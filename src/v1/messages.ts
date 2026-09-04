// Recoverable fan-out, mailbox, and history protocol v1.
//
// **The fan-out design rests on a single inode.** The canonical message, the
// fan-out intent, and every inbox reference are hard links to the same file,
// and this is not a space saving — it is how atomicity is obtained where the
// file system does not give it: two files cannot be created with one `rename`,
// and "create the intent" is exactly one atomic `open(O_EXCL)`.
//
// The order is:
//
// 1. Validate recipients and the routing policy — before the first side effect.
// 2. Create `intents/<id>.json` with the `wx` flag. **This is the commit
//    point**: from here the message exists, and everything else is recoverable,
//    because the intent IS the canonical message whole — the recipients sit
//    in it too.
// 3. Link the canon: `link(intent → messages/<id>.json)`. Idempotent.
// 4. Link a reference into each recipient's inbox. Idempotent: `EEXIST` means
//    "already there".
// 5. Drop the intent once every recipient has a reference.
//
// After a crash, `recoverTask` writes what is missing — at engine open and on
// demand. TWO places are checked THEN, inbox and history: a reference that is
// not in inbox may already have been read, and recovery that looked only at
// inbox would return the already-read message a second time. Activation runs
// independently and AFTER the fan-out is on disk.
//
// The FS requirement is inherited whole: hard links inside one volume. Their
// absence is a lawful environment condition, and the answer is the typed
// code `link-refused`, not a half-written record.
import {
  existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import type { NotificationMessage } from '../driver.js';
import { pidAlive } from '../fs/proc.js';
import { linkFailure } from './artifacts.js';
import { fail } from './errors.js';
import {
  brokenInboxDir, brokenMessagesDir, historyDir, historyRef, inboxDir, inboxRef, intentFile,
  intentsDir, messageFile, messagesDir, ownerOfIntent, taskDir,
} from './layout.js';
import { MESSAGE_PROTOCOL_VERSION } from './model.js';
import type { MessageV1, ParticipantV1, TaskV1 } from './model.js';
import { validate } from './validate.js';

/** Fan-out steps, after each of which the suite can crash the process. */
export type FanoutStep = 'validate' | 'blob' | 'artifact' | 'intent' | 'canonical' | 'ref' | 'close' | 'read';

/**
 * Fault-injection seam. Called AFTER each durable step; a throw from it is
 * a crash exactly at that point. Not supplied in production at all, and that
 * is the only way to test recovery: a real process crash mid-step is not
 * reproduced by the suite.
 */
export type FaultHook = (step: FanoutStep, info: Record<string, unknown>) => void;

const NO_FAULT: FaultHook = () => {};

/** "Who to wake" event. The shape is the one the driver `activate` accepts. */
export interface ActivationEvent {
  kind: 'unread';
  task: string;
  /** Participant ID. In v1 it is also the delivery address: role is not derived from it. */
  address: string;
  /** Opaque session reference of the participant — the first argument of `activate`. */
  ref: string | null;
  unread: number;
  messages: NotificationMessage[];
}

/** Message excerpt for a notification: the driver assembles the text, the frame belongs to the channel. */
export function previewOf(m: MessageV1): NotificationMessage {
  return {
    id: m.id,
    type: m.type,
    from: m.sender,
    ts: m.ts,
    body: m.body,
    artifact: m.artifact ?? null,
  };
}

let seq = 0;

/**
 * New record id: a timestamp, a sender counter, and a random tail. String
 * sort equals send order, so a second clock is not needed. The tail is
 * random, not just a counter: `seq` lives in process memory, and under one
 * address both the session and its background command walk — two processes
 * in the same millisecond would assemble the same name.
 */
export function newRecordId(now: Date): string {
  seq = (seq + 1) % 10000;
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('Z', '');
  return `${stamp}-${String(seq).padStart(4, '0')}-${randomBytes(3).toString('hex')}`;
}

// Idempotent hard link: `true` — we put it, `false` — it was already there.
// `EEXIST` here is not a refusal, it is the whole point of the step:
// recovery writes what is missing and does not touch what is ready.
function linkOnce(from: string, to: string): boolean {
  mkdirSync(path.dirname(to), { recursive: true });
  try {
    linkSync(from, to);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw linkFailure(e, to);
  }
}

/** Whether the recipient has a ref — in the inbox or already in history. */
function delivered(home: string, task: string, participant: string, message: string): boolean {
  return existsSync(inboxRef(home, task, participant, message))
    || existsSync(historyRef(home, task, participant, message));
}

/**
 * Threshold after which an unclosed intent is treated as abandoned regardless
 * of the lease.
 *
 * It is also the upper bound of the lease: a pid the OS reused for a foreign
 * process would otherwise lock a foreign intent forever, and the undelivered
 * would sit forever. The slack is taken from the cost of one send: measured
 * 2026-09-02, 500 sends in a row — 1.4 ms CPU per send at a median of 1.3 ms;
 * under load (load average 38–44) the median is the same, and the tail is
 * stretched by the scheduler: p99 35–67 ms, the longest of one and a half
 * thousand — 141 ms. The threshold is two hundred times that, and a live
 * intent never lives longer than a send at all: from `wx` creation to drop
 * it is a synchronous block.
 *
 * Exported for a contract quote: the reference names the threshold in
 * seconds, and `lint` checks that number against this constant through
 * `dist`; there are no other consumers outside.
 */
export const INTENT_STALE_MS = 30_000;

/**
 * Lease: who is writing this fan-out right now. Laid down NEXT TO the intent,
 * as a separate file, not as a field on the record: the intent and the canon
 * are one inode, and the field would travel into every recipient's inbox and
 * into history, and a reader of the former version would reject such a
 * message by schema (`additionalProperties: false`) and take it to `broken`.
 * A separate file is invisible to former readers by construction — they walk
 * the intents directory by the `.json` mask.
 *
 * A write refusal does not cancel the send: the commit point is the intent,
 * and the lease only speeds up recovery; without it the intent is treated as
 * abandoned by age.
 *
 * The `w` flag, not `wx`: exclusivity is already won by the `wx` creation of
 * the intent itself, and `wx` here would mean "an orphaned `<id>.owner` under
 * the same name stays foreign" — a fresh intent would carry foreign pid and
 * host and would either be declared abandoned at once or wait the threshold
 * in vain. That names may repeat is something the code already counts on:
 * `commitIntent` reassembles the id on `EEXIST` up to 16 times.
 */
function leaseIntent(intent: string): void {
  try {
    writeFileSync(ownerOfIntent(intent),
      `${JSON.stringify({ pid: process.pid, host: os.hostname() })}\n`, { flag: 'w' });
  } catch {
    // No lease — recovery will pick the intent up by age, not by owner liveness.
  }
}

/** Lease record; `null` — there is no lease, it is unreadable, or it is incomplete. */
function readLease(file: string): { pid: number; host: string } | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const { pid, host } = raw as { pid?: unknown; host?: unknown };
    if (!Number.isInteger(pid) || typeof host !== 'string') return null;
    return { pid: pid as number, host };
  } catch {
    return null;
  }
}

/**
 * Whether an unclosed intent is abandoned — that is, whether recovery may
 * touch it.
 *
 * A neighbour's live fan-out must not be picked up: recovery materializes the
 * canon and drops the intent, and the owner at that moment is walking to its
 * own `link` — and gets `ENOENT` on a delivered message, a refusal on success.
 *
 * Branches, in this order:
 * 1. age is at least `INTENT_STALE_MS` — abandoned regardless of the lease
 *    (the upper bound). Age is computed from local clocks by `mtime`, and on
 *    a shared mount `mtime` is set by the owner's machine: the branch admits
 *    that the home has one clock. Drifted clocks move the threshold itself,
 *    but not the decision about a live owner — that is guarded by branch 2
 *    by comparing the host;
 * 2. there is no lease, or it is from a foreign machine — owner liveness is
 *    unknown, wait for the threshold;
 * 3. the pid is ours — abandoned. The life of an intent inside a process is
 *    ONE synchronous block: `commitIntent` and `completeFanout` are
 *    synchronous whole, and every `await` of `send` stands before the commit
 *    point, so our own pid on an intent means "a previous process with the
 *    same number", not "it is being written right now". If an await appears
 *    between creating the intent and dropping it, the branch becomes wrong,
 *    and the crash checks in `v1-engine.test.mjs` go red on that: they crash
 *    the send at the seam and recover in THE SAME process;
 * 4. otherwise owner pid liveness decides.
 */
function abandonedIntent(intent: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(intent).mtimeMs;
  } catch {
    // The intent was taken between the directory listing and the check — nothing to recover.
    return false;
  }
  if (age >= INTENT_STALE_MS) return true;
  const lease = readLease(ownerOfIntent(intent));
  if (!lease || lease.host !== os.hostname()) return false;
  return lease.pid === process.pid || !pidAlive(lease.pid);
}

/** Step 2: create the intent. Atomic `open(O_EXCL)` — the commit point of the whole fan-out. */
function openIntent(home: string, task: string, message: MessageV1): void {
  mkdirSync(intentsDir(home, task), { recursive: true });
  const intent = intentFile(home, task, message.id);
  writeFileSync(intent, `${JSON.stringify(message, null, 2)}\n`, { flag: 'wx' });
  // The lease AFTER the intent, not before: an orphaned lease describes nobody's
  // fan-out, and the "intent is there, lease is not yet" window is closed by
  // age — such an intent is younger than the threshold.
  leaseIntent(intent);
}

/**
 * Step 3: link the canon to the intent. Idempotent — recovery calls the same
 * thing.
 *
 * There is no "canon already there" check before the link, and that is not
 * a simplification: it was the same window, only wider — a neighbour fits
 * between it and `link`. `EEXIST` from the link itself already means "the
 * canon is in place", and `linkOnce` reports that by returning `false`.
 *
 * `ENOENT` on the source is not a refusal, it is "materialized by another":
 * a neighbour who took the same fan-out to the end took the intent, and the
 * canon is already in place. A refusal from here would break the sender's
 * loop on a DELIVERED message. But if there is no canon then either — that
 * is a real loss, and it stays a refusal.
 */
function materialize(home: string, task: string, message: string): boolean {
  const canonical = messageFile(home, task, message);
  try {
    return linkOnce(intentFile(home, task, message), canonical);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    if (existsSync(canonical)) return false;
    return fail('link-refused', `intent is gone and there is no canon: ${canonical}`,
      { task, message, target: canonical, errno: 'ENOENT' });
  }
}

/**
 * Steps 3–5 in one pass: the canon, refs for recipients, drop the intent.
 * Called by both send and recovery — exactly one code, otherwise recovery
 * would repair something other than what broke.
 */
export function completeFanout(home: string, task: string, message: MessageV1, fault: FaultHook = NO_FAULT): string[] {
  materialize(home, task, message.id);
  fault('canonical', { task, message: message.id });
  const fresh: string[] = [];
  for (const [index, recipient] of message.recipients.entries()) {
    // Fresh — those who must be woken — a recipient is counted for the process
    // whose ref landed. `linkOnce` returns `false` on `EEXIST` when between
    // `delivered()` and `link` a neighbour already put the ref: two recoverers
    // would otherwise both name the recipient as fresh, and two activation
    // events would go out for one message. Delivery is still one — one ref —
    // only the report of it was doubled.
    if (!delivered(home, task, recipient, message.id)
      && linkOnce(messageFile(home, task, message.id), inboxRef(home, task, recipient, message.id))) {
      fresh.push(recipient);
    }
    fault('ref', { task, message: message.id, recipient, index });
  }
  // Step 5. Only after refs for ALL: an intent dropped earlier would take
  // with it the only trace of the undelivered, and nobody would write the
  // missing ref. The lease leaves with it: it describes an unclosed fan-out,
  // and a closed one needs no owner.
  const intent = intentFile(home, task, message.id);
  rmSync(intent, { force: true });
  rmSync(ownerOfIntent(intent), { force: true });
  fault('close', { task, message: message.id });
  return fresh;
}

/** How much unread sits with the participant. */
export function countInbox(home: string, task: string, participant: string): number {
  return inboxNames(inboxDir(home, task, participant)).length;
}

function inboxNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/** Assemble the activation event for a participant: what sits with them and how to wake them. */
export function eventFor(home: string, task: string, participant: ParticipantV1, messages: MessageV1[]): ActivationEvent {
  return {
    kind: 'unread',
    task,
    address: participant.id,
    ref: participant.sessionRef,
    unread: countInbox(home, task, participant.id),
    messages: messages.map(previewOf),
  };
}

/** Assemble a canonical message. Validation is on the caller's side, before the first write. */
export function newMessage(task: string, sender: string, recipients: string[], type: string, body: string, artifact: string | null, now: Date): MessageV1 {
  return {
    protocolVersion: MESSAGE_PROTOCOL_VERSION,
    id: newRecordId(now),
    task,
    sender,
    recipients: [...recipients],
    type,
    body,
    ...(artifact ? { artifact } : {}),
    ts: now.toISOString(),
  };
}

/** Step 2 with a retry on a taken name: the id is assembled again, not replaced in silence. */
export function commitIntent(home: string, task: string, message: MessageV1, now: Date): MessageV1 {
  let current = message;
  for (let tries = 0; ; tries += 1) {
    try {
      openIntent(home, task, current);
      return current;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (tries >= 16) fail('schema-invalid', `could not take a message name in ${tries} attempts`, { task });
      current = { ...current, id: newRecordId(now) };
    }
  }
}

/**
 * What was found unreadable while reading the mailbox. Reason and place are
 * split into fields, not glued into a string: the adapter assembles the text
 * for a person, and a glue would force it to cut the string back with a
 * regex — the two report channels would drift on the first word edit.
 */
export interface BrokenNote {
  name: string;
  code: string;
  /** Why the record did not read. */
  note: string;
  /** Directory the record was set aside in; `null` — it stayed in place. */
  attic: string | null;
  /** Why setting it aside failed; `null` — it succeeded, or it was not tried. */
  failure: string | null;
}

/** Where the record went: the directory, or the reason setting it aside failed. */
function isolate(from: string, atticDir: string, name: string): { attic: string | null; failure: string | null } {
  try {
    mkdirSync(atticDir, { recursive: true });
    renameSync(from, path.join(atticDir, name));
    return { attic: atticDir, failure: null };
  } catch (e) {
    return { attic: null, failure: (e as Error).message };
  }
}

/**
 * Take incoming and move the refs to history. There is no processing ack and
 * no exactly-once: the mailbox guarantees the message is kept until read,
 * and only that.
 *
 * Order is by file name: timestamp plus counter, so string sort equals send
 * order.
 */
export function readInbox(home: string, task: string, participant: string, fault: FaultHook = NO_FAULT): {
  messages: MessageV1[]; broken: BrokenNote[];
} {
  const dir = inboxDir(home, task, participant);
  const messages: MessageV1[] = [];
  const broken: BrokenNote[] = [];
  const names = inboxNames(dir);
  // The history directory is created here, not on the first send: `rename` of
  // a ref needs a ready parent, and creating it empty for every participant
  // is unnecessary.
  if (names.length) ensureHistoryDir(home, task, participant);
  for (const name of names) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      // A neighbour took it between the listing and the read — a skip, not a
      // refusal: the second reader took the message, and that reader will
      // deliver it.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    let parsed: unknown = null;
    let code = '';
    let note = '';
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      code = 'schema-invalid';
      note = `did not parse (${(e as Error).message})`;
    }
    if (!code) {
      const verdict = validate('message', parsed);
      if (!verdict.ok) {
        code = verdict.code as string;
        note = `does not match the schema: ${verdict.at} ${verdict.note}`;
      }
    }
    if (code) {
      // A record from the future does not go to `broken`: it is not corrupt, there is just nothing to read it with.
      const where = code === 'schema-version-unsupported'
        ? { attic: null, failure: null }
        : isolate(file, brokenInboxDir(home, task, participant), name);
      broken.push({ name, code, note, ...where });
      continue;
    }
    try {
      renameSync(file, historyRef(home, task, participant, (parsed as MessageV1).id));
    } catch (e) {
      // ENOENT here is the same neighbour who took it. A refusal from here
      // would come from the MIDDLE of the walk, when some refs have already
      // gone to history, and there would be nobody to put them back.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      continue;
    }
    messages.push(parsed as MessageV1);
  }
  fault('read', { task, participant, taken: messages.length });
  return { messages, broken };
}

// history/<participant> is created lazily, like inbox: the directory appears with the first read.
export function ensureHistoryDir(home: string, task: string, participant: string): void {
  mkdirSync(historyDir(home, task, participant), { recursive: true });
}

/** History query. `all` lifts the limit whole; `before` — a cursor for paged reading. */
export interface HistoryQuery {
  task?: string;
  participant?: string;
  limit?: number;
  /**
   * Cursor of the previous page: an opaque string that `cursor` returned.
   * There is no need to assemble it by hand, and it should not be — the
   * order-key form belongs to history.
   */
  before?: string;
  all?: boolean;
}

/** History record: one message for one participant. */
export interface HistoryEntry {
  task: string;
  participant: string;
  message: MessageV1;
}

/** History response: a page from old to new, and a cursor to the older page. */
export interface HistoryPage {
  entries: HistoryEntry[];
  /** What to pass as `before` for the next (older) page; `null` — there is nothing older. */
  cursor: string | null;
  broken: BrokenNote[];
}

/**
 * Order key: the message id, and on a tie — the participant. One message sits
 * with many, and it has as many history records as recipients.
 *
 * **The cursor is this key whole, not the message id** (review remark). The
 * limit counts RECORDS, so a page boundary lawfully cuts a group of records
 * of one message; a cursor by id would cut the next page by the whole group
 * at once, and records left of the cut would land on no page at all.
 */
function orderKey(message: string, participant: string): string {
  return `${message} ${participant}`;
}

/**
 * Compare order keys. One comparison for both sort and cursor cut: two
 * different comparisons on the same data give two different orders, and the
 * page boundary stops matching itself. `localeCompare` is no good here at
 * all — it depends on the locale, and the key is machine-made.
 */
function byKey(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Task history: what was read, from old to new, last 50 records by default.
 *
 * There is no unread here at all, and that is not a gap: unread sits in the
 * mailbox, and if it landed here the history would stop telling delivered
 * from read — and fan-out recovery stands on that distinction.
 */
export function history(home: string, tasks: string[], { participant, limit = 50, before, all = false }: HistoryQuery): HistoryPage {
  const refs: { key: string; task: string; participant: string; file: string }[] = [];
  for (const task of tasks) {
    const root = path.join(taskDir(home, task), 'history');
    let boxes: string[];
    try {
      boxes = readdirSync(root);
    } catch {
      continue;
    }
    for (const box of boxes) {
      if (participant && box !== participant) continue;
      for (const name of inboxNames(path.join(root, box))) {
        const id = name.slice(0, -'.json'.length);
        refs.push({ key: orderKey(id, box), task, participant: box, file: path.join(root, box, name) });
      }
    }
  }
  refs.sort((a, b) => byKey(a.key, b.key));
  // Exclusive cursor: the page returns records strictly OLDER than it, so
  // there are no repeats on the page boundary. The comparison is the same
  // one the records were sorted with.
  const older = before ? refs.filter((r) => byKey(r.key, before) < 0) : refs;
  const page = all ? older : older.slice(Math.max(0, older.length - Math.max(0, limit)));
  const entries: HistoryEntry[] = [];
  const broken: BrokenNote[] = [];
  for (const ref of page) {
    let message: unknown;
    try {
      message = JSON.parse(readFileSync(ref.file, 'utf8'));
    } catch (e) {
      broken.push({ name: path.basename(ref.file), code: 'schema-invalid', note: (e as Error).message, attic: null, failure: null });
      continue;
    }
    const verdict = validate('message', message);
    if (!verdict.ok) {
      broken.push({ name: path.basename(ref.file), code: verdict.code as string, note: `${verdict.at} ${verdict.note}`, attic: null, failure: null });
      continue;
    }
    entries.push({ task: ref.task, participant: ref.participant, message: message as MessageV1 });
  }
  const first = page[0];
  const hasOlder = Boolean(first) && older.length > page.length;
  return { entries, cursor: hasOlder ? (first as { key: string }).key : null, broken };
}

/** What recovery repaired in one task. */
export interface Repair {
  task: string;
  message: string;
  /** Who the refs were written for. Empty — the intent was simply not dropped. */
  recipients: string[];
  /** Whether the canon had to be linked again. */
  canonical: boolean;
}

/**
 * Recover fan-out of one task: walk unclosed intents and write what is missing.
 *
 * Idempotent by construction: both the canon and every ref are put with
 * `link`, and `EEXIST` here means "already there". A second call on a
 * healthy store does nothing.
 */
export function recoverTask(home: string, task: string, meta: TaskV1, fault: FaultHook = NO_FAULT): {
  repairs: Repair[]; events: ActivationEvent[]; broken: BrokenNote[];
} {
  const repairs: Repair[] = [];
  const events: ActivationEvent[] = [];
  const broken: BrokenNote[] = [];
  let entries: string[];
  try {
    entries = readdirSync(intentsDir(home, task)).sort();
  } catch {
    return { repairs, events, broken };
  }
  const names = entries.filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  for (const name of names) {
    const file = path.join(intentsDir(home, task), name);
    // The lease gate stands BEFORE the record is parsed: a live neighbour's
    // torn record is lawful too — `wx` creates the file atomically, and the
    // contents are written after, and a half of them is visible.
    if (!abandonedIntent(file)) continue;
    let parsed: unknown = null;
    let code = '';
    let note = '';
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      code = 'schema-invalid';
      note = `intent did not parse (${(e as Error).message})`;
    }
    if (!code) {
      const verdict = validate('message', parsed);
      if (!verdict.ok) {
        code = verdict.code as string;
        note = `intent does not match the schema: ${verdict.at} ${verdict.note}`;
      }
    }
    if (code) {
      // A torn intent record is the only form of corruption a crash inside
      // the commit point produces: the send did not return then, and there
      // was no message for the sender.
      const where = code === 'schema-version-unsupported'
        ? { attic: null, failure: null }
        : isolate(file, brokenMessagesDir(home, task), name);
      // The lease lives exactly as long as the intent: the intent left — it leaves too.
      if (where.attic) rmSync(ownerOfIntent(file), { force: true });
      broken.push({ name, code, note, ...where });
      continue;
    }
    const message = parsed as MessageV1;
    const hadCanonical = existsSync(messageFile(home, task, message.id));
    const fresh = completeFanout(home, task, message, fault);
    repairs.push({ task, message: message.id, recipients: fresh, canonical: !hadCanonical });
    for (const id of fresh) {
      const who = meta.participants.find((p) => p.id === id);
      // A recipient who is no longer in the journal still gets the ref: it
      // would have sat there without the crash too. There is nobody to wake
      // — no event for them.
      if (who) events.push(eventFor(home, task, who, [message]));
    }
  }
  sweepLeases(intentsDir(home, task), entries);
  return { repairs, events, broken };
}

/**
 * Remove leases that have nothing to describe. An orphaned `<id>.owner`
 * remains when a former-version code closes the fan-out: it drops the
 * intent and does not know about the lease. The garbage leaves in silence
 * — there is no promise behind it at all.
 *
 * The decision is taken from ONE listing, and it is never atomic: `readdir`
 * may return a `.owner` from a position not yet walked and not return a
 * `.json` that landed in a position already walked — then a live lease is
 * swept. The cost of that error is one-sided: the intent stays without a
 * lease, that is, it falls into the "liveness unknown — wait for the
 * threshold" branch. Recovery becomes more careful from that, not bolder,
 * and cannot pick up a neighbour's in-flight fan-out.
 */
function sweepLeases(dir: string, entries: string[]): void {
  const open = new Set(entries.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)));
  for (const name of entries) {
    if (!name.endsWith('.owner') || open.has(name.slice(0, -'.owner'.length))) continue;
    rmSync(path.join(dir, name), { force: true });
  }
}

export { messagesDir };

/**
 * Look into the mailbox without touching anything in it. The difference from
 * `readInbox` is one and it is everything: refs stay in the inbox and do not
 * go to history. Broken ones are set aside the same way — otherwise one
 * unreadable record would return to the reader on every visit.
 *
 * A foreign session calls this: `mailbox` gives it a copy, and the originals
 * stay with the owner.
 */
export function peekInbox(home: string, task: string, participant: string): {
  messages: MessageV1[]; broken: BrokenNote[];
} {
  const dir = inboxDir(home, task, participant);
  const messages: MessageV1[] = [];
  const broken: BrokenNote[] = [];
  for (const name of inboxNames(dir)) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      // The owner took it between the listing and the read: they will deliver the message.
      continue;
    }
    let parsed: unknown = null;
    let code = '';
    let note = '';
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      code = 'schema-invalid';
      note = `did not parse (${(e as Error).message})`;
    }
    if (!code) {
      const verdict = validate('message', parsed);
      if (!verdict.ok) {
        code = verdict.code as string;
        note = `does not match the schema: ${verdict.at} ${verdict.note}`;
      }
    }
    if (code) {
      // A record from the future does not go to `broken`: it is not corrupt, there is just nothing to read it with.
      const where = code === 'schema-version-unsupported'
        ? { attic: null, failure: null }
        : isolate(file, brokenInboxDir(home, task, participant), name);
      broken.push({ name, code, note, ...where });
      continue;
    }
    messages.push(parsed as MessageV1);
  }
  return { messages, broken };
}

/**
 * Glance into the mailbox in silence: touches no refs and sets no broken
 * aside. Needed by the supervisor — its diagnostics go to `stdio: 'ignore'`,
 * and what was set aside would vanish without a word to anyone.
 */
export function glanceInbox(home: string, task: string, participant: string): MessageV1[] {
  const dir = inboxDir(home, task, participant);
  const messages: MessageV1[] = [];
  for (const name of inboxNames(dir)) {
    try {
      messages.push(JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as MessageV1);
    } catch {
      // Broken, or taken by a neighbour — not our problem: the reader takes the mailbox, and that reader will report.
    }
  }
  return messages;
}

/**
 * When the participant last SENT on the bus; `null` — they have sent nothing
 * yet.
 *
 * The record name does not carry the sender (a stamp, a counter, and a
 * random tail), so there is no answer without reading the contents. This is
 * asked on every heartbeat for every one who has stalled, and correspondence
 * accumulates on the order of three megabytes a day — so the parse is
 * **incremental**: each record is read exactly once in the life of the
 * process, and the next call touches only names it has not seen yet. A cache
 * keyed on directory state would not do here: any send changes it, and the
 * walk would become full again.
 *
 * The canon is immutable and disappears only with the task, so what was seen
 * does not go stale.
 */
const sentSeen = new Map<string, { seen: Set<string>; last: Map<string, number> }>();

export function lastSentAt(home: string, task: string, participant: string): number | null {
  const dir = messagesDir(home, task);
  let hit = sentSeen.get(dir);
  if (!hit) {
    hit = { seen: new Set<string>(), last: new Map<string, number>() };
    sentSeen.set(dir, hit);
  }
  // Directories are created lazily: no directory — `inboxNames` returns an empty list.
  for (const name of inboxNames(dir)) {
    if (hit.seen.has(name)) continue;
    hit.seen.add(name);
    try {
      const m = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as MessageV1;
      const at = Date.parse(m.ts);
      if (!Number.isFinite(at)) continue;
      if (!hit.last.has(m.sender) || (hit.last.get(m.sender) as number) < at) hit.last.set(m.sender, at);
    } catch {
      // A broken message does not name its sender — the walk continues.
    }
  }
  return hit.last.get(participant) ?? null;
}

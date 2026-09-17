// Messages: names, order and what a read marks.
// [reference/04-protocol.md#messages-names-order-and-what-a-read-marks](../../docs/reference/04-protocol.md#messages-names-order-and-what-a-read-marks)
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
import { fail, PromptobusError } from './errors.js';
import {
  brokenInboxDir, brokenMessagesDir, historyDir, historyRef, historyRoot, inboxDir, inboxRef, intentFile,
  intentsDir, messageFile, messagesDir, ownerOfIntent,
} from './layout.js';
import { compactStamp, MESSAGE_PROTOCOL_VERSION } from './model.js';
import type { MessageV1, ParticipantV1, TaskV1 } from './model.js';
import { validate } from './validate.js';

/** Fan-out steps, after each of which the suite can crash the process. */
export type FanoutStep =
  | 'validate' | 'blob' | 'artifact' | 'intent' | 'canonical' | 'ref' | 'close' | 'read'
  | 'task-read' | 'artifact-read' | 'intent-read' | 'intent-materialize' | 'inbox-read' | 'history-ref';

/** Fault-injection seam: fan-out points fire AFTER each durable step, read points immediately
 * BEFORE their named filesystem operation. Not supplied in production at all. */
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

/** New record id: a timestamp, a sender counter and a random tail, so string sort equals send order.
 * The tail is random because `seq` lives in process memory and two processes share an address. */
export function newRecordId(now: Date): string {
  seq = (seq + 1) % 10000;
  const stamp = compactStamp(now);
  return `${stamp}-${String(seq).padStart(4, '0')}-${randomBytes(3).toString('hex')}`;
}

// Idempotent hard link. `EEXIST` from the LINK is the whole point of the step — recovery writes
// what is missing; from the `mkdir` it is a refusal, and goes out classified like any mkdir errno.
function linkOnce(from: string, to: string): boolean {
  try {
    mkdirSync(path.dirname(to), { recursive: true });
  } catch (e) {
    throw linkFailure(e, path.dirname(to));
  }
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

/** Threshold after which an unclosed intent is treated as abandoned.
 * [reference/04-protocol.md#intent_stale_ms--threshold-after-which-an-unclosed-intent-is-treated-as-abandoned-regardless](../../docs/reference/04-protocol.md#intent_stale_ms--threshold-after-which-an-unclosed-intent-is-treated-as-abandoned-regardless) */
export const INTENT_STALE_MS = 30_000;

/** Writing a message into a mailbox.
 * [reference/04-protocol.md#leaseintent--lease-who-is-writing-this-fan-out-right-now](../../docs/reference/04-protocol.md#leaseintent--lease-who-is-writing-this-fan-out-right-now) */
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

/** Whether an unclosed intent is abandoned — that is, whether recovery may touch it.
 * [reference/04-protocol.md#abandonedintent--whether-an-unclosed-intent-is-abandoned--that-is-whether-recovery-may](../../docs/reference/04-protocol.md#abandonedintent--whether-an-unclosed-intent-is-abandoned--that-is-whether-recovery-may) */
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
  // The lease AFTER the intent, not before: an orphaned lease describes nobody's fan-out, and the
  // "intent there, lease not yet" window is closed by age.
  leaseIntent(intent);
}

/** Step 3: link the canon to the intent, idempotent. There is no "already there" check before the
 * link — `EEXIST` says it; `ENOENT` on the source means another took the fan-out to the end. */
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

/** Steps 3–5 in one pass: the canon, refs for recipients, drop the intent. Called by both send and
 * recovery — exactly one code, or recovery would repair something other than what broke. */
export function completeFanout(home: string, task: string, message: MessageV1, fault: FaultHook = NO_FAULT): string[] {
  materialize(home, task, message.id);
  fault('canonical', { task, message: message.id });
  const fresh: string[] = [];
  for (const [index, recipient] of message.recipients.entries()) {
    // Fresh — those who must be woken: a recipient is counted for the process whose ref landed, or
    // two recoverers would both name it fresh and send two activation events for one message.
    if (!delivered(home, task, recipient, message.id)
      && linkOnce(messageFile(home, task, message.id), inboxRef(home, task, recipient, message.id))) {
      fresh.push(recipient);
    }
    fault('ref', { task, message: message.id, recipient, index });
  }
  // Step 5, only after refs for ALL: an intent dropped earlier would take the only trace of the
  // undelivered with it. The lease leaves with it — a closed fan-out needs no owner.
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

/** What was found unreadable while reading the mailbox. Reason and place are separate fields, not
 * glued: a glue would force the adapter to cut it back with a regex, and the channels would drift. */
export interface BrokenNote {
  name: string;
  /** Protocol validation code, or filesystem errno when the record stays for retry. */
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

type ReadRecord = { message: MessageV1 } | { broken: BrokenNote };

function readRecord(file: string, name: string, attic: string | null): ReadRecord {
  const raw = readFileSync(file, 'utf8');
  let parsed: unknown = null;
  let code = '';
  let note = '';
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    code = 'schema-invalid';
    note = 'did not parse (' + (e as Error).message + ')';
  }
  if (!code) {
    const verdict = validate('message', parsed);
    if (!verdict.ok) {
      code = verdict.code as string;
      note = 'does not match the schema: ' + verdict.at + ' ' + verdict.note;
    }
  }
  if (code) {
    // A future schema stays in place: it is unsupported, not corrupt.
    const where = code === 'schema-version-unsupported' || attic === null
      ? { attic: null, failure: null }
      : isolate(file, attic, name);
    return { broken: { name, code, note, ...where } };
  }
  return { message: parsed as MessageV1 };
}

/** Take incoming and move the refs to history. No processing ack and no exactly-once: the mailbox
 * keeps a message until read, and that is all. Order is by file name, which is send order. */
export function readInbox(home: string, task: string, participant: string, fault: FaultHook = NO_FAULT): {
  messages: MessageV1[]; broken: BrokenNote[];
} {
  const dir = inboxDir(home, task, participant);
  const messages: MessageV1[] = [];
  const broken: BrokenNote[] = [];
  const names = inboxNames(dir);
  // The history directory is created here, not on the first send: `rename` of a ref needs a ready
  // parent, and creating it empty for every participant is unnecessary.
  if (names.length) ensureHistoryDir(home, task, participant);
  for (const name of names) {
    const file = path.join(dir, name);
    let record: ReadRecord;
    try {
      fault('inbox-read', { task, participant, name, mode: 'read' });
      record = readRecord(file, name, brokenInboxDir(home, task, participant));
    } catch (e) {
      // A neighbour took it between the listing and the read — a skip, not a refusal: the second
      // reader took the message, and that reader will deliver it.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const errno = (e as NodeJS.ErrnoException).code;
      if (typeof errno !== 'string') throw e;
      broken.push({ name, code: errno, note: (e as Error).message, attic: null, failure: null });
      continue;
    }
    if ('broken' in record) {
      broken.push(record.broken);
      continue;
    }
    try {
      fault('history-ref', { task, participant, name });
      renameSync(file, historyRef(home, task, participant, record.message.id));
    } catch (e) {
      // ENOENT here is the same neighbour. A refusal from the MIDDLE of the walk would strand refs
      // already moved: report it, leave this one in the inbox, and return what moved.
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') continue;
      if (typeof errno !== 'string') throw e;
      broken.push({ name, code: errno, note: (e as Error).message, attic: null, failure: null });
      continue;
    }
    messages.push(record.message);
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
  /** Cursor of the previous page: an opaque string `cursor` returned. It should not be assembled by
   * hand — the order-key form belongs to history. */
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

/** Order key: the message id, and on a tie the participant. **The cursor is this key WHOLE**, not the
 * message id: the limit counts RECORDS, and an id cursor would leave records on no page at all. */
function orderKey(message: string, participant: string): string {
  return `${message} ${participant}`;
}

/** Compare order keys — one comparison for both sort and cursor cut, or the page boundary would stop
 * matching itself. `localeCompare` is no good: it depends on the locale, and the key is machine-made. */
function byKey(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Task history: what was read, old to new, last 50 records by default. Unread is not here — it sits
 * in the mailbox, and fan-out recovery stands on telling delivered from read. */
export function history(home: string, tasks: string[], { participant, limit = 50, before, all = false }: HistoryQuery): HistoryPage {
  const refs: { key: string; task: string; participant: string; file: string }[] = [];
  for (const task of tasks) {
    const root = historyRoot(home, task);
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
  // Exclusive cursor: the page returns records strictly OLDER than it, so there are no repeats on
  // the boundary. The comparison is the one the records were sorted with.
  const older = before ? refs.filter((r) => byKey(r.key, before) < 0) : refs;
  const page = all ? older : older.slice(Math.max(0, older.length - Math.max(0, limit)));
  const entries: HistoryEntry[] = [];
  const broken: BrokenNote[] = [];
  for (const ref of page) {
    let record: ReadRecord;
    try {
      record = readRecord(ref.file, path.basename(ref.file), null);
    } catch (e) {
      broken.push({ name: path.basename(ref.file), code: 'schema-invalid', note: (e as Error).message, attic: null, failure: null });
      continue;
    }
    if ('broken' in record) {
      broken.push(record.broken);
      continue;
    }
    entries.push({ task: ref.task, participant: ref.participant, message: record.message });
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

/** A classified fan-out failure: unfinished for retry, or permanently lost. */
export interface RecoverFailure {
  task: string;
  message: string;
  code: 'link-refused' | 'intent-lost';
  note: string;
}

/** Recover fan-out of one task: walk unclosed intents and write what is missing. Idempotent by
 * construction; a classified refusal for one message does not stop recovery of its neighbours. */
export function recoverTask(home: string, task: string, meta: TaskV1, fault: FaultHook = NO_FAULT): {
  repairs: Repair[]; events: ActivationEvent[]; broken: BrokenNote[]; failed: RecoverFailure[];
} {
  const repairs: Repair[] = [];
  const events: ActivationEvent[] = [];
  const broken: BrokenNote[] = [];
  const failed: RecoverFailure[] = [];
  let entries: string[];
  try {
    entries = readdirSync(intentsDir(home, task)).sort();
  } catch {
    return { repairs, events, broken, failed };
  }
  const names = entries.filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  for (const name of names) {
    const file = path.join(intentsDir(home, task), name);
    // The lease gate stands BEFORE the record is parsed: a live neighbour's torn record is lawful
    // too — `wx` creates the file atomically and the contents land after.
    if (!abandonedIntent(file)) continue;
    let raw: string;
    try {
      fault('intent-read', { task, name });
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const errno = (e as NodeJS.ErrnoException).code;
      if (typeof errno !== 'string') throw e;
      broken.push({ name, code: errno, note: (e as Error).message, attic: null, failure: null });
      continue;
    }
    let parsed: unknown = null;
    let code = '';
    let note = '';
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
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
      // A torn intent record is the only corruption a crash inside the commit point produces: the
      // send did not return then, and there was no message for the sender.
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
    let fresh: string[];
    try {
      fault('intent-materialize', { task, message: message.id });
      fresh = completeFanout(home, task, message, fault);
    } catch (e) {
      // A classified environmental refusal leaves the intent for a later pass; ENOENT at
      // materialization means both sources are gone. Everything else still escapes.
      if (!(e instanceof PromptobusError) || e.code !== 'link-refused') throw e;
      const failureCode = e.context.errno === 'ENOENT' ? 'intent-lost' : e.code;
      failed.push({ task, message: message.id, code: failureCode, note: e.message });
      continue;
    }
    repairs.push({ task, message: message.id, recipients: fresh, canonical: !hadCanonical });
    for (const id of fresh) {
      const who = meta.participants.find((p) => p.id === id);
      // A recipient no longer in the journal still gets the ref — it would have sat there without
      // the crash too. There is nobody to wake, so no event for them.
      if (who) events.push(eventFor(home, task, who, [message]));
    }
  }
  sweepLeases(intentsDir(home, task), entries);
  return { repairs, events, broken, failed };
}

/** Remove leases that have nothing to describe. The decision comes from ONE listing and is never
 * atomic — but the error is one-sided: a swept live lease only makes recovery more careful. */
function sweepLeases(dir: string, entries: string[]): void {
  const open = new Set(entries.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)));
  for (const name of entries) {
    if (!name.endsWith('.owner') || open.has(name.slice(0, -'.owner'.length))) continue;
    rmSync(path.join(dir, name), { force: true });
  }
}

export { messagesDir };

/** Look into the mailbox without touching anything: refs stay and do not go to history. Broken ones
 * are still set aside, or one unreadable record would return to the reader on every visit. */
export function peekInbox(home: string, task: string, participant: string, fault: FaultHook = NO_FAULT): {
  messages: MessageV1[]; broken: BrokenNote[];
} {
  const dir = inboxDir(home, task, participant);
  const messages: MessageV1[] = [];
  const broken: BrokenNote[] = [];
  for (const name of inboxNames(dir)) {
    const file = path.join(dir, name);
    let record: ReadRecord;
    try {
      fault('inbox-read', { task, participant, name, mode: 'peek' });
      record = readRecord(file, name, brokenInboxDir(home, task, participant));
    } catch (e) {
      // The owner took it between the listing and the read: they will deliver the message.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Any other refusal is present-and-broken, never absent
      // ([01-overview](../../docs/reference/01-overview.md) § Store home).
      const errno = (e as NodeJS.ErrnoException).code;
      if (typeof errno !== 'string') throw e;
      broken.push({ name, code: errno, note: (e as Error).message, attic: null, failure: null });
      continue;
    }
    if ('broken' in record) {
      broken.push(record.broken);
      continue;
    }
    messages.push(record.message);
  }
  return { messages, broken };
}

/** Glance into the mailbox in silence: no refs touched and nothing set aside. Needed by the
 * supervisor — its diagnostics go nowhere anyone would read, and what was set aside would vanish. */
export function glanceInbox(home: string, task: string, participant: string, fault: FaultHook = NO_FAULT): {
  messages: MessageV1[]; broken: BrokenNote[];
} {
  const dir = inboxDir(home, task, participant);
  const messages: MessageV1[] = [];
  const broken: BrokenNote[] = [];
  for (const name of inboxNames(dir)) {
    let raw: string;
    try {
      fault('inbox-read', { task, participant, name, mode: 'glance' });
      raw = readFileSync(path.join(dir, name), 'utf8');
    } catch (e) {
      // The owner took it between the listing and the read: they will deliver the message.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const errno = (e as NodeJS.ErrnoException).code;
      if (typeof errno !== 'string') throw e;
      broken.push({ name, code: errno, note: (e as Error).message, attic: null, failure: null });
      continue;
    }
    try {
      messages.push(JSON.parse(raw) as MessageV1);
    } catch {
      // Malformed records remain for the consuming reader to classify and set aside.
    }
  }
  return { messages, broken };
}

/** When the participant last SENT on the bus. The record name carries no sender, so the parse is
 * **incremental**: each record is read once per process, since the canon is immutable. */
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

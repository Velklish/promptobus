import {
  constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { writeJsonAtomic } from './fs/atomic.js';
import {
  addrDir, FOREIGN_MARK, FOREIGN_ROUTE, GateError, isAddress, MESSAGE_TYPES, newTaskIdentity, ORCHESTRATOR,
  participantFileStem, requireTaskId, stampOfId, TASK_ID_RE, TASK_TITLE_SEP, taskDir, tasksDir,
} from './protocol.js';
import type { Ownership } from './protocol.js';
import {
  onTaskLock, sessionFile, sessionsDir, withTaskLock, workersDir,
} from './sidecar.js';
import type { Binding } from './sidecar.js';

/**
 * Diagnostics for a person. Arrives as an argument and only where the reader
 * reports corruption: the package writes nothing to process streams, and the
 * environment and output are the adapter business.
 * Unnamed — the reader stays silent, and the `broken` list is returned to
 * the caller as before.
 */
export type Warn = (msg: string) => void;

const SILENT: Warn = () => {};

// Bus store `v0.61.0` — a maildir store of a task. **It is no longer the
// production store**: cutover moved the mechanism to protocol v1
// ([v1/](v1/)), and what remains here is the one reader this code still
// lives for — migration of the former store → `.promptobus`
// ([migrate.ts](migrate.ts)). The second caller is the suite: a legacy
// slice is read by its own reader, and missing adapter files are written
// into its copy through the same store API.
//
// The surface goes out as the `legacy` namespace from [index.ts](index.ts).
// It cannot be a flat export: both stores share the same names, and in a
// common space they would collide. The home stays as long as the migration
// input is read: the former-layout reader is its subject, and it can be
// removed only together with the migration itself.
//
// There is no daemon: each session has its own MCP-server stdio process,
// shared state is on disk. One message = one JSON file in the addressee
// mailbox, landing in place by an atomic rename; a mailbox has exactly one
// consumer (address = process), so "read" is moving the file into read/.
//
// The store path arrives as the `home` argument. Where it lives, the
// package does not know at all: the workspace root is found by the adapter,
// which also supplies diagnostics and session identity
// ([host.ts](host.ts)).

let seq = 0;
// Temporary-name counter of its own: the `seq` number goes into the file name and keeps send order.
let tmpSeq = 0;

// File-operation error code. `strict` yields the caught value as `unknown`, and
// reading codes (`EEXIST`, `ENOENT`) is the same condition as in the JS
// edition of this file.
type Errno = NodeJS.ErrnoException;
const errno = (e: unknown): Errno => e as Errno;

/** Task participant record. Fields beyond the address are written by the adapter — they are its, not the store. */
export interface Participant {
  address: string;
  owner?: string | null;
  title?: string;
  dismissed?: string;
  [key: string]: unknown;
}

/** Task journal: `task.json` as it is today. */
export interface TaskMeta {
  id: string;
  title?: string;
  slug?: string;
  stamp?: string;
  titleExplicit?: boolean;
  created?: string;
  closed?: string;
  status?: string;
  participants?: Participant[];
  [key: string]: unknown;
}

/** Protocol v1 message — one atomically created file in the addressee mailbox. */
export interface Message {
  id: string;
  task: string;
  from: string;
  to: string;
  type: string;
  ts: string;
  body: string;
  artifact?: string;
}

export function inboxDir(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'inbox', addrDir(addr));
}

export function readDir(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'read', addrDir(addr));
}

// Where the unreadable is set aside: a directory next to `read/`, the file stays under its own name.
export function brokenDir(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'broken', addrDir(addr));
}

export function artifactsDir(home: string, id: string): string {
  return path.join(taskDir(home, id), 'artifacts');
}

// --- tasks ------------------------------------------------------------------

export function taskFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'task.json');
}

export function taskExists(home: string, id: unknown): boolean {
  return TASK_ID_RE.test((id ?? '') as string) && existsSync(taskFile(home, id as string));
}

// Owner of the `orchestrator` address — the session the task was born in:
// `promptobus spawn` and `promptobus review` are launched by Bash from it and
// inherit its identity.
export function taskOwner(home: string, id: string): string | null {
  const meta = readTask(home, id);
  return (meta.participants ?? []).find((p) => p.address === ORCHESTRATOR)?.owner ?? null;
}

// Own mailbox or a foreign one — the only condition on the whole bus. Nothing
// to compare (no identity or no owner) — the mechanism stays silent entirely:
// backward compatibility outranks the guard. Worker and reviewer addresses are
// not gated: the address is declared in their mcp-config.
export function ownership(home: string, id: string, addr: string, session: string | null): Ownership {
  if (addr !== ORCHESTRATOR) return { gated: false, owner: null, session };
  const owner = taskOwner(home, id);
  if (!owner || !session) return { gated: false, owner, session };
  return { gated: owner !== session, owner, session };
}

// Claim of the mailbox by a successor session. Returns the previous owner:
// there is one `owner` field, and no history. A claim is also a rebind: the
// owner declares its current task too.
export function claimOwnership(home: string, id: string, owner: string): string | null {
  const previous = withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = (meta.participants ?? []).find((x) => x.address === ORCHESTRATOR) ?? { address: ORCHESTRATOR };
    const was = p.owner ?? null;
    writeTask(home, applyParticipant(meta, { ...p, owner }));
    return was;
  });
  bindSession(home, id, owner);
  return previous;
}

// --- declared session→task binding ------------------------
//
// The binding is laid as a per-session file next to `tasks/`: without it the
// session task was inferred by the "only active one" guess — with several
// active the bus refused the lifted session, with one a foreign session
// picked it up as its own. Hybrid: where there is no identity (manual
// launch, tests, CI), resolve falls back to the same guess. The session
// name is checked by task-id grammar — if it does not fit, there is no
// binding at all. Only an ACTIVE task is bound: `liveBinding` never yields
// a closed one. Claiming the mailbox of a closed task is still lawful —
// nobody forbade reading its correspondence.
export function bindSession(home: string, id: string, session: string | null): Binding | null {
  const file = sessionFile(home, session);
  if (!file || !taskExists(home, id) || readTask(home, id).status !== 'active') return null;
  const mark: Binding = { session: session as string, task: id, since: new Date().toISOString() };
  return writeJsonAtomic(file, mark);
}

// Binding of this session or `null`. Read by LIVENESS, not by file presence:
// a session that kept working after `promptobus done` must fall back to the
// spare path again. Under one `try` both the mark and the journal: a
// truncated `task.json` would drop `resolveTaskId`.
export function liveBinding(home: string, session: string | null): Binding | null {
  const file = sessionFile(home, session);
  if (!file) return null;
  try {
    const mark = JSON.parse(readFileSync(file, 'utf8')) as Binding | null;
    if (!taskExists(home, mark?.task)) return null;
    return readTask(home, (mark as Binding).task).status === 'active' ? mark : null;
  } catch {
    return null;
  }
}

export function boundTaskId(home: string, session: string | null): string | null {
  return liveBinding(home, session)?.task ?? null;
}

// Bind a session to the task it owns. Spawn and review call this, not
// `bindSession`: a session that entered a foreign run with an explicit
// `--task` would send argument-less calls into a foreign journal.
export function bindIfOwner(home: string, id: string, session: string | null): Binding | null {
  if (!session || taskOwner(home, id) !== session) return null;
  return bindSession(home, id, session);
}

// Sweep bindings that have lost liveness: the mechanism does not need it, the directory does.
export function sweepBindings(home: string): number {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return 0;
  let dropped = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    if (liveBinding(home, name.slice(0, -'.json'.length))) continue;
    rmSync(path.join(dir, name), { force: true });
    dropped += 1;
  }
  return dropped;
}

/** What goes into a new task. Everything except `id` is optional. */
export interface NewTask {
  id?: string;
  title?: string;
  slug?: string;
  stamp?: string;
  titleExplicit?: boolean;
  owner?: string | null;
}

export function createTask(home: string, {
  id = newTaskIdentity().id, title, slug, stamp, titleExplicit = false, owner = null,
}: NewTask): TaskMeta {
  requireTaskId(id);
  if (taskExists(home, id)) throw new Error(`task ${id} already exists`);
  const taskStamp = stamp ?? stampOfId(id);
  const meta: TaskMeta = {
    id,
    title: title ?? id,
    // The stamp is written always: without it `readableTail` falls back to
    // the full id — a person reads `(t20260827-175756)` instead of `(0827-1757)`.
    ...(slug ? { slug } : {}),
    ...(taskStamp ? { stamp: taskStamp } : {}),
    // The title was set by a person explicitly — assembly from tracks does not touch it.
    ...(titleExplicit ? { titleExplicit: true } : {}),
    created: new Date().toISOString(),
    status: 'active',
    // Write the owner only if the environment supplied one — otherwise the owner mechanism is off.
    participants: [{ address: ORCHESTRATOR, ...(owner ? { owner } : {}) }],
  };
  mkdirSync(inboxDir(home, id, ORCHESTRATOR), { recursive: true });
  mkdirSync(artifactsDir(home, id), { recursive: true });
  // The `wx` flag: between the `taskExists` check and the write a second
  // first spawn of the same run fits, and a latecomer through `rename` would
  // silently overwrite the participants of the one that went first.
  try {
    writeFileSync(taskFile(home, id), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' });
  } catch (e) {
    if (errno(e).code === 'EEXIST') throw new Error(`task ${id} already exists`);
    throw e;
  }
  return meta;
}

// Journal cache for one request: one bus-tool call reads task.json four to
// six times from places that do not know about each other. It lives exactly
// as long as the wrapped synchronous stretch: outside it a neighbour edits
// the journal lawfully. `writeTask` and `withTaskLock` extinguish it.
// Reader invariant: do not mutate a `readTask` result under the cache.
let taskCache: Map<string, TaskMeta> | null = null;

export function withTaskCache<T>(fn: () => T): T {
  const outer = taskCache;
  taskCache = outer ?? new Map();
  try {
    return fn();
  } finally {
    taskCache = outer;
  }
}

// The journal cache is lifted for the lock: under it the journal changes
// both by our write and by a foreign one the lock waited for. Registration
// is here, at the cache owner — the lock itself lives in
// [sidecar.ts](sidecar.ts) and knows nothing of caches.
onTaskLock((fn) => withoutTaskCache(fn));

function withoutTaskCache<T>(fn: () => T): T {
  const outer = taskCache;
  taskCache = null;
  try {
    return fn();
  } finally {
    taskCache = outer;
    // Under the lock the journal may have changed — both by our write and
    // by a foreign one the lock waited for.
    outer?.clear();
  }
}

export function readTask(home: string, id: string): TaskMeta {
  const f = taskFile(home, id);
  const hit = taskCache?.get(f);
  if (hit) return hit;
  if (!existsSync(f)) throw new GateError(`task ${id} is not in ${tasksDir(home)}`);
  const meta = JSON.parse(readFileSync(f, 'utf8')) as TaskMeta;
  taskCache?.set(f, meta);
  return meta;
}

// The journal is written the same way as a message: a temporary file in the
// same directory and `rename` over it. `writeFileSync` truncates the file
// to zero — a parallel reader finds it empty, and a process that died
// mid-write leaves a truncated journal forever.
export function writeTask(home: string, meta: TaskMeta): TaskMeta {
  writeJsonAtomic(taskFile(home, meta.id), meta);
  // What was written is reread the same way — a snapshot from before the write would lie.
  taskCache?.clear();
  return meta;
}

// The listing survives both a foreign directory and a broken journal: one
// corrupt task would otherwise extinguish every bus command — `listTasks`
// feeds `resolveTaskId`.
export function listTasks(home: string, warn: Warn = SILENT): TaskMeta[] {
  const dir = tasksDir(home);
  if (!existsSync(dir)) return [];
  const out: TaskMeta[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !TASK_ID_RE.test(e.name)) continue;
    if (!existsSync(taskFile(home, e.name))) continue;
    try {
      out.push(readTask(home, e.name));
    } catch (err) {
      warn(`task ${e.name} skipped: ${taskFile(home, e.name)} is unreadable (${(err as Error).message})`);
    }
  }
  return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

export function activeTasks(home: string, warn: Warn = SILENT): TaskMeta[] {
  return listTasks(home, warn).filter((t) => t.status === 'active');
}

// Active task of the process. Three sources, in descending strength: an
// explicit declaration (a tool argument, `--task`, `A2A_TASK`), the session
// binding, the "only active one" inference — a spare path for those who
// have no identity; its gates watch it.
//
// All three refusals are addressed to a person — a typo in the id, an empty
// journal, several active tasks at once — so they are thrown as
// `GateError`: a bare `Error` is printed with a stack by the CLI top-level
// catch, and a lawful refusal reads as a breakage of the mechanism itself.
export function resolveTaskId(home: string, declared: string | null | undefined, session: string | null, warn: Warn = SILENT): string {
  if (declared) {
    if (!taskExists(home, declared)) throw new GateError(`task ${declared} is not in ${tasksDir(home)}`);
    return declared;
  }
  const bound = boundTaskId(home, session);
  if (bound) return bound;
  const active = activeTasks(home, warn);
  if (active.length === 1) return active[0].id;
  if (active.length === 0) {
    throw new GateError(`no active task: ${tasksDir(home)} is empty or every task is closed. `
      + `A task is created when the first worker is spawned: promptobus spawn --repo <name> --brief <file>`);
  }
  throw new GateError(`several active tasks (${active.map((t) => t.id).join(', ')}), `
    + `and this session has no binding${session ? '' : ' — the environment gave it no identity'} — `
    + 'name the one you need (A2A_TASK for the session, --task for the command). '
    + 'The task is yours and this is a new session — claim the mailbox: mailbox {claim: true, task: <id>}, '
    + 'then it resolves on its own. Need a new run — start it with promptobus spawn --new-task.');
}

// The mailbox that was read from and written to is named in every bus reply:
// home, task, address. The task is named by title too: a foreign task is
// given away by the subject, the id is not. The same place names the drift
// "session is bound to A, the journal says B" — it is lawful.
export function identityLabel(home: string, task: string, addr: string, session: string | null = null): string {
  const { title } = readTask(home, task);
  const named = title && title !== task ? `${task} «${title}»` : task;
  const bound = session ? boundTaskId(home, session) : null;
  const drift = bound && bound !== task ? ` · session binding ${session}: task ${bound}` : '';
  return `A2A_HOME=${home} · task=${named} · address=${addr}${drift}`;
}

function applyParticipant(meta: TaskMeta, participant: Participant): TaskMeta {
  if (!isAddress(participant?.address)) {
    throw new GateError(`invalid participant address «${participant?.address}» — `
      + 'expected orchestrator, worker:<slug> or reviewer:<slug>');
  }
  const rest = (meta.participants ?? []).filter((p) => p.address !== participant.address);
  meta.participants = [...rest, participant];
  return meta;
}

export function upsertParticipant(home: string, id: string, participant: Participant): TaskMeta {
  return withTaskLock(home, id, () => writeTask(home, applyParticipant(readTask(home, id), participant)));
}

// Dismiss a participant from watch: the orchestrator closed the session
// itself, and the warden has nowhere to learn that — without the mark it
// would report "GONE" about a closed one. The mark lives on the participant
// record in the journal: keep it on the process, and its death would bring
// the reports back. Returns `{ found, was }`: "no such participant" and
// "the mark was already there" are two different answers.
function setDismissed(home: string, id: string, address: string, at: string | null): { found: boolean; was: string | null } {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = (meta.participants ?? []).find((x) => x.address === address);
    if (!p) return { found: false, was: null };
    const was = p.dismissed ?? null;
    // The state is already what they ask to make it — do not touch the
    // journal: a repeat dismiss does not rewrite the dismiss time, and a
    // return to watch does not write the journal for one that was not
    // dismissed — the most common case on a re-review, and it would cost a
    // task lock.
    if (Boolean(was) === Boolean(at)) return { found: true, was };
    // A return is DELETION of the field, not `null` in it: every journal
    // reader would have to tell `dismissed: null` from a dismiss, and the
    // field is checked for truthiness.
    const { dismissed, ...rest } = p;
    writeTask(home, applyParticipant(meta, at ? { ...rest, dismissed: at } : rest));
    return { found: true, was };
  });
}

export function dismissParticipant(home: string, id: string, address: string, at: string = new Date().toISOString()): {
  found: boolean; was: string | null;
} {
  return setDismissed(home, id, address, at);
}

// Return to watch — where the participant is given new work. A lift again
// clears the mark itself (the record is laid whole); a re-review of a live
// session — this call.
export function watchParticipant(home: string, id: string, address: string): { found: boolean; was: string | null } {
  return setDismissed(home, id, address, null);
}

// Task title from the titles of its tracks: otherwise a run of three tracks
// would read as the work of one. Computed over the WHOLE journal and called
// AFTER the participant write — two spawns from one pre-image would yield
// "A · B" and "A · C", and the winner would lose the foreign track.
// An empty list is not a reason to rename: a former-CLI task has no `title` field.
export function titleFromLines(meta?: TaskMeta | null): string | null {
  const lines = [...new Set((meta?.participants ?? [])
    .filter((p) => String(p.address ?? '').startsWith('worker:') && p.title)
    .map((p) => p.title as string))];
  return lines.length ? lines.join(TASK_TITLE_SEP) : null;
}

/** What is asked of the task title. */
export interface Retitle {
  title?: string | null;
  fromLines?: boolean;
  explicit?: boolean;
  restamp?: boolean;
  session?: string | null;
}

// The task title is written after the fact: grafting a new track appends to
// it, and `--task-title` pins it for good (`titleExplicit`). One door
// remains — restamping: `restamp` sets the plan by double explicitness
// (`--task-title` plus an explicit `--task`), and the right is checked here
// by the same `ownership` as the rest of the bus — under the lock, not in
// the plan: the mailbox may have changed owner after the plan was built.
export function retitleTask(home: string, id: string, {
  title = null, fromLines = false, explicit = false, restamp = false, session = null,
}: Retitle = {}): string | null {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    if (meta.titleExplicit && !(restamp && !ownership(home, id, ORCHESTRATOR, session).gated)) return null;
    // `fromLines` is computed HERE and only here: the `--dry-run` prediction
    // lives in a separate intent field (`preview`) that this function does
    // not read.
    const next = fromLines ? titleFromLines(meta) : title;
    if (!next || next === meta.title) {
      // The mark is set even when the title is already that: otherwise a
      // title a person named explicitly would stay unprotected from the
      // next graft.
      if (explicit) {
        meta.titleExplicit = true;
        writeTask(home, meta);
      }
      return null;
    }
    meta.title = next;
    if (explicit) meta.titleExplicit = true;
    writeTask(home, meta);
    return next;
  });
}

export function closeTask(home: string, id: string): TaskMeta {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    meta.status = 'done';
    meta.closed = new Date().toISOString();
    return writeTask(home, meta);
  });
}

// --- messages ---------------------------------------------------------------

function stamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:.]/g, '').replace('Z', '');
}

// The artifact is laid in the shared task folder under its own name; a taken name is not overwritten.
function storeArtifact(home: string, id: string, srcAbs: string): string {
  const src = path.resolve(srcAbs);
  if (!existsSync(src)) throw new Error(`artifact is missing: ${src}`);
  const dir = artifactsDir(home, id);
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(src);
  const stem = path.basename(src, ext);
  // The copy itself takes the name, not a check before it: `existsSync` in a
  // loop is TOCTOU. `COPYFILE_EXCL` gives the name to exactly one, a
  // latecomer takes the next number.
  for (let i = 1; ; i += 1) {
    const name = i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
    try {
      copyFileSync(src, path.join(dir, name), constants.COPYFILE_EXCL);
      return name;
    } catch (e) {
      if (errno(e).code !== 'EEXIST') throw e;
    }
  }
}

/** What is sent on the bus. */
export interface Outgoing {
  from: string;
  to: string;
  type: string;
  body: string;
  artifactPath?: string | null;
}

export function sendMessage(home: string, id: string, { from, to, type, body, artifactPath }: Outgoing): Message {
  if (!isAddress(from)) throw new Error(`unknown sender address «${from}»`);
  if (!isAddress(to)) throw new Error(`unknown recipient address «${to}» — orchestrator, worker:<slug> or reviewer:<slug>`);
  if (!MESSAGE_TYPES.includes(type)) {
    throw new Error(`type «${type}» is not a v1 protocol type: ${MESSAGE_TYPES.join(', ')}`);
  }
  if (typeof body !== 'string' || !body.trim()) throw new Error('body is empty — a message with no text is not sent');
  // The addressee must be listed as a task participant: a typo in the slug
  // would pass grammar, the function opens the mailbox directory itself, and
  // send would return success. There is no lawful send to an unregistered
  // address — spawn writes the participant BEFORE launch.
  const known = (readTask(home, id).participants ?? []).map((p) => p.address);
  if (!known.includes(to)) {
    throw new Error(`task ${id} has no participant «${to}» — there is nobody to pick the message up, `
      + `and a mailbox opened for them will be seen by neither promptobus status nor task. Task participants: ${known.join(', ')}`);
  }

  const artifact = artifactPath ? storeArtifact(home, id, artifactPath) : undefined;
  const now = new Date();
  const dir = inboxDir(home, id, to);
  mkdirSync(dir, { recursive: true });
  // Name uniqueness is held by the disk, not by process memory: each process
  // has its own `seq` counter. The temporary file is in the same directory
  // (rename and link are atomic only inside one FS; the reader picks `.json`
  // and does not take a leading dot). We `link`, not `rename`: it refuses
  // on a taken name instead of a quiet overwrite.
  tmpSeq += 1;
  const tmp = path.join(dir, `.tmp-msg-${process.pid}-${tmpSeq}`);
  const ts = stamp(now);
  let msg: Message;
  try {
    for (;;) {
      seq += 1;
      const base = `${ts}-${String(seq).padStart(4, '0')}-${addrDir(from)}`;
      msg = { id: base, task: id, from, to, type, ts: now.toISOString(), body, ...(artifact ? { artifact } : {}) };
      writeFileSync(tmp, JSON.stringify(msg, null, 2) + '\n');
      try {
        linkSync(tmp, path.join(dir, `${base}.json`));
        break;
      } catch (e) {
        if (errno(e).code !== 'EEXIST') throw e;
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return msg;
}

function inboxNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
}

// One message from the mailbox: parsed, `null` if a neighbour took it, and
// `null` if broken — the broken one goes to `broken/` with a report. Were it
// to throw SyntaxError outward, the mailbox would jam forever, and the whole
// run with it.
function takeMessage(dir: string, name: string, attic: string, broken: string[], warn: Warn): Message | null {
  const file = path.join(dir, name);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    // A neighbour took it between the listing and the read — a skip, not a refusal.
    if (errno(e).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as Message;
  } catch (e) {
    let note;
    try {
      mkdirSync(attic, { recursive: true });
      renameSync(file, path.join(attic, name));
      note = `BROKEN MESSAGE ${name}: did not parse (${(e as Error).message}) — set aside in ${attic}, the mailbox keeps working`;
    } catch (moveErr) {
      // Setting aside failed — still do not drop the mailbox: name both the
      // damage and that the file stayed.
      note = `BROKEN MESSAGE ${name}: did not parse (${(e as Error).message}) and was not set aside (${(moveErr as Error).message}) — skipped`;
    }
    // Report on two channels: diagnostics for a person, the `broken` list
    // for the agent (on the MCP path stderr is read by the harness, not the
    // session, and without the list the message would vanish in silence).
    warn(note);
    broken.push(note);
    return null;
  }
}

// Take incoming and mark them read. Order is by file name: a timestamp with
// milliseconds plus the sender counter, so string sort is send order.
export function readInbox(home: string, id: string, addr: string, warn: Warn = SILENT): { msgs: Message[]; broken: string[] } {
  const dir = inboxDir(home, id, addr);
  const names = inboxNames(dir);
  const broken: string[] = [];
  if (!names.length) return { msgs: [], broken };
  const done = readDir(home, id, addr);
  const attic = brokenDir(home, id, addr);
  mkdirSync(done, { recursive: true });
  const msgs: Message[] = [];
  for (const n of names) {
    const msg = takeMessage(dir, n, attic, broken, warn);
    if (!msg) continue;
    try {
      renameSync(path.join(dir, n), path.join(done, n));
    } catch (e) {
      // A neighbour took it between the read and the move — a skip, not a
      // refusal: a refusal would come from the middle of the walk, when
      // some messages have already gone to `read/`. The message is not
      // lost — the neighbour took it, and that neighbour will deliver it.
      if (errno(e).code !== 'ENOENT') throw e;
      continue;
    }
    msgs.push(msg);
  }
  return { msgs, broken };
}

export function countInbox(home: string, id: string, addr: string): number {
  return inboxNames(inboxDir(home, id, addr)).length;
}

// Accumulated unread does not speak for itself: notification is best-effort,
// if it did not arrive the message sits and the session thinks nobody wrote.
// The counter rides as a tail on replies where the session does not take
// the mailbox (`send`, `task`, `promptobus review` output); zero is not
// named. To a foreign mailbox the line says something else: the originals
// will not be given to it.
export function unreadNote(home: string, id: string, addr: string, session: string | null = null): string | null {
  const n = countInbox(home, id, addr);
  if (!n) return null;
  const own = ownership(home, id, addr, session);
  if (!own.gated) return `your mailbox: ${n} unread — pick them up with the mailbox tool`;
  return `${FOREIGN_MARK}: ${n} unread at the orchestrator of this task, but the mailbox is bound to session `
    + `${own.owner}, this one is ${own.session}. ${FOREIGN_ROUTE}`;
}

// Glance into the mailbox without touching anything in it — needed by the
// warden. Unlike `peekInbox`, that one sets the unreadable aside in
// `broken/` and names it aloud, and warden diagnostics go to
// `stdio: 'ignore'` — what was set aside would vanish without a word to anyone.
export function glanceInbox(home: string, id: string, addr: string): Message[] {
  const dir = inboxDir(home, id, addr);
  const msgs: Message[] = [];
  for (const n of inboxNames(dir)) {
    try {
      msgs.push(JSON.parse(readFileSync(path.join(dir, n), 'utf8')) as Message);
    } catch {
      // Broken or taken by a neighbour — not our trouble: the reader takes
      // the mailbox, and that reader will report it.
    }
  }
  return msgs;
}

// Look at incoming without taking them — needed by a foreign session: `mailbox`
// gives it a copy, and the originals stay with the owner. Messages are taken
// by the owner-session `mailbox`, which may also have taken the file between
// the listing and the read.
export function peekInbox(home: string, id: string, addr: string, warn: Warn = SILENT): { msgs: Message[]; broken: string[] } {
  const dir = inboxDir(home, id, addr);
  const attic = brokenDir(home, id, addr);
  const broken: string[] = [];
  const msgs: Message[] = [];
  for (const n of inboxNames(dir)) {
    const msg = takeMessage(dir, n, attic, broken, warn);
    if (msg) msgs.push(msg);
  }
  return { msgs, broken };
}


// --- insert when merging the stalls track into store.ts ------------------------

// Stamp and sender in the message file name — the shape `sendMessage` sets.
const MSG_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})-\d{4}-(.+)\.json$/;

// When the address last SENT on the bus; `null` — has not sent anything yet.
// Message bodies are not read at all: the file name carries both the
// timestamp and the sender, and this is asked on every heartbeat for every
// stalled one. We look at both places a message lawfully lives — unread in
// the recipient mailbox and read in `read/`.
export function lastSentAt(home: string, id: string, address: string): number | null {
  const from = addrDir(address);
  let last: number | null = null;
  for (const box of ['inbox', 'read']) {
    const root = path.join(taskDir(home, id), box);
    let boxes: string[];
    try {
      boxes = readdirSync(root);
    } catch {
      // Directories are created lazily: no directory — no messages in it.
      continue;
    }
    for (const dir of boxes) {
      let names: string[];
      try {
        names = readdirSync(path.join(root, dir));
      } catch {
        continue;
      }
      for (const n of names) {
        const m = MSG_NAME_RE.exec(n);
        // The sender is checked whole, not by the name tail: the slug
        // `x-worker-api` has the same tail `-worker-api.json`, and its
        // messages would pass as messages of `worker:api`.
        if (!m || m[8] !== from) continue;
        const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!);
        if (last === null || at > last) last = at;
      }
    }
  }
  return last;
}


// --- re-export of the dictionary and adapter files ------------------------------------
//
// The module surface stays as migration and the fixture generator knew it:
// the bus dictionary and the task-directory files moved to neighbouring
// modules, but a consumer of the legacy slice has no reason to call them
// through two imports.
export {
  addrDir, brokenNote, claimRoute, FOREIGN_MARK, FOREIGN_ROUTE, GateError, isAddress,
  MAILBOX_CLAIMED_MARK, MESSAGE_TYPES, newTaskIdentity, ORCHESTRATOR, participantFileStem,
  reviewerAddress, SLUG_MAX, slugify, stampOfId, TASK_TITLE_SEP, taskDir, tasksDir,
  workerAddress, foreignTaskLine,
} from './protocol.js';
export type { Clock, Ownership } from './protocol.js';
export {
  beatWarden, claimWarden, clearWarden, healthFile, lastTurnAt, liveWarden, lockBusyError,
  logWarden, markTurn, readHealth, readStalls, readWake, sessionFile, sessionsDir, stallsFile,
  tailWardenLog, WARDEN_BEAT_SEC, wakeFile, wardenLogFile, wardenMarkFile, withTaskLock,
  workersDir, writeHealth, writeStalls, writeWake,
} from './sidecar.js';
export type { Binding, Health, LockHolder, Stalls, Wake, WardenMark } from './sidecar.js';
export { pidAlive } from './fs/proc.js';

// Participant file paths in `workers/`: name joining is in the dictionary, the directory is in sidecar.
export function participantMcpPath(home: string, taskId: string, address: string): string {
  return path.join(workersDir(home, taskId), `${participantFileStem(address)}.mcp.json`);
}

export function participantSettingsPath(home: string, taskId: string, address: string): string {
  return path.join(workersDir(home, taskId), `${participantFileStem(address)}.settings.json`);
}

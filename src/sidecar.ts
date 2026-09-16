// The sidecar: state beside the journal.
// [reference/01-overview.md#the-sidecar-state-beside-the-journal](../docs/reference/01-overview.md#the-sidecar-state-beside-the-journal)
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { writeFileAtomic, writeJsonAtomic } from './fs/atomic.js';
import { LOCK_WAIT_MS, withDirLock } from './fs/lock.js';
import type { LockHolder } from './fs/lock.js';
import { pidAlive } from './fs/proc.js';
import { blobLockDir, lockDir } from './v1/layout.js';
import { addrDir, GateError, requireTaskId, TASK_ID_RE, taskDir, tasksDir } from './protocol.js';

// --- directories -------------------------------------------------------------

export function workersDir(home: string, id: string): string {
  return path.join(taskDir(home, id), 'workers');
}

// Session-to-task bindings — next to `tasks/`: resolve must answer in one read.
export function sessionsDir(home: string): string {
  return path.join(home, 'sessions');
}

// --- task warden -------------------------------------------------------------

// Listening on the bus is held by a process, not by the model. It has no state of its own —
// everything lives in the task directory, so the warden dying loses nothing.

// Process mark. The file name is leftover from the former warden name and must not be renamed: under
// a new name a previous release's mark would go unseen, and two wardens would stand on one task.
export function wardenMarkFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'supervisor.json');
}

// Participant contact point — their messaging socket address and its token, handed over by the
// participant itself. The token is a secret; the file is written with mode `0600`.
export function wakeFile(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'wake', `${addrDir(addr)}.json`);
}

// What the warden knows about delivery to each address. A file of its own, not fields on the task
// journal: a write happens on every delivery, and the journal is edited under the lock.
export function healthFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'health.json');
}

// Warden log — line-oriented, append-only: deliveries, rollbacks, escalations. This is NOT the task
// journal, and the file name is the former one for the same reason as the warden mark.
export function wardenLogFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'supervisor.log');
}

export function stallsFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'stalls.json');
}

// How often the warden refreshes its mark, kept next to the liveness read: a drift between the write
// period and the stale threshold would declare a live process dead. The threshold is three periods.
export const WARDEN_BEAT_SEC = 30;

/** Mark of the task warden process. */
export interface WardenMark {
  pid: number;
  started?: string;
  beat?: string;
  cli?: string;
  /** Harness version, if the consumer named one. Neutral name: more than one harness exists. */
  harness?: string;
  [key: string]: unknown;
}

export function readWardenMark(home: string, id: string): WardenMark | null {
  try {
    return JSON.parse(readFileSync(wardenMarkFile(home, id), 'utf8')) as WardenMark;
  } catch {
    return null;
  }
}

export function writeWardenMark(home: string, id: string, mark: WardenMark): WardenMark {
  writeJsonAtomic(wardenMarkFile(home, id), mark);
  return mark;
}

export function dropWardenMark(home: string, id: string): void {
  rmSync(wardenMarkFile(home, id), { force: true });
}

function wardenExitFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'waits', 'warden.exit.json');
}

/** Warden departure note for the loop guard — written before the mark is cleared. */
export interface WardenExit {
  reason: string;
  at: string;
}

export function writeWardenExit(home: string, id: string, note: WardenExit): void {
  writeJsonAtomic(wardenExitFile(home, id), note);
}

export function readWardenExit(home: string, id: string): WardenExit | null {
  try {
    const raw = JSON.parse(readFileSync(wardenExitFile(home, id), 'utf8')) as WardenExit;
    return typeof raw?.reason === 'string' && typeof raw?.at === 'string' ? raw : null;
  } catch {
    return null;
  }
}

export function clearWardenExit(home: string, id: string): void {
  rmSync(wardenExitFile(home, id), { force: true });
}

function wardenGenerationFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'waits', 'warden.gen.json');
}

export function readWardenGeneration(home: string, id: string): number {
  try {
    const raw = JSON.parse(readFileSync(wardenGenerationFile(home, id), 'utf8')) as { gen?: number };
    const gen = raw?.gen;
    return typeof gen === 'number' && Number.isInteger(gen) && gen >= 0 ? gen : 0;
  } catch {
    return 0;
  }
}

function bumpWardenGeneration(home: string, id: string): number {
  const gen = readWardenGeneration(home, id) + 1;
  writeJsonAtomic(wardenGenerationFile(home, id), { gen });
  return gen;
}

// The live warden of this task, or `null`. Two signs, both required: a live pid (the system reuses
// numbers) and an unstale `beat` (a process killed between beats would count as live).
export function liveWarden(home: string, id: string): WardenMark | null {
  const mark = readWardenMark(home, id);
  if (!mark) return null;
  if (!pidAlive(mark.pid)) return null;
  const beat = Date.parse(mark.beat ?? mark.started ?? '');
  if (!(Number.isFinite(beat) && Date.now() - beat < WARDEN_BEAT_SEC * 3000)) return null;
  return mark;
}

/** Participant contact point: where the warden knocks. */
export interface Wake {
  address: string;
  socket: string;
  token?: string;
  pid: number;
  session?: string;
  at: string;
}

export function readWake(home: string, id: string, addr: string): Wake | null {
  try {
    return JSON.parse(readFileSync(wakeFile(home, id, addr), 'utf8')) as Wake;
  } catch {
    return null;
  }
}

// Hand over the contact point. Called often, so a file with the same contents is not rewritten.
// Mode `0600` for the session token: macOS does not enforce it, but code without it is not portable.
export function writeWake(home: string, id: string, addr: string, {
  socket, token = null, pid = process.pid, session = null,
}: { socket?: string | null; token?: string | null; pid?: number; session?: string | null } = {}): Wake | null {
  if (!socket) return null;
  const next: Wake = {
    address: addr,
    socket,
    ...(token ? { token } : {}),
    pid,
    ...(session ? { session } : {}),
    at: new Date().toISOString(),
  };
  const was = readWake(home, id, addr);
  if (was && was.socket === next.socket && was.token === next.token
    && was.pid === next.pid && was.session === next.session) return was;
  writeFileAtomic(wakeFile(home, id, addr), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/** What the warden knows about delivery by address. */
export type Health = Record<string, unknown>;

export function readHealth(home: string, id: string): Health {
  try {
    const raw = JSON.parse(readFileSync(healthFile(home, id), 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? raw as Health : {};
  } catch {
    return {};
  }
}

export function writeHealth(home: string, id: string, health: Health): Health {
  writeJsonAtomic(healthFile(home, id), health);
  return health;
}

/** Mark of reported stalls: reason, time of the last report, and a try counter per address. A former
 * CLI wrote a bare reason string, read as a mark with no time — repeated only when the reason changes. */
export type Stalls = Record<string, { reason: string; at: string | null; tries?: number }>;

export function readStalls(home: string, id: string): Stalls {
  try {
    const raw = JSON.parse(readFileSync(stallsFile(home, id), 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).map(([addr, v]) => [
      addr, typeof v === 'string' ? { reason: v, at: null } : v as Stalls[string],
    ]));
  } catch {
    return {};
  }
}

/** Atomic: a truncated file would be read as "never reported". */
export function writeStalls(home: string, id: string, stalls: Stalls): Stalls {
  writeJsonAtomic(stallsFile(home, id), stalls);
  return stalls;
}

// Append a line to the warden log. No lock and no atomic replace: one line shorter than the pipe
// buffer does not tear, there is one writer, and a log-write refusal must not stop delivery.
export function logWarden(home: string, id: string, line: string): boolean {
  try {
    mkdirSync(taskDir(home, id), { recursive: true });
    appendFileSync(wardenLogFile(home, id), `${new Date().toISOString()} ${line}\n`);
    return true;
  } catch {
    return false;
  }
}

// Tail of the warden log for `promptobus status`. Read whole: a run has tens
// of delivery events.
export function tailWardenLog(home: string, id: string, n = 3): string[] {
  try {
    const lines = readFileSync(wardenLogFile(home, id), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// --- end-of-turn mark --------------------------------------------------------

// End-of-turn mark for an address. The guard sets it on EVERY turn end, and it is the only sign that
// a session yielded the turn where there is no bg session. The guard counter will not do — it wipes.
function turnFile(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'waits', `${addrDir(addr)}.turn.json`);
}

export function markTurn(home: string, id: string, addr: string, at: string = new Date().toISOString()): string {
  writeJsonAtomic(turnFile(home, id, addr), { at });
  return at;
}

// When the address last yielded the turn; milliseconds, or `null` — there
// has never been a mark.
export function lastTurnAt(home: string, id: string, addr: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(turnFile(home, id, addr), 'utf8')) as { at?: unknown };
    const at = Date.parse(typeof raw?.at === 'string' ? raw.at : '');
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

// --- session-to-task bindings: a file per session, without which the task was inferred by "the only
// active one" and a foreign session took it. Where there is no identity, resolve falls back to that guess.
export function sessionFile(home: string, session: string | null): string | null {
  if (typeof session !== 'string' || !TASK_ID_RE.test(session)) return null;
  return path.join(sessionsDir(home), `${session}.json`);
}

/** Mark binding a session to a task. `role` and `address` are written when the caller knows them:
 * missing fields are lawful — the orchestrator writes a binding too, with one known address. */
export interface Binding {
  session: string;
  task: string;
  since: string;
  role?: string;
  address?: string;
}

export function readBinding(home: string, session: string | null): Binding | null {
  const file = sessionFile(home, session);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Binding;
  } catch {
    return null;
  }
}

export function writeBinding(home: string, mark: Binding): Binding {
  return writeJsonAtomic(sessionFile(home, mark.session) as string, mark);
}

/** Names of sessions that have a binding mark. Cleanup walks this list. */
export function bindingNames(home: string): string[] {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length));
}

export function dropBinding(home: string, session: string): void {
  const file = sessionFile(home, session);
  if (file) rmSync(file, { force: true });
}

// --- task-journal lock: the primitive is shared by both stores ([fs/lock.ts](fs/lock.ts)); what stays
// here are its refusal words and suspending the journal cache. Holders register as a list, not a field.

/** Wrapper that suspends the journal cache for the duration of the call. */
export type Suspend = <T>(fn: () => T) => T;

const suspenders: Suspend[] = [];

export function onTaskLock(suspend: Suspend): void {
  suspenders.push(suspend);
}

/** Who holds the task lock. */
export type { LockHolder };

// Busy-lock refusal. Only a live holder reaches here: a dead one was dropped
// by `dropDeadLock`.
export function lockBusyError(id: string, lock: string, held: LockHolder | null, waitedMs: number): GateError {
  const who = held?.pid
    ? `Held by a live process ${held.pid}${held.session ? ` (session ${held.session})` : ''}`
      + `${held.since ? `, since ${held.since}` : ''} — wait for it and retry the command;`
      + ` to see what it is doing: ps -p ${held.pid}`
    : 'Who holds it, the lock did not name: the owner file was not written — that is how a process looks that died'
      + ' between creating the directory and the write. Delete the lock directory if the writing process is already gone from the system';
  return new GateError(`task ${id} journal is busy: waited ${waitedMs} ms, lock ${lock}. ${who}`);
}

// Task lock, exported for journal read-modify-write on the adapter side and for the test, whose seam
// is `waitMs`. Session identity arrives as an ARGUMENT and only for busy-lock diagnosis.
export function withTaskLock<T>(home: string, id: string, fn: () => T, {
  waitMs = LOCK_WAIT_MS, session = null,
}: { waitMs?: number; session?: string | null } = {}): T {
  const task = requireTaskId(id);
  const lock = lockDir(home, task);
  const guarded = suspenders.reduce<() => T>((inner, suspend) => () => suspend(inner), fn);
  return withDirLock(lock, guarded, {
    waitMs,
    session,
    // No task directory at all is not a busy lock: we speak with the words and the CLASS of
    // `readTask` — the same text with a stack or without reads as two different outcomes.
    onMissing: () => new GateError(`task ${id} is not in ${tasksDir(home)}`),
    onBusy: (held, waitedMs) => lockBusyError(id, lock, held, waitedMs),
  });
}

/** Publication lock, adapter side: a sweep judges a payload under the lock a send names one in.
 * [reference/04-protocol.md#store-layout](../docs/reference/04-protocol.md#store-layout) */
export function withBlobLock<T>(home: string, id: string, fn: () => T, {
  waitMs = LOCK_WAIT_MS, session = null,
}: { waitMs?: number; session?: string | null } = {}): T {
  const task = requireTaskId(id);
  const lock = blobLockDir(home, task);
  return withDirLock(lock, fn, {
    waitMs,
    session,
    onMissing: () => new GateError(`task ${id} is not in ${tasksDir(home)}`),
    onBusy: (held, waitedMs) => lockBusyError(id, lock, held, waitedMs),
    onSelfAsync: () => new GateError(`task ${id} payloads are held by an asynchronous publication `
      + `of this process (lock ${lock}) — waiting for it here would block the loop that has to `
      + 'release it, so there is nothing to wait for'),
  });
}

// Claim the warden place first-wins — one decision under the lock: a check
// and a write apart are TOCTOU, and two would watch the same task.
export function claimWarden(home: string, id: string, {
  pid = process.pid, cli = null, harness = null, session = null,
}: { pid?: number; cli?: string | null; harness?: string | null; session?: string | null } = {}): { busy?: WardenMark; mark?: WardenMark } {
  return withTaskLock(home, id, () => {
    const busy = liveWarden(home, id);
    if (busy) return { busy };
    const now = new Date().toISOString();
    const mark: WardenMark = { pid, started: now, beat: now, ...(cli ? { cli } : {}), ...(harness ? { harness } : {}) };
    writeWardenMark(home, id, mark);
    bumpWardenGeneration(home, id);
    return { mark };
  }, { session });
}

// Heartbeat: only OUR own mark is extended, and only an existing one. The place was taken — `null`,
// and the process exits on that: two must not watch the same task.
export function beatWarden(home: string, id: string, {
  pid = process.pid, session = null,
}: { pid?: number; session?: string | null } = {}): WardenMark | null {
  return withTaskLock(home, id, () => {
    const mark = readWardenMark(home, id);
    if (!mark || mark.pid !== pid) return null;
    mark.beat = new Date().toISOString();
    writeWardenMark(home, id, mark);
    return mark;
  }, { session });
}

// Only our own mark is cleared: a process whose place was taken would carry off a foreign record,
// and the next reader would see "no warden" while one is live.
export function clearWarden(home: string, id: string, pid: number = process.pid, {
  session = null,
}: { session?: string | null } = {}): boolean {
  if (!existsSync(taskDir(home, id))) return false;
  return withTaskLock(home, id, () => {
    const mark = readWardenMark(home, id);
    if (mark && mark.pid !== pid) return false;
    dropWardenMark(home, id);
    return true;
  }, { session });
}

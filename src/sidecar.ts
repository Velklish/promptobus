// Task-directory files no store holds: participant contact points, delivery
// health, the warden mark and log, stall and end-of-turn marks, session-to-task
// bindings, and the participant files directory.
//
// Why they live here, not in a store. The store is versioned — correspondence,
// participants, and artifacts move with the protocol version. These files do
// not belong to the protocol at all: the adapter names their format and is the
// one that reads and writes them, and a migration copies them byte for byte.
// A separate module makes that boundary visible: cutover replaced the store,
// not these files.
//
// Both stores name the task-directory layout (`<home>/tasks/<id>`) the same
// way, so the path comes from [protocol.ts](protocol.ts) — the shared bus
// dictionary.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { writeFileAtomic, writeJsonAtomic } from './fs/atomic.js';
import { LOCK_WAIT_MS, withDirLock } from './fs/lock.js';
import type { LockHolder } from './fs/lock.js';
import { pidAlive } from './fs/proc.js';
import { addrDir, GateError, TASK_ID_RE, taskDir, tasksDir } from './protocol.js';

// --- directories -------------------------------------------------------------

export function workersDir(home: string, id: string): string {
  return path.join(taskDir(home, id), 'workers');
}

// Session-to-task bindings — next to `tasks/`: resolve must answer in one read.
export function sessionsDir(home: string): string {
  return path.join(home, 'sessions');
}

// --- task warden -------------------------------------------------------------

// Listening on the bus is held by a process, not by the model. It has no
// state of its own — everything lives here, in the task directory: the
// warden dying loses nothing, and a restart starts from the same place.

// Process mark: `{pid, started, beat, cli, harness}`.
//
// The file name is leftover from the former warden name and must not be
// renamed: a task opened by the previous release is read by the new CLI, and
// under a new name its mark would go unseen — two wardens would stand on one
// task, each with its own delivery loop.
export function wardenMarkFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'supervisor.json');
}

// Participant contact point — the address of their messaging socket and the
// token to it. The participant hands it over themselves: the harness puts the
// socket address and token into the environment of every child process of the
// session — the warden needs neither a session registry nor the participant
// pid. The token is a secret; the file is written with mode `0600`.
export function wakeFile(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'wake', `${addrDir(addr)}.json`);
}

// What the warden knows about delivery to each address. A file of its own,
// not fields on the task journal: a write happens on every delivery, and the
// journal is edited under the lock.
export function healthFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'health.json');
}

// Warden log — line-oriented, append-only: deliveries, rollbacks, escalations.
// A person reads it when asking why a participant stayed silent. This is NOT
// the task journal: that one holds the task. The file name is the former one
// for the same reason as `wardenMarkFile` above.
export function wardenLogFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'supervisor.log');
}

export function stallsFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'stalls.json');
}

// How often the warden refreshes its mark. The constant lives here, next to
// the liveness read: a process is live by the freshness of `beat`, and if the
// write period drifted from the stale threshold the mechanism would declare
// a live one dead. The `liveWarden` threshold is three periods: one missed
// beat happens under machine load.
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

// The live warden of this task, or `null`. Two signs, both required: a live
// pid (the system reuses numbers) and an unstale `beat` (a process killed
// between beats would otherwise count as live for up to three periods).
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

// Hand over the contact point. It is called often, so a file with the same
// contents is not rewritten — otherwise every bus-tool call would cost a disk
// write. Mode `0600`: the file holds the session token; on macOS the mode is
// not actually enforced, but the token is stored and sent always — code
// without it is not portable.
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
  if (was && was.socket === next.socket && was.token === next.token && was.pid === next.pid) return was;
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

/**
 * Mark of reported stalls: reason, time of the last report, and a try
 * counter per address. The former CLI wrote a bare reason string here — that
 * is read as a mark with no time, and such a stall is repeated only when the
 * reason changes.
 */
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

// Append a line to the warden log. No lock and no atomic replace:
// `appendFileSync` of one line shorter than the pipe buffer does not tear,
// and there is one writer. A log-write refusal must not stop delivery.
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

// End-of-turn mark for an address: `waits/<address>.turn.json`, next to the
// loop-guard counter. The guard sets it — it is called on EVERY turn end —
// and it is the only sign that "the session yielded the turn" for a
// participant with no bg session: an orchestrator interactive session has no
// harness session record at all. The guard counter will not do: it lives
// only while the guard is returning the turn, and a clean pass WIPES it.
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

// --- session-to-task bindings ----------------------------------------
//
// The binding is a file per session, next to `tasks/`: without it the
// session task was inferred by the "only active one" guess — with several
// active the bus refused the session that came up, with one a foreign
// session took it as its own. Hybrid: where there is no identity (manual
// start, tests, CI), resolve falls back to that same guess. The session
// name is checked against the task-id grammar — if it does not fit, there
// is no binding at all.
export function sessionFile(home: string, session: string | null): string | null {
  if (typeof session !== 'string' || !TASK_ID_RE.test(session)) return null;
  return path.join(sessionsDir(home), `${session}.json`);
}

/**
 * Mark binding a session to a task.
 *
 * `role` and `address` are optional and are written when the caller knows
 * them. They were added for participant identity (role and task): today that
 * identity reaches the session only through the env of its mcp-config, and
 * when it starts being read from the binding the field will already be
 * there — a second migration will not be needed. Missing fields are lawful:
 * the orchestrator writes a binding too, and it has one known address.
 */
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

// --- task-journal lock -------------------------------------------------------
//
// The primitive lives in [fs/lock.ts](fs/lock.ts) and is shared by both
// stores; what stays here are the words of its refusals — they are for a
// person — and suspending the journal cache for the duration of the lock.
//
// The cache is suspended by whoever holds it: under the lock the journal
// changes both by this write and by the foreign one the lock waited out.
// Holders register as a list, not as a single field: the package has two
// stores, and the second registrar must not undo the first.

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

// Task lock. Exported for journal read-modify-write on the adapter side
// (`markWorktreesSwept` in `promptobus done`) and for the test — `waitMs` is
// its seam.
//
// Session identity arrives as an ARGUMENT and only for busy-lock diagnosis:
// whose process holds the journal is known to the environment, and the
// adapter reads the environment. Unnamed — the refusal will say "who holds
// it, the lock did not name".
export function withTaskLock<T>(home: string, id: string, fn: () => T, {
  waitMs = LOCK_WAIT_MS, session = null,
}: { waitMs?: number; session?: string | null } = {}): T {
  const lock = path.join(taskDir(home, id), '.lock');
  const guarded = suspenders.reduce<() => T>((inner, suspend) => () => suspend(inner), fn);
  return withDirLock(lock, guarded, {
    waitMs,
    session,
    // No task directory at all — that is not a busy lock: we speak with the
    // words and the class of `readTask`. The class is required on a par with
    // the words: the same text arriving with a stack or without is read as
    // two different outcomes.
    onMissing: () => new GateError(`task ${id} is not in ${tasksDir(home)}`),
    onBusy: (held, waitedMs) => lockBusyError(id, lock, held, waitedMs),
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
    return { mark };
  }, { session });
}

// Heartbeat: only OUR own mark is extended, and only an existing one. The
// place was taken — `null` is returned, and the process exits on that:
// two must not watch the same task.
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

// Only our own mark is cleared: a process whose place was taken would carry
// off a foreign record — and the next reader would see "no warden" while one
// is live.
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

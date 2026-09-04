// Directory lock: task-journal read-modify-write sits under it, for both the
// legacy store and protocol v1.
//
// The lock is a directory, not a file: `mkdir` is atomic on every FS and does
// not need a descriptor cleaned up; a second process gets `EEXIST` instead of
// a quiet overwrite. A foreign lock is dropped only on a dead pid, never on a
// guess about age.
//
// Refusal wording did not move here and will not: the legacy store has its own
// (`GateError` with a path for a person), v1 has its own (a typed code). The
// module takes them as callbacks.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pidAlive, sleepSync } from './proc.js';

export const LOCK_WAIT_MS = 5000;
export const LOCK_RETRY_MS = 20;

/** Who holds the lock: without an owner file the advice "delete the directory if the process is gone" cannot be followed. */
export interface LockHolder {
  pid: number | null;
  session: string | null;
  since: string | null;
}

/**
 * Who holds the lock. A former-CLI lock holds the pid as a string — that is
 * read too: the only process that can outlive the directory is one that died
 * mid-write.
 */
export function lockHolder(lock: string): LockHolder | null {
  let raw;
  try { raw = readFileSync(path.join(lock, 'owner'), 'utf8').trim(); } catch { return null; }
  if (!raw) return null;
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* not JSON — a former-CLI lock */ }
  // The object check is not a formality: a bare pid of the former format is
  // valid JSON, and `JSON.parse('999999')` yields a number with no `pid` field.
  if (parsed && typeof parsed === 'object') return parsed as LockHolder;
  return { pid: Number(raw) || null, session: null, since: null };
}

/**
 * An orphaned lock — by pid liveness: a process that died mid-write leaves the
 * directory forever. We take the directory aside with `rename`, not delete it
 * in place: between a foreign `rm` and our own `mkdir` a neighbour would slip
 * in, and a second cleaner would wipe its fresh lock. A holder with no pid is
 * left alone: between `mkdir` and writing the owner file the lock is a live
 * grab, not an orphan.
 */
export function dropDeadLock(lock: string): boolean {
  const held = lockHolder(lock);
  if (!held?.pid || pidAlive(held.pid)) return false;
  const tomb = `${lock}.dead.${process.pid}`;
  try { renameSync(lock, tomb); } catch { return false; }
  rmSync(tomb, { recursive: true, force: true });
  return true;
}

/** How the lock answers its two lawful refusals. The words are the caller's business. */
export interface DirLockOptions {
  waitMs?: number;
  retryMs?: number;
  /** Session identity in the owner file: pid answers "is it alive", session answers "whose is it". */
  session?: string | null;
  /** The directory the lock is taken in does not exist at all — that is not a busy lock, it is a missing subject. */
  onMissing: () => Error;
  /** The lock is held by a live holder longer than allowed. */
  onBusy: (held: LockHolder | null, waitedMs: number) => Error;
}

/**
 * Locks taken by THIS process right now. Needed for nesting: an adapter
 * read-modify-write takes the task lock, and a store operation inside it takes
 * the same one — and without accounting for its own locks the process would
 * sit out `waitMs` on itself and refuse with "journal busy", naming its own
 * pid as the holder.
 *
 * Nesting is lawful and safe: the lock separates PROCESSES, and inside a
 * process the stretch under it is synchronous, so the nested call is the same
 * critical section. Only the call that took the lock drops it: the inner one
 * leaves without touching the directory.
 */
const held = new Set<string>();

/**
 * Take the lock directory, run, and drop. A dead holder is dropped while
 * waiting; a live one sits out `waitMs` and refuses in the caller's words.
 */
export function withDirLock<T>(lock: string, fn: () => T, {
  waitMs = LOCK_WAIT_MS, retryMs = LOCK_RETRY_MS, session = null, onMissing, onBusy,
}: DirLockOptions): T {
  // Our own lock — we work inside it. A missing task directory still stays the
  // outer call's refusal: it does not reach here.
  if (held.has(lock)) return fn();
  const started = Date.now();
  const deadline = started + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(path.join(lock, 'owner'), `${JSON.stringify({
        pid: process.pid, session, since: new Date().toISOString(),
      })}\n`);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw onMissing();
      if (code !== 'EEXIST') throw e;
      if (dropDeadLock(lock)) continue;
      if (Date.now() >= deadline) throw onBusy(lockHolder(lock), Date.now() - started);
      sleepSync(retryMs);
    }
  }
  held.add(lock);
  try {
    return fn();
  } finally {
    held.delete(lock);
    rmSync(lock, { recursive: true, force: true });
  }
}

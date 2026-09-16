// The lock: what it guards and what it cannot.
// [reference/01-overview.md#the-lock-what-it-guards-and-what-it-cannot](../../docs/reference/01-overview.md#the-lock-what-it-guards-and-what-it-cannot)
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

/** Who holds the lock. A former-CLI lock holds the pid as a string and is read too: the only process
 * that can outlive the directory is one that died mid-write. */
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

/** An orphaned lock, by pid liveness. Taken aside with `rename` rather than deleted in place, or a
 * neighbour would slip in between; a holder with no pid is a live grab and is left alone. */
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

/** Locks taken by THIS process right now, for nesting: without them a process would sit out `waitMs`
 * on itself. Nesting is safe — the lock separates PROCESSES — and only the outer call drops it. */
const held = new Set<string>();

/** Take the lock directory, run, and drop. A dead holder is dropped while waiting; a live one sits
 * out `waitMs` and refuses in the caller's words. */
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

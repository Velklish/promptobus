// Reading about a process.
// [reference/01-overview.md#reading-about-a-process](../../docs/reference/01-overview.md#reading-about-a-process)
import process from 'node:process';

/**
 * Whether the process is alive. Signal 0 sends nothing, it only checks that the
 * target is reachable; `EPERM` means "the process exists, but it is not ours" —
 * also alive.
 */
export function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Synchronous pause: the lock is taken from synchronous code, and there is no event loop to yield to there. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

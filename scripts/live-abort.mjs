// Cleanup of a live run cut off by a signal: `finally` of the script body never runs on one.
// The contract and why the handler goes first — contributing guide § Live harness scenarios.
import { writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

// `SIGKILL` cannot be handled; what it leaves is the next run's sweep.
export const ABORT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Shell convention `128 + number`; a signal the table does not name exits 1, never 0. */
export function exitCodeOf(signal, signals = os.constants.signals) {
  const n = signals?.[signal];
  return Number.isInteger(n) ? 128 + n : 1;
}

/** How long an awaited cleanup may run before the exit goes without it. */
export const ABORT_WAIT_MS = 15_000;

// A separate group makes a parent-only signal and a terminal group signal one forwarding path.
export function runCanaryChild(entry, { cwd, env, fd, waitMs = ABORT_WAIT_MS }) {
  const child = spawn(process.execPath, [entry], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let abort = null, timer, logError, remaining = 64 * 1024 * 1024;
    const capture = bytes => {
      if (logError) return;
      try {
        const length = Math.min(remaining, bytes.length);
        for (let n = 0; n < length;) n += writeSync(fd, bytes, n, length - n);
        remaining -= length;
        if (length !== bytes.length) logError = new Error('live output exceeded 64 MiB');
      } catch (error) { logError = error; }
    };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', capture);
    const finish = (status, terminated, error) => {
      clearTimeout(timer);
      for (const signal of ABORT_SIGNALS) process.off(signal, forward);
      for (const stream of [child.stdout, child.stderr]) stream.off('data', capture);
      if (error || (!abort && logError)) reject(error ?? logError);
      else resolve({ status, abort, terminated, pid: child.pid });
    };
    const forward = signal => {
      if (abort) return;
      abort = signal;
      timer = setTimeout(() => { child.unref(); finish(null, false); }, waitMs);
      child.kill(signal);
    };
    for (const signal of ABORT_SIGNALS) process.on(signal, forward);
    child.once('error', error => {
      if (!abort) finish(null, false, error);
    });
    child.once('close', code => finish(code, true));
  });
}

// Awaited cleanup needs a sandbox outside the helper's own signal handler (`signalCleanup: false`).
export function onAbort(cleanup, {
  signals = ABORT_SIGNALS,
  on = (sig, fn) => process.prependListener(sig, fn),
  exit = (code) => process.exit(code),
  say = (line) => writeSync(2, line),
  waitMs = ABORT_WAIT_MS,
} = {}) {
  let taken = false;
  let finished = false;
  const finish = (signal) => {
    if (finished) return;
    finished = true;
    exit(exitCodeOf(signal));
  };
  for (const signal of signals) {
    on(signal, () => {
      if (taken) return;
      taken = true;
      let result = null;
      let then = null;
      let broke = null;
      let failed = false;
      try {
        result = cleanup(signal);
        then = result?.then;
      } catch (e) {
        broke = e;
        failed = true;
      }
      if (failed) {
        say(`✖ cleanup after ${signal} broke off: ${broke?.message ?? broke}\n`);
        finish(signal);
        return;
      }
      if (typeof then !== 'function') {
        finish(signal);
        return;
      }
      const overdue = setTimeout(() => {
        say(`✖ cleanup after ${signal} did not end in ${waitMs} ms — exiting without it\n`);
        finish(signal);
      }, waitMs);
      Promise.resolve({ then: (resolve, reject) => then.call(result, resolve, reject) }).then(
        () => { clearTimeout(overdue); finish(signal); },
        (e) => {
          clearTimeout(overdue);
          say(`✖ cleanup after ${signal} broke off: ${e?.message ?? e}\n`);
          finish(signal);
        },
      );
    });
  }
}

// Cleanup of a live run cut off by a signal: `finally` of the script body never runs on one.
// The contract and why the handler goes first — contributing guide § Live harness scenarios.
import { writeSync } from 'node:fs';
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

// Prepended: the sandbox helper's own handler exits 130 and would otherwise run first. An
// AWAITED cleanup needs the run's sandbox outside that handler (`signalCleanup: false`).
/** Run `cleanup(signal)` once on the first abort signal, then exit with its code. A cleanup that
 *  returns a thenable is awaited up to `waitMs`; the exit keeps its code either way. */
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

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

/** Run a synchronous `cleanup(signal)` once on the first abort signal, then exit with its code.
 *  Prepended: the sandbox helper's own handler exits 130 and would otherwise run first. */
export function onAbort(cleanup, {
  signals = ABORT_SIGNALS,
  on = (sig, fn) => process.prependListener(sig, fn),
  exit = (code) => process.exit(code),
  say = (line) => writeSync(2, line),
} = {}) {
  let taken = false;
  for (const signal of signals) {
    on(signal, () => {
      if (taken) return;
      taken = true;
      try {
        cleanup(signal);
      } catch (e) {
        say(`✖ cleanup after ${signal} broke off: ${e?.message ?? e}\n`);
      }
      exit(exitCodeOf(signal));
    });
  }
}

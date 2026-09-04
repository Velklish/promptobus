// Shared suite helper: a check verdict. Not `*.test.mjs` — the runner
// (run.mjs) takes only those from the directory, so this file is not
// in the run.
//
// Fixes one problem. `fail()` inside the code under test is
// `process.exit(1)`. While each file stacked verdicts in its own array
// and printed them at the tail, such a crash took every verdict of the
// file at once, including ones that had already passed: the runner saw
// a failed file, and what it failed on did not follow from the output.
// This hit the mutation probe hardest: a check below the crash point
// does not run at all, and there is no way to tell a "lying" check from
// one that "never reached" — and the repository rule requires exactly
// that distinction.
//
// We print as they accumulate, rather than flushing an array in the
// `exit` handler: the verdict leaves the process the moment it is
// obtained, and does not depend on whether the process itself lives to
// the handler. The hook keeps only the summary — the "N/M passed" line
// and, if the file was cut off, the abort mark.
//
// We write to descriptor 1 directly, past `console`, for two reasons
// at once:
//   • tests swap `console.log` to catch CLI output, and `process.exit()`
//     from `fail()` takes the process past `finally` — the swapped
//     console stays, and the verdict would go into it in exactly the
//     case this is all for;
//   • `writeSync` is synchronous on any stdout, while
//     `process.stdout.write` on macOS writes to a pipe asynchronously —
//     output from the `exit` handler is lost there entirely.
import { writeSync } from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { makeSandbox } from './sandbox.mjs';
import { HOME_VARS, applyHygiene } from './hygiene.mjs';

// The list of "what the suite must not touch" is shared with the runner
// and lives in one place — [hygiene.mjs](hygiene.mjs). That file also
// says why each variable is in it: warden auto-lift, this session's
// contact point, the user home, the memory-hook lever.
//
// It is applied here, not only in the runner: a suite file is also run
// alone — by hand, while debugging — and that is when a miss costs the
// most. A `process.env` edit is inherited by every process the file
// starts later, so one apply covers the whole tree.
//
// Home is swapped only if the environment holds the real one. The
// signal comes from the system, not the environment: under the runner
// home is already diverted, and swapping it a second time is pointless.
// On Windows `os.userInfo()` reads the same `USERPROFILE`, so the
// signal also fires under the runner — the file gets its own sandbox
// instead of the issued one, both inside the run directory, and there
// is no harm in that.
const REAL_HOME = os.userInfo().homedir;
const home = HOME_VARS.some((name) => process.env[name] === REAL_HOME)
  ? makeSandbox('promptobus-home-') : null;
applyHygiene(process.env, { home });

const results = [];
// `beforeExit` fires only on a natural finish — when the event loop
// has emptied; `process.exit()` skips it. That is how we tell "the
// file reached the end" from "the file was cut off", without which an
// incomplete summary would read as complete.
let finished = false;
process.on('beforeExit', () => { finished = true; });

// Pause between write attempts. `writeSync` is synchronous, there is
// no event loop here at all, and there is nothing to yield a tick to —
// we sleep for real, `Atomics.wait` on our own memory.
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

function out(line) {
  const buf = Buffer.from(`${line}\n`);
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off);
    } catch (e) {
      // EAGAIN — the non-blocking pipe is full, write the rest later.
      // Any other error means there is nowhere left to write.
      if (e.code !== 'EAGAIN') return;
      // Wait for the reader to drain the pipe. Without a pause the
      // loop spins hot: the same EAGAIN arrives millions of times a
      // second, the process burns a core and gets in the way of the
      // one who should drain the pipe. Two milliseconds per round are
      // invisible on a verdict line and turn a busy-loop into a wait.
      Atomics.wait(PAUSE, 0, 0, 2);
    }
  }
}

// Check verdict: name, condition, and a detail printed only on red.
export function check(name, cond, detail = '') {
  const ok = !!cond;
  results.push({ name, ok });
  // The exit code is set on the spot: in the `exit` handler it can no
  // longer be changed, and the check may not live to the file tail.
  if (!ok) process.exitCode = 1;
  out(`${ok ? '✔' : '✖'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

process.on('exit', () => {
  const passed = results.filter((r) => r.ok).length;
  // `beforeExit` alone is not enough. An unresolved top-level promise
  // empties the event loop — `beforeExit` fires, the file is counted
  // as having reached the end — and the process exits with code 13
  // (`unsettled top-level await`). The summary then printed
  // "1/1 passed" about a file cut off on the first check; only the
  // runner made the run red, by exit code, and a person read a complete
  // summary next to a failed file.
  // So the second check is by code: a file that reached the end exits
  // with exactly the code its verdicts assigned; any other means abort.
  //
  // The code is taken from `process.exitCode`, not from the handler
  // argument: the argument is computed before Node sets 13 on an
  // unresolved top-level await, and on Node 20 it arrives as zero at a
  // real exit code of 13 — abort there became indistinguishable from a
  // clean end. Node installs its own handler before ours, so by this
  // moment `process.exitCode` holds 13 on both versions; in every other
  // outcome it equals the argument. There is nothing to take in
  // `beforeExit` — there it is still `undefined` on both Node 20 and
  // Node 25.
  const code = process.exitCode ?? 0;
  const expected = passed === results.length ? 0 : 1;
  if (finished && code === expected) {
    out(`\n${passed}/${results.length} passed`);
    return;
  }
  const last = results.length ? `after check "${results[results.length - 1].name}"` : 'before the first check';
  out(`\n${passed}/${results.length} passed before abort`);
  // The abort reason is not named: the same path takes the file on
  // `process.exit()` from `fail()`, an unhandled exception, and a
  // rejected promise with no handler. Naming one of them sends the
  // reader looking for a `fail()` that was not there; the exception
  // itself is visible on stderr next to it.
  out(`✖ abort: process exited with code ${code} ${last} — checks below did not run, there are no verdicts for them`);
});

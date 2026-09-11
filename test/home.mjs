// The suite's home diversion, applied at module load. Not `*.test.mjs` — the
// runner (run.mjs) takes only those from the directory, so this file is not in
// the run.
//
// Home was diverted in two places and neither covered a file run BY HAND.
// [run.mjs](run.mjs) builds a per-file home for every child of a run;
// [check.mjs](check.mjs) applied the shared hygiene list at module load — but
// only for the files that IMPORT it. A file written against `node:test` imports
// the verdict helper not at all, so run alone it saw `os.homedir()` and wrote
// there. That is why this lives on its own: `check.mjs` is a verdict printer,
// and half the suite has no use for one.
//
// Measured on this tree, 2026-09-05: 22 of the 46 suite files import no verdict
// helper. NONE of them writes under home today, and that is not luck — the two
// that did (`model-routing.test.mjs`, `model-routing-command.test.mjs`) each
// carried a copy of this diversion. With those two copies removed, both write
// `~/.promptobus/model-routing/cache.json` on a hand run, measured by watching a
// probe home rather than by reading the code. So what is closed here is the
// absence of an apply, not a leak in progress — and one apply point instead of
// two copies and twenty files with nothing.
//
// **This module borrows nothing, and that is the point.** It has to run before
// any module that could resolve a home path at load, so it cannot import one on
// the way in. `makeSandbox` from [sandbox.mjs](sandbox.mjs) would be the natural
// reuse and is exactly what it must not do: that module statically imports three
// package modules, and they would all be evaluated before the line below. So the
// sandbox and its keep-until-exit are written out here. The one non-builtin
// import is [hygiene.mjs](hygiene.mjs), which holds the shared list and itself
// imports nothing but Node built-ins; the sentinel in `tmpdir-sweep.test.mjs`
// keeps both facts true.
//
// The signal comes from the SYSTEM, not the environment. `os.userInfo()` reads
// the passwd record and ignores `$HOME`, so under the runner — where `$HOME` is
// already a run directory — nothing matches and no second sandbox is made. On
// Windows `os.userInfo()` reads the same `USERPROFILE`, so the signal also fires
// under the runner there: the file gets its own sandbox instead of the issued
// one, both inside the run directory, and there is no harm in that.
// The runner also issued `CLAUDE_CONFIG_DIR=<run home>/.claude`; when no second
// home is needed, the nested hygiene apply keeps that value while the issued home
// is live. Any config path other than `<current home>/.claude` is still dropped.
//
// Everything else the call applies — the warden switch, the session-leak list,
// the memory-hook lever, the PATH seal — is the shared list in
// [hygiene.mjs](hygiene.mjs), which is also where each name's reason is written.
// One `process.env` edit is inherited by every process the file starts later, so
// one apply covers the whole tree below it.
import { mkdtempSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { HOME_VARS, applyHygiene } from './hygiene.mjs';

// Sandbox lifetime, written out rather than imported, for the reason above. The
// real `process.exit` is captured now: suite files swap it with a thrower to catch
// `fail()` refusals, and a signal hook calling the swapped one would raise an
// unhandled exception instead of exiting 130. Capturing it here, before any suite
// file has run, is the earliest it can be taken. `exit` covers a failed check and
// a crash; the three signals cover an interrupt. Under the runner the directory
// already lives inside the run directory, which the runner removes.
const exit0 = process.exit;

function sandboxHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'promptobus-home-'));
  const clean = () => rmSync(dir, { recursive: true, force: true });
  process.on('exit', clean);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { clean(); exit0.call(process, 130); });
  }
  return dir;
}

const REAL_HOME = os.userInfo().homedir;
const home = HOME_VARS.some((name) => process.env[name] === REAL_HOME) ? sandboxHome() : null;
applyHygiene(process.env, { home });

// Watchdog: a suite file must exit on its own, and a file run BY HAND has nothing
// to make it.
//
// [run.mjs](run.mjs) gives every file of a run a deadline and takes a late one down
// with SIGKILL. A single-file run — `node test/<file>.test.mjs`, the form the
// mutation-probe rule prescribes — has no deadline, no child bookkeeping and no
// parent to notice: when the session that started it dies, the file becomes an
// orphan with `PPID 1` that nothing will ever collect. Measured on the owner's
// machine at the end of run 0911e: five such processes, all older than the sessions
// that could have started them, one of them holding a core for two days (PB-166).
//
// **Unref'd, and that is the whole mechanism.** A file that has FINISHED its work
// empties its event loop and exits, and an unref'd timer neither holds the loop open
// nor ever fires — so a finished file pays nothing for this. A file still alive at
// the deadline has, by definition, something holding its loop, and
// `getActiveResourcesInfo()` names it. The diagnosis is the point: the runner's own
// take-down says "taken down as hung" and nothing about what held it.
//
// **`unref` saves the file that finished, and only that one. This is a second
// deadline on a file's WHOLE WORK, and it is stated as one rather than sold as free.**
// A file still honestly working at the deadline has a live loop like any other, so it
// is taken down too — the timer cannot tell unfinished work from a leaked handle, and
// the message below therefore names both readings instead of accusing the file.
//
// What the second ceiling actually costs, in the two forms separately:
//
//   • under `npm test` it moves the ceiling from the runner's 300 s to 240 s, four
//     fifths. A file in that band was already failing before this — the runner would
//     have SIGKILLed it at 300 s as "hung" — so what changes there is 60 s of headroom
//     and a diagnosis in place of a blind kill;
//   • run BY HAND there was no ceiling at all, and now there is one. That is a NEW
//     constraint on a form that previously had none, and it is the honest cost of
//     closing the hole: an orphan cannot be prevented without some deadline.
//
// The margin is not as wide as the fast case suggests. The slowest file measured
// alone is 44.5 s (2026-09-12, all 55 run one by one), but [run.mjs](run.mjs) records
// `promptobus-package.test.mjs` at **186.5 s** under the pool on a machine at load
// average 8 (2026-09-02, before the fix that brought it to 14.4 s). That is 0.78 of
// this ceiling. A file that legitimately needs longer must be split, moved to the
// serial group, or given a larger number here — and the number lives in one place so
// that raising it is one edit.
//
// **What it cannot catch, and this is a limit, not an oversight:** a file spinning
// inside synchronous work never returns to its event loop, so no timer of its own
// ever runs. That is the shape of the orphan the card measured at 100 % of a core,
// and the same reason SIGTERM did not touch it — no JS handler of any kind runs
// there. Only the runner's SIGKILL reaches that one, and only under a run.
//
// Written to descriptor 2 past `console` for the reason [check.mjs](check.mjs)
// writes past it — suite files swap `console` to catch CLI output — and the exit
// goes through the `process.exit` captured above, for the reason the signal hooks
// use it: files swap it with a thrower to catch `fail()` refusals.
//
// The write goes through the same drain loop as the verdict printer, and for the same
// reason: a bare `writeSync` onto a non-blocking pipe raises EAGAIN, and here that
// would be an uncaught exception at the exact moment the diagnostic matters — the
// process would still exit non-zero and the message this whole mechanism exists to
// print would be gone. Under the runner descriptor 2 is a file and cannot refuse;
// a hand run into a pipe can, and a hand run is what this watchdog is for. The loop
// is written out rather than imported: `check.mjs` is where it lives, and `check.mjs`
// imports THIS file — the one direction the dependency may not take.
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

function out(line) {
  const buf = Buffer.from(line);
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(2, buf, off);
    } catch (e) {
      // EAGAIN — the pipe is full; wait for the reader instead of spinning hot on it.
      // Anything else means there is nowhere left to write, and the exit below still
      // carries the verdict.
      if (e.code !== 'EAGAIN') return;
      Atomics.wait(PAUSE, 0, 0, 2);
    }
  }
}
const WATCHDOG_MS = 240_000;
setTimeout(() => {
  const held = [...new Set(process.getActiveResourcesInfo())].sort();
  // Both readings, in this order, because the watchdog cannot tell them apart and an
  // accusation it cannot support is worse than no message. Unfinished work comes
  // first: it is the one a person can act on by reading the file's own output above.
  out(`\n✖ watchdog: still alive ${WATCHDOG_MS / 1000} s after start, and the event loop is not empty.`
    + ' Either the work is not done — then this file needs splitting, the serial group, or a'
    + ' larger WATCHDOG_MS in test/home.mjs — or the work IS done and something holds the loop'
    + ' open, in which case the file would outlive the session that started it.\n'
    + `  what holds the loop: ${held.length ? held.join(', ') : '(nothing named)'}\n`
    + '  the file\'s own verdicts above say which of the two this is.\n');
  exit0.call(process, 1);
}, WATCHDOG_MS).unref();

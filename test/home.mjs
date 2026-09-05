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
//
// Everything else the call applies — the warden switch, the session-leak list,
// the memory-hook lever, the PATH seal — is the shared list in
// [hygiene.mjs](hygiene.mjs), which is also where each name's reason is written.
// One `process.env` edit is inherited by every process the file starts later, so
// one apply covers the whole tree below it.
import { mkdtempSync, rmSync } from 'node:fs';
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

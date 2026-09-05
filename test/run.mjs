// Chain runner: `npm test` = walk this directory. The old list in
// package.json depended on the author remembering — a file left off it
// never ran, in silence. Walk is in node, not a shell loop: npm scripts
// on Windows run under `cmd`.
//
// Files run as a pool of child processes, not one by one: per-file
// isolation is complete by construction — own process, own `mkdtemp`
// sandbox, own environment — and a sequential walk kept the machine at
// 40% of one core, because more than half the run the suite waits on
// holds and foreign processes. Measured 2026-08-30 on eight cores,
// `time npm test`: 47 files, 259.4 s wall-clock sequential at 105.6 s
// CPU (user+sys), 181.2 s with the pool.
//
// Sort by name now sets the order files are HANDED to lanes, not the
// print order: they print as they finish, and print order follows
// durations. The hand-out stays deterministic — otherwise the first
// wave's membership would drift between runs with load. Who does not
// belong in the pool — below, at `SERIAL`.
//
// A file failure does not stop the chain: files are isolated from each
// other, and stopping on the first hid the picture behind one diagnosis
// — the developer fixed the suite one file per run. Failures accumulate
// and are listed in the end summary; the exit code stays non-zero on
// any failure.
//
// A check for a contract that has no code yet is marked PENDING, not
// commented out and not left red: a red suite stops being read, and a
// commented check is forgotten. The mark is `node:test`'s own `todo`
// — `test(name, { todo: 'why' }, fn)`. Such a check runs, its failure
// is printed with the reason, and the file still exits 0, so the run
// stays green while the pending work stays visible in the file's
// `todo N` line. Two rules go with it: the title says which task turns
// it green, and the `todo` reason says why it cannot be green yet.
// Files that use the shared verdict helper ([check.mjs](check.mjs))
// have no such mark — `check` has one axis, pass or fail — so a file
// with pending checks is written against `node:test`.
// Subject today: [model-routing.test.mjs](model-routing.test.mjs).
//
// Output is buffered per file and printed whole when the file ends:
// `stdio: 'inherit'` in parallel would mash six files' lines into one
// mess. Inside a file the order is unchanged — verdicts are printed by
// the shared helper [check.mjs](check.mjs) as they accumulate, so a
// cut-off file shows what passed and where it stopped.
import {
  closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHygiene } from './hygiene.mjs';
import { sweepTestSandboxes, sweptLine } from './tmpdir-sweep.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((n) => n.endsWith('.test.mjs')).sort();

// Run sandboxes go into one directory, removed on exit — including
// failure and Ctrl+C. Each file does its own `mkdtemp` in `os.tmpdir()`,
// and `os.tmpdir()` reads TMPDIR (POSIX) and TEMP/TMP (Windows) — so
// swapping those variables sends EVERY sandbox into the run directory
// at once: those the test creates and those the library under it
// creates (hooks.js, headless.js). The files themselves need no edits.
//
// The runner cleans up, not each file: a file's trailing `rmSync` is
// exactly what does not run when it is needed — on a failed check
// (`process.exit` from `fail`) and on interrupt. Measured before the
// fix: 108 directories and 37 MB of real git repositories in system
// tmp. A green run does not leak — 33 files one by one into a clean
// TMPDIR leave zero directories; what leaks is exactly what never
// reaches the tail.
//
// Each launch has its own run directory (`mkdtemp`), so two parallel
// `npm test` runs do not collide and one cleanup does not touch the
// other's sandboxes.
const RUN_TMP = mkdtempSync(path.join(os.tmpdir(), 'promptobus-test-run-'));

// Sandboxes that survived a CUT-OFF run are swept at start. The exit
// hook ([sandbox.mjs](sandbox.mjs)) and the run-directory cleanup
// remove their own, but the run that leaves the garbage is exactly the
// one that never reaches them: Ctrl-C, file taken down at the file
// timeout, process crash. Measured 2026-09-03 on the owner's machine —
// 126 directories in system `$TMPDIR`.
//
// Sweep lives here, not in the shared helper [check.mjs](check.mjs):
// the runner is the only suite process that sees the real `$TMPDIR`;
// it sends children `TMPDIR` into the run directory on the line above.
// From `check.mjs` it would sweep the run directory with live sandboxes
// of neighbouring files, and would not touch what piled up in system
// `$TMPDIR` at all. Thresholds, prefix list, and rationale —
// [tmpdir-sweep.mjs](tmpdir-sweep.mjs); a run going on nearby is held
// by the one-hour age cut-off.
const refusedBoxes = [];
const sweptBoxes = sweepTestSandboxes(os.tmpdir(), { current: RUN_TMP, refused: refusedBoxes });
if (sweptBoxes.length) console.log(`▸ ${sweptLine('previous-run sandboxes', sweptBoxes, { keep: 0 })}`);
if (refusedBoxes.length) console.log(`▸ sweep refused (in use or foreign permissions): ${refusedBoxes.join(', ')}`);

const RAISED_LOG = 'wardens-raised.log';
const HOME_PREFIX = 'home-';
// Output buffers live in a separate folder: the run directory itself
// is TMPDIR for the children, and a file next to their sandboxes would
// be read as one more sandbox.
const OUT_DIR = path.join(RUN_TMP, 'out');
mkdirSync(OUT_DIR, { recursive: true });

// Environment of a suite file. The list of "what the suite must not
// touch" is shared with [check.mjs](check.mjs) and lives in one place
// in [hygiene.mjs](hygiene.mjs): that file also says why it holds the
// warden switch, the session contact point, the user home, and the
// memory-hook lever. The runner adds its own — the sandbox directory
// and the auto-lift trace path.
//
// The auto-lift trace (`PROMPTOBUS_WARDEN_TRACE`) lives at the root of
// the run directory, not in the task store: the store is inside the
// sandbox the test file removes, and by the end of the run the trace
// would already be gone. One file per run; every child appends to it
// at once.
function testEnv(tmp) {
  // Home is per file, not one per run: under the pool several files
  // spawn the real CLI at once, and `sync` at its tail installs memory
  // hooks into home — a shared home would be a race of two installs.
  // The directory is created immediately: the installer and
  // `os.homedir()` want an existing path, not a promise. It lives
  // inside the run directory, so it is removed with it.
  const home = mkdtempSync(path.join(tmp, HOME_PREFIX));
  return applyHygiene({
    ...process.env,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PROMPTOBUS_WARDEN_TRACE: path.join(tmp, RAISED_LOG),
  }, { home });
}

// Pool width. Two cores are left for the machine: suite files themselves
// spawn processes — the real CLI, git, stub binaries — and a lane per
// core takes time from those children rather than adding parallelism.
// The cap of six is from the same measure: forty-seven files in six
// lanes already wait on the longest file, and lanes beyond that idle.
const POOL = Math.max(1, Math.min(6, os.cpus().length - 2));

// Serial group: files whose checks measure wall-clock. Run last and
// without neighbours, on a still machine — under pool load their
// thresholds either go red on sound code or, worse, go green on
// nothing. Rationale per file, in parentheses — measured 2026-08-30:
//
// - `promptobus-warden.test.mjs` (5.3 s): the knock round goes over a
//   real unix socket, and the verdict is taken via `settle()` 50 ms
//   after it; process clocks are shifted by a 20 ms timer. Fifty
//   milliseconds under six neighbours may not be enough for a socket
//   round;
// - `promptobus-e2e.test.mjs` (32.7 s): a full orchestration round on
//   a stub harness. The knock round goes over a real unix socket
//   between four processes — CLI, warden, participant, its MCP server
//   — and the silent end-of-turn report arrives on the warden heartbeat
//   (`WARDEN_BEAT_SEC`, 30 s). Both costs are wall-clock, and under
//   pool load the knock round would hit the thresholds, while the file
//   itself spawns as many processes as a whole pool lane. What it waits
//   on is one place, named in the file: 25 s of 33 is waiting for that
//   heartbeat;
// - `runner.test.mjs` (4.6 s): a nested copy of the runner raises its
//   own lanes. The concurrency verdict reads the peak of live children
//   (`live.size` at spawn), not a `Date.now()` window in them:
//   wall-clock measures when the child got CPU, and under machine
//   neighbours it drifts on a sound pool. The 120 ms pauses stay for
//   the buffering verdict. The file is outside the pool because the
//   nested copy itself opens up to six lanes — it would take time from
//   neighbours on the run, not because the verdict needs a still
//   machine.
//
// Who is not in the group, and why. `promptobus-mcp.test.mjs` has no
// wall-clock thresholds left: its checks look at response contents and
// store counters. `fresh.test.mjs` — the only threshold is
// `spent < 10 000` at a 400 ms timeout, a twenty-five-fold margin.
// In `install.test.mjs` and `zone.test.mjs` `Date.now()` builds fixture
// age, and there is no clock threshold at all: load does not move
// those files.
// `model-routing-preflight.test.mjs` has one threshold — the whole
// preflight under a 200 ms budget must end inside 5 000 ms, the same
// twenty-five-fold margin as `fresh.test.mjs` — and the stand-in
// adapter it is measured against answers at 30 s, so a machine under
// load moves the measurement nowhere near the verdict. Everything
// else in the file is file contents, permissions and TTL arithmetic
// against a fixed instant, which load does not touch.
// `promptobus.test.mjs` left the group with its rationale: the races it
// sat there for moved into the nested package, and in the file itself
// `Date.now()` only builds fixture age — the same case as `install` and
// `zone`. Races today are run by `promptobus-package.test.mjs` as a
// child `npm test --prefix cli/packages/promptobus`, and it is out of
// the group on purpose: the race barrier releases children on readiness,
// not on a timestamp; each child's return code is checked; and the
// recovery window that made the file go red under the pool is closed
// in the store — the races have no wall-clock thresholds left. File
// measured under the pool: 186.5 s on a busy machine before vs 14.4 s
// after (2026-09-02, load average 8).
//
// The group is a list of names: a file renamed past this list would
// slip into the pool in silence. [runner.test.mjs](runner.test.mjs)
// watches that — it checks the list against the directory.
const SERIAL = ['promptobus-e2e.test.mjs', 'promptobus-mixed.test.mjs', 'promptobus-cursor-wake.test.mjs', 'promptobus-warden.test.mjs', 'runner.test.mjs'];

// File timeout. A hung file used to hang `npm test` forever: the runner
// waited on the child with no deadline, and anything can hang a file —
// an unresolved promise in swapped stdin (`answerWith`, setup.test.mjs),
// a live git over the network. A person sees a silent console and does
// not know whether the run is going or stuck.
//
// The number comes from the slowest suite file. That is now
// `promptobus-review.test.mjs`: 27.7 s alone and 32–45 s under the pool
// (measured 2026-08-30). All of that time is real work: the file builds
// git clones and diffs them, so it depends entirely on the machine and
// on lane neighbours — the spread under the pool shows that.
//
// Hence a 300 s file timeout: the worst pool run is given almost a
// seven-fold margin. A smaller one would turn a slow machine into a
// "hung file" diagnosis on a sound suite, and the timeout must catch a
// hang, not a slow machine.
//
// SIGKILL, not SIGTERM: suite files hang sandbox cleanup on SIGTERM
// ([sandbox.mjs](sandbox.mjs)), and a file stuck inside its own
// handler would survive a soft signal. Sandboxes still live in the run
// directory, which the runner removes.
const FILE_TIMEOUT_MS = 300_000;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  rmSync(RUN_TMP, { recursive: true, force: true });
}
process.on('exit', cleanup);

// Live children — so they can be taken down on interrupt. The signal
// handler marks the interrupt, kills the live ones, and ends there:
// cleanup is still the same `exit` hook, one for every exit path.
// Pool lanes stop taking from the queue; those in flight come back
// as taken down.
const live = new Map();
// Peak — how many children the runner held at once, at spawn. Not
// Date.now() in the child: that stamp is set when the process got CPU,
// and under machine neighbours the windows drift on a sound pool.
// The `live` counter does not know about neighbours.
let peakLive = 0;
let interrupted = null;
let interruptedOn = [];
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (interrupted) return;
    interrupted = sig;
    interruptedOn = [...live.keys()];
    for (const child of live.values()) {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }
  });
}

// Zero files found is a failure, not a successful report of an empty
// chain: that is what a moved directory or a broken walk looks like.
if (!files.length) {
  console.error(`✖ no *.test.mjs in ${here} — nothing to run`);
  process.exit(1);
}

const failed = [];

// One file: own process, own environment, own output buffer. The buffer
// is a file on disk, not a string in memory: one descriptor for the
// child's stdout and stderr, so the two streams land in the order they
// were written — two pipes cannot reconstruct that order. The same
// removes the EAGAIN loop in the verdict helper ([check.mjs](check.mjs)):
// `writeSync` into a file does not refuse, and a non-blocking pipe
// under six writers overflows.
function runFile(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = path.join(OUT_DIR, `${name}.log`);
    const fd = openSync(log, 'w');
    const child = spawn(process.execPath, [path.join(here, name)], {
      stdio: ['ignore', fd, fd],
      env: testEnv(RUN_TMP),
    });
    live.set(name, child);
    if (live.size > peakLive) peakLive = live.size;
    let done = false;
    let timedOut = false;
    let error = null;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, FILE_TIMEOUT_MS);
    // `error` and `close` both fire when the child did not start at
    // all — the flag keeps the parse on the first of them.
    const finish = (status, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      live.delete(name);
      closeSync(fd);
      let out = '';
      try { out = readFileSync(log, 'utf8'); } catch { /* nothing to write */ }
      let why = null;
      // A file taken down at the file timeout is named separately: it
      // also has a signal, and the shared "killed by signal" branch
      // would send the reader looking for a foreign `kill` instead of
      // a hang.
      if (timedOut) why = `did not finish in ${FILE_TIMEOUT_MS / 1000} s — taken down as hung`;
      else if (error) why = `did not start: ${error.message}`;
      else if (signal) why = `signal ${signal}`;
      else if (status !== 0) why = `code ${status}`;
      resolve({ name, ms: Date.now() - started, out, why });
    };
    child.on('error', (e) => { error = e; finish(null, null); });
    child.on('close', (status, signal) => finish(status, signal));
  });
}

// File output in one piece: title with duration, buffer, failure
// diagnosis. File time is always printed — the run breakdown is built
// from it, and the serial group is decided from it.
function report({ name, ms, out, why }) {
  console.log(`\n▸ ${name} — ${(ms / 1000).toFixed(1)} s`);
  if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  if (why) {
    console.error(`✖ ${name} — failed (${why})`);
    failed.push({ name, why });
  }
}

// Pool: `width` lanes share one queue. A lane takes the next file as
// soon as it has handed back the previous — so a long file holds its
// lane, not the whole run.
async function runGroup(names, width) {
  const queue = [...names];
  const lanes = Array.from({ length: Math.min(width, queue.length) }, async () => {
    while (queue.length && !interrupted) report(await runFile(queue.shift()));
  });
  await Promise.all(lanes);
}

const serial = files.filter((n) => SERIAL.includes(n));
const pooled = files.filter((n) => !SERIAL.includes(n));
console.log(`▸ ${files.length} files: ${pooled.length} in a pool of ${POOL}, `
  + `${serial.length} in the serial group at the end`);

await runGroup(pooled, POOL);
console.log(`▸ pool peak: ${peakLive}`);
if (!interrupted) await runGroup(serial, 1);

// The exit code is SET, not issued via `process.exit`. File output
// goes through `process.stdout.write`, and on macOS a pipe write is
// async: exiting on the spot would cut the tail of the last printed
// buffers — exactly what the buffers were created for. There is no
// further work, the event loop is empty, and the process will exit
// itself after flushing.
if (interrupted) {
  const on = interruptedOn.length ? `on ${interruptedOn.join(', ')}` : 'between files';
  console.error(`\n✖ run interrupted (${interrupted}) ${on}`
    + ' — sandboxes cleaned up, remaining files were not started');
  process.exitCode = 130;
} else {
  // Gate: a bus command must not start a process that outlives the
  // run. We judge by the auto-lift trace — the `PROMPTOBUS_WARDEN_TRACE`
  // file written by the warden lift point ([warden.js](../lib/warden.js)).
  // That trace is enough for two reasons at once: the warden journal
  // in the task store is removed with the sandbox by the test file
  // itself, and that journal is not written only on lift — an ordinary
  // watch round, which the suite calls a dozen and a half times, also
  // puts a line there.
  //
  // The gate looks at lift, not at a live pid: the process is detached
  // by construction — it outlives both the file and the run — and the
  // system reuses process numbers, so a "is it alive now" check would
  // go red on a foreign process with the same number.
  //
  // The gate has one boundary, named in [warden.js](../lib/warden.js):
  // a warden started by hand leaves no trace. The rule forbids
  // auto-lift, and the suite does not start one by hand.
  let raised = [];
  try {
    raised = readFileSync(path.join(RUN_TMP, RAISED_LOG), 'utf8').split('\n').filter(Boolean);
  } catch {
    // no trace — nobody was raised
  }

  const passed = files.length - failed.length;
  if (failed.length) {
    console.error(`\n✖ ${failed.length} of ${files.length} files failed, ${passed} passed:`);
    for (const f of failed) console.error(`  ✖ ${f.name} — ${f.why}`);
  }
  if (raised.length) {
    console.error(`\n✖ wardens were raised under this run (${raised.length}) — these processes outlive the run:`);
    for (const line of raised) console.error(`  ✖ ${line}`);
    console.error('  the PROMPTOBUS_WARDEN=off switch is in the shared hygiene.mjs list — the bus command did not read it');
  }
  if (failed.length || raised.length) process.exitCode = 1;
  else console.log(`\n${passed}/${files.length} test files passed`);
}

// Regression on the chain runner (run.mjs). Run: npm test
//
// The subject is runner decisions, not test contents:
//
//   • file timeout — one hung file used to hang `npm test` forever,
//     because the runner waited on the child with no deadline;
//   • warden auto-lift gate — a bus command must not start a process
//     that outlives the run, and a trace of such a lift must paint
//     the run red;
//   • suite-file home — diverted into the run directory, and per file;
//   • pool, serial group, and per-file output buffering.
//
// This cannot be checked on the real runner — it runs the whole suite
// — so a copy in a sandbox is taken, with stub test files next to it.
// The copy is the same code, not a retelling: under the file-timeout
// probe one number is swapped, under the pool probe nothing is swapped.
import {
  closeSync, copyFileSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeSandbox } from './sandbox.mjs';
import { check } from './check.mjs';

const SB = makeSandbox('promptobus-runner-');
const here = path.dirname(fileURLToPath(import.meta.url));

const src = readFileSync(path.join(here, 'run.mjs'), 'utf8');
const CAP_MS = 2000;
const copy = src.replace(/const FILE_TIMEOUT_MS = [\d_]+;/, `const FILE_TIMEOUT_MS = ${CAP_MS};`);
// Without this check a swap that missed the constant would go green
// on the real file timeout (`FILE_TIMEOUT_MS` in run.mjs) — i.e. a
// check that checks nothing.
check('file timeout in the copy is swapped — we exercise the shortened one, not the real one',
  copy !== src && copy.includes(`const FILE_TIMEOUT_MS = ${CAP_MS};`));

// The runner copy is planted in the sandbox with the hygiene list and
// the `$TMPDIR` sweep: the runner imports both by a relative path, and
// without the neighbour files the copy fails on import — red would
// point at the probe, not at its subject. One hand puts them so
// nothing can be forgotten.
//
// The sweep has its own transitive import — the shared thresholds
// module from a neighbouring directory that is not in the sandbox at
// all. There is no need to drag the whole tree after it: in the copy
// one import line is rewritten to an absolute path to the real module.
// A swap that missed would give a copy that fails on import, so its
// own check watches it — like the file-timeout swap above.
const sweepSrc = readFileSync(path.join(here, 'tmpdir-sweep.mjs'), 'utf8');
const RUNS_MOD = "'../scripts/canary-runs.mjs'";
const sweepCopy = sweepSrc.replace(RUNS_MOD,
  JSON.stringify(pathToFileURL(path.join(here, '..', 'scripts', 'canary-runs.mjs')).href));
check(': thresholds import in the sweep copy is rewritten to the real module',
  sweepCopy !== sweepSrc && !sweepCopy.includes(RUNS_MOD));

function plant(dir, source) {
  writeFileSync(path.join(dir, 'run.mjs'), source);
  copyFileSync(path.join(here, 'hygiene.mjs'), path.join(dir, 'hygiene.mjs'));
  writeFileSync(path.join(dir, 'tmpdir-sweep.mjs'), sweepCopy);
}
plant(SB, copy);

// Hangs in exactly the way the file timeout was created for: an
// unresolved promise with a live event loop. One promise without a
// timer does not hang the file — Node notices an empty loop and exits
// with code 13 (that branch is watched by check.test.mjs); what hangs
// it is what holds the loop: an open watcher, a stdin being read, an
// unanswered subprocess. The timer here stands in for those.
writeFileSync(path.join(SB, 'a-visyachiy.test.mjs'),
  'setInterval(() => {}, 1000);\nawait new Promise(() => {});\n');
writeFileSync(path.join(SB, 'b-zhivoy.test.mjs'), "console.log('live file reached the end');\n");

// The probe has its own deadline: a broken file timeout means eternal
// waiting, and without it red would look like a hung suite — i.e. the
// very problem we are fixing.
//
// Not `spawnSync` with its `timeout` and not pipes: a runner taken
// down at the deadline leaves the hung file alive (it was started as
// its own process), and the pipe stays open IN IT — and `spawnSync`
// keeps hanging on a read of an already-dead runner. Mutation-probe
// measure: a sixty-second deadline did not fire in three minutes.
// So output goes to a file, the copy has its own process group
// (`detached`), and at the deadline the whole group is taken down
// at once.
async function runCopy(dir, env = {}) {
  const log = path.join(dir, 'run.log');
  const fd = openSync(log, 'w');
  const child = spawn(process.execPath, [path.join(dir, 'run.mjs')],
    { stdio: ['ignore', fd, fd], detached: true, env: { ...process.env, ...env } });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already dead */ }
      resolve(null);
    }, 60_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  closeSync(fd);
  return { status: code, out: readFileSync(log, 'utf8') };
}

const { status, out: all } = await runCopy(SB);

check('hung file is taken down at the file timeout, not waited on forever',
  status !== null, `runner did not exit in 60 s · ${all.slice(-300)}`);
check('the taken-down file is named and named hung, not "did not start"',
  /a-visyachiy\.test\.mjs — failed \(did not finish in 2 s — taken down as hung\)/.test(all)
  && !/did not start/.test(all), all.slice(-500));
check('the run is red — a hang does not pass as success',
  status === 1 && /1 of 2 files failed/.test(all), `status=${status} ${all.slice(-300)}`);
// The chain does not stop on the taken-down file: the rest must still
// run, otherwise the file timeout would hide the picture the same way
// as stopping on the first failure.
check('the next file of the chain is still run',
  /live file reached the end/.test(all), all.slice(-300));
// Negative control of the auto-lift gate: nobody left a trace — the
// gate must stay silent, otherwise red below would only prove that it
// always goes red.
check(': without an auto-lift trace the gate stays silent',
  !/wardens were raised/.test(all), all.slice(-300));

// --- warden auto-lift gate -----------------------------------
//
// A real lift is not needed here and is harmful: it would start a
// detached process that outlives the run — exactly what the rule
// forbids. The subject is the runner decision, not bus behaviour, so
// a stub file writes the trace itself, the same way the lift point
// does: it appends a line to the file from `PROMPTOBUS_WARDEN_TRACE`.
// The copy of the runner sets the variable, and it points into the
// COPY run directory — this probe's trace does not enter the real run.
const SB2 = makeSandbox('promptobus-runner-raised-');
plant(SB2, copy);
writeFileSync(path.join(SB2, 'a-podnyal.test.mjs'),
  "import { appendFileSync } from 'node:fs';\n"
  + "appendFileSync(process.env.PROMPTOBUS_WARDEN_TRACE, 'warden auto-lift · task probe · pid 4242\\n');\n"
  + "console.log('file with a trace reached the end');\n");

// Suite-file home is diverted into the run directory. We ask the stub
// file for it, not ourselves: this file's home was swapped by the same
// runner, and a check against itself would pass without the swap. The
// file goes green and does not touch the failed counter — neighbouring
// trace checks do not depend on it.
//
// The same file also asks the rest of the hygiene list: the warden
// switch and this session's contact point. Asking them without setup
// is pointless — on a machine without a live session the variables
// are already absent, and the check would go green on nothing. So the
// runner copy is started with them set on purpose: the runner must
// cover them with its list, not inherit them.
writeFileSync(path.join(SB2, 'b-dom.test.mjs'),
  "import os from 'node:os';\n"
  + "console.log(`HOME: ${os.homedir()} :: ${process.env.USERPROFILE ?? ''} :: ${process.env.CLAUDE_CONFIG_DIR ?? '(dropped)'}`);\n"
  + "console.log(`HYGIENE: ${process.env.PROMPTOBUS_WARDEN} :: "
  + "${process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? '(dropped)'} :: "
  + "${process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? '(dropped)'} :: "
  + "${process.env.CONTEXT_STORE_STOP_GATE ?? '(dropped)'} :: "
  + "${process.env.PROMPTOBUS_E2E_ROOT ?? '(dropped)'} :: "
  + "${process.env.PROMPTOBUS_ROLE ?? '(dropped)'} :: "
  + "${process.env.PROMPTOBUS_TASK ?? '(dropped)'} :: "
  + "${process.env.PROMPTOBUS_HOME ?? '(dropped)'}`);\n");

const raised = await runCopy(SB2, {
  PROMPTOBUS_WARDEN: 'on',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/poddelnyy-probe.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok-probe',
  CONTEXT_STORE_STOP_GATE: '0',
  PROMPTOBUS_E2E_ROOT: '/net/takogo/kataloga',
  // Participant identity: under a mechanism worker and reviewer it
  // stands in the session environment before `npm test`, so the runner
  // copy is started with it set on purpose — on a machine without such
  // a session the variables are already absent, and the check would
  // go green on nothing. Home points at a directory that does not
  // exist: if the runner did not drop it, the run would look for the
  // task journal there, and on a real machine — in the live bus
  // journal.
  PROMPTOBUS_ROLE: 'worker:proba',
  PROMPTOBUS_TASK: 'proba-t20260902-000000',
  PROMPTOBUS_HOME: '/net/takogo/doma/.promptobus',
  // Claude Code config directory: the harness puts it on a worker
  // session, and from there stall parse would read the state of a
  // person's live sessions. Points at a directory that does not exist.
  CLAUDE_CONFIG_DIR: '/net/takogo/konfiga/.claude',
});
check(': an auto-lift trace paints the run red, even though the files passed',
  raised.status === 1 && /file with a trace reached the end/.test(raised.out)
  && !/files failed/.test(raised.out), `status=${raised.status} ${raised.out.slice(-400)}`);
check(': the gate names the count, the trace line itself, and the switch',
  /wardens were raised under this run \(1\)/.test(raised.out)
  && /pid 4242/.test(raised.out)
  && /PROMPTOBUS_WARDEN=off/.test(raised.out), raised.out.slice(-400));

// --- the user home does not reach a suite file ----------------------
//
// A green run rewrote a person's memory hooks and
// `~/.claude/settings.json`: a suite file spawns the real CLI, and
// `sync` at the tail installs hooks into home. The real home is
// visible from here as `os.userInfo().homedir` — that record comes
// from the system, not the environment, so the swap does not move it
// and the check stays honest.
const [homeSeen = '', profileSeen = '', cfgSeen = ''] = (raised.out.match(/HOME: (.+)/)?.[1] ?? '').split(' :: ');
check(': a suite file sees home inside the run directory, not the real one',
  /promptobus-test-run-[^\n]*[\\/]home-[^\n\\/]+$/.test(homeSeen)
  && homeSeen !== os.userInfo().homedir, `suite file home: ${homeSeen || '(unnamed)'}`);
// Windows looks at USERPROFILE, POSIX at HOME, and swapping only one
// of the two would leave a hole on the other platform entirely.
check(': USERPROFILE is diverted to the same place as HOME',
  profileSeen === homeSeen && profileSeen !== '', `USERPROFILE: ${profileSeen || '(empty)'}`);
// Claude Code config directory — the same place as home: participant
// stall parse reads `jobs/<id>/state.json` from it, and a leaked
// worker-session variable would send it into the state of a person's
// live sessions. The runner copy received the variable with a path
// that does not exist.
check(': CLAUDE_CONFIG_DIR is diverted into the run directory — stall parse does not read a person home',
  homeSeen !== '' && cfgSeen === path.join(homeSeen, '.claude'),
  `CLAUDE_CONFIG_DIR=${cfgSeen || '(unnamed)'} · home ${homeSeen || '(unnamed)'}`);

// --- the hygiene list is applied in full ------------------
//
// Home is only one item on the list, and a check of one item would
// stay silent about a dropped neighbour. The runner copy received the
// switch in the on position, a stub wake point, and the memory-hook
// lever — in the position the bus sets (`=0`): it must cover all
// three.
const [
  wdnSeen = '', sockSeen = '', tokenSeen = '', csSeen = '', e2eSeen = '',
  roleSeen = '', taskSeen = '', busHomeSeen = '',
] = (raised.out.match(/HYGIENE: (.+)/)?.[1] ?? '').split(' :: ');
check(': the runner kills warden auto-lift and drops the session contact point',
  wdnSeen === 'off' && sockSeen === '(dropped)' && tokenSeen === '(dropped)',
  `PROMPTOBUS_WARDEN=${wdnSeen || '(unnamed)'} · socket=${sockSeen} · token=${tokenSeen}`);
check(': the runner drops the memory-hook lever',
  csSeen === '(dropped)', `CONTEXT_STORE_STOP_GATE=${csSeen || '(unnamed)'}`);
// The root of the mechanism under test is set by the release canary,
// and only it. Left in the environment after a hand run, it silently
// sends the whole suite onto a foreign tree: the script resolves the
// binary, the store, and the driver from it.
check(': the runner drops the root of the mechanism under test',
  e2eSeen === '(dropped)', `PROMPTOBUS_E2E_ROOT=${e2eSeen || '(unnamed)'}`);
// Participant identity — the same class as the memory lever: spawn
// itself puts it into the session environment, and under a mechanism
// worker it stands there before `npm test`. The leak costs more than
// the neighbours: `PROMPTOBUS_HOME` beats a home search from cwd, and
// a suite file that does not declare its own home would go work in
// the LIVE bus journal of the workspace. All three are checked: a
// dropped pair without the third would leave a hole exactly where it
// costs the most.
check(': the runner drops participant identity — role, task, and bus home',
  roleSeen === '(dropped)' && taskSeen === '(dropped)' && busHomeSeen === '(dropped)',
  `PROMPTOBUS_ROLE=${roleSeen || '(unnamed)'} · PROMPTOBUS_TASK=${taskSeen || '(unnamed)'}`
  + ` · PROMPTOBUS_HOME=${busHomeSeen || '(unnamed)'}`);

// --- pool, serial group, and output buffering ------------------------
//
// Three decisions at once, and all three are visible only from
// outside: pool files go concurrently, the serial group goes after
// the pool and one by one, each file's output is printed as one
// piece. The copy here is unpatched — the subject is exactly the
// real `POOL` and `SERIAL`, and swapped they would test the swap.
//
// Serial-group membership is read from the source, not repeated here
// as a list: a copy of the list would drift from the runner the same
// way hygiene drifted.
const SERIAL_NAMES = (() => {
  try { return JSON.parse((src.match(/const SERIAL = (\[[^\]]*\]);/)?.[1] ?? '').replace(/'/g, '"')); }
  catch { return null; }
})();
check(': the serial group is named in the runner as a list of names and it was read',
  Array.isArray(SERIAL_NAMES) && SERIAL_NAMES.length > 0, JSON.stringify(SERIAL_NAMES));
// The group is a list of file names, and a renamed file would slip
// into the pool in silence — under the load it was taken out of.
// Red here is cheaper than a flaky test in a month.
const strayNames = (SERIAL_NAMES ?? []).filter((n) => !readdirSync(here).includes(n));
check(': every serial-group file is in the suite directory',
  strayNames.length === 0, `not in the directory: ${strayNames.join(', ')}`);

const SB3 = makeSandbox('promptobus-runner-pool-');
plant(SB3, src);
const TIMES = path.join(SB3, 'times');
mkdirSync(TIMES);
// A stub file marks its real bounds on disk and prints three lines
// with pauses. The pauses are for the buffering verdict: without them
// neighbour lines would not have time to interleave into foreign
// output — contiguous output would only prove there was nothing to
// print. Pool concurrency is not judged by these stamps: Date.now()
// in the child measures when it got CPU.
const probe = (name) => writeFileSync(path.join(SB3, name),
  "import { writeFileSync } from 'node:fs';\n"
  + 'const start = Date.now();\n'
  + 'const pause = () => new Promise((r) => { setTimeout(r, 120); });\n'
  + `for (let i = 1; i <= 3; i += 1) { console.log('${name} ' + i); await pause(); }\n`
  + `writeFileSync(${JSON.stringify(path.join(TIMES, `${name}.json`))}, `
  + 'JSON.stringify({ start, end: Date.now() }));\n');

// Pool width is computed by the same formula as in the runner. There
// are exactly as many stub files as lanes, but no more than three:
// the probe requires that ALL of them be live at once, and four files
// on two lanes would paint a sound runner red. The cap of three is
// the cost of the probe: more files do not prove the same parallelism.
const POOL_HERE = Math.max(1, Math.min(6, os.cpus().length - 2));
const POOLED = ['p-1.test.mjs', 'p-2.test.mjs', 'p-3.test.mjs'].slice(0, Math.min(3, POOL_HERE));
for (const name of [...POOLED, ...(SERIAL_NAMES ?? [])]) probe(name);
const pooled = await runCopy(SB3);
const peakLive = Number(pooled.out.match(/pool peak: (\d+)/)?.[1]);
check(': the pool probe ran in full — there is something to judge',
  pooled.status === 0 && Number.isInteger(peakLive),
  `status=${pooled.status} peak=${peakLive} ${pooled.out.slice(-400)}`);

// The mark is read softly: the file may not be there at all — the
// runner did not start the stub file, or it failed before the write.
// An exception from here would take the whole test file, and red
// would arrive as an abort without a verdict, i.e. without the name
// of what broke.
const at = (name) => {
  try { return JSON.parse(readFileSync(path.join(TIMES, `${name}.json`), 'utf8')); }
  catch { return null; }
};
const poolTimes = POOLED.map(at);
const serialTimes = (SERIAL_NAMES ?? []).map(at);
const noMark = [...POOLED, ...(SERIAL_NAMES ?? [])].filter((name) => at(name) === null);
check(': every stub file marked its bounds — there is something to judge by',
  noMark.length === 0, `no mark: ${noMark.join(', ') || '—'}`);

// A one-lane machine the probe names outright, rather than staying
// silent about having checked nothing. It is named, not failed: on a
// machine that cannot give a second lane there is nothing to measure,
// and a red verdict there says the runner is broken when it is the
// hardware that is small. A machine wide enough to be measured and a
// pool that still collapsed to one lane is the real defect, and that
// one does fail.
const WIDE_ENOUGH = os.cpus().length >= 4;
check(WIDE_ENOUGH
  ? ': this machine pool is wider than one lane — there is parallelism to measure'
  : ': parallelism was NOT measured — this machine is too small to give a second lane',
  WIDE_ENOUGH ? POOL_HERE >= 2 : true,
  `${os.cpus().length} cores — pool is ${POOL_HERE} lanes`);
const starts = (list) => list.filter(Boolean).map((t) => t.start);
const ends = (list) => list.filter(Boolean).map((t) => t.end);
// Peak — how many children the runner held in `live` right after
// spawn, not an intersection of wall-clock windows. Windows go red
// when the scheduler spread the children, while the lanes are all
// open: the counter does not know about machine neighbours.
check(': pool files go concurrently, not one by one',
  peakLive === POOLED.length,
  `peak ${peakLive} at ${POOLED.length} files on ${POOL_HERE} lanes: ${JSON.stringify(poolTimes)}`);

const lastPool = Math.max(...ends(poolTimes), 0);
// An empty mark list is printed as a word, not zero: `Math.min()`
// with no arguments returns infinity, and with an added zero —
// zero, and the red detail would lie about the start time.
const bound = (pick, list) => (list.length ? pick(...list) : '(no marks)');
check(': the serial group starts after the last pool file',
  poolTimes.every(Boolean) && serialTimes.every(Boolean)
  && Math.min(...starts(serialTimes)) >= lastPool,
  `pool ended ${bound(Math.max, ends(poolTimes))}, `
  + `group started ${bound(Math.min, starts(serialTimes))}`);
check(': inside the serial group files do not overlap — they have no neighbours',
  serialTimes.every(Boolean) && [...serialTimes].sort((a, b) => a.start - b.start)
    .every((t, i, all) => i === 0 || t.start >= all[i - 1].end),
  JSON.stringify(serialTimes));

// Buffering: a file's lines must sit contiguously. We count blocks,
// not file order — output split by a neighbour gives a second block
// with the same name.
const marks = pooled.out.split('\n')
  .map((l) => l.match(/^(\S+\.test\.mjs) [123]$/)?.[1]).filter(Boolean);
const blocks = marks.filter((name, i) => i === 0 || marks[i - 1] !== name);
check(': file lines are printed contiguously — output is buffered per file',
  marks.length === 3 * (POOLED.length + (SERIAL_NAMES ?? []).length)
  && blocks.length === new Set(blocks).size, `${marks.length} lines · ${blocks.join(',')}`);

// --- the exit code does not truncate the buffer --------------------------------------
//
// File output goes through `process.stdout.write`, and on macOS a
// pipe write is async: `process.exit()` at the runner tail takes the
// process before the pipe drains, and the tail of the last printed
// buffers vanishes — exactly what the buffers were created for.
// Probe measure: a stub file prints four thousand lines and goes
// red; through `process.exit(1)` 1586 of 4000 lines reach the
// reader, through `process.exitCode` — all four thousand, three
// times out of three.
//
// A pipe is safe here, unlike in `runCopy`: there are no hung files
// in this sandbox, and nobody is left to hold it open after the
// runner dies.
//
// The probe is platform-specific by subject. Node writes to a pipe
// asynchronously on macOS and Windows and synchronously on Linux —
// there is no truncate there at all, and the probe works as a
// negative control: it is green on sound code and on `process.exit`.
// Only the machine where the problem lives makes it red, and that
// is lawful — the gate is held by developers on macOS.
const SB4 = makeSandbox('promptobus-runner-pipe-');
plant(SB4, src);
const LINES = 4000;
writeFileSync(path.join(SB4, 'a-mnogo.test.mjs'),
  `for (let i = 0; i < ${LINES}; i += 1) console.log('output line number ' + i);\n`
  + 'process.exit(1);\n');
// Own deadline, for the same reason as `runCopy`: the probe starts
// the runner, and a hung runner without a file timeout hangs the
// whole suite file — and red would look like a hang, i.e. the
// problem that was being fixed.
const piped = spawnSync(process.execPath, [path.join(SB4, 'run.mjs')],
  { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
const arrived = (piped.stdout ?? '').split('\n')
  .filter((l) => l.startsWith('output line number ')).length;
check(': a red run finishes the buffer into the pipe, and does not cut it off on exit',
  arrived === LINES && piped.status === 1,
  `${arrived} of ${LINES} lines arrived, code ${piped.status}`);

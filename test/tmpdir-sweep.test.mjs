// Leftovers of mechanism runs in `$TMPDIR`. Run: npm test
//
// There are two subjects, and both are directories piling up in a
// shared `$TMPDIR`. Release gates
// (`release-gates.mjs`) leave a run
// directory with a report; the suite leaves a sandbox of a cut-off
// run — Ctrl-C, taken down at the file timeout, a process crash
// never reach the exit hook. Both are healed by one
// `sweepPreviousRuns` sweep ([canary-runs.mjs](../scripts/canary-runs.mjs))
// with its own prefix and its own `keep`: gates keep the three
// latest directories (the report is read after the run), the suite
// keeps nothing except the young — there is nothing to read in a
// sandbox.
//
// Checked on a sandbox, not on the real `$TMPDIR`: the sweep removes
// directories, and a foreign run on the same machine the suite has
// no right to touch. Times are planted with `utimesSync` and counted
// FROM `Date.now()` — the sweep has an age cut-off, and calendar
// literals would make verdicts depend on the day of the run.
//
// The file does not start or import `release-gates.mjs` itself: that
// one runs whole already on import — it wants a clean tree, packs a
// tarball and installs it. So the sweep call in it is checked against
// the source: without that check a removed call would paint nothing.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { SOCK_PREFIXES } from './sock-prefixes.mjs';
import { SUITE_PREFIXES, sweepTestSandboxes } from './tmpdir-sweep.mjs';
import { KEEP_RUNS, sweepPreviousRuns, sweptLine } from '../scripts/canary-runs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();

// A non-empty directory with a file inside: the sweep removes it
// whole, and a non-empty directory is what it actually meets.
function plant(dir, name, ageMs) {
  const box = path.join(dir, name);
  mkdirSync(box, { recursive: true });
  writeFileSync(path.join(box, 'run.md'), `# ${name}\n`);
  const at = new Date(NOW - ageMs);
  utimesSync(box, at, at);
  return box;
}
const listOf = (dir) => readdirSync(dir).sort();

// ── Release gates: own prefix, canary thresholds ──────────────────────────────────────
//
// All planted directories are older than the age cut-off, so only
// "the three newest" judges them. Expectations are a list of names,
// NOT derived from `KEEP_RUNS`: a check that computes the expected
// from the same number it checks passes at any value of it.
const GATES_PREFIX = 'promptobus-release-gates-';
const TMP = makeSandbox('promptobus-sweep-tmp-');
for (const [name, age] of [['keep-2h', 2 * HOUR], ['keep-3h', 3 * HOUR], ['keep-4h', 4 * HOUR],
  ['gone-5h', 5 * HOUR], ['gone-3d', 3 * DAY]]) plant(TMP, `${GATES_PREFIX}${name}`, age);
// Current gates-run directory: by mtime it is the newest, but the
// sweep does not count it at all.
const CURRENT = plant(TMP, `${GATES_PREFIX}current`, 0);
// A canary directory in the same `$TMPDIR`: a different prefix — not
// the gates sweep's business.
const CANARY = plant(TMP, 'promptobus-canary-abc123', 3 * DAY);

const sweptGates = sweepPreviousRuns(TMP, { prefix: GATES_PREFIX, current: CURRENT });

check(`: the gates sweep keeps ${KEEP_RUNS} newest run directories and its own current`,
  listOf(TMP).join(',') === ['promptobus-canary-abc123', `${GATES_PREFIX}current`,
    `${GATES_PREFIX}keep-2h`, `${GATES_PREFIX}keep-3h`, `${GATES_PREFIX}keep-4h`].join(','),
  `left: ${listOf(TMP).join(', ')}`);

check(': the oldest gates directories were swept, and the swept are returned as a list',
  sweptGates.join(',') === [`${GATES_PREFIX}gone-5h`, `${GATES_PREFIX}gone-3d`].join(','),
  `swept: ${sweptGates.join(', ') || 'none'}`);

check(': the current gates-run directory the sweep does not touch',
  existsSync(CURRENT) && !sweptGates.includes(path.basename(CURRENT)), CURRENT);

check(': a canary directory the gates sweep does not touch',
  existsSync(CANARY) && !sweptGates.includes(path.basename(CANARY)), CANARY);

// The sweep call in the script itself — against the source: it cannot
// be imported, and without this check a removed call would paint no
// check. Here it is also checked that the prefix of `mkdtempSync` and
// of the sweep is ONE: drifted, they would give the script a run that
// sweeps foreign things or does not sweep at all.
const gatesFile = path.join(here, '..', 'scripts', 'release-gates.mjs');
const gatesPresent = existsSync(gatesFile);
const gatesSrc = gatesPresent ? readFileSync(gatesFile, 'utf8') : '';
if (gatesPresent) {
  const literals = gatesSrc.split(`'${GATES_PREFIX}'`).length - 1;
  check(': release-gates sweeps previous directories, and its prefix has one home',
    /const RUN_PREFIX = 'promptobus-release-gates-';/.test(gatesSrc)
    && /mkdtempSync\(path\.join\(os\.tmpdir\(\), RUN_PREFIX\)\)/.test(gatesSrc)
    && /sweepPreviousRuns\(os\.tmpdir\(\), \{ prefix: RUN_PREFIX[^)]*\)/.test(gatesSrc)
    && literals === 1,
    `prefix literals: ${literals} · sweep: ${/sweepPreviousRuns/.test(gatesSrc)}`);
} else {
  check(': release-gates.mjs is not in this repository — suite sweep is owned by run.mjs',
    /sweepTestSandboxes\(os\.tmpdir\(\)/.test(readFileSync(path.join(here, 'run.mjs'), 'utf8')));
}

// The summary line is one for every caller, and its empty case must
// name BOTH thresholds: gates can have nothing to sweep by count and
// by age, and "nothing beyond the three kept" only talks about the
// count — i.e. it lies in exactly half the cases. Thresholds in the
// verdict are given as numbers, not derived from constants: otherwise
// it would pass at any value of them.
check(': an empty sweep summary names both thresholds, and at keep = 0 — only age',
  /nothing to sweep: everything is within 3 kept or younger than 60 minutes/.test(sweptLine('к', [], { keep: 3 }))
  && /nothing to sweep: everything is younger than 60 minutes/.test(sweptLine('п', [], { keep: 0 }))
  && !/kept/.test(sweptLine('п', [], { keep: 0 })),
  `${sweptLine('к', [], { keep: 3 })} · ${sweptLine('п', [], { keep: 0 })}`);

// ── Suite sandboxes: everything of ours older than the cut-off is swept ────────────────────────────────
//
// `keep = 0` lifts the count protection: a fresh sandbox is held ONLY
// by the age cut-off. So the scene has young directories, old ones,
// and foreign ones: without the young, sweeping everything in a row
// would be green; without the old — a sweep that removed nothing
// at all.
const BOXES = makeSandbox('promptobus-sweep-tmp-');
const OLD = ['promptobus-sync-old', 'promptobus-promptobus spawn-old', 'promptobus-bushook-old',
  'promptobus-cursor-wake-old', 'promptobus-test-run-old',
  // Nested-package suite sandbox: a hand `npm test --prefix` pours
  // it into the same system `$TMPDIR`, and it is swept on a par with
  // our own.
  'promptobus-store-old'];
for (const name of OLD) plant(BOXES, name, 3 * DAY);
// Young: a neighbouring file's own sandbox and the run directory of
// a parallel `npm test`.
const FRESH = ['promptobus-sync-fresh', 'promptobus-test-run-fresh'];
for (const name of FRESH) plant(BOXES, name, 5 * MIN);
// Foreign: live runs, release gates, canary, and production CLI code.
// All old — i.e. they would have been swept if it were about age,
// not prefix.
const FOREIGN = ['promptobus-canary-old', 'promptobus-release-gates-old', 'promptobus-live-e2e-old',
  'promptobus-live-cursor-logs-42', 'agents-review-old'];
for (const name of FOREIGN) plant(BOXES, name, 3 * DAY);
// Directory of THIS run: old by mtime, but the runner itself created
// it — the sweep does not count it.
const RUN_TMP = plant(BOXES, 'promptobus-test-run-current', 3 * DAY);

const swept = sweepTestSandboxes(BOXES, { current: RUN_TMP });

check(': suite sandboxes older than the cut-off were swept — all own prefixes, including a space in the name',
  swept.join(',') === [...OLD].sort().join(','),
  `swept: ${swept.join(', ') || 'none'}`);

check(': a fresh sandbox is not swept — the age cut-off holds it, not the count',
  FRESH.every((n) => existsSync(path.join(BOXES, n))),
  `left: ${listOf(BOXES).join(', ')}`);

check(': directories of foreign prefixes the suite sweep does not touch',
  FOREIGN.every((n) => existsSync(path.join(BOXES, n))),
  `swept: ${swept.join(', ') || 'none'}`);

check(': the current run directory is not swept, even though it is old',
  existsSync(RUN_TMP) && !swept.includes(path.basename(RUN_TMP)), RUN_TMP);

// A second pass over the same directory: there is nothing more to
// sweep, and the sweep says so with an empty list, not by sweeping
// the remainder.
check(': a second pass has nothing to sweep — the remainder is not touched',
  sweepTestSandboxes(BOXES, { current: RUN_TMP }).length === 0
  && listOf(BOXES).length === FRESH.length + FOREIGN.length + 1,
  listOf(BOXES).join(', '));

// The sweep call in the runner — against the source, the same move
// and for the same reason as for gates above: [run.mjs](run.mjs)
// cannot be imported, it runs the whole suite. Without the check a
// removed call would paint nothing — the sweep itself is checked by
// sandbox scenes, and it is called from one place, and that place is
// the only coverage here.
const runSrc = readFileSync(path.join(here, 'run.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
check(': the runner calls the sweep at start and gives it its run directory',
  /sweepTestSandboxes\(os\.tmpdir\(\), \{ current: RUN_TMP[^)]*\)/.test(runSrc),
  `import: ${/from '.\/tmpdir-sweep.mjs'/.test(runSrc)} · call: ${/sweepTestSandboxes\(/.test(runSrc)}`);

// ── A sweep refusal does not fail the suite ───────────────────────────────────────────────────────
//
// A directory is in use or there are no permissions for it — sweep
// here is hygiene, not a gate, and the run must not go red because
// of it. The scene is mixed: next to the unyielding directory sits
// an ordinary one, and the verdict requires that the swept one be
// NAMED. A guard around the whole walk would erase that name — the
// runner would print "swept: 0" on a run that did sweep.
//
// Unyieldingness is planted as permissions of an INNER directory,
// not the parent: `rmSync` goes inward and trips on a file inside a
// closed directory, and a neighbouring directory of the same
// `$TMPDIR` is swept as if nothing happened.
//
// Both scene directories are of ONE prefix, and the one to be swept
// goes first (it is younger, and the walk goes from fresh to old).
// Different prefixes go into different sweep calls, and a guard
// around the whole call would pass such a scene unnoticed — and
// that is exactly what is caught here.
//
// The guard is double. On Windows this form of permissions does not
// exist at all. Under root permission bits mean nothing — `rmSync`
// will remove even a closed one — and the "sweep did not throw"
// verdict would go green on nothing; the official node image in CI
// runs as root.
if (process.platform !== 'win32' && process.getuid?.() !== 0) {
  const LOCKED = makeSandbox('promptobus-sweep-tmp-');
  const stuck = plant(LOCKED, 'promptobus-sync-locked', 3 * DAY);
  const lock = path.join(stuck, 'lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, 'held'), 'занято\n');
  chmodSync(lock, 0o555);
  // Directory time is set AFTER contents were put into it: directory
  // mtime grows on every write inside, and a planted age without
  // that would reset to "just now" — the age cut-off would then
  // protect the directory itself, and the scene would not be
  // checking a sweep refusal.
  const aged = new Date(NOW - 3 * DAY);
  utimesSync(stuck, aged, aged);
  const doomed = plant(LOCKED, 'promptobus-sync-doomed', 2 * DAY);

  let threw = null;
  let sweptLocked = [];
  const refused = [];
  try { sweptLocked = sweepTestSandboxes(LOCKED, { refused }); } catch (e) { threw = e; }
  chmodSync(lock, 0o755);

  check(': a sweep refusal the sweep swallows — the suite does not fail from it',
    threw === null, `threw: ${threw?.message ?? '—'}`);

  check(': a refusal does not take the name of a swept neighbour — the list names it',
    sweptLocked.join(',') === 'promptobus-sync-doomed' && !existsSync(doomed),
    `swept: ${sweptLocked.join(', ') || 'none'}`);

  check(': the unyielding directory is named in a separate list and stayed in place',
    refused.join(',') === 'promptobus-sync-locked' && existsSync(stuck),
    `refused: ${refused.join(', ') || 'none'} · ${existsSync(stuck)}`);
}

// ── Prefix-list sentinel ──────────────────────────────────────────────────────────
//
// The list is hand-built by grepping the directory, and a new prefix
// would leak past the sweep in silence. The check repeats the same
// grep: every `makeSandbox('…')` and
// `mkdtempSync(path.join(os.tmpdir(), '…'))` literal in `test/` must
// be covered by the list. The same way
// [runner.test.mjs](runner.test.mjs) checks `SERIAL` against the
// directory.
//
// Non-literal arguments (the `prefix` variable in
// [sandbox.mjs](sandbox.mjs) itself) grep does not take by
// construction — there is nothing to search for. `makeSockDir` lives
// under `/tmp` past `os.tmpdir()` and is not the subject of THIS
// sweep: its prefixes are watched by the section below.
const declared = [];
const SCAN = [here];
for (const dir of SCAN) {
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    // Comment lines are stripped: prose quotes the same calls in
    // this file and in [tmpdir-sweep.mjs](tmpdir-sweep.mjs) itself,
    // and a quoted sandbox does not create one.
    const src = readFileSync(path.join(dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    // Any of the three quotes, closed by itself (back-reference): a
    // literal moved into backticks would otherwise slip past the
    // sentinel in silence — and they are moved in this repository
    // in batches, whole waves.
    for (const m of src.matchAll(/makeSandbox\(\s*(['"`])([^'"`]+)\1/g)) declared.push([file, m[2]]);
    for (const m of src.matchAll(/mkdtempSync\(path\.join\(os\.tmpdir\(\),\s*(['"`])([^'"`]+)\1/g)) {
      declared.push([file, m[2]]);
    }
  }
}
const uncovered = declared.filter(([, pre]) => !SUITE_PREFIXES.some((known) => pre.startsWith(known)));

check(': the sweep prefix list covers every suite sandbox',
  declared.length > 0 && uncovered.length === 0,
  `literals found: ${declared.length} · uncovered: `
  + `${uncovered.map(([f, p]) => `${p} (${f})`).join(', ') || '—'}`);

// ── Socket-prefix sentinel of the release gate ────────────────────────────
//
// The "no sockets left after the run" verdict looks at `/tmp` by
// SOCK_PREFIXES. The list is hand-built, and a new prefix would leak
// past the verdict in silence — a live case: `ags-` in
// promptobus-guard.test.mjs was not in the gate literal. The check
// is the same as for SUITE_PREFIXES above: every
// `makeSockPath('…')` / `makeSockDir('…')` literal must be covered
// by the list. A non-literal `prefix` in sandbox.mjs grep does not
// take — the caller creates the directory.
//
// `scripts/` is scanned too: a live run plants a socket through
// `makeSockDir`, not through the suite. release-gates.mjs itself
// cannot be imported — it runs on import — so the call is checked
// against the source, like the run-directory sweep above.
const sockDeclared = [];
const SOCK_SCAN = [here, path.join(here, '..', 'scripts')];
for (const dir of SOCK_SCAN) {
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    const src = readFileSync(path.join(dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/makeSock(?:Path|Dir)\(\s*(['"`])([^'"`]+)\1/g)) {
      sockDeclared.push([file, m[2]]);
    }
  }
}
const sockUncovered = sockDeclared.filter(([, pre]) => !SOCK_PREFIXES.some((known) => pre.startsWith(known)));

check(': the socket-prefix list covers every makeSockPath/makeSockDir',
  sockDeclared.length > 0 && sockUncovered.length === 0,
  `literals found: ${sockDeclared.length} · uncovered: `
  + `${sockUncovered.map(([f, p]) => `${p} (${f})`).join(', ') || '—'}`);

if (gatesPresent) {
  check(': release-gates looks at sockets by SOCK_PREFIXES, not by a literal',
    /from '\.\.\/test\/sock-prefixes\.mjs'/.test(gatesSrc)
    && /younger\('\/tmp',\s*SOCK_PREFIXES\)/.test(gatesSrc),
    `import: ${/sock-prefixes/.test(gatesSrc)} · younger: ${/younger\('\/tmp'/.test(gatesSrc)}`);
}

// Leftovers of mechanism runs in `$TMPDIR`. Run: npm test
//
// There are two subjects, and both are directories piling up in shared
// machine temporary areas. The suite leaves a sandbox of a cut-off run —
// Ctrl-C, taken down at the file timeout, a process crash never reaches
// the exit hook — and its socket helpers leave directories directly under
// `/tmp`. Both are healed by the runner's shared
// `sweepPreviousRuns` sweep ([canary-runs.mjs](../scripts/canary-runs.mjs))
// with one prefix per resource and `keep = 0`: there is nothing to read
// after the suite run, so only the age cutoff and a liveness proof hold a
// neighbouring run.
//
// Checked on a sandbox, not on the real `$TMPDIR`: the sweep removes
// directories, and a foreign run on the same machine the suite has
// no right to touch. Times are planted with `utimesSync` and counted
// FROM `Date.now()` — the sweep has an age cut-off, and calendar
// literals would make verdicts depend on the day of the run.
//
// The runner cannot be imported here: it starts the whole suite. Its two
// sweep calls are checked against source, so removing one cannot make this
// fixture file paint green while the production cleanup disappears.
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { SOCK_PREFIXES } from './sock-prefixes.mjs';
import { SUITE_PREFIXES, sweepTestSandboxes, sweepTestSockets } from './tmpdir-sweep.mjs';
import {
  KEEP_RUNS, RUN_OWNER_FILE, runOwnerIsLive, socketDirIsLive, sweepPreviousRuns, sweptLine,
} from '../scripts/canary-runs.mjs';

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
    /sweepTestSandboxes\(os\.tmpdir\(\),[\s\S]*?current:\s*RUN_TMP/.test(readFileSync(path.join(here, 'run.mjs'), 'utf8'))
    && /sweepTestSockets\(\s*['"]\/tmp['"]/.test(readFileSync(path.join(here, 'run.mjs'), 'utf8')));
}

// The summary line is one for every caller, and its empty case must
// name BOTH thresholds: gates can have nothing to sweep by count and
// by age, and "nothing beyond the three kept" only talks about the
// count — i.e. it lies in exactly half the cases. Thresholds in the
// verdict are given as numbers, not derived from constants: otherwise
// it would pass at any value of them.
check(': an empty sweep summary names both thresholds, and at keep = 0 — only age',
  /nothing to sweep: everything is within 3 kept or younger than 60 minutes/.test(sweptLine('a', [], { keep: 3 }))
  && /nothing to sweep: everything is younger than 60 minutes/.test(sweptLine('b', [], { keep: 0 }))
  && !/kept/.test(sweptLine('b', [], { keep: 0 })),
  `${sweptLine('a', [], { keep: 3 })} · ${sweptLine('b', [], { keep: 0 })}`);

// ── Suite sandboxes: everything of ours older than the cut-off is swept ────────────────────────────────
//
// `keep = 0` lifts the count protection: a fresh sandbox is held ONLY
// by the age cut-off. So the scene has young directories, old ones,
// and foreign ones: without the young, sweeping everything in a row
// would be green; without the old — a sweep that removed nothing
// at all.
const BOXES = makeSandbox('promptobus-sweep-tmp-');
const OLD = ['promptobus-telemetry-old', 'promptobus-promptobus spawn-old', 'promptobus-ambient-old',
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
// A neighbouring run can be older than the age cutoff and still own live
// holders. Its owner marker is the liveness evidence; the six children model
// the four Codex holders and two Claude reviewers that must remain together.
const LIVE_RUN = plant(BOXES, 'promptobus-test-run-live', 3 * DAY);
writeFileSync(path.join(LIVE_RUN, RUN_OWNER_FILE), `${JSON.stringify({ pid: process.pid, path: LIVE_RUN })}\n`);
for (const holder of ['codex-holder-1', 'codex-holder-2', 'codex-holder-3', 'codex-holder-4',
  'claude-reviewer-1', 'claude-reviewer-2']) {
  mkdirSync(path.join(LIVE_RUN, holder), { recursive: true });
  writeFileSync(path.join(LIVE_RUN, holder, 'live'), 'held\n');
}
utimesSync(LIVE_RUN, new Date(NOW - 3 * DAY), new Date(NOW - 3 * DAY));

const heldRuns = [];
const swept = sweepTestSandboxes(BOXES, { current: RUN_TMP, isLive: runOwnerIsLive, held: heldRuns });

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

check(': a live neighbouring run keeps its owner tree and all six live holders',
  existsSync(LIVE_RUN)
  && ['codex-holder-1', 'codex-holder-2', 'codex-holder-3', 'codex-holder-4',
    'claude-reviewer-1', 'claude-reviewer-2'].every((holder) => existsSync(path.join(LIVE_RUN, holder)))
  && heldRuns.join(',') === path.basename(LIVE_RUN),
  `held: ${heldRuns.join(', ') || 'none'}`);

// A second pass over the same directory: there is nothing more to
// sweep, and the sweep says so with an empty list, not by sweeping
// the remainder.
check(': a second pass has nothing to sweep — the remainder is not touched',
  sweepTestSandboxes(BOXES, { current: RUN_TMP, isLive: runOwnerIsLive }).length === 0
  && listOf(BOXES).length === FRESH.length + FOREIGN.length + 2,
  listOf(BOXES).join(', '));

// The marker's path is resolved before it is compared: a realpath spelling
// difference is harmless, but a dead pid or a different existing directory
// is not ownership evidence. Both negative cases must stay removable.
const OWNER_FIXTURE = mkdtempSync('promptobus-sweep-owner-');
const DEAD_OWNER = plant(OWNER_FIXTURE, 'dead', 3 * DAY);
writeFileSync(path.join(DEAD_OWNER, RUN_OWNER_FILE), `${JSON.stringify({ pid: 2147483647, path: DEAD_OWNER })}\n`);
const MISMATCH_OWNER = plant(OWNER_FIXTURE, 'mismatch', 3 * DAY);
const MISMATCH_TARGET = plant(OWNER_FIXTURE, 'other', 3 * DAY);
writeFileSync(path.join(MISMATCH_OWNER, RUN_OWNER_FILE), `${JSON.stringify({ pid: process.pid, path: MISMATCH_TARGET })}\n`);
check(': a dead owner pid is not live', !runOwnerIsLive(DEAD_OWNER), DEAD_OWNER);
check(': an owner path mismatch is not live', !runOwnerIsLive(MISMATCH_OWNER), MISMATCH_TARGET);
rmSync(OWNER_FIXTURE, { recursive: true, force: true });

// A prefix and an old mtime are not proof that a neighbouring run is gone.
// The fixture supplies liveness evidence for one directory and leaves a second
// one genuinely abandoned; the sweep must hold the first while removing the
// second. This is deliberately a private fixture, never the machine's `/tmp`.
const LIVE_FIXTURE = makeSandbox('promptobus-sweep-live-');
const LIVE_PREFIX = SOCK_PREFIXES[0];
const LIVE_NEIGHBOUR = plant(LIVE_FIXTURE, `${LIVE_PREFIX}live-neighbour`, 3 * DAY);
const CURRENT_SOCKET_RUN = plant(LIVE_FIXTURE, `${LIVE_PREFIX}current`, 3 * DAY);
const STALE_SOCKET_RUN = plant(LIVE_FIXTURE, `${LIVE_PREFIX}stale`, 3 * DAY);
const heldLive = [];
const sweptWithLiveness = sweepTestSockets(LIVE_FIXTURE, {
  current: CURRENT_SOCKET_RUN,
  isLive: (dir) => dir === LIVE_NEIGHBOUR,
  held: heldLive,
});

check(': liveness evidence preserves a live neighbouring socket directory',
  existsSync(LIVE_NEIGHBOUR) && existsSync(CURRENT_SOCKET_RUN)
  && !existsSync(STALE_SOCKET_RUN)
  && sweptWithLiveness.join(',') === path.basename(STALE_SOCKET_RUN)
  && heldLive.join(',') === path.basename(LIVE_NEIGHBOUR),
  `swept: ${sweptWithLiveness.join(', ') || 'none'} · held: ${heldLive.join(', ') || 'none'}`);

// Exercise the default probe, not only the injected predicate above. The
// fixture uses a short relative root so the Unix socket path stays below
// sun_path even when the runner diverts the suite's normal TMPDIR.
if (process.platform !== 'win32') {
  const SOCKET_FIXTURE = mkdtempSync('promptobus-sweep-socket-');
  const server = net.createServer();
  let listening = false;
  let probeError = null;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path.join(SOCKET_FIXTURE, 'live.sock'), resolve);
    });
    listening = true;
    const plain = path.join(SOCKET_FIXTURE, 'plain');
    const empty = path.join(SOCKET_FIXTURE, 'empty');
    mkdirSync(plain);
    mkdirSync(empty);
    writeFileSync(path.join(plain, 'plain.sock'), 'not a socket\n');
    check(': a live Unix socket is held by the default probe', socketDirIsLive(SOCKET_FIXTURE), SOCKET_FIXTURE);
    check(': a plain .sock file is not a live socket', !socketDirIsLive(plain), plain);
    check(': an empty socket directory is not live', !socketDirIsLive(empty), empty);
  } catch (error) {
    probeError = error;
    check(': the socket probe fixture starts', false, error?.message ?? String(error));
  } finally {
    if (listening) await new Promise((resolve) => server.close(resolve));
    rmSync(SOCKET_FIXTURE, { recursive: true, force: true });
  }
  if (probeError) console.error(`socket probe fixture: ${probeError.message ?? probeError}`);
} else {
  check(': the default socket probe is fail-closed on win32', socketDirIsLive('missing') === true, 'not held');
}

// The sweep calls in the runner — against the source, for the same reason
// as the absent release-gate script above: [run.mjs](run.mjs) cannot be
// imported, it runs the whole suite. Without these checks a removed call
// would paint nothing — the sweeps themselves are checked by fixture
// scenes, and the runner is their only production call site.
const runSrc = readFileSync(path.join(here, 'run.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
check(': the runner sweeps sandboxes and sockets at start, with an owner check',
  /sweepTestSandboxes\(os\.tmpdir\(\),[\s\S]*?current:\s*RUN_TMP[\s\S]*?isLive:\s*runOwnerIsLive/.test(runSrc)
  && /sweepTestSockets\(\s*['"]\/tmp['"]/.test(runSrc),
  `import: ${/from '.\/tmpdir-sweep.mjs'/.test(runSrc)} · sandboxes: ${/sweepTestSandboxes\(/.test(runSrc)} · sockets: ${/sweepTestSockets\(/.test(runSrc)}`);

// Live scripts are not imported: each one starts real harness sessions. Read
// their source instead, and keep their cleanup checks next to the suite
// sentinel so a new live prefix cannot hide outside every sweep.
const scriptsDir = path.join(here, '..', 'scripts');
const sourceOf = (name) => readFileSync(path.join(scriptsDir, name), 'utf8');
const mixedSrc = sourceOf('live-mixed.mjs');
const cursorSrc = sourceOf('live-cursor.mjs');
const codexSrc = sourceOf('live-codex.mjs');
const e2eSrc = sourceOf('live-e2e.mjs');
const LIVE_PREFIXES = [
  'promptobus-live-codex-', 'promptobus-live-cursor-', 'promptobus-live-e2e-',
];

check(': live-mixed ignores run directories older than this run',
  /const tmpLeft[\s\S]*?bornAfter\(path\.join\(tmpdir\(\), n\)\)/.test(mixedSrc),
  'the run-directory verdict has no birth-time cutoff');

const ownSweep = (src, prefix) => /sweepPreviousRuns/.test(src)
  && new RegExp(`prefix:\\s*['"]${prefix}['"]`).test(src)
  && /current:\s*SB/.test(src);
check(': live-codex sweeps old sandbox directories with its own prefix',
  ownSweep(codexSrc, 'promptobus-live-codex-'),
  'live-codex has no sweep for its sandbox prefix');
check(': live-e2e sweeps old sandbox directories with its own prefix',
  ownSweep(e2eSrc, 'promptobus-live-e2e-'),
  'live-e2e has no sweep for its sandbox prefix');

const refusedSweep = (src) => /const refused\w*\s*=\s*\[\]/.test(src)
  && /sweepPreviousRuns\([\s\S]*?refused:\s*refused\w*/.test(src)
  && /sweep refused/.test(src);
check(': live-mixed reports refused log sweeps', refusedSweep(mixedSrc), 'live-mixed drops refused names');
check(': live-cursor reports refused log sweeps', refusedSweep(cursorSrc), 'live-cursor drops refused names');

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
  const stuck = plant(LOCKED, 'promptobus-telemetry-locked', 3 * DAY);
  const lock = path.join(stuck, 'lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, 'held'), 'held\n');
  chmodSync(lock, 0o555);
  // Directory time is set AFTER contents were put into it: directory
  // mtime grows on every write inside, and a planted age without
  // that would reset to "just now" — the age cut-off would then
  // protect the directory itself, and the scene would not be
  // checking a sweep refusal.
  const aged = new Date(NOW - 3 * DAY);
  utimesSync(stuck, aged, aged);
  const doomed = plant(LOCKED, 'promptobus-telemetry-doomed', 2 * DAY);

  let threw = null;
  let sweptLocked = [];
  const refused = [];
  try { sweptLocked = sweepTestSandboxes(LOCKED, { refused }); } catch (e) { threw = e; }
  chmodSync(lock, 0o755);

  check(': a sweep refusal the sweep swallows — the suite does not fail from it',
    threw === null, `threw: ${threw?.message ?? '—'}`);

  check(': a refusal does not take the name of a swept neighbour — the list names it',
    sweptLocked.join(',') === 'promptobus-telemetry-doomed' && !existsSync(doomed),
    `swept: ${sweptLocked.join(', ') || 'none'}`);

  check(': the unyielding directory is named in a separate list and stayed in place',
    refused.join(',') === 'promptobus-telemetry-locked' && existsSync(stuck),
    `refused: ${refused.join(', ') || 'none'} · ${existsSync(stuck)}`);
}

// ── Prefix-list sentinel ──────────────────────────────────────────────────────────
//
// The list is hand-built by grepping the directory, and a new prefix
// would leak past the sweep in silence. The check repeats the same
// grep in both directions: every `makeSandbox('…')` and every `mkdtemp`
// of a temp directory literal in `test/` must be covered by the list,
// and every list entry must cover a literal. The same way
// [runner.test.mjs](runner.test.mjs) checks `SERIAL` against the
// directory.
//
// **The temp directory is spelled two ways, and the pattern takes
// both.** While it demanded the qualified `os.tmpdir()`, a file that
// did `import { tmpdir } from 'node:os'` and wrote
// `join(tmpdir(), '…')` was invisible to the sentinel: its prefix was
// never demanded of the list and never swept, and the check stayed
// green on an incomplete list. Measured 2026-09-05 on this tree: the
// qualified pattern found 44 literals and reported nothing uncovered;
// the widened one finds 61 and reported eight uncovered prefixes,
// among them `promptobus-routing-`, which four files were already
// creating. So the `os.` qualifier is optional, and so is the `path.`
// on `join`.
//
// Non-literal arguments (the `prefix` variable in
// [sandbox.mjs](sandbox.mjs) itself) grep does not take by
// construction — there is nothing to search for. `makeSockDir` lives
// under `/tmp` past `os.tmpdir()` and is not the subject of THIS
// sweep: its prefixes are watched by the section below.
const declared = [];
const SCAN = [here, scriptsDir];
for (const dir of SCAN) {
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.mjs')
    && (dir === here || n.startsWith('live-')))) {
    // Comment lines are stripped: prose quotes the same calls in
    // this file and in [tmpdir-sweep.mjs](tmpdir-sweep.mjs) itself,
    // and a quoted sandbox does not create one.
    const src = readFileSync(path.join(dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    // Any of the three quotes, closed by itself (back-reference): a
    // literal moved into backticks would otherwise slip past the
    // sentinel in silence — and they are moved in this repository
    // in batches, whole waves.
    for (const m of src.matchAll(/makeSandbox\(\s*(['"`])([^'"`]+)\1/g)) declared.push([file, m[2]]);
    for (const m of src.matchAll(/mkdtempSync\(\s*(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(['"`])([^'"`]+)\1/g)) {
      declared.push([file, m[2]]);
    }
  }
}
const uncovered = declared.filter(([, pre]) => !SUITE_PREFIXES.some((known) => pre.startsWith(known))
  && !LIVE_PREFIXES.some((known) => pre.startsWith(known)));

check(': the sweep prefix list covers every suite sandbox',
  declared.length > 0 && uncovered.length === 0,
  `literals found: ${declared.length} · uncovered: `
  + `${uncovered.map(([f, p]) => `${p} (${f})`).join(', ') || '—'}`);

const dead = SUITE_PREFIXES.filter((known) => !declared.some(([, pre]) => pre.startsWith(known)));
check(': the sweep prefix list has no dead entries',
  dead.length === 0,
  `dead: ${dead.join(', ') || '—'}`);

// ── Socket-prefix sentinel of the runner sweep ────────────────────────────
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
// `makeSockDir`, not through the suite. The runner itself cannot be
// imported — it runs the whole suite — so its call is checked against
// the source, like the run-directory sweep above.
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
const sockDead = SOCK_PREFIXES.filter((known) => !sockDeclared.some(([, pre]) => pre.startsWith(known)));

check(': the socket-prefix list covers every makeSockPath/makeSockDir',
  sockDeclared.length > 0 && sockUncovered.length === 0,
  `literals found: ${sockDeclared.length} · uncovered: `
  + `${sockUncovered.map(([f, p]) => `${p} (${f})`).join(', ') || '—'}`);

check(': the socket-prefix list has no dead entries',
  sockDead.length === 0,
  `dead: ${sockDead.join(', ') || '—'}`);

if (gatesPresent) {
  check(': release-gates looks at sockets by SOCK_PREFIXES, not by a literal',
    /from '\.\.\/test\/sock-prefixes\.mjs'/.test(gatesSrc)
    && /younger\('\/tmp',\s*SOCK_PREFIXES\)/.test(gatesSrc),
    `import: ${/sock-prefixes/.test(gatesSrc)} · younger: ${/younger\('\/tmp'/.test(gatesSrc)}`);
} else {
  check(': the runner sweeps sockets with the shared prefix list and liveness probe',
    /sweepTestSockets\(\s*['"]\/tmp['"]/.test(runSrc)
    && /SOCK_PREFIXES/.test(readFileSync(path.join(here, 'sock-prefixes.mjs'), 'utf8'))
    && /socketDirIsLive/.test(readFileSync(path.join(here, 'tmpdir-sweep.mjs'), 'utf8')),
    'the runner socket sweep or its liveness seam is missing');
}

// ── Home-diversion sentinel ───────────────────────────────────────────────
//
// The third footprint of the suite on a machine, after `$TMPDIR` sandboxes and
// sockets: the operator's HOME. It is diverted in two places, and only one of
// them covers a file run BY HAND — [run.mjs](run.mjs) builds a per-file home for
// every child of a run, and [home.mjs](home.mjs) applies the shared hygiene list
// at module load for whoever imports it. A file that imports neither sees
// `os.homedir()` and writes there.
//
// The apply is not visible from the outside — no directory, no trace file, just
// an import — so this is a source check, like the two sentinels above, and like
// them it reads the directory rather than a list. Comment lines are stripped:
// prose in this repository quotes these imports, and a quoted import diverts
// nothing.
//
// `check.mjs` is accepted in place of `home.mjs` because it imports it, and the
// second check is what makes that a fact rather than a claim. Without it the
// first check would go on passing after someone moved the apply back out of the
// verdict helper, and half the suite names only the helper.
const suiteFiles = readdirSync(here).filter((n) => n.endsWith('.test.mjs'));
// Every static import of a file, in source order, with what it names. Comment
// lines are stripped first: prose in this repository quotes these imports, and a
// quoted import diverts nothing.
const importsOf = (name) => [...readFileSync(path.join(here, name), 'utf8')
  .replace(/^\s*\/\/.*$/gm, '')
  .matchAll(/^import\s+(?:[^;]*?\s+from\s+)?'([^']+)';/gm)].map((m) => m[1]);
const APPLY = ['./home.mjs', './check.mjs'];
const placed = suiteFiles.map((name) => [name, importsOf(name)]);
const noApply = placed.filter(([, imports]) => !imports.some((i) => APPLY.includes(i))).map(([n]) => n);

check(': every suite file reaches the home diversion — by home.mjs or by check.mjs',
  suiteFiles.length > 20 && noApply.length === 0,
  `suite files: ${suiteFiles.length} · with no apply: ${noApply.join(', ') || '—'}`);

// Reaching it is not enough — it has to be reached FIRST. A module that resolved a
// home path at load would capture the real one, and an import placed after such a
// module diverts nothing that module already read. Node built-ins are not the
// hazard: importing `node:os` captures nothing, `os.homedir()` is a function. The
// rule is therefore about everything else, which is the set that can hold state.
const tooLate = placed
  .filter(([, imports]) => {
    const at = imports.findIndex((i) => APPLY.includes(i));
    return at >= 0 && imports.slice(0, at).some((i) => !i.startsWith('node:'));
  })
  .map(([name, imports]) => `${name} (${imports.slice(0, imports.findIndex((i) => APPLY.includes(i)))
    .filter((i) => !i.startsWith('node:')).join(', ')})`);

check(': the apply point is imported before any module that is not a Node built-in',
  placed.length > 20 && tooLate.length === 0,
  `late in: ${tooLate.join(' · ') || '—'}`);

check(': check.mjs reaches the diversion by importing home.mjs, so naming the helper is enough',
  importsOf('check.mjs')[0] === './home.mjs', importsOf('check.mjs').join(', '));

// And `home.mjs` itself borrows nothing that could read home before it runs. It is
// the first thing every suite file loads, so its own imports are evaluated before
// the diversion: one suite module, which carries the shared list and imports only
// built-ins itself. `makeSandbox` would be the natural reuse and is the thing this
// forbids — sandbox.mjs statically imports three package modules.
const homeImports = importsOf('home.mjs');
const hygieneImports = importsOf('hygiene.mjs');
check(': home.mjs imports only built-ins and hygiene.mjs, which imports only built-ins',
  homeImports.length > 0
  && homeImports.every((i) => i.startsWith('node:') || i === './hygiene.mjs')
  && hygieneImports.every((i) => i.startsWith('node:')),
  `home.mjs: ${homeImports.join(', ')} · hygiene.mjs: ${hygieneImports.join(', ')}`);

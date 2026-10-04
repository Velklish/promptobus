// The mutation probe itself — the gate on the gate. Run: npm test
//
// Subject: `scripts/mutation-probe.mjs` and the four outcomes it must keep apart. Three of
// them are the ones a person cannot be trusted to notice by hand:
//
//   red with the mutation, green without → the check sees its subject. The only pass.
//   the mutation changed nothing         → the probe proved nothing and must say so, not pass.
//   the check passed WITH the mutation   → the check does not see the file. This is the shape
//                                          this repository kept finding by eye all through the
//                                          2026-09-12 run, and the first one a machine catches.
//   the tree is not clean                → refusal. "Commit first" was held by nothing but the
//                                          agent remembering, and a probe over uncommitted work
//                                          loses it: three fixes in two days.
//
// **The probe is run against a repository of its own**, built here with `git init`, and never
// against this one: the script resolves its root as its own `..`, so a copy under `<tmp>/scripts`
// makes `<tmp>` the root. That keeps the checks from depending on whether this tree happens to be
// clean, and from mutating real files to find out.
//
// The restore this file pins is the subject of PB-95, not an implementation detail: the script
// puts the file back from a snapshot taken BEFORE the mutation, never with git, because a git
// restore is exactly what lost the work the script exists to protect.
import { check } from './check.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeSandbox } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = makeSandbox('mutation-probe-');
const SCRIPT = path.join(REPO, 'scripts', 'mutation-probe.mjs');
const SUBJECT = path.join(REPO, 'subject.txt');
const MARKER = 'the-marker-the-check-looks-for';

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

mkdirSync(path.join(REPO, 'scripts'), { recursive: true });
copyFileSync(path.join(here, '..', 'scripts', 'mutation-probe.mjs'), SCRIPT);
writeFileSync(SUBJECT, `${MARKER}\n`);
// The stand's own check: green only while the subject still carries the marker. `other.txt` is
// what the check does NOT read, and is how the "does not see the file" outcome is reached.
writeFileSync(path.join(REPO, 'check.mjs'), [
  "import { readFileSync } from 'node:fs';",
  `const text = readFileSync(new URL('subject.txt', import.meta.url), 'utf8');`,
  `if (!text.includes(${JSON.stringify(MARKER)})) { console.log('✖ the marker is gone'); process.exit(1); }`,
  "console.log('✔ the marker is there');",
].join('\n'));
writeFileSync(path.join(REPO, 'other.txt'), 'nothing here is read by the check\n');
// Red without a line the probe treats as a named check: a build step, a module that fails to load.
writeFileSync(path.join(REPO, 'quiet-fail.mjs'), [
  "import { readFileSync } from 'node:fs';",
  "const text = readFileSync(new URL('subject.txt', import.meta.url), 'utf8');",
  `if (!text.includes(${JSON.stringify(MARKER)})) { console.log('tsc refused the build'); process.exit(1); }`,
  "console.log('build ok');",
].join('\n'));
// Green on one line, red once a real newline has landed inside the subject.
writeFileSync(path.join(REPO, 'lines.mjs'), [
  "import { readFileSync } from 'node:fs';",
  "const text = readFileSync(new URL('subject.txt', import.meta.url), 'utf8');",
  "const body = text.endsWith('\\n') ? text.slice(0, -1) : text;",
  "if (body.includes('\\n')) { console.log('✖ a real newline landed'); process.exit(1); }",
  "console.log('✔ one line');",
].join('\n'));
// A test file run by the default command, whose name is shell text: `$(…)` runs under a shell.
const SHELL_NAME = 'x $(: > pwned) y.mjs';
writeFileSync(path.join(REPO, SHELL_NAME), [
  "const verdict = 'green';",
  "if (verdict !== 'green') { console.log('✖ the verdict turned'); process.exit(1); }",
  "console.log('✔ green');",
].join('\n'));
writeFileSync(path.join(REPO, 'self-kill.mjs'), [
  "const verdict = 'green';",
  "if (verdict !== 'green') process.kill(process.pid, 'SIGTERM');",
  "console.log('✔ green');",
].join('\n'));
// Cut off by the suite's own helper, so the abort line the probe reads is the real one.
writeFileSync(path.join(REPO, 'crash.mjs'), [
  `import { check } from ${JSON.stringify(pathToFileURL(path.join(here, 'check.mjs')).href)};`,
  "import { readFileSync } from 'node:fs';",
  "const text = readFileSync(new URL('subject.txt', import.meta.url), 'utf8');",
  "check(': the subject is read', true);",
  `if (!text.includes(${JSON.stringify(MARKER)})) throw new Error('the setup broke before the verdict');`,
  "check(': the marker is there', true);",
].join('\n'));
writeFileSync(path.join(REPO, 'killed.mjs'), [
  "import { readFileSync } from 'node:fs';",
  "const text = readFileSync(new URL('subject.txt', import.meta.url), 'utf8');",
  `if (!text.includes(${JSON.stringify(MARKER)})) process.kill(process.pid, 'SIGTERM');`,
  "console.log('✔ the marker is there');",
].join('\n'));
// Run by the default command, so its parent is the probe: the run signals the probe mid-run and
// then ends as a red that names its failing check.
writeFileSync(path.join(REPO, 'signals-probe.mjs'), [
  "const verdict = 'green';",
  "if (verdict !== 'green') { process.kill(process.ppid, verdict); console.log('✖ the verdict turned'); process.exit(1); }",
  "console.log('✔ green');",
].join('\n'));
// The real runner, planted with the neighbours it imports the way runner.test.mjs plants it, so the
// line the probe reads for a file the runner took down is the runner's own wording.
const RUNNER = path.join(REPO, 'runner');
const RUNNER_CAP_S = 3;
const runSrc = readFileSync(path.join(here, 'run.mjs'), 'utf8');
const runCopy = runSrc.replace(/const FILE_TIMEOUT_MS = [\d_]+;/, `const FILE_TIMEOUT_MS = ${RUNNER_CAP_S * 1000};`);
const sweepSrc = readFileSync(path.join(here, 'tmpdir-sweep.mjs'), 'utf8');
const RUNS_MOD = "'../scripts/canary-runs.mjs'";
const sweepCopy = sweepSrc.replace(RUNS_MOD,
  JSON.stringify(pathToFileURL(path.join(here, '..', 'scripts', 'canary-runs.mjs')).href));
check(': the planted runner has its file timeout cut and its sweep import pointed at the real module',
  runCopy !== runSrc && sweepCopy !== sweepSrc && !sweepCopy.includes(RUNS_MOD));
mkdirSync(RUNNER);
writeFileSync(path.join(RUNNER, 'run.mjs'), runCopy);
const SPAWN_FILE = 'spawn(process.execPath, [path.join(here, name)]';
const unstartable = runCopy.replace(SPAWN_FILE, "spawn(path.join(here, 'no-such-node'), [path.join(here, name)]");
check(': the unstartable runner copy has its file spawn pointed at a missing executable', unstartable !== runCopy);
writeFileSync(path.join(RUNNER, 'run-unstartable.mjs'), unstartable);
writeFileSync(path.join(RUNNER, 'tmpdir-sweep.mjs'), sweepCopy);
copyFileSync(path.join(here, 'hygiene.mjs'), path.join(RUNNER, 'hygiene.mjs'));
writeFileSync(path.join(RUNNER, 'a-subject.test.mjs'), [
  "import { readFileSync } from 'node:fs';",
  "const text = readFileSync(new URL('../subject.txt', import.meta.url), 'utf8');",
  "if (text.includes('killed')) process.kill(process.pid, 'SIGKILL');",
  "else if (text.includes('hung')) setInterval(() => {}, 1000);",
  "else console.log('✔ the subject is read');",
].join('\n'));
// A red whose output quotes the cut-off lines as text — indented and mid-line, the way a report does.
writeFileSync(path.join(REPO, 'quotes.mjs'), [
  "import { readFileSync } from 'node:fs';",
  "const text = readFileSync(new URL('subject.txt', import.meta.url), 'utf8');",
  `if (!text.includes(${JSON.stringify(MARKER)})) {`,
  "  console.log('✖ the marker is gone — the probe it ran printed:');",
  "  console.log('    ✖ abort: process exited with code 1 after check \": x\" — checks below did not run');",
  "  console.log('✖ probe: the run with the mutation was cut off (✖ a.test.mjs — failed (signal SIGKILL))');",
  '  process.exit(1);',
  '}',
  "console.log('✔ the marker is there');",
].join('\n'));
// Red with more output than the probe buffers: the spawn fails while the mutation is in place.
writeFileSync(path.join(REPO, 'flood.mjs'), [
  "import { readFileSync } from 'node:fs';",
  "const text = readFileSync(new URL('subject.txt', import.meta.url), 'utf8');",
  `if (!text.includes(${JSON.stringify(MARKER)})) { process.stdout.write('x'.repeat(65 * 1024 * 1024)); process.exitCode = 1; }`,
  "else console.log('✔ the marker is there');",
].join('\n'));
git('init', '-q');
git('config', 'user.email', 'probe@example.invalid');
git('config', 'user.name', 'probe');
git('add', '-A');
git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'stand');

const fed = (input, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', input });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const probe = (...args) => fed(undefined, ...args);
const subject = () => readFileSync(SUBJECT, 'utf8');
const RUN = ['--run', `${JSON.stringify(process.execPath)} check.mjs`];
const runWith = (file, ...rest) => ['--run', [JSON.stringify(process.execPath), file, ...rest].join(' ')];
const status = () => git('status', '--porcelain');
const OTHER = path.join(REPO, 'other.txt');
const other = () => (existsSync(OTHER) ? readFileSync(OTHER, 'utf8') : 'other.txt is gone');
// Stand housekeeping after a case's own checks, never the probe's restore: a case that leaves the
// tree dirty must not have the next one refused for it.
const clean = () => { git('reset', '-q', '--hard'); git('clean', '-qfd'); };

// --- the one pass: red with the mutation, green without ----------------------

const good = probe('subject.txt', '--mutate', `s/${MARKER}/broken/`, ...RUN);
check(': a check that sees its subject is red with the mutation and green without it',
  good.code === 0 && /✔ probe: red with the mutation \(exit 1\), green without it/.test(good.out),
  `exit ${good.code} · ${good.out}`);
check(': a red run that names a failing check does not warn that none was named',
  !/no failing check was named/.test(good.out),
  good.out);
check(': and the red run\'s own line is quoted, so the report says WHAT fired',
  /✖ the marker is gone/.test(good.out), good.out);
check(': the subject is put back — from the snapshot, which is the whole point of the script',
  subject() === `${MARKER}\n`, subject());

// --- the mutation that changed nothing ---------------------------------------

const inert = probe('subject.txt', '--mutate', 's/no-such-text-anywhere/x/', ...RUN);
check(': a mutation that changes nothing is a refusal, not a pass',
  inert.code === 2 && /the mutation changed nothing/.test(inert.out),
  `exit ${inert.code} · ${inert.out}`);
check(': and it leaves the subject alone',
  subject() === `${MARKER}\n`, subject());

// --- the check that does not see the file ------------------------------------

const blind = probe('other.txt', '--mutate', 's/nothing/something/', ...RUN);
check(': a check that stays green WITH the mutation in place is reported as not seeing the file',
  blind.code === 1 && /passed WITH the mutation in place — it does not see other\.txt/.test(blind.out),
  `exit ${blind.code} · ${blind.out}`);
check(': and that file is restored too — a failed probe still puts the tree back',
  readFileSync(path.join(REPO, 'other.txt'), 'utf8') === 'nothing here is read by the check\n');

// --- the replacement half of --mutate ---------------------------------------

const escaped = probe('subject.txt', '--mutate', `s/${MARKER}/bro\\nken/`, ...RUN);
check(': a replacement containing the \\n escape is refused by name, and the message names --stdin-patch',
  escaped.code === 2 && /the \\n escape/.test(escaped.out) && /--stdin-patch/.test(escaped.out),
  `exit ${escaped.code} · ${escaped.out}`);
check(': the refusal leaves the subject untouched and runs no check',
  subject() === `${MARKER}\n` && !/mutated →/.test(escaped.out), escaped.out);

const piped = probe('subject.txt', '--mutate', `s|${MARKER}|broken|`, ...RUN);
check(': the separator is arbitrary — s|…|…| reddens the check the same way',
  piped.code === 0 && /✔ probe: red with the mutation \(exit 1\), green without it/.test(piped.out),
  `exit ${piped.code} · ${piped.out}`);
check(': and the subject is put back after a pipe-separated mutation',
  subject() === `${MARKER}\n`, subject());

const realNl = probe('subject.txt', '--mutate', `s|${MARKER}|two\nlines|`, '--run', `${JSON.stringify(process.execPath)} lines.mjs`);
check(': a replacement that already holds a real newline is applied, and the line break is real',
  realNl.code === 0 && /✖ a real newline landed/.test(realNl.out) && !/the \\n escape/.test(realNl.out),
  `exit ${realNl.code} · ${realNl.out}`);
check(': the subject is put back after a real-newline mutation',
  subject() === `${MARKER}\n`, subject());

// A whole-marker `$&` writes the marker back, so the pattern is a piece in the middle.
const dollars = [
  ['$&XX', '$&'],
  ['$1XX', '$1'],
  ['$`XX', '$`'],
  ["$'XX", "$'"],
];
for (const [repl, label] of dollars) {
  const r = probe('subject.txt', '--mutate', `s/check-looks/${repl}/`, ...RUN);
  check(`: a replacement containing ${label} warns and the pass verdict stays`,
    r.code === 0 && /String\.replace replacement/.test(r.out) && /✔ probe: red with the mutation \(exit 1\), green without it/.test(r.out),
    `exit ${r.code} · ${r.out}`);
  check(`: the subject is put back after a ${label} mutation`,
    subject() === `${MARKER}\n`, subject());
}

const literalDollar = probe('subject.txt', '--mutate', `s/${MARKER}/$$&/`, ...RUN);
check(': $$& is a literal dollar, not a substitution, so it draws no warning',
  literalDollar.code === 0 && !/--mutate: warning:/.test(literalDollar.out) && /✔ probe: red with the mutation \(exit 1\)/.test(literalDollar.out),
  `exit ${literalDollar.code} · ${literalDollar.out}`);
check(': the subject is put back after a literal-dollar mutation',
  subject() === `${MARKER}\n`, subject());

// --- a red run that never named a check --------------------------------------

const quiet = probe('subject.txt', '--mutate', `s/${MARKER}/broken/`, '--run', `${JSON.stringify(process.execPath)} quiet-fail.mjs`);
check(': a red run that names no failing check warns before the pass verdict',
  quiet.code === 0
    && /no failing check was named/.test(quiet.out)
    && /stops before the suite/.test(quiet.out)
    && /✔ probe: red with the mutation \(exit 1\), green without it/.test(quiet.out)
    && quiet.out.indexOf('no failing check was named') < quiet.out.indexOf('✔ probe: red with the mutation'),
  `exit ${quiet.code} · ${quiet.out}`);
check(': the subject is put back after a run that named no check',
  subject() === `${MARKER}\n`, subject());

// --- the default command runs the file, never its name as shell text ---------

const shellName = probe(SHELL_NAME, '--mutate', "s/'green';/'red';/");
check(': the default command runs a file whose name holds $(…), and reads that file\'s own verdicts',
  shellName.code === 0 && /✖ the verdict turned/.test(shellName.out)
    && /✔ probe: red with the mutation \(exit 1\), green without it/.test(shellName.out),
  `exit ${shellName.code} · ${shellName.out}`);
check(': and the $(…) in the name never ran — the file it would create is not there',
  !existsSync(path.join(REPO, 'pwned')) && status() === '', status());
clean();

// --- a patch the restore cannot put back is refused before it is applied -----

const EDIT = ['diff --git a/subject.txt b/subject.txt', '--- a/subject.txt', '+++ b/subject.txt', '@@ -1 +1 @@', `-${MARKER}`, '+broken'];
const patched = (...lines) => `${lines.join('\n')}\n`;

const edit = fed(patched(...EDIT), 'subject.txt', '--stdin-patch', ...RUN);
check(': a patch that only changes the content of the subject is applied and probed',
  edit.code === 0 && /✔ probe: red with the mutation \(exit 1\), green without it/.test(edit.out),
  `exit ${edit.code} · ${edit.out}`);
check(': and the subject is put back after it', subject() === `${MARKER}\n` && status() === '', status());
clean();

const escapes = [
  ['deletes the subject', /delete mode 100644 subject\.txt/, [
    'diff --git a/subject.txt b/subject.txt', 'deleted file mode 100644', '--- a/subject.txt', '+++ /dev/null',
    '@@ -1 +0,0 @@', `-${MARKER}`]],
  ['renames the subject', /rename subject\.txt => moved\.txt/, [
    'diff --git a/subject.txt b/moved.txt', 'similarity index 100%', 'rename from subject.txt', 'rename to moved.txt']],
  ['changes the subject and renames another file with no hunk', /rename other\.txt => renamed\.txt/, [
    ...EDIT, 'diff --git a/other.txt b/renamed.txt', 'similarity index 100%', 'rename from other.txt', 'rename to renamed.txt']],
  ['changes the subject and copies another file', /copy other\.txt => copied\.txt/, [
    ...EDIT, 'diff --git a/other.txt b/copied.txt', 'similarity index 100%', 'copy from other.txt', 'copy to copied.txt']],
  ['changes the subject and creates a file', /create mode 100644 created\.txt/, [
    ...EDIT, 'diff --git a/created.txt b/created.txt', 'new file mode 100644', '--- /dev/null', '+++ b/created.txt',
    '@@ -0,0 +1 @@', '+new']],
  ['changes the subject and its mode', /mode change 100644 => 100755 subject\.txt/, [
    'diff --git a/subject.txt b/subject.txt', 'old mode 100644', 'new mode 100755', ...EDIT.slice(1)]],
  ['changes the subject and the content of another file', /this one touches other\.txt —/, [
    ...EDIT, 'diff --git a/other.txt b/other.txt', '--- a/other.txt', '+++ b/other.txt', '@@ -1 +1 @@',
    '-nothing here is read by the check', '+something']],
];
for (const [what, named, lines] of escapes) {
  const r = fed(patched(...lines), 'subject.txt', '--stdin-patch', ...RUN);
  check(`: a patch that ${what} is refused before it is applied, and the refusal names what escapes`,
    r.code === 2 && /may only change the content of subject\.txt/.test(r.out) && named.test(r.out) && !/mutated →/.test(r.out),
    `exit ${r.code} · ${r.out}`);
  check(`: the tree is as committed after a patch that ${what}`,
    status() === '' && subject() === `${MARKER}\n` && other() === 'nothing here is read by the check\n',
    `${status()} · ${existsSync(SUBJECT) ? subject() : 'subject.txt is gone'} · ${other()}`);
  clean();
}

// --- a failure with the mutation in place still restores the subject ---------

const flood = probe('subject.txt', '--mutate', `s/${MARKER}/broken/`, ...runWith('flood.mjs'));
check(': a run that fails to spawn with the mutation in place is refused, and the failure is named',
  flood.code === 2 && /ENOBUFS/.test(flood.out), `exit ${flood.code} · ${flood.out.slice(0, 2000)}`);
check(': and the subject is put back on the way out of that failure',
  subject() === `${MARKER}\n` && status() === '', `${status()} · ${subject()}`);
clean();

// --- a run cut off before its verdicts is not the red ------------------------

const BREAK = ['subject.txt', '--mutate', `s/${MARKER}/broken/`];
const cuts = [
  ['killed by a signal', /signal SIGTERM/,
    () => probe('self-kill.mjs', '--mutate', "s/'green';/'red';/")],
  ['ended by a signal its shell reports as 128 + N', /exit 143/,
    () => probe(...BREAK, '--run', `${JSON.stringify(process.execPath)} killed.mjs; exit $?`)],
  ['that crashed before its verdicts', /✖ abort: process exited with code 1/,
    () => probe(...BREAK, ...runWith('crash.mjs'))],
  ['holding a file the runner took down by a signal', /a-subject\.test\.mjs — failed \(signal SIGKILL\)/,
    () => probe('subject.txt', '--mutate', `s/${MARKER}/killed/`, ...runWith('runner/run.mjs'))],
  ['holding a file the runner took down at its timeout', new RegExp(`a-subject\\.test\\.mjs — failed \\(did not finish in ${RUNNER_CAP_S} s`),
    () => probe('subject.txt', '--mutate', `s/${MARKER}/hung/`, ...runWith('runner/run.mjs'))],
  ['holding a file the runner could not start', /a-subject\.test\.mjs — failed \(did not start: /,
    () => probe(...BREAK, ...runWith('runner/run-unstartable.mjs'))],
  ['during which the probe itself got SIGINT', /the probe got SIGINT/,
    () => probe('signals-probe.mjs', '--mutate', "s/'green';/'SIGINT';/")],
  ['during which the probe itself got SIGTERM', /the probe got SIGTERM/,
    () => probe('signals-probe.mjs', '--mutate', "s/'green';/'SIGTERM';/")],
];
for (const [what, why, run] of cuts) {
  const r = run();
  check(`: a run ${what} is refused as cut off, not counted as the red`,
    r.code === 2 && /the run with the mutation was cut off/.test(r.out) && why.test(r.out) && !/✔ probe/.test(r.out),
    `exit ${r.code} · ${r.out}`);
  check(`: the tree is as committed after a run ${what}`,
    status() === '' && subject() === `${MARKER}\n`, `${status()} · ${subject()}`);
  clean();
}

const quoted = probe(...BREAK, ...runWith('quotes.mjs'));
check(': a red whose output only quotes the cut-off lines, indented or mid-line, is counted as the red',
  quoted.code === 0 && /✔ probe: red with the mutation \(exit 1\), green without it/.test(quoted.out),
  `exit ${quoted.code} · ${quoted.out}`);
check(': the subject is put back after a red that quotes the cut-off lines',
  subject() === `${MARKER}\n` && status() === '', `${status()} · ${subject()}`);

// An exit right after a write to a pipe can cut the last line, so the probe sets its exit code and returns.
check(': the probe never calls process.exit', !/process\.exit\(/.test(readFileSync(SCRIPT, 'utf8')));

// --- commit first ------------------------------------------------------------

writeFileSync(path.join(REPO, 'uncommitted.txt'), 'an edit nobody committed\n');
const dirty = probe('subject.txt', '--mutate', `s/${MARKER}/broken/`, ...RUN);
check(': a dirty tree is refused before anything is touched, and what is dirty is named',
  dirty.code === 2 && /the tree is not clean/.test(dirty.out) && /uncommitted\.txt/.test(dirty.out),
  `exit ${dirty.code} · ${dirty.out}`);
check(': the refusal ran no check at all — the subject was never mutated',
  subject() === `${MARKER}\n` && !/mutated →/.test(dirty.out), dirty.out);

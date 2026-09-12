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
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
git('init', '-q');
git('config', 'user.email', 'probe@example.invalid');
git('config', 'user.name', 'probe');
git('add', '-A');
git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'stand');

const probe = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const subject = () => readFileSync(SUBJECT, 'utf8');
const RUN = ['--run', `${JSON.stringify(process.execPath)} check.mjs`];

// --- the one pass: red with the mutation, green without ----------------------

const good = probe('subject.txt', '--mutate', `s/${MARKER}/broken/`, ...RUN);
check(': a check that sees its subject is red with the mutation and green without it',
  good.code === 0 && /✔ probe: red with the mutation \(exit 1\), green without it/.test(good.out),
  `exit ${good.code} · ${good.out}`);
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

// --- commit first ------------------------------------------------------------

writeFileSync(path.join(REPO, 'uncommitted.txt'), 'an edit nobody committed\n');
const dirty = probe('subject.txt', '--mutate', `s/${MARKER}/broken/`, ...RUN);
check(': a dirty tree is refused before anything is touched, and what is dirty is named',
  dirty.code === 2 && /the tree is not clean/.test(dirty.out) && /uncommitted\.txt/.test(dirty.out),
  `exit ${dirty.code} · ${dirty.out}`);
check(': the refusal ran no check at all — the subject was never mutated',
  subject() === `${MARKER}\n` && !/mutated →/.test(dirty.out), dirty.out);

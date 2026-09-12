// Mutation probe: prove a check fails when its subject is broken, and passes when it is not.
// Why it is a script and not a rule: docs/guides/contributing.md.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (s) => process.stdout.write(`${s}\n`);
const die = (s) => { say(`✖ ${s}`); process.exit(2); };

const USAGE = 'usage: npm run probe -- <file> (--mutate s/<js-regexp>/<replacement>/[gi] | --stdin-patch) [--run <command>]';

function parse(argv) {
  const out = { file: null, sed: null, patch: false, run: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--mutate') out.sed = argv[i += 1] ?? null;
    else if (a === '--stdin-patch') out.patch = true;
    else if (a === '--run') out.run = argv[i += 1] ?? null;
    else if (a.startsWith('-')) die(`unknown option ${a}\n${USAGE}`);
    else if (out.file === null) out.file = a;
    else die(`only one file is probed at a time\n${USAGE}`);
  }
  return out;
}

const opts = parse(process.argv.slice(2));
if (!opts.file) die(USAGE);
if (!opts.sed === !opts.patch) die(`give exactly one of --mutate and --stdin-patch\n${USAGE}`);

const rel = path.relative(ROOT, path.resolve(ROOT, opts.file));
if (rel.startsWith('..')) die(`${opts.file} is outside the repository`);
const abs = path.join(ROOT, rel);

// The command whose red is being proven. A test file runs itself, the way test/run.mjs runs it;
// anything else the repository gates with is named with --run.
const command = opts.run ?? `node ${JSON.stringify(rel)}`;

function sh(cmd) {
  const r = spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Commit first. A probe over uncommitted work loses it: restoring the mutation with git takes
// the edit with it, which has cost this repository three fixes in two days.
const dirty = sh('git status --porcelain').out.trim();
if (dirty) {
  say('✖ probe: the tree is not clean — commit before probing, or the restore takes your edit with the mutation');
  for (const line of dirty.split('\n').slice(0, 20)) say(`    ${line}`);
  process.exit(2);
}

const before = readFileSync(abs, 'utf8');

function restore() {
  writeFileSync(abs, before);
}

function mutate() {
  if (opts.patch) {
    const patch = readFileSync(0, 'utf8');
    // The snapshot restores ONE file, so a patch that touches another would leave it mutated —
    // the loss this script exists to prevent. BOTH sides are read: a rename or a delete names
    // its victim on `---` and something else, or nothing, on `+++`.
    const named = (re) => [...patch.matchAll(re)].map((m) => m[1]).filter((f) => f !== '/dev/null');
    const touched = [...named(/^\+\+\+ (?:b\/)?(\S+)$/gm), ...named(/^--- (?:a\/)?(\S+)$/gm)];
    const foreign = touched.filter((f) => path.normalize(f) !== path.normalize(rel));
    if (foreign.length) die(`--stdin-patch may only touch ${rel}, and this one touches ${[...new Set(foreign)].join(', ')} — the restore puts back one file`);
    if (!touched.length) die(`--stdin-patch: no "--- a/<path>" or "+++ b/<path>" line names a file to change`);
    const r = spawnSync('git', ['apply', '-'], { cwd: ROOT, input: patch, encoding: 'utf8' });
    if ((r.status ?? 1) !== 0) die(`git apply refused the patch: ${(r.stderr ?? '').trim()}`);
    return;
  }
  // The substitution is done here, not by the `sed` binary: `sed -i` differs between BSD and
  // GNU, and a PATH without it fails as ENOENT. Anything richer goes through --stdin-patch.
  const m = opts.sed.match(/^s(.)(.*)\1(.*)\1([gi]*)$/s);
  if (!m) die(`--mutate takes s<sep><regexp><sep><replacement><sep>[gi], not ${JSON.stringify(opts.sed)} — use --stdin-patch for anything else`);
  const [, , re, repl, flags] = m;
  // A JS regexp, not sed's BRE: `(`, `|` and `{` are operators here and need escaping.
  let pattern;
  try {
    pattern = new RegExp(re, flags);
  } catch (e) {
    die(`--mutate: ${e.message} — the pattern is a JavaScript regexp, so ( ) | { } are operators; escape them or use --stdin-patch`);
  }
  writeFileSync(abs, before.replace(pattern, repl));
}

mutate();
const after = readFileSync(abs, 'utf8');
if (after === before) {
  restore();
  die(`the mutation changed nothing in ${rel} — the probe would have proven nothing`);
}

const red = sh(command);
restore();
const green = sh(command);

// Lines that name what fired. Enough to paste into a report; the full output is not reprinted.
const fired = red.out.split('\n').filter((l) => /✖|✘|not ok|AssertionError|FAIL/.test(l)).slice(0, 5);

say(`probe: ${rel} · ${command}`);
say(`  mutated → exit ${red.code}`);
for (const l of fired) say(`    ${l.trim()}`);
say(`  restored → exit ${green.code}`);

if (red.code === 0) {
  say(`✖ probe: the check passed WITH the mutation in place — it does not see ${rel}`);
  process.exit(1);
}
if (green.code !== 0) {
  say('✖ probe: the check is red after the restore — the tree did not come back, or the check was already red');
  process.exit(1);
}
say(`✔ probe: red with the mutation (exit ${red.code}), green without it — ${rel} via ${command}`);

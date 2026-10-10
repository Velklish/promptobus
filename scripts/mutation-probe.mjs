// Mutation probe: prove a check fails when its subject is broken, and passes when it is not.
// Why it is a script and not a rule: docs/guides/contributing.md.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (s) => process.stdout.write(`${s}\n`);
// Thrown rather than exited: a refusal raised with the mutation in place passes the restore on its way out.
class Refusal extends Error {}
const die = (s) => { throw new Refusal(s); };

const USAGE = 'usage: npm run probe -- <file> (--mutate s<sep><js-regexp><sep><replacement><sep>[gi] | --stdin-patch) [--run <command>]; the separator is arbitrary (s|…|…|)';
// A run cut off before its verdicts: the suite's abort line (test/check.mjs), or the runner's line for a
// file it took down or never started (test/run.mjs). Column 0 only: an indented or mid-line one is a quote.
const CUT_OFF = /^✖ abort: process exited|^✖ \S+ — failed \((?:signal |did not finish|did not start)/;
const HELD = ['SIGINT', 'SIGTERM'];

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

// `shown` is shell text unless `argv` is given; then `argv` runs without a shell and `shown` only names it.
function sh(shown, argv = null) {
  const how = { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const r = argv ? spawnSync(argv[0], argv.slice(1), how) : spawnSync(shown, { ...how, shell: true });
  if (r.error) die(`${shown}: ${r.error.message}`);
  return { code: r.status ?? 1, signal: r.signal, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function run(shown, argv = null) {
  return new Promise((resolve, reject) => {
    const how = { cwd: ROOT, shell: argv === null };
    const child = argv ? spawn(argv[0], argv.slice(1), how) : spawn(shown, how);
    child.stdin.end();
    const streams = { stdout: '', stderr: '' };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    for (const name of Object.keys(streams)) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        if (failure) return;
        streams[name] += chunk;
        sizes[name] += Buffer.byteLength(chunk);
        if (sizes[name] > 64 * 1024 * 1024) {
          failure = new Refusal(`${shown}: ENOBUFS — ${name} exceeds maxBuffer`);
          child.kill('SIGTERM');
        }
      });
    }
    child.on('error', (error) => { failure = new Refusal(`${shown}: ${error.message}`); });
    child.on('close', (code, signal) => {
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, signal, out: streams.stdout + streams.stderr });
    });
  });
}

// A shell reports a death by signal N as 128 + N, and this suite's files and runner exit 130 on one.
function cutOff(run) {
  if (run.signal) return `signal ${run.signal}`;
  if (run.code > 128) return `exit ${run.code}, a signal by the shell's count`;
  return run.out.split('\n').find((l) => CUT_OFF.test(l))?.trim() ?? null;
}

function mutate(opts, rel, abs, before) {
  if (opts.patch) {
    const patch = readFileSync(0, 'utf8');
    // The snapshot restores the content of ONE file, so git's own reading of the patch must name that
    // file alone and no operation: a delete, a create, a rename, a copy or a mode change escapes it.
    const read = spawnSync('git', ['apply', '--check', '--numstat', '--summary', '-z', '-'], { cwd: ROOT, input: patch, encoding: 'utf8' });
    if ((read.status ?? 1) !== 0) die(`git apply refused the patch: ${(read.stderr ?? '').trim()}`);
    const records = read.stdout.split('\0');
    const operations = records.pop().trim().split('\n').filter(Boolean).map((l) => l.trim());
    const foreign = [...new Set(records.map((r) => r.split('\t').slice(2).join('\t')))]
      .filter((f) => path.normalize(f) !== path.normalize(rel));
    const escapes = [...(foreign.length ? [`touches ${foreign.join(', ')}`] : []), ...operations.map((o) => `carries "${o}"`)];
    if (escapes.length) die(`--stdin-patch may only change the content of ${rel}, and this one ${escapes.join(' and ')} — the restore puts back the content of one file`);
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
  // Two characters, not a newline: a real newline already passed the `s` flag on the parse.
  if (repl.includes('\\n')) {
    die('--mutate: the replacement contains the \\n escape, which String.replace writes as a backslash and an n — use --stdin-patch');
  }
  // `$$` is a literal dollar. The other `$` forms substitute, and a person may mean them.
  const bare = repl.replaceAll('$$', '');
  if (/\$[&'`]|\$0?[1-9]/.test(bare)) {
    say("--mutate: warning: the replacement is a String.replace replacement, so $&, $1, $` and $' substitute — a person may mean them");
  }
  writeFileSync(abs, before.replace(pattern, repl));
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (!opts.file) die(USAGE);
  if (!opts.sed === !opts.patch) die(`give exactly one of --mutate and --stdin-patch\n${USAGE}`);

  const rel = path.relative(ROOT, path.resolve(ROOT, opts.file));
  if (rel.startsWith('..')) die(`${opts.file} is outside the repository`);
  const abs = path.join(ROOT, rel);

  // The command whose red is being proven. A test file runs itself, the way test/run.mjs runs it, its
  // name an argument and never shell text; anything else the repository gates with is named with --run.
  const command = opts.run ?? `node ${JSON.stringify(rel)}`;
  const argv = opts.run === null ? [process.execPath, rel] : null;

  // Commit first. A probe over uncommitted work loses it: restoring the mutation with git takes
  // the edit with it, which has cost this repository three fixes in two days.
  const dirty = sh('git status --porcelain').out.trim();
  if (dirty) {
    say('✖ probe: the tree is not clean — commit before probing, or the restore takes your edit with the mutation');
    for (const line of dirty.split('\n').slice(0, 20)) say(`    ${line}`);
    process.exitCode = 2;
    return;
  }

  const before = readFileSync(abs, 'utf8');
  // A signal to the probe while the mutation is in place is held, not obeyed: dying here would skip the restore.
  const held = [];
  const hold = (signal) => held.push(signal);
  for (const s of HELD) process.on(s, hold);
  let red;
  try {
    mutate(opts, rel, abs, before);
    if (readFileSync(abs, 'utf8') === before) die(`the mutation changed nothing in ${rel} — the probe would have proven nothing`);
    red = await run(command, argv);
    const cut = held.length ? `the probe got ${held[0]}` : cutOff(red);
    if (cut) die(`probe: the run with the mutation was cut off (${cut}) — it is not counted as the red; ${rel} is restored`);
  } finally {
    writeFileSync(abs, before);
    for (const s of HELD) process.off(s, hold);
  }
  const green = await run(command, argv);

  // Lines that name what fired. Enough to paste into a report; the full output is not reprinted.
  const fired = red.out.split('\n').filter((l) => /✖|✘|not ok|AssertionError|FAIL/.test(l)).slice(0, 5);

  say(`probe: ${rel} · ${command}`);
  say(`  mutated → exit ${red.code}`);
  for (const l of fired) say(`    ${l.trim()}`);
  say(`  restored → exit ${green.code}`);
  if (red.code !== 0 && fired.length === 0) {
    say('warning: no failing check was named, and a run that stops before the suite — a build step, a module that fails to load — reads as red');
  }

  if (red.code === 0) {
    say(`✖ probe: the check passed WITH the mutation in place — it does not see ${rel}`);
    process.exitCode = 1;
    return;
  }
  if (green.code !== 0) {
    say('✖ probe: the check is red after the restore — the tree did not come back, or the check was already red');
    process.exitCode = 1;
    return;
  }
  say(`✔ probe: red with the mutation (exit ${red.code}), green without it — ${rel} via ${command}`);
}

try {
  await main();
} catch (e) {
  if (!(e instanceof Refusal)) throw e;
  say(`✖ ${e.message}`);
  process.exitCode = 2;
}

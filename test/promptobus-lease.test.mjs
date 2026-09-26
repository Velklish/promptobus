// `promptobus lease -- <command…>` on real processes: two measuring runs never overlap, and a holder
// killed with SIGKILL does not keep a waiter out. Run: npm test
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';

const SB = makeSandbox('promptobus-lease-');
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'promptobus.js');
const ROOT = path.join(SB, 'lease');
const lease = await import(path.join(here, '..', 'lib', 'lease.js'));

const ENV = { ...process.env, [lease.LEASE_DIR_VAR]: ROOT };

// One CLI run, with stderr collected and a promise for its end. Every run names a short --wait,
// so a broken lease fails its own check instead of holding the file to the watchdog.
function run(args, { waitFor = null, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, 'lease', ...args], { cwd: SB, env: { ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  let seen = null;
  const saw = new Promise((resolve) => { seen = resolve; });
  child.stderr.on('data', (d) => {
    err += d;
    if (waitFor && err.includes(waitFor)) seen();
  });
  child.stdout.resume();
  const done = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, err, ms: Date.now() - started }));
  });
  const started = Date.now();
  return { child, done, saw, err: () => err };
}

const until = async (cond, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => { setTimeout(r, 25); });
  }
  return true;
};

// A measuring command: stamps its entry, holds the machine, stamps its exit.
const STAMPS = path.join(SB, 'stamps.log');
const measure = (name) => ['node', '-e',
  `const f=${JSON.stringify(STAMPS)},fs=require('fs');fs.appendFileSync(f,'enter ${name} '+Date.now()+'\\n');`
  + `setTimeout(()=>{fs.appendFileSync(f,'exit ${name} '+Date.now()+'\\n')},600)`];

// A holder that sits until killed, writing its own pid so the orphan can be cleaned up.
const sitter = (pidFile) => ['node', '-e',
  `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},60000)`];
const orphans = [];
// The orphan holds this file's stdio pipes open, so it is killed as soon as its check is done.
const reap = (f) => {
  try { process.kill(Number(readFileSync(f, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
};
process.on('exit', () => { for (const f of orphans) reap(f); });

// Two participants of one task, both measuring, started in the same tick.
{
  const a = run(['--as', 'worker:a', '--task', 'lease-t1', '--wait', '30', '--', ...measure('a')]);
  const b = run(['--as', 'worker:b', '--task', 'lease-t1', '--wait', '30', '--', ...measure('b')]);
  const [ra, rb] = await Promise.all([a.done, b.done]);
  const spans = {};
  for (const line of readFileSync(STAMPS, 'utf8').trim().split('\n')) {
    const [what, who, at] = line.split(' ');
    (spans[who] ??= {})[what] = Number(at);
  }
  const [first, second] = Object.values(spans).sort((x, y) => x.enter - y.enter);
  check('two measuring runs of one task under the lease do not overlap: the second enters after the first exits',
    ra.code === 0 && rb.code === 0 && first && second && second.enter >= first.exit,
    JSON.stringify({ spans, codes: [ra.code, rb.code], stderr: [ra.err, rb.err] }));
  const waited = [ra, rb].find((r) => r.err.includes('waiting'));
  check('the one that waited printed who held the machine: address, task, command and since when',
    /machine lease is held by worker:[ab] \(task lease-t1\) · node -e .* · since \d{4}-\d\d-\d\dT.* · pid \d+ — waiting, up to 30 s/
      .test(waited?.err ?? ''),
    JSON.stringify([ra.err, rb.err]));
}

// Two approval branches start from one main tip. Only one publisher may touch its index at a time.
{
  const repo = path.join(SB, 'publication');
  mkdirSync(repo);
  const git = (...args) => spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  const mustGit = (...args) => {
    const r = git(...args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  mustGit('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, '.gitignore'), '.claude/worktrees/\n');
  writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  mustGit('add', '.');
  mustGit('commit', '-qm', 'base');
  const branch = (name) => {
    const at = path.join(repo, '.claude', 'worktrees', name);
    mustGit('worktree', 'add', '-q', '-b', `accept-${name}`, at, 'main');
    writeFileSync(path.join(at, `${name}.txt`), `${name}\n`);
    const r = spawnSync('git', ['-C', at, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    const committed = spawnSync('git', ['-C', at, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', name], { encoding: 'utf8' });
    if (committed.status !== 0) throw new Error(committed.stderr);
  };
  branch('a');
  branch('b');
  writeFileSync(path.join(repo, 'owner-untracked.txt'), 'owner bytes\n');
  const stamps = path.join(SB, 'publish-stamps.log');
  const result = (name) => path.join(SB, `publish-${name}.json`);
  const release = path.join(SB, 'release-publisher-a');
  const publisher = (name, releaseFile = null) => ['node', '-e', `
    const fs = require('fs'), cp = require('child_process');
    const repo = ${JSON.stringify(repo)}, name = ${JSON.stringify(name)};
    const stamp = (event) => fs.appendFileSync(${JSON.stringify(stamps)}, JSON.stringify({ name, event, at: Date.now() }) + ${JSON.stringify('\n')});
    const git = (...args) => cp.spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const state = () => ({
      head: git('rev-parse', 'HEAD').stdout.trim(),
      status: git('status', '--porcelain', '--untracked-files=all').stdout,
      index: fs.readFileSync(require('path').join(repo, '.git', 'index')).toString('base64'),
      tracked: fs.readFileSync(require('path').join(repo, 'base.txt'), 'utf8'),
      untracked: fs.readFileSync(require('path').join(repo, 'owner-untracked.txt'), 'utf8'),
    });
    stamp('enter');
    const publish = () => {
      const before = state();
      const merged = git('merge', '--ff-only', 'accept-' + name);
      const after = state();
      fs.writeFileSync(${JSON.stringify(result(name))}, JSON.stringify({ before, after, code: merged.status, stderr: merged.stderr }));
      stamp('exit');
      process.exitCode = merged.status ?? 1;
    };
    const releaseFile = ${JSON.stringify(releaseFile)};
    if (releaseFile) {
      const timer = setInterval(() => { if (fs.existsSync(releaseFile)) { clearInterval(timer); publish(); } }, 20);
    } else { publish(); }
  `];
  const a = run(['--as', 'approver:a', '--key', repo, '--wait', '30', '--', ...publisher('a', release)]);
  await until(() => existsSync(stamps));
  const alias = path.join(SB, 'publication-alias');
  symlinkSync(repo, alias);
  const b = run(['--as', 'approver:b', '--key', alias, '--wait', '30', '--', ...publisher('b')], { waitFor: 'waiting' });
  await b.saw;
  const otherRepo = path.join(SB, 'other-publication');
  mkdirSync(otherRepo);
  const otherMarker = path.join(SB, 'other-publisher.ran');
  const other = await run(['--as', 'approver:other', '--key', otherRepo, '--wait', '5', '--', 'node', '-e',
    `require('fs').writeFileSync(${JSON.stringify(otherMarker)}, '1')`]).done;
  check('a different clone key can publish while the first publisher is held',
    other.code === 0 && existsSync(otherMarker) && !readFileSync(stamps, 'utf8').includes('"event":"exit"'),
    JSON.stringify({ other, events: readFileSync(stamps, 'utf8') }));
  const machineA = run(['--as', 'worker:machine-a', '--wait', '10', '--', ...measure('within-a')]);
  const machineB = run(['--as', 'worker:machine-b', '--wait', '10', '--', ...measure('within-b')]);
  const machineResults = await Promise.all([machineA.done, machineB.done]);
  const machineSpans = {};
  for (const line of readFileSync(STAMPS, 'utf8').trim().split('\n')) {
    const [what, who, at] = line.split(' ');
    if (who.startsWith('within-')) (machineSpans[who] ??= {})[what] = Number(at);
  }
  const [machineFirst, machineSecond] = Object.values(machineSpans).sort((x, y) => x.enter - y.enter);
  check('machine holders still exclude each other while a keyed publisher holds the clone',
    machineResults.every((r) => r.code === 0) && machineSecond?.enter >= machineFirst?.exit
    && !readFileSync(stamps, 'utf8').includes('"event":"exit"'),
    JSON.stringify({ machineResults, machineSpans, events: readFileSync(stamps, 'utf8') }));
  writeFileSync(release, 'go');
  const [ra, rb] = await Promise.all([a.done, b.done]);
  const events = readFileSync(stamps, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const aExit = events.find((e) => e.name === 'a' && e.event === 'exit')?.at;
  const bEnter = events.find((e) => e.name === 'b' && e.event === 'enter')?.at;
  const refused = JSON.parse(readFileSync(result('b'), 'utf8'));
  check('two publishers keyed by the canonical clone root, including a symlink alias, do not overlap',
    ra.code === 0 && rb.code !== 0 && bEnter >= aExit && rb.err.includes('clone publication lease is held by approver:a'),
    JSON.stringify({ codes: [ra.code, rb.code], events, wait: rb.err }));
  check('a refused fast-forward under the clone lease leaves the clone index, tree and untracked bytes unchanged',
    refused.code !== 0 && JSON.stringify(refused.before) === JSON.stringify(refused.after)
    && refused.before.head === mustGit('rev-parse', 'accept-a')
    && refused.before.status === '?? owner-untracked.txt\n',
    JSON.stringify(refused));
  const missingMarker = path.join(SB, 'missing-key-command.ran');
  const missing = await run(['--key', path.join(SB, 'no-such-clone'), '--', 'node', '-e',
    `require('fs').writeFileSync(${JSON.stringify(missingMarker)}, '1')`]).done;
  check('a missing clone key refuses before running the publication command',
    missing.code === 1 && missing.err.includes('--key') && !existsSync(missingMarker),
    JSON.stringify(missing));
}

// A dead wrapper cannot free a clone lock while its exec'd publication command survives.
{
  const repo = path.join(SB, 'surviving-publication');
  mkdirSync(repo);
  const pidFile = path.join(SB, 'surviving-publisher.pid');
  const release = path.join(SB, 'release-survivor');
  const ran = path.join(SB, 'after-survivor.ran');
  orphans.push(pidFile);
  const survivor = ['node', '-e', `
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 20);
  `];
  const holder = run(['--as', 'approver:killed-wrapper', '--key', repo, '--wait', '10', '--', ...survivor]);
  await until(() => existsSync(pidFile));
  const commandPid = Number(readFileSync(pidFile, 'utf8'));
  holder.child.kill('SIGKILL');
  await holder.done;
  const held = lease.readLease(ROOT, repo).holder;
  const waiter = run(['--as', 'approver:after-kill', '--key', repo, '--wait', '10', '--', 'node', '-e',
    `require('fs').writeFileSync(${JSON.stringify(ran)}, '1')`]);
  await until(() => waiter.err().includes('waiting') || existsSync(ran), 5000);
  check('a keyed lease stays held by the surviving child after its wrapper is killed',
    held?.alive && held.childPid === commandPid && waiter.err().includes('waiting') && !existsSync(ran),
    JSON.stringify({ held, wait: waiter.err(), ran: existsSync(ran) }));
  writeFileSync(release, 'go');
  const next = await waiter.done;
  check('the next keyed publisher runs after the surviving child exits',
    next.code === 0 && existsSync(ran) && /^clone publication lease: free/.test(lease.leaseLines(ROOT, Date.now(), repo)[0]),
    JSON.stringify({ next, lines: lease.leaseLines(ROOT, Date.now(), repo) }));
}

// If the wrapper died before its child registered, automatic recovery has no safe proof.
{
  const repo = path.join(SB, 'ambiguous-publication');
  mkdirSync(repo);
  const scope = createHash('sha256').update(realpathSync(repo)).digest('hex');
  const lock = path.join(ROOT, 'keys', `${scope}.lock`);
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, 'owner'), `${JSON.stringify({ pid: 2 ** 22 + 12345, since: new Date().toISOString() })}\n`);
  const ran = path.join(SB, 'ambiguous-publisher.ran');
  const result = await run(['--as', 'approver:ambiguous', '--key', repo, '--wait', '1', '--', 'node', '-e',
    `require('fs').writeFileSync(${JSON.stringify(ran)}, '1')`]).done;
  check('a dead wrapper without a known child pid requires explicit recovery and runs no publisher',
    result.code === 1 && result.err.includes(lock) && result.err.includes('verify the publisher and child are dead')
    && !existsSync(ran) && existsSync(lock), JSON.stringify(result));
}

// A holder killed mid-measurement: the waiter proceeds by liveness, well inside its bound.
{
  const pidFile = path.join(SB, 'killed-child.pid');
  orphans.push(pidFile);
  const holder = run(['--as', 'worker:dies', '--task', 'lease-t1', '--wait', '30', '--', ...sitter(pidFile)]);
  await until(() => existsSync(pidFile));
  const ran = path.join(SB, 'after-kill.ran');
  const waiter = run(['--as', 'worker:next', '--task', 'lease-t1', '--wait', '30', '--',
    'node', '-e', `require('fs').writeFileSync(${JSON.stringify(ran)},'1')`], { waitFor: 'waiting' });
  await waiter.saw;
  const seen = lease.leaseLines(ROOT);
  check('status names the holder and the waiter while one waits on the other',
    /^machine lease: held by worker:dies \(task lease-t1\) · node -e .* · pid \d+$/.test(seen[0])
    && seen.length === 2 && /^machine lease: waiting — worker:next \(task lease-t1\) · node -e /.test(seen[1]),
    JSON.stringify(seen));
  holder.child.kill('SIGKILL');
  const r = await waiter.done;
  check('a holder killed with SIGKILL does not block the waiter: it runs its command, far inside its 30 s bound',
    r.code === 0 && existsSync(ran) && r.ms < 20_000,
    JSON.stringify({ code: r.code, ms: r.ms, err: r.err }));
  await holder.done;
  reap(pidFile);
  check('after both, the machine reads free and no waiter is left listed',
    /^machine lease: free/.test(lease.leaseLines(ROOT).join('\n')) && lease.leaseLines(ROOT).length === 1,
    JSON.stringify(lease.leaseLines(ROOT)));
}

// The bound: a live holder that outlasts it is named in the refusal, and nothing is run.
{
  const pidFile = path.join(SB, 'bound-child.pid');
  orphans.push(pidFile);
  const holder = run(['--as', 'worker:long', '--task', 'lease-t2', '--wait', '30', '--', ...sitter(pidFile)]);
  await until(() => existsSync(pidFile));
  const ran = path.join(SB, 'bound.ran');
  const r = await run(['--as', 'worker:short', '--wait', '1', '--',
    'node', '-e', `require('fs').writeFileSync(${JSON.stringify(ran)},'1')`]).done;
  check('past the bound the waiter fails with the holder\'s line and does not run its command',
    r.code === 1 && !existsSync(ran)
    && /machine lease is held by worker:long \(task lease-t2\) · .* — waited \d+ s, the bound; your command was not run/.test(r.err),
    JSON.stringify(r));
  holder.child.kill('SIGTERM');
  const h = await holder.done;
  check('a signal to the holder reaches its command, the wrapper exits with that command\'s code, and the lease is free',
    h.code === 143 && /^machine lease: free/.test(lease.leaseLines(ROOT)[0]),
    JSON.stringify({ h, lines: lease.leaseLines(ROOT) }));
}

// Exit code of the command, and a refusal with nothing to run.
{
  const r = await run(['--wait', '30', '--', 'node', '-e', 'process.exit(7)']).done;
  check('the wrapper exits with the command\'s own code', r.code === 7, JSON.stringify(r));
  const none = await run(['--as', 'worker:x']).done;
  check('no command is a refusal that shows the form', none.code === 1 && none.err.includes('lease: no command to run'),
    JSON.stringify(none));
}

// A waiter that meets a holder between its `mkdir` and its record names it once the record lands.
{
  const root = path.join(SB, 'early');
  const pidFile = path.join(SB, 'early-holder.pid');
  orphans.push(pidFile);
  const sleeper = spawn(process.execPath, ['-e',
    `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},60000)`], { stdio: 'ignore' });
  await until(() => existsSync(pidFile));
  const lock = path.join(root, 'machine.lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, 'owner'),
    `${JSON.stringify({ pid: sleeper.pid, session: null, since: new Date().toISOString() })}\n`);
  const child = spawn(process.execPath, [CLI, 'lease', '--as', 'worker:early', '--wait', '30', '--', 'node', '-e', ''],
    { cwd: SB, env: { ...ENV, [lease.LEASE_DIR_VAR]: root }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => { child.on('exit', (code) => resolve(code)); });
  await until(() => lease.readLease(root).waiters.length === 1);
  await new Promise((r) => { setTimeout(r, 600); });
  writeFileSync(path.join(lock, 'holder.json'),
    `${JSON.stringify({ address: 'worker:late', task: 'lease-t4', command: 'npm test' })}\n`);
  await until(() => err.includes('waiting'));
  rmSync(lock, { recursive: true, force: true });
  const code = await done;
  reap(pidFile);
  check('a holder caught before its record is written is named by the wait line once the record lands, not as a nameless caller',
    code === 0 && /^machine lease is held by worker:late \(task lease-t4\) · npm test · /.test(err) && !err.includes('named no address'),
    JSON.stringify({ code, err }));
}

// A lock left by a dead process reads as such in `status` until the next taker drops it.
{
  const root = path.join(SB, 'dead');
  mkdirSync(path.join(root, 'machine.lock'), { recursive: true });
  writeFileSync(path.join(root, 'machine.lock', 'owner'),
    `${JSON.stringify({ pid: 2 ** 22 + 12345, session: null, since: '2026-09-25T10:00:00.000Z' })}\n`);
  writeFileSync(path.join(root, 'machine.lock', 'holder.json'),
    `${JSON.stringify({ address: 'worker:gone', task: 'lease-t3', command: 'npm test' })}\n`);
  const lines = lease.leaseLines(root);
  check('status says a lock of a dead pid was left, names it, and does not call it held',
    /^machine lease: left by a dead process — worker:gone \(task lease-t3\) · npm test · since 2026-09-25T10:00:00.000Z/.test(lines[0]),
    JSON.stringify(lines));
}

// A lease directory this user does not own is refused before anything is created in it.
if (process.getuid?.() !== 0 && process.platform !== 'win32') {
  const marker = path.join(SB, 'foreign.ran');
  const foreign = await run(['--as', 'worker:x', '--wait', '5', '--', 'node', '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)},'1')`], { env: { [lease.LEASE_DIR_VAR]: '/' } }).done;
  check('a lease directory owned by another user is refused: nothing runs and nothing is created in it',
    foreign.code === 1 && !existsSync(marker) && /lease directory \/ belongs to uid 0, not to this user .* your command was not run/.test(foreign.err)
    && !existsSync('/machine.lock') && !existsSync('/waiters'),
    JSON.stringify(foreign));
  const target = path.join(SB, 'link-target');
  mkdirSync(target);
  const link = path.join(SB, 'link');
  symlinkSync(target, link);
  const linked = await run(['--wait', '5', '--', 'node', '-e', 'process.exit(0)'], { env: { [lease.LEASE_DIR_VAR]: link } }).done;
  check('a lease directory that is a symbolic link is refused, and nothing is created behind it',
    linked.code === 1 && linked.err.includes('is a symbolic link') && readdirSync(target).length === 0,
    JSON.stringify(linked));
}

// The default place is outside every store home and one per user of the machine.
{
  const env = { ...process.env };
  delete env[lease.LEASE_DIR_VAR];
  const root = lease.leaseRoot(env);
  check('without the override the lease lives in one machine-wide place per user, not in a store home',
    process.platform === 'win32' ? root.endsWith('promptobus-lease') : root === `/tmp/promptobus-${process.getuid()}`,
    root);
}

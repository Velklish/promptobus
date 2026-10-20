import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandGrantSchema } from '../.test-build/control-schema.js';

test('immutable execution command entries are admitted by the strict grant schema', () => {
  assert.doesNotThrow(() => commandGrantSchema.parse({ actor: 'orchestrator', task: 'task', token: 'grant', state: 'active', phase: 'tests',
    scope: { repository: '/tmp/owned', branch: 'main', base: 'a'.repeat(40), operations: ['local fixture'] }, preconditions: ['approved'],
    execution: { commands: [{ id: 'one', argv: [process.execPath, '-e', ''], cwd: '/tmp/owned', env: {}, output: '/tmp/owned/run',
      buildRoot: '/tmp/owned', tmpRoot: '/tmp/owned', cacheRoot: '/tmp/owned', exclusiveKeys: [], measurementScope: '/tmp/owned' }] } }));
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newTaskIdentity, openEngine } from 'promptobus';
import { publishControl, admitCommand, executionCommand, commandReference, commandTerminal } from '../.test-build/control.js';
import { engineOperation } from '../.test-build/engine-host.js';
import { launchFixture } from './evidence-fixture.mjs';
const runner = process.env.PB_COMMAND_RUNNER ?? fileURLToPath(new URL('../.test-build/command-runner.js', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 800; i++) { if (fn()) return; await pause(10); }
  assert.fail(`barrier not reached: ${label}`);
}
async function fixture(t, shared = null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-command-')));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init', '--quiet'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'Fixture');
  const sha = git('rev-parse', 'HEAD').toString().trim(), task = newTaskIdentity('command').id;
  const binding = { task, participant: 'orchestrator', role: 'orchestrator', projectId: 'project', environmentId: 'environment', environmentPath: root,
    hostId: 'local', providerId: 'codex', root, token: randomUUID(), threadId: null, phase: 'pending', parentThreadId: null,
    lifecycleOwnerThreadId: null, environmentOwner: 'existing', branch: 'main', baseSha: sha,
    launchContext: launchFixture(task, 'orchestrator', 'orchestrator', root) };
  binding.launchContext.grant.scope.base = sha;
  const reference = { directory: path.join(root, 'control'), owner: { task, participant: 'orchestrator', projectId: 'project', environmentId: 'environment', hostId: 'local', root }, readRoots: [root] };
  if (shared) reference.readRoots.push(shared);
  binding.launchContext.control = { mode: 'current', reference };
  publishControl({ reference, ownerConfirmed: true, STOP: false, noNewStages: false, grants: { orchestrator: binding.launchContext.grant } }, { initialize: true, expectedRevision: null });
  await engineOperation({ operation: 'reserve', binding, create: true, title: 'Actual local command fixture' });
  binding.threadId = 'thr-owner'; binding.phase = 'ready';
  await engineOperation({ operation: 'finalize', binding });
  const engine = openEngine({ root, recover: false, policy: () => ({ allow: true }) });
  const current = () => JSON.parse(fs.readFileSync(path.join(reference.directory, 'current.json'), 'utf8'));
  const update = patch => { const { format, revision, pendingCommands, ...previous } = current();
    return publishControl({ ...previous, ...patch }, { initialize: false, expectedRevision: revision, binding, denyOnly: false }); };
  const leases = shared ? path.join(shared, 'leases') : path.join(root, 'leases');
  fs.mkdirSync(leases, { recursive: true });
  const children = [], members = [];
  t.after(async () => {
    for (const member of members) fs.writeFileSync(member.release, 'fixture cleanup');
    for (const child of children) await child.done;
    if (process.env.PB_FIXTURE_EVIDENCE_DIR) {
      const destination = path.join(process.env.PB_FIXTURE_EVIDENCE_DIR, path.basename(root)); fs.mkdirSync(destination, { recursive: true });
      fs.cpSync(path.join(root, 'control'), path.join(destination, 'control'), { recursive: true });
      for (const member of members) {
        const directory = path.join(destination, member.binding.participant); fs.mkdirSync(directory);
        for (const file of ['input.json', 'entered', 'run.stdout.txt', 'run.stderr.txt', 'run.receipt.txt']) {
          if (fs.existsSync(path.join(member.directory, file))) fs.copyFileSync(path.join(member.directory, file), path.join(directory, file));
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  function member(actor, { key, scope = shared ?? root, code, exit = 0, omitEnv = [] } = {}) {
    const directory = path.join(root, actor); fs.mkdirSync(directory);
    const tmp = path.join(directory, 'tmp'), cache = path.join(directory, 'cache'), build = path.join(directory, 'build');
    for (const file of [tmp, cache, build]) fs.mkdirSync(file);
    const marker = path.join(directory, 'entered'), release = path.join(directory, 'release'), output = path.join(directory, 'run');
    const argv = [process.execPath, '-e', code ?? `const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({tmp:process.env.TMPDIR,cache:process.env.XDG_CACHE_HOME,cwd:process.cwd()}));const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);process.stdout.write('original stdout\\n');process.stderr.write('original assertion\\n');process.exitCode=${exit};}},10);`];
    const command = { id: 'run', argv, cwd: directory, env: { TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: cache, XDG_STATE_HOME: cache, XDG_DATA_HOME: cache, npm_config_cache: cache, NPM_CONFIG_CACHE: cache, npm_config_logs_dir: cache, NPM_CONFIG_LOGS_DIR: cache, PROMPTOBUS_LEASE_DIR: leases },
      output, buildRoot: build, tmpRoot: tmp, cacheRoot: cache, exclusiveKeys: key ? [key] : [build, tmp, cache], measurementScope: scope };
    for (const key of omitEnv) delete command.env[key];
    const b = structuredClone(binding); b.participant = actor; b.role = 'worker'; b.environmentId = `env-${actor}`; b.environmentPath = directory;
    b.launchContext.ownedRoots = [directory]; b.launchContext.readRoots = reference.readRoots;
    b.launchContext.grant = { ...b.launchContext.grant, actor, token: randomUUID(), phase: 'test', scope: { ...b.launchContext.grant.scope, repository: directory }, execution: { commands: [command] } };
    update({ grants: { ...current().grants, [actor]: b.launchContext.grant } });
    const input = path.join(directory, 'input.json'); fs.writeFileSync(input, JSON.stringify({ binding: b, commandId: 'run' }));
    const member = { binding: b, command, input, marker, release, output, directory }; members.push(member); return member;
  }
  function run(member, args = []) {
    const child = spawn(process.execPath, [...args, runner, '--admission', member.input, '--output', member.output, '--by', member.binding.participant, '--', ...member.command.argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    child.done = new Promise(resolve => child.on('close', (exit, signal) => resolve({ exit, signal, stdout, stderr })));
    children.push(child); return child;
  }
  const release = member => fs.writeFileSync(member.release, 'close');
  const entered = member => until(() => fs.existsSync(member.marker), member.binding.participant);
  const receipt = member => JSON.parse(fs.readFileSync(`${member.output}.receipt.txt`, 'utf8'));
  return { root, reference, current, update, engine, binding, member, run, release, entered, receipt, leases };
}

function setupFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-command-setup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository'), owned = path.join(root, 'owned'), leases = path.join(root, 'leases');
  for (const directory of [repository, owned, leases]) fs.mkdirSync(directory);
  const task = newTaskIdentity('setup').id, actor = 'worker', createdRoot = path.join(owned, 'new-owned');
  const launchContext = launchFixture(task, actor, 'worker', repository);
  launchContext.readRoots = [root]; launchContext.ownedRoots.push(owned, createdRoot);
  const marker = path.join(repository, 'entered'), output = path.join(createdRoot, 'evidence', 'run');
  const tmp = path.join(createdRoot, 'runtime', 'tmp'), cache = path.join(createdRoot, 'runtime', 'cache'), build = path.join(createdRoot, 'build');
  const command = { id: 'run', argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'unexpected execution')`],
    cwd: repository, env: { TMPDIR: tmp, TMP: tmp, TEMP: tmp, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: cache, XDG_STATE_HOME: cache,
      XDG_DATA_HOME: cache, npm_config_cache: cache, NPM_CONFIG_CACHE: cache, npm_config_logs_dir: cache, NPM_CONFIG_LOGS_DIR: cache, PROMPTOBUS_LEASE_DIR: leases },
    output, buildRoot: build, tmpRoot: tmp, cacheRoot: cache, exclusiveKeys: [build, tmp, cache], measurementScope: root };
  launchContext.grant.execution = { commands: [command] };
  const control = path.join(root, 'control');
  launchContext.control = { mode: 'current', reference: { directory: control,
    owner: { task, participant: 'orchestrator', projectId: 'project', environmentId: 'owner-environment', hostId: 'local', root: repository }, readRoots: [root] } };
  const binding = { task, participant: actor, role: 'worker', projectId: 'project', environmentId: 'environment', environmentPath: repository,
    hostId: 'local', providerId: 'codex', root: repository, token: randomUUID(), threadId: null, phase: 'pending',
    branch: 'main', baseSha: 'a'.repeat(40), launchContext };
  const input = path.join(repository, 'input.json');
  const write = () => fs.writeFileSync(input, JSON.stringify({ binding, commandId: command.id }));
  write();
  const run = async ({ preflight = true, inputFile = input, argv = command.argv, stem = command.output, by = actor } = {}) => {
    const child = spawn(process.execPath, [runner, ...(preflight ? ['--preflight'] : []), '--admission', inputFile, '--output', stem, '--by', by, '--', ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    return new Promise(resolve => child.on('close', (exit, signal) => resolve({ exit, signal, stdout, stderr })));
  };
  const untouched = () => {
    assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(control), false);
    assert.equal(fs.existsSync(path.join(repository, '.promptobus')), false); assert.deepEqual(fs.readdirSync(leases), []);
    for (const suffix of ['.stdout.txt', '.stderr.txt', '.receipt.txt']) assert.equal(fs.existsSync(`${output}${suffix}`), false);
  };
  return { root, repository, owned, leases, createdRoot, command, binding, input, marker, output, control, write, run, untouched };
}

test('setup preflight creates only declared directories before task admission without executing the command', async t => {
  const f = setupFixture(t);
  const result = await f.run(); assert.equal(result.exit, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.mode, 'preflight'); assert.equal(observation.observation, 'setup');
  assert.equal(observation.commandId, 'run'); assert.equal(observation.actor, 'worker');
  assert.match(observation.commandSha256, /^[a-f0-9]{64}$/); assert.equal(observation.substantiveCommandStarted, false);
  assert.deepEqual(observation.declaredTools, ['promptobus_send', 'promptobus_mailbox', 'promptobus_task', 'promptobus_artifact']);
  assert.deepEqual(observation.notChecked, ['dynamic-current-control', 'evidence-artifact-bytes', 'installed-tool-eligibility', 'execution-permissions']);
  assert.equal('ready' in observation, false); assert.equal('receipt' in observation, false); assert.equal('complete' in observation, false);
  const expected = [f.createdRoot, f.command.buildRoot, path.dirname(f.command.tmpRoot), f.command.tmpRoot, f.command.cacheRoot, path.dirname(f.output)].sort();
  assert.deepEqual([...observation.createdDirectories].sort(), expected);
  for (const directory of expected) {
    assert.equal(fs.realpathSync(directory), directory); assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
  f.untouched();
  const repeated = await f.run(); assert.equal(repeated.exit, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout).createdDirectories, []); f.untouched();
});

test('actual execution without setup refuses missing declared directories before command entry', async t => {
  const f = setupFixture(t), result = await f.run({ preflight: false });
  assert.equal(result.exit, 1); assert.match(result.stderr, /ENOENT/);
  assert.equal(fs.existsSync(f.createdRoot), false); f.untouched();
});

for (const mismatch of ['read-root', 'cwd', 'lease-root', 'measurement', 'environment', 'outside-root', 'symlink', 'missing-key', 'role', 'notRun', 'manifest', 'argv', 'actor', 'output']) {
  test(`setup preflight rejects ${mismatch} before creating any declared directory`, async t => {
    const f = setupFixture(t), options = {};
    if (mismatch === 'read-root') f.binding.launchContext.readRoots.push(path.join(f.root, 'missing-read'));
    if (mismatch === 'cwd') f.command.cwd = path.join(f.repository, 'missing-cwd');
    if (mismatch === 'lease-root') f.command.env.PROMPTOBUS_LEASE_DIR = path.join(f.root, 'missing-leases');
    if (mismatch === 'measurement') f.command.measurementScope = path.join(f.root, 'missing-measurement');
    if (mismatch === 'environment') f.command.env.TMP = f.root;
    if (mismatch === 'outside-root') f.command.output = path.join(f.root, 'unowned-output', 'run');
    if (mismatch === 'symlink') { fs.symlinkSync(f.repository, path.join(f.owned, 'alias'), 'dir'); f.command.output = path.join(f.owned, 'alias', 'nested', 'run'); }
    if (mismatch === 'missing-key') f.command.exclusiveKeys.push(path.join(f.owned, 'undeclared-key'));
    if (mismatch === 'role') f.binding.launchContext.role.literal = 'Unbound role';
    if (mismatch === 'notRun') delete f.binding.launchContext.preparation.reason;
    if (mismatch === 'manifest') f.binding.evidenceManifest = { version: 1 };
    if (mismatch === 'argv') options.argv = [...f.command.argv, 'changed'];
    if (mismatch === 'actor') options.by = 'another-worker';
    if (mismatch === 'output') options.stem = `${f.command.output}-changed`;
    f.write();
    const result = await f.run(options); assert.equal(result.exit, 1);
    assert.doesNotMatch(result.stderr, /usage:/, 'the production preflight must reject the actual bounded input');
    assert.equal(fs.existsSync(f.createdRoot), false); assert.equal(fs.existsSync(path.join(f.root, 'unowned-output')), false);
    assert.equal(fs.existsSync(path.join(f.repository, 'nested')), false); f.untouched();
  });
}

test('setup preflight cannot create an admission input parent or overwrite command receipt files', async t => {
  const f = setupFixture(t), missingInput = path.join(f.createdRoot, 'missing-input.json');
  const missing = await f.run({ inputFile: missingInput }); assert.equal(missing.exit, 1); assert.match(missing.stderr, /ENOENT/);
  assert.equal(fs.existsSync(f.createdRoot), false); f.untouched();
  fs.mkdirSync(path.dirname(f.output), { recursive: true });
  for (const suffix of ['.stdout.txt', '.stderr.txt', '.receipt.txt']) fs.writeFileSync(`${f.output}${suffix}`, 'original evidence');
  const result = await f.run(); assert.equal(result.exit, 0, result.stderr);
  for (const suffix of ['.stdout.txt', '.stderr.txt', '.receipt.txt']) assert.equal(fs.readFileSync(`${f.output}${suffix}`, 'utf8'), 'original evidence');
  assert.equal(fs.existsSync(f.marker), false); assert.equal(fs.existsSync(f.control), false); assert.deepEqual(fs.readdirSync(f.leases), []);
});

test('isolated actual children enter together without a global measurement lease and preserve exit 7', async t => {
  const f = await fixture(t), a = f.member('worker-a', { exit: 7 }), b = f.member('worker-b');
  const ac = f.run(a), bc = f.run(b); await Promise.all([f.entered(a), f.entered(b)]);
  assert.deepEqual(JSON.parse(fs.readFileSync(a.marker)), { tmp: a.command.tmpRoot, cache: a.command.cacheRoot, cwd: a.command.cwd });
  assert.equal(fs.existsSync(path.join(f.leases, 'lease.lock')), false);
  f.release(a); f.release(b);
  assert.equal((await ac.done).exit, 7); assert.equal((await bc.done).exit, 0);
  const receipt = f.receipt(a); assert.equal(receipt.exit, 7); assert.equal(receipt.complete, true);
  assert.equal(fs.readFileSync(`${a.output}.stderr.txt`, 'utf8'), 'original assertion\n');
  if (process.env.PB_COMMAND_RUNNER) {
    const generation = path.resolve(runner, '../..'), manifest = JSON.parse(fs.readFileSync(path.join(generation, 'dist/build-manifest.json')));
    assert.equal(receipt.launcher.buildIdentity.buildId, manifest.identity.buildId);
    assert.equal(receipt.launcher.sha256, manifest.artifacts['commands/command-runner.js']);
  }
  assert.equal(commandTerminal(f.reference, commandReference(a.binding, a.command)), true);
  assert.equal((await f.run(a).done).exit, 1, 'immutable entry is single use');
});

test('same canonical key serializes while a different key progresses; token revoked after wait refuses', async t => {
  const f = await fixture(t), key = path.join(f.root, 'shared'); fs.mkdirSync(key);
  const alias = path.join(f.root, 'shared-alias'); fs.symlinkSync(key, alias, 'dir');
  const a = f.member('worker-a', { key }), b = f.member('worker-b', { key: alias }), c = f.member('worker-c');
  const ac = f.run(a); await f.entered(a);
  const bc = f.run(b), cc = f.run(c); await f.entered(c);
  await until(() => fs.existsSync(path.join(f.leases, 'keys')) && fs.readdirSync(path.join(f.leases, 'keys')).length > 0, 'key held');
  const grants = { ...f.current().grants }; delete grants['worker-b']; f.update({ grants });
  f.release(a); f.release(c); assert.equal((await ac.done).exit, 0); assert.equal((await cc.done).exit, 0);
  const refused = await bc.done; assert.equal(refused.exit, 1, refused.stderr); assert.match(refused.stderr, /grant-mismatch|ended-token/);
  assert.equal(fs.existsSync(b.marker), false);
});

test('permission-delayed invocation reads revoked authority when the local launcher finally starts', async t => {
  const f = await fixture(t), delayed = f.member('worker-delayed'), independent = f.member('worker-independent');
  const other = f.run(independent); await f.entered(independent);
  const grants = { ...f.current().grants }; delete grants['worker-delayed']; f.update({ grants });
  const result = await f.run(delayed).done; assert.equal(result.exit, 1); assert.equal(fs.existsSync(delayed.marker), false);
  f.release(independent); assert.equal((await other.done).exit, 0);
});

test('active controlled cohort and unrelated scope enter together; draining and STOP deny later entry', async t => {
  const f = await fixture(t), otherScope = path.join(f.root, 'other'); fs.mkdirSync(otherScope);
  const a = f.member('worker-a'), b = f.member('worker-b'), c = f.member('worker-c', { scope: otherScope }), excluded = f.member('worker-excluded');
  const members = [a, b].map(m => ({ actor: m.binding.participant, token: m.binding.launchContext.grant.token, phase: 'test' }));
  const fence = { scope: f.root, cohort: 'measurement', state: 'draining', members, blockers: [] };
  f.update({ measurementFence: fence });
  assert.equal((await f.run(excluded).done).exit, 1); assert.equal(fs.existsSync(excluded.marker), false);
  f.update({ measurementFence: { ...fence, state: 'active' } });
  const ac = f.run(a), bc = f.run(b), cc = f.run(c); await Promise.all([f.entered(a), f.entered(b), f.entered(c)]);
  assert.throws(() => f.update({ measurementFence: undefined }), /measurement-busy/);
  const grants = { ...f.current().grants }; delete grants['worker-a'];
  f.update({ STOP: true, grants }); assert.equal(f.current().STOP, true);
  assert.equal(f.current().grants['worker-a'], undefined);
  assert.throws(() => f.update({ measurementFence: undefined }), /measurement-busy/);
  f.release(a); f.release(b); f.release(c); await Promise.all([ac.done, bc.done, cc.done]);
  f.update({ measurementFence: undefined }); assert.equal(f.current().measurementFence, undefined);
});

test('draining retains live and UNKNOWN blocker despite omission, token revocation and idle owner', async t => {
  const f = await fixture(t), a = f.member('worker-a'), cohort = f.member('worker-cohort');
  const ac = f.run(a); await f.entered(a);
  const fence = { scope: f.root, cohort: 'measure', state: 'draining', members: [{ actor: 'worker-cohort', token: cohort.binding.launchContext.grant.token, phase: 'test' }], blockers: [] };
  const grants = { ...f.current().grants }; delete grants['worker-a']; f.update({ grants, measurementFence: fence });
  assert.equal(f.current().measurementFence.blockers.length, 1);
  assert.throws(() => f.update({ measurementFence: { ...fence, state: 'active', blockers: [] } }), /measurement-busy/);
  f.release(a); assert.equal((await ac.done).exit, 0);
  fs.writeFileSync(`${a.output}.receipt.txt`, '{partial');
  assert.throws(() => f.update({ measurementFence: { ...fence, state: 'active', blockers: [] } }), /measurement-busy/);
  assert.throws(() => f.update({ measurementFence: undefined }), /measurement-busy/);
});

for (const change of ['STOP', 'phase', 'scope', 'inactive']) test(`${change} mismatch refuses before any actual child marker`, async t => {
  const f = await fixture(t), a = f.member('worker-a');
  if (change === 'STOP') f.update({ STOP: true });
  if (change === 'phase') { const altered = structuredClone(a.binding); altered.launchContext.grant.phase = 'later'; fs.writeFileSync(a.input, JSON.stringify({ binding: altered, commandId: 'run' })); }
  if (change === 'scope') { const altered = structuredClone(a.binding); altered.launchContext.grant.execution.commands[0].measurementScope = a.directory; fs.writeFileSync(a.input, JSON.stringify({ binding: altered, commandId: 'run' })); }
  if (change === 'inactive') f.engine.closeTask(f.binding.task);
  assert.equal((await f.run(a).done).exit, 1); assert.equal(fs.existsSync(a.marker), false);
});

test('cross-current-source shared resource retains unresolved receipt completion after child close', async t => {
  const shared = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-shared-resource-'))); t.after(() => fs.rmSync(shared, { recursive: true, force: true }));
  const key = path.join(shared, 'mutable'); fs.mkdirSync(key);
  const f = await fixture(t, shared), g = await fixture(t, shared), a = f.member('worker-a', { key }), b = g.member('worker-b', { key }), c = g.member('worker-c');
  const hook = path.join(f.root, 'fail-finalize.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to).includes('/calls/')&&fs.readFileSync(from,'utf8').includes('"terminal"'))throw new Error('fixture terminal write failure');return rename(from,to)};syncBuiltinESMExports();`);
  const ac = f.run(a, ['--import', hook]); await f.entered(a); f.release(a); const failed = await ac.done;
  assert.equal(f.receipt(a).complete, true); assert.equal(failed.exit, 1); assert.match(failed.stderr, /terminal write failure/);
  const bc = g.run(b), cc = g.run(c); await g.entered(c);
  const refused = await bc.done; assert.equal(refused.exit, 1); assert.match(refused.stderr, /unresolved admitted command/); assert.equal(fs.existsSync(b.marker), false);
  g.release(c); assert.equal((await cc.done).exit, 0);
});


test('admitted crash before PID handshake retains ambiguous resource ownership', async t => {
  const f = await fixture(t), key = path.join(f.root, 'shared'); fs.mkdirSync(key);
  const a = f.member('worker-a', { key }), b = f.member('worker-b', { key }), c = f.member('worker-c');
  const hook = path.join(f.root, 'die-before-spawn.mjs');
  fs.writeFileSync(hook, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawn;cp.spawn=(file,...args)=>{if(file==='/bin/sh')process.kill(process.pid,'SIGKILL');return spawn(file,...args)};syncBuiltinESMExports();`);
  const dead = await f.run(a, ['--import', hook]).done; assert.equal(dead.signal, 'SIGKILL'); assert.equal(fs.existsSync(a.marker), false);
  const bc = f.run(b), cc = f.run(c); await f.entered(c); const refused = await bc.done;
  assert.equal(refused.exit, 1); assert.match(refused.stderr, /no known child pid/); assert.equal(fs.existsSync(b.marker), false);
  f.release(c); assert.equal((await cc.done).exit, 0);
});

test('launcher crash after child PID handshake retains known live child and later UNKNOWN receipt', async t => {
  const f = await fixture(t), key = path.join(f.root, 'shared'); fs.mkdirSync(key);
  const a = f.member('worker-a', { key }), b = f.member('worker-b', { key }), c = f.member('worker-c');
  const ac = f.run(a); await f.entered(a); ac.kill('SIGKILL');
  const bc = f.run(b), cc = f.run(c); await f.entered(c); assert.equal(fs.existsSync(b.marker), false);
  f.release(a); const dead = await ac.done; assert.equal(dead.signal, 'SIGKILL');
  const refused = await bc.done; assert.equal(refused.exit, 1); assert.match(refused.stderr, /unresolved admitted command/); assert.equal(fs.existsSync(b.marker), false);
  f.release(c); assert.equal((await cc.done).exit, 0);
});


for (const name of ['NPM_CONFIG_CACHE', 'npm_config_cache', 'XDG_CONFIG_HOME', 'NPM_CONFIG_LOGS_DIR', 'PROMPTOBUS_LEASE_DIR']) {
  test(`immutable environment must explicitly pin ${name}`, async t => {
    const f = await fixture(t), a = f.member('worker-a', { code: "process.stdout.write('unexpected child')", omitEnv: [name] });
    const result = await f.run(a).done; assert.equal(result.exit, 1); assert.match(result.stderr, /exact environment/);
    assert.equal(fs.existsSync(`${a.output}.receipt.txt`), false);
  });
}

for (const mismatch of ['argv', 'output', 'cwd', 'env']) test(`exact immutable ${mismatch} mismatch refuses the actual invocation`, async t => {
  const f = await fixture(t), a = f.member('worker-a', { code: "process.stdout.write('unexpected child')" });
  if (mismatch === 'argv') a.command.argv.push('changed');
  if (mismatch === 'output') a.output += '-changed';
  if (mismatch === 'cwd' || mismatch === 'env') {
    const input = JSON.parse(fs.readFileSync(a.input)), command = input.binding.launchContext.grant.execution.commands[0];
    if (mismatch === 'cwd') command.cwd = f.root; else command.env.UNGRANTED = 'changed';
    fs.writeFileSync(a.input, JSON.stringify(input));
  }
  const result = await f.run(a).done; assert.equal(result.exit, 1); assert.equal(fs.existsSync(a.marker), false);
});


if (process.env.PB_COMMAND_RUNNER) test('immutable generation readback hashes every emitted module, captured toolchain and snapshot', () => {
  const generation = path.resolve(runner, '../..'), manifest = JSON.parse(fs.readFileSync(path.join(generation, 'dist/build-manifest.json')));
  const sha = value => createHash('sha256').update(value).digest('hex');
  const files = [];
  const visit = relative => {
    const file = path.join(generation, relative);
    if (fs.statSync(file).isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
    else files.push(relative.split(path.sep).join('/'));
  };
  for (const entry of manifest.snapshot.entries) visit(entry);
  files.sort();
  assert.equal(sha(JSON.stringify(files.map(file => [file, sha(fs.readFileSync(path.join(generation, file)))]))), manifest.snapshot.sha256);
  const emitted = files.filter(file => file.startsWith('commands/'));
  assert.ok(emitted.length > 1); assert.deepEqual(Object.keys(manifest.artifacts).filter(file => file.startsWith('commands/')).sort(), emitted);
  for (const file of emitted) assert.equal(sha(fs.readFileSync(path.join(generation, file))), manifest.artifacts[file]);
  assert.equal(manifest.commandLauncher, 'commands/command-runner.js');
  assert.equal(manifest.commandCompiler.find(compiler => compiler.name === 'typescript').version, '7.0.2');
  assert.deepEqual(manifest.commandCompiler, manifest.identity.inputs.commandCompiler);
  assert.ok(manifest.commandCompiler.some(compiler => compiler.name === `@typescript/typescript-${process.platform}-${process.arch}`));
});


test('resource claim directory symlink refuses before writing outside the immutable namespace', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.leases, 'command-resources'), 'dir');
  const a = f.member('worker-a', { code: "process.stdout.write('unexpected child')" });
  const result = await f.run(a).done; assert.equal(result.exit, 1); assert.match(result.stderr, /claim directory/);
  assert.deepEqual(fs.readdirSync(outside), []); assert.equal(fs.existsSync(`${a.output}.receipt.txt`), false);
});

test('outer lease cleanup failure preserves the collected executed receipt and exact exit 7', async t => {
  const f = await fixture(t), a = f.member('worker-a', { exit: 7 });
  const hook = path.join(f.root, 'fail-lease-release.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rm=fs.rmSync;let failed=false;fs.rmSync=(file,...args)=>{if(!failed&&String(file).startsWith(${JSON.stringify(path.join(f.leases, 'keys') + path.sep)})&&String(file).endsWith('.lock')&&fs.existsSync(${JSON.stringify(`${a.output}.receipt.txt`)})){failed=true;throw new Error('fixture outer lease cleanup failure')}return rm(file,...args)};syncBuiltinESMExports();`);
  const child = f.run(a, ['--import', hook]); await f.entered(a); f.release(a);
  const result = await child.done; assert.equal(result.exit, 1);
  const receipt = JSON.parse(result.stderr); assert.equal(receipt.notRun, false); assert.equal(receipt.exit, 7); assert.equal(receipt.signal, null);
  assert.equal(receipt.finalizationComplete, false); assert.equal(receipt.admission.commandId, 'run');
  assert.equal(receipt.launcher.sha256, f.receipt(a).launcher.sha256);
  assert.equal(f.receipt(a).exit, 7); assert.equal(f.receipt(a).complete, true);
});

for (const fault of ['control-release', 'raw-read', 'receipt-write', 'receipt-close']) {
  test(`executed ${fault} finalization failure keeps exact exit 7 and unresolved concrete resource`, async t => {
    const f = await fixture(t), key = path.join(f.root, 'shared'); fs.mkdirSync(key);
    const a = f.member('worker-a', { key, exit: 7 }), b = f.member('worker-b', { key }), c = f.member('worker-c');
    const hook = path.join(f.root, 'fail-finalization.mjs');
    fs.writeFileSync(hook, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const fault=${JSON.stringify(fault)},stem=${JSON.stringify(a.output)},control=${JSON.stringify(path.join(f.reference.directory, '.lock'))};const original={open:fs.openSync,read:fs.readFileSync,write:fs.writeFileSync,close:fs.closeSync,rm:fs.rmSync};let receiptFd,failed=false;
fs.openSync=(file,...args)=>{const fd=original.open(file,...args);if(String(file)===stem+'.receipt.txt')receiptFd=fd;return fd};
fs.readFileSync=(file,...args)=>{if(fault==='raw-read'&&String(file)===stem+'.stdout.txt'&&!failed){failed=true;throw new Error('fixture '+fault+' failure')}return original.read(file,...args)};
fs.writeFileSync=(file,...args)=>{if(fault==='receipt-write'&&file===receiptFd&&!failed){failed=true;throw new Error('fixture '+fault+' failure')}return original.write(file,...args)};
fs.closeSync=fd=>{if(fault==='receipt-close'&&fd===receiptFd&&!failed){failed=true;original.close(fd);throw new Error('fixture '+fault+' failure')}return original.close(fd)};
fs.rmSync=(file,...args)=>{if(fault==='control-release'&&String(file)===control&&!failed){failed=true;throw new Error('fixture '+fault+' failure')}return original.rm(file,...args)};syncBuiltinESMExports();`);
    const child = f.run(a, ['--import', hook]); await f.entered(a); f.release(a);
    const result = await child.done; assert.equal(result.exit, 1);
    const receipt = JSON.parse(result.stderr); assert.equal(receipt.notRun, false); assert.equal(receipt.exit, 7); assert.equal(receipt.signal, null);
    assert.equal(receipt.finalizationComplete, false); assert.equal(receipt.admission.commandId, 'run'); assert.ok(receipt.launcher.sha256);
    assert.equal(commandTerminal(f.reference, commandReference(a.binding, a.command)), false);
    const competing = f.run(b), independent = f.run(c); await f.entered(c);
    const refused = await competing.done; assert.equal(refused.exit, 1); assert.match(refused.stderr, /unresolved admitted command/); assert.equal(fs.existsSync(b.marker), false);
    f.release(c); assert.equal((await independent.done).exit, 0);
  });
}

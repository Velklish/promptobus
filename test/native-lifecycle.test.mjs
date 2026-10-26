import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { makeSandbox, stubCommand, writeHostConfig } from './sandbox.mjs';
import { spawnSync } from 'node:child_process';
import { spawn as spawnParticipant } from '../lib/spawn.js';
import { expectFail, quiet } from './console.mjs';
import { hostOf } from '../lib/host.js';
import { done } from '../lib/done.js';
import * as store from '../lib/store.js';
import { openEngine, openParticipant } from '../dist/index.js';
import { REGISTRY } from '../lib/drivers.js';
import { codexDriver } from '../lib/driver-codex.js';
import { commandReceipts, readStopConfirmation } from '../lib/codex-command-receipts.js';
import { sessionFile, sessionKey, writeSession } from '../lib/codex-session.js';
import { persistNativeParticipant, reserveNativeParticipant, retainNativeStop } from '../lib/native-lifecycle.js';
import { bindBeforeLaunch } from '../lib/liftoff.js';

process.env.CLAUDE_CODE_SESSION_ID = 'lifecycle-owner';
process.env.PROMPTOBUS_WARDEN = 'off';
let sequence = 0;
function fixture() {
  const root = makeSandbox('promptobus-lifecycle-');
  writeHostConfig(root, { tools: ['codex'] });
  const host = hostOf(root), home = host.promptobusHome();
  process.env.PROMPTOBUS_CODEX_HOME = path.join(root, 'native');
  const task = 'lifecycle-t20261024-' + String(++sequence).padStart(6, '0');
  store.createTask(home, { id: task, title: 'Native lifecycle', owner: 'lifecycle-owner' });
  return { root, host, home, task };
}
const participant = () => store.participantRecord('worker:one', {
  harness: 'codex', mode: 'managed', sessionRef: 'lifecycle-ref', sessionId: 'actual-thread',
});

async function terminalFixture() {
  const f = fixture();
  const p = participant();
  const { record: reserved } = openParticipant(f.home, f.task, p, REGISTRY, { assignment: true });
  const record = { ref: p.sessionRef, home: f.home, task: f.task, address: 'worker:one',
    launchId: 'terminal-launch', threadId: 'actual-thread', holderPid: 2147483646, appPid: 2147483645,
    stopConfirmed: true, state: 'dead' };
  const receiptFile = path.join(process.env.PROMPTOBUS_CODEX_HOME, 'receipts', sessionKey(record.ref), sessionKey(record.launchId) + '.jsonl');
  const receipts = commandReceipts(receiptFile, { format: 1, ...record });
  const deadlineAt = Date.now() + 5000;
  receipts.append('stop/requested', { threadId: record.threadId, deadlineAt });
  receipts.append('app-server/close', { code: 0, signal: null });
  receipts.append('stop/confirmed', { ...record, commands: [], appClose: { code: 0, signal: null }, deadlineAt, originalToolReceipt: 'not synthesized' });
  writeSession({ ...record, commandReceiptFile: receiptFile });
  const stopped = await codexDriver.stop(record.ref);
  assert.equal(stopped.stopped, true, JSON.stringify(stopped));
  assert.equal(existsSync(sessionFile(record.ref)), false);
  const retained = store.participantOf(store.readTask(f.home, f.task), 'worker:one').metadata.nativeStop;
  assert.equal(retained?.launchId, record.launchId, 'Stop must project terminal evidence before dropping the record');
  return { ...f, reserved, receiptFile, record };
}

test('confirmed native Stop retains exact proof for idle done and unchanged repeat', async () => {
  const f = await terminalFixture();
  const { reserved, receiptFile } = f;
  for (const field of ['task', 'address']) {
    assert.equal(readStopConfirmation(receiptFile, { ...f.record, [field]: 'foreign' }).ok, false,
      'terminal receipt cannot be borrowed across ' + field);
  }
  assert.throws(() => persistNativeParticipant(f.home, f.task, reserved, { sessionId: 'late' }), /unresolved/,
    'late launch callback cannot overwrite a confirmed Stop');
  const sentinel = path.join(f.root, 'foreign-sentinel');
  writeFileSync(sentinel, 'foreign');
  await quiet(() => close(f));
  const file = path.join(f.home, 'tasks', f.task, 'task.json'), first = readFileSync(file);
  await quiet(() => close(f));
  assert.deepEqual(readFileSync(file), first);
  assert.equal(readFileSync(sentinel, 'utf8'), 'foreign');
  assert.equal(existsSync(receiptFile), true);
});
const noSessions = () => ({});
const close = f => done(f.host, { task: f.task, 'keep-sessions': true, snapshot: noSessions,
  adapterFor: () => ({ probe: () => ({ available: 'unknown' }) }) });

for (const state of ['unresolved', 'unknown']) {
  test('native done refuses ' + state + ' before canonical mutation', async () => {
    const f = fixture();
    const record = participant();
    if (state === 'unknown') record.sessionRef = null;
    store.upsertParticipant(f.home, f.task, record);
    const file = path.join(f.home, 'tasks', f.task, 'task.json');
    const before = readFileSync(file);
    const patch = path.join(f.root, 'dirty-patch.txt');
    writeFileSync(patch, 'retained patch');
    const refusal = await expectFail(() => close(f));
    assert.deepEqual(readFileSync(file), before, 'native done must not change task bytes before terminal proof');
    assert.equal(refusal.failed, true, 'native done must refuse missing or unknown terminal evidence');
    assert.equal(readFileSync(patch, 'utf8'), 'retained patch');
  });
}

test('canonical repeat close preserves first stamps and bytes', () => {
  const root = makeSandbox('promptobus-close-repeat-');
  let tick = 0;
  const engine = openEngine({ root, policy: () => ({ allow: true }), recover: false,
    now: () => new Date(1700000000000 + ++tick * 1000) });
  const f = fixture();
  const owner = store.readTask(f.home, f.task).participants[0];
  engine.createTask({ id: 'repeat', title: 'Repeat', owner });
  engine.closeTask('repeat', { adapter: { closed: 'first' } });
  const file = engine.taskFile('repeat');
  const first = readFileSync(file);
  engine.closeTask('repeat', { adapter: { closed: 'second' } });
  assert.deepEqual(readFileSync(file), first, 'repeat close must not rewrite closed or updated');
});

test('close wins before native assignment: no participant is reserved', () => {
  const f = fixture();
  store.closeTask(f.home, f.task);
  const file = path.join(f.home, 'tasks', f.task, 'task.json');
  const before = readFileSync(file);
  assert.throws(() => openParticipant(f.home, f.task, participant(), REGISTRY, { assignment: true }), /closed/);
  assert.deepEqual(readFileSync(file), before);
});

test('native reservation wins before close: task and reservation stay active', async () => {
  const f = fixture();
  const { record } = openParticipant(f.home, f.task, participant(), REGISTRY, { assignment: true });
  assert.ok(record.metadata.assignmentAfterId);
  const file = path.join(f.home, 'tasks', f.task, 'task.json');
  const before = readFileSync(file);
  const refusal = await expectFail(() => close(f));
  assert.equal(refusal.failed, true, 'pending native reservation must block canonical close');
  assert.deepEqual(readFileSync(file), before);
});

test('repeat native CLI done does not sweep a second time', async () => {
  const f = fixture();
  store.upsertParticipant(f.home, f.task, { ...participant(), mode: 'attached', sessionRef: null });
  store.closeTask(f.home, f.task);
  const file = path.join(f.home, 'tasks', f.task, 'task.json');
  const before = readFileSync(file);
  const wake = store.wakeFile(f.home, f.task, 'orchestrator');
  mkdirSync(path.dirname(wake), { recursive: true });
  writeFileSync(wake, 'retained repeat sentinel');
  await quiet(() => close(f));
  assert.deepEqual(readFileSync(file), before);
  assert.equal(existsSync(wake), true, 'repeat close must not run another cleanup pass');
});

for (const winner of ['close', 'reservation']) {
  test(winner + ' wins before native spawn resource mutation', async () => {
    const f = fixture(), repo = path.join(f.root, 'fixture');
    mkdirSync(repo);
    for (const args of [['init', '-q', '-b', 'main'], ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-q', '--allow-empty', '-m', 'base']]) {
      const git = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      assert.equal(git.status, 0, git.stderr);
    }
    writeFileSync(path.join(repo, 'AGENTS.md'), 'Read-only fixture rules.\n');
    const brief = path.join(f.root, 'brief.md');
    writeFileSync(brief, 'Do not execute model work.\n');
    const bin = path.join(f.root, 'bin');
    stubCommand(bin, 'codex', "process.stdout.write('codex-cli 0.163.0\\n');");
    let closeAttempt, resources = 0;
    const host = { ...f.host, resolveRepo: async () => ({ nsPath: 'fixture', via: 'fixture' }),
      repoAbsPath: () => repo, isClone: () => true,
      freshenRepo: () => {
        resources++;
        if (winner === 'reservation') closeAttempt = expectFail(() => close(f));
        throw new Error('fixture resource boundary');
      },
    };
    const tool = { ok: true, bin: path.join(bin, 'codex'), source: 'fixture' };
    Object.defineProperty(tool, 'version', { enumerable: true, get() {
      if (winner === 'close' && !closeAttempt) closeAttempt = expectFail(() => close(f));
      return '0.163.0';
    } });
    const launch = await expectFail(() => spawnParticipant(host, {
      repo: 'fixture', task: f.task, worker: 'one', brief, harness: 'codex', tool,
    }));
    assert.equal(launch.failed, true, 'fixture stops before any model/holder launch');
    assert.ok(closeAttempt, launch.out);
    const outcome = await closeAttempt;
    assert.equal(outcome.failed, winner === 'reservation', outcome.out);
    assert.equal(resources, winner === 'close' ? 0 : 1, 'close winner forbids first resource callback');
    assert.equal(store.readTask(f.home, f.task).status, winner === 'close' ? 'done' : 'active');
  });
}
test('mail assignment changes neither launch admission nor retained terminal proof', async () => {
  const f = await terminalFixture();
  const previous = store.participantOf(store.readTask(f.home, f.task), 'worker:one');
  store.sendMessage(f.home, f.task, { from: 'orchestrator', to: 'worker:one',
    type: 'task', body: 'Late mail stays queued', session: 'lifecycle-owner' });
  const current = store.participantOf(store.readTask(f.home, f.task), 'worker:one');
  assert.notEqual(current.metadata.assignmentAfterId, previous.metadata.assignmentAfterId);
  assert.equal(current.metadata.nativeLaunchId, previous.metadata.nativeLaunchId);
  const { record } = reserveNativeParticipant(f.home, f.task, participant(), current, REGISTRY);
  assert.notEqual(record.metadata.nativeLaunchId, previous.metadata.nativeLaunchId);
  assert.equal(record.metadata.nativeStop, undefined);
  assert.equal(existsSync(f.receiptFile), true);
  const before = record.metadata.assignmentAfterId;
  store.sendMessage(f.home, f.task, { from: 'orchestrator', to: 'worker:one',
    type: 'task', body: 'Mail during launch', session: 'lifecycle-owner' });
  persistNativeParticipant(f.home, f.task, record, { sessionId: 'new-thread' });
  const bound = store.participantOf(store.readTask(f.home, f.task), 'worker:one');
  assert.notEqual(bound.metadata.assignmentAfterId, before);
  assert.equal(bound.metadata.sessionId, 'new-thread');
  assert.equal(bound.metadata.nativeLaunchId, record.metadata.nativeLaunchId);
});

for (const changed of ['generation', 'terminal-proof']) {
  test('failed native launch undo preserves newer ' + changed, () => {
    const f = fixture();
    const { record } = reserveNativeParticipant(f.home, f.task, participant(), undefined, REGISTRY);
    const undo = bindBeforeLaunch(f.home, f.task, 'worker:one', { sessionId: 'pending-thread', sessionRecord: 'stable-pointer' }, record);
    const current = store.participantOf(store.readTask(f.home, f.task), 'worker:one');
    store.upsertParticipant(f.home, f.task, { ...current, metadata: { ...current.metadata,
      ...(changed === 'generation' ? { nativeLaunchId: record.metadata.nativeLaunchId + '-new' }
        : { nativeStop: { launchId: record.metadata.nativeLaunchId } }),
    } });
    const file = path.join(f.home, 'tasks', f.task, 'task.json'), before = readFileSync(file);
    undo();
    assert.deepEqual(readFileSync(file), before, 'late native undo must preserve the current binding and terminal evidence');
  });
}

for (const damage of ['hash', 'binding', 'unreadable-registry', 'owned-unbound-call']) {
  test('native done refuses ' + damage + ' after retained Stop', async () => {
    const f = await terminalFixture();
    if (damage === 'hash') {
      const rows = readFileSync(f.receiptFile, 'utf8').trim().split('\n').map(JSON.parse);
      rows.at(-1).auditNote = 'valid receipt with changed bytes';
      writeFileSync(f.receiptFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      assert.equal(readStopConfirmation(f.receiptFile, f.record).ok, true, 'digest check must catch a structurally valid change');
    }
    if (damage === 'binding') {
      const p = store.participantOf(store.readTask(f.home, f.task), 'worker:one');
      store.upsertParticipant(f.home, f.task, { ...p, metadata: { ...p.metadata, sessionId: 'another-thread' } });
    }
    if (damage === 'unreadable-registry') {
      const dir = path.dirname(sessionFile(f.record.ref));
      rmSync(dir, { recursive: true, force: true });
      writeFileSync(dir, 'not a directory');
    }
    if (damage === 'owned-unbound-call') writeSession({ ref: 'unbound-ref', home: f.home, task: f.task, address: 'orchestrator', launchId: 'unknown' });
    const file = path.join(f.home, 'tasks', f.task, 'task.json'), before = readFileSync(file);
    const refusal = await expectFail(() => close(f));
    assert.equal(refusal.failed, true, 'unresolved native evidence must block done');
    assert.deepEqual(readFileSync(file), before);
  });
}

test('native retirement task lock stays within the Stop budget', async () => {
  const f = await terminalFixture();
  writeSession({ ...f.record, commandReceiptFile: f.receiptFile });
  const file = path.join(f.home, 'tasks', f.task, 'task.json'), before = readFileSync(file);
  const lock = path.join(path.dirname(file), '.lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, session: 'fixture-busy', since: new Date().toISOString() }));
  try {
    const started = Date.now();
    const result = await codexDriver.stop(f.record.ref, { timeoutMs: 40 });
    const elapsed = Date.now() - started;
    assert.equal(result.stopped, false);
    assert.ok(elapsed < 500, 'task lock must consume only the remaining Stop budget; elapsed=' + elapsed);
    assert.equal(existsSync(sessionFile(f.record.ref)), true);
    assert.deepEqual(readFileSync(file), before);
  } finally { rmSync(lock, { recursive: true, force: true }); }
});

for (const identity of [undefined, 42, 'stale-launch']) {
  test('native done refuses invalid launch identity ' + identity, async () => {
    const f = await terminalFixture();
    const p = store.participantOf(store.readTask(f.home, f.task), 'worker:one');
    store.upsertParticipant(f.home, f.task, { ...p, metadata: { ...p.metadata, nativeLaunchId: identity } });
    const file = path.join(f.home, 'tasks', f.task, 'task.json'), before = readFileSync(file);
    assert.equal((await expectFail(() => close(f))).failed, true);
    assert.deepEqual(readFileSync(file), before);
  });
}

test('whole metadata replacement cannot borrow terminal proof over an owned launch', async () => {
  const f = await terminalFixture();
  const old = store.participantOf(store.readTask(f.home, f.task), 'worker:one');
  const { record } = reserveNativeParticipant(f.home, f.task, participant(), old, REGISTRY);
  writeSession({ ...f.record, launchId: record.metadata.nativeLaunchId, state: 'starting', stopConfirmed: false });
  assert.throws(() => store.withTaskLock(f.home, f.task, () => retainNativeStop(f.record, f.receiptFile)), /unresolved/);
  assert.throws(() => persistNativeParticipant(f.home, f.task, old, { sessionId: 'old-callback' }), /unresolved/);
  store.upsertParticipant(f.home, f.task, { ...record, metadata: { ...old.metadata } });
  const file = path.join(f.home, 'tasks', f.task, 'task.json'), before = readFileSync(file);
  assert.equal((await expectFail(() => close(f))).failed, true);
  assert.deepEqual(readFileSync(file), before);
});

test('idle native done retains an actual dirty worktree and foreign sentinel', async () => {
  const f = await terminalFixture(), repo = path.join(f.root, 'repo'), worktree = path.join(f.root, 'worktree');
  mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  git(['init', '-q', '-b', 'main']);
  writeFileSync(path.join(repo, 'patch.txt'), 'base\n');
  git(['add', 'patch.txt']);
  git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-qm', 'base']);
  git(['worktree', 'add', '-qb', 'pb-native-fixture', worktree]);
  writeFileSync(path.join(worktree, 'patch.txt'), 'dirty patch\n');
  const sentinel = path.join(repo, 'foreign-sentinel');
  writeFileSync(sentinel, 'foreign\n');
  const p = store.participantOf(store.readTask(f.home, f.task), 'worker:one');
  store.upsertParticipant(f.home, f.task, { ...p, metadata: { ...p.metadata, repoAbs: repo, worktree } });
  const before = git(['diff'], worktree);
  await quiet(() => close({ ...f, host: { ...f.host, defaultBranch: () => 'main' } }));
  assert.equal(store.readTask(f.home, f.task).status, 'done');
  assert.equal(git(['diff'], worktree), before);
  assert.equal(readFileSync(sentinel, 'utf8'), 'foreign\n');
  assert.equal(readFileSync(path.join(worktree, 'patch.txt'), 'utf8'), 'dirty patch\n');
});

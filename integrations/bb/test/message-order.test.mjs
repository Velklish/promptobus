import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { newTaskIdentity, openEngine } from 'promptobus';
import { requireStepResults } from '../../../lib/review.js';
import { publishControl } from '../.test-build/control.js';
import { engineOperation } from '../.test-build/engine-host.js';
import { launchFixture } from './evidence-fixture.mjs';

const pipeline = { pipeline: () => [
  { name: 'worker', kind: 'edits-tree' },
  { name: 'reviewer', kind: 'reads-diff' },
  { name: 'approver', kind: 'writes-main-tree' },
] };

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-bb-message-order-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const task = newTaskIdentity('bb-order').id;
  const owner = { task, participant: 'orchestrator', role: 'orchestrator', projectId: 'project',
    environmentId: 'environment', environmentPath: root, hostId: 'local', providerId: 'codex', root,
    token: randomUUID(), threadId: null, phase: 'pending', parentThreadId: null,
    lifecycleOwnerThreadId: null, environmentOwner: 'existing', branch: 'main', baseSha: 'a'.repeat(40),
    launchContext: launchFixture(task, 'orchestrator', 'orchestrator', root) };
  const reference = { directory: path.join(root, 'control'), owner: { task, participant: 'orchestrator',
    projectId: owner.projectId, environmentId: owner.environmentId, hostId: owner.hostId, root }, readRoots: [root] };
  owner.launchContext.control = { mode: 'current', reference };
  publishControl({ reference, ownerConfirmed: true, STOP: false, noNewStages: false,
    grants: { orchestrator: structuredClone(owner.launchContext.grant) } },
  { initialize: true, expectedRevision: null });
  const reserve = async (binding, create = false) => {
    await engineOperation({ operation: 'reserve', binding, create, title: 'Message order fixture' });
    binding.threadId = `thr-${binding.participant}`;
    binding.phase = 'ready';
    await engineOperation({ operation: 'finalize', binding });
    return binding;
  };
  await reserve(owner, true);
  const bindings = { orchestrator: owner };
  for (const role of ['worker', 'reviewer', 'approver', 'reporter']) {
    const binding = { ...owner, participant: role, role, token: randomUUID(), threadId: null,
      phase: 'pending', parentThreadId: owner.threadId, lifecycleOwnerThreadId: owner.threadId,
      ...(role === 'approver' ? { predecessors: { worker: 'worker', reviewer: 'reviewer' } } : {}),
      launchContext: launchFixture(task, role, role, root) };
    binding.launchContext.control = { mode: 'current', reference };
    bindings[role] = await reserve(binding);
  }
  let at = new Date('2099-01-01T00:00:00.000Z');
  const engine = openEngine({ root, recover: false, policy: () => ({ allow: true }), now: () => at });
  const send = (from, type = 'result', to = 'orchestrator', body = `${from} ${type}`) =>
    engine.sendSync(task, { from, to: [to], type, body }).message;
  const pending = role => engineOperation({ operation: 'pending', binding: bindings[role] });
  const step = (binding = owner) => engineOperation({ operation: 'step', binding, worker: 'worker', reviewer: 'reviewer' });
  const gate = input => requireStepResults(pipeline, input);
  const participant = role => engine.readTask(task).participants.find(p => p.id === role);
  return { root, task, engine, bindings, send, pending, step, gate, participant,
    set at(value) { at = new Date(value); } };
}

test('reserve/finalize records initial worker, reviewer and approver fences without fake messages', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.engine.facts(f.task).messages, []);
  for (const role of ['worker', 'reviewer', 'approver']) {
    const participant = f.participant(role);
    assert.match(participant.metadata.assignmentAfterId, /^\d{8}T\d{9}-\d{4}-[a-f0-9]{6}$/);
    assert.equal(participant.sessionRef, f.bindings[role].threadId);
    assert.equal((await f.pending(role)).obligation, participant.metadata.assignmentAfterId);
    assert.equal(fs.existsSync(path.join(f.engine.home, 'tasks', f.task, 'messages', `${participant.metadata.assignmentAfterId}.json`)), false);
  }
  assert.equal((await f.pending('orchestrator')).obligation, null);
  assert.equal((await f.pending('reporter')).obligation, null);
});

for (const role of ['worker', 'reviewer', 'approver']) for (const type of ['result', 'review']) {
  test(`${role} pending settles with ${type} across rollback and the latest canonical task reopens it`, async t => {
    const f = await fixture(t);
    const initial = f.participant(role).metadata.assignmentAfterId;
    f.at = '2000-01-01T00:00:00.000Z';
    const result = f.send(role, type);
    assert.ok(result.ts < f.participant(role).metadata.bb.assignedAt);
    assert.ok(result.id > initial);
    assert.equal((await f.pending(role)).obligation, null);
    f.at = '1999-01-01T00:00:00.000Z';
    const assignment = f.send('orchestrator', 'task', role, 'new canonical assignment');
    assert.ok(assignment.ts < result.ts && assignment.id > result.id);
    assert.equal((await f.pending(role)).obligation, assignment.id);
    f.at = '1998-01-01T00:00:00.000Z';
    const settled = f.send(role, type);
    assert.ok(settled.ts < assignment.ts && settled.id > assignment.id);
    assert.equal((await f.pending(role)).obligation, null);
  });
}

test('fresh internal assignment fences the previous result without inventing a task message', async t => {
  const f = await fixture(t);
  const canonical = f.send('orchestrator', 'task', 'worker', 'earlier canonical assignment');
  const previous = f.send('worker');
  assert.equal((await f.pending('worker')).obligation, null);
  const before = f.engine.facts(f.task).messages.map(m => m.id);
  const assigned = await engineOperation({ operation: 'assignment', binding: f.bindings.worker });
  assert.ok(assigned.assignmentAfterId > previous.id && assigned.assignmentAfterId > canonical.id);
  assert.deepEqual(f.engine.facts(f.task).messages.map(m => m.id), before);
  assert.equal((await f.pending('worker')).obligation, assigned.assignmentAfterId);
  assert.equal(f.participant('worker').sessionRef, f.bindings.worker.threadId);
  f.at = '1999-01-01T00:00:00.000Z';
  const current = f.send('worker');
  assert.ok(current.id > assigned.assignmentAfterId && current.ts < previous.ts);
  assert.equal((await f.pending('worker')).obligation, null);
});

test('step joins canonical worker/reviewer results to the exact BB subject under rollback', async t => {
  const f = await fixture(t);
  f.send('orchestrator', 'task', 'worker', 'earlier worker assignment');
  f.send('orchestrator', 'task', 'reviewer', 'earlier reviewer assignment');
  f.send('worker');
  f.send('reviewer');
  f.at = '2000-01-01T00:00:00.000Z';
  const workerFence = await engineOperation({ operation: 'assignment', binding: f.bindings.worker });
  const reviewerFence = await engineOperation({ operation: 'assignment', binding: f.bindings.reviewer });
  const stale = await f.step();
  assert.equal(stale.taskMeta.participants.find(p => p.id === 'worker').metadata.assignmentAfterId, workerFence.assignmentAfterId);
  assert.equal(stale.taskMeta.participants.find(p => p.id === 'reviewer').metadata.assignmentAfterId, reviewerFence.assignmentAfterId);
  assert.throws(() => f.gate(stale), /no result is recorded after/);
  const worker = f.send('worker');
  f.at = '1999-01-01T00:00:00.000Z';
  const reviewer = f.send('reviewer');
  assert.ok(worker.id > workerFence.assignmentAfterId && reviewer.id > reviewerFence.assignmentAfterId);
  assert.ok(reviewer.ts < worker.ts);
  const step = await f.step(f.bindings.approver);
  assert.equal(step.repoDir, f.root);
  assert.deepEqual(step.taskMeta.participants.map(p => p.metadata.address), ['worker:worker', 'reviewer:worker']);
  assert.equal(step.facts.task.participants.find(p => p.id === 'worker').metadata.address, undefined);
  assert.doesNotThrow(() => f.gate(step));
  assert.throws(() => f.gate({ ...step, repoDir: path.join(f.root, 'different-subject') }), /its recorded subject is/);
  const reviewerParticipant = f.participant('reviewer');
  f.engine.patchParticipant(f.task, 'reviewer', { metadata: { ...reviewerParticipant.metadata,
    bb: { ...reviewerParticipant.metadata.bb, environmentPath: path.join(f.root, 'different-subject') } } });
  await assert.rejects(f.step(), /Reviewer and worker subjects differ/);
});

test('missing legacy and pending assignment boundaries refuse pending and step freshness proof', async t => {
  const f = await fixture(t);
  f.send('worker');
  f.send('reviewer');
  const participant = f.participant('worker');
  const legacy = { ...participant.metadata };
  delete legacy.assignmentAfterId;
  f.engine.patchParticipant(f.task, 'worker', { metadata: legacy });
  await assert.rejects(f.pending('worker'), /requires explicit fresh assignment/);
  f.send('orchestrator', 'task', 'worker', 'retained canonical assignment');
  f.send('worker');
  f.engine.patchParticipant(f.task, 'worker', { metadata: legacy });
  await assert.rejects(f.pending('worker'), /requires explicit fresh assignment/);
  const step = await f.step();
  assert.throws(() => f.gate(step), /requires explicit fresh assignment/);
  f.engine.patchParticipant(f.task, 'worker', { metadata: { ...legacy, assignmentAfterId: null } });
  await assert.rejects(f.pending('worker'), /pending publication/);
  const unpublished = await f.step();
  assert.throws(() => f.gate(unpublished), /pending publication/);
});

test('recovered review intent remains owed after task metadata publication fails and the mailbox is consumed', async t => {
  const f = await fixture(t);
  f.send('orchestrator', 'task', 'worker', 'A1'); const prior = f.send('worker', 'result', 'orchestrator', 'R1');
  f.send('reviewer');
  const boundary = f.participant('worker').metadata.assignmentAfterId;
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (String(to) === f.engine.taskFile(f.task)) throw Object.assign(new Error('assignment metadata publication refused'), { code: 'EIO' });
    return rename(from, to, ...args);
  }; syncBuiltinESMExports();
  try { assert.throws(() => f.send('orchestrator', 'review', 'worker', 'A2'), /assignment metadata publication refused/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(f.participant('worker').metadata.assignmentAfterId, boundary);
  const directory = path.join(f.engine.home, 'tasks', f.task);
  const names = fs.readdirSync(path.join(directory, 'intents')).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1);
  const assignment = JSON.parse(fs.readFileSync(path.join(directory, 'intents', names[0]), 'utf8'));
  assert.equal(assignment.type, 'review'); assert.ok(assignment.id > prior.id);
  assert.equal(fs.existsSync(path.join(directory, 'messages', `${assignment.id}.json`)), false);
  assert.equal(f.engine.recover(f.task).repairs.length, 1);
  assert.equal(f.participant('worker').metadata.assignmentAfterId, boundary);
  f.engine.read(f.task, 'worker');
  const pending = await f.pending('worker');
  assert.deepEqual(pending.ids, []);
  assert.equal(pending.obligation, assignment.id, 'Recovered review A2 must remain owed after ACK; retained R1 cannot settle it');
  const step = await f.step();
  assert.throws(() => f.gate(step), /no result is recorded after/);
});

for (const kind of ['no-lease', 'partial']) test(`step and pending refuse ${kind} A2 instead of accepting visible A1/R1`, async t => {
  const f = await fixture(t);
  f.send('orchestrator', 'task', 'worker', 'A1');
  const result = f.send('worker', 'result', 'orchestrator', 'R1');
  f.send('reviewer');
  assert.equal((await f.pending('worker')).obligation, null);
  const current = await f.step();
  assert.doesNotThrow(() => f.gate(current));
  f.at = '1999-01-01T00:00:00.000Z';
  const newer = f.send('orchestrator', 'task', 'worker', 'A2');
  assert.ok(newer.id > result.id && newer.ts < result.ts);
  const canonical = path.join(f.engine.home, 'tasks', f.task, 'messages', `${newer.id}.json`);
  const directory = path.join(f.engine.home, 'tasks', f.task, 'intents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${newer.id}.json`), kind === 'partial' ? '{' : fs.readFileSync(canonical));
  fs.rmSync(canonical);
  fs.rmSync(path.join(f.engine.inboxPath(f.task, 'worker'), `${newer.id}.json`));
  await assert.rejects(f.step(), /intent|recovery|broken|repair/);
  await assert.rejects(f.pending('worker'), /intent|recovery|broken|repair/);
});

test('a live paused A2 intent blocks stale BB step/pending and preserves its order after recovery', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  f.send('orchestrator', 'task', 'worker', 'A1');
  const previous = f.send('worker', 'result', 'orchestrator', 'R1');
  f.send('reviewer');
  const current = await f.step();
  assert.doesNotThrow(() => f.gate(current));
  const source = `import { openEngine } from ${JSON.stringify(import.meta.resolve('promptobus'))};
const engine = openEngine({ root: process.env.ORDER_ROOT, recover: false, policy: () => ({ allow: true }),
  now: () => new Date('1999-01-01Z'), faults(step, info) { if (step === 'intent') {
    process.stdout.write(info.message + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } } });
engine.sendSync(process.env.ORDER_TASK, { from: 'orchestrator', to: ['worker'], type: 'task', body: 'A2' });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, ORDER_ROOT: f.root, ORDER_TASK: f.task }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGTERM'));
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 || signal === 'SIGTERM' ? resolve() : reject(new Error(stderr)));
  });
  const id = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', data => { text += data; if (text.includes('\n')) resolve(text.split('\n')[0]); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`writer exited before intent: ${stderr}`)));
  });
  assert.ok(id > previous.id);
  const directory = path.join(f.engine.home, 'tasks', f.task);
  assert.equal(fs.existsSync(path.join(directory, 'messages', `${id}.json`)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'intents', `${id}.owner`), 'utf8')).pid, child.pid);
  await assert.rejects(f.step(), /unresolved task intent/);
  await assert.rejects(f.pending('worker'), /unresolved task intent/);
  child.kill('SIGTERM');
  await exited;
  const step = await f.step();
  assert.equal((await f.pending('worker')).obligation, id);
  assert.throws(() => f.gate(step), /no result is recorded after/);
  assert.equal(step.facts.messages.find(m => m.id === id).body, 'A2');
});

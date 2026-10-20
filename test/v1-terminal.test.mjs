import './home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { openEngine, PromptobusError } from '../dist/index.js';

const person = (id, role = 'worker') => ({ id, role, harness: 'fixture', mode: 'managed',
  sessionRef: `session-${id}`, capabilities: null, metadata: {} });
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptobus-v1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = openEngine({ root, recover: false, policy: () => ({ allow: true }), ...options });
  const task = 'terminal-task';
  engine.createTask({ id: task, title: 'Terminal ordering', owner: person('owner', 'orchestrator') });
  for (const id of ['worker', 'reviewer']) engine.assignParticipant(task, person(id));
  return { root, engine, task, directory: path.join(engine.home, 'tasks', task) };
}
const jsonNames = directory => {
  try { return fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const assignments = (engine, task) => engine.readTask(task).participants.map(p => [p.id, p.metadata.assignmentAfterId]);
function noMessage(engine, task) {
  const directory = path.join(engine.home, 'tasks', task);
  assert.deepEqual(jsonNames(path.join(directory, 'intents')), []);
  assert.deepEqual(jsonNames(path.join(directory, 'messages')), []);
  for (const participant of ['owner', 'worker', 'reviewer']) {
    assert.equal(engine.unread(task, participant), 0);
    assert.deepEqual(jsonNames(engine.historyPath(task, participant)), []);
  }
}

test('close-first held stream rejects publication before reservation and retains its public artifact', async t => {
  const f = fixture(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const payload = 'retained artifact after terminal refusal';
  const head = fs.readFileSync(path.join(f.engine.home, 'message-order.json'));
  const before = assignments(f.engine, f.task);
  const outcome = f.engine.send(f.task, { from: 'owner', to: ['worker'], type: 'task', body: 'must not commit',
    artifact: { filename: 'held.txt', stream: Readable.from((async function* () {
      enter(); await gate; yield payload;
    })()) } }).then(result => ({ result }), error => ({ error }));
  await entered;
  assert.equal(fs.existsSync(path.join(f.directory, '.lock')), false);
  assert.equal(fs.existsSync(path.join(f.engine.home, '.message-order-lock')), false);
  assert.equal(fs.existsSync(path.join(f.directory, '.lock-blobs')), true);
  noMessage(f.engine, f.task);
  f.engine.closeTask(f.task, { adapter: { first: true } });
  const closed = f.engine.closeTask(f.task, { adapter: { second: true } });
  assert.equal(closed.status, 'done');
  assert.deepEqual(closed.adapter, { first: true, second: true });
  release();
  const settled = await outcome;
  assert.ok(settled.error instanceof PromptobusError,
    'Close-first held-stream send must reject with typed task-closed; successful publication after done is forbidden');
  assert.equal(settled.error.code, 'task-closed');
  assert.deepEqual(settled.error.context, { task: f.task, status: 'done' });
  assert.equal(settled.result, undefined);
  noMessage(f.engine, f.task);
  assert.deepEqual(fs.readFileSync(path.join(f.engine.home, 'message-order.json')), head);
  assert.deepEqual(assignments(f.engine, f.task), before);
  const artifacts = f.engine.listArtifacts(f.task);
  assert.equal(artifacts.artifacts.length, 1); assert.deepEqual(artifacts.broken, []);
  assert.equal(f.engine.readArtifactContent(f.task, artifacts.artifacts[0].id).toString(), payload);
  assert.deepEqual(f.engine.orphanBlobs(f.task), []);
  assert.equal(fs.readdirSync(path.join(f.directory, 'blobs')).some(name => name.startsWith('.tmp-blob-')), false);
  assert.equal(fs.existsSync(path.join(f.directory, '.lock-blobs')), false);
  const reopened = openEngine({ root: f.root, recover: false, policy: () => ({ allow: true }) });
  noMessage(reopened, f.task);
  assert.deepEqual(reopened.recover(f.task).events, []);
  const recovered = openEngine({ root: f.root, policy: () => ({ allow: true }) });
  assert.equal(recovered.readTask(f.task).status, 'done'); noMessage(recovered, f.task);
  assert.deepEqual(recovered.facts(f.task).messages, []);
});

for (const type of ['status', 'task', 'review', 'artifact']) test(`sync ${type} rechecks activity after admission before changing order or assignment`, t => {
  let armed = false, engine;
  const f = fixture(t, { faults(step) { if (armed && step === 'validate') { armed = false; engine.closeTask(f.task); } } });
  engine = f.engine;
  let baseline;
  if (type === 'artifact') {
    const source = path.join(f.root, 'existing.txt'); fs.writeFileSync(source, 'existing linked artifact');
    baseline = engine.sendSync(f.task, { from: 'owner', to: ['owner'], type, body: 'baseline', artifact: { path: source } });
    engine.read(f.task, 'owner');
  }
  const head = fs.readFileSync(path.join(engine.home, 'message-order.json'));
  const before = assignments(engine, f.task);
  armed = true;
  assert.throws(() => engine.sendSync(f.task, { from: 'owner', to: ['worker'], type, body: 'loses to close',
    ...(baseline ? { linkArtifact: baseline.artifact.id } : {}) }),
  error => error instanceof PromptobusError && error.code === 'task-closed' && error.context.status === 'done');
  assert.deepEqual(fs.readFileSync(path.join(engine.home, 'message-order.json')), head);
  assert.deepEqual(assignments(engine, f.task), before);
  assert.equal(engine.unread(f.task, 'worker'), 0);
  assert.deepEqual(jsonNames(path.join(f.directory, 'intents')), []);
  assert.deepEqual(engine.facts(f.task).messages.map(m => m.id), baseline ? [baseline.message.id] : []);
  if (baseline) assert.equal(engine.readArtifactContent(f.task, baseline.artifact.id).toString(), 'existing linked artifact');
});

test('intent committed before close completes fanout and assignment on the done task', t => {
  let engine, intent;
  const f = fixture(t, { faults(step, info) {
    if (step !== 'intent') return;
    intent = info.message;
    assert.equal(fs.existsSync(path.join(f.directory, 'intents', `${intent}.json`)), true);
    assert.equal(fs.existsSync(path.join(f.directory, '.lock')), false);
    assert.equal(fs.existsSync(path.join(engine.home, '.message-order-lock')), false);
    engine.closeTask(f.task);
  } });
  engine = f.engine;
  const result = engine.sendSync(f.task, { from: 'owner', to: ['worker', 'reviewer'], type: 'task', body: 'committed first' });
  assert.equal(result.message.id, intent); assert.equal(result.events.length, 2);
  assert.equal(engine.readTask(f.task).status, 'done');
  for (const id of ['worker', 'reviewer']) {
    assert.equal(engine.readTask(f.task).participants.find(p => p.id === id).metadata.assignmentAfterId, intent);
    assert.deepEqual(engine.read(f.task, id).messages.map(m => m.id), [intent]);
  }
  assert.deepEqual(engine.recover(f.task).repairs, []);
  assert.deepEqual(engine.facts(f.task).messages.map(m => m.id), [intent]);
});

test('reserved-only crash followed by close remains an uncommitted gap after recovery', t => {
  let reserved;
  const crash = new Error('crash after durable reservation');
  const f = fixture(t, { faults(step, info) { if (step === 'order-reserved') { reserved = info.message; throw crash; } } });
  const before = assignments(f.engine, f.task);
  assert.throws(() => f.engine.sendSync(f.task, { from: 'owner', to: ['worker'], type: 'task', body: 'never committed' }), error => error === crash);
  const head = fs.readFileSync(path.join(f.engine.home, 'message-order.json'));
  assert.equal(JSON.parse(head).head, reserved);
  f.engine.closeTask(f.task);
  const reopened = openEngine({ root: f.root, recover: false, policy: () => ({ allow: true }), now: () => new Date('1999-01-01Z') });
  noMessage(reopened, f.task); assert.deepEqual(reopened.recover(f.task).events, []);
  assert.deepEqual(assignments(reopened, f.task), before);
  assert.deepEqual(fs.readFileSync(path.join(f.engine.home, 'message-order.json')), head);
  const next = 'terminal-next';
  reopened.createTask({ id: next, title: 'Another active task', owner: person('owner', 'orchestrator') });
  const sent = reopened.sendSync(next, { from: 'owner', to: ['owner'], type: 'status', body: 'later active commit' });
  assert.ok(sent.message.id > reserved); noMessage(reopened, f.task);
});

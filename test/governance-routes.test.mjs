import './home.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeSandbox } from './sandbox.mjs';
import * as store from '../lib/store.js';

const root = makeSandbox('promptobus-governance-routes-');
const home = path.join(root, '.promptobus');
const engine = store.bus(home, { cli: '0.5.1' });
const artifactPath = path.join(root, 'route.txt');
writeFileSync(artifactPath, 'route evidence\n');

function task(id, slug, owner, parent, teamlead) {
  return store.createTask(home, {
    id, title: slug, owner, adapter: { slug },
    ...(parent ? { parent, teamlead } : {}),
  });
}

const rootA = task('root-a-t20260926-120000', 'root-a', 'owner-a');
const rootB = task('root-b-t20260926-120000', 'root-b', 'owner-b');
const childA = task('child-a-t20260926-120000', 'alpha', 'lead-a', rootA.id, 'teamlead:alpha');
task('child-b-t20260926-120000', 'beta', 'lead-b', rootA.id, 'teamlead:beta');
const foreignChild = task('child-c-t20260926-120000', 'gamma', 'lead-c', rootB.id, 'teamlead:gamma');
store.upsertParticipant(home, rootA.id, store.participantRecord('worker:w'));
store.upsertParticipant(home, rootA.id, store.participantRecord('reporter'));
store.upsertParticipant(home, rootA.id, store.participantRecord('user'));

function send(from, to, type, taskId = rootA.id) {
  return engine.sendSync(taskId, {
    from: store.addrDir(from), to: [store.addrDir(to)], type, body: `${from} to ${to}: ${type}`,
    ...(type === 'artifact' ? { artifact: { path: artifactPath } } : {}),
  });
}

function denied(from, to, type, why, taskId = rootA.id) {
  assert.throws(() => send(from, to, type, taskId), (error) => {
    assert.equal(error.code, 'policy-denied');
    assert.match(error.message, why);
    return true;
  });
}

test('orchestrator and ordinary participants retain all seven vertical routes', () => {
  for (const type of store.MESSAGE_TYPES) {
    assert.equal(send('orchestrator', 'worker:w', type).message.type, type);
    assert.equal(send('worker:w', 'orchestrator', type).message.type, type);
  }
});

test('siblings of one root exchange four types; task, result and review use the root orchestrator', () => {
  for (const type of ['question', 'answer', 'status', 'artifact']) {
    assert.equal(send('teamlead:alpha', 'teamlead:beta', type).message.type, type);
  }
  for (const type of ['task', 'result', 'review']) {
    denied('teamlead:alpha', 'teamlead:beta', type, /root orchestrator of task root-a/);
  }
  assert.equal(store.sendMessage(home, rootA.id, {
    from: 'teamlead:alpha', to: 'teamlead:beta', type: 'question', body: 'sibling question', session: 'lead-a',
  }).message.type, 'question');
  assert.throws(() => store.sendMessage(home, rootA.id, {
    from: 'teamlead:alpha', to: 'teamlead:beta', type: 'question', body: 'borrowed', session: 'stranger',
  }), /cannot borrow an address/);
});

test('a teamlead bound to a child of another root cannot use the sibling route', () => {
  store.upsertParticipant(home, rootA.id, store.participantRecord('teamlead:foreign', {
    childTask: foreignChild.id, sessionId: 'lead-c',
  }));
  denied('teamlead:alpha', 'teamlead:foreign', 'question', /root orchestrator of task root-a/);
});

test('a reciprocal peer link admits four types in both directions and never assigns work', () => {
  store.upsertParticipant(home, rootA.id, store.participantRecord('peer:root-b', {
    peerTask: rootB.id, sessionId: 'owner-b',
  }));
  denied('orchestrator', 'peer:root-b', 'question', /reciprocal link/);
  store.upsertParticipant(home, rootB.id, store.participantRecord('peer:root-a', {
    peerTask: rootA.id, sessionId: 'owner-a',
  }));
  for (const type of ['question', 'answer', 'status', 'artifact']) {
    assert.equal(send('orchestrator', 'peer:root-b', type).message.type, type);
    assert.equal(send('peer:root-b', 'orchestrator', type).message.type, type);
  }
  for (const type of ['task', 'result', 'review']) {
    denied('orchestrator', 'peer:root-b', type, /root orchestrator/);
    denied('peer:root-b', 'orchestrator', type, /root orchestrator/);
  }
  assert.equal(store.sendMessage(home, rootA.id, {
    from: 'peer:root-b', to: 'orchestrator', type: 'question', body: 'peer question', session: 'owner-b',
  }).message.type, 'question');
  assert.throws(() => store.sendMessage(home, rootA.id, {
    from: 'peer:root-b', to: 'orchestrator', type: 'question', body: 'borrowed', session: 'stranger',
  }), /cannot borrow an address/);
});

test('user asks the orchestrator by question and receives answer or status only', () => {
  assert.equal(send('user', 'orchestrator', 'question').message.type, 'question');
  for (const type of store.MESSAGE_TYPES.filter((one) => one !== 'question')) {
    denied('user', 'orchestrator', type, /user asks the orchestrator by question/);
  }
  for (const type of ['answer', 'status']) {
    assert.equal(send('orchestrator', 'user', type).message.type, type);
  }
  for (const type of store.MESSAGE_TYPES.filter((one) => !['answer', 'status'].includes(one))) {
    denied('orchestrator', 'user', type, /receives answer or status/);
  }
  denied('user', 'worker:w', 'question', /root orchestrator/);
  store.upsertParticipant(home, childA.id, store.participantRecord('user'));
  assert.equal(send('user', 'orchestrator', 'question', childA.id).message.type, 'question');
  assert.equal(send('orchestrator', 'user', 'answer', childA.id).message.type, 'answer');
  assert.equal(send('orchestrator', 'user', 'status', childA.id).message.type, 'status');
  denied('user', 'orchestrator', 'status', /user asks the orchestrator by question/, childA.id);
  denied('orchestrator', 'user', 'task', /receives answer or status/, childA.id);
  store.upsertParticipant(home, childA.id, store.participantRecord('peer:root-b'));
  denied('orchestrator', 'peer:root-b', 'question', /reciprocal link/, childA.id);
});

test('reporter sends nothing; other absent pairs take the vertical route', () => {
  denied('reporter', 'orchestrator', 'question', /reporter reads and sends nothing/);
  denied('reporter', 'worker:w', 'status', /root orchestrator/);
  denied('teamlead:alpha', 'worker:w', 'question', /root orchestrator/);
  denied('worker:w', 'teamlead:alpha', 'answer', /root orchestrator/);
  assert.equal(send('orchestrator', 'reporter', 'status').message.type, 'status');
});

import './home.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openEngine } from '../dist/index.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import * as store from '../lib/store.js';
import { requireStepResults } from '../lib/review.js';
import { reviewerResultSent } from '../lib/approver.js';
import { buildDigest } from '../lib/digest.js';

function fixture(t) {
  const root = makeSandbox('pb-native-message-order-');
  writeHostConfig(root);
  const home = path.join(root, '.promptobus');
  let at = new Date('2026-10-20T12:00:00.000Z');
  const engine = openEngine({ root, now: () => at, recover: false, policy: () => ({ allow: true }) });
  const task = 'native-order-t20261020-120000';
  engine.createTask({ id: task, title: 'Native order', owner: store.participantRecord(store.ORCHESTRATOR) });
  const participant = (address, subject = root) => store.participantRecord(address, {
    harness: 'claude', repoAbs: subject, worktree: subject,
    started: '2099-01-01T00:00:00.000Z', reviewAssignedAt: '2099-01-01T00:00:00.000Z',
  });
  engine.assignParticipant(task, participant('worker:sample'));
  engine.assignParticipant(task, participant('reviewer:sample'));
  store.bus(home, { cli: '0.28.0' });
  const send = (from, type = 'result', body = type, to = store.ORCHESTRATOR) => engine.sendSync(task, {
    from: store.addrDir(from), to: [store.addrDir(to)], type, body,
  }).message;
  const host = { pipeline: () => [
    { name: 'worker', kind: 'edits-tree' },
    { name: 'reviewer', kind: 'reads-diff' },
    { name: 'approver', kind: 'writes-main-tree' },
  ] };
  const gate = (repoDir = root, taskMeta = engine.readTask(task)) => requireStepResults(host, {
    home, taskId: task, taskMeta, stepName: 'approver', slug: 'sample', repoDir,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, task, engine, participant, send, gate, set at(value) { at = new Date(value); } };
}

test('native gates and digest follow committed results through rollback and equal timestamps', t => {
  const f = fixture(t);
  f.send('worker:sample');
  const first = f.send('reviewer:sample', 'result', 'earlier report');
  f.at = '2026-10-20T11:59:59.000Z';
  const assignment = f.send(store.ORCHESTRATOR, 'task', 'review again', 'reviewer:sample');
  store.stampReviewAssignment(f.home, f.task, 'reviewer:sample', assignment.id, assignment.ts);
  assert.equal(reviewerResultSent(f.home, f.task, 'reviewer:sample'), false);
  assert.throws(() => f.gate(), /no result is recorded after/);
  const second = f.send('reviewer:sample', 'result', 'current report');
  assert.equal(second.ts, assignment.ts);
  assert.ok(second.ts < first.ts);
  assert.ok(second.id > assignment.id && assignment.id > first.id);
  assert.equal(reviewerResultSent(f.home, f.task, 'reviewer:sample'), true);
  assert.doesNotThrow(() => f.gate());
  const digest = buildDigest(f.root, { task: f.task });
  assert.equal(digest.tasks[0].pieces.find(piece => piece.slug === 'sample').step, 'approver');
});

test('native gates read the current participant boundary instead of a stale task snapshot', t => {
  const f = fixture(t);
  f.send('worker:sample');
  f.send('reviewer:sample');
  const stale = f.engine.readTask(f.task);
  f.at = '2026-10-19T12:00:00.000Z';
  f.engine.assignParticipant(f.task, f.participant('reviewer:sample'));
  assert.throws(() => f.gate(f.root, stale), /no result is recorded after/);
  f.send('reviewer:sample');
  assert.doesNotThrow(() => f.gate(f.root, stale));
  assert.throws(() => f.gate(path.join(f.root, 'another-subject')), /its recorded subject is/);
});

test('the shared native gate joins synthetic BB subjects to canonical participants by id', t => {
  const f = fixture(t);
  f.send('worker:sample');
  f.send('reviewer:sample');
  const facts = f.engine.facts(f.task);
  const subjects = structuredClone(facts.task);
  for (const participant of facts.task.participants) delete participant.metadata.address;
  for (const participant of subjects.participants) participant.metadata.assignmentAfterId = null;
  const host = { pipeline: () => [
    { name: 'worker', kind: 'edits-tree' },
    { name: 'reviewer', kind: 'reads-diff' },
    { name: 'approver', kind: 'writes-main-tree' },
  ] };
  assert.doesNotThrow(() => requireStepResults(host, {
    home: f.home, taskId: f.task, taskMeta: subjects, facts,
    stepName: 'approver', slug: 'sample', repoDir: f.root,
  }));
});

test('null and retained legacy assignment boundaries fail closed without timestamp or telemetry fallback', t => {
  const f = fixture(t);
  f.send('worker:sample');
  f.send('reviewer:sample');
  store.stampReviewAssignment(f.home, f.task, 'reviewer:sample', null);
  f.send('reviewer:sample');
  assert.equal(reviewerResultSent(f.home, f.task, 'reviewer:sample'), false);
  assert.throws(() => f.gate(), /pending publication/);
  f.engine.putParticipant(f.task, f.participant('reviewer:sample'));
  f.send('reviewer:sample');
  assert.equal(reviewerResultSent(f.home, f.task, 'reviewer:sample'), false);
  assert.throws(() => f.gate(), /requires explicit fresh assignment/);
  const assignment = store.sendMessage(f.home, f.task, {
    from: store.ORCHESTRATOR, to: 'reviewer:sample', type: 'task', body: 'explicit fresh assignment',
  });
  const assigned = store.participantOf(f.engine.readTask(f.task), 'reviewer:sample');
  assert.equal(assigned.metadata.assignmentAfterId, assignment.message.id);
  assert.equal(assigned.metadata.reviewAssignedAt, '2099-01-01T00:00:00.000Z');
  assert.equal(reviewerResultSent(f.home, f.task, 'reviewer:sample'), false);
  f.send('reviewer:sample');
  assert.doesNotThrow(() => f.gate());
});

test('a delayed re-review stamp cannot replace a newer initial-prompt fence', t => {
  const f = fixture(t);
  const assignment = f.send(store.ORCHESTRATOR, 'task', 'review again', 'reviewer:sample');
  f.engine.assignParticipant(f.task, f.participant('reviewer:sample'));
  const fresh = store.participantOf(f.engine.readTask(f.task), 'reviewer:sample');
  store.stampReviewAssignment(f.home, f.task, 'reviewer:sample', assignment.id, assignment.ts);
  assert.deepEqual(store.participantOf(f.engine.readTask(f.task), 'reviewer:sample'), fresh);
});

test('a delayed re-review stamp cannot clear a newer pending assignment', t => {
  const f = fixture(t);
  const assignment = f.send(store.ORCHESTRATOR, 'task', 'review again', 'reviewer:sample');
  store.stampReviewAssignment(f.home, f.task, 'reviewer:sample', null);
  store.stampReviewAssignment(f.home, f.task, 'reviewer:sample', assignment.id, assignment.ts);
  assert.equal(store.participantOf(f.engine.readTask(f.task), 'reviewer:sample').metadata.assignmentAfterId, null);
});

test('an explicit canonical assignment supersedes a retained earlier participant boundary', t => {
  const f = fixture(t);
  f.send('worker:sample');
  f.send('reviewer:sample');
  const earlier = store.participantOf(f.engine.readTask(f.task), 'reviewer:sample');
  f.send(store.ORCHESTRATOR, 'task', 'newer assignment', 'reviewer:sample');
  f.engine.putParticipant(f.task, earlier);
  assert.equal(reviewerResultSent(f.home, f.task, 'reviewer:sample'), false);
  assert.throws(() => f.gate(), /no result is recorded after/);
});

for (const lease of [true, false]) {
  test(`native current-result queries refuse a newer assignment intent ${lease ? 'with a live lease' : 'before its lease exists'}`, t => {
    const f = fixture(t);
    f.send('worker:sample');
    f.send('reviewer:sample');
    const assignment = f.send(store.ORCHESTRATOR, 'task', 'new assignment', 'reviewer:sample');
    const canonical = path.join(store.messagesDir(f.home, f.task), `${assignment.id}.json`);
    const intentDir = path.join(store.taskDir(f.home, f.task), 'intents');
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(path.join(intentDir, `${assignment.id}.json`), readFileSync(canonical));
    if (lease) writeFileSync(path.join(intentDir, `${assignment.id}.owner`),
      JSON.stringify({ pid: process.pid, host: 'fixture-live-other-host' }));
    rmSync(canonical);
    rmSync(path.join(f.engine.inboxPath(f.task, store.addrDir('reviewer:sample')), `${assignment.id}.json`));
    assert.throws(() => reviewerResultSent(f.home, f.task, 'reviewer:sample'), /intent/);
    assert.throws(() => f.gate(), /intent/);
    assert.throws(() => buildDigest(f.root, { task: f.task }), /intent/);
  });
}

test('native current-result queries refuse broken canonical facts instead of skipping newer records', t => {
  const f = fixture(t);
  f.send('worker:sample');
  f.send('reviewer:sample');
  const newer = f.send(store.ORCHESTRATOR, 'task', 'new assignment', 'reviewer:sample');
  writeFileSync(path.join(store.messagesDir(f.home, f.task), `${newer.id}.json`), '{');
  assert.throws(() => reviewerResultSent(f.home, f.task, 'reviewer:sample'));
  assert.throws(() => f.gate());
});

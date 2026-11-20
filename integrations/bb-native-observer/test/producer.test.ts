import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readBoard, readPieceHistory } from '../board.js';
import { columnsOf } from '../dashboard.js';
import { readProjection, sessionFileName } from '../projection.js';
import { fixture, treeDigest } from './fixture.js';

test('the board follows the pipeline recorded by spawn and agrees with digest on the same store', async () => {
  const runtime = (file: string) => import(pathToFileURL(path.resolve(`../../lib/${file}.js`)).href);
  const [{ hostOf }, { planSpawn }, store, { buildDigest }, { requireStepResults }] = await Promise.all(['host', 'spawn', 'store', 'digest', 'review'].map(runtime));
  const f = fixture('legacy');
  try {
    const repo = path.join(f.root, 'app'), brief = path.join(f.root, 'brief.md');
    mkdirSync(repo); writeFileSync(brief, 'Work on parser');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base', '--allow-empty']);
    for (const gates of [['approver'], ['approver', 'security', 'reviewer']]) {
      const pipeline = { owner: { name: 'worker', kind: 'edits-tree' }, gates: gates.map(name => ({ name, kind: name === 'approver' ? 'writes-main-tree' : 'reads-diff' })) };
      writeFileSync(path.join(f.root, 'promptobus.json'), JSON.stringify({ commandName: 'promptobus', tools: ['claude'], pipeline }));
      const home = f.selection.storeRoot, host = hostOf(f.root, { home });
      store.bus(home, { cli: host.version });
      const plan = await planSpawn(host, { repo, brief, worker: 'parser', newTask: true, slug: `run-${gates.length}`, dryRun: true });
      store.createTask(home, plan.createNew);
      const boundary = { assignmentAfterId: '20200101T000000000-0000-000000' };
      const worker = store.participantRecord('worker:parser', { ...boundary, worktree: repo });
      f.engine.addParticipant(plan.taskId, worker);
      f.engine.sendSync(plan.taskId, { from: worker.id, to: ['orchestrator'], type: 'result', body: 'ready' });
      const digest = buildDigest(host, { task: plan.taskId }).tasks[0];
      const roots = { storeRoot: home, nativeRoot: f.selection.nativeRoot };
      const lane = () => readBoard(roots, 'producer-test', 1).runs.find(row => row.id === plan.taskId)!;
      const run = lane();
      assert.deepEqual(run.steps, ['worker', ...gates]);
      assert.equal(run.inferred, false);
      assert.deepEqual(digest.pieces, [{ slug: 'parser', step: 'approver' }]);
      assert.deepEqual(run.pieces.map(({ slug, step }) => ({ slug, step })), digest.pieces);
      if (gates.length !== 1) continue;
      const gate = (config: typeof host, stepName: string) => requireStepResults(config, { home, taskId: plan.taskId,
        taskMeta: f.engine.readTask(plan.taskId), stepName, slug: 'parser', repoDir: repo });
      gate(host, 'approver');
      pipeline.gates.unshift({ name: 'reviewer', kind: 'reads-diff' });
      writeFileSync(path.join(f.root, 'promptobus.json'), JSON.stringify({ commandName: 'promptobus', tools: ['claude'], pipeline }));
      const changed = hostOf(f.root, { home });
      assert.deepEqual(buildDigest(changed, { task: plan.taskId }).tasks[0].pieces, [{ slug: 'parser', step: 'reviewer' }]);
      gate(changed, 'reviewer');
      assert.throws(() => gate(changed, 'approver'), /requires a type=result message from reviewer:parser/);
      assert.deepEqual(lane().startSteps, ['worker', 'approver']);
      assert.equal(lane().pieces[0].placement, 'expected-at-start');
      assert.equal(lane().pieces[0].holder, null);
      const reviewer = store.participantRecord('reviewer:parser', { ...boundary, reviewSubject: repo });
      f.engine.addParticipant(plan.taskId, reviewer);
      f.engine.sendSync(plan.taskId, { from: reviewer.id, to: ['orchestrator'], type: 'status', body: 'checking parser' });
      const observed = lane();
      assert.deepEqual(observed.steps, ['worker', 'approver', 'reviewer']);
      assert.equal(observed.pieces[0].step, 'reviewer');
      assert.equal(observed.pieces[0].placement, 'observed');
      assert.equal(observed.pieces[0].holder?.participantId, reviewer.id);
      assert.ok(readPieceHistory({ ...roots, taskId: plan.taskId, slug: 'parser' }).messages.some(m => m.body === 'checking parser'));
      f.engine.sendSync(plan.taskId, { from: reviewer.id, to: ['orchestrator'], type: 'result', body: 'reviewed' });
      gate(changed, 'approver');
      assert.deepEqual(columnsOf(lane()).filter(col => col.pieces.length).map(col => col.label), ['Next step unconfirmed']);
    }
  } finally { f.cleanup(); }
});

test('the observer reads native records written for reserved Codex workers and reviewers', async () => {
  const runtime = (file: string) => import(pathToFileURL(path.resolve(`../../lib/${file}.js`)).href);
  const [store, lifecycle, { REGISTRY }, { writeSession }] = await Promise.all(
    ['store', 'native-lifecycle', 'drivers', 'codex-session'].map(runtime));
  const f = fixture();
  try {
    const selection = { ...f.selection, taskId: 'bound-producers' };
    const { storeRoot: home, nativeRoot, taskId } = selection;
    store.createTask(home, { id: taskId, title: 'Bound Codex launches' });
    const refs = ['!!!', 'x'.repeat(60), 'review/one:two', 'MiXeD'];
    for (const [index, ref] of refs.entries()) {
      const reviewer = index % 2 === 1;
      const address = `${reviewer ? 'reviewer' : 'worker'}:actor-${index}`, thread = `thread-${index}`;
      const participant = store.participantRecord(address, { harness: 'codex', sessionRef: ref,
        ...(reviewer ? { reviewLaunchId: `review-${index}` } : {}) });
      const { record } = lifecycle.reserveNativeParticipant(home, taskId, participant, null, REGISTRY);
      if (reviewer) lifecycle.persistReviewerSession(home, taskId, record, thread, false, thread);
      else lifecycle.persistNativeParticipant(home, taskId, record, { session: thread, sessionId: thread });
      const persisted = store.participantOf(store.readTask(home, taskId), address);
      assert.equal(persisted.metadata.sessionId, thread);
      assert.equal(typeof record.metadata.nativeLaunchId, 'string');
      assert.ok(record.metadata.nativeLaunchId);
      assert.equal(persisted.metadata.nativeLaunchId, record.metadata.nativeLaunchId);
      writeSession({ ref, home, task: taskId, address, threadId: thread, launchId: record.metadata.nativeLaunchId,
        state: 'alive', busy: true, sandbox: 'readOnly' }, { PROMPTOBUS_CODEX_HOME: nativeRoot });
      const actor = readProjection(selection, 'producer-test', 1).actors.find(p => p.address === address);
      assert.ok(actor);
      assert.deepEqual([actor.sessionRef, actor.launchId, actor.threadId, actor.state, actor.busy, actor.sandbox],
        [ref, record.metadata.nativeLaunchId, thread, 'alive', true, 'readOnly']);
    }
  } finally { f.cleanup(); }
});

test('legacy worker and reviewer records retain canonical bindings without a native launch binding', async () => {
  const { participantRecord, upsertParticipant } = await import(pathToFileURL(path.resolve('../../lib/store.js')).href);
  const f = fixture('producer-bindings');
  try {
    const selection = { ...f.selection, taskId: 'actual-producer' };
    f.engine.createTask({ id: selection.taskId, title: 'Producer registration', owner: f.engine.readTask(f.selection.taskId).participants[0] });
    for (const [index, address] of ['worker:alpha', 'reviewer:beta'].entries()) {
      const native = f.records[index];
      const record = participantRecord(address, { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high',
        name: native.ref, sessionRef: native.ref, session: null });
      upsertParticipant(selection.storeRoot, selection.taskId,
        { ...record, metadata: { ...record.metadata, session: native.threadId, sessionId: native.threadId } });
      assert.equal(f.engine.readTask(selection.taskId).participants.find(p => p.id === record.id)!.metadata.nativeLaunchId, undefined);
      writeFileSync(path.join(f.selection.nativeRoot, 'sessions', sessionFileName(native.ref)), '{UNBOUND-NATIVE-RECORD');
    }
    const before = treeDigest(f.root), snapshot = readProjection(selection, 'producer-test', 1);
    assert.equal(snapshot.actors.length, 2);
    for (const address of ['worker:alpha', 'reviewer:beta']) {
      const actor = snapshot.actors.find(actor => actor.address === address && actor.model === 'gpt-6.1-sol')!;
      assert(actor); assert.equal(actor.state, 'native launch binding unavailable');
      assert.equal(actor.busy, null); assert.equal(actor.launchId, null); assert.equal(actor.commands, null);
      assert.equal(actor.sandbox, null); assert.match(actor.threadId!, /^thread-/); assert.equal(actor.effort, 'high');
    }
    assert.equal(treeDigest(f.root), before);
  } finally { f.cleanup(); }
});

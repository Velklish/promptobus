import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readBoard } from '../board.js';
import { readProjection, sessionFileName } from '../projection.js';
import { fixture, treeDigest } from './fixture.js';

test('the board follows the pipeline recorded by spawn and agrees with digest on the same store', async () => {
  const runtime = (file: string) => import(pathToFileURL(path.resolve(`../../lib/${file}.js`)).href);
  const [{ hostOf }, { planSpawn }, store, { buildDigest }] = await Promise.all(['host', 'spawn', 'store', 'digest'].map(runtime));
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
      const worker = store.participantRecord('worker:parser', { assignmentAfterId: '20200101T000000000-0000-000000' });
      f.engine.addParticipant(plan.taskId, worker);
      f.engine.sendSync(plan.taskId, { from: worker.id, to: ['orchestrator'], type: 'result', body: 'ready' });
      const digest = buildDigest(host, { task: plan.taskId }).tasks[0];
      const run = readBoard({ storeRoot: home, nativeRoot: f.selection.nativeRoot }, 'producer-test', 1).runs.find(row => row.id === plan.taskId)!;
      assert.deepEqual(run.steps, ['worker', ...gates]);
      assert.equal(run.inferred, false);
      assert.deepEqual(digest.pieces, [{ slug: 'parser', step: 'approver' }]);
      assert.deepEqual(run.pieces.map(({ slug, step }) => ({ slug, step })), digest.pieces);
    }
  } finally { f.cleanup(); }
});

test('actual worker and reviewer persist records retain canonical bindings without a fabricated native launch binding', async () => {
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

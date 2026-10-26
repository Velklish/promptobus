import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { readProjection, sessionFileName } from '../projection.js';
import { fixture, treeDigest } from './fixture.js';

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

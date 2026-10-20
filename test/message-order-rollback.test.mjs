import './home.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEngine, newTaskIdentity } from '../dist/index.js';

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-message-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let at = new Date('2026-10-20T12:00:00.000Z');
  const engine = openEngine({ root, policy: () => ({ allow: true }), recover: false, now: () => at, ...options });
  const task = newTaskIdentity('order').id;
  const participant = id => ({ id, role: id === 'orchestrator' ? 'orchestrator' : 'worker', harness: 'fixture',
    mode: 'managed', sessionRef: id, capabilities: null, metadata: {} });
  engine.createTask({ id: task, title: 'Ordering fixture', owner: participant('orchestrator') });
  engine.addParticipant(task, participant('worker'));
  const send = body => engine.sendSync(task, { from: 'worker', to: ['orchestrator'], type: 'result', body });
  return { root, engine, task, participant, send, set at(value) { at = new Date(value); } };
}

test('committed result order survives wall-clock rollback while original timestamps remain unchanged', t => {
  const f = fixture(t), first = f.send('first result');
  f.at = '2026-10-20T11:59:59.000Z';
  const second = f.send('second result');
  assert.ok(second.message.id > first.message.id, `Later committed result must have a greater canonical ID; first=${first.message.id}, second=${second.message.id}`);
  assert.equal(second.message.ts, '2026-10-20T11:59:59.000Z');
  assert.deepEqual(f.engine.peek(f.task, 'orchestrator').messages.map(message => message.body), ['first result', 'second result']);
});

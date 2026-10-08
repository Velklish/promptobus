import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeBbParticipant, stopBbParticipant } from '../.test-build/lifecycle.js';

const binding = { phase: 'ready', threadId: 'thread', projectId: 'project', environmentId: 'env',
  environmentPath: '/actual/worktree', hostId: 'local', providerId: 'codex' };
function sdk(state = 'idle') {
  const thread = { id: 'thread', projectId: 'project', environmentId: 'env', providerId: 'codex', status: state,
    runtime: { displayStatus: state }, activeBackgroundAgentCount: 0, archivedAt: null, deletedAt: null,
    parentThreadId: null, lifecycleOwnerThreadId: null };
  const environment = { id: 'env', path: '/actual/worktree', hostId: 'local', status: 'ready', lifecycle: { phase: 'active' } };
  const host = { id: 'local', status: 'connected', lifecycle: { phase: 'active' } };
  let stopped = 0;
  const bb = { sdk: { threads: { get: async () => thread, stop: async () => { stopped++; return { ok: true }; } },
    environments: { get: async () => environment }, hosts: { get: async () => host } } };
  return { bb, thread, environment, host, get stopped() { return stopped; } };
}

test('async SDK observations resolve before producing plain SessionView; stopping and offline stay unknown', async () => {
  const s = sdk('active');
  const active = await observeBbParticipant(s.bb, binding);
  assert.deepEqual(active.view, { state: 'alive', busy: true, stall: null, id: 'thread', note: 'BB active' });
  assert.equal(active.view.then, undefined);
  s.thread.status = s.thread.runtime.displayStatus = 'idle';
  assert.equal((await observeBbParticipant(s.bb, binding)).view.busy, false);
  s.thread.status = s.thread.runtime.displayStatus = 'stopping';
  assert.equal((await observeBbParticipant(s.bb, binding)).view.state, 'unknown');
  assert.equal((await observeBbParticipant(s.bb, binding)).status, 'stopping');
  s.host.status = 'disconnected';
  s.thread.status = s.thread.runtime.displayStatus = 'idle';
  assert.equal((await observeBbParticipant(s.bb, binding)).view.state, 'unknown');
  s.host.status = 'connected'; s.environment.status = 'destroyed';
  assert.equal((await observeBbParticipant(s.bb, binding)).view.state, 'unknown');
});

test('unknown SDK reads and mismatched bindings are not alive or confirmed stopped', async () => {
  const s = sdk();
  s.thread.providerId = 'foreign';
  assert.equal((await observeBbParticipant(s.bb, binding)).view.state, 'unknown');
  await assert.rejects(stopBbParticipant(s.bb, binding), /binding mismatch/);
  assert.equal(s.stopped, 0);
  s.bb.sdk.threads.get = async () => { throw new Error('Host offline'); };
  assert.equal((await observeBbParticipant(s.bb, binding)).view.state, 'unknown');
});

test('Stop success is checked against fresh SDK status and background work; stopping blocks cleanup', async () => {
  const s = sdk('stopping');
  const first = await stopBbParticipant(s.bb, binding);
  assert.equal(first.confirmed, false);
  assert.equal(first.observation.status, 'stopping');
  s.thread.status = s.thread.runtime.displayStatus = 'idle';
  s.thread.activeBackgroundAgentCount = 1;
  assert.equal((await stopBbParticipant(s.bb, binding)).confirmed, false);
  s.thread.activeBackgroundAgentCount = 0;
  assert.equal((await stopBbParticipant(s.bb, binding)).confirmed, true);
  s.host.status = 'disconnected';
  assert.equal((await stopBbParticipant(s.bb, binding)).confirmed, false);
  assert.equal(s.stopped, 4);
});

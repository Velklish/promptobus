import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext, makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import { openEngine, newTaskIdentity } from 'promptobus';
import plugin from '../.test-build/server.js';
import { engineOperation } from '../.test-build/engine-host.js';

async function stand(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const threads = new Map();
  const environment = { id: 'env', projectId: 'project', path: root, hostId: 'local' };
  let next = 0;
  let host;
  host = createFakePluginHost({ pluginId: 'promptobus', agentSkillIds: Object.values(options.skills ?? {
    worker: 'promptobus-worker', reviewer: 'promptobus-reviewer', approver: 'promptobus-approver',
    teamlead: 'promptobus-teamlead', reporter: 'promptobus-reporter', orchestrator: 'promptobus-orchestrator',
  }), sdk: {
    system: { config: async () => ({ primaryHostId: 'local' }) },
    environments: { get: async () => environment },
    threads: {
      get: async ({ threadId }) => { if (!threads.has(threadId)) throw new Error('Thread not found'); return threads.get(threadId); },
      spawn: async args => {
        const thread = makeThreadResponse({ id: `thr-${++next}`, projectId: args.projectId, environmentId: 'env', providerId: args.providerId });
        threads.set(thread.id, thread);
        const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
        assert.equal((await hook(makeMessageDispatchHookContext({ thread, origin: 'plugin', originPluginId: 'promptobus' }))).action, 'wait');
        const before = host.harness.inspection.experimental_hostRpcCalls.length;
        await assert.rejects(host.harness.behavior.callAgentTool('promptobus_task', {}, { threadId: thread.id, projectId: 'project' }), /not bound/);
        assert.equal(host.harness.inspection.experimental_hostRpcCalls.length, before);
        if (options.beforeReturn) await options.beforeReturn({ host, thread });
        return thread;
      },
      stop: async () => ({ ok: true }),
    },
  }, experimental_callHostRpc: async ({ method, input, hostId }) => {
    assert.equal(hostId, 'local');
    if (options.failFinalize && method === 'engine' && input.operation === 'finalize') throw new Error('Host unavailable');
    return engineOperation(input);
  } });
  t.after(() => host.harness.lifecycle.dispose());
  plugin(host.bb);
  const task = newTaskIdentity('engine-test').id;
  const create = async () => host.harness.behavior.runCli(['task', 'create', '--task', task, '--title', 'Engine test', '--project', 'project', '--environment', 'env', '--model', 'test-model', '--assignment', 'Read mailbox, then stop.']);
  const add = async (id, role = 'worker') => host.harness.behavior.runCli(['participant', 'add', '--task', task, '--participant', id, '--role', role, '--model', 'test-model', '--assignment', 'Read mailbox, then stop.']);
  const call = (id, name, input = {}, projectId = 'project') => host.harness.behavior.callAgentTool(name, input, { threadId: id, projectId });
  return { root, threads, environment, get host() { return host; }, task, create, add, call,
    async reload() { host = await host.harness.lifecycle.reload(plugin); } };
}

test('bound tools use host engine canon; peek preserves mail, read acknowledges only the caller, artifacts survive reload', async t => {
  const s = await stand(t);
  assert.equal((await s.create()).exitCode, 0);
  assert.equal((await s.add('worker-one')).exitCode, 0);
  assert.equal(s.host.harness.inspection.recheckCount, 2);
  const sent = JSON.parse(await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'artifact', body: 'Review evidence', artifact: { filename: 'evidence.txt', content: 'immutable evidence' } }));
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  assert.equal(engine.unread(s.task, 'worker-one'), 1);
  assert.equal(JSON.parse(await s.call('thr-2', 'promptobus_mailbox', { mode: 'peek' })).messages[0].id, sent.message.id);
  assert.equal(engine.unread(s.task, 'worker-one'), 1);
  assert.equal(JSON.parse(await s.call('thr-1', 'promptobus_mailbox', { mode: 'read' })).messages.length, 0);
  await s.reload();
  assert.equal(JSON.parse(await s.call('thr-2', 'promptobus_artifact', { id: sent.artifact.id })).content, 'immutable evidence');
  assert.equal(JSON.parse(await s.call('thr-2', 'promptobus_mailbox', { mode: 'read' })).messages.length, 1);
  assert.equal(engine.unread(s.task, 'worker-one'), 0);
  assert.equal(engine.readTask(s.task).participants.find(p => p.id === 'worker-one').sessionRef, 'thr-2');
  assert.ok(s.host.harness.inspection.experimental_hostRpcCalls.every(c => c.hostId === 'local'));
});

test('forged identity fields, metadata, foreign project and missing threads grant no bus rights', async t => {
  const s = await stand(t);
  assert.equal((await s.create()).exitCode, 0);
  await s.add('worker-one');
  const count = () => s.host.harness.inspection.experimental_hostRpcCalls.length;
  for (const input of [{ from: 'orchestrator' }, { task: s.task }, { address: 'orchestrator' }]) {
    const before = count();
    await assert.rejects(s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'status', body: 'spoof', ...input }));
    assert.equal(count(), before);
  }
  const config = await s.host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    thread: { id: 'forged' }, pluginMetadata: { promptobus: { task: s.task, role: 'orchestrator', participant: 'orchestrator' } },
  }));
  assert.equal(config.tools.length, 0);
  const before = count();
  await assert.rejects(s.call('forged', 'promptobus_task'), /not bound/);
  await assert.rejects(s.call('thr-2', 'promptobus_task', {}, 'foreign'), /binding mismatch/);
  s.threads.delete('thr-2');
  await assert.rejects(s.call('thr-2', 'promptobus_task'), /Thread not found/);
  assert.equal(count(), before);
});

test('canonical participant edits and closed tasks are refused; reporter cannot send', async t => {
  const s = await stand(t);
  await s.create(); await s.add('reporter-one', 'reporter');
  await assert.rejects(s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'status', body: 'forbidden' }), /role/);
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  engine.patchParticipant(s.task, 'reporter-one', { role: 'orchestrator' });
  await assert.rejects(s.call('thr-2', 'promptobus_task'), /Canonical binding mismatch/);
  engine.closeTask(s.task);
  await assert.rejects(s.call('thr-1', 'promptobus_task'), /closed/);
});

test('a failed finalization stays orphaned across reload and cannot be reassigned', async t => {
  const s = await stand(t, { failFinalize: true });
  assert.equal((await s.create()).exitCode, 1);
  await s.reload();
  await assert.rejects(s.call('thr-1', 'promptobus_task'), /not bound/);
  assert.equal((await s.create()).exitCode, 1);
  const status = await s.host.harness.behavior.runCli(['bindings']);
  assert.equal(status.exitCode, 0);
  assert.equal(JSON.parse(status.stdout)[0].phase, 'orphan');
});

test('role tool selection uses stored bindings and refuses changed environment, provider and worker lateral sends', async t => {
  const s = await stand(t);
  assert.equal((await s.create()).exitCode, 0);
  assert.equal((await s.add('worker-one')).exitCode, 0);
  assert.equal((await s.add('worker-two')).exitCode, 0);
  assert.equal((await s.add('reviewer-one', 'reviewer')).exitCode, 0);
  const context = makePluginAgentConfigurationContext({ thread: { id: 'thr-4' }, project: { id: 'project' },
    environment: { id: 'env', path: s.root }, host: { id: 'local' }, provider: { id: 'promptobus-codex-reviewer' } });
  const configuration = await s.host.harness.behavior.resolveAgentConfiguration(context);
  assert.deepEqual(configuration.tools.map(tool => tool.name).sort(), [
    'promptobus_send', 'promptobus_mailbox', 'promptobus_task', 'promptobus_artifact',
    'pb_review_read_file', 'pb_review_read_files', 'pb_review_list_files', 'pb_review_search_text',
  ].sort());
  assert.deepEqual(configuration.skills, ['promptobus-reviewer']);
  assert.equal((await s.host.harness.behavior.resolveAgentConfiguration({ ...context, provider: { ...context.provider, id: 'codex' } })).tools.length, 0);
  await assert.rejects(s.call('thr-2', 'promptobus_send', { to: ['worker-two'], type: 'status', body: 'forbidden lateral route' }), /Route through/);
  const before = s.host.harness.inspection.experimental_hostRpcCalls.length;
  s.environment.hostId = 'remote';
  await assert.rejects(s.call('thr-2', 'promptobus_task'), /environment binding mismatch/);
  assert.equal(s.host.harness.inspection.experimental_hostRpcCalls.length, before);
});

test('unrelated dispatches proceed while metadata cannot release a pending plugin thread', async t => {
  const s = await stand(t);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  assert.equal((await hook(makeMessageDispatchHookContext({ originPluginId: null }))).action, 'proceed');
  assert.equal((await hook(makeMessageDispatchHookContext({ originPluginId: 'promptobus' }))).action, 'wait');
});

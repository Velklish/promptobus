import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext, makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import { openEngine, newTaskIdentity } from 'promptobus';
import plugin from '../.test-build/server.js';
import { engineOperation } from '../.test-build/engine-host.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function stand(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const threads = new Map();
  const environment = { id: 'env', projectId: 'project', path: root, hostId: 'local', managed: false, status: 'ready', lifecycle: { phase: 'active' } };
  const workerEnvironment = { ...environment, id: 'bb-actual-env', path: `${root}/actual-bb-worktree`, managed: true };
  const events = [];
  let initialArgs;
  let nativeCatalogCleared = false;
  let stopStatus = 'idle';
  let behindCount = 0;
  let baseRef;
  let patches = [{ path: 'result.txt', patch: 'diff --git a/result.txt b/result.txt\nnew file mode 100644\n--- /dev/null\n+++ b/result.txt\n@@ -0,0 +1 @@\n+unaccepted result\n', truncated: false }];
  const workspace = env => ({ outcome: 'available', workspace: {
    checkout: { kind: 'branch', headSha: env === 'env' ? 'a'.repeat(40) : 'b'.repeat(40) },
    branch: { currentBranch: env === 'env' ? 'main' : 'actual-bb-branch' },
    mergeBase: { files: [], behindCount, baseRef: baseRef ?? (env === 'env' ? 'a'.repeat(40) : 'b'.repeat(40)) },
    workingTree: { files: patches.map(p => ({ path: p.path, status: '??' })) },
  } });
  let next = 0;
  let host;
  host = createFakePluginHost({ pluginId: 'promptobus', agentSkillIds: Object.values(options.skills ?? {
    worker: 'promptobus-worker', reviewer: 'promptobus-reviewer', approver: 'promptobus-approver',
    teamlead: 'promptobus-teamlead', reporter: 'promptobus-reporter', orchestrator: 'promptobus-orchestrator',
  }), sdk: {
    system: { config: async () => ({ primaryHostId: 'local' }) },
    environments: { get: async ({ environmentId }) => environmentId === 'env' ? environment : workerEnvironment,
      status: async ({ environmentId }) => workspace(environmentId), diffPatch: async ({ paths }) => {
        assert.equal(paths.length > 0, true, 'SDK diffPatch requires at least one path');
        return { outcome: 'available', patches };
      } },
    hosts: { get: async () => ({ id: 'local', status: 'connected', lifecycle: { phase: 'active' } }) },
    threads: {
      get: async ({ threadId }) => { if (!threads.has(threadId)) throw new Error('Thread not found'); return threads.get(threadId); },
      spawn: async args => {
        initialArgs = args;
        nativeCatalogCleared = false;
        const thread = makeThreadResponse({ id: `thr-${++next}`, projectId: args.projectId, environmentId: args.environment.type === 'reuse' ? args.environment.environmentId : null, providerId: args.providerId,
          parentThreadId: args.parentThreadId ?? null, lifecycleOwnerThreadId: args.lifecycleOwnerThreadId ?? null });
        threads.set(thread.id, thread);
        const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
        assert.equal((await hook(makeMessageDispatchHookContext({ thread, origin: 'plugin', originPluginId: 'promptobus' }))).action, 'wait');
        const before = host.harness.inspection.experimental_hostRpcCalls.length;
        await assert.rejects(host.harness.behavior.callAgentTool('promptobus_task', {}, { threadId: thread.id, projectId: 'project' }), /not bound/);
        assert.equal(host.harness.inspection.experimental_hostRpcCalls.length, before);
        if (options.beforeReturn) await options.beforeReturn({ host, thread });
        return thread;
      },
      stop: async ({ threadId }) => { events.push('stop'); const thread = threads.get(threadId); thread.status = thread.runtime.displayStatus = stopStatus; return { ok: true }; },
      wait: async ({ threadId }) => {
        const thread = threads.get(threadId);
        const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
        const context = makeMessageDispatchHookContext({ thread, host: { id: 'local' },
          input: { blocks: [{ type: 'text', text: initialArgs.prompt }], text: initialArgs.prompt } });
        assert.equal((await hook({ ...context, input: { ...context.input, text: 'Do the actual assignment' } })).action, 'wait');
        assert.equal((await hook(context)).action, 'proceed');
        await assert.rejects(host.harness.behavior.callAgentTool('promptobus_task', {}, { threadId, projectId: 'project' }), /not bound/);
        thread.environmentId = workerEnvironment.id; thread.status = thread.runtime.displayStatus = 'idle';
        events.push('provision');
        return { matched: true, target: { kind: 'status', status: 'idle' }, thread };
      },
      clearContext: async () => { nativeCatalogCleared = true; events.push('clear-context'); return { ok: true }; },
      send: async ({ threadId, input }) => { events.push('assignment');
        assert.equal(nativeCatalogCleared, true, 'The preparation native thread retains its empty dynamic tool catalog until Clear context');
        assert.equal(input[0].text.includes('Read mailbox, then stop.'), true);
        assert.equal(input[0].text.includes(workerEnvironment.path), true);
        const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
        assert.equal((await hook(makeMessageDispatchHookContext({ thread: threads.get(threadId) }))).action, 'proceed');
        return { ok: true }; },
      list: async ({ offset = 0, limit = 200 } = {}) => {
        const list = [...threads.values()].filter(t => t.archivedAt === null && t.deletedAt === null).slice(offset, offset + limit);
        if (options.beforeListReturn) await options.beforeListReturn();
        return list;
      },
      archive: async ({ threadId }) => { events.push('archive'); threads.get(threadId).archivedAt = Date.now(); return { ok: true }; },
    },
  }, experimental_callHostRpc: async ({ method, input, hostId }) => {
    assert.equal(hostId, 'local');
    if (options.failFinalize && method === 'engine' && input.operation === 'finalize') throw new Error('Host unavailable');
    if (input.operation === 'check' && options.beforeCheck) await options.beforeCheck();
    if (input.operation === 'preserve') events.push('preserve');
    return engineOperation(input);
  } });
  t.after(() => host.harness.lifecycle.dispose());
  plugin(host.bb);
  const task = newTaskIdentity('engine-test').id;
  const create = async () => host.harness.behavior.runCli(['task', 'create', '--task', task, '--title', 'Engine test', '--project', 'project', '--environment', 'env', '--model', 'test-model', '--assignment', 'Read mailbox, then stop.']);
  const add = async (id, role = 'worker', extra = []) => host.harness.behavior.runCli(['participant', 'add', '--task', task, '--participant', id, '--role', role, '--model', 'test-model', '--assignment', 'Read mailbox, then stop.', ...extra]);
  const call = (id, name, input = {}, projectId = 'project') => host.harness.behavior.callAgentTool(name, input, { threadId: id, projectId });
  const control = (action, id) => host.harness.behavior.runCli(['participant', action, '--task', task, '--participant', id]);
  return { root, threads, environment, workerEnvironment, events, get host() { return host; }, task, create, add, call, control,
    set stopStatus(value) { stopStatus = value; }, set patches(value) { patches = value; },
    set behindCount(value) { behindCount = value; }, set baseRef(value) { baseRef = value; },
    async reload() { host = await host.harness.lifecycle.reload(plugin); } };
}

test('bound tools use host engine canon; peek preserves mail, read acknowledges only the caller, artifacts survive reload', async t => {
  const s = await stand(t);
  assert.equal((await s.create()).exitCode, 0);
  const added = await s.add('worker-one');
  assert.equal(added.exitCode, 0, JSON.stringify(added));
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

test('BB owns new worktree selection; preparation has no bus rights and actual assignment follows Stop and canonical binding', async t => {
  const s = await stand(t);
  await s.create();
  const added = await s.add('worker-new', 'worker', ['--new-environment', '--base-branch', 'main']);
  assert.equal(added.exitCode, 0, JSON.stringify(added));
  assert.deepEqual(s.events, ['provision', 'stop', 'clear-context', 'assignment']);
  const get = await s.control('get', 'worker-new');
  assert.equal(get.exitCode, 0, JSON.stringify(get));
  const actual = JSON.parse(get.stdout);
  assert.equal(actual.environmentId, 'bb-actual-env');
  assert.equal(actual.environmentPath, s.workerEnvironment.path);
  assert.equal(actual.branch, 'actual-bb-branch');
  assert.equal(actual.baseSha, 'b'.repeat(40));
  assert.equal(actual.parentThreadId, 'thr-1');
  assert.equal(actual.lifecycleOwnerThreadId, 'thr-1');
  assert.equal(actual.view.state, 'alive');
  await s.reload();
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  const worker = engine.readTask(s.task).participants.find(p => p.id === 'worker-new');
  assert.equal(worker.metadata.bb.environmentOwner, 'bb');
  assert.equal(worker.metadata.bb.environmentPath, s.workerEnvironment.path);
  assert.equal(worker.sessionRef, 'thr-2');
  assert.equal(JSON.parse((await s.control('get', 'worker-new')).stdout).baseSha, 'b'.repeat(40));
});

test('archive preserves unaccepted patch in stable canon before BB archive and never accepts the task', async t => {
  const s = await stand(t);
  await s.create(); await s.add('worker-new', 'worker', ['--new-environment', '--base-branch', 'main']);
  s.events.length = 0;
  const archive = await s.control('archive', 'worker-new');
  assert.equal(archive.exitCode, 0, JSON.stringify(archive));
  assert.deepEqual(s.events, ['stop', 'preserve', 'archive']);
  const result = JSON.parse(archive.stdout);
  assert.equal(result.accepted, false);
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  const snapshot = JSON.parse(engine.readArtifactContent(s.task, result.preservation.artifactId).toString());
  assert.equal(snapshot.patches[0].patch.includes('unaccepted result'), true);
  assert.equal(snapshot.baseSha, 'b'.repeat(40));
  assert.equal(engine.readTask(s.task).status, 'active');
  await s.reload();
  assert.equal((await s.control('archive', 'worker-new')).exitCode, 0);
  assert.equal(JSON.parse((await s.control('get', 'worker-new')).stdout).phase, 'archived');
  await assert.rejects(s.call('thr-2', 'promptobus_task'), /not bound/);
});

test('unconfirmed Stop, truncated patch and unpreserved lifecycle children block archive across reload', async t => {
  const s = await stand(t);
  await s.create(); await s.add('worker-one');
  assert.equal((await s.control('archive', 'orchestrator')).exitCode, 1);
  assert.equal(s.events.includes('archive'), false);
  s.stopStatus = 'stopping';
  const stopping = await s.control('archive', 'worker-one');
  assert.equal(stopping.exitCode, 1);
  assert.match(stopping.stderr, /Stop was not confirmed/);
  assert.equal(s.events.includes('preserve'), false);
  await s.reload(); s.stopStatus = 'idle';
  s.patches = [{ path: 'result.txt', patch: 'partial patch', truncated: true }];
  const partial = await s.control('archive', 'worker-one');
  assert.equal(partial.exitCode, 1);
  assert.match(partial.stderr, /Incomplete patch/);
  assert.equal(s.events.includes('archive'), false);
  await assert.rejects(s.call('thr-2', 'promptobus_task'), /not bound/);
});

test('untracked binary marker and a foreign SDK lifecycle child are retained', async t => {
  const s = await stand(t);
  await s.create(); await s.add('worker-one');
  s.patches = [{ path: 'result.txt', patch: 'Binary files /dev/null and b/result.txt differ\n', truncated: false }];
  assert.equal((await s.control('archive', 'worker-one')).exitCode, 1);
  assert.equal(s.events.includes('archive'), false);
  s.patches = [];
  assert.equal((await s.control('archive', 'worker-one')).exitCode, 0);
  s.events.length = 0;
  s.threads.set('foreign-child', makeThreadResponse({ id: 'foreign-child', lifecycleOwnerThreadId: 'thr-1' }));
  const result = await s.control('archive', 'orchestrator');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /BB lifecycle child/);
  assert.equal(s.events.includes('archive'), false);
});

test('common merge base or a recorded base ahead of HEAD blocks preservation and archive', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  s.baseRef = 'c'.repeat(40);
  assert.match((await s.control('archive', 'worker-one')).stderr, /diverged from the recorded base/);
  s.baseRef = undefined; s.behindCount = 1;
  assert.match((await s.control('archive', 'worker-one')).stderr, /diverged from the recorded base/);
  assert.equal(s.events.includes('preserve'), false); assert.equal(s.events.includes('archive'), false);
});

test('an add waiting on host validation cannot launch after the owner enters archive', async t => {
  const { promise: entered, resolve: enter } = deferred();
  const { promise: release, resolve } = deferred();
  const s = await stand(t, { beforeCheck: async () => { enter(); await release; } });
  await s.create();
  const add = s.add('late-worker'); await entered;
  assert.equal((await s.control('archive', 'orchestrator')).exitCode, 0);
  resolve();
  const result = await add;
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /no longer ready/);
  assert.equal(s.threads.size, 1);
});

test('archive waiting on SDK scan sees a child reserved before its phase change', async t => {
  const { promise: entered, resolve: enter } = deferred();
  const { promise: release, resolve } = deferred();
  const s = await stand(t, { beforeListReturn: async () => { enter(); await release; } });
  await s.create();
  const archive = s.control('archive', 'orchestrator'); await entered;
  assert.equal((await s.add('early-worker')).exitCode, 0);
  resolve();
  const result = await archive;
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /children first/);
  assert.equal(s.events.includes('archive'), false); assert.equal(s.threads.get('thr-2').archivedAt, null);
});

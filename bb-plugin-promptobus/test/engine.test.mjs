import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext, makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import { openEngine, newTaskIdentity } from 'promptobus';
import plugin from '../.test-build/server.js';
import { engineOperation } from '../.test-build/engine-host.js';
import { bindingStore } from '../.test-build/bindings.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function stand(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const threads = new Map();
  const executionOptions = new Map();
  const metadata = new Map();
  const history = new Map(); const queues = new Map(); const interactions = new Map(); const wakes = [];
  const append = (id, type, data = {}) => {
    const rows = history.get(id) ?? []; const seq = (rows.at(-1)?.seq ?? 0) + 1;
    const row = { id: `event-${id}-${seq}`, threadId: id, seq, createdAt: Date.now(), scope: { kind: 'thread' }, type, data };
    rows.push(row); history.set(id, rows); return row;
  };
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
    system: { config: async () => ({ primaryHostId: 'local' }),
      providerStates: async () => ({ providers: [{ providerId: 'codex', status: 'ready' }] }),
      usageLimits: async () => ({ codex: { status: 'ok', windows: [{ label: '5h', usedPercent: 21, resetsAt: null }] } }) },
    providers: { list: async () => ['codex', 'promptobus-codex-reviewer'].map(id => ({ id, available: true, family: 'codex',
      capabilities: { modelCatalogScope: 'host' }, maintenance: { health: id === 'codex', usage: id === 'codex' } })),
      models: async () => ({ modelLoadError: options.modelLoadError ?? null, models: [{ id: 'test-model', model: 'test-model', defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] }) },
    environments: { get: async ({ environmentId }) => environmentId === 'env' ? environment : workerEnvironment,
      status: async ({ environmentId }) => workspace(environmentId), diffPatch: async ({ paths }) => {
        assert.equal(paths.length > 0, true, 'SDK diffPatch requires at least one path');
        return { outcome: 'available', patches };
      } },
    hosts: { get: async () => ({ id: 'local', status: 'connected', lifecycle: { phase: 'active' } }) },
    threads: {
      events: { list: async ({ threadId, afterSeq = '0', order = 'asc', limit = '200', types }) => {
        assert.equal(Number(limit) <= 100, true, 'Thread event limit cannot exceed 100');
        const rows = (history.get(threadId) ?? []).filter(row => row.seq > Number(afterSeq) && (!types || types.includes(row.type)));
        return (order === 'desc' ? [...rows].reverse() : rows).slice(0, Number(limit));
      } },
      interactions: { list: async ({ threadId }) => interactions.get(threadId) ?? [] },
      queuedMessages: {
        list: async ({ threadId }) => queues.get(threadId) ?? [],
        delete: async ({ threadId, queuedMessageId }) => {
          const entries = queues.get(threadId) ?? []; const entry = entries.find(row => row.id === queuedMessageId);
          queues.set(threadId, entries.filter(row => row.id !== queuedMessageId));
          if (entry) await host.harness.behavior.emitThreadEvent('message.cancelled', { entry });
          return { ok: true };
        },
      },
      get: async ({ threadId }) => { if (!threads.has(threadId)) throw new Error('Thread not found');
        if (options.beforeGet) await options.beforeGet(threadId); return threads.get(threadId); },
      defaultExecutionOptions: async ({ threadId }) => executionOptions.get(threadId) ?? null,
      spawn: async args => {
        initialArgs = args;
        nativeCatalogCleared = false;
        const thread = makeThreadResponse({ id: `thr-${++next}`, projectId: args.projectId, environmentId: args.environment.type === 'reuse' ? args.environment.environmentId : null, providerId: args.providerId,
          parentThreadId: args.parentThreadId ?? null, lifecycleOwnerThreadId: args.lifecycleOwnerThreadId ?? null });
        threads.set(thread.id, thread);
        executionOptions.set(thread.id, { model: args.model, reasoningLevel: args.reasoningLevel, permissionMode: args.permissionMode,
          serviceTier: 'default', source: 'client/thread/start' });
        metadata.set(thread.id, args.pluginMetadata ?? {});
        const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
        assert.equal((await hook(makeMessageDispatchHookContext({ thread, origin: 'plugin', originPluginId: 'promptobus' }))).action, 'wait');
        const before = host.harness.inspection.experimental_hostRpcCalls.length;
        await assert.rejects(host.harness.behavior.callAgentTool('promptobus_task', {}, { threadId: thread.id, projectId: 'project' }), /not bound/);
        assert.equal(host.harness.inspection.experimental_hostRpcCalls.length, before);
        if (options.beforeReturn) await options.beforeReturn({ host, thread });
        if (options.ambiguousSpawn) throw new Error('Spawn response was lost');
        return thread;
      },
      getPluginMetadata: async ({ threadId, pluginId }) => {
        assert.equal(pluginId, 'promptobus'); return metadata.get(threadId) ?? {};
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
        if (options.beforePreparationIdle) await options.beforePreparationIdle({ threadId, append, thread });
        thread.environmentId = workerEnvironment.id; thread.status = thread.runtime.displayStatus = 'idle';
        events.push('provision');
        return { matched: true, target: { kind: 'status', status: 'idle' }, thread };
      },
      clearContext: async () => { nativeCatalogCleared = true; events.push('clear-context'); return { ok: true }; },
      send: async ({ threadId, input, mode }) => {
        if (input[0].text.startsWith('Promptobus mailbox wake: ')) {
          wakes.push({ threadId, input, mode });
          if (options.wakeSend) return options.wakeSend({ threadId, input, mode, append, queues, threads, host });
          const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
          const admitted = await hook(makeMessageDispatchHookContext({ thread: threads.get(threadId), input: { blocks: input, text: input[0].text } }));
          assert.equal(admitted.action, 'proceed', JSON.stringify(admitted));
          append(threadId, 'client/turn/requested', { input });
          const thread = threads.get(threadId); thread.status = thread.runtime.displayStatus = 'active';
          return { ok: true, delivery: 'sent' };
        }
        if (options.assignmentSend) return options.assignmentSend({ threadId, input, mode, threads, host });
        events.push('assignment');
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
    if (input.operation === 'finalize' && options.beforeFinalize) await options.beforeFinalize(input);
    if (input.operation === 'check' && options.beforeCheck) await options.beforeCheck();
    if (input.operation === 'preserve') events.push('preserve');
    return engineOperation(input);
  } });
  t.after(() => host.harness.lifecycle.dispose());
  plugin(host.bb);
  const task = newTaskIdentity('engine-test').id;
  const create = async (extra = []) => host.harness.behavior.runCli(['task', 'create', '--task', task, '--title', 'Engine test', '--project', 'project', '--environment', 'env', '--model', 'test-model', '--assignment', 'Read mailbox, then stop.', ...extra]);
  const add = async (id, role = 'worker', extra = []) => host.harness.behavior.runCli(['participant', 'add', '--task', task, '--participant', id, '--role', role, '--model', 'test-model', '--assignment', 'Read mailbox, then stop.', ...extra]);
  const call = (id, name, input = {}, projectId = 'project') => host.harness.behavior.callAgentTool(name, input, { threadId: id, projectId });
  const control = (action, id) => host.harness.behavior.runCli(['participant', action, '--task', task, '--participant', id]);
  return { root, threads, environment, workerEnvironment, events, get host() { return host; }, task, create, add, call, control,
    wakes, queues, interactions, append, executionOptions, get initialArgs() { return initialArgs; },
    reconcile: () => host.harness.behavior.runCli(['recovery', 'run']),
    delivery: id => bindingStore(host.bb).delivery(id),
    updateDelivery: (id, update) => bindingStore(host.bb).updateDelivery(id, update),
    finish(id, status = 'completed') { append(id, 'turn/completed', { status }); const thread = threads.get(id); thread.status = thread.runtime.displayStatus = 'idle'; },
    set stopStatus(value) { stopStatus = value; }, set patches(value) { patches = value; },
    set behindCount(value) { behindCount = value; }, set baseRef(value) { baseRef = value; },
    async reload() { host = await host.harness.lifecycle.reload(plugin); } };
}

test('BB launch persists explicit provider/model/reasoning and sends the same selection to SDK', async t => {
  const s = await stand(t);
  assert.equal((await s.create(['--provider', 'codex', '--reasoning-level', 'high'])).exitCode, 0);
  assert.equal(s.initialArgs.providerId, 'codex');
  assert.equal(s.initialArgs.model, 'test-model');
  assert.equal(s.initialArgs.reasoningLevel, 'high');
  const selected = bindingStore(s.host.bb).thread('thr-1').execution;
  assert.equal(selected.runtime, 'bb'); assert.equal(selected.harness, 'codex');
  assert.equal(selected.providerId, 'codex'); assert.equal(selected.model, 'test-model');
  assert.equal(selected.reasoningLevel, 'high'); assert.equal(selected.reasoningSource, 'explicit');
  assert.equal(selected.scope.environmentId, 'env'); assert.equal(selected.scope.hostId, 'local');
  const canonical = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false }).readTask(s.task);
  assert.equal(canonical.participants[0].harness, 'bb');
  assert.deepEqual(canonical.participants[0].metadata.bb.execution, selected);
  await s.reload();
  assert.deepEqual(bindingStore(s.host.bb).thread('thr-1').execution, selected);
  s.executionOptions.get('thr-1').reasoningLevel = 'low';
  const observed = JSON.parse((await s.control('get', 'orchestrator')).stdout);
  assert.deepEqual(observed.execution, selected);
  assert.equal(observed.currentExecution.reasoningLevel, 'low');
});

test('BB role policy refuses an explicit provider mismatch without canonical reservation or spawn', async t => {
  const s = await stand(t); await s.create();
  const before = s.host.harness.inspection.experimental_hostRpcCalls.length;
  const result = await s.add('unsafe-reviewer', 'reviewer', ['--provider', 'codex']);
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /reviewer.*promptobus-codex-reviewer/);
  assert.equal(s.threads.size, 1);
  assert.equal(s.host.harness.inspection.experimental_hostRpcCalls.slice(before).some(call => call.input.operation === 'reserve'), false);
  assert.equal(bindingStore(s.host.bb).participant(s.task, 'unsafe-reviewer'), undefined);
});

test('BB reviewer uses its own provider and does not reuse the owner quota selection', async t => {
  const s = await stand(t); await s.create(['--reasoning-level', 'high']);
  assert.equal((await s.add('reviewer-one', 'reviewer')).exitCode, 0);
  const execution = bindingStore(s.host.bb).thread('thr-2').execution;
  assert.equal(s.initialArgs.providerId, 'promptobus-codex-reviewer');
  assert.equal(s.initialArgs.reasoningLevel, 'low');
  assert.equal(execution.quota.status, 'unknown'); assert.deepEqual(execution.quota.windows, []);
  const canonical = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false }).readTask(s.task);
  assert.deepEqual(canonical.participants.find(p => p.id === 'reviewer-one').metadata.bb.execution, execution);
});

test('the BB CLI rejects native harness and strategy flags before any task or thread creation', async t => {
  const s = await stand(t);
  for (const args of [['--harness', 'claude'], ['--strategy', 'cheap']]) {
    const result = await s.create(args);
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /unknown option/);
    assert.equal(s.threads.size, 0); assert.equal(bindingStore(s.host.bb).task(s.task), undefined);
  }
});

test('unknown BB model availability fails before a canonical task, binding or thread exists', async t => {
  const s = await stand(t, { modelLoadError: { code: 'timeout', providerId: 'codex', detail: null } });
  const result = await s.create();
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /model availability is unknown: timeout/);
  assert.equal(s.threads.size, 0); assert.equal(bindingStore(s.host.bb).task(s.task), undefined);
  assert.equal(s.host.harness.inspection.experimental_hostRpcCalls.length, 0);
});

test('wake hints and duplicate BB announcements do not ACK or repeat canonical consumption across reload', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  const sent = JSON.parse(await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Unread work hint' }));
  await s.reconcile(); assert.equal(s.wakes.length, 1); assert.equal(s.wakes[0].mode, 'queue-if-active');
  assert.ok(s.wakes[0].input[0].text.includes(sent.message.id));
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  assert.equal(engine.unread(s.task, 'worker-one'), 1);
  for (let i = 0; i < 3; i++) await s.host.harness.behavior.emitThreadEvent('experimental_thread.events', { thread: s.threads.get('thr-2'), sequence: 1 });
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.length, 1);
  assert.equal(JSON.parse(await s.call('thr-2', 'promptobus_mailbox', { mode: 'read' })).messages.length, 1);
  assert.equal(JSON.parse(await s.call('thr-2', 'promptobus_mailbox', { mode: 'read' })).messages.length, 0);
  s.finish('thr-2'); await s.reconcile(); assert.equal(s.wakes.length, 1); assert.equal(s.delivery('thr-2').pending, null);
});

test('recovery closes the canon-to-outbox crash gap and reconciles a lost accepted send without another executor', async t => {
  const s = await stand(t, { wakeSend({ threadId, input, append, threads }) {
    append(threadId, 'client/turn/requested', { input }); const thread = threads.get(threadId);
    thread.status = thread.runtime.displayStatus = 'active'; throw new Error('Accepted send response was lost');
  } });
  await s.create(); await s.add('worker-one');
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  engine.sendSync(s.task, { from: 'orchestrator', to: ['worker-one'], type: 'status', body: 'Committed just before server crash' });
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.length, 1); assert.equal(s.delivery('thr-2').pending.state, 'unknown');
  await s.reload(); await s.reconcile();
  assert.equal(s.delivery('thr-2').pending.state, 'sent'); assert.equal(s.wakes.length, 1); assert.equal(s.threads.size, 2);
  assert.equal(engine.unread(s.task, 'worker-one'), 1);
});

for (const ambiguous of [false, true]) test(`queued wake${ambiguous ? ' with lost reply' : ''} survives reload without duplicate send or mailbox ACK`, async t => {
  const s = await stand(t, { wakeSend({ threadId, input, queues }) {
    const entry = { id: 'queued-wake', threadId, content: input }; queues.set(threadId, [entry]);
    if (ambiguous) throw new Error('Queued response was lost');
    return { ok: true, delivery: 'queued', queuedMessage: entry, waitingOn: { kind: 'interaction' } };
  } });
  await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Durable queued mail' });
  await s.reconcile(); await s.reload(); await s.reconcile();
  assert.equal(s.wakes.length, 1); assert.equal(s.delivery('thr-2').pending.state, 'queued');
  assert.equal(s.delivery('thr-2').pending.queuedId, 'queued-wake');
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  assert.equal(engine.unread(s.task, 'worker-one'), 1);
  const resumed = await s.control('resume', 'worker-one');
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert.equal(s.delivery('thr-2').paused, false, 'Internal queue cancellation must not become a user Stop');
  assert.equal(s.wakes.length, 2);
});

test('pending interaction defers wake, a denied interaction pauses it, and replay remains idempotent', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  s.interactions.set('thr-2', [{ id: 'approval' }]);
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Wait for interaction' });
  await s.reconcile(); assert.equal(s.wakes.length, 0);
  s.interactions.set('thr-2', []); await s.reconcile(); assert.equal(s.wakes.length, 1);
  s.finish('thr-2'); s.append('thr-2', 'system/interaction/lifecycle', { interaction: { status: 'resolved', resolution: { decision: 'deny' } } });
  await s.reconcile(); const epoch = s.delivery('thr-2').epoch;
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.length, 1);
  assert.equal(s.delivery('thr-2').paused, true); assert.equal(s.delivery('thr-2').epoch, epoch);
});

test('operator Stop wins over a late queued send response and stays paused after reload until explicit resume', async t => {
  const entered = deferred(); const reply = deferred();
  let queued = true;
  const s = await stand(t, { async wakeSend({ threadId, input, queues, append, threads }) {
    if (queued) {
      const entry = { id: 'late-queued', threadId, content: input }; queues.set(threadId, [entry]); entered.resolve();
      await reply.promise; return { ok: true, delivery: 'queued', queuedMessage: entry, waitingOn: { kind: 'thread-busy' } };
    }
    append(threadId, 'client/turn/requested', { input }); const thread = threads.get(threadId); thread.status = thread.runtime.displayStatus = 'active';
    return { ok: true, delivery: 'sent' };
  } });
  await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Stop while send is unresolved' });
  await entered.promise;
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0);
  const epoch = s.delivery('thr-2').epoch; const oldText = s.wakes[0].input[0].text;
  reply.resolve(); await s.reconcile(); assert.deepEqual(s.queues.get('thr-2'), []);
  assert.equal(s.delivery('thr-2').pending, null); assert.equal(s.delivery('thr-2').epoch, epoch);
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.length, 1); assert.equal(s.delivery('thr-2').paused, true);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const admission = await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), input: { blocks: [{ type: 'text', text: oldText }], text: oldText } }));
  assert.equal(admission.action, 'reject');
  queued = false; const resumed = await s.control('resume', 'worker-one'); assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert.equal(s.wakes.length, 2); assert.equal(s.delivery('thr-2').paused, false);
});

test('operator Stop during launch finalization cancels the initial assignment and retains the recorded thread', async t => {
  const entered = deferred(); const release = deferred();
  const s = await stand(t, { async beforeFinalize(input) {
    if (input.binding.participant === 'worker-one') { entered.resolve(); await release.promise; }
  } });
  await s.create();
  const adding = s.add('worker-one', 'worker', ['--new-environment', '--base-branch', 'main']);
  await entered.promise;
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0);
  release.resolve(); const added = await adding;
  assert.equal(added.exitCode, 1, 'A stopped launch must require operator recovery');
  assert.match(added.stderr, /stopped during launch/);
  assert.equal(s.events.includes('assignment'), false, 'Stop must suppress the automatic initial assignment');
  assert.equal(s.delivery('thr-2').paused, true);
  assert.equal(bindingStore(s.host.bb).thread('thr-2').phase, 'orphan');
  assert.equal(s.threads.get('thr-2').status, 'idle');
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.length, 0); assert.equal(s.threads.size, 2);
});

test('active BB Stop during preparation is replayed before arming the first assignment', async t => {
  const s = await stand(t, { beforePreparationIdle({ threadId, append, thread }) {
    thread.status = thread.runtime.displayStatus = 'active';
    append(threadId, 'system/thread/interrupted', {});
    append(threadId, 'turn/completed', { status: 'interrupted' });
  } });
  await s.create();
  const added = await s.add('worker-one', 'worker', ['--new-environment', '--base-branch', 'main']);
  assert.equal(added.exitCode, 1, 'Interrupted preparation must not be treated as a completed launch');
  assert.equal(s.events.includes('assignment'), false); assert.equal(s.delivery('thr-2').paused, true);
  assert.equal(s.delivery('thr-2').cursor, 2); assert.equal(s.threads.get('thr-2').status, 'idle');
  assert.equal(bindingStore(s.host.bb).thread('thr-2').phase, 'orphan');
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.length, 0);
});

test('operator Stop while wake dispatch validates the host rejects the late admission', async t => {
  const entered = deferred(); const release = deferred(); let block = false; let admission;
  const s = await stand(t, { async beforeCheck() { if (block) { entered.resolve(); await release.promise; } },
    async wakeSend({ threadId, input, host, threads, append }) {
      const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
      admission = await hook(makeMessageDispatchHookContext({ thread: threads.get(threadId), origin: 'plugin', originPluginId: 'promptobus',
        input: { blocks: input, text: input[0].text } }));
      if (admission.action !== 'proceed') throw new Error('Wake admission rejected');
      append(threadId, 'client/turn/requested', { input });
      threads.get(threadId).status = threads.get(threadId).runtime.displayStatus = 'active';
      return { ok: true, delivery: 'sent' };
    } });
  await s.create(); await s.add('worker-one'); block = true;
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  engine.sendSync(s.task, { from: 'orchestrator', to: ['worker-one'], type: 'status', body: 'Stop during validation' });
  const running = s.reconcile(); await entered.promise;
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0);
  release.resolve(); await running;
  assert.equal(admission.action, 'reject', 'Late admission must check the current Stop state');
  assert.equal(s.threads.get('thr-2').status, 'idle'); assert.equal(s.delivery('thr-2').paused, true);
  assert.equal(engine.unread(s.task, 'worker-one'), 1);
  block = false;
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const input = { blocks: [{ type: 'text', text: 'Initial assignment' }], text: 'Initial assignment' };
  assert.equal((await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), origin: 'plugin', originPluginId: 'promptobus', input }))).action, 'reject');
  assert.equal((await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), origin: 'user', input }))).action, 'proceed');
});

test('initial SDK send with no plugin attribution is refused when Stop finishes during host validation', async t => {
  const entered = deferred(); const release = deferred(); let block = false; let admission;
  const s = await stand(t, { async beforeCheck() { if (block) { entered.resolve(); await release.promise; } },
    async assignmentSend({ threadId, input, host, threads }) {
      block = true;
      const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
      admission = await hook(makeMessageDispatchHookContext({ thread: threads.get(threadId), origin: null, originPluginId: null,
        input: { blocks: input, text: input[0].text } }));
      if (admission.action !== 'proceed') throw new Error('Initial assignment admission rejected');
      threads.get(threadId).status = threads.get(threadId).runtime.displayStatus = 'active';
      return { ok: true, delivery: 'sent' };
    } });
  await s.create();
  const adding = s.add('worker-one', 'worker', ['--new-environment', '--base-branch', 'main']);
  await entered.promise; assert.equal((await s.control('stop', 'worker-one')).exitCode, 0);
  release.resolve(); const added = await adding;
  assert.equal(admission.action, 'reject', 'Initial assignment admission cannot depend on SDK origin attribution');
  assert.equal(added.exitCode, 1); assert.equal(s.threads.get('thr-2').status, 'idle');
  assert.equal(s.delivery('thr-2').paused, true);
});

test('active interruption after a full history page pauses delivery without replaying or reviving it', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  for (let i = 0; i < 200; i++) s.append('thr-2', 'turn/completed', { status: 'completed' });
  s.append('thr-2', 'system/thread/interrupted', {});
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Mail after user interruption' });
  await s.reconcile(); assert.equal(s.delivery('thr-2').cursor, 201); assert.equal(s.delivery('thr-2').paused, true);
  assert.equal(s.wakes.length, 0); const epoch = s.delivery('thr-2').epoch;
  await s.reload(); await s.reconcile(); assert.equal(s.delivery('thr-2').epoch, epoch); assert.equal(s.wakes.length, 0);
});

test('active Stop recorded after replay and before idle observation prevents a new wake despite overlapping announcements', async t => {
  const entered = deferred(); const release = deferred(); let block = false;
  const s = await stand(t, { async beforeGet(id) {
    if (block && id === 'thr-2') { block = false; entered.resolve(); await release.promise; }
  } });
  await s.create(); await s.add('worker-one');
  const thread = s.threads.get('thr-2'); thread.status = thread.runtime.displayStatus = 'active';
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  engine.sendSync(s.task, { from: 'orchestrator', to: ['worker-one'], type: 'status', body: 'Unread during active Stop' });
  block = true; const running = s.reconcile(); await entered.promise;
  const interrupted = s.append('thr-2', 'system/thread/interrupted', {});
  thread.status = thread.runtime.displayStatus = 'idle';
  const announced = s.host.harness.behavior.emitThreadEvent('experimental_thread.events', { thread, sequence: interrupted.seq });
  release.resolve(); await Promise.all([running, announced]);
  assert.equal(s.wakes.length, 0, 'Interruption committed during observation must be replayed before another wake');
  assert.equal(thread.status, 'idle'); assert.equal(s.delivery('thr-2').paused, true);
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.length, 0); assert.equal(engine.unread(s.task, 'worker-one'), 1);
});

test('dispatch replays interruption committed during host validation without waiting for an announcement', async t => {
  const entered = deferred(); const release = deferred(); let block = false; let admission;
  const s = await stand(t, { async beforeCheck() { if (block) { entered.resolve(); await release.promise; } },
    async wakeSend({ threadId, input, host, threads }) {
      const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
      admission = await hook(makeMessageDispatchHookContext({ thread: threads.get(threadId), input: { blocks: input, text: input[0].text } }));
      if (admission.action !== 'proceed') throw new Error('Wake admission rejected');
      threads.get(threadId).status = threads.get(threadId).runtime.displayStatus = 'active';
      return { ok: true, delivery: 'sent' };
    } });
  await s.create(); await s.add('worker-one'); block = true;
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  engine.sendSync(s.task, { from: 'orchestrator', to: ['worker-one'], type: 'status', body: 'Interruption during dispatch validation' });
  const running = s.reconcile(); await entered.promise;
  s.append('thr-2', 'system/thread/interrupted', {});
  release.resolve(); await running;
  assert.equal(admission.action, 'reject'); assert.equal(s.threads.get('thr-2').status, 'idle');
  assert.equal(s.delivery('thr-2').paused, true); assert.equal(engine.unread(s.task, 'worker-one'), 1);
});

test('an ambiguous unobserved send is replayed before bounded retry, and unread hints cannot loop without new mail', async t => {
  const s = await stand(t, { wakeSend() { throw new Error('No send receipt'); } });
  await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'No receipt' }); await s.reconcile();
  assert.equal(s.wakes.length, 1);
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.length, 1);
  for (let i = 0; i < 3; i++) {
    s.updateDelivery('thr-2', state => { state.pending.at = Date.now() - 31_000; }); await s.reconcile();
  }
  assert.equal(s.wakes.length, 3); assert.match(s.delivery('thr-2').reason, /budget exhausted/);
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.length, 3); assert.equal(s.threads.size, 2);
});

test('ACK without canonical result gets two turn-boundary continuations, then requires explicit operator recovery', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'task', body: 'Canonical result obligation' }); await s.reconcile();
  await s.call('thr-2', 'promptobus_mailbox', { mode: 'read' });
  for (let i = 0; i < 3; i++) { s.finish('thr-2'); await s.reconcile(); }
  assert.equal(s.wakes.filter(wake => wake.threadId === 'thr-2').length, 3);
  assert.equal(s.delivery('thr-2').continuations, 2); assert.match(s.delivery('thr-2').reason, /budget exhausted/);
  await s.reload(); await s.reconcile(); assert.equal(s.wakes.filter(wake => wake.threadId === 'thr-2').length, 3);
  await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'result', body: 'Canonical terminal evidence' }); await s.reconcile();
  assert.equal(s.delivery('thr-2').obligation, null); assert.equal(s.delivery('thr-2').pending, null);
});

test('lost spawn response retains launch intent and exposes candidates without a second executor or automatic binding', async t => {
  let intentDuringSpawn;
  const s = await stand(t, { ambiguousSpawn: true, beforeReturn({ host }) {
    const store = bindingStore(host.bb); const b = store.list()[0];
    intentDuringSpawn = store.launchIntent(b); assert.equal(b.threadId, null);
  } });
  const result = await s.create();
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /response was lost/);
  assert.equal(intentDuringSpawn?.status, 'requested', 'Intent must be durable before the SDK response');
  assert.equal(intentDuringSpawn.assignment, 'Read mailbox, then stop.'); assert.equal(intentDuringSpawn.model, 'test-model');
  await s.reload();
  const inspect = await s.host.harness.behavior.runCli(['recovery', 'inspect', '--task', s.task, '--participant', 'orchestrator']);
  assert.equal(inspect.exitCode, 0, inspect.stderr);
  const state = JSON.parse(inspect.stdout);
  assert.equal(state.phase, 'orphan'); assert.equal(state.threadId, null);
  assert.equal(state.launch.status, 'unknown'); assert.equal(state.automaticallyRebound, false);
  assert.deepEqual(state.candidates, [{ threadId: 'thr-1', environmentId: 'env', status: 'idle' }]);
  assert.equal(s.threads.size, 1);
  await assert.rejects(s.call('thr-1', 'promptobus_task'), /not bound/);
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  assert.equal(engine.readTask(s.task).participants[0].sessionRef, null);
});

test('recovery distinguishes canonical mailbox ACK from an outstanding task result across reload', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  const sent = JSON.parse(await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'task', body: 'Produce the assigned result' }));
  const pending = () => engineOperation({ binding: bindingStore(s.host.bb).thread('thr-2'), operation: 'pending' });
  const before = await pending();
  assert.deepEqual(before.ids, [sent.message.id]); assert.equal(before.obligation, sent.message.id);
  await s.call('thr-2', 'promptobus_mailbox', { mode: 'read' });
  await s.reload();
  const acknowledged = await pending();
  assert.deepEqual(acknowledged.ids, []); assert.equal(acknowledged.obligation, sent.message.id);
  assert.notEqual(acknowledged.revision, before.revision);
  await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'result', body: 'Assigned result' });
  assert.equal((await pending()).obligation, null);
  await s.call('thr-1', 'promptobus_mailbox', { mode: 'read' });
  await s.reload(); assert.equal((await pending()).obligation, null);
});

test('delivery cursor and pause survive reload independently of a stale lifecycle binding save', async t => {
  const s = await stand(t); await s.create();
  const store = bindingStore(s.host.bb); const stale = store.thread('thr-1');
  store.updateDelivery('thr-1', state => { state.cursor = 37; state.paused = true; state.epoch += 1; state.reason = 'Operator Stop'; });
  store.save(stale);
  await s.reload();
  const restored = bindingStore(s.host.bb).delivery('thr-1');
  assert.equal(restored.cursor, 37); assert.equal(restored.epoch, 1); assert.equal(restored.paused, true);
  assert.equal(restored.reason, 'Operator Stop');
});

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

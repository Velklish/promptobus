import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext, makeMessageDispatchHookContext } from '@get-bb/plugin-sdk/testing';
import { openEngine, newTaskIdentity } from 'promptobus';
import plugin from '../.test-build/server.js';
import { engineOperation } from '../.test-build/engine-host.js';
import { bindingStore } from '../.test-build/bindings.js';
import { createHostEntry } from '../.test-build/host-integration.js';
import { createBbHostIntegration } from 'promptobus/bb-host';
import { launchFixture, evidenceFixture } from './evidence-fixture.mjs';
import { digest, evidenceManifestSchema } from '../.test-build/review-evidence.js';
import { contextDeclarationSchema } from '../.test-build/protocol.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function stand(t, options = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pb-bb-engine-')));
  const hostEntry = options.hostSetup?.(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const threads = new Map();
  const executionOptions = new Map();
  const metadata = new Map();
  const history = new Map(); const queues = new Map(); const interactions = new Map(); const wakes = [];
  const append = (id, type, data = {}) => {
    const rows = history.get(id) ?? []; const seq = (rows.at(-1)?.seq ?? 0) + 1;
    if (type === 'client/turn/requested' || type === 'client/turn/rejected') data = { requestId: `request-${id}-${seq}`, ...data };
    const row = { id: `event-${id}-${seq}`, threadId: id, seq, createdAt: Date.now(), scope: { kind: 'thread' }, type, data };
    rows.push(row); history.set(id, rows); return row;
  };
  const environment = { name: null, environmentProviderInstanceKey: null, id: 'env', projectId: 'project', path: root, hostId: 'local', managed: false, status: 'ready', lifecycle: { phase: 'active' } };
  const workerEnvironment = { ...environment, id: 'bb-actual-env', path: `${root}/actual-bb-worktree`, managed: true };
  const environments = new Map([environment, workerEnvironment, ...(options.environments ?? [])].map(e => [e.id, e]));
  const names = []; const spawns = [];
  const events = [];
  const catalogs = new Map();
  const freezeCatalog = async thread => {
    const env = environments.get(thread.environmentId) ?? environment;
    const config = await host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
      thread, project: { id: thread.projectId }, environment: { id: env.id, path: env.path },
      host: { id: env.hostId }, provider: { id: thread.providerId },
    }));
    catalogs.set(thread.id, config.tools.map(tool => tool.name));
  };
  let initialArgs;
  let nativeCatalogCleared = false;
  let stopStatus = 'idle';
  let behindCount = 0;
  let baseRef;
  let headSha = 'a'.repeat(40);
  let patches = [{ path: 'result.txt', patch: 'diff --git a/result.txt b/result.txt\nnew file mode 100644\n--- /dev/null\n+++ b/result.txt\n@@ -0,0 +1 @@\n+unaccepted result\n', truncated: false }];
  const workspace = env => ({ outcome: 'available', workspace: {
    checkout: { kind: 'branch', headSha: env === 'env' ? headSha : 'b'.repeat(40) },
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
    providers: { list: async () => ['codex', 'promptobus-codex-reviewer', 'acp-cursor', 'acp-opencode'].map(id => ({ id, available: true,
      family: id.startsWith('acp-') ? 'acp' : 'codex', capabilities: { modelCatalogScope: 'host', permissionModes: ['accept-edits'] },
      maintenance: { health: id === 'codex', usage: id === 'codex' } })),
      models: async () => ({ modelLoadError: options.modelLoadError ?? null, models: [{ id: 'test-model', model: 'test-model', defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] }) },
    environments: { get: async ({ environmentId }) => environments.get(environmentId),
      update: async ({ environmentId, name }) => {
        names.push({ environmentId, name });
        if (options.nameError) throw new Error(options.nameError);
        const env = environments.get(environmentId);
        if (!options.nameUnconfirmed) env.name = name;
        return env;
      },
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
          if (options.beforeQueueDelete) await options.beforeQueueDelete();
          const entries = queues.get(threadId) ?? []; const entry = entries.find(row => row.id === queuedMessageId);
          queues.set(threadId, entries.filter(row => row.id !== queuedMessageId));
          if (entry) await host.harness.behavior.emitThreadEvent('message.cancelled', { entry });
          return { ok: true };
        },
      },
      get: async ({ threadId, signal }) => { if (!threads.has(threadId)) throw new Error('Thread not found');
        if (options.beforeGet) await options.beforeGet(threadId, signal); return threads.get(threadId); },
      update: async ({ threadId, title }) => {
        if (options.titleUpdateError) throw new Error(options.titleUpdateError);
        const thread = threads.get(threadId); if (!options.titleUpdateUnconfirmed) thread.title = title; return thread;
      },
      defaultExecutionOptions: async ({ threadId }) => executionOptions.get(threadId) ?? null,
      spawn: async args => {
        initialArgs = args; spawns.push(args);
        nativeCatalogCleared = false;
        const thread = makeThreadResponse({ id: `thr-${++next}`, projectId: args.projectId, environmentId: args.environment.type === 'reuse' ? args.environment.environmentId : null, providerId: args.providerId,
          parentThreadId: args.parentThreadId ?? null, lifecycleOwnerThreadId: args.lifecycleOwnerThreadId ?? null, title: options.titleUnconfirmed ? 'Unconfirmed title' : args.title });
        threads.set(thread.id, thread);
        executionOptions.set(thread.id, { model: args.model, reasoningLevel: args.reasoningLevel, permissionMode: args.permissionMode,
          serviceTier: 'default', source: 'client/thread/start' });
        metadata.set(thread.id, args.pluginMetadata ?? {});
        if (options.freezeEarlyCatalog) await freezeCatalog(thread);
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
        workerEnvironment.environmentProviderInstanceKey = options.existingEnvironment ? 'another-thread' : threadId;
        thread.environmentId = initialArgs.environment.type === 'reuse' ? initialArgs.environment.environmentId : workerEnvironment.id;
        thread.status = thread.runtime.displayStatus = 'idle';
        if (options.afterPreparationIdle) await options.afterPreparationIdle({ thread, environment: workerEnvironment });
        events.push('provision');
        return { matched: options.preparationMatched ?? true, target: { kind: 'status', status: 'idle' }, thread };
      },
      clearContext: async ({ threadId }) => {
        if (options.beforeClearContext) await options.beforeClearContext(threadId);
        nativeCatalogCleared = true; catalogs.delete(threadId); events.push('clear-context');
        return { ok: true };
      },
      send: async ({ threadId, input, mode }) => {
        if (input[0].text.startsWith('Promptobus mailbox wake: ')) {
          wakes.push({ threadId, input, mode });
          if (options.wakeSend) return options.wakeSend({ threadId, input, mode, append, queues, threads, host });
          const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
          const admitted = await hook(makeMessageDispatchHookContext({ thread: threads.get(threadId), originPluginId: null, input: { blocks: input, text: input[0].text } }));
          assert.equal(admitted.action, 'proceed', JSON.stringify(admitted));
          append(threadId, 'client/turn/requested', { input });
          const thread = threads.get(threadId); thread.status = thread.runtime.displayStatus = 'active';
          return { ok: true, delivery: 'sent' };
        }
        if (options.assignmentSend) return options.assignmentSend({ threadId, input, mode, threads, host });
        events.push('assignment');
        if (options.freezeEarlyCatalog && !catalogs.has(threadId)) await freezeCatalog(threads.get(threadId));
        assert.equal(nativeCatalogCleared, true, 'The preparation native thread retains its empty dynamic tool catalog until Clear context');
        assert.equal(input[0].text.includes('Read mailbox, then stop.'), true);
        assert.equal(input[0].text.includes(environments.get(threads.get(threadId).environmentId).path), true);
        const hook = host.harness.inspection.registrations.hooks['message.dispatch'];
        assert.equal((await hook(makeMessageDispatchHookContext({ thread: threads.get(threadId) }))).action, 'proceed');
        return { ok: true, delivery: 'sent' }; },
      list: async ({ offset = 0, limit = 200 } = {}) => {
        const list = [...threads.values()].filter(t => t.archivedAt === null && t.deletedAt === null).slice(offset, offset + limit);
        if (options.beforeListReturn) await options.beforeListReturn();
        return list;
      },
      archive: async ({ threadId }) => { events.push('archive'); threads.get(threadId).archivedAt = Date.now(); return { ok: true }; },
    },
  }, experimental_callHostRpc: async ({ method, input, hostId, signal }) => {
    assert.equal(hostId, 'local');
    if (hostEntry && method !== 'engine') return hostEntry.handlers[method](input, { signal: new AbortController().signal });
    if (method === 'prepareContext') return options.hostContext?.(input.binding) ?? { rules: [], skills: [], tools: [] };
    if (method === 'controlPublish') return createHostEntry().handlers.controlPublish(input, { signal: signal ?? new AbortController().signal });
    if (method === 'launchControl') {
      if (options.beforeControl) await options.beforeControl(input);
      return createHostEntry().handlers.launchControl(input, { signal: signal ?? new AbortController().signal });
    }
    if (method === 'read') {
      if (options.beforeRead) await options.beforeRead(input);
      return createHostEntry().handlers.read(input, { signal: signal ?? new AbortController().signal });
    }
    if (method === 'canonical' || method === 'hostContext') return options.hostOperation?.(method, input) ?? { read: true };
    if (options.failFinalize && method === 'engine' && input.operation === 'finalize') throw new Error('Host unavailable');
    if (input.operation === 'finalize' && options.beforeFinalize) await options.beforeFinalize(input);
    if (input.operation === 'check' && options.beforeCheck) await options.beforeCheck(signal);
    if (input.operation === 'preserve') events.push('preserve');
    if (input.operation === 'artifact' && options.beforeArtifact) await options.beforeArtifact(input);
    if (input.operation === 'step') {
      const entry = hostEntry ?? createHostEntry();
      return entry.handlers.engine(input, { signal: new AbortController().signal });
    }
    return engineOperation(input);
  } });
  t.after(() => host.harness.lifecycle.dispose());
  plugin(host.bb);
  const task = newTaskIdentity('engine-test').id;
  const reference = { directory: path.join(root, 'current-control'), owner: { task, participant: 'orchestrator',
    projectId: 'project', environmentId: 'env', hostId: 'local', root }, readRoots: [root] };
  const publish = async (launch, update = {}) => {
    const file = path.join(reference.directory, 'current.json');
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (launch && previous && JSON.stringify(previous.grants[launch.grant.actor]) === JSON.stringify(launch.grant) && !Object.keys(update).length) {
      launch.control = { mode: 'current', reference }; return previous;
    }
    const grants = { ...(previous?.grants ?? {}), ...(launch ? { [launch.grant.actor]: launch.grant } : {}) };
    const publication = { reference, ownerConfirmed: true, STOP: false, noNewStages: false, grants, ...update };
    const result = await host.harness.behavior.runCli(['control', 'publish', '--task', task,
      ...(previous ? ['--expected-revision', String(previous.revision)] : ['--initialize']), '--input', JSON.stringify(publication)]);
    assert.equal(result.exitCode, 0, result.stderr);
    if (launch) launch.control = { mode: 'current', reference };
    return publication;
  };
  const supplied = async extra => {
    const i = extra.indexOf('--launch-context');
    if (i < 0) return extra;
    const launch = JSON.parse(extra[i + 1]);
    if (launch.control.mode !== 'current') await publish(launch);
    const result = [...extra]; result[i + 1] = JSON.stringify(launch); return result;
  };
  const create = async (extra = []) => {
    const launch = launchFixture(task, 'orchestrator', 'orchestrator', root);
    if (!options.noLaunchContext && !extra.includes('--launch-context')) await publish(launch);
    return host.harness.behavior.runCli(['task', 'create', '--task', task, '--title', 'Engine test', '--project', 'project', '--environment', 'env', '--model', 'test-model',
      ...(extra.includes('--assignment') ? [] : ['--assignment', 'Read mailbox, then stop.']),
      ...(options.noLaunchContext || extra.includes('--launch-context') ? [] : ['--launch-context', JSON.stringify(launch)]), ...await supplied(extra)]);
  };
  const add = async (id, role = 'worker', extra = []) => {
    const envId = extra.includes('--environment') ? extra[extra.indexOf('--environment') + 1] : 'env';
    const env = extra.includes('--new-environment') || extra.includes('--environment-path') ? workerEnvironment : environments.get(envId);
    const launch = launchFixture(task, id, role, env.path, env.id === 'env' ? 'main' : 'actual-bb-branch', env.id === 'env' ? 'a'.repeat(40) : 'b'.repeat(40));
    launch.readRoots.push(root);
    const evidence = [];
    if (role === 'reviewer') {
      launch.review = { producer: 'orchestrator', producerBinding: 'participant', sourceEnvironmentId: env.id, base: 'a'.repeat(40), requiredGates: [['fiction', 'gate']], requirePassingGates: true };
      if (!options.noManifest && !extra.includes('--evidence-manifest')) evidence.push('--evidence-manifest', JSON.stringify((await evidenceFixture(root, task, env.id === 'env' ? 'a'.repeat(40) : 'b'.repeat(40))).manifest));
    }
    if (!extra.includes('--launch-context')) await publish(launch);
    extra = await supplied(extra);
    return host.harness.behavior.runCli(['participant', 'add', '--task', task, '--participant', id, '--role', role, '--model', 'test-model', '--assignment', 'Read mailbox, then stop.',
      ...(extra.includes('--launch-context') ? [] : ['--launch-context', JSON.stringify(launch)]), ...evidence, ...extra]);
  };
  const call = (id, name, input = {}, projectId = 'project') => host.harness.behavior.callAgentTool(name, input, { threadId: id, projectId });
  const control = (action, id) => host.harness.behavior.runCli(['participant', action, '--task', task, '--participant', id]);
  return { root, threads, environment, workerEnvironment, environments, names, spawns, events, get host() { return host; }, task, create, add, call, control, publish,
    wakes, queues, interactions, append, executionOptions, catalogs, get initialArgs() { return initialArgs; },
    reconcile: () => host.harness.behavior.runCli(['recovery', 'run']),
    delivery: id => bindingStore(host.bb).delivery(id),
    updateDelivery: (id, update) => bindingStore(host.bb).updateDelivery(id, update),
    finish(id, status = 'completed') { append(id, 'turn/completed', { status }); const thread = threads.get(id); thread.status = thread.runtime.displayStatus = 'idle'; },
    set stopStatus(value) { stopStatus = value; }, set patches(value) { patches = value; },
    set behindCount(value) { behindCount = value; }, set baseRef(value) { baseRef = value; },
    set headSha(value) { headSha = value; },
    async reload() { host = await host.harness.lifecycle.reload(plugin); } };
}

const acceptReview = (s, resultId, reviewer = 'independent') => s.host.harness.behavior.runCli([
  'task', 'accept', '--task', s.task, '--reviewer', reviewer, '--result', resultId,
]);
async function reviewResult(s, changes = {}, participant = 'independent', transform = body => body) {
  const binding = bindingStore(s.host.bb).participant(s.task, participant);
  const task = JSON.parse(await s.call(binding.threadId, 'promptobus_task'));
  const { source, base, producer, evidenceManifestSha256 } = task.reviewEvidence;
  const decision = { format: 'bb-review-decision-v1', task: s.task, reviewer: participant,
    assignmentAfterId: task.assignmentAfterId, source, base, producer, evidenceManifestSha256,
    decision: 'pass', findings: { critical: 0, major: 0 }, ...changes };
  const body = `**Done** \u2014 Reviewed the full current diff; critical ${decision.findings.critical}, major ${decision.findings.major}.\n**Gate** \u2014 not run, reviewer runs no mechanics.\n**Open** \u2014 Fictional integration fixture.\n**Decide** \u2014 nothing.\nAcceptance decision: ${JSON.stringify(decision)}\nReview ${binding.launchContext.grant.token} complete 1/1\nAll-calls release: actor ${participant}, token ${binding.launchContext.grant.token}, completed scope source review, pending=0 and running=0.`;
  assert.ok(body.length <= 2400);
  return JSON.parse(await s.call(binding.threadId, 'promptobus_send', { to: ['orchestrator'], type: 'result', body: transform(body) }));
}

test('minimal owner execution and independent review repairs findings and accepts a fresh source with exactly two actors', async t => {
  const s = await stand(t), privateReasoning = 'OWNER_PRIVATE_REASONING_SENTINEL';
  const created = await s.create(['--assignment', `Read mailbox, then stop. ${privateReasoning}`]);
  assert.equal(created.exitCode, 0, created.stderr);
  assert.equal((await s.add('independent', 'reviewer')).exitCode, 0);
  assert.equal(s.threads.size, 2);
  assert.equal(s.spawns[1].prompt.includes(privateReasoning), false);
  const engine = openEngine({ root: s.root, recover: false, policy: () => ({ allow: true }) });
  const first = await reviewResult(s, { decision: 'changes-required', findings: { critical: 0, major: 1 } });
  const rejected = await acceptReview(s, first.message.id);
  assert.equal(rejected.exitCode, 1); assert.match(rejected.stderr, /requires PASS with zero critical and major/);
  assert.equal(engine.facts(s.task).messages.some(m => m.type === 'result' && m.id === first.message.id), true);
  const source = 'c'.repeat(40), base = 'a'.repeat(40);
  s.headSha = source;
  const stale = await acceptReview(s, first.message.id);
  assert.equal(stale.exitCode, 1); assert.match(stale.stderr, /source mismatch/);
  const evidence = await evidenceFixture(s.root, s.task, source, base);
  const land = async content => {
    const sent = JSON.parse(await s.call('thr-1', 'promptobus_send', { to: ['orchestrator'], type: 'artifact', body: 'Original relevant review history.',
      artifact: { filename: 'review-history.txt', content } }));
    return { id: sent.artifact.id, sender: 'orchestrator', bytes: Buffer.byteLength(content), sha256: digest(content) };
  };
  const finding = 'src/example.ts:3 [major] Preserve the required source check.\n';
  const original = await land(finding);
  const index = await land(JSON.stringify({ version: 1, artifacts: [{ ...original, producer: 'independent', source: base, base }],
    entries: [{ id: 'prior-required-finding', kind: 'finding', source: base, base, producer: 'independent',
      raw: { parts: [original.id], bytes: original.bytes, sha256: original.sha256 } }] }));
  evidence.manifest.support = { artifacts: [{ ...index, producer: 'orchestrator', source, base }],
    index: { parts: [index.id], bytes: index.bytes, sha256: index.sha256 },
    required: [{ id: 'prior-required-finding', reason: 'Recheck this finding against the repaired full diff.' }] };
  const launch = launchFixture(s.task, 'independent', 'reviewer', s.root);
  launch.grant.token += '-repair'; launch.grant.phase = 'review-repair';
  launch.review = { producer: 'orchestrator', producerBinding: 'participant', sourceEnvironmentId: 'env', base,
    requiredGates: [['fiction', 'gate']], requirePassingGates: true };
  await s.publish(launch); s.finish('thr-2');
  const fullDiff = 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-missingCheck()\n+requiredCheck()\n';
  const resumed = await s.host.harness.behavior.runCli(['participant', 'resume', '--task', s.task, '--participant', 'independent',
    '--launch-context', JSON.stringify(launch), '--evidence-manifest', JSON.stringify(evidence.manifest),
    '--assignment', `Read mailbox, then stop. Review the full diff ${base}..${source}; revisit prior-required-finding from ${index.id}.\n${fullDiff}`]);
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  const fresh = bindingStore(s.host.bb).participant(s.task, 'independent');
  assert.ok(fresh.phaseAssignment.includes(JSON.stringify(fullDiff).slice(1, -1))); assert.ok(fresh.phaseAssignment.includes(index.id));
  assert.equal(fresh.phaseAssignment.includes(privateReasoning), false);
  assert.equal(JSON.parse(await s.call('thr-2', 'promptobus_artifact', { id: original.id })).content, finding);
  const passed = await reviewResult(s);
  const current = JSON.parse(readFileSync(path.join(s.root, 'current-control/current.json'), 'utf8'));
  delete current.grants.independent;
  await s.publish(null, { grants: current.grants });
  const before = [...s.events];
  const accepted = await acceptReview(s, passed.message.id);
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).accepted, true); assert.equal(JSON.parse(accepted.stdout).physicalClose, false);
  assert.equal(JSON.parse(accepted.stdout).source, source);
  assert.equal(s.threads.size, 2); assert.equal(engine.readTask(s.task).status, 'active');
  assert.deepEqual(s.events, before, 'Logical acceptance neither stops nor clears a context');
  const record = engine.facts(s.task).messages.find(m => m.id === JSON.parse(accepted.stdout).messageId);
  assert.equal(JSON.parse(record.body).resultId, passed.message.id);
});

test('logical acceptance refuses wrong decision scope, malformed metadata and a superseded result or assignment', async t => {
  const s = await stand(t); await s.create(); await s.add('independent', 'reviewer');
  for (const changes of [
    { source: 'c'.repeat(40) }, { base: 'b'.repeat(40) }, { producer: 'different-author' },
    { evidenceManifestSha256: 'b'.repeat(64) }, { assignmentAfterId: 'stale-assignment' },
    { reviewer: 'orchestrator' }, { task: 'wrong-task' },
    { decision: 'changes-required' }, { findings: { critical: 1, major: 0 } }, { findings: { critical: 0, major: 1 } },
  ]) {
    const result = await reviewResult(s, changes), rejected = await acceptReview(s, result.message.id);
    assert.equal(rejected.exitCode, 1, JSON.stringify(changes)); assert.match(rejected.stderr, /decision .* mismatch|requires PASS/);
  }
  for (const transform of [
    body => body.replace(/^Acceptance decision: .*\n/m, ''),
    body => body.replace('Acceptance decision: ', 'Acceptance decision: {broken}\nAcceptance decision: '),
    body => body.replace(/^Acceptance decision: .*$/m, 'Acceptance decision: {broken}'),
  ]) {
    const result = await reviewResult(s, {}, 'independent', transform), rejected = await acceptReview(s, result.message.id);
    assert.equal(rejected.exitCode, 1); assert.match(rejected.stderr, /Acceptance decision|strict bb-review-decision/);
  }
  const old = await reviewResult(s), latest = await reviewResult(s);
  const staleResult = await acceptReview(s, old.message.id);
  assert.equal(staleResult.exitCode, 1); assert.match(staleResult.stderr, /exact latest result/);
  const engine = openEngine({ root: s.root, recover: false, policy: () => ({ allow: true }) });
  engine.assignParticipant(s.task, engine.readTask(s.task).participants.find(p => p.id === 'independent'));
  const staleAssignment = await acceptReview(s, latest.message.id);
  assert.equal(staleAssignment.exitCode, 1); assert.match(staleAssignment.stderr, /exact latest result/);
  const self = await acceptReview(s, latest.message.id, 'orchestrator');
  assert.equal(self.exitCode, 1); assert.match(self.stderr, /independent bound reviewer/);
  assert.equal(engine.facts(s.task).messages.some(m => m.body.includes('bb-task-acceptance-v1')), false);
});

for (const gate of ['failed', 'notRun']) test(`logical acceptance requires passing required receipts when the original review admitted ${gate} gates`, async t => {
  const s = await stand(t); await s.create();
  const evidence = await evidenceFixture(s.root, s.task, undefined, undefined, undefined, undefined, gate === 'failed' ? { exit: 7 } : { gateNotRun: true });
  const launch = launchFixture(s.task, 'independent', 'reviewer', s.root);
  launch.review = { producer: 'orchestrator', producerBinding: 'participant', sourceEnvironmentId: 'env', base: 'a'.repeat(40),
    requiredGates: [['fiction', 'gate']], requirePassingGates: false };
  const added = await s.add('independent', 'reviewer', ['--launch-context', JSON.stringify(launch), '--evidence-manifest', JSON.stringify(evidence.manifest)]);
  assert.equal(added.exitCode, 0, added.stderr);
  const passed = await reviewResult(s), rejected = await acceptReview(s, passed.message.id);
  assert.equal(rejected.exitCode, 1); assert.match(rejected.stderr, /mandatory gates are not all passing/);
});

test('logical acceptance refuses missing original receipts and denied owner current authority', async t => {
  const s = await stand(t); await s.create(); await s.add('independent', 'reviewer');
  const passed = await reviewResult(s), store = bindingStore(s.host.bb), reviewer = store.participant(s.task, 'independent');
  const saved = structuredClone(reviewer.evidenceManifest);
  reviewer.evidenceManifest.artifacts = reviewer.evidenceManifest.artifacts.filter(ref => ref.kind !== 'receipt'); store.save(reviewer);
  const missing = await acceptReview(s, passed.message.id);
  assert.equal(missing.exitCode, 1); assert.match(missing.stderr, /original command receipt missing/);
  reviewer.evidenceManifest = saved; store.save(reviewer);
  await s.publish(null, { STOP: true });
  const denied = await acceptReview(s, passed.message.id);
  assert.equal(denied.exitCode, 1); assert.match(denied.stderr, /STOP or noNewStages denies admission/);
});

test('logical acceptance reauthenticates the owner after asynchronous evidence reads', async t => {
  const s = await stand(t); await s.create(); await s.add('independent', 'reviewer');
  const result = await reviewResult(s), store = bindingStore(s.host.bb);
  const owner = store.task(s.task), reviewer = store.participant(s.task, 'independent');
  const engine = openEngine({ root: s.root, recover: false, policy: () => ({ allow: true }) });
  const last = reviewer.evidenceManifest.artifacts.at(-1).sha256, read = fs.readFileSync;
  const expectedReads = reviewer.evidenceManifest.artifacts.filter(ref => ref.sha256 === last).length;
  let changed = false, reads = 0;
  fs.readFileSync = function(file, ...args) {
    const content = read.call(this, file, ...args);
    if (path.basename(String(file)) === last) reads++;
    if (!changed && reads === expectedReads) {
      changed = true;
      queueMicrotask(() => {
        const participant = engine.readTask(s.task).participants.find(p => p.id === 'orchestrator');
        engine.patchParticipant(s.task, participant.id, { metadata: { ...participant.metadata, bb: { ...participant.metadata.bb, token: 'rebound-owner-token' } } });
      });
    }
    return content;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(engineOperation({ operation: 'accept', binding: owner, reviewer, resultId: result.message.id }), /canonical owner binding changed/);
    assert.equal(changed, true);
  } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
  assert.equal(engine.facts(s.task).messages.some(m => m.body.includes('bb-task-acceptance-v1')), false);
});

test('owner-selected context purpose defaults explicitly, inherits, permits an explicit task purpose and stays canonical', async t => {
  const seen = [], s = await stand(t, { hostContext: binding => { seen.push([binding.participant, binding.contextPurpose]); return { rules: [], skills: [], tools: [] }; } });
  assert.equal((await s.create()).exitCode, 0); assert.equal((await s.add('independent', 'reviewer')).exitCode, 0);
  assert.equal((await s.add('writer', 'worker', ['--context-purpose', 'author-voice'])).exitCode, 0);
  const store = bindingStore(s.host.bb), engine = openEngine({ root: s.root, recover: false, policy: () => ({ allow: true }) });
  assert.equal(store.task(s.task).contextPurpose, 'technical'); assert.equal(store.participant(s.task, 'independent').contextPurpose, 'technical');
  assert.equal(store.participant(s.task, 'writer').contextPurpose, 'author-voice');
  assert.ok(seen.some(([id, purpose]) => id === 'writer' && purpose === 'author-voice'));
  const writer = store.participant(s.task, 'writer'); writer.contextPurpose = 'technical'; store.save(writer);
  await assert.rejects(s.call(writer.threadId, 'promptobus_task'), /Canonical binding mismatch/);
  const legacy = store.task(s.task); delete legacy.contextPurpose; store.save(legacy);
  const participant = engine.readTask(s.task).participants.find(p => p.id === 'orchestrator');
  const metadata = structuredClone(participant.metadata); delete metadata.bb.contextPurpose;
  engine.patchParticipant(s.task, participant.id, { metadata });
  assert.equal((await s.add('legacy-worker')).exitCode, 0);
  assert.equal(store.participant(s.task, 'legacy-worker').contextPurpose, undefined);
});

test('BB context declaration JSON is strict and refuses invalid files before provider model work', async t => {
  const s = await stand(t), file = path.join(s.root, 'invalid-context.json');
  const invalid = [{ skills: [], resources: [], extra: true }, { skills: [{ name: '../escape', reason: 'No' }], resources: [] },
    { skills: [], resources: [{ path: 'relative.md', reason: 'No' }] }, { skills: [{ name: 'catalog', reason: 'No', requires: [{ kind: 'skill', name: 'other', path: '/other' }] }], resources: [] }];
  for (const value of invalid) {
    assert.equal(contextDeclarationSchema.safeParse(value).success, false);
    writeFileSync(file, JSON.stringify(value));
    const before = s.host.harness.inspection.sdk.calls.filter(call => call.path === 'providers.models').length;
    const result = await s.create(['--context-file', file]);
    assert.equal(result.exitCode, 1); assert.equal(s.spawns.length, 0);
    assert.equal(s.host.harness.inspection.sdk.calls.filter(call => call.path === 'providers.models').length, before);
  }
  assert.equal(bindingStore(s.host.bb).task(s.task), undefined);
});

test('launch preflight refuses missing bounded context before any model spawn', async t => {
  const s = await stand(t, { noLaunchContext: true });
  const result = await s.create();
  assert.equal(result.exitCode, 1, 'Missing executable context must refuse before threads.spawn');
  assert.match(result.stderr, /launch context/);
  assert.equal(s.spawns.length, 0);
});

test('source reviewer refuses missing original manifest before any reviewer spawn', async t => {
  const s = await stand(t, { noManifest: true });
  assert.equal((await s.create()).exitCode, 0);
  const before = s.spawns.length;
  const result = await s.add('source-review', 'reviewer');
  assert.equal(result.exitCode, 1, 'Absent original artifact IDs must not spend a review turn');
  assert.match(result.stderr, /manifest/);
  assert.equal(s.spawns.length, before);
});

test('review initial immutable assignment holds every original ID readable through the bound BB artifact tool', async t => {
  const s = await stand(t); await s.create();
  assert.equal((await s.add('original-review', 'reviewer')).exitCode, 0);
  const launch = s.initialArgs.prompt;
  const b = bindingStore(s.host.bb).thread('thr-2');
  assert.ok(launch.includes(b.launchContext.role.literal.slice(0, 30)));
  for (const ref of b.evidenceManifest.artifacts) {
    assert.ok(launch.includes(ref.id), `Initial assignment is missing ${ref.kind} ID`);
    const actual = JSON.parse(await s.call('thr-2', 'promptobus_artifact', { id: ref.id }));
    assert.equal(actual.id, ref.id); assert.equal(actual.size, ref.bytes); assert.equal(actual.sha256, ref.sha256);
  }
});

test('retained missing-ID review failure blocks zero reviewer starts until the complete initial manifest exists', async t => {
  const observed = JSON.parse(readFileSync(new URL('../../../docs/evidence/bb-orchestration-2026-10-13.json', import.meta.url), 'utf8')).evidenceDeliveryObservation;
  assert.equal(observed.evidenceMajor, 1); assert.equal(observed.sourceFindings, 0);
  const s = await stand(t, { noManifest: true }); await s.create();
  const f = await evidenceFixture(s.root, s.task);
  const incomplete = structuredClone(f.manifest); incomplete.artifacts = [];
  const before = s.spawns.length;
  const delayed = await s.add('first-original-review', 'reviewer', ['--evidence-manifest', JSON.stringify(incomplete)]);
  assert.equal(delayed.exitCode, 1); assert.equal(s.spawns.length, before);
  const admitted = await s.add('first-original-review', 'reviewer', ['--evidence-manifest', JSON.stringify(f.manifest)]);
  assert.equal(admitted.exitCode, 0, admitted.stderr); assert.equal(s.spawns.length, before + 1);
  for (const ref of f.manifest.artifacts) assert.ok(s.initialArgs.prompt.includes(ref.id));
});

test('complete evidence upload lands UTF-8 raw parts and actual artifact IDs without another model turn', async t => {
  const s = await stand(t); await s.create();
  const content = '東京 Δ '.repeat(200_000) + '\nORIGINAL_TAIL\n';
  const file = path.join(s.root, 'original-raw.txt'); writeFileSync(file, content);
  const before = s.spawns.length;
  const result = await s.host.harness.behavior.runCli(['evidence', 'upload', '--task', s.task, '--file', file, '--to', 'orchestrator']);
  assert.equal(result.exitCode, 0, result.stderr);
  const uploaded = JSON.parse(result.stdout); assert.ok(uploaded.parts.length > 1);
  let raw = '';
  for (const part of uploaded.parts) raw += JSON.parse(await s.call('thr-1', 'promptobus_artifact', { id: part.id })).content;
  assert.equal(raw, content); assert.equal(uploaded.bytes, Buffer.byteLength(content)); assert.equal(s.spawns.length, before);
});

test('bounded file control is current at each BB call and an ended grant refuses without another identity', async t => {
  const s = await stand(t, { noLaunchContext: true });
  const launch = launchFixture(s.task, 'orchestrator', 'orchestrator', s.root);
  await s.publish(launch);
  assert.equal((await s.create(['--launch-context', JSON.stringify(launch)])).exitCode, 0);
  const current = JSON.parse(await s.call('thr-1', 'promptobus_task')); assert.equal(current.participant, 'orchestrator');
  await s.publish(null, { grants: {} });
  await assert.rejects(s.call('thr-1', 'promptobus_task'), /grant-mismatch/); assert.equal(s.spawns.length, 1);
});

test('fresh evidence repair keeps the actor, ends the old token and supplies every original ID before resumed delivery', async t => {
  let delivered;
  const s = await stand(t, { assignmentSend: async ({ input }) => { delivered = input[0].text; return { ok: true, delivery: 'sent' }; } });
  await s.create(); await s.add('phase-review', 'reviewer');
  const oldPrompt = s.initialArgs.prompt;
  const before = bindingStore(s.host.bb).thread('thr-2');
  const next = structuredClone(before.launchContext);
  next.grant.token = 'fresh-evidence-phase'; next.grant.phase = 'evidence-repair';
  await s.publish(next);
  const f = await evidenceFixture(s.root, s.task);
  const resume = extra => s.host.harness.behavior.runCli(['participant', 'resume', '--task', s.task, '--participant', 'phase-review',
    '--launch-context', JSON.stringify(next), '--assignment', 'Read complete original evidence in this bounded phase.', ...extra]);
  const missing = await resume([]); assert.equal(missing.exitCode, 1); assert.match(missing.stderr, /manifest/);
  assert.equal(delivered, undefined); assert.equal(s.spawns.length, 2);
  const accepted = await resume(['--evidence-manifest', JSON.stringify(f.manifest)]);
  assert.equal(accepted.exitCode, 0, accepted.stderr);
  assert.ok(delivered.includes('fresh-evidence-phase')); for (const ref of f.manifest.artifacts) assert.ok(delivered.includes(ref.id));
  const after = bindingStore(s.host.bb).thread('thr-2');
  assert.equal(after.participant, before.participant); assert.equal(after.token, before.token); assert.equal(after.threadId, before.threadId);
  assert.equal(after.phaseAssignmentPending, false); assert.equal(s.spawns.length, 2);
  assert.equal(s.delivery('thr-2').paused, false);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const old = await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: 'promptobus',
    input: { blocks: [{ type: 'text', text: oldPrompt }], text: oldPrompt } }));
  assert.equal(old.action, 'reject', 'A queued initial assignment from the ended grant cannot activate the fresh phase');
  const retry = await resume(['--evidence-manifest', JSON.stringify(f.manifest)]);
  assert.equal(retry.exitCode, 1); assert.match(retry.stderr, /fresh token/);
});

test('error-state Stop and fresh phase remain refused and paused across reload', async t => {
  const s = await stand(t);
  assert.equal((await s.create()).exitCode, 0);
  assert.equal((await s.add('phase-review', 'reviewer')).exitCode, 0);
  const before = bindingStore(s.host.bb).thread('thr-2');
  const thread = s.threads.get('thr-2');
  thread.status = thread.runtime.displayStatus = 'error'; s.stopStatus = 'error';
  s.events.length = 0;
  const stopped = await s.control('stop', 'phase-review');
  assert.equal(stopped.exitCode, 1);
  assert.equal(JSON.parse(stopped.stdout).confirmed, false);
  const epoch = s.delivery('thr-2').epoch;
  await s.reload(); await s.reconcile();
  assert.equal(s.delivery('thr-2').paused, true);
  assert.equal(s.delivery('thr-2').epoch, epoch);
  const next = structuredClone(before.launchContext);
  next.grant.token = 'fresh-error-phase'; next.grant.phase = 'error-repair';
  await s.publish(next);
  const f = await evidenceFixture(s.root, s.task);
  const resumed = await s.host.harness.behavior.runCli(['participant', 'resume', '--task', s.task, '--participant', 'phase-review',
    '--launch-context', JSON.stringify(next), '--assignment', 'Read complete original evidence in this bounded phase.',
    '--evidence-manifest', JSON.stringify(f.manifest)]);
  assert.equal(resumed.exitCode, 1);
  assert.match(resumed.stderr, /Fresh phase Stop was not confirmed/);
  assert.deepEqual(s.events, ['stop', 'stop'], 'Unconfirmed Stop must precede and block Clear context and assignment');
  assert.deepEqual(bindingStore(s.host.bb).thread('thr-2'), before);
  assert.equal(s.delivery('thr-2').paused, true); assert.equal(s.spawns.length, 2);
});

test('Stop during fresh initial assignment wins and an unknown send cannot start a mailbox-only review', async t => {
  for (const stop of [true, false]) {
    const s = await stand(t, { assignmentSend: async ({ threadId }) => {
      if (stop) await s.control('stop', 'phase-review');
      await s.reconcile(); assert.equal(s.wakes.filter(wake => wake.threadId === threadId).length, 0);
      if (!stop) throw new Error('Fresh initial send reply lost');
      return { ok: true, delivery: 'sent' };
    } });
    await s.create(); await s.add('phase-review', 'reviewer');
    await s.control('stop', 'phase-review');
    await s.call('thr-1', 'promptobus_send', { to: ['phase-review'], type: 'task', body: 'Read the complete original evidence in the fresh bounded phase.' });
    const before = bindingStore(s.host.bb).thread('thr-2'); const next = structuredClone(before.launchContext);
    next.grant.token = 'fresh-stop-phase'; next.grant.phase = 'repair';
    await s.publish(next);
    const f = await evidenceFixture(s.root, s.task);
    const result = await s.host.harness.behavior.runCli(['participant', 'resume', '--task', s.task, '--participant', 'phase-review',
      '--launch-context', JSON.stringify(next), '--evidence-manifest', JSON.stringify(f.manifest), '--assignment', 'Read all original evidence.']);
    assert.equal(result.exitCode, 1); assert.equal(s.wakes.filter(wake => wake.threadId === 'thr-2').length, 0); assert.equal(s.spawns.length, 2);
    if (stop) assert.equal(s.delivery('thr-2').paused, true);
    else assert.ok(bindingStore(s.host.bb).thread('thr-2').phaseAssignment);
  }
});

function fictionalHost(calls, { selected = false } = {}) {
  return root => {
    const base = path.join(root, 'base'), module = path.join(root, 'modules'), skills = path.join(root, 'canon-skills');
    for (const dir of [base, module, path.join(skills, 'catalog')]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(base, 'rules.md'), 'PRECEDENCE=base');
    writeFileSync(path.join(module, 'rules.md'), 'PRECEDENCE=module');
    writeFileSync(path.join(skills, 'catalog', 'SKILL.md'), 'Canonical skill: read catalog before editing.');
    const host = { collectRules: environment => [path.join(environment, 'AGENTS.md'), path.join(module, 'rules.md'), path.join(base, 'rules.md')],
      skillsDir: () => skills, resolveRepoModule: () => null, reviewSkillDir: () => skills,
      participantServers: () => ({ servers: { catalog: { env: { SECRET: 'not-delivered' } } }, external: [] }),
      participantDenyTools: () => ({ tools: [{ server: 'catalog', tool: 'write' }], complete: true }) };
    if (selected) host.selectParticipantContext = ({ repoDir, task }) => ({
      rules: host.collectRules(repoDir).map(file => ({ path: file, reason: 'Mandatory installed rule' })),
      skills: (task.context?.skills ?? []).map(skill => ({ ...skill, root: path.join(skills, skill.name) })),
      resources: task.context?.resources ?? [],
    });
    return createHostEntry(createBbHostIntegration({ resolveHost: () => host,
      prepareEnvironment: ({ root: environment }) => { mkdirSync(environment, { recursive: true });
        writeFileSync(path.join(environment, 'AGENTS.md'), `PRECEDENCE=repo\nENVIRONMENT=${environment}\n${'rule '.repeat(1000)}\nRULE_TAIL`); },
      listTools: async () => [{ name: 'read', description: 'Read catalog', access: 'read', inputSchema: { type: 'object' } },
        { name: 'write', description: 'Write catalog', access: 'write', inputSchema: { type: 'object' } }],
      invokeTool: async input => { calls.push(input); return { result: input.tool }; },
    }));
  };
}

test('BB explicit context survives initial/reviewer/fresh delivery and remains canonical without inheriting owner extras', async t => {
  let delivered;
  const s = await stand(t, { hostSetup: fictionalHost([], { selected: true }),
    assignmentSend: async ({ input }) => { delivered = input[0].text; return { ok: true, delivery: 'sent' }; } });
  const shared = path.join(s.root, 'canon-skills', '_shared'); mkdirSync(shared);
  const resource = path.join(shared, 'reference.md'), sibling = path.join(shared, 'private.md'), file = path.join(s.root, 'task-context.json');
  writeFileSync(resource, 'EXACT_SHARED_BODY'); writeFileSync(sibling, 'UNSELECTED_SHARED_BODY');
  const declaration = { skills: [{ name: 'catalog', reason: 'Task catalog', requires: [{ kind: 'resource', path: resource }] }],
    resources: [{ path: resource, reason: 'Exact selected contract' }] };
  writeFileSync(file, JSON.stringify(declaration));
  const created = await s.create(['--context-file', file]); assert.equal(created.exitCode, 0, created.stderr);
  assert.ok(s.initialArgs.prompt.includes('Exact selected contract')); assert.equal(s.initialArgs.prompt.includes('EXACT_SHARED_BODY'), false);
  const withoutExtras = await s.add('without-owner-extras'); assert.equal(withoutExtras.exitCode, 0, withoutExtras.stderr);
  const store = bindingStore(s.host.bb), child = store.participant(s.task, 'without-owner-extras');
  assert.equal(child.contextDeclaration, undefined); assert.deepEqual(child.hostContext.skills, []);
  const added = await s.add('explicit-review', 'reviewer', ['--context-file', file]); assert.equal(added.exitCode, 0, added.stderr);
  const before = store.participant(s.task, 'explicit-review');
  assert.deepEqual(before.contextDeclaration, declaration); assert.deepEqual(before.hostContext.selection.task.context, declaration);
  assert.match(await s.call(before.threadId, 'promptobus_host_context', { mode: 'read', path: resource }), /EXACT_SHARED_BODY/);
  await assert.rejects(s.call(before.threadId, 'promptobus_host_context', { mode: 'read', path: sibling }), /outside the declared/);
  const next = structuredClone(before.launchContext); next.grant.token += '-explicit-context'; next.grant.phase = 'context-review';
  await s.publish(next); s.finish(before.threadId);
  const evidence = await evidenceFixture(s.root, s.task);
  const resumed = await s.host.harness.behavior.runCli(['participant', 'resume', '--task', s.task, '--participant', before.participant,
    '--launch-context', JSON.stringify(next), '--evidence-manifest', JSON.stringify(evidence.manifest), '--assignment', 'Read the exact selected contract in this fresh review phase.']);
  assert.equal(resumed.exitCode, 0, resumed.stderr); assert.ok(delivered.includes('Exact selected contract'));
  assert.equal(delivered.includes('EXACT_SHARED_BODY'), false);
  const after = store.participant(s.task, before.participant);
  assert.deepEqual(after.contextDeclaration, declaration); assert.deepEqual(after.hostContext.selection, before.hostContext.selection);
  const engine = openEngine({ root: s.root, recover: false, policy: () => ({ allow: true }) });
  const canonical = engine.readTask(s.task).participants.find(participant => participant.id === before.participant);
  assert.deepEqual(canonical.metadata.bb.contextDeclaration, declaration);
  after.contextDeclaration.skills[0].reason = 'Tampered'; store.save(after);
  await assert.rejects(s.call(after.threadId, 'promptobus_task'), /Canonical binding mismatch/);
  const owner = store.task(s.task); owner.contextDeclaration.resources[0].reason = 'Tampered owner'; store.save(owner);
  await assert.rejects(s.call(owner.threadId, 'promptobus_task'), /Canonical binding mismatch/);
});

test('a resource-only BB context keeps its exact Host reader visible', async t => {
  const s = await stand(t, { hostSetup: () => createHostEntry(createBbHostIntegration({ resolveHost: () => ({
    collectRules: () => [], skillsDir: () => null, resolveRepoModule: () => null, reviewSkillDir: () => null,
    selectParticipantContext: ({ task }) => ({ rules: [], skills: [], resources: task.context?.resources ?? [] }),
    participantServers: () => ({ servers: {}, external: [] }),
  }) })) }), resource = path.join(s.root, 'reference.md'), file = path.join(s.root, 'resources.json');
  writeFileSync(resource, 'RESOURCE_ONLY_REFERENCE'); writeFileSync(file, JSON.stringify({ skills: [], resources: [{ path: resource, reason: 'Only reference' }] }));
  const created = await s.create(['--context-file', file]); assert.equal(created.exitCode, 0, created.stderr);
  const binding = bindingStore(s.host.bb).task(s.task);
  assert.match(await s.call(binding.threadId, 'promptobus_host_context', { mode: 'read', path: resource }), /RESOURCE_ONLY_REFERENCE/);
});

test('BB Host delivery uses complete rule/skill content and authentic canonical worker/reviewer capabilities', async t => {
  const calls = []; const s = await stand(t, { hostSetup: fictionalHost(calls) });
  assert.equal((await s.create()).exitCode, 0);
  assert.ok(s.initialArgs.prompt.includes('RULE_TAIL'));
  assert.ok(s.initialArgs.prompt.includes('Canonical skill: read catalog before editing.'));
  assert.equal(s.initialArgs.prompt.includes('not-delivered'), false);
  await s.add('worker-host'); await s.add('reviewer-host', 'reviewer');
  const worker = bindingStore(s.host.bb).thread('thr-2'), reviewer = bindingStore(s.host.bb).thread('thr-3');
  assert.deepEqual(worker.hostContext.tools.map(tool => tool.tool), ['read', 'write']);
  assert.deepEqual(reviewer.hostContext.tools.map(tool => tool.tool), ['read']);
  assert.deepEqual(JSON.parse(await s.call('thr-2', 'promptobus_host_call', { server: 'catalog', tool: 'write', args: {} })), { result: 'write' });
  assert.deepEqual(calls[0].actor, { task: s.task, participant: 'worker-host' });
  assert.deepEqual(JSON.parse(await s.call('thr-3', 'promptobus_host_call', { server: 'catalog', tool: 'read', args: {} })), { result: 'read' });
  assert.deepEqual(calls[1].actor, { task: s.task, participant: 'reviewer-host' });
  await assert.rejects(s.call('thr-3', 'promptobus_host_call', { server: 'catalog', tool: 'write', args: { role: 'worker' } }), /not admitted/);
  await assert.rejects(s.call('thr-3', 'promptobus_host_call', { server: 'catalog', tool: 'read', args: {}, role: 'worker' }), /unrecognized|unknown/i);
  assert.equal(calls.length, 2);
  await s.reload();
  const context = JSON.parse(await s.call('thr-3', 'promptobus_host_context', { mode: 'inspect' }));
  assert.ok(context.rules[0].text.endsWith('RULE_TAIL'));
});

test('selected BB tools export MCP object input schemas and preserve strict Host context requests', async t => {
  const calls = [];
  const s = await stand(t, { hostContext: () => ({ rules: [{ path: '/declared', text: 'Declared fixture rule' }], skills: [], tools: [] }),
    hostOperation: async (method, input) => {
    calls.push({ method, args: input.args });
    return input.args;
  } });
  const selected = ['promptobus_send', 'promptobus_mailbox', 'promptobus_task', 'promptobus_artifact', 'promptobus_host_context'];
  const tools = s.host.harness.inspection.registrations.agentTools.filter(tool => selected.includes(tool.name));
  assert.deepEqual(tools.map(tool => tool.name), selected);
  for (const tool of tools) assert.equal(tool.inputSchema.type, 'object', `${tool.name} must publish an MCP object inputSchema`);
  const schema = tools.at(-1).inputSchema;
  assert.equal(schema.oneOf.length, 2);
  assert.ok(schema.oneOf.every(branch => branch.type === 'object' && branch.additionalProperties === false));
  assert.equal((await s.create()).exitCode, 0);
  assert.equal((await s.add('schema-worker')).exitCode, 0);
  const valid = [{ mode: 'inspect' }, { mode: 'read', path: '/declared' },
    { mode: 'read', path: '/declared', start_line: 1, line_count: 2000 }];
  for (const args of valid) {
    assert.deepEqual(tools.at(-1).parse(args), { ok: true, value: args });
    assert.deepEqual(JSON.parse(await s.call('thr-2', 'promptobus_host_context', args)), args);
  }
  const invalid = [{ mode: 'inspect', path: '/extra' }, { mode: 'inspect', line_count: 1 }, { mode: 'read' },
    { mode: 'read', path: '' }, { mode: 'unknown' }, { mode: 'inspect', extra: true },
    ...['actor', 'participant', 'task', 'token', 'role'].map(field => ({ mode: 'inspect', [field]: 'spoof' })),
    ...[0, -1, 1.5].map(start_line => ({ mode: 'read', path: '/declared', start_line })),
    ...[0, -1, 1.5, 2001].map(line_count => ({ mode: 'read', path: '/declared', line_count }))];
  for (const args of invalid) {
    assert.equal(tools.at(-1).parse(args).ok, false, JSON.stringify(args));
    await assert.rejects(s.call('thr-2', 'promptobus_host_context', args));
  }
  assert.deepEqual(calls, valid.map(args => ({ method: 'hostContext', args })));
});

test('new BB worktrees collect generated Host context after actual environment provisioning', async t => {
  const s = await stand(t, { hostSetup: fictionalHost([]) }); await s.create();
  assert.equal((await s.add('worker-host', 'worker', ['--new-environment', '--base-branch', 'main'])).exitCode, 0);
  const b = bindingStore(s.host.bb).thread('thr-2');
  assert.equal(b.hostContext.rules[0].path, path.join(realpathSync(s.workerEnvironment.path), 'AGENTS.md'));
  assert.ok(b.hostContext.rules[0].text.includes(`ENVIRONMENT=${s.workerEnvironment.path}`));
  const config = await s.host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    thread: { id: b.threadId }, project: { id: b.projectId }, environment: { id: b.environmentId, path: b.environmentPath },
    host: { id: b.hostId }, provider: { id: b.providerId },
  }));
  assert.ok(config.tools.some(tool => tool.name === 'promptobus_host_call'));
});

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
  assert.deepEqual(s.host.harness.inspection.experimental_hostRpcCalls.map(call => call.method), ['controlPublish']);
});

test('coordinator progress stays unread without model wakes; result carries it once across reload', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  const status = JSON.parse(await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'status', body: 'Gate is running' }));
  await s.reconcile(); await s.reload(); await s.reconcile();
  assert.equal(s.wakes.filter(wake => wake.threadId === 'thr-1').length, 0);
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  assert.equal(engine.unread(s.task, 'orchestrator'), 1);
  const result = JSON.parse(await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'result', body: 'Done' }));
  await s.reconcile(); await s.reconcile();
  assert.equal(s.wakes.filter(wake => wake.threadId === 'thr-1').length, 1);
  assert.ok(s.wakes.filter(wake => wake.threadId === 'thr-1')[0].input[0].text.includes(status.message.id));
  assert.ok(s.wakes.filter(wake => wake.threadId === 'thr-1')[0].input[0].text.includes(result.message.id));
  assert.deepEqual(JSON.parse(await s.call('thr-1', 'promptobus_mailbox', { mode: 'read' })).messages.map(m => m.type), ['status', 'result']);
  s.finish('thr-1'); await s.reconcile();
  assert.equal(s.wakes.filter(wake => wake.threadId === 'thr-1').length, 1);
});

for (const type of ['task', 'question', 'answer', 'review', 'artifact']) {
  test(`coordinator ${type} remains actionable with retained progress`, async t => {
    const s = await stand(t); await s.create(); await s.add('worker-one');
    const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
    engine.sendSync(s.task, { from: 'worker-one', to: ['orchestrator'], type: 'status', body: 'Progress' });
    await s.reconcile(); assert.equal(s.wakes.filter(wake => wake.threadId === 'thr-1').length, 0);
    const artifact = path.join(s.root, 'progress.txt');
    if (type === 'artifact') writeFileSync(artifact, 'Evidence');
    engine.sendSync(s.task, { from: 'worker-one', to: ['orchestrator'], type, body: 'Action',
      ...(type === 'artifact' ? { artifact: { path: artifact } } : {}) });
    await s.reconcile(); assert.equal(s.wakes.filter(wake => wake.threadId === 'thr-1').length, 1);
    assert.equal(engine.unread(s.task, 'orchestrator'), 2);
  });
}

test('coordinator progress never resets the pending result activation budget', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'result', body: 'Done' });
  await s.reconcile();
  const before = s.delivery('thr-1');
  s.finish('thr-1');
  await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'status', body: 'Waiting' });
  await s.reconcile();
  assert.equal(s.delivery('thr-1').key, before.key);
  assert.equal(s.delivery('thr-1').attempts, before.attempts + 1);
});

test('a stopped coordinator retains progress and result without reactivation across reload', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  assert.equal((await s.control('stop', 'orchestrator')).exitCode, 0);
  await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'status', body: 'Progress' });
  await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'result', body: 'Done' });
  await s.reload(); await s.reconcile();
  assert.equal(s.wakes.length, 0); assert.equal(s.delivery('thr-1').paused, true);
  assert.equal(JSON.parse(await s.call('thr-1', 'promptobus_mailbox', { mode: 'read' })).messages.length, 2);
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
  s.finish('thr-2'); await s.reconcile();
  assert.equal(s.wakes.filter(wake => wake.threadId === 'thr-2' && wake.input[0].text.includes('Canonical unread IDs')).length, 1);
  assert.match(s.delivery('thr-2').pending.key, /^result:/, 'The initial prompt still owes its result after the mailbox is consumed');
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
    const entry = { id: 'queued-wake', threadId, originPluginId: 'promptobus', content: input }; queues.set(threadId, [entry]);
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
      const entry = { id: 'late-queued', threadId, originPluginId: 'promptobus', content: input }; queues.set(threadId, [entry]); entered.resolve();
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
  const admission = await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: 'promptobus', input: { blocks: [{ type: 'text', text: oldText }], text: oldText } }));
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
      admission = await hook(makeMessageDispatchHookContext({ thread: threads.get(threadId), originPluginId: null, input: { blocks: input, text: input[0].text } }));
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

for (const type of ['task', 'result']) test(`attachment provenance: ${type} retains its authenticated sender before ACK and after ACK/reload`, async t => {
  const s = await stand(t);
  assert.equal((await s.create()).exitCode, 0);
  assert.equal((await s.add('worker-one')).exitCode, 0);
  const sender = type === 'task' ? 'orchestrator' : 'worker-one';
  const caller = type === 'task' ? 'thr-1' : 'thr-2';
  const recipient = type === 'task' ? 'worker-one' : 'orchestrator';
  const reader = type === 'task' ? 'thr-2' : 'thr-1';
  const sent = JSON.parse(await s.call(caller, 'promptobus_send', { to: [recipient], type,
    body: 'Canonical assignment or result with original evidence.', artifact: { filename: `${type}.txt`, content: `original ${type}` } }));
  const check = async () => {
    const artifact = JSON.parse(await s.call(reader, 'promptobus_artifact', { id: sent.artifact.id }));
    assert.equal(artifact.sender, sender); assert.equal(artifact.content, `original ${type}`);
  };
  await check();
  const read = JSON.parse(await s.call(reader, 'promptobus_mailbox', { mode: 'read' }));
  assert.ok(read.messages.some(message => message.id === sent.message.id));
  await check(); await s.reload(); await check();
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

for (const provider of ['acp-cursor', 'acp-opencode']) for (const provision of [false, true]) {
  test(`ACP worker keeps provider across spawn, tools and recovery (${provider}, provision ${provision})`, async t => {
    const s = await stand(t); await s.create();
    const extra = ['--provider', provider, '--reasoning-level', 'high',
      ...(provision ? ['--new-environment', '--base-branch', 'main'] : [])];
    const added = await s.add('worker-acp', 'worker', extra);
    assert.equal(added.exitCode, 0, added.stderr);
    const { threadId } = JSON.parse(added.stdout);
    assert.equal(s.spawns.at(-1).providerId, provider);
    assert.equal(s.spawns.at(-1).permissionMode, 'accept-edits');
    assert.equal(s.spawns.at(-1).reasoningLevel, 'high');
    const b = bindingStore(s.host.bb).thread(threadId);
    assert.equal(b.providerId, provider); assert.equal(b.execution.providerId, provider);
    assert.equal(b.execution.harness, provider === 'acp-cursor' ? 'cursor' : 'opencode');
    assert.equal(JSON.parse(await s.call(threadId, 'promptobus_task')).participant, 'worker-acp');
    const context = makePluginAgentConfigurationContext({ thread: { id: threadId }, project: { id: 'project' },
      environment: { id: b.environmentId, path: b.environmentPath }, host: { id: 'local' }, provider: { id: provider } });
    const configuration = await s.host.harness.behavior.resolveAgentConfiguration(context);
    assert.equal(configuration.tools.some(tool => tool.name === 'promptobus_send'), true);
    assert.deepEqual(configuration.skills, ['promptobus-worker']);
    assert.equal((await s.control('stop', 'worker-acp')).exitCode, 0);
    await s.reload();
    assert.equal((await s.control('resume', 'worker-acp')).exitCode, 0);
    assert.equal(bindingStore(s.host.bb).thread(threadId).providerId, provider);
    assert.equal(JSON.parse(await s.call(threadId, 'promptobus_task')).participant, 'worker-acp');
  });
}

test('Cursor approver retains provider and authenticated current predecessors across tools and recovery', async t => {
  const s = await stand(t); await s.create();
  await s.add('alpha', 'worker', ['--provider', 'acp-opencode']); await s.add('beta', 'reviewer');
  const extra = ['--provider', 'acp-cursor', '--reasoning-level', 'high', '--worker', 'alpha', '--reviewer', 'beta'];
  const refused = await s.add('acceptor', 'approver', extra);
  assert.equal(refused.exitCode, 1); assert.equal(s.threads.size, 3);
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }) });
  await engine.send(s.task, { from: 'alpha', to: ['orchestrator'], type: 'result', body: 'Worker evidence' });
  await engine.send(s.task, { from: 'beta', to: ['orchestrator'], type: 'result', body: 'Reviewer evidence' });
  const added = await s.add('acceptor', 'approver', extra); assert.equal(added.exitCode, 0, added.stderr);
  const { threadId } = JSON.parse(added.stdout); const b = bindingStore(s.host.bb).thread(threadId);
  assert.equal(s.spawns.at(-1).providerId, 'acp-cursor'); assert.equal(b.providerId, 'acp-cursor');
  assert.equal(b.execution.harness, 'cursor'); assert.equal(b.parentThreadId, 'thr-2');
  assert.deepEqual(b.predecessors, { worker: 'alpha', reviewer: 'beta' });
  assert.equal(JSON.parse(await s.call(threadId, 'promptobus_task')).participant, 'acceptor');
  assert.equal((await s.control('stop', 'acceptor')).exitCode, 0); await s.reload();
  assert.equal((await s.control('resume', 'acceptor')).exitCode, 0);
  assert.equal(bindingStore(s.host.bb).thread(threadId).providerId, 'acp-cursor');
  const worker = engine.readTask(s.task).participants.find(p => p.id === 'alpha');
  engine.patchParticipant(s.task, 'alpha', { metadata: { ...worker.metadata, bb: { ...worker.metadata.bb,
    assignedAt: new Date(Date.now() + 60_000).toISOString() } } });
  await s.call(threadId, 'promptobus_task');
  engine.assignParticipant(s.task, engine.readTask(s.task).participants.find(p => p.id === 'alpha'));
  await assert.rejects(s.call(threadId, 'promptobus_task'), /requires a type=result/);
});

test('approver requires current worker and isolated reviewer results for the same subject before launch and tools', async t => {
  const s = await stand(t); await s.create(); await s.add('alpha'); await s.add('beta', 'reviewer');
  const extra = ['--worker', 'alpha', '--reviewer', 'beta'];
  const refuses = async (extra, pattern) => {
    const result = await s.add('acceptor', 'approver', extra); assert.equal(result.exitCode, 1); assert.match(result.stderr, pattern);
    assert.equal(s.threads.size, 3, 'A refused acceptance must not reserve or spawn another executor');
    assert.equal(bindingStore(s.host.bb).participant(s.task, 'acceptor'), undefined);
  };
  await refuses([], /requires --worker and --reviewer/);
  await refuses(extra, /requires a type=result/);
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }) });
  await engine.send(s.task, { from: 'alpha', to: ['orchestrator'], type: 'result', body: 'Actual worker result; content stays opaque.' });
  await refuses(extra, /requires a type=result/);
  await engine.send(s.task, { from: 'beta', to: ['orchestrator'], type: 'result', body: 'A negative verdict is still a recorded fact, not an automatic acceptance.' });
  const added = await s.add('acceptor', 'approver', extra); assert.equal(added.exitCode, 0, added.stderr);
  const thread = JSON.parse(added.stdout).threadId;
  assert.equal(JSON.parse(await s.call(thread, 'promptobus_task')).participant, 'acceptor');
  const worker = engine.readTask(s.task).participants.find(p => p.id === 'alpha');
  engine.patchParticipant(s.task, 'alpha', { metadata: { ...worker.metadata, bb: { ...worker.metadata.bb,
    assignedAt: new Date(Date.now() + 60_000).toISOString() } } });
  await s.call(thread, 'promptobus_task');
  engine.assignParticipant(s.task, engine.readTask(s.task).participants.find(p => p.id === 'alpha'));
  await assert.rejects(s.call(thread, 'promptobus_task'), /requires a type=result/);
});

test('approver refuses a reviewer on another BB subject and an assignment that supersedes an old result', async t => {
  const s = await stand(t); await s.create(); await s.add('alpha'); await s.add('beta', 'reviewer');
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }) });
  for (const from of ['alpha', 'beta']) await engine.send(s.task, { from, to: ['orchestrator'], type: 'result', body: 'Recorded result.' });
  const reviewer = engine.readTask(s.task).participants.find(p => p.id === 'beta');
  engine.patchParticipant(s.task, 'beta', { metadata: { ...reviewer.metadata, bb: { ...reviewer.metadata.bb, environmentPath: s.root + '/other' } } });
  const extra = ['--worker', 'alpha', '--reviewer', 'beta'];
  const mismatch = await s.add('acceptor', 'approver', extra); assert.equal(mismatch.exitCode, 1); assert.match(mismatch.stderr, /subjects differ/);
  engine.patchParticipant(s.task, 'beta', { metadata: reviewer.metadata });
  const future = openEngine({ root: s.root, policy: () => ({ allow: true }), now: () => new Date(Date.now() + 60_000) });
  await future.send(s.task, { from: 'orchestrator', to: ['beta'], type: 'task', body: 'A fresh review assignment supersedes the old result.' });
  const stale = await s.add('acceptor', 'approver', extra); assert.equal(stale.exitCode, 1); assert.match(stale.stderr, /requires a type=result/);
});

test('damaged unread assignments refuse approver admission repeatedly without moving their refs', async t => {
  for (const mode of [null, 'peek', 'read']) {
  for (const content of ['{', JSON.stringify({ type: 'task' })]) {
    const s = await stand(t); await s.create(); await s.add('alpha'); await s.add('beta', 'reviewer');
    const engine = openEngine({ root: s.root, policy: () => ({ allow: true }) });
    for (const from of ['alpha', 'beta']) await engine.send(s.task, { from, to: ['orchestrator'], type: 'result', body: 'Recorded result.' });
    const sent = await engine.send(s.task, { from: 'orchestrator', to: ['beta'], type: 'task', body: 'New assignment.' });
    const ref = path.join(engine.inboxPath(s.task, 'beta'), sent.message.id + '.json');
    writeFileSync(ref, content);
    if (mode) engine[mode](s.task, 'beta');
    const retained = mode ? path.join(engine.brokenPath(s.task, 'beta'), sent.message.id + '.json') : ref;
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await s.add('acceptor', 'approver', ['--worker', 'alpha', '--reviewer', 'beta']);
      assert.equal(refused.exitCode, 1, 'Incomplete assignment history must never admit old results');
      assert.match(refused.stderr, /committed evidence requires explicit repair/);
      assert.equal(s.threads.size, 3);
      assert.equal(existsSync(retained), true, 'Repeated checks must retain the damaged ref');
    }
  }
  }
});

test('canonical outstanding assignment refuses admission despite an unlistable unread directory without reserving an approver', async t => {
  const s = await stand(t); await s.create(); await s.add('alpha'); await s.add('beta', 'reviewer');
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }) });
  for (const from of ['alpha', 'beta']) await engine.send(s.task, { from, to: ['orchestrator'], type: 'result', body: 'Recorded result.' });
  await engine.send(s.task, { from: 'orchestrator', to: ['beta'], type: 'task', body: 'New assignment.' });
  const box = engine.inboxPath(s.task, 'beta'); renameSync(box, box + '.saved'); writeFileSync(box, 'not a directory');
  for (let attempt = 0; attempt < 2; attempt++) {
    const refused = await s.add('acceptor', 'approver', ['--worker', 'alpha', '--reviewer', 'beta']);
    assert.equal(refused.exitCode, 1); assert.match(refused.stderr, /requires a type=result/);
    assert.equal(s.threads.size, 3);
    assert.equal(bindingStore(s.host.bb).participant(s.task, 'acceptor'), undefined);
  }
});

test('canonical outstanding assignment survives unlistable read history at root and participant directories', async t => {
  for (const participant of [null, 'beta']) {
    const s = await stand(t); await s.create(); await s.add('alpha'); await s.add('beta', 'reviewer');
    const engine = openEngine({ root: s.root, policy: () => ({ allow: true }) });
    for (const from of ['alpha', 'beta']) await engine.send(s.task, { from, to: ['orchestrator'], type: 'result', body: 'Recorded result.' });
    await engine.send(s.task, { from: 'orchestrator', to: ['beta'], type: 'task', body: 'New assignment.' });
    engine.read(s.task, 'beta');
    const box = participant ? engine.historyPath(s.task, participant) : path.dirname(engine.historyPath(s.task, 'beta'));
    renameSync(box, box + '.saved'); writeFileSync(box, 'not a directory');
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await s.add('acceptor', 'approver', ['--worker', 'alpha', '--reviewer', 'beta']);
      assert.equal(refused.exitCode, 1); assert.match(refused.stderr, /requires a type=result/);
      assert.equal(s.threads.size, 3);
      assert.equal(bindingStore(s.host.bb).participant(s.task, 'acceptor'), undefined);
    }
  }
});

test('an assignment arriving during Host preparation refuses before approver reservation and spawn', async t => {
  let s;
  s = await stand(t, { hostContext: async b => {
    if (b.role === 'approver') {
      const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), now: () => new Date(Date.now() + 60_000) });
      await engine.send(s.task, { from: 'orchestrator', to: ['beta'], type: 'task', body: 'Review changed during Host preparation.' });
    }
    return { rules: [], skills: [], tools: [] };
  } });
  await s.create(); await s.add('alpha'); await s.add('beta', 'reviewer');
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }) });
  for (const from of ['alpha', 'beta']) await engine.send(s.task, { from, to: ['orchestrator'], type: 'result', body: 'Recorded result.' });
  const refused = await s.add('acceptor', 'approver', ['--worker', 'alpha', '--reviewer', 'beta']);
  assert.equal(refused.exitCode, 1); assert.match(refused.stderr, /requires a type=result/);
  assert.equal(s.threads.size, 3, 'A stale preparation must not spawn an executor');
  assert.equal(bindingStore(s.host.bb).participant(s.task, 'acceptor'), undefined);
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
  assert.equal(JSON.parse(status.stdout).items[0].phase, 'orphan');
});

test('bindings inventory stays bounded when stored instructions exceed the SDK CLI cap', async t => {
  const s = await stand(t);
  assert.equal((await s.create()).exitCode, 0);
  const store = bindingStore(s.host.bb), binding = store.task(s.task);
  binding.bootstrap = 'OPAQUE_BINDING_PAYLOAD_'.repeat(60_000);
  store.save(binding);
  const result = await s.host.harness.behavior.runCli(['bindings']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) <= 64 * 1024);
  assert.doesNotMatch(result.stdout, /OPAQUE_BINDING_PAYLOAD_/);
  assert.deepEqual(JSON.parse(result.stdout), { items: [{ task: binding.task, participant: binding.participant,
    threadId: binding.threadId, role: binding.role, phase: binding.phase, projectId: binding.projectId,
    environmentId: binding.environmentId, hostId: binding.hostId, providerId: binding.providerId }], nextCursor: null });
  assert.equal(store.list()[0].bootstrap, binding.bootstrap, 'Scheduler reads must retain the full stored binding');
});

test('bindings pages traverse unchanged rows exactly once and support exact task and participant filters', async t => {
  const s = await stand(t); assert.equal((await s.create()).exitCode, 0);
  const store = bindingStore(s.host.bb), seed = store.task(s.task), expected = [seed];
  const otherTask = newTaskIdentity('inventory-other').id;
  for (let i = 0; i < 110; i++) {
    const binding = { ...seed, task: i % 2 ? otherTask : s.task, participant: `worker-${String(Math.floor(i / 2)).padStart(3, '0')}`,
      threadId: i === 0 ? null : `inventory-${i}`, role: 'worker', phase: i === 0 ? 'orphan' : 'ready', bootstrap: 'OPAQUE_PAGE_PAYLOAD' };
    store.reserve(binding, i === 1); expected.push(binding);
  }
  const inventory = async args => {
    const result = await s.host.harness.behavior.runCli(['bindings', ...args]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 64 * 1024);
    assert.doesNotMatch(result.stdout, /OPAQUE_PAGE_PAYLOAD/);
    return JSON.parse(result.stdout);
  };
  const first = await inventory([]); assert.equal(first.items.length, 50);
  const all = [...first.items]; let cursor = first.nextCursor;
  while (cursor !== null) {
    const page = await inventory(['--cursor', String(cursor)]);
    assert.ok(page.nextCursor === null || page.nextCursor > cursor);
    all.push(...page.items); cursor = page.nextCursor;
  }
  assert.deepEqual(all.map(row => [row.task, row.participant]), expected.map(row => [row.task, row.participant]));
  assert.equal(new Set(all.map(row => JSON.stringify([row.task, row.participant]))).size, expected.length);
  assert.equal(all.find(row => row.participant === 'worker-000' && row.task === s.task).phase, 'orphan');
  assert.equal((await inventory(['--limit', '100'])).items.length, 100);
  const byTask = await inventory(['--task', otherTask, '--limit', '100']);
  assert.equal(byTask.nextCursor, null); assert.equal(byTask.items.length, 55);
  assert.ok(byTask.items.every(row => row.task === otherTask));
  const byParticipant = await inventory(['--participant', 'worker-000']);
  assert.equal(byParticipant.items.length, 2);
  const exact = await inventory(['--task', s.task, '--participant', 'worker-000', '--limit', '1']);
  assert.equal(exact.items.length, 1); assert.equal(exact.nextCursor, null); assert.equal(exact.items[0].threadId, null);
  assert.deepEqual(await inventory(['--participant', 'worker-00']), { items: [], nextCursor: null });
  assert.deepEqual(await inventory(['--task', otherTask.slice(0, -1)]), { items: [], nextCursor: null });
  assert.equal(store.list().length, expected.length); assert.equal(s.spawns.length, 1);
});

test('bindings byte-limited pages count UTF-8 and preserve every row across continuation', async t => {
  const s = await stand(t); assert.equal((await s.create()).exitCode, 0);
  const store = bindingStore(s.host.bb), binding = store.task(s.task);
  binding.projectId = '東京🙂'.repeat(2000); store.save(binding);
  for (let i = 1; i <= 4; i++) store.reserve({ ...binding, participant: `unicode-${i}`, threadId: null }, false);
  const participants = []; let cursor = 0;
  do {
    const result = await s.host.harness.behavior.runCli(['bindings', '--limit', '100', '--cursor', String(cursor)]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) <= 64 * 1024);
    const page = JSON.parse(result.stdout);
    assert.ok(page.items.length > 0 && page.items.length < 5);
    participants.push(...page.items.map(row => row.participant));
    assert.ok(page.nextCursor === null || page.nextCursor > cursor); cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(participants, ['orchestrator', 'unicode-1', 'unicode-2', 'unicode-3', 'unicode-4']);
});

test('bindings budget includes JSON metadata and an oversized summary fails without skipping its row', async t => {
  const s = await stand(t); assert.equal((await s.create()).exitCode, 0);
  const store = bindingStore(s.host.bb), binding = store.task(s.task);
  const initial = JSON.parse((await s.host.harness.behavior.runCli(['bindings'])).stdout).items[0];
  const overhead = Buffer.byteLength(JSON.stringify({ items: [{ ...initial, projectId: '' }], nextCursor: null }));
  binding.projectId = 'x'.repeat(64 * 1024 - overhead); store.save(binding);
  const exact = await s.host.harness.behavior.runCli(['bindings']);
  assert.equal(exact.exitCode, 0, exact.stderr); assert.equal(Buffer.byteLength(exact.stdout), 64 * 1024);
  binding.projectId += 'x'; store.save(binding);
  const oversized = await s.host.harness.behavior.runCli(['bindings']);
  assert.equal(oversized.exitCode, 1); assert.equal(oversized.stdout, '');
  assert.match(oversized.stderr, /summary at row 1 exceeds 64 KiB; correct its oversized stored identity fields/);
  assert.ok(Buffer.byteLength(oversized.stderr) <= 64 * 1024);
  store.reserve({ ...binding, participant: 'oversized', threadId: null, projectId: '🙂'.repeat(17_000) }, false);
  binding.projectId = 'project'; store.save(binding);
  store.reserve({ ...binding, participant: 'after-oversized', threadId: null }, false);
  const partial = JSON.parse((await s.host.harness.behavior.runCli(['bindings'])).stdout);
  assert.deepEqual(partial.items.map(row => row.participant), ['orchestrator']);
  assert.equal(partial.nextCursor, 1);
  const continuation = await s.host.harness.behavior.runCli(['bindings', '--cursor', String(partial.nextCursor)]);
  assert.equal(continuation.exitCode, 1); assert.equal(continuation.stdout, '');
  assert.match(continuation.stderr, /summary at row 2 exceeds 64 KiB/);
});

test('bindings invalid limit and cursor inputs refuse with bounded output', async t => {
  const s = await stand(t);
  const empty = await s.host.harness.behavior.runCli(['bindings']);
  assert.equal(empty.exitCode, 0); assert.deepEqual(JSON.parse(empty.stdout), { items: [], nextCursor: null });
  for (const [option, values] of [
    ['limit', ['0', '101', '-1', '1.5', '1e1', '', 'invalid', '9'.repeat(80_000)]],
    ['cursor', ['-1', '1.5', '', 'invalid', '9007199254740992', 'invalid'.repeat(12_000)]],
  ]) for (const value of values) {
    const result = await s.host.harness.behavior.runCli(['bindings', `--${option}`, value]);
    assert.equal(result.exitCode, 1, `Invalid ${option} must refuse`);
    assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 64 * 1024);
    assert.match(result.stderr, /bindings (limit|cursor|limit and cursor)/);
  }
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

test('constrained reviewer delivers a long lossless report through bounded status parts and one terminal result', async t => {
  const s = await stand(t);
  assert.equal((await s.create()).exitCode, 0);
  assert.equal((await s.add('long-review', 'reviewer')).exitCode, 0);
  const binding = bindingStore(s.host.bb).thread('thr-2');
  const token = binding.launchContext.grant.token;
  const findings = Array.from({ length: 12 }, (_, i) => `src/example.ts:${i + 1} [major] Finding ${i + 1}: ${'Keep every detail 🧪. '.repeat(45)}— suggested fix.\n`).join('');
  assert.ok(findings.length > 7303);
  await assert.rejects(s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'result', body: findings }));
  const characters = Array.from(findings);
  const payloads = [];
  for (let offset = 0; offset < characters.length; offset += 1000) payloads.push(characters.slice(offset, offset + 1000).join(''));
  const landed = [];
  for (const [index, payload] of payloads.entries()) {
    const body = `Review ${token} part ${index + 1}/${payloads.length}\n${payload}`;
    assert.ok(body.length <= 2400);
    const reply = JSON.parse(await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'status', body }));
    assert.equal(reply.message.sender, 'long-review');
    assert.equal(reply.artifact, null);
    landed.push(reply.message);
    await s.call('thr-1', 'promptobus_mailbox', { mode: 'read' });
  }
  const body = `**Done** — Reviewed source; critical 0, major 12, minor 0.\n**Gate** — not run, reviewer runs no mechanical checks.\n**Open** — Fixture only.\n**Decide** — nothing.\nReview ${token} complete ${payloads.length}/${payloads.length}\nAll-calls release: actor long-review, token ${token}, completed scope source review, pending=0 and running=0.`;
  assert.ok(body.length <= 2400);
  const terminal = JSON.parse(await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'result', body }));
  await s.call('thr-1', 'promptobus_mailbox', { mode: 'read' });
  const engine = openEngine({ root: s.root, recover: false, policy: () => ({ allow: true }) });
  const messages = engine.history({ task: s.task, all: true, strict: true }).entries.map(entry => entry.message)
    .filter(message => message.sender === 'long-review').sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(messages.map(message => message.id), [...landed, terminal.message].map(message => message.id));
  assert.deepEqual(messages.map(message => message.type), [...payloads.map(() => 'status'), 'result']);
  assert.equal(messages.slice(0, -1).map(message => message.body.slice(message.body.indexOf('\n') + 1)).join(''), findings);
  assert.equal(messages.filter(message => message.body.includes('All-calls release:')).length, 1);
  assert.ok(messages.every(message => message.sender === 'long-review' && !message.artifact));
  const configuration = await s.host.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    thread: { id: 'thr-2' }, project: { id: 'project' }, environment: { id: 'env', path: s.root },
    host: { id: 'local' }, provider: { id: 'promptobus-codex-reviewer' },
  }));
  assert.deepEqual(configuration.tools.map(tool => tool.name), ['promptobus_send', 'promptobus_mailbox', 'promptobus_task', 'promptobus_artifact',
    'pb_review_read_file', 'pb_review_read_files', 'pb_review_list_files', 'pb_review_search_text']);
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

test('existing path provisions the owning participant (no helper), records actual identity and delivers after Stop', async t => {
  const s = await stand(t, { hostSetup: fictionalHost([]) }); await s.create();
  s.workerEnvironment.managed = false;
  const added = await s.add('worker-path', 'worker', ['--environment-path', s.workerEnvironment.path, '--provider', 'codex', '--reasoning-level', 'high']);
  assert.equal(added.exitCode, 0, JSON.stringify(added));
  assert.equal(s.threads.size, 2);
  assert.deepEqual(s.initialArgs.environment, { type: 'host', hostId: 'local',
    workspace: { type: 'unmanaged', path: s.workerEnvironment.path } });
  assert.equal(s.initialArgs.sendAt, undefined);
  assert.equal(s.initialArgs.prompt.includes('Preparation token:'), true);
  assert.deepEqual(s.events, ['provision', 'stop', 'clear-context', 'assignment']);
  const b = bindingStore(s.host.bb).thread('thr-2');
  assert.equal(b.environmentId, 'bb-actual-env');
  assert.equal(b.environmentPath, s.workerEnvironment.path);
  assert.equal(b.environmentOwner, 'existing');
  assert.equal(b.baseSha, 'b'.repeat(40));
  assert.equal(b.branch, 'actual-bb-branch');
  assert.equal(b.parentThreadId, 'thr-1');
  assert.equal(b.lifecycleOwnerThreadId, 'thr-1');
  assert.equal(b.execution.scope.environmentId, b.environmentId);
  assert.equal(b.execution.providerSource, 'explicit'); assert.equal(b.execution.reasoningSource, 'explicit');
  assert.equal(b.execution.reasoningLevel, 'high');
  assert.ok(b.hostContext.rules[0].text.includes(`ENVIRONMENT=${s.workerEnvironment.path}`));
  const reserve = s.host.harness.inspection.experimental_hostRpcCalls.find(call => call.input.operation === 'reserve'
    && call.input.binding.participant === 'worker-path');
  assert.equal(reserve.input.binding.environmentId, 'bb-actual-env');
  const engine = openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false });
  assert.equal(engine.readTask(s.task).participants.find(p => p.id === 'worker-path').sessionRef, 'thr-2');
  await s.reload();
  assert.equal(JSON.parse((await s.control('get', 'worker-path')).stdout).view.state, 'alive');
});

test('existing path revalidates the launched model ID after provisioning', async t => {
  for (const [name, refreshedId] of [
    ['rejects a refreshed model catalog ID before reservation or assignment', 'catalog-model-b'],
    ['preserves the launched model ID when the refreshed catalog is stable', 'catalog-model-a'],
  ]) await t.test(name, async t => {
    const catalog = id => ({ modelLoadError: null, models: [{ id, model: 'test-model', defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] });
    const s = await stand(t, { beforePreparationIdle: async () => {
      s.host.harness.inspection.sdk.stub('providers.models', async () => catalog(refreshedId));
    } });
    assert.equal((await s.create()).exitCode, 0);
    s.workerEnvironment.managed = false;
    s.host.harness.inspection.sdk.stub('providers.models', async () => catalog('catalog-model-a'));
    const result = await s.add('worker-model', 'worker', ['--environment-path', s.workerEnvironment.path]);
    const b = bindingStore(s.host.bb).thread('thr-2');
    assert.equal(s.initialArgs.model, 'catalog-model-a');
    assert.equal(s.executionOptions.get('thr-2').model, 'catalog-model-a');
    if (refreshedId !== 'catalog-model-a') {
      assert.equal(result.exitCode, 1, JSON.stringify(result));
      assert.match(result.stderr, /model.*(?:changed|mismatch)/i);
      assert.equal(b.phase, 'orphan');
      assert.deepEqual(s.events, ['provision', 'stop']);
      assert.equal(s.host.harness.inspection.experimental_hostRpcCalls.some(call => call.input.operation === 'reserve'
        && call.input.binding.participant === 'worker-model'), false);
    } else {
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(b.phase, 'ready');
      assert.equal(b.execution.scope.environmentId, s.workerEnvironment.id);
      assert.deepEqual(s.events, ['provision', 'stop', 'clear-context', 'assignment']);
    }
    assert.equal(b.execution.model, 'catalog-model-a');
    assert.equal(b.execution.requestedModel, 'test-model');
    assert.equal(b.execution.nativeModel, 'test-model');
    assert.equal(s.threads.get('thr-2').status, 'idle');
    assert.equal(s.threads.get('thr-2').activeBackgroundAgentCount, 0);
  });
});

test('existing environment id retains immediate assignment without path bootstrap', async t => {
  const s = await stand(t, { hostSetup: fictionalHost([]) }); await s.create();
  s.workerEnvironment.managed = false;
  const result = await s.add('worker-id', 'worker', ['--environment', 'bb-actual-env']);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.deepEqual(s.initialArgs.environment, { type: 'reuse', environmentId: 'bb-actual-env' });
  assert.equal(s.initialArgs.prompt.includes('Preparation token:'), false);
  assert.equal(s.initialArgs.prompt.includes(s.workerEnvironment.path), true);
  assert.deepEqual(s.events, []);
  assert.equal(bindingStore(s.host.bb).thread('thr-2').phase, 'ready');
});

test('existing path rejects incompatible modes and relative paths before spawn', async t => {
  const s = await stand(t); await s.create();
  for (const extra of [['--environment', 'env'], ['--environment', ''], ['--new-environment', '--base-branch', 'main'], ['--base-branch', 'main'], ['--base-branch', '']]) {
    const result = await s.add('worker-conflict', 'worker', ['--environment-path', s.workerEnvironment.path, ...extra]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Select either/);
  }
  const relative = await s.add('worker-relative', 'worker', ['--environment-path', 'relative/worktree']);
  assert.equal(relative.exitCode, 1); assert.match(relative.stderr, /absolute/);
  const empty = await s.add('worker-empty', 'worker', ['--environment-path', '']);
  assert.equal(empty.exitCode, 1); assert.match(empty.stderr, /absolute/);
  assert.equal(s.threads.size, 1);
});

test('existing path refuses invalid provisioning identity, Git HEAD and lifecycle without assignment', async t => {
  const cases = [
    ['null environment', ({ thread }) => { thread.environmentId = null; }],
    ['wrong thread', ({ thread }) => { thread.id = 'foreign'; }],
    ['wrong project', ({ environment }) => { environment.projectId = 'foreign'; }],
    ['wrong host', ({ environment }) => { environment.hostId = 'foreign'; }],
    ['wrong path', ({ environment }) => { environment.path += '-foreign'; }],
    ['wrong environment', ({ environment }) => { environment.id = 'foreign'; }],
    ['managed environment', ({ environment }) => { environment.managed = true; }],
    ['unready environment', ({ environment }) => { environment.status = 'pending'; }],
    ['inactive environment', ({ environment }) => { environment.lifecycle.phase = 'destroyed'; }],
    ['wrong parent', ({ thread }) => { thread.parentThreadId = 'foreign'; }],
    ['wrong lifecycle owner', ({ thread }) => { thread.lifecycleOwnerThreadId = 'foreign'; }],
    ['archived thread', ({ thread }) => { thread.archivedAt = 1; }],
    ['deleted thread', ({ thread }) => { thread.deletedAt = 1; }],
    ['background work', ({ thread }) => { thread.activeBackgroundAgentCount = 1; }],
  ];
  for (const [name, afterPreparationIdle] of cases) await t.test(name, async t => {
    const s = await stand(t, { afterPreparationIdle }); await s.create(); s.workerEnvironment.managed = false;
    const requested = s.workerEnvironment.path;
    const result = await s.add('worker-invalid', 'worker', ['--environment-path', requested]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /binding mismatch|not ready|not idle|managed|path|unavailable/);
    assert.equal(s.events.includes('assignment'), false);
    assert.equal(s.host.harness.inspection.experimental_hostRpcCalls.some(call => call.input.operation === 'reserve'
      && call.input.binding.participant === 'worker-invalid'), false);
    const b = bindingStore(s.host.bb).participant(s.task, 'worker-invalid');
    assert.equal(b.phase, 'orphan'); assert.equal(b.threadId, 'thr-2');
    await s.reload();
    const inspect = await s.host.harness.behavior.runCli(['recovery', 'inspect', '--task', s.task, '--participant', 'worker-invalid']);
    assert.equal(JSON.parse(inspect.stdout).launch.environmentPath, requested);
  });
  for (const name of ['missing HEAD', 'not Git', 'offline host']) await t.test(name, async t => {
    const s = await stand(t); await s.create(); s.workerEnvironment.managed = false;
    await s.publish(launchFixture(s.task, 'worker-invalid', 'worker', s.workerEnvironment.path, 'actual-bb-branch', 'b'.repeat(40)));
    if (name === 'offline host') s.host.harness.inspection.sdk.stub('hosts.get', async () => ({ id: 'local', status: 'disconnected', lifecycle: { phase: 'active' } }));
    else s.host.harness.inspection.sdk.stub('environments.status', async () => name === 'not Git'
      ? { outcome: 'unavailable' } : { outcome: 'available', workspace: { checkout: { kind: 'branch', headSha: null } } });
    const result = await s.add('worker-invalid', 'worker', ['--environment-path', s.workerEnvironment.path]);
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /HEAD|unavailable/);
    assert.equal(s.events.includes('assignment'), false);
  });
});

test('existing path preserves ambiguous spawn, missing path and preparation timeout receipts without retry', async t => {
  for (const failure of ['missing path', 'lost reply', 'timeout']) await t.test(failure, async t => {
    const s = await stand(t, { preparationMatched: failure !== 'timeout', beforeReturn: ({ thread }) => {
      if (thread.id === 'thr-2' && failure === 'lost reply') throw new Error('Spawn response was lost');
    } }); await s.create(); s.workerEnvironment.managed = false;
    if (failure === 'missing path') s.host.harness.inspection.sdk.stub('threads.spawn', async () => { throw new Error('Workspace path does not exist'); });
    const result = await s.add('worker-failed', 'worker', ['--environment-path', s.workerEnvironment.path]);
    assert.equal(result.exitCode, 1); assert.match(result.stderr, /path does not exist|response was lost|did not become idle/);
    assert.equal(s.events.includes('assignment'), false);
    assert.equal(s.host.harness.inspection.sdk.callsTo('threads.spawn').length, 2);
    await s.reload();
    const inspect = await s.host.harness.behavior.runCli(['recovery', 'inspect', '--task', s.task, '--participant', 'worker-failed']);
    const receipt = JSON.parse(inspect.stdout);
    assert.equal(receipt.phase, 'orphan');
    assert.equal(receipt.launch.environmentPath, s.workerEnvironment.path);
    assert.equal(receipt.automaticallyRebound, false);
    assert.equal(receipt.candidates.length, failure === 'lost reply' ? 1 : 0);
  });
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


test('overlapping archive rereads the terminal binding after the async child scan', async t => {
  const entered = deferred(), release = deferred(); let first = true;
  const s = await stand(t, { async beforeListReturn() {
    if (first) { first = false; entered.resolve(); await release.promise; }
  } });
  await s.create(); await s.add('worker-one');
  const slow = s.control('archive', 'worker-one'); await entered.promise;
  const fast = await s.control('archive', 'worker-one');
  assert.equal(fast.exitCode, 0, fast.stderr);
  const preserved = JSON.parse(fast.stdout).preservation;
  release.resolve(); const result = await slow;
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).preservation, preserved);
  assert.equal(s.events.filter(e => e === 'preserve').length, 1);
  await s.reload();
  const b = bindingStore(s.host.bb).participant(s.task, 'worker-one');
  assert.equal(b.phase, 'archived'); assert.deepEqual(b.preservation, preserved);
  assert.ok(openEngine({ root: s.root, policy: () => ({ allow: true }), recover: false }).readArtifactContent(s.task, preserved.artifactId));
});

test('orphan recovery reports persisted effort and explicitly unknown legacy effort without executing', async t => {
  const s = await stand(t, { ambiguousSpawn: true });
  assert.equal((await s.create(['--reasoning-level', 'high'])).exitCode, 1);
  const inspect = () => s.host.harness.behavior.runCli(['recovery', 'inspect', '--task', s.task, '--participant', 'orchestrator']);
  assert.equal(JSON.parse((await inspect()).stdout).launch.reasoningLevel, 'high');
  const store = bindingStore(s.host.bb), b = store.task(s.task), intent = store.launchIntent(b);
  delete intent.reasoningLevel; store.launch(b, intent); await s.reload();
  assert.equal(JSON.parse((await inspect()).stdout).launch.reasoningLevel, null);
  assert.equal(s.threads.size, 1); assert.equal(bindingStore(s.host.bb).task(s.task).threadId, null);
});

test('dispatch bounds stalled SDK validation, waits on temporary loss and rejects a permanent mismatch', async t => {
  let stall = false, temporary = false, observed;
  const s = await stand(t, { async beforeGet(id, signal) {
    if (temporary) throw new Error('Host temporarily offline');
    if (stall) {
      observed = signal;
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
  } });
  await s.create(); const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const context = () => makeMessageDispatchHookContext({ thread: s.threads.get('thr-1') });
  stall = true; const began = Date.now(); const blocked = await hook(context());
  assert.equal(blocked.action, 'wait'); assert.equal(observed.aborted, true);
  assert.ok(Date.now() - began < 8000, 'Dispatch must release the shared lock below the SDK 10-second cap');
  stall = false; temporary = true; assert.equal((await hook(context())).action, 'wait');
  temporary = false; assert.equal((await hook(context())).action, 'proceed');
  s.threads.get('thr-1').providerId = 'foreign'; assert.equal((await hook(context())).action, 'reject');
});


for (const originPluginId of [null, 'promptobus']) test(`late queue insertion after Stop and reload retains exact ownership and rejects stale hints without pausing resume (${originPluginId})`, async t => {
  const entered = deferred(), reply = deferred(); let first = true;
  const s = await stand(t, { async wakeSend({ threadId, input, queues, append, threads }) {
    if (first) {
      first = false; entered.resolve(); await reply.promise;
      const entry = { id: 'after-stop', threadId, originPluginId, content: input };
      queues.set(threadId, [...(queues.get(threadId) ?? []), entry]);
      return { ok: true, delivery: 'queued', queuedMessage: entry, waitingOn: { kind: 'thread-busy' } };
    }
    append(threadId, 'client/turn/requested', { input }); threads.get(threadId).status = threads.get(threadId).runtime.displayStatus = 'active';
    return { ok: true, delivery: 'sent' };
  } });
  await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Insert after cancellation scan' }); await entered.promise;
  const old = s.wakes[0].input[0].text;
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0);
  const unrelated = { id: 'quoted-user', threadId: 'thr-2', originPluginId: null, content: [{ type: 'text', text: `Please explain this hint: ${old}` }] };
  const copied = { id: 'copied-user', threadId: 'thr-2', originPluginId: null, content: [{ type: 'text', text: old }] };
  s.queues.set('thr-2', [unrelated, copied]); await s.reload(); reply.resolve(); await new Promise(resolve => setImmediate(resolve));
  await s.reconcile(); assert.deepEqual(s.queues.get('thr-2'), [unrelated, copied]);
  assert.equal(s.delivery('thr-2').paused, true);
  s.queues.set('thr-2', []);
  const resumed = await s.control('resume', 'worker-one'); assert.equal(resumed.exitCode, 0, resumed.stderr);
  const epoch = s.delivery('thr-2').epoch;
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const rejected = await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId,
    input: { text: old, blocks: s.wakes[0].input } }));
  assert.equal(rejected.action, 'reject');
  s.append('thr-2', 'client/turn/rejected', { requestId: 'old-request', reason: 'plugin-rejected', message: rejected.message });
  await s.reconcile(); assert.equal(s.delivery('thr-2').paused, false); assert.equal(s.delivery('thr-2').epoch, epoch);
  assert.equal(s.wakes.length, 2);
});

for (const originPluginId of [null, 'promptobus']) test(`failed queued wake deletion retains ownership across reload and retries before resume (${originPluginId})`, async t => {
  let fail = true;
  const s = await stand(t, { beforeQueueDelete() { if (fail) throw new Error('Delete temporarily failed'); },
    wakeSend({ threadId, input, queues }) {
      const entry = { id: 'owned-queued', threadId, originPluginId, content: input }; queues.set(threadId, [entry]);
      return { ok: true, delivery: 'queued', queuedMessage: entry, waitingOn: { kind: 'thread-busy' } };
    } });
  await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Retry cancellation' }); await s.reconcile();
  const old = s.wakes[0].input[0].text;
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0); await s.reload();
  assert.equal(s.queues.get('thr-2').length, 1);
  fail = false; await s.call('thr-2', 'promptobus_mailbox', { mode: 'read' });
  await s.call('thr-2', 'promptobus_send', { to: ['orchestrator'], type: 'result', body: 'Initial assignment completed.' });
  const result = await s.control('resume', 'worker-one'); assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(s.queues.get('thr-2'), []); assert.equal(s.delivery('thr-2').paused, false);
  assert.ok(s.delivery('thr-2').retired.some(receipt => receipt.text === old));
});


test('stalled host validation shares the dispatch abort budget and rechecks after recovery', async t => {
  let stall = false, observed;
  const s = await stand(t, { async beforeCheck(signal) {
    if (!stall) return;
    observed = signal;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await s.create();
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const context = makeMessageDispatchHookContext({ thread: s.threads.get('thr-1') });
  stall = true; const before = Date.now();
  assert.equal((await hook(context)).action, 'wait'); assert.ok(Date.now() - before < 8000);
  assert.equal(observed.aborted, true);
  stall = false; assert.equal((await hook(context)).action, 'proceed');
});


test('a previously replayed wake request ID remains owned when its ordinary SDK rejection arrives after resume', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Late ordinary SDK rejection' });
  await s.reconcile();
  await s.reconcile();
  const requested = s.delivery('thr-2').pending;
  assert.ok(requested.requestSeq > 0, 'Old requested event must already be behind the durable cursor');
  const requestId = `request-thr-2-${requested.requestSeq}`;
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0); await s.reload();
  assert.equal((await s.control('resume', 'worker-one')).exitCode, 0);
  const epoch = s.delivery('thr-2').epoch;
  s.append('thr-2', 'client/turn/rejected', { requestId, reason: 'provider-unavailable', message: 'Provider connection closed' });
  await s.reconcile();
  assert.equal(s.delivery('thr-2').paused, false); assert.equal(s.delivery('thr-2').epoch, epoch);
  s.append('thr-2', 'client/turn/rejected', { requestId: 'unrelated-current', reason: 'provider-unavailable', message: 'Provider connection closed' });
  await s.reconcile(); assert.equal(s.delivery('thr-2').paused, true);
});


test('copied and quoted user wake text dispatches as user input without becoming a retired request', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'User owns copies' }); await s.reconcile();
  const old = s.wakes[0].input[0].text;
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0); await s.reload();
  const entries = [old, `Explain this hint: ${old}`].map((text, i) => ({ id: `user-${i}`, threadId: 'thr-2', originPluginId: null,
    content: [{ type: 'text', text }] }));
  s.queues.set('thr-2', entries);
  assert.equal((await s.control('resume', 'worker-one')).exitCode, 0);
  assert.deepEqual(s.queues.get('thr-2'), entries);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  for (const entry of entries) {
    const ctx = makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), origin: 'cli', originPluginId: null,
      queuedMessages: [entry], input: { blocks: entry.content, text: entry.content[0].text } });
    assert.equal((await hook(ctx)).action, 'proceed', 'User-owned text must survive real dispatch');
    s.append('thr-2', 'client/turn/requested', { requestId: entry.id, input: entry.content });
    s.queues.set('thr-2', s.queues.get('thr-2').filter(row => row.id !== entry.id));
    s.finish('thr-2'); await s.reconcile();
    assert.ok(s.delivery('thr-2').retired.every(receipt => !receipt.requests.includes(entry.id)));
    assert.equal(s.delivery('thr-2').paused, false);
  }
});

for (const originPluginId of [null, 'promptobus']) test(`a mixed queued group waits for owned obsolete cleanup without rejecting unrelated user rows (${originPluginId})`, async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Mixed group' }); await s.reconcile();
  const old = s.wakes[0].input;
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0); await s.reload();
  const user = { id: 'user', threadId: 'thr-2', originPluginId: null, content: [{ type: 'text', text: 'Keep this user input' }] };
  s.queues.set('thr-2', [user]); assert.equal((await s.control('resume', 'worker-one')).exitCode, 0);
  const stale = { id: 'late-old', threadId: 'thr-2', originPluginId, content: old };
  s.queues.set('thr-2', [stale, user]);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  assert.equal((await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: 'mixed',
    queuedMessages: [stale, user], input: { blocks: [...old, ...user.content], text: old[0].text+'\n'+user.content[0].text } }))).action, 'wait');
  await s.reconcile(); assert.deepEqual(s.queues.get('thr-2'), [user]);
  assert.equal((await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: null,
    queuedMessages: [user], input: { blocks: user.content, text: user.content[0].text } }))).action, 'proceed');
  assert.equal(s.delivery('thr-2').paused, false);
});


test('Stop before requested replay still correlates generated payload after retirement and reload', async t => {
  const entered = deferred(), reply = deferred(); let first = true, requestId;
  const s = await stand(t, { async wakeSend({ threadId, input, append, threads }) {
    const row = append(threadId, 'client/turn/requested', { input });
    if (first) { first = false; requestId = row.data.requestId; entered.resolve(); await reply.promise; }
    threads.get(threadId).status = threads.get(threadId).runtime.displayStatus = 'active';
    return { ok: true, delivery: 'sent' };
  } });
  await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Stop before event replay' }); await entered.promise;
  assert.equal(s.delivery('thr-2').pending.requestId, null);
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0); await s.reload();
  assert.equal((await s.control('resume', 'worker-one')).exitCode, 0);
  reply.resolve(); await new Promise(resolve => setImmediate(resolve));
  const epoch = s.delivery('thr-2').epoch;
  s.append('thr-2', 'client/turn/rejected', { requestId, reason: 'provider-unavailable', message: 'Provider connection closed' });
  await s.reconcile(); assert.equal(s.delivery('thr-2').paused, false); assert.equal(s.delivery('thr-2').epoch, epoch);
});

test('a user copy of the current pending text cannot replace generated request identity', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Current wake copy' }); await s.reconcile(); await s.reconcile();
  const owned = s.delivery('thr-2').pending; assert.ok(owned.requestId);
  const user = { type: 'text', text: owned.text };
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  assert.equal((await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: null,
    input: { blocks: [user], text: user.text } }))).action, 'proceed');
  s.append('thr-2', 'client/turn/requested', { requestId: 'user-current-copy', input: [user] }); await s.reconcile();
  assert.equal(s.delivery('thr-2').pending.requestId, owned.requestId);
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0); await s.reload();
  assert.equal((await s.control('resume', 'worker-one')).exitCode, 0);
  s.append('thr-2', 'client/turn/rejected', { requestId: owned.requestId, reason: 'provider-unavailable', message: 'Provider connection closed' });
  await s.reconcile(); assert.equal(s.delivery('thr-2').paused, false);
  s.append('thr-2', 'client/turn/rejected', { requestId: 'user-current-copy', reason: 'provider-unavailable', message: 'Provider connection closed' });
  await s.reconcile(); assert.equal(s.delivery('thr-2').paused, true);
});

for (const currentFirst of [true, false]) test(`current and obsolete owned queue group waits for precise cleanup (current first ${currentFirst})`, async t => {
  const s = await stand(t, { wakeSend({ threadId, input, queues }) {
    const entry = { id: `owned-${Date.now()}`, threadId, originPluginId: 'promptobus', content: input };
    queues.set(threadId, [entry]); return { ok: true, delivery: 'queued', queuedMessage: entry, waitingOn: { kind: 'thread-busy' } };
  } });
  await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'Two owned rows' }); await s.reconcile();
  const old = s.queues.get('thr-2')[0]; assert.equal((await s.control('stop', 'worker-one')).exitCode, 0);
  assert.equal((await s.control('resume', 'worker-one')).exitCode, 0);
  const current = s.queues.get('thr-2')[0]; const entries = currentFirst ? [current, old] : [old, current];
  s.queues.set('thr-2', entries);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  assert.equal((await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: 'promptobus', queuedMessages: entries,
    input: { blocks: entries.flatMap(entry => entry.content), text: entries.map(entry => entry.content[0].text).join('\n') } }))).action, 'wait');
  await s.reconcile(); assert.deepEqual(s.queues.get('thr-2'), [current]);
  assert.equal(s.delivery('thr-2').pending.text, current.content[0].text); assert.equal(s.delivery('thr-2').paused, false);
  assert.equal((await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: 'promptobus', queuedMessages: [current],
    input: { blocks: current.content, text: current.content[0].text } }))).action, 'proceed');
});


test('unattributed generated wakes are fenced while paused and preserve explicit foreign and user copies', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-one');
  await s.call('thr-1', 'promptobus_send', { to: ['worker-one'], type: 'status', body: 'SDK origin is absent' }); await s.reconcile();
  const input = s.wakes[0].input;
  assert.equal((await s.control('stop', 'worker-one')).exitCode, 0);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const context = blocks => makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: null,
    input: { blocks, text: blocks[0].text } });
  assert.equal((await hook(context(input))).action, 'reject');
  const copied = { id: 'manual-copy', threadId: 'thr-2', originPluginId: null, content: [{ type: 'text', text: input[0].text }] };
  const foreign = { id: 'foreign-copy', threadId: 'thr-2', originPluginId: 'another-plugin', content: input };
  s.queues.set('thr-2', [copied, foreign]); await s.reconcile();
  assert.deepEqual(s.queues.get('thr-2'), [copied, foreign]);
  assert.equal((await hook(context(copied.content))).action, 'proceed');
  await s.host.harness.behavior.emitThreadEvent('message.cancelled', { entry: copied });
  assert.equal(s.delivery('thr-2').reason.includes('User cancelled'), false);
});


for (const role of ['worker', 'reviewer']) test(`SDK display default: lone ${role} title carries task, role and subject without parsing assignment`, async t => {
  const s = await stand(t); await s.create();
  const result = await s.add('independent-name', role); assert.equal(result.exitCode, 0, result.stderr);
  const b = bindingStore(s.host.bb).participant(s.task, 'independent-name');
  assert.equal(s.threads.get(b.threadId).title, `${s.task} · ${role === 'worker' ? 'Worker' : 'Review'} · independent-name`);
  assert.equal(b.participant, 'independent-name'); assert.equal(b.environmentId, 'env');
  assert.equal(s.environment.name, null); assert.deepEqual(s.names, []);
});

test('SDK display override: related pair survives shared worker/reviewer environment and independent identities', async t => {
  const s = await stand(t); await s.create();
  const result = await s.add('alpha', 'worker', ['--new-environment', '--base-branch', 'main',
    '--display-label', 'TASK-12 + TASK-13', '--display-subject', 'Markdown anchors', '--repository-label', 'sample-repo']);
  assert.equal(result.exitCode, 0, result.stderr);
  const review = await s.add('beta', 'reviewer', ['--environment', 'bb-actual-env']); assert.equal(review.exitCode, 0, review.stderr);
  assert.equal(s.threads.get('thr-2').title, 'TASK-12 + TASK-13 · Worker · Markdown anchors');
  assert.equal(s.threads.get('thr-3').title, 'TASK-12 + TASK-13 · Review · Markdown anchors');
  assert.equal(s.workerEnvironment.name, 'TASK-12 + TASK-13 · sample-repo');
  assert.deepEqual(s.names, [{ environmentId: 'bb-actual-env', name: 'TASK-12 + TASK-13 · sample-repo' }]);
  assert.equal(bindingStore(s.host.bb).participant(s.task, 'beta').environmentId, 'bb-actual-env');
});

test('SDK display ownership: only a newly owned unnamed environment receives a default name', async t => {
  const s = await stand(t); await s.create();
  const added = await s.add('alpha', 'worker', ['--new-environment', '--base-branch', 'main']); assert.equal(added.exitCode, 0, added.stderr);
  assert.equal(s.workerEnvironment.name, `${s.task} · ${path.basename(s.root)}`);
  assert.deepEqual(s.names, [{ environmentId: 'bb-actual-env', name: `${s.task} · ${path.basename(s.root)}` }]);
});

for (const scenario of ['custom', 'existing-path', 'foreign-user', 'other-task']) test(`SDK display preservation: ${scenario} environment and unrelated threads stay unchanged`, async t => {
  const s = await stand(t, { existingEnvironment: scenario === 'existing-path' }); await s.create();
  if (scenario === 'existing-path') s.workerEnvironment.managed = false;
  if (scenario === 'custom') s.workerEnvironment.name = 'My custom worktree';
  if (scenario === 'foreign-user') s.threads.set('unrelated', makeThreadResponse({ id: 'unrelated', environmentId: 'bb-actual-env', title: 'Keep this title' }));
  if (scenario === 'other-task') {
    const foreign = { ...bindingStore(s.host.bb).task(s.task), task: newTaskIdentity('other-task').id, threadId: null, environmentId: 'bb-actual-env' };
    bindingStore(s.host.bb).reserve(foreign, true);
  }
  const before = structuredClone(s.threads.get('unrelated'));
  const extra = scenario === 'existing-path' ? ['--environment-path', s.workerEnvironment.path] : ['--new-environment', '--base-branch', 'main'];
  const result = await s.add('alpha', 'worker', extra); assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(s.workerEnvironment.name, scenario === 'custom' ? 'My custom worktree' : null);
  assert.deepEqual(s.names, []); assert.deepEqual(s.threads.get('unrelated'), before); assert.equal(s.environment.name, null);
});

for (const scenario of ['exception', 'unconfirmed']) test(`SDK display metadata failure: ${scenario} is visible and never reported as ready`, async t => {
  const s = await stand(t, scenario === 'exception' ? { nameError: 'Environment metadata unavailable' } : { nameUnconfirmed: true }); await s.create();
  const result = await s.add('alpha', 'worker', ['--new-environment', '--base-branch', 'main']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, scenario === 'exception' ? /Environment metadata unavailable/ : /BB environment naming was not confirmed/);
  const b = bindingStore(s.host.bb).participant(s.task, 'alpha'); assert.equal(b.phase, 'orphan');
  assert.equal(s.threads.get(b.threadId).status, 'idle'); assert.equal(s.events.includes('assignment'), false);
  assert.equal(bindingStore(s.host.bb).launchIntent(b).status, 'recorded');
});

async function displayAcceptance(t, extra = []) {
  const acceptance = { id: 'acceptance-env', projectId: 'project', path: '/dedicated/acceptance', hostId: 'local', managed: false,
    name: 'Acceptance worktree', environmentProviderInstanceKey: null, status: 'ready', lifecycle: { phase: 'active' } };
  const s = await stand(t, { environments: [acceptance] }); await s.create();
  const worker = await s.add('alpha', 'worker', extra); assert.equal(worker.exitCode, 0, worker.stderr);
  const reviewer = await s.add('beta', 'reviewer'); assert.equal(reviewer.exitCode, 0, reviewer.stderr);
  for (const from of ['alpha', 'beta']) await s.call(bindingStore(s.host.bb).participant(s.task, from).threadId, 'promptobus_send',
    { to: ['orchestrator'], type: 'result', body: 'Recorded result, content is opaque.' });
  return s;
}

for (const pair of [false, true]) test(`SDK display acceptance: authenticated worker parent and orchestrator lifecycle survive tools stop/resume (pair ${pair})`, async t => {
  const extra = pair ? ['--display-label', 'TASK-12 + TASK-13', '--display-subject', 'Markdown anchors'] : [];
  const s = await displayAcceptance(t, extra); const store = bindingStore(s.host.bb);
  const predecessors = ['alpha', 'beta'].map(id => store.participant(s.task, id));
  const before = predecessors.map(b => structuredClone(b));
  s.threads.set('unrelated', makeThreadResponse({ id: 'unrelated', environmentId: 'unrelated-env', title: 'Unrelated thread' }));
  const unrelated = structuredClone(s.threads.get('unrelated'));
  const added = await s.add('acceptor', 'approver', ['--environment', 'acceptance-env', '--worker', 'alpha', '--reviewer', 'beta']);
  assert.equal(added.exitCode, 0, added.stderr);
  const b = store.participant(s.task, 'acceptor'); const thread = s.threads.get(b.threadId);
  assert.equal(thread.parentThreadId, 'thr-2'); assert.equal(b.parentThreadId, 'thr-2');
  assert.equal(s.spawns.at(-1).parentThreadId, 'thr-2'); assert.equal(s.spawns.at(-1).lifecycleOwnerThreadId, 'thr-1');
  assert.equal(thread.lifecycleOwnerThreadId, 'thr-1'); assert.equal(b.lifecycleOwnerThreadId, 'thr-1');
  assert.equal(thread.title, `${pair ? 'TASK-12 + TASK-13' : s.task} · Acceptance · ${pair ? 'Markdown anchors' : 'alpha'}`);
  assert.equal(b.environmentId, 'acceptance-env'); assert.equal(b.environmentPath, '/dedicated/acceptance');
  assert.equal(b.branch, 'actual-bb-branch'); assert.equal(b.baseSha, 'b'.repeat(40)); assert.deepEqual(b.predecessors, { worker: 'alpha', reviewer: 'beta' });
  assert.notEqual(b.environmentId, predecessors[0].environmentId); assert.equal(s.environments.get('acceptance-env').name, 'Acceptance worktree');
  assert.equal(JSON.parse((await s.control('get', 'acceptor')).stdout).view.state, 'alive');
  const task = JSON.parse(await s.call(b.threadId, 'promptobus_task')); assert.equal(task.id, s.task); assert.equal(task.participant, 'acceptor');
  assert.deepEqual(task.contacts.filter(p => ['alpha', 'beta'].includes(p.id)).map(p => p.threadId).sort(), ['thr-2', 'thr-3']);
  assert.ok(await s.call(b.threadId, 'promptobus_mailbox', { mode: 'read' }));
  await s.call('thr-1', 'promptobus_send', { to: ['acceptor'], type: 'status', body: 'Orchestrator still owns the acceptance lifecycle.' }); await s.reconcile();
  assert.equal(s.wakes.at(-1).threadId, b.threadId);
  const stopped = await s.control('stop', 'acceptor'); assert.equal(stopped.exitCode, 0, stopped.stderr); assert.equal(JSON.parse(stopped.stdout).confirmed, true);
  assert.equal(s.delivery(b.threadId).paused, true);
  const resumed = await s.control('resume', 'acceptor'); assert.equal(resumed.exitCode, 0, resumed.stderr); assert.equal(s.delivery(b.threadId).paused, false);
  assert.ok(await s.call(b.threadId, 'promptobus_mailbox', { mode: 'read' }));
  assert.deepEqual(['alpha', 'beta'].map(id => store.participant(s.task, id)), before);
  assert.deepEqual(s.threads.get('unrelated'), unrelated); assert.deepEqual(s.names, []);
});

test('SDK display raw parent regression: metadata-only reparent rejects task mailbox inspection and lifecycle', async t => {
  const s = await displayAcceptance(t);
  const added = await s.add('acceptor', 'approver', ['--environment', 'acceptance-env', '--worker', 'alpha', '--reviewer', 'beta']); assert.equal(added.exitCode, 0, added.stderr);
  const b = bindingStore(s.host.bb).participant(s.task, 'acceptor'); const thread = s.threads.get(b.threadId);
  const before = structuredClone(thread); thread.parentThreadId = thread.parentThreadId === 'thr-2' ? 'thr-1' : 'thr-2';
  assert.equal(JSON.parse((await s.control('get', 'acceptor')).stdout).status, 'BB binding mismatch');
  await assert.rejects(s.call(b.threadId, 'promptobus_task'), /BB thread binding mismatch/);
  await assert.rejects(s.call(b.threadId, 'promptobus_mailbox', { mode: 'read' }), /BB thread binding mismatch/);
  assert.equal((await s.control('stop', 'acceptor')).exitCode, 1); assert.equal((await s.control('resume', 'acceptor')).exitCode, 1);
  Object.assign(thread, before); assert.equal(JSON.parse(await s.call(b.threadId, 'promptobus_task')).participant, 'acceptor');
});

for (const predecessor of ['alpha', 'beta']) for (const mismatch of ['parent', 'lifecycle', 'project', 'provider', 'environment', 'missing', 'foreign']) test(`SDK display predecessor refusal: ${predecessor} ${mismatch} never reserves or spawns acceptance`, async t => {
  const s = await displayAcceptance(t); const store = bindingStore(s.host.bb); const worker = store.participant(s.task, predecessor);
  if (mismatch === 'missing') s.threads.delete(worker.threadId);
  else if (mismatch === 'foreign') { s.threads.set('foreign-thread', makeThreadResponse({ id: 'foreign-thread' })); }
  else s.threads.get(worker.threadId)[`${mismatch === 'parent' ? 'parentThread' : mismatch === 'lifecycle' ? 'lifecycleOwnerThread' : mismatch}Id`] = 'foreign';
  const count = s.spawns.length;
  const result = await s.add('acceptor', 'approver', ['--environment', 'acceptance-env', '--worker', mismatch === 'foreign' && predecessor === 'alpha' ? 'foreign-worker' : 'alpha',
    '--reviewer', mismatch === 'foreign' && predecessor === 'beta' ? 'foreign-reviewer' : 'beta']);
  assert.equal(result.exitCode, 1, result.stdout); assert.equal(s.spawns.length, count); assert.equal(store.participant(s.task, 'acceptor'), undefined);
});


test('SDK display metadata failure: unconfirmed thread title fails before participant activation', async t => {
  const s = await stand(t, { titleUnconfirmed: true }); const result = await s.create();
  assert.equal(result.exitCode, 1); assert.match(result.stderr, /BB thread naming was not confirmed/);
  const b = bindingStore(s.host.bb).task(s.task); assert.equal(b.phase, 'orphan'); assert.equal(s.threads.get(b.threadId).status, 'idle');
});

test('SDK display ownership: newly registered unmanaged path is named only with its actual launch instance', async t => {
  const s = await stand(t); await s.create(); s.workerEnvironment.managed = false;
  const result = await s.add('alpha', 'worker', ['--environment-path', s.workerEnvironment.path]); assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(s.workerEnvironment.environmentProviderInstanceKey, 'thr-2'); assert.equal(s.workerEnvironment.name, `${s.task} · ${path.basename(s.root)}`);
  assert.equal(JSON.parse(result.stdout).display.environment.status, 'named');
});

test('SDK display legacy binding: absent optional metadata uses canonical task and participant fallback', async t => {
  const s = await stand(t); await s.create(); const store = bindingStore(s.host.bb); const owner = store.task(s.task);
  delete owner.display; store.save(owner); await s.reload();
  const result = await s.add('legacy-worker'); assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(s.threads.get('thr-2').title, `${s.task} · Worker · legacy-worker`);
});


for (const override of [false, true]) test(`SDK display existing-path reviewer: actual shared identity inherits labels after preparation (override ${override})`, async t => {
  const s = await stand(t); await s.create(); s.workerEnvironment.managed = false;
  const worker = await s.add('alpha', 'worker', ['--environment-path', s.workerEnvironment.path,
    '--display-label', 'TASK-12 + TASK-13', '--display-subject', 'Markdown anchors', '--repository-label', 'sample-repo']); assert.equal(worker.exitCode, 0, worker.stderr);
  const extra = override ? ['--display-subject', 'Independent review'] : [];
  const reviewer = await s.add('beta', 'reviewer', ['--environment-path', s.workerEnvironment.path, ...extra]); assert.equal(reviewer.exitCode, 0, reviewer.stderr);
  assert.equal(s.threads.get('thr-3').title, `TASK-12 + TASK-13 · Review · ${override ? 'Independent review' : 'Markdown anchors'}`);
  assert.equal(s.threads.get('thr-2').environmentId, s.threads.get('thr-3').environmentId);
  assert.equal(s.workerEnvironment.name, 'TASK-12 + TASK-13 · sample-repo'); assert.equal(s.names.length, 1);
});

for (const mode of ['exception', 'unconfirmed']) test(`SDK display existing-path reviewer: ${mode} title update refuses ready outcome`, async t => {
  const s = await stand(t, mode === 'exception' ? { titleUpdateError: 'Thread metadata unavailable' } : { titleUpdateUnconfirmed: true });
  await s.create(); s.workerEnvironment.managed = false;
  assert.equal((await s.add('alpha', 'worker', ['--environment-path', s.workerEnvironment.path, '--display-label', 'TASK-12'])).exitCode, 0);
  const result = await s.add('beta', 'reviewer', ['--environment-path', s.workerEnvironment.path]); assert.equal(result.exitCode, 1);
  assert.match(result.stderr, mode === 'exception' ? /Thread metadata unavailable/ : /BB thread naming was not confirmed/);
  assert.equal(bindingStore(s.host.bb).participant(s.task, 'beta').phase, 'orphan');
});

for (const provider of ['acp-cursor', 'acp-opencode']) for (const workspace of ['reuse', 'worktree', 'path']) {
  test(`ACP assignment starts with bound tools after early session configuration (${provider}, ${workspace})`, async t => {
    const s = await stand(t, { freezeEarlyCatalog: true });
    assert.equal((await s.create()).exitCode, 0);
    if (workspace === 'path') s.workerEnvironment.managed = false;
    const extra = workspace === 'worktree' ? ['--new-environment', '--base-branch', 'main']
      : workspace === 'path' ? ['--environment-path', s.workerEnvironment.path] : [];
    const added = await s.add('early-catalog', 'worker', ['--provider', provider, ...extra]);
    assert.equal(added.exitCode, 0, JSON.stringify(added));
    assert.deepEqual(s.catalogs.get('thr-2'), ['promptobus_send', 'promptobus_mailbox', 'promptobus_task', 'promptobus_artifact'],
      'The assignment must use a fresh provider session configured after the binding is ready');
    assert.deepEqual(s.events, ['provision', 'stop', 'clear-context', 'assignment']);
    assert.equal(s.initialArgs.prompt.includes('Preparation token:'), true);
    const b = bindingStore(s.host.bb).thread('thr-2');
    assert.equal(b.environmentId, workspace === 'reuse' ? 'env' : 'bb-actual-env');
    assert.equal(b.providerId, provider);
    assert.equal(JSON.parse(await s.call('thr-2', 'promptobus_task')).participant, 'early-catalog');
  });
}

for (const provider of ['acp-cursor', 'acp-opencode']) for (const failure of ['environment changed', 'Stop unconfirmed']) {
  test(`ACP reuse preparation refuses ${failure} without delivering assignment (${provider})`, async t => {
    const s = await stand(t, { afterPreparationIdle({ thread }) {
      if (failure === 'environment changed') thread.environmentId = 'bb-actual-env';
    } });
    assert.equal((await s.create()).exitCode, 0);
    if (failure === 'Stop unconfirmed') s.stopStatus = 'stopping';
    const result = await s.add('refused-preparation', 'worker', ['--provider', provider]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, failure === 'environment changed' ? /BB preparation environment changed/ : /BB preparation Stop was not confirmed/);
    assert.equal(s.events.includes('assignment'), false);
    assert.equal(bindingStore(s.host.bb).thread('thr-2').phase, 'orphan');
    await assert.rejects(s.call('thr-2', 'promptobus_task'), /not bound/);
  });
}

for (const boundary of ['clearContext', 'evidence']) test(`review boundary: Stop during ${boundary} retains the transfer epoch`, async t => {
  const entered = deferred(), release = deferred(); let block = false, reads = 0, delivered = 0;
  const s = await stand(t, {
    beforeClearContext: async () => { if (block && boundary === 'clearContext') { entered.resolve(); await release.promise; } },
    beforeArtifact: async () => { if (block && boundary === 'evidence' && ++reads === 8) { entered.resolve(); await release.promise; } },
    assignmentSend: async () => { delivered++; return { ok: true, delivery: 'sent' }; },
  });
  await s.create(); await s.add('review-boundary', 'reviewer'); await s.control('stop', 'review-boundary');
  const b = bindingStore(s.host.bb).thread('thr-2'), next = structuredClone(b.launchContext);
  next.grant.token = 'transfer-boundary'; next.grant.phase = 'repair';
  await s.publish(next);
  const f = await evidenceFixture(s.root, s.task); block = true;
  const pending = s.host.harness.behavior.runCli(['participant', 'resume', '--task', s.task, '--participant', b.participant,
    '--launch-context', JSON.stringify(next), '--evidence-manifest', JSON.stringify(f.manifest), '--assignment', 'Complete bounded repair context.']);
  await entered.promise; await s.control('stop', b.participant); const stoppedEpoch = s.delivery('thr-2').epoch; release.resolve();
  const result = await pending;
  assert.equal(result.exitCode, 1, 'A Stop during the asynchronous transfer must refuse resume');
  assert.match(result.stderr, /Stop/); assert.equal(s.delivery('thr-2').paused, true);
  assert.equal(s.delivery('thr-2').epoch, stoppedEpoch); assert.equal(delivered, 0); assert.equal(s.spawns.length, 2);
});

test('review boundary: selected reviewer snapshot must match the declared evidence source before spawn', async t => {
  const s = await stand(t); await s.create();
  const launch = launchFixture(s.task, 'wrong-snapshot', 'reviewer', s.root);
  launch.review = { producer: 'orchestrator', producerBinding: 'participant', sourceEnvironmentId: s.workerEnvironment.id,
    base: 'a'.repeat(40), requiredGates: [['fiction', 'gate']], requirePassingGates: true };
  const f = await evidenceFixture(s.root, s.task, 'b'.repeat(40)); const before = s.spawns.length;
  const result = await s.add('wrong-snapshot', 'reviewer', ['--environment', 'env', '--launch-context', JSON.stringify(launch),
    '--evidence-manifest', JSON.stringify(f.manifest)]);
  assert.equal(result.exitCode, 1, 'Evidence for environment B must not start a reader of environment A');
  assert.match(result.stderr, /snapshot.*source SHA mismatch/); assert.equal(s.spawns.length, before);
});

test('review boundary: a worker relay cannot authorize a Root-labelled external producer', async t => {
  const s = await stand(t); await s.create(); await s.add('worker-relay');
  const launch = launchFixture(s.task, 'unapproved-root', 'reviewer', s.root);
  launch.review = { producer: 'Root operator', producerBinding: 'owner-declaration', sourceEnvironmentId: 'env', base: 'a'.repeat(40),
    requiredGates: [['fiction', 'gate']], requirePassingGates: true };
  const f = await evidenceFixture(s.root, s.task, 'a'.repeat(40), 'a'.repeat(40), 'Root operator', 'worker-relay');
  const before = s.spawns.length;
  const result = await s.add('unapproved-root', 'reviewer', ['--launch-context', JSON.stringify(launch), '--evidence-manifest', JSON.stringify(f.manifest)]);
  assert.equal(result.exitCode, 1, 'A magic producerBinding label is not an authenticated owner authorization');
  assert.match(result.stderr, /canonical owner declaration/); assert.equal(s.spawns.length, before);
});

test('review boundary: cancelling queued initial context retains its fence and retries the complete assignment', async t => {
  let delivered = '', count = 0;
  const s = await stand(t, { assignmentSend: async ({ threadId, input }) => {
    delivered = input[0].text;
    const entry = { id: `initial-queue-${++count}`, threadId, originPluginId: 'promptobus', content: input };
    s.queues.set(threadId, [entry]); return { ok: true, delivery: 'queued', queuedMessage: entry };
  } });
  await s.create(); await s.add('queued-review', 'reviewer'); await s.control('stop', 'queued-review');
  await s.call('thr-1', 'promptobus_send', { to: ['queued-review'], type: 'task', body: 'Canonical repair task.' });
  const b = bindingStore(s.host.bb).thread('thr-2'), next = structuredClone(b.launchContext);
  next.grant.token = 'queued-complete-phase'; next.grant.phase = 'repair';
  await s.publish(next);
  const f = await evidenceFixture(s.root, s.task);
  const first = await s.host.harness.behavior.runCli(['participant', 'resume', '--task', s.task, '--participant', b.participant,
    '--launch-context', JSON.stringify(next), '--evidence-manifest', JSON.stringify(f.manifest), '--assignment', 'Complete initial original context.']);
  assert.equal(first.exitCode, 0, first.stderr); const original = delivered;
  const entry = s.queues.get('thr-2')[0]; s.queues.set('thr-2', []);
  await s.host.harness.behavior.emitThreadEvent('message.cancelled', { entry }); await s.reconcile();
  assert.equal(s.delivery('thr-2').paused, true, 'Cancellation must not allow a mailbox-only activation');
  assert.equal(bindingStore(s.host.bb).thread('thr-2').phaseAssignmentPending, true);
  assert.equal(s.wakes.filter(w => w.threadId === 'thr-2').length, 0);
  assert.equal((await s.control('resume', b.participant)).exitCode, 0);
  assert.equal(delivered, original); assert.ok(delivered.includes(JSON.stringify(next.role.literal)));
  for (const ref of f.manifest.artifacts) assert.ok(delivered.includes(ref.id));
  await s.host.harness.behavior.emitThreadEvent('message.cancelled', { entry });
  assert.equal(s.delivery('thr-2').paused, false, 'An obsolete queue ID cannot cancel the retried initial delivery');
  const current = s.queues.get('thr-2')[0]; s.queues.set('thr-2', []);
  const requested = s.append('thr-2', 'client/turn/requested', { input: current.content });
  s.threads.get('thr-2').status = s.threads.get('thr-2').runtime.displayStatus = 'active';
  await s.reconcile(); const accepted = bindingStore(s.host.bb).thread('thr-2');
  assert.equal(accepted.phaseAssignmentPending, false); assert.equal(accepted.phaseAssignmentDelivery.requestId, requested.data.requestId);
});

for (const scenario of ['owner', 'worker', 'wrong-hash', 'wrong-token', 'wrong-reviewer', 'wrong-environment']) {
  test(`review owner declaration: ${scenario} canonical sender and exact scope`, async t => {
    const s = await stand(t); await s.create(); await s.add('worker-relay');
    const launch = launchFixture(s.task, 'authorized-root', 'reviewer', s.root);
    const f = await evidenceFixture(s.root, s.task, 'a'.repeat(40), 'a'.repeat(40), 'Root operator', 'worker-relay');
    const declaration = { version: 1, task: s.task, reviewer: 'authorized-root', grantToken: launch.grant.token,
      producer: 'Root operator', sourceEnvironmentId: 'env', manifestSha256: digest(JSON.stringify(evidenceManifestSchema.parse(f.manifest))) };
    if (scenario === 'wrong-hash') declaration.manifestSha256 = 'f'.repeat(64);
    if (scenario === 'wrong-token') declaration.grantToken = 'old-ended-token';
    if (scenario === 'wrong-reviewer') declaration.reviewer = 'someone-else';
    if (scenario === 'wrong-environment') declaration.sourceEnvironmentId = 'bb-actual-env';
    const landed = JSON.parse(await s.call(scenario === 'worker' ? 'thr-2' : 'thr-1', 'promptobus_send', {
      to: ['orchestrator'], type: 'artifact', body: 'Explicit fictional owner declaration.', artifact: { filename: 'owner-declaration.txt', content: JSON.stringify(declaration) },
    }));
    launch.review = { producer: 'Root operator', producerBinding: 'owner-declaration', ownerDeclaration: landed.artifact.id,
      sourceEnvironmentId: 'env', base: 'a'.repeat(40), requiredGates: [['fiction', 'gate']], requirePassingGates: true };
    const before = s.spawns.length;
    const result = await s.add('authorized-root', 'reviewer', ['--launch-context', JSON.stringify(launch), '--evidence-manifest', JSON.stringify(f.manifest)]);
    assert.equal(result.exitCode, scenario === 'owner' ? 0 : 1, result.stderr);
    assert.equal(s.spawns.length, before + (scenario === 'owner' ? 1 : 0));
    if (scenario !== 'owner') assert.match(result.stderr, /canonical owner declaration sender\/scope mismatch/);
  });
}

test('review boundary: prepared initial context also survives queue cancellation', async t => {
  let delivered;
  const s = await stand(t, { assignmentSend: async ({ threadId, input }) => {
    delivered = input[0].text; const entry = { id: 'prepared-initial', threadId, originPluginId: 'promptobus', content: input };
    s.queues.set(threadId, [entry]); return { ok: true, delivery: 'queued', queuedMessage: entry };
  } });
  await s.create(); s.workerEnvironment.managed = false;
  assert.equal((await s.add('prepared-review', 'reviewer', ['--environment-path', s.workerEnvironment.path])).exitCode, 0);
  const initial = delivered, entry = s.queues.get('thr-2')[0]; s.queues.set('thr-2', []);
  await s.host.harness.behavior.emitThreadEvent('message.cancelled', { entry });
  await s.reconcile(); assert.equal(s.delivery('thr-2').paused, true, 'A prepared reviewer has not received the manifest until its complete initial context is delivered');
  assert.equal(bindingStore(s.host.bb).thread('thr-2').phaseAssignmentPending, true);
  assert.equal((await s.control('resume', 'prepared-review')).exitCode, 0); assert.equal(delivered, initial);
});

for (const boundary of ['binding', 'engine', 'control']) test(`review2 boundary: plain resume Stop during ${boundary} await keeps its original epoch`, async t => {
  const entered = deferred(), release = deferred(); let block = false;
  const wait = async () => { if (block) { block = false; entered.resolve(); await release.promise; } };
  const s = await stand(t, { beforeGet: async id => { if (boundary === 'binding' && id === 'thr-2') await wait(); },
    beforeCheck: async () => { if (boundary === 'engine') await wait(); },
    beforeControl: async input => { if (boundary === 'control' && input.binding.participant === 'plain-worker') await wait(); } });
  await s.create(); await s.add('plain-worker'); await s.control('stop', 'plain-worker');
  await s.call('thr-1', 'promptobus_send', { to: ['plain-worker'], type: 'task', body: 'Canonical bounded task.' });
  block = true; const pending = s.control('resume', 'plain-worker'); await entered.promise;
  await s.control('stop', 'plain-worker'); const epoch = s.delivery('thr-2').epoch; release.resolve();
  const result = await pending;
  assert.equal(result.exitCode, 1, 'Stop before recovery.resume must not be replaced by a newly captured epoch');
  assert.match(result.stderr, /newer Stop/); assert.equal(s.delivery('thr-2').paused, true); assert.equal(s.delivery('thr-2').epoch, epoch);
  assert.equal(s.wakes.filter(w => w.threadId === 'thr-2').length, 0);
});

for (const phase of ['fresh', 'prepared', 'unrelated-copy']) test(`review2 boundary: anonymous early ${phase} initial cancellation correlates the late queue ID and retries exact context`, async t => {
  const entered = deferred(), release = deferred(); let first = true, delivered;
  const s = await stand(t, { assignmentSend: async ({ threadId, input }) => {
    delivered = input[0].text;
    if (!first) return { ok: true, delivery: 'sent' };
    first = false; const entry = { id: 'late-initial-queue', threadId, originPluginId: null, content: input };
    s.queues.set(threadId, [entry]); entered.resolve(entry); await release.promise;
    return { ok: true, delivery: 'queued', queuedMessage: entry };
  } });
  await s.create(); let pending;
  if (phase === 'prepared') {
    s.workerEnvironment.managed = false; pending = s.add('early-cancel', 'reviewer', ['--environment-path', s.workerEnvironment.path]);
  } else {
    await s.add('early-cancel', 'reviewer'); await s.control('stop', 'early-cancel');
    const b = bindingStore(s.host.bb).thread('thr-2'), next = structuredClone(b.launchContext);
    next.grant.token = 'early-cancel-phase'; next.grant.phase = 'repair';
    await s.publish(next); const f = await evidenceFixture(s.root, s.task);
    pending = s.host.harness.behavior.runCli(['participant', 'resume', '--task', s.task, '--participant', b.participant,
      '--launch-context', JSON.stringify(next), '--evidence-manifest', JSON.stringify(f.manifest), '--assignment', 'Whole original context.']);
  }
  const entry = await entered.promise, original = delivered;
  if (phase !== 'unrelated-copy') s.queues.set('thr-2', []);
  await s.host.harness.behavior.emitThreadEvent('message.cancelled', { entry: phase === 'unrelated-copy' ? { ...entry, id: 'unrelated-queue' } : entry }); await s.reconcile();
  assert.equal(s.wakes.filter(w => w.threadId === 'thr-2').length, 0); release.resolve();
  const result = await pending; assert.equal(result.exitCode, 0, result.stderr);
  if (phase === 'unrelated-copy') {
    assert.equal(s.delivery('thr-2').paused, false, 'A different queue ID cannot cancel the actual initial delivery');
    assert.equal(bindingStore(s.host.bb).thread('thr-2').phaseAssignmentDelivery.state, 'queued');
    s.queues.set('thr-2', []); await s.host.harness.behavior.emitThreadEvent('message.cancelled', { entry });
  }
  assert.equal(s.delivery('thr-2').paused, true, 'The late reply must correlate cancellation instead of saving an eternally queued deleted ID');
  assert.equal(bindingStore(s.host.bb).thread('thr-2').phaseAssignmentDelivery.state, 'cancelled');
  assert.equal(bindingStore(s.host.bb).thread('thr-2').phaseAssignmentPending, true);
  assert.equal((await s.control('resume', 'early-cancel')).exitCode, 0); assert.equal(delivered, original);
  assert.equal(bindingStore(s.host.bb).thread('thr-2').phaseAssignmentPending, false);
});

for (const condition of ['STOP', 'ended']) test(`review2 boundary: bound reviewer file reads refuse ${condition} before filesystem access`, async t => {
  let reads = 0; const s = await stand(t, { beforeRead: async () => { reads++; } }); await s.create();
  const launch = launchFixture(s.task, 'file-reader', 'reviewer', s.root);
  launch.review = { producer: 'orchestrator', producerBinding: 'participant', sourceEnvironmentId: 'env', base: 'a'.repeat(40), requiredGates: [['fiction', 'gate']], requirePassingGates: true };
  await s.publish(launch);
  assert.equal((await s.add('file-reader', 'reviewer', ['--launch-context', JSON.stringify(launch)])).exitCode, 0);
  const file = path.join(s.root, 'owned-source.txt'); writeFileSync(file, 'bounded source');
  await s.call('thr-2', 'pb_review_read_file', { path: file }); assert.equal(reads, 1);
  await s.publish(null, condition === 'STOP' ? { STOP: true } : { grants: { orchestrator: bindingStore(s.host.bb).task(s.task).launchContext.grant } });
  await assert.rejects(s.call('thr-2', 'promptobus_task'), /STOP|grant-mismatch/);
  await assert.rejects(s.call('thr-2', 'pb_review_read_file', { path: file }), /STOP|grant-mismatch/);
  assert.equal(reads, 1, 'The admission refusal must precede the actual bounded filesystem handler');
});

for (const condition of ['STOP', 'ended']) test(`dispatch rechecks file control ${condition} before an owned model turn`, async t => {
  const s = await stand(t); await s.create();
  const launch = launchFixture(s.task, 'controlled-worker', 'worker', s.root);
  await s.publish(launch);
  assert.equal((await s.add('controlled-worker', 'worker', ['--launch-context', JSON.stringify(launch)])).exitCode, 0);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const context = makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), origin: 'plugin', originPluginId: 'promptobus',
    input: { blocks: [{ type: 'text', text: s.initialArgs.prompt }], text: s.initialArgs.prompt } });
  assert.equal((await hook(context)).action, 'proceed');
  await s.publish(null, condition === 'STOP' ? { STOP: true } : { grants: { orchestrator: bindingStore(s.host.bb).task(s.task).launchContext.grant } });
  assert.notEqual((await hook(context)).action, 'proceed', 'Revoked file control must prevent the next model turn');
});

for (const condition of ['STOP', 'ended']) test(`anonymous initial dispatch rechecks ${condition} for queued and copied input`, async t => {
  let entry;
  const s = await stand(t, { assignmentSend: async ({ threadId, input }) => {
    entry = { id: 'controlled-initial', threadId, originPluginId: null, content: input };
    s.queues.set(threadId, [entry]); return { ok: true, delivery: 'queued', queuedMessage: entry };
  } });
  await s.create(); s.workerEnvironment.managed = false;
  mkdirSync(s.workerEnvironment.path);
  const launch = launchFixture(s.task, 'anonymous-worker', 'worker', s.workerEnvironment.path, 'actual-bb-branch', 'b'.repeat(40));
  launch.readRoots.push(s.root);
  await s.publish(launch);
  const added = await s.add('anonymous-worker', 'worker', ['--environment-path', s.workerEnvironment.path, '--launch-context', JSON.stringify(launch)]);
  assert.equal(added.exitCode, 0, added.stderr);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const input = { blocks: entry.content, text: entry.content[0].text };
  const context = queued => makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: null, input, queuedMessages: [queued] });
  assert.equal((await hook(context(entry))).action, 'proceed');
  assert.equal((await hook(context({ ...entry, id: 'unrelated-copy' }))).action, 'proceed');
  await s.publish(null, condition === 'STOP' ? { STOP: true } : { grants: { orchestrator: bindingStore(s.host.bb).task(s.task).launchContext.grant } });
  assert.notEqual((await hook(context(entry))).action, 'proceed', 'The authoritative initial queue must recheck current control');
  assert.notEqual((await hook(context({ ...entry, id: 'unrelated-copy' }))).action, 'proceed', 'User input cannot reactivate a revoked participant grant');
});

for (const condition of ['STOP', 'ended']) for (const delivery of ['queued', 'sent']) test(`anonymous sending dispatch holds ${condition} before its ${delivery} receipt lands`, async t => {
  const entered = deferred(), release = deferred(); let entry;
  const s = await stand(t, { assignmentSend: async ({ threadId, input }) => {
    entry = { id: 'early-control', threadId, originPluginId: null, content: input };
    s.queues.set(threadId, [entry]); entered.resolve(); await release.promise;
    return { ok: true, delivery: 'queued', queuedMessage: entry };
  } });
  await s.create(); s.workerEnvironment.managed = false; mkdirSync(s.workerEnvironment.path);
  const launch = launchFixture(s.task, 'early-worker', 'worker', s.workerEnvironment.path, 'actual-bb-branch', 'b'.repeat(40));
  launch.readRoots.push(s.root);
  await s.publish(launch);
  const pending = s.add('early-worker', 'worker', ['--environment-path', s.workerEnvironment.path, '--launch-context', JSON.stringify(launch)]);
  await entered.promise;
  try {
    const binding = bindingStore(s.host.bb).thread('thr-2');
    assert.equal(binding.phaseAssignmentDelivery.state, 'sending'); assert.equal(binding.phaseAssignmentDelivery.queuedId, null);
    await s.publish(null, condition === 'STOP' ? { STOP: true } : { grants: { orchestrator: bindingStore(s.host.bb).task(s.task).launchContext.grant } });
    const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
    const result = await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: null,
      input: { blocks: entry.content, text: entry.content[0].text }, queuedMessages: delivery === 'queued' ? [entry] : [] }));
    assert.equal(result.action, 'reject', 'A revoked participant grant must prevent an early anonymous model turn');
  } finally { release.resolve(); await pending; }
});

test('owner current source revokes a constrained reviewer after owner thread disappears while inline evidence remains unchanged', async t => {
  const s = await stand(t); assert.equal((await s.create()).exitCode, 0);
  const root = path.join(s.root, 'restricted-review'); mkdirSync(root);
  s.environments.set('restricted', { ...s.environment, id: 'restricted', path: root });
  const launch = launchFixture(s.task, 'restricted-reviewer', 'reviewer', root, 'actual-bb-branch', 'b'.repeat(40));
  launch.review = { producer: 'orchestrator', producerBinding: 'participant', sourceEnvironmentId: 'restricted', base: 'a'.repeat(40),
    requiredGates: [['fiction', 'gate']], requirePassingGates: true };
  const historical = JSON.stringify(launch.control.snapshot);
  const evidence = path.join(root, 'historical-inline.json'); writeFileSync(evidence, historical);
  const manifest = (await evidenceFixture(s.root, s.task, 'b'.repeat(40))).manifest;
  const added = await s.add('restricted-reviewer', 'reviewer', ['--environment', 'restricted', '--launch-context', JSON.stringify(launch),
    '--evidence-manifest', JSON.stringify(manifest)]);
  assert.equal(added.exitCode, 0, added.stderr);
  const binding = bindingStore(s.host.bb).thread('thr-2');
  assert.deepEqual(binding.launchContext.readRoots, [root]);
  assert.equal(binding.launchContext.control.reference.directory.startsWith(`${root}/`), false);
  await s.call('thr-2', 'promptobus_task');
  s.threads.delete('thr-1');
  await s.publish(null, { STOP: true });
  await assert.rejects(s.call('thr-2', 'promptobus_task'), /Current control blocked.*STOP/);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const result = await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: 'promptobus',
    input: { blocks: [{ type: 'text', text: s.initialArgs.prompt }], text: s.initialArgs.prompt } }));
  assert.equal(result.action, 'reject');
  assert.equal(readFileSync(evidence, 'utf8'), historical);
  assert.deepEqual(bindingStore(s.host.bb).thread('thr-2').launchContext.readRoots, [root]);
});

for (const status of ['error', 'missing', 'unknown']) test(`ready owner with ${status} runtime can deny authority while issuance and unstop stay refused`, async t => {
  const s = await stand(t); assert.equal((await s.create()).exitCode, 0);
  const file = path.join(s.root, 'current-control', 'current.json');
  const publish = async patch => {
    const { format, revision, ...input } = JSON.parse(readFileSync(file, 'utf8'));
    return s.host.harness.behavior.runCli(['control', 'publish', '--task', s.task, '--expected-revision', String(revision),
      '--input', JSON.stringify({ ...input, ...patch })]);
  };
  if (status === 'missing') s.threads.delete('thr-1');
  else s.threads.get('thr-1').status = s.threads.get('thr-1').runtime.displayStatus = status === 'error' ? 'error' : 'stopped';
  const grant = structuredClone(bindingStore(s.host.bb).task(s.task).launchContext.grant);
  grant.token = 'unhealthy-issued-token'; grant.phase = 'unhealthy-issued-phase';
  const issue = await publish({ grants: { orchestrator: grant } });
  assert.equal(issue.exitCode, 1); assert.match(issue.stderr, /deny-only/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, 1);
  const revoked = await publish({ STOP: true }); assert.equal(revoked.exitCode, 0, revoked.stderr);
  const unstop = await publish({ STOP: false }); assert.equal(unstop.exitCode, 1); assert.match(unstop.stderr, /deny-only/);
  const ended = await publish({ grants: {} }); assert.equal(ended.exitCode, 0, ended.stderr);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).revision, 3);
});

for (const legacy of ['inline', 'missing']) test(`${legacy} historical launch remains status-readable and migration-blocked at every live admission`, async t => {
  const s = await stand(t); await s.create(); await s.add('legacy-worker');
  const store = bindingStore(s.host.bb), binding = store.thread('thr-2');
  if (legacy === 'inline') {
    binding.launchContext.control = launchFixture(s.task, binding.participant, binding.role, s.root).control;
    binding.launchContext.role.literal = 'Historical role literal retained as evidence';
  } else delete binding.launchContext;
  store.save(binding);
  const get = await s.host.harness.behavior.runCli(['participant', 'get', '--task', s.task, '--participant', binding.participant]);
  assert.equal(get.exitCode, 0, get.stderr);
  await assert.rejects(s.call('thr-2', 'promptobus_task'), /migration/);
  const hook = s.host.harness.inspection.registrations.hooks['message.dispatch'];
  const dispatch = await hook(makeMessageDispatchHookContext({ thread: s.threads.get('thr-2'), originPluginId: 'promptobus',
    input: { blocks: [{ type: 'text', text: s.initialArgs.prompt }], text: s.initialArgs.prompt } }));
  assert.equal(dispatch.action, 'reject'); assert.match(dispatch.message, /migration/);
  const resumed = await s.control('resume', binding.participant);
  assert.equal(resumed.exitCode, 1); assert.match(resumed.stderr, /migration/);
  assert.deepEqual(store.thread('thr-2'), binding);
});

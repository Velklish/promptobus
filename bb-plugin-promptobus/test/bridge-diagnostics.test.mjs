import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import { bindingStore } from '../.test-build/bindings.js';
import { registerBridgeDiagnostics } from '../.test-build/bridge-diagnostics.js';

function fixture(t, provider = 'acp-cursor') {
  const thread = makeThreadResponse({ id: 'thr-probe', projectId: 'proj_gdmr94qxzs', environmentId: 'env-probe', providerId: provider });
  let primaryHostId = 'host_xj49wfq3ap';
  const host = createFakePluginHost({ pluginId: 'promptobus', sdk: {
    system: { config: async () => ({ primaryHostId }) }, threads: { get: async () => thread },
  } });
  t.after(() => host.harness.lifecycle.dispose());
  const store = bindingStore(host.bb);
  const binding = { task: 'backlogs-t20261012-1840', participant: provider === 'acp-cursor' ? 'bridgecu2' : 'bridgego2',
    role: 'worker', projectId: thread.projectId, environmentId: thread.environmentId, environmentPath: '/private/probe',
    hostId: primaryHostId, providerId: provider, root: '/private/task', token: '22222222-2222-4222-8222-222222222222',
    threadId: thread.id, phase: 'ready', bootstrap: 'SECRET_PROMPT', hostContext: { rules: [], skills: [], tools: [] } };
  store.reserve(binding, true);
  const directories = [];
  t.mock.method(fs, 'mkdirSync', (...args) => { directories.push(args); });
  t.mock.method(fs, 'lstatSync', () => ({ isDirectory: () => true, isSymbolicLink: () => false }));
  t.mock.method(fs, 'chmodSync', (...args) => { directories.push(args); });
  const trace = registerBridgeDiagnostics(host.bb, store);
  const context = { threadId: thread.id, projectId: thread.projectId, hostId: binding.hostId };
  return { host, store, binding, thread, directories, trace, context,
    env: (ctx = context, id = provider) => host.harness.behavior.resolveProviderEnv(id, ctx),
    set primaryHostId(value) { primaryHostId = value; } };
}

for (const provider of ['acp-cursor', 'acp-opencode']) test(`temporary bridge recording selects only the exact owned ${provider} probe`, async t => {
  const s = fixture(t, provider);
  assert.deepEqual(await s.env(), [{ name: 'BB_PROVIDER_BRIDGE_RECORD_DIR',
    value: '/Users/kim.p/.bb/thread-storage/thr_sp4g9f2jit/main-run/bridge-records/thr-probe',
    reason: 'Temporary scoped bridge diagnostic recording' }]);
  assert.deepEqual(s.directories, [
    ['/Users/kim.p/.bb/thread-storage/thr_sp4g9f2jit/main-run/bridge-records/thr-probe', { recursive: true, mode: 0o700 }],
    ['/Users/kim.p/.bb/thread-storage/thr_sp4g9f2jit/main-run/bridge-records/thr-probe', 0o700],
  ]);
  assert.equal(s.host.harness.inspection.logEntries.length, 0);
});

for (const mismatch of ['unknown thread', 'task', 'project', 'host', 'old actor', 'actor prefix', 'provider', 'phase', 'primary host', 'actual provider', 'actual project', 'archived']) {
  test(`temporary bridge recording fails closed on ${mismatch}`, async t => {
    const s = fixture(t);
    let context = s.context;
    if (mismatch === 'unknown thread') context = { ...context, threadId: 'thr-unknown' };
    if (mismatch === 'task') s.binding.task = 'other-task';
    if (mismatch === 'project') context = { ...context, projectId: 'other-project' };
    if (mismatch === 'host') context = { ...context, hostId: 'other-host' };
    if (mismatch === 'old actor') s.binding.participant = 'bridgecu';
    if (mismatch === 'actor prefix') s.binding.participant = 'bridgecu2-extra';
    if (mismatch === 'provider') s.binding.providerId = 'acp-opencode';
    if (mismatch === 'phase') s.binding.phase = 'orphan';
    if (mismatch === 'primary host') s.primaryHostId = 'other-host';
    if (mismatch === 'actual provider') s.thread.providerId = 'acp-opencode';
    if (mismatch === 'actual project') s.thread.projectId = 'other-project';
    if (mismatch === 'archived') s.thread.archivedAt = 1;
    if (mismatch === 'task' || mismatch === 'old actor' || mismatch === 'actor prefix') {
      s.store.thread = () => s.binding;
    } else s.store.save(s.binding);
    assert.deepEqual(await s.env(context), []);
    assert.deepEqual(s.directories, []);
  });
}

test('temporary bridge recording refuses a cross-provider callback and a symlink destination', async t => {
  const s = fixture(t);
  assert.deepEqual(await s.env(s.context, 'acp-opencode'), []);
  assert.deepEqual(s.directories, []);
  t.mock.method(fs, 'lstatSync', () => ({ isDirectory: () => false, isSymbolicLink: () => true }));
  assert.deepEqual(await s.env(), []);
  assert.equal(s.directories.length, 1);
});

test('temporary configuration trace logs only selected names, tuple identities and mismatch booleans', t => {
  const s = fixture(t);
  const context = makePluginAgentConfigurationContext({ thread: { id: s.thread.id, title: 'SECRET_TITLE' },
    project: { id: s.binding.projectId, name: 'SECRET_PROJECT' }, environment: { id: s.binding.environmentId, path: '/SECRET_PATH' },
    host: { id: s.binding.hostId }, provider: { id: s.binding.providerId, model: 'SECRET_MODEL' },
    pluginMetadata: { token: 'SECRET_TOKEN', participant: 'bridgecu2', task: s.binding.task } });
  s.trace(context, []);
  const text = s.host.harness.inspection.logEntries[0].message;
  assert.equal(text.includes('SECRET'), false);
  const data = JSON.parse(text.slice('Promptobus bridge configuration '.length));
  assert.deepEqual(data.mismatches, ['path']);
  assert.deepEqual(data.selectedNames, []);
  assert.equal(data.selectedCount, 0);
  s.trace({ ...context, environment: { ...context.environment, path: s.binding.environmentPath } }, ['promptobus_task']);
  const selected = JSON.parse(s.host.harness.inspection.logEntries[1].message.slice('Promptobus bridge configuration '.length));
  assert.deepEqual(selected.mismatches, []);
  assert.deepEqual(selected.selectedNames, ['promptobus_task']);
  assert.equal(selected.selectedCount, 1);
  s.trace({ ...context, thread: { ...context.thread, id: 'thr-unknown' } }, ['SECRET_TOOL']);
  assert.equal(s.host.harness.inspection.logEntries.length, 2);
});

test('temporary recording ignores untrusted metadata and traversal-like thread ids', async t => {
  const s = fixture(t);
  assert.deepEqual(await s.env({ ...s.context, threadId: 'thr-unknown',
    pluginMetadata: { task: s.binding.task, participant: s.binding.participant, token: 'SECRET_TOKEN' } }), []);
  s.binding.threadId = '../escape';
  s.store.thread = () => s.binding;
  assert.deepEqual(await s.env({ ...s.context, threadId: '../escape' }), []);
  assert.deepEqual(s.directories, []);
});

test('temporary recording rechecks binding after asynchronous SDK identity observations', async t => {
  const s = fixture(t);
  s.host.harness.inspection.sdk.stub('threads.get', async () => {
    s.store.thread = () => undefined;
    return s.thread;
  });
  assert.deepEqual(await s.env(), []);
  assert.deepEqual(s.directories, []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { captureBbWorkspace, recordBbWorkspace } from '../.test-build/lifecycle.js';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const binding = { environmentId: 'env', projectId: 'project', hostId: 'local', environmentPath: '/actual/worktree',
  threadId: 'thread', baseSha: base };
const key = '["env",{"type":"all","mergeBaseBranch":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},false,"result.txt","revision-1"]';
const patch = { path: 'result.txt', patch: 'diff --git a/result.txt b/result.txt\n+saved\n', truncated: false };

function fixture(t, override = {}) {
  const status = { outcome: 'available', workspace: {
    checkout: { kind: 'branch', headSha: head }, branch: { currentBranch: 'actual-branch' },
    mergeBase: { baseRef: base, behindCount: 0, files: [] }, workingTree: { files: [{ path: 'result.txt', status: '??' }] },
  } };
  const files = { outcome: 'available', files: [{ path: 'result.txt', revision: 'revision-1', binary: false, loadMode: 'auto' }],
    truncated: false, mergeBaseRef: base };
  const patches = { [key]: { outcome: 'available', patch: { ...patch } } };
  const responses = { workspaceStatus: status, files, patches };
  const host = createFakePluginHost({ pluginId: 'promptobus', sdk: {
    environments: { get: async () => ({ id: 'env', projectId: 'project', hostId: 'local', path: binding.environmentPath,
      status: 'ready', lifecycle: { phase: 'active' } }) },
    plugins: { callRpc: async args => {
      assert.equal(args.pluginId, 'bb--git');
      assert.ok(args.outputSchema, 'Cross-plugin RPC must declare the consumed output schema');
      return override[args.method] ? override[args.method](args, responses) : responses[args.method];
    } },
  } });
  t.after(() => host.harness.lifecycle.dispose());
  return { ...host, status, files, patches, calls: () => host.harness.inspection.sdk.callsTo('plugins.callRpc').map(([args]) => args) };
}

test('workspace capture uses public Git RPC revision keys and retains exact binding and patches across two reads', async t => {
  const f = fixture(t), signal = new AbortController().signal;
  assert.deepEqual(await captureBbWorkspace(f.bb, binding, signal), { baseSha: base, headSha: head,
    branch: 'actual-branch', patches: [patch], environmentId: binding.environmentId, environmentPath: binding.environmentPath,
    hostId: binding.hostId, threadId: binding.threadId });
  assert.deepEqual(f.calls().map(({ method, input, signal: passed }) => {
    assert.equal(passed, signal); return { method, input };
  }), Array.from({ length: 2 }, () => [
    { method: 'workspaceStatus', input: { environmentId: 'env', mergeBaseBranch: base } },
    { method: 'files', input: { environmentId: 'env', target: { type: 'all', mergeBaseBranch: base }, ignoreWhitespace: false } },
    { method: 'patches', input: { keys: [key] } },
  ]).flat());
});

test('workspace recording uses the validated public status without passing signal in RPC input', async t => {
  const f = fixture(t), b = { ...binding }, signal = new AbortController().signal;
  await recordBbWorkspace(f.bb, b, signal, binding.environmentPath);
  assert.equal(b.baseSha, head); assert.equal(b.branch, 'actual-branch');
  assert.deepEqual(f.calls()[0].input, { environmentId: 'env' }); assert.equal(f.calls()[0].signal, signal);
});

for (const outcome of ['not_applicable', 'unavailable']) test(`Git ${outcome} cannot produce a workspace snapshot`, async t => {
  const f = fixture(t, { workspaceStatus: () => ({ outcome }) });
  await assert.rejects(captureBbWorkspace(f.bb, binding), /snapshot is unavailable/);
});

test('Git status validates unknown output before it can record a binding', async t => {
  const f = fixture(t, { workspaceStatus: (_, responses) => {
    const status = structuredClone(responses.workspaceStatus); status.workspace.checkout.headSha = 42; return status;
  } });
  const b = { ...binding };
  await assert.rejects(recordBbWorkspace(f.bb, b), error => error.name === 'ZodError'); assert.deepEqual(b, binding);
});

test('Git files validate unknown output before creating revision keys', async t => {
  const f = fixture(t); f.files.files[0].revision = 42;
  await assert.rejects(captureBbWorkspace(f.bb, binding), error => error.name === 'ZodError');
  assert.equal(f.calls().some(call => call.method === 'patches'), false);
});

for (const scenario of ['truncated', 'binary', 'too large', 'wrong base', 'duplicate', 'missing', 'extra']) {
  test(`Git file inventory refuses ${scenario} before requesting patches`, async t => {
    const f = fixture(t);
    if (scenario === 'truncated') f.files.truncated = true;
    if (scenario === 'binary') f.files.files[0].binary = true;
    if (scenario === 'too large') f.files.files[0].loadMode = 'too_large';
    if (scenario === 'wrong base') f.files.mergeBaseRef = head;
    if (scenario === 'duplicate') f.files.files.push({ ...f.files.files[0] });
    if (scenario === 'missing') f.files.files = [];
    if (scenario === 'extra') f.files.files.push({ ...f.files.files[0], path: 'extra.txt' });
    await assert.rejects(captureBbWorkspace(f.bb, binding), /Incomplete patch/);
    assert.equal(f.calls().some(call => call.method === 'patches'), false);
  });
}

for (const scenario of ['missing key', 'extra key', 'unavailable', 'wrong path', 'truncated', 'empty', 'binary', 'submodule', 'malformed']) {
  test(`Git keyed patches refuse ${scenario}`, async t => {
    const f = fixture(t), row = f.patches[key];
    if (scenario === 'missing key') delete f.patches[key];
    if (scenario === 'extra key') f.patches.foreign = row;
    if (scenario === 'unavailable') f.patches[key] = { outcome: 'unavailable' };
    if (scenario === 'wrong path') row.patch.path = 'foreign.txt';
    if (scenario === 'truncated') row.patch.truncated = true;
    if (scenario === 'empty') row.patch.patch = ' ';
    if (scenario === 'binary') row.patch.patch = 'Binary files /dev/null and b/result.txt differ\n';
    if (scenario === 'submodule') row.patch.patch = '+Subproject commit 123456\n';
    if (scenario === 'malformed') row.patch.truncated = 0;
    await assert.rejects(captureBbWorkspace(f.bb, binding), error => scenario === 'malformed'
      ? error.name === 'ZodError' : /Incomplete patch/.test(error.message));
  });
}

test('empty inventory reads files twice and never invokes the nonempty keyed patch operation', async t => {
  const f = fixture(t); f.files.files = []; f.status.workspace.workingTree.files = [];
  assert.deepEqual((await captureBbWorkspace(f.bb, binding)).patches, []);
  assert.deepEqual(f.calls().map(call => call.method), ['workspaceStatus', 'files', 'workspaceStatus', 'files']);
});

test('canonical store exclusion applies to status and file inventory while retaining every other file', async t => {
  const f = fixture(t);
  f.status.workspace.workingTree.files.push({ path: '.promptobus/task.json', status: '??' });
  f.files.files.push({ path: '.promptobus/task.json', revision: 'store-revision', binary: false, loadMode: 'auto' });
  assert.deepEqual((await captureBbWorkspace(f.bb, binding, undefined, true)).patches, [patch]);
});

for (const field of ['head', 'patch']) test(`changed ${field} between capture reads refuses preservation`, async t => {
  let reads = 0;
  const f = fixture(t, { workspaceStatus: (_, responses) => {
    if (++reads === 2) {
      if (field === 'head') responses.workspaceStatus.workspace.checkout.headSha = 'c'.repeat(40);
      else responses.patches[key].patch.patch += '+changed\n';
    }
    return structuredClone(responses.workspaceStatus);
  } });
  await assert.rejects(captureBbWorkspace(f.bb, binding), /changed during preservation/);
});

for (const method of ['before', 'workspaceStatus', 'files', 'patches']) test(`Git capture cancellation at ${method} stops further reads`, async t => {
  const controller = new AbortController(), reason = new Error('capture cancelled');
  const f = fixture(t, method === 'before' ? {} : { [method]: (args, responses) => {
    assert.equal(args.signal, controller.signal); controller.abort(reason); return responses[method];
  } });
  if (method === 'before') controller.abort(reason);
  await assert.rejects(captureBbWorkspace(f.bb, binding, controller.signal), error => error === reason);
  assert.deepEqual(f.calls().map(call => call.method), method === 'before' ? [] :
    ['workspaceStatus', 'files', 'patches'].slice(0, ['workspaceStatus', 'files', 'patches'].indexOf(method) + 1));
});

test('Git RPC transport errors retain their identity without retry or native fallback', async t => {
  const reason = new Error('Git plugin unavailable');
  const f = fixture(t, { workspaceStatus: () => { throw reason; } });
  await assert.rejects(captureBbWorkspace(f.bb, binding), error => error === reason);
  assert.equal(f.calls().length, 1);
});

test('Git capture batches keyed patches at the public fifty-key limit without dropping paths', async t => {
  const f = fixture(t, { patches: ({ input }) => Object.fromEntries(input.keys.map(k => {
    const [environmentId, target, ignoreWhitespace, file, revision] = JSON.parse(k);
    assert.equal(environmentId, 'env'); assert.deepEqual(target, { type: 'all', mergeBaseBranch: base });
    assert.equal(ignoreWhitespace, false); assert.equal(revision, 'revision-1');
    return [k, { outcome: 'available', patch: { ...patch, path: file } }];
  })) });
  f.files.files = Array.from({ length: 51 }, (_, n) => ({ ...f.files.files[0], path: `file-${n}.txt` }));
  f.status.workspace.workingTree.files = f.files.files.map(file => ({ path: file.path, status: '??' }));
  assert.equal((await captureBbWorkspace(f.bb, binding)).patches.length, 51);
  assert.deepEqual(f.calls().filter(call => call.method === 'patches').map(call => call.input.keys.length), [50, 1, 50, 1]);
});

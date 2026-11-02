import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { createStandaloneHost } from 'promptobus/host';
import { createBbManagedAdmission } from 'promptobus/bb-host';
import { newTaskIdentity } from 'promptobus';
import { lookupBbRoot } from '../.test-build/root-lookup.js';
import { bindingStore } from '../.test-build/bindings.js';
import { bindingSchema } from '../.test-build/protocol.js';
import { createHostEntry } from '../.test-build/host-integration.js';
import { registerRuntime } from '../.test-build/runtime.js';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pb-bb-root-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const threads = new Map(), history = new Map();
  const environment = { id: 'environment', path: root, hostId: 'local' };
  const environments = new Map([[environment.id, environment]]);
  const listCalls = [], identityCalls = [];
  let ownerResolver = executionPath => createStandaloneHost({ cwd: executionPath });
  let beforeList = () => {};
  let beforeGet = () => {};
  const host = createFakePluginHost({ pluginId: 'promptobus', sdk: {
    system: { config: async () => ({ primaryHostId: 'local' }) },
    threads: {
      list: async args => {
        assert.equal(args.hostId, 'local'); assert.equal(args.includeHidden, true);
        listCalls.push(args); await beforeList(args);
        return [...threads.values()].filter(thread => (thread.archivedAt !== null) === args.archived)
          .slice(args.offset, args.offset + args.limit);
      },
      get: async ({ threadId }) => { await beforeGet(threadId); return threads.get(threadId); },
      events: { list: async args => {
        identityCalls.push(args);
        assert.deepEqual(args.types, ['thread/identity']);
        const sorted = [...history.get(args.threadId) ?? []].sort((a, b) => args.order === 'asc' ? a.seq - b.seq : b.seq - a.seq);
        return sorted.slice(0, Number(args.limit));
      } },
    },
    environments: { get: async ({ environmentId }) => environments.get(environmentId) },
  }, experimental_callHostRpc: async ({ method, input, hostId, signal }) => {
    assert.equal(method, 'rootScope'); assert.equal(hostId, 'local');
    return createHostEntry({}, ownerResolver).handlers.rootScope(input, { signal: signal ?? new AbortController().signal });
  } });
  t.after(() => host.harness.lifecycle.dispose());
  const store = bindingStore(host.bb);
  const add = (id = 'thr_root', nativeId = 'native-root', overrides = {}) => {
    const thread = makeThreadResponse({ id, providerId: 'codex', environmentId: environment.id, ...overrides });
    threads.set(id, thread);
    history.set(id, [{ id: `identity-${id}`, threadId: id, type: 'thread/identity', seq: 1,
      createdAt: 1, scope: { kind: 'thread' }, data: { providerThreadId: nativeId } }]);
    return thread;
  };
  const managed = (threadId, phase = 'ready') => {
    const binding = bindingSchema.parse({ task: newTaskIdentity('root-lookup').id, participant: 'orchestrator', role: 'orchestrator',
      projectId: 'project', environmentId: environment.id, environmentPath: root, hostId: 'local', providerId: 'codex', root,
      token: randomUUID(), threadId, phase });
    store.reserve(binding, true);
    return binding;
  };
  const lookup = (nativeThreadId = 'native-root') => lookupBbRoot(host.bb, store, { root, home: path.join(root, '.promptobus'),
    hostId: 'local', nativeThreadId, resolveOwnerScope: async executionPath => {
      const owner = await ownerResolver(executionPath);
      return { root: owner.workspaceRoot(), home: owner.promptobusHome() };
    } });
  return { root, host, threads, history, environment, environments, listCalls, identityCalls, store, add, managed, lookup,
    beforeList(callback) { beforeList = callback; }, beforeGet(callback) { beforeGet = callback; },
    resolveOwner(callback) { ownerResolver = callback; } };
}

test('ordinary root uses latest typed identity and completes hidden and archived inventories', async t => {
  const s = fixture(t); s.add();
  assert.deepEqual(await s.lookup(), { complete: true, eligibility: 'eligible', bbThreadId: 'thr_root' });
  assert.deepEqual(s.listCalls.map(call => call.archived), [false, true, false, true]);
  assert.ok(s.identityCalls.every(call => call.order === 'desc' && call.limit === '1'));
});

test('public root lookup returns the exact canonical owner workspace and store', async t => {
  const s = fixture(t); s.add(); registerRuntime(s.host.bb);
  const result = await s.host.harness.behavior.runCli(['root', 'lookup', '--root', s.root, '--native-thread', 'native-root']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { complete: true, eligibility: 'eligible', bbThreadId: 'thr_root',
    root: s.root, home: path.join(s.root, '.promptobus') });
});

test('latest identity replaces older matching identity rather than adopting its first event', async t => {
  const s = fixture(t); s.add();
  const original = s.history.get('thr_root')[0];
  s.history.get('thr_root').push({ ...original, id: 'new-generation', seq: 2, data: { providerThreadId: 'different-native-root' } });
  await assert.rejects(s.lookup(), /one complete unique latest/);
});

test('an archived second mapping remains ambiguous', async t => {
  const s = fixture(t); s.add(); s.add('thr_old', 'native-root', { archivedAt: 7 });
  await assert.rejects(s.lookup(), /one complete unique latest/);
});

test('missing latest identity or an unavailable later page never falls back to a partial match', async t => {
  const s = fixture(t); s.add();
  s.history.delete('thr_root');
  await assert.rejects(s.lookup(), /latest native identity is incomplete/);
  s.add(); s.beforeList(args => { if (args.archived) throw new Error('Archived inventory unavailable'); });
  await assert.rejects(s.lookup(), /Archived inventory unavailable/);
});

for (const archivedAt of [null, 7]) test(`a second Codex thread with missing identity prevents complete lookup (archived ${archivedAt !== null})`, async t => {
  const s = fixture(t); s.add(); s.add('thr_unknown', 'unobserved-native', { archivedAt });
  s.history.delete('thr_unknown');
  await assert.rejects(s.lookup(), /latest native identity is incomplete/);
});

for (const archivedAt of [null, 7]) test(`missing identity in a foreign owner still blocks host-wide lookup (archived ${archivedAt !== null})`, async t => {
  const s = fixture(t); s.add();
  const foreign = path.join(s.root, 'foreign-owner'); mkdirSync(foreign);
  s.environments.set('foreign-environment', { id: 'foreign-environment', path: foreign, hostId: 'local' });
  s.add('thr_foreign', 'unobserved-native', { environmentId: 'foreign-environment', archivedAt });
  s.history.delete('thr_foreign');
  let resolved = 0;
  s.resolveOwner(executionPath => { resolved++; return createStandaloneHost({ cwd: executionPath }); });
  await assert.rejects(s.lookup(), /latest native identity is incomplete/);
  assert.equal(resolved, 0, 'Owner resolution cannot establish uniqueness before the complete native inventory');
});

test('a duplicate native identity in a foreign owner is not excluded by execution path', async t => {
  const s = fixture(t); s.add();
  const foreign = path.join(s.root, 'foreign-owner'); mkdirSync(foreign);
  s.environments.set('foreign-environment', { id: 'foreign-environment', path: foreign, hostId: 'local' });
  s.add('thr_foreign', 'native-root', { environmentId: 'foreign-environment', archivedAt: 7 });
  await assert.rejects(s.lookup(), /one complete unique latest/);
});

for (const phase of ['pending', 'provisioning', 'ready', 'orphan', 'archiving', 'archived']) {
  test(`legacy managed binding in ${phase} cannot become an ordinary root`, async t => {
    const s = fixture(t); s.add(); s.managed('thr_root', phase);
    await assert.rejects(s.lookup(), /Managed BB thread is excluded/);
  });
}

test('unresolved legacy intent blocks admission even when the new owner table is empty', async t => {
  const s = fixture(t); s.add();
  const binding = s.managed(null, 'orphan');
  s.store.launch(binding, { attemptId: randomUUID(), assignment: 'Unresolved owned launch', model: 'subscription-model', status: 'unknown' });
  await assert.rejects(s.lookup(), /Unresolved legacy managed launch/);
  assert.equal(s.listCalls.length, 0);
});

test('turn-scoped identity, labels and parent identifiers are not ordinary root authority', async t => {
  const s = fixture(t); s.add('thr_root', 'native-root', { originKind: 'user', parentThreadId: null });
  s.history.get('thr_root')[0].scope = { kind: 'turn', turnId: 'native-child' };
  await assert.rejects(s.lookup(), /latest native identity is incomplete/);
});

test('changed public inventory and foreign canonical workspace refuse admission', async t => {
  const s = fixture(t); s.add();
  let calls = 0;
  s.beforeList(() => { if (++calls === 3) s.add('thr_new', 'another-native'); });
  await assert.rejects(s.lookup(), /inventory changed/);
  s.beforeList(() => {}); s.environment.path = path.join(s.root, 'foreign');
  await assert.rejects(s.lookup(), /another canonical workspace/);
});

test('native generation changed after inventory completion is refused', async t => {
  const s = fixture(t); s.add();
  s.beforeGet(() => s.history.get('thr_root').push({ ...s.history.get('thr_root')[0],
    id: 'changed-before-result', seq: 2, data: { providerThreadId: 'new-native-root' } }));
  await assert.rejects(s.lookup(), /generation changed/);
});

test('every public list page participates in native identity uniqueness', async t => {
  const s = fixture(t);
  for (let index = 0; index < 201; index++) s.add(`thr_${index}`, index === 200 ? 'native-root' : `native-${index}`);
  assert.equal((await s.lookup()).bbThreadId, 'thr_200');
  assert.deepEqual(s.listCalls.filter(call => call.archived === false).map(call => call.offset), [0, 200, 0, 200]);
});

test('custom participant Host never silently becomes the canonical owner resolver', async t => {
  const s = fixture(t), context = { signal: new AbortController().signal };
  const custom = createHostEntry({});
  await assert.rejects(custom.handlers.rootScope({ root: s.root }, context), /canonical owner Host resolver is required/);
  const selected = createHostEntry({}, root => createStandaloneHost({ cwd: root }));
  assert.deepEqual(await selected.handlers.rootScope({ root: s.root }, context), { root: s.root, home: path.join(s.root, '.promptobus') });
});

test('managed bridge uses its explicit canonical owner store and retains one permanent thread classification', async t => {
  const s = fixture(t), services = path.join(s.root, 'services');
  mkdirSync(services, { mode: 0o700 });
  const admission = createBbManagedAdmission(root => createStandaloneHost({ cwd: root }), { ...process.env, PROMPTOBUS_SERVICE_HOME: services });
  const intent = randomUUID();
  const ownerScope = await admission.begin(s.root, intent);
  await admission.complete(s.root, intent, 'thr_managed', ownerScope);
  await admission.complete(s.root, intent, 'thr_managed', ownerScope);
  await assert.rejects(admission.complete(s.root, intent, 'thr_other', ownerScope), /another BB thread/);
  const foreign = path.join(s.root, 'foreign'); mkdirSync(foreign);
  const mismatch = createBbManagedAdmission(() => createStandaloneHost({ cwd: foreign }));
  await assert.rejects(mismatch.scope(s.root), /another canonical workspace/);
});

test('two checkout execution paths share their explicitly resolved owner store', async t => {
  const s = fixture(t), first = path.join(s.root, 'first-checkout'), second = path.join(s.root, 'second-checkout');
  const services = path.join(s.root, 'services');
  for (const directory of [first, second, services]) mkdirSync(directory, { mode: 0o700 });
  const resolved = [], owner = createStandaloneHost({ cwd: s.root });
  const admission = createBbManagedAdmission(executionPath => { resolved.push(executionPath); return owner; },
    { ...process.env, PROMPTOBUS_SERVICE_HOME: services });
  const expected = { root: s.root, home: path.join(s.root, '.promptobus') };
  assert.deepEqual(await admission.scope(first), expected);
  assert.deepEqual(await admission.scope(second), expected);
  const intent = randomUUID(), selected = await admission.begin(first, intent);
  await assert.rejects(admission.begin(second, intent), /already exists/);
  await admission.complete(first, intent, 'thr_owned', selected);
  assert.deepEqual(resolved, [first, second, first, second, first]);
});

test('a reloaded owner resolver cannot complete an intent under another store', async t => {
  const s = fixture(t), services = path.join(s.root, 'services');
  mkdirSync(services, { mode: 0o700 });
  const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: services }, intent = randomUUID();
  const first = createBbManagedAdmission(root => createStandaloneHost({ cwd: root }), env);
  const expected = await first.begin(s.root, intent);
  const before = readdirSync(services);
  const changed = createBbManagedAdmission(root => createStandaloneHost({ cwd: root, home: path.join(root, 'foreign-store') }), env);
  await assert.rejects(changed.complete(s.root, intent, 'thr_unclassified', expected), /owner workspace or store changed/);
  const otherWorkspace = createBbManagedAdmission(() => createStandaloneHost({ cwd: path.dirname(s.root) }), env);
  await assert.rejects(otherWorkspace.complete(s.root, intent, 'thr_unclassified', expected), /owner workspace or store changed/);
  await assert.rejects(changed.complete(s.root, intent, 'thr_unclassified'), /persisted owner scope/);
  assert.deepEqual(readdirSync(services), before, 'Refused completion must not create another owner scope or lock');
  await first.complete(s.root, intent, 'thr_owned', expected);
});

test('lookup resolves a checkout environment to its owner without changing its execution path', async t => {
  const s = fixture(t), checkout = path.join(s.root, 'checkout'); mkdirSync(checkout);
  s.add(); s.environment.path = checkout;
  const seen = [];
  s.resolveOwner(executionPath => { seen.push(executionPath); return createStandaloneHost({ cwd: s.root }); });
  assert.equal((await s.lookup()).bbThreadId, 'thr_root');
  assert.deepEqual(seen, [checkout]);
  assert.equal(s.environment.path, checkout);
});

test('lookup refuses a different store even under the same canonical owner workspace', async t => {
  const s = fixture(t); s.add();
  s.resolveOwner(root => createStandaloneHost({ cwd: root, home: path.join(root, 'foreign-store') }));
  await assert.rejects(s.lookup(), /another canonical workspace or store/);
});

test('lookup refuses an environment with no absolute execution path', async t => {
  const s = fixture(t); s.add(); s.environment.path = null;
  await assert.rejects(s.lookup(), /no absolute execution path/);
});

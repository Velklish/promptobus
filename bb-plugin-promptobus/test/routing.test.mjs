import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectBbExecution } from '../.test-build/routing.js';

const binding = { role: 'worker', hostId: 'host', environmentId: 'env', environmentOwner: 'existing' };
function fixture() {
  const calls = [];
  const provider = { id: 'codex', family: 'codex', available: true,
    capabilities: { modelCatalogScope: 'host', permissionModes: ['accept-edits', 'full'] },
    maintenance: { health: true, usage: true } };
  const model = { id: 'model', model: 'model', defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] };
  const catalog = { models: [model], selectedOnlyModels: [], modelLoadError: null };
  const host = { id: 'host', status: 'connected', lifecycle: { phase: 'active' } };
  const environment = { id: 'env', hostId: 'host', status: 'ready', lifecycle: { phase: 'active' } };
  const health = { providers: [{ providerId: 'codex', status: 'ready', accountEmail: 'private@example.test' }] };
  const usage = { codex: { status: 'ok', accountEmail: 'private@example.test', planLabel: 'private',
    windows: [{ label: '5h', usedPercent: 37, resetsAt: '2099-01-01T00:00:00Z', cost: { usedUsdCents: 123, limitUsdCents: 456 } }] } };
  const record = (method, value) => async args => { calls.push({ method, args }); return value; };
  const bb = { sdk: { hosts: { get: record('host', host) }, environments: { get: record('environment', environment) },
    providers: { list: record('providers', [provider]), models: record('models', catalog) },
    system: { providerStates: record('health', health), usageLimits: record('usage', usage) } } };
  return { bb, calls, provider, model, catalog, host, environment, health, usage,
    select: (request = { model: 'model' }, b = binding, signal) => selectBbExecution(bb, b, request, signal) };
}

test('BB routing uses environment catalog/health and host/provider account windows, excluding account identity and cost', async () => {
  const s = fixture(); const selection = await s.select({ model: 'model', provider: 'codex', reasoningLevel: 'high' });
  assert.equal(selection.reasoningLevel, 'high'); assert.equal(selection.health, 'ready');
  assert.deepEqual(selection.quota, { status: 'known', reason: null,
    windows: [{ label: '5h', usedPercent: 37, resetsAt: '2099-01-01T00:00:00Z' }] });
  for (const method of ['providers', 'models', 'health']) {
    const { args } = s.calls.find(call => call.method === method);
    assert.equal(args.environmentId, 'env'); assert.equal(args.hostId, undefined);
  }
  assert.deepEqual(s.calls.find(call => call.method === 'usage').args, { hostId: 'host', providerId: 'codex', signal: undefined });
  assert.equal(JSON.stringify(selection).includes('private'), false);
  assert.equal(JSON.stringify(selection).includes('UsdCents'), false);
});

test('new worktrees use their host catalog and never borrow coordinator-scoped availability', async () => {
  const s = fixture(); const selected = await s.select({ model: 'model' }, { ...binding, environmentOwner: 'bb' });
  assert.equal(selected.reasoningLevel, 'medium'); assert.equal(selected.reasoningSource, 'catalog');
  assert.deepEqual(selected.scope, { hostId: 'host', environmentId: null });
  for (const method of ['providers', 'models', 'health']) {
    const { args } = s.calls.find(call => call.method === method);
    assert.equal(args.hostId, 'host'); assert.equal(args.environmentId, undefined);
  }
  s.provider.capabilities.modelCatalogScope = 'workspace';
  await assert.rejects(s.select({ model: 'model' }, { ...binding, environmentOwner: 'bb' }), /host-scoped/);
});

test('the selected SDK model id and native model name remain distinct', async () => {
  const s = fixture(); s.model.id = 'sdk-model-id';
  const selected = await s.select();
  assert.equal(selected.requestedModel, 'model'); assert.equal(selected.model, 'sdk-model-id');
  assert.equal(selected.nativeModel, 'model');
});

test('provider mismatch and cross-provider model routing refuse without fallback', async () => {
  const s = fixture();
  await assert.rejects(s.select({ model: 'model', provider: 'claude' }), /requires provider codex/);
  await assert.rejects(s.select({ model: 'model', provider: 'codex' }, { ...binding, role: 'reviewer' }), /requires provider promptobus-codex-reviewer/);
  assert.equal(s.calls.length, 0);
  s.model.routeProviderId = 'claude';
  await assert.rejects(s.select(), /unavailable on provider codex/);
});

test('Cursor and OpenCode workers and Cursor approvers keep their provider through scoped selection', async () => {
  for (const [providerId, harness, role] of [
    ['acp-cursor', 'cursor', 'worker'], ['acp-opencode', 'opencode', 'worker'], ['acp-cursor', 'cursor', 'approver'],
  ]) {
    const s = fixture();
    s.provider.id = providerId; s.provider.family = 'acp';
    s.health.providers[0].providerId = providerId;
    s.usage[providerId] = { ...s.usage.codex, windows: [{ label: 'Provider window', usedPercent: 12, resetsAt: null }] };
    const selected = await s.select({ model: 'model', provider: providerId, reasoningLevel: 'high' }, { ...binding, role });
    assert.equal(selected.providerId, providerId); assert.equal(selected.harness, harness);
    assert.equal(selected.health, 'ready'); assert.equal(selected.reasoningLevel, 'high');
    assert.equal(selected.quota.windows[0].usedPercent, 12);
    assert.equal(s.calls.find(c => c.method === 'models').args.providerId, providerId);
    assert.equal(s.calls.find(c => c.method === 'usage').args.providerId, providerId);
  }
});

test('ACP providers cannot replace the constrained reviewer or Codex governance roles', async () => {
  for (const role of ['reviewer', 'orchestrator', 'teamlead', 'reporter']) {
    for (const provider of ['acp-cursor', 'acp-opencode']) {
      const s = fixture();
      await assert.rejects(s.select({ model: 'model', provider }, { ...binding, role }), /requires provider/);
      assert.equal(s.calls.length, 0);
    }
  }
  await assert.rejects(fixture().select({ model: 'model', provider: 'acp-opencode' }, { ...binding, role: 'approver' }), /requires provider/);
});

test('an executable provider without accept-edits permission support is refused before model selection', async () => {
  const s = fixture(); s.provider.capabilities.permissionModes = ['full'];
  await assert.rejects(s.select(), /does not support accept-edits/);
  assert.equal(s.calls.some(c => c.method === 'models'), false);
});

test('offline host/environment and unavailable or unknown model inventory refuse explicitly', async () => {
  for (const [change, error] of [
    [s => { s.host.status = 'disconnected'; }, /host is unavailable/],
    [s => { s.environment.status = 'offline'; }, /environment is unavailable/],
    [s => { s.provider.available = false; }, /provider codex is unavailable/],
    [s => { s.catalog.modelLoadError = { code: 'timeout' }; }, /availability is unknown: timeout/],
    [s => { s.catalog.models = []; s.catalog.selectedOnlyModels = [s.model]; }, /Model model is unavailable/],
    [s => { s.health.providers[0].status = 'unauthenticated'; }, /is unauthenticated/],
  ]) {
    const s = fixture(); change(s); await assert.rejects(s.select(), error);
  }
  await assert.rejects(fixture().select({ model: 'missing' }), /Model missing is unavailable/);
  await assert.rejects(fixture().select({ model: 'model', reasoningLevel: 'ultra' }), /does not support reasoning level ultra/);
});

test('unknown health stays unknown while missing, empty and failed usage cannot become fabricated windows', async () => {
  for (const mutate of [
    s => { delete s.usage.codex; },
    s => { s.usage.codex.status = 'error'; },
    s => { s.usage.codex.windows = []; },
    s => { s.bb.sdk.system.usageLimits = async () => { throw new Error('unavailable'); }; },
  ]) {
    const s = fixture(); mutate(s); s.health.providers[0].status = 'unknown';
    const selected = await s.select();
    assert.equal(selected.health, 'unknown'); assert.equal(selected.quota.status, 'unknown');
    assert.deepEqual(selected.quota.windows, []); assert.equal(typeof selected.quota.reason, 'string');
  }
});

test('reviewer quota is unknown for its own provider, even when regular Codex has account windows', async () => {
  const s = fixture(); s.provider.id = 'promptobus-codex-reviewer';
  s.provider.maintenance = { health: false, usage: false };
  const selected = await s.select({ model: 'model' }, { ...binding, role: 'reviewer' });
  assert.equal(selected.providerId, 'promptobus-codex-reviewer'); assert.equal(selected.harness, 'codex');
  assert.equal(selected.quota.status, 'unknown'); assert.equal(selected.health, 'unknown');
  assert.deepEqual(selected.quota.windows, []); assert.equal(s.calls.some(c => c.method === 'usage'), false);
});

test('usage probe failure may be unknown but cancellation cannot produce a launch selection', async () => {
  const s = fixture(); const abort = new AbortController();
  s.bb.sdk.system.usageLimits = async () => { abort.abort(); throw new Error('cancelled'); };
  await assert.rejects(s.select({ model: 'model' }, binding, abort.signal), { name: 'AbortError' });
});

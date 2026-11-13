import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { openHttpBus } from './harness-cursor.mjs';

const drift = stage => `Managed lifetime changed after observation; retry with current owner proof [stage: returned fence: ${stage}]`;

async function connect({ method, status = 409, error, persistent = false, change = null }) {
  const cfg = { url: 'http://cursor-fixture.invalid/mcp/bus', headers: { Authorization: 'Bearer ${env:CONTROLLED_BEARER}' } };
  const env = { CONTROLLED_BEARER: 'same-owned-token' }, calls = [], responses = [], sessions = new Set();
  const originalFetch = globalThis.fetch;
  let failures = 0, client = null, failure = null, initializations = 0;
  globalThis.fetch = async (url, options) => {
    if (options.method === 'DELETE') {
      const id = options.headers['mcp-session-id'];
      assert.equal(sessions.delete(id), true);
      calls.push({ url, method: 'DELETE', session: id });
      return new Response(null, { status: 204 });
    }
    const request = JSON.parse(options.body);
    const refused = request.method === method && (persistent || failures === 0);
    const code = refused ? status : request.id === undefined ? 202 : 200;
    calls.push({ url, headers: { ...options.headers }, body: options.body, method: request.method, status: code });
    if (refused) {
      failures += 1;
      change?.(cfg, env);
      const response = new Response(error === null ? 'not JSON' : JSON.stringify({ error }), { status: code });
      responses.push(response);
      return response;
    }
    const id = request.method === 'initialize' ? `owned-session-${++initializations}` : options.headers['mcp-session-id'];
    if (request.method === 'initialize') sessions.add(id);
    else assert.equal(sessions.has(id), true);
    return new Response(request.id === undefined ? null : JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }),
      { status: code, headers: { 'mcp-session-id': id } });
  };
  try {
    client = await openHttpBus(cfg, env);
    await client.rpc('tools/call', { name: 'controlled', arguments: {} });
  } catch (caught) { failure = caught; }
  finally {
    try { if (client) await client.close(); }
    finally { globalThis.fetch = originalFetch; }
  }
  return { calls, failure, client, attempts: calls.filter(call => call.method === method), initializations,
    openSessions: sessions.size, responses };
}

for (const method of ['initialize', 'notifications/initialized']) {
  const acceptedStage = method === 'initialize' ? 'authenticate' : 'body';
  test(`${method} retries one unchanged request after ${acceptedStage} revision drift`, async () => {
    const result = await connect({ method, error: drift(acceptedStage) });
    assert.equal(result.failure, null);
    assert.equal(result.attempts.length, 2);
    const [{ status: firstStatus, ...first }, { status: secondStatus, ...second }] = result.attempts;
    assert.equal(firstStatus, 409);
    assert.equal(secondStatus, method === 'initialize' ? 200 : 202);
    assert.deepEqual(second, first);
    assert.equal(result.calls.filter(call => call.method === 'initialize' && call.status === 200).length, 1);
    assert.equal(JSON.parse(result.calls.find(call => call.method === 'tools/call').body).id, 2);
    assert.equal(result.initializations, 1);
    assert.equal(result.openSessions, 0);
    assert.equal(result.calls.filter(call => call.method === 'DELETE').length, 1);
    assert.ok(result.responses.every(response => response.bodyUsed));
    if (method === 'notifications/initialized') assert.equal(first.headers['mcp-session-id'], 'owned-session-1');
  });

  test(`${method} stops after one retry when revision drift persists`, async () => {
    const result = await connect({ method, error: drift(acceptedStage), persistent: true });
    assert.equal(result.attempts.length, 2);
    assert.match(result.failure?.message ?? '', /HTTP MCP .*: 409/);
  });

  for (const [label, status, error] of [
    ['expired grant', 401, drift('authenticate')],
    ['forbidden grant', 403, drift('authenticate')],
    ['unavailable proof', 503, drift('body')],
    ['exhausted proof', 409, 'Managed lifetime changed after observation; retry with current owner proof [stage: exhausted 3]'],
    ['participant identity at authenticate', 409, drift('authenticate: participant identity')],
    ['participant identity at body', 409, drift('body: participant identity')],
    ['different identity', 409, 'Managed participant identity changed during authorization'],
    ['different stage', 409, drift('dispatch')],
    ['unobserved handshake stage', 409, drift(method === 'initialize' ? 'body' : 'authenticate')],
    ['non-string refusal', 409, [drift(acceptedStage)]],
    ['non-JSON refusal', 409, null],
  ]) {
    test(`${method} does not retry ${label}`, async () => {
      const result = await connect({ method, status, error });
      assert.equal(result.attempts.length, 1);
      assert.ok(result.failure);
    });
  }

  for (const [label, change] of [
    ['URL', cfg => { cfg.url = 'http://changed.invalid/mcp/bus'; }],
    ['bearer configuration', cfg => { cfg.headers.Authorization = 'Bearer replacement'; }],
    ['resolved bearer', (_cfg, env) => { env.CONTROLLED_BEARER = 'replacement'; }],
  ]) {
    test(`${method} does not retry after its ${label} changes`, async () => {
      const result = await connect({ method, error: drift(acceptedStage), change });
      assert.equal(result.attempts.length, 1);
      assert.ok(result.failure);
    });
  }
}

for (const stage of ['authenticate', 'body']) {
  test(`tools/call does not retry ${stage} revision drift`, async () => {
    const result = await connect({ method: 'tools/call', error: drift(stage) });
    assert.equal(result.attempts.length, 1);
    assert.match(result.failure?.message ?? '', /HTTP MCP tools\/call: 409/);
  });
}

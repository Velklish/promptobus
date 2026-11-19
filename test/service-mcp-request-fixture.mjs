import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { createStandaloneHost } from '../dist/host-index.js';
import { REGISTRY } from '../lib/drivers.js';
import { serviceHarnessContext } from '../lib/harness-home.js';
import { ManagedNativeRevisionDrift, requireManagedNativeBinding } from '../lib/native-admission.js';
import { createMcpRequests } from '../lib/service-mcp-request.js';
import { prepareServicePaths, readPrivate, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { createTask, participantRecord, upsertParticipant } from '../lib/store.js';

const root = realpathSync(makeSandbox('promptobus-test-service-mcp-request-'));
writeHostConfig(root, { tools: [] });
const host = createStandaloneHost({ cwd: root }), runtime = runtimeIdentity(host);
const env = { PROMPTOBUS_SERVICE_HOME: path.join(root, 'private') };
const paths = servicePaths(host, env), expectedHarness = serviceHarnessContext(host, {}, REGISTRY);
prepareServicePaths(paths);
const files = path.join(root, 'files'), sample = path.join(files, 'sample');
mkdirSync(files);
const version = '2025-06-18';
const init = { id: 1, method: 'initialize', params: { protocolVersion: version } };
const initialized = { method: 'notifications/initialized' };
const tool = { id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: sample } } };
const expired = { status: 401, body: { error: 'Client binding is absent or expired' } };
const missing = { status: 404, body: { error: 'MCP session not found' } };
const fixture = (options = {}, connectBus) => {
  const hooks = {}, grant = { schemaVersion: 1, id: randomUUID(), token: randomUUID(), runtime, cwd: root, env: {}, pollEnv: {},
    lifetime: { kind: 'reservation', expiresAt: Date.now() + 60000 }, files: { roots: [files], canonicalFiles: [] }, ...options };
  const file = path.join(paths.clients, `${grant.id}.json`);
  writePrivate(file, grant);
  const mcp = createMcpRequests({ host, runtime, paths, env, expectedHarness, createHost: async () => await hooks.host?.() ?? host,
    requireProcessLifetime: async () => {}, proveNativeBinding: current => hooks.native ? hooks.native(current) : requireManagedNativeBinding(paths, current, { host, env: current.pollEnv }),
    warden: { observe: async () => hooks.observe?.() ?? { reporter: { state: 'alive' } } },
    isClosing: () => { hooks.final?.(); return false; }, finalizeStandaloneStartup: () => assert.fail('unexpected startup') }, connectBus);
  const request = (endpoint, message, session, { method = 'POST', headers, readBody } = {}) => mcp.handle({ endpoint, method,
    headers: { authorization: `Bearer ${grant.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(session ? { 'mcp-session-id': session } : {}), ...headers }, readBody: readBody ?? (() => ({ jsonrpc: '2.0', ...message })) });
  return { hooks, grant, file, request };
};

// An early refusal also settles the race, so a broken checkpoint cannot leave the test waiting for entry.
async function during(start, change) {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const result = start(async () => { entered.resolve(); await released.promise; });
  let timer;
  try { await Promise.race([entered.promise, result.then(reply => assert.fail(`did not enter wait: ${JSON.stringify(reply)}`)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('request barrier timed out')), 5000); })]); change(); }
  finally { clearTimeout(timer); released.resolve(); }
  return result;
}

for (const endpoint of ['bus', 'reviewer_files']) {
  const { grant, file, request } = fixture();
  let reads = 0;
  const unread = { readBody: () => { reads++; return init; } };
  assert.deepEqual(await request(endpoint, init, null, { ...unread, headers: { authorization: 'Bearer unknown' } }), expired);
  writePrivate(file, { ...grant, lifetime: { kind: 'reservation', expiresAt: 1 } });
  const denied = await request(endpoint, init, null, unread);
  check(`${endpoint}: invalid bearer and expired lifetime refuse before body`, reads === 0
    && isDeepStrictEqual(denied, { status: 401, body: { error: 'Client lifetime is already expired or replaced' } }), JSON.stringify({ denied, reads }));
  reads = 0;
  writePrivate(file, { ...grant, nativeBinding: { kind: 'codex', state: 'pending' }, lifetime: { kind: 'reservation', expiresAt: 1 } });
  const pending = await request(endpoint, init, null, unread);
  const malformed = await request(endpoint, init, null, { ...unread, headers: { 'mcp-protocol-version': 'invalid' } });
  check(`${endpoint}: expired pending reservation precedes headers and lazy reader`, reads === 0 &&
    [pending, malformed].every(reply => isDeepStrictEqual(reply, { status: 401, body: { error: 'Client lifetime is already expired or replaced' } })));
  writePrivate(file, grant);
  const opened = await request(endpoint, init), session = opened.headers?.['mcp-session-id'];
  assert.equal(opened.status, 200, JSON.stringify(opened)); assert.ok(session);
  assert.equal(opened.body.result.protocolVersion, version);
  assert.equal(opened.body.result.serverInfo.name, endpoint === 'bus' ? 'promptobus' : 'promptobus-reviewer-files');
  assert.deepEqual(await request(endpoint, null, randomUUID(), { ...unread, method: 'PUT', headers: { 'mcp-protocol-version': 'invalid' } }),
    { status: 400, body: { error: 'Unsupported MCP protocol version' } });
  assert.deepEqual(await request(endpoint, null, session, { ...unread, method: 'PUT' }), { status: 405, body: { error: 'MCP requires POST' } });
  assert.deepEqual(await request(endpoint, null, session, { ...unread, headers: { accept: '', 'content-type': 'text/plain' } }),
    { status: 415, body: { error: 'MCP requires application/json' } });
  assert.deepEqual(await request(endpoint, null, session, { ...unread, headers: { accept: 'application/json' } }),
    { status: 406, body: { error: 'MCP client must accept JSON and event streams' } });
  assert.deepEqual(await request(endpoint, { method: 'tools/list', id: 3 }, session), { status: 400, body: { error: 'MCP session has not completed initialization' } });
  assert.deepEqual(await request(endpoint, { method: 'ping', id: 3 }, session), { status: 200, headers: {}, body: { jsonrpc: '2.0', id: 3, result: {} } });
  assert.deepEqual(await request(endpoint, initialized, session), { status: 202 });
  const listed = await request(endpoint, { method: 'tools/list', id: 4 }, session);
  assert.equal(listed.status, 200); assert.ok(listed.body.result.tools.length);
  assert.deepEqual(await request(endpoint, null, session, { ...unread, method: 'GET' }), { status: 405, headers: { allow: 'POST, DELETE' }, body: { error: 'SSE is not offered' } });
  assert.deepEqual(await request(endpoint === 'bus' ? 'reviewer_files' : 'bus', null, session, { ...unread, method: 'DELETE' }), missing);
  assert.deepEqual(await request(endpoint, null, session, { ...unread, method: 'DELETE', headers: { 'mcp-protocol-version': '2025-03-26' } }),
    { status: 400, body: { error: 'Unsupported or mismatched MCP protocol version' } });
  writeFileSync(sample, 'original content');
  const first = await request(endpoint, tool, session), directory = path.join(paths.requests, session);
  assert.equal(first.status, 200);
  const [name] = readdirSync(directory), receipt = path.join(directory, name), completed = readPrivate(receipt);
  assert.equal(completed.state, 'completed');
  if (endpoint === 'reviewer_files') {
    writeFileSync(sample, 'updated content');
    assert.match(JSON.stringify((await request(endpoint, tool, session)).body.result), /updated content/);
  } else {
    const saved = { ...completed.response, result: { isError: true, content: [{ type: 'text', text: 'saved outcome' }] } };
    writePrivate(receipt, { ...completed, response: saved });
    check('bus replay selects the synthetic completed receipt body', isDeepStrictEqual((await request(endpoint, tool, session)).body, saved));
    writePrivate(receipt, { digest: completed.digest, state: 'started', readOnly: false });
    assert.deepEqual(await request(endpoint, tool, session), { status: 409, body: { error: 'The earlier request outcome is uncertain; inspect the journal instead of repeating it' } });
  }
  assert.deepEqual(await request(endpoint, { ...tool, params: { name: 'other' } }, session), { status: 409, body: { error: 'This request id was already used for different arguments' } });
  assert.deepEqual(await request(endpoint, null, session, { ...unread, method: 'DELETE' }), { status: 204 });
  assert.deepEqual(await request(endpoint, null, session, unread), missing);
  check(`${endpoint}: session flow, replay and ordinary receipt cleanup`, reads === 0 && !existsSync(directory));
}

for (const [endpoint, expectedTool, foreignTool] of [
  ['bus', 'promptobus_send', 'read_file'],
  ['reviewer_files', 'read_file', 'promptobus_send'],
]) {
  const { request, grant, file } = fixture({ nativeBinding: { kind: 'codex', state: 'pending' } });
  const opened = await request(endpoint, init), session = opened.headers['mcp-session-id'];
  assert.deepEqual(await request(endpoint, initialized, session), { status: 202 });
  assert.equal((await request(endpoint, tool, session)).status, 403);
  const result = await during(wait => request(endpoint, null, session, { readBody: async () => { await wait(); return { jsonrpc: '2.0', method: 'tools/list', id: 3 }; } }),
    () => writePrivate(file, { ...grant, nativeBinding: { kind: 'codex', state: 'bound', threadId: 'realized' } }));
  const names = result.body?.result?.tools?.map(entry => entry.name) ?? [];
  check(`${endpoint}: realization during body read returns its own catalog`, result.status === 200 && result.body.id === 3
    && names.includes(expectedTool) && !names.includes(foreignTool), JSON.stringify({ status: result.status, names }));
}

for (const kind of ['standalone', 'BB']) {
  const nonce = randomUUID(), launch = path.join(paths.directory, `standalone-launch-${nonce}.json`);
  const { grant, request } = fixture({ ...(kind === 'BB' ? { bbRootNonce: nonce } : { rootLaunch: { file: launch, nonce } }),
    lifetime: { kind: 'process', process: { pid: process.pid, birth: 'fixture' } },
    nativeBinding: { kind: 'codex', state: 'bound', threadId: 'owned' } });
  if (kind === 'standalone') writePrivate(launch, { schemaVersion: 1, root, home: paths.home, runtime, nonce, cwd: root, profile: 'fixture',
    process: grant.lifetime.process, expiresAt: Date.now() + 60000, clientId: grant.id, nativeId: 'owned', resumeNativeId: null, phase: 'bound', revoked: false, plan: null });
  const opened = await request('bus', init), session = opened.headers?.['mcp-session-id'];
  assert.ok(session, JSON.stringify(opened)); await request('bus', initialized, session);
  assert.equal((await request('bus', tool, session)).status, 403);
  const result = await request('bus', { ...tool, params: { ...tool.params, _meta: { threadId: 'owned' } } }, session);
  const directory = path.join(paths.requests, `root-${nonce}`, session);
  assert.equal(result.status, 200, JSON.stringify(result));
  const [name] = readdirSync(directory);
  assert.deepEqual(await request('bus', null, session, { method: 'DELETE' }), { status: 204 });
  check(`${kind} nonce-keyed receipt survives session deletion`, readPrivate(path.join(directory, name)).state === 'completed');
}

{
  const { grant, file, request } = fixture();
  const opened = await request('bus', init), session = opened.headers['mcp-session-id'];
  const result = await during(wait => request('bus', initialized, session, { readBody: async () => { await wait(); return { jsonrpc: '2.0', ...initialized }; } }),
    () => writePrivate(file, { ...grant, token: randomUUID() }));
  check('replacement during body read cannot initialize session', result.status === 401 && !readPrivate(path.join(paths.sessions, `${session}.json`)).initialized);
}
{
  const { hooks, file, request } = fixture(), before = readdirSync(paths.sessions);
  const result = await during(wait => { hooks.host = async () => { await wait(); return {}; }; return request('bus', init); }, () => rmSync(file));
  check('revocation during Host creation precedes Host inspection and rolls back provisional session', result.status === 401 && result.body.error === expired.body.error);
  assert.deepEqual(readdirSync(paths.sessions), before);
}

const task = 'managed-request-t20261101-000000', record = path.join(root, 'launch.json');
const lifetime = { kind: 'managed', task, address: 'reporter', launchId: 'owned-launch', record, ref: 'owned' };
const publish = extra => writePrivate(record, { home: paths.home, ...lifetime, ...extra });
const identity = sessionId => upsertParticipant(paths.home, task, participantRecord('reporter', { harness: 'codex', sessionRef: 'owned', sessionRecord: record, sessionId }));
createTask(paths.home, { id: task, title: 'request admission fixture', owner: 'owner' }); identity('original'); publish({});
for (const change of ['revocation', 'launch replacement']) {
  let calls = 0;
  const { grant, file, request } = fixture({ lifetime }, () => ({ handle(message) {
    if (message.method === 'tools/call') calls++;
    return { jsonrpc: '2.0', id: message.id, result: {} };
  } }));
  const opened = await request('bus', init), session = opened.headers?.['mcp-session-id']; assert.ok(session, JSON.stringify(opened));
  assert.deepEqual(await request('bus', initialized, session), { status: 202 });
  const message = { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'fixture_count' } };
  const reply = await during(wait => request('bus', null, session, { readBody: async () => { await wait(); return message; } }),
    () => change === 'revocation' ? rmSync(file) : publish({ launchId: 'other-launch' }));
  const expected = change === 'revocation' ? expired : { status: 401, body: { error: 'Managed lifetime has no matching task, participant and launch record' } };
  check(`managed tool body: ${change} refuses before invocation or started receipt`, isDeepStrictEqual(reply, expected) && calls === 0
    && !existsSync(path.join(paths.requests, session)), JSON.stringify({ reply, calls }));
  writePrivate(file, grant); publish({});
  assert.equal((await request('bus', message, session)).status, 200); assert.equal(calls, 1);
}
for (const scenario of ['first drift', 'persistent drift', 'identity between attempts', 'unavailable']) {
  const { request, hooks } = fixture({ lifetime }); let proofs = 0, observations = 0;
  const response = await during(wait => {
    hooks.native = async () => { proofs++; if (proofs === 1) await wait();
      if (scenario === 'unavailable') throw new Error('native proof unavailable');
      if (proofs === 1 || scenario === 'persistent drift') throw new ManagedNativeRevisionDrift(); };
    hooks.observe = () => { observations++; return { reporter: { state: 'alive' } }; };
    return request('bus', null, null, { method: 'GET' });
  }, () => { if (scenario === 'identity between attempts') identity('replacement'); });
  const expected = { 'first drift': [400, 2, 1], 'persistent drift': [409, 3, 0], 'identity between attempts': [409, 1, 0], unavailable: [500, 1, 0] }[scenario];
  check(`native proof adapter: ${scenario}`, response.status === expected[0] && proofs === expected[1] && observations === expected[2], JSON.stringify(response));
  identity('original');
}
for (const scenario of ['revoked', 'identity', 'dead', 'unknown', 'one revision', 'sustained revision']) {
  const { request, file, hooks } = fixture({ lifetime }); let observations = 0, reads = 0;
  const response = await during(wait => {
    hooks.observe = async () => { observations++; if (observations === 1) await wait();
      if (scenario === 'sustained revision') publish({ observations });
      return { reporter: { state: scenario === 'dead' ? 'gone' : scenario === 'unknown' ? 'unknown' : 'alive' } }; };
    return request('bus', null, null, { method: 'GET', readBody: () => { reads++; } });
  }, () => { if (scenario === 'revoked') rmSync(file); if (scenario === 'identity') identity('replacement'); if (scenario === 'one revision') publish({ revision: 2 }); });
  const expected = { revoked: [401, 1], identity: [409, 1], dead: [401, 1], unknown: [503, 1], 'one revision': [400, 2], 'sustained revision': [409, 3] }[scenario];
  check(`held managed observation: ${scenario}`, response.status === expected[0] && observations === expected[1] && reads === 0,
    JSON.stringify({ response, observations }));
  if (scenario === 'sustained revision') assert.match(response.body.error, /exhausted 3/);
  identity('original');
}
{
  const { request, hooks, file } = fixture({ lifetime });
  const opened = await request('reviewer_files', init), session = opened.headers?.['mcp-session-id']; assert.ok(session, JSON.stringify(opened));
  await request('reviewer_files', initialized, session);
  const lock = path.join(paths.home, 'tasks', task, '.lock'), receipts = path.join(paths.requests, session);
  mkdirSync(lock); writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, nonce: 'held' }));
  try { const busy = await request('reviewer_files', tool, session);
    check('occupied task lock refuses before creating a receipt', busy.status === 503 && /did not enter its journal/.test(busy.body.error) && !existsSync(receipts)); }
  finally { rmSync(lock, { recursive: true }); }
  hooks.final = () => publish({ lastEvent: 'changed without a bound Codex client' });
  const drifted = await request('reviewer_files', tool, session);
  check('returned fence rejects record drift without Codex telemetry authority', drifted.status === 409 && /returned fence: dispatch/.test(drifted.body.error) && !existsSync(receipts));
  hooks.final = () => identity('replacement');
  const swapped = await request('reviewer_files', tool, session);
  check('returned fence rejects a replaced participant without retry', swapped.status === 409 && /dispatch: participant identity/.test(swapped.body.error) && !existsSync(receipts));
  identity('original');
  hooks.final = () => rmSync(file, { force: true });
  const denied = await request('reviewer_files', tool, session);
  check('synchronous journal authority rechecks grant before invoking tool', denied.status === 401 && !existsSync(receipts));
}

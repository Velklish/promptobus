import { check, skip } from './check.mjs';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { registryOf } from '../dist/index.js';
import { mcpTools } from '../dist/mcp/tools.js';
import { runWorkspaceService } from '../lib/service.js';
import { registerServiceClient, revokeServiceClient, serviceControl } from '../lib/service-client.js';
import { readDiscovery, readPrivate, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { bus, createTask, participantRecord, readWake, strictTaskFacts, upsertParticipant } from '../lib/store.js';
import { resolveSessionIdentity } from '../lib/drivers.js';
import { sessionFile as codexSessionFile } from '../lib/codex-session.js';
import { REVIEW_FILE_TOOLS } from '../lib/reviewer-files.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('Codex HTTP native binding', 'This platform has no implemented process-birth observer');
} else {
  const root = realpathSync(makeSandbox('promptobus-shared-service-native-'));
  const privateHome = mkdtempSync(path.join(realpathSync('/tmp'), 'pbsvc-'));
  const home = path.join(root, '.promptobus'), readRoot = path.join(root, 'review');
  const task = 'native-binding-t20261030-000000', nativeId = 'native-thread-one';
  const binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: privateHome, PROMPTOBUS_HOME: home,
    PROMPTOBUS_SERVICE_IDLE_MS: '60000', PROMPTOBUS_WARDEN: 'off' };
  const options = { cwd: root, env }, clients = [], factories = [], gates = new Map();
  writeHostConfig(root, { tools: [] });
  mkdirSync(readRoot);
  writeFileSync(path.join(readRoot, 'proof.txt'), 'owned reviewer text');
  const host = createStandaloneHost({ cwd: root, binPath, version });
  const paths = servicePaths(host, env), runtime = runtimeIdentity(host);
  const makeHost = async context => {
    factories.push({ ...context, frozen: Object.isFrozen(context.env) });
    if (context.env.FACTORY_GATE && context.env.CODEX_THREAD_ID !== 'ancestor-codex') await gates.get(context.env.FACTORY_GATE).promise;
    return createStandaloneHost({ cwd: context.cwd, binPath, version });
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() >= deadline) throw new Error('Fixture readiness timed out'); await wait(10); }
  };
  const gate = name => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    const value = { promise, release };
    gates.set(name, value);
    return value;
  };
  const snapshot = directory => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? snapshot(file).map(([name, hash]) => [path.join(entry.name, name), hash])
        : [[entry.name, createHash('sha256').update(readFileSync(file)).digest('hex')]];
    });
  };
  const state = () => JSON.stringify([snapshot(home), snapshot(paths.requests)]);
  const owner = input => serviceControl(paths, { runtime, ...input });
  const realize = (credential, threadId) => owner({ operation: 'realize', clientId: credential.clientId, threadId })
    .then(value => ({ value }), error => ({ error: error.message }));
  const register = async (extra = {}, filesRoot = readRoot, lifetime = { kind: 'process', process: requireProcess() }) => {
    const credential = await registerServiceClient(host, { cwd: root,
      env: { ...env, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: 'orchestrator',
        CODEX_THREAD_ID: 'ancestor-codex', CLAUDE_CODE_SESSION_ID: 'ancestor-claude', CURSOR_CONVERSATION_ID: 'ancestor-cursor',
        PROMPTOBUS_CLAUDE_SESSION: '/ancestor/claude', PROMPTOBUS_CURSOR_SESSION: '/ancestor/cursor',
        PROMPTOBUS_CODEX_SESSION: '/ancestor/codex', PROMPTOBUS_OPENCODE_SESSION: '/ancestor/opencode', ...extra },
      nativeBinding: { kind: 'codex', state: 'pending' }, lifetime,
      files: { roots: [filesRoot] } }, options);
    clients.push(credential);
    return credential;
  };
  const http = (credential, connection, message, headers = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const call = request(connection.url, { method: 'POST', headers: {
      authorization: `Bearer ${credential.token}`, accept: 'application/json, text/event-stream',
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      ...(connection.session ? { 'mcp-session-id': connection.session, 'mcp-protocol-version': connection.protocol } : {}), ...headers,
    } }, response => {
      let text = '';
      response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text, json: text ? JSON.parse(text) : null }));
    });
    call.setTimeout(10000, () => call.destroy(new Error('Fixture HTTP request timed out')));
    call.on('error', reject); call.end(body);
  });
  let sequence = 0;
  const rpc = (credential, connection, method, params = {}, id = ++sequence, headers) => http(credential, connection,
    { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }, headers);
  const initialize = async (credential, endpoint = 'bus', asked = '2025-06-18') => {
    const url = endpoint === 'bus' ? credential.busUrl : credential.filesUrl;
    const initialized = await rpc(credential, { url }, 'initialize', { protocolVersion: asked, capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    const connection = { url, session: initialized.headers['mcp-session-id'], protocol: initialized.json?.result?.protocolVersion };
    check(`pending ${endpoint} initialize negotiates a protocol`, initialized.status === 200 && typeof connection.session === 'string'
      && connection.protocol === (asked === 'unsupported' ? '2025-06-18' : asked), initialized.text);
    if (connection.session) {
      const completed = await rpc(credential, connection, 'notifications/initialized', {}, null);
      check(`pending ${endpoint} completes protocol initialization`, completed.status === 202 && completed.text === '', completed.text);
    }
    return connection;
  };
  const tool = (credential, connection, name, args = {}, meta = { threadId: nativeId }, id = ++sequence, headers) => rpc(credential,
    connection, 'tools/call', { name, arguments: args, ...(meta === false ? {} : { _meta: meta }) }, id, headers);
  let serviceError;
  const service = runWorkspaceService({ host, createHost: makeHost, env }).catch(error => { serviceError = error; });
  try {
    await until(() => readDiscovery(paths) !== null || serviceError);
    if (serviceError) throw serviceError;
    bus(home, { cli: version });
    createTask(home, { id: task, title: 'native binding fixture', owner: nativeId });
    upsertParticipant(home, task, participantRecord('user'));
    const pending = await register();
    const before = state();
    check('pending registration creates no actor Host', factories.length === 0, JSON.stringify(factories));
    const clientControl = await new Promise((resolve, reject) => {
      const call = request({ socketPath: paths.controlSocket, path: '/control', method: 'POST',
        headers: { host: 'promptobus.local', authorization: `Bearer ${pending.token}` } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      call.on('error', reject);
      call.end(JSON.stringify({ runtime, operation: 'realize', clientId: pending.clientId, threadId: nativeId }));
    });
    check('a client bearer cannot realize native identity through owner control', clientControl === 401
      && readPrivate(pending.credentialFile).nativeBinding?.state === 'pending');
    const connection = await initialize(pending), files = await initialize(pending, 'reviewer_files', '2025-03-26');
    rmSync(readRoot, { recursive: true });
    for (const [route, expected] of [[connection, mcpTools(registryOf(host))], [files, REVIEW_FILE_TOOLS]]) {
      const ping = await rpc(pending, route, 'ping');
      const list = await rpc(pending, route, 'tools/list');
      check('pending ping and tools/list use pure existing declarations even when file roots are unavailable', ping.status === 200
        && list.status === 200 && JSON.stringify(list.json.result.tools) === JSON.stringify(expected), list.text);
      const denied = await tool(pending, route, route === files ? 'read_file' : 'promptobus_send',
        route === files ? { path: path.join(readRoot, 'proof.txt') } : { to: 'user', type: 'status', body: 'pending must not commit' });
      check('pending native tools/call refuses before actor creation or dispatch', denied.status === 403 && /pending/.test(denied.text), denied.text);
    }
    check('pending initialization and discovery leave journal, receipts, wake and actor factory untouched', state() === before && factories.length === 0);
    mkdirSync(readRoot); writeFileSync(path.join(readRoot, 'proof.txt'), 'owned reviewer text');
    const badRealizations = [];
    for (const threadId of [null, '', ' ', 1, {}, ' native-thread-one', 'native-thread-one\n']) badRealizations.push(await realize(pending, threadId));
    check('owner realization refuses malformed native identities without realizing a grant', badRealizations.every(result => /native thread id/.test(result.error ?? ''))
      && readPrivate(pending.credentialFile).nativeBinding?.state === 'pending', JSON.stringify(badRealizations));
    const realized = await realize(pending, nativeId), repeated = await realize(pending, nativeId), foreign = await realize(pending, 'foreign-native');
    check('owner realization binds one exact native thread, repeats idempotently and refuses another', !realized.error && !repeated.error
      && /already bound/.test(foreign.error ?? '') && readPrivate(pending.credentialFile).nativeBinding?.threadId === nativeId, JSON.stringify({ realized, repeated, foreign }));
    check('owner realization alone does not construct an actor Host', factories.length === 0);
    const beforeDenied = state();
    const beforeDeniedFactories = factories.length;
    for (const [label, meta] of [['missing', false], ['null', null], ['array', []], ['no thread', {}], ['number', { threadId: 1 }],
      ['empty', { threadId: '' }], ['foreign', { threadId: 'foreign-native', sessionId: nativeId }], ['shared root only', { sessionId: nativeId }]]) {
      for (const route of [connection, files]) {
        const denied = await tool(pending, route, route === files ? 'read_file' : 'promptobus_send',
          route === files ? { path: path.join(readRoot, 'proof.txt') } : { to: 'user', type: 'status', body: 'wrong metadata must not commit' }, meta);
        check(`${label} actual native metadata refuses on ${route === files ? 'reviewer_files' : 'bus'}`, denied.status === 403, denied.text);
      }
    }
    const nested = await tool(pending, connection, 'promptobus_task', { _meta: { threadId: nativeId } }, { threadId: 'foreign-native' }, undefined,
      { 'x-promptobus-thread-id': nativeId, 'x-promptobus-role': 'orchestrator' });
    check('arguments, role headers and caller thread headers cannot replace actual native metadata', nested.status === 403, nested.text);
    check('metadata refusals create no Host, request receipt or journal/wake changes', state() === beforeDenied && factories.length === beforeDeniedFactories);
    const listed = await rpc(pending, connection, 'tools/list');
    check('realization preserves the initialized session and pure catalog', listed.status === 200 && factories.length === beforeDeniedFactories);
    const page = await tool(pending, connection, 'promptobus_task');
    check('the same initialized MCP session serves an authorized bus tool after realization', page.status === 200 && !page.json.result?.isError
      && page.text.includes(task), page.text);
    const actor = factories.at(-1);
    check('the ordinary actor Host receives frozen lexical env containing only the owner-bound native identity', actor?.frozen === true
      && actor.cwd === root && resolveSessionIdentity(actor.env).id === nativeId
      && actor.env.CODEX_THREAD_ID === nativeId && ['CLAUDE_CODE_SESSION_ID', 'CURSOR_CONVERSATION_ID', 'PROMPTOBUS_CODEX_SESSION',
        'PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_OPENCODE_SESSION'].every(name => actor.env[name] === undefined), JSON.stringify(actor));
    const read = await tool(pending, files, 'read_file', { path: path.join(readRoot, 'proof.txt') });
    check('the same reviewer session serves a matching native read', read.status === 200 && !read.json.result?.isError && read.text.includes('owned reviewer text'), read.text);
    const sendId = ++sequence, sendArgs = { to: 'user', type: 'status', body: 'one native mutation' };
    const sent = await tool(pending, connection, 'promptobus_send', sendArgs, { threadId: nativeId, sessionId: 'shared-root' }, sendId);
    const replay = await tool(pending, connection, 'promptobus_send', sendArgs, { threadId: nativeId, sessionId: 'shared-root' }, sendId);
    check('an authorized native mutation retains its durable RPC response', sent.status === 200 && !sent.json.result?.isError && replay.text === sent.text
      && strictTaskFacts(home, task).messages.filter(message => message.type === 'status').length === 1, sent.text);
    const receiptSnapshot = state();
    for (const meta of [{ threadId: 'foreign-native', sessionId: 'shared-root' }, false, { sessionId: nativeId }]) {
      const refused = await tool(pending, connection, 'promptobus_send', sendArgs, meta, sendId);
      check('native proof is checked before replaying a saved successful mutation receipt', refused.status === 403, refused.text);
    }
    check('refused cached mutations preserve saved receipts and the single journal commit', state() === receiptSnapshot
      && strictTaskFacts(home, task).messages.filter(message => message.type === 'status').length === 1);
    const otherRoot = path.join(root, 'review-other');
    mkdirSync(otherRoot); writeFileSync(path.join(otherRoot, 'other.txt'), 'other reviewer text');
    const other = await register({}, otherRoot);
    const racing = await Promise.all([realize(other, 'racing-one'), realize(other, 'racing-two')]);
    const winner = readPrivate(other.credentialFile).nativeBinding?.threadId;
    check('concurrent owner realizations cannot bind two native threads', racing.filter(result => !result.error).length === 1
      && racing.filter(result => /already bound/.test(result.error ?? '')).length === 1 && ['racing-one', 'racing-two'].includes(winner), JSON.stringify(racing));
    const otherFiles = await initialize(other, 'reviewer_files');
    const crossed = await tool(other, otherFiles, 'read_file', { path: path.join(readRoot, 'proof.txt') });
    check('a second reviewer grant cannot dispatch with the first native identity', crossed.status === 403, crossed.text);
    const ownRead = await tool(other, otherFiles, 'read_file', { path: path.join(otherRoot, 'other.txt') }, { threadId: winner });
    const foreignRead = await tool(other, otherFiles, 'read_file', { path: path.join(readRoot, 'proof.txt') }, { threadId: winner });
    check('matching native identity preserves each reviewer grant file ceiling', ownRead.status === 200 && !ownRead.json.result?.isError
      && ownRead.text.includes('other reviewer text') && foreignRead.status === 200 && foreignRead.json.result?.isError
      && /outside the declared review roots/.test(foreignRead.text), foreignRead.text);
    const managedAddress = 'worker:owned-native', managedRef = 'owned-native-launch';
    const managedRecord = codexSessionFile(managedRef, { ...env, PROMPTOBUS_CODEX_HOME: host.harnessStateHome('codex') });
    const managedProof = { kind: 'managed', task, address: managedAddress, ref: managedRef, record: managedRecord, launchId: 'owned-launch-one' };
    const launch = { ref: managedRef, home, task, address: managedAddress, threadId: nativeId, launchId: managedProof.launchId,
      holderPid: process.pid, state: 'idle', rpcSocket: path.join(root, 'owned-native.sock'), turns: 3 };
    mkdirSync(path.dirname(managedRecord), { recursive: true });
    writeFileSync(managedRecord, JSON.stringify(launch));
    upsertParticipant(home, task, participantRecord(managedAddress, { harness: 'codex', sessionRef: managedRef, sessionId: nativeId,
      sessionRecord: managedRecord, nativeLaunchId: managedProof.launchId }));
    const managed = await register({ PROMPTOBUS_ROLE: managedAddress }, readRoot, managedProof);
    const managedFactories = factories.length, managedBefore = state();
    const managedRoute = await initialize(managed);
    check('pending managed discovery does not join or hand over a contact point', factories.length === managedFactories
      && state() === managedBefore && readWake(home, task, managedAddress) === null);
    await realize(managed, nativeId);
    const managedPage = await tool(managed, managedRoute, 'promptobus_task');
    const managedActor = factories.at(-1), wake = readWake(home, task, managedAddress);
    check('managed native context derives its owned launch record from lifetime proof and keeps the exact bound thread', managedActor?.env.CODEX_THREAD_ID === nativeId
      && managedActor.env.PROMPTOBUS_CODEX_SESSION === managedRecord && resolveSessionIdentity(managedActor.env).id === nativeId, JSON.stringify(managedActor));
    check('ordinary owned Codex bus join hands over the matching managed launch contact point', managedPage.status === 200 && !managedPage.json.result?.isError
      && wake?.session === nativeId && wake.socket === `${launch.rpcSocket}#3`, JSON.stringify(wake));
    const managedState = state();
    writeFileSync(managedRecord, JSON.stringify({ ...launch, launchId: 'replaced-launch' }));
    const managedReplaced = await tool(managed, managedRoute, 'promptobus_send', { to: 'orchestrator', type: 'status', body: 'replaced managed launch must not commit' });
    writeFileSync(managedRecord, JSON.stringify(launch));
    check('replaced managed lifetime proof refuses even with matching native metadata and cached context', managedReplaced.status === 401
      && state() === managedState, managedReplaced.text);
    for (const [name, replace] of [['revoked', false], ['replaced', true]]) {
      const held = gate(name), credential = await register({ FACTORY_GATE: name });
      const route = await initialize(credential);
      await realize(credential, nativeId);
      const started = factories.length;
      const inFlight = tool(credential, route, 'promptobus_send', { to: 'user', type: 'status', body: `${name} factory must not commit` });
      await until(() => factories.length > started);
      const saved = readPrivate(credential.credentialFile), priorState = state();
      if (replace) writePrivate(credential.credentialFile, { ...saved, nativeBinding: { kind: 'codex', state: 'bound', threadId: 'replacement-native' } });
      else await revokeServiceClient(host, credential.clientId, options);
      held.release();
      const refused = await inFlight;
      check(`a deferred Host factory cannot restore ${name} native authority`, refused.status === 401 && state() === priorState, refused.text);
      if (replace) {
        const count = factories.length;
        const restored = await tool(credential, route, 'promptobus_task', {}, { threadId: 'replacement-native' });
        check('a replacement grant constructs a fresh Host with the replacement identity', restored.status === 200 && factories.length === count + 1
          && factories.at(-1).env.CODEX_THREAD_ID === 'replacement-native', restored.text);
      } else {
        check('a revoked deferred factory leaves no saved grant, session or request resources', !existsSync(credential.credentialFile)
          && !existsSync(path.join(paths.sessions, `${route.session}.json`)) && !existsSync(path.join(paths.requests, route.session)));
      }
    }
    const race = await register();
    const controls = await Promise.all([realize(race, nativeId), revokeServiceClient(host, race.clientId, options)]);
    check('realize racing with revoke cannot recreate a removed grant', controls.length === 2 && !existsSync(race.credentialFile));
    const removed = await tool(race, connection, 'promptobus_task');
    check('a revoked native credential cannot borrow an existing session', removed.status === 401, removed.text);
  } finally {
    for (const held of gates.values()) held.release();
    for (const credential of clients) {
      if (existsSync(credential.credentialFile)) await revokeServiceClient(host, credential.clientId, options);
    }
    if (!serviceError) await owner({ operation: 'stop' });
    await service;
    rmSync(privateHome, { recursive: true, force: true });
  }
  if (serviceError) throw serviceError;
}

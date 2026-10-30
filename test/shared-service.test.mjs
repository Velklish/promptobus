import { check, skip } from './check.mjs';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { bindServiceClient, ensureWorkspaceService, registerServiceClient, revokeServiceClient, serviceControl, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { processState, readDiscovery, requireProcess, runtimeIdentity, servicePaths } from '../lib/service-state.js';
import { bindSessionIdentity, bus, createTask, participantRecord, strictTaskFacts, upsertParticipant, withIdentityEnvironment, sessionIdentity } from '../lib/store.js';
import { REGISTRY, resolveSessionIdentity } from '../lib/drivers.js';
import { bindServiceHarnessContext, requireServiceHarnessContext, serviceHarnessContext } from '../lib/harness-home.js';
import { sessionFile as codexSessionFile } from '../lib/codex-session.js';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('shared service process lifetime and private control socket', 'This platform has no implemented process-birth observer');
} else {
  const ROOT = realpathSync(makeSandbox('promptobus-shared-service-'));
  const PRIVATE = mkdtempSync(path.join(realpathSync('/tmp'), 'pbsvc-'));
  const HOME = path.join(ROOT, '.promptobus');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const PACKAGE = path.join(HERE, '..');
  const ENTRY = path.join(ROOT, 'consumer.mjs');
  const VERSION = JSON.parse(readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')).version;
  const TASK = 'shared-root-t20261030-000000';
  const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: PRIVATE, PROMPTOBUS_SERVICE_IDLE_MS: '1000',
    PROMPTOBUS_SERVICE_RESERVATION_MS: '2500', PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off' };
  const owned = new Map();
  let fakePort = null;
  let lifetimeChild = null;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(predicate, timeout = 5000) {
    const end = Date.now() + timeout;
    while (!await predicate()) { if (Date.now() >= end) return false; await wait(25); }
    return true;
  }
  const remember = discovery => { owned.set(discovery.process.pid, discovery.process); return discovery; };
  process.once('exit', () => {
    for (const identity of owned.values()) if (processState(identity) !== 'dead') {
      try { process.kill(identity.pid, 'SIGTERM'); } catch {}
    }
    rmSync(PRIVATE, { recursive: true, force: true });
  });
  writeHostConfig(ROOT, { tools: [] });
  writeFileSync(ENTRY, `import {existsSync,writeFileSync} from 'node:fs';
import {createStandaloneHost} from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, 'dist', 'host-index.js')).href)};
import {runPromptobus} from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, 'lib', 'cli.js')).href)};
// Hold deferred shutdown work to expose admission between its acknowledgement and execution.
const immediate=globalThis.setImmediate;
globalThis.setImmediate=(callback,...args)=>immediate(()=>{
  if(process.env.SHARED_TEST_STOP_GATE && existsSync(process.env.SHARED_TEST_STOP_GATE)) setTimeout(callback,250,...args);
  else callback(...args);
});
const make=({cwd,env})=>{
  const host=createStandaloneHost({cwd,binPath:${JSON.stringify(ENTRY)},version:${JSON.stringify(VERSION)}});
  const argv=host.busArgv;
  host.busArgv=args=>{
    if(args[0]==='warden') {
      if(env.SHARED_TEST_GATE && existsSync(env.SHARED_TEST_GATE)) {
        writeFileSync(env.SHARED_TEST_MARKER,'entered');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
      }
      throw new Error('fixture does not launch an external warden');
    }
    return argv(args);
  };
  if(env.SHARED_TEST_BIN) host.resolveToolBin=()=>({ok:true,bin:env.SHARED_TEST_BIN});
  return host;
};
const factory=async context=>{
  const {env}=context;
  if(env.SHARED_TEST_FACTORY_GATE) {
    writeFileSync(env.SHARED_TEST_FACTORY_MARKER,'entered');
    while(existsSync(env.SHARED_TEST_FACTORY_GATE)) await new Promise(resolve=>setTimeout(resolve,10));
  }
  return make(context);
};
const host=make({cwd:process.cwd(),env:process.env});
const code=await runPromptobus(process.argv.slice(2),{host,createHost:factory,env:process.env,cwd:process.cwd()});
if(code) process.exitCode=code;
`);
  const host = createStandaloneHost({ cwd: ROOT, binPath: ENTRY, version: VERSION });
  const options = { cwd: ROOT, env };
  const paths = servicePaths(host, env);
  const cli = args => new Promise(resolve => {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: null, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const http = (url, token, body, extra = {}, method = 'POST') => new Promise((resolve, reject) => {
    const text = body === undefined ? null : JSON.stringify(body);
    const target = new URL(url);
    const call = request(target, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
      ...(text === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }), ...extra } }, response => {
      let output = '';
      response.setEncoding('utf8'); response.on('data', chunk => { output += chunk; });
      response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: output,
        json: output ? JSON.parse(output) : null }));
    });
    call.setTimeout(10000, () => call.destroy(new Error('Fixture HTTP request timed out')));
    call.on('error', reject); call.end(text);
  });
  let sequence = 0;
  const initialize = async (credential, files = false, complete = true) => {
    const result = await http(files ? credential.filesUrl : credential.busUrl, credential.token,
      { jsonrpc: '2.0', id: ++sequence, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
    const connection = { ...result, session: result.headers['mcp-session-id'], url: files ? credential.filesUrl : credential.busUrl };
    if (complete && result.status === 200) {
      const initialized = await http(connection.url, credential.token, { jsonrpc: '2.0', method: 'notifications/initialized' },
        { 'mcp-session-id': connection.session, 'mcp-protocol-version': '2025-06-18' });
      check('the client completes MCP initialization without a response body', initialized.status === 202 && initialized.text === '');
    }
    return connection;
  };
  const tool = (credential, connection, name, args = {}, id = ++sequence, headers = {}) => http(connection.url, credential.token,
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    { 'mcp-session-id': connection.session, 'mcp-protocol-version': '2025-06-18', ...headers });
  const clientEnv = (role, session) => ({ ...env, PROMPTOBUS_ROLE: role, PROMPTOBUS_TASK: TASK, CLAUDE_CODE_SESSION_ID: session });
  let current = null;
  try {
    bus(HOME, { cli: VERSION });
    createTask(HOME, { id: TASK, title: 'shared fixture', owner: 'root-session' });
    upsertParticipant(HOME, TASK, participantRecord('worker:one', { harness: 'claude', session: 'worker-ref', sessionId: 'worker-one' }));
    upsertParticipant(HOME, TASK, participantRecord('reporter', { harness: 'claude', session: 'reporter-ref', sessionId: 'reporter-one' }));

    const cold = await Promise.all(Array.from({ length: 5 }, () => cli(['service', 'ensure', '--json'])));
    check('concurrent public ensure commands succeed', cold.every(result => result.code === 0), cold.map(result => result.stderr).join(' | '));
    const discovered = cold.filter(result => result.code === 0).map(result => JSON.parse(result.stdout));
    discovered.forEach(remember);
    current = discovered[0];
    check('concurrent cold starts publish exactly one process and endpoint', discovered.length === 5
      && new Set(discovered.map(item => item.process.pid)).size === 1 && new Set(discovered.map(item => item.url)).size === 1);
    const listing = await new Promise(resolve => {
      const child = spawn('ps', ['-axo', 'pid=,command='], { stdio: ['ignore', 'pipe', 'ignore'] });
      let text = ''; child.stdout.on('data', chunk => { text += chunk; });
      child.on('close', () => resolve(text.split('\n').filter(line => line.includes(`${ENTRY} service run`)).map(line => Number(line.trim().split(/\s/)[0]))));
    });
    check('only one owned physical service remains after the contenders exit', listing.length === 1 && listing[0] === current.process.pid, JSON.stringify(listing));
    check('discovery contains no bearer or client credential', !/token|credential|authorization/i.test(JSON.stringify(readDiscovery(paths))));

    const worker = await registerServiceClient(host, { cwd: ROOT, env: clientEnv('worker:one', 'worker-one'),
      lifetime: { kind: 'process', process: requireProcess() } }, options);
    const connection = await initialize(worker);
    check('a real HTTP client initializes the bus', connection.status === 200 && typeof connection.session === 'string'
      && connection.json.result.protocolVersion === '2025-06-18');
    const incomplete = await initialize(worker, false, false);
    const early = await tool(worker, incomplete, 'promptobus_task');
    check('tools refuse before the initialized notification', early.status === 400 && /completed initialization/.test(early.text));
    await http(incomplete.url, worker.token, undefined, { 'mcp-session-id': incomplete.session }, 'DELETE');
    const page = await tool(worker, connection, 'promptobus_task');
    check('the HTTP bus uses the client task and address', page.status === 200 && !page.json.result.isError
      && page.json.result.content[0].text.includes(TASK));
    const forged = await tool(worker, connection, 'promptobus_digest', {}, undefined,
      { 'x-promptobus-role': 'reporter', 'x-promptobus-task': 'other-task' });
    check('caller headers cannot promote a worker to reporter', forged.status === 200 && forged.json.result.isError
      && /reporter only.*worker:one/.test(forged.json.result.content[0].text));
    const unauth = await http(connection.url, 'wrong-token', { jsonrpc: '2.0', id: ++sequence, method: 'ping' }, { 'mcp-session-id': connection.session });
    check('a foreign bearer is refused before dispatch', unauth.status === 401);
    const ownerDenied = await new Promise((resolve, reject) => {
      const call = request({ socketPath: paths.controlSocket, path: '/control', method: 'POST',
        headers: { host: 'promptobus.local', authorization: `Bearer ${worker.token}` } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      call.on('error', reject); call.end(JSON.stringify({ operation: 'stop' }));
    });
    check('a client bearer cannot use owner control', ownerDenied === 401);
    const foreignOrigin = await http(connection.url, worker.token, { jsonrpc: '2.0', id: ++sequence, method: 'ping' },
      { 'mcp-session-id': connection.session, origin: 'https://foreign.example' });
    check('a foreign Origin is refused', foreignOrigin.status === 403);
    const foreignHost = await http(connection.url, worker.token, { jsonrpc: '2.0', id: ++sequence, method: 'ping' },
      { 'mcp-session-id': connection.session, host: 'foreign.example' });
    check('a foreign HTTP authority is refused', foreignHost.status === 403);
    const badProtocol = await http(connection.url, worker.token, { jsonrpc: '2.0', id: ++sequence, method: 'ping' },
      { 'mcp-session-id': connection.session, 'mcp-protocol-version': '1900-01-01' });
    check('an unsupported protocol version is refused', badProtocol.status === 400);
    const badInitialProtocol = await http(connection.url, worker.token, { jsonrpc: '2.0', id: ++sequence,
      method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { 'mcp-protocol-version': '1900-01-01' });
    check('an unsupported protocol header also refuses initialization', badInitialProtocol.status === 400);
    const sse = await http(connection.url, worker.token, undefined, { 'mcp-session-id': connection.session }, 'GET');
    check('the JSON transport explicitly declines SSE', sse.status === 405);
    const refusedStop = await cli(['service', 'stop', '--json']);
    check('public stop refuses a live client', refusedStop.code === 1 && /live clients/.test(refusedStop.stderr));
    await wait(1500);
    check('a live idle client retains the service without HTTP requests or SSE', processState(current.process) !== 'dead');

    const readA = path.join(ROOT, 'read-a'), readB = path.join(ROOT, 'read-b');
    mkdirSync(readA); mkdirSync(readB);
    writeFileSync(path.join(readA, 'a.txt'), 'alpha'); writeFileSync(path.join(readB, 'b.txt'), 'beta');
    const first = await registerServiceClient(host, { cwd: ROOT, env: clientEnv('worker:one', 'worker-one'),
      lifetime: { kind: 'process', process: requireProcess() }, files: { roots: [readA] } }, options);
    const second = await registerServiceClient(host, { cwd: ROOT, env: clientEnv('worker:one', 'worker-one'),
      lifetime: { kind: 'process', process: requireProcess() }, files: { roots: [readB] } }, options);
    const firstFiles = await initialize(first, true), secondFiles = await initialize(second, true);
    const readId = ++sequence;
    const own = await tool(first, firstFiles, 'read_file', { path: path.join(readA, 'a.txt') }, readId);
    const crossed = await tool(first, firstFiles, 'read_file', { path: path.join(readB, 'b.txt') });
    const ownB = await tool(second, secondFiles, 'read_file', { path: path.join(readB, 'b.txt') });
    check('simultaneous reviewer file clients retain separate roots', own.status === 200 && !own.json.result.isError
      && crossed.json.result.isError && !ownB.json.result.isError);
    writeFileSync(path.join(readA, 'a.txt'), 'updated alpha');
    const refreshed = await tool(first, firstFiles, 'read_file', { path: path.join(readA, 'a.txt') }, readId);
    check('repeating an approved read does not retain an obsolete file body', refreshed.status === 200 && /updated alpha/.test(refreshed.text));
    const foreignSession = await http(first.filesUrl, second.token, { jsonrpc: '2.0', id: ++sequence, method: 'tools/list' }, { 'mcp-session-id': firstFiles.session });
    check('a client cannot borrow another client MCP session', foreignSession.status === 404);
    for (const [name, args] of [
      ['read_file', { path: paths.owner }], ['read_files', { files: [{ path: second.credentialFile }] }],
      ['list_files', { path: PRIVATE }], ['search_text', { path: PRIVATE, query: 'token' }],
    ]) {
      const denied = await tool(first, firstFiles, name, args);
      check(`${name} cannot expose owner or foreign client credentials`, denied.status === 200 && denied.json.result.isError);
    }
    symlinkSync(paths.owner, path.join(readA, 'linked-secret'));
    const linked = await tool(first, firstFiles, 'read_file', { path: path.join(readA, 'linked-secret') });
    check('a symlink cannot expose a private service credential', linked.json.result.isError);
    for (const files of [{ roots: ['/'] }, { roots: [paths.owner], canonicalFiles: [paths.owner] }]) {
      let refused = '';
      try { await registerServiceClient(host, { cwd: ROOT, env: clientEnv('worker:one', 'worker-one'), files }, options); } catch (error) { refused = error.message; }
      check('unsafe reviewer grants overlapping the private credential tree refuse', /overlap private/.test(refused), refused);
    }
    let changedHarness = '';
    try { await registerServiceClient(host, { cwd: ROOT, env: { ...clientEnv('worker:one', 'worker-one'), SHARED_TEST_BIN: '/different/bin' } }, options); }
    catch (error) { changedHarness = error.message; }
    check('a different harness binding refuses without switching global state', /different harness/.test(changedHarness), changedHarness);

    const id = ++sequence, args = { to: 'orchestrator', type: 'status', body: 'one commit' };
    const sent = await tool(worker, connection, 'promptobus_send', args, id);
    const repeated = await tool(worker, connection, 'promptobus_send', args, id);
    const altered = await tool(worker, connection, 'promptobus_send', { ...args, body: 'different' }, id);
    check('the same RPC returns its saved response while changed arguments refuse', sent.status === 200 && !sent.json.result.isError
      && repeated.text === sent.text && altered.status === 409);
    check('repeated and altered RPCs did not duplicate the message commit', strictTaskFacts(HOME, TASK).messages.filter(message => message.type === 'status').length === 1);

    process.kill(current.process.pid, 'SIGKILL');
    await until(() => processState(current.process) === 'dead');
    current = remember(await ensureWorkspaceService(host, options));
    check('owner preflight restarts the crashed service at the retained endpoint', current.url === connection.url.replace(/mcp\/bus$/, ''));
    const recovered = await tool(worker, connection, 'promptobus_send', args, id);
    check('a completed RPC and native client binding survive crash plus owner preflight', recovered.status === 200 && recovered.text === sent.text
      && strictTaskFacts(HOME, TASK).messages.filter(message => message.type === 'status').length === 1);

    const gate = path.join(ROOT, 'pause-gate'), marker = path.join(ROOT, 'pause-marker');
    const reporter = await registerServiceClient(host, { cwd: ROOT, env: { ...clientEnv('reporter', 'reporter-one'), PROMPTOBUS_WARDEN: 'on',
      SHARED_TEST_GATE: gate, SHARED_TEST_MARKER: marker }, lifetime: { kind: 'process', process: requireProcess() } }, options);
    const reporterConnection = await initialize(reporter);
    writeFileSync(gate, 'pause after journal commit');
    const uncertainId = ++sequence, uncertainArgs = { body: 'one uncertain question' };
    const pending = tool(reporter, reporterConnection, 'promptobus_ask', uncertainArgs, uncertainId).catch(error => ({ error: error.message }));
    check('the real reporter request reached its post-commit consumer callback', await until(() => existsSync(marker)));
    process.kill(current.process.pid, 'SIGKILL');
    await pending; await until(() => processState(current.process) === 'dead');
    rmSync(gate);
    current = remember(await ensureWorkspaceService(host, options));
    const uncertain = await tool(reporter, reporterConnection, 'promptobus_ask', uncertainArgs, uncertainId);
    check('an interrupted RPC is reported uncertain rather than blindly rerun', uncertain.status === 409 && /uncertain/.test(uncertain.text));
    check('the interrupted reporter send was committed exactly once', strictTaskFacts(HOME, TASK).messages.filter(message => message.type === 'question').length === 1);

    for (const credential of [first, second, reporter]) await revokeServiceClient(host, credential.clientId, options);
    const revoked = await tool(first, firstFiles, 'read_file', { path: path.join(readA, 'a.txt') });
    check('revoked credentials cannot reuse a cached connection', revoked.status === 401);
    check('revocation releases protocol and request resources', !existsSync(path.join(paths.sessions, `${firstFiles.session}.json`))
      && !existsSync(path.join(paths.requests, firstFiles.session)) && !existsSync(first.credentialFile));
    lifetimeChild = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise((resolve, reject) => { lifetimeChild.once('spawn', resolve); lifetimeChild.once('error', reject); });
    const processClient = await registerServiceClient(host, { cwd: ROOT, env: clientEnv('worker:one', 'worker-one'),
      lifetime: { kind: 'process', process: requireProcess(lifetimeChild.pid) } }, options);
    const processConnection = await initialize(processClient);
    await tool(processClient, processConnection, 'promptobus_task');
    const childExit = new Promise(resolve => lifetimeChild.once('close', resolve));
    lifetimeChild.stdin.end(); await childExit; lifetimeChild = null;
    check('native process exit releases the client and its persisted protocol resources', await until(() => !existsSync(processClient.credentialFile)
      && !existsSync(path.join(paths.sessions, `${processConnection.session}.json`)) && !existsSync(path.join(paths.requests, processConnection.session))));
    const absent = await initialize(processClient);
    check('an exited native process cannot reinitialize with its former bearer', absent.status === 401);
    const binding = await registerServiceClient(host, { cwd: ROOT, env: clientEnv('worker:one', 'worker-one') }, options);
    let replaced = '';
    lifetimeChild = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise((resolve, reject) => { lifetimeChild.once('spawn', resolve); lifetimeChild.once('error', reject); });
    const managedHolder = requireProcess(lifetimeChild.pid);
    const managedRecord = codexSessionFile('managed-ref', { ...env, PROMPTOBUS_CODEX_HOME: host.harnessStateHome('codex') });
    const managedProof = { kind: 'managed', task: TASK, address: 'reporter', ref: 'managed-ref', record: managedRecord, launchId: 'launch-generation-one' };
    const launchRecord = { ref: managedProof.ref, home: HOME, task: TASK, address: managedProof.address,
      threadId: 'managed-one', launchId: managedProof.launchId, holderPid: lifetimeChild.pid, state: 'idle' };
    mkdirSync(path.dirname(managedRecord), { recursive: true });
    writeFileSync(managedRecord, JSON.stringify(launchRecord));
    upsertParticipant(HOME, TASK, participantRecord(managedProof.address, { harness: 'codex', sessionRef: managedProof.ref,
      sessionId: launchRecord.threadId, sessionRecord: managedRecord, nativeLaunchId: managedProof.launchId }));
    const managedGate = path.join(ROOT, 'managed-pause-gate'), managedMarker = path.join(ROOT, 'managed-pause-marker');
    const managedEnv = { ...clientEnv(managedProof.address, 'managed-one'), CLAUDE_CODE_SESSION_ID: undefined,
      CODEX_THREAD_ID: launchRecord.threadId, PROMPTOBUS_CODEX_SESSION: managedRecord, PROMPTOBUS_WARDEN: 'on',
      SHARED_TEST_GATE: managedGate, SHARED_TEST_MARKER: managedMarker };
    try { await bindServiceClient(host, binding.clientId, { ...managedProof, address: 'worker:one', ref: 'replaced-ref' }, options); }
    catch (error) { replaced = error.message; }
    check('owner bind refuses a replaced provider session reference', /no matching task, participant/.test(replaced), replaced);
    await revokeServiceClient(host, binding.clientId, options);
    for (const proof of [
      { kind: 'managed', task: TASK, address: managedProof.address, ref: managedProof.ref },
      { kind: 'managed', task: TASK, address: managedProof.address, ref: managedProof.ref, record: managedRecord },
    ]) {
      const result = await registerServiceClient(host, { cwd: ROOT, env: managedEnv, lifetime: proof }, options)
        .then(credential => ({ credential }), error => ({ error: error.message }));
      check('managed lifetime refuses an incomplete immutable launch proof', /Invalid client lifetime/.test(result.error ?? ''), result.error ?? 'credential was issued');
      if (result.credential) await revokeServiceClient(host, result.credential.clientId, options);
    }
    const managed = await registerServiceClient(host, { cwd: ROOT, env: managedEnv, lifetime: managedProof }, options);
    const managedConnection = await initialize(managed);
    check('an owned complete launch-generation proof can initialize', managedConnection.status === 200);
    const managedReadId = ++sequence;
    const managedRead = await tool(managed, managedConnection, 'promptobus_task', {}, managedReadId);
    check('the live owned managed holder serves an ordinary bus read', managedRead.status === 200 && !managedRead.json.result.isError
      && (await workspaceServiceStatus(host, options)).unknownManaged === 0);
    writeFileSync(managedGate, 'pause managed send after journal commit');
    const managedUncertainId = ++sequence, managedUncertainArgs = { body: 'one uncertain managed question' };
    const questionsBeforeManaged = strictTaskFacts(HOME, TASK).messages.filter(message => message.type === 'question').length;
    const managedPending = tool(managed, managedConnection, 'promptobus_ask', managedUncertainArgs, managedUncertainId).catch(error => ({ error: error.message }));
    check('the managed request reaches its real post-journal callback with its holder alive', await until(() => existsSync(managedMarker))
      && processState(managedHolder) === 'alive'
      && strictTaskFacts(HOME, TASK).messages.filter(message => message.type === 'question').length === questionsBeforeManaged + 1);
    process.kill(current.process.pid, 'SIGKILL');
    await managedPending; await until(() => processState(current.process) === 'dead');
    rmSync(managedGate);
    current = remember(await ensureWorkspaceService(host, options));
    const managedUncertain = await tool(managed, managedConnection, 'promptobus_ask', managedUncertainArgs, managedUncertainId);
    check('the managed crash leaves a real uncertain request receipt', managedUncertain.status === 409 && /uncertain/.test(managedUncertain.text));
    await revokeServiceClient(host, worker.clientId, options);
    const managedRequestDir = path.join(paths.requests, managedConnection.session);
    const savedResources = [managed.credentialFile, path.join(paths.sessions, `${managedConnection.session}.json`),
      ...readdirSync(managedRequestDir).map(file => path.join(managedRequestDir, file))].map(file => [file, readFileSync(file)]);
    const resourcesUnchanged = () => savedResources.every(([file, bytes]) => existsSync(file) && readFileSync(file).equals(bytes));
    const messageIds = () => JSON.stringify(strictTaskFacts(HOME, TASK).messages.map(message => message.id));
    const savedMessages = messageIds();
    const invalidRecords = [
      ['missing', undefined], ['malformed syntax', '{'], ['empty object', '{}'], ['null', 'null'], ['array', '[]'],
      ...['launchId', 'home', 'task', 'address'].map(field => {
        const incomplete = { ...launchRecord }; delete incomplete[field];
        return [`missing ${field}`, JSON.stringify(incomplete)];
      }),
    ];
    for (const [unavailable, content] of invalidRecords) {
      if (content === undefined) rmSync(managedRecord);
      else writeFileSync(managedRecord, content);
      const unprovenStatus = await workspaceServiceStatus(host, options);
      const unproven = await tool(managed, managedConnection, 'promptobus_ask', { body: `unproven ${unavailable} launch must not commit` })
        .catch(error => ({ status: 0, error: error.message }));
      check(`a ${unavailable} same-pointer launch proof retains unknown lifetime and all protocol receipts but refuses side effects`, unproven.status === 401
        && unprovenStatus.unknownManaged === 1 && unprovenStatus.clients === 1 && resourcesUnchanged()
        && processState(managedHolder) === 'alive' && processState(current.process) === 'alive'
        && messageIds() === savedMessages);
      if (unavailable === 'empty object') {
        const retained = unprovenStatus.unknownManaged === 1 && unprovenStatus.clients === 1 && resourcesUnchanged();
        if (retained) await wait(Number(env.PROMPTOBUS_SERVICE_IDLE_MS) + 250);
        check('an unknown managed proof alone retains the service beyond its configured idle interval', retained
          && processState(current.process) === 'alive' && processState(managedHolder) === 'alive' && resourcesUnchanged());
      }
      writeFileSync(managedRecord, JSON.stringify(launchRecord));
    }
    const restoredRead = await tool(managed, managedConnection, 'promptobus_task', {}, managedReadId).catch(error => ({ status: 0, text: error.message }));
    const restoredFreshRead = await tool(managed, managedConnection, 'promptobus_task').catch(error => ({ status: 0, text: error.message }));
    const restoredUncertain = await tool(managed, managedConnection, 'promptobus_ask', managedUncertainArgs, managedUncertainId)
      .catch(error => ({ status: 0, text: error.message }));
    check('restoring the owned launch proof restores cached and fresh access and retains request uncertainty without duplicating its commit',
      restoredRead.status === 200 && restoredRead.text === managedRead.text && restoredUncertain.status === 409 && /uncertain/.test(restoredUncertain.text)
      && restoredFreshRead.status === 200 && !restoredFreshRead.json.result.isError
      && resourcesUnchanged() && messageIds() === savedMessages);
    writeFileSync(managedRecord, JSON.stringify({ ...launchRecord, launchId: 'launch-generation-two' }));
    const oldGeneration = await tool(managed, managedConnection, 'promptobus_ask', { body: 'stale launch must not commit' })
      .catch(error => ({ status: 0, error: error.message }));
    check('same ref, pointer and native identity with a new launch generation rejects the old bearer before side effects', oldGeneration.status === 401
      && messageIds() === savedMessages);
    if (existsSync(managed.credentialFile)) await revokeServiceClient(host, managed.clientId, options);
    const managedHolderExit = new Promise(resolve => lifetimeChild.once('close', resolve));
    lifetimeChild.stdin.end(); await managedHolderExit; lifetimeChild = null;
    if (processState(current.process) === 'dead') current = remember(await ensureWorkspaceService(host, options));
    const status = await workspaceServiceStatus(host, options);
    const controlStatus = await serviceControl(paths, { operation: 'status' });
    check('private and public diagnostics expose counts rather than credentials', status.running && status.clients === 0
      && controlStatus.clients === 0 && !/token|credential|authorization/i.test(JSON.stringify(status)));
    const reservation = await registerServiceClient(host, { cwd: ROOT, env: clientEnv('worker:one', 'worker-one') }, options);
    await wait(1500);
    check('the readiness-to-initialize reservation retains an idle service', processState(current.process) !== 'dead');
    const expiryHolder = await registerServiceClient(host, { cwd: ROOT, env: clientEnv('worker:one', 'worker-one'),
      lifetime: { kind: 'process', process: requireProcess() } }, options);
    await wait(1100);
    const expired = await initialize(reservation);
    check('an expired startup reservation is refused', expired.status === 401);
    await revokeServiceClient(host, expiryHolder.clientId, options);
    check('a service exits after reservations expire and no client remains', await until(() => processState(current.process) === 'dead'));

    const retained = current.url;
    fakePort = createServer((_request, response) => response.end('foreign'));
    await new Promise(resolve => fakePort.listen(Number(new URL(retained).port), '127.0.0.1', resolve));
    let occupied = '';
    try { await ensureWorkspaceService(host, options); } catch (error) { occupied = error.message; }
    check('a foreign retained port refuses instead of selecting a second endpoint', /EADDRINUSE|address already in use/.test(occupied), occupied);
    await new Promise(resolve => fakePort.close(resolve)); fakePort = null;
    current = remember(await ensureWorkspaceService(host, options));
    check('the same endpoint is reused after the foreign listener leaves', current.url === retained);
    const factoryGate = path.join(ROOT, 'factory-gate'), factoryMarker = path.join(ROOT, 'factory-marker');
    writeFileSync(factoryGate, 'hold client Host factory');
    const pendingRegister = serviceControl(paths, { operation: 'register', runtime: runtimeIdentity(host), client: {
      cwd: ROOT, env: { ...clientEnv('worker:one', 'worker-one'), SHARED_TEST_FACTORY_GATE: factoryGate, SHARED_TEST_FACTORY_MARKER: factoryMarker },
      lifetime: { kind: 'process', process: requireProcess() },
    } });
    check('a concurrent registration reaches the pending async Host factory', await until(() => existsSync(factoryMarker)));
    const pendingStop = await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) })
      .then(result => ({ result }), error => ({ error: error.message }));
    rmSync(factoryGate);
    const registered = await pendingRegister;
    check('stop refuses an admitted asynchronous registration and keeps its accepted grant alive', /live clients or active work/.test(pendingStop.error ?? '')
      && processState(current.process) !== 'dead' && (await initialize(registered)).status === 200);
    await revokeServiceClient(host, registered.clientId, options);

    const stopGate = path.join(ROOT, 'stop-gate');
    // The daemon inherits this path on its next preflight; the scheduler hook only widens an existing race window.
    await stopWorkspaceService(host, options);
    const stopOptions = { ...options, env: { ...env, SHARED_TEST_STOP_GATE: stopGate } };
    current = remember(await ensureWorkspaceService(host, stopOptions));
    writeFileSync(stopGate, 'hold deferred closing');
    const acceptedStop = await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) });
    const afterStop = await serviceControl(paths, { operation: 'register', runtime: runtimeIdentity(host),
      client: { cwd: ROOT, env: clientEnv('worker:one', 'worker-one') } })
      .then(credential => ({ credential }), error => ({ error: error.message }));
    check('accepted stop closes registration admission before a new owner request can receive a credential', acceptedStop.stopped === true
      && !afterStop.credential, afterStop.credential ? 'stop and register both accepted' : afterStop.error);
    rmSync(stopGate);
    check('the accepted concurrent stop physically exits', await until(() => processState(current.process) === 'dead'));
    current = remember(await ensureWorkspaceService(host, options));
    if (afterStop.credential) await revokeServiceClient(host, afterStop.credential.clientId, options);
    const final = await cli(['service', 'stop', '--json']);
    check('public stop succeeds with no clients', final.code === 0 && JSON.parse(final.stdout).stopped === true, final.stderr);
    check('public stop returns only after the owned process exits', processState(current.process) === 'dead');
    check('all owned service generations have exited', await until(() => [...owned.values()].every(identity => processState(identity) === 'dead')));

    bindSessionIdentity(resolveSessionIdentity);
    const outer = process.env.CLAUDE_CODE_SESSION_ID;
    const scoped = await Promise.all(['first', 'second'].map((id, index) => withIdentityEnvironment({ CLAUDE_CODE_SESSION_ID: id }, async () => {
      await wait(index ? 5 : 15); return sessionIdentity();
    })));
    check('implicit identity reads stay lexical across concurrent async clients', scoped.join(',') === 'first,second' && process.env.CLAUDE_CODE_SESSION_ID === outer);
    bindServiceHarnessContext(host, env, REGISTRY);
    let boundMismatch = '';
    try { bindServiceHarnessContext({ ...host, harnessStateHome: () => '/foreign/harness/home' }, env, REGISTRY); }
    catch (error) { boundMismatch = error.message; }
    check('service startup checks the actually bound global harness readers', /different harness/.test(boundMismatch), boundMismatch);
    const expectedHarness = serviceHarnessContext(host, env, REGISTRY), resolveBin = host.resolveToolBin;
    let cursorMismatch = '';
    try { requireServiceHarnessContext(expectedHarness, { ...host, resolveToolBin: tool => tool === 'cursor-agent'
      ? { ok: true, bin: '/different/cursor-agent' } : resolveBin(tool) }, env, REGISTRY); }
    catch (error) { cursorMismatch = error.message; }
    check('compatibility checks the Cursor driver binary even when cursor and every other tool response are unchanged', /different harness/.test(cursorMismatch), cursorMismatch);
  } finally {
    if (lifetimeChild) lifetimeChild.kill('SIGTERM');
    if (fakePort) await new Promise(resolve => fakePort.close(resolve));
    for (const identity of owned.values()) if (processState(identity) !== 'dead') {
      try { process.kill(identity.pid, 'SIGTERM'); } catch {}
    }
    await until(() => [...owned.values()].every(identity => processState(identity) === 'dead'));
    rmSync(PRIVATE, { recursive: true, force: true });
  }
}

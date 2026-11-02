import { check, skip } from './check.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { readHealth, readWardenMark } from '../dist/sidecar.js';
import { makeSandbox, makeSockPath, listenTestSocket, writeHostConfig } from './sandbox.mjs';
import { bus, createTask, participantRecord, readInbox, readWake, readWardenExit, readWardenGeneration, sendMessage, upsertParticipant, wakeFile, writeWake, WARDEN_BEAT_SEC } from '../lib/store.js';
import { abortTaskWarden, bindServiceClient, ensureTaskWarden, ensureWorkspaceService, registerServiceClient, revokeServiceClient, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { processState, recordVersion, requireProcess, servicePaths } from '../lib/service-state.js';
import { ServiceWarden } from '../lib/service-warden.js';
import { REGISTRY } from '../lib/drivers.js';
import { serviceHarnessContext } from '../lib/harness-home.js';
import { participantSession } from '../lib/status.js';
import { sessionFile as codexSessionFile } from '../lib/codex-session.js';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('shared task service process lifetime', 'The shared service has no process-birth observer on this platform');
} else {
  const ROOT = realpathSync(makeSandbox('promptobus-shared-warden-'));
  const PRIVATE = mkdtempSync(path.join(realpathSync('/tmp'), 'pbsvc-'));
  const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const ENTRY = path.join(ROOT, 'consumer.mjs'), FAKE = path.join(ROOT, 'claude-fixture.mjs');
  const GATE = path.join(ROOT, 'inspect-gate'), ENTERED = path.join(ROOT, 'inspect-entered'), RELEASE = path.join(ROOT, 'inspect-release');
  const LIST = path.join(ROOT, 'sessions.json');
  const VERSION = JSON.parse(readFileSync(path.join(PACKAGE, 'package.json'), 'utf8')).version;
  const TASKS = ['shared-one-t20261030-020000', 'shared-two-t20261030-020000'];
  const CONTACT = 'shared-contact-t20261030-020000';
  const EMPTY = 'shared-empty-t20261030-020000';
  const FORMATTED = path.join(ROOT, 'formatted-commands.jsonl');
  const NATURAL_GATE = path.join(ROOT, 'natural-gate'), NATURAL_HELD = path.join(ROOT, 'natural-held'), NATURAL_RELEASE = path.join(ROOT, 'natural-release');
  const PROBE_UNAVAILABLE = path.join(ROOT, 'birth-unavailable');
  const SESSION = 'owned-root-session';
  const env = { ...process.env,
    PROMPTOBUS_SERVICE_HOME: PRIVATE, PROMPTOBUS_SERVICE_IDLE_MS: '200', PROMPTOBUS_WARDEN: 'off' };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) { if (Date.now() >= deadline) return false; await wait(5); }
    return true;
  };
  const owned = new Map(), sockets = [], endpoints = [], connections = new Set();
  let holder = null, startupCredential = null, freshCredential = null, coordinator = null, workerFailure = null;
  writeHostConfig(ROOT, { tools: [] });
  writeFileSync(FAKE, `#!${process.execPath}
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')) console.log('2.1.284');
else {
  if(existsSync(${JSON.stringify(GATE)})) {
    writeFileSync(${JSON.stringify(ENTERED)},'entered');
    while(!existsSync(${JSON.stringify(RELEASE)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
  console.log(readFileSync(${JSON.stringify(LIST)},'utf8'));
}
`, { mode: 0o755 });
  writeFileSync(LIST, JSON.stringify(TASKS.map((task, index) => ({ name: `ref-${index}`, id: `native-${index}`, sessionId: `native-${index}`, pid: process.pid, state: 'idle' }))));
  writeFileSync(ENTRY, `import {isMainThread,Worker} from 'node:worker_threads';
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
// Withhold only this owned process-observer delivery; the fixed system executable still runs.
const spawn=childProcess.spawn;
childProcess.spawn=function(command,args,...options){
  const child=spawn.call(this,command,args,...options);
  if(command==='/bin/ps' && args?.length===6 && args[0]==='-p' && /^\\d+$/.test(args[1])
    && JSON.stringify(args.slice(2))===JSON.stringify(['-o','stat=','-o','lstart='])
    && existsSync(${JSON.stringify(PROBE_UNAVAILABLE)})) {
    const emit=child.stdout.emit;
    child.stdout.emit=function(event,...values){ return event==='data' ? true : emit.call(this,event,...values); };
  }
  return child;
};
syncBuiltinESMExports();
import {createStandaloneHost} from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, 'dist/host-index.js')).href)};
import {runPromptobus} from ${JSON.stringify(pathToFileURL(path.join(PACKAGE, 'lib/cli.js')).href)};
if(!isMainThread) throw new Error('consumer entry must not be replayed by the warden worker');
const emit=Worker.prototype.emit;
Worker.prototype.emit=function(event,...args){
  const message=args[0];
  if(event==='message' && message?.kind==='settled' && message.task===${JSON.stringify(EMPTY)}
    && message.result?.kind==='stopped' && message.result.reason==='no live participants remain'
    && existsSync(${JSON.stringify(NATURAL_GATE)})) {
    writeFileSync(${JSON.stringify(NATURAL_HELD)},'old loop actually settled');
    const release=setInterval(()=>{
      if(existsSync(${JSON.stringify(NATURAL_RELEASE)})) {clearInterval(release);emit.call(this,event,...args);}
    },5);
    return true;
  }
  return emit.call(this,event,...args);
};
const make=({cwd,env})=>{
  const host=createStandaloneHost({cwd,binPath:${JSON.stringify(ENTRY)},version:${JSON.stringify(VERSION)}});
  const resolve=host.resolveToolBin;
  host.resolveToolBin=tool=>tool==='claude'?{ok:true,bin:${JSON.stringify(FAKE)}}:resolve(tool);
  const command=host.busCommand, role=env.PROMPTOBUS_ROLE??'startup';
  host.busCommand=args=>{
    appendFileSync(${JSON.stringify(FORMATTED)},JSON.stringify({pid:process.pid,isMainThread,role,args})+'\\n',{mode:0o600});
    return command(args);
  };
  return host;
};
const code=await runPromptobus(process.argv.slice(2),{host:make({cwd:process.cwd(),env:process.env}),createHost:make,cwd:process.cwd(),env:process.env});
if(code) process.exitCode=code;
`);
  const host = createStandaloneHost({ cwd: ROOT, binPath: ENTRY, version: VERSION });
  const resolve = host.resolveToolBin;
  host.resolveToolBin = tool => tool === 'claude' ? { ok: true, bin: FAKE } : resolve(tool);
  const HOME = host.promptobusHome(), options = { cwd: ROOT, env }, paths = servicePaths(host, env);
  const socketPath = makeSockPath('a2s-');
  const received = [];
  const cli = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd: ROOT, env: { ...env, CLAUDE_CODE_SESSION_ID: SESSION }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  let requestId = 0;
  const rpc = async (credential, session, method, params) => {
    const response = await fetch(credential.busUrl, { method: 'POST', headers: {
      authorization: `Bearer ${credential.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: ++requestId }), method, ...(params ? { params } : {}) }) });
    return { status: response.status, session: response.headers.get('mcp-session-id'), text: await response.text() };
  };
  const initialize = async credential => {
    const initialized = await rpc(credential, null, 'initialize', { protocolVersion: '2025-06-18' });
    if (initialized.status === 200) await rpc(credential, initialized.session, 'notifications/initialized');
    return initialized;
  };
  const releaseInspect = () => writeFileSync(RELEASE, 'released');
  try {
    bus(HOME, { cli: VERSION });
    for (const [index, task] of TASKS.entries()) {
      createTask(HOME, { id: task, title: 'owned shared task', owner: SESSION });
      upsertParticipant(HOME, task, participantRecord('worker:fixture', { harness: 'claude', sessionRef: `ref-${index}`, sessionId: `native-${index}` }));
      const server = createServer(socket => {
        connections.add(socket); socket.on('close', () => connections.delete(socket));
        let text = ''; socket.on('data', bytes => { text += bytes; });
        socket.on('end', () => { received.push({ task, text }); socket.destroy(); });
      });
      const endpoint = socketPath(`task-${index}`), listening = await listenTestSocket(server, endpoint);
      if (!listening.ok) throw new Error(listening.reason);
      sockets.push(server); endpoints.push(endpoint);
      writeWake(HOME, task, 'worker:fixture', { socket: endpoint, token: `token-${index}`, session: `native-${index}` });
    }
    startupCredential = await registerServiceClient(host, { cwd: ROOT, env, lifetime: { kind: 'process', process: requireProcess() } }, options);
    let current = (await workspaceServiceStatus(host, options)); owned.set(current.process.pid, current.process);
    await wait(450);
    check('a real startup client retains the owner beyond idle while ordinary CLI demands are still being prepared', processState(current.process) === 'alive'
      && (await workspaceServiceStatus(host, options)).clients === 1);
    const pendingTask = 'pending-native-t20261101-150000', pendingAddress = 'worker:pending', pendingRef = 'not-yet-launched';
    const pendingRecord = path.join(ROOT, 'pending-launch.json');
    const pendingTuple = { home: HOME, task: pendingTask, address: pendingAddress, ref: pendingRef, launchId: 'pending-generation-one' };
    createTask(HOME, { id: pendingTask, title: 'native launch has not run', owner: SESSION });
    upsertParticipant(HOME, pendingTask, participantRecord(pendingAddress, { harness: 'claude', sessionRef: pendingRef,
      sessionRecord: pendingRecord, pending: true }));
    writeFileSync(pendingRecord, JSON.stringify(pendingTuple), { mode: 0o600 });
    const pending = await registerServiceClient(host, { cwd: ROOT,
      env: { ...env, PROMPTOBUS_TASK: pendingTask, PROMPTOBUS_ROLE: pendingAddress },
      nativeBinding: { kind: 'claude', state: 'pending' } }, options);
    writeFileSync(GATE, 'hold the prelaunch observation of an absent session');
    await bindServiceClient(host, pending.clientId, { kind: 'managed', ...pendingTuple, record: pendingRecord }, options);
    const prelaunchView = await workspaceServiceStatus(host, options);
    if (prelaunchView.warden.observations > 0) {
      check('prelaunch observation reaches the owned absent-session barrier', await until(() => existsSync(ENTERED)));
      releaseInspect();
      check('prelaunch observation settles after its owned barrier is released', await until(async () =>
        (await workspaceServiceStatus(host, options)).warden.observations === 0));
    }
    const beforeNative = await workspaceServiceStatus(host, options);
    const pendingBytes = existsSync(pending.credentialFile) ? readFileSync(pending.credentialFile) : null;
    check('an exact pending native launch retains its credential as unknown before the session exists',
      beforeNative.clients === 2 && beforeNative.unknownManaged === 1 && pendingBytes !== null,
      JSON.stringify({ clients: beforeNative.clients, unknownManaged: beforeNative.unknownManaged, credentialRetained: pendingBytes !== null }));
    releaseInspect(); rmSync(GATE, { force: true });
    const originalSessions = readFileSync(LIST);
    writeFileSync(LIST, JSON.stringify([...JSON.parse(originalSessions),
      { name: pendingRef, id: 'pending-native', sessionId: 'pending-native', pid: process.pid, state: 'idle' }]));
    const pendingJournal = readFileSync(path.join(HOME, 'tasks', pendingTask, 'task.json'));
    const pendingConnection = await initialize(pending);
    const pendingTool = await rpc(pending, pendingConnection.session, 'tools/call', { name: 'promptobus_send',
      arguments: { to: 'orchestrator', type: 'status', body: 'must remain undispatched' } });
    check('pending native discovery grants no actor tool authority or journal mutation', pendingConnection.status === 200
      && pendingTool.status === 403 && /pending/.test(pendingTool.text)
      && readFileSync(path.join(HOME, 'tasks', pendingTask, 'task.json')).equals(pendingJournal),
      JSON.stringify({ initializeStatus: pendingConnection.status, toolStatus: pendingTool.status, text: pendingTool.text }));
    writeFileSync(pendingRecord, JSON.stringify({ ...pendingTuple, launchId: 'replacement-generation' }));
    const replacedPending = await workspaceServiceStatus(host, options);
    check('a replaced pending launch still retires its old credential without waiting for a native session',
      replacedPending.clients === 1 && !existsSync(pending.credentialFile));
    if (existsSync(pending.credentialFile)) await revokeServiceClient(host, pending.clientId, options);
    writeFileSync(LIST, originalSessions);
    const raised = await Promise.all(TASKS.map(task => cli(['warden', '--task', task])));
    check('ordinary CLI warden commands demand two task loops without replaying the consumer entry on a Worker', raised.every(result => result.code === 0), raised.map(result => result.stderr).join(' | '));
    check('two active tasks have distinct journal seats and the same physical service PID', await until(() => TASKS.every(task => readWardenMark(HOME, task)?.pid === current.process.pid)));
    await revokeServiceClient(host, startupCredential.clientId, options); startupCredential = null;
    createTask(HOME, { id: EMPTY, title: 'natural no-work exit', owner: SESSION });
    writeFileSync(NATURAL_GATE, 'hold only this owned natural completion event');
    await ensureTaskWarden(host, HOME, EMPTY, options);
    upsertParticipant(HOME, TASKS[1], participantRecord('reviewer:missing', { harness: 'claude', sessionRef: 'missing-ref', sessionId: 'missing-native' }));
    const sent = await Promise.all(TASKS.map(task => cli(['send', 'worker:fixture', '--task', task, '--type', 'task', '--body', `owned mail for ${task}`])));
    check('ordinary CLI sends keep existing shared task demands working', sent.every(result => result.code === 0));
    check('each task receives its own real wake and token', await until(() => received.length === 2)
      && TASKS.every((task, index) => received.some(item => item.task === task && item.text.includes(`"token":"token-${index}"`) && item.text.includes(task))));
    let initialHealth;
    const durableKnocks = await until(() => {
      initialHealth = TASKS.map(task => readHealth(HOME, task)['worker:fixture']);
      return initialHealth.every((health, index) => health?.knocks === 1
        && typeof health.knockedAt === 'string' && health.wakeSession === `native-${index}`);
    });
    check('the crash control observes both actual durable successful knocks before owner death', durableKnocks,
      JSON.stringify({ received: received.length, initialHealth }));
    if (!durableKnocks) throw new Error('owned crash fixture has no durable successful knock baseline');
    const crashed = current, beforeCrash = TASKS.map(task => readWardenGeneration(HOME, task));
    process.kill(crashed.process.pid, 'SIGKILL');
    if (!await until(() => processState(crashed.process) === 'dead')) throw new Error('owned crashed service did not physically exit');
    current = await ensureWorkspaceService(host, options); owned.set(current.process.pid, current.process);
    check('owner preflight recovers both outstanding task demands at the retained endpoint after physical owner death', current.url === crashed.url
      && current.process.pid !== crashed.process.pid && await until(() => TASKS.every((task, index) =>
        readWardenMark(HOME, task)?.pid === current.process.pid && readWardenGeneration(HOME, task) > beforeCrash[index])));
    await wait(450);
    check('active task work alone retains the service beyond idle without any client grant', processState(current.process) === 'alive'
      && (await workspaceServiceStatus(host, options)).clients === 0);
    check('recovered task seats retain the previous successful knock instead of duplicating unread delivery', received.length === 2,
      JSON.stringify({ received: received.map(({ task }) => task), initialHealth,
        recoveredHealth: TASKS.map(task => readHealth(HOME, task)['worker:fixture']) }));
    await abortTaskWarden(host, TASKS[0], options);
    readInbox(HOME, TASKS[1], 'worker:fixture');
    sendMessage(HOME, TASKS[1], { from: 'orchestrator', to: 'worker:fixture', type: 'task', body: 'second independent wake' });
    check('aborting one task leaves the other seat and real delivery alive', !existsSync(path.join(HOME, 'tasks', TASKS[0], 'supervisor.json'))
      && readWardenMark(HOME, TASKS[1])?.pid === current.process.pid && await until(() => received.filter(item => item.task === TASKS[1]).length === 2));

    rmSync(RELEASE, { force: true }); rmSync(ENTERED, { force: true }); writeFileSync(GATE, 'hold inspect');
    await ensureTaskWarden(host, HOME, TASKS[0], options);
    check('the real provider inspect enters its owned blocking fixture', await until(() => existsSync(ENTERED)));
    const previousGeneration = readWardenGeneration(HOME, TASKS[0]);
    holder = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise((resolve, reject) => { holder.once('error', reject); holder.stdout.once('data', resolve); });
    if (!Number.isInteger(holder.pid) || holder.pid <= 1) throw new Error('owned fresh root has no valid PID');
    const freshProcess = requireProcess(holder.pid);
    let progress = null;
    const fresh = (async () => {
      freshCredential = await registerServiceClient(host, { cwd: ROOT, env: { ...env, PROMPTOBUS_TASK: TASKS[1], PROMPTOBUS_ROLE: 'orchestrator', CLAUDE_CODE_SESSION_ID: SESSION },
        lifetime: { kind: 'process', process: freshProcess } }, options);
      const connected = await initialize(freshCredential);
      const ping = await rpc(freshCredential, connected.session, 'ping');
      return { connected, ping, status: await workspaceServiceStatus(host, options) };
    })().then(result => { progress = result; }, error => { progress = { error: error.message }; });
    const responsive = await until(() => progress !== null);
    check('a fresh real root process grant initializes and performs authenticated ping while provider inspect remains blocked', responsive
      && !progress.error && progress.connected.status === 200 && progress.ping.status === 200
      && progress.status.unknownClients === 0 && !existsSync(RELEASE), progress?.error ?? 'root progress waited behind the provider poll');
    const aborted = abortTaskWarden(host, TASKS[0], options);
    check('a pending task abort is visible before inspect has physically settled', await until(async () =>
      (await workspaceServiceStatus(host, options)).warden.tasks.some(item => item.task === TASKS[0] && item.state === 'stopping')));
    const reensured = await ensureTaskWarden(host, HOME, TASKS[0], options);
    check('reensure while a round is pending retains its generation instead of overlapping a successor', reensured.state === 'stopping'
      && readWardenGeneration(HOME, TASKS[0]) === previousGeneration);
    releaseInspect(); await fresh; await aborted;
    check('a successor starts only after old cleanup and its same-PID seat survives', await until(() => readWardenGeneration(HOME, TASKS[0]) > previousGeneration
      && readWardenMark(HOME, TASKS[0])?.pid === current.process.pid) && readWardenMark(HOME, TASKS[1])?.pid === current.process.pid);
    const differentBirth = process.platform === 'darwin'
      ? freshProcess.birth.replace(/:(\d{2}) (\d{4})$/, (_match, seconds, year) => `:${String((Number(seconds) + 1) % 60).padStart(2, '0')} ${year}`)
      : freshProcess.birth.replace(/:(\d+)$/, (_match, ticks) => `:${BigInt(ticks) + 1n}`);
    const wrongBirth = await registerServiceClient(host, { cwd: ROOT, env: { ...env, PROMPTOBUS_TASK: TASKS[1], PROMPTOBUS_ROLE: 'orchestrator', CLAUDE_CODE_SESSION_ID: SESSION },
      lifetime: { kind: 'process', process: { ...freshProcess, birth: differentBirth } } }, options)
      .then(() => null, error => error.message);
    check('the fresh process path verifies OS birth rather than treating an existing PID as its proof', /expired or replaced/.test(wrongBirth ?? ''), wrongBirth ?? 'incorrect birth was admitted');
    if (process.platform === 'darwin') {
      writeFileSync(PROBE_UNAVAILABLE, 'owned observer cannot provide birth');
      const unavailable = await registerServiceClient(host, { cwd: ROOT,
        env: { ...env, PROMPTOBUS_TASK: TASKS[1], PROMPTOBUS_ROLE: 'orchestrator', CLAUDE_CODE_SESSION_ID: SESSION },
        lifetime: { kind: 'process', process: freshProcess } }, options).then(() => null, error => error.message);
      const denied = await initialize(freshCredential), retained = await workspaceServiceStatus(host, options);
      check('unavailable OS birth refuses root admission and requests while retaining the existing unknown client', /birth identity is unavailable/.test(unavailable ?? '')
        && denied.status === 401 && retained.clients === 1 && retained.unknownClients === 1 && existsSync(freshCredential.credentialFile),
      JSON.stringify({ unavailable, denied, retained, credentialRetained: existsSync(freshCredential.credentialFile) }));
      rmSync(PROBE_UNAVAILABLE);
      check('restored OS birth proof returns the same root credential to service without identity replacement', (await initialize(freshCredential)).status === 200);
    }

    createTask(HOME, { id: CONTACT, title: 'late owned contact', owner: SESSION });
    const contactRecord = path.join(ROOT, 'contact-launch.json'), contactSession = 'owned-contact-native';
    writeFileSync(contactRecord, JSON.stringify({ home: HOME, task: CONTACT, address: 'worker:contact', launchId: 'contact-generation-one' }));
    upsertParticipant(HOME, CONTACT, participantRecord('worker:contact', { harness: 'claude', sessionRef: 'contact-ref', sessionId: contactSession, sessionRecord: contactRecord }));
    writeWake(HOME, CONTACT, 'worker:contact', { socket: socketPath('fresh-contact'), token: 'owned-contact-token', session: contactSession });
    const contactFile = wakeFile(HOME, CONTACT, 'worker:contact'), contactBytes = readFileSync(contactFile);
    const contact = REGISTRY.drivers.claude.registerWake;
    for (const [name, candidate] of [['no socket', { CLAUDE_CODE_SESSION_ID: contactSession }],
      ['same socket without token', { CLAUDE_CODE_SESSION_ID: contactSession, CLAUDE_CODE_MESSAGING_SOCKET: readWake(HOME, CONTACT, 'worker:contact').socket }],
      ['different socket without token', { CLAUDE_CODE_SESSION_ID: contactSession, CLAUDE_CODE_MESSAGING_SOCKET: socketPath('incomplete-new-contact') }]]) {
      contact(HOME, CONTACT, 'worker:contact', candidate);
      check(`a Claude handover with ${name} preserves the known pair without copying its secret`, readFileSync(contactFile).equals(contactBytes));
    }
    const foreign = contact(HOME, CONTACT, 'worker:contact', { CLAUDE_CODE_SESSION_ID: 'foreign-native', CLAUDE_CODE_MESSAGING_SOCKET: socketPath('foreign-contact'), CLAUDE_CODE_MESSAGING_TOKEN: 'foreign-token' });
    check('a foreign session cannot replace or borrow the owned contact pair', foreign === false && readFileSync(contactFile).equals(contactBytes));
    const contactCredential = await registerServiceClient(host, { cwd: ROOT, env: { ...env, PROMPTOBUS_TASK: CONTACT, PROMPTOBUS_ROLE: 'worker:contact', CLAUDE_CODE_SESSION_ID: contactSession,
      CLAUDE_CODE_MESSAGING_SOCKET: socketPath('stale-contact'), CLAUDE_CODE_MESSAGING_TOKEN: 'stale-token' },
    lifetime: { kind: 'managed', task: CONTACT, address: 'worker:contact', ref: 'contact-ref', record: contactRecord, launchId: 'contact-generation-one' } }, options);
    writeFileSync(contactRecord, JSON.stringify({ home: HOME, task: CONTACT, address: 'worker:contact', launchId: 'contact-generation-two' }));
    const oldContact = await initialize(contactCredential);
    check('a replaced launch generation is denied before a stale contact pair can cross the actor boundary', oldContact.status === 401 && readFileSync(contactFile).equals(contactBytes));
    const retiredContact = await workspaceServiceStatus(host, options);
    check('a replaced launch grant retires while the independent root client stays usable', retiredContact.clients === 1
      && !existsSync(contactCredential.credentialFile) && (await initialize(freshCredential)).status === 200,
    JSON.stringify({ retiredContact, contactRetained: existsSync(contactCredential.credentialFile), rootRetained: existsSync(freshCredential.credentialFile) }));

    check('the existing heartbeat naturally ends a no-work loop before main handles its settled event', await until(() => existsSync(NATURAL_HELD)
      && readWardenExit(HOME, EMPTY)?.reason === 'no live participants remain' && readWardenMark(HOME, EMPTY) === null, (WARDEN_BEAT_SEC + 5) * 1000));
    const naturalGeneration = readWardenGeneration(HOME, EMPTY);
    upsertParticipant(HOME, EMPTY, participantRecord('worker:fixture', { harness: 'claude', sessionRef: 'ref-0', sessionId: 'native-0' }));
    writeWake(HOME, EMPTY, 'worker:fixture', { socket: endpoints[0], token: 'natural-successor-token', session: 'native-0' });
    const naturalMessage = await cli(['send', 'worker:fixture', '--task', EMPTY, '--type', 'task', '--body', 'new work after old natural cleanup']);
    const naturalDemands = await Promise.all([ensureTaskWarden(host, HOME, EMPTY, options), ensureTaskWarden(host, HOME, EMPTY, options)]);
    check('new work and demand accepted during delayed natural completion stay durable without stealing the cleared seat', naturalMessage.code === 0
      && naturalDemands.every(demand => demand.state === 'running') && readWardenMark(HOME, EMPTY) === null
      && JSON.parse(readFileSync(path.join(paths.directory, 'warden-demand.json'), 'utf8')).tasks[EMPTY].required === true);
    rmSync(NATURAL_GATE); writeFileSync(NATURAL_RELEASE, 'main may accept old completion');
    check('natural completion starts exactly one successor for the later demand and wakes its new mail once', await until(() =>
      readWardenGeneration(HOME, EMPTY) > naturalGeneration && readWardenMark(HOME, EMPTY)?.pid === current.process.pid
      && received.filter(item => item.text.includes(EMPTY)).length === 1)
      && readWardenGeneration(HOME, EMPTY) === naturalGeneration + 1
      && (await workspaceServiceStatus(host, options)).warden.tasks.some(item => item.task === EMPTY && item.state === 'running'));
    check('task stall formatting uses the original main-thread owner Host closure', await until(() => existsSync(FORMATTED)
      && readFileSync(FORMATTED, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).some(item =>
        item.pid === current.process.pid && item.isMainThread && item.role === 'startup' && item.args[0] === 'review')));

    await revokeServiceClient(host, freshCredential.clientId, options); freshCredential = null;
    const holderDone = new Promise(resolve => holder.once('close', resolve)); holder.stdin.end(); await holderDone; holder = null;
    await Promise.all([...TASKS, EMPTY].map(task => abortTaskWarden(host, task, options)));
    check('no clients and no task work permit physical service idle exit', await until(() => processState(current.process) === 'dead'));
    current = await ensureWorkspaceService(host, options); owned.set(current.process.pid, current.process);
    const recovered = await workspaceServiceStatus(host, options);
    check('preflight does not restart completed empty task demands merely because their journals are still active', recovered.warden.tasks.length === 0 && recovered.clients === 0);
    await stopWorkspaceService(host, options);
    check('all owned physical service generations exited', [...owned.values()].every(identity => processState(identity) === 'dead'));

    coordinator = new ServiceWarden(paths, host, serviceHarnessContext(host, env, REGISTRY), env, error => { workerFailure = error; });
    await coordinator.ready;
    rmSync(RELEASE, { force: true }); rmSync(ENTERED, { force: true });
    coordinator.ensure(TASKS[0]);
    check('the isolated observation race reaches the same owned inspect barrier', await until(() => existsSync(ENTERED)));
    const nativeFile = codexSessionFile('stable-race-ref', { ...env, PROMPTOBUS_CODEX_HOME: host.harnessStateHome('codex') });
    mkdirSync(path.dirname(nativeFile), { recursive: true });
    const nativeBytes = JSON.stringify({ ref: 'stable-race-ref', home: HOME, task: TASKS[1], address: 'worker:race', launchId: 'stable-race-generation', threadId: 'stable-race-native', holderPid: process.pid, state: 'idle' });
    writeFileSync(nativeFile, nativeBytes);
    const participant = participantRecord('worker:race', { harness: 'codex', sessionRef: 'stable-race-ref', sessionId: 'stable-race-native', sessionRecord: nativeFile });
    const revision = recordVersion(nativeFile), pendingView = coordinator.observe([participant], [revision]);
    writeFileSync(nativeFile, '{}'); writeFileSync(nativeFile, nativeBytes);
    check('restoring identical record bytes still changes its observation revision', recordVersion(nativeFile).version !== revision.version);
    releaseInspect();
    check('a snapshot queued before corrupt-and-restore stays unknown rather than publishing a stale death or identity', await pendingView === null && workerFailure === null);
    const freshView = await coordinator.observe([participant], [recordVersion(nativeFile)]);
    check('a fresh stable observation sees the live owned holder without creating a new launch proof', participantSession(participant, freshView) === 'alive'
      && JSON.parse(readFileSync(nativeFile, 'utf8')).launchId === 'stable-race-generation');
    await coordinator.abort(TASKS[0]); await coordinator.close(); coordinator = null;
  } finally {
    releaseInspect();
    writeFileSync(NATURAL_RELEASE, 'release owned natural completion during cleanup');
    if (coordinator) await coordinator.close();
    if (startupCredential) { try { await revokeServiceClient(host, startupCredential.clientId, options); } catch {} }
    if (freshCredential) { try { await revokeServiceClient(host, freshCredential.clientId, options); } catch {} }
    if (holder && Number.isInteger(holder.pid) && holder.pid > 1) { const done = new Promise(resolve => holder.once('close', resolve)); holder.stdin.end(); await done; }
    for (const identity of owned.values()) if (processState(identity) !== 'dead') { try { process.kill(identity.pid, 'SIGTERM'); } catch {} }
    for (const socket of connections) socket.destroy();
    await Promise.all(sockets.map(server => new Promise(resolve => server.close(resolve))));
    await until(() => [...owned.values()].every(identity => processState(identity) === 'dead'));
    rmSync(PRIVATE, { recursive: true, force: true });
  }
}

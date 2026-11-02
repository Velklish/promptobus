import { check, skip } from './check.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createStandaloneHost } from '../dist/host-index.js';
import { runWorkspaceService } from '../lib/service.js';
import { ensureTaskWarden, abortTaskWarden, registerServiceClient, revokeServiceClient, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { processState, readDiscovery, recordVersion, requireProcess, servicePaths } from '../lib/service-state.js';
import { bus, createTask, participantOf, participantRecord, readTask, strictTaskFacts, upsertParticipant } from '../lib/store.js';
import { publishCodexNativeAdmission, readSession, sessionFile, writeSession } from '../lib/codex-session.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('managed HTTP operation authority', 'This platform has no process-birth observer');
} else {
  const root = realpathSync(makeSandbox('promptobus-service-operation-'));
  const privateHome = mkdtempSync(path.join(realpathSync('/tmp'), 'pbsvc-'));
  const home = path.join(root, '.promptobus'), binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const fake = path.join(root, 'claude.mjs'), entered = path.join(root, 'inspect-entered'), release = path.join(root, 'inspect-release');
  const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: privateHome, PROMPTOBUS_HOME: home,
    PROMPTOBUS_SERVICE_IDLE_MS: '60000', PROMPTOBUS_WARDEN: 'off' };
  const options = { cwd: root, env }, clients = [], holders = [], holderIdentities = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!await predicate()) { if (Date.now() >= deadline) throw new Error('Owned operation fixture barrier timed out'); await wait(5); }
  };
  writeHostConfig(root, { tools: [] });
  writeFileSync(fake, `#!${process.execPath}
import {existsSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')) console.log('2.1.284');
else {writeFileSync(${JSON.stringify(entered)},'actual Worker provider inspect');
while(!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
console.log('[]');}
`, { mode: 0o755 });
  const make = ({ cwd }) => {
    const host = createStandaloneHost({ cwd, binPath, version }), resolve = host.resolveToolBin;
    host.resolveToolBin = tool => tool === 'claude' ? { ok: true, bin: fake } : resolve(tool);
    return host;
  };
  const host = make({ cwd: root }), paths = servicePaths(host, env);
  const codexEnv = { ...env, PROMPTOBUS_CODEX_HOME: host.harnessStateHome('codex') };
  let sequence = 0, replyGate = null, serviceError;
  const emit = Worker.prototype.emit, postMessage = Worker.prototype.postMessage, observing = new Map();
  Worker.prototype.postMessage = function(message, ...args) {
    if (message?.kind === 'observe') observing.set(message.id, JSON.stringify(message.participants));
    return postMessage.call(this, message, ...args);
  };
  // The service tick observes managed grants too, so a gate holds every reply until its request settles.
  Worker.prototype.emit = function(event, ...args) {
    const gate = replyGate;
    if (gate && event === 'message' && args[0]?.kind === 'observed') {
      gate.held.push(observing.get(args[0].id) ?? '');
      gate.promise.then(() => emit.call(this, event, gate.fail
        ? { ...args[0], snapshot: null, error: 'owned observation delivery refused' } : args[0]));
      return true;
    }
    return emit.call(this, event, ...args);
  };
  const holdReply = fail => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return replyGate = { promise, release, fail, held: [] };
  };
  const rpc = async (actor, method, params = {}, id = ++sequence) => {
    const response = await fetch(actor.credential.busUrl, { method: 'POST', headers: {
      authorization: `Bearer ${actor.credential.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(actor.session ? { 'mcp-session-id': actor.session, 'mcp-protocol-version': '2025-06-18' } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }) });
    return { status: response.status, session: response.headers.get('mcp-session-id'), text: await response.text() };
  };
  const question = (actor, body, id) => rpc(actor, 'tools/call', { name: 'promptobus_ask', arguments: { body }, _meta: { threadId: actor.thread } }, id);
  const gatedQuestion = async (actor, fail, body, id) => {
    const gate = holdReply(fail), own = () => gate.held.filter(participants => participants.includes(JSON.stringify(actor.ref))).length;
    writeFileSync(actor.record, readFileSync(actor.record));
    await workspaceServiceStatus(host, options);
    await until(() => own() > 0);
    let settled = false;
    const request = question(actor, body, id);
    request.then(() => { settled = true; }, () => { settled = true; });
    await until(() => own() > 1 || settled);
    return { gate, request };
  };
  const questions = actor => strictTaskFacts(home, actor.task).messages.filter(message => message.type === 'question').length;
  const receipt = (actor, id) => path.join(paths.requests, actor.session, `${createHash('sha256').update(JSON.stringify(id)).digest('hex')}.json`);
  const journal = directory => readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name !== '.lock').sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? journal(path.join(directory, entry.name)).map(([file, hash]) => [path.join(entry.name, file), hash])
      : [[entry.name, createHash('sha256').update(readFileSync(path.join(directory, entry.name))).digest('hex')]]);
  const actor = async (label, address = 'reporter') => {
    const task = `authority-${label}-t20261101-000000`, ref = `owned-${label}`, thread = `native-${label}`;
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'ignore'] });
    holders.push(child);
    await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
    const identity = requireProcess(child.pid); holderIdentities.push(identity);
    const record = sessionFile(ref, codexEnv);
    const nativeStore = path.join(root, `native-store-${label}`); mkdirSync(nativeStore);
    // The live owned app models a correlated API publication; the separately owned holder is retired below.
    const app = spawn(process.execPath, ['-e', "const {createInterface}=require('node:readline');\ncreateInterface({input:process.stdin}).once('line',line=>{\n  const request=JSON.parse(line);\n  if(request.id!==1||request.method!=='thread/start') throw new Error('Unexpected owned unit API request');\n  process.stdout.write(JSON.stringify({id:request.id,result:{thread:{id:process.argv[1]}}})+'\\n');\n});", thread], {
      env: { ...process.env, CODEX_HOME: nativeStore }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    holders.push(app);
    const reply = new Promise((resolve, reject) => { app.once('error', reject); app.stdout.once('data', bytes => resolve(JSON.parse(String(bytes)))); });
    app.stdin.write(`${JSON.stringify({ id: 1, method: 'thread/start', params: {} })}\n`);
    const started = await reply;
    if (started.id !== 1 || started.result?.thread?.id !== thread) throw new Error('Owned unit thread/start response did not correlate');
    const appProcess = requireProcess(app.pid); holderIdentities.push(appProcess);
    writeSession({ ref, home, task, address, role: address, launchId: `launch-${label}`, threadId: thread,
      holderPid: child.pid, holderProcess: identity, appPid: app.pid, appProcess, nativeAdmissionSchema: 1,
      codexHome: nativeStore, state: 'idle' }, codexEnv);
    publishCodexNativeAdmission(ref, { version: recordVersion(record), launchId: `launch-${label}`,
      home, task, address, nativeStore, nativeId: thread, process: appProcess, method: 'thread/start' }, codexEnv);
    const value = readSession(ref, codexEnv);
    const owner = address === 'orchestrator' ? 'previous-owned-session' : thread;
    createTask(home, { id: task, title: 'owned operation admission', owner });
    upsertParticipant(home, task, participantRecord(address, { harness: 'codex', sessionRef: ref, sessionId: thread, sessionRecord: record, nativeLaunchId: value.launchId,
      ...(address === 'orchestrator' ? { owner } : {}) }));
    const credential = await registerServiceClient(host, { cwd: root,
      env: { ...codexEnv, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: address },
      nativeBinding: { kind: 'codex', state: 'bound', threadId: thread },
      lifetime: { kind: 'managed', task, address, ref, record, launchId: value.launchId } }, options);
    clients.push(credential);
    const result = { task, ref, record, value, child, identity, credential, thread, session: null };
    const initialized = await rpc(result, 'initialize', { protocolVersion: '2025-06-18' });
    result.session = initialized.session;
    if (initialized.status !== 200 || !result.session) throw new Error(`Owned actor initialization refused: ${initialized.text}`);
    const completed = await rpc(result, 'notifications/initialized', {}, null);
    if (completed.status !== 202) throw new Error(`Owned actor initialization incomplete: ${completed.text}`);
    return result;
  };
  const retire = async actor => {
    const closed = new Promise(resolve => actor.child.once('close', resolve)); actor.child.stdin.end(); await closed;
    if (processState(actor.identity) !== 'dead') throw new Error('Owned holder exit was not observed');
  };
  const service = runWorkspaceService({ host, createHost: make, env }).catch(error => { serviceError = error; });
  const busyTask = 'authority-busy-t20261101-000000';
  try {
    await until(() => readDiscovery(paths) !== null || serviceError);
    if (serviceError) throw serviceError;
    bus(home, { cli: version });
    const unchanged = await actor('unchanged'), deadRecord = await actor('record-dead');
    for (const current of [unchanged, deadRecord]) {
      const positiveId = ++sequence, positive = await question(current, 'owned positive before holder death', positiveId);
      current.savedReceipt = { file: receipt(current, positiveId), bytes: readFileSync(receipt(current, positiveId)) };
      check('a fresh alive managed holder can publish a real question', positive.status === 200 && !JSON.parse(positive.text).result?.isError && questions(current) === 1, positive.text);
    }
    await until(async () => (await workspaceServiceStatus(host, options)).unknownManaged === 0);
    createTask(home, { id: busyTask, title: 'actual occupied Worker', owner: 'fixture-owner' });
    upsertParticipant(home, busyTask, participantRecord('worker:busy', { harness: 'claude', sessionRef: 'busy-ref', sessionId: 'busy-native' }));
    await ensureTaskWarden(host, home, busyTask, options);
    await until(() => existsSync(entered));
    const stableRevision = recordVersion(unchanged.record);
    await retire(unchanged); await retire(deadRecord);
    writeFileSync(deadRecord.record, JSON.stringify({ ...deadRecord.value, state: 'dead' }));
    const journals = [unchanged, deadRecord].map(current => JSON.stringify(journal(path.join(home, 'tasks', current.task))));
    let results = null;
    const ids = [++sequence, ++sequence];
    const pending = Promise.all([question(unchanged, 'must not publish after unchanged-record death', ids[0]),
      question(deadRecord, 'must not publish after recorded death', ids[1])]).then(value => { results = value; });
    await wait(100);
    const retained = await workspaceServiceStatus(host, options);
    check('busy actual Worker plus dead holders withholds both mutations before native observation', results === null
      && questions(unchanged) === 1 && questions(deadRecord) === 1 && !existsSync(receipt(unchanged, ids[0])) && !existsSync(receipt(deadRecord, ids[1]))
      && [unchanged, deadRecord].every((current, index) => JSON.stringify(journal(path.join(home, 'tasks', current.task))) === journals[index])
      && recordVersion(unchanged.record).version === stableRevision.version,
    JSON.stringify({ results, questions: [questions(unchanged), questions(deadRecord)], stableRevision }));
    check('pending unknown retains both credentials and their previous committed request receipts', retained.clients >= 2
      && [unchanged, deadRecord].every(current => existsSync(current.credential.credentialFile)
        && readFileSync(current.savedReceipt.file).equals(current.savedReceipt.bytes)));
    writeFileSync(release, 'release actual provider'); await pending;
    check('fresh dead native observations refuse both requests without writing their request receipts', results.every(result => result.status === 401)
      && questions(unchanged) === 1 && questions(deadRecord) === 1
      && !existsSync(receipt(unchanged, ids[0])) && !existsSync(receipt(deadRecord, ids[1])), JSON.stringify(results));
    await abortTaskWarden(host, busyTask, options);

    const current = await actor('revision');
    const driftId = ++sequence, drift = await gatedQuestion(current, false, 'must not cross record revision', driftId);
    const bytes = readFileSync(current.record); writeFileSync(current.record, bytes);
    drift.gate.release();
    const drifted = await drift.request; replyGate = null;
    check('an actual observation result for a prior record revision cannot create a receipt or journal question', drifted.status === 409
      && questions(current) === 0 && !existsSync(receipt(current, driftId)), drifted.text);
    const unknownId = ++sequence, unknown = await gatedQuestion(current, true, 'must not cross unknown observation', unknownId);
    unknown.gate.release();
    const refused = await unknown.request; replyGate = null;
    check('controlled observation delivery failure refuses mutation and retains recovery credential/session', refused.status === 503
      && questions(current) === 0 && !existsSync(receipt(current, unknownId)) && existsSync(current.credential.credentialFile)
      && existsSync(path.join(paths.sessions, `${current.session}.json`)), refused.text);

    const ownLock = path.join(home, 'tasks', current.task, '.lock');
    mkdirSync(ownLock); writeFileSync(path.join(ownLock, 'owner'), JSON.stringify({ pid: process.pid, nonce: 'fixture-contention' }));
    const busyId = ++sequence, contended = await question(current, 'no effects before own task lock', busyId);
    rmSync(ownLock, { recursive: true });
    check('contention before dispatch leaves no started receipt and no reporter side effect', contended.status === 503
      && !existsSync(receipt(current, busyId)) && !participantOf(readTask(home, current.task), 'user') && questions(current) === 0, contended.text);
    const orderLock = path.join(home, '.message-order-lock');
    mkdirSync(orderLock); writeFileSync(path.join(orderLock, 'owner'), JSON.stringify({ pid: process.pid, nonce: 'fixture-late-contention' }));
    const partialId = ++sequence, partial = await question(current, 'late contention after user registration', partialId);
    const saved = existsSync(receipt(current, partialId)) ? JSON.parse(readFileSync(receipt(current, partialId), 'utf8')) : null;
    rmSync(orderLock, { recursive: true });
    check('later target contention preserves the possible-effect receipt and the already registered user', partial.status === 200
      && JSON.parse(partial.text).result?.isError === true && saved?.state === 'completed'
      && participantOf(readTask(home, current.task), 'user') && questions(current) === 0, JSON.stringify({ partial, saved }));
    const replay = await question(current, 'late contention after user registration', partialId);
    check('retrying a saved partial outcome does not silently replay the tool after contention ends', replay.text === partial.text && questions(current) === 0, replay.text);
    const recovered = await question(current, 'explicit new request after owner inspection');
    check('fresh proof permits an explicit new request after contention resolution', recovered.status === 200
      && !JSON.parse(recovered.text).result?.isError && questions(current) === 1, recovered.text);

    const owner = await actor('claim', 'orchestrator');
    const claim = await rpc(owner, 'tools/call', { name: 'promptobus_mailbox', arguments: { claim: true }, _meta: { threadId: owner.thread } });
    const next = await rpc(owner, 'tools/call', { name: 'promptobus_task', arguments: {}, _meta: { threadId: owner.thread } });
    check('an admitted own-mailbox claim and its subsequent request retain ordinary binding behavior', claim.status === 200
      && !JSON.parse(claim.text).result?.isError && next.status === 200 && !JSON.parse(next.text).result?.isError, JSON.stringify({ claim, next }));
  } finally {
    replyGate?.release(); replyGate = null; Worker.prototype.emit = emit; Worker.prototype.postMessage = postMessage;
    writeFileSync(release, 'fixture cleanup release');
    await abortTaskWarden(host, busyTask, options).catch(() => {});
    for (const credential of clients) await revokeServiceClient(host, credential.clientId, options).catch(() => {});
    await stopWorkspaceService(host, options).catch(() => {});
    await service;
    for (const child of holders) if (child.exitCode === null) child.stdin.end();
    await until(() => holderIdentities.every(identity => processState(identity) === 'dead'));
    check('all fixture native holders exit and the owner lock is released', holderIdentities.every(identity => processState(identity) === 'dead')
      && !existsSync(paths.lock) && !serviceError, serviceError?.message);
    rmSync(privateHome, { recursive: true, force: true });
  }
}

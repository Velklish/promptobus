import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv from 'ajv';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { dropSession, holderAsk, holderLogFile, pidAlive, readSession, sessionFile, waitReady, writeSession } from '../lib/codex-session.js';
import { codexDriver, MIN_CODEX_VERSION, PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';
import { readStopConfirmation } from '../lib/codex-command-receipts.js';
import { requireNativeTerminal } from '../lib/native-lifecycle.js';

const root = makeSandbox('promptobus-codex-');
const binDir = path.join(root, 'bin');
mkdirSync(binDir);
const fsyncRefusal = path.join(root, 'fsync-refusal.mjs');
writeFileSync(fsyncRefusal, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const fsync = fs.fsyncSync;
fs.fsyncSync = fd => {
  const record = JSON.parse(fs.readFileSync(process.env.FIXTURE_SESSION_FILE, 'utf8'));
  if (fs.existsSync(process.env.FIXTURE_FSYNC_SWITCH)
    && fs.fstatSync(fd).ino === fs.statSync(process.env.FIXTURE_SESSION_FILE).ino
    && record.failedStopCleanup?.appClosed === (process.env.FIXTURE_FSYNC_REFUSAL === 'closed'))
    throw Object.assign(new Error('fixture record fsync refused'), { code: 'EIO' });
  return fsync(fd);
};
syncBuiltinESMExports();
`);
const schemaChecks = [...new Set([MIN_CODEX_VERSION, PROVEN_CODEX_VERSION])].map(version => {
  const ajv = new Ajv();
  return ajv.compile(JSON.parse(readFileSync(path.resolve('test/fixtures/codex-app-server', version, 'v2/TurnInterruptParams.json'))));
});
stubCommand(binDir, 'codex', `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const emit = msg => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...msg})+'\\n');
const reply = (id,result) => emit({id,result});
const batch = msgs => process.stdout.write(msgs.map(msg=>JSON.stringify({jsonrpc:'2.0',...msg})+'\\n').join(''));
const pending = new Map();
let first = true;
let interrupt = 'ok';
const thread = {id:'thread',sessionId:'thread',cliVersion:'0.160.0',createdAt:0,updatedAt:0,
  cwd:process.cwd(),ephemeral:false,modelProvider:'openai',preview:'',projectId:null,source:'appServer',status:{type:'idle'},turns:[]};
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg = JSON.parse(line); const {id,method,params={}}=msg;
  appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify(msg)+'\\n');
  if(method==='initialize') { reply(id,{userAgent:'fixture',codexHome:process.cwd(),platformOs:'macos',platformFamily:'unix'});
    emit({method:'account/rateLimits/updated',params:{primary:{usedPercent:0}}}); }
  else if(method==='thread/start') batch([
    {id,result:{thread,cwd:process.cwd(),model:'gpt-6-astra',modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly'}}},
    {method:'hook/started',params:{threadId:'thread',run:{eventName:'sessionStart',status:'running',sourcePath:'/hooks.json'}}},
    {method:'hook/completed',params:{threadId:'thread',run:{eventName:'sessionStart',status:'completed',sourcePath:'/hooks.json'}}}
  ]);
  else if(method==='thread/name/set') reply(id,{});
  else if(method==='turn/start') {
    if(first) { first=false; reply(id,{turn:{id:'A',status:'inProgress',items:[]}}); emit({method:'turn/started',params:{id:'A'}}); }
    else if(params.input[0].text==='error') emit({id,error:{code:-32000,message:'fixture request rejected'}});
    else if(params.input[0].text==='no-id') reply(id,{});
    else pending.set(params.input[0].text,id);
  }
  else if(method==='fixture/control') {
    interrupt=params.interrupt ?? interrupt;
    for(const event of params.events??[]) emit({method:event.method,params:event.params??{id:event.id,status:event.status??'completed'}});
    for(const request of params.requests??[]) emit(request);
    for(const turn of params.release??[]) { reply(pending.get(turn),{turn:{id:turn,status:'inProgress',items:[]}}); pending.delete(turn); }
    reply(id,{});
    if(params.endOutput) setTimeout(()=>process.stdout.end(params.partial??''),10);
  }
  else if(method==='fixture/hang') {}
  else if(method==='thread/backgroundTerminals/terminate') reply(id,{terminated:true});
  else if(method==='thread/backgroundTerminals/list') reply(id,{terminals:[]});
  else if(method==='turn/interrupt') {
    if(interrupt==='error') emit({id,error:{code:-32000,message:'fixture interrupt rejected'}});
    else if(interrupt!=='hang') { reply(id,{}); if(interrupt!=='ack') emit({method:'turn/completed',params:{id:params.turnId,status:'interrupted'}}); }
  }
}
`);

async function scenario(name, work, { expected, hanging = false, unresolved = false, failedCleanup = false, failRecordFsync = null, budget = 5000, after, driver = false, receiptBlocked = false, rawTools = false, rawResume = false } = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir);
  if (receiptBlocked) writeFileSync(path.join(dir, 'receipts'), 'not a directory');
  const trace = path.join(dir, 'requests.jsonl');
  const env = { ...process.env, PROMPTOBUS_CODEX_HOME: dir, PROMPTOBUS_CODEX_LIMIT_MS: '20', FIXTURE_TRACE: trace };
  const codexHome = path.join(dir, 'private-home');
  if (rawTools) {
    mkdirSync(codexHome);
    env.CODEX_HOME = codexHome;
    env.PROMPTOBUS_CODEX_RAW_TOOL_RECEIPTS = '1';
    for (const key of ['CODEX_EXEC_SERVER_URL', 'CODEX_EXEC_SERVER_NOISE_REGISTRY_URL',
      'CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID', 'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN',
      'CODEX_EXEC_SERVER_NOISE_CHATGPT_ACCOUNT_ID']) delete env[key];
  }
  const ref = name;
  if (failRecordFsync) {
    Object.assign(env, { NODE_OPTIONS: `--import=${pathToFileURL(fsyncRefusal).href}`,
      FIXTURE_SESSION_FILE: sessionFile(ref, env), FIXTURE_FSYNC_REFUSAL: failRecordFsync,
      FIXTURE_FSYNC_SWITCH: path.join(dir, 'fsync-blocked') });
    writeFileSync(env.FIXTURE_FSYNC_SWITCH, 'fixture refusal');
  }
  writeSession({ ref, launchId: 'launch-' + name, bin: path.join(binDir, 'codex'), cwd: dir, role: 'worker', state: 'starting',
    ...(rawTools ? { codexHome } : {}),
    ...(rawResume ? { resumeThreadId: 'existing-thread' } : {}),
    sandbox: 'read-only', approvalPolicy: 'on-request', prompt: 'First', addDirs: [], model: null }, env);
  const holder = spawn(process.execPath, [path.resolve('lib/codex-hold.js'), sessionFile(ref, env)], { env, stdio: 'ignore' });
  const exited = new Promise(resolve => holder.once('exit', resolve));
  const messages = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const rpc = (method, params, timeoutMs = 3000) => holderAsk(ref, 'rpc', { method, params, timeoutMs }, env, timeoutMs + 1000);
  const control = params => rpc('fixture/control', params);
  const start = (id, timeoutMs = 3000) => rpc('turn/start', { threadId: 'thread', input: [{ type: 'text', text: id }] }, timeoutMs);
  const accepted = async id => {
    const answer = start(id);
    await waitFor(() => messages().some(m => m.method === 'turn/start' && m.params.input[0].text === id), { timeoutMs: 3000 });
    await control({ release: [id] });
    return answer;
  };
  let ack;
  let duration;
  let held;
  const shutdown = async () => {
    const before = Date.now();
    if (driver) {
      const previous = process.env.PROMPTOBUS_CODEX_HOME;
      process.env.PROMPTOBUS_CODEX_HOME = dir;
      try { ack = await codexDriver.stop(ref, { timeoutMs: budget }); }
      finally {
        if (previous === undefined) delete process.env.PROMPTOBUS_CODEX_HOME;
        else process.env.PROMPTOBUS_CODEX_HOME = previous;
      }
    } else ack = await holderAsk(ref, 'shutdown', { launchId: 'launch-' + name, deadlineAt: before + budget }, env, budget + 1500);
    duration = Date.now() - before;
    return ack;
  };
  try {
    const ready = await waitReady(ref, env, 5000);
    if (rawResume) {
      check('shutdown raw capture: resume refuses before thread/model dispatch',
        !ready.ok && /fresh native thread/.test(ready.error)
          && !messages().some(m => ['thread/resume', 'turn/start'].includes(m.method)), JSON.stringify(ready));
      return;
    }
    if (receiptBlocked) {
      check('shutdown initial persistence refusal: no model turn is dispatched',
        !ready.ok && /receipt creation failed/.test(ready.error) && !messages().some(m => m.method === 'turn/start'), JSON.stringify(ready));
      return;
    }
    check(`shutdown ${name}: actual holder started`, ready.ok, JSON.stringify(ready));
    if (!ready.ok) return;
    held = readSession(ref, env);
    if (rawTools) check(`shutdown ${name}: fresh thread opts into experimental raw events`,
      messages().find(m => m.method === 'thread/start')?.params.experimentalRawEvents === true);
    if (name === 'completed-A-reserved-B') {
      const log = readFileSync(holderLogFile(ref, env), 'utf8');
      check('holder thread/start: same-chunk hook notifications survive thread identity establishment',
        log.includes('event hook/started sessionStart running /hooks.json')
          && log.includes('event hook/completed sessionStart completed /hooks.json'), log);
    }
    const status = () => holderAsk(ref, 'status', {}, env);
    await work({ start, accepted, control, rpc, messages, shutdown, status, ref, env, holder });
    const originalFailedReceipt = failedCleanup ? readFileSync(readSession(ref, env).commandReceiptFile, 'utf8') : null;
    if (!ack) await shutdown();
    check(`shutdown ${name}: unresolved interrupt cannot report successful Stop`,
      ack.ok === !unresolved, JSON.stringify(ack));
    const interrupts = messages().filter(m => m.method === 'turn/interrupt');
    check(`shutdown ${name}: targets only the known active IDs`,
      JSON.stringify(interrupts.map(m => m.params.turnId).sort()) === JSON.stringify([...expected].sort()), JSON.stringify(interrupts));
    check(`shutdown ${name}: each interrupt matches both native schemas`,
      interrupts.every(m => schemaChecks.every(validate => validate(m.params))), JSON.stringify(interrupts));
    const record = readSession(ref, env) ?? held;
    const receiptFile = record.commandReceiptFile;
    const receipts = (() => { try { return readFileSync(receiptFile, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } })();
    if (failedCleanup) {
      const closed = await waitFor(() => !pidAlive(holder.pid) && !pidAlive(record.appPid), { timeoutMs: 1500, stepMs: 20 });
      const retained = readSession(ref, env);
      check(`shutdown ${name}: failed audit releases the owned idle app and holder`,
        closed && holder.exitCode === 1 && holder.signalCode === null, JSON.stringify(ack));
      check(`shutdown ${name}: failed cleanup retains record and private home`,
        !!retained && existsSync(codexHome) && !existsSync(held.rpcSocket));
      check(`shutdown ${name}: original failed ledger is byte-for-byte unchanged`,
        readFileSync(receiptFile, 'utf8') === originalFailedReceipt);
      await after?.({ ack, record: retained, receipts, receiptFile, messages, ref, env });
      return;
    }
    await after?.({ ack, record, receipts, receiptFile, messages });
    if (unresolved) {
      check(`shutdown ${name}: unresolved Stop retains the holder and recoverable record`,
        pidAlive(holder.pid) && existsSync(sessionFile(ref, env)) && existsSync(readSession(ref, env)?.rpcSocket), JSON.stringify(readSession(ref, env)));
      return;
    }
    if (!ack.ok) return;
    await exited;
    check(`shutdown ${name}: child and socket are cleaned`,
      !pidAlive(held.appPid) && !existsSync(held.rpcSocket), JSON.stringify(held));
    if (driver) check(`shutdown ${name}: driver retires only the confirmed session`, !readSession(ref, env) && ack.stopped);
    check(`shutdown ${name}: all interrupts share the existing bounded allowance`,
      duration < 6200 && (!hanging || duration >= 4500), `${duration}ms`);
  } finally {
    if (pidAlive(holder.pid)) holder.kill('SIGKILL');
    const appPid = readSession(ref, env)?.appPid ?? held?.appPid;
    if (pidAlive(appPid)) { try { process.kill(appPid, 'SIGKILL'); } catch { /* gone */ } }
    dropSession(ref, env);
    if (ack?.ok && held?.commandReceiptFile) check(`shutdown ${name}: lifecycle evidence outlives the record`, existsSync(held.commandReceiptFile));
  }
}

await scenario('completed-A-reserved-B', async ({ accepted, control, status }) => {
  await accepted('B');
  await control({ events: [{ method: 'turn/completed', params: { threadId: 'foreign', id: 'A', status: 'completed' } }] });
  check('holder thread binding: another thread cannot complete an owned active turn', (await status()).activeTurns.includes('A'));
  await control({ events: [{ method: 'turn/completed', id: 'A' }] });
}, { expected: ['B'] });
await scenario('notification-before-response', async ({ start, control, messages }) => {
  const answer = start('B');
  await waitFor(() => messages().some(m => m.params?.input?.[0]?.text === 'B'), { timeoutMs: 3000 });
  await control({ events: [{ method: 'turn/started', id: 'B' }], release: ['B'] });
  await answer;
}, { expected: ['A', 'B'] });
await scenario('completed-before-response', async ({ start, control, messages }) => {
  const answer = start('B');
  await waitFor(() => messages().some(m => m.params?.input?.[0]?.text === 'B'), { timeoutMs: 3000 });
  await control({ events: [{ method: 'turn/started', id: 'B' }, { method: 'turn/completed', id: 'B' },
    { method: 'turn/completed', id: 'A' }], release: ['B'] });
  await answer;
}, { expected: [] });
await scenario('no-known-ID-in-flight', async ({ start, control, messages }) => {
  await control({ events: [{ method: 'turn/completed', id: 'A' }] });
  const answer = start('B').catch(error => error.message);
  await waitFor(() => messages().some(m => m.params?.input?.[0]?.text === 'B'), { timeoutMs: 3000 });
  void answer;
}, { expected: [], unresolved: true });
await scenario('request-error', async ({ start }) => {
  let error = '';
  try { await start('error'); } catch (err) { error = err.message; }
  check('shutdown request-error: rejected request is not a reservation', /fixture request rejected/.test(error), error);
}, { expected: ['A'] });
await scenario('request-timeout', async ({ start }) => {
  let error = '';
  try { await start('B', 30); } catch (err) { error = err.message; }
  check('shutdown request-timeout: timed-out request is not a reservation', /timeout|timed out|no reply/.test(error), error);
}, { expected: [], unresolved: true });
await scenario('missing-response-ID', async ({ start, control }) => {
  await control({ events: [{ method: 'turn/completed', id: 'A' }] });
  await start('no-id');
}, { expected: [], unresolved: true });
await scenario('multiple-active-IDs', async ({ accepted }) => {
  await accepted('B'); await accepted('C');
}, { expected: ['A', 'B', 'C'] });
await scenario('interrupt-errors', async ({ accepted, control }) => {
  await accepted('B'); await control({ interrupt: 'error' });
}, { expected: ['A', 'B'], unresolved: true });
await scenario('interrupts-never-reply', async ({ accepted, control }) => {
  await accepted('B'); await accepted('C'); await control({ interrupt: 'hang' });
}, { expected: ['A', 'B', 'C'], hanging: true, unresolved: true });
await scenario('late-response-after-stopping', async ({ start, control, messages, shutdown, status }) => {
  const b = start('B');
  await waitFor(() => messages().some(m => m.params?.input?.[0]?.text === 'B'), { timeoutMs: 3000 });
  const c = start('C').catch(error => error.message);
  await control({ interrupt: 'hang' });
  const stopped = shutdown();
  await waitFor(async () => (await status()).stopping === true, { timeoutMs: 3000 });
  await control({ release: ['B'] });
  await b;
  const refusal = await c;
  check('shutdown late response: queued turn refuses before native dispatch',
    /stopping/.test(refusal) && !messages().some(m => m.params?.input?.[0]?.text === 'C'), refusal);
  await waitFor(() => messages().filter(m => m.method === 'turn/interrupt').length === 2, { timeoutMs: 3000 });
  await control({ events: [{ method: 'turn/completed', id: 'A' }] });
  const holderStatus = await status();
  check('shutdown late response: accepted in-flight turn remains accounted',
    holderStatus.busy === true && holderStatus.activeTurns.includes('B'), JSON.stringify(holderStatus));
  await stopped;
}, { expected: ['A', 'B'], hanging: true, unresolved: true });

const command = (method, exitCode = null) => ({ method, params: { threadId: 'thread', turnId: 'A',
  item: { type: 'commandExecution', id: 'cmd-1', command: 'fixture-command', cwd: root, processId: 'process-1',
    status: method === 'item/started' ? 'inProgress' : exitCode === 0 ? 'completed' : 'failed',
    exitCode, aggregatedOutput: method === 'item/completed' ? 'first\nlast\n' : null } } });
const output = delta => ({ method: 'item/commandExecution/outputDelta',
  params: { threadId: 'thread', turnId: 'A', itemId: 'cmd-1', delta } });

await scenario('ack-before-terminal-and-trailing-output', async ({ control, shutdown, messages }) => {
  await control({ interrupt: 'ack' });
  let returned = false;
  const stopped = shutdown().then(result => { returned = true; return result; });
  await waitFor(() => messages().some(m => m.method === 'turn/interrupt'), { timeoutMs: 3000 });
  check('shutdown command: interrupt ACK is not terminal proof', !returned);
  await control({ events: [command('item/started'), output('first\n'), { method: 'turn/completed', id: 'A' }] });
  await new Promise(resolve => setTimeout(resolve, 40));
  check('shutdown command: terminal turn alone does not drain background work', !returned);
  await control({ events: [output('last\n'), command('item/completed', 7)] });
  await stopped;
}, { expected: ['A'], after: ({ receipts, receiptFile }) => {
  const confirmed = receipts.find(r => r.kind === 'stop/confirmed');
  check('shutdown command: actual nonzero exit is preserved as nonzero', confirmed?.commands[0]?.exitCode === 7, JSON.stringify(confirmed));
  check('shutdown command: both output deltas precede durable confirmation',
    receipts.filter(r => r.kind === 'item/commandExecution/outputDelta').map(r => r.delta).join('') === 'first\nlast\n'
      && receipts.findIndex(r => r.kind === 'item/completed') < receipts.indexOf(confirmed), JSON.stringify(receipts));
  check('shutdown command: selected lifecycle evidence is separate from the upstream tool receipt',
    existsSync(receiptFile) && confirmed?.originalToolReceipt === 'not synthesized');
} });

await scenario('finite-active-command-natural-completion', async ({ control, shutdown, messages }) => {
  await control({ events: [command('item/started'), output('first\n')] });
  let returned = false;
  const stopped = shutdown().then(result => { returned = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 60));
  check('shutdown finite command: natural-completion wait preserves readers before interrupt',
    !returned && !messages().some(m => m.method === 'turn/interrupt'));
  await control({ events: [output('last\n'), command('item/completed', 0)] });
  await stopped;
}, { expected: ['A'], after: ({ receipts }) => {
  check('shutdown finite command: command outcome precedes turn interruption and successful accounting',
    receipts.findIndex(r => r.kind === 'item/completed') < receipts.findIndex(r => r.kind === 'stop/interrupt')
      && receipts.at(-1).kind === 'stop/confirmed' && receipts.at(-1).commands[0].exitCode === 0, JSON.stringify(receipts));
} });

const rawTool = item => ({ method: 'rawResponseItem/completed', params: { threadId: 'thread', turnId: 'A', item } });
await scenario('raw-resume-refused', async () => {}, { rawTools: true, rawResume: true });
const rawCall = { type: 'function_call', call_id: 'cmd-1', name: 'exec_command',
  arguments: JSON.stringify({cmd:'fixture-command',workdir:root}) };
const rawResult = { type: 'function_call_output', call_id: 'cmd-1',
  output: 'Chunk ID: fixture\nWall time: 1 seconds\nProcess exited with code 0\nOutput:\nACTUAL-SELECTED-TOOL-OUTPUT' };
const unsupportedEnvelope = rawTool({ type: 'custom_tool_call', name: 'functions.exec', call_id: 'unsupported-code',
  input: 'await Promise.all([tools.exec_command({cmd:"fixture-command"})]);' });
const completedIdle = [{ method: 'turn/completed', id: 'A' },
  { method: 'thread/status/changed', params: { threadId: 'thread', type: 'idle' } }];
for (const driver of [false, true]) await scenario(`failed-envelope-idle-${driver ? 'driver' : 'holder'}`, async ({ control, status }) => {
  await control({ events: [rawTool(rawCall), command('item/completed', 0), rawTool(rawResult), unsupportedEnvelope, ...completedIdle] });
  const observed = await status();
  check('shutdown failed envelope: independent lifecycle is idle and original audit remains failed',
    observed.busy === false && observed.activeTurns.length === 0
      && /outside the supported single literal call shape/.test(observed.commandReceiptError), JSON.stringify(observed));
}, { expected: [], rawTools: true, unresolved: true, failedCleanup: true, driver, after: ({ ack, record, receipts, receiptFile, ref, env }) => {
  const cleanup = record?.failedStopCleanup;
  check('shutdown failed envelope: same-launch cleanup preserves the audit failure and actual app closure',
    !ack.ok && !ack.stopped && !record?.stopConfirmed && cleanup?.ref === ref
      && cleanup?.launchId === record?.launchId && cleanup?.threadId === record?.threadId
      && cleanup?.holderPid === record?.holderPid && cleanup?.appPid === record?.appPid
      && cleanup?.receiptFile === receiptFile && cleanup?.appClosed === true && cleanup?.holderExitRequested === true
      && cleanup?.appClose?.code === 0 && cleanup?.appClose?.signal === null
      && cleanup?.auditError === record?.stopError && /outside the supported single literal call shape/.test(cleanup?.auditError)
      && cleanup?.terminal?.lastTurn?.id === 'A' && cleanup?.terminal?.lastTurn?.status === 'completed'
      && cleanup?.terminal?.activeTurns?.length === 0 && cleanup?.terminal?.commands?.[0]?.exitCode === 0
      && cleanup?.terminal?.rawTools?.pending?.length === 0
      && JSON.stringify(cleanup?.terminal?.rawTools?.refusedEnvelopes)
        === JSON.stringify([{ threadId: 'thread', turnId: 'A', callId: 'unsupported-code' }]), JSON.stringify(record));
  check('shutdown failed envelope: raw ledger is unchanged after its original refusal and cannot certify Stop',
    receipts.at(-1)?.kind === 'rawResponseItem/completed' && !readStopConfirmation(receiptFile, record).ok
      && !receipts.some(row => row.kind === 'stop/confirmed'), JSON.stringify(receipts));
  let refused = false;
  try { requireNativeTerminal('fixture-home', { id: 'fixture-task' }, { id: 'fixture-worker', sessionRef: ref,
    metadata: { nativeLaunchId: record?.launchId, sessionId: record?.threadId } }, env); }
  catch (error) { refused = /native work is active or unresolved/.test(error.message); }
  check('shutdown failed envelope: physical resource closure does not authorize native terminal acceptance', refused);
} });
for (const identity of ['missing-call', 'blank-call', 'unknown-turn', 'missing-turn', 'unknown-turn-missing-call', 'duplicate-call', 'existing-call']) {
  await scenario(`failed-envelope-identity-${identity}`, async ({ control, status }) => {
    const envelope = structuredClone(unsupportedEnvelope);
    if (identity.includes('missing-call')) delete envelope.params.item.call_id;
    if (identity === 'blank-call') envelope.params.item.call_id = ' ';
    if (identity.includes('unknown-turn')) envelope.params.turnId = 'unknown-B';
    if (identity === 'missing-turn') delete envelope.params.turnId;
    if (identity === 'existing-call') envelope.params.item.call_id = rawCall.call_id;
    const prior = identity === 'existing-call' ? [rawTool(rawCall), command('item/completed', 0), rawTool(rawResult)] : [];
    await control({ events: [...prior, ...completedIdle, envelope,
      ...(identity === 'duplicate-call' ? [envelope] : [])] });
    const observed = await status();
    check(`shutdown refused envelope ${identity}: prior idle turn cannot supply missing raw identity`,
      observed.busy === false && observed.activeTurns.length === 0
        && observed.commandReceiptError === 'original code-mode envelope is outside the supported single literal call shape', JSON.stringify(observed));
  }, { expected: [], rawTools: true, unresolved: true, budget: 250, after: ({ ack, record, receipts }) => {
    check(`shutdown refused envelope ${identity}: unknown or ambiguous identity cannot release resources`,
      !ack.ok && !ack.stopped && !ack.appClosed && !record.failedStopCleanup
        && !receipts.some(row => row.kind === 'stop/confirmed'), JSON.stringify(record));
  } });
}
for (const mode of ['active', 'pending-command', 'pending-raw', 'unknown-exit', 'unknown-turn', 'missing-idle',
  'pending-request', 'inflight-rpc', 'inflight-turn', 'later-malformed-command', 'later-malformed-turn', 'later-output', 'later-broken-stream']) {
  await scenario(`failed-envelope-${mode}`, async ({ control, rpc, start, messages }) => {
    if (mode === 'inflight-turn') {
      void start('B', 500).catch(() => {});
      await waitFor(() => messages().some(m => m.params?.input?.[0]?.text === 'B'), { timeoutMs: 1000 });
    }
    if (mode === 'inflight-rpc') {
      void rpc('fixture/hang', {}, 500).catch(() => {});
      await waitFor(() => messages().some(m => m.method === 'fixture/hang'), { timeoutMs: 1000 });
    }
    const events = mode === 'pending-command' ? [command('item/started')]
      : mode === 'unknown-exit' ? [command('item/completed', null)]
        : mode === 'pending-raw' ? [rawTool(rawCall)]
          : mode === 'later-output' ? [rawTool(rawCall), command('item/completed', 0), rawTool(rawResult)] : [];
    events.push(unsupportedEnvelope);
    if (mode === 'later-malformed-command') {
      const malformed = command('item/started'); malformed.params.item.id = null; events.push(malformed);
    }
    if (mode === 'later-malformed-turn') events.push({ method: 'turn/completed', status: 'inProgress', id: 'A' });
    if (mode === 'later-output') events.push(output('unexpected trailing output'));
    if (mode !== 'active') events.push(...(mode === 'missing-idle' ? completedIdle.slice(0, 1) : completedIdle));
    if (mode === 'unknown-turn') events.push({ method: 'turn/completed', id: 'A', status: 'inProgress' });
    await control({ events, ...(mode === 'later-broken-stream' ? { endOutput: true, partial: '{"unfinished":' } : {}),
      ...(mode === 'pending-request' ? { requests: [
      { id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'A' } },
    ] } : {}) });
    if (mode === 'later-broken-stream') await new Promise(resolve => setTimeout(resolve, 40));
  }, { expected: [], rawTools: true, unresolved: true, budget: 250, after: ({ ack, record, receipts }) => {
    check(`shutdown failed envelope ${mode}: unsafe lifecycle cannot release resources or synthesize Stop`,
      !ack.ok && !ack.stopped && !record.failedStopCleanup?.appClosed && !receipts.some(row => row.kind === 'stop/confirmed'));
  } });
}
for (const phase of ['requested', 'closed']) await scenario(`failed-envelope-fsync-${phase}`, async ({ control, shutdown, env }) => {
  await control({ events: [unsupportedEnvelope, ...completedIdle] });
  await shutdown();
  rmSync(env.FIXTURE_FSYNC_SWITCH);
  const repeated = await shutdown();
  check(`shutdown failed envelope ${phase}: observed persistence failure permanently disables cleanup`,
    !repeated.ok && !repeated.stopped && !repeated.holderExitRequested);
}, { expected: [], rawTools: true, unresolved: true, budget: 500, failRecordFsync: phase, after: ({ ack, record }) => {
  check(`shutdown failed envelope ${phase}: record fsync refusal cannot authorize holder exit or successful Stop`,
    !ack.ok && !ack.stopped && record.stopConfirmed === false && record.failedStopCleanup?.appClosed === (phase === 'closed'), JSON.stringify(record));
} });
await scenario('failed-stream-idle', async ({ control, status }) => {
  await control({ events: completedIdle, endOutput: true, partial: '{"unfinished":' });
  await waitFor(async () => (await status()).commandReceiptError, { timeoutMs: 1000 });
}, { expected: [], rawTools: true, unresolved: true, budget: 250, after: ({ record }) => {
  check('shutdown failed stream: idle state cannot widen the envelope-only cleanup exception', !record.failedStopCleanup);
} });
await scenario('raw-output-before-interrupt', async ({ control, shutdown, messages }) => {
  await control({ events: [rawTool(rawCall), command('item/started')] });
  let returned = false;
  const stopped = shutdown().then(value => { returned = true; return value; });
  await control({ events: [command('item/completed', 0)] });
  await new Promise(resolve => setTimeout(resolve, 20));
  check('shutdown original tool: command terminal alone cannot interrupt before original output',
    !returned && !messages().some(m => m.method === 'turn/interrupt'));
  if (!messages().some(m => m.method === 'turn/interrupt')) await control({ events: [
    rawTool({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'UNRETAINED-REASONING' }] }),
    rawTool(rawResult),
  ] });
  await stopped;
}, { expected: ['A'], rawTools: true, after: ({ receipts, receiptFile }) => {
  const selected = receipts.filter(r => r.kind === 'rawResponseItem/completed');
  check('shutdown original tool: actual received selected notifications are durable before interrupt',
    selected.length === 2 && selected[1].notification.params.item.output === rawResult.output
      && selected[1].sequence < receipts.find(r => r.kind === 'stop/interrupt')?.sequence, JSON.stringify(selected));
  check('shutdown original tool: reasoning is filtered before durable payload storage',
    !readFileSync(receiptFile, 'utf8').includes('UNRETAINED-REASONING'));
} });
await scenario('raw-output-missing', async ({ control }) => {
  await control({ events: [command('item/started'), command('item/completed', 0)] });
}, { expected: [], rawTools: true, budget: 250, unresolved: true, after: ({ ack, receipts }) => {
  check('shutdown original tool: missing original output remains retained unresolved',
    !ack.stopped && /original|tool receipt/.test(ack.note) && !receipts.some(r => r.kind === 'stop/confirmed')), JSON.stringify(ack);
} });
await scenario('raw-missing-second-invocation', async ({ control }) => {
  const second = command('item/completed', 0);
  second.params.item = { ...second.params.item, id: 'cmd-2', command: 'missing-fixture' };
  await control({ events: [rawTool(rawCall), rawTool(rawResult), command('item/started'), command('item/completed', 0), second] });
}, { expected: [], rawTools: true, budget: 250, unresolved: true, after: ({ ack, receipts }) => {
  check('shutdown original binding: second lifecycle invocation without original receipt cannot confirm',
    !ack.stopped && /original/.test(ack.note) && !receipts.some(r => r.kind === 'stop/confirmed'), JSON.stringify(ack));
} });

await scenario('active-command-timeout', async ({ control }) => {
  await control({ events: [command('item/started')] });
}, { expected: [], budget: 250, unresolved: true, after: ({ ack, receipts }) => {
  check('shutdown command timeout: retained command is not killed to fabricate success',
    /active command outcomes/.test(ack.note) && !receipts.some(r => r.kind === 'stop/confirmed'));
} });

for (const exit of [null, -1]) await scenario(`unknown-command-exit-${exit}`, async ({ control, rpc }) => {
  await control({ events: [command('item/started'), command('item/completed', exit), { method: 'turn/completed', id: 'A' }] });
  await rpc('thread/backgroundTerminals/terminate', { threadId: 'thread', processId: 'process-1' });
  await rpc('thread/backgroundTerminals/list', { threadId: 'thread' });
}, { expected: [], budget: 250, unresolved: true, after: ({ ack, receipts }) => {
  check(`shutdown unknown ${exit}: terminal API ACK and empty list do not supply an exit`,
    !ack.stopped && !receipts.some(r => r.kind === 'stop/confirmed'));
} });

await scenario('receipt-write-error', async ({ status, control }) => {
  const file = (await status()).commandReceiptFile;
  rmSync(file); mkdirSync(file);
  await control({ events: [command('item/started')] });
}, { expected: [], budget: 250, unresolved: true, after: ({ ack, record }) => {
  check('shutdown write error: failed persistence cannot produce Stop success',
    /receipt.*failed/.test(ack.note) && !!record.stopError, JSON.stringify(ack));
} });

await scenario('broken-output-stream', async ({ control, status }) => {
  await control({ endOutput: true, partial: '{"unfinished":' });
  await waitFor(async () => (await status()).commandReceiptError, { timeoutMs: 3000 });
}, { expected: [], budget: 250, unresolved: true });

await scenario('repeated-unresolved-stop', async ({ control, shutdown, messages, start }) => {
  await control({ interrupt: 'error' });
  const first = await shutdown();
  const second = await shutdown();
  const refusal = await start('after-stop').catch(error => error.message);
  check('shutdown repeat: unresolved Stop retains failure without resending consumed interrupt',
    !first.ok && !second.ok && messages().filter(m => m.method === 'turn/interrupt').length === 1);
  check('shutdown repeat: no new model dispatch is admitted', /stopping/.test(refusal)
    && !messages().some(m => m.params?.input?.[0]?.text === 'after-stop'), refusal);
}, { expected: ['A'], budget: 250, unresolved: true });

await scenario('stale-launch-no-shutdown', async ({ ref, env, holder, control }) => {
  const answer = await holderAsk(ref, 'shutdown', { launchId: 'foreign-launch' }, env);
  check('shutdown stale launch: no interrupt or process signal is authorized',
    !answer.ok && pidAlive(holder.pid) && !answer.attempted, JSON.stringify(answer));
  await control({ events: [{ method: 'turn/completed', id: 'A' }] });
}, { expected: [] });

await scenario('driver-idle-terminal-retirement', async ({ control }) => {
  await control({ events: [{ method: 'turn/completed', id: 'A' }] });
}, { expected: [], driver: true });

await scenario('concurrent-stop', async ({ control, shutdown, messages }) => {
  await control({ interrupt: 'ack' });
  const first = shutdown();
  const second = shutdown();
  await waitFor(() => messages().some(m => m.method === 'turn/interrupt'), { timeoutMs: 3000 });
  await control({ events: [{ method: 'turn/completed', id: 'A' }] });
  const replies = await Promise.all([first, second]);
  check('shutdown concurrent: both callers share the same successful finalization', replies.every(r => r.ok && r.stopped));
}, { expected: ['A'], after: ({ receipts }) => {
  check('shutdown concurrent: one interrupt and one durable confirmation',
    receipts.filter(r => r.kind === 'stop/requested').length === 1 && receipts.filter(r => r.kind === 'stop/confirmed').length === 1);
} });

await scenario('receipt-refusal-before-first-turn', async () => {}, { receiptBlocked: true });

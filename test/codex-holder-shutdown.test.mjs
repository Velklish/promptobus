import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { dropSession, holderAsk, pidAlive, readSession, sessionFile, waitReady, writeSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-codex-');
const binDir = path.join(root, 'bin');
mkdirSync(binDir);
const schemaChecks = ['0.159.2', '0.160.0'].map(version => {
  const ajv = new Ajv();
  return ajv.compile(JSON.parse(readFileSync(path.resolve('test/fixtures/codex-app-server', version, 'v2/TurnInterruptParams.json'))));
});
stubCommand(binDir, 'codex', `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const emit = msg => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...msg})+'\\n');
const reply = (id,result) => emit({id,result});
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
  else if(method==='thread/start') reply(id,{thread,cwd:process.cwd(),model:'gpt-6-astra',modelProvider:'openai',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'readOnly'}});
  else if(method==='thread/name/set') reply(id,{});
  else if(method==='turn/start') {
    if(first) { first=false; reply(id,{turn:{id:'A',status:'inProgress',items:[]}}); emit({method:'turn/started',params:{id:'A'}}); }
    else if(params.input[0].text==='error') emit({id,error:{code:-32000,message:'fixture request rejected'}});
    else if(params.input[0].text==='no-id') reply(id,{});
    else pending.set(params.input[0].text,id);
  }
  else if(method==='fixture/control') {
    interrupt=params.interrupt ?? interrupt;
    for(const event of params.events??[]) emit({method:event.method,params:{id:event.id,status:event.status??'completed'}});
    for(const turn of params.release??[]) { reply(pending.get(turn),{turn:{id:turn,status:'inProgress',items:[]}}); pending.delete(turn); }
    reply(id,{});
  }
  else if(method==='turn/interrupt') {
    if(interrupt==='error') emit({id,error:{code:-32000,message:'fixture interrupt rejected'}});
    else if(interrupt!=='hang') reply(id,{});
  }
}
`);

async function scenario(name, work, { expected, hanging = false } = {}) {
  const dir = path.join(root, name);
  mkdirSync(dir);
  const trace = path.join(dir, 'requests.jsonl');
  const env = { ...process.env, PROMPTOBUS_CODEX_HOME: dir, PROMPTOBUS_CODEX_LIMIT_MS: '20', FIXTURE_TRACE: trace };
  const ref = name;
  writeSession({ ref, bin: path.join(binDir, 'codex'), cwd: dir, role: 'worker', state: 'starting',
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
  const shutdown = async () => {
    const before = Date.now();
    ack = await holderAsk(ref, 'shutdown', {}, env, 6500);
    duration = Date.now() - before;
    return ack;
  };
  try {
    const ready = await waitReady(ref, env, 5000);
    check(`shutdown ${name}: actual holder started`, ready.ok, JSON.stringify(ready));
    if (!ready.ok) return;
    await work({ start, accepted, control, rpc, messages, shutdown, status: () => holderAsk(ref, 'status', {}, env) });
    if (!ack) await shutdown();
    check(`shutdown ${name}: caller receives acknowledgement before socket cleanup`, ack.ok === true, JSON.stringify(ack));
    await exited;
    const interrupts = messages().filter(m => m.method === 'turn/interrupt');
    check(`shutdown ${name}: targets only the known active IDs`,
      JSON.stringify(interrupts.map(m => m.params.turnId).sort()) === JSON.stringify([...expected].sort()), JSON.stringify(interrupts));
    check(`shutdown ${name}: each interrupt matches both native schemas`,
      interrupts.every(m => schemaChecks.every(validate => validate(m.params))), JSON.stringify(interrupts));
    check(`shutdown ${name}: child and socket are cleaned`,
      !pidAlive(readSession(ref, env)?.appPid) && !existsSync(readSession(ref, env)?.rpcSocket), JSON.stringify(readSession(ref, env)));
    check(`shutdown ${name}: all interrupts share the existing bounded allowance`,
      duration < 6200 && (!hanging || duration >= 4500), `${duration}ms`);
  } finally {
    if (pidAlive(holder.pid)) holder.kill('SIGKILL');
    const appPid = readSession(ref, env)?.appPid;
    if (pidAlive(appPid)) { try { process.kill(appPid, 'SIGKILL'); } catch { /* gone */ } }
    dropSession(ref, env);
  }
}

await scenario('completed-A-reserved-B', async ({ accepted, control }) => {
  await accepted('B');
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
}, { expected: [] });
await scenario('request-error', async ({ start }) => {
  let error = '';
  try { await start('error'); } catch (err) { error = err.message; }
  check('shutdown request-error: rejected request is not a reservation', /fixture request rejected/.test(error), error);
}, { expected: ['A'] });
await scenario('request-timeout', async ({ start }) => {
  let error = '';
  try { await start('B', 30); } catch (err) { error = err.message; }
  check('shutdown request-timeout: timed-out request is not a reservation', /timeout|timed out|no reply/.test(error), error);
}, { expected: ['A'] });
await scenario('missing-response-ID', async ({ start, control }) => {
  await control({ events: [{ method: 'turn/completed', id: 'A' }] });
  await start('no-id');
}, { expected: [] });
await scenario('multiple-active-IDs', async ({ accepted }) => {
  await accepted('B'); await accepted('C');
}, { expected: ['A', 'B', 'C'] });
await scenario('interrupt-errors', async ({ accepted, control }) => {
  await accepted('B'); await control({ interrupt: 'error' });
}, { expected: ['A', 'B'] });
await scenario('interrupts-never-reply', async ({ accepted, control }) => {
  await accepted('B'); await accepted('C'); await control({ interrupt: 'hang' });
}, { expected: ['A', 'B', 'C'], hanging: true });
await scenario('late-response-after-stopping', async ({ start, control, messages, shutdown, status }) => {
  const b = start('B');
  await waitFor(() => messages().some(m => m.params?.input?.[0]?.text === 'B'), { timeoutMs: 3000 });
  const c = start('C').catch(error => error.message);
  await control({ interrupt: 'hang' });
  const stopped = shutdown();
  await waitFor(() => messages().some(m => m.method === 'turn/interrupt'), { timeoutMs: 3000 });
  await control({ release: ['B'] });
  await b;
  const refusal = await c;
  check('shutdown late response: queued turn refuses before native dispatch',
    /stopping/.test(refusal) && !messages().some(m => m.params?.input?.[0]?.text === 'C'), refusal);
  await control({ events: [{ method: 'turn/completed', id: 'A' }] });
  const holderStatus = await status();
  check('shutdown late response: stopped request cannot add a reservation', holderStatus.busy === false, JSON.stringify(holderStatus));
  await stopped;
}, { expected: ['A'], hanging: true });

import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { dropSession, holderAsk, holderLogFile, pidAlive, readSession, sessionFile, waitReady, writeSession } from '../lib/codex-session.js';
import { rawToolReceipts } from '../lib/codex-raw-tool-receipts.js';
import { readStopConfirmation } from '../lib/codex-command-receipts.js';

const root = realpathSync(makeSandbox('promptobus-codex-'));
const bin = path.join(root, 'bin'); mkdirSync(bin);
stubCommand(bin, 'codex', `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const emit = messages => process.stdout.write(messages.map(msg=>JSON.stringify({jsonrpc:'2.0',...msg})+'\\n').join(''));
let turn = 0;
for await (const line of readline.createInterface({input:process.stdin})) {
 const {id,method,params={}} = JSON.parse(line);
 appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({method,params})+'\\n');
 if(method==='initialize') emit([{id,result:{userAgent:'fixture'}}]);
 else if(method==='thread/start') emit([{id,result:{thread:{id:'thread'},
   ...(process.env.FIXTURE_CWD==='missing'?{}:{cwd:process.env.FIXTURE_CWD==='foreign'?'/foreign'
     :process.env.FIXTURE_CWD==='alias'?process.env.FIXTURE_ALIAS_CWD:process.cwd()}),
   sandbox:{type:'readOnly'},approvalPolicy:'on-request'}}]);
 else if(method==='turn/start'||method==='review/start'||method==='turn/steer') {
  const turnId='turn-'+(++turn),callId='call-'+turn;
  const raw=item=>({method:'rawResponseItem/completed',params:{threadId:'thread',turnId,item}});
  emit([
   {method:'turn/started',params:{threadId:'thread',turn:{id:turnId,status:'inProgress'}}},
   raw({type:'function_call',name:'exec_command',call_id:callId,arguments:JSON.stringify({cmd:'fixture'})}),
   {method:'item/completed',params:{threadId:'thread',turnId,item:{type:'commandExecution',id:callId,
    command:'fixture',cwd:process.cwd(),status:'completed',exitCode:0}}},
   raw({type:'function_call_output',call_id:callId,output:'Chunk ID: fixture\\nProcess exited with code 0\\nOutput:\\n'}),
   {method:'turn/completed',params:{threadId:'thread',turn:{id:turnId,status:'completed'}}},
   {id,result:{turn:{id:turnId,status:'completed'}}}
  ]);
 } else emit([{id,result:{}}]);
}
`);
function selected(file) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  let error;
  const raw = rawToolReceipts(() => {}, reason => { error = reason; }, rows[0]);
  const commands = new Map();
  for (const row of rows.slice(1)) {
    if (row.kind.startsWith('execution-context/')) raw.context(row.kind.slice('execution-context/'.length), row);
    if (row.kind === 'rawResponseItem/completed') raw.observe(row.notification, 'thread');
    if (row.kind === 'item/started' || row.kind === 'item/completed') {
      const { sequence, at, kind, ...data } = row; commands.set(row.itemId, data);
    }
  }
  return { rows, error, ...raw.snapshot([...commands.values()]) };
}
const selectorKeys = ['CODEX_EXEC_SERVER_URL', 'CODEX_EXEC_SERVER_NOISE_REGISTRY_URL',
  'CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID', 'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN', 'CODEX_EXEC_SERVER_NOISE_CHATGPT_ACCOUNT_ID'];
async function scenario(name, mutation, acceptedCwd = 'matching', startup = {}) {
  const dir = path.join(root, name); mkdirSync(dir);
  const alias = `${dir}-alias`;
  if (acceptedCwd === 'alias') symlinkSync(dir, alias, 'dir');
  const codexHome = path.join(dir, 'private-home');
  if (startup.home !== 'missing') mkdirSync(codexHome);
  if (startup.environmentFile === 'file') writeFileSync(path.join(codexHome, 'environments.toml'), '# Owned unproved environment configuration.\n');
  if (startup.environmentFile === 'directory') mkdirSync(path.join(codexHome, 'environments.toml'));
  if (startup.environmentFile === 'symlink') symlinkSync('absent-owned-target', path.join(codexHome, 'environments.toml'));
  const env = { ...process.env, PROMPTOBUS_CODEX_HOME: dir, PROMPTOBUS_CODEX_RAW_TOOL_RECEIPTS: '1',
    PROMPTOBUS_CODEX_LIMIT_MS: '20',
    CODEX_HOME: startup.home === 'mismatch' ? dir : codexHome,
    FIXTURE_TRACE: path.join(dir, 'requests.jsonl'), FIXTURE_CWD: acceptedCwd, FIXTURE_ALIAS_CWD: alias };
  for (const key of selectorKeys) delete env[key];
  Object.assign(env, startup.selectors ?? {});
  if (startup.legacy) delete env.PROMPTOBUS_CODEX_RAW_TOOL_RECEIPTS;
  const ref = name, launchId = 'launch-' + name;
  writeSession({ ref, launchId, bin: path.join(bin, 'codex'), cwd: dir, codexHome, role: 'worker', state: 'starting',
    sandbox: 'read-only', approvalPolicy: 'on-request', prompt: 'First', addDirs: [], model: null }, env);
  const holder = spawn(process.execPath, [path.resolve('lib/codex-hold.js'), sessionFile(ref, env)], { env, stdio: 'ignore' });
  const exited = new Promise(resolve => holder.once('exit', resolve));
  let held;
  try {
    const ready = await waitReady(ref, env, 5000);
    if (startup.refuse) {
      held = readSession(ref, env);
      const rows = held?.commandReceiptFile && existsSync(held.commandReceiptFile) ? selected(held.commandReceiptFile).rows : [];
      check(`holder startup ${name}: unproved executor configuration refuses admission`, !ready.ok, JSON.stringify(ready));
      check(`holder startup ${name}: no child RPC or trusted context is produced`,
        !existsSync(env.FIXTURE_TRACE) && !rows.some(row => row.kind === 'execution-context/thread/accepted'));
      const log = readFileSync(holderLogFile(ref, env), 'utf8');
      check(`holder startup ${name}: refusal never logs selector values`,
        !JSON.stringify(held).includes('UNRETAINED-SELECTOR-VALUE') && !log.includes('UNRETAINED-SELECTOR-VALUE'));
      return;
    }
    check(`holder implicit ${name}: owned fake holder is ready`, ready.ok, JSON.stringify(ready));
    if (!ready.ok) return;
    held = readSession(ref, env);
    if (startup.legacy) {
      check('holder startup legacy: non-opt-in admission preserves unsupported environment inputs without claiming fixed context',
        existsSync(env.FIXTURE_TRACE) && !selected(held.commandReceiptFile).rows.some(row => row.kind.startsWith('execution-context/')));
      return;
    }
    await waitFor(() => selected(held.commandReceiptFile).rows.some(row =>
      row.kind === 'execution-context/turn/accepted' && row.turnId === 'turn-1'), { timeoutMs: 3000 });
    const initial = selected(held.commandReceiptFile);
    check(`holder implicit ${name}: accepted cwd is required independently of lifecycle cwd`,
      initial.bindings.length === (acceptedCwd === 'matching' ? 1 : 0), JSON.stringify(initial));
    const requests = readFileSync(env.FIXTURE_TRACE, 'utf8').trim().split('\n').map(JSON.parse);
    check(`holder implicit ${name}: experimental advertisement flag is requested independently of executor admission`,
      requests.find(row => row.method === 'thread/start')?.params.config['features.stable_environment_tools'] === false);
    if (acceptedCwd === 'matching') check(`holder implicit ${name}: raw-before-ACK uses actual later turn identity`,
      initial.rows.findIndex(row => row.kind === 'rawResponseItem/completed')
        < initial.rows.findIndex(row => row.kind === 'execution-context/turn/accepted')
      && initial.bindings[0]?.defaultContext?.launchId === launchId);
    const rpc = (method, params) => holderAsk(ref, 'rpc', { method, params, timeoutMs: 3000 }, env);
    let next = { threadId: 'thread', input: [{ type: 'text', text: 'Second' }] };
    if (mutation) {
      if (mutation.method === 'turn/start') next = { ...next, ...mutation.params };
      else await rpc(mutation.method, mutation.params ?? { threadId: 'thread' });
    }
    await rpc('turn/start', next);
    const replay = selected(held.commandReceiptFile);
    const supported = !mutation && acceptedCwd === 'matching';
    check(`holder implicit ${name}: ${supported ? 'ordinary next turn inherits fixed context' : 'unsupported context cannot use implicit proof'}`,
      supported ? replay.bindings.length === 2 && replay.pending.length === 0
        : replay.bindings.length === 0 && replay.pending.length >= 4, JSON.stringify(replay));
    const stop = await holderAsk(ref, 'shutdown', { launchId, deadlineAt: Date.now() + 500 }, env, 2000);
    check(`holder implicit ${name}: durable Stop agrees with selected original proof`, stop.ok === supported, JSON.stringify(stop));
    if (supported && stop.ok) {
      await exited;
      check('holder implicit replay: durable receipt validates independent context after holder exit',
        readStopConfirmation(held.commandReceiptFile, held).ok);
    }
  } finally {
    held ??= readSession(ref, env);
    if (pidAlive(holder.pid)) holder.kill('SIGKILL');
    if (pidAlive(held?.appPid)) { try { process.kill(held.appPid, 'SIGKILL'); } catch { /* owned fixture already gone */ } }
    await waitFor(() => !pidAlive(holder.pid), { timeoutMs: 3000 });
    dropSession(ref, env);
  }
}
await scenario('fixed-two-turns');
await scenario('missing-accepted-cwd', null, 'missing');
await scenario('foreign-accepted-cwd', null, 'foreign');
await scenario('aliased-accepted-cwd', null, 'alias');
for (const [name, mutation] of [
  ['cwd-override', { method: 'turn/start', params: { cwd: '/foreign' } }],
  ['environments-override', { method: 'turn/start', params: { environments: [] } }],
  ['settings-update', { method: 'thread/settings/update' }],
  ['environment-update', { method: 'environment/update' }],
  ['resume', { method: 'thread/resume' }],
  ['review', { method: 'review/start' }],
  ['steer', { method: 'turn/steer' }],
  ['unknown-rpc', { method: 'unknown/mutation' }],
]) await scenario(name, mutation);
for (const key of selectorKeys) await scenario('selector-' + key.toLowerCase(), null, 'matching', {
  selectors: { [key]: 'UNRETAINED-SELECTOR-VALUE' }, refuse: true,
});
await scenario('complete-noise', null, 'matching', {
  selectors: Object.fromEntries(selectorKeys.slice(1).map(key => [key, 'UNRETAINED-SELECTOR-VALUE'])), refuse: true,
});
await scenario('empty-selector', null, 'matching', { selectors: { CODEX_EXEC_SERVER_URL: '' }, refuse: true });
for (const environmentFile of ['file', 'directory', 'symlink'])
  await scenario('environment-' + environmentFile, null, 'matching', { environmentFile, refuse: true });
for (const home of ['missing', 'mismatch'])
  await scenario('private-home-' + home, null, 'matching', { home, refuse: true });
await scenario('legacy-environment-selection', null, 'matching', {
  selectors: { CODEX_EXEC_SERVER_URL: 'UNRETAINED-SELECTOR-VALUE' }, environmentFile: 'file', legacy: true,
});

import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox, stubCommand, writeHostConfig } from './sandbox.mjs';
import { expectFail } from './console.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import * as store from '../lib/store.js';
import { REGISTRY } from '../lib/drivers.js';
import { reserveNativeParticipant, requireNativeTerminal } from '../lib/native-lifecycle.js';
import { holderAsk, pidAlive, readSession, sessionFile, waitReady, writeSession } from '../lib/codex-session.js';
import { readStopConfirmation } from '../lib/codex-command-receipts.js';
import { stop } from '../lib/stop.js';

const root = makeSandbox('promptobus-codex-');
writeHostConfig(root, { tools: ['codex'] });
const host = hostOf(root), home = host.promptobusHome();
process.env.CLAUDE_CODE_SESSION_ID = 'fixture-owner';
process.env.PROMPTOBUS_CODEX_HOME = path.join(root, 'registry');
process.env.PROMPTOBUS_WARDEN = 'off';
const task = 'declined-t20261026-010000', address = 'worker:denied', ref = 'declined-fixture';
store.createTask(home, { id: task, title: 'Declined command Stop', owner: 'fixture-owner' });
const { record: participant } = reserveNativeParticipant(home, task,
  store.participantRecord(address, { harness: 'codex', mode: 'managed', sessionRef: ref }), undefined, REGISTRY);
const trace = path.join(root, 'requests.jsonl'), bin = path.join(root, 'bin');
stubCommand(bin, 'codex', `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const emit = msg => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...msg})+'\\n');
const thread = {id:'fixture-thread',turns:[]};
for await (const line of readline.createInterface({input:process.stdin})) {
  const msg=JSON.parse(line),{id,method}=msg;
  appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify(msg)+'\\n');
  if(method==='initialize') emit({id,result:{userAgent:'fixture'}});
  else if(method==='thread/start') emit({id,result:{thread,cwd:process.cwd(),
    model:'gpt-6-astra',modelProvider:'openai',approvalPolicy:'on-request',
    approvalsReviewer:'user',sandbox:{type:'readOnly'}}});
  else if(method==='turn/start') {
    emit({id,result:{turn:{id:'fixture-turn',status:'inProgress',items:[]}}});
    emit({method:'turn/started',params:{threadId:thread.id,turn:{id:'fixture-turn',status:'inProgress'}}});
    const item={type:'commandExecution',id:'exec-declined',command:'fixture-never-executed',
      cwd:process.cwd(),processId:null,exitCode:null,status:'inProgress'};
    for(const method of ['item/started','item/completed']) {
      emit({method,params:{threadId:thread.id,turnId:'fixture-turn',item:{...item,
        status:method==='item/completed'?'declined':'inProgress'}}});
    }
    emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:'fixture-turn',status:'completed'}}});
  } else emit({id,result:{}});
}
`);
const env = { ...process.env, FIXTURE_TRACE: trace };
writeSession({ ref, home, task, address, launchId: participant.metadata.nativeLaunchId,
  bin: path.join(bin, 'codex'), cwd: root, role: 'worker', state: 'starting',
  codexHome: path.join(root, 'private-home'), sandbox: 'read-only', approvalPolicy: 'on-request',
  prompt: 'Fixture only', addDirs: [], model: null }, env);
mkdirSync(path.join(root, 'private-home'));
writeFileSync(path.join(root, 'private-home', 'sentinel'), 'owned fixture');
const holder = spawn(process.execPath, [path.resolve('lib/codex-hold.js'), sessionFile(ref, env)], { env, stdio: 'ignore' });
const exited = new Promise(resolve => holder.once('exit', resolve));
let held;
try {
  const ready = await waitReady(ref, env, 5000);
  check('declined public Stop: fixture holder starts without a model', ready.ok, JSON.stringify(ready));
  if (ready.ok) {
    held = readSession(ref, env);
    store.upsertParticipant(home, task, { ...participant,
      metadata: { ...participant.metadata, sessionId: held.threadId } });
    await waitFor(async () => {
      const status = await holderAsk(ref, 'status', {}, env);
      return status.busy === false && status.activeTurns.length === 0;
    }, { timeoutMs: 3000 });
    const before = readFileSync(held.commandReceiptFile, 'utf8').trim().split('\n').map(JSON.parse);
    check('declined public Stop: actual declined event has no process or exit',
      before.some(row => row.kind === 'item/completed' && row.status === 'declined'
        && row.processId === null && row.exitCode === null), JSON.stringify(before));
    const result = await expectFail(() => stop(host, { task, address }));
    check('declined public Stop: idle actor retires with its explicit non-start outcome',
      !result.failed && result.value === 0 && !readSession(ref, env), result.out);
    if (!result.failed && result.value === 0) {
      await exited;
      const rows = readFileSync(held.commandReceiptFile, 'utf8').trim().split('\n').map(JSON.parse);
      const final = rows.at(-1), item = final.commands?.[0];
      check('declined public Stop: retained proof preserves declined null exit without execution',
        final.kind === 'stop/confirmed' && item?.status === 'declined' && item.exitCode === null
          && item.processId === null && item.aggregatedOutput === null
          && !rows.some(row => row.kind === 'item/commandExecution/outputDelta'), JSON.stringify(final));
      const meta = store.readTask(home, task), stopped = store.participantOf(meta, address);
      let terminal = false;
      try { requireNativeTerminal(home, meta, stopped); terminal = true; } catch { /* assertion below */ }
      check('declined public Stop: retained identity and hash validate for native lifecycle',
        terminal && readStopConfirmation(held.commandReceiptFile, stopped.metadata.nativeStop).ok);
      const requests = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
      check('declined public Stop: closes only fixture resources and leaves task active',
        !pidAlive(held.holderPid) && !pidAlive(held.appPid) && !existsSync(held.rpcSocket)
          && meta.status === 'active' && !requests.some(msg => msg.method === 'turn/interrupt'));
    }
  }
} finally {
  if (pidAlive(holder.pid)) holder.kill('SIGKILL');
  if (pidAlive(held?.appPid)) process.kill(held.appPid, 'SIGKILL');
}

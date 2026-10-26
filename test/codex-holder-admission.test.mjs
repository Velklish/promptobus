import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { dropSession, holderAsk, pidAlive, readSession, sessionFile, waitReady, withSessionLaunch, writeSession } from '../lib/codex-session.js';

for (const change of ['ownership', 'stopping', 'enqueue-lock']) {
test(change === 'enqueue-lock' ? 'holder releases launch lock before awaiting the RPC response'
  : 'holder refuses ' + change + ' changed during awaited auth reload', async () => {
  const root = makeSandbox('promptobus-admission-');
  const owner = path.join(root, 'owner'), privateHome = path.join(root, 'private');
  mkdirSync(owner); mkdirSync(privateHome);
  const auth = label => JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    access_token: 'e30.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000) + 3600, label })).toString('base64url') + '.fixture',
    refresh_token: '', account_id: 'fixture',
  } });
  writeFileSync(path.join(owner, 'auth.json'), auth('initial'));
  writeFileSync(path.join(privateHome, 'auth.json'), auth('initial'));
  const bin = path.join(root, 'bin'), trace = path.join(root, 'trace.jsonl');
  const release = path.join(root, 'release'), waiting = path.join(root, 'waiting');
  stubCommand(bin, 'codex', `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
const emit = x => process.stdout.write(JSON.stringify(x)+'\\n');
for await (const line of readline.createInterface({input:process.stdin})) {
 const {id,method,params={}} = JSON.parse(line);
 appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({method,params})+'\\n');
 if(method==='initialize') { emit({id,result:{}}); emit({method:'account/rateLimits/updated',params:{primary:{usedPercent:0}}}); }
 else if(method==='thread/start') emit({id,result:{thread:{id:'actual-thread'},approvalPolicy:'on-request',sandbox:{type:'readOnly'}}});
 else if(method==='account/read') { writeFileSync(process.env.FIXTURE_WAITING,'waiting'); while(!existsSync(process.env.FIXTURE_RELEASE)) await new Promise(r=>setTimeout(r,5)); emit({id,result:{}}); }
 else if(method==='turn/start') { if(params.input?.[0]?.text==='pending-enqueue') { writeFileSync(process.env.FIXTURE_WAITING,'waiting'); while(!existsSync(process.env.FIXTURE_RELEASE)) await new Promise(r=>setTimeout(r,5)); } emit({id,result:{turn:{id:'idle-turn'}}}); emit({method:'turn/started',params:{id:'idle-turn'}}); setTimeout(()=>emit({method:'turn/completed',params:{id:'idle-turn',status:'completed'}}),20); }
 else emit({id,result:{}});
}
`);
  const env = { ...process.env, PROMPTOBUS_CODEX_HOME: root, PROMPTOBUS_CODEX_LIMIT_MS: '20',
    FIXTURE_TRACE: trace, FIXTURE_RELEASE: release, FIXTURE_WAITING: waiting };
  const ref = 'admission';
  writeSession({ ref, launchId: 'old-launch', bin: path.join(bin, 'codex'), cwd: root,
    codexHome: privateHome, authOwnerHome: owner, role: 'worker', state: 'starting',
    sandbox: 'read-only', approvalPolicy: 'on-request', prompt: 'First', addDirs: [], model: null }, env);
  const holder = spawn(process.execPath, [path.resolve('lib/codex-hold.js'), sessionFile(ref, env)], { env, stdio: 'ignore' });
  let original;
  try {
    const ready = await waitReady(ref, env, 5000);
    assert.equal(ready.ok, true, JSON.stringify(ready));
    original = readSession(ref, env);
    assert.equal(await waitFor(() => readSession(ref, env)?.busy === false, { timeoutMs: 3000 }), true, 'fixture first turn must be idle');
    if (change === 'enqueue-lock') {
      const pending = holderAsk(ref, 'rpc', { method: 'turn/start', params: { threadId: 'actual-thread',
        input: [{ type: 'text', text: 'pending-enqueue' }] } }, env);
      assert.equal(await waitFor(() => existsSync(waiting), { timeoutMs: 3000 }), true, 'fixture must hold the RPC response');
      assert.doesNotThrow(() => withSessionLaunch(ref, env, () => {}, { waitMs: 0 }),
        'synchronous launch lock must be released while the RPC response is pending');
      writeFileSync(release, 'release');
      await pending;
      return;
    }
    writeFileSync(path.join(owner, 'auth.json'), auth('changed'));
    const pending = holderAsk(ref, 'rpc', { method: 'turn/start', params: {
      threadId: 'actual-thread', input: [{ type: 'text', text: 'must-not-dispatch' }],
    } }, env).then(result => ({ result }), error => ({ error: error.message }));
    assert.equal(await waitFor(() => existsSync(waiting), { timeoutMs: 3000 }), true, 'fixture must hold the auth await');
    writeSession({ ...readSession(ref, env), ...(change === 'ownership'
      ? { launchId: 'replacement-launch' } : { stopping: true }) }, env);
    writeFileSync(release, 'release');
    const answer = await pending;
    const requests = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(requests.filter(r => r.method === 'turn/start' && r.params.input?.[0]?.text === 'must-not-dispatch').length, 0,
      'lost ownership after auth await must prevent model input');
    assert.match(answer.error ?? '', change === 'ownership' ? /ownership changed/ : /stopping/);
    if (change === 'stopping') {
      const stopped = await holderAsk(ref, 'shutdown', { launchId: 'old-launch', deadlineAt: Date.now() + 1500 }, env, 2000);
      assert.equal(stopped.ok, true, 'refused admission must not invent an unresolved dispatched call: ' + JSON.stringify(stopped));
    }
  } finally {
    if (pidAlive(holder.pid)) holder.kill('SIGKILL');
    if (pidAlive(original?.appPid)) { try { process.kill(original.appPid, 'SIGKILL'); } catch {} }
    await new Promise(resolve => { if (holder.exitCode !== null || holder.signalCode !== null) resolve(); else holder.once('exit', resolve); });
    dropSession(ref, env);
  }
});
}

import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeSandbox, makeSockDir } from './sandbox.mjs';
import { readSession, sessionKey, sessionsDir, writeSession } from '../lib/codex-session.js';

test('self-Stop finalizer leaves a replacement launch untouched', async () => {
  const root = makeSandbox('promptobus-codex-finalizer-'), env = { ...process.env, PROMPTOBUS_CODEX_HOME: root };
  const ref = 'finalizer-replacement', launchId = 'original-launch', threadId = 'original-thread';
  writeSession({ ref, launchId, threadId, holderPid: process.pid, appPid: process.pid, state: 'starting' }, env);
  const helper = spawn(process.execPath, [fileURLToPath(new URL('../lib/codex-retire.js', import.meta.url)), ref,
    launchId, threadId, String(Date.now() + 3000)], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const ready = new Promise((resolve, reject) => { helper.once('message', resolve); helper.once('error', reject); helper.once('exit', code => reject(new Error(`helper exited ${code} before readiness`))); });
  const closed = new Promise(resolve => helper.once('exit', (code, signal) => resolve({ code, signal })));
  assert.equal((await ready).ready, true);
  helper.disconnect();
  const replacement = { ref, launchId: 'replacement-launch', threadId: 'replacement-thread', state: 'starting' };
  writeSession(replacement, env);
  assert.deepEqual(await closed, { code: 1, signal: null });
  assert.equal(readSession(ref, env).launchId, replacement.launchId);
  assert.equal(readSession(ref, env).threadId, replacement.threadId);
  const log = path.join(sessionsDir(env), `${sessionKey(ref)}.self-stop-${createHash('sha256').update(launchId).digest('hex').slice(0, 16)}.log`);
  assert.equal(existsSync(log), true);
  assert.match(readFileSync(log, 'utf8'), /launch identity changed/);
});

async function holderTrap(t) {
  const { sock } = makeSockDir('pb-stop-recovery-'), server = createServer();
  let connections = 0;
  server.on('connection', socket => { connections++; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sock('holder'), resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { socket: sock('holder'), count: () => connections };
}

test('self-Stop does not request shutdown when finalizer spawn fails', async t => {
  const root = makeSandbox('promptobus-codex-finalizer-'), ref = 'spawn-failure', threadId = 'owned-thread';
  const env = { ...process.env, PROMPTOBUS_CODEX_HOME: root, CODEX_THREAD_ID: threadId };
  const trap = await holderTrap(t);
  writeSession({ ref, launchId: 'owned-launch', threadId, holderPid: process.pid, appPid: process.pid, state: 'idle', rpcSocket: trap.socket }, env);
  const shim = path.join(root, 'deny-finalizer.mjs');
  writeFileSync(shim, `import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=child.spawn;
child.spawn=(file,args,...rest)=>{ if(args.some(arg=>String(arg).endsWith('/codex-retire.js'))) throw new Error('fixture finalizer spawn denied'); return original(file,args,...rest); };
syncBuiltinESMExports();
`);
  const driver = pathToFileURL(fileURLToPath(new URL('../lib/driver-codex.js', import.meta.url))).href;
  const script = `import {codexDriver} from ${JSON.stringify(driver)}; console.log(JSON.stringify(await codexDriver.stop(${JSON.stringify(ref)}, {deferSelf:true})));`;
  const child = spawn(process.execPath, ['--import', pathToFileURL(shim).href, '--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const outcome = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, false);
  assert.equal(result.stopped, false);
  assert.match(result.note, /fixture finalizer spawn denied/);
  assert.equal(readSession(ref, env).launchId, 'owned-launch');
  assert.equal(readSession(ref, env).stopConfirmed, undefined);
  assert.equal(trap.count(), 0, 'no shutdown request may reach the holder');
});

test('self-Stop refuses when finalizer child exits before readiness', async t => {
  const root = makeSandbox('promptobus-codex-finalizer-'), ref = 'startup-failure', threadId = 'owned-thread';
  const env = { ...process.env, PROMPTOBUS_CODEX_HOME: root, CODEX_THREAD_ID: threadId };
  const trap = await holderTrap(t);
  writeSession({ ref, launchId: 'owned-launch', threadId, holderPid: process.pid, appPid: process.pid, state: 'idle', rpcSocket: trap.socket }, env);
  const shim = path.join(root, 'failed-finalizer.mjs');
  writeFileSync(shim, `import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=child.spawn;
child.spawn=(file,args,...rest)=>args.some(arg=>String(arg).endsWith('/codex-retire.js'))
  ? original(file,['-e','process.exit(23)'],...rest) : original(file,args,...rest);
syncBuiltinESMExports();
`);
  const driver = pathToFileURL(fileURLToPath(new URL('../lib/driver-codex.js', import.meta.url))).href;
  const script = `import {codexDriver} from ${JSON.stringify(driver)}; console.log(JSON.stringify(await codexDriver.stop(${JSON.stringify(ref)}, {deferSelf:true})));`;
  const child = spawn(process.execPath, ['--import', pathToFileURL(shim).href, '--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const outcome = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, false);
  assert.equal(result.stopped, false);
  assert.match(result.note, /exited before readiness/);
  assert.equal(readSession(ref, env).launchId, 'owned-launch');
  assert.equal(readSession(ref, env).stopConfirmed, undefined);
  assert.equal(trap.count(), 0, 'no shutdown request may reach the holder');
});

test('self-Stop readiness timeout releases and stops its owned helper', async t => {
  const root = makeSandbox('promptobus-codex-finalizer-'), ref = 'no-ready', threadId = 'owned-thread';
  const marker = path.join(root, 'helper-pid');
  const env = { ...process.env, PROMPTOBUS_CODEX_HOME: root, CODEX_THREAD_ID: threadId, FIXTURE_HELPER_PID: marker };
  const trap = await holderTrap(t);
  writeSession({ ref, launchId: 'owned-launch', threadId, holderPid: process.pid, appPid: process.pid, state: 'idle', rpcSocket: trap.socket }, env);
  const shim = path.join(root, 'no-ready-finalizer.mjs');
  writeFileSync(shim, `import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=child.spawn;
child.spawn=(file,args,...rest)=>args.some(arg=>String(arg).endsWith('/codex-retire.js'))
  ? original(file,['-e',"require('node:fs').writeFileSync(process.env.FIXTURE_HELPER_PID,String(process.pid));setInterval(()=>{},1000)"],...rest)
  : original(file,args,...rest);
syncBuiltinESMExports();
`);
  const driver = pathToFileURL(fileURLToPath(new URL('../lib/driver-codex.js', import.meta.url))).href;
  const script = `import {codexDriver} from ${JSON.stringify(driver)}; console.log(JSON.stringify(await codexDriver.stop(${JSON.stringify(ref)}, {deferSelf:true,timeoutMs:1000})));`;
  const child = spawn(process.execPath, ['--import', pathToFileURL(shim).href, '--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const started = Date.now();
  const outcome = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
  assert.ok(Date.now() - started < 4000, 'CLI must exit within the readiness bound');
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, false);
  assert.equal(result.stopped, false);
  assert.match(result.note, /readiness timed out/);
  assert.equal(readSession(ref, env).launchId, 'owned-launch');
  assert.equal(readSession(ref, env).stopConfirmed, undefined);
  assert.equal(trap.count(), 0, 'no shutdown request may reach the holder');
  const pid = Number(readFileSync(marker, 'utf8'));
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(alive, false, 'the owned no-ready helper must exit');
});

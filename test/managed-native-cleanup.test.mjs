import { check } from './check.mjs';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStandaloneHost } from '../dist/host-index.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { readSession as readCodex, reapHolder as reapCodex, sessionFile as codexFile, writeSession as writeCodex } from '../lib/codex-session.js';
import { readSession as readCursor, readTmuxSessions, sessionFile as cursorFile } from '../lib/cursor-persist.js';
import { reapHolder as reapOpenCode } from '../lib/opencode-session.js';
import { processState, requireProcess } from '../lib/service-state.js';
import { revokeFailedManagedLaunch } from '../lib/service-launch.js';
import { createTask, participantRecord, participantSessionPath, taskFile, upsertParticipant } from '../lib/store.js';
import { installHarness as installCodex } from './harness-codex.mjs';
import { installHarness as installCursor, planParticipant } from './harness-cursor.mjs';
import { makeSandbox, makeSockDir, stubCommand, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-managed-native-cleanup-'));
writeHostConfig(root, { tools: ['claude', 'cursor', 'codex', 'opencode'] });
const host = createStandaloneHost({ cwd: root }), home = host.promptobusHome();
const task = 'native-cleanup-t20261101-120000', bin = path.join(root, 'bin');
createTask(home, { id: task, title: 'actual managed native failure cleanup' });
process.env.PROMPTOBUS_OPENCODE_HOME = path.join(root, 'opencode-registry');
const reserve = (driver, ref, launchId) => {
  const address = `worker:${ref}`;
  upsertParticipant(home, task, participantRecord(address, { harness: driver.id, mode: 'managed', sessionRef: ref,
    ...(driver.id === 'codex' ? { nativeLaunchId: launchId } : {}) }));
  return { tool: { bin: process.execPath, version: driver.id === 'claude' ? '2.1.295' : undefined }, host, home, task, address, ref, role: 'worker', cwd: root, env: process.env, persist: () => {} };
};
async function driverAndCaller(driver, plan, runtime) {
  let driverError, callerError;
  try { await driver.spawn(plan, runtime); } catch (error) { driverError = error; }
  try { await revokeFailedManagedLaunch(plan, driverError); } catch (error) { callerError = error; }
  return { driverError, callerError };
}

// Real shared liftoff undo reads the journal; a broken journal must not replace beforeStart's error.
{
  const ref = 'claude-undo', launchId = 'claude-undo-launch', runtime = reserve(claudeDriver, ref, launchId);
  const nativeStore = path.join(root, 'claude-native'); mkdirSync(nativeStore);
  runtime.env = { ...process.env, CLAUDE_CONFIG_DIR: nativeStore };
  const record = participantSessionPath(home, task, runtime.address), journal = taskFile(home, task);
  const before = readFileSync(journal), original = new Error('Claude native registration refused before start');
  let revokes = 0;
  const plan = { argv: [], files: [], prelaunchBinding: { sessionId: '12345678-1234-4123-8123-123456789abc', sessionRecord: record },
    service: { launchId, beforeStart: async () => { writeFileSync(journal, '{broken-task'); throw original; },
      realize: async () => {}, revoke: async () => { revokes += 1; } } };
  try {
    const { driverError, callerError } = await driverAndCaller(claudeDriver, plan, runtime);
    check('actual Claude liftoff preserves beforeStart and real journal undo failures through its caller',
      driverError instanceof AggregateError && driverError.errors[0] === original && driverError.cause === original
        && driverError.errors[1] instanceof Error && callerError === driverError && revokes === 1
        && driverError.message.includes(original.message) && driverError.message.includes(record), driverError?.stack);
    const retained = JSON.parse(readFileSync(record, 'utf8'));
    check('failed shared Claude undo retains the exact native record and launch references',
      retained.ref === ref && retained.launchId === launchId && retained.home === home && retained.task === task
        && retained.address === runtime.address && retained.nativeCommand.nativeStore === nativeStore
        && driverError.message.includes('state is unknown'));
  } finally { writeFileSync(journal, before); }
}

// The real Codex driver reaches bind/realize, then a shutdown reply without holder exit is insufficient.
{
  const harness = await installCodex({ binDir: bin });
  const owner = path.join(root, 'auth-owner'); mkdirSync(owner);
  writeFileSync(path.join(owner, 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"fixture"}');
  const ref = 'codex-unconfirmed-exit', launchId = 'codex-unconfirmed-launch', runtime = reserve(codexDriver, ref, launchId);
  runtime.env = { ...process.env, PROMPTOBUS_CODEX_OWNER_HOME: owner };
  runtime.tool.bin = path.join(bin, 'codex');
  const file = codexFile(ref, runtime.env), codexHome = participantCodexHome({ task, address: runtime.address }, runtime.env);
  const socketHome = makeSockDir('pb-native-cleanup-').dir;
  const socket = path.join(socketHome, 'shutdown.sock'), original = new Error('actual Codex realization refused');
  let nativeRecord, revokes = 0, shutdownRequest, acceptShutdown = true;
  const server = createServer(client => client.once('data', data => {
    shutdownRequest = JSON.parse(String(data));
    client.end(`${JSON.stringify({ ok: acceptShutdown, stopped: acceptShutdown, note: 'fixture native shutdown declined' })}\n`);
  }));
  await new Promise(resolve => server.listen(socket, resolve));
  const plan = { argv: [], files: [], cwd: root, prompt: 'fixture', settings: {}, trustProject: false, codexHome,
    mcpConfig: { mcpServers: {} }, prelaunchBinding: { sessionRecord: file },
    service: { launchId, beforeStart: async () => {}, realize: async () => {
      nativeRecord = readCodex(ref, runtime.env);
      writeCodex({ ...nativeRecord, holderPid: process.pid, rpcSocket: socket }, runtime.env);
      throw original;
    }, revoke: async () => { revokes += 1; } } };
  try {
    const { driverError, callerError } = await driverAndCaller(codexDriver, plan, runtime);
    check('actual Codex driver retains record and home when shutdown answered but waitStopped returned false',
      driverError instanceof AggregateError && driverError.errors[0] === original && driverError.cause === original
        && driverError.errors[1].message.includes('did not confirm exit') && callerError === driverError && revokes === 1
        && existsSync(file) && existsSync(codexHome) && readCodex(ref, runtime.env).threadId === nativeRecord.threadId,
      driverError?.stack);
    check('Codex cleanup asks the captured launch generation without inventing native Stop evidence',
      shutdownRequest?.launchId === launchId && !readCodex(ref, runtime.env).stopConfirmed);
    acceptShutdown = false;
    let declined;
    try { await reapCodex(ref, runtime.env, 5); } catch (error) { declined = error; }
    check('Codex reap rejects a resolved but declined native shutdown and retains the owned record',
      declined?.message.includes('fixture native shutdown declined') && existsSync(file));
  } finally {
    if (nativeRecord) { writeCodex(nativeRecord, runtime.env); await reapCodex(ref, runtime.env); }
    await new Promise(resolve => server.close(resolve));
    rmSync(socketHome, { recursive: true, force: true });
    harness.restore();
  }
}

// Unknown native creation retains its owned process and records without native cleanup.
{
  const ref = 'opencode-unconfirmed-exit', launchId = 'opencode-unconfirmed-launch', runtime = reserve(opencodeDriver, ref, launchId);
  const file = participantSessionPath(home, task, runtime.address), original = new Error('actual OpenCode session create refused');
  const fetch0 = globalThis.fetch, kill0 = process.kill;
  let owned, revokes = 0, signals = [], deletes = 0;
  writeFileSync(path.join(root, 'serve'), `const{writeFileSync}=require('node:fs');
writeFileSync(process.env.OPENCODE_DB,'SQLite format 3\\0',{mode:0o600});
console.log('server listening on http://127.0.0.1:32124');setInterval(()=>{},1000);`);
  globalThis.fetch = async (_url, options) => {
    owned = JSON.parse(readFileSync(file, 'utf8'));
    if (options.method === 'POST') throw original;
    if (options.method === 'DELETE') deletes += 1;
    return new Response('[]', { status: 200 });
  };
  process.kill = (pid, signal) => {
    if (owned && Math.abs(pid) === owned.holderPid && signal !== 0) { signals.push(signal); return true; }
    return kill0(pid, signal);
  };
  const plan = { argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'],
    files: [], cwd: root, env: { ...process.env, XDG_DATA_HOME: root, OPENCODE_DB: path.join(root, `${ref}.db`) },
    prompt: 'fixture', holder: { password: 'fixture' }, permissionPollMs: 0,
    service: { launchId, beforeStart: async () => {}, realize: async () => {}, revoke: async () => { revokes += 1; } } };
  try {
    const { driverError, callerError } = await driverAndCaller(opencodeDriver, plan, runtime);
    check('actual OpenCode driver preserves primary error and exact refs when native creation is unresolved',
      driverError instanceof AggregateError && driverError.errors[0] === original && driverError.cause === original
        && driverError.errors[1].message.includes('native creation/admission is unresolved') && callerError === driverError && revokes === 1
        && existsSync(file) && processState(owned.holderProcess) === 'alive'
        && JSON.parse(readFileSync(file, 'utf8')).holderPid === owned.holderPid, driverError?.stack);
    check('OpenCode unknown create retains its pending endpoint without API deletion or either owned signal stage',
      !!owned.nativeCreationPending?.endpoint && !owned.sessionId && !!owned.holderProcess?.birth && deletes === 0 && signals.length === 0);
  } finally {
    process.kill = kill0; globalThis.fetch = fetch0;
    if (owned) await reapOpenCode(owned.holderPid, { identity: owned.holderProcess });
  }
}

{
  const kill0 = process.kill;
  let signals = 0;
  process.kill = (pid, signal) => {
    if (Math.abs(pid) === process.pid && signal !== 0) { signals += 1; return true; }
    return kill0(pid, signal);
  };
  try {
    let malformed;
    try { await reapOpenCode(process.pid, { identity: { pid: process.pid, birth: 'different-owned-process-generation' }, graceMs: 1, stepMs: 1 }); }
    catch (error) { malformed = error; }
    check('OpenCode cleanup refuses incomparable birth without signaling its live occupant', malformed instanceof Error && signals === 0);
    const occupant = requireProcess();
    let priorBirth;
    if (occupant.birth.startsWith('v2:linux:')) priorBirth = occupant.birth.replace(/:(\d+)$/, (_, ticks) => `:${BigInt(ticks) > 0n ? BigInt(ticks) - 1n : 1n}`);
    else if (occupant.birth.startsWith('v2:darwin:utc-c:')) {
      const date = new Date(`${occupant.birth.slice('v2:darwin:utc-c:'.length)} GMT`); date.setUTCSeconds(date.getUTCSeconds() - 1);
      const [weekday, , month, year, time] = date.toUTCString().split(' ');
      priorBirth = `v2:darwin:utc-c:${weekday.slice(0, -1)} ${month} ${date.getUTCDate()} ${time} ${year}`;
    } else throw new Error('Owned cleanup fixture requires a comparable captured process birth');
    await reapOpenCode(process.pid, { identity: { ...occupant, birth: priorBirth }, graceMs: 1, stepMs: 1 });
    check('OpenCode cleanup never signals a live PID reused by a different process generation', signals === 0 && processState(occupant) === 'alive');
  } finally { process.kill = kill0; }
}

// A real Cursor fixture creates the native session; failed marks and revoke retain its actual identity.
{
  const harness = await installCursor({ binDir: bin });
  const ref = 'cursor-mark-error', launchId = 'cursor-mark-launch', runtime = reserve(cursorDriver, ref, launchId);
  runtime.tool.bin = path.join(bin, 'cursor-agent');
  const file = cursorFile(ref, process.env), cleanup = new Error('Cursor owned credential revoke refused');
  const hook = path.join(root, 'native-hook.mjs');
  const priorConfig = process.env.CURSOR_CONFIG_DIR;
  process.env.CURSOR_CONFIG_DIR = path.join(root, 'cursor-native'); mkdirSync(process.env.CURSOR_CONFIG_DIR, { mode: 0o700 });
  symlinkSync(realpathSync(process.execPath), path.join(bin, 'node'));
  writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(bin, 'cursor-agent'), '#!/bin/bash\nSCRIPT_DIR="${0%/*}"\nNODE_BIN="$SCRIPT_DIR/node"\nexec -a "$0" "$NODE_BIN" "$SCRIPT_DIR/index.js" "$@"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, 'index.js'), `import crypto from 'node:crypto';import path from 'node:path';
import{mkdirSync,writeFileSync,openSync}from'node:fs';import{syncBuiltinESMExports}from'node:module';
import{agentMain}from${JSON.stringify(path.join(import.meta.dirname, 'harness-cursor.mjs'))};
const argv=process.argv.slice(2);
if(argv[0]==='create-chat'){console.log(crypto.randomUUID());}
else{
 if(argv[0]==='persist'&&!['list','stop','attach','__session'].includes(argv[1])){
  const id=argv[argv.indexOf('--resume')+1],original=crypto.randomUUID;process.env.PB_FIXTURE_CURSOR_CWD=process.cwd();
  crypto.randomUUID=()=>{crypto.randomUUID=original;syncBuiltinESMExports();return id;};syncBuiltinESMExports();
 }
 if(argv[0]==='persist'&&argv[1]==='__session'){
  const plan=JSON.parse(Buffer.from(argv[2],'base64').toString('utf8'));
  const file=path.join(process.env.CURSOR_CONFIG_DIR,'chats',crypto.createHash('md5').update(path.resolve(process.env.PB_FIXTURE_CURSOR_CWD)).digest('hex'),plan.chatId,'store.db');
  mkdirSync(path.dirname(file),{recursive:true,mode:0o700});writeFileSync(file,'SQLite format 3\\0',{mode:0o600});openSync(file,'r+');
 }
 await agentMain(argv);
}
`);
  writeFileSync(hook, `import {readFileSync,realpathSync} from 'node:fs';
import{bindManagedNativeStart}from${JSON.stringify(path.join(import.meta.dirname, '../lib/drivers.js'))};
import{recordVersion}from${JSON.stringify(path.join(import.meta.dirname, '../lib/service-state.js'))};
import{observeRootProcess,processExecutable,processParent,isSupportedPosixShell}from${JSON.stringify(path.join(import.meta.dirname, '../lib/root-process.js'))};
const event=JSON.parse(readFileSync(0,'utf8'));
if(event.hook_event_name==='sessionStart'){
 const file=process.env.PROMPTOBUS_CURSOR_SESSION,record=JSON.parse(readFileSync(file,'utf8'));
 const version=recordVersion(file),executable=record.nativeCommand.executable;
 let native=await observeRootProcess(process.ppid);
 if(native&&await isSupportedPosixShell(native)){const parent=await processParent(native.pid);native=parent?await observeRootProcess(parent):null;}
 if(!native||await processExecutable(native)!==executable.file)throw new Error('Owned Cursor hook has no matching native runtime');
 bindManagedNativeStart({harness:'cursor',home:record.home,task:record.task,address:record.address,ref:record.ref,
 record:file,launchId:record.launchId,nativeId:event.conversation_id,transcript:event.transcript_path,nativeProcessEvidence:{version,process:native,executable}});
}`);
  stubCommand(bin, 'tmux', `import {tmuxMain} from ${JSON.stringify(path.join(import.meta.dirname, 'harness-cursor.mjs'))};
const args=process.argv.slice(2);
if(args.includes('set-option')&&args.includes('@promptobus_task')){console.error('fixture task mark refused');process.exitCode=1;}
else await tmuxMain(args,{...process.env,PROMPTOBUS_E2E_CURSOR:${JSON.stringify(harness.home)}});`);
  planParticipant(harness.home, runtime.address, { turns: [{ hang: true }] });
  const plan = cursorDriver.prepare({ ref, role: 'worker', model: cursorDriver.options.defaultModel, root, cwd: root,
    home, task, address: runtime.address, prompt: 'fixture', env: process.env, skillsRoot: null,
    mcp: { servers: {}, home, task, address: runtime.address }, guardCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` });
  let revokes = 0, liveAtRevoke = false;
  plan.service = { launchId, beforeStart: async () => {}, realize: async () => {}, revoke: async () => {
    revokes += 1;
    const saved = readCursor(ref), observed = readTmuxSessions().sessions?.find(session => session.chatId === saved.chatId);
    liveAtRevoke = !!observed;
    throw cleanup;
  } };
  for (const entry of plan.files) { mkdirSync(path.dirname(entry.path), { recursive: true }); writeFileSync(entry.path, entry.text); }
  try {
    const { driverError, callerError } = await driverAndCaller(cursorDriver, plan, runtime), saved = readCursor(ref);
    const actual = readTmuxSessions().sessions?.find(session => session.name === saved?.sessionName);
    check('actual Cursor mark refusal revokes before any native stop and retains discovered native references on revoke failure',
      liveAtRevoke && !!actual && saved.chatId === actual.chatId && saved.panePid === actual.panePid
        && saved.workspaceHash === actual.hash && !!actual.hash && saved.launchId === launchId && revokes === 1
        && driverError instanceof AggregateError && driverError.errors[1] === cleanup && callerError === driverError
        && driverError.errors[0].message.includes('fixture task mark refused') && driverError.message.includes(file), driverError?.stack);
  } finally {
    const stopped = await cursorDriver.stop(ref);
    check('Cursor failure fixture confirms its own native session exit', stopped.ok && stopped.stopped, stopped.note);
    harness.restore();
    if (priorConfig === undefined) delete process.env.CURSOR_CONFIG_DIR; else process.env.CURSOR_CONFIG_DIR = priorConfig;
  }
}

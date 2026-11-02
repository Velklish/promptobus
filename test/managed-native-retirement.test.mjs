import { check } from './check.mjs';
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStandaloneHost } from '../dist/host-index.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { readSession as readCursor, readTmuxSessions, sessionFile as cursorFile, dropSession as dropCursor } from '../lib/cursor-persist.js';
import { createHarnessRegistry } from '../lib/harness-registry.js';
import { reapHolder } from '../lib/opencode-session.js';
import { serviceControl } from '../lib/service-client.js';
import { processState, readDiscovery, readPrivate, requireProcess, runtimeIdentity, servicePaths } from '../lib/service-state.js';
import { createOwnerEnvironment, finalizeManagedServiceLaunch, revokeFailedManagedLaunch } from '../lib/service-launch.js';
import { createTask, participantOf, participantRecord, participantSessionPath, readTask, upsertParticipant, withTaskLock, writeJsonAtomic } from '../lib/store.js';
import { installHarness, planParticipant } from './harness-cursor.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('pb-native-retirement-'));
writeHostConfig(root, { tools: ['cursor', 'opencode'] });
const host = createStandaloneHost({ cwd: root }), home = host.promptobusHome(), task = 'retirement-t20261101-000001';
createTask(home, { id: task, title: 'Owned native retirement races' });
const priorOpenCode = process.env.PROMPTOBUS_OPENCODE_HOME;
process.env.PROMPTOBUS_OPENCODE_HOME = path.join(root, 'opencode-registry');
const serviceHome = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-retirement-'));
const serviceEnv = { ...process.env, PROMPTOBUS_HOME: home, PROMPTOBUS_SERVICE_HOME: serviceHome,
  PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_SERVICE_IDLE_MS: '60000' };
for (const key of Object.keys(serviceEnv)) if (/^PROMPTOBUS_(CLIENT_|ROOT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$)/.test(key)) delete serviceEnv[key];
const serviceBin = path.resolve(import.meta.dirname, '../bin/promptobus.js');
const version = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version;
const serviceHost = createStandaloneHost({ cwd: root, binPath: serviceBin, version });
const paths = servicePaths(serviceHost, serviceEnv), launches = [], promptFailures = new Map();
let serviceError, serviceStderr = '';
let owner = cp.spawn(process.execPath, [serviceBin, 'service', 'run'], { cwd: root, env: serviceEnv, stdio: ['ignore', 'ignore', 'pipe'] });
owner.stderr.on('data', bytes => { serviceStderr += bytes; }); owner.once('error', error => { serviceError = error; });
let running = new Promise(resolve => owner.once('close', resolve));
let ownerEnvironment;
const registry = createHarnessRegistry({ harness: 'opencode' });
const body = `const{writeFileSync}=require('node:fs');writeFileSync(process.env.OPENCODE_DB,'SQLite format 3\\0',{mode:0o600});
console.log('server listening on http://127.0.0.1:32124');setInterval(()=>{},1000);`;
writeFileSync(path.join(root, 'serve'), body);
const spawn = cp.spawn, fetch = globalThis.fetch, kill = process.kill, children = [], onExit = new Map();
let apiSequence = 0, deleted = [], successorSignals = [], protectedProcess = null;
const stat0 = fs.statSync, atRetirement = new Map();
fs.statSync = (file, ...args) => {
  const pending = atRetirement.get(file);
  if (pending && processState(pending.process) === 'dead') { atRetirement.delete(file); pending.publish(); }
  return stat0(file, ...args);
};
cp.spawn = (...args) => {
  const child = spawn(...args);
  if (args[0] === realpathSync(process.execPath) && args[1]?.[0] === 'serve' && args[2]?.cwd === root) {
    children.push(child);
    child.once('spawn', () => { child.ownedIdentity = requireProcess(child.pid); });
    child.once('exit', () => onExit.get(child.pid)?.());
  }
  return child;
};
syncBuiltinESMExports();
process.kill = (pid, signal) => {
  if (protectedProcess && Math.abs(pid) === protectedProcess.pid && signal !== 0) successorSignals.push(signal);
  return kill(pid, signal);
};
globalThis.fetch = async (url, options) => {
  const route = new URL(url).pathname;
  if (options.method === 'POST' && route === '/api/session') return new Response(JSON.stringify({ data: { id: `owned-api-${++apiSequence}` } }), { status: 200 });
  const prompt = route.match(/^\/api\/session\/([^/]+)\/prompt$/);
  if (options.method === 'POST' && prompt && promptFailures.has(prompt[1])) await promptFailures.get(prompt[1])();
  if (options.method === 'DELETE') deleted.push(route);
  return new Response(JSON.stringify([]), { status: 200 });
};

async function openCode(ref, fail = null, beforeAdmission = false) {
  const address = `worker:${ref}`, launchId = `${ref}-launch`, file = participantSessionPath(home, task, address);
  upsertParticipant(home, task, participantRecord(address, { harness: 'opencode', mode: 'managed', sessionRef: ref }));
  let revocation, revokes = 0;
  const plan = { launchId, argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'], files: [], cwd: root,
    env: { ...serviceEnv, XDG_DATA_HOME: root, OPENCODE_DB: path.join(root, `${ref}.db`) }, prompt: 'fixture',
    mcpConfig: { mcp: {} }, holder: { password: 'fixture' }, permissionPollMs: 0 };
  await finalizeManagedServiceLaunch(serviceHost, { launch: plan, driver: opencodeDriver, home, task, address, ref, cwd: root,
    env: { ...serviceEnv, PROMPTOBUS_OWNER_ENV_FILE: ownerEnvironment }, commonEnv: serviceEnv });
  launches.push(plan.service);
  const { realize, revoke } = plan.service;
  plan.service.realize = async id => {
    if (beforeAdmission) return fail(JSON.parse(readFileSync(file, 'utf8')));
    await realize(id);
    const grant = readPrivate(plan.service.credentialFile);
    if (grant?.nativeBinding?.state !== 'bound' || grant.nativeBinding.kind !== 'opencode' || grant.nativeBinding.sessionId !== id) {
      throw new Error('Owned retirement fixture did not realize its exact native grant');
    }
    if (fail) promptFailures.set(id, () => fail(JSON.parse(readFileSync(file, 'utf8'))));
  };
  plan.service.revoke = () => revocation ??= (async () => { revokes += 1; await revoke(); })();
  let error;
  try {
    await opencodeDriver.spawn(plan, { tool: { bin: process.execPath }, host: serviceHost, home, task, address, ref, role: 'worker', cwd: root,
      env: serviceEnv, persist: (id, _state, full) => {
        const p = participantOf(readTask(home, task), address);
        upsertParticipant(home, task, { ...p, metadata: { ...p.metadata, sessionRecord: file, sessionId: full } });
      } });
  } catch (caught) { error = caught; }
  return { ref, address, file, plan, error, get revokes() { return revokes; }, record: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null };
}

try {
  const deadline = Date.now() + 5000;
  while (!readDiscovery(paths) && !serviceError && owner.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (serviceError) throw serviceError;
  if (readDiscovery(paths)?.process.pid !== owner.pid) throw new Error(`Owned retirement fixture service did not start: ${serviceStderr}`);
  ownerEnvironment = createOwnerEnvironment(serviceHost, serviceEnv);
  const unknownError = new Error('owned OpenCode realization refused before admission');
  let unknownRecord, unknownBytes, unknownRegistry, unknownParticipant;
  deleted = []; successorSignals = [];
  const unknown = await openCode('opencode-before-admission', async record => {
    unknownRecord = record; protectedProcess = record.holderProcess;
    unknownBytes = readFileSync(participantSessionPath(home, task, record.address), 'utf8');
    unknownRegistry = readFileSync(registry.sessionFile(record.ref), 'utf8');
    unknownParticipant = JSON.stringify(participantOf(readTask(home, task), record.address));
    throw unknownError;
  }, true);
  let callerError; try { await revokeFailedManagedLaunch(unknown.plan, unknown.error); } catch (error) { callerError = error; }
  check('OpenCode pre-admission realization failure retains exact owned native state without API cleanup or holder signals',
    unknown.error instanceof AggregateError && unknown.error.errors[0] === unknownError && unknown.error.cause === unknownError
      && /native creation\/admission is unresolved/.test(unknown.error.errors[1]?.message) && callerError === unknown.error && unknown.revokes === 1
      && readFileSync(unknown.file, 'utf8') === unknownBytes && readFileSync(registry.sessionFile(unknown.ref), 'utf8') === unknownRegistry
      && JSON.stringify(participantOf(readTask(home, task), unknown.address)) === unknownParticipant
      && processState(unknownRecord.holderProcess) === 'alive' && deleted.length === 0 && successorSignals.length === 0,
    unknown.error?.stack);
  protectedProcess = null;
  for (const operation of ['startup', 'stop', 'sweep']) for (const replacement of [false, true]) {
    const name = `opencode-${operation}-${replacement ? 'replacement' : 'control'}`, original = new Error(`${name} first prompt refused after native admission`);
    const successor = replacement ? await openCode(`${name}-successor`) : null;
    if (successor?.error) throw successor.error;
    let snapshot, oldRecord;
    const arm = record => {
      oldRecord = record;
      if (!replacement) return;
      protectedProcess = successor.record.holderProcess; successorSignals = [];
      let published = false;
      const publish = () => {
        if (published) return; published = true;
        const next = { ...successor.record, ref: record.ref, home, task, address: record.address,
          launchId: `${name}-replacement-generation`, log: record.log };
        withTaskLock(home, task, () => {
          writeJsonAtomic(participantSessionPath(home, task, record.address), next, { mode: 0o600 });
          registry.writeSession({ ref: record.ref, recordPath: participantSessionPath(home, task, record.address),
            sessionId: next.sessionId, launchId: next.launchId, home, task, address: record.address });
          upsertParticipant(home, task, participantRecord(record.address, { harness: 'opencode', mode: 'managed', sessionRef: record.ref,
            sessionId: next.sessionId, sessionRecord: participantSessionPath(home, task, record.address), replacementMarker: name }));
          snapshot = { record: readFileSync(participantSessionPath(home, task, record.address), 'utf8'),
            registry: readFileSync(registry.sessionFile(record.ref), 'utf8'), participant: JSON.stringify(participantOf(readTask(home, task), record.address)) };
        });
      };
      onExit.set(record.holderPid, publish);
      atRetirement.set(participantSessionPath(home, task, record.address), { process: record.holderProcess, publish });
    };
    let current, failure, result, selected;
    deleted = [];
    if (operation === 'startup') {
      current = await openCode(name, async record => { arm(record); throw original; });
      failure = current.error;
    } else {
      current = await openCode(name);
      if (current.error) throw current.error;
      arm(current.record);
      selected = participantOf(readTask(home, task), current.address);
      try {
        result = operation === 'stop' ? await opencodeDriver.stop(name)
          : await opencodeDriver.sweepParticipant(selected, task);
      } catch (error) { failure = error; }
    }
    const operationDeletes = [...deleted];
    if (replacement) {
      check(`${name}: actual old holder exit publishes the replacement before retirement, which retains exact primary/registry/pointer bytes`,
        !!snapshot && existsSync(current.file) && existsSync(registry.sessionFile(name)) && readFileSync(current.file, 'utf8') === snapshot.record
          && readFileSync(registry.sessionFile(name), 'utf8') === snapshot.registry
          && JSON.stringify(participantOf(readTask(home, task), current.address)) === snapshot.participant
          && processState(oldRecord.holderProcess) === 'dead' && processState(successor.record.holderProcess) === 'alive'
          && successorSignals.length === 0 && !!failure, failure?.stack);
      if (operation === 'startup') {
        let callerError;
        try { await revokeFailedManagedLaunch(current.plan, failure); } catch (error) { callerError = error; }
        check(`${name}: caller preserves the native failure plus replacement-retirement refusal without another cleanup`,
          failure instanceof AggregateError && failure.errors[0] === original && failure.cause === original
            && /changed ownership during native cleanup/.test(failure.errors[1]?.message) && callerError === failure && current.revokes === 1, failure?.stack);
      }
      if (selected) {
        const beforeDeletes = deleted.length;
        let stale;
        try { await opencodeDriver.sweepParticipant(selected, task); } catch (error) { stale = error; }
        check(`${name}: a stale selected participant cannot sweep the current replacement before snapshot capture`,
          /changed its selected native identity/.test(stale?.message ?? '') && deleted.length === beforeDeletes && processState(successor.record.holderProcess) === 'alive'
            && existsSync(current.file) && readFileSync(current.file, 'utf8') === snapshot.record);
      }
      protectedProcess = null;
      const stopped = await opencodeDriver.stop(successor.ref);
      check(`${name}: fixture separately cleans its actual successor through its original owned seat`, stopped.ok && stopped.stopped);
      registry.dropSession(name); rmSync(current.file, { force: true }); rmSync(`${current.file}.holder.log`, { force: true });
    } else {
      check(`${name}: confirmed native cleanup retires unchanged owned records instead of refusing every cleanup`,
        !existsSync(current.file) && !existsSync(registry.sessionFile(name)) && processState(oldRecord.holderProcess) === 'dead'
          && (operation === 'startup' ? failure === original && current.revokes === 1
            : operation === 'stop' ? result?.ok && result.stopped : result?.swept === 1), failure?.stack);
    }
    check(`${name}: the awaited actual delete/reap path never deletes the successor native API session`,
      operation === 'startup' ? !operationDeletes.length : operationDeletes.length === 1 && operationDeletes[0] === `/api/session/${oldRecord.sessionId}`,
      JSON.stringify(operationDeletes));
    onExit.delete(oldRecord.holderPid); atRetirement.delete(current.file);
  }
  const successor = await openCode('empty-stop-successor');
  if (successor.error) throw successor.error;
  const ref = 'empty-stop-old-entry', missing = path.join(root, 'old-missing-record.json');
  registry.writeSession({ ref, home, task, address: 'worker:empty-old', recordPath: missing, sessionId: 'old-known-api-id' });
  const stat = fs.statSync;
  let published = false, expected, failure;
  fs.statSync = (file, ...args) => {
    if (!published && file === registry.sessionFile(ref)) {
      published = true;
      registry.writeSession({ ...registry.readSession(successor.ref), ref });
      expected = readFileSync(registry.sessionFile(ref), 'utf8');
    }
    return stat(file, ...args);
  };
  syncBuiltinESMExports();
  const beforeDeletes = deleted.length;
  try { await opencodeDriver.stop(ref); } catch (error) { failure = error; }
  finally { fs.statSync = stat; syncBuiltinESMExports(); }
  check('OpenCode empty-record Stop cannot drop an actual successor entry published between its initial read and lock snapshot',
    published && /changed before empty retirement/.test(failure?.message ?? '') && existsSync(registry.sessionFile(ref))
      && readFileSync(registry.sessionFile(ref), 'utf8') === expected && deleted.length === beforeDeletes
      && processState(successor.record.holderProcess) === 'alive', failure?.stack);
  registry.dropSession(ref);
  const stopped = await opencodeDriver.stop(successor.ref);
  check('empty-record replacement fixture separately cleans its original actual owned successor', stopped.ok && stopped.stopped);
} finally {
  cp.spawn = spawn; globalThis.fetch = fetch; process.kill = kill; fs.statSync = stat0; atRetirement.clear(); syncBuiltinESMExports();
  for (const child of children) if (child.ownedIdentity && processState(child.ownedIdentity) === 'alive') await reapHolder(child.pid, { identity: child.ownedIdentity });
  for (const launch of launches) if (existsSync(launch.credentialFile)) await launch.revoke();
  if (owner.exitCode === null && owner.signalCode === null) {
    if (!serviceError && readDiscovery(paths)?.process.pid === owner.pid) await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(serviceHost) });
    else owner.kill('SIGTERM');
  }
  await running;
  rmSync(serviceHome, { recursive: true, force: true });
  if (priorOpenCode === undefined) delete process.env.PROMPTOBUS_OPENCODE_HOME; else process.env.PROMPTOBUS_OPENCODE_HOME = priorOpenCode;
}
if (serviceError) throw serviceError;

const bin = path.join(root, 'bin'), harness = await installHarness({ binDir: bin });
const hook = path.join(root, 'native-start.mjs'), fault = path.join(root, 'cursor-retirement-packet.json');
const tornBarrier = path.join(root, 'cursor-torn-barrier.json');
const priorConfig = process.env.CURSOR_CONFIG_DIR;
process.env.CURSOR_CONFIG_DIR = path.join(root, 'cursor-native'); mkdirSync(process.env.CURSOR_CONFIG_DIR, { mode: 0o700 });
symlinkSync(realpathSync(process.execPath), path.join(bin, 'node'));
writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
writeFileSync(path.join(bin, 'cursor-agent'), '#!/bin/bash\nSCRIPT_DIR="${0%/*}"\nNODE_BIN="$SCRIPT_DIR/node"\nexec -a "$0" "$NODE_BIN" "$SCRIPT_DIR/index.js" "$@"\n', { mode: 0o755 });
writeFileSync(hook, `import {readFileSync,realpathSync} from 'node:fs';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {bindManagedNativeStart} from ${JSON.stringify(path.join(import.meta.dirname, '../lib/drivers.js'))};
import{recordVersion}from${JSON.stringify(path.join(import.meta.dirname, '../lib/service-state.js'))};
import{observeRootProcess,processExecutable,processParent,isSupportedPosixShell}from${JSON.stringify(path.join(import.meta.dirname, '../lib/root-process.js'))};
const event=JSON.parse(readFileSync(0,'utf8'));
if(event.hook_event_name==='sessionStart'){const file=process.env.PROMPTOBUS_CURSOR_SESSION,record=JSON.parse(readFileSync(file,'utf8'));
const version=recordVersion(file),executable=record.nativeCommand.executable;let native=await observeRootProcess(process.ppid);
if(native&&await isSupportedPosixShell(native)){const parent=await processParent(native.pid);native=parent?await observeRootProcess(parent):null;}
if(!native||await processExecutable(native)!==executable.file)throw new Error('Owned Cursor hook has no matching native runtime');
const barrier=fs.existsSync(${JSON.stringify(tornBarrier)})?JSON.parse(readFileSync(${JSON.stringify(tornBarrier)},'utf8')):null;
if(barrier?.record===file){const rename=fs.renameSync;fs.renameSync=function(from,to,...rest){
if(to===barrier.taskJson&&!fs.existsSync(barrier.entered)){fs.writeFileSync(barrier.entered,'record published, participant held under the task lock');
const edge=Date.now()+15000;while(!fs.existsSync(barrier.release)&&Date.now()<edge)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}
return rename.call(this,from,to,...rest);};syncBuiltinESMExports();}
bindManagedNativeStart({harness:'cursor',home:record.home,task:record.task,address:record.address,ref:record.ref,
record:file,launchId:record.launchId,nativeId:event.conversation_id,transcript:event.transcript_path,nativeProcessEvidence:{version,process:native,executable}});
if(barrier?.record===file)fs.writeFileSync(barrier.finished,'record and participant published');}
`);
writeFileSync(path.join(bin, 'index.js'), `import crypto from 'node:crypto';import path from 'node:path';
import {existsSync,mkdirSync,openSync,readFileSync,writeFileSync} from 'node:fs';import{syncBuiltinESMExports}from'node:module';
import {agentMain} from ${JSON.stringify(path.join(import.meta.dirname, 'harness-cursor.mjs'))};
import {writeSession} from ${JSON.stringify(path.join(import.meta.dirname, '../lib/cursor-persist.js'))};
import {withTaskLock,upsertParticipant,participantRecord,participantOf,readTask} from ${JSON.stringify(path.join(import.meta.dirname, '../lib/store.js'))};
const argv=process.argv.slice(2);
if(argv[0]==='create-chat'){console.log(crypto.randomUUID());}
else{
if(argv[0]==='persist'&&!['list','stop','attach','__session'].includes(argv[1])){
const id=argv[argv.indexOf('--resume')+1],original=crypto.randomUUID;process.env.PB_FIXTURE_CURSOR_CWD=process.cwd();
crypto.randomUUID=()=>{crypto.randomUUID=original;syncBuiltinESMExports();return id;};syncBuiltinESMExports();}
if(argv[0]==='persist'&&argv[1]==='__session'){
const plan=JSON.parse(Buffer.from(argv[2],'base64').toString('utf8'));
const file=path.join(process.env.CURSOR_CONFIG_DIR,'chats',crypto.createHash('md5').update(path.resolve(process.env.PB_FIXTURE_CURSOR_CWD)).digest('hex'),plan.chatId,'store.db');
mkdirSync(path.dirname(file),{recursive:true,mode:0o700});writeFileSync(file,'SQLite format 3\\0',{mode:0o600});openSync(file,'r+');}
await agentMain(argv);
if(argv[0]==='persist'&&argv[1]==='stop'&&existsSync(${JSON.stringify(fault)})){
const p=JSON.parse(readFileSync(${JSON.stringify(fault)},'utf8'));
if(argv[2]===p.oldName){withTaskLock(p.home,p.task,()=>{
writeSession(p.record);upsertParticipant(p.home,p.task,participantRecord(p.address,p.metadata));
writeFileSync(p.snapshot,JSON.stringify({record:readFileSync(p.file,'utf8'),participant:JSON.stringify(participantOf(readTask(p.home,p.task),p.address))}));});}}
}
`);

const cursorServiceEnv = { ...serviceEnv, ...process.env, PROMPTOBUS_HOME: home, PROMPTOBUS_SERVICE_HOME: serviceHome, PROMPTOBUS_WARDEN: 'off' };
owner = cp.spawn(process.execPath, [serviceBin, 'service', 'run'], { cwd: root, env: cursorServiceEnv, stdio: ['ignore', 'ignore', 'pipe'] });
serviceError = null; serviceStderr = '';
owner.stderr.on('data', bytes => { serviceStderr += bytes; }); owner.once('error', error => { serviceError = error; });
running = new Promise(resolve => owner.once('close', resolve));
async function tornCursor(ref, replace) {
  const files = Object.fromEntries(['entered', 'release', 'finished'].map(name => [name, path.join(root, `${ref}.${name}`)]));
  const taskJson = path.join(home, 'tasks', task, 'task.json'), taskLock = path.join(home, 'tasks', task, '.lock');
  writeFileSync(tornBarrier, JSON.stringify({ record: cursorFile(ref), taskJson, ...files }));
  const stages = [], read = fs.readFileSync, mkdir = fs.mkdirSync;
  let snapshotAfterPublication = false, replaced = null, replacing = false;
  fs.readFileSync = function(file, ...rest) {
    const value = read.call(this, file, ...rest);
    if (file === taskJson && existsSync(files.entered) && !existsSync(files.release)) {
      stages.push('unlocked snapshot read'); writeFileSync(files.release, 'released by an unlocked snapshot');
    } else if (file === taskJson && existsSync(files.release)) snapshotAfterPublication = true;
    return value;
  };
  fs.mkdirSync = function(file, ...rest) {
    if (file !== taskLock || replacing) return mkdir.call(this, file, ...rest);
    if (replace && !replaced && snapshotAfterPublication) {
      replacing = true;
      try {
        const current = participantOf(readTask(home, task), `worker:${ref}`);
        replaced = { original: current, replacement: { ...current, metadata: { ...current.metadata, nativeLaunchId: `${ref}-replacement` } } };
        upsertParticipant(home, task, replaced.replacement);
      } finally { replacing = false; }
    }
    try { return mkdir.call(this, file, ...rest); } catch (error) {
      if (error?.code === 'EEXIST' && existsSync(files.entered) && !existsSync(files.release)) {
        stages.push('contended task lock'); writeFileSync(files.release, 'released by the contended task lock');
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
  try {
    const result = await cursor(ref);
    return { ...result, stages, replaced, entered: existsSync(files.entered), finished: existsSync(files.finished) };
  } finally {
    fs.readFileSync = read; fs.mkdirSync = mkdir; syncBuiltinESMExports(); rmSync(tornBarrier, { force: true });
  }
}
async function cursor(ref, fail = null) {
  const address = `worker:${ref}`, file = cursorFile(ref), launchId = `${ref}-launch`;
  upsertParticipant(home, task, participantRecord(address, { harness: 'cursor', mode: 'managed', sessionRef: ref }));
  planParticipant(harness.home, address, { turns: [{ hang: true }] });
  const plan = cursorDriver.prepare({ ref, role: 'worker', model: cursorDriver.options.defaultModel, root, cwd: root, home, task, address,
    prompt: 'fixture', env: process.env, skillsRoot: null, mcp: { servers: {}, home, task, address },
    guardCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` });
  plan.launchId = launchId;
  await finalizeManagedServiceLaunch(serviceHost, { launch: plan, driver: cursorDriver, home, task, address, ref, cwd: root,
    env: { ...cursorServiceEnv, PROMPTOBUS_OWNER_ENV_FILE: ownerEnvironment }, commonEnv: cursorServiceEnv });
  launches.push(plan.service);
  const { realize, revoke } = plan.service;
  let revocation, revokes = 0, native, bytesAtRealize;
  plan.service.realize = async id => {
    await realize(id);
    const client = readPrivate(plan.service.credentialFile);
    if (client?.nativeBinding?.state !== 'bound' || client.nativeBinding.kind !== 'cursor' || client.nativeBinding.sessionId !== id) {
      throw new Error('Owned Cursor fixture did not realize its exact native grant');
    }
    native = readCursor(ref); bytesAtRealize = readFileSync(file, 'utf8');
    if (fail) await fail(native);
  };
  plan.service.revoke = () => revocation ??= (async () => { revokes += 1; await revoke(); })();
  for (const file of plan.files) { mkdirSync(path.dirname(file.path), { recursive: true }); writeFileSync(file.path, file.text); }
  let error;
  try {
    await cursorDriver.spawn(plan, { tool: { bin: path.join(bin, 'cursor-agent') }, host: serviceHost, home, task, address, ref, role: 'worker', cwd: root,
      env: process.env, persist: (_name, _state, full) => {
        const p = participantOf(readTask(home, task), address);
        upsertParticipant(home, task, { ...p, metadata: { ...p.metadata, sessionRecord: file, sessionId: full } });
      } });
  } catch (caught) { error = caught; }
  return { ref, address, file, plan, error, native, bytesAtRealize, get revokes() { return revokes; } };
}
try {
  const edge = Date.now() + 5000;
  while (!readDiscovery(paths) && !serviceError && owner.exitCode === null && Date.now() < edge) await new Promise(resolve => setTimeout(resolve, 10));
  if (serviceError) throw serviceError;
  if (readDiscovery(paths)?.process.pid !== owner.pid) throw new Error(`Owned Cursor fixture service did not start: ${serviceStderr}`);
  ownerEnvironment = createOwnerEnvironment(serviceHost, cursorServiceEnv);
  const original = new Error('Cursor realize response failed after its owner commit');
  const unknown = await cursor('cursor-uncertain-realize', async () => { throw original; });
  let callerError; try { await revokeFailedManagedLaunch(unknown.plan, unknown.error); } catch (error) { callerError = error; }
  check('Cursor realize-response failure retains exact native state and never treats the committed callback as confirmed admission',
    unknown.error instanceof AggregateError && unknown.error.errors[0] === original && unknown.error.cause === original
      && /native creation\/admission is unresolved/.test(unknown.error.errors[1]?.message) && callerError === unknown.error && unknown.revokes === 1
      && readFileSync(unknown.file, 'utf8') === unknown.bytesAtRealize
      && readTmuxSessions().sessions.some(session => session.name === unknown.native.sessionName), unknown.error?.stack);
  const unknownStopped = await cursorDriver.stop(unknown.ref);
  check('Cursor uncertain-realization fixture separately stops its unchanged actual native session', unknownStopped.ok && unknownStopped.stopped, unknownStopped.note);
  const torn = await tornCursor('cursor-torn-snapshot', false);
  const tornParticipant = participantOf(readTask(home, task), torn.address), tornRecord = readCursor(torn.ref);
  check('a Cursor hook publication held between its record and participant writes is admitted only from one consistent snapshot',
    !torn.error && torn.entered && torn.finished && JSON.stringify(torn.stages) === '["contended task lock"]'
      && tornParticipant?.metadata.sessionId === tornRecord?.chatId && !!tornRecord?.nativeAdmission,
    JSON.stringify({ stages: torn.stages, entered: torn.entered, finished: torn.finished, error: torn.error?.message }));
  const tornStopped = await cursorDriver.stop(torn.ref);
  check('the consistent-snapshot fixture separately stops its actual native session', tornStopped.ok && tornStopped.stopped, tornStopped.note);
  const replacedTorn = await tornCursor('cursor-torn-replaced', true);
  check('a real participant replacement after the consistent snapshot still refuses Cursor admission',
    !!replacedTorn.replaced && /changed its exact owner generation/.test(replacedTorn.error?.message ?? '')
      && !readCursor(replacedTorn.ref)?.nativeAdmission
      && participantOf(readTask(home, task), replacedTorn.address)?.metadata.nativeLaunchId === `${replacedTorn.ref}-replacement`,
    JSON.stringify({ stages: replacedTorn.stages, replaced: !!replacedTorn.replaced, error: replacedTorn.error?.message }));
  if (replacedTorn.replaced) upsertParticipant(home, task, replacedTorn.replaced.original);
  const replacedStopped = await cursorDriver.stop(replacedTorn.ref);
  check('the refused replacement fixture separately stops its actual native session', replacedStopped.ok && replacedStopped.stopped, replacedStopped.note);
  for (const replacement of [false, true]) {
    const ref = `cursor-${replacement ? 'replacement' : 'control'}`;
    const successor = replacement ? await cursor(`${ref}-successor`) : null;
    if (successor?.error) throw successor.error;
    const current = await cursor(ref);
    if (current.error) throw current.error;
    const snapshotFile = path.join(root, `${ref}.snapshot.json`);
    if (replacement) writeFileSync(fault, JSON.stringify({ oldName: current.native.sessionName, home, task, address: current.address,
      file: cursorFile(ref), snapshot: snapshotFile,
      record: { ...successor.native, ref, home, task, address: current.address, launchId: `${ref}-replacement-generation` },
      metadata: { harness: 'cursor', mode: 'managed', sessionRef: ref, sessionId: successor.native.chatId,
        sessionRecord: cursorFile(ref), replacementMarker: ref } }));
    const stopped = await cursorDriver.stop(ref);
    if (replacement) {
      const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
      check('Cursor actual public Stop completion cannot retire a newer record or overwrite its participant pointer',
        !stopped.ok && !stopped.stopped && /registry revision changed during Stop/.test(stopped.note)
          && readFileSync(current.file, 'utf8') === snapshot.record
          && JSON.stringify(participantOf(readTask(home, task), current.address)) === snapshot.participant
          && !readTmuxSessions().sessions.some(session => session.name === current.native.sessionName)
          && readTmuxSessions().sessions.some(session => session.name === successor.native.sessionName), stopped.note);
      rmSync(fault, { force: true });
      const successorStopped = await cursorDriver.stop(successor.ref);
      check('Cursor replacement fixture separately confirms cleanup of the actual successor through its original seat', successorStopped.ok && successorStopped.stopped, successorStopped.note);
      dropCursor(ref);
    } else check('Cursor confirmed public Stop of an unchanged bound session removes its record',
      stopped.ok && stopped.stopped && !existsSync(current.file)
        && !readTmuxSessions().sessions.some(session => session.name === current.native.sessionName), stopped.note);
  }
} finally {
  rmSync(fault, { force: true });
  for (const launch of launches) if (existsSync(launch.credentialFile)) await launch.revoke();
  if (owner.exitCode === null && owner.signalCode === null) {
    if (!serviceError && readDiscovery(paths)?.process.pid === owner.pid) await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(serviceHost) });
    else owner.kill('SIGTERM');
  }
  await running; rmSync(serviceHome, { recursive: true, force: true }); harness.restore();
  if (priorConfig === undefined) delete process.env.CURSOR_CONFIG_DIR; else process.env.CURSOR_CONFIG_DIR = priorConfig;
}
if (serviceError) throw serviceError;

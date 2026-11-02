import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStandaloneHost } from '../dist/host-index.js';
import { codexDriver, participantCodexHome, removeParticipantHome } from '../lib/driver-codex.js';
import { dropSession, holderAlive, holderLogFile, pidAlive, readSession, sessionFile } from '../lib/codex-session.js';
import { processState } from '../lib/service-state.js';
import { REGISTRY } from '../lib/drivers.js';
import { persistNativeParticipant, releaseNativeReservation, reserveNativeParticipant } from '../lib/native-lifecycle.js';
import * as store from '../lib/store.js';
import { abandon } from '../lib/abandon.js';
import { done } from '../lib/done.js';
import { sweep } from '../lib/sweep.js';
import { capture, expectFail } from './console.mjs';
import { installHarness, planParticipant } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

// Public cleanup uses the real native driver/holder and fixture app-server. The small
// service callback below isolates native cleanup; it does not claim HTTP grant coverage.
const root = realpathSync(makeSandbox('pb-codex-cleanup-policy-'));
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const stub = path.join(root, 'bin', 'codex.stub.mjs');
writeFileSync(stub, `import {existsSync,writeFileSync} from 'node:fs';
const output=process.stdout.write.bind(process.stdout),gate=process.env.PB_CLEANUP_IDLE_GATE;
let completed=false;
process.stdout.write=function(chunk,...args){
 let event;try{event=JSON.parse(String(chunk));}catch{}
 if(event?.method==='turn/completed')completed=true;
 if(gate&&completed&&event?.method==='thread/status/changed'&&event.params?.type==='idle'){
  writeFileSync(gate+'.held','actual idle held');
  const deadline=Date.now()+15000;
  void (async()=>{while(!existsSync(gate+'.release')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
   if(!existsSync(gate+'.release'))writeFileSync(gate+'.timeout','deadline');output(chunk,...args);})();return true;
 }
 return output(chunk,...args);
};
` + readFileSync(stub, 'utf8'));

const owner = path.join(root, 'auth-owner'); mkdirSync(owner);
writeFileSync(path.join(owner, 'auth.json'), '{"stub":"owned fixture account"}\n');
const prior = { owner: process.env.PROMPTOBUS_CODEX_OWNER_HOME, session: process.env.CLAUDE_CODE_SESSION_ID };
process.env.PROMPTOBUS_CODEX_OWNER_HOME = owner;
process.env.CLAUDE_CODE_SESSION_ID = 'cleanup-policy-owner';
const host = createStandaloneHost({ cwd: root, extraEnv: { PROMPTOBUS_WARDEN: 'off' } });
const home = store.canonicalPath(host.promptobusHome()), launched = [], fixtures = [];
const address = 'worker:owned';
let sequence = 0;

function fixture() {
  const task = `codex-cleanup-policy-t20261101-${String(++sequence).padStart(6, '0')}`;
  store.createTask(home, { id: task, title: 'Native versus task-local cleanup', owner: 'cleanup-policy-owner' });
  const ref = `${task}:${address}`;
  const { record: reserved } = reserveNativeParticipant(home, task,
    store.participantRecord(address, { harness: 'codex', mode: 'managed', sessionRef: ref }), null, REGISTRY);
  const nativeHome = participantCodexHome({ task, address });
  const local = [store.participantMcpPath(home, task, address), store.participantSettingsPath(home, task, address),
    store.participantSessionPath(home, task, address), store.wakeFile(home, task, address)];
  const copied = path.join(store.workersDir(home, task), `${store.participantFileStem(address)}.copied-skills`);
  mkdirSync(copied, { recursive: true });
  local.push(path.join(copied, 'SKILL.md'));
  for (const file of local) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `task-local owned sidecar ${file}\n`, { mode: 0o600 });
  }
  const fixture = { task, ref, reserved, nativeHome, local, copied };
  fixtures.push(fixture);
  return fixture;
}
const current = f => store.participantOf(store.readTask(home, f.task), address);
const invoke = (f, operation) => operation === 'sweep'
  ? sweep(host, { task: f.task, address })
  : done(host, { task: f.task, 'keep-sessions': true,
    adapterFor: () => ({ probe: () => ({ available: 'unknown' }) }) });
const localRemoved = f => f.local.every(file => !existsSync(file)) && !existsSync(f.copied);
const closedAsExpected = (f, operation) => store.readTask(home, f.task).status === (operation === 'done' ? 'done' : 'active')
  && (operation !== 'done' || !!store.readTask(home, f.task).adapter.worktreesSwept);
function snapshot(f) {
  const files = [store.taskFile(home, f.task), ...f.local];
  if (existsSync(sessionFile(f.ref))) files.push(sessionFile(f.ref));
  if (existsSync(path.join(f.nativeHome, 'auth.json'))) files.push(path.join(f.nativeHome, 'auth.json'));
  return files.map(file => [file, readFileSync(file, 'utf8')]);
}
const same = before => before.every(([file, bytes]) => existsSync(file) && readFileSync(file, 'utf8') === bytes);
async function refusedInvoke(f, operation) {
  let error;
  const result = await expectFail(async () => {
    try { return await invoke(f, operation); }
    catch (caught) { error = caught; throw caught; }
  });
  return { ...result, error };
}

try {
  for (const operation of ['sweep', 'done']) {
    const f = fixture();
    mkdirSync(f.nativeHome, { recursive: true });
    const privateFile = path.join(f.nativeHome, 'auth.json');
    writeFileSync(privateFile, 'owned prelaunch home; no native issue', { mode: 0o600 });
    releaseNativeReservation(home, f.task, f.reserved);
    check(`${operation} fixture uses the exact released generation rather than inferring never-invoked from record absence`,
      current(f).metadata.nativeUnlaunched === f.reserved.metadata.nativeLaunchId && !existsSync(sessionFile(f.ref)));
    const released = current(f);
    store.upsertParticipant(home, f.task, { ...released, metadata: { ...released.metadata, nativeLaunchId: 'replacement-generation' } });
    const beforeRefusal = snapshot(f);
    const refused = await refusedInvoke(f, operation);
    check(`public ${operation} refuses a stale never-invoked marker before any destructive cleanup`,
      refused.failed && /unresolved/.test(refused.error?.message ?? '') && same(beforeRefusal), `${refused.error?.stack ?? ''}\n${refused.out}`);
    store.upsertParticipant(home, f.task, released);
    await capture(() => invoke(f, operation));
    check(`public ${operation} permits task-local cleanup for an exact never-invoked generation while retaining its private home`,
      localRemoved(f) && readFileSync(privateFile, 'utf8') === 'owned prelaunch home; no native issue'
        && !existsSync(sessionFile(f.ref)) && !current(f).metadata.nativeStop && closedAsExpected(f, operation));
    check(`public ${operation} does not rewrite the released generation or manufacture native Stop proof`,
      current(f).metadata.nativeLaunchId === released.metadata.nativeLaunchId
        && current(f).metadata.nativeUnlaunched === released.metadata.nativeUnlaunched);
  }

  for (const operation of ['sweep', 'done']) {
    const f = fixture(), gate = path.join(root, f.task + '.idle'), env = { ...process.env, PROMPTOBUS_ROLE: address, PB_CLEANUP_IDLE_GATE: gate };
    planParticipant(harness.home, address, { turns: [{ do: [] }] });
    const launchId = f.reserved.metadata.nativeLaunchId;
    const plan = { argv: [], files: [], cwd: root, prompt: 'Owned native cleanup fixture', settings: {}, trustProject: false,
      mcpConfig: { mcpServers: {} }, codexHome: f.nativeHome, prelaunchBinding: {},
      service: { launchId, beforeStart: async () => {}, realize: async () => {}, revoke: async () => {} } };
    launched.push({ ...f, env });
    await codexDriver.spawn(plan, { tool: { bin: path.join(root, 'bin', 'codex') }, host, home, task: f.task, address,
      ref: f.ref, role: 'worker', cwd: root, env,
      persist: (id, state, full) => persistNativeParticipant(home, f.task, f.reserved,
        { sessionId: full, sessionRecord: sessionFile(f.ref), sessionState: state }) });
    const readyDeadline = Date.now() + 15000;
    const native = await waitFor(() => {
      const record = readSession(f.ref);
      return record?.turns >= 1 && !record.busy && existsSync(gate + '.held') ? record : null;
    }, { timeoutMs: 15000 });
    if (!native?.nativeAdmission?.process || processState(native.nativeAdmission.process) !== 'alive') {
      throw new Error('Cleanup policy fixture has no live API-correlated owned app-server');
    }
    writeFileSync(gate + '.release', 'release actual idle');
    const completed = await waitFor(() => {
      const record = readSession(f.ref), log = holderLogFile(f.ref);
      return record?.turns >= 1 && !record.busy && record.lastEvent === 'thread/status/changed'
        && existsSync(log) && readFileSync(log, 'utf8').split('\n').some(line => line.endsWith(' alive'));
    }, { timeoutMs: Math.max(1, readyDeadline - Date.now()) });
    if (!completed || existsSync(gate + '.timeout')) throw new Error('Owned holder did not finish its actual idle publication');
    const liveBefore = snapshot(f);
    const liveRefusal = await refusedInvoke(f, operation);
    check(`public ${operation} refuses the actual live native owner without terminal proof and preserves all resources`,
      liveRefusal.failed && /unresolved|session is still alive/.test(`${liveRefusal.error?.message ?? ''}\n${liveRefusal.out}`)
        && same(liveBefore), `${liveRefusal.error?.stack ?? ''}\n${liveRefusal.out}`);
    // This is an owned fixture crash, never a native Stop claim. Only the exact captured
    // app-server is signalled; its holder must independently observe closure and exit.
    if (processState(native.nativeAdmission.process) !== 'alive') throw new Error('Owned app-server changed before fixture crash');
    process.kill(native.nativeAdmission.process.pid, 'SIGTERM');
    const dead = await waitFor(() => !holderAlive(f.ref) && !pidAlive(readSession(f.ref)?.appPid), { timeoutMs: 10000 });
    if (!dead) throw new Error('Owned cleanup fixture processes did not exit');
    await capture(() => abandon(host, { task: f.task, address }));
    const abandoned = current(f), nativeFile = sessionFile(f.ref), nativeBytes = readFileSync(nativeFile, 'utf8');
    const auth = path.join(f.nativeHome, 'auth.json'), authBytes = readFileSync(auth, 'utf8');
    const history = path.join(harness.home, 'threads', `${native.threadId}.json`), historyBytes = readFileSync(history, 'utf8');
    check(`${operation} abandonment fixture records missing Stop after actual owned native exit`,
      abandoned.metadata.abandoned.unknown.includes('stop-receipt') && !abandoned.metadata.nativeStop
        && readSession(f.ref).stopConfirmed !== true && processState(native.nativeAdmission.process) === 'dead');
    await capture(() => invoke(f, operation));
    check(`public ${operation} permits abandoned task-local cleanup while retaining exact native primary, private home and history`,
      localRemoved(f) && readFileSync(nativeFile, 'utf8') === nativeBytes && readFileSync(auth, 'utf8') === authBytes
        && readFileSync(history, 'utf8') === historyBytes && closedAsExpected(f, operation)
        && !current(f).metadata.nativeStop && current(f).metadata.nativeLaunchId === launchId);
  }
} finally {
  for (const f of launched) {
    const native = readSession(f.ref, f.env);
    if (native?.nativeAdmission?.process && processState(native.nativeAdmission.process) === 'alive') {
      process.kill(native.nativeAdmission.process.pid, 'SIGTERM');
    }
    if (!await waitFor(() => !holderAlive(f.ref, f.env) && !pidAlive(readSession(f.ref, f.env)?.appPid), { timeoutMs: 10000 })) {
      throw new Error(`Owned fixture cleanup remains unknown: ${f.ref}`);
    }
    // The private registry and home belong only to this fixture. Explicit teardown after
    // assertions does not turn abandonment or PID disappearance into a native Stop.
    if (readSession(f.ref, f.env)?.launchId !== f.reserved.metadata.nativeLaunchId) throw new Error('Fixture generation changed before teardown');
    dropSession(f.ref, f.env);
  }
  for (const f of fixtures) if (!existsSync(sessionFile(f.ref))) removeParticipantHome(f.nativeHome);
  if (prior.owner === undefined) delete process.env.PROMPTOBUS_CODEX_OWNER_HOME; else process.env.PROMPTOBUS_CODEX_OWNER_HOME = prior.owner;
  if (prior.session === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prior.session;
  harness.restore();
}

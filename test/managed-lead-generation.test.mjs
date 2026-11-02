import { check } from './check.mjs';
import cp from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStandaloneHost } from '../dist/host-index.js';
import { lead } from '../lib/lead.js';
import { codexDriver } from '../lib/driver-codex.js';
import { holderAlive, holderAsk, pidAlive, publishCodexNativeAdmission, readSession, sessionFile, writeSession, dropSession } from '../lib/codex-session.js';
import { participantOf, readTask, upsertParticipant, withTaskLock } from '../lib/store.js';
import { processState, recordVersion, servicePaths } from '../lib/service-state.js';
import { abortTaskWarden, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { installHarness, planParticipant, readTrace } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('pb-lead-generation-'));
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const authOwner = path.join(root, 'owner'); mkdirSync(authOwner);
writeFileSync(path.join(authOwner, 'auth.json'), '{"stub":"credentials"}\n');
const priorOwner = process.env.PROMPTOBUS_CODEX_OWNER_HOME;
process.env.PROMPTOBUS_CODEX_OWNER_HOME = authOwner;
const host = createStandaloneHost({ cwd: root, extraEnv: { PROMPTOBUS_WARDEN: 'off' } });
const home = host.promptobusHome(), task = 'lead-generation-t20261101-000001';
const brief = path.join(root, 'brief.md'); writeFileSync(brief, '# Preserve owned history\nRead this task before proceeding.\n');
planParticipant(harness.home, 'orchestrator', { turns: Array.from({ length: 8 }, () => ({ do: [{ tool: 'promptobus_task', args: { task } }] })) });
const options = { cwd: root, env: process.env }, paths = servicePaths(host);
const request = http.request, spawn = cp.spawn, originalSpawn = codexDriver.spawn, revocations = [], launches = [];
let mode = 'normal', failureNative, failureOwner, failureLaunch, swapLaunch, replacement, failureCause;
http.request = (...args) => {
  const call = request(...args);
  if (args[0]?.socketPath === paths.controlSocket) {
    const end = call.end;
    call.end = function (body, ...rest) {
      const input = JSON.parse(String(body));
      if (input.operation === 'revoke') revocations.push(input.clientId);
      return end.call(this, body, ...rest);
    };
  }
  return call;
};
cp.spawn = (...args) => {
  const child = spawn(...args);
  if (args[0] === process.execPath && args[1]?.[0] === path.resolve('lib/codex-hold.js')) {
    const launchId = args[1][2];
    child.once('exit', () => {
      if (swapLaunch !== launchId) return;
      withTaskLock(home, task, () => {
        const p = participantOf(readTask(home, task), 'orchestrator'), ref = 'reserved-successor-root';
        const record = { ref, launchId: 'reserved-successor-generation', home, task, address: 'orchestrator',
          cwd: root, role: 'orchestrator', state: 'starting', threadId: null, nativeAdmissionSchema: 1, holderPid: null, appPid: null };
        writeSession(record);
        const next = { ...p, sessionRef: ref, metadata: { ...p.metadata, sessionRecord: sessionFile(ref),
          nativeLaunchId: record.launchId, launcherPid: process.pid, replacementMarker: 'must-remain' } };
        upsertParticipant(home, task, next);
        replacement = { ref, file: sessionFile(ref), record: readFileSync(sessionFile(ref), 'utf8'),
          participant: JSON.stringify(participantOf(readTask(home, task), 'orchestrator')) };
      });
    });
  }
  return child;
};
syncBuiltinESMExports();
codexDriver.spawn = async (launch, runtime) => {
  launches.push({ launch, runtime });
  const realize = launch.service.realize.bind(launch.service);
  launch.service.realize = async nativeId => {
    const native = readSession(runtime.ref, runtime.env), owner = participantOf(readTask(home, task), 'orchestrator');
    check(`${mode}: public lead publishes its actual current generation and record before real HTTP admission`,
      native.threadId === nativeId && native.launchId === launch.service.launchId && owner.metadata.nativeLaunchId === native.launchId
        && owner.metadata.sessionId === nativeId && owner.metadata.owner === nativeId && owner.sessionRef === runtime.ref
        && owner.metadata.sessionRecord === launch.sessionRecord && native.nativeAdmission?.nativeId === nativeId
        && processState(native.nativeAdmission.process) === 'alive');
    if (launch.managedResume) check(`${mode}: public resume retains the validated current launcher reservation through realization`,
      owner.metadata.launcherPid === process.pid && owner.metadata.launcherPid === launch.managedResume.launcherPid
        && launch.managedResume.previousLaunchId !== native.launchId);
    await realize(nativeId);
    if (mode !== 'normal') {
      failureNative = readSession(runtime.ref, runtime.env); failureOwner = participantOf(readTask(home, task), 'orchestrator');
      failureLaunch = { launch, runtime };
      if (mode === 'replacement') swapLaunch = launch.service.launchId;
      failureCause = new Error(`fixture ${mode} failure after actual HTTP realization`);
      throw failureCause;
    }
  };
  return originalSpawn(launch, runtime);
};

const completed = plan => waitFor(() => {
  const r = readSession(plan.name, plan.env);
  return r?.lastTurn?.status === 'completed' && !r.busy ? r : null;
}, { timeoutMs: 15000 });
async function retain(plan) {
  const current = await completed(plan);
  if (!current) throw new Error('Public root did not complete its actual native turn');
  const answer = await holderAsk(plan.name, 'shutdown', { launchId: current.launchId }, plan.env);
  if (!answer.ok || !answer.stopped || answer.launchId !== current.launchId) throw new Error('Owned root declined fixture shutdown');
  const dead = await waitFor(() => !holderAlive(plan.name, plan.env) && !pidAlive(current.appPid), { timeoutMs: 10000 });
  if (!dead) throw new Error('Owned root processes did not exit');
  await plan.launch.service.revoke();
  return readSession(plan.name, plan.env);
}
const publication = (native, version) => ({ version, launchId: native.launchId, home: native.home, task: native.task,
  address: native.address, nativeStore: native.nativeAdmission.nativeStore, nativeId: native.threadId,
  process: native.nativeAdmission.process, method: native.nativeAdmissionEvidence.method });
function latePublication(ref, native, env, label) {
  const file = sessionFile(ref, env), before = readFileSync(file, 'utf8');
  const ownerBefore = JSON.stringify(participantOf(readTask(home, task), 'orchestrator'));
  let failure;
  try { publishCodexNativeAdmission(ref, publication(native, recordVersion(file)), env); } catch (error) { failure = error; }
  check(label, /Codex native provenance/.test(failure?.message ?? '') && readFileSync(file, 'utf8') === before
    && JSON.stringify(participantOf(readTask(home, task), 'orchestrator')) === ownerBefore, failure?.stack);
}

let current;
try {
  const cold = await lead(host, { brief, task, permissionMode: 'full-access' });
  const first = await retain(cold);
  const resumed = await lead(host, { task, resume: true });
  const previous = await retain(resumed), previousOwner = participantOf(readTask(home, task), 'orchestrator');
  check('successful cold and resumed public owners retain current generation and clear only the completed launcher reservation',
    first.threadId === previous.threadId && first.codexHome === previous.codexHome && first.launchId !== previous.launchId
      && previousOwner.metadata.nativeLaunchId === previous.launchId && previousOwner.metadata.launcherPid === undefined);
  const history = path.join(harness.home, 'threads', `${previous.threadId}.json`), historyBefore = JSON.parse(readFileSync(history, 'utf8'));
  mode = 'rollback'; let refused;
  try { await lead(host, { task, resume: true }); } catch (error) { refused = error; }
  const restored = readSession(resumed.name, resumed.env), owner = participantOf(readTask(home, task), 'orchestrator');
  check('actual failed-next realization revokes once, confirms owned exit, restores exact previous record and owner generation, then clears its reservation',
    refused === failureCause && isDeepStrictEqual(restored, previous) && owner.metadata.nativeLaunchId === previous.launchId
      && owner.metadata.launcherPid === undefined && processState(failureNative.nativeAdmission.process) === 'dead'
      && !existsSync(failureLaunch.launch.service.credentialFile)
      && revocations.filter(id => id === failureLaunch.launch.service.clientId).length === 1, refused?.stack);
  const failedGeneration = failureNative;
  latePublication(resumed.name, previous, resumed.env, 'a late old API publisher with a fresh recordVersion cannot revive the confirmed-dead predecessor');
  latePublication(resumed.name, failedGeneration, resumed.env, 'a late failed-next API publisher with a fresh recordVersion cannot overwrite the restored predecessor');
  const afterFailureHistory = JSON.parse(readFileSync(history, 'utf8'));
  check('failed realization and rollback preserve the actual prior native history without another first turn',
    isDeepStrictEqual(afterFailureHistory.injectedItems, historyBefore.injectedItems) && isDeepStrictEqual(afterFailureHistory.turns, historyBefore.turns));
  mode = 'normal';
  current = await lead(host, { task, resume: true });
  const afterRollback = await retain(current);
  check('a new explicit public resume after failed-next rollback admits the same native history on a new own child',
    afterRollback.threadId === previous.threadId && afterRollback.codexHome === previous.codexHome
      && afterRollback.launchId !== previous.launchId && afterRollback.launchId !== failedGeneration.launchId
      && afterRollback.nativeAdmissionEvidence.method === 'thread/resume'
      && readTrace(harness.home, 'orchestrator').filter(entry => entry.kind === 'tool' && !entry.isError && entry.text.includes(task)).length >= 3);
  mode = 'replacement'; let replacementFailure;
  try { await lead(host, { task, resume: true }); } catch (error) { replacementFailure = error; }
  check('a successor owner published at actual old holder exit survives rollback and launcher cleanup byte-for-byte',
    replacementFailure instanceof AggregateError && replacementFailure.errors[0] === failureCause
      && /changed its root owner before rollback/.test(replacementFailure.errors[1]?.message)
      && !!replacement && readFileSync(replacement.file, 'utf8') === replacement.record
      && JSON.stringify(participantOf(readTask(home, task), 'orchestrator')) === replacement.participant
      && readSession(failureLaunch.runtime.ref, failureLaunch.runtime.env).launchId === failureNative.launchId
      && processState(failureNative.nativeAdmission.process) === 'dead'
      && !existsSync(failureLaunch.launch.service.credentialFile)
      && revocations.filter(id => id === failureLaunch.launch.service.clientId).length === 1, replacementFailure?.stack);
  latePublication(failureLaunch.runtime.ref, failureNative, failureLaunch.runtime.env,
    'a late failed API publisher cannot modify the retained native record or newer reserved owner after native death');
} finally {
  swapLaunch = null;
  codexDriver.spawn = originalSpawn; cp.spawn = spawn; http.request = request; syncBuiltinESMExports();
  if (replacement && failureOwner) {
    withTaskLock(home, task, () => upsertParticipant(home, task, failureOwner));
    dropSession(replacement.ref);
  }
  for (const { launch } of launches) if (existsSync(launch.service.credentialFile)) await launch.service.revoke();
  const owned = failureLaunch ?? (current ? { runtime: { ref: current.name, env: current.env } } : null);
  if (owned && readSession(owned.runtime.ref, owned.runtime.env)) {
    const stopped = await codexDriver.stop(owned.runtime.ref);
    check('public generation fixture separately confirms native cleanup of its retained exact owned seat', stopped.ok && stopped.stopped, stopped.note);
  }
  await abortTaskWarden(host, task, options);
  if ((await workspaceServiceStatus(host, options)).running) {
    const stopped = await stopWorkspaceService(host, options);
    check('public generation fixture confirms physical exit of its own HTTP owner', stopped.stopped === true);
  }
  if (priorOwner === undefined) delete process.env.PROMPTOBUS_CODEX_OWNER_HOME; else process.env.PROMPTOBUS_CODEX_OWNER_HOME = priorOwner;
  harness.restore();
}

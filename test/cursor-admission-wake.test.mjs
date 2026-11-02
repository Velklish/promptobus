// Schedule a real wake inside actual bundled-runtime native open-file proof.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { installHarness, CURSOR_HOME_VAR } from './harness-cursor.mjs';
import { waitFor } from './harness.mjs';
import { proveStandIsolation, STUB_BIN } from '../scripts/live-entry.mjs';
import { processState } from '../lib/service-state.js';

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const change of ['wake', 'process', 'chat', 'owner', 'owner-only']) {
  const root = makeSandbox('promptobus-promptobus-live-cursor-cleanup-');
  const bins = path.join(root, 'bin'), harness = await installHarness({ binDir: bins, bundledRuntime: true });
  const mechanism = path.join(root, 'mechanism');
  for (const name of ['bin', 'dist', 'lib', 'models', 'schemas', 'skills', 'scripts', 'test', 'package.json']) {
    cpSync(path.join(PACKAGE, name), path.join(mechanism, name), { recursive: true });
  }
  symlinkSync(path.join(PACKAGE, 'node_modules'), path.join(mechanism, 'node_modules'), 'dir');
  const proofFile = path.join(root, 'proof.json'), resultFile = path.join(root, 'result.json');
  const driverFile = path.join(mechanism, 'lib', 'driver-cursor.js');
  let driver = readFileSync(driverFile, 'utf8');
  const proofCall = 'await processHasOpenFile(process, file)';
  if (driver.split(proofCall).length !== 2) throw new Error('Cursor admission open-file boundary changed');
  driver = driver.replace(proofCall, 'await fixtureOpenFileProof(process, file, recordFile, env, plan.service?.credentialFile)');
  driver += `
import {writeFileSync as fixtureWrite} from 'node:fs';
import {upsertParticipant as fixtureParticipant} from './store.js';
let fixtureInjected = false;
async function fixtureOpenFileProof(identity, nativeFile, recordFile, env, credentialFile) {
  const actualProof = await processHasOpenFile(identity, nativeFile);
  if (!actualProof || fixtureInjected) return actualProof;
  fixtureInjected = true;
  const before = readPrivate(recordFile), revision = recordVersion(recordFile);
  const wake = ${JSON.stringify(change)} === 'owner-only' ? null : registerWake(before.home, before.task, before.address, {...env, [SESSION_ENV_VAR]:recordFile}, before.chatId);
  const afterWake = readPrivate(recordFile);
  withTaskLock(before.home, before.task, () => {
    const current = readPrivate(recordFile);
    if (${JSON.stringify(change)} === 'process') writeSession({...current,
      nativeStartEvidence:{...current.nativeStartEvidence, process:processIdentity(globalThis.process.pid)}},env);
    if (['owner','owner-only'].includes(${JSON.stringify(change)})) {
      const owner=participantOf(readTask(before.home,before.task),before.address);
      fixtureParticipant(before.home,before.task,{...owner,metadata:{...owner.metadata,sessionId:'new-native-owner'}});
    }
    if (${JSON.stringify(change)} === 'chat') writeSession({...current,chatId:'00000000-0000-4000-8000-000000000001'},env);
  });
  fixtureWrite(${JSON.stringify(proofFile)},JSON.stringify({actualProof,wake,recordFile,credentialFile,
    nativeId:before.chatId,process:identity,revisionChanged:!sameRecordVersion(revision),
    turnsBefore:Number(before.turns)||0,turnsAfter:Number(afterWake.turns)||0,last:afterWake.last}));
  return actualProof;
}
`;
  writeFileSync(driverFile, driver);
  const entry = path.join(mechanism, 'scripts', 'live-cursor.mjs');
  let source = readFileSync(entry, 'utf8');
  const anchor = "  check('step 2: promptobus spawn --harness cursor raised a live participant',";
  if (source.split(anchor).length !== 2) throw new Error('Cursor spawn receipt boundary changed');
  source = source.replace(anchor, `
  ref = store.participantOf(store.readTask(home,TASK),WORKER)?.sessionRef ?? '';
  const {readPrivate:fixtureRead,requireProcess:fixtureIdentity,processState:fixtureState} = await import('../lib/service-state.js');
  const fixtureProof=existsSync(${JSON.stringify(proofFile)})?JSON.parse(readFileSync(${JSON.stringify(proofFile)},'utf8')):null;
  const fixtureRecord=fixtureProof?fixtureRead(fixtureProof.recordFile):null;
  const fixtureClient=fixtureProof?.credentialFile?fixtureRead(fixtureProof.credentialFile):null;
  const fixtureOwner=store.liveWarden(home,TASK);
  writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({spawn:{status:spawned.status,out:spawned.out},ref,
    retained:!!fixtureRecord,admission:fixtureRecord?.nativeAdmission,binding:fixtureClient?.nativeBinding,
    turns:fixtureRecord?.turns,last:fixtureRecord?.last,paneState:fixtureProof?fixtureState(fixtureProof.process):'unknown',
    owner:fixtureOwner?.pid?fixtureIdentity(fixtureOwner.pid):null,sandbox:SB}));
  throw new Error('owned admission scheduling fixture complete');
` + anchor);
  writeFileSync(entry, source);
  const isolated = proveStandIsolation({ binDir: bins, names: ['agent', 'cursor', 'cursor-agent', { name: 'tmux', probe: ['-V'] }],
    homes: { [CURSOR_HOME_VAR]: harness.home, PROMPTOBUS_CURSOR_HOME: harness.stateHome,
      PROMPTOBUS_CURSOR_USER_HOME: harness.userHome }, env: process.env });
  if (!isolated.ok) throw new Error(`Cursor admission isolation refused: ${isolated.reason}`);
  const serviceHome = mkdtempSync(path.join(realpathSync('/tmp'), 'pbcur-fixture-'));
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PROMPTOBUS_SERVICE_HOME: serviceHome, [STUB_BIN]: bins } });
  let output = '', exit = null;
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const done = new Promise(resolve => child.on('close', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  let proof, result;
  try {
    await waitFor(() => exit || null, { timeoutMs: 90000 });
    proof = existsSync(proofFile) ? JSON.parse(readFileSync(proofFile, 'utf8')) : null;
    result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
    if (change === 'owner-only') check('Cursor admission: owner replacement is injected after actual open-file proof without changing the native record',
      proof?.actualProof === true && !proof.wake && proof.revisionChanged === false && proof.turnsAfter === proof.turnsBefore,
      JSON.stringify({ proof, exit, output: output.slice(-1800) }));
    else check(`Cursor admission ${change}: actual open-file proof contains a real same-native wake before publication`,
      proof?.actualProof === true && !!proof.wake && proof.revisionChanged === true
      && proof.turnsAfter === proof.turnsBefore + 1 && proof.last?.session === proof.nativeId,
      JSON.stringify({ proof, exit, output: output.slice(-1800) }));
    if (change === 'wake') check('Cursor admission: concurrent wake preserves admission and its latest turn metadata',
      result?.spawn.status === 0 && result.admission?.nativeId === proof?.nativeId
      && result.admission?.process?.pid === proof?.process.pid && result.binding?.state === 'bound'
      && result.binding.sessionId === proof?.nativeId && result.turns >= proof?.turnsAfter && result.last?.session === proof?.nativeId,
      JSON.stringify({ result, proof, output: output.slice(-1800) }));
    else check(`Cursor admission: changed native ${change} proof refuses publication and retains the owned pane`,
      result?.spawn.status === 1 && !result.admission && result.retained === true && result.paneState === 'alive'
      && result.spawn.out.includes('Cursor native creation/publication changed its exact owner generation'),
      JSON.stringify({ result, proof, output: output.slice(-1800) }));
  } finally {
    if (!exit) { child.kill('SIGKILL'); await done; }
    for (const identity of [proof?.process, result?.owner]) if (identity && processState(identity) === 'alive') {
      try { process.kill(identity.pid, 'SIGTERM'); } catch { /* owned fixture already exited */ }
      await waitFor(() => processState(identity) === 'dead', { timeoutMs: 10000 });
    }
    harness.restore();
    if (result?.sandbox && (!proof?.process || processState(proof.process) === 'dead')
      && (!result.owner || processState(result.owner) === 'dead')) rmSync(result.sandbox, { recursive: true, force: true });
    rmSync(serviceHome, { recursive: true, force: true });
  }
}

import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { recordNativeBinding, reserveManagedNativeIdentity, assertNativeBinding, requireManagedNativeBinding } from '../lib/native-admission.js';
import { observeRootProcess } from '../lib/root-process.js';
import { acquireServiceLock, prepareServicePaths, readPrivate, recordVersion, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { bus, createTask, participantRecord, upsertParticipant } from '../lib/store.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-managed-transition-'));
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-transition-'));
writeHostConfig(root, { tools: [] });
const binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const host = createStandaloneHost({ cwd: root, binPath, version }), env = { ...process.env, PROMPTOBUS_SERVICE_HOME: base };
const paths = servicePaths(host, env), runtime = runtimeIdentity(host), context = { host, env };
prepareServicePaths(paths); bus(paths.home, { cli: version });
const task = 'managed-transition-t20261101-000000', ref = 'owned-ref', address = 'orchestrator', nativeId = randomUUID();
createTask(paths.home, { id: task, title: 'Scoped native transition fixture', owner: nativeId });
const recordFile = path.join(paths.directory, 'managed-record.json');
const oldChild = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
const oldClosed = new Promise(resolve => oldChild.once('close', resolve));
const oldReady = new Promise(resolve => oldChild.once('message', resolve));
const intermediate = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
const intermediateClosed = new Promise(resolve => intermediate.once('close', resolve));
const intermediateReady = new Promise(resolve => intermediate.once('message', resolve));
const refused = async action => { try { await action(); return false; } catch { return true; } };
const originalKill = process.kill;
try {
  await Promise.all([oldReady, intermediateReady]);
  const oldProcess = await observeRootProcess(oldChild.pid);
  if (!oldProcess) throw new Error('Owned transition fixture child has no captured birth');
  const tuple = process => ({ harness: 'codex', nativeStore: root, nativeId, process });
  const old = { ...tuple(oldProcess), source: 'managed', runtime, ownerKey: 'old-launch', nonce: 'old-launch' };
  let release = await acquireServiceLock(path.join(paths.directory, 'root-admission.lock'));
  if (!release) throw new Error('Owned transition lock unavailable');
  await recordNativeBinding(paths, old, context); release();
  const previousRecord = { version: 'old-version-before-overwrite', ref, home: paths.home, task, address, cwd: root, nativeId, nativeStore: root };
  const transition = { kind: 'managed-root-resume', record: recordFile, previousLaunchId: old.ownerKey, previous: tuple(oldProcess), previousRecord,
    launcherReservation: { previous: null, current: process.pid } };
  const currentProcess = await observeRootProcess(intermediate.pid);
  if (!currentProcess) throw new Error('Owned intermediate fixture has no captured birth');
  const record = { ref, home: paths.home, task, address, cwd: root, launchId: 'next-launch', threadId: nativeId, codexHome: root,
    nativeAdmission: tuple(currentProcess), nativeAdmissionEvidence: { kind: 'codex-thread-api', method: 'thread/resume', ...tuple(currentProcess) },
    nativeAdmissionTransition: transition };
  writePrivate(recordFile, record);
  upsertParticipant(paths.home, task, participantRecord(address, { harness: 'codex', sessionRef: ref,
    sessionRecord: recordFile, sessionId: nativeId, launcherPid: process.pid }));
  const grant = { id: randomUUID(), runtime, nativeBinding: { kind: 'codex', state: 'pending' },
    lifetime: { kind: 'managed', task, address, ref, record: recordFile, launchId: record.launchId } };
  check('owner-approved managed transition cannot replace a live captured old native birth', await refused(() => reserveManagedNativeIdentity(paths, grant, nativeId, context)));
  oldChild.kill('SIGTERM'); await oldClosed;
  await reserveManagedNativeIdentity(paths, grant, nativeId, context);
  const next = readPrivate(path.join(paths.directory, 'native-admission.json')).bindings[0];
  check('explicit same-history managed resume atomically replaces only the positively dead generation', next.ownerKey === record.launchId
    && next.nativeStore === root && next.nativeId === nativeId && next.previousManaged.ownerKey === old.ownerKey);
  await reserveManagedNativeIdentity(paths, grant, nativeId, context);
  check('same physical managed publication repeats idempotently', readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length === 1);
  check('managed first excludes a later standalone binding of the same actual tuple', await refused(() => assertNativeBinding(paths,
    { ...next, source: 'standalone', ownerKey: randomUUID(), nonce: randomUUID(), profile: 'ordinary' }, context)));
  const boundGrant = { ...grant, nativeBinding: { kind: 'codex', state: 'bound', threadId: nativeId } };
  await requireManagedNativeBinding(paths, boundGrant, context);
  for (const method of [['thread/start'], ['thread/resume'], { value: 'thread/resume' }, null]) {
    writePrivate(recordFile, { ...record, nativeAdmissionEvidence: { ...record.nativeAdmissionEvidence, method } });
    const bytes = readFileSync(recordFile, 'utf8');
    check('nonprimitive owned API method cannot become managed native proof',
      await refused(() => requireManagedNativeBinding(paths, boundGrant, context)) && readFileSync(recordFile, 'utf8') === bytes);
  }
  writePrivate(recordFile, record);
  writePrivate(recordFile, { ...record, nativeAdmission: { ...record.nativeAdmission, nativeStore: paths.home } });
  check('use-time managed proof refuses a changed native store', await refused(() => requireManagedNativeBinding(paths, boundGrant, context)));
  writePrivate(recordFile, { ...record, nativeAdmissionSchema: 1, holderPid: 1, appPid: process.pid });
  check('a corrupt new managed schema never falls back to an unresolved legacy publication', await refused(() => reserveManagedNativeIdentity(paths, grant, nativeId, context)));
  writePrivate(recordFile, { ...record, nativeAdmissionTransition: { ...transition, previousLaunchId: 'foreign-generation' } });
  check('another transition cannot replace the currently live next native generation', await refused(() => reserveManagedNativeIdentity(paths,
    { ...grant, lifetime: { ...grant.lifetime, launchId: 'third-launch' } }, nativeId, context)));
  intermediate.kill('SIGTERM'); await intermediateClosed;
  const thirdGrant = { ...grant, lifetime: { ...grant.lifetime, launchId: 'third-launch' } };
  const thirdTuple = tuple(requireProcess());
  const restoredTransition = { ...transition, previousRecord: { ...previousRecord, version: 'restored-different-inode-version' } };
  writePrivate(recordFile, { ...record, launchId: 'third-launch', nativeAdmission: thirdTuple,
    nativeAdmissionEvidence: { kind: 'codex-thread-api', method: 'thread/resume', ...thirdTuple }, nativeAdmissionTransition: restoredTransition });
  await reserveManagedNativeIdentity(paths, thirdGrant, nativeId, context);
  check('restored old history can explicitly resume after the failed intermediate generation is positively dead',
    readPrivate(path.join(paths.directory, 'native-admission.json')).bindings[0].ownerKey === 'third-launch');
  const primary = readPrivate(recordFile), aliasFile = path.join(paths.directory, 'alias.json'), aliasTask = 'managed-alias-t20261101-000000';
  createTask(paths.home, { id: aliasTask, title: 'Same physical native alias fixture', owner: nativeId });
  const source = { record: recordFile, version: recordVersion(recordFile).version, launchId: 'third-launch', nativeId };
  writePrivate(aliasFile, { ...primary, task: aliasTask, nativeAdmissionSource: source });
  upsertParticipant(paths.home, aliasTask, participantRecord(address, { harness: 'codex', sessionRef: ref, sessionRecord: aliasFile, sessionId: nativeId }));
  const aliasGrant = { ...thirdGrant, nativeBinding: { kind: 'codex', state: 'bound', threadId: nativeId },
    lifetime: { ...thirdGrant.lifetime, task: aliasTask, record: aliasFile } };
  writePrivate(recordFile, { ...primary, heartbeat: 'ordinary primary revision after sidecar copy' });
  await requireManagedNativeBinding(paths, aliasGrant, context);
  check('alias proof checks the immutable current primary tuple without requiring an eternal snapshot version', recordVersion(recordFile).version !== source.version);
  writePrivate(recordFile, { ...primary, nativeAdmission: { ...primary.nativeAdmission, process: { ...primary.nativeAdmission.process, birth: 'foreign-birth' } } });
  check('alias use refuses a replaced primary native generation', await refused(() => requireManagedNativeBinding(paths, aliasGrant, context)));
  writePrivate(recordFile, primary);
  const legacyId = randomUUID(), legacyTuple = { ...thirdTuple, nativeId: legacyId };
  const legacyRecord = { ...record, launchId: 'legacy-next', threadId: legacyId, nativeAdmission: legacyTuple,
    nativeAdmissionEvidence: { kind: 'codex-thread-api', method: 'thread/resume', ...legacyTuple },
    nativeAdmissionTransition: { ...transition, previousLaunchId: 'legacy-launch', previous: null,
      previousRecord: { ...previousRecord, nativeId: legacyId }, legacyDeath: { kind: 'pid-absence', pids: [oldChild.pid, intermediate.pid] } } };
  upsertParticipant(paths.home, task, participantRecord(address, { harness: 'codex', sessionRef: ref,
    sessionRecord: recordFile, sessionId: legacyId, launcherPid: process.pid }));
  writePrivate(recordFile, legacyRecord);
  const legacyLedger = readPrivate(path.join(paths.directory, 'native-admission.json'));
  writePrivate(path.join(paths.directory, 'native-admission.json'), { ...legacyLedger, bindings: [...legacyLedger.bindings, {
    harness: 'codex', nativeStore: root, nativeId: legacyId, source: 'managed', runtime,
    ownerKey: 'legacy-launch', nonce: 'legacy-launch', process: null,
  }] });
  const ledgerBeforeLegacy = readFileSync(path.join(paths.directory, 'native-admission.json'), 'utf8');
  check('birthless legacy resume cannot create a binding even after every old native PID exits',
    await refused(() => reserveManagedNativeIdentity(paths, { ...grant, lifetime: { ...grant.lifetime, launchId: 'legacy-next' } }, legacyId, context))
    && readFileSync(path.join(paths.directory, 'native-admission.json'), 'utf8') === ledgerBeforeLegacy);

} finally {
  process.kill = originalKill;
  oldChild.kill('SIGTERM'); await oldClosed;
  intermediate.kill('SIGTERM'); await intermediateClosed;
  rmSync(base, { recursive: true, force: true });
}

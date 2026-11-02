import { check } from './check.mjs';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { assertNativeBinding, nativeStoreForServiceClient, recordNativeBinding } from '../lib/native-admission.js';
import { acquireServiceLock, prepareServicePaths, privateDirectory, recordVersion, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { bus, createTask, participantRecord, upsertParticipant } from '../lib/store.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-store-isolation-'));
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-stores-'));
writeHostConfig(root, { tools: [] });
const binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url)), version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const storeA = path.join(root, 'native-a'), storeB = path.join(root, 'native-b'); mkdirSync(storeA); mkdirSync(storeB);
const registry = path.join(base, 'harness'); privateDirectory(registry); privateDirectory(path.join(registry, 'sessions'));
const host = createStandaloneHost({ cwd: root, binPath, version }), env = { ...process.env, PROMPTOBUS_SERVICE_HOME: base, PROMPTOBUS_CLAUDE_HOME: registry };
const paths = servicePaths(host, env), runtime = runtimeIdentity(host), context = { host, env }, processIdentity = requireProcess();
prepareServicePaths(paths); bus(paths.home, { cli: version });
const task = 'known-native-store-t20261101-000000', address = 'worker:known', ref = 'known-ref', id = randomUUID(), launchId = randomUUID();
createTask(paths.home, { id: task, title: 'Known native-store fixture', owner: id });
const file = path.join(registry, 'sessions', 'known.json');
const nativeAdmission = { harness: 'claude', nativeStore: storeA, nativeId: id, process: processIdentity };
const executable = recordVersion(realpathSync(process.execPath)), transcript = path.join(storeA, `${id}.jsonl`);
writeFileSync(transcript, JSON.stringify({ sessionId: id }) + '\n', { mode: 0o600 });
// Private producer packet for store isolation, not an actual Claude startup/genesis proof.
const record = { home: paths.home, task, address, ref, cwd: root, launchId, sessionId: id, nativeAdmission,
  nativeLaunchProvenance: { state: 'candidate', nativeStore: storeA },
  nativeCommand: { executable, nativeStore: storeA, argv: ['--bg', '--session-id', id, 'fixture prompt'] },
  nativeAdmissionEvidence: { kind: 'native-session-start', source: 'startup', ...nativeAdmission, transcript, executable } };
writePrivate(file, record);
upsertParticipant(paths.home, task, participantRecord(address, { harness: 'claude', sessionRef: ref, sessionRecord: file, sessionId: id, nativeLaunchId: launchId }));
const managed = { ...nativeAdmission, source: 'managed', runtime, ownerKey: launchId, nonce: launchId };
const nonce = randomUUID(), standalone = { ...managed, source: 'standalone', nativeStore: storeB, ownerKey: nonce, nonce, profile: 'ordinary', phase: 'bound' };
const transaction = async action => {
  let release = await acquireServiceLock(path.join(paths.directory, 'root-admission.lock'));
  const deadline = Date.now() + 5000;
  while (!release) { if (Date.now() >= deadline) throw new Error('Owned store transaction stayed busy'); await new Promise(resolve => setTimeout(resolve, 10)); release = await acquireServiceLock(path.join(paths.directory, 'root-admission.lock')); }
  try { return await action(); } finally { release(); }
};
const refused = async action => { try { await action(); return false; } catch { return true; } };
const freshLedger = () => { rmSync(path.join(paths.directory, 'native-admission.json'), { force: true }); rmSync(path.join(paths.directory, 'native-admission.initialized.json'), { force: true }); };
try {
  for (const order of [[managed, standalone], [standalone, managed]]) {
    await transaction(() => recordNativeBinding(paths, order[0], context));
    await transaction(() => recordNativeBinding(paths, order[1], context));
    check(`${order[0].source} first: same harness/ID in two proved actual stores stays independent`, !await refused(() => assertNativeBinding(paths, standalone, context)));
    freshLedger();
  }
  const concurrent = await Promise.allSettled([managed, standalone].map(binding => transaction(() => recordNativeBinding(paths, binding, context))));
  check('concurrent independent-store publications both survive the same owner lock', concurrent.every(result => result.status === 'fulfilled'));
  const managedGrant = { runtime, nativeBinding: { kind: 'claude', state: 'bound', sessionId: id }, lifetime: { kind: 'managed', task, address, ref, record: file, launchId } };
  const rootGrant = { runtime, nativeBinding: { kind: 'claude', state: 'bound', sessionId: id }, lifetime: { kind: 'process', process: processIdentity }, rootLaunch: { nonce, file: '/unused/private-unit-reference' } };
  check('service conflict lookup uses trusted exact-generation ledger stores', nativeStoreForServiceClient(paths, managedGrant, id) === storeA
    && nativeStoreForServiceClient(paths, rootGrant, id) === storeB);
  check('a raw actor store hint is not trusted service provenance', nativeStoreForServiceClient(paths, { ...rootGrant,
    rootLaunch: undefined, env: { CLAUDE_CONFIG_DIR: storeA }, lifetime: { kind: 'process', process: processIdentity } }, id) === null);
  check('same store still conflicts with another origin', await refused(() => assertNativeBinding(paths, { ...standalone, nativeStore: storeA }, context)));
  writePrivate(file, { ...record, nativeAdmission: undefined, codexHome: storeA, env: { CLAUDE_CONFIG_DIR: storeA } });
  check('unknown managed store still blocks a potentially related ID despite raw path hints', await refused(() => assertNativeBinding(paths, standalone, context)));
  writePrivate(file, { ...record, nativeAdmission: { ...nativeAdmission, process: { pid: process.pid } } });
  check('incomplete published store/process provenance cannot prove a foreign store', await refused(() => assertNativeBinding(paths, standalone, context)));
  writePrivate(file, record);
  check('one immutable generation cannot switch an already known store', await refused(() => transaction(() => recordNativeBinding(paths,
    { ...standalone, nativeStore: root }, context))));
  const bbId = randomUUID(), bbNonce = randomUUID(), stateDirectory = path.join(paths.directory, 'root-admission');
  privateDirectory(stateDirectory);
  writePrivate(path.join(stateDirectory, 'state.json'), { schemaVersion: 2, root: paths.root, home: paths.home,
    profiles: [{ id: 'bb-known-store', runtime, nativeStore: storeA }], managed: [], roots: [{ profileId: 'bb-known-store', bbThreadId: 'thr_known_store',
      generation: { nativeThreadId: bbId, appServer: processIdentity, nonce: bbNonce } }] });
  const otherStore = { ...standalone, harness: 'codex', nativeId: bbId, ownerKey: randomUUID(), nonce: randomUUID() };
  check('available BB root history preserves same-ID independence for a proved different native store',
    !await refused(() => transaction(() => recordNativeBinding(paths, otherStore, context))));
  check('available BB root history still excludes that same ID in its own actual store',
    await refused(() => assertNativeBinding(paths, { ...otherStore, nativeStore: storeA }, context)));
} finally { rmSync(base, { recursive: true, force: true }); }

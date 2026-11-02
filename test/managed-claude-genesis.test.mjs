import { check } from './check.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { bindManagedNativeStart } from '../lib/drivers.js';
import { reserveManagedNativeIdentity } from '../lib/native-admission.js';
import { prepareServicePaths, readPrivate, recordVersion, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { bus, createTask, participantOf, participantRecord, readTask, upsertParticipant } from '../lib/store.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-claude-genesis-'));
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-claude-genesis-'));
writeHostConfig(root, { tools: [] });
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const host = createStandaloneHost({ cwd: root, binPath: fileURLToPath(new URL('../bin/promptobus.js', import.meta.url)), version });
const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: base }, paths = servicePaths(host, env), runtime = runtimeIdentity(host);
prepareServicePaths(paths);
const task = 'claude-genesis-t20261101-000000', address = 'worker:claude', ref = 'claude-genesis';
const nativeId = randomUUID(), hint = randomUUID(), launchId = randomUUID(), nativeProcess = requireProcess();
const file = path.join(paths.directory, 'owned-claude.json'), transcript = path.join(root, `${nativeId}.jsonl`);
const executable = recordVersion(realpathSync(process.execPath));
bus(paths.home, { cli: version });
createTask(paths.home, { id: task, title: 'Claude private publication contract', owner: 'fixture-owner' });
const initial = { home: paths.home, task, address, ref, launchId, cwd: root, sessionId: null,
  nativeLaunchProvenance: { state: 'candidate', nativeStore: root },
  nativeCommand: { executable, nativeStore: root, argv: ['--bg', '--session-id', hint, 'fixture prompt'] } };
writePrivate(file, initial);
upsertParticipant(paths.home, task, participantRecord(address, { harness: 'claude', sessionRef: ref, sessionRecord: file, nativeLaunchId: launchId, sessionId: hint }));
writeFileSync(transcript, JSON.stringify({ sessionId: nativeId }) + '\n', { mode: 0o600 });
const binding = { harness: 'claude', nativeStore: root, nativeId, process: nativeProcess };
// This unit packet represents a verified producer; it is not an actual native launch/SessionStart proof.
const evidence = { kind: 'native-session-start', source: 'startup', ...binding, transcript, executable };
const input = { harness: 'claude', home: paths.home, task, address, ref, record: file, launchId, nativeId, transcript };
const refused = async action => { try { await action(); return false; } catch { return true; } };
try {
  const stale = recordVersion(file);
  writePrivate(file, { ...initial, heartbeat: 'ordinary intervening write' });
  const changed = readFileSync(file, 'utf8');
  check('late native publication refuses a changed original record version without overwriting it',
    await refused(() => bindManagedNativeStart({ ...input, nativeProof: { version: stale, binding, evidence } })) && readFileSync(file, 'utf8') === changed);
  writePrivate(file, { ...initial, launchId: 'replacement-generation' });
  const replacement = readFileSync(file, 'utf8');
  check('late native publication cannot adopt a replacement launch generation', await refused(() => bindManagedNativeStart({ ...input,
    nativeProof: { version: recordVersion(file), binding, evidence } })) && readFileSync(file, 'utf8') === replacement);
  writePrivate(file, initial);
  bindManagedNativeStart({ ...input, nativeProof: { version: recordVersion(file), binding, evidence } });
  const published = readPrivate(file);
  check('verified publication binds actual native ID instead of the prelaunch hint', published.sessionId === nativeId
    && published.nativeAdmission.nativeId === nativeId && participantOf(readTask(paths.home, task), address).metadata.sessionId === nativeId && nativeId !== hint);
  const grant = { id: randomUUID(), runtime, nativeBinding: { kind: 'claude', state: 'pending' },
    lifetime: { kind: 'managed', task, address, ref, record: file, launchId } };
  for (const patch of [{ source: 'resume' }, { source: ['startup'] }, { nativeId: hint }, { transcript: path.join(root, `${hint}.jsonl`) }]) {
    writePrivate(file, { ...published, nativeAdmissionEvidence: { ...evidence, ...patch } });
    check('an invalid first creation packet cannot write the native ledger', await refused(() => reserveManagedNativeIdentity(paths, grant, nativeId, { host, env }))
      && readPrivate(path.join(paths.directory, 'native-admission.json')) === null);
  }
  writePrivate(file, published);
  await reserveManagedNativeIdentity(paths, grant, nativeId, { host, env });
  check('the owner consumes the exact verified producer tuple into one native binding', readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length === 1
    && readPrivate(path.join(paths.directory, 'native-admission.json')).bindings[0].nativeId === nativeId);
} finally { rmSync(base, { recursive: true, force: true }); }

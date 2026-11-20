import { check } from './check.mjs';
import { makeServiceTestDirectory } from './service-test-directory.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { bindManagedNativeStart } from '../lib/drivers.js';
import { readBgSessions } from '../lib/liftoff.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { readManagedServiceHookContext, requireManagedClaudeMcp } from '../lib/service-launch.js';
import { reserveManagedNativeIdentity } from '../lib/native-admission.js';
import { prepareServicePaths, readPrivate, recordVersion, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { bus, createTask, participantOf, participantRecord, readTask, upsertParticipant } from '../lib/store.js';
import { makeSandbox, stubCommand, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-claude-genesis-'));
const base = makeServiceTestDirectory('pb-claude-genesis-');
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
const owner = sessionId => participantRecord(address, { harness: 'claude', sessionRef: ref, sessionRecord: file, nativeLaunchId: launchId, sessionId });
upsertParticipant(paths.home, task, owner(null));
writeFileSync(transcript, JSON.stringify({ sessionId: nativeId }) + '\n', { mode: 0o600 });
const binding = { harness: 'claude', nativeStore: root, nativeId, process: nativeProcess };
// This unit packet represents a verified producer; it is not an actual native launch/SessionStart proof.
const evidence = { kind: 'native-session-start', source: 'startup', ...binding, transcript, executable };
const input = { harness: 'claude', home: paths.home, task, address, ref, record: file, launchId, nativeId, transcript };
const refused = async action => { try { await action(); return false; } catch { return true; } };
// Tokenless metadata only. Each case gets its own staged client at the same participant pointer.
function stagedClient(generation, state) {
  const id = randomUUID(), client = path.join(paths.clients, `${id}.json`);
  const scope = { task, address, record: file, ...generation };
  writePrivate(path.join(paths.directory, `launch-${id}.json`), { ...scope, runtime, home: paths.home, harness: 'claude', deferTaskBinding: false });
  if (state) writePrivate(client, { id, runtime, lifetime: { kind: 'managed', ...scope }, nativeBinding: { kind: 'claude', ...state },
    env: { PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: address } });
  return { id, client };
}
const errorOf = action => { try { action(); return null; } catch (error) { return error.message; } };
try {
  const journal = () => participantOf(readTask(paths.home, task), address);
  const journalBefore = JSON.stringify(journal()), pointerBefore = readFileSync(file, 'utf8');
  const ledger = path.join(paths.directory, 'native-admission.json');
  check('unreadable Claude list supplies no session observation', claudeDriver.inspect(ref, null) === null);
  const registryFile = path.join(root, 'test-registry.json');
  stubCommand(root, 'claude-registry', `import { readFileSync } from 'node:fs';
    process.stdout.write(readFileSync(${JSON.stringify(registryFile)}));`);
  const source = { executable: path.join(root, process.platform === 'win32' ? 'claude-registry.cmd' : 'claude-registry'), nativeStore: root };
  for (const [label, payload, strict] of [
    ['bare list', [], true], ['agents envelope', { agents: [] }, true], ['sessions envelope', { sessions: [] }, true],
    ['empty object', {}, false], ['unrecognized envelope', { unexpected: true }, false],
    ['null agents', { agents: null }, false], ['offline string', 'offline', false],
    ['unidentified row', [{ id: 'short' }], false],
  ]) {
    writeFileSync(registryFile, JSON.stringify(payload));
    const observed = readBgSessions({ source, fresh: true });
    const verified = readBgSessions({ source, requireSessionIds: true });
    check(`managed rollback registry: ${label} preserves ordinary read and requires identifiable sessions`,
      Array.isArray(observed.list) && Array.isArray(verified.list) === strict, JSON.stringify({ observed, verified }));
  }
  const predecessor = { state: 'bound', sessionId: 'a1b2c3d4-0000-4000-8000-000000000001' };
  for (const [label, generation, state, expected] of [
    ['ref mismatch only', { ref: 'previous-ref', launchId }, predecessor, 'Managed launch record identity changed'],
    ['launch mismatch only', { ref, launchId: 'previous-launch' }, predecessor, 'Managed launch record identity changed'],
    ['retired client with matching generation', { ref, launchId }, null, 'Managed client has no native launch binding'],
  ]) {
    const { client } = stagedClient(generation, state);
    const reason = errorOf(() => readManagedServiceHookContext(host, client, { env }));
    check(`managed reconnect: ${label}`, reason === expected && readFileSync(file, 'utf8') === pointerBefore
      && JSON.stringify(journal()) === journalBefore && readPrivate(ledger) === null, reason);
  }
  const next = stagedClient({ ref, launchId }, { state: 'pending' }), context = readManagedServiceHookContext(host, next.client, { env });
  const connection = randomUUID();
  writePrivate(path.join(paths.sessions, `${connection}.json`), { id: connection, client: next.id, endpoint: 'bus', protocol: '2025-06-18', initialized: true });
  const pending = errorOf(() => requireManagedClaudeMcp(host, next.client, { env }));
  check('an initialized successor connection with matching launch metadata is still pending native admission',
    context.ref === ref && context.launchId === launchId && pending === 'Claude execution requires its admitted native MCP client'
    && readPrivate(next.client).nativeBinding.state === 'pending' && readPrivate(file).sessionId === null && readPrivate(ledger) === null, pending);
  check('before verified startup the initialized successor has no native session ID in the participant journal',
    journal()?.sessionRef === ref && journal().metadata.nativeLaunchId === launchId && journal().metadata.sessionId == null);
  upsertParticipant(paths.home, task, owner(hint));
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

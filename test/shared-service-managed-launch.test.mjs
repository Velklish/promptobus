import { check, skip } from './check.mjs';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { runWorkspaceService } from '../lib/service.js';
import { registerServiceClient, revokeServiceClient, serviceControl } from '../lib/service-client.js';
import { createOwnerEnvironment, finalizeManagedServiceLaunch, managedServiceServers, managedServiceHeaders, readManagedServiceHookContext, readOwnerEnvironment } from '../lib/service-launch.js';
import { readDiscovery, readPrivate, recordVersion, sameRecordVersion, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { bus, createTask, participantRecord, participantOf, readTask, readWake, upsertParticipant } from '../lib/store.js';
import { bindManagedNativeStart, resolveSessionIdentity } from '../lib/drivers.js';
import { ownsLegacyLaunch } from '../lib/native-lifecycle.js';
import { guard } from '../lib/guard.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('managed shared HTTP launch', 'This platform has no implemented process-birth observer');
} else {
  const root = realpathSync(makeSandbox('promptobus-shared-service-managed-'));
  const privateHome = mkdtempSync(path.join(realpathSync('/tmp'), 'pbsvc-'));
  const home = path.join(root, '.promptobus'), binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const nativeStore = path.join(root, 'native-account'); mkdirSync(nativeStore, { mode: 0o700 });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: nativeStore, PROMPTOBUS_HOME: home, PROMPTOBUS_SERVICE_HOME: privateHome, PROMPTOBUS_SERVICE_IDLE_MS: '60000', PROMPTOBUS_WARDEN: 'off', ROOT_ACCOUNT_SETTING: 'root-account' };
  for (const name of ['PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK', 'PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_OPENCODE_SESSION', 'PROMPTOBUS_OWNER_ENV_FILE']) delete env[name];
  writeHostConfig(root, { tools: [] });
  const host = createStandaloneHost({ cwd: root, binPath, version });
  const paths = servicePaths(host, env), runtime = runtimeIdentity(host), options = { env, cwd: root }, clients = [], launches = [], factories = [];
  const owner = input => serviceControl(paths, { runtime, ...input });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async predicate => { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() >= deadline) throw new Error('Fixture readiness timed out'); await wait(10); } };
  const managedHook = async (args, hookEnv, event) => {
    const stdout = process.stdout.write, stderr = process.stderr.write;
    let output = '', error = '';
    process.stdout.write = chunk => { output += chunk; return true; };
    process.stderr.write = chunk => { error += chunk; return true; };
    try { await guard(args, hookEnv, root, Readable.from([JSON.stringify(event)])); }
    finally { process.stdout.write = stdout; process.stderr.write = stderr; }
    return { output, error };
  };
  const rpc = (credential, connection, method, params = {}, id = 1) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });
    const call = request(credential.busUrl, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, accept: 'application/json, text/event-stream',
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(connection ? { 'mcp-session-id': connection, 'mcp-protocol-version': '2025-06-18' } : {}) } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, session: response.headers['mcp-session-id'], text }));
      response.on('error', reject);
    });
    call.setTimeout(10000, () => call.destroy(new Error('Fixture HTTP request timed out'))); call.on('error', reject); call.end(body);
  });
  const publishUnitNative = (file, nativeId) => {
    const current = readPrivate(file), executable = recordVersion(realpathSync(process.execPath));
    const transcript = path.join(nativeStore, `${nativeId}.jsonl`), nativeProcess = requireProcess();
    writeFileSync(transcript, JSON.stringify({ sessionId: nativeId }) + '\n', { mode: 0o600 });
    writePrivate(file, { ...current, nativeCommand: { executable, nativeStore, argv: ['--bg', 'fixture prompt'] } });
    const binding = { harness: 'claude', nativeStore, nativeId, process: nativeProcess };
    // This private owner unit packet tests service realization, not actual native creation.
    bindManagedNativeStart({ harness: 'claude', home, task: current.task, address: current.address, ref: current.ref, record: file,
      launchId: current.launchId, nativeId, transcript, nativeProof: { version: recordVersion(file), binding,
        evidence: { kind: 'native-session-start', source: 'startup', ...binding, transcript, executable } } });
  };
  let serviceError;
  const service = runWorkspaceService({ host, env, createHost: context => {
    factories.push(context);
    return createStandaloneHost({ cwd: context.cwd, binPath, version });
  } }).catch(error => { serviceError = error; });
  try {
    await until(() => readDiscovery(paths) || serviceError);
    if (serviceError) throw serviceError;
    bus(home, { cli: version });
    const snapshotFile = createOwnerEnvironment(host, { ...env, PROMPTOBUS_ROOT_LAUNCH_FILE: '/private/root-launch-only',
      PROMPTOBUS_ROOT_FUTURE_REFERENCE: '/private/root-future-only', PROMPTOBUS_CLIENT_TOKEN: 'fixture-parent-client-token' });
    const snapshot = readOwnerEnvironment(host, snapshotFile, options);
    const serializedSnapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    check('the actual serialized managed owner snapshot removes every root/client capability reference while retaining trusted account context',
      !Object.keys(serializedSnapshot.env).some(key => key.startsWith('PROMPTOBUS_ROOT_') || key.startsWith('PROMPTOBUS_CLIENT_'))
        && !readFileSync(snapshotFile, 'utf8').includes('/private/root-launch-only')
        && !readFileSync(snapshotFile, 'utf8').includes('/private/root-future-only')
        && serializedSnapshot.env.ROOT_ACCOUNT_SETTING === 'root-account' && snapshot.ROOT_ACCOUNT_SETTING === env.ROOT_ACCOUNT_SETTING);
    check('owner environment is an owned private immutable snapshot', (statSync(snapshotFile).mode & 0o777) === 0o600 && Object.isFrozen(snapshot) && snapshot.ROOT_ACCOUNT_SETTING === 'root-account');
    const saved = readPrivate(snapshotFile);
    for (const changed of [{ home: `${home}-foreign` }, { root: `${root}-foreign` }, { runtime: 'foreign-runtime' }, { env: { BAD: 1 } }]) {
      writePrivate(snapshotFile, { ...saved, ...changed });
      let refused = false; try { readOwnerEnvironment(host, snapshotFile, options); } catch { refused = true; }
      check('owner environment refuses a changed workspace, store, runtime or value type', refused);
    }
    writePrivate(snapshotFile, saved);
    chmodSync(snapshotFile, 0o644);
    let publicSnapshotRefused = false; try { readOwnerEnvironment(host, snapshotFile, options); } catch { publicSnapshotRefused = true; }
    check('owner environment refuses a readable-by-others snapshot', publicSnapshotRefused); chmodSync(snapshotFile, 0o600);
    for (const harness of ['claude', 'cursor', 'codex', 'opencode']) {
      const nativeId = `native-${harness}`, task = `launch-${harness}-t20261030-000000`;
      createTask(home, { id: task, title: 'managed native fixture', owner: nativeId });
      upsertParticipant(home, task, participantRecord('user'));
      const credential = await registerServiceClient(host, { cwd: root, env: { ...env, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: 'orchestrator',
        CODEX_THREAD_ID: 'ancestor-codex', CLAUDE_CODE_SESSION_ID: 'ancestor-claude', CURSOR_CONVERSATION_ID: 'ancestor-cursor', OPENCODE_SESSION_ID: 'ancestor-opencode' },
        nativeBinding: { kind: harness, state: 'pending' }, lifetime: { kind: 'process', process: requireProcess() } }, options);
      clients.push(credential);
      const before = factories.length, initialized = await rpc(credential, null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'managed-launch-fixture', version: '1' } });
      await rpc(credential, initialized.session, 'notifications/initialized', {}, null);
      const discovered = await rpc(credential, initialized.session, 'tools/list', {}, 2);
      const denied = await rpc(credential, initialized.session, 'tools/call', { name: 'promptobus_task', arguments: {} }, 3);
      check(`${harness} pending discovery stays pure and tools refuse before owner realization`, initialized.status === 200 && discovered.status === 200 && denied.status === 403 && factories.length === before, JSON.stringify({ initialized, discovered, denied }));
      await owner({ operation: 'realize', clientId: credential.clientId, threadId: nativeId });
      const called = await rpc(credential, initialized.session, 'tools/call', { name: 'promptobus_task', arguments: {}, ...(harness === 'codex' ? { _meta: { threadId: nativeId } } : {}) }, 4);
      const actor = factories.at(-1), expectedVariable = harness === 'claude' ? 'CLAUDE_CODE_SESSION_ID' : harness === 'cursor' ? 'CURSOR_CONVERSATION_ID' : harness === 'codex' ? 'CODEX_THREAD_ID' : null;
      check(`${harness} realization keeps the MCP session and constructs only its own native actor`, called.status === 200 && factories.length === before + 1
        && Object.isFrozen(actor.env) && (expectedVariable ? resolveSessionIdentity(actor.env).id === nativeId : actor.env.OPENCODE_SESSION_ID === undefined), called.text);
      check(`${harness} actor cannot inherit another harness identity`, ['CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CURSOR_CONVERSATION_ID', 'OPENCODE_SESSION_ID'].filter(name => name !== expectedVariable).every(name => actor?.env[name] === undefined));
      const servers = managedServiceServers(harness, credential);
      check(`${harness} HTTP descriptors contain references instead of bearer bytes`, !JSON.stringify(servers).includes(credential.token) && !JSON.stringify(servers).includes('stdio')
        && (harness === 'codex' ? servers.promptobus.bearer_token_env_var === 'PROMPTOBUS_CLIENT_TOKEN'
          : servers.promptobus.headers.Authorization.includes(harness === 'cursor' ? '${env:' : harness === 'opencode' ? '{env:' : '${')));
    }
    const task = 'managed-record-t20261030-000000', address = 'worker:managed', ref = 'owned-managed-ref', nativeId = 'actual-managed-claude';
    createTask(home, { id: task, title: 'record fixture', owner: 'fixture-owner' });
    const plan = { argv: ['--session-id', nativeId], settings: {}, mcpConfig: { mcpServers: { external: { url: 'http://external.invalid/mcp' } } }, files: [] };
    const driver = { id: 'claude', replaceMcpServers(launch, servers) { Object.assign(launch.mcpConfig.mcpServers, servers); } };
    const base = { launch: plan, driver, home, task, address, ref, cwd: root, env: { ...env, PROMPTOBUS_ROLE: address }, commonEnv: env };
    let missingSnapshotRefused = false; try { const unexpected = await finalizeManagedServiceLaunch(host, { ...base, launch: { ...plan, mcpConfig: { mcpServers: {} }, files: [] } }); launches.push(unexpected.service); } catch (error) { missingSnapshotRefused = /private root owner environment/.test(error.message); }
    check('a managed caller cannot rename its captured environment as a root snapshot', missingSnapshotRefused);
    const privateEntries = readdirSync(paths.directory).length;
    let strippedManagedRefused = false;
    try {
      const unexpected = await finalizeManagedServiceLaunch(host, { ...base, launch: { ...plan, mcpConfig: { mcpServers: {} }, files: [] },
        env: { ...env, PROMPTOBUS_ROLE: 'orchestrator' },
        commonEnv: { ...env, PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_CODEX_SESSION: '/owned/managed-session', CODEX_HOME: '/private/managed-account' } });
      launches.push(unexpected.service);
    } catch (error) { strippedManagedRefused = /private root owner environment/.test(error.message); }
    check('stripped child env cannot hide managed markers in the raw common snapshot', strippedManagedRefused && readdirSync(paths.directory).length === privateEntries);
    const finalized = await finalizeManagedServiceLaunch(host, { ...base, env: { ...base.env, PROMPTOBUS_OWNER_ENV_FILE: snapshotFile,
      PROMPTOBUS_CLIENT_TOKEN: 'ancestor-token', CODEX_THREAD_ID: 'ancestor-codex' } });
    launches.push(finalized.service);
    const credential = readPrivate(finalized.service.credentialFile);
    check('finalization preserves the same plan and native argv while replacing only credential ownership', plan.service === finalized.service && plan.argv[1] === nativeId
      && plan.mcpConfig.mcpServers.external.url === 'http://external.invalid/mcp' && finalized.env.CODEX_THREAD_ID === undefined
      && finalized.env.PROMPTOBUS_CLIENT_TOKEN !== 'ancestor-token' && credential.nativeBinding.state === 'pending');
    const record = path.join(paths.directory, 'owned-claude.json');
    const owned = { ref, home, task, address, launchId: finalized.service.launchId, sessionId: null };
    writePrivate(record, owned);
    upsertParticipant(home, task, participantRecord(address, { harness: 'claude', sessionRef: ref, sessionRecord: record }));
    await finalized.service.beforeStart(record);
    const previousParticipant = participantOf(readTask(home, task), address);
    const deferred = { ref, record, launchId: finalized.service.launchId, deferTaskBinding: true, previousParticipant };
    check('deferred existing task retains authority only while its captured participant is unchanged', ownsLegacyLaunch(home, task, address, deferred));
    upsertParticipant(home, task, { ...previousParticipant, metadata: { ...previousParticipant.metadata, changedGeneration: true } });
    check('deferred launch refuses a changed prior participant even when its old ref still matches', !ownsLegacyLaunch(home, task, address, deferred));
    upsertParticipant(home, task, previousParticipant);
    const beforeDeferredStart = readPrivate(record);
    const priorNative = { ...previousParticipant, metadata: { ...previousParticipant.metadata, sessionId: 'old-same-ref-native' } };
    upsertParticipant(home, task, priorNative);
    const deferredStart = { harness: 'claude', home, task, address, ref, record, launchId: finalized.service.launchId, nativeId, deferTaskBinding: true };
    const pendingStart = bindManagedNativeStart(deferredStart);
    check('same-ref deferred start does not publish through the previous native participant', !pendingStart.published
      && JSON.stringify(participantOf(readTask(home, task), address)) === JSON.stringify(priorNative));
    upsertParticipant(home, task, { ...priorNative, metadata: { ...priorNative.metadata, sessionId: nativeId } });
    check('the exact handed-over native participant can publish its deferred start', bindManagedNativeStart(deferredStart).published);
    upsertParticipant(home, task, previousParticipant);
    writePrivate(record, beforeDeferredStart);
    const context = readManagedServiceHookContext(host, finalized.service.credentialFile, options);
    check('owned launch binding precedes the native ID and remains pending', context.record === record && context.ref === ref && readPrivate(finalized.service.credentialFile).lifetime.kind === 'managed'
      && readPrivate(finalized.service.credentialFile).nativeBinding.state === 'pending');
    const privateState = () => JSON.stringify([paths.directory, paths.clients].map(directory => readdirSync(directory).sort().map(name => {
      const file = path.join(directory, name), stat = statSync(file);
      return [name, stat.mtimeMs, stat.isFile() ? readFileSync(file, 'utf8') : null];
    })));
    const priorHeadersState = privateState();
    const headers = managedServiceHeaders(host, finalized.service.credentialFile, options);
    check('managed Claude headers read the exact staged credential without writes or service startup', headers.Authorization === `Bearer ${credential.token}`
      && privateState() === priorHeadersState);
    check('managed Claude config carries the private reference but no bearer bytes',
      plan.mcpConfig.mcpServers.promptobus.headersHelper.includes(finalized.service.credentialFile)
      && plan.mcpConfig.mcpServers.promptobus.headers === undefined && !JSON.stringify(plan.mcpConfig).includes(credential.token));
    for (const file of [path.join(paths.clients, 'invalid.json'), path.join(root, path.basename(finalized.service.credentialFile))]) {
      let refused = false; try { managedServiceHeaders(host, file, options); } catch { refused = true; }
      check('managed headers refuse invalid or foreign credential references', refused);
    }
    for (const changed of [{ runtime: 'foreign-runtime' }, { env: { ...credential.env, PROMPTOBUS_TASK: 'another-task' } }]) {
      writePrivate(finalized.service.credentialFile, { ...readPrivate(finalized.service.credentialFile), ...changed });
      let refused = false; try { managedServiceHeaders(host, finalized.service.credentialFile, options); } catch { refused = true; }
      check('managed headers refuse a mismatched runtime or staged actor', refused);
      // beforeStart has changed the lifetime from the original reservation.
      writePrivate(finalized.service.credentialFile, { ...readPrivate(finalized.service.credentialFile), runtime: credential.runtime, env: credential.env });
    }
    for (const changed of [{ task: 'another-task' }, { role: 'worker:foreign' }, { home: root }, { rootProfile: 'conflicting-root' }]) {
      const before = readFileSync(finalized.service.credentialFile, 'utf8');
      const refused = await managedHook({ host, home, task, role: address, clientFile: finalized.service.credentialFile, serviceHome: paths.base, ...changed }, env,
        { hook_event_name: 'SessionStart', session_id: nativeId });
      const expected = changed.rootProfile ? 'Managed hook requires one owned client reference' : 'Managed hook scope does not match its client';
      check('managed SessionStart refuses a mismatched explicit hook scope or root profile', JSON.parse(refused.output).continue === false
        && refused.error.trim() === expected && readFileSync(finalized.service.credentialFile, 'utf8') === before, refused.error);
    }
    let wrongIdRefused = false; try { await finalized.service.realize('unproven-native'); } catch (error) { wrongIdRefused = /owned launch record/.test(error.message); }
    check('owner realization cannot invent a native ID absent from the owned record', wrongIdRefused && readPrivate(finalized.service.credentialFile).nativeBinding.state === 'pending');
    writePrivate(record, { ...readPrivate(record), sessionId: nativeId });
    let unprovedRefused = false; try { await finalized.service.realize(nativeId); } catch (error) { unprovedRefused = /verified fresh creation/.test(error.message); }
    check('an owned ID without a producer packet remains pending', unprovedRefused && readPrivate(finalized.service.credentialFile).nativeBinding.state === 'pending');
    publishUnitNative(record, nativeId);
    const publishedVersion = recordVersion(record), publishedEvidence = readPrivate(record).nativeStartEvidence;
    const repeated = { harness: 'claude', home, task, address, ref, record, launchId: finalized.service.launchId, nativeId };
    bindManagedNativeStart(repeated);
    check('an identical Claude hook preserves the exact record version and richer same-ID evidence', sameRecordVersion(publishedVersion)
      && JSON.stringify(readPrivate(record).nativeStartEvidence) === JSON.stringify(publishedEvidence));
    let foreignStartRefused = false;
    try { bindManagedNativeStart({ ...repeated, nativeId: 'foreign-native-id' }); } catch { foreignStartRefused = true; }
    check('a foreign Claude hook refuses without rewriting the published native record', foreignStartRefused && sameRecordVersion(publishedVersion));
    let realized = true, realizationError; try { await finalized.service.realize(nativeId); } catch (error) { realized = false; realizationError = error; }
    check('the actual owned native ID realizes the managed grant', realized && readPrivate(finalized.service.credentialFile).nativeBinding.sessionId === nativeId, realizationError?.stack);
    const verified = readPrivate(record);
    writePrivate(record, { ...verified, launchId: 'replacement-launch' });
    let replacedRefused = false; try { readManagedServiceHookContext(host, finalized.service.credentialFile, options); } catch { replacedRefused = true; }
    check('hook lookup refuses a replaced launch generation before any handshake', replacedRefused);
    writePrivate(record, verified);
    const lateTask = 'late-owner-t20261030-000000', lateRef = 'late-owner-ref', aliasTask = 'alias-owner-t20261030-000000';
    const aliasRecord = path.join(paths.directory, 'alias-owner.json');
    const latePlan = { argv: [], settings: {}, mcpConfig: { mcpServers: { parent_bus: { command: 'old-stdio' } } }, files: [],
      serviceScopes: [{ server: 'parent_bus', task: aliasTask, address: 'orchestrator', record: aliasRecord }] };
    const late = await finalizeManagedServiceLaunch(host, { launch: latePlan, driver, home, task: lateTask, address: 'orchestrator', ref: lateRef,
      cwd: root, env: { ...env, PROMPTOBUS_OWNER_ENV_FILE: snapshotFile }, commonEnv: env, deferTaskBinding: true });
    launches.push(late.service);
    const lateRecord = path.join(paths.directory, 'late-owner.json');
    writePrivate(lateRecord, { ref: lateRef, home, task: lateTask, address: 'orchestrator', launchId: late.service.launchId, sessionId: 'late-native' });
    writePrivate(aliasRecord, { ref: lateRef, home, task: aliasTask, address: 'orchestrator', launchId: late.service.launchId, sessionId: 'late-native' });
    await late.service.beforeStart(lateRecord);
    const aliasVariable = Object.keys(late.env).find(name => name.startsWith('PROMPTOBUS_CLIENT_TOKEN_'));
    check('an additional task connection receives its own reference and credential', aliasVariable && late.env[aliasVariable] !== late.env.PROMPTOBUS_CLIENT_TOKEN
      && latePlan.mcpConfig.mcpServers.parent_bus.headersHelper !== latePlan.mcpConfig.mcpServers.promptobus.headersHelper
      && !JSON.stringify(latePlan.mcpConfig).includes(late.env[aliasVariable])
      && latePlan.mcpConfig.mcpServers.parent_bus.command === undefined);
    check('a future owner stages its record without creating a fake task or actor Host', !existsSync(path.join(home, 'tasks', lateTask))
      && readPrivate(late.service.credentialFile).lifetime.kind === 'reservation');
    await managedHook({ host, home, task: lateTask, role: 'orchestrator', clientFile: late.service.credentialFile, serviceHome: paths.base },
      { ...env, CLAUDE_CODE_MESSAGING_SOCKET: '/unpublished-contact.sock', CLAUDE_CODE_MESSAGING_TOKEN: 'unpublished-contact-token' },
      { hook_event_name: 'SessionStart', session_id: 'late-native' });
    check('an unpublished deferred SessionStart cannot publish a native contact point', readWake(home, lateTask, 'orchestrator') === null
      && !existsSync(path.join(home, 'tasks', lateTask)));
    createTask(home, { id: lateTask, title: 'published owner', owner: 'late-native' });
    upsertParticipant(home, lateTask, participantRecord('orchestrator', { harness: 'claude', sessionRef: lateRef, sessionId: 'late-native', sessionRecord: lateRecord }));
    createTask(home, { id: aliasTask, title: 'published alias owner', owner: 'late-native' });
    upsertParticipant(home, aliasTask, participantRecord('orchestrator', { harness: 'claude', sessionRef: lateRef, sessionId: 'late-native', sessionRecord: aliasRecord }));
    publishUnitNative(lateRecord, 'late-native');
    publishUnitNative(aliasRecord, 'late-native');
    await late.service.realize('late-native');
    check('actual owner publication upgrades the staged reservation before realization', readPrivate(late.service.credentialFile).lifetime.kind === 'managed'
      && readPrivate(late.service.credentialFile).nativeBinding.sessionId === 'late-native');
  } finally {
    for (const launch of launches) if (existsSync(launch.credentialFile)) await launch.revoke();
    for (const credential of clients) if (existsSync(credential.credentialFile)) await revokeServiceClient(host, credential.clientId, options);
    if (!serviceError) await owner({ operation: 'stop' });
    await service; rmSync(privateHome, { recursive: true, force: true });
  }
  if (serviceError) throw serviceError;
}

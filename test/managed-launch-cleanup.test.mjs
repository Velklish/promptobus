import { check } from './check.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createStandaloneHost } from '../dist/host-index.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { lockFile as cursorLockFile, sessionFile as cursorFile } from '../lib/cursor-persist.js';
import { holderAsk, readSession, reapHolder, sessionFile as codexFile, STOP_TIMEOUT_MS, writeSession } from '../lib/codex-session.js';
import { lead } from '../lib/lead.js';
import { report } from '../lib/report.js';
import { finalizeManagedServiceLaunch, revokeFailedManagedLaunch } from '../lib/service-launch.js';
import { prepareServicePaths, processStateAsync, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { createTask, participantOf, participantRecord, readTask, upsertParticipant } from '../lib/store.js';
import { createHarnessRegistry } from '../lib/harness-registry.js';
import { installHarness } from './harness-codex.mjs';
import { makeSandbox, makeSockDir, stubCommand, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-launch-cleanup-'));
const home = path.join(root, '.promptobus'), task = 'cleanup-t20261101-120000';
writeHostConfig(root, { tools: ['cursor', 'codex'] });
const host = createStandaloneHost({ cwd: root });
createTask(home, { id: task, title: 'managed launch cleanup' });
const bin = path.join(root, 'bin');
const env = { ...process.env, PROMPTOBUS_CURSOR_HOME: path.join(root, 'cursor') };
const harness = await installHarness({ binDir: bin, env });
env.PATH = process.env.PATH;
const owner = path.join(root, 'auth-owner');
mkdirSync(owner);
env.PROMPTOBUS_CODEX_OWNER_HOME = owner;
stubCommand(bin, 'tmux', 'console.error("fixture pty provider refused"); process.exit(23);');

async function failedLaunch(driver, stage) {
  const address = `worker:${driver.id}-${stage}`, ref = `failed-${driver.id}-${stage}`, launchId = `launch-${driver.id}-${stage}`;
  upsertParticipant(home, task, participantRecord(address, { harness: driver.id, sessionRef: ref,
    ...(driver.id === 'codex' ? { nativeLaunchId: launchId } : {}) }));
  const record = driver.id === 'cursor' ? cursorFile(ref, env) : codexFile(ref, env);
  const codexHome = driver.id === 'codex' ? participantCodexHome({ task, address }, env) : null;
  writeFileSync(path.join(owner, 'auth.json'), stage === 'auth' ? '{"auth_mode":"chatgpt","tokens":{}}' : '{"auth_mode":"apikey","OPENAI_API_KEY":"fixture"}');
  if (stage === 'files') writeFileSync(path.join(root, 'blocked-native-files'), 'fixture');
  const original = new Error(`${stage} native launch refused`), revokeError = new Error('fixture revocation refused');
  let revokes = 0, driverError, callerError;
  const plan = { argv: [], cwd: root, prompt: 'fixture', settings: {}, mcpConfig: { mcpServers: {} }, codexHome,
    trustProject: false, prelaunchBinding: { sessionRecord: record },
    ...(stage === 'files' ? { privateHomeFiles: [{ path: path.join(root, 'blocked-native-files', 'native'), text: 'fixture' }] } : {}),
    service: { launchId, clientId: 'fixture-client', credentialFile: '/owned/fixture-client',
      beforeStart: async () => {
        if (stage === 'cleanup') mkdirSync(cursorLockFile(ref, env));
        if (stage === 'before-start') throw original;
      },
      realize: async () => { if (stage === 'bind') throw original; },
      revoke: async () => { revokes += 1; if (stage !== 'cleanup') throw revokeError; } } };
  const previousExit = process.exit;
  process.exit = code => { throw new Error(`fixture intercepted EXIT:${code}`); };
  try {
    try {
      await driver.spawn(plan, { tool: { bin: stage === 'ready' ? path.join(root, 'missing-codex') : path.join(bin, driver.id === 'cursor' ? 'cursor-unused' : 'codex') },
        host, home, task, address, ref, role: 'worker', cwd: root, env, persist: () => {}, awaitOptions: { tries: 1, delayMs: 0 } });
    } catch (error) { driverError = error; }
    try { await revokeFailedManagedLaunch(plan, driverError); }
    catch (error) { callerError = error; }
    check(`${driver.id} ${stage} failure preserves its owned record until successful revocation`,
      existsSync(record) && (!codexHome || existsSync(codexHome)), record);
    check(`${driver.id} ${stage} failure preserves both causes and exactly one revoke attempt`,
      driverError instanceof AggregateError && callerError === driverError
        && (stage === 'cleanup' ? driverError.errors[1] instanceof Error && driverError.errors[1].message.includes(cursorLockFile(ref, env)) : driverError.errors[1] === revokeError)
        && driverError.errors[0] !== revokeError && driverError.cause === driverError.errors[0]
        && driverError.message.includes(record) && (stage === 'cleanup' || driverError.message.includes(revokeError.message))
        && driverError.message.includes('state is unknown') && revokes === 1
        && (!['before-start', 'bind'].includes(stage) || driverError.errors[0] === original),
      JSON.stringify({ message: callerError?.message, revokes }));
  } finally {
    process.exit = previousExit;
    const held = driver.id === 'codex' ? readSession(ref, env) : null;
    let cleanupFailure;
    if (held?.holderPid) {
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      try {
        if (held.holderProcess?.pid !== held.holderPid) throw new Error('Fixture holder lifetime is unknown');
        let settled = false;
        while (Date.now() < deadline) {
          const current = readSession(ref, env);
          if (current?.launchId !== held.launchId || current.holderPid !== held.holderPid
            || current.holderProcess?.birth !== held.holderProcess.birth) throw new Error('Fixture holder generation changed during cleanup');
          if (await processStateAsync(held.holderProcess) === 'dead') { settled = true; break; }
          if (current.rpcSocket) {
            try {
              await holderAsk(ref, 'status', {}, env, Math.max(1, Math.min(200, deadline - Date.now())));
              settled = true; break;
            } catch { /* A published socket may not yet be listening. */ }
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (!settled || Date.now() >= deadline) throw new Error('Fixture holder neither exited nor published a ready RPC within cleanup allowance');
        await reapHolder(ref, env, Math.max(1, deadline - Date.now()));
      } catch (error) { cleanupFailure = error; }
      check(`codex ${stage} cleanup confirms the owned holder exit before removing retained resources`, !cleanupFailure, cleanupFailure?.stack);
    }
    if (!cleanupFailure) {
      rmSync(record, { force: true });
      if (stage === 'cleanup') rmSync(cursorLockFile(ref, env), { recursive: true, force: true });
      if (codexHome) rmSync(codexHome, { recursive: true, force: true });
    }
  }
}

try {
  await failedLaunch(cursorDriver, 'pty');
  await failedLaunch(cursorDriver, 'cleanup');
  for (const stage of ['auth', 'files', 'before-start', 'bind', 'ready']) await failedLaunch(codexDriver, stage);
} finally { harness.restore(); }

const onDropError = new Error('fixture participant-home cleanup refused');
const sidecar = path.join(root, 'removed-sidecar');
writeFileSync(sidecar, 'fixture');
const registryEnv = { PROMPTOBUS_CURSOR_HOME: path.join(root, 'failed-registry-drop') };
const registry = createHarnessRegistry({ harness: 'cursor', sidecars: () => [sidecar], onDrop: () => { throw onDropError; } });
registry.writeSession({ ref: 'failed-drop', sessionId: 'actual-owned-id', codexHome: '/retained/home-reference' }, registryEnv);
let onDropFailure;
try { registry.dropSession('failed-drop', registryEnv); } catch (error) { onDropFailure = error; }
check('registry onDrop failure retains primary record and exact native/home references',
  onDropFailure === onDropError && registry.readSession('failed-drop', registryEnv)?.sessionId === 'actual-owned-id'
    && registry.readSession('failed-drop', registryEnv)?.codexHome === '/retained/home-reference');
check('retained primary record does not imply already removed sidecars are preserved', !existsSync(sidecar));

const privateHome = realpathSync(makeSockDir('pb-rollback-').dir);
const serviceEnv = { ...process.env, PROMPTOBUS_HOME: home, PROMPTOBUS_SERVICE_HOME: privateHome };
for (const key of ['PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK', 'PROMPTOBUS_OWNER_ENV_FILE', 'PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_OPENCODE_SESSION']) delete serviceEnv[key];
const paths = servicePaths(host, serviceEnv), runtime = runtimeIdentity(host);
prepareServicePaths(paths);
const discovery = { schemaVersion: 1, root: paths.root, home: paths.home, runtime, version: host.version, url: 'http://127.0.0.1:32123/', process: requireProcess() };
writePrivate(paths.discovery, discovery);
writePrivate(paths.owner, { token: 'a'.repeat(64) });
let mode, registers, clients, revocations, actorEnvironments;
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  const answer = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (input.operation === 'status') return answer(200, { ...discovery, clients: clients.length, reservations: clients.length, unknownClients: 0,
    unknownManaged: 0, sessions: 0, warden: { tasks: [], observations: 0 } });
  if (input.operation === 'register') {
    actorEnvironments.push(input.client.env);
    registers += 1;
    if (mode === 'register' && registers === 3) return answer(503, { error: 'fixture third registration refused' });
    const clientId = `${String(registers).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const credentialFile = path.join(paths.clients, `${clientId}.json`);
    const credential = { clientId, credentialFile, token: 'SECRET-FIXTURE-TOKEN', busUrl: `${discovery.url}mcp/client/${clientId}`, filesUrl: null };
    writePrivate(credentialFile, credential); clients.push(credential);
    return answer(200, credential);
  }
  if (input.operation === 'revoke') {
    revocations.push(input.clientId);
    if (clients.slice(0, 2).some(client => client.clientId === input.clientId)) return answer(503, { error: `fixture revoke refused ${input.clientId}` });
    rmSync(clients.find(client => client.clientId === input.clientId).credentialFile, { force: true });
    return answer(200, {});
  }
  answer(400, { error: 'unexpected fixture operation' });
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(paths.controlSocket, resolve); });
  for (mode of ['register', 'config', 'revoke']) {
    registers = 0; clients = []; revocations = []; actorEnvironments = [];
    const configError = new Error('fixture config replacement refused'), nativeError = new Error('fixture native launch refused');
    const launch = { argv: [], files: [], env: { PROMPTOBUS_ROOT_LAUNCH_FILE: '/private/root-launch' },
      serviceScopes: ['alias-one', 'alias-two'].map(server => ({ server, task, address: 'orchestrator', record: path.join(root, `${server}.json`) })) };
    let failure, callerFailure, afterRevokeCalls = 0;
    try {
      await finalizeManagedServiceLaunch(host, { launch, driver: { id: 'claude', replaceMcpServers() { if (mode === 'config') throw configError; } },
        home, task, address: 'worker:rollback', ref: 'rollback', cwd: root,
        env: { ...serviceEnv, PROMPTOBUS_ROOT_FUTURE_KEY: 'root-only' }, commonEnv: serviceEnv });
      if (mode === 'revoke') await revokeFailedManagedLaunch(launch, nativeError);
    } catch (error) { failure = error; }
    try { await revokeFailedManagedLaunch(launch, failure, () => { afterRevokeCalls += 1; }); }
    catch (error) { callerFailure = error; }
    const firstMessage = mode === 'register' ? 'fixture third registration refused' : mode === 'config' ? configError.message : nativeError.message;
    check(`${mode} rollback preserves its original failure and all failed owned grant references`,
      failure instanceof AggregateError && failure.errors[0].message === firstMessage && failure.cause === failure.errors[0]
        && failure.errors.length === 3 && (mode !== 'config' || failure.errors[0] === configError)
        && failure.message.includes(firstMessage) && clients.slice(0, 2).every(client => failure.message.includes(client.clientId)
          && failure.message.includes(client.credentialFile) && existsSync(client.credentialFile))
        && !failure.message.includes('SECRET-FIXTURE-TOKEN'), failure?.message);
    check(`${mode} finalized or partial-registration cleanup failure prevents caller reservation cleanup and duplicate revoke`,
      callerFailure === failure && afterRevokeCalls === 0 && revocations.length === clients.length,
      JSON.stringify({ afterRevokeCalls, attempts: revocations }));
    check(`${mode} rollback attempts every owned registered grant once despite earlier failures`,
      revocations.length === clients.length && clients.every(client => revocations.filter(id => id === client.clientId).length === 1)
        && clients.slice(2).every(client => !existsSync(client.credentialFile)), JSON.stringify(revocations));
    check(`${mode} registers each managed actor without root launch environment keys`,
      actorEnvironments.length === registers && actorEnvironments.every(env => !Object.keys(env).some(key => key.startsWith('PROMPTOBUS_ROOT_'))));
    if (mode === 'revoke') {
      check('the finalized child retains only its private owner bootstrap reference',
        !!launch.env.PROMPTOBUS_OWNER_ENV_FILE && !Object.keys(launch.env).some(key => key.startsWith('PROMPTOBUS_ROOT_')));
      try { await launch.service.revoke(); } catch { /* the first unknown outcome remains the result */ }
      check('service revoke does not repeat an operation with an unknown outcome', revocations.length === clients.length);
    }
  }

  const publicHarness = await installHarness({ binDir: bin });
  const savedServiceHome = process.env.PROMPTOBUS_SERVICE_HOME, savedOwner = process.env.PROMPTOBUS_CODEX_OWNER_HOME;
  process.env.PROMPTOBUS_SERVICE_HOME = privateHome; process.env.PROMPTOBUS_CODEX_OWNER_HOME = owner;
  const replace = codexDriver.replaceMcpServers;
  const publicTask = 'rollback-resume-t20261101-000001', publicRef = 'rollback-public-root', nativeId = 'retained-root-fixture-id';
  const [oldHolder, oldApp] = await Promise.all([0, 1].map(async () => {
    const child = spawn(process.execPath, ['-e', 'process.send("ready");process.once("message",()=>process.exit(0));'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    await new Promise(resolve => child.once('message', resolve));
    const identity = requireProcess(child.pid), closed = new Promise(resolve => child.once('close', resolve));
    child.send('exit'); await closed; return identity;
  }));
  const oldHome = participantCodexHome({ task: publicTask, address: 'orchestrator' }); mkdirSync(oldHome, { recursive: true });
  // Private known current-version state reaches finalization rollback, not native genesis.
  const oldRecord = { ref: publicRef, launchId: 'retained-public-generation', home, task: publicTask, address: 'orchestrator',
    cwd: root, codexHome: oldHome, threadId: nativeId, holderPid: oldHolder.pid, appPid: oldApp.pid,
    nativeAdmissionSchema: 1, holderProcess: oldHolder, appProcess: oldApp,
    nativeAdmission: { harness: 'codex', nativeStore: realpathSync(oldHome), nativeId, process: oldApp },
    nativeAdmissionEvidence: { kind: 'codex-thread-api', method: 'thread/start', nativeStore: realpathSync(oldHome), nativeId, process: oldApp },
    role: 'orchestrator', state: 'dead', sandbox: 'danger-full-access' };
  writeSession(oldRecord);
  createTask(home, { id: publicTask, title: 'Retained public resume', owner: nativeId });
  upsertParticipant(home, publicTask, participantRecord('orchestrator', {
    harness: 'codex', mode: 'managed', sessionRef: publicRef, sessionId: nativeId, owner: nativeId,
    nativeLaunchId: oldRecord.launchId, sessionRecord: codexFile(publicRef),
  }));
  mode = 'config'; registers = 0; clients = []; revocations = []; actorEnvironments = [];
  const configError = new Error('public resume final config refused');
  let publicFailure, preparedLaunch;
  codexDriver.replaceMcpServers = launch => { preparedLaunch = launch; throw configError; };
  try {
    const before = readFileSync(codexFile(publicRef), 'utf8');
    try { await lead(host, { task: publicTask, resume: true }); } catch (error) { publicFailure = error; }
    const owner = participantOf(readTask(home, publicTask), 'orchestrator');
    check('actual public resume retains its validated reservation when finalize rollback cannot revoke its registered grant',
      publicFailure instanceof AggregateError && publicFailure.errors[0] === configError && publicFailure.cause === configError
        && owner.metadata.launcherPid === process.pid && owner.metadata.nativeLaunchId === oldRecord.launchId
        && owner.metadata.sessionRecord === codexFile(publicRef) && preparedLaunch.service?.clientId === clients[0].clientId
        && preparedLaunch.service.credentialFile === clients[0].credentialFile
        && preparedLaunch.launchId === undefined
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(preparedLaunch.service.launchId)
        && preparedLaunch.service.launchId !== oldRecord.launchId
        && readFileSync(codexFile(publicRef), 'utf8') === before && revocations.length === 1
        && existsSync(clients[0].credentialFile), publicFailure?.stack);
    const reporterTask = 'rollback-reporter-t20261101-000001';
    createTask(home, { id: reporterTask, title: 'Retained public reporter reservation', owner: 'fixture-root-owner' });
    const reporterConfigError = new Error('public reporter final config refused');
    let reporterFailure, reporterLaunch;
    registers = 0; clients = []; revocations = []; actorEnvironments = [];
    codexDriver.replaceMcpServers = launch => { reporterLaunch = launch; throw reporterConfigError; };
    try { await report(host, { task: reporterTask, harness: 'codex' }); } catch (error) { reporterFailure = error; }
    const reporter = participantOf(readTask(home, reporterTask), 'reporter');
    check('actual public reporter cannot mark its reserved generation unlaunched before unknown finalize revocation',
      reporterFailure instanceof AggregateError && reporterFailure.errors[0] === reporterConfigError
        && reporter.metadata.nativeLaunchId === reporterLaunch.launchId && reporter.metadata.nativeUnlaunched === undefined
        && reporter.metadata.pending === true && reporter.metadata.launchPid === process.pid && !!reporter.metadata.launchToken
        && reporterLaunch.service?.clientId === clients[0].clientId
        && reporterLaunch.service.credentialFile === clients[0].credentialFile
        && reporterLaunch.service.launchId === reporterLaunch.launchId && revocations.length === 1 && existsSync(clients[0].credentialFile), reporterFailure?.stack);
  } finally {
    codexDriver.replaceMcpServers = replace;
    if (savedServiceHome === undefined) delete process.env.PROMPTOBUS_SERVICE_HOME; else process.env.PROMPTOBUS_SERVICE_HOME = savedServiceHome;
    if (savedOwner === undefined) delete process.env.PROMPTOBUS_CODEX_OWNER_HOME; else process.env.PROMPTOBUS_CODEX_OWNER_HOME = savedOwner;
    publicHarness.restore();
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(privateHome, { recursive: true, force: true });
}

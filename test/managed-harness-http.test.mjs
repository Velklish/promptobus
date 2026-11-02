import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { makeSandbox, makeSockDir, stubCommand, writeHostConfig } from './sandbox.mjs';
import { bindHandshake, claudeDriver, SESSION_RECORD_VAR } from '../lib/driver-claude.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { codexDriver } from '../lib/driver-codex.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { createTask, participantSessionPath, participantRecord, readTask, taskExists, upsertParticipant } from '../lib/store.js';
import { createOwnerEnvironment, finalizeManagedServiceLaunch, revokeFailedManagedLaunch } from '../lib/service-launch.js';
import { reapHolder } from '../lib/opencode-session.js';
import { sessionFile as cursorSessionFile } from '../lib/cursor-persist.js';
import { createStandaloneHost } from '../dist/host-index.js';
import { runWorkspaceService } from '../lib/service.js';
import { serviceControl } from '../lib/service-client.js';
import { readDiscovery, runtimeIdentity, servicePaths } from '../lib/service-state.js';
import { persistLegacyParticipant } from '../lib/native-lifecycle.js';

const scratch = makeSandbox('promptobus-harness-');
writeHostConfig(scratch, { tools: ['claude', 'cursor', 'codex', 'opencode'] });
const git = spawnSync('git', ['-C', scratch, 'init', '-q'], { encoding: 'utf8' });
if (git.status !== 0) throw new Error(git.stderr);
const home = path.join(scratch, '.promptobus');
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude-native'); mkdirSync(process.env.CLAUDE_CONFIG_DIR, { mode: 0o700 });
for (const harness of ['CURSOR', 'CODEX', 'OPENCODE']) process.env[`PROMPTOBUS_${harness}_HOME`] = path.join(scratch, `${harness.toLowerCase()}-registry`);
const task = 'http-owned-t20261030-090000';
const address = 'worker:http';
const ref = 'HTTP worker';
const external = { command: 'external-fixture', args: ['read'], env: { OWNER: 'external' } };
const servers = { promptobus: { type: 'stdio', command: 'old-bus-fixture', disabled_tools: ['promptobus_send'],
  http_headers_helper: 'fixture-root-profile-helper', env: { PROMPTOBUS_ROOT_LAUNCH_FILE: '/private/root-launch' } }, reviewer_files: { command: 'old-files-fixture' }, external };
for (const driver of [claudeDriver, cursorDriver, codexDriver, opencodeDriver]) {
  const before = readdirSync(scratch).sort().join(',');
  const launch = driver.prepare({
    ref, role: 'worker', model: driver.options.defaultModel, mcp: { servers, home, task, address },
    prompt: 'fixture', cwd: scratch, root: scratch, skillsRoot: null, home, task, address,
    mcpConfigPath: path.join(scratch, `${driver.id}.mcp.json`), settingsPath: path.join(scratch, `${driver.id}.settings.json`),
    guardCommand: 'fixture-guard', env: process.env,
  });
  const argv = [...launch.argv];
  const prebound = launch.prelaunchBinding?.sessionId;
  const permissions = JSON.stringify(launch.settings?.permission ?? launch.settings?.permissions);
  const owned = { promptobus: { type: 'http', url: 'http://127.0.0.1:32123/mcp/client/bus',
    headers: { Authorization: 'Bearer ${PROMPTOBUS_CLIENT_TOKEN}' }, bearer_token_env_var: 'PROMPTOBUS_CLIENT_TOKEN', oauth: false },
  reviewer_files: { type: 'http', url: 'http://127.0.0.1:32123/mcp/client/reviewer_files',
    headers: { Authorization: 'Bearer ${PROMPTOBUS_CLIENT_TOKEN}' }, bearer_token_env_var: 'PROMPTOBUS_CLIENT_TOKEN', oauth: false } };
  driver.replaceMcpServers(launch, owned);
  const config = launch.mcpConfig;
  const entries = config.mcpServers ?? config.mcp;
  check(`: ${driver.id} refreshes its existing launch with HTTP bus and files while preserving external servers`,
    entries.promptobus.url === owned.promptobus.url && entries.reviewer_files.url === owned.reviewer_files.url
      && (driver.id !== 'codex' || entries.promptobus.disabled_tools?.join(',') === 'promptobus_send')
      && (driver.id === 'opencode' ? entries.external.command[0] === external.command : entries.external.command === external.command), JSON.stringify(config));
  check(`: ${driver.id} config serialization and same native launch agree`,
    (!launch.mcpConfigPath || JSON.stringify(JSON.parse(launch.files.find(file => file.path === launch.mcpConfigPath).text)) === JSON.stringify(config))
      && JSON.stringify(launch.argv) === JSON.stringify(argv) && launch.prelaunchBinding?.sessionId === prebound
      && JSON.stringify(launch.settings?.permission ?? launch.settings?.permissions) === permissions,
    JSON.stringify({ argv: launch.argv, prebound, config }));
  check(`: ${driver.id} plan refresh remains pure and emits credential references`,
    readdirSync(scratch).sort().join(',') === before && JSON.stringify(config).includes('PROMPTOBUS_CLIENT_TOKEN')
      && !JSON.stringify(config).includes('old-bus-fixture') && !JSON.stringify(config).includes('old-files-fixture'));
  check(`: ${driver.id} replaces the root profile helper and launch reference with its own managed descriptor`,
    !JSON.stringify(config).includes('fixture-root-profile-helper') && !JSON.stringify(config).includes('/private/root-launch'));
  driver.replaceMcpServers(launch, { promptobus: owned.promptobus });
  check(`: ${driver.id} removes an obsolete reviewer files grant`,
    !(launch.mcpConfig.mcpServers ?? launch.mcpConfig.mcp).reviewer_files);
}

createTask(home, { id: task, title: 'owned native ordering' });
upsertParticipant(home, task, participantRecord(address, { name: ref, sessionRef: ref, harness: 'opencode', mode: 'managed' }));
process.env.PROMPTOBUS_OPENCODE_HOME = path.join(scratch, 'registry');
const file = participantSessionPath(home, task, address);
const serviceHome = makeSockDir('pb-http-order-').dir, serviceEnv = { ...process.env, PROMPTOBUS_SERVICE_HOME: serviceHome, PROMPTOBUS_WARDEN: 'off' };
const binPath = path.resolve(import.meta.dirname, '../bin/promptobus.js'), version = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version;
const host = createStandaloneHost({ cwd: scratch, binPath, version }), paths = servicePaths(host, serviceEnv), services = [];
let serviceError;
const serviceRun = runWorkspaceService({ host, env: serviceEnv }).catch(error => { serviceError = error; });
const edge = Date.now() + 5000;
while (!readDiscovery(paths) && !serviceError && Date.now() < edge) await new Promise(resolve => setTimeout(resolve, 10));
if (serviceError) throw serviceError;
if (!readDiscovery(paths)) throw new Error('Owned handover service did not become ready');
const ownerEnvironment = createOwnerEnvironment(host, serviceEnv);
writeFileSync(path.join(scratch, 'serve'), `const{writeFileSync}=require('node:fs');writeFileSync(process.env.OPENCODE_DB,'SQLite format 3\\0',{mode:0o600});console.log('server listening on http://127.0.0.1:12345');setInterval(()=>{},1000);`);
async function managedOpenCode(plan, task, address, ref) {
  const callbacks = plan.service; delete plan.service;
  plan.launchId = callbacks.launchId; plan.mcpConfig = { mcp: {} };
  await finalizeManagedServiceLaunch(host, { launch: plan, driver: opencodeDriver, home, task, address, ref, cwd: scratch,
    env: { ...serviceEnv, PROMPTOBUS_OWNER_ENV_FILE: ownerEnvironment }, commonEnv: serviceEnv, deferTaskBinding: !taskExists(home, task) });
  services.push(plan.service);
  const { beforeStart, realize } = plan.service;
  plan.service.beforeStart = async file => { await beforeStart(file); await callbacks.beforeStart(file); };
  plan.service.realize = async id => { await realize(id); await callbacks.realize(id); };
  return plan;
}
const originalFetch = globalThis.fetch;
const events = [];
let pid = null;
let realized = false;
try {
globalThis.fetch = async (url, options) => {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  pid = record.holderPid;
  const route = `${options.method} ${new URL(url).pathname}`;
  if (route.endsWith('/prompt')) {
    events.push('prompt');
    check(': OpenCode first prompt follows actual native publication and realization',
      realized && record.sessionId === 'owned-native-session' && events.indexOf('persist') < events.indexOf('realize')
        && events.indexOf('realize') < events.indexOf('prompt'), JSON.stringify(events));
  }
  return new Response(JSON.stringify({ data: { id: 'owned-native-session' } }), { status: 200 });
};
try {
  const launched = await opencodeDriver.spawn(await managedOpenCode({
    argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'],
    cwd: scratch, env: { ...process.env, XDG_DATA_HOME: scratch, OPENCODE_DB: path.join(scratch, 'owned.db') }, prompt: 'fixture', holder: { password: 'fixture' }, permissionPollMs: 0,
    service: { launchId: 'owned-launch', clientId: 'fixture-client', credentialFile: '/private/fixture-client',
      beforeStart: async (recordPath) => {
        events.push('before-start');
        const record = JSON.parse(readFileSync(recordPath, 'utf8'));
        check(': OpenCode publishes its owned launch before starting the native holder',
          recordPath === file && record.ref === ref && record.launchId === 'owned-launch' && record.home === home
            && record.task === task && record.address === address && record.sessionId === null && !record.holderPid
            && readTask(home, task).participants.some(p => p.metadata.sessionRecord === file), JSON.stringify(record));
      },
      realize: async (nativeId) => {
        events.push('realize');
        await new Promise(resolve => setImmediate(resolve));
        realized = nativeId === 'owned-native-session';
      },
      revoke: async () => { events.push('revoke'); },
    },
  }, task, address, ref), { tool: { bin: process.execPath }, host, home, task, address, ref,
    persist: () => { events.push('persist'); } });
  check(': OpenCode service handover uses the actual createSession id once',
    launched.session === 'owned-native-session' && events.join(',') === 'before-start,persist,realize,prompt', JSON.stringify(events));
} finally {
  globalThis.fetch = originalFetch;
  if (pid) await reapHolder(pid);
  if (existsSync(file)) await opencodeDriver.stop(ref);
}

const futureTask = 'future-owner-t20261101-000001', futureRef = 'Future OpenCode owner';
let futureFile = null;
const futureEvents = [];
let futurePid = null, futureLaunch, futureError;
globalThis.fetch = async (url, options) => {
  const record = JSON.parse(readFileSync(futureFile, 'utf8'));
  futurePid = record.holderPid;
  if (new URL(url).pathname.endsWith('/prompt')) {
    futureEvents.push('prompt');
    check(': OpenCode first owner receives its first prompt after actual publication and realization',
      taskExists(home, futureTask) && record.sessionId === 'future-native-id'
      && futureEvents.indexOf('persist') < futureEvents.indexOf('realize')
      && futureEvents.indexOf('realize') < futureEvents.indexOf('prompt'), JSON.stringify(futureEvents));
  }
  return new Response(JSON.stringify({ data: { id: 'future-native-id' } }), { status: 200 });
};
try {
  try {
    futureLaunch = await opencodeDriver.spawn(await managedOpenCode({
      argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'],
      cwd: scratch, env: { ...process.env, XDG_DATA_HOME: scratch, OPENCODE_DB: path.join(scratch, 'future.db') }, prompt: 'fixture', holder: { password: 'fixture' }, permissionPollMs: 0,
      service: { launchId: 'future-launch', clientId: 'future-client', credentialFile: '/private/future-client',
        beforeStart: async file => {
          futureFile = file;
          futureEvents.push('before-start');
          check(': OpenCode first owner stages a record without fabricating a task or actor',
            path.isAbsolute(file) && !taskExists(home, futureTask) && JSON.parse(readFileSync(file, 'utf8')).sessionId === null);
        },
        realize: async id => {
          futureEvents.push('realize');
          check(': OpenCode first owner realizes only the actual published native API identity',
            id === 'future-native-id' && taskExists(home, futureTask)
            && readTask(home, futureTask).participants.some(p => p.metadata.sessionId === id && p.metadata.sessionRecord === futureFile));
        },
        revoke: async () => { futureEvents.push('revoke'); },
      },
    }, futureTask, 'orchestrator', futureRef), { tool: { bin: process.execPath }, host, home, task: futureTask, address: 'orchestrator', ref: futureRef, role: 'teamlead',
      persist: (id, state, full) => {
        futureEvents.push('persist');
        createTask(home, { id: futureTask, title: 'actual native owner', owner: id });
        upsertParticipant(home, futureTask, participantRecord('orchestrator', {
          harness: 'opencode', mode: 'attached', sessionRef: futureRef,
          sessionId: full, sessionRecord: futureFile, owner: id,
        }));
      },
    });
  } catch (error) { futureError = error; }
  check(': OpenCode first teamlead can launch before its child task exists',
    futureLaunch?.session === 'future-native-id' && futureEvents.join(',') === 'before-start,persist,realize,prompt',
    futureError?.message ?? JSON.stringify(futureEvents));
} finally {
  globalThis.fetch = originalFetch;
  if (futurePid) await reapHolder(futurePid);
  if (futureFile && existsSync(futureFile)) await opencodeDriver.stop(futureRef);
}
} finally {
  globalThis.fetch = originalFetch;
  for (const service of services) await service.revoke();
  await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) });
  await serviceRun; rmSync(serviceHome, { recursive: true, force: true });
  if (serviceError) throw serviceError;
}

const originalFailure = new Error('native API launch failed after confirmation');
const revokeFailure = new Error('private owner control is unavailable');
const retainedRecord = '/owned/fixture/native-session.json';
let failure;
try {
  await revokeFailedManagedLaunch({ argv: [], files: [], sessionRecord: retainedRecord,
    service: { revoke: async () => { throw revokeFailure; } } }, originalFailure);
} catch (error) { failure = error; }
check(': failed native launch reports both causal messages and its exact record while cleanup stays unknown',
  failure instanceof AggregateError && failure.errors[0] === originalFailure && failure.errors[1] === revokeFailure
  && failure.message.includes(originalFailure.message) && failure.message.includes(revokeFailure.message)
  && failure.message.includes(retainedRecord) && failure.message.includes('state is unknown'), failure?.message);

for (const driver of [claudeDriver, cursorDriver, opencodeDriver]) {
  const failedAddress = `worker:failed-${driver.id}`, failedRef = `Failed ${driver.id} launch`;
  upsertParticipant(home, task, participantRecord(failedAddress, { name: failedRef, sessionRef: failedRef, harness: driver.id, mode: 'managed' }));
  const failedRecord = driver.id === 'cursor' ? cursorSessionFile(failedRef, process.env) : participantSessionPath(home, task, failedAddress);
  const nativeFailure = new Error(`${driver.id} native launch transport failed`, { cause: new Error('fixture connection reset') });
  const cleanupFailure = new Error(`${driver.id} credential revocation is unavailable`);
  let revokeCalls = 0, stagedRecord, holderPid, driverFailure, callerFailure, nativeApiAttempted = false;
  const failedPlan = {
    argv: driver.id === 'opencode' ? ['serve', '--port', '0', '--hostname', '127.0.0.1'] : [],
    cwd: scratch, env: { ...process.env, XDG_DATA_HOME: scratch, OPENCODE_DB: path.join(scratch, 'failed.db') }, prelaunchBinding: { sessionRecord: failedRecord },
    prompt: 'fixture', holder: { password: 'fixture' }, permissionPollMs: 0,
    service: {
      launchId: `failed-${driver.id}-launch`, clientId: 'failed-client', credentialFile: '/private/failed-client',
      beforeStart: async file => {
        stagedRecord = file;
        if (driver.id !== 'opencode') throw nativeFailure;
      },
      realize: async () => {},
      revoke: async () => { revokeCalls += 1; throw cleanupFailure; },
    },
  };
  globalThis.fetch = async (url, options) => {
    holderPid = JSON.parse(readFileSync(stagedRecord, 'utf8')).holderPid;
    if (options.method === 'POST' && new URL(url).pathname === '/api/session') {
      nativeApiAttempted = true;
      throw nativeFailure;
    }
    return new Response('[]', { status: 200 });
  };
  try {
    try {
      await driver.spawn(failedPlan, { tool: { bin: process.execPath }, home, task, address: failedAddress,
        ref: failedRef, role: 'worker', cwd: scratch, env: process.env, persist: () => {} });
    } catch (error) { driverFailure = error; }
    try { await revokeFailedManagedLaunch(failedPlan, driverFailure); }
    catch (error) { callerFailure = error; }
    check(`: ${driver.id} driver preserves launch and revocation failures through its caller`,
      driverFailure instanceof AggregateError && driverFailure.errors[0] === nativeFailure && driverFailure.errors[1] === cleanupFailure
        && driverFailure.cause === nativeFailure && driverFailure.errors[0].cause.message === 'fixture connection reset'
        && driverFailure.message.includes(nativeFailure.message) && driverFailure.message.includes(cleanupFailure.message)
        && driverFailure.message.includes(failedRecord) && driverFailure.message.includes('state is unknown'), driverFailure?.message);
    check(`: ${driver.id} driver and caller revoke the failed managed launch exactly once`,
      callerFailure === driverFailure && revokeCalls === 1, JSON.stringify({ revokeCalls, message: callerFailure?.message }));
    check(`: ${driver.id} failed revocation retains its exact owned native record`,
      stagedRecord === failedRecord && existsSync(failedRecord)
        && JSON.parse(readFileSync(failedRecord, 'utf8')).launchId === failedPlan.service.launchId, failedRecord);
    if (driver.id === 'opencode') check(': OpenCode failure regression reaches the actual native createSession adapter', nativeApiAttempted);
  } finally {
    globalThis.fetch = originalFetch;
    if (holderPid) await reapHolder(holderPid);
  }
}

let callbackCalls = 0, callbackRevokes = 0, callbackFailure, repeatedCallbackFailure;
const callbackPlan = { argv: [], files: [], sessionRecord: retainedRecord,
  service: { revoke: async () => { callbackRevokes += 1; } } };
try {
  await revokeFailedManagedLaunch(callbackPlan, originalFailure, () => { callbackCalls += 1; throw revokeFailure; });
} catch (error) { callbackFailure = error; }
try { await revokeFailedManagedLaunch(callbackPlan, callbackFailure); }
catch (error) { repeatedCallbackFailure = error; }
check(': post-revocation cleanup failure preserves both causes and its native uncertainty',
  callbackFailure instanceof AggregateError && callbackFailure.cause === originalFailure
    && callbackFailure.errors[0] === originalFailure && callbackFailure.errors[1] === revokeFailure
    && callbackFailure.message.includes('native launch cleanup failed') && callbackFailure.message.includes(originalFailure.message)
    && callbackFailure.message.includes(revokeFailure.message) && callbackFailure.message.includes(retainedRecord)
    && callbackFailure.message.includes('state is unknown'), callbackFailure?.message);
check(': a caller does not repeat a failed post-revocation cleanup or credential operation',
  callbackFailure === repeatedCallbackFailure && callbackCalls === 1 && callbackRevokes === 1);
const successEvents = [];
let successfulCleanupFailure;
try {
  await revokeFailedManagedLaunch({ argv: [], files: [], service: { revoke: async () => { successEvents.push('revoke'); } } },
    originalFailure, () => { successEvents.push('cleanup'); });
} catch (error) { successfulCleanupFailure = error; }
check(': successful revocation precedes native record cleanup and preserves the original launch error',
  successfulCleanupFailure === originalFailure && successEvents.join(',') === 'revoke,cleanup');

const asyncRecord = path.join(scratch, 'async-failed-cleanup.json');
writeFileSync(asyncRecord, JSON.stringify({ ref: 'owned-async-failure', sessionId: 'actual-native-id' }));
let rejectCleanup;
const asynchronousCleanup = new Promise((resolve, reject) => { rejectCleanup = reject; });
asynchronousCleanup.catch(() => {});
let asyncFailure, asyncRevokes = 0;
const asyncPlan = { argv: [], files: [], sessionRecord: asyncRecord, service: { revoke: async () => { asyncRevokes += 1; } } };
const failedCleanup = revokeFailedManagedLaunch(asyncPlan, originalFailure, () => asynchronousCleanup);
rejectCleanup(revokeFailure);
try { await failedCleanup; } catch (error) { asyncFailure = error; }
check(': awaited native cleanup rejection preserves the launch cause and retained record',
  asyncFailure instanceof AggregateError && asyncFailure.errors[0] === originalFailure && asyncFailure.errors[1] === revokeFailure
    && asyncFailure.cause === originalFailure && asyncFailure.message.includes(asyncRecord) && existsSync(asyncRecord), asyncFailure?.message);
try { await revokeFailedManagedLaunch(asyncPlan, asyncFailure); } catch { /* same retained failure */ }
check(': caller does not repeat revoke after an asynchronous cleanup failure', asyncRevokes === 1);

const hintedAddress = 'worker:actual-claude', hintedRef = 'Actual Claude native identity';
upsertParticipant(home, task, participantRecord(hintedAddress, { harness: 'claude', sessionRef: hintedRef }));
const hintedReserved = readTask(home, task).participants.find(p => p.metadata.address === hintedAddress);
const hintedPlan = claudeDriver.prepare({ ref: hintedRef, role: 'worker', model: 'opus', prompt: 'fixture', cwd: scratch, root: scratch,
  home, task, address: hintedAddress, env: process.env, mcp: { servers: { promptobus: { command: 'fixture-bus' } }, home, task, address: hintedAddress },
  mcpConfigPath: path.join(scratch, 'hinted.mcp.json'), settingsPath: path.join(scratch, 'hinted.settings.json'), guardCommand: 'fixture-guard' });
const actualClaudeId = '11111111-1111-4111-8111-111111111111', hintEvents = [];
const nativeFixtures = path.join(scratch, 'native-fixtures');
stubCommand(nativeFixtures, 'claude-hinted', `console.log('backgrounded · ${actualClaudeId.slice(0, 8)} · ${hintedRef}');`);
hintedPlan.service = { launchId: 'hinted-claude-launch', clientId: 'hinted-client', credentialFile: '/private/hinted-client',
  beforeStart: async () => { hintEvents.push('before-start'); },
  realize: async id => {
    hintEvents.push('realize');
    check(': Claude realizes only its actual confirmed native id after publishing the owned record',
      id === actualClaudeId && JSON.parse(readFileSync(hintedPlan.sessionRecord, 'utf8')).sessionId === actualClaudeId
        && readTask(home, task).participants.some(p => p.metadata.address === hintedAddress && p.metadata.sessionId === actualClaudeId));
  }, revoke: async () => { hintEvents.push('revoke'); } };
let hintedResult, hintedFailure;
try {
  hintedResult = await claudeDriver.spawn(hintedPlan, { tool: { bin: path.join(nativeFixtures, 'claude-hinted') }, home, task, address: hintedAddress, ref: hintedRef,
    role: 'worker', cwd: scratch, env: process.env, persist: (id, state, full) => {
      hintEvents.push('persist');
      persistLegacyParticipant(home, task, { ...hintedReserved, metadata: { ...hintedReserved.metadata,
        sessionRecord: hintedPlan.sessionRecord, session: id, sessionId: full, pending: state === 'dead' } });
    },
    awaitOptions: { tries: 1, delayMs: 0, sessions: () => [{ name: hintedRef, id: actualClaudeId.slice(0, 8), sessionId: actualClaudeId, pid: process.pid }] } });
} catch (error) { hintedFailure = error; }
check(': Claude accepts an actual native UUID that differs from its requested launch hint',
  hintedPlan.prelaunchBinding.sessionId !== actualClaudeId && hintedResult?.session === actualClaudeId.slice(0, 8)
    && hintEvents.join(',') === 'before-start,persist,realize', JSON.stringify({ error: hintedFailure?.message, hintedResult, hintEvents,
      record: JSON.parse(readFileSync(hintedPlan.sessionRecord, 'utf8')),
      participant: readTask(home, task).participants.find(p => p.metadata.address === hintedAddress) }));

const swappedAddress = 'worker:swapped-claude', swappedRef = 'Swapped Claude native generation';
upsertParticipant(home, task, participantRecord(swappedAddress, { harness: 'claude', sessionRef: swappedRef }));
const swappedReserved = readTask(home, task).participants.find(p => p.metadata.address === swappedAddress);
const swappedPlan = claudeDriver.prepare({ ref: swappedRef, role: 'worker', model: 'opus', prompt: 'fixture', cwd: scratch, root: scratch,
  home, task, address: swappedAddress, env: process.env, mcp: { servers: { promptobus: { command: 'fixture-bus' } }, home, task, address: swappedAddress },
  mcpConfigPath: path.join(scratch, 'swapped.mcp.json'), settingsPath: path.join(scratch, 'swapped.settings.json'), guardCommand: 'fixture-guard' });
stubCommand(nativeFixtures, 'claude-swapped', `console.log('backgrounded · ${actualClaudeId.slice(0, 8)} · ${swappedRef}');`);
let swappedRealizations = 0, swappedPersistCalls = 0, swappedFailure, replacementBytes, replacementParticipant;
swappedPlan.service = { launchId: 'original-claude-generation', clientId: 'swapped-client', credentialFile: '/private/swapped-client',
  beforeStart: async () => {}, realize: async () => { swappedRealizations += 1; }, revoke: async () => {} };
try {
  await claudeDriver.spawn(swappedPlan, { tool: { bin: path.join(nativeFixtures, 'claude-swapped') }, home, task, address: swappedAddress, ref: swappedRef,
    role: 'worker', cwd: scratch, env: process.env, persist: (id, state, full) => {
      swappedPersistCalls += 1;
      persistLegacyParticipant(home, task, { ...swappedReserved, metadata: { ...swappedReserved.metadata,
        sessionRecord: swappedPlan.sessionRecord, session: id, sessionId: full, pending: state === 'dead' } });
    },
    awaitOptions: { tries: 1, delayMs: 0, sessions: () => {
      const file = swappedPlan.sessionRecord, record = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...record, launchId: 'replacement-claude-generation', sessionId: null, expectedSessionId: actualClaudeId }));
      upsertParticipant(home, task, participantRecord(swappedAddress, { harness: 'claude', sessionRef: swappedRef,
        sessionRecord: file, pending: true, replacementOwner: 'must-stay-byte-stable' }));
      replacementBytes = readFileSync(file, 'utf8');
      replacementParticipant = JSON.stringify(readTask(home, task).participants.find(p => p.metadata.address === swappedAddress));
      const beforeParticipant = JSON.stringify(readTask(home, task).participants);
      const bound = bindHandshake(home, task, swappedAddress, { [SESSION_RECORD_VAR]: file }, actualClaudeId,
      { ref: swappedRef, launchId: 'original-claude-generation' });
      check(': managed Claude handshake rejects a replaced generation before any record or participant write',
      bound === 'refused' && readFileSync(file, 'utf8') === replacementBytes
        && JSON.stringify(readTask(home, task).participants) === beforeParticipant);
      return [{ name: swappedRef, id: actualClaudeId.slice(0, 8), sessionId: actualClaudeId, pid: process.pid }];
    } } });
} catch (error) { swappedFailure = error; }
const swappedRecord = JSON.parse(readFileSync(swappedPlan.sessionRecord, 'utf8'));
check(': Claude driver refuses generation replacement before realizing an old native launch',
  swappedFailure?.message.includes('changed its owned generation') && swappedRealizations === 0 && swappedPersistCalls === 0
    && swappedRecord.launchId === 'replacement-claude-generation' && swappedRecord.sessionId === null
    && readFileSync(swappedPlan.sessionRecord, 'utf8') === replacementBytes
    && JSON.stringify(readTask(home, task).participants.find(p => p.metadata.address === swappedAddress)) === replacementParticipant,
  JSON.stringify({ message: swappedFailure?.message, swappedPersistCalls, swappedRealizations }));

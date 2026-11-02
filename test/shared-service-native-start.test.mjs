import { check, skip } from './check.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { runWorkspaceService } from '../lib/service.js';
import { serviceControl } from '../lib/service-client.js';
import { createOwnerEnvironment, finalizeManagedServiceLaunch } from '../lib/service-launch.js';
import { authorizeManagedNativeStart } from '../lib/native-start.js';
import { guard } from '../lib/guard.js';
import { PROMPTOBUS_SERVER } from '../lib/contract.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { readDiscovery, readPrivate, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { bus, createTask, lastTurnAt, participantOf, participantRecord, participantSessionPath, readTask, taskExists, upsertParticipant, workersDir, writeJsonAtomic } from '../lib/store.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('managed native start binding', 'This platform has no implemented process-birth observer');
} else {
  const root = realpathSync(makeSandbox('promptobus-native-start-'));
  const serviceHome = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-native-start-'));
  const home = path.join(root, '.promptobus'), binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
  const ownerNativeStore = path.join(root, 'owner-native-config'); mkdirSync(ownerNativeStore);
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const env = { ...process.env, PROMPTOBUS_HOME: home, PROMPTOBUS_SERVICE_HOME: serviceHome,
    PROMPTOBUS_SERVICE_IDLE_MS: '60000', PROMPTOBUS_WARDEN: 'off', CLAUDE_CONFIG_DIR: ownerNativeStore };
  for (const key of Object.keys(env)) if (/^PROMPTOBUS_(CLIENT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$)/.test(key)) delete env[key];
  writeHostConfig(root, { tools: [] });
  const host = createStandaloneHost({ cwd: root, binPath, version }), paths = servicePaths(host, env);
  const options = { env, cwd: root }, launches = [];
  let failure;
  const running = runWorkspaceService({ host, env, createHost: context => createStandaloneHost({ cwd: context.cwd, binPath, version }) })
    .catch(error => { failure = error; });
  const refused = async action => { try { await action(); return false; } catch { return true; } };
  try {
    const deadline = Date.now() + 5000;
    while (!readDiscovery(paths) && !failure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (failure) throw failure;
    if (!readDiscovery(paths)) throw new Error('Native start fixture service did not become ready');
    bus(home, { cli: version });
    const owner = createOwnerEnvironment(host, env);
    let stoppedWithoutCredential = true;
    try { await authorizeManagedNativeStart(host, { hook_event_name: 'Stop' }, { ...env, PROMPTOBUS_CLIENT_FILE: path.join(paths.clients, 'revoked.json') }, root); }
    catch { stoppedWithoutCredential = false; }
    check('ordinary Stop does not reopen a revoked native-start credential', stoppedWithoutCredential);
    for (const harness of ['claude', 'cursor']) {
      const task = `native-${harness}-t20261101-000000`, address = 'worker:native', ref = `native-${harness}-ref`;
      const nativeId = `actual-${harness}`, idField = harness === 'cursor' ? 'chatId' : 'sessionId';
      createTask(home, { id: task, title: 'Native start binding', owner: 'fixture-owner' });
      const driver = { id: harness, replaceMcpServers(launch, servers) { launch.servers = servers; } };
      const finalized = await finalizeManagedServiceLaunch(host, { launch: {}, driver, home, task, address, ref, cwd: root,
        env: { ...env, PROMPTOBUS_OWNER_ENV_FILE: owner }, commonEnv: env });
      launches.push(finalized.service);
      const record = harness === 'claude' ? participantSessionPath(home, task, address) : path.join(paths.directory, `${harness}-record.json`);
      const mask = process.umask(0o022);
      try {
        mkdirSync(path.dirname(record), { recursive: true });
        writeJsonAtomic(record, { home, task, address, ref, launchId: finalized.service.launchId, [idField]: null,
          ...(harness === 'claude' ? { expectedSessionId: `requested-hint-${nativeId}` } : {}) }, { mode: 0o600 });
      } finally { process.umask(mask); }
      upsertParticipant(home, task, participantRecord(address, { harness, sessionRef: ref, sessionRecord: record }));
      await finalized.service.beforeStart(record);
      const provenance = readPrivate(record).nativeLaunchProvenance;
      check(`${harness} stages only an explicit trusted native launch store and leaves unproved kinds unknown`,
        provenance.ownerEnvironment === owner && (harness === 'claude'
          ? provenance.nativeStore === ownerNativeStore && provenance.source === 'owner-environment/CLAUDE_CONFIG_DIR'
          : provenance.nativeStore === null && provenance.source === 'unknown'));
      const transcript = path.join(ownerNativeStore, 'projects', task, `${nativeId}.jsonl`);
      mkdirSync(path.dirname(transcript), { recursive: true });
      writeFileSync(transcript, `${JSON.stringify({ sessionId: nativeId })}\n`);
      const start = { hook_event_name: harness === 'cursor' ? 'sessionStart' : 'SessionStart',
        [harness === 'cursor' ? 'conversation_id' : 'session_id']: nativeId, cwd: root, transcript_path: transcript };
      const inherited = { ...finalized.env, CLAUDE_CODE_SESSION_ID: nativeId, CURSOR_CONVERSATION_ID: nativeId };
      check(`${harness} start cannot take native identity from inherited env`, await refused(() =>
        authorizeManagedNativeStart(host, { hook_event_name: start.hook_event_name }, inherited, root))
        && readPrivate(record)[idField] === null && readPrivate(finalized.service.credentialFile).nativeBinding.state === 'pending');
      await authorizeManagedNativeStart(host, { ...start, hook_event_name: 'Stop' }, finalized.env, root);
      check(`${harness} Stop cannot realize a pending native identity`, readPrivate(record)[idField] === null);
      const turnBefore = lastTurnAt(home, task, address);
      const input = { isTTY: false, setEncoding() {}, async *[Symbol.asyncIterator]() { yield JSON.stringify(start); } };
      const nativeEnv = { ...finalized.env, [harness === 'cursor' ? 'PROMPTOBUS_CURSOR_SESSION' : 'PROMPTOBUS_CLAUDE_SESSION']: record,
        [harness === 'cursor' ? 'CURSOR_CONVERSATION_ID' : 'CLAUDE_CODE_SESSION_ID']: nativeId };
      const unproved = await refused(() => guard({ host }, nativeEnv, root, input));
      check(`${harness} an unproved hook can publish identity but cannot realize its first native grant`, unproved && readPrivate(record)[idField] === nativeId
        && readPrivate(finalized.service.credentialFile).nativeBinding.state === 'pending'
        && participantOf(readTask(home, task), address).metadata.sessionId === nativeId);
      if (harness === 'claude') check('Claude ordinary workers SessionStart keeps record0600 and directory0755 through real guard binding',
        (statSync(record).mode & 0o777) === 0o600 && (statSync(path.dirname(record)).mode & 0o777) === 0o755);
      check(`${harness} SessionStart does not advance the participant turn`, lastTurnAt(home, task, address) === turnBefore);
      check(`${harness} keeps actual hook transcript evidence without manufacturing a native process birth`,
        readPrivate(record).nativeStartEvidence.transcript === realpathSync(transcript)
          && !readPrivate(record).nativeAdmission && readPrivate(record).nativeAdmissionUnknown.nativeId === nativeId);
      check(`${harness} a second native identity cannot replace the first`, await refused(() => authorizeManagedNativeStart(host,
        { ...start, [harness === 'cursor' ? 'conversation_id' : 'session_id']: 'foreign-native' }, finalized.env, root))
        && readPrivate(record)[idField] === nativeId);
    }
    {
      const task = 'foreign-config-t20261101-000000', address = 'worker:foreign-config', ref = 'foreign-config';
      const actorConfig = path.join(root, 'actor-native-config'); mkdirSync(actorConfig);
      createTask(home, { id: task, title: 'Actor config is not native provenance', owner: 'fixture-owner' });
      const finalized = await finalizeManagedServiceLaunch(host, { launch: {}, driver: { id: 'claude', replaceMcpServers() {} },
        home, task, address, ref, cwd: root, env: { ...env, PROMPTOBUS_OWNER_ENV_FILE: owner, CLAUDE_CONFIG_DIR: actorConfig }, commonEnv: env });
      launches.push(finalized.service);
      const record = path.join(paths.directory, 'actor-config-record.json');
      writePrivate(record, { home, task, address, ref, launchId: finalized.service.launchId, sessionId: null });
      upsertParticipant(home, task, participantRecord(address, { harness: 'claude', sessionRef: ref, sessionRecord: record }));
      await finalized.service.beforeStart(record);
      check('actor CLAUDE_CONFIG_DIR cannot replace the trusted owner native store or become confirmed provenance',
        readPrivate(record).nativeLaunchProvenance.nativeStore === null && !readPrivate(record).nativeAdmission);
    }
    const mask = process.umask(0o022);
    try {
      mkdirSync(path.join(env.HOME, '.local', 'share'), { recursive: true });
      for (const driver of [claudeDriver, opencodeDriver]) {
        const task = `worker-stage-${driver.id}-t20261101-000001`, address = 'worker:staging', ref = `${driver.id}-ordinary-worker`;
        createTask(home, { id: task, title: 'Ordinary worker staging' });
        mkdirSync(workersDir(home, task), { recursive: true });
        upsertParticipant(home, task, participantRecord(address, { harness: driver.id, mode: 'managed', sessionRef: ref }));
        const launch = driver.prepare({ ref, role: 'worker', model: driver.options.defaultModel, prompt: 'fixture', root, cwd: root,
          home, task, address, env, skillsRoot: null, mcp: { servers: { [PROMPTOBUS_SERVER]: { command: 'unused-bus' } }, home, task, address }, guardCommand: 'unused-native-guard',
          mcpConfigPath: path.join(root, `${driver.id}.worker-mcp.json`), settingsPath: path.join(root, `${driver.id}.worker-settings.json`) });
        const finalized = await finalizeManagedServiceLaunch(host, { launch, driver, home, task, address, ref, cwd: root,
          env: { ...env, PROMPTOBUS_OWNER_ENV_FILE: owner }, commonEnv: env });
        launches.push(finalized.service);
        const beforeStart = finalized.service.beforeStart.bind(finalized.service), stopAtNativeBoundary = new Error('fixture stops after actual worker staging');
        let staged = false, workerFile, parentMode, fileMode, observedFailure;
        finalized.service.beforeStart = async file => {
          workerFile = file; parentMode = statSync(path.dirname(file)).mode & 0o777;
          await beforeStart(file);
          staged = true; fileMode = statSync(file).mode & 0o777;
          throw stopAtNativeBoundary;
        };
        for (const file of launch.files) { mkdirSync(path.dirname(file.path), { recursive: true }); writeFileSync(file.path, file.text); }
        try {
          await driver.spawn(launch, { tool: { bin: process.execPath }, host, home, task, address, ref, role: 'worker', cwd: root,
            env: finalized.env, persist: () => {} });
        } catch (error) { observedFailure = error; }
        check(`${driver.id} actual worker beforeStart stages its owned 0600 record in the ordinary 0755 workers directory under umask022`,
          staged && observedFailure === stopAtNativeBoundary && workerFile === participantSessionPath(home, task, address)
            && parentMode === 0o755 && (statSync(workersDir(home, task)).mode & 0o777) === 0o755 && fileMode === 0o600,
          `${workerFile} ${observedFailure?.stack}`);
      }
    } finally { process.umask(mask); }
    const task = 'deferred-native-t20261101-000000', address = 'orchestrator', ref = 'deferred-native-ref';
    const driver = { id: 'claude', replaceMcpServers() {} };
    const deferred = await finalizeManagedServiceLaunch(host, { launch: {}, driver, home, task, address, ref, cwd: root,
      env: { ...env, PROMPTOBUS_OWNER_ENV_FILE: owner }, commonEnv: env, deferTaskBinding: true });
    launches.push(deferred.service);
    const record = path.join(paths.directory, 'deferred-native-record.json');
    writePrivate(record, { home, task, address, ref, launchId: deferred.service.launchId, sessionId: null, expectedSessionId: 'deferred-native' });
    await deferred.service.beforeStart(record);
    await authorizeManagedNativeStart(host, { hook_event_name: 'SessionStart', session_id: 'deferred-native' }, deferred.env, root);
    check('a future owner start records real identity without inventing a task or realizing authority', !taskExists(home, task)
      && readPrivate(record).sessionId === 'deferred-native' && readPrivate(deferred.service.credentialFile).nativeBinding.state === 'pending');
  } finally {
    for (const launch of launches) if (existsSync(launch.credentialFile)) await launch.revoke();
    if (!failure) await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) });
    await running;
    rmSync(serviceHome, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

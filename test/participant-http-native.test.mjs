import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeSandbox, makeSockDir, stubCommand, withStubPath, writeHostConfig } from './sandbox.mjs';
import { DAEMON_IDENTITY } from './harness.mjs';
import { openScriptedHttp, scriptedHttpHelperBinary, connectionHeaders as nativeConnectionHeaders } from './participant-http.mjs';

const runtime = process.argv[2] ? pathToFileURL(`${path.resolve(process.argv[2])}/`) : new URL('../', import.meta.url);
const { createStandaloneHost } = await import(new URL('dist/host-index.js', runtime));
const { guardHookCommand } = await import(new URL('dist/hooks.js', runtime));
const { claudeDriver } = await import(new URL('lib/driver-claude.js', runtime));
const { bindManagedNativeStart } = await import(new URL('lib/drivers.js', runtime));
const { createOwnerEnvironment, finalizeManagedServiceLaunch } = await import(new URL('lib/service-launch.js', runtime));
const { runWorkspaceService } = await import(new URL('lib/service.js', runtime));
const { serviceControl } = await import(new URL('lib/service-client.js', runtime));
const { readDiscovery, readPrivate, recordVersion, requireProcess, runtimeIdentity, servicePaths } = await import(new URL('lib/service-state.js', runtime));
const { bus, createTask, participantRecord, readWake, upsertParticipant, writeJsonAtomic } = await import(new URL('lib/store.js', runtime));

test('configured SessionStart realizes a verified fixture tuple; omitting it leaves HTTP tools denied', async () => {
  const root = realpathSync(makeSandbox('promptobus-harness-http-native-'));
  const serviceHome = path.join(makeSockDir('a2h-').dir, 'service');
  const home = path.join(root, '.promptobus'), task = 'participant-http-t20261101-000001', address = 'worker:http';
  const ref = 'scripted HTTP native participant', nativeId = randomUUID();
  const binPath = fileURLToPath(new URL('bin/promptobus.js', runtime));
  const version = JSON.parse(readFileSync(new URL('package.json', runtime), 'utf8')).version;
  const nativeStore = path.join(root, 'native-account'), bin = path.join(root, 'bin');
  mkdirSync(nativeStore); mkdirSync(bin);
  stubCommand(bin, 'claude', `if(process.argv[2]==='agents')console.log(JSON.stringify([{name:${JSON.stringify(ref)},id:${JSON.stringify(nativeId.slice(0,8))},sessionId:${JSON.stringify(nativeId)},pid:${process.pid},status:'idle'}]));else process.exitCode=1;`);
  const restorePath = withStubPath(bin);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: nativeStore, PROMPTOBUS_HOME: home, PROMPTOBUS_SERVICE_HOME: serviceHome, PROMPTOBUS_WARDEN: 'off' };
  for (const key of Object.keys(env)) if (/^PROMPTOBUS_(CLIENT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$)/.test(key)) delete env[key];
  writeHostConfig(root, { tools: ['claude'] });
  const nodePath = env.PROMPTOBUS_TEST_PATH_SEAL ? path.join(env.PROMPTOBUS_TEST_PATH_SEAL, 'node') : process.execPath;
  const host = createStandaloneHost({ cwd: root, binPath, version, nodePath }), paths = servicePaths(host, env);
  let serviceError, launch, client;
  const failures = [];
  const running = runWorkspaceService({ host, env, createHost: context => createStandaloneHost({ cwd: context.cwd, binPath, version, nodePath }) })
    .catch(error => { serviceError = error; });
  try {
    const deadline = Date.now() + 5000;
    while (!readDiscovery(paths) && !serviceError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (serviceError) throw serviceError;
    assert.ok(readDiscovery(paths), 'HTTP native fixture service reached readiness');
    bus(home, { cli: version });
    createTask(home, { id: task, title: 'Scripted native HTTP scope', owner: 'fixture-owner' });
    const configPath = path.join(root, 'participant-mcp.json'), settingsPath = path.join(root, 'participant-settings.json');
    const plan = claudeDriver.prepare({ ref, role: 'worker', cwd: root, prompt: 'fixture', model: 'fixture',
      mcp: { home, task, address, servers: { promptobus: { command: process.execPath, args: [binPath, 'mcp'],
        env: { PROMPTOBUS_HOME: home, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: address } } } },
      mcpConfigPath: configPath, settingsPath, guardCommand: guardHookCommand(host, { home, taskId: task, address }) });
    const finalized = await finalizeManagedServiceLaunch(host, { launch: plan, driver: claudeDriver,
      home, task, address, ref, cwd: root, env: { ...env, PROMPTOBUS_OWNER_ENV_FILE: createOwnerEnvironment(host, env) }, commonEnv: env });
    launch = finalized.service;
    for (const file of plan.files) {
      mkdirSync(path.dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.text, { mode: file.secret ? 0o600 : 0o644 });
    }
    const record = plan.prelaunchBinding.sessionRecord;
    const before = JSON.parse(readFileSync(record, 'utf8'));
    writeJsonAtomic(record, { ...before, ref, launchId: launch.launchId, sessionId: null,
      nativeCommand: { executable: recordVersion(realpathSync(process.execPath)), nativeStore, argv: ['--bg', 'fixture prompt'] } }, { mode: 0o600 });
    upsertParticipant(home, task, participantRecord(address, { harness: 'claude', mode: 'managed', sessionRef: ref, sessionRecord: record }));
    await launch.beforeStart(record);
    const config = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.promptobus;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(scriptedHttpHelperBinary(config), binPath, 'the configured HTTP helper names the actual CLI binary');
    assert.equal(scriptedHttpHelperBinary({ headersHelper: 'node /foreign.js service headers' }), null, 'an unknown helper shape cannot supply the binary identity');
    const sessionEnv = { ...finalized.env, ...DAEMON_IDENTITY, CLAUDE_CODE_SESSION_ID: nativeId,
      PROMPTOBUS_CLIENT_FILE: '/unrelated-daemon-client.json', PROMPTOBUS_CLIENT_TOKEN: 'unrelated-daemon-token',
      CLAUDE_CODE_MESSAGING_SOCKET: path.join(root, 'native-contact.sock'), CLAUDE_CODE_MESSAGING_TOKEN: 'native-contact-token' };
    const headers = await nativeConnectionHeaders(config, sessionEnv, root);
    const initialized = await fetch(config.url, { method: 'POST', headers: { ...headers,
      accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18',
      capabilities: {}, clientInfo: { name: 'missing-hook-negative', version: '1' } } }) });
    const initializedBody = await initialized.text();
    assert.equal(initialized.status, 200, initializedBody);
    const session = initialized.headers.get('mcp-session-id');
    const connectionHeaders = { ...headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' };
    const ready = await fetch(config.url, { method: 'POST', headers: connectionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(ready.status, 202);
    const denied = await fetch(config.url, { method: 'POST', headers: connectionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'promptobus_task', arguments: {} } }) });
    assert.equal(denied.status, 403, 'without SessionStart, the actual HTTP owner denies pending native tools');
    await denied.text();
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).sessionId, null);
    const closed = await fetch(config.url, { method: 'DELETE', headers: connectionHeaders });
    assert.equal(closed.status, 204);
    assert.equal(readWake(home, task, address), null, 'pending discovery cannot publish a native contact');
    const transcript = path.join(nativeStore, `${nativeId}.jsonl`), nativeProcess = requireProcess();
    writeFileSync(transcript, JSON.stringify({ sessionId: nativeId }) + '\n', { mode: 0o600 });
    const executable = readPrivate(record).nativeCommand.executable;
    const binding = { harness: 'claude', nativeStore, nativeId, process: nativeProcess };
    // This owner-side unit packet represents a verified producer; the configured hook tests realization, not native creation.
    bindManagedNativeStart({ harness: 'claude', home, task, address, ref, record, launchId: launch.launchId, nativeId, transcript,
      nativeProof: { version: recordVersion(record), binding, evidence: { kind: 'native-session-start', source: 'startup', ...binding, transcript, executable } } });
    assert.equal(readPrivate(launch.credentialFile).nativeBinding.state, 'pending', 'owner publication alone does not realize the pending client');
    client = await openScriptedHttp(config, { settings, env: sessionEnv, cwd: root, nativeId });
    assert.deepEqual(client.scope, { home, task, address });
    assert.equal(readWake(home, task, address)?.session, nativeId, 'configured SessionStart publishes wake before any first turn');
    assert.equal(readWake(home, task, address)?.socket, sessionEnv.CLAUDE_CODE_MESSAGING_SOCKET);
    assert.equal(readWake(home, task, address)?.token, sessionEnv.CLAUDE_CODE_MESSAGING_TOKEN);
    const ownWake = readWake(home, task, address);
    await assert.rejects(openScriptedHttp(config, { settings, env: { ...sessionEnv, CLAUDE_CODE_MESSAGING_SOCKET: '/foreign.sock' },
      cwd: root, nativeId: randomUUID() }), process.argv[2] ? /Scripted SessionStart hook exited/ : /Scripted SessionStart hook refused this session/);
    assert.deepEqual(readWake(home, task, address), ownWake, 'a foreign native ID cannot replace the owned contact point');
    assert.equal(readPrivate(launch.credentialFile).nativeBinding.sessionId, nativeId,
      'the actual configured hook realizes the same pending client before the authenticated scoped read');
  } catch (error) {
    failures.push(error);
  } finally {
    try { await client?.close(); }
    catch (error) { failures.push(new Error('HTTP native fixture client close failed', { cause: error })); }
    try { await launch?.revoke(); }
    catch (error) { failures.push(new Error('HTTP native fixture client revoke failed', { cause: error })); }
    try {
      if (readDiscovery(paths)) {
        const deadline = Date.now() + 5000;
        let status = await serviceControl(paths, { operation: 'status', runtime: runtimeIdentity(host) });
        while (status.warden.observations > 0) {
          assert.ok(Date.now() < deadline, `HTTP native fixture observations did not settle: ${JSON.stringify(status.warden)}`);
          await new Promise(resolve => setTimeout(resolve, 10));
          status = await serviceControl(paths, { operation: 'status', runtime: runtimeIdentity(host) });
        }
        await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) });
      }
      await running;
    } catch (error) { failures.push(new Error('HTTP native fixture owner shutdown failed', { cause: error })); }
    finally { restorePath(); }
  }
  if (serviceError && !failures.includes(serviceError)) failures.push(serviceError);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'HTTP native fixture failed; primary and cleanup errors retained');
});

import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, skip } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { openHttpBus } from './harness-cursor.mjs';
import { createStandaloneHost } from '../dist/host-index.js';
import { createTask } from '../lib/store.js';
import { runWorkspaceService } from '../lib/service.js';
import { registerServiceClient, realizeServiceClient, revokeServiceClient, serviceControl } from '../lib/service-client.js';
import { managedServiceServers } from '../lib/service-launch.js';
import { readDiscovery, requireProcess, runtimeIdentity, servicePaths } from '../lib/service-state.js';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('Cursor fixture HTTP authentication', 'Process birth observation is not implemented on this platform');
} else {
  const root = realpathSync(makeSandbox('promptobus-cursor-http-'));
  const privateHome = realpathSync(mkdtempSync(path.join(realpathSync('/tmp'), 'pb-cur-http-')));
  writeHostConfig(root, { tools: [] });
  const binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const host = createStandaloneHost({ cwd: root, binPath, version });
  const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: privateHome, PROMPTOBUS_WARDEN: 'off' };
  const paths = servicePaths(host, env), options = { env }, task = 'cursor-http-t20261101-000001', nativeId = 'cursor-fixture-native';
  createTask(paths.home, { id: task, title: 'scoped Cursor HTTP fixture', owner: nativeId });
  let serviceError, credential, client;
  const service = runWorkspaceService({ host, env, createHost: context => createStandaloneHost({ cwd: context.cwd, binPath, version }) })
    .catch(error => { serviceError = error; });
  try {
    const deadline = Date.now() + 5000;
    while (!readDiscovery(paths) && !serviceError) {
      if (Date.now() >= deadline) throw new Error('Cursor HTTP fixture owner did not become ready');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (serviceError) throw serviceError;
    credential = await registerServiceClient(host, { cwd: root,
      env: { ...env, PROMPTOBUS_HOME: paths.home, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: 'orchestrator' },
      lifetime: { kind: 'process', process: requireProcess() }, nativeBinding: { kind: 'cursor', state: 'pending' } }, options);
    await realizeServiceClient(host, credential.clientId, nativeId, options);
    let answer, error;
    try {
      client = await openHttpBus(managedServiceServers('cursor', credential).promptobus, { ...env, PROMPTOBUS_CLIENT_TOKEN: credential.token });
      answer = await client.rpc('tools/call', { name: 'promptobus_task', arguments: {} });
    } catch (caught) { error = caught; }
    check('Cursor HTTP fixture authenticates its scoped task read', !error && !answer?.result?.isError
      && answer?.result?.content?.some(item => item.text?.includes(task)), error?.message ?? JSON.stringify(answer));
  } finally {
    await client?.close();
    if (credential) await revokeServiceClient(host, credential.clientId, options);
    if (readDiscovery(paths)) await serviceControl(paths, { operation: 'stop', runtime: runtimeIdentity(host) });
    await service;
    rmSync(privateHome, { recursive: true, force: true });
  }
}

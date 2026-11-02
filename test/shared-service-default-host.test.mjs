import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { check, skip } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { createStandaloneHost } from '../dist/host-index.js';
import { ensureWorkspaceService, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { runtimeIdentity, sameProcess } from '../lib/service-state.js';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('default standalone cold HTTP owner', 'Process birth observation is not implemented on this platform');
} else {
  const root = realpathSync(makeSandbox('promptobus-default-owner-'));
  const privateHome = realpathSync(mkdtempSync(path.join(realpathSync('/tmp'), 'pb-default-')));
  writeHostConfig(root, { tools: [] });
  const host = createStandaloneHost({ cwd: root });
  const options = { env: { ...process.env, PROMPTOBUS_SERVICE_HOME: privateHome, PROMPTOBUS_WARDEN: 'off' } };
  let discovery;
  try {
    let startupError;
    try { discovery = await ensureWorkspaceService(host, options); }
    catch (error) { startupError = error; }
    const status = discovery ? await workspaceServiceStatus(host, options) : null;
    check('default standalone Host cold-starts its own installed CLI and exact runtime',
      status?.running && status.runtime === runtimeIdentity(host) && status.process.pid === discovery.process.pid,
      startupError?.message);
    if (discovery) {
      const reused = await ensureWorkspaceService(host, options);
      check('default standalone Host reuses the same physical owner', reused.process.pid === discovery.process.pid);
    }
  } finally {
    await stopWorkspaceService(host, options);
    if (discovery) check('default standalone owner physically exits before fixture cleanup', !sameProcess(discovery.process));
    else skip('default standalone owner physical exit', 'No owner reached startup readiness');
    rmSync(privateHome, { recursive: true, force: true });
  }
}

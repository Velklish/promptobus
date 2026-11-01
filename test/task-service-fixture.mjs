import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// These fixtures have one initial demand per task in a fresh owner lifetime. A
// running diagnostics row is published only after that entry's Worker started ACK.
export function initialTaskClaimStarted({ status, owner, task, initialDemand, durableDemand, mark, ownerState }) {
  return !!owner && ownerState === 'alive' && status.running
    && status.process?.pid === owner.pid && status.process.birth === owner.birth && mark?.pid === owner.pid
    && initialDemand?.required === true && durableDemand?.required === true
    && typeof initialDemand.demand === 'string' && durableDemand.demand === initialDemand.demand
    && status.warden?.tasks.some(row => row.task === task && row.pid === owner.pid && row.state === 'running');
}

export async function taskServiceFixture({ workspace, home, task, socketDirectory, env = process.env, mechanismRoot = packageRoot }) {
  const [{ createStandaloneHost }, client] = await Promise.all([
    import(path.join(mechanismRoot, 'dist/host-index.js')),
    import(path.join(mechanismRoot, 'lib/service-client.js')),
  ]);
  const version = JSON.parse(readFileSync(path.join(mechanismRoot, 'package.json'), 'utf8')).version;
  const host = createStandaloneHost({ cwd: workspace, binPath: path.join(mechanismRoot, 'bin/promptobus.js'), version });
  const ownedEnv = { ...env, PROMPTOBUS_HOME: home,
    PROMPTOBUS_SERVICE_HOME: path.join(realpathSync(socketDirectory), 'service') };
  const options = { cwd: workspace, env: ownedEnv };
  return {
    env: ownedEnv,
    status() { return client.workspaceServiceStatus(host, options); },
    async demand() {
      const { servicePaths } = await import(path.join(mechanismRoot, 'lib/service-state.js'));
      const file = path.join(servicePaths(host, ownedEnv).directory, 'warden-demand.json');
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).tasks[task] ?? null : null;
    },
    async close() {
      const status = await client.workspaceServiceStatus(host, options);
      if (!status.running) return { stopped: false, process: null };
      await client.abortTaskWarden(host, task, options);
      await client.stopWorkspaceService(host, options);
      return { stopped: true, process: status.process };
    },
  };
}

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
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
  const host = createStandaloneHost({ cwd: workspace, binPath: realpathSync(path.join(mechanismRoot, 'bin/promptobus.js')), version });
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
      const [{ readPrivate, servicePaths }, { canonicalPath }] = await Promise.all([
        import(path.join(mechanismRoot, 'lib/service-state.js')), import(path.join(mechanismRoot, 'lib/store.js')),
      ]);
      const paths = servicePaths(host, ownedEnv);
      for (const name of readdirSync(paths.clients)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error('Owned task cleanup found an invalid credential filename');
        const grant = readPrivate(path.join(paths.clients, name));
        if (!grant) continue;
        if (`${grant.id}.json` !== name) throw new Error('Owned task cleanup credential identity changed');
        if (grant.runtime !== status.runtime || !grant.env?.PROMPTOBUS_HOME
          || canonicalPath(grant.env.PROMPTOBUS_HOME) !== paths.home
          || grant.lifetime?.kind !== 'managed' || grant.lifetime.task !== task) continue;
        await client.revokeServiceClient(host, grant.id, options);
      }
      const deadline = Date.now() + 5000;
      let beforeStop = await client.workspaceServiceStatus(host, options);
      while (beforeStop.running && beforeStop.clients === 0 && beforeStop.warden.observations > 0) {
        if (Date.now() >= deadline) throw new Error(`Owned task observations did not settle: ${JSON.stringify(beforeStop)}`);
        await new Promise(resolve => setTimeout(resolve, 25));
        beforeStop = await client.workspaceServiceStatus(host, options);
      }
      try { await client.stopWorkspaceService(host, options); }
      catch (error) { throw new Error(`${error.message}; owned task cleanup status: ${JSON.stringify(beforeStop)}`, { cause: error }); }
      return { stopped: true, process: status.process };
    },
  };
}

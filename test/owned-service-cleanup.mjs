import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createStandaloneHost } from '../dist/host-index.js';
import { serviceControl, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { readPrivate, servicePaths } from '../lib/service-state.js';

const base = process.argv[2];
if (!base || !path.isAbsolute(base)) throw new Error('Fixture cleanup requires its absolute private service directory');
for (const name of readdirSync(base)) {
  if (!/^[a-f0-9]{64}$/.test(name)) continue;
  const directory = path.join(base, name);
  const discovery = readPrivate(path.join(directory, 'service.json'));
  if (!discovery) continue;
  const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: base };
  const host = createStandaloneHost({ cwd: discovery.root, home: discovery.home,
    binPath: path.resolve('bin/promptobus.js'), version: discovery.version });
  const paths = servicePaths(host, env);
  if (paths.directory !== directory) throw new Error('Fixture cleanup service identity changed');
  const status = await workspaceServiceStatus(host, { env });
  if (!status.running) continue;
  for (const client of readdirSync(paths.clients)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(client)) throw new Error('Fixture cleanup found an invalid credential filename');
    await serviceControl(paths, { operation: 'revoke', runtime: discovery.runtime, clientId: path.basename(client, '.json') });
  }
  for (const task of status.warden.tasks) await serviceControl(paths, { operation: 'warden-abort', runtime: discovery.runtime, task: task.task, pollEnv: env });
  let beforeStop = await workspaceServiceStatus(host, { env });
  const started = Date.now();
  try {
    while (beforeStop.running && beforeStop.warden.observations > 0) {
      if (Date.now() - started >= 5000) throw new Error('Owned fixture observations did not settle before shutdown');
      await new Promise(resolve => setTimeout(resolve, 10));
      beforeStop = await workspaceServiceStatus(host, { env });
    }
    await stopWorkspaceService(host, { env });
  }
  catch (error) {
    const args = ['-p', String(status.process.pid), '-o', 'pid=', '-o', 'ppid=', '-o', 'stat=', '-o', 'lstart=', '-o', 'command='];
    const observed = spawnSync('ps', args, { encoding: 'utf8', timeout: 2000 });
    process.stderr.write(`${JSON.stringify({ phase: 'fixture-owner-stop-timeout', at: new Date().toISOString(),
      elapsedMs: Date.now() - started, directory, root: discovery.root, process: status.process,
      beforeStop, error: error.message, ps: { args, exitCode: observed.status, signal: observed.signal,
        error: observed.error?.message, stdout: observed.stdout, stderr: observed.stderr } })}\n`);
    throw error;
  }
}

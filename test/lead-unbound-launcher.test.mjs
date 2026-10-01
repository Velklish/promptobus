import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, THREAD_DELAY_VAR } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { taskExists } from '../lib/store.js';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { holderLogFile, pidAlive, registrySessions, sessionFile } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-lead-unbound-');
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}');
const env = { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, PROMPTOBUS_WARDEN: 'off' };
const host = hostOf(root);
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Original root\nKeep its holder isolated.\n');
const cli = path.resolve('bin/promptobus.js');
for (const [index, title] of ['Original root', 'Different root'].entries()) {
  const task = `lead-unbound-t20261001-00000${index + 1}`;
  const args = ['lead', '--brief', brief, '--task', task];
  const launcher = spawn(process.execPath, [cli, ...args], {
    cwd: root, env: { ...env, [THREAD_DELAY_VAR]: '3000' }, stdio: 'ignore',
  });
  const completion = new Promise(resolve => launcher.once('exit', resolve));
  const retained = await waitFor(() => {
    const record = registrySessions(env).find(record => record.task === task && pidAlive(record.holderPid));
    if (!record || !existsSync(holderLogFile(record.ref, env))) return null;
    const appPid = Number(readFileSync(holderLogFile(record.ref, env), 'utf8').match(/app-server pid (\d+)/)?.[1]);
    return pidAlive(appPid) ? { ...record, appPid } : null;
  }, { timeoutMs: 10000 });
  const privateHome = participantCodexHome({ task, address: 'orchestrator' }, env);
  check(`${title}: detached holder exists before task birth`, retained && !taskExists(host.promptobusHome(), task));
  launcher.kill('SIGKILL');
  await completion;
  const before = readFileSync(sessionFile(retained.ref, env), 'utf8');
  const auth = readFileSync(path.join(privateHome, 'auth.json'), 'utf8');
  const retry = spawnSync(process.execPath, [cli, ...args, '--title', title], {
    cwd: root, env, encoding: 'utf8', timeout: 20000,
  });
  const after = JSON.parse(readFileSync(sessionFile(retained.ref, env), 'utf8'));
  const original = JSON.parse(before);
  check(`${title}: dead launcher lease cannot replace its live unbound holder`,
    retry.status === 1 && /live unbound Codex root/.test(retry.stdout + retry.stderr)
    && ['ref', 'launchId', 'launcherPid', 'holderPid', 'codexHome', 'prompt', 'startedAt'].every(key => after[key] === original[key])
    && readFileSync(path.join(privateHome, 'auth.json'), 'utf8') === auth
    && pidAlive(retained.holderPid) && pidAlive(retained.appPid)
    && registrySessions(env).filter(record => record.task === task).length === 1,
    `${retry.status} ${retry.stdout}${retry.stderr}`);
  process.kill(retained.appPid, 'SIGKILL');
  process.kill(retained.holderPid, 'SIGKILL');
  await waitFor(() => !pidAlive(retained.appPid) && !pidAlive(retained.holderPid), { timeoutMs: 10000 });
  const replacement = spawnSync(process.execPath, [cli, ...args, '--title', title], {
    cwd: root, env, encoding: 'utf8', timeout: 30000,
  });
  check(`${title}: a dead unbound record is removed before a new root reuses its private home`,
    replacement.status === 0 && taskExists(host.promptobusHome(), task) && existsSync(privateHome)
    && registrySessions(env).filter(record => record.task === task).length === 1,
    `${replacement.status} ${replacement.stdout}${replacement.stderr}`);
  const current = registrySessions(env).find(record => record.task === task);
  await codexDriver.stop(current.ref);
}
harness.restore();

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, THREAD_DELAY_VAR } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { taskExists } from '../lib/store.js';
import { codexDriver } from '../lib/driver-codex.js';
import { holderAlive, holderLogFile, pidAlive, readSession, registrySessions, sessionFile, writeSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-lead-startup-');
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}');
const env = { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, PROMPTOBUS_WARDEN: 'off' };
const host = hostOf(root), cli = path.resolve('bin/promptobus.js');
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Startup root\nPreserve its only native holder.\n');
const child = path.join(root, 'fork-exit.mjs');
writeFileSync(child, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawn;
cp.spawn = (...args) => {
  const result = original(...args);
  if (args[1]?.[0]?.endsWith('/codex-hold.js')) process.exit(0);
  return result;
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(cli).href)});
`);
for (const [index, title] of ['Startup root', 'Different startup root'].entries()) {
  const task = `lead-startup-t20261001-00000${index + 1}`;
  const args = ['lead', '--brief', brief, '--task', task];
  const launched = spawnSync(process.execPath, [child, ...args], {
    cwd: root, env: { ...env, [THREAD_DELAY_VAR]: '3000' }, encoding: 'utf8', timeout: 15000,
  });
  const retained = await waitFor(() => {
    const record = registrySessions(env).find(value => value.task === task);
    if (!record || !existsSync(holderLogFile(record.ref, env))) return null;
    const log = readFileSync(holderLogFile(record.ref, env), 'utf8');
    const appPid = Number(log.match(/app-server pid (\d+)/)?.[1]);
    return pidAlive(appPid) ? { record, appPid } : null;
  }, { timeoutMs: 10000 });
  const before = retained.record;
  check(`${title}: launcher exits after fork before either holder PID is published`,
    launched.status === 0 && before.holderPid === null && before.appPid === null
    && !taskExists(host.promptobusHome(), task) && holderAlive(before.ref, env));
  const retry = spawnSync(process.execPath, [cli, ...args, '--title', title], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  const after = readSession(before.ref, env);
  check(`${title}: live holder lock prevents retry from adopting or replacing an unpublished launch`,
    retry.status === 1 && /live unbound Codex root/.test(retry.stdout + retry.stderr)
    && after?.launchId === before.launchId && after?.prompt === before.prompt
    && registrySessions(env).filter(value => value.task === task).length === 1,
    `${retry.status} ${retry.stdout}${retry.stderr}`);
  await codexDriver.stop(before.ref);
}
const ref = 'delayed-old-holder';
const replacement = { ref, launchId: 'replacement-nonce', state: 'starting', prompt: 'Replacement scope',
  bin: '/fixture/must-not-start', cwd: root, codexHome: path.join(root, 'replacement-private') };
writeSession(replacement, env);
const file = sessionFile(ref, env);
const originalBytes = readFileSync(file, 'utf8');
const old = spawnSync(process.execPath, [path.resolve('lib/codex-hold.js'), file, 'original-nonce'], {
  cwd: root, env, encoding: 'utf8', timeout: 10000,
});
check('a delayed holder carries immutable launch ownership and refuses another launch record',
  old.status === 3 && /launch ownership changed/.test(old.stderr)
  && readFileSync(file, 'utf8') === originalBytes
  && !existsSync(holderLogFile(ref, env)), `${old.status} ${old.stderr}`);
harness.restore();

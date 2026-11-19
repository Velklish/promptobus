import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { scheduled, receipt } from './fixture-order.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, THREAD_DELAY_VAR } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { codexDriver } from '../lib/driver-codex.js';
import { dropSession, pidAlive, registrySessions, sessionFile, sessionKey, sessionsDir, writeSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-lead-startup-');
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}');
const env = { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, PROMPTOBUS_WARDEN: 'off' };
const cli = path.resolve('bin/promptobus.js');
for (const [index, title] of ['Original cleanup scope', 'Different cleanup scope'].entries()) {
  const task = `lead-cleanup-t20261001-00000${index + 1}`;
  const brief = path.join(root, `brief-${index}.md`);
  writeFileSync(brief, '# Original cleanup scope\nPreserve exactly one native owner.\n');
  const release = path.join(root, `release-${index}`), nativeStarted = path.join(root, `native-${index}`);
  const pidFile = path.join(root, `pid-${index}`);
  const oldAppFile = path.join(root, `old-app-${index}`);
  const attempt = path.join(root, `transition-attempt-${index}`);
  const poised = path.join(root, `before-transition-${index}`);
  const resumed = path.join(root, `cleanup-resumed-${index}`);
  const target = path.join(root, `transition-path-${index}`);
  const ordered = scheduled('late-contender') || scheduled('contended');
  const schedule = JSON.stringify({ attempt, poised, resumed, target, late: scheduled('late-contender') });
  const helpers = JSON.stringify(new URL('./fixture-transition-order.mjs', import.meta.url).href);
  const delayed = path.join(root, `delayed-${index}.mjs`);
  writeFileSync(delayed, `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const deadline = Date.now() + 15000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (Date.now() >= deadline) throw new Error('old holder never released');
  await new Promise(resolve => setTimeout(resolve, 5));
}
${ordered ? `(await import(${helpers})).instrumentContender(${schedule});` : ''}
const original = cp.spawn;
cp.spawn = (...args) => {
  fs.writeFileSync(${JSON.stringify(nativeStarted)}, String(process.pid));
  const child = original(...args);
  ${ordered ? `if (child.pid) fs.writeFileSync(${JSON.stringify(oldAppFile)}, String(child.pid));` : ''}
  return child;
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(path.resolve('lib/codex-hold.js')).href)});
`);
  const launcher = path.join(root, `launcher-${index}.mjs`);
  writeFileSync(launcher, `
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawn;
cp.spawn = (...args) => {
  if (args[1]?.[0]?.endsWith('/codex-hold.js')) {
    const child = original(args[0], [${JSON.stringify(delayed)}, ...args[1].slice(1)], args[2]);
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.exit(0);
  }
  return original(...args);
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(cli).href)});
`);
  const args = ['lead', '--permission-mode', 'full-access', '--brief', brief, '--task', task];
  let current;
  try {
  const launched = spawnSync(process.execPath, [launcher, ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  await waitFor(() => existsSync(pidFile), { timeoutMs: 10000 });
  const original = registrySessions(env).find(record => record.task === task);
  check(`${title}: old detached holder is paused before lock acquisition`, launched.status === 0
    && original?.holderPid === null && !existsSync(nativeStarted));
  const lock = path.join(sessionsDir(env), `${sessionKey(original.ref)}.lock`);
  if (ordered) writeFileSync(target, path.join(sessionsDir(env), `${sessionKey(original.ref)}.transition`));
  const retryScript = path.join(root, `retry-${index}.mjs`);
  writeFileSync(retryScript, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFileSync;
${ordered ? `const { awaitContender, recordObservation } = await import(${helpers});` : ''}
let released = false;
fs.readFileSync = (...args) => {
  try { return original(...args); }
  catch (error) {
    if (!released && String(args[0]) === ${JSON.stringify(lock)} && error.code === 'ENOENT') {
      released = true;
      fs.writeFileSync(${JSON.stringify(release)}, 'start old holder after liveness read');
      ${ordered ? `awaitContender(${schedule});` : ''}
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && !fs.existsSync(${JSON.stringify(nativeStarted)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      ${ordered ? `recordObservation(${schedule}, ${JSON.stringify(nativeStarted)});` : ''}
    }
    throw error;
  }
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(cli).href)});
`);
  const retried = spawnSync(process.execPath, [retryScript, ...args, '--title', title], {
    cwd: root, env: { ...env, [THREAD_DELAY_VAR]: '500' }, encoding: 'utf8', timeout: 30000,
  });
  current = registrySessions(env).find(record => record.task === task);
  const keys = { original: sessionKey(original.ref), retry: current && sessionKey(current.ref), oldRef: original.ref, retryRef: current?.ref };
  check(`${title}: retry uses the intended session and transition keys`, !!current && current.task === original.task
    && current.address === original.address && (original.ref === current.ref) === (index === 0)
    && (keys.original === keys.retry) === (index === 0), JSON.stringify(keys));
  if (ordered) {
    const snapshot = existsSync(resumed) && JSON.parse(readFileSync(resumed, 'utf8'));
    const tried = await waitFor(() => existsSync(attempt), { timeoutMs: 4000 });
    receipt('cleanup observation', { title, keys, snapshot, firstAttempt: tried && readFileSync(attempt, 'utf8') });
    check(`${title}: prescribed contender order occurred`, snapshot && tried && !snapshot.native
      && snapshot.attempt === (scheduled('contended') ? 'EEXIST' : null), JSON.stringify(snapshot));
  }
  check(`${title}: stale cleanup and holder acquisition cannot both win`, !existsSync(nativeStarted),
    `${retried.status} ${retried.stdout}${retried.stderr}`);
  check(`${title}: retry retains only its own native launch`, retried.status === 0
    && current?.launchId !== original.launchId && current?.threadId && pidAlive(current.holderPid),
    `${retried.status} ${retried.stdout}${retried.stderr}`);
  } finally {
  current ??= registrySessions(env).find(record => record.task === task);
  const oldPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null;
  const oldApp = ordered && existsSync(oldAppFile) ? Number(readFileSync(oldAppFile, 'utf8')) : null;
  const pids = [oldPid, oldApp, current?.holderPid, current?.appPid];
  try { if (current?.holderPid) await codexDriver.stop(current.ref, { timeoutMs: 3000 }); } finally {
    for (const pid of pids) {
      if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    const gone = await waitFor(() => pids.every(pid => !pidAlive(pid)), { timeoutMs: 4000 });
    if (ordered) receipt('owned cleanup processes exited', { title, pids, gone });
    check(`${title}: fixture holders exited`, gone);
  }
  }
}
const callbackTask = 'lead-cleanup-t20261001-000003';
const callbackBrief = path.join(root, 'callback.md');
writeFileSync(callbackBrief, '# Callback ownership\nKeep replacement records and sidecars unchanged.\n');
const callbackLaunch = spawnSync(process.execPath, [cli, 'lead', '--permission-mode', 'full-access', '--brief', callbackBrief, '--task', callbackTask], {
  cwd: root, env, encoding: 'utf8', timeout: 15000,
});
const callbackRecord = registrySessions(env).find(record => record.task === callbackTask);
check('callback fixture starts a real detached native holder', callbackLaunch.status === 0 && pidAlive(callbackRecord?.appPid));
const deadSibling = { ...callbackRecord, ref: '000-dead-sibling', launchId: 'dead-sibling', holderPid: null, appPid: null };
writeSession(deadSibling, env);
const deadBytes = readFileSync(sessionFile(deadSibling.ref, env), 'utf8');
const liveAuth = readFileSync(path.join(callbackRecord.codexHome, 'auth.json'), 'utf8');
let mixedRefusal = '';
try { codexDriver.prepareRootLaunch({ home: callbackRecord.home, task: callbackTask, env }); }
catch (error) { mixedRefusal = error.message; }
check('a live retained root prevents cleanup of dead siblings sharing its private home',
  /live unbound Codex root/.test(mixedRefusal)
  && existsSync(sessionFile(deadSibling.ref, env))
  && readFileSync(sessionFile(deadSibling.ref, env), 'utf8') === deadBytes
  && existsSync(path.join(callbackRecord.codexHome, 'auth.json'))
  && readFileSync(path.join(callbackRecord.codexHome, 'auth.json'), 'utf8') === liveAuth);
rmSync(sessionFile(deadSibling.ref, env));
const replacement = { ...callbackRecord, launchId: 'replacement-callback-owner', scopeMarker: 'do not rewrite' };
writeSession(replacement, env);
const replacementBytes = readFileSync(sessionFile(replacement.ref, env), 'utf8');
const callbackLock = path.join(sessionsDir(env), `${sessionKey(replacement.ref)}.lock`);
const lockBytes = JSON.stringify({ pid: process.pid, at: 'replacement-lock' });
writeFileSync(callbackLock, lockBytes);
rmSync(replacement.rpcSocket, { force: true });
writeFileSync(replacement.rpcSocket, 'replacement-socket');
process.kill(callbackRecord.appPid, 'SIGKILL');
await waitFor(() => !pidAlive(callbackRecord.holderPid), { timeoutMs: 10000 });
check('delayed native exit cannot patch a replacement launch record',
  readFileSync(sessionFile(replacement.ref, env), 'utf8') === replacementBytes);
check('delayed holder cleanup cannot remove another process holder lock',
  existsSync(callbackLock) && readFileSync(callbackLock, 'utf8') === lockBytes);
check('delayed holder cleanup cannot remove a replacement socket',
  existsSync(replacement.rpcSocket) && readFileSync(replacement.rpcSocket, 'utf8') === 'replacement-socket');
dropSession(replacement.ref, env);
harness.restore();

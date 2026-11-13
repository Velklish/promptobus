import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { bus, participantRecord, taskExists } from '../lib/store.js';
import { codexDriver } from '../lib/driver-codex.js';
import { readStopConfirmation } from '../lib/codex-command-receipts.js';
import { holderAlive, holderLogFile, pidAlive, readSession, registrySessions, sessionFile, writeSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-lead-startup-');
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}');
const env = { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, PROMPTOBUS_WARDEN: 'off' };
const host = hostOf(root), cli = path.resolve('bin/promptobus.js');
const readyForStop = (record, launchId) => record?.launchId === launchId
  && record.state === 'binding' && record.rpcSocket
  && record.threadId && record.holderPid && record.appPid ? record : null;
const cleanupConfirmed = (stopped, record) => stopped.ok === true && stopped.stopped === true
  && !holderAlive(record.ref, env) && !pidAlive(record.appPid)
  && readStopConfirmation(record.commandReceiptFile, record).ok;
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Startup root\nPreserve its only native holder.\n');
const preload = path.join(root, 'hold-listen.cjs');
writeFileSync(preload, `
const { readFileSync, writeFileSync, renameSync, existsSync, watch } = require('node:fs');
const path = require('node:path');
const { Server } = require('node:net');
const file = process.argv[2], launchId = process.argv[3];
if (process.argv[1] !== ${JSON.stringify(path.resolve('lib/codex-hold.js'))}
  || path.dirname(file) !== ${JSON.stringify(path.join(realpathSync(harness.stateHome), 'sessions'))}
  || JSON.parse(readFileSync(file, 'utf8')).launchId !== launchId) throw new Error('unowned holder barrier');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const spawn = cp.spawn;
cp.spawn = (...args) => {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const child = spawn(...args);
  if (args[0] === record.bin && args[1]?.includes('app-server')) {
    const release = path.join(${JSON.stringify(root)}, record.task + '.fork-release');
    const marker = path.join(${JSON.stringify(root)}, record.task + '.forked');
    writeFileSync(marker + '.tmp', JSON.stringify({ ref: record.ref, launchId, appPid: child.pid }));
    renameSync(marker + '.tmp', marker);
    const until = Date.now() + 10000, pause = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(release)) {
      if (Date.now() >= until) throw new Error('owned app fork barrier was not released');
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  return child;
};
syncBuiltinESMExports();
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (args[0] !== record.rpcSocket || record.launchId !== launchId) throw new Error('holder barrier ownership changed');
  const release = path.join(${JSON.stringify(root)}, record.task + '.release');
  let watcher, released = false;
  const cleanup = () => { watcher?.close(); clearTimeout(timer); process.off('exit', cleanup); };
  const resume = () => {
    if (released || !existsSync(release)) return;
    released = true;
    try { listen.apply(this, args); } finally { cleanup(); }
  };
  const timer = setTimeout(() => {
    resume();
    if (released) return;
    try { this.emit('error', new Error('owned listener barrier was not released')); } finally { cleanup(); }
  }, 10000);
  process.once('exit', cleanup);
  try {
    watcher = watch(${JSON.stringify(root)}, resume);
    watcher.on('error', error => { try { this.emit('error', error); } finally { cleanup(); } });
    const marker = path.join(${JSON.stringify(root)}, record.task + '.listening');
    writeFileSync(marker + '.tmp', JSON.stringify(record));
    renameSync(marker + '.tmp', marker);
    resume();
  } catch (error) { cleanup(); throw error; }
  return this;
};
`);
const child = path.join(root, 'fork-exit.mjs');
writeFileSync(child, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawn;
cp.spawn = (...args) => {
  const holder = args[1]?.[0]?.endsWith('/codex-hold.js');
  if (holder) args[1] = ['--require', ${JSON.stringify(preload)}, ...args[1]];
  const result = original(...args);
  if (holder) process.exit(0);
  return result;
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(cli).href)});
`);
const controlled = path.join(root, 'delayed-watch.cjs');
writeFileSync(controlled, `
const fs = require('node:fs');
const { Server } = require('node:net');
const file = process.argv[2], present = process.argv[3] === 'present';
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
const release = ${JSON.stringify(root)} + '/' + record.task + '.release';
const events = [], held = [];
const note = event => events.push({ event, ns: process.hrtime.bigint().toString(), release: fs.existsSync(release) });
const watch = fs.watch, rename = fs.renameSync, listen = Server.prototype.listen, timeout = setTimeout;
fs.watch = (dir, callback) => {
  if (dir !== ${JSON.stringify(root)}) throw new Error('unowned watch control');
  const watcher = watch(dir, () => note('watch-notified'));
  note('watch-held');
  held.push(callback);
  const close = watcher.close;
  watcher.close = function () { note('watch-closed'); return close.call(this); };
  return watcher;
};
fs.renameSync = (...args) => { rename(...args); if (args[1].endsWith('.listening')) note('marker'); };
Server.prototype.listen = function (...args) { note('actual-listen'); return listen.apply(this, args); };
global.setTimeout = (callback, ms) => {
  if (ms !== 10000) throw new Error('unexpected owned listener deadline');
  note('timer-armed');
  return timeout(() => {
    note('timer');
    try { callback(); } finally {
      for (const deliver of held) { note('watch-delivered'); deliver(); }
    }
  }, ms);
};
process.argv = [process.execPath, ${JSON.stringify(path.resolve('lib/codex-hold.js'))}, file, record.launchId];
require(${JSON.stringify(preload)});
const server = new Server();
server.on('error', error => { note('error:' + error.message); if (server.listening) server.close(); });
server.on('listening', () => { note('listening'); server.close(() => note('server-closed')); });
note('listen');
server.listen(record.rpcSocket, '127.0.0.1');
note('listen-return');
if (present) { fs.writeFileSync(release, 'release\\n'); note('release'); }
process.once('beforeExit', () => console.log(JSON.stringify(events)));
`);
for (const present of [true, false]) {
  const record = { ref: 'controlled-listener-' + present, launchId: 'owned-listener-' + present,
    task: 'controlled-listener-' + present, rpcSocket: 0 };
  const file = sessionFile(record.ref, env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
  let result;
  try {
    result = spawnSync(process.execPath, [controlled, file, present ? 'present' : 'absent'], {
      cwd: root, env, encoding: 'utf8', timeout: 15000,
    });
  } finally { rmSync(file, { force: true }); }
  const events = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : [];
  console.log('controlled owned listener schedule: ' + JSON.stringify({ present, status: result.status, events }));
  const at = name => events.findIndex(value => value.event === name);
  const ordered = names => names.every((name, i) => at(name) >= 0 && (i === 0 || at(names[i - 1]) < at(name)));
  check('controlled listener holds watch delivery through the unchanged timer: release ' + present,
    result.status === 0 && ordered(['listen', 'timer-armed', 'watch-held', 'marker', 'listen-return', 'timer', 'watch-delivered'])
    && (!present || ordered(['listen-return', 'release', 'timer']))
    && events[at('listen-return')]?.release === false && events[at('timer')]?.release === present,
    result.stderr + JSON.stringify(events));
  check(present ? 'owned listener timer consumes a durable release while its watch callback is held'
    : 'owned listener timer refuses an absent release while its watch callback is held',
    present ? ordered(['timer', 'actual-listen', 'listening', 'server-closed'])
      && !events.some(value => value.event.startsWith('error:'))
      : at('error:owned listener barrier was not released') > at('timer') && at('actual-listen') === -1,
    JSON.stringify(events));
  check('controlled listener closes its owned watcher at the timer: release ' + present,
    ordered(['timer', 'watch-closed', 'watch-delivered'])
    && events.filter(value => value.event === 'watch-closed').length === 1, JSON.stringify(events));
}
for (const [index, title] of ['Startup root', 'Different startup root', 'Unbound startup root'].entries()) {
  const task = `lead-startup-t20261001-00000${index + 1}`;
  const args = ['lead', '--permission-mode', 'full-access', '--brief', brief, '--task', task];
  const launched = spawnSync(process.execPath, [child, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 15000,
  });
  const retained = await waitFor(() => {
    const marker = path.join(root, task + '.forked');
    if (!existsSync(marker)) return null;
    const fork = JSON.parse(readFileSync(marker, 'utf8'));
    const record = readSession(fork.ref, env);
    return record?.launchId === fork.launchId && pidAlive(fork.appPid) ? { record, appPid: fork.appPid } : null;
  }, { timeoutMs: 10000 });
  if (!retained) {
    check(`${title}: owned holder reaches its app-server startup barrier`, false,
      `${launched.status} ${launched.stdout}${launched.stderr}`);
    break;
  }
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
  writeFileSync(path.join(root, task + '.fork-release'), 'release\n');
  const published = await waitFor(() => {
    const file = path.join(root, task + '.listening');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }, { timeoutMs: 10000 });
  if (!published) throw new Error(`${title}: holder did not reach its owned listener barrier`);
  check(`${title}: owned publication precedes listener readiness despite complete PID and thread fields`,
    published.launchId === before.launchId && published.threadId && published.holderPid && published.appPid
    && published.state === 'starting' && !existsSync(published.rpcSocket), JSON.stringify(published));
  if (index < 2) bus(host.promptobusHome(), { cli: host.version }).createTask({ id: task, title,
    owner: participantRecord('orchestrator', { harness: 'codex', mode: 'managed', owner: published.threadId,
      sessionRef: published.ref, sessionId: published.threadId, nativeLaunchId: published.launchId }),
  });
  let stopCalls = 0;
  const cleanup = (async () => {
    const bound = await waitFor(() => readyForStop(readSession(before.ref, env), before.launchId), { timeoutMs: 10000 });
    if (!bound) throw new Error(`${title}: owned listener readiness was not published: ${JSON.stringify(readSession(before.ref, env))}`);
    stopCalls += 1;
    return { bound, stopped: await codexDriver.stop(before.ref) };
  })();
  await new Promise(setImmediate);
  check(`${title}: cleanup cannot call Stop before the owned listener barrier is released`, stopCalls === 0);
  writeFileSync(path.join(root, task + '.release'), 'release\n');
  const { bound, stopped } = await cleanup;
  if (index < 2) {
    check(`${title}: fixture cleanup waits for published ownership before Stop and directory removal`,
      stopCalls === 1 && cleanupConfirmed(stopped, bound), JSON.stringify(stopped));
  } else {
    const file = sessionFile(bound.ref, env), auth = path.join(bound.codexHome, 'auth.json');
    const recordBytes = readFileSync(file, 'utf8'), authBytes = readFileSync(auth, 'utf8');
    const receiptBytes = readFileSync(bound.commandReceiptFile, 'utf8');
    await new Promise(setImmediate);
    check('a missing task keeps Stop unresolved and retains record, home and receipts despite confirmed physical exit',
      stopCalls === 1 && stopped.ok === false && stopped.stopped === false && stopped.attempted === true
      && /record retirement unresolved: task .* is not in/.test(stopped.note) && !cleanupConfirmed(stopped, bound)
      && !holderAlive(bound.ref, env) && !pidAlive(bound.appPid) && !taskExists(host.promptobusHome(), task)
      && readStopConfirmation(bound.commandReceiptFile, bound).ok
      && readSession(bound.ref, env)?.launchId === bound.launchId && existsSync(bound.codexHome)
      && readFileSync(file, 'utf8') === recordBytes && readFileSync(auth, 'utf8') === authBytes
      && readFileSync(bound.commandReceiptFile, 'utf8') === receiptBytes, JSON.stringify(stopped));
  }
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

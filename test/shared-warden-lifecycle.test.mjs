import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { makeSandbox } from './sandbox.mjs';
import { REGISTRY } from '../lib/drivers.js';
import { runTaskWarden } from '../lib/warden.js';
import { createTask, participantRecord, sendMessage, upsertParticipant, wardenMarkFile, writeJsonAtomic, writeWake } from '../lib/store.js';
import { readWardenMark } from '../dist/sidecar.js';

const ROOT = makeSandbox('promptobus-shared-warden-');
const HOME = path.join(ROOT, '.promptobus');
const tasks = ['one-t20261030-010000', 'two-t20261030-010000', 'pending-t20261030-010000', 'legacy-t20261030-010000'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('owned warden fixture condition did not occur'); await wait(5); }
};
const host = { version: '0.31.0', formatStalls: () => [] };
const controllers = tasks.map(() => new AbortController());
const loops = [];
const wakes = [];
let pendingRelease, active = 0, peak = 0, legacy = null;
const pendingActivation = new Promise(resolve => { pendingRelease = resolve; });
const registry = { ...REGISTRY, drivers: { ...REGISTRY.drivers, claude: { ...REGISTRY.drivers.claude,
  inspect: ref => ({ state: 'alive', busy: false, stall: null, id: ref, note: null }),
  activate: async (_target, notification) => {
    wakes.push(notification.task);
    if (notification.task === tasks[2]) {
      active += 1; peak = Math.max(peak, active);
      await pendingActivation;
      active -= 1;
    }
    return { ok: true };
  },
} } };
const start = index => {
  const loop = runTaskWarden({ home: HOME, task: tasks[index], host, session: null, signal: controllers[index].signal, registry });
  loops.push(loop);
  return loop;
};
const watcherCount = () => process.getActiveResourcesInfo().filter(kind => kind === 'FSEventWrap').length;
const baselineWatchers = watcherCount();
try {
  for (const task of tasks) {
    createTask(HOME, { id: task, title: 'owned task loop', owner: 'root-session' });
    upsertParticipant(HOME, task, participantRecord('worker:fixture', { harness: 'claude', sessionRef: 'fixture-ref', sessionId: 'fixture-ref' }));
    writeWake(HOME, task, 'worker:fixture', { socket: '/owned-fixture-socket', token: 'fixture', session: 'fixture-ref' });
  }
  const first = start(0), second = start(1);
  check('two task loops own separate journal seats under one physical PID', tasks.slice(0, 2).every(task => readWardenMark(HOME, task)?.pid === process.pid)
    && wardenMarkFile(HOME, tasks[0]) !== wardenMarkFile(HOME, tasks[1]));
  await new Promise(resolve => setImmediate(resolve));
  controllers[0].abort();
  const promptlyAborted = await Promise.race([first.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
  check('abort wakes an idle watcher without waiting for its poll timer', promptlyAborted && !existsSync(wardenMarkFile(HOME, tasks[0])));
  sendMessage(HOME, tasks[1], { from: 'orchestrator', to: 'worker:fixture', type: 'task', body: 'wake the remaining task' });
  await until(() => wakes.includes(tasks[1]));
  check('aborting one task leaves the other seat and its delivery working', readWardenMark(HOME, tasks[1])?.pid === process.pid
    && wakes.filter(task => task === tasks[0]).length === 0 && wakes.filter(task => task === tasks[1]).length === 1);
  controllers[1].abort(); await second;

  await until(() => watcherCount() === baselineWatchers);
  sendMessage(HOME, tasks[2], { from: 'orchestrator', to: 'worker:fixture', type: 'task', body: 'hold activation' });
  const pending = start(2);
  await until(() => active === 1);
  const activeWatchers = watcherCount();
  check(process.platform === 'darwin'
    ? 'Darwin creates no watcher handles while the owned task activation is held'
    : 'non-Darwin has watcher handles while the owned task activation is held',
  readWardenMark(HOME, tasks[2])?.pid === process.pid
    && (process.platform === 'darwin' ? activeWatchers === baselineWatchers : activeWatchers > baselineWatchers),
  JSON.stringify({ platform: process.platform, baselineWatchers, activeWatchers }));
  controllers[2].abort();
  let settled = false; pending.finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const contender = await runTaskWarden({ home: HOME, task: tasks[2], host, session: null, registry });
  check('abort retains the task seat until its actual activation settles and refuses an overlapping generation', !settled
    && readWardenMark(HOME, tasks[2])?.pid === process.pid && contender.kind === 'busy' && peak === 1);
  pendingRelease(); await pending;
  check('only settled activation permits task cleanup', active === 0 && !existsSync(wardenMarkFile(HOME, tasks[2])));

  legacy = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { legacy.once('error', reject); legacy.stdout.once('data', resolve); });
  if (!Number.isInteger(legacy.pid) || legacy.pid <= 1) throw new Error('owned legacy holder did not publish a valid PID');
  const stale = new Date(Date.now() - 600_000).toISOString();
  writeJsonAtomic(wardenMarkFile(HOME, tasks[3]), { pid: legacy.pid, beat: stale, started: stale });
  const before = readFileSync(wardenMarkFile(HOME, tasks[3]));
  const refused = await runTaskWarden({ home: HOME, task: tasks[3], host, session: null, registry });
  check('a physically live legacy warden is busy even with a stale heartbeat and its mark is preserved', refused.kind === 'busy'
    && refused.mark.pid === legacy.pid && readFileSync(wardenMarkFile(HOME, tasks[3])).equals(before));
  const legacyExit = new Promise(resolve => legacy.once('close', resolve)); legacy.stdin.end(); await legacyExit; legacy = null;
  const recovered = start(3); controllers[3].abort(); await recovered;
  check('only actual legacy process exit permits a new task loop to claim and clean its seat', !existsSync(wardenMarkFile(HOME, tasks[3])));
  await until(() => watcherCount() === baselineWatchers);
  check('all task watcher handles were released after cleanup', watcherCount() === baselineWatchers);
} finally {
  pendingRelease(); controllers.forEach(controller => controller.abort());
  await Promise.allSettled(loops);
  if (legacy && Number.isInteger(legacy.pid) && legacy.pid > 1) { const done = new Promise(resolve => legacy.once('close', resolve)); legacy.stdin.end(); await done; }
}

// The isolated model exercises production selection and wake wiring with stub OS calls.
const source = readFileSync(new URL('../lib/warden.js', import.meta.url), 'utf8');
const watchStart = source.indexOf('function watchInboxes(');
const watchEnd = source.indexOf('\n}', watchStart) + 2;
if (watchStart < 0 || watchEnd <= watchStart) throw new Error('Warden inbox watcher source boundary is missing');
const inbox = path.join(ROOT, 'model-inbox');
const opened = [];
let onChange, pollTimer, closeCalls = 0;
const watchInboxes = runInNewContext(source.slice(watchStart, watchEnd) + '\nwatchInboxes', {
  process: Object.freeze({ platform: 'linux' }),
  watchedDirs: () => [inbox],
  mkdirSync: () => {},
  watch: (dir, notify) => {
    opened.push(dir);
    onChange = notify;
    const watcher = new EventEmitter();
    watcher.close = () => { closeCalls += 1; watcher.emit('close'); };
    return watcher;
  },
  setTimeout: (_callback, ms) => { pollTimer = { ms }; return pollTimer; },
  clearTimeout: () => { pollTimer = null; },
});
const observer = watchInboxes(HOME, tasks[0], ['worker:fixture']);
let woke = false;
const next = observer.next(1000).then(() => { woke = true; });
const pollArmed = pollTimer?.ms === 1000;
onChange?.();
await new Promise(resolve => setImmediate(resolve));
const wokeWithoutPoll = woke && pollTimer === null;
await observer.close();
await next;
check('isolated non-Darwin watch branch opens the owned inbox and wakes before its poll', opened.length === 1
  && opened[0] === inbox && pollArmed && wokeWithoutPoll && closeCalls === 1,
JSON.stringify({ opened, pollArmed, wokeWithoutPoll, closeCalls }));

// Evaluate the built production control flow in memory; these failure barriers launch no native process.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';

const compiled = (name) => readFileSync(new URL(`../lib/${name}.js`, import.meta.url), 'utf8');
const loopSource = compiled('warden').slice(compiled('warden').indexOf('export async function runTaskWarden')).replace('export ', '');
const errorsOf = error => error instanceof AggregateError ? error.errors.flatMap(errorsOf) : [error];

for (const failure of ['none', 'watcher', 'note', 'mark', 'primary only', 'primary and cleanup', 'retained own mark', 'foreign mark']) {
  const actions = [], primary = new Error('original watch failure'), closeError = new Error('watcher close refused');
  const noteError = new Error('departure note refused'), markError = new Error('owned seat clear refused');
  let mark = null;
  const dependencies = {
    process, REGISTRY: {}, withTaskLock: (_home, _task, callback) => callback(), readWardenMark: () => mark,
    pidAlive: () => false, claimWarden: () => { mark = { pid: process.pid }; return { mark }; },
    warn: () => {}, ok: () => {}, info: () => {}, logWarden: (_home, _task, line) => {
      if (failure.startsWith('primary') && line.startsWith('watch round failed')) throw primary;
    },
    readTask: () => ({ participants: [] }), addressOf: () => null, snapshotSessions: () => ({}),
    coreRegistry: value => value, participantSlots: () => [], WARDEN_BEAT_SEC: 60, ROUND_FAIL_LIMIT: 1, TICK_MS: 1,
    supervisorRound: async () => {
      if (failure.startsWith('primary')) throw primary;
      if (failure === 'foreign mark') mark = { pid: process.pid + 100000 };
      return { stop: 'owned fixture complete' };
    },
    watchInboxes: () => ({ addrs: '', next: async () => {}, close: async () => {
      actions.push('watcher'); if (['watcher', 'primary and cleanup'].includes(failure)) throw closeError;
    } }),
    writeWardenExit: () => { actions.push('note'); if (['note', 'primary and cleanup'].includes(failure)) throw noteError; },
    clearWarden: () => {
      actions.push('clear'); if (['mark', 'primary and cleanup'].includes(failure)) throw markError;
      if (failure === 'retained own mark') return false;
      if (mark?.pid !== process.pid) return false;
      mark = null; return true;
    },
  };
  const loop = new Function(...Object.keys(dependencies), `${loopSource}; return runTaskWarden;`)(...Object.values(dependencies));
  let result, error;
  try { result = await loop({ home: '/fixture', task: 'owned-task', host: { version: 'fixture' }, session: null }); }
  catch (caught) { error = caught; }
  const expected = failure === 'primary and cleanup' ? [primary, closeError, noteError, markError] : failure === 'primary only' ? [primary]
    : failure === 'watcher' ? [closeError] : failure === 'note' ? [noteError] : failure === 'mark' ? [markError] : [];
  check(`warden cleanup: ${failure} attempts every cleanup stage and never certifies a retained own seat`,
    actions.join(',') === 'watcher,note,clear' && (failure === 'retained own mark'
      ? result === undefined && errorsOf(error).some(item => /retained its own warden seat/.test(item?.message ?? '')) : expected.length
      ? result === undefined && expected.every(item => errorsOf(error).includes(item))
      : error === undefined && result?.kind === 'stopped')
    && (failure === 'foreign mark' ? mark?.pid === process.pid + 100000
      : expected.includes(markError) || failure === 'retained own mark' ? mark?.pid === process.pid : mark === null),
    JSON.stringify({ actions, result, error: error?.message, errors: errorsOf(error).map(item => item?.message), mark }));
}

check('warden cleanup docs: failed cleanup retains demand and owner lock release requires actual Worker exit',
  readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8')
    .includes('An unconfirmed Worker exit retains the lock rather than claiming shutdown.')
  && readFileSync(new URL('../docs/guides/contributing.md', import.meta.url), 'utf8')
    .includes('it unresolved before the first cleanup await.'));

const coordinatorSource = compiled('service-warden').slice(compiled('service-warden').indexOf('export class ServiceWarden')).replace('export ', '');
for (const failure of ['loop failure', 'settlement persistence']) {
  let worker, saved, refuse = false, fatal = null, writes = 0, fatalities = 0;
  const actions = [];
  class FixtureWorker extends EventEmitter {
    constructor() { super(); worker = this; queueMicrotask(() => this.emit('message', { kind: 'ready' })); }
    postMessage(message) {
      actions.push(message.kind);
      if (message.kind === 'close') queueMicrotask(() => this.emit('exit', 0));
    }
  }
  const dependencies = {
    path, Worker: FixtureWorker, randomUUID: () => 'generation-one', requireTaskId: () => {},
    readPrivate: () => null, recordOf: value => !!value && typeof value === 'object',
    writePrivate: (_file, value) => {
      writes += 1; if (refuse) throw new Error('demand persistence refused');
      saved = JSON.parse(JSON.stringify(value));
    },
    taskWardenHost: () => ({ formatStalls: () => [] }), harnessHomeVar: name => name,
    readTask: () => ({ status: 'active' }), existsSync: () => true, taskDir: () => '/fixture/task',
  };
  const ServiceWarden = new Function(...Object.keys(dependencies),
    `${coordinatorSource.replace("new URL('./warden-worker.js', import.meta.url)", "'/fixture/warden-worker.js'")}; return ServiceWarden;`)(...Object.values(dependencies));
  const coordinator = new ServiceWarden({ directory: '/fixture/service', home: '/fixture/home' }, {},
    { pollEnvironment: {}, homes: {}, bins: {} }, {}, error => { fatal = error; fatalities += 1; });
  await coordinator.ready;
  coordinator.ensure('task-a');
  refuse = failure === 'settlement persistence';
  worker.emit('message', failure === 'loop failure'
    ? { kind: 'failed', task: 'task-a', generation: 'generation-one', error: 'owned loop cleanup refused' }
    : { kind: 'settled', task: 'task-a', generation: 'generation-one', result: { kind: 'stopped', reason: 'fixture done' } });
  check(`warden coordinator: ${failure} enters fatal once and retains the durable recovery demand`,
    fatal?.message === (refuse ? 'demand persistence refused' : 'owned loop cleanup refused')
    && fatalities === 1 && saved?.tasks?.['task-a']?.required === true, JSON.stringify({ fatal: fatal?.message, fatalities, saved, writes, actions }));
  let closed = false;
  const closing = coordinator.close().then(() => { closed = true; }, () => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  check(`warden coordinator: ${failure} sends Worker close and waits for its exit after failure`,
    closed && actions.filter(action => action === 'close').length === 1, JSON.stringify({ actions, closed }));
  // Unit-fixture insurance only: the old failure path never asks this fake Worker to exit.
  if (!closed) worker.emit('exit', 0);
  await closing;
}

for (const exited of [true, false]) {
  const source = compiled('service'), actions = [], primary = new Error('original owner failure'), closeError = new Error('Worker close failed');
  const cleanup = source.slice([...source.matchAll(/finally\s*\{/g)].at(-1).index, source.lastIndexOf('\n}'));
  const server = name => ({ listening: true, closeAllConnections: () => actions.push(`${name} force-close`),
    close: done => { actions.push(`${name} close`); done(); } });
  const context = { timer: null, lifecycle: { stop: () => actions.push('lifetime stop') },
    releaseWardenBinding: () => actions.push('unbind'), sharedWarden: { hasExited: () => exited,
      close: async () => { actions.push('Worker close'); throw closeError; } },
    pendingObservations: [], http: server('http'), ipc: server('ipc'), release: () => actions.push('release'),
    serviceFailed: true, serviceFailure: primary };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let error;
  try { await new AsyncFunction(...Object.keys(context), `try {} ${cleanup}`)(...Object.values(context)); }
  catch (caught) { error = caught; }
  check(`warden owner finally: rejected close with Worker exit ${exited} attempts listener cleanup and releases lock only on proof`,
    actions.includes('http close') && actions.includes('ipc close') && actions.includes('release') === exited, JSON.stringify({ actions, error: error?.message }));
  check(`warden owner finally: primary and cleanup failure survive with Worker exit ${exited}`,
    errorsOf(error).includes(primary) && errorsOf(error).includes(closeError), JSON.stringify({ error: error?.message, errors: errorsOf(error).map(item => item?.message) }));
}

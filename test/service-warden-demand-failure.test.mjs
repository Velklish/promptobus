// Pure production coordinator control flow; actual owner/Worker proof is tested separately.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';

const compiled = readFileSync(new URL('../lib/service-warden.js', import.meta.url), 'utf8');
const source = compiled.slice(compiled.indexOf('export class ServiceWarden')).replace('export ', '')
  .replace("new URL('./warden-worker.js', import.meta.url)", "'/owned/warden-worker.js'");
const clone = value => value === null ? null : JSON.parse(JSON.stringify(value));

for (const operation of ['ensure', 'abort', 'recover inactive', 'recover continuation']) {
  for (const phase of ['before replace', 'after replace']) {
    let worker, disk = null, writes = 0, sequence = 0, fault = false, inactive = false, fatalities = 0, fatal;
    const primary = new Error(`owned ${operation} ${phase} persistence failure`);
    const actions = [];
    class FixtureWorker extends EventEmitter {
      constructor() { super(); worker = this; queueMicrotask(() => this.emit('message', { kind: 'ready' })); }
      postMessage(message) {
        actions.push(message);
        if (message.kind === 'close') queueMicrotask(() => this.emit('exit', 0));
      }
    }
    const dependencies = {
      path, Worker: FixtureWorker, randomUUID: () => `generation-${++sequence}`, requireTaskId: () => {},
      readPrivate: () => clone(disk), recordOf: value => !!value && typeof value === 'object',
      writePrivate: (_file, value) => {
        writes += 1;
        if (fault && phase === 'before replace') throw primary;
        disk = clone(value);
        if (fault) throw primary;
      },
      taskWardenHost: () => ({ formatStalls: () => [] }), harnessHomeVar: name => name,
      readTask: () => ({ status: inactive ? 'closed' : 'active' }), existsSync: () => true, taskDir: () => '/owned/task',
    };
    const ServiceWarden = new Function(...Object.keys(dependencies), `${source}; return ServiceWarden;`)(...Object.values(dependencies));
    const make = () => new ServiceWarden({ directory: '/owned/service', home: '/owned/home' }, {},
      { pollEnvironment: {}, homes: {}, bins: {} }, {}, error => { fatal = error; fatalities += 1; });
    if (operation.startsWith('recover')) disk = { schemaVersion: 1, home: '/owned/home', tasks: { 'task-a': { demand: 'persisted-a', required: true } } };
    const coordinator = make(); await coordinator.ready;
    let aborted = Promise.resolve(), recovering = Promise.resolve(), caught;
    if (operation === 'ensure' || operation === 'abort') {
      coordinator.ensure('task-a');
      if (operation === 'ensure') aborted = coordinator.abort('task-a').catch(() => {});
    }
    const previous = clone(disk), initialStarts = actions.filter(row => row.kind === 'start');
    if (operation === 'recover continuation') recovering = coordinator.recover().catch(error => error);
    inactive = operation === 'recover inactive'; fault = true;
    try {
      if (operation === 'ensure' || operation === 'recover continuation') coordinator.ensure(operation === 'ensure' ? 'task-a' : 'task-b');
      else if (operation === 'abort') await coordinator.abort('task-a');
      else await coordinator.recover();
    } catch (error) { caught = error; }
    const atFailure = { fatalities, sameError: fatal === primary, disk: clone(disk), writes };
    check(`demand ${operation} ${phase}: persistence refusal immediately enters the common fatal path and preserves its primary`,
      caught === primary && atFailure.fatalities === 1 && atFailure.sameError, JSON.stringify(atFailure));
    const afterWrite = clone(disk), writesAtFailure = writes;
    for (const row of initialStarts) worker.emit('message', { kind: 'settled', task: row.task, generation: row.generation,
      result: { kind: 'stopped', reason: 'actual held callback released by this pure fixture' } });
    await recovering; await aborted; await new Promise(resolve => setImmediate(resolve));
    check(`demand ${operation} ${phase}: late settlement/recovery cannot start an old-owner generation or write after failure`,
      actions.filter(row => row.kind === 'start').length === initialStarts.length && writes === writesAtFailure
      && JSON.stringify(disk) === JSON.stringify(afterWrite), JSON.stringify({ actions, writesAtFailure, writes, disk }));
    if (phase === 'before replace') check(`demand ${operation}: proven pre-replace failure leaves the exact old durable snapshot`,
      JSON.stringify(afterWrite) === JSON.stringify(previous), JSON.stringify({ previous, afterWrite }));
    else check(`demand ${operation}: caller failure does not erase a snapshot already replaced on disk`,
      JSON.stringify(afterWrite) !== JSON.stringify(previous) && JSON.stringify(disk) === JSON.stringify(afterWrite), JSON.stringify({ previous, afterWrite }));
    const writesBeforeLateCalls = writes;
    try { coordinator.ensure('late-task'); } catch {}
    try { await coordinator.abort('task-a'); } catch {}
    const firstClose = coordinator.close(), nextClose = coordinator.close();
    for (const row of actions.filter(row => row.kind === 'start')) worker.emit('message', { kind: 'settled', task: row.task,
      generation: row.generation, result: { kind: 'stopped', reason: 'pure-fixture insurance after verdict' } });
    await Promise.allSettled([firstClose, nextClose]);
    check(`demand ${operation} ${phase}: late owner calls and repeated close preserve durable bytes and one Worker close`,
      writes === writesBeforeLateCalls && firstClose === nextClose && actions.filter(row => row.kind === 'close').length === 1 && fatalities === 1,
    JSON.stringify({ actions, writes, writesBeforeLateCalls, fatalities }));
    fault = false; inactive = false;
    const durable = clone(disk), counter = sequence, beforeRecovery = actions.length;
    const recovered = make(); await recovered.ready; await recovered.recover();
    const restored = actions.slice(beforeRecovery).filter(row => row.kind === 'start');
    const expected = Object.entries(durable?.tasks ?? {}).filter(([, value]) => value.required).map(([task, value]) => [task, value.demand]).sort();
    check(`demand ${operation} ${phase}: successor uses the actual durable generation without inventing a retry action`,
      JSON.stringify(restored.map(row => [row.task, row.generation]).sort()) === JSON.stringify(expected) && sequence === counter,
    JSON.stringify({ expected, restored, counter, sequence }));
    const closing = recovered.close();
    for (const row of restored) worker.emit('message', { kind: 'settled', task: row.task, generation: row.generation,
      result: { kind: 'stopped', reason: 'pure-fixture disposal' } });
    await closing;
  }
}

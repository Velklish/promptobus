import { parentPort, workerData } from 'node:worker_threads';
import { bindHarnessBins, bindHarnessHomes, bindPollEnvironment } from './harness-home.js';
import { forgetSessions, snapshotOf } from './drivers.js';
import { readWardenGeneration } from './store.js';
import { readWardenMark } from '../dist/sidecar.js';
import { runTaskWarden } from './warden.js';
import { sameRecordVersion } from './service-state.js';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function tableOf(value) {
    if (!object(value))
        throw new Error('Invalid warden context');
    const table = {};
    for (const [key, item] of Object.entries(value)) {
        if (item !== null && typeof item !== 'string')
            throw new Error('Invalid warden context');
        table[key] = item;
    }
    return table;
}
function bootstrapOf(value) {
    if (!object(value) || typeof value.home !== 'string' || typeof value.version !== 'string')
        throw new Error('Invalid warden bootstrap');
    return { home: value.home, version: value.version, homes: tableOf(value.homes), bins: tableOf(value.bins) };
}
if (!parentPort)
    throw new Error('The task warden entry requires its private worker channel');
const port = parentPort, context = bootstrapOf(workerData);
bindHarnessHomes({ harnessStateHome: harness => context.homes[harness] ?? null });
bindHarnessBins({ resolveToolBin: tool => context.bins[tool] ? { ok: true, bin: context.bins[tool] }
        : { ok: false, reason: `Shared poll context has no binary for ${tool}` } });
bindPollEnvironment(process.env);
const loops = new Map();
const formatting = new Map();
let sequence = 0;
const send = (message) => port.postMessage(message);
const formatStalls = (task, fresh) => new Promise((resolve, reject) => {
    const id = ++sequence;
    formatting.set(id, { resolve, reject });
    send({ kind: 'format', id, task, fresh: [...fresh] });
});
function failureMessage(error) {
    if (error instanceof AggregateError)
        return `${error.message}: ${error.errors.map(failureMessage).join('; ')}`;
    return error instanceof Error ? error.message : String(error);
}
port.on('message', (message) => {
    if (message.kind === 'formatted') {
        const pending = formatting.get(message.id);
        formatting.delete(message.id);
        if (message.error)
            pending?.reject(new Error(message.error));
        else
            pending?.resolve(message.lines ?? []);
    }
    else if (message.kind === 'observe') {
        try {
            forgetSessions();
            const stable = message.records.every(sameRecordVersion);
            const snapshot = stable ? snapshotOf(message.participants) : null;
            send({ kind: 'observed', id: message.id, snapshot: message.records.every(sameRecordVersion) ? snapshot : null });
        }
        catch (error) {
            send({ kind: 'observed', id: message.id, error: error instanceof Error ? error.message : String(error) });
        }
    }
    else if (message.kind === 'abort') {
        const entry = loops.get(message.task);
        if (entry?.generation === message.generation)
            entry.controller.abort();
    }
    else if (message.kind === 'start') {
        if (loops.has(message.task)) {
            send({ kind: 'failed', task: message.task, generation: message.generation, error: 'The previous task warden has not settled' });
            return;
        }
        const controller = new AbortController(), before = readWardenGeneration(context.home, message.task);
        forgetSessions();
        const promise = runTaskWarden({ home: context.home, task: message.task, host: { version: context.version, formatStalls }, session: null, signal: controller.signal });
        const entry = { generation: message.generation, controller, promise };
        loops.set(message.task, entry);
        if (readWardenGeneration(context.home, message.task) > before && readWardenMark(context.home, message.task)?.pid === process.pid) {
            send({ kind: 'started', task: message.task, generation: message.generation });
        }
        void promise.then(result => {
            if (loops.get(message.task) === entry)
                loops.delete(message.task);
            send({ kind: 'settled', task: message.task, generation: message.generation, result });
        }, error => {
            if (loops.get(message.task) === entry)
                loops.delete(message.task);
            send({ kind: 'failed', task: message.task, generation: message.generation, error: failureMessage(error) });
        });
    }
    else if (message.kind === 'close') {
        for (const entry of loops.values())
            entry.controller.abort();
        void Promise.allSettled([...loops.values()].map(entry => entry.promise)).then(() => port.close());
    }
});
port.once('close', () => {
    for (const pending of formatting.values())
        pending.reject(new Error('The task warden formatting channel closed'));
});
send({ kind: 'ready' });

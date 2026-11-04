import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { requireTaskId, taskDir } from '../dist/index.js';
import { readTask } from './store.js';
import { taskWardenHost } from './warden.js';
import { readPrivate, recordOf, writePrivate } from './service-state.js';
import { harnessHomeVar } from './harness-home.js';
export class ServiceWarden {
    paths;
    ready;
    worker;
    exit;
    file;
    demands = new Map();
    tasks = new Map();
    legacy = new Map();
    observations = new Map();
    sequence = 0;
    closing = false;
    closingPromise = null;
    workerExited = false;
    failure = null;
    failed;
    constructor(paths, host, context, env, fatal) {
        this.paths = paths;
        this.file = path.join(paths.directory, 'warden-demand.json');
        const saved = readPrivate(this.file);
        if (saved !== null) {
            if (!recordOf(saved) || saved.schemaVersion !== 1 || saved.home !== paths.home || !recordOf(saved.tasks))
                throw new Error('Invalid shared warden demand state');
            for (const [task, value] of Object.entries(saved.tasks)) {
                requireTaskId(task);
                if (!recordOf(value) || typeof value.demand !== 'string' || typeof value.required !== 'boolean')
                    throw new Error('Invalid shared warden demand state');
                this.demands.set(task, { demand: value.demand, required: value.required });
            }
        }
        const pollEnv = { ...context.pollEnvironment };
        for (const [harness, home] of Object.entries(context.homes))
            if (home)
                pollEnv[harnessHomeVar(harness)] = home;
        for (const key of ['PROMPTOBUS_EXEC_TRACE'])
            if (env[key])
                pollEnv[key] = env[key];
        const bootstrap = { home: paths.home, version: host.version, homes: context.homes, bins: context.bins };
        this.worker = new Worker(new URL('./warden-worker.js', import.meta.url), { workerData: bootstrap, env: pollEnv });
        let readyResolve, readyReject;
        this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        const format = taskWardenHost(host);
        this.worker.on('message', (message) => {
            try {
                if (message.kind === 'ready')
                    readyResolve();
                else if (message.kind === 'format') {
                    void Promise.resolve().then(() => format.formatStalls(message.task, message.fresh)).then(lines => this.send({ kind: 'formatted', id: message.id, lines }), error => this.send({ kind: 'formatted', id: message.id, error: error instanceof Error ? error.message : String(error) }));
                }
                else if (message.kind === 'observed') {
                    const pending = this.observations.get(message.id);
                    this.observations.delete(message.id);
                    if (message.error)
                        pending?.reject(new Error(message.error));
                    else
                        pending?.resolve(message.snapshot ?? null);
                }
                else {
                    const entry = this.tasks.get(message.task);
                    if (!entry || entry.generation !== message.generation)
                        return;
                    if (message.kind === 'started') {
                        entry.started = true;
                        return;
                    }
                    if (message.kind === 'failed') {
                        failed(new Error(message.error));
                        return;
                    }
                    const result = message.result;
                    if (result.kind === 'busy')
                        this.legacy.set(message.task, result.mark.pid);
                    else
                        this.legacy.delete(message.task);
                    const wanted = this.demands.get(message.task);
                    if (!this.closing && result.kind !== 'busy' && wanted?.demand === entry.generation) {
                        this.setDemand(message.task, { ...wanted, required: false });
                    }
                    this.tasks.delete(message.task);
                    entry.resolve(result);
                    if (!this.closing && wanted?.required && wanted.demand !== entry.generation)
                        this.start(message.task, wanted.demand);
                }
            }
            catch (error) {
                failed(error instanceof Error ? error : new Error(String(error)));
            }
        });
        const failed = this.failed = (error) => {
            if (this.failure)
                return;
            this.failure = error;
            readyReject(error);
            for (const pending of this.observations.values())
                pending.reject(error);
            this.observations.clear();
            for (const entry of this.tasks.values())
                entry.reject(error);
            if (!this.closing) {
                void this.close().catch(() => { });
                fatal(error);
            }
        };
        this.worker.once('error', failed);
        this.exit = new Promise(resolve => this.worker.once('exit', code => {
            this.workerExited = true;
            if (!this.closing)
                failed(new Error(`The shared task warden worker exited (${code}); run owner preflight before reconnecting`));
            resolve();
        }));
    }
    send(message) { this.worker.postMessage(message); }
    persist(demands) {
        writePrivate(this.file, { schemaVersion: 1, home: this.paths.home, tasks: Object.fromEntries(demands) });
    }
    setDemand(task, wanted) {
        const candidate = new Map(this.demands);
        candidate.set(task, wanted);
        try {
            this.persist(candidate);
        }
        catch (error) {
            this.failed(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
        this.demands.set(task, wanted);
    }
    start(task, demand) {
        if (this.closing || this.failure)
            throw this.failure ?? new Error('The shared task warden is unavailable');
        let resolve, reject;
        const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
        void promise.catch(() => { });
        this.tasks.set(task, { generation: demand, stopping: false, started: false, promise, resolve: resolve, reject: reject });
        this.legacy.delete(task);
        this.send({ kind: 'start', task, generation: demand });
    }
    async recover() {
        await this.ready;
        if (this.closing || this.failure)
            throw this.failure ?? new Error('The shared task warden is unavailable');
        for (const [task, wanted] of this.demands)
            if (wanted.required) {
                const active = existsSync(taskDir(this.paths.home, task)) && readTask(this.paths.home, task).status === 'active';
                if (active)
                    this.start(task, wanted.demand);
                else
                    this.setDemand(task, { ...wanted, required: false });
            }
    }
    ensure(task) {
        if (this.closing || this.failure)
            throw this.failure ?? new Error('The shared task warden is unavailable');
        requireTaskId(task);
        if (readTask(this.paths.home, task).status !== 'active')
            return { state: 'inactive' };
        const wanted = { demand: randomUUID(), required: true };
        this.setDemand(task, wanted);
        const existing = this.tasks.get(task);
        if (existing) {
            return { state: existing.stopping ? 'stopping' : 'running' };
        }
        this.start(task, wanted.demand);
        return { state: 'starting' };
    }
    async abort(task) {
        if (this.closing || this.failure)
            throw this.failure ?? new Error('The shared task warden is unavailable');
        requireTaskId(task);
        const wanted = this.demands.get(task);
        if (wanted)
            this.setDemand(task, { ...wanted, required: false });
        const entry = this.tasks.get(task);
        if (!entry) {
            this.legacy.delete(task);
            return { kind: 'stopped', reason: 'no shared task loop is running' };
        }
        entry.stopping = true;
        this.send({ kind: 'abort', task, generation: entry.generation });
        return entry.promise;
    }
    async observe(participants, records = []) {
        if (this.closing || this.failure)
            return null;
        await this.ready;
        if (this.closing || this.failure)
            return null;
        const id = ++this.sequence;
        let resolve, reject;
        const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
        this.observations.set(id, { promise, resolve: resolve, reject: reject });
        this.send({ kind: 'observe', id, participants, records });
        return promise;
    }
    active() { return this.tasks.size > 0 || this.observations.size > 0; }
    diagnostics() {
        const tasks = [...this.tasks].map(([task, entry]) => ({ task,
            state: entry.stopping ? 'stopping' : entry.started ? 'running' : 'starting', pid: process.pid }));
        tasks.push(...[...this.legacy].map(([task, pid]) => ({ task, state: 'legacy-busy', pid })));
        return { tasks, observations: this.observations.size };
    }
    hasExited() { return this.workerExited; }
    close() { return this.closingPromise ??= this.closeWorker(); }
    async closeWorker() {
        this.closing = true;
        for (const [task, entry] of this.tasks) {
            entry.stopping = true;
            this.send({ kind: 'abort', task, generation: entry.generation });
        }
        await Promise.allSettled([...this.tasks.values()].map(entry => entry.promise));
        await Promise.allSettled([...this.observations.values()].map(entry => entry.promise));
        this.send({ kind: 'close' });
        await this.exit;
        if (this.failure)
            throw this.failure;
    }
}

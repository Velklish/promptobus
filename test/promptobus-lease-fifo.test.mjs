import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { readLease, underLease } from '../lib/lease.js';

const SB = makeSandbox('promptobus-lease-');
const root = path.join(SB, 'lease');
const moduleUrl = new URL('../lib/lease.js', import.meta.url).href;
const until = async (condition) => {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('TIMEOUT waiting for controlled lease retry');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
};

let deadPid;
for (const key of [null, SB]) {
  const label = key ? 'keyed: ' : '';
  const events = path.join(SB, key ? 'keyed-entries.jsonl' : 'machine-entries.jsonl');
  // Each child pauses its lease retry timer at an IPC barrier; the parent chooses retry order.
  const waiters = [];
  let release;
  const holder = underLease(root, { pid: process.pid, address: 'holder', command: 'hold' },
    () => new Promise((resolve) => { release = resolve; }), { key });
  try {
    await until(() => release);
    for (const [name, retryMs] of [['first', 500], ['second', 50], ['third', 5]]) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { appendFileSync } from 'node:fs';
        import { underLease } from ${JSON.stringify(moduleUrl)};
        globalThis.setTimeout = (callback, ms) => {
          process.send({ retryMs: ms });
          process.once('message', callback);
        };
        await underLease(${JSON.stringify(root)}, {
          pid: process.pid, address: ${JSON.stringify(name)}, command: 'enter',
        }, () => appendFileSync(${JSON.stringify(events)}, JSON.stringify(${JSON.stringify(name)}) + ${JSON.stringify('\n')}), {
          key: ${JSON.stringify(key)}, waitMs: 30_000, retryMs: ${retryMs},
        });
        process.disconnect();
      `], { cwd: SB, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const waiter = { child, name, retryMs, retries: 0, code: null, err: '' };
      child.on('message', (message) => { if (message.retryMs === retryMs) waiter.retries += 1; });
      child.stderr.on('data', (chunk) => { waiter.err += chunk; });
      waiter.done = new Promise((resolve) => {
        child.on('exit', (code) => { waiter.code = code; resolve(); });
      });
      waiters.push(waiter);
      await until(() => waiter.retries === 1 || waiter.code !== null);
      if (waiter.code !== null) throw new Error(waiter.err);
      // Give the next registration a distinct `since` without depending on child startup speed.
      const since = readLease(root, key).waiters.find((entry) => entry.pid === child.pid).since;
      await until(() => new Date().toISOString() > since);
    }
    check(label + 'three live lease waiters register in since order with different retry intervals',
      JSON.stringify(readLease(root, key).waiters.map((entry) => entry.address)) === JSON.stringify(['first', 'second', 'third']),
      JSON.stringify(readLease(root, key)));
    release();
    await holder;
    for (const waiter of [...waiters].reverse()) {
      waiter.child.send('retry');
      await until(() => waiter.retries > 1 || waiter.code !== null);
    }
    for (const waiter of waiters) {
      if (waiter.code === null) waiter.child.send('retry');
      await waiter.done;
    }
    const entries = readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    check(label + 'the oldest live lease waiter takes each release even when later waiters retry first',
      JSON.stringify(entries) === JSON.stringify(['first', 'second', 'third']) && waiters.every((waiter) => waiter.code === 0),
      JSON.stringify({ entries, waiters: waiters.map(({ name, retryMs, code, err }) => ({ name, retryMs, code, err })) }));
  } finally {
    release?.();
    for (const waiter of waiters) if (waiter.code === null) waiter.child.kill('SIGKILL');
    await Promise.all(waiters.map((waiter) => waiter.done));
    await holder;
  }

  deadPid = waiters[0].child.pid;
}

const dir = path.join(root, 'waiters');
mkdirSync(dir, { recursive: true });
const deadFile = path.join(dir, `${deadPid}.json`);
const liveFile = path.join(dir, `${process.pid}.json`);
writeFileSync(deadFile, `${JSON.stringify({ pid: deadPid, since: '2026-01-01T00:00:00.000Z' })}\n`);
writeFileSync(liveFile, `${JSON.stringify({ pid: process.pid, since: '2026-01-02T00:00:00.000Z' })}\n`);
const state = readLease(root);
check('reading the lease removes a dead waiter file and retains the live waiter file',
  !existsSync(deadFile) && existsSync(liveFile) && state.waiters.length === 1 && state.waiters[0].pid === process.pid,
  JSON.stringify({ deadFileExists: existsSync(deadFile), liveFileExists: existsSync(liveFile), state }));

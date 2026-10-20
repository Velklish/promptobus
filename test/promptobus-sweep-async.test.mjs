import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';
import * as store from '../lib/store.js';
import { createRegistry } from '../dist/index.js';
import { opencodeDriver } from '../lib/driver-opencode.js';
import { sweep } from '../lib/sweep.js';

const SB = makeSandbox('promptobus-sweep-');
writeHostConfig(SB);
const home = path.join(SB, '.promptobus');
const task = 'async-sweep-t20261013-140000';
const address = 'worker:accepted';
store.bindSessionIdentity(() => ({ id: 'fixture-owner' }));
store.createTask(home, { id: task, title: 'async sweep fixture', owner: 'fixture-owner' });
store.upsertParticipant(home, task, store.participantRecord(address, { harness: 'opencode', sessionRef: 'dead-fixture' }));
const lock = path.join(store.taskDir(home, task), '.lock');
const file = path.join(store.taskDir(home, task), 'task.json');
const sidecar = store.participantSessionPath(home, task, address);
mkdirSync(path.dirname(sidecar), { recursive: true });
writeFileSync(sidecar, 'fixture');
let release;
const delayed = new Promise((resolve) => { release = resolve; });
let enter;
const entered = new Promise((resolve) => { enter = resolve; });
let finished = false;
let hookLock = false;
let hook;
const registry = createRegistry({ drivers: { opencode: {
  ...opencodeDriver,
  inspect: () => ({ state: 'gone', busy: false, stall: null, id: null }),
  sweepParticipant: (...args) => hook(...args),
} }, fallback: 'opencode' });
const cacheRead = (reader, title) => reader.withTaskCache(() => {
  reader.readTask(home, task);
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  meta.title = title;
  writeFileSync(file, JSON.stringify(meta));
  return reader.readTask(home, task).title;
});
hook = async () => {
  hookLock = existsSync(lock);
  enter();
  await delayed;
  check(': public sweep suspends adapter journal cache across the delayed hook',
    cacheRead(store, 'adapter reread') === 'adapter reread', 'readTask reused a cached journal under the lock');
};
let code;
const pending = capture(async () => { code = await sweep(SB, { task, address }, { registry }); finished = true; });
await entered;
await new Promise((resolve) => setImmediate(resolve));
check(': public sweep stays pending and keeps participant files until its delayed hook settles',
  !finished && existsSync(sidecar), JSON.stringify({ finished, sidecar: existsSync(sidecar) }));
check(': public sweep retains the journal lock across the asynchronous hook',
  hookLock && existsSync(lock), JSON.stringify({ hookLock, lock: existsSync(lock) }));
let relifted = false;
let refusal;
try { store.withTaskLock(home, task, () => { relifted = true; }, { waitMs: 20 }); }
catch (error) { refusal = error.message; }
check(': concurrent same-process relift cannot borrow the sweep lock',
  !relifted && /lock|journal/.test(refusal ?? ''), JSON.stringify({ relifted, refusal }));
const script = `import { withTaskLock } from ${JSON.stringify(new URL('../lib/store.js', import.meta.url).href)};
try { withTaskLock(${JSON.stringify(home)}, ${JSON.stringify(task)}, () => {}, {waitMs: 30}); }
catch (error) { console.error(error.message); process.exitCode = 7; }`;
const concurrent = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: process.env });
check(': concurrent relift process waits and refuses while asynchronous sweep holds the journal',
  concurrent.status === 7 && /journal is busy/.test(concurrent.stderr),
  JSON.stringify({ exit: concurrent.status, stdout: concurrent.stdout, stderr: concurrent.stderr }));
release();
await pending;
check(': completed public sweep removes participant files and releases its lock',
  code === 0 && finished && !existsSync(sidecar) && !existsSync(lock) && store.readTask(home, task).status === 'active',
  JSON.stringify({ code, finished, sidecar: existsSync(sidecar), lock: existsSync(lock) }));

writeFileSync(sidecar, 'reject fixture');
const unhandled = [];
const onUnhandled = (error) => { unhandled.push(error.message); };
process.on('unhandledRejection', onUnhandled);
hook = async () => { throw new Error('fixture cleanup rejected'); };
const warning = await capture(async () => { code = await sweep(SB, { task, address }, { registry }); });
await new Promise((resolve) => setImmediate(resolve));
process.off('unhandledRejection', onUnhandled);
check(': rejected asynchronous sweep hook follows the cleanup warning path without an unhandled rejection',
  code === 0 && warning.includes('could not clear the harness state of participant worker:accepted: fixture cleanup rejected')
  && unhandled.length === 0 && !existsSync(lock) && !existsSync(sidecar),
  JSON.stringify({ code, warning, unhandled, lock: existsSync(lock), sidecar: existsSync(sidecar) }));

const other = 'async-sweep-other-t20261013-140000';
store.createTask(home, { id: other, title: 'overlapping lock fixture', owner: 'fixture-owner' });
let finishFirst, finishSecond, enteredFirst, enteredSecond;
const firstGate = new Promise((resolve) => { finishFirst = resolve; });
const secondGate = new Promise((resolve) => { finishSecond = resolve; });
const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
const secondEntered = new Promise((resolve) => { enteredSecond = resolve; });
const first = store.withTaskLockAsync(home, task, async () => { enteredFirst(); await firstGate; });
const second = store.withTaskLockAsync(home, other, async () => { enteredSecond(); await secondGate; });
await Promise.all([firstEntered, secondEntered]);
finishFirst();
await first;
check(': overlapping task locks keep the adapter journal cache suspended after one settles',
  cacheRead(store, 'overlap adapter') === 'overlap adapter', 'one settled lock restored a cache still suspended by another');
finishSecond();
await second;
const cachesResume = () => store.withTaskCache(() =>
  store.readTask(home, task) === store.readTask(home, task));
check(': the adapter journal cache resumes after all asynchronous task locks settle',
  cachesResume(), 'cache suspension survived the last lock');
let rejected;
try { await store.withTaskLockAsync(home, task, () => { throw new Error('lock callback rejected'); }); }
catch (error) { rejected = error.message; }
check(': throwing asynchronous task-lock callback releases the lock and restores the adapter cache',
  rejected === 'lock callback rejected' && !existsSync(lock) && cachesResume(),
  JSON.stringify({ rejected, lock: existsSync(lock) }));

import { check } from './check.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeSandbox, makeSockDir } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { codexDriver } from '../lib/driver-codex.js';
import { commandReceipts } from '../lib/codex-command-receipts.js';
import { codexStateHome, sessionKey, sessionsDir, writeSession, readSession, dropSession } from '../lib/codex-session.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { bus, createTask, participantRecord, upsertParticipant } from '../lib/store.js';
const repo = fileURLToPath(new URL('..', import.meta.url));
const root = makeSandbox('promptobus-stop-recovery-');
process.env.PROMPTOBUS_CODEX_HOME = path.join(root, 'state');
const runChild = ms => {
  const child = spawn(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore' });
  child.done = new Promise(resolve => child.once('exit', resolve));
  return child;
};
const app = runChild(1); await app.done;
function confirmed(ref, holderPid, fields = {}) {
  const launchId = `launch-${ref}`;
  const file = path.join(codexStateHome(), 'receipts', sessionKey(ref), sessionKey(launchId) + '.jsonl');
  const record = { ref, launchId, threadId: 'thread', holderPid, appPid: app.pid, state: 'alive', stopping: true,
    stopConfirmed: true, commandReceiptFile: file, ...fields };
  const ledger = commandReceipts(file, { format: 1, ref, launchId, holderPid, appPid: app.pid, ...fields });
  const deadlineAt = Date.now() + 5000;
  ledger.append('stop/requested', { threadId: record.threadId, deadlineAt });
  ledger.append('app-server/close', { code: 0, signal: null });
  ledger.append('stop/confirmed', { threadId: record.threadId, launchId, holderPid, appPid: app.pid,
    commands: [], appClose: { code: 0, signal: null }, deadlineAt, originalToolReceipt: 'not synthesized' });
  writeSession(record);
  return record;
}
const holder = runChild(500);
const late = confirmed('late-confirmation', holder.pid);
const socket = makeSockDir('pb-stop-recovery-').sock('holder');
writeSession({ ...late, rpcSocket: socket });
const server = net.createServer(conn => conn.once('data', data => {
  const request = JSON.parse(String(data));
  conn.end(JSON.stringify({ id: request.id, result: { ok: true, stopped: true, launchId: late.launchId,
    receiptFile: late.commandReceiptFile } }) + '\n');
}));
await new Promise(resolve => server.listen(socket, resolve));
try {
  const first = await codexDriver.stop(late.ref, { timeoutMs: 60 });
  check('Stop recovery: confirmation before deadline with a still-live holder remains unresolved',
    !first.ok && first.attempted && !first.stopped && !!readSession(late.ref), JSON.stringify(first));
  await holder.done;
  await new Promise(resolve => server.close(resolve));
  const second = await codexDriver.stop(late.ref, { timeoutMs: 200 });
  check('Stop recovery: validated same-launch confirmation retires after original holder exit without a socket',
    second.ok && second.stopped && !readSession(late.ref), JSON.stringify(second));
  const third = await codexDriver.stop(late.ref, { timeoutMs: 200 });
  check('Stop recovery: retirement is idempotent', third.ok && !third.stopped, JSON.stringify(third));
} finally {
  if (holder.exitCode === null) holder.kill('SIGTERM');
  await holder.done;
  if (server.listening) await new Promise(resolve => server.close(resolve));
  dropSession(late.ref);
}

for (const [name, change] of [
  ['missing-proof', record => rmSync(record.commandReceiptFile)],
  ['truncated-proof', record => writeFileSync(record.commandReceiptFile, readFileSync(record.commandReceiptFile, 'utf8').trimEnd())],
  ['foreign-launch', record => writeSession({ ...record, launchId: 'foreign-launch' })],
  ['foreign-holder', record => writeSession({ ...record, holderPid: app.pid })],
  ['live-reused-holder', record => writeSession({ ...record, holderPid: process.pid })],
  ['live-reused-app', record => writeSession({ ...record, appPid: process.pid })],
  ['unknown-exit', record => {
    const rows = readFileSync(record.commandReceiptFile, 'utf8').trim().split('\n').map(JSON.parse);
    rows.at(-1).commands = [{ itemId: 'unaccounted', completed: true, status: 'failed', exitCode: -1 }];
    writeFileSync(record.commandReceiptFile, rows.map(JSON.stringify).join('\n') + '\n');
  }],
  ['missing-row', record => {
    const rows = readFileSync(record.commandReceiptFile, 'utf8').trim().split('\n');
    rows.splice(1, 1); writeFileSync(record.commandReceiptFile, rows.join('\n') + '\n');
  }],
]) {
  const record = confirmed(name, holder.pid);
  try {
    change(record);
    const result = await codexDriver.stop(record.ref, { timeoutMs: 100 });
    check(`Stop recovery: ${name} cannot authorize retirement`,
      result.ok === false && result.attempted === true && !result.stopped && !!readSession(record.ref), JSON.stringify(result));
  } finally { dropSession(record.ref); }
}

const budgetRecord = confirmed('proof-read-crosses-budget', holder.pid);
const originalRead = fs.readFileSync, originalNow = Date.now;
let clock = originalNow(), proofRead = false;
try {
  Date.now = () => clock;
  fs.readFileSync = function(file, ...args) {
    const bytes = originalRead.call(this, file, ...args);
    if (String(file) === budgetRecord.commandReceiptFile) { proofRead = true; clock += 200; }
    return bytes;
  };
  syncBuiltinESMExports();
  const result = await codexDriver.stop(budgetRecord.ref, { timeoutMs: 80 });
  check('Stop retirement: actual proof read crossing current budget retains the record',
    proofRead && !result.ok && result.attempted && !result.stopped && !!readSession(budgetRecord.ref), JSON.stringify(result));
} finally {
  fs.readFileSync = originalRead; Date.now = originalNow; syncBuiltinESMExports(); dropSession(budgetRecord.ref);
}

const proofHome = path.join(root, 'proof-store');
bus(proofHome, { cli: '0.29.0' });
createTask(proofHome, { id: 'proof-budget', owner: null });
const retainedBudget = confirmed('retained-proof-crosses-budget', holder.pid,
  { home: proofHome, task: 'proof-budget', address: 'worker:proof' });
upsertParticipant(proofHome, 'proof-budget', participantRecord('worker:proof', {
  harness: 'codex', sessionRef: retainedBudget.ref, sessionId: retainedBudget.threadId, nativeLaunchId: retainedBudget.launchId,
}));
let receiptReads = 0;
clock = originalNow();
try {
  Date.now = () => clock;
  fs.readFileSync = function(file, ...args) {
    const bytes = originalRead.call(this, file, ...args);
    if (String(file) === retainedBudget.commandReceiptFile && ++receiptReads === 2) clock += 200;
    return bytes;
  };
  syncBuiltinESMExports();
  const result = await codexDriver.stop(retainedBudget.ref, { timeoutMs: 80 });
  check('Stop retirement: actual task-bound proof retention crossing current budget retains the record',
    receiptReads === 2 && !result.ok && result.attempted && !result.stopped && !!readSession(retainedBudget.ref), JSON.stringify(result));
} finally {
  fs.readFileSync = originalRead; Date.now = originalNow; syncBuiltinESMExports(); dropSession(retainedBudget.ref);
}

const lockRecord = confirmed('competing-lock', holder.pid);
const lockSocket = makeSockDir('pb-stop-lock-').sock('holder');
writeSession({ ...lockRecord, rpcSocket: lockSocket });
const lockServer = net.createServer(conn => conn.once('data', data => {
  const request = JSON.parse(String(data));
  conn.end(JSON.stringify({ id: request.id, result: { ok: true, stopped: true, launchId: lockRecord.launchId } }) + '\n');
}));
await new Promise(resolve => lockServer.listen(lockSocket, resolve));
const lock = path.join(sessionsDir(), sessionKey(lockRecord.ref) + '.transition');
const ready = path.join(root, 'lock-ready');
const locker = spawn(process.execPath, ['--input-type=module', '-e', `
  import { withDirLock } from ${JSON.stringify(pathToFileURL(path.join(repo, 'dist/fs/lock.js')).href)};
  import { writeFileSync } from 'node:fs';
  withDirLock(${JSON.stringify(lock)},()=>{writeFileSync(${JSON.stringify(ready)},'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);},
    {onMissing:()=>new Error('missing'),onBusy:()=>new Error('busy')});`], { stdio: 'ignore' });
const lockerDone = new Promise(resolve => locker.once('exit', resolve));
try {
  check('Stop retirement lock: actual competing process acquired the transition lock',
    await waitFor(() => existsSync(ready), { timeoutMs: 2000 }));
  const started = Date.now();
  let result;
  try { result = await codexDriver.stop(lockRecord.ref, { timeoutMs: 80 }); }
  catch (error) { result = { threw: error.message }; }
  const elapsed = Date.now() - started;
  check('Stop retirement lock: contention returns structured retained failure',
    result.ok === false && result.attempted === true && result.stopped === false && !!readSession(lockRecord.ref), JSON.stringify(result));
  check('Stop retirement lock: contention shares the remaining deadline', elapsed < 500, `${elapsed} ms`);
} finally {
  if (locker.exitCode === null) locker.kill('SIGTERM');
  await lockerDone;
  await new Promise(resolve => lockServer.close(resolve));
  rmSync(lock, { recursive: true, force: true });
  dropSession(lockRecord.ref);
}

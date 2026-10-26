import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs, { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { expectFail, quiet } from './console.mjs';
import { hostOf } from '../lib/host.js';
import * as store from '../lib/store.js';
import { recoverTeamleadRebind, spawnTeamlead } from '../lib/spawn.js';
import { codexDriver } from '../lib/driver-codex.js';
import { commandReceipts } from '../lib/codex-command-receipts.js';
import { sessionFile, sessionKey, writeSession } from '../lib/codex-session.js';
import { done } from '../lib/done.js';
import { sweep } from '../lib/sweep.js';
import { requireNativeTerminal } from '../lib/native-lifecycle.js';

process.env.PROMPTOBUS_WARDEN = 'off';
let sequence = 0;
async function fixture() {
  const root = makeSandbox('promptobus-lifecycle-');
  writeHostConfig(root, { tools: ['codex'] });
  const host = hostOf(root), home = host.promptobusHome();
  process.env.PROMPTOBUS_CODEX_HOME = path.join(root, 'native');
  process.env.CLAUDE_CODE_SESSION_ID = 'root-owner';
  const parent = `native-parent-t20261026-${String(++sequence).padStart(6, '0')}`;
  store.createTask(home, { id: parent, title: 'Native parent', owner: 'root-owner' });
  const brief = path.join(root, 'brief.md');
  writeFileSync(brief, '# Native group\n\nOwned fixture without a model.\n');
  const original = codexDriver.spawn;
  let calls = 0, launchId;
  codexDriver.spawn = async (plan, ctx) => {
    calls++;
    launchId = plan.launchId ?? 'owned-launch';
    ctx.persist('native-thread', 'alive', 'native-thread');
    return { output: 'fixture', session: 'native-thread', seen: {} };
  };
  let plan;
  try {
    await quiet(async () => { plan = await spawnTeamlead(host, { task: parent, brief, slug: 'owned',
      harness: 'codex', tool: { ok: true, bin: 'fixture-codex', version: '0.163.0' } }); });
  } finally { codexDriver.spawn = original; }
  assert.equal(calls, 1, 'production teamlead persistence must establish both actual seats');
  const record = { ref: plan.name, home, task: plan.childTask, address: 'orchestrator', role: 'teamlead',
    threadId: 'native-thread', launchId, holderPid: 2147483646, appPid: 2147483645,
    state: 'dead', stopConfirmed: true };
  const file = path.join(process.env.PROMPTOBUS_CODEX_HOME, 'receipts', sessionKey(record.ref), sessionKey(record.launchId) + '.jsonl');
  const ledger = commandReceipts(file, { format: 1, ...record });
  const deadlineAt = Date.now() + 5000;
  ledger.append('stop/requested', { threadId: record.threadId, deadlineAt });
  ledger.append('app-server/close', { code: 0, signal: null });
  ledger.append('stop/confirmed', { ...record, commands: [], appClose: { code: 0, signal: null },
    deadlineAt, originalToolReceipt: 'not synthesized' });
  writeSession({ ...record, commandReceiptFile: file });
  return { root, host, home, parent, child: plan.childTask, address: plan.address, record, file, brief };
}
const close = (f, task) => done(f.host, { task, 'keep-sessions': true, snapshot: () => ({}),
  adapterFor: () => ({ probe: () => ({ available: 'unknown' }) }) });

for (const operation of ['done', 'sweep']) test(`native teamlead Stop permits parent ${operation} through its verified child`, async () => {
  const f = await fixture();
  const stopped = await codexDriver.stop(f.record.ref);
  assert.equal(stopped.stopped, true, JSON.stringify(stopped));
  assert.equal(existsSync(sessionFile(f.record.ref)), false);
  process.env.CLAUDE_CODE_SESSION_ID = 'native-thread';
  await quiet(() => close(f, f.child));
  process.env.CLAUDE_CODE_SESSION_ID = 'root-owner';
  await quiet(() => operation === 'done' ? close(f, f.parent) : sweep(f.host, { task: f.parent, address: f.address }));
  assert.equal(store.readTask(f.home, f.parent).status, operation === 'done' ? 'done' : 'active');
  assert.equal(readFileSync(f.file, 'utf8').includes('stop/confirmed'), true);
  const parent = store.readTask(f.home, f.parent), lead = store.participantOf(parent, f.address);
  const child = store.participantOf(store.readTask(f.home, f.child), 'orchestrator');
  assert.equal(lead.metadata.nativeLaunchId, f.record.launchId);
  assert.deepEqual(lead.metadata.nativeStop.alias, { task: f.parent, address: f.address });
  const { alias, ...original } = lead.metadata.nativeStop;
  assert.deepEqual(original, child.metadata.nativeStop);
  assert.equal(original.task, f.child, 'the receipt keeps its actual child task identity');
  assert.equal(codexDriver.sweepParticipant(lead, f.parent), false, 'the parent alias owns no second private home');
});

const seat = (f, task, address) => store.participantOf(store.readTask(f.home, task), address);
const change = (f, task, address, fn) => store.upsertParticipant(f.home, task, fn(seat(f, task, address)));
const bytes = f => [f.parent, f.child].map(task => readFileSync(store.taskFile(f.home, task), 'utf8'));

async function relift(f, options = {}) {
  const original = codexDriver.spawn;
  let actual;
  codexDriver.spawn = async (plan, ctx) => {
    actual = { ref: plan.ref ?? f.record.ref, launchId: plan.launchId ?? 'second-launch' };
    await options.beforePersist?.(actual);
    ctx.persist('native-thread-2', 'alive', 'native-thread-2');
    return { output: 'fixture', session: 'native-thread-2', seen: {} };
  };
  try {
    await quiet(() => spawnTeamlead(f.host, { task: f.parent, brief: f.brief, slug: 'owned',
      harness: 'codex', sessions: {}, tool: { ok: true, bin: 'fixture-codex', version: '0.163.0' }, ...options }));
  } finally { codexDriver.spawn = original; }
  return actual;
}
function nextTerminal(f, actual) {
  const record = { ...f.record, ...actual, threadId: 'native-thread-2' };
  const file = path.join(process.env.PROMPTOBUS_CODEX_HOME, 'receipts', sessionKey(record.ref), sessionKey(record.launchId) + '.jsonl');
  const ledger = commandReceipts(file, { format: 1, ...record }), deadlineAt = Date.now() + 5000;
  ledger.append('stop/requested', { threadId: record.threadId, deadlineAt });
  ledger.append('app-server/close', { code: 0, signal: null });
  ledger.append('stop/confirmed', { ...record, commands: [], appClose: { code: 0, signal: null },
    deadlineAt, originalToolReceipt: 'not synthesized' });
  writeSession({ ...record, commandReceiptFile: file });
  return record;
}
for (const operation of ['done', 'sweep']) test(`native teamlead Stop then same-slug relift permits second Stop and parent ${operation}`, async () => {
  const f = await fixture();
  assert.equal((await codexDriver.stop(f.record.ref)).stopped, true);
  const priorReceipt = readFileSync(f.file), actual = await relift(f);
  assert.notEqual(actual.launchId, f.record.launchId);
  const record = nextTerminal(f, actual), stopped = await codexDriver.stop(record.ref);
  assert.equal(stopped.stopped, true, 'second Stop must retire the new actual launch: ' + JSON.stringify(stopped));
  for (const [task, address] of [[f.parent, f.address], [f.child, 'orchestrator']]) {
    const p = seat(f, task, address);
    assert.equal(p.metadata.nativeLaunchId, record.launchId);
    assert.equal(p.metadata.nativeStop.launchId, record.launchId);
  }
  assert.deepEqual(readFileSync(f.file), priorReceipt, 'old terminal evidence remains unchanged');
  process.env.CLAUDE_CODE_SESSION_ID = 'native-thread-2';
  await quiet(() => close(f, f.child));
  process.env.CLAUDE_CODE_SESSION_ID = 'root-owner';
  await quiet(() => operation === 'done' ? close(f, f.parent) : sweep(f.host, { task: f.parent, address: f.address }));
});

test('native teamlead relift validates prior terminal proof before dispatch', async () => {
  const f = await fixture(), before = bytes(f);
  let invoked = false;
  await assert.rejects(() => relift(f, { beforePersist: () => { invoked = true; } }), /unresolved/);
  assert.equal(invoked, false);
  assert.deepEqual(bytes(f), before);
});

test('native teamlead invoked relift failure retains prior proofs and fences both seats', async () => {
  const f = await fixture();
  assert.equal((await codexDriver.stop(f.record.ref)).stopped, true);
  const prior = [seat(f, f.parent, f.address), seat(f, f.child, 'orchestrator')].map(p => p.metadata.nativeStop);
  await assert.rejects(() => relift(f, { beforePersist: () => { throw new Error('unknown invoked fixture outcome'); } }), /unknown invoked/);
  const current = [seat(f, f.parent, f.address), seat(f, f.child, 'orchestrator')];
  assert.deepEqual(current.map(p => p.metadata.nativeStop), prior);
  assert.ok(current[0].metadata.nativePendingLaunchId);
  assert.equal(current[0].metadata.nativePendingLaunchId, current[1].metadata.nativePendingLaunchId);
  let invoked = false;
  await assert.rejects(() => relift(f, { beforePersist: () => { invoked = true; } }), /unresolved/);
  assert.equal(invoked, false);
  process.env.CLAUDE_CODE_SESSION_ID = 'native-thread';
  assert.equal((await expectFail(() => close(f, f.child))).failed, true);
});

test('native teamlead known pre-driver config failure releases only its reserved markers', async () => {
  const f = await fixture();
  assert.equal((await codexDriver.stop(f.record.ref)).stopped, true);
  const prior = [seat(f, f.parent, f.address), seat(f, f.child, 'orchestrator')].map(p => p.metadata.nativeStop);
  const prepare = codexDriver.prepare, blocked = path.join(f.root, 'blocked');
  mkdirSync(blocked);
  codexDriver.prepare = ctx => ({ ...prepare(ctx), files: [{ path: blocked, text: 'cannot replace directory' }] });
  let invoked = false;
  try { await assert.rejects(() => relift(f, { beforePersist: () => { invoked = true; } })); }
  finally { codexDriver.prepare = prepare; }
  assert.equal(invoked, false);
  const current = [seat(f, f.parent, f.address), seat(f, f.child, 'orchestrator')];
  assert.deepEqual(current.map(p => p.metadata.nativeStop), prior);
  assert.equal(current.some(p => p.metadata.nativePendingLaunchId), false);
  requireNativeTerminal(f.home, store.readTask(f.home, f.parent), current[0]);
});

for (const stale of [false, true]) test(`native teamlead partial rebind ${stale ? 'preserves a newer generation' : 'recovers the reserved new generation'}`, async () => {
  const f = await fixture();
  assert.equal((await codexDriver.stop(f.record.ref)).stopped, true);
  const priorReceipt = readFileSync(f.file);
  await assert.rejects(() => relift(f, { fault: step => {
    if (step === 'teamlead-rebind-after-child') throw new Error('fixture partial rebind');
  } }), /partial rebind/);
  const intent = path.join(path.dirname(store.taskFile(f.home, f.parent)), 'rebinds', 'owned.json');
  assert.equal(existsSync(intent), true);
  const child = seat(f, f.child, 'orchestrator');
  assert.equal(child.metadata.nativeStop, undefined);
  assert.equal(child.metadata.nativePendingLaunchId, undefined);
  assert.notEqual(child.metadata.nativeLaunchId, f.record.launchId);
  assert.equal(seat(f, f.parent, f.address).metadata.nativeStop.launchId, f.record.launchId);
  if (stale) {
    change(f, f.child, 'orchestrator', p => ({ ...p, metadata: { ...p.metadata, nativeLaunchId: 'newer' } }));
    const before = bytes(f), oldIntent = readFileSync(intent);
    assert.throws(() => recoverTeamleadRebind(f.home, f.parent, f.address), /generation changed/);
    assert.deepEqual(bytes(f), before);
    assert.deepEqual(readFileSync(intent), oldIntent);
  } else {
    assert.equal(recoverTeamleadRebind(f.home, f.parent, f.address), true);
    const parent = seat(f, f.parent, f.address);
    assert.equal(parent.metadata.nativeLaunchId, child.metadata.nativeLaunchId);
    assert.equal(parent.metadata.nativeStop, undefined);
    assert.equal(parent.metadata.nativePendingLaunchId, undefined);
    const record = nextTerminal(f, { ref: child.sessionRef, launchId: child.metadata.nativeLaunchId });
    assert.equal((await codexDriver.stop(record.ref)).stopped, true);
  }
  assert.deepEqual(readFileSync(f.file), priorReceipt);
});

test('native teamlead rebind recovery preserves a completed Stop of the new generation', async () => {
  const f = await fixture();
  assert.equal((await codexDriver.stop(f.record.ref)).stopped, true);
  const intent = path.join(path.dirname(store.taskFile(f.home, f.parent)), 'rebinds', 'owned.json');
  const unlink = fs.unlinkSync;
  fs.unlinkSync = file => {
    if (file === intent) throw Object.assign(new Error('fixture intent deletion refused'), { code: 'EIO' });
    return unlink(file);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(() => relift(f), /intent deletion refused/); }
  finally { fs.unlinkSync = unlink; syncBuiltinESMExports(); }
  const child = seat(f, f.child, 'orchestrator');
  const record = nextTerminal(f, { ref: child.sessionRef, launchId: child.metadata.nativeLaunchId });
  assert.equal((await codexDriver.stop(record.ref)).stopped, true);
  const before = bytes(f);
  assert.equal(recoverTeamleadRebind(f.home, f.parent, f.address), true);
  assert.deepEqual(bytes(f), before, 'completed new-generation proof must never be overwritten by the rebind intent');
  assert.equal(existsSync(intent), false);
});

for (const damage of ['parent-thread', 'parent-ref', 'parent-mode', 'parent-harness', 'parent-launch',
  'child-thread', 'child-owner', 'child-launch', 'duplicate-alias', 'parent-child-link']) {
  test(`native teamlead Stop refuses ${damage} without retiring or rewriting either seat`, async () => {
    const f = await fixture();
    if (damage.startsWith('parent-')) change(f, f.parent, f.address, p => ({ ...p,
      ...(damage === 'parent-mode' ? { mode: 'attached' } : {}),
      ...(damage === 'parent-harness' ? { harness: 'claude' } : {}),
      ...(damage === 'parent-ref' ? { sessionRef: 'replacement' } : {}),
      metadata: { ...p.metadata, ...(damage === 'parent-thread' ? { sessionId: 'replacement' }
        : damage === 'parent-launch' ? { nativeLaunchId: 'replacement' }
        : damage === 'parent-child-link' ? { childTask: `${f.child}-foreign` } : {}) } }));
    if (damage.startsWith('child-')) change(f, f.child, 'orchestrator', p => ({ ...p, metadata: { ...p.metadata,
      [damage === 'child-thread' ? 'sessionId' : damage === 'child-owner' ? 'owner' : 'nativeLaunchId']: 'replacement' } }));
    if (damage === 'duplicate-alias') store.upsertParticipant(f.home, f.parent, store.participantRecord('teamlead:other', {
      ...seat(f, f.parent, f.address).metadata, harness: 'codex', mode: 'managed', sessionRef: f.record.ref,
    }));
    const before = bytes(f), registry = readFileSync(sessionFile(f.record.ref));
    const stopped = await codexDriver.stop(f.record.ref);
    assert.equal(stopped.stopped, false, JSON.stringify(stopped));
    assert.deepEqual(bytes(f), before);
    assert.deepEqual(readFileSync(sessionFile(f.record.ref)), registry);
  });
}

for (const phase of ['child-before', 'parent-before', 'parent-after']) {
  test(`native teamlead Stop recovers ${phase} publication failure before retirement`, async () => {
    const f = await fixture(), receipt = readFileSync(f.file);
    const parentLock = path.join(path.dirname(store.taskFile(f.home, f.parent)), '.lock');
    const childLock = path.join(path.dirname(store.taskFile(f.home, f.child)), '.lock');
    const launchLock = path.join(path.dirname(sessionFile(f.record.ref)), sessionKey(f.record.ref) + '.transition');
    const target = store.taskFile(f.home, phase === 'child-before' ? f.child : f.parent);
    const rename = fs.renameSync, mkdir = fs.mkdirSync, acquired = [];
    let refused = false, held = false, stopped;
    fs.mkdirSync = (file, ...args) => { if ([parentLock, childLock, launchLock].includes(file)) acquired.push(file); return mkdir(file, ...args); };
    fs.renameSync = (from, to) => {
      if (to !== target || refused) return rename(from, to);
      refused = true;
      held = [parentLock, childLock, launchLock].every(existsSync);
      if (phase === 'parent-after') rename(from, to);
      throw Object.assign(new Error('fixture alias publication refused'), { code: 'EIO' });
    };
    syncBuiltinESMExports();
    try { stopped = await codexDriver.stop(f.record.ref); }
    finally { fs.renameSync = rename; fs.mkdirSync = mkdir; syncBuiltinESMExports(); }
    assert.equal(refused && held, true, 'publication must hold parent, child and launch locks');
    assert.deepEqual(acquired.slice(0, 3), [parentLock, childLock, launchLock], 'all retirement locks use parent then child then session order');
    assert.equal(stopped.stopped, false);
    assert.equal(existsSync(sessionFile(f.record.ref)), true, 'partial publication must retain the recovery record');
    const lead = seat(f, f.parent, f.address);
    assert.throws(() => requireNativeTerminal(f.home, store.readTask(f.home, f.parent), lead), /unresolved/);
    const retry = await codexDriver.stop(f.record.ref);
    assert.equal(retry.stopped, true, JSON.stringify(retry));
    assert.equal(existsSync(sessionFile(f.record.ref)), false);
    assert.deepEqual(readFileSync(f.file), receipt);
    requireNativeTerminal(f.home, store.readTask(f.home, f.parent), seat(f, f.parent, f.address));
    const after = bytes(f), repeated = await codexDriver.stop(f.record.ref);
    assert.equal(repeated.ok && !repeated.stopped, true);
    assert.deepEqual(bytes(f), after);
  });
}

test('native teamlead Stop recovery preserves a newer parent after partial publication', async () => {
  const f = await fixture(), rename = fs.renameSync;
  const target = store.taskFile(f.home, f.parent);
  fs.renameSync = (from, to) => {
    if (to === target) throw Object.assign(new Error('fixture parent publication refused'), { code: 'EIO' });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try { assert.equal((await codexDriver.stop(f.record.ref)).stopped, false); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  change(f, f.parent, f.address, p => ({ ...p, metadata: { ...p.metadata, sessionId: 'newer-thread', nativeLaunchId: 'newer-launch' } }));
  const before = bytes(f);
  assert.equal((await codexDriver.stop(f.record.ref)).stopped, false);
  assert.deepEqual(bytes(f), before);
  assert.equal(existsSync(sessionFile(f.record.ref)), true);
});

for (const task of ['parent', 'child']) test(`native teamlead Stop ${task} lock stays within the shared deadline`, async () => {
  const f = await fixture(), before = bytes(f);
  const lock = path.join(path.dirname(store.taskFile(f.home, f[task])), '.lock');
  mkdirSync(lock);
  writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, since: new Date().toISOString(), session: 'fixture' }));
  try {
    const started = Date.now(), stopped = await codexDriver.stop(f.record.ref, { timeoutMs: 30 });
    assert.equal(stopped.stopped, false);
    assert.ok(Date.now() - started < 500, 'lock wait cannot extend Stop by another fixed allowance');
    assert.deepEqual(bytes(f), before);
    assert.equal(existsSync(sessionFile(f.record.ref)), true);
  } finally { rmSync(lock, { recursive: true, force: true }); }
});

for (const damage of ['copied-proof', 'alias-address', 'alias-task', 'source-address', 'child-proof', 'child-owner', 'parent-launch']) {
  test(`native teamlead parent sweep refuses ${damage} without deleting owned files`, async () => {
    const f = await fixture();
    assert.equal((await codexDriver.stop(f.record.ref)).stopped, true);
    change(f, f.parent, f.address, p => {
      const nativeStop = structuredClone(p.metadata.nativeStop);
      if (damage === 'copied-proof') delete nativeStop.alias;
      if (damage === 'alias-address') nativeStop.alias.address = 'teamlead:foreign';
      if (damage === 'alias-task') nativeStop.alias.task = f.child;
      if (damage === 'source-address') nativeStop.address = 'worker:foreign';
      return { ...p, metadata: { ...p.metadata, nativeStop,
        ...(damage === 'parent-launch' ? { nativeLaunchId: 'replacement' } : {}) } };
    });
    if (damage === 'child-proof') change(f, f.child, 'orchestrator', p => ({ ...p, metadata: { ...p.metadata, nativeStop: null } }));
    if (damage === 'child-owner') change(f, f.child, 'orchestrator', p => ({ ...p, metadata: { ...p.metadata, owner: 'replacement' } }));
    const sentinel = store.participantSettingsPath(f.home, f.parent, f.address);
    mkdirSync(path.dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, 'owned sentinel');
    const before = bytes(f);
    assert.equal((await expectFail(() => sweep(f.host, { task: f.parent, address: f.address }))).failed, true);
    assert.equal(readFileSync(sentinel, 'utf8'), 'owned sentinel');
    assert.deepEqual(bytes(f), before);
  });
}

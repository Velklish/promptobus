import './home.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { withTaskLock } from '../dist/index.js';
import { messageOrderFile, reserveMessageId } from '../dist/v1/message-order.js';
import { openEngine, newTaskIdentity } from '../dist/index.js';

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-message-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let at = new Date('2026-10-20T12:00:00.000Z');
  const engine = openEngine({ root, policy: () => ({ allow: true }), recover: false, now: () => at, ...options });
  const task = newTaskIdentity('order').id;
  const participant = id => ({ id, role: id === 'orchestrator' ? 'orchestrator' : 'worker', harness: 'fixture',
    mode: 'managed', sessionRef: id, capabilities: null, metadata: {} });
  engine.createTask({ id: task, title: 'Ordering fixture', owner: participant('orchestrator') });
  engine.addParticipant(task, participant('worker'));
  const send = body => engine.sendSync(task, { from: 'worker', to: ['orchestrator'], type: 'result', body });
  return { root, engine, task, participant, send, set at(value) { at = new Date(value); } };
}


test('equal-time and reopened writers preserve store-local order across journals', t => {
  const f = fixture(t), first = f.send('first');
  const reopened = openEngine({ root: f.root, recover: false, policy: () => ({ allow: true }), now: () => new Date('2026-10-20T12:00:00Z') });
  const other = newTaskIdentity('other').id;
  reopened.createTask({ id: other, title: 'Other journal', owner: f.participant('orchestrator') });
  const second = reopened.sendSync(other, { from: 'orchestrator', to: ['orchestrator'], type: 'question', body: 'cross journal question' });
  const third = f.send('later answer/result');
  assert.ok(first.message.id < second.message.id && second.message.id < third.message.id);
  assert.equal(second.message.ts, first.message.ts);
});

test('logical counter carries into the next millisecond without changing wall-clock telemetry', t => {
  const f = fixture(t), reserved = '20261020T120000000-9999-ffffff';
  fs.writeFileSync(messageOrderFile(f.engine.home), JSON.stringify({ format: 1, head: reserved }));
  const result = f.send('after rollover').message;
  assert.match(result.id, /^20261020T120000001-0000-/);
  assert.equal(result.ts, '2026-10-20T12:00:00.000Z');
});

test('reservation before intent leaves a harmless crash gap across reopen', t => {
  let reserved;
  const f = fixture(t, { faults(step, info) { if (step === 'order-reserved') { reserved = info.message; throw new Error('crash before intent'); } } });
  assert.throws(() => f.send('interrupted'), /crash before intent/);
  assert.equal(fs.existsSync(path.join(f.engine.home, 'tasks', f.task, 'messages')), false);
  const next = openEngine({ root: f.root, recover: false, policy: () => ({ allow: true }), now: () => new Date('2000-01-01Z') })
    .sendSync(f.task, { from: 'worker', to: ['orchestrator'], type: 'result', body: 'after crash' });
  assert.ok(next.message.id > reserved);
});

test('explicit rebuild preserves canonical bytes and retained assignment fences above every message', t => {
  const f = fixture(t), first = f.send('retained');
  const canonical = path.join(f.engine.home, 'tasks', f.task, 'messages', `${first.message.id}.json`), original = fs.readFileSync(canonical);
  const assigned = f.engine.assignParticipant(f.task, f.participant('worker'));
  const fence = assigned.participants.find(p => p.id === 'worker').metadata.assignmentAfterId;
  assert.ok(fence > first.message.id);
  assert.equal(fs.existsSync(path.join(path.dirname(canonical), `${fence}.json`)), false);
  fs.unlinkSync(messageOrderFile(f.engine.home));
  assert.throws(() => f.send('missing head'), /missing high-water in a populated store/);
  const rebuilt = f.engine.rebuildMessageOrder();
  assert.equal(rebuilt.head, fence); assert.equal(rebuilt.fences, 1);
  f.at = '1999-01-01Z'; assert.ok(f.send('after reconstruction').message.id > fence);
  assert.deepEqual(fs.readFileSync(canonical), original);
});

test('rebuild retains a valid reserved high-water and refuses unsupported or incomplete retained evidence', t => {
  const f = fixture(t), result = f.send('retained');
  const head = '20991231T235959999-9999-ffffff';
  fs.writeFileSync(messageOrderFile(f.engine.home), JSON.stringify({ format: 1, head }));
  assert.equal(f.engine.rebuildMessageOrder().head, head);
  fs.writeFileSync(messageOrderFile(f.engine.home), JSON.stringify({ format: 2, head }));
  assert.throws(() => f.engine.rebuildMessageOrder(), error => error.code === 'schema-version-unsupported');
  fs.writeFileSync(messageOrderFile(f.engine.home), '{malformed');
  assert.throws(() => f.send('malformed head'), /malformed high-water/);
  assert.equal(f.engine.rebuildMessageOrder().head, result.message.id);
  const broken = path.join(f.engine.home, 'tasks', f.task, 'broken', 'messages'); fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'retained.json'), 'unresolved evidence');
  assert.throws(() => f.engine.rebuildMessageOrder(), /broken retained messages/);
});

test('reconstruction includes open intents and refuses unknown or malformed retained task records', t => {
  const f = fixture(t), canonical = f.send('canonical').message;
  const id = reserveMessageId(f.engine.home, new Date('2030-01-01Z'));
  const intents = path.join(f.engine.home, 'tasks', f.task, 'intents'); fs.mkdirSync(intents, { recursive: true });
  fs.writeFileSync(path.join(intents, `${id}.json`), JSON.stringify({ ...canonical, id, body: 'retained open intent' }));
  fs.unlinkSync(messageOrderFile(f.engine.home));
  const rebuilt = f.engine.rebuildMessageOrder();
  assert.equal(rebuilt.head, id); assert.equal(rebuilt.messages, 1); assert.equal(rebuilt.intents, 1);
  const unknown = path.join(f.engine.home, 'tasks', '!unknown'); fs.mkdirSync(unknown);
  const before = fs.readFileSync(messageOrderFile(f.engine.home));
  assert.throws(() => f.engine.rebuildMessageOrder(), /unknown retained task entry/);
  fs.rmSync(unknown, { recursive: true });
  const task = f.engine.taskFile(f.task); fs.writeFileSync(task, '{malformed');
  assert.throws(() => f.engine.rebuildMessageOrder(), SyntaxError);
  assert.deepEqual(fs.readFileSync(messageOrderFile(f.engine.home)), before);
});

test('normal short-lived engine allocation rereads bounded head without scanning retained canonical history', t => {
  const f = fixture(t); f.send('initialize');
  const read = fs.readSync, list = fs.readdirSync; let headBytes = 0;
  fs.readSync = (fd, ...args) => { const count = read(fd, ...args); headBytes += count; return count; };
  fs.readdirSync = (directory, ...args) => {
    if (String(directory) === path.join(f.engine.home, 'tasks') || String(directory).endsWith('/messages')) throw new Error('unexpected retained-history scan');
    return list(directory, ...args);
  };
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 4; i++) openEngine({ root: f.root, recover: false, policy: () => ({ allow: true }), now: () => new Date('2000-01-01Z') })
      .sendSync(f.task, { from: 'worker', to: ['orchestrator'], type: 'result', body: `reopen-${i}` });
    assert.ok(headBytes > 0 && headBytes < 4 * 4096);
  } finally { fs.readSync = read; fs.readdirSync = list; syncBuiltinESMExports(); }
});

test('oversized head refuses before reading its bytes and explicit rebuild requires complete raw traversal', t => {
  const f = fixture(t); f.send('initialize');
  fs.writeFileSync(messageOrderFile(f.engine.home), ' '.repeat(4097));
  const read = fs.readSync; let bytes = 0;
  fs.readSync = (fd, ...args) => { const count = read(fd, ...args); bytes += count; return count; }; syncBuiltinESMExports();
  try { assert.throws(() => f.send('oversized'), /malformed high-water/); assert.equal(bytes, 0); }
  finally { fs.readSync = read; syncBuiltinESMExports(); }
  const list = fs.readdirSync;
  fs.readdirSync = (directory, ...args) => {
    if (String(directory) === path.join(f.engine.home, 'tasks')) throw Object.assign(new Error('listing refused'), { code: 'EACCES' });
    return list(directory, ...args);
  }; syncBuiltinESMExports();
  try { assert.throws(() => f.engine.rebuildMessageOrder(), error => error.code === 'EACCES'); }
  finally { fs.readdirSync = list; syncBuiltinESMExports(); }
  assert.equal(fs.statSync(messageOrderFile(f.engine.home)).size, 4097);
});

for (const kind of ['no-lease', 'partial']) test(`strict committed facts refuse a newer ${kind} intent instead of accepting visible old facts`, t => {
  const f = fixture(t);
  f.engine.sendSync(f.task, { from: 'orchestrator', to: ['worker'], type: 'task', body: 'A1' });
  f.send('R1');
  const id = withTaskLock(f.engine.home, f.task, () => reserveMessageId(f.engine.home, new Date('2000-01-01Z')));
  const directory = path.join(f.engine.home, 'tasks', f.task, 'intents'); fs.mkdirSync(directory, { recursive: true });
  const message = { protocolVersion: 1, id, task: f.task, sender: 'orchestrator', recipients: ['worker'], type: 'task', body: 'A2', ts: '2000-01-01T00:00:00.000Z' };
  fs.writeFileSync(path.join(directory, `${id}.json`), kind === 'partial' ? '{' : JSON.stringify(message));
  assert.throws(() => f.engine.facts(f.task), /unresolved task intent/);
});

for (const query of ['facts', 'rebuild']) test(`${query} cannot miss a partial intent quarantined between retained namespace listings`, t => {
  const f = fixture(t);
  f.engine.sendSync(f.task, { from: 'orchestrator', to: ['worker'], type: 'task', body: 'A1' }); f.send('R1');
  const id = reserveMessageId(f.engine.home, new Date('2030-01-01Z'));
  const directory = path.join(f.engine.home, 'tasks', f.task);
  const intents = path.join(directory, 'intents'); fs.mkdirSync(intents, { recursive: true });
  const partial = path.join(intents, `${id}.json`); fs.writeFileSync(partial, '{');
  fs.utimesSync(partial, new Date('2040-01-01Z'), new Date('2040-01-01Z'));
  if (query === 'rebuild') fs.unlinkSync(messageOrderFile(f.engine.home));
  const source = `import {openEngine} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
let clock=Date.parse('2050-01-01Z'); Date.now=()=>clock+=6000;
const engine=openEngine({home:process.env.ORDER_HOME,recover:false,policy:()=>({allow:true})});
try {const result=engine.recover(process.env.ORDER_TASK); console.log(JSON.stringify({kind:'recovered',broken:result.broken.length}));}
catch(error){console.log(JSON.stringify({kind:'blocked',message:error.message}));}`;
  const recover = () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, ORDER_HOME: f.engine.home, ORDER_TASK: f.task }, encoding: 'utf8', timeout: 3000,
    });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
  };
  const list = fs.readdirSync; let interleaved;
  fs.readdirSync = (target, ...args) => {
    if (String(target) !== path.join(directory, 'broken', 'messages') || interleaved) return list(target, ...args);
    let names, failure;
    try { names = list(target, ...args); } catch (error) { failure = error; }
    interleaved = recover();
    if (failure) throw failure;
    return names;
  }; syncBuiltinESMExports();
  try {
    assert.throws(() => query === 'facts' ? f.engine.facts(f.task) : f.engine.rebuildMessageOrder(),
      error => query === 'facts' ? /unresolved task intent/.test(error.message) : error instanceof SyntaxError,
      'A concurrent quarantine must not make unresolved A2 disappear and expose only old A1/R1');
  } finally { fs.readdirSync = list; syncBuiltinESMExports(); }
  assert.equal(interleaved.kind, 'blocked'); assert.match(interleaved.message, /message order commit is busy/);
  assert.equal(fs.existsSync(partial), true);
  if (query === 'rebuild') assert.equal(fs.existsSync(messageOrderFile(f.engine.home)), false);
  assert.deepEqual(recover(), { kind: 'recovered', broken: 1 });
  assert.equal(fs.existsSync(path.join(directory, 'broken', 'messages', `${id}.json`)), true);
  assert.throws(() => query === 'facts' ? f.engine.facts(f.task) : f.engine.rebuildMessageOrder(),
    /requires explicit repair|broken retained messages/);
});

test('live paused A2 intent excludes stale A1/R1 facts before canonical publication and later recovers exact order', async t => {
  const f = fixture(t);
  f.engine.sendSync(f.task, { from: 'orchestrator', to: ['worker'], type: 'task', body: 'A1' }); const prior = f.send('R1');
  const module = new URL('../dist/index.js', import.meta.url).href;
  const source = `import {openEngine} from ${JSON.stringify(module)};
const e=openEngine({root:process.env.ORDER_ROOT,recover:false,policy:()=>({allow:true}),now:()=>new Date('1999-01-01Z'),faults(step,info){if(step==='intent'){process.stdout.write(info.message+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});
e.sendSync(process.env.ORDER_TASK,{from:'orchestrator',to:['worker'],type:'task',body:'A2'});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, ORDER_ROOT: f.root, ORDER_TASK: f.task }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const ready = new Promise((resolve, reject) => { child.stdout.once('data', data => resolve(String(data).trim())); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`child exited ${code}`)); }); });
  const done = new Promise((resolve, reject) => { let stderr = ''; child.stderr.on('data', data => { stderr += data; }); child.once('exit', (code, signal) => code === 0 || signal === 'SIGTERM' ? resolve() : reject(new Error(stderr))); });
  const id = await ready; assert.ok(id > prior.message.id);
  assert.throws(() => f.engine.facts(f.task), /unresolved task intent/);
  const later = f.send('another result after A2 intent'); assert.ok(later.message.id > id);
  child.kill('SIGTERM'); await done;
  assert.deepEqual(f.engine.facts(f.task).messages.map(m => m.body), ['A1', 'R1', 'A2', 'another result after A2 intent']);
});

test('explicit operator rebuild uses only the sealed fake host store and creates no work or harness session', async t => {
  const f = fixture(t), sent = f.send('retained');
  fs.unlinkSync(messageOrderFile(f.engine.home));
  const { runPromptobus } = await import('../lib/cli.js');
  let stdout = '';
  const host = { commandName: 'fixture-promptobus', version: '0.0.0', workspaceRoot: f.root,
    promptobusHome: () => f.engine.home,
    harnessStateHome() { throw new Error('repair must not read an ambient harness home'); },
    resolveToolBin() { throw new Error('repair must not resolve or launch a harness binary'); } };
  const before = fs.readFileSync(f.engine.taskFile(f.task));
  const exit = await runPromptobus(['message-order', 'rebuild'], { host, cwd: f.root, env: {}, output: { write(text) { stdout += text; } } });
  assert.equal(exit, 0); assert.equal(JSON.parse(stdout).head, sent.message.id);
  assert.deepEqual(fs.readFileSync(f.engine.taskFile(f.task)), before);
  assert.deepEqual(f.engine.facts(f.task).messages.map(message => message.id), [sent.message.id]);
});

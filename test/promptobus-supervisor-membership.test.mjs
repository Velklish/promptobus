import './home.mjs';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeSandbox } from './sandbox.mjs';
import { openEngine } from '../dist/index.js';
import { inboxDir, inboxRef, messageFile } from '../dist/v1/layout.js';
import { readHealth, writeHealth, writeWake } from '../dist/sidecar.js';
import { KNOCK_COALESCE_SEC, KNOCK_RETRY_SEC, supervisorRound } from '../dist/supervisor.js';
import { previewBlock } from '../lib/notification.js';

const CAPS = { spawn: true, attach: true, activation: 'push', inspect: true, stop: true };
const START = Date.parse('2026-10-20T12:00:00.000Z');
const WINDOW = KNOCK_COALESCE_SEC * 1000 + 1;
const RETRY = KNOCK_RETRY_SEC * 1000 + 1;
const participant = (id, role, address) => ({ id, role, harness: 'fixture', mode: 'managed',
  capabilities: CAPS, sessionRef: `session-${id}`, metadata: { address } });

function fixture(name, address = 'worker:test') {
  const home = path.join(makeSandbox('promptobus-membership-'), '.promptobus');
  const task = `${name}-t20261020-120000`;
  const engine = openEngine({ home, policy: () => ({ allow: true }), now: () => new Date(START) });
  engine.createTask({ id: task, title: name, owner: participant('owner', 'orchestrator', 'orchestrator') });
  engine.addParticipant(task, participant('worker', 'worker', address));
  const calls = [];
  let reply = { ok: true };
  const registry = { fallback: 'fixture', drivers: { fixture: { id: 'fixture', capabilities: CAPS,
    activate: async (_target, notification) => { calls.push(notification); return reply; } } } };
  const wake = session => writeWake(home, task, address, { socket: 'fixture-contact', session });
  wake('first-session');
  const send = (body, to = ['worker'], type = 'task', journal = task) =>
    engine.sendSync(journal, { from: 'owner', to, type, body }).message;
  const round = (at, extra = {}) => supervisorRound(home, task, { registry, now: START + at, ...extra });
  const health = () => readHealth(home, task)[address];
  const hide = (message, id = 'worker', journal = task) => rmSync(inboxRef(home, journal, id, message.id));
  const deliver = (message, id = 'worker', journal = task) => {
    mkdirSync(inboxDir(home, journal, id), { recursive: true });
    linkSync(messageFile(home, journal, message.id), inboxRef(home, journal, id, message.id));
  };
  return { home, task, engine, calls, registry, wake, send, round, health, hide, deliver,
    refuse: () => { reply = { ok: false, error: 'fixture refused' }; },
    accept: () => { reply = { ok: true }; } };
}

test('a late lower ID is previewed alone after coalescing and unchanged retries suppress it', async () => {
  const f = fixture('late');
  const a = f.send('late A');
  f.hide(a);
  const b = f.send('visible B');
  assert.ok(a.id < b.id);
  await f.round(0);
  f.deliver(a);
  await f.round(1);
  assert.equal(f.calls.length, 1);
  await f.round(WINDOW);
  assert.deepEqual(f.calls[1].messages.map(m => m.id), [a.id]);
  await f.round(WINDOW + RETRY);
  assert.deepEqual(f.calls[2].messages, []);
  assert.equal(f.engine.inboxIdentity(f.task, 'worker').ids.length, 2);
});

test('equal-count replacement below the covered maximum remains pending while the first ref stays', async () => {
  const f = fixture('replace');
  const a = f.send('late replacement');
  f.hide(a);
  const b = f.send('first stays');
  const c = f.send('removed');
  await f.round(0);
  f.hide(c);
  f.deliver(a);
  await f.round(1);
  assert.equal(f.calls.length, 1);
  await f.round(WINDOW);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].messages.map(m => m.id), [a.id]);
  assert.deepEqual(f.health().coveredUnread, [[f.task, 'worker', a.id], [f.task, 'worker', b.id]]);
});

test('merged slots distinguish the same message ID by participant and task', async () => {
  const f = fixture('merged');
  f.engine.addParticipant(f.task, participant('other', 'worker', 'worker:other'));
  const shared = f.send('shared', ['worker', 'other']);
  f.hide(shared, 'other');
  const otherTask = 'merged-other-t20261020-120000';
  f.engine.createTask({ id: otherTask, title: 'other slot', owner: participant('owner', 'orchestrator', 'orchestrator') });
  f.engine.addParticipant(otherTask, participant('worker', 'worker', 'worker:elsewhere'));
  const otherMessage = f.send('other task', ['worker'], 'task', otherTask);
  f.hide(otherMessage, 'worker', otherTask);
  const slots = { alias: false, slots: [{ task: f.task, participant: 'worker' },
    { task: f.task, participant: 'other' }, { task: otherTask, participant: 'worker' }] };
  const mailboxes = p => p.id === 'worker' ? slots : { alias: true, slots: [] };
  await f.round(0, { mailboxes });
  f.deliver(shared, 'other');
  f.deliver(otherMessage, 'worker', otherTask);
  await f.round(1, { mailboxes });
  await f.round(WINDOW, { mailboxes });
  assert.deepEqual(f.calls[1].messages.map(m => m.id), [shared.id, otherMessage.id]);
  assert.equal(f.health().coveredUnread.length, 3);
});

test('failed activation retains its delta without attempting again each tick', async () => {
  const f = fixture('failure');
  f.send('first');
  await f.round(0);
  const later = f.send('second');
  await f.round(1);
  f.refuse();
  await f.round(WINDOW);
  await f.round(WINDOW + 1);
  await f.round(WINDOW + 2);
  assert.equal(f.calls.length, 2);
  assert.equal(f.health().coveredUnread.length, 1);
  f.accept();
  await f.round(WINDOW + RETRY);
  assert.deepEqual(f.calls[2].messages.map(m => m.id), [later.id]);
});

test('directory listing failure retains verified coverage and does not claim a take', async () => {
  const f = fixture('directory');
  const message = f.send('retained');
  await f.round(0);
  const dir = inboxDir(f.home, f.task, 'worker');
  renameSync(dir, `${dir}-saved`);
  writeFileSync(dir, 'not a directory');
  const round = await f.round(1);
  assert.deepEqual(f.health().coveredUnread, [[f.task, 'worker', message.id]]);
  assert.equal(f.health().unread, 1);
  assert.ok(!round.events.some(line => line.startsWith('delivered worker:test')));
  rmSync(dir);
  renameSync(`${dir}-saved`, dir);
  await f.round(RETRY);
  assert.deepEqual(f.calls[1].messages, []);
});

test('a successful broken-ref hint does not cover the refused lower message', async () => {
  const f = fixture('read-refusal');
  const a = f.send('temporarily refused');
  const b = f.send('readable');
  const faults = (step, context) => {
    if (step === 'inbox-read' && context.name === `${a.id}.json`) {
      throw Object.assign(new Error('fixture read refused'), { code: 'EACCES' });
    }
  };
  await f.round(0, { faults });
  assert.deepEqual(f.health().coveredUnread, [[f.task, 'worker', b.id]]);
  assert.equal(f.calls[0].messages.filter(m => m.type === 'mailbox-broken').length, 1);
  await f.round(1);
  assert.equal(f.calls.length, 1);
  await f.round(RETRY);
  assert.deepEqual(f.calls[1].messages.map(m => m.id), [a.id]);
});

test('a partial merged listing prunes only the slot whose absence was verified', async () => {
  const f = fixture('partial');
  f.engine.addParticipant(f.task, participant('other', 'worker', 'worker:other'));
  const first = f.send('first slot');
  const other = f.send('other slot', ['other']);
  const mailboxes = p => p.id === 'worker' ? { alias: false, slots: [
    { task: f.task, participant: 'worker' }, { task: f.task, participant: 'other' },
  ] } : { alias: true, slots: [] };
  await f.round(0, { mailboxes });
  f.hide(first);
  const dir = inboxDir(f.home, f.task, 'other');
  renameSync(dir, `${dir}-saved`);
  writeFileSync(dir, 'not a directory');
  await f.round(1, { mailboxes });
  assert.deepEqual(f.health().coveredUnread, [[f.task, 'other', other.id]]);
  assert.deepEqual(f.health().observedUnread, [[f.task, 'other', other.id]]);
  rmSync(dir);
  renameSync(`${dir}-saved`, dir);
});

test('activation success covers its sampled refs without covering mail that arrived while awaiting it', async () => {
  const f = fixture('sampled');
  const first = f.send('sampled');
  const activate = f.registry.drivers.fixture.activate;
  let later;
  f.registry.drivers.fixture.activate = async (...args) => {
    const result = await activate(...args);
    later = f.send('arrived during activation');
    return result;
  };
  await f.round(0);
  f.registry.drivers.fixture.activate = activate;
  assert.deepEqual(f.health().coveredUnread, [[f.task, 'worker', first.id]]);
  await f.round(1);
  await f.round(WINDOW);
  assert.deepEqual(f.calls[1].messages.map(m => m.id), [later.id]);
});

test('legacy health takes a conservative snapshot and session change resets the successful baseline', async () => {
  const f = fixture('legacy');
  const message = f.send('retained unread');
  await f.round(0);
  const old = f.health();
  delete old.coveredUnread;
  delete old.observedUnread;
  old.knockedTo = '99991231T235959999-9999-legacy';
  writeHealth(f.home, f.task, { 'worker:test': old });
  await f.round(1);
  assert.equal(f.calls.length, 1);
  await f.round(WINDOW);
  assert.deepEqual(f.calls[1].messages.map(m => m.id), [message.id]);
  f.wake('second-session');
  f.refuse();
  await f.round(2 * WINDOW);
  assert.equal(f.health().coveredUnread, undefined);
  await f.round(2 * WINDOW + 1);
  assert.equal(f.calls.length, 3);
  f.accept();
  await f.round(2 * WINDOW + RETRY);
  assert.deepEqual(f.calls[3].messages.map(m => m.id), [message.id]);
  assert.equal(f.health().wakeSession, 'second-session');
});

test('membership changes obey named holds and status-only mail stays quiet', async () => {
  const f = fixture('hold');
  f.send('held');
  const reset = { said: 'fixture reset', at: new Date(START + RETRY).toISOString() };
  await f.round(0, { sessions: { 'worker:test': { state: 'alive', busy: false,
    stall: { kind: 'limit', reason: 'fixture hold', reset } } } });
  assert.equal(f.calls.length, 0);
  assert.equal(f.health().coveredUnread, undefined);
  await f.round(RETRY);
  assert.equal(f.calls.length, 1);
  const status = fixture('status', 'orchestrator');
  status.send('progress', ['worker'], 'status');
  await status.round(0);
  status.send('more progress', ['worker'], 'status');
  await status.round(RETRY);
  assert.equal(status.calls.length, 0);
  status.engine.read(status.task, 'worker');
  await status.round(RETRY + 1);
  assert.deepEqual(status.health().observedUnread, []);
});

test('successful preview overflow covers the sampled messages and prunes after a take', async () => {
  const f = fixture('budget');
  for (let i = 0; i < 70; i += 1) f.send(`message ${i}`);
  await f.round(0);
  assert.match(previewBlock(f.calls[0].messages), /— and \d+ more: fetch the mailbox/);
  assert.equal(f.health().coveredUnread.length, 70);
  await f.round(RETRY);
  assert.deepEqual(f.calls[1].messages, []);
  f.engine.read(f.task, 'worker');
  await f.round(RETRY + 1);
  assert.deepEqual(f.health().coveredUnread, []);
  assert.deepEqual(f.health().observedUnread, []);
});

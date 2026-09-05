// Contract suite of the drivers and the warden state machine. Run with `npm test`.
//
// The drivers here are STAND-INS, and that is not a saving, it is the subject
// of the check: the contract must hold on a harness that does not exist. Real
// drivers live in `lib/`, and their own branches — the socket, the session
// registry, a binary refusal — are checked separately.
//
// Four kinds of driver are covered by stand-ins: push (wakes on its own),
// pull (organises its own polling), managed (it raised the session) and
// attached (the session attached itself).
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const bus = await import('../dist/index.js');

// A routing policy is required when the engine is opened, and its rule is the
// adapter's business: there is no adapter here, and a stand-in set plays its
// part. The rule "a worker must not write to a worker" lives at the consumer
// and is checked there.
const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-driver-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const home = path.join(SB, 'ws', '.promptobus');
const engine = bus.openEngine({ home, policy: () => ({ allow: true }) });

// There is no adapter here, and a stand-in set plays its part: translating an
// address into a v1 participant record is its job, and it does it by the same
// rules as the mechanism door (`lib/store.js`).
// The address lives in the `metadata` field: the notification names the
// participant by it, and health, contact points, and stop marks are keyed by it.
function rec(address, { harness = 'fake', mode, sessionRef = null, ...fields } = {}) {
  return {
    id: bus.addrDir(address),
    role: bus.roleOf(address),
    harness: (typeof harness === 'string' && harness.trim()) || 'fake',
    // The mode is given AS IS: the driver contract must survive both a typo
    // and junk in the field — the record is edited by hand, and "if not
    // attached, then managed" would stop a session the driver did not launch.
    // The store schema will not accept such a record, and here it is not put
    // in the store: the predicate is asked about a record the caller supplied.
    mode: mode === undefined ? (sessionRef ? 'managed' : 'attached') : mode,
    sessionRef,
    capabilities: null,
    metadata: { address, ...fields },
  };
}

const put = (task, address, fields) => engine.putParticipant(task, rec(address, fields));
const participantAt = (task, address) => engine.readTask(task).participants
  .find((x) => bus.addressOf(x) === address);
const send = (task, to, type, body) => engine.sendSync(task, {
  from: bus.ORCHESTRATOR, to: [bus.addrDir(to)], type, body,
});

let seq = 0;
function newTask(title = 'contract') {
  seq += 1;
  const id = `drv-t2026090${seq % 10}-${String(100000 + seq).slice(0, 6)}`;
  engine.createTask({ id, title, owner: rec(bus.ORCHESTRATOR) });
  return id;
}

// Stand-in driver: capabilities are declared, operations count calls. `activate`
// returns whatever was put in `reply` — that is how a refusal of one participant
// is checked not to take the whole round with it.
function fakeDriver(id, {
  activation = 'push', spawn = true, attach = false, inspect = true, stop = false,
  features = null,
  reply = () => ({ ok: true }), view = () => ({ state: 'alive', busy: false, stall: null, id: null }),
  omit = [],
  knockChannel = 'socket',
} = {}) {
  const calls = { spawn: [], attach: [], inspect: [], activate: [], stop: [] };
  const d = {
    id,
    // Harness properties are declared SEPARATELY from operations and by
    // default they are not there at all: a driver of the previous contract
    // edition does not know them, and it must be read as "cannot", not as
    // "it probably can".
    capabilities: { spawn, attach, activation, inspect, stop, ...(features ?? {}) },
    options: { knockChannel },
    calls,
  };
  if (!omit.includes('spawn')) d.spawn = async (ctx) => { calls.spawn.push(ctx); return { ok: true }; };
  if (!omit.includes('attach')) d.attach = async (ctx) => { calls.attach.push(ctx); return { ok: true }; };
  if (!omit.includes('inspect')) d.inspect = (ref) => { calls.inspect.push(ref); return view(ref); };
  if (!omit.includes('activate')) {
    d.activate = async (target, notification) => {
      calls.activate.push({ target, notification });
      return reply(target, notification);
    };
  }
  if (!omit.includes('stop')) d.stop = (ref) => { calls.stop.push(ref); return { ok: true, stopped: true, note: 'closed' }; };
  return d;
}

// Refusal of an async operation: `stopParticipant` returns a promise, and a
// synchronous `try` would walk past the refusal with the outcome "it did not
// throw".
const rejected = async (fn) => {
  try {
    await fn();
    return { threw: false, name: '', msg: '' };
  } catch (e) {
    return { threw: true, name: e?.constructor?.name, msg: e.message };
  }
};

const thrown = (fn) => {
  try {
    fn();
    return { threw: false, name: '', msg: '' };
  } catch (e) {
    return { threw: true, name: e?.constructor?.name, msg: e.message };
  }
};

// --- registry: harness → driver map ----------------------------------------

test('the registry is assembled only from drivers that meet the contract', () => {
  const bad = thrown(() => bus.createRegistry({ drivers: { fake: { id: 'fake' } } }));
  assert.equal(bad.name, 'GateError');
  assert.match(bad.msg, /no id or capabilities/);
  const noFallback = thrown(() => bus.createRegistry({ drivers: { fake: fakeDriver('fake') }, fallback: 'other' }));
  assert.equal(noFallback.name, 'GateError');
  assert.match(noFallback.msg, /fallback/);
});

test('an unknown harness refuses and names the known ones', () => {
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake') } });
  const r = thrown(() => bus.driverFor(registry, 'cursor'));
  assert.equal(r.name, 'GateError');
  assert.match(r.msg, /«cursor» is unknown/);
  assert.match(r.msg, /known: fake/);
});

test('a former-CLI record harness is taken from fallback, and a non-empty unknown one is not', () => {
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake') }, fallback: 'fake' });
  // The `harness` field is not there at all — this is a record made before the
  // field appeared.
  assert.equal(bus.harnessOf(rec('worker:a'), registry), 'fake');
  assert.equal(bus.driverFor(registry, bus.harnessOf(rec('worker:a'), registry)).id, 'fake');
  // An empty string is also "not named": spaces do not make a harness a name.
  assert.equal(bus.harnessOf(rec('worker:a', { harness: '  ' }), registry), 'fake');
  // A non-empty unknown name is not saved by fallback: this is a declared
  // harness, and it is foreign.
  assert.equal(thrown(() => bus.driverFor(registry, bus.harnessOf({ harness: 'cursor' }, registry))).name, 'GateError');
  // Without fallback a record without a harness also refuses — it is not
  // silently attributed to anyone.
  const strict = bus.createRegistry({ drivers: { fake: fakeDriver('fake') } });
  assert.match(thrown(() => bus.driverFor(strict, bus.harnessOf({}, strict))).msg, /not named/);
});

test('a capability is asked both as a declaration and as an operation', () => {
  const declared = fakeDriver('fake', { stop: false });
  assert.match(thrown(() => bus.requireCapability(declared, 'stop')).msg, /cannot stop/);
  // Declared, but there is no operation — the same refusal: they are
  // indistinguishable to the caller.
  const lying = fakeDriver('fake', { stop: true, omit: ['stop'] });
  assert.match(thrown(() => bus.requireCapability(lying, 'stop')).msg, /declared stop but has no such operation/);
});

// --- harness properties: flags without their own operation -------------------

test('a harness property is asked by the flag, not by operation presence', () => {
  const full = fakeDriver('fake', {
    features: { denyTools: true, systemPrompt: true, sessionList: true, enter: true },
  });
  for (const feature of ['denyTools', 'systemPrompt', 'sessionList', 'enter']) {
    assert.equal(bus.hasFeature(full, feature), true, feature);
  }
  // Declared as false — "cannot", and that is the case the flag was introduced
  // for: a read-only participant does not exist on such a harness at all.
  const half = fakeDriver('fake', { features: { denyTools: false, sessionList: true } });
  assert.equal(bus.hasFeature(half, 'denyTools'), false);
  assert.equal(bus.hasFeature(half, 'sessionList'), true);
  // The flag is not there AT ALL — a driver of the previous contract edition.
  // It is read as "cannot": the silent "it probably can" is exactly what the
  // flag guards against.
  const old = fakeDriver('fake');
  for (const feature of ['denyTools', 'systemPrompt', 'sessionList', 'enter']) {
    assert.equal(bus.hasFeature(old, feature), false, feature);
  }
});

test('the capabilities snapshot carries the new flags, and a former-edition record is read without them', () => {
  const task = newTask();
  const driver = fakeDriver('fake', {
    features: { denyTools: true, systemPrompt: false, sessionList: true, enter: false },
  });
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  const { meta } = bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake', sessionRef: 'sess-a' }), registry);
  const p = meta.participants.find((x) => bus.addressOf(x) === 'worker:a');
  assert.deepEqual(p.capabilities, {
    spawn: true, attach: false, activation: 'push', inspect: true, stop: false,
    denyTools: true, systemPrompt: false, sessionList: true, enter: false,
  });
  // A record made BEFORE the contract extension must be accepted by the schema
  // as-is: such records sit in live journals, and were it to require the new
  // fields, a task of the previous release would stop reading entirely —
  // together with its participants, mailboxes, and the cleanup after it.
  const { meta: old } = bus.openParticipant(home, task,
    rec('worker:b', { harness: 'fake', sessionRef: 'sess-b' }), bus.createRegistry({
      drivers: { fake: fakeDriver('fake') },
    }));
  const q = old.participants.find((x) => bus.addressOf(x) === 'worker:b');
  assert.deepEqual(Object.keys(q.capabilities).sort(),
    ['activation', 'attach', 'inspect', 'spawn', 'stop']);
  // And such a journal is read whole, not "except this participant".
  assert.equal(engine.readTask(task).participants.length, old.participants.length);
});

// --- managed and attached: the participant record ------------------------------------

test('managed: the participant record carries harness, mode, ref, and the capabilities snapshot', () => {
  const task = newTask();
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake') } });
  const { driver, meta } = bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake', sessionRef: 'sess-a' }), registry);
  assert.equal(driver.id, 'fake');
  const p = meta.participants.find((x) => bus.addressOf(x) === 'worker:a');
  assert.equal(p.harness, 'fake');
  assert.equal(p.mode, 'managed');
  assert.equal(p.sessionRef, 'sess-a');
  assert.deepEqual(p.capabilities, { spawn: true, attach: false, activation: 'push', inspect: true, stop: false });
});

test('attached: the session attached itself, and its own capability is required', () => {
  const task = newTask();
  const pushOnly = bus.createRegistry({ drivers: { fake: fakeDriver('fake', { attach: false }) } });
  const refused = thrown(() => bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake', sessionRef: 'sess-a' }), pushOnly, { mode: 'attached' }));
  assert.match(refused.msg, /cannot attach/);
  const withAttach = bus.createRegistry({ drivers: { fake: fakeDriver('fake', { attach: true }) } });
  const { meta } = bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake', sessionRef: 'sess-a' }), withAttach, { mode: 'attached' });
  assert.equal(meta.participants.find((x) => bus.addressOf(x) === 'worker:a').mode, 'attached');
});

test('an unknown harness refuses BEFORE the participant write', () => {
  const task = newTask();
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake') } });
  const before = readFileSync(engine.taskFile(task), 'utf8');
  const r = thrown(() => bus.openParticipant(home, task,
    rec('worker:a', { harness: 'cursor', sessionRef: 'sess-a' }), registry));
  assert.equal(r.name, 'GateError');
  assert.equal(readFileSync(engine.taskFile(task), 'utf8'), before, 'the task journal was not touched');
  assert.equal(engine.readTask(task).participants.some((p) => bus.addressOf(p) === 'worker:a'), false);
});

test('an undeclared capability refuses BEFORE the participant write', () => {
  const task = newTask();
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake', { spawn: false }) } });
  const before = readFileSync(engine.taskFile(task), 'utf8');
  assert.match(thrown(() => bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake', sessionRef: 'sess-a' }), registry)).msg, /cannot spawn/);
  assert.equal(readFileSync(engine.taskFile(task), 'utf8'), before, 'the task journal was not touched');
});

test('a participant without a session reference refuses in the same order', () => {
  const task = newTask();
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake') } });
  const before = readFileSync(engine.taskFile(task), 'utf8');
  assert.match(thrown(() => bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake' }), registry)).msg, /session reference/);
  assert.equal(readFileSync(engine.taskFile(task), 'utf8'), before);
});

test('stop only kills managed: attached refuses by mode, not by capability', async () => {
  const driver = fakeDriver('fake', { attach: true, stop: true });
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  const managed = rec('worker:a', { harness: 'fake', mode: 'managed', sessionRef: 'sess-a' });
  const attached = rec('worker:b', { harness: 'fake', mode: 'attached', sessionRef: 'sess-b' });
  // The stop outcome is `await`ed: the driver may wait until the harness no
  // longer has the session, and a synchronous field read would walk past the
  // promise.
  assert.equal((await bus.stopParticipant(managed, registry)).ok, true);
  assert.deepEqual(driver.calls.stop, ['sess-a']);
  const refused = await rejected(() => bus.stopParticipant(attached, registry));
  assert.equal(refused.name, 'GateError');
  assert.match(refused.msg, /mode «attached»/);
  assert.match(refused.msg, /did not launch/);
  assert.deepEqual(driver.calls.stop, ['sess-a'], 'attached did not reach the driver');
  // A former-CLI record does not carry a mode at all — spawn raised its
  // session, and it is managed.
  assert.equal(bus.modeOf(rec('worker:c', { sessionRef: 'sess-c' })), 'managed');
  assert.equal(bus.isManaged(rec('worker:c', { sessionRef: 'sess-c' })), true);
  // The task owner carries no session reference: it has no mode, there is
  // nothing to stop.
  assert.equal(bus.modeOf(rec(bus.ORCHESTRATOR)), null);
  assert.equal(bus.isManaged(rec(bus.ORCHESTRATOR)), false);
  assert.equal((await bus.stopParticipant(managed, registry)).stopped, true, 'the "stopped" outcome is distinct from "nothing to stop"');
});

test('an unfamiliar mode is not counted as managed — neither a case typo nor junk', async () => {
  const driver = fakeDriver('fake', { stop: true });
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  // "If not attached, then managed" would stop a session the driver did not
  // launch: a hand-edited field can be a typo or junk.
  for (const mode of ['Attached', 'MANAGED', 'что-то своё', 'managed ']) {
    const p = rec('worker:a', { harness: 'fake', mode, sessionRef: 'sess-a' });
    const known = mode.trim() === 'managed';
    assert.equal(bus.isManaged(p), known, `mode=${JSON.stringify(mode)}`);
    if (known) continue;
    const r = await rejected(() => bus.stopParticipant(p, registry));
    assert.equal(r.name, 'GateError', `mode=${JSON.stringify(mode)}`);
    assert.match(r.msg, /does not know this mode|mode «attached»/);
  }
  assert.deepEqual(driver.calls.stop, [], 'an unfamiliar mode did not reach the driver');
  // The field is not there at all — a lawful default: that is how the former
  // CLI wrote participants.
  assert.equal(bus.isManaged(rec('worker:a', { sessionRef: 'sess-a' })), true);
  assert.equal(bus.isManaged(rec('worker:a', { mode: '  ', sessionRef: 'sess-a' })), true);
});

test('a driver without the stop capability refuses before the call, even for a managed participant', async () => {
  const driver = fakeDriver('fake', { stop: false, omit: ['stop'] });
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  const r = await rejected(() => bus.stopParticipant(
    rec('worker:a', { harness: 'fake', mode: 'managed', sessionRef: 'sess-a' }), registry));
  assert.equal(r.name, 'GateError');
  assert.match(r.msg, /cannot stop/);
});

// --- inspect: the session snapshot --------------------------------------------------

test('the snapshot is assembled through the registry and keyed by participant address', () => {
  const task = newTask();
  const driver = fakeDriver('fake', {
    view: (ref) => (ref === 'sess-b'
      ? { state: 'stale', busy: false, stall: null, id: 'id-b' }
      : { state: 'alive', busy: true, stall: null, id: 'id-a', note: 'busy' }),
  });
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a' });
  put(task, 'worker:b', { harness: 'fake', sessionRef: 'sess-b' });
  const snap = bus.snapshotSessions(engine.readTask(task).participants, registry);
  assert.deepEqual(Object.keys(snap).sort(), ['worker:a', 'worker:b']);
  assert.equal(snap['worker:a'].busy, true);
  assert.equal(snap['worker:b'].state, 'stale');
  // The task owner carries no session reference — it is not in the snapshot
  // at all, and that is not "vanished".
  assert.equal(Object.hasOwn(snap, bus.ORCHESTRATOR), false);
  assert.equal(bus.liveParticipant(rec(bus.ORCHESTRATOR), snap), 'unknown');
});

test('the driver did not parse the state — there is no snapshot at all', () => {
  const task = newTask();
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake', { view: () => null }) } });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a' });
  assert.equal(bus.snapshotSessions(engine.readTask(task).participants, registry), null);
  // Unknown is not death: the stalled list does not invent it.
  assert.equal(bus.blockedParticipants(home, task, engine.readTask(task).participants, null), null);
});

// --- unknown: there is no one to ask ------------------------------------------
//
// Two kinds of participant there is nothing to ask about: there is no driver
// for its harness in the map, and there is a driver but `inspect` is not
// declared. Both must be read as UNKNOWN, not as death: taking them for dead,
// the mechanism would stop a live task's listener, report "GONE" about a
// working session, and wipe its config in cleanup.

test('a foreign harness does not bring the snapshot down, it gives that participant unknown', () => {
  const task = newTask();
  const driver = fakeDriver('fake');
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  put(task, 'worker:a', { harness: 'cursor', sessionRef: 'sess-a', started: '2020-01-01T00:00:00.000Z' });
  put(task, 'worker:b', { harness: 'fake', sessionRef: 'sess-b', started: '2020-01-01T00:00:00.000Z' });
  const ps = engine.readTask(task).participants;
  const snap = bus.snapshotSessions(ps, registry);
  assert.equal(snap['worker:a'].state, 'unknown', 'the snapshot assembled, it did not throw');
  assert.equal(snap['worker:b'].state, 'alive');
  assert.equal(bus.liveParticipant(ps.find((p) => bus.addressOf(p) === 'worker:a'), snap), 'unknown');
  // The unknown is not stopped and is not reported.
  assert.ok(bus.liveWatched(home, task, snap).includes('worker:a'));
  assert.deepEqual(bus.blockedParticipants(home, task, ps, snap), []);
});

test('a driver without inspect is also unknown: a live session is not given out as dead', (t) => {
  const task = newTask();
  const blind = fakeDriver('blind', { inspect: false, omit: ['inspect'] });
  const registry = bus.createRegistry({ drivers: { blind }, fallback: 'blind' });
  put(task, 'worker:a', { harness: 'blind', sessionRef: 'sess-a', started: '2020-01-01T00:00:00.000Z' });
  const ps = engine.readTask(task).participants;
  const snap = bus.snapshotSessions(ps, registry);
  assert.equal(snap['worker:a'].state, 'unknown');
  assert.equal(bus.liveParticipant(ps[0], snap), 'unknown');
  assert.deepEqual(bus.blockedParticipants(home, task, ps, snap), [], 'there is no GONE report');
  assert.deepEqual(bus.liveWatched(home, task, snap), ['worker:a'], 'not dropped from the live set');
  return t.test('the warden of a live task does not go out', () => {
    // The warden seat is taken for real: `beatRound` first of all extends its
    // own mark, and without it it would exit on "another process took the
    // seat", not on emptiness.
    bus.claimWarden(home, task);
    assert.equal(bus.beatRound(home, task, Date.now(), { sessions: snap }), null);
  });
});

// --- the stall report carries the record harness ----------------------------
//
// The stall route is a command of a SPECIFIC harness, and it must be asked of
// the driver that parsed the state. By this point the snapshot is already
// assembled, the registry is not passed into the parse at all, so the harness
// travels as a field of the stall record itself.

test('the stall record names the participant harness — the consumer takes the route driver by it', () => {
  const task = newTask();
  const stall = { state: 'alive', busy: false, stall: { kind: 'permission', reason: 'permission prompt' }, id: 'id-a' };
  const registry = bus.createRegistry({
    drivers: { fake: fakeDriver('fake', { view: () => stall }) },
    fallback: 'fake',
  });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a', started: '2020-01-01T00:00:00.000Z' });
  const ps = engine.readTask(task).participants;
  const snap = bus.snapshotSessions(ps, registry);
  const stalled = bus.blockedParticipants(home, task, ps, snap);
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].harness, 'fake');
  // Former-CLI records do not carry a `harness` field at all — then `null`,
  // and the consumer takes the `fallback` of its registry. Inventing a name
  // for them is not allowed: a foreign one would send the route to a driver
  // that did not raise this session.
  const legacy = [{ ...ps.find((x) => bus.addressOf(x) === 'worker:a'), harness: undefined }];
  const legacySnap = { 'worker:a': stall };
  assert.equal(bus.blockedParticipants(home, task, legacy, legacySnap)[0].harness, null);
});

// --- push: activation through the driver --------------------------------------------

test('a push-driver wakes the addressee of the unread, and the notification carries excerpts', async (t) => {
  const task = newTask();
  const driver = fakeDriver('fake');
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a' });
  bus.writeWake(home, task, 'worker:a', { socket: path.join(SB, 'a.sock') });
  send(task, 'worker:a', 'task', 'первое');

  const r = await bus.supervisorRound(home, task, { registry });
  await t.test('the knock went once and to the addressee', () => {
    assert.equal(driver.calls.activate.length, 1);
    assert.equal(driver.calls.activate[0].target.ref, 'sess-a');
    assert.equal(driver.calls.activate[0].target.endpoint.socket, path.join(SB, 'a.sock'));
  });
  await t.test('the notification carries the task, the address, the count, and the message bodies', () => {
    const n = driver.calls.activate[0].notification;
    assert.equal(n.kind, 'unread');
    assert.equal(n.task, task);
    assert.equal(n.address, 'worker:a');
    assert.equal(n.unread, 1);
    assert.equal(n.messages.length, 1);
    assert.equal(n.messages[0].body, 'первое');
    assert.equal(n.messages[0].type, 'task');
    assert.equal(n.messages[0].from, bus.ORCHESTRATOR);
    assert.ok(n.messages[0].id, 'the excerpt has an id — the repeat cutoff goes by it');
  });
  await t.test('the round event is named', () => {
    assert.ok(r.events.some((e) => /notification worker:a/.test(e)), r.events.join('\n'));
  });
});

test('a pull-driver does not wake at all, but its unread is visible', async () => {
  const task = newTask();
  const driver = fakeDriver('fake', { activation: 'pull' });
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a' });
  bus.writeWake(home, task, 'worker:a', { socket: path.join(SB, 'pull.sock') });
  send(task, 'worker:a', 'task', 'лежит');

  await bus.supervisorRound(home, task, { registry });
  assert.equal(driver.calls.activate.length, 0, 'a pull-driver does not wake the session');
  const h = bus.readHealth(home, task)['worker:a'];
  assert.equal(h.unread, 1);
  assert.equal(h.channel, 'pull');
  // Silence of such a participant is visible by the same threshold as for
  // push: the channel has nothing to do with it.
  const late = Date.now() + (bus.SILENCE_SEC + 60) * 1000;
  const r = await bus.supervisorRound(home, task, { registry, now: late });
  assert.ok(r.events.some((e) => /SILENT worker:a/.test(e)), r.events.join('\n'));
});

test('an activation refusal of one participant does not block the others', async (t) => {
  const task = newTask();
  const driver = fakeDriver('fake', {
    reply: (target) => {
      if (target.ref === 'sess-a') throw new Error('channel severed');
      return { ok: true };
    },
  });
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  for (const [addr, ref] of [['worker:a', 'sess-a'], ['worker:b', 'sess-b']]) {
    put(task, addr, { harness: 'fake', sessionRef: ref });
    bus.writeWake(home, task, addr, { socket: path.join(SB, `${ref}.sock`) });
    send(task, addr, 'task', `для ${addr}`);
  }
  const r = await bus.supervisorRound(home, task, { registry });
  await t.test('both participants were walked, the round was not cut short', () => {
    assert.equal(driver.calls.activate.length, 2);
    assert.equal(r.stop, null);
  });
  await t.test('the fallen one got a channel fallback with the reason', () => {
    const h = bus.readHealth(home, task);
    assert.equal(h['worker:a'].channel, 'self-wake');
    assert.equal(h['worker:a'].knockError, 'channel severed');
    // A successful knock writes `options.knockChannel`; on the stand-in
    // driver the default is `socket`, as on Claude Code.
    assert.equal(h['worker:b'].channel, 'socket');
    assert.equal(h['worker:b'].knocks, 1);
    // The refusal journal for channel `socket` is still the word "socket" —
    // the Claude Code form.
    assert.ok(r.events.some((e) => /socket did not accept the notification \(channel severed\)/.test(e)),
      r.events.join('\n'));
  });
});

test('a successful knock writes the driver knockChannel, not the socket literal', async () => {
  const task = newTask();
  const inject = fakeDriver('cursor-like', { knockChannel: 'inject' });
  const rpc = fakeDriver('codex-like', { knockChannel: 'rpc' });
  const registry = bus.createRegistry({
    drivers: { 'cursor-like': inject, 'codex-like': rpc },
  });
  put(task, 'worker:a', { harness: 'cursor-like', sessionRef: 'sess-a' });
  put(task, 'worker:b', { harness: 'codex-like', sessionRef: 'sess-b' });
  for (const [addr, name] of [['worker:a', 'a'], ['worker:b', 'b']]) {
    bus.writeWake(home, task, addr, { socket: path.join(SB, `${name}.sock`) });
    send(task, addr, 'task', `для ${addr}`);
  }
  await bus.supervisorRound(home, task, { registry });
  const h = bus.readHealth(home, task);
  assert.equal(h['worker:a'].channel, 'inject');
  assert.equal(h['worker:b'].channel, 'rpc');
});

test('a failed knock writes the driver knockChannel, not the socket literal', async () => {
  const task = newTask();
  const inject = fakeDriver('cursor-like', {
    knockChannel: 'inject',
    reply: () => ({ ok: false, error: 'channel severed' }),
  });
  const rpc = fakeDriver('codex-like', {
    knockChannel: 'rpc',
    reply: () => ({ ok: false, error: 'holder gone' }),
  });
  const registry = bus.createRegistry({
    drivers: { 'cursor-like': inject, 'codex-like': rpc },
  });
  put(task, 'worker:a', { harness: 'cursor-like', sessionRef: 'sess-a' });
  put(task, 'worker:b', { harness: 'codex-like', sessionRef: 'sess-b' });
  for (const [addr, name] of [['worker:a', 'a'], ['worker:b', 'b']]) {
    bus.writeWake(home, task, addr, { socket: path.join(SB, `${name}.sock`) });
    send(task, addr, 'task', `для ${addr}`);
  }
  const r = await bus.supervisorRound(home, task, { registry });
  const h = bus.readHealth(home, task);
  assert.equal(h['worker:a'].channel, 'self-wake');
  assert.equal(h['worker:b'].channel, 'self-wake');
  assert.ok(r.events.some((e) => /worker:a: inject did not accept the notification \(channel severed\)/.test(e)),
    r.events.join('\n'));
  assert.ok(r.events.some((e) => /worker:b: rpc did not accept the notification \(holder gone\)/.test(e)),
    r.events.join('\n'));
  assert.ok(!r.events.some((e) => /socket did not accept/.test(e)), r.events.join('\n'));
});

test('a participant with an unknown harness does not take the round, it stays a journal line', async () => {
  const task = newTask();
  const driver = fakeDriver('fake');
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  put(task, 'worker:a', { harness: 'cursor', sessionRef: 'sess-a' });
  put(task, 'worker:b', { harness: 'fake', sessionRef: 'sess-b' });
  for (const addr of ['worker:a', 'worker:b']) {
    bus.writeWake(home, task, addr, { socket: path.join(SB, `${addr.replace(':', '-')}.sock`) });
    send(task, addr, 'task', 'привет');
  }
  const r = await bus.supervisorRound(home, task, { registry });
  assert.equal(r.stop, null);
  assert.equal(driver.calls.activate.length, 1, 'the known harness was woken');
  const h = bus.readHealth(home, task);
  assert.equal(h['worker:a'].channel, 'no-driver');
  assert.match(String(h['worker:a'].knockError), /«cursor» is unknown/);
  assert.ok(r.events.some((e) => /nothing to wake with worker:a/.test(e)), r.events.join('\n'));
});

// --- state survives process death ------------------------------------

test('the warden fell and came back — the state is in place, there is no second knock', async (t) => {
  const task = newTask();
  const sock = path.join(SB, 'restart.sock');
  const first = fakeDriver('fake');
  const registry = (d) => bus.createRegistry({ drivers: { fake: d }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a' });
  bus.writeWake(home, task, 'worker:a', { socket: sock });
  send(task, 'worker:a', 'task', 'первое');
  await bus.supervisorRound(home, task, { registry: registry(first) });
  const knockedTo = bus.readHealth(home, task)['worker:a'].knockedTo;

  // "Restart": a fresh driver and a fresh registry, as after process death.
  // The warden has no state of its own — everything it knew sits in the
  // task store.
  const second = fakeDriver('fake');
  await bus.supervisorRound(home, task, { registry: registry(second) });
  await t.test('the re-knock threshold survived the restart — there is no second knock', () => {
    assert.equal(second.calls.activate.length, 0);
    assert.equal(bus.readHealth(home, task)['worker:a'].knocks, 1);
  });

  send(task, 'worker:a', 'status', 'второе');
  const third = fakeDriver('fake');
  await bus.supervisorRound(home, task, { registry: registry(third) });
  await t.test('the repeat cutoff survived too: the notification has only the new', () => {
    assert.equal(third.calls.activate.length, 1);
    const msgs = third.calls.activate[0].notification.messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].body, 'второе');
    assert.ok(String(msgs[0].id) > String(knockedTo), 'shown is what arrived after the previous knock');
  });
});

test('a stall is written to the journal and does not activate the owner', async (t) => {
  const task = newTask();
  const stall = { state: 'alive', busy: false, stall: { kind: 'permission', reason: 'permission prompt' }, id: 'id-a' };
  const driver = fakeDriver('fake', { view: (ref) => (ref === 'sess-a' ? stall : { state: 'alive', busy: false, stall: null, id: null }) });
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a', started: '2020-01-01T00:00:00.000Z' });
  put(task, bus.ORCHESTRATOR, { harness: 'fake', sessionRef: 'sess-o' });
  bus.writeWake(home, task, bus.ORCHESTRATOR, { socket: path.join(SB, 'orch.sock') });
  const snap = bus.snapshotSessions(engine.readTask(task).participants, registry);

  const first = await bus.stallRound(home, task, { sessions: snap });
  await t.test('a stall does not spawn activate, and the record names the participant', () => {
    assert.equal(driver.calls.activate.length, 0);
    assert.equal(first.length, 1);
    assert.equal(first[0].address, 'worker:a');
    assert.equal(first[0].kind, 'permission');
    assert.equal(first[0].reason, 'permission prompt');
    assert.equal(first[0].id, 'id-a');
  });
  const wasCalls = driver.calls.activate.length;
  await bus.stallRound(home, task, { sessions: snap });
  await t.test('the same stall is not written a second time', () => {
    assert.equal(driver.calls.activate.length, wasCalls);
    assert.match(readFileSync(bus.stallsFile(home, task), 'utf8'), /permission prompt/);
  });
});

test('without a contact point the mark is set at once — there is nothing to deliver', async () => {
  const task = newTask();
  const driver = fakeDriver('fake', {
    reply: () => ({ ok: false, error: 'socket did not reply' }),
    view: (ref) => (ref === 'sess-a'
      ? { state: 'alive', busy: false, stall: { kind: 'permission', reason: 'permission prompt' }, id: 'id-a' }
      : { state: 'alive', busy: false, stall: null, id: null }),
  });
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a', started: '2020-01-01T00:00:00.000Z' });
  put(task, bus.ORCHESTRATOR, { harness: 'fake', sessionRef: 'sess-o' });
  const snap = bus.snapshotSessions(engine.readTask(task).participants, registry);
  const events = await bus.stallRound(home, task, { sessions: snap });
  assert.equal(driver.calls.activate.length, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].address, 'worker:a');
  assert.equal(events[0].kind, 'permission');
  assert.match(readFileSync(bus.stallsFile(home, task), 'utf8'), /permission prompt/);
});

test('a pull-driver on the owner address: the stall is also without activate', async () => {
  const task = newTask();
  const driver = fakeDriver('fake', {
    activation: 'pull',
    view: (ref) => (ref === 'sess-a'
      ? { state: 'alive', busy: false, stall: { kind: 'permission', reason: 'permission prompt' }, id: 'id-a' }
      : { state: 'alive', busy: false, stall: null, id: null }),
  });
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a', started: '2020-01-01T00:00:00.000Z' });
  put(task, bus.ORCHESTRATOR, { harness: 'fake', sessionRef: 'sess-o' });
  bus.writeWake(home, task, bus.ORCHESTRATOR, { socket: path.join(SB, 'pull-orch.sock') });
  const snap = bus.snapshotSessions(engine.readTask(task).participants, registry);
  const events = await bus.stallRound(home, task, { sessions: snap });
  assert.equal(driver.calls.activate.length, 0, 'a stall does not wake');
  assert.equal(events.length, 1);
  assert.equal(events[0].address, 'worker:a');
  assert.match(readFileSync(bus.stallsFile(home, task), 'utf8'), /permission prompt/);
});

// --- measured constants ----------------------------------------------------

test('the state-machine intervals are the same numbers that were in the CLI warden', () => {
  assert.equal(bus.TICK_MS, 1000);
  assert.equal(bus.KNOCK_RETRY_SEC, 120);
  assert.equal(bus.SILENCE_SEC, 900);
  assert.equal(bus.WARDEN_TOTAL_SEC, 6 * 3600);
  assert.equal(bus.ROUND_FAIL_LIMIT, 3);
  assert.equal(bus.SPAWN_GRACE_SEC, 30);
});

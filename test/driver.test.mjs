// Contract suite driver'ов и машины состояний надзирателя. Запуск — `npm test`.
//
// Driver'ы здесь ПОДСТАВНЫЕ, и это не экономия, а предмет проверки: контракт обязан
// держаться на harness'е, которого не существует. Настоящие driver'ы живут в `lib/`,
// их собственные ветки — сокет, реестр сессий, отказ бинаря — проверяются отдельно.
//
// Четыре рода driver'а покрыты подставными: push (будит сам), pull (организует свой
// polling), managed (сессию поднял он) и attached (сессия подключилась сама).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const bus = await import('../dist/index.js');

// Routing policy обязательна при открытии engine, и правило её — дело adapter'а: здесь
// adapter'а нет, и его играет набор. Правило «worker'у нельзя писать worker'у»
// живёт у потребителя и проверяется там.
const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-driver-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const home = path.join(SB, 'ws', '.promptobus');
const engine = bus.openEngine({ home, policy: () => ({ allow: true }) });

// Adapter'а здесь нет, и его играет набор: перевод адреса в запись участника v1 — его дело,
// и делает он его теми же правилами, что дверь механизма (`lib/store.js`).
// Адрес лежит полем `metadata`: по нему участника называет notification и по нему ключуются
// health, contact point'ы и отметки стопа.
function rec(address, { harness = 'fake', mode, sessionRef = null, ...fields } = {}) {
  return {
    id: bus.addrDir(address),
    role: bus.roleOf(address),
    harness: (typeof harness === 'string' && harness.trim()) || 'fake',
    // Режим отдаётся КАК ЕСТЬ: контракт driver'а обязан пережить и опечатку, и мусор в
    // поле — запись правят руками, а «раз не attached, значит managed» гасило бы сессию,
    // которую driver не поднимал. Схема store такую запись не примет, и здесь она в store
    // не кладётся: предикат спрашивают о записи, которую подал вызывающий.
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

// Подставной driver: capabilities объявляются, операции считают вызовы. `activate`
// возвращает то, что положили в `reply`, — им и проверяется, что отказ одного участника
// круг не уносит.
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
    // Свойства harness'а объявляются ОТДЕЛЬНО от операций и по умолчанию их нет
    // вовсе: driver прежней редакции контракта их не знает, и читаться он обязан как
    // «не умеет», а не как «наверное, умеет».
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
  if (!omit.includes('stop')) d.stop = (ref) => { calls.stop.push(ref); return { ok: true, stopped: true, note: 'закрыта' }; };
  return d;
}

// Отказ асинхронной операции: `stopParticipant` отдаёт обещание, и синхронный
// `try` прошёл бы мимо отказа с исходом «не бросило».
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

// --- registry: карта harness → driver ----------------------------------------

test('registry собирается только из driver’ов, выполняющих контракт', () => {
  const bad = thrown(() => bus.createRegistry({ drivers: { fake: { id: 'fake' } } }));
  assert.equal(bad.name, 'GateError');
  assert.match(bad.msg, /без id или capabilities/);
  const noFallback = thrown(() => bus.createRegistry({ drivers: { fake: fakeDriver('fake') }, fallback: 'other' }));
  assert.equal(noFallback.name, 'GateError');
  assert.match(noFallback.msg, /fallback/);
});

test('неизвестный harness отказывает и называет известные', () => {
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake') } });
  const r = thrown(() => bus.driverFor(registry, 'cursor'));
  assert.equal(r.name, 'GateError');
  assert.match(r.msg, /«cursor» неизвестен/);
  assert.match(r.msg, /известные: fake/);
});

test('harness записи прежнего CLI берётся из fallback, а непустой незнакомый — нет', () => {
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake') }, fallback: 'fake' });
  // Поля `harness` нет вовсе — это запись, сделанная до того, как поле появилось.
  assert.equal(bus.harnessOf(rec('worker:a'), registry), 'fake');
  assert.equal(bus.driverFor(registry, bus.harnessOf(rec('worker:a'), registry)).id, 'fake');
  // Пустая строка — тоже «не назван»: пробелы не делают harness именем.
  assert.equal(bus.harnessOf(rec('worker:a', { harness: '  ' }), registry), 'fake');
  // А вот непустое незнакомое имя fallback не спасает: это заявленный harness, и он чужой.
  assert.equal(thrown(() => bus.driverFor(registry, bus.harnessOf({ harness: 'cursor' }, registry))).name, 'GateError');
  // Без fallback запись без harness тоже отказывает — молча её никому не приписывают.
  const strict = bus.createRegistry({ drivers: { fake: fakeDriver('fake') } });
  assert.match(thrown(() => bus.driverFor(strict, bus.harnessOf({}, strict))).msg, /не назван/);
});

test('capability спрашивается и как объявление, и как операция', () => {
  const declared = fakeDriver('fake', { stop: false });
  assert.match(thrown(() => bus.requireCapability(declared, 'stop')).msg, /не умеет stop/);
  // Объявил, а операции нет — тот же отказ: для вызывающего они неразличимы.
  const lying = fakeDriver('fake', { stop: true, omit: ['stop'] });
  assert.match(thrown(() => bus.requireCapability(lying, 'stop')).msg, /объявил stop, но операции/);
});

// --- свойства harness'а: флаги без своей операции -------------------

test('свойство harness\'а спрашивается флагом, а не наличием операции', () => {
  const full = fakeDriver('fake', {
    features: { denyTools: true, systemPrompt: true, sessionList: true, enter: true },
  });
  for (const feature of ['denyTools', 'systemPrompt', 'sessionList', 'enter']) {
    assert.equal(bus.hasFeature(full, feature), true, feature);
  }
  // Объявлено ложью — «не умеет», и это тот случай, ради которого флаг заведён: read-only
  // участника у такого harness'а не бывает вовсе.
  const half = fakeDriver('fake', { features: { denyTools: false, sessionList: true } });
  assert.equal(bus.hasFeature(half, 'denyTools'), false);
  assert.equal(bus.hasFeature(half, 'sessionList'), true);
  // Флага нет ВОВСЕ — driver прежней редакции контракта. Читается как «не умеет»:
  // молчаливое «наверное, умеет» и есть то, от чего флаг сторожит.
  const old = fakeDriver('fake');
  for (const feature of ['denyTools', 'systemPrompt', 'sessionList', 'enter']) {
    assert.equal(bus.hasFeature(old, feature), false, feature);
  }
});

test('снимок capabilities несёт новые флаги, а запись прежней редакции читается без них', () => {
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
  // Запись, сделанную ДО расширения контракта, схема обязана принимать как есть: такие
  // лежат в живых журналах, и потребуй она новых полей, задача прошлого релиза перестала
  // бы читаться целиком — вместе с участниками, mailbox'ами и уборкой за ней.
  const { meta: old } = bus.openParticipant(home, task,
    rec('worker:b', { harness: 'fake', sessionRef: 'sess-b' }), bus.createRegistry({
      drivers: { fake: fakeDriver('fake') },
    }));
  const q = old.participants.find((x) => bus.addressOf(x) === 'worker:b');
  assert.deepEqual(Object.keys(q.capabilities).sort(),
    ['activation', 'attach', 'inspect', 'spawn', 'stop']);
  // И прочитан такой журнал целиком, а не «кроме этого участника».
  assert.equal(engine.readTask(task).participants.length, old.participants.length);
});

// --- managed и attached: запись участника ------------------------------------

test('managed: запись участника несёт harness, режим, ref и снимок capabilities', () => {
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

test('attached: сессия подключилась сама, и требуется своя capability', () => {
  const task = newTask();
  const pushOnly = bus.createRegistry({ drivers: { fake: fakeDriver('fake', { attach: false }) } });
  const refused = thrown(() => bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake', sessionRef: 'sess-a' }), pushOnly, { mode: 'attached' }));
  assert.match(refused.msg, /не умеет attach/);
  const withAttach = bus.createRegistry({ drivers: { fake: fakeDriver('fake', { attach: true }) } });
  const { meta } = bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake', sessionRef: 'sess-a' }), withAttach, { mode: 'attached' });
  assert.equal(meta.participants.find((x) => bus.addressOf(x) === 'worker:a').mode, 'attached');
});

test('неизвестный harness отказывает ДО записи participant', () => {
  const task = newTask();
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake') } });
  const before = readFileSync(engine.taskFile(task), 'utf8');
  const r = thrown(() => bus.openParticipant(home, task,
    rec('worker:a', { harness: 'cursor', sessionRef: 'sess-a' }), registry));
  assert.equal(r.name, 'GateError');
  assert.equal(readFileSync(engine.taskFile(task), 'utf8'), before, 'журнал задачи не тронут');
  assert.equal(engine.readTask(task).participants.some((p) => bus.addressOf(p) === 'worker:a'), false);
});

test('необъявленная capability отказывает ДО записи participant', () => {
  const task = newTask();
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake', { spawn: false }) } });
  const before = readFileSync(engine.taskFile(task), 'utf8');
  assert.match(thrown(() => bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake', sessionRef: 'sess-a' }), registry)).msg, /не умеет spawn/);
  assert.equal(readFileSync(engine.taskFile(task), 'utf8'), before, 'журнал задачи не тронут');
});

test('участник без session reference отказывает тем же порядком', () => {
  const task = newTask();
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake') } });
  const before = readFileSync(engine.taskFile(task), 'utf8');
  assert.match(thrown(() => bus.openParticipant(home, task,
    rec('worker:a', { harness: 'fake' }), registry)).msg, /session reference/);
  assert.equal(readFileSync(engine.taskFile(task), 'utf8'), before);
});

test('stop гасит только managed: attached отказывает режимом, а не capability', async () => {
  const driver = fakeDriver('fake', { attach: true, stop: true });
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  const managed = rec('worker:a', { harness: 'fake', mode: 'managed', sessionRef: 'sess-a' });
  const attached = rec('worker:b', { harness: 'fake', mode: 'attached', sessionRef: 'sess-b' });
  // Исход гашения `await`'ится: driver вправе дождаться, пока сессии у harness'а не станет,
  // и синхронное чтение поля прошло бы мимо обещания.
  assert.equal((await bus.stopParticipant(managed, registry)).ok, true);
  assert.deepEqual(driver.calls.stop, ['sess-a']);
  const refused = await rejected(() => bus.stopParticipant(attached, registry));
  assert.equal(refused.name, 'GateError');
  assert.match(refused.msg, /режим «attached»/);
  assert.match(refused.msg, /не поднимал/);
  assert.deepEqual(driver.calls.stop, ['sess-a'], 'до driver’а attached не дошёл');
  // Запись прежнего CLI режима не несёт вовсе — её сессию поднимал подъём, и она managed.
  assert.equal(bus.modeOf(rec('worker:c', { sessionRef: 'sess-c' })), 'managed');
  assert.equal(bus.isManaged(rec('worker:c', { sessionRef: 'sess-c' })), true);
  // Owner задачи session reference не несёт: режима у него нет, гасить нечего.
  assert.equal(bus.modeOf(rec(bus.ORCHESTRATOR)), null);
  assert.equal(bus.isManaged(rec(bus.ORCHESTRATOR)), false);
  assert.equal((await bus.stopParticipant(managed, registry)).stopped, true, 'исход «погасил» отличим от «гасить нечего»');
});

test('незнакомый режим за managed не считается — ни опечатка в регистре, ни мусор', async () => {
  const driver = fakeDriver('fake', { stop: true });
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  // «Раз не attached, значит managed» гасило бы сессию, которую driver не поднимал: у поля,
  // правленного руками, значение бывает и опечаткой, и мусором.
  for (const mode of ['Attached', 'MANAGED', 'что-то своё', 'managed ']) {
    const p = rec('worker:a', { harness: 'fake', mode, sessionRef: 'sess-a' });
    const known = mode.trim() === 'managed';
    assert.equal(bus.isManaged(p), known, `mode=${JSON.stringify(mode)}`);
    if (known) continue;
    const r = await rejected(() => bus.stopParticipant(p, registry));
    assert.equal(r.name, 'GateError', `mode=${JSON.stringify(mode)}`);
    assert.match(r.msg, /контракт не знает|режим «attached»/);
  }
  assert.deepEqual(driver.calls.stop, [], 'до driver’а незнакомый режим не дошёл');
  // Поля нет вовсе — законное умолчание: так писал участников прежний CLI.
  assert.equal(bus.isManaged(rec('worker:a', { sessionRef: 'sess-a' })), true);
  assert.equal(bus.isManaged(rec('worker:a', { mode: '  ', sessionRef: 'sess-a' })), true);
});

test('driver без capability stop отказывает до вызова, даже managed-участнику', async () => {
  const driver = fakeDriver('fake', { stop: false, omit: ['stop'] });
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  const r = await rejected(() => bus.stopParticipant(
    rec('worker:a', { harness: 'fake', mode: 'managed', sessionRef: 'sess-a' }), registry));
  assert.equal(r.name, 'GateError');
  assert.match(r.msg, /не умеет stop/);
});

// --- inspect: снимок сессий --------------------------------------------------

test('снимок собирается через registry и ключуется адресом участника', () => {
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
  // Owner задачи session reference не несёт — в снимке его нет вовсе, и это не «исчез».
  assert.equal(Object.hasOwn(snap, bus.ORCHESTRATOR), false);
  assert.equal(bus.liveParticipant(rec(bus.ORCHESTRATOR), snap), 'unknown');
});

test('driver не разобрал состояние — снимка нет целиком', () => {
  const task = newTask();
  const registry = bus.createRegistry({ drivers: { fake: fakeDriver('fake', { view: () => null }) } });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a' });
  assert.equal(bus.snapshotSessions(engine.readTask(task).participants, registry), null);
  // Неизвестность — не смерть: перечень вставших её не выдумывает.
  assert.equal(bus.blockedParticipants(home, task, engine.readTask(task).participants, null), null);
});

// --- неизвестность: спросить некого ------------------------------------------
//
// Два рода участника, о котором спросить нечем: driver'а по его harness'у в карте нет и
// driver есть, но `inspect` не объявлен. Оба обязаны читаться как НЕИЗВЕСТНОСТЬ, а не как
// смерть: приняв их за мёртвых, механизм гасит слушателя живой задачи, докладывает «ИСЧЕЗ»
// о работающей сессии и сносит её конфиг уборкой.

test('чужой harness не роняет снимок, а даёт этому участнику неизвестность', () => {
  const task = newTask();
  const driver = fakeDriver('fake');
  const registry = bus.createRegistry({ drivers: { fake: driver } });
  put(task, 'worker:a', { harness: 'cursor', sessionRef: 'sess-a', started: '2020-01-01T00:00:00.000Z' });
  put(task, 'worker:b', { harness: 'fake', sessionRef: 'sess-b', started: '2020-01-01T00:00:00.000Z' });
  const ps = engine.readTask(task).participants;
  const snap = bus.snapshotSessions(ps, registry);
  assert.equal(snap['worker:a'].state, 'unknown', 'снимок собрался, а не бросил');
  assert.equal(snap['worker:b'].state, 'alive');
  assert.equal(bus.liveParticipant(ps.find((p) => bus.addressOf(p) === 'worker:a'), snap), 'unknown');
  // Неизвестного не гасят и о нём не докладывают.
  assert.ok(bus.liveWatched(home, task, snap).includes('worker:a'));
  assert.deepEqual(bus.blockedParticipants(home, task, ps, snap), []);
});

test('driver без inspect — тоже неизвестность: живую сессию за мёртвую не выдают', (t) => {
  const task = newTask();
  const blind = fakeDriver('blind', { inspect: false, omit: ['inspect'] });
  const registry = bus.createRegistry({ drivers: { blind }, fallback: 'blind' });
  put(task, 'worker:a', { harness: 'blind', sessionRef: 'sess-a', started: '2020-01-01T00:00:00.000Z' });
  const ps = engine.readTask(task).participants;
  const snap = bus.snapshotSessions(ps, registry);
  assert.equal(snap['worker:a'].state, 'unknown');
  assert.equal(bus.liveParticipant(ps[0], snap), 'unknown');
  assert.deepEqual(bus.blockedParticipants(home, task, ps, snap), [], 'доклада «ИСЧЕЗ» нет');
  assert.deepEqual(bus.liveWatched(home, task, snap), ['worker:a'], 'из живых не выброшен');
  return t.test('надзиратель живой задачи не гаснет', () => {
    // Место надзирателя занимается по-настоящему: `beatRound` первым делом продлевает свою
    // отметку, и без неё он вышел бы по «место занял другой процесс», а не по пустоте.
    bus.claimWarden(home, task);
    assert.equal(bus.beatRound(home, task, Date.now(), { sessions: snap }), null);
  });
});

// --- доклад о стопе несёт harness записи ----------------------------
//
// Маршрут по стопу — команда КОНКРЕТНОГО harness'а, и спрашивать её надо у того driver'а,
// который состояние и разобрал. Снимок к этому моменту уже собран, registry в разбор не
// подаётся вовсе, поэтому harness едет полем самой записи о стопе.

test('запись о стопе называет harness участника — по нему потребитель берёт driver маршрута', () => {
  const task = newTask();
  const stall = { state: 'alive', busy: false, stall: { kind: 'permission', reason: 'диалог' }, id: 'id-a' };
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
  // Записи прежнего CLI поля `harness` не несут вовсе — тогда `null`, и потребитель берёт
  // `fallback` своего registry. Выдумывать за них имя нельзя: чужое повело бы маршрут к
  // driver'у, который эту сессию не поднимал.
  const legacy = [{ ...ps.find((x) => bus.addressOf(x) === 'worker:a'), harness: undefined }];
  const legacySnap = { 'worker:a': stall };
  assert.equal(bus.blockedParticipants(home, task, legacy, legacySnap)[0].harness, null);
});

// --- push: активация через driver --------------------------------------------

test('push-driver будит адресата непрочитанного, и notification несёт выжимки', async (t) => {
  const task = newTask();
  const driver = fakeDriver('fake');
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a' });
  bus.writeWake(home, task, 'worker:a', { socket: path.join(SB, 'a.sock') });
  send(task, 'worker:a', 'task', 'первое');

  const r = await bus.supervisorRound(home, task, { registry });
  await t.test('стук ушёл один и адресату', () => {
    assert.equal(driver.calls.activate.length, 1);
    assert.equal(driver.calls.activate[0].target.ref, 'sess-a');
    assert.equal(driver.calls.activate[0].target.endpoint.socket, path.join(SB, 'a.sock'));
  });
  await t.test('notification несёт задачу, адрес, счётчик и тела сообщений', () => {
    const n = driver.calls.activate[0].notification;
    assert.equal(n.kind, 'unread');
    assert.equal(n.task, task);
    assert.equal(n.address, 'worker:a');
    assert.equal(n.unread, 1);
    assert.equal(n.messages.length, 1);
    assert.equal(n.messages[0].body, 'первое');
    assert.equal(n.messages[0].type, 'task');
    assert.equal(n.messages[0].from, bus.ORCHESTRATOR);
    assert.ok(n.messages[0].id, 'у выжимки есть id — по нему идёт отсечка повтора');
  });
  await t.test('событие круга названо', () => {
    assert.ok(r.events.some((e) => /notification worker:a/.test(e)), r.events.join('\n'));
  });
});

test('pull-driver не будит вовсе, но непрочитанное у него видно', async () => {
  const task = newTask();
  const driver = fakeDriver('fake', { activation: 'pull' });
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a' });
  bus.writeWake(home, task, 'worker:a', { socket: path.join(SB, 'pull.sock') });
  send(task, 'worker:a', 'task', 'лежит');

  await bus.supervisorRound(home, task, { registry });
  assert.equal(driver.calls.activate.length, 0, 'pull-driver сессию не будит');
  const h = bus.readHealth(home, task)['worker:a'];
  assert.equal(h.unread, 1);
  assert.equal(h.channel, 'pull');
  // Молчание такого участника видно тем же порогом, что и у push: канал ни при чём.
  const late = Date.now() + (bus.SILENCE_SEC + 60) * 1000;
  const r = await bus.supervisorRound(home, task, { registry, now: late });
  assert.ok(r.events.some((e) => /МОЛЧИТ worker:a/.test(e)), r.events.join('\n'));
});

test('отказ активации одного участника не мешает остальным', async (t) => {
  const task = newTask();
  const driver = fakeDriver('fake', {
    reply: (target) => {
      if (target.ref === 'sess-a') throw new Error('канал оборван');
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
  await t.test('оба участника обойдены, круг не оборван', () => {
    assert.equal(driver.calls.activate.length, 2);
    assert.equal(r.stop, null);
  });
  await t.test('упавшему записан откат канала с причиной', () => {
    const h = bus.readHealth(home, task);
    assert.equal(h['worker:a'].channel, 'self-wake');
    assert.equal(h['worker:a'].knockError, 'канал оборван');
    // Удавшийся стук пишет `options.knockChannel`; у подставного driver'а по умолчанию
    // это `socket`, как у Claude Code.
    assert.equal(h['worker:b'].channel, 'socket');
    assert.equal(h['worker:b'].knocks, 1);
    // Журнал отказа для канала `socket` по-прежнему слово «сокет» — форма Claude Code.
    assert.ok(r.events.some((e) => /сокет не принял notification \(канал оборван\)/.test(e)),
      r.events.join('\n'));
  });
});

test('удавшийся стук пишет knockChannel driver’а, а не литерал socket', async () => {
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

test('отказ стука пишет knockChannel driver’а, а не литерал «сокет»', async () => {
  const task = newTask();
  const inject = fakeDriver('cursor-like', {
    knockChannel: 'inject',
    reply: () => ({ ok: false, error: 'канал оборван' }),
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
  assert.ok(r.events.some((e) => /worker:a: inject не принял notification \(канал оборван\)/.test(e)),
    r.events.join('\n'));
  assert.ok(r.events.some((e) => /worker:b: rpc не принял notification \(holder gone\)/.test(e)),
    r.events.join('\n'));
  assert.ok(!r.events.some((e) => /сокет не принял/.test(e)), r.events.join('\n'));
});

test('участник с неизвестным harness не уносит круг, а остаётся строкой в журнале', async () => {
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
  assert.equal(driver.calls.activate.length, 1, 'знакомый harness разбужен');
  const h = bus.readHealth(home, task);
  assert.equal(h['worker:a'].channel, 'no-driver');
  assert.match(String(h['worker:a'].knockError), /«cursor» неизвестен/);
  assert.ok(r.events.some((e) => /будить нечем worker:a/.test(e)), r.events.join('\n'));
});

// --- состояние переживает смерть процесса ------------------------------------

test('надзиратель упал и поднялся заново — состояние на месте, второго стука нет', async (t) => {
  const task = newTask();
  const sock = path.join(SB, 'restart.sock');
  const first = fakeDriver('fake');
  const registry = (d) => bus.createRegistry({ drivers: { fake: d }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a' });
  bus.writeWake(home, task, 'worker:a', { socket: sock });
  send(task, 'worker:a', 'task', 'первое');
  await bus.supervisorRound(home, task, { registry: registry(first) });
  const knockedTo = bus.readHealth(home, task)['worker:a'].knockedTo;

  // «Перезапуск»: свежий driver и свежий registry, как после смерти процесса. Своего
  // состояния у надзирателя нет — всё, что он знал, лежит в store задачи.
  const second = fakeDriver('fake');
  await bus.supervisorRound(home, task, { registry: registry(second) });
  await t.test('порог перестука пережил перезапуск — второго стука нет', () => {
    assert.equal(second.calls.activate.length, 0);
    assert.equal(bus.readHealth(home, task)['worker:a'].knocks, 1);
  });

  send(task, 'worker:a', 'status', 'второе');
  const third = fakeDriver('fake');
  await bus.supervisorRound(home, task, { registry: registry(third) });
  await t.test('отсечка повтора тоже пережила: в notification только новое', () => {
    assert.equal(third.calls.activate.length, 1);
    const msgs = third.calls.activate[0].notification.messages;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].body, 'второе');
    assert.ok(String(msgs[0].id) > String(knockedTo), 'показано то, что пришло после прошлого стука');
  });
});

test('стоп пишется в журнал и не активирует owner’а', async (t) => {
  const task = newTask();
  const stall = { state: 'alive', busy: false, stall: { kind: 'permission', reason: 'permission prompt' }, id: 'id-a' };
  const driver = fakeDriver('fake', { view: (ref) => (ref === 'sess-a' ? stall : { state: 'alive', busy: false, stall: null, id: null }) });
  const registry = bus.createRegistry({ drivers: { fake: driver }, fallback: 'fake' });
  put(task, 'worker:a', { harness: 'fake', sessionRef: 'sess-a', started: '2020-01-01T00:00:00.000Z' });
  put(task, bus.ORCHESTRATOR, { harness: 'fake', sessionRef: 'sess-o' });
  bus.writeWake(home, task, bus.ORCHESTRATOR, { socket: path.join(SB, 'orch.sock') });
  const snap = bus.snapshotSessions(engine.readTask(task).participants, registry);

  const first = await bus.stallRound(home, task, { sessions: snap });
  await t.test('стоп не рождает activate, а запись несёт участника', () => {
    assert.equal(driver.calls.activate.length, 0);
    assert.equal(first.length, 1);
    assert.equal(first[0].address, 'worker:a');
    assert.equal(first[0].kind, 'permission');
    assert.equal(first[0].reason, 'permission prompt');
    assert.equal(first[0].id, 'id-a');
  });
  const wasCalls = driver.calls.activate.length;
  await bus.stallRound(home, task, { sessions: snap });
  await t.test('тот же стоп второй раз не пишется', () => {
    assert.equal(driver.calls.activate.length, wasCalls);
    assert.match(readFileSync(bus.stallsFile(home, task), 'utf8'), /permission prompt/);
  });
});

test('без contact point отметка ставится сразу — доставлять нечего', async () => {
  const task = newTask();
  const driver = fakeDriver('fake', {
    reply: () => ({ ok: false, error: 'сокет не ответил' }),
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

test('pull-driver на адресе owner’а: стоп тоже без activate', async () => {
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
  assert.equal(driver.calls.activate.length, 0, 'стоп не будит');
  assert.equal(events.length, 1);
  assert.equal(events[0].address, 'worker:a');
  assert.match(readFileSync(bus.stallsFile(home, task), 'utf8'), /permission prompt/);
});

// --- измеренные константы ----------------------------------------------------

test('интервалы машины состояний — те же числа, что были в надзирателе CLI', () => {
  assert.equal(bus.TICK_MS, 1000);
  assert.equal(bus.KNOCK_RETRY_SEC, 120);
  assert.equal(bus.SILENCE_SEC, 900);
  assert.equal(bus.WARDEN_TOTAL_SEC, 6 * 3600);
  assert.equal(bus.ROUND_FAIL_LIMIT, 3);
  assert.equal(bus.SPAWN_GRACE_SEC, 30);
});

// Engine protocol v1 (`BL-409`): задача и участники, fan-out с восстановлением, mailbox и
// history, content-addressed артефакты, изоляция повреждённого.
//
// Ни CLI, ни рабочего места, ни harness'а здесь нет вовсе — и это предмет проверки наравне
// с остальным: core обязан работать без них (ADR-032, §2). Всё, что engine знает о внешнем
// мире, приходит двумя аргументами открытия — корень и routing policy.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  ERROR_CODES, MECHANISM_VERSION_FIELD, openEngine, PromptobusError, validate,
} from '../dist/index.js';
// Единственный глубокий импорт в наборе, и он нужен ровно одной проверке ниже: `commitIntent`
// принимает готовую запись, то есть даёт назвать id заранее, а через `openEngine` его собирает
// сам движок со случайным хвостом. Наружу package этот модуль не отдаёт — entry point'ов у
// него три, и проверка их не расширяет.
import { commitIntent } from '../dist/v1/messages.js';

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-v1-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const CAPS = { spawn: true, attach: true, activation: 'push', inspect: true, stop: true };

// Роль объявлена ПОЛЕМ, а не выведена из id: `w-api` здесь worker только потому, что так
// написано в записи. Это и есть то, что v1 разводит по сравнению с адресом `worker:<слаг>`.
const person = (id, role, extra = {}) => ({
  id,
  role,
  harness: 'fake',
  mode: 'managed',
  sessionRef: `sess-${id}`,
  capabilities: CAPS,
  metadata: {},
  ...extra,
});

// Подставная policy: правило ATI «worker → worker запрещён» живёт у adapter'а, здесь оно
// стоит образцом — core своих ролей не знает.
const noWorkerToWorker = (sender, recipient) => (
  sender.role === 'worker' && recipient.role === 'worker'
    ? { deny: true, reason: `worker'ам между собой писать нельзя` }
    : { allow: true }
);

const allowAll = () => ({ allow: true });

// Незакрытые fan-out'ы задачи. Считаются записи intent'ов, а не содержимое каталога: рядом
// с каждой лежит лизинг владельца `<id>.owner` (`BL-447`).
const openIntents = (dir) => readdirSync(dir).filter((n) => n.endsWith('.json'));

let sandboxes = 0;
function sandbox() {
  sandboxes += 1;
  const root = path.join(SB, `root-${sandboxes}`);
  mkdirSync(root, { recursive: true });
  return root;
}

// Часы шагают на секунду за вызов: id сообщений сортируются порядком отправки, и штампы
// прогона не зависят от того, насколько быстра машина.
function clock(from = '2026-09-02T10:00:00.000Z') {
  let ms = Date.parse(from);
  return () => {
    ms += 1000;
    return new Date(ms);
  };
}

/** Задача с owner'ом и двумя worker'ами. Owner — такой же participant, с harness и режимом. */
function taskWith(engine, id = 'demo-t20260902-100000') {
  engine.createTask({ id, title: 'демо', owner: person('owner', 'orchestrator', { mode: 'attached' }) });
  engine.addParticipant(id, person('w-api', 'worker'));
  engine.addParticipant(id, person('w-docs', 'worker'));
  return id;
}

function open(root, options = {}) {
  return openEngine({ root, policy: allowAll, now: clock(), ...options });
}

// Отказ engine: код вместо разбора текста. Человеческий текст — дело adapter'а, и сверять
// его здесь значило бы прибивать к набору то, чего в контракте нет.
function refusal(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

async function refusalAsync(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
}

// ── Открытие engine ───────────────────────────────────────────────────────────────────

test('routing policy обязательна при открытии, а не при первой отправке', () => {
  const e = refusal(() => openEngine({ root: sandbox() }));
  assert.ok(e instanceof PromptobusError);
  assert.equal(e.code, 'policy-required');
  // Отказ до первой отправки — весь смысл: engine, у которого правило появится потом, до
  // тех пор пропускает всё.
  assert.equal(refusal(() => openEngine({ root: sandbox(), policy: 'нет' })).code, 'policy-required');
});

test('store лежит в <root>/.promptobus, и корень package не ищет', () => {
  const root = sandbox();
  assert.equal(open(root).home, path.join(root, '.promptobus'));
});

// ── Задача и участники ────────────────────────────────────────────────────────────────

test('owner задачи — такой же participant: harness, режим, sessionRef и capabilities', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const meta = engine.readTask(id);
  const owner = meta.participants.find((p) => p.id === meta.owner);
  assert.equal(meta.owner, 'owner');
  assert.equal(owner.harness, 'fake');
  assert.equal(owner.mode, 'attached');
  assert.equal(owner.sessionRef, 'sess-owner');
  assert.deepEqual(owner.capabilities, CAPS);
});

test('участник без harness не заводится: fallback\'а в v1 нет вовсе', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const { harness, ...noHarness } = person('w-null', 'worker');
  const e = refusal(() => engine.addParticipant(id, noHarness));
  assert.equal(e.code, 'schema-invalid');
  assert.deepEqual(engine.readTask(id).participants.map((p) => p.id), ['owner', 'w-api', 'w-docs']);
});

test('обновление участника — patch по полям, а не замена записи целиком', async (t) => {
  // Инвариант legacy `upsertParticipant` («второй вызов обязан класть обратно ту же запись»)
  // в v1 не повторяется: там дописывающий одно поле терял поля первого вызова молча
  // (находка `BL-408`).
  const engine = open(sandbox());
  const id = taskWith(engine);
  engine.patchParticipant(id, 'w-api', { metadata: { repo: 'ns/repo' } });
  engine.patchParticipant(id, 'w-api', { sessionRef: 'sess-restarted' });
  const p = engine.readTask(id).participants.find((x) => x.id === 'w-api');
  await t.test('patch: поле первого вызова пережило второй', () => {
    assert.deepEqual(p.metadata, { repo: 'ns/repo' });
    assert.equal(p.sessionRef, 'sess-restarted');
    assert.equal(p.harness, 'fake');
  });
  await t.test('patch: ломающий схему отказывает ДО записи журнала', () => {
    const before = readFileSync(path.join(engine.home, 'tasks', id, 'task.json'), 'utf8');
    assert.equal(refusal(() => engine.patchParticipant(id, 'w-api', { mode: 'detached' })).code, 'schema-invalid');
    assert.equal(readFileSync(path.join(engine.home, 'tasks', id, 'task.json'), 'utf8'), before);
  });
});

test('owner меняется только явным claim и возвращает прежнего', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  assert.equal(engine.claimOwner(id, 'w-api'), 'owner');
  assert.equal(engine.readTask(id).owner, 'w-api');
  // Захват на участника, которого в задаче нет, — отказ, а не тихая смена владельца.
  assert.equal(refusal(() => engine.claimOwner(id, 'w-none')).code, 'participant-not-found');
});

test('задачу с тем же id заводит ровно один', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const e = refusal(() => engine.createTask({ id, title: 'вторая', owner: person('owner', 'orchestrator') }));
  assert.equal(e.code, 'task-exists');
  assert.equal(engine.readTask(id).title, 'демо');
});

// ── Prevalidation fan-out ─────────────────────────────────────────────────────────────

test('prevalidation: пустой список, дубли, незнакомый адресат и чужой тип', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const cases = [
    ['recipients-empty', { from: 'owner', to: [], type: 'task', body: 'a' }],
    ['recipients-duplicate', { from: 'owner', to: ['w-api', 'w-api'], type: 'task', body: 'a' }],
    ['participant-not-found', { from: 'owner', to: ['w-none'], type: 'task', body: 'a' }],
    ['participant-not-found', { from: 'w-none', to: ['w-api'], type: 'task', body: 'a' }],
    ['message-type-unknown', { from: 'owner', to: ['w-api'], type: 'notify', body: 'a' }],
    ['schema-invalid', { from: 'owner', to: ['w-api'], type: 'task', body: '' }],
  ];
  for (const [code, input] of cases) {
    await t.test(`prevalidation: ${code} на ${JSON.stringify(input.to)} ${input.type}`, async () => {
      const e = await refusalAsync(() => engine.send(id, input));
      assert.equal(e.code, code);
    });
  }
  await t.test('prevalidation: ни один отказ не тронул store', () => {
    assert.equal(engine.unread(id, 'w-api'), 0);
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'messages')));
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'intents')));
  });
});

test('в закрытую задачу не пишут, а читать её законно', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'до закрытия' });
  engine.closeTask(id);
  assert.equal((await refusalAsync(() => engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'после' }))).code,
    'task-closed');
  assert.equal(engine.read(id, 'w-api').messages.length, 1);
});

// ── Routing policy ────────────────────────────────────────────────────────────────────

test('routing denial срабатывает ДО артефактов и сообщений', async (t) => {
  const root = sandbox();
  const engine = openEngine({ root, policy: noWorkerToWorker, now: clock() });
  const id = taskWith(engine);
  const file = path.join(SB, 'denial.patch');
  writeFileSync(file, 'дифф, который не должен доехать\n');
  const e = await refusalAsync(() => engine.send(id, {
    from: 'w-api', to: ['w-docs'], type: 'artifact', body: 'дифф', artifact: { path: file },
  }));
  await t.test('routing denial: код и причина policy', () => {
    assert.equal(e.code, 'policy-denied');
    assert.equal(e.context.sender, 'w-api');
    assert.equal(e.context.recipient, 'w-docs');
    assert.match(e.context.reason, /worker/);
  });
  await t.test('routing denial: blob\'а в задаче не появилось', () => {
    // Порядок «policy → blob» и есть предмет: артефакт, положенный до проверки, остался бы
    // в задаче навсегда — blob'ы уходят только с `prune`.
    assert.equal(engine.orphanBlobs(id).length, 0);
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'blobs')));
  });
  await t.test('routing denial: ни сообщения, ни intent\'а', () => {
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'messages')));
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'intents')));
    assert.equal(engine.unread(id, 'w-docs'), 0);
  });
  await t.test('routing denial: разрешённое направление проходит', async () => {
    const sent = await engine.send(id, { from: 'w-api', to: ['owner'], type: 'result', body: 'готово' });
    assert.equal(sent.message.sender, 'w-api');
    assert.equal(engine.unread(id, 'owner'), 1);
  });
});

test('policy, вернувшая не решение, читается как отказ', async () => {
  const engine = openEngine({ root: sandbox(), policy: () => undefined, now: clock() });
  const id = taskWith(engine);
  const e = await refusalAsync(() => engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'a' }));
  assert.equal(e.code, 'policy-denied');
  assert.equal(engine.unread(id, 'w-api'), 0);
});

// ── Fan-out: доставка и события ───────────────────────────────────────────────────────

test('fan-out: одно каноническое сообщение и ссылка каждому получателю', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const { message, events } = await engine.send(id, {
    from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'сделай',
  });
  const taskRoot = path.join(engine.home, 'tasks', id);
  await t.test('fan-out: канон один', () => {
    assert.deepEqual(readdirSync(path.join(taskRoot, 'messages')), [`${message.id}.json`]);
  });
  await t.test('fan-out: intent снят после ссылок у всех', () => {
    assert.deepEqual(readdirSync(path.join(taskRoot, 'intents')), []);
  });
  await t.test('fan-out: ссылка у каждого получателя, у отправителя — ничего', () => {
    assert.equal(engine.unread(id, 'w-api'), 1);
    assert.equal(engine.unread(id, 'w-docs'), 1);
    assert.equal(engine.unread(id, 'owner'), 0);
  });
  await t.test('fan-out: ссылки и канон — один inode', () => {
    // Неизменяемость канона объявлена контрактом, а inode общий: содержимое не копируется,
    // и «ссылка» здесь — жёсткая ссылка, а не запись рядом.
    const ino = statSync(path.join(taskRoot, 'messages', `${message.id}.json`)).ino;
    for (const who of ['w-api', 'w-docs']) {
      assert.equal(statSync(path.join(taskRoot, 'inbox', who, `${message.id}.json`)).ino, ino);
    }
  });
  await t.test('fan-out: события «кого будить» по получателю, с ref и выжимкой', () => {
    // Форма — та, которую примет `activate(target, notification)` driver'а: `ref` идёт в
    // target, остальное — в notification.
    assert.deepEqual(events.map((e) => e.address), ['w-api', 'w-docs']);
    assert.deepEqual(events.map((e) => e.ref), ['sess-w-api', 'sess-w-docs']);
    for (const e of events) {
      assert.equal(e.kind, 'unread');
      assert.equal(e.task, id);
      assert.equal(e.unread, 1);
      assert.deepEqual(e.messages, [{
        id: message.id, type: 'task', from: 'owner', ts: message.ts, body: 'сделай', artifact: null,
      }]);
    }
  });
});

test('отказ активации одного получателя не трогает fan-out и не мешает другим', async () => {
  // Активация — дело supervisor'а и driver'а: engine отдаёт список «кого будить». Здесь
  // проверяется контракт событий — что отказ одного не откатывает доставку и не уносит
  // остальных.
  const engine = open(sandbox());
  const id = taskWith(engine);
  const { events } = await engine.send(id, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'обоим' });
  const woken = [];
  for (const e of events) {
    try {
      if (e.address === 'w-api') throw new Error('сокет не принял notification');
      woken.push(e.address);
    } catch {
      // Ровно то, что делает supervisor: отказ — исход, а не исключение наружу.
    }
  }
  assert.deepEqual(woken, ['w-docs']);
  assert.equal(engine.unread(id, 'w-api'), 1, 'отказ активации не откатил доставку');
  assert.equal(engine.read(id, 'w-api').messages.length, 1);
});

// ── Crash в каждой точке fan-out ──────────────────────────────────────────────────────

// Падение изображается броском из шва: настоящее падение процесса набором посреди шага не
// воспроизводится, а состояние на диске остаётся то же самое. Что это не артефакт броска в
// одном процессе, проверяет [v1-races.test.mjs](v1-races.test.mjs) — там процесс и правда
// умирает посреди fan-out'а.
function crashAt(root, step, { at = 0 } = {}) {
  let seen = 0;
  return openEngine({
    root,
    policy: allowAll,
    now: clock(),
    recover: false,
    faults: (which) => {
      if (which !== step) return;
      seen += 1;
      if (seen > at) throw new Error(`падение в точке ${step}`);
    },
  });
}

const STEPS = ['validate', 'blob', 'artifact', 'intent', 'canonical', 'ref', 'close'];

test('crash в каждой точке fan-out и идемпотентное восстановление', async (t) => {
  for (const step of STEPS) {
    await t.test(`crash в точке ${step}: восстановление доводит доставку до конца`, async () => {
      const root = sandbox();
      const source = path.join(SB, `crash-${step}.patch`);
      writeFileSync(source, `содержимое для ${step}\n`);
      const broken = crashAt(root, step, { at: 0 });
      const id = taskWith(broken);
      const e = await refusalAsync(() => broken.send(id, {
        from: 'owner', to: ['w-api', 'w-docs'], type: 'artifact', body: 'дифф', artifact: { path: source },
      }));
      assert.match(e.message, new RegExp(`падение в точке ${step}`));

      // Открытие engine восстанавливает fan-out само — это первый из двух маршрутов
      // восстановления (второй — вызов `recover()` кругом надзирателя).
      const healed = openEngine({ root, policy: allowAll, now: clock() });
      const committed = ['intent', 'canonical', 'ref', 'close'].includes(step);
      if (committed) {
        assert.equal(healed.unread(id, 'w-api'), 1, `${step}: w-api`);
        assert.equal(healed.unread(id, 'w-docs'), 1, `${step}: w-docs`);
        assert.deepEqual(readdirSync(path.join(healed.home, 'tasks', id, 'intents')), [],
          `${step}: intent остался незакрытым`);
      } else {
        // До точки коммита сообщения не существует вовсе: отправка не вернулась, и
        // отправитель о нём не знает.
        assert.equal(healed.unread(id, 'w-api'), 0, `${step}: w-api`);
        assert.equal(healed.unread(id, 'w-docs'), 0, `${step}: w-docs`);
      }

      // Второй проход не делает ничего: восстановление идемпотентно по построению —
      // и канон, и каждая ссылка ставятся `link`'ом, а `EEXIST` значит «уже есть».
      const again = healed.recover(id);
      assert.deepEqual(again.repairs, [], `${step}: повторное восстановление что-то починило`);
      assert.deepEqual(again.events, [], `${step}: повторное восстановление кого-то будит`);
      assert.equal(healed.unread(id, 'w-api'), committed ? 1 : 0, `${step}: повтор изменил mailbox`);
    });
  }
});

test('crash после первой ссылки: вторая дописывается, первая не дублируется', async () => {
  const root = sandbox();
  // Падение ПОСЛЕ первой ссылки: у `w-api` она есть, у `w-docs` ещё нет.
  const broken = crashAt(root, 'ref', { at: 0 });
  const id = taskWith(broken);
  await refusalAsync(() => broken.send(id, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'обоим' }));
  assert.equal(broken.unread(id, 'w-api'), 1);
  assert.equal(broken.unread(id, 'w-docs'), 0);

  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  const { repairs, events } = healed.recover(id);
  assert.equal(repairs.length, 1);
  assert.deepEqual(repairs[0].recipients, ['w-docs'], 'дописывается только недостающая ссылка');
  assert.deepEqual(events.map((e) => e.address), ['w-docs'], 'будят только того, кому дописали');
  assert.equal(healed.unread(id, 'w-api'), 1, 'первая ссылка не задвоилась');
  assert.equal(healed.unread(id, 'w-docs'), 1);
});

test('crash после чтения: восстановление не возвращает прочитанное', async (t) => {
  const root = sandbox();
  // Падение после ссылки ЕДИНСТВЕННОМУ получателю: ссылки у всех есть, а intent снять уже
  // не успели — ровно то состояние, в котором восстановление могло бы доставить второй раз.
  const broken = crashAt(root, 'ref', { at: 0 });
  const id = taskWith(broken);
  await refusalAsync(() => broken.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'один раз' }));
  assert.equal(openIntents(path.join(broken.home, 'tasks', id, 'intents')).length, 1, 'intent открыт');

  // Получатель забирает сообщение ДО восстановления: ссылка уезжает из inbox в history.
  const taken = broken.read(id, 'w-api');
  assert.deepEqual(taken.messages.map((m) => m.body), ['один раз']);

  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  const { repairs, events } = healed.recover(id);
  await t.test('восстановление сверило history, а не только inbox', () => {
    assert.deepEqual(repairs[0].recipients, [], 'ссылка дописана заново');
    assert.deepEqual(events, [], 'разбудили того, кто уже прочитал');
    assert.equal(healed.unread(id, 'w-api'), 0);
  });
  await t.test('второе чтение пусто — сообщение не доставлено дважды', () => {
    assert.deepEqual(healed.read(id, 'w-api').messages, []);
  });
});

// ── Лизинг незакрытого fan-out'а (BL-447) ─────────────────────────────────────────────

/**
 * Незакрытый intent на диске: отправка роняется швом сразу после точки коммита. Остаются
 * intent и запись владельца с pid ЭТОГО процесса — ровно то, что оставил бы настоящий
 * отправитель, умерший в этот момент.
 */
async function inFlight(root, body = 'в полёте') {
  const broken = crashAt(root, 'intent');
  const id = taskWith(broken);
  await refusalAsync(() => broken.send(id, { from: 'owner', to: ['w-api'], type: 'task', body }));
  const dir = path.join(broken.home, 'tasks', id, 'intents');
  const [name] = readdirSync(dir).filter((n) => n.endsWith('.json'));
  return { id, dir, intent: path.join(dir, name), owner: path.join(dir, `${name.slice(0, -'.json'.length)}.owner`) };
}

const lease = (file, pid, host = os.hostname()) => writeFileSync(file, `${JSON.stringify({ pid, host })}\n`);

// Состарить intent за порог. Час заведомо больше любого порога, поэтому проверка не зависит
// от самого числа — она про ветку «возраст решает», а не про величину `INTENT_STALE_MS`.
const backdate = (file) => {
  const long = new Date(Date.now() - 3600_000);
  utimesSync(file, long, long);
};

// Чужой ЖИВОЙ pid: настоящий процесс. Свой не годится вовсе — свой pid на intent'е
// восстановление читает как «прошлый процесс с тем же номером» и подбирает.
const liveStranger = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });

// Чужой МЁРТВЫЙ pid: номер только что вышедшего процесса. Число наугад не годится — оно
// может оказаться живым, и проверка молча проверяла бы не то.
async function deadStranger() {
  const ch = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => ch.on('exit', r));
  return ch.pid;
}

test('лизинг: восстановление не трогает intent живого владельца', async (t) => {
  // Дом с несколькими пишущими процессами — норма, а engine открывается лениво, и открытие
  // прогоняет восстановление. Без лизинга опоздавший подбирал живой fan-out соседа:
  // материализовал канон и снимал intent, пока владелец стоял на пути к `link`.
  const root = sandbox();
  const { id, intent } = await inFlight(root);
  const stranger = liveStranger();
  // Гасится через `after`, а не последней строкой: красный assert бросает мимо неё, а живой
  // ребёнок держит цикл событий родителя — набор висел бы минуту после падения.
  t.after(() => stranger.kill());
  lease(path.join(path.dirname(intent), `${path.basename(intent, '.json')}.owner`), stranger.pid);
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  const { repairs, events } = healed.recover(id);
  await t.test('живой intent не подобран и не снят', () => {
    assert.deepEqual(repairs, [], 'восстановление влезло в чужой идущий fan-out');
    assert.deepEqual(events, []);
    assert.ok(existsSync(intent), 'intent снят из-под живого владельца');
    assert.equal(healed.unread(id, 'w-api'), 0, 'ссылка дописана мимо владельца');
  });
});

test('лизинг: intent мёртвого владельца восстановление подбирает', async () => {
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root, 'дописать');
  lease(owner, await deadStranger());
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  const { repairs } = healed.recover(id);
  assert.deepEqual(repairs.map((r) => r.recipients), [['w-api']]);
  assert.equal(healed.unread(id, 'w-api'), 1);
  assert.ok(!existsSync(intent), 'intent остался незакрытым');
  assert.ok(!existsSync(owner), 'запись владельца пережила закрытие fan-out\'а');
});

test('лизинг: intent без записи владельца ждёт порога, а за порогом подбирается', async (t) => {
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root);
  // Так выглядит intent, написанный версией, лизинга не знавшей: живость владельца
  // спросить не у чего, и решает один возраст.
  rmSync(owner);
  await t.test('моложе порога — не тронут', () => {
    const young = openEngine({ root, policy: allowAll, now: clock(), recover: false });
    assert.deepEqual(young.recover(id).repairs, []);
    assert.ok(existsSync(intent));
  });
  await t.test('старше порога — подобран', () => {
    backdate(intent);
    const stale = openEngine({ root, policy: allowAll, now: clock(), recover: false });
    assert.equal(stale.recover(id).repairs.length, 1);
    assert.equal(stale.unread(id, 'w-api'), 1);
  });
});

test('лизинг: запись владельца с чужой машины — ждём порога, живость не спрашивается', async () => {
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root);
  // pid НАШ: на своей машине он означал бы «подбирай», и проверка, не смотрящая на host,
  // этого не заметила бы вовсе.
  lease(owner, process.pid, `${os.hostname()}-drugaya`);
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  assert.deepEqual(healed.recover(id).repairs, []);
  assert.ok(existsSync(intent));
});

test('лизинг: за порогом подбирается и intent живого владельца', async (t) => {
  // Возраст — верхний предел лизинга: pid, переиспользованный ОС под чужой живой процесс,
  // иначе запирал бы intent навсегда. Он же оставляет достижимой гонку, которую терпит
  // `materialize`, — без него та терпимость была бы мёртвым кодом.
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root);
  const stranger = liveStranger();
  t.after(() => stranger.kill());
  lease(owner, stranger.pid);
  backdate(intent);
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  assert.equal(healed.recover(id).repairs.length, 1);
  assert.equal(healed.unread(id, 'w-api'), 1);
});

test('лизинг: intent, брошенный этим же процессом, подбирается', async (t) => {
  // Жизнь intent'а внутри процесса — ОДИН синхронный блок: `commitIntent` и `completeFanout`
  // синхронны целиком, а все await'ы отправки стоят до точки коммита. Поэтому свой pid на
  // intent'е значит «прошлый процесс с тем же номером», а не «пишется прямо сейчас». На этом
  // инварианте держится весь набор падений выше — он роняет отправку швом и восстанавливает
  // ТЕМ ЖЕ процессом; появится await между созданием intent'а и его снятием — покраснеют и
  // они, и эта проверка.
  const root = sandbox();
  const { id, intent, owner } = await inFlight(root, 'свой же');
  await t.test('владельцем записан наш pid', () => {
    assert.deepEqual(JSON.parse(readFileSync(owner, 'utf8')), { pid: process.pid, host: os.hostname() });
  });
  await t.test('восстановление тем же процессом доводит доставку', () => {
    const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
    assert.equal(healed.recover(id).repairs.length, 1);
    assert.equal(healed.unread(id, 'w-api'), 1);
    assert.ok(!existsSync(intent));
  });
});

test('лизинг: свежий intent не наследует осиротевшую запись владельца', async () => {
  // Имена записей могут повториться — код считает это достижимым сам: `commitIntent`
  // пересобирает id по `EEXIST` до шестнадцати раз. Если под тем же именем остался
  // осиротевший лизинг прежнего fan-out'а, свежий intent обязан переписать его собой: иначе
  // он несёт чужие pid и host и объявляется брошенным сразу — окно `BL-447` открыто заново.
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine);
  const dir = path.join(engine.home, 'tasks', id, 'intents');
  mkdirSync(dir, { recursive: true });
  const record = {
    protocolVersion: 1,
    id: '20260902T100700000-0021-abcdef',
    task: id,
    sender: 'owner',
    recipients: ['w-api'],
    type: 'task',
    body: 'свежий',
    ts: '2026-09-02T10:07:00.000Z',
  };
  const orphan = path.join(dir, `${record.id}.owner`);
  lease(orphan, await deadStranger(), `${os.hostname()}-drugaya`);
  commitIntent(engine.home, id, record, new Date(record.ts));
  assert.deepEqual(JSON.parse(readFileSync(orphan, 'utf8')), { pid: process.pid, host: os.hostname() });
});

test('лизинг: осиротевшая запись владельца убирается молча', async () => {
  // Так каталог выглядит после кода прежних версий: intent он снимает, а про лизинг не знает.
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'закрытый fan-out' });
  const orphan = path.join(engine.home, 'tasks', id, 'intents', '20260902T100500000-0009-abcdef.owner');
  mkdirSync(path.dirname(orphan), { recursive: true });
  lease(orphan, process.pid);
  assert.deepEqual(engine.recover(id).repairs, []);
  assert.ok(!existsSync(orphan), 'осиротевшая запись владельца осталась мусором');
});

test('сосед унёс intent между проверкой и связыванием — отправка не отказывает', async (t) => {
  // Гонка `BL-447` целиком, в одном процессе и детерминированно: шов бьёт ровно в окно —
  // точка коммита пройдена, `completeFanout` ещё не начался, — а соседа играет собственное
  // восстановление, которому свой pid на intent'е позволяет его подобрать. Оно материализует
  // канон и снимает intent, и владелец приходит к `link` на исчезнувший источник.
  const root = sandbox();
  let stolen = false;
  let id = null;
  const engine = openEngine({
    root,
    policy: allowAll,
    now: clock(),
    recover: false,
    faults: (step) => {
      if (step !== 'intent' || stolen) return;
      stolen = true;
      engine.recover(id);
    },
  });
  id = taskWith(engine);
  const sent = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'один раз' });
  await t.test('отправка вернулась успехом, а не отказом на доставленном', () => {
    assert.ok(stolen, 'гонка не воспроизведена — соседа не было');
    assert.equal(sent.message.body, 'один раз');
  });
  await t.test('доставлено ровно один раз', () => {
    assert.equal(engine.unread(id, 'w-api'), 1);
    assert.deepEqual(engine.read(id, 'w-api').messages.map((m) => m.id), [sent.message.id]);
  });
  await t.test('intent и запись владельца сняты', () => {
    assert.deepEqual(readdirSync(path.join(engine.home, 'tasks', id, 'intents')), []);
  });
});

test('intent унесён, а канона нет — отказ остаётся отказом', async () => {
  // Второй исход того же окна: ни intent'а, ни канона — это не «материализовано другим», а
  // настоящая потеря, и терпеть её нельзя.
  const root = sandbox();
  let taken = false;
  const engine = openEngine({
    root,
    policy: allowAll,
    now: clock(),
    recover: false,
    faults: (step, info) => {
      if (step !== 'intent' || taken) return;
      taken = true;
      rmSync(path.join(root, '.promptobus', 'tasks', info.task, 'intents', `${info.message}.json`));
    },
  });
  const id = taskWith(engine);
  const e = await refusalAsync(() => engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'потеря' }));
  assert.ok(e instanceof PromptobusError, String(e));
  assert.equal(e.code, 'link-refused');
  assert.equal(e.context.errno, 'ENOENT');
  assert.equal(engine.unread(id, 'w-api'), 0);
});

test('оборванный intent изолируется, а задача работает дальше', async () => {
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine);
  const { message } = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'целое' });
  // Падение внутри точки коммита — единственная форма порчи intent'а: `wx` создаёт файл
  // атомарно, а содержимое пишется следом.
  const torn = path.join(engine.home, 'tasks', id, 'intents', '20260902T100500000-0009-abcdef.json');
  mkdirSync(path.dirname(torn), { recursive: true });
  writeFileSync(torn, '{"protocolVersion":1,"id":"2026');
  // Изолируется она, только когда владелец признан брошенным: у живого соседа половина
  // записи законна ровно так же — файл создан, содержимое ещё пишется. Записи владельца у
  // этой половины нет, поэтому брошенной её делает возраст.
  backdate(torn);
  const healed = openEngine({ root, policy: allowAll, now: clock() });
  assert.equal(healed.recover(id).broken.length, 0, 'изоляция случилась на открытии, а не позже');
  assert.ok(existsSync(path.join(healed.home, 'tasks', id, 'broken', 'messages', path.basename(torn))));
  assert.ok(!existsSync(torn));
  assert.deepEqual(healed.read(id, 'w-api').messages.map((m) => m.id), [message.id]);
});

test('оборванный intent живого соседа остаётся на месте, пока владелец не брошен', () => {
  // Половина записи — законное состояние живого соседа: `wx` создал файл атомарно, содержимое
  // пишется следом, и его половину видно. Гейт лизинга стоит ДО разбора записи именно поэтому;
  // перенеси его под разбор — свежая половина уедет в `broken`, а владелец придёт к `link` на
  // унесённый источник. Соседняя проверка выше про то же ловит только СОСТАРЕННУЮ запись, и
  // оба положения гейта дают на ней одинаковый зелёный.
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine);
  const torn = path.join(engine.home, 'tasks', id, 'intents', '20260902T100600000-0011-abcdef.json');
  mkdirSync(path.dirname(torn), { recursive: true });
  writeFileSync(torn, '{"protocolVersion":1,"id":"2026');
  const healed = openEngine({ root, policy: allowAll, now: clock(), recover: false });
  assert.deepEqual(healed.recover(id).broken, [], 'половина записи живого соседа объявлена порчей');
  assert.ok(existsSync(torn), 'половина записи живого соседа унесена в broken');
  assert.ok(!existsSync(path.join(healed.home, 'tasks', id, 'broken', 'messages')),
    'каталог изоляции заведён на ровном месте');
});

// ── Mailbox и history ─────────────────────────────────────────────────────────────────

test('чтение переносит ссылку в history и не возвращает прочитанное', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'раз' });
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'status', body: 'два' });
  assert.deepEqual(engine.read(id, 'w-api').messages.map((m) => m.body), ['раз', 'два']);
  assert.deepEqual(engine.read(id, 'w-api').messages, []);
  assert.equal(engine.unread(id, 'w-api'), 0);
  assert.equal(readdirSync(path.join(engine.home, 'tasks', id, 'history', 'w-api')).length, 2);
});

test('ссылка в inbox и запись в history читают одно и то же содержимое', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const { message } = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'то же самое' });
  const root = path.join(engine.home, 'tasks', id);
  const inInbox = readFileSync(path.join(root, 'inbox', 'w-api', `${message.id}.json`), 'utf8');
  engine.read(id, 'w-api');
  const inHistory = readFileSync(path.join(root, 'history', 'w-api', `${message.id}.json`), 'utf8');
  const canonical = readFileSync(path.join(root, 'messages', `${message.id}.json`), 'utf8');
  assert.equal(inInbox, canonical);
  assert.equal(inHistory, canonical);
});

test('битое сообщение в mailbox\'е уезжает в broken, а остальные доходят', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'целое' });
  const box = path.join(engine.home, 'tasks', id, 'inbox', 'w-api');
  writeFileSync(path.join(box, '20260902T100900000-0009-ffffff.json'), '{битое');
  const { messages, broken } = engine.read(id, 'w-api');
  assert.deepEqual(messages.map((m) => m.body), ['целое']);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].code, 'schema-invalid');
  assert.ok(existsSync(path.join(engine.home, 'tasks', id, 'broken', 'inbox', 'w-api',
    '20260902T100900000-0009-ffffff.json')));
});

test('сообщение более новой версии не изолируется, а называется своим кодом', async () => {
  // Порча и «нечем читать» — разные исходы: запись из будущего чинится обновлением
  // механизма, а не изоляцией, и уносить её в broken значило бы её потерять.
  const engine = open(sandbox());
  const id = taskWith(engine);
  await engine.send(id, { from: 'owner', to: ['w-api'], type: 'task', body: 'целое' });
  const box = path.join(engine.home, 'tasks', id, 'inbox', 'w-api');
  const name = '20260902T101000000-0009-eeeeee.json';
  writeFileSync(path.join(box, name), JSON.stringify({
    protocolVersion: 2, id: name.slice(0, -5), task: id, sender: 'owner', recipients: ['w-api'],
    type: 'task', body: 'из будущего', ts: '2026-09-02T10:10:00.000Z',
  }));
  const { messages, broken } = engine.read(id, 'w-api');
  assert.deepEqual(messages.map((m) => m.body), ['целое']);
  assert.equal(broken[0].code, 'schema-version-unsupported');
  assert.ok(existsSync(path.join(box, name)), 'запись из будущего осталась на месте');
});

test('history: постранично, от старых к новым, по умолчанию последние 50', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  for (let i = 0; i < 60; i += 1) {
    await engine.send(id, { from: 'owner', to: ['w-api'], type: 'status', body: `п${String(i).padStart(2, '0')}` });
  }
  engine.read(id, 'w-api');
  const page = engine.history({ task: id, participant: 'w-api' });
  await t.test('history: по умолчанию 50 последних, от старых к новым', () => {
    assert.equal(page.entries.length, 50);
    assert.equal(page.entries[0].message.body, 'п10');
    assert.equal(page.entries.at(-1).message.body, 'п59');
  });
  await t.test('history: курсор отдаёт страницу старше, без повторов на границе', () => {
    const older = engine.history({ task: id, participant: 'w-api', before: page.cursor, limit: 50 });
    assert.equal(older.entries.length, 10);
    assert.equal(older.entries[0].message.body, 'п00');
    assert.equal(older.entries.at(-1).message.body, 'п09');
    assert.equal(older.cursor, null, 'страниц старше не осталось');
    const seen = new Set([...page.entries, ...older.entries].map((e) => e.message.id));
    assert.equal(seen.size, 60);
  });
  await t.test('history: all снимает лимит целиком', () => {
    assert.equal(engine.history({ task: id, participant: 'w-api', all: true }).entries.length, 60);
  });
  await t.test('history: непрочитанного в ней нет', async () => {
    await engine.send(id, { from: 'owner', to: ['w-api'], type: 'status', body: 'непрочитанное' });
    const all = engine.history({ task: id, participant: 'w-api', all: true });
    assert.equal(all.entries.length, 60);
    assert.equal(engine.unread(id, 'w-api'), 1);
  });
});

test('history: граница страницы не режет группу записей одного сообщения', async (t) => {
  // Одно сообщение двум получателям — ДВЕ записи истории, а лимит считает записи, а не
  // сообщения. Курсор по id сообщения отсекал следующую страницу целой группой: записи
  // того же сообщения, оставшиеся левее среза, не попадали ни в одну страницу вовсе.
  const engine = open(sandbox());
  const id = taskWith(engine);
  for (let i = 0; i < 3; i += 1) {
    await engine.send(id, { from: 'owner', to: ['w-api', 'w-docs'], type: 'status', body: `м${i}` });
  }
  for (const who of ['w-api', 'w-docs']) engine.read(id, who);
  const whole = engine.history({ task: id, all: true });
  const page = engine.history({ task: id, limit: 3 });
  const older = engine.history({ task: id, limit: 3, before: page.cursor });
  const seen = (p) => p.entries.map((e) => `${e.message.id} ${e.participant}`);
  await t.test('граница группы: страницы отдают ровно 3 и 3 записи', () => {
    assert.equal(whole.entries.length, 6);
    assert.equal(page.entries.length, 3);
    assert.equal(older.entries.length, 3);
  });
  await t.test('граница группы: две страницы покрывают историю целиком и без повторов', () => {
    const both = [...seen(older), ...seen(page)];
    assert.equal(new Set(both).size, 6, `потеряно или задвоено: ${both.join(' | ')}`);
    assert.deepEqual(both, seen(whole));
  });
  await t.test('граница группы: страниц старше не осталось', () => {
    assert.equal(older.cursor, null);
  });
});

test('history без участника собирает всех, без задачи — все задачи', async () => {
  const engine = open(sandbox());
  const first = taskWith(engine, 'one-t20260902-100000');
  const second = taskWith(engine, 'two-t20260902-100001');
  await engine.send(first, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'первой' });
  await engine.send(second, { from: 'owner', to: ['w-api'], type: 'task', body: 'второй' });
  for (const [task, who] of [[first, 'w-api'], [first, 'w-docs'], [second, 'w-api']]) engine.read(task, who);
  // Одно сообщение, лежащее у двоих, — две записи истории: адресаты разные.
  assert.equal(engine.history({ task: first, all: true }).entries.length, 2);
  assert.equal(engine.history({ all: true }).entries.length, 3);
  assert.deepEqual(engine.history({ participant: 'w-docs', all: true }).entries.map((e) => e.message.body), ['первой']);
});

// ── Артефакты ─────────────────────────────────────────────────────────────────────────

test('артефакт: потоковый SHA-256, дедупликация и разные имена на один digest', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(SB, 'artifact-a.patch');
  writeFileSync(file, 'одно и то же содержимое\n');
  const copy = path.join(SB, 'artifact-b.patch');
  writeFileSync(copy, 'одно и то же содержимое\n');

  const first = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'раз', artifact: { path: file } });
  const second = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'два', artifact: { path: copy } });

  await t.test('артефакт: два имени, две metadata-записи, один blob', () => {
    assert.equal(first.artifact.sha256, second.artifact.sha256);
    assert.notEqual(first.artifact.id, second.artifact.id);
    assert.deepEqual([first.artifact.filename, second.artifact.filename], ['artifact-a.patch', 'artifact-b.patch']);
    assert.deepEqual(readdirSync(path.join(engine.home, 'tasks', id, 'blobs')), [first.artifact.sha256]);
    assert.equal(engine.listArtifacts(id).artifacts.length, 2);
  });
  await t.test('артефакт: сообщение несёт id metadata, содержимое читается по нему', () => {
    assert.equal(first.message.artifact, first.artifact.id);
    assert.equal(engine.readArtifactContent(id, first.artifact.id).toString(), 'одно и то же содержимое\n');
  });
  await t.test('артефакт: размер записан по прочитанному, а не по заявленному', () => {
    assert.equal(first.artifact.size, Buffer.byteLength('одно и то же содержимое\n'));
  });
});

test('артефакт из потока: digest считается на проходе записи', async () => {
  // Поток читается ровно один раз — второго чтения у него нет вовсе. Непотоковый digest
  // («прочитать файл и посчитать») этот случай не закрывает никак.
  const engine = open(sandbox());
  const id = taskWith(engine);
  const body = 'кусок один|кусок два|кусок три';
  const sent = await engine.send(id, {
    from: 'owner',
    to: ['w-api'],
    type: 'artifact',
    body: 'из потока',
    artifact: { stream: Readable.from(body.split('|')), filename: 'stream.txt' },
  });
  assert.equal(sent.artifact.size, Buffer.byteLength(body.replaceAll('|', '')));
  assert.equal(engine.readArtifactContent(id, sent.artifact.id).toString(), body.replaceAll('|', ''));
});

test('негодное имя артефакта отказывает ДО blob\'а', async (t) => {
  // Имя, пойманное схемой уже после записи blob'а, оставляло бы в задаче содержимое без
  // metadata — orphan blob на ровном месте, живущий до самого `prune` (замечание ревью).
  const engine = open(sandbox());
  const id = taskWith(engine);
  const cases = [
    ['пустое имя у потока', { stream: Readable.from(['данные']), filename: '' }],
    ['разделитель пути в имени', { stream: Readable.from(['данные']), filename: 'sub/x.txt' }],
    ['имя каталога', { stream: Readable.from(['данные']), filename: '..' }],
  ];
  for (const [what, artifact] of cases) {
    await t.test(`имя артефакта: ${what} — код artifact-source`, async () => {
      const e = await refusalAsync(() => engine.send(id, {
        from: 'owner', to: ['w-api'], type: 'artifact', body: 'дифф', artifact,
      }));
      assert.equal(e.code, 'artifact-source');
    });
  }
  await t.test('имя артефакта: ни одного blob\'а в задаче не появилось', () => {
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id, 'blobs')));
    assert.equal(engine.orphanBlobs(id).length, 0);
  });
});

test('артефакт: расхождение digest\'а при чтении — типизированный отказ', async (t) => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(SB, 'integrity.patch');
  writeFileSync(file, 'исходное содержимое\n');
  const sent = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'дифф', artifact: { path: file } });
  const blob = path.join(engine.home, 'tasks', id, 'blobs', sent.artifact.sha256);
  await t.test('артефакт: до порчи читается целиком', () => {
    assert.equal(engine.readArtifactContent(id, sent.artifact.id).toString(), 'исходное содержимое\n');
  });
  await t.test('артефакт: подменённое содержимое не отдаётся молча', () => {
    rmSync(blob);
    writeFileSync(blob, 'подменённое содержимое\n');
    const e = refusal(() => engine.readArtifactContent(id, sent.artifact.id));
    assert.equal(e.code, 'artifact-integrity');
    assert.equal(e.context.declared, sent.artifact.sha256);
    assert.notEqual(e.context.actual, sent.artifact.sha256);
  });
  await t.test('артефакт: пропавший blob — свой код, а не integrity', () => {
    rmSync(blob);
    assert.equal(refusal(() => engine.readArtifactContent(id, sent.artifact.id)).code, 'artifact-not-found');
  });
});

test('артефакт: битая metadata изолируется, остальные записи задачи читаются', async () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(SB, 'meta.patch');
  writeFileSync(file, 'дифф\n');
  const sent = await engine.send(id, { from: 'owner', to: ['w-api'], type: 'artifact', body: 'дифф', artifact: { path: file } });
  const dir = path.join(engine.home, 'tasks', id, 'artifacts');
  writeFileSync(path.join(dir, '20260902T101100000-0009-cccccc.json'), '{битое');
  const listed = engine.listArtifacts(id);
  assert.deepEqual(listed.artifacts.map((a) => a.id), [sent.artifact.id]);
  assert.equal(listed.broken.length, 1);
  assert.ok(existsSync(path.join(engine.home, 'tasks', id, 'broken', 'artifacts',
    '20260902T101100000-0009-cccccc.json')));
});

test('orphan blob лежит до prune, а prune уносит задачу целиком', async (t) => {
  const root = sandbox();
  const file = path.join(SB, 'orphan.patch');
  writeFileSync(file, 'содержимое без имени\n');
  // Падение между blob'ом и metadata оставляет содержимое без единой ссылки на него.
  const broken = crashAt(root, 'blob', { at: 0 });
  const id = taskWith(broken);
  await refusalAsync(() => broken.send(id, {
    from: 'owner', to: ['w-api'], type: 'artifact', body: 'дифф', artifact: { path: file },
  }));
  const engine = openEngine({ root, policy: allowAll, now: clock() });
  await t.test('orphan blob: содержимое лежит, metadata на него нет', () => {
    assert.equal(engine.orphanBlobs(id).length, 1);
    assert.deepEqual(engine.listArtifacts(id).artifacts, []);
  });
  await t.test('orphan blob: восстановление его не трогает', () => {
    engine.recover(id);
    assert.equal(engine.orphanBlobs(id).length, 1);
  });
  await t.test('prune активной задачи отказывает', () => {
    assert.equal(refusal(() => engine.prune(id)).code, 'task-active');
    assert.ok(existsSync(path.join(engine.home, 'tasks', id)));
  });
  await t.test('prune закрытой уносит и blob\'ы, и переписку', () => {
    engine.closeTask(id);
    const pruned = engine.prune(id);
    assert.equal(pruned.blobs, 1);
    assert.ok(pruned.bytes > 0);
    assert.ok(!existsSync(path.join(engine.home, 'tasks', id)));
  });
});

// ── Изоляция повреждённой задачи ──────────────────────────────────────────────────────

test('повреждённая задача блокирует только себя', async (t) => {
  const engine = open(sandbox());
  const healthy = taskWith(engine, 'zhivaya-t20260902-100000');
  const sick = taskWith(engine, 'bitaya-t20260902-100001');
  await engine.send(healthy, { from: 'owner', to: ['w-api'], type: 'task', body: 'работает' });
  writeFileSync(path.join(engine.home, 'tasks', sick, 'task.json'), '{обрезанный журнал');

  await t.test('перечисление отдаёт исправные и называет порченую', () => {
    const listed = engine.listTasks();
    assert.deepEqual(listed.tasks.map((t2) => t2.id), [healthy]);
    assert.equal(listed.broken.length, 1);
    // Порченая задача называется ПАРОЙ, а не готовой строкой: id и причина приезжают
    // отдельно, потому что текст человеку собирает adapter — ему нужен ещё путь файла.
    assert.equal(listed.broken[0].id, sick);
    assert.match(listed.broken[0].note, /не разобран/);
  });
  await t.test('чтение порченой отказывает своим кодом', () => {
    assert.equal(refusal(() => engine.readTask(sick)).code, 'task-broken');
  });
  await t.test('исправная задача работает дальше', () => {
    assert.deepEqual(engine.read(healthy, 'w-api').messages.map((m) => m.body), ['работает']);
  });
  await t.test('восстановление по всем задачам не спотыкается о порченую', () => {
    assert.deepEqual(engine.recover().repairs, []);
  });
});

// ── BL-486: смесь версий механизма ────────────────────────────────────────────────────
//
// После `sync` живая сессия продолжает работать с MCP-сервером шины, поднятым на её старте
// из ПРЕЖНЕГО релиза, а worker нового релиза кладёт в журнал запись со снимком capabilities,
// которого прежний валидатор не знает. Схему это не ослабляет: незнакомое поле — по-прежнему
// отказ. Различается ТЕКСТ и код — «начни новую сессию» вместо «журнал не по схеме», потому
// что лечится это новой сессией, а не починкой журнала.
//
// Версию читателя называет открывающий engine, и в этом файле его играет набор: копилки на
// уровне модуля у package нет — чужое значение приходит аргументом, как home и policy.

// Снимок capabilities с полем, которого читатель не знает: так выглядит запись механизма
// новее — своих полей у него больше, а имена их читателю неизвестны по построению.
const AHEAD_CAPS = { ...CAPS, resume: true };

// Журнал каждый раз собирается из ПЕРВОНАЧАЛЬНОГО снимка, а не из того, что лежит на диске
// после соседней проверки: поля metadata сливаются, и версия прошлой редакции доехала бы до
// проверки «версии в записи нет».
const pristine = new Map();

// Адреса участников фикстуры: человеку отказ называет адрес, а не id каталога mailbox'а.
const ADDRESS = { owner: 'orchestrator', 'w-api': 'worker:api', 'w-docs': 'worker:docs' };

/**
 * Журнал, где запись участника `on` сделана механизмом версии `version`, а снимок
 * capabilities у него — `caps`. `marked` помечает версией ещё кого-то, не трогая его снимок:
 * так выглядит журнал после `sync` — новый CLI перезаписывает и владельца тоже.
 */
function journalFrom(engine, id, { version, caps = AHEAD_CAPS, patch = {}, on = 'w-api', marked = {} }) {
  const file = path.join(engine.home, 'tasks', id, 'task.json');
  if (!pristine.has(file)) pristine.set(file, readFileSync(file, 'utf8'));
  const meta = JSON.parse(pristine.get(file));
  const versions = { ...marked, ...(version === null ? {} : { [on]: version }) };
  const participants = meta.participants.map((p) => ({
    ...p,
    ...(p.id === on ? { capabilities: caps } : {}),
    metadata: {
      ...p.metadata,
      address: ADDRESS[p.id] ?? p.id,
      ...(versions[p.id] ? { [MECHANISM_VERSION_FIELD]: versions[p.id] } : {}),
    },
  }));
  writeFileSync(file, JSON.stringify({ ...meta, participants, ...patch }, null, 2));
  return file;
}

test('BL-486: запись механизма новее читателя — отказ зовёт в новую сессию, а не чинить журнал', async (t) => {
  const engine = open(sandbox(), { cli: '0.63.0' });
  const id = taskWith(engine);

  await t.test('лишние поля плюс версия новее — свой код и честный текст', () => {
    journalFrom(engine, id, { version: '0.64.0' });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'schema-version-unsupported');
    // Текст называет ОБЕ версии, участника и лечение: без лечения человек чинит журнал,
    // который цел.
    assert.match(e.message, /запись участника worker:api сделана механизмом 0\.64\.0/);
    assert.match(e.message, /эта сессия работает на 0\.63\.0/);
    assert.match(e.message, /начни новую сессию/);
    assert.match(e.message, /MCP-сервер шины стартует из установленного релиза/);
    assert.equal(e.context.participant, 'worker:api');
  });

  await t.test('те же лишние поля без версии в записи — прежний отказ прежним текстом', () => {
    journalFrom(engine, id, { version: null });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'task-broken');
    assert.match(e.message, /не по схеме/);
    assert.ok(!/начни новую сессию/.test(e.message), e.message);
  });

  // Второй ход мутационной пробы: наивная редакция «версия ≠ моей — смесь версий» обязана
  // покрасить обе проверки ниже, потому что обе называют версию, отличную от читателя лишь
  // в другую сторону либо не отличную вовсе.
  await t.test('версия в записи СТАРЕЕ читателя — прежний отказ, а не смесь версий', () => {
    journalFrom(engine, id, { version: '0.62.0' });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'task-broken');
    assert.ok(!/начни новую сессию/.test(e.message), e.message);
  });

  await t.test('версия в записи РАВНА версии читателя — прежний отказ', () => {
    journalFrom(engine, id, { version: '0.63.0' });
    assert.equal(refusal(() => engine.readTask(id)).code, 'task-broken');
  });

  // Первый ход пробы по условию «лишние поля есть»: журнал новее, но поломка не в них —
  // это порча, и лечится она изоляцией задачи, а не новой сессией.
  await t.test('версия новее, а поломка не в лишних полях — прежний task-broken', () => {
    journalFrom(engine, id, { version: '0.64.0', caps: CAPS, patch: { title: '' } });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'task-broken');
    assert.match(e.message, /не по схеме/);
    assert.ok(!/начни новую сессию/.test(e.message), e.message);
  });

  // Названный участник — тот, на чьей записи споткнулся валидатор, а не первый попавшийся с
  // маркером: `sync` перезаписывает и владельца, а он в журнале первый.
  await t.test('назван участник, на чьей записи споткнулся валидатор, а не первый с маркером', () => {
    journalFrom(engine, id, { version: '0.64.0', on: 'w-docs', marked: { owner: '0.64.0' } });
    const e = refusal(() => engine.readTask(id));
    assert.equal(e.code, 'schema-version-unsupported');
    assert.equal(e.context.participant, 'worker:docs');
    assert.match(e.message, /запись участника worker:docs/);
  });

  // Сторож размещения проверки: она живёт ВНУТРИ ветки невалидного вердикта, и годный
  // журнал не имеет права споткнуться о версию сам по себе.
  await t.test('версия новее, лишних полей нет — журнал читается как обычно', () => {
    journalFrom(engine, id, { version: '0.64.0', caps: CAPS });
    assert.equal(engine.readTask(id).id, id);
  });
});

test('BL-486: версия читателя не названа при открытии — прежний путь целиком', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  journalFrom(engine, id, { version: '99.0.0' });
  assert.equal(refusal(() => engine.readTask(id)).code, 'task-broken');
});

test('журнал более новой версии не объявляется порченым', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(engine.home, 'tasks', id, 'task.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...meta, schemaVersion: 2 }, null, 2));
  assert.equal(refusal(() => engine.readTask(id)).code, 'schema-version-unsupported');
});


// Журнал приезжает на место через `rename`, как сообщение: жёсткая ссылка на прежний файл
// держит прежнее содержимое. Записанный поверх себя (`writeFileSync`) он менялся бы и по
// ссылке — а между усечением и записью параллельный читатель видит пустой файл и отвечает
// «журнал не читается» о живой задаче. Проверка переехала сюда из набора слоя совместимости
// (`BL-430`): предмет — `writeTask` engine, и мутационная проба на неё — подмена
// `writeJsonAtomic` на `writeFileSync` в `v1/store.ts`.
test('BL-149: журнал не пишется поверх себя — новый файл встаёт через rename', () => {
  const engine = open(sandbox());
  const id = taskWith(engine);
  const file = path.join(engine.home, 'tasks', id, 'task.json');
  const held = path.join(engine.home, 'held-journal.json');
  linkSync(file, held);
  engine.patchTask(id, { title: 'переименована' });
  assert.equal(JSON.parse(readFileSync(held, 'utf8')).title, 'демо', 'прежняя ссылка увидела новую запись');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).title, 'переименована');
});

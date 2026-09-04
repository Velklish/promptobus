// Многопроцессная конкуренция protocol v1 (`BL-409`): отправка, чтение и восстановление
// настоящими процессами, и настоящее падение процесса посреди fan-out'а.
//
// Настоящими, а не промисами в одном процессе: предмет проверки — атомарные примитивы
// файловой системы (`wx` у intent'а, `link` у ссылок, `rename` у чтения), а внутри одного
// процесса они никогда не встречаются с собой. Тем же приёмом устроен набор legacy store
// ([races.test.mjs](races.test.mjs)), и барьер здесь тот же: без него дети выстраиваются в
// очередь по времени запуска, и окно, которое чинится, не наступает вовсе.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { ERROR_CODES, openEngine, PromptobusError } from '../dist/index.js';

const DIST = new URL('../dist/index.js', import.meta.url).href;
const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-v1-races-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const J = JSON.stringify;
const CAPS = { spawn: true, attach: true, activation: 'push', inspect: true, stop: true };
const person = (id, role) => ({
  id, role, harness: 'fake', mode: 'managed', sessionRef: `sess-${id}`, capabilities: CAPS, metadata: {},
});
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

function open(root, options = {}) {
  return openEngine({ root, policy: allowAll, ...options });
}

function taskWith(engine, id) {
  engine.createTask({ id, title: 'гонка', owner: person('owner', 'orchestrator') });
  for (const who of ['w-api', 'w-docs']) engine.addParticipant(id, person(who, 'worker'));
  return id;
}

// Доклад ребёнка «дошёл до барьера». Первая строка его stdout и в проверки не возвращается.
const READY = '__ready__';

// Дочерний процесс с кодом на входе: код выхода, stdout и stderr одним резолвом. `open`
// внутри собирается той же строкой, что и здесь: engine у ребёнка настоящий, и правило
// routing policy ему тоже нужно.
//
// Код возврата берётся у КАЖДОГО ребёнка, а не только там, где его спрашивают: тело упавшего
// ребёнка не печатает ничего, и его молчание неотличимо от потерянного сообщения — проверка
// счёта называла причиной следствие (`BL-449`). Резолв по `close`, а не по `exit`: `exit`
// приходит до того, как дочитаны пайпы, и хвост stderr уезжал бы вместе с диагнозом.
//
// `ready` — хук барьера: зовётся ровно один раз, с stdin'ом ребёнка при докладе о готовности
// либо с `null`, если ребёнок умер, не доложив. Второе обязательно: упавший ребёнок иначе
// запирал бы барьер навсегда.
function child(body, { ready = null } = {}) {
  const code = `const m = await import(${J(DIST)});\n`
    + 'const open = (root, extra = {}) => m.openEngine({ root, policy: () => ({ allow: true }), ...extra });\n'
    + body;
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, ['--input-type=module', '-e', code],
      { stdio: [ready ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let pending = ready;
    const arrive = (stdin) => {
      if (!pending) return;
      const hook = pending;
      pending = null;
      hook(stdin);
    };
    ch.stdout.on('data', (d) => { out += d; if (out.startsWith(`${READY}\n`)) arrive(ch.stdin); });
    ch.stderr.on('data', (d) => { err += d; });
    ch.on('close', (c) => {
      arrive(null);
      resolve({ code: c, out: (ready ? out.slice(out.indexOf('\n') + 1) : out).trim(), err: err.trim() });
    });
  });
}

// Все дети вышли нулём — сверяется ПЕРЕД всяким счётом сообщений, ссылок и intent'ов. Деталь
// называет упавшего и несёт его stderr: диагноз стоит там, а не в числе недосчитанных.
function exitedZero(kids, who = (i) => `#${i}`) {
  const dead = kids.map((k, i) => ({ ...k, who: who(i) })).filter((k) => k.code !== 0);
  assert.equal(dead.length, 0, dead
    .map((k) => `ребёнок ${k.who} вышел кодом ${k.code}: ${k.err || 'stderr пуст'}`).join('\n'));
}

// Барьер: дети докладывают о готовности и засыпают на чтении stdin, а родитель отпускает всех
// разом, когда собрались все.
//
// По готовности, а не по общей метке времени (`BL-448`). Метка давала фору на запуск node и
// импорт `dist`, и калибровалась под спокойную машину: под нагрузкой (load average 40) часть
// детей входила в барьер уже ПОСЛЕ метки, и гонка вырождалась в почти последовательный
// запуск. Ожидание на stdin — блокировка, а не спин: прежний `while (Date.now() < at) {}` жёг
// процессорное время каждого ребёнка до самой метки. Снятие stdin с чтения после отпуска
// обязательно: оставленный в потоке, он держал бы цикл событий ребёнка живым и после гонки.
function racers(n, body) {
  const doors = [];
  let seen = 0;
  let gathered = null;
  const all = new Promise((r) => { gathered = r; });
  const arrive = (stdin) => {
    if (stdin) {
      // Слушатель ошибки — сразу при укладке двери, а не при отпуске: ребёнок, доложивший о
      // готовности и тут же умерший, оставил бы пайп без слушателя, и EPIPE уронил бы набор.
      stdin.on('error', () => {});
      doors.push(stdin);
    }
    seen += 1;
    if (seen === n) gathered();
  };
  const kids = Array.from({ length: n }, (_, i) => child(
    `const i = ${i};\nconsole.log(${J(READY)});\n`
    + "await new Promise((r) => process.stdin.once('data', r));\nprocess.stdin.pause();\n"
    + body,
    { ready: arrive },
  ));
  return all.then(() => {
    // Ребёнок мог умереть между докладом и отпуском: EPIPE здесь не отказ стенда, и
    // слушатель ошибки на двери стоит с самой её укладки.
    for (const door of doors) door.end('go\n');
    return Promise.all(kids);
  });
}

// ── Конкурентная отправка ─────────────────────────────────────────────────────────────

test('два процесса шлют в один mailbox — ничего не потеряно и порядок отправителя цел', async (t) => {
  const root = sandbox();
  const id = taskWith(open(root), 'otpravka-t20260902-110000');
  const PER = 20;
  const kids = await racers(2,
    `const e = open(${J(root)});\n`
    + `for (let k = 0; k < ${PER}; k += 1) {\n`
    + `  await e.send(${J(id)}, { from: 'w-' + (i ? 'docs' : 'api'), to: ['owner'], type: 'status', body: i + '#' + k });\n`
    + '}\n');
  const { messages } = open(root).read(id, 'owner');
  const sender = (i) => ['w-api', 'w-docs'][i];
  await t.test('конкурентная отправка: оба процесса записали, ничего не потеряно', () => {
    exitedZero(kids, sender);
    assert.equal(messages.length, PER * 2);
  });
  await t.test('конкурентная отправка: у каждого отправителя порядок сохранён', () => {
    exitedZero(kids, sender);
    for (const line of [0, 1]) {
      const own = messages.filter((m) => m.body.startsWith(`${line}#`)).map((m) => Number(m.body.split('#')[1]));
      assert.equal(own.length, PER);
      assert.deepEqual(own, own.map((_, k) => k));
    }
  });
  await t.test('конкурентная отправка: незакрытых intent\'ов и временных файлов не осталось', () => {
    exitedZero(kids, sender);
    const taskRoot = path.join(open(root).home, 'tasks', id);
    assert.deepEqual(readdirSync(path.join(taskRoot, 'intents')), []);
    assert.deepEqual(readdirSync(path.join(taskRoot, 'messages')).filter((n) => n.startsWith('.')), []);
  });
});

test('восемь процессов заводят одну задачу — успех ровно у одного', async () => {
  const root = sandbox();
  const id = 'sozdanie-t20260902-110100';
  const owner = J(person('owner', 'orchestrator'));
  const kids = await racers(8,
    `try { open(${J(root)}).createTask({ id: ${J(id)}, title: 'линия ' + i, owner: ${owner} });\n`
    + "  console.log('ok ' + i);\n"
    + "} catch (e) { console.log('busy ' + (e.code || e.message)); }");
  exitedZero(kids);
  const created = kids.map((k) => k.out);
  const winners = created.filter((r) => r.startsWith('ok'));
  assert.equal(winners.length, 1, created.join(', '));
  assert.ok(created.filter((r) => r.startsWith('busy')).every((r) => r.endsWith('task-exists')), created.join(', '));
  assert.equal(open(root).readTask(id).title, `линия ${winners[0].split(' ')[1]}`);
});

// ── Конкурентное чтение ───────────────────────────────────────────────────────────────

test('два читателя одного mailbox\'а — ни отказа, ни задвоенного сообщения', async (t) => {
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine, 'chtenie-t20260902-110200');
  const LETTERS = 120;
  for (let k = 0; k < LETTERS; k += 1) {
    await engine.send(id, { from: 'owner', to: ['w-api'], type: 'status', body: `п${k}` });
  }
  const kids = await racers(2,
    `try { const r = open(${J(root)}, { recover: false }).read(${J(id)}, 'w-api');\n`
    + "  console.log(r.messages.map((x) => x.body).join(' '));\n"
    + "} catch (e) { console.log('ОТКАЗ ' + (e.code || e.message)); }");
  const readers = kids.map((k) => k.out);
  // Отказавшего читателя в счёт не берём: его выход — не сообщения, а диагноз, и в сумме
  // он врал бы вверх ровно на той мутации, ради которой проверка и стоит.
  const delivered = readers.filter((r) => !r.startsWith('ОТКАЗ')).flatMap((r) => r.split(' ')).filter(Boolean);
  await t.test('два читателя: отказа нет, ни одно сообщение не потеряно', () => {
    exitedZero(kids);
    assert.ok(!readers.some((r) => r.startsWith('ОТКАЗ')), readers.filter((r) => r.startsWith('ОТКАЗ')).join(', '));
    assert.equal(delivered.length, LETTERS);
  });
  await t.test('два читателя: ни одно сообщение не досталось обоим', () => {
    exitedZero(kids);
    assert.equal(new Set(delivered).size, LETTERS);
  });
  await t.test('два читателя: mailbox пуст, а прочитанное всё лежит в history', () => {
    exitedZero(kids);
    assert.equal(open(root).unread(id, 'w-api'), 0);
    assert.equal(open(root).history({ task: id, participant: 'w-api', all: true }).entries.length, LETTERS);
  });
});

// ── Настоящее падение процесса посреди fan-out'а ──────────────────────────────────────

test('процесс умирает посреди fan-out\'а — восстановление доводит доставку', async (t) => {
  // Ровно то состояние, что даёт бросок из шва в одном процессе, — но полученное настоящей
  // смертью процесса: без этого «падение» оставалось бы моделью падения.
  const root = sandbox();
  const id = taskWith(open(root), 'padenie-t20260902-110300');
  const died = await child(
    `const e = open(${J(root)}, { recover: false, faults: (step) => { if (step === 'ref') process.exit(7); } });\n`
    + `await e.send(${J(id)}, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'обоим' });\n`);
  await t.test('падение: процесс умер в точке ref', () => {
    assert.equal(died.code, 7, died.err || 'stderr пуст');
  });
  await t.test('падение: на диске остался незакрытый intent и одна ссылка из двух', () => {
    const noHeal = openEngine({ root, policy: allowAll, recover: false });
    assert.equal(openIntents(path.join(noHeal.home, 'tasks', id, 'intents')).length, 1);
    assert.equal(noHeal.unread(id, 'w-api') + noHeal.unread(id, 'w-docs'), 1);
  });
  await t.test('падение: открытие engine дописывает недостающее', () => {
    const healed = open(root);
    assert.equal(healed.unread(id, 'w-api'), 1);
    assert.equal(healed.unread(id, 'w-docs'), 1);
    assert.deepEqual(readdirSync(path.join(healed.home, 'tasks', id, 'intents')), []);
  });
});

test('конкурентное восстановление из четырёх процессов не задваивает доставку', async (t) => {
  const root = sandbox();
  const id = taskWith(open(root), 'vosstanovlenie-t20260902-110400');
  // Пять недоставленных fan-out'ов: каждый умирает после первой ссылки. Код выхода сверяется
  // у каждого: не умерший, а не стартовавший ребёнок дал бы недостачу intent'ов с диагнозом
  // «восстановление не сработало» вместо «процесс не отработал» (`BL-449`).
  for (let k = 0; k < 5; k += 1) {
    const killed = await child(
      `const e = open(${J(root)}, { recover: false, faults: (step) => { if (step === 'ref') process.exit(7); } });\n`
      + `await e.send(${J(id)}, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'п${k}' });\n`);
    assert.equal(killed.code, 7, `отправитель п${k}: ${killed.err || 'stderr пуст'}`);
  }
  const before = openEngine({ root, policy: allowAll, recover: false });
  assert.equal(openIntents(path.join(before.home, 'tasks', id, 'intents')).length, 5);

  const kids = await racers(4,
    `const r = open(${J(root)}, { recover: false }).recover(${J(id)});\n`
    + "console.log(r.repairs.flatMap((x) => x.recipients.map((p) => x.message + ':' + p)).join(','));");
  const healers = kids.map((k) => k.out);
  await t.test('конкурентное восстановление: ни один процесс не отказал', () => {
    exitedZero(kids);
    assert.ok(healers.every((r) => !r.startsWith('ОТКАЗ')), healers.join(' | '));
  });
  await t.test('конкурентное восстановление: у каждого получателя ровно пять ссылок', () => {
    exitedZero(kids);
    const healed = open(root);
    assert.equal(healed.unread(id, 'w-api'), 5);
    assert.equal(healed.unread(id, 'w-docs'), 5);
    assert.deepEqual(readdirSync(path.join(healed.home, 'tasks', id, 'intents')), []);
  });
  await t.test('конкурентное восстановление: каждого получателя свежим назвал ровно один процесс', () => {
    exitedZero(kids);
    // Пять отправителей умерли после первой ссылки: восстановлению осталось по одной ссылке на
    // сообщение, и свежим её получателя вправе назвать только тот процесс, чья ссылка легла.
    // Двое, прошедшие `delivered()` до чужого `link`, иначе назвали бы его оба — и надзиратель
    // разослал бы два notification на одно сообщение (`BL-455`).
    const pairs = healers.flatMap((r) => r.trim().split(',').filter(Boolean));
    assert.equal(pairs.length, 5, pairs.join(' '));
    assert.equal(new Set(pairs).size, 5, pairs.join(' '));
  });
  await t.test('конкурентное восстановление: чтение отдаёт каждое сообщение по разу', () => {
    const healed = open(root);
    const bodies = healed.read(id, 'w-docs').messages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['п0', 'п1', 'п2', 'п3', 'п4']);
  });
});

test('восстановление рядом с чтением не возвращает уже прочитанное', async () => {
  const root = sandbox();
  const id = taskWith(open(root), 'gonka-chteniya-t20260902-110500');
  for (let k = 0; k < 8; k += 1) {
    const killed = await child(
      `const e = open(${J(root)}, { recover: false, faults: (step) => { if (step === 'ref') process.exit(7); } });\n`
      + `await e.send(${J(id)}, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'п${k}' });\n`);
    assert.equal(killed.code, 7, `отправитель п${k}: ${killed.err || 'stderr пуст'}`);
  }
  // Три восстановителя и один читатель разом: читатель уносит ссылки в history, а
  // восстановители в это же время дописывают недостающие. Сверка ДВУХ мест — inbox и
  // history — здесь и работает: без неё прочитанное вернулось бы читателю второй раз.
  const kids = await racers(4,
    `const e = open(${J(root)}, { recover: false });\n`
    + `if (i === 0) { const r = e.read(${J(id)}, 'w-api'); console.log('read ' + r.messages.map((m) => m.body).join(' ')); }\n`
    + `else { e.recover(${J(id)}); console.log('heal'); }\n`);
  exitedZero(kids);
  const out = kids.map((k) => k.out);
  const readLine = out.find((r) => r.startsWith('read')) ?? '';
  const gotFirst = readLine.slice('read '.length).split(' ').filter(Boolean);
  const engine = open(root);
  const gotSecond = engine.read(id, 'w-api').messages.map((m) => m.body);
  const all = [...gotFirst, ...gotSecond];
  assert.equal(new Set(all).size, all.length, `сообщение доставлено дважды: ${all.join(' ')}`);
  assert.deepEqual([...all].sort(), ['п0', 'п1', 'п2', 'п3', 'п4', 'п5', 'п6', 'п7']);
});

test('BL-447: открытие engine у соседа не рвёт идущую отправку', async (t) => {
  // Дом с несколькими пишущими процессами — обычный run: оркестратор и worker'ы. Engine
  // открывается лениво, и открытие прогоняет восстановление по всем задачам дома; без
  // лизинга оно подбирало не брошенный fan-out мёртвого, а идущий fan-out живого — снимало
  // intent из-под владельца, и тот получал `ENOENT` на `link`, то есть отказ на уже
  // доставленном сообщении. Здесь четверо шлют, четверо открывают engine раз за разом:
  // отказ отправителя виден кодом возврата, а не только недостачей в счёте (`BL-449`).
  const root = sandbox();
  const id = taskWith(open(root), 'lizing-t20260902-110700');
  const PER = 25;
  const kids = await racers(8,
    'if (i % 2 === 0) {\n'
    + `  const e = open(${J(root)});\n`
    + `  for (let k = 0; k < ${PER}; k += 1) {\n`
    + `    await e.send(${J(id)}, { from: 'w-api', to: ['owner'], type: 'status', body: i + '#' + k });\n`
    + '  }\n'
    + '} else {\n'
    + `  for (let k = 0; k < ${PER}; k += 1) open(${J(root)});\n`
    + '}\n');
  await t.test('BL-447: ни один отправитель не отказал', () => {
    exitedZero(kids);
  });
  await t.test('BL-447: доставлено всё, что отправлено', () => {
    exitedZero(kids);
    assert.equal(open(root).unread(id, 'owner'), 4 * PER);
  });
  await t.test('BL-447: незакрытых intent\'ов и осиротевших лизингов не осталось', () => {
    exitedZero(kids);
    assert.deepEqual(readdirSync(path.join(open(root).home, 'tasks', id, 'intents')), []);
  });
});

// ── Отказ жёсткой ссылки ──────────────────────────────────────────────────────────────

test('ФС отказала в жёсткой ссылке — типизированный код, а не половинчатая запись', async (t) => {
  // Требование к ФС наследуется целиком (ADR-032, §4): жёсткие ссылки внутри одного тома.
  // Отсутствие их — законное условие среды, и различаться оно обязано от поломки механизма.
  // Изображается оно каталогом без права записи: `link` отдаёт `EACCES` там же, где чужой
  // том отдал бы `EXDEV`.
  //
  // Под root прав каталога нет вовсе — `link` проходит, и отказ изобразить нечем. Способа
  // получить отказ, который root не обходит, у стенда нет: второго тома под тестом не
  // держат, а `chattr`/`chflags` непереносимы. Поэтому под `uid 0` проверка пропускает себя
  // вслух, а не зеленеет ни на чём. `getuid` есть не везде — на Windows его нет, и там
  // проверка идёт как шла.
  if (process.getuid?.() === 0) {
    t.skip('под root права каталога не действуют, отказ ссылки не изобразить; проверка идёт под непривилегированным пользователем');
    return;
  }
  const root = sandbox();
  const engine = open(root);
  const id = taskWith(engine, 'ssylka-t20260902-110600');
  const box = path.join(engine.home, 'tasks', id, 'inbox', 'w-api');
  mkdirSync(box, { recursive: true });
  chmodSync(box, 0o500);
  let refused = null;
  try {
    await engine.send(id, { from: 'owner', to: ['w-api', 'w-docs'], type: 'task', body: 'не пройдёт' });
  } catch (e) {
    refused = e;
  }
  await t.test('отказ ссылки: типизированный код и errno в контексте', () => {
    assert.ok(refused instanceof PromptobusError, String(refused));
    assert.equal(refused.code, 'link-refused');
    assert.ok(ERROR_CODES.includes(refused.code));
    assert.match(String(refused.context.errno), /^E[A-Z]+$/);
  });
  await t.test('отказ ссылки: fan-out не наполовину — intent открыт и доводится потом', () => {
    const stuck = openEngine({ root, policy: allowAll, recover: false });
    assert.equal(openIntents(path.join(stuck.home, 'tasks', id, 'intents')).length, 1);
    assert.equal(stuck.unread(id, 'w-docs'), 0, 'второй получатель ссылки не получил');
    chmodSync(box, 0o700);
    const healed = open(root);
    assert.equal(healed.unread(id, 'w-api'), 1);
    assert.equal(healed.unread(id, 'w-docs'), 1);
    assert.deepEqual(readdirSync(path.join(healed.home, 'tasks', id, 'intents')), []);
  });
  // Права возвращаются в любом случае: иначе уборка песочницы упрётся в закрытый каталог.
  if (existsSync(box)) chmodSync(box, 0o700);
});

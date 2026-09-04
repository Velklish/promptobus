// Package у своей границы там, где её не закрывает engine: словарь шины (адреса, идентичность
// задачи), лок журнала задачи и три чтения mailbox'а, заведённые вместе со снятием слоя
// совместимости, — `peekInbox`, `glanceInbox` и `lastSentAt`. Запуск — своя команда
// package: `npm test`.
//
// **Чего здесь больше нет и почему.** Раньше файл проверял слой совместимости — legacy
// поверхность поверх engine v1, — и половина его проверок звала одну и ту же операцию v1
// через фасад. Слоя нет, и каждая такая проверка уехала туда, где живёт её предмет:
// операции store — в [v1-engine.test.mjs](v1-engine.test.mjs), дверь механизма (журнал в
// адресах, кэш журнала, папка файлов задачи, отказ негодному адресату) — в
// наборе adapter'а потребителя.
// Поимённый разбор снятого — в результате задачи.
//
// Диагностика и идентичность сессии приходят АРГУМЕНТАМИ: package не читает окружение и в
// потоки процесса не пишет, и шва для подстановки у него больше нет вовсе.
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const store = await import('../dist/index.js');

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-store-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

// Routing policy обязательна при открытии engine, и правило её — дело adapter'а: здесь
// adapter'а нет, и его играет набор. Пример policy («worker'у нельзя писать worker'у»)
// живёт в CLI и проверяется там.
const engineAt = (home) => store.openEngine({ home, policy: () => ({ allow: true }) });

// Запись участника, какой её кладёт adapter: id — имя каталога mailbox'а, адрес — поле
// `metadata`, по которому участника называют человеку и ключуют файлы надзирателя.
function participant(address, fields = {}) {
  return {
    id: store.addrDir(address),
    role: store.roleOf(address),
    harness: 'proba',
    mode: 'attached',
    sessionRef: null,
    capabilities: null,
    metadata: { address, ...fields },
  };
}

// Что бросил вызов: класс и текст. Класс — по конструктору, как его читает верхний catch
// CLI (опознаёт `GateError` по имени класса, а не `instanceof`).
function thrown(fn) {
  try {
    fn();
    return { threw: false, name: '', msg: '' };
  } catch (e) {
    return { threw: true, name: e?.constructor?.name, msg: e.message };
  }
}

// --- словарь шины: адреса и идентичность задачи ------------------------------

test('адрес: orchestrator и worker:<slug> валидны', () => {
  assert.ok(store.isAddress('orchestrator') && store.isAddress('worker:cargos-api'));
});

test('адрес: посторонний отвергнут', () => {
  assert.ok(!store.isAddress('worker:') && !store.isAddress('boss') && !store.isAddress('worker:Bad Slug'));
});

test('адрес → каталог: двоеточие не уезжает в имя файла', () => {
  assert.equal(store.addrDir('worker:cargos-api'), 'worker-cargos-api');
  assert.equal(store.addrDir('orchestrator'), 'orchestrator');
});

// Роль считается ОДИН раз, при записи участника: store v1 держит её полем и из id не выводит.
test('адрес → роль: считается из адреса и кладётся полем записи', () => {
  assert.equal(store.roleOf('worker:cargos-api'), 'worker');
  assert.equal(store.roleOf('reviewer:cargos-api'), 'reviewer');
  assert.equal(store.roleOf('orchestrator'), 'orchestrator');
});

// Имя файлов участника в `workers/`: по нему их кладёт spawn и метёт уборка.
test('адрес → имя файлов участника: reviewer отличается от worker\'а', () => {
  assert.equal(store.participantFileStem('worker:cargos-api'), 'cargos-api');
  assert.equal(store.participantFileStem('reviewer:cargos-api'), 'reviewer-cargos-api');
});

// Адрес без слага имени файла не даёт, и прежде это молчало: склейка отдавала `undefined`,
// а путь конфига собирался из него как `undefined.mcp.json` — файл, которого не искал и не
// убирал никто. Отказ обязан называть адрес: маршрут сюда недостижим, и по
// одному тексту «слага нет» вызывающего не найти.
test('адрес без слага: имя файла участника не собирается, отказ называет адрес', () => {
  const stem = thrown(() => store.participantFileStem('orchestrator'));
  assert.ok(stem.threw && /orchestrator/.test(stem.msg), `${stem.threw} · ${stem.msg}`);
});

// идентичность задачи и id сообщения лежат в одном журнале. Сообщение штампуется
// через `toISOString`, то есть UTC; задача прежде брала местные getters. Подставной clock
// разводит обе зоны независимо от TZ машины теста: на UTC-машине настоящий Date скрыл бы
// прежнюю реализацию.
const UTC_CLOCK = {
  getUTCFullYear: () => 2026, getUTCMonth: () => 7, getUTCDate: () => 31,
  getUTCHours: () => 11, getUTCMinutes: () => 6, getUTCSeconds: () => 52,
  getFullYear: () => 1999, getMonth: () => 0, getDate: () => 1,
  getHours: () => 23, getMinutes: () => 59, getSeconds: () => 58,
};

test('id задачи штампуется по UTC, а не по местным getters', () => {
  const utcIdentity = store.newTaskIdentity('utc-proba', UTC_CLOCK);
  assert.equal(utcIdentity.id, 'utc-proba-t20260831-110652');
  assert.equal(utcIdentity.stamp, 't20260831-110652');
});

test('формат хвоста и чтение старых id не изменились', () => {
  assert.equal(store.stampOfId('utc-proba-t20260831-110652'), 't20260831-110652');
  assert.equal(store.stampOfId('staryy-t20250102-030405'), 't20250102-030405');
});

test('id задачи: путь наружу отвергнут', () => {
  assert.ok(thrown(() => store.taskDir(path.join(SB, 'ws'), '../../etc')).threw);
});

// --- accessor'ы полей adapter'а -------------------------------------
//
// Своих полей у записи участника пять — роль, harness, режим, session reference и снимок
// capabilities; всё прочее пишет adapter, и core заглядывает туда ровно этими семью
// именами. Россыпи `metadata.<поле>` по core нет: дверь одна, и проверка сторожит, что
// она отдаёт именно то поле, о котором говорит её имя.
test('accessor\'ы читают поля adapter\'а и молчат на пустом', () => {
  const full = participant('worker:a', {
    started: '2026-09-03T10:00:00.000Z', repoAbs: '/tmp/repo', dismissed: '2026-09-03T11:00:00.000Z',
    session: 'bg-1', name: 'Worker: кусок (0903-1000)', owner: 'sess-1',
  });
  assert.equal(store.addressOf(full), 'worker:a');
  assert.equal(store.startedOf(full), '2026-09-03T10:00:00.000Z');
  assert.equal(store.repoAbsOf(full), '/tmp/repo');
  assert.equal(store.dismissedOf(full), '2026-09-03T11:00:00.000Z');
  assert.equal(store.sessionOf(full), 'bg-1');
  assert.equal(store.nameOf(full), 'Worker: кусок (0903-1000)');
  assert.equal(store.ownerOf(full), 'sess-1');
  const bare = participant('worker:b');
  for (const read of [store.startedOf, store.repoAbsOf, store.dismissedOf, store.sessionOf,
    store.nameOf, store.ownerOf]) {
    assert.equal(read(bare), null);
  }
  assert.equal(store.addressOf(null), null);
});

// --- лок журнала задачи ------------------------------------

test('лок журнала задачи', async (t) => {
  const home = path.join(SB, 'lock', '.promptobus');
  const engine = engineAt(home);
  const heldTask = engine.createTask({
    id: 't20260827-100004', title: 'занятый лок', owner: participant('orchestrator'),
  });
  const heldLock = path.join(store.taskDir(home, heldTask.id), '.lock');
  const holdLock = (holder) => {
    mkdirSync(heldLock, { recursive: true });
    writeFileSync(path.join(heldLock, 'owner'), typeof holder === 'string' ? holder : `${JSON.stringify(holder)}\n`);
  };
  // Выдержку задаём швом `waitMs`: прежде эта единственная проверка в наборе выжидала весь
  // `LOCK_WAIT_MS`, то есть пять секунд на прогон ради одной строки.
  const takeLock = (opts = {}) => store.withTaskLock(home, heldTask.id, () => 'взят', { waitMs: 120, ...opts });

  // Вход через лок командой не достаётся: `taskExists` стоит выше по каждому маршруту, а
  // `task.json` лежит ВНУТРИ каталога задачи — состояния «журнал есть, каталога нет» без
  // гонки не бывает. Поэтому предмет здесь библиотечный и ровно тот, что читает верхний
  // catch CLI: имя класса (опознаёт его по имени, а не `instanceof`).
  await t.test('ENOENT под локом отвечает словами и классом отказа человеку', () => {
    const ghost = thrown(() => store.withTaskLock(home, 'net-takoy', () => 'не дойдёт'));
    assert.equal(ghost.name, 'GateError');
    assert.match(ghost.msg, /задачи net-takoy нет в/);
  });

  holdLock({ pid: process.pid, session: 'sess-derzhatel', since: '2026-08-28T10:00:00.000Z' });
  const busy = thrown(() => takeLock());
  await t.test('занятый лок — отказ, а не запись поверх чужого read-modify-write', () => {
    assert.ok(busy.threw && busy.msg.includes(heldLock), busy.msg);
  });
  await t.test('отказ называет держателя — pid, сессию и сколько ждали', () => {
    assert.ok(busy.msg.includes(`процесс ${process.pid}`), busy.msg);
    assert.ok(busy.msg.includes('сессия sess-derzhatel'), busy.msg);
    assert.match(busy.msg, /ждали \d+ мс/);
  });
  // Занятый журнал — законный отказ человеку («дождись его и повтори команду»), и класс у
  // него общий с остальным словарём: со стеком он читался бы как поломка CLI.
  await t.test('занятый журнал задачи — отказ человеку, а не поломка CLI', () => {
    assert.equal(thrown(() => takeLock()).name, 'GateError');
  });

  // Держателя пишет сам лок, и это отдельный предмет: проверки выше подкладывают файл
  // `owner` руками, поэтому пропажа сессии из записи осталась бы незамеченной — отказ
  // просто перестал бы её называть (мутационная проба 2026-08-28).
  rmSync(heldLock, { recursive: true, force: true });
  const ownerFile = () => JSON.parse(readFileSync(path.join(heldLock, 'owner'), 'utf8'));
  const insideOwner = store.withTaskLock(home, heldTask.id, ownerFile, { session: 'sess-moya' });
  await t.test('лок называет себя изнутри — pid этого процесса, сессия и время захвата', () => {
    assert.equal(insideOwner?.pid, process.pid);
    assert.equal(insideOwner.session, 'sess-moya');
    assert.ok(!Number.isNaN(Date.parse(insideOwner.since)), JSON.stringify(insideOwner));
  });

  // Идентичность сессии приходит АРГУМЕНТОМ, и другого источника у неё нет: переменная
  // сессии Claude Code при этом СТОИТ в окружении — иначе проверка говорила бы лишь о том,
  // что её нет, а предмет здесь другой. На эту проверку нацелена
  // мутационная проба «`process.env.CLAUDE_CODE_SESSION_ID` в исходнике package».
  const wasEnv = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-iz-okruzheniya';
  let noSession;
  try {
    noSession = store.withTaskLock(home, heldTask.id, ownerFile);
  } finally {
    if (wasEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = wasEnv;
  }
  await t.test('сессию локу называет вызывающий — package окружение не читает', () => {
    assert.equal(noSession.session, null);
    assert.equal(noSession.pid, process.pid);
  });

  // Лок без отметки владельца — законное наследие прежней версии: маршрут остаётся, но
  // номер по догадке не выдумывается. Мёртвым такой лок тоже не объявляется: между `mkdir` и
  // записью файла есть окно, и в нём безымянный лок — живой захват, а не сирота.
  mkdirSync(heldLock, { recursive: true });
  await t.test('держателя нет в локе — отказ говорит об этом, а не выдумывает номер', () => {
    const anon = thrown(() => takeLock());
    assert.ok(anon.threw && /лок не назвал/.test(anon.msg), anon.msg);
  });
  // осиротевший лок читается по живости pid, а не по наличию каталога. Процесс,
  // умерший внутри записи, иначе запирал бы журнал задачи навсегда: каждая следующая запись
  // досиживала бы таймаут и отказывала. Возраст лока при этом не значит ничего: у держателя
  // выше `since` годовалый, и лок остался.
  rmSync(heldLock, { recursive: true, force: true });
  holdLock({ pid: 2147483646, session: 'sess-umershaya', since: '2026-08-28T10:00:00.000Z' });
  await t.test('лок мёртвого процесса снимается сам — запись проходит, а каталог не остаётся', () => {
    assert.equal(takeLock(), 'взят');
    assert.ok(!existsSync(heldLock));
  });
  // Лок прежнего CLI держит голый pid строкой. Читается тем же чтением: `JSON.parse('999999')`
  // отдаёт число, а не запись, и без проверки на объект такой лок молча считался бы безымянным.
  holdLock('999999\n');
  await t.test('лок прежнего формата (голый pid) читается тем же чтением — мёртвый снимается', () => {
    assert.equal(takeLock(), 'взят');
    assert.ok(!existsSync(heldLock));
  });
  rmSync(heldLock, { recursive: true, force: true });

  // Повторный вход того же процесса. Read-modify-write двери берёт лок задачи, а операция
  // store внутри берёт ЕГО ЖЕ: без учёта своих локов процесс досиживал бы `waitMs` на самом
  // себе и отказывал «журнал занят», назвав держателем собственный pid (найдено
  // живым прогоном — `promptobus dismiss` падал именно так). Вложение законно: лок разводит
  // ПРОЦЕССЫ, а внутри процесса участок синхронный, и вложенный вызов — та же секция.
  await t.test('вложенный лок того же процесса входит в ту же секцию, а не ждёт себя', () => {
    // Сверять настенное время незачем: без учёта своих локов вложенный вызов не «медленный»,
    // а отказной — он досиживает свой `waitMs` и бросает. Проверяется исход, а не срок: под
    // нагрузкой соседних прогонов порог дрожал бы, а отказ — нет.
    const seen = store.withTaskLock(home, heldTask.id, () => {
      const outerOwner = ownerFile();
      const innerOwner = store.withTaskLock(home, heldTask.id, () => ownerFile(), { waitMs: 120 });
      return { outerOwner, innerOwner, insideExists: existsSync(heldLock) };
    }, { session: 'sess-vlozhennaya' });
    assert.deepEqual(seen.innerOwner, seen.outerOwner, 'внутренний вызов видит того же держателя');
    assert.equal(seen.innerOwner.session, 'sess-vlozhennaya', 'держателем остался внешний вызов');
    assert.equal(seen.insideExists, true);
  });
  // Снимает лок только тот вызов, который его взял: сними внутренний — внешний доработал бы
  // без лока вовсе, и сосед вошёл бы в его критическую секцию.
  await t.test('лок снимает взявший — после внутреннего вызова он ещё держится', () => {
    const held = store.withTaskLock(home, heldTask.id, () => {
      store.withTaskLock(home, heldTask.id, () => 'внутри');
      return existsSync(heldLock);
    });
    assert.equal(held, true, 'внутренний вызов снял чужой лок');
    assert.equal(existsSync(heldLock), false, 'внешний вызов лок не снял');
  });

  await t.test('лок снят — временных файлов и каталога лока в задаче не осталось', () => {
    assert.ok(!existsSync(heldLock));
    assert.ok(readdirSync(store.taskDir(home, heldTask.id)).every((n) => !n.startsWith('.tmp-')));
  });
});

// --- три чтения mailbox'а, которых нет у `read` ----------------------
//
// `read` забирает mailbox и уносит ссылки в history. Этим трём операциям он не годится:
// чужой сессии отдаётся копия, надзиратель заглядывает молча, а разбор стопа спрашивает
// «когда этот адрес последний раз выходил на шину». Раньше все три жили в слое
// совместимости и вместе с ним чуть не уехали.
test('peek, glance и lastSentAt — чтения, которые не забирают mailbox', async (t) => {
  const home = path.join(SB, 'peek', '.promptobus');
  const engine = engineAt(home);
  const task = engine.createTask({ id: 'peek-t20260903-000000', title: 'чтения', owner: participant('orchestrator') });
  engine.addParticipant(task.id, participant('worker:a'));
  for (const n of [1, 2, 3]) {
    engine.sendSync(task.id, { from: 'worker-a', to: ['orchestrator'], type: 'status', body: `цел ${n}` });
  }

  await t.test('peek: сообщения отданы, а mailbox остался полным', () => {
    const { messages, broken } = engine.peek(task.id, 'orchestrator');
    assert.equal(messages.map((m) => m.body).join(','), 'цел 1,цел 2,цел 3');
    assert.equal(broken.length, 0);
    assert.equal(engine.unread(task.id, 'orchestrator'), 3);
  });

  // Так выглядит файл процесса, умершего посреди записи прежним CLI (без link/rename).
  const box = engine.inboxPath(task.id, 'orchestrator');
  const dirtyName = '20260903T000000000-9999-abcdef.json';
  writeFileSync(path.join(box, dirtyName), '{"id": "20260903T0000');
  await t.test('peek: битое названо структурно и отложено, целое дошло', () => {
    const { messages, broken } = engine.peek(task.id, 'orchestrator');
    assert.equal(messages.length, 3);
    assert.equal(broken.length, 1);
    assert.equal(broken[0].name, dirtyName);
    // Причина и место разведены полями, а не склеены в строку: текст человеку собирает
    // adapter, и склейка заставляла бы его резать её обратно регексом.
    assert.match(broken[0].note, /не разобрано/);
    assert.ok(broken[0].attic && !existsSync(path.join(box, dirtyName)));
  });

  await t.test('glance: заглядывает молча — ни ссылок не трогает, ни битого не откладывает', () => {
    writeFileSync(path.join(box, dirtyName), 'не json вовсе');
    const seen = engine.glance(task.id, 'orchestrator');
    assert.equal(seen.map((m) => m.body).join(','), 'цел 1,цел 2,цел 3');
    assert.ok(existsSync(path.join(box, dirtyName)), 'битое осталось на месте');
    assert.equal(engine.unread(task.id, 'orchestrator'), 4);
    rmSync(path.join(box, dirtyName), { force: true });
  });

  await t.test('lastSentAt: время последней ОТПРАВКИ адреса, а не его непрочитанного', () => {
    const sent = engine.lastSentAt(task.id, 'worker-a');
    assert.ok(Number.isFinite(sent), String(sent));
    assert.equal(engine.lastSentAt(task.id, 'orchestrator'), null, 'оркестратор ещё не отправлял');
    // Разбор идёт инкрементально и переживает добавление: следующая отправка двигает время.
    const before = sent;
    engine.sendSync(task.id, { from: 'orchestrator', to: ['worker-a'], type: 'task', body: 'ответ' });
    assert.ok(engine.lastSentAt(task.id, 'orchestrator') >= before);
  });

  await t.test('read после peek: mailbox забран целиком, повторное чтение пусто', () => {
    const { messages } = engine.read(task.id, 'orchestrator');
    assert.equal(messages.map((m) => m.body).join(','), 'цел 1,цел 2,цел 3');
    assert.equal(engine.read(task.id, 'orchestrator').messages.length, 0);
    assert.equal(engine.unread(task.id, 'orchestrator'), 0);
  });
});

// --- жёсткая ссылка на blob под именем adapter'а ---------------------
//
// Папка файлов задачи — дело adapter'а, а путь blob'а наружу package не отдаёт.
// Дверь между ними одна — `linkBlob`, и она же занимает имя: `false` вместо тихой перезаписи.
test('linkBlob ставит ссылку и не перезаписывает занятое имя', () => {
  const home = path.join(SB, 'link', '.promptobus');
  const engine = engineAt(home);
  const task = engine.createTask({ id: 'link-t20260903-000000', title: 'ссылки', owner: participant('orchestrator') });
  engine.addParticipant(task.id, participant('worker:a'));
  const src = path.join(SB, 'contract.json');
  writeFileSync(src, '{"event":"CargoCreated"}\n');
  let placed = null;
  const dir = path.join(SB, 'files');
  const sent = engine.sendSync(task.id, {
    from: 'worker-a',
    to: ['orchestrator'],
    type: 'artifact',
    body: 'контракт',
    artifact: {
      path: src,
      name: (sha) => {
        placed = sha;
        return 'contract.json';
      },
    },
  });
  assert.equal(sent.artifact.filename, 'contract.json');
  assert.ok(engine.linkBlob(task.id, placed, path.join(dir, 'contract.json')));
  assert.match(readFileSync(path.join(dir, 'contract.json'), 'utf8'), /CargoCreated/);
  // Второй раз тем же именем — `false`, а не перезапись: следующее имя выбирает вызывающий.
  assert.equal(engine.linkBlob(task.id, placed, path.join(dir, 'contract.json')), false);
  assert.ok(engine.linkBlob(task.id, placed, path.join(dir, 'contract-2.json')));
});

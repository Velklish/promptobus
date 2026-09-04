// Дверь механизма в шину — `lib/store.js`. Здесь проверяется то,
// что делает ОНА, а не package: перевод адреса в запись участника v1, журнал задачи в полях
// механизма, папка файлов задачи, отказ незарегистрированному адресату, кэш журнала на один
// вызов инструмента и два канала доклада о битом.
//
// Проверки переехали сюда из набора store вместе с предметом: слой совместимости
// внутри package снят — package отдаёт одну поверхность v1, и всё, что говорит
// адресами и полями механизма, живёт в CLI. Что осталось в ядре: словарь шины, лок
// журнала, операции store ([v1-engine.test.mjs](v1-engine.test.mjs)) и три чтения
// mailbox'а ([store.test.mjs](store.test.mjs)).
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { captureSplit, quiet } from './console.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = realpathSync(makeSandbox('promptobus-promptobus-adapter-'));

const store = await import(path.join(here, '..', 'lib', 'store.js'));

const home = path.join(SB, 'ws', '.promptobus');

function thrown(fn) {
  try {
    fn();
    return { threw: false, name: '', msg: '' };
  } catch (e) {
    return { threw: true, name: e?.constructor?.name, msg: e.message };
  }
}

// --- журнал задачи в полях механизма ------------------------------------------

const task = store.createTask(home, {
  id: 't20260813-120000', title: 'трасса события через два сервиса', owner: null,
});

check('createTask: статус active, оркестратор участником по своему адресу',
  task.status === 'active' && store.addressOf(task.participants[0]) === store.ORCHESTRATOR,
  `${task.status} · ${store.addressOf(task.participants[0])}`);

check('createTask: заголовок читается обратно',
  store.readTask(home, task.id).title === 'трасса события через два сервиса');

// Слаг, штамп и пометка явного заголовка — поля МЕХАНИЗМА, и в журнале v1 они лежат в
// `adapter`: собственные поля задачи там — заголовок, статус, владелец и участники.
check('createTask: штамп задачи лежит в adapter журнала и пишется даже без слага',
  store.readTask(home, task.id).adapter.stamp === task.id
  && !store.readTask(home, task.id).adapter.slug,
  JSON.stringify(store.readTask(home, task.id).adapter));

// --- запись участника: адрес отсекается до записи -----------------------------

// : негодный адрес отсекается до записи. Проверяем и класс отказа, и диск: `GateError`
// после записи выглядел бы правильно, но оставил бы порченый журнал.
const beforeInvalid = JSON.stringify(store.readTask(home, task.id).participants);
const invalid = thrown(() => store.upsertParticipant(home, task.id,
  store.participantRecord('worker:Плохой Адрес', { repo: 'ns/repo' })));

check(': запись участника отвергает негодный адрес через GateError',
  invalid.name === 'GateError' && /invalid participant address/.test(invalid.msg),
  `${invalid.name} · ${invalid.msg}`);

check(': отказ произошёл до записи — участники задачи не изменились',
  JSON.stringify(store.readTask(home, task.id).participants) === beforeInvalid);

// Адресаты проверок ниже числятся участниками задачи: с  сообщение уходит только
// тому, кто есть в журнале, а заводит его там spawn — живого spawn'а здесь нет.
for (const address of ['worker:a', 'worker:b']) {
  store.upsertParticipant(home, task.id, store.participantRecord(address, { repo: 'ns/repo' }));
}

check('запись участника: адрес лежит в metadata, роль и id — свои поля v1', (() => {
  const p = store.participantOf(store.readTask(home, task.id), 'worker:a');
  return p.id === 'worker-a' && p.role === 'worker' && p.metadata.address === 'worker:a'
    && p.metadata.repo === 'ns/repo' && p.harness === store.FALLBACK_HARNESS;
})());

// --- файлы участника в `workers/` ------------------------------------------------

// Имя файлов участника выводится из его адреса одной функцией; считают его spawn, ревью и
// уборка `promptobus done` — три разных предмета, у которых общий только журнал, и разойдись
// копии, уборка мела бы мимо. Адрес без слага имени не даёт вовсе, и молчать об этом нельзя:
// прежде склейка отдавала `undefined`, а путь собирался как `undefined.mcp.json` — файл,
// которого не искал и не убирал никто.
check(': путь mcp-config участника собран из его адреса',
  /workers[\\/]cargos-api\.mcp\.json$/.test(store.participantMcpPath(home, task.id, 'worker:cargos-api'))
  && /workers[\\/]reviewer-cargos-api\.settings\.json$/.test(
    store.participantSettingsPath(home, task.id, 'reviewer:cargos-api')),
  `${store.participantMcpPath(home, task.id, 'worker:cargos-api')} · ${store.participantSettingsPath(home, task.id, 'reviewer:cargos-api')}`);

const noSlug = thrown(() => store.participantMcpPath(home, task.id, store.ORCHESTRATOR));
const noSlugSettings = thrown(() => store.participantSettingsPath(home, task.id, store.ORCHESTRATOR));
check(': адрес без слага пути не даёт — отказ называет адрес, а не молчит',
  noSlug.threw && /orchestrator/.test(noSlug.msg)
  && noSlugSettings.threw && /orchestrator/.test(noSlugSettings.msg),
  `${noSlug.msg} · ${noSlugSettings.msg}`);

// --- валидация отправки -------------------------------------------------------

const bad = (patch) => thrown(() => store.sendMessage(home, task.id, {
  from: store.ORCHESTRATOR, to: 'worker:a', type: 'task', body: 'текст', ...patch,
}));

check('валидация: чужой тип сообщения отвергнут', bad({ type: 'gossip' }).threw
  && /protocol/i.test(bad({ type: 'gossip' }).msg));
check('валидация: unknown recipient address отвергнут', bad({ to: 'somebody' }).threw);
check('валидация: пустой body отвергнут', bad({ body: '   ' }).threw);

const rejectedType = store.MESSAGE_TYPES.filter((t) => thrown(() => store.sendMessage(home, task.id, {
  from: store.ORCHESTRATOR, to: 'worker:a', type: t, body: t,
})).threw);
check(`валидация: все ${store.MESSAGE_TYPES.length} типов протокола приняты`,
  rejectedType.length === 0, rejectedType.join(', '));

// --- routing policy ATI: worker'у нельзя писать worker'у ------------------------

// Правило задаёт потребитель, и у механизма оно одно: переписываются только с оркестратором
// задачи ( §3 — «routing policy обязательна, правило передаёт потребитель»).
// Проверки на него не было ни одной: мутационная проба  (разрешить worker → worker)
// оставляла зелёными и `promptobus-mcp.test.mjs`, и E2E, и весь корневой набор.
const between = thrown(() => store.sendMessage(home, task.id, {
  from: 'worker:a', to: 'worker:b', type: 'status', body: 'мимо оркестратора',
}));
check('policy ATI: worker worker\'у не пишет — отказ, а не тихая доставка',
  between.threw && /do not write to each other/.test(between.msg), `${between.threw} · ${between.msg}`);

check('policy ATI: отказ называет маршрут — through the orchestrator',
  /through the orchestrator/.test(between.msg) && /pass this to them/.test(between.msg), between.msg);

// Отказ не имеет права оставить в задаче ни байта: ни ссылки в mailbox'е получателя, ни
// записи отправителя. Порядок тот же, что у engine, — policy спрашивается ДО side effect.
check('policy ATI: отказ ничего не положил — mailbox получателя пуст',
  store.countInbox(home, task.id, 'worker:b') === 0);

// Обе законные стороны проходят: правило запрещает ровно «участник → участник».
const toOrch = thrown(() => store.sendMessage(home, task.id, {
  from: 'worker:a', to: store.ORCHESTRATOR, type: 'status', body: 'участник оркестратору',
}));
const fromOrch = thrown(() => store.sendMessage(home, task.id, {
  from: store.ORCHESTRATOR, to: 'worker:b', type: 'task', body: 'оркестратор участнику',
}));
check('policy ATI: «участник → оркестратор» и «оркестратор → участник» проходят',
  !toOrch.threw && !fromOrch.threw, `${toOrch.msg} · ${fromOrch.msg}`);

// Reviewer — такой же участник: правило смотрит на роль записи, а не на префикс адреса.
store.upsertParticipant(home, task.id, store.participantRecord('reviewer:a', { repo: 'ns/repo' }));
const workerToReviewer = thrown(() => store.sendMessage(home, task.id, {
  from: 'worker:a', to: 'reviewer:a', type: 'question', body: 'напрямую ревьюеру',
}));
check('policy ATI: worker и reviewer между собой тоже не переписываются',
  workerToReviewer.threw && /do not write to each other/.test(workerToReviewer.msg),
  workerToReviewer.msg);

// --- доставка адресами --------------------------------------------------------

const { messages: inbox } = store.readInbox(home, task.id, 'worker:a');

check('inbox: пришли все отправленные, в порядке отправки',
  inbox.length === store.MESSAGE_TYPES.length
  && inbox.map((m) => m.type).join(',') === store.MESSAGE_TYPES.join(','),
  inbox.map((m) => m.type).join(','));

// Канон несёт ID записи участника; адрес человеку собирает тот, кто печатает.
check('inbox: отправитель и получатель — id участников, задача и штамп на месте',
  inbox[0].task === task.id && inbox[0].sender === 'orchestrator'
  && inbox[0].recipients.join(',') === 'worker-a'
  && typeof inbox[0].ts === 'string' && typeof inbox[0].id === 'string',
  JSON.stringify(inbox[0]));

check('inbox: повторное чтение пусто — прочитанное ушло',
  store.readInbox(home, task.id, 'worker:a').messages.length === 0);

check('inbox: счётчик непрочитанного', store.countInbox(home, task.id, 'worker:a') === 0);

// --- артефакты в папке файлов задачи ------------------------------------------

const artSrc = path.join(SB, 'contract.json');
writeFileSync(artSrc, '{"event":"CargoCreated"}\n');
const withArt = store.sendMessage(home, task.id, {
  from: 'worker:a', to: store.ORCHESTRATOR, type: 'artifact', body: 'контракт события', artifactPath: artSrc,
});

check('артефакт: жёсткая ссылка в папке файлов задачи под своим именем',
  withArt.artifact.filename === 'contract.json'
  && /CargoCreated/.test(readFileSync(path.join(store.filesDir(home, task.id), 'contract.json'), 'utf8')),
  withArt.artifact.filename);

writeFileSync(artSrc, '{"event":"CargoUpdated"}\n');
const withArt2 = store.sendMessage(home, task.id, {
  from: 'worker:b', to: store.ORCHESTRATOR, type: 'artifact', body: 'второй контракт', artifactPath: artSrc,
});

check('артефакт: одноимённый не затирает прежний — имя занимает сама ссылка',
  withArt2.artifact.filename === 'contract-2.json'
  && /CargoCreated/.test(readFileSync(path.join(store.filesDir(home, task.id), 'contract.json'), 'utf8')),
  withArt2.artifact.filename);

const noFile = thrown(() => store.sendMessage(home, task.id, {
  from: store.ORCHESTRATOR, to: 'worker:a', type: 'artifact', body: 'нет файла',
  artifactPath: path.join(SB, 'ghost.txt'),
}));
check('артефакт: несуществующий путь → отказ', noFile.threw && /артефакта нет/.test(noFile.msg), noFile.msg);
store.readInbox(home, task.id, store.ORCHESTRATOR);

// --- жизненный цикл задачи ----------------------------------------------------

check('resolveTaskId: одна активная задача — она и есть текущая',
  store.resolveTaskId(home, null, null) === task.id);

const second = store.createTask(home, { id: 't20260813-130000', title: 'вторая', owner: null });
const many = thrown(() => store.resolveTaskId(home, null, null));
check('resolveTaskId: несколько активных → отказ со списком',
  many.threw && many.msg.includes(task.id) && many.msg.includes(second.id), many.msg);

check('resolveTaskId: явное объявление сильнее поиска',
  store.resolveTaskId(home, second.id, null) === second.id);

store.closeTask(home, second.id);
check('closeTask: задача закрыта, отметка закрытия лежит в adapter, активной снова одна',
  store.readTask(home, second.id).status === 'done'
  && typeof store.readTask(home, second.id).adapter.closed === 'string'
  && store.resolveTaskId(home, null, null) === task.id);

check('resolveTaskId: несуществующая задача → отказ',
  thrown(() => store.resolveTaskId(home, 'нет-такой', null)).threw);

// --- : сообщение несуществующему адресату -------------------------------

const bl156 = path.join(SB, 'bl156', '.promptobus');
const addressed = store.createTask(bl156, { id: 't20260827-110000', title: 'адресация', owner: null });
store.upsertParticipant(bl156, addressed.id,
  store.participantRecord('worker:cargos-api', { repo: 'loads_search/cargos-api' }));
const ghostArt = path.join(SB, 'bl156-artifact.json');
writeFileSync(ghostArt, '{"never":"sent"}\n');
const toGhost = thrown(() => store.sendMessage(bl156, addressed.id, {
  from: store.ORCHESTRATOR, to: 'worker:opechatka', type: 'task', body: 'бриф в пустоту', artifactPath: ghostArt,
}));

check(': адресат вне участников задачи — отказ, а не тихий успех',
  toGhost.threw && toGhost.msg.includes('worker:opechatka'), toGhost.msg);

check(': отказ называет участников задачи — опечатка в слаге чинится с одного взгляда',
  toGhost.msg.includes('worker:cargos-api') && toGhost.msg.includes('orchestrator'), toGhost.msg);

check(': mailbox-призрак не заведён',
  !existsSync(path.join(store.taskDir(bl156, addressed.id), 'inbox', 'worker-opechatka')));

// Проверка адресата стоит до записи артефакта: отказ не должен оставлять в папке файлов
// задачи файл, которого никто не заказывал.
check(': артефакт отвергнутого сообщения в задачу не скопирован',
  !existsSync(path.join(store.filesDir(bl156, addressed.id), 'bl156-artifact.json')));

const toKnown = store.sendMessage(bl156, addressed.id, {
  from: store.ORCHESTRATOR, to: 'worker:cargos-api', type: 'task', body: 'бриф участнику',
});
check(': участнику задачи сообщение уходит по-прежнему',
  toKnown.message.recipients.join(',') === 'worker-cargos-api'
  && store.countInbox(bl156, addressed.id, 'worker:cargos-api') === 1);

// --- два канала доклада о битом ------------------------------------------------

// Доклад о нечитаемом идёт в два канала: диагностика человеку (stderr adapter'а) и список
// агенту (у MCP-пути stderr читает harness, а не сессия, и без списка сообщение исчезало бы
// молча). Package при этом в потоки процесса не пишет вовсе — строку собирает дверь.
const bl250 = path.join(SB, 'bl250', '.promptobus');
const dirty = store.createTask(bl250, { id: 'bitoe-t20260829-040000', title: 'битый вход', owner: null });
store.upsertParticipant(bl250, dirty.id, store.participantRecord('worker:a'));
for (const n of [1, 2, 3]) {
  store.sendMessage(bl250, dirty.id, {
    from: 'worker:a', to: store.ORCHESTRATOR, type: 'status', body: `цел ${n}`,
  });
}
const dirtyBox = store.inboxDir(bl250, dirty.id, store.ORCHESTRATOR);
const dirtyName = '20260829T040000000-9999-abcdef.json';
writeFileSync(path.join(dirtyBox, dirtyName), 'не json вовсе');
const read = captureSplit(() => store.readInbox(bl250, dirty.id, store.ORCHESTRATOR));

check('битый файл впереди очереди не уносит целые — все три дошли до читателя',
  read.value.messages.map((m) => m.body).join(',') === 'цел 1,цел 2,цел 3',
  read.value.messages.map((m) => m.body).join(','));

check('доклад агенту: список broken называет файл по имени и место, куда он отложен',
  read.value.broken.some((m) => m.includes(dirtyName) && m.includes('broken')),
  read.value.broken.join(' | '));

check('доклад человеку: та же строка ушла в stderr двери, а не в потоки package',
  read.err.includes(dirtyName), read.err);

check('mailbox больше не заткнут — прочитанное уехало, битого в нём нет',
  store.countInbox(bl250, dirty.id, store.ORCHESTRATOR) === 0
  && !existsSync(path.join(dirtyBox, dirtyName)));

// --- : журнал задачи читается раз на запрос ------------------------------

// Резолв задачи, гейт владельца, тревога о notification'е, шапка ответа и сам рендер
// спрашивают журнал каждый порознь: на один вызов инструмента приходилось четыре-шесть
// чтений и разборов. Кэш живёт ровно столько, сколько обёрнутый им синхронный участок;
// признак того, что чтение одно, — сам диск: файл сносится между двумя чтениями.
const bl261 = path.join(SB, 'bl261', '.promptobus');
const cached = store.createTask(bl261, { id: 'kesh-t20260829-070000', title: 'кэш журнала', owner: null });
const cachedFile = store.taskFile(bl261, cached.id);
const cachedRaw = readFileSync(cachedFile, 'utf8');
let inSpan = null;
const spanTry = thrown(() => {
  inSpan = store.withTaskCache(() => {
    const first = store.readTask(bl261, cached.id);
    rmSync(cachedFile, { force: true });
    return [first.title, store.readTask(bl261, cached.id).title];
  });
});
check(': внутри запроса журнал читается один раз — второе чтение диска не касается',
  !spanTry.threw && inSpan?.join('|') === 'кэш журнала|кэш журнала', spanTry.msg || String(inSpan));

writeFileSync(cachedFile, cachedRaw);
const outOfSpan = thrown(() => {
  rmSync(cachedFile, { force: true });
  store.readTask(bl261, cached.id);
});
check(': вне запроса чтение прежнее — снесённый журнал отказывает, как и раньше',
  outOfSpan.threw && /нет в/.test(outOfSpan.msg), outOfSpan.msg);

writeFileSync(cachedFile, cachedRaw);
const afterWrite = store.withTaskCache(() => {
  store.readTask(bl261, cached.id);
  store.patchTask(bl261, cached.id, { title: 'переименована' });
  return store.readTask(bl261, cached.id).title;
});
check(': запись журнала гасит кэш — следующее чтение того же хода видит новое',
  afterWrite === 'переименована', afterWrite);

// Под локом читается диск, а не кэш: read-modify-write обязан видеть то, что записал сосед,
// которого лок и дождался. Соседа изображает запись мимо двери — так кэш остаётся с прежним
// снимком. Пишется ЗАПИСЬ STORE, а не её вид: журнал versioned, и вид без версии читатель
// не примет — правкой соседа он бы и не был.
const sneaky = { ...JSON.parse(readFileSync(cachedFile, 'utf8')), title: 'правка соседа' };
const underLock = store.withTaskCache(() => {
  store.readTask(bl261, cached.id);
  writeFileSync(cachedFile, JSON.stringify(sneaky, null, 2) + '\n');
  const seen = store.withTaskLock(bl261, cached.id, () => store.readTask(bl261, cached.id).title);
  return [seen, store.readTask(bl261, cached.id).title];
});
check(': под локом журнал читается с диска, а лок на выходе гасит кэш запроса',
  underLock.join('|') === 'правка соседа|правка соседа', underLock.join('|'));

// --- перечисление переживает битый журнал --------------------------------------

const bl149 = path.join(SB, 'bl149', '.promptobus');
const sane = store.createTask(bl149, { id: 't20260827-100000', title: 'исправная', owner: null });
const brokenTask = store.createTask(bl149, { id: 't20260827-100001', title: 'битая', owner: null });
// Так выглядит журнал процесса, умершего посреди неатомарной записи.
writeFileSync(store.taskFile(bl149, brokenTask.id), '{\n  "id": "t20260827-1000');
const listed = captureSplit(() => store.listTasks(bl149));

check(': битый журнал не валит перечисление — исправная задача на месте',
  listed.value.map((t) => t.id).join(',') === sane.id, listed.value.map((t) => t.id).join(','));

check(': пропущенная задача названа человеку по её файлу',
  listed.err.includes(brokenTask.id) && listed.err.includes('task.json'), listed.err);

mkdirSync(path.join(store.tasksDir(bl149), 'не id задачи'), { recursive: true });
check(': посторонний каталог рядом с задачами отсеян, а не брошен отказом',
  !thrown(() => quiet(() => store.listTasks(bl149))).threw);

// --- : граница adapter'а — к driver'у ходят только через registry ---------
//
// Второй production driver обязан класться в карту `harness → driver`, не трогая ни одного
// файла за её пределами. Держится это тем, что никто, кроме самой карты, driver'а не
// импортирует: строка `import … from './driver-claude.js'` в любом модуле механизма и есть
// та связь, из-за которой каждый следующий harness пришлось бы разводить по всем этим
// файлам поимённо.
//
// Гейт стоит здесь, а не в наборе package: тот сторожит ОБРАТНОЕ направление — имён
// harness'ов в исходниках ядра ([promptobus-package.test.mjs](promptobus-package.test.mjs)).
// Проверяется весь `lib/**` и `bin/**`: команда, дотянувшаяся до driver'а мимо
// карты, ломает границу так же, как модуль шины.
//
// Мутационная проба: верни `import { stallRoute } from './driver-claude.js'` в `status.js` —
// гейт краснеет с именем файла и именем импортируемого модуля.

// Файлы самих driver'ов: карта, два driver'а и их реестры сессий. Им импорт друг друга
// законен — это один предмет, разложенный по файлам.
const DRIVER_OWN = new Set([
  'lib/drivers.js',
  'lib/driver-claude.js',
  'lib/liftoff.js',
  'lib/driver-cursor.js',
  'lib/cursor-persist.js',
  'lib/driver-codex.js',
  'lib/codex-rpc.js',
  'lib/codex-session.js',
  'lib/codex-hold.js',
]);

// Модули, которых снаружи не касаются вовсе: сами driver'ы и их реестры сессий. Карта
// (`drivers.js`) в перечень не входит — она и есть дверь, и её импортируют все.
const DRIVER_PRIVATE = /(?:^|\/)(driver-claude|liftoff|driver-cursor|cursor-persist|driver-codex|codex-rpc|codex-session|codex-hold)\.js$/;

// Спецификатор модуля в статическом импорте, реэкспорте и динамическом `import(...)`.
// Прозы это не касается: перед кавычкой обязано стоять `from` или `import`.
const MODULE_SPEC = /(?:\bfrom|\bimport)\s*\(?\s*'([^']+)'/g;

function jsFilesUnder(dir, rel, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, e.name);
    const key = `${rel}/${e.name}`;
    if (e.isDirectory()) jsFilesUnder(at, key, out);
    else if (e.name.endsWith('.js')) out.push([key, at]);
  }
  return out;
}

const MECHANISM_ROOT = path.join(here, '..');
const adapterFiles = [
  ...jsFilesUnder(path.join(MECHANISM_ROOT, 'lib'), 'lib'),
  ...jsFilesUnder(path.join(MECHANISM_ROOT, 'bin'), 'bin'),
];

const crossings = [];
for (const [rel, file] of adapterFiles) {
  if (DRIVER_OWN.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(MODULE_SPEC)) {
    if (!DRIVER_PRIVATE.test(m[1])) continue;
    crossings.push(`${rel} → ${m[1]} (строка ${text.slice(0, m.index).split('\n').length})`);
  }
}

check(': гейт границы видит файлы механизма — есть что проверять',
  adapterFiles.length > 20 && adapterFiles.some(([rel]) => rel === 'lib/status.js')
  && adapterFiles.some(([rel]) => rel === 'bin/promptobus.js'),
  `${adapterFiles.length} файлов`);

check(': driver и его реестр сессий не импортирует никто, кроме карты registry',
  crossings.length === 0, crossings.join(' | '));

// Дверь одна, и она не пустая: карта обязана импортировать driver сама — иначе гейт выше
// был бы зелен на механизме, у которого driver'ов нет вовсе.
const doorSrc = readFileSync(path.join(MECHANISM_ROOT, 'lib', 'drivers.js'), 'utf8');
check(': карта registry импортирует driver сама — гейт не зелен на пустоте',
  /from '\.\/driver-claude\.js'/.test(doorSrc)
  && /export const REGISTRY/.test(doorSrc), doorSrc.split('\n').slice(0, 3).join(' | '));

// : driver'ов в карте двое, и оба взяты ею самой. Проверка не дубль предыдущей: та
// держит гейт от пустоты, эта — от карты, в которой второй production driver объявлен, но
// не подключён, и `--harness cursor` отказывал бы «неизвестный harness».
check(': карта registry держит оба production driver’а — claude и cursor',
  /from '\.\/driver-cursor\.js'/.test(doorSrc)
  && /\[CLAUDE\]: claudeDriver/.test(doorSrc) && /\[CURSOR\]: cursorDriver/.test(doorSrc),
  doorSrc.split('\n').filter((l) => /driver-|Driver/.test(l)).join(' | '));
check(': карта registry держит третий production driver — codex',
  /from '\.\/driver-codex\.js'/.test(doorSrc) && /\[CODEX\]: codexDriver/.test(doorSrc),
  doorSrc.split('\n').filter((l) => /codex|CODEX/.test(l)).join(' | '));

// Наружу из driver'а больше не торчат половины подъёма: `spawn.js` и `review.js` собирали
// argv и конфиг сами, зовя `driver.spawnArgv` и `driver.mcpConfig`. Теперь это одна
// операция `prepare`, и вернуть половины значит вернуть сборку команды за пределы driver'а.
const driverSrc = readFileSync(path.join(MECHANISM_ROOT, 'lib', 'driver-claude.js'), 'utf8');
check(': сборка argv и конфига наружу не экспортируется — она половина `prepare`',
  !/^export function (spawnArgv|mcpConfig)\b/m.test(driverSrc),
  (driverSrc.match(/^export function \w+/gm) ?? []).join(', '));

// --- : поверхность driver'а — только объявленная контрактом ---------------
//
// Гейт границы выше держит ИМПОРТ: driver берут дверью, а не напрямую. Он не держит второго
// — что у взятого объекта зовут ровно то, что контракт объявил. Ревью нашло четыре таких
// расхождения разом: `probeWake` в объявлении против `checkWake` в реализации и у
// потребителя, `sessionEnv` с одним параметром против двух на вызове, незаявленный
// `shadowedUserServers` и необязательные `options`/`phrases`, которые adapter разыменовывает
// без проверки. Ни одно импортом не ловится: driver-то взят правильно.
//
// Разбор идёт по ОБЪЯВЛЕНИЯМ `driver.ts`, а не по подстроке: имя, встреченное в его прозе,
// объявлением не является, и гейт, читающий файл целиком, зеленел бы на комментарии.
//
// Соглашение, которое гейт этим и держит: driver кладётся в переменную `driver` или
// `lifter` (либо полем `.driver` плана), а словари берутся членом — `.options.<имя>`,
// `.phrases.<имя>`, `.capabilities.<имя>`. Помощник, отдающий словарь целиком, спрятал бы
// имя от разбора, и поверхность снова перестала бы сверяться.

const DRIVER_TS = path.join(MECHANISM_ROOT, 'src', 'driver.ts');

/** Тело интерфейса по имени — со счётом скобок: внутри есть вложенные объектные типы. */
function interfaceBody(src, name) {
  const head = `export interface ${name} {`;
  const at = src.indexOf(head);
  if (at < 0) return null;
  let i = at + head.length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    i += 1;
  }
  return depth === 0 ? src.slice(at + head.length, i - 1) : null;
}

/** Имена членов интерфейса: поле или метод в начале строки, `readonly` и `?` — необязательны. */
function interfaceMembers(src, name) {
  const body = interfaceBody(src, name);
  if (body === null) return null;
  const out = new Set();
  for (const line of body.split('\n')) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\??\s*[(:]/.exec(line);
    // Строки комментариев отсекаются признаком, а не совпадением: `* `foo`: что-то` в
    // JSDoc иначе прочиталось бы объявлением.
    if (m && !/^\s*(?:\/\/|\/?\*)/.test(line)) out.add(m[1]);
  }
  return out;
}

const driverTs = readFileSync(DRIVER_TS, 'utf8');
const SURFACE = {
  Driver: interfaceMembers(driverTs, 'Driver'),
  DriverPhrases: interfaceMembers(driverTs, 'DriverPhrases'),
  DriverOptions: interfaceMembers(driverTs, 'DriverOptions'),
  DriverCapabilities: interfaceMembers(driverTs, 'DriverCapabilities'),
};

check(': объявления контракта разобраны — есть с чем сверять',
  Object.entries(SURFACE).every(([, set]) => set && set.size >= 4)
  && SURFACE.Driver.has('prepare') && SURFACE.Driver.has('stop')
  && SURFACE.DriverPhrases.has('sessions') && SURFACE.DriverOptions.has('effortLevels')
  && SURFACE.DriverCapabilities.has('denyTools'),
  Object.entries(SURFACE).map(([k, v]) => `${k}: ${v ? [...v].join(',') : 'не разобран'}`).join(' | '));

// Проза объявлением не считается — это и отличает разбор от грепа. Слова ниже в `driver.ts`
// есть (в комментариях и в соседних типах), а членами четырёх интерфейсов не являются:
// наивная редакция «имя встречается в файле» покрасила бы эту проверку.
const PROSE_ONLY = ['registry', 'notification', 'harness', 'participant'];
check(': имя из прозы driver.ts объявленным не считается — разбор по объявлениям, не по подстроке',
  PROSE_ONLY.every((word) => driverTs.includes(word)
    && !Object.values(SURFACE).some((set) => set.has(word))),
  PROSE_ONLY.filter((w) => Object.values(SURFACE).some((set) => set.has(w))).join(', ') || 'ни одно');

// Комментарии срезаются перед разбором — тем же приёмом, что у границы package: проза
// законно называет операции driver'а, и гейт, читающий её наравне с кодом, краснел бы на
// пересказе. Строчный комментарий берётся только с начала строки: `//` бывает и в URL.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((l) => !/^\s*(?:\/\/|\*)/.test(l)).join('\n');
}

const USE = {
  // `.options.<имя>`, `.phrases.<имя>`, `.capabilities.<имя>` — словарь берут членом.
  member: /\.(options|phrases|capabilities)\??\.([A-Za-z_]\w*)/g,
  // Деструктуризация словаря: `const { a, b: c } = <что-то>.options;`.
  destructure: /(?:const|let)\s*\{([^}]+)\}\s*=\s*[^;]*?\.(options|phrases)\b/g,
  // Словарь взят в переменную целиком: `const HARNESS = <что-то>.options;`.
  bind: /(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*[^;]*?\.(options|phrases)\s*;/g,
  // Операция driver'а: обращение к переменной, в которой он лежит.
  op: /\b(?:driver|lifter)\??\.([A-Za-z_]\w*)/g,
};
const IFACE = { options: 'DriverOptions', phrases: 'DriverPhrases', capabilities: 'DriverCapabilities' };

const undeclared = [];
const seen = { Driver: new Set(), DriverPhrases: new Set(), DriverOptions: new Set(), DriverCapabilities: new Set() };
for (const [rel, file] of adapterFiles) {
  if (DRIVER_OWN.has(rel)) continue;
  const text = stripComments(readFileSync(file, 'utf8'));
  const want = (iface, name) => {
    seen[iface].add(name);
    if (!SURFACE[iface].has(name)) undeclared.push(`${rel}: ${iface}.${name}`);
  };
  for (const m of text.matchAll(USE.member)) want(IFACE[m[1]], m[2]);
  for (const m of text.matchAll(USE.destructure)) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_]\w*$/.test(key)) want(IFACE[m[2]], key);
    }
  }
  for (const m of text.matchAll(USE.bind)) {
    const iface = IFACE[m[2]];
    for (const use of text.matchAll(new RegExp(`\\b${m[1]}\\??\\.([A-Za-z_]\\w*)`, 'g'))) want(iface, use[1]);
  }
  for (const m of text.matchAll(USE.op)) want('Driver', m[1]);
}

check(': adapter зовёт у driver’а только объявленное контрактом',
  undeclared.length === 0, undeclared.join(' | '));

// Гейт, не нашедший обращений, зелен на пустоте — а именно так он и выглядел бы, разойдись
// соглашение об имени переменной с кодом.
check(': гейт видит поверхность driver’а — операции, словарь опций и слова',
  seen.Driver.size >= 8 && seen.DriverOptions.size >= 4 && seen.DriverPhrases.size >= 2,
  `Driver: ${[...seen.Driver].sort().join(',')} · options: ${[...seen.DriverOptions].sort().join(',')}`
  + ` · phrases: ${[...seen.DriverPhrases].sort().join(',')}`);

// --- : обязательный словарь объявлен КАЖДЫМ production driver'ом -----------
//
// Гейт поверхности выше держит одну сторону — что adapter зовёт только объявленное. Вторая
// сторона зеркальна: что каждый driver карты объявил всё, что контракт назвал обязательным.
// Ни одна из них не ловит другую. Цена невыполнения известна поимённо: без `defaultModel`
// участник поднимается моделью, которой у его бинаря нет, а без `promptRules` его промпт
// молча теряет правила harness'а.
//
// Обязательность читается из самого `driver.ts`: член со знаком `?` необязателен, и
// требовать его значило бы выдумывать контракт за него.
function requiredMembers(src, name) {
  const body = interfaceBody(src, name);
  const out = new Set();
  for (const line of (body ?? '').split('\n')) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)(\??)\s*[(:]/.exec(line);
    if (m && !/^\s*(?:\/\/|\/?\*)/.test(line) && !m[2]) out.add(m[1]);
  }
  return out;
}

const REQUIRED = {
  options: requiredMembers(driverTs, 'DriverOptions'),
  phrases: requiredMembers(driverTs, 'DriverPhrases'),
};
const { REGISTRY } = await import(path.join(MECHANISM_ROOT, 'lib', 'drivers.js'));
const missingSurface = [];
for (const [harness, driver] of Object.entries(REGISTRY.drivers)) {
  for (const key of ['options', 'phrases']) {
    for (const name of REQUIRED[key]) {
      if (driver[key]?.[name] === undefined) missingSurface.push(`${harness}: ${key}.${name}`);
    }
  }
}
check(': обязательный словарь контракта объявлен каждым driver’ом карты',
  missingSurface.length === 0 && REQUIRED.options.has('defaultModel') && REQUIRED.phrases.has('tool')
  && Object.keys(REGISTRY.drivers).length >= 2,
  `${missingSurface.join(' | ') || 'все объявлены'} · driver'ов ${Object.keys(REGISTRY.drivers).length}`);

// Слова harness'а в adapter'е законны только у driver'а. Печать status/stalls/notification/
// warden — harness-neutral: маршрут и подтверждение («job not found») приходят phrases
// или stallRoute. Отсечка — перечень файлов печати: без неё греп краснеет на spawn/review,
// где `claude --bg` — предмет подъёма, не печать состояния.
const PRINT_SURFACE = new Set([
  'lib/status.js',
  'lib/stalls.js',
  'lib/notification.js',
  'lib/warden.js',
]);
check(': поверхность печати найдена в adapterFiles — гейт не зелен на переименовании',
  [...PRINT_SURFACE].every((rel) => adapterFiles.some(([r]) => r === rel)),
  [...PRINT_SURFACE].filter((rel) => !adapterFiles.some(([r]) => r === rel)).join(', ') || 'все на месте');
const HARNESS_WORDS = /job not found|claude |agent |codex /;
function harnessWordHits(rel, text, { comments = false } = {}) {
  return (comments ? text : stripComments(text)).split('\n')
    .filter((line) => HARNESS_WORDS.test(line))
    .map((line) => `${rel}: ${line.trim().slice(0, 90)}`);
}
const surfaceHits = [];
const naiveHits = [];
for (const [rel, file] of adapterFiles) {
  if (DRIVER_OWN.has(rel)) continue;
  const text = readFileSync(file, 'utf8');
  // Print surface is judged on code: comments may name a harness as the subject of
  // a lift (`claude --bg` in spawn.js). Naive grep keeps comments so the cutoff
  // is proven non-empty — dest adapter code outside drivers is already clean.
  naiveHits.push(...harnessWordHits(rel, text, { comments: true }));
  if (PRINT_SURFACE.has(rel)) surfaceHits.push(...harnessWordHits(rel, text));
}
check(': harness-neutral печать не содержит слов harness’ов',
  surfaceHits.length === 0, surfaceHits.join(' | '));
check(': отсечка гейта не пустая — наивный греп без неё ложно срабатывает',
  naiveHits.length > surfaceHits.length, naiveHits.slice(0, 4).join(' | '));

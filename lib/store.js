import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { warn, writeFileAtomic } from './util.js';
import {
  addrDir, addressOf, bindingNames, brokenNote, dropBinding, FOREIGN_MARK,
  FOREIGN_ROUTE,
  foreignSessionOf,
  GateError, isAddress, MECHANISM_VERSION_FIELD, MESSAGE_TYPES, migrate, splitLegacyRel,
  newTaskIdentity, onTaskLock,
  openEngine, ORCHESTRATOR, ownerOf, participantFileStem, preflight, PromptobusError,
  readBinding, requireTaskId,
  roleOf, ROOT_DIR, sameSession, sessionFile, sessionOf, stampOfId, TASK_TITLE_SEP, taskDir,
  tasksDir, validate,
  withTaskLock as lockTask, workersDir, writeBinding,
} from '../dist/index.js';

// Adapter шины над Promptobus. Ядро — задачи, участники,
// mailbox'ы, артефакты, восстановимый fan-out, история, файлы каталога задачи и MCP-factory
// — живёт в TypeScript-ядре package'а и о рабочем месте не знает ничего.
//
// Здесь остаётся то, что ядру знать и не положено: поиск корня рабочего места, путь к store
// внутри него, идентичность сессии, человеческая диагностика, routing policy
// и грамматика адресов механизма.
//
// **Слоя совместимости больше нет**. У package одна поверхность — v1, и
// потребители шины зовут её моделями v1: `TaskV1` (заголовок, статус, участники, `adapter`
// с полями механизма), `ParticipantV1` (id, роль, harness, режим, session reference,
// capabilities и `metadata` механизма), `MessageV1` (отправитель и получатели — id
// участников). Обещания «имена и сигнатуры прежние» этот модуль не даёт вовсе: он дверь
// механизма, а не второй слой над ядром. Хелперы, которых v1 не даёт и дать не может —
// перевод адреса в запись участника, вокабуляр гейта чужого mailbox'а, заголовок задачи из
// track'ов, привязки «сессия → задача», — живут здесь явно и без обещаний совместимости.
//
// **Импорт идёт путём до `dist`, а не именем пакета.** Из чекаута команда работает
// только после сборки — `npm run build`. Пользователя tarball это не касается: `dist`
// едет в пакете.
//
// Все остальные модули шины продолжают импортировать `./store.js`: граница проходит здесь,
// и знать про `dist` им незачем.
export {
  // адреса и грамматика
  ORCHESTRATOR, isAddress, addrDir, roleOf, addressOf, workerAddress, reviewerAddress,
  participantFileStem, SLUG_MAX, slugify, newTaskIdentity, stampOfId, TASK_TITLE_SEP,
  // вокабуляр гейта чужого mailbox'а
  GateError, FOREIGN_MARK, FOREIGN_ROUTE, MAILBOX_CLAIMED_MARK, foreignTaskLine, claimRoute,
  brokenNote,
  // идентичность сессии в записи участника и её сверка
  sessionOf, sessionIdOf, sameSession, foreignSessionOf,
  // типы сообщений, коды отказа protocol v1 и лизинг незакрытого fan-out'а
  MESSAGE_TYPES, ERROR_CODES, PromptobusError, INTENT_STALE_MS,
  // пути каталога задачи и файлы, которых не держит store
  taskDir, tasksDir, workersDir, sessionsDir, sessionFile, wakeFile, healthFile,
  wardenLogFile, wardenMarkFile,
  // живость и надзиратель
  pidAlive, WARDEN_BEAT_SEC, liveWarden, claimWarden, beatWarden, clearWarden,
  readWake, writeWake, readHealth, writeHealth, logWarden, tailWardenLog,
  // отметки конца хода
  lastTurnAt, markTurn,
  // отказ занятого лока журнала
  lockBusyError,
} from '../dist/index.js';

// Корень store шины внутри рабочего места. Это `.promptobus`: переписка,
// участники и артефакты лежат в protocol v1.
// Отсюда же имя берёт переменная окружения `PROMPTOBUS_HOME`.
export const PROMPTOBUS_REL = ROOT_DIR;

// Harness записей, которые его не называют вовсе: журнал прежнего CLI. То же значение, что
// `fallback` driver registry — взять его импортом отсюда нельзя (registry тянет driver, а
// тот этот же модуль), поэтому копия здесь, а держит их вместе проверка набора:
// `REGISTRY.fallback === FALLBACK_HARNESS`.
export const FALLBACK_HARNESS = 'claude';

export function promptobusHome(root, host) {
  if (host == null) {
    throw new Error('promptobusHome: host обязателен — отсутствие прежней раскладки объявляет host.legacyLayout(), а не пропуск аргумента');
  }
  ensureStore(root, host);
  return path.join(root, PROMPTOBUS_REL);
}

/**
 * Корень рабочего места по объявленному каталогу store.
 *
 * Опознаются два хвоста — новый (`.promptobus`) и прежний, если host его объявил
 * через `legacyLayout()`. `legacyLayout() === null` — законный путь standalone:
 * прежней раскладки нет, мигрировать не из чего, хвост не опознан, дом берётся как есть.
 * Опознан — переезд запускается тем же ходом, что и у команды, а устаревший `PROMPTOBUS_HOME`
 * несинхронизированного конфига резолвится в НОВЫЙ корень, а не воссоздаёт старый
 * каталог рядом с переехавшим. Не опознан — каталог берётся как есть: домом бывает
 * произвольный каталог (так его задаёт набор), и придумывать ему корень нельзя.
 */
function rootOfHome(home, host) {
  if (host == null) {
    throw new Error('rootOfHome: host обязателен — отсутствие прежней раскладки объявляет host.legacyLayout(), а не пропуск аргумента');
  }
  const abs = path.resolve(home);
  if (path.basename(abs) === PROMPTOBUS_REL) return path.dirname(abs);
  const layout = host?.legacyLayout?.() ?? null;
  if (!layout?.rel) return null;
  const parts = splitLegacyRel(layout.rel);
  if (!parts) return null;
  const [outer, inner] = parts;
  const parent = path.dirname(abs);
  if (path.basename(abs) === inner && path.basename(parent) === outer) return path.dirname(parent);
  return null;
}

// Миграция прежнего каталога → `.promptobus` при ПЕРВОМ обращении. Дверей в store
// две, и обе ведут сюда: `promptobusHome(root, host)` — у команд, ищущих корень от cwd, и
// `resolveIdentity` — у процессов, которым дом объявлен переменной `PROMPTOBUS_HOME`. Вторая
// обязательна наравне с первой: `PROMPTOBUS_HOME` задают и конфиг участника, и canonical-список
// рабочего места, поэтому самое частое первое касание store — вызов инструмента шины из
// любой сессии, и через `promptobusHome` он не идёт вовсе.
//
// Отказ preflight'а (активные задачи, оба корня сразу, повреждённый корень) — законный
// исход и приезжает `GateError`'ом: верхний catch печатает его без стека, а MCP-сервер
// отдаёт текстом ответа инструмента. Доклад об удавшемся переносе идёт в stderr: stdout у
// MCP-сервера занят протоколом целиком, и посторонняя строка в нём ломает клиента.
//
// Помнится сделанное ПО КОРНЮ, а не одним флагом на процесс: корней у процесса бывает
// несколько — так ходит набор, и так же ходит команда, которой корень назвали аргументом.
const migrated = new Set();

function ensureStore(root, host) {
  if (host == null) {
    throw new Error('ensureStore: host обязателен — отсутствие прежней раскладки объявляет host.legacyLayout(), а не пропуск аргумента');
  }
  if (migrated.has(root)) return;
  const plan = preflight(root, host);
  if (!plan.needed && !plan.refusal) {
    migrated.add(root);
    return;
  }
  if (plan.refusal) throw new GateError(plan.refusal);
  // Идентичность сессии и имя harness'а переносу подаёт adapter: первое — диагностике
  // занятого лока переезда, второе — записям прежнего CLI, у которых поля `harness` нет
  // вовсе, а v1 требует его в каждой записи участника.
  const report = migrate(root, { session: sessionIdentity(), harness: FALLBACK_HARNESS, host });
  migrated.add(root);
  // Ничего не делали: переносить было нечего либо всё сделал сосед — переезд идёт из двух
  // процессов сразу, и проигравший уходит ни с чем. Молчим: доклад числами на пустом
  // отчёте сказал бы «задач 0, сообщений 0, прежний каталог снят» там, где сосед перенёс
  // семьдесят одну задачу, — то есть соврал бы ровно той строкой, которая обещана
  // пользователю как доклад.
  if (!report.moved) return;
  if (report.resumed) {
    warn(`шина: прежний каталог ${report.from} снесён — перенос был доделан прошлым запуском`);
    return;
  }
  const msgs = report.tasks.reduce((n, t) => n + t.messages, 0);
  const arts = report.tasks.reduce((n, t) => n + t.artifacts, 0);
  const broken = report.tasks.reduce((n, t) => n + t.broken.length, 0);
  warn(`шина переехала в ${report.to}: задач ${report.tasks.length}, сообщений ${msgs}, `
    + `артефактов ${arts}, привязок сессий ${report.bindings}`
    + `${broken ? `, отложено битых записей ${broken}` : ''}`
    + `${report.brokenTasks.length ? `, повреждённых задач ${report.brokenTasks.length} (в migration-broken)` : ''}`
    + `. Прежний каталог ${report.from} снят: старый CLI новый store не читает.`);
}

// Идентичность сессии — единственная переменная, на которую можно опереться: у каждой
// сессии своя, до дочернего процесса MCP-сервера доходит и переживает `--resume`
// (проверено живьём). Соседние врут: `CLAUDE_PID` и `CLAUDE_EFFORT` протекают от предка,
// `CLAUDE_CODE_HOST_SESSION_ID` общий у всей семьи. Нет её — механизм владельца молчит.
export function sessionIdentity(env = process.env) {
  return env.CLAUDE_CODE_SESSION_ID?.trim() || null;
}

// --- engine v1 -------------------------------------------------------------------

// Routing policy — правило «кто кому вправе писать». Обязательна при открытии engine, и
// задаёт её потребитель: core ролей не знает и берёт их из записей участников.
//
// Правило шины: переписываются только с оркестратором задачи. Worker'ы и reviewer'ы между
// собой не общаются — контекст и артефакты идут через него; описание инструмента `send`
// говорит это с самого появления шины, а исполнять его стало чем только с protocol v1.
export function atiRouting(sender, recipient) {
  if (sender.role === ORCHESTRATOR || recipient.role === ORCHESTRATOR) return { allow: true };
  return {
    deny: true,
    reason: `${sender.role}'ы и ${recipient.role}'ы между собой не переписываются — `
      + 'контекст и артефакты идут через оркестратора: перешли это ему, он передаст',
  };
}

// Engine на home: открытие восстанавливает незакрытые fan-out'ы всех задач, и делать это на
// каждый вызов store незачем. Ключ — сам home: процесс CLI работает с одним, а набор
// заводит по временному каталогу на файл.
const engines = new Map();

/**
 * Engine v1 этого дома — единственная дверь механизма в store. Каталог store подаётся
 * целиком: у механизма он приходит переменной окружения, и `.promptobus` в конце может не
 * стоять вовсе.
 */
export function bus(home, { cli } = {}) {
  const hit = engines.get(home);
  if (hit) return hit;
  // Версия механизма называется при открытии — оба пути, команда CLI и MCP-сервер шины,
  // идут через эту дверь, поэтому смесь версий они читают одинаково.
  const engine = openEngine({ home, policy: atiRouting, cli: cli ?? '0.0.0' });
  engines.set(home, engine);
  return engine;
}

/**
 * Отказ v1 — человеку. Коды `task-not-found`, `task-broken`, `lock-busy` и остальные
 * адресованы тому, кто набрал команду, поэтому уезжают `GateError`'ом: голый `Error`
 * верхний catch CLI печатает со стеком, и законный отказ читается как поломка
 * самого механизма. Ветвиться по коду вызывающий вправе и сам — `ERROR_CODES` уходят
 * наружу отсюда же.
 */
function gate(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PromptobusError) throw new GateError(e.message);
    throw e;
  }
}

// --- участники: адрес ↔ запись v1 ------------------------------------------------

/**
 * Запись участника v1 из адреса и полей механизма.
 *
 * Собственные поля v1 — `id`, `role`, `harness`, `mode`, `sessionRef`, `capabilities`; всё
 * остальное, что механизм пишет про участника (заголовок track'а, репозиторий, имя сессии,
 * время подъёма, отметка снятия с наблюдения), едет в `metadata` целиком, и адрес лежит
 * там же: по нему участника называют человеку и по нему ключуются health, contact point'ы
 * и отметки стопа.
 */
export function participantRecord(address, fields = {}) {
  if (!isAddress(address)) {
    throw new GateError(`недопустимый адрес участника «${address}» — `
      + 'ожидается orchestrator, worker:<slug> или reviewer:<slug>');
  }
  const declared = typeof fields.harness === 'string' ? fields.harness.trim() : '';
  const ref = typeof fields.sessionRef === 'string' && fields.sessionRef ? fields.sessionRef
    : (typeof fields.name === 'string' && fields.name ? fields.name : null);
  const raw = typeof fields.mode === 'string' ? fields.mode.trim() : '';
  return {
    id: addrDir(address),
    role: roleOf(address),
    harness: declared || FALLBACK_HARNESS,
    // Режим обязателен схемой. Правило то же, что у `modeOf` контракта driver'а: сессию за
    // участником поднимал spawn, значит `managed`; сессии нет — `attached`, как у owner'а.
    mode: raw === 'managed' || raw === 'attached' ? raw : (ref ? 'managed' : 'attached'),
    sessionRef: ref,
    capabilities: capsOf(fields.capabilities ?? null),
    // Версия механизма, сделавшего запись. Она и есть свидетельство смеси версий:
    // читатель прежнего релиза спотыкается о поля, которых не знает, и без неё отвечает
    // «журнал не по схеме» вместо «начни новую сессию».
    metadata: { ...fields, address, [MECHANISM_VERSION_FIELD]: fields[MECHANISM_VERSION_FIELD] ?? '0.0.0' },
  };
}

// Снимок capabilities кладётся только целым: половина снимка не значит ничего, а схема
// такую запись всё равно не примет.
function capsOf(value) {
  return validate('participant', {
    id: 'x', role: 'x', harness: 'x', mode: 'attached', sessionRef: null, capabilities: value, metadata: {},
  }).ok ? value : null;
}

// Файлы участника в `workers/` — по его адресу: их кладёт подъём, их же метёт уборка
// `promptobus done`. Склейка имени живёт в package (`participantFileStem`), каталог — в
// sidecar; здесь только две двери, которыми их зовёт механизм.
export function participantMcpPath(home, taskId, address) {
  return path.join(workersDir(home, taskId), `${participantFileStem(address)}.mcp.json`);
}

export function participantSettingsPath(home, taskId, address) {
  return path.join(workersDir(home, taskId), `${participantFileStem(address)}.settings.json`);
}

/**
 * КАТАЛОГИ участника в `workers/` — те, что driver завёл рядом с его файлами.
 * Имя каталога выбирает driver, поэтому механизм узнаёт их по общему стеблю адреса, а не по
 * имени: у driver'а Cursor это рабочее место reviewer'а с его `.cursor/`, у Claude Code их
 * нет вовсе. Метёт их та же уборка `promptobus done`, что и mcp-конфиги: внутри лежит
 * конфиг MCP с подставленными токенами.
 */
export function participantDirs(home, taskId, address) {
  const dir = workersDir(home, taskId);
  const stem = `${participantFileStem(address)}.`;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(stem))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Участник задачи по его адресу; `null` — такого в журнале нет. */
export function participantOf(meta, address) {
  return (meta?.participants ?? []).find((p) => addressOf(p) === address) ?? null;
}

/** Адреса участников задачи, в порядке записи. Негодные записи пропускаются. */
export function addressesOf(meta) {
  return (meta?.participants ?? []).map((p) => addressOf(p)).filter(Boolean);
}

// --- журнал задачи ---------------------------------------------------------------

export function taskExists(home, id) {
  return typeof id === 'string' && bus(home).taskExists(id);
}

export function taskFile(home, id) {
  return bus(home).taskFile(requireTaskId(id));
}

export function inboxDir(home, id, addr) {
  return bus(home).inboxPath(requireTaskId(id), addrDir(addr));
}

/** Прочитанное этим адресом: в v1 каталог называется `history/` — по имени файла в нём
 * восстановление fan-out'а и отличает доставленное от недостающего. */
export function historyDir(home, id, addr) {
  return bus(home).historyPath(requireTaskId(id), addrDir(addr));
}

/** Куда откладывается нечитаемое из mailbox'а этого адреса. */
export function brokenDir(home, id, addr) {
  return bus(home).brokenPath(requireTaskId(id), addrDir(addr));
}

// Кэш журнала на один запрос: один вызов инструмента шины читает журнал по четыре-шесть
// раз из мест, которые друг о друге не знают. Живёт ровно столько, сколько обёрнутый
// синхронный участок: за его пределами сосед правит журнал законно. Гасят его запись
// журнала и лок задачи. Инвариант читателя: результат `readTask` под кэшем не мутировать.
let taskCache = null;

export function withTaskCache(fn) {
  const outer = taskCache;
  taskCache = outer ?? new Map();
  try {
    return fn();
  } finally {
    taskCache = outer;
  }
}

// Кэш снимается на время лока: под ним журнал меняется и своей записью, и чужой, которую
// лок дождался. Сам лок живёт в package и о кэшах не знает.
onTaskLock((fn) => {
  const outer = taskCache;
  taskCache = null;
  try {
    return fn();
  } finally {
    taskCache = outer;
    outer?.clear();
  }
});

export function readTask(home, id) {
  const key = `${home}\u0000${requireTaskId(id)}`;
  const hit = taskCache?.get(key);
  if (hit) return hit;
  const meta = gate(() => bus(home).readTask(id));
  taskCache?.set(key, meta);
  return meta;
}

/** Read-modify-write журнала под локом задачи, с идентичностью сессии для диагностики. */
export function withTaskLock(home, id, fn, opts = {}) {
  return lockTask(home, id, fn, { session: sessionIdentity(), ...opts });
}

/** Поправить журнал: заголовок и поля механизма в `adapter`. Поля `adapter` сливаются. */
export function patchTask(home, id, patch) {
  const meta = gate(() => bus(home).patchTask(id, patch));
  taskCache?.clear();
  return meta;
}

/**
 * Завести задачу ПО ЖУРНАЛЬНОЙ ФОРМЕ: `{ id, title, adapter }` — та же, какую отдаёт
 * `readTask`. Форма одна намеренно: план команды несёт журнал, который она положит, и
 * читает его теми же полями, какими его прочтёт следующая команда — слаг, штамп и пометка
 * явного заголовка лежат в `adapter`, собственные поля задачи там заголовок и статус.
 *
 * Сессия-владелец mailbox'а — не поле задачи: она уезжает в `metadata` записи участника
 * `orchestrator`, и пишется только когда окружение дало идентичность.
 */
export function createTask(home, {
  id = newTaskIdentity().id, title, adapter: fields = {}, owner = sessionIdentity(),
} = {}) {
  requireTaskId(id);
  if (taskExists(home, id)) throw new Error(`задача ${id} уже есть`);
  // Штамп пишется всегда: без него `readableTail` откатывается на полный id — человек
  // читает `(t20260827-175756)` вместо `(0827-1757)`.
  const taskStamp = fields.stamp ?? stampOfId(id);
  const adapter = { ...fields, ...(taskStamp ? { stamp: taskStamp } : {}) };
  mkdirSync(taskDir(home, id), { recursive: true });
  let meta;
  try {
    // Заведение «первым выигрывает» — флагом `wx` внутри v1: между проверкой и записью
    // помещается второй первый spawn того же run'а, и опоздавший через `rename` молча
    // перетёр бы участников ушедшего вперёд.
    //
    // Владелец задачи — участник `orchestrator`. Сессия-владелец его mailbox'а лежит полем
    // `owner` в `metadata`: это владение адресом, а не владение задачей. Пишем его, только
    // если окружение дало идентичность, — иначе механизм владельца выключен.
    meta = bus(home).createTask({
      id,
      title: title ?? id,
      owner: participantRecord(ORCHESTRATOR, owner ? { owner } : {}),
      adapter,
    });
  } catch (e) {
    if (e instanceof PromptobusError && e.code === 'task-exists') throw new Error(`задача ${id} уже есть`);
    if (e instanceof PromptobusError) throw new GateError(e.message);
    throw e;
  }
  // Каталоги mailbox'а владельца и файлов задачи — как их заводил прежний store: пустой
  // mailbox и пустая папка файлов видны человеку сразу после `spawn`.
  mkdirSync(inboxDir(home, id, ORCHESTRATOR), { recursive: true });
  mkdirSync(filesDir(home, id), { recursive: true });
  return meta;
}

// Перечисление переживает и посторонний каталог, и битый журнал: одна порченая задача
// иначе гасила бы каждую команду шины — `listTasks` кормит `resolveTaskId`.
export function listTasks(home) {
  const { tasks, broken } = bus(home).listTasks();
  // Текст собирается здесь, а не приезжает готовой строкой: id и причина приходят парой,
  // и человеку нужен ещё путь файла — по нему он и чинит.
  for (const { id, note } of broken) {
    warn(`задача ${id} пропущена: ${taskFile(home, id)} не читается (${note})`);
  }
  return [...tasks].sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

export function activeTasks(home) {
  return listTasks(home).filter((t) => t.status === 'active');
}

export function closeTask(home, id) {
  const meta = gate(() => bus(home).closeTask(id, { adapter: { closed: new Date().toISOString() } }));
  taskCache?.clear();
  return meta;
}

// Активная задача процесса. Три источника, по убыванию силы: явное объявление
// (аргумент инструмента, `--task`, `PROMPTOBUS_TASK`), привязка сессии, вывод «единственной
// активной» — запасной путь для тех, у кого идентичности нет; его гейты и сторожат.
//
// Все три отказа адресованы человеку — опечатка в id, пустой журнал, несколько активных
// задач разом, — поэтому бросаются `GateError`'ом: голый `Error` верхний catch CLI
// печатает со стеком, и законный отказ читается как поломка самого механизма.
export function resolveTaskId(home, declared, session = sessionIdentity()) {
  if (declared) {
    if (!taskExists(home, declared)) throw new GateError(`задачи ${declared} нет в ${tasksDir(home)}`);
    return declared;
  }
  const bound = boundTaskId(home, session);
  if (bound) return bound;
  const active = activeTasks(home);
  if (active.length === 1) return active[0].id;
  if (active.length === 0) {
    throw new GateError(`активной задачи нет: ${tasksDir(home)} пуст или все задачи закрыты. `
      + 'Задача заводится при spawn\'е первого worker\'а: promptobus spawn --repo <имя> --brief <файл>');
  }
  throw new GateError(`активных задач несколько (${active.map((t) => t.id).join(', ')}), `
    + `а привязки у этой сессии нет${session ? '' : ' — окружение не дало её идентичности'} — `
    + 'укажи нужную (PROMPTOBUS_TASK для сессии, --task для команды). '
    + 'Задача твоя, а сессия новая — забери mailbox себе: mailbox {claim: true, task: <id>}, '
    + 'дальше она резолвится сама. Нужен новый run — заведи его через promptobus spawn --new-task.');
}

// Mailbox, из которого читали и в который писали, называется в каждом ответе шины: home,
// задача, адрес. Задачу зовём и по имени: чужую задачу выдаёт тема, id не выдаёт. Тут же
// называется расхождение «сессия привязана к A, журнал говорит B» — оно законно.
export function identityLabel(home, task, addr, session = null) {
  const { title } = readTask(home, task);
  const named = title && title !== task ? `${task} «${title}»` : task;
  const bound = session ? boundTaskId(home, session) : null;
  const drift = bound && bound !== task ? ` · привязка сессии ${session}: задача ${bound}` : '';
  return `PROMPTOBUS_HOME=${home} · задача=${named} · адрес=${addr}${drift}`;
}

// --- участники ---------------------------------------------------------------------

/**
 * Положить участника целиком, заменив прежнюю запись. Подъём кладёт НОВУЮ запись — новая
 * сессия, новый снимок capabilities, — и уносит с ней всё, что относилось к прежней, в том
 * числе отметку снятия с наблюдения.
 */
export function upsertParticipant(home, id, participant) {
  const meta = gate(() => bus(home).putParticipant(id, participant));
  taskCache?.clear();
  return meta;
}

// Снятие участника с наблюдения: сессию закрыл сам оркестратор, а надзирателю неоткуда об
// этом знать — без отметки он докладывал бы «ИСЧЕЗ» о закрытом. Дом отметки — запись
// участника в журнале: держи её процесс, его смерть возвращала бы доклады. Возвращается
// `{ found, was }`: «участника нет» и «отметка уже стояла» — два разных ответа.
function setDismissed(home, id, address, at) {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = participantOf(meta, address);
    if (!p) return { found: false, was: null };
    const was = p.metadata.dismissed ?? null;
    // Состояние уже такое, каким его просят сделать, — журнал не трогаем: повторный
    // dismiss не переписывает время снятия, а возврат под наблюдение не пишет журнал у не
    // снятого — самый частый случай на переревью, и он стоил бы лока задачи.
    if (Boolean(was) === Boolean(at)) return { found: true, was };
    // Возврат — УДАЛЕНИЕ поля, а не `null` в нём: `dismissed: null` пришлось бы отличать
    // от снятия каждому читателю журнала, а поле проверяется на истинность.
    const { dismissed, ...rest } = p.metadata;
    gate(() => bus(home).patchParticipant(id, p.id, {
      metadata: at ? { ...rest, dismissed: at } : rest,
    }));
    taskCache?.clear();
    return { found: true, was };
  });
}

export function dismissParticipant(home, id, address, at = new Date().toISOString()) {
  return setDismissed(home, id, address, at);
}

// Возврат под наблюдение — там, где участнику даётся новая работа. Подъём заново снимает
// отметку сам (запись кладётся целиком), переревью живой сессии — этим вызовом.
export function watchParticipant(home, id, address) {
  return setDismissed(home, id, address, null);
}

// Заголовок задачи из заголовков её track'ов: иначе run из трёх track'ов читался бы работой
// одной. Считается по ВСЕМУ журналу и зовётся ПОСЛЕ записи участника — два spawn'а от
// одного пре-имиджа дали бы «A · B» и «A · C», и победитель потерял бы чужой track.
// Пустой список — не повод переименовывать: у задачи прежнего CLI поля `title` нет.
export function titleFromLines(meta) {
  const lines = [...new Set((meta?.participants ?? [])
    .filter((p) => String(addressOf(p) ?? '').startsWith('worker:') && p.metadata?.title)
    .map((p) => p.metadata.title))];
  return lines.length ? lines.join(TASK_TITLE_SEP) : null;
}

// Заголовок задачи пишется задним числом: подсадка нового track'а его дописывает, а
// `--task-title` пришпиливает насмерть (`titleExplicit`). Одна дверь есть —
// перештамповка: `restamp` ставит план по двойной явности (`--task-title` плюс явный
// `--task`), а право проверяется здесь тем же `ownership`, что у всей шины — под локом, а
// не в плане: mailbox мог сменить владельца после сборки плана.
export function retitleTask(home, id, {
  title = null, fromLines = false, explicit = false, restamp = false, session = null,
} = {}) {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    if (meta.adapter.titleExplicit && !(restamp && !ownership(home, id, ORCHESTRATOR, session).gated)) return null;
    // `fromLines` считает ЗДЕСЬ и только здесь: предсказание для `--dry-run` живёт
    // отдельным полем намерения (`preview`), которого эта функция не читает.
    const next = fromLines ? titleFromLines(meta) : title;
    if (!next || next === meta.title) {
      // Пометка ставится и тогда, когда заголовок уже такой: иначе явно названный
      // человеком заголовок остался бы незащищённым от следующей подсадки.
      if (explicit) patchTask(home, id, { adapter: { titleExplicit: true } });
      return null;
    }
    patchTask(home, id, { title: next, ...(explicit ? { adapter: { titleExplicit: true } } : {}) });
    return next;
  });
}

// --- владение mailbox'ом и захват --------------------------------------------------

// Владелец адреса `orchestrator` — сессия, при которой задача завелась: `promptobus spawn` и
// `promptobus review` запускаются Bash'ем из неё и наследуют её идентичность.
export function taskOwner(home, id) {
  return ownerOf(participantOf(readTask(home, id), ORCHESTRATOR));
}

export function ownership(home, id, addr, session) {
  if (addr !== ORCHESTRATOR) return { gated: false, owner: null, session };
  const owner = taskOwner(home, id);
  if (!owner || !session) return { gated: false, owner, session };
  return { gated: owner !== session, owner, session };
}

/**
 * Один ли это id владельца mailbox'а `orchestrator`. Обе стороны полные
 * (`CLAUDE_CODE_SESSION_ID`): `registerWake` и поле `owner` кладут одно и то же.
 * Префикс `sameSession` здесь fail-open — короткий id совпал бы с чужим полным,
 * у которого те же первые восемь hex, и погасил бы hint преемника и строку status.
 */
export function sameOwnerSession(a, b) {
  const x = typeof a === 'string' ? a.trim() : '';
  const y = typeof b === 'string' ? b.trim() : '';
  return Boolean(x && y && x === y);
}

/**
 * Пишет за адрес участника ЧУЖАЯ сессия? Возвращает сессию из журнала, за которой адрес
 * закреплён, или `null` — пишет своя либо сверить нечем.
 *
 * Гейт нужен потому, что окружение фоновой сессии harness выдаёт не то, с которым её
 * поднимали: замер 2026-09-03 на `claude` 2.1.251 — тройка `PROMPTOBUS_*` достаётся сессии
 * от процесса, поднявшего демон, то есть от ПЕРВОГО spawn'а run'а. Идентичность хука эта
 * задача забрала в аргументы его команды, а гейт остаётся вторым рубежом: он держит и то,
 * что зовут руками, и участника, поднятого прежним релизом.
 *
 * Само правило сверки — в core (`foreignSessionOf`), один дом на все двери гейта. Здесь
 * остаётся то, что core знать не положено: чтение журнала рабочего места и то, что владение
 * адресом `orchestrator` этим гейтом не ведается — там своё (`ownership` выше), его сессию
 * никакой driver не поднимал.
 */
export function foreignSession(home, id, addr, session) {
  if (!session || addr === ORCHESTRATOR) return null;
  try {
    return foreignSessionOf(participantOf(readTask(home, id), addr), session);
  } catch {
    // Журнала нет или он не читается — гейту нечем судить, и молчание честнее отказа.
    return null;
  }
}

// Захват mailbox'а сессией-преемником. Возвращает прежнего владельца: поле `owner` одно,
// истории нет. Захват — ещё и перепривязка: владелец объявляет и свою текущую задачу.
export function claimOwnership(home, id, owner) {
  const previous = withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = participantOf(meta, ORCHESTRATOR);
    const was = ownerOf(p);
    if (p) {
      gate(() => bus(home).patchParticipant(id, p.id, { metadata: { ...p.metadata, owner } }));
    } else {
      gate(() => bus(home).putParticipant(id, participantRecord(ORCHESTRATOR, { owner })));
    }
    taskCache?.clear();
    return was;
  });
  bindSession(home, id, owner);
  return previous;
}

// --- привязки «сессия → задача» ----------------------------------------------------

// Привязывается только АКТИВНАЯ задача: закрытую `liveBinding` не отдаст никогда. Захват
// mailbox'а закрытой задачи при этом законен — читать её переписку никто не запрещал.
export function bindSession(home, id, session = sessionIdentity()) {
  const file = sessionFile(home, session);
  if (!file || !taskExists(home, id) || readTask(home, id).status !== 'active') return null;
  const address = addressIn(home, id, session);
  return writeBinding(home, {
    session,
    task: id,
    since: new Date().toISOString(),
    ...(address ? { address, role: roleOf(address) } : {}),
  });
}

// Адрес, за которым числится эта сессия. Сегодня записан он только у владельца задачи —
// участнику идентичность доезжает через env его mcp-config, а не через привязку.
// Поле необязательное: появится источник — привязка начнёт его нести без второй миграции.
function addressIn(home, id, session) {
  try {
    return taskOwner(home, id) === session ? ORCHESTRATOR : null;
  } catch {
    return null;
  }
}

// Привязка этой сессии или `null`. Читается ПО ЖИВОСТИ, а не по наличию файла: сессия,
// продолжившая работать после `promptobus done`, обязана снова попасть на запасной путь. Под
// одним `try` и отметка, и журнал: обрезанный журнал ронял бы `resolveTaskId`.
export function liveBinding(home, session = sessionIdentity()) {
  try {
    const mark = readBinding(home, session);
    if (!taskExists(home, mark?.task)) return null;
    return readTask(home, mark.task).status === 'active' ? mark : null;
  } catch {
    return null;
  }
}

export function boundTaskId(home, session = sessionIdentity()) {
  return liveBinding(home, session)?.task ?? null;
}

// Привязать сессию к задаче, которой она владеет. Spawn и ревью зовут её, а не
// `bindSession`: у сессии, вошедшей в чужой run явным `--task`, вызовы без аргумента
// уехали бы в чужой журнал.
export function bindIfOwner(home, id, session = sessionIdentity()) {
  if (!session || taskOwner(home, id) !== session) return null;
  return bindSession(home, id, session);
}

// Уборка привязок, потерявших живость: механизму не нужна, каталогу — да.
export function sweepBindings(home) {
  let dropped = 0;
  for (const session of bindingNames(home)) {
    if (liveBinding(home, session)) continue;
    dropBinding(home, session);
    dropped += 1;
  }
  return dropped;
}

// --- сообщения ---------------------------------------------------------------------

/**
 * Папка файлов задачи. Содержимое у неё двух родов: артефакты, прошедшие шиной, — жёсткими
 * ссылками на свои blob'ы под теми именами, с которыми пришли, и то, что механизм кладёт
 * туда сам, — дифф `promptobus review`, попадающий в папку файлом, а не отправкой.
 *
 * В store v1 содержимое артефакта адресуется SHA-256 и лежит в `blobs/`, а `artifacts/`
 * держит metadata-записи. Ни то, ни другое человеку не откроешь, а папку задачи открывают:
 * её путь печатает инструмент `task`, её же считает `promptobus prune`. Дом папки здесь, у
 * adapter'а: упаковка каталога — его дело.
 */
export function filesDir(home, id) {
  return path.join(taskDir(home, id), 'files');
}

/**
 * Имя артефакта в папке файлов задачи. Занимает его сама ссылка: `linkBlob` отказывает на
 * занятом имени вместо тихой перезаписи — та же атомарность, которой прежний store держал
 * `COPYFILE_EXCL`. Ссылка, а не копия: содержимое живёт в blob'е и дедуплицировано.
 */
function placeFile(home, id, source, sha256) {
  const dir = filesDir(home, id);
  const ext = path.extname(source);
  const stem = path.basename(source, ext);
  for (let i = 1; ; i += 1) {
    const name = i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
    if (bus(home).linkBlob(id, sha256, path.join(dir, name))) return name;
  }
}

/**
 * Отправить сообщение. Отправитель и получатель — АДРЕСА: ими разговаривают инструменты
 * шины и человек, а id участника остаётся внутри store. Возвращается исход v1: канон и
 * metadata артефакта, если он был.
 */
export function sendMessage(home, id, { from, to, type, body, artifactPath }) {
  if (!isAddress(from)) throw new Error(`неизвестный адрес отправителя «${from}»`);
  if (!isAddress(to)) throw new Error(`неизвестный адрес получателя «${to}» — orchestrator, worker:<slug> или reviewer:<slug>`);
  if (!MESSAGE_TYPES.includes(type)) {
    throw new Error(`тип «${type}» не из протокола v1: ${MESSAGE_TYPES.join(', ')}`);
  }
  if (typeof body !== 'string' || !body.trim()) throw new Error('body пуст — сообщение без текста не отправляется');
  // Адресат обязан числиться участником задачи: опечатка в слаге прошла бы грамматику, и
  // отправка вернула бы успех. Законного отправления на незарегистрированный адрес нет —
  // spawn пишет участника ДО запуска. Слова отказа свои: у v1 в них id участника, а
  // человек и механизм говорят адресами.
  const meta = readTask(home, id);
  const known = addressesOf(meta);
  if (!known.includes(to)) {
    throw new Error(`в задаче ${id} нет участника «${to}» — сообщение некому забрать, `
      + `и заведённый под него mailbox не увидит ни promptobus status, ни task. Участники задачи: ${known.join(', ')}`);
  }
  // Отправитель, которого в задаче ещё нет, записывается участником: без записи routing
  // policy нечего спросить. Случай законный и живой — сессия вправе назвать чужую задачу
  // аргументом `task`, и её адрес в той задаче ещё не значится; адрес при этом не
  // пользовательский ввод, он объявлен окружением самой сессии.
  //
  // **Запись кладётся сразу снятой с наблюдения** — тем же полем, которым её снимает
  // `promptobus dismiss`. Иначе у записи появлялось бы последствие, которого в прежнем
  // store не было вовсе: надзиратель берёт адрес под присмотр и докладывает оркестратору
  // ЧУЖОЙ задачи о стопе сессии, которая просто написала туда однажды. Явный подъём
  // участника (`spawn`, `review`) кладёт запись без отметки и остаётся под присмотром.
  //
  // **Право на отправку спрашивается ДО записи.** Правило то же, что у engine («отказ
  // policy не имеет права оставить в задаче ни байта»): иначе отказ закрытой задачи или
  // маршрута оставлял бы в ЧУЖОМ журнале нового участника — и запись переживала бы отказ,
  // ради которого её и не следовало класть.
  if (!known.includes(from)) {
    requireSendable(meta, from, to);
    upsertParticipant(home, id, participantRecord(from, { dismissed: new Date().toISOString() }));
  }
  const sent = gate(() => bus(home).sendSync(id, {
    from: addrDir(from),
    to: [addrDir(to)],
    type,
    body,
    ...(artifactPath ? { artifact: { path: artifactPath, name: (sha) => placeFile(home, id, artifactPath, sha) } } : {}),
  }));
  taskCache?.clear();
  return { message: sent.message, artifact: sent.artifact };
}

/**
 * Вправе ли этот адрес отправить в эту задачу — спрашивается у тех же правил, что и у
 * engine, но ДО записи отправителя участником. Дважды сработавшая policy ничего не стоит:
 * она чистая функция.
 */
function requireSendable(meta, from, to) {
  if (meta.status !== 'active') throw new GateError(`задача ${meta.id} закрыта`);
  const recipient = participantOf(meta, to);
  if (!recipient) return;
  const decision = atiRouting(participantRecord(from), recipient, meta);
  if (decision?.allow === true) return;
  throw new GateError(`${addrDir(from)} → ${recipient.id}: ${decision?.reason ?? 'policy не вернула решения'}`);
}

/** Забрать входящие: прочитанное уезжает в history. */
export function readInbox(home, id, addr) {
  const { messages, broken } = gate(() => bus(home).read(id, addrDir(addr)));
  return { messages, broken: brokenLines(broken) };
}

/** Прочитать не забирая: нужен чужой сессии — ей `mailbox` отдаёт копию. */
export function peekInbox(home, id, addr) {
  const { messages, broken } = gate(() => bus(home).peek(id, addrDir(addr)));
  return { messages, broken: brokenLines(broken) };
}

/**
 * Заглянуть в mailbox, не тронув в нём ничего, — нужен надзирателю. Отличие от `peekInbox`:
 * тот откладывает нечитаемое в `broken/` и называет вслух, а диагностика надзирателя уходит
 * в `stdio: 'ignore'` — отложенное исчезло бы без слова кому-либо.
 */
export function glanceInbox(home, id, addr) {
  try {
    return bus(home).glance(id, addrDir(addr));
  } catch {
    return [];
  }
}

// Доклад о битом — в два канала: диагностика человеку, список агенту (у MCP-пути stderr
// читает harness, а не сессия, и без списка сообщение исчезало бы молча). Слова те же,
// какими их знал прежний store: их цитируют ответы инструментов и набор.
//
// Собирается строка ИЗ ПОЛЕЙ, а не режется регексом из готовой: причина и место приезжают
// из v1 раздельно, и склейка заставляла бы разбирать её обратно — два канала доклада
// разъехались бы на первой же правке слов.
function brokenLines(notes) {
  return notes.map(({ name, note, attic, failure }) => {
    const where = failure ? ` и не отложено (${failure}) — пропущено`
      : (attic ? ` — отложено в ${attic}, mailbox работает дальше` : ' — оставлено на месте');
    const said = `БИТОЕ СООБЩЕНИЕ ${name}: ${note}${where}`;
    warn(said);
    return said;
  });
}

export function countInbox(home, id, addr) {
  return bus(home).unread(id, addrDir(addr));
}

// Когда адрес в последний раз ОТПРАВЛЯЛ на шину; `null` — не отправлял ещё ничего.
export function lastSentAt(home, id, addr) {
  return bus(home).lastSentAt(id, addrDir(addr));
}

// Накопившееся непрочитанное само о себе не говорит: notification — best-effort, не
// дошла — сообщение лежит, а сессия считает, что ей не писали. Счётчик идёт хвостом в
// ответах, где сессия mailbox не забирает (`send`, `task`, вывод `promptobus review`); ноль не
// называем. Чужому mailbox'у строка говорит другое: оригиналы ему не отдадут.
export function unreadNote(home, id, addr, session = null) {
  const n = countInbox(home, id, addr);
  if (!n) return null;
  const own = ownership(home, id, addr, session);
  if (!own.gated) return `твой mailbox: непрочитано ${n} — забери инструментом promptobus_mailbox`;
  return `${FOREIGN_MARK}: непрочитано ${n} у orchestrator этой задачи, но mailbox закреплён за сессией `
    + `${own.owner}, эта — ${own.session}. ${FOREIGN_ROUTE}`;
}

/**
 * История задач: страница записей от старых к новым, по умолчанию последние 50.
 *
 * Единица — ЗАПИСЬ, а не сообщение: одно сообщение, лежащее у двоих, даёт две записи.
 * Непрочитанного здесь нет вовсе — оно лежит в mailbox'е, и чтение истории его не трогает.
 */
export function history(home, query = {}) {
  return gate(() => bus(home).history(query));
}

// Артефакт в сообщении механизм называет ИМЕНЕМ ФАЙЛА — его печатают ответы инструментов,
// notification надзирателя и журнал `promptobus history`, и по нему человек находит файл в
// папке задачи. В v1 сообщение несёт id metadata-записи, поэтому имя читается из неё.
// Сообщения без артефакта чтения metadata не стоят вовсе.
export function nameOfArtifact(home, task, id) {
  try {
    return bus(home).readArtifact(task, id).filename;
  } catch {
    return undefined;
  }
}

// --- service MCP-слоя ---------------------------------------------------------------

// Перечень операций, которыми пользуются инструменты шины. Собирает его adapter, а не
// package: половина перечня стоит на идентичности сессии — владение mailbox'ом, привязка,
// резолв активной задачи и шапка ответа
// ([mcp/service.ts](../src/mcp/service.ts)).
export const busService = {
  artifactsDir: filesDir,
  artifactName: nameOfArtifact,
  bindSession,
  brokenNote,
  claimOwnership,
  countInbox,
  identityLabel,
  ownership,
  peekInbox,
  readInbox,
  readTask,
  resolveTaskId,
  send: sendMessage,
  unreadNote,
  withTaskCache,
};

// Тот же приём — перезаписываемым файлам CLI: счётчику сторожа в `waits/` и `stalls.json`.
// Store задачи пишет свои файлы сам, внутри package; наружу этот примитив он не отдаёт.
export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
  return value;
}

// --- идентичность процесса ---------------------------------------------------

// Кто этот процесс на шине. Worker и reviewer получают identity через env своего
// mcp-config; canonical сервер оркестратора получает PROMPTOBUS_HOME при sync. Поиск home от
// cwd — fallback для ручного запуска и старого конфига. Путь приводим к физической форме
// даже когда последний каталог ещё не создан: на Darwin /var и /private/var ведут в одно
// место, и без общей канонизации команда и MCP-сервер печатали бы разные identity.
function canonicalPath(value) {
  const abs = path.resolve(value);
  let existing = abs;
  const tail = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return abs;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(realpathSync(existing), ...tail);
  } catch {
    return abs;
  }
}

// Привязки здесь нет намеренно: функция зовётся один раз на процесс, а привязка меняется
// под ним (`claim` перепривязывает, `promptobus done` гасит) — её читает `resolveTaskId` на
// каждом вызове. Здесь остаётся неизменное: роль, home, объявленная env задача и сессия.
/**
 * Нужен ли этому дому переезд — и не сдвигая его. Спрашивает сторож цикла: его дело
 * проверить mailbox, а не двигать store.
 * Хвост дома не опознан — переезда по нему не бывает вовсе, значит и ждать нечего.
 */
export function storePending(home, host) {
  if (host == null) {
    throw new Error('storePending: host обязателен — отсутствие прежней раскладки объявляет host.legacyLayout(), а не пропуск аргумента');
  }
  const root = rootOfHome(home, host);
  if (!root) return false;
  const plan = preflight(root, host);
  return plan.needed || Boolean(plan.refusal);
}

/**
 * Кто эта сессия на шине. `declared` — идентичность, ОБЪЯВЛЕННАЯ вызывающим (сегодня это
 * аргументы команды Stop-хука); она сильнее окружения, и порядок здесь не
 * косметика. Окружение фоновой сессии harness выдаёт не то, с которым её поднимали —
 * тройка `PROMPTOBUS_*` достаётся ей от процесса, поднявшего демон, — поэтому объявленному
 * верят первым, а окружение остаётся запасным путём ручного запуска и НЕДОВЕРЕННЫМ
 * источником.
 */
export function resolveIdentity(env = process.env, cwd = process.cwd(), { move = true, declared: said = null, host } = {}) {
  if (host == null) {
    throw new Error('resolveIdentity: host обязателен — отсутствие прежней раскладки объявляет host.legacyLayout(), а не пропуск аргумента');
  }
  const of = (name, key) => (typeof said?.[key] === 'string' && said[key].trim() ? said[key].trim() : env[name]?.trim() || '');
  const role = of('PROMPTOBUS_ROLE', 'role') || ORCHESTRATOR;
  if (!isAddress(role)) throw new GateError(`PROMPTOBUS_ROLE=«${role}» — ожидается orchestrator, worker:<slug> или reviewer:<slug>`);
  const declared = of('PROMPTOBUS_HOME', 'home');
  let home;
  // `move: false` — резолв БЕЗ переезда: так дом спрашивает сторож цикла, которому двигать
  // store не положено. Путь при этом тот же, иначе после переезда сторож смотрел бы в
  // снесённый каталог.
  const at = (root) => (move ? promptobusHome(root, host) : path.join(root, PROMPTOBUS_REL));
  if (declared) {
    // Переезд запускается и здесь: у процесса с объявленным домом другого касания store
    // нет вовсе. Корень выводится из самого дома; не вывелся — берём дом как есть.
    const root = rootOfHome(declared, host);
    home = root ? at(root) : declared;
  } else {
    const root = host.findRoot(cwd);
    if (!root) {
      throw new GateError('не найден корень рабочего места и не задан PROMPTOBUS_HOME — '
        + 'шину Promptobus не с чем связать');
    }
    home = at(root);
  }
  return {
    role,
    home: canonicalPath(home),
    declaredTask: of('PROMPTOBUS_TASK', 'task') || null,
    session: sessionIdentity(env),
  };
}

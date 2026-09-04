import {
  constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { writeJsonAtomic } from './fs/atomic.js';
import {
  addrDir, FOREIGN_MARK, FOREIGN_ROUTE, GateError, isAddress, MESSAGE_TYPES, newTaskIdentity, ORCHESTRATOR,
  participantFileStem, requireTaskId, stampOfId, TASK_ID_RE, TASK_TITLE_SEP, taskDir, tasksDir,
} from './protocol.js';
import type { Ownership } from './protocol.js';
import {
  onTaskLock, sessionFile, sessionsDir, withTaskLock, workersDir,
} from './sidecar.js';
import type { Binding } from './sidecar.js';

/**
 * Диагностика человеку. Приходит аргументом и только там, где reader сообщает о порче:
 * package в потоки процесса не пишет, а окружение и вывод — дело adapter'а.
 * Не назвали — reader молчит, а список `broken` возвращается вызывающему как и раньше.
 */
export type Warn = (msg: string) => void;

const SILENT: Warn = () => {};

// Store шины `v0.61.0` — maildir-хранилище задачи. **Production store'ом он
// быть перестал**: cutover перевёл механизм на protocol v1 ([v1/](v1/)), и здесь
// остаётся тот единственный читатель, ради которого этот код живёт дальше, — миграция
// прежнего store → `.promptobus` ([migrate.ts](migrate.ts)). Второй вызывающий — набор:
// legacy-срез читается своим reader'ом, а недостающие файлы adapter'а дописываются в его
// копию тем же store API.
//
// Наружу поверхность уходит namespace'ом `legacy` из [index.ts](index.ts). Плоским
// экспортом ей нельзя: имена у обоих store одни и те же, и в общем пространстве они
// столкнулись бы. Дом остаётся, пока читается вход миграции: reader прежней раскладки —
// её предмет, и снять его можно только вместе с самой миграцией.
//
// Демона нет: у каждой сессии свой stdio-процесс MCP-сервера, общее состояние на диске.
// Одно сообщение = один JSON-файл в mailbox адресата, попадающий на место атомарным
// rename; у mailbox ровно один потребитель (адрес = процесс), поэтому «прочитано» —
// перемещение файла в read/.
//
// Путь store приходит аргументом `home`. Где он лежит, package не знает вовсе: корень
// рабочего места ищет adapter, он же подставляет диагностику и идентичность сессии
// ([host.ts](host.ts)).

let seq = 0;
// Счётчик временных имён — свой: номер `seq` уезжает в имя файла и держит порядок отправки.
let tmpSeq = 0;

// Код ошибки файловой операции. `strict` отдаёт пойманное как `unknown`, а разбор кодов
// (`EEXIST`, `ENOENT`) — то же самое условие, что и в JS-редакции этого файла.
type Errno = NodeJS.ErrnoException;
const errno = (e: unknown): Errno => e as Errno;

/** Запись участника задачи. Поля сверх адреса пишет adapter — они его, а не store. */
export interface Participant {
  address: string;
  owner?: string | null;
  title?: string;
  dismissed?: string;
  [key: string]: unknown;
}

/** Журнал задачи: `task.json` как он есть сегодня. */
export interface TaskMeta {
  id: string;
  title?: string;
  slug?: string;
  stamp?: string;
  titleExplicit?: boolean;
  created?: string;
  closed?: string;
  status?: string;
  participants?: Participant[];
  [key: string]: unknown;
}

/** Сообщение протокола v1 — один атомарно созданный файл в mailbox'е адресата. */
export interface Message {
  id: string;
  task: string;
  from: string;
  to: string;
  type: string;
  ts: string;
  body: string;
  artifact?: string;
}

export function inboxDir(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'inbox', addrDir(addr));
}

export function readDir(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'read', addrDir(addr));
}

// Куда откладывается нечитаемое: каталог соседний с `read/`, файл остаётся под своим именем.
export function brokenDir(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'broken', addrDir(addr));
}

export function artifactsDir(home: string, id: string): string {
  return path.join(taskDir(home, id), 'artifacts');
}

// --- задачи ------------------------------------------------------------------

export function taskFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'task.json');
}

export function taskExists(home: string, id: unknown): boolean {
  return TASK_ID_RE.test((id ?? '') as string) && existsSync(taskFile(home, id as string));
}

// Владелец адреса `orchestrator` — сессия, при которой задача завелась: `promptobus spawn` и
// `promptobus review` запускаются Bash'ем из неё и наследуют её идентичность.
export function taskOwner(home: string, id: string): string | null {
  const meta = readTask(home, id);
  return (meta.participants ?? []).find((p) => p.address === ORCHESTRATOR)?.owner ?? null;
}

// Свой mailbox или чужой — единственное условие на всю шину. Сравнивать нечем (нет
// идентичности или владельца) — механизм молчит целиком: совместимость назад важнее
// защиты. Адреса worker'ов и reviewer'ов не гейтуются: адрес объявлен в их mcp-config.
export function ownership(home: string, id: string, addr: string, session: string | null): Ownership {
  if (addr !== ORCHESTRATOR) return { gated: false, owner: null, session };
  const owner = taskOwner(home, id);
  if (!owner || !session) return { gated: false, owner, session };
  return { gated: owner !== session, owner, session };
}

// Захват mailbox'а сессией-преемником. Возвращает прежнего владельца: поле `owner` одно,
// истории нет. Захват — ещё и перепривязка: владелец объявляет и свою текущую задачу.
export function claimOwnership(home: string, id: string, owner: string): string | null {
  const previous = withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = (meta.participants ?? []).find((x) => x.address === ORCHESTRATOR) ?? { address: ORCHESTRATOR };
    const was = p.owner ?? null;
    writeTask(home, applyParticipant(meta, { ...p, owner }));
    return was;
  });
  bindSession(home, id, owner);
  return previous;
}

// --- объявленная привязка «сессия → задача» ------------------------
//
// Привязка кладётся файлом на сессию рядом с `tasks/`: без неё задача сессии выводилась
// догадкой «единственная активная» — при нескольких активных шина отказывала поднятой
// сессии, при одной чужая подхватывала её как свою. Гибрид: где идентичности нет
// (ручной запуск, тесты, CI), резолв откатывается на ту же догадку. Имя
// сессии проверяется грамматикой id задачи — не уложилось, привязки нет вовсе.
// Привязывается только АКТИВНАЯ задача: закрытую `liveBinding` не отдаст никогда. Захват
// mailbox'а закрытой задачи при этом законен — читать её переписку никто не запрещал.
export function bindSession(home: string, id: string, session: string | null): Binding | null {
  const file = sessionFile(home, session);
  if (!file || !taskExists(home, id) || readTask(home, id).status !== 'active') return null;
  const mark: Binding = { session: session as string, task: id, since: new Date().toISOString() };
  return writeJsonAtomic(file, mark);
}

// Привязка этой сессии или `null`. Читается ПО ЖИВОСТИ, а не по наличию файла: сессия,
// продолжившая работать после `promptobus done`, обязана снова попасть на запасной путь. Под
// одним `try` и отметка, и журнал: обрезанный `task.json` ронял бы `resolveTaskId`.
export function liveBinding(home: string, session: string | null): Binding | null {
  const file = sessionFile(home, session);
  if (!file) return null;
  try {
    const mark = JSON.parse(readFileSync(file, 'utf8')) as Binding | null;
    if (!taskExists(home, mark?.task)) return null;
    return readTask(home, (mark as Binding).task).status === 'active' ? mark : null;
  } catch {
    return null;
  }
}

export function boundTaskId(home: string, session: string | null): string | null {
  return liveBinding(home, session)?.task ?? null;
}

// Привязать сессию к задаче, которой она владеет. Spawn и ревью зовут её, а не
// `bindSession`: у сессии, вошедшей в чужой run явным `--task`, вызовы без аргумента
// уехали бы в чужой журнал.
export function bindIfOwner(home: string, id: string, session: string | null): Binding | null {
  if (!session || taskOwner(home, id) !== session) return null;
  return bindSession(home, id, session);
}

// Уборка привязок, потерявших живость: механизму не нужна, каталогу — да.
export function sweepBindings(home: string): number {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return 0;
  let dropped = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    if (liveBinding(home, name.slice(0, -'.json'.length))) continue;
    rmSync(path.join(dir, name), { force: true });
    dropped += 1;
  }
  return dropped;
}

/** Что кладётся в новую задачу. Всё, кроме `id`, необязательно. */
export interface NewTask {
  id?: string;
  title?: string;
  slug?: string;
  stamp?: string;
  titleExplicit?: boolean;
  owner?: string | null;
}

export function createTask(home: string, {
  id = newTaskIdentity().id, title, slug, stamp, titleExplicit = false, owner = null,
}: NewTask): TaskMeta {
  requireTaskId(id);
  if (taskExists(home, id)) throw new Error(`задача ${id} уже есть`);
  const taskStamp = stamp ?? stampOfId(id);
  const meta: TaskMeta = {
    id,
    title: title ?? id,
    // Штамп пишется всегда: без него `readableTail` откатывается на полный id —
    // человек читает `(t20260827-175756)` вместо `(0827-1757)`.
    ...(slug ? { slug } : {}),
    ...(taskStamp ? { stamp: taskStamp } : {}),
    // Заголовок задан человеком явно — сборка из track'ов его не трогает.
    ...(titleExplicit ? { titleExplicit: true } : {}),
    created: new Date().toISOString(),
    status: 'active',
    // Владельца пишем, только если окружение его дало — иначе механизм владельца выключен.
    participants: [{ address: ORCHESTRATOR, ...(owner ? { owner } : {}) }],
  };
  mkdirSync(inboxDir(home, id, ORCHESTRATOR), { recursive: true });
  mkdirSync(artifactsDir(home, id), { recursive: true });
  // Флаг `wx`: между проверкой `taskExists` и записью помещается второй первый spawn того
  // же run'а, и опоздавший через `rename` молча перетёр бы участников ушедшего вперёд.
  try {
    writeFileSync(taskFile(home, id), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' });
  } catch (e) {
    if (errno(e).code === 'EEXIST') throw new Error(`задача ${id} уже есть`);
    throw e;
  }
  return meta;
}

// Кэш журнала на один запрос: один вызов инструмента шины читает task.json по
// четыре-шесть раз из мест, которые друг о друге не знают. Живёт ровно столько, сколько
// обёрнутый синхронный участок: за его пределами сосед правит журнал законно. Гасят его
// `writeTask` и `withTaskLock`. Инвариант читателя: результат `readTask` под кэшем не
// мутировать.
let taskCache: Map<string, TaskMeta> | null = null;

export function withTaskCache<T>(fn: () => T): T {
  const outer = taskCache;
  taskCache = outer ?? new Map();
  try {
    return fn();
  } finally {
    taskCache = outer;
  }
}

// Кэш журнала снимается на время лока: под ним журнал меняется и своей записью, и чужой,
// которую лок дождался. Регистрация здесь, у владельца кэша, — сам лок живёт в
// [sidecar.ts](sidecar.ts) и о кэшах не знает.
onTaskLock((fn) => withoutTaskCache(fn));

function withoutTaskCache<T>(fn: () => T): T {
  const outer = taskCache;
  taskCache = null;
  try {
    return fn();
  } finally {
    taskCache = outer;
    // Под локом журнал мог измениться — и своей записью, и чужой, которую лок дождался.
    outer?.clear();
  }
}

export function readTask(home: string, id: string): TaskMeta {
  const f = taskFile(home, id);
  const hit = taskCache?.get(f);
  if (hit) return hit;
  if (!existsSync(f)) throw new GateError(`задачи ${id} нет в ${tasksDir(home)}`);
  const meta = JSON.parse(readFileSync(f, 'utf8')) as TaskMeta;
  taskCache?.set(f, meta);
  return meta;
}

// Журнал пишется тем же приёмом, что и сообщение: временный файл в той же директории и
// `rename` поверх. `writeFileSync` усекает файл до нуля — параллельный читатель застаёт
// его пустым, а умерший посреди записи процесс оставляет обрезанный журнал навсегда.
export function writeTask(home: string, meta: TaskMeta): TaskMeta {
  writeJsonAtomic(taskFile(home, meta.id), meta);
  // Записанное перечитывают тем же ходом — снимок до записи врал бы.
  taskCache?.clear();
  return meta;
}

// Перечисление переживает и посторонний каталог, и битый журнал: одна порченая задача
// иначе гасила бы каждую команду шины — `listTasks` кормит `resolveTaskId`.
export function listTasks(home: string, warn: Warn = SILENT): TaskMeta[] {
  const dir = tasksDir(home);
  if (!existsSync(dir)) return [];
  const out: TaskMeta[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !TASK_ID_RE.test(e.name)) continue;
    if (!existsSync(taskFile(home, e.name))) continue;
    try {
      out.push(readTask(home, e.name));
    } catch (err) {
      warn(`задача ${e.name} пропущена: ${taskFile(home, e.name)} не читается (${(err as Error).message})`);
    }
  }
  return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

export function activeTasks(home: string, warn: Warn = SILENT): TaskMeta[] {
  return listTasks(home, warn).filter((t) => t.status === 'active');
}

// Активная задача процесса. Три источника, по убыванию силы: явное объявление
// (аргумент инструмента, `--task`, `A2A_TASK`), привязка сессии, вывод «единственной
// активной» — запасной путь для тех, у кого идентичности нет; его гейты и сторожат.
//
// Все три отказа адресованы человеку — опечатка в id, пустой журнал, несколько активных
// задач разом, — поэтому бросаются `GateError`'ом: голый `Error` верхний catch CLI
// печатает со стеком, и законный отказ читается как поломка самого механизма.
export function resolveTaskId(home: string, declared: string | null | undefined, session: string | null, warn: Warn = SILENT): string {
  if (declared) {
    if (!taskExists(home, declared)) throw new GateError(`задачи ${declared} нет в ${tasksDir(home)}`);
    return declared;
  }
  const bound = boundTaskId(home, session);
  if (bound) return bound;
  const active = activeTasks(home, warn);
  if (active.length === 1) return active[0].id;
  if (active.length === 0) {
    throw new GateError(`активной задачи нет: ${tasksDir(home)} пуст или все задачи закрыты. `
      + `Задача заводится при spawn'е первого worker'а: promptobus spawn --repo <имя> --brief <файл>`);
  }
  throw new GateError(`активных задач несколько (${active.map((t) => t.id).join(', ')}), `
    + `а привязки у этой сессии нет${session ? '' : ' — окружение не дало её идентичности'} — `
    + 'укажи нужную (A2A_TASK для сессии, --task для команды). '
    + 'Задача твоя, а сессия новая — забери mailbox себе: mailbox {claim: true, task: <id>}, '
    + 'дальше она резолвится сама. Нужен новый run — заведи его через promptobus spawn --new-task.');
}

// Mailbox, из которого читали и в который писали, называется в каждом ответе шины: home,
// задача, адрес. Задачу зовём и по имени: чужую задачу выдаёт тема, id не выдаёт. Тут же
// называется расхождение «сессия привязана к A, журнал говорит B» — оно законно.
export function identityLabel(home: string, task: string, addr: string, session: string | null = null): string {
  const { title } = readTask(home, task);
  const named = title && title !== task ? `${task} «${title}»` : task;
  const bound = session ? boundTaskId(home, session) : null;
  const drift = bound && bound !== task ? ` · привязка сессии ${session}: задача ${bound}` : '';
  return `A2A_HOME=${home} · задача=${named} · адрес=${addr}${drift}`;
}

function applyParticipant(meta: TaskMeta, participant: Participant): TaskMeta {
  if (!isAddress(participant?.address)) {
    throw new GateError(`недопустимый адрес участника «${participant?.address}» — `
      + 'ожидается orchestrator, worker:<slug> или reviewer:<slug>');
  }
  const rest = (meta.participants ?? []).filter((p) => p.address !== participant.address);
  meta.participants = [...rest, participant];
  return meta;
}

export function upsertParticipant(home: string, id: string, participant: Participant): TaskMeta {
  return withTaskLock(home, id, () => writeTask(home, applyParticipant(readTask(home, id), participant)));
}

// Снятие участника с наблюдения: сессию закрыл сам оркестратор, а надзирателю неоткуда об
// этом знать — без отметки он докладывал бы «ИСЧЕЗ» о закрытом. Дом отметки — запись
// участника в журнале: держи её процесс, его смерть возвращала бы доклады. Возвращается
// `{ found, was }`: «участника нет» и «отметка уже стояла» — два разных ответа.
function setDismissed(home: string, id: string, address: string, at: string | null): { found: boolean; was: string | null } {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    const p = (meta.participants ?? []).find((x) => x.address === address);
    if (!p) return { found: false, was: null };
    const was = p.dismissed ?? null;
    // Состояние уже такое, каким его просят сделать, — журнал не трогаем: повторный
    // dismiss не переписывает время снятия, а возврат под наблюдение не пишет журнал у не
    // снятого — самый частый случай на переревью, и он стоил бы лока задачи.
    if (Boolean(was) === Boolean(at)) return { found: true, was };
    // Возврат — УДАЛЕНИЕ поля, а не `null` в нём: `dismissed: null` пришлось бы
    // отличать от снятия каждому читателю журнала, а поле проверяется на истинность.
    const { dismissed, ...rest } = p;
    writeTask(home, applyParticipant(meta, at ? { ...rest, dismissed: at } : rest));
    return { found: true, was };
  });
}

export function dismissParticipant(home: string, id: string, address: string, at: string = new Date().toISOString()): {
  found: boolean; was: string | null;
} {
  return setDismissed(home, id, address, at);
}

// Возврат под наблюдение — там, где участнику даётся новая работа. Подъём заново снимает
// отметку сам (запись кладётся целиком), переревью живой сессии — этим вызовом.
export function watchParticipant(home: string, id: string, address: string): { found: boolean; was: string | null } {
  return setDismissed(home, id, address, null);
}

// Заголовок задачи из заголовков её track'ов: иначе run из трёх track'ов читался бы работой
// одной. Считается по ВСЕМУ журналу и зовётся ПОСЛЕ записи участника — два spawn'а от
// одного пре-имиджа дали бы «A · B» и «A · C», и победитель потерял бы чужой track.
// Пустой список — не повод переименовывать: у задачи прежнего CLI поля `title` нет.
export function titleFromLines(meta?: TaskMeta | null): string | null {
  const lines = [...new Set((meta?.participants ?? [])
    .filter((p) => String(p.address ?? '').startsWith('worker:') && p.title)
    .map((p) => p.title as string))];
  return lines.length ? lines.join(TASK_TITLE_SEP) : null;
}

/** Что просят сделать с заголовком задачи. */
export interface Retitle {
  title?: string | null;
  fromLines?: boolean;
  explicit?: boolean;
  restamp?: boolean;
  session?: string | null;
}

// Заголовок задачи пишется задним числом: подсадка нового track'а его дописывает, а
// `--task-title` пришпиливает насмерть (`titleExplicit`). Одна дверь есть —
// перештамповка: `restamp` ставит план по двойной явности (`--task-title` плюс явный
// `--task`), а право проверяется здесь тем же `ownership`, что у всей шины — под локом, а
// не в плане: mailbox мог сменить владельца после сборки плана.
export function retitleTask(home: string, id: string, {
  title = null, fromLines = false, explicit = false, restamp = false, session = null,
}: Retitle = {}): string | null {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    if (meta.titleExplicit && !(restamp && !ownership(home, id, ORCHESTRATOR, session).gated)) return null;
    // `fromLines` считает ЗДЕСЬ и только здесь: предсказание для `--dry-run` живёт
    // отдельным полем намерения (`preview`), которого эта функция не читает.
    const next = fromLines ? titleFromLines(meta) : title;
    if (!next || next === meta.title) {
      // Пометка ставится и тогда, когда заголовок уже такой: иначе явно названный
      // человеком заголовок остался бы незащищённым от следующей подсадки.
      if (explicit) {
        meta.titleExplicit = true;
        writeTask(home, meta);
      }
      return null;
    }
    meta.title = next;
    if (explicit) meta.titleExplicit = true;
    writeTask(home, meta);
    return next;
  });
}

export function closeTask(home: string, id: string): TaskMeta {
  return withTaskLock(home, id, () => {
    const meta = readTask(home, id);
    meta.status = 'done';
    meta.closed = new Date().toISOString();
    return writeTask(home, meta);
  });
}

// --- сообщения ---------------------------------------------------------------

function stamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:.]/g, '').replace('Z', '');
}

// Артефакт кладётся в общую папку задачи под своим именем; занятое имя не перетирается.
function storeArtifact(home: string, id: string, srcAbs: string): string {
  const src = path.resolve(srcAbs);
  if (!existsSync(src)) throw new Error(`артефакта нет: ${src}`);
  const dir = artifactsDir(home, id);
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(src);
  const stem = path.basename(src, ext);
  // Имя занимает сама копия, а не проверка перед ней: `existsSync` в цикле — TOCTOU.
  // `COPYFILE_EXCL` отдаёт имя ровно одному, опоздавший берёт следующий номер.
  for (let i = 1; ; i += 1) {
    const name = i === 1 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
    try {
      copyFileSync(src, path.join(dir, name), constants.COPYFILE_EXCL);
      return name;
    } catch (e) {
      if (errno(e).code !== 'EEXIST') throw e;
    }
  }
}

/** Что отправляется на шину. */
export interface Outgoing {
  from: string;
  to: string;
  type: string;
  body: string;
  artifactPath?: string | null;
}

export function sendMessage(home: string, id: string, { from, to, type, body, artifactPath }: Outgoing): Message {
  if (!isAddress(from)) throw new Error(`неизвестный адрес отправителя «${from}»`);
  if (!isAddress(to)) throw new Error(`неизвестный адрес получателя «${to}» — orchestrator, worker:<slug> или reviewer:<slug>`);
  if (!MESSAGE_TYPES.includes(type)) {
    throw new Error(`тип «${type}» не из протокола v1: ${MESSAGE_TYPES.join(', ')}`);
  }
  if (typeof body !== 'string' || !body.trim()) throw new Error('body пуст — сообщение без текста не отправляется');
  // Адресат обязан числиться участником задачи: опечатка в слаге прошла бы грамматику,
  // каталог mailbox'а функция заводит сама, и отправка вернула бы успех. Законного
  // отправления на незарегистрированный адрес нет — spawn пишет участника ДО запуска.
  const known = (readTask(home, id).participants ?? []).map((p) => p.address);
  if (!known.includes(to)) {
    throw new Error(`в задаче ${id} нет участника «${to}» — сообщение некому забрать, `
      + `и заведённый под него mailbox не увидит ни promptobus status, ни task. Участники задачи: ${known.join(', ')}`);
  }

  const artifact = artifactPath ? storeArtifact(home, id, artifactPath) : undefined;
  const now = new Date();
  const dir = inboxDir(home, id, to);
  mkdirSync(dir, { recursive: true });
  // Уникальность имени держит диск, а не память процесса: счётчик `seq` свой у каждого
  // процесса. Временный файл — в той же директории (rename и link атомарны только внутри
  // одной ФС; читатель отбирает по `.json` и точку в начале не берёт). Кладём `link`, а не
  // `rename`: он отказывает на занятом имени вместо тихой перезаписи.
  tmpSeq += 1;
  const tmp = path.join(dir, `.tmp-msg-${process.pid}-${tmpSeq}`);
  const ts = stamp(now);
  let msg: Message;
  try {
    for (;;) {
      seq += 1;
      const base = `${ts}-${String(seq).padStart(4, '0')}-${addrDir(from)}`;
      msg = { id: base, task: id, from, to, type, ts: now.toISOString(), body, ...(artifact ? { artifact } : {}) };
      writeFileSync(tmp, JSON.stringify(msg, null, 2) + '\n');
      try {
        linkSync(tmp, path.join(dir, `${base}.json`));
        break;
      } catch (e) {
        if (errno(e).code !== 'EEXIST') throw e;
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return msg;
}

function inboxNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
}

// Одно сообщение из mailbox'а: разобранное, `null` на унесённом соседом и `null` на
// битом — битое уезжает в `broken/` с докладом. Брось оно SyntaxError наружу, mailbox
// затыкался бы навсегда, а с ним весь run.
function takeMessage(dir: string, name: string, attic: string, broken: string[], warn: Warn): Message | null {
  const file = path.join(dir, name);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    // Унёс сосед между листингом и чтением — пропуск, а не отказ.
    if (errno(e).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as Message;
  } catch (e) {
    let note;
    try {
      mkdirSync(attic, { recursive: true });
      renameSync(file, path.join(attic, name));
      note = `БИТОЕ СООБЩЕНИЕ ${name}: не разобрано (${(e as Error).message}) — отложено в ${attic}, mailbox работает дальше`;
    } catch (moveErr) {
      // Отложить не вышло — тем более не роняем mailbox: называем и порчу, и то, что файл остался.
      note = `БИТОЕ СООБЩЕНИЕ ${name}: не разобрано (${(e as Error).message}) и не отложено (${(moveErr as Error).message}) — пропущено`;
    }
    // Доклад в два канала: диагностика — человеку, список `broken` — агенту (у MCP-пути
    // stderr читает harness, а не сессия, и без списка сообщение исчезало бы молча).
    warn(note);
    broken.push(note);
    return null;
  }
}

// Забрать входящие и пометить прочитанными. Порядок — по имени файла: метка времени с
// миллисекундами плюс счётчик отправителя, поэтому сортировка строк — порядок отправки.
export function readInbox(home: string, id: string, addr: string, warn: Warn = SILENT): { msgs: Message[]; broken: string[] } {
  const dir = inboxDir(home, id, addr);
  const names = inboxNames(dir);
  const broken: string[] = [];
  if (!names.length) return { msgs: [], broken };
  const done = readDir(home, id, addr);
  const attic = brokenDir(home, id, addr);
  mkdirSync(done, { recursive: true });
  const msgs: Message[] = [];
  for (const n of names) {
    const msg = takeMessage(dir, n, attic, broken, warn);
    if (!msg) continue;
    try {
      renameSync(path.join(dir, n), path.join(done, n));
    } catch (e) {
      // Унёс сосед между чтением и переносом — пропуск, а не отказ: отказ пришёл бы из
      // середины обхода, когда часть сообщений уже уехала в `read/`. Сообщение не
      // теряется — его забрал сосед, он и доставит.
      if (errno(e).code !== 'ENOENT') throw e;
      continue;
    }
    msgs.push(msg);
  }
  return { msgs, broken };
}

export function countInbox(home: string, id: string, addr: string): number {
  return inboxNames(inboxDir(home, id, addr)).length;
}

// Накопившееся непрочитанное само о себе не говорит: notification — best-effort, не
// дошла — сообщение лежит, а сессия считает, что ей не писали. Счётчик идёт хвостом в
// ответах, где сессия mailbox не забирает (`send`, `task`, вывод `promptobus review`); ноль не
// называем. Чужому mailbox'у строка говорит другое: оригиналы ему не отдадут.
export function unreadNote(home: string, id: string, addr: string, session: string | null = null): string | null {
  const n = countInbox(home, id, addr);
  if (!n) return null;
  const own = ownership(home, id, addr, session);
  if (!own.gated) return `твой mailbox: непрочитано ${n} — забери инструментом mailbox`;
  return `${FOREIGN_MARK}: непрочитано ${n} у orchestrator этой задачи, но mailbox закреплён за сессией `
    + `${own.owner}, эта — ${own.session}. ${FOREIGN_ROUTE}`;
}

// Заглянуть в mailbox, не тронув в нём ничего, — нужен надзирателю. Отличие от
// `peekInbox`: тот откладывает нечитаемое в `broken/` и называет вслух, а диагностика
// надзирателя уходит в `stdio: 'ignore'` — отложенное исчезло бы без слова кому-либо.
export function glanceInbox(home: string, id: string, addr: string): Message[] {
  const dir = inboxDir(home, id, addr);
  const msgs: Message[] = [];
  for (const n of inboxNames(dir)) {
    try {
      msgs.push(JSON.parse(readFileSync(path.join(dir, n), 'utf8')) as Message);
    } catch {
      // Битое или унесённое соседом — не наша беда: mailbox забирает читатель, он и доложит.
    }
  }
  return msgs;
}

// Посмотреть входящие не забирая — нужен чужой сессии: ей `mailbox` отдаёт копию, а
// оригиналы остаются владельцу. Забирает сообщения `mailbox` сессии-владельца, он же мог
// унести файл между листингом и чтением.
export function peekInbox(home: string, id: string, addr: string, warn: Warn = SILENT): { msgs: Message[]; broken: string[] } {
  const dir = inboxDir(home, id, addr);
  const attic = brokenDir(home, id, addr);
  const broken: string[] = [];
  const msgs: Message[] = [];
  for (const n of inboxNames(dir)) {
    const msg = takeMessage(dir, n, attic, broken, warn);
    if (msg) msgs.push(msg);
  }
  return { msgs, broken };
}


// --- вставка при слиянии track'а stalls в store.ts ------------------------

// Штамп и отправитель в имени файла сообщения — форма, которую задаёт `sendMessage`.
const MSG_NAME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})-\d{4}-(.+)\.json$/;

// Когда адрес в последний раз ОТПРАВЛЯЛ на шину; `null` — не отправлял ещё ничего.
// Содержимое сообщений не читается вовсе: имя файла несёт и метку времени, и отправителя,
// а спрашивают это на каждом ударе сердца по каждому вставшему. Смотрим оба места, где
// сообщение законно лежит, — непрочитанное в mailbox'е получателя и прочитанное в `read/`.
export function lastSentAt(home: string, id: string, address: string): number | null {
  const from = addrDir(address);
  let last: number | null = null;
  for (const box of ['inbox', 'read']) {
    const root = path.join(taskDir(home, id), box);
    let boxes: string[];
    try {
      boxes = readdirSync(root);
    } catch {
      // Каталоги заводятся лениво: нет каталога — нет и сообщений в нём.
      continue;
    }
    for (const dir of boxes) {
      let names: string[];
      try {
        names = readdirSync(path.join(root, dir));
      } catch {
        continue;
      }
      for (const n of names) {
        const m = MSG_NAME_RE.exec(n);
        // Отправитель сверяется целиком, а не хвостом имени: у слага `x-worker-api` хвост
        // тот же `-worker-api.json`, и его сообщения сошли бы за сообщения `worker:api`.
        if (!m || m[8] !== from) continue;
        const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +m[7]!);
        if (last === null || at > last) last = at;
      }
    }
  }
  return last;
}


// --- реэкспорт словаря и файлов adapter'а ------------------------------------
//
// Поверхность модуля остаётся той, какой её знали миграция и генератор fixture: словарь
// шины и файлы каталога задачи разъехались по соседним модулям, но звать их через два
// импорта потребителю legacy-среза незачем.
export {
  addrDir, brokenNote, claimRoute, FOREIGN_MARK, FOREIGN_ROUTE, GateError, isAddress,
  MAILBOX_CLAIMED_MARK, MESSAGE_TYPES, newTaskIdentity, ORCHESTRATOR, participantFileStem,
  reviewerAddress, SLUG_MAX, slugify, stampOfId, TASK_TITLE_SEP, taskDir, tasksDir,
  workerAddress, foreignTaskLine,
} from './protocol.js';
export type { Clock, Ownership } from './protocol.js';
export {
  beatWarden, claimWarden, clearWarden, healthFile, lastTurnAt, liveWarden, lockBusyError,
  logWarden, markTurn, readHealth, readStalls, readWake, sessionFile, sessionsDir, stallsFile,
  tailWardenLog, WARDEN_BEAT_SEC, wakeFile, wardenLogFile, wardenMarkFile, withTaskLock,
  workersDir, writeHealth, writeStalls, writeWake,
} from './sidecar.js';
export type { Binding, Health, LockHolder, Stalls, Wake, WardenMark } from './sidecar.js';
export { pidAlive } from './fs/proc.js';

// Пути файлов участника в `workers/`: склейка имени — в словаре, каталог — в sidecar.
export function participantMcpPath(home: string, taskId: string, address: string): string {
  return path.join(workersDir(home, taskId), `${participantFileStem(address)}.mcp.json`);
}

export function participantSettingsPath(home: string, taskId: string, address: string): string {
  return path.join(workersDir(home, taskId), `${participantFileStem(address)}.settings.json`);
}

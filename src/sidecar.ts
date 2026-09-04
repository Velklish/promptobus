// Файлы каталога задачи, которых не держит ни один store: contact point'ы участников,
// health доставки, отметка и журнал надзирателя, отметки стопа и конца хода, привязки
// «сессия → задача» и каталог файлов участника.
//
// Почему они здесь, а не в store. Store версионирован — переписка, участники и артефакты
// переезжают с версией протокола. Эти файлы к протоколу не относятся вовсе:
// их формат задаёт adapter, читает и пишет их он же, а миграция переносит их байт в байт.
// Отдельный модуль и делает эту границу видимой: cutover сменил store, а не их.
//
// Раскладку каталога задачи (`<home>/tasks/<id>`) оба store называют одинаково, поэтому
// путь берётся из [protocol.ts](protocol.ts) — общего словаря шины.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { writeFileAtomic, writeJsonAtomic } from './fs/atomic.js';
import { LOCK_WAIT_MS, withDirLock } from './fs/lock.js';
import type { LockHolder } from './fs/lock.js';
import { pidAlive } from './fs/proc.js';
import { addrDir, GateError, TASK_ID_RE, taskDir, tasksDir } from './protocol.js';

// --- каталоги ----------------------------------------------------------------

export function workersDir(home: string, id: string): string {
  return path.join(taskDir(home, id), 'workers');
}

// Привязки «сессия → задача» — рядом с `tasks/`: резолв обязан отвечать одним чтением.
export function sessionsDir(home: string): string {
  return path.join(home, 'sessions');
}

// --- надзиратель задачи -------------------------------------------------------

// Слушание шины держится не на модели, а на процессе. Своего состояния у него
// нет — всё лежит здесь, в каталоге задачи: смерть надзирателя не теряет ничего, а
// перезапуск начинает с того же места.

// Отметка процесса: `{pid, started, beat, cli, harness}`.
//
// Имя файла осталось от прежнего имени надзирателя и переименованию не
// подлежит: задача, заведённая прошлым релизом, читается новым CLI, а под новым именем её
// отметка стала бы невидимой — и на одну задачу встали бы два надзирателя, каждый со
// своим циклом доставки.
export function wardenMarkFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'supervisor.json');
}

// Contact point участника — адрес его messaging-сокета и токен к нему. Сдаёт его сам
// участник: harness кладёт адрес сокета и токен в окружение
// каждого дочернего процесса сессии — надзирателю не нужны ни реестр сессий, ни pid
// участника. Токен — секрет, файл кладётся правами `0600`.
export function wakeFile(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'wake', `${addrDir(addr)}.json`);
}

// Что надзиратель знает о доставке каждому адресу. Отдельным файлом, а не полями в
// журнале задачи: запись идёт на каждую доставку, а журнал правится под локом.
export function healthFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'health.json');
}

// Журнал надзирателя — построчный, дописываемый: доставки, откаты, эскалации. Его читает
// человек, разбирая «почему участник молчал». Это НЕ журнал задачи: тот держит постановку.
// Имя файла прежнее по той же причине, что у `wardenMarkFile` выше.
export function wardenLogFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'supervisor.log');
}

export function stallsFile(home: string, id: string): string {
  return path.join(taskDir(home, id), 'stalls.json');
}

// Как часто надзиратель обновляет свою отметку. Дом константы здесь, рядом с чтением
// живости: живым процесс считается по свежести `beat`, и разъедься период записи с порогом
// протухания — механизм объявлял бы мёртвым живого. Порог `liveWarden` — три периода:
// один пропущенный удар бывает от нагрузки машины.
export const WARDEN_BEAT_SEC = 30;

/** Отметка процесса-надзирателя задачи. */
export interface WardenMark {
  pid: number;
  started?: string;
  beat?: string;
  cli?: string;
  /** Версия harness'а, если потребитель её назвал. Имя нейтральное: harness'ов больше одного. */
  harness?: string;
  [key: string]: unknown;
}

export function readWardenMark(home: string, id: string): WardenMark | null {
  try {
    return JSON.parse(readFileSync(wardenMarkFile(home, id), 'utf8')) as WardenMark;
  } catch {
    return null;
  }
}

export function writeWardenMark(home: string, id: string, mark: WardenMark): WardenMark {
  writeJsonAtomic(wardenMarkFile(home, id), mark);
  return mark;
}

export function dropWardenMark(home: string, id: string): void {
  rmSync(wardenMarkFile(home, id), { force: true });
}

// Живой надзиратель этой задачи или `null`. Признаков два, оба обязательны: живой pid
// (система переиспользует номера) и непротухший `beat` (убитый между ударами процесс
// иначе числился бы живым до трёх периодов).
export function liveWarden(home: string, id: string): WardenMark | null {
  const mark = readWardenMark(home, id);
  if (!mark) return null;
  if (!pidAlive(mark.pid)) return null;
  const beat = Date.parse(mark.beat ?? mark.started ?? '');
  if (!(Number.isFinite(beat) && Date.now() - beat < WARDEN_BEAT_SEC * 3000)) return null;
  return mark;
}

/** Contact point участника: куда стучать надзирателю. */
export interface Wake {
  address: string;
  socket: string;
  token?: string;
  pid: number;
  session?: string;
  at: string;
}

export function readWake(home: string, id: string, addr: string): Wake | null {
  try {
    return JSON.parse(readFileSync(wakeFile(home, id, addr), 'utf8')) as Wake;
  } catch {
    return null;
  }
}

// Сдать свой contact point. Зовут его часто, поэтому файл с тем же содержимым не
// переписывается — иначе каждый вызов инструмента шины стоил бы записи на диск. Права
// `0600`: в файле токен сессии; на macOS он фактически не проверяется, но хранится и
// шлётся всегда — код без него непереносим.
export function writeWake(home: string, id: string, addr: string, {
  socket, token = null, pid = process.pid, session = null,
}: { socket?: string | null; token?: string | null; pid?: number; session?: string | null } = {}): Wake | null {
  if (!socket) return null;
  const next: Wake = {
    address: addr,
    socket,
    ...(token ? { token } : {}),
    pid,
    ...(session ? { session } : {}),
    at: new Date().toISOString(),
  };
  const was = readWake(home, id, addr);
  if (was && was.socket === next.socket && was.token === next.token && was.pid === next.pid) return was;
  writeFileAtomic(wakeFile(home, id, addr), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/** Что надзиратель знает о доставке по адресам. */
export type Health = Record<string, unknown>;

export function readHealth(home: string, id: string): Health {
  try {
    const raw = JSON.parse(readFileSync(healthFile(home, id), 'utf8')) as unknown;
    return raw && typeof raw === 'object' ? raw as Health : {};
  } catch {
    return {};
  }
}

export function writeHealth(home: string, id: string, health: Health): Health {
  writeJsonAtomic(healthFile(home, id), health);
  return health;
}

/**
 * Отметка доложенных стопов: причина, время последнего доклада и счётчик попыток на адрес.
 * Прежний CLI писал сюда голую строку причины — она читается как отметка без времени, и
 * такой стоп повторяется только по смене причины.
 */
export type Stalls = Record<string, { reason: string; at: string | null; tries?: number }>;

export function readStalls(home: string, id: string): Stalls {
  try {
    const raw = JSON.parse(readFileSync(stallsFile(home, id), 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).map(([addr, v]) => [
      addr, typeof v === 'string' ? { reason: v, at: null } : v as Stalls[string],
    ]));
  } catch {
    return {};
  }
}

/** Атомарно: усечённый файл читатель разобрал бы как «не докладывали». */
export function writeStalls(home: string, id: string, stalls: Stalls): Stalls {
  writeJsonAtomic(stallsFile(home, id), stalls);
  return stalls;
}

// Дописать строку в журнал надзирателя. Без лока и атомарной подмены: `appendFileSync`
// одной строкой короче буфера трубы не рвётся, а писатель один. Отказ записи лога не
// имеет права остановить доставку.
export function logWarden(home: string, id: string, line: string): boolean {
  try {
    mkdirSync(taskDir(home, id), { recursive: true });
    appendFileSync(wardenLogFile(home, id), `${new Date().toISOString()} ${line}\n`);
    return true;
  } catch {
    return false;
  }
}

// Хвост журнала надзирателя для `promptobus status`. Читается целиком: событий доставки в run десятки.
export function tailWardenLog(home: string, id: string, n = 3): string[] {
  try {
    const lines = readFileSync(wardenLogFile(home, id), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// --- отметка конца хода -------------------------------------------------------

// Отметка конца хода адреса: `waits/<адрес>.turn.json`, рядом со счётчиком сторожа цикла.
// Ставит её сторож — он зовётся на КАЖДОМ завершении хода, — и она единственный признак
// «сессия отдала ход» у участника без bg-сессии: у интерактивной сессии оркестратора в
// записи сессии у harness'а нет вовсе. Счётчик сторожа для этого не годится:
// он живёт только пока сторож возвращает ход, а чистый проход его СНОСИТ.
function turnFile(home: string, id: string, addr: string): string {
  return path.join(taskDir(home, id), 'waits', `${addrDir(addr)}.turn.json`);
}

export function markTurn(home: string, id: string, addr: string, at: string = new Date().toISOString()): string {
  writeJsonAtomic(turnFile(home, id, addr), { at });
  return at;
}

// Когда адрес в последний раз отдал ход; миллисекунды или `null` — отметки не было ни разу.
export function lastTurnAt(home: string, id: string, addr: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(turnFile(home, id, addr), 'utf8')) as { at?: unknown };
    const at = Date.parse(typeof raw?.at === 'string' ? raw.at : '');
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

// --- привязки «сессия → задача» ------------------------------------
//
// Привязка кладётся файлом на сессию рядом с `tasks/`: без неё задача сессии выводилась
// догадкой «единственная активная» — при нескольких активных шина отказывала поднятой
// сессии, при одной чужая подхватывала её как свою. Гибрид: где идентичности нет
// (ручной запуск, тесты, CI), резолв откатывается на ту же догадку. Имя
// сессии проверяется грамматикой id задачи — не уложилось, привязки нет вовсе.
export function sessionFile(home: string, session: string | null): string | null {
  if (typeof session !== 'string' || !TASK_ID_RE.test(session)) return null;
  return path.join(sessionsDir(home), `${session}.json`);
}

/**
 * Отметка привязки сессии к задаче.
 *
 * `role` и `address` необязательны и пишутся, когда вызывающий их знает. Заведены они под
 * идентичность участника (роль и задача): сегодня она доезжает до сессии только через
 * env её mcp-config, и когда её начнут читать из привязки, поле уже будет на месте — второй
 * миграции для этого не понадобится. Отсутствие полей законно: привязку кладёт и оркестратор,
 * у которого адрес один и известен.
 */
export interface Binding {
  session: string;
  task: string;
  since: string;
  role?: string;
  address?: string;
}

export function readBinding(home: string, session: string | null): Binding | null {
  const file = sessionFile(home, session);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Binding;
  } catch {
    return null;
  }
}

export function writeBinding(home: string, mark: Binding): Binding {
  return writeJsonAtomic(sessionFile(home, mark.session) as string, mark);
}

/** Имена сессий, у которых есть отметка привязки. Обход уборки — по нему. */
export function bindingNames(home: string): string[] {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length));
}

export function dropBinding(home: string, session: string): void {
  const file = sessionFile(home, session);
  if (file) rmSync(file, { force: true });
}

// --- лок журнала задачи -------------------------------------------------------
//
// Примитив живёт в [fs/lock.ts](fs/lock.ts) и общий у обоих store; здесь остаются слова
// его отказов — они адресованы человеку — и снятие кэша журнала на время лока.
//
// Кэш снимает тот, кто его держит: под локом журнал меняется и своей записью, и чужой,
// которую лок дождался. Регистрируются держатели списком, а не одним полем: store'а в
// package два, и второй регистратор не имеет права отменить первого.

/** Обёртка, снимающая кэш журнала на время вызова. */
export type Suspend = <T>(fn: () => T) => T;

const suspenders: Suspend[] = [];

export function onTaskLock(suspend: Suspend): void {
  suspenders.push(suspend);
}

/** Кто держит лок задачи. */
export type { LockHolder };

// Отказ занятого лока. Сюда доходит только живой держатель: мёртвого снял `dropDeadLock`.
export function lockBusyError(id: string, lock: string, held: LockHolder | null, waitedMs: number): GateError {
  const who = held?.pid
    ? `Держит живой процесс ${held.pid}${held.session ? ` (сессия ${held.session})` : ''}`
      + `${held.since ? `, взят ${held.since}` : ''} — дождись его и повтори команду;`
      + ` смотреть, чем он занят: ps -p ${held.pid}`
    : 'Кто его держит, лок не назвал: файл владельца не записан — так выглядит процесс, умерший'
      + ' между заведением каталога и записью. Удали каталог лока, если процесса записи в системе уже нет';
  return new GateError(`журнал задачи ${id} занят: ждали ${waitedMs} мс, лок ${lock}. ${who}`);
}

// Лок задачи. Экспортируется ради read-modify-write журнала на стороне adapter'а
// (`markWorktreesSwept` в `promptobus done`) и ради теста — `waitMs` его шов.
//
// Идентичность сессии приходит АРГУМЕНТОМ и только для диагностики занятого лока: чей
// процесс держит журнал, знает окружение, а окружение читает adapter. Не
// назвали — отказ скажет «кто его держит, лок не назвал».
export function withTaskLock<T>(home: string, id: string, fn: () => T, {
  waitMs = LOCK_WAIT_MS, session = null,
}: { waitMs?: number; session?: string | null } = {}): T {
  const lock = path.join(taskDir(home, id), '.lock');
  const guarded = suspenders.reduce<() => T>((inner, suspend) => () => suspend(inner), fn);
  return withDirLock(lock, guarded, {
    waitMs,
    session,
    // Каталога задачи нет вовсе — это не занятый лок: говорим словами и классом
    // `readTask`. Класс тут обязателен наравне со словами: один текст, приезжающий то
    // со стеком, то без, читается как два разных исхода.
    onMissing: () => new GateError(`задачи ${id} нет в ${tasksDir(home)}`),
    onBusy: (held, waitedMs) => lockBusyError(id, lock, held, waitedMs),
  });
}

// Занять место надзирателя «первым выигрывает» — одним решением под локом: порознь
// проверка и запись — TOCTOU, и одну задачу стерегли бы двое.
export function claimWarden(home: string, id: string, {
  pid = process.pid, cli = null, harness = null, session = null,
}: { pid?: number; cli?: string | null; harness?: string | null; session?: string | null } = {}): { busy?: WardenMark; mark?: WardenMark } {
  return withTaskLock(home, id, () => {
    const busy = liveWarden(home, id);
    if (busy) return { busy };
    const now = new Date().toISOString();
    const mark: WardenMark = { pid, started: now, beat: now, ...(cli ? { cli } : {}), ...(harness ? { harness } : {}) };
    writeWardenMark(home, id, mark);
    return { mark };
  }, { session });
}

// Удар сердца: продлевается только СВОЯ отметка и только существующая. Место перехвачено
// — возвращается `null`, и по нему процесс выходит: стеречь задачу вдвоём нельзя.
export function beatWarden(home: string, id: string, {
  pid = process.pid, session = null,
}: { pid?: number; session?: string | null } = {}): WardenMark | null {
  return withTaskLock(home, id, () => {
    const mark = readWardenMark(home, id);
    if (!mark || mark.pid !== pid) return null;
    mark.beat = new Date().toISOString();
    writeWardenMark(home, id, mark);
    return mark;
  }, { session });
}

// Снимается только своя отметка: процесс, чьё место перехвачено, унёс бы чужую запись —
// и следующий читатель увидел бы «надзирателя нет» при живом.
export function clearWarden(home: string, id: string, pid: number = process.pid, {
  session = null,
}: { session?: string | null } = {}): boolean {
  if (!existsSync(taskDir(home, id))) return false;
  return withTaskLock(home, id, () => {
    const mark = readWardenMark(home, id);
    if (mark && mark.pid !== pid) return false;
    dropWardenMark(home, id);
    return true;
  }, { session });
}

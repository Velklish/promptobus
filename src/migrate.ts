// Миграция прежнего store → `.promptobus`.
//
// Однонаправленная и одноразовая: backup'а и обратной миграции нет, старый CLI новый store
// не читает. Отсюда единственное требование, которому подчинён весь порядок шагов —
// **частично записанного нового store не бывает**: он собирается в соседнем временном
// каталоге и встаёт на место одним `rename`, а legacy-каталог сносится только после.
//
// Откуда мигрировать, объявляет host (`legacyLayout`). Нет раскладки — переносить не из чего.
//
// Порядок:
//
// 1. preflight — оба root'а сразу, активные задачи, испорченный корень: отказ ДО мутации;
// 2. сборка в `<root>/.promptobus.migrating` — соседе цели, чтобы `rename` был атомарным;
// 3. отметка `migrated.json` внутри собранного каталога — до переключения;
// 4. `rename` временного каталога в `.promptobus`;
// 5. снос прежнего каталога.
//
// **Отметка закрывает окно между 4 и 5.** Смерть процесса ровно там оставила бы оба root'а,
// а «оба root'а сразу» — отказ; пользователь получил бы кирпич на ровном месте. Отметка
// называет legacy-каталог, из которого собран новый: она есть — миграция удалась, и
// повторный запуск просто доделывает уборку. Её нет — `.promptobus` пришёл откуда-то ещё, и
// это тот самый случай, ради которого отказ и заведён.
import {
  copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { writeJsonAtomic } from './fs/atomic.js';
import { withDirLock } from './fs/lock.js';
import type { LockHolder } from './fs/lock.js';
import {
  addrDir, GateError, isAddress, ORCHESTRATOR, roleOf, TASK_ID_RE, UNDECLARED_HARNESS,
  UNDECLARED_ROLE,
} from './protocol.js';
import * as legacy from './legacy-store.js';
import {
  artifactsDir, blobFile, blobRef, blobsDir, brokenInboxDir, historyDir, inboxDir, messagesDir,
  ROOT_DIR, taskDir,
} from './v1/layout.js';
import { MESSAGE_PROTOCOL_VERSION, SCHEMA_VERSION } from './v1/model.js';
import type {
  ArtifactV1, CapabilitiesSnapshot, MessageV1, ParticipantV1, TaskV1,
} from './v1/model.js';
import { validate } from './v1/validate.js';
import type { HostLegacyLayout, PromptobusHost } from './host.js';

/** Имя отметки удавшейся сборки. Лежит внутри нового root'а и переживает `rename`. */
const MARK = 'migrated.json';

/**
 * Сколько ждать соседа, который уже переезжает.
 *
 * Переезд идёт со старта КАЖДОГО stdio-сервера шины, а сервер поднимается на каждую сессию
 * и на каждого участника: два запуска в одном рабочем месте — обычное дело, а не гонка из
 * теории. Замер на копии живого workspace (71 задача, 36 МБ) — 1,45 с; тридцать секунд
 * покрывают его двадцатикратно, и досиживает их только тот, чей сосед ЖИВ (мёртвого лок
 * снимает сам).
 */
const MIGRATION_WAIT_MS = 30_000;

/**
 * Команда закрытия активных задач прежнего CLI приходит с host'а (`legacyLayout().done`).
 * Здесь её нет: у package нет своей раскладки и своего прежнего CLI.
 */

/** Шаги, на которых набор умеет уронить миграцию. В production не подставляется вовсе. */
export type MigrationStep =
  | 'scan' | 'temp' | 'task' | 'messages' | 'artifacts' | 'sidecar' | 'sessions'
  | 'mark' | 'switch' | 'cleanup';

export type MigrationFault = (step: MigrationStep, info: Record<string, unknown>) => void;

const NO_FAULT: MigrationFault = () => {};

/** Что миграция сделала с одной задачей. */
export interface TaskReport {
  id: string;
  participants: number;
  messages: number;
  unread: number;
  read: number;
  artifacts: number;
  broken: string[];
}

/** Итог миграции: числа и перечень отложенного. */
export interface MigrationReport {
  root: string;
  from: string;
  to: string;
  tasks: TaskReport[];
  brokenTasks: string[];
  bindings: number;
  /**
   * Сделал ли ЭТОТ вызов хоть что-то. `false` — переносить было нечего либо всё сделал
   * сосед: переезд идёт из двух процессов сразу, и проигравший уходит ни с чем. Поле
   * заведено не для полноты: без него пустой отчёт неотличим от удавшегося переноса, и
   * доклад числами — тот самый, что обещан пользователю, — говорил бы «задач 0, сообщений
   * 0, прежний каталог снят» там, где сосед перенёс семьдесят одну задачу.
   */
  moved: boolean;
  /** Задача уже была сделана прежним запуском — переключение доводится без сборки. */
  resumed: boolean;
}

/** Решение preflight'а: нужна ли миграция и чем она отказывает. */
export interface MigrationPlan {
  needed: boolean;
  /** Человеческий текст отказа или `null`. Отказ — законный исход, а не поломка. */
  refusal: string | null;
  legacyHome: string;
  target: string;
  /** Активные задачи, если отказ пришёл из-за них. */
  active: string[];
}

function homeOf(root: string): string {
  return path.join(root, ROOT_DIR);
}

function tempOf(root: string): string {
  return path.join(root, `${ROOT_DIR}.migrating`);
}

function lockOf(root: string): string {
  return path.join(root, `${ROOT_DIR}.migrating.lock`);
}

/** Занятый лок переезда: сосед жив и всё ещё переносит. */
class MigrationBusy extends Error {
  readonly refusal: GateError;

  constructor(refusal: GateError) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

function busyRefusal(root: string, held: LockHolder | null, waitedMs: number): MigrationBusy {
  const who = held?.pid
    ? `Держит живой процесс ${held.pid}${held.session ? ` (сессия ${held.session})` : ''}`
      + `${held.since ? `, взят ${held.since}` : ''}`
    : 'Кто его держит, лок не назвал: файл владельца не записан';
  return new MigrationBusy(new GateError(
    `переезд шины в ${root} идёт в другом процессе: ждали ${waitedMs} мс, лок ${lockOf(root)}. `
    + `${who} — дождись его и повтори команду.`));
}

function isDir(at: string): boolean {
  try {
    return statSync(at).isDirectory();
  } catch {
    return false;
  }
}

function markOf(home: string): { from?: string } | null {
  try {
    return JSON.parse(readFileSync(path.join(home, MARK), 'utf8')) as { from?: string };
  } catch {
    return null;
  }
}

/**
 * Разбор `legacyLayout().rel`: ровно два сегмента — внешний каталог и store внутри него.
 * Форма объявлена, чтобы adapter восстанавливал корень рабочего места из абсолютного пути
 * store и не получал `undefined` на односегментном пути.
 */
export function splitLegacyRel(rel: string): [string, string] {
  const parts = String(rel ?? '').split(/[\\/]/).filter(Boolean);
  if (parts.length !== 2) {
    throw new GateError(
      `legacy layout.rel должен быть ровно из двух сегментов пути `
      + `(каталог и store внутри него), а не ${JSON.stringify(rel)}`,
    );
  }
  return [parts[0], parts[1]];
}

function layoutOf(options: MigrationOptions): HostLegacyLayout | null {
  if (Object.prototype.hasOwnProperty.call(options, 'layout')) return options.layout ?? null;
  if (options.host) return options.host.legacyLayout();
  return null;
}

/**
 * Нужна ли миграция и можно ли её делать. Ни одного изменения на диске — отказ приходит
 * до мутации по построению. Без layout (standalone, host без прежнего store) — не из чего.
 */
export function preflight(root: string, layout: HostLegacyLayout | null = null): MigrationPlan {
  const target = homeOf(root);
  const empty: MigrationPlan = { needed: false, refusal: null, legacyHome: '', target, active: [] };
  if (!layout) return empty;
  let outer: string;
  let inner: string;
  try {
    [outer, inner] = splitLegacyRel(layout.rel);
  } catch (e) {
    empty.refusal = e instanceof GateError ? e.message : String(e);
    return empty;
  }
  const legacyHome = path.join(root, outer, inner);
  const plan: MigrationPlan = { needed: false, refusal: null, legacyHome, target, active: [] };
  if (!existsSync(legacyHome)) return plan;
  if (!isDir(legacyHome)) {
    plan.refusal = `${legacyHome} — не каталог: store прежней шины повреждён, и переносить из него нечего. `
      + `Убери его руками, если он не нужен, и повтори команду.`;
    return plan;
  }
  const legacyTasks = path.join(legacyHome, 'tasks');
  if (existsSync(legacyTasks) && !isDir(legacyTasks)) {
    plan.refusal = `${legacyTasks} — не каталог: store прежней шины повреждён. `
      + 'Разбери его руками: миграция не трогает повреждённый корень и ничего из него не переносит.';
    return plan;
  }
  if (existsSync(target)) {
    // Оба root'а сразу. Отметка отличает недоделанную уборку от чужого `.promptobus`:
    // первую доводим, второй — тот самый случай, ради которого отказ заведён.
    if (markOf(target)?.from === legacyHome) {
      plan.needed = true;
      return plan;
    }
    plan.refusal = `рядом лежат оба store шины: новый ${target} и прежний ${legacyHome}. `
      + 'Слить их механизм не берётся — он не знает, какая переписка новее. '
      + `Разбери руками: оставь нужный каталог, второй убери, и повтори команду.`;
    return plan;
  }
  plan.needed = true;
  const active = activeLegacyTasks(legacyHome);
  if (active.length) {
    plan.active = active;
    plan.refusal = `переход на новый store требует, чтобы активных задач не осталось, а их ${active.length}: `
      + `${active.join(', ')}.\nЗакрой каждую прежней версией CLI и повтори команду:\n`
      + active.map((id) => `  ${layout.done.replace('<id>', id)}`).join('\n');
  }
  return plan;
}

function activeLegacyTasks(legacyHome: string): string[] {
  const dir = path.join(legacyHome, 'tasks');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const active: string[] = [];
  for (const name of names.sort()) {
    if (!TASK_ID_RE.test(name)) continue;
    try {
      const meta = JSON.parse(readFileSync(path.join(dir, name, 'task.json'), 'utf8')) as { status?: string };
      // Битую задачу активной не считаем: активировать её всё равно нечем, а отказ по ней
      // не даёт закрыть её прежним CLI — тот на ней тоже споткнётся.
      if (meta?.status !== 'done') active.push(name);
    } catch {
      // Нечитаемый журнал — не активная задача. Уедет в migration-broken.
    }
  }
  return active;
}

/** Нужна ли миграция вообще. Отдельным предикатом: его зовут перед каждым обращением. */
export function migrationNeeded(root: string, layout: HostLegacyLayout | null = null): boolean {
  return preflight(root, layout).needed;
}

/**
 * Перенести store. Отказ preflight'а — `GateError` с человеческим текстом: это законный
 * исход, а не поломка механизма. Без layout — пустой отчёт, диск не трогается.
 */
export function migrate(root: string, {
  fault = NO_FAULT, waitMs = MIGRATION_WAIT_MS, session = null, harness = null, ...rest
}: MigrationOptions = {}): MigrationReport {
  const layout = layoutOf(rest);
  const plan = preflight(root, layout);
  if (plan.refusal) throw new GateError(plan.refusal);
  const empty = (): MigrationReport => ({
    root, from: plan.legacyHome, to: plan.target, tasks: [], brokenTasks: [], bindings: 0,
    moved: false, resumed: false,
  });
  if (!plan.needed) return empty();

  // **Переезд идёт под локом, и лок здесь не перестраховка.** Он запускается со старта
  // каждого stdio-сервера шины и с каждой команды, поэтому два процесса в одном рабочем
  // месте входят сюда почти одновременно — обычный случай, а не гонка из теории. Без лока
  // порядок теряет данные молча: A собрала часть, B снесла её временный каталог, A дописала
  // остаток и отметку, A переименовала — в новом корне неполный store с отметкой удавшейся
  // сборки, старый снесён, отката нет по построению задачи.
  //
  // Примитив тот же, что у журнала задачи: каталог с файлом владельца и снятием по мёртвому
  // pid ([fs/lock.ts](fs/lock.ts)). Проигравший НЕ отказывает: он переспрашивает preflight и
  // видит уже переехавший корень. Отказ на старте сервера значил бы «шина пропала» у второй
  // сессии на ровном месте.
  try {
    return withDirLock(lockOf(root), () => migrateLocked(root, layout, empty(), fault, harness), {
      waitMs,
      session,
      onMissing: () => new GateError(`рабочего места ${root} нет — переносить из него нечего`),
      onBusy: (held, waitedMs) => busyRefusal(root, held, waitedMs),
    });
  } catch (e) {
    if (!(e instanceof MigrationBusy)) throw e;
    // Лок досидел до конца — но сосед мог доделать переезд ровно в это окно. Спрашиваем
    // ещё раз: переехавший корень для нас исход, а не повод отказать.
    const after = preflight(root, layout);
    if (after.refusal) throw new GateError(after.refusal);
    if (!after.needed) return empty();
    throw e.refusal;
  }
}

/** Сам перенос — уже под локом: соседа здесь нет по построению. */
function migrateLocked(
  root: string,
  layout: HostLegacyLayout | null,
  report: MigrationReport,
  fault: MigrationFault,
  harness: string | null,
): MigrationReport {
  // Пока ждали лок, сосед мог сделать всё. Preflight переспрашивается ЗДЕСЬ, а не только
  // снаружи: снаружи он читался до ожидания, и решение по нему успело устареть.
  const plan = preflight(root, layout);
  if (plan.refusal) throw new GateError(plan.refusal);
  if (!plan.needed) return report;
  const { legacyHome, target } = plan;

  // Прежний запуск успел переключиться и не успел убрать legacy — доводим уборку.
  if (existsSync(target)) {
    report.moved = true;
    report.resumed = true;
    fault('cleanup', { target });
    rmSync(legacyHome, { recursive: true, force: true });
    return report;
  }

  const temp = tempOf(root);
  // Остаток чужой сборки под локом — уже мусор: на место каталог встаёт одним `rename`, и
  // недоделанный до него не доживает, а лок мы держим — значит прежний владелец либо снял
  // его сам, либо мёртв и снят по pid. Живого соседа этот `rm` застать не может.
  rmSync(temp, { recursive: true, force: true });

  try {
    fault('scan', { legacyHome });
    mkdirSync(path.join(temp, 'tasks'), { recursive: true });
    fault('temp', { temp });
    for (const id of legacyTaskIds(legacyHome)) {
      const one = migrateTask(legacyHome, temp, id, fault, harness);
      if (one) report.tasks.push(one);
      else report.brokenTasks.push(id);
    }
    report.bindings = copyBindings(legacyHome, temp);
    fault('sessions', { bindings: report.bindings });
    writeJsonAtomic(path.join(temp, MARK), {
      from: legacyHome,
      at: new Date().toISOString(),
      tasks: report.tasks.length,
      brokenTasks: report.brokenTasks.length,
    });
    fault('mark', { temp });
    // Точка переключения. До неё legacy-каталог не тронут ни разу.
    renameSync(temp, target);
    fault('switch', { target });
  } catch (e) {
    // Отказ до переключения не оставляет ни половины нового store, ни следа во старом.
    rmSync(temp, { recursive: true, force: true });
    throw e;
  }
  fault('cleanup', { legacyHome });
  rmSync(legacyHome, { recursive: true, force: true });
  report.moved = true;
  return report;
}

function legacyTaskIds(legacyHome: string): string[] {
  try {
    return readdirSync(path.join(legacyHome, 'tasks'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && TASK_ID_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// --- одна задача ---------------------------------------------------------------

/**
 * Детерминированный хвост id записи: та же legacy-запись даёт то же имя при любом
 * повторе. Случайный хвост здесь был бы прямой потерей — прерванная и повторённая
 * миграция раскладывала бы одни и те же сообщения под разными именами.
 */
function tail(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 6);
}

const LEGACY_MSG_RE = /^(\d{8}T\d{9})-(\d{4})-/;

/**
 * Имя сообщения v1 из legacy-имени. Штамп и счётчик берутся как есть: на них стоит порядок
 * истории, и сортировка строк обязана остаться той же. Отправитель из имени уходит — в v1
 * он лежит полем записи.
 *
 * **Хвост сеется каталогом, а не одним именем файла, и это не украшение.** Имена прежнего
 * store уникальны в пределах ОДНОГО mailbox'а, а не задачи: два отправителя под одним
 * адресом из двух процессов собирали одно имя, и разводил их `link` внутри своего каталога
 * (справочником). Посев одним именем дал бы
 * им один id на всю задачу — канон второго не записался бы (`existsSync`), ссылка проглотила
 * бы `EEXIST`, и сообщение исчезло бы молча. Детерминизм повтора при этом цел: каждый
 * legacy-файл лежит ровно в одном каталоге.
 */
function recordIdOf(legacyId: string, at: string, box: string): string {
  const seed = `${box}/${legacyId}`;
  const m = LEGACY_MSG_RE.exec(`${legacyId}-`);
  if (m) return `${m[1]}-${m[2]}-${tail(seed)}`;
  // Имя не по форме прежнего store (правка руками, чужой файл) — штамп берём из времени
  // записи, порядок при этом остаётся хронологическим.
  const stamp = new Date(Number.isFinite(Date.parse(at)) ? at : Date.now())
    .toISOString().replace(/[-:.]/g, '').replace('Z', '');
  return `${stamp}-0000-${tail(seed)}`;
}

function isoOf(value: unknown, fallback: string): string {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : fallback;
}

function migrateTask(legacyHome: string, temp: string, id: string, fault: MigrationFault, harness: string | null): TaskReport | null {
  const report: TaskReport = { id, participants: 0, messages: 0, unread: 0, read: 0, artifacts: 0, broken: [] };
  let meta: legacy.TaskMeta;
  try {
    meta = JSON.parse(readFileSync(path.join(legacyHome, 'tasks', id, 'task.json'), 'utf8')) as legacy.TaskMeta;
  } catch (e) {
    stashBrokenTask(legacyHome, temp, id, `журнал не разобран: ${(e as Error).message}`);
    return null;
  }
  const task = toV1Task(id, meta, harness);
  if (!task) {
    stashBrokenTask(legacyHome, temp, id, 'журнал не переводится в модель v1');
    return null;
  }
  report.participants = task.participants.length;
  mkdirSync(taskDir(temp, id), { recursive: true });

  // Артефакты идут ПЕРВЫМИ: сообщение ссылается на metadata-запись по id, и без карты
  // «имя файла → id» ссылку не переписать.
  const named = migrateArtifacts(legacyHome, temp, id, meta, report);
  fault('artifacts', { task: id, artifacts: report.artifacts });

  migrateMessages(legacyHome, temp, id, named, report);
  fault('messages', { task: id, messages: report.messages });

  writeJsonAtomic(path.join(taskDir(temp, id), 'task.json'), task);
  fault('task', { task: id });

  copySidecar(legacyHome, temp, id);
  fault('sidecar', { task: id });
  return report;
}

/** Повреждённая задача: каталог сохраняется целиком и НЕ попадает в `tasks/`. */
function stashBrokenTask(legacyHome: string, temp: string, id: string, why: string): void {
  const at = path.join(temp, 'migration-broken', id);
  mkdirSync(path.dirname(at), { recursive: true });
  cpSync(path.join(legacyHome, 'tasks', id), at, { recursive: true });
  writeFileSync(path.join(temp, 'migration-broken', `${id}.txt`), `${why}\n`);
}

/** Что подаётся переносу. Всё, кроме шва fault injection, — сведения adapter'а. */
export interface MigrationOptions {
  /** Шов fault injection. В production не подставляется. */
  fault?: MigrationFault;
  /** Сколько ждать лок переезда. */
  waitMs?: number;
  /**
   * Идентичность сессии, затеявшей переезд, — только для диагностики занятого лока.
   * Окружение читает adapter, поэтому значение приходит аргументом.
   */
  session?: string | null;
  /**
   * Harness записей прежнего CLI: у них поля `harness` нет вовсе, а v1 требует его в каждой
   * записи участника. Имён harness'ов в package нет и быть не может — их дом у driver'ов,
   * поэтому имя даёт adapter. Не назвали — запись говорит «harness не объявлен».
   */
  harness?: string | null;
  /**
   * Откуда мигрировать. Явный `null` — не из чего, даже если host другой. Не передали —
   * берётся `host.legacyLayout()`, а без host'а — тоже не из чего.
   */
  layout?: HostLegacyLayout | null;
  host?: Pick<PromptobusHost, 'legacyLayout'>;
}

function capsOf(value: unknown): CapabilitiesSnapshot | null {
  return validate('participant', {
    id: 'x', role: 'x', harness: 'x', mode: 'attached', sessionRef: null, capabilities: value, metadata: {},
  }).ok ? (value as CapabilitiesSnapshot | null) : null;
}

/**
 * Запись участника прежнего store в модель v1.
 *
 * Legacy-запись едет в `metadata` ЦЕЛИКОМ, и это главное свойство перевода: поля driver'а,
 * заголовок track'а, репозиторий, отметка снятия с наблюдения и всё, что adapter написал
 * когда-либо, возвращаются читателю байт в байт. Собственные поля v1 — `role`, `harness`,
 * `mode`, `sessionRef`, `capabilities` — вид на ту же запись: их читают схема, policy и
 * событие активации.
 */
function participantToV1(p: legacy.Participant, harness: string | null): ParticipantV1 {
  const declared = typeof p.harness === 'string' ? p.harness.trim() : '';
  const ref = typeof p.sessionRef === 'string' && p.sessionRef ? p.sessionRef
    : (typeof p.name === 'string' && p.name ? p.name : null);
  const raw = typeof p.mode === 'string' ? p.mode.trim() : '';
  const usable = isAddress(p?.address);
  return {
    // Негодный адрес запись НЕ роняет: одна испорченная строка не имеет права стоить
    // остальных, и `promptobus done` по такой записи всё равно приберёт секреты и каталоги
    // Id при этом обязан быть стабильным: тот же адрес даёт то же имя на каждом
    // проходе.
    id: usable ? addrDir(p.address) : `broken-${tail(String(p?.address))}`,
    role: usable ? roleOf(p.address) : UNDECLARED_ROLE,
    harness: declared || harness || UNDECLARED_HARNESS,
    // Режим обязателен схемой, а у legacy-записи его может не быть вовсе. Правило то же,
    // что у `modeOf`: сессию за участником поднимал spawn, значит `managed`; сессии нет —
    // `attached`, как у owner'а задачи. Незнакомое значение остаётся в `metadata`, и
    // разбирает его `modeOf` — здесь оно не имеет права стать «managed» молча.
    mode: raw === 'managed' || raw === 'attached' ? raw : (ref ? 'managed' : 'attached'),
    sessionRef: ref,
    capabilities: capsOf(p.capabilities ?? null),
    metadata: { ...p },
  };
}

function toV1Task(id: string, meta: legacy.TaskMeta, harness: string | null): TaskV1 | null {
  const participants: ParticipantV1[] = [];
  const seen = new Set<string>();
  for (const p of meta.participants ?? []) {
    // Перевод — тот же, которым его делает слой совместимости: две редакции одного
    // правила разъехались бы молча. Запись с негодным адресом он не роняет и не теряет —
    // id ей даёт стабильный хвост от самого адреса, а `promptobus done` по ней всё равно
    // приберёт секреты и каталоги.
    const one = participantToV1(p, harness);
    if (seen.has(one.id)) continue;
    seen.add(one.id);
    participants.push(one);
  }
  // Owner задачи обязан быть участником: у v1 он такая же запись. Прежний `createTask`
  // всегда клал `orchestrator`, но журнал, правленный руками, мог его лишиться.
  if (!seen.has(ORCHESTRATOR)) {
    participants.unshift(participantToV1({ address: ORCHESTRATOR }, harness));
  }
  const adapter: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!['id', 'title', 'status', 'created', 'participants'].includes(k)) adapter[k] = v;
  }
  const created = isoOf(meta.created, new Date().toISOString());
  const task: TaskV1 = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title: (typeof meta.title === 'string' && meta.title) ? meta.title.slice(0, 512) : id,
    status: meta.status === 'done' ? 'done' : 'active',
    owner: ORCHESTRATOR,
    created,
    updated: isoOf(meta.closed, created),
    participants,
    adapter,
  };
  return validate('task', task).ok ? task : null;
}

// --- артефакты ------------------------------------------------------------------

/**
 * Каждый файл `artifacts/` — в blob с SHA-256 плюс metadata-запись; имя файла остаётся
 * видимым человеку жёсткой ссылкой в `files/`. Возвращается карта «имя файла → id записи»:
 * по ней переписываются ссылки в сообщениях.
 *
 * Сирота — файл, на который не ссылается ни одно сообщение — переносится наравне с
 * остальными: удалить его вправе только `prune`, и то вместе с задачей.
 */
function migrateArtifacts(legacyHome: string, temp: string, id: string, meta: legacy.TaskMeta, report: TaskReport): Map<string, string> {
  const named = new Map<string, string>();
  const from = path.join(legacyHome, 'tasks', id, 'artifacts');
  let names: string[];
  try {
    names = readdirSync(from).sort();
  } catch {
    return named;
  }
  const stamp = new Date(isoOf(meta.created, new Date().toISOString()))
    .toISOString().replace(/[-:.]/g, '').replace('Z', '');
  let seq = 0;
  for (const name of names) {
    const src = path.join(from, name);
    let content: Buffer;
    try {
      if (!statSync(src).isFile()) continue;
      content = readFileSync(src);
    } catch (e) {
      report.broken.push(`артефакт ${name}: не прочитан (${(e as Error).message})`);
      continue;
    }
    seq += 1;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const record: ArtifactV1 = {
      schemaVersion: SCHEMA_VERSION,
      id: `${stamp}-${String(seq).padStart(4, '0')}-${tail(name)}`,
      sha256,
      filename: name,
      size: content.length,
      blob: blobRef(sha256),
    };
    if (!validate('artifact', record).ok) {
      const attic = path.join(taskDir(temp, id), 'broken', 'artifacts');
      mkdirSync(attic, { recursive: true });
      copyFileSync(src, path.join(attic, name));
      report.broken.push(`артефакт ${name}: metadata не по схеме v1 — отложен в broken/artifacts`);
      continue;
    }
    mkdirSync(blobsDir(temp, id), { recursive: true });
    const blob = blobFile(temp, id, sha256);
    // Blob неизменяем и дедуплицируется внутри задачи: два одноимённых файла с одним
    // содержимым дают две metadata-записи и один blob.
    if (!existsSync(blob)) writeFileSync(blob, content);
    mkdirSync(artifactsDir(temp, id), { recursive: true });
    writeJsonAtomic(path.join(artifactsDir(temp, id), `${record.id}.json`), record);
    const files = path.join(taskDir(temp, id), 'files');
    mkdirSync(files, { recursive: true });
    try {
      linkSync(blob, path.join(files, name));
    } catch {
      // Имя занято — так выглядит одноимённый файл с другим содержимым; прежний store
      // разводил их номером ещё при отправке, и здесь оба имени уже разные.
    }
    named.set(name, record.id);
    report.artifacts += 1;
  }
  return named;
}

// --- сообщения ------------------------------------------------------------------

function migrateMessages(legacyHome: string, temp: string, id: string, named: Map<string, string>, report: TaskReport): void {
  const taskAt = path.join(legacyHome, 'tasks', id);
  for (const [box, target] of [['inbox', 'inbox'], ['read', 'history']] as const) {
    for (const dir of boxes(path.join(taskAt, box))) {
      for (const name of records(path.join(taskAt, box, dir))) {
        const moved = migrateMessage(path.join(taskAt, box, dir, name), temp, id, dir, target, named, report);
        if (moved) {
          report.messages += 1;
          if (target === 'inbox') report.unread += 1;
          else report.read += 1;
        }
      }
    }
  }
  // Уже отложенное прежним store: `broken/<адрес>` → `broken/inbox/<участник>`. Каталогов
  // у `broken/` в v1 три, а не один — участник с id `artifacts` иначе увёл бы чужое.
  for (const dir of boxes(path.join(taskAt, 'broken'))) {
    const attic = brokenInboxDir(temp, id, dir);
    mkdirSync(attic, { recursive: true });
    for (const name of readdirSync(path.join(taskAt, 'broken', dir))) {
      copyFileSync(path.join(taskAt, 'broken', dir, name), path.join(attic, name));
      report.broken.push(`сообщение ${dir}/${name}: отложено прежним store — перенесено в broken/inbox`);
    }
  }
}

function boxes(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function records(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

function migrateMessage(src: string, temp: string, id: string, box: string, target: 'inbox' | 'history',
  named: Map<string, string>, report: TaskReport): boolean {
  let raw: string;
  try {
    raw = readFileSync(src, 'utf8');
  } catch (e) {
    report.broken.push(`сообщение ${box}/${path.basename(src)}: не прочитано (${(e as Error).message})`);
    return false;
  }
  let legacyMsg: legacy.Message | null = null;
  let why = '';
  try {
    legacyMsg = JSON.parse(raw) as legacy.Message;
  } catch (e) {
    why = `не разобрано (${(e as Error).message})`;
  }
  const message = legacyMsg && !why ? toV1Message(id, legacyMsg, named, box) : null;
  if (!message) {
    // Битая или непереводимая запись — в `broken/inbox/<участник>` под своим именем.
    // Обрезанный файл, оставшийся от смерти процесса посреди записи, выглядит именно так.
    const attic = brokenInboxDir(temp, id, box);
    mkdirSync(attic, { recursive: true });
    writeFileSync(path.join(attic, path.basename(src)), raw);
    report.broken.push(`сообщение ${box}/${path.basename(src)}: ${why || 'не переводится в протокол v1'} `
      + '— отложено в broken/inbox');
    return false;
  }
  // Канон и ссылка получателю — один inode, как у отправки: ссылка ставится ПОСЛЕ канона,
  // и повторный проход по готовому не делает ничего.
  mkdirSync(messagesDir(temp, id), { recursive: true });
  const canonical = path.join(messagesDir(temp, id), `${message.id}.json`);
  if (!existsSync(canonical)) writeFileSync(canonical, `${JSON.stringify(message, null, 2)}\n`);
  const at = target === 'inbox' ? inboxDir(temp, id, box) : historyDir(temp, id, box);
  mkdirSync(at, { recursive: true });
  try {
    linkSync(canonical, path.join(at, `${message.id}.json`));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return true;
}

function toV1Message(task: string, m: legacy.Message, named: Map<string, string>, box: string): MessageV1 | null {
  if (!isAddress(m?.from) || !isAddress(m?.to)) return null;
  const ts = isoOf(m.ts, '');
  if (!ts) return null;
  const artifact = typeof m.artifact === 'string' ? named.get(m.artifact) : undefined;
  const message: MessageV1 = {
    protocolVersion: MESSAGE_PROTOCOL_VERSION,
    id: recordIdOf(String(m.id ?? ''), ts, box),
    task,
    sender: addrDir(m.from),
    recipients: [addrDir(m.to)],
    type: String(m.type),
    body: String(m.body ?? ''),
    ...(artifact ? { artifact } : {}),
    ts,
  };
  return validate('message', message).ok ? message : null;
}

// --- файлы adapter'а -------------------------------------------------------------

/**
 * Что переносится как есть: файлы, которых не держит ни один store.
 *
 * `wake/` в списке нет намеренно. Contact point несёт адрес messaging-сокета и токен живой
 * сессии; сессий на момент миграции не бывает (активные задачи её блокируют), а сдают их
 * участники сами при первом же обращении к шине. Перенесённый contact point был бы адресом
 * умершего сокета — надзиратель стучал бы в него до первого отказа.
 */
const SIDECAR = ['health.json', 'supervisor.json', 'supervisor.log', 'stalls.json', 'waits', 'workers'];

function copySidecar(legacyHome: string, temp: string, id: string): void {
  const from = path.join(legacyHome, 'tasks', id);
  for (const name of SIDECAR) {
    const src = path.join(from, name);
    if (!existsSync(src)) continue;
    cpSync(src, path.join(taskDir(temp, id), name), { recursive: true });
  }
}

/** Привязки «сессия → задача» — как есть: их формат store не касается вовсе. */
function copyBindings(legacyHome: string, temp: string): number {
  const from = path.join(legacyHome, 'sessions');
  let names: string[];
  try {
    names = readdirSync(from).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }
  if (!names.length) return 0;
  mkdirSync(path.join(temp, 'sessions'), { recursive: true });
  for (const name of names) copyFileSync(path.join(from, name), path.join(temp, 'sessions', name));
  return names.length;
}

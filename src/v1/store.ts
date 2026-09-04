// Журнал задачи v1: задача, участники, owner и его явный захват.
//
// Отличия от legacy store не косметические, и оба названы решением:
//
// 1. **Owner — такой же participant.** У него есть `harness`, `mode`, `sessionRef` и
// `capabilities`, как у любого другого, и записывается он при заведении задачи. Fallback'а
// по harness'у в v1 нет вовсе: он заводился в registry ровно ради записи владельца,
// которую legacy `createTask` клал без этого поля.
// 2. **Обновление участника — patch по полям, а не замена записи целиком.** У legacy
// `upsertParticipant` второй вызов, дописывающий одно поле, обязан класть обратно ТУ ЖЕ
// запись — иначе поля первого вызова исчезают молча. Здесь такого
// инварианта нет: patch трогает названные поля и проверяет схему после слияния.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { writeJsonAtomic } from '../fs/atomic.js';
import { addressOf, mechanismVersionOf } from '../protocol.js';
import { withDirLock } from '../fs/lock.js';
import { fail, PromptobusError } from './errors.js';
import { lockDir, taskDir, taskFile, tasksDir } from './layout.js';
import { SCHEMA_VERSION } from './model.js';
import type { ParticipantV1, TaskV1 } from './model.js';
import { requireValid, validate } from './validate.js';

/** Часы store: набор подставляет свои, чтобы штампы были предсказуемы. */
export type Clock = () => Date;

/** Что кладётся в новую задачу. Owner — полноценная запись участника, а не один id. */
export interface NewTask {
  id: string;
  title: string;
  owner: ParticipantV1;
  adapter?: Record<string, unknown>;
}

/**
 * Версия механизма, читающего журнал. Приходит АРГУМЕНТОМ, как home и policy:
 * собственной версии у package нет вовсе (номер журнала — дело того, кто открыл engine), а копилка на
 * уровне модуля была бы мостом для чужого значения — ровно тем, что здесь запрещено.
 * Задаётся при открытии engine и оттуда доходит до каждого чтения.
 *
 * `null` — «сравнить не с чем»: смесь версий не различается, работает прежний путь целиком.
 */
export type ReaderVersion = string | null;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Числовое сравнение версий: 0.10.0 новее 0.9.0, строками — наоборот. Свой, а не общий с
// CLI: package не импортирует модулей потребителя вовсе, на этом стоит standalone-сборка. `null` —
// «сравнить нечем»: номер в журнале пишет механизм, но читаем мы его как чужой текст.
function cmpVersion(a: string, b: string): number | null {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (![...pa, ...pb].every((n) => Number.isInteger(n) && n >= 0)) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Участник, чью запись сделал механизм НОВЕЕ читателя. Свидетельство — версия механизма в
 * записи: её кладёт adapter при подъёме участника, и по ней «журнал испорчен» отличается от
 * «журнал новее этой сессии».
 *
 * Спрашивается СНАЧАЛА тот участник, на чьей записи споткнулся валидатор: `verdict.at`
 * называет его индексом, и назвать вместо него первого попавшегося с маркером значило бы
 * увести человека к чужой записи — новый CLI перезаписывает и владельца, а тот в журнале
 * первый. Путь не участника (лишнее поле у самого журнала) индекса не несёт — тогда годится
 * любой участник с маркером новее: журнал целиком трогал механизм новее этой сессии.
 */
function writtenByNewer(meta: unknown, at: string, reader: ReaderVersion): { address: string; version: string } | null {
  if (!reader || !isObject(meta) || !Array.isArray(meta.participants)) return null;
  const named = /^participants\[(\d+)\]/.exec(at);
  const candidates = named ? [meta.participants[Number(named[1])]] : meta.participants;
  for (const p of candidates) {
    const version = mechanismVersionOf(p as { metadata?: Record<string, unknown> });
    if (version === null || cmpVersion(version, reader) !== 1) continue;
    // Человеку участника называют адресом, а не id каталога mailbox'а: адрес и есть то, что
    // он видел в отчёте spawn'а.
    const address = addressOf(p as { metadata?: Record<string, unknown> })
      ?? String((p as { id?: unknown })?.id ?? '?');
    return { address, version };
  }
  return null;
}

/** Read-modify-write журнала под локом задачи. */
export function withTaskLock<T>(home: string, task: string, fn: () => T, { waitMs = 5000 } = {}): T {
  return withDirLock(lockDir(home, task), fn, {
    waitMs,
    onMissing: () => new PromptobusError('task-not-found', `задачи ${task} нет в ${tasksDir(home)}`, { task }),
    onBusy: (held, waitedMs) => new PromptobusError('lock-busy',
      `журнал задачи ${task} занят: ждали ${waitedMs} мс`,
      { task, waitedMs, holder: held }),
  });
}

export function taskExists(home: string, task: string): boolean {
  try {
    return existsSync(taskFile(home, task));
  } catch {
    // Негодный id — не «задачи нет», а отказ грамматики; но спрашивают это и обходом по
    // диску, где посторонний каталог законен.
    return false;
  }
}

/**
 * Прочитать журнал. Нечитаемый или невалидный — `task-broken`: повреждённая задача блокирует
 * только себя, остальные работают (`listTasks` её пропускает).
 */
export function readTask(home: string, task: string, cli: ReaderVersion = null): TaskV1 {
  const file = taskFile(home, task);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    fail('task-not-found', `задачи ${task} нет в ${tasksDir(home)}`, { task, file });
  }
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch (e) {
    fail('task-broken', `журнал задачи ${task} не разобран: ${(e as Error).message}`, { task, file });
  }
  const verdict = validate('task', meta);
  if (!verdict.ok) {
    // Незнакомые поля плюс запись, сделанная механизмом новее этой сессии, — не порча
    // журнала, а смесь версий после `sync`: MCP-сервер шины живой сессии поднят
    // из прежнего релиза и полей нового не знает. Лечится это новой сессией, и отказ обязан
    // называть лечение, иначе человек чинит несуществующую поломку журнала.
    const ahead = verdict.extra.length ? writtenByNewer(meta, verdict.at, cli) : null;
    if (ahead) {
      fail('schema-version-unsupported',
        `журнал задачи ${task}: запись участника ${ahead.address} сделана механизмом ${ahead.version}, `
        + `эта сессия работает на ${cli} — начни новую сессию, `
        + 'MCP-сервер шины стартует из установленного релиза',
        { task, file, at: verdict.at, participant: ahead.address, wrote: ahead.version, reader: cli });
    }
    // Более новая версия схемы — свой код и здесь: такую задачу нельзя ни читать как свою,
    // ни объявлять испорченной. Чинится она обновлением механизма, а не изоляцией записи.
    fail(verdict.code === 'schema-version-unsupported' ? 'schema-version-unsupported' : 'task-broken',
      `журнал задачи ${task} не по схеме: ${verdict.at} ${verdict.note}`, { task, file, at: verdict.at });
  }
  return meta as TaskV1;
}

/** Записать журнал целиком. Валидация до записи: негодное в store не попадает вовсе. */
export function writeTask(home: string, meta: TaskV1, now: Clock): TaskV1 {
  const next: TaskV1 = { ...meta, updated: now().toISOString() };
  requireValid('task', next, { task: next.id });
  writeJsonAtomic(taskFile(home, next.id), next);
  return next;
}

/**
 * Завести задачу. «Первым выигрывает»: журнал кладётся флагом `wx`, и опоздавший получает
 * отказ, а не тихо уносит чужих участников.
 */
export function createTask(home: string, { id, title, owner, adapter = {} }: NewTask, now: Clock): TaskV1 {
  requireValid('participant', owner, { task: id, participant: (owner as ParticipantV1)?.id });
  const at = now().toISOString();
  const meta: TaskV1 = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title,
    status: 'active',
    owner: owner.id,
    created: at,
    updated: at,
    participants: [owner],
    adapter,
  };
  requireValid('task', meta, { task: id });
  const file = taskFile(home, id);
  mkdirSync(taskDir(home, id), { recursive: true });
  try {
    // Флаг `wx`, а не атомарная подмена: имя занимает сама запись, и второй заход тем же id
    // получает отказ вместо тихой перезаписи. Проверка `existsSync` перед записью была бы
    // тем же окном, только шире — между ней и записью помещается сосед.
    writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('task-exists', `задача ${id} уже есть`, { task: id });
    throw e;
  }
  return meta;
}

/** Задача, которую не прочитать: её id и причина. Текст человеку собирает adapter. */
export interface BrokenTask {
  id: string;
  note: string;
}

/** Перечислить задачи. Одна порченая не имеет права гасить остальные. */
export function listTasks(home: string, cli: ReaderVersion = null): { tasks: TaskV1[]; broken: BrokenTask[] } {
  const dir = tasksDir(home);
  const tasks: TaskV1[] = [];
  const broken: BrokenTask[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { tasks, broken };
  }
  for (const name of names.sort()) {
    if (!taskExists(home, name)) continue;
    try {
      tasks.push(readTask(home, name, cli));
    } catch (e) {
      broken.push({ id: name, note: (e as Error).message });
    }
  }
  return { tasks, broken };
}

export function participantOf(meta: TaskV1, id: string): ParticipantV1 | null {
  return meta.participants.find((p) => p.id === id) ?? null;
}

export function requireParticipant(meta: TaskV1, id: string): ParticipantV1 {
  const found = participantOf(meta, id);
  if (!found) {
    fail('participant-not-found', `в задаче ${meta.id} нет участника «${id}»`,
      { task: meta.id, participant: id, known: meta.participants.map((p) => p.id) });
  }
  return found;
}

/** Добавить участника. Существующий id — отказ: перезапись стёрла бы его поля молча. */
export function addParticipant(home: string, task: string, participant: ParticipantV1, now: Clock,
  cli: ReaderVersion = null): ParticipantV1 {
  requireValid('participant', participant, { task, participant: participant?.id });
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    if (participantOf(meta, participant.id)) {
      fail('participant-exists', `в задаче ${task} участник «${participant.id}» уже есть`,
        { task, participant: participant.id });
    }
    writeTask(home, { ...meta, participants: [...meta.participants, participant] }, now);
    return participant;
  });
}

/**
 * Положить запись участника целиком, заменив прежнюю. Отличие от `patchParticipant` не в
 * удобстве: подъём участника кладёт НОВУЮ запись — новая сессия, новый снимок capabilities —
 * и обязан унести с ней всё, что относилось к прежней, включая отметки adapter'а в
 * `metadata`. Патч по полям оставил бы их от умершей сессии.
 *
 * Возвращается журнал целиком: вызывающему нужен и он — по нему считается заголовок задачи
 * из track'ов, и делать второе чтение сразу после записи было бы чтением из-под соседа.
 */
export function putParticipant(home: string, task: string, participant: ParticipantV1, now: Clock,
  cli: ReaderVersion = null): TaskV1 {
  requireValid('participant', participant, { task, participant: participant?.id });
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    const rest = meta.participants.filter((p) => p.id !== participant.id);
    return writeTask(home, { ...meta, participants: [...rest, participant] }, now);
  });
}

/** Что можно поправить в записи участника. `id` не патчится: он и есть адрес. */
export type ParticipantPatch = Partial<Omit<ParticipantV1, 'id'>>;

/**
 * Поправить участника патчем по полям. Не заменой целиком: у legacy `upsertParticipant`
 * второй вызов, дописывающий поле, обязан класть обратно ту же запись, иначе поля первого
 * исчезают молча. Схема проверяется ПОСЛЕ слияния — патч, ломающий запись,
 * отказывает до записи журнала.
 */
export function patchParticipant(home: string, task: string, id: string, patch: ParticipantPatch, now: Clock,
  cli: ReaderVersion = null): ParticipantV1 {
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    const was = requireParticipant(meta, id);
    const next: ParticipantV1 = { ...was, ...patch, id: was.id };
    requireValid('participant', next, { task, participant: id });
    writeTask(home, {
      ...meta,
      participants: meta.participants.map((p) => (p.id === id ? next : p)),
    }, now);
    return next;
  });
}

/**
 * Захват владения задачей. Owner у задачи один, и меняется он только так — молчаливого
 * перехвата не бывает. Возвращается прежний владелец: поле одно, истории нет.
 */
export function claimOwner(home: string, task: string, id: string, now: Clock,
  cli: ReaderVersion = null): string {
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    requireParticipant(meta, id);
    const was = meta.owner;
    if (was !== id) writeTask(home, { ...meta, owner: id }, now);
    return was;
  });
}

/**
 * Закрыть задачу. Поля adapter'а ложатся ТЕМ ЖЕ ходом: отметку закрытия пишет он, и второй
 * лок ради одного поля стоил бы задачи, закрытой без неё.
 */
export function closeTask(home: string, task: string, now: Clock, adapter?: Record<string, unknown>,
  cli: ReaderVersion = null): TaskV1 {
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    return writeTask(home, {
      ...meta,
      status: 'done',
      ...(adapter === undefined ? {} : { adapter: { ...meta.adapter, ...adapter } }),
    }, now);
  });
}

/** Активна ли задача. Отправка в закрытую — отказ: переписку закрытой задачи не ведут. */
export function requireActive(meta: TaskV1): TaskV1 {
  if (meta.status !== 'active') {
    fail('task-closed', `задача ${meta.id} закрыта`, { task: meta.id, status: meta.status });
  }
  return meta;
}

export { taskDir };

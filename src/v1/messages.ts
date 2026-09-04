// Восстановимый fan-out, mailbox и history protocol v1.
//
// **Устройство fan-out'а держится на одном inode.** Каноническое сообщение, fan-out intent
// и каждая ссылка в inbox — жёсткие ссылки на один и тот же файл, и это не экономия места,
// а способ получить атомарность там, где файловая система её не даёт: двух файлов одним
// `rename` не создать, а «создать intent» — это ровно один атомарный `open(O_EXCL)`.
//
// Порядок такой:
//
// 1. Провалидировать получателей и routing policy — до первого side effect.
// 2. Создать `intents/<id>.json` флагом `wx`. **Это точка коммита**: с неё сообщение
// существует, и всё остальное восстановимо, потому что intent и ЕСТЬ каноническое
// сообщение целиком — получатели лежат в нём же.
// 3. Связать канон: `link(intent → messages/<id>.json)`. Идемпотентно.
// 4. Связать ссылку в inbox каждому получателю. Идемпотентно: `EEXIST` значит «уже есть».
// 5. Снять intent, когда ссылки есть у всех.
//
// После падения недостающее дописывает `recoverTask` — при открытии engine и по вызову.
// Сверяются ПРИ ЭТОМ ДВА места, inbox и history: ссылка, которой нет в inbox, могла быть
// уже прочитана, и восстановление, смотрящее только в inbox, вернуло бы прочитанное второй
// раз. Активация идёт независимо и ПОСЛЕ того, как fan-out лёг на диск.
//
// Требование к ФС наследуется целиком: жёсткие ссылки внутри одного тома. Их
// отсутствие — законное условие среды, и отвечает на него типизированный код
// `link-refused`, а не половинчатая запись.
import {
  existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import type { NotificationMessage } from '../driver.js';
import { pidAlive } from '../fs/proc.js';
import { linkFailure } from './artifacts.js';
import { fail } from './errors.js';
import {
  brokenInboxDir, brokenMessagesDir, historyDir, historyRef, inboxDir, inboxRef, intentFile,
  intentsDir, messageFile, messagesDir, ownerOfIntent, taskDir,
} from './layout.js';
import { MESSAGE_PROTOCOL_VERSION } from './model.js';
import type { MessageV1, ParticipantV1, TaskV1 } from './model.js';
import { validate } from './validate.js';

/** Шаги fan-out'а, после каждого из которых набор умеет уронить процесс. */
export type FanoutStep = 'validate' | 'blob' | 'artifact' | 'intent' | 'canonical' | 'ref' | 'close' | 'read';

/**
 * Шов fault injection. Зовётся ПОСЛЕ каждого durable-шага; бросок из него — падение ровно
 * в этой точке. В production не подставляется вовсе, и это единственный способ проверить
 * восстановление: настоящее падение процесса посреди шага набором не воспроизводится.
 */
export type FaultHook = (step: FanoutStep, info: Record<string, unknown>) => void;

const NO_FAULT: FaultHook = () => {};

/** Событие «кого будить». Форма — та, которую принимает `activate` driver'а. */
export interface ActivationEvent {
  kind: 'unread';
  task: string;
  /** ID участника. В v1 он же адрес доставки: роль из него не выводится. */
  address: string;
  /** Opaque session reference участника — первый аргумент `activate`. */
  ref: string | null;
  unread: number;
  messages: NotificationMessage[];
}

/** Выжимка сообщения для notification: текст собирает driver, рамка принадлежит каналу. */
export function previewOf(m: MessageV1): NotificationMessage {
  return {
    id: m.id,
    type: m.type,
    from: m.sender,
    ts: m.ts,
    body: m.body,
    artifact: m.artifact ?? null,
  };
}

let seq = 0;

/**
 * Новый id записи: штамп времени, счётчик отправителя и случайный хвост. Сортировка строк
 * равна порядку отправки, поэтому истории вторых часов не нужно. Хвост случайный, а не
 * только счётчик: `seq` живёт в памяти процесса, а под одним адресом ходят и сессия, и её
 * фоновая команда — два процесса в одну миллисекунду собирали бы одно имя.
 */
export function newRecordId(now: Date): string {
  seq = (seq + 1) % 10000;
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('Z', '');
  return `${stamp}-${String(seq).padStart(4, '0')}-${randomBytes(3).toString('hex')}`;
}

// Идемпотентная жёсткая ссылка: `true` — поставили, `false` — она уже была. `EEXIST` здесь
// не отказ, а весь смысл шага: восстановление дописывает недостающее, не трогая готового.
function linkOnce(from: string, to: string): boolean {
  mkdirSync(path.dirname(to), { recursive: true });
  try {
    linkSync(from, to);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw linkFailure(e, to);
  }
}

/** Есть ли у получателя ссылка — в inbox'е либо уже в history. */
function delivered(home: string, task: string, participant: string, message: string): boolean {
  return existsSync(inboxRef(home, task, participant, message))
    || existsSync(historyRef(home, task, participant, message));
}

/**
 * Порог, после которого незакрытый intent считается брошенным независимо от лизинга.
 *
 * Он же — верхний предел лизинга: pid, переиспользованный ОС под чужой процесс, иначе запирал
 * бы чужой intent навсегда, и недоставленное лежало бы вечно. Запас взят от стоимости одной
 * отправки: замер 2026-09-02, 500 отправок подряд — 1,4 мс CPU на отправку при медиане
 * 1,3 мс; под нагрузкой (load average 38–44) медиана та же, а хвост растягивает планировщик:
 * p99 35–67 мс, самая долгая из полутора тысяч — 141 мс. Порог больше неё в двести раз, и
 * дольше отправки intent живым не бывает вовсе: от `wx`-создания до снятия идёт синхронный
 * блок.
 *
 * Экспортирован ради цитаты контракта: справочник называет порог секундами, и
 * `lint` сверяет то число с этой константой через `dist`; других потребителей снаружи нет.
 */
export const INTENT_STALE_MS = 30_000;

/**
 * Лизинг: кто пишет этот fan-out прямо сейчас. Ложится РЯДОМ с intent'ом, отдельным файлом,
 * а не полем в записи: intent и канон — один inode, и поле уехало бы в inbox каждого
 * получателя и в history, а читатель прежней версии отверг бы такое сообщение схемой
 * (`additionalProperties: false`) и увёз бы его в `broken`. Отдельный файл прежним читателям
 * невидим по построению — каталог intents они обходят по маске `.json`.
 *
 * Отказ записи отправку не отменяет: точка коммита — intent, а лизинг лишь ускоряет
 * восстановление; без него intent считается брошенным по возрасту.
 *
 * Флаг `w`, а не `wx`: исключительность уже выиграна `wx`-созданием самого intent'а, а `wx`
 * здесь значил бы «осиротевший `<id>.owner` под тем же именем остаётся чужим» — свежий intent
 * нёс бы чужие pid и host и либо объявлялся брошенным сразу, либо ждал порога впустую. Что
 * имена могут повториться, код считает сам: `commitIntent` пересобирает id по `EEXIST` до 16
 * раз.
 */
function leaseIntent(intent: string): void {
  try {
    writeFileSync(ownerOfIntent(intent),
      `${JSON.stringify({ pid: process.pid, host: os.hostname() })}\n`, { flag: 'w' });
  } catch {
    // Лизинга нет — восстановление подберёт intent по возрасту, а не по живости владельца.
  }
}

/** Запись лизинга; `null` — лизинга нет, он нечитаем или неполон. */
function readLease(file: string): { pid: number; host: string } | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const { pid, host } = raw as { pid?: unknown; host?: unknown };
    if (!Number.isInteger(pid) || typeof host !== 'string') return null;
    return { pid: pid as number, host };
  } catch {
    return null;
  }
}

/**
 * Брошен ли незакрытый intent — то есть вправе ли восстановление его трогать.
 *
 * Живой fan-out соседа подбирать нельзя: восстановление материализует канон и снимает intent,
 * а владелец в этот момент идёт к своему `link` — и получает `ENOENT` на доставленном
 * сообщении, то есть отказ на успехе.
 *
 * Ветки, в этом порядке:
 * 1. возраст не меньше `INTENT_STALE_MS` — брошен независимо от лизинга (верхний предел).
 * Считается он локальными часами по `mtime`, а на разделяемом монтировании `mtime` ставит
 * машина владельца: ветка допускает, что часы у дома одни. Разъехавшиеся часы двигают сам
 * порог, но не решение по живому владельцу — того сторожит ветка 2 сверкой host'а;
 * 2. лизинга нет либо он с чужой машины — живость владельца неизвестна, ждём порога;
 * 3. pid наш — брошен. Жизнь intent'а внутри процесса это ОДИН синхронный блок:
 * `commitIntent` и `completeFanout` синхронны целиком, а все await'ы `send` стоят до точки
 * коммита, поэтому свой pid на intent'е значит «прошлый процесс с тем же номером», а не
 * «пишется прямо сейчас». Появится await между созданием intent'а и его снятием — ветка
 * станет неверной, и краснеют на этом проверки падений в `v1-engine.test.mjs`: они роняют
 * отправку швом и восстанавливают ТЕМ ЖЕ процессом;
 * 4. иначе решает живость pid'а владельца.
 */
function abandonedIntent(intent: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(intent).mtimeMs;
  } catch {
    // Intent унесли между листингом каталога и проверкой — восстанавливать нечего.
    return false;
  }
  if (age >= INTENT_STALE_MS) return true;
  const lease = readLease(ownerOfIntent(intent));
  if (!lease || lease.host !== os.hostname()) return false;
  return lease.pid === process.pid || !pidAlive(lease.pid);
}

/** Шаг 2: создать intent. Атомарный `open(O_EXCL)` — точка коммита всего fan-out'а. */
function openIntent(home: string, task: string, message: MessageV1): void {
  mkdirSync(intentsDir(home, task), { recursive: true });
  const intent = intentFile(home, task, message.id);
  writeFileSync(intent, `${JSON.stringify(message, null, 2)}\n`, { flag: 'wx' });
  // Лизинг ПОСЛЕ intent'а, а не до: осиротевший лизинг ничей fan-out не описывает, а окно
  // «intent есть, лизинга ещё нет» закрыто возрастом — такой intent моложе порога.
  leaseIntent(intent);
}

/**
 * Шаг 3: связать канон с intent'ом. Идемпотентно — восстановление зовёт то же самое.
 *
 * Проверки «канон уже есть» перед ссылкой здесь нет, и это не упрощение: она была тем же
 * окном, только шире — между ней и `link` помещается сосед. `EEXIST` от самой ссылки уже
 * значит «канон на месте», а сообщает об этом `linkOnce` возвратом `false`.
 *
 * `ENOENT` на источнике — не отказ, а «материализовано другим»: intent унёс сосед, доведший
 * тот же fan-out до конца, и канон уже на месте. Отказ отсюда обрывал цикл отправителя на
 * ДОСТАВЛЕННОМ сообщении. А вот если канона при этом нет — это настоящая потеря,
 * и она остаётся отказом.
 */
function materialize(home: string, task: string, message: string): boolean {
  const canonical = messageFile(home, task, message);
  try {
    return linkOnce(intentFile(home, task, message), canonical);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    if (existsSync(canonical)) return false;
    return fail('link-refused', `intent унесён, а канона нет: ${canonical}`,
      { task, message, target: canonical, errno: 'ENOENT' });
  }
}

/**
 * Шаги 3–5 одним проходом: канон, ссылки получателям, снятие intent'а. Зовётся и отправкой,
 * и восстановлением — ровно один код, иначе восстановление чинило бы не то, что ломалось.
 */
export function completeFanout(home: string, task: string, message: MessageV1, fault: FaultHook = NO_FAULT): string[] {
  materialize(home, task, message.id);
  fault('canonical', { task, message: message.id });
  const fresh: string[] = [];
  for (const [index, recipient] of message.recipients.entries()) {
    // Свежим — тем, кого надо разбудить, — получатель считается у того процесса, чья ссылка
    // легла. `linkOnce` отдаёт `false` по `EEXIST`, когда между `delivered()` и `link` ссылку
    // успел поставить сосед: двое восстановителей иначе назвали бы получателя свежим оба, и
    // на одно сообщение ушли бы два события активации. Доставка при этом одна —
    // ссылка одна, — задваивался только доклад о ней.
    if (!delivered(home, task, recipient, message.id)
      && linkOnce(messageFile(home, task, message.id), inboxRef(home, task, recipient, message.id))) {
      fresh.push(recipient);
    }
    fault('ref', { task, message: message.id, recipient, index });
  }
  // Шаг 5. Только после ссылок у ВСЕХ: снятый раньше intent унёс бы с собой единственный
  // след недоставленного, и недостающую ссылку не дописал бы никто. Лизинг уходит вместе с
  // ним: он описывает незакрытый fan-out, а закрытому владелец не нужен.
  const intent = intentFile(home, task, message.id);
  rmSync(intent, { force: true });
  rmSync(ownerOfIntent(intent), { force: true });
  fault('close', { task, message: message.id });
  return fresh;
}

/** Сколько непрочитанного лежит у участника. */
export function countInbox(home: string, task: string, participant: string): number {
  return inboxNames(inboxDir(home, task, participant)).length;
}

function inboxNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/** Собрать событие активации по участнику: что у него лежит и чем его будить. */
export function eventFor(home: string, task: string, participant: ParticipantV1, messages: MessageV1[]): ActivationEvent {
  return {
    kind: 'unread',
    task,
    address: participant.id,
    ref: participant.sessionRef,
    unread: countInbox(home, task, participant.id),
    messages: messages.map(previewOf),
  };
}

/** Собрать каноническое сообщение. Валидация — на стороне вызывающего, до первой записи. */
export function newMessage(task: string, sender: string, recipients: string[], type: string, body: string, artifact: string | null, now: Date): MessageV1 {
  return {
    protocolVersion: MESSAGE_PROTOCOL_VERSION,
    id: newRecordId(now),
    task,
    sender,
    recipients: [...recipients],
    type,
    body,
    ...(artifact ? { artifact } : {}),
    ts: now.toISOString(),
  };
}

/** Шаг 2 с повтором по занятому имени: id собирается заново, а не подменяется молча. */
export function commitIntent(home: string, task: string, message: MessageV1, now: Date): MessageV1 {
  let current = message;
  for (let tries = 0; ; tries += 1) {
    try {
      openIntent(home, task, current);
      return current;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (tries >= 16) fail('schema-invalid', `имя сообщения не удалось занять за ${tries} попыток`, { task });
      current = { ...current, id: newRecordId(now) };
    }
  }
}

/**
 * Что нашлось нечитаемого при чтении mailbox'а. Причина и место разведены полями, а не
 * склеены в строку: текст человеку собирает adapter, и склейка заставляла бы его резать
 * её обратно регексом — два канала доклада разъезжались бы на первой же правке слов.
 */
export interface BrokenNote {
  name: string;
  code: string;
  /** Почему запись не прочиталась. */
  note: string;
  /** Каталог, куда запись отложена; `null` — осталась на месте. */
  attic: string | null;
  /** Почему отложить не вышло; `null` — вышло либо и не пробовали. */
  failure: string | null;
}

/** Куда уехала запись: каталог либо причина, по которой отложить не вышло. */
function isolate(from: string, atticDir: string, name: string): { attic: string | null; failure: string | null } {
  try {
    mkdirSync(atticDir, { recursive: true });
    renameSync(from, path.join(atticDir, name));
    return { attic: atticDir, failure: null };
  } catch (e) {
    return { attic: null, failure: (e as Error).message };
  }
}

/**
 * Забрать входящие и перенести ссылки в history. Подтверждения обработки и exactly-once
 * нет: mailbox гарантирует сохранность сообщения до чтения, и только это.
 *
 * Порядок — по имени файла: штамп времени плюс счётчик, поэтому сортировка строк равна
 * порядку отправки.
 */
export function readInbox(home: string, task: string, participant: string, fault: FaultHook = NO_FAULT): {
  messages: MessageV1[]; broken: BrokenNote[];
} {
  const dir = inboxDir(home, task, participant);
  const messages: MessageV1[] = [];
  const broken: BrokenNote[] = [];
  const names = inboxNames(dir);
  // Каталог history заводится здесь, а не при первой отправке: `rename` ссылки требует
  // готового родителя, и заводить его пустым у каждого участника незачем.
  if (names.length) ensureHistoryDir(home, task, participant);
  for (const name of names) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      // Унёс сосед между листингом и чтением — пропуск, а не отказ: сообщение забрал
      // второй читатель, он же его и доставит.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    let parsed: unknown = null;
    let code = '';
    let note = '';
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      code = 'schema-invalid';
      note = `не разобрано (${(e as Error).message})`;
    }
    if (!code) {
      const verdict = validate('message', parsed);
      if (!verdict.ok) {
        code = verdict.code as string;
        note = `не по схеме: ${verdict.at} ${verdict.note}`;
      }
    }
    if (code) {
      // Запись из будущего в `broken` не уезжает: она не испорчена, читать её нечем.
      const where = code === 'schema-version-unsupported'
        ? { attic: null, failure: null }
        : isolate(file, brokenInboxDir(home, task, participant), name);
      broken.push({ name, code, note, ...where });
      continue;
    }
    try {
      renameSync(file, historyRef(home, task, participant, (parsed as MessageV1).id));
    } catch (e) {
      // ENOENT здесь — тот же унёсший сосед. Отказ отсюда пришёл бы из СЕРЕДИНЫ обхода,
      // когда часть ссылок уже уехала в history, и вернуть их было бы некому.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      continue;
    }
    messages.push(parsed as MessageV1);
  }
  fault('read', { task, participant, taken: messages.length });
  return { messages, broken };
}

// history/<участник> заводится лениво, как и inbox: каталог появляется с первым чтением.
export function ensureHistoryDir(home: string, task: string, participant: string): void {
  mkdirSync(historyDir(home, task, participant), { recursive: true });
}

/** Запрос истории. `all` снимает лимит целиком; `before` — курсор постраничного чтения. */
export interface HistoryQuery {
  task?: string;
  participant?: string;
  limit?: number;
  /**
   * Курсор прошлой страницы: непрозрачная строка, которую вернул `cursor`. Собирать её
   * руками не нужно и не следует — форма ключа порядка принадлежит истории.
   */
  before?: string;
  all?: boolean;
}

/** Запись истории: одно сообщение у одного участника. */
export interface HistoryEntry {
  task: string;
  participant: string;
  message: MessageV1;
}

/** Ответ истории: страница от старых к новым и курсор на страницу старше. */
export interface HistoryPage {
  entries: HistoryEntry[];
  /** Что передать в `before` за следующей (более старой) страницей; `null` — старше нет. */
  cursor: string | null;
  broken: BrokenNote[];
}

/**
 * Ключ порядка: id сообщения, а при равенстве — участник. Одно сообщение лежит у многих, и
 * записей истории у него столько же, сколько получателей.
 *
 * **Курсор — этот ключ целиком, а не id сообщения** (замечание ревью). Лимит считает
 * ЗАПИСИ, поэтому граница страницы законно режет группу записей одного сообщения; курсор по
 * id отсекал следующую страницу всей группой сразу, и записи, оставшиеся левее среза, не
 * попадали ни в одну страницу вовсе.
 */
function orderKey(message: string, participant: string): string {
  return `${message} ${participant}`;
}

/**
 * Сравнение ключей порядка. Одно на сортировку и на отсечку курсора: два разных сравнения
 * на одних данных дают два разных порядка, и граница страницы перестаёт совпадать сама с
 * собой. `localeCompare` тут не годится вовсе — он зависит от локали, а ключ машинный.
 */
function byKey(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * История задачи: прочитанное, от старых к новым, по умолчанию последние 50 записей.
 *
 * Непрочитанного здесь нет вовсе, и это не пробел: непрочитанное лежит в mailbox'е, и
 * попади оно сюда — история перестала бы отличать доставленное от прочитанного, а на этом
 * различии стоит восстановление fan-out'а.
 */
export function history(home: string, tasks: string[], { participant, limit = 50, before, all = false }: HistoryQuery): HistoryPage {
  const refs: { key: string; task: string; participant: string; file: string }[] = [];
  for (const task of tasks) {
    const root = path.join(taskDir(home, task), 'history');
    let boxes: string[];
    try {
      boxes = readdirSync(root);
    } catch {
      continue;
    }
    for (const box of boxes) {
      if (participant && box !== participant) continue;
      for (const name of inboxNames(path.join(root, box))) {
        const id = name.slice(0, -'.json'.length);
        refs.push({ key: orderKey(id, box), task, participant: box, file: path.join(root, box, name) });
      }
    }
  }
  refs.sort((a, b) => byKey(a.key, b.key));
  // Курсор исключающий: страница отдаёт записи строго СТАРШЕ него, поэтому повторов на
  // границе страниц не бывает. Сравнение — то же самое, которым отсортированы записи.
  const older = before ? refs.filter((r) => byKey(r.key, before) < 0) : refs;
  const page = all ? older : older.slice(Math.max(0, older.length - Math.max(0, limit)));
  const entries: HistoryEntry[] = [];
  const broken: BrokenNote[] = [];
  for (const ref of page) {
    let message: unknown;
    try {
      message = JSON.parse(readFileSync(ref.file, 'utf8'));
    } catch (e) {
      broken.push({ name: path.basename(ref.file), code: 'schema-invalid', note: (e as Error).message, attic: null, failure: null });
      continue;
    }
    const verdict = validate('message', message);
    if (!verdict.ok) {
      broken.push({ name: path.basename(ref.file), code: verdict.code as string, note: `${verdict.at} ${verdict.note}`, attic: null, failure: null });
      continue;
    }
    entries.push({ task: ref.task, participant: ref.participant, message: message as MessageV1 });
  }
  const first = page[0];
  const hasOlder = Boolean(first) && older.length > page.length;
  return { entries, cursor: hasOlder ? (first as { key: string }).key : null, broken };
}

/** Что починило восстановление в одной задаче. */
export interface Repair {
  task: string;
  message: string;
  /** Кому дописаны ссылки. Пусто — intent просто не был снят. */
  recipients: string[];
  /** Пришлось ли связывать канон заново. */
  canonical: boolean;
}

/**
 * Восстановление fan-out'а одной задачи: пройти незакрытые intent'ы и дописать недостающее.
 *
 * Идемпотентно по построению: и канон, и каждая ссылка ставятся `link`'ом, а `EEXIST` здесь
 * значит «уже есть». Повторный вызов на здоровом store не делает ничего.
 */
export function recoverTask(home: string, task: string, meta: TaskV1, fault: FaultHook = NO_FAULT): {
  repairs: Repair[]; events: ActivationEvent[]; broken: BrokenNote[];
} {
  const repairs: Repair[] = [];
  const events: ActivationEvent[] = [];
  const broken: BrokenNote[] = [];
  let entries: string[];
  try {
    entries = readdirSync(intentsDir(home, task)).sort();
  } catch {
    return { repairs, events, broken };
  }
  const names = entries.filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  for (const name of names) {
    const file = path.join(intentsDir(home, task), name);
    // Гейт лизинга стоит ДО разбора записи: у живого соседа и оборванная запись законна —
    // `wx` создаёт файл атомарно, а содержимое пишется следом, и его половину видно.
    if (!abandonedIntent(file)) continue;
    let parsed: unknown = null;
    let code = '';
    let note = '';
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      code = 'schema-invalid';
      note = `intent не разобран (${(e as Error).message})`;
    }
    if (!code) {
      const verdict = validate('message', parsed);
      if (!verdict.ok) {
        code = verdict.code as string;
        note = `intent не по схеме: ${verdict.at} ${verdict.note}`;
      }
    }
    if (code) {
      // Оборванная запись intent'а — единственная форма порчи, которую даёт падение внутри
      // точки коммита: отправка при этом не вернулась, и сообщения для отправителя не было.
      const where = code === 'schema-version-unsupported'
        ? { attic: null, failure: null }
        : isolate(file, brokenMessagesDir(home, task), name);
      // Лизинг живёт ровно столько, сколько intent: уехал intent — уходит и он.
      if (where.attic) rmSync(ownerOfIntent(file), { force: true });
      broken.push({ name, code, note, ...where });
      continue;
    }
    const message = parsed as MessageV1;
    const hadCanonical = existsSync(messageFile(home, task, message.id));
    const fresh = completeFanout(home, task, message, fault);
    repairs.push({ task, message: message.id, recipients: fresh, canonical: !hadCanonical });
    for (const id of fresh) {
      const who = meta.participants.find((p) => p.id === id);
      // Получатель, которого в журнале уже нет, ссылку получает всё равно: она лежала бы
      // там и без падения. Будить его некого — события по нему нет.
      if (who) events.push(eventFor(home, task, who, [message]));
    }
  }
  sweepLeases(intentsDir(home, task), entries);
  return { repairs, events, broken };
}

/**
 * Убрать лизинги, которым нечего описывать. Осиротевший `<id>.owner` остаётся, когда fan-out
 * закрывает код прежних версий: он снимает intent, а про лизинг не знает. Мусор уходит молча
 * — обещания за ним нет никакого.
 *
 * Решение принимается по ОДНОМУ листингу, и атомарным он не бывает: `readdir` может отдать
 * `.owner` из непройденной позиции и не отдать `.json`, легший в уже пройденную, — тогда
 * смахнётся живой лизинг. Цена такой ошибки односторонняя: intent остаётся без лизинга, то
 * есть попадает в ветку «живость неизвестна — ждём порога». Восстановление от этого делается
 * осторожнее, а не смелее, и подобрать чужой идущий fan-out не может.
 */
function sweepLeases(dir: string, entries: string[]): void {
  const open = new Set(entries.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)));
  for (const name of entries) {
    if (!name.endsWith('.owner') || open.has(name.slice(0, -'.owner'.length))) continue;
    rmSync(path.join(dir, name), { force: true });
  }
}

export { messagesDir };

/**
 * Заглянуть в mailbox, ничего в нём не тронув. Отличие от `readInbox` одно и оно всё:
 * ссылки остаются в inbox'е, а не уезжают в history. Битое при этом откладывается так же —
 * иначе одна нечитаемая запись возвращалась бы читателю на каждом заходе.
 *
 * Зовёт это чужая сессия: ей `mailbox` отдаёт копию, а оригиналы остаются владельцу.
 */
export function peekInbox(home: string, task: string, participant: string): {
  messages: MessageV1[]; broken: BrokenNote[];
} {
  const dir = inboxDir(home, task, participant);
  const messages: MessageV1[] = [];
  const broken: BrokenNote[] = [];
  for (const name of inboxNames(dir)) {
    const file = path.join(dir, name);
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      // Унёс владелец между листингом и чтением: сообщение он и доставит.
      continue;
    }
    let parsed: unknown = null;
    let code = '';
    let note = '';
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      code = 'schema-invalid';
      note = `не разобрано (${(e as Error).message})`;
    }
    if (!code) {
      const verdict = validate('message', parsed);
      if (!verdict.ok) {
        code = verdict.code as string;
        note = `не по схеме: ${verdict.at} ${verdict.note}`;
      }
    }
    if (code) {
      // Запись из будущего в `broken` не уезжает: она не испорчена, читать её нечем.
      const where = code === 'schema-version-unsupported'
        ? { attic: null, failure: null }
        : isolate(file, brokenInboxDir(home, task, participant), name);
      broken.push({ name, code, note, ...where });
      continue;
    }
    messages.push(parsed as MessageV1);
  }
  return { messages, broken };
}

/**
 * Заглянуть в mailbox молча: ни ссылок не трогает, ни битого не откладывает. Нужен
 * надзирателю — его диагностика уходит в `stdio: 'ignore'`, и отложенное исчезло бы без
 * слова кому-либо.
 */
export function glanceInbox(home: string, task: string, participant: string): MessageV1[] {
  const dir = inboxDir(home, task, participant);
  const messages: MessageV1[] = [];
  for (const name of inboxNames(dir)) {
    try {
      messages.push(JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as MessageV1);
    } catch {
      // Битое или унесённое соседом — не наша беда: mailbox забирает читатель, он и доложит.
    }
  }
  return messages;
}

/**
 * Когда участник в последний раз ОТПРАВЛЯЛ на шину; `null` — не отправлял ещё ничего.
 *
 * Имя записи отправителя не несёт (штамп, счётчик и случайный хвост), поэтому ответа без
 * чтения содержимого нет. Спрашивают это на каждом ударе сердца по каждому вставшему, а
 * переписки набегает порядка трёх мегабайт в день, — поэтому разбор идёт **инкрементально**:
 * каждая запись читается ровно один раз за жизнь процесса, а очередной вызов трогает только
 * имена, которых он ещё не видел. Кэш по состоянию каталога здесь не годился: любая отправка
 * меняет его, и обход становился полным заново.
 *
 * Канон неизменяем и исчезает только вместе с задачей, поэтому увиденное не протухает.
 */
const sentSeen = new Map<string, { seen: Set<string>; last: Map<string, number> }>();

export function lastSentAt(home: string, task: string, participant: string): number | null {
  const dir = messagesDir(home, task);
  let hit = sentSeen.get(dir);
  if (!hit) {
    hit = { seen: new Set<string>(), last: new Map<string, number>() };
    sentSeen.set(dir, hit);
  }
  // Каталоги заводятся лениво: нет каталога — `inboxNames` отдаёт пустой список.
  for (const name of inboxNames(dir)) {
    if (hit.seen.has(name)) continue;
    hit.seen.add(name);
    try {
      const m = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as MessageV1;
      const at = Date.parse(m.ts);
      if (!Number.isFinite(at)) continue;
      if (!hit.last.has(m.sender) || (hit.last.get(m.sender) as number) < at) hit.last.set(m.sender, at);
    } catch {
      // Битое сообщение своего отправителя не называет — обход идёт дальше.
    }
  }
  return hit.last.get(participant) ?? null;
}

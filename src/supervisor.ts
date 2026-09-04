// Машина состояний надзирателя: круги, пороги перестука, health непрочитанного,
// эскалация молчания и решение «кого активировать».
//
// Что здесь есть и чего здесь нет. Здесь — РЕШЕНИЯ: кому лежит непрочитанное, пора ли
// стучать, какие сообщения показать, кто встал и о ком уже доложено. Здесь нет ни канала
// доставки, ни текста: канал даёт driver через `activate`, текст рендерит он же — рамка и
// слова принадлежат каналу harness'а, а не шине. Отсюда же нет и процесса: отвязанный
// launcher, наблюдатели `fs.watch` и цикл живут у потребителя, потому что смерть процесса
// по построению ничего не стоит — состояние целиком лежит в store задачи.
//
// Интервалы ниже — измеренные, а не выбранные. Меняя их, меняешь поведение живого run'а:
// каждый назван вместе с тем, чем он отмерен.
import {
  beatWarden, lastTurnAt, logWarden, readHealth, readStalls, readWake, writeHealth, writeStalls,
} from './sidecar.js';
import type { Stalls, Wake } from './sidecar.js';
import { addressOf, dismissedOf, foreignSessionOf, repoAbsOf, sessionIdOf, sessionOf, startedOf } from './protocol.js';
import { readArtifact } from './v1/artifacts.js';
import { countInbox, glanceInbox, lastSentAt } from './v1/messages.js';
import type { MessageV1, ParticipantV1, TaskV1 } from './v1/model.js';
import { readTask } from './v1/store.js';
import { driverFor, harnessOf, pushes, sessionRefOf } from './driver.js';
import type {
  ActivateResult, ActivationTarget, Driver, Notification, NotificationMessage, Registry,
  SessionSnapshot, SessionStall, SessionView, StalledParticipant,
} from './driver.js';
// Опрос mailbox'ов — подстраховка `fs.watch`, который события теряет.
export const TICK_MS = 1000;

// Перестук: mailbox всё ещё не забран — стучимся снова. Две минуты отмерены ходу
// участника, а не сети: занятая длинным ходом сессия законно молчит минуты.
export const KNOCK_RETRY_SEC = 120;

// Порог молчания: дольше него непрочитанное лежать не должно — участник либо встал,
// либо не получает notification вовсе. Пятнадцать минут — «не отвечает», а не «думает»:
// mailbox забирается ПЕРЕД разбором, не после.
export const SILENCE_SEC = 900;

// Потолок жизни процесса — стережёт забытый run, чья задача осталась открытой на ночь.
export const WARDEN_TOTAL_SEC = 6 * 3600;

// Сколько отказов круга подряд процесс терпит, прежде чем выйти. Один отказ — транзиент
// (лок задачи занят соседним spawn'ом, файл переписывается под рукой); три подряд — нет.
export const ROUND_FAIL_LIMIT = 3;

// Окно регистрации свежеподнятой сессии: подъём пишет участника в журнал РАНЬШЕ, чем
// сессия появляется у harness'а со своим процессом, и отсутствие процесса в этом зазоре
// означает не смерть, а незаконченный старт.
export const SPAWN_GRACE_SEC = 30;

/** Отметка health одного адреса. Поля дописываются кругом, читаются им же и `promptobus status`. */
interface HealthMark {
  unread?: number;
  since?: string | null;
  knockedAt?: string | null;
  triedAt?: string | null;
  deliveredAt?: string | null;
  knocks?: number;
  knockedTo?: string | null;
  escalatedAt?: string | null;
  channel?: string | null;
  knockError?: string | null;
  wake?: string | null;
  [key: string]: unknown;
}

function marksOf(health: Record<string, unknown>, addr: string): HealthMark {
  const v = health[addr];
  return (v && typeof v === 'object' ? v : {}) as HealthMark;
}

// Окно СИММЕТРИЧНО: время подъёма пишется по часам той машины, и сдвинутые назад часы
// делали бы свежую запись «из будущего» с отрицательным возрастом.
export function justSpawned(participant: ParticipantV1 | null | undefined, now: number = Date.now()): boolean {
  const at = Date.parse(String(startedOf(participant) ?? ''));
  return Number.isFinite(at) && Math.abs(now - at) < SPAWN_GRACE_SEC * 1000;
}

// Когда участнику в последний раз НАЧАЛИ ход. Отметок три, и все три означают одно —
// участника достали: подъём (`started` в журнале задачи), удавшаяся активация (`knockedAt`)
// и забранный им mailbox (`deliveredAt`). Попытка активации (`triedAt`) в счёт не идёт
// намеренно: неудавшаяся активация хода не начала, и молчание после неё говорит о глухом
// канале, а не о стопе — про это у шины свои слова.
function lastActivation(home: string, task: string, participant: ParticipantV1 | null | undefined): number | null {
  const marks = marksOf(readHealth(home, task), String(addressOf(participant) ?? ''));
  const at = [startedOf(participant), marks.knockedAt, marks.deliveredAt]
    .map((v) => Date.parse(String(v ?? ''))).filter(Number.isFinite);
  return at.length ? Math.max(...at) : null;
}

/** Что снимок знает про сессию участника. Нет ref — сессии за адресом нет вовсе. */
function viewOf(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): SessionView | null {
  if (sessions === null) return null;
  if (!sessionRefOf(participant)) return null;
  // Ref есть, а записи в снимке нет: участник появился после снимка либо сессии не стало.
  return sessions[String(addressOf(participant) ?? '')] ?? { state: 'gone', busy: false, stall: null, id: null };
}

/**
 * Состояние сессии участника: `alive` | `dead` | `unknown`. Неразобранный снимок, запись без
 * session reference и участник, спросить о котором некого, — неизвестность, а не смерть.
 */
export function liveParticipant(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): 'alive' | 'dead' | 'unknown' {
  if (!sessionRefOf(participant)) return 'unknown';
  const view = viewOf(participant, sessions);
  if (!view || view.state === 'unknown') return 'unknown';
  // Вопрос один: достучимся ли. Запись, пережившая свой процесс, недостижима ровно как
  // отсутствующая; различает их `promptobus status`, которому причина нужна для человека.
  return view.state === 'alive' ? 'alive' : 'dead';
}

/**
 * Стоп ли это на самом деле. Пока на шине было ожидание, участник между
 * сообщениями сидел внутри вызова инструмента и для harness'а был занят; когда
 * ожидание сняли, он, отправив сообщение, ход
 * заканчивает, и harness метит его сессию стоящей со строкой вроде «result sent; awaiting
 * next cycle». Для разбора стопа это исход `unknown`, и доклад уходил на каждый штатный
 * конец хода.
 *
 * Стопом остаётся МОЛЧАЛИВЫЙ конец хода: участник закончил ход, не отправив на шину ничего
 * после своей последней активации. `permission` и `limit` этой проверке не подлежат вовсе —
 * их снимает человек или время, а не сообщение на шине.
 *
 * Предикат один на троих: доклад надзирателя, печать `promptobus status` и строки о вставших в
 * ответе `mailbox`. Разъехавшись, они стали бы разными ответами об одном состоянии.
 *
 * Задача и её store — обязательные аргументы, и молчаливого умолчания у них нет намеренно:
 * «нет home — считаем стопом» и есть тот механизм расхождения, ради закрытия которого
 * предикат сведён в одну функцию.
 */
export function stallStands(home: string, task: string, participant: ParticipantV1 | null | undefined, stall: SessionStall | null | undefined): boolean {
  if (!home || !task) throw new Error('stallStands: нужны home и task — предикат читает store задачи');
  if (!stall) return false;
  if (stall.kind !== 'unknown') return true;
  const since = lastActivation(home, task, participant);
  if (since === null) return true;
  let sent: number | null;
  try {
    sent = lastSentAt(home, task, String(participant?.id ?? ''));
  } catch {
    // Негодная запись участника не имеет права снимать доклад о его стопе.
    return true;
  }
  // Участник ещё НИ РАЗУ не выходил на шину, а его сессия уже показывает отданный ход — это
  // незаконченный старт, а не стоп. Окно открылось вместе с новым входом в разбор:
  // пока им служило состояние `blocked`, свежая сессия в него не попадала вовсе, а `idle` она
  // показывает между `--bg` и первым своим ходом — доклад ушёл бы с причиной буквально `idle`,
  // потому что `state.json` к этому моменту ещё не написан.
  //
  // **Окно стоит внутри предиката, а не в `blockedParticipants` рядом с соседними
  // `justSpawned`, потому что печать `promptobus status` зовёт предикат напрямую, минуя разбор
  // участников** (`lib/status.js`) — положенное туда, оно оставило бы
  // её без защиты и развело каналы, ровно против того, ради чего предикат сводил.
  //
  // **И только эта ветка: у заговорившего хоть раз участника timeline настоящий, и молчание
  // после активации — стоп независимо от возраста записи**; окно на всю ветку `unknown` дало
  // бы полминуты глухоты всем сразу.
  if (sent === null) return !justSpawned(participant);
  return sent < since;
}

/**
 * Contact point адреса держит ЧУЖАЯ сессия — или `null`, если держит своя либо сверить
 * нечем.
 *
 * Так бывает не от злого умысла: Stop-хук берёт идентичность из аргументов своей команды, а
 * когда её там нет — из окружения сессии, и окружение фоновой сессии harness выдаёт не то,
 * с которым её поднимали. Замер 2026-09-03: фоновые сессии harness'а — заранее
 * заведённые spare демона, и тройка `PROMPTOBUS_*` достаётся им от процесса, поднявшего
 * демон, то есть от ПЕРВОГО spawn'а run'а. Второй участник задачи тогда сдаёт contact point
 * за адрес первого, и надзиратель, ничего не проверяя, будит по нему чужую сессию: за десять
 * минут того run'а одиннадцать notification'ов ушли не туда.
 *
 * Отсюда правило: стучать в такой contact point нельзя. Он не мёртв — он ведёт к другой
 * сессии, и стук по нему начинает ЧУЖОЙ ход, а адресат остаётся глухим. Само собой это
 * чинится первым же концом хода настоящего владельца: его хук перепишет запись своей.
 *
 * Обе стороны обязаны быть названы: запись участника без id сессии (подъём не разобрал его
 * из вывода `--bg`) и contact point прежнего CLI без поля `session` — это неизвестность, а
 * не чужая сессия, и обвинять по ней нельзя.
 */
export function wakeTakenBy(home: string, task: string, p: ParticipantV1 | null | undefined, endpoint?: Wake | null): string | null {
  const addr = addressOf(p);
  if (!addr) return null;
  // Запись читается вызывающим, когда она у него уже есть: круг присмотра читает contact
  // point каждого участника каждую секунду, и второе чтение того же файла — лишний syscall
  // на участника в секунду (замечание ревью). Аргумента нет — читаем сами: доклад о стопах
  // идёт мимо круга.
  const wake = endpoint === undefined ? readWake(home, task, addr) : endpoint;
  const held = wake?.session ?? null;
  // Отдаётся ЗАХВАТЧИК — сессия из contact point'а, а не та, за которой адрес закреплён: её
  // и называет строка причины, ею же человек опознаёт вторую сессию. Правило сверки при этом
  // общее (`foreignSessionOf`), и второй копии у него нет.
  return held && foreignSessionOf(p, held) ? held : null;
}

/** Сессия, за которой адрес закреплён в журнале, — как её называть человеку. */
function heldBy(p: ParticipantV1 | null | undefined): string {
  return sessionIdOf(p) ?? sessionOf(p) ?? 'никем';
}

/**
 * Занята ли сессия участника ходом. Ветки две, потому что участники двух родов,
 * и одной ветки на обоих не хватает.
 *
 * **Есть session reference** — берём занятость из снимка: её объявил driver.
 *
 * **Reference'а нет** — так живёт owner задачи: его сессия не поднята driver'ом, записи о
 * ней у harness'а нет вовсе. Занятость тогда берётся от сторожа цикла: он зовётся на КАЖДОМ
 * завершении хода и кладёт отметку (`markTurn`). Активация новее отметки — значит с тех пор
 * сессия ход начала и ещё не отдала. Признак накопительный, а не мгновенный: «побывала ли
 * свободной с прошлой активации», а не «свободна ли сию секунду».
 *
 * Ни один источник не контракт: снимка нет, записи нет, отметки сторожа не было ни разу —
 * это НЕИЗВЕСТНОСТЬ, а не занятость, и вызывающий делает то же, что делал бы без предиката.
 */
export function sessionBusy(home: string, task: string, participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): boolean {
  // Ветка выбирается РОДОМ участника, а не тем, нашлась ли его сессия в снимке: снимок
  // отдаёт пустоту и на неразобранном состоянии, и на исчезнувшей записи, и по этой пустоте
  // участник с сессией уезжал бы в ветку сторожа — где отметки конца хода у него может не
  // быть вовсе, а активация её заведомо новее: перестук глох бы там, где состояние неизвестно.
  if (sessionRefOf(participant)) {
    const view = viewOf(participant, sessions);
    return view ? view.busy === true : false;
  }
  const turn = lastTurnAt(home, task, String(addressOf(participant) ?? ''));
  if (turn === null) return false;
  const since = lastActivation(home, task, participant);
  return since !== null && since > turn;
}

/**
 * Участники задачи, от которых сообщений ждать нечего: сессия стоит на запросе или запись
 * пережила свой процесс. `null` — состояние неизвестно: это не «все живы».
 *
 * «Числится, но процесса нет» проверяется РАНЬШЕ стопа: у пережившей свой процесс записи
 * тоже стоит признак стопа, и маршрут получался бы «разбуди сообщением» — а будить некого.
 */
export function blockedParticipants(home: string, task: string, participants: ParticipantV1[] | null | undefined, sessions: SessionSnapshot): StalledParticipant[] | null {
  // Store задачи спрашивается на входе, а не при первом стопе: внутри `stallStands` до
  // отказа доходят только реально вставшие, и вызов с забытым store молчал бы, пока никто
  // не встал, а отказывал бы посреди круга надзирателя или ответа `mailbox`.
  if (!home || !task) throw new Error('blockedParticipants: нужны home и task — разбор стопа читает store задачи');
  if (sessions === null) return null;
  const stalled: StalledParticipant[] = [];
  // Harness записи едет в доклад вместе с ней: МАРШРУТ по стопу спрашивают у того
  // же driver'а, который состояние и разобрал, а `registry` этой функции не подают — она
  // читает готовый снимок. Registry здесь не заводится намеренно: снимок собран раньше, и
  // второй источник правды о harness'е разошёлся бы с ним молча.
  const harnessOfRecord = (p: ParticipantV1) => (
    typeof p.harness === 'string' && p.harness.trim() ? p.harness.trim() : null);
  for (const p of participants ?? []) {
    const ref = sessionRefOf(p);
    if (!ref) continue;
    // Снятый с наблюдения участник в доклад не идёт вовсе. Снимается наблюдение целиком,
    // а не только исход `gone`: фильтр по исходу поставил бы молчание в зависимость от
    // гонки двух команд оркестратора. Новая запись подъёма кладётся без отметки.
    if (dismissedOf(p)) continue;
    const view = viewOf(p, sessions)!;
    // Спросить о нём некого — driver'а по его harness'у нет либо тот не смотрит. Молчим:
    // выдуманный доклад «ИСЧЕЗ» позвал бы поднимать заново работающую сессию.
    if (view.state === 'unknown') continue;
    const repoAbs = repoAbsOf(p);
    // Записи нет вовсе — тоже доклад: остановленный человеком участник и сорвавшийся
    // подъём иначе были бы невидимы. Своё состояние, а не `stale`: сессии нет ни следа.
    // Окно регистрации накрывает и эту ветку: только что поднятой сессии в списке нет ВООБЩЕ.
    if (view.state === 'gone') {
      if (justSpawned(p)) continue;
      stalled.push({
        address: String(addressOf(p)),
        ref,
        // Последний известный id из журнала: сессии за ним нет, но её каталог живёт дольше.
        id: sessionOf(p),
        repoAbs,
        harness: harnessOfRecord(p),
        kind: 'gone',
        // Слова про исчезнувшую запись — у driver'а: он один знает, где её не стало и как
        // это называется у его harness'а. Не сказал — говорим нейтрально, а не выдумываем.
        reason: view.stall?.reason ?? "записи сессии у harness'а нет",
      });
      continue;
    }
    if (view.state === 'stale') {
      // Свежая запись — не призрак: молчим целиком, отметка «доложено» тоже не ложится.
      if (justSpawned(p)) continue;
      stalled.push({
        address: String(addressOf(p)),
        ref,
        id: view.id,
        // Каталог клона нужен маршруту: reviewer поднимается по нему, а не подъёмом worker'а.
        repoAbs,
        harness: harnessOfRecord(p),
        kind: 'stale',
        // Причина говорит только новое: «числится, но процесса нет» скажет вызывающий.
        reason: view.stall?.reason ?? 'запись пережила свой процесс',
      });
      continue;
    }
    // Штатный конец хода — не стоп, и решает это store задачи, а не снимок: home и task
    // нужны ровно для него (`stallStands`).
    if (stallStands(home, task, p, view.stall)) {
      stalled.push({
        address: String(addressOf(p)),
        ref,
        id: view.id,
        repoAbs,
        harness: harnessOfRecord(p),
        kind: view.stall!.kind,
        reason: view.stall!.reason,
      });
      continue;
    }
    // Сессия работает, а достучаться до неё нечем: contact point её адреса держит другая
    // (`wakeTakenBy`). Для owner'а это тот же класс, что стоп, — сообщений от
    // такого участника не будет, и mailbox об этом не скажет, — поэтому доклад идёт тем же
    // каналом. Проверяется ПОСЛЕДНИМ: у мёртвой записи беда крупнее, и называть её чужим
    // contact point'ом значило бы увести человека не туда.
    // Окно регистрации — то же, что у соседних веток: при повторном подъёме запись
    // участника несёт новый id сессии, а `wake/<адрес>.json` остаётся от прежней, и до
    // рукопожатия нового сервера шины (`onJoin` перепишет её) свежеподнятый участник
    // выглядел бы глухим. Отказ от стука в круге присмотра окном не накрывается намеренно:
    // стучать в чужой сокет нельзя и в эти тридцать секунд, а вот докладывать о них — рано.
    const taken = justSpawned(p) ? null : wakeTakenBy(home, task, p);
    if (taken) {
      stalled.push({
        address: String(addressOf(p)),
        ref,
        id: view.id,
        repoAbs,
        harness: harnessOfRecord(p),
        kind: 'wake-taken',
        reason: `contact point держит сессия ${taken}, а адрес закреплён за ${heldBy(p)}`,
      });
    }
  }
  return stalled;
}

// Отметка доложенных стопов живёт в store задачи (`readStalls`/`writeStalls`): без неё
// доклад повторялся бы каждый круг, сжигая ход за ходом у адресата.

/**
 * Что нового среди стопов, БЕЗ отметки. Отметку ставит вызывающий (`commitStalls`).
 * `retryMs` — срок, после которого отмеченный стоп снова свежий; `maxTries` — потолок
 * попыток на одну причину, ноль (умолчание) — повтора нет вовсе.
 * `current === null` — состояние сессий не разобрано: это не «стопов нет».
 */
export function pendingStalls(home: string, task: string, probe: (ps: ParticipantV1[] | undefined) => StalledParticipant[] | null, { now = Date.now(), retryMs = 0, maxTries = 1 } = {}): {
  fresh: StalledParticipant[]; current: Stalls | null;
} {
  const stalled = probe(readTask(home, task).participants);
  if (stalled === null) return { fresh: [], current: null };
  const reported = readStalls(home, task);
  const current: Stalls = {};
  const fresh: StalledParticipant[] = [];
  for (const s of stalled) {
    const reason = `${s.ref}|${s.reason}`;
    const was = reported[s.address];
    const same = was?.reason === reason;
    const at = Date.parse(was?.at ?? '');
    const tries = Number(was?.tries) || 0;
    const again = retryMs > 0 && tries < maxTries && Number.isFinite(at) && now - at >= retryMs;
    if (same && !again) {
      current[s.address] = was!;
      continue;
    }
    fresh.push(s);
    current[s.address] = { reason, at: new Date(now).toISOString(), tries: same ? tries + 1 : 1 };
  }
  return { fresh, current };
}

/** Отметить доложенное. Состояние уже такое — журнал не трогаем: запись стоила бы диска. */
export function commitStalls(home: string, task: string, current: Stalls | null): void {
  if (current === null) return;
  if (JSON.stringify(readStalls(home, task)) === JSON.stringify(current)) return;
  writeStalls(home, task, current);
}

/**
 * Кого надзирателю ещё есть смысл стеречь. Считаем только участников с session reference:
 * их состояние наблюдаемо, а сессия человека за адресом owner'а не наблюдаема ниоткуда —
 * считай его живым, и выход «живых не осталось» стал бы недостижим.
 * Неизвестность в мёртвые не берётся: неразобранный снимок оставляет живыми всех — иначе
 * выход по недоступности внешней команды. Оттуда же окно регистрации (`justSpawned`):
 * только что поднятой сессии в снимке нет вообще.
 */
export function liveWatched(home: string, task: string, sessions: SessionSnapshot): string[] {
  let meta;
  try {
    meta = readTask(home, task);
  } catch {
    return [];
  }
  if (meta.status !== 'active') return [];
  const named = (meta.participants ?? []).filter((p) => addressOf(p) && sessionRefOf(p));
  if (!named.length) return [];
  return named
    .filter((p) => justSpawned(p) || liveParticipant(p, sessions) !== 'dead')
    .map((p) => String(addressOf(p)));
}

// Лежит ли в задаче непрочитанное — по любому её адресу.
function unreadLeft(home: string, task: string): boolean {
  let meta;
  try {
    meta = readTask(home, task);
  } catch {
    return false;
  }
  return (meta.participants ?? []).some((p) => {
    if (!p?.id) return false;
    try {
      return countInbox(home, task, p.id) > 0;
    } catch {
      return false;
    }
  });
}

/**
 * Удар сердца: продлить свою отметку и проверить три причины выйти. Вынесено от цикла ради
 * теста: проверка ветки внутри цикла стоила бы набору получаса ожидания.
 */
export function beatRound(home: string, task: string, startedMs: number, { now = Date.now(), sessions = null as SessionSnapshot, session = null as string | null } = {}): string | null {
  // Отметку перехватил преемник — стеречь вдвоём нельзя, работу продолжает он. Идентичность
  // сессии идёт локу: чей процесс держит журнал, знает окружение, а его читает adapter.
  if (!beatWarden(home, task, { session })) return 'место надзирателя занял другой процесс';
  // Непрочитанное держит процесс даже при пустом списке живых: mailbox мог быть не забран.
  if (!liveWatched(home, task, sessions).length && !unreadLeft(home, task)) {
    return 'живых участников не осталось';
  }
  if (now - startedMs >= WARDEN_TOTAL_SEC * 1000) {
    return `просидел общий потолок ${Math.round(WARDEN_TOTAL_SEC / 3600)} ч`;
  }
  return null;
}

/**
 * Выжимка сообщения для notification: driver собирает из неё свой текст.
 *
 * Отправитель называется АДРЕСОМ, а артефакт — именем файла: postcard читает человек, и id
 * записи участника (`worker-api`) или id metadata артефакта в нём были бы машинным хвостом
 * вместо имени. Оба перевода делаются здесь и по журналу задачи: сообщение несёт id, а имя
 * лежит в записи.
 */
function previewOf(home: string, meta: TaskV1, m: MessageV1): NotificationMessage {
  const sender = meta.participants.find((p) => p.id === m.sender);
  let artifact: string | null = null;
  if (m.artifact) {
    try {
      artifact = readArtifact(home, m.task, m.artifact).filename;
    } catch {
      // Metadata артефакта не прочиталась — счётчик в postcard'е важнее имени файла.
      artifact = m.artifact;
    }
  }
  return {
    id: typeof m?.id === 'string' ? m.id : null,
    type: String(m?.type ?? ''),
    from: addressOf(sender) ?? String(m?.sender ?? ''),
    ts: String(m?.ts ?? ''),
    body: typeof m?.body === 'string' ? m.body : '',
    artifact,
  };
}

/**
 * Один круг присмотра: посмотреть все mailbox'ы задачи, разбудить тех, у кого лежит
 * непрочитанное, обновить health. Активация идёт через driver участника, взятый из
 * registry по его harness. `sessions` — снимок с последнего удара сердца: круг идёт раз в
 * секунду, и своего опроса ему не положено. `null` — состояния сессий нет, и это
 * неизвестность.
 */
export async function supervisorRound(home: string, task: string, { now = Date.now(), registry, sessions = null as SessionSnapshot }: {
  now?: number; registry: Registry; sessions?: SessionSnapshot;
}): Promise<{ stop: string | null; events: string[] }> {
  let meta;
  try {
    meta = readTask(home, task);
  } catch (e) {
    return { stop: `журнал задачи не читается: ${(e as Error).message}`, events: [] };
  }
  if (meta.status !== 'active') return { stop: 'задача закрыта', events: [] };

  const health = readHealth(home, task);
  const events: string[] = [];
  let changed = false;

  for (const p of meta.participants ?? []) {
    const addr = addressOf(p);
    if (!addr) continue;
    let unread: number;
    try {
      unread = countInbox(home, task, p.id);
    } catch {
      // Негодная запись участника не имеет права останавливать присмотр за остальными.
      continue;
    }
    const was = marksOf(health, addr);
    const h: HealthMark = { ...was };

    if (!unread) {
      // Mailbox забрали — это и есть подтверждение доставки; всегда пустой не пишется.
      if (was.unread) {
        events.push(`доставлено ${addr}: mailbox забран (лежало ${was.unread}, стуков ${was.knocks ?? 0})`);
        health[addr] = {
          ...was,
          unread: 0,
          deliveredAt: new Date(now).toISOString(),
          since: null,
          knockedAt: null,
          triedAt: null,
          knocks: 0,
          escalatedAt: null,
        };
        changed = true;
      }
      continue;
    }

    // `since` — когда mailbox перестал быть пустым: по нему считается молчание, и новое
    // сообщение поверх старого его не сбрасывает — иначе молчания не увидеть никогда.
    if (!was.unread) {
      h.since = new Date(now).toISOString();
      h.knocks = 0;
      h.knockedAt = null;
      h.triedAt = null;
      h.escalatedAt = null;
    }
    h.unread = unread;

    // Driver участника берётся из registry по его harness — и отказ одного участника не
    // имеет права уносить присмотр за остальными: неизвестный harness остаётся в журнале
    // строкой, а круг идёт дальше.
    let driver;
    try {
      driver = driverFor(registry, harnessOf(p, registry));
    } catch (e) {
      if (h.channel !== 'no-driver' || h.knockError !== (e as Error).message) {
        events.push(`будить нечем ${addr}: ${(e as Error).message}`);
      }
      h.channel = 'no-driver';
      h.knockError = (e as Error).message;
      if (JSON.stringify(h) !== JSON.stringify(was)) changed = true;
      health[addr] = h;
      continue;
    }

    const endpoint = readWake(home, task, addr);
    // Чей это contact point на самом деле: спрашивается до порогов перестука —
    // перехваченный канал не «ещё не время», а «стучать некуда».
    const taken = wakeTakenBy(home, task, p, endpoint);
    // Отпечаток contact point'а: адрес канала и время сдачи. Переписал участник свой
    // contact point — сессия перезапустилась, канал сменился — активируем НЕМЕДЛЕННО, не
    // досиживая порог перестука: прежний адрес мёртв по построению.
    const print = endpoint?.socket ? `${endpoint.socket}#${endpoint.at ?? ''}` : null;
    const moved = print !== null && was.wake !== undefined && print !== was.wake;

    // Порог перестука считается по ВРЕМЕНИ ПОПЫТКИ, а не успеха: иначе неотвечающий канал
    // получал бы попытку каждую секунду. `knockedAt` остаётся временем последней УДАВШЕЙСЯ
    // доставки: его читает разбор «когда дозвонились».
    const triedAt = Date.parse(h.triedAt ?? '');
    const grew = unread > (was.unread ?? 0);
    const stale = Number.isFinite(triedAt) && now - triedAt >= KNOCK_RETRY_SEC * 1000;
    // Перестук по ТОМУ ЖЕ непрочитанному ждёт, пока сессия отдаст ход: занятая сессия
    // notification увидит только в конце хода, а ход ей и так вернёт сторож цикла с
    // непрочитанным. Первого стука по новому сообщению это не касается: его сессия ещё не
    // видела. У owner'а задачи сессии в снимке нет, и занятость там берётся от сторожа
    // цикла — обе ветки в `sessionBusy`.
    const since = Date.parse(h.since ?? '');
    const waited = Number.isFinite(since) ? now - since : 0;
    // Граница накопительного признака: гейт держится не дольше порога молчания. Удавшаяся
    // активация доставку не подтверждает, и отброшенная пределами очереди получателя — тот
    // самый случай, ради которого redelivery и заведён — сессию не разбудила: хода она не
    // начинала и не кончит, отметка сторожа не двинется, и занятость осталась бы истиной
    // навсегда. Лежит дольше порога — стучим, невзирая на занятость.
    const busy = stale && waited < SILENCE_SEC * 1000 && sessionBusy(home, task, p, sessions);
    if (!pushes(driver)) {
      // Pull-driver сессию не будит вовсе — он организует свой polling, а core только
      // показывает его capability и непрочитанное. Health при этом ведётся как у всех:
      // молчание такого участника видно тем же порогом.
      if (h.channel !== 'pull') {
        h.channel = 'pull';
        h.wake = null;
      }
    } else if (!endpoint?.socket) {
      // Contact point'а нет — стучать нечем, и порогом это не придерживается: сдать канал
      // участник может уже после того, как сообщение легло.
      if (h.channel !== 'self-wake') {
        h.channel = 'self-wake';
        h.wake = null;
        events.push(`откат на self-wake ${addr}: contact point'а нет — участник не сдал сокет`);
      }
    } else if (taken) {
      // Contact point держит другая сессия (`wakeTakenBy` выше). Стучать в него нельзя: он
      // не мёртв, он ведёт в ЧУЖУЮ сессию — стук начал бы ей ход, а адресат остался бы
      // глухим. Ждать нечего и делать нечего: настоящий владелец перепишет запись своей на
      // первом же своём конце хода. Один раз на причину: перехваченный contact point живёт
      // минутами, а круг идёт раз в секунду.
      const why = `contact point держит сессия ${taken}, а адрес закреплён за ${heldBy(p)}`;
      if (h.channel !== 'self-wake' || h.knockError !== why) {
        events.push(`откат на self-wake ${addr}: ${why} — стук ушёл бы в чужую сессию`);
      }
      h.channel = 'self-wake';
      h.knockError = why;
      h.wake = null;
    } else if (!Number.isFinite(triedAt) || grew || moved || (stale && !busy)) {
      h.triedAt = new Date(now).toISOString();
      h.wake = print;
      // Mailbox читается ровно здесь, а не каждый круг. `glanceInbox`, а не `peekInbox`:
      // битое надзиратель не разбирает и в сторону не откладывает.
      const box = glanceInbox(home, task, p.id);
      // Повтор несёт только пришедшее после прошлого стука: прежде он перечислял весь
      // ящик заново, до шести сообщений в одном postcard'е. Сколько лежит всего, говорит
      // счётчик в шапке. Полный список идёт там, где прошлого стука сессия не видела:
      // его не было вовсе либо участник переписал contact point, то есть перезапустился.
      // Отсечка — по id сообщения, а не по времени: имена в mailbox'е сортируются
      // порядком отправки (`readInbox`), и вторых часов для этого не нужно.
      const upTo = moved ? null : was.knockedTo ?? null;
      const msgs = upTo === null ? box : box.filter((m) => String(m?.id ?? '') > upTo);
      const r = await activate(driver, { ref: sessionRefOf(p), endpoint }, {
        kind: 'unread', task, address: addr, unread, messages: msgs.map((m) => previewOf(home, meta, m)),
      });
      if (r?.ok) {
        // Канал — объявление driver'а, не провод contact point'а. Поле `wake.socket` есть
        // и у inject/rpc: там это путь реестра или держателя, а не messaging-сокет.
        // Литерал `socket` называл человеку не тот транспорт.
        h.channel = driver.options?.knockChannel ?? 'socket';
        h.knockError = null;
        h.knockedAt = h.triedAt;
        h.knocks = (h.knocks ?? 0) + 1;
        // Докуда отстучали: не только показанное, но и уехавшее в хвост «и ещё N» —
        // о нём postcard сказал, и повторять его во второй раз незачем.
        if (box.length) h.knockedTo = box[box.length - 1]?.id ?? h.knockedTo ?? null;
        events.push(`notification ${addr}: непрочитанных ${unread}, стук ${h.knocks}`
          + `${moved ? ' (contact point переписан)' : ''}`);
      } else {
        // Один раз на причину: мёртвый канал отдаёт ту же ошибку каждые две минуты.
        // Фраза называет канал driver'а: литерал «сокет» уводил разбор к транспорту,
        // которого у inject/rpc нет. `socket` печатается словом «сокет» — так строку
        // давно читают у harness'а с каналом `socket`.
        const why = r?.error ?? 'неизвестно';
        const channel = driver.options?.knockChannel ?? 'socket';
        const label = channel === 'socket' ? 'сокет' : channel;
        if (h.channel !== 'self-wake' || h.knockError !== why) {
          events.push(`откат на self-wake ${addr}: ${label} не принял notification (${why})`);
        }
        h.channel = 'self-wake';
        h.knockError = why;
      }
      // Записи здесь нет: её решает сравнение состояний ниже.
    }

    // Молчание дольше порога — эскалация, и однократная: иначе журнал зальёт один факт.
    if (Number.isFinite(since) && waited >= SILENCE_SEC * 1000 && !h.escalatedAt) {
      h.escalatedAt = new Date(now).toISOString();
      events.push(`МОЛЧИТ ${addr}: mailbox не забран ${Math.round(waited / 60000)} мин, `
        + `непрочитанных ${unread}, канал ${h.channel ?? 'нет'}`);
      changed = true;
    }

    if (JSON.stringify(h) !== JSON.stringify(was)) changed = true;
    health[addr] = h;
  }

  if (changed) writeHealth(home, task, health);
  for (const line of events) logWarden(home, task, line);
  return { stop: null, events };
}

// Активация одного участника. Отказ driver'а — исход, а не исключение: доставка остальным
// обязана идти дальше, и брошенное им наружу уносило бы круг целиком вместе с health
// остальных адресов.
async function activate(driver: Driver, target: ActivationTarget, notification: Notification): Promise<ActivateResult> {
  if (typeof driver.activate !== 'function') {
    return { ok: false, error: `driver «${driver.id}» не будит сам: операции activate у него нет` };
  }
  try {
    const r = await driver.activate(target, notification);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'неизвестно' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Стоп участника. Вставшая сессия сообщений не шлёт, и по mailbox'у о ней не узнать:
 * участник стоит, а owner ждёт сообщения, которого не будет.
 *
 * Эскалация — видимость: строка в status и запись в журнал. Postcard о стопе не шлётся —
 * отдельный notification сжигал ходы оркестратора на каждом круге, пока стоп не снят.
 * Отметка ставится сразу: доставлять нечего, повторять нечего.
 *
 * Возвращает свежие стопы структурой. Строку журнала собирает adapter через `stallLine`:
 * иначе в посмертной записи пропали бы причина и маршрут.
 */
export async function stallRound(home: string, task: string, { sessions = null as SessionSnapshot, now = Date.now() }: {
  sessions?: SessionSnapshot; now?: number;
} = {}): Promise<StalledParticipant[]> {
  const { fresh, current } = pendingStalls(home, task, (ps) => blockedParticipants(home, task, ps, sessions),
    { now, retryMs: 0, maxTries: 1 });
  // Состав мог измениться и без новых: участник отвис. Отметку двигаем всё равно —
  // иначе следующий его стоп с той же причиной свежим не сочтётся.
  commitStalls(home, task, current);
  return fresh;
}

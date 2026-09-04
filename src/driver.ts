// Driver contract и driver registry, entry point "./driver" (ADR-032, §3).
//
// Driver — adapter одного harness'а: он поднимает сессию участника, опознаёт её состояние,
// будит её и умеет остановить. Что именно за harness — package не знает и знать не вправе:
// здесь объявлен только контракт, а сами driver'ы живут у потребителя. Registry передаётся
// в core ЯВНО, картой `harness → driver`, и неизвестный harness отказывает ДО того, как в
// store что-либо изменится: отказ после записи участника оставил бы в журнале задачи
// участника, будить которого нечем.
//
// Ограничение, невидимое из этого файла: имени ни одного harness'а здесь нет и быть не
// может — его сторожит гейт «в исходниках package нет harness-specific имён»
// ([promptobus-package.test.mjs](../../../test/promptobus-package.test.mjs)).
import { addressOf, GateError } from './protocol.js';
import { PromptobusError } from './v1/errors.js';
import type { ParticipantMode, ParticipantV1, TaskV1 } from './v1/model.js';
import { putParticipant } from './v1/store.js';

/** Как участник назван человеку: адрес, если adapter его написал, иначе id записи. */
function named(participant: ParticipantV1 | null | undefined): string {
  return addressOf(participant) ?? String(participant?.id ?? '');
}

/** Способ активации участника: driver будит сессию сам (push) либо она опрашивает (pull). */
export type Activation = 'push' | 'pull';

/**
 * Что driver умеет. Снимок кладётся в запись participant.
 *
 * Флагов девять, и делятся они на два рода. Пять первых объявляют ОПЕРАЦИИ — у каждого
 * есть одноимённый метод, и спрашивает их `requireCapability`. Четыре последних (ADR-034)
 * объявляют СВОЙСТВА harness'а, метода у которых нет: спрашивать их надо до подъёма,
 * потому что без них не собирается роль или строка вывода, а не отдельный вызов.
 */
export interface DriverCapabilities {
  spawn: boolean;
  attach: boolean;
  activation: Activation;
  inspect: boolean;
  stop: boolean;
  /**
   * Умеет ли harness запретить сессии инструменты. Без него read-only участника не бывает
   * вовсе, и `review` обязан отказать ДО подъёма: поднятый reviewer с правом записи —
   * не «ревью без гарантии», а сессия, которая правит ревьюируемый код.
   */
  denyTools?: boolean;
  /**
   * Умеет ли harness принять свой файл настроек или системный промпт на один подъём.
   * Сегодня его читает только СНИМОК capabilities в записи участника — свидетельство того,
   * чем его поднимали; ветки по нему в механизме нет, потому что driver без файла настроек
   * не доставит участнику ни сторожа цикла, ни скиллов, то есть не поднимет его вовсе.
   * Спросит его первым `--harness` (`BL-468`): там выбор driver'а делает человек.
   */
  systemPrompt?: boolean;
  /**
   * Есть ли у harness'а реестр сессий. Без него состояние сессии — неизвестность, а не
   * смерть: механизм не вправе объявить сессию мёртвой оттого, что спросить о ней некого.
   *
   * Читается сегодня ДВОЯКО и без ветки по самому флагу: driver без реестра не объявляет
   * `inspect`, снимок даёт такому участнику `unknown`, и по нему `promptobus status` печатает
   * «спросить о ней некому», уборка каталог оставляет, а надзиратель его не гасит. Флаг
   * называет ПРИЧИНУ этой неизвестности — чтобы второй driver объявлял её вслух, а не
   * молчаливым отсутствием операции.
   */
  sessionList?: boolean;
  /**
   * Умеет ли человек ВОЙТИ в сессию из терминала. Слово `attach` в контракте занято
   * режимом участника (`attached`), поэтому вход человека зовётся `enter` (глоссарий).
   *
   * Сегодня его читает снимок capabilities и `phrases.enter`, которым driver даёт adapter'у
   * строку входа для маршрута по стопу; отдельной ветки по флагу нет — маршрут её и есть.
   * Спросит его первым `--harness` (`BL-468`): у harness'а без входа человека совет
   * «ответить может только человек» пришлось бы писать иначе.
   */
  enter?: boolean;
}

// Режим участника — поле записи v1 (`managed` | `attached`), и второго объявления у него не
// бывает: контракт driver'а и схема store обязаны говорить об одном.
export type { ParticipantMode } from './v1/model.js';

/**
 * Состояние сессии в снимке. `alive` — за записью стоит процесс, `stale` — запись пережила
 * свой процесс, `gone` — записи нет вовсе. Различать эти три обязан driver: у harness'ов
 * признаки разные, а у core вопрос один — ждать ли от участника сообщений.
 *
 * `unknown` — четвёртое и не про сессию, а про наблюдателя: спросить оказалось некого.
 * Driver'а по harness'у записи не нашлось, либо driver не объявил `inspect`. Смертью это
 * не считается ни у одного потребителя: правило «неизвестность — не смерть» держит выход
 * надзирателя, доклад о вставших и уборку `promptobus done` — приняв неизвестность за смерть,
 * механизм гасит слушателя живой задачи и сносит конфиг работающей сессии.
 */
export type SessionState = 'alive' | 'stale' | 'gone' | 'unknown';

/** Стоп сессии, как его назвал driver: `kind` выбирает маршрут, `reason` — слова человеку. */
export interface SessionStall {
  kind: string;
  reason: string;
}

/** Что driver знает про одну сессию прямо сейчас. */
export interface SessionView {
  state: SessionState;
  /** Занята ли сессия ходом. Driver не знает — `false`: неизвестность занятостью не считается. */
  busy: boolean;
  stall: SessionStall | null;
  /** Идентификатор сессии для человеческих маршрутов adapter'а. */
  id: string | null;
  /**
   * Слово harness'а о состоянии — для человеческой строки adapter'а. Core его не читает и
   * решений по нему не принимает: у каждого harness'а свой словарь, и договориться о нём
   * нельзя, а показать человеку — можно.
   */
  note?: string | null;
}

/**
 * Снимок сессий участников: адрес → что про его сессию известно. Ключ — АДРЕС, а не id
 * записи: по нему же ключуются health, отметки стопа и contact point'ы, и он же уезжает в
 * notification, который читает человек ([protocol.ts](protocol.ts), `addressOf`). `null` — состояния нет
 * вовсе (driver не разобрал ответ harness'а), и это НЕ «все живы». Участник без session
 * reference (сессия человека за адресом owner'а) в снимке не числится вовсе.
 */
export type SessionSnapshot = Record<string, SessionView> | null;

/**
 * Harness-neutral MCP descriptor: чем участник дотягивается до шины и до остальных
 * серверов. В собственный конфиг и arguments его переводит сам driver (ADR-032, §3).
 */
export interface McpDescriptor {
  address: string;
  task: string;
  home: string;
  servers: Record<string, unknown>;
}

/**
 * Контекст подъёма: всё, что driver'у нужно, и ничего про его harness (ADR-034). Ни одного
 * argv, ни одного имени флага и ни одного пути его дома здесь нет — их собирает driver сам
 * в `prepare`. Потребитель называет ПРЕДМЕТ («каталоги, которые участник вправе читать»,
 * «команда сторожа цикла»), а как это выглядит у harness'а, знает только driver.
 */
export interface SpawnContext {
  /** Opaque session reference, которым driver опознаёт сессию потом. */
  ref: string;
  address: string;
  task: string;
  home: string;
  mcp: McpDescriptor;
  prompt: string;
  cwd: string;
  /** Роль участника — от неё зависят слова отказов подъёма. */
  role?: string;
  model?: string;
  effort?: string | null;
  permissionMode?: string | null;
  /** Каталоги вне `cwd`, которые участник вправе читать. */
  addDirs?: string[];
  /** Каталог со скиллами рабочего места на одну сессию. */
  pluginDir?: string | null;
  /** Куда driver кладёт свой конфиг MCP и свой файл настроек. */
  mcpConfigPath?: string;
  settingsPath?: string;
  /** Команда сторожа цикла: driver оборачивает её в собственную форму хука. */
  guardCommand?: string;
  /** Инструменты, снятые у участника (требует capability `denyTools`). */
  denyTools?: string[] | null;
  /** Настройки рабочего места, адресованные участнику: driver кладёт их в свой файл. */
  extraSettings?: Record<string, unknown>;
  /** Остальное — дело потребителя: driver читает только то, что назвал контракт. */
  [key: string]: unknown;
}

/** Файл, который driver просит положить рядом с сессией до её подъёма. */
export interface LaunchFile {
  path: string;
  text: string;
  /** В файле секрет (токены) — класть правами `0600`. */
  secret: boolean;
}

/**
 * План подъёма: перевод harness-neutral контекста в argv, конфиги и файлы (ADR-034).
 * Собирается ОДНИМ вызовом `prepare`, и тем же объектом идёт в `spawn`: печать `--dry-run`
 * и реальный подъём обязаны говорить об одном, а два вызова сборки разошлись бы молча.
 */
export interface LaunchPlan {
  /** Аргументы запуска. Потребитель их не собирает и не правит — только печатает. */
  argv: string[];
  /** Конфиг MCP в форме harness'а: его читает `--dry-run` и кладёт на диск потребитель. */
  mcpConfig: unknown;
  /** Файл настроек в форме harness'а. */
  settings: unknown;
  /** Что уедет на диск до подъёма. Порядок значим: driver кладёт их в нём. */
  files: LaunchFile[];
  /**
   * Рабочий каталог сессии, если driver выбрал НЕ тот, что назвал вызывающий (`BL-468`).
   * Нужен там, где harness не принимает настроек на один подъём и читает их из своего
   * рабочего каталога: посади он такого участника в каталог вызывающего — конфиги легли бы
   * в чужое дерево. Поля нет — работает каталог из `SpawnContext.cwd`.
   */
  cwd?: string;
}

/**
 * Слова harness'а, которые adapter вставляет в свои строки. Общий текст остаётся у
 * adapter'а, harness-specific команда приходит строкой отсюда (ADR-034): иначе «claude
 * attach» пришлось бы знать каждому, кто печатает строку про сессию.
 */
export interface DriverPhrases {
  /** Где человек видит свои сессии — командой, как он её наберёт. */
  sessions: string;
  /** Список сессий не разобран: так это называется у harness'а. */
  unreadable: string;
  /** Войти в сессию из терминала (capability `enter`). */
  enter(id: string): string;
  /** Погасить сессию рукой человека. */
  stop(id: string): string;
  /** Посмотреть журнал сессии. */
  logs(id: string): string;
  /**
   * Как ЭТОТ harness называет инструмент сервера MCP — тем именем, которым его зовёт
   * сессия (`BL-468`). Имя собирает клиент, а не сервер, и у разных клиентов оно разное:
   * промпт участника, называющий инструменты шины и памяти, обязан брать написание отсюда,
   * иначе участник ищет инструмент, которого под этим именем у него нет.
   */
  tool(server: string, name: string): string;
  /**
   * Правила ЭТОГО harness'а, которые дописываются к промпту участника (`BL-468`): то, что
   * принадлежит инструменту, а не заданию, — его повадки в headless. Пусто — дописывать
   * нечего, и промпт остаётся ровно тем, что собрал вызывающий.
   */
  promptRules: string;
  /**
   * Как зовётся сессия у этого harness'а, когда имя выбирает не механизм (`BL-484`).
   * Печатает эту строку `--dry-run`: он обязан сказать, чего в его выводе НЕТ и почему —
   * имя, которое придумывает сам бинарь на старте, заранее не напечатать. Не объявлено —
   * имя сессии выбирает механизм, и `--dry-run` печатает его как есть.
   */
  naming?: string;
}

/**
 * Допустимые значения опций и версии harness'а. Потребитель их не знает и знать не вправе:
 * уровни effort, режимы прав и запрещаемые инструменты — словарь harness'а, а не шины.
 */
export interface DriverOptions {
  /**
   * Имя бинаря harness'а: им adapter резолвит путь к нему, проверяет версию и печатает
   * команду в `--dry-run`. Совпадает с `id` driver'а не по правилу, а по факту у этого
   * harness'а: имя в карте registry и имя исполняемого — разные предметы.
   */
  tool: string;
  /** Допустимые значения effort. */
  effortLevels: string[];
  /** Минимальная версия harness'а по уровню effort — там, где значение доезжает не с любой. */
  effortMinVersion?: Record<string, string>;
  /** Допустимые режимы прав и тот, что берётся без флага. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /**
   * Модель, которой участник поднимается без флага `--model` (`BL-468`). Дом — driver:
   * словарь имён моделей принадлежит harness'у целиком, и умолчание одного бинаря другой
   * отвергает как любой неизвестный id.
   */
  defaultModel: string;
  /**
   * Берёт ли harness каталог скиллов рабочего места на одну сессию. Необязательное: не
   * объявлено — «не берёт», и строка вывода говорит об этом вслух вместо того, чтобы
   * обещать участнику скиллы, которых он не получил.
   */
  skillsDir?: boolean;
  /** Инструменты, снятые у read-only участника (capability `denyTools`). */
  denyTools: string[];
  /** Версия harness'а, на которой проверен канал пробуждения. Не гейт — свидетельство. */
  provenVersion: string;
  /**
   * Чем driver будит сессию: `socket` — стук в канал живой сессии, `turn` — новый ход по
   * ней (`BL-324`), `inject` — вставка текста в живую сессию помимо сокета (`BL-484`).
   * Различие не косметическое: подставной канал набора подменяет доставку только там, где
   * она и правда сокет, — у остальных подменять нечего, а `endpoint` их сокетом не является
   * вовсе.
   */
  knockChannel: string;
  /** Переменные предка, которые до сессии доезжать не должны. */
  envDrop: string[];
  /**
   * Утилиты рабочего места, без которых driver не поднимет сессию (`BL-484`). Имена, а не
   * пути: резолв, минимальную версию и слова отказа держит потребитель — у него же живёт
   * декларация инструментов. Необязательное: не объявлено — у harness'а таких зависимостей
   * нет, и спрашивать нечего.
   */
  utils?: string[];
}

/** Что смок канала пробуждения увидел. `endpoint === null` — сессия его не сдаёт вовсе. */
export interface WakeProbe {
  endpoint: string | null;
  ok: boolean;
  /** Причина словами harness'а: чего именно нет или что ответил сокет. */
  error: string | null;
}

/** Куда стучать: opaque ref участника и contact point, который он сдал в store. */
export interface ActivationTarget {
  ref: string | null;
  endpoint: { socket?: string | null; token?: string | null } | null;
}

/** Выжимка сообщения для notification: то, из чего driver собирает свой текст. */
export interface NotificationMessage {
  id: string | null;
  type: string;
  from: string;
  ts: string;
  body: string;
  artifact: string | null;
}

/** Участник, от которого сообщений ждать нечего, — как его назвал разбор стопа. */
export interface StalledParticipant {
  address: string;
  /** Opaque session reference записи участника. */
  ref: string | null;
  id: string | null;
  repoAbs: string | null;
  kind: string;
  reason: string;
  /**
   * Harness записи, как она его назвала (ADR-034). Нужен потребителю, чтобы спросить
   * МАРШРУТ у того же driver'а, который состояние и разобрал: строку о стопе печатают
   * `status`, ответ `mailbox` и доклад надзирателя, а команда в ней harness-specific.
   * Поля нет в записи — `null`, и потребитель берёт `fallback` своего registry.
   */
  harness: string | null;
}

/**
 * Notification: что core просит доставить. Текста здесь нет намеренно — его рендерит
 * driver, потому что рамка и слова принадлежат каналу harness'а, а не шине.
 */
export type Notification =
  { kind: 'unread'; task: string; address: string; unread: number; messages: NotificationMessage[] };

/**
 * Исход гашения. Два признака, а не один: `ok` говорит, что операция не отказала, а
 * `stopped` — что сессия и правда была погашена. Сессии уже нет, у записи нет
 * идентификатора, состояние не разобрано — это успех, но гасить было нечего, и печатать
 * такой исход как «сессия закрыта» значило бы утверждать недоказанное.
 */
export interface StopResult {
  ok: boolean;
  stopped: boolean;
  note: string;
  /**
   * Команду гашения driver ОТДАЛ, а подтвердить исчезновение сессии не смог (`BL-473`):
   * потолок ожидания вышел либо реестр после команды не разобран. Без этого признака
   * `stopped: false` означает «сессии не было ещё до команды», и два разных исхода
   * потребитель печатал бы одними словами — «гасить не пришлось» отрицало бы то, что
   * гасить как раз пришлось. Каталог участника уборка при этом оставляет: для неё сессия
   * не мертва.
   */
  attempted?: boolean;
}

/** Исход активации. Признак «доставлено» этим не даётся — он один, mailbox забран. */
export interface ActivateResult {
  ok: boolean;
  error?: string | null;
}

/** Driver harness'а. Реализуются те операции, которые объявлены в capabilities. */
export interface Driver {
  readonly id: string;
  readonly capabilities: DriverCapabilities;
  /**
   * Словарь harness'а: допустимые значения опций, версии, запрещаемые инструменты.
   * Обязателен, а не «если есть» (замечание ревью): его читают help CLI, оба подъёма,
   * `doctor` и `lint` — и читают БЕЗ проверки, потому что driver без словаря опций не
   * поднимет сессию вовсе. Необязательным полем он делал бы отказ отложенным и невнятным:
   * `agents.js` берёт из него значения на верхнем уровне модуля, то есть упал бы на любой
   * команде CLI, включая `--version`.
   */
  readonly options: DriverOptions;
  /** Строки harness'а для человеческих маршрутов adapter'а. Обязательны по той же причине. */
  readonly phrases: DriverPhrases;
  /**
   * Перевести harness-neutral контекст в свой план подъёма. Ничего не пишет и не
   * запускает: `--dry-run` печатает ровно то, что исполнит `spawn`.
   */
  prepare?(context: SpawnContext): LaunchPlan;
  spawn?(plan: LaunchPlan, runtime: SpawnContext): Promise<unknown>;
  attach?(plan: LaunchPlan, runtime: SpawnContext): Promise<unknown>;
  /** Что сказано о подъёме после успеха: неподтверждённая сверка, неразобранный id. */
  saidLiftoff?(result: unknown): void;
  inspect?(ref: string): SessionView | null;
  /** Забыть запомненный список сессий: после подъёма и гашения он устарел. */
  forgetSessions?(): void;
  activate?(target: ActivationTarget, notification: Notification): Promise<ActivateResult> | ActivateResult;
  /** Текст notification'а в канал этого harness'а. Внутри `activate`; наружу — для шва. */
  renderNotification?(notification: Notification): string;
  /**
   * Что человеку делать с этим стопом — командами своего harness'а. Общий текст («встал»,
   * «ЧИСЛИТСЯ», «ИСЧЕЗ») остаётся у adapter'а: он один на все harness'ы.
   */
  stallRoute?(stall: StalledParticipant & { task?: string | null }, id: string | null, ref: string | null): string;
  /** Сдать contact point СВОЕЙ сессии в store задачи: адрес сокета знает только harness. */
  registerWake?(home: string, task: string, address: string, env?: unknown, session?: string | null): unknown;
  /** Сказать в журнал надзирателя, что запись за чужой адрес не пошла. */
  sayForeignWrite?(home: string, task: string, address: string, held: string, session: string | null, what: string): void;
  /** Смок канала пробуждения для диагностики: сдан ли сокет и принимает ли он соединение. */
  checkWake?(env?: unknown): Promise<WakeProbe>;
  /**
   * Окружение поднимаемой сессии: поверх наследуемого ложится `extra` вызывающего, а
   * протекающие от предка переменные снимает driver. Второй аргумент обязателен по факту:
   * им едет рычаг, который ставит сам механизм (гейт хука памяти), и driver, читающий одно
   * `base`, потерял бы его молча.
   */
  sessionEnv?(base: unknown, extra?: Record<string, string>): Record<string, string | undefined>;
  /**
   * Отказ по версии harness'а под запрошенные опции — до первой записи на диск. `null` —
   * отказывать не за что: версия годится либо её не прочли, а утверждать «старее нужной»
   * о непрочитанном механизм не вправе.
   */
  optionRefusal?(options: { effort?: string | null }, tool: unknown): string | null;
  /**
   * Имена доставленных серверов MCP, перекрытые ЛИЧНЫМИ записями пользователя. Личный
   * конфиг — свойство harness'а: у второго driver'а он лежит в другом месте и в другой
   * форме, а строка вывода про перекрытия одна на всех.
   */
  shadowedUserServers?(names: string[]): string[];
  /**
   * Погасить сессию. `ok` — операция не отказала, `stopped` — сессия и правда была
   * погашена: гасить оказалось нечего — тоже успех, но другой исход, и путать их нельзя.
   *
   * **Операция возвращается, когда сессии у harness'а уже НЕТ** (`BL-473`) — либо с честным
   * `stopped: false` и причиной в `note`, если ждать пришлось дольше её собственного
   * потолка. Обещать «погашено» раньше нельзя: следом за гашением идёт уборка, а она
   * спрашивает у driver'а состояние сессии — вернись `stop` раньше её смерти, обход увидел
   * бы сессию живой и законно оставил бы её каталог до следующего закрытия задачи.
   *
   * Ждать driver вправе, поэтому исход бывает и обещанием: `stopParticipant` его `await`'ит,
   * и потребитель обязан делать то же. Синхронный driver контракту тоже отвечает — ждать
   * ему нечего, если у его harness'а сессии не станет тем же вызовом.
   */
  stop?(ref: string): StopResult | Promise<StopResult>;
}

/**
 * Карта `harness → driver`. Потребитель собирает её сам и передаёт в core явно: core не
 * заводит driver'ов и не ищет их.
 *
 * `fallback` — harness, приписываемый записи участника, у которой поля `harness` нет
 * ВОВСЕ. Такие записи оставил прежний CLI, когда harness был один; на них стоит и legacy
 * fixture. Пустое поле — не то же самое, что неизвестное имя: непустой незнакомый harness
 * отказывает, и fallback его не спасает.
 */
export interface Registry {
  readonly drivers: Readonly<Record<string, Driver>>;
  readonly fallback: string | null;
}

export function createRegistry({ drivers, fallback = null }: {
  drivers: Record<string, Driver>;
  fallback?: string | null;
}): Registry {
  if (!drivers || typeof drivers !== 'object') throw new GateError('registry: нужна карта harness → driver');
  for (const [harness, driver] of Object.entries(drivers)) {
    if (!driver?.id || !driver?.capabilities) {
      throw new GateError(`registry: driver «${harness}» без id или capabilities — контракт не выполнен`);
    }
  }
  if (fallback !== null && !Object.hasOwn(drivers, fallback)) {
    throw new GateError(`registry: fallback «${fallback}» не назван в карте harness → driver`);
  }
  return { drivers: { ...drivers }, fallback };
}

/** Имя harness'а записи. Поля нет вовсе — берётся `fallback` registry (запись прежнего CLI). */
export function harnessOf(participant: ParticipantV1 | null | undefined, registry: Registry): string | null {
  const declared = participant?.harness;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();
  return registry.fallback;
}

/** Driver по имени harness'а. Неизвестный — отказ, и отказ ДО всякой записи в store. */
export function driverFor(registry: Registry, harness: string | null | undefined): Driver {
  const known = Object.keys(registry.drivers);
  if (!harness) {
    throw new GateError('harness участника не назван, и registry не объявил fallback — '
      + `известные harness: ${known.join(', ') || 'нет ни одного'}`);
  }
  const driver = registry.drivers[harness];
  if (!driver) {
    throw new GateError(`harness «${harness}» неизвестен — известные: ${known.join(', ') || 'нет ни одного'}`);
  }
  return driver;
}

/**
 * Умеет ли driver то, о чём его просят. Спрашивается ДО изменения store: объявленная
 * capability без операции — тот же отказ, что и незаявленная, потому что для вызывающего
 * они неразличимы.
 */
export function requireCapability(driver: Driver, op: 'spawn' | 'attach' | 'inspect' | 'stop'): void {
  if (!driver.capabilities?.[op]) {
    throw new GateError(`driver «${driver.id}» не умеет ${op} — эта операция им не объявлена`);
  }
  if (typeof (driver as unknown as Record<string, unknown>)[op] !== 'function') {
    throw new GateError(`driver «${driver.id}» объявил ${op}, но операции у него нет`);
  }
}

/** Свойства harness'а без своей операции: спрашиваются флагом, а не наличием метода. */
export type DriverFeature = 'denyTools' | 'systemPrompt' | 'sessionList' | 'enter';

/**
 * Объявил ли driver свойство harness'а (ADR-034). Операции у таких флагов нет, поэтому
 * `requireCapability` сюда не годится: спрашивать нечего, кроме самого объявления.
 * Незаявленное свойство читается как «нет»: молчаливое «наверное, умеет» и есть тот
 * случай, ради которого флаг заведён.
 */
export function hasFeature(driver: Driver, feature: DriverFeature): boolean {
  return driver.capabilities?.[feature] === true;
}

/** Умеет ли driver будить сам. Pull-driver сессию не будит — он организует свой polling. */
export function pushes(driver: Driver): boolean {
  return driver.capabilities?.activation === 'push';
}

/**
 * Opaque session reference записи участника. Записи прежнего CLI несли её полем `name`;
 * отдельное поле им дала миграция ([migrate.ts](migrate.ts)), поэтому здесь читается только
 * оно — второго источника у v1 нет.
 */
export function sessionRefOf(participant: ParticipantV1 | null | undefined): string | null {
  const ref = participant?.sessionRef;
  return typeof ref === 'string' && ref ? ref : null;
}

/**
 * Записать участника, которого driver поднял (`managed`) либо к чьей сессии подключился
 * (`attached`).
 *
 * Registry спрашивается ПЕРВЫМ, и в этом весь смысл функции: неизвестный harness и
 * необъявленная операция отказывают до того, как в журнале задачи что-либо изменится.
 * Отказ после записи оставил бы в журнале участника, будить которого нечем, — а журнал
 * читают и надзиратель, и `status`, и уборка.
 */
export function openParticipant(home: string, task: string, participant: ParticipantV1, registry: Registry, { mode = 'managed' as ParticipantMode } = {}): {
  driver: Driver; meta: TaskV1; record: ParticipantV1;
} {
  const driver = driverFor(registry, harnessOf(participant, registry));
  requireCapability(driver, mode === 'managed' ? 'spawn' : 'attach');
  const ref = sessionRefOf(participant);
  if (!ref) {
    throw new GateError(`участник ${named(participant)}: driver «${driver.id}» не получил session reference — `
      + 'опознавать его сессию потом будет нечем');
  }
  // Запись отдаётся вызывающему целиком: `putParticipant` кладёт участника целиком, и
  // дописывающий к ней id сессии обязан класть обратно ТУ ЖЕ запись, а не собранную заново
  // — иначе поля driver'а исчезли бы второй же записью.
  //
  // Отказ store переводится в `GateError`, как его переводит дверь механизма: подъём зовут
  // две команды, и занятый журнал у них — законный исход. Два `promptobus spawn` одного
  // run'а бьются за журнал по построению (`BL-249`), и проигравший обязан прочитать
  // «журнал задачи занят», а не стек `PromptobusError` из верхнего catch.
  const record: ParticipantV1 = { ...participant, ...participantDriverFields(driver, { mode, ref }) };
  let meta: TaskV1;
  try {
    meta = putParticipant(home, task, record, () => new Date());
  } catch (e) {
    if (e instanceof PromptobusError) throw new GateError(e.message);
    throw e;
  }
  return { driver, meta, record };
}

/**
 * Режим участника. Поля нет вовсе — `managed`: записи прежнего CLI оставил spawn, а он
 * поднимал сессию сам. Участник без session reference режима не имеет: сессию за ним
 * никто не поднимал (так живёт owner задачи).
 */
export function modeOf(participant: ParticipantV1 | null | undefined): ParticipantMode | null {
  if (!sessionRefOf(participant)) return null;
  const raw = typeof participant?.mode === 'string' ? participant.mode.trim() : '';
  // Поля нет вовсе — `managed`: так писал участников прежний CLI, а сессию поднимал spawn.
  if (!raw) return 'managed';
  // Незнакомое непустое значение — опечатка или мусор из правки руками, и умолчание тут
  // разрушительно (замечание ревью): «раз не attached, значит managed» гасит сессию,
  // которую driver не поднимал. Режима нет — гасить некому, а явный вызов отказывает.
  return raw === 'managed' || raw === 'attached' ? raw : null;
}

/** Распоряжается ли driver этой сессией: поднял он её — ему её и гасить. */
export function isManaged(participant: ParticipantV1 | null | undefined): boolean {
  return modeOf(participant) === 'managed';
}

/**
 * Остановить сессию участника — операция driver'а, а не команды.
 *
 * Гасить вправе только `managed`: сессию, подключившуюся самой, driver не поднимал, и
 * capability тут ни при чём — дело в режиме. Отказ явный, а не молчаливый пропуск: тихо
 * оставленная живой чужая сессия и есть тот случай, ради которого режим объявлен полем.
 *
 * Идемпотентность — на driver'е: сессии уже нет, она мертва или её состояние не разобрано —
 * это исход со своими словами, а не ошибка.
 *
 * Исход `await`'ится: driver вправе дождаться, пока сессии у harness'а не станет (`BL-473`),
 * и потребитель обязан дождаться его — иначе уборка пойдёт по состоянию, которого ещё нет.
 */
export async function stopParticipant(participant: ParticipantV1, registry: Registry): Promise<StopResult> {
  const driver = driverFor(registry, harnessOf(participant, registry));
  requireCapability(driver, 'stop');
  const mode = modeOf(participant);
  if (mode !== 'managed') {
    // Незнакомое значение называется дословно: «режима нет» о поле, в котором что-то
    // написано, читалось бы как «поля нет», а чинят их по-разному.
    const raw = typeof participant?.mode === 'string' ? participant.mode.trim() : '';
    const said = mode ?? (raw ? `«${raw}» — такого режима контракт не знает` : 'сессии за ним нет вовсе');
    throw new GateError(`участник ${named(participant)}: режим ${mode ? `«${mode}»` : said} — `
      + `driver «${driver.id}» эту сессию не поднимал и распоряжаться ею не вправе`);
  }
  return driver.stop!(sessionRefOf(participant)!);
}

/** Поля driver'а в записи participant: harness, режим и снимок capabilities. */
export function participantDriverFields(driver: Driver, { mode, ref }: {
  mode: ParticipantMode;
  ref: string;
}): { harness: string; mode: ParticipantMode; sessionRef: string; capabilities: DriverCapabilities } {
  return {
    harness: driver.id,
    mode,
    sessionRef: ref,
    capabilities: { ...driver.capabilities },
  };
}

/** Спросить некого: driver'а нет либо он не смотрит. Не смерть и не жизнь — неизвестность. */
const UNKNOWN: SessionView = { state: 'unknown', busy: false, stall: null, id: null };

/**
 * Снимок сессий участников — вход машины состояний. Берётся раз в удар сердца: за ответом
 * driver'а стоит внешний опрос harness'а, и круг присмотра, идущий раз в секунду, своего
 * опроса не заводит.
 *
 * Driver не разобрал состояние хотя бы одной сессии — снимка нет целиком: неизвестность у
 * одного участника означает недоступность источника, а не смерть остальных.
 *
 * **Одна негодная запись не имеет права уносить снимок целиком** (замечание ревью). Чужой
 * harness и driver, объявивший себя не смотрящим, дают этому участнику `unknown` — и обход
 * идёт дальше. Иначе отказ выходил наружу и валил всех читателей снимка разом: печать
 * `promptobus status`, обход `promptobus done` посреди уборки чужих токенов и сам процесс надзирателя.
 * Про чужой harness скажет круг присмотра — там у него свои слова и своя отметка health.
 */
export function snapshotSessions(participants: ParticipantV1[] | null | undefined, registry: Registry): SessionSnapshot {
  const view: Record<string, SessionView> = {};
  for (const p of participants ?? []) {
    const ref = sessionRefOf(p);
    const addr = addressOf(p);
    if (!addr || !ref) continue;
    let seen: SessionView | null;
    try {
      const driver = driverFor(registry, harnessOf(p, registry));
      if (!driver.capabilities?.inspect || typeof driver.inspect !== 'function') {
        view[addr] = UNKNOWN;
        continue;
      }
      seen = driver.inspect(ref);
    } catch {
      view[addr] = UNKNOWN;
      continue;
    }
    if (seen === null) return null;
    view[addr] = seen;
  }
  return view;
}

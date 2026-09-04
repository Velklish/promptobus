// Promptobus service, каким его видит MCP-слой: перечень операций, которыми пользуются
// инструменты. Перечень явный, а не «весь store», и это и есть смысл файла — граница видна
// глазом, а не выводится чтением четырёх модулей. Home операции получают аргументом: он
// приходит с идентичностью процесса, и второго источника у него нет.
//
// Service передаётся factory ЯВНО , и **дефолтной реализации у него нет**: половина перечня — дело
// adapter'а, а не store. Владение mailbox'ом, привязка «сессия → задача», резолв активной
// задачи и шапка `PROMPTOBUS_HOME=… · задача=… · адрес=…` стоят на идентичности сессии, а
// окружение читает только adapter. Собирает service он же —
// adapter потребителя.
//
// Адреса, а не id участников. Инструменты шины разговаривают адресами: адрес объявлен
// участнику его mcp-config'ом, им же ключуются health и contact point'ы, и его читает
// человек. Перевод адреса в id записи v1 делает adapter — там, где он и живёт.
import type { Ownership } from '../protocol.js';
import type { ArtifactV1, MessageV1, TaskV1 } from '../v1/model.js';

/** Что отправляется на шину инструментом `promptobus_send`. */
export interface OutgoingMessage {
  from: string;
  to: string;
  type: string;
  body: string;
  artifactPath?: string | null;
}

/** Исход отправки: канон и metadata артефакта, если он был. */
export interface SentMessage {
  message: MessageV1;
  artifact: ArtifactV1 | null;
}

/** Что нашлось в mailbox'е: сообщения и человеческие строки о нечитаемом. */
export interface MailboxRead {
  messages: MessageV1[];
  broken: string[];
}

/** Операции, которыми пользуется MCP-слой. Собирает их adapter. */
export interface PromptobusService {
  /** Папка файлов задачи: её путь печатает `promptobus_task`, в ней лежат артефакты. */
  artifactsDir(home: string, task: string): string;
  /** Имя файла артефакта по id его metadata-записи; `undefined` — запись не прочиталась. */
  artifactName(home: string, task: string, artifact: string): string | undefined;
  /** Привязать сессию к задаче, которой она владеет. */
  bindSession(home: string, task: string, session: string | null): unknown;
  /** Строка о нечитаемом для ответа инструмента; `null` — говорить не о чем. */
  brokenNote(broken: string[]): string | null;
  /** Захватить mailbox `orchestrator`. Возвращается прежний владелец. */
  claimOwnership(home: string, task: string, owner: string): string | null;
  /** Сколько непрочитанного лежит у адреса. */
  countInbox(home: string, task: string, addr: string): number;
  /** Шапка ответа: home, задача по id и имени, адрес и расхождение с привязкой сессии. */
  identityLabel(home: string, task: string, addr: string, session?: string | null): string;
  /** Владение mailbox'ом: закрыт ли он за другой сессией. */
  ownership(home: string, task: string, addr: string, session: string | null): Ownership;
  /** Прочитать не забирая: оригиналы остаются владельцу. */
  peekInbox(home: string, task: string, addr: string): MailboxRead;
  /** Забрать входящие: прочитанное уезжает в history. */
  readInbox(home: string, task: string, addr: string): MailboxRead;
  readTask(home: string, task: string): TaskV1;
  /** Активная задача процесса: объявленная → привязка сессии → единственная активная. */
  resolveTaskId(home: string, declared: string | null | undefined, session: string | null): string;
  send(home: string, task: string, outgoing: OutgoingMessage): SentMessage;
  /** Хвост «твой mailbox: непрочитано N»; `null` — ноль либо говорить не о чем. */
  unreadNote(home: string, task: string, addr: string, session: string | null): string | null;
  /** Кэш журнала на один вызов инструмента: журнал читается по четыре-шесть раз. */
  withTaskCache<T>(fn: () => T): T;
}

// Публичная поверхность Promptobus, entry point ".". Она **одна** — protocol и store v1
// (`BL-430`): задачи, участники, сообщения, артефакты, восстановимый fan-out и история.
// Рядом с ней уходят наружу словарь шины, файлы каталога задачи, которых не держит store,
// миграция прежнего корня, MCP factory, driver contract и машина состояний надзирателя.
//
// Сырые filesystem-хелперы (атомарная запись файла и JSON) наружу не выходят — они
// внутренние (ADR-032, §1): экспортированный однажды хелпер становится контрактом, а смысл
// границы в том, что снаружи виден protocol, а не диск. По той же причине снаружи не видно
// и путей store v1: все операции идут через `openEngine`.
//
// Ограничение, невидимое из этого файла: исходники package импортируют только Node
// built-ins и собственные файлы. Ни cli/lib, ни Git, ни layout рабочего места, ни harness
// сюда не попадают — на этом держится standalone-сборка, и это сторожит import-boundary
// gate. Он же сторожит и обратное направление: `process.env`, `process.stdout`,
// `process.stderr` и `console.` в исходниках package запрещены. **Диагностика, идентичность
// сессии и имя harness'а приходят АРГУМЕНТАМИ** — так же, как `home` и `policy` у
// `openEngine`: окружение и вывод остаются делом adapter'а (ADR-032, §2).

/** Версия протокола и store, которую понимает эта сборка. */
export const PROTOCOL_VERSION = 1;

/** Имя package. Отдаётся наружу, чтобы импорт из собранного dist был проверяем. */
export const PACKAGE_NAME = '@ati-agents/promptobus';

// Словарь шины: типы сообщений, грамматика адресов, идентичность задачи, вокабуляр гейта
// чужого mailbox'а и accessor'ы полей adapter'а в записи участника.
export {
  addressOf, addrDir, brokenNote, claimRoute, dismissedOf, foreignTaskLine, FOREIGN_MARK,
  FOREIGN_ROUTE, GateError, isAddress, MAILBOX_CLAIMED_MARK, MECHANISM_VERSION_FIELD,
  mechanismVersionOf, MESSAGE_TYPES, nameOf,
  newTaskIdentity, ORCHESTRATOR, ownerOf, participantFileStem, repoAbsOf, requireTaskId,
  foreignSessionOf,
  reviewerAddress, roleOf, sameSession, sessionIdOf, sessionOf, SLUG_MAX, slugify, stampOfId,
  startedOf, TASK_ID_RE,
  TASK_TITLE_SEP, taskDir, tasksDir, UNDECLARED_HARNESS, UNDECLARED_ROLE, workerAddress,
} from './protocol.js';
export type { Clock as TaskClock, Ownership } from './protocol.js';

// Protocol и store v1 (`BL-409`, ADR-032 §6) — плоско, а не namespace'ом: namespace `v1`
// заводился потому, что плоские имена занимал слой совместимости, и с его уходом второго
// набора имён здесь нет вовсе.
export * from './v1/index.js';

// Файлы каталога задачи, которых не держит store: contact point'ы, health, отметка и журнал
// надзирателя, отметки стопа и конца хода, привязки сессий, каталог файлов участника и лок
// журнала.
export {
  beatWarden, claimWarden, clearWarden, healthFile, lastTurnAt, liveWarden, lockBusyError,
  logWarden, markTurn, onTaskLock, readBinding, readHealth, readStalls, readWake, sessionFile,
  sessionsDir, stallsFile, tailWardenLog, WARDEN_BEAT_SEC, wakeFile, wardenLogFile,
  wardenMarkFile, withTaskLock, workersDir, writeBinding, bindingNames, dropBinding,
  writeHealth, writeStalls, writeWake,
} from './sidecar.js';
export type { Binding, Health, LockHolder, Stalls, Suspend, Wake, WardenMark } from './sidecar.js';
export { pidAlive } from './fs/proc.js';

// Store `v0.61.0` — namespace'ом, а не россыпью: имена у него и у v1 одни и те же, и в общем
// пространстве они столкнулись бы. Зовут его двое и только они: миграция и набор,
// проверяющий чтение legacy-fixture.
export * as legacy from './legacy-store.js';

// Миграция `.agents/a2a` → `.promptobus` (`BL-410`, ADR-032 §7).
export { LEGACY_DONE, LEGACY_REL, migrate, migrationNeeded, preflight } from './migrate.js';
export type { MigrationOptions, MigrationPlan, MigrationReport, TaskReport } from './migrate.js';

// MCP-сервер шины (`BL-407`): транспорт, negotiation и диспетчер инструментов. Потребитель
// подаёт service и callbacks и получает `serve` — рабочее место, Git и harness за эту
// границу не заходят ([mcp/server.ts](mcp/server.ts)).
export { createMcpServer, negotiateProtocol } from './mcp/server.js';
export type {
  McpEvent, McpIdentity, McpInput, McpJoin, McpOptions, McpOutput, McpServerInfo, McpStalls,
} from './mcp/server.js';
export type {
  MailboxRead, OutgoingMessage, PromptobusService, SentMessage,
} from './mcp/service.js';
export { ADDR_MARK, readableName, senderAddress, summarizeMessages } from './mcp/render.js';
export type { DecorateParticipant } from './mcp/render.js';

// Driver contract, registry и машина состояний надзирателя (`BL-408`). Отдельным блоком:
// у driver'а есть и свой entry point `./driver` — там объявлен контракт, — а здесь та же
// поверхность приезжает вместе со store, потому что потребитель берёт их вместе: registry
// передаётся в машину состояний, а машина состояний читает store задачи.
export * from './driver.js';
export * from './supervisor.js';

// Host contract и standalone-реализация (ADR-038, BL-518). Отдельный entry point
// `./host` — тот же набор: потребитель, которому нужен только host, не тянет store.
export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from './host.js';
export type {
  HostFreshness, HostModuleNote, HostRepo, HostRepoCandidate, HostRepoModule,
  HostServers, HostToolBin, PromptobusHost,
} from './host.js';
export { HOST_CONFIG, createStandaloneHost } from './standalone.js';
export type { StandaloneHostOptions } from './standalone.js';

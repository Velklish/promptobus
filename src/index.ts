// Public Promptobus surface, the "." entry point. It is **one** — protocol and store v1:
// tasks, participants, messages, artifacts, recoverable fan-out, and history.
// Alongside it go out the bus vocabulary, task-directory files the store does not
// hold, former-root migration, the MCP factory, the driver contract, and the
// warden state machine.
//
// Raw filesystem helpers (atomic file and JSON writes) do not go out — they are
// internal: a helper exported once becomes a contract, and the point of the
// boundary is that the outside sees protocol, not disk. For the same reason the
// store v1 paths are not visible outside: every operation goes through `openEngine`.
//
// A constraint invisible from this file: package sources import only Node
// built-ins and their own files. No consumer modules, no Git, no workspace
// layout, no harness land here — standalone builds rest on that, and the
// import-boundary gate watches it. It also watches the other direction:
// `process.env`, `process.stdout`, `process.stderr`, and `console.` are forbidden
// in package sources. **Diagnostics, session identity, and the harness name
// arrive as ARGUMENTS** — the same way `home` and `policy` do for `openEngine`:
// the environment and the output stay the adapter's business.

/** Protocol and store version this build understands. */
export const PROTOCOL_VERSION = 1;

/** Package name. Exposed so an import from the built dist is checkable. */
export const PACKAGE_NAME = 'promptobus';

// Bus vocabulary: message types, address grammar, task identity, foreign-mailbox
// gate wording, and accessors for adapter fields on the participant record.
export {
  addressOf, addrDir, brokenNote, claimRoute, dismissedOf, foreignTaskLine, FOREIGN_MARK,
  FOREIGN_ROUTE, GateError, isAddress, MAILBOX_CLAIMED_MARK, MECHANISM_VERSION_FIELD,
  mechanismVersionOf, MESSAGE_TYPES, nameOf,
  newTaskIdentity, ORCHESTRATOR, ownerOf, participantFileStem, repoAbsOf, requireTaskId,
  foreignSessionOf,
  reviewerAddress, roleOf, ROUTING_FIELD, routingOf, sameSession, sessionIdOf, sessionOf, SLUG_MAX, slugify, stampOfId,
  startedOf, TASK_ID_RE,
  TASK_TITLE_SEP, taskDir, tasksDir, UNDECLARED_HARNESS, UNDECLARED_ROLE, workerAddress,
} from './protocol.js';
export type { Clock as TaskClock, Ownership } from './protocol.js';

// Protocol and store v1 — flat, not a namespace: the `v1` namespace existed
// because the flat names were taken by the compatibility layer, and with that
// gone there is no second set of names here at all.
export * from './v1/index.js';

// Task-directory files the store does not hold: contact points, health, the
// warden mark and log, stall and end-of-turn marks, session bindings, the
// participant files directory, and the journal lock.
export {
  beatWarden, claimWarden, clearWarden, healthFile, lastTurnAt, liveWarden, lockBusyError,
  logWarden, markTurn, onTaskLock, readBinding, readHealth, readStalls, readWake, sessionFile,
  sessionsDir, stallsFile, tailWardenLog, WARDEN_BEAT_SEC, wakeFile, wardenLogFile,
  wardenMarkFile, withTaskLock, workersDir, writeBinding, bindingNames, dropBinding,
  writeHealth, writeStalls, writeWake,
} from './sidecar.js';
export type { Binding, Health, LockHolder, Stalls, Suspend, Wake, WardenMark } from './sidecar.js';
export { pidAlive } from './fs/proc.js';

// Store `v0.61.0` — as a namespace, not a scatter: its names and v1's are the
// same, and in a shared space they would collide. Two callers only: migration
// and the suite that checks reading a legacy fixture.
export * as legacy from './legacy-store.js';

// Former-store migration → `.promptobus`. Where to migrate from is declared by the host.
export { migrate, migrationNeeded, preflight, splitLegacyRel } from './migrate.js';
export type { MigrationOptions, MigrationPlan, MigrationReport, TaskReport } from './migrate.js';

// Bus MCP server: transport, negotiation, and the tool dispatcher. The consumer
// supplies a service and callbacks and gets `serve` — workspace, Git, and harness
// do not cross this boundary ([mcp/server.ts](mcp/server.ts)).
export { createMcpServer, negotiateProtocol } from './mcp/server.js';
export type {
  McpEvent, McpIdentity, McpInput, McpJoin, McpOptions, McpOutput, McpServerInfo, McpStalls,
} from './mcp/server.js';
export type {
  MailboxRead, OutgoingMessage, PromptobusService, SentMessage,
} from './mcp/service.js';
export {
  ADDR_MARK, MAILBOX_EMPTY, MESSAGE_FROM, readableName, senderAddress, SENT_PREFIX, summarizeMessages,
} from './mcp/render.js';
export type { DecorateParticipant } from './mcp/render.js';

// Driver contract, registry, and the warden state machine. A separate block:
// the driver also has its own `./driver` entry point — the contract is declared
// there — and here the same surface arrives together with the store, because
// the consumer takes them together: the registry is passed into the state
// machine, and the state machine reads the task store. The availability adapter
// contract ([model-routing.ts](model-routing.ts)) rides the same star: a driver
// declares it as `availability`, and the two are read together.
export * from './driver.js';
export * from './supervisor.js';

// Host contract and standalone implementation. A separate `./host` entry
// point is the same set: a consumer that only needs a host does not pull the store.
export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from './host.js';
export type {
  HostFreshness, HostLegacyLayout, HostModuleNote, HostRepo, HostRepoCandidate, HostRepoModule,
  HostRoutingOverlay, HostRoutingPaths, HostServers, HostToolBin, PromptobusHost,
} from './host.js';
export { HOST_CONFIG, createStandaloneHost } from './standalone.js';
export type { StandaloneHostOptions } from './standalone.js';

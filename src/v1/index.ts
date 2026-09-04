// Protocol and store v1 — the production store since cutover
// and its only surface: there is no longer a layer of former names over the
// engine, and consumers call these models directly.
//
// Names go out FLAT, from `../index.ts` (`export * from './v1/index.js'`): the
// v1 surface is still from the main entry point; `./driver`, `./host`, and
// `./hooks` go out separately. Raw store paths do not go out — the outside
// sees protocol, not disk; the exception is declared by the engine itself
// (`taskFile`, `inboxPath`, `historyPath`, `brokenPath`) and named there.
export { ERROR_CODES, PromptobusError } from './errors.js';
export type { ErrorCode, ErrorContext } from './errors.js';
export {
  MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES_V1, MODELS, SCHEMA_VERSION,
} from './model.js';
export type {
  ArtifactV1, CapabilitiesSnapshot, MessageV1, ModelName, ParticipantMode, ParticipantV1, TaskV1,
} from './model.js';
export { requireValid, validate } from './validate.js';
export type { Verdict } from './validate.js';
export { ROOT_DIR } from './layout.js';
export { INTENT_STALE_MS } from './messages.js';
export { openEngine } from './engine.js';
export type {
  Engine, EngineOptions, PruneResult, RecoverResult, RoutingDecision, RoutingPolicy, SendInput,
  SendResult,
} from './engine.js';
export type { ArtifactSource } from './artifacts.js';
export type { BrokenTask, Clock, NewTask, ParticipantPatch, ReaderVersion } from './store.js';
export type {
  ActivationEvent, BrokenNote, FanoutStep, FaultHook, HistoryEntry, HistoryPage, HistoryQuery, Repair,
} from './messages.js';

// Protocol v1 entry point: what the package exports of it and what stays inside.
// The surface and its boundary: reference/04-protocol.md.
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
  SendResult, SendSyncInput,
} from './engine.js';
export type { ArtifactSource } from './artifacts.js';
export type { BrokenTask, Clock, NewTask, ParticipantPatch, ReaderVersion } from './store.js';
export type {
  ActivationEvent, BrokenNote, FanoutStep, FaultHook, HistoryEntry, HistoryPage, HistoryQuery,
  RecoverFailure, Repair,
} from './messages.js';

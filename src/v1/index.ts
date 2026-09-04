// Protocol и store v1 — production store механизма с cutover'а
// и единственная его поверхность: слоя с прежними именами над engine больше нет,
// и потребители зовут эти модели напрямую.
//
// Наружу имена уходят ПЛОСКО, из `../index.ts` (`export * from './v1/index.js'`): поверхность
// v1 по-прежнему из главного entry point; отдельно уходят `./driver`, `./host` и `./hooks`.
// Сырые пути store
// наружу не выходят — снаружи виден protocol, а не диск; исключение объявлено самим
// engine (`taskFile`, `inboxPath`, `historyPath`, `brokenPath`) и названо там же.
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

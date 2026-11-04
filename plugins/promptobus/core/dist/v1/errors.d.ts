/** Refusal-code list. A constant, not in-place strings: the consumer branches on the code, and an
 * undeclared code is read as an unknown refusal. */
export declare const ERROR_CODES: readonly ['policy-required', 'policy-denied', 'task-not-found', 'task-exists', 'task-closed', 'task-active', 'task-broken', 'participant-not-found', 'participant-exists', 'recipients-empty', 'recipients-duplicate', 'message-type-unknown', 'schema-invalid', 'schema-version-unsupported', 'pipeline-invalid', 'artifact-source', 'artifact-not-found', 'artifact-broken', 'artifact-integrity', 'lock-busy', 'lock-self-async', 'link-refused', 'dir-blocked', 'dir-occupied', 'strategy-unknown', 'role-unknown', 'harness-unknown', 'catalog-invalid', 'overlay-invalid', 'constraint-unknown', 'constraint-unavailable', 'candidates-empty', 'limit-hit-at-start', 'harness-refused'];
/** v1 refusal code. */
export type ErrorCode = (typeof ERROR_CODES)[number];
/** Facts of the refusal: which task, participant, file. Read by the consumer, not by a person. */
export type ErrorContext = Record<string, unknown>;
/** Protocol v1 refusal. A class, not a bare `Error`: the consumer tells a bus refusal from a crash
 * with `instanceof`, and branches on `code`. */
export declare class PromptobusError extends Error {
    readonly code: ErrorCode;
    readonly context: ErrorContext;
    constructor(code: ErrorCode, message: string, context?: ErrorContext);
}
/** Short throw form: no v1 refusal has a place that needs a bare `Error`. */
export declare function fail(code: ErrorCode, message: string, context?: ErrorContext): never;

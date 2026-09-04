// Protocol v1 refusals: a typed code plus context.
//
// Human wording is the adapter's job, and that is not style: the package must
// compile and be tested without the CLI, and user output stays in the CLI
// entirely. So what goes out is a `code` from the list below and `context`
// with the facts of the refusal; `message` inside the exception is left for
// debugging — a consumer has no need to read it, and must branch on the code.

/**
 * Refusal-code list. A constant, not in-place strings: the consumer branches
 * on the code, and an undeclared code is read as an unknown refusal.
 */
export const ERROR_CODES = [
  // routing policy
  'policy-required',
  'policy-denied',
  // task
  'task-not-found',
  'task-exists',
  'task-closed',
  'task-active',
  'task-broken',
  // participants
  'participant-not-found',
  'participant-exists',
  // send
  'recipients-empty',
  'recipients-duplicate',
  'message-type-unknown',
  // validation
  'schema-invalid',
  'schema-version-unsupported',
  // artifacts
  'artifact-source',
  'artifact-not-found',
  'artifact-integrity',
  // disk
  'lock-busy',
  'link-refused',
] as const;

/** v1 refusal code. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Facts of the refusal: which task, participant, file. Read by the consumer, not by a person. */
export type ErrorContext = Record<string, unknown>;

/**
 * Protocol v1 refusal. A class, not a bare `Error`: the consumer tells a bus
 * refusal from a crash with `instanceof`, and branches on `code`.
 */
export class PromptobusError extends Error {
  readonly code: ErrorCode;

  readonly context: ErrorContext;

  constructor(code: ErrorCode, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = 'PromptobusError';
    this.code = code;
    this.context = context;
  }
}

/** Short throw form: no v1 refusal has a place that needs a bare `Error`. */
export function fail(code: ErrorCode, message: string, context: ErrorContext = {}): never {
  throw new PromptobusError(code, message, context);
}

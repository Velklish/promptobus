// Typed protocol errors.
// [reference/03-cli.md#error-codes](../../docs/reference/03-cli.md#error-codes)

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
  'artifact-broken',
  'artifact-integrity',
  // disk
  'lock-busy',
  'link-refused',
  // model routing. The adapter raises these, not the core: the codes belong to
  // the CLI surface ADR-003 fixed, and they live here because the consumer
  // branches on a code from one list — a second list beside this one would be
  // a second vocabulary for the same kind of refusal. Their prose half is the
  // error-code table of [reference/04-protocol.md#typed-protocol-errors](../../docs/reference/04-protocol.md#typed-protocol-errors), and the suite reads the two
  // as one list.
  'strategy-unknown',
  'role-unknown',
  'harness-unknown',
  'catalog-invalid',
  'overlay-invalid',
  'constraint-unknown',
  'constraint-unavailable',
  'candidates-empty',
  'limit-hit-at-start',
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

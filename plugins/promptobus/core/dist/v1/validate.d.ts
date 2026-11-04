import { ERROR_CODES } from './errors.js';
import type { ErrorCode } from './errors.js';
import type { ModelName } from './model.js';
/** Validator verdict: where the refusal is and why. The code is required — the consumer branches on it. */
export interface Verdict {
    ok: boolean;
    code: ErrorCode | null;
    /** Path to the bad field: `participants[1].harness`. Empty when accepted. */
    at: string;
    note: string;
    /** Unfamiliar fields the refusal is about — a separate field, not a parse of `note`: the reader
     * tells "written by a newer mechanism" from corruption by it, and prose would drift. */
    extra: readonly string[];
}
/** Check a record against a model. A verdict, not a throw: the reader isolates the bad, it does not crash. */
export declare function validate(model: ModelName, value: unknown): Verdict;
/** The same as a throw — for writes: the bad never enters the store. */
export declare function requireValid(model: ModelName, value: unknown, context?: Record<string, unknown>): void;
export { ERROR_CODES };

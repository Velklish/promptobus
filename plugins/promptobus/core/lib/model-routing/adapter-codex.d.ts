import type { ProbeRequest } from '../../dist/index.js';
import type { AdapterVerdict } from './adapter-common.js';
import type { AvailabilityWindow } from './cache.js';
import type { CodexRateLimits } from '../codex-session.js';
interface ProbeRuntime {
    tool: string;
    env: NodeJS.ProcessEnv;
}
/** Ceiling for one `account/rateLimits/read`. The whole budget still caps it. */
export declare const LIMIT_READ_TIMEOUT_MS = 10000;
/** The limit snapshot inside whatever carried it: the request wraps it in `rateLimits`, the
 * notification carries it flat. */
export declare function rateLimitSnapshot(payload: unknown): CodexRateLimits | null;
/** A reset moment as ISO-8601; Codex names it in unix SECONDS on the request and as a string on
 * the notification. Nothing is repaired: a divided millisecond value would be an invented time. */
export declare function resetIso(value: unknown): string | null;
/** The plan this account is on, or `null`. `source` is `probe` — the harness answered — and not
 * the method it answered on; the shape gate for the name is the cache's. */
export declare function accountTier(snap: CodexRateLimits | null | undefined): {
    name: string;
    source: string;
} | null;
/** Whether the account holds spendable credits, as two booleans — or `null`. **The balance is read
 * and never carried**: a count is a fact about the account, and nothing here reads one. */
export declare function accountCredits(snap: CodexRateLimits | null | undefined): {
    available: boolean;
    unlimited: boolean;
} | null;
/** How many "full reset" credits the account may spend, or `null`. It sits at the TOP level of the
 * result, not inside `rateLimits`. **The adapter never spends one** (ADR-005). */
export declare function resetCreditCount(payload: unknown): {
    available: number;
} | null;
export declare const WINDOW_KIND_BY_ID: Record<string, string>;
export declare function windowKind(id: string, lengthSec: number | null | undefined): string;
export declare function rateLimitWindows(snap: CodexRateLimits | null | undefined): AvailabilityWindow[];
/** When the spent window comes back, or `null`. Without `rateLimitReachedType` the reached window
 * is whichever is at 100 %. A reset that is not read leaves the exhaustion sticky. */
export declare function reachedResetAt(snap: CodexRateLimits | null | undefined): string | null;
/** Whether an error says this binary lacks the method rather than refusing to answer it. Both are
 * `-32600`, so only the text can tell them apart, and the text is never carried. */
export declare function unsupportedMethod(error: {
    message?: unknown;
} | null | undefined): boolean;
/** Ask Codex about the account. The driver's launch context comes in so the probe runs under the
 * same isolated config a lift would use. Never throws: a throw loses the text with it. */
export declare function probeCodex({ toolBin: bin, timeoutMs }: ProbeRequest, { tool, env }: ProbeRuntime): Promise<AdapterVerdict>;
export {};

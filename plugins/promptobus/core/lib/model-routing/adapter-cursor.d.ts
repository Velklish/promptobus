import type { AvailabilityWindow } from './cache.js';
import type { AdapterModel, JsonResponse, RoutingAdapter, TokenRequest } from './adapter-common.js';
interface CursorDocument {
    autoBucketModels?: unknown;
    billingCycleStart?: unknown;
    billingCycleEnd?: unknown;
    displayMessage?: unknown;
    planUsage?: {
        autoPercentUsed?: unknown;
        apiPercentUsed?: unknown;
        limit?: unknown;
    };
    aggregations?: {
        tier?: unknown;
        modelIntent?: unknown;
    }[];
    thirdPartyUsageNudge?: {
        threshold?: unknown;
        targetModel?: unknown;
    };
}
interface CursorDependencies {
    readToken: (request: {
        timeoutMs: number;
    }) => Promise<{
        token: string;
        source: string;
    } | null>;
    readBackendUrl: () => Promise<string>;
    postJson: (url: string, request: TokenRequest) => Promise<JsonResponse<CursorDocument>>;
}
export declare function autoPoolModels(inventory: readonly unknown[] | null | undefined, bucket: unknown, tiered: unknown): string[];
export declare function autoTierModels(events: CursorDocument | null | undefined): Set<string>;
/** The billing cycle as ADR-005 windows: one length, two pools. `lengthSec` is the cycle the answer
 * states, not thirty days; unreadable boundaries yield no window, since a pace needs a length. */
export declare function periodWindows(usage: CursorDocument | null | undefined, inventory: readonly unknown[] | null | undefined, events: CursorDocument | null | undefined, autoModels?: string[]): AvailabilityWindow[];
/** The tier, derived, or `null`. **No Cursor method returns the plan name**, so ADR-005 makes the
 * cycle's included amount the proxy — the PLAN's cents, never the account's spend. */
export declare function derivedTier(usage: CursorDocument | null | undefined): {
    name: string;
    source: string;
} | null;
/** A line of harness text made safe for a diagnosis, or `null`: control characters out, whitespace
 * collapsed, 120 characters, and any `@` refused — an address is what the cache never holds. */
export declare function sanitizeMessage(text: unknown): string | null;
/** Cursor's own near-limit signal in this adapter's words, or `null`. The threshold and the target
 * travel; the nudge's `label` is prose written for a dialog and does not. */
export declare function nudgeNote(policy: CursorDocument | null | undefined): string | null;
/** The backend URL the CLI cached, or `null`. **Only `https:` is accepted**: a bearer token is about
 * to be sent there, and a refused value falls back to the measured default. */
export declare function backendUrlOf(text: unknown): string | null;
/** The three headers Connect wants, and no fourth. Exported so the shape can be checked without a
 * request: `connect-protocol-version` is what makes these methods answer 200 at all. */
export declare function connectHeaders(token: string): {
    authorization: string;
    'content-type': string;
    'connect-protocol-version': string;
};
/** The inventory `models` listed, with the marks it printed. */
export declare function parseModels(stdout: unknown): AdapterModel[];
/** What `status` said: `in`, `out`, or `unreadable`. **The exit code is not consulted** — it is 0
 * either way — and the negative is matched first, because "not logged in" contains "logged in". */
export declare function authState(stdout: unknown): "in" | "out" | "unreadable";
/** The adapter the driver declares; the tool name comes from the driver, so there is no second copy
 * to drift. `deps` is the seam for everything that leaves this process but the harness binary. */
export declare function cursorAvailability(tool: string, deps?: Partial<CursorDependencies>): RoutingAdapter;
export {};

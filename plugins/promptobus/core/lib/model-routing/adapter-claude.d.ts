import type { AvailabilityWindow } from './cache.js';
import type { JsonResponse, RoutingAdapter, TokenRequest } from './adapter-common.js';
type ScopeTable = Record<string, readonly string[]>;
interface ClaudeLimit {
    kind?: string;
    percent?: unknown;
    resets_at?: unknown;
    locked_reason?: unknown;
    is_active?: unknown;
    scope?: {
        model?: {
            display_name?: unknown;
        };
    };
}
interface ClaudeDocument {
    limits?: ClaudeLimit[];
    organization?: {
        rate_limit_tier?: unknown;
    };
}
interface ClaudeDependencies {
    readCredential: (request: {
        timeoutMs: number;
    }) => Promise<unknown>;
    getJson: (url: string, request: TokenRequest) => Promise<JsonResponse<ClaudeDocument>>;
    clearHint?: string;
}
/** Where the record lives on a platform whose credentials are a file. */
export declare function credentialFile(env?: Record<string, unknown> | null | undefined, home?: string): string;
/** A moment as the snapshot writes them, or `null`. The UNIT is this adapter's fact; the range
 * check and formatting are shared. A number is refused — this endpoint names moments in strings. */
export declare function stampOf(value: unknown): string | null;
/** The model ids a scope's display name resolves to, or null when it resolves to none.
 * [guides/model-routing.md#scopemodels--resolving-a-scope-display-name-to-model-ids](../../docs/guides/model-routing.md#scopemodels--resolving-a-scope-display-name-to-model-ids) */
export declare function scopeModels(displayName: unknown, table: ScopeTable | null | undefined): any[] | null;
/** Three fields of the credential record, and no fourth. The shape is the enforcement:
 * `refreshToken` is never read, so it cannot be carried into a message, a log or a cache. */
export declare function credentialRecord(text: unknown): {
    accessToken: string;
    expiresAt: number | null;
    tier: string | null;
} | null;
export declare function usageWindows(usage: ClaudeDocument | null | undefined, scopeTable?: ScopeTable | null): AvailabilityWindow[];
export declare function spentWindow(usage: ClaudeDocument | null | undefined): {
    id: string;
    resetAt: string | null;
} | null;
/** The three headers both endpoints want, and no fourth. Exported so the shape can be checked
 * without a request: it is the only place a token is written. */
export declare function oauthHeaders(token: string): {
    authorization: string;
    'anthropic-beta': string;
    accept: string;
};
/** The adapter a driver declares as `availability`.
 * [guides/model-routing.md#claudeavailability--the-adapter-a-driver-declares-as-availability](../../docs/guides/model-routing.md#claudeavailability--the-adapter-a-driver-declares-as-availability) */
export declare function claudeAvailability(inventoryOf: (version: string | null | undefined) => string[], scopeIds?: ScopeTable | null, deps?: Partial<ClaudeDependencies>): RoutingAdapter;
export {};

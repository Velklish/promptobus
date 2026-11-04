import type { PromptobusHost } from '../../dist/index.js';
type CacheHost = Pick<PromptobusHost, 'routingPaths'>;
export type WindowScope = {
    model: string;
    models?: string[];
    pool?: never;
} | {
    pool: 'auto';
    models: string[];
    model?: never;
} | {
    pool: 'api';
    models?: never;
    model?: never;
} | null;
export interface InventoryModel {
    model: string;
    rated: boolean;
    hidden?: true;
    flags?: string[];
}
export interface AvailabilityWindow {
    id: string;
    kind: string;
    lengthSec: number;
    scope: WindowScope;
    usedPercent?: number;
    estimate?: 'local-estimate';
    resetAt?: string | null;
    checkedAt?: string;
    source?: string;
}
export interface AvailabilityTier {
    name: string;
    source: string;
}
export interface SnapshotEntry {
    state: string;
    reason: string | null;
    message: string;
    checkedAt: string;
    source: string;
    resetAt: string | null;
    version?: string;
    tier?: AvailabilityTier | null;
    spendControlReached?: boolean;
    credits?: {
        available: boolean;
        unlimited: boolean;
    };
    resetCredits?: {
        available: number;
    };
    models?: InventoryModel[];
    autoPoolModels?: string[];
    poolWindowsUnbound?: true;
    inventoryCheckedAt?: string;
    inventorySource?: string;
    windows?: AvailabilityWindow[];
}
export interface SnapshotEntryInput {
    state: string;
    reason?: string | null;
    message?: unknown;
    checkedAt?: unknown;
    source: string;
    resetAt?: unknown;
    version?: unknown;
    tier?: unknown;
    spendControlReached?: unknown;
    credits?: unknown;
    resetCredits?: unknown;
    models?: unknown;
    autoPoolModels?: unknown;
    poolWindowsUnbound?: unknown;
    inventoryCheckedAt?: unknown;
    inventorySource?: unknown;
    windows?: unknown;
}
export interface SnapshotDocument {
    schemaVersion: number;
    takenAt: string;
    harnesses: Record<string, SnapshotEntry>;
}
/** Snapshot document version, pinned by the schema and its golden fixture. A document of any
 * other version is DISCARDED, never migrated (ADR-005 D): this is a cache, not a store. */
export declare const SNAPSHOT_VERSION = 2;
/** Permissions of the cache file. Availability is not a secret; what a leaky adapter might attach to it is. */
export declare const CACHE_MODE = 384;
/** Auth and model inventory. */
export declare const AUTH_TTL_MS: number;
/** Limit windows. An entry that carries any ages at this speed — it is only as fresh as its shortest fact. */
export declare const WINDOW_TTL_MS: number;
/** A probe that timed out or failed. Long enough not to hammer a broken harness, short enough to recover. */
export declare const TRANSIENT_TTL_MS: number;
/** The stamp of something never looked at: the epoch rather than a fourth `source`, because
 * this is an AGE, not a provenance — every TTL measured from it has long passed. */
export declare const NEVER_CHECKED = "1970-01-01T00:00:00.000Z";
/** Whether a value is a timestamp at all. The form is normalised by `isoStamp`; this only asks if it can be. */
export declare function isTimestamp(value: unknown): value is string;
/** ISO-8601 with milliseconds — the one timestamp form the snapshot schema accepts. */
export declare function isoStamp(value?: string | number | null | undefined): string;
/** Epoch milliseconds as the snapshot writes a moment, or `null`. The unit stays with each
 * adapter; the range check lives here once, and it never falls back to "now". */
export declare function stampAtMs(ms: number): string | null;
/** The cache file this host names. Never assembled from a home path here: the host owns the layout. */
export declare function cacheFileOf(host: CacheHost): string;
/** The lock a writer holds while it reads, merges and renames. What it prevents is a LOST
 * entry, not a corrupt file — the write is already temp-plus-rename. */
export declare const LOCK_SUFFIX = ".lock";
/** How long a writer waits for somebody else's lock before writing anyway. */
export declare const LOCK_WAIT_MS = 2000;
/** When a lock stops being somebody's and becomes litter: a holder keeps it for microseconds,
 * and waiting the full window on every later command would tax one crash forever. */
export declare const LOCK_STALE_MS = 15000;
/** Resolver deny with no overlay rule. The OpenCode adapter marks model ids with it. */
export declare const OFF_ALLOWANCE_FLAG = "off-allowance";
/** The marks a model row may carry — a CLOSED list, and the schema's `flags` enum. Closed so
 * a typo in an overlay deny cannot ban nothing silently; an unknown flag is dropped. */
export declare const MODEL_FLAGS: string[];
/** The snapshot property-name grammar, shared with the hand-written validator. */
export declare const HARNESS_RE: RegExp;
/** The window kinds ADR-005 names. A NAME, never a length: `lengthSec` is the number, and neither is derived from the other. */
export declare const WINDOW_KINDS: string[];
/** A list of model ids, deduplicated, or `null`. Exported for the telemetry record: one
 * function per schema, or the two copies drift and the quieter one stops deduplicating. */
export declare function modelList(raw: unknown): string[] | null;
export declare function scopeOf(value: unknown): WindowScope | undefined;
/** Where a tier name may have come from. A closed list, so a fifth spelling never reaches disk. */
export declare const TIER_SOURCES: string[];
/** A tier name has the shape of a CODE, not of prose. A gate, not tidiness: it is the second
 * string an adapter writes to disk, and this file exists to stay clean. */
export declare const TIER_NAME_RE: RegExp;
export declare function snapshotEntry(entry: SnapshotEntryInput): SnapshotEntry;
/** The stored snapshot, or `null`. An unreadable file and a document of another `schemaVersion`
 * are both none; the version is checked HERE because this is the one door into the file. */
export declare function readSnapshot(host: CacheHost): SnapshotDocument | null;
/** The `schemaVersion` at the cache path that this build does NOT read, or `null`. It exists
 * so one word of a diagnosis can tell a first run from an upgrade that discarded everything. */
export declare function staleVersionAt(host: CacheHost): number | null;
/** Whether an exhaustion is the sticky kind: confirmably spent with no known reset. Neither
 * time nor a later probe clears it — `--clear-exhausted` is the only door. */
export declare function stickyExhaustion(entry: Pick<SnapshotEntry, 'state' | 'resetAt'> | null | undefined): boolean;
/** When an entry stops being usable. The cascade reads top to bottom and the first match wins;
 * the tier needs no line of its own, since it ages with auth and inventory. */
export declare function entryExpiry(entry: Pick<SnapshotEntry, 'state' | 'resetAt' | 'checkedAt' | 'reason' | 'windows'>): number;
/** When an entry's limit windows ran out, as a stamp, or `null` when the cascade aged it by another line. */
export declare function windowsExpiry(entry: SnapshotEntry | null | undefined): string | null;
/** Whether the entry may still be used at that moment. */
export declare function entryLive(entry: SnapshotEntry, at?: number): boolean;
/** Entries reused without asking the harness. `refresh` drops every live one except a sticky
 * exhaustion; a reused entry says `source: 'cache'` whatever first wrote it. */
export declare function heldOf(doc: SnapshotDocument | null | undefined, { refresh, recheckTimedExhaustion, at }?: {
    at?: number | undefined;
    recheckTimedExhaustion?: boolean | undefined;
    refresh?: boolean | undefined;
}): Record<string, SnapshotEntry>;
/** Merge entries into the stored snapshot and write it. Merge, not replace: the late-start
 * hook writes ONE harness. `dryRun` makes the whole call a no-op in both modes. */
export declare function writeEntries(host: CacheHost, entries: Record<string, SnapshotEntryInput>, { at, dryRun }?: {
    at?: number | undefined;
    dryRun?: boolean | undefined;
}): {
    doc: null;
    dropped: string[];
    contended: boolean;
} | {
    doc: {
        schemaVersion: number;
        takenAt: string;
        harnesses: {
            [x: string]: SnapshotEntry;
        };
    };
    dropped: string[];
    contended: boolean;
} | null;
/** Drop a sticky exhaustion — the `--clear-exhausted` library half. Only the sticky kind, and
 * the entry is removed rather than rewritten: nothing is known about that harness after. */
export declare function clearExhausted(host: CacheHost, harness: string, { dryRun }?: {
    dryRun?: boolean | undefined;
}): boolean;
export declare function markExhausted(host: CacheHost, harness: string, { resetAt, reason, message, at, dryRun, }?: {
    resetAt?: string | null;
    reason?: string | null;
    message?: string | null;
    at?: number;
    dryRun?: boolean;
}): SnapshotEntry;
export {};

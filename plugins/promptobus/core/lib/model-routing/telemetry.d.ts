import type { ParticipantV1, PromptobusHost, TaskV1, TelemetryRecord, TelemetryWindow } from '../../dist/index.js';
import type { SnapshotDocument } from './cache.js';
type UnknownRecord = Record<string, unknown>;
interface ThroughputObservation {
    outputTokens: number | null;
    generationDurationSec: number | null;
    tokensPerSecond: number | null;
}
interface TokenBounds {
    from: number | null;
    until: number | null;
}
interface Tally {
    turns: number;
    reviewRounds: number;
    questions: number;
    resultCount: number;
    lastResultAt: string | null;
}
interface TelemetryOptions {
    at?: number;
    snapshot?: SnapshotDocument | null;
    throughput?: Map<string, ThroughputObservation> | null;
}
interface CollectedRecord extends TelemetryRecord {
    schemaVersion: number;
    recordedAt: string;
    step: string;
    effort: string | null;
    tuple: string | null;
    strategy: string | null;
    strategySource: string | null;
    spawnedAt: string | null;
    lastResultAt: string | null;
    endedAt: string;
    throughput: ThroughputObservation | null;
    idleSamples: number;
    deliverySamples: number;
    windows: TelemetryWindow[];
    concurrentParticipants: number | null;
    dismissedBeforeDone: boolean;
}
export { telemetrySummary } from '../../dist/index.js';
/** Record version, additive-only from here on: a reader that had to migrate history would be a
 * reason to throw history away, which a file collected from the first day must not do. */
export declare const TELEMETRY_VERSION = 1;
/** Permissions of the telemetry file. The cache's, for the cache's reason: it is the account's. */
export declare const TELEMETRY_MODE = 384;
/** File name, beside the cache the host names. The host owns the directory; this owns the leaf. */
export declare const TELEMETRY_FILE = "telemetry.jsonl";
/** A participant's throughput observation in the closed telemetry shape, or `null`. A partial
 * event is kept as partial evidence; missing evidence is `null`, never zero. */
export declare function throughputObservationOf(raw: unknown): ThroughputObservation | null;
/** A usable tokens/second observation, derived from the pair when necessary. */
export declare function throughputRate(raw: unknown): number | null;
/** Permissions of the per-participant throughput evidence sidecar. */
export declare const THROUGHPUT_SIDECAR_MODE = 384;
/** File beside the guard mark where a turn appends its harness evidence. */
export declare function throughputSidecarFile(home: string, task: string, address: string): string;
/** Append one normalised, per-turn observation without taking the task lock: this is one turn's
 * observation, not a completion duration. A refusal to write is left to the caller. */
export declare function appendThroughputObservation(home: string, task: string, address: string, raw: unknown): boolean;
/** Clear a participant's old turn evidence when its journal record is replaced by a new lift. */
export declare function clearThroughputSidecar(home: string, task: string, address: string): boolean;
/** Project one participant's sidecar into run totals and a direct-rate mean. A tokens-and-
 * duration pair wins where one observation carries both; otherwise a token-weighted mean. */
export declare function readThroughputSidecar(home: string, task: string, address: string): {
    outputTokens: number | null;
    generationDurationSec: number | null;
    tokensPerSecond: number | null;
} | null;
/** Read each participant sidecar once while projecting a task at `done`. */
export declare function readThroughputSidecars(home: string, meta: TaskV1): Map<string, ThroughputObservation>;
export declare function sessionLogOf(host: PromptobusHost, home: string, task: string, participant: ParticipantV1): {
    sessionId: string;
    path: string;
} | null;
export declare function tokenLogHistoryOf(host: PromptobusHost, home: string, task: string, participant: ParticipantV1 | null | undefined): {
    sessionId: string | null;
    path: string | null;
}[];
/** The telemetry file this host names, assembled from `routingPaths().cacheFile`: the two are
 * the same account's, and a split would leave one account's telemetry beside another's. */
export declare function telemetryFileOf(host: Pick<PromptobusHost, 'routingPaths'>): string;
/** The opaque local key of a task: SHA-256 truncated to sixteen hex characters, unsalted so
 * grouping holds across installs. What it buys is that the slug a person typed is not in the file. */
export declare function taskHash(id: unknown): string;
/** Which spawn-window readings are missing, and whether the reason is harness-wide: a fresh
 * entry reports each id, an absent, stale or held one cannot distinguish its windows. */
export declare function endReadingStatus(host: PromptobusHost, harness: string, windowIds: readonly string[], at: number, snapshot?: SnapshotDocument | null): {
    missing: string[];
    reason: string | null;
    harness: boolean;
};
/** Message counts per participant, from the CANONICAL messages and not `history/`, which holds
 * only what a mailbox fetched. Only the envelope is read — `body` never leaves this function. */
export declare function tallies(home: string, id: string, window?: Partial<TokenBounds> | null): Map<string, Tally>;
/** Recorded harnesses whose rows carry windows and can therefore have an end reading. */
export declare function telemetryWindowHarnesses(meta: TaskV1 | null | undefined): string[];
/** Spawn-window ids recorded for one harness, in their first-seen order. */
export declare function telemetryWindowIds(meta: TaskV1 | null | undefined, harness: string): string[];
/** Counting bounds of closed generation `index`. The lower bound is the previous entry's `until`,
 * or none for the first. The entry's own `from` is its last lift, not this bound. */
export declare function historyCountWindow(history: readonly {
    until?: string;
}[], index: number): {
    from: number | null;
    until: number | null;
};
/** The records this task's participants leave behind, in journal order; an unrouted `--model`
 * pick gets one too. Every field is copied BY NAME — a spread would carry `metadata` out. */
export declare function telemetryRecords(host: PromptobusHost, home: string, meta: TaskV1, { at, snapshot, throughput, }?: TelemetryOptions): CollectedRecord[];
/** Append this task's records and say how many landed. One write for the whole task, or a `done`
 * interrupted between participants leaves half a run. `mode` is re-set after umask cuts it. */
export declare function appendTelemetry(host: PromptobusHost, home: string, meta: TaskV1, { at, snapshot, throughput, }?: TelemetryOptions): {
    file: string;
    written: number;
};
/** Every record the file holds, in append order. A line that does not parse is SKIPPED, not
 * raised on: a truncated last line must not throw away a person's whole history. */
export declare function readTelemetry(host: Pick<PromptobusHost, 'routingPaths'>): {
    file: string;
    records: UnknownRecord[];
    skipped: number;
};
/** The one line `models` prints: count and size only; role summary is in `telemetryStats`. */
export declare function telemetryLine(host: PromptobusHost): string;
export declare function telemetryStats(host: PromptobusHost): {
    note?: undefined;
    file: string;
    records: number;
    bytes: number;
    unreadable: boolean;
    summary?: import("../../dist/telemetry.js").TelemetryRunSummary[] | undefined;
} | {
    file: string;
    records: null;
    bytes: null;
    unreadable: boolean;
    note: string;
} | null;

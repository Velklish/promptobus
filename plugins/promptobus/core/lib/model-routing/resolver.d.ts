import type { AvailabilityWindow, SnapshotDocument, SnapshotEntry, WindowScope } from './cache.js';
import type { CatalogTuple, RoutingPolicy, RoutingSources } from './catalog.js';
import type { AdapterModel } from './adapter-common.js';
type Entry = Omit<Partial<SnapshotEntry>, 'models'> & {
    models?: AdapterModel[];
};
interface Constraints {
    harness?: string | null;
    model?: string | null;
    effort?: string | null;
    allowPayg?: boolean;
}
interface Warning {
    code: string;
    message: string;
    harness?: string;
    usedPercent?: number;
}
interface ResolverPolicy {
    policy: RoutingPolicy;
    sources: RoutingSources;
    tuples?: CatalogTuple[];
    warnings?: Warning[];
    layers?: {
        id: string;
        path?: string;
        present?: boolean;
    }[];
}
interface Exclusion {
    code: string;
    detail: string;
    usedPercent?: number;
    pool?: 'auto' | 'api';
}
interface Score {
    total: number;
    base: number;
    components: Record<string, number>;
    adjustments: {
        code: string;
        points: number;
    }[];
}
interface PaceWindow {
    id: string;
    kind: string;
    scope: WindowScope;
}
interface PaceMarks {
    atCap?: true;
    representative?: true;
}
interface Unpaced extends PaceMarks {
    window: PaceWindow | null;
    usedShare: number | null;
    elapsedShare: null;
    underspend: null;
    spendPenalty: null;
    effective: null;
    eligible: false;
    note: string;
}
interface Paced extends PaceMarks {
    window: PaceWindow;
    usedShare: number;
    elapsedShare: number;
    underspend: number;
    spendPenalty: number;
    effective: number;
    eligible: true;
    note: null;
}
type Pace = Unpaced | Paced;
interface ResolveRequest {
    role?: string;
    step?: string;
    qualityFloor?: number | null;
    strategy?: string;
    constraints?: Constraints;
    policy?: ResolverPolicy | null;
    snapshot?: SnapshotDocument | null;
    liveParticipants?: {
        role?: string;
        harness?: string;
        model?: string;
    }[];
    strategyCommands?: Record<string, string>;
    expiredWindows?: Record<string, string>;
    now?: number;
}
/** Identity alias for the canonical routed-role list, kept for callers of this module. */
export declare const ROLES: readonly ("approver" | "reviewer" | "worker")[];
/** `schemaVersion` of the document produced here. Two since ADR-005: a fifth `strategy` value,
 * a `pace` block, two warning codes and `strategySource` all arrive together. */
export declare const DECISION_SCHEMA_VERSION = 2;
/** What `remaining` counts as when it cannot be read. ADR-005 fixes 50 % with the
 * `unknown-availability` adjustment — penalised, never blocking. Not a policy value. */
export declare const NEUTRAL_REMAINING_PERCENT = 50;
export declare const DECISION_WARNINGS: string[];
/** Exclusion codes a candidate may carry, kept together for schema parity. */
export declare const EXCLUSION_CODES: string[];
/** Ratings for the role being routed: the tuple's own, with its role override on top. */
export declare function ratingsFor(tuple: CatalogTuple, role: string): {
    [x: string]: number;
};
/** The windows that apply to one tuple: the account-wide ones plus the scope covering it.
 * Exported because a lift records the same set, and two definitions would measure two things. */
export declare function applicableWindows(entry: Entry, model: string | undefined): AvailabilityWindow[];
export declare function poolOf(entry: Entry | null | undefined, model: string | undefined, harness: string): "api" | "auto" | null;
/** The lists in force for a step, applied to every spelling of a lift whose `--model` no tuple names.
 * `flags` are the marks of the model's snapshot row. */
export declare function unratedExclusion({ harness, models, effort, flags, pool, }: {
    harness: string;
    models: string[];
    effort?: string | null;
    flags?: string[];
    pool?: string | null;
}, policy: Pick<ResolverPolicy, 'policy' | 'sources'>, role: string, step?: string): Exclusion | null;
/** One decision. Pure: `now` is the clock in milliseconds, and nothing here may read one of its
 * own — it produces `snapshot.ageSec` and, under `balance`, `elapsedShare`. */
export declare function resolve({ role, step, qualityFloor, strategy, constraints, policy, snapshot, liveParticipants, strategyCommands, expiredWindows, now, }?: ResolveRequest): {
    schemaVersion: number;
    strategy: string | undefined;
    role: string | undefined;
    step: string | undefined;
    qualityFloor: number;
    weights: {
        [x: string]: number;
    };
    balance?: {
        band: number;
        spendUnit: number;
    } | undefined;
    chosen: {
        tupleId: string;
        harness: string;
        model: string;
        effort: string | null;
    } | null;
    candidates: {
        tupleId: string;
        harness: string;
        model: string;
        effort: string | null;
        availability: {
            state: string;
            reason: string | null;
            checkedAt: string;
            source: string;
        };
        score: Score | null;
        pace?: Pace | undefined;
        excluded: Exclusion | null;
        chosen: boolean;
    }[];
    runtime: {
        harness: string;
        model: string;
        flags?: string[];
    }[];
    warnings: {
        code: string;
        message: string;
    }[];
    constraints: {
        harness: string | null;
        model: string | null;
        effort: string | null;
        allowPayg: boolean;
        applied: boolean;
    };
    overlays: {
        id: string;
        path: string | undefined;
        applied: boolean;
    }[];
    snapshot: {
        takenAt: string;
        ageSec: number;
        source: string;
        harnesses: {
            harness: string;
            availability: {
                checkedAt: string;
                ageSec: number;
                source: string;
            };
            inventory: {
                checkedAt: string;
                ageSec: number;
                source: string;
            } | null;
            windows: {
                checkedAt: string;
                ageSec: number;
                source: string;
                id: string;
            }[];
        }[];
    };
};
export {};

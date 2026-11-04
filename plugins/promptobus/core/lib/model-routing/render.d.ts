import type { AvailabilityTier, AvailabilityWindow } from './cache.js';
interface TupleDescription {
    harness: string;
    model: string;
    effort?: string | null;
}
interface Pace {
    window?: Pick<AvailabilityWindow, 'id' | 'kind' | 'scope'> | null;
    eligible: boolean;
    representative?: boolean;
    note?: string | null;
    usedShare?: number | null;
    elapsedShare?: number | null;
    underspend?: number | null;
    spendPenalty?: number | null;
    effective?: number | null;
    atCap?: boolean;
}
interface Candidate extends TupleDescription {
    tupleId: string;
    chosen: boolean;
    availability: {
        state: string;
    };
    score?: {
        total: number;
        adjustments: {
            points: number;
            code: string;
        }[];
    } | null;
    excluded?: {
        code: string;
        detail: string;
    } | null;
    pace?: Pace | null;
}
interface RuntimeModel extends TupleDescription {
    flags?: string[];
}
interface AgeRecord {
    ageSec: number;
    source: string;
    checkedAt: string;
}
interface HarnessAvailability {
    harness: string;
    state: string;
    tier?: AvailabilityTier | null;
    plan?: {
        name: unknown;
        source: string;
    } | null;
    capacity?: Record<string, {
        value: number;
        source: string;
    }>;
    credits?: {
        available: boolean;
        unlimited: boolean;
    };
    resetCredits?: {
        available: number;
    };
    poolWindowsUnbound?: boolean;
    windows?: AvailabilityWindow[];
}
export interface RoutingDecision {
    strategy: string;
    role: string;
    step?: string;
    qualityFloor?: number;
    candidates: Candidate[];
    runtime: RuntimeModel[];
    warnings: {
        code: string;
        message: string;
    }[];
    overlays: {
        id: string;
        applied: boolean;
    }[];
    chosen?: (TupleDescription & {
        tupleId: string;
    }) | null;
    snapshot: {
        takenAt: string;
        ageSec: number;
        source: string;
        harnesses?: {
            harness: string;
            availability: AgeRecord;
            inventory?: AgeRecord | null;
            windows: (AgeRecord & {
                id: string;
            })[];
        }[];
    };
    balance?: {
        band: number;
        spendUnit: number;
    };
    harnesses?: HarnessAvailability[];
}
/** The fields this renderer reads. `chosen` is not among them: `null` there is the empty-candidate case. */
/** Unrated rows the text form prints per harness before it counts the rest. */
export declare const RUNTIME_ROWS_PER_HARNESS = 8;
/** A decision as the terminal shows it. Blocks that carry nothing are left out: a `warnings:`
 * heading with nothing under it reads as a warning that failed to print. */
export declare function render(decision: RoutingDecision | null | undefined): string;
export {};

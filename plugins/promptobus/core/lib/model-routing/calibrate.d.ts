import type { CatalogTuple } from './catalog.js';
type AliasDictionary = Record<string, Record<string, readonly string[]> | null | undefined>;
interface ModelKey {
    harness: string;
    model: string;
}
interface EffortKey extends ModelKey {
    effort: string | null;
}
interface Ratings {
    quality: number;
    speed: number;
    quotaCost: number;
}
interface RatingProposal {
    band: number | null;
    why: string | null;
    move?: number;
    ratio?: number;
    implied?: number;
    surprise?: number;
    pivot?: boolean;
}
interface KeyProposal {
    pivot: boolean;
    speed: RatingProposal | null;
    speedPivot: boolean;
    quotaCost: RatingProposal | null;
}
interface CalibrationKey extends EffortKey {
    aliasesSeen: string[];
    tuple: string | null;
    runs: number;
    steps: {
        step: string;
        role: string;
        runs: number;
        acceptedPieces: number;
    }[];
    acceptedPieces: number;
    dismissed: number;
    withoutWindows: number;
    durationSec: number | null;
    durationSamples: number;
    throughput: number | null;
    throughputSamples: number;
    turns: number | null;
    reviewRounds: number | null;
    windowDelta: number | null;
    windowSamples: number;
    catalog: Ratings | null;
    override: Partial<Ratings> | null;
    overrideSources: Partial<Record<keyof Ratings, string>> | null;
    eligible: boolean;
    note: string | null;
    proposal: KeyProposal | null;
}
interface CalibrationOptions {
    tuples?: CatalogTuple[];
    overlayTuples?: CatalogTuple[] | null;
    overlaySources?: Record<string, Record<string, string>> | null;
    aliases?: AliasDictionary | null;
    threshold?: number;
}
/** Runs per key before anything is proposed. A constant of ADR-005, deliberately not an
 * overlay key: an evidence threshold a person could lower stops being evidence. */
export declare const EVIDENCE_THRESHOLD = 5;
/** What one band of difference is worth as a ratio; ADR-005 fixes 1.25. A stated convention,
 * not a measurement — which is why nothing proposes a band from a ratio alone. */
export declare const BAND_RATIO = 1.25;
/** A measured ratio this far from the one the bands imply moves one band. */
export declare const SURPRISE_ONE = 1.5;
/** …and this far moves two, which is also the cap. */
export declare const SURPRISE_TWO = 3;
/** Bands one run of `calibrate` may move a rating, in either direction. */
export declare const MAX_MOVE = 2;
/** Median of a sample, `null` when there is none. The even case takes the mean of the two
 * middle values; a `.5` in a count is read as what it is — a sample of two that disagrees. */
export declare function median(values: readonly unknown[]): number | null;
/** A record's one window number: the LARGEST delta among the windows that applied, not their
 * sum — the resolver scores on the same set. An absent end reading or a negative delta drops. */
export declare function windowDelta(record: unknown): number | null;
/** An ACCEPTED PIECE (ADR-005): not dismissed before `done`, and at least one result sent.
 * Only these enter duration, turn and review-round medians; throughput uses every record. */
export declare function acceptedPiece(record: unknown): boolean;
/** The model id a key is on, through the DRIVER's alias dictionary and keyed BY HARNESS: a
 * name is an alias only where it is published ([guides/model-routing.md](../../docs/guides/model-routing.md)). */
export declare function resolveModel(harness: string, model: string, aliases?: AliasDictionary | null): {
    model: string;
    alias: null;
} | {
    model: any;
    alias: string;
};
/** How many bands a measured ratio moves a rating, before clamping. `surprise` is 1 when the
 * catalog already said this; the scale is symmetric multiplicatively, since neutral is one. */
export declare function moveFor(surprise: number): number;
/** Group the records, compare them with the catalog, and propose. Pure: nothing is read from
 * disk and nothing written — `--write` is the command's, and it acts on `ratings` alone. */
export declare function calibrate(records?: unknown, { tuples, overlayTuples, overlaySources, aliases, threshold, }?: CalibrationOptions): {
    threshold: number;
    records: number;
    keys: CalibrationKey[];
    pivot: {
        harness: string;
        model: string;
        effort: string | null;
        tuple: string | null;
        runs: number;
    } | null;
    speedPivot: {
        harness: string;
        model: string;
        runs: number;
        throughput: number | null;
        throughputSamples: number;
    } | null;
    speedModels: {
        harness: string;
        model: string;
        runs: number;
        throughput: number | null;
        throughputSamples: number;
    }[];
    ratings: Record<string, Partial<Ratings>>;
};
/** The text `models calibrate` prints. The overlay lines come last and together, because that
 * is the shape a person pastes — and the same lines are what `--write` merges. */
export declare function renderCalibration(report: ReturnType<typeof calibrate>): string;
export {};

import { PromptobusError } from '../dist/index.js';
import { loadCatalog } from './model-routing/catalog.js';
import { preflight } from './model-routing/preflight.js';
import { resolve } from './model-routing/resolver.js';
import type { CatalogTuple } from './model-routing/catalog.js';
import type { SnapshotDocument, SnapshotEntry } from './model-routing/cache.js';
import type { PromptobusHost, TaskV1, RoleRegistry } from '../dist/index.js';
type MergedCatalog = ReturnType<typeof loadCatalog>;
type Constraints = {
    harness?: string | null;
    model?: string | null;
    effort?: string | null;
    allowPayg?: boolean;
};
type ResolverRequest = NonNullable<Parameters<typeof resolve>[0]>;
type ModelDecision = Omit<ReturnType<typeof resolve>, 'strategy' | 'role' | 'warnings'> & {
    strategy: string;
    role: string;
    strategySource?: string;
    warnings: (ReturnType<typeof resolve>['warnings'][number] & {
        harness?: string;
        usedPercent?: number;
    })[];
};
interface RoutingOptions extends Constraints {
    strategy?: string | null;
    role?: string;
    refresh?: boolean;
    dryRun?: boolean;
    recheckTimedExhaustion?: boolean;
    strategySource?: string | null;
    catalogFile?: string;
    adapterFor?: Parameters<typeof preflight>[0]['adapterFor'];
    now?: number;
    permitEmptyCandidates?: boolean;
    liftUnrated?: boolean;
}
type RoutingContext = NonNullable<Awaited<ReturnType<typeof routingContext>>>;
interface LiftOptions extends RoutingOptions {
    taskMeta?: Pick<TaskV1, 'participants'> | null;
    address?: string | null;
}
interface CommandOutput {
    write: (text: string) => unknown;
}
interface ModelsOptions extends RoutingOptions {
    noProbe?: boolean;
    json?: boolean;
    clearExhausted?: string | null;
    subcommand?: string | null;
    set?: string | null;
    clear?: boolean;
    write?: boolean;
    yes?: boolean;
    ask?: (question: string) => unknown | Promise<unknown>;
    stdin?: {
        isTTY?: boolean;
    } | null;
    output?: CommandOutput;
}
interface AvailabilityRow extends Pick<SnapshotEntry, 'state' | 'reason' | 'checkedAt' | 'source'>, Partial<Pick<SnapshotEntry, 'tier' | 'spendControlReached' | 'credits' | 'resetCredits' | 'poolWindowsUnbound' | 'windows'>> {
    harness: string;
    plan?: {
        name: unknown;
        source: string;
    } | null;
    capacity?: Record<string, {
        value: number;
        source: string;
    }>;
}
/** Strategy of a `models` call that names none: `balanced`, ADR-005's middle weight set — the
 * answer with no thumb on any scale. `spawn` and `review` have no default and route nothing. */
export declare const DEFAULT_STRATEGY = "balanced";
/** Role a `models` call that names none is answered for. */
export declare const DEFAULT_ROLE = "worker";
/** Everything a routed call needs, with the harnesses already asked, or `null` for an unrated lift. The
 * resolver is a FUNCTION: the participants are known only inside a plan, where nothing awaits. */
export declare function routingContext(rootOrHost: unknown, { strategy, role, harness, model, effort, allowPayg, refresh, dryRun, recheckTimedExhaustion, strategySource, catalogFile, adapterFor, now, permitEmptyCandidates, liftUnrated, }?: RoutingOptions): Promise<{
    host: PromptobusHost;
    registry: RoleRegistry;
    policy: {
        schemaVersion: number;
        updated: string | undefined;
        tuples: CatalogTuple[];
        policy: Readonly<import("./model-routing/catalog.js").RoutingPolicy>;
        sources: import("./model-routing/catalog.js").RoutingSources;
        constraints: {
            harness: {} | null;
            model: {} | null;
            effort: {} | null;
        } | null;
        appliedOverlays: string[];
        warnings: ({
            code: string;
            message: string;
            tupleId: string;
            assessedAt: string | undefined;
            ageDays: number;
            staleAfterDays: number;
        } | {
            code: string;
            message: string;
            tupleId: string;
            validUntil: string;
            promotionalFigure: unknown;
            listFigure: unknown;
            listBand: unknown;
        })[];
        layers: {
            id: string;
            path: string;
            present: boolean;
        }[];
    };
    snapshot: {
        schemaVersion: number;
        takenAt: string;
        harnesses: Record<string, SnapshotEntry>;
    };
    constraints: {
        harness: string | null;
        model: string | null;
        effort: string | null;
        allowPayg: boolean;
    };
    strategyCommands: {
        [k: string]: string;
    };
    decide: (liveParticipants?: ResolverRequest['liveParticipants']) => ModelDecision;
} | null>;
/** The refusal a decision with no pick becomes. The rendered decision travels INSIDE the message:
 * a plan prints nothing, and the diagnostics a person needs are the lines `models` shows. */
export declare function noCandidate(decision: ModelDecision): PromptobusError;
/** The decision as it is kept on the participant — compact on purpose.
 * [guides/model-routing.md#routingmetadata--the-decision-as-it-is-kept-on-the-participant](../docs/guides/model-routing.md#routingmetadata--the-decision-as-it-is-kept-on-the-participant) */
export declare function routingMetadata(decision: ModelDecision, snapshot?: SnapshotDocument | null): {
    strategy: string;
    role: string;
    step: string | undefined;
    qualityFloor: number;
    tupleId: string;
    harness: string;
    model: string;
    effort: string | null;
    score: number | null;
    strategySource?: string | undefined;
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
    windows: {
        id: string;
        kind: string;
        scope: {
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
        usedPercent: number | undefined;
    }[];
    warnings: string[];
    nearLimit?: {
        harness: string | undefined;
        usedPercent: number | undefined;
    }[] | undefined;
    nearlySpent?: {
        harness: string;
        pool?: string;
        usedPercent: number;
    }[] | undefined;
    constraints: {
        harness: string | null;
        model: string | null;
        effort: string | null;
        allowPayg: boolean;
        applied: boolean;
    };
};
/** Participants already up, as the resolver wants them. Three kinds are left out: the orchestrator
 * (no harness of its own), a record with no model, and a dismissed one. `exclude` is the restart. */
export declare function liveTuples(taskMeta: Pick<TaskV1, 'participants'> | null | undefined, { exclude, registry }?: {
    exclude?: string | null;
    registry?: RoleRegistry | null;
}): {
    harness: string;
    model: string;
    role: string;
}[];
/** The pick, from a context already built and the task the lift joins. Synchronous on purpose —
 * `planReview` is called as a pure function by the suite and may not await. */
export declare function decideLift(ctx: RoutingContext | null, { taskMeta, address }?: Pick<LiftOptions, 'taskMeta' | 'address'>): {
    decision: ModelDecision;
    harness: string;
    model: string;
    effort: string | null;
    metadata: {
        strategy: string;
        role: string;
        step: string | undefined;
        qualityFloor: number;
        tupleId: string;
        harness: string;
        model: string;
        effort: string | null;
        score: number | null;
        strategySource?: string | undefined;
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
        windows: {
            id: string;
            kind: string;
            scope: {
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
            usedPercent: number | undefined;
        }[];
        warnings: string[];
        nearLimit?: {
            harness: string | undefined;
            usedPercent: number | undefined;
        }[] | undefined;
        nearlySpent?: {
            harness: string;
            pool?: string;
            usedPercent: number;
        }[] | undefined;
        constraints: {
            harness: string | null;
            model: string | null;
            effort: string | null;
            allowPayg: boolean;
            applied: boolean;
        };
    };
} | null;
/** The routing half of a lift in one call, or `null` when it routes nothing — the whole legacy
 * path. The check lives here: two copies would drift, and the drifted one would ask the host. */
export declare function routeLift(rootOrHost: unknown, { role, strategy, harness, model, effort, allowPayg, refresh, dryRun, taskMeta, address, catalogFile, adapterFor, now, }?: LiftOptions): Promise<{
    decision: ModelDecision;
    harness: string;
    model: string;
    effort: string | null;
    metadata: {
        strategy: string;
        role: string;
        step: string | undefined;
        qualityFloor: number;
        tupleId: string;
        harness: string;
        model: string;
        effort: string | null;
        score: number | null;
        strategySource?: string | undefined;
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
        windows: {
            id: string;
            kind: string;
            scope: {
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
            usedPercent: number | undefined;
        }[];
        warnings: string[];
        nearLimit?: {
            harness: string | undefined;
            usedPercent: number | undefined;
        }[] | undefined;
        nearlySpent?: {
            harness: string;
            pool?: string;
            usedPercent: number;
        }[] | undefined;
        constraints: {
            harness: string | null;
            model: string | null;
            effort: string | null;
            allowPayg: boolean;
            applied: boolean;
        };
    };
} | null>;
/** One line about a routed participant: strategy, tuple, snapshot age, warnings. Each `near-limit` and
 * each harness that left selection is named with its percentage; an older record prints bare codes. */
export declare function routingLine(raw: Record<string, unknown> | ReturnType<typeof routingMetadata> | null | undefined): string | null;
/** The decision inside a `--dry-run` plan, rendered rather than summarised: a dry run is where a
 * person checks the pick before paying for it, and a one-line summary hides the losers. */
export declare function sayDecision(decision: ModelDecision): void;
/** The strategy a routed call will use, and where it came from: `--strategy`, then the merged
 * default, then `null` — the legacy path. Reading it costs the overlay files and nothing else. */
export declare function effectiveStrategy(host: PromptobusHost, { strategy, catalogFile, now }?: Pick<RoutingOptions, 'strategy' | 'catalogFile' | 'now'>): {
    strategy: string;
    source: string;
} | null;
/** What the resolver would pick right now, with the availability facts attached.
 * [guides/model-routing.md#availabilityof--the-decision-with-the-availability-facts-it-was-made-on-attached](../docs/guides/model-routing.md#availabilityof--the-decision-with-the-availability-facts-it-was-made-on-attached) */
export declare function availabilityOf(snapshot: SnapshotDocument | null | undefined, policy?: MergedCatalog | null): AvailabilityRow[];
export declare function models(rootOrHost: unknown, { strategy, role, refresh, noProbe, json, clearExhausted: clearHarness, subcommand, set: setStrategy, clear: clearStrategy, write, yes, ask, stdin, catalogFile, adapterFor, now, output, }?: ModelsOptions): Promise<number>;
export {};

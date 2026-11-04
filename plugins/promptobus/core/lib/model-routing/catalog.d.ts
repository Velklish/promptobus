import type { PromptobusHost } from '../../dist/index.js';
type SelectorKind = 'harnesses' | 'models' | 'efforts' | 'tuples' | 'flags' | 'pools';
type SelectorMap = Partial<Record<SelectorKind, string[]>>;
interface RoleRules {
    allow: SelectorMap;
    deny: SelectorMap;
}
interface AccountPolicy {
    capacity?: Record<string, number>;
    denySuffixes?: string[];
    [key: string]: unknown;
}
export interface RoutingPolicy {
    weights: Record<string, Record<string, number>>;
    penalties: Record<string, number>;
    bonuses: Record<string, number>;
    caps: Record<string, Record<string, number>>;
    qualityFloor: Record<string, number>;
    balance: Record<string, number>;
    nearLimit: Record<string, number>;
    defaults: Record<string, string>;
    account: Record<string, AccountPolicy>;
    allow: SelectorMap;
    deny: SelectorMap;
    byRole: Record<string, RoleRules>;
    payg: {
        allow: boolean;
    };
}
export interface CatalogTuple {
    id: string;
    harness: string;
    model: string;
    effort?: string | null;
    ratings: Record<string, number>;
    priority?: number;
    assessedAt?: string;
    evidence?: {
        sources?: {
            rating?: string;
            validUntil?: string;
            figure?: unknown;
            listFigure?: unknown;
            listBand?: unknown;
        }[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
interface CatalogDocument {
    schemaVersion: number;
    updated?: string;
    tuples?: CatalogTuple[];
}
interface RoutingLayerIdentity {
    kind: string;
    id: string;
}
interface RoutingLayer {
    id: string;
    path?: string;
    present: boolean;
    data: unknown;
}
interface RoutingRule {
    layer: string;
    rule: 'allow' | 'deny';
    role: string | null;
    kind: SelectorKind;
    names: string[];
}
export interface RoutingSources {
    weights: Record<string, string>;
    rules: RoutingRule[];
    defaults: Record<string, string>;
    account: Record<string, string>;
    ratings: Record<string, Record<string, string>>;
    priority: Record<string, string>;
    floorAlias: string[];
}
interface RoutingConstraints {
    harness?: string | null;
    model?: string | null;
    effort?: string | null;
    allowPayg?: boolean;
}
type RoutingHost = Pick<PromptobusHost, 'routingPaths'>;
/** Shipped catalog. `models/` is in `files`, so this path exists in the tarball too. */
export declare const CATALOG_FILE: string;
export declare const CATALOG_SCHEMA_VERSION = 2;
export declare const OVERLAY_SCHEMA_VERSION = 2;
/** Overlay keys whose VALUES are on the rating scale, and which ADR-005 therefore refuses in a
 * v1 file — [guides/model-routing.md](../../docs/guides/model-routing.md#the-overlay-to-copy). */
export declare const SCALED_OVERLAY_KEYS: readonly string[];
/** The one runtime list of participant roles that model routing supports: the catalog roles of the step kinds. */
export declare const ROUTED_ROLES: readonly ("approver" | "reviewer" | "worker")[];
/** Kept as an identity alias for callers of the catalog's older name. */
export declare const RULE_ROLES: readonly ("approver" | "reviewer" | "worker")[];
/** Return whether a participant role belongs to the routing contract. */
export declare const isRoutedRole: (role: string) => boolean;
/** Age at which a rating starts producing a `stale-rating` warning; never an exclusion.
 * [guides/model-routing.md](../../docs/guides/model-routing.md#staleness) */
export declare const STALE_RATING_DAYS = 90;
/** Policy defaults, every number from ADR-005. The resolver reads them through the merged policy
 * and never from a literal of its own — that is what lets an overlay change them. */
export declare const DEFAULT_POLICY: Readonly<RoutingPolicy>;
/** The strategy names `--strategy` accepts; `auto` is a skill decision, never a value. `balance`
 * answers which ACCOUNT to spend from and orders inside a harness by `balanced` weights. */
export declare const STRATEGIES: string[];
/** The strategies that HAVE a weight set — the four of ADR-005. An overlay may re-weight only these. */
export declare const WEIGHT_STRATEGIES: string[];
/** The weight set `balance` orders tuples by inside one harness. "The role's ordering", everywhere in ADR-005. */
export declare const BALANCE_ORDERING = "balanced";
/** The names an allow or a deny rule can select by. Flags and pools read the snapshot;
 * the other selectors read tuple fields. */
export declare const SELECTOR_KINDS: SelectorKind[];
export declare const ROUTING_POOLS: string[];
/** Layer id a diagnostic names when the value came from `DEFAULT_POLICY` and no overlay wrote it.
 * Not a real layer, and it cannot collide with one. */
export declare const DEFAULTS = "defaults";
/** One JSON file of the routing stack. Absent is a state, not a failure; present and unreadable
 * IS one — ignoring it would apply a policy the person thinks is in force. */
export declare function readLayerFile(file: string, layer?: RoutingLayerIdentity | null): {
    present: boolean;
    data: unknown;
};
/** Read the canonical catalog and every overlay the host names, in the host's order. Nothing is
 * merged and nothing is checked here. */
export declare function readLayers(host: RoutingHost | null | undefined, { catalogFile }?: {
    catalogFile?: string | undefined;
}): {
    canonical: {
        present: boolean;
        data: unknown;
        id: string;
        path: string;
        writable: boolean;
    };
    overlays: {
        present: boolean;
        data: unknown;
        id: string;
        path: string;
        writable: boolean;
    }[];
};
/** How a rule reads in a diagnostic: `deny.models`, or `deny.byRole.reviewer.models`. */
export declare const rulePath: (rule: Pick<RoutingRule, 'role' | 'rule' | 'kind'>) => string;
/** A layer as a diagnostic names it. `defaults` is a layer id like any other. */
export declare const layerLabel: (id: string) => string;
/** `deny.models of overlay "user"`, joined for a merged list several layers wrote. */
export declare const rulesLabel: (rules: RoutingRule[]) => string;
/** The rules of one kind that apply when routing `role`: the unscoped ones and that role's, in
 * layer order. `role: null` asks for the unscoped rules alone. */
export declare function rulesFor(sources: RoutingSources | null | undefined, { rule, kind, role, step, name, }?: {
    rule?: 'allow' | 'deny';
    kind?: SelectorKind;
    role?: string | null;
    step?: string | null;
    name?: string | null;
}): RoutingRule[];
/** The allow and deny lists in force for one role (ADR-005). A kind absent from `allow` means no
 * layer stated one; present and empty means they agreed on nothing — different facts. */
export declare function rulesForRole(policy: RoutingPolicy | null | undefined, role: string, step?: string): {
    allow: Partial<Record<SelectorKind, string[]>>;
    deny: Partial<Record<SelectorKind, string[]>>;
};
/** Merge the whole stack. Pure, and the layer ORDER of `overlays` is the precedence order —
 * swapping two entries changes the result, which is the property the merge test pins. */
export declare function mergeRouting({ canonical, overlays, constraints, stepNames, now }?: {
    canonical?: CatalogDocument | null;
    overlays?: RoutingLayer[];
    constraints?: RoutingConstraints | null;
    stepNames?: string[];
    now?: number;
}): {
    schemaVersion: number;
    updated: string | undefined;
    tuples: CatalogTuple[];
    policy: Readonly<RoutingPolicy>;
    sources: RoutingSources;
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
};
/** The whole load in one call. `layers` comes back with the paths and whether each was there:
 * the decision names a layer by `id`, and a person still has to find the file. */
export declare function loadCatalog({ host, constraints, catalogFile, now }?: {
    host?: PromptobusHost | null;
    constraints?: RoutingConstraints | null;
    catalogFile?: string;
    now?: number;
}): {
    schemaVersion: number;
    updated: string | undefined;
    tuples: CatalogTuple[];
    policy: Readonly<RoutingPolicy>;
    sources: RoutingSources;
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
export {};

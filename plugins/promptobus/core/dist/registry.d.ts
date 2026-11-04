import type { PromptobusHost } from './host.js';
export declare const ORCHESTRATOR = "orchestrator";
export declare const WORKER = "worker";
export declare const REVIEWER = "reviewer";
export declare const APPROVER = "approver";
export declare const EDITS_TREE = "edits-tree";
export declare const READS_DIFF = "reads-diff";
export declare const WRITES_MAIN_TREE = "writes-main-tree";
/** The three kinds of right a pipeline step is an instance of. */
export declare const STEP_KINDS: readonly ["edits-tree", "reads-diff", "writes-main-tree"];
export type StepKind = (typeof STEP_KINDS)[number];
/** What the package strips from a participant before lift: the harness's write tools, or nothing. */
export type PackageDeny = 'write-tools' | 'none';
/** Participant file stem in `workers/`: the slug alone, `<name>-<slug>`, or the bare name. */
export type StemShape = 'slug' | 'prefixed' | 'name';
declare const KIND_FIELDS: Readonly<{
    readonly "edits-tree": {
        readonly deny: 'none';
        readonly hostDenyRole: null;
        readonly floor: 5;
        readonly catalogRole: "worker";
        readonly routed: true;
        readonly lift: "worker";
    };
    readonly "reads-diff": {
        readonly deny: 'write-tools';
        readonly hostDenyRole: "reviewer";
        readonly floor: 9;
        readonly catalogRole: "reviewer";
        readonly routed: true;
        readonly lift: "reviewer";
    };
    readonly "writes-main-tree": {
        readonly deny: 'none';
        readonly hostDenyRole: "approver";
        readonly floor: 7;
        readonly catalogRole: "approver";
        readonly routed: true;
        readonly lift: "approver";
    };
}>;
/** The role word a host classifies external MCP writes under. */
export type HostDenyRole = NonNullable<(typeof KIND_FIELDS)[StepKind]['hostDenyRole']>;
/** A role the model catalog rates tuples for. */
export type CatalogRole = (typeof KIND_FIELDS)[StepKind]['catalogRole'];
export interface RoleEntry {
    readonly name: string;
    readonly layer: 'governance' | 'step';
    readonly kind: StepKind | null;
    /** Address shape: `<name>:<slug>` when true, the bare name otherwise. */
    readonly slug: boolean;
    readonly stem: StemShape;
    readonly deny: PackageDeny;
    readonly hostDenyRole: HostDenyRole | null;
    readonly floor: number | null;
    readonly catalogRole: CatalogRole | null;
    readonly routed: boolean;
    /** Which lift's texts the entry is lifted with; `null` — nothing lifts it. */
    readonly lift: CatalogRole | null;
}
/** A registry value: governance roles first, then the steps in pipeline order. Never mutated. */
export interface RoleRegistry {
    readonly entries: readonly RoleEntry[];
    /** Declared names; absent on the shipped registry. */
    readonly activeSteps?: readonly string[];
}
/** A step a declaration names. */
export interface DeclaredStep {
    readonly name: string;
    readonly kind: StepKind;
    /** Present only when the host's declaration sets a floor for this step. */
    readonly qualityFloor?: number;
}
/** What the package ships: the governance roles and the default pipeline `worker`, `reviewer`, `approver`. */
export declare const SHIPPED_REGISTRY: RoleRegistry;
export declare function roleEntry(registry: RoleRegistry, name: unknown): RoleEntry | null;
/** The address grammar: a slugless name the package fixes, or `<name>:<slug>` under any other name. */
export declare const ADDRESS_RE: RegExp;
/** The registry with each declared step admitted: its name parses, its stem is `<name>-<slug>`, its fields are its kind's. */
export declare function withSteps(registry: RoleRegistry, declared: readonly DeclaredStep[]): RoleRegistry;
/** The registry a host declares; the shipped one while it declares no pipeline, or when there is no host. */
export declare function registryOf(host: Pick<PromptobusHost, 'pipeline'> | null | undefined): RoleRegistry;
/** Whether the registry admits an address: the grammar holds and its role is one of the entries. */
export declare function admitsAddress(registry: RoleRegistry, address: unknown): boolean;
/** The addressees of one pipeline: its orchestrator and every step. */
export declare function pipelineAddressNames(registry: RoleRegistry): string[];
/** The address list the texts print: `orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>`. */
export declare function addressList(registry: RoleRegistry): string;
/** The address without its step prefix; a governance address, or one whose prefix is no step, stays whole. */
export declare function withoutStep(registry: RoleRegistry, address: string): string;
/** The entry whose participant files a worker named `slug` would share, or `null`. */
export declare function stemOwner(registry: RoleRegistry, slug: string): RoleEntry | null;
/** The package deny list of a role, given the harness's own write tools — that very list, not a copy. */
export declare function packageDenyTools(registry: RoleRegistry, role: string, writeTools: readonly string[]): readonly string[];
/** Catalog roles of the routed entries, once each, in pipeline order. */
export declare function routedCatalogRoles(registry: RoleRegistry): CatalogRole[];
/** Default quality floor of a role on the ten-point scale; `null` for a role that is not routed. */
export declare function defaultFloor(registry: RoleRegistry, role: string): number | null;
/** Words a lift announces a role with — its kind's (`reviewer`, `the reviewer`); `null` for what nothing lifts. */
export declare function liftWords(registry: RoleRegistry, role: string): {
    nom: string;
    acc: string;
} | null;
export {};

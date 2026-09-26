// Roles and step kinds: the one table addresses, stems, deny lists, floors and routes read.
// [reference/04-protocol.md#the-role-registry](../docs/reference/04-protocol.md#the-role-registry)
import type { PromptobusHost } from './host.js';

export const ORCHESTRATOR = 'orchestrator';
export const WORKER = 'worker';
export const REVIEWER = 'reviewer';
export const APPROVER = 'approver';

export const EDITS_TREE = 'edits-tree';
export const READS_DIFF = 'reads-diff';
export const WRITES_MAIN_TREE = 'writes-main-tree';

/** The three kinds of right a pipeline step is an instance of. */
export const STEP_KINDS = Object.freeze([EDITS_TREE, READS_DIFF, WRITES_MAIN_TREE] as const);
export type StepKind = (typeof STEP_KINDS)[number];

/** What the package strips from a participant before lift: the harness's write tools, or nothing. */
export type PackageDeny = 'write-tools' | 'none';

/** Participant file stem in `workers/`: the slug alone, `<name>-<slug>`, or the bare name. */
export type StemShape = 'slug' | 'prefixed' | 'name';

const KIND_FIELDS = Object.freeze({
  [EDITS_TREE]: {
    deny: 'none', hostDenyRole: null, floor: 5, catalogRole: WORKER, routed: true, lift: WORKER,
  },
  [READS_DIFF]: {
    deny: 'write-tools', hostDenyRole: REVIEWER, floor: 9, catalogRole: REVIEWER, routed: true, lift: REVIEWER,
  },
  [WRITES_MAIN_TREE]: {
    deny: 'none', hostDenyRole: APPROVER, floor: 7, catalogRole: APPROVER, routed: true, lift: APPROVER,
  },
} as const);

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
}

/** A step a declaration names. */
export interface DeclaredStep {
  readonly name: string;
  readonly kind: StepKind;
  /** Present only when the host's declaration sets a floor for this step. */
  readonly qualityFloor?: number;
}

const UNLIFTED = {
  deny: 'none', hostDenyRole: null, floor: null, catalogRole: null, routed: false, lift: null,
} as const;

function governance(name: string, slug: boolean): RoleEntry {
  return Object.freeze({ name, layer: 'governance', kind: null, slug, stem: slug ? 'prefixed' : 'name', ...UNLIFTED });
}

function step(name: string, kind: StepKind, stem: StemShape): RoleEntry {
  return Object.freeze({ name, layer: 'step', kind, slug: true, stem, ...KIND_FIELDS[kind] });
}

/** What the package ships: the governance roles and the default pipeline `worker`, `reviewer`, `approver`. */
export const SHIPPED_REGISTRY: RoleRegistry = Object.freeze({
  entries: Object.freeze([
    governance(ORCHESTRATOR, false),
    governance('teamlead', true),
    governance('peer', true),
    governance('reporter', false),
    governance('user', false),
    step(WORKER, EDITS_TREE, 'slug'),
    step(REVIEWER, READS_DIFF, 'prefixed'),
    step(APPROVER, WRITES_MAIN_TREE, 'prefixed'),
  ]),
});

export function roleEntry(registry: RoleRegistry, name: unknown): RoleEntry | null {
  return registry.entries.find((e) => e.name === name) ?? null;
}

const STEP_NAME_SOURCE = '[a-z][a-z0-9-]{0,31}';
const STEP_NAME_RE = new RegExp(`^${STEP_NAME_SOURCE}$`);
const SLUG_SOURCE = '[a-z0-9][a-z0-9-]*';
const BARE = SHIPPED_REGISTRY.entries.filter((e) => !e.slug).map((e) => e.name).join('|');

/** The address grammar: a slugless name the package fixes, or `<name>:<slug>` under any other name. */
export const ADDRESS_RE = new RegExp(`^(${BARE}|(?!(?:${BARE}):)${STEP_NAME_SOURCE}:${SLUG_SOURCE})$`);

/** The registry with each declared step admitted: its name parses, its stem is `<name>-<slug>`, its fields are its kind's. */
export function withSteps(registry: RoleRegistry, declared: readonly DeclaredStep[]): RoleRegistry {
  const entries = [...registry.entries];
  for (const { name, kind } of declared) {
    if (typeof name !== 'string' || !STEP_NAME_RE.test(name)) {
      throw new Error(`step name «${name}» is not admitted: a step name is ${STEP_NAME_RE.source}`);
    }
    if (!STEP_KINDS.includes(kind)) {
      throw new Error(`step «${name}» names kind «${kind}» — a step is one of ${STEP_KINDS.join(', ')}`);
    }
    const known = entries.find((e) => e.name === name);
    if (known?.layer === 'governance') throw new Error(`step name «${name}» is a governance role the package fixes`);
    if (known) {
      if (known.kind === kind) continue;
      throw new Error(`step «${name}» is already admitted as ${known.kind}, not ${kind}`);
    }
    const overlap = entries.find((e) => e.slug
      && (name.startsWith(`${e.name}-`) || e.name.startsWith(`${name}-`)));
    if (overlap) {
      const [longer, shorter] = name.startsWith(`${overlap.name}-`) ? [name, overlap.name] : [overlap.name, name];
      throw new Error(`step name «${name}» overlaps «${overlap.name}»: ${longer}:x and `
        + `${shorter}:${longer.slice(shorter.length + 1)}-x would share one participant id and one mailbox`);
    }
    entries.push(step(name, kind, 'prefixed'));
  }
  return Object.freeze({ entries: Object.freeze(entries) });
}

/** The registry a host declares; the shipped one while it declares no pipeline, or when there is no host. */
export function registryOf(host: PromptobusHost | null | undefined): RoleRegistry {
  return withSteps(SHIPPED_REGISTRY, host?.pipeline?.() ?? []);
}

/** Whether the registry admits an address: the grammar holds and its role is one of the entries. */
export function admitsAddress(registry: RoleRegistry, address: unknown): boolean {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) return false;
  const at = address.indexOf(':');
  return roleEntry(registry, at < 0 ? address : address.slice(0, at))?.slug === at >= 0;
}

/** The addressees of one pipeline: its orchestrator and every step. */
export function pipelineAddressNames(registry: RoleRegistry): string[] {
  return [ORCHESTRATOR, ...registry.entries.filter((e) => e.layer === 'step').map((e) => e.name)];
}

/** The address list the texts print: `orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>`. */
export function addressList(registry: RoleRegistry): string {
  const forms = pipelineAddressNames(registry).map((n) => (roleEntry(registry, n)?.slug ? `${n}:<slug>` : n));
  return `${forms.slice(0, -1).join(', ')} or ${forms.at(-1)}`;
}

/** The address without its step prefix; a governance address, or one whose prefix is no step, stays whole. */
export function withoutStep(registry: RoleRegistry, address: string): string {
  const at = address.indexOf(':');
  return at > 0 && roleEntry(registry, address.slice(0, at))?.layer === 'step' ? address.slice(at + 1) : address;
}

/** The entry whose participant files a worker named `slug` would share, or `null`. */
export function stemOwner(registry: RoleRegistry, slug: string): RoleEntry | null {
  return registry.entries.find((e) => (e.stem === 'prefixed' && slug.startsWith(`${e.name}-`))
    || (e.stem === 'name' && slug === e.name)) ?? null;
}

/** The package deny list of a role, given the harness's own write tools — that very list, not a copy. */
export function packageDenyTools(registry: RoleRegistry, role: string, writeTools: readonly string[]): readonly string[] {
  return roleEntry(registry, role)?.deny === 'write-tools' ? writeTools : [];
}

/** Catalog roles of the routed entries, once each, in pipeline order. */
export function routedCatalogRoles(registry: RoleRegistry): CatalogRole[] {
  const out: CatalogRole[] = [];
  for (const e of registry.entries) {
    if (e.routed && e.catalogRole && !out.includes(e.catalogRole)) out.push(e.catalogRole);
  }
  return out;
}

/** Default quality floor of a role on the ten-point scale; `null` for a role that is not routed. */
export function defaultFloor(registry: RoleRegistry, role: string): number | null {
  return roleEntry(registry, role)?.floor ?? null;
}

/** Words a lift announces a role with — its kind's (`reviewer`, `the reviewer`); `null` for what nothing lifts. */
export function liftWords(registry: RoleRegistry, role: string): { nom: string; acc: string } | null {
  const lift = roleEntry(registry, role)?.lift;
  return lift ? { nom: lift, acc: `the ${lift}` } : null;
}

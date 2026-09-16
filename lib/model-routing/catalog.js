// Model catalog and the overlay merge: the shipped file, the layer stack, the rules.
// [guides/model-routing.md#loading-the-catalog-and-the-layer-stack](../../docs/guides/model-routing.md#loading-the-catalog-and-the-layer-stack)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GateError } from '../../dist/index.js';

// `MODEL_FLAGS` is NOT re-exported here: it lives with the reader that projects a snapshot's
// model rows ([cache.js](cache.js)). Two paths to one name is how a second copy appears.

const here = path.dirname(fileURLToPath(import.meta.url));

/** Shipped catalog. `models/` is in `files`, so this path exists in the tarball too. */
export const CATALOG_FILE = path.join(here, '..', '..', 'models', 'catalog.json');

export const CATALOG_SCHEMA_VERSION = 2;
export const OVERLAY_SCHEMA_VERSION = 2;

/** Overlay keys whose VALUES are on the rating scale, and which ADR-005 therefore refuses in a
 * v1 file — [guides/model-routing.md](../../docs/guides/model-routing.md#the-overlay-to-copy). */
export const SCALED_OVERLAY_KEYS = Object.freeze(['ratings', 'qualityFloor', 'reviewerQualityFloor']);

/** The one runtime list of participant roles that model routing supports. */
export const ROUTED_ROLES = Object.freeze(['worker', 'reviewer', 'approver']);

/** Kept as an identity alias for callers of the catalog's older name. */
export const RULE_ROLES = ROUTED_ROLES;

/** Return whether a participant role belongs to the routing contract. */
export const isRoutedRole = (role) => ROUTED_ROLES.includes(role);

const DEFAULT_ROLE_FLOORS = Object.freeze({ worker: 5, reviewer: 9, approver: 7 });
const roleMap = (make) => Object.freeze(Object.fromEntries(
  ROUTED_ROLES.map((role) => [role, make(role)]),
));
const defaultFloorFor = (role) => {
  const floor = DEFAULT_ROLE_FLOORS[role];
  if (!Number.isInteger(floor) || floor < 1 || floor > 10) {
    throw new TypeError(`routed role "${role}" has no valid default quality floor`);
  }
  return floor;
};
const DEFAULT_QUALITY_FLOORS = roleMap(defaultFloorFor);
const EMPTY_ROLE_RULES = () => Object.freeze({
  allow: Object.freeze({}),
  deny: Object.freeze({}),
});
const DEFAULT_ROLE_RULES = roleMap(EMPTY_ROLE_RULES);

/** Age at which a rating starts producing a `stale-rating` warning; never an exclusion.
 * [guides/model-routing.md](../../docs/guides/model-routing.md#staleness) */
export const STALE_RATING_DAYS = 90;

/** Policy defaults, every number from ADR-003. The resolver reads them through the merged policy
 * and never from a literal of its own — that is what lets an overlay change them. */
export const DEFAULT_POLICY = Object.freeze({
  weights: Object.freeze({
    quality: Object.freeze({ quality: 65, speed: 10, quotaCost: 10, remaining: 15 }),
    balanced: Object.freeze({ quality: 40, speed: 25, quotaCost: 20, remaining: 15 }),
    speed: Object.freeze({ quality: 20, speed: 60, quotaCost: 5, remaining: 15 }),
    economy: Object.freeze({ quality: 20, speed: 10, quotaCost: 55, remaining: 15 }),
  }),
  penalties: Object.freeze({
    unknownAvailability: 10,
    liveParticipantPerHarness: 5,
    liveParticipantCap: 20,
  }),
  bonuses: Object.freeze({ reviewerDiversity: 5 }),
  /** How many participants may be live on one harness at once, per harness, empty by default.
   * A ceiling and not a steeper penalty, because a penalty only ORDERS candidates. */
  caps: Object.freeze({ liveParticipants: Object.freeze({}) }),
  /** Role defaults on the ADR-005 1–10 scale. All remain soft choice rules. */
  qualityFloor: DEFAULT_QUALITY_FLOORS,
  /** The two numbers of the pace layer, both in PERCENTAGE POINTS of a window (ADR-004). A band
   * below the ~1-point noise floor would do nothing; `spendUnit` equal to it costs 10 one band. */
  balance: Object.freeze({ band: 5, spendUnit: 5 }),
  /** When `models` says an account is running short. Two readings of one window — `usedPercent`
   * is a LEVEL, `underspend` a RATE — and either alone raises the line. */
  nearLimit: Object.freeze({ usedPercent: 80, underspend: -15 }),
  /** The strategy `spawn` and `review` use with no `--strategy`, and the one key `models strategy
   * --set` writes. Empty is the legacy path; `auto` is never a value. */
  defaults: Object.freeze({}),
  /** A person's answer to a question no harness method returns. **Nothing writes it**: the
   * writable layer is per-workspace, and a tool-written answer would be asked in every one. */
  account: Object.freeze({}),
  allow: Object.freeze({}),
  deny: Object.freeze({}),
  byRole: DEFAULT_ROLE_RULES,
  payg: Object.freeze({ allow: false }),
});

/** The strategy names `--strategy` accepts; `auto` is a skill decision, never a value. `balance`
 * answers which ACCOUNT to spend from and orders inside a harness by `balanced` weights. */
export const STRATEGIES = ['quality', 'balanced', 'speed', 'economy', 'balance'];

/** The strategies that HAVE a weight set — the four of ADR-003. An overlay may re-weight only these. */
export const WEIGHT_STRATEGIES = ['quality', 'balanced', 'speed', 'economy'];

/** The weight set `balance` orders tuples by inside one harness. "The role's ordering", everywhere in ADR-004. */
export const BALANCE_ORDERING = 'balanced';

/** The names an allow or a deny rule can select by. `flags` is the odd one (ADR-004): the others
 * read a field of the TUPLE, and it reads a mark the SNAPSHOT carries, one step later. */
export const SELECTOR_KINDS = ['harnesses', 'models', 'efforts', 'tuples', 'flags'];


/** Layer id a diagnostic names when the value came from `DEFAULT_POLICY` and no overlay wrote it.
 * Not a real layer, and it cannot collide with one. */
export const DEFAULTS = 'defaults';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const clone = (v) => JSON.parse(JSON.stringify(v));

function gateError(message, layer = null) {
  const error = new GateError(message);
  if (layer) error.routingLayer = layer;
  return error;
}
function assertKnownRoleKeys(value, at, layerId) {
  if (!isObject(value)) return;
  const unknown = Object.keys(value).filter((role) => role !== '__proto__' && !isRoutedRole(role));
  if (unknown.length) {
    throw gateError(
      `${at}: unknown role ${unknown.join(', ')} — allowed: ${ROUTED_ROLES.join(', ')}`,
      { kind: 'overlay', id: layerId },
    );
  }
}

/** One JSON file of the routing stack. Absent is a state, not a failure; present and unreadable
 * IS one — ignoring it would apply a policy the person thinks is in force. */
export function readLayerFile(file, layer = null) {
  if (!existsSync(file)) return { present: false, data: null };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw gateError(`routing layer ${file} is unreadable: ${err.message}`, layer);
  }
  try {
    return { present: true, data: JSON.parse(text) };
  } catch (err) {
    throw gateError(`routing layer ${file} is not valid JSON: ${err.message}`, layer);
  }
}

/** Read the canonical catalog and every overlay the host names, in the host's order. Nothing is
 * merged and nothing is checked here. */
export function readLayers(host, { catalogFile = CATALOG_FILE } = {}) {
  const catalogLayer = { kind: 'catalog', id: 'catalog' };
  const canonical = readLayerFile(catalogFile, catalogLayer);
  if (!canonical.present) throw gateError(`the shipped catalog is missing: ${catalogFile}`, catalogLayer);
  const declared = host?.routingPaths?.()?.overlays ?? [];
  const writable = declared.filter((layer) => layer.writable === true).map((layer) => layer.id);
  // Exactly one writable layer, checked HERE at the declaration rather than at the write
  // (ADR-004 D6): with two, which file the tool writes would depend on iteration order.
  if (declared.length && writable.length !== 1) {
    const named = declared.map((layer) => layer.id).join(', ');
    throw gateError(writable.length
      ? `the host declares ${writable.length} writable routing layers (${writable.join(', ')}); exactly one may be writable`
      : `the host declares routing layers (${named}) and none of them is writable; exactly one must be`,
    { kind: 'host', id: 'host' });
  }
  const overlays = declared.map((layer) => ({
    id: layer.id,
    path: layer.path,
    writable: layer.writable === true,
    ...readLayerFile(layer.path, { kind: 'overlay', id: layer.id }),
  }));
  return { canonical: { ...canonical, id: 'catalog', path: catalogFile, writable: false }, overlays };
}

// --- the merge itself ---------------------------------------------------------
// The merge: four rules, and provenance as a list of rules rather than one layer id.

function mergeWeights(base, patch, note) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const name of Object.keys(patch)) {
    if (name === '__proto__') continue;
    out[name] = { ...patch[name] };
    note(name);
  }
  return out;
}

function mergeFlat(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__') continue;
    out[k] = v;
  }
  return out;
}

/** One layer's quality floors, with `reviewerQualityFloor` read as an alias (ADR-004). Inside ONE
 * layer the explicit key wins and the pair is recorded; across layers the highest one wins. */
function floorPatch(overlay, sources, layerId) {
  const out = {};
  if (isObject(overlay.qualityFloor)) {
    assertKnownRoleKeys(overlay.qualityFloor, 'qualityFloor', layerId);
    Object.assign(out, overlay.qualityFloor);
  }
  if (overlay.reviewerQualityFloor === undefined) return out;
  if (out.reviewer === undefined) out.reviewer = overlay.reviewerQualityFloor;
  else sources.floorAlias.push(layerId);
  return out;
}

/** `defaults`, with the layer of each key recorded. `__proto__` is skipped: these keys come from
 * a person's file, and assigning that name reaches the prototype SETTER instead. */
function mergeDefaults(base, patch, sources, layerId) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__') continue;
    out[key] = value;
    sources.defaults[key] = layerId;
  }
  return out;
}

/** `caps`, merged harness by harness: the highest layer naming a harness wins for THAT harness.
 * No layer is recorded — nothing prints where a cap came from. */
function mergeCaps(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [kind, block] of Object.entries(patch)) {
    // `__proto__` on either level, for the reason `mergeAccount` gives: a harness
    // id is a person's string, and the spread below would take it along.
    if (kind === '__proto__' || !isObject(block)) continue;
    out[kind] = mergeFlat(out[kind] ?? {}, block);
  }
  return out;
}

/** `account`, one block per harness merged key by key, so two layers may answer different
 * questions about one harness. The layer is recorded: `models` prints where an answer came from. */
function mergeAccount(base, patch, sources, layerId) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [harness, block] of Object.entries(patch)) {
    // `__proto__` on either level, for the reason `mergeDefaults` gives: a harness id is a
    // person's string, and the spread below would take a `__proto__` key of the block with it.
    if (harness === '__proto__' || !isObject(block)) continue;
    const merged = { ...(out[harness] ?? {}) };
    for (const [key, value] of Object.entries(block)) {
      if (key === '__proto__') continue;
      merged[key] = value;
      sources.account[`${harness}.${key}`] = layerId;
    }
    out[harness] = merged;
  }
  return out;
}

/** Deny: union per selector kind, order-preserving so a merged list reads as it was written. */
function mergeDeny(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const kind of SELECTOR_KINDS) {
    if (!Array.isArray(patch[kind])) continue;
    out[kind] = [...new Set([...(out[kind] ?? []), ...patch[kind]])];
  }
  return out;
}

/** Allow: intersection per selector kind, over the layers that state one. */
function mergeAllow(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const kind of SELECTOR_KINDS) {
    if (!Array.isArray(patch[kind])) continue;
    out[kind] = Array.isArray(out[kind])
      ? out[kind].filter((name) => patch[kind].includes(name))
      : [...patch[kind]];
  }
  return out;
}

/** Every allow and deny list one overlay wrote, unscoped ones and `byRole` ones alike. */
function recordRules(rules, layerId, overlay) {
  for (const rule of ['allow', 'deny']) {
    const block = overlay[rule];
    if (!isObject(block)) continue;
    for (const kind of SELECTOR_KINDS) {
      if (Array.isArray(block[kind])) {
        rules.push({ layer: layerId, rule, role: null, kind, names: [...block[kind]] });
      }
    }
    if (!isObject(block.byRole)) continue;
    assertKnownRoleKeys(block.byRole, `${rule}.byRole`, layerId);
    for (const role of ROUTED_ROLES) {
      const scoped = block.byRole[role];
      if (!isObject(scoped)) continue;
      for (const kind of SELECTOR_KINDS) {
        if (Array.isArray(scoped[kind])) {
          rules.push({ layer: layerId, rule, role, kind, names: [...scoped[kind]] });
        }
      }
    }
  }
}

function applyOverlayToPolicy(policy, overlay, sources, layerId) {
  const byRole = { ...policy.byRole };
  for (const role of ROUTED_ROLES) {
    const allowPatch = overlay.allow?.byRole?.[role];
    const denyPatch = overlay.deny?.byRole?.[role];
    if (!isObject(allowPatch) && !isObject(denyPatch)) continue;
    byRole[role] = {
      allow: mergeAllow(byRole[role].allow, allowPatch),
      deny: mergeDeny(byRole[role].deny, denyPatch),
    };
  }
  recordRules(sources.rules, layerId, overlay);
  return {
    weights: mergeWeights(policy.weights, overlay.weights, (n) => { sources.weights[n] = layerId; }),
    penalties: mergeFlat(policy.penalties, overlay.penalties),
    bonuses: mergeFlat(policy.bonuses, overlay.bonuses),
    caps: mergeCaps(policy.caps, overlay.caps),
    qualityFloor: mergeFlat(policy.qualityFloor, floorPatch(overlay, sources, layerId)),
    balance: mergeFlat(policy.balance, overlay.balance),
    nearLimit: mergeFlat(policy.nearLimit, overlay.nearLimit),
    // A scalar merging like every other: the highest layer that names one wins. Its layer is
    // recorded because a person who wants to change it must be told which file to open.
    defaults: mergeDefaults(policy.defaults, overlay.defaults, sources, layerId),
    account: mergeAccount(policy.account, overlay.account, sources, layerId),
    allow: mergeAllow(policy.allow, overlay.allow),
    deny: mergeDeny(policy.deny, overlay.deny),
    byRole,
    payg: mergeFlat(policy.payg, overlay.payg),
  };
}

// --- reading the provenance back ---------------------------------------------

/** How a rule reads in a diagnostic: `deny.models`, or `deny.byRole.reviewer.models`. */
export const rulePath = (rule) => (rule.role
  ? `${rule.rule}.byRole.${rule.role}.${rule.kind}`
  : `${rule.rule}.${rule.kind}`);

/** A layer as a diagnostic names it. `defaults` is a layer id like any other. */
export const layerLabel = (id) => (id === DEFAULTS ? 'the defaults' : `overlay "${id}"`);

/** `deny.models of overlay "user"`, joined for a merged list several layers wrote. */
export const rulesLabel = (rules) => (rules.length
  ? rules.map((r) => `${rulePath(r)} of ${layerLabel(r.layer)}`).join(', ')
  : layerLabel(DEFAULTS));

/** The rules of one kind that apply when routing `role`: the unscoped ones and that role's, in
 * layer order. `role: null` asks for the unscoped rules alone. */
export function rulesFor(sources, {
  rule, kind, role = null, name = null,
} = {}) {
  return (sources?.rules ?? [])
    .filter((r) => r.rule === rule && r.kind === kind)
    .filter((r) => r.role === null || r.role === role)
    .filter((r) => name === null || r.names.includes(name));
}

/** The allow and deny lists in force for one role (ADR-004). A kind absent from `allow` means no
 * layer stated one; present and empty means they agreed on nothing — different facts. */
export function rulesForRole(policy, role) {
  if (!isRoutedRole(role)) {
    throw gateError(`rulesForRole: unknown role "${role}" — allowed: ${ROUTED_ROLES.join(', ')}`);
  }
  const scoped = policy?.byRole?.[role] ?? { allow: {}, deny: {} };
  const allow = {};
  const deny = {};
  for (const kind of SELECTOR_KINDS) {
    const flat = policy?.allow?.[kind];
    const own = scoped.allow?.[kind];
    if (Array.isArray(flat) && Array.isArray(own)) allow[kind] = flat.filter((n) => own.includes(n));
    else if (Array.isArray(flat)) allow[kind] = [...flat];
    else if (Array.isArray(own)) allow[kind] = [...own];

    const merged = [...new Set([...(policy?.deny?.[kind] ?? []), ...(scoped.deny?.[kind] ?? [])])];
    if (merged.length) deny[kind] = merged;
  }
  return { allow, deny };
}

function applyOverlayToTuples(tuples, overlay, sources, layerId) {
  const ratings = isObject(overlay.ratings) ? overlay.ratings : {};
  const priority = isObject(overlay.priority) ? overlay.priority : {};
  if (!Object.keys(ratings).length && !Object.keys(priority).length) return tuples;
  // `Object.hasOwn`, not a bare read: these maps are keyed by a tuple id from a person's file,
  // and the id grammar admits `constructor` and `__proto__`.
  return tuples.map((tuple) => {
    const patchedRatings = Object.hasOwn(ratings, tuple.id) ? ratings[tuple.id] : undefined;
    const patchedPriority = Object.hasOwn(priority, tuple.id) ? priority[tuple.id] : undefined;
    if (patchedRatings === undefined && patchedPriority === undefined) return tuple;
    // The same per-rating merge also supplies calibrate's source label. A later
    // layer replaces the provenance of only the keys it names.
    if (isObject(patchedRatings) && sources?.ratings) {
      const previous = Object.hasOwn(sources.ratings, tuple.id)
        ? sources.ratings[tuple.id]
        : Object.create(null);
      const provenance = { ...previous };
      for (const rating of Object.keys(patchedRatings)) provenance[rating] = layerId;
      sources.ratings[tuple.id] = provenance;
    }
    if (patchedPriority !== undefined && sources?.priority) sources.priority[tuple.id] = layerId;
    return {
      ...tuple,
      ...(patchedRatings ? { ratings: { ...tuple.ratings, ...patchedRatings } } : {}),
      ...(patchedPriority === undefined ? {} : { priority: patchedPriority }),
    };
  });
}

/** Constraints layer: `--harness`, `--model` and `--effort` pass through untouched, `--allow-payg`
 * is a policy change applied here. Opt-in only — `false` does not force the policy back. */
function applyConstraints(policy, constraints) {
  if (!isObject(constraints)) return policy;
  if (constraints.allowPayg !== true) return policy;
  return { ...policy, payg: { ...policy.payg, allow: true } };
}

function staleWarnings(tuples, now) {
  const cutoff = now - STALE_RATING_DAYS * 24 * 60 * 60 * 1000;
  const out = [];
  for (const tuple of tuples) {
    const at = Date.parse(tuple.assessedAt ?? '');
    if (Number.isFinite(at) && at < cutoff) {
      const ageDays = Math.floor((now - at) / (24 * 60 * 60 * 1000));
      // `code` and `message` and nothing else are what a decision document may carry. Everything
      // below them is for a caller that wants the facts without parsing prose.
      out.push({
        code: 'stale-rating',
        message: `the rating of "${tuple.id}" was assessed ${ageDays} days ago, `
          + `and a rating goes stale after ${STALE_RATING_DAYS} — a warning only, never an exclusion`,
        tupleId: tuple.id,
        assessedAt: tuple.assessedAt,
        ageDays,
        staleAfterDays: STALE_RATING_DAYS,
      });
    }
  }
  return out;
}

function promotionWarnings(tuples, now) {
  const out = [];
  for (const tuple of tuples) {
    for (const source of tuple.evidence?.sources ?? []) {
      if (source?.rating !== 'quotaCost' || typeof source.validUntil !== 'string') continue;
      const validUntil = Date.parse(`${source.validUntil}T23:59:59.999Z`);
      if (!Number.isFinite(validUntil) || validUntil >= now) continue;
      out.push({
        code: 'promotion-expired',
        message: `the promotion for "${tuple.id}" expired on ${source.validUntil}: `
          + `promotional figure ${source.figure}; list figure ${source.listFigure} gives band ${source.listBand}`
          + ' — warning only, the catalog remains loadable',
        tupleId: tuple.id,
        validUntil: source.validUntil,
        promotionalFigure: source.figure,
        listFigure: source.listFigure,
        listBand: source.listBand,
      });
    }
  }
  return out;
}

/** Merge the whole stack. Pure, and the layer ORDER of `overlays` is the precedence order —
 * swapping two entries changes the result, which is the property the merge test pins. */
export function mergeRouting({ canonical, overlays = [], constraints = null, now = Date.now() } = {}) {
  if (!isObject(canonical)) {
    throw gateError('mergeRouting: no canonical catalog', { kind: 'catalog', id: 'catalog' });
  }
  if (canonical.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw gateError(
      `catalog schemaVersion ${canonical.schemaVersion} is not the supported ${CATALOG_SCHEMA_VERSION}`,
      { kind: 'catalog', id: 'catalog' },
    );
  }
  let policy = clone(DEFAULT_POLICY);
  let tuples = clone(canonical.tuples ?? []);
  const applied = [];
  // Who wrote each key a diagnostic has to name: a weight set has one writer, an allow or deny
  // list as many as stated one. `DEFAULTS` is a layer id like any other.
  const sources = {
    weights: Object.fromEntries(WEIGHT_STRATEGIES.map((n) => [n, DEFAULTS])),
    rules: [],
    defaults: {},
    account: {},
    // Effective tuple rating source, keyed by tuple id and rating name.
    ratings: {},
    // Effective canonical-priority source, keyed by tuple id. A priority is a
    // scalar, so one layer id and not a map per key.
    priority: {},
    // Layers that stated `qualityFloor.reviewer` AND the alias. Lawful — the explicit key wins —
    // and a `validate` warning: a file saying one thing twice expected two things.
    floorAlias: [],
  };
  for (const layer of overlays) {
    if (!layer?.present || !isObject(layer.data)) continue;
    const scaled = layer.data.schemaVersion === 1
      ? SCALED_OVERLAY_KEYS.filter((key) => Object.hasOwn(layer.data, key))
      : [];
    if (scaled.length) {
      throw gateError(`overlay "${layer.id}" uses schemaVersion 1 with ${scaled.join(', ')}; `
        + `rewrite ${scaled.map((key) => `\`${key}\``).join(' and ')} on the 1–10 scale `
        + `and set \`schemaVersion: 2\` (${layer.path})`,
      { kind: 'overlay', id: layer.id });
    }
    if (layer.data.schemaVersion !== OVERLAY_SCHEMA_VERSION && layer.data.schemaVersion !== 1) {
      throw gateError(`overlay "${layer.id}" schemaVersion ${layer.data.schemaVersion} `
        + `is not the supported ${OVERLAY_SCHEMA_VERSION} (${layer.path})`,
      { kind: 'overlay', id: layer.id });
    }
    policy = applyOverlayToPolicy(policy, layer.data, sources, layer.id);
    tuples = applyOverlayToTuples(tuples, layer.data, sources, layer.id);
    applied.push(layer.id);
  }
  policy = applyConstraints(policy, constraints);
  return {
    schemaVersion: canonical.schemaVersion,
    updated: canonical.updated,
    tuples,
    policy,
    sources,
    constraints: isObject(constraints)
      ? {
        harness: constraints.harness ?? null,
        model: constraints.model ?? null,
        effort: constraints.effort ?? null,
      }
      : null,
    appliedOverlays: applied,
    warnings: [...staleWarnings(tuples, now), ...promotionWarnings(tuples, now)],
  };
}

/** The whole load in one call. `layers` comes back with the paths and whether each was there:
 * the decision names a layer by `id`, and a person still has to find the file. */
export function loadCatalog({ host, constraints = null, catalogFile = CATALOG_FILE, now = Date.now() } = {}) {
  const { canonical, overlays } = readLayers(host, { catalogFile });
  const merged = mergeRouting({ canonical: canonical.data, overlays, constraints, now });
  return {
    ...merged,
    layers: [
      { id: canonical.id, path: canonical.path, present: true },
      ...overlays.map(({ id, path: file, present }) => ({ id, path: file, present })),
    ],
  };
}

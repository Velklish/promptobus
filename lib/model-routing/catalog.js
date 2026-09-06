// Model catalog and the overlay merge.
//
// The catalog is the maintainers' rating of tuples and ships with the package
// (`models/catalog.json`, `files` in package.json). Above it sit overlays: the
// host names them and their order, lowest precedence first
// (`routingPaths().overlays` — [02-host](../../docs/reference/02-host.md)), and
// above those the constraints the caller took from the command line. The stack
// is exactly the one ADR-003 fixed:
//
//     canonical catalog → host overlays, lowest to highest → CLI constraints
//
// Nothing here resolves or scores anything. This module answers one question —
// "what is the policy and the tuple list, after everyone has had their say" —
// and PB-18 turns that answer into a pick. `validate.js` next door reads the
// same layers and reports what is wrong with them.
//
// A missing overlay file is normal and not an error: the host names paths, it
// does not promise they exist.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GateError } from '../../dist/index.js';

// `MODEL_FLAGS` — the closed list an overlay's `flags` selector is checked
// against — is NOT re-exported here. It lives with the reader that projects a
// snapshot's model rows onto the shape ([cache.js](cache.js)), because a flag is
// a mark the SNAPSHOT carries, and `validate.js` imports it from there. Two
// paths to one name are how a second copy of it eventually appears.

const here = path.dirname(fileURLToPath(import.meta.url));

/** Shipped catalog. `models/` is in `files`, so this path exists in the tarball too. */
export const CATALOG_FILE = path.join(here, '..', '..', 'models', 'catalog.json');

export const CATALOG_SCHEMA_VERSION = 1;
export const OVERLAY_SCHEMA_VERSION = 1;

/**
 * Age at which a rating starts producing a `stale-rating` warning.
 *
 * Ninety days, and the number is a mechanism default rather than something
 * ADR-003 fixed: catalog updates are event-driven — a changed model line-up,
 * changed prices, a substantial observation — so there is no schedule to derive
 * it from. It is deliberately longer than a release cycle and shorter than the
 * time in which a harness's model list turns over. A stale rating is never an
 * exclusion; it is a warning and nothing more.
 */
export const STALE_RATING_DAYS = 90;

/**
 * Policy defaults, every number of them from ADR-003. The resolver reads them
 * from here through the merged policy and never from a literal of its own —
 * that is what makes an overlay able to change them at all.
 */
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
  /**
   * ADR-004 decision 3, superseding ADR-003's reviewer floor of 4 and its
   * absence of a worker floor. Five for the reviewer, because the reviewer is
   * the last reader and a defect it misses costs the defect and a round trip;
   * three for the worker, because ADR-003's own opening argument — a worker on
   * a cheap model where the task needed the expensive one is paid for in review
   * rounds — describes a floor and never set one.
   */
  qualityFloor: Object.freeze({ worker: 3, reviewer: 5 }),
  /**
   * The two numbers of the pace layer, both in PERCENTAGE POINTS of a window
   * (ADR-004), and both defaulting to five.
   *
   * `band` says "these two accounts are about equally spent, so take the better
   * model". Its job is not to model noise, but the noise floor is about a point
   * — one harness reports `usedPercent` as an integer, and a sixty-second cache
   * entry moves a five-hour window by a third of a point — so a band below that
   * would do nothing at all. `spendUnit` is equal to it by default, so that a
   * `quotaCost` of 5 gives up exactly one band against a `quotaCost` of 1: the
   * heaviest tuple has to be a whole band ahead on pace to win.
   */
  balance: Object.freeze({ band: 5, spendUnit: 5 }),
  /**
   * When `models` says an account is running short (ADR-004 decision 7). Two
   * readings of the same binding window, and either one on its own raises the
   * line: `usedPercent` is a LEVEL — how much of the window is gone — and
   * `underspend` is a RATE, in the pace layer's percentage points, so −15 means
   * the account has spent fifteen points more of the window than has elapsed of
   * it. A harness can trip one without the other, which is the point of having
   * both: an account at 85 % with 95 % of its week gone is high on level and
   * ahead on pace, and an account at 40 % three days early is neither.
   */
  nearLimit: Object.freeze({ usedPercent: 80, underspend: -15 }),
  /**
   * The strategy `spawn` and `review` use when `--strategy` is absent, and the
   * one key `models strategy --set` writes. Empty by default, and empty is the
   * legacy path: ADR-003's "a call with no `--strategy` routes nothing" still
   * holds word for word where no layer sets one. `auto` is never a value — it is
   * a skill decision and has never been a value the CLI accepts.
   */
  defaults: Object.freeze({}),
  /**
   * A person's answer to a question no harness method returns — today one,
   * Cursor's plan name, under `account: { "<harness>": { plan } }` in the user
   * overlay. **Nothing writes it**: the writable layer is per-workspace, so a
   * tool-written answer would be given again in every workspace, which is the
   * opposite of "asked once" (ADR-004). Display only, and an input to no score.
   */
  account: Object.freeze({}),
  allow: Object.freeze({}),
  deny: Object.freeze({}),
  byRole: Object.freeze({
    worker: Object.freeze({ allow: Object.freeze({}), deny: Object.freeze({}) }),
    reviewer: Object.freeze({ allow: Object.freeze({}), deny: Object.freeze({}) }),
  }),
  payg: Object.freeze({ allow: false }),
});

/**
 * The strategy names `--strategy` accepts. `auto` is a skill decision, never a
 * value here.
 *
 * `balance` is ADR-004's fifth and it is not a fifth weight set: it answers
 * which ACCOUNT to spend from, where the other four answer how to weigh the
 * qualities of a tuple, and inside one harness it orders tuples by the merged
 * `balanced` weights. Two weight sets that must be kept in step are two things
 * to keep in step, and a person who wants a different ordering inside a harness
 * is describing a different strategy. The cost is named rather than hidden: an
 * overlay that re-weights `balanced` re-weights the inside of `balance` with it.
 */
export const STRATEGIES = ['quality', 'balanced', 'speed', 'economy', 'balance'];

/** The strategies that HAVE a weight set — the four of ADR-003. An overlay may re-weight only these. */
export const WEIGHT_STRATEGIES = ['quality', 'balanced', 'speed', 'economy'];

/** The weight set `balance` orders tuples by inside one harness. "The role's ordering", everywhere in ADR-004. */
export const BALANCE_ORDERING = 'balanced';

/**
 * The names an allow or a deny rule can select by.
 *
 * `flags` is the odd one and ADR-004 says why: the other four read a field of
 * the TUPLE, and a flag is a mark the SNAPSHOT carries on a model row. So it
 * merges here like its neighbours and is applied in the resolver one step later
 * — after the inventory step, which is where the row it needs arrives.
 */
export const SELECTOR_KINDS = ['harnesses', 'models', 'efforts', 'tuples', 'flags'];

/**
 * Roles a `byRole` block scopes a rule to — the two the resolver routes for.
 *
 * `byRole` is a nested selector object rather than a fifth name beside the four
 * above (ADR-004, decision 5): a role is a condition on WHEN a rule applies, not
 * a thing that can be banned, and putting it in the flat object would change
 * what its neighbours mean.
 */
export const RULE_ROLES = ['worker', 'reviewer'];

/**
 * Layer id a diagnostic names when the value it is about came from
 * `DEFAULT_POLICY` and no overlay ever wrote it. Not a real layer, and it
 * cannot collide with one: the overlay schema has no layer named here, and the
 * host's ids come from `routingPaths()`.
 */
export const DEFAULTS = 'defaults';

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * One JSON file of the routing stack.
 *
 * Absent is a state, not a failure: the caller sees `present: false` and moves
 * on. Present and unreadable IS a failure — a person edited that file and got
 * the syntax wrong, and silently ignoring it would apply a policy they think is
 * in force.
 */
export function readLayerFile(file) {
  if (!existsSync(file)) return { present: false, data: null };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new GateError(`routing layer ${file} is unreadable: ${err.message}`);
  }
  try {
    return { present: true, data: JSON.parse(text) };
  } catch (err) {
    throw new GateError(`routing layer ${file} is not valid JSON: ${err.message}`);
  }
}

/**
 * Read the canonical catalog and every overlay the host names, in the host's
 * order. Nothing is merged and nothing is checked here — `mergeRouting` and
 * `validate` take it from this shape.
 */
export function readLayers(host, { catalogFile = CATALOG_FILE } = {}) {
  const canonical = readLayerFile(catalogFile);
  if (!canonical.present) throw new GateError(`the shipped catalog is missing: ${catalogFile}`);
  const declared = host?.routingPaths?.()?.overlays ?? [];
  const writable = declared.filter((layer) => layer.writable === true).map((layer) => layer.id);
  // Exactly one writable layer, and the check is HERE — at the declaration —
  // rather than at the write (ADR-004, decision 6). A host that names layers and
  // no writable one has an incomplete declaration, and a person who learns that
  // from `models strategy --set` learns it after making the edit it refuses to
  // keep. Two is the other half of the same fault: with two, which file the tool
  // writes would depend on iteration order, and the loser's copy would sit on
  // disk saying something nobody set. A host that declares no layer at all
  // declares nothing to write, which is lawful and is what a consumer with no
  // overlays has.
  if (declared.length && writable.length !== 1) {
    const named = declared.map((layer) => layer.id).join(', ');
    throw new GateError(writable.length
      ? `the host declares ${writable.length} writable routing layers (${writable.join(', ')}); exactly one may be writable`
      : `the host declares routing layers (${named}) and none of them is writable; exactly one must be`);
  }
  const overlays = declared.map((layer) => ({
    id: layer.id,
    path: layer.path,
    writable: layer.writable === true,
    ...readLayerFile(layer.path),
  }));
  return { canonical: { ...canonical, id: 'catalog', path: catalogFile, writable: false }, overlays };
}

// --- the merge itself --------------------------------------------------------
//
// Four different rules live here, and they differ on purpose:
//
//   * a weight SET is replaced whole. Half-replacing one would silently stop it
//     summing to 100, and the resolver would divide a component back by a weight
//     nobody chose;
//   * a DENY list ACCUMULATES across layers, per selector kind. A ban written in
//     any layer stands, and no layer above it lifts one: lifting a ban means
//     changing the layer that wrote it. ADR-003's "Clarification, 2026-09-05" —
//     replacement per selector kind — is superseded whole by ADR-004 decision 5,
//     which measured the cost of the old rule: a product policy could only make
//     its bans hold by sitting above a person's file and erasing that person's
//     own `deny.tuples` with it;
//   * an ALLOW list INTERSECTS across layers, per selector kind. A tuple must be
//     named by every allow list of that kind that any layer states, so one
//     sentence covers both lists — a layer's rule survives every layer above it
//     (ADR-004, option B1). The cost is real and is checked rather than
//     discovered: two layers can intersect to nothing, and `validate` reports
//     `allow-intersection-empty` when they do. An intersection that came out
//     empty is `[]` and NOT an absent key, because the two mean opposite things
//     to the resolver — absent is "no allow list of this kind", empty is "an
//     allow list that admits nothing";
//   * everything else merges field by field: a penalty, a bonus, one rating of
//     one tuple. Naming a field is how an overlay changes it, and not naming it
//     is how it leaves the layer below alone.
//
// Provenance is a LIST OF RULES rather than one layer id per key, and it has to
// be: under union and intersection a merged list is written by several layers at
// once, and "denied by overlay \"workspace\"" is only half an answer when the
// user layer denied it too. `sources.rules` records every allow and deny list
// any layer wrote, in layer order, with the role it was scoped to — and every
// diagnostic in the resolver and in `validate` is a filter over that list.

function mergeWeights(base, patch, note) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const name of Object.keys(patch)) {
    out[name] = { ...patch[name] };
    note(name);
  }
  return out;
}

function mergeFlat(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = v;
  return out;
}

/**
 * One layer's quality floors, with `reviewerQualityFloor` read as an alias for
 * `qualityFloor.reviewer` (ADR-004) so an overlay written for v1 keeps its
 * meaning.
 *
 * Inside ONE layer the explicit key wins and the pair is recorded for
 * `validate` to warn about. Across layers nothing special happens: a floor is a
 * scalar and the highest layer that states one wins, whichever of the two
 * spellings it used.
 */
function floorPatch(overlay, sources, layerId) {
  const out = {};
  if (isObject(overlay.qualityFloor)) Object.assign(out, overlay.qualityFloor);
  if (overlay.reviewerQualityFloor === undefined) return out;
  if (out.reviewer === undefined) out.reviewer = overlay.reviewerQualityFloor;
  else sources.floorAlias.push(layerId);
  return out;
}

/**
 * `defaults`, with the layer of each key recorded — `models strategy` names
 * where the value came from.
 *
 * `__proto__` is skipped, for the reason `applyOverlayToTuples` gives: these
 * keys come from `JSON.parse` on a file a person wrote, and a plain assignment
 * to that name reaches the prototype SETTER rather than creating a property. A
 * layer carrying it would route with a policy object whose prototype had moved,
 * and `validate` — which refuses the key as an unknown one — would be running
 * on a document the merge had already been changed by.
 */
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

/**
 * `account`, one block per harness, merged key by key so two layers could answer
 * different questions about one harness. The layer is recorded for the same
 * reason it is for `defaults`: `models` prints where a person's answer came
 * from, and where to add one that is not there.
 */
function mergeAccount(base, patch, sources, layerId) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [harness, block] of Object.entries(patch)) {
    // `__proto__` on either level, and for the reason `mergeDefaults` gives: a
    // harness id is a person's string, and the spread below would take a
    // `__proto__` key of the block with it.
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
    for (const role of RULE_ROLES) {
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
  for (const role of RULE_ROLES) {
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
    qualityFloor: mergeFlat(policy.qualityFloor, floorPatch(overlay, sources, layerId)),
    balance: mergeFlat(policy.balance, overlay.balance),
    nearLimit: mergeFlat(policy.nearLimit, overlay.nearLimit),
    // A scalar, and it merges like every other scalar: the highest layer that
    // names one wins. Its layer is recorded because `models strategy` prints
    // where the effective default came from, and a person who wants to change it
    // has to be told which of three files to open.
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

/**
 * The rules of one kind that apply when routing `role`: the unscoped ones and
 * that role's, in layer order. `name` narrows to the rules that carry it, which
 * is what a "who denied this tuple" diagnostic asks.
 *
 * `role: null` asks for the unscoped rules alone — the question `validate` puts
 * when no layer scoped a rule of that kind to a role at all.
 */
export function rulesFor(sources, {
  rule, kind, role = null, name = null,
} = {}) {
  return (sources?.rules ?? [])
    .filter((r) => r.rule === rule && r.kind === kind)
    .filter((r) => r.role === null || r.role === role)
    .filter((r) => name === null || r.names.includes(name));
}

/**
 * The allow and deny lists in force for one role: the unscoped lists, with the
 * role's own unioned into the deny and intersected into the allow (ADR-004).
 *
 * A kind absent from `allow` means no layer stated one; a kind present and empty
 * means the layers that did state one agreed on nothing, and the resolver denies
 * every tuple by it. Those are different facts and the shape keeps them apart.
 */
export function rulesForRole(policy, role) {
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

function applyOverlayToTuples(tuples, overlay) {
  const ratings = isObject(overlay.ratings) ? overlay.ratings : {};
  const priority = isObject(overlay.priority) ? overlay.priority : {};
  if (!Object.keys(ratings).length && !Object.keys(priority).length) return tuples;
  // `Object.hasOwn`, not a bare read: these are maps keyed by a tuple id from a
  // file a person wrote, and the id grammar admits `constructor` and
  // `__proto__`. A bare read would hand the prototype's value to a tuple that
  // was never named.
  return tuples.map((tuple) => {
    const patchedRatings = Object.hasOwn(ratings, tuple.id) ? ratings[tuple.id] : undefined;
    const patchedPriority = Object.hasOwn(priority, tuple.id) ? priority[tuple.id] : undefined;
    if (patchedRatings === undefined && patchedPriority === undefined) return tuple;
    return {
      ...tuple,
      ...(patchedRatings ? { ratings: { ...tuple.ratings, ...patchedRatings } } : {}),
      ...(patchedPriority === undefined ? {} : { priority: patchedPriority }),
    };
  });
}

/**
 * Constraints layer. `--harness`, `--model` and `--effort` are carried through
 * untouched — they are the resolver's business, and PB-18 applies them — while
 * `--allow-payg` is a policy change and is applied here.
 *
 * Opt-in only: `allowPayg: false` does not force the policy back to false. The
 * flag exists to admit pay-as-you-go, so an absent or false flag means "say
 * nothing", and an overlay that opted PAYG in keeps its say.
 */
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
    if (!Number.isFinite(at) || at >= cutoff) continue;
    const ageDays = Math.floor((now - at) / (24 * 60 * 60 * 1000));
    // `code` and `message` and nothing else are what a decision document may
    // carry: `warnings` in `schemas/model-routing/decision.schema.json` is
    // closed on exactly those two. Everything below them is for a caller that
    // wants the facts without parsing prose, and PB-18 copies the first two
    // rather than translating.
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
  return out;
}

/**
 * Merge the whole stack. A pure function of its arguments — the layer ORDER of
 * `overlays` is the precedence order, and swapping two entries changes the
 * result. That is the property the merge test pins.
 */
export function mergeRouting({ canonical, overlays = [], constraints = null, now = Date.now() } = {}) {
  if (!isObject(canonical)) throw new GateError('mergeRouting: no canonical catalog');
  if (canonical.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new GateError(`catalog schemaVersion ${canonical.schemaVersion} is not the supported ${CATALOG_SCHEMA_VERSION}`);
  }
  let policy = clone(DEFAULT_POLICY);
  let tuples = clone(canonical.tuples ?? []);
  const applied = [];
  // Who wrote each key a diagnostic has to name. A weight set has one writer and
  // is keyed by strategy; an allow or a deny list has as many writers as there
  // are layers that stated one, so those are kept as a list of rules instead.
  // `DEFAULTS` is a layer id like any other: a weight set nobody touched is
  // still attributable, and "the defaults" is a better answer than the whole
  // stack.
  const sources = {
    weights: Object.fromEntries(WEIGHT_STRATEGIES.map((n) => [n, DEFAULTS])),
    rules: [],
    defaults: {},
    account: {},
    // Layers that stated `qualityFloor.reviewer` AND the `reviewerQualityFloor`
    // alias. Lawful — the explicit key wins — and a `validate` warning, because
    // a file saying one thing twice is a file whose author expected one of the
    // two to do something.
    floorAlias: [],
  };
  for (const layer of overlays) {
    if (!layer?.present || !isObject(layer.data)) continue;
    if (layer.data.schemaVersion !== OVERLAY_SCHEMA_VERSION) {
      throw new GateError(`overlay "${layer.id}" schemaVersion ${layer.data.schemaVersion} `
        + `is not the supported ${OVERLAY_SCHEMA_VERSION} (${layer.path})`);
    }
    policy = applyOverlayToPolicy(policy, layer.data, sources, layer.id);
    tuples = applyOverlayToTuples(tuples, layer.data);
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
    warnings: staleWarnings(tuples, now),
  };
}

/**
 * The whole load in one call: read the shipped catalog, read every overlay the
 * host declares, merge in the host's order, apply the caller's constraints.
 *
 * `layers` comes back with the paths and whether each one was there, because
 * the decision output names a layer by its `id` — "denied by overlay
 * \"workspace\"" — and a person still has to be able to find the file.
 */
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

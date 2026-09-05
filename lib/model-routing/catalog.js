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
  reviewerQualityFloor: 4,
  allow: Object.freeze({}),
  deny: Object.freeze({}),
  payg: Object.freeze({ allow: false }),
});

/** The four strategy names `--strategy` accepts. `auto` is a skill decision, never a value here. */
export const STRATEGIES = ['quality', 'balanced', 'speed', 'economy'];

/** The names an allow or a deny rule can select by. */
export const SELECTOR_KINDS = ['harnesses', 'models', 'efforts', 'tuples'];

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
  const overlays = declared.map((layer) => ({
    id: layer.id,
    path: layer.path,
    ...readLayerFile(layer.path),
  }));
  return { canonical: { ...canonical, id: 'catalog', path: catalogFile }, overlays };
}

// --- the merge itself --------------------------------------------------------
//
// Three different rules live here, and they differ on purpose:
//
//   * a weight SET is replaced whole. Half-replacing one would silently stop it
//     summing to 100, and the resolver would divide a component back by a weight
//     nobody chose;
//   * an allow or deny list is replaced whole PER SELECTOR KIND. A higher layer
//     that names `deny.models` writes that list instead of the one below —
//     it does not add to it. What it CANNOT do is clear one: the overlay schema
//     has no empty list and no reset, so a layer can replace a ban with a
//     different ban but never with none. That is deliberate for a consumer
//     policy layer, whose bans are meant to survive a person's workspace file,
//     and it is the whole story — PB-13.3 asks whether an explicit reset belongs in the
//     schema;
//   * everything else merges field by field: a penalty, a bonus, one rating of
//     one tuple. Naming a field is how an overlay changes it, and not naming it
//     is how it leaves the layer below alone.
//
// Every one of those writes is recorded, keyed the way the rule is keyed — a
// weight set by strategy, an allow or deny list by selector kind. The decision
// output and `validate` name a layer by its id ("denied by overlay
// \"workspace\""), and without provenance the only honest answer would be the
// whole stack.

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

function mergeSelectors(base, patch, note) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const kind of SELECTOR_KINDS) {
    if (!Array.isArray(patch[kind])) continue;
    out[kind] = [...patch[kind]];
    note(kind);
  }
  return out;
}

function applyOverlayToPolicy(policy, overlay, sources, layerId) {
  return {
    weights: mergeWeights(policy.weights, overlay.weights, (n) => { sources.weights[n] = layerId; }),
    penalties: mergeFlat(policy.penalties, overlay.penalties),
    bonuses: mergeFlat(policy.bonuses, overlay.bonuses),
    reviewerQualityFloor: overlay.reviewerQualityFloor ?? policy.reviewerQualityFloor,
    allow: mergeSelectors(policy.allow, overlay.allow, (k) => { sources.allow[k] = layerId; }),
    deny: mergeSelectors(policy.deny, overlay.deny, (k) => { sources.deny[k] = layerId; }),
    payg: mergeFlat(policy.payg, overlay.payg),
  };
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
  // Who last wrote each key that a diagnostic has to name. `DEFAULTS` is a
  // layer id like any other: a weight set nobody touched is still attributable,
  // and "the defaults" is a better answer than the whole stack.
  const sources = {
    weights: Object.fromEntries(STRATEGIES.map((n) => [n, DEFAULTS])),
    allow: Object.fromEntries(SELECTOR_KINDS.map((k) => [k, DEFAULTS])),
    deny: Object.fromEntries(SELECTOR_KINDS.map((k) => [k, DEFAULTS])),
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

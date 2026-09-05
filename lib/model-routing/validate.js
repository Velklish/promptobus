// `models validate` as a library function: what is wrong with the catalog and
// the overlays, before anything tries to route on them.
//
// It is a library function and not a command on purpose. PB-21 wires the
// `promptobus models validate` subcommand to it; the resolver calls the same
// function on the same layers; and a consumer that ships a policy layer of its
// own can check that layer without a subprocess.
//
// **Production reads no JSON Schema.** The grammar below is the same grammar as
// `schemas/model-routing/*.schema.json`, written by hand for the same reason
// [src/v1/validate.ts](../../src/v1/validate.ts) gives: the package must run
// with no runtime dependency, and ajv is a devDependency. Two descriptions of
// one contract drift, so a parity check on shared documents lives in
// [test/model-routing-catalog.test.mjs](../../test/model-routing-catalog.test.mjs)
// — edit one, edit the other, or the red comes from there.
//
// Verdict shape: `{ ok, errors, warnings }`. An error carries the code the
// reference table names (`catalog-invalid`, `overlay-invalid` —
// [03-cli](../../docs/reference/03-cli.md)), the layer id it belongs to, and
// the field it is about. A warning never makes `ok` false: a stale rating is a
// warning by ADR-003, and the canonical-priority checks are warnings because
// the priority scheme is documented convention rather than schema.
import { existsSync, readFileSync } from 'node:fs';

import { REGISTRY } from '../drivers.js';
import {
  CATALOG_FILE, CATALOG_SCHEMA_VERSION, DEFAULTS, OVERLAY_SCHEMA_VERSION,
  SELECTOR_KINDS, STRATEGIES, mergeRouting,
} from './catalog.js';

const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const TUPLE_ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const HARNESS_RE = /^[a-z][a-z0-9-]{0,31}$/;

const ROLES = ['worker', 'reviewer'];
const RATING_KEYS = ['quality', 'speed', 'quotaCost'];
const WEIGHT_KEYS = ['quality', 'speed', 'quotaCost', 'remaining'];
const PRICE_KEYS = ['inputPerMTok', 'cachedInputPerMTok', 'outputPerMTok'];
const BILLING = ['subscription', 'payg'];

const TUPLE_KEYS = [
  'id', 'harness', 'model', 'effort', 'roles', 'ratings', 'roleRatings',
  'prices', 'billing', 'priority', 'assessedAt', 'source', 'evidence',
];
const TUPLE_REQUIRED = [
  'id', 'harness', 'model', 'effort', 'roles', 'ratings', 'prices',
  'billing', 'priority', 'assessedAt', 'source',
];
const CATALOG_KEYS = ['schemaVersion', 'updated', 'tuples'];
const OVERLAY_KEYS = [
  'schemaVersion', 'note', 'weights', 'penalties', 'bonuses',
  'reviewerQualityFloor', 'allow', 'deny', 'ratings', 'priority', 'payg',
];
const PENALTY_KEYS = ['unknownAvailability', 'liveParticipantPerHarness', 'liveParticipantCap'];
const BONUS_KEYS = ['reviewerDiversity'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRating = (v) => Number.isInteger(v) && v >= 1 && v <= 5;
const isText = (v) => typeof v === 'string' && v.length > 0;

/** Harnesses this CLI can actually launch. A tuple naming anything else is unroutable by construction. */
export function knownHarnesses() {
  return Object.keys(REGISTRY.drivers);
}

/** Effort levels of one harness, from that driver's own dictionary. Unknown harness — an empty list. */
export function effortLevelsOf(harness) {
  return REGISTRY.drivers[harness]?.options?.effortLevels ?? [];
}

function extras(value, allowed) {
  return Object.keys(value).filter((k) => !allowed.includes(k));
}

// --- grammar -----------------------------------------------------------------

function checkRatings(value, at, push, { partial = false } = {}) {
  if (!isObject(value)) return push(at, 'expected an object of ratings');
  const unknown = extras(value, RATING_KEYS);
  if (unknown.length) push(at, `unknown rating ${unknown.join(', ')}`);
  if (partial && !Object.keys(value).length) push(at, 'names no rating — an empty override changes nothing');
  for (const key of RATING_KEYS) {
    if (value[key] === undefined) {
      if (!partial) push(`${at}.${key}`, 'is required');
      continue;
    }
    if (!isRating(value[key])) push(`${at}.${key}`, 'expected an integer from 1 to 5');
  }
  return undefined;
}

function checkTuple(tuple, at, push) {
  if (!isObject(tuple)) return push(at, 'expected an object');
  const unknown = extras(tuple, TUPLE_KEYS);
  if (unknown.length) push(at, `unknown field ${unknown.join(', ')}`);
  for (const key of TUPLE_REQUIRED) {
    if (tuple[key] === undefined) push(`${at}.${key}`, 'is required');
  }
  if (tuple.id !== undefined && !(isText(tuple.id) && TUPLE_ID_RE.test(tuple.id))) {
    push(`${at}.id`, `does not match ${TUPLE_ID_RE.source}`);
  }
  if (tuple.harness !== undefined && !(isText(tuple.harness) && HARNESS_RE.test(tuple.harness))) {
    push(`${at}.harness`, `does not match ${HARNESS_RE.source}`);
  }
  if (tuple.model !== undefined && !isText(tuple.model)) push(`${at}.model`, 'expected a non-empty string');
  if (tuple.effort !== undefined && tuple.effort !== null && !isText(tuple.effort)) {
    push(`${at}.effort`, 'expected a non-empty string or null');
  }
  if (tuple.roles !== undefined) {
    if (!Array.isArray(tuple.roles) || !tuple.roles.length) push(`${at}.roles`, 'expected a non-empty array');
    else {
      if (new Set(tuple.roles).size !== tuple.roles.length) push(`${at}.roles`, 'repeats a role');
      for (const role of tuple.roles) {
        if (!ROLES.includes(role)) push(`${at}.roles`, `unknown role "${role}" — allowed: ${ROLES.join(', ')}`);
      }
    }
  }
  if (tuple.ratings !== undefined) checkRatings(tuple.ratings, `${at}.ratings`, push);
  if (tuple.roleRatings !== undefined) {
    if (!isObject(tuple.roleRatings)) push(`${at}.roleRatings`, 'expected an object');
    else {
      const unknownRoles = extras(tuple.roleRatings, ROLES);
      if (unknownRoles.length) push(`${at}.roleRatings`, `unknown role ${unknownRoles.join(', ')}`);
      for (const role of ROLES) {
        if (tuple.roleRatings[role] === undefined) continue;
        checkRatings(tuple.roleRatings[role], `${at}.roleRatings.${role}`, push, { partial: true });
      }
    }
  }
  if (tuple.prices !== undefined) {
    if (!isObject(tuple.prices)) push(`${at}.prices`, 'expected an object');
    else {
      const unknownPrices = extras(tuple.prices, PRICE_KEYS);
      if (unknownPrices.length) push(`${at}.prices`, `unknown price ${unknownPrices.join(', ')}`);
      for (const key of PRICE_KEYS) {
        const price = tuple.prices[key];
        if (price === undefined) push(`${at}.prices.${key}`, 'is required — write null when there is no published price');
        else if (price !== null && !(typeof price === 'number' && price >= 0)) {
          push(`${at}.prices.${key}`, 'expected a number not below zero, or null');
        }
      }
    }
  }
  if (tuple.billing !== undefined && !BILLING.includes(tuple.billing)) {
    push(`${at}.billing`, `expected one of ${BILLING.join(', ')}`);
  }
  if (tuple.priority !== undefined && !(Number.isInteger(tuple.priority) && tuple.priority >= 0)) {
    push(`${at}.priority`, 'expected an integer not below zero');
  }
  if (tuple.assessedAt !== undefined && !(isText(tuple.assessedAt) && TIMESTAMP_RE.test(tuple.assessedAt))) {
    push(`${at}.assessedAt`, 'expected the exact form Date#toISOString prints');
  }
  if (tuple.source !== undefined && !isText(tuple.source)) {
    push(`${at}.source`, 'is required and non-empty — a rating with no source is a hypothesis');
  }
  if (tuple.evidence !== undefined && typeof tuple.evidence !== 'string') {
    push(`${at}.evidence`, 'expected a string');
  }
  return undefined;
}

/** Grammar of the shipped catalog. Returns a list of `{ at, note }`; empty means the shape holds. */
export function checkCatalogShape(doc) {
  const found = [];
  const push = (at, note) => found.push({ at, note });
  if (!isObject(doc)) {
    push('', 'expected an object');
    return found;
  }
  const unknown = extras(doc, CATALOG_KEYS);
  if (unknown.length) push('', `unknown field ${unknown.join(', ')}`);
  if (doc.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    push('schemaVersion', `expected ${CATALOG_SCHEMA_VERSION}`);
  }
  if (!(isText(doc.updated) && TIMESTAMP_RE.test(doc.updated))) {
    push('updated', 'expected the exact form Date#toISOString prints');
  }
  if (!Array.isArray(doc.tuples) || !doc.tuples.length) {
    push('tuples', 'expected a non-empty array');
    return found;
  }
  doc.tuples.forEach((tuple, i) => checkTuple(tuple, `tuples[${i}]`, push));
  return found;
}

function checkNameList(value, at, push) {
  if (!Array.isArray(value) || !value.length) return push(at, 'expected a non-empty array');
  if (new Set(value).size !== value.length) push(at, 'repeats a name');
  for (const name of value) if (!isText(name)) push(at, 'expected non-empty strings');
  return undefined;
}

function checkSelectors(value, at, push) {
  if (!isObject(value)) return push(at, 'expected an object');
  if (!Object.keys(value).length) {
    return push(at, 'names no selector — an empty rule is a shape error, not "allow nothing"');
  }
  const unknown = extras(value, SELECTOR_KINDS);
  if (unknown.length) push(at, `unknown selector ${unknown.join(', ')}`);
  for (const kind of SELECTOR_KINDS) {
    if (value[kind] === undefined) continue;
    checkNameList(value[kind], `${at}.${kind}`, push);
  }
  return undefined;
}

function checkIdMap(value, at, push, checkValue) {
  if (!isObject(value)) return push(at, 'expected an object keyed by tuple id');
  if (!Object.keys(value).length) return push(at, 'is empty — remove it instead');
  for (const [id, entry] of Object.entries(value)) {
    if (!TUPLE_ID_RE.test(id)) push(`${at}.${id}`, `key does not match ${TUPLE_ID_RE.source}`);
    checkValue(entry, `${at}.${id}`);
  }
  return undefined;
}

/** Grammar of one overlay. Every field is optional except `schemaVersion`. */
export function checkOverlayShape(doc) {
  const found = [];
  const push = (at, note) => found.push({ at, note });
  if (!isObject(doc)) {
    push('', 'expected an object');
    return found;
  }
  const unknown = extras(doc, OVERLAY_KEYS);
  if (unknown.length) push('', `unknown field ${unknown.join(', ')}`);
  if (doc.schemaVersion !== OVERLAY_SCHEMA_VERSION) push('schemaVersion', `expected ${OVERLAY_SCHEMA_VERSION}`);
  if (doc.note !== undefined && typeof doc.note !== 'string') push('note', 'expected a string');
  if (doc.weights !== undefined) {
    if (!isObject(doc.weights)) push('weights', 'expected an object');
    else {
      const unknownStrategies = extras(doc.weights, STRATEGIES);
      if (unknownStrategies.length) push('weights', `unknown strategy ${unknownStrategies.join(', ')}`);
      for (const name of STRATEGIES) {
        const set = doc.weights[name];
        if (set === undefined) continue;
        if (!isObject(set)) {
          push(`weights.${name}`, 'expected an object of four weights');
          continue;
        }
        const unknownWeights = extras(set, WEIGHT_KEYS);
        if (unknownWeights.length) push(`weights.${name}`, `unknown weight ${unknownWeights.join(', ')}`);
        for (const key of WEIGHT_KEYS) {
          const w = set[key];
          if (w === undefined) push(`weights.${name}.${key}`, 'is required — a weight set is replaced whole');
          else if (!(typeof w === 'number' && w >= 0 && w <= 100)) {
            push(`weights.${name}.${key}`, 'expected a percent from 0 to 100');
          }
        }
      }
    }
  }
  for (const [field, keys] of [['penalties', PENALTY_KEYS], ['bonuses', BONUS_KEYS]]) {
    if (doc[field] === undefined) continue;
    if (!isObject(doc[field])) {
      push(field, 'expected an object');
      continue;
    }
    const unknownKeys = extras(doc[field], keys);
    if (unknownKeys.length) push(field, `unknown key ${unknownKeys.join(', ')}`);
    for (const key of keys) {
      const v = doc[field][key];
      if (v === undefined) continue;
      if (!(typeof v === 'number' && v >= 0)) push(`${field}.${key}`, 'expected a number not below zero');
    }
  }
  if (doc.reviewerQualityFloor !== undefined && !isRating(doc.reviewerQualityFloor)) {
    push('reviewerQualityFloor', 'expected an integer from 1 to 5');
  }
  if (doc.allow !== undefined) checkSelectors(doc.allow, 'allow', push);
  if (doc.deny !== undefined) checkSelectors(doc.deny, 'deny', push);
  if (doc.ratings !== undefined) {
    checkIdMap(doc.ratings, 'ratings', push, (entry, at) => checkRatings(entry, at, push, { partial: true }));
  }
  if (doc.priority !== undefined) {
    checkIdMap(doc.priority, 'priority', push, (entry, at) => {
      if (!(Number.isInteger(entry) && entry >= 0)) push(at, 'expected an integer not below zero');
    });
  }
  if (doc.payg !== undefined) {
    if (!isObject(doc.payg)) push('payg', 'expected an object');
    else {
      const unknownKeys = extras(doc.payg, ['allow']);
      if (unknownKeys.length) push('payg', `unknown key ${unknownKeys.join(', ')}`);
      if (doc.payg.allow !== undefined && typeof doc.payg.allow !== 'boolean') {
        push('payg.allow', 'expected a boolean');
      }
    }
  }
  return found;
}

// --- the verdict -------------------------------------------------------------

function collector() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    // `message`, not the `note` the grammar helpers pass around: the verdict is
    // the public shape and it shares a vocabulary with the decision document,
    // whose `warnings` are closed on `code` and `message`
    // (`schemas/model-routing/decision.schema.json`). `{ at, note }` stays the
    // internal shape of one grammar finding, and this collector is the boundary
    // between the two.
    error: (code, layer, at, message) => errors.push({ code, layer, at, message }),
    warn: (entry) => warnings.push(entry),
  };
}

function referenceChecks(out, layer, doc, catalogFacts) {
  const { ids, models, harnesses, efforts } = catalogFacts;
  const bad = (at, note) => out.error('overlay-invalid', layer.id, at, note);
  for (const field of ['ratings', 'priority']) {
    if (!isObject(doc[field])) continue;
    for (const id of Object.keys(doc[field])) {
      if (!ids.has(id)) bad(`${field}.${id}`, `no tuple with id "${id}" in the merged catalog`);
    }
  }
  for (const rule of ['allow', 'deny']) {
    const selectors = doc[rule];
    if (!isObject(selectors)) continue;
    for (const id of selectors.tuples ?? []) {
      if (!ids.has(id)) bad(`${rule}.tuples`, `no tuple with id "${id}" in the merged catalog`);
    }
    for (const name of selectors.harnesses ?? []) {
      if (!harnesses.has(name)) {
        bad(`${rule}.harnesses`, `unknown harness "${name}" — this CLI drives ${knownHarnesses().join(', ')}`);
      }
    }
    for (const name of selectors.models ?? []) {
      if (!models.has(name)) bad(`${rule}.models`, `no tuple in the merged catalog uses model "${name}"`);
    }
    for (const name of selectors.efforts ?? []) {
      if (!efforts.has(name)) {
        bad(`${rule}.efforts`, `no harness of this CLI names effort "${name}", and no tuple uses it`);
      }
    }
  }
}

function contradictionChecks(out, policy, sources) {
  // allow and deny are merged per selector kind, so the contradiction is
  // between the MERGED lists rather than inside one file: a person who denies a
  // model in the user layer and allows it in the workspace layer has written
  // two rules that cannot both hold.
  //
  // `layer` is the layer that wrote the DENY list, because deny is applied
  // after allow and is therefore the half that takes effect. Where the allow
  // list came from another file, the message names that one too — a diagnostic
  // that named only one of two files would send the reader to the wrong editor.
  for (const kind of SELECTOR_KINDS) {
    const allow = policy.allow?.[kind] ?? [];
    const deny = policy.deny?.[kind] ?? [];
    const allowFrom = sources.allow?.[kind] ?? DEFAULTS;
    const denyFrom = sources.deny?.[kind] ?? DEFAULTS;
    for (const name of allow) {
      if (!deny.includes(name)) continue;
      const where = allowFrom === denyFrom
        ? `both rules are in "${denyFrom}"`
        : `allowed by "${allowFrom}", denied by "${denyFrom}"`;
      out.error('overlay-invalid', denyFrom, `deny.${kind}`,
        `"${name}" is both allowed and denied — deny is applied after allow, so the allow rule `
        + `can never take effect (${where})`);
    }
  }
}

function weightChecks(out, policy, sources) {
  for (const name of STRATEGIES) {
    const from = sources.weights?.[name] ?? DEFAULTS;
    const set = policy.weights?.[name];
    if (!isObject(set)) {
      out.error('overlay-invalid', from, `weights.${name}`, 'the merged policy has no weight set for this strategy');
      continue;
    }
    const sum = WEIGHT_KEYS.reduce((a, k) => a + (typeof set[k] === 'number' ? set[k] : 0), 0);
    if (Math.round(sum * 100) / 100 !== 100) {
      out.error('overlay-invalid', from, `weights.${name}`, `the four weights sum to ${sum}, not 100`);
    }
  }
}

function catalogSemantics(out, tuples) {
  const seen = new Set();
  for (const tuple of tuples) {
    if (!isText(tuple?.id)) continue;
    if (seen.has(tuple.id)) {
      out.error('catalog-invalid', 'catalog', `tuples.${tuple.id}`,
        'duplicate tuple id — the resolver\'s last tie-break is the id, and a duplicate makes the pick order-dependent');
    }
    seen.add(tuple.id);
    if (!isText(tuple.harness)) continue;
    if (!knownHarnesses().includes(tuple.harness)) {
      out.error('catalog-invalid', 'catalog', `tuples.${tuple.id}.harness`,
        `unknown harness "${tuple.harness}" — this CLI drives ${knownHarnesses().join(', ')}`);
      continue;
    }
    if (tuple.effort === null || tuple.effort === undefined) continue;
    const levels = effortLevelsOf(tuple.harness);
    if (!levels.includes(tuple.effort)) {
      out.error('catalog-invalid', 'catalog', `tuples.${tuple.id}.effort`,
        `"${tuple.effort}" is not an effort level of ${tuple.harness} — allowed: ${levels.join(', ')}`);
    }
  }
}

// Canonical priority is a documented convention rather than a schema rule
// ([guides/model-routing.md](../../docs/guides/model-routing.md)): harness
// blocks in the order `REGISTRY` lists the drivers, and inside a block the
// tuples run from the highest quality down. A catalog that breaks it still
// routes — the resolver only uses priority as a tie-break — so this is a
// warning, and it exists so that the written rule is enforced rather than
// merely written.
function priorityChecks(out, tuples) {
  const byPriority = new Map();
  for (const tuple of tuples) {
    if (!Number.isInteger(tuple?.priority)) continue;
    if (byPriority.has(tuple.priority)) {
      out.warn({
        code: 'priority-duplicate',
        priority: tuple.priority,
        tupleIds: [byPriority.get(tuple.priority), tuple.id],
        message: `tuples "${byPriority.get(tuple.priority)}" and "${tuple.id}" share canonical priority `
          + `${tuple.priority}, so the tie-break falls through to the tuple id`,
      });
    } else byPriority.set(tuple.priority, tuple.id);
  }

  const order = knownHarnesses();
  const groups = new Map();
  for (const tuple of tuples) {
    if (!isText(tuple?.harness) || !Number.isInteger(tuple?.priority)) continue;
    if (!groups.has(tuple.harness)) groups.set(tuple.harness, []);
    groups.get(tuple.harness).push(tuple);
  }
  let ceiling = -1;
  for (const harness of order) {
    const group = groups.get(harness);
    if (!group?.length) continue;
    const sorted = [...group].sort((a, b) => a.priority - b.priority);
    if (sorted[0].priority <= ceiling) {
      out.warn({
        code: 'priority-not-canonical',
        harness,
        message: `the ${harness} block starts at ${sorted[0].priority}, inside the block above it — `
          + `harness blocks run in the order the driver registry lists them: ${order.join(', ')}`,
      });
    }
    ceiling = sorted[sorted.length - 1].priority;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].ratings?.quality > sorted[i - 1].ratings?.quality) {
        out.warn({
          code: 'priority-not-canonical',
          harness,
          tupleIds: [sorted[i - 1].id, sorted[i].id],
          message: `inside a harness block priority rises as quality falls; "${sorted[i].id}" `
            + `rates higher than "${sorted[i - 1].id}" but sits below it`,
        });
      }
    }
  }
}

/**
 * Validate a stack that is already in memory. Pure: the tests drive it with
 * documents rather than files, and `validate` below is the same call with the
 * reading done first.
 *
 * The grammar gate is deliberate — semantic checks run only on layers whose
 * shape held. A reference check against a `tuples` field that is not an array
 * would crash rather than report, and a person fixing a broken file wants the
 * shape error, not a stack trace behind it.
 */
export function validateLayers({ canonical, overlays = [], constraints = null, now = Date.now() } = {}) {
  const out = collector();
  const catalogShape = checkCatalogShape(canonical?.data);
  for (const { at, note } of catalogShape) {
    out.error('catalog-invalid', 'catalog', at, note);
  }

  const sound = [];
  for (const layer of overlays) {
    if (!layer.present) continue;
    const shape = checkOverlayShape(layer.data);
    for (const { at, note } of shape) out.error('overlay-invalid', layer.id, at, note);
    if (!shape.length) sound.push(layer);
  }

  if (catalogShape.length) return { ok: false, errors: out.errors, warnings: out.warnings };

  catalogSemantics(out, canonical.data.tuples);

  let merged;
  try {
    merged = mergeRouting({ canonical: canonical.data, overlays: sound, constraints, now });
  } catch (err) {
    out.error('overlay-invalid', 'merge', '', err.message);
    return { ok: false, errors: out.errors, warnings: out.warnings };
  }

  const facts = {
    ids: new Set(merged.tuples.map((t) => t.id)),
    models: new Set(merged.tuples.map((t) => t.model)),
    harnesses: new Set(knownHarnesses()),
    efforts: new Set([
      ...knownHarnesses().flatMap((h) => effortLevelsOf(h)),
      ...merged.tuples.map((t) => t.effort).filter((e) => typeof e === 'string'),
    ]),
  };
  for (const layer of sound) referenceChecks(out, layer, layer.data, facts);
  weightChecks(out, merged.policy, merged.sources);
  contradictionChecks(out, merged.policy, merged.sources);
  priorityChecks(out, merged.tuples);
  for (const warning of merged.warnings) out.warn(warning);

  return { ok: out.errors.length === 0, errors: out.errors, warnings: out.warnings };
}

/**
 * Read the shipped catalog and every overlay the host names, then validate the
 * stack. Unreadable JSON is a finding, not a throw: `models validate` is the
 * command a person runs precisely when a file is broken.
 */
export function validate({ host, constraints = null, catalogFile = CATALOG_FILE, now = Date.now() } = {}) {
  const read = (file, id, code) => {
    if (!existsSync(file)) return { id, path: file, present: false, data: null };
    try {
      return { id, path: file, present: true, data: JSON.parse(readFileSync(file, 'utf8')) };
    } catch (err) {
      return { id, path: file, present: true, data: null, failure: { code, note: err.message } };
    }
  };

  const canonical = read(catalogFile, 'catalog', 'catalog-invalid');
  const declared = host?.routingPaths?.()?.overlays ?? [];
  const overlays = declared.map((layer) => read(layer.path, layer.id, 'overlay-invalid'));
  const layers = [canonical, ...overlays].map(({ id, path: file, present }) => ({ id, path: file, present }));

  const broken = [canonical, ...overlays].filter((l) => l.failure);
  if (!canonical.present) {
    return {
      ok: false,
      layers,
      errors: [{ code: 'catalog-invalid', layer: 'catalog', at: '', message: `the shipped catalog is missing: ${catalogFile}` }],
      warnings: [],
    };
  }
  if (broken.length) {
    return {
      ok: false,
      layers,
      errors: broken.map((l) => ({ code: l.failure.code, layer: l.id, at: '', message: `not valid JSON: ${l.failure.note}` })),
      warnings: [],
    };
  }

  return { ...validateLayers({ canonical, overlays, constraints, now }), layers };
}

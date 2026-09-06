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
import { MODEL_FLAGS } from './cache.js';
import {
  CATALOG_FILE, CATALOG_SCHEMA_VERSION, DEFAULTS as DEFAULTS_LAYER, OVERLAY_SCHEMA_VERSION, RULE_ROLES,
  SCALED_OVERLAY_KEYS,
  SELECTOR_KINDS, STRATEGIES, WEIGHT_STRATEGIES, mergeRouting, rulePath, rulesFor, rulesForRole, rulesLabel,
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
  'schemaVersion', 'note', 'weights', 'penalties', 'bonuses', 'reviewerQualityFloor', 'qualityFloor',
  'balance', 'nearLimit', 'defaults', 'account', 'allow', 'deny', 'ratings', 'priority', 'payg',
];
const BALANCE_KEYS = ['band', 'spendUnit'];
const NEAR_LIMIT_KEYS = ['usedPercent', 'underspend'];
const DEFAULTS_KEYS = ['strategy'];
const ACCOUNT_KEYS = ['plan'];
const PENALTY_KEYS = ['unknownAvailability', 'liveParticipantPerHarness', 'liveParticipantCap'];
const BONUS_KEYS = ['reviewerDiversity'];
const EVIDENCE_KEYS = ['text', 'sources', 'interpolatedFrom', 'hypothesis'];
const CITATION_KEYS = ['rating', 'basis', 'version', 'agentHarness', 'provenance', 'figure', 'url', 'date'];
const CITATION_REQUIRED = ['rating', 'basis', 'version', 'agentHarness', 'figure', 'url', 'date'];
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRating = (v) => Number.isInteger(v) && v >= 1 && v <= 10;
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
    if (!isRating(value[key])) push(`${at}.${key}`, 'expected an integer from 1 to 10');
  }
  return undefined;
}

// One citation. The shape mirrors `citation` in
// schemas/model-routing/catalog.schema.json, hand-written for the reason the
// header gives: production reads no JSON Schema, and the parity check in
// test/model-routing-catalog.test.mjs is what keeps the two from drifting.
function checkCitation(citation, at, push) {
  if (!isObject(citation)) return push(at, 'expected an object');
  const unknown = extras(citation, CITATION_KEYS);
  if (unknown.length) push(at, `unknown field ${unknown.join(', ')}`);
  for (const key of CITATION_REQUIRED) {
    if (citation[key] === undefined) push(`${at}.${key}`, 'is required');
  }
  if (citation.rating !== undefined && !RATING_KEYS.includes(citation.rating)) {
    push(`${at}.rating`, `expected one of ${RATING_KEYS.join(', ')}`);
  }
  for (const key of ['basis', 'version', 'agentHarness', 'provenance', 'figure', 'url']) {
    if (citation[key] !== undefined && !isText(citation[key])) {
      push(`${at}.${key}`, 'expected a non-empty string');
    }
  }
  if (citation.date !== undefined && !(isText(citation.date) && DATE_RE.test(citation.date))) {
    push(`${at}.date`, 'expected the date the source was seen, as YYYY-MM-DD');
  }
  return undefined;
}

// The object form of `evidence` (ADR-004). The string form is the v1 shape and
// is still lawful; a row that is neither is a shape error here.
function checkCitedEvidence(evidence, at, push) {
  if (!isObject(evidence)) return push(at, 'expected a string, or an object of { text, sources, interpolatedFrom, hypothesis }');
  const unknown = extras(evidence, EVIDENCE_KEYS);
  if (unknown.length) push(at, `unknown field ${unknown.join(', ')}`);
  if (!isText(evidence.text)) push(`${at}.text`, 'is required and non-empty');
  if (evidence.sources !== undefined) {
    if (!Array.isArray(evidence.sources) || !evidence.sources.length) {
      push(`${at}.sources`, 'expected a non-empty array — omit it rather than writing an empty one');
    } else {
      evidence.sources.forEach((citation, i) => checkCitation(citation, `${at}.sources[${i}]`, push));
    }
  }
  if (evidence.interpolatedFrom !== undefined
    && !(isText(evidence.interpolatedFrom) && TUPLE_ID_RE.test(evidence.interpolatedFrom))) {
    push(`${at}.interpolatedFrom`, `does not match ${TUPLE_ID_RE.source}`);
  }
  if (evidence.hypothesis !== undefined) {
    if (!Array.isArray(evidence.hypothesis) || !evidence.hypothesis.length) {
      push(`${at}.hypothesis`, 'expected a non-empty array of rating names');
    } else {
      if (new Set(evidence.hypothesis).size !== evidence.hypothesis.length) {
        push(`${at}.hypothesis`, 'repeats a rating');
      }
      for (const rating of evidence.hypothesis) {
        if (!RATING_KEYS.includes(rating)) {
          push(`${at}.hypothesis`, `unknown rating "${rating}" — allowed: ${RATING_KEYS.join(', ')}`);
        }
      }
    }
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
    checkCitedEvidence(tuple.evidence, `${at}.evidence`, push);
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

/** `null` when the list is well formed, a marker when it is not — `checkFlagList` reads that. */
function checkNameList(value, at, push) {
  if (!Array.isArray(value) || !value.length) {
    push(at, 'expected a non-empty array');
    return 'shape';
  }
  if (new Set(value).size !== value.length) push(at, 'repeats a name');
  for (const name of value) if (!isText(name)) push(at, 'expected non-empty strings');
  return undefined;
}

/**
 * `flags` names a mark the SNAPSHOT carries, and it is the one selector whose
 * names are in no catalog — so a typo has nothing to be caught against except a
 * closed list, which is what `MODEL_FLAGS` is (ADR-004).
 */
function checkFlagList(value, at, push) {
  if (checkNameList(value, at, push) !== undefined) return undefined;
  for (const name of value) {
    if (!MODEL_FLAGS.includes(name)) {
      push(at, `unknown flag "${name}" — a snapshot carries ${MODEL_FLAGS.join(', ')}`);
    }
  }
  return undefined;
}

function checkFlatSelectors(value, at, push, allowed) {
  if (!isObject(value)) return push(at, 'expected an object');
  if (!Object.keys(value).length) {
    return push(at, 'names no selector — an empty rule is a shape error, not "allow nothing"');
  }
  const unknown = extras(value, allowed);
  if (unknown.length) push(at, `unknown selector ${unknown.join(', ')}`);
  for (const kind of SELECTOR_KINDS) {
    if (value[kind] === undefined) continue;
    if (kind === 'flags') checkFlagList(value[kind], `${at}.${kind}`, push);
    else checkNameList(value[kind], `${at}.${kind}`, push);
  }
  return undefined;
}

function checkSelectors(value, at, push) {
  const done = checkFlatSelectors(value, at, push, [...SELECTOR_KINDS, 'byRole']);
  if (done !== undefined || value.byRole === undefined) return done;
  if (!isObject(value.byRole)) return push(`${at}.byRole`, 'expected an object keyed by role');
  if (!Object.keys(value.byRole).length) {
    return push(`${at}.byRole`, 'names no role — an empty block scopes nothing');
  }
  const unknownRoles = extras(value.byRole, RULE_ROLES);
  if (unknownRoles.length) {
    push(`${at}.byRole`, `unknown role ${unknownRoles.join(', ')} — allowed: ${RULE_ROLES.join(', ')}`);
  }
  for (const role of RULE_ROLES) {
    if (value.byRole[role] === undefined) continue;
    // No `byRole` inside `byRole`: a rule is scoped to one role or to none, and
    // a second nesting would be a role that is also another role.
    checkFlatSelectors(value.byRole[role], `${at}.byRole.${role}`, push, SELECTOR_KINDS);
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
  const scaled = doc.schemaVersion === 1
    ? SCALED_OVERLAY_KEYS.filter((key) => Object.hasOwn(doc, key))
    : [];
  if (scaled.length) {
    push('schemaVersion',
      `rewrite ${scaled.map((key) => `\`${key}\``).join(' and ')} on the 1–10 scale `
      + 'and set `schemaVersion: 2`');
  } else if (doc.schemaVersion !== OVERLAY_SCHEMA_VERSION && doc.schemaVersion !== 1) {
    push('schemaVersion', `expected ${OVERLAY_SCHEMA_VERSION}`);
  }
  if (doc.note !== undefined && typeof doc.note !== 'string') push('note', 'expected a string');
  if (doc.weights !== undefined) {
    if (!isObject(doc.weights)) push('weights', 'expected an object');
    else {
      // `balance` is not among them and cannot be: it has no weight set of its
      // own and orders tuples by the merged `balanced` weights (ADR-004).
      const unknownStrategies = extras(doc.weights, WEIGHT_STRATEGIES);
      if (unknownStrategies.length) push('weights', `unknown strategy ${unknownStrategies.join(', ')}`);
      for (const name of WEIGHT_STRATEGIES) {
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
    push('reviewerQualityFloor', 'expected an integer from 1 to 10');
  }
  if (doc.qualityFloor !== undefined) {
    if (!isObject(doc.qualityFloor)) push('qualityFloor', 'expected an object keyed by role');
    else {
      if (!Object.keys(doc.qualityFloor).length) push('qualityFloor', 'names no role — an empty block changes nothing');
      const unknownRoles = extras(doc.qualityFloor, RULE_ROLES);
      if (unknownRoles.length) {
        push('qualityFloor', `unknown role ${unknownRoles.join(', ')} — allowed: ${RULE_ROLES.join(', ')}`);
      }
      for (const role of RULE_ROLES) {
        if (doc.qualityFloor[role] === undefined) continue;
        if (!isRating(doc.qualityFloor[role])) push(`qualityFloor.${role}`, 'expected an integer from 1 to 10');
      }
    }
  }
  if (doc.balance !== undefined) {
    if (!isObject(doc.balance)) push('balance', 'expected an object');
    else {
      if (!Object.keys(doc.balance).length) push('balance', 'names no key — an empty block changes nothing');
      const unknownKeys = extras(doc.balance, BALANCE_KEYS);
      if (unknownKeys.length) push('balance', `unknown key ${unknownKeys.join(', ')}`);
      for (const key of BALANCE_KEYS) {
        const v = doc.balance[key];
        if (v === undefined) continue;
        if (!(typeof v === 'number' && v >= 0)) {
          push(`balance.${key}`, 'expected a number not below zero — percentage points of a window');
        }
      }
    }
  }
  if (doc.nearLimit !== undefined) {
    if (!isObject(doc.nearLimit)) push('nearLimit', 'expected an object');
    else {
      if (!Object.keys(doc.nearLimit).length) push('nearLimit', 'names no key — an empty block changes nothing');
      const unknownKeys = extras(doc.nearLimit, NEAR_LIMIT_KEYS);
      if (unknownKeys.length) push('nearLimit', `unknown key ${unknownKeys.join(', ')}`);
      if (doc.nearLimit.usedPercent !== undefined
        && !(typeof doc.nearLimit.usedPercent === 'number'
          && doc.nearLimit.usedPercent >= 0 && doc.nearLimit.usedPercent <= 100)) {
        push('nearLimit.usedPercent', 'expected a percent from 0 to 100');
      }
      // Negative on purpose and unbounded below: it is an underspend, and the
      // line is raised when the account is further AHEAD of pace than this. A
      // positive value would fire on every harness that is behind pace, which is
      // every harness the balance strategy is happy about.
      if (doc.nearLimit.underspend !== undefined && typeof doc.nearLimit.underspend !== 'number') {
        push('nearLimit.underspend', 'expected a number — percentage points of a window, normally negative');
      }
    }
  }
  if (doc.defaults !== undefined) {
    if (!isObject(doc.defaults)) push('defaults', 'expected an object');
    else {
      if (!Object.keys(doc.defaults).length) push('defaults', 'names no key — an empty block changes nothing');
      const unknownKeys = extras(doc.defaults, DEFAULTS_KEYS);
      if (unknownKeys.length) push('defaults', `unknown key ${unknownKeys.join(', ')}`);
      if (doc.defaults.strategy !== undefined && !STRATEGIES.includes(doc.defaults.strategy)) {
        push('defaults.strategy', `expected one of ${STRATEGIES.join(', ')} — `
          + '"auto" is not one of them: classifying a task into a strategy is the agent\'s decision');
      }
    }
  }
  if (doc.account !== undefined) {
    if (!isObject(doc.account)) push('account', 'expected an object keyed by harness');
    else {
      if (!Object.keys(doc.account).length) push('account', 'names no harness — an empty block changes nothing');
      for (const [harness, block] of Object.entries(doc.account)) {
        if (!HARNESS_RE.test(harness)) push(`account.${harness}`, `key does not match ${HARNESS_RE.source}`);
        if (!isObject(block)) {
          push(`account.${harness}`, 'expected an object');
          continue;
        }
        if (!Object.keys(block).length) push(`account.${harness}`, 'names no key — an empty block changes nothing');
        const unknownKeys = extras(block, ACCOUNT_KEYS);
        if (unknownKeys.length) push(`account.${harness}`, `unknown key ${unknownKeys.join(', ')}`);
        if (block.plan !== undefined && !isText(block.plan)) {
          push(`account.${harness}.plan`, 'expected a non-empty string');
        }
      }
    }
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
    // `rule` names the CHECK that fired, where a check has a name of its own:
    // `allow-intersection-empty`, `deny-covers-allow`. It is not a second error
    // code — `models validate` raises `verdict.errors[0].code`, so a new value
    // there would change what a consumer branching on `overlay-invalid`
    // receives, and ADR-004's supersession table adds no error code. It is the
    // name of the rule the finding is about, printed beside the layer.
    error: (code, layer, at, message, rule = null) => errors.push({
      code, layer, at, message, ...(rule ? { rule } : {}),
    }),
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
  // `flags` is not checked here and cannot be: a flag is a mark the snapshot
  // carries, not a catalog fact, so its names are checked against the closed
  // `MODEL_FLAGS` by the grammar above. Whether any model of a RUN carries one
  // is a question only a run can answer, and the resolver answers it with the
  // `flag-not-in-inventory` warning.
  for (const rule of ['allow', 'deny']) {
    const selectors = doc[rule];
    if (!isObject(selectors)) continue;
    const blocks = [[selectors, `${rule}`]];
    if (isObject(selectors.byRole)) {
      for (const role of RULE_ROLES) {
        if (isObject(selectors.byRole[role])) blocks.push([selectors.byRole[role], `${rule}.byRole.${role}`]);
      }
    }
    for (const [block, at] of blocks) {
      for (const id of block.tuples ?? []) {
        if (!ids.has(id)) bad(`${at}.tuples`, `no tuple with id "${id}" in the merged catalog`);
      }
      for (const name of block.harnesses ?? []) {
        if (!harnesses.has(name)) {
          bad(`${at}.harnesses`, `unknown harness "${name}" — this CLI drives ${knownHarnesses().join(', ')}`);
        }
      }
      for (const name of block.models ?? []) {
        if (!models.has(name)) bad(`${at}.models`, `no tuple in the merged catalog uses model "${name}"`);
      }
      for (const name of block.efforts ?? []) {
        if (!efforts.has(name)) {
          bad(`${at}.efforts`, `no harness of this CLI names effort "${name}", and no tuple uses it`);
        }
      }
    }
  }
}

/**
 * A name that one layer allows and another denies, over the rule PAIRS that can
 * both apply at once — two unscoped rules, or an unscoped one with a scoped one,
 * or two scoped to the same role.
 *
 * Pairs rather than merged lists, for two reasons. `at` has to name a path that
 * is actually in a file, and reading it off the rule that fired is the only way
 * to be sure of that — a check driven by the effective lists of a role would
 * report an unscoped rule at `deny.byRole.<role>.<kind>`, which nobody wrote.
 * And a pair is found once this way: a per-role sweep finds every unscoped pair
 * twice, once in each role's pass.
 *
 * `layer` is the layer that wrote the DENY half, because deny is applied after
 * allow and is therefore the half that takes effect. The message names the
 * other file too: a diagnostic naming one of two would send the reader to the
 * wrong editor.
 */
function shadowChecks(out, sources, kind) {
  const allowRules = rulesFor(sources, { rule: 'allow', kind, role: null });
  const denyRules = rulesFor(sources, { rule: 'deny', kind, role: null });
  for (const role of RULE_ROLES) {
    for (const r of rulesFor(sources, { rule: 'allow', kind, role })) {
      if (r.role === role) allowRules.push(r);
    }
    for (const r of rulesFor(sources, { rule: 'deny', kind, role })) {
      if (r.role === role) denyRules.push(r);
    }
  }
  for (const a of allowRules) {
    for (const d of denyRules) {
      // Rules scoped to different roles never both apply, so a name in both is
      // not a contradiction — it is two policies for two roles.
      if (a.role !== null && d.role !== null && a.role !== d.role) continue;
      const role = d.role ?? a.role;
      const scope = role ? ` when routing the ${role}` : '';
      for (const name of a.names) {
        if (!d.names.includes(name)) continue;
        if (a.layer === d.layer && a.role === d.role) {
          // One file that both allows and denies a name, at the same scope.
          // Nobody writes that on purpose, and under union there is no reading
          // of it that helps.
          out.error('overlay-invalid', d.layer, rulePath(d),
            `"${name}" is both allowed and denied in "${d.layer}"${scope} — deny is applied after allow, `
            + 'so the allow rule can never take effect');
        } else if (a.layer === d.layer) {
          // One file that allows a name and denies it FOR ONE ROLE. That is a
          // deliberate narrowing — "allow these harnesses; the reviewer never
          // runs on that one" — and it is the rule `byRole` was added to make
          // writable. Neither an error nor a warning: the allow list still takes
          // effect for the other role, and nothing was taken away by surprise.
          continue;
        } else {
          // Lawful under union, and deny wins. A warning rather than the error
          // it was under replacement, sending the person to the file that took
          // their allow list away (ADR-004).
          out.warn({
            code: 'allow-shadowed-by-deny',
            layer: d.layer,
            at: rulePath(d),
            message: `"${name}" is allowed by ${rulePath(a)} of "${a.layer}" and denied by `
              + `${rulePath(d)} of "${d.layer}"${scope} — lawful, and deny wins: no allow list anywhere `
              + `reaches a ban, because deny is applied after allow. Lifting it means editing "${d.layer}"`,
          });
        }
      }
    }
  }
}

/**
 * The two set-level checks, over the lists that are actually in force. `role` is
 * `null` for the unscoped lists and a role name when some layer scoped a rule of
 * this kind — the effective lists then differ per role, and only one of the two
 * may be broken.
 *
 * `at` is the path of the last rule that made up the half being reported, so it
 * names a line that exists rather than a shape of the merge.
 */
function setChecksForKind(out, policy, sources, kind, role) {
  const effective = role === null
    ? { allow: policy.allow ?? {}, deny: policy.deny ?? {} }
    : rulesForRole(policy, role);
  const allow = effective.allow?.[kind];
  const deny = effective.deny?.[kind] ?? [];
  const allowRules = rulesFor(sources, { rule: 'allow', kind, role });
  const denyRules = rulesFor(sources, { rule: 'deny', kind, role });
  const scope = role === null ? '' : ` when routing the ${role}`;
  const at = (rules, fallback) => (rules.length ? rulePath(rules[rules.length - 1]) : fallback);

  // Two layers narrowing different ways intersect to nothing, and every tuple is
  // then denied by policy from files that both say "allow". Without this check
  // the symptom would be `candidates-empty` with no explanation.
  if (Array.isArray(allow) && !allow.length && allowRules.length > 1) {
    out.error('overlay-invalid', allowRules[allowRules.length - 1].layer, at(allowRules, `allow.${kind}`),
      `the allow lists of ${rulesLabel(allowRules)} intersect to nothing${scope}, so no tuple is admitted `
      + '— an allow list is narrowed by every layer that states one and widened by none',
      'allow-intersection-empty');
  }

  if (Array.isArray(allow) && allow.length && deny.length && allow.every((n) => deny.includes(n))) {
    out.error('overlay-invalid', denyRules[denyRules.length - 1]?.layer ?? allowRules[0].layer,
      at(denyRules, `deny.${kind}`),
      `every name the merged allow list admits is denied${scope}: ${rulesLabel(allowRules)} allow `
      + `${allow.map((n) => `"${n}"`).join(', ')}, and ${rulesLabel(denyRules)} deny all of them`,
      'deny-covers-allow');
  }
}

/**
 * The allow and deny lists of the merged policy, checked under ADR-004's merge.
 *
 * The pairwise check runs once per kind, over the rules themselves. The
 * set-level checks need the lists in force, so they run per role for a kind some
 * layer scoped and once on the unscoped lists for a kind nobody did.
 */
function contradictionChecks(out, policy, sources) {
  const scoped = new Set((sources.rules ?? []).filter((r) => r.role !== null).map((r) => r.kind));
  for (const kind of SELECTOR_KINDS) {
    shadowChecks(out, sources, kind);
    if (scoped.has(kind)) {
      for (const role of RULE_ROLES) setChecksForKind(out, policy, sources, kind, role);
    } else setChecksForKind(out, policy, sources, kind, null);
  }
}

function weightChecks(out, policy, sources) {
  for (const name of WEIGHT_STRATEGIES) {
    const from = sources.weights?.[name] ?? DEFAULTS_LAYER;
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

// ADR-004 § Catalog ratings from published results: "`validate` refuses a rated
// row with no source, unless the row is marked interpolated." Applied per
// rating, because that is the grain the ADR rates at — a row can have a
// published price behind `quotaCost` and nothing behind `speed`, and saying so
// is the difference between a citation and a decoration.
//
// Three ways a rating is accounted for, and no fourth:
//
//   * `evidence.sources` names it — the figure, the field it was banded
//     against, the page and the date are there to be re-checked;
//   * `evidence.interpolatedFrom` — the row is a rung of a ladder and the base
//     row carries every citation, which is also why they share an `assessedAt`;
//   * `evidence.hypothesis` names it — nothing is published for that exact
//     model, the ADR refuses to invent a number, and the row says so out loud.
//
// A rating in none of the three is an unsourced number wearing the same clothes
// as a sourced one, which is the whole failure this check exists to stop. A row
// with no `evidence` FIELD is the same failure and is treated as an empty one —
// otherwise deleting the field would be the way past the check. The v1 string
// form cannot express any of this, so a row that still uses it is left alone:
// this is an error about a citation that was attempted and came out short, not
// a migration gate.
//
// `interpolatedFrom` is checked twice over: the base row must exist, and it must
// not itself be interpolated. Both hold the same line — the exemption is one hop
// to a row that carries figures, and a chain of exemptions can close into a ring
// in which nothing cites a page at all.
function citationChecks(out, tuples) {
  const byId = new Map(tuples.filter((t) => isText(t?.id)).map((t) => [t.id, t]));
  for (const tuple of tuples) {
    // A row with NO `evidence` at all is the case this check most needs to
    // catch, and skipping it would be the hole: `evidence` is optional in the
    // schema, so "no citation" and "no field" would otherwise be the same
    // document with different verdicts. An absent field is an empty citation.
    const evidence = tuple?.evidence === undefined ? {} : tuple.evidence;
    if (!isObject(evidence)) continue;
    const cited = new Set((evidence.sources ?? []).map((c) => c?.rating));
    const supposed = new Set(evidence.hypothesis ?? []);
    const interpolated = isText(evidence.interpolatedFrom);
    if (interpolated) {
      const origin = byId.get(evidence.interpolatedFrom);
      if (!origin) {
        out.error('catalog-invalid', 'catalog', `tuples.${tuple.id}.evidence.interpolatedFrom`,
          `no tuple with id "${evidence.interpolatedFrom}" — an interpolated row is exempt from citing `
          + 'its own figures because the base row carries them, so a base row that is not there '
          + 'leaves the ladder with no source at all');
      } else if (isObject(origin.evidence) && isText(origin.evidence.interpolatedFrom)) {
        // One hop and no more. A chain would let a ladder cite itself in a ring
        // — every rung exempt, every figure somewhere else, and no row in the
        // cycle ever naming a page. ADR-004 puts the figures on THE base row.
        out.error('catalog-invalid', 'catalog', `tuples.${tuple.id}.evidence.interpolatedFrom`,
          `"${evidence.interpolatedFrom}" is itself interpolated (from `
          + `"${origin.evidence.interpolatedFrom}") — a base row carries the figures, so the `
          + 'exemption is one hop; a chain of them can close into a ring that cites nothing');
      } else if (origin.id === tuple.id) {
        out.error('catalog-invalid', 'catalog', `tuples.${tuple.id}.evidence.interpolatedFrom`,
          'a row cannot be interpolated from itself');
      }
      continue;
    }
    for (const rating of RATING_KEYS) {
      if (cited.has(rating) || supposed.has(rating)) continue;
      out.error('catalog-invalid', 'catalog', `tuples.${tuple.id}.evidence`,
        `"${rating}" is rated ${tuple.ratings?.[rating]} with nothing behind it — name a source in `
        + '`sources`, mark the row `interpolatedFrom` a base row that has one, or say in '
        + '`hypothesis` that no figure is published for this exact model');
    }
    for (const rating of supposed) {
      if (!cited.has(rating)) continue;
      out.error('catalog-invalid', 'catalog', `tuples.${tuple.id}.evidence.hypothesis`,
        `"${rating}" is named a hypothesis and also carries a source — it is one or the other`);
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
 * Keep launchable effort rungs even when the 1–10 bands cannot distinguish
 * them, but make the tie visible. `interpolatedFrom` is the ladder identity:
 * Cursor carries effort in the model id, so grouping by `model` would miss the
 * very ladders this check is for.
 */
function ladderChecks(out, tuples) {
  const groups = new Map();
  for (const tuple of tuples) {
    const root = isText(tuple?.evidence?.interpolatedFrom) ? tuple.evidence.interpolatedFrom : tuple?.id;
    if (!isText(root)) continue;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(tuple);
  }
  for (const rows of groups.values()) {
    const seen = new Map();
    for (const tuple of rows.sort((a, b) => a.priority - b.priority)) {
      const signature = JSON.stringify([tuple.ratings, [...(tuple.roles ?? [])].sort()]);
      if (!seen.has(signature)) {
        seen.set(signature, tuple);
        continue;
      }
      const first = seen.get(signature);
      out.warn({
        code: 'ladder-indistinguishable',
        tupleIds: [first.id, tuple.id],
        message: `ladder rungs "${first.id}" and "${tuple.id}" coincide on all ratings and roles; `
          + 'both remain because effort is still a launchable choice',
      });
    }
  }
}

/** Reviewer is conferred by an assessed base row, never by upward interpolation. */
function reviewerRoleChecks(out, tuples) {
  const byId = new Map(tuples.filter((t) => isText(t?.id)).map((t) => [t.id, t]));
  for (const tuple of tuples) {
    if (!tuple?.roles?.includes('reviewer')) continue;
    const baseId = isText(tuple.evidence?.interpolatedFrom) ? tuple.evidence.interpolatedFrom : tuple.id;
    const base = byId.get(baseId);
    if ((base?.ratings?.quality ?? 0) < 9 || (tuple.ratings?.quality ?? 0) < 9) {
      out.error('catalog-invalid', 'catalog', `tuples.${tuple.id}.roles`,
        `reviewer requires this tuple and its assessed base row "${baseId}" to have quality 9 or above; `
        + 'upward interpolation never confers the reviewer role');
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
  citationChecks(out, canonical.data.tuples);
  reviewerRoleChecks(out, canonical.data.tuples);

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
  // A harness a person answered a question about that this CLI does not drive.
  // An error rather than a warning: the answer is display only, so a misspelt
  // one would sit in a file forever, printed under a name nothing recognises.
  for (const layer of sound) {
    for (const harness of Object.keys(isObject(layer.data.account) ? layer.data.account : {})) {
      if (knownHarnesses().includes(harness)) continue;
      out.error('overlay-invalid', layer.id, `account.${harness}`,
        `unknown harness "${harness}" — this CLI drives ${knownHarnesses().join(', ')}`);
    }
  }
  weightChecks(out, merged.policy, merged.sources);
  // A layer that states `qualityFloor.reviewer` and the `reviewerQualityFloor`
  // alias both. Lawful — the explicit key wins (ADR-004) — and worth saying,
  // because a file that says one thing twice is a file whose author expected
  // one of the two to do something.
  for (const layer of merged.sources.floorAlias ?? []) {
    out.warn({
      code: 'quality-floor-alias',
      layer,
      at: 'reviewerQualityFloor',
      message: `"${layer}" states both qualityFloor.reviewer and the reviewerQualityFloor alias — `
        + 'the explicit key wins and the alias does nothing in this layer',
    });
  }
  contradictionChecks(out, merged.policy, merged.sources);
  priorityChecks(out, merged.tuples);
  ladderChecks(out, merged.tuples);
  for (const warning of merged.warnings) out.warn(warning);

  // `rules` travels with the verdict because `models validate` prints the bans
  // in force and who may lift each one, and the merge is the only place that
  // knows. It is the same list every finding above was read from.
  return {
    ok: out.errors.length === 0, errors: out.errors, warnings: out.warnings, rules: merged.sources.rules,
  };
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
  const overlays = declared.map((layer) => ({
    ...read(layer.path, layer.id, 'overlay-invalid'),
    writable: layer.writable === true,
  }));
  // `writable` travels with the layer because `models validate` is where a
  // person asks which file the tool writes — the one layer of the stack whose
  // content is not theirs alone (ADR-004).
  const layers = [canonical, ...overlays]
    .map(({ id, path: file, present, writable }) => ({ id, path: file, present, writable: writable === true }));

  // The same rule `readLayers` refuses on, reported here as a FINDING rather
  // than thrown, because that is what this call is for: a person whose host
  // declares no writable layer would otherwise be told by `models validate` that
  // their stack holds and by `models` that it does not.
  const writable = overlays.filter((l) => l.writable).map((l) => l.id);
  if (declared.length && writable.length !== 1) {
    return {
      ok: false,
      layers,
      errors: [{
        code: 'overlay-invalid',
        layer: 'host',
        at: 'routingPaths().overlays',
        message: writable.length
          ? `${writable.length} layers are writable (${writable.join(', ')}); exactly one may be`
          : `no declared layer is writable (${declared.map((l) => l.id).join(', ')}); exactly one must be`,
      }],
      warnings: [],
    };
  }

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

// The resolver: one decision from the merged catalog, the availability snapshot
// and a strategy. A pure function — no clock of its own, no disk, no harness —
// because determinism is the contract ADR-003 fixed: the same inputs give the
// same tuple whatever order they arrive in, and every number that moved the
// pick is published.
//
// The shape it produces is `schemas/model-routing/decision.schema.json`, and the
// shape it consumes is what the two modules next door already answer:
// `loadCatalog` ([catalog.js](catalog.js)) for the tuples, the merged policy and
// its layers, `preflight` ([preflight.js](preflight.js)) for the snapshot. It
// wires nothing: PB-21 gives it a command line.
//
// Three rules shape the file.
//
// **Every number comes from the merged policy.** A weight, a penalty, a bonus
// and the reviewer floor are read from `policy.policy`, never from a literal —
// that is what makes an overlay able to change them at all. The two constants
// below are formula constants of ADR-003, not policy: the 1–5 normalisation and
// the neutral 50 % an unknown remaining limit counts as. The overlay schema has
// no key for either, so an overlay cannot move them and neither can this file.
//
// **The nine filter steps are in the ADR's order, and the first one that
// matches is the exclusion reported.** Order is what makes an explanation
// stable: a tuple the account cannot run AND that is rated for the other role
// must always give the same answer, or two runs would disagree about why.
//
// **A harness the snapshot does not carry is filtered, not excluded.** The
// snapshot covers the harnesses the workspace declared (`host.declaredTools()`,
// the preflight's `harnesses`), and ADR-003 says the catalog is filtered by that
// declaration. A tuple for a harness this workspace never declared was not
// considered and does not belong in `candidates`; the exclusion enum has no code
// for it either.
import { GateError } from '../../dist/index.js';
import { DEFAULTS, SELECTOR_KINDS, STRATEGIES } from './catalog.js';

/** The two roles a run is routed for. `reviewer` is the one with a quality floor and a diversity bonus. */
export const ROLES = ['worker', 'reviewer'];

/** `schemaVersion` of the document produced here. */
export const DECISION_SCHEMA_VERSION = 1;

/**
 * What `remaining` counts as when it cannot be read: the harness state is
 * `unknown`, or it exposes no windows at all. ADR-003 fixes it at a neutral
 * 50 %, together with the `unknown-availability` adjustment that goes with it —
 * penalised, never blocking. It is not a policy value: the overlay schema has no
 * key for it, so nothing may move it without moving the ADR first.
 */
export const NEUTRAL_REMAINING_PERCENT = 50;

/**
 * Warning codes a decision may carry. `validate` has two of its own —
 * `priority-duplicate` and `priority-not-canonical` — which check a convention
 * rather than a routing outcome and never reach a decision
 * ([guides/model-routing.md](../../docs/guides/model-routing.md)). Copying a
 * warning the schema does not declare would produce a document nothing can read
 * back, so the copy is filtered by this list.
 */
export const DECISION_WARNINGS = [
  'stale-rating', 'unknown-remaining', 'reviewer-floor-not-met', 'snapshot-stale', 'probe-incomplete',
];

/** The layer id `readLayers` gives the shipped catalog. The decision's `overlays` block is the rest of the stack. */
const CANONICAL_LAYER = 'catalog';

// Rounded to two decimals wherever a number reaches the document: the tie-break
// reads the printed total, so the number compared must be the number shown.
const round2 = (n) => Math.round(n * 100) / 100;

/** A 1–5 maintainer rating on the 0–100 scale. */
const normalise = (r) => ((r - 1) / 4) * 100;

/** The same scale, inverted — a smaller spend contributes more. */
const invert = (r) => ((5 - r) / 4) * 100;

const has = (obj, key) => obj != null && Object.hasOwn(obj, key);

/**
 * The harness entry of the snapshot, or `null` when this workspace has none.
 *
 * `Object.hasOwn`, not a bare read: the harness grammar admits `constructor`
 * and `toString`, and a bare read would hand a prototype value to a tuple whose
 * harness was never probed.
 */
function entryOf(snapshot, harness) {
  return has(snapshot?.harnesses, harness) ? snapshot.harnesses[harness] : null;
}

/** The candidate's availability block: the harness entry projected onto the four fields the decision declares. */
function availabilityOf(entry) {
  return {
    state: entry.state,
    reason: entry.reason ?? null,
    checkedAt: entry.checkedAt,
    source: entry.source,
  };
}

/** Ratings for the role being routed: the tuple's own, with its role override on top. */
function ratingsFor(tuple, role) {
  const override = tuple.roleRatings?.[role];
  return override ? { ...tuple.ratings, ...override } : { ...tuple.ratings };
}

/**
 * The remaining allowance of one harness, as a percentage, and whether it had
 * to be guessed.
 *
 * `100 − max(usedPercent)` over the harness's windows. No windows, or a state
 * of `unknown`, and it is the neutral value plus the adjustment — ADR-003's
 * fourth decision, penalise rather than block.
 */
function remainingOf(entry) {
  const windows = Array.isArray(entry.windows) ? entry.windows : [];
  if (entry.state === 'unknown' || !windows.length) {
    return { percent: NEUTRAL_REMAINING_PERCENT, unknown: true };
  }
  return { percent: 100 - Math.max(...windows.map((w) => w.usedPercent)), unknown: false };
}

const selectorValue = (tuple, kind) => ({
  harnesses: tuple.harness,
  models: tuple.model,
  efforts: tuple.effort,
  tuples: tuple.id,
}[kind]);

const layerLabel = (id) => (id === DEFAULTS ? 'the defaults' : `overlay "${id}"`);

/**
 * Step 2a — the allow and deny lists of the merged policy.
 *
 * Deny is applied after allow, the order `validate` states when it reports the
 * two as a contradiction. `detail` names the layer that wrote the list, because
 * that is the file a person has to open: "denied by overlay \"workspace\"".
 */
function policyExclusion(tuple, rules, sources) {
  for (const kind of SELECTOR_KINDS) {
    const allow = rules.allow?.[kind];
    if (!Array.isArray(allow) || !allow.length) continue;
    if (!allow.includes(selectorValue(tuple, kind))) {
      return {
        code: 'denied-by-policy',
        detail: `not named by allow.${kind} of ${layerLabel(sources?.allow?.[kind] ?? DEFAULTS)}`,
      };
    }
  }
  for (const kind of SELECTOR_KINDS) {
    const deny = rules.deny?.[kind];
    if (!Array.isArray(deny) || !deny.length) continue;
    if (deny.includes(selectorValue(tuple, kind))) {
      return {
        code: 'denied-by-policy',
        detail: `denied by ${layerLabel(sources?.deny?.[kind] ?? DEFAULTS)} (deny.${kind})`,
      };
    }
  }
  return null;
}

/**
 * Step 2b — `--harness`, `--model` and `--effort`.
 *
 * They are constraints, not wishes: a named value narrows the list and is never
 * replaced, so a constraint that leaves nothing standing ends with no chosen
 * tuple and the reasons say which value did it.
 */
function constraintExclusion(tuple, constraints) {
  const named = [
    ['harness', constraints.harness, tuple.harness],
    ['model', constraints.model, tuple.model],
    ['effort', constraints.effort, tuple.effort],
  ].filter(([, wanted]) => wanted !== undefined && wanted !== null);
  const missed = named.filter(([, wanted, actual]) => wanted !== actual);
  if (!missed.length) return null;
  return {
    code: 'constraint-mismatch',
    detail: missed
      .map(([flag, wanted, actual]) => `--${flag} "${wanted}" was named; this tuple is ${actual === null ? 'unset' : `"${actual}"`}`)
      .join('; '),
  };
}

/** Steps 2…6 in the ADR's order. The first step that matches is the reason reported. */
function exclusionOf(tuple, { role, rules, sources, constraints, entry, paygAllowed }) {
  const denied = policyExclusion(tuple, rules, sources);
  if (denied) return denied;

  const constrained = constraintExclusion(tuple, constraints);
  if (constrained) return constrained;

  if (!tuple.roles.includes(role)) {
    return { code: 'role-not-allowed', detail: `rated for ${tuple.roles.join(', ')} only` };
  }

  // Only when the harness answered with an inventory. A harness that is silent
  // about its models has not said this one is absent, and reading silence as
  // absence would drop every tuple of a harness the cache could not answer for.
  if (Array.isArray(entry.models) && !entry.models.some((m) => m.model === tuple.model)) {
    return {
      code: 'model-not-in-inventory',
      detail: `the ${tuple.harness} account does not expose "${tuple.model}"`,
    };
  }

  if (entry.state === 'unavailable') {
    return {
      code: 'harness-unavailable',
      detail: `${tuple.harness} is unavailable${entry.reason ? ` (${entry.reason})` : ''}`,
    };
  }
  if (entry.state === 'exhausted') {
    return {
      code: 'harness-exhausted',
      detail: `${tuple.harness} is exhausted${entry.reason ? ` (${entry.reason})` : ''}`
        + `${entry.resetAt ? `; resets at ${entry.resetAt}` : ''}`,
    };
  }

  if (tuple.billing === 'payg' && !paygAllowed) {
    return { code: 'payg-not-allowed', detail: 'pay-as-you-go; pass --allow-payg to consider it' };
  }
  return null;
}

/**
 * Step 7 — the four weighted components, and then the adjustments in the order
 * they are applied.
 *
 * A component is its weight over 100 times the normalised value, so dividing one
 * back by its weight recovers the rating. The adjustments are published as their
 * own rows for the same reason: a total nobody can take apart explains nothing.
 */
function scoreOf(tuple, { role, weights, rules, entry, liveCount, diversity }) {
  const ratings = ratingsFor(tuple, role);
  const remaining = remainingOf(entry);
  const components = {
    quality: round2((normalise(ratings.quality) * weights.quality) / 100),
    speed: round2((normalise(ratings.speed) * weights.speed) / 100),
    quotaCost: round2((invert(ratings.quotaCost) * weights.quotaCost) / 100),
    remaining: round2((remaining.percent * weights.remaining) / 100),
  };
  const base = round2(Object.values(components).reduce((a, b) => a + b, 0));

  // `0 - x` rather than `-x`: an overlay may set a penalty to zero, and `-0` is a
  // different value to `Object.is`, so a document carrying it would fail a
  // comparison that the same document with `0` passes.
  const adjustments = [];
  if (remaining.unknown) {
    adjustments.push({ code: 'unknown-availability', points: 0 - rules.penalties.unknownAvailability });
  }
  if (liveCount > 0) {
    // Per participant on the same harness, and capped: the point is to spread a
    // run over the accounts it has, not to make a busy harness unusable.
    const raw = liveCount * rules.penalties.liveParticipantPerHarness;
    adjustments.push({ code: 'live-participant', points: 0 - Math.min(raw, rules.penalties.liveParticipantCap) });
  }
  if (diversity) {
    adjustments.push({ code: 'reviewer-diversity', points: rules.bonuses.reviewerDiversity });
  }
  const total = round2(base + adjustments.reduce((a, x) => a + x.points, 0));
  return { score: { total, base, components, adjustments }, quality: ratings.quality };
}

/**
 * Step 9 — the tie-break, in ADR-003's order: effective score, then confirmed
 * availability, then canonical priority, then the tuple id. It is total,
 * because two tuples cannot share an id, so input order never reaches the
 * result.
 */
function byTieBreak(a, b) {
  return b.score.total - a.score.total
    || (b.availability.state === 'available' ? 1 : 0) - (a.availability.state === 'available' ? 1 : 0)
    || a.priority - b.priority
    || (a.tupleId < b.tupleId ? -1 : 1);
}

/** Excluded rows print after the scored ones, in canonical priority order — the id settles a shared priority. */
function byPriority(a, b) {
  return a.priority - b.priority || (a.tupleId < b.tupleId ? -1 : 1);
}

/**
 * The models the account exposes that the merged catalog does not rate. Shown,
 * never chosen: a rating is what makes a model a tuple.
 */
function runtimeRows(snapshot) {
  // Harness order is the sorted one, not the snapshot's key order: an object's
  // keys carry the order they were written in, and a decision must not.
  const rows = [];
  for (const harness of Object.keys(snapshot.harnesses).sort()) {
    const entry = snapshot.harnesses[harness];
    for (const model of Array.isArray(entry.models) ? entry.models : []) {
      if (model.rated !== false) continue;
      rows.push({ harness, model: model.model, ...(model.flags ? { flags: [...model.flags] } : {}) });
    }
  }
  return rows;
}

/** `probe` or `cache` when every harness agrees, `mixed` otherwise — the enum has no fourth answer. */
function snapshotSource(snapshot) {
  const seen = new Set(Object.values(snapshot.harnesses).map((h) => h.source));
  if (seen.size === 1) {
    const only = [...seen][0];
    if (only === 'probe' || only === 'cache') return only;
  }
  return 'mixed';
}

/**
 * One decision.
 *
 * `policy` is the answer of `loadCatalog` — the merged tuples, the merged
 * policy, the layers the host named and the warnings the merge produced.
 * `snapshot` is the answer of `preflight`. `constraints` are the caller's
 * `--harness`, `--model`, `--effort` and `--allow-payg`. `liveParticipants` are
 * the participants already up, as `{ harness, model, role }`: they carry the
 * per-harness penalty, and the ones whose role is `worker` are what a reviewer's
 * diversity bonus is measured against. `now` is the clock, in milliseconds, and
 * the only thing it produces is `snapshot.ageSec`.
 */
export function resolve({
  role,
  strategy,
  constraints = {},
  policy,
  snapshot,
  liveParticipants = [],
  now = Date.now(),
} = {}) {
  const rules = policy?.policy;
  if (!rules) throw new GateError('resolve: `policy` must be the answer of loadCatalog — its policy block is missing');
  if (!ROLES.includes(role)) throw new GateError(`resolve: unknown role "${role}" — allowed: ${ROLES.join(', ')}`);
  if (!STRATEGIES.includes(strategy)) {
    throw new GateError(`resolve: unknown strategy "${strategy}" — allowed: ${STRATEGIES.join(', ')}`);
  }
  const weights = rules.weights?.[strategy];
  if (!weights) throw new GateError(`resolve: the merged policy has no weight set for "${strategy}"`);
  if (!snapshot?.harnesses) throw new GateError('resolve: the availability snapshot carries no harnesses');

  // `--allow-payg` reaches the merge as a policy change, so the merged policy is
  // the answer; the flag is read too, because this function is pure and may be
  // handed a policy merged without it. Opt-in in both places: neither can turn
  // pay-as-you-go back off.
  const paygAllowed = rules.payg?.allow === true || constraints.allowPayg === true;
  const workers = liveParticipants.filter((p) => p?.role === 'worker');

  const rows = [];
  for (const tuple of policy.tuples ?? []) {
    const entry = entryOf(snapshot, tuple.harness);
    if (!entry) continue;
    const row = {
      tupleId: tuple.id,
      harness: tuple.harness,
      model: tuple.model,
      effort: tuple.effort ?? null,
      priority: tuple.priority,
      availability: availabilityOf(entry),
      excluded: exclusionOf(tuple, { role, rules, sources: policy.sources, constraints, entry, paygAllowed }),
      entry,
      tuple,
    };
    rows.push(row);
  }

  for (const row of rows) {
    if (row.excluded) continue;
    // A reviewer whose harness or model differs from every live worker's is the
    // second opinion the bonus is for. With no live worker there is nothing to
    // differ from, and the bonus is not given.
    const diversity = role === 'reviewer' && workers.length > 0
      && workers.every((w) => w.harness !== row.harness || w.model !== row.model);
    const { score, quality } = scoreOf(row.tuple, {
      role,
      weights,
      rules,
      entry: row.entry,
      liveCount: liveParticipants.filter((p) => p?.harness === row.harness).length,
      diversity,
    });
    row.score = score;
    row.quality = quality;
  }

  const scored = rows.filter((r) => r.score).sort(byTieBreak);
  const excluded = rows.filter((r) => !r.score).sort(byPriority);

  // Step 8. The reviewer floor is a choice rule, not a filter: a candidate below
  // it stays in the list with its score, and only the pick moves. Nothing
  // reaches the floor and the best remaining one is taken with a warning — a
  // soft fallback, because a refusal here would leave a run with no reviewer at
  // all.
  const warnings = [];
  let chosen = null;
  if (scored.length) {
    if (role === 'reviewer') {
      const floor = rules.reviewerQualityFloor;
      const above = scored.filter((r) => r.quality >= floor);
      chosen = above.length ? above[0] : scored[0];
      if (!above.length) {
        warnings.push({
          code: 'reviewer-floor-not-met',
          message: `no reviewer candidate reaches the quality floor of ${floor} of 5 — `
            + `"${chosen.tupleId}" was taken as the best remaining one`,
        });
      }
    } else {
      chosen = scored[0];
    }
  }

  // Warnings copied from the merge carry `code` and `message` and nothing else:
  // that is the whole of a warning in this document, and the facts a caller
  // wants without parsing prose stay on the merge's own verdict.
  const copied = (policy.warnings ?? [])
    .filter((w) => DECISION_WARNINGS.includes(w.code))
    .map((w) => ({ code: w.code, message: w.message }));

  // Snapshot-derived warnings, per harness, in name order — and only for a
  // harness whose candidates were actually scored: a warning about a harness
  // nothing was taken from explains nothing.
  const inPlay = [...new Set(scored.map((r) => r.harness))].sort();
  const fromSnapshot = [];
  for (const harness of inPlay) {
    const entry = snapshot.harnesses[harness];
    if (remainingOf(entry).unknown) {
      fromSnapshot.push({
        code: 'unknown-remaining',
        message: `${harness} exposes no limit source — remaining counted as ${NEUTRAL_REMAINING_PERCENT} % `
          + `and the candidate penalised ${rules.penalties.unknownAvailability} points`,
      });
    }
    if (entry.reason === 'stale_cache') {
      fromSnapshot.push({
        code: 'snapshot-stale',
        message: `${harness} was answered from a cache entry past its TTL and no probe ran — `
          + `it counts as unknown, checked at ${entry.checkedAt}`,
      });
    }
    if (entry.reason === 'probe_timeout') {
      fromSnapshot.push({
        code: 'probe-incomplete',
        message: `the ${harness} adapter did not answer inside the preflight budget — it counts as unknown`,
      });
    }
  }

  const applied = excluded.some((r) => r.excluded.code === 'constraint-mismatch');
  const takenAt = snapshot.takenAt;
  const candidate = (row) => ({
    tupleId: row.tupleId,
    harness: row.harness,
    model: row.model,
    effort: row.effort,
    availability: row.availability,
    score: row.score ?? null,
    excluded: row.excluded ?? null,
    chosen: row === chosen,
  });

  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    strategy,
    role,
    weights: { ...weights },
    chosen: chosen
      ? {
        tupleId: chosen.tupleId, harness: chosen.harness, model: chosen.model, effort: chosen.effort,
      }
      : null,
    candidates: [...scored, ...excluded].map(candidate),
    runtime: runtimeRows(snapshot),
    warnings: [...copied, ...fromSnapshot, ...warnings],
    constraints: {
      harness: constraints.harness ?? null,
      model: constraints.model ?? null,
      effort: constraints.effort ?? null,
      allowPayg: constraints.allowPayg === true,
      applied,
    },
    overlays: (policy.layers ?? [])
      .filter((layer) => layer.id !== CANONICAL_LAYER)
      .map((layer) => ({ id: layer.id, path: layer.path, applied: layer.present === true })),
    snapshot: {
      takenAt,
      ageSec: Math.max(0, Math.floor((now - Date.parse(takenAt)) / 1000)),
      source: snapshotSource(snapshot),
    },
  };
}

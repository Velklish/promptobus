// The resolver: one decision from the merged catalog, the snapshot and a strategy. Pure.
// The three rules it obeys and why the order is fixed: [guides/model-routing.md#the-resolver-one-decision-and-the-three-rules-that-shape-it](../../docs/guides/model-routing.md#the-resolver-one-decision-and-the-three-rules-that-shape-it)
import { GateError } from '../../dist/index.js';
import {
  BALANCE_ORDERING, SELECTOR_KINDS, STRATEGIES, rulesFor, rulesForRole, rulesLabel,
} from './catalog.js';

/** The two roles a run is routed for. `reviewer` is the one with a quality floor and a diversity bonus. */
export const ROLES = ['worker', 'reviewer'];

/**
 * `schemaVersion` of the document produced here.
 *
 * Two since ADR-004, and the bump belongs to this task rather than to the one
 * that added `harnesses`: a reader of version 1 would be wrong about a fifth
 * `strategy` value, a `pace` block on a candidate, two warning codes and
 * `strategySource`, and those arrive together.
 */
export const DECISION_SCHEMA_VERSION = 2;

/**
 * What `remaining` counts as when it cannot be read: the harness state is
 * `unknown`, or it exposes no windows at all. ADR-003 fixes it at a neutral
 * 50 %, together with the `unknown-availability` adjustment that goes with it —
 * penalised, never blocking. It is not a policy value: the overlay schema has no
 * key for it, so nothing may move it without moving the ADR first.
 */
export const NEUTRAL_REMAINING_PERCENT = 50;

/**
 * Warning codes a decision may carry. `validate` has three validate-only
 * warnings: `priority-duplicate` and `priority-not-canonical` check a convention,
 * while `promotion-expired` records a catalog promotion whose last observed date
 * passed. None of them reaches a decision
 * ([[guides/model-routing.md#the-resolver-one-decision-and-the-three-rules-that-shape-it](../../docs/guides/model-routing.md#the-resolver-one-decision-and-the-three-rules-that-shape-it)](../../docs/guides/model-routing.md)). Copying a
 * warning the schema does not declare would produce a document nothing can read
 * back, so the copy is filtered by this list.
 */
export const DECISION_WARNINGS = [
  'stale-rating', 'unknown-remaining', 'reviewer-floor-not-met', 'snapshot-stale', 'probe-incomplete',
  'flag-not-in-inventory', 'worker-floor-not-met', 'balance-fallback', 'near-limit',
  'live-participant-cap',
];

/** Exclusion codes a candidate may carry, kept together for schema parity. */
export const EXCLUSION_CODES = [
  'model-not-in-inventory', 'role-not-allowed', 'constraint-mismatch', 'denied-by-policy',
  'payg-not-allowed', 'harness-unavailable', 'harness-exhausted',
];

/**
 * Selector kinds whose value is a field of the TUPLE, and which are therefore
 * applied at filtering step 2. `flags` is the one that is not: it reads the
 * snapshot's model row, so it needs the inventory step to have run first and is
 * applied after it (ADR-004).
 */
const TUPLE_SELECTOR_KINDS = SELECTOR_KINDS.filter((kind) => kind !== 'flags');

/** The layer id `readLayers` gives the shipped catalog. The decision's `overlays` block is the rest of the stack. */
const CANONICAL_LAYER = 'catalog';

// Rounded to two decimals wherever a number reaches the document: the tie-break
// reads the printed total, so the number compared must be the number shown.
const round2 = (n) => Math.round(n * 100) / 100;

/** A 1–10 maintainer rating on the 0–100 scale. */
const normalise = (r) => ((r - 1) / 9) * 100;

/** The same scale, inverted — a smaller spend contributes more. */
const invert = (r) => ((10 - r) / 9) * 100;

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
 * The models the resolver may choose from: the inventory rows the harness does
 * not hide.
 *
 * A hidden row stays in the snapshot so the cache matches what the harness
 * lists. The resolver's inventory and runtime projections filter it out, and
 * `models` prints those projections rather than the whole inventory. A catalog
 * tuple naming a hidden model is excluded as `model-not-in-inventory`, with
 * detail naming the account.
 */
function inventoryOf(entry) {
  return Array.isArray(entry.models) ? entry.models.filter((m) => m.hidden !== true) : null;
}

/**
 * Whether one window binds this tuple's model.
 *
 * Three shapes, and two of them say what they cover BY MODEL ID (ADR-004): the
 * resolver matches by exact id and infers no family, because a family inferred
 * from a display name is a guess about which rows a limit binds, made in the
 * module least able to check it. A model scope whose display name the adapter
 * could not resolve carries no `models`, and binds nothing.
 *
 * The `api` pool is the exception and it is defined by its complement: it
 * carries no list, because a list of everything else is not a fact any harness
 * stated, so a tuple falls in it exactly when no `auto` pool of that harness
 * names its model.
 */
function windowBinds(window, model, entry) {
  const scope = window.scope ?? null;
  if (scope === null) return true;
  if (scope.pool === 'auto') return (scope.models ?? []).includes(model);
  if (scope.pool === 'api') {
    return !(entry.windows ?? []).some((w) => w.scope?.pool === 'auto' && (w.scope.models ?? []).includes(model));
  }
  return Array.isArray(scope.models) && scope.models.includes(model);
}

/**
 * The windows that apply to one tuple: the account-wide ones plus the scope
 * covering it.
 *
 * Exported because a lift records the same set on its participant, so that the
 * spend of a run can later be read as the delta of those windows (PB-36). One
 * implementation rather than two: a second definition of "applicable" would
 * measure a run against a window the pick was never scored on.
 */
export function applicableWindows(entry, model) {
  return (Array.isArray(entry.windows) ? entry.windows : []).filter((w) => windowBinds(w, model, entry));
}

/**
 * The remaining allowance for one TUPLE, as a percentage, and whether it had to
 * be guessed.
 *
 * `100 − max(usedPercent)` over the applicable windows — the account-wide ones
 * plus the scope covering this tuple. ADR-003 already said "applicable"; until
 * ADR-004 a harness had only account-wide windows, so this is a refinement of
 * that sentence and not a reversal of it, and a Cursor tuple in a spent pool now
 * scores below one in a pool with room under every strategy.
 *
 * No applicable window, or a state of `unknown`, and it is the neutral value
 * plus the adjustment — ADR-003's fourth decision, penalise rather than block.
 */
function remainingOf(entry, model) {
  const windows = applicableWindows(entry, model);
  if (entry.state === 'unknown' || !windows.length) {
    return { percent: NEUTRAL_REMAINING_PERCENT, unknown: true };
  }
  return { percent: 100 - Math.max(...windows.map((w) => w.usedPercent)), unknown: false };
}

/** A share of 0…1, clamped against clock skew — ADR-004 fixes the clamp on `elapsedShare`. */
const clamp01 = (n) => Math.min(1, Math.max(0, n));

// The exclusion codes in the ADR's order: the first match is the one reported.
// The order and why it is fixed: [guides/model-routing.md#paceof--the-pace-block-of-one-candidate-how-much-of-its-binding-window-is-spent](../../docs/guides/model-routing.md#paceof--the-pace-block-of-one-candidate-how-much-of-its-binding-window-is-spent)
function paceOf(entry, tuple, { role, spendUnit, now }) {
  const applicable = applicableWindows(entry, tuple.model)
    .sort((a, b) => b.usedPercent - a.usedPercent || (a.id < b.id ? -1 : 1));
  // Every field is present in every branch, and the ones that could not be
  // computed are `null`. A block that omitted them instead would make a reader
  // check two things — is the key there, and is it null — to ask one question.
  const blank = (note, over = {}) => ({
    window: null,
    usedShare: null,
    elapsedShare: null,
    underspend: null,
    spendPenalty: null,
    effective: null,
    eligible: false,
    note,
    ...over,
  });
  if (!applicable.length) return blank('no-pace');

  const binding = applicable[0];
  const window = { id: binding.id, kind: binding.kind, scope: binding.scope ?? null };
  const usedShare = binding.usedPercent / 100;
  if (binding.usedPercent >= 100) return blank('window-spent', { window, usedShare });

  const resetMs = Date.parse(binding.resetAt ?? '');
  const lengthMs = Number.isFinite(binding.lengthSec) ? binding.lengthSec * 1000 : NaN;
  if (!Number.isFinite(resetMs) || resetMs <= now || !Number.isFinite(lengthMs) || lengthMs <= 0) {
    return blank('no-pace', { window, usedShare });
  }

  const elapsedShare = clamp01((now - (resetMs - lengthMs)) / lengthMs);
  const underspend = round2((elapsedShare - usedShare) * 100);
  // C2: the discount is in the units of the underspend, and it is applied to the
  // tuple that would actually be picked — a harness has no underspend until a
  // tuple names one, because the binding window is defined per tuple.
  //
  // `ratingsFor`, not the tuple's own ratings, and for the same reason `scoreOf`
  // uses it: a `roleRatings.reviewer.quotaCost` is what that tuple actually
  // spends when the reviewer is the role being routed, and a penalty computed
  // from the other number would disagree with the score component beside it —
  // and could flip the harness.
  const spendPenalty = round2((spendUnit * ((ratingsFor(tuple, role).quotaCost ?? 1) - 1)) / 9);
  return {
    window,
    usedShare: round2(usedShare * 100) / 100,
    elapsedShare: round2(elapsedShare * 100) / 100,
    underspend,
    spendPenalty,
    effective: round2(underspend - spendPenalty),
    eligible: true,
    note: null,
  };
}

const selectorValue = (tuple, kind) => ({
  harnesses: tuple.harness,
  models: tuple.model,
  efforts: tuple.effort,
  tuples: tuple.id,
}[kind]);

/** The marks the snapshot carries on this tuple's model — empty when the harness listed no inventory. */
function flagsOf(entry, model) {
  const row = (Array.isArray(entry.models) ? entry.models : []).find((m) => m.model === model);
  return Array.isArray(row?.flags) ? row.flags : [];
}

/**
 * One `denied-by-policy` exclusion, naming every layer that wrote the rule and
 * the rule's own path.
 *
 * The layer alone stopped being an answer when ADR-004 made deny a union: a ban
 * two layers wrote is lifted in neither of them alone, and a diagnostic naming
 * one file would send the reader to do half the edit. The sentence about who can
 * lift it is on the deny half only, because that is where it is load-bearing —
 * no allow list anywhere reaches a ban, since deny is applied after allow.
 */
const deniedBy = (rules) => ({
  code: 'denied-by-policy',
  detail: `denied by ${rulesLabel(rules)} — a ban is lifted only in the layer that wrote it`,
});

const notAllowedBy = (rules) => ({
  code: 'denied-by-policy',
  detail: `not named by ${rulesLabel(rules)}`,
});

/**
 * Step 2a — the allow and deny lists in force for this role.
 *
 * Deny is applied after allow, the order `validate` states when it reports the
 * two together. An allow list that is present and EMPTY is the intersection of
 * two layers that agreed on nothing: it admits no tuple, and that is the
 * behaviour the empty array asks for — `validate` reports it as
 * `allow-intersection-empty` so a person is not left reading candidate rows to
 * work out why everything is denied.
 */
function policyExclusion(tuple, effective, sources, role) {
  for (const kind of TUPLE_SELECTOR_KINDS) {
    const allow = effective.allow?.[kind];
    if (!Array.isArray(allow)) continue;
    if (!allow.includes(selectorValue(tuple, kind))) {
      return notAllowedBy(rulesFor(sources, { rule: 'allow', kind, role }));
    }
  }
  for (const kind of TUPLE_SELECTOR_KINDS) {
    const deny = effective.deny?.[kind];
    if (!Array.isArray(deny) || !deny.length) continue;
    const value = selectorValue(tuple, kind);
    if (deny.includes(value)) {
      return deniedBy(rulesFor(sources, {
        rule: 'deny', kind, role, name: value,
      }));
    }
  }
  return null;
}

/**
 * Step 4a — the `flags` selector, one step after the inventory step because it
 * reads the row that step consulted.
 *
 * **Silence is not absence** (ADR-004). A harness that reported no inventory has
 * no flags to match, so a flag DENY excludes nothing there, and a person who
 * must never run outside zero-data-retention does not get that guarantee from a
 * harness that lists no models. An allow list is the same fact read the other
 * way: `allow.flags` says "only models carrying this mark", and a tuple whose
 * mark cannot be seen is not one of them.
 */
function flagExclusion(tuple, effective, sources, role, entry) {
  const flags = flagsOf(entry, tuple.model);
  const allow = effective.allow?.flags;
  if (Array.isArray(allow) && !flags.some((f) => allow.includes(f))) {
    return notAllowedBy(rulesFor(sources, { rule: 'allow', kind: 'flags', role }));
  }
  const deny = effective.deny?.flags ?? [];
  const hit = flags.find((f) => deny.includes(f));
  if (hit !== undefined) {
    return deniedBy(rulesFor(sources, {
      rule: 'deny', kind: 'flags', role, name: hit,
    }));
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
function exclusionOf(tuple, {
  role, effective, sources, constraints, entry, paygAllowed,
}) {
  const denied = policyExclusion(tuple, effective, sources, role);
  if (denied) return denied;

  const constrained = constraintExclusion(tuple, constraints);
  if (constrained) return constrained;

  if (!tuple.roles.includes(role)) {
    return { code: 'role-not-allowed', detail: `rated for ${tuple.roles.join(', ')} only` };
  }

  // Only when the harness answered with an inventory. A harness that is silent
  // about its models has not said this one is absent, and reading silence as
  // absence would drop every tuple of a harness the cache could not answer for.
  const inventory = inventoryOf(entry);
  if (inventory && !inventory.some((m) => m.model === tuple.model)) {
    return {
      code: 'model-not-in-inventory',
      detail: `the ${tuple.harness} account does not expose "${tuple.model}"`,
    };
  }

  const flagged = flagExclusion(tuple, effective, sources, role, entry);
  if (flagged) return flagged;

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
  const remaining = remainingOf(entry, tuple.model);
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
    for (const model of inventoryOf(entry) ?? []) {
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
 * per-harness penalty and the per-harness cap, and the ones whose role is
 * `worker` are what a reviewer's diversity bonus is measured against. `now` is
 * the clock, in milliseconds: it
 * produces `snapshot.ageSec`, and under `balance` it is also what `elapsedShare`
 * is measured from — which is why nothing here may read a clock of its own.
 */
export function resolve({
  role,
  strategy,
  constraints = {},
  policy,
  snapshot,
  liveParticipants = [],
  strategyCommands,
  now = Date.now(),
} = {}) {
  const rules = policy?.policy;
  if (!rules) throw new GateError('resolve: `policy` must be the answer of loadCatalog — its policy block is missing');
  if (!ROLES.includes(role)) throw new GateError(`resolve: unknown role "${role}" — allowed: ${ROLES.join(', ')}`);
  if (!STRATEGIES.includes(strategy)) {
    throw new GateError(`resolve: unknown strategy "${strategy}" — allowed: ${STRATEGIES.join(', ')}`);
  }
  // `balance` has no weight set of its own and orders tuples inside one harness
  // by the merged `balanced` weights — "the role's ordering", everywhere in
  // ADR-004. The published `weights` are therefore the ones actually used.
  const ordering = strategy === 'balance' ? BALANCE_ORDERING : strategy;
  const weights = rules.weights?.[ordering];
  if (!weights) throw new GateError(`resolve: the merged policy has no weight set for "${ordering}"`);
  if (!snapshot?.harnesses) throw new GateError('resolve: the availability snapshot carries no harnesses');

  // `--allow-payg` reaches the merge as a policy change, so the merged policy is
  // the answer; the flag is read too, because this function is pure and may be
  // handed a policy merged without it. Opt-in in both places: neither can turn
  // pay-as-you-go back off.
  const paygAllowed = rules.payg?.allow === true || constraints.allowPayg === true;
  const workers = liveParticipants.filter((p) => p?.role === 'worker');

  // How many participants are already up on each harness, and the ceiling the
  // merged policy puts on that number. Both are read once: the count is the input
  // of the `live-participant` adjustment on every candidate and of the cap on
  // every representative, and two walks of the same list are two places to drift.
  //
  // `liveParticipants` is ONE TASK's list — the caller builds it from the task
  // journal — so both the penalty and the cap bound a run rather than an account,
  // and two tasks side by side each count their own.
  const liveOf = (harness) => liveParticipants.filter((p) => p?.harness === harness).length;
  const caps = rules.caps?.liveParticipants ?? {};
  // A harness with no cap is unbounded — that is what a layer naming none says,
  // and it is today's behaviour word for word. `Number.isInteger` and not a
  // truthiness test: a cap of 0 is the person saying "never this harness", and it
  // has to survive the read that a falsy value would drop.
  const capOf = (harness) => (Number.isInteger(caps[harness]) ? caps[harness] : null);
  const atCap = (harness) => {
    const cap = capOf(harness);
    return cap !== null && liveOf(harness) >= cap;
  };

  // The lists in force for THIS role: the unscoped ones with the role's own
  // unioned into the deny and intersected into the allow. Computed once — the
  // rules do not change between candidates, and a per-candidate merge would be
  // the same answer arrived at N times.
  const effective = rulesForRole(rules, role);

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
      excluded: exclusionOf(tuple, {
        role, effective, sources: policy.sources, constraints, entry, paygAllowed,
      }),
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
      liveCount: liveOf(row.harness),
      diversity,
    });
    row.score = score;
    row.quality = quality;
  }

  const scored = rows.filter((r) => r.score).sort(byTieBreak);
  const excluded = rows.filter((r) => !r.score).sort(byPriority);

  // The pace block, per ADR-004. It is computed for every scored candidate and
  // published on every one of them, whatever the strategy asked for: `balance`
  // is a CHOICE LAYER above the scoring and not a filter (option A2), so a
  // candidate keeps its score and its place and only the pick moves. Under the
  // other four the block is not published — nothing reads it, and a decision
  // carrying a number no rule of its own strategy used invites a reader to
  // believe one did.
  const balance = rules.balance ?? {};
  const band = Number.isFinite(balance.band) ? balance.band : 0;
  const spendUnit = Number.isFinite(balance.spendUnit) ? balance.spendUnit : band;
  // Computed for every scored candidate under EVERY strategy, because the
  // near-limit signal reads it and a person running `models --strategy quality`
  // is owed the same warning about their windows. Published only under
  // `balance`, in `candidate()` below: a decision carrying a number no rule of
  // its own strategy used would invite a reader to believe one did.
  for (const row of scored) {
    row.pace = paceOf(row.entry, row.tuple, { role, spendUnit, now });
    // The mark is on the candidate rather than left for a reader to re-derive
    // from the cap and a participant list the decision does not carry: the pace
    // table prints it, and a second copy of the rule beside the printer would
    // show a different row after the first edit here.
    if (atCap(row.harness)) row.pace.atCap = true;
  }

  // Step 8. A quality floor is a choice rule, not a filter: a candidate below it
  // stays in the list with its score, and only the pick moves past it. Nothing
  // reaches the floor and the best remaining one is taken with a warning — a
  // soft fallback, because a refusal here would leave a run with no worker or no
  // reviewer at all. ADR-004 gives BOTH roles one, defaulting to 3 and 5.
  const floor = rules.qualityFloor?.[role];
  const bestOf = (rows_) => {
    if (!rows_.length) return null;
    const above = Number.isFinite(floor) ? rows_.filter((r) => r.quality >= floor) : rows_;
    return above.length ? above[0] : rows_[0];
  };

  // **One representative per eligible harness/pool group, and one rule for it.**
  // The tuple that would actually be picked there: its best ELIGIBLE candidate
  // by the role's ordering that meets the role's floor. A pool-less binding
  // window is the one account-wide group; a pool-scoped window contributes its
  // own group. The `balance` pick and pace table read every representative; the
  // near-limit signal reduces them back to one best-scored representative per
  // harness because that warning is about an account, not each pool. Under the
  // reviewer's floor of 5 the best-scoring row of a group and its representative
  // are routinely different tuples, and a group whose TOP row cannot be paced
  // would drop out of a signal that looked at the top row instead of at the
  // eligible ones.
  //
  // Computed under every strategy, because the signal needs it under every
  // strategy; the mark is only published under `balance`, with the pace block
  // it sits in.
  const eligible = scored.filter((r) => r.pace?.eligible);
  const groups = new Map();
  for (const row of eligible) {
    const pool = row.pace.window?.scope?.pool ?? null;
    const key = `${row.harness}\u0000${pool ?? ''}`;
    if (!groups.has(key)) groups.set(key, { harness: row.harness, pool, rows: [] });
    groups.get(key).rows.push(row);
  }
  const representatives = [...groups.values()]
    .map(({ rows: group }) => bestOf(group))
    .filter(Boolean);
  // Marked in the document rather than left for a reader to re-derive: the
  // renderer would otherwise repeat this rule, and a second copy of it would
  // show a different representative on a run where the floor moved the first.
  for (const row of representatives) row.pace.representative = true;

  // The quality floor sits above the balance comparison: when at least one
  // paced group has a floor-meeting representative, only those representatives
  // enter the leader band and balanced-score tie-break. A group with no
  // floor-meeting candidate still keeps its below-floor representative in the
  // document; it is simply not a balance contender while a floor-meeting group
  // exists. If no paced representative meets the floor, every representative
  // remains in the comparison so balance still has a soft fallback.
  const floorRepresentatives = Number.isFinite(floor)
    ? representatives.filter((row) => row.quality >= floor)
    : [];
  const balanceRepresentatives = floorRepresentatives.length
    ? floorRepresentatives
    : representatives;

  const warnings = [];
  let chosen = null;
  if (scored.length) {
    if (strategy !== 'balance') chosen = bestOf(scored);
    else {
      // The pick, in ADR-004's order, over the representatives computed above:
      // the floor is applied when the representative is chosen rather than
      // after, so the pace compared is the pace of the tuple the comparison is
      // about.
      if (!representatives.length) {
        // No harness could be paced. A fallback rather than a refusal, because a
        // person asked for work to start and not for a lecture about their
        // windows — and `unknown` has been a penalty and never a block since
        // ADR-003's fourth decision row.
        chosen = bestOf(scored);
        warnings.push({
          code: 'balance-fallback',
          message: 'no harness could be paced — every candidate\'s binding window is unknown, spent or '
            + `already reset, so this pick was scored by the ${BALANCE_ORDERING} weights, not balanced`,
        });
      } else {
        // The band is measured from the single leader's number rather than from
        // a row, which is what makes the tied set well defined whatever order
        // the candidates arrived in — the determinism ADR-003 calls
        // load-bearing. The floor has already narrowed the comparison when a
        // paced representative reaches it. Inside the tied set the `balanced`
        // score decides, then ADR-003's own tie-break, and `scored` is already
        // in that order.
        const pickOf = (set) => {
          const leader = Math.max(...set.map((r) => r.pace.effective));
          const tied = set.filter((r) => r.pace.effective >= leader - band);
          return [...tied].sort(byTieBreak)[0];
        };
        // The live-participant cap (PB-162), and it sits HERE rather than in the
        // exclusion steps: a cap is about what THIS TASK has already put on an
        // account, not about the tuple, and the other four strategies answer a
        // question the number of live participants is not an input to. A harness
        // at its cap therefore keeps its candidates, their scores and their pace
        // rows, and only leaves the comparison — the quality floor's own shape.
        const under = balanceRepresentatives.filter((r) => !atCap(r.harness));
        // Every paced harness at its cap: a fallback rather than a refusal, for
        // the reason `balance-fallback` gives one line up — a person asked for
        // work to start. The warning below is what keeps it from being silent.
        chosen = pickOf(under.length ? under : balanceRepresentatives);
        // "Named when it bounded the choice", and WHETHER it bounded one is read
        // off the two picks rather than off the cap being set: a cap that holds
        // out a harness the comparison would not have taken anyway changed
        // nothing, and a warning about it is noise a person learns to skip.
        const uncapped = pickOf(balanceRepresentatives);
        // WHICH harness to name is a different question, and it is read off the
        // rows the cap actually removed. The uncapped pick is not that harness:
        // the band is measured from the leader's number, so removing a capped
        // representative can LOWER the leader and WIDEN the tied set, pulling in
        // a row that was outside it before — and the pick then moves to a harness
        // no cap ever touched. Reading the name off `uncapped` printed "claude is
        // at its live-participant cap of null" on a run where codex was the
        // capped one, and sent a person to edit a key that was never set.
        const heldOut = balanceRepresentatives.filter((r) => atCap(r.harness));
        if (!under.length) {
          warnings.push({
            code: 'live-participant-cap',
            message: `every paced harness is at its live-participant cap — ${[...new Set(balanceRepresentatives
              .map((r) => `${r.harness} ${liveOf(r.harness)}/${capOf(r.harness)}`))].sort().join(', ')}. `
              + `"${chosen.tupleId}" was taken as if no cap were set: a cap holds a run away from one account, `
              + 'it does not leave the run without a participant',
          });
        } else if (chosen !== uncapped) {
          // At least one row was removed, or the two picks would be the same
          // object: `under` is a filter of the same array and `pickOf` is
          // deterministic on equal sets. So `heldOut` is never empty here.
          //
          // The best-paced held-out representative leads the line — it is the
          // one the comparison would have had to beat — and any others follow
          // it, so a person reading the line learns every key it is about.
          const lead = [...heldOut].sort((a, b) => b.pace.effective - a.pace.effective || byTieBreak(a, b))[0];
          const others = [...new Set(heldOut.filter((r) => r.harness !== lead.harness)
            .map((r) => `${r.harness} ${liveOf(r.harness)}/${capOf(r.harness)}`))].sort();
          warnings.push({
            code: 'live-participant-cap',
            message: `${lead.harness} is at its live-participant cap of ${capOf(lead.harness)} `
              + `(${liveOf(lead.harness)} already up), so "${lead.tupleId}" was held out of the pace `
              + `comparison and "${chosen.tupleId}" on ${chosen.harness} was taken instead`
              + `${others.length ? `; also at the ceiling: ${others.join(', ')}` : ''}. The ceiling is `
              + `caps.liveParticipants.${lead.harness} in an overlay`,
          });
        }
      }
    }
    const floorReached = scored.some((row) => row.quality >= floor);
    if (Number.isFinite(floor) && chosen && chosen.quality < floor) {
      const code = role === 'reviewer' ? 'reviewer-floor-not-met' : 'worker-floor-not-met';
      const floorCandidate = scored.find((row) => row.quality >= floor);
      const message = floorReached
        ? `"${chosen.tupleId}" on the ${chosen.harness} harness was taken below the quality floor `
          + `of ${floor} of 10; "${floorCandidate.tupleId}" on the ${floorCandidate.harness} `
          + 'harness meets the floor but was not considered because its binding window is not paced'
        : `no ${role} candidate reaches the quality floor of ${floor} of 10 — `
          + `"${chosen.tupleId}" was taken as the best remaining one`;
      warnings.push({ code, message });
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

  // A flag rule whose mark no model of this run's snapshot carries. A warning
  // rather than an error, because an inventory that names no flags is a normal
  // Tuesday (ADR-004) — and it is raised here rather than in `validate` because
  // only a run holds a snapshot to check the name against. It says the rule
  // matched nothing, never that the guarantee holds: silence is not absence.
  const marks = new Set();
  for (const entry of Object.values(snapshot.harnesses)) {
    for (const model of Array.isArray(entry.models) ? entry.models : []) {
      for (const flag of Array.isArray(model.flags) ? model.flags : []) marks.add(flag);
    }
  }
  for (const rule of ['deny', 'allow']) {
    for (const flag of effective[rule]?.flags ?? []) {
      if (marks.has(flag)) continue;
      const wrote = rulesFor(policy.sources, {
        rule, kind: 'flags', role, name: flag,
      });
      fromSnapshot.push({
        code: 'flag-not-in-inventory',
        message: `no model in this snapshot carries the flag "${flag}" named by ${rulesLabel(wrote)} — `
          + 'the rule excluded nothing, and a harness that lists no models has no flag to match',
      });
    }
  }
  for (const harness of inPlay) {
    const entry = snapshot.harnesses[harness];
    // Measured on the harness's own best scored candidate, because `remaining`
    // is now per tuple: two tuples of one harness can differ when their scopes
    // do, and the warning is about the harness having no readable limit at all.
    const model = scored.find((r) => r.harness === harness)?.model;
    if (remainingOf(entry, model).unknown) {
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
          + `it counts as unknown, ${Date.parse(entry.checkedAt) === 0 ? 'never checked' : `checked at ${entry.checkedAt}`}`,
      });
    }
    if (entry.reason === 'probe_timeout') {
      fromSnapshot.push({
        code: 'probe-incomplete',
        message: `the ${harness} adapter did not answer inside the preflight budget — it counts as unknown`,
      });
    }
  }

  // The near-limit signal (ADR-004 decision 7). It is computed HERE, and not
  // beside the printer, because it needs the pace of each harness and this is
  // the only place that has it — and because `render` reads the decision and
  // nothing else, so a signal the text showed and `--json` did not would be the
  // two outputs of one command reading different sources.
  //
  // Per harness, measured on the best representative there — the same tuple
  // the pace table names when a harness has one pool, and the best-scored one
  // when it has several — because the warning is about the account rather than
  // each pool. The balance comparison itself still uses every representative.
  const nearLimit = rules.nearLimit ?? {};
  // The best representative per harness, and nothing else. A harness already
  // reported as `exhausted` is not repeated — it is a stronger statement about
  // the same account. Reading the harness's TOP row instead would measure a
  // different tuple from the one the pace table prints and the pick compares,
  // and would drop a harness whose best-scoring row happens to be the unpaceable
  // one.
  const nearLimitRepresentatives = [...new Set(representatives.map((r) => r.harness))].sort()
    .map((harness) => bestOf(representatives.filter((r) => r.harness === harness).sort(byTieBreak)))
    .filter(Boolean);
  const paced = nearLimitRepresentatives.map((row) => ({ harness: row.harness, row }));
  const short = paced.filter(({ row }) => row.pace.usedShare * 100 >= nearLimit.usedPercent
    || row.pace.underspend < nearLimit.underspend);
  if (short.length) {
    // `economy` when EVERY paced harness is short by either threshold — the
    // account set as a whole is short, and the answer is to spend less per run.
    // `balance` otherwise: at least one other harness has room, and the answer
    // is to spend it there instead.
    const proposed = paced.length && short.length === paced.length ? 'economy' : 'balance';
    // A warning that recommends what is already happening is noise.
    if (proposed !== strategy) {
      for (const { harness, row } of short) {
        const { pace } = row;
        // Which of the two tests tripped, named rather than left to be worked
        // out from the numbers: a level and a rate are different facts about one
        // window, and "85 % used" and "fifteen points ahead of pace" ask for
        // different things. Both can be true at once, and then both are said.
        const why = [
          pace.usedShare * 100 >= nearLimit.usedPercent
            ? `${(pace.usedShare * 100).toFixed(1)} % of it is used, at or past the ${nearLimit.usedPercent} % threshold`
            : null,
          pace.underspend < nearLimit.underspend
            ? `it is ${(0 - pace.underspend).toFixed(2)} points ahead of its own pace, past the `
              + `${nearLimit.underspend} the threshold allows`
            : null,
        ].filter(Boolean).join('; and ');
        const reset = row.entry.windows?.find((w) => w.id === pace.window.id)?.resetAt;
        fromSnapshot.push({
          code: 'near-limit',
          message: `${harness} is running short — its ${pace.window.kind} window "${pace.window.id}" `
            + `(${(pace.elapsedShare * 100).toFixed(1)} % elapsed${reset ? `, resets at ${reset}` : ''}): ${why}. `
            + `Propose --strategy ${proposed} to the person and run `
            + `\`${strategyCommands[proposed]}\` once they agree — nothing switches on its own`,
        });
      }
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
    ...(strategy === 'balance' && row.pace ? { pace: row.pace } : {}),
    excluded: row.excluded ?? null,
    chosen: row === chosen,
  });

  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    strategy,
    role,
    weights: { ...weights },
    ...(strategy === 'balance' ? { balance: { band, spendUnit } } : {}),
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

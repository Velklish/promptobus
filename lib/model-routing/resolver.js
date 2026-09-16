// The resolver: one decision, and the three rules that shape it.
// [guides/model-routing.md#the-resolver-one-decision-and-the-three-rules-that-shape-it](../../docs/guides/model-routing.md#the-resolver-one-decision-and-the-three-rules-that-shape-it)
import { GateError } from '../../dist/index.js';
import {
  BALANCE_ORDERING, ROUTED_ROLES, SELECTOR_KINDS, STRATEGIES, isRoutedRole, rulesFor, rulesForRole, rulesLabel,
} from './catalog.js';

/** Identity alias for the canonical routed-role list, kept for callers of this module. */
export const ROLES = ROUTED_ROLES;

/** `schemaVersion` of the document produced here. Two since ADR-004: a fifth `strategy` value,
 * a `pace` block, two warning codes and `strategySource` all arrive together. */
export const DECISION_SCHEMA_VERSION = 2;

/** What `remaining` counts as when it cannot be read. ADR-003 fixes 50 % with the
 * `unknown-availability` adjustment — penalised, never blocking. Not a policy value. */
export const NEUTRAL_REMAINING_PERCENT = 50;

/** Warning codes a decision may carry. `validate` has three of its own that never reach one:
 * copying one the schema does not declare would make an unreadable document ([guides/model-routing.md](../../docs/guides/model-routing.md)). */
const ROLE_FLOOR_WARNINGS = Object.freeze(ROUTED_ROLES.map((role) => `${role}-floor-not-met`));

export const DECISION_WARNINGS = [
  'stale-rating', 'unknown-remaining',
  ...ROLE_FLOOR_WARNINGS,
  'snapshot-stale', 'probe-incomplete',
  'flag-not-in-inventory', 'balance-fallback', 'near-limit',
  'live-participant-cap',
];

/** Exclusion codes a candidate may carry, kept together for schema parity. */
export const EXCLUSION_CODES = [
  'model-not-in-inventory', 'role-not-allowed', 'constraint-mismatch', 'denied-by-policy',
  'payg-not-allowed', 'harness-unavailable', 'harness-exhausted',
];

/** Selector kinds whose value is a field of the TUPLE, applied at filtering step 2. `flags` is
 * the one that is not — it reads the snapshot's model row, so it waits for the inventory step. */
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

/** The harness entry of the snapshot, or `null`. `Object.hasOwn`, not a bare read: the harness
 * grammar admits `constructor` and `toString`, and a bare read hands over a prototype value. */
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
export function ratingsFor(tuple, role) {
  const override = tuple.roleRatings?.[role];
  return override ? { ...tuple.ratings, ...override } : { ...tuple.ratings };
}

/** The models the resolver may choose from: the inventory rows the harness does not hide. A
 * hidden row stays in the snapshot; a tuple naming one is `model-not-in-inventory`. */
function inventoryOf(entry) {
  return Array.isArray(entry.models) ? entry.models.filter((m) => m.hidden !== true) : null;
}

/** Whether one window binds this tuple's model: matched by EXACT id, never by an inferred
 * family (ADR-004). The `api` pool is defined by complement — no `auto` pool names the model. */
function windowBinds(window, model, entry) {
  const scope = window.scope ?? null;
  if (scope === null) return true;
  if (scope.pool === 'auto') return (scope.models ?? []).includes(model);
  if (scope.pool === 'api') {
    return !(entry.windows ?? []).some((w) => w.scope?.pool === 'auto' && (w.scope.models ?? []).includes(model));
  }
  return Array.isArray(scope.models) && scope.models.includes(model);
}

/** The windows that apply to one tuple: the account-wide ones plus the scope covering it.
 * Exported because a lift records the same set, and two definitions would measure two things. */
export function applicableWindows(entry, model) {
  return (Array.isArray(entry.windows) ? entry.windows : []).filter((w) => windowBinds(w, model, entry));
}

/** The remaining allowance for one TUPLE: `100 − max(usedPercent)` over the applicable windows
 * (ADR-003 refined by ADR-004). No window, or `unknown`, is the neutral value plus a penalty. */
function remainingOf(entry, model) {
  const windows = applicableWindows(entry, model);
  if (entry.state === 'unknown' || !windows.length) {
    return { percent: NEUTRAL_REMAINING_PERCENT, unknown: true };
  }
  return { percent: 100 - Math.max(...windows.map((w) => w.usedPercent)), unknown: false };
}

/** A share of 0…1, clamped against clock skew — ADR-004 fixes the clamp on `elapsedShare`. */
const clamp01 = (n) => Math.min(1, Math.max(0, n));

// The pace block of one candidate: how much of its binding window is spent.
// [guides/model-routing.md#paceof--the-pace-block-of-one-candidate-how-much-of-its-binding-window-is-spent](../../docs/guides/model-routing.md#paceof--the-pace-block-of-one-candidate-how-much-of-its-binding-window-is-spent)
function paceOf(entry, tuple, { role, spendUnit, now }) {
  const applicable = applicableWindows(entry, tuple.model)
    .sort((a, b) => b.usedPercent - a.usedPercent || (a.id < b.id ? -1 : 1));
  // Every field is present in every branch, and what could not be computed is `null`: omitting
  // them would make a reader check two things to ask one question.
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
  // The discount is in the units of the underspend and is applied to the tuple that would be
  // picked. `ratingsFor`, not the tuple's own: another number would disagree with the score.
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

/** One `denied-by-policy` exclusion, naming every layer that wrote the rule: ADR-004 made deny
 * a union, so a ban two layers wrote is lifted in neither of them alone. */
const deniedBy = (rules) => ({
  code: 'denied-by-policy',
  detail: `denied by ${rulesLabel(rules)} — a ban is lifted only in the layer that wrote it`,
});

const notAllowedBy = (rules) => ({
  code: 'denied-by-policy',
  detail: `not named by ${rulesLabel(rules)}`,
});

/** Step 2a — the allow and deny lists in force for this role, deny applied after allow. A
 * present and EMPTY allow list admits no tuple; `validate` reports that separately. */
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

/** Step 4a — the `flags` selector, one step after the inventory step. **Silence is not absence**
 * (ADR-004): a harness reporting no inventory has no flags, so a flag deny excludes nothing. */
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

/** Step 2b — `--harness`, `--model` and `--effort`. Constraints, not wishes: a named value
 * narrows and is never replaced, so one that leaves nothing standing ends with no tuple. */
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

  // Only when the harness answered with an inventory: silence about its models is not a claim
  // that this one is absent, and reading it as one would drop every tuple of that harness.
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

/** Step 7 — the four weighted components, then the adjustments in order. A component is its
 * weight over 100 times the normalised value, and adjustments are published as their own rows. */
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

  // `0 - x` rather than `-x`: an overlay may set a penalty to zero, and `-0` is a different
  // value to `Object.is`, so a document carrying it would fail a comparison `0` passes.
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

/** Step 9 — the tie-break in ADR-003's order: effective score, confirmed availability, canonical
 * priority, tuple id. Total, because two tuples cannot share an id. */
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

/** The models the account exposes that the merged catalog does not rate. Shown, never chosen:
 * a rating is what makes a model a tuple. */
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

/** One decision. Pure: `now` is the clock in milliseconds, and nothing here may read one of its
 * own — it produces `snapshot.ageSec` and, under `balance`, `elapsedShare`. */
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
  if (!isRoutedRole(role)) throw new GateError(`resolve: unknown role "${role}" — allowed: ${ROUTED_ROLES.join(', ')}`);
  if (!STRATEGIES.includes(strategy)) {
    throw new GateError(`resolve: unknown strategy "${strategy}" — allowed: ${STRATEGIES.join(', ')}`);
  }
  // `balance` has no weight set of its own and orders tuples inside one harness by the merged
  // `balanced` weights, so the published `weights` are the ones actually used.
  const ordering = strategy === 'balance' ? BALANCE_ORDERING : strategy;
  const weights = rules.weights?.[ordering];
  if (!weights) throw new GateError(`resolve: the merged policy has no weight set for "${ordering}"`);
  if (!snapshot?.harnesses) throw new GateError('resolve: the availability snapshot carries no harnesses');

  // `--allow-payg` reaches the merge as a policy change; the flag is read too, because this
  // function is pure. Opt-in in both places — neither can turn pay-as-you-go back off.
  const paygAllowed = rules.payg?.allow === true || constraints.allowPayg === true;
  const workers = liveParticipants.filter((p) => p?.role === 'worker');

  // Read once: two walks of the same list are two places to drift. `liveParticipants` is ONE
  // TASK's list, so both the penalty and the cap bound a run rather than an account.
  const liveOf = (harness) => liveParticipants.filter((p) => p?.harness === harness).length;
  const caps = rules.caps?.liveParticipants ?? {};
  // A harness with no cap is unbounded. `Number.isInteger`, not a truthiness test: a cap of 0
  // is the person saying "never this harness", and it has to survive the read.
  const capOf = (harness) => (Number.isInteger(caps[harness]) ? caps[harness] : null);
  const atCap = (harness) => {
    const cap = capOf(harness);
    return cap !== null && liveOf(harness) >= cap;
  };

  // The lists in force for THIS role, computed once: the rules do not change between
  // candidates, and a per-candidate merge is the same answer arrived at N times.
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
    // A reviewer differing from every live worker is the second opinion the bonus is for; with
    // no live worker there is nothing to differ from.
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

  // The pace block (ADR-004) is computed for every scored candidate whatever the strategy asked
  // for: `balance` is a CHOICE LAYER above the scoring, not a filter. Published only there.
  const balance = rules.balance ?? {};
  const band = Number.isFinite(balance.band) ? balance.band : 0;
  const spendUnit = Number.isFinite(balance.spendUnit) ? balance.spendUnit : band;
  // Computed under EVERY strategy because the near-limit signal reads it, and a person running
  // `--strategy quality` is owed the same warning. Published only under `balance`.
  for (const row of scored) {
    row.pace = paceOf(row.entry, row.tuple, { role, spendUnit, now });
    // The mark is on the candidate rather than left for a reader to re-derive: a second copy of
    // the rule beside the printer would show a different row after the first edit here.
    if (atCap(row.harness)) row.pace.atCap = true;
  }

  // Step 8. A quality floor is a choice rule, not a filter: a candidate below it keeps its score
  // and only the pick moves. Nothing reaching it is a soft fallback with a warning (ADR-004).
  const floor = rules.qualityFloor?.[role];
  const bestOf = (rows_) => {
    if (!rows_.length) return null;
    const above = Number.isFinite(floor) ? rows_.filter((r) => r.quality >= floor) : rows_;
    return above.length ? above[0] : rows_[0];
  };

  // One representative per eligible harness/pool group: its best ELIGIBLE candidate by the
  // role's ordering that meets the floor — a top row that cannot be paced would drop the group.
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
  // Marked in the document rather than left for a reader to re-derive: a second copy of the
  // rule in the renderer would show a different representative when the floor moved the first.
  for (const row of representatives) row.pace.representative = true;

  // The quality floor sits above the balance comparison: with one floor-meeting representative,
  // only those contend. With none, every representative stays, so balance keeps its fallback.
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
      // The pick, in ADR-004's order, over the representatives: the floor is applied when the
      // representative is chosen, so the pace compared belongs to the tuple in question.
      if (!representatives.length) {
        // No harness could be paced. A fallback rather than a refusal: a person asked for work
        // to start, and `unknown` has been a penalty and never a block since ADR-003.
        chosen = bestOf(scored);
        warnings.push({
          code: 'balance-fallback',
          message: 'no harness could be paced — every candidate\'s binding window is unknown, spent or '
            + `already reset, so this pick was scored by the ${BALANCE_ORDERING} weights, not balanced`,
        });
      } else {
        // The band is measured from the single leader's NUMBER, not from a row: that is what
        // makes the tied set well defined whatever order the candidates arrived in.
        const pickOf = (set) => {
          const leader = Math.max(...set.map((r) => r.pace.effective));
          const tied = set.filter((r) => r.pace.effective >= leader - band);
          return [...tied].sort(byTieBreak)[0];
        };
        // The live-participant cap sits HERE, not in the exclusion steps: it is about what THIS
        // TASK put on an account. A capped harness keeps its rows and only leaves the comparison.
        const under = balanceRepresentatives.filter((r) => !atCap(r.harness));
        // Every paced harness at its cap: a fallback rather than a refusal, and the warning
        // below is what keeps it from being silent.
        chosen = pickOf(under.length ? under : balanceRepresentatives);
        // WHETHER a cap bounded the choice is read off the two picks, not off the cap being set:
        // a cap holding out a harness nothing would have taken changed nothing.
        const uncapped = pickOf(balanceRepresentatives);
        // WHICH harness to name is read off the rows the cap removed, never off `uncapped`:
        // removing a capped row can lower the leader, widen the band and move the pick elsewhere.
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
          // `heldOut` is never empty here: the two picks would be the same object otherwise. The
          // best-paced held-out representative leads the line — the one the pick had to beat.
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
      const code = `${role}-floor-not-met`;
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

  // Warnings copied from the merge carry `code` and `message` and nothing else: that is the
  // whole of a warning here, and the rest stays on the merge's own verdict.
  const copied = (policy.warnings ?? [])
    .filter((w) => DECISION_WARNINGS.includes(w.code))
    .map((w) => ({ code: w.code, message: w.message }));

  // Snapshot-derived warnings, per harness in name order, and only for a harness whose
  // candidates were actually scored: a warning about a harness nothing was taken from explains nothing.
  const inPlay = [...new Set(scored.map((r) => r.harness))].sort();
  const fromSnapshot = [];

  // A flag rule whose mark no model of this snapshot carries — a warning, raised here because
  // only a run holds a snapshot. It says the rule matched nothing, never that a guarantee holds.
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
    // Measured on the harness's own best scored candidate, since `remaining` is per tuple: the
    // warning is about the harness having no readable limit at all.
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

  // The near-limit signal (ADR-004 decision 7), computed HERE because only this place has each
  // harness's pace — and `render` reads the decision alone, so text and `--json` cannot differ.
  const nearLimit = rules.nearLimit ?? {};
  // The best representative per harness and nothing else; an already-`exhausted` harness is not
  // repeated. The TOP row would measure a different tuple from the one the pace table prints.
  const nearLimitRepresentatives = [...new Set(representatives.map((r) => r.harness))].sort()
    .map((harness) => bestOf(representatives.filter((r) => r.harness === harness).sort(byTieBreak)))
    .filter(Boolean);
  const paced = nearLimitRepresentatives.map((row) => ({ harness: row.harness, row }));
  const short = paced.filter(({ row }) => row.pace.usedShare * 100 >= nearLimit.usedPercent
    || row.pace.underspend < nearLimit.underspend);
  if (short.length) {
    // `economy` when EVERY paced harness is short: the account set as a whole is, and the answer
    // is to spend less per run. `balance` otherwise — another harness has room.
    const proposed = paced.length && short.length === paced.length ? 'economy' : 'balance';
    // A warning that recommends what is already happening is noise.
    if (proposed !== strategy) {
      for (const { harness, row } of short) {
        const { pace } = row;
        // Which of the two tests tripped, named rather than left to be worked out: a level and a
        // rate are different facts, and both can be true at once.
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

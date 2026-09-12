// Calibrate: reading the telemetry back.
// [guides/model-routing.md#calibrate-reading-the-telemetry-back](../../docs/guides/model-routing.md#calibrate-reading-the-telemetry-back)

import { throughputRate } from './telemetry.js';

/**
 * Runs per key before anything is proposed. A constant of ADR-005, deliberately
 * not an overlay key: an evidence threshold a person could lower is a threshold
 * that stops being evidence.
 */
export const EVIDENCE_THRESHOLD = 5;

/**
 * What one band of difference is worth as a ratio. ADR-005 fixes 1.25: two
 * catalog bands apart implies `1.25²` in measured throughput or window delta.
 * It is a stated convention, not a measurement — which is why nothing below
 * proposes a band from a ratio alone, only a STEP away from a band the catalog
 * already assessed.
 */
export const BAND_RATIO = 1.25;

/** A measured ratio this far from the one the bands imply moves one band. */
export const SURPRISE_ONE = 1.5;

/** …and this far moves two, which is also the cap. */
export const SURPRISE_TWO = 3;

/** Bands one run of `calibrate` may move a rating, in either direction. */
export const MAX_MOVE = 2;

/** The rating floor and ceiling of ADR-005. */
const MIN_BAND = 1;
const MAX_BAND = 10;

const clampBand = (n) => Math.min(MAX_BAND, Math.max(MIN_BAND, n));

/**
 * Median of a sample, `null` when there is none.
 *
 * The even case takes the mean of the two middle values. Durations, throughput
 * and window deltas are continuous quantities, so the mean of the pair is a
 * value of the same kind; `turns` and `reviewRounds` are counts, and a `.5`
 * there is read as what it is — a sample of two that disagrees.
 */
export function median(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * A record's one window number, or `null`.
 *
 * The LARGEST delta among the windows that applied to the run, not their sum and
 * not one of them chosen by kind. The resolver scores a tuple on
 * `100 − max(usedPercent)` over exactly this set (ADR-003, refined by ADR-004),
 * so the window that bound the pick is the window whose movement is the spend a
 * proposal may argue with. A sum would count one account's session and weekly
 * windows twice for the same tokens.
 *
 * A window whose end reading is absent contributes nothing — the cache entry was
 * already stale when the record was written, and a delta against a stale
 * percentage is not a delta. A NEGATIVE delta is a window that reset or was
 * replaced mid-run; it is dropped for the same reason rather than clamped to
 * zero, which would read as "this run spent nothing".
 */
export function windowDelta(record) {
  const deltas = [];
  for (const w of Array.isArray(record?.windows) ? record.windows : []) {
    if (typeof w?.usedPercentAtEnd !== 'number' || typeof w?.usedPercentAtSpawn !== 'number') continue;
    const d = w.usedPercentAtEnd - w.usedPercentAtSpawn;
    if (d < 0) continue;
    deltas.push(d);
  }
  return deltas.length ? Math.max(...deltas) : null;
}

/**
 * Whether a record is an ACCEPTED PIECE (ADR-005's term): it was not dismissed
 * before `done` and it sent at least one result.
 *
 * Only these enter completion-duration, turn and review-round medians. A
 * completion duration runs from the lift to the participant's last result,
 * falling back to dismissal and then the task close. Throughput is model-output
 * evidence and uses every record that carries a usable observation, including a
 * dismissed run; a run without a result can still report tokens/s.
 */
export function acceptedPiece(record) {
  return record?.dismissedBeforeDone !== true && (record?.resultCount ?? 0) >= 1;
}

/**
 * The model id a key is on, resolving a harness alias through the dictionary the
 * DRIVER handed over.
 *
 * `aliases` is `{ harness: { alias: [id, …] } }` — each driver's own
 * `options.modelAliases`, passed in by the command. Nothing is imported here and
 * nothing is inferred from a name: an alias points at whatever the vendor moved
 * Calibrate: reading the telemetry back.
 * ([guides/model-routing.md#calibrate-reading-the-telemetry-back](../../docs/guides/model-routing.md#calibrate-reading-the-telemetry-back)). It is keyed BY HARNESS because a name is only an
 * alias on the harness that publishes it — `sonnet` typed at a harness with no
 * such alias is a model name, and resolving it from a neighbour's dictionary
 * would move one harness's runs onto another's row.
 *
 * An alias naming more than one id resolves to none of them: two ids is not a
 * resolution, and taking the first would attribute a person's runs to a row at
 * random.
 */
export function resolveModel(harness, model, aliases = {}) {
  const table = Object.hasOwn(aliases ?? {}, harness) ? aliases[harness] : null;
  const ids = table && Object.hasOwn(table, model) ? table[model] : null;
  if (!Array.isArray(ids) || ids.length !== 1) return { model, alias: null };
  return { model: ids[0], alias: model };
}

/** The catalog row for one key, or `null`. Effort is compared as written, including `null`. */
function rowFor(tuples, harness, model, effort) {
  return tuples.find((t) => t.harness === harness && t.model === model
    && (t.effort ?? null) === (effort ?? null)) ?? null;
}

/** Stable order of the keys, and the tie-break ADR-005 names for the pivot. */
function keyOrder(a, b) {
  return a.harness.localeCompare(b.harness)
    || a.model.localeCompare(b.model)
    || String(a.effort ?? '').localeCompare(String(b.effort ?? ''));
}

/** Stable order for the model-level speed groups and their pivot tie-break. */
function modelOrder(a, b) {
  return a.harness.localeCompare(b.harness) || a.model.localeCompare(b.model);
}

/**
 * How many bands a measured ratio moves a rating, before clamping.
 *
 * `surprise` is the observed ratio divided by the ratio the two rows' catalog
 * bands imply, so 1 means "the catalog already said this" and no move. The scale
 * is symmetric in the multiplicative sense — `1 / 1.5` is as surprising as
 * `1.5` — because a ratio's neutral point is one, not zero.
 */
export function moveFor(surprise) {
  if (!Number.isFinite(surprise) || surprise <= 0) return 0;
  if (surprise >= SURPRISE_TWO) return MAX_MOVE;
  if (surprise >= SURPRISE_ONE) return 1;
  if (surprise <= 1 / SURPRISE_TWO) return -MAX_MOVE;
  if (surprise <= 1 / SURPRISE_ONE) return -1;
  return 0;
}

/**
 * One rating's proposal, or the reason there is none.
 *
 * Both calibrated measurements increase with their rating: a bigger window
 * delta means more quota cost, and a larger tokens/second observation means
 * higher throughput.
 */
function proposeRating({
  observed, pivotObserved, band, pivotBand, missing,
}) {
  if (observed === null || pivotObserved === null) return { band: null, why: missing };
  if (pivotObserved === 0) {
    return { band: null, why: 'the pivot median is zero, so there is no ratio to compare against' };
  }
  // A measured zero is below the RESOLUTION of what was measured, not a
  // measurement of nearly nothing. `usedPercent` and its window deltas arrive as
  // whole percentage points, so a median of 0 says the
  // runs were too small to register — and turning that into "far cheaper than
  // the catalog" would propose a two-band drop from an absence of evidence. It
  // is the zero-pivot case seen from the other side and it is answered the same
  // way.
  if (observed === 0) {
    return {
      band: null,
      why: 'the median is zero — the runs are below what this measurement can resolve, '
        + 'which is not evidence of a near-zero value',
    };
  }
  const ratio = observed / pivotObserved;
  // The ratio the two rows' CATALOG bands already imply, in the same direction
  // as the measurement. `speed`: a higher throughput is the higher band.
  const implied = BAND_RATIO ** (band - pivotBand);
  const surprise = implied === 0 ? NaN : ratio / implied;
  // The report is a document a machine reads back, so a neutral move is the
  // ordinary numeric zero.
  const move = moveFor(surprise) || 0;
  return {
    band: clampBand(band + move),
    move,
    ratio,
    implied,
    surprise,
    why: null,
  };
}

/**
 * Group the records, compare them with the catalog, and propose.
 *
 * Pure. `records` are telemetry rows as written; `tuples` is the SHIPPED
 * catalog's tuple list and is what every band is compared against;
 * `overlayTuples` is the merged stack, read only to show a person the override
 * they already have; `overlaySources` names the layer that supplied each such
 * rating; `aliases` is the driver's alias dictionary. Nothing is read from disk
 * and nothing is written: `--write` is the command's, and it acts on `ratings`
 * below and on no other part of this report.
 */
export function calibrate(records = [], {
  tuples = [], overlayTuples = null, overlaySources = null, aliases = {}, threshold = EVIDENCE_THRESHOLD,
} = {}) {
  const groups = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (typeof r?.harness !== 'string' || typeof r?.model !== 'string') continue;
    const { model, alias } = resolveModel(r.harness, r.model, aliases);
    const effort = typeof r.effort === 'string' && r.effort ? r.effort : null;
    const id = JSON.stringify([r.harness, model, effort]);
    if (!groups.has(id)) {
      groups.set(id, {
        harness: r.harness, model, effort, aliases: new Set(), records: [],
      });
    }
    const g = groups.get(id);
    if (alias) g.aliases.add(alias);
    g.records.push(r);
  }

  // Speed is a model property, so its evidence is pooled across the effort
  // ladder. Keep the original key groups as well: duration and quotaCost remain
  // useful per-rung completion/spend evidence.
  const speedGroups = new Map();
  for (const g of groups.values()) {
    const id = JSON.stringify([g.harness, g.model]);
    if (!speedGroups.has(id)) {
      speedGroups.set(id, { harness: g.harness, model: g.model, records: [] });
    }
    speedGroups.get(id).records.push(...g.records);
  }

  const keys = [...groups.values()].map((g) => {
    const accepted = g.records.filter(acceptedPiece);
    const deltas = g.records.map(windowDelta).filter((d) => d !== null);
    const throughputValues = g.records.map(throughputRate).filter((rate) => rate !== null);
    const row = rowFor(tuples, g.harness, g.model, g.effort);
    // The same row after the overlays, when the caller handed them over. Only
    // the ratings that actually differ are kept: an overlay that repeats the
    // catalog band is not an override a reader needs to be told about.
    const merged = overlayTuples ? rowFor(overlayTuples, g.harness, g.model, g.effort) : null;
    const override = {};
    const overrideSources = {};
    if (row && merged) {
      for (const name of ['quality', 'speed', 'quotaCost']) {
        if (merged.ratings[name] !== row.ratings[name]) {
          override[name] = merged.ratings[name];
          const source = overlaySources?.[row.id]?.[name];
          if (typeof source === 'string') overrideSources[name] = source;
        }
      }
    }
    return {
      harness: g.harness,
      model: g.model,
      effort: g.effort,
      // The names a person actually typed that landed on this row. Printed so a
      // reader can see WHY their `--model opus` runs are under `claude-opus-5`.
      aliasesSeen: [...g.aliases].sort(),
      tuple: row?.id ?? null,
      runs: g.records.length,
      acceptedPieces: accepted.length,
      dismissed: g.records.filter((r) => r.dismissedBeforeDone === true).length,
      withoutWindows: g.records.filter((r) => windowDelta(r) === null).length,
      durationSec: median(accepted.map((r) => r.durationSec)),
      durationSamples: accepted.filter((r) => typeof r.durationSec === 'number').length,
      throughput: median(throughputValues),
      throughputSamples: throughputValues.length,
      turns: median(accepted.map((r) => r.turns)),
      reviewRounds: median(accepted.map((r) => r.reviewRounds)),
      windowDelta: median(deltas),
      windowSamples: deltas.length,
      catalog: row
        ? { quality: row.ratings.quality, speed: row.ratings.speed, quotaCost: row.ratings.quotaCost }
        : null,
      override: Object.keys(override).length ? override : null,
      overrideSources: Object.keys(overrideSources).length ? overrideSources : null,
      eligible: g.records.length >= threshold && Boolean(row),
      note: null,
      proposal: null,
    };
  }).sort(keyOrder);

  const speedModels = [...speedGroups.values()].map((g) => {
    const throughputValues = g.records.map(throughputRate).filter((rate) => rate !== null);
    const ratedTuples = tuples.filter((tuple) => tuple.harness === g.harness && tuple.model === g.model
      && typeof tuple.ratings?.speed === 'number');
    // ADR-005 keeps speed constant along a ladder. The shipped catalog's base
    // row is the one without `interpolatedFrom`; use that row as the anchor rather
    // than whichever rung happened to have telemetry first.
    const base = ratedTuples.find((tuple) => !tuple.evidence?.interpolatedFrom) ?? ratedTuples[0];
    return {
      harness: g.harness,
      model: g.model,
      runs: g.records.length,
      throughput: median(throughputValues),
      throughputSamples: throughputValues.length,
      catalogSpeed: base?.ratings.speed ?? null,
    };
  }).sort(modelOrder);

  for (const k of keys) {
    if (k.runs < threshold) k.note = `insufficient data: ${k.runs} of ${threshold}`;
    else if (!k.catalog) {
      k.note = `no catalog row rates ${k.harness}/${k.model}`
        + `${k.effort ? `/${k.effort}` : ''} — there is no band to move`;
    }
  }

  // The pivot: most runs among the eligible keys, ties settled by the key order
  // above. `keys` is already in that order, so a stable max by run count IS the
  // tie-break — no second rule to keep in step with the first.
  const eligible = keys.filter((k) => k.eligible);
  const pivot = eligible.reduce((best, k) => (best === null || k.runs > best.runs ? k : best), null);

  // Speed's anchor is the most-observed model with a usable throughput median,
  // independently of the per-rung quotaCost pivot.
  const speedEligible = speedModels.filter((m) => m.throughputSamples >= threshold
    && m.catalogSpeed !== null);
  const speedPivot = speedEligible.reduce((best, m) => (
    best === null || m.throughputSamples > best.throughputSamples ? m : best
  ), null);
  const speedByModel = new Map(speedModels.map((m) => [JSON.stringify([m.harness, m.model]), m]));

  const speedProposalForModel = (model) => {
    if (!model) return null;
    if (model.catalogSpeed === null) return { band: null, why: 'catalog has no speed band for this model' };
    // A rung below the run threshold has no per-rung proposal when the model
    // has no pooled throughput evidence either. A model with enough pooled
    // observations may still carry its one speed proposal to every rung.
    const missing = model.throughputSamples === 0
      ? 'no throughput observation for this model'
      : model.throughputSamples < threshold
        ? `fewer than ${threshold} throughput observations for this model`
        : 'throughput comparison is unavailable';
    if (model.throughputSamples < threshold) return { band: null, why: missing };
    if (model === speedPivot) {
      return { band: model.catalogSpeed, move: 0, why: null, pivot: true };
    }
    return proposeRating({
      observed: model.throughput,
      pivotObserved: speedPivot.throughput,
      band: model.catalogSpeed,
      pivotBand: speedPivot.catalogSpeed,
      missing,
    });
  };
  const speedProposals = new Map(speedModels.map((model) => [
    JSON.stringify([model.harness, model.model]), speedProposalForModel(model),
  ]));
  const speedProposal = (k) => {
    const model = speedByModel.get(JSON.stringify([k.harness, k.model]));
    if (!model || !k.catalog) return null;
    // A rung below the threshold has no proposal unless its model has enough
    // pooled evidence to carry a model-level speed band to it.
    if (model.throughputSamples < threshold && !k.eligible) return null;
    return speedProposals.get(JSON.stringify([k.harness, k.model])) ?? null;
  };

  for (const k of keys) {
    const speed = speedProposal(k);
    let quotaCost = null;
    if (k.eligible) {
      quotaCost = k === pivot
        ? { band: k.catalog.quotaCost, move: 0, why: null, pivot: true }
        : proposeRating({
          observed: k.windowDelta,
          pivotObserved: pivot.windowDelta,
          band: k.catalog.quotaCost,
          pivotBand: pivot.catalog.quotaCost,
          missing: 'no usable window delta on this key or on the pivot',
        });
    }
    if (speed || quotaCost) {
      k.proposal = {
        pivot: k === pivot,
        speed,
        speedPivot: speed?.pivot === true,
        quotaCost,
      };
    }
  }

  // The merge payload of `--write`: only ratings that MOVED. A proposal equal to
  // the catalog band is still printed beside it — that is the reader's
  // confirmation that the local runs agree — but writing it would leave an
  // override in a person's file that says nothing and goes on saying it after
  // the next catalog update moves the row underneath it.
  const ratings = {};
  for (const k of keys) {
    if (!k.proposal || !k.tuple) continue;
    const block = {};
    for (const name of ['speed', 'quotaCost']) {
      const p = k.proposal[name];
      if (p?.band === null || p?.band === undefined) continue;
      if (p.band === k.catalog[name]) continue;
      block[name] = p.band;
    }
    if (Object.keys(block).length) ratings[k.tuple] = block;
  }
  // Speed belongs to the model, not to the rungs that happened to produce
  // telemetry. Project a valid model-level proposal onto every rated tuple in
  // the shipped ladder, including rungs with no records yet.
  // The shipped catalog invariant is one speed band across a model's effort
  // ladder; the projection also normalises a malformed input ladder to its
  // model proposal, including for the pivot model that otherwise keeps its band.
  for (const tuple of tuples) {
    if (typeof tuple?.id !== 'string' || typeof tuple.ratings?.speed !== 'number') continue;
    const proposal = speedProposals.get(JSON.stringify([tuple.harness, tuple.model]));
    if (!proposal || proposal.band === null || proposal.band === undefined) continue;
    if (proposal.band === tuple.ratings.speed) continue;
    ratings[tuple.id] = { ...(ratings[tuple.id] ?? {}), speed: proposal.band };
  }

  return {
    threshold,
    records: Array.isArray(records) ? records.length : 0,
    keys,
    pivot: pivot ? { harness: pivot.harness, model: pivot.model, effort: pivot.effort, tuple: pivot.tuple, runs: pivot.runs } : null,
    speedPivot: speedPivot ? {
      harness: speedPivot.harness,
      model: speedPivot.model,
      runs: speedPivot.runs,
      throughput: speedPivot.throughput,
      throughputSamples: speedPivot.throughputSamples,
    } : null,
    speedModels: speedModels.map(({ harness, model, runs, throughput, throughputSamples }) => ({
      harness, model, runs, throughput, throughputSamples,
    })),
    ratings,
  };
}

const n1 = (x) => (x === null || x === undefined ? '—' : Math.round(x * 10) / 10);
const n2 = (x) => (x === null || x === undefined ? '—' : Math.round(x * 100) / 100);

/** The key as a person reads it: harness, model, effort, and the aliases that landed on it. */
function keyLabel(k) {
  const base = `${k.harness} · ${k.model}${k.effort ? ` · ${k.effort}` : ''}`;
  return k.aliasesSeen.length ? `${base} (alias ${k.aliasesSeen.join(', ')})` : base;
}

function ratingLine(name, p, current, override, overrideSource) {
  const base = override === null || override === undefined
    ? `catalog ${current}`
    : overrideSource
      ? `catalog ${current}, overlay "${overrideSource}" ${override}`
      : `catalog ${current}, your overlay ${override}`;
  if (p.band === null) return `      ${name}: no proposal — ${p.why} (${base})`;
  const moved = p.band === current ? 'unchanged' : `${current} → ${p.band}`;
  const behind = p.move === undefined || p.pivot
    ? 'the pivot keeps its catalog band'
    : `observed ratio ${n2(p.ratio)} against ${n2(p.implied)} implied by the bands `
      + `= ${n2(p.surprise)}× surprise, ${p.move === 0 ? 'no move' : `${p.move > 0 ? '+' : ''}${p.move} band(s)`}`;
  return `      ${name}: ${moved} (${base}) — ${behind}`;
}

/**
 * The text `models calibrate` prints.
 *
 * A block per key, in the key order, with every number a proposal rests on
 * beside it. The overlay lines come last, together, because that is the shape a
 * person pastes — and the same lines are what `--write` merges, so what is read
 * and what is written cannot drift apart.
 */
export function renderCalibration(report) {
  const out = [];
  out.push(`telemetry: ${report.records} record(s) over ${report.keys.length} key(s); `
    + `evidence threshold ${report.threshold} throughput observation(s) for speed, `
    + `${report.threshold} run(s) per key for quotaCost`);
  out.push('every band below is compared against the SHIPPED catalog, not against an overlay: '
    + 'a proposal is one step from the shipped band, so running this twice on one file proposes '
    + 'the same thing twice');
  if (report.pivot) {
    out.push(`pivot (local anchor): ${report.pivot.harness} · ${report.pivot.model}`
      + `${report.pivot.effort ? ` · ${report.pivot.effort}` : ''} — ${report.pivot.runs} run(s), keeps its catalog bands`);
  } else {
    out.push('pivot (local anchor): none — no key reaches the threshold with a catalog row behind it');
  }
  if (report.speedPivot) {
    out.push(`speed pivot (throughput anchor): ${report.speedPivot.harness} · ${report.speedPivot.model}`
      + ` — ${report.speedPivot.throughputSamples} observation(s), ${n1(report.speedPivot.throughput)} tokens/s; `
      + 'one speed band across the effort ladder');
  } else {
    out.push('speed pivot (throughput anchor): none — no model has enough throughput observations with a catalog row');
  }
  for (const model of report.speedModels ?? []) {
    if (model.throughputSamples > 0) continue;
    out.push(`speed evidence: ${model.harness} · ${model.model} — no throughput observation; `
      + 'duration is completion-duration evidence and is not used for speed');
  }
  for (const k of report.keys) {
    out.push('');
    out.push(`  ${keyLabel(k)}${k.tuple ? ` → ${k.tuple}` : ''}`);
    out.push(`    ${k.runs} run(s), ${k.acceptedPieces} accepted piece(s), `
      + `${k.dismissed} dismissed, ${k.withoutWindows} without windows`);
    out.push(`    median completion duration ${n1(k.durationSec)}s over ${k.durationSamples} sample(s) · `
      + `median throughput ${n1(k.throughput)} tokens/s over ${k.throughputSamples} sample(s) · `
      + `median window delta ${n1(k.windowDelta)} pp over ${k.windowSamples} sample(s)`);
    // `quality` is indirect and stays a note: review rounds and accepted pieces
    // measure how a run was received, not how good the model is, and ADR-005
    // keeps a telemetry-derived quality rating out of v1 entirely.
    out.push(`    note (quality is not proposed from telemetry): median turns ${n1(k.turns)}, `
      + `median review rounds per accepted piece ${n1(k.reviewRounds)}`);
    if (k.note) {
      out.push(`    ${k.note}${k.proposal ? '' : ' — nothing proposed'}`);
      if (!k.proposal) continue;
    }
    out.push('    proposed:');
    const speed = k.proposal.speed;
    const quotaCost = k.proposal.quotaCost ?? { band: null, why: k.note ?? 'insufficient data' };
    out.push(ratingLine('speed', { ...speed, pivot: k.proposal.speedPivot },
      k.catalog.speed, k.override?.speed, k.overrideSources?.speed));
    out.push(ratingLine('quotaCost', { ...quotaCost, pivot: k.proposal.pivot },
      k.catalog.quotaCost, k.override?.quotaCost, k.overrideSources?.quotaCost));
  }
  out.push('');
  const moved = Object.keys(report.ratings);
  if (!moved.length) {
    out.push('no rating moves: no eligible speed or quotaCost proposal moved a catalog band. Nothing to write.');
    return out.join('\n');
  }
  out.push(`overlay lines (${moved.length} tuple(s)) — "ratings" of a schemaVersion 2 overlay:`);
  out.push(JSON.stringify({ ratings: report.ratings }, null, 2));
  return out.join('\n');
}

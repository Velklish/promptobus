// Calibrate: reading the telemetry back.
// [guides/model-routing.md#calibrate-reading-the-telemetry-back](../../docs/guides/model-routing.md#calibrate-reading-the-telemetry-back)

import { throughputRate } from './telemetry.js';

/** Runs per key before anything is proposed. A constant of ADR-005, deliberately not an
 * overlay key: an evidence threshold a person could lower stops being evidence. */
export const EVIDENCE_THRESHOLD = 5;

/** What one band of difference is worth as a ratio; ADR-005 fixes 1.25. A stated convention,
 * not a measurement — which is why nothing proposes a band from a ratio alone. */
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

/** Median of a sample, `null` when there is none. The even case takes the mean of the two
 * middle values; a `.5` in a count is read as what it is — a sample of two that disagrees. */
export function median(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** A record's one window number: the LARGEST delta among the windows that applied, not their
 * sum — the resolver scores on the same set. An absent end reading or a negative delta drops. */
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

/** An ACCEPTED PIECE (ADR-005): not dismissed before `done`, and at least one result sent.
 * Only these enter duration, turn and review-round medians; throughput uses every record. */
export function acceptedPiece(record) {
  return record?.dismissedBeforeDone !== true && (record?.resultCount ?? 0) >= 1;
}

/** The model id a key is on, through the DRIVER's alias dictionary and keyed BY HARNESS: a
 * name is an alias only where it is published ([guides/model-routing.md](../../docs/guides/model-routing.md)). */
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

/** How many bands a measured ratio moves a rating, before clamping. `surprise` is 1 when the
 * catalog already said this; the scale is symmetric multiplicatively, since neutral is one. */
export function moveFor(surprise) {
  if (!Number.isFinite(surprise) || surprise <= 0) return 0;
  if (surprise >= SURPRISE_TWO) return MAX_MOVE;
  if (surprise >= SURPRISE_ONE) return 1;
  if (surprise <= 1 / SURPRISE_TWO) return -MAX_MOVE;
  if (surprise <= 1 / SURPRISE_ONE) return -1;
  return 0;
}

/** One rating's proposal, or the reason there is none. Both calibrated measurements increase
 * with their rating: a bigger window delta is more quota, more tokens/s is more throughput. */
function proposeRating({
  observed, pivotObserved, band, pivotBand, missing,
}) {
  if (observed === null || pivotObserved === null) return { band: null, why: missing };
  if (pivotObserved === 0) {
    return { band: null, why: 'the pivot median is zero, so there is no ratio to compare against' };
  }
  // A measured zero is below the RESOLUTION of the measurement: `usedPercent` arrives in whole
  // points, so a median of 0 means the runs were too small to register, not "far cheaper".
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

/** Group the records, compare them with the catalog, and propose. Pure: nothing is read from
 * disk and nothing written — `--write` is the command's, and it acts on `ratings` alone. */
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

  // Speed is a model property, so its evidence pools across the effort ladder. The original
  // key groups stay: duration and quotaCost remain per-rung evidence.
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
    // The same row after the overlays. Only ratings that differ are kept: an overlay repeating
    // the catalog band is not an override a reader needs to be told about.
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
      // reader can see WHY their `--model opus` runs are under `claude-opus-5-5`.
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
    // ADR-005 keeps speed constant along a ladder. The anchor is the shipped base row — the
    // one without `interpolatedFrom` — not whichever rung had telemetry first.
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

  // The pivot: most runs among the eligible keys, ties settled by the key order. `keys` is
  // already in that order, so a stable max by run count IS the tie-break.
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
    // A rung below the run threshold has no per-rung proposal without pooled throughput
    // evidence; with enough pooled observations a model still carries its speed proposal.
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

  // The merge payload of `--write`: only ratings that MOVED. Writing an unmoved one would
  // leave an override that says nothing and keeps saying it after the next catalog update.
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
  // Speed belongs to the model, not to the rungs that produced telemetry: project it onto
  // every rated tuple, which also normalises a malformed input ladder to its model proposal.
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

/** The text `models calibrate` prints. The overlay lines come last and together, because that
 * is the shape a person pastes — and the same lines are what `--write` merges. */
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
    // `quality` is indirect and stays a note: rounds and accepted pieces measure how a run was
    // received, and ADR-005 keeps a telemetry-derived quality rating out of v1.
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

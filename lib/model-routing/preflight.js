// Availability preflight: ask every declared harness what the account can do
// right now, all at once, under one budget, and hand back the availability
// snapshot the resolver reads.
//
// Three decisions shape this file.
//
// **One budget for the whole run, not one per harness.** Adapters run in
// parallel, so each is given the whole budget as its own ceiling and the run ends
// when the budget does. A harness that has not answered by then is `unknown` /
// `probe_timeout` and does not hold the command: a person waiting on `spawn` pays
// once for the slowest harness, never three times in a row.
//
// **The cache is consulted before the adapters, not after.** A live entry means no
// probe at all; `--refresh` drops the live entries and probes again. What
// `--refresh` cannot drop is a sticky exhaustion ([cache.js](cache.js)).
//
// **`--dry-run` without `--refresh` never probes.** A dry run is how a person asks
// a question, and a question that starts three harness binaries and waits fifteen
// seconds is not one. A harness with no live entry then reports `unknown` /
// `stale_cache` — reported, never silently taken as available.
//
// Flags are the CLI's words; this module takes `refresh` and `dryRun` as options
// and knows nothing about argv.

import { AVAILABILITY_REASONS, AVAILABILITY_SOURCES, AVAILABILITY_STATES } from '../../dist/index.js';
import {
  NEVER_CHECKED, SNAPSHOT_VERSION, heldOf, isTimestamp, isoStamp, readSnapshot, snapshotEntry,
  writeEntries,
} from './cache.js';

/**
 * Total budget for the whole preflight, in milliseconds. Fixed at 15 s by
 * ADR-003 — the ceiling a person waits before a routed command starts anything.
 * The parameter exists so the suite can run the same code against a budget it can
 * afford to wait out; nothing in production passes it.
 */
export const PREFLIGHT_BUDGET_MS = 15_000;

/**
 * A verdict that is not one — an adapter that threw, or answered something outside
 * the contract.
 *
 * **The thrown text is not carried.** An adapter that wraps harness output in an
 * error (`throw new Error(stderr)` is the obvious way to write it) would put that
 * output straight into the one free-text field that reaches disk, and the cache is
 * the file that must not leak. Only the error's kind survives; an adapter with
 * something to say says it by ANSWERING — a verdict with a reason and a message it
 * wrote itself is the contract's channel for that, and throwing is not.
 */
function failedVerdict(kind) {
  return {
    state: 'unknown',
    reason: 'probe_failed',
    message: `the adapter did not answer the contract (${kind})`,
    checkedAt: isoStamp(),
    source: 'probe',
    resetAt: null,
  };
}

/** A harness that did not answer inside the budget. It is unknown, which the resolver penalises, not death. */
function timedOutVerdict(budgetMs) {
  return {
    state: 'unknown',
    reason: 'probe_timeout',
    message: `no answer within the ${budgetMs} ms preflight budget`,
    checkedAt: isoStamp(),
    source: 'probe',
    resetAt: null,
  };
}

/**
 * A harness the cache cannot answer for and no probe was run for.
 *
 * The stamp separates the two cases the one reason code cannot. An entry that
 * expired keeps its own `checkedAt` — that age is what a decision reports next to
 * its `snapshot-stale` warning, and stamping it "now" would claim the harness was
 * just looked at. A harness the cache never held gets `NEVER_CHECKED`, because it
 * has no age at all and the run stamp would give it the freshest one on the page.
 * `source` stays `cache` in both: the cache is what was consulted, and the
 * schema's three sources have no fourth value for "consulted and found nothing".
 *
 * Nothing else of the expired entry is carried — a stale model inventory read as
 * current is worse than none.
 */
function staleVerdict(stored) {
  return {
    state: 'unknown',
    reason: 'stale_cache',
    message: stored
      ? 'the cache entry outlived its TTL and no probe ran'
      : 'no cache entry for this harness and no probe ran',
    checkedAt: stored?.checkedAt && isTimestamp(stored.checkedAt) ? stored.checkedAt : NEVER_CHECKED,
    source: 'cache',
    resetAt: null,
  };
}

/**
 * A value echoed back in a diagnosis, or `null` when it is not safe to echo.
 *
 * The fields checked below are closed lists, and the mistake worth naming is a
 * typo in one of them — `quota-unknown` for `quota_unknown` is invisible unless
 * the diagnosis prints it. So the value is quoted back, but only through the
 * shape a code has: this is the one place adapter-authored text can reach the
 * message, and the no-secrets rule does not get an exception for convenience.
 */
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,40}$/;
const echoed = (value) => (CODE_SHAPE.test(String(value ?? '')) ? ` ${JSON.stringify(String(value))}` : '');

/**
 * What is wrong with an adapter's answer, or `null` when nothing is.
 *
 * All three closed lists are checked, not just the state. The written cache
 * promises to validate against the snapshot schema, and a misspelled reason or a
 * missing `source` would break that promise from inside — the file would carry a
 * document nothing can read back, and the run that wrote it would have said it
 * succeeded. This is the gate a typo in PB-15…PB-17 meets.
 *
 * A reason is required for every state but `available`: the reference maps each
 * of the nine codes to a state, and none of them accompanies `available`. So a
 * null reason there is the normal case, and a null reason anywhere else is an
 * adapter that did not say why.
 */
function contractBreach(answer) {
  if (!answer || typeof answer !== 'object') return 'no verdict at all';
  if (!AVAILABILITY_STATES.includes(answer.state)) return `unknown state${echoed(answer.state)}`;
  const reason = answer.reason ?? null;
  if (reason === null) {
    if (answer.state !== 'available') return `state ${answer.state} with no reason`;
  } else if (!AVAILABILITY_REASONS.includes(reason)) {
    return `unknown reason${echoed(reason)}`;
  }
  if (answer.source !== undefined && !AVAILABILITY_SOURCES.includes(answer.source)) {
    return `unknown source${echoed(answer.source)}`;
  }
  if (answer.checkedAt !== undefined && !isTimestamp(answer.checkedAt)) return 'unreadable checkedAt';
  return null;
}

/** An adapter answer, taken as far as the contract allows and no further. */
function verdictOf(answer) {
  const breach = contractBreach(answer);
  if (breach) return failedVerdict(breach);
  return {
    ...answer,
    checkedAt: isoStamp(answer.checkedAt ?? null),
    source: answer.source ?? 'probe',
  };
}

/**
 * Run the adapters. They all start together and the budget runs beside them; when
 * it wins, whatever has not settled is a timeout.
 *
 * The budget timer is cleared on the way out, so a fast run does not hold the
 * event loop for the rest of the budget. An adapter's own pending work is its
 * own: a stub that waits must not keep the process alive after the run.
 */
async function runProbes({ host, harnesses, adapterFor, refresh, budgetMs }) {
  const answers = {};
  if (!harnesses.length) return answers;
  const started = harnesses.map((harness) => Promise.resolve()
    .then(() => adapterFor(harness).probe({ host, timeoutMs: budgetMs, refresh }))
    .then((answer) => { answers[harness] = verdictOf(answer); })
    .catch((e) => { answers[harness] = failedVerdict(`threw ${e?.constructor?.name ?? typeof e}`); }));

  let timer = null;
  const budget = new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); });
  try {
    await Promise.race([Promise.all(started), budget]);
  } finally {
    clearTimeout(timer);
  }
  for (const harness of harnesses) {
    if (!answers[harness]) answers[harness] = timedOutVerdict(budgetMs);
  }
  return answers;
}

/**
 * Whether the catalog rates a model, applied to the inventory an adapter reported.
 *
 * An adapter knows its harness, not the catalog, so `rated` is filled here. The
 * default says `false` for everything, which is the reading that cannot go wrong:
 * an unrated model is shown as a runtime row and is never chosen automatically.
 * The caller that has a merged catalog in hand (the resolver's command) passes the
 * real predicate.
 */
function withRated(harness, entry, rated) {
  if (!Array.isArray(entry.models)) return entry;
  return {
    ...entry,
    models: entry.models.map((m) => ({ ...m, rated: rated(harness, m.model) === true })),
  };
}

/**
 * The availability snapshot for these harnesses.
 *
 * `harnesses` is the list to ask about — `host.declaredTools()` at the call site,
 * narrowed by whatever the command constrains. `adapterFor` maps a harness name to
 * its adapter and is passed in rather than imported: this module must not know
 * which drivers exist ([lib/drivers.js](../drivers.js) is the one door to those).
 *
 * The result validates against `schemas/model-routing/snapshot.schema.json`, and
 * what was probed is written to the cache — unless `dryRun`, which writes nothing
 * in either mode.
 */
export async function preflight({
  host,
  harnesses,
  adapterFor,
  refresh = false,
  dryRun = false,
  budgetMs = PREFLIGHT_BUDGET_MS,
  rated = () => false,
}) {
  const names = [...new Set(harnesses)];
  const stored = readSnapshot(host);
  const held = heldOf(stored, { refresh });
  const wanted = names.filter((name) => !held[name]);
  // A dry run without --refresh is the one path that asks nothing: it reads the
  // cache and stops there.
  const probeNames = dryRun && !refresh ? [] : wanted;
  const answers = await runProbes({ host, harnesses: probeNames, adapterFor, refresh, budgetMs });

  const out = {};
  for (const name of names) {
    const raw = answers[name] ?? held[name] ?? staleVerdict(stored?.harnesses?.[name]);
    out[name] = snapshotEntry(withRated(name, raw, rated));
  }

  const probed = {};
  for (const name of Object.keys(answers)) probed[name] = out[name];
  // Only a run that ASKED something writes. `writeEntries` merges into the stored
  // document and re-stamps its `takenAt`, so calling it with nothing to merge
  // rewrote the file with the same entries under a fresh stamp — and a reader
  // that ages a snapshot from that stamp would report the age of the last run
  // instead of the age of the facts. A run with an empty answer set has learned
  // nothing and has nothing to say about when.
  if (Object.keys(probed).length) writeEntries(host, probed, { dryRun });

  return { schemaVersion: SNAPSHOT_VERSION, takenAt: isoStamp(), harnesses: out };
}

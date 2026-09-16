// Preflight: running the adapters together under one budget.
// [guides/model-routing.md#preflight-running-the-adapters-together-under-one-budget](../../docs/guides/model-routing.md#preflight-running-the-adapters-together-under-one-budget)

import { AVAILABILITY_REASONS, AVAILABILITY_SOURCES, AVAILABILITY_STATES } from '../../dist/index.js';
import { warn } from '../util.js';
import {
  LOCK_WAIT_MS, NEVER_CHECKED, SNAPSHOT_VERSION, cacheFileOf, heldOf, isTimestamp, isoStamp,
  readSnapshot, snapshotEntry, staleVersionAt, writeEntries,
} from './cache.js';
import { verdict } from './adapter-common.js';

/** Total budget for the whole preflight, fixed at 15 s by ADR-003. The parameter exists so
 * the suite can run this code against a budget it can afford to wait out. */
export const PREFLIGHT_BUDGET_MS = 15_000;

/** A verdict that is not one — an adapter that threw or answered outside the contract. The
 * thrown TEXT is not carried: the cache is the file that must not leak. */
function failedVerdict(kind) {
  return verdict('unknown', 'probe_failed', `the adapter did not answer the contract (${kind})`);
}

/** A harness the registry could not hand an adapter for: the same `unknown` / `probe_failed`
 * a driver with no adapter answers — from here the two are one fact, nothing was asked. */
function noAdapterVerdict(kind) {
  return verdict('unknown', 'probe_failed', `no adapter could be taken for this harness (${kind})`);
}

/** A harness that did not answer inside the budget. It is unknown, which the resolver penalises, not death. */
function timedOutVerdict(budgetMs) {
  return verdict('unknown', 'probe_timeout', `no answer within the ${budgetMs} ms preflight budget`);
}

/** A harness whose binary was never resolved, because the budget was gone. It names which
 * half spent the time: a slow adapter is a slow harness, a slow resolve is a slow HOST. */
function unresolvedVerdict(budgetMs) {
  return verdict('unknown', 'probe_timeout',
    `the ${budgetMs} ms preflight budget was spent resolving harness binaries — this one was never asked`);
}

/** A harness the cache cannot answer for. An expired entry keeps its own `checkedAt` and a
 * never-held one gets `NEVER_CHECKED`; nothing else of a stale entry is carried. */
function staleVerdict(stored, discardedVersion = null) {
  const message = stored
    ? 'the cache entry outlived its TTL and no probe ran'
    : (discardedVersion === null
      ? 'no cache entry for this harness and no probe ran'
      : `the cache was written by an older version (schemaVersion ${discardedVersion}) and was discarded; no probe ran`);
  return verdict('unknown', 'stale_cache', message, {
    checkedAt: stored?.checkedAt && isTimestamp(stored.checkedAt) ? stored.checkedAt : NEVER_CHECKED,
    source: 'cache',
  });
}

/** A value echoed back in a diagnosis, or `null` when it is not safe to echo: a typo in a
 * closed list is invisible unless printed, and this is where adapter text could reach it. */
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,40}$/;
const echoed = (value) => (CODE_SHAPE.test(String(value ?? '')) ? ` ${JSON.stringify(String(value))}` : '');

/** What is wrong with an adapter's answer, or `null`. All three closed lists are checked: a
 * misspelled reason would break the cache's validation promise from inside. */
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

/** The adapters, taken one by one and never all at once: `adapterFor` throws on a name no
 * driver answers for, and one bad config line would cost the whole preflight. */
function adaptersOf(harnesses, adapterFor) {
  const adapters = new Map();
  const broken = {};
  for (const harness of harnesses) {
    let adapter = null;
    try {
      adapter = adapterFor(harness);
    } catch (e) {
      broken[harness] = noAdapterVerdict(`threw ${e?.constructor?.name ?? typeof e}`);
      continue;
    }
    if (typeof adapter?.probe !== 'function') {
      broken[harness] = noAdapterVerdict('the registry answered nothing with a probe');
      continue;
    }
    adapters.set(harness, adapter);
  }
  return { adapters, broken };
}

// Resolve the binary of every harness about to be probed, BEFORE any adapter.
// [guides/model-routing.md#resolvebins--resolve-the-binary-of-every-harness-about-to-be-probed-before-any-adapter](../../docs/guides/model-routing.md#resolvebins--resolve-the-binary-of-every-harness-about-to-be-probed-before-any-adapter)
function resolveBins({ host, harnesses, adapters, deadline }) {
  const bins = {};
  const unresolved = [];
  const byTool = new Map();
  for (const harness of harnesses) {
    const tool = adapters.get(harness)?.tool ?? null;
    if (!tool) { bins[harness] = null; continue; }
    if (byTool.has(tool)) { bins[harness] = byTool.get(tool); continue; }
    if (Date.now() >= deadline) { unresolved.push(harness); continue; }
    let found = null;
    try {
      found = typeof host?.resolveToolBin === 'function' ? host.resolveToolBin(tool) : null;
    } catch {
      found = null;
    }
    byTool.set(tool, found);
    bins[harness] = found;
  }
  return { bins, unresolved };
}

/** Run the adapters together, with the budget beside them. Each is given what is LEFT of it,
 * not the whole figure: the binaries were resolved out of the same budget. */
async function runProbes({ host, harnesses, adapters, bins, refresh, budgetMs, deadline }) {
  const answers = {};
  if (!harnesses.length) return answers;
  const left = () => Math.max(0, deadline - Date.now());
  const started = harnesses.map((harness) => Promise.resolve()
    .then(() => adapters.get(harness).probe({
      host, toolBin: bins[harness] ?? null, timeoutMs: left(), refresh,
    }))
    .then((answer) => { answers[harness] = verdictOf(answer); })
    .catch((e) => { answers[harness] = failedVerdict(`threw ${e?.constructor?.name ?? typeof e}`); }));

  let timer = null;
  const budget = new Promise((resolve) => { timer = setTimeout(resolve, left()); });
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

/** Whether the catalog rates a model, applied to what an adapter reported. The default says
 * `false` for everything — the reading that cannot go wrong: unrated is never auto-chosen. */
function withRated(harness, entry, rated) {
  if (!Array.isArray(entry.models)) return entry;
  return {
    ...entry,
    models: entry.models.map((m) => ({ ...m, rated: rated(harness, m.model) === true })),
  };
}

/** The availability snapshot for these harnesses. `adapterFor` is passed in, not imported:
 * this module must not know which drivers exist ([lib/drivers.js](../drivers.js) is that door). */
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
  // Asked only when the cache came back empty, so an ordinary run reads the file once. An
  // unreadable version is a discard, which a person meets instead of "no cache entry".
  const discardedVersion = stored ? null : staleVersionAt(host);
  const held = heldOf(stored, { refresh });
  const wanted = names.filter((name) => !held[name]);
  // A dry run without --refresh is the one path that asks nothing: it reads the
  // cache and stops there.
  const probeNames = dryRun && !refresh ? [] : wanted;
  // The deadline covers both halves of the ask — resolving binaries and running adapters:
  // both are what a person waits through, and the resolve is the half nothing else bounds.
  const deadline = Date.now() + budgetMs;
  const { adapters, broken } = adaptersOf(probeNames, adapterFor);
  const askable = probeNames.filter((name) => adapters.has(name));
  const { bins, unresolved } = resolveBins({ host, harnesses: askable, adapters, deadline });
  const asked = askable.filter((name) => !unresolved.includes(name));
  const answers = await runProbes({
    host, harnesses: asked, adapters, bins, refresh, budgetMs, deadline,
  });
  for (const name of unresolved) answers[name] = unresolvedVerdict(budgetMs);
  Object.assign(answers, broken);

  const out = {};
  for (const name of names) {
    const raw = answers[name] ?? held[name] ?? staleVerdict(stored?.harnesses?.[name], discardedVersion);
    out[name] = snapshotEntry(withRated(name, raw, rated));
  }

  const probed = {};
  for (const name of Object.keys(answers)) probed[name] = out[name];
  // Only a run that ASKED something writes: `writeEntries` re-stamps `takenAt`, so an empty
  // merge would age the facts by the clock of a run that learned nothing.
  if (Object.keys(probed).length) {
    try {
      const { dropped = [], contended = false } = writeEntries(host, probed, { dryRun }) ?? {};
      if (dropped.length) {
        warn(`availability cache dropped invalid harness names: ${dropped.join(', ')} — ${cacheFileOf(host)}`);
      }
      // The lock is advisory with a deadline and the write happens either way, so this is the
      // only moment the fallthrough is visible. Why it is not a refusal: 05-drivers, the cache lock.
      if (contended) {
        warn(`availability cache was written WITHOUT the lock after ${LOCK_WAIT_MS} ms of contention — `
          + `a neighbour writing at the same moment may lose its entry: ${cacheFileOf(host)}`);
      }
    } catch (e) {
      // The probes already answered: the cache is an accelerator, not the fact;
      // a failed persistence is re-asked next command, while clearExhausted stays an explicit write refusal.
      warn(`availability cache was not written (${e.message}) — ${cacheFileOf(host)}`);
    }
  }

  return { schemaVersion: SNAPSHOT_VERSION, takenAt: isoStamp(), harnesses: out };
}

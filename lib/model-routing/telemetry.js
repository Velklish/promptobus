// Participant telemetry: the collecting half.
// [guides/model-routing.md#participant-telemetry-the-collecting-half](../../docs/guides/model-routing.md#participant-telemetry-the-collecting-half)

import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync,
  truncateSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  addrDir, addressOf, dismissedOf, isAddress, readHealth, routingOf,
  startedOf, taskDir, wardenLogFile,
} from '../../dist/index.js';
import {
  WINDOW_KINDS, WINDOW_TTL_MS, isTimestamp, isoStamp, readSnapshot, scopeOf,
} from './cache.js';
import { warn } from '../util.js';
import { isRoutedRole } from './catalog.js';

/** Record version, additive-only from here on: a reader that had to migrate history would be a
 * reason to throw history away, which a file collected from the first day must not do. */
export const TELEMETRY_VERSION = 1;

/** Permissions of the telemetry file. The cache's, for the cache's reason: it is the account's. */
export const TELEMETRY_MODE = 0o600;

/** File name, beside the cache the host names. The host owns the directory; this owns the leaf. */
export const TELEMETRY_FILE = 'telemetry.jsonl';

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function field(source, names) {
  for (const name of names) {
    if (Object.hasOwn(source, name)) return source[name];
  }
  return undefined;
}

/** A participant's throughput observation in the closed telemetry shape, or `null`. A partial
 * event is kept as partial evidence; missing evidence is `null`, never zero. */
export function throughputObservationOf(raw) {
  let source = raw;
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'throughput')) source = raw.throughput;
  else if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'throughputObservation')) {
    source = raw.throughputObservation;
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;

  const outputValue = field(source, ['outputTokens', 'output_tokens']);
  const outputNumber = numeric(outputValue);
  const outputTokens = outputNumber !== null && Number.isSafeInteger(outputNumber) && outputNumber >= 0
    ? outputNumber : null;

  const durationValue = field(source, [
    'generationDurationSec', 'generation_duration_sec',
  ]);
  const durationMsValue = field(source, [
    'generationDurationMs', 'generation_duration_ms',
  ]);
  const durationNumber = numeric(durationValue);
  const durationMs = numeric(durationMsValue);
  const generationDurationSec = durationNumber !== null && durationNumber > 0
    ? durationNumber
    : durationMs !== null && durationMs > 0 ? durationMs / 1000 : null;

  const rateNumber = numeric(field(source, [
    'tokensPerSecond', 'tokens_per_second',
  ]));
  const tokensPerSecond = rateNumber !== null && rateNumber > 0 ? rateNumber : null;

  if (outputTokens === null && generationDurationSec === null && tokensPerSecond === null) return null;
  return { outputTokens, generationDurationSec, tokensPerSecond };
}

/** A usable tokens/second observation, derived from the pair when necessary. */
export function throughputRate(raw) {
  const observation = throughputObservationOf(raw);
  if (!observation) return null;
  if (observation.tokensPerSecond !== null) return observation.tokensPerSecond;
  if (observation.outputTokens === null || observation.generationDurationSec === null) return null;
  const rate = observation.outputTokens / observation.generationDurationSec;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Permissions of the per-participant throughput evidence sidecar. */
export const THROUGHPUT_SIDECAR_MODE = 0o600;

/** File beside the guard mark where a turn appends its harness evidence. */
export function throughputSidecarFile(home, task, address) {
  return path.join(taskDir(home, task), 'waits', `${addrDir(address)}.throughput.jsonl`);
}

/** Append one normalised, per-turn observation without taking the task lock: this is one turn's
 * observation, not a completion duration. A refusal to write is left to the caller. */
export function appendThroughputObservation(home, task, address, raw) {
  const observation = throughputObservationOf(raw);
  if (!observation) return false;
  const file = throughputSidecarFile(home, task, address);
  mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !existsSync(file);
  appendFileSync(file, `${JSON.stringify(observation)}\n`, { mode: THROUGHPUT_SIDECAR_MODE });
  if (fresh) chmodSync(file, THROUGHPUT_SIDECAR_MODE);
  return true;
}

/** Clear a participant's old turn evidence when its journal record is replaced by a new lift. */
export function clearThroughputSidecar(home, task, address) {
  const file = throughputSidecarFile(home, task, address);
  try {
    truncateSync(file, 0);
    return true;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      warn(`${file}: could not clear throughput sidecar (${e.message}) — lift continues without telemetry reset`);
    }
    return false;
  }
}

/** Project one participant's sidecar into run totals and a direct-rate mean. A tokens-and-
 * duration pair wins where one observation carries both; otherwise a token-weighted mean. */
export function readThroughputSidecar(home, task, address) {
  const file = throughputSidecarFile(home, task, address);
  if (!existsSync(file)) return null;
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
  let outputTokens = 0;
  let outputSamples = 0;
  let pairTokens = 0;
  let pairDurationSec = 0;
  let pairSamples = 0;
  let weightedRate = 0;
  let rateWeight = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let observation;
    try {
      observation = throughputObservationOf(JSON.parse(line));
    } catch {
      observation = null;
    }
    if (!observation) continue;
    if (observation.outputTokens !== null) {
      outputTokens += observation.outputTokens;
      outputSamples += 1;
    }
    if (observation.outputTokens !== null && observation.generationDurationSec !== null) {
      pairTokens += observation.outputTokens;
      pairDurationSec += observation.generationDurationSec;
      pairSamples += 1;
    }
    if (observation.tokensPerSecond !== null) {
      const weight = observation.outputTokens > 0 ? observation.outputTokens : 1;
      weightedRate += observation.tokensPerSecond * weight;
      rateWeight += weight;
    }
  }
  if (!outputSamples && !pairSamples && !rateWeight) return null;
  const pairRate = pairSamples && pairDurationSec > 0
    ? pairTokens / pairDurationSec : null;
  return {
    outputTokens: outputSamples ? outputTokens : null,
    generationDurationSec: pairSamples ? pairDurationSec : null,
    tokensPerSecond: pairRate !== null && Number.isFinite(pairRate) && pairRate > 0
      ? null
      : rateWeight ? weightedRate / rateWeight : null,
  };
}

/** Read each participant sidecar once while projecting a task at `done`. */
export function readThroughputSidecars(home, meta) {
  const out = new Map();
  for (const participant of meta?.participants ?? []) {
    const address = addressOf(participant);
    if (!address || !isAddress(address)) continue;
    const observation = readThroughputSidecar(home, meta.id, address);
    if (observation) out.set(address, observation);
  }
  return out;
}

function timeMs(value) {
  const at = typeof value === 'number' ? value : Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(at) ? at : null;
}

function elapsedSec(from, to) {
  const start = timeMs(from);
  const end = timeMs(to);
  if (start === null || end === null || end < start) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

function addTimingSample(state, fieldName, samplesName, from, to) {
  const seconds = elapsedSec(from, to);
  if (seconds === null) return;
  state[fieldName] += seconds;
  state[samplesName] += 1;
}

function canonicalMessageTimes(home, id, participantId, address) {
  const dir = path.join(taskDir(home, id), 'messages');
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const times = [];
  for (const name of names) {
    let message;
    try {
      message = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(message?.recipients)
      || !message.recipients.some((to) => to === participantId || to === address)) continue;
    const at = timeMs(message.ts);
    if (at !== null) times.push(at);
  }
  return times.sort((a, b) => a - b);
}

function wardenDeliveryEvents(home, id, address) {
  let lines;
  try {
    lines = readFileSync(wardenLogFile(home, id), 'utf8').split('\n');
  } catch {
    return [];
  }
  const markers = [
    [` notification ${address}:`, 'notification'],
    [` delivered ${address}:`, 'delivered'],
  ];
  const events = [];
  for (const line of lines) {
    const at = timeMs(line.slice(0, 24));
    if (at === null) continue;
    const marker = markers.find(([needle]) => line.includes(needle));
    if (marker) events.push({ at, kind: marker[1] });
  }
  return events.sort((a, b) => a.at - b.at);
}

function timingFor(home, id, address, participantId, at) {
  const state = {
    idleSec: 0, idleSamples: 0, deliveryLatencySec: 0, deliverySamples: 0,
  };
  const closeAt = timeMs(at) ?? Infinity;
  const messages = canonicalMessageTimes(home, id, participantId, address)
    .filter((messageAt) => messageAt <= closeAt);
  const events = wardenDeliveryEvents(home, id, address)
    .filter((event) => event.at <= closeAt);
  const mark = readHealth(home, id)?.[address] ?? {};
  const beforeClose = (value) => {
    const stamp = timeMs(value);
    return stamp !== null && stamp <= closeAt ? stamp : null;
  };
  const healthKnockedAt = beforeClose(mark.knockedAt);
  const healthDeliveredAt = beforeClose(mark.deliveredAt);
  const healthSince = beforeClose(mark.since);
  let knockAt = null;
  let deliveredAt = null;
  let messageIndex = 0;

  for (const event of events) {
    if (event.kind === 'notification') {
      if (knockAt === null) knockAt = event.at;
      continue;
    }
    if (event.kind !== 'delivered') continue;
    if (knockAt === null && healthKnockedAt !== null && healthKnockedAt <= event.at) {
      knockAt = healthKnockedAt;
    }
    addTimingSample(state, 'idleSec', 'idleSamples', knockAt, event.at);
    while (messageIndex < messages.length && messages[messageIndex] <= event.at) {
      addTimingSample(state, 'deliveryLatencySec', 'deliverySamples', messages[messageIndex], event.at);
      messageIndex += 1;
    }
    deliveredAt = event.at;
    knockAt = null;
  }

  if (healthDeliveredAt !== null && (deliveredAt === null || healthDeliveredAt > deliveredAt)) {
    if (knockAt !== null) {
      addTimingSample(state, 'idleSec', 'idleSamples', knockAt, healthDeliveredAt);
      knockAt = null;
    }
    while (messageIndex < messages.length && messages[messageIndex] <= healthDeliveredAt) {
      addTimingSample(
        state, 'deliveryLatencySec', 'deliverySamples', messages[messageIndex], healthDeliveredAt,
      );
      messageIndex += 1;
    }
    deliveredAt = healthDeliveredAt;
  }

  const unread = Number(mark.unread) > 0;
  if (unread && knockAt === null) {
    knockAt = healthKnockedAt ?? healthSince;
  }
  if (unread && knockAt !== null) {
    addTimingSample(state, 'idleSec', 'idleSamples', knockAt, at);
  }

  return {
    idleSec: state.idleSamples ? state.idleSec : null,
    idleSamples: state.idleSamples,
    deliveryLatencySec: state.deliverySamples ? state.deliveryLatencySec : null,
    deliverySamples: state.deliverySamples,
  };
}

/** The telemetry file this host names, assembled from `routingPaths().cacheFile`: the two are
 * the same account's, and a split would leave one account's telemetry beside another's. */
export function telemetryFileOf(host) {
  return path.join(path.dirname(host.routingPaths().cacheFile), TELEMETRY_FILE);
}

/** The opaque local key of a task: SHA-256 truncated to sixteen hex characters, unsalted so
 * grouping holds across installs. What it buys is that the slug a person typed is not in the file. */
export function taskHash(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}

/** One window of the record, or `null`. The projection drops rather than repairs, exactly as
 * the cache's does: a number invented here would read as a measurement. */
function windowOf(raw, endOf) {
  const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
  const at = typeof raw?.usedPercent === 'number' ? raw.usedPercent : NaN;
  if (!id || !WINDOW_KINDS.includes(raw?.kind)) return null;
  if (!Number.isFinite(at) || at < 0 || at > 100) return null;
  const scope = scopeOf(raw.scope);
  if (scope === undefined) return null;
  return {
    id, kind: raw.kind, scope, usedPercentAtSpawn: at, usedPercentAtEnd: endOf(id),
  };
}

/** Whether an entry was checked recently enough to answer about its windows. */
function telemetryEntryFresh(entry, at) {
  const checked = Date.parse(entry?.checkedAt);
  return Number.isFinite(checked) && checked + WINDOW_TTL_MS > at;
}

/** Read one harness entry from the provided snapshot or its cache. */
function snapshotEntryOf(host, harness, snapshot) {
  return (snapshot ?? readSnapshot(host))?.harnesses?.[harness];
}

/** The end-of-run reading of a harness's windows, by id, and only within the window TTL.
 * Deliberately not `entryLive`: a held exhaustion is not a fresh percentage for a delta. */
function endReader(host, harness, at, snapshot = null) {
  const entry = snapshotEntryOf(host, harness, snapshot);
  if (!telemetryEntryFresh(entry, at)) return () => null;
  const byId = new Map();
  for (const w of Array.isArray(entry.windows) ? entry.windows : []) {
    if (typeof w?.id === 'string' && typeof w.usedPercent === 'number') byId.set(w.id, w.usedPercent);
  }
  return (id) => (byId.has(id) ? byId.get(id) : null);
}

/** Which spawn-window readings are missing, and whether the reason is harness-wide: a fresh
 * entry reports each id, an absent, stale or held one cannot distinguish its windows. */
export function endReadingStatus(host, harness, windowIds, at, snapshot = null) {
  const entry = snapshotEntryOf(host, harness, snapshot);
  const ids = [...new Set(windowIds)];
  if (!telemetryEntryFresh(entry, at)) {
    return {
      missing: ids,
      reason: entry ? (entry.reason ?? 'stale_cache') : 'probe_failed',
      harness: true,
    };
  }
  const readings = new Set((Array.isArray(entry.windows) ? entry.windows : [])
    .filter((window) => typeof window?.id === 'string' && typeof window.usedPercent === 'number')
    .map((window) => window.id));
  const missing = ids.filter((id) => !readings.has(id));
  if (!missing.length) return { missing: [], reason: null, harness: false };
  const held = entry.source === 'cache' && entry.state === 'exhausted' && !entry.resetAt;
  if (held || (!readings.size && entry.reason !== null && entry.reason !== undefined)) {
    return { missing, reason: entry.reason, harness: true };
  }
  return { missing, reason: 'no_window_reading', harness: false };
}

/** Message counts per participant, from the CANONICAL messages and not `history/`, which holds
 * only what a mailbox fetched. Only the envelope is read — `body` never leaves this function. */
export function tallies(home, id) {
  const out = new Map();
  const of = (who) => {
    if (!out.has(who)) {
      out.set(who, {
        turns: 0, reviewRounds: 0, questions: 0, resultCount: 0, lastResultAt: null,
      });
    }
    return out.get(who);
  };
  let names;
  try {
    names = readdirSync(path.join(taskDir(home, id), 'messages'));
  } catch {
    // No messages directory is a task nobody wrote on — zero counts, not a refusal.
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let msg;
    try {
      msg = JSON.parse(readFileSync(path.join(taskDir(home, id), 'messages', name), 'utf8'));
    } catch {
      // An unreadable record costs its own count and nothing else: the run it
      // belongs to is over, and there is nobody left to fix it for.
      continue;
    }
    const type = typeof msg?.type === 'string' ? msg.type : null;
    if (typeof msg?.sender === 'string') {
      const sent = of(msg.sender);
      sent.turns += 1;
      if (type === 'question') sent.questions += 1;
      if (type === 'result') {
        sent.resultCount += 1;
        if (isTimestamp(msg.ts)
          && (sent.lastResultAt === null || Date.parse(msg.ts) >= Date.parse(sent.lastResultAt))) {
          sent.lastResultAt = isoStamp(msg.ts);
        }
      }
    }
    if (type === 'review') {
      for (const to of Array.isArray(msg.recipients) ? msg.recipients : []) {
        if (typeof to === 'string') of(to).reviewRounds += 1;
      }
    }
  }
  return out;
}

/** Whether this participant ever lifted a session — the one predicate deciding both who gets a
 * row and who counts as a neighbour. A record with no model never lifted one. */
function lifted(p) {
  if (!isRoutedRole(p?.role)) return false;
  return typeof p.metadata?.model === 'string' && Boolean(p.metadata.model.trim());
}

function windowIdsOf(p) {
  const windows = routingOf(p)?.windows;
  return (Array.isArray(windows) ? windows : [])
    .map((window) => windowOf(window, () => null))
    .filter(Boolean)
    .map((window) => window.id);
}

/** Recorded harnesses whose rows carry windows and can therefore have an end reading. */
export function telemetryWindowHarnesses(meta) {
  return [...new Set((meta?.participants ?? [])
    .filter((p) => addressOf(p) && lifted(p))
    .filter((p) => windowIdsOf(p).length)
    .map((p) => p.harness)
    .filter((harness) => typeof harness === 'string' && harness))];
}

/** Spawn-window ids recorded for one harness, in their first-seen order. */
export function telemetryWindowIds(meta, harness) {
  return [...new Set((meta?.participants ?? [])
    .filter((p) => addressOf(p) && lifted(p) && p.harness === harness)
    .flatMap((p) => windowIdsOf(p)))];
}

/** The moment a participant's own run ended: its last result, its dismissal, or the task close.
 * The dismissal is read through the accessor — a field named in four files is renamed in three. */
function endOf(p, closedAt, lastResultAt) {
  if (isTimestamp(lastResultAt)) return isoStamp(lastResultAt);
  const dismissed = dismissedOf(p);
  return isTimestamp(dismissed) ? isoStamp(dismissed) : closedAt;
}

/** How many other participants were live on the same harness at this one's spawn. It is why a
 * window delta belongs to the RUN: dividing it is the reader's decision, not this file's. */
function concurrentAt(participants, self, spawnedAt) {
  if (!spawnedAt) return null;
  const at = Date.parse(spawnedAt);
  let n = 0;
  for (const p of participants) {
    if (p === self) continue;
    // The same filter the rows use: a record with no model never lifted a session, so counting
    // it would inflate the very number a reader divides a window delta by.
    if (!lifted(p)) continue;
    if (p.harness !== self.harness) continue;
    const started = Date.parse(startedOf(p) ?? '');
    if (!Number.isFinite(started) || started > at) continue;
    const dismissed = Date.parse(dismissedOf(p) ?? '');
    if (Number.isFinite(dismissed) && dismissed <= at) continue;
    n += 1;
  }
  return n;
}

/** The records this task's participants leave behind, in journal order; an unrouted `--model`
 * pick gets one too. Every field is copied BY NAME — a spread would carry `metadata` out. */
export function telemetryRecords(host, home, meta, {
  at = Date.now(), snapshot = null, throughput = null,
} = {}) {
  const participants = (meta?.participants ?? []).filter((p) => addressOf(p));
  const recordedAt = isoStamp(at);
  const task = taskHash(meta.id);
  const counts = tallies(home, meta.id);
  const ends = new Map();
  const rows = [];
  for (const p of participants) {
    if (!lifted(p)) continue;
    const model = p.metadata.model.trim();
    const routing = routingOf(p) ?? {};
    const spawnedAt = isTimestamp(startedOf(p)) ? isoStamp(startedOf(p)) : null;
    const tally = counts.get(p.id) ?? {
      turns: 0, reviewRounds: 0, questions: 0, resultCount: 0, lastResultAt: null,
    };
    const ended = endOf(p, recordedAt, tally.lastResultAt);
    const seconds = spawnedAt ? Math.round((Date.parse(ended) - Date.parse(spawnedAt)) / 1000) : null;
    const observation = throughput?.get(addressOf(p)) ?? null;
    const timing = timingFor(home, meta.id, addressOf(p), p.id, at);
    if (!ends.has(p.harness)) ends.set(p.harness, endReader(host, p.harness, at, snapshot));
    const readEnd = ends.get(p.harness);
    rows.push({
      schemaVersion: TELEMETRY_VERSION,
      recordedAt,
      task,
      role: p.role,
      harness: p.harness,
      model,
      effort: typeof p.metadata?.effort === 'string' && p.metadata.effort ? p.metadata.effort : null,
      tuple: typeof routing.tupleId === 'string' && routing.tupleId ? routing.tupleId : null,
      strategy: typeof routing.strategy === 'string' && routing.strategy ? routing.strategy : null,
      // PB-32's field, read defensively: a build that does not write it yet
      // leaves `null`, and a record of it is still a record of the strategy.
      strategySource: typeof routing.strategySource === 'string' && routing.strategySource
        ? routing.strategySource
        : null,
      spawnedAt,
      lastResultAt: tally.lastResultAt,
      endedAt: ended,
      durationSec: seconds === null ? null : Math.max(0, seconds),
      throughput: observation,
      idleSec: timing.idleSec,
      idleSamples: timing.idleSamples,
      deliveryLatencySec: timing.deliveryLatencySec,
      deliverySamples: timing.deliverySamples,
      turns: tally.turns,
      reviewRounds: tally.reviewRounds,
      questions: tally.questions,
      resultCount: tally.resultCount,
      windows: (Array.isArray(routing.windows) ? routing.windows : [])
        .map((w) => windowOf(w, readEnd))
        .filter(Boolean),
      concurrentParticipants: concurrentAt(participants, p, spawnedAt),
      dismissedBeforeDone: Boolean(dismissedOf(p)),
    });
  }
  return rows;
}

/** Append this task's records and say how many landed. One write for the whole task, or a `done`
 * interrupted between participants leaves half a run. `mode` is re-set after umask cuts it. */
export function appendTelemetry(host, home, meta, {
  at = Date.now(), snapshot = null, throughput = null,
} = {}) {
  const file = telemetryFileOf(host);
  const rows = telemetryRecords(host, home, meta, { at, snapshot, throughput });
  if (!rows.length) return { file, written: 0 };
  mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !existsSync(file);
  appendFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: TELEMETRY_MODE });
  if (fresh) chmodSync(file, TELEMETRY_MODE);
  return { file, written: rows.length };
}

function nonEmptyStringList(value) {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim())
    && new Set(value).size === value.length;
}

function canonicalQuotaScope(scope) {
  if (scope === null) return null;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return undefined;
  const keys = Object.keys(scope);
  if (typeof scope.model === 'string' && scope.model.trim()) {
    if (!keys.every((key) => key === 'model' || key === 'models')
      || (Object.hasOwn(scope, 'models') && !nonEmptyStringList(scope.models))) return undefined;
    return Object.hasOwn(scope, 'models')
      ? { model: scope.model, models: [...scope.models].sort() }
      : { model: scope.model };
  }
  if (scope.pool === 'auto') {
    if (!keys.every((key) => key === 'pool' || key === 'models')
      || !nonEmptyStringList(scope.models)) return undefined;
    return { pool: 'auto', models: [...scope.models].sort() };
  }
  return scope.pool === 'api' && keys.every((key) => key === 'pool')
    ? { pool: 'api' } : undefined;
}

const QUOTA_WINDOW_KEYS = [
  'id', 'kind', 'scope', 'usedPercentAtSpawn', 'usedPercentAtEnd',
];

function trustedQuotaWindowOf(record, window) {
  const harness = typeof record?.harness === 'string' ? record.harness : '';
  if (!harness || !window || typeof window !== 'object') return null;
  if (Array.isArray(window)) return null;
  const candidate = window;
  const keys = Reflect.ownKeys(candidate);
  if (keys.length !== QUOTA_WINDOW_KEYS.length
    || !keys.every((key) => typeof key === 'string' && QUOTA_WINDOW_KEYS.includes(key))) return null;
  const id = typeof candidate.id === 'string' ? candidate.id : '';
  const kind = candidate.kind;
  const scope = canonicalQuotaScope(candidate.scope);
  const usedPercentAtSpawn = candidate.usedPercentAtSpawn;
  const usedPercentAtEnd = candidate.usedPercentAtEnd;
  if (!id || !['session', 'weekly', 'monthly'].includes(kind)
    || scope === undefined || typeof usedPercentAtSpawn !== 'number'
    || !Number.isFinite(usedPercentAtSpawn) || usedPercentAtSpawn < 0
    || usedPercentAtSpawn > 100
    || (usedPercentAtEnd !== null
      && (typeof usedPercentAtEnd !== 'number' || !Number.isFinite(usedPercentAtEnd)
        || usedPercentAtEnd < 0 || usedPercentAtEnd > 100))) return null;
  const deltaPercent = typeof usedPercentAtEnd === 'number'
    && usedPercentAtEnd >= usedPercentAtSpawn
    ? usedPercentAtEnd - usedPercentAtSpawn : null;
  return {
    key: JSON.stringify([harness, id, kind, scope]),
    harness,
    id,
    kind,
    scope,
    deltaPercent,
  };
}

function quotaEvidenceOf(records) {
  const groups = new Map();
  const recordsByHarness = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const harness = typeof record?.harness === 'string' ? record.harness : '';
    if (!harness) continue;
    if (!recordsByHarness.has(harness)) recordsByHarness.set(harness, []);
    recordsByHarness.get(harness).push(record);
    for (const window of Array.isArray(record?.windows) ? record.windows : []) {
      const trusted = trustedQuotaWindowOf(record, window);
      if (!trusted || groups.has(trusted.key)) continue;
      groups.set(trusted.key, {
        harness: trusted.harness,
        windowId: trusted.id,
        windowKind: trusted.kind,
        scope: trusted.scope,
        coverage: new Map(),
      });
    }
  }
  for (const [key, group] of groups) {
    for (const record of recordsByHarness.get(group.harness) ?? []) {
      const role = typeof record.role === 'string' && record.role ? record.role : 'unknown';
      if (!group.coverage.has(role)) {
        group.coverage.set(role, { records: 0, measured: 0, unavailable: 0, deltas: [] });
      }
      const entry = group.coverage.get(role);
      entry.records += 1;
      const windows = Array.isArray(record?.windows) ? record.windows : [];
      const matches = windows.map((window) => trustedQuotaWindowOf(record, window))
        .filter((window) => window?.key === key);
      const delta = matches.length === 1 ? matches[0].deltaPercent : null;
      if (delta === null) entry.unavailable += 1;
      else {
        entry.measured += 1;
        entry.deltas.push(delta);
      }
    }
  }
  return [...groups.values()].map((group) => {
    const coverage = [...group.coverage.entries()].map(([role, value]) => ({
      role,
      records: value.records,
      measuredRecords: value.measured,
      unavailableRecords: value.unavailable,
    })).sort((a, b) => a.role.localeCompare(b.role));
    const deltas = [...group.coverage.values()].flatMap((value) => value.deltas);
    const sameDelta = deltas.length > 0 && deltas.every((delta) => delta === deltas[0]);
    const recordsCount = coverage.reduce((total, value) => total + value.records, 0);
    const measuredRecords = coverage.reduce((total, value) => total + value.measuredRecords, 0);
    const state = !deltas.length ? 'unavailable'
      : recordsCount > 1 || measuredRecords < recordsCount || !sameDelta ? 'ambiguous' : 'measured';
    return {
      harness: group.harness,
      windowId: group.windowId,
      windowKind: group.windowKind,
      scope: group.scope,
      deltaPercent: sameDelta ? deltas[0] : null,
      state,
      coverage,
    };
  }).sort((a, b) => a.harness.localeCompare(b.harness)
    || a.windowId.localeCompare(b.windowId)
    || a.windowKind.localeCompare(b.windowKind));
}

function summaryNumber(target, fieldName, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  target[fieldName] += value;
  target[fieldName + 'Samples'] += 1;
}

function summaryRole() {
  return {
    records: 0,
    wallClockSec: 0,
    wallClockSecSamples: 0,
    sourceRecords: [],
    idleSec: 0,
    idleSecSamples: 0,
    deliveryLatencySec: 0,
    deliveryLatencySecSamples: 0,
    busMessages: 0,
    busMessagesSamples: 0,
    reviewRounds: 0,
    reviewRoundsSamples: 0,
    questions: 0,
    questionsSamples: 0,
    resultCount: 0,
    resultCountSamples: 0,
  };
}

function summaryValue(target, fieldName) {
  const samples = target[fieldName + 'Samples'];
  return samples === target.records ? target[fieldName] : null;
}

/** Group persisted telemetry by run and participant role; missing values stay null. */
export function telemetrySummary(records = []) {
  const runs = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (typeof record?.task !== 'string' || !record.task
      || typeof record.role !== 'string' || !record.role) continue;
    if (!runs.has(record.task)) runs.set(record.task, new Map());
    const roles = runs.get(record.task);
    if (!roles.has(record.role)) roles.set(record.role, summaryRole());
    const role = roles.get(record.role);
    role.sourceRecords.push(record);
    role.records += 1;
    summaryNumber(role, 'wallClockSec', record.durationSec);
    summaryNumber(role, 'idleSec', record.idleSec);
    summaryNumber(role, 'deliveryLatencySec', record.deliveryLatencySec);
    summaryNumber(role, 'busMessages', record.turns);
    summaryNumber(role, 'reviewRounds', record.reviewRounds);
    summaryNumber(role, 'questions', record.questions);
    summaryNumber(role, 'resultCount', record.resultCount);
  }
  return [...runs.entries()].map(([task, roleMap]) => {
    const quotaRecords = [...roleMap.values()].flatMap((value) => value.sourceRecords);
    const quotaEvidence = quotaEvidenceOf(quotaRecords);
    const measuredQuotaRoles = new Set(quotaEvidence.flatMap((evidence) => evidence.coverage
      .filter((value) => value.measuredRecords > 0)
      .map((value) => value.role)));
    const roles = {};
    for (const [name, value] of roleMap.entries()) {
      roles[name] = {
        records: value.records,
        wallClockSec: summaryValue(value, 'wallClockSec'),
        quotaCostPercent: null,
        quotaCostState: measuredQuotaRoles.has(name) ? 'ambiguous' : 'unavailable',
        idleSec: summaryValue(value, 'idleSec'),
        deliveryLatencySec: summaryValue(value, 'deliveryLatencySec'),
        busMessages: summaryValue(value, 'busMessages'),
        reviewRounds: summaryValue(value, 'reviewRounds'),
        questions: summaryValue(value, 'questions'),
        resultCount: summaryValue(value, 'resultCount'),
      };
    }
    const completeWallClock = Object.values(roles).length > 0
      && Object.values(roles).every((value) => value.wallClockSec !== null);
    const ranked = completeWallClock ? Object.entries(roles)
      .sort((a, b) => b[1].wallClockSec - a[1].wallClockSec
        || a[0].localeCompare(b[0])) : [];
    return {
      task,
      roles,
      quotaEvidence,
      bottleneckRole: ranked.length ? ranked[0][0] : null,
    };
  });
}

/** How many records the file holds and how large it is; `null` for no file, `unreadable` for one
 * that cannot be read — which must not read as "no records yet". */
function telemetryStatsOf(host, includeSummary) {
  const file = telemetryFileOf(host);
  if (!existsSync(file)) return null;
  try {
    const records = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
    const rows = includeSummary ? readTelemetry(host).records : null;
    return { file, records, bytes: statSync(file).size, unreadable: false,
      ...(includeSummary ? { summary: telemetrySummary(rows) } : {}) };
  } catch (e) {
    return { file, records: null, bytes: null, unreadable: true, note: e.message };
  }
}

/** Every record the file holds, in append order. A line that does not parse is SKIPPED, not
 * raised on: a truncated last line must not throw away a person's whole history. */
export function readTelemetry(host) {
  const file = telemetryFileOf(host);
  if (!existsSync(file)) return { file, records: [], skipped: 0 };
  const records = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) records.push(row);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { file, records, skipped };
}

/** The one line `models` prints: count and size only; role summary is in `telemetryStats`. */
export function telemetryLine(host) {
  const stats = telemetryStatsOf(host, false);
  if (!stats) return `telemetry: no records yet (${telemetryFileOf(host)})`;
  if (stats.unreadable) {
    return `telemetry: the file is there and could not be read (${stats.note}) — ${stats.file}`;
  }
  return `telemetry: ${stats.records} record(s), ${stats.bytes} B (${stats.file})`;
}

export function telemetryStats(host) {
  return telemetryStatsOf(host, true);
}

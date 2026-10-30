// Participant telemetry: the collecting half.
// [guides/model-routing.md#participant-telemetry-the-collecting-half](../../docs/guides/model-routing.md#participant-telemetry-the-collecting-half)

import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync,
  truncateSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  addrDir, addressOf, dismissedOf, isAddress, readHealth, readTranscript, registryOf, roleEntry, routingOf,
  startedOf, taskDir, telemetrySummary, wardenLogFile,
} from '../../dist/index.js';
import {
  WINDOW_KINDS, WINDOW_TTL_MS, isTimestamp, isoStamp, readSnapshot, scopeOf,
} from './cache.js';
import { warn } from '../util.js';
import { isRoutedRole } from './catalog.js';
import { sessionKey } from '../harness-registry.js';
import { participantOf, readTask, sameStoreHome } from '../store.js';

import type { MessageV1, ParticipantV1, PromptobusHost, RoleRegistry, TaskV1, TelemetryRecord, TelemetryWindow } from '../../dist/index.js';
import type { AvailabilityWindow, SnapshotDocument, SnapshotEntry } from './cache.js';

type UnknownRecord = Record<string, unknown>;
interface ThroughputObservation { outputTokens: number | null; generationDurationSec: number | null; tokensPerSecond: number | null }
type TokenUsage = NonNullable<TelemetryRecord['tokens']>;
type TokenTotals = Omit<TokenUsage, 'reason'>;
interface TokenLogIdentity { sessionId?: unknown; path?: unknown }
interface TokenBounds { from: number | null; until: number | null }
interface Tally { turns: number; reviewRounds: number; questions: number; resultCount: number; lastResultAt: string | null }
interface TimingState { idleSec: number; idleSamples: number; deliveryLatencySec: number; deliverySamples: number }
interface RoutingReading { step?: string; role?: string; windows?: unknown[]; tupleId?: unknown; strategy?: unknown; strategySource?: unknown }
interface GenerationInput {
  harness?: string; model?: unknown; effort?: unknown; from?: unknown; until?: string;
  tupleId?: unknown; strategy?: unknown; strategySource?: unknown; sessionId?: unknown;
  tokenLog?: TokenLogIdentity; tokenLogHistory?: TokenLogIdentity[];
}
interface SessionLogRow {
  type?: unknown; sessionId?: unknown; timestamp?: unknown;
  message?: { role?: unknown; id?: unknown; usage?: UnknownRecord };
  payload?: { id?: unknown; type?: unknown; info?: { total_token_usage?: UnknownRecord } };
}
interface TelemetryOptions { at?: number; snapshot?: SnapshotDocument | null; throughput?: Map<string, ThroughputObservation> | null }
interface CollectedRecord extends TelemetryRecord {
  schemaVersion: number; recordedAt: string; step: string; effort: string | null; tuple: string | null;
  strategy: string | null; strategySource: string | null; spawnedAt: string | null;
  lastResultAt: string | null; endedAt: string; throughput: ThroughputObservation | null;
  idleSamples: number; deliverySamples: number; windows: TelemetryWindow[];
  concurrentParticipants: number | null; dismissedBeforeDone: boolean;
}

// The role-summary algorithm has one home, `src/telemetry.ts`; re-exported for the same
// reason `lib/warden.js` re-exports its threshold instead of holding a second copy.
export { telemetrySummary } from '../../dist/index.js';

/** Record version, additive-only from here on: a reader that had to migrate history would be a
 * reason to throw history away, which a file collected from the first day must not do. */
export const TELEMETRY_VERSION = 1;

/** Permissions of the telemetry file. The cache's, for the cache's reason: it is the account's. */
export const TELEMETRY_MODE = 0o600;

/** File name, beside the cache the host names. The host owns the directory; this owns the leaf. */
export const TELEMETRY_FILE = 'telemetry.jsonl';

function numeric(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function field(source: object, names: readonly string[]) {
  for (const name of names) {
    if (Object.hasOwn(source, name)) return (source as UnknownRecord)[name];
  }
  return undefined;
}

/** A participant's throughput observation in the closed telemetry shape, or `null`. A partial
 * event is kept as partial evidence; missing evidence is `null`, never zero. */
export function throughputObservationOf(raw: unknown): ThroughputObservation | null {
  let source = raw;
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'throughput')) source = (raw as UnknownRecord).throughput;
  else if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'throughputObservation')) {
    source = (raw as UnknownRecord).throughputObservation;
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
export function throughputRate(raw: unknown) {
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
export function throughputSidecarFile(home: string, task: string, address: string) {
  return path.join(taskDir(home, task), 'waits', `${addrDir(address)}.throughput.jsonl`);
}

/** Append one normalised, per-turn observation without taking the task lock: this is one turn's
 * observation, not a completion duration. A refusal to write is left to the caller. */
export function appendThroughputObservation(home: string, task: string, address: string, raw: unknown) {
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
export function clearThroughputSidecar(home: string, task: string, address: string) {
  const file = throughputSidecarFile(home, task, address);
  try {
    truncateSync(file, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`${file}: could not clear throughput sidecar (${(e as Error).message}) — lift continues without telemetry reset`);
    }
    return false;
  }
}

/** Project one participant's sidecar into run totals and a direct-rate mean. A tokens-and-
 * duration pair wins where one observation carries both; otherwise a token-weighted mean. */
export function readThroughputSidecar(home: string, task: string, address: string) {
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
      const weight = observation.outputTokens! > 0 ? observation.outputTokens! : 1;
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
export function readThroughputSidecars(home: string, meta: TaskV1) {
  const out = new Map<string, ThroughputObservation>();
  for (const participant of meta?.participants ?? []) {
    const address = addressOf(participant)!;
    if (!address || !isAddress(address)) continue;
    const observation = readThroughputSidecar(home, meta.id, address);
    if (observation) out.set(address, observation);
  }
  return out;
}

function timeMs(value: unknown) {
  const at = typeof value === 'number' ? value : Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(at) ? at : null;
}

function elapsedSec(from: unknown, to: unknown) {
  const start = timeMs(from);
  const end = timeMs(to);
  if (start === null || end === null || end < start) return null;
  return Math.max(0, Math.round((end - start) / 1000));
}

// Session paths stay in the private journal; only counts and reason codes reach telemetry.
export function sessionLogOf(host: PromptobusHost, home: string, task: string, participant: ParticipantV1) {
  const metadata = participant?.metadata ?? {};
  const sessionId = ownText(metadata.sessionId) ?? (participant.role === 'orchestrator' ? ownText(metadata.owner) : null);
  if (!sessionId) return null;
  const address = addressOf(participant)!;
  const transcript = readTranscript(home, task, address);
  if (transcript?.session === sessionId && path.isAbsolute(transcript.path)) {
    return { sessionId, path: transcript.path };
  }
  if (participant.harness !== 'codex' || !participant.sessionRef) return null;
  try {
    const stateHome = host.harnessStateHome('codex');
    if (!stateHome) return null;
    const file = path.join(stateHome, 'sessions', `${sessionKey(participant.sessionRef)}.json`);
    const record: { ref?: unknown; threadId?: unknown; home?: unknown; rolloutPath?: unknown; task?: unknown; address?: unknown } = JSON.parse(readFileSync(file, 'utf8'));
    if (record.ref !== participant.sessionRef || record.threadId !== sessionId
      || !sameStoreHome(record.home, home)
      || typeof record.rolloutPath !== 'string' || !path.isAbsolute(record.rolloutPath)) return null;
    if (record.task !== task || record.address !== address) {
      if (participant.role !== 'teamlead' || !ownText(metadata.childTask)) return null;
      const rootLead = participantOf(readTask(home, task), address);
      const child = readTask(home, metadata.childTask as string);
      const owner = participantOf(child, 'orchestrator');
      if (rootLead?.id !== participant.id || rootLead!.harness !== participant.harness
        || rootLead!.sessionRef !== participant.sessionRef || rootLead!.metadata.sessionId !== sessionId
        || rootLead!.metadata.childTask !== child.id || child.parent !== task
        || owner?.harness !== participant.harness || owner!.sessionRef !== participant.sessionRef
        || owner!.metadata.owner !== sessionId || owner!.metadata.sessionId !== sessionId
        || record.task !== child.id || record.address !== 'orchestrator') return null;
    }
    return { sessionId, path: record.rolloutPath };
  } catch {
    return null;
  }
}

function uniqueTokenLogs(identities: readonly (TokenLogIdentity | null | undefined)[]) {
  const bySession = new Map<string | null, { sessionId: string | null; path: string | null }>();
  for (const raw of identities) {
    const sessionId = ownText(raw?.sessionId);
    const file = typeof raw?.path === 'string' && path.isAbsolute(raw.path) ? raw.path : null;
    const identity = { sessionId, path: file };
    if (!bySession.has(sessionId) || file) bySession.set(sessionId, identity);
  }
  return [...bySession.values()];
}

export function tokenLogHistoryOf(host: PromptobusHost, home: string, task: string, participant: ParticipantV1 | null | undefined) {
  if (!participant) return [];
  const metadata = participant.metadata ?? {};
  const previous = Array.isArray(metadata.tokenLogHistory) ? metadata.tokenLogHistory as TokenLogIdentity[] : [];
  const identity = sessionLogOf(host, home, task, participant);
  const current = identity ?? { sessionId: ownText(metadata.sessionId) ?? ownText(metadata.owner), path: null };
  return uniqueTokenLogs([...previous, ...(metadata.pending === true && !identity && !current.sessionId ? [] : [current])]);
}

function absentTokens(reason: string): TokenUsage {
  return { input: null, cacheRead: null, cacheWrite: null, output: null, reason };
}

function tokenNumber(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function inside(at: number | null, bounds: TokenBounds) {
  return at !== null && (bounds.from === null || at >= bounds.from)
    && (bounds.until === null || at < bounds.until);
}

function firstTokenBoundary(meta: TaskV1, started: unknown) {
  const stamps = [timeMs(meta.created), timeMs(started)].filter((at) => at !== null);
  return stamps.length ? Math.min(...stamps) : null;
}

function claudeTokens(lines: SessionLogRow[], sessionId: string, bounds: TokenBounds): TokenUsage {
  const messages = new Map<unknown, { at: number | null; usage: Record<string, number | null> }>();
  for (const row of lines) {
    if (row.type !== 'assistant' || row.message?.role !== 'assistant' || row.sessionId !== sessionId) continue;
    if (!ownText(row.message.id) || timeMs(row.timestamp) === null) return absentTokens('message_identity_unavailable');
    const prior = messages.get(row.message.id);
    const usage = { ...prior?.usage };
    for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) {
      const next = tokenNumber(row.message.usage?.[key]);
      usage[key] = next === null ? (usage[key] ?? null) : Math.max(usage[key] ?? 0, next);
    }
    messages.set(row.message.id, { at: prior?.at ?? timeMs(row.timestamp), usage });
  }
  const relevant = [...messages.values()].filter((row) => inside(row.at, bounds));
  if (!relevant.length) return absentTokens('usage_not_reported');
  const fields = { input: 'input_tokens', cacheRead: 'cache_read_input_tokens',
    cacheWrite: 'cache_creation_input_tokens', output: 'output_tokens' };
  const out = {} as TokenTotals;
  for (const [key, fieldName] of Object.entries(fields)) {
    const values = relevant.map((row) => tokenNumber(row.usage?.[fieldName]));
    const sum = values.reduce<number>((total, value) => total + (value ?? 0), 0);
    out[key as keyof TokenTotals] = values.includes(null) ? null : tokenNumber(sum);
  }
  return { ...out, reason: Object.values(out).includes(null) ? 'usage_fields_unavailable' : null };
}

function codexTokens(lines: SessionLogRow[], sessionId: string, bounds: TokenBounds): TokenUsage {
  const identities = lines.filter((row) => row.type === 'session_meta');
  if (!identities.length || identities.some((row) => row.payload?.id !== sessionId)) {
    return absentTokens('session_identity_mismatch');
  }
  const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'];
  let baseline: Record<string, number | null> | null = null, latest: Record<string, number | null> | null = null, previous: Record<string, number | null> | null = null;
  for (const row of lines) {
    if (row.type !== 'event_msg' || row.payload?.type !== 'token_count' || !row.payload.info) continue;
    const at = timeMs(row.timestamp);
    if (at === null) return absentTokens('usage_timestamp_unavailable');
    if (bounds.until !== null && at >= bounds.until) continue;
    const raw = row.payload.info.total_token_usage;
    const current = Object.fromEntries(fields.map((key) => [key, tokenNumber(raw?.[key])]));
    if (previous && fields.some((key) => current[key] !== null && previous![key] !== null
      && current[key]! < previous![key]!)) return absentTokens('cumulative_usage_reset');
    previous = current;
    if (bounds.from !== null && at < bounds.from) baseline = current;
    else latest = current;
  }
  if (!latest) return absentTokens('usage_not_reported');
  if (!baseline && bounds.from !== null
    && !identities.some((row) => timeMs(row.timestamp) !== null && timeMs(row.timestamp)! >= bounds.from!)) {
    return absentTokens('generation_baseline_unavailable');
  }
  const delta = (key: string) => latest![key] === null || (baseline && baseline[key] === null)
    ? null : tokenNumber(latest![key]! - (baseline?.[key] ?? 0));
  const totalInput = delta('input_tokens'), cacheRead = delta('cached_input_tokens');
  const cacheWrite = delta('cache_write_input_tokens'), output = delta('output_tokens');
  const input = totalInput === null || cacheRead === null || cacheWrite === null ? null
    : tokenNumber(totalInput - cacheRead - cacheWrite);
  const out = { input, cacheRead, cacheWrite, output };
  return { ...out, reason: Object.values(out).includes(null) ? 'usage_fields_unavailable' : null };
}

function logTokens(harness: string, identity: TokenLogIdentity | null | undefined, bounds: TokenBounds, observation: ThroughputObservation | null = null): TokenUsage {
  if (harness === 'cursor') {
    return { ...absentTokens('input_cache_usage_not_reported'), output: observation?.outputTokens ?? null };
  }
  if (!['claude', 'codex'].includes(harness)) return absentTokens('harness_usage_unsupported');
  if (!identity?.sessionId || typeof identity.path !== 'string' || !path.isAbsolute(identity.path)) {
    return absentTokens('session_log_unavailable');
  }
  let lines: SessionLogRow[];
  try {
    lines = readFileSync(identity.path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    if (lines.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) return absentTokens('session_log_invalid');
  } catch (error) {
    return absentTokens(error instanceof SyntaxError ? 'session_log_invalid' : 'session_log_unavailable');
  }
  return harness === 'claude' ? claudeTokens(lines, identity.sessionId as string, bounds)
    : codexTokens(lines, identity.sessionId as string, bounds);
}

function sessionTokens(harness: string, identities: TokenLogIdentity | readonly TokenLogIdentity[] | null | undefined, bounds: TokenBounds, observation: ThroughputObservation | null = null): TokenUsage {
  if (harness === 'cursor' || !['claude', 'codex'].includes(harness)) {
    return logTokens(harness, null, bounds, observation);
  }
  if (bounds.from === null) return absentTokens('generation_boundary_unavailable');
  const logs = uniqueTokenLogs(Array.isArray(identities) ? identities : [identities as TokenLogIdentity | null | undefined]);
  if (!logs.length) return absentTokens('session_log_unavailable');
  const readings = logs.map((identity) => logTokens(harness, identity, bounds));
  const out = {} as TokenTotals;
  for (const key of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
    out[key] = readings.some((row) => row[key] === null) ? null
      : tokenNumber(readings.reduce((sum, row) => sum + row[key]!, 0));
  }
  return { ...out, reason: readings.find((row) => row.reason)?.reason
    ?? (Object.values(out).includes(null) ? 'usage_fields_unavailable' : null) };
}

function addTimingSample(state: TimingState, fieldName: keyof TimingState, samplesName: keyof TimingState, from: unknown, to: unknown) {
  const seconds = elapsedSec(from, to);
  if (seconds === null) return;
  state[fieldName] += seconds;
  state[samplesName] += 1;
}

function canonicalMessageTimes(home: string, id: string, participantId: string, address: string) {
  const dir = path.join(taskDir(home, id), 'messages');
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const times = [];
  for (const name of names) {
    let message: Partial<MessageV1> | null;
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

function wardenDeliveryEvents(home: string, id: string, address: string) {
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

function timingFor(home: string, id: string, address: string, participantId: string, at: number, since: string | null = null) {
  const state = {
    idleSec: 0, idleSamples: 0, deliveryLatencySec: 0, deliverySamples: 0,
  };
  const closeAt = timeMs(at) ?? Infinity;
  const openAt = timeMs(since) ?? -Infinity;
  const messages = canonicalMessageTimes(home, id, participantId, address)
    .filter((messageAt) => messageAt >= openAt && messageAt <= closeAt);
  const events = wardenDeliveryEvents(home, id, address)
    .filter((event) => event.at >= openAt && event.at <= closeAt);
  const mark = (readHealth(home, id)?.[address] ?? {}) as { knockedAt?: unknown; deliveredAt?: unknown; since?: unknown; unread?: unknown };
  const beforeClose = (value: unknown) => {
    const stamp = timeMs(value);
    return stamp !== null && stamp >= openAt && stamp <= closeAt ? stamp : null;
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
export function telemetryFileOf(host: Pick<PromptobusHost, 'routingPaths'>) {
  return path.join(path.dirname(host.routingPaths().cacheFile), TELEMETRY_FILE);
}

/** The opaque local key of a task: SHA-256 truncated to sixteen hex characters, unsalted so
 * grouping holds across installs. What it buys is that the slug a person typed is not in the file. */
export function taskHash(id: unknown) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}

/** One window of the record, or `null`. The projection drops rather than repairs, exactly as
 * the cache's does: a number invented here would read as a measurement. */
function windowOf(raw: unknown, endOf: (id: string) => number | null): TelemetryWindow | null {
  const id = typeof (raw as Partial<AvailabilityWindow> | null | undefined)?.id === 'string' ? (raw as AvailabilityWindow).id.trim() : '';
  const at = typeof (raw as Partial<AvailabilityWindow> | null | undefined)?.usedPercent === 'number' ? (raw as AvailabilityWindow).usedPercent! : NaN;
  if (!id || !WINDOW_KINDS.includes((raw as AvailabilityWindow | null | undefined)?.kind as string)) return null;
  if (!Number.isFinite(at) || at < 0 || at > 100) return null;
  const scope = scopeOf((raw as AvailabilityWindow).scope);
  if (scope === undefined) return null;
  return {
    id, kind: (raw as AvailabilityWindow).kind, scope, usedPercentAtSpawn: at, usedPercentAtEnd: endOf(id),
  };
}

/** Whether an entry was checked recently enough to answer about its windows. */
function telemetryEntryFresh(entry: SnapshotEntry | null | undefined, at: number) {
  if (['probe_failed', 'probe_timeout', 'stale_cache'].includes(entry?.reason as string)) return false;
  const checked = Date.parse(entry?.checkedAt as string);
  return Number.isFinite(checked) && checked + WINDOW_TTL_MS > at;
}

function telemetryWindowFresh(window: AvailabilityWindow | null | undefined, entry: SnapshotEntry | null | undefined, at: number) {
  const checked = Date.parse((window?.checkedAt ?? entry?.checkedAt) as string);
  return Number.isFinite(checked) && checked + WINDOW_TTL_MS > at;
}

/** Read one harness entry from the provided snapshot or its cache. */
function snapshotEntryOf(host: PromptobusHost, harness: string, snapshot: SnapshotDocument | null) {
  return (snapshot ?? readSnapshot(host))?.harnesses?.[harness];
}

/** The end-of-run reading of a harness's windows, by id, and only within the window TTL.
 * Deliberately not `entryLive`: a held exhaustion is not a fresh percentage for a delta. */
function endReader(host: PromptobusHost, harness: string, at: number, snapshot: SnapshotDocument | null = null): (id: string) => number | null {
  const entry = snapshotEntryOf(host, harness, snapshot);
  if (!telemetryEntryFresh(entry, at)) return () => null;
  const byId = new Map<string, number>();
  for (const w of Array.isArray(entry!.windows) ? entry!.windows : []) {
    if (typeof w?.id === 'string' && typeof w.usedPercent === 'number'
      && telemetryWindowFresh(w, entry, at)) byId.set(w.id, w.usedPercent);
  }
  return (id) => (byId.has(id) ? byId.get(id)! : null);
}

/** Which spawn-window readings are missing, and whether the reason is harness-wide: a fresh
 * entry reports each id, an absent, stale or held one cannot distinguish its windows. */
export function endReadingStatus(host: PromptobusHost, harness: string, windowIds: readonly string[], at: number, snapshot: SnapshotDocument | null = null) {
  const entry = snapshotEntryOf(host, harness, snapshot);
  const ids = [...new Set(windowIds)];
  if (!telemetryEntryFresh(entry, at)) {
    return {
      missing: ids,
      reason: entry ? (entry!.reason ?? 'stale_cache') : 'probe_failed',
      harness: true,
    };
  }
  const readings = new Set((Array.isArray(entry!.windows) ? entry!.windows : [])
    .filter((window) => typeof window?.id === 'string' && typeof window.usedPercent === 'number'
      && telemetryWindowFresh(window, entry, at))
    .map((window) => window.id));
  const missing = ids.filter((id) => !readings.has(id));
  if (!missing.length) return { missing: [], reason: null, harness: false };
  const held = entry!.source === 'cache' && entry!.state === 'exhausted' && !entry!.resetAt;
  if (held || (!readings.size && entry!.reason !== null && entry!.reason !== undefined)) {
    return { missing, reason: entry!.reason, harness: true };
  }
  return { missing, reason: 'no_window_reading', harness: false };
}

/** Message counts per participant, from the CANONICAL messages and not `history/`, which holds
 * only what a mailbox fetched. Only the envelope is read — `body` never leaves this function. */
export function tallies(home: string, id: string, window: Partial<TokenBounds> | null = null) {
  const from = window && Number.isFinite(window.from) ? window.from : null;
  const until = window && Number.isFinite(window.until) ? window.until : null;
  const out = new Map<string, Tally>();
  const of = (who: string) => {
    if (!out.has(who)) {
      out.set(who, {
        turns: 0, reviewRounds: 0, questions: 0, resultCount: 0, lastResultAt: null,
      });
    }
    return out.get(who)!;
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
    let msg: Partial<MessageV1> | null;
    try {
      msg = JSON.parse(readFileSync(path.join(taskDir(home, id), 'messages', name), 'utf8'));
    } catch {
      // An unreadable record costs its own count and nothing else: the run it
      // belongs to is over, and there is nobody left to fix it for.
      continue;
    }
    const type = typeof msg?.type === 'string' ? msg.type : null;
    if (from !== null || until !== null) {
      const at = isTimestamp(msg?.ts) ? Date.parse(msg.ts) : NaN;
      if (!Number.isFinite(at)) continue;
      if (from !== null && at < from!) continue;
      if (until !== null && at >= until!) continue;
    }
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
      for (const to of Array.isArray(msg!.recipients) ? msg!.recipients : []) {
        if (typeof to === 'string') of(to).reviewRounds += 1;
      }
    }
  }
  return out;
}

/** Whether this participant ever lifted a session — the one predicate deciding both who gets a
 * row and who counts as a neighbour. A record with no model never lifted one. */
function lifted(p: ParticipantV1, registry: RoleRegistry | null = null) {
  if (['teamlead', 'orchestrator'].includes(p?.role)) {
    return Boolean(ownText(p.metadata?.sessionId) || ownText(p.metadata?.owner) || ownText(p.metadata?.model));
  }
  const entry = registry ? roleEntry(registry, p?.role) : null;
  const routing = routingOf(p) as RoutingReading | null;
  const routed = entry?.routed || isRoutedRole(p?.role)
    || (routing?.step === p?.role && isRoutedRole(routing?.role as string));
  if (!routed) return false;
  return typeof p.metadata?.model === 'string' && Boolean(p.metadata.model.trim());
}

function windowIdsOf(p: ParticipantV1) {
  const windows = routingOf(p)?.windows;
  return (Array.isArray(windows) ? windows : [])
    .map((window) => windowOf(window, () => null))
    .filter(Boolean)
    .map((window) => window!.id);
}

/** Recorded harnesses whose rows carry windows and can therefore have an end reading. */
export function telemetryWindowHarnesses(meta: TaskV1 | null | undefined) {
  return [...new Set((meta?.participants ?? [])
    .filter((p) => addressOf(p) && lifted(p))
    .filter((p) => windowIdsOf(p).length)
    .map((p) => p.harness)
    .filter((harness) => typeof harness === 'string' && harness))];
}

/** Spawn-window ids recorded for one harness, in their first-seen order. */
export function telemetryWindowIds(meta: TaskV1 | null | undefined, harness: string) {
  return [...new Set((meta?.participants ?? [])
    .filter((p) => addressOf(p) && lifted(p) && p.harness === harness)
    .flatMap((p) => windowIdsOf(p)))];
}

/** The moment a participant's own run ended: its last result, its dismissal, or the task close.
 * The dismissal is read through the accessor — a field named in four files is renamed in three. */
function endOf(p: ParticipantV1, closedAt: string, lastResultAt: string | null) {
  if (isTimestamp(lastResultAt)) return isoStamp(lastResultAt);
  const dismissed = dismissedOf(p);
  return isTimestamp(dismissed) ? isoStamp(dismissed) : closedAt;
}

/** How many other participants were live on the same harness at this one's spawn. It is why a
 * window delta belongs to the RUN: dividing it is the reader's decision, not this file's. */
function concurrentAt(participants: ParticipantV1[], self: ParticipantV1, spawnedAt: string | null, registry: RoleRegistry) {
  if (!spawnedAt) return null;
  const at = Date.parse(spawnedAt);
  let n = 0;
  for (const p of participants) {
    if (p === self) continue;
    // The same filter the rows use: a record with no model never lifted a session, so counting
    // it would inflate the very number a reader divides a window delta by.
    if (!lifted(p, registry)) continue;
    if (p.harness !== self.harness) continue;
    const started = Date.parse(startedOf(p) ?? '');
    if (!Number.isFinite(started) || started > at) continue;
    const dismissed = Date.parse(dismissedOf(p) ?? '');
    if (Number.isFinite(dismissed) && dismissed <= at) continue;
    n += 1;
  }
  return n;
}

function emptyTally(): Tally {
  return { turns: 0, reviewRounds: 0, questions: 0, resultCount: 0, lastResultAt: null };
}

function ownText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Closed reviewer generations. The open one is the participant record itself.
function priorHarnessGenerations(p: ParticipantV1) {
  const history = Array.isArray(p.metadata?.harnessHistory) ? p.metadata.harnessHistory as GenerationInput[] : [];
  return history
    .filter((row) => row && typeof row.harness === 'string' && row.harness && isTimestamp(row.until))
    .map((row) => ({
      harness: row.harness!,
      // The current record's model is a later generation. A closed row with none of its own is omitted.
      model: ownText(row.model),
      effort: typeof row.effort === 'string' && row.effort ? row.effort : null,
      from: isTimestamp(row.from) ? isoStamp(row.from) : null,
      until: isoStamp(row.until!),
      tupleId: ownText(row.tupleId),
      strategy: ownText(row.strategy),
      strategySource: ownText(row.strategySource),
      tokenLog: row.tokenLog?.sessionId === row.sessionId ? row.tokenLog : null,
      tokenLogHistory: Array.isArray(row.tokenLogHistory) ? row.tokenLogHistory : null,
    }));
}

/** Counting bounds of closed generation `index`. The lower bound is the previous entry's `until`,
 * or none for the first. The entry's own `from` is its last lift, not this bound. */
export function historyCountWindow(history: readonly { until?: string }[], index: number) {
  const until = Date.parse(history[index]?.until ?? '');
  const prev = index > 0 ? Date.parse(history[index - 1]?.until ?? '') : NaN;
  return {
    from: Number.isFinite(prev) ? prev : null,
    until: Number.isFinite(until) ? until : null,
  };
}

/** The records this task's participants leave behind, in journal order; an unrouted `--model`
 * pick gets one too. Every field is copied BY NAME — a spread would carry `metadata` out. */
export function telemetryRecords(host: PromptobusHost, home: string, meta: TaskV1, {
  at = Date.now(), snapshot = null, throughput = null,
}: TelemetryOptions = {}) {
  const participants = (meta?.participants ?? []).filter((p) => addressOf(p));
  const recordedAt = isoStamp(at);
  const task = taskHash(meta.id);
  const counts = tallies(home, meta.id);
  const ends = new Map<string, (id: string) => number | null>();
  const rows: CollectedRecord[] = [];
  const registry = registryOf(host);
  for (const p of participants) {
    if (!lifted(p, registry)) continue;
    const savedRouting = routingOf(p) as RoutingReading | null;
    const savedRole = (savedRouting?.step ?? savedRouting?.role) === p.role
      && isRoutedRole(savedRouting?.role as string) ? savedRouting!.role : null;
    const catalogRole = ['teamlead', 'orchestrator'].includes(p.role) ? p.role
      : savedRole ?? roleEntry(registry, p.role)?.catalogRole ?? p.role;
    const closed = priorHarnessGenerations(p);
    for (let i = 0; i < closed.length; i++) {
      const gen = closed[i];
      if (!gen.model) continue;
      const spawnedAt = gen.from;
      const bounds = historyCountWindow(closed, i);
      const tally = tallies(home, meta.id, bounds).get(p.id) ?? emptyTally();
      const ended = gen.until;
      const seconds = spawnedAt ? Math.round((Date.parse(ended) - Date.parse(spawnedAt)) / 1000) : null;
      const standIn = {
        ...p,
        harness: gen.harness,
        metadata: { ...p.metadata, model: gen.model, started: gen.from },
      };
      rows.push({
        schemaVersion: TELEMETRY_VERSION,
        recordedAt,
        task,
        participant: taskHash(p.id),
        generation: i,
        role: catalogRole,
        step: p.role,
        harness: gen.harness,
        model: gen.model,
        effort: gen.effort,
        tuple: gen.tupleId,
        strategy: gen.strategy,
        strategySource: gen.strategySource,
        spawnedAt,
        lastResultAt: tally.lastResultAt,
        endedAt: ended,
        durationSec: seconds === null ? null : Math.max(0, seconds),
        throughput: null,
        tokens: sessionTokens(gen.harness, gen.tokenLogHistory ?? gen.tokenLog,
          { from: bounds.from ?? firstTokenBoundary(meta, gen.from), until: bounds.until }),
        idleSec: null,
        idleSamples: 0,
        deliveryLatencySec: null,
        deliverySamples: 0,
        turns: tally.turns,
        reviewRounds: tally.reviewRounds,
        questions: tally.questions,
        resultCount: tally.resultCount,
        windows: [],
        concurrentParticipants: concurrentAt(participants, standIn, spawnedAt, registry),
        dismissedBeforeDone: false,
      });
    }
    const model = ownText(p.metadata.model);
    const routing = (routingOf(p) as RoutingReading | null) ?? {};
    const spawnedAt = isTimestamp(startedOf(p)) ? isoStamp(startedOf(p))
      : p.role === 'orchestrator' && isTimestamp(meta.created) ? isoStamp(meta.created) : null;
    const tally = closed.length
      ? (tallies(home, meta.id, {
        from: Date.parse(closed[closed.length - 1].until),
      }).get(p.id) ?? emptyTally())
      : (counts.get(p.id) ?? emptyTally());
    const ended = endOf(p, recordedAt, tally.lastResultAt);
    const seconds = spawnedAt ? Math.round((Date.parse(ended) - Date.parse(spawnedAt)) / 1000) : null;
    const observation = throughput?.get(addressOf(p)!) ?? null;
    const timingSince = closed.length ? closed[closed.length - 1].until : null;
    const timing = timingFor(home, meta.id, addressOf(p)!, p.id, at, timingSince);
    if (!ends.has(p.harness)) ends.set(p.harness, endReader(host, p.harness, at, snapshot));
    const readEnd = ends.get(p.harness)!;
    rows.push({
      schemaVersion: TELEMETRY_VERSION,
      recordedAt,
      task,
      participant: taskHash(p.id),
      generation: closed.length,
      role: catalogRole,
      step: p.role,
      harness: p.harness,
      model,
      effort: typeof p.metadata?.effort === 'string' && p.metadata.effort ? p.metadata.effort : null,
      tuple: typeof routing.tupleId === 'string' && routing.tupleId ? routing.tupleId : null,
      strategy: typeof routing.strategy === 'string' && routing.strategy ? routing.strategy : null,
      // `strategySource` is read defensively: a build that does not write it yet
      // leaves `null`, and a record of it is still a record of the strategy.
      strategySource: typeof routing.strategySource === 'string' && routing.strategySource
        ? routing.strategySource
        : null,
      spawnedAt,
      lastResultAt: tally.lastResultAt,
      endedAt: ended,
      durationSec: seconds === null ? null : Math.max(0, seconds),
      throughput: observation,
      tokens: sessionTokens(p.harness, tokenLogHistoryOf(host, home, meta.id, p), {
        from: closed.length ? timeMs(closed[closed.length - 1].until) : firstTokenBoundary(meta, spawnedAt),
        until: at + 1,
      }, observation),
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
        .filter(Boolean) as TelemetryWindow[],
      concurrentParticipants: concurrentAt(participants, p, spawnedAt, registry),
      dismissedBeforeDone: Boolean(dismissedOf(p)),
    });
  }
  return rows;
}

/** Append this task's records and say how many landed. One write for the whole task, or a `done`
 * interrupted between participants leaves half a run. `mode` is re-set after umask cuts it. */
export function appendTelemetry(host: PromptobusHost, home: string, meta: TaskV1, {
  at = Date.now(), snapshot = null, throughput = null,
}: TelemetryOptions = {}) {
  const file = telemetryFileOf(host);
  const rows = telemetryRecords(host, home, meta, { at, snapshot, throughput });
  if (!rows.length) return { file, written: 0 };
  mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !existsSync(file);
  appendFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: TELEMETRY_MODE });
  if (fresh) chmodSync(file, TELEMETRY_MODE);
  return { file, written: rows.length };
}

/** How many records the file holds and how large it is; `null` for no file, `unreadable` for one
 * that cannot be read — which must not read as "no records yet". */
function telemetryStatsOf(host: PromptobusHost, includeSummary: boolean) {
  const file = telemetryFileOf(host);
  if (!existsSync(file)) return null;
  try {
    const records = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
    const rows = includeSummary ? readTelemetry(host).records : null;
    return { file, records, bytes: statSync(file).size, unreadable: false,
      // The legacy core summary keeps its typed signature; its implementation checks these raw rows.
      ...(includeSummary ? { summary: telemetrySummary(rows as (UnknownRecord & TelemetryRecord)[]) } : {}) };
  } catch (e) {
    return { file, records: null, bytes: null, unreadable: true, note: (e as Error).message };
  }
}

/** Every record the file holds, in append order. A line that does not parse is SKIPPED, not
 * raised on: a truncated last line must not throw away a person's whole history. */
export function readTelemetry(host: Pick<PromptobusHost, 'routingPaths'>) {
  const file = telemetryFileOf(host);
  if (!existsSync(file)) return { file, records: [], skipped: 0 };
  const records: UnknownRecord[] = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) records.push(row as UnknownRecord);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { file, records, skipped };
}

/** The one line `models` prints: count and size only; role summary is in `telemetryStats`. */
export function telemetryLine(host: PromptobusHost) {
  const stats = telemetryStatsOf(host, false);
  if (!stats) return `telemetry: no records yet (${telemetryFileOf(host)})`;
  if (stats.unreadable) {
    return `telemetry: the file is there and could not be read (${stats.note}) — ${stats.file}`;
  }
  return `telemetry: ${stats.records} record(s), ${stats.bytes} B (${stats.file})`;
}

export function telemetryStats(host: PromptobusHost) {
  return telemetryStatsOf(host, true);
}

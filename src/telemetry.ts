// Public participant telemetry summary.
// [reference/03-cli.md#participant-telemetry](../docs/reference/03-cli.md#participant-telemetry)

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PromptobusHost } from './host.js';

const TELEMETRY_FILE = 'telemetry.jsonl';

export type QuotaEvidenceState = 'measured' | 'ambiguous' | 'unavailable';

export interface TelemetryWindow {
  id: string;
  kind: string;
  scope?: unknown;
  usedPercentAtSpawn: number;
  usedPercentAtEnd: number | null;
}

export interface TelemetryRecord {
  task: string;
  role: string;
  harness?: string;
  durationSec?: number | null;
  windows?: readonly TelemetryWindow[];
  idleSec?: number | null;
  deliveryLatencySec?: number | null;
  turns?: number | null;
  reviewRounds?: number | null;
  questions?: number | null;
  resultCount?: number | null;
}

export interface QuotaCoverage {
  role: string;
  records: number;
  measuredRecords: number;
  unavailableRecords: number;
}

export interface QuotaEvidence {
  harness: string;
  windowId: string;
  windowKind: string;
  scope: unknown;
  deltaPercent: number | null;
  state: QuotaEvidenceState;
  coverage: readonly QuotaCoverage[];
}

export interface TelemetryRoleSummary {
  records: number;
  wallClockSec: number | null;
  quotaCostPercent: null;
  quotaCostState: 'ambiguous' | 'unavailable';
  idleSec: number | null;
  deliveryLatencySec: number | null;
  busMessages: number | null;
  reviewRounds: number | null;
  questions: number | null;
  resultCount: number | null;
}

export interface TelemetryRunSummary {
  task: string;
  roles: Record<string, TelemetryRoleSummary>;
  quotaEvidence: readonly QuotaEvidence[];
  bottleneckRole: string | null;
}

export interface TelemetryFileStats {
  file: string;
  records: number;
  bytes: number;
  unreadable: false;
  summary: readonly TelemetryRunSummary[];
}

export interface TelemetryUnreadableStats {
  file: string;
  records: null;
  bytes: null;
  unreadable: true;
  note: string;
}

export type TelemetryStats = TelemetryFileStats | TelemetryUnreadableStats;

type NumericField =
  | 'wallClockSec'
  | 'idleSec'
  | 'deliveryLatencySec'
  | 'busMessages'
  | 'reviewRounds'
  | 'questions'
  | 'resultCount';

interface Measure {
  total: number;
  samples: number;
}

interface SummaryRoleAccumulator {
  records: number;
  sourceRecords: TelemetryRecord[];
  measures: Record<NumericField, Measure>;
}

interface QuotaCoverageAccumulator {
  records: number;
  measured: number;
  unavailable: number;
  deltas: number[];
}

interface QuotaGroup {
  harness: string;
  windowId: string;
  windowKind: string;
  scope: unknown;
  coverage: Map<string, QuotaCoverageAccumulator>;
}

function telemetryFileOf(host: Pick<PromptobusHost, 'routingPaths'>): string {
  return path.join(path.dirname(host.routingPaths().cacheFile), TELEMETRY_FILE);
}

type CanonicalQuotaScope = null
  | { model: string; models?: string[] }
  | { pool: 'auto'; models: string[] }
  | { pool: 'api' };

function nonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim())
    && new Set(value).size === value.length;
}

function canonicalQuotaScope(scope: unknown): CanonicalQuotaScope | undefined {
  if (scope === null) return null;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return undefined;
  const candidate = scope as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (typeof candidate.model === 'string' && candidate.model.trim()) {
    if (!keys.every((key) => key === 'model' || key === 'models')
      || (Object.hasOwn(candidate, 'models') && !nonEmptyStringList(candidate.models))) {
      return undefined;
    }
    return Object.hasOwn(candidate, 'models')
      ? { model: candidate.model, models: [...(candidate.models as string[])].sort() }
      : { model: candidate.model };
  }
  if (candidate.pool === 'auto') {
    if (!keys.every((key) => key === 'pool' || key === 'models')
      || !nonEmptyStringList(candidate.models)) return undefined;
    return { pool: 'auto', models: [...(candidate.models as string[])].sort() };
  }
  return candidate.pool === 'api' && keys.every((key) => key === 'pool')
    ? { pool: 'api' } : undefined;
}

const QUOTA_WINDOW_KEYS = [
  'id', 'kind', 'scope', 'usedPercentAtSpawn', 'usedPercentAtEnd',
];

type QuotaWindowKind = 'session' | 'weekly' | 'monthly';

interface TrustedQuotaWindow {
  key: string;
  harness: string;
  id: string;
  kind: QuotaWindowKind;
  scope: CanonicalQuotaScope;
  deltaPercent: number | null;
}

function trustedQuotaWindowOf(
  record: TelemetryRecord, window: unknown,
): TrustedQuotaWindow | null {
  const harness = typeof record.harness === 'string' ? record.harness : '';
  if (!harness || !window || typeof window !== 'object') return null;
  if (Array.isArray(window)) return null;
  const candidate = window as Record<string, unknown>;
  const keys = Reflect.ownKeys(candidate);
  if (keys.length !== QUOTA_WINDOW_KEYS.length
    || !keys.every((key) => typeof key === 'string' && QUOTA_WINDOW_KEYS.includes(key))) return null;
  const id = typeof candidate.id === 'string' ? candidate.id : '';
  const kind = candidate.kind;
  const scope = canonicalQuotaScope(candidate.scope);
  const usedPercentAtSpawn = candidate.usedPercentAtSpawn;
  const usedPercentAtEnd = candidate.usedPercentAtEnd;
  if (!id || !['session', 'weekly', 'monthly'].includes(kind as QuotaWindowKind)
    || scope === undefined || typeof usedPercentAtSpawn !== 'number'
    || !Number.isFinite(usedPercentAtSpawn) || usedPercentAtSpawn < 0
    || usedPercentAtSpawn > 100
    || (usedPercentAtEnd !== null
      && (typeof usedPercentAtEnd !== 'number' || !Number.isFinite(usedPercentAtEnd)
        || usedPercentAtEnd < 0 || usedPercentAtEnd > 100))) return null;
  const deltaPercent = typeof usedPercentAtEnd === 'number'
    && usedPercentAtEnd >= usedPercentAtSpawn
    ? usedPercentAtEnd - usedPercentAtSpawn : null;
  const trustedKind = kind as QuotaWindowKind;
  return {
    key: JSON.stringify([harness, id, trustedKind, scope]),
    harness,
    id,
    kind: trustedKind,
    scope,
    deltaPercent,
  };
}

function quotaEvidenceOf(records: readonly TelemetryRecord[]): QuotaEvidence[] {
  const groups = new Map<string, QuotaGroup>();
  const recordsByHarness = new Map<string, TelemetryRecord[]>();
  for (const record of Array.isArray(records) ? records : []) {
    const harness = typeof record?.harness === 'string' ? record.harness : '';
    if (!harness) continue;
    if (!recordsByHarness.has(harness)) recordsByHarness.set(harness, []);
    recordsByHarness.get(harness)?.push(record);
    for (const window of Array.isArray(record.windows) ? record.windows : []) {
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
      if (!entry) continue;
      entry.records += 1;
      const windows = Array.isArray(record.windows) ? record.windows : [];
      const matches = windows.map((window) => trustedQuotaWindowOf(record, window))
        .filter((window): window is TrustedQuotaWindow => window?.key === key);
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
    const state: QuotaEvidenceState = !deltas.length ? 'unavailable'
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

function summaryRole(): SummaryRoleAccumulator {
  return {
    records: 0,
    sourceRecords: [],
    measures: {
      wallClockSec: { total: 0, samples: 0 },
      idleSec: { total: 0, samples: 0 },
      deliveryLatencySec: { total: 0, samples: 0 },
      busMessages: { total: 0, samples: 0 },
      reviewRounds: { total: 0, samples: 0 },
      questions: { total: 0, samples: 0 },
      resultCount: { total: 0, samples: 0 },
    },
  };
}

function summaryNumber(
  target: SummaryRoleAccumulator, fieldName: NumericField, value: number | null | undefined,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  target.measures[fieldName].total += value;
  target.measures[fieldName].samples += 1;
}

function summaryValue(target: SummaryRoleAccumulator, fieldName: NumericField): number | null {
  const measure = target.measures[fieldName];
  return measure.samples === target.records ? measure.total : null;
}

export function telemetrySummary(records: readonly TelemetryRecord[] = []): TelemetryRunSummary[] {
  const runs = new Map<string, Map<string, SummaryRoleAccumulator>>();
  for (const record of Array.isArray(records) ? records : []) {
    if (typeof record?.task !== 'string' || !record.task
      || typeof record.role !== 'string' || !record.role) continue;
    if (!runs.has(record.task)) runs.set(record.task, new Map());
    const roles = runs.get(record.task);
    if (!roles) continue;
    if (!roles.has(record.role)) roles.set(record.role, summaryRole());
    const role = roles.get(record.role);
    if (!role) continue;
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
    const roles: Record<string, TelemetryRoleSummary> = {};
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
      .sort((a, b) => b[1].wallClockSec! - a[1].wallClockSec!
        || a[0].localeCompare(b[0])) : [];
    return {
      task,
      roles,
      quotaEvidence,
      bottleneckRole: ranked.length ? ranked[0][0] : null,
    };
  });
}

function rowsOf(text: string): TelemetryRecord[] {
  const rows: TelemetryRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        rows.push(row as TelemetryRecord);
      }
    } catch {
      // A truncated append is skipped; the file remains readable.
    }
  }
  return rows;
}

export function telemetryStats(
  host: Pick<PromptobusHost, 'routingPaths'>,
): TelemetryStats | null {
  const file = telemetryFileOf(host);
  if (!existsSync(file)) return null;
  try {
    const text = readFileSync(file, 'utf8');
    const records = text.split('\n').filter((line) => line.trim()).length;
    const rows = rowsOf(text);
    return {
      file,
      records,
      bytes: statSync(file).size,
      unreadable: false,
      summary: telemetrySummary(rows),
    };
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    return { file, records: null, bytes: null, unreadable: true, note };
  }
}

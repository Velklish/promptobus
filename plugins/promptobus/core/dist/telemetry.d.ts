import type { PromptobusHost } from './host.js';
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
    participant?: string;
    generation?: number;
    role: string;
    harness?: string;
    model?: string | null;
    tokens?: {
        input: number | null;
        cacheRead: number | null;
        cacheWrite: number | null;
        output: number | null;
        reason: string | null;
    };
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
    participants?: readonly TelemetryRecord[];
}
export interface TelemetryUnreadableStats {
    file: string;
    records: null;
    bytes: null;
    unreadable: true;
    note: string;
}
export type TelemetryStats = TelemetryFileStats | TelemetryUnreadableStats;
export declare function telemetrySummary(records?: readonly TelemetryRecord[]): TelemetryRunSummary[];
export declare function telemetryStats(host: Pick<PromptobusHost, 'routingPaths'>, { task }?: {
    task?: string;
}): TelemetryStats | null;

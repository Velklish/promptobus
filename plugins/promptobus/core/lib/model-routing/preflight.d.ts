import type { PromptobusHost } from '../../dist/index.js';
import type { SnapshotEntry } from './cache.js';
interface PreflightRequest {
    host: PromptobusHost;
    harnesses: readonly string[];
    adapterFor: (harness: string) => unknown;
    refresh?: boolean;
    dryRun?: boolean;
    recheckTimedExhaustion?: boolean;
    budgetMs?: number;
    rated?: (harness: string, model: string) => unknown;
}
/** Total budget for the whole preflight, fixed at 15 s by ADR-005. The parameter exists so
 * the suite can run this code against a budget it can afford to wait out. */
export declare const PREFLIGHT_BUDGET_MS = 15000;
/** The availability snapshot for these harnesses. `adapterFor` is passed in, not imported:
 * this module must not know which drivers exist ([lib/drivers.js](../drivers.js) is that door). */
export declare function preflight({ host, harnesses, adapterFor, refresh, dryRun, recheckTimedExhaustion, budgetMs, rated, }: PreflightRequest): Promise<{
    schemaVersion: number;
    takenAt: string;
    harnesses: Record<string, SnapshotEntry>;
}>;
export {};

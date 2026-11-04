import type { PromptobusHost, TaskV1 } from '../dist/index.js';
interface SweepOptions {
    remove?: typeof rmSync;
    tasks?: TaskV1[];
}
import { rmSync } from 'node:fs';
import { PRUNE_DEFAULT_DAYS } from './contract.js';
export { PRUNE_DEFAULT_DAYS };
/** Cleanup at the default threshold, called by `done` after its own work. It prints what
 * was removed and is otherwise silent: `done` without `--older-than` is not a report. */
export declare function sweepJournals(home: string, days?: number, { remove, tasks }?: SweepOptions): {
    count: number;
    gone: number;
    failed: number;
};
export declare function parseOlderThan(olderThan: unknown): number;
export declare function retentionCommand(host: Pick<PromptobusHost, 'busCommand'>, id: string, days: number): string;
export declare function prune(rootOrHost: unknown, { olderThan, yes, tasks, task }?: SweepOptions & {
    olderThan?: unknown;
    yes?: boolean;
    task?: string;
}): void;

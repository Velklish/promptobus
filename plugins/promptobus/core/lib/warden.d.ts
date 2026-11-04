import { knockRegistry, snapshotOf } from './drivers.js';
import type { LibRegistry } from './driver-runtime.js';
import type { PromptobusHost, SessionSnapshot, StalledParticipant, WardenMark } from '../dist/index.js';
type Knock = Parameters<typeof knockRegistry>[0];
interface RoundOptions {
    now?: number;
    knock?: Knock;
    sessions?: SessionSnapshot;
}
interface ReportStallsOptions extends RoundOptions {
    host?: PromptobusHost | null;
}
interface WardenOptions {
    host?: PromptobusHost | null;
    task?: string | null;
}
interface EnsureWardenOptions {
    env?: NodeJS.ProcessEnv;
    pollEnv?: NodeJS.ProcessEnv;
    host?: PromptobusHost | null;
    launch?: (home: string, task: string, env: NodeJS.ProcessEnv, host: PromptobusHost) => number | null;
}
export declare function bindSharedWarden(ensure: (home: string, task: string) => unknown): () => void;
export interface TaskWardenHost {
    version: string;
    formatStalls(task: string, fresh: readonly StalledParticipant[]): string[] | Promise<string[]>;
}
export interface TaskWardenOptions {
    home: string;
    task: string;
    host: TaskWardenHost;
    session: string | null;
    signal?: AbortSignal;
    registry?: LibRegistry;
}
export type TaskWardenResult = {
    kind: 'busy';
    mark: WardenMark;
} | {
    kind: 'stopped';
    reason: string | null;
};
export declare function taskWardenHost(host: PromptobusHost): TaskWardenHost;
export { KNOCK_COALESCE_SEC, KNOCK_RETRY_SEC, ROUND_FAIL_LIMIT, SILENCE_SEC, TICK_MS, WARDEN_ABSOLUTE_SEC, WARDEN_TOTAL_SEC, } from '../dist/index.js';
export { beatRound, liveWatched } from '../dist/index.js';
export declare function wardenRound(home: string, task: string, { now, knock, sessions }?: RoundOptions): Promise<{
    stop: string | null;
    events: string[];
    knocked: string[];
}>;
/** A knocked session is looked at again at once, past the heartbeat's session-list cache, so a refusal
 * naming a reset holds the next knock — 03-cli § Guard and warden. `snapshot` is the suite's seam. */
export declare function reinspectKnocked(home: string, task: string, sessions: SessionSnapshot, knocked: readonly string[], snapshot?: typeof snapshotOf): SessionSnapshot;
/** Participant stalls: fresh ones go to the journal. The one postcard is a named reset's, sent to
 * the orchestrator once per sighting — 03-cli § Guard and warden. */
export declare function reportStalls(home: string, task: string, { sessions, now, host, knock, }?: ReportStallsOptions): Promise<string[]>;
export declare function wardenOff(env?: NodeJS.ProcessEnv): boolean;
export declare function ensureWarden(home: string, task: string, { env, pollEnv, launch, host }?: EnsureWardenOptions): number | null | Promise<number | null>;
export declare function handOverContactPoints(home: string, { env, session }?: {
    env?: NodeJS.ProcessEnv | undefined;
    session?: string | null | undefined;
}): string[];
export declare function warden(opts?: WardenOptions, env?: NodeJS.ProcessEnv, cwd?: string): Promise<{
    pid: number;
    state: string;
}>;
export declare function runTaskWarden({ home, task, host, session, signal, registry }: TaskWardenOptions): Promise<TaskWardenResult>;

import { mcpNote } from './spawn.js';
import { routeLift } from './models.js';
import { prepareNativeContext } from './native-participant-context.js';
import type { PromptobusHost, ParticipantV1, TaskV1 } from '../dist/index.js';
import type { SpawnOptions } from './spawn.js';
import type { CodexDriver } from './drivers.js';
type Selection = ReturnType<typeof prepareNativeContext>;
type RootOwner = Omit<ParticipantV1, 'metadata'> & {
    metadata: ParticipantV1['metadata'] & {
        launcherPid?: number;
        model?: string;
        effort?: string;
    };
};
export interface LeadOptions extends SpawnOptions {
    resume?: boolean;
}
export interface LeadPlan {
    host: PromptobusHost;
    home: string;
    root: string;
    task: string;
    resume: {
        meta: TaskV1;
        owner: RootOwner;
        record: ReturnType<CodexDriver['resumeState']>;
    } | null;
    address: string;
    title: string | undefined;
    slug: string;
    brief: string;
    selectedContext: Selection;
    driver: CodexDriver;
    model: string;
    effort: string | null;
    permissionMode: string;
    rules: string[];
    env: NodeJS.ProcessEnv;
    commonEnv: NodeJS.ProcessEnv;
    name: string;
    launch: ReturnType<CodexDriver['prepare']>;
    prompt: string;
    mcpNote: ReturnType<typeof mcpNote>;
    routing: NonNullable<Awaited<ReturnType<typeof routeLift>>>['metadata'] | null;
}
/** A new root owner uses the same holder and private-home protocol as a teamlead. */
export declare function planLead(rootOrHost: unknown, opts?: LeadOptions): Promise<LeadPlan>;
export declare function lead(rootOrHost: unknown, opts?: LeadOptions): Promise<LeadPlan>;
export {};

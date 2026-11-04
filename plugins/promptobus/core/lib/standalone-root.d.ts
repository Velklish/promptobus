import type { PromptobusHost } from '../dist/index.js';
import type { RootExecCommand } from './launch-exec.js';
import type { StandaloneRootHarness } from './standalone-root-state.js';
export declare const ROOT_LAUNCH_FILE = "PROMPTOBUS_ROOT_LAUNCH_FILE";
export interface StandaloneRootProfileInput {
    id: string;
    harness: StandaloneRootHarness;
    nativeStore: string;
    executable: string;
}
export interface StandaloneRootProfileDescriptor {
    mode: 'standalone';
    harness: StandaloneRootHarness;
    profile: string;
    busUrl: string;
    root: string;
    home: string;
    server: {
        url: string;
        http_headers_helper: string;
        required: true;
    } | {
        type: 'http';
        url: string;
        headersHelper: string;
    };
    startHook: {
        type: 'command';
        command: string;
    };
    execPlanCommand: string;
}
export declare function standaloneResumeId(harness: StandaloneRootHarness, args: readonly string[]): string | null;
export declare function approveStandaloneRootProfile(host: PromptobusHost, input: StandaloneRootProfileInput, env?: NodeJS.ProcessEnv): Promise<StandaloneRootProfileDescriptor>;
export declare function standaloneRootExecPlan(host: PromptobusHost, id: string, command: Pick<RootExecCommand, 'file' | 'args'>, { env, dryRun, launcherPid, cwd }?: {
    env?: NodeJS.ProcessEnv;
    dryRun?: boolean;
    launcherPid?: number;
    cwd?: string;
}): Promise<string | {
    mode: string;
    harness: StandaloneRootHarness;
    profile: string;
    root: string;
    home: string;
    command: Pick<RootExecCommand, "args" | "file">;
    cwd: string;
    preflight: 'notRun';
    nativeAuthorization: 'notRun';
}>;
export declare function standaloneRootHeaders(host: PromptobusHost, id: string, env?: NodeJS.ProcessEnv): Promise<{
    Authorization: string;
}>;
export declare function preflightStandaloneRoot(host: PromptobusHost, id: string, nativeId: string, env?: NodeJS.ProcessEnv): Promise<unknown>;
export declare function authorizeStandaloneRootStart(host: PromptobusHost, id: string, event: Readonly<Record<string, unknown>>, env?: NodeJS.ProcessEnv): Promise<void>;

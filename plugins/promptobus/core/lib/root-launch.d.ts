import type { PromptobusHost } from '../dist/index.js';
import type { RootExecCommand } from './launch-exec.js';
export interface CodexRootProfileDescriptor {
    profile: string;
    busUrl: string;
    root: string;
    home: string;
    server: {
        url: string;
        http_headers_helper: string;
        required: true;
    };
    startHook: {
        type: 'command';
        command: string;
    };
    execPlanCommand: string;
    creation?: {
        state: 'pending' | 'uncertain' | 'bound';
        bbThreadId: string | null;
    };
}
export declare function approveCodexRootProfile(host: PromptobusHost, input: {
    id: string;
    nativeStore: string;
    executionScope?: Readonly<{
        project: string;
        environment: string;
    }>;
    createRoot?: (profile: CodexRootProfileDescriptor) => Promise<{
        id: string;
    }>;
}, env?: NodeJS.ProcessEnv): Promise<CodexRootProfileDescriptor>;
export declare function codexRootExecPlan(host: PromptobusHost, id: string, command: Pick<RootExecCommand, 'file' | 'args'>, { env, dryRun }?: {
    env?: NodeJS.ProcessEnv;
    dryRun?: boolean;
}): Promise<string | {
    profile: string;
    root: string;
    home: string;
    command: Pick<RootExecCommand, "args" | "file">;
    preflight: 'notRun';
    nativeAuthorization: 'notRun';
}>;
export declare function codexRootHeaders(host: PromptobusHost, id: string, env?: NodeJS.ProcessEnv): Promise<{
    Authorization: string;
}>;
export declare function authorizeCodexRootStart(host: PromptobusHost, id: string, event: Readonly<Record<string, unknown>>, env?: NodeJS.ProcessEnv): Promise<void>;

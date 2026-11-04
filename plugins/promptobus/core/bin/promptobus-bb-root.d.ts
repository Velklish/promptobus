#!/usr/bin/env node
import type { PromptobusHost } from '../dist/index.js';
import type { CodexRootProfileDescriptor } from '../lib/root-launch.js';
type RootConfiguration = Pick<CodexRootProfileDescriptor, 'profile' | 'root' | 'home' | 'server'>;
interface RootOptions {
    root: string;
    profile: string;
    'native-store': string;
    project: string;
    environment: string;
    help?: false;
}
interface RootScope {
    readonly root: string;
    readonly project: string;
    readonly environment: string;
}
interface HookStatus {
    key: string;
    eventName: string;
    command: string;
    currentHash: string;
    enabled: boolean;
    trustStatus: string;
    displayOrder: number;
}
interface InvocationIo {
    env?: NodeJS.ProcessEnv;
    input?: AsyncIterable<string | Uint8Array>;
    output?: {
        write(text: string): unknown;
    };
}
export declare function parseOptions(args: string[]): RootOptions | {
    help: true;
};
export declare function readPrompt(input: AsyncIterable<string | Uint8Array>): Promise<string>;
export declare function readBb(args: string[], { root, env }: {
    root: string;
    env: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>>;
export declare function requireEnvironment(scope: RootScope, env: NodeJS.ProcessEnv): Promise<void>;
export declare function renderServer(profile: RootConfiguration): string;
export declare function parseServer(text: string, profile: RootConfiguration): {
    url: string;
    http_headers_helper: string;
    required: true;
};
export declare function hookTrustStatus(result: unknown, profile: RootConfiguration, text: string): {
    ready: boolean;
    handlers: HookStatus[];
};
export declare function inspectHookTrust(profile: RootConfiguration, nativeStore: string, env: NodeJS.ProcessEnv): Promise<{
    ready: boolean;
    handlers: HookStatus[];
    verify: () => void;
    nativeStore: string;
    executable: string;
}>;
export declare function prepareProject(host: PromptobusHost, profile: CodexRootProfileDescriptor, options: {
    create: true;
    update?: boolean;
}): Promise<() => void>;
export declare function prepareProject(host: PromptobusHost, profile: CodexRootProfileDescriptor, options?: {
    create?: boolean;
    update?: boolean;
}): Promise<false | (() => void)>;
export declare function runBbRoot(args: string[], { env, input, output }?: InvocationIo): Promise<2 | undefined>;
export {};

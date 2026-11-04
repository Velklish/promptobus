import type { SpawnOptions, SpawnSyncOptions, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
interface ProcessEnvironment {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
}
interface RunPlan {
    ok: true;
    file: string;
    args: readonly string[];
    verbatim: boolean;
}
interface RunRefusal {
    ok: false;
    code: string;
    message: string;
}
interface AsyncRunOptions extends SpawnOptions {
    timeoutMs?: number;
    encoding?: BufferEncoding | 'buffer' | null;
}
export interface AsyncRunResult<T extends string | Buffer = string | Buffer> {
    error: Error | null;
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: T;
    stderr: T;
    pid: number | undefined;
    output: [null, T, T];
}
export declare const PROC_MAX_OUTPUT: number;
export declare const PROC_TIMEOUT_MS = 60000;
export declare function resolveCommand(cmd: string, { platform, env }?: ProcessEnvironment): string | null;
export declare function quoteCmdArg(arg: unknown): string;
export declare function buildCmdLine(file: string, args: readonly string[]): string;
export declare function planRun(cmd: string, args?: readonly string[], { platform, env }?: ProcessEnvironment): RunPlan | RunRefusal;
export declare function wouldResolve(cmd: string, env: NodeJS.ProcessEnv, cwd?: string): string | null;
export declare function run(cmd: string, args: readonly string[] | undefined, options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> | AsyncRunResult<string>;
export declare function run(cmd: string, args?: readonly string[], options?: SpawnSyncOptions): SpawnSyncReturns<string | Buffer> | AsyncRunResult<string>;
export declare function runAsync(cmd: string, args: readonly string[] | undefined, options: AsyncRunOptions & {
    encoding: BufferEncoding;
}): Promise<AsyncRunResult<string>>;
export declare function runAsync(cmd: string, args?: readonly string[], options?: AsyncRunOptions): Promise<AsyncRunResult>;
export {};

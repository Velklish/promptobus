import type { SpawnSyncOptions } from 'node:child_process';
import { PROC_MAX_OUTPUT, PROC_TIMEOUT_MS } from './exec.js';
export { PROC_MAX_OUTPUT, PROC_MAX_OUTPUT as GIT_MAX_OUTPUT, PROC_TIMEOUT_MS };
export interface ProcessResult {
    status?: number | null;
    signal?: string | null;
    error?: NodeJS.ErrnoException | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
}
interface LoggedRunOptions {
    cwd?: string;
    timeout?: number;
    logPath?: string;
    env?: NodeJS.ProcessEnv;
    exec?: (cmd: string, args: readonly string[], options: SpawnSyncOptions) => ProcessResult;
}
export declare function ok(msg: unknown): void;
export declare function info(msg: unknown): void;
export declare function warn(msg: unknown): void;
export declare function fail(msg: unknown): never;
export declare function bad(msg: unknown): void;
export declare const GIT_NET_TIMEOUT_MS = 30000;
export declare const gitIn: (dir: string, args: readonly string[], input?: string | Buffer) => import("child_process").SpawnSyncReturns<string>;
export declare const GIT_CLONE_TIMEOUT_MS: number;
export declare const PROC_INSTALL_TIMEOUT_MS: number;
export declare function runProc(cmd: string, args?: readonly string[], options?: SpawnSyncOptions): import("./exec.js").AsyncRunResult<string> | import("child_process").SpawnSyncReturns<string | Buffer<ArrayBufferLike>>;
export declare function procTimedOut(r: ProcessResult | null | undefined): boolean;
export declare function lastLine(text: unknown): string;
export declare function lastLines(text: unknown, n?: number): string;
export declare function runLogged(argv: readonly string[], { cwd, timeout, logPath, exec, env }?: LoggedRunOptions): {
    status: number;
    ms: number;
    logPath: string | undefined;
    why: null;
} | {
    status: number | null;
    ms: number;
    logPath: string | undefined;
    why: string;
};
export declare function procError(r: ProcessResult | null | undefined, { label, full }?: {
    label?: string;
    full?: boolean;
}): string;
export { shellQuote } from '../dist/fs/shell.js';
export declare function toPosix(p: string): string;
export declare function envPlaceholderRe(): RegExp;
export declare function substituteEnvVars<T>(obj: T): T;

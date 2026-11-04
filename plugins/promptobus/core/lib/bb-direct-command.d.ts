import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
type DirectChild = ChildProcessByStdio<null, Readable, Readable>;
export interface DirectCommandReceipt {
    command: readonly string[];
    by: string;
    cwd: string;
    complete: boolean;
    exit: number | null;
    signal: NodeJS.Signals | null;
    error: string | null;
    [key: string]: unknown;
}
export interface DirectCommandInput {
    command: readonly string[];
    stem: string;
    by: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    beforeSpawn?: (start: () => DirectChild) => unknown;
    onReceipt?: (receipt: DirectCommandReceipt) => unknown;
    receiptFields?: Record<string, unknown>;
    spawnPlan?: {
        file: string;
        args: readonly string[];
        verbatim?: boolean;
    };
}
export declare function assertBbDirectCommand(command: readonly string[]): void;
export declare function recordBbDirectCommand({ command, stem, by, cwd, env, beforeSpawn, onReceipt, receiptFields, spawnPlan }: DirectCommandInput): Promise<{
    receipt: {
        command: readonly string[];
        by: string;
        cwd: string;
        exit: number | null;
        signal: NodeJS.Signals | null;
        error: string | null;
        complete: boolean;
        finalizationComplete?: boolean | undefined;
        finalizationError?: string | undefined;
        stdout: {
            file: string;
            bytes: number;
            sha256: string;
        };
        stderr: {
            file: string;
            bytes: number;
            sha256: string;
        };
    };
    exitCode: number;
}>;
export {};

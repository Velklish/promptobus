import type { PromptobusHost } from '../dist/index.js';
interface LeaseParty {
    pid?: number | null;
    since?: string | null;
    address?: string | null;
    task?: string | null;
    command?: string | null;
    cwd?: string;
}
interface LeaseWaiter extends LeaseParty {
    pid: number;
}
interface LeaseHolder extends LeaseParty {
    alive: boolean;
    ambiguous?: boolean;
    childPid?: number | null;
}
interface LeaseState {
    root: string;
    holder: LeaseHolder | null;
    waiters: LeaseWaiter[];
}
interface LeaseOptions {
    key?: string | null;
    waitMs?: number;
    retryMs?: number;
    log?: (line: string) => void;
}
export declare const LEASE_DIR_VAR = "PROMPTOBUS_LEASE_DIR";
export declare const LEASE_WAIT_SEC = 1800;
/** Where the lease lives: outside every store home, so all workspaces of this user see one lease. */
export declare function leaseRoot(env?: NodeJS.ProcessEnv): string;
/** One party of the lease, for a person: who, in which task, running what, since when. */
export declare function describeParty(p: LeaseParty, now?: number): string;
/** The holder and the live waiters. Pid and time come from the lock's own owner file. */
export declare function readLease(root?: string, key?: string | null): LeaseState;
/** The `status` lines: the holder, or "free", then each waiter. */
export declare function leaseLines(root?: string, now?: number, key?: string | null): string[];
/** Hold the selected lease around `fn`. A live holder is waited out up to `waitMs`, with one
 * line each time the holder changes; past the bound the refusal carries that same line. */
export declare function underLease<T>(root: string, me: LeaseParty, fn: (lock?: string) => T | Promise<T>, { key, waitMs, retryMs, log }?: LeaseOptions): Promise<T>;
export declare function keyedCommandPlan(command: string[], env: NodeJS.ProcessEnv, keyedLocks?: string[]): {
    file: string;
    args: string[];
    verbatim: boolean;
};
/** `lease [--key <clone-root>] [--wait <seconds>] -- <command…>`: the command's exit code. */
export declare function lease(host: Pick<PromptobusHost, 'commandName'>, { command, as, task, key, wait, env, cwd }: {
    command?: string[];
    as?: string | null;
    task?: string | null;
    key?: string | null;
    wait?: unknown;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}): Promise<number>;
/** Resource ownership and optional machine lease guidance for executable participants. */
export declare function leaseRule({ host, taskId, address }: {
    host: Pick<PromptobusHost, 'busCommand'>;
    taskId: string;
    address: string;
}): string;
export {};

import { randomBytes } from 'node:crypto';
import { run } from './exec.js';
import type { ProcessIdentity } from './service-state.js';
interface HolderResponse {
    status: number;
    data: unknown;
}
type HolderFetch = (url: string, password: string, method: string, path: string, body?: unknown, timeoutMs?: number) => Promise<HolderResponse>;
interface PermissionAsk {
    action: string;
    [key: string]: unknown;
}
/** A holder password — 43 base62 chars, the shape the binary prints itself. */
export declare function holderPassword(random?: typeof randomBytes): string;
/** The listening port off the holder log line, case-insensitive — the binary owns the words. */
export declare function portOfLog(text: unknown): number | null;
export declare const holderUrl: (port: number) => string;
export declare const HOLDER_HTTP_TIMEOUT_MS = 10000;
/** The holder answers session lists: readiness is an answered request, not a port bind. */
export declare function waitReady(url: string, password: string, { timeoutMs, stepMs }?: {
    stepMs?: number | undefined;
    timeoutMs?: number | undefined;
}, fetchFn?: HolderFetch): Promise<boolean>;
/** Start the holder detached with its log; the caller waits readiness separately. */
export declare function startHolder(bin: string, argv: string[], { cwd, env, log }: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    log?: string | null;
}): import("child_process").ChildProcess;
/** Stop an owned holder and confirm exit within the existing cleanup budget. */
export declare function reapHolder(pid: number, { graceMs, stepMs, identity }?: {
    graceMs?: number;
    stepMs?: number;
    identity?: ProcessIdentity | null;
}): Promise<void>;
export declare function pidAlive(pid: number): boolean;
export declare const createSession: (url: string, password: string, title: string, fetchFn?: HolderFetch) => Promise<HolderResponse>;
export declare const sendPrompt: (url: string, password: string, sessionId: string, text: string, fetchFn?: HolderFetch) => Promise<HolderResponse>;
export declare const listPermissions: (url: string, password: string, sessionId: string, fetchFn?: HolderFetch) => Promise<HolderResponse>;
export declare const replyPermission: (url: string, password: string, sessionId: string, requestId: string, fetchFn?: HolderFetch) => Promise<HolderResponse>;
/** Asks from a permission body, or null when the body is not that list. */
export declare function parsePermissionList(value: unknown): PermissionAsk[] | null;
export declare const readMessages: (url: string, password: string, sessionId: string, limit?: number, fetchFn?: HolderFetch) => Promise<HolderResponse>;
export declare const deleteSession: (url: string, password: string, sessionId: string, fetchFn?: HolderFetch) => Promise<HolderResponse>;
/** The trailing idle outcome of a message list, newest first, or null while the turn runs. */
export declare function idleOutcome(value: unknown): unknown;
export declare const HOLDER_REQUEST_SOURCE: string;
/** One holder request from a synchronous caller. Null when the process or the body fails. */
export declare function holderRequestSync(url: string, password: string, method: string, requestPath: string, body: unknown, runFn?: typeof run): HolderResponse | null;
export {};

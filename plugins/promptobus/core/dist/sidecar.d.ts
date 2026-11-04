import type { LockHolder } from './fs/lock.js';
import { GateError } from './protocol.js';
export declare function workersDir(home: string, id: string): string;
export declare function sessionsDir(home: string): string;
export declare function wardenMarkFile(home: string, id: string): string;
export declare function wakeFile(home: string, id: string, addr: string): string;
export declare function healthFile(home: string, id: string): string;
export declare function wardenLogFile(home: string, id: string): string;
export declare function stallsFile(home: string, id: string): string;
export declare const WARDEN_BEAT_SEC = 30;
/** Mark of the task warden process. */
export interface WardenMark {
    pid: number;
    started?: string;
    beat?: string;
    cli?: string;
    /** Harness version, if the consumer named one. Neutral name: more than one harness exists. */
    harness?: string;
    [key: string]: unknown;
}
export declare function readWardenMark(home: string, id: string): WardenMark | null;
export declare function writeWardenMark(home: string, id: string, mark: WardenMark): WardenMark;
export declare function dropWardenMark(home: string, id: string): void;
/** Warden departure note for the loop guard — written before the mark is cleared. */
export interface WardenExit {
    reason: string;
    at: string;
}
export declare function writeWardenExit(home: string, id: string, note: WardenExit): void;
export declare function readWardenExit(home: string, id: string): WardenExit | null;
export declare function clearWardenExit(home: string, id: string): void;
export declare function readWardenGeneration(home: string, id: string): number;
export declare function liveWarden(home: string, id: string): WardenMark | null;
/** Participant contact point: where the warden knocks. */
export interface Wake {
    address: string;
    socket: string;
    token?: string;
    pid: number;
    session?: string;
    at: string;
}
export declare function readWake(home: string, id: string, addr: string): Wake | null;
export declare function writeWake(home: string, id: string, addr: string, { socket, token, pid, session, }?: {
    socket?: string | null;
    token?: string | null;
    pid?: number;
    session?: string | null;
}): Wake | null;
/** What the warden knows about delivery by address. */
export type Health = Record<string, unknown>;
export declare function readHealth(home: string, id: string): Health;
export declare function writeHealth(home: string, id: string, health: Health): Health;
/** Mark of reported stalls: reason, time of the last report, and a try counter per address. A former
 * CLI wrote a bare reason string, read as a mark with no time — repeated only when the reason changes. */
export type Stalls = Record<string, {
    reason: string;
    at: string | null;
    tries?: number;
}>;
export declare function readStalls(home: string, id: string): Stalls;
/** Atomic: a truncated file would be read as "never reported". */
export declare function writeStalls(home: string, id: string, stalls: Stalls): Stalls;
export declare function logWarden(home: string, id: string, line: string): boolean;
export declare function tailWardenLog(home: string, id: string, n?: number): string[];
export declare function markTurn(home: string, id: string, addr: string, at?: string): string;
export declare function lastTurnAt(home: string, id: string, addr: string): number | null;
export interface Transcript {
    path: string;
    session: string | null;
    at: string;
}
export declare function markTranscript(home: string, id: string, addr: string, file: string, session?: string | null): Transcript;
export declare function readTranscript(home: string, id: string, addr: string): Transcript | null;
export declare function sessionFile(home: string, session: string | null): string | null;
/** Mark binding a session to a task. `role` and `address` are written when the caller knows them:
 * missing fields are lawful — the orchestrator writes a binding too, with one known address. */
export interface Binding {
    session: string;
    task: string;
    since: string;
    role?: string;
    address?: string;
}
export declare function readBinding(home: string, session: string | null): Binding | null;
export declare function writeBinding(home: string, mark: Binding): Binding;
/** Names of sessions that have a binding mark. Cleanup walks this list. */
export declare function bindingNames(home: string): string[];
export declare function dropBinding(home: string, session: string): void;
/** Wrapper that suspends the journal cache for the duration of the call. */
export type Suspend = <T>(fn: () => T) => T;
export declare function onTaskLock(suspend: Suspend): void;
/** Who holds the task lock. */
export type { LockHolder };
export declare function lockBusyError(id: string, lock: string, held: LockHolder | null, waitedMs: number): GateError;
export declare function withTaskLock<T>(home: string, id: string, fn: () => T, { waitMs, session, }?: {
    waitMs?: number;
    session?: string | null;
}): T;
/** The journal lock and cache suspension held until asynchronous work settles. */
export declare function withTaskLockAsync<T>(home: string, id: string, fn: () => Promise<T>, { waitMs, session, }?: {
    waitMs?: number;
    session?: string | null;
}): Promise<T>;
/** Publication lock, adapter side: a sweep judges a payload under the lock a send names one in.
 * [reference/04-protocol.md#store-layout](../docs/reference/04-protocol.md#store-layout) */
export declare function withBlobLock<T>(home: string, id: string, fn: () => T, { waitMs, session, }?: {
    waitMs?: number;
    session?: string | null;
}): T;
export declare function claimWarden(home: string, id: string, { pid, cli, harness, session, }?: {
    pid?: number;
    cli?: string | null;
    harness?: string | null;
    session?: string | null;
}): {
    busy?: WardenMark;
    mark?: WardenMark;
};
export declare function beatWarden(home: string, id: string, { pid, session, }?: {
    pid?: number;
    session?: string | null;
}): WardenMark | null;
export declare function clearWarden(home: string, id: string, pid?: number, { session, }?: {
    session?: string | null;
}): boolean;

import type { ProbeRequest } from '../../dist/index.js';
import type { InventoryModel, SnapshotEntry } from './cache.js';
export type AdapterModel = Omit<InventoryModel, 'rated'> & {
    rated?: boolean;
};
export type AdapterVerdict = Omit<SnapshotEntry, 'models'> & {
    models?: AdapterModel[];
};
export interface RoutingAdapter {
    tool?: string;
    readsVersion?: boolean;
    probe(request: ProbeRequest): AdapterVerdict | Promise<AdapterVerdict>;
}
export interface CaptureError {
    code?: unknown;
    message?: unknown;
}
export type CaptureResult = {
    launched: false;
    error: CaptureError | null | undefined;
    timedOut?: false;
    status?: never;
    signal?: never;
    stdout?: never;
} | {
    launched: true;
    timedOut: boolean;
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    error?: never;
};
export type JsonResponse<T = unknown> = {
    status: number;
    doc: T | null;
    error?: never;
} | {
    error: 'timeout' | 'network';
    status?: never;
    doc?: never;
};
export interface TokenRequest {
    token: string;
    timeoutMs: number;
}
/** The credential store on macOS, by absolute path — a `security` off `PATH` is a poor thing to
 * hand a request for a token. */
export declare const SECURITY_BIN = "/usr/bin/security";
/** Spawn a binary and capture its stdout, resolving exactly once and never rejecting: every outcome
 * becomes a field of the result. [guides/model-routing.md](../../docs/guides/model-routing.md#killing-a-probes-child-why-three-lines-and-not-one). */
export declare function spawnAndCapture(bin: string, argv: readonly string[], timeoutMs: number): Promise<CaptureResult>;
/** One keychain secret on macOS via `security find-generic-password`: the trimmed value, or `null`
 * on any refusal, timeout, non-zero exit or empty answer — the caller decides what that means. */
export declare function readKeychainSecret(service: string, { timeoutMs }: {
    timeoutMs: number;
}): Promise<string | null>;
/** One HTTP call, JSON in hand or a word for why not. `timeout` and `network` are different
 * verdicts; the response text is parsed and dropped, never carried past this call. */
export declare function requestJson(url: string, { method, headers, body, timeoutMs, }: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
}): Promise<JsonResponse>;
/** One verdict, of any adapter or of the preflight itself. `source` is `probe` by default —
 * override it in `extra` for a cache-sourced verdict, along with the `checkedAt` it keeps. */
export declare function verdict<T extends Partial<AdapterVerdict> = {}>(state: string, reason: string | null, message: string, extra?: T): AdapterVerdict & T;

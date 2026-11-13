import type { ProcessIdentity, RecordVersion } from './service-state.js';
import type { HarnessSessionRecord } from './harness-registry.js';
import type { LibMcpServer } from './driver-runtime.js';
import type { PromptobusHost } from '../dist/index.js';
export interface CodexRateLimits {
    rateLimitReachedType?: string | null;
    primary?: CodexRateLimits | null;
    secondary?: CodexRateLimits | null;
    usedPercent?: unknown;
    resetsAt?: unknown;
    planType?: unknown;
    windowDurationMins?: unknown;
    lengthSec?: unknown;
    credits?: {
        balance?: unknown;
        hasCredits?: unknown;
        unlimited?: unknown;
    } | null;
    spendControlReached?: unknown;
    [key: string]: unknown;
}
export interface CodexPendingRequest {
    id?: unknown;
    method?: string;
    at?: string;
    server?: string | null;
    mode?: string | null;
    kind?: string | null;
}
interface CodexError {
    code?: unknown;
    message?: string;
}
interface CodexTurn {
    id?: string;
    status?: string;
    error?: string | CodexError | null;
    items?: CodexItem[];
}
interface CodexItem {
    type?: string;
    id?: string;
    name?: string;
    input?: string | null;
    arguments?: string;
    output?: unknown;
    call_id?: unknown;
    command?: string;
    cwd?: string;
    processId?: string | null;
    exitCode?: number | null;
    aggregatedOutput?: string | null;
    status?: string;
    error?: unknown;
    server?: string;
    tool?: string;
    content?: {
        type?: string;
        text?: string;
    }[];
}
export interface CodexParams extends CodexRateLimits {
    id?: string;
    threadId?: string;
    turn?: CodexTurn;
    type?: string;
    status?: string;
    error?: string | CodexError | null;
    item?: CodexItem;
    run?: {
        eventName?: unknown;
        status?: unknown;
        sourcePath?: unknown;
    };
    requestId?: unknown;
    questions?: {
        id: string;
    }[];
    networkApprovalContext?: {
        host?: unknown;
        protocol?: unknown;
    } | null;
    proposedNetworkPolicyAmendments?: {
        host?: unknown;
    }[];
    permissions?: {
        fileSystem?: unknown;
        network?: {
            enabled?: unknown;
        };
    } | null;
    sandbox?: unknown;
    approvalPolicy?: unknown;
    cwd?: unknown;
    fileChanges?: unknown;
    requestedSchema?: {
        type?: unknown;
        properties?: unknown;
    } | null;
    _meta?: Record<string, unknown> | null;
    serverName?: unknown;
    server?: unknown;
    mode?: unknown;
    grantRoot?: unknown;
    kind?: unknown;
}
interface CodexResult {
    id?: string;
    turn?: CodexTurn;
    thread?: {
        id?: string;
        path?: string;
        turns?: CodexTurn[];
    };
    model?: string | null;
    reasoningEffort?: string | null;
    sandbox?: {
        type?: string;
        networkAccess?: boolean;
    };
    approvalPolicy?: string | null;
    cwd?: string;
    [key: string]: unknown;
}
export interface CodexSessionRecord extends HarnessSessionRecord {
    ref: string;
    bin?: string;
    cwd?: string;
    role?: string;
    prompt?: string;
    name?: string;
    home?: string | null;
    task?: string | null;
    address?: string | null;
    hostName?: unknown;
    codexHome?: string;
    authOwnerHome?: string;
    rpcSocket?: string | null;
    launchId?: string | null;
    threadId?: string | null;
    sandbox?: string;
    approvalPolicy?: string;
    model?: string | null;
    effort?: string | null;
    addDirs?: string[];
    holderPid?: number | null;
    appPid?: number | null;
    state?: string;
    busy?: boolean;
    error?: string | null;
    holderProcess?: ProcessIdentity | null;
    appProcess?: ProcessIdentity | null;
    nativeAdmissionSchema?: 1;
    launcherProcess?: ProcessIdentity | null;
    turns?: number;
    stopping?: boolean;
    stopConfirmed?: boolean;
    stopError?: string | null;
    rawToolReceipts?: boolean;
    commandReceiptFile?: string;
    canonicalSkillsDir?: string | null;
    resumeThreadId?: string | null;
    startedAt?: string;
    mcpPrefix?: string;
    initialPrompt?: string;
    initialAssignmentInjected?: boolean;
    bindBeforeFirstTurn?: boolean;
    rolloutPath?: string | null;
    firstTurnStartedAt?: string;
    firstTurnEndedAt?: string;
    pendingRequests?: CodexPendingRequest[];
    pendingRequest?: CodexPendingRequest | null;
    lastUnknownApproval?: {
        method: string;
        at: string;
        why?: string;
    } | null;
    rateLimits?: CodexRateLimits | null;
    nameSet?: boolean | null;
    methodsCalled?: string[];
    lastEvent?: string | null;
    lastEventAt?: string | null;
    currentTurnId?: string | null;
    lastTurn?: {
        id?: string | null;
        status?: string | null;
        at?: string;
        error?: string;
    };
    nativeAdmission?: {
        harness: 'codex';
        nativeStore: string;
        nativeId: string;
        process: ProcessIdentity;
    };
    nativeAdmissionEvidence?: {
        kind: 'codex-thread-api';
        method: 'thread/start' | 'thread/resume';
        nativeStore: string;
        nativeId: string;
        process: ProcessIdentity;
    };
}
interface CodexAdmissionPublication {
    version: RecordVersion;
    launchId: string;
    home: string;
    task: string;
    address: string;
    nativeStore: string;
    nativeId: string;
    process: ProcessIdentity;
    method: 'thread/start' | 'thread/resume';
}
export type ManagedCodexResumeDeath = {
    kind: 'process-birth';
    holder: ProcessIdentity;
    process: ProcessIdentity;
};
export declare function managedCodexResumeDeath(ref: string, record: CodexSessionRecord, env?: NodeJS.ProcessEnv): ManagedCodexResumeDeath;
export declare function retireCodexResumeHolderLock(ref: string, record: CodexSessionRecord, env?: NodeJS.ProcessEnv): void;
export declare function publishCodexNativeAdmission(ref: string, input: CodexAdmissionPublication, env?: NodeJS.ProcessEnv): void;
export interface CodexHolderResult extends Partial<CodexSessionRecord> {
    ok?: boolean;
    stopped?: boolean;
    attempted?: boolean;
    deferred?: boolean;
    note?: string | null;
    receiptFile?: string;
    threadStatus?: string | {
        type?: string;
    } | null;
    turnStarted?: boolean;
    activeTurns?: (string | null | undefined)[];
    appClosed?: boolean;
    holderExitRequested?: boolean;
    commandReceiptError?: string | null;
}
type ConfiguredServers = {
    ok: false;
    why: string;
    names?: never;
} | {
    ok: true;
    names: Set<string>;
    why?: never;
};
interface ApprovalDecision {
    allow: boolean;
    why?: string;
    unknown?: boolean;
}
export declare const SESSION_ENV_VAR = "PROMPTOBUS_CODEX_SESSION";
export declare const PARTICIPANT_ARGV: string[];
export declare function codexInitParams(record: CodexSessionRecord | null | undefined, env?: NodeJS.ProcessEnv): {
    clientInfo: {
        name: string;
        version: string;
    };
    capabilities: {
        experimentalApi: boolean;
        optOutNotificationMethods: string[];
    };
};
export declare function socketPath(ref: string, env?: NodeJS.ProcessEnv, launchId?: string | null): string;
export declare function selfStopLogFile(ref: string, launchId: string, env?: NodeJS.ProcessEnv): string;
export declare function holderLogFile(ref: string, env?: NodeJS.ProcessEnv): string;
export declare const codexStateHome: (env?: NodeJS.ProcessEnv) => string;
export declare const sessionsDir: (env?: NodeJS.ProcessEnv) => string;
export declare const sessionKey: typeof import("./harness-registry.js").sessionKey;
export declare const sessionFile: (ref: string, env?: NodeJS.ProcessEnv) => string;
export declare const readSession: (ref: string, env?: NodeJS.ProcessEnv) => CodexSessionRecord | null;
export declare const writeSession: (record: CodexSessionRecord, env?: NodeJS.ProcessEnv) => {
    provenance: string;
} & Omit<CodexSessionRecord, "provenance">;
export declare const patchSession: (ref: string, patch: Partial<CodexSessionRecord>, env?: NodeJS.ProcessEnv) => ({
    provenance: string;
} & Omit<CodexSessionRecord, "provenance">) | null;
export declare const dropSession: (ref: string, env?: NodeJS.ProcessEnv) => void;
export declare const registrySessions: (env?: NodeJS.ProcessEnv) => CodexSessionRecord[];
export declare const scanSessions: (env?: NodeJS.ProcessEnv) => import("./harness-registry.js").RegistryObservation<CodexSessionRecord>;
export declare const pidAlive: typeof import("./store.js").pidAlive;
export declare function findSessionByAddress(home: string, task: string, address: string, env?: NodeJS.ProcessEnv): CodexSessionRecord | null;
export declare function bindParticipantHomeRemoval(fn: ((home: string) => unknown) | null): void;
export declare const INIT_TIMEOUT_MS = 30000;
export declare const MODEL_LIST_TIMEOUT_MS = 15000;
export declare const THREAD_START_TIMEOUT_MS = 60000;
export declare const NAME_SET_TIMEOUT_MS = 10000;
export declare const TURN_STARTED_TIMEOUT_MS = 15000;
export declare function turnWaitMs(env?: NodeJS.ProcessEnv): number;
export declare function limitWaitMs(env?: NodeJS.ProcessEnv): number;
export declare function preambleMs(env?: NodeJS.ProcessEnv): number;
export declare function readyMs(env?: NodeJS.ProcessEnv): number;
/** Live silence budget for a running Codex turn. Cursor's watchdog is the same 180 s. */
export declare const TURN_IDLE_MS = 180000;
export declare function turnIdleMs(env?: NodeJS.ProcessEnv): number;
/** Error text app-server put on turn/completed. Message only — never a params blob. */
export declare function turnErrorText(params: CodexParams | null | undefined): string | null;
export declare function turnFailed(status: unknown): status is "error" | "failed";
/** Drop only the matching server-request id. Number `1` and string `"1"` stay distinct. */
export declare function outstandingAfterResolved(pendingRequests: readonly CodexPendingRequest[] | null | undefined, requestId: unknown): CodexPendingRequest[];
export declare function oldestPending(pendingRequests: readonly CodexPendingRequest[] | null | undefined): CodexPendingRequest;
export declare const STOP_TIMEOUT_MS = 10000;
export declare const STOP_STEP_MS = 100;
export declare function rateLimitReached(snap: CodexRateLimits | null | undefined): boolean;
export declare function rateLimitNote(snap: CodexRateLimits | null | undefined): string | null;
/** `model/list` rows as names, with the mark app-server puts on hidden ones. Filtering is
 * the caller's: a hidden model a person named is still a model they named (ADR-005). */
export declare function listedModels(result: unknown): {
    model: unknown;
    hidden: boolean;
}[];
export declare function withSessionLaunch<T>(ref: string, env: NodeJS.ProcessEnv | undefined, fn: () => T, { waitMs }?: {
    waitMs?: number;
}): T;
export declare function takeHolderLock(ref: string, env?: NodeJS.ProcessEnv): {
    ok: boolean;
    file: string;
    error?: undefined;
} | {
    ok: boolean;
    file: string;
    error: string;
};
export declare function dropHolderLock(ref: string, env?: NodeJS.ProcessEnv): void;
export declare function holderAsk<T = CodexHolderResult>(ref: string, op: string, extra?: Record<string, unknown>, env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<T>;
export declare function holderAlive(ref: string, env?: NodeJS.ProcessEnv): boolean;
export declare function holderLockState(ref: string, env?: NodeJS.ProcessEnv): 'alive' | 'dead' | 'unknown';
export declare function startHolder(ref: string, env?: NodeJS.ProcessEnv): import("child_process").ChildProcess;
export declare function waitReady(ref: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, readyState?: string): Promise<{
    ok: boolean;
    error: string;
    record: CodexSessionRecord;
    log?: undefined;
} | {
    error?: undefined;
    ok: boolean;
    record: CodexSessionRecord;
    log?: undefined;
} | {
    ok: boolean;
    error: string;
    record: CodexSessionRecord | null;
    log: string;
}>;
export declare function tailLog(ref: string, env?: NodeJS.ProcessEnv, n?: number): string;
/** Stop the holder of `ref`: ask `shutdown` (bounded by `timeoutMs`, the ask also at most 5 s),
 *  then confirm its exit. A declined or unreadable native Stop retains the owned record. */
export declare function reapHolder(ref: string, env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<void>;
export declare function waitStopped(ref: string, env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<boolean>;
export declare function writeParticipantWake(record: Partial<CodexSessionRecord>, _env?: NodeJS.ProcessEnv): import("../dist/sidecar.js").Wake | null;
export declare function approvalReply(method: string, allow: boolean, params?: CodexParams): object;
/** The `[mcp_servers]` keys the lift wrote, read once at holder start. A later write to the
 * home does not widen this set. [05-drivers § codex_apps](../docs/reference/05-drivers.md#the-built-in-codex_apps-server-stays-off-in-the-participant-home) */
export declare function configuredMcpServers(record: CodexSessionRecord | null | undefined): ConfiguredServers;
/** Allowlisted fields of a server-to-client request. Never the prompt, schema, url or params
 * blob; `schema` and `kind` are shape, and name which question was asked. */
export declare function serverRequestSummary(method: string, params: CodexParams | null | undefined): {
    method: string;
    server: string | null;
    mode: string | null;
    schema: boolean;
    kind: string | null;
};
export declare function decideApproval(method: string, params: CodexParams | null | undefined, record: CodexSessionRecord, configuredServers?: ConfiguredServers | null): ApprovalDecision;
export declare function codexMcpPrefix(host: Pick<PromptobusHost, 'commandName'>): string;
export declare function codexMcpName(name: unknown, prefix: string): string;
/** Workspace MCP set into the Codex `mcp_servers` form. The two transports do not share a
 * field, and a foreign one kills the config load: [05-drivers.md](../docs/reference/05-drivers.md#the-two-mcp_servers-transports-and-the-field-that-kills-the-config-load) */
export declare function codexMcpServers(servers: Record<string, LibMcpServer> | null | undefined, prefix: string): {
    servers: Record<string, LibMcpServer>;
    skipped: string[];
};
export declare function threadStartConfig(record: CodexSessionRecord): {
    bypass_hook_trust: boolean;
    'features.shell_tool'?: boolean | undefined;
    'features.unified_exec'?: boolean | undefined;
    'features.hooks'?: boolean | undefined;
    model_reasoning_effort?: string | undefined;
};
export declare function verifyThreadProfile(record: CodexSessionRecord, result: CodexResult | null | undefined, log?: (line: string) => void): void;
/** Disable personal duplicates by the paths Codex itself lists. The private canonical copy also
 * has user scope for an install-root role, so its directory is excluded explicitly. */
export declare function canonicalSkillOverrides(listed: unknown, canonicalDir: string): {
    path: string | undefined;
    enabled: boolean;
}[];
export declare function recoveryPrompt(record: CodexSessionRecord, history: CodexResult | null | undefined): string | undefined;
/** Body of the detached holder. The argument is the path to the session record: the holder
 * does not rebuild the ref from argv, so it cannot drift from the file key. */
export declare function holdMain(argv?: string[], env?: NodeJS.ProcessEnv): Promise<void>;
export {};

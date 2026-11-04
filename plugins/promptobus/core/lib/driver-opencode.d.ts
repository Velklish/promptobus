import { run } from './exec.js';
import type { ProcessIdentity, RecordVersion } from './service-state.js';
import { sayForeignWrite as commonSayForeignWrite } from './driver-common.js';
import { listPermissions, parsePermissionList } from './opencode-session.js';
import type { ActivationTarget, HostMcpTool, Notification, ParticipantV1, SessionView } from '../dist/index.js';
import type { LibDriver, LibLaunchPlan, LibPrepareContext } from './driver-runtime.js';
type PermissionAsk = NonNullable<ReturnType<typeof parsePermissionList>>[number];
type HolderFetch = NonNullable<Parameters<typeof listPermissions>[3]>;
interface OpenCodeRecord {
    url: string | null;
    password: string | null;
    sessionId: string | null;
    holderPid?: number;
    holderProcess?: ProcessIdentity | null;
    nativeAdmissionUnknown?: {
        harness: 'opencode';
        nativeId: string;
        reason: string;
    };
    nativeCommand?: {
        executable: RecordVersion;
        argv: string[];
        nativeEnvironment: {
            XDG_DATA_HOME: string;
            OPENCODE_DB: string;
            OPENCODE_SIMULATE?: string;
        };
    };
    nativeCreationPending?: {
        endpoint: string;
    };
    nativeAdmission?: {
        harness: 'opencode';
        nativeStore: string;
        nativeId: string;
        process: ProcessIdentity;
    };
    nativeAdmissionEvidence?: {
        kind: 'opencode-session-api';
        method: 'session/create';
        nativeStore: string;
        nativeId: string;
        process: ProcessIdentity;
        endpoint: string;
        executable: RecordVersion;
    };
    log?: string | null;
    cwd?: string;
    roots?: string[];
    started: string;
    home?: string | null;
    task?: string | null;
    address?: string | null;
    ref?: string;
    launchId?: string;
}
interface OpenCodePlan extends LibLaunchPlan {
    prompt?: string;
    env?: NodeJS.ProcessEnv;
    roots?: string[];
    addDirs?: string[];
    holder?: {
        password?: string;
        title?: string;
    };
    permissionPollMs?: number;
}
interface PermissionOptions {
    url: string;
    password: string;
    sessionId: string;
    roots: readonly unknown[];
    pollMs?: number;
    stepMs?: number;
    fetchFn?: HolderFetch;
    sleepFn?: (ms: number) => Promise<unknown>;
}
/** Harness name in the participant record and the key in the registry map. */
export declare const OPENCODE = "opencode";
/** Skills directory the driver names for a lift: carried by `OPENCODE_CONFIG_DIR`, so nothing of
 * the driver's lands in the participant's working directory. */
export declare const OPENCODE_SKILLS_REL: string;
export declare const PERMISSION_MODES: string[];
export declare const DEFAULT_PERMISSION_MODE = "auto";
export declare const EFFORT_LEVELS: never[];
export declare const DEFAULT_MODEL = "opencode-go/muse-spark-1.3-contributor";
export declare const OPENCODE_MIN_VERSION = "2.0.0";
export declare const PERMISSION_POLL_MS = 4000;
export declare const REVIEWER_DENY: string[];
export declare function permissionDeny(denyTools: readonly unknown[] | null | undefined): Record<string, "deny" | Record<string, "allow">>;
export declare function permissionGrant(denyTools: readonly unknown[] | null | undefined, roots: readonly unknown[] | null | undefined): Record<string, "deny" | Record<string, "allow">>;
export declare const SESSION_RECORD_VAR = "PROMPTOBUS_OPENCODE_SESSION";
export declare function mcpDenyTools(tools: readonly HostMcpTool[] | null | undefined): string[];
export declare const SESSION_ENV_DROP: string[];
/** Harness words the adapter inserts into its own strings: shared prose stays with it. */
export declare const PHRASES: {
    sessions: string;
    unreadable: string;
    enter: (id: string | null) => string;
    stop: (id: string | null) => string;
    logs: () => string;
    tool: (_server: string, name: string) => string;
    mcpBoundary: string;
    reviewerCommands: {
        isolation: string;
        procedureSkip: string;
        record: string;
        gate: string;
    };
    promptRules: string;
};
/** The workspace skills canon: `.opencode/skills` at the workspace root. No directory — null. */
export declare function workspaceSkillsDir(root: string | null | undefined): string | null;
/** Session cwd and absolute addDirs. A relative path is not a root: resolving it would follow the wrong process. */
export declare function declaredRoots(cwd: unknown, addDirs?: readonly unknown[]): string[];
/** The directory an external_directory resource names, after a trailing glob is stripped. */
export declare function resourceInRoots(resource: unknown, roots: readonly unknown[] | null | undefined): boolean;
export declare function askResources(ask: Partial<PermissionAsk> | null | undefined): string[];
/** An external_directory ask whose every resource is a declared root or inside one. */
export declare function coveredExternalDirectory(ask: Partial<PermissionAsk> | null | undefined, roots: readonly unknown[] | null | undefined): boolean;
export declare function pendingPermissionNote(asks: readonly Partial<PermissionAsk>[] | null | undefined): string;
/** Reply for declared-root external_directory asks. Any ask still listed fails the lift. */
export declare function settlePermissionAsks({ url, password, sessionId, roots, pollMs, stepMs, fetchFn, sleepFn, }: PermissionOptions): Promise<void>;
/** Lift plan from harness-neutral context. Writes nothing and starts nothing. */
export declare function prepare({ ref, role: _role, mcp, prompt, model, effort, permissionMode: _permissionMode, mcpConfigPath, env, denyTools, root, skillsRoot, selectedContext, home, task, address, cwd, addDirs, }: Omit<LibPrepareContext, 'role' | 'task' | 'address' | 'cwd'> & {
    role?: string | null;
    task?: string | null;
    address?: string | null;
    cwd?: string | null;
}): OpenCodePlan;
declare const sayForeignWrite: typeof commonSayForeignWrite;
export { sayForeignWrite };
export declare function holderRecord({ home, task, address, password, pid, log, cwd }: {
    home?: string | null;
    task?: string | null;
    address?: string | null;
    password?: string | null;
    pid?: number;
    log?: string | null;
    cwd?: string;
}): OpenCodeRecord;
/** Registry file key of a ref — the name `writeSession` files it under. */
export declare const registrySessionKey: (ref: string) => string;
/** Pending asks after declared-root replies. Null when the permission route cannot be read. */
export declare function remainingPermissionAsks(record: OpenCodeRecord, runFn?: typeof run): PermissionAsk[] | null;
export declare function listSessionsSync(record: OpenCodeRecord, runFn?: typeof run): unknown[] | null;
/** The argv reading the holder session list: one local subprocess per heartbeat. */
export declare function apiArgv(record: OpenCodeRecord): string[];
/** The `{data:[...]}` envelope off the list call, or null when it does not parse. */
export declare function parseSessionList(text: unknown): unknown[] | null;
/** The snapshot view off a list the holder answered. A pending ask is not a model call. */
export declare function viewOf(record: OpenCodeRecord, list: readonly unknown[] | null | undefined, asks?: PermissionAsk[] | null | undefined): SessionView;
export declare function sweepParticipant(participant: ParticipantV1, taskId: string, env?: NodeJS.ProcessEnv, context?: {
    home: string;
    task: string;
    taskLocked?: true;
}): Promise<{
    swept: number;
}>;
/** Contact point of an opencode participant: the session-record path. The record holds url,
 * password and session id behind mode 0600 — no secret travels the journal. */
export declare function registerWake(home: string, task: string, addr: string, env?: NodeJS.ProcessEnv, session?: string | null): false | import("../dist/sidecar.js").Wake | null;
/** Channel smoke: the holder process is up and the record names a session. It answers no
 * turn state — an optimistic smoke for doctor/integration; `activate` is the real gate. */
export declare function checkWake(env?: NodeJS.ProcessEnv): {
    endpoint: null;
    ok: boolean;
    error: string;
} | {
    endpoint: string;
    ok: boolean;
    error: string;
} | {
    endpoint: string;
    ok: boolean;
    error: null;
};
export declare function renderNotification(n: Notification): string;
/** Wake a participant with a follow-up turn on its session. An idle session takes the text; a
 * running turn refuses honestly, and the warden falls back to self-wake and retries. */
export declare function activate(target: ActivationTarget, notification: Notification): Promise<{
    ok: boolean;
    error: string;
} | {
    error?: undefined;
    ok: boolean;
}>;
/** OpenCode driver — worker, reviewer and approver lifts through a per-participant holder. */
export declare const opencodeDriver: LibDriver;

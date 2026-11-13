import type { PreservedDirectoryVerifier } from './native-participant-context.js';
import type { RecordVersion } from './service-state.js';
import { codexMcpPrefix } from './codex-session.js';
import { probeCodex } from './model-routing/adapter-codex.js';
import { sayForeignWrite as commonSayForeignWrite } from './driver-common.js';
export { participantAuthSnapshot } from './codex-participant-auth.js';
import type { HostMcpTool, LaunchFile, Notification, NotificationMessage, SessionView, WakeProbe, ActivationTarget, ActivateResult, ParticipantV1, ReservationLookup, ReservationState, UnstartedReservation } from '../dist/index.js';
import type { CodexSessionRecord, ManagedCodexResumeDeath } from './codex-session.js';
import type { LibDriver, LibLaunchPlan, LibPrepareContext, LibSpawnContext, LibSpawnResult, LibStall, LibMcpConfig, LibMcpServer, LibToolBin } from './driver-runtime.js';
interface CodexPrepareContext extends Omit<LibPrepareContext, 'task' | 'address' | 'mcpConfigPath' | 'settingsPath' | 'guardCommand'> {
    task?: string | null;
    address?: string | null;
    mcpConfigPath?: string;
    settingsPath?: string | null;
    guardCommand?: string | null;
}
interface CodexLaunchPlan extends LibLaunchPlan {
    mcpConfig: LibMcpConfig;
    settings: {
        sandbox?: string;
        approvalPolicy?: string;
        model?: string;
        effort?: string | null;
        addDirs?: string[];
    };
    prompt: string;
    rootSessionRecord?: string | null;
    codexHome?: string;
    privateHomeSkills?: string | null;
    privateHomeFiles?: LaunchFile[];
    canonicalSkillsDir?: string | null;
    homeHooks?: string | null;
    bindBeforeFirstTurn?: boolean;
    trustProject?: boolean;
    resumeThreadId?: string;
    launchId?: string;
    retainFailedSession?: boolean;
    managedResume?: {
        version: RecordVersion;
        ref: string;
        home: string;
        task: string;
        address: string;
        nativeId: string;
        nativeStore: string;
        cwd: string;
        previousLaunchId: string;
        previous: CodexSessionRecord['nativeAdmission'] | null;
        death: ManagedCodexResumeDeath;
        launcherPid: number;
        previousLauncherPid: number | null;
    };
}
interface CodexParticipant extends Omit<ParticipantV1, 'metadata'> {
    address?: string;
    metadata: ParticipantV1['metadata'] & {
        nativeStop?: {
            alias?: unknown;
            home?: string;
        };
        address?: string;
    };
}
export declare const CODEX = "codex";
export declare const CODEX_TEAMLEAD_ROOT_SERVER = "promptobus-root";
export declare const EFFORT_LEVELS: string[];
export declare const PERMISSION_MODES: string[];
export declare const DEFAULT_PERMISSION_MODE = "workspace-write";
export declare const DEFAULT_MODEL = "gpt-6-astra";
export declare const REVIEWER_DENY: string[];
export declare const PROVEN_CODEX_VERSION = "0.167.2";
export declare const MIN_CODEX_VERSION = "0.158.0";
export declare const SESSION_ENV_DROP: string[];
type SystemSkillsVerifier = PreservedDirectoryVerifier;
export declare function pristineCodexSystemSkills(bin: string, env?: NodeJS.ProcessEnv): Promise<SystemSkillsVerifier>;
export declare const codexToolSegment: (s: unknown) => string;
export declare const PHRASES: {
    workerOrchestrator: string;
    rootPreamble: ({ task, root }: {
        task: string;
        root: string;
    }) => string;
    mcpBoundary: string;
    reviewerCommands: {
        isolation: string;
        procedureSkip: string;
        record: string;
        gate: string;
    };
    promptRules: string;
    promptRulesFor: (role: string) => string;
    sessions: string;
    unreadable: string;
    naming: string;
    enter: (id: string | null) => string;
    stop: (id: string | null) => string;
    logs: (id: string | null) => string;
    tool: (server: string, name: string, host: Parameters<typeof codexMcpPrefix>[0]) => string;
};
/** Project skills directory relative to project root: `.codex/skills` —
 * [ADR-008](../docs/adr/adr-008-codex-reviewer-working-directory.md). */
export declare const CODEX_SKILLS_REL: string;
/** The hooks document this lift writes into a path it owns. A file already at the
 * discovery path is judged by its records, not by these bytes. */
export declare function hooksDocument(command: string): string;
/** Refuse foreign hooks, then validate clone-root config with the selected binary at lift. */
export declare function refuseForeignProjectLayer(lookupDir: string, writtenDir: string, tool?: LibToolBin | null, guardCommand?: string | null, projectGuardCommand?: string | null): void;
/** The owner's Codex home — the only thing a participant home copies from, and read-only to the
 * mechanism. The durable host override precedes `CODEX_HOME`, else `~/.codex`. */
export declare function ownerCodexHome(env?: NodeJS.ProcessEnv): string;
/** Parent of every participant home. Nothing outside it is ever removed. */
export declare function participantHomesRoot(): string;
/** The home of ONE participant. Deterministic rather than `mkdtemp`, so `--dry-run` can print the
 * path a real lift will use; the hash carries task and address, and the suffix the registry. */
export declare function participantCodexHome({ task, address }: {
    task?: string | null;
    address?: string | null;
}, env?: NodeJS.ProcessEnv): string;
/** `config.toml` of a participant home. There is no trust COMMAND on codex-cli 0.156.1, and the
 * `[projects]` key is the project's REALPATH — the unresolved spelling is not recognised. */
export declare function codexHomeConfig({ servers, trusted, hooksEnabled, rawToolReceipts }?: {
    servers?: Record<string, LibMcpServer>;
    trusted?: string[];
    hooksEnabled?: boolean;
    rawToolReceipts?: boolean;
}): string;
/** The spelling Codex compares a `[projects]` key against. Exported because the difference from
 * `path.resolve` is invisible except through a symlink, so the check lives on this function. */
export declare function trustPath(dir: string): string;
/** Where Codex reads this directory's project `hooks.json`. A linked worktree is the main
 * checkout's `.codex`; every other directory is its own. [hooks-and-trust](../docs/guides/hooks-and-trust.md). */
export declare function projectHooksDir(cwd: string): string;
/** The home hooks file is written here, after the home exists. A launch-file write
 * would go through a path the home guard has not checked. */
export declare function writeRedirectedHooks(plan: Pick<CodexLaunchPlan, 'homeHooks'>, workdir: string, codexHome: string): string | null;
/** Build the home. Not a wipe: a repeat spawn writes over the config of a home whose app-server may
 * still hold a thread. A missing `auth.json` is reported, not refused — an API key travels anyway. */
export declare function makeParticipantHome({ dir, config, env, ownerHome }: {
    dir: string;
    config?: string;
    env?: NodeJS.ProcessEnv;
    ownerHome?: string;
}): {
    dir: string;
    auth: boolean;
    config: string;
};
/** Remove one participant home. The guard is the point: this runs on `done` and on a failed lift
 * with a path off a record, so only a direct child of the homes root is ever removed. */
export declare function removeParticipantHome(dir: unknown): boolean;
/** Remove every home of this registry that no session record names.
 * [reference/05-drivers.md#sweepparticipanthomes--remove-every-home-of-this-registry-that-no-session-record-names](../docs/reference/05-drivers.md#sweepparticipanthomes--remove-every-home-of-this-registry-that-no-session-record-names) */
export declare function sweepParticipantHomes(env?: NodeJS.ProcessEnv): string[];
declare function reservationState(input: ReservationLookup): ReservationState;
declare function retireUnstarted(input: UnstartedReservation): boolean;
/** The harness state of one closed participant that lives outside its worktree — a reviewer has
 * none and its home holds the same credentials copy. Rebuilt from task and address when needed. */
export declare function sweepParticipant(participant: CodexParticipant, taskId: string, env?: NodeJS.ProcessEnv): boolean;
/** The Codex skills canon at the workspace root — the only source, since a person's copies under
 * `~/.codex` are not addressed to the participant. No directory means `null`. */
export declare function workspaceSkillsDir(root: string | null | undefined): string | null;
export declare function installPrivateHomeLayer(plan: Pick<CodexLaunchPlan, 'privateHomeFiles' | 'privateHomeSkills'>, codexHome: string, verifySystem?: SystemSkillsVerifier): void;
/** The lift line about workspace skills names the destination each role actually reads. */
export declare function skillsNoteOf({ src, dest, count }: {
    src: string | null;
    dest: string;
    count: number;
}): string;
/** Reviewer working directory: the mechanism's own, not the tree under review.
 * [reference/05-drivers.md#reviewsandbox--reviewer-working-directory-the-mechanisms-own-not-the-tree-under-review](../docs/reference/05-drivers.md#reviewsandbox--reviewer-working-directory-the-mechanisms-own-not-the-tree-under-review) */
export declare function reviewSandbox(settingsPath: unknown): string;
export declare function mcpDenyTools(tools: readonly HostMcpTool[]): {
    server: string;
    tool: string;
}[];
/** Lift plan from harness-neutral context; writes and launches nothing. */
declare function prepare({ mcp, prompt, model, effort, permissionMode, addDirs, readFiles, readSkillDirs, cwd, denyTools, ref, role, task, address, root, skillsRoot, selectedContext, settingsPath, executionKind, rootTask, rootAddress, guardCommand, projectGuardCommand, env, }: CodexPrepareContext): CodexLaunchPlan;
declare function replaceMcpServers(plan: LibLaunchPlan, servers: Record<string, LibMcpServer>): void;
declare const sessionEnv: (base?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv) => {
    [x: string]: string | undefined;
};
declare function optionRefusal(): null;
declare function shadowedUserServers(): never[];
declare const sayForeignWrite: typeof commonSayForeignWrite;
export { sayForeignWrite };
export declare function registerWake(home: string, task: string, addr: string, env?: NodeJS.ProcessEnv, session?: string | null): false | import("../dist/sidecar.js").Wake | null;
export declare function checkWake(env?: NodeJS.ProcessEnv): WakeProbe;
export declare function orderBody(task: string, addr: string, unread: number, msgs?: NotificationMessage[], prefix?: string | null): string;
/** Wake text for one participant. The tool namespace comes off the SESSION RECORD, since neither
 * this function nor a `Notification` carries a host; `activate` holds the record and never comes here. */
export declare function renderNotification(n: Notification): string;
export declare function activate(target: ActivationTarget, notification: Notification): Promise<ActivateResult>;
declare function inspect(ref: string): SessionView;
export declare function stallRoute({ kind, address, repoAbs, task: _task, reviewCommand, doneCommand, statusCommand, reset }: LibStall, id: string | null): string;
declare function resumeState(ref: string, { home, cwd, task, address, threadId, launcherPid, env }: Parameters<NonNullable<LibDriver['resumeState']>>[1]): CodexSessionRecord;
declare function spawn(input: LibLaunchPlan, { tool, ref, role, cwd, env, host, home: runtimeHome, task: runtimeTask, address: runtimeAddress, launchFailNote, deadNote, persist, }: LibSpawnContext): Promise<LibSpawnResult<CodexSessionRecord>>;
declare function saidLiftoff({ output, seen: receipt }: LibSpawnResult & {
    name?: string;
}): void;
export declare function retireConfirmedCodex(ref: string, launchId: string, threadId: string | null | undefined, deadline: number): string | undefined;
/** Stop confirms terminal command accounting before retiring the matching launch.
 * Unresolved stops retain their record, participant home and selected lifecycle receipts. */
declare function stop(ref: string, { timeoutMs, deferSelf }?: {
    deferSelf?: boolean | undefined;
    timeoutMs?: number | undefined;
}): Promise<{
    ok: boolean;
    stopped: boolean;
    note: string;
    deferred?: undefined;
} | {
    ok: boolean;
    attempted: boolean;
    stopped: boolean;
    note: string;
} | {
    ok: boolean;
    stopped: boolean;
    deferred: boolean;
    note: string;
}>;
export declare const codexDriver: {
    reservationState: typeof reservationState;
    retireUnstarted: typeof retireUnstarted;
    id: string;
    capabilities: {
        spawn: true;
        attach: false;
        activation: "push";
        inspect: true;
        stop: true;
        denyTools: true;
        mcpDenyTools: true;
        approverLift: true;
        systemPrompt: true;
        sessionList: true;
        enter: true;
    };
    options: {
        tool: string;
        effortLevels: string[];
        permissionModes: string[];
        defaultPermissionMode: string;
        defaultModel: string;
        denyTools: string[];
        provenVersion: string;
        knockChannel: string;
        identityVar: string;
        mcpIdentity: {
            recordVar: string;
            idField: string;
        };
        envDrop: string[];
        skillsDir: false;
        selectedContext: true;
        launchDirs: string[];
    };
    availability: {
        tool: string;
        probe: (request: Parameters<typeof probeCodex>[0]) => Promise<import("./model-routing/adapter-common.js").AdapterVerdict>;
    };
    phrases: {
        workerOrchestrator: string;
        rootPreamble: ({ task, root }: {
            task: string;
            root: string;
        }) => string;
        mcpBoundary: string;
        reviewerCommands: {
            isolation: string;
            procedureSkip: string;
            record: string;
            gate: string;
        };
        promptRules: string;
        promptRulesFor: (role: string) => string;
        sessions: string;
        unreadable: string;
        naming: string;
        enter: (id: string | null) => string;
        stop: (id: string | null) => string;
        logs: (id: string | null) => string;
        tool: (server: string, name: string, host: Parameters<typeof codexMcpPrefix>[0]) => string;
    };
    prepare: typeof prepare;
    replaceMcpServers: typeof replaceMcpServers;
    resumeState: typeof resumeState;
    prepareRootLaunch: ({ home, task, env }: Parameters<NonNullable<LibDriver['prepareRootLaunch']>>[0]) => void;
    refuseForeignProjectLayer: typeof refuseForeignProjectLayer;
    participantCodexHome: typeof participantCodexHome;
    sweepParticipant: typeof sweepParticipant;
    mcpDenyTools: typeof mcpDenyTools;
    spawn: typeof spawn;
    saidLiftoff: typeof saidLiftoff;
    inspect: typeof inspect;
    stop: typeof stop;
    stopSelf: (ref: string) => Promise<{
        ok: boolean;
        stopped: boolean;
        note: string;
        deferred?: undefined;
    } | {
        ok: boolean;
        attempted: boolean;
        stopped: boolean;
        note: string;
    } | {
        ok: boolean;
        stopped: boolean;
        deferred: boolean;
        note: string;
    }>;
    activate: typeof activate;
    renderNotification: typeof renderNotification;
    stallRoute: typeof stallRoute;
    registerWake: typeof registerWake;
    sayForeignWrite: typeof commonSayForeignWrite;
    checkWake: typeof checkWake;
    sessionEnv: typeof sessionEnv;
    optionRefusal: typeof optionRefusal;
    shadowedUserServers: typeof shadowedUserServers;
};

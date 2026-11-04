import { resetBgSessionsCache, sayLiftoff } from './liftoff.js';
import { sayForeignWrite as commonSayForeignWrite } from './driver-common.js';
import type { HostMcpTool, Notification, NotificationMessage, SessionView, SessionStall, WakeProbe, ActivateResult, ActivationTarget, PromptobusHost } from '../dist/index.js';
import type { RawBgSession } from './liftoff.js';
import type { LibLaunchPlan, LibPrepareContext, LibSpawnContext, LibStall, LibMcpServer } from './driver-runtime.js';
interface ClaudeLaunchPlan extends LibLaunchPlan {
    claudeStartHook: {
        command: string | null | undefined;
        settingsPath: string;
    };
}
interface ClaudePrepareContext extends Omit<LibPrepareContext, 'role'> {
    role?: string | null;
}
/** Harness name in the participant record and the key in the registry map. */
export declare const CLAUDE = "claude";
/** Project skills directory relative to project root: `.claude/skills` (https://docs.claude.com/en/docs/claude-code/skills). */
export declare const CLAUDE_SKILLS_REL: string;
export declare const EFFORT_LEVELS: string[];
export declare const PERMISSION_MODES: string[];
export declare const DEFAULT_PERMISSION_MODE = "auto";
/** The modes a session bypasses permission prompts in, in the harness's own sense. **Measured, not
 * read off the names**: `dontAsk`, `acceptEdits` and `auto` all took a knocked message. */
export declare const PROMPT_BYPASS_MODES: string[];
/** Whether a lift in this mode would have the session hold an unattested peer message. */
export declare const bypassesPrompts: (mode: string | null | undefined) => boolean;
export declare const DEFAULT_MODEL = "opus";
export declare const MODEL_ALIASES: string[];
export declare const MODEL_IDS: string[];
export declare const MODEL_SCOPE_IDS: {
    fable: string[];
    opus: string[];
    sonnet: string[];
    haiku: string[];
};
export declare const MODEL_ALIAS_IDS: {
    fable: string[];
    opus: string[];
    sonnet: string[];
    haiku: string[];
};
export declare const inventoryFor: (_version: unknown) => string[];
export declare const REVIEWER_DENY: string[];
export declare const REPORTER_DENY: string[];
export declare const PROVEN_CLAUDE_VERSION = "2.1.280";
export declare const SESSION_ENV_DROP: string[];
export declare const SESSION_RECORD_VAR = "PROMPTOBUS_CLAUDE_SESSION";
/** Harness words the adapter inserts into its own strings: shared prose stays with it, the command
 * stays here, or everyone who prints a session line would know `claude attach`. */
export declare const PHRASES: {
    sessions: string;
    unreadable: string;
    enter: (id: string | null) => string;
    stop: (id: string | null) => string;
    logs: (id: string | null) => string;
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
export declare const KNOCK_TIMEOUT_MS = 3000;
export declare const KNOCK_FROM = "promptobus-warden";
export declare function sessionDetail(id: unknown, home?: string): string | null;
export declare function sessionDetailAt(id: unknown, detail: string | null | undefined, home?: string): number | null;
export declare const TRANSCRIPT_TAIL: number;
export declare function awaitsUser(file: unknown): boolean;
export declare function markLimitAtStart(host: Pick<PromptobusHost, 'routingPaths' | 'busCommand'> | null | undefined, output: unknown): string;
export declare function sessionStall(session: RawBgSession | null | undefined, detail?: unknown, seen?: number | null | undefined): SessionStall | null;
export declare function stallRoute({ kind, address, repoAbs: _repoAbs, task: _task, reviewCommand, reset }: LibStall, id: string | null, name: string | null): string;
export declare function orderBody(task: string, addr: string, unread: number, msgs?: NotificationMessage[]): string;
export declare function renderNotification(n: Notification): string;
export declare function knockSocket(endpoint: ActivationTarget['endpoint'], body: string, { timeoutMs }?: {
    timeoutMs?: number | undefined;
}): Promise<ActivateResult>;
export declare function probeWake(socketPath: string, token: unknown, { timeoutMs }?: {
    timeoutMs?: number | undefined;
}): Promise<ActivateResult>;
/** Wake channel of THIS session — the diagnostics entry. `doctor` asks for the outcome, not the
 * variables, and the smoke sends no real message: that would cost a record in a person's feed. */
export declare function checkWake(env?: NodeJS.ProcessEnv): Promise<WakeProbe>;
export declare function registerWake(home: string, task: string, addr: string, env?: NodeJS.ProcessEnv, session?: string | null): false | import("../dist/sidecar.js").Wake | null;
export declare function bindHandshake(home: string, task: string, addr: string, env?: NodeJS.ProcessEnv, session?: string | null, expected?: {
    ref: string;
    launchId: string;
} | null): "bound" | "refused" | null;
declare const sayForeignWrite: typeof commonSayForeignWrite;
export { sayForeignWrite };
export declare function mcpDenyTools(tools: readonly HostMcpTool[]): string[];
/** Lift plan from harness-neutral context. Writes nothing and starts nothing: `--dry-run` prints
 * exactly this object and the real lift executes it, so print and deed cannot split. */
declare function prepare({ ref, role, mcp, prompt, model, effort, permissionMode, addDirs, pluginDir, selectedContext, mcpConfigPath, settingsPath, guardCommand, denyTools, extraSettings, sessionId, }: ClaudePrepareContext): ClaudeLaunchPlan;
declare function replaceMcpServers(plan: LibLaunchPlan, servers: Record<string, LibMcpServer>): void;
declare function optionRefusal(): null;
declare function shadowedUserServers(names: string[]): string[];
declare function inspect(ref: string, sessions?: unknown[] | null | undefined): SessionView | null;
declare function spawn(plan: LibLaunchPlan, { tool, ref, role, cwd, env, home, task, address, launchFailNote, deadNote, unboundNote, persist, awaitOptions, host, noun, requireFullSession, requireLaunchMatch }: LibSpawnContext): Promise<import("./liftoff.js").LaunchResult>;
declare function stop(ref: string, waitOptions?: {
    timeoutMs?: number;
    stepMs?: number;
} | undefined): Promise<{
    ok: boolean;
    stopped: boolean;
    note: string;
    attempted?: undefined;
} | {
    ok: boolean;
    stopped: boolean;
    attempted: boolean;
    note: string;
}>;
/** Claude Code driver — six optional capabilities including `approverLift`; see `capabilities` below. */
export declare const claudeDriver: {
    id: string;
    capabilities: {
        spawn: true;
        attach: false;
        activation: "push";
        inspect: true;
        stop: true;
        denyTools: true;
        mcpDenyTools: true;
        systemPrompt: true;
        sessionList: true;
        enter: true;
        approverLift: true;
    };
    options: {
        tool: string;
        readsVersion: true;
        effortLevels: string[];
        effortMinVersion: {};
        permissionModes: string[];
        defaultPermissionMode: string;
        defaultModel: string;
        modelAliases: {
            fable: string[];
            opus: string[];
            sonnet: string[];
            haiku: string[];
        };
        denyTools: string[];
        provenVersion: string;
        knockChannel: string;
        identityVar: string;
        mcpIdentity: null;
        envDrop: string[];
        skillsDir: true;
        selectedContext: true;
        launchDirs: never[];
    };
    phrases: {
        sessions: string;
        unreadable: string;
        enter: (id: string | null) => string;
        stop: (id: string | null) => string;
        logs: (id: string | null) => string;
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
    availability: import("./model-routing/adapter-common.js").RoutingAdapter;
    prepare: typeof prepare;
    replaceMcpServers: typeof replaceMcpServers;
    mcpDenyTools: typeof mcpDenyTools;
    spawn: typeof spawn;
    saidLiftoff: typeof sayLiftoff;
    inspect: typeof inspect;
    forgetSessions: typeof resetBgSessionsCache;
    stop: typeof stop;
    activate: (target: ActivationTarget, notification: Notification) => Promise<ActivateResult>;
    renderNotification: typeof renderNotification;
    stallRoute: typeof stallRoute;
    registerWake: typeof registerWake;
    bindHandshake: typeof bindHandshake;
    awaitsUser: typeof awaitsUser;
    sayForeignWrite: typeof commonSayForeignWrite;
    checkWake: typeof checkWake;
    sessionEnv: (base?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv) => {
        [x: string]: string | undefined;
    };
    optionRefusal: typeof optionRefusal;
    shadowedUserServers: typeof shadowedUserServers;
};

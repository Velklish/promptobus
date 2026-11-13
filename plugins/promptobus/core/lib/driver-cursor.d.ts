import { liftSession, stopSession } from './cursor-persist.js';
import { sayForeignWrite as commonSayForeignWrite } from './driver-common.js';
import type { Notification, NotificationMessage, SessionView, WakeProbe, ActivationTarget, ActivateResult } from '../dist/index.js';
import type { LibLaunchPlan, LibPrepareContext, LibSpawnContext, LibSpawnResult, LibStall, LibMcpServer, LibToolBin } from './driver-runtime.js';
type CursorPrepareContext = LibPrepareContext;
interface UtilityResult {
    ok: boolean;
    reason?: string;
    version?: string | null;
}
/** Harness name on the participant record and the key in the registry map. */
export declare const CURSOR = "cursor";
/** Name of the BINARY, and NOT the harness name — [02-host.md § Tool binaries](../docs/reference/02-host.md#tool-binaries).
 * One constant, two readers, so the name a host resolves and the name the adapter probes cannot drift. */
export declare const CURSOR_TOOL = "cursor-agent";
/** Project skills directory relative to project root: `.cursor/skills` —
 * [05-drivers.md § Cursor](../docs/reference/05-drivers.md#cursor-project-skills-location). */
export declare const CURSOR_SKILLS_REL: string;
export declare function findCursorBin({ env, home }?: {
    env?: NodeJS.ProcessEnv | undefined;
    home?: string | undefined;
}): {
    path: string;
} | null;
export declare function normalizeTool(tool: LibToolBin, { env }?: {
    env?: NodeJS.ProcessEnv | undefined;
}): LibToolBin;
export declare const EFFORT_LEVELS: string[];
export declare const PERMISSION_MODES: string[];
export declare const DEFAULT_PERMISSION_MODE = "force";
export declare const DEFAULT_MODEL = "composer-2.5";
export declare const REVIEWER_DENY: string[];
export declare const PROVEN_CURSOR_VERSION = "2026.09.02";
export declare const SESSION_ENV_DROP: string[];
/** Harness words for the adapter's human strings. `logs` is the only one that is not a command: the
 * transcript lives under the CHAT id, and entering the session ties the two more easily. */
export declare const PHRASES: {
    sessions: string;
    unreadable: string;
    enter: (id: string | null) => string;
    stop: (id: string | null) => string;
    logs: (id: string | null) => string;
    tool: (server: string, name: string) => string;
    mcpBoundary: string;
    reviewerCommands: {
        isolation: string;
        procedureSkip: string;
        record: string;
        gate: string;
    };
    promptRules: string;
    naming: string;
};
/** The Cursor skills canon at the workspace root — the only source, not `~/.cursor`: a person's
 * personal copies are not addressed to the participant. No directory means `null`. */
export declare function workspaceSkillsDir(root: string | null | undefined): string | null;
export declare function skillsNoteOf({ src, dest, count }: {
    src: string | null;
    dest: string;
    count: number;
}): string;
/** Reviewer sandbox: Cursor reads permissions, MCP and hooks from the WORKING directory, so a
 * reviewer in the clone would write three files into a foreign tree. Deterministic, not `mkdtemp`. */
export declare function reviewSandbox(settingsPath: unknown): string;
/** The build the list below was read from: the `_E` table of the `cursor-agent` `index.js` bundle,
 * on 2026-09-17 and with no live session. Not `PROVEN_CURSOR_VERSION` — that one dates a lift. */
export declare const HOOK_EVENTS_SOURCE_VERSION = "2026.09.10-fd3934a";
/** The names a live spike drove; the rest of the inventory is read from the bundle and never seen
 * firing here. A subset of `KNOWN_HOOK_EVENTS`, and the suite holds it to one. */
export declare const PROVEN_HOOK_EVENTS: string[];
/** Known Cursor hook event names — a list, for the gate. An unknown event SILENTLY kills the whole
 * hooks file, so a misspelled one would lose the loop guard and the wake channel without a sound. */
export declare const KNOWN_HOOK_EVENTS: string[];
/** Lift plan from harness-neutral context; writes and launches nothing. `--plugin-dir` is not in
 * argv — Cursor has its own plugin format, and the skills canon travels as `.cursor/skills` files. */
declare function prepare({ mcp, prompt, model, effort, permissionMode, addDirs, settingsPath, cwd, guardCommand, projectGuardCommand, denyTools, root, skillsRoot, selectedContext, ref, role, env, }: Omit<CursorPrepareContext, 'ref'> & {
    ref?: string | null;
}): LibLaunchPlan;
declare function replaceMcpServers(plan: LibLaunchPlan, servers: Record<string, LibMcpServer>): void;
/** Refuse without the utility needed by a [persist session](../docs/reference/05-drivers.md#cursor-the-persist-session). */
declare function optionRefusal(_options: unknown, _tool: unknown, { util }?: {
    util?: () => UtilityResult;
}): string | null;
declare function shadowedUserServers(names: string[]): string[];
/** Contact point of a Cursor participant: not a socket but "the session is alive and took a turn",
 * handed off by the HOOK at turn end. `socket` carries the ended-turn count, and this call owns it. */
export declare function registerWake(home: string, task: string, addr: string, env?: NodeJS.ProcessEnv, session?: string | null): false | import("../dist/sidecar.js").Wake | null;
declare const sayForeignWrite: typeof commonSayForeignWrite;
export { sayForeignWrite };
/** Channel smoke for `doctor`. The channel is a live persist session, handed off by the PARTICIPANT
 * session; the smoke does no real injection — that would cost a turn in somebody's chat. */
export declare function checkWake(env?: NodeJS.ProcessEnv): WakeProbe;
export declare function orderBody(task: string, addr: string, unread: number, msgs?: NotificationMessage[]): string;
export declare function renderNotification(n: Notification): string;
/** Wake a participant by injection into its live session. Three refusals, all honest outcomes. There
 * is no "turn is running" refusal: an injection queues in the TUI, and delivery to a queue is delivery. */
export declare function activate(target: ActivationTarget, notification: Notification): Promise<ActivateResult>;
/** State of one session for a snapshot. **The `stale` state appeared in Cursor**: a record with no
 * session on the server is lawful — stopped from outside, or a reboot, since state lives in `/tmp`. */
declare function inspect(ref: string): SessionView;
/** What a person should do with this stall, in Cursor commands; the shared line text stays with the
 * adapter. Attach is real here, and its cost is named: tmux shrinks to the narrowest client. */
export declare function stallRoute({ kind, address, repoAbs, task: _task, reviewCommand, doneCommand }: LibStall, id: string | null): string;
/** Participant lift: a registry record and a live persist session. The binary arrives as a resolved
 * path; the session name is learned AFTER start, and ours is found by hash, chat id and creation time. */
declare function spawn(plan: LibLaunchPlan, { tool, ref, role, cwd, env, host, home: runtimeHome, task: runtimeTask, address: runtimeAddress, launchFailNote, deadNote, persist, awaitOptions, }: LibSpawnContext): Promise<LibSpawnResult<Awaited<ReturnType<typeof liftSession>>>>;
/** Binary path as of NOW. Lift pins the version by resolving the symlink, but the binary updates
 * itself between turns and the old versioned directory vanishes, so stop resolves afresh. */
export declare function liveBin(recorded: string | null | undefined, { env }?: {
    env?: NodeJS.ProcessEnv | undefined;
}): string | null | undefined;
declare function saidLiftoff({ output }: Pick<LibSpawnResult, 'output'>): void;
/** Stop a session. **It returns AFTER the harness no longer HAS the session.** Reap covers two kinds
 * of process: tool children of a running turn, and the `worker-server` orphan that outlives a normal end. */
declare function stop(ref: string, waitOptions?: Parameters<typeof stopSession>[1]): Promise<{
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
/** Cursor driver. `attach: false` — no user attach to a foreign session; not to be confused with a
 * PERSON entering. `activation: 'push'` — text is injected into the live session, queueing if busy. */
export declare const cursorDriver: {
    id: string;
    capabilities: {
        spawn: true;
        attach: false;
        approverLift: true;
        activation: "push";
        inspect: true;
        stop: true;
        denyTools: true;
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
        utils: string[];
        skillsDir: false;
        selectedContext: true;
        launchDirs: string[];
    };
    phrases: {
        sessions: string;
        unreadable: string;
        enter: (id: string | null) => string;
        stop: (id: string | null) => string;
        logs: (id: string | null) => string;
        tool: (server: string, name: string) => string;
        mcpBoundary: string;
        reviewerCommands: {
            isolation: string;
            procedureSkip: string;
            record: string;
            gate: string;
        };
        promptRules: string;
        naming: string;
    };
    availability: import("./model-routing/adapter-common.js").RoutingAdapter;
    prepare: typeof prepare;
    replaceMcpServers: typeof replaceMcpServers;
    normalizeTool: typeof normalizeTool;
    spawn: typeof spawn;
    saidLiftoff: typeof saidLiftoff;
    inspect: typeof inspect;
    stop: typeof stop;
    activate: typeof activate;
    renderNotification: typeof renderNotification;
    stallRoute: typeof stallRoute;
    registerWake: typeof registerWake;
    sayForeignWrite: typeof commonSayForeignWrite;
    checkWake: typeof checkWake;
    sessionEnv: (base?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv) => {
        [x: string]: string | undefined;
    };
    optionRefusal: typeof optionRefusal;
    shadowedUserServers: typeof shadowedUserServers;
};

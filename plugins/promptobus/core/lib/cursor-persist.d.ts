import { run } from './exec.js';
import type { HarnessSessionRecord } from './harness-registry.js';
interface CursorSessionRecord extends HarnessSessionRecord {
    sessionName?: string | null;
    tmuxServer?: string;
    cwd?: string;
    chatId?: string | null;
    transcript?: string;
    panePid?: number | null;
    workspaceHash?: string | null;
}
interface TmuxSession {
    name: string;
    attached: number;
    created: number;
    panePid: number | null;
    managed: boolean;
    hash: string | null;
    chatId: string | null;
    task: string | null;
    address: string | null;
}
interface LiftSessionResult {
    ok: boolean;
    session: TmuxSession | null;
    paneStarted: boolean;
    launchPane: string;
    error?: string;
    failure?: unknown;
}
interface TmuxOptions {
    server?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Buffer | null;
}
interface ProcessReadResult {
    status: number | null;
    stdout: string | Buffer;
    stderr: string | Buffer;
    error?: Error | null;
    signal?: NodeJS.Signals | null;
}
interface McpConfig {
    mcpServers?: Record<string, {
        type?: string;
        command?: unknown;
        args?: unknown;
    } | null | undefined>;
}
type CursorRecord = CursorSessionRecord | null | undefined;
/** Environment variable that marks the session for process reap and contact-point handoff. */
export declare const SESSION_ENV_VAR = "PROMPTOBUS_CURSOR_SESSION";
/** Tmux server persist sessions live on. The name is `persist`'s own and is not changed: participants
 * share a server so a person needs `agent persist list` and nothing in the environment. */
export declare const CURSOR_TMUX_SERVER = "cursor-agent";
/** Server of one-shot pty provider panes. Its own, because a pane is lift machinery rather than a
 * participant session: it has no place in `agent persist list`. */
export declare const LAUNCH_TMUX_SERVER = "promptobus-launch";
/** `persist` lifts its server with `TMUX_TMPDIR=/tmp`, and talk with it must come from there: the
 * socket is looked up by that variable, whose default differs across systems. */
export declare const TMUX_TMPDIR = "/tmp";
/** Options `persist` stamps on its session. They are how it is recognised among others. */
export declare const CURSOR_SESSION_OPTS: string[];
/** Options the mechanism stamps on ITS sessions. The server is shared, so "stop everything found"
 * would take a person's own work: `inspect` and cleanup tell ours apart by these. */
export declare const TASK_OPT = "@promptobus_task";
export declare const ADDRESS_OPT = "@promptobus_address";
/** Pause between pasting text and `Enter`. Without it Enter is LOST and the text glues onto the next
 * message; measured, every run passed at 0.3–0.4 s, and this is the top of the measurement. */
export declare const ENTER_PAUSE_MS = 400;
/** How long we wait for the input field to empty: a broken case is the ceiling, a normal one is a tick or two. */
export declare const INPUT_WAIT_MS = 5000;
export declare const INPUT_STEP_MS = 100;
export declare const ENTER_SETTLE_MS = 400;
/** Ceiling of SILENCE in the transcript, not of a turn's total time — a real turn runs for minutes.
 * It kills nothing: the threshold gives `inspect` a verdict, and the decision stays with a person. */
export declare const TURN_IDLE_MS = 180000;
/** Window in which an injection counts as a started turn while the transcript is silent after it:
 * measured 3.09 and 8.03 s to the first line, and without it the warden would wake twice. */
export declare const INJECT_GRACE_MS = 20000;
/** How long we wait for the persist session to appear in the tmux list; measured 1.17–1.39 s. The
 * wait form is `{tries, delayMs}`, the same as the neighbouring driver's `awaitOptions`. */
export declare const LIFT_TRIES = 240;
export declare const LIFT_STEP_MS = 250;
/** How long we wait for the session to vanish after `persist stop`. Measurement of stop itself: 0.14–0.15 s. */
export declare const STOP_TIMEOUT_MS = 10000;
export declare const STOP_STEP_MS = 100;
/** Suite seam: the live silence threshold is measured in minutes and there is nothing to wait those
 * out in the suite. Read only here; unset in life, so the threshold stays live. */
export declare function turnIdleMs(env?: NodeJS.ProcessEnv): number;
/** Registry of OUR persist sessions. The shared registry owns the record format and the atomic
 * write; this file keeps only Cursor's tmux and buffer sidecars. */
export declare function cursorUserHome(env?: NodeJS.ProcessEnv): string;
export declare function lockFile(ref: string, env?: NodeJS.ProcessEnv): string;
export declare const cursorStateHome: (env?: NodeJS.ProcessEnv) => string;
export declare const sessionsDir: (env?: NodeJS.ProcessEnv) => string;
export declare const sessionKey: typeof import("./harness-registry.js").sessionKey;
export declare const sessionFile: (ref: string, env?: NodeJS.ProcessEnv) => string;
export declare const readSession: (ref: string, env?: NodeJS.ProcessEnv) => CursorSessionRecord | null;
export declare const writeSession: (record: CursorSessionRecord, env?: NodeJS.ProcessEnv) => {
    provenance: string;
} & Omit<CursorSessionRecord, "provenance">;
export declare const patchSession: (ref: string, patch: Partial<CursorSessionRecord>, env?: NodeJS.ProcessEnv) => ({
    provenance: string;
} & Omit<CursorSessionRecord, "provenance">) | null;
export declare const dropSession: (ref: string, env?: NodeJS.ProcessEnv) => void;
export declare const pidAlive: typeof import("./store.js").pidAlive;
export declare function injectionActivityFile(ref: string, env?: NodeJS.ProcessEnv): string;
/** Activity is separate from the native ownership record; a queued turn must not invalidate its proof. */
export declare function markInjected(record: CursorSessionRecord, env?: NodeJS.ProcessEnv): boolean;
export declare function sessionRevision(ref: string, env?: NodeJS.ProcessEnv): string | null;
/** How long a lock is considered live without its process: an injection takes a second, a broken
 * one about five, and a minute is ten times smaller than the participant silence threshold. */
export declare const LOCK_STALE_MS = 60000;
export declare const TMUX_NOT_FOUND: string;
export declare function binInDir(dir: string, bin: string): string | null;
export declare function searchPath({ env, home }?: {
    env?: NodeJS.ProcessEnv | undefined;
    home?: string | undefined;
}): {
    sep: string;
    dirs: string[];
};
/** The tmux every call runs, by absolute path, or `null`: the search the lift's check makes.
 * [reference/05-drivers.md#cursor-tmux-by-absolute-path](../docs/reference/05-drivers.md#cursor-tmux-by-absolute-path) */
export declare function tmuxBin({ env }?: {
    env?: NodeJS.ProcessEnv | undefined;
}): string | null;
/** Tmux call on the named server, with the caller's environment. `-f /dev/null`, the same flag
 * `persist` uses: a person's `~/.tmux.conf` would otherwise change what the mechanism pastes and reads. */
export declare function tmux(args: string[], { server, env, input }?: TmuxOptions): ProcessReadResult;
/** Server sessions, machine-readable, and `missing` when tmux could not be run, or exited
 * non-zero without a measured no-server line — a live server could still be behind that. */
export declare function readTmuxSessions({ server, env }?: {
    env?: NodeJS.ProcessEnv | undefined;
    server?: string | undefined;
}): {
    sessions: TmuxSession[];
    missing: null;
} | {
    sessions: null;
    missing: string;
};
/** Stop preflight yields while tmux runs, so another participant can issue its shutdown. */
export declare function readTmuxSessionsAsync({ server, env, timeoutMs, deadlineAt }?: {
    server?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    deadlineAt?: number;
}): Promise<{
    sessions: null;
    missing: string;
} | {
    sessions: TmuxSession[];
    missing: null;
}>;
/** The list alone, for the lift: a tmux that cannot run fails its `new-session` with the reason. */
export declare function tmuxSessions({ server, env }?: {
    env?: NodeJS.ProcessEnv | undefined;
    server?: string | undefined;
}): TmuxSession[];
/** One session by name, or `null` when the server does not have it. A tmux that could not be run
 * refuses instead: `null` there would read a live session as gone. */
export declare function findSession(name: string | null | undefined, { server, env }?: {
    env?: NodeJS.ProcessEnv | undefined;
    server?: string | undefined;
}): TmuxSession | null;
/** Working-directory hash `persist` stamps on its session — how ours is found among foreigners.
 * **The path is taken RESOLVED**: on macOS `$TMPDIR` is a symlink, and the hashes differ. */
export declare function workspaceHash(cwd: unknown): string;
/** What is visible in the pane now. Read for the input field and the running-turn label. */
export declare function capturePane(name: string, { server, env }?: {
    env?: NodeJS.ProcessEnv | undefined;
    server?: string | undefined;
}): string | null;
/** Text standing in the pane input field; an empty field is the prompt with no text. **The running-
 * turn label lives on the SAME line**, so unstripped it makes every running turn read as occupied. */
export declare function inputText(pane: unknown): string;
/** Pty provider pane script. The environment is materialised HERE: the pane inherits the tmux SERVER
 * environment, which a previous lift may have set. `env -u` guards a foreign `TMUX`. */
export declare function launchScript({ bin, argv, env }: {
    bin: string;
    argv: string[];
    env?: NodeJS.ProcessEnv;
}): string;
/** Lift a persist session. The binary chooses the name, so it is learned AFTER start; ours is
 * recognised by three marks at once — directory hash, non-empty chat id, and creation time. */
export declare function liftSession({ ref, bin, argv, cwd, env, launchEnv, task, address, tries, delayMs, acceptSession, expectedChatId, }: {
    ref: string;
    bin: string;
    argv: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    launchEnv?: NodeJS.ProcessEnv | null;
    task?: string | null;
    address?: string | null;
    tries?: number;
    delayMs?: number;
    acceptSession?: (session: TmuxSession) => Promise<boolean>;
    expectedChatId?: string;
}): Promise<LiftSessionResult>;
/** Deliver text into a live session, by the protocol the spike measured.
 * [reference/05-drivers.md#injecttext--deliver-text-into-a-live-session](../docs/reference/05-drivers.md#injecttext--deliver-text-into-a-live-session) */
export declare function injectText(record: CursorRecord, text: string, { env, pauseMs }?: {
    env?: NodeJS.ProcessEnv | undefined;
    pauseMs?: number | undefined;
}): Promise<{
    ok: boolean;
    error?: undefined;
} | {
    ok: boolean;
    error: string;
}>;
/** The chat transcript is the only machine source about a turn under persist. The mechanism does NOT
 * compute its path slug — Cursor truncates and hashes — so it is found by chat id once and recorded. */
export declare function findTranscript(chatId: string | null | undefined, env?: NodeJS.ProcessEnv): string | null;
/** Transcript path of a record: from the record, and on first find — into the record. */
export declare function transcriptOf(record: CursorRecord, env?: NodeJS.ProcessEnv): string | null;
/** What the transcript says about the turn, read from the ORDER of lines. **`turn_ended` is an
 * end-of-FILE marker, not an event**: it cannot count turns, so only "running or not" is taken. */
export declare function readTranscript(file: string): {
    busy: boolean;
    ended: number;
    status: unknown;
    touchedAt: number | null;
} | null;
/** Whether a session turn is running, and whether it has been silent past the threshold. An injection
 * counts as a turn before the transcript says so, or the warden would wake twice on one unread. */
export declare function turnState(record: CursorRecord, env?: NodeJS.ProcessEnv): {
    busy: boolean;
    ended: number;
    status: {} | null;
    transcript: string | null;
    silentMs: number | null;
    silent: boolean;
};
/** Bus needle beside `worker-server`, not read from `.cursor/mcp.json`: a refusal to read that file
 * would leave needles empty, and `promptobus mcp` would count as a tool, so nothing ever stalls. */
export declare const BUS_MCP_NEEDLE = "promptobus mcp";
/** Command-line needles of stdio servers from the participant project MCP. */
export declare function mcpRuntimeNeedles(mcp: McpConfig | null | undefined): string[];
export declare function readParticipantMcp(record: CursorRecord): McpConfig | null;
export declare function isRuntimeCmd(cmd: unknown, needles?: string[]): boolean;
/** Instrumental descendants of the pane process — a sign of turn life wider than transcript silence.
 * The runtime subtree is not descended into: a descent would leave kids non-empty forever. */
export declare function toolKidsOf(pid: unknown, { ps, needles }?: {
    ps?: typeof run;
    needles?: string[];
}): number[];
/** How many changed files are stat'ed. A repository handing back thousands gets the newest of the
 * first `TOUCH_SCAN_MAX`, which can only make the signal older — and it only ever lifts a verdict. */
export declare const TOUCH_SCAN_MAX = 500;
/** How long since the participant last WROTE in its own tree, in milliseconds.
 * [reference/05-drivers.md#worktreetouchedms--the-third-liveness-signal-and-what-the-first-two-miss](../docs/reference/05-drivers.md#worktreetouchedms--the-third-liveness-signal-and-what-the-first-two-miss) */
export declare function worktreeTouchedMs(record: CursorRecord, { exec, now }?: {
    exec?: typeof run | undefined;
    now?: (() => number) | undefined;
}): number | null;
/** A stall is silence AND no instrumental descendants AND no recent write in the working tree —
 * three signals because each covers a phase the others do not see. `null` decides nothing. */
export declare function silentIsStall(turn: {
    silent?: boolean;
} | null | undefined, kids: number[] | null | undefined, touchedMs?: number | null, env?: NodeJS.ProcessEnv): boolean;
/** Session mark in the environment of its processes. Computed from the ref, not taken from the
 * record: by cleanup time there is already no record of the turn. */
export declare function sessionMarker(record: CursorRecord, env?: NodeJS.ProcessEnv): string | null;
/** Orphaned `worker-server`, recognised by TWO marks at once — the subcommand name and the session
 * mark in the environment. It outlives a NORMAL end of turn: measured alive 11 minutes after one. */
export declare function reapOrphans(marker: string | null | undefined, { ps }?: {
    ps?: typeof run | undefined;
}): number[];
/** TOOL children of a running turn: `agent persist stop` takes the pane down in 0.14 s and leaves
 * them alive. Found by the tree from the pane process, not by a mark — a tool builds its own environment. */
export declare function treeOf(pid: unknown, { ps }?: {
    ps?: typeof run | undefined;
}): number[];
/** Kill the named processes. Died itself between listing and signal — a lawful outcome. */
export declare function killPids(pids: number[] | null | undefined): number[];
/** Stop a persist session. **It returns AFTER the harness no longer HAS the session**: cleanup
 * follows stop, and an earlier return would leave the worktree in place. */
export declare function stopSession(record: CursorRecord, { env, bin, timeoutMs, stepMs, }?: {
    env?: NodeJS.ProcessEnv;
    bin?: string | null;
    timeoutMs?: number;
    stepMs?: number;
}): Promise<{
    stopped: boolean;
    missing: string;
    orphans: never[];
    kids: never[];
} | {
    stopped: boolean;
    missing: null;
    orphans: number[];
    kids: never[];
    said?: undefined;
} | {
    stopped: boolean;
    missing: null;
    said: string | null;
    orphans: number[];
    kids: number[];
}>;
export {};

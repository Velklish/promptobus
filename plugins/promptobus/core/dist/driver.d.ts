import type { ORCHESTRATOR, REVIEWER, WORKER } from './registry.js';
import type { HostMcpTool, HostToolBin, PreparedHostParticipantContextSelection, PromptobusHost } from './host.js';
import type { AvailabilityAdapter } from './model-routing.js';
import type { ParticipantMode, ParticipantV1, TaskV1 } from './v1/model.js';
/** How the participant is activated: the driver wakes the session itself (push) or the session polls (pull). */
export type Activation = 'push' | 'pull';
/** What the driver can do; the snapshot is stored in the participant record. Eleven flags in two
 * kinds: five declare OPERATIONS with a same-named method, six declare harness PROPERTIES. */
export interface DriverCapabilities {
    spawn: boolean;
    attach: boolean;
    activation: Activation;
    inspect: boolean;
    stop: boolean;
    /** Whether the harness can deny the session tools. Without it a read-only participant does not
     * exist, and `review` must refuse BEFORE launch rather than edit the code under review. */
    denyTools?: boolean;
    /** Whether the harness can mechanically deny canonical MCP write tools for a reviewer or
     * approver. Absent means MCP writes stay prompt-only for that harness. */
    mcpDenyTools?: boolean;
    /** Whether the harness takes its settings file or a system prompt for a single launch. Only the
     * capabilities SNAPSHOT reads it — a driver without one will not launch a participant at all. */
    systemPrompt?: boolean;
    /** Whether the harness has a session registry. Without it session state is unknown, not death.
     * The flag names the REASON for that unknown, rather than leaving a silent absent operation. */
    sessionList?: boolean;
    /** Whether a person can ENTER the session from a terminal. `attach` in the contract is taken by
     * the participant mode, so human entry is `enter` (glossary); the stall route is its branch. */
    enter?: boolean;
    /** Whether `review --approver` may lift on this harness. */
    approverLift?: boolean;
}
export type { ParticipantMode } from './v1/model.js';
/** Session state in the snapshot: `alive`, `stale`, `gone` — and `unknown`, which is about the
 * OBSERVER, not the session. No consumer treats unknown as death. */
export type SessionState = 'alive' | 'stale' | 'gone' | 'unknown';
/** Reservation observation; unknown retains capacity. */
export type ReservationState = 'alive' | 'dead' | 'unknown';
export interface ReservationLookup {
    ref: string;
    registryHome: string;
}
/** Retirement requires fresh proof matching this launch generation and process birth. */
export interface UnstartedReservation extends ReservationLookup {
    home: string;
    task: string;
    address: string;
    launchId: string;
    owner: {
        pid: number;
        birth: string;
    };
}
/** A harness refusal that names a time to retry after: the harness's words for that time, and the
 * instant they parse to — `null` when they do not. [05-drivers.md § A refusal that names a reset](../docs/reference/05-drivers.md#a-refusal-that-names-a-reset) */
export interface NamedReset {
    said: string;
    at: string | null;
}
/** Session stall as the driver named it: `kind` chooses the route, `reason` — words for a person. */
export interface SessionStall {
    kind: string;
    reason: string;
    /** Present only when the refusal named a time to retry after; the warden holds its knocks on it. */
    reset?: NamedReset;
}
/** The retry time a refusal names, or `null` when it names none. Harness-neutral: one fact, not a taxonomy.
 * `seen` is when the harness wrote the line: a wall time in a named zone means its next occurrence after that. */
export declare function namedReset(text: unknown, seen?: number | null): NamedReset | null;
/** Whether a named reset still stands at `now`. A time that did not parse stands until the refusal clears. */
export declare function resetAhead(reset: NamedReset | null | undefined, now?: number): boolean;
/** The reset time for a person: the instant, or the harness's words marked as unread. */
export declare function resetText(reset: NamedReset): string;
/** What the driver knows about one session right now. */
export interface SessionView {
    state: SessionState;
    /** Whether the session is busy with a turn. The driver does not know — `false`: unknown is not treated as busy. */
    busy: boolean;
    stall: SessionStall | null;
    /** Session identifier for the adapter's human routes. */
    id: string | null;
    /** The harness word about the state, for the adapter's human line. Core neither reads it nor
     * decides from it: each harness has its own vocabulary, and showing it is still possible. */
    note?: string | null;
}
/** Snapshot of participant sessions, keyed by ADDRESS as health and contact points are. `null` means
 * no state at all — NOT "everyone is alive"; a participant with no session reference is not listed. */
export type SessionSnapshot = Record<string, SessionView> | null;
/** Harness-neutral MCP descriptor: how the participant reaches the bus and the other servers. The
 * driver translates it into its own config and arguments. */
export interface McpDescriptor {
    address: string;
    task: string;
    home: string;
    servers: Record<string, unknown>;
}
/** A driver deny rule: plain harness ids, or structured MCP rules kept until prepare. */
export type DriverDenyTool = string | HostMcpTool;
/** Launch context: everything the driver needs and nothing about its harness. The consumer names the
 * SUBJECT; only the driver knows how that looks for the harness. */
export interface SpawnContext {
    /** Opaque session reference the driver later uses to recognise the session. */
    ref: string;
    address: string;
    task: string;
    home: string;
    mcp: McpDescriptor;
    prompt: string;
    cwd: string;
    /** Participant role — launch refusal wording depends on it. */
    role?: string;
    model?: string;
    effort?: string | null;
    permissionMode?: string | null;
    /** Directories outside `cwd` that the participant may read. */
    addDirs?: string[];
    /** Exact read-only files outside the reviewed tree; parents are not granted. */
    readFiles?: string[];
    /** Review procedure directories and their shared references. */
    readSkillDirs?: string[];
    /** Selected native content layout; undefined keeps root, null disables it. */
    skillsRoot?: string | null;
    /** Admitted per-task inventory; whole skills containers are disabled when present. */
    selectedContext?: PreparedHostParticipantContextSelection | null;
    /** Directory with workspace skills for one session. */
    pluginDir?: string | null;
    /** Where the driver puts its MCP config and its settings file. */
    mcpConfigPath?: string;
    settingsPath?: string;
    /** Loop-guard command: the driver wraps it in its own hook form. */
    guardCommand?: string;
    /** Tools taken from the participant (requires the `denyTools` capability). */
    denyTools?: DriverDenyTool[] | null;
    /** Workspace settings addressed to the participant: the driver puts them in its file. */
    extraSettings?: Record<string, unknown>;
    /** The environment the lift will pass. */
    env?: Record<string, string | undefined>;
    /** The rest is the consumer's business: the driver reads only what the contract named. */
    [key: string]: unknown;
}
/** A file the driver asks to place next to the session before launch. */
export interface LaunchFile {
    path: string;
    text: string;
    /** The file holds a secret (tokens) — write it with `0600` permissions. */
    secret: boolean;
    /** Index content of a tracked path the text was merged from: the write sets `skip-worktree` on it. */
    tracked?: string;
    copyFrom?: string;
    copyFileFrom?: string;
    clearDirectory?: boolean;
    /** Retain this child only after the driver's verifier accepts it before writes. */
    preserveDirectory?: string;
    selectedContext?: PreparedHostParticipantContextSelection;
    selectedPaths?: string[];
}
/** Launch plan: the harness-neutral context as argv, configs and files. Assembled by ONE `prepare`
 * call, and the same object goes into `spawn`, so print and deed cannot diverge. */
export interface LaunchPlan {
    /** Launch arguments, excluding a prompt delivered through a non-positional channel. */
    argv: string[];
    /** Assignment text when the harness does not take it as a positional argument; such a driver
     * delivers it itself, for example through a `turn/start` request. */
    prompt?: string;
    /** Descriptive command line for `--dry-run` when `argv` alone is not runnable. Absent — the
     * consumer prints `<tool> <argv without the last element> <prompt>`. */
    dryRunCommand?: string;
    /** MCP config in the harness form: `--dry-run` reads it and the consumer writes it to disk. */
    mcpConfig: unknown;
    /** Settings file in the harness form. */
    settings: unknown;
    /** What will go to disk before launch. Order matters: the driver writes them in that order. */
    files: LaunchFile[];
    /** Session working directory when the driver chose NOT the one the caller named — needed where a
     * harness reads settings from its working directory, or configs would land in a foreign tree. */
    cwd?: string;
}
export interface ReviewerCommandPhrases {
    isolation: string;
    procedureSkip: string;
    record: string;
    gate: string;
}
/** Harness words the adapter inserts into its lines. Shared text stays with the adapter; the
 * harness-specific command comes from here, or every printer would know the enter command. */
export interface DriverPhrases {
    /** Where a person sees their sessions — the command as they would type it. */
    sessions: string;
    /** Session list could not be parsed: that is what the harness calls it. */
    unreadable: string;
    /** Enter the session from a terminal (`enter` capability). */
    enter(id: string): string;
    /** Stop the session by a person's hand. */
    stop(id: string): string;
    /** View the session journal. */
    logs(id: string): string;
    /** How THIS harness names an MCP server tool. The host is passed because for one harness the
     * spelling carries the consumer's identity; a driver that does not depend on it ignores it. */
    tool(server: string, name: string, host: PromptobusHost): string;
    /** The reviewer's MCP boundary in this harness's own measured vocabulary. */
    mcpBoundary: string;
    /** What a reviewer may run to read files, and how the prompt names skipped checks. */
    reviewerCommands: ReviewerCommandPhrases;
    /** Rules of THIS harness appended to the participant prompt — its headless habits. Empty means
     * nothing to append, and the prompt stays exactly what the caller assembled. */
    promptRules: string;
    /** A role-specific tail, when this harness distinguishes executable roles from reviewers. */
    promptRulesFor?(role: typeof WORKER | typeof REVIEWER | typeof ORCHESTRATOR): string;
    /** Task owner description; absent preserves the native worker prompt's established wording. */
    workerOrchestrator?: string;
    /** Preamble for the managed root owner supported by this driver. */
    rootPreamble?(context: {
        task: string;
        root: string;
    }): string;
    /** What this harness calls the session when the mechanism does not choose the name: `--dry-run`
     * prints this, because a name the binary invents at start cannot be printed in advance. */
    naming?: string;
}
/** A session record the harness puts in its participant MCP server's environment. */
export interface McpIdentityRecord {
    /** Environment variable carrying the absolute record path. */
    recordVar: string;
    /** Record field carrying the harness session id stored on the participant. */
    idField: string;
}
/** Allowed option values and harness versions. The consumer does not know them and has no right to:
 * effort levels, permission modes and deniable tools are harness vocabulary, not the bus. */
export interface DriverOptions {
    /** Harness binary name: the adapter resolves its path by it. It matches the driver `id` by fact
     * rather than by rule — a registry key and an executable name are different subjects. */
    tool: string;
    /** Allowed effort values. */
    effortLevels: string[];
    /** Minimum harness version per effort level — where the value does not arrive with every version. */
    effortMinVersion?: Record<string, string>;
    /** Allowed permission modes and the one taken without a flag. */
    permissionModes: string[];
    defaultPermissionMode: string;
    /** Model the participant is launched with when there is no `--model` flag. The home is the driver:
     * one binary's default is refused by another as any unknown id. */
    defaultModel: string;
    /** Model alias the harness publishes → the full ids it resolves to today. The driver is the only
     * holder of this answer, since an alias points wherever the vendor moved it. */
    modelAliases?: Record<string, string[]>;
    /** Whether the harness takes the workspace skills directory for one session. Not declared means
     * "does not take", and the output says so rather than promising skills never received. */
    skillsDir?: boolean;
    /** Whether prepare materializes only the supplied selected context. */
    selectedContext?: boolean;
    /** Directories inside the participant's working directory this driver's launch files claim.
     * [reference/05-drivers.md#launch-directories-a-driver-claims](../docs/reference/05-drivers.md#launch-directories-a-driver-claims) */
    launchDirs?: string[];
    /** Tools taken from a read-only participant (`denyTools` capability). */
    denyTools: string[];
    /** Harness version on which the wake channel was proven. Not a gate — evidence. */
    provenVersion: string;
    /** The floor and the effort refusal need the binary's version. The preflight and a real lift
     * ask `readToolVersion` only when this is set. */
    readsVersion?: boolean;
    /** How the driver wakes the session: `socket`, `turn`, or `inject`. Not cosmetic — the suite's
     * stand-in channel substitutes delivery only where it truly is a socket. */
    knockChannel: string;
    /** Variable carrying the harness's OWN session id in a process it starts, or `null`. It answers
     * for a command the session runs, not for an MCP server child. See 02-host.md and ADR-019. */
    identityVar: string | null;
    /** Record proof for an MCP child, accepted only when home, task and address match. See 02-host.md and ADR-019. */
    mcpIdentity: McpIdentityRecord | null;
    /** Ancestor variables that must not reach the session. */
    envDrop: string[];
    /** Workspace utilities without which the driver will not launch: NAMES, not paths — resolve,
     * minimum version and refusal wording are the consumer's. Not declared means none. */
    utils?: string[];
}
/** What the wake-channel smoke saw. `endpoint === null` — the session does not hand one over at all. */
export interface WakeProbe {
    endpoint: string | null;
    ok: boolean;
    /** Reason in the harness words: what exactly is missing or what the socket answered. */
    error: string | null;
}
/** Where to knock: the participant opaque ref and the contact point it handed into the store. */
export interface ActivationTarget {
    ref: string | null;
    endpoint: {
        socket?: string | null;
        token?: string | null;
    } | null;
}
/** Message extract for a notification: what the driver builds its text from. */
export interface NotificationMessage {
    id: string | null;
    type: string;
    from: string;
    ts: string;
    body: string;
    artifact: string | null;
    /** A line of the bus's own, not a mailbox message: it rides whole on the postcard when it fits. */
    bus?: true;
}
/** A participant from whom there is nothing to wait for — as stall analysis named it. */
export interface StalledParticipant {
    address: string;
    /** Opaque session reference of the participant record. */
    ref: string | null;
    id: string | null;
    repoAbs: string | null;
    kind: string;
    reason: string;
    reset?: NamedReset;
    /** The record harness as it named it: the consumer needs it to ask the ROUTE of the same driver
     * that parsed the state. Absent from the record — `null`, and the registry `fallback` is taken. */
    harness: string | null;
}
/** Notification: what core asks to deliver. There is no text here on purpose — the driver renders it,
 * because the frame and the words belong to the harness channel, not the bus. */
export type Notification = {
    kind: 'unread';
    task: string;
    address: string;
    unread: number;
    messages: NotificationMessage[];
};
/** Stop outcome. Two flags, not one: `ok` says the operation did not refuse, `stopped` that a session
 * was actually stopped — nothing to stop is success. A deferred self-Stop is accepted but not confirmed. */
export interface StopResult {
    ok: boolean;
    /** Native Stop confirms terminal command accounting before retiring its owned launch.
     * Missing command outcomes remain unresolved even when an interrupt was acknowledged. */
    stopped: boolean;
    note: string;
    /** The driver ISSUED the stop and could not confirm the session vanished. Without this flag
     * `stopped: false` would also mean "there was no session", and cleanup leaves the directory. */
    attempted?: boolean;
    deferred?: boolean;
}
/** Activation outcome. This does not give a “delivered” flag — that one is the mailbox having been taken. */
export interface ActivateResult {
    ok: boolean;
    error?: string | null;
}
/** Harness driver. The operations declared in capabilities are the ones implemented. */
export interface Driver {
    readonly id: string;
    readonly capabilities: DriverCapabilities;
    /** Harness vocabulary. Required, not "if present": the CLI takes values from it at module top
     * level, so an optional field would turn a missing driver vocabulary into a crash on `--version`. */
    readonly options: DriverOptions;
    /** Harness strings for the adapter's human routes. Required for the same reason. */
    readonly phrases: DriverPhrases;
    /** Optional pre-launch binary normalization; absence keeps the host result unchanged. */
    normalizeTool?(tool: HostToolBin, context?: {
        env?: Record<string, string | undefined>;
    }): HostToolBin;
    /** Translate the harness-neutral context into its launch plan. Writes nothing and starts nothing:
     * `--dry-run` prints exactly what `spawn` will execute. */
    prepare?(context: SpawnContext): LaunchPlan;
    /** Translate canonical host MCP write-tool identities into this harness's deny rules. */
    mcpDenyTools?(tools: readonly HostMcpTool[]): DriverDenyTool[];
    spawn?(plan: LaunchPlan, runtime: SpawnContext): Promise<unknown>;
    attach?(plan: LaunchPlan, runtime: SpawnContext): Promise<unknown>;
    /** What was said about the launch after success: unconfirmed check, unparsed id. */
    saidLiftoff?(result: unknown): void;
    inspect?(ref: string): SessionView | null;
    /** Side-effect-free fresh observation. Missing hooks use the strict generic fallback. */
    reservationState?(request: ReservationLookup): ReservationState;
    /** Retire only the current proven unstarted record; false or failure retains the reservation. */
    retireUnstarted?(request: UnstartedReservation): boolean;
    /** Validate an inactive retained managed owner before native thread resumption. */
    resumeState?(ref: string, context: {
        home: string;
        cwd: string;
        task: string;
        address: string;
        threadId: string;
        launcherPid?: number;
        env?: Record<string, string | undefined>;
    }): {
        threadId: string;
        sandbox: string;
    };
    /** Refuse live unbound roots and remove dead unbound state before a new root launch. */
    prepareRootLaunch?(context: {
        home: string;
        task: string;
        env?: Record<string, string | undefined>;
    }): void;
    /** Remove the harness state of one closed participant that does NOT live in its worktree — the
     * one leak with no other cleanup path, and it may hold credentials. Must not throw. */
    sweepParticipant?(participant: unknown, taskId: string): unknown;
    /** Forget the remembered session list: after launch and stop it is stale. */
    forgetSessions?(): void;
    activate?(target: ActivationTarget, notification: Notification): Promise<ActivateResult> | ActivateResult;
    /** Notification text into this harness channel. Inside `activate`; outward — for the seam. */
    renderNotification?(notification: Notification): string;
    /** What a person should do with this stall, in their harness commands. The shared state words stay
     * with the adapter: they are one for all harnesses. */
    stallRoute?(stall: StalledParticipant & {
        task?: string | null;
    }, id: string | null, ref: string | null): string;
    /** Hand the contact point of ITS OWN session into the task store: only the harness knows the socket address.
     * The written point; `false` when the binding gate refused it or the write failed; `null` when there was nothing to hand over. */
    registerWake?(home: string, task: string, address: string, env?: unknown, session?: string | null): unknown;
    /** Bind the participant record to this session at its MCP handshake through the lift's session-record
     * pointer, before the binding gate: `bound`, `refused` or `null`. 02-host § Session identity. */
    bindHandshake?(home: string, task: string, address: string, env?: unknown, session?: string | null): unknown;
    /** Whether the session transcript at this path holds a question to the user still unanswered.
     * Positive evidence only: anything unread or unrecognised is `false`. */
    awaitsUser?(transcript: string): boolean;
    /** Tell the supervisor journal that a write for a foreign address did not go through. */
    sayForeignWrite?(home: string, task: string, address: string, held: string, session: string | null, what: string): void;
    /** Wake-channel smoke for diagnostics: whether a socket was handed over and whether it accepts a connection. */
    checkWake?(env?: unknown): Promise<WakeProbe>;
    /** Environment of the session being launched: the caller's `extra` over the inherited one, with
     * ancestor leaks stripped. The second argument carries a lever the mechanism itself sets. */
    sessionEnv?(base: unknown, extra?: Record<string, string>): Record<string, string | undefined>;
    /** Refusal by harness version for the requested options, before the first write to disk. `null`
     * means nothing to refuse for: the version is fine, or it was not read and may not be claimed. */
    optionRefusal?(options: {
        effort?: string | null;
    }, tool: unknown): string | null;
    /** Throws GateError naming a foreign project file before the first write of this lift. The selected
     * binary is passed at lift, a plan passes none; `guardCommand` is the lift's guard, never trusted. */
    refuseForeignProjectLayer?(lookupDir: string, writtenDir: string, tool?: HostToolBin | null, guardCommand?: string | null): void;
    /** Names of delivered MCP servers shadowed by a person's PERSONAL records. Personal config is a
     * harness property; the output line about shadowing is one for all. */
    shadowedUserServers?(names: string[]): string[];
    /** Stop the session. **It returns when the harness already has NO session**, or with an honest
     * `stopped: false` and a reason — cleanup follows the stop. The outcome may be a promise. */
    stop?(ref: string): StopResult | Promise<StopResult>;
    /** Accept an owned self-Stop for later confirmation without waiting on its caller. */
    stopSelf?(ref: string): StopResult | Promise<StopResult>;
    /** Availability adapter of this harness: what the ACCOUNT can do, asked before any session exists.
     * Its absence is a state, not an error — the registry answers `unknown` / `probe_failed`. */
    readonly availability?: AvailabilityAdapter;
}
/** `harness → driver` map, assembled by the consumer and passed in: core neither creates nor looks up
 * drivers. `fallback` is for a record with NO `harness` field; a non-empty unknown name refuses. */
export interface Registry {
    readonly drivers: Readonly<Record<string, Driver>>;
    readonly fallback: string | null;
}
export declare function createRegistry({ drivers, fallback }: {
    drivers: Record<string, Driver>;
    fallback?: string | null;
}): Registry;
/** Harness name of the record. Field absent entirely — the registry `fallback` is taken (a former-CLI record). */
export declare function harnessOf(participant: ParticipantV1 | null | undefined, registry: Registry): string | null;
/** Driver by harness name. Unknown — refusal, and the refusal is BEFORE any store write. */
export declare function driverFor<D>(registry: {
    readonly drivers: Readonly<Record<string, D>>;
}, harness: string | null | undefined): D;
/** Whether the driver can do what is asked. Asked BEFORE the store changes: a declared capability
 * without an operation is the same refusal as an undeclared one. */
export declare function requireCapability(driver: Driver, op: 'spawn' | 'attach' | 'inspect' | 'stop'): void;
/** Harness properties without their own operation: asked by the flag, not by method presence. */
export type DriverFeature = 'denyTools' | 'mcpDenyTools' | 'systemPrompt' | 'sessionList' | 'enter' | 'approverLift';
/** Whether the driver declared a harness property. Such flags have no operation, so an undeclared one
 * is read as "no" — the silent "it probably can" is what the flag exists against. */
export declare function hasFeature(driver: Driver, feature: DriverFeature): boolean;
/** Whether the driver wakes on its own. A pull-driver does not wake the session — it organises its own polling. */
export declare function pushes(driver: Driver): boolean;
/** Opaque session reference of the participant record. Former-CLI records carried it in `name`;
 * migration gave them a field of their own, and v1 has no second source. */
export declare function sessionRefOf(participant: ParticipantV1 | null | undefined): string | null;
/** Write a participant the driver launched or attached to. The registry is asked FIRST: a refusal
 * after the write would leave a participant in the journal with nothing to wake it by. */
export declare function openParticipant(home: string, task: string, participant: ParticipantV1, registry: Registry, { mode, assignment }?: {
    assignment?: boolean | undefined;
    mode?: ParticipantMode | undefined;
}): {
    driver: Driver;
    meta: TaskV1;
    record: ParticipantV1;
};
/** Participant mode. Absent entirely means `managed` — the former CLI left spawn records. A
 * participant with no session reference has no mode: nobody launched a session behind it. */
export declare function modeOf(participant: ParticipantV1 | null | undefined): ParticipantMode | null;
/** Whether the driver owns this session: it launched it — it is the one to stop it. */
export declare function isManaged(participant: ParticipantV1 | null | undefined): boolean;
/** Stop a participant session — a driver operation, not a command. Only `managed` may be stopped, and
 * the refusal is explicit; the outcome is awaited, since the driver may wait for the harness. */
export declare function stopParticipant(participant: ParticipantV1, registry: Registry, options?: {
    deferSelf?: boolean;
}): Promise<StopResult>;
/** Driver fields in the participant record: harness, mode and the capabilities snapshot. */
export declare function participantDriverFields(driver: Driver, { mode, ref }: {
    mode: ParticipantMode;
    ref: string;
}): {
    harness: string;
    mode: ParticipantMode;
    sessionRef: string;
    capabilities: DriverCapabilities;
};
/** Snapshot of participant sessions, taken once per heartbeat. One unparsed session drops the whole
 * snapshot; one INVALID record does not — it gets `unknown`, and the walk goes on. */
export declare function snapshotSessions(participants: ParticipantV1[] | null | undefined, registry: Registry): SessionSnapshot;
export * from './model-routing.js';

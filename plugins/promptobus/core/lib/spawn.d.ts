import { runLogged } from './util.js';
import { contactsOf, retitleTask } from './store.js';
import { routeLift } from './models.js';
import { prepareNativeContext } from './native-participant-context.js';
import type { PromptobusHost, TaskV1, ParticipantV1, RoleRegistry, LaunchFile, HostModuleNote, SessionSnapshot } from '../dist/index.js';
import type { LibDriver, LibLaunchPlan, LibToolBin } from './driver-runtime.js';
import type { CodexDriver } from './drivers.js';
type Selection = ReturnType<typeof prepareNativeContext>;
type Routed = NonNullable<Awaited<ReturnType<typeof routeLift>>>;
type Contacts = ReturnType<typeof contactsOf>;
type TaskIdentity = Pick<TaskV1, 'id'> & Partial<Pick<TaskV1, 'adapter'>>;
type TaskName = TaskIdentity & Pick<TaskV1, 'title'>;
interface SpawnMetadata {
    childTask?: string;
    sessionId?: string;
    owner?: string;
    model?: string;
    effort?: string;
    name?: string;
    repo?: string;
    worktreeName?: string;
    worktree?: string;
    baseSha?: string;
    title?: string;
    nativeLaunchId?: string;
}
type SpawnParticipant = Omit<ParticipantV1, 'metadata'> & {
    metadata: ParticipantV1['metadata'] & SpawnMetadata;
};
export interface SpawnOptions extends NonNullable<Parameters<typeof prepareNativeContext>[1]['options']> {
    repo?: string;
    brief?: string;
    task?: string;
    newTask?: boolean;
    title?: string;
    taskTitle?: string;
    worker?: string;
    slug?: string;
    harness?: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
    strategy?: string;
    allowPayg?: boolean;
    refresh?: boolean;
    dryRun?: boolean;
    teamlead?: boolean;
    tool?: LibToolBin;
    sessions?: SessionSnapshot;
    adapterFor?: NonNullable<Parameters<typeof routeLift>[1]>['adapterFor'];
    awaitOptions?: {
        tries?: number;
        delayMs?: number;
    };
    fault?: ((point: string) => void) | null;
}
export interface RepoSkillsState {
    kind: 'planned' | 'invalid' | 'none' | 'ok' | 'failed' | 'kept';
    argv: string[] | null;
    why?: string | null;
    ms?: number;
    code?: number | null;
    logPath?: string | null;
    dirt?: string[] | null;
    missingDeps?: 'refused' | 'absent' | null;
}
export interface WorktreeDepsState {
    ran?: boolean;
    repeat?: boolean;
    planned?: boolean;
    kind?: string;
    ok?: boolean;
    ms?: number;
    why?: string | null;
    command?: string;
    logPath?: string;
    ignored?: boolean | null;
}
interface McpNote {
    level: string;
    text: string;
}
interface Retitle extends NonNullable<Parameters<typeof retitleTask>[2]> {
    preview?: string;
}
interface NewTask extends Pick<TaskV1, 'id' | 'title' | 'status' | 'adapter' | 'participants'> {
}
export interface TeamleadPlan {
    host: PromptobusHost;
    home: string;
    root: string;
    rootTask: string;
    childTask: string;
    rootMeta: TaskV1;
    childMeta: TaskV1 | null;
    address: string;
    slug: string;
    title: string;
    brief: string;
    former: SpawnParticipant | null;
    pendingRebind: boolean;
    selectedContext: Selection;
    driver: LibDriver;
    name: string;
    model: string;
    effort: string | null;
    permissionMode: string | null;
    rules: string[];
    ruleDirs: string[];
    pluginDir: string | null;
    env: NodeJS.ProcessEnv;
    commonEnv: NodeJS.ProcessEnv;
    mcpConfigPath: string;
    settingsPath: string;
    guardCommand: string;
    mcpNote: McpNote;
    launch: LibLaunchPlan;
    prompt: string;
    routing: Routed['metadata'] | null;
    decision: Routed['decision'] | null;
    routingSkipped: string | null;
    briefStem: string;
    taskId: string;
}
export interface SpawnPlan {
    host: PromptobusHost;
    home: string;
    taskId: string;
    createNew: NewTask | null;
    participant: ParticipantV1 | null;
    slug: string;
    address: string;
    ownerName: string;
    nsPath: string;
    repoAbs: string;
    via: string;
    brief: string;
    selectedContext: Selection;
    name: string;
    workTitle: string;
    wtName: string;
    worktreePath: string;
    branch: string;
    base: string;
    model: string;
    effort: string | null;
    permissionMode: string | null;
    settingsPath: string;
    guardCommand: string;
    pluginDir: string | null;
    mcpConfigPath: string;
    mcpNote: McpNote;
    retitle: Retitle | null;
    titleKept: string | null;
    driver: LibDriver;
    routing: Routed['metadata'] | null;
    decision: Routed['decision'] | null;
    routingSkipped: string | null;
    launch: LibLaunchPlan;
    argv: string[];
    mcpConfig: unknown;
    settings: unknown;
    rules: string[];
    ruleDirs: string[];
    module: HostModuleNote;
    prompt: string;
    env: NodeJS.ProcessEnv;
    commonEnv: NodeJS.ProcessEnv;
    repoSkills: RepoSkillsState;
    worktreeDeps: WorktreeDepsState;
    rebuild: (repoSkills: RepoSkillsState, worktreeDeps?: WorktreeDepsState) => {
        prompt: string;
        launch: LibLaunchPlan;
    };
    knownBaseSha: string | null;
    cwd: string;
}
export declare function readBrief(file: string | null | undefined): string;
export declare const SKILL_KEYS: string[];
export declare function participantSkillsRoot(rootOrHost: unknown, repoDir?: string): string | null;
export declare function skillSettings(rootOrHost: unknown, repoDir?: string): Record<string, unknown>;
export declare function participantPluginDir(rootOrHost: unknown, repoDir?: string): string | null;
export { PROMPTOBUS_SERVER } from './contract.js';
export declare function participantMcp(rootOrHost: unknown, { address, taskId, home, reportTaskId, repoDir }: {
    address: string;
    taskId: string;
    home: string;
    reportTaskId?: string | null;
    repoDir?: string;
}, driver: Required<Pick<LibDriver, 'shadowedUserServers'>>): {
    descriptor: {
        address: string;
        task: string;
        home: string;
        servers: {
            promptobus: {
                type: string;
                command: string;
                args: string[];
                env: {
                    PROMPTOBUS_ROLE: string;
                    PROMPTOBUS_TASK: string;
                    PROMPTOBUS_HOME: string;
                    PROMPTOBUS_ROOT_TASK?: string | undefined;
                };
            };
        };
    };
    external: string[];
    shadowed: string[];
};
export declare function writeSecret(file: string, text: string): void;
/**
 * Files the driver asks to place next to the session before lift. Order is
 * its, mode is shared: a secret is written `0600`. What sits in the file and what it is
 * called is the driver's; that "tokens are here" is the contract's, so the caller sets
 * the mode. `copyFrom` is a whole directory: the Cursor skill canon travels as files, not
 * as the text of one file.
 *
 * `launchDirs` is the driver's own `options.launchDirs` — the caller hands it over rather
 * than the whole driver, because this function writes files and asks nothing else of the
 * harness.
 */
export declare function writeLaunchFiles(files: LaunchFile[], launchDirs?: readonly string[]): void;
export declare function mcpServerLines(raw: unknown): string[];
export declare function mcpNote(mcp: ReturnType<typeof participantMcp>, who: string): {
    level: string;
    text: string;
};
export declare function sayMcp(plan: {
    mcpNote: McpNote;
}, { hint }?: {
    hint?: boolean | undefined;
}): void;
export declare function sessionEnv(driver: Required<Pick<LibDriver, 'sessionEnv'>>, base: NodeJS.ProcessEnv | undefined, host: Pick<PromptobusHost, 'extraEnv'>): NodeJS.ProcessEnv;
/**
 * MCP tool name as THIS harness's session calls it. The participant prompt names bus
 * and memory tools, and harness spellings differ: Claude Code takes the short name,
 * Cursor namespaces with a hyphen (`promptobus-promptobus_send`). A participant given
 * a foreign spelling looks for a tool they do not have.
 */
export declare function toolName(driver: Pick<LibDriver, 'phrases'>, server: string, name: string, host: PromptobusHost): string;
export declare function memoryRule(driver: Pick<LibDriver, 'phrases'>, host: PromptobusHost): string;
export declare function contactsSection(contacts: Contacts, taskTool: string): string;
export declare function optionRefusal(driver: Required<Pick<LibDriver, 'optionRefusal'>>, effort: string | null, tool: LibToolBin, host?: Pick<PromptobusHost, 'busCommand'> | null): string | null;
export declare function normalizeLaunchTool(driver: Pick<LibDriver, 'id' | 'normalizeTool'>, tool: LibToolBin, env?: NodeJS.ProcessEnv): LibToolBin;
export declare function withToolVersion(driver: Pick<LibDriver, 'options'>, host: PromptobusHost, tool: LibToolBin): LibToolBin;
export { titleFromLines } from './store.js';
export declare function restampOutcome(current: unknown, wanted: unknown): {
    level: string;
    text: string;
};
/**
 * Lift driver by the `--harness` flag. Two gates, both before any write to disk.
 *
 * First — registry: an unknown name refuses with the list of known ones, and
 * `liftDriver` ([drivers.js](drivers.js)) does that — the only door from the mechanism
 * to drivers.
 *
 * Second — workspace declaration: a harness that is not in the tools manifest got
 * neither adapters (`sync` did not lay them out) nor a line in `doctor`. Lifting a
 * participant with it would start a session of a tool this workspace does not work
 * with. Without the flag there is no gate at all: the previous lift harness is taken
 * from the map and the declaration is not asked — otherwise a workspace with only
 * `cursor` in the declaration would stop lifting the orchestration that already ran
 * on it.
 *
 * The remedy names a FILE and a FIELD, not a command. Declaring a harness is a hand
 * edit of the manifest; the package has no `tools` subcommand, and the refusal used to
 * print one inherited from the project this package was extracted from. That is the
 * expensive kind of wrong message: it arrives at the one moment an operator most needs
 * a true instruction, and it looks helpful and complete. The only command left
 * in it is `syncHint()` — the host's own, and one that exists. A consumer whose CLI
 * does have a declaration command says so through its own host.
 */
export declare function liftHarness(rootOrHost: unknown, harness: 'codex'): CodexDriver;
export declare function liftHarness(rootOrHost: unknown, harness?: string | null): LibDriver;
export declare function resolveEffort(effort: string | null | undefined, driver: Pick<LibDriver, 'options'>): string | null;
export declare function resolvePermissionMode(mode: string | null | undefined, driver: Pick<LibDriver, 'options'>, fallback?: string | null | undefined): string | null;
export declare function refuseParticipantPrefix(slug: string, route: string, registry: RoleRegistry, participants?: readonly ParticipantV1[], addressFor?: (slug: string) => string): string;
export declare const NAME_MAX = 100;
export declare function machineName(task: TaskIdentity, { slug }?: {
    slug?: string;
}): string;
export declare function shortTitle(title: unknown, max?: number): string;
export declare function sessionName(task: TaskName, { slug, reviewer, approver, taken, title }?: {
    slug?: string;
    reviewer?: boolean;
    approver?: boolean;
    taken?: readonly unknown[];
    title?: string | null;
}): string;
export declare function recoverTeamleadRebind(home: string, rootTask: string, address: string, fault?: SpawnOptions['fault']): boolean;
export declare function planTeamlead(rootOrHost: unknown, opts: SpawnOptions): Promise<TeamleadPlan>;
export declare function planSpawn(rootOrHost: unknown, opts: SpawnOptions): Promise<SpawnPlan>;
/**
 * Line about workspace skills. Four outcomes: the plugin directory is attached, there is
 * no plugin, the harness does not take a plugin, and the harness itself said where the
 * skills come from (a file copy, not a flag). The driver puts its own line on the plan —
 * otherwise Cursor would read "not attached" after already receiving the canon in the
 * worktree `.cursor/skills`.
 */
export declare function skillsNote(plan: {
    launch?: Pick<LibLaunchPlan, 'skillsNote'>;
    pluginDir?: string | null;
    driver: Pick<LibDriver, 'options'>;
}): string;
export declare function sayModule(plan: {
    module: HostModuleNote;
}): void;
/**
 * Field in the REPOSITORY's own `promptobus.json` that declares how to restore the
 * process skills it does not keep in git.
 *
 * The repository's file, not the workspace's: a generator belongs to the repository
 * being spawned into, and the host describes a workspace. `PromptobusHost` is asked
 * nothing here — a host method would either answer about the workspace root's manifest
 * or need a repository argument, and the declaration is one JSON field read by path.
 *
 * An argv array, never a shell line: everything the package launches goes through
 * `run`, and a shell string would need a quoting dialect invented for this one field —
 * and would put a repository's text on the operator's command line.
 */
export declare const GENERATOR_FIELD = "generate";
/**
 * The generator the repository at `repoAbs` declares. `null` — none, which is the
 * default: skills in git stay the normal case and cost this step nothing. A declaration
 * that is there but unusable comes back with `argv: null` and the reason, because
 * silently treating a malformed field as "no generator" is how a participant comes up
 * without the skills its repository thinks it declared.
 */
export declare function repoGenerator(repoAbs: string): {
    argv: string[] | null;
    why: string | null;
} | null;
/**
 * Run the repository's generator in the fresh worktree.
 *
 * A refusal is NOT a spawn refusal, the same rule the dependency install follows: the
 * participant is told what failed and with what exit code, and decides. Killing a lift
 * over missing skills would cost more than the skills.
 *
 * `fresh: false` is a repeat spawn into a surviving directory — what the previous
 * session generated is still there, and running a generator over a worker's tree is a
 * write nobody asked for.
 *
 * `exec` is the test seam, as in `installWorktreeDeps`.
 */
export declare function runRepoGenerator({ worktreePath }: {
    worktreePath: string;
}, { fresh, exec, depsRefused }?: {
    fresh?: boolean;
    exec?: NonNullable<Parameters<typeof runLogged>[1]>['exec'];
    depsRefused?: boolean;
}): RepoSkillsState;
/**
 * The preamble sentence about the repository's own process skills. It is written for
 * every outcome, including "no generator declared": three workers once came up without
 * the rules their repository generates, one noticed and two did not, and a participant
 * that is never told cannot notice.
 */
export declare function repoSkillsLine(state: RepoSkillsState | null | undefined): string;
/**
 * The participant's dependency-install line. A fresh plan carries the lock forecast,
 * while a real spawn replaces it with the install outcome. A repeat carries `repeat`:
 * it deliberately does not rerun or check dependencies in a worktree that may contain
 * the previous session's changes.
 */
export declare function worktreeDepsLine(state: WorktreeDepsState | null | undefined): string;
/**
 * The same three states for the OPERATOR, in `--dry-run`. It says what the preamble will
 * say, in one line: a run that printed "no generator declared" while the participant was
 * told the declaration is broken would send the reader looking in the wrong file.
 */
export declare function repoSkillsPlanNote(state: RepoSkillsState | null | undefined): string;
/**
 * Outcome of the generator for the OPERATOR. `none` and `kept` say nothing out loud:
 * the preamble carries both, and a line about a step that did not happen would print on
 * every lift into every repository that never declared one.
 */
export declare function sayRepoSkills(state: RepoSkillsState | null | undefined): void;
export declare function sayWorktreeDeps(result: WorktreeDepsState | null | undefined): void;
export declare function guardHookNote(plan: {
    settingsPath: string;
    guardCommand: string;
}): string;
export declare function opencodeGuardNote(plan: {
    mcpConfigPath: string;
}): string;
export declare function sessionEnvNote(driver: Pick<LibDriver, 'options'>, host: Pick<PromptobusHost, 'extraEnv'>): string;
export declare function dryRunToolNote(driver: Pick<LibDriver, 'options'>): string;
export declare function sayTool(tool: LibToolBin, { reason }?: {
    reason?: boolean | undefined;
}): void;
/**
 * The brief in the task files folder. The file the orchestrator passes is theirs and
 * temporary — a scratch note beside a run, and the consumer's workspace filled up with
 * directories of stale ones; the assignment itself is the one document that explains a
 * branch months later, so the bus keeps a copy next to the review diffs of the same
 * task. Every lift stores the brief it was given, and a repeat at the same address takes
 * the next number: overwriting would drop the assignment the previous session actually
 * worked by, and the history of assignments of an address is exactly what is being kept.
 *
 * A write refusal is a WARNING, in the voice of the dependency install: the worker is
 * already up by this point, and a throw here would end the command with a running
 * session, no report and no route back. What is lost is a copy — the orchestrator still
 * holds the file it passed.
 */
export declare function keepBrief(plan: {
    home: string;
    taskId: string;
    slug: string;
    brief: string;
    briefStem?: string;
}): void;
export declare function spawnTeamlead(rootOrHost: unknown, opts: SpawnOptions): Promise<TeamleadPlan>;
export declare function spawn(rootOrHost: unknown, opts: SpawnOptions): Promise<SpawnPlan | TeamleadPlan>;

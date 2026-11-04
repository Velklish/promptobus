import { contactsOf, newTaskIdentity, strictTaskFacts } from './store.js';
import { mcpNote } from './spawn.js';
import { decideLift, routingContext } from './models.js';
import type { DeclaredStep, DriverDenyTool, HostClone, HostMcpTool, ParticipantV1, PreparedHostParticipantContextSelection, PromptobusHost, RoleEntry, StepKind, TaskV1 } from '../dist/index.js';
import type { LibDriver, LibLaunchPlan, LibSpawnContext, LibToolBin } from './driver-runtime.js';
type TaskIdentity = ReturnType<typeof newTaskIdentity>;
type PlannedTask = Pick<TaskV1, 'id' | 'title' | 'status' | 'adapter' | 'participants'>;
type TaskParticipants = Pick<TaskV1, 'participants'>;
type Contacts = ReturnType<typeof contactsOf>;
type RoutingContext = Awaited<ReturnType<typeof routingContext>>;
type RoutedLift = NonNullable<ReturnType<typeof decideLift>>;
type NativeSelection = PreparedHostParticipantContextSelection | null;
export type DenyEntry = Pick<RoleEntry, 'hostDenyRole'> & {
    kind: StepKind;
};
export interface GateInstructions {
    path: string;
    text: string;
}
export interface ReviewOptions {
    target?: string;
    base?: string;
    task?: string;
    title?: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
    harness?: string;
    strategy?: string;
    dryRun?: boolean;
    stepName?: string;
    approver?: boolean;
    alias?: boolean;
    brief?: string;
    allowPayg?: boolean;
    refresh?: boolean;
    tool?: LibToolBin;
    adapterFor?: NonNullable<Parameters<typeof routingContext>[1]>['adapterFor'];
    awaitOptions?: LibSpawnContext['awaitOptions'];
    contextPurpose?: string;
    contextDeclaration?: unknown;
}
interface ReviewPlanningOptions extends ReviewOptions {
    routing?: RoutingContext;
    instructions?: GateInstructions | null;
    instructionsReuse?: boolean;
    taskIdentity?: TaskIdentity | null;
    preparedContext?: NativeSelection;
}
interface ReviewPreflight {
    taskIdentity: TaskIdentity | null;
    participant: ParticipantV1 | null;
    selectedContext: NativeSelection;
}
interface ReviewRefusal {
    refusal: string;
    routingSkipped?: undefined;
    routing?: undefined;
    reuse?: undefined;
    taskIdentity?: undefined;
    selectedContext?: undefined;
}
interface ReviewSnapshot {
    at: string;
    head: string | null;
    clean: boolean;
    modifiedTracked: string[];
    line: string;
}
interface ReviewSkill {
    name: string;
    module: string;
    dir: string;
    shared: string | null;
}
type Attachments = ReturnType<typeof attachedFiles>;
type Seat = {
    kind: 'several';
    detail: string;
    owner?: undefined;
} | {
    kind: 'one';
    owner: ParticipantV1;
    detail: string;
} | {
    kind: 'latest';
    owner: ParticipantV1;
    detail: string;
    picked: string | null;
};
interface SubjectInput {
    diffPath: string;
    repoDir: string;
    stat: string;
    untracked: string[];
    baseLine: string;
    snapshot: ReviewSnapshot;
    gateRecords: string[];
    handoverRecords: string[];
    attachments: Attachments;
    reviewedAddress: string | null;
    attachmentSeat: Seat | null;
    approverBeside: Seat | null;
    approverFiles: Attachments;
}
interface ReviewPromptInput extends SubjectInput {
    taskId: string;
    nsPath: string;
    address: string;
    stepName: string;
    instructions: GateInstructions | null;
    rules: string[];
    skill: ReviewSkill | null;
    driver: LibDriver;
    host: PromptobusHost;
    contacts: Contacts;
    priorFindings: string | null;
}
export interface ReviewPlan extends ReviewPromptInput {
    home: string;
    createNew: PlannedTask | null;
    taskIdentity: TaskIdentity | null;
    selectedContext: NativeSelection;
    otherActive: string[];
    slug: string;
    name: string;
    baseRef: string | null;
    ownerAddress: string | null;
    owner: ParticipantV1 | null;
    warnings: string[];
    diff: string;
    participant: ParticipantV1 | null;
    sessionState: 'alive' | 'dead' | 'unknown' | null;
    reuse: boolean;
    unlaunched: boolean;
    titleIgnored: boolean;
    rebind: {
        from: string;
        to: string;
    } | null;
    ruleDirs: string[];
    addDirs: string[];
    prompt: string;
    reReview: string;
    module: ReturnType<PromptobusHost['moduleNote']>;
    pluginDir: string | null;
    settingsPath: string;
    guardCommand: string;
    mcpConfigPath: string;
    mcpNote: ReturnType<typeof mcpNote>;
    launch: LibLaunchPlan;
    argv: string[];
    mcpConfig: unknown;
    settings: unknown;
    model: string;
    effort: string | null;
    permissionMode: string | null;
    refusal: string | null;
    routing: RoutedLift['metadata'] | null;
    decision: RoutedLift['decision'] | null;
    routingSkipped: string | null;
    env: NodeJS.ProcessEnv;
    commonEnv: NodeJS.ProcessEnv;
}
/** Refusal on the ability to strip tools; `null` means the driver declared it. A pure function:
 * there is no live driver without `denyTools`, so the branch is reachable only with a stand-in. */
export declare function denyToolsRefusal(driver: LibDriver): string | null;
export declare function hostDenyClassification(host: Pick<PromptobusHost, 'participantDenyToolsByKind' | 'participantDenyTools'>, entry: DenyEntry, declaredServers?: readonly unknown[], repoDir?: string): {
    tools: HostMcpTool[];
    complete: boolean;
    detail: string;
};
export declare function reviewerDenyTools(host: PromptobusHost, driver: LibDriver, declaredServers?: readonly unknown[], stepName?: string, repoDir?: string): {
    tools: readonly DriverDenyTool[];
    refusal: string | null;
};
/** Which reviewer this subject belongs to. The slug comes from the SUBJECT, not the clone root: with
 * two workers of one repository `basename` would send the second review to the first's reviewer. */
export declare function reviewerFor(ownerStep: DeclaredStep, taskMeta: TaskParticipants, repoDir: string, clone: Pick<HostClone, 'abs'>, stepName?: string): {
    owner: ParticipantV1 | null;
    slug: string;
    address: string;
};
/** The bus checks only journal facts: the current assignment, the subject and a result after it. */
export declare function requireStepResults(host: Pick<PromptobusHost, 'pipeline'>, { home, taskId, taskMeta, stepName, slug, repoDir, facts }: {
    home: string;
    taskId: string;
    taskMeta: TaskParticipants;
    stepName: string;
    slug: string;
    repoDir: string;
    facts?: ReturnType<typeof strictTaskFacts> | null;
    signal?: AbortSignal;
}): void;
export declare function readGateInstructions(host: PromptobusHost, stepName: string | undefined, cached?: unknown): GateInstructions | null;
export declare function gateInstructionsSection(instructions: GateInstructions | null | undefined): string;
export declare function planReview(rootOrHost: unknown, options: ReviewPlanningOptions & {
    contextPreflightOnly: true;
}): ReviewPreflight | ReviewRefusal;
export declare function planReview(rootOrHost: unknown, options?: ReviewPlanningOptions & {
    contextPreflightOnly?: false;
}): ReviewPlan | ReviewRefusal;
export declare function review(rootOrHost: unknown, opts?: ReviewOptions): Promise<ReviewPlan | import('./approver.js').ApproverPlan>;
export declare function step(rootOrHost: unknown, opts?: ReviewOptions): Promise<ReviewPlan | import('./approver.js').ApproverPlan>;
export declare function worktreeOwner(ownerStep: DeclaredStep, taskMeta: TaskParticipants, repoDir: string): ParticipantV1 | null;
export declare function approverSeat(taskMeta: TaskParticipants, repoDir: string, cloneRoot: string | null | undefined): Seat | null;
export declare function resolveRepoDir(target: string): {
    refusal: string;
    repoDir?: never;
    targetDir?: never;
} | {
    refusal?: never;
    repoDir: string;
    targetDir: string;
};
declare function attachedFiles(home: string, taskId: string, owner: ParticipantV1 | null): {
    files: {
        path: string;
        at: string;
        kind: string;
    }[];
    broken: (string | null)[];
} | null;
export declare function writeDiff(dir: string, slug: string, content: string, stepName?: string): string;
export {};

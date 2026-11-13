import { openParticipant } from '../dist/index.js';
import type { Driver, Registry, LaunchPlan, SpawnContext, WakeProbe, ParticipantV1, PromptobusHost, HostToolBin, StepKind, HostMcpTool, StalledParticipant, DriverDenyTool } from '../dist/index.js';
import type { RoutingAdapter } from './model-routing/adapter-common.js';
export interface ManagedServiceLaunch {
    launchId: string;
    clientId: string;
    credentialFile: string;
    beforeStart(record: string): Promise<void>;
    realize(nativeId: string): Promise<void>;
    revoke(): Promise<void>;
}
export interface LibLaunchPlan extends LaunchPlan {
    liveSeat?: {
        starting(): void;
        stopped(): void;
        staged(record: string, launchId: string): void;
    };
    service?: ManagedServiceLaunch;
    serviceScopes?: {
        server: string;
        task: string;
        address: string;
        record: string;
    }[];
    serviceFiles?: {
        roots: string[];
        canonicalFiles?: string[];
    };
    env?: NodeJS.ProcessEnv;
    mcpConfigPath?: string;
    prelaunchBinding?: {
        sessionId?: string;
        sessionRecord?: string;
    };
    sessionRecord?: string | null;
    launchId?: string;
    rootSessionRecord?: string | null;
    skillsNote?: string | null;
    envNote?: string;
    configDir?: string;
}
export interface LibPrepareContext extends Pick<SpawnContext, 'ref' | 'address' | 'task' | 'mcp' | 'prompt' | 'cwd' | 'role' | 'model' | 'effort' | 'permissionMode' | 'addDirs' | 'readFiles' | 'readSkillDirs' | 'skillsRoot' | 'selectedContext' | 'pluginDir' | 'mcpConfigPath' | 'settingsPath' | 'guardCommand' | 'extraSettings' | 'env'> {
    denyTools?: readonly DriverDenyTool[] | null;
    model: string;
    mcpConfigPath: string;
    settingsPath: string;
    home?: string | null;
    root?: string | null;
    rootTask?: string | null;
    rootAddress?: string | null;
    executionKind?: StepKind | null;
    sessionId?: string;
    projectGuardCommand?: string | null;
}
export type LibToolBin = Omit<HostToolBin, 'version'> & {
    version?: string | null;
};
export interface LibSpawnContext extends Pick<SpawnContext, 'ref' | 'home' | 'task' | 'address' | 'cwd'> {
    role: string;
    env: NodeJS.ProcessEnv;
    tool: LibToolBin & {
        bin: string;
    };
    host: PromptobusHost;
    persist(id: string | null, state: 'alive' | 'dead' | 'unknown', full: string | null): unknown;
    awaitOptions?: {
        tries?: number;
        delayMs?: number;
    };
    launchFailNote?: string;
    deadNote?: string;
    unboundNote?: string;
    noun?: string | null;
    requireFullSession?: boolean;
    requireLaunchMatch?: boolean;
}
export interface LibSpawnResult<TSeen extends object = object> {
    output: string;
    session: string | null;
    seen: TSeen;
}
export interface LibStall extends Pick<StalledParticipant, 'kind' | 'address' | 'repoAbs' | 'reset'> {
    task?: string | null;
    reviewCommand?: string;
    doneCommand?: string;
    statusCommand?: string;
}
export interface LibMcpServer {
    command?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    type?: string;
    url?: string;
    headers?: Record<string, string>;
    http_headers?: Record<string, string>;
    bearer_token_env_var?: string;
    env_http_headers?: Record<string, string>;
    oauth?: false;
    disabled_tools?: string[];
    [key: string]: unknown;
}
export interface LibMcpConfig {
    mcpServers: Record<string, LibMcpServer>;
}
export interface LibDriver extends Omit<Driver, 'availability' | 'prepare' | 'spawn' | 'checkWake' | 'saidLiftoff' | 'sessionEnv' | 'stallRoute' | 'registerWake' | 'bindHandshake' | 'optionRefusal' | 'sweepParticipant' | 'normalizeTool' | 'resumeState' | 'refuseForeignProjectLayer' | 'shadowedUserServers'> {
    readonly availability?: RoutingAdapter;
    replaceMcpServers?(plan: LibLaunchPlan, servers: Record<string, LibMcpServer>): void;
    resumeState?(ref: string, context: Parameters<NonNullable<Driver['resumeState']>>[1]): {
        threadId?: string | null;
        sandbox?: string;
    };
    normalizeTool?(tool: LibToolBin, context?: {
        env?: NodeJS.ProcessEnv;
    }): LibToolBin;
    refuseForeignProjectLayer?(lookupDir: string, writtenDir: string, tool?: LibToolBin | null, guardCommand?: string | null, projectGuardCommand?: string | null): void;
    prepare?: (context: LibPrepareContext) => LibLaunchPlan;
    spawn?: (plan: LibLaunchPlan, runtime: LibSpawnContext) => Promise<LibSpawnResult>;
    saidLiftoff?: (result: LibSpawnResult & {
        name: string;
    }) => void;
    checkWake?: (env?: NodeJS.ProcessEnv) => WakeProbe | Promise<WakeProbe>;
    sessionEnv: (base?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    stallRoute?(stall: LibStall, id: string | null, ref: string | null): string;
    registerWake?(home: string, task: string, address: string, env?: NodeJS.ProcessEnv, session?: string | null): unknown;
    bindHandshake?(home: string, task: string, address: string, env?: NodeJS.ProcessEnv, session?: string | null): unknown;
    optionRefusal: (options: {
        effort?: string | null;
        statusCommand?: string | null;
    }, tool: LibToolBin) => string | null;
    shadowedUserServers: (names: string[]) => string[];
    sweepParticipant?(participant: ParticipantV1, taskId: string, env?: NodeJS.ProcessEnv, context?: {
        home: string;
        task: string;
        taskLocked?: true;
    }): unknown;
    mcpDenyTools?(tools: readonly HostMcpTool[]): DriverDenyTool[];
}
export interface LibRegistry extends Omit<Registry, 'drivers'> {
    readonly drivers: Readonly<Record<string, LibDriver>>;
}
export type CoreDriverPort = Pick<Driver, 'id' | 'capabilities' | 'options' | 'phrases' | 'inspect' | 'stop' | 'activate' | 'awaitsUser'>;
export interface CoreRegistryPort extends Omit<Registry, 'drivers'> {
    readonly drivers: Readonly<Record<string, CoreDriverPort>>;
}
export declare function coreDriver(driver: LibDriver): CoreDriverPort;
export declare function coreRegistry(registry: LibRegistry): CoreRegistryPort;
export declare function createLibRegistry({ drivers, fallback }: {
    drivers: Record<string, LibDriver>;
    fallback?: string | null;
}): LibRegistry;
export declare function libDriverFor(registry: LibRegistry, harness: string | null | undefined): LibDriver;
export declare function libOpenParticipant(home: string, task: string, participant: ParticipantV1, registry: LibRegistry, options?: Parameters<typeof openParticipant>[4]): Omit<ReturnType<typeof openParticipant>, 'driver'> & {
    driver: LibDriver;
};
export declare function replaceLaunchMcpConfig(plan: LibLaunchPlan, config: unknown): void;

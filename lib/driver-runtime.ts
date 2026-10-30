import { createRegistry, driverFor, openParticipant } from '../dist/index.js';
import type { Driver, Registry, LaunchPlan, SpawnContext, WakeProbe, ParticipantV1, PromptobusHost, HostToolBin, StepKind, HostMcpTool, StalledParticipant, DriverDenyTool } from '../dist/index.js';
import type { RoutingAdapter } from './model-routing/adapter-common.js';

export interface LibLaunchPlan extends LaunchPlan {
  prelaunchBinding?: { sessionId?: string; sessionRecord?: string };
  sessionRecord?: string | null;
  skillsNote?: string | null;
  envNote?: string;
  configDir?: string;
}
export interface LibPrepareContext extends Pick<SpawnContext,
  'ref' | 'address' | 'task' | 'mcp' | 'prompt' | 'cwd' | 'role' | 'model' | 'effort' | 'permissionMode' |
  'addDirs' | 'readFiles' | 'readSkillDirs' | 'skillsRoot' | 'selectedContext' | 'pluginDir' | 'mcpConfigPath' |
  'settingsPath' | 'guardCommand' | 'denyTools' | 'extraSettings' | 'env'> {
  model: string;
  mcpConfigPath: string;
  settingsPath: string;
  home?: string | null;
  root?: string | null;
  rootTask?: string | null;
  rootAddress?: string | null;
  executionKind?: StepKind | null;
  sessionId?: string;
}
export type LibToolBin = Omit<HostToolBin, 'version'> & { version?: string | null };
export interface LibSpawnContext extends Pick<SpawnContext, 'ref' | 'home' | 'task' | 'address' | 'cwd'> {
  role: string;
  env: NodeJS.ProcessEnv;
  tool: LibToolBin & { bin: string };
  host: PromptobusHost;
  persist(id: string | null, state: 'alive' | 'dead' | 'unknown', full: string | null): unknown;
  awaitOptions?: { tries?: number; delayMs?: number };
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
  command?: string; args?: string[]; env?: NodeJS.ProcessEnv; type?: string; url?: string;
  headers?: Record<string, string>; disabled_tools?: string[];
  [key: string]: unknown;
}
export interface LibMcpConfig { mcpServers: Record<string, LibMcpServer> }
export interface LibDriver extends Omit<Driver,
  'availability' | 'prepare' | 'spawn' | 'checkWake' | 'saidLiftoff' | 'sessionEnv' | 'stallRoute' |
  'registerWake' | 'bindHandshake' | 'optionRefusal' | 'sweepParticipant' | 'normalizeTool' | 'resumeState'> {
  readonly availability?: RoutingAdapter;
  resumeState?(ref: string, context: Parameters<NonNullable<Driver['resumeState']>>[1]): { threadId?: string | null; sandbox?: string };
  normalizeTool?(tool: LibToolBin, context?: { env?: NodeJS.ProcessEnv }): LibToolBin;
  prepare?: (context: LibPrepareContext) => LibLaunchPlan;
  spawn?: (plan: LibLaunchPlan, runtime: LibSpawnContext) => Promise<LibSpawnResult>;
  saidLiftoff?: (result: LibSpawnResult & { name: string }) => void;
  checkWake?: (env?: NodeJS.ProcessEnv) => WakeProbe | Promise<WakeProbe>;
  sessionEnv?(base?: NodeJS.ProcessEnv, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  stallRoute?(stall: LibStall, id: string | null, ref: string | null): string;
  registerWake?(home: string, task: string, address: string, env?: NodeJS.ProcessEnv, session?: string | null): unknown;
  bindHandshake?(home: string, task: string, address: string, env?: NodeJS.ProcessEnv, session?: string | null): unknown;
  optionRefusal?(options: { effort?: string | null }, tool: LibToolBin): string | null;
  sweepParticipant?(participant: ParticipantV1, taskId: string): unknown;
  mcpDenyTools?(tools: readonly HostMcpTool[]): DriverDenyTool[];
}
export interface LibRegistry extends Omit<Registry, 'drivers'> {
  readonly drivers: Readonly<Record<string, LibDriver>>;
}

// Core invokes these four operations; its required data fields retain their public contracts.
export type CoreDriverPort = Pick<Driver,
  'id' | 'capabilities' | 'options' | 'phrases' | 'inspect' | 'stop' | 'activate' | 'awaitsUser'>;
export interface CoreRegistryPort extends Omit<Registry, 'drivers'> {
  readonly drivers: Readonly<Record<string, CoreDriverPort>>;
}

export function coreDriver(driver: LibDriver): CoreDriverPort {
  const checked: CoreDriverPort = driver;
  return checked;
}
export function coreRegistry(registry: LibRegistry): CoreRegistryPort {
  const checked: CoreRegistryPort = registry;
  return checked;
}
export function createLibRegistry({ drivers, fallback }: {
  drivers: Record<string, LibDriver>; fallback?: string | null;
}): LibRegistry {
  const checked: Record<string, CoreDriverPort> = drivers;
  const registry: CoreRegistryPort = createRegistry({ drivers: checked, fallback });
  // Core copies the map and retains each input driver reference (src/driver.ts, createRegistry).
  return registry as LibRegistry;
}
export function libDriverFor(registry: LibRegistry, harness: string | null | undefined): LibDriver {
  const driver: CoreDriverPort = driverFor(coreRegistry(registry), harness);
  // Core returns an unchanged member of this private registry (src/driver.ts, driverFor).
  return driver as LibDriver;
}
export function libOpenParticipant(home: string, task: string, participant: ParticipantV1,
  registry: LibRegistry, options?: Parameters<typeof openParticipant>[4]):
  Omit<ReturnType<typeof openParticipant>, 'driver'> & { driver: LibDriver } {
  const opened: Omit<ReturnType<typeof openParticipant>, 'driver'> & { driver: CoreDriverPort }
    = openParticipant(home, task, participant, coreRegistry(registry), options);
  // openParticipant returns the registry driver without replacing it (src/driver.ts).
  return opened as Omit<ReturnType<typeof openParticipant>, 'driver'> & { driver: LibDriver };
}

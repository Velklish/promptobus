import type { PromptobusHost } from '../dist/index.js';
import type { ServiceClientCredential, ServiceClientInput, ServiceClientLifetime } from './service.js';
import type { ServiceDiscovery, ServicePaths } from './service-state.js';
import type { WardenDiagnostics } from './service-warden.js';
/** pollEnv is the full owner bootstrap snapshot; cwd remains caller context, not the daemon cwd. */
export interface ServiceCallOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    pollEnv?: NodeJS.ProcessEnv;
}
export declare function serviceControl(paths: ServicePaths, input: object): Promise<unknown>;
export declare function workspaceServiceStatus(host: PromptobusHost, { env }?: ServiceCallOptions): Promise<{
    running: false;
    discovery: ServiceDiscovery | null;
} | {
    schemaVersion: 1;
    root: string;
    home: string;
    runtime: string;
    version: string;
    url: string;
    process: import("./service-state.js").ProcessIdentity;
    clients: number;
    reservations: number;
    unknownClients: number;
    unknownManaged: number;
    sessions: number;
    warden: WardenDiagnostics;
    discovery?: undefined;
    running: true;
}>;
export declare function ensureWorkspaceService(host: PromptobusHost, { env, pollEnv }?: ServiceCallOptions): Promise<ServiceDiscovery>;
export declare function registerServiceClient(host: PromptobusHost, client: ServiceClientInput, options?: ServiceCallOptions): Promise<ServiceClientCredential>;
export declare function bindServiceClient(host: PromptobusHost, clientId: string, lifetime: ServiceClientLifetime, options?: ServiceCallOptions): Promise<unknown>;
export declare function realizeServiceClient(host: PromptobusHost, clientId: string, threadId: string, options?: ServiceCallOptions): Promise<unknown>;
export declare function revokeServiceClient(host: PromptobusHost, clientId: string, options?: ServiceCallOptions): Promise<unknown>;
export declare function stopWorkspaceService(host: PromptobusHost, { env }?: ServiceCallOptions): Promise<{
    stopped: boolean;
}>;
export declare function ensureTaskWarden(host: PromptobusHost, home: string, task: string, options?: ServiceCallOptions): Promise<{
    pid: number;
    state: string;
}>;
export declare function abortTaskWarden(host: PromptobusHost, task: string, options?: ServiceCallOptions): Promise<unknown>;

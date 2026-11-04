import type { PromptobusHost } from '../dist/index.js';
import type { WardenDiagnostics } from './service-warden.js';
import type { ProcessIdentity, ServiceDiscovery } from './service-state.js';
import type { StandaloneRootReference } from './standalone-root-state.js';
export type ServiceHostFactory = (context: {
    cwd: string;
    env: Readonly<NodeJS.ProcessEnv>;
}) => PromptobusHost | Promise<PromptobusHost>;
export type ServiceClientLifetime = {
    kind: 'reservation';
    expiresAt: number;
} | {
    kind: 'process';
    process: ProcessIdentity;
} | {
    kind: 'managed';
    task: string;
    address: string;
    ref: string;
    launchId: string;
    record: string;
};
export type ServiceNativeHarness = 'claude' | 'cursor' | 'codex' | 'opencode';
export type ServiceNativeBinding = {
    kind: ServiceNativeHarness;
    state: 'pending';
} | {
    kind: 'codex';
    state: 'bound';
    threadId: string;
} | {
    kind: Exclude<ServiceNativeHarness, 'codex'>;
    state: 'bound';
    sessionId: string;
};
export interface ServiceClientInput {
    cwd: string;
    env: NodeJS.ProcessEnv;
    pollEnv?: NodeJS.ProcessEnv;
    lifetime?: ServiceClientLifetime;
    files?: {
        roots: string[];
        canonicalFiles?: string[];
    };
    nativeBinding?: ServiceNativeBinding;
    rootLaunch?: StandaloneRootReference;
    bbRootNonce?: string;
}
export interface ServiceClientGrant {
    schemaVersion: 1;
    id: string;
    token: string;
    runtime: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    pollEnv: NodeJS.ProcessEnv;
    lifetime: ServiceClientLifetime;
    files: {
        roots: string[];
        canonicalFiles: string[];
    } | null;
    nativeBinding?: ServiceNativeBinding;
    rootLaunch?: StandaloneRootReference;
    bbRootNonce?: string;
}
export interface ServiceClientCredential {
    clientId: string;
    token: string;
    credentialFile: string;
    busUrl: string;
    filesUrl: string | null;
}
export interface ServiceStatus extends ServiceDiscovery {
    clients: number;
    reservations: number;
    unknownClients: number;
    unknownManaged: number;
    sessions: number;
    warden: WardenDiagnostics;
}
export interface RunServiceOptions {
    host: PromptobusHost;
    createHost: ServiceHostFactory;
    env?: NodeJS.ProcessEnv;
    activeWork?: () => boolean;
}
export declare function runWorkspaceService({ host, createHost, env, activeWork: additionalWork }: RunServiceOptions): Promise<void>;

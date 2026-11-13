import type { PromptobusHost } from '../dist/index.js';
import type { LibDriver, LibLaunchPlan, LibMcpServer } from './driver-runtime.js';
import { revokeFailedManagedLaunch } from './driver-common.js';
import type { ServiceCallOptions } from './service-client.js';
import type { ServiceClientInput, ServiceNativeHarness } from './service.js';
export declare const OWNER_ENV_FILE = "PROMPTOBUS_OWNER_ENV_FILE";
export declare const CLIENT_TOKEN = "PROMPTOBUS_CLIENT_TOKEN";
export declare const CLIENT_FILE = "PROMPTOBUS_CLIENT_FILE";
export interface ManagedServiceLaunch {
    launchId: string;
    clientId: string;
    credentialFile: string;
    beforeStart(record: string): Promise<void>;
    realize(nativeId: string): Promise<void>;
    revoke(): Promise<void>;
}
interface ServiceLaunchPlan extends LibLaunchPlan {
    service?: ManagedServiceLaunch;
    env?: NodeJS.ProcessEnv;
    serviceScopes?: {
        server: string;
        task: string;
        address: string;
        record: string;
    }[];
    serviceFiles?: NonNullable<ServiceClientInput['files']>;
}
export interface ManagedServiceLaunchInput {
    launch: ServiceLaunchPlan;
    driver: LibDriver;
    home: string;
    task: string;
    address: string;
    ref: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    commonEnv: NodeJS.ProcessEnv;
    files?: NonNullable<ServiceClientInput['files']>;
    deferTaskBinding?: boolean;
}
export declare function createOwnerEnvironment(host: PromptobusHost, env: NodeJS.ProcessEnv): string;
export declare function readOwnerEnvironment(host: PromptobusHost, file: string, { env }?: ServiceCallOptions): Readonly<NodeJS.ProcessEnv>;
export declare function managedServiceServers(harness: ServiceNativeHarness, credential: {
    busUrl: string;
    filesUrl: string | null;
}, tokenVariable?: string): {
    promptobus: LibMcpServer;
    reviewer_files?: LibMcpServer | undefined;
};
interface ManagedHookContext {
    harness: ServiceNativeHarness;
    home: string;
    task: string;
    address: string;
    ref: string;
    record: string;
    launchId: string;
    deferTaskBinding: boolean;
}
export declare function readManagedServiceHookContext(host: PromptobusHost, file: string, options?: ServiceCallOptions): ManagedHookContext;
/** Read only the exact staged launch capability; this helper never starts the service. */
export declare function managedServiceHeaders(host: PromptobusHost, file: string, options?: ServiceCallOptions): {
    Authorization: string;
};
export declare function realizeManagedServiceClient(host: PromptobusHost, file: string, nativeId: string, options?: ServiceCallOptions): Promise<void>;
export declare function requireManagedClaudeMcp(host: PromptobusHost, file: string, options?: ServiceCallOptions): void;
export declare function finalizeManagedServiceLaunch(host: PromptobusHost, input: ManagedServiceLaunchInput): Promise<{
    service: ManagedServiceLaunch;
    env: NodeJS.ProcessEnv;
}>;
export { revokeFailedManagedLaunch };

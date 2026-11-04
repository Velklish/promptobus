import type { PromptobusHost } from '../dist/index.js';
export interface ProcessIdentity {
    pid: number;
    birth: string;
}
export interface RecordVersion {
    file: string;
    version: string;
}
export declare function recordVersion(file: string): RecordVersion;
export declare function sameRecordVersion(expected: RecordVersion): boolean;
export interface ServicePaths {
    base: string;
    directory: string;
    discovery: string;
    owner: string;
    lock: string;
    startup: string;
    clients: string;
    sessions: string;
    requests: string;
    controlSocket: string;
    root: string;
    home: string;
}
export interface ServiceDiscovery {
    schemaVersion: 1;
    root: string;
    home: string;
    runtime: string;
    version: string;
    url: string;
    process: ProcessIdentity;
}
export declare const recordOf: (value: unknown) => value is Record<string, unknown>;
export declare const contained: (root: string, file: string) => boolean;
export declare function processIdentity(pid: number): ProcessIdentity | null;
export declare function processIdentityAsync(pid: number): Promise<ProcessIdentity | null>;
export declare function sameProcess(identity: ProcessIdentity): boolean;
export declare function processState(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown';
export declare function processStateAsync(identity: ProcessIdentity): Promise<'alive' | 'dead' | 'unknown'>;
export declare function requireProcess(pid?: number): ProcessIdentity;
export declare function servicePaths(host: PromptobusHost, env?: NodeJS.ProcessEnv): ServicePaths;
export declare function prepareControlSocket(paths: ServicePaths): Promise<void>;
export declare function privateDirectory(directory: string): void;
export declare function prepareServicePaths(paths: ServicePaths): void;
export declare function readPrivate(file: string): unknown;
export declare function writePrivate(file: string, value: unknown): void;
export declare function processRecord(value: unknown): ProcessIdentity | null;
export declare function discoveryOf(value: unknown): ServiceDiscovery | null;
export declare function readDiscovery(paths: ServicePaths): ServiceDiscovery | null;
export declare function runtimeIdentity(host: PromptobusHost): string;
export declare function acquireServiceLock(directory: string): Promise<(() => void) | null>;

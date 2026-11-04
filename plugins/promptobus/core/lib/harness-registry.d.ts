import { pidAlive } from '../dist/index.js';
export interface HarnessSessionRecord {
    ref: string;
    provenance?: string | null;
    mechanismPath?: string | null;
    mechanismPathIssue?: string | null;
    mechanismVersion?: string | null;
    packagePath?: string | null;
    packageVersion?: string | null;
    packageIssue?: string | null;
    hostVersion?: string | null;
    binaryPath?: string | null;
    binaryVersion?: string | null;
    bin?: string | null;
    [key: string]: unknown;
}
interface RegistryOptions<T extends HarnessSessionRecord> {
    harness?: string;
    sidecars?: (ref: string, env: NodeJS.ProcessEnv) => string[];
    onDrop?: (record: T, env: NodeJS.ProcessEnv) => void;
}
export declare function sessionKey(ref: unknown): string;
export declare function createHarnessRegistry<T extends HarnessSessionRecord = HarnessSessionRecord>({ harness, sidecars, onDrop }?: RegistryOptions<T>): {
    harness: string;
    stateHome: (env?: NodeJS.ProcessEnv) => string;
    sessionsDir: (env?: NodeJS.ProcessEnv) => string;
    sessionKey: typeof sessionKey;
    sessionFile: (ref: string, env?: NodeJS.ProcessEnv) => string;
    readSession: (ref: string, env?: NodeJS.ProcessEnv) => T | null;
    writeSession: (record: T, env?: NodeJS.ProcessEnv) => {
        provenance: string;
    } & Omit<T, "provenance">;
    patchSession: (ref: string, patch: Partial<T>, env?: NodeJS.ProcessEnv) => ({
        provenance: string;
    } & Omit<T, "provenance">) | null;
    dropSession: (ref: string, env?: NodeJS.ProcessEnv) => void;
    registrySessions: (env?: NodeJS.ProcessEnv) => T[];
    pidAlive: typeof pidAlive;
};
export {};

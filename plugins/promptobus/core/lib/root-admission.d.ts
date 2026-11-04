import type { PromptobusHost } from '../dist/index.js';
import type { ProcessIdentity, ServicePaths } from './service-state.js';
export interface RootGeneration {
    nativeThreadId: string;
    appServer: ProcessIdentity;
    nonce: string;
}
interface RootCreation {
    revision: string;
    state: 'pending' | 'uncertain' | 'bound';
    bbThreadId: string | null;
    nativeThreadId: string | null;
    pending: {
        file: string;
        generation: RootGeneration;
    } | null;
    executionScope?: Readonly<{
        project: string;
        environment: string;
    }>;
}
export interface ApprovedRootProfile {
    id: string;
    runtime: string;
    nativeStore: string;
    creation?: RootCreation;
}
export interface RootLookupScope {
    root: string;
    home: string;
    profile: Readonly<ApprovedRootProfile>;
    generation: Readonly<RootGeneration>;
}
export interface RootRealization extends RootLookupScope {
    bbThreadId: string;
}
export interface RootRequest {
    profileId: string;
    nativeStore: string;
    generation: RootGeneration;
}
interface ManagedLaunch {
    id: string;
    bbThreadId: string | null;
}
interface RootRecord {
    profileId: string;
    bbThreadId: string;
    generation: RootGeneration;
}
interface AdmissionState {
    schemaVersion: 2;
    root: string;
    home: string;
    profiles: ApprovedRootProfile[];
    managed: ManagedLaunch[];
    roots: RootRecord[];
}
export declare function readRootAdmissionState(paths: ServicePaths): AdmissionState | null;
export declare function createRootAdmission(host: PromptobusHost, { env }?: {
    env?: NodeJS.ProcessEnv;
}): {
    approveProfile(input: {
        id: string;
        nativeStore: string;
        executionScope?: RootCreation['executionScope'];
    }, verifyOwner?: () => void, publishProfile?: () => void): Promise<void>;
    reserveRootCreation(id: string, revision: string, verifyOwner: () => void, executionScope?: RootCreation['executionScope']): Promise<{
        invoke: boolean;
        creation: RootCreation;
    }>;
    finishRootCreation(id: string, revision: string, bbThreadId: string | null, verifyOwner: () => void, executionScope?: RootCreation['executionScope']): Promise<RootCreation>;
    deferRootCreation(id: string, file: string, generation: RootGeneration, verifyOwner?: () => void): Promise<boolean>;
    realizeRoot<T>(input: RootRequest, lookup: (scope: RootLookupScope) => Promise<unknown>, realize: (proof: RootRealization) => Promise<T>, verifyOwner?: () => void): Promise<T>;
    beginManagedLaunch(id: string): Promise<void>;
    completeManagedLaunch(id: string, bbThreadId: string): Promise<void>;
};
export {};

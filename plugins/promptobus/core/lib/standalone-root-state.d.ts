import type { NativeAdmissionContext } from './native-admission.js';
import type { ProcessIdentity, RecordVersion, ServicePaths } from './service-state.js';
export type StandaloneRootHarness = 'codex' | 'claude';
export interface StandaloneRootProfile {
    schemaVersion: 1;
    mode: 'standalone';
    id: string;
    harness: StandaloneRootHarness;
    root: string;
    home: string;
    runtime: string;
    nativeStore: string;
    executable: RecordVersion;
    ownerEnvironment: string;
}
export interface StandaloneRootReference {
    file: string;
    nonce: string;
}
export interface StandaloneRootLaunch {
    schemaVersion: 1;
    profile: string;
    root: string;
    home: string;
    runtime: string;
    process: ProcessIdentity;
    cwd: string;
    nonce: string;
    expiresAt: number;
    clientId: string | null;
    nativeId: string | null;
    phase: 'pending' | 'bound';
    revoked: boolean;
    plan: string | null;
    resumeNativeId: string | null;
    identityInvalid?: boolean;
    nativeCommand?: {
        file: string;
        args: string[];
    };
    nativeStart?: {
        source: string;
        transcript: string;
    };
    startupCandidate?: {
        sessionId: string;
        transcript: string;
        capturedAt: number;
        revisions: RecordVersion[];
    };
}
interface RootGrant {
    id: string;
    runtime: string;
    cwd?: string;
    rootLaunch?: StandaloneRootReference;
    lifetime: {
        kind: string;
        process?: ProcessIdentity;
    };
    nativeBinding?: {
        kind: string;
        state: string;
        threadId?: string;
        sessionId?: string;
    };
}
export declare const standaloneProfileFile: (paths: ServicePaths, id: string) => string;
export declare const scopedRootProfile: (value: unknown) => value is string;
export declare function standaloneReference(value: unknown): StandaloneRootReference;
export declare function readStandaloneProfile(paths: ServicePaths, runtime: string, id: string): StandaloneRootProfile;
export declare function readStandaloneLaunch(paths: ServicePaths, runtime: string, reference: StandaloneRootReference): StandaloneRootLaunch;
export declare const pendingStandaloneExpired: (launch: StandaloneRootLaunch) => boolean;
export declare function requireStartupCandidateFence(paths: ServicePaths, launch: StandaloneRootLaunch, profile: StandaloneRootProfile): void;
export declare function claudeStartupTranscript(nativeStore: string, sessionId: string, transcript: string, deferred?: boolean): string | null;
export declare function requireStandaloneRoot(grant: RootGrant, paths: ServicePaths, registration?: boolean, context?: NativeAdmissionContext): Promise<{
    launch: StandaloneRootLaunch;
    profile: StandaloneRootProfile;
} | undefined>;
export declare function publishStandaloneClient(grant: RootGrant, paths: ServicePaths): void;
export declare function standaloneExpired(grant: RootGrant, paths: ServicePaths): boolean;
export declare function standaloneClientRevoked(paths: ServicePaths, clientId: string): boolean;
export declare function prepareStandaloneResume(grant: RootGrant, paths: ServicePaths, context: NativeAdmissionContext): Promise<string | undefined>;
export declare function revokeStandaloneRoot(grant: RootGrant, paths: ServicePaths): void;
/** Exact approved `exec [controls] [--] <prompt>` subset that rust-v0.166.0 dispatches to `thread/start`. */
export declare function codexStandaloneNewExec(args: readonly string[], cwd: string): boolean;
export declare function claimStandaloneIdentity(grant: RootGrant, paths: ServicePaths, nativeId: string, context: NativeAdmissionContext): Promise<void>;
export {};

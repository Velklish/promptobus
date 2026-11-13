import type { ProcessIdentity, ServicePaths } from './service-state.js';
import type { PromptobusHost } from '../dist/index.js';
import type { ServiceClientGrant } from './service.js';
export interface NativeAdmissionBinding {
    harness: 'codex' | 'claude' | 'cursor' | 'opencode';
    nativeStore: string | null;
    nativeId: string;
    source: 'standalone' | 'bb' | 'managed';
    runtime: string;
    ownerKey: string;
    process: ProcessIdentity | null;
    nonce: string;
    profile?: string;
    phase?: 'pending' | 'bound';
    previousNonce?: string;
    previousManaged?: {
        ownerKey: string;
        nativeStore: string | null;
        process: ProcessIdentity | null;
        record: Record<string, unknown>;
    };
}
interface NativeAdmissionLedger {
    schemaVersion: 2;
    root: string;
    home: string;
    bindings: NativeAdmissionBinding[];
}
export interface NativeAdmissionContext {
    host: PromptobusHost;
    env: NodeJS.ProcessEnv;
}
export declare class ManagedNativeRevisionDrift extends Error {
    constructor();
}
export declare function requireKnownNativeOutcomes(paths: ServicePaths, nonce: string): void;
export declare function requireNativeAdmissionState(paths: ServicePaths): void;
export declare function initializeNativeAdmissionState(paths: ServicePaths): void;
export declare function nativeStoreForServiceClient(paths: ServicePaths, grant: ServiceClientGrant, actualId: string): string | null;
export declare function reserveBbNativeSuccessor(paths: ServicePaths, binding: NativeAdmissionBinding, context: NativeAdmissionContext): Promise<void>;
export declare function assertNativeBinding(paths: ServicePaths, binding: NativeAdmissionBinding, context: NativeAdmissionContext): Promise<NativeAdmissionLedger>;
export declare function recordNativeBinding(paths: ServicePaths, binding: NativeAdmissionBinding, context: NativeAdmissionContext, validatePublication?: () => void): Promise<void>;
export declare function requireCurrentNativeBinding(paths: ServicePaths, binding: NativeAdmissionBinding): void;
export declare function reserveExplicitStandaloneResume(paths: ServicePaths, binding: NativeAdmissionBinding, context: NativeAdmissionContext): Promise<NativeAdmissionBinding>;
export declare function standaloneBindingForRecovery(paths: ServicePaths, runtime: string, profile: string, nativeId: string): NativeAdmissionBinding;
export declare function requireManagedNativeBinding(paths: ServicePaths, grant: ServiceClientGrant, context: NativeAdmissionContext): Promise<void>;
export declare function reserveManagedNativeIdentity(paths: ServicePaths, grant: ServiceClientGrant, nativeId: string, context: NativeAdmissionContext): Promise<void>;
export {};

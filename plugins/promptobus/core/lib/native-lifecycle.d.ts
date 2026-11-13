import type { ParticipantV1, TaskV1 } from '../dist/index.js';
import type { LibRegistry } from './driver-runtime.js';
type NativeLaunchView = Pick<ParticipantV1, 'harness' | 'sessionRef' | 'metadata'> & Partial<Pick<ParticipantV1, 'id'>>;
interface NativeRecord {
    ref: string;
    home?: string | null;
    task?: string | null;
    address?: string | null;
    threadId?: string | null;
    launchId?: string | null;
    holderPid?: number | null;
    appPid?: number | null;
    rawToolReceipts?: boolean;
    cwd?: string;
    [key: string]: unknown;
}
interface NativeIdleOptions {
    taskLocked?: boolean;
    sessionDead?: ((participant: ParticipantV1) => boolean) | null;
}
export interface LegacyLaunchBinding {
    ref: string;
    record: string;
    launchId: string;
    deferTaskBinding?: boolean;
    previousParticipant?: ParticipantV1 | null;
}
export declare function ownsLegacyLaunch(home: string, task: string, address: string, expected: LegacyLaunchBinding): boolean;
export declare function requireCurrentNativeLaunch(current: NativeLaunchView | null | undefined, expected: NativeLaunchView | null | undefined): void;
export declare function withNativeStopLocks<T>(record: NativeRecord, fn: () => T, { deadlineAt }?: {
    deadlineAt?: number;
}): T;
export declare function abandonmentAllowsClose(participant: ParticipantV1 | null | undefined, sessionDead: boolean): boolean;
export declare function requireNativeTerminal(home: string | undefined, meta: Pick<TaskV1, 'id' | 'parent'>, participant: ParticipantV1, env?: NodeJS.ProcessEnv, { taskLocked, onVerified, lockWaitMs }?: {
    taskLocked?: boolean;
    onVerified?: () => void;
    lockWaitMs?: number;
}): void;
/** The caller holds the parent and child task locks, in that order. */
export declare function requireNativeRootRoute(home: string, child: TaskV1, route: ParticipantV1, env?: NodeJS.ProcessEnv): void;
export declare function withVerifiedManagedNativeStop(home: string, proof: {
    task: string;
    address: string;
    ref: string;
    launchId: string;
    record: string;
}, env: NodeJS.ProcessEnv, onVerified: (participant: ParticipantV1) => boolean): boolean;
export declare function requireNativeIdle(home: string, meta: TaskV1, address?: string | null, { taskLocked, sessionDead }?: NativeIdleOptions): void;
export declare function retainNativeStop(record: NativeRecord, receiptFile: string): void;
export declare function reserveNativeParticipant(home: string, task: string, participant: ParticipantV1, expected: ParticipantV1 | null | undefined, registry: LibRegistry): Omit<{
    driver: import("../dist/driver.js").Driver;
    meta: TaskV1;
    record: ParticipantV1;
}, "driver"> & {
    driver: import("./driver-runtime.js").LibDriver;
};
export declare function persistNativeParticipant(home: string, task: string, reserved: ParticipantV1, metadata: Record<string, unknown>): TaskV1;
export declare function persistLegacyParticipant(home: string, task: string, participant: ParticipantV1): TaskV1;
export declare function releaseNativeReservation(home: string, task: string, reserved: ParticipantV1): TaskV1 | undefined;
export {};

import { GateError } from './store.js';
import type { ProcessIdentity } from './service-state.js';
import type { ParticipantV1, PromptobusHost } from '../dist/index.js';
import type { LibDriver, LibLaunchPlan, LibSpawnContext } from './driver-runtime.js';
type State = 'alive' | 'dead' | 'unknown';
export interface LiveSeat {
    token: string;
    address: string;
    harness: string;
    ref: string;
    owner: ProcessIdentity | null;
    phase: 'reserved' | 'launching' | 'registered';
    nativeId: string | null;
    record: string | null;
    nativeTask: string;
    nativeAddress: string;
    launchId: string | null;
}
interface Observation {
    state: State;
    nativeId: string | null;
    launchId?: string | null;
    settled?: boolean;
}
export declare const reservationFile: (home: string, task: string) => string;
export declare class LiveAdmissionError extends GateError {
}
export declare function liveReservations(home: string, task: string): LiveSeat[];
export declare function observeLiveRef(harness: string, ref: string, env?: NodeJS.ProcessEnv, primary?: string | null): Observation;
export declare function liveCapNote(host: PromptobusHost, home: string, task: string, harness: string, address: string): string | null;
export declare function reserveLiveSeat(host: PromptobusHost, home: string, task: string, address: string, harness: string, ref: string, env?: NodeJS.ProcessEnv, record?: string | null, native?: {
    task?: string;
    address?: string;
    launchId?: string | null;
    previous?: ParticipantV1 | null;
}): LiveSeat;
export declare function reservedSpawn(driver: LibDriver, plan: LibLaunchPlan, context: LibSpawnContext, { task, address, ...expected }?: {
    task?: string;
    address?: string;
    previous?: ParticipantV1 | null;
}): Promise<import("./driver-runtime.js").LibSpawnResult<object>>;
export declare function recoverLiveSeat(host: PromptobusHost, home: string, task: string, address: string, env?: NodeJS.ProcessEnv): Promise<boolean>;
export declare function requireReservationIdle(home: string, task: string, address: string, env?: NodeJS.ProcessEnv): void;
export declare function withReservationIdle<T>(home: string, task: string, address: string, fn: () => T): T;
export declare function requireNoLiveReservations(host: PromptobusHost, home: string, task: string): void;
export {};

import { preflight } from './model-routing/preflight.js';
import type { LibRegistry } from './driver-runtime.js';
import type { ParticipantV1, SessionSnapshot } from '../dist/index.js';
type SnapshotReader = (participants: ParticipantV1[]) => SessionSnapshot;
type AdapterReader = Parameters<typeof preflight>[0]['adapterFor'];
interface DoneOptions {
    task?: string | null;
    yes?: unknown;
    'older-than'?: unknown;
    'keep-sessions'?: unknown;
    adapterFor?: AdapterReader;
    snapshot?: SnapshotReader;
}
export declare function stopManaged(home: string, id: string, { registry, snapshot }?: {
    registry?: LibRegistry;
    snapshot?: SnapshotReader | null;
}): Promise<{
    stopped: number;
    idle: number;
    failed: number;
    unconfirmed: number;
}>;
export declare function done(rootOrHost: unknown, opts?: DoneOptions): Promise<void>;
export {};

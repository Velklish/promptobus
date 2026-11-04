import type { RecordVersion } from './service-state.js';
import type { TaskWardenResult } from './warden.js';
import type { ParticipantV1, SessionSnapshot, StalledParticipant } from '../dist/index.js';
export interface WardenBootstrap {
    home: string;
    version: string;
    homes: Record<string, string | null>;
    bins: Record<string, string | null>;
}
export type WardenCommand = {
    kind: 'start';
    task: string;
    generation: string;
} | {
    kind: 'abort';
    task: string;
    generation: string;
} | {
    kind: 'observe';
    id: number;
    participants: ParticipantV1[];
    records: RecordVersion[];
} | {
    kind: 'formatted';
    id: number;
    lines?: string[];
    error?: string;
} | {
    kind: 'close';
};
export type WardenEvent = {
    kind: 'ready';
} | {
    kind: 'started';
    task: string;
    generation: string;
} | {
    kind: 'settled';
    task: string;
    generation: string;
    result: TaskWardenResult;
} | {
    kind: 'failed';
    task: string;
    generation: string;
    error: string;
} | {
    kind: 'format';
    id: number;
    task: string;
    fresh: StalledParticipant[];
} | {
    kind: 'observed';
    id: number;
    snapshot?: SessionSnapshot;
    error?: string;
};

import type { MessageV1 } from '../dist/index.js';
export declare function historyMessage(home: string, task: string, addr: string, id: string): MessageV1 | null;
export declare function history(rootOrHost: unknown, { task, participant, limit, all }?: {
    task?: string;
    participant?: string;
    limit?: unknown;
    all?: boolean;
}): void;

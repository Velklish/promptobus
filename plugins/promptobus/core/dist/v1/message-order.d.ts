import type { MessageV1 } from './model.js';
export declare const messageOrderFile: (home: string) => string;
export declare function withMessageCommit<T>(home: string, fn: () => T): T;
export declare function validOrderId(id: unknown): id is string;
export declare function strictCommittedMessages(home: string, task: string): MessageV1[];
export declare function rebuildMessageOrder(home: string): {
    messages: number;
    intents: number;
    fences: number;
    head: string | null;
};
export declare function reserveMessageId(home: string, now: Date): string;

import { humanTerminalIdentity } from './send.js';
export declare function reportQuestion(rootOrHost: unknown, opts?: {
    question?: unknown;
    task?: string;
    [key: string]: unknown;
}, context?: Parameters<typeof humanTerminalIdentity>[2]): Promise<{
    threadId: string | null | undefined;
    turnId: {};
    text: string;
}>;

import { resolveIdentity } from './store.js';
import type { PromptobusHost, TaskV1 } from '../dist/index.js';
export interface GuardInput {
    isTTY?: boolean;
    setEncoding(encoding: BufferEncoding): unknown;
    destroy?(): unknown;
    [Symbol.asyncIterator](): AsyncIterator<unknown>;
}
interface GuardArgs {
    role?: unknown;
    task?: unknown;
    home?: unknown;
    rootProfile?: string;
    standaloneProfile?: string;
    serviceHome?: string;
    clientFile?: string;
    host?: PromptobusHost | null;
}
type Identity = ReturnType<typeof resolveIdentity>;
interface ProbeResult {
    dead: boolean;
    error: string | null;
}
export declare const GUARD_MARK = "LOOP GUARD";
export declare const GUARD_BLOCK_LIMIT = 2;
export declare function guardMarkFile(home: string, task: string, addr: string): string;
export declare function successorMarkFile(home: string, task: string, session: unknown): string;
export declare function readEvent(stdin: GuardInput): Promise<Record<string, unknown>>;
export declare function guardVerdict(home: string, task: string, addr: string, session?: string | null): {
    key: string;
    reason: string;
} | null;
export declare function declaredParticipant(identity: {
    role?: unknown;
} | null | undefined): boolean;
export declare function probeContactPoint(socketPath: string | null | undefined, timeoutMs?: number): Promise<ProbeResult>;
export declare function successorLine(meta: Pick<TaskV1, 'id' | 'title'>, owner: string, deadSince: unknown, unread: number): string;
export declare function successorHint(identity: Identity, cwd: string, session: string | null, event: Record<string, unknown> | null | undefined, probe?: typeof probeContactPoint, host?: PromptobusHost | null): Promise<{
    code: number;
    payload: {
        hookSpecificOutput: {
            hookEventName: string;
            additionalContext: string;
        };
        systemMessage: string;
    } | {
        hookSpecificOutput?: undefined;
        systemMessage: string;
    };
} | null>;
export declare function guard(args?: GuardArgs, env?: NodeJS.ProcessEnv, cwd?: string, stdin?: GuardInput): Promise<void>;
export {};

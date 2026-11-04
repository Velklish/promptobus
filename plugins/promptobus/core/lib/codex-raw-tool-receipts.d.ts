interface ToolOutcome {
    terminal: boolean;
    exitCode: number | null;
    running: boolean;
    sessionId?: string | null;
    unresolved?: string;
}
interface RawToolItem {
    type?: string;
    name?: string;
    input?: string | null;
    call_id?: unknown;
    arguments?: string;
    output?: unknown;
}
interface RawToolMessage {
    method?: string;
    params?: {
        threadId?: unknown;
        turnId?: unknown;
        item?: RawToolItem | null;
    } | null;
}
export interface ExecutionContext {
    launchId: string;
    threadId: string;
    cwd: string;
}
export interface CommandCall {
    callId: string;
    turnId: string;
    type: string;
    exec: boolean;
    sessionId: string | null;
    ownerCallId: string | null | undefined;
    command: string | null;
    cwd: string | null;
    processId: string | null | undefined;
    outcome: ToolOutcome | null;
    finalOutcome: ToolOutcome | null;
}
interface ObservedCommand {
    itemId: string;
    turnId?: string | null;
    command?: string;
    cwd?: string;
    processId?: string | null;
    exitCode?: number | null;
}
export declare function singleCodeToolCall(input: string): {
    name: string;
    args: Record<string, unknown>;
} | null;
export declare function toolResultOutcome(output: unknown, legacy?: boolean): ToolOutcome;
export declare function rawToolReceipts(append: (kind: string, data: {
    notification: RawToolMessage;
}) => unknown, fail: (reason: string) => unknown, identity?: {
    launchId?: unknown;
    cwd?: unknown;
}): {
    context(kind: string, data: Record<string, unknown>): void;
    observe(msg: RawToolMessage, threadId: string | null | undefined): void;
    snapshot(commands: readonly ObservedCommand[]): {
        calls: CommandCall[];
        bindings: {
            itemId: string;
            callId: string;
            turnId: string | null | undefined;
            requestedCommand: string | null;
            command: string | undefined;
            cwd: string | undefined;
            exitCode: number | null | undefined;
            cwdSource?: string;
            defaultContext?: ExecutionContext;
        }[];
        pending: string[];
        refusedEnvelopes?: {
            threadId: string;
            turnId: string | null;
            callId: string | null;
        }[] | undefined;
    };
};
export {};

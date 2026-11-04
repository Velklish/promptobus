interface CommandItem {
    itemId: string;
    completed?: boolean;
    exitCode?: number | null;
    status?: string;
    threadId?: string | null;
    turnId?: string | null;
    command?: string;
    cwd?: string;
    processId?: string | null;
    aggregatedOutput?: string | null;
    [key: string]: unknown;
}
interface ReceiptIdentity {
    ref: string;
    launchId?: string | null;
    task?: string | null;
    address?: string | null;
    threadId?: string | null;
    cwd?: string;
    rawToolReceipts?: boolean;
    holderPid?: number | null;
    appPid?: number | null;
    [key: string]: unknown;
}
interface CommandNotification {
    method: string;
    params?: {
        threadId?: string;
        turnId?: string | null;
        id?: string;
        status?: string;
        turn?: {
            id?: string;
            status?: string;
        };
        itemId?: string;
        delta?: string;
        item?: {
            type?: string;
            id?: string;
            command?: string;
            cwd?: string;
            processId?: string | null;
            status?: string;
            exitCode?: number | null;
            aggregatedOutput?: string | null;
        };
    };
}
export declare function commandReceipts(file: string, identity: ReceiptIdentity): {
    file: string;
    append: (kind: string, data: object) => boolean;
    context(kind: string, data: Record<string, unknown>): void;
    fail: (reason: string) => void;
    observe(msg: CommandNotification, threadId: string): void;
    snapshot(): {
        file: string;
        error: string | null;
        envelopeOnlyFailure: boolean;
        commands: CommandItem[];
        rawTools: {
            calls: import("./codex-raw-tool-receipts.js").CommandCall[];
            bindings: {
                itemId: string;
                callId: string;
                turnId: string | null | undefined;
                requestedCommand: string | null;
                command: string | undefined;
                cwd: string | undefined;
                exitCode: number | null | undefined;
                cwdSource?: string;
                defaultContext?: import("./codex-raw-tool-receipts.js").ExecutionContext;
            }[];
            pending: string[];
            refusedEnvelopes?: {
                threadId: string;
                turnId: string | null;
                callId: string | null;
            }[] | undefined;
        } | null;
        pending: string[];
    };
};
export declare function readStopConfirmation(file: string, record: ReceiptIdentity): {
    ok: boolean;
    receiptFile: string;
    note?: undefined;
} | {
    receiptFile?: undefined;
    ok: boolean;
    note: string;
};
export {};

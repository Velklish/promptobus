export type ReviewerTool = {
    name: string;
    description: string;
    inputSchema: unknown;
};
export declare const REVIEW_FILE_TOOLS: {
    name: string;
    description: string;
    inputSchema: unknown;
}[];
export declare const reviewerFiles: (roots: string[], canonicalFiles?: string[]) => (name: string, args: unknown) => unknown;
export declare const BB_REVIEWER_TOOLS: string[];
export declare const BB_REVIEWER_PROTOCOL_TOOLS: string[];
export declare const BB_REVIEWER_HOST_TOOLS: string[];
export declare function reviewerTools(tools?: ReviewerTool[]): ReviewerTool[];
export declare function reviewerProfile({ cwd, model, effort, instructions, tools }: {
    cwd: string;
    model: string;
    effort?: string;
    instructions?: string;
    tools?: ReviewerTool[];
}): Record<string, unknown>;
export declare function verifyReviewerProfile(value: unknown, model: string): void;
export declare function verifyReviewerConfig(value: unknown): void;
export declare function queryBbReviewer(input: {
    directory: string;
    signal?: AbortSignal;
}, method: string, params?: unknown): Promise<any>;
export declare function openBbReviewer(input: {
    directory: string;
    model: string;
    effort?: string;
    instructions?: string;
    tools?: ReviewerTool[];
    threadId?: string | null;
    invoke: (params: {
        threadId: string;
        turnId: string | null;
        callId: string;
        tool: string;
        arguments: Record<string, unknown>;
    }) => Promise<unknown>;
    notify?: (message: {
        method: string;
        params?: any;
    }) => void;
    executable?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
}): Promise<{
    threadId: string;
    pid: number;
    profile: unknown;
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    close: () => Promise<void>;
}>;

export type ReviewerTool = { name: string; description: string; inputSchema: unknown };
export const BB_REVIEWER_TOOLS: string[];
export const BB_REVIEWER_CODEX_VERSION: string;
export function reviewerTools(tools?: ReviewerTool[]): ReviewerTool[];
export function reviewerProfile(input: { cwd: string; model: string; effort?: string; instructions?: string; tools?: ReviewerTool[] }): Record<string, unknown>;
export function verifyReviewerProfile(result: unknown, model: string): void;
export function verifyReviewerConfig(config: unknown): void;
export function queryBbReviewer(input: { directory: string; signal?: AbortSignal }, method: string, params?: unknown): Promise<any>;
export const REVIEW_FILE_TOOLS: { name: string; description: string; inputSchema: unknown }[];
export function reviewerFiles(roots: string[], canonicalFiles?: string[]): (name: string, args: unknown) => unknown;
export function openBbReviewer(input: {
  directory: string; model: string; effort?: string; instructions?: string; tools?: ReviewerTool[]; threadId?: string | null;
  invoke: (params: { threadId: string; turnId: string | null; callId: string; tool: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  notify?: (message: { method: string; params?: any }) => void; executable?: string; env?: Record<string, string | undefined>; signal?: AbortSignal;
}): Promise<{ threadId: string; pid: number; profile: unknown; request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>; close: () => Promise<void> }>;

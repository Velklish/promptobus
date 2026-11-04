type ToolProperties = Record<string, unknown>;
interface ReadResult {
    path: string;
    start_line: number;
    total_lines: number;
    lines: {
        line: number;
        text: string;
    }[];
}
interface FileMatch {
    path: string;
    relative_path?: string;
    line?: number;
    text?: string;
}
export declare const REVIEW_FILE_TOOLS: {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: ToolProperties;
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        openWorldHint: boolean;
    };
}[];
export declare function reviewerFiles(roots: unknown, canonicalFiles?: unknown): (name: string, args: Record<string, unknown>) => ReadResult | {
    files: ReadResult[];
} | {
    matches: FileMatch[];
    truncated: boolean;
};
export {};

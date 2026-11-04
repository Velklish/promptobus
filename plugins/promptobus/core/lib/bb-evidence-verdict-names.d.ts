export declare function extractNodeTestVerdictNames(raw: unknown): {
    complete: boolean;
    names: string[];
    reason: string;
} | {
    complete: boolean;
    names: string[];
    reason: null;
};

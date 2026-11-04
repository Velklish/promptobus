export declare const codexPrompts: {
    workerOrchestrator: string;
    rootPreamble: ({ task, root }: {
        task: string;
        root: string;
    }) => string;
    mcpBoundary: string;
    reviewerCommands: {
        isolation: string;
        procedureSkip: string;
        record: string;
        gate: string;
    };
    promptRules: string;
    promptRulesFor: (role: string) => string;
};

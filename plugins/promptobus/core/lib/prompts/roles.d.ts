export interface ParticipantTools {
    promptobus_send: string;
    promptobus_mailbox: string;
    promptobus_task: string;
}
interface ParticipantBindings {
    tools: ParticipantTools;
    memory: string;
    contacts: string;
}
export interface WorkerInstructionInput {
    brief: string;
    rules: readonly string[];
    bindings: ParticipantBindings & {
        preamble: string;
        workspace: string;
        repositorySkills: string;
        dependencies: string;
        lease: string;
        orchestrator: string;
        communication: string;
        wait: string;
        answerDelivery: string;
        reviewDelivery: string;
        branchDelivery: string;
        operationalRules: string;
        artifactDelivery?: string;
        evidenceInstructions?: string;
    };
}
export interface ReviewerInstructionInput {
    taskId: string;
    nsPath: string;
    repoDir: string;
    address: string;
    stepName: string;
    rules: readonly string[];
    reviewSubject: string;
    instructionsSection: string;
    procedureText: string;
    bindings: ParticipantBindings & {
        mcpBoundary: string;
        reviewerCommands: {
            isolation: string;
            procedureSkip: string;
            record: string;
            gate: string;
        };
        communication: string;
        externalReads: string;
        wait: string;
        close: string;
        operationalRules: string;
        evidenceInstructions?: string;
        reportInstructions?: string;
        reportSend?: string;
    };
}
export interface ApproverInstructionInput {
    taskId: string;
    nsPath: string;
    address: string;
    stepName: string;
    reviewAddr: string;
    rules: readonly string[];
    mcpBoundary?: string | null;
    brief?: string | null;
    instructionsSection: string;
    bindings: ParticipantBindings & {
        workspace: string;
        acceptance: string;
        workerContext: string;
        workerContact: string;
        repositorySkills: string;
        dependencies: string;
        lease: string;
        communication: string;
        wait: string;
        evidenceInstructions?: string;
    };
}
export interface TeamleadInstructionInput {
    rootTask: string;
    childTask: string;
    address: string;
    rootAddress: string;
    root: string;
    brief: string;
    siblings: readonly string[];
    rules: readonly string[];
    bindings: ParticipantBindings & {
        entry: string;
        installationNote: string;
        secondaryMailbox: string;
        lease: string;
    };
}
export interface ReporterInstructionInput {
    task: string;
    root: string;
    rules: readonly string[];
    bindings: {
        tools: {
            promptobus_send: string;
            promptobus_task: string;
            promptobus_digest: string;
            promptobus_status: string;
            promptobus_ask: string;
        };
        contacts: string;
        answerChannel: string;
        journalSources: string;
        digestView: string;
        journalBody: string;
        fileBoundary: string;
    };
}
export interface OrchestratorInstructionInput {
    rules: readonly string[];
    brief: string;
    bindings: {
        tools: ParticipantTools;
        preamble: string;
        delivery: string;
        operationalRules: string;
    };
}
export declare function renderWorkerInstructions({ brief, rules, bindings }: WorkerInstructionInput): string;
export declare function renderTeamleadInstructions({ rootTask, childTask, address, rootAddress, root, brief, siblings, rules, bindings }: TeamleadInstructionInput): string;
export declare function renderReviewerInstructions({ taskId, nsPath, repoDir, address, stepName, rules, reviewSubject, instructionsSection, procedureText, bindings }: ReviewerInstructionInput): string;
export declare function renderApproverInstructions({ taskId, nsPath, address, stepName, reviewAddr, rules, mcpBoundary, brief, instructionsSection, bindings }: ApproverInstructionInput): string;
export declare function renderReporterInstructions({ task, root, rules, bindings }: ReporterInstructionInput): string;
export declare function renderOrchestratorInstructions({ rules, brief, bindings }: OrchestratorInstructionInput): string;
export declare function renderReviewProcedure(skill: {
    dir: string;
    shared?: string | null;
} | null, reviewerCommands: ReviewerInstructionInput['bindings']['reviewerCommands']): string;
export {};

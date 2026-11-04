import type { HostContextRef, HostParticipantContextTask, HostTaskContextDeclaration, PreparedHostParticipantContextSelection, PromptobusHost } from '../dist/index.js';
export type ParticipantContextHost = Pick<PromptobusHost, 'selectParticipantContext' | 'resolveRepoModule' | 'reviewSkillDir'>;
export interface ParticipantContextCeiling {
    task: HostParticipantContextTask;
    rules: {
        path: string;
        reason: string;
        requires: string[];
    }[];
    skills: {
        name: string;
        root: string;
        sourceRoot?: string;
        reason: string;
        requires?: HostContextRef[];
    }[];
    resources?: PreparedHostParticipantContextSelection['resources'];
}
export declare function normalizeContextDeclaration(value: unknown): HostTaskContextDeclaration;
export declare function selectParticipantContext(host: ParticipantContextHost, { root, role, task, preparedSelection: prepared }: {
    root: string;
    role: string;
    task?: HostParticipantContextTask;
    preparedSelection?: ParticipantContextCeiling | null;
}): PreparedHostParticipantContextSelection | null;

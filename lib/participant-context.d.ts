import type { HostContextRef, HostParticipantContextTask, HostTaskContextDeclaration, PreparedHostParticipantContextSelection, PromptobusHost } from '../dist/index.js';

export type ParticipantContextHost = Pick<PromptobusHost, 'selectParticipantContext' | 'resolveRepoModule' | 'reviewSkillDir'>;
export interface ParticipantContextCeiling {
  task: HostParticipantContextTask;
  rules: { path: string; reason: string; requires: string[] }[];
  skills: { name: string; root: string; sourceRoot?: string; reason: string; requires?: HostContextRef[] }[];
  resources?: PreparedHostParticipantContextSelection['resources'];
}
export function normalizeContextDeclaration(value: unknown): HostTaskContextDeclaration;
export function selectParticipantContext(host: ParticipantContextHost, input: {
  root: string; role: string; task?: HostParticipantContextTask;
  preparedSelection?: ParticipantContextCeiling;
}): PreparedHostParticipantContextSelection | null;

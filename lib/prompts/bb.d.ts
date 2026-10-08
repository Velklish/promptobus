import type { APPROVER, ORCHESTRATOR, REVIEWER, WORKER } from '../../dist/registry.js';
export type BbInstructionRole = typeof WORKER | typeof REVIEWER | typeof APPROVER | typeof ORCHESTRATOR | 'teamlead' | 'reporter';
export const BB_ROLE_SKILLS: Readonly<Record<BbInstructionRole, string>>;
export function renderBbInstructionSkill(role: BbInstructionRole): string;
export function createBbInstructionDelivery(role: BbInstructionRole, context: {
  taskId: string;
  address: string;
  environmentId: string;
  workspace: string;
  assignment: string;
  tools: Readonly<Record<string, string>>;
  workerAddress?: string | null;
  allowDirectWorkerMessages?: boolean;
  snapshot?: { head: string; base: string; dirty: boolean; diffPath: string };
  gateRecords?: readonly string[];
}): { configuration: { tools: string[]; skills: string[]; instructions: string }; initialPrompt: string };

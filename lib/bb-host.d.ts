import type { PromptobusHost } from '../dist/index.js';

export interface BbHostContext {
  rules: { path: string; text: string }[];
  skills: { name: string; path: string; text: string; root: string }[];
  tools: { server: string; tool: string; description: string; inputSchema: unknown; access: 'read' | 'write' }[];
}
export interface BbHostInput { root: string; role: string; signal?: AbortSignal }
export interface BbCanonicalTool { name: string; description: string; inputSchema: unknown; access: 'read' | 'write' }
export type BbContextHost = Pick<PromptobusHost, 'collectRules' | 'skillsDir' | 'resolveRepoModule' | 'reviewSkillDir'
  | 'participantServers' | 'participantDenyTools' | 'participantDenyToolsByKind' | 'pipeline'>;
export interface BbCanonicalInput {
  server: string; configuration: unknown; root: string; signal?: AbortSignal;
}
export interface BbCanonicalCall extends BbCanonicalInput {
  tool: string; args: Record<string, unknown>; role: string; actor: { task: string; participant: string };
}
export interface BbHostIntegration {
  prepare(input: BbHostInput): Promise<BbHostContext>;
  collect(input: BbHostInput): Promise<BbHostContext>;
  read(input: BbHostInput & { path: string; start_line?: number; line_count?: number }): Promise<unknown>;
  invoke(input: BbHostInput & { server: string; tool: string; args: Record<string, unknown>; actor: BbCanonicalCall['actor'] }): Promise<unknown>;
}
export function createBbHostIntegration(options: {
  resolveHost(root: string): BbContextHost | Promise<BbContextHost>;
  listTools?(input: BbCanonicalInput): Promise<BbCanonicalTool[]>;
  invokeTool?(input: BbCanonicalCall): Promise<unknown>;
  prepareEnvironment?(input: BbHostInput): void | Promise<void>;
}): BbHostIntegration;
export function renderBbHostContext(context: BbHostContext): string;

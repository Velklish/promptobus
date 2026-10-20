import type { HostParticipantContextTask, MessageV1, PreparedHostParticipantContextSelection, PromptobusHost, TaskV1 } from '../dist/index.js';
import type { ParticipantContextCeiling } from './participant-context.js';

export type BbHostSelection = ParticipantContextCeiling;
export interface BbHostContext {
  rules: { path: string; text: string }[];
  skills: { name: string; path: string; text: string; root: string }[];
  resources?: PreparedHostParticipantContextSelection['resources'];
  tools: { server: string; tool: string; description: string; inputSchema: unknown; access: 'read' | 'write' }[];
  selection?: BbHostSelection;
}
export interface BbHostInput {
  root: string; role: string; task?: HostParticipantContextTask; preparedContext?: BbHostContext; signal?: AbortSignal;
}
export interface BbCanonicalTool { name: string; description: string; inputSchema: unknown; access: 'read' | 'write' }
export type BbContextHost = Pick<PromptobusHost, 'collectRules' | 'skillsDir' | 'resolveRepoModule' | 'reviewSkillDir'
  | 'participantServers' | 'participantDenyTools' | 'participantDenyToolsByKind' | 'pipeline' | 'selectParticipantContext'>;
export interface BbCanonicalInput {
  server: string; configuration: unknown; root: string; signal?: AbortSignal;
}
export interface BbCanonicalCall extends BbCanonicalInput {
  tool: string; args: Record<string, unknown>; role: string; actor: { task: string; participant: string };
}
export interface BbHostIntegration {
  checkStep(input: { home: string; taskId: string; taskMeta: TaskV1; stepName: string; slug: string; repoDir: string; facts?: { task: TaskV1; messages: MessageV1[] }; signal?: AbortSignal }): Promise<void>;
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
export function extractNodeTestVerdictNames(raw: string): { complete: boolean; names: string[]; reason: string | null };
export function assertBbDirectCommand(command: readonly string[]): void;

export interface DirectCommandReceipt { command: string[]; by: string; cwd: string; complete: boolean; exit: number | null; signal: string | null; error: string | null; [key: string]: unknown }
export function recordBbDirectCommand(input: { command: string[]; stem: string; by: string; cwd?: string; env?: NodeJS.ProcessEnv;
  beforeSpawn?: (start: () => import('node:child_process').ChildProcessWithoutNullStreams) => import('node:child_process').ChildProcessWithoutNullStreams;
  onReceipt?: (receipt: DirectCommandReceipt) => void; receiptFields?: Record<string, unknown>;
  spawnPlan?: { file: string; args: string[]; verbatim?: boolean } }): Promise<{ receipt: DirectCommandReceipt; exitCode: number }>;
export function leaseRoot(env?: NodeJS.ProcessEnv): string;
export function underLease<T>(root: string, me: { pid: number; address: string; task: string; command: string; cwd: string }, fn: (lock: string) => Promise<T>,
  options: { key: string; waitMs?: number; retryMs?: number; log?: (line: string) => void }): Promise<T>;
export function keyedCommandPlan(command: string[], env: NodeJS.ProcessEnv, locks: string[]): { file: string; args: string[]; verbatim: boolean };

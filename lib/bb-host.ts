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

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extractNodeTestVerdictNames as extractVerdictNames } from './bb-evidence-verdict-names.js';
import { underLease as runUnderLease, keyedCommandPlan as coreCommandPlan } from './lease.js';
export { leaseRoot } from './lease.js';
export { assertBbDirectCommand } from './bb-direct-command.js';
import { recordBbDirectCommand as recordDirectCommand } from './bb-direct-command.js';
import path from 'node:path';
import { reviewerFiles } from './reviewer-files.js';
import { selectParticipantContext } from './participant-context.js';
import { hostDenyClassification, requireStepResults } from './review.js';
import type { DenyEntry } from './review.js';
import { registryOf, roleEntry, REVIEWER } from '../dist/index.js';
import { DEFAULT_PIPELINE, pipelineOf, pipelineSteps } from '../dist/pipeline.js';

const readText = (file: string) => {
  const canonical = realpathSync(file);
  if (!statSync(canonical).isFile() || statSync(canonical).size > 256 * 1024) throw new Error('Host context requires a text file of at most 256 KiB');
  const bytes = readFileSync(canonical);
  if (bytes.includes(0)) throw new Error('Host context cannot contain binary files');
  return { path: canonical, text: bytes.toString('utf8') };
};

export function renderBbHostContext(context: BbHostContext): string {
  return [...(context.selection ? [`Selected Host task: ${JSON.stringify(context.selection.task.id)}. Context purpose: ${JSON.stringify(context.selection.task.purpose)}.`] : []),
    'Host rules below are ordered highest priority first. Earlier rules win on conflict.',
    ...context.rules.map(rule => `Host rule ${rule.path}:\n${rule.text}`),
    ...context.skills.map(skill => `Canonical Host skill ${skill.name} (${skill.path}):\n${skill.text}`),
    ...(context.resources ?? []).map(resource => `Declared Host resource ${resource.path}: ${resource.reason}`),
    'Read additional declared rule/skill resources and exact declared files with promptobus_host_context. Call canonical tools through promptobus_host_call.',
    `Admitted canonical tools: ${JSON.stringify(context.tools)}`].join('\n\n');
}

interface BbHostOptions {
  resolveHost(root: string): BbContextHost | Promise<BbContextHost>;
  listTools?(input: BbCanonicalInput): Promise<BbCanonicalTool[]>;
  invokeTool?(input: BbCanonicalCall): Promise<unknown>;
  prepareEnvironment?(input: BbHostInput): void | Promise<void>;
}
export function createBbHostIntegration(options: BbHostOptions): BbHostIntegration;
export function createBbHostIntegration({ resolveHost, listTools, invokeTool, prepareEnvironment }: Partial<BbHostOptions> = {}): BbHostIntegration {
  if (typeof resolveHost !== 'function') throw new Error('A consumer-owned Host resolver is required');
  const gather = async (input: BbHostInput) => {
    const { root, role, signal, preparedContext } = input;
    signal?.throwIfAborted();
    const host = await resolveHost(root);
    if (preparedContext && typeof host.selectParticipantContext === 'function' && !preparedContext.selection) throw new Error('Host context task selection changed; prepare context again');
    const selection = selectParticipantContext(host, { root, role, task: input.task, preparedSelection: preparedContext?.selection });
    let rules: BbHostContext['rules'], skills: BbHostContext['skills'];
    const resourceRoots: string[] = [];
    if (selection) {
      rules = selection.rules.map(rule => {
        try { return readText(rule.path); } catch (failure) {
          const parent = selection.rules.find(source => source.requires.includes(rule.path))?.path;
          throw new Error(`${parent ? `Required Host rule ${parent} -> ${rule.path}` : `Selected Host resource ${rule.path}`} unavailable: ${(failure as Error).message}`);
        }
      });
      skills = selection.skills.map(skill => ({ name: skill.name, ...readText(path.join(skill.root, 'SKILL.md')), root: skill.root }));
    } else {
      rules = [...new Set(host.collectRules(root))].map(readText);
      skills = [];
      const source = host.skillsDir(root);
      if (source) for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new Error(`BB Host context refuses symlink skill entries: ${entry.name}`);
        if (!entry.isDirectory()) continue;
        if (entry.name === '_shared') {
          resourceRoots.push(realpathSync(path.join(source, entry.name)));
          continue;
        }
        const skill = readText(path.join(source, entry.name, 'SKILL.md'));
        skills.push({ name: entry.name, ...skill, root: realpathSync(path.join(source, entry.name)) });
      }
      const module = host.resolveRepoModule(root);
      const reviewSkill = role === REVIEWER && module?.meta?.review?.skill;
      if (reviewSkill && !skills.some(skill => skill.name === reviewSkill)) {
        const directory = host.reviewSkillDir(reviewSkill, root);
        skills.push({ name: reviewSkill, ...readText(path.join(directory, 'SKILL.md')), root: realpathSync(directory) });
      }
    }
    const { servers, external } = host.participantServers(root);
    if (external.length) throw new Error('Host canonical server delivery is incomplete');
    const names = Object.keys(servers);
    if (names.length && (typeof listTools !== 'function' || typeof invokeTool !== 'function')) throw new Error('A consumer-owned canonical tool adapter is required');
    const tools = (await Promise.all(names.map(async server => {
      const catalog = await listTools!({ server, configuration: servers[server], root, signal });
      return catalog.map(tool => {
        if (!tool.name || !['read', 'write'].includes(tool.access)) throw new Error('Canonical tools require explicit read/write access classification');
        return { server, tool: tool.name, description: tool.description, inputSchema: tool.inputSchema, access: tool.access };
      });
    }))).flat();
    const constrained = role === REVIEWER || role === 'reporter';
    const denied = constrained ? hostDenyClassification(host, roleEntry(registryOf(host as PromptobusHost), role === 'reporter' ? REVIEWER : role) as DenyEntry, names, root) : null;
    if (denied && !denied.complete) throw new Error('Host canonical write-tool classification is incomplete');
    const isDenied = (tool: BbHostContext['tools'][number]) => denied?.tools.some(write => write.server === tool.server && write.tool === tool.tool);
    if (constrained && tools.some(tool => tool.access === 'write' && !isDenied(tool))) throw new Error('Host canonical write-tool classification omits a declared write');
    const context = { rules, skills, tools: tools.filter(tool => !isDenied(tool) && (!selection || !preparedContext || preparedContext.tools.some(prior =>
      prior.server === tool.server && prior.tool === tool.tool && (prior.access === 'write' || tool.access === 'read')))), ...(selection ? { resources: selection.resources, selection } : {}) };
    if (Buffer.byteLength(JSON.stringify(context)) > 1024 * 1024) throw new Error('Host context exceeds 1 MiB');
    signal?.throwIfAborted();
    return { context, servers, resourceRoots };
  };
  return {
    async checkStep(input) {
      input.signal?.throwIfAborted();
      const host = await resolveHost(input.repoDir);
      const steps = pipelineOf(host as PromptobusHost), supported = pipelineSteps(DEFAULT_PIPELINE);
      if (steps.length !== supported.length || steps.some((step, index) => step.name !== supported[index].name || step.kind !== supported[index].kind)) {
        throw new Error('BB requires the shipped worker/reviewer/approver pipeline');
      }
      requireStepResults(host, input);
      input.signal?.throwIfAborted();
    },
    async prepare(input) { input.signal?.throwIfAborted(); await prepareEnvironment?.(input); return (await gather({ ...input, preparedContext: undefined })).context; },
    async collect(input) { return (await gather(input)).context; },
    async read(input) {
      const { context, resourceRoots } = await gather(input);
      const exactFiles = [...context.rules.map(rule => rule.path), ...(context.resources ?? []).map(resource => resource.path)];
      const roots = [...exactFiles, ...context.skills.map(skill => skill.root), ...resourceRoots];
      if (!roots.length) throw new Error('No Host context resources are declared');
      return reviewerFiles(roots, exactFiles)('read_file', {
        path: input.path, start_line: input.start_line, line_count: input.line_count,
      });
    },
    async invoke(input) {
      const { context, servers } = await gather(input);
      if (!context.tools.some(tool => tool.server === input.server && tool.tool === input.tool)) throw new Error('Canonical tool is not admitted for this participant');
      input.signal?.throwIfAborted();
      return invokeTool!({ server: input.server, configuration: servers[input.server], tool: input.tool, args: input.args,
        root: input.root, role: input.role, actor: input.actor, signal: input.signal });
    },
  };
}

export interface DirectCommandReceipt { command: string[]; by: string; cwd: string; complete: boolean; exit: number | null; signal: string | null; error: string | null; [key: string]: unknown }

export function recordBbDirectCommand(input: { command: string[]; stem: string; by: string; cwd?: string; env?: NodeJS.ProcessEnv;
  beforeSpawn?: (start: () => import('node:child_process').ChildProcessWithoutNullStreams) => import('node:child_process').ChildProcessWithoutNullStreams;
  onReceipt?: (receipt: DirectCommandReceipt) => void; receiptFields?: Record<string, unknown>;
  spawnPlan?: { file: string; args: string[]; verbatim?: boolean } }): Promise<{ receipt: DirectCommandReceipt; exitCode: number }> {
  return recordDirectCommand(input as Parameters<typeof recordDirectCommand>[0]) as Promise<Awaited<ReturnType<typeof recordDirectCommand>> & { receipt: DirectCommandReceipt }>;
}

export function underLease<T>(root: string, me: { pid: number; address: string; task: string; command: string; cwd: string }, fn: (lock: string) => Promise<T>,
  options: { key: string; waitMs?: number; retryMs?: number; log?: (line: string) => void }): Promise<T> {
  return runUnderLease(root, me, fn as (lock?: string) => Promise<T>, options);
}
export const keyedCommandPlan: (command: string[], env: NodeJS.ProcessEnv, locks: string[]) => { file: string; args: string[]; verbatim: boolean } = coreCommandPlan;

export const extractNodeTestVerdictNames: (raw: string) => { complete: boolean; names: string[]; reason: string | null } = extractVerdictNames;

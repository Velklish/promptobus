import { z } from 'zod';
import path from 'node:path';
import { MESSAGE_TYPES, PARTICIPANT_ID_RE, TASK_ID_RE } from 'promptobus';
import { BB_ROLE_SKILLS } from 'promptobus/instructions';
import { launchContextSchema } from './launch-context.js';
import { evidenceManifestSchema } from './review-evidence.js';

export const roleSchema = z.enum(Object.keys(BB_ROLE_SKILLS) as [keyof typeof BB_ROLE_SKILLS, ...(keyof typeof BB_ROLE_SKILLS)[]]);
export const reasoningSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none', 'ultracode']);
export const executionSchema = z.object({
  runtime: z.literal('bb'), harness: z.enum(['codex', 'cursor', 'opencode']),
  providerId: z.enum(['codex', 'promptobus-codex-reviewer', 'acp-cursor', 'acp-opencode']),
  providerSource: z.enum(['role', 'explicit']), model: z.string().min(1), nativeModel: z.string().min(1),
  requestedModel: z.string().min(1), reasoningLevel: reasoningSchema, reasoningSource: z.enum(['catalog', 'explicit']),
  observedAt: z.string(), scope: z.object({ hostId: z.string(), environmentId: z.string().nullable() }).strict(),
  health: z.enum(['ready', 'unknown']),
  quota: z.object({ status: z.enum(['known', 'unknown']), reason: z.string().nullable(),
    windows: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable() }).strict()),
  }).strict(),
}).strict();
export type ExecutionSelection = z.infer<typeof executionSchema>;
export const contextPurposeSchema = z.enum(['technical', 'user-facing', 'author-voice']);
const contextNameSchema = z.string().regex(/^(?!\.{1,2}$)[^\\/\0]+$/).regex(/\S/);
const contextReasonSchema = z.string().regex(/^[^\0]+$/).regex(/\S/);
const contextPathSchema = z.string().regex(path.sep === '/' ? /^\/[^\0]*$/ : /^(?:[A-Za-z]:[\\/]|\\\\)[^\0]*$/);
export const contextRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('skill'), name: contextNameSchema }).strict(),
  z.object({ kind: z.literal('rule'), path: contextPathSchema }).strict(),
  z.object({ kind: z.literal('resource'), path: contextPathSchema }).strict(),
]);
export const contextDeclarationSchema = z.object({
  skills: z.array(z.object({ name: contextNameSchema, reason: contextReasonSchema, requires: z.array(contextRefSchema).optional() }).strict()),
  resources: z.array(z.object({ path: contextPathSchema, reason: contextReasonSchema, requires: z.array(contextRefSchema).optional() }).strict()),
}).strict();
const selectedResourceSchema = z.object({ path: z.string().min(1), sourcePath: z.string().min(1), reason: z.string().min(1), requires: z.array(contextRefSchema) }).strict();
export const hostContextSchema = z.object({
  rules: z.array(z.object({ path: z.string(), text: z.string() }).strict()),
  skills: z.array(z.object({ name: z.string(), path: z.string(), text: z.string(), root: z.string() }).strict()),
  tools: z.array(z.object({ server: z.string(), tool: z.string(), description: z.string(), inputSchema: z.unknown(), access: z.enum(['read', 'write']) }).strict()),
  resources: z.array(selectedResourceSchema).optional(),
  selection: z.object({
    task: z.object({ id: z.string().min(1), purpose: contextPurposeSchema, context: contextDeclarationSchema.optional() }).strict(),
    rules: z.array(z.object({ path: z.string().min(1), reason: z.string().min(1), requires: z.array(z.string().min(1)) }).strict()),
    skills: z.array(z.object({ name: z.string().min(1), root: z.string().min(1), sourceRoot: z.string().min(1).optional(), reason: z.string().min(1), requires: z.array(contextRefSchema).optional() }).strict()),
    resources: z.array(selectedResourceSchema).optional(),
  }).strict().optional(),
}).strict();
export const hostReadSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inspect') }).strict(),
  z.object({ mode: z.literal('read'), path: z.string().min(1), start_line: z.number().int().positive().optional(),
    line_count: z.number().int().positive().max(2000).optional() }).strict(),
]).meta({ type: 'object' });
export const hostCallSchema = z.object({ server: z.string().min(1), tool: z.string().min(1), args: z.record(z.string(), z.unknown()) }).strict();
export const bindingSchema = z.object({
  task: z.string().regex(TASK_ID_RE), participant: z.string().regex(PARTICIPANT_ID_RE), role: roleSchema,
  projectId: z.string().min(1), environmentId: z.string().min(1), environmentPath: z.string().min(1),
  hostId: z.string().min(1), providerId: z.string().min(1), root: z.string().min(1), token: z.string().uuid(),
  threadId: z.string().nullable(), phase: z.enum(['pending', 'provisioning', 'ready', 'orphan', 'archiving', 'archived']),
  parentThreadId: z.string().nullable().default(null), lifecycleOwnerThreadId: z.string().nullable().default(null),
  environmentOwner: z.enum(['existing', 'bb']).default('existing'), branch: z.string().nullable().default(null),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/).nullable().default(null), bootstrap: z.string().optional(),
  preservation: z.object({ artifactId: z.string(), sha256: z.string(), at: z.string() }).strict().optional(),
  display: z.object({ label: z.string().trim().min(1), subject: z.string().trim().min(1), repository: z.string().trim().min(1) }).strict().optional(),
  execution: executionSchema.optional(),
  contextPurpose: contextPurposeSchema.optional(),
  contextDeclaration: contextDeclarationSchema.optional(),
  hostContext: hostContextSchema.optional(),
  launchContext: launchContextSchema.optional(),
  evidenceManifest: evidenceManifestSchema.optional(),
  phaseAssignment: z.string().optional(),
  phaseAssignmentPending: z.boolean().optional(),
  phaseAssignmentDelivery: z.object({ state: z.enum(['sending', 'sent', 'queued', 'unknown', 'cancelled']),
    epoch: z.number().int().nonnegative(), queuedId: z.string().nullable(), requestId: z.string().nullable(),
    cancelledQueueIds: z.array(z.string()).default([]) }).strict().optional(),
  predecessors: z.object({ worker: z.string().regex(PARTICIPANT_ID_RE), reviewer: z.string().regex(PARTICIPANT_ID_RE) }).strict().optional(),
}).strict();
export type Binding = z.infer<typeof bindingSchema>;
export const launchSchema = z.object({
  attemptId: z.string().uuid(), assignment: z.string(), model: z.string(), reasoningLevel: reasoningSchema.optional(), baseBranch: z.string().optional(),
  environmentPath: z.string().min(1).optional(),
  status: z.enum(['prepared', 'requested', 'recorded', 'ready', 'unknown']),
}).strict();
export const deliverySchema = z.object({
  paused: z.boolean().default(true), epoch: z.number().int().nonnegative().default(0),
  cursor: z.number().int().nonnegative().default(0), key: z.string().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0), reason: z.string().default('Explicit resume is required'),
  lastCompleted: z.number().int().nonnegative().default(0), obligation: z.string().nullable().default(null),
  continuations: z.number().int().nonnegative().default(0),
  retired: z.array(z.object({ marker: z.string(), text: z.string(), requests: z.array(z.string()).default([]),
    visibility: z.literal('agent-only').nullable().default(null),
  }).strict()).default([]),
  pending: z.object({ marker: z.string(), text: z.string(), key: z.string(), afterSeq: z.number().int().nonnegative(),
    at: z.number(), state: z.enum(['sending', 'sent', 'queued', 'unknown']), queuedId: z.string().nullable(),
    requestSeq: z.number().int().nonnegative().nullable().default(null),
    requestId: z.string().nullable().default(null),
    requests: z.array(z.string()).default([]), visibility: z.literal('agent-only').nullable().default(null),
  }).strict().nullable().default(null),
}).strict();
export type DeliveryState = z.infer<typeof deliverySchema>;
export const pendingSchema = z.object({ ids: z.array(z.string()), revision: z.string(), obligation: z.string().nullable() }).strict();
export const sendSchema = z.object({
  to: z.array(z.string().regex(PARTICIPANT_ID_RE)).min(1), type: z.enum(MESSAGE_TYPES), body: z.string().min(1).max(2400),
  artifact: z.object({ filename: z.string().min(1).max(255), content: z.string().max(1_000_000) }).strict().optional(),
}).strict();
export const mailboxSchema = z.object({ mode: z.enum(['peek', 'read']) }).strict();
export const emptySchema = z.object({}).strict();
export const artifactSchema = z.object({ id: z.string().min(1) }).strict();
export const BUS_TOOLS = ['promptobus_send', 'promptobus_mailbox', 'promptobus_task', 'promptobus_artifact'] as const;
export function toolsFor(role: Binding['role']): string[] {
  return BUS_TOOLS.filter(name => role !== 'reporter' || name !== 'promptobus_send');
}

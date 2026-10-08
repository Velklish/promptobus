import { z } from 'zod';
import { MESSAGE_TYPES, PARTICIPANT_ID_RE, TASK_ID_RE } from 'promptobus';
import { BB_ROLE_SKILLS } from 'promptobus/instructions';

export const roleSchema = z.enum(Object.keys(BB_ROLE_SKILLS) as [keyof typeof BB_ROLE_SKILLS, ...(keyof typeof BB_ROLE_SKILLS)[]]);
export const bindingSchema = z.object({
  task: z.string().regex(TASK_ID_RE), participant: z.string().regex(PARTICIPANT_ID_RE), role: roleSchema,
  projectId: z.string().min(1), environmentId: z.string().min(1), environmentPath: z.string().min(1),
  hostId: z.string().min(1), providerId: z.string().min(1), root: z.string().min(1), token: z.string().uuid(),
  threadId: z.string().nullable(), phase: z.enum(['pending', 'provisioning', 'ready', 'orphan', 'archiving', 'archived']),
  parentThreadId: z.string().nullable().default(null), lifecycleOwnerThreadId: z.string().nullable().default(null),
  environmentOwner: z.enum(['existing', 'bb']).default('existing'), branch: z.string().nullable().default(null),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/).nullable().default(null), bootstrap: z.string().optional(),
  preservation: z.object({ artifactId: z.string(), sha256: z.string(), at: z.string() }).strict().optional(),
}).strict();
export type Binding = z.infer<typeof bindingSchema>;
export const launchSchema = z.object({
  attemptId: z.string().uuid(), assignment: z.string(), model: z.string(), baseBranch: z.string().optional(),
  status: z.enum(['prepared', 'requested', 'recorded', 'ready', 'unknown']),
}).strict();
export const deliverySchema = z.object({
  paused: z.boolean().default(true), epoch: z.number().int().nonnegative().default(0),
  cursor: z.number().int().nonnegative().default(0), key: z.string().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0), reason: z.string().default('Explicit resume is required'),
  lastCompleted: z.number().int().nonnegative().default(0), obligation: z.string().nullable().default(null),
  continuations: z.number().int().nonnegative().default(0),
  pending: z.object({ marker: z.string(), text: z.string(), key: z.string(), afterSeq: z.number().int().nonnegative(),
    at: z.number(), state: z.enum(['sending', 'sent', 'queued', 'unknown']), queuedId: z.string().nullable(),
    requestSeq: z.number().int().nonnegative().nullable().default(null),
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

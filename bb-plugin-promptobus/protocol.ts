import { z } from 'zod';
import { MESSAGE_TYPES, PARTICIPANT_ID_RE, TASK_ID_RE } from 'promptobus';
import { BB_ROLE_SKILLS } from 'promptobus/instructions';

export const roleSchema = z.enum(Object.keys(BB_ROLE_SKILLS) as [keyof typeof BB_ROLE_SKILLS, ...(keyof typeof BB_ROLE_SKILLS)[]]);
export const bindingSchema = z.object({
  task: z.string().regex(TASK_ID_RE), participant: z.string().regex(PARTICIPANT_ID_RE), role: roleSchema,
  projectId: z.string().min(1), environmentId: z.string().min(1), environmentPath: z.string().min(1),
  hostId: z.string().min(1), providerId: z.string().min(1), root: z.string().min(1), token: z.string().uuid(),
  threadId: z.string().nullable(), phase: z.enum(['pending', 'ready', 'orphan']),
}).strict();
export type Binding = z.infer<typeof bindingSchema>;
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

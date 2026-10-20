import path from 'node:path';
import { z } from 'zod';

const text = z.string().trim().min(1);
const absolute = text.refine(value => path.isAbsolute(value) && path.dirname(value) !== value, 'requires a bounded absolute path');
export const commandGrantSchema = z.object({
  actor: text, task: text, token: text, state: z.literal('active'), phase: text,
  scope: z.object({ repository: absolute, branch: text, base: z.string().regex(/^[a-f0-9]{40,64}$/), operations: z.array(text).min(1) }).strict(),
  preconditions: z.array(text).min(1),
}).strict();
export const controlReferenceSchema = z.object({
  directory: absolute,
  owner: z.object({ task: text, participant: z.literal('orchestrator'), projectId: text, environmentId: text, hostId: text, root: absolute }).strict(),
  readRoots: z.array(absolute).min(1),
}).strict();
const projection = { ownerConfirmed: z.boolean(), STOP: z.boolean(), noNewStages: z.boolean(),
  grants: z.record(text, commandGrantSchema) };
export const controlPublicationSchema = z.object({ reference: controlReferenceSchema, ...projection }).strict();
export const currentControlSchema = z.object({ format: z.literal('promptobus-bb-control-v1'), reference: controlReferenceSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), ...projection }).strict();
export const tokenRecordSchema = z.object({ format: z.literal('promptobus-bb-token-v1'), task: text, actor: text, token: text,
  grantSha256: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['active', 'ended']) }).strict();
export const controlOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('allowed'), revision: z.number().int().positive(), predecessorEnded: z.boolean().optional() }).strict(),
  z.object({ outcome: z.literal('blocked'), reason: text, message: text }).strict(),
  z.object({ outcome: z.literal('unavailable'), reason: text, message: text }).strict(),
]);
export type ControlReference = z.infer<typeof controlReferenceSchema>;
export type CommandGrant = z.infer<typeof commandGrantSchema>;
export type ControlPublication = z.infer<typeof controlPublicationSchema>;
export type ControlOutcome = z.infer<typeof controlOutcomeSchema>;

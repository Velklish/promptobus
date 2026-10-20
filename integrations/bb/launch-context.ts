import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { BB_ROLE_SKILLS, renderBbInstructionSkill } from 'promptobus/instructions';
import type { Binding } from './protocol.js';
import { commandGrantSchema, controlReferenceSchema } from './control-schema.js';
export { commandGrantSchema } from './control-schema.js';

const text = z.string().trim().min(1);
const absolute = text.refine(value => path.isAbsolute(value) && path.dirname(value) !== value, 'requires a bounded absolute path');
const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
export const controlSnapshotSchema = z.object({
  ownerConfirmed: z.literal(true), STOP: z.literal(false), noNewStages: z.literal(false),
  grant: commandGrantSchema, endedTokens: z.array(text),
}).strict();
export const launchContextSchema = z.object({
  ownedRoots: z.array(absolute).min(1), readRoots: z.array(absolute).min(1),
  role: z.object({ name: text, literal: text }).strict(),
  grant: commandGrantSchema,
  control: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('current'), reference: controlReferenceSchema }).strict(),
    z.object({ mode: z.literal('file'), path: absolute }).strict(),
    z.object({ mode: z.literal('inline'), snapshot: controlSnapshotSchema,
      signals: z.tuple([z.literal('Hold'), z.literal('Stop')]) }).strict(),
  ]),
  preparation: z.object({ commands: z.array(z.array(text).min(1)), status: z.enum(['complete', 'notRun']),
    reason: text.optional() }).strict(),
  quota: z.object({ authority: text, missingUsage: z.literal('informational'),
    soft: z.number().nonnegative(), hard: z.number().nonnegative(), maxActiveIncludingOwner: z.number().int().positive(),
    PAYG: z.literal(false) }).strict(),
  review: z.object({ producer: text, producerBinding: z.enum(['participant', 'owner-declaration']), sourceEnvironmentId: text, base: sha,
    ownerDeclaration: text.optional(),
    requiredGates: z.array(z.array(text).min(1)).min(1), requirePassingGates: z.boolean() }).strict().optional(),
}).strict();
export type LaunchContext = z.infer<typeof launchContextSchema>;

export function underRoots(file: string, roots: readonly string[]) {
  return roots.some(root => {
    const relative = path.relative(root, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  });
}

export function readDeclaredFile(file: string, roots: readonly string[], maximum: number) {
  const resolved = realpathSync(file), allowed = roots.map(root => realpathSync(root));
  if (!underRoots(resolved, allowed)) throw new Error('launch context: file outside declared roots');
  const before = statSync(resolved);
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), current = statSync(realpathSync(file));
    if (!opened.isFile()) throw new Error('launch context: bounded file is not a regular file');
    if (opened.size > maximum) throw new Error('launch context: bounded file exceeds limit');
    if ([before, current].some(entry => entry.dev !== opened.dev || entry.ino !== opened.ino)) {
      throw new Error('launch context: bounded file changed while opening');
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== opened.size || fstatSync(fd).size !== opened.size || !underRoots(realpathSync(file), allowed)) throw new Error('launch context: bounded file changed while reading');
    return bytes;
  } finally { closeSync(fd); }
}

export function validateControl(context: LaunchContext, input: unknown) {
  const current = controlSnapshotSchema.parse(input);
  if (!isDeepStrictEqual(current.grant, context.grant)) throw new Error('launch context: current grant mismatch');
  if (current.endedTokens.includes(context.grant.token)) throw new Error('launch context: ended token requires a fresh bounded phase');
  return current;
}

export function validateLaunchContext(binding: Binding, input: unknown, tools: readonly string[]) {
  if (input === undefined) throw new Error('launch context is required before substantive assignment');
  const parsed = launchContextSchema.safeParse(input);
  if (!parsed.success) throw new Error(`launch context: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const context = parsed.data;
  if (context.role.name !== BB_ROLE_SKILLS[binding.role] || context.role.literal !== renderBbInstructionSkill(binding.role)) {
    throw new Error('launch context: selected role literal mismatch');
  }
  if (!context.ownedRoots.includes(binding.environmentPath) || !context.ownedRoots.every(root => underRoots(root, context.readRoots))) {
    throw new Error('launch context: ownedRoots outside provider readRoots');
  }
  const grant = context.grant;
  if (grant.actor !== binding.participant || grant.task !== binding.task || grant.scope.repository !== binding.environmentPath
    || grant.scope.branch !== binding.branch || grant.scope.base !== binding.baseSha) throw new Error('launch context: actor/task/owned scope mismatch');
  if (context.quota.soft > context.quota.hard) throw new Error('launch context: quota soft exceeds hard');
  if (context.preparation.status === 'notRun' && !context.preparation.reason) throw new Error('launch context: preparation notRun requires reason');
  if (!['promptobus_task', 'promptobus_mailbox', 'promptobus_artifact'].every(name => tools.includes(name))
    || (binding.role !== 'reporter' && !tools.includes('promptobus_send')) || tools.some(name => name.startsWith('mcp__'))) {
    throw new Error('launch context: executable BB tool binding missing or ambiguous; no native fallback');
  }
  if (context.control.mode === 'file') {
    if (!underRoots(context.control.path, context.readRoots)) throw new Error('launch context: control.path outside provider readRoots; use inline control');
  } else if (context.control.mode === 'inline') validateControl(context, context.control.snapshot);
  return context;
}

import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { artifactSchema, bindingSchema, emptySchema, hostCallSchema, hostContextSchema, hostReadSchema, mailboxSchema, sendSchema } from './protocol.js';

const bound = { binding: bindingSchema };
export const engineInput = z.discriminatedUnion('operation', [
  z.object({ ...bound, operation: z.literal('reserve'), title: z.string().min(1), create: z.boolean() }).strict(),
  z.object({ ...bound, operation: z.literal('finalize') }).strict(),
  z.object({ ...bound, operation: z.literal('check') }).strict(),
  z.object({ ...bound, operation: z.literal('step'), worker: z.string(), reviewer: z.string() }).strict(),
  z.object({ ...bound, operation: z.literal('pending') }).strict(),
  z.object({ ...bound, operation: z.literal('preserve'), content: z.string().max(10_000_000) }).strict(),
  z.object({ ...bound, operation: z.literal('send'), args: sendSchema }).strict(),
  z.object({ ...bound, operation: z.literal('mailbox'), args: mailboxSchema }).strict(),
  z.object({ ...bound, operation: z.literal('task'), args: emptySchema }).strict(),
  z.object({ ...bound, operation: z.literal('artifact'), args: artifactSchema }).strict(),
  z.object({ ...bound, operation: z.literal('uploadEvidence'), file: z.string().min(1), to: z.string().min(1) }).strict(),
]);

export const hostContract = defineRpcContract({
  prepareContext: { input: z.object(bound).strict(), output: hostContextSchema },
  hostContext: { input: z.object({ ...bound, args: hostReadSchema }).strict(), output: z.unknown() },
  canonical: { input: z.object({ ...bound, args: hostCallSchema }).strict(), output: z.unknown() },
  launchControl: { input: z.object(bound).strict(), output: z.unknown() },
  read: { input: z.object({ root: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }).strict(), output: z.unknown() },
  engine: { input: engineInput, output: z.unknown() },
});

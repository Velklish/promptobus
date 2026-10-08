import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { artifactSchema, bindingSchema, emptySchema, mailboxSchema, sendSchema } from './protocol.js';

const bound = { binding: bindingSchema };
export const engineInput = z.discriminatedUnion('operation', [
  z.object({ ...bound, operation: z.literal('reserve'), title: z.string().min(1), create: z.boolean() }).strict(),
  z.object({ ...bound, operation: z.literal('finalize') }).strict(),
  z.object({ ...bound, operation: z.literal('check') }).strict(),
  z.object({ ...bound, operation: z.literal('preserve'), content: z.string().max(10_000_000) }).strict(),
  z.object({ ...bound, operation: z.literal('send'), args: sendSchema }).strict(),
  z.object({ ...bound, operation: z.literal('mailbox'), args: mailboxSchema }).strict(),
  z.object({ ...bound, operation: z.literal('task'), args: emptySchema }).strict(),
  z.object({ ...bound, operation: z.literal('artifact'), args: artifactSchema }).strict(),
]);

export const hostContract = defineRpcContract({
  read: { input: z.object({ root: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }).strict(), output: z.unknown() },
  engine: { input: engineInput, output: z.unknown() },
});

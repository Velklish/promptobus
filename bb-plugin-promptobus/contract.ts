import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const hostContract = defineRpcContract({
  read: { input: z.object({ root: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }).strict(), output: z.unknown() },
});

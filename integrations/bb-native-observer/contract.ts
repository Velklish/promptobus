import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const absolutePath = z.string().min(1).max(4096).refine(value => !value.includes('\0')
  && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value)), 'Use an absolute path on the selected host');
export const selectionSchema = z.object({
  storeRoot: absolutePath, nativeRoot: absolutePath,
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
}).strict();
export const rootsSchema = selectionSchema.omit({ taskId: true });
export const configurationSchema = rootsSchema.extend({ hostId: z.string().regex(/^host_[A-Za-z0-9]+$/),
  taskId: selectionSchema.shape.taskId.or(z.literal('')) }).strict();
export const settingsSchema = configurationSchema.extend({ taskId: selectionSchema.shape.taskId });
export type Selection = z.infer<typeof selectionSchema>;
const text = z.string().max(240).nullable();
const owner = z.object({ id: z.string(), sessionRef: text, harness: z.string() }).strict().nullable();
export const messageSchema = z.object({ id: z.string(), sender: z.string(), recipients: z.array(z.string()), type: z.string(),
  body: z.string().max(16000), created: z.string(), artifact: text, bodyTruncated: z.boolean() }).strict();
const commands = z.object({ starts: z.number().int().nonnegative(), terminals: z.number().int().nonnegative(),
  rawSelected: z.number().int().nonnegative(), incompleteTail: z.boolean() }).strict().nullable();
export const snapshotSchema = z.object({
  selection: selectionSchema, sampledAt: z.string(), observer: z.object({ instance: z.string(), pid: z.number() }).strict(),
  task: z.object({ id: z.string(), title: z.string(), state: z.enum(['not prepared', 'active', 'done']), updated: text, owner }).strict(),
  actors: z.array(z.object({ participantId: z.string(), address: z.string(), role: z.string(), harness: z.string(), model: text, effort: text, sessionRef: text, launchId: text,
    threadId: text, state: z.string(), busy: z.boolean().nullable(), sandbox: text, commands }).strict()).max(64),
  messages: z.array(messageSchema).max(32),
  limits: z.array(z.string()).max(4),
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const taskListSchema = z.array(z.object({ id: z.string(), title: z.string(), state: z.enum(['active', 'done']), updated: z.string() }).strict()).max(256);
export const catalogueSchema = z.object({ tasks: taskListSchema, truncated: z.boolean(), scanned: z.number().int().min(0).max(4096) }).strict();
export const viewSchema = z.object({ configuration: configurationSchema, snapshot: snapshotSchema.nullable(),
  snapshotError: z.string().nullable(), catalogue: catalogueSchema.nullable(), catalogueError: z.string().nullable() }).strict();
export type View = z.infer<typeof viewSchema>;
export const rpcContract = defineRpcContract({ snapshot: { input: z.null(), output: snapshotSchema },
  view: { input: z.null(), output: viewSchema },
  tasks: { input: z.null(), output: catalogueSchema },
  selectTask: { input: z.object({ taskId: selectionSchema.shape.taskId }).strict(), output: snapshotSchema },
});
export const hostContract = defineRpcContract({ snapshot: { input: selectionSchema, output: snapshotSchema },
  tasks: { input: rootsSchema, output: catalogueSchema } });

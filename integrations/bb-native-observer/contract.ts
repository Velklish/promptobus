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
  taskId: selectionSchema.shape.taskId.or(z.literal('')), ownerThreadId: z.string().default(''), wakeEnabled: z.boolean().default(false) }).strict();
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
export const ownerFeedSchema = z.object({ taskId: z.string(), state: z.enum(['not prepared', 'active', 'done']),
  ownerParticipantId: z.string(), ownerSessionRef: text, messages: z.array(z.object({ id: z.string(), sender: z.string(),
    recipients: z.array(z.string()), type: z.string() }).strict()).max(4096) }).strict();
export const wakeStatusSchema = z.object({ enabled: z.boolean(), ownerThreadId: z.string().nullable(), state: z.string(),
  error: z.string().nullable(), lastMessageId: z.string().nullable() }).strict();
export const viewSchema = z.object({ configuration: configurationSchema, snapshot: snapshotSchema.nullable(),
  snapshotError: z.string().nullable(), catalogue: catalogueSchema.nullable(), catalogueError: z.string().nullable(), wake: wakeStatusSchema }).strict();
export type View = z.infer<typeof viewSchema>;
const slug = z.string().min(1).max(128);
export const pieceSchema = z.object({ slug, step: z.string().nullable(), unfinishedDelivery: z.boolean().optional(),
  holder: z.object({ participantId: z.string(), address: z.string(), role: z.string(), harness: z.string(), model: text, sessionRef: text,
    bbThreadId: text, status: z.object({ line: z.string().max(240), at: z.string() }).strict().nullable(),
    unread: z.number().int().nonnegative(), stall: text, question: z.string().nullable() }).strict().nullable(),
  participants: z.array(z.object({ step: z.string(), participantId: z.string() }).strict()).max(16) }).strict();
export const boardSchema = z.object({ sampledAt: z.string(), observer: z.object({ instance: z.string(), pid: z.number() }).strict(),
  runs: z.array(z.object({ id: z.string(), title: z.string(), state: z.enum(['active', 'done']), updated: z.string(), owner: text,
    steps: z.array(z.string()).max(16), pieces: z.array(pieceSchema).max(64), inferred: z.boolean(), error: text, notice: text.optional() }).strict()).max(256),
  truncated: z.boolean(), limits: z.array(z.string()).max(4) }).strict();
export type Board = z.infer<typeof boardSchema>;
export const sourceSchema = configurationSchema.pick({ hostId: true, storeRoot: true, nativeRoot: true }).strict();
export type Source = z.infer<typeof sourceSchema>;
export const sourcedBoardSchema = boardSchema.extend({ source: sourceSchema }).strict();
export type SourcedBoard = z.infer<typeof sourcedBoardSchema>;
export const pieceSelectionSchema = rootsSchema.extend({ taskId: selectionSchema.shape.taskId, slug }).strict();
export const historySchema = z.object({ taskId: z.string(), slug: z.string(), messages: z.array(messageSchema).max(64), notice: text.optional() }).strict();
export const sourcedHistorySchema = historySchema.extend({ source: sourceSchema }).strict();
export type PieceHistory = z.infer<typeof sourcedHistorySchema>;
export const rpcContract = defineRpcContract({ snapshot: { input: z.null(), output: snapshotSchema },
  view: { input: z.null(), output: viewSchema },
  tasks: { input: z.null(), output: catalogueSchema },
  wakeStatus: { input: z.null(), output: wakeStatusSchema },
  bindOwner: { input: z.discriminatedUnion('enabled', [
    z.object({ taskId: selectionSchema.shape.taskId, threadId: z.string().regex(/^thr_[a-z0-9]+$/), enabled: z.literal(true) }).strict(),
    z.object({ taskId: selectionSchema.shape.taskId, threadId: z.string().optional(), enabled: z.literal(false) }).strict(),
  ]), output: wakeStatusSchema },
  selectTask: { input: z.object({ taskId: selectionSchema.shape.taskId }).strict(), output: snapshotSchema },
  board: { input: z.null(), output: sourcedBoardSchema },
  pieceHistory: { input: pieceSelectionSchema.pick({ taskId: true, slug: true }).extend({ source: sourceSchema }).strict(), output: sourcedHistorySchema },
});
export const hostContract = defineRpcContract({ snapshot: { input: selectionSchema, output: snapshotSchema },
  tasks: { input: rootsSchema, output: catalogueSchema }, ownerFeed: { input: selectionSchema, output: ownerFeedSchema },
  board: { input: rootsSchema, output: boardSchema }, pieceHistory: { input: pieceSelectionSchema, output: historySchema } });

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { addressOf, GateError, ORCHESTRATOR, ownerOf, PromptobusError, readStalls, requireTaskId, type PromptobusHost, type TaskV1 } from '../dist/index.js';
import { ownedReader, type OwnedReader } from '../dist/fs/owned-reader.js';
import { taskFile } from '../dist/v1/layout.js';
import { readMessageFence, strictCommittedMessages, validOrderId } from '../dist/v1/message-order.js';
import { requireValid } from '../dist/v1/validate.js';
import { resolveSessionIdentity } from './drivers.js';

const PAGE_SIZE = 10;
const BODY_LIMIT = 2000;
const MAIL_TYPES = new Set(['status', 'question', 'answer', 'result', 'review']);
const BUSY = 'store message order is busy; retry with the last successful cursor';
const INCOMPLETE = 'selected journal is incomplete: unresolved message fan-out';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Cursor = { v: 1; scope: string; last: string | null; closed: boolean; stalls: Record<string, string> };

function decode(token: string | undefined): Cursor | null {
  if (token === undefined) return null;
  try {
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw new Error();
    const c = JSON.parse(bytes.toString('utf8')) as Cursor;
    if (c.v === 1 && typeof c.scope === 'string' && (c.last === null || validOrderId(c.last))
      && typeof c.closed === 'boolean' && c.stalls && typeof c.stalls === 'object' && !Array.isArray(c.stalls)
      && Object.values(c.stalls).every((value) => typeof value === 'string')) return c;
  } catch { /* invalid cursor */ }
  throw new GateError('observe: invalid cursor; use the exact nextCursor from the last successful page');
}

function identityFor(task: string, env: NodeJS.ProcessEnv) {
  const identity = resolveSessionIdentity(env);
  const candidate = identity.candidates[0];
  const declaredTask = env.PROMPTOBUS_TASK?.trim();
  const declaredRole = env.PROMPTOBUS_ROLE?.trim();
  if (identity.reason !== 'resolved' || !identity.id || !candidate?.harness || candidate.id !== identity.id
    || (declaredTask && declaredTask !== task) || (declaredRole && declaredRole !== ORCHESTRATOR)) {
    throw new GateError('observation requires the selected task’s bound orchestrator command identity');
  }
  return { id: identity.id, harness: candidate.harness };
}

function authorizedTask(reader: OwnedReader, home: string, id: string, identity: ReturnType<typeof identityFor>) {
  const text = reader.text(taskFile(home, id));
  if (text === null) throw new GateError('selected task journal is unavailable');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new GateError('selected task journal is malformed'); }
  requireValid('task', value, { task: id });
  const meta = value as TaskV1;
  const owner = meta.participants.find((p) => p.id === meta.owner && p.role === ORCHESTRATOR);
  if (meta.id !== id || !owner || addressOf(owner) !== ORCHESTRATOR || owner.harness !== identity.harness
    || ownerOf(owner) !== identity.id) throw new GateError('observation requires the selected task’s bound orchestrator command identity');
  return { meta, owner };
}

function sample(reader: OwnedReader, home: string, task: TaskV1, before: Cursor) {
  const stalls: Cursor['stalls'] = Object.create(null);
  const changes = [];
  if (task.status === 'done' && !before.closed) {
    changes.push({ kind: 'task-state', task: task.id, at: task.updated, status: task.status });
  }
  let marks;
  try { marks = readStalls(home, task.id, { read: reader.text }); }
  catch { throw new GateError(`task ${task.id} stall marks cannot be read as an owned valid record`); }
  for (const address of Object.keys(marks).sort()) {
    const stall = marks[address]!;
    stalls[address] = hash([stall.reason, stall.at]);
    if (before.stalls[address] !== stalls[address]) {
      changes.push({ kind: 'stall', task: task.id, address, at: stall.at, reason: stall.reason });
    }
  }
  for (const address of Object.keys(before.stalls)) {
    if (!Object.hasOwn(stalls, address)) changes.push({ kind: 'stall-cleared', task: task.id, address, at: null });
  }
  return { stalls, changes, closed: task.status === 'done' };
}

function page(reader: OwnedReader, home: string, id: string, identity: ReturnType<typeof identityFor>, cursor: Cursor | null) {
  reader.resetBudget();
  const { meta: task, owner } = authorizedTask(reader, home, id, identity);
  const scope = hash([home, id, task.created, identity.harness, identity.id]);
  if (cursor && cursor.scope !== scope) throw new GateError('cursor belongs to a different store, task or owner');
  const before = cursor ?? { v: 1 as const, scope, last: null, closed: false, stalls: {} };
  const fence = readMessageFence(home, reader);
  if (fence.busy) return BUSY;
  let records;
  try { records = strictCommittedMessages(home, id, reader); }
  catch (error) {
    if (error instanceof PromptobusError && error.context.pending === 'fan-out') return INCOMPLETE;
    throw new GateError(`task ${id} canonical mail: ${(error as Error).message}`);
  }
  const after = readMessageFence(home, reader);
  if (after.busy || after.head !== fence.head) return BUSY;
  if (records.some((m) => !fence.head || m.id > fence.head)) throw new GateError('selected journal is incomplete: canonical mail exceeds the message-order head');

  const visible = records.filter((m) => MAIL_TYPES.has(m.type) && (m.sender === owner.id || m.recipients.includes(owner.id)));
  if (before.last && !visible.some((m) => m.id === before.last)) throw new GateError('cursor message is no longer visible in the selected mailbox');
  const fresh = visible.filter((m) => !before.last || m.id > before.last);
  const addresses = new Map(task.participants.map((p) => [p.id, addressOf(p) ?? p.id]));
  const messages = fresh.slice(0, PAGE_SIZE).map((m) => ({ kind: 'message', id: m.id, task: id, at: m.ts, type: m.type,
    from: addresses.get(m.sender) ?? m.sender, to: m.recipients.map((to) => addresses.get(to) ?? to),
    ...(m.originTask ? { originTask: m.originTask } : {}),
    body: m.body.slice(0, BODY_LIMIT), ...(m.body.length > BODY_LIMIT ? { truncated: true } : {}) }));
  const more = fresh.length > messages.length;
  const { stalls, changes, closed } = more ? { stalls: before.stalls, changes: [], closed: false } : sample(reader, home, task, before);
  const rechecked = authorizedTask(reader, home, id, identity);
  if (rechecked.meta.created !== task.created || rechecked.owner.id !== owner.id) throw new GateError('selected task binding changed during observation');
  const next: Cursor = { v: 1, scope, last: messages.at(-1)?.id ?? before.last, closed, stalls };
  return { schemaVersion: 1, task: id, observedAt: new Date().toISOString(),
    status: messages.length || changes.length ? 'activity' : closed ? 'closed' : 'idle',
    closed, more, messages, changes, nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url') };
}

export async function observe(host: PromptobusHost, opts: { task?: string; after?: string; wait?: string }, env = process.env) {
  if (!opts.task) throw new GateError('observe requires --task <id>');
  const id = requireTaskId(opts.task);
  const wait = opts.wait ?? '0';
  if (!/^\d{1,2}$/.test(wait) || Number(wait) > 20) throw new GateError('observe --wait expects 0 to 20 whole seconds');
  const cursor = decode(opts.after);
  const deadline = performance.now() + Number(wait) * 1000;
  try {
    const identity = identityFor(id, env);
    const reader = ownedReader(host.promptobusHome());
    const home = reader.root;
    if (env.PROMPTOBUS_HOME?.trim() && realpathSync(env.PROMPTOBUS_HOME.trim()) !== home) throw new GateError('declared store scope differs from the workspace store');
    for (;;) {
      const result = page(reader, home, id, identity, cursor);
      if (typeof result !== 'string' && result.status !== 'idle') return result;
      const remaining = deadline - performance.now();
      if (remaining > 0) await sleep(Math.min(500, remaining));
      if (performance.now() < deadline) continue;
      if (typeof result !== 'string') return result;
      throw new GateError(result);
    }
  } catch (error) {
    throw new GateError(`observe: ${id} feed unavailable; keep the previous cursor: ${(error as Error).message}`);
  }
}

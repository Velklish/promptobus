import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { addressOf, GateError, readStalls, requireTaskId, type PromptobusHost, type TaskV1 } from '../dist/index.js';
import { TASK_ID_RE } from '../dist/v1/model.js';
import { readMessageFence, strictCommittedMessages, validOrderId } from '../dist/v1/message-order.js';
import { pendingLinks, readTask } from '../dist/v1/store.js';

const PAGE_SIZE = 10;
const BODY_LIMIT = 2000;
const MAIL_TYPES = new Set(['status', 'question', 'answer', 'result', 'review']);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Cursor = {
  v: 1;
  scope: string;
  last: [task: string, id: string] | null;
  journals: string[];
  state: Record<string, string>;
};

function decode(token: string | undefined): Cursor | null {
  if (token === undefined) return null;
  try {
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw new Error();
    const c = JSON.parse(bytes.toString('utf8')) as Cursor;
    if (c.v === 1 && typeof c.scope === 'string' && Array.isArray(c.journals)
      && c.journals.every((id) => typeof id === 'string' && TASK_ID_RE.test(id))
      && (c.last === null || (Array.isArray(c.last) && c.last.length === 2
        && c.journals.includes(c.last[0]) && validOrderId(c.last[1])))
      && c.state && typeof c.state === 'object' && !Array.isArray(c.state)
      && Object.values(c.state).every((value) => typeof value === 'string')) return c;
  } catch { /* invalid cursor */ }
  throw new GateError('observe: invalid cursor; use the exact nextCursor from the last successful page');
}

function childrenOf(root: TaskV1) {
  return [...new Set(root.participants.flatMap((p) => p.role === 'teamlead'
    && typeof p.metadata.childTask === 'string' ? [requireTaskId(p.metadata.childTask)] : []))].sort();
}

function sample(home: string, root: TaskV1, journals: TaskV1[], before: Cursor) {
  const state: Record<string, string> = {};
  const changes = [];
  for (const task of journals) {
    const statusKey = `${task.id}/`;
    state[statusKey] = task.status;
    if (task.status !== 'active' && before.state[statusKey] !== task.status) {
      changes.push({ kind: 'task-state', task: task.id, at: task.updated, status: task.status });
    }
    let stalls;
    try { stalls = readStalls(home, task.id, { strict: true }); }
    catch (error) { throw new GateError(`task ${task.id} stall marks: ${(error as Error).message}`); }
    for (const address of Object.keys(stalls).sort()) {
      const stall = stalls[address]!;
      const key = `${task.id}/${address}`;
      state[key] = hash([stall.reason, stall.at]);
      if (before.state[key] !== state[key]) {
        changes.push({ kind: 'stall', task: task.id, address, at: stall.at, reason: stall.reason });
      }
    }
    for (const key of Object.keys(before.state)) {
      if (key !== statusKey && key.startsWith(statusKey) && !Object.hasOwn(state, key)) {
        changes.push({ kind: 'stall-cleared', task: task.id, address: key.slice(statusKey.length), at: null });
      }
    }
  }
  return { state, changes, closed: root.status === 'done' && journals.every((task) => task.status === 'done') };
}

function page(home: string, id: string, version: string, cursor: Cursor | null) {
  const fence = readMessageFence(home);
  if (fence.busy) return null;
  const load = (task: string) => {
    const meta = readTask(home, task, version);
    if (meta.id !== task) throw new GateError(`task ${task} journal identity does not match`);
    return meta;
  };
  const root = load(id);
  if (root.parent !== undefined) throw new GateError(`task ${id} is a child; select root ${root.parent}`);
  const scope = hash([home, root.id, root.created]);
  if (cursor && cursor.scope !== scope) throw new GateError('cursor belongs to a different store or root');
  const before = cursor ?? { v: 1 as const, scope, last: null, journals: [], state: {} };
  const children = childrenOf(root);
  // A child can exist before the root publishes its link. An incomplete link cannot be skipped.
  if (pendingLinks(home, id).length) return null;
  const journals = [root, ...children.map(load)];
  if (journals.slice(1).some((task) => task.parent !== id)) throw new GateError('child journal has a different root');
  const ids = journals.map((task) => task.id);
  if (before.journals.some((task) => !ids.includes(task))) throw new GateError('a previously observed child journal is no longer linked');
  const mail = [];
  for (const task of journals) {
    let records;
    try { records = strictCommittedMessages(home, task.id); }
    catch (error) {
      if ((error as Error).message.includes('unresolved task intent')) return null;
      throw new GateError(`task ${task.id} canonical mail: ${(error as Error).message}`);
    }
    if (before.last?.[0] === task.id && !records.some((m) => m.id === before.last![1])) {
      throw new GateError(`cursor message is no longer in task ${task.id}`);
    }
    const addresses = new Map(task.participants.map((p) => [p.id, addressOf(p) ?? p.id]));
    for (const m of records) {
      if (!fence.head || m.id > fence.head) return null;
      if (!MAIL_TYPES.has(m.type)) continue;
      if (before.last && m.id <= before.last[1]) {
        if (!before.journals.includes(task.id)) throw new GateError(`newly linked task ${task.id} contains mail older than the cursor`);
        continue;
      }
      mail.push({ kind: 'message', id: m.id, task: task.id, at: m.ts, type: m.type,
        from: addresses.get(m.sender) ?? m.sender, to: m.recipients.map((to) => addresses.get(to) ?? to),
        ...(m.originTask ? { originTask: m.originTask } : {}),
        body: m.body.slice(0, BODY_LIMIT), ...(m.body.length > BODY_LIMIT ? { truncated: true } : {}) });
    }
  }
  if (readMessageFence(home).head !== fence.head || pendingLinks(home, id).length
    || JSON.stringify(childrenOf(load(id))) !== JSON.stringify(children)) return null;

  mail.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const messages = mail.slice(0, PAGE_SIZE);
  const last = messages.at(-1);
  const more = mail.length > messages.length;
  const { state, changes, closed } = more ? { state: before.state, changes: [], closed: false }
    : sample(home, root, journals, before);
  const next: Cursor = { v: 1, scope, last: last ? [last.task, last.id] : before.last, journals: ids, state };
  return { schemaVersion: 1, root: id, observedAt: new Date().toISOString(),
    status: messages.length || changes.length ? 'activity' : closed ? 'closed' : 'idle',
    closed, more, messages, changes, nextCursor: Buffer.from(JSON.stringify(next)).toString('base64url') };
}

export async function observe(host: PromptobusHost, opts: { task?: string; after?: string; wait?: string }) {
  if (!opts.task) throw new GateError('observe requires --task <root>');
  const id = requireTaskId(opts.task);
  const wait = opts.wait ?? '0';
  if (!/^\d{1,2}$/.test(wait) || Number(wait) > 20) throw new GateError('observe --wait expects 0 to 20 whole seconds');
  const cursor = decode(opts.after);
  const deadline = performance.now() + Number(wait) * 1000;
  try {
    const home = realpathSync(host.promptobusHome());
    for (;;) {
      const result = page(home, id, host.version, cursor);
      if (result && (result.status !== 'idle' || performance.now() >= deadline)) return result;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        if (result) return result;
        throw new GateError('journal snapshot could not be confirmed (message order or child link is changing or incomplete)');
      }
      await sleep(Math.min(500, remaining));
    }
  } catch (error) {
    throw new GateError(`observe: ${id} feed unavailable; keep the previous cursor: ${(error as Error).message}`);
  }
}

import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from '../fs/atomic.js';
import { withDirLock } from '../fs/lock.js';
import { fail } from './errors.js';
import { brokenMessagesDir, intentsDir, messagesDir, taskFile, tasksDir } from './layout.js';
import { compactStamp, RECORD_ID_RE, TASK_ID_RE } from './model.js';
import type { MessageV1, TaskV1 } from './model.js';
import { requireValid } from './validate.js';

const HEAD_LIMIT = 4096;
export const messageOrderFile = (home: string) => path.join(home, 'message-order.json');
export function withMessageCommit<T>(home: string, fn: () => T): T {
  mkdirSync(home, { recursive: true });
  return withDirLock(path.join(home, '.message-order-lock'), fn, {
    onMissing: () => new Error('message order store is missing'),
    onBusy: () => new Error('message order commit is busy; retry after the current writer finishes'),
  });
}
function refusal(note: string): never {
  return fail('schema-invalid', `message order: ${note}; stop other writers and run message-order rebuild`, {});
}
function stampDate(stamp: string): Date {
  return new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`);
}
export function validOrderId(id: unknown): id is string {
  if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return false;
  const stamp = id.slice(0, 18), at = stampDate(stamp);
  return Number.isFinite(at.getTime()) && compactStamp(at) === stamp;
}
function readHead(home: string): { kind: 'valid'; head: string | null } | { kind: 'missing' | 'malformed' } {
  let fd: number;
  try { fd = openSync(messageOrderFile(home), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }; throw error; }
  let content: Buffer;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > HEAD_LIMIT) return { kind: 'malformed' };
    content = Buffer.alloc(before.size);
    let read = 0;
    while (read < content.length) {
      const count = readSync(fd, content, read, content.length - read, read);
      if (!count) break;
      read += count;
    }
    if (read !== content.length || fstatSync(fd).size !== before.size) return { kind: 'malformed' };
  } finally { closeSync(fd); }
  let value: unknown;
  try { value = JSON.parse(content.toString('utf8')); } catch { return { kind: 'malformed' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'malformed' };
  const head = value as { format?: unknown; head?: unknown };
  if (head.format !== undefined && head.format !== 1) return fail('schema-version-unsupported', 'message order head format is unsupported', {});
  if (head.format !== 1 || Object.keys(head).sort().join(',') !== 'format,head' || (head.head !== null && !validOrderId(head.head))) return { kind: 'malformed' };
  return { kind: 'valid', head: head.head as string | null };
}
function names(directory: string): string[] {
  try { return readdirSync(directory).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function readMessage(file: string, task: string, id: string): MessageV1 {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  requireValid('message', value, { task, message: id });
  const message = value as MessageV1;
  if (message.task !== task || message.id !== id || !validOrderId(id)) refusal('canonical or intent identity mismatch');
  return message;
}
export function strictCommittedMessages(home: string, task: string): MessageV1[] {
  if (names(brokenMessagesDir(home, task)).length) refusal('unresolved broken message records prevent complete committed facts');
  if (names(intentsDir(home, task)).some(name => !name.endsWith('.owner'))) fail('schema-invalid', 'committed facts temporarily unavailable: unresolved task intent; wait for its writer or recover its fan-out', { task });
  return names(messagesDir(home, task)).map(name => {
    if (!name.endsWith('.json') || !validOrderId(name.slice(0, -5))) return refusal('unknown canonical message name');
    return readMessage(path.join(messagesDir(home, task), name), task, name.slice(0, -5));
  });
}
function retainedHead(home: string): { head: string | null; messages: number; intents: number; fences: number } {
  let head: string | null = null, messages = 0, intents = 0, fences = 0;
  const consider = (id: unknown) => {
    if (!validOrderId(id)) refusal('invalid retained ordering boundary');
    if (head === null || id > head) head = id;
  };
  for (const task of names(tasksDir(home))) {
    if (!TASK_ID_RE.test(task)) refusal('unknown retained task entry');
    const value: unknown = JSON.parse(readFileSync(taskFile(home, task), 'utf8'));
    requireValid('task', value, { task });
    const meta = value as TaskV1;
    if (meta.id !== task) refusal('retained task identity mismatch');
    if (names(brokenMessagesDir(home, task)).length) refusal('broken retained messages need explicit repair');
    for (const participant of meta.participants) {
      const fence = participant.metadata.assignmentAfterId;
      if (fence !== undefined && fence !== null) { consider(fence); fences++; }
    }
    for (const [directory, intent] of [[messagesDir(home, task), false], [intentsDir(home, task), true]] as const) {
      for (const name of names(directory)) {
        if (intent && name.endsWith('.owner')) continue;
        if (!name.endsWith('.json') || !validOrderId(name.slice(0, -5))) refusal('unknown retained message or intent name');
        const message = readMessage(path.join(directory, name), task, name.slice(0, -5));
        consider(message.id);
        if (intent) intents++; else messages++;
      }
    }
  }
  return { head, messages, intents, fences };
}
export function rebuildMessageOrder(home: string) {
  return withMessageCommit(home, () => {
    const previous = readHead(home), retained = retainedHead(home);
    const head = previous.kind === 'valid' && previous.head && (!retained.head || previous.head > retained.head) ? previous.head : retained.head;
    writeJsonAtomic(messageOrderFile(home), { format: 1, head });
    return { ...retained, head };
  });
}
export function reserveMessageId(home: string, now: Date): string {
  return withMessageCommit(home, () => {
    const state = readHead(home);
    let head: string | null;
    if (state.kind === 'valid') head = state.head;
    else {
      if (state.kind === 'malformed') return refusal('malformed high-water state');
      const retained = retainedHead(home);
      if (retained.head !== null) return refusal('missing high-water in a populated store');
      head = null;
    }
    let stamp = compactStamp(now), counter = 0;
    if (!validOrderId(`${stamp}-0000-000000`)) return refusal('wall-clock stamp is outside the supported ID encoding');
    if (head && stamp <= head.slice(0, 18)) {
      stamp = head.slice(0, 18); counter = Number(head.slice(19, 23)) + 1;
      if (counter > 9999) { stamp = compactStamp(new Date(stampDate(stamp).getTime() + 1)); counter = 0; }
    }
    const id = `${stamp}-${String(counter).padStart(4, '0')}-${randomBytes(3).toString('hex')}`;
    if (!validOrderId(id) || (head && id <= head)) return refusal('logical ID encoding is exhausted');
    writeJsonAtomic(messageOrderFile(home), { format: 1, head: id });
    return id;
  });
}

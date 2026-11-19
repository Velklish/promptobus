import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { addressOf, PARTICIPANT_ID_RE, requireValid, type MessageV1, type TaskV1 } from '../../src/index.ts';
import { RECORD_ID_RE } from '../../src/v1/model.js';
import { rootsSchema, selectionSchema, snapshotSchema, catalogueSchema, type Selection, type Snapshot } from './contract.js';

const clipped = (value: unknown) => typeof value === 'string' ? value.slice(0, 240) : null;
function parseRecord(text: string) {
  try { return JSON.parse(text); }
  catch { throw new Error('Selected native JSON is malformed'); }
}
export function ownedDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory)
    throw new Error('Selected directory must be a canonical absolute path without symlinks');
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || realpathSync(directory) !== directory)
    throw new Error('Selected directory must be a canonical absolute path without symlinks');
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Selected directory is not owned by the host user');
}
export const OWNED_RECORD_BYTES = 256 * 1024;
export class ReadBudgetExceeded extends Error {}
export class ReadBudget {
  exhausted = false;
  constructor(private remaining: number) {}
  reserve(bytes: number) {
    if (this.exhausted || bytes > this.remaining) {
      this.exhausted = true;
      throw new ReadBudgetExceeded();
    }
    this.remaining -= bytes;
  }
}
export function ownedText(root: string, file: string, maximum = OWNED_RECORD_BYTES, budget?: ReadBudget): string | null {
  ownedDirectory(root);
  if (!file.startsWith(root + path.sep)) throw new Error('File is outside the selected root');
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (before.isSymbolicLink()) throw new Error('Selected file crosses a symlink');
    if (!before.isFile() || before.size > maximum) throw new Error('Selected file exceeds the owned regular-file boundary');
    if (realpathSync(file) !== file) throw new Error('Selected file crosses a symlink');
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum || stat.dev !== before.dev || stat.ino !== before.ino
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Selected file exceeds the owned regular-file boundary');
    budget?.reserve(stat.size + 1);
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0, read = 0;
    do { read = readSync(fd, buffer, bytes, buffer.length - bytes, null); bytes += read; } while (read && bytes < buffer.length);
    if (bytes > maximum || bytes > stat.size) throw new Error('Selected file grew during the bounded read');
    return buffer.subarray(0, bytes).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function sessionFileName(ref: string): string {
  const head = ref.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  const hash = createHash('sha1').update(ref).digest('hex').slice(0, 12);
  return `${head ? head + '-' : ''}${hash}.json`;
}
export function selectedTask(root: string, taskId: string, budget?: ReadBudget): TaskV1 | null {
  try {
    const text = ownedText(root, path.join(root, 'tasks', taskId, 'task.json'), OWNED_RECORD_BYTES, budget);
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    requireValid('task', value);
    const task = value as TaskV1;
    if (task.id !== taskId) throw new Error();
    return task;
  } catch (error) {
    if (error instanceof ReadBudgetExceeded) throw error;
    throw new Error('Selected canonical task is unavailable, malformed or outside the owned boundary');
  }
}
function* entryNames(directory: string) {
  try { ownedDirectory(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const handle = opendirSync(directory);
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) yield entry.name;
  } finally { handle.closeSync(); }
}
export function historyNames(directory: string, limit: number): string[] {
  const names: string[] = [];
  for (const name of entryNames(directory)) {
    if (names.length >= limit) throw new Error();
    names.push(name);
  }
  return names;
}
type Reference = { id: string; participant: string; file: string };
function readMessage(root: string, taskId: string, id: string, file: string, budget?: ReadBudget): MessageV1 | null {
  const text = ownedText(root, file, OWNED_RECORD_BYTES, budget);
  if (text === null) return null;
  const value: unknown = JSON.parse(text);
  requireValid('message', value);
  const message = value as MessageV1;
  if (message.task !== taskId || message.id !== id) throw new Error();
  return message;
}
function addReference(messages: Map<string, MessageV1>, ref: Reference, message: MessageV1 | null) {
  if (!message || !message.recipients.includes(ref.participant)) throw new Error();
  const prior = messages.get(message.id);
  if (prior && JSON.stringify(prior) !== JSON.stringify(message)) throw new Error();
  messages.set(message.id, message);
}
export function taskMessages(root: string, taskId: string, onlyParticipant?: string): MessageV1[] {
  try {
    const refs: Reference[] = [];
    for (const area of ['history', 'inbox']) {
      const directory = path.join(root, 'tasks', taskId, area);
      const participants = onlyParticipant ? [onlyParticipant] : historyNames(directory, 64);
      for (const participant of participants) {
        if (!PARTICIPANT_ID_RE.test(participant)) throw new Error();
        for (const name of historyNames(path.join(directory, participant), 4096 - refs.length)) {
          if (!name.endsWith('.json')) continue;
          const id = name.slice(0, -5);
          refs.push({ id, participant, file: path.join(directory, participant, name) });
        }
      }
    }
    const messages = new Map<string, MessageV1>();
    for (const ref of refs) addReference(messages, ref, readMessage(root, taskId, ref.id, ref.file));
    return [...messages.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  } catch { throw new Error('Selected canonical history is unavailable, malformed or outside the owned boundary'); }
}
export const BOARD_REFERENCE_LIMIT = 4096;
function recentReferences(root: string, taskId: string) {
  const refs: Reference[] = [], unread = new Map<string, number>();
  const newestFirst = (a: Reference, b: Reference) => a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
  let count = 0;
  for (const area of ['inbox', 'history']) {
    const directory = path.join(root, 'tasks', taskId, area);
    for (const participant of historyNames(directory, 64)) {
      if (!PARTICIPANT_ID_RE.test(participant)) throw new Error();
      const mailbox = path.join(directory, participant);
      for (const name of entryNames(mailbox)) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!RECORD_ID_RE.test(id)) throw new Error();
        if (area === 'inbox') unread.set(participant, (unread.get(participant) ?? 0) + 1);
        count++;
        refs.push({ id, participant, file: path.join(mailbox, name) });
        if (refs.length === 2 * BOARD_REFERENCE_LIMIT) {
          refs.sort(newestFirst);
          refs.length = BOARD_REFERENCE_LIMIT;
        }
      }
    }
  }
  return { refs: refs.sort(newestFirst).slice(0, BOARD_REFERENCE_LIMIT), unread, older: count > BOARD_REFERENCE_LIMIT };
}
function readIntents(root: string, taskId: string, budget: ReadBudget) {
  const directory = path.join(root, 'tasks', taskId, 'intents');
  const ids = new Set<string>(), participants = new Set<string>();
  try {
    const names = historyNames(directory, 4096).filter(name => name.endsWith('.json')).sort().reverse();
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!RECORD_ID_RE.test(id)) throw new Error();
      ids.add(id);
    }
    for (const id of ids) {
      if (budget.exhausted) break;
      try {
        const message = readMessage(root, taskId, id, path.join(directory, `${id}.json`), budget);
        if (!message) { ids.delete(id); continue; }
        participants.add(message.sender);
        for (const recipient of message.recipients) participants.add(recipient);
      } catch (error) {
        if (!(error instanceof ReadBudgetExceeded)) throw error;
      }
    }
  } catch { throw new Error('Selected canonical intents are unavailable, malformed or outside the owned boundary'); }
  return { ids, participants };
}
export function boardMessages(root: string, taskId: string, budget: ReadBudget) {
  const historyError = () => new Error('Selected canonical history is unavailable, malformed or outside the owned boundary');
  let recent: ReturnType<typeof recentReferences>;
  try { recent = recentReferences(root, taskId); }
  catch { throw historyError(); }
  const { refs, unread, older } = recent;
  // A link in the sample can still belong to a partially delivered intent; list intents after the links.
  const pending = readIntents(root, taskId, budget), messages = new Map<string, MessageV1>();
  try {
    for (const ref of refs) {
      if (budget.exhausted) break;
      let message = readMessage(root, taskId, ref.id, ref.file, budget);
      if (!message) {
        const history = path.join(root, 'tasks', taskId, 'history', ref.participant, `${ref.id}.json`);
        if (history !== ref.file) message = readMessage(root, taskId, ref.id, history, budget);
      }
      addReference(messages, ref, message);
    }
  } catch (error) { if (!(error instanceof ReadBudgetExceeded)) throw historyError(); }
  return { messages: [...messages.values()].reverse().filter(message => !pending.ids.has(message.id)),
    unread, older, pending: pending.participants };
}
export function toMessage(message: MessageV1) {
  return { id: message.id, sender: message.sender, recipients: message.recipients, type: message.type,
    body: message.body.slice(0, 16000), bodyTruncated: message.body.length > 16000,
    created: message.ts, artifact: clipped(message.artifact) };
}
function taskOwner(task: TaskV1) {
  const participant = task.participants.find(value => value.id === task.owner);
  if (!participant || participant.role !== 'orchestrator') throw new Error('Selected task owner is unavailable');
  return { id: participant.id, harness: participant.harness, sessionRef: clipped(participant.metadata.owner) };
}
export function readTasks(input: { storeRoot: string; nativeRoot: string }, budget?: ReadBudget) {
  const { storeRoot } = rootsSchema.parse(input);
  const result: { tasks: { id: string; title: string; state: 'active' | 'done'; updated: string }[]; truncated: boolean; scanned: number }
    = { tasks: [], truncated: false, scanned: 0 };
  if (!existsSync(storeRoot)) return result;
  ownedDirectory(storeRoot);
  const directory = path.join(storeRoot, 'tasks');
  try { ownedDirectory(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
  const handle = opendirSync(directory);
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (result.scanned >= 4096) { result.truncated = true; break; }
      result.scanned++;
      if (!selectionSchema.shape.taskId.safeParse(entry.name).success) continue;
      try {
        const task = selectedTask(storeRoot, entry.name, budget);
        if (task) result.tasks.push({ id: task.id, title: task.title, state: task.status, updated: task.updated });
      } catch (error) {
        if (error instanceof ReadBudgetExceeded) { result.truncated = true; break; }
      }
    }
  } finally { handle.closeSync(); }
  // Active runs first, so finished ones never crowd an active run out of the 256 kept.
  result.tasks.sort((a, b) => Number(a.state === 'done') - Number(b.state === 'done') || b.updated.localeCompare(a.updated));
  if (result.tasks.length > 256) { result.tasks.length = 256; result.truncated = true; }
  return catalogueSchema.parse(result);
}
export function readOwnerFeed(input: Selection) {
  const { storeRoot, taskId } = selectionSchema.parse(input);
  const task = existsSync(storeRoot) ? selectedTask(storeRoot, taskId) : null;
  if (!task) return { taskId, state: 'not prepared' as const, ownerParticipantId: '', ownerSessionRef: null, messages: [] };
  const owner = taskOwner(task);
  return { taskId, state: task.status, ownerParticipantId: owner.id, ownerSessionRef: owner.sessionRef,
    messages: taskMessages(storeRoot, taskId, owner.id).map(({ id, sender, recipients, type }) => ({ id, sender, recipients, type })) };
}
function commandCounts(root: string, file: unknown, identity: { ref: unknown; launchId: unknown; task: unknown; address: unknown }) {
  if (file == null) return null;
  if (typeof file !== 'string') throw new Error('Native command receipt path is malformed');
  const content = ownedText(root, file, 8 * 1024 * 1024);
  if (content === null) return null;
  const lines = content.split('\n'), tail = lines.pop();
  const rows = lines.filter(Boolean).map(parseRecord);
  const launch = rows[0];
  if (!launch || launch.kind !== 'launch' || Object.entries(identity).some(([key, value]) => launch[key] !== value))
    throw new Error('Command receipt launch identity mismatch');
  if (rows.some((row, index) => row.sequence !== index + 1)) throw new Error('Command receipt sequence is incomplete');
  return { starts: rows.filter(row => row.kind === 'item/started').length,
    terminals: rows.filter(row => row.kind === 'item/completed').length,
    rawSelected: rows.filter(row => row.kind === 'rawResponseItem/completed').length, incompleteTail: Boolean(tail) };
}
export function readProjection(input: Selection, instance: string, pid: number): Snapshot {
  const { storeRoot, nativeRoot, taskId } = selectionSchema.parse(input);
  const snapshot: Snapshot = { selection: { storeRoot, nativeRoot, taskId }, sampledAt: new Date().toISOString(), observer: { instance, pid },
    task: { id: taskId, title: taskId, state: 'not prepared', updated: null, owner: null }, actors: [], messages: [], limits: [
      'Selected command receipt events only; other tool attempts are not measured.',
      'Native state and busy values are stored registry values; process liveness is not checked. Missing native records are unknown; registry absence is not physical drain proof.',
      'Snapshot reads do not execute work, consume mail, ACK, recover or control actors.',
      'Terminal close and canonical task completion do not prove native process removal.',
    ] };
  if (!existsSync(storeRoot)) return snapshot;
  ownedDirectory(storeRoot);
  const task = selectedTask(storeRoot, taskId);
  if (task === null) return snapshot;
  if (task.participants.length > 64) throw new Error('Selected task exceeds 64 participants');
  snapshot.task = { id: task.id, title: task.title, state: task.status, updated: task.updated, owner: taskOwner(task) };
  if (existsSync(nativeRoot)) ownedDirectory(nativeRoot);
  for (const participant of task.participants.filter(value => value.mode === 'managed')) {
    const address = addressOf(participant) ?? participant.id;
    const actor: Snapshot['actors'][number] = { participantId: participant.id, address, role: participant.role, harness: participant.harness,
      model: clipped(participant.metadata.model), effort: clipped(participant.metadata.effort),
      sessionRef: clipped(participant.sessionRef), launchId: clipped(participant.metadata.nativeLaunchId),
      threadId: clipped(participant.metadata.sessionId), state: 'native record unavailable', busy: null, sandbox: null, commands: null };
    snapshot.actors.push(actor);
    if (participant.harness !== 'codex' || !participant.sessionRef) continue;
    if (typeof participant.metadata.nativeLaunchId !== 'string' || !participant.metadata.nativeLaunchId) {
      actor.state = 'native launch binding unavailable'; continue;
    }
    if (!existsSync(nativeRoot)) continue;
    const text = ownedText(nativeRoot, path.join(nativeRoot, 'sessions', sessionFileName(participant.sessionRef)));
    if (text === null) continue;
    const record = parseRecord(text);
    if (record.home !== storeRoot || record.task !== taskId || record.address !== address
      || record.ref !== participant.sessionRef || typeof record.launchId !== 'string'
      || record.launchId !== participant.metadata.nativeLaunchId) throw new Error('Native participant launch identity mismatch');
    actor.launchId = clipped(record.launchId); actor.threadId = clipped(record.threadId);
    actor.model = clipped(record.model) ?? actor.model; actor.effort = clipped(record.effort) ?? actor.effort;
    actor.state = clipped(record.state) ?? 'unknown'; actor.busy = typeof record.busy === 'boolean' ? record.busy : null;
    actor.sandbox = clipped(record.sandbox);
    actor.commands = commandCounts(nativeRoot, record.commandReceiptFile,
      { ref: record.ref, launchId: record.launchId, task: taskId, address });
  }
  snapshot.messages = taskMessages(storeRoot, taskId).slice(-32).map(toMessage);
  return snapshotSchema.parse(snapshot);
}

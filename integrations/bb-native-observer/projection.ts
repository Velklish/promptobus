import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { addressOf, PARTICIPANT_ID_RE, requireValid, type MessageV1, type TaskV1 } from '../../src/index.ts';
import { rootsSchema, selectionSchema, snapshotSchema, catalogueSchema, type Selection, type Snapshot } from './contract.js';

const clipped = (value: unknown) => typeof value === 'string' ? value.slice(0, 240) : null;
function parseRecord(text: string) {
  try { return JSON.parse(text); }
  catch { throw new Error('Selected native JSON is malformed'); }
}
function ownedDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || realpathSync(directory) !== directory)
    throw new Error('Selected directory must be a canonical absolute path without symlinks');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Selected directory is not owned by the host user');
}
export function ownedText(root: string, file: string, maximum = 262144): string | null {
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
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
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
function selectedTask(root: string, taskId: string): TaskV1 | null {
  try {
    const text = ownedText(root, path.join(root, 'tasks', taskId, 'task.json'));
    if (text === null) return null;
    const value: unknown = JSON.parse(text);
    requireValid('task', value);
    const task = value as TaskV1;
    if (task.id !== taskId) throw new Error();
    return task;
  } catch { throw new Error('Selected canonical task is unavailable, malformed or outside the owned boundary'); }
}
function historyNames(directory: string, limit: number): string[] {
  try { ownedDirectory(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const handle = opendirSync(directory), names: string[] = [];
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (names.length >= limit) throw new Error();
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return names;
}
function taskMessages(root: string, taskId: string, onlyParticipant?: string): MessageV1[] {
  try {
    const refs: { id: string; participant: string; file: string }[] = [];
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
    for (const ref of refs) {
      const text = ownedText(root, ref.file);
      if (text === null) throw new Error();
      const value: unknown = JSON.parse(text);
      requireValid('message', value);
      const message = value as MessageV1;
      if (message.task !== taskId || message.id !== ref.id || !message.recipients.includes(ref.participant)) throw new Error();
      const prior = messages.get(message.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(message)) throw new Error();
      messages.set(message.id, message);
    }
    return [...messages.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  } catch { throw new Error('Selected canonical history is unavailable, malformed or outside the owned boundary'); }
}
function taskOwner(task: TaskV1) {
  const participant = task.participants.find(value => value.id === task.owner);
  if (!participant || participant.role !== 'orchestrator') throw new Error('Selected task owner is unavailable');
  return { id: participant.id, harness: participant.harness, sessionRef: clipped(participant.metadata.owner) };
}
export function readTasks(input: { storeRoot: string; nativeRoot: string }) {
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
      if (result.scanned >= 4096 || result.tasks.length >= 256) { result.truncated = true; break; }
      result.scanned++;
      if (!selectionSchema.shape.taskId.safeParse(entry.name).success) continue;
      try {
        const task = selectedTask(storeRoot, entry.name);
        if (task) result.tasks.push({ id: task.id, title: task.title, state: task.status, updated: task.updated });
      } catch { continue; }
    }
  } finally { handle.closeSync(); }
  result.tasks.sort((a, b) => b.updated.localeCompare(a.updated));
  return catalogueSchema.parse(result);
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
  snapshot.messages = taskMessages(storeRoot, taskId).slice(-32).map(message => ({
    id: message.id, sender: message.sender, recipients: message.recipients, type: message.type,
    body: message.body.slice(0, 16000), bodyTruncated: message.body.length > 16000,
    created: message.ts, artifact: clipped(message.artifact),
  }));
  return snapshotSchema.parse(snapshot);
}

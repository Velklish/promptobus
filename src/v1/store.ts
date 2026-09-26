// The v1 store: what is written and in what order.
// [reference/04-protocol.md#the-v1-store-what-is-written-and-in-what-order](../../docs/reference/04-protocol.md#the-v1-store-what-is-written-and-in-what-order)
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from '../fs/atomic.js';
import { addressOf, mechanismVersionOf, sessionIdOf } from '../protocol.js';
import { withDirLock, withDirLockAsync } from '../fs/lock.js';
import type { DirLockOptions } from '../fs/lock.js';
import { fail, PromptobusError } from './errors.js';
import type { ErrorCode } from './errors.js';
import { blobLockDir, lockDir, taskDir, taskFile, tasksDir } from './layout.js';
import type { FaultHook } from './messages.js';
import { SCHEMA_VERSION, TASK_ID_RE } from './model.js';
import type { ParticipantV1, TaskV1 } from './model.js';
import { requireValid, validate } from './validate.js';

/** Store clock: the suite substitutes its own so stamps are predictable. */
export type Clock = () => Date;

/** What goes into a new task. The owner is a full participant record, not a lone id. */
export interface NewTask {
  id: string;
  title: string;
  owner: ParticipantV1;
  adapter?: Record<string, unknown>;
  parent?: string;
  teamlead?: ParticipantV1;
}

interface TaskLinkIntent {
  parent: string;
  child: TaskV1;
  teamlead: ParticipantV1;
}

export interface TaskLinkRepair {
  parent: string;
  child: string;
  childCreated: boolean;
  teamleadRegistered: boolean;
}

export interface TaskLinkFailure {
  parent: string;
  child: string;
  note: string;
}

function linksDir(home: string, parent: string): string {
  return path.join(taskDir(home, parent), 'links');
}

function linkIntentFile(home: string, parent: string, child: string): string {
  return path.join(linksDir(home, parent), `${child}.json`);
}

function pendingLinks(home: string, parent: string): string[] {
  try {
    return readdirSync(linksDir(home, parent)).filter((name) => name.endsWith('.json')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

function ownerSession(p: ParticipantV1): string | null {
  const value = p.metadata.owner;
  return typeof value === 'string' && value.trim() ? value : null;
}

function validTaskLink(value: unknown, parent: string): asserts value is TaskLinkIntent {
  if (!isObject(value)) fail('schema-invalid', `task link in ${parent} is not an object`, { parent });
  const intent = value as unknown as TaskLinkIntent;
  requireValid('task', intent.child, { task: intent.child?.id });
  requireValid('participant', intent.teamlead, { task: parent, participant: intent.teamlead?.id });
  const owner = intent.child.participants.find((p) => p.id === intent.child.owner);
  const session = owner && ownerSession(owner);
  if (intent.parent !== parent || intent.child.parent !== parent || !owner || owner.role !== 'orchestrator'
    || intent.teamlead.role !== 'teamlead' || !session || sessionIdOf(intent.teamlead) !== session
    || intent.teamlead.metadata.childTask !== intent.child.id) {
    fail('schema-invalid', `task ${intent.child.id} has an invalid parent link to ${parent}`,
      { task: intent.child.id, parent });
  }
}

/**
 * Version of the mechanism reading the journal. It arrives as an ARGUMENT, like
 * home and policy: the package has no version of its own (the journal number is
 * the business of whoever opened the engine), and a module-level pot would be a
 * bridge for a foreign value — exactly what is forbidden here. It is set when
 * the engine opens and reaches every read from there.
 *
 * `null` — "nothing to compare": a mix of versions is not distinguished, and
 * the former path works in full.
 */
export type ReaderVersion = string | null;

const NO_FAULT: FaultHook = () => {};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Numeric version compare: 0.10.0 is newer than 0.9.0; as strings it is the
// other way around. A prerelease or build tail does not disarm the diagnosis:
// comparison uses the numeric core and the refusal keeps the original string.
// Our own, not shared with the CLI: the package does not import consumer
// modules at all, and standalone builds rest on that. `null` — "nothing to
// compare": the journal number is written by the mechanism, but we read it as
// foreign text.
function cmpVersion(a: string, b: string): number | null {
  const pa = a.split(/[-+]/, 1)[0].split('.').map(Number);
  const pb = b.split(/[-+]/, 1)[0].split('.').map(Number);
  if (![...pa, ...pb].every((n) => Number.isInteger(n) && n >= 0)) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The participant whose record was written by a mechanism NEWER than the
 * reader. The evidence is the mechanism version on the record: the adapter
 * writes it when it lifts the participant, and that is how "the journal is
 * corrupt" is told from "the journal is newer than this session".
 *
 * The participant the validator stumbled on is asked FIRST: `verdict.at`
 * names them by index, and naming the first marker-holder instead would send
 * a person to a foreign record — a new CLI overwrites the owner too, and the
 * owner is first in the journal. A path that is not a participant (an extra
 * field on the journal itself) carries no index — then any participant with a
 * newer marker will do: the whole journal was touched by a mechanism newer
 * than this session.
 */
function writtenByNewer(meta: unknown, at: string, reader: ReaderVersion): { address: string; version: string } | null {
  if (!reader || !isObject(meta) || !Array.isArray(meta.participants)) return null;
  const named = /^participants\[(\d+)\]/.exec(at);
  const candidates = named ? [meta.participants[Number(named[1])]] : meta.participants;
  for (const p of candidates) {
    const version = mechanismVersionOf(p as { metadata?: Record<string, unknown> });
    if (version === null || cmpVersion(version, reader) !== 1) continue;
    // A person is named the participant by address, not by mailbox-directory
    // id: the address is what they saw in the spawn report.
    const address = addressOf(p as { metadata?: Record<string, unknown> })
      ?? String((p as { id?: unknown })?.id ?? '?');
    return { address, version };
  }
  return null;
}

/** Journal read-modify-write under the task lock. */
export function withTaskLock<T>(home: string, task: string, fn: () => T, { waitMs = 5000 } = {}): T {
  return withDirLock(lockDir(home, task), fn, {
    waitMs,
    onMissing: () => new PromptobusError('task-not-found', `task ${task} is not in ${tasksDir(home)}`, { task }),
    onBusy: (held, waitedMs) => new PromptobusError('lock-busy',
      `task ${task} journal is busy: waited ${waitedMs} ms`,
      { task, waitedMs, holder: held }),
  });
}

function blobLockWords(home: string, task: string, waitMs: number): DirLockOptions {
  return {
    waitMs,
    onMissing: () => new PromptobusError('task-not-found', `task ${task} is not in ${tasksDir(home)}`, { task }),
    onBusy: (held, waitedMs) => new PromptobusError('lock-busy',
      `task ${task} payloads are busy: waited ${waitedMs} ms`,
      { task, waitedMs, holder: held }),
    onSelfAsync: (lock) => new PromptobusError('lock-self-async',
      `task ${task} payloads are held by an asynchronous publication of this process: `
      + 'a synchronous wait would block the loop that must release them',
      { task, lock }),
  };
}

/** Writing a payload and naming it, or deciding a payload is nobody's — one short lock.
 * [reference/04-protocol.md#store-layout](../../docs/reference/04-protocol.md#store-layout) */
export function withBlobLock<T>(home: string, task: string, fn: () => T, { waitMs = 5000 } = {}): T {
  return withDirLock(blobLockDir(home, task), fn, blobLockWords(home, task, waitMs));
}

/** The same lock for the streaming publication path, which writes the blob across an await. */
export function withBlobLockAsync<T>(home: string, task: string, fn: () => Promise<T>, { waitMs = 5000 } = {}): Promise<T> {
  return withDirLockAsync(blobLockDir(home, task), fn, blobLockWords(home, task, waitMs));
}

export function taskExists(home: string, task: string): boolean {
  try {
    return existsSync(taskFile(home, task));
  } catch {
    // A bad id is not "no such task", it is a grammar refusal; but this is
    // also asked by a disk walk, where a foreign directory is lawful.
    return false;
  }
}

/**
 * Read the journal. Unreadable or invalid — `task-broken`: a damaged task
 * blocks only itself, the rest work (`listTasks` skips it).
 */
export function readTask(home: string, task: string, cli: ReaderVersion = null, fault: FaultHook = NO_FAULT): TaskV1 {
  const file = taskFile(home, task);
  let raw;
  try {
    fault('task-read', { task, file });
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') {
      fail('task-not-found', `task ${task} is not in ${tasksDir(home)}`, { task, file, errno });
    }
    if (typeof errno !== 'string') throw e;
    fail('task-broken', `task ${task} journal could not be read (${errno}): ${(e as Error).message}`,
      { task, file, errno });
  }
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch (e) {
    fail('task-broken', `task ${task} journal did not parse: ${(e as Error).message}`, { task, file });
  }
  const verdict = validate('task', meta);
  if (!verdict.ok) {
    // Unfamiliar fields plus a record written by a mechanism newer than this
    // session are not journal corruption, they are a mix of versions after
    // `sync`: the live session's bus MCP server was lifted from the previous
    // release and does not know the new fields. The cure is a new session, and
    // the refusal must name the cure, or a person will fix a journal breakage
    // that is not there.
    const ahead = verdict.extra.length ? writtenByNewer(meta, verdict.at, cli) : null;
    if (ahead) {
      fail('schema-version-unsupported',
        `task ${task} journal: participant ${ahead.address} was written by mechanism ${ahead.version}, `
        + `this session runs ${cli} — start a new session, `
        + 'the bus MCP server starts from the installed release',
        { task, file, at: verdict.at, participant: ahead.address, wrote: ahead.version, reader: cli });
    }
    // A newer schema version has its own code here too: such a task must
    // neither be read as ours nor declared corrupt. It is fixed by updating
    // the mechanism, not by isolating the record.
    fail(verdict.code === 'schema-version-unsupported' ? 'schema-version-unsupported' : 'task-broken',
      `task ${task} journal does not match the schema: ${verdict.at} ${verdict.note}`, { task, file, at: verdict.at });
  }
  return meta as TaskV1;
}

/** Write the journal whole. Validation before the write: the bad never enters the store. */
export function writeTask(home: string, meta: TaskV1, now: Clock): TaskV1 {
  const next: TaskV1 = { ...meta, updated: now().toISOString() };
  requireValid('task', next, { task: next.id });
  const current = readTask(home, next.id);
  if (current.parent !== next.parent) {
    fail('schema-invalid', `task ${next.id} cannot change its parent after creation`, { task: next.id });
  }
  writeJsonAtomic(taskFile(home, next.id), next);
  return next;
}

/** Publish a complete first journal without replacing an earlier writer. */
function writeNewTask(home: string, meta: TaskV1, fault: FaultHook = NO_FAULT): TaskV1 {
  const file = taskFile(home, meta.id);
  mkdirSync(taskDir(home, meta.id), { recursive: true });
  const temp = path.join(taskDir(home, meta.id), `.tmp-task-${randomUUID()}`);
  try {
    writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
    fault('task-link-publish', { task: meta.id, file });
    linkSync(temp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('task-exists', `task ${meta.id} already exists`, { task: meta.id });
    throw e;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return meta;
}

export function createTask(home: string, {
  id, title, owner, adapter = {}, parent, teamlead,
}: NewTask, now: Clock, fault: FaultHook = NO_FAULT, cli: ReaderVersion = null): TaskV1 {
  requireValid('participant', owner, { task: id, participant: (owner as ParticipantV1)?.id });
  const at = now().toISOString();
  const meta: TaskV1 = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title,
    status: 'active',
    ...(parent === undefined ? {} : { parent }),
    owner: owner.id,
    created: at,
    updated: at,
    participants: [owner],
    adapter,
  };
  requireValid('task', meta, { task: id });
  if (parent === undefined) {
    if (teamlead !== undefined) fail('schema-invalid', `task ${id} has a teamlead without a parent`, { task: id });
    return writeNewTask(home, meta);
  }
  if (!teamlead) fail('schema-invalid', `child task ${id} needs a teamlead participant in parent ${parent}`,
    { task: id, parent });
  const linked: ParticipantV1 = { ...teamlead, metadata: { ...teamlead.metadata, childTask: id } };
  const intent: TaskLinkIntent = { parent, child: meta, teamlead: linked };
  validTaskLink(intent, parent);
  return withTaskLock(home, parent, () => {
    const root = requireActive(readTask(home, parent, cli));
    if (root.parent !== undefined) {
      fail('schema-invalid', `task ${parent} is a child and cannot be the parent of ${id}`,
        { task: id, parent });
    }
    const unfinished = pendingLinks(home, parent).map((name) => name.slice(0, -'.json'.length));
    if (unfinished.length) {
      fail('task-active', `task ${parent} has unfinished child link ${unfinished.join(', ')}; recover it first`,
        { task: parent, children: unfinished });
    }
    if (root.participants.some((p) => p.id === linked.id)) {
      fail('participant-exists', `task ${parent} already has teamlead ${linked.id}`, { task: parent, participant: linked.id });
    }
    if (taskExists(home, id)) fail('task-exists', `task ${id} already exists`, { task: id });
    mkdirSync(linksDir(home, parent), { recursive: true });
    const file = linkIntentFile(home, parent, id);
    if (existsSync(file)) fail('task-exists', `task ${id} has an unfinished parent link in ${parent}`,
      { task: id, parent, file });
    writeJsonAtomic(file, intent);
    let child: TaskV1;
    try {
      child = writeNewTask(home, meta, fault);
    } catch (e) {
      if (e instanceof PromptobusError && e.code === 'task-exists') unlinkSync(file);
      throw e;
    }
    fault('task-link', { parent, child: id });
    writeTask(home, { ...root, participants: [...root.participants, linked] }, now);
    unlinkSync(file);
    return child;
  });
}

/** A task that cannot be read: its id, refusal code, and reason. The adapter assembles the text for a person. */
export interface BrokenTask {
  id: string;
  code: ErrorCode;
  note: string;
}

/** List tasks. One corrupt task must not extinguish the rest. */
export function listTasks(home: string, cli: ReaderVersion = null, fault: FaultHook = NO_FAULT): {
  tasks: TaskV1[]; broken: BrokenTask[];
} {
  const dir = tasksDir(home);
  const tasks: TaskV1[] = [];
  const broken: BrokenTask[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { tasks, broken };
  }
  for (const name of names.sort()) {
    if (!taskExists(home, name)) continue;
    try {
      tasks.push(readTask(home, name, cli, fault));
    } catch (e) {
      if (!(e instanceof PromptobusError)) throw e;
      broken.push({ id: name, code: e.code, note: e.message });
    }
  }
  return { tasks, broken };
}

/** Complete child creation whose intent survived a crash between the two journals. */
export function recoverTaskLinks(home: string, now: Clock, task?: string, cli: ReaderVersion = null): {
  links: TaskLinkRepair[]; linkFailures: TaskLinkFailure[];
} {
  const links: TaskLinkRepair[] = [];
  const linkFailures: TaskLinkFailure[] = [];
  const all = listTasks(home, cli).tasks;
  const named = task ? all.find((meta) => meta.id === task) : null;
  const parents = task ? [named?.parent ?? task] : all.map((meta) => meta.id);
  for (const parent of parents) {
    for (const name of pendingLinks(home, parent)) {
      const childId = name.slice(0, -'.json'.length);
      if (!TASK_ID_RE.test(childId)) {
        linkFailures.push({ parent, child: childId, note: `invalid child task id in ${name}` });
        continue;
      }
      try {
        withTaskLock(home, parent, () => {
          const file = linkIntentFile(home, parent, childId);
          if (!existsSync(file)) return;
          const intent: unknown = JSON.parse(readFileSync(file, 'utf8'));
          validTaskLink(intent, parent);
          if (intent.child.id !== childId) {
            fail('schema-invalid', `task link ${file} names child ${intent.child.id}, expected ${childId}`,
              { task: childId, parent, file });
          }
          const root = readTask(home, parent, cli);
          if (root.parent !== undefined) {
            fail('schema-invalid', `task ${parent} is a child and cannot own task link ${childId}`,
              { task: childId, parent });
          }
          const was = root.participants.find((p) => p.id === intent.teamlead.id);
          if (was && (was.metadata.childTask !== childId || sessionIdOf(was) !== sessionIdOf(intent.teamlead))) {
            fail('participant-exists', `task ${parent} teamlead ${was.id} belongs to another child or session`,
              { task: parent, participant: was.id });
          }
          let childCreated = false;
          if (taskExists(home, childId)) {
            const child = readTask(home, childId, cli);
            if (child.parent !== parent) {
              fail('task-exists', `task ${childId} belongs to parent ${child.parent ?? 'none'}, not ${parent}`,
                { task: childId, parent });
            }
          } else {
            writeNewTask(home, intent.child);
            childCreated = true;
          }
          if (!was) writeTask(home, { ...root, participants: [...root.participants, intent.teamlead] }, now);
          unlinkSync(file);
          links.push({ parent, child: childId, childCreated, teamleadRegistered: !was });
        });
      } catch (e) {
        if (!(e instanceof PromptobusError) && !(e instanceof SyntaxError)
          && typeof (e as NodeJS.ErrnoException).code !== 'string') throw e;
        linkFailures.push({ parent, child: childId, note: (e as Error).message });
      }
    }
  }
  return { links, linkFailures };
}

export function participantOf(meta: TaskV1, id: string): ParticipantV1 | null {
  return meta.participants.find((p) => p.id === id) ?? null;
}

export function requireParticipant(meta: TaskV1, id: string): ParticipantV1 {
  const found = participantOf(meta, id);
  if (!found) {
    fail('participant-not-found', `task ${meta.id} has no participant «${id}»`,
      { task: meta.id, participant: id, known: meta.participants.map((p) => p.id) });
  }
  return found;
}

/** Add a participant. An existing id is a refusal: an overwrite would erase their fields in silence. */
export function addParticipant(home: string, task: string, participant: ParticipantV1, now: Clock,
  cli: ReaderVersion = null): ParticipantV1 {
  requireValid('participant', participant, { task, participant: participant?.id });
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    if (participantOf(meta, participant.id)) {
      fail('participant-exists', `task ${task} already has participant «${participant.id}»`,
        { task, participant: participant.id });
    }
    writeTask(home, { ...meta, participants: [...meta.participants, participant] }, now);
    return participant;
  });
}

/**
 * Put a participant record whole, replacing the former one. The difference
 * from `patchParticipant` is not convenience: lifting a participant writes a
 * NEW record — a new session, a new capabilities snapshot — and must take
 * with it everything that belonged to the former one, including adapter marks
 * in `metadata`. A field patch would leave those from the dead session.
 *
 * The whole journal is returned: the caller needs it too — the task title is
 * computed from tracks off it, and a second read right after the write would
 * be a read from under a neighbour.
 */
export function putParticipant(home: string, task: string, participant: ParticipantV1, now: Clock,
  cli: ReaderVersion = null): TaskV1 {
  requireValid('participant', participant, { task, participant: participant?.id });
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    const rest = meta.participants.filter((p) => p.id !== participant.id);
    return writeTask(home, { ...meta, participants: [...rest, participant] }, now);
  });
}

/** What can be patched on a participant record. `id` is not patched: it is the address. */
export type ParticipantPatch = Partial<Omit<ParticipantV1, 'id'>>;

/**
 * Patch a participant by fields. Not a whole replace: in legacy
 * `upsertParticipant` a second call that adds a field must put back the same
 * record, or the first call's fields vanish in silence. The schema is checked
 * AFTER the merge — a patch that breaks the record refuses before the journal
 * is written.
 */
export function patchParticipant(home: string, task: string, id: string, patch: ParticipantPatch, now: Clock,
  cli: ReaderVersion = null): ParticipantV1 {
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    const was = requireParticipant(meta, id);
    const next: ParticipantV1 = { ...was, ...patch, id: was.id };
    requireValid('participant', next, { task, participant: id });
    writeTask(home, {
      ...meta,
      participants: meta.participants.map((p) => (p.id === id ? next : p)),
    }, now);
    return next;
  });
}

/**
 * Claim ownership of the task. A task has one owner, and that is the only way
 * it changes — there is no silent takeover. The previous owner is returned:
 * there is one field, and no history.
 */
export function claimOwner(home: string, task: string, id: string, now: Clock,
  cli: ReaderVersion = null): string {
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    requireParticipant(meta, id);
    const was = meta.owner;
    if (was !== id) writeTask(home, { ...meta, owner: id }, now);
    return was;
  });
}

/**
 * Close the task. Adapter fields are laid down in THE SAME pass: the adapter
 * writes the close mark, and a second lock for one field would cost a task
 * closed without it.
 */
export function closeTask(home: string, task: string, now: Clock, adapter?: Record<string, unknown>,
  cli: ReaderVersion = null): TaskV1 {
  return withTaskLock(home, task, () => {
    const meta = readTask(home, task, cli);
    if (meta.parent === undefined) {
      const listed = listTasks(home, cli);
      const active = listed.tasks.filter((child) => child.parent === task && child.status === 'active')
        .map((child) => child.id);
      const broken = new Set(listed.broken.map((child) => child.id));
      const linkedBroken = meta.participants.map((p) => p.metadata.childTask)
        .filter((id): id is string => typeof id === 'string' && broken.has(id) && taskExists(home, id));
      const pending = pendingLinks(home, task).map((name) => name.slice(0, -'.json'.length));
      const children = [...new Set([...active, ...linkedBroken, ...pending])];
      if (children.length) {
        fail('task-active', `task ${task} cannot close while child task ${children.join(', ')} is active or unfinished`,
          { task, children });
      }
    }
    return writeTask(home, {
      ...meta,
      status: 'done',
      ...(adapter === undefined ? {} : { adapter: { ...meta.adapter, ...adapter } }),
    }, now);
  });
}

/** Whether the task is active. Send into a closed one is a refusal: a closed task's correspondence is not continued. */
export function requireActive(meta: TaskV1): TaskV1 {
  if (meta.status !== 'active') {
    fail('task-closed', `task ${meta.id} is closed`, { task: meta.id, status: meta.status });
  }
  return meta;
}

export { taskDir };

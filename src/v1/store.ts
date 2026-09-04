// Task journal v1: the task, participants, the owner, and an explicit claim.
//
// Differences from the legacy store are not cosmetic, and both were named by a decision:
//
// 1. **The owner is a participant like any other.** It has `harness`, `mode`,
//    `sessionRef`, and `capabilities`, and it is written when the task is
//    created. v1 has no harness fallback at all: it was added to the registry
//    exactly for the owner record that legacy `createTask` wrote without that field.
// 2. **Updating a participant is a field patch, not a whole-record replace.**
//    In legacy `upsertParticipant` a second call that adds one field must put
//    back THE SAME record — otherwise the first call's fields vanish in
//    silence. There is no such invariant here: the patch touches the named
//    fields and checks the schema after the merge.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { writeJsonAtomic } from '../fs/atomic.js';
import { addressOf, mechanismVersionOf } from '../protocol.js';
import { withDirLock } from '../fs/lock.js';
import { fail, PromptobusError } from './errors.js';
import { lockDir, taskDir, taskFile, tasksDir } from './layout.js';
import { SCHEMA_VERSION } from './model.js';
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Numeric version compare: 0.10.0 is newer than 0.9.0; as strings it is the
// other way around. Our own, not shared with the CLI: the package does not
// import consumer modules at all, and standalone builds rest on that. `null`
// — "nothing to compare": the journal number is written by the mechanism, but
// we read it as foreign text.
function cmpVersion(a: string, b: string): number | null {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
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
export function readTask(home: string, task: string, cli: ReaderVersion = null): TaskV1 {
  const file = taskFile(home, task);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    fail('task-not-found', `task ${task} is not in ${tasksDir(home)}`, { task, file });
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
  writeJsonAtomic(taskFile(home, next.id), next);
  return next;
}

/**
 * Create a task. First writer wins: the journal is laid down with the `wx`
 * flag, and a latecomer gets a refusal, not a quiet theft of foreign participants.
 */
export function createTask(home: string, { id, title, owner, adapter = {} }: NewTask, now: Clock): TaskV1 {
  requireValid('participant', owner, { task: id, participant: (owner as ParticipantV1)?.id });
  const at = now().toISOString();
  const meta: TaskV1 = {
    schemaVersion: SCHEMA_VERSION,
    id,
    title,
    status: 'active',
    owner: owner.id,
    created: at,
    updated: at,
    participants: [owner],
    adapter,
  };
  requireValid('task', meta, { task: id });
  const file = taskFile(home, id);
  mkdirSync(taskDir(home, id), { recursive: true });
  try {
    // The `wx` flag, not an atomic replace: the record itself takes the name,
    // and a second pass with the same id gets a refusal instead of a quiet
    // overwrite. An `existsSync` check before the write would be the same
    // window, only wider — a neighbour fits between the check and the write.
    writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('task-exists', `task ${id} already exists`, { task: id });
    throw e;
  }
  return meta;
}

/** A task that cannot be read: its id and the reason. The adapter assembles the text for a person. */
export interface BrokenTask {
  id: string;
  note: string;
}

/** List tasks. One corrupt task must not extinguish the rest. */
export function listTasks(home: string, cli: ReaderVersion = null): { tasks: TaskV1[]; broken: BrokenTask[] } {
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
      tasks.push(readTask(home, name, cli));
    } catch (e) {
      broken.push({ id: name, note: (e as Error).message });
    }
  }
  return { tasks, broken };
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

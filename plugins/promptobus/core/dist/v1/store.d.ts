import type { ErrorCode } from './errors.js';
import { taskDir } from './layout.js';
import type { FaultHook } from './messages.js';
import type { ParticipantV1, TaskV1 } from './model.js';
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
/** Journal read-modify-write under the task lock. */
export declare function withTaskLock<T>(home: string, task: string, fn: () => T, { waitMs }?: {
    waitMs?: number | undefined;
}): T;
/** Writing a payload and naming it, or deciding a payload is nobody's — one short lock.
 * [reference/04-protocol.md#store-layout](../../docs/reference/04-protocol.md#store-layout) */
export declare function withBlobLock<T>(home: string, task: string, fn: () => T, { waitMs }?: {
    waitMs?: number | undefined;
}): T;
/** The same lock for the streaming publication path, which writes the blob across an await. */
export declare function withBlobLockAsync<T>(home: string, task: string, fn: () => Promise<T>, { waitMs }?: {
    waitMs?: number | undefined;
}): Promise<T>;
export declare function taskExists(home: string, task: string): boolean;
/**
 * Read the journal. Unreadable or invalid — `task-broken`: a damaged task
 * blocks only itself, the rest work (`listTasks` skips it).
 */
export declare function readTask(home: string, task: string, cli?: ReaderVersion, fault?: FaultHook): TaskV1;
/** Write the journal whole. Validation before the write: the bad never enters the store. */
export declare function writeTask(home: string, meta: TaskV1, now: Clock): TaskV1;
export declare function createTask(home: string, { id, title, owner, adapter, parent, teamlead, }: NewTask, now: Clock, fault?: FaultHook, cli?: ReaderVersion): TaskV1;
/** A task that cannot be read: its id, refusal code, and reason. The adapter assembles the text for a person. */
export interface BrokenTask {
    id: string;
    code: ErrorCode;
    note: string;
}
/** List tasks. One corrupt task must not extinguish the rest. */
export declare function listTasks(home: string, cli?: ReaderVersion, fault?: FaultHook): {
    tasks: TaskV1[];
    broken: BrokenTask[];
};
/** Complete child creation whose intent survived a crash between the two journals. */
export declare function recoverTaskLinks(home: string, now: Clock, task?: string, cli?: ReaderVersion): {
    links: TaskLinkRepair[];
    linkFailures: TaskLinkFailure[];
};
export declare function participantOf(meta: TaskV1, id: string): ParticipantV1 | null;
export declare function requireParticipant(meta: TaskV1, id: string): ParticipantV1;
/** Add a participant. An existing id is a refusal: an overwrite would erase their fields in silence. */
export declare function addParticipant(home: string, task: string, participant: ParticipantV1, now: Clock, cli?: ReaderVersion): ParticipantV1;
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
export declare function putParticipant(home: string, task: string, participant: ParticipantV1, now: Clock, cli?: ReaderVersion): TaskV1;
export declare function assignParticipant(home: string, task: string, participant: ParticipantV1, now: Clock, cli?: ReaderVersion): TaskV1;
/** What can be patched on a participant record. `id` is not patched: it is the address. */
export type ParticipantPatch = Partial<Omit<ParticipantV1, 'id'>>;
/**
 * Patch a participant by fields. Not a whole replace: in legacy
 * `upsertParticipant` a second call that adds a field must put back the same
 * record, or the first call's fields vanish in silence. The schema is checked
 * AFTER the merge — a patch that breaks the record refuses before the journal
 * is written.
 */
export declare function patchParticipant(home: string, task: string, id: string, patch: ParticipantPatch, now: Clock, cli?: ReaderVersion): ParticipantV1;
/**
 * Claim ownership of the task. A task has one owner, and that is the only way
 * it changes — there is no silent takeover. The previous owner is returned:
 * there is one field, and no history.
 */
export declare function claimOwner(home: string, task: string, id: string, now: Clock, cli?: ReaderVersion): string;
/**
 * Close the task. Adapter fields are laid down in THE SAME pass: the adapter
 * writes the close mark, and a second lock for one field would cost a task
 * closed without it.
 */
export declare function closeTask(home: string, task: string, now: Clock, adapter?: Record<string, unknown>, cli?: ReaderVersion): TaskV1;
/** Whether the task is active. Send into a closed one is a refusal: a closed task's correspondence is not continued. */
export declare function requireActive(meta: TaskV1): TaskV1;
export { taskDir };

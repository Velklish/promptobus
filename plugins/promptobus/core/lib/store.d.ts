import { brokenNote, withTaskLock as lockTask, withTaskLockAsync as lockTaskAsync } from '../dist/index.js';
import { writeJsonAtomic } from '../dist/fs/atomic.js';
import { artifactsDir, blobsDir, brokenArtifactsDir, filesDir, messagesDir } from '../dist/v1/layout.js';
import { writeTask } from '../dist/v1/store.js';
import type { Engine, HistoryQuery, Mailbox, MessageV1, OutgoingMessage, Ownership, ParticipantV1, PromptobusHost, RoleRegistry, SenderCaller, SentMessage, TaskV1 } from '../dist/index.js';
interface IdentityScope {
    home: string;
    task: string | null;
    address: string | null;
}
interface IdentityAnswer {
    id: string | null;
    reason: string;
    why: string | null;
    candidates: unknown[];
}
type IdentityReader = (env: NodeJS.ProcessEnv, scope: IdentityScope | null) => IdentityAnswer | null;
type ContactTask = Pick<TaskV1, 'id' | 'participants'> & Partial<Pick<TaskV1, 'parent' | 'adapter'>>;
type MessageHeader = Omit<MessageV1, 'body' | 'protocolVersion'> & {
    firstLine?: string;
};
interface HeaderOptions {
    statusLine?: boolean;
}
interface MessageRead {
    file: string;
    type: string;
    purpose: string | null;
}
interface ContactRoute {
    address: string | null;
    task: string;
    types: readonly string[];
}
interface TaskHints {
    spawnRepo: string;
    spawnNewTask: string;
}
interface SendHints {
    status: string;
    registry?: RoleRegistry;
}
interface CreateTaskInput {
    id?: string;
    title?: string;
    adapter?: Record<string, unknown>;
    owner?: string | null;
    parent?: string;
    teamlead?: string;
}
interface RetitleOptions {
    title?: string | null;
    fromLines?: boolean;
    explicit?: boolean;
    restamp?: boolean;
    session?: string | null;
}
interface DeclaredIdentity {
    role?: unknown;
    home?: unknown;
    task?: unknown;
}
export { artifactsDir, blobsDir, brokenArtifactsDir, filesDir, messagesDir };
export { ORCHESTRATOR, isAddress, addrDir, roleOf, addressOf, workerAddress, reviewerAddress, approverAddress, participantFileStem, SLUG_MAX, slugify, newTaskIdentity, stampOfId, TASK_TITLE_SEP, GateError, FOREIGN_MARK, FOREIGN_ROUTE, MAILBOX_CLAIMED_MARK, foreignTaskLine, claimRoute, brokenNote, sessionOf, sessionIdOf, sameSession, foreignSessionOf, holdsSession, startedOf, MESSAGE_TYPES, ERROR_CODES, PromptobusError, taskDir, tasksDir, workersDir, sessionsDir, sessionFile, wakeFile, healthFile, stallsFile, wardenLogFile, wardenMarkFile, pidAlive, WARDEN_BEAT_SEC, liveWarden, claimWarden, beatWarden, clearWarden, readWake, writeWake, readHealth, writeHealth, logWarden, tailWardenLog, readWardenExit, readWardenGeneration, writeWardenExit, clearWardenExit, lastTurnAt, markTurn, markTranscript, readTranscript, lockBusyError, } from '../dist/index.js';
export declare const PROMPTOBUS_REL = ".promptobus";
export declare const FALLBACK_HARNESS = "claude";
export declare function promptobusHome(root: string, host: PromptobusHost | null | undefined): string;
export declare function withIdentityEnvironment<T>(env: NodeJS.ProcessEnv, fn: () => T): T;
export declare function bindSessionIdentity(fn: IdentityReader | null): void;
/**
 * `null` is an answer here, never a silence. Unbound, the core says so once instead of
 * falling back to one harness's variable — the fallback IS the defect (ADR-019).
 */
export declare function sessionIdentity(env?: NodeJS.ProcessEnv, scope?: IdentityScope | null): string | null;
export declare function contestedIdentity(answer: IdentityAnswer | null | undefined): answer is IdentityAnswer & {
    reason: 'contested' | 'contested-records';
};
/**
 * The resolver's whole answer, for a caller whose refusal must SAY why there is no identity.
 * `sessionIdentity` drops everything but the id, and "none" and "contested" then look alike.
 */
export declare function sessionIdentityReport(env?: NodeJS.ProcessEnv, scope?: IdentityScope | null): IdentityAnswer;
/** The participant mailbox of an address: its primary address and the slots read as one; `alias` when
 * the address is an address alias (ADR-028). */
export declare function mailboxOf(home: string, id: string, addr: string): Mailbox;
/** The child's record that stands for its root orchestrator, or `null`. */
export declare function rootRecordOf(child: TaskV1 | null | undefined): ParticipantV1 | null;
/** The child's address for its root: its record's, else `root:<root slug>`, never a bare `root` —
 * 04-protocol § Addresses gives the reason. */
export declare function rootAddressOf(root: TaskV1, child?: TaskV1 | null): string;
/** The address of the child's `root:<slug>` record, written by the teamlead lift when it is missing. */
export declare function ensureRootRecord(home: string, childId: string): string | null;
/**
 * v1 engine of this home — the only mechanism door into the store. The store directory is
 * given in full: the mechanism receives it from an environment variable, and `.promptobus`
 * may be missing from the end entirely.
 */
export declare function bus(home: string, { cli }?: {
    cli?: string;
}): Engine;
/**
 * v1 participant record from an address and mechanism fields.
 *
 * Own v1 fields are `id`, `role`, `harness`, `mode`, `sessionRef`, `capabilities`; everything
 * else the mechanism writes about the participant (track title, repository, session name,
 * start time, dismissed-from-watch mark) rides in `metadata` in full, and the address lives
 * there too: it is how the participant is named to a human, and how health, contact points
 * and stop marks are keyed.
 */
export declare function participantRecord(address: string, fields?: Record<string, unknown>, registry?: RoleRegistry): ParticipantV1;
export declare function participantMcpPath(home: string, taskId: string, address: string): string;
export declare function participantSettingsPath(home: string, taskId: string, address: string): string;
export declare function participantSessionPath(home: string, taskId: string, address: string): string;
export declare function dropStaleWake(home: string, taskId: string, address: string, session: string | null): boolean;
/**
 * Participant DIRECTORIES in `workers/` — those the driver created next to the files.
 * The driver chooses the directory name, so the mechanism recognises them by the shared
 * address stem, not by name: the Cursor and Codex drivers each seat a reviewer in one of
 * these, Claude Code has none at all. What is inside differs by driver — a Cursor
 * reviewer's holds its project configs, including an MCP config with tokens substituted
 * in, while a Codex reviewer's holds a copy of the workspace skills canon and nothing
 * secret — so the same `promptobus done` sweep that cleans mcp-configs removes them
 * whole, without asking a driver what it put there.
 */
export declare function participantDirs(home: string, taskId: string, address: string): string[];
/** Participant of the task by address; `null` — no such record in the journal. */
export declare function participantOf<T extends {
    metadata?: Record<string, unknown> | null;
}>(meta: {
    participants?: readonly T[];
} | null | undefined, address: unknown): T | null;
/** Addresses of the task participants, in record order. Invalid records are skipped. */
export declare function addressesOf(meta: TaskV1 | null | undefined): (string | null)[];
export declare function taskExists(home: string, id: unknown): boolean;
export declare function taskFile(home: string, id: string): string;
export declare function inboxDir(home: string, id: string, addr: string): string;
/** What this address has read: in v1 the directory is called `history/` — fan-out
 * recovery uses the filename in it to tell delivered from missing. */
export declare function historyDir(home: string, id: string, addr: string): string;
/** Where unreadable mail from this address mailbox is set aside. */
export declare function brokenDir(home: string, id: string, addr: string): string;
export declare function withTaskCache<T>(fn: () => T): T;
export declare function readTask(home: string, id: string): TaskV1;
/** Read-modify-write of the journal under the task lock, with session identity for diagnosis. */
export declare function withTaskLock<T>(home: string, id: string, fn: () => T, opts?: Parameters<typeof lockTask>[3]): T;
/** Asynchronous journal work with the same session diagnosis and cache suspension. */
export declare function withTaskLockAsync<T>(home: string, id: string, fn: () => Promise<T>, opts?: Parameters<typeof lockTaskAsync>[3]): Promise<T>;
/** Patch the journal: title and mechanism fields in `adapter`. `adapter` fields are merged. */
export declare function patchTask(home: string, id: string, patch: Parameters<Engine['patchTask']>[1]): TaskV1;
/**
 * Create a task IN JOURNAL FORM: `{ id, title, adapter }` — the same form `readTask`
 * returns. One form on purpose: the command plan carries the journal it will write, and
 * reads it by the same fields the next command will read — slug, stamp and the explicit-
 * title mark live in `adapter`; the own fields of the task there are title and status.
 *
 * The mailbox-owner session is not a task field: it rides in the `orchestrator` participant
 * record `metadata`, and is written only when the environment supplied identity.
 */
export declare function createTask(home: string, { id, title, adapter: fields, owner, parent, teamlead, }?: CreateTaskInput): TaskV1;
export declare function listTasks(home: string): TaskV1[];
export declare function activeTasks(home: string): TaskV1[];
export declare function closeTask(home: string, id: string): TaskV1;
export declare function resolveTaskId(home: string, declared: string | null | undefined, session: string | null | undefined, hints: TaskHints): string;
export declare function identityLabel(home: string, task: string, addr: string, session?: string | null): string;
/**
 * Put the participant in full, replacing the former record. Lift writes a NEW record — a
 * new session, a new capabilities snapshot — and takes with it everything that belonged
 * to the former one, including the dismissed-from-watch mark.
 */
export declare function upsertParticipant(home: string, id: string, participant: ParticipantV1): TaskV1;
export declare function changePeerLink(home: string, aId: string, bId: string, { session, unlink, write }?: {
    session?: string | null;
    unlink?: boolean;
    write?: typeof writeTask;
}): {
    a: string;
    b: string;
};
export declare function dismissParticipant(home: string, id: string, address: string, at?: string): {
    found: boolean;
    was: {} | null;
};
export declare function watchParticipant(home: string, id: string, address: string): {
    found: boolean;
    was: {} | null;
};
/**
 * Record on the reviewer which snapshot it is holding: the moment the diff file was
 * written, the worktree HEAD it was taken from, and whether its tracked tree was clean
 * with the paths that differed when it was not. Together they answer how far behind
 * the file is and whether its contents matched HEAD for `promptobus status` and
 * `promptobus_task`, without opening the file and without asking the reviewer.
 *
 * A patch and not `upsertParticipant`, because it is called where the record must NOT be
 * replaced: a re-review only sends a message to a live session, and putting the record
 * in full there would take the session id and the capabilities snapshot with it. A fresh
 * lift writes the same fields itself, in the record it lays.
 *
 * `head` is absent on a repository with no commits; then the former one is REMOVED
 * rather than kept — a stale sha beside a fresh time reads as a snapshot from a commit
 * this diff was never taken from. The path list is always replaced too: otherwise a
 * clean re-review would keep reporting the prior dirty paths.
 */
export declare function stampSnapshot(home: string, id: string, address: string, { at, head, clean, modifiedTracked }: {
    at: string;
    head?: string | null;
    clean: boolean;
    modifiedTracked: string[];
}): {
    found: boolean;
};
/** Causal reviewer-assignment watermark — set from the sent task message; null clears until send. */
export declare function stampReviewAssignment(home: string, id: string, address: string, afterId: string | null, at?: string | null): {
    found: boolean;
};
export declare function titleFromLines(meta: {
    participants?: readonly {
        metadata: Record<string, unknown>;
    }[];
} | null | undefined, registry?: RoleRegistry): string | null;
export declare function retitleTask(home: string, id: string, { title, fromLines, explicit, restamp, session, }?: RetitleOptions, registry?: RoleRegistry): string | null;
export declare function taskOwner(home: string, id: string): string | null;
/**
 * Two answers about the `orchestrator` mailbox, and they are not each other's negation:
 * `allowed` is the right, `gated` the narrower "proved foreign" — 03-cli § The owner gate.
 */
export declare function ownership(home: string, id: string, addr: string, session: string | null): Ownership;
export declare function orchestratedTasks(home: string, session?: string | null): TaskV1[];
/**
 * Head of a refusal from the owner gate: what the call could NOT prove, by `right`
 * — 03-cli § The owner gate.
 */
export declare function unprovenOwnerLine(home: string, meta: TaskV1, own: Ownership): string;
/**
 * Where to go after that refusal, and every branch must be walkable by whoever gets it
 * — 03-cli § The owner gate.
 */
export declare function ownerRoute(home: string, meta: TaskV1, own: Ownership, repeat: string): string;
/** The owner-gate line, the shared copy sentence, and `ownerRoute`. `null` for every
 * other `right`: those words belong to the refusal, and a second wording would drift. */
export declare function noIdentityMailboxLine(home: string, id: string, own: Ownership | null | undefined): string | null;
/** An approver of THIS task holding the calling session, proven by the participant record's own
 * session — the one home of the proof `sweep`, `dismiss` and `stop` share. */
export declare function approverHere(meta: TaskV1 | null | undefined, session: string | null): ParticipantV1 | null;
/** Why the approver route did not open either, said only where an approver record exists: a
 * record with no session of its own, or a session that is not the one recorded. */
export declare function unprovenApproverLine(meta: TaskV1 | null | undefined, session: string | null): string | null;
/**
 * Whether these are the same `orchestrator` mailbox owner id. Both sides are full
 * (`CLAUDE_CODE_SESSION_ID`): `registerWake` and the `owner` field store the same thing.
 * A `sameSession` prefix here is fail-open — a short id would match a foreign full one
 * that shares the first eight hex digits, and would mute the successor hint and the
 * status line.
 */
export declare function sameOwnerSession(a: unknown, b: unknown): boolean;
/**
 * Is a FOREIGN session writing for this participant address? Returns the journal session
 * the address is bound to, or `null` — it is this session writing, or there is nothing
 * to check against.
 *
 * The gate is needed because a harness background session is given an environment that is
 * not the one it was started with: measurement 2026-09-03 on `claude` 2.1.251 — the
 * `PROMPTOBUS_*` triple reaches the session from the process that started the daemon, that
 * is from the FIRST spawn of the run. This task took the hook identity into the arguments
 * of its command, and the gate remains a second line: it holds both what is called by
 * hand and a participant started by a former release.
 *
 * The check rule itself lives in the core (`foreignSessionOf`), one home for every gate
 * door. What remains here is what the core must not know: reading the workspace journal,
 * and that ownership of the `orchestrator` address is not the concern of this gate — that
 * has its own (`ownership` above); no driver started that session.
 */
export declare function foreignSession(home: string, id: string, addr: string, session: string | null): string | null;
/** The address a caller sends as in task `id`: the record this session PROVABLY holds; a declared
 * role picks among held records anywhere and binds only on its declared task — 04-protocol § Addresses. */
export declare function senderFor(home: string, id: string, { session, why, hint, declaredTask }?: Partial<SenderCaller>): string;
/** Where a contact point handed over at an address is written: the primary address's own point. */
export declare function wakeAddressOf(home: string, id: string, addr: string): import("../dist/index.js").MailboxSlot;
/** The warden's view of each record of task `id`: the slots its mailbox reads, and whether it is an
 * alias. Built once per call, every journal parsed once; a record added since is viewed on demand. */
export declare function participantSlots(home: string, id: string): (p: ParticipantV1) => {
    alias: boolean;
    slots: {
        task: string;
        participant: string;
    }[];
};
/** The address a mailbox call reads in task `id`: the record this session provably holds there, the
 * declared role when it holds that one too or none at all — ADR-028 § The journal, the mailbox reads. */
export declare function mailboxAddress(home: string, id: string, role: string, session: string | null): string | null;
/** Whom a participant may write: per participant reached, its addresses with the types the routing
 * policy allows and their tasks. `seats` state a lift's tasks and records before they are written. */
export declare function contactsOf(home: string, id: string, addr: string, { registry, seats }?: {
    registry?: RoleRegistry;
    seats?: {
        meta: ContactTask;
        sender: ParticipantV1 | null;
    }[] | null;
}): ContactRoute[][];
/** One contact as `<address> (<types>) in task <id>`, its routes joined by "or". */
export declare function contactText(routes: readonly ContactRoute[]): string;
/** Whom the address may write, on one line, or `null` when it is no participant of the task. */
export declare function contactsLine(home: string, id: string, addr: string, registry?: RoleRegistry): string | null;
export declare function claimOwnership(home: string, id: string, owner: string): string | null;
export declare function bindSession(home: string, id: string, session?: string | null): import("../dist/sidecar.js").Binding | null;
export declare function liveBinding(home: string, session?: string | null): import("../dist/sidecar.js").Binding | null;
export declare function boundTaskId(home: string, session?: string | null): string | null;
export declare function bindIfOwner(home: string, id: string, session?: string | null): import("../dist/sidecar.js").Binding | null;
export declare function sweepBindings(home: string): number;
/** The name a sent file lands under, at number `n`; leading dots are dropped.
 * [reference/04-protocol.md#artifacts](../docs/reference/04-protocol.md#artifacts) */
export declare function landedName(source: string, n?: number): string;
/**
 * The numbering of the task files folder — one home for it. The first file of a stem
 * carries no number, every next one takes the following: `review-store.diff`,
 * `review-store-2.diff`. Both kinds of file live by it — an artifact that arrived
 * through the bus (`placeFile`) and one the mechanism put there itself
 * (`occupyTaskFile`), and both the write and the PREDICTION of a name are spelled here.
 */
export declare function numberedName(stem: string, ext: string, n: number): string;
export declare function withMessageReadHook<T>(hook: ((read: MessageRead) => void) | null, work: () => T): T;
export declare function taskMessageHeaders(home: string, id: string, options?: HeaderOptions): MessageHeader[];
export declare function strictTaskFacts(home: string, id: string, options?: HeaderOptions): {
    task: TaskV1;
    messages: MessageHeader[];
};
export declare function currentResult<T extends MessageHeader>(participant: ParticipantV1 | null | undefined, messages: readonly T[]): T | null;
export declare function historyHeaders(home: string, id: string, addr: string): MessageHeader[];
export declare function journalMessageBody(home: string, id: string, messageId: string, purpose: string): string;
/** Files one address attached to the task, in send order, and the records that could not be read.
 * [reference/04-protocol.md#artifacts](../docs/reference/04-protocol.md#artifacts) */
export declare function attachmentsOf(home: string, id: string, participantId: string): {
    files: {
        filename: string | undefined;
        at: string;
    }[];
    broken: (string | null)[];
};
declare function outboundMessages(home: string, id: string, senderId: string, sinceMs?: number): MessageHeader[];
export { outboundMessages };
/**
 * A file the MECHANISM writes into the task files folder: the `review` diff and the
 * `spawn` brief. The name is occupied by the write itself — between a check for a free
 * name and the write a second command with the same stem would slip in, and an already
 * placed file must not be overwritten: the reviewer may still be reading the previous
 * diff, and the previous brief is the history of assignments of that address. The `wx`
 * flag refuses on an existing file — a signal to take the next number. Returns the path
 * that LANDED on disk.
 */
export declare function occupyTaskFile(dir: string, stem: string, ext: string, content: string | Buffer): string;
/**
 * Send a message. Sender and recipient are ADDRESSES: that is how bus tools and a human
 * talk, and the participant id stays inside the store. Returns the v1 outcome: the canon
 * and the artifact metadata, if there was one.
 */
export declare function sendMessage(home: string, id: string, { from, to, type, body, artifactPath, session, }: OutgoingMessage, hints: SendHints): SentMessage;
/** Fetch incoming mail: what was read moves to history, in the slot it was read from. */
export declare function readInbox(home: string, id: string, addr: string): {
    messages: MessageV1[];
    broken: string[];
};
/** Read without fetching: needed by a foreign session — `mailbox` gives them a copy. */
export declare function peekInbox(home: string, id: string, addr: string): {
    messages: MessageV1[];
    broken: string[];
};
/**
 * Glance into the mailbox without touching anything in it — needed by the warden.
 * Difference from `peekInbox`: that one sets unreadable mail aside in `broken/` and names
 * it out loud, while warden diagnostics go to `stdio: 'ignore'` — set-aside mail would
 * vanish without a word to anyone.
 */
export declare function glanceInbox(home: string, id: string, addr: string): MessageV1[];
export declare function countInbox(home: string, id: string, addr: string): number;
/** Unread of the whole participant mailbox the address belongs to. */
export declare function countMailbox(home: string, id: string, addr: string): number;
export declare function lastSentAt(home: string, id: string, addr: string): number | null;
export declare function unreadNote(home: string, id: string, addr: string, session?: string | null): string | null;
/**
 * Task history: a page of entries from old to new, last 50 by default.
 *
 * The unit is an ENTRY, not a message: one message sitting with two participants gives
 * two entries. There is no unread here at all — it lives in the mailbox, and reading
 * history does not touch it.
 */
export declare function history(home: string, query?: HistoryQuery): import("../dist/index.js").HistoryPage;
export declare function nameOfArtifact(home: string, task: string, id: string): string | undefined;
export declare const busService: {
    artifactsDir: typeof filesDir;
    artifactName: typeof nameOfArtifact;
    bindSession: typeof bindSession;
    brokenNote: typeof brokenNote;
    claimOwnership: typeof claimOwnership;
    countInbox: typeof countInbox;
    contactsLine: typeof contactsLine;
    countMailbox: typeof countMailbox;
    identityLabel: typeof identityLabel;
    mailboxAddress: typeof mailboxAddress;
    mailboxOf: typeof mailboxOf;
    noIdentityMailboxLine: typeof noIdentityMailboxLine;
    ownership: typeof ownership;
    peekInbox: typeof peekInbox;
    readInbox: typeof readInbox;
    readTask: typeof readTask;
    listTasks: typeof listTasks;
    resolveTaskId: typeof resolveTaskId;
    send: typeof sendMessage;
    senderFor: typeof senderFor;
    unreadNote: typeof unreadNote;
    withTaskCache: typeof withTaskCache;
};
export { writeJsonAtomic };
export declare function canonicalPath(value: string): string;
export declare function sameStoreHome(left: unknown, right: unknown): boolean;
export declare function resolveIdentity(env?: NodeJS.ProcessEnv, cwd?: string, { declared: said, host }?: {
    declared?: DeclaredIdentity | null;
    host?: PromptobusHost;
}): {
    role: string;
    hint: string | null;
    home: string;
    declaredTask: string | null;
    session: string | null;
    why: string | null;
};

// Engine protocol v1: the only door into store v1.
//
// The caller supplies the root, and the routing policy too, and both are
// required at OPEN. The policy is here, not on the first send: an engine
// without a "who may write to whom" rule is a bus whose rule will appear
// someday, and until then everything goes through.
//
// The engine is wired to the CLI through the mechanism door (the consumer
// adapter): that opens it with the workspace root and the consumer routing
// policy, and hands the models to consumers as they are.
import { linkSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  blobStats, listArtifacts, nameOf, newArtifact, orphanBlobs, readArtifact, readBlob, stashBlob,
  stashBlobSync, writeArtifact,
} from './artifacts.js';
import type { ArtifactSource } from './artifacts.js';
import { fail } from './errors.js';
import {
  blobFile, brokenInboxDir, historyDir, homeOf, inboxDir, taskDir, taskFile,
} from './layout.js';
import {
  commitIntent, completeFanout, countInbox, eventFor, glanceInbox, history as historyOf,
  lastSentAt as lastSentAtOf, newMessage, newRecordId, peekInbox, readInbox, recoverTask,
} from './messages.js';
import type {
  ActivationEvent, BrokenNote, FaultHook, HistoryPage, HistoryQuery, Repair,
} from './messages.js';
import { MESSAGE_TYPES_V1 } from './model.js';
import type { ArtifactV1, MessageV1, ParticipantV1, TaskV1 } from './model.js';
import {
  addParticipant, claimOwner, closeTask, createTask, listTasks, patchParticipant, putParticipant,
  readTask, requireActive, requireParticipant, taskExists, withTaskLock, writeTask,
} from './store.js';
import type { BrokenTask, Clock, NewTask, ParticipantPatch } from './store.js';
import { requireValid } from './validate.js';

/** Routing-policy decision: allow, or refuse with a reason. */
export type RoutingDecision = { allow: true } | { deny: true; reason: string };

/**
 * Routing policy — the "who may write to whom" rule. The consumer sets it: for
 * the CLI that is the "worker → worker" ban; another adapter will have its
 * own. Roles are taken from participant RECORDS: role is never derived from
 * the id anywhere.
 */
export type RoutingPolicy = (sender: ParticipantV1, recipient: ParticipantV1, task: TaskV1) => RoutingDecision;

/** What is passed to the engine at open. */
export interface EngineOptions {
  /**
   * Workspace root. The store lives at `<root>/.promptobus`; the package does
   * not search for the root itself. Exactly one of `root` or `home` is set.
   */
  root?: string;
  /**
   * The store directory whole. Needed by an adapter whose path arrives as an
   * environment variable and may not end in `.promptobus` at all: the adapter
   * names the directory, not the workspace, and gluing a root name on a second
   * time would walk the store past the directory a person named.
   */
  home?: string;
  policy: RoutingPolicy;
  /** Clock: the suite substitutes its own so stamps are predictable. */
  now?: Clock;
  /** Fault-injection seam. Not supplied in production. */
  faults?: FaultHook;
  /** Whether to recover fan-out at open. Turned off only by the suite. */
  recover?: boolean;
  /**
   * Version of the mechanism that reads journals through this engine. The
   * package has none of its own — the opener names it, like `home` and
   * `policy`. Unnamed — a mix of versions is not distinguished: a record with
   * unfamiliar fields stays corruption.
   */
  cli?: string | null;
}

/** What is sent on the bus. The artifact is laid down HERE — otherwise the policy does not watch it. */
export interface SendInput {
  from: string;
  to: string[];
  type: string;
  body: string;
  artifact?: ArtifactSource;
}

/**
 * The same, synchronously. The artifact source here is a file only, and the
 * adapter names it — the callback is called AFTER the blob is on disk and
 * receives its digest: the adapter lays its human names next to it, and name
 * dedup without a digest is impossible.
 */
export interface SendSyncInput {
  from: string;
  to: string[];
  type: string;
  body: string;
  artifact?: { path: string; name?: (sha256: string, size: number) => string };
}

/** Send outcome: the canon, artifact metadata, and "who to wake" events. */
export interface SendResult {
  message: MessageV1;
  artifact: ArtifactV1 | null;
  events: ActivationEvent[];
}

/** Recovery outcome: what was repaired and who must be woken for it. */
export interface RecoverResult {
  repairs: Repair[];
  events: ActivationEvent[];
  broken: BrokenNote[];
}

/** What `prune` took. */
export interface PruneResult {
  task: string;
  blobs: number;
  bytes: number;
}

const NO_FAULT: FaultHook = () => {};

/** Engine v1. Every operation goes through it: the package does not hand raw paths out. */
export interface Engine {
  /** Store directory: `<root>/.promptobus`. */
  readonly home: string;
  createTask(input: NewTask): TaskV1;
  readTask(task: string): TaskV1;
  listTasks(): { tasks: TaskV1[]; broken: BrokenTask[] };
  taskExists(task: string): boolean;
  /**
   * Close the task. `adapter` — adapter fields laid down in THE SAME pass: the
   * adapter writes the close mark, and a second lock for one field would cost
   * a task closed without it.
   */
  closeTask(task: string, patch?: { adapter?: Record<string, unknown> }): TaskV1;
  /**
   * Patch the task journal: title and adapter fields. `adapter` fields are
   * MERGED, not replaced: the object is opaque, and a whole replace would take
   * neighbouring fields written in the meantime.
   */
  patchTask(task: string, patch: { title?: string; adapter?: Record<string, unknown> }): TaskV1;
  addParticipant(task: string, participant: ParticipantV1): ParticipantV1;
  /** Put a participant record whole, replacing the former one: that is how lift writes. */
  putParticipant(task: string, participant: ParticipantV1): TaskV1;
  patchParticipant(task: string, id: string, patch: ParticipantPatch): ParticipantV1;
  /**
   * Four paths the adapter needs by name, not by operation: diagnostics name
   * the journal file to a person as "journal does not read"; the bus listener
   * (`fs.watch`) watches the mailbox; and a live run shows a person what was
   * read and what was set aside — that is how they tell where a message went.
   * The rest of the store layout does not go out.
   */
  taskFile(task: string): string;
  inboxPath(task: string, participant: string): string;
  historyPath(task: string, participant: string): string;
  brokenPath(task: string, participant: string): string;
  claimOwner(task: string, id: string): string;
  send(task: string, input: SendInput): Promise<SendResult>;
  sendSync(task: string, input: SendSyncInput): SendResult;
  read(task: string, participant: string): { messages: MessageV1[]; broken: BrokenNote[] };
  /** Read without taking: refs stay in the inbox. Broken ones are set aside the same way. */
  peek(task: string, participant: string): { messages: MessageV1[]; broken: BrokenNote[] };
  /** Glance in silence: touches no refs and sets no broken aside. */
  glance(task: string, participant: string): MessageV1[];
  unread(task: string, participant: string): number;
  /** When the participant last sent; `null` — they have sent nothing yet. */
  lastSentAt(task: string, participant: string): number | null;
  /**
   * Hard link to a blob under a name the adapter chose. `false` — the name is
   * taken, and picking the next one is the caller's job: the payload is
   * deduplicated, and a second link to the same inode costs no extra byte.
   * The blob path itself does not go out.
   */
  linkBlob(task: string, sha256: string, target: string): boolean;
  history(query?: HistoryQuery): HistoryPage;
  recover(task?: string): RecoverResult;
  readArtifact(task: string, id: string): ArtifactV1;
  readArtifactContent(task: string, id: string): Buffer;
  listArtifacts(task: string): { artifacts: ArtifactV1[]; broken: string[] };
  orphanBlobs(task: string): string[];
  prune(task: string): PruneResult;
}

/**
 * Open the engine. Without a routing policy — a refusal HERE, not on the
 * first send: a bus whose rule will appear later lets everything through
 * until then.
 */
export function openEngine({
  root, home: at, policy, now = () => new Date(), faults = NO_FAULT, recover = true, cli = null,
}: EngineOptions): Engine {
  if (typeof policy !== 'function') {
    fail('policy-required', 'routing policy is required: an engine without a who-may-write-to-whom rule does not open');
  }
  if ((root === undefined) === (at === undefined)) {
    fail('schema-invalid', 'the engine opens on exactly one of: the workspace root, or the store home itself');
  }
  const home = at ?? homeOf(root as string);

  function decide(sender: ParticipantV1, recipient: ParticipantV1, meta: TaskV1): void {
    const decision = policy(sender, recipient, meta);
    if (decision && (decision as { allow?: unknown }).allow === true) return;
    // Not a decision at all is also a refusal: a policy that returned garbage
    // must not be read as permission. A silent pass here would cost exactly
    // what the policy is required for.
    const reason = decision && typeof (decision as { reason?: unknown }).reason === 'string'
      ? (decision as { reason: string }).reason
      : 'policy returned no decision';
    fail('policy-denied', `${sender.id} → ${recipient.id}: ${reason}`,
      { task: meta.id, sender: sender.id, recipient: recipient.id, reason });
  }

  /** Step 1: everything checked BEFORE the first side effect. One for both send branches. */
  function prepare(task: string, input: { from: string; to: string[]; type: string; body: string }): {
    meta: TaskV1; sender: ParticipantV1; recipients: ParticipantV1[];
  } {
    const meta = requireActive(readTask(home, task, cli));
    const sender = requireParticipant(meta, input.from);
    if (!Array.isArray(input.to) || !input.to.length) {
      fail('recipients-empty', 'recipient list is empty', { task });
    }
    if (new Set(input.to).size !== input.to.length) {
      fail('recipients-duplicate', `duplicate recipients: ${input.to.join(', ')}`, { task, to: input.to });
    }
    const recipients = input.to.map((id) => requireParticipant(meta, id));
    if (typeof input.type !== 'string' || !MESSAGE_TYPES_V1.includes(input.type)) {
      fail('message-type-unknown', `type «${String(input.type)}» is not a v1 protocol type: ${MESSAGE_TYPES_V1.join(', ')}`,
        { task, type: input.type });
    }
    if (typeof input.body !== 'string' || !input.body) {
      fail('schema-invalid', 'body is empty — a message with no text is not sent', { task });
    }
    for (const recipient of recipients) decide(sender, recipient, meta);
    faults('validate', { task, message: null });
    return { meta, sender, recipients };
  }

  /** Steps 2–5: the commit point, fan-out, and "who to wake" events. Also one for both send branches. */
  function finish(task: string, meta: TaskV1, sender: ParticipantV1, recipients: ParticipantV1[],
    input: { to: string[]; type: string; body: string }, artifact: ArtifactV1 | null): SendResult {
    const draft = newMessage(task, sender.id, input.to, input.type, input.body, artifact?.id ?? null, now());
    requireValid('message', draft, { task });
    const message = commitIntent(home, task, draft, now());
    faults('intent', { task, message: message.id });
    completeFanout(home, task, message, faults);
    // Activation is NOT here: the engine returns a "who to wake" list, and
    // the supervisor wakes them through the participant's driver — independently
    // per recipient, after the fan-out is on disk.
    return { message, artifact, events: recipients.map((r) => eventFor(home, task, r, [message])) };
  }

  const engine: Engine = {
    home,

    createTask: (input) => createTask(home, input, now),
    readTask: (task) => readTask(home, task, cli),
    listTasks: () => listTasks(home, cli),
    taskExists: (task) => taskExists(home, task),
    closeTask: (task, patch = {}) => closeTask(home, task, now, patch.adapter, cli),
    patchTask: (task, patch) => withTaskLock(home, task, () => {
      const meta = readTask(home, task, cli);
      return writeTask(home, {
        ...meta,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.adapter === undefined ? {} : { adapter: { ...meta.adapter, ...patch.adapter } }),
      }, now);
    }),
    addParticipant: (task, participant) => addParticipant(home, task, participant, now, cli),
    putParticipant: (task, participant) => putParticipant(home, task, participant, now, cli),
    taskFile: (task) => taskFile(home, task),
    inboxPath: (task, participant) => inboxDir(home, task, participant),
    historyPath: (task, participant) => historyDir(home, task, participant),
    brokenPath: (task, participant) => brokenInboxDir(home, task, participant),
    patchParticipant: (task, id, patch) => patchParticipant(home, task, id, patch, now, cli),
    claimOwner: (task, id) => claimOwner(home, task, id, now, cli),

    async send(task, input) {
      const { sender, recipients, meta } = prepare(task, input);

      // --- artifact: after policy, before the message -----------------------------------
      // The order is required: a policy refusal must not leave a blob in the
      // task. The digest is computed as a stream, on the write pass — the
      // source may be a stream, and it has no second read at all.
      let artifact: ArtifactV1 | null = null;
      if (input.artifact) {
        // The name is computed BEFORE the blob is written: a bad one, caught
        // by the schema only after, would leave payload in the task with no
        // metadata — an orphan blob until `prune`.
        const filename = nameOf(input.artifact);
        const { sha256, size } = await stashBlob(home, task, input.artifact);
        faults('blob', { task, sha256 });
        artifact = writeArtifact(home, task, newArtifact(newRecordId(now()), sha256, filename, size));
        faults('artifact', { task, artifact: artifact.id });
      }
      return finish(task, meta, sender, recipients, input, artifact);
    },

    sendSync(task, input) {
      const { sender, recipients, meta } = prepare(task, input);
      let artifact: ArtifactV1 | null = null;
      if (input.artifact) {
        const source = input.artifact;
        // The source name is checked BEFORE the blob is written — the same as
        // the streaming branch: a bad one, caught only after, would leave
        // payload in the task with no metadata, an orphan blob on a flat path.
        nameOf({ path: source.path });
        const { sha256, size } = stashBlobSync(home, task, source.path);
        faults('blob', { task, sha256 });
        // The name a person will see the record under is given by the adapter
        // and AFTER the blob: name dedup without a digest is impossible. It
        // is checked by the same `nameOf`.
        const filename = nameOf({ path: source.path, filename: source.name?.(sha256, size) });
        artifact = writeArtifact(home, task, newArtifact(newRecordId(now()), sha256, filename, size));
        faults('artifact', { task, artifact: artifact.id });
      }
      return finish(task, meta, sender, recipients, input, artifact);
    },

    read(task, participant) {
      // Reading a closed task is lawful: `requireActive` has nothing to do
      // here — the correspondence stays a journal after close.
      requireParticipant(readTask(home, task, cli), participant);
      return readInbox(home, task, participant, faults);
    },

    peek: (task, participant) => peekInbox(home, task, participant),
    glance: (task, participant) => glanceInbox(home, task, participant),

    unread: (task, participant) => countInbox(home, task, participant),

    lastSentAt: (task, participant) => lastSentAtOf(home, task, participant),

    linkBlob(task, sha256, target) {
      mkdirSync(path.dirname(target), { recursive: true });
      try {
        linkSync(blobFile(home, task, sha256), target);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
      }
    },

    history(query = {}) {
      const tasks = query.task ? [query.task] : listTasks(home, cli).tasks.map((t) => t.id);
      return historyOf(home, tasks, query);
    },

    recover(task) {
      const metas = task ? [readTask(home, task, cli)] : listTasks(home, cli).tasks;
      const out: RecoverResult = { repairs: [], events: [], broken: [] };
      for (const meta of metas) {
        const one = recoverTask(home, meta.id, meta, faults);
        out.repairs.push(...one.repairs);
        out.events.push(...one.events);
        out.broken.push(...one.broken);
      }
      return out;
    },

    readArtifact: (task, id) => readArtifact(home, task, id),
    readArtifactContent: (task, id) => readBlob(home, task, readArtifact(home, task, id)),
    listArtifacts: (task) => listArtifacts(home, task),
    orphanBlobs: (task) => orphanBlobs(home, task),

    /**
     * Wipe the task whole, blobs included. A blob is deduplicated inside the
     * task, and it is "nobody's" only until the next send of the same
     * payload — so blobs are never removed one by one, they leave with the task.
     */
    prune(task) {
      const meta = readTask(home, task, cli);
      if (meta.status === 'active') {
        fail('task-active', `task ${task} is active — prune wipes its correspondence and blobs whole`,
          { task, status: meta.status });
      }
      const { count, bytes } = blobStats(home, task);
      rmSync(taskDir(home, task), { recursive: true, force: true });
      return { task, blobs: count, bytes };
    },
  };

  if (recover) engine.recover();
  return engine;
}

import type { ArtifactSource } from './artifacts.js';
import type { ActivationEvent, BrokenNote, FaultHook, HistoryPage, HistoryQuery, RecoverFailure, Repair } from './messages.js';
import type { ArtifactV1, MessageV1, ParticipantV1, TaskV1 } from './model.js';
import type { BrokenTask, Clock, NewTask, ParticipantPatch, TaskLinkFailure, TaskLinkRepair } from './store.js';
/** Routing-policy decision: allow, or refuse with a reason. */
export type RoutingDecision = {
    allow: true;
} | {
    deny: true;
    reason: string;
};
/**
 * Routing policy — the "who may write to whom" rule. The consumer sets it: for
 * the CLI that is the "worker → worker" ban; another adapter will have its
 * own. Roles are taken from participant RECORDS: role is never derived from
 * the id anywhere.
 */
export type RoutingPolicy = (sender: ParticipantV1, recipient: ParticipantV1, task: TaskV1, type: string) => RoutingDecision;
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
    /** Whether to recover fan-out at open. A consumer may recover explicitly to report the result. */
    recover?: boolean;
    /** Reader/Host version for journal diagnostics, independent of the package version.
     * Null leaves unfamiliar fields classified as corruption. */
    cli?: string | null;
}
/** What is sent on the bus. The artifact is laid down HERE — otherwise the policy does not watch it. */
export interface SendInput {
    from: string;
    to: string[];
    type: string;
    body: string;
    originTask?: string;
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
    originTask?: string;
    artifact?: {
        path: string;
        name?: (sha256: string, size: number) => string;
    };
    /** Metadata id of a prior artifact message; sets `message.artifact` without a new attachment. */
    linkArtifact?: string;
}
/** Send outcome: the canon, artifact metadata, and "who to wake" events. */
export interface SendResult {
    message: MessageV1;
    artifact: ArtifactV1 | null;
    events: ActivationEvent[];
}
/** Recovery outcome: completed work, wake events, unreadable records, and fan-out failures. */
export interface RecoverResult {
    repairs: Repair[];
    links: TaskLinkRepair[];
    linkFailures: TaskLinkFailure[];
    events: ActivationEvent[];
    broken: BrokenNote[];
    failed: RecoverFailure[];
}
/** What `prune` took. */
export interface PruneResult {
    task: string;
    blobs: number;
    bytes: number;
}
/** Engine v1. Every operation goes through it: the package does not hand raw paths out. */
export interface Engine {
    /** Store directory: `<root>/.promptobus`. */
    readonly home: string;
    createTask(input: NewTask): TaskV1;
    readTask(task: string): TaskV1;
    listTasks(): {
        tasks: TaskV1[];
        broken: BrokenTask[];
    };
    taskExists(task: string): boolean;
    rebuildMessageOrder(): {
        head: string | null;
        messages: number;
        intents: number;
        fences: number;
    };
    facts(task: string): {
        task: TaskV1;
        messages: MessageV1[];
    };
    assignParticipant(task: string, participant: ParticipantV1): TaskV1;
    inboxIdentity(task: string, participant: string): {
        ids: string[];
        complete: boolean;
    };
    /**
     * Close the task. `adapter` — adapter fields laid down in THE SAME pass: the
     * adapter writes the close mark, and a second lock for one field would cost
     * a task closed without it.
     */
    closeTask(task: string, patch?: {
        adapter?: Record<string, unknown>;
    }): TaskV1;
    /**
     * Patch the task journal: title and adapter fields. `adapter` fields are
     * MERGED, not replaced: the object is opaque, and a whole replace would take
     * neighbouring fields written in the meantime.
     */
    patchTask(task: string, patch: {
        title?: string;
        adapter?: Record<string, unknown>;
    }): TaskV1;
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
    read(task: string, participant: string): {
        messages: MessageV1[];
        broken: BrokenNote[];
    };
    /** Read without taking: refs stay in the inbox. Broken ones are set aside the same way. */
    peek(task: string, participant: string): {
        messages: MessageV1[];
        broken: BrokenNote[];
    };
    /** Glance in silence: touches no refs and sets no broken aside. */
    glance(task: string, participant: string): MessageV1[];
    /** Validate without consuming or isolating refs; diagnostics remain visible on retry. */
    inspectInbox(task: string, participant: string): {
        messages: MessageV1[];
        broken: BrokenNote[];
    };
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
    listArtifacts(task: string): {
        artifacts: ArtifactV1[];
        broken: string[];
    };
    orphanBlobs(task: string): string[];
    prune(task: string): PruneResult;
}
/**
 * Open the engine. Without a routing policy — a refusal HERE, not on the
 * first send: a bus whose rule will appear later lets everything through
 * until then.
 */
export declare function openEngine({ root, home: at, policy, now, faults, recover, cli, }: EngineOptions): Engine;

import type { NotificationMessage } from '../driver.js';
import { messagesDir } from './layout.js';
import type { MessageV1, ParticipantV1, TaskV1 } from './model.js';
/** Durable steps the suite can crash after. `mkdir` fires before the directory is created. */
export type FanoutStep = 'validate' | 'blob' | 'artifact' | 'intent' | 'canonical' | 'mkdir' | 'ref' | 'close' | 'read' | 'task-read' | 'artifact-read' | 'intent-read' | 'intent-materialize' | 'inbox-read' | 'history-ref' | 'task-link' | 'task-link-publish' | 'order-reserved';
/** Fault seam. Durable steps fire after the write; reads and `mkdir` fire immediately before
 * their filesystem call. Not supplied in production. */
export type FaultHook = (step: FanoutStep, info: Record<string, unknown>) => void;
/** "Who to wake" event. The shape is the one the driver `activate` accepts. */
export interface ActivationEvent {
    kind: 'unread';
    task: string;
    /** Participant ID. In v1 it is also the delivery address: role is not derived from it. */
    address: string;
    /** Opaque session reference of the participant — the first argument of `activate`. */
    ref: string | null;
    unread: number;
    messages: NotificationMessage[];
}
/** Message excerpt for a notification: the driver assembles the text, the frame belongs to the channel. */
export declare function previewOf(m: MessageV1): NotificationMessage;
/** Independent draft/artifact name. Message commit replaces it with a durable logical ID. */
export declare function newRecordId(now: Date): string;
/** Threshold after which an unclosed intent is treated as abandoned.
 * [reference/04-protocol.md#intent_stale_ms--threshold-after-which-an-unclosed-intent-is-treated-as-abandoned-regardless](../../docs/reference/04-protocol.md#intent_stale_ms--threshold-after-which-an-unclosed-intent-is-treated-as-abandoned-regardless) */
export declare const INTENT_STALE_MS = 30000;
/** Steps 3–5 in one pass: the canon, refs for recipients, drop the intent. Called by both send and
 * recovery — exactly one code, or recovery would repair something other than what broke. */
export declare function completeFanout(home: string, task: string, message: MessageV1, fault?: FaultHook): string[];
/** How much unread sits with the participant. */
export declare function countInbox(home: string, task: string, participant: string): number;
export declare function inboxIdentity(home: string, task: string, participant: string): {
    ids: string[];
    complete: boolean;
};
/** Assemble the activation event for a participant: what sits with them and how to wake them. */
export declare function eventFor(home: string, task: string, participant: ParticipantV1, messages: MessageV1[]): ActivationEvent;
/** Assemble a canonical message. Validation is on the caller's side, before the first write. */
export declare function newMessage(task: string, sender: string, recipients: string[], type: string, body: string, artifact: string | null, now: Date, originTask?: string): MessageV1;
/** Reserve store order under the message-commit lock, then publish the intent. */
export declare function commitIntent(home: string, task: string, message: MessageV1, now: Date, fault?: FaultHook): MessageV1;
/** What was found unreadable while reading the mailbox. Reason and place are separate fields, not
 * glued: a glue would force the adapter to cut it back with a regex, and the channels would drift. */
export interface BrokenNote {
    name: string;
    /** Protocol validation code, or filesystem errno when the record stays for retry. */
    code: string;
    /** Why the record did not read. */
    note: string;
    /** Directory the record was set aside in; `null` — it stayed in place. */
    attic: string | null;
    /** Why setting it aside failed; `null` — it succeeded, or it was not tried. */
    failure: string | null;
}
/** Take incoming and move the refs to history. No processing ack and no exactly-once: the mailbox
 * keeps a message until read, and that is all. Order is by file name, which is send order. */
export declare function readInbox(home: string, task: string, participant: string, fault?: FaultHook): {
    messages: MessageV1[];
    broken: BrokenNote[];
};
export declare function ensureHistoryDir(home: string, task: string, participant: string): void;
/** History query. `all` lifts the limit whole; `before` — a cursor for paged reading. */
export interface HistoryQuery {
    task?: string;
    participant?: string;
    limit?: number;
    /** Cursor of the previous page: an opaque string `cursor` returned. It should not be assembled by
     * hand — the order-key form belongs to history. */
    before?: string;
    all?: boolean;
    /** Refuse unreadable directories when the caller requires complete history. */
    strict?: boolean;
}
/** History record: one message for one participant. */
export interface HistoryEntry {
    task: string;
    participant: string;
    message: MessageV1;
}
/** History response: a page from old to new, and a cursor to the older page. */
export interface HistoryPage {
    entries: HistoryEntry[];
    /** What to pass as `before` for the next (older) page; `null` — there is nothing older. */
    cursor: string | null;
    broken: BrokenNote[];
}
/** Task history: what was read, old to new, last 50 records by default. Unread is not here — it sits
 * in the mailbox, and fan-out recovery stands on telling delivered from read. */
export declare function history(home: string, tasks: string[], { participant, limit, before, all, strict }: HistoryQuery): HistoryPage;
/** What recovery repaired in one task. */
export interface Repair {
    task: string;
    message: string;
    /** Who the refs were written for. Empty — the intent was simply not dropped. */
    recipients: string[];
    /** Whether the canon had to be linked again. */
    canonical: boolean;
}
/** A classified fan-out failure: unfinished for retry, or permanently lost. */
export interface RecoverFailure {
    task: string;
    message: string;
    code: 'link-refused' | 'intent-lost' | 'dir-blocked' | 'dir-occupied';
    note: string;
}
/** Recover fan-out of one task: walk unclosed intents and write what is missing. Idempotent by
 * construction; a classified refusal for one message does not stop recovery of its neighbours. */
export declare function recoverTask(home: string, task: string, meta: TaskV1, fault?: FaultHook): {
    repairs: Repair[];
    events: ActivationEvent[];
    broken: BrokenNote[];
    failed: RecoverFailure[];
};
export { messagesDir };
/** Look into the mailbox without touching anything: refs stay and do not go to history. Broken ones
 * are still set aside, or one unreadable record would return to the reader on every visit. */
export declare function peekInbox(home: string, task: string, participant: string, fault?: FaultHook): {
    messages: MessageV1[];
    broken: BrokenNote[];
};
/** Validate unread records without consuming or isolating their refs. */
export declare function inspectInbox(home: string, task: string, participant: string, fault?: FaultHook): {
    messages: MessageV1[];
    broken: BrokenNote[];
};
/** Glance without consuming: no refs moved. A refusal or a record that does not parse is named
 * in `broken` and left in place — setting it aside would vanish into ignored supervisor diagnostics. */
export declare function glanceInbox(home: string, task: string, participant: string, fault?: FaultHook): {
    messages: MessageV1[];
    broken: BrokenNote[];
};
export declare function lastSentAt(home: string, task: string, participant: string): number | null;

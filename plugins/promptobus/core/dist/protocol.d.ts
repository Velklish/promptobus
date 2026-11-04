import { ORCHESTRATOR } from './registry.js';
export declare const MESSAGE_TYPES: readonly string[];
export { ORCHESTRATOR };
/** Harness of a record that neither the journal nor the adapter named. Deliberately neutral: harness
 * names live with the drivers, and this is the admission that the field was never declared. */
export declare const UNDECLARED_HARNESS = "undeclared";
/** Role of a record whose address does not parse: a hand edit, a journal after a crash. */
export declare const UNDECLARED_ROLE = "undeclared";
export declare const TASK_ID_RE: RegExp;
export declare class GateError extends Error {
}
export declare function isAddress(addr: unknown): boolean;
export declare function addrDir(addr: unknown): string;
/** Address role as its own value. Store v1 keeps it as a field on the participant record and does
 * not derive it from the id: it is computed ONCE, when the participant is written. */
export declare function roleOf(addr: unknown): string;
export declare function workerAddress(slug: string): string;
export declare function reviewerAddress(slug: string): string;
export declare function approverAddress(slug: string): string;
export declare function requireTaskId(id: unknown): string;
export declare function tasksDir(home: string): string;
export declare function taskDir(home: string, id: string): string;
export declare function participantFileStem(address: string): string;
export declare const SLUG_MAX = 24;
export declare function slugify(text: unknown, max?: number): string;
export interface Clock {
    getUTCFullYear: () => number;
    getUTCMonth: () => number;
    getUTCDate: () => number;
    getUTCHours: () => number;
    getUTCMinutes: () => number;
    getUTCSeconds: () => number;
}
/** Identity of a new task: a readable slug in front, a machine stamp in the tail and in task.json. */
export declare function newTaskIdentity(slug?: string | null, now?: Clock): {
    id: string;
    slug: string | null;
    stamp: string;
};
export declare function stampOfId(id: unknown): string | null;
export declare const TASK_TITLE_SEP = " \u00B7 ";
export declare const FOREIGN_MARK = "FOREIGN MAILBOX";
export declare const MAILBOX_COPY = "A copy is below; the originals stayed in the mailbox.";
export declare const FOREIGN_ROUTE: string;
export declare const MAILBOX_CLAIMED_MARK = "MAILBOX CLAIMED";
export declare function claimRoute(repeat: string): string;
/** Participant record as these accessors see it. Structural — so the v1 model is not pulled in. */
interface WithMetadata {
    metadata?: Record<string, unknown> | null;
}
/** Participant address, in the grammar of `isAddress`. Not assembled from the id: `addrDir` is injective
 * only over addresses a registry admits, and a record with no field has no role to ask. */
export declare function addressOf(p: WithMetadata | null | undefined): string | null;
/** Name of the field where the mechanism leaves its version. It lives in `metadata` because that is
 * opaque to the schema: an own field would be "extra" to an older reader — the very breakage it prevents. */
export declare const MECHANISM_VERSION_FIELD = "mechanismVersion";
/** Version of the mechanism that wrote the participant record: the journal reader tells "newer than
 * me" from corruption by it — unfamiliar fields plus a newer version are a mix after `sync`. */
export declare function mechanismVersionOf(p: WithMetadata | null | undefined): string | null;
/** Name of the field a routed lift leaves its decision in. The adapter writes and `status` reads, so
 * the name has one home — the same rule and reason as `MECHANISM_VERSION_FIELD` above. */
export declare const ROUTING_FIELD = "routing";
/** Routing decision of a participant lifted with `--strategy`. An object, so it does not go through
 * `field`; it lives in `metadata` so any version can read the record and no protocol bump is needed. */
export declare function routingOf(p: WithMetadata | null | undefined): Record<string, unknown> | null;
/** When the adapter lifted the participant session: the fresh-lift registration window. */
export declare function startedOf(p: WithMetadata | null | undefined): string | null;
/** Participant working-copy directory — the path a person is given in a stall report. */
export declare function repoAbsOf(p: WithMetadata | null | undefined): string | null;
/** Whether the participant was dismissed from watch, and when: the adapter sets the mark (`promptobus dismiss`). */
export declare function dismissedOf(p: WithMetadata | null | undefined): string | null;
/** Short participant session id from the journal: the session is gone, the directory lives. It is how
 * the session is named at the harness, and lift parses it from the launch output. */
export declare function sessionOf(p: WithMetadata | null | undefined): string | null;
/** Full participant session identifier — the one the session calls ITSELF and arrives with when it
 * writes. Records with no field fall back to the prefix. */
export declare function sessionIdOf(p: WithMetadata | null | undefined): string | null;
/** Whether these are the same session identifier — a FALLBACK for records with no full id.
 * [reference/04-protocol.md#samesession--whether-these-are-the-same-session-identifier--a-fallback-rule-for-records](../docs/reference/04-protocol.md#samesession--whether-these-are-the-same-session-identifier--a-fallback-rule-for-records) */
export declare function sameSession(a: string | null | undefined, b: string | null | undefined): boolean;
/** Is a FOREIGN session writing for this address? One rule for every door of the gate, so no copy can
 * drift. Full id by EQUALITY first, the short prefix only when absent; both sides must be named. */
export declare function foreignSessionOf(p: WithMetadata | null | undefined, session: string | null | undefined): string | null;
/** The participant binding: owner for the orchestrator; harness id or session-record pointer
 * for every other address. `null` — an unbound record, legal to read and never sent as. */
export declare function boundSessionOf(p: WithMetadata | null | undefined): string | null;
/** Whether this session PROVABLY holds the record — a positive proof, where `foreignSessionOf` answers
 * `null` for a record bound to nobody. [reference/04-protocol.md#addresses](../docs/reference/04-protocol.md#addresses) */
export declare function holdsSession(p: WithMetadata | null | undefined, session: string | null | undefined): boolean;
/** Readable participant name, the one their session is shown under at the harness. */
export declare function nameOf(p: WithMetadata | null | undefined): string | null;
/** Session that owns the `orchestrator` mailbox. Ownership of the address, not the task. */
export declare function ownerOf(p: WithMetadata | null | undefined): string | null;
/** How the owner gate answered: what it proved, not what it failed to find. */
export type OwnershipRight = 'owner' | 'ownerless' | 'no-identity' | 'foreign' | 'other-address';
/** Mailbox ownership. `allowed` is the right, proven positively; `gated` is the narrower "proved
 * foreign" the advisory lines read, and the two are not each other's negation. */
export interface Ownership {
    gated: boolean;
    allowed: boolean;
    right: OwnershipRight;
    owner: string | null;
    session: string | null;
}
export declare function foreignTaskLine(meta: {
    id: string;
    title?: string;
}, own: Ownership): string;
export declare function brokenNote(broken: string[]): string | null;

import type { Stalls, Wake } from './sidecar.js';
import type { FaultHook } from './v1/messages.js';
import type { ParticipantV1 } from './v1/model.js';
import type { NamedReset, Registry, SessionSnapshot, SessionStall, StalledParticipant } from './driver.js';
export declare const TICK_MS = 1000;
export declare const KNOCK_RETRY_SEC = 120;
export declare const KNOCK_COALESCE_SEC = 90;
export declare const SILENCE_SEC = 900;
export declare const WARDEN_TOTAL_SEC: number;
export declare const WARDEN_ABSOLUTE_SEC: number;
export declare const ROUND_FAIL_LIMIT = 3;
export declare const SPAWN_GRACE_SEC = 30;
/** The slots one participant record's mailbox reads; `alias` — the record is an address alias that the
 * warden of its primary task knocks for (ADR-028). */
export interface ParticipantSlots {
    alias: boolean;
    slots: {
        task: string;
        participant: string;
    }[];
}
/** The adapter's answer per participant record of the task; without it each record is its own slot. */
export type MailboxesOf = (participant: ParticipantV1) => ParticipantSlots;
/** Which fallback put `channel` at `self-wake`; prognosis per state in [guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not](../docs/guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not) */
export type SelfWakeState = 'starting' | 'taken' | 'refused';
export declare function justSpawned(participant: ParticipantV1 | null | undefined, now?: number): boolean;
export declare function lastActivation(home: string, task: string, participant: ParticipantV1 | null | undefined): number | null;
/** The named reset that holds the address's knocks at `now`, or null: the harness refused the turn
 * and said when to retry. [03-cli.md § Guard and warden](../docs/reference/03-cli.md#guard-and-warden) */
export declare function heldReset(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot, now?: number): NamedReset | null;
/** Participant session state: `alive` | `dead` | `unknown`. An unparsed snapshot, a record with no
 * session reference, and a participant nobody can be asked about are unknown, not death. */
export declare function liveParticipant(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): 'alive' | 'dead' | 'unknown';
/** Whether this is a stall for real: a SILENT end of turn, and `permission` has a check
 * [guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not](../docs/guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not) */
export declare function stallStands(home: string, task: string, participant: ParticipantV1 | null | undefined, stall: SessionStall | null | undefined): boolean;
/** The address's contact point is held by a FOREIGN session, or null.
 * [guides/hooks-and-trust.md#waketakenby--the-addresss-contact-point-is-held-by-a-foreign-session--or-null-if](../docs/guides/hooks-and-trust.md#waketakenby--the-addresss-contact-point-is-held-by-a-foreign-session--or-null-if) */
export declare function wakeTakenBy(home: string, task: string, p: ParticipantV1 | null | undefined, endpoint?: Wake | null): string | null;
/** Whether the participant's session is busy with a turn.
 * [guides/hooks-and-trust.md#sessionbusy--whether-the-participants-session-is-busy-with-a-turn](../docs/guides/hooks-and-trust.md#sessionbusy--whether-the-participants-session-is-busy-with-a-turn) */
export declare function sessionBusy(home: string, task: string, participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): boolean;
/** Task participants from whom no messages are to be expected; `null` means the state is unknown,
 * which is not "everyone is alive". "Listed, but no process" is checked BEFORE the stall. */
export declare function blockedParticipants(home: string, task: string, participants: ParticipantV1[] | null | undefined, sessions: SessionSnapshot, mailboxes?: MailboxesOf | null): StalledParticipant[] | null;
/** What is new among the stalls, WITHOUT the mark — the caller sets it. `current === null` means
 * session state was not inspected, which is not "there are no stalls". */
export declare function pendingStalls(home: string, task: string, probe: (ps: ParticipantV1[] | undefined) => StalledParticipant[] | null, { now, retryMs, maxTries }?: {
    maxTries?: number | undefined;
    now?: number | undefined;
    retryMs?: number | undefined;
}): {
    fresh: StalledParticipant[];
    current: Stalls | null;
};
/** Mark what was reported. The state is already like this — do not touch the journal: a write would cost disk. */
export declare function commitStalls(home: string, task: string, current: Stalls | null): void;
/** Whom the warden still has reason to watch: only participants with a session reference, since a
 * person's session is observable from nowhere. Unknown is not taken as dead, nor is a fresh spawn. */
export declare function liveWatched(home: string, task: string, sessions: SessionSnapshot): string[];
/** Heartbeat: renew our mark and check three reasons to exit. Lifted out of the loop for the test —
 * checking a branch inside the loop would have cost the suite half an hour of waiting. */
export declare function beatRound(home: string, task: string, startedMs: number, { now, sessions, session, mailboxes, }?: {
    mailboxes?: MailboxesOf | null | undefined;
    now?: number | undefined;
    session?: string | null | undefined;
    sessions?: SessionSnapshot | undefined;
}): string | null;
/** One watch round: look at all mailboxes, wake those with unread, update health. `sessions` is the
 * snapshot from the last heartbeat — the round runs once a second and gets no poll of its own. */
export declare function supervisorRound(home: string, task: string, { now, registry, sessions, faults, mailboxes, }: {
    now?: number;
    registry: Registry;
    sessions?: SessionSnapshot;
    faults?: FaultHook;
    mailboxes?: MailboxesOf | null;
}): Promise<{
    stop: string | null;
    events: string[];
    knocked: string[];
}>;
/** Participant stall. Escalation is visibility — a status line and a journal entry, no postcard: a
 * separate notification burned orchestrator turns every round. The journal line is the adapter's. */
export declare function stallRound(home: string, task: string, { sessions, now, mailboxes, }?: {
    sessions?: SessionSnapshot;
    now?: number;
    mailboxes?: MailboxesOf | null;
}): Promise<StalledParticipant[]>;
/** One report per sighting of a named reset: the orchestrator is knocked once with the time, so the run
 * decides instead of reading the journal. `fresh` is `stallRound`'s, whose mark makes a sighting once. */
export declare function reportResets(home: string, task: string, fresh: StalledParticipant[], { registry, now, mailboxes, }: {
    registry: Registry;
    now?: number;
    mailboxes?: MailboxesOf | null;
}): Promise<string[]>;

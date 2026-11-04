import type { ParticipantV1, PromptobusHost, SessionSnapshot, StalledParticipant, TaskV1, Wake } from '../dist/index.js';
import type { LibDriver } from './driver-runtime.js';
type StatusHost = Partial<Pick<PromptobusHost, 'busCommand' | 'promptobusHome'>>;
type TaskTitle = Pick<TaskV1, 'id'> & Partial<Pick<TaskV1, 'title'>>;
type WakeContact = Partial<Pick<Wake, 'socket' | 'session' | 'at'>>;
type HealthEntry = Record<string, unknown>;
interface StatusOptions {
    task?: string;
    sessions?: SessionSnapshot;
}
export { commitStalls, pendingStalls, sessionBusy, stallStands, lastActivation, justSpawned, SPAWN_GRACE_SEC, } from '../dist/index.js';
export { stallTail } from './stalls.js';
export declare function stallLine(s: StalledParticipant, task: string, host?: StatusHost | null): string;
/** Task participants from whom no messages should be expected. The fourth argument is the
 * session snapshot, and the default builds it — a three-argument call still works. */
export declare function blockedParticipants(home: string, task: string, participants: ParticipantV1[] | null | undefined, sessions?: SessionSnapshot): StalledParticipant[] | null;
/** Participant session state: `alive` | `dead` | `unknown`. The default takes state for
 * exactly one participant — a snapshot is built from a list, this question needs none. */
export declare function participantSession(participant: ParticipantV1 | null | undefined, sessions?: SessionSnapshot): "alive" | "dead" | "unknown";
/** Whether this participant's harness reports the session dead. Unknown is not death. */
export declare function sessionReportedDead(participant: ParticipantV1 | null | undefined): boolean;
/** Why `participantSession` said `unknown`: the observer's failure named apart from the session's.
 * [03-cli.md § Status, done, sweep](../docs/reference/03-cli.md#status-done-sweep-dismiss-history) */
export declare function unknownWhy(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot, driver: {
    phrases: Pick<LibDriver['phrases'], 'unreadable'>;
}): string;
export declare const WARDEN_MARK = "NO WARDEN";
export declare function wardenLine(home: string, id: string, host: Pick<PromptobusHost, 'busCommand'> | null | undefined): {
    alive: boolean;
    line: string;
};
export declare function contactSocketPath(socket: unknown): string | null;
export declare function contactSocketGone(wake: {
    socket?: unknown;
} | null | undefined): boolean;
export declare function orchestratorSocketGone(wake: WakeContact | null | undefined, h: HealthEntry, owner: string | null | undefined): boolean;
export declare function orchestratorDeadLine(owner: unknown, since: unknown): string;
export declare function wardenDeadLine(meta: TaskTitle, host: Pick<PromptobusHost, 'busCommand'> | null | undefined, reason: unknown, unread?: number | null): string;
export declare function wardenPriorExitLine(meta: TaskTitle, reason: unknown, unread?: number | null): string;
export declare const MAILBOX_UNREAD_MARK: string;
export declare function status(rootOrHost: unknown, { task, sessions }?: StatusOptions): void;

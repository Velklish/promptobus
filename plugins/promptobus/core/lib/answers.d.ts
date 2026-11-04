import type { MessageV1, ParticipantV1 } from '../dist/index.js';
export declare const ANSWER_EXPECTED: readonly string[];
export declare const UNANSWERED_MARK = "UNANSWERED";
export declare function expectsAnswer(type: string): boolean;
export declare function unansweredUserQuestions(home: string, task: string): (Omit<MessageV1, "body" | "protocolVersion"> & {
    firstLine?: string;
})[];
/** Since when this address owes an answer, or `null` when the debt is even.
 * [03-cli.md § Guard and warden](../docs/reference/03-cli.md#guard-and-warden) */
export declare function answerOwedSince(home: string, task: string, addr: string, participant: ParticipantV1 | null | undefined): string | null;
/** The `UNANSWERED` state: a debt stands AND a turn has ended since it began — a reply
 * still being composed, and a death mid-turn, are not this. */
export declare function unansweredSince(home: string, task: string, addr: string, participant: ParticipantV1 | null | undefined): string | null;

import type { Ownership } from '../protocol.js';
import type { DeclaredStep } from '../registry.js';
import type { MessageV1, ParticipantV1, TaskV1 } from '../v1/model.js';
import type { PromptobusService } from './service.js';
/** Participant lines only the adapter knows: repository, worktree, background session. */
export type DecorateParticipant = (participant: ParticipantV1) => string[];
export declare const ADDR_MARK = " \u00B7 address ";
/** First word of an empty-mailbox reply. The hook compares it whole, not as a prefix. */
export declare const MAILBOX_EMPTY = "empty";
/** Prefix of a successful `promptobus_send` reply. The hook matches it at the start of the line. */
export declare const SENT_PREFIX = "sent ";
/** Word between message type and sender in a mailbox heading (`### status from name`). */
export declare const MESSAGE_FROM = " from ";
export declare function summarizeMessages(msgs: MessageV1[], from?: (m: MessageV1) => string): string;
export declare function readableName(meta: TaskV1 | null | undefined, addr: string, of?: boolean): string;
/** Sender address, translated from the journal only: `addrDir` is injective over admitted addresses alone,
 * and a record already gone from the journal has no role to ask, so the id itself is printed. */
export declare function senderAddress(meta: TaskV1 | null | undefined, m: MessageV1): string;
/** Header list of a mailbox read: sender, type, time, id, size and first line — never a body. */
export declare function renderMessages(service: PromptobusService, home: string, task: string, addr: string, msgs: MessageV1[], session?: string | null): string;
/** One message in full, as `promptobus_mailbox` returns it by id. */
export declare function renderMessage(service: PromptobusService, home: string, task: string, addr: string, m: MessageV1, session?: string | null): string;
export declare function foreignNote(task: string, { owner, session }: Ownership): string;
export declare function renderTask(service: PromptobusService, home: string, id: string, addr: string, session: string | null, decorate: DecorateParticipant, steps: readonly DeclaredStep[]): string;
/** The unread part of a participant line: the participant's total on its primary address, and on an
 * address alias the slot's own count with where it is counted — ADR-028 § The journal, the mailbox reads. */
export declare function mailboxPart(service: Pick<PromptobusService, 'mailboxOf' | 'countMailbox' | 'countInbox'>, home: string, id: string, addr: string): string;

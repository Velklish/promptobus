import type { MessageV1 } from '../dist/index.js';
export interface PreviewMessage extends Partial<Pick<MessageV1, 'type' | 'ts' | 'body'>> {
    from?: string;
    bus?: boolean;
    artifact?: string | null;
}
/** Preview separator. Named because it counts against the budget the same as the lines. */
export declare const PREVIEW_SEP = "\n\n";
/** "And N more" tail: overflow becomes a count instead of vanishing silently. Mail is fetched from
 * the mailbox; a bus line is not there, so it is counted apart. */
export declare function restLine(n: number, bus?: number): string;
/** The whole preview block. The budget holds the ENTIRE block of stub lines: a burst of mail
 * would otherwise grow the postcard line by line. */
export declare function previewBlock(msgs?: readonly PreviewMessage[], budget?: number): string;
/** Build one channel's frame around the shared preview block. */
export declare function orderBody(task: string, addr: string, unread: number, msgs?: readonly PreviewMessage[], { header, fetchLine, workingOrder, }?: {
    fetchLine?: string | undefined;
    header?: string | undefined;
    workingOrder?: string | undefined;
}): string;

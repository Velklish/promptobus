// The step that holds each piece of work, shared by the digest and the BB board so both agree.
// [reference/03-cli.md#digest](../docs/reference/03-cli.md#digest)

import { addressOf } from './protocol.js';
import { RECORD_ID_RE } from './v1/model.js';
import type { MessageV1, ParticipantV1 } from './v1/index.js';

type Header = Pick<MessageV1, 'id' | 'sender' | 'recipients' | 'type'>;

/** One piece of work: its slug, the step that holds it and its participants by step. */
export interface Piece {
  readonly slug: string;
  /** The holding step; `null` once every step from the piece's first one has a current result. */
  readonly step: string | null;
  /** The participant of each step the piece has one at, in pipeline order. */
  readonly participants: readonly { readonly step: string; readonly id: string }[];
}

function bySendOrder(a: Pick<MessageV1, 'id'>, b: Pick<MessageV1, 'id'>) {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/** The participant's newest result after its current assignment — the newest task or review sent to it
 * past its recorded boundary — or `null`; a participant without a valid boundary has none. */
export function currentResult<T extends Header>(participant: ParticipantV1 | null | undefined, messages: readonly T[]): T | null {
  const boundary = participant?.metadata?.assignmentAfterId;
  if (typeof boundary !== 'string' || !RECORD_ID_RE.test(boundary)) return null;
  const assignments = messages.filter((message) => message.recipients.includes(participant!.id)
    && (message.type === 'task' || message.type === 'review'));
  const afterId = assignments.reduce((latest, message) => message.id > latest ? message.id : latest, boundary);
  return messages.filter((message) => message.sender === participant!.id && message.type === 'result'
    && message.id > afterId).sort(bySendOrder).at(-1) ?? null;
}

/** Pieces in step order, done last: held by the first step from the piece's first participant whose
 * participant is missing or has no current result. An address whose prefix is not in `steps` is skipped. */
export function piecesOf(participants: readonly ParticipantV1[], messages: readonly Header[],
  steps: readonly string[]): Piece[] {
  const bySlug = new Map<string, Map<string, ParticipantV1>>();
  for (const participant of participants) {
    const address = addressOf(participant);
    const colon = address?.indexOf(':') ?? -1;
    if (!address || colon < 0 || !steps.includes(address.slice(0, colon))) continue;
    const slug = address.slice(colon + 1);
    if (!bySlug.has(slug)) bySlug.set(slug, new Map());
    bySlug.get(slug)!.set(address.slice(0, colon), participant);
  }
  const pieces: Piece[] = [];
  for (const [slug, held] of bySlug) {
    let holder: string | null = null;
    for (const step of steps.slice(steps.findIndex((name) => held.has(name)))) {
      holder = step;
      const participant = held.get(step);
      if (!participant || !currentResult(participant, messages)) break;
      holder = null;
    }
    pieces.push({ slug, step: holder,
      participants: steps.filter((step) => held.has(step)).map((step) => ({ step, id: held.get(step)!.id })) });
  }
  const order = (piece: Piece) => piece.step === null ? steps.length : steps.indexOf(piece.step);
  return pieces.sort((a, b) => order(a) - order(b) || a.slug.localeCompare(b.slug));
}

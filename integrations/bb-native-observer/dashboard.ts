import type { Board, Source, View } from './contract.js';
export function displayTime(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Unknown';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function messageLabel(message: { type: string; sender: string }, actors: readonly { participantId: string; role: string }[]): string {
  const role = actors.find(actor => actor.participantId === message.sender)?.role;
  return message.type === 'result' && role === 'reviewer' ? 'Reviewer result · recorded' : message.type;
}
export function sampleStale(sampledAt: string, now: number): boolean {
  const time = Date.parse(sampledAt);
  return !Number.isFinite(time) || now - time > 10000;
}
export function retainSample(previous: View | null, next: View): View {
  if (!next.snapshot && next.snapshotError && previous?.snapshot
    && previous.configuration.hostId === next.configuration.hostId
    && previous.configuration.storeRoot === next.configuration.storeRoot
    && previous.configuration.nativeRoot === next.configuration.nativeRoot
    && previous.configuration.taskId === next.configuration.taskId) return { ...next, snapshot: previous.snapshot };
  return next;
}
/** Whether two samples came from one host, store and native root. */
export function sameSource(a: Source | null | undefined, b: Source | null | undefined): boolean {
  return Boolean(a && b) && a!.hostId === b!.hostId && a!.storeRoot === b!.storeRoot && a!.nativeRoot === b!.nativeRoot;
}
/** Whether two piece references name one piece of one run from one source. */
export function samePiece(a: { taskId: string; slug: string; source: Source } | null | undefined,
  b: { taskId: string; slug: string; source: Source } | null | undefined): boolean {
  return Boolean(a && b) && a!.taskId === b!.taskId && a!.slug === b!.slug && sameSource(a!.source, b!.source);
}
/** Whether a fresh board from the opened piece's source still shows that piece. */
export function showsPiece(board: Pick<Board, 'runs'> & { source: Source }, piece: { taskId: string; slug: string; source: Source }): boolean {
  return sameSource(board.source, piece.source) && board.runs.some(run => run.id === piece.taskId && run.pieces.some(value => value.slug === piece.slug));
}
/** Why a holder has no thread to open, or null when it has one. */
export function threadNote(holder: { harness: string; bbThreadId: string | null }): string | null {
  if (holder.bbThreadId) return null;
  return holder.harness === 'bb' ? 'This BB participant has no BB thread recorded yet, so there is no thread to open.'
    : 'This participant runs outside BB, so it has no BB thread to open. Use its session reference with its own harness.';
}
type Run = Board['runs'][number];
type Piece = Run['pieces'][number];
export type HistoryFilter = 'all' | 'work' | 'status' | 'questions';
const HISTORY: Record<Exclude<HistoryFilter, 'all'>, readonly string[]> = {
  work: ['task', 'review', 'result'], status: ['status'], questions: ['question', 'answer'] };
export function historyMessages<T extends { type: string }>(messages: readonly T[], filter: HistoryFilter): T[] {
  return filter === 'all' ? [...messages] : messages.filter(message => HISTORY[filter].includes(message.type));
}
export function relativeAge(at: string | null | undefined, now: number): string {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return 'age unknown';
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
/** The run's steps as columns plus Done; a piece sits in the column of the step that holds it. */
export function columnsOf(run: Pick<Run, 'steps' | 'pieces' | 'startSteps'>): { step: string | null; label: string; pieces: Piece[] }[] {
  return [...run.steps.map(step => ({ step, label: step })), { step: null, label: run.startSteps ? 'Next step unconfirmed' : 'Done' }]
    .map(column => ({ ...column, pieces: run.pieces.filter(piece => piece.step === column.step) }));
}
export function pieceSignals(piece: Piece): { label: string; tone: string }[] {
  const holder = piece.holder, signals: { label: string; tone: string }[] = [];
  if (piece.unfinishedDelivery) signals.push({ label: 'Unfinished delivery', tone: 'warning' });
  if (!holder) {
    if (piece.step !== null) signals.push({ label: `No ${piece.step} yet`, tone: 'unknown' });
    return signals;
  }
  if (holder.stall) signals.push({ label: 'Stalled', tone: 'warning' });
  if (holder.question) signals.push({ label: 'Asked a question', tone: 'warning' });
  if (holder.unread) signals.push({ label: `${holder.unread} unread`, tone: 'active' });
  return signals;
}

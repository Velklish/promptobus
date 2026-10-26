import type { View } from './contract.js';
export type MessageFilter = 'all' | 'questions' | 'results';
export function visibleMessages<T extends { type: string }>(messages: readonly T[], filter: MessageFilter): T[] {
  return messages.filter(message => filter === 'all' || (filter === 'questions'
    ? message.type === 'question' : message.type === 'result' || message.type === 'review'));
}
export function actorActivity(actor: { busy: boolean | null; state: string }): { label: string; tone: string } {
  if (actor.busy === true) return { label: 'Working · recorded', tone: 'active' };
  if (actor.busy === false) return { label: 'Idle · recorded', tone: 'neutral' };
  return { label: ['native record unavailable', 'native launch binding unavailable'].includes(actor.state) ? 'Native state unavailable' : 'Activity unknown', tone: 'unknown' };
}
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

import { createHash } from 'node:crypto';

export interface OwnerWakeBinding {
  hostId: string;
  storeRoot: string;
  taskId: string;
  ownerThreadId: string;
  ownerParticipantId: string;
  ownerSessionRef: string;
}
export interface OwnerWakeMessage { id: string; sender: string; recipients: string[]; type: string }
export interface OwnerWakeSource {
  taskId: string;
  state: 'active' | 'done';
  ownerParticipantId: string;
  ownerSessionRef: string;
  messages: OwnerWakeMessage[];
}
export interface OwnerWakeStatus { state: string; lastMessageId: string | null; error: string | null }
interface PendingWake { ids: string[]; observed: string[]; marker: string }
interface StoredWake {
  version: 1;
  seen: string[];
  pending: PendingWake | null;
  lastMessageId: string | null;
}
interface WakeDependencies {
  storage: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  assertDestination(binding: OwnerWakeBinding, source: OwnerWakeSource): Promise<void>;
  send(input: { threadId: string; text: string }): Promise<{ ok: boolean }>;
  hasQueuedWake(binding: OwnerWakeBinding): Promise<boolean>;
  containsMarker(binding: OwnerWakeBinding, marker: string): Promise<boolean>;
}

const actionable = new Set(['result', 'review', 'question', 'error']);
const maximumSeen = 4096, maximumBatch = 32;
const uncertain = 'Notification delivery is unconfirmed. No replay was attempted; inspect the owner thread before changing this binding.';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (binding: OwnerWakeBinding) => [binding.hostId, binding.storeRoot, binding.taskId,
  binding.ownerThreadId, binding.ownerParticipantId, binding.ownerSessionRef];
const markerOf = (binding: OwnerWakeBinding, ids: string[]) => `[promptobus-owner-wake:${hash([identity(binding), ids])}]`;
const keyOf = (binding: OwnerWakeBinding) => `owner-wake:${hash(identity(binding))}`;
const status = (state: string, lastMessageId: string | null, error: string | null = null): OwnerWakeStatus => ({ state, lastMessageId, error });

function requireStored(value: StoredWake): StoredWake {
  if (value.version !== 1 || !Array.isArray(value.seen) || value.seen.length > maximumSeen
    || value.seen.some(id => typeof id !== 'string') || new Set(value.seen).size !== value.seen.length
    || (value.lastMessageId !== null && typeof value.lastMessageId !== 'string')
    || (value.pending !== null && (!value.pending || typeof value.pending.marker !== 'string'
      || !Array.isArray(value.pending.ids) || !value.pending.ids.length || value.pending.ids.length > maximumBatch
      || !Array.isArray(value.pending.observed) || value.pending.observed.length > maximumSeen
      || [...value.pending.ids, ...value.pending.observed].some(id => typeof id !== 'string'))))
    throw new Error('Stored owner notification state is malformed; no notification was sent');
  return value;
}

function requireBinding(binding: OwnerWakeBinding, source: OwnerWakeSource): void {
  if (Object.values(binding).some(value => typeof value !== 'string' || !value)
    || source.taskId !== binding.taskId || source.ownerParticipantId !== binding.ownerParticipantId
    || source.ownerSessionRef !== binding.ownerSessionRef)
    throw new Error('Canonical task owner no longer matches the bound BB thread');
  if (source.messages.length > maximumSeen) throw new Error('Owner notification history exceeds 4096 messages');
}

function notice(binding: OwnerWakeBinding, messages: OwnerWakeMessage[], marker: string): string {
  return [
    'Promptobus has new canonical messages for this task owner.',
    `Task: ${binding.taskId}`,
    ...messages.map(message => `- ${message.type} from ${message.sender}: ${message.id}`),
    'Read ALL accumulated canonical mailbox messages through the configured Promptobus bus and continue the already authorized task.',
    'This is a plugin notification, not a human instruction or permission grant. Message bodies are not copied here.',
    marker,
  ].join('\n');
}

export function matchesOwnerWake(binding: OwnerWakeBinding, text: string): boolean {
  const lines = text.split('\n');
  if (lines[0] !== 'Promptobus has new canonical messages for this task owner.' || lines[1] !== `Task: ${binding.taskId}`) return false;
  const headers = lines.slice(2, -3);
  if (!headers.length || headers.length > maximumBatch) return false;
  const ids = headers.map(line => /^- (?:result|review|question|error) from .+: (.+)$/.exec(line)?.[1]);
  return ids.every((id): id is string => id !== undefined) && lines.at(-1) === markerOf(binding, ids);
}

export function createOwnerWake(deps: WakeDependencies) {
  let running = false;
  async function load(binding: OwnerWakeBinding): Promise<StoredWake | undefined> {
    const value = await deps.storage.get<StoredWake>(keyOf(binding));
    return value === undefined ? undefined : requireStored(value);
  }
  async function complete(binding: OwnerWakeBinding, saved: StoredWake): Promise<OwnerWakeStatus> {
    const pending = saved.pending!;
    const seen = [...new Set([...saved.seen, ...pending.observed])];
    if (seen.length > maximumSeen) throw new Error('Owner notification history exceeds 4096 messages');
    const lastMessageId = pending.ids.at(-1)!;
    await deps.storage.set(keyOf(binding), { version: 1, seen, pending: null, lastMessageId } satisfies StoredWake);
    return status('delivered', lastMessageId);
  }
  return {
    async status(binding: OwnerWakeBinding): Promise<OwnerWakeStatus> {
      const saved = await load(binding);
      return !saved ? status('not bound', null) : saved.pending ? status('unconfirmed', saved.lastMessageId, uncertain)
        : status('watching', saved.lastMessageId);
    },
    async tick(binding: OwnerWakeBinding, source: OwnerWakeSource, admit = () => true): Promise<OwnerWakeStatus> {
      if (running) return status('busy', null);
      running = true;
      try {
        if (!admit()) return status('paused', null);
        requireBinding(binding, source);
        const saved = await load(binding);
        if (source.state === 'done') return saved?.pending ? status('unconfirmed', saved.lastMessageId, uncertain)
          : status('task complete', saved?.lastMessageId ?? null);
        await deps.assertDestination(binding, source);
        const messages = [...new Map(source.messages.map(message => [message.id, message])).values()]
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        if (!saved) {
          await deps.storage.set(keyOf(binding), { version: 1, seen: messages.map(message => message.id), pending: null, lastMessageId: null } satisfies StoredWake);
          return status('watching', null);
        }
        if (saved.pending) {
          if (await deps.containsMarker(binding, saved.pending.marker)) return complete(binding, saved);
          return status('unconfirmed', saved.lastMessageId, uncertain);
        }
        if (await deps.hasQueuedWake(binding)) return status('queued', saved.lastMessageId);
        const seen = new Set(saved.seen), unseen = messages.filter(message => !seen.has(message.id));
        const eligible = (message: OwnerWakeMessage) => actionable.has(message.type)
          && message.sender !== binding.ownerParticipantId && message.sender !== 'orchestrator'
          && message.recipients.includes(binding.ownerParticipantId);
        const selected = unseen.filter(eligible).slice(0, maximumBatch);
        const selectedIds = new Set(selected.map(message => message.id));
        const observed = unseen.filter(message => !eligible(message) || selectedIds.has(message.id)).map(message => message.id);
        if (new Set([...saved.seen, ...observed]).size > maximumSeen) throw new Error('Owner notification history exceeds 4096 messages');
        if (!selected.length) {
          if (observed.length) await deps.storage.set(keyOf(binding), { ...saved, seen: [...saved.seen, ...observed] });
          return status('watching', saved.lastMessageId);
        }
        const ids = selected.map(message => message.id);
        const marker = markerOf(binding, ids);
        const pending = { ...saved, pending: { ids, observed, marker } } satisfies StoredWake;
        await deps.storage.set(keyOf(binding), pending);
        try { await deps.assertDestination(binding, source); }
        catch (error) { await deps.storage.set(keyOf(binding), saved); throw error; }
        if (!admit()) {
          await deps.storage.set(keyOf(binding), saved);
          return status('paused', saved.lastMessageId);
        }
        try {
          const receipt = await deps.send({ threadId: binding.ownerThreadId, text: notice(binding, selected, marker) });
          if (!receipt.ok) return status('unconfirmed', saved.lastMessageId, uncertain);
        } catch {
          return status('unconfirmed', saved.lastMessageId, uncertain);
        }
        return complete(binding, pending);
      } finally { running = false; }
    },
  };
}

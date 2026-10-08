import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { observeBbParticipant } from './lifecycle.js';
import { pendingSchema } from './protocol.js';
import type { Binding } from './protocol.js';
import type { bindingStore } from './bindings.js';

const HEADER = 'Promptobus mailbox wake: ';
export const LAUNCH_HEADER = 'Promptobus launch: ';
const MAIL_ATTEMPTS = 3;
const CONTINUATIONS = 2;
const RECONCILE_MS = 30_000;
type Store = ReturnType<typeof bindingStore>;
type OnHost = (binding: Binding, request: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export function registerDelivery(bb: BbPluginApi, store: Store, onHost: OnHost) {
  const running = new Map<string, Promise<void>>();
  let disposed = false;
  const pause = (b: Binding, reason: string) => store.updateDelivery(b.threadId!, state => {
    state.paused = true; state.epoch += 1; state.reason = reason;
  });
  const replay = async (b: Binding, signal?: AbortSignal) => {
    for (;;) {
      const cursor = store.delivery(b.threadId!).cursor;
      const rows = await bb.sdk.threads.events.list({ threadId: b.threadId!, afterSeq: String(cursor), order: 'asc', limit: '100', signal,
        types: ['system/thread/interrupted', 'turn/completed', 'client/turn/requested', 'client/turn/rejected', 'system/interaction/lifecycle'] });
      if (disposed) return;
      store.updateDelivery(b.threadId!, state => {
        for (const row of rows) {
          if (row.threadId !== b.threadId) throw new Error('BB event thread mismatch');
          if (row.seq <= state.cursor) continue;
          state.cursor = row.seq;
          const interaction = row.type === 'system/interaction/lifecycle' ? row.data.interaction : null;
          if (row.type === 'system/thread/interrupted' || row.type === 'client/turn/rejected'
            || (row.type === 'turn/completed' && row.data.status !== 'completed')
            || (interaction && (interaction.status === 'interrupted'
              || (interaction.resolution && 'decision' in interaction.resolution && interaction.resolution.decision === 'deny')))) {
            state.paused = true; state.epoch += 1; state.reason = `BB ${row.type}; explicit resume is required`;
          }
          if (row.type === 'turn/completed' && row.data.status === 'completed') state.lastCompleted = row.seq;
          if (row.type === 'client/turn/requested' && state.pending && row.data.input?.some(block => block.type === 'text' && block.text.includes(state.pending!.marker))) {
            state.pending.requestSeq = row.seq; state.pending.state = 'sent'; state.pending.queuedId = null;
          }
        }
      });
      if (rows.length < 100) return;
    }
  };
  const cancelQueued = async (b: Binding) => {
    const pending = store.delivery(b.threadId!).pending;
    if (!pending) return;
    store.updateDelivery(b.threadId!, state => { if (state.pending?.marker === pending.marker) state.pending = null; });
    const entries = await bb.sdk.threads.queuedMessages.list({ threadId: b.threadId! });
    for (const entry of entries) if (entry.content.some(block => block.type === 'text' && block.text.includes(pending.marker))) {
      await bb.sdk.threads.queuedMessages.delete({ threadId: b.threadId!, queuedMessageId: entry.id });
    }
  };
  const reconcile = async (id: string, outerSignal?: AbortSignal) => {
    const b = store.thread(id);
    if (disposed || !b || b.phase !== 'ready') return;
    const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
    await replay(b, signal);
    let state = store.delivery(id);
    if (disposed || state.paused) return;
    const epoch = state.epoch;
    if ((await bb.sdk.system.config()).primaryHostId !== b.hostId) { pause(b, 'BB primary host changed'); return; }
    const observation = await observeBbParticipant(bb, b, signal);
    if (observation.thread?.archivedAt !== null && observation.thread?.archivedAt !== undefined
      || observation.thread?.deletedAt !== null && observation.thread?.deletedAt !== undefined) { pause(b, 'BB thread archived or deleted'); return; }
    if (observation.status === 'error' || observation.status === 'stopping') { pause(b, `BB ${observation.status}`); return; }
    if (observation.view.state !== 'alive' || observation.status !== 'idle' || observation.thread?.activeBackgroundAgentCount !== 0) return;
    if ((await bb.sdk.threads.interactions.list({ threadId: id, signal })).length) return;
    const mail = pendingSchema.parse(await onHost(b, { operation: 'pending' }, signal));
    const entries = await bb.sdk.threads.queuedMessages.list({ threadId: id, signal });
    await replay(b, signal);
    if (disposed || store.thread(id)?.phase !== 'ready' || store.delivery(id).epoch !== epoch || store.delivery(id).paused) return;
    state = store.updateDelivery(id, current => {
      if (current.key !== mail.revision) { current.key = mail.revision; current.attempts = 0; }
      if (current.obligation !== mail.obligation) { current.obligation = mail.obligation; current.continuations = 0; }
    });
    if (!mail.ids.length && !mail.obligation) {
      await cancelQueued(b);
      if (!disposed) store.updateDelivery(id, current => { if (current.epoch === epoch) current.pending = null; });
      return;
    }
    if (state.pending) {
      const pending = state.pending;
      const queued = entries.find(entry => entry.content.some(block => block.type === 'text' && block.text.includes(pending.marker)));
      if (queued) {
        store.updateDelivery(id, current => { if (current.epoch === epoch && current.pending?.marker === pending.marker) {
          current.pending.state = 'queued'; current.pending.queuedId = queued.id;
        } });
        return;
      }
      if (pending.requestSeq !== null ? state.lastCompleted <= pending.requestSeq : Date.now() - pending.at < RECONCILE_MS) return;
    }
    if (entries.length) return;
    const isMail = mail.ids.length > 0;
    if (isMail ? state.attempts >= MAIL_ATTEMPTS : state.continuations >= CONTINUATIONS) {
      store.updateDelivery(id, current => { if (current.epoch === epoch) current.reason = 'Continuation budget exhausted; explicit resume is required'; });
      return;
    }
    const marker = `${HEADER}${randomUUID()}`;
    const key = isMail ? `mail:${mail.revision}` : `result:${mail.obligation}`;
    const text = `${marker}\nTask ${b.task}; participant ${b.participant}; mailbox revision ${mail.revision}.\n`
      + (isMail ? `Canonical unread IDs: ${JSON.stringify(mail.ids)}. Read promptobus_mailbox with mode read. Process each canonical ID once; a repeated wake does not repeat an acknowledged assignment.`
        : `Canonical task ${mail.obligation} was acknowledged but has no result/review. Finish its protocol obligation or report a blocker to orchestrator; do not repeat completed source work.`)
      + '\nUse canonical messages and artifacts as the source of work. This hint is not mailbox ACK or acceptance. End the turn when waiting.';
    const saved = store.updateDelivery(id, current => {
      if (current.epoch !== epoch || current.paused) return;
      if (isMail) current.attempts += 1; else current.continuations += 1;
      current.reason = ''; current.pending = { marker, text, key, afterSeq: current.cursor, at: Date.now(), state: 'sending', queuedId: null, requestSeq: null };
    });
    if (saved.pending?.marker !== marker || disposed || store.thread(id)?.phase !== 'ready') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([bb.sdk.threads.send({ threadId: id, mode: 'queue-if-active', input: [{ type: 'text', text, mentions: [] }] }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('BB send response deadline exceeded')), 5000); })]);
      if (disposed) return;
      store.updateDelivery(id, current => { if (current.epoch === epoch && current.pending?.marker === marker) {
        current.pending.state = result.delivery; current.pending.queuedId = result.delivery === 'queued' ? result.queuedMessage.id : null;
      } });
    } catch (error) {
      if (!disposed) store.updateDelivery(id, current => { if (current.epoch === epoch && current.pending?.marker === marker) {
        current.pending.state = 'unknown'; current.reason = `Ambiguous BB send: ${(error as Error).message}`;
      } });
    } finally { clearTimeout(timer); }
  };
  const run = (id: string, signal?: AbortSignal) => {
    const existing = running.get(id);
    if (existing) return existing;
    const work = reconcile(id, signal).catch(error => { if (!disposed && !signal?.aborted) bb.log.warn(`Promptobus recovery ${id}: ${(error as Error).message}`); })
      .finally(() => running.delete(id));
    running.set(id, work); return work;
  };
  for (const event of ['experimental_thread.events', 'thread.idle', 'thread.active', 'thread.failed', 'thread.archived', 'thread.deleted', 'interaction.pending'] as const) {
    bb.events.on(event, ({ thread }) => run(thread.id));
  }
  bb.events.on('message.cancelled', ({ entry }) => {
    const b = store.thread(entry.threadId); const pending = b && store.delivery(entry.threadId).pending;
    if (b && pending && entry.content.some(block => block.type === 'text' && block.text.includes(pending.marker))) pause(b, 'User cancelled the queued wake');
  });
  bb.background.service('delivery-recovery', { async start(signal) {
    while (!signal.aborted && !disposed) {
      for (const b of store.list()) if (b.threadId && b.phase === 'ready') await run(b.threadId, signal);
      try { await sleep(1000, undefined, { signal }); } catch { return; }
    }
  } });
  bb.onDispose(() => { disposed = true; });
  return {
    run,
    replay,
    pause,
    cancelQueued,
    async arm(b: Binding) {
      await replay(b, AbortSignal.timeout(5000));
      store.updateDelivery(b.threadId!, state => {
        if (state.epoch === 0) { state.paused = false; state.reason = ''; }
      });
    },
    async resume(b: Binding) {
      if (b.phase !== 'ready') throw new Error('Participant is not ready for resume');
      await replay(b);
      const epoch = store.delivery(b.threadId!).epoch;
      const observation = await observeBbParticipant(bb, b);
      if (observation.view.state !== 'alive' || observation.status !== 'idle' || observation.thread?.activeBackgroundAgentCount !== 0
        || (await bb.sdk.threads.interactions.list({ threadId: b.threadId! })).length) throw new Error('Resume requires an available idle thread without pending interactions');
      await cancelQueued(b);
      store.updateDelivery(b.threadId!, state => {
        if (state.epoch !== epoch) throw new Error('A newer Stop wins over resume');
        state.epoch += 1; state.paused = false; state.pending = null; state.key = null; state.attempts = 0;
        state.obligation = null; state.continuations = 0; state.reason = '';
      });
      await run(b.threadId!);
      return store.delivery(b.threadId!);
    },
    admits(id: string, text: string) {
      const state = store.delivery(id);
      if (text.includes(LAUNCH_HEADER)) {
        const b = store.thread(id); const intent = b && store.launchIntent(b);
        return !state.paused && !!intent && text.includes(`${LAUNCH_HEADER}${intent.attemptId}`);
      }
      if (!text.includes(HEADER)) return true;
      return !state.paused && !!state.pending && text.includes(state.pending.marker);
    },
  };
}

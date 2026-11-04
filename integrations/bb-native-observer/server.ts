import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { configurationSchema, hostContract, rpcContract, rootsSchema, settingsSchema } from './contract.js';
import { createOwnerWake, matchesOwnerWake, type OwnerWakeBinding, type OwnerWakeSource } from './owner-wake.js';
export { rpcContract } from './contract.js';

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostId: { type: 'string', label: 'Host ID', default: '', experimental_schema: settingsSchema.shape.hostId.or(z.literal('')) },
    storeRoot: { type: 'string', label: 'Promptobus store root', default: '', experimental_schema: rootsSchema.shape.storeRoot.or(z.literal('')) },
    nativeRoot: { type: 'string', label: 'Native Codex state root', default: '', experimental_schema: rootsSchema.shape.nativeRoot.or(z.literal('')) },
    taskId: { type: 'string', label: 'Task ID', default: '', experimental_schema: configurationSchema.shape.taskId },
    ownerThreadId: { type: 'string', label: 'BB orchestrator thread', default: '' },
    wakeEnabled: { type: 'boolean', label: 'Notify BB orchestrator about new task messages', default: false },
  });
  let revision = 0;
  settings.onChange(() => { revision++; });
  let operations = Promise.resolve<unknown>(undefined);
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = operations.then(run);
    operations = result.catch(() => undefined);
    return result;
  };
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const configuration = async () => {
    const parsed = configurationSchema.safeParse(await settings.get());
    if (!parsed.success) throw new Error('Configure Host ID and absolute store and native roots in plugin Settings, then select a task');
    return parsed.data;
  };
  const snapshotFor = async (values: Awaited<ReturnType<typeof configuration>>) => {
    const { hostId, storeRoot, nativeRoot, taskId } = settingsSchema.parse(values);
    const selected = { storeRoot, nativeRoot, taskId };
    const value = await host.call('snapshot', selected, { hostId, timeoutMs: 5000 });
    if (value.selection.storeRoot !== selected.storeRoot || value.selection.nativeRoot !== selected.nativeRoot
      || value.selection.taskId !== selected.taskId || value.task.id !== selected.taskId) throw new Error('Snapshot selection differs from the configured task');
    return value;
  };
  const tasksFor = (values: Awaited<ReturnType<typeof configuration>>) => host.call('tasks',
    { storeRoot: values.storeRoot, nativeRoot: values.nativeRoot }, { hostId: values.hostId, timeoutMs: 5000 });
  const unchanged = (started: number) => {
    if (started !== revision) throw new Error('Selected configuration changed while reading; refresh the observer');
  };
  const snapshot = async () => {
    const started = revision, values = await configuration(), value = await snapshotFor(values);
    unchanged(started); return value;
  };
  const selection = async () => {
    const { hostId, storeRoot, nativeRoot, taskId } = settingsSchema.parse(await settings.get());
    return { hostId, selected: { storeRoot, nativeRoot, taskId } };
  };
  const feed = async () => {
    const { hostId, selected } = await selection();
    const source = await host.call('ownerFeed', selected, { hostId, timeoutMs: 5000 });
    if (source.taskId !== selected.taskId || source.state === 'not prepared' || !source.ownerSessionRef)
      throw new Error('Selected task has no bound owner session');
    return { hostId, selected, source: source as OwnerWakeSource };
  };
  let lastError: string | null = null;
  const wake = createOwnerWake({
    storage: bb.storage.kv,
    async assertDestination(binding) {
      const current = await feed();
      if (current.hostId !== binding.hostId || current.selected.storeRoot !== binding.storeRoot
        || current.selected.taskId !== binding.taskId || current.source.state !== 'active'
        || current.source.ownerParticipantId !== binding.ownerParticipantId || current.source.ownerSessionRef !== binding.ownerSessionRef)
        throw new Error('Selected task owner changed; notifications are paused');
      const thread = await bb.sdk.threads.get({ threadId: binding.ownerThreadId, include: 'environment' });
      if (thread.providerId !== 'codex' || thread.archivedAt !== null || thread.deletedAt !== null
        || !('environment' in thread) || !thread.environment || thread.environment.hostId !== binding.hostId)
        throw new Error('BB owner must be an unarchived Codex thread on the selected host');
      const identity = await bb.sdk.threads.events.list({ threadId: binding.ownerThreadId, types: ['thread/identity'], order: 'desc', limit: '1' });
      if (identity[0]?.type !== 'thread/identity' || identity[0].data.providerThreadId !== binding.ownerSessionRef)
        throw new Error('BB thread does not match the canonical owner session');
    },
    send: ({ threadId, text }) => bb.sdk.threads.send({ threadId, originPluginId: 'promptobus-native-panel', mode: 'queue-if-active', input: [{ type: 'text', text, mentions: [] }] }),
    async hasQueuedWake(binding) {
      const queued = await bb.sdk.threads.queuedMessages.list({ threadId: binding.ownerThreadId });
      const own = queued.filter(row => row.origin === 'plugin' && row.originPluginId === 'promptobus-native-panel'
        && row.content.some(item => item.type === 'text' && matchesOwnerWake(binding, item.text)));
      if (own.some(row => row.state === 'failed_exhausted'))
        throw new Error('Queued owner notification exhausted delivery attempts; inspect the owner queue before continuing');
      return own.length > 0;
    },
    async containsMarker(binding, marker) {
      const queued = await bb.sdk.threads.queuedMessages.list({ threadId: binding.ownerThreadId });
      if (queued.some(row => row.origin === 'plugin' && row.originPluginId === 'promptobus-native-panel'
        && row.content.some(item => item.type === 'text' && item.text.split('\n').at(-1) === marker))) return true;
      let afterSeq: string | undefined;
      for (let page = 0; page < 20; page++) {
        const rows = await bb.sdk.threads.events.list({ threadId: binding.ownerThreadId,
          types: ['client/turn/requested'], order: 'asc', limit: '200', afterSeq });
        if (rows.some(row => row.type === 'client/turn/requested'
          && (JSON.stringify(row.data.input).includes(marker) || JSON.stringify(row.data.inputGroups ?? []).includes(marker)))) return true;
        if (rows.length < 200) return false;
        afterSeq = String(rows.at(-1)!.seq);
      }
      throw new Error('Owner notification delivery history exceeds the bounded scan');
    },
  });
  const binding = async (): Promise<{ binding: OwnerWakeBinding; source: OwnerWakeSource }> => {
    const values = await settings.get(), current = await feed();
    if (!/^thr_[a-z0-9]+$/.test(values.ownerThreadId)) throw new Error('Select the BB orchestrator thread before enabling notifications');
    const issued = await bb.storage.kv.get<OwnerWakeBinding>('owner-notification-binding');
    if (!issued || issued.hostId !== current.hostId || issued.storeRoot !== current.selected.storeRoot
      || issued.taskId !== current.selected.taskId || issued.ownerThreadId !== values.ownerThreadId
      || issued.ownerParticipantId !== current.source.ownerParticipantId || issued.ownerSessionRef !== current.source.ownerSessionRef)
      throw new Error('Notification selection or owner changed; explicitly reconnect the BB owner');
    return { source: current.source, binding: issued };
  };
  const wakeStatus = async () => {
    const values = await settings.get();
    if (!values.wakeEnabled) return { enabled: false, ownerThreadId: values.ownerThreadId || null, state: 'disabled', error: null, lastMessageId: null };
    try {
      const current = await binding(), status = await wake.status(current.binding);
      const state = current.source.state === 'done' && !status.error ? 'task complete' : status.state;
      return { enabled: true, ownerThreadId: values.ownerThreadId, ...status, state: lastError ? 'paused' : state, error: lastError ?? status.error };
    } catch (error) {
      return { enabled: true, ownerThreadId: values.ownerThreadId || null, state: 'paused', error: String(error), lastMessageId: null };
    }
  };
  bb.rpc.register(rpcContract, {
    snapshot,
    async view() {
      const started = revision, values = await configuration();
      const [catalogue, selected, notifications] = await Promise.allSettled([tasksFor(values),
        values.taskId ? snapshotFor(values) : Promise.resolve(null), wakeStatus()]);
      unchanged(started);
      return { configuration: values,
        snapshot: selected.status === 'fulfilled' ? selected.value : null,
        snapshotError: selected.status === 'rejected' ? String(selected.reason) : null,
        catalogue: catalogue.status === 'fulfilled' ? catalogue.value : null,
        catalogueError: catalogue.status === 'rejected' ? String(catalogue.reason) : null,
        wake: notifications.status === 'fulfilled' ? notifications.value : { enabled: values.wakeEnabled, ownerThreadId: values.ownerThreadId || null, state: 'paused', error: String(notifications.reason), lastMessageId: null } };
    },
    async tasks() {
      const started = revision, value = await tasksFor(await configuration());
      unchanged(started); return value;
    },
    async selectTask({ taskId }) {
      const started = ++revision;
      return serial(async () => {
        const values = await configuration();
        const value = await snapshotFor({ ...values, taskId });
        if (value.task.state === 'not prepared') throw new Error('Selected task is unavailable; refresh the task list');
        unchanged(started);
        await settings.experimental_set({ taskId, wakeEnabled: false, ownerThreadId: '' });
        const persisted = revision, fresh = await configuration();
        unchanged(persisted);
        if (fresh.taskId !== taskId || fresh.hostId !== values.hostId || fresh.storeRoot !== values.storeRoot || fresh.nativeRoot !== values.nativeRoot)
          throw new Error('Selected configuration changed while persisting the task');
        lastError = null;
        return value;
      });
    },
    wakeStatus,
    async bindOwner({ taskId, threadId, enabled }) {
      const started = ++revision;
      return serial(async () => {
        if ((await settings.get()).taskId !== taskId) throw new Error('Selected task changed; refresh before binding its BB owner');
        if (!enabled) { await settings.experimental_set({ wakeEnabled: false }); lastError = null; return wakeStatus(); }
        const current = await feed();
        const selected: OwnerWakeBinding = { hostId: current.hostId, storeRoot: current.selected.storeRoot,
          taskId: current.selected.taskId, ownerThreadId: threadId,
          ownerParticipantId: current.source.ownerParticipantId, ownerSessionRef: current.source.ownerSessionRef };
        await wake.tick(selected, current.source, () => started === revision);
        unchanged(started);
        await bb.storage.kv.set('owner-notification-binding', selected);
        const fresh = await selection();
        unchanged(started);
        if (fresh.hostId !== current.hostId || JSON.stringify(fresh.selected) !== JSON.stringify(current.selected))
          throw new Error('Selected task changed before binding its BB owner');
        await settings.experimental_set({ ownerThreadId: threadId, wakeEnabled: true });
        lastError = null;
        return wakeStatus();
      });
    },
  });
  bb.background.service('owner-notifications', { async start(signal) {
    while (!signal.aborted) {
      try {
        await serial(async () => {
          const started = revision, values = await settings.get();
          if (values.wakeEnabled) {
            const current = await binding();
            await wake.tick(current.binding, current.source, () => !signal.aborted && started === revision);
            lastError = null;
          }
        });
      } catch (error) { lastError = String(error); }
      await new Promise<void>(resolve => {
        const finished = () => { clearTimeout(timer); signal.removeEventListener('abort', finished); resolve(); };
        const timer = setTimeout(finished, 2000);
        signal.addEventListener('abort', finished, { once: true });
        if (signal.aborted) finished();
      });
    }
  } });
  bb.cli.register({ name: 'promptobus-native-panel', summary: 'Read the configured native task snapshot', async run(argv) {
    if (argv.length) return { exitCode: 1, stderr: 'No arguments accepted; use plugin Settings or the dashboard task selector' };
    return { exitCode: 0, stdout: JSON.stringify(await snapshot()) };
  } });
}

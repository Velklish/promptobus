import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from '../server.js';
import { readOwnerFeed, readProjection, readTasks } from '../projection.js';
import type { OwnerWakeSource } from '../owner-wake.js';
import type { Selection, Snapshot } from '../contract.js';
import { fixture, treeDigest } from './fixture.js';

const ownerSession = '01a169ae-1d39-7f30-8f37-4f76d1c73083';
const taskId = 'selected-task', ownerThreadId = 'thr_owner', hostId = 'host_example';
const input = (text: string) => ({ type: 'text' as const, text, mentions: [] });
const message = (id: string) => ({ id, sender: 'worker-id', recipients: ['owner-id'], type: 'result' });
type Values = { hostId: string; storeRoot: string; nativeRoot: string; taskId: string; ownerThreadId: string; wakeEnabled: boolean };
type EventRow = { seq: number; type: string; data: Record<string, unknown> };
type SettingsDescriptor = { default: unknown; experimental_schema?: { safeParse: (value: unknown) => { success: boolean } } };
type WakeStatus = { enabled: boolean; ownerThreadId: string | null; state: string; error: string | null; lastMessageId: string | null };
type Handlers = {
  snapshot(): Promise<Snapshot>;
  view(): Promise<{ snapshot: Snapshot; wake: WakeStatus }>;
  tasks(): Promise<unknown>;
  selectTask(input: { taskId: string }): Promise<Snapshot>;
  bindOwner(input: { taskId: string; threadId: string; enabled: boolean }): Promise<WakeStatus>;
  wakeStatus(): Promise<WakeStatus>;
};

function harness(existing?: { values: Values; storage: Map<string, unknown> }) {
  const values: Values = existing?.values ?? { hostId, storeRoot: '/owned/bus', nativeRoot: '/owned/native', taskId,
    ownerThreadId: '', wakeEnabled: false };
  const storage = existing?.storage ?? new Map<string, unknown>();
  const settingsListeners: ((next: Values, previous: Values) => void)[] = [];
  const hostCalls: { method: string; input: unknown; options: unknown }[] = [], sdkCalls: { method: string; input: unknown }[] = [];
  const sends: { threadId: string; mode: string; input: ReturnType<typeof input>[];
    originPluginId?: string; senderThreadId?: string; permissionMode?: string }[] = [];
  let source: OwnerWakeSource = { taskId, state: 'active', ownerParticipantId: 'owner-id', ownerSessionRef: ownerSession, messages: [] };
  let thread = { providerId: 'codex', archivedAt: null as number | null, deletedAt: null as number | null,
    environment: { hostId } as { hostId: string } | null };
  let identities: EventRow[] = [{ seq: 1, type: 'thread/identity', data: { threadId: ownerThreadId, providerThreadId: ownerSession } }];
  let history: EventRow[] = [], queued: { content: ReturnType<typeof input>[]; originPluginId?: string | null; origin?: string | null; state?: string }[] = [];
  let busy = false, queueError: Error | null = null;
  let afterQueueRead: (() => Promise<void>) | null = null;
  let sendError: Error | null = null;
  let beforeStorageSet: ((key: string) => Promise<void>) | null = null;
  let identityChecks = 0, beforeIdentity: ((call: number) => Promise<void>) | null = null;
  let hostReader: ((method: string, selected: Selection) => unknown) | null = null;
  let rpc!: Handlers, cli!: { run: (argv: string[]) => Promise<{ exitCode: number }> }, service!: { start(signal: AbortSignal): Promise<void> };
  let descriptors!: Record<string, SettingsDescriptor>;
  const selection = () => ({ storeRoot: values.storeRoot, nativeRoot: values.nativeRoot, taskId: values.taskId });
  const snapshot = (selected: Selection) => ({ selection: selected, sampledAt: '2026-10-26T00:00:00.000Z', observer: { instance: 'test', pid: 1 },
    task: { id: selected.taskId, title: 'Selected task', state: 'active', updated: null, owner: { id: source.ownerParticipantId, sessionRef: source.ownerSessionRef, harness: 'codex' } },
    actors: [], messages: [], limits: [] });
  const changeSettings = (patch: Partial<Values>) => {
    const previous = { ...values }; Object.assign(values, patch);
    for (const listener of settingsListeners) listener({ ...values }, previous);
    return { ...values };
  };
  const bb = {
    settings: { define(value: typeof descriptors) { descriptors = value; return {
      async get() { return { ...values }; },
      async experimental_set(patch: Partial<Values>) { return changeSettings(patch); },
      onChange(listener: typeof settingsListeners[number]) { settingsListeners.push(listener); },
    }; } },
    storage: { kv: { async get<T>(key: string) { return structuredClone(storage.get(key)) as T | undefined; },
      async set(key: string, value: unknown) { await beforeStorageSet?.(key); storage.set(key, structuredClone(value)); } } },
    hosts: { experimental_client: () => ({ async call(method: string, selected: Selection, options: unknown) {
      hostCalls.push({ method, input: selected, options });
      if (hostReader) return hostReader(method, selected);
      if (method === 'ownerFeed') return structuredClone(source);
      if (method === 'tasks') return { tasks: [{ id: taskId, title: 'Selected task', state: 'active', updated: '2026-10-26' }], truncated: false, scanned: 1 };
      return snapshot(selected);
    } }) },
    sdk: { threads: {
      async get(args: unknown) { sdkCalls.push({ method: 'get', input: args }); return structuredClone(thread); },
      events: { async list(args: { types: string[]; afterSeq?: string; limit?: string }) {
        sdkCalls.push({ method: 'events.list', input: args });
        if (args.types.includes('thread/identity')) await beforeIdentity?.(++identityChecks);
        return structuredClone(args.types.includes('thread/identity') ? identities
          : history.filter(row => row.seq > Number(args.afterSeq ?? 0)).slice(0, Number(args.limit ?? 200)));
      } },
      queuedMessages: { async list(args: unknown) {
        sdkCalls.push({ method: 'queuedMessages.list', input: args });
        if (queueError) throw queueError;
        const rows = structuredClone(queued); await afterQueueRead?.(); return rows;
      } },
      async send(args: typeof sends[number]) { sends.push(structuredClone(args)); if (sendError) throw sendError;
        if (busy) queued.push({ content: structuredClone(args.input), originPluginId: args.originPluginId, origin: 'plugin' });
        return { ok: true, delivery: busy ? 'queued' : 'sent' }; },
    } },
    background: { service(name: string, value: typeof service) { assert.equal(name, 'owner-notifications'); service = value; } },
    rpc: { register(_contract: unknown, handlers: Handlers) { rpc = handlers; } },
    cli: { register(value: typeof cli) { cli = value; } },
  };
  plugin(bb as never);
  return { values, storage, hostCalls, sdkCalls, sends, rpc, cli, descriptors, selection, snapshot, changeSettings,
    setSource: (value: OwnerWakeSource) => { source = value; },
    setThread: (patch: Partial<typeof thread>) => { thread = { ...thread, ...patch }; },
    setIdentities: (value: EventRow[]) => { identities = value; },
    setHistory: (value: EventRow[]) => { history = value; }, setQueue: (value: typeof queued) => { queued = value; },
    setQueueError: (value: Error | null) => { queueError = value; },
    afterQueueRead: (hook: typeof afterQueueRead) => { afterQueueRead = hook; },
    queue: () => structuredClone(queued), setBusy: (value: boolean) => { busy = value; },
    setSendError: (value: Error | null) => { sendError = value; },
    beforeIdentity: (hook: NonNullable<typeof beforeIdentity>) => { identityChecks = 0; beforeIdentity = hook; },
    beforeStorageSet: (hook: NonNullable<typeof beforeStorageSet>) => { beforeStorageSet = hook; },
    readHost: (reader: NonNullable<typeof hostReader>) => { hostReader = reader; },
    async pollOnce() {
      const abort = new AbortController(), running = service.start(abort.signal);
      await new Promise<void>(resolve => setImmediate(resolve));
      abort.abort(); await running;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('a bind paused in BB identity validation cannot arm a subsequently selected task', async () => {
  const f = harness(), entered = deferred(), release = deferred();
  f.beforeIdentity(async () => { entered.resolve(); await release.promise; });
  const binding = f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  await entered.promise;
  const selecting = f.rpc.selectTask({ taskId: 'task-next' });
  release.resolve();
  const outcomes = await Promise.allSettled([binding, selecting]);
  assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal(f.values.taskId, 'task-next');
  assert.equal(f.values.wakeEnabled, false, 'a stale task bind must not enable the newly selected task');
  assert.equal(f.values.ownerThreadId, '');
  assert.equal(f.sends.length, 0);
});

test('disabling during the final destination check cancels the pending notification before send', async () => {
  const f = harness();
  await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  f.setSource({ taskId, state: 'active', ownerParticipantId: 'owner-id', ownerSessionRef: ownerSession, messages: [message('020')] });
  const entered = deferred(), release = deferred();
  f.beforeIdentity(async call => { if (call === 2) { entered.resolve(); await release.promise; } });
  const polling = f.pollOnce();
  await entered.promise;
  const disabling = f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: false });
  await new Promise<void>(resolve => setImmediate(resolve));
  release.resolve();
  await Promise.all([disabling, polling]);
  assert.equal(f.values.wakeEnabled, false);
  assert.equal(f.sends.length, 0, 'a disabled binding must not send after its pending destination check resumes');
});

test('combined dashboard view refuses a selection changed during its snapshot read', async () => {
  const f = harness(), entered = deferred(), release = deferred();
  f.readHost(async (method, selected) => {
    if (method === 'snapshot' && selected.taskId === taskId) { entered.resolve(); await release.promise; }
    return f.snapshot(selected);
  });
  const view = f.rpc.view();
  await entered.promise;
  await f.rpc.selectTask({ taskId: 'task-next' });
  release.resolve();
  await assert.rejects(view, /[Ss]election.*changed|[Ss]elected (task|configuration).*changed/);
});

test('binding refuses an external Settings change while its issued binding is being persisted', async () => {
  const f = harness(), entered = deferred(), release = deferred();
  f.beforeStorageSet(async key => {
    if (key === 'owner-notification-binding') { entered.resolve(); await release.promise; }
  });
  const binding = f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  await entered.promise;
  f.changeSettings({ taskId: 'task-next' });
  release.resolve();
  await assert.rejects(binding, /[Ss]election.*changed|[Ss]elected (task|configuration).*changed/);
  assert.equal(f.values.taskId, 'task-next');
  assert.equal(f.values.wakeEnabled, false, 'an issued binding write must not re-enable a different selected task');
  assert.equal(f.sends.length, 0);
});

test('server validates Settings before host access and forwards only the current configured selection', async () => {
  const f = harness(); f.values.hostId = ''; f.values.storeRoot = ''; f.values.nativeRoot = ''; f.values.taskId = '';
  assert.equal(f.descriptors.storeRoot.experimental_schema!.safeParse('relative').success, false);
  assert.equal(f.descriptors.taskId.experimental_schema!.safeParse('../foreign').success, false);
  assert.equal(f.descriptors.hostId.experimental_schema!.safeParse('').success, true);
  await assert.rejects(f.rpc.snapshot(), /Configure/); assert.equal(f.hostCalls.length, 0);
  Object.assign(f.values, { hostId, storeRoot: '/owned/bus', nativeRoot: '/owned/native', taskId: 'task-a' });
  await f.rpc.snapshot();
  assert.deepEqual(f.hostCalls, [{ method: 'snapshot', input: f.selection(), options: { hostId, timeoutMs: 5000 } }]);
  f.values.taskId = 'task-b'; await f.rpc.snapshot();
  assert.equal((f.hostCalls[1].input as Selection).taskId, 'task-b');
  assert.equal((await f.cli.run(['stop'])).exitCode, 1); assert.equal(f.hostCalls.length, 2);
});

test('owner binding validates actual metadata.owner against BB thread identity and ignores existing messages', async () => {
  const f = harness(), disk = fixture('actual-owner-feed');
  try {
    const owner = disk.engine.readTask(disk.selection.taskId).participants.find(row => row.id === 'owner')!;
    disk.engine.patchParticipant(disk.selection.taskId, owner.id, { metadata: { ...owner.metadata, owner: ownerSession } });
    disk.engine.sendSync(disk.selection.taskId, { from: 'actor-0', to: ['owner'], type: 'result', body: 'Existing result' });
    Object.assign(f.values, disk.selection);
    f.readHost((method, selected) => method === 'ownerFeed' ? readOwnerFeed(selected)
      : method === 'tasks' ? readTasks(selected) : readProjection(selected, 'server-test', 1));
    const before = treeDigest(disk.root);
    const bound = await f.rpc.bindOwner({ taskId: disk.selection.taskId, threadId: ownerThreadId, enabled: true });
    assert.equal(bound.enabled, true); assert.equal(bound.state, 'watching'); assert.equal(f.sends.length, 0);
    await f.pollOnce(); assert.equal(f.sends.length, 0); assert.equal(treeDigest(disk.root), before);
    assert.ok(f.sdkCalls.some(call => call.method === 'get'
      && JSON.stringify(call.input) === JSON.stringify({ threadId: ownerThreadId, include: 'environment' })));
    assert.ok(f.sdkCalls.some(call => call.method === 'events.list'
      && JSON.stringify(call.input).includes('thread/identity')));
  } finally { disk.cleanup(); }
});

test('binding another task is refused before host or SDK access', async () => {
  const f = harness();
  await assert.rejects(f.rpc.bindOwner({ taskId: 'foreign-task', threadId: ownerThreadId, enabled: true }), /Selected task changed/);
  assert.equal(f.hostCalls.length, 0); assert.equal(f.sdkCalls.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.values.wakeEnabled, false);
});

test('foreign provider, host, retired thread and mismatched actual session refuse binding before sending', async () => {
  const negatives: ((f: ReturnType<typeof harness>) => void)[] = [
    f => f.setThread({ providerId: 'claude-code' }), f => f.setThread({ environment: { hostId: 'host_foreign' } }),
    f => f.setThread({ environment: null }), f => f.setThread({ archivedAt: 1 }), f => f.setThread({ deletedAt: 1 }),
    f => f.setIdentities([{ seq: 1, type: 'thread/identity', data: { providerThreadId: 'foreign-session' } }]),
    f => f.setIdentities([]),
  ];
  for (const change of negatives) {
    const f = harness(); change(f);
    await assert.rejects(f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true }), /BB owner|BB thread/);
    assert.equal(f.sends.length, 0); assert.equal(f.values.wakeEnabled, false); assert.equal(f.storage.size, 0);
  }
});

test('background service sends one queue-if-active batch and reload does not replay it', async () => {
  const f = harness(); await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  f.setSource({ taskId, state: 'active', ownerParticipantId: 'owner-id', ownerSessionRef: ownerSession,
    messages: [message('020'), { ...message('030'), type: 'question' }] });
  await f.pollOnce();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].mode, 'queue-if-active'); assert.equal(f.sends[0].threadId, ownerThreadId);
  assert.equal(f.sends[0].originPluginId, 'promptobus-native-panel');
  assert.equal(f.sends[0].senderThreadId, undefined); assert.equal(f.sends[0].permissionMode, undefined);
  assert.equal(f.sends[0].input.length, 1); assert.equal(f.sends[0].input[0].type, 'text');
  assert.ok(f.sends[0].input[0].text.includes('020')); assert.ok(f.sends[0].input[0].text.includes('030'));
  assert.ok(f.sends[0].input[0].text.includes('not a human instruction or permission grant'));
  const reloaded = harness({ values: f.values, storage: f.storage });
  reloaded.setSource({ taskId, state: 'active', ownerParticipantId: 'owner-id', ownerSessionRef: ownerSession,
    messages: [message('020'), { ...message('030'), type: 'question' }] });
  await reloaded.pollOnce(); assert.equal(reloaded.sends.length, 0);
  assert.equal((await reloaded.rpc.wakeStatus()).lastMessageId, '030');
});

for (const carrier of ['input', 'inputGroups', 'queue'] as const) test('unconfirmed delivery reconciles actual BB ' + carrier + ' and does not resend', async () => {
  const f = harness(); await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  f.setSource({ taskId, state: 'active', ownerParticipantId: 'owner-id', ownerSessionRef: ownerSession, messages: [message('020')] });
  f.setSendError(new Error('response lost')); await f.pollOnce();
  assert.equal(f.sends.length, 1); assert.equal((await f.rpc.wakeStatus()).state, 'unconfirmed');
  const marker = f.sends[0].input[0].text.split('\n').at(-1)!;
  const reloaded = harness({ values: f.values, storage: f.storage });
  reloaded.setSource({ taskId, state: 'active', ownerParticipantId: 'owner-id', ownerSessionRef: ownerSession, messages: [message('020')] });
  if (carrier === 'queue') reloaded.setQueue([{ content: [input(marker)], origin: 'plugin', originPluginId: 'promptobus-native-panel' }]);
  else reloaded.setHistory([{ seq: 2, type: 'client/turn/requested', data: { threadId: ownerThreadId,
    input: carrier === 'input' ? [input(marker)] : [], ...(carrier === 'inputGroups' ? { inputGroups: [[input(marker)]] } : {}) } }]);
  await reloaded.pollOnce();
  assert.equal(reloaded.sends.length, 0); assert.equal((await reloaded.rpc.wakeStatus()).lastMessageId, '020');
});

test('a missing delivery marker keeps the pending notification unconfirmed across polls', async () => {
  const f = harness(); await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  f.setSource({ taskId, state: 'active', ownerParticipantId: 'owner-id', ownerSessionRef: ownerSession, messages: [message('020')] });
  f.setSendError(new Error('response lost')); await f.pollOnce(); f.setSendError(null); await f.pollOnce();
  assert.equal(f.sends.length, 1); assert.equal((await f.rpc.wakeStatus()).state, 'unconfirmed');
});

test('current destination and owner drift pauses background delivery before SDK send', async () => {
  const f = harness(); await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  f.setSource({ taskId, state: 'active', ownerParticipantId: 'owner-id', ownerSessionRef: ownerSession, messages: [message('020')] });
  f.setThread({ environment: { hostId: 'host_foreign' } }); await f.pollOnce();
  assert.equal(f.sends.length, 0); assert.equal((await f.rpc.wakeStatus()).state, 'paused');
  f.setThread({ environment: { hostId } });
  f.setSource({ taskId, state: 'active', ownerParticipantId: 'owner-id', ownerSessionRef: 'foreign-session', messages: [message('020')] });
  await f.pollOnce(); assert.equal(f.sends.length, 0); assert.equal((await f.rpc.wakeStatus()).state, 'paused');
});

test('task catalogue works before task selection and selecting a task disables its previous owner binding', async () => {
  const f = harness(); f.values.taskId = '';
  assert.deepEqual(await f.rpc.tasks(), { tasks: [{ id: taskId, title: 'Selected task', state: 'active', updated: '2026-10-26' }], truncated: false, scanned: 1 });
  assert.equal(f.sdkCalls.length, 0);
  f.values.taskId = taskId; await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  await f.rpc.selectTask({ taskId: 'task-next' });
  assert.equal(f.values.taskId, 'task-next'); assert.equal(f.values.wakeEnabled, false); assert.equal(f.values.ownerThreadId, '');
  assert.equal((await f.rpc.wakeStatus()).state, 'disabled');
  await f.pollOnce(); assert.equal(f.sends.length, 0);
});


test('busy owner keeps exactly one wake across distinct messages and resumes every unseen ID after dispatch', async () => {
  const f = harness(); f.setBusy(true);
  await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  const messages = [message('010')];
  const feed = () => ({ taskId, state: 'active' as const, ownerParticipantId: 'owner-id', ownerSessionRef: ownerSession, messages });
  f.setSource(feed()); await f.pollOnce();
  messages.push({ ...message('020'), type: 'question' });
  f.setSource(feed()); await f.pollOnce();
  messages.push(message('030')); f.setSource(feed()); await f.pollOnce();
  assert.equal(f.queue().length, 1, 'new canonical IDs must not append wakes while the owner is busy');
  assert.equal(f.sends.length, 1);
  assert.equal((await f.rpc.wakeStatus()).lastMessageId, '010');
  assert.match(f.sends[0].input[0].text, /Read ALL accumulated canonical mailbox messages/);
  f.setQueue([]); await f.pollOnce();
  assert.equal(f.queue().length, 1); assert.equal(f.sends.length, 2);
  assert.match(f.sends[1].input[0].text, /020/); assert.match(f.sends[1].input[0].text, /030/);
  assert.equal((await f.rpc.wakeStatus()).lastMessageId, '030');
  f.setQueue([]); await f.pollOnce(); assert.equal(f.sends.length, 2);
});


const ownerFeed = (ids: string[]): OwnerWakeSource => ({ taskId, state: 'active', ownerParticipantId: 'owner-id',
  ownerSessionRef: ownerSession, messages: ids.map(message) });

async function queuedOwner() {
  const f = harness(); f.setBusy(true);
  await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  f.setSource(ownerFeed(['010'])); await f.pollOnce();
  return f;
}

test('reload recognizes queued wake and retains later IDs until the real queue drains', async () => {
  const first = await queuedOwner(), f = harness({ values: first.values, storage: first.storage });
  f.setBusy(true); f.setQueue(first.queue()); f.setSource(ownerFeed(['010', '020', '030']));
  await f.pollOnce(); await f.pollOnce();
  assert.equal(f.sends.length, 0); assert.equal((await f.rpc.wakeStatus()).lastMessageId, '010');
  f.setQueue([]); await f.pollOnce();
  assert.equal(f.sends.length, 1); assert.match(f.sends[0].input[0].text, /020/); assert.match(f.sends[0].input[0].text, /030/);
});

test('legacy queued wakes block growth without deleting or rewriting the existing rows', async () => {
  const f = await queuedOwner();
  const legacy = f.queue()[0];
  legacy.content[0].text = legacy.content[0].text.replace('Read ALL accumulated canonical mailbox messages', 'Read these messages');
  const rows = Array.from({ length: 6 }, () => structuredClone(legacy));
  f.setQueue(rows); f.setSource(ownerFeed(['010', '020'])); await f.pollOnce(); await f.pollOnce();
  assert.equal(f.sends.length, 1); assert.deepEqual(f.queue(), rows);
  f.setQueue([]); await f.pollOnce(); assert.equal(f.sends.length, 2); assert.match(f.sends[1].input[0].text, /020/);
});

test('human, other plugin, task substring and mismatched binding markers cannot suppress a wake', async () => {
  const seed = await queuedOwner(), own = seed.queue()[0];
  const foreignBinding = harness();
  await foreignBinding.rpc.bindOwner({ taskId, threadId: 'thr_other', enabled: true });
  foreignBinding.setSource(ownerFeed(['010'])); await foreignBinding.pollOnce();
  const variants = [
    { ...own, origin: 'app', originPluginId: null },
    { ...own, origin: 'plugin', originPluginId: 'other-plugin' },
    { ...own, content: [input(own.content[0].text.replace(`Task: ${taskId}`, `Task: ${taskId}-other`))] },
    { ...own, content: foreignBinding.sends[0].input },
    { ...own, content: [input(own.content[0].text + ' extra')] },
  ];
  for (const row of variants) {
    const f = harness(); await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
    f.setQueue([row]); f.setSource(ownerFeed(['020'])); await f.pollOnce();
    assert.equal(f.sends.length, 1, JSON.stringify(row)); assert.deepEqual(f.queue(), [row]);
  }
});

test('queue lookup failure preserves unseen IDs and recovers without a blind send', async () => {
  const f = harness(); await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
  f.setSource(ownerFeed(['010'])); f.setQueueError(new Error('queue unavailable')); await f.pollOnce();
  assert.equal(f.sends.length, 0); assert.equal((await f.rpc.wakeStatus()).state, 'paused');
  assert.equal((await f.rpc.wakeStatus()).lastMessageId, null);
  f.setQueueError(null); await f.pollOnce(); assert.equal(f.sends.length, 1);
});

test('dispatch after the queue snapshot delays one tick without dropping later IDs', async () => {
  const f = await queuedOwner(); f.setSource(ownerFeed(['010', '020']));
  f.afterQueueRead(async () => { f.setQueue([]); });
  await f.pollOnce(); assert.equal(f.sends.length, 1); assert.equal(f.queue().length, 0);
  f.afterQueueRead(null); await f.pollOnce();
  assert.equal(f.sends.length, 2); assert.match(f.sends[1].input[0].text, /020/); assert.equal(f.queue().length, 1);
});

test('disable or rebind during queue lookup invalidates admission before send', async () => {
  for (const patch of [{ wakeEnabled: false }, { ownerThreadId: 'thr_other' }]) {
    const f = harness(); await f.rpc.bindOwner({ taskId, threadId: ownerThreadId, enabled: true });
    f.setSource(ownerFeed(['010']));
    f.afterQueueRead(async () => { f.changeSettings(patch); }); await f.pollOnce();
    assert.equal(f.sends.length, 0);
    f.afterQueueRead(null); f.changeSettings({ wakeEnabled: true, ownerThreadId }); await f.pollOnce();
    assert.equal(f.sends.length, 1); assert.match(f.sends[0].input[0].text, /010/);
  }
});


test('exhausted own wake pauses visibly even without new IDs and never replays it', async () => {
  const f = await queuedOwner(), row = { ...f.queue()[0], state: 'failed_exhausted' };
  f.setQueue([row]); await f.pollOnce();
  assert.equal((await f.rpc.wakeStatus()).state, 'paused');
  assert.match((await f.rpc.wakeStatus()).error!, /exhausted delivery attempts/);
  f.setSource(ownerFeed(['010', '020'])); await f.pollOnce();
  assert.equal(f.sends.length, 1); assert.deepEqual(f.queue(), [row]);
  f.setQueue([]); await f.pollOnce(); assert.equal(f.sends.length, 2);
  assert.match(f.sends[1].input[0].text, /020/);
});

for (const state of ['queued', 'waiting', 'scheduled', 'claimed', 'failed_retrying'])
  test(`own wake in ${state} state blocks another pending wake`, async () => {
    const f = await queuedOwner(); f.setQueue([{ ...f.queue()[0], state }]);
    f.setSource(ownerFeed(['010', '020'])); await f.pollOnce();
    assert.equal(f.sends.length, 1);
    assert.equal((await f.rpc.wakeStatus()).error, null);
  });

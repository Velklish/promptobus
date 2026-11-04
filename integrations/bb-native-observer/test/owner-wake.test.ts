import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnerWake, type OwnerWakeBinding, type OwnerWakeMessage, type OwnerWakeSource } from '../owner-wake.js';

const binding: OwnerWakeBinding = { hostId: 'host_test', storeRoot: '/store', taskId: 'task-one',
  ownerThreadId: 'thr_test', ownerParticipantId: 'owner-id', ownerSessionRef: 'actual-provider-session' };
const message = (id: string, change: Partial<OwnerWakeMessage> = {}): OwnerWakeMessage =>
  ({ id, type: 'result', sender: 'worker-id', recipients: ['owner-id'], ...change });
const source = (messages: OwnerWakeMessage[], change: Partial<OwnerWakeSource> = {}): OwnerWakeSource =>
  ({ taskId: binding.taskId, state: 'active', ownerParticipantId: binding.ownerParticipantId,
    ownerSessionRef: binding.ownerSessionRef, messages, ...change });

function fixture() {
  const values = new Map<string, unknown>(), sends: { threadId: string; text: string }[] = [], markers = new Set<string>();
  let refuse = false, reply: 'ok' | 'throw' | 'false' = 'ok', checks = 0;
  const deps = {
    storage: { async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
      async set(key: string, value: unknown) { values.set(key, structuredClone(value)); } },
    async assertDestination() { checks++; if (refuse) throw new Error('foreign BB destination'); },
    async send(input: { threadId: string; text: string }) {
      sends.push(input);
      if (reply === 'throw') throw new Error('connection lost after request');
      return { ok: reply === 'ok' };
    },
    async hasQueuedWake() { return false; },
    async containsMarker(_binding: OwnerWakeBinding, marker: string) { return markers.has(marker); },
  };
  return { values, sends, markers, deps, wake: createOwnerWake(deps),
    refuse: () => { refuse = true; }, reply: (value: typeof reply) => { reply = value; }, checks: () => checks };
}

test('enabling baselines existing messages and batches only subsequent actionable owner messages', async () => {
  const f = fixture(), old = message('010');
  assert.equal((await f.wake.tick(binding, source([old]))).state, 'watching');
  assert.equal(f.sends.length, 0);
  const fresh = [message('020'), message('030', { type: 'question' }), message('040', { type: 'review' }), message('050', { type: 'error' })];
  assert.equal((await f.wake.tick(binding, source([old, ...fresh]))).state, 'delivered');
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].threadId, binding.ownerThreadId);
  for (const next of fresh) assert.ok(f.sends[0].text.includes(next.id));
  assert.ok(!f.sends[0].text.includes('010'));
  assert.ok(f.sends[0].text.includes('not a human instruction or permission grant'));
  assert.equal((await f.wake.tick(binding, source([old, ...fresh]))).state, 'watching');
  assert.equal(f.sends.length, 1);
});

test('ordinary status, self reports and foreign recipients never wake the owner', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  await f.wake.tick(binding, source([message('010', { type: 'status' }), message('020', { sender: 'owner-id' }),
    message('030', { sender: 'orchestrator' }), message('040', { recipients: ['other-owner'] })]));
  assert.equal(f.sends.length, 0);
});

test('persistent message identities prevent replay after reload and admit late older IDs', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  await f.wake.tick(binding, source([message('030')]));
  const reloaded = createOwnerWake(f.deps);
  await reloaded.tick(binding, source([message('030'), message('010')]));
  assert.equal(f.sends.length, 2);
  assert.ok(f.sends[1].text.includes('010'));
  await reloaded.tick(binding, source([message('010'), message('030'), message('010')]));
  assert.equal(f.sends.length, 2);
});

test('binding property order does not create a new delivery stream', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  await f.wake.tick(binding, source([message('010')]));
  const reordered = Object.fromEntries(Object.entries(binding).reverse()) as unknown as OwnerWakeBinding;
  await f.wake.tick(reordered, source([message('010'), message('020')]));
  assert.equal(f.sends.length, 2);
  assert.ok(f.sends[1].text.includes('020'));
  assert.ok(!f.sends[1].text.includes('010'));
});

test('another task or owner generation refuses before sending', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  for (const change of [{ taskId: 'other' }, { ownerParticipantId: 'other' }, { ownerSessionRef: 'new-generation' }])
    await assert.rejects(f.wake.tick(binding, source([message('010')], change)), /Canonical task owner/);
  assert.equal(f.sends.length, 0);
});

test('new binding gets its own baseline, while a completed task never sends', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  const next = { ...binding, ownerThreadId: 'thr_other' };
  await f.wake.tick(next, source([message('010')]));
  await f.wake.tick(next, source([message('010'), message('020')], { state: 'done' }));
  assert.equal(f.sends.length, 0);
});

test('fresh destination validation refuses a stale or foreign BB owner', async () => {
  const f = fixture(); await f.wake.tick(binding, source([])); f.refuse();
  await assert.rejects(f.wake.tick(binding, source([message('010')])), /foreign BB destination/);
  assert.equal(f.sends.length, 0);
});

test('destination loss during durable intent is known unsent and does not strand a pending notification', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  let checks = 0;
  f.deps.assertDestination = async () => { if (++checks === 2) throw new Error('destination changed'); };
  await assert.rejects(f.wake.tick(binding, source([message('010')])), /destination changed/);
  assert.equal(f.sends.length, 0);
  assert.equal((await f.wake.status(binding)).state, 'watching');
  f.deps.assertDestination = async () => {};
  assert.equal((await f.wake.tick(binding, source([message('010')]))).state, 'delivered');
  assert.equal(f.sends.length, 1);
});

test('ambiguous send is durable and never replayed without actual marker evidence', async () => {
  const f = fixture(); await f.wake.tick(binding, source([])); f.reply('throw');
  assert.equal((await f.wake.tick(binding, source([message('010')]))).state, 'unconfirmed');
  const reloaded = createOwnerWake(f.deps);
  assert.equal((await reloaded.status(binding)).state, 'unconfirmed');
  assert.equal((await reloaded.tick(binding, source([message('010')]))).state, 'unconfirmed');
  assert.equal(f.sends.length, 1);
  assert.equal((await reloaded.tick(binding, source([message('010')], { state: 'done' }))).state, 'unconfirmed');
  const marker = f.sends[0].text.split('\n').at(-1)!; f.markers.add(marker);
  assert.equal((await reloaded.tick(binding, source([message('010')]))).state, 'delivered');
  assert.equal(f.sends.length, 1);
  assert.equal((await reloaded.status(binding)).lastMessageId, '010');
});

test('an explicit non-ok receipt is not marked delivered or blindly retried', async () => {
  const f = fixture(); await f.wake.tick(binding, source([])); f.reply('false');
  assert.equal((await f.wake.tick(binding, source([message('010')]))).state, 'unconfirmed');
  await f.wake.tick(binding, source([message('010')]));
  assert.equal(f.sends.length, 1);
  assert.equal((await f.wake.status(binding)).lastMessageId, null);
});

test('crash after accepted send reconciles the persisted intent instead of sending twice', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  const set = f.deps.storage.set; let saves = 0;
  f.deps.storage.set = async (key, value) => { if (++saves === 2) throw new Error('persistence unavailable'); await set(key, value); };
  await assert.rejects(f.wake.tick(binding, source([message('010')])), /persistence unavailable/);
  assert.equal(f.sends.length, 1);
  f.deps.storage.set = set; f.markers.add(f.sends[0].text.split('\n').at(-1)!);
  const reload = createOwnerWake(f.deps);
  assert.equal((await reload.tick(binding, source([message('010')]))).state, 'delivered');
  assert.equal(f.sends.length, 1);
});

test('failed durable intent refuses before the public send', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  f.deps.storage.set = async () => { throw new Error('state unavailable'); };
  await assert.rejects(f.wake.tick(binding, source([message('010')])), /state unavailable/);
  assert.equal(f.sends.length, 0);
});

test('marker lookup failure never retries an unconfirmed send', async () => {
  const f = fixture(); await f.wake.tick(binding, source([])); f.reply('throw');
  await f.wake.tick(binding, source([message('010')]));
  f.deps.containsMarker = async () => { throw new Error('timeline unavailable'); };
  await assert.rejects(f.wake.tick(binding, source([message('010')])), /timeline unavailable/);
  assert.equal(f.sends.length, 1);
});

test('source cap refuses before sending and batches retain later actionable messages', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  await assert.rejects(f.wake.tick(binding, source(Array.from({ length: 4097 }, (_, i) => message(String(i))))), /4096/);
  const messages = Array.from({ length: 33 }, (_, i) => message(String(i).padStart(3, '0')));
  await f.wake.tick(binding, source(messages)); await f.wake.tick(binding, source(messages));
  assert.equal(f.sends.length, 2);
  assert.ok(!f.sends[0].text.includes('032'));
  assert.ok(f.sends[1].text.includes('032'));
});

test('overlapping polls share one in-flight delivery', async () => {
  const f = fixture(); await f.wake.tick(binding, source([]));
  let release: (value: { ok: boolean }) => void = () => {};
  f.deps.send = async input => { f.sends.push(input); return new Promise(resolve => { release = resolve; }); };
  const wake = createOwnerWake(f.deps), first = wake.tick(binding, source([message('010')]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await wake.tick(binding, source([message('010')]))).state, 'busy');
  release({ ok: true }); await first;
  assert.equal(f.sends.length, 1);
});

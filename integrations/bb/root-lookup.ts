import path from 'node:path';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { bindingStore } from './bindings.js';

interface RootLookupInput {
  root: string; home: string; nativeThreadId: string; hostId: string; signal?: AbortSignal;
  resolveOwnerScope(executionPath: string): Promise<{ root: string; home: string }>;
}

export async function lookupBbRoot(bb: BbPluginApi, store: ReturnType<typeof bindingStore>, input: RootLookupInput) {
  const { root, home, nativeThreadId, hostId, signal } = input;
  if (!path.isAbsolute(root) || path.resolve(root) !== root || !/^\S+$/u.test(nativeThreadId)) throw new Error('Root lookup requires a canonical workspace and exact native identity');
  const bindings = store.list();
  for (const binding of bindings) {
    const intent = store.launchIntent(binding);
    if (binding.hostId === hostId && binding.root === root && !binding.threadId && intent
      && (intent.status === 'requested' || intent.status === 'unknown')) throw new Error('Unresolved legacy managed launch blocks root lookup');
  }
  const latestIdentity = async (threadId: string) => {
    const events = await bb.sdk.threads.events.list({ threadId, types: ['thread/identity'], order: 'desc', limit: '1', signal });
    const latest = events[0];
    if (events.length !== 1 || !latest || latest.type !== 'thread/identity' || latest.threadId !== threadId
      || latest.scope.kind !== 'thread' || !Number.isSafeInteger(latest.seq)
      || typeof latest.data.providerThreadId !== 'string' || !/^\S+$/u.test(latest.data.providerThreadId)) {
      throw new Error('BB latest native identity is incomplete');
    }
    return { nativeId: latest.data.providerThreadId, seq: latest.seq };
  };
  const scan = async () => {
    const inventory = new Map<string, { environmentId: string | null; nativeId: string | null; seq: number | null }>();
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 200) {
        signal?.throwIfAborted();
        const threads = await bb.sdk.threads.list({ hostId, archived, includeHidden: true, offset, limit: 200, signal });
        for (const thread of threads) {
          if (thread.providerId !== 'codex') continue;
          if (inventory.has(thread.id)) throw new Error('BB thread inventory changed during root lookup');
          inventory.set(thread.id, { environmentId: thread.environmentId, ...await latestIdentity(thread.id) });
        }
        if (threads.length < 200) break;
      }
    }
    return inventory;
  };
  const first = await scan(), second = await scan();
  const normalized = (values: typeof first) => JSON.stringify([...values].sort(([left], [right]) => left.localeCompare(right)));
  if (normalized(first) !== normalized(second)) throw new Error('BB native identity inventory changed during root lookup');
  const matches = [...second].filter(([, value]) => value.nativeId === nativeThreadId);
  if (matches.length !== 1) throw new Error('Root requires one complete unique latest BB native identity');
  const [bbThreadId, match] = matches[0]!;
  if (bindings.some(binding => binding.threadId === bbThreadId)) throw new Error('Managed BB thread is excluded from root lookup in every phase');
  if (!match.environmentId) throw new Error('BB native root has no canonical workspace');
  const environment = await bb.sdk.environments.get({ environmentId: match.environmentId, signal });
  if (environment.hostId !== hostId) throw new Error('BB native root belongs to another host');
  if (!environment.path || !path.isAbsolute(environment.path)) throw new Error('BB native root has no absolute execution path');
  const owner = await input.resolveOwnerScope(environment.path);
  if (owner.root !== root || owner.home !== home) throw new Error('BB native root belongs to another canonical workspace or store');
  const current = await bb.sdk.threads.get({ threadId: bbThreadId, signal });
  if (current.id !== bbThreadId || current.providerId !== 'codex' || current.environmentId !== match.environmentId
    || current.archivedAt !== null || current.deletedAt !== null) throw new Error('BB native root changed or is no longer available');
  const latest = await latestIdentity(bbThreadId);
  if (latest.nativeId !== nativeThreadId || latest.seq !== match.seq) throw new Error('BB native generation changed during root lookup');
  signal?.throwIfAborted();
  return { complete: true as const, eligibility: 'eligible' as const, bbThreadId };
}

import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { SessionView } from 'promptobus';
import type { Binding } from './protocol.js';

type Thread = Awaited<ReturnType<BbPluginApi['sdk']['threads']['get']>>;
type Environment = Awaited<ReturnType<BbPluginApi['sdk']['environments']['get']>>;
type Host = Awaited<ReturnType<BbPluginApi['sdk']['hosts']['get']>>;
export interface BbObservation { view: SessionView; status: string; thread?: Thread; environment?: Environment; host?: Host }
const unknown = (b: Binding, note: string): BbObservation => ({ status: note,
  view: { state: 'unknown', busy: false, stall: null, id: b.threadId, note } });

export async function observeBbParticipant(bb: BbPluginApi, b: Binding, signal?: AbortSignal): Promise<BbObservation> {
  if (!b.threadId) return unknown(b, 'BB unbound');
  let observed: Thread | undefined;
  try {
    const thread = await bb.sdk.threads.get({ threadId: b.threadId, signal });
    if (thread.id !== b.threadId || thread.projectId !== b.projectId || thread.environmentId !== b.environmentId
      || thread.providerId !== b.providerId || thread.parentThreadId !== (b.parentThreadId ?? null)
      || thread.lifecycleOwnerThreadId !== (b.lifecycleOwnerThreadId ?? null)) return unknown(b, 'BB binding mismatch');
    observed = thread;
    const [environment, host] = await Promise.all([
      bb.sdk.environments.get({ environmentId: b.environmentId, signal }), bb.sdk.hosts.get({ hostId: b.hostId, signal }),
    ]);
    if (environment.id !== b.environmentId || environment.hostId !== b.hostId || environment.path !== b.environmentPath
      || host.id !== b.hostId || host.status !== 'connected' || host.lifecycle.phase !== 'active'
      || environment.status !== 'ready' || environment.lifecycle.phase !== 'active') return {
        ...unknown(b, 'BB unavailable'), status: thread.runtime.displayStatus, thread, environment, host };
    const status = thread.runtime.displayStatus;
    const view: SessionView = { state: thread.deletedAt !== null ? 'gone' : thread.archivedAt !== null ? 'stale'
      : status === 'active' || status === 'idle' || status === 'starting' ? 'alive' : 'unknown',
    busy: status === 'active' || status === 'starting', stall: null, id: b.threadId, note: `BB ${status}` };
    return { view, status, thread, environment, host };
  } catch (error) { return { ...unknown(b, `BB unknown: ${(error as Error).message}`),
    ...(observed ? { status: observed.runtime.displayStatus, thread: observed } : {}) }; }
}

export async function stopBbParticipant(bb: BbPluginApi, b: Binding) {
  const before = await observeBbParticipant(bb, b);
  if (!before.thread) throw new Error(before.view.note ?? 'BB participant observation unavailable');
  await bb.sdk.threads.stop({ threadId: b.threadId! });
  const observation = await observeBbParticipant(bb, b);
  const confirmed = observation.view.state === 'alive' && observation.status === 'idle' && observation.thread?.status === 'idle'
    && observation.thread.activeBackgroundAgentCount === 0 && observation.thread.queuedMessageCount === 0;
  return { confirmed, observation };
}

export async function captureBbWorkspace(bb: BbPluginApi, b: Binding, signal?: AbortSignal, excludeCanonicalStore = false) {
  if (!b.baseSha) throw new Error('No recorded base SHA; leave the environment in place');
  const read = async () => {
    const status = await bb.sdk.environments.status({ environmentId: b.environmentId, mergeBaseBranch: b.baseSha!, signal });
    if (status.outcome !== 'available' || !status.workspace.mergeBase) throw new Error('Workspace snapshot is unavailable');
    if (status.workspace.mergeBase.baseRef !== b.baseSha || status.workspace.mergeBase.behindCount !== 0) throw new Error('Workspace diverged from the recorded base; leave the environment in place');
    const checkout = status.workspace.checkout;
    if (checkout.kind !== 'branch' && checkout.kind !== 'detached') throw new Error('Workspace HEAD is unavailable');
    const paths = [...new Set([...status.workspace.mergeBase.files, ...status.workspace.workingTree.files].map(file => file.path))]
      .filter(file => !excludeCanonicalStore || (file !== '.promptobus' && !file.startsWith('.promptobus/'))).sort();
    const diff = paths.length ? await bb.sdk.environments.diffPatch({ environmentId: b.environmentId, paths,
      target: { type: 'all', mergeBaseBranch: b.baseSha! }, signal }) : { outcome: 'available' as const, patches: [] };
    if (diff.outcome !== 'available' || diff.patches.length !== paths.length
      || diff.patches.some(p => p.truncated || !paths.includes(p.path) || !p.patch.trim()
        || /^Binary files |^[+-]Subproject commit|^Submodule /m.test(p.patch))
      || new Set(diff.patches.map(p => p.path)).size !== paths.length) throw new Error('Incomplete patch; leave the environment in place');
    return { baseSha: b.baseSha, headSha: checkout.headSha, branch: status.workspace.branch.currentBranch,
      patches: [...diff.patches].sort((a, c) => a.path.localeCompare(c.path)) };
  };
  const first = await read();
  if (JSON.stringify(first) !== JSON.stringify(await read())) throw new Error('Workspace changed during preservation; leave it in place');
  return { ...first, environmentId: b.environmentId, environmentPath: b.environmentPath, hostId: b.hostId, threadId: b.threadId };
}

export async function recordBbWorkspace(bb: BbPluginApi, b: Binding, signal?: AbortSignal, expectedPath?: string) {
  const environment = await bb.sdk.environments.get({ environmentId: b.environmentId, signal });
  if (environment.id !== b.environmentId || environment.projectId !== b.projectId || environment.hostId !== b.hostId || !environment.path
    || environment.status !== 'ready' || environment.lifecycle.phase !== 'active') throw new Error('BB environment is not ready');
  if (expectedPath && environment.path !== expectedPath) throw new Error('BB environment path binding mismatch');
  const status = await bb.sdk.environments.status({ environmentId: b.environmentId, signal });
  if (status.outcome !== 'available' || (status.workspace.checkout.kind !== 'branch' && status.workspace.checkout.kind !== 'detached')
    || !status.workspace.checkout.headSha) throw new Error('A Git environment with an actual HEAD is required');
  b.environmentPath = environment.path; b.branch = status.workspace.branch.currentBranch; b.baseSha = status.workspace.checkout.headSha;
  return environment;
}

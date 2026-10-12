import fs from 'node:fs';
import path from 'node:path';
import type { BbPluginApi, PluginAgentConfigurationContext } from '@get-bb/plugin-sdk';
import type { bindingStore } from './bindings.js';

const TASK = 'backlogs-t20261012-1840';
const PROJECT = 'proj_gdmr94qxzs';
const HOST = 'host_xj49wfq3ap';
const ACTORS: Record<string, string> = { bridgecu2: 'acp-cursor', bridgego2: 'acp-opencode' };
const RECORD_ROOT = '/Users/kim.p/.bb/thread-storage/thr_sp4g9f2jit/main-run/bridge-records';

export function registerBridgeDiagnostics(bb: BbPluginApi, store: ReturnType<typeof bindingStore>) {
  const scoped = (id: string) => {
    const b = store.thread(id);
    return b && b.threadId === id && /^[A-Za-z0-9_-]+$/.test(id) && b.task === TASK
      && b.projectId === PROJECT && b.hostId === HOST && ACTORS[b.participant] === b.providerId ? b : undefined;
  };
  for (const provider of ['acp-cursor', 'acp-opencode']) bb.providers.experimental_contributeEnv(provider, async context => {
    const b = scoped(context.threadId);
    if (!b || b.providerId !== provider || context.projectId !== b.projectId || context.hostId !== b.hostId
      || !['pending', 'provisioning', 'ready'].includes(b.phase)) return [];
    try {
      if ((await bb.sdk.system.config()).primaryHostId !== b.hostId) return [];
      const thread = await bb.sdk.threads.get({ threadId: b.threadId! });
      if (thread.id !== b.threadId || thread.projectId !== b.projectId || thread.providerId !== provider
        || thread.archivedAt !== null || thread.deletedAt !== null) return [];
      const current = scoped(context.threadId);
      if (!current || current.providerId !== provider || !['pending', 'provisioning', 'ready'].includes(current.phase)) return [];
      const directory = path.join(RECORD_ROOT, context.threadId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) return [];
      fs.chmodSync(directory, 0o700);
      return [{ name: 'BB_PROVIDER_BRIDGE_RECORD_DIR', value: directory, reason: 'Temporary scoped bridge diagnostic recording' }];
    } catch {
      bb.log.warn(`Promptobus bridge diagnostic recording refused for thread ${context.threadId}`);
      return [];
    }
  });
  return (context: PluginAgentConfigurationContext, selectedNames: string[]) => {
    const b = scoped(context.thread.id);
    if (!b) return;
    const matches = { phase: b.phase === 'ready', project: b.projectId === context.project.id,
      environment: b.environmentId === context.environment.id, path: b.environmentPath === context.environment.path,
      host: b.hostId === context.host.id, provider: b.providerId === context.provider.id };
    bb.log.info(`Promptobus bridge configuration ${JSON.stringify({ thread: context.thread.id, project: context.project.id,
      environment: context.environment.id, host: context.host.id, provider: context.provider.id, phase: b.phase,
      matches, mismatches: Object.entries(matches).filter(([, match]) => !match).map(([field]) => field),
      selectedNames, selectedCount: selectedNames.length })}`);
  };
}

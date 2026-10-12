import fs from 'node:fs';
import path from 'node:path';
import type { BbPluginApi, PluginAgentConfigurationContext } from '@get-bb/plugin-sdk';
import type { bindingStore } from './bindings.js';
import { prepareWireWrapper } from './bridge-wire-wrapper.js';

const TASK = 'backlogs-t20261012-1840';
const PROJECT = 'proj_gdmr94qxzs';
const HOST = 'host_xj49wfq3ap';
const RECORD_ROOT = '/Users/kim.p/.bb/thread-storage/thr_sp4g9f2jit/main-run/bridge-records';
const PROBES: Record<string, { thread: string; environment: string; provider: string; command: string; real: string }> = {
  bridgecu2: { thread: 'thr_z65cxgddx9', environment: 'env_ceqdnicad9', provider: 'acp-cursor', command: 'cursor-agent',
    real: '/Users/kim.p/.local/share/cursor-agent/versions/2026.09.26-dd393fe/cursor-agent' },
  bridgego2: { thread: 'thr_qv38kd3qbw', environment: 'env_fx6a8fifuz', provider: 'acp-opencode', command: 'opencode',
    real: '/opt/homebrew/Cellar/opencode/2.0.20/bin/opencode' },
};
const NODE = '/opt/homebrew/Cellar/node/25.2.1/bin/node';

export function registerBridgeDiagnostics(bb: BbPluginApi, store: ReturnType<typeof bindingStore>) {
  const scoped = (id: string) => {
    const b = store.thread(id);
    const probe = b && PROBES[b.participant];
    return b && b.threadId === id && /^[A-Za-z0-9_-]+$/.test(id) && b.task === TASK
      && b.projectId === PROJECT && b.hostId === HOST && probe?.provider === b.providerId
      && probe.thread === id && probe.environment === b.environmentId ? b : undefined;
  };
  for (const provider of ['acp-cursor', 'acp-opencode']) bb.providers.experimental_contributeEnv(provider, async context => {
    const b = scoped(context.threadId);
    const probe = b && PROBES[b.participant];
    if (!b || b.providerId !== provider || context.projectId !== b.projectId || context.hostId !== b.hostId
      || !probe || b.threadId !== probe.thread || b.environmentId !== probe.environment
      || !['pending', 'provisioning', 'ready'].includes(b.phase)) return [];
    try {
      if ((await bb.sdk.system.config()).primaryHostId !== b.hostId) return [];
      const thread = await bb.sdk.threads.get({ threadId: b.threadId! });
      if (thread.id !== b.threadId || thread.projectId !== b.projectId || thread.providerId !== provider
        || thread.environmentId !== probe.environment || thread.archivedAt !== null || thread.deletedAt !== null) return [];
      const current = scoped(context.threadId);
      if (!current || current.providerId !== provider || current.environmentId !== probe.environment
        || !['pending', 'provisioning', 'ready'].includes(current.phase)) return [];
      const directory = path.join(RECORD_ROOT, context.threadId);
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) return [];
      fs.chmodSync(directory, 0o700);
      const baseline = path.join(directory, 'original-path.txt');
      const stat = fs.lstatSync(baseline);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) return [];
      const originalPath = fs.readFileSync(baseline, 'utf8');
      if (!originalPath || /[\r\n\0]/.test(originalPath) || originalPath.split(path.delimiter).includes(path.join(directory, 'bin'))) return [];
      fs.accessSync(NODE, fs.constants.X_OK);
      fs.accessSync(probe.real, fs.constants.X_OK);
      const bin = prepareWireWrapper(directory, probe.command, probe.real, NODE);
      return [{ name: 'PATH', value: `${bin}${path.delimiter}${originalPath}`, reason: 'Temporary scoped ACP wire capture' }];
    } catch {
      bb.log.warn(`Promptobus ACP wire capture refused for thread ${context.threadId}`);
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

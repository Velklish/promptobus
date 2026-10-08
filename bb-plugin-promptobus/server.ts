import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { BB_REVIEWER_TOOLS, REVIEW_FILE_TOOLS } from 'promptobus/bb-reviewer';
import { hostContract } from './contract.js';

export const REVIEWER_PROVIDER = 'promptobus-codex-reviewer';

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  bb.providers.register({
    id: REVIEWER_PROVIDER, displayName: 'Codex (Promptobus read-only reviewer)', family: 'codex',
    strings: { signInHint: 'Run codex to sign in.', expiredHint: 'Run codex, then retry.', installUrl: 'https://developers.openai.com/codex/cli' },
    capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: 'none',
      supportsManualCompaction: false, supportsThreadArchive: false, supportsThreadRename: false,
      permissionModes: ['accept-edits'], reasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
    composerActions: [], models: { fallback: [], scope: 'host' },
  });
  for (const tool of REVIEW_FILE_TOOLS) {
    bb.agents.registerTool({
      name: `pb_review_${tool.name}`, description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
      async execute(args, context) {
        const thread = await bb.sdk.threads.get({ threadId: context.threadId, signal: context.signal });
        if (thread.providerId !== REVIEWER_PROVIDER || thread.projectId !== context.projectId || !thread.environmentId) {
          throw new Error('Read-only reviewer tool requires its authenticated BB thread');
        }
        const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal: context.signal });
        const local = (await bb.sdk.system.config()).primaryHostId;
        if (!environment.path || !local || environment.hostId !== local) throw new Error('Reviewer requires a local coordinator environment');
        const result = await host.call('read', { root: environment.path, name: tool.name, args: args as Record<string, unknown> },
          { hostId: local, signal: context.signal });
        return JSON.stringify(result);
      },
    });
  }
  bb.agents.configure(context => context.provider.id === REVIEWER_PROVIDER
    ? { tools: BB_REVIEWER_TOOLS, skills: [], instructions: 'Read code through pb_review_read_file, pb_review_read_files, pb_review_list_files and pb_review_search_text. This provider mechanically denies shell, edits and all unclassified external tools.' }
    : { tools: [], skills: [] });
}

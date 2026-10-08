import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { createStandaloneHost } from 'promptobus/host';
import { createBbHostIntegration } from 'promptobus/bb-host';
import type { BbHostIntegration } from 'promptobus/bb-host';
import { reviewerFiles } from 'promptobus/bb-reviewer';
import { hostContract } from './contract.js';
import { engineOperation } from './engine-host.js';

export function createHostEntry(integration: BbHostIntegration = createBbHostIntegration({ resolveHost: root => createStandaloneHost({ cwd: root }) })) {
  return experimental_defineHostEntry({ contract: hostContract, handlers: {
    read: async ({ root, name, args }) => reviewerFiles([root])(name, args),
    engine: async (input, context) => { context.signal.throwIfAborted(); return engineOperation(input); },
    prepareContext: async ({ binding: b }, context) => integration.prepare({ root: b.environmentPath, role: b.role, signal: context.signal }),
    hostContext: async ({ binding: b, args }, context) => {
      context.signal.throwIfAborted();
      await engineOperation({ binding: b, operation: 'check' });
      const input = { root: b.environmentPath, role: b.role, signal: context.signal };
      return args.mode === 'inspect' ? integration.collect(input) : integration.read({ ...input, ...args });
    },
    canonical: async ({ binding: b, args }, context) => {
      context.signal.throwIfAborted();
      await engineOperation({ binding: b, operation: 'check' });
      return integration.invoke({ root: b.environmentPath, role: b.role, ...args,
        actor: { task: b.task, participant: b.participant }, signal: context.signal });
    },
  } });
}

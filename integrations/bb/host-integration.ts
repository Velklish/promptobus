import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { createStandaloneHost } from 'promptobus/host';
import { createBbHostIntegration } from 'promptobus/bb-host';
import type { BbHostIntegration } from 'promptobus/bb-host';
import type { Binding } from './protocol.js';
import { reviewerFiles } from 'promptobus/bb-reviewer';
import { hostContract } from './contract.js';
import { BUILD_IDENTITY } from './build-identity.js';
import { engineOperation } from './engine-host.js';
import { readCurrentControl, publishControl } from './control.js';

function participantTask(b: Binding) {
  if (b.contextDeclaration && !b.contextPurpose) throw new Error('Explicit task context requires an explicit purpose');
  return b.contextPurpose ? { task: { id: b.task, purpose: b.contextPurpose, ...(b.contextDeclaration ? { context: b.contextDeclaration } : {}) } } : {};
}

export function createHostEntry(integration: BbHostIntegration = createBbHostIntegration({ resolveHost: root => createStandaloneHost({ cwd: root }) })) {
  return experimental_defineHostEntry({ contract: hostContract, handlers: {
    runtimeDescribe: async (_input, context) => {
      context.signal.throwIfAborted();
      return { identity: BUILD_IDENTITY };
    },
    launchControl: async ({ binding, predecessor }, context) => {
      context.signal.throwIfAborted();
      return readCurrentControl(binding, predecessor);
    },
    controlPublish: async ({ publication, initialize, expectedRevision, binding, denyOnly = true }, context) => {
      context.signal.throwIfAborted();
      return publishControl(publication, { initialize, expectedRevision, binding, denyOnly });
    },
    read: async ({ root, name, args }) => reviewerFiles([root])(name, args),
    engine: async (input, context) => {
      context.signal.throwIfAborted();
      const result = await engineOperation(input);
      if (input.operation === 'step') await integration.checkStep({ ...result as Parameters<BbHostIntegration['checkStep']>[0], signal: context.signal });
      return result;
    },
    prepareContext: async ({ binding: b }, context) => integration.prepare({ root: b.environmentPath, role: b.role,
      ...participantTask(b), signal: context.signal }),
    hostContext: async ({ binding: b, args }, context) => {
      context.signal.throwIfAborted();
      await engineOperation({ binding: b, operation: 'check' });
      const input = { root: b.environmentPath, role: b.role, preparedContext: b.hostContext,
        ...participantTask(b), signal: context.signal };
      return args.mode === 'inspect' ? integration.collect(input) : integration.read({ ...input, ...args });
    },
    canonical: async ({ binding: b, args }, context) => {
      context.signal.throwIfAborted();
      await engineOperation({ binding: b, operation: 'check' });
      return integration.invoke({ root: b.environmentPath, role: b.role, ...args, preparedContext: b.hostContext,
        ...participantTask(b),
        actor: { task: b.task, participant: b.participant }, signal: context.signal });
    },
  } });
}

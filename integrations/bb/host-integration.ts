import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { createStandaloneHost } from 'promptobus/host';
import { createBbHostIntegration } from 'promptobus/bb-host';
import type { BbHostIntegration } from 'promptobus/bb-host';
import { reviewerFiles } from 'promptobus/bb-reviewer';
import { hostContract } from './contract.js';
import { engineOperation } from './engine-host.js';
import { readDeclaredFile, validateControl } from './launch-context.js';

export function createHostEntry(integration: BbHostIntegration = createBbHostIntegration({ resolveHost: root => createStandaloneHost({ cwd: root }) })) {
  return experimental_defineHostEntry({ contract: hostContract, handlers: {
    launchControl: async ({ binding: b }, context) => {
      context.signal.throwIfAborted();
      const launch = b.launchContext;
      if (!launch) throw new Error('launch context is required');
      if (launch.control.mode === 'inline') return validateControl(launch, launch.control.snapshot);
      const current = JSON.parse(readDeclaredFile(launch.control.path, launch.readRoots, 1024 * 1024).toString('utf8'));
      const grant = current.grant ?? current.grants?.[b.participant];
      return validateControl(launch, { ownerConfirmed: current.ownerConfirmed, STOP: current.STOP, noNewStages: current.noNewStages,
        grant: grant && { actor: grant.actor, task: grant.task, token: grant.token, state: grant.state, phase: grant.phase ?? 'initial',
          scope: { repository: grant.scope?.repository, branch: grant.scope?.branch, base: grant.scope?.base, operations: grant.scope?.operations },
          preconditions: grant.preconditions },
        endedTokens: current.endedTokens ?? current.grantHistory?.map((g: { token: string }) => g.token) ?? [] });
    },
    read: async ({ root, name, args }) => reviewerFiles([root])(name, args),
    engine: async (input, context) => {
      context.signal.throwIfAborted();
      const result = await engineOperation(input);
      if (input.operation === 'step') await integration.checkStep({ ...result as Parameters<BbHostIntegration['checkStep']>[0], signal: context.signal });
      return result;
    },
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

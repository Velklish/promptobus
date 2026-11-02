import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { openEngine } from 'promptobus';
import { createStandaloneHost } from 'promptobus/host';
import { createBbHostIntegration, createBbManagedAdmission } from 'promptobus/bb-host';
import type { BbHostIntegration } from 'promptobus/bb-host';
import type { PromptobusHost } from 'promptobus';
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

export function createHostEntry(integration?: BbHostIntegration, resolveOwnerHost?: (root: string) => PromptobusHost | Promise<PromptobusHost>) {
  const standalone = (root: string) => createStandaloneHost({ cwd: root });
  const selected = integration ?? createBbHostIntegration({ resolveHost: standalone });
  const ownerResolver = resolveOwnerHost ?? (integration ? undefined : standalone);
  const admission = () => {
    if (!ownerResolver) throw new Error('A canonical owner Host resolver is required for BB root admission');
    return createBbManagedAdmission(ownerResolver);
  };
  return experimental_defineHostEntry({ contract: hostContract, handlers: {
    rootScope: async ({ root }, context) => {
      context.signal.throwIfAborted();
      return admission().scope(root);
    },
    rootLaunch: async (input, context) => {
      context.signal.throwIfAborted();
      return input.operation === 'begin' ? admission().begin(input.root, input.intent)
        : admission().complete(input.root, input.intent, input.threadId, input.ownerScope);
    },
    runtimeDescribe: async (_input, context) => {
      context.signal.throwIfAborted();
      return { identity: BUILD_IDENTITY };
    },
    messageOrderRebuild: async ({ root: suppliedRoot }, context) => {
      context.signal.throwIfAborted();
      if (!path.isAbsolute(suppliedRoot) || path.dirname(suppliedRoot) === suppliedRoot) throw new Error('Coordinator root must be bounded and absolute');
      const root = realpathSync(suppliedRoot), home = path.join(root, '.promptobus');
      if (path.resolve(suppliedRoot) !== root) throw new Error('Coordinator root must be its canonical local path');
      if (!lstatSync(home, { throwIfNoEntry: false })?.isDirectory() || realpathSync(home) !== home) throw new Error('Message-order rebuild requires an existing coordinator store without symlinks');
      const engine = openEngine({ root, recover: false, policy: () => ({ deny: true, reason: 'Maintenance cannot route messages' }) });
      return { root, home: engine.home, ...engine.rebuildMessageOrder(), identity: BUILD_IDENTITY };
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
      if (input.operation === 'step') await selected.checkStep({ ...result as Parameters<BbHostIntegration['checkStep']>[0], signal: context.signal });
      return result;
    },
    prepareContext: async ({ binding: b }, context) => selected.prepare({ root: b.environmentPath, role: b.role,
      ...participantTask(b), signal: context.signal }),
    hostContext: async ({ binding: b, args }, context) => {
      context.signal.throwIfAborted();
      await engineOperation({ binding: b, operation: 'check' });
      const input = { root: b.environmentPath, role: b.role, preparedContext: b.hostContext,
        ...participantTask(b), signal: context.signal };
      return args.mode === 'inspect' ? selected.collect(input) : selected.read({ ...input, ...args });
    },
    canonical: async ({ binding: b, args }, context) => {
      context.signal.throwIfAborted();
      await engineOperation({ binding: b, operation: 'check' });
      return selected.invoke({ root: b.environmentPath, role: b.role, ...args, preparedContext: b.hostContext,
        ...participantTask(b),
        actor: { task: b.task, participant: b.participant }, signal: context.signal });
    },
  } });
}

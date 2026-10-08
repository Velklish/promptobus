import { randomUUID } from 'node:crypto';
import { cliCommand, defineCli } from '@get-bb/plugin-sdk';
import type { BbPluginApi, PluginAgentConfigurationContext, PluginAgentToolContext } from '@get-bb/plugin-sdk';
import { createBbInstructionDelivery, BB_ROLE_SKILLS } from 'promptobus/instructions';
import { BB_REVIEWER_TOOLS } from 'promptobus/bb-reviewer';
import { ORCHESTRATOR, REVIEWER } from 'promptobus';
import { engineInput, hostContract } from './contract.js';
import { bindingStore } from './bindings.js';
import { artifactSchema, bindingSchema, emptySchema, mailboxSchema, roleSchema, sendSchema, toolsFor } from './protocol.js';
import type { Binding } from './protocol.js';

export const REVIEWER_PROVIDER = 'promptobus-codex-reviewer';

export function registerRuntime(bb: BbPluginApi) {
  const store = bindingStore(bb);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const onHost = async (binding: Binding, request: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await host.call('engine', engineInput.parse({ binding, ...request }), { hostId: binding.hostId, signal });
    bb.log.info(`Promptobus ${request.operation} host=${binding.hostId} task=${binding.task} participant=${binding.participant}`);
    return result;
  };
  const requireThread = async (b: Binding, signal?: AbortSignal) => {
    const thread = await bb.sdk.threads.get({ threadId: b.threadId!, signal });
    if (thread.id !== b.threadId || thread.projectId !== b.projectId || thread.environmentId !== b.environmentId
      || thread.providerId !== b.providerId) throw new Error('BB thread binding mismatch');
    const environment = await bb.sdk.environments.get({ environmentId: b.environmentId, signal });
    const local = (await bb.sdk.system.config()).primaryHostId;
    if (environment.hostId !== b.hostId || environment.path !== b.environmentPath || b.hostId !== local) throw new Error('BB environment binding mismatch');
  };
  const authorize = async (context: PluginAgentToolContext, tool: string) => {
    context.signal.throwIfAborted();
    const b = store.thread(context.threadId);
    if (!b || b.phase !== 'ready') throw new Error('Promptobus participant is not bound');
    if (b.projectId !== context.projectId) throw new Error('BB project binding mismatch');
    if (!toolsFor(b.role).includes(tool)) throw new Error('Tool is not available to this role');
    await requireThread(b, context.signal);
    context.signal.throwIfAborted();
    return b;
  };
  for (const [name, parameters, operation] of [
    ['promptobus_send', sendSchema, 'send'], ['promptobus_mailbox', mailboxSchema, 'mailbox'],
    ['promptobus_task', emptySchema, 'task'], ['promptobus_artifact', artifactSchema, 'artifact'],
  ] as const) {
    bb.agents.registerTool({ name, description: `Promptobus ${operation} for the authenticated participant. Identity is supplied by the runtime.`,
      parameters, async execute(args, context) {
        const binding = await authorize(context, name);
        return JSON.stringify(await onHost(binding, { operation, args }, context.signal));
      } });
  }
  bb.experimental_hooks.on('message.dispatch', async context => {
    const b = store.thread(context.thread.id);
    if (!b) return context.originPluginId === 'promptobus'
      ? { action: 'wait', reason: 'Waiting for authoritative Promptobus participant binding' } : { action: 'proceed' };
    if (b.phase !== 'ready') return { action: 'wait', reason: `Promptobus binding is ${b.phase}; operator recovery is required` };
    try {
      await requireThread(b);
      await onHost(b, { operation: 'check' });
      return { action: 'proceed' };
    } catch (error) { return { action: 'reject', message: String((error as Error).message) }; }
  });
  const spawn = async (b: Binding, assignment: string, model: string) => {
    let recorded = false;
    const tools = toolsFor(b.role);
    const delivery = createBbInstructionDelivery(b.role, { taskId: b.task, address: b.participant, environmentId: b.environmentId,
      workspace: b.environmentPath, assignment, tools: Object.fromEntries(tools.map(name => [name, name])) });
    try {
      const thread = await bb.sdk.threads.spawn({ projectId: b.projectId, environment: { type: 'reuse', environmentId: b.environmentId },
        providerId: b.providerId, model, permissionMode: 'accept-edits',
        prompt: delivery.initialPrompt, title: `Promptobus ${b.role}: ${b.participant}` });
      b.threadId = thread.id;
      store.save(b);
      recorded = true;
      await requireThread(b);
      await onHost(b, { operation: 'finalize' });
      b.phase = 'ready'; store.save(b);
      await bb.experimental_hooks.recheck('message.dispatch');
      return { task: b.task, participant: b.participant, threadId: b.threadId, phase: b.phase };
    } catch (error) {
      if (!recorded) b.threadId = null;
      b.phase = 'orphan'; store.save(b);
      if (b.threadId) await bb.sdk.threads.stop({ threadId: b.threadId }).catch(() => {});
      throw error;
    }
  };
  const createOptions = {
    task: { type: 'string', required: true, description: 'Canonical v1 task id.' },
    title: { type: 'string', required: true, description: 'Task title.' },
    project: { type: 'string', required: true, description: 'Existing BB project id.' },
    environment: { type: 'string', required: true, description: 'Existing local coordinator environment id.' },
    model: { type: 'string', required: true, description: 'Explicit Codex model.' },
    assignment: { type: 'string', required: true, stdin: true, description: 'Initial assignment text.' },
  } as const;
  bb.cli.register(defineCli({ name: 'promptobus', summary: 'Local engine-backed BB task participants.', commands: {
    'task create': cliCommand({ summary: 'Create a local task and bind a new Codex orchestrator thread.', options: createOptions,
      async run({ options }, context) {
        const environment = await bb.sdk.environments.get({ environmentId: options.environment, signal: context.signal });
        const local = (await bb.sdk.system.config()).primaryHostId;
        if (!environment.path || !local || environment.hostId !== local) throw new Error('A local coordinator environment is required');
        const b = bindingSchema.parse({ task: options.task, participant: ORCHESTRATOR, role: ORCHESTRATOR, projectId: options.project,
          environmentId: options.environment, environmentPath: environment.path, hostId: local, providerId: 'codex', root: environment.path,
          token: randomUUID(), threadId: null, phase: 'pending' });
        store.reserve(b, true);
        try {
          const result = await onHost(b, { operation: 'reserve', create: true, title: options.title }, context.signal) as { root: string };
          b.root = result.root; store.save(b);
          return { exitCode: 0, stdout: JSON.stringify(await spawn(b, options.assignment, options.model)) };
        } catch (error) { b.phase = 'orphan'; store.save(b); throw error; }
      } }),
    'participant add': cliCommand({ summary: 'Bind a new role thread to an existing plugin-owned task.', options: {
      task: createOptions.task, participant: { type: 'string', required: true, description: 'Independent participant id.' },
      role: { type: 'enum', values: roleSchema.options, required: true, description: 'Instruction role.' },
      model: createOptions.model, assignment: createOptions.assignment,
    }, async run({ options }, context) {
      const owner = store.task(options.task);
      if (!owner || owner.phase !== 'ready') throw new Error('Task has no ready plugin-owned orchestrator');
      if (options.role === ORCHESTRATOR) throw new Error('The task already has its orchestrator');
      await requireThread(owner, context.signal);
      await onHost(owner, { operation: 'check' }, context.signal);
      const b = bindingSchema.parse({ ...owner, participant: options.participant, role: options.role,
        providerId: options.role === REVIEWER ? REVIEWER_PROVIDER : 'codex', token: randomUUID(), threadId: null, phase: 'pending' });
      store.reserve(b, false);
      try {
        await onHost(b, { operation: 'reserve', create: false, title: options.task }, context.signal);
        return { exitCode: 0, stdout: JSON.stringify(await spawn(b, options.assignment, options.model)) };
      } catch (error) { b.phase = 'orphan'; store.save(b); throw error; }
    } }),
    bindings: cliCommand({ summary: 'List participant binding phases, including orphaned launches.', run: () => ({ exitCode: 0,
      stdout: JSON.stringify(store.list().map(({ token, ...binding }) => binding)) }) }),
  } }));
  return {
    async checkReviewer(context: PluginAgentToolContext) {
      const b = store.thread(context.threadId);
      if (b) {
        if (b.phase !== 'ready' || b.role !== REVIEWER || b.projectId !== context.projectId) throw new Error('Reviewer participant is not bound');
        await requireThread(b, context.signal); await onHost(b, { operation: 'check' }, context.signal);
      }
    },
    configuration(context: PluginAgentConfigurationContext) {
      const b = store.thread(context.thread.id);
      if (!b) return undefined;
      if (b.phase !== 'ready' || b.projectId !== context.project.id || b.environmentId !== context.environment.id
        || b.environmentPath !== context.environment.path || b.hostId !== context.host.id || b.providerId !== context.provider.id) return { tools: [], skills: [] };
      return { tools: [...toolsFor(b.role), ...(b.role === REVIEWER ? BB_REVIEWER_TOOLS : [])], skills: [BB_ROLE_SKILLS[b.role]],
        instructions: `Authenticated Promptobus task ${b.task}, participant ${b.participant}, role ${b.role}. Use promptobus_task for current contacts. Identity fields are not tool arguments. Use the complete initial context and the selected role skill. BB owns Stop and continuation; end the turn when waiting.` };
    },
  };
}

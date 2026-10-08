import { randomUUID } from 'node:crypto';
import { cliCommand, defineCli } from '@get-bb/plugin-sdk';
import type { BbPluginApi, PluginAgentConfigurationContext, PluginAgentToolContext } from '@get-bb/plugin-sdk';
import { createBbInstructionDelivery, BB_ROLE_SKILLS } from 'promptobus/instructions';
import { BB_REVIEWER_HOST_TOOLS, BB_REVIEWER_TOOLS } from 'promptobus/bb-reviewer';
import { renderBbHostContext } from 'promptobus/bb-host';
import { ORCHESTRATOR, REVIEWER } from 'promptobus';
import { engineInput, hostContract } from './contract.js';
import { bindingStore } from './bindings.js';
import { artifactSchema, bindingSchema, emptySchema, hostCallSchema, hostContextSchema, hostReadSchema, mailboxSchema, reasoningSchema, roleSchema, sendSchema, toolsFor } from './protocol.js';
import type { Binding } from './protocol.js';
import { captureBbWorkspace, observeBbParticipant, recordBbWorkspace, stopBbParticipant } from './lifecycle.js';
import { registerDelivery, LAUNCH_HEADER } from './delivery.js';
import { REVIEWER_PROVIDER, selectBbExecution, SUPPORTED_PROVIDERS } from './routing.js';
export { REVIEWER_PROVIDER } from './routing.js';

export function registerRuntime(bb: BbPluginApi) {
  const store = bindingStore(bb);
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const participantTools = (b: Binding) => [...toolsFor(b.role),
    ...(b.hostContext && (b.hostContext.rules.length || b.hostContext.skills.length || b.hostContext.tools.length) ? [BB_REVIEWER_HOST_TOOLS[0]] : []),
    ...(b.hostContext?.tools.length ? [BB_REVIEWER_HOST_TOOLS[1]] : [])];
  const prepareContext = async (b: Binding, signal?: AbortSignal) => {
    b.hostContext = hostContextSchema.parse(await host.call('prepareContext', { binding: b }, { hostId: b.hostId, signal }));
  };
  const onHost = async (binding: Binding, request: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await host.call('engine', engineInput.parse({ binding, ...request }), { hostId: binding.hostId, signal });
    bb.log.info(`Promptobus ${request.operation} host=${binding.hostId} task=${binding.task} participant=${binding.participant}`);
    return result;
  };
  const requireThread = async (b: Binding, signal?: AbortSignal) => {
    const thread = await bb.sdk.threads.get({ threadId: b.threadId!, signal });
    if (thread.id !== b.threadId || thread.projectId !== b.projectId || thread.environmentId !== b.environmentId
      || thread.providerId !== b.providerId || thread.parentThreadId !== b.parentThreadId
      || thread.lifecycleOwnerThreadId !== b.lifecycleOwnerThreadId) throw new Error('BB thread binding mismatch');
    const environment = await bb.sdk.environments.get({ environmentId: b.environmentId, signal });
    const local = (await bb.sdk.system.config()).primaryHostId;
    if (environment.hostId !== b.hostId || environment.path !== b.environmentPath || b.hostId !== local) throw new Error('BB environment binding mismatch');
  };
  const recovery = registerDelivery(bb, store, onHost);
  const authorize = async (context: PluginAgentToolContext, tool: string) => {
    context.signal.throwIfAborted();
    const b = store.thread(context.threadId);
    if (!b || b.phase !== 'ready') throw new Error('Promptobus participant is not bound');
    if (b.projectId !== context.projectId) throw new Error('BB project binding mismatch');
    if (!participantTools(b).includes(tool)) throw new Error('Tool is not available to this role');
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
        const result = await onHost(binding, { operation, args }, context.signal);
        if (operation === 'send') for (const recipient of (args as { to: string[] }).to) {
          const target = store.participant(binding.task, recipient);
          if (target?.threadId) void recovery.run(target.threadId);
        }
        return JSON.stringify(result);
      } });
  }
  bb.agents.registerTool({ name: 'promptobus_host_context', description: 'Read declared Host rules, skills, canonical catalog or bounded context resources. Identity is runtime-owned.',
    parameters: hostReadSchema, async execute(args, context) {
      const binding = await authorize(context, 'promptobus_host_context');
      return JSON.stringify(await host.call('hostContext', { binding, args }, { hostId: binding.hostId, signal: context.signal }));
    } });
  bb.agents.registerTool({ name: 'promptobus_host_call', description: 'Call an admitted canonical Host tool by server/tool pair. Reviewer writes are mechanically refused before invocation.',
    parameters: hostCallSchema, async execute(args, context) {
      const binding = await authorize(context, 'promptobus_host_call');
      return JSON.stringify(await host.call('canonical', { binding, args }, { hostId: binding.hostId, signal: context.signal }));
    } });
  bb.experimental_hooks.on('message.dispatch', async context => {
    const b = store.thread(context.thread.id);
    if (!b) return context.originPluginId === 'promptobus'
      ? { action: 'wait', reason: 'Waiting for authoritative Promptobus participant binding' } : { action: 'proceed' };
    if (b.phase === 'provisioning' && b.bootstrap && context.thread.projectId === b.projectId
      && context.thread.providerId === b.providerId && context.host?.id === b.hostId
      && context.input.blocks.length === 1 && context.input.blocks[0]?.type === 'text' && context.input.text === b.bootstrap) return { action: 'proceed' };
    if (b.phase !== 'ready') return { action: 'wait', reason: `Promptobus binding is ${b.phase}; operator recovery is required` };
    const admits = () => store.thread(b.threadId!)?.phase === 'ready' && recovery.admits(b.threadId!, context.input.text)
      && (context.originPluginId !== 'promptobus' || !store.delivery(b.threadId!).paused);
    if (!admits()) return { action: 'reject', message: 'Promptobus dispatch was stopped or superseded; operator recovery is required' };
    try {
      await requireThread(b);
      await onHost(b, { operation: 'check' });
      await recovery.replay(b, AbortSignal.timeout(5000));
      if (!admits()) return { action: 'reject', message: 'Promptobus dispatch was stopped or superseded; operator recovery is required' };
      return { action: 'proceed' };
    } catch (error) { return { action: 'reject', message: String((error as Error).message) }; }
  });
  const spawn = async (b: Binding, assignment: string, baseBranch?: string) => {
    let recorded = false;
    const { model, reasoningLevel } = b.execution!;
    const intent = { attemptId: randomUUID(), assignment, model, reasoningLevel, ...(baseBranch ? { baseBranch } : {}), status: 'requested' as const };
    store.launch(b, intent);
    const delivery = () => createBbInstructionDelivery(b.role, { taskId: b.task, address: b.participant, environmentId: b.environmentId,
      workspace: b.environmentPath, assignment, tools: Object.fromEntries(participantTools(b).map(name => [name, name])) });
    const initialPrompt = () => `${LAUNCH_HEADER}${intent.attemptId}\n${delivery().initialPrompt}\n\n${b.hostContext ? renderBbHostContext(b.hostContext) : ''}`;
    if (baseBranch) b.bootstrap = `Prepare the BB environment only. Do not use any tools, read files, edit files or perform an assignment. Reply READY and end the turn. Preparation token: ${randomUUID()}`;
    try {
      const thread = await bb.sdk.threads.spawn({ projectId: b.projectId, environment: baseBranch
        ? { type: 'host', hostId: b.hostId, workspace: { type: 'managed-worktree', baseBranch: { kind: 'named', name: baseBranch } } }
        : { type: 'reuse', environmentId: b.environmentId },
        providerId: b.providerId, model, reasoningLevel, permissionMode: 'accept-edits', pluginMetadata: { launchAttemptId: intent.attemptId },
        ...(b.parentThreadId ? { parentThreadId: b.parentThreadId } : {}),
        ...(b.lifecycleOwnerThreadId ? { lifecycleOwnerThreadId: b.lifecycleOwnerThreadId } : {}),
        prompt: b.bootstrap ?? initialPrompt(), title: `Promptobus ${b.role}: ${b.participant}` });
      b.threadId = thread.id;
      store.save(b);
      recorded = true;
      store.launch(b, { ...intent, status: 'recorded' });
      if (baseBranch) {
        b.phase = 'provisioning'; store.save(b);
        await bb.experimental_hooks.recheck('message.dispatch');
        const prepared = await bb.sdk.threads.wait({ threadId: b.threadId, status: 'idle', timeoutMs: 120_000 });
        if (!prepared.matched) throw new Error('BB preparation did not become idle');
        const actual = await bb.sdk.threads.get({ threadId: b.threadId });
        if (actual.projectId !== b.projectId || actual.providerId !== b.providerId || !actual.environmentId) throw new Error('BB provisioning binding mismatch');
        if (actual.status !== 'idle' || actual.runtime.displayStatus !== 'idle' || actual.activeBackgroundAgentCount !== 0) throw new Error('BB preparation is not idle');
        b.environmentId = actual.environmentId;
        const environment = await recordBbWorkspace(bb, b);
        if (!environment.managed) throw new Error('BB did not return a managed environment');
        if (!(await stopBbParticipant(bb, b)).confirmed) throw new Error('BB preparation Stop was not confirmed');
        await prepareContext(b);
        await bb.sdk.threads.clearContext({ threadId: b.threadId });
        delete b.bootstrap; b.phase = 'pending'; store.save(b);
        await onHost(b, { operation: 'reserve', create: false, title: b.task });
      }
      await requireThread(b);
      await onHost(b, { operation: 'finalize' });
      await recovery.arm(b);
      if (store.delivery(b.threadId!).paused) throw new Error('Participant stopped during launch; operator recovery is required');
      b.phase = 'ready'; store.save(b);
      if (baseBranch) await bb.sdk.threads.send({ threadId: b.threadId, mode: 'auto', input: [{ type: 'text', text: initialPrompt(), mentions: [] }] });
      await bb.experimental_hooks.recheck('message.dispatch');
      store.launch(b, { ...intent, status: 'ready' });
      return { task: b.task, participant: b.participant, threadId: b.threadId, phase: b.phase, execution: b.execution };
    } catch (error) {
      if (!recorded) b.threadId = null;
      b.phase = 'orphan'; store.save(b);
      store.launch(b, { ...intent, status: recorded ? 'recorded' : 'unknown' });
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
    provider: { type: 'enum', values: SUPPORTED_PROVIDERS, description: 'Explicit BB provider; must match the role policy.' },
    'reasoning-level': { type: 'enum', values: reasoningSchema.options, description: 'Supported model reasoning level; defaults to its SDK catalog value.' },
    assignment: { type: 'string', required: true, stdin: true, description: 'Initial assignment text.' },
  } as const;
  const participantOptions = { task: createOptions.task,
    participant: { type: 'string', required: true, description: 'Independent participant id.' } } as const;
  const boundParticipant = (task: string, participant: string) => {
    const b = store.participant(task, participant);
    if (!b || !b.threadId) throw new Error('Participant has no recorded BB thread');
    return b;
  };
  const archiving = new Set<string>();
  bb.cli.register(defineCli({ name: 'promptobus', summary: 'Local engine-backed BB task participants.', commands: {
    'task create': cliCommand({ summary: 'Create a local task and bind a new Codex orchestrator thread.', options: createOptions,
      async run({ options }, context) {
        const environment = await bb.sdk.environments.get({ environmentId: options.environment, signal: context.signal });
        const local = (await bb.sdk.system.config()).primaryHostId;
        if (!environment.path || !local || environment.hostId !== local || environment.managed) throw new Error('A stable local unmanaged coordinator environment is required');
        const b = bindingSchema.parse({ task: options.task, participant: ORCHESTRATOR, role: ORCHESTRATOR, projectId: options.project,
          environmentId: options.environment, environmentPath: environment.path, hostId: local, providerId: 'codex', root: environment.path,
          token: randomUUID(), threadId: null, phase: 'pending' });
        await recordBbWorkspace(bb, b, context.signal);
        b.execution = await selectBbExecution(bb, b, { model: options.model, provider: options.provider, reasoningLevel: options['reasoning-level'] }, context.signal);
        await prepareContext(b, context.signal);
        store.reserve(b, true);
        try {
          const result = await onHost(b, { operation: 'reserve', create: true, title: options.title }, context.signal) as { root: string };
          b.root = result.root; store.save(b);
          return { exitCode: 0, stdout: JSON.stringify(await spawn(b, options.assignment)) };
        } catch (error) { b.phase = 'orphan'; store.save(b); throw error; }
      } }),
    'participant add': cliCommand({ summary: 'Bind a new role thread to an existing plugin-owned task.', options: {
      ...participantOptions,
      role: { type: 'enum', values: roleSchema.options, required: true, description: 'Instruction role.' },
      model: createOptions.model, provider: createOptions.provider, 'reasoning-level': createOptions['reasoning-level'], assignment: createOptions.assignment,
      environment: { type: 'string', description: 'Reuse an existing local BB environment; defaults to the coordinator.' },
      'new-environment': { type: 'boolean', description: 'Let BB create and own a managed worktree.' },
      'base-branch': { type: 'string', description: 'Required branch for a new managed worktree.' },
    }, async run({ options }, context) {
      const owner = store.task(options.task);
      if (!owner || owner.phase !== 'ready') throw new Error('Task has no ready plugin-owned orchestrator');
      if (options.role === ORCHESTRATOR) throw new Error('The task already has its orchestrator');
      if (options['new-environment'] ? options.environment || !options['base-branch'] : options['base-branch']) throw new Error('Select either an existing environment or --new-environment with --base-branch');
      await requireThread(owner, context.signal);
      await onHost(owner, { operation: 'check' }, context.signal);
      const b = bindingSchema.parse({ ...owner, participant: options.participant, role: options.role,
        providerId: options.role === REVIEWER ? REVIEWER_PROVIDER : 'codex', token: randomUUID(), threadId: null, phase: 'pending',
        parentThreadId: owner.threadId, lifecycleOwnerThreadId: owner.threadId,
        environmentId: options.environment ?? owner.environmentId, environmentOwner: options['new-environment'] ? 'bb' : 'existing',
        preservation: undefined });
      delete b.preservation;
      delete b.hostContext;
      if (!options['new-environment']) await recordBbWorkspace(bb, b, context.signal);
      b.execution = await selectBbExecution(bb, b, { model: options.model, provider: options.provider, reasoningLevel: options['reasoning-level'] }, context.signal);
      if (!options['new-environment']) await prepareContext(b, context.signal);
      if (store.task(options.task)?.phase !== 'ready') throw new Error('Task orchestrator is no longer ready for a child launch');
      store.reserve(b, false);
      try {
        if (!options['new-environment']) await onHost(b, { operation: 'reserve', create: false, title: options.task }, context.signal);
        return { exitCode: 0, stdout: JSON.stringify(await spawn(b, options.assignment, options['base-branch'])) };
      } catch (error) { b.phase = 'orphan'; store.save(b); throw error; }
    } }),
    'participant get': cliCommand({ summary: 'Resolve SDK state before returning a plain SessionView.', options: participantOptions,
      async run({ options }, context) {
        const b = boundParticipant(options.task, options.participant);
        const observation = await observeBbParticipant(bb, b, context.signal);
        const currentExecution = observation.view.state === 'alive' ? await bb.sdk.threads.defaultExecutionOptions({ threadId: b.threadId!, signal: context.signal }) : null;
        return { exitCode: 0, stdout: JSON.stringify({ participant: b.participant, phase: b.phase,
          environmentId: b.environmentId, environmentPath: b.environmentPath, hostId: b.hostId, branch: b.branch, baseSha: b.baseSha,
          parentThreadId: b.parentThreadId, lifecycleOwnerThreadId: b.lifecycleOwnerThreadId,
          execution: b.execution ?? null, currentExecution, ...observation }) };
      } }),
    'routing inspect': cliCommand({ summary: 'Read scoped BB provider/model selection and account windows without launching.', options: {
      environment: createOptions.environment, model: createOptions.model, provider: createOptions.provider,
      'reasoning-level': createOptions['reasoning-level'], role: { type: 'enum', values: roleSchema.options, required: true, description: 'Role policy to check.' },
    }, async run({ options }, context) {
      const environment = await bb.sdk.environments.get({ environmentId: options.environment, signal: context.signal });
      const local = (await bb.sdk.system.config()).primaryHostId;
      if (!local || environment.hostId !== local) throw new Error('A local BB environment is required');
      const execution = await selectBbExecution(bb, { role: options.role, hostId: local, environmentId: environment.id, environmentOwner: 'existing' },
        { model: options.model, provider: options.provider, reasoningLevel: options['reasoning-level'] }, context.signal);
      return { exitCode: 0, stdout: JSON.stringify(execution) };
    } }),
    'participant stop': cliCommand({ summary: 'Request Stop and check fresh runtime state; preserve the environment.', options: participantOptions,
      async run({ options }) {
        const b = boundParticipant(options.task, options.participant);
        recovery.pause(b, 'Operator Stop; explicit resume is required');
        await recovery.cancelQueued(b).catch(error => bb.log.warn(`Promptobus queued wake retained: ${(error as Error).message}`));
        const result = await stopBbParticipant(bb, b);
        return { exitCode: result.confirmed ? 0 : 1, stdout: JSON.stringify({ ...result, deliveryPaused: true }) }; } }),
    'participant resume': cliCommand({ summary: 'Explicitly re-enable bounded wake delivery to an available idle participant.', options: participantOptions,
      async run({ options }, context) {
        const b = boundParticipant(options.task, options.participant);
        await requireThread(b, context.signal); await onHost(b, { operation: 'check' }, context.signal);
        return { exitCode: 0, stdout: JSON.stringify(await recovery.resume(b)) };
      } }),
    'recovery run': cliCommand({ summary: 'Reconcile recorded threads, history and canonical unread mail without resuming paused participants.',
      async run(_args, context) {
        for (const b of store.list()) if (b.threadId && b.phase === 'ready') await recovery.run(b.threadId, context.signal);
        return { exitCode: 0, stdout: JSON.stringify(store.list().filter(b => b.threadId).map(b => ({ participant: b.participant, task: b.task,
          phase: b.phase, delivery: store.delivery(b.threadId!) }))) };
      } }),
    'participant archive': cliCommand({ summary: 'Stop, preserve a complete workspace snapshot in the coordinator, then archive through BB.', options: participantOptions,
      async run({ options }, context) {
        const b = boundParticipant(options.task, options.participant);
        if (b.phase === 'archived') return { exitCode: 0, stdout: JSON.stringify({ phase: b.phase, preservation: b.preservation }) };
        if (b.phase !== 'ready' && b.phase !== 'archiving') throw new Error('Participant is not ready for preservation');
        if (store.list().some(child => child.lifecycleOwnerThreadId === b.threadId && child.phase !== 'archived')) throw new Error('Preserve and archive lifecycle children first');
        for (let offset = 0; ; offset += 200) {
          const threads = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 200, offset, signal: context.signal });
          if (threads.some(thread => thread.lifecycleOwnerThreadId === b.threadId)) throw new Error('A BB lifecycle child is still unarchived');
          if (threads.length < 200) break;
        }
        if (store.list().some(child => child.lifecycleOwnerThreadId === b.threadId && child.phase !== 'archived')) throw new Error('Preserve and archive lifecycle children first');
        if (archiving.has(b.threadId!)) throw new Error('Participant is already being archived');
        archiving.add(b.threadId!);
        try {
          recovery.pause(b, 'Participant archive');
          b.phase = 'archiving'; store.save(b);
          if (!(await stopBbParticipant(bb, b)).confirmed) throw new Error('BB Stop was not confirmed; environment remains in place');
          const excludeCanonicalStore = store.task(b.task)?.environmentId === b.environmentId;
          const content = JSON.stringify(await captureBbWorkspace(bb, b, context.signal, excludeCanonicalStore));
          const result = await onHost(b, { operation: 'preserve', content }, context.signal) as { artifact: { id: string; sha256: string } };
          b.preservation = { artifactId: result.artifact.id, sha256: result.artifact.sha256, at: new Date().toISOString() }; store.save(b);
          const stopped = await observeBbParticipant(bb, b, context.signal);
          if (stopped.view.state !== 'alive' || stopped.status !== 'idle' || stopped.thread?.activeBackgroundAgentCount !== 0) throw new Error('BB runtime restarted before archive');
          if (content !== JSON.stringify(await captureBbWorkspace(bb, b, context.signal, excludeCanonicalStore))) throw new Error('Workspace changed after preservation; environment remains in place');
          await bb.sdk.threads.archive({ threadId: b.threadId!, signal: context.signal });
          const actual = await bb.sdk.threads.get({ threadId: b.threadId!, signal: context.signal });
          if (actual.archivedAt === null) throw new Error('BB archive was not confirmed');
          b.phase = 'archived'; store.save(b);
          return { exitCode: 0, stdout: JSON.stringify({ phase: b.phase, preservation: b.preservation,
            environmentOwner: 'BB', accepted: false }) };
        } finally { archiving.delete(b.threadId!); }
      } }),
    bindings: cliCommand({ summary: 'List participant binding phases, including orphaned launches.', run: () => ({ exitCode: 0,
      stdout: JSON.stringify(store.list().map(({ token, ...binding }) => binding)) }) }),
    'recovery inspect': cliCommand({ summary: 'Inspect durable launch intent and candidate threads without binding or spawning.', options: participantOptions,
      async run({ options }, context) {
        const b = store.participant(options.task, options.participant);
        if (!b) throw new Error('Participant is not owned by this plugin');
        const intent = store.launchIntent(b);
        const candidates: { threadId: string; environmentId: string | null; status: string }[] = [];
        if (!b.threadId && intent) for (let offset = 0; ; offset += 200) {
          const threads = await bb.sdk.threads.list({ projectId: b.projectId, includeHidden: true, archived: false, limit: 200, offset, signal: context.signal });
          for (const thread of threads) if (thread.providerId === b.providerId && thread.parentThreadId === b.parentThreadId
            && thread.lifecycleOwnerThreadId === b.lifecycleOwnerThreadId) {
            const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id, signal: context.signal });
            if (metadata.launchAttemptId === intent.attemptId) candidates.push({ threadId: thread.id, environmentId: thread.environmentId, status: thread.status });
          }
          if (threads.length < 200) break;
        }
        return { exitCode: 0, stdout: JSON.stringify({ participant: b.participant, phase: b.phase, threadId: b.threadId,
          launch: intent ? { attemptId: intent.attemptId, status: intent.status, model: intent.model, baseBranch: intent.baseBranch } : null,
          delivery: b.threadId ? store.delivery(b.threadId) : null, candidates, automaticallyRebound: false }) };
      } }),
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
      return { tools: [...participantTools(b), ...(b.role === REVIEWER ? BB_REVIEWER_TOOLS : [])], skills: [BB_ROLE_SKILLS[b.role]],
        instructions: `Authenticated Promptobus task ${b.task}, participant ${b.participant}, role ${b.role}. Use promptobus_task for current contacts. Identity fields are not tool arguments. Use the complete initial context and the selected role skill. BB owns Stop and continuation; end the turn when waiting.` };
    },
  };
}

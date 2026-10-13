import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { cliCommand, defineCli } from '@get-bb/plugin-sdk';
import type { BbPluginApi, PluginAgentConfigurationContext, PluginAgentToolContext } from '@get-bb/plugin-sdk';
import { createBbInstructionDelivery, BB_ROLE_SKILLS } from 'promptobus/instructions';
import { BB_REVIEWER_HOST_TOOLS, BB_REVIEWER_TOOLS } from 'promptobus/bb-reviewer';
import { renderBbHostContext } from 'promptobus/bb-host';
import { ORCHESTRATOR, REVIEWER, APPROVER } from 'promptobus';
import { engineInput, hostContract } from './contract.js';
import { bindingStore } from './bindings.js';
import { artifactSchema, bindingSchema, emptySchema, hostCallSchema, hostContextSchema, hostReadSchema, mailboxSchema, reasoningSchema, roleSchema, sendSchema, toolsFor } from './protocol.js';
import type { Binding } from './protocol.js';
import { captureBbWorkspace, observeBbParticipant, recordBbWorkspace, stopBbParticipant } from './lifecycle.js';
import { registerDelivery, LAUNCH_HEADER } from './delivery.js';
import { REVIEWER_PROVIDER, selectBbExecution, SUPPORTED_PROVIDERS } from './routing.js';
import { launchContextSchema, underRoots, validateLaunchContext } from './launch-context.js';
import { validateReviewEvidence } from './review-evidence.js';
import type { EvidenceArtifact } from './review-evidence.js';
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
  const boundedJson = (value: string | undefined, field: string) => {
    if (value === undefined) return undefined;
    if (Buffer.byteLength(value) > 256 * 1024) throw new Error(`${field} exceeds 256 KiB`);
    try { return JSON.parse(value) as unknown; } catch { throw new Error(`${field} requires JSON`); }
  };
  const admit = async (b: Binding, signal?: AbortSignal) => {
    b.launchContext = validateLaunchContext(b, b.launchContext, participantTools(b));
    await host.call('launchControl', { binding: b }, { hostId: b.hostId, signal });
    signal?.throwIfAborted();
  };
  const checkEvidence = async (b: Binding, reader: Binding, signal?: AbortSignal) => {
    const review = b.launchContext?.review;
    if (!review) throw new Error('review evidence manifest requires the bounded original producer/source environment/base/gate scope');
    const producer = store.participant(b.task, review.producer);
    if (review.producerBinding === 'participant' && (!producer || producer.phase !== 'ready')) throw new Error('review evidence manifest: original producer is not bound');
    const source = await bb.sdk.environments.get({ environmentId: review.sourceEnvironmentId, signal });
    if (source.hostId !== b.hostId || !source.path || !underRoots(source.path, b.launchContext!.readRoots)) throw new Error('review evidence manifest: source environment outside declared read roots');
    const workspace = await bb.sdk.environments.status({ environmentId: source.id, signal });
    if (workspace.outcome !== 'available' || !workspace.workspace || !('headSha' in workspace.workspace.checkout)
      || !workspace.workspace.checkout.headSha) throw new Error('review evidence manifest: source SHA is unreadable');
    if (workspace.workspace.workingTree.files.some(file => !['?', '??'].includes(file.status))) throw new Error('review evidence manifest: source tracked files are dirty');
    b.evidenceManifest = await validateReviewEvidence(b.evidenceManifest, { source: workspace.workspace.checkout.headSha, base: review.base,
      producer: review.producer, requiredGates: review.requiredGates, requirePassingGates: review.requirePassingGates },
    async id => await onHost(reader, { operation: 'artifact', args: { id } }, signal) as EvidenceArtifact);
  };
  const onHost = async (binding: Binding, request: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await host.call('engine', engineInput.parse({ binding, ...request }), { hostId: binding.hostId, signal });
    bb.log.info(`Promptobus ${request.operation} host=${binding.hostId} task=${binding.task} participant=${binding.participant}`);
    return result;
  };
  const requireThread = async (b: Binding, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const thread = await bb.sdk.threads.get({ threadId: b.threadId!, signal });
    signal?.throwIfAborted();
    if (thread.id !== b.threadId || thread.projectId !== b.projectId || thread.environmentId !== b.environmentId
      || thread.providerId !== b.providerId || thread.parentThreadId !== b.parentThreadId
      || thread.lifecycleOwnerThreadId !== b.lifecycleOwnerThreadId) throw new Error('BB thread binding mismatch');
    const environment = await bb.sdk.environments.get({ environmentId: b.environmentId, signal });
    signal?.throwIfAborted();
    const local = (await bb.sdk.system.config({ signal })).primaryHostId;
    signal?.throwIfAborted();
    if (environment.hostId !== b.hostId || environment.path !== b.environmentPath || b.hostId !== local) throw new Error('BB environment binding mismatch');
  };
  const recovery = registerDelivery(bb, store, onHost);
  const requirePredecessors = async (owner: Binding, workerId: string, reviewerId: string, signal?: AbortSignal) => {
    const worker = store.participant(owner.task, workerId);
    const reviewer = store.participant(owner.task, reviewerId);
    if (!worker?.threadId || worker.phase !== 'ready' || worker.role !== 'worker'
      || !reviewer?.threadId || reviewer.phase !== 'ready' || reviewer.role !== REVIEWER
      || worker.task !== owner.task || reviewer.task !== owner.task
      || worker.projectId !== owner.projectId || reviewer.projectId !== owner.projectId
      || worker.hostId !== owner.hostId || reviewer.hostId !== owner.hostId
      || worker.lifecycleOwnerThreadId !== owner.threadId || reviewer.lifecycleOwnerThreadId !== owner.threadId) throw new Error('BB predecessor binding mismatch');
    await requireThread(worker, signal); await requireThread(reviewer, signal);
    return worker;
  };
  const checkStep = async (b: Binding, signal?: AbortSignal) => {
    if (b.role !== APPROVER) return;
    if (!b.predecessors) throw new Error('The approver requires explicit worker and reviewer predecessors');
    const owner = store.task(b.task);
    if (!owner?.threadId || owner.phase !== 'ready') throw new Error('Task has no ready plugin-owned orchestrator');
    await requireThread(owner, signal);
    await requirePredecessors(owner, b.predecessors.worker, b.predecessors.reviewer, signal);
    await onHost(b.phase === 'ready' ? b : owner, { operation: 'step', ...b.predecessors }, signal);
  };
  const authorize = async (context: PluginAgentToolContext, tool: string) => {
    context.signal.throwIfAborted();
    const b = store.thread(context.threadId);
    if (!b || b.phase !== 'ready') throw new Error('Promptobus participant is not bound');
    if (b.projectId !== context.projectId) throw new Error('BB project binding mismatch');
    if (!participantTools(b).includes(tool)) throw new Error('Tool is not available to this role');
    await requireThread(b, context.signal);
    await checkStep(b, context.signal);
    if (b.launchContext) await admit(b, context.signal);
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
    const owned = context.queuedMessages.length ? context.queuedMessages.filter(entry => entry.originPluginId === 'promptobus'
      || recovery.owns(b.threadId!, entry.content, entry.originPluginId))
      .map(entry => entry.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
      : context.originPluginId === 'promptobus' || recovery.owns(b.threadId!, context.input.blocks, context.originPluginId) ? [context.input.text] : [];
    const grouped = owned.length > 0 && context.queuedMessages.length > 1;
    const refusal = () => grouped
      ? { action: 'wait' as const, reason: 'Waiting for owned Promptobus wake cancellation', sendAt: Date.now() + 1000 }
      : { action: 'reject' as const, message: owned.length ? recovery.rejection(b.threadId!, owned[0])
        : 'Promptobus dispatch was stopped or superseded; operator recovery is required' };
    const admits = () => store.thread(b.threadId!)?.phase === 'ready' && recovery.admits(b.threadId!, context.input.text, false)
      && owned.every(text => recovery.admits(b.threadId!, text)) && (!owned.length || !store.delivery(b.threadId!).paused);
    if (!admits()) return refusal();
    const controller = new AbortController(), signal = controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([(async () => {
        await requireThread(b, signal);
        signal.throwIfAborted();
        await onHost(b, { operation: 'check' }, signal);
        signal.throwIfAborted();
        await checkStep(b, signal);
        signal.throwIfAborted();
        await recovery.replay(b, signal);
        signal.throwIfAborted();
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => {
        const error = new Error('Promptobus dispatch validation exceeded 5000 ms');
        controller.abort(error); reject(error);
      }, 5000); })]);
      if (!admits()) return refusal();
      return { action: 'proceed' };
    } catch (error) {
      const message = String((error as Error).message);
      return /binding mismatch|task is closed|requires explicit|requires the shipped.*pipeline/i.test(message)
        ? { action: 'reject', message }
        : { action: 'wait', reason: `Promptobus validation unavailable: ${message}`, sendAt: Date.now() + 1000 };
    } finally { clearTimeout(timer!); }
  });
  const displayOptions = {
    'display-label': { type: 'string', description: 'Card/task label or explicit related pair; defaults to the canonical task id.' },
    'display-subject': { type: 'string', description: 'Short display subject; defaults to the participant id.' },
    'repository-label': { type: 'string', description: 'Repository display label; defaults to the verified coordinator workspace name.' },
  } as const;
  const titleFor = (b: Binding) => `${b.display?.label ?? b.task} · ${b.role === APPROVER ? 'Acceptance'
    : b.role === REVIEWER ? 'Review' : b.role[0].toUpperCase() + b.role.slice(1)} · ${b.display?.subject ?? b.participant}`;
  const nameEnvironment = async (b: Binding, provision: boolean) => {
    if (!provision) return { status: 'preserved', reason: 'existing environment' };
    const environment = await bb.sdk.environments.get({ environmentId: b.environmentId });
    if (environment.name?.trim()) return { status: 'preserved', reason: 'existing name', name: environment.name };
    if (environment.environmentProviderInstanceKey !== b.threadId) return { status: 'preserved', reason: 'ownership not confirmed' };
    if (store.list().some(other => other.environmentId === b.environmentId && other.phase !== 'archived'
      && (other.task !== b.task || other.participant !== b.participant))) return { status: 'preserved', reason: 'shared environment' };
    for (let offset = 0; ; offset += 200) {
      const threads = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 200, offset });
      if (threads.some(thread => thread.environmentId === b.environmentId && thread.id !== b.threadId)) return { status: 'preserved', reason: 'shared environment' };
      if (threads.length < 200) break;
    }
    await requireThread(b);
    const current = await bb.sdk.environments.get({ environmentId: b.environmentId });
    if (current.name?.trim() || current.environmentProviderInstanceKey !== b.threadId) return { status: 'preserved', reason: 'metadata changed', name: current.name };
    const name = `${b.display?.label ?? b.task} · ${b.display?.repository ?? path.basename(b.root)}`;
    const updated = await bb.sdk.environments.update({ environmentId: b.environmentId, name });
    const confirmed = await bb.sdk.environments.get({ environmentId: b.environmentId });
    if (updated.id !== b.environmentId || updated.name !== name || confirmed.name !== name) throw new Error('BB environment naming was not confirmed');
    await requireThread(b);
    return { status: 'named', name };
  };
  const spawn = async (b: Binding, assignment: string, baseBranch?: string, environmentPath?: string,
    displayOverrides: Partial<NonNullable<Binding['display']>> = {}) => {
    let recorded = false;
    const provision = Boolean(baseBranch || environmentPath);
    if (!provision) await admit(b);
    const prepare = provision || b.providerId === 'acp-cursor' || b.providerId === 'acp-opencode';
    const { model, reasoningLevel } = b.execution!;
    const intent = { attemptId: randomUUID(), assignment, model, reasoningLevel, ...(baseBranch ? { baseBranch } : {}),
      ...(environmentPath ? { environmentPath } : {}), status: 'requested' as const };
    store.launch(b, intent);
    const delivery = () => createBbInstructionDelivery(b.role, { taskId: b.task, address: b.participant, environmentId: b.environmentId,
      workspace: b.environmentPath, assignment, launchContext: b.launchContext, evidenceManifest: b.evidenceManifest,
      bridgeCheck: 'First turn: call the actual BB promptobus_task and promptobus_mailbox bindings; report a refusal once. No native fallback, substitute identity or diagnostic model session.',
      tools: Object.fromEntries(participantTools(b).map(name => [name, name])) });
    const initialPrompt = () => `${LAUNCH_HEADER}${intent.attemptId}\n${delivery().initialPrompt}\n\n${b.hostContext ? renderBbHostContext(b.hostContext) : ''}`;
    if (prepare) b.bootstrap = `Prepare the BB environment only. Do not use any tools, read files, edit files or perform an assignment. Reply READY and end the turn. Preparation token: ${randomUUID()}`;
    try {
      await checkStep(b);
      await host.call('launchControl', { binding: b }, { hostId: b.hostId });
      if (b.role === REVIEWER) await checkEvidence(b, store.task(b.task)!);
      const thread = await bb.sdk.threads.spawn({ projectId: b.projectId, environment: baseBranch
        ? { type: 'host', hostId: b.hostId, workspace: { type: 'managed-worktree', baseBranch: { kind: 'named', name: baseBranch } } }
        : environmentPath ? { type: 'host', hostId: b.hostId, workspace: { type: 'unmanaged', path: environmentPath } }
        : { type: 'reuse', environmentId: b.environmentId },
        providerId: b.providerId, model, reasoningLevel, permissionMode: 'accept-edits', pluginMetadata: { launchAttemptId: intent.attemptId },
        ...(b.parentThreadId ? { parentThreadId: b.parentThreadId } : {}),
        ...(b.lifecycleOwnerThreadId ? { lifecycleOwnerThreadId: b.lifecycleOwnerThreadId } : {}),
        prompt: b.bootstrap ?? initialPrompt(), title: titleFor(b) });
      b.threadId = thread.id;
      store.save(b);
      recorded = true;
      store.launch(b, { ...intent, status: 'recorded' });
      if (prepare) {
        b.phase = 'provisioning'; store.save(b);
        await bb.experimental_hooks.recheck('message.dispatch');
        const prepared = await bb.sdk.threads.wait({ threadId: b.threadId, status: 'idle', timeoutMs: 120_000 });
        if (!prepared.matched) throw new Error('BB preparation did not become idle');
        const actual = await bb.sdk.threads.get({ threadId: b.threadId });
        if (actual.id !== b.threadId || actual.projectId !== b.projectId || actual.providerId !== b.providerId || !actual.environmentId
          || actual.parentThreadId !== b.parentThreadId || actual.lifecycleOwnerThreadId !== b.lifecycleOwnerThreadId) throw new Error('BB provisioning binding mismatch');
        if (actual.status !== 'idle' || actual.runtime.displayStatus !== 'idle' || actual.activeBackgroundAgentCount !== 0
          || actual.archivedAt !== null || actual.deletedAt !== null) throw new Error('BB preparation is not idle');
        if (!provision && actual.environmentId !== b.environmentId) throw new Error('BB preparation environment changed');
        b.environmentId = actual.environmentId;
        const environment = await recordBbWorkspace(bb, b, undefined, environmentPath);
        if (provision && (baseBranch ? !environment.managed : environment.managed)) throw new Error('BB returned an unexpected managed environment mode');
        if (environmentPath) {
          const selected = await selectBbExecution(bb, b, { model: b.execution!.requestedModel, reasoningLevel,
            provider: b.execution!.providerSource === 'explicit' ? b.providerId : undefined });
          if (selected.model !== model) throw new Error('BB preparation model selection changed');
          b.execution = { ...selected, reasoningSource: b.execution!.reasoningSource };
        }
        if (!(await stopBbParticipant(bb, b)).confirmed) throw new Error('BB preparation Stop was not confirmed');
        await prepareContext(b);
        await admit(b);
        if (b.evidenceManifest) {
          const source = await bb.sdk.environments.status({ environmentId: b.environmentId });
          if (source.outcome !== 'available' || !source.workspace || !('headSha' in source.workspace.checkout)
            || source.workspace.checkout.headSha !== b.evidenceManifest.source) throw new Error('review evidence manifest: prepared snapshot source SHA mismatch');
        }
        await bb.sdk.threads.clearContext({ threadId: b.threadId });
        delete b.bootstrap; b.phase = 'pending'; store.save(b);
        if (provision) await onHost(b, { operation: 'reserve', create: false, title: b.task });
      }
      await requireThread(b);
      if (provision && b.role === REVIEWER) {
        const workers = store.list().filter(other => other.task === b.task && other.role === 'worker'
          && other.phase === 'ready' && other.environmentId === b.environmentId);
        if (workers.length === 1 && workers[0].display) {
          await requireThread(workers[0]);
          b.display = bindingSchema.parse({ ...b, display: { ...workers[0].display, ...displayOverrides } }).display; store.save(b);
          const updated = await bb.sdk.threads.update({ threadId: b.threadId, title: titleFor(b) });
          if (updated.id !== b.threadId || updated.title !== titleFor(b)) throw new Error('BB thread naming was not confirmed');
          await requireThread(b);
        }
      }
      if ((await bb.sdk.threads.get({ threadId: b.threadId })).title !== titleFor(b)) throw new Error('BB thread naming was not confirmed');
      const naming = await nameEnvironment(b, provision);
      await checkStep(b);
      await admit(b);
      if (b.role === REVIEWER) await checkEvidence(b, store.task(b.task)!);
      await onHost(b, { operation: 'finalize' });
      await recovery.arm(b);
      if (store.delivery(b.threadId!).paused) throw new Error('Participant stopped during launch; operator recovery is required');
      b.phase = 'ready'; store.save(b);
      if (prepare) await bb.sdk.threads.send({ threadId: b.threadId, mode: 'auto', input: [{ type: 'text', text: initialPrompt(), mentions: [] }] });
      await bb.experimental_hooks.recheck('message.dispatch');
      store.launch(b, { ...intent, status: 'ready' });
      return { task: b.task, participant: b.participant, threadId: b.threadId, phase: b.phase, execution: b.execution, display: { title: titleFor(b), environment: naming } };
    } catch (error) {
      if (!recorded) b.threadId = null;
      b.phase = 'orphan'; store.save(b);
      store.launch(b, { ...intent, status: recorded ? 'recorded' : 'unknown' });
      if (b.threadId) await bb.sdk.threads.stop({ threadId: b.threadId }).catch(() => {});
      throw error;
    }
  };
  const createOptions = {
    ...displayOptions,
    task: { type: 'string', required: true, description: 'Canonical v1 task id.' },
    title: { type: 'string', required: true, description: 'Task title.' },
    project: { type: 'string', required: true, description: 'Existing BB project id.' },
    environment: { type: 'string', required: true, description: 'Existing local coordinator environment id.' },
    model: { type: 'string', required: true, description: 'Explicit model from the selected BB provider.' },
    provider: { type: 'enum', values: SUPPORTED_PROVIDERS, description: 'Explicit BB provider; must match the role policy.' },
    'reasoning-level': { type: 'enum', values: reasoningSchema.options, description: 'Supported model reasoning level; defaults to its SDK catalog value.' },
    assignment: { type: 'string', required: true, stdin: true, description: 'Initial assignment text.' },
    'launch-context': { type: 'string', description: 'Required bounded JSON: complete role literal, owned/read roots, grant, current control route, preparation and owner quota policy.' },
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
          token: randomUUID(), threadId: null, phase: 'pending',
          display: { label: options['display-label'] ?? options.task, subject: options['display-subject'] ?? options.title,
            repository: options['repository-label'] ?? path.basename(environment.path) } });
        await recordBbWorkspace(bb, b, context.signal);
        b.execution = await selectBbExecution(bb, b, { model: options.model, provider: options.provider, reasoningLevel: options['reasoning-level'] }, context.signal);
        b.providerId = b.execution.providerId;
        await prepareContext(b, context.signal);
        b.launchContext = validateLaunchContext(b, boundedJson(options['launch-context'], 'launch context'), participantTools(b));
        await admit(b, context.signal);
        store.reserve(b, true);
        try {
          const result = await onHost(b, { operation: 'reserve', create: true, title: options.title }, context.signal) as { root: string };
          b.root = result.root; store.save(b);
          return { exitCode: 0, stdout: JSON.stringify(await spawn(b, options.assignment)) };
        } catch (error) { b.phase = 'orphan'; store.save(b); throw error; }
      } }),
    'participant add': cliCommand({ summary: 'Bind a new role thread to an existing plugin-owned task.', options: {
      ...participantOptions, ...displayOptions,
      role: { type: 'enum', values: roleSchema.options, required: true, description: 'Instruction role.' },
      model: createOptions.model, provider: createOptions.provider, 'reasoning-level': createOptions['reasoning-level'], assignment: createOptions.assignment,
      'launch-context': createOptions['launch-context'],
      'evidence-manifest': { type: 'string', description: 'Required reviewer original-artifact manifest JSON; every part must be readable before launch.' },
      environment: { type: 'string', description: 'Reuse an existing local BB environment; defaults to the coordinator.' },
      'environment-path': { type: 'string', description: 'Provision an existing absolute local Git worktree path in this task project.' },
      'new-environment': { type: 'boolean', description: 'Let BB create and own a managed worktree.' },
      'base-branch': { type: 'string', description: 'Required branch for a new managed worktree.' },
      worker: { type: 'string', description: 'Required for approver: recorded worker participant for this subject.' },
      reviewer: { type: 'string', description: 'Required for approver: recorded isolated reviewer of the same subject.' },
    }, async run({ options }, context) {
      const owner = store.task(options.task);
      if (!owner || owner.phase !== 'ready') throw new Error('Task has no ready plugin-owned orchestrator');
      if (options.role === ORCHESTRATOR) throw new Error('The task already has its orchestrator');
      if (options['environment-path'] !== undefined ? options.environment !== undefined || options['new-environment'] || options['base-branch'] !== undefined
        : options['new-environment'] ? options.environment || !options['base-branch'] : options['base-branch']) {
        throw new Error('Select either --environment, --environment-path or --new-environment with --base-branch');
      }
      const environmentPath = options['environment-path'];
      if (environmentPath !== undefined && (!environmentPath.trim() || !path.isAbsolute(environmentPath))) throw new Error('--environment-path requires an absolute local path');
      const provision = Boolean(options['new-environment'] || environmentPath);
      await requireThread(owner, context.signal);
      await onHost(owner, { operation: 'check' }, context.signal);
      let worker: Binding | undefined;
      if (options.role === APPROVER) {
        if (!options.worker || !options.reviewer) throw new Error('The approver requires --worker and --reviewer');
        worker = await requirePredecessors(owner, options.worker, options.reviewer, context.signal);
        await onHost(owner, { operation: 'step', worker: options.worker, reviewer: options.reviewer }, context.signal);
      } else if (options.worker || options.reviewer) throw new Error('Predecessors are only selected for the approver');
      const sharedWorkers = options.role === REVIEWER && !provision ? store.list().filter(other => other.task === owner.task
        && other.role === 'worker' && other.phase === 'ready' && other.environmentId === (options.environment ?? owner.environmentId)) : [];
      const inherited = worker?.display ?? (sharedWorkers.length === 1 ? sharedWorkers[0].display : undefined);
      const b = bindingSchema.parse({ ...owner, participant: options.participant, role: options.role,
        display: { label: options['display-label'] ?? inherited?.label ?? owner.display?.label ?? options.task,
          subject: options['display-subject'] ?? inherited?.subject ?? options.participant,
          repository: options['repository-label'] ?? inherited?.repository ?? owner.display?.repository ?? path.basename(owner.root) },
        providerId: options.role === REVIEWER ? REVIEWER_PROVIDER : 'codex', token: randomUUID(), threadId: null, phase: 'pending',
        parentThreadId: worker?.threadId ?? owner.threadId, lifecycleOwnerThreadId: owner.threadId,
        environmentId: options.environment ?? owner.environmentId, environmentOwner: options['new-environment'] ? 'bb' : 'existing',
        preservation: undefined });
      delete b.predecessors;
      if (options.role === APPROVER) b.predecessors = { worker: options.worker!, reviewer: options.reviewer! };
      delete b.preservation;
      delete b.hostContext;
      delete b.launchContext; delete b.evidenceManifest;
      if (!provision) await recordBbWorkspace(bb, b, context.signal);
      b.execution = await selectBbExecution(bb, provision ? { ...b, environmentOwner: 'bb' } : b,
        { model: options.model, provider: options.provider, reasoningLevel: options['reasoning-level'] }, context.signal);
      b.providerId = b.execution.providerId;
      if (!provision) await prepareContext(b, context.signal);
      b.launchContext = boundedJson(options['launch-context'], 'launch context') as Binding['launchContext'];
      if (!provision) await admit(b, context.signal);
      else {
        const declared = launchContextSchema.parse(b.launchContext);
        b.launchContext = validateLaunchContext({ ...b, environmentPath: declared.grant.scope.repository,
          branch: declared.grant.scope.branch, baseSha: declared.grant.scope.base }, declared, participantTools(b));
      }
      if (b.role === REVIEWER) {
        b.evidenceManifest = boundedJson(options['evidence-manifest'], 'review evidence manifest') as Binding['evidenceManifest'];
        await checkEvidence(b, owner, context.signal);
      } else if (options['evidence-manifest'] !== undefined) throw new Error('review evidence manifest is only used for a reviewer');
      if (b.predecessors) await onHost(owner, { operation: 'step', ...b.predecessors }, context.signal);
      if (store.task(options.task)?.phase !== 'ready') throw new Error('Task orchestrator is no longer ready for a child launch');
      store.reserve(b, false);
      try {
        if (!provision) await onHost(b, { operation: 'reserve', create: false, title: options.task }, context.signal);
        return { exitCode: 0, stdout: JSON.stringify(await spawn(b, options.assignment, options['base-branch'], environmentPath && path.normalize(environmentPath), {
            ...(options['display-label'] !== undefined ? { label: options['display-label'] } : {}),
            ...(options['display-subject'] !== undefined ? { subject: options['display-subject'] } : {}),
            ...(options['repository-label'] !== undefined ? { repository: options['repository-label'] } : {}),
          })) };
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
    'evidence upload': cliCommand({ summary: 'Land complete bounded UTF-8 evidence as original opaque parts and return actual artifact IDs.', options: {
      task: createOptions.task, file: { type: 'string', required: true, description: 'Exact file inside declared owned roots.' },
      to: { type: 'string', required: true, description: 'Existing canonical recipient; no participant is started.' },
    }, async run({ options }, context) {
      const b = store.task(options.task);
      if (!b || b.phase !== 'ready') throw new Error('Task has no ready plugin-owned orchestrator');
      await requireThread(b, context.signal); await admit(b, context.signal);
      return { exitCode: 0, stdout: JSON.stringify(await onHost(b, { operation: 'uploadEvidence', file: options.file, to: options.to }, context.signal)) };
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
        let b = boundParticipant(options.task, options.participant);
        if (b.phase === 'archived') return { exitCode: 0, stdout: JSON.stringify({ phase: b.phase, preservation: b.preservation }) };
        if (b.phase !== 'ready' && b.phase !== 'archiving') throw new Error('Participant is not ready for preservation');
        if (store.list().some(child => child.lifecycleOwnerThreadId === b.threadId && child.phase !== 'archived')) throw new Error('Preserve and archive lifecycle children first');
        for (let offset = 0; ; offset += 200) {
          const threads = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 200, offset, signal: context.signal });
          if (threads.some(thread => thread.lifecycleOwnerThreadId === b.threadId)) throw new Error('A BB lifecycle child is still unarchived');
          if (threads.length < 200) break;
        }
        b = boundParticipant(options.task, options.participant);
        if (b.phase === 'archived') return { exitCode: 0, stdout: JSON.stringify({ phase: b.phase, preservation: b.preservation }) };
        if (b.phase !== 'ready' && b.phase !== 'archiving') throw new Error('Participant is not ready for preservation');
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
          launch: intent ? { attemptId: intent.attemptId, status: intent.status, model: intent.model, reasoningLevel: intent.reasoningLevel ?? null,
            baseBranch: intent.baseBranch, environmentPath: intent.environmentPath } : null,
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
        instructions: `Authenticated Promptobus task ${b.task}, participant ${b.participant}, role ${b.role}. Use promptobus_task for current contacts. Identity fields are not tool arguments. Use the complete initial context and the selected role skill. ${b.launchContext ? 'Bounded launch context admitted; actual provider bridge remains unmeasured until the first authenticated task/mailbox calls.' : 'Legacy binding: launch context notMeasured; no readiness certification.'} BB owns Stop and continuation; end the turn when waiting.` };
    },
  };
}

import { realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openEngine, ORCHESTRATOR, WORKER, REVIEWER, APPROVER } from 'promptobus';
import type { ParticipantV1 } from 'promptobus';
import { engineInput } from './contract.js';

export async function engineOperation(input: unknown) {
  const request = engineInput.parse(input);
  const b = request.binding;
  if (!path.isAbsolute(b.root)) throw new Error('Coordinator root must be absolute');
  const root = realpathSync(b.root);
  const engine = openEngine({ root, recover: false, policy: (sender, recipient) => {
    if (sender.role === 'reporter') return { deny: true, reason: 'Reporter cannot send' };
    return sender.role === ORCHESTRATOR || recipient.role === ORCHESTRATOR
      ? { allow: true } : { deny: true, reason: 'Route through the task orchestrator' };
  } });
  if (request.operation === 'reserve') {
    const participant: ParticipantV1 = { id: b.participant, role: b.role, harness: 'bb', mode: 'managed',
      sessionRef: null, capabilities: null, metadata: { bb: { token: b.token, projectId: b.projectId,
        environmentId: b.environmentId, hostId: b.hostId, providerId: b.providerId, environmentPath: b.environmentPath,
        environmentOwner: b.environmentOwner, branch: b.branch, baseSha: b.baseSha,
        parentThreadId: b.parentThreadId, lifecycleOwnerThreadId: b.lifecycleOwnerThreadId,
        assignedAt: new Date().toISOString(), ...(b.predecessors ? { predecessors: b.predecessors } : {}),
        ...(b.execution ? { execution: b.execution } : {}) } } };
    if (request.create) {
      if (b.role !== ORCHESTRATOR || b.participant !== ORCHESTRATOR) throw new Error('Task owner must be the orchestrator');
      engine.createTask({ id: b.task, title: request.title, owner: participant, adapter: { bb: { hostId: b.hostId, root } } });
    } else {
      const task = engine.readTask(b.task);
      const coordinator = task.adapter.bb as { hostId?: string; root?: string } | undefined;
      if (task.status !== 'active' || coordinator?.hostId !== b.hostId || coordinator.root !== root) throw new Error('Coordinator binding mismatch');
      engine.addParticipant(b.task, participant);
    }
    return { root };
  }
  const task = engine.readTask(b.task);
  if (task.status !== 'active') throw new Error('Promptobus task is closed');
  const coordinator = task.adapter.bb as { hostId?: string; root?: string } | undefined;
  if (coordinator?.hostId !== b.hostId || coordinator.root !== root) throw new Error('Coordinator binding mismatch');
  const participant = task.participants.find(p => p.id === b.participant);
  const metadata = participant?.metadata.bb as Record<string, unknown> | undefined;
  if (!participant || participant.role !== b.role || participant.harness !== 'bb' || participant.mode !== 'managed'
    || metadata?.token !== b.token || metadata.projectId !== b.projectId || metadata.environmentId !== b.environmentId
    || metadata.hostId !== b.hostId || metadata.providerId !== b.providerId) throw new Error('Canonical binding mismatch');
  if (request.operation === 'finalize') {
    if (!b.threadId || (participant.sessionRef !== null && participant.sessionRef !== b.threadId)) throw new Error('Canonical binding mismatch');
    engine.patchParticipant(b.task, b.participant, { sessionRef: b.threadId });
    return { ready: true };
  }
  if ((b.phase !== 'ready' && !(b.phase === 'archiving' && request.operation === 'preserve'))
    || !b.threadId || participant.sessionRef !== b.threadId) throw new Error('Canonical binding mismatch');
  switch (request.operation) {
    case 'step': {
      if (b.role !== ORCHESTRATOR && b.role !== APPROVER) throw new Error('Only the coordinator or approver may check this step');
      if (b.role === APPROVER && (b.predecessors?.worker !== request.worker || b.predecessors.reviewer !== request.reviewer)) throw new Error('Approver predecessor binding mismatch');
      const worker = task.participants.find(p => p.id === request.worker && p.role === WORKER && p.harness === 'bb');
      const reviewer = task.participants.find(p => p.id === request.reviewer && p.role === REVIEWER && p.harness === 'bb');
      if (!worker || !reviewer) throw new Error('The approver requires recorded BB worker and reviewer participants');
      const subject = (worker.metadata.bb as { environmentPath?: string }).environmentPath;
      if (!subject || (reviewer.metadata.bb as { environmentPath?: string }).environmentPath !== subject) throw new Error('Reviewer and worker subjects differ');
      const recovery = engine.recover(b.task);
      const history = engine.history({ task: b.task, all: true, strict: true });
      if (recovery.broken.length || recovery.failed.length || recovery.linkFailures.length || history.broken.length) throw new Error('Canonical assignment history is incomplete');
      for (const p of task.participants) {
        try {
          if (readdirSync(engine.brokenPath(b.task, p.id)).some(name => name.endsWith('.json'))) throw new Error('Canonical assignment history is incomplete');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const inboxes = task.participants.map(p => engine.inspectInbox(b.task, p.id));
      if (inboxes.some(box => box.broken.length)) throw new Error('Canonical assignment history is incomplete');
      const messages = [...history.entries.map(e => e.message), ...inboxes.flatMap(box => box.messages)];
      const facts = [worker, reviewer].map(p => {
        const assignment = messages.filter(m => m.type === 'task' && m.recipients.includes(p.id)).sort((a, c) => a.id.localeCompare(c.id)).at(-1);
        const at = assignment?.ts ?? (p.metadata.bb as { assignedAt?: string }).assignedAt;
        return { ...p, metadata: { address: `${p.role}:${worker.id}`, worktree: subject, reviewSubject: subject, started: at } };
      });
      return { home: engine.home, taskId: b.task, taskMeta: { ...task, participants: facts }, stepName: APPROVER, slug: worker.id, repoDir: subject };
    }
    case 'pending': {
      const recovery = engine.recover(b.task);
      const history = engine.history({ task: b.task, all: true });
      if (recovery.broken.length || recovery.failed.length || recovery.linkFailures.length || history.broken.length) throw new Error('Canonical recovery is incomplete');
      const unread = engine.glance(b.task, b.participant);
      const messages = [...history.entries.map(entry => entry.message),
        ...task.participants.flatMap(contact => engine.glance(b.task, contact.id))];
      const latestTask = messages.filter(message => message.recipients.includes(b.participant) && message.type === 'task')
        .sort((a, c) => a.id.localeCompare(c.id)).at(-1);
      const terminal = latestTask && messages.some(message => message.sender === b.participant
        && (message.type === 'result' || message.type === 'review') && message.id > latestTask.id);
      const ids = unread.map(message => message.id).sort();
      return { ids, revision: createHash('sha256').update(JSON.stringify(ids)).digest('hex'),
        obligation: latestTask && !terminal && b.role !== 'reporter' && b.role !== ORCHESTRATOR ? latestTask.id : null };
    }
    case 'preserve': return engine.send(b.task, { from: ORCHESTRATOR, to: [ORCHESTRATOR], type: 'artifact',
      body: `BB lifecycle snapshot for ${b.participant}; this is not acceptance.`,
      artifact: { filename: `${b.participant}-bb-snapshot.json`, stream: Readable.from([Buffer.from(request.content, 'utf8')]) } });
    case 'check': return { ready: true };
    case 'task': return { id: task.id, title: task.title, status: task.status, owner: task.owner,
      participant: b.participant, role: b.role,
      contacts: task.participants.map(p => ({ id: p.id, role: p.role, threadId: p.sessionRef })) };
    case 'mailbox': return request.args.mode === 'read' ? engine.read(b.task, b.participant) : engine.peek(b.task, b.participant);
    case 'artifact': {
      const artifact = engine.readArtifact(b.task, request.args.id);
      if (artifact.size > 1_000_000) throw new Error('Artifact exceeds the BB tool read limit');
      return { ...artifact, content: engine.readArtifactContent(b.task, artifact.id).toString('utf8') };
    }
    case 'send': return engine.send(b.task, { from: b.participant, to: request.args.to, type: request.args.type, body: request.args.body,
      ...(request.args.artifact ? { artifact: { filename: request.args.artifact.filename,
        stream: Readable.from([Buffer.from(request.args.artifact.content, 'utf8')]) } } : {}) });
  }
}

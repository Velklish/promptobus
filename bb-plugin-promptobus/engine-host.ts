import { realpathSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openEngine, ORCHESTRATOR } from 'promptobus';
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
        parentThreadId: b.parentThreadId, lifecycleOwnerThreadId: b.lifecycleOwnerThreadId } } };
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

import { realpathSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { Readable } from 'node:stream';
import { openEngine, withTaskLock, ORCHESTRATOR, WORKER, REVIEWER, APPROVER } from 'promptobus';
import type { ParticipantV1 } from 'promptobus';
import { engineInput } from './contract.js';
import { readCurrentControl } from './control.js';
import { readDeclaredFile } from './launch-context.js';
import { parseReviewDecision, reviewEvidenceIdentity } from './task-acceptance.js';
import { validateReviewEvidence } from './review-evidence.js';
import type { EvidenceArtifact } from './review-evidence.js';

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
        ...(b.contextPurpose ? { contextPurpose: b.contextPurpose } : {}),
        ...(b.contextDeclaration ? { contextDeclaration: b.contextDeclaration } : {}),
        ...(reviewEvidenceIdentity(b) ? { reviewEvidence: reviewEvidenceIdentity(b) } : {}),
        assignedAt: new Date().toISOString(), ...(b.predecessors ? { predecessors: b.predecessors } : {}),
        ...(b.execution ? { execution: b.execution } : {}) } } };
    if (request.create) {
      if (b.role !== ORCHESTRATOR || b.participant !== ORCHESTRATOR) throw new Error('Task owner must be the orchestrator');
      const control = readCurrentControl(b);
      if (control.outcome !== 'allowed' || b.launchContext?.control.mode !== 'current') throw new Error(control.outcome === 'allowed' ? 'Current reference required' : control.message);
      engine.createTask({ id: b.task, title: request.title, owner: participant, adapter: { bb: { hostId: b.hostId, root, currentControl: b.launchContext.control.reference } } });
      engine.assignParticipant(b.task, participant);
    } else {
      const task = engine.readTask(b.task);
      const coordinator = task.adapter.bb as { hostId?: string; root?: string } | undefined;
      if (task.status !== 'active' || coordinator?.hostId !== b.hostId || coordinator.root !== root) throw new Error('Coordinator binding mismatch');
      withTaskLock(engine.home, b.task, () => {
        if (engine.readTask(b.task).participants.some(p => p.id === b.participant)) throw new Error('Canonical participant already exists');
        engine.assignParticipant(b.task, participant);
      });
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
    || metadata.hostId !== b.hostId || metadata.providerId !== b.providerId
    || metadata.contextPurpose !== b.contextPurpose || !isDeepStrictEqual(metadata.contextDeclaration, b.contextDeclaration)) throw new Error('Canonical binding mismatch');
  if (request.operation === 'finalize') {
    if (!b.threadId || (participant.sessionRef !== null && participant.sessionRef !== b.threadId)) throw new Error('Canonical binding mismatch');
    engine.patchParticipant(b.task, b.participant, { sessionRef: b.threadId });
    return { ready: true };
  }
  if ((b.phase !== 'ready' && !(b.phase === 'archiving' && request.operation === 'preserve'))
    || !b.threadId || participant.sessionRef !== b.threadId) throw new Error('Canonical binding mismatch');
  switch (request.operation) {
    case 'accept': {
      if (b.role !== ORCHESTRATOR || task.owner !== b.participant) throw new Error('Logical acceptance requires the canonical task owner');
      const reviewer = request.reviewer, review = reviewer.launchContext?.review;
      const identity = reviewEvidenceIdentity(reviewer);
      if (reviewer.role !== REVIEWER || reviewer.phase !== 'ready' || !reviewer.threadId || !identity || !review
        || reviewer.task !== b.task || reviewer.projectId !== b.projectId || reviewer.hostId !== b.hostId
        || reviewer.lifecycleOwnerThreadId !== b.threadId || reviewer.threadId === b.threadId
        || reviewer.participant === identity.producer) throw new Error('Logical acceptance requires an independent bound reviewer');
      await validateReviewEvidence(reviewer.evidenceManifest, { source: identity.source, base: review.base, producer: review.producer,
        requiredGates: review.requiredGates, requirePassingGates: true }, async id =>
        await engineOperation({ binding: b, operation: 'artifact', args: { id } }) as EvidenceArtifact);
      return withTaskLock(engine.home, b.task, () => {
        const facts = engine.facts(b.task);
        const owner = facts.task.participants.find(p => p.id === b.participant);
        const ownerBound = owner?.metadata.bb as Record<string, unknown> | undefined;
        if (facts.task.owner !== b.participant || owner?.role !== ORCHESTRATOR || owner.harness !== 'bb' || owner.mode !== 'managed'
          || owner.sessionRef !== b.threadId || ownerBound?.token !== b.token || ownerBound.projectId !== b.projectId
          || ownerBound.environmentId !== b.environmentId || ownerBound.environmentPath !== b.environmentPath
          || ownerBound.hostId !== b.hostId || ownerBound.providerId !== b.providerId || ownerBound.contextPurpose !== b.contextPurpose
          || !isDeepStrictEqual(ownerBound.contextDeclaration, b.contextDeclaration)) {
          throw new Error('Logical acceptance canonical owner binding changed');
        }
        const canonical = facts.task.participants.find(p => p.id === reviewer.participant);
        const author = facts.task.participants.find(p => p.id === identity.producer);
        const bound = canonical?.metadata.bb as Record<string, unknown> | undefined;
        if (!canonical || canonical.role !== REVIEWER || canonical.harness !== 'bb' || canonical.mode !== 'managed'
          || canonical.sessionRef !== reviewer.threadId || canonical.sessionRef === author?.sessionRef
          || bound?.token !== reviewer.token || bound.projectId !== reviewer.projectId || bound.environmentId !== reviewer.environmentId
          || bound.environmentPath !== reviewer.environmentPath || bound.lifecycleOwnerThreadId !== b.threadId
          || bound.hostId !== reviewer.hostId || bound.providerId !== reviewer.providerId || bound.contextPurpose !== reviewer.contextPurpose
          || !isDeepStrictEqual(bound.contextDeclaration, reviewer.contextDeclaration) || !isDeepStrictEqual(bound.reviewEvidence, identity)) throw new Error('Logical acceptance reviewer/source binding mismatch');
        const persisted = canonical.metadata.assignmentAfterId;
        if (typeof persisted !== 'string') throw new Error('Logical acceptance requires a current causal review assignment');
        const boundary = facts.messages.filter(m => m.recipients.includes(canonical.id) && (m.type === 'task' || m.type === 'review'))
          .reduce((latest, m) => m.id > latest ? m.id : latest, persisted);
        const result = facts.messages.filter(m => m.sender === canonical.id && m.type === 'result' && m.id > boundary)
          .sort((a, c) => a.id.localeCompare(c.id)).at(-1);
        if (!result || result.id !== request.resultId || !result.recipients.includes(b.participant)) throw new Error('Logical acceptance requires the exact latest result after the current review assignment');
        const decision = parseReviewDecision(result.body);
        if (decision.task !== b.task || decision.reviewer !== canonical.id || decision.assignmentAfterId !== boundary
          || decision.source !== identity.source || decision.base !== identity.base || decision.producer !== identity.producer
          || decision.evidenceManifestSha256 !== identity.evidenceManifestSha256) throw new Error('Logical acceptance decision source/base/producer/evidence/assignment mismatch');
        if (decision.decision !== 'pass' || decision.findings.critical !== 0 || decision.findings.major !== 0) throw new Error('Logical acceptance requires PASS with zero critical and major findings');
        const control = readCurrentControl(b);
        if (control.outcome !== 'allowed') throw new Error(control.message);
        const acceptance = { format: 'bb-task-acceptance-v1', task: b.task, reviewer: reviewer.participant,
          resultId: result.id, assignmentAfterId: boundary, ...identity, physicalClose: false };
        const recorded = engine.sendSync(b.task, { from: b.participant, to: [b.participant], type: 'status', body: JSON.stringify(acceptance) });
        return { accepted: true, ...acceptance, messageId: recorded.message.id };
      });
    }
    case 'uploadEvidence': {
      const launch = b.launchContext;
      if (!launch || b.role !== ORCHESTRATOR) throw new Error('Evidence upload requires the bounded task coordinator');
      const bytes = readDeclaredFile(request.file, launch.ownedRoots, 64 * 1024 * 1024);
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parts = [];
      for (let offset = 0; offset < bytes.length || (offset === 0 && bytes.length === 0);) {
        let end = Math.min(offset + 900_000, bytes.length);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        const part = bytes.subarray(offset, end);
        const sent = await engine.send(b.task, { from: b.participant, to: [request.to], type: 'artifact',
          body: `Original opaque evidence part ${parts.length + 1}; attachment acceptance does not certify a schema.`,
          artifact: { filename: `${path.basename(request.file)}.part-${parts.length + 1}.txt`, stream: Readable.from([part]) } });
        if (!sent.artifact) throw new Error('Evidence attachment did not land');
        parts.push({ ...sent.artifact, sender: b.participant });
        offset = end;
        if (bytes.length === 0) break;
      }
      return { parts, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    case 'step': {
      if (b.role !== ORCHESTRATOR && b.role !== APPROVER) throw new Error('Only the coordinator or approver may check this step');
      if (b.role === APPROVER && (b.predecessors?.worker !== request.worker || b.predecessors.reviewer !== request.reviewer)) throw new Error('Approver predecessor binding mismatch');
      const factsSnapshot = engine.facts(b.task);
      const worker = factsSnapshot.task.participants.find(p => p.id === request.worker && p.role === WORKER && p.harness === 'bb');
      const reviewer = factsSnapshot.task.participants.find(p => p.id === request.reviewer && p.role === REVIEWER && p.harness === 'bb');
      if (!worker || !reviewer) throw new Error('The approver requires recorded BB worker and reviewer participants');
      const subject = (worker.metadata.bb as { environmentPath?: string }).environmentPath;
      if (!subject || (reviewer.metadata.bb as { environmentPath?: string }).environmentPath !== subject) throw new Error('Reviewer and worker subjects differ');
      const facts = [worker, reviewer].map(p => {
        return { ...p, metadata: { ...p.metadata, address: `${p.role}:${worker.id}`, worktree: subject, reviewSubject: subject } };
      });
      return { home: engine.home, taskId: b.task, taskMeta: { ...factsSnapshot.task, participants: facts }, facts: factsSnapshot, stepName: APPROVER, slug: worker.id, repoDir: subject };
    }
    case 'pending': {
      const facts = engine.facts(b.task);
      const messages = facts.messages;
      const persisted = facts.task.participants.find(current => current.id === b.participant)?.metadata.assignmentAfterId;
      const unread = engine.glance(b.task, b.participant);
      const latestAssignment = messages.filter(message => message.recipients.includes(b.participant) && (message.type === 'task' || message.type === 'review'))
        .sort((a, c) => a.id.localeCompare(c.id)).at(-1);
      if (b.role !== ORCHESTRATOR && b.role !== 'reporter' && typeof persisted !== 'string') {
        throw new Error(persisted === null ? 'Canonical assignment boundary is pending publication' : 'Canonical assignment boundary requires explicit fresh assignment');
      }
      const boundary = typeof persisted === 'string' ? (latestAssignment && latestAssignment.id > persisted ? latestAssignment.id : persisted) : null;
      const terminal = boundary && messages.some(message => message.sender === b.participant
        && (message.type === 'result' || message.type === 'review') && message.id > boundary);
      const actionable = b.role === ORCHESTRATOR ? unread.filter(message => message.type !== 'status') : unread;
      const ids = actionable.length ? unread.map(message => message.id).sort() : [];
      return { ids, revision: createHash('sha256').update(JSON.stringify(actionable.map(message => message.id).sort())).digest('hex'),
        obligation: boundary && !terminal && b.role !== 'reporter' && b.role !== ORCHESTRATOR ? boundary : null };
    }
    case 'preserve': return engine.send(b.task, { from: ORCHESTRATOR, to: [ORCHESTRATOR], type: 'artifact',
      body: `BB lifecycle snapshot for ${b.participant}; this is not acceptance.`,
      artifact: { filename: `${b.participant}-bb-snapshot.json`, stream: Readable.from([Buffer.from(request.content, 'utf8')]) } });
    case 'assignment': {
      const identity = reviewEvidenceIdentity(b);
      const assigned = engine.assignParticipant(b.task, identity ? { ...participant,
        metadata: { ...participant.metadata, bb: { ...metadata, reviewEvidence: identity } } } : participant);
      return { assignmentAfterId: assigned.participants.find(p => p.id === b.participant)!.metadata.assignmentAfterId };
    }
    case 'check': return { ready: true };
    case 'task': return { id: task.id, title: task.title, status: task.status, owner: task.owner,
      participant: b.participant, role: b.role, assignmentAfterId: participant.metadata.assignmentAfterId ?? null,
      ...(metadata.reviewEvidence ? { reviewEvidence: metadata.reviewEvidence } : {}),
      contacts: task.participants.map(p => ({ id: p.id, role: p.role, threadId: p.sessionRef })) };
    case 'mailbox': return request.args.mode === 'read' ? engine.read(b.task, b.participant) : engine.peek(b.task, b.participant);
    case 'artifact': {
      const artifact = engine.readArtifact(b.task, request.args.id);
      if (artifact.size > 1_000_000) throw new Error('Artifact exceeds the BB tool read limit');
      const history = engine.history({ task: b.task, all: true, strict: true });
      const inboxes = task.participants.map(p => engine.inspectInbox(b.task, p.id));
      if (history.broken.length || inboxes.some(box => box.broken.length)) throw new Error('Artifact provenance history is incomplete');
      const messages = [...history.entries.map(entry => entry.message), ...inboxes.flatMap(box => box.messages)];
      const senders = new Set(messages.filter(m => m.artifact === artifact.id).map(m => m.sender));
      if (senders.size !== 1) throw new Error('Artifact provenance sender is missing or ambiguous');
      return { ...artifact, sender: [...senders][0], content: engine.readArtifactContent(b.task, artifact.id).toString('utf8') };
    }
    case 'send': return engine.send(b.task, { from: b.participant, to: request.args.to, type: request.args.type, body: request.args.body,
      ...(request.args.artifact ? { artifact: { filename: request.args.artifact.filename,
        stream: Readable.from([Buffer.from(request.args.artifact.content, 'utf8')]) } } : {}) });
  }
}

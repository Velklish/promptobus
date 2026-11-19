import path from 'node:path';
import { addressOf, DEFAULT_PIPELINE, pipelineSteps, piecesOf, SHIPPED_REGISTRY, type MessageV1, type ParticipantV1, type TaskV1 } from '../../src/index.ts';
import { boardSchema, historySchema, pieceSchema, rootsSchema, type Board } from './contract.js';
import { BOARD_REFERENCE_LIMIT, boardMessages, OWNED_RECORD_BYTES, ownedDirectory, ownedText, ReadBudget, ReadBudgetExceeded, readTasks, selectedTask, toMessage } from './projection.js';

const ACTIVE_RUNS = 16;
const BOARD_READ_BYTES = 8 * 1024 * 1024;
const DISCOVERY_READ_BYTES = 8 * 1024 * 1024;
const clipped = (value: unknown) => typeof value === 'string' ? value.slice(0, 240) : null;
const GOVERNANCE = new Set(SHIPPED_REGISTRY.entries.filter(entry => entry.layer !== 'step').map(entry => entry.name));
const BB_THREAD = /^thr_[a-z0-9]+$/;
const SHIPPED = pipelineSteps(DEFAULT_PIPELINE).map(step => step.name);
const BB_STEPS = ['worker', 'reviewer', 'approver'];

/** Places a BB participant, which records no address, as the adapter's step check does; the full rule is in the README's
 * Board section. */
export function placed(participants: readonly ParticipantV1[]): ParticipantV1[] {
  const named = new Map<string, string>(), chosen = new Set<string>(), split = new Set<string>();
  for (const participant of participants) {
    const before = (participant.metadata.bb as { predecessors?: { worker?: unknown; reviewer?: unknown } } | null | undefined)?.predecessors;
    if (participant.harness !== 'bb' || participant.role !== 'approver' || typeof before?.worker !== 'string') continue;
    named.set(participant.id, before.worker);
    if (typeof before.reviewer !== 'string') continue;
    if (named.has(before.reviewer) && named.get(before.reviewer) !== before.worker) split.add(before.reviewer);
    named.set(before.reviewer, before.worker); chosen.add(before.worker);
  }
  for (const reviewer of split) named.delete(reviewer);
  for (const participant of participants) {
    const producer = (participant.metadata.bb as { reviewEvidence?: { producer?: unknown } } | null | undefined)?.reviewEvidence?.producer;
    if (participant.harness !== 'bb' || participant.role !== 'reviewer' || named.has(participant.id) || split.has(participant.id) || typeof producer !== 'string' || chosen.has(producer)) continue;
    if (participants.some(worker => worker.id === producer && worker.harness === 'bb' && worker.role === 'worker')) named.set(participant.id, producer);
  }
  const bb = participants.filter(participant => !addressOf(participant) && participant.harness === 'bb' && BB_STEPS.includes(participant.role));
  const address = new Map(bb.map(participant => [participant.id, `${participant.role}:${participant.role === 'worker' ? participant.id : named.get(participant.id) ?? participant.id}`]));
  // Several participants of one step on one worker each keep their own card, so none hides another's thread and history.
  const shared = [...address.values()].filter((value, index, all) => all.indexOf(value) !== index);
  for (const [id, value] of address) if (shared.includes(value)) address.set(id, `${value.slice(0, value.indexOf(':'))}:${id}`);
  return participants.map(participant => address.has(participant.id)
    ? { ...participant, metadata: { ...participant.metadata, address: address.get(participant.id) } } : participant);
}

/** Shipped steps first; a step a host declared is known here only by its addresses and follows them. */
export function boardSteps(task: Pick<TaskV1, 'participants'>): string[] {
  const steps = [...SHIPPED];
  for (const participant of task.participants) {
    const address = addressOf(participant) ?? '', colon = address.indexOf(':');
    const prefix = address.slice(0, colon);
    if (colon > 0 && !GOVERNANCE.has(prefix) && !steps.includes(prefix)) steps.push(prefix);
  }
  return steps.slice(0, 16);
}
function stallsOf(root: string, taskId: string, budget: ReadBudget): Record<string, string> {
  if (budget.exhausted) return {};
  let text: string | null;
  try { text = ownedText(root, path.join(root, 'tasks', taskId, 'stalls.json'), OWNED_RECORD_BYTES, budget); }
  catch (error) { if (error instanceof ReadBudgetExceeded) return {}; throw error; }
  if (text === null) return {};
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([address, value]) => {
    const reason = typeof value === 'string' ? value : (value as { reason?: unknown } | null)?.reason;
    return typeof reason === 'string' ? [[address, reason.slice(0, 240)]] : [];
  }));
}
function openQuestion(participantId: string, messages: readonly MessageV1[]): string | null {
  const asked = messages.filter(message => message.type === 'question' && message.sender === participantId);
  const open = asked.filter(question => question.recipients.some(recipient => !messages.some(reply => reply.type === 'answer'
    && reply.id > question.id && reply.sender === recipient && reply.recipients.includes(participantId))));
  return open.at(-1)?.id ?? null;
}
function sampleNotice(older: boolean, exhausted: boolean, scope: string): { notice?: string } {
  const notices = [];
  if (older) notices.push(`Older messages were not read (newest ${BOARD_REFERENCE_LIMIT} references only).`);
  if (exhausted) notices.push(`${scope} reached its byte budget; some records were not read.`);
  return notices.length ? { notice: notices.join(' ') } : {};
}
function runOf(root: string, task: TaskV1, budget: ReadBudget) {
  const participants = placed(task.participants);
  const { messages, unread, older, pending } = boardMessages(root, task.id, budget);
  const stalls = stallsOf(root, task.id, budget);
  const steps = boardSteps({ participants });
  const pieces = piecesOf(participants, messages, steps).slice(0, 64).map(piece => {
    const held = piece.participants.find(entry => entry.step === piece.step)
      ?? (piece.step === null ? piece.participants.at(-1) : undefined);
    const participant = held && participants.find(value => value.id === held.id);
    let holder = null;
    if (participant) {
      const address = addressOf(participant) ?? participant.id;
      const status = messages.findLast(message => message.type === 'status' && message.sender === participant.id);
      holder = { participantId: participant.id, address, role: participant.role, harness: participant.harness,
        model: clipped(participant.metadata.model ?? (participant.harness === 'bb'
          ? (participant.metadata.bb as { execution?: { model?: unknown } } | null | undefined)?.execution?.model : undefined)), sessionRef: clipped(participant.sessionRef),
        bbThreadId: participant.harness === 'bb' && BB_THREAD.test(participant.sessionRef ?? '') ? participant.sessionRef : null,
        status: status ? { line: (status.body.trim().split('\n')[0] ?? '').slice(0, 240), at: status.ts } : null,
        unread: unread.get(participant.id) ?? 0, stall: stalls[address] ?? null,
        question: openQuestion(participant.id, messages) };
    }
    return pieceSchema.parse({ slug: piece.slug, step: piece.step, holder,
      ...(piece.participants.some(entry => pending.has(entry.id)) ? { unfinishedDelivery: true } : {}),
      participants: piece.participants.map(entry => ({ step: entry.step, participantId: entry.id })) });
  });
  return { steps, pieces, inferred: steps.length > SHIPPED.length, ...sampleNotice(older, budget.exhausted, 'The board sample') };
}
export function readBoard(input: { storeRoot: string; nativeRoot: string }, instance: string, pid: number): Board {
  const { storeRoot } = rootsSchema.parse(input);
  const discoveryBudget = new ReadBudget(DISCOVERY_READ_BYTES), budget = new ReadBudget(BOARD_READ_BYTES);
  const catalogue = readTasks(input, discoveryBudget);
  const board: Board = { sampledAt: new Date().toISOString(), observer: { instance, pid }, runs: [], truncated: catalogue.truncated, limits: [
    `The board reads the ${ACTIVE_RUNS} most recently updated active runs; finished runs are listed without pieces.`,
    'Columns follow the shipped pipeline. The board cannot read a pipeline a host declared: its other steps follow in address order.',
    'Board reads do not execute work, consume mail, ACK, recover or control actors.',
  ] };
  if (discoveryBudget.exhausted) board.limits.push('Run discovery reached its byte budget; some runs were not read.');
  let read = 0;
  for (const entry of catalogue.tasks) {
    const run = { id: entry.id, title: entry.title, state: entry.state, updated: entry.updated, owner: null as string | null,
      steps: [] as string[], pieces: [] as Board['runs'][number]['pieces'], inferred: false, error: null as string | null };
    board.runs.push(run);
    if (entry.state !== 'active') continue;
    if (read++ >= ACTIVE_RUNS) { run.error = `Not sampled: the board reads ${ACTIVE_RUNS} active runs`; continue; }
    try {
      const task = selectedTask(storeRoot, entry.id);
      if (!task) { run.error = 'Run disappeared during the sample'; continue; }
      if (task.participants.length > 64) throw new Error('Run exceeds 64 participants');
      run.owner = clipped(task.participants.find(value => value.id === task.owner)?.harness);
      Object.assign(run, runOf(storeRoot, task, budget));
    } catch (error) { run.error = String(error instanceof Error ? error.message : error).slice(0, 240); }
  }
  return boardSchema.parse(board);
}
export function readPieceHistory(input: { storeRoot: string; nativeRoot: string; taskId: string; slug: string }) {
  const { storeRoot } = rootsSchema.parse({ storeRoot: input.storeRoot, nativeRoot: input.nativeRoot });
  ownedDirectory(storeRoot);
  const task = selectedTask(storeRoot, input.taskId);
  if (!task) throw new Error('Selected run is unavailable');
  const budget = new ReadBudget(BOARD_READ_BYTES);
  const { messages, older } = boardMessages(storeRoot, task.id, budget);
  const participants = placed(task.participants);
  const piece = piecesOf(participants, [], boardSteps({ participants })).find(value => value.slug === input.slug);
  if (!piece) throw new Error('Selected piece is not in this run');
  const ids = new Set(piece.participants.map(entry => entry.id));
  return historySchema.parse({ taskId: task.id, slug: piece.slug,
    ...sampleNotice(older, budget.exhausted, 'Piece history'),
    messages: messages.filter(message => ids.has(message.sender) || message.recipients.some(id => ids.has(id))).slice(-64).map(toMessage) });
}

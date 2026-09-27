import { pipelineOf } from '../dist/pipeline.js';
import { readStalls } from '../dist/index.js';
import { hostOf } from './host.js';
import { answerOwedSince, unansweredSince } from './answers.js';
import {
  addrDir, addressOf, countInbox, journalMessageBody, listTasks, ORCHESTRATOR,
  readHealth, readTask, taskMessageHeaders,
} from './store.js';
import { fail, info, ok } from './util.js';

function ageSeconds(at, now) {
  const time = Date.parse(at);
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 1000)) : null;
}

function ageText(seconds) {
  if (seconds === null) return 'unknown age';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function selectedTasks(home, task, all) {
  if (task && !all.some((meta) => meta.id === task)) {
    fail(`digest: task "${task}" is not in the journal${all.length ? `. Known: ${all.map((t) => t.id).join(', ')}` : ''}`);
  }
  const requested = task ? readTask(home, task) : null;
  const roots = requested
    ? [requested.parent ? readTask(home, requested.parent) : requested]
    : all.filter((meta) => meta.status === 'active' && !meta.parent);
  const orphaned = requested ? [] : all.filter((meta) => meta.status === 'active' && meta.parent
    && !all.some((root) => root.id === meta.parent && root.status === 'active'));
  return [...roots, ...orphaned].flatMap((root) => root.parent
    ? [{ meta: root, depth: 0 }]
    : [{ meta: root, depth: 0 }, ...all.filter((child) => child.parent === root.id)
      .map((meta) => ({ meta, depth: 1 }))]);
}

function questionsOf(home, meta, messages, now, allTasks) {
  const answers = messages.filter((message) => message.type === 'answer');
  const peerHeaders = new Map();
  const peerAnswerState = (message, recipient) => {
    if (recipient !== addrDir(ORCHESTRATOR) || !message.sender.startsWith('peer-')) return 'open';
    const originTask = message.originTask;
    if (!originTask || !allTasks.some((other) => other.id === originTask)) return 'unresolved-provenance';
    if (!peerHeaders.has(originTask)) peerHeaders.set(originTask, taskMessageHeaders(home, originTask));
    const replySender = addrDir(`peer:${meta.adapter.slug}`);
    const replies = peerHeaders.get(originTask).filter((reply) => reply.task === originTask
      && reply.type === 'answer' && reply.id > message.id && reply.sender === replySender
      && reply.recipients.includes(addrDir(ORCHESTRATOR)));
    if (replies.some((reply) => reply.originTask === meta.id)) return 'answered';
    return replies.some((reply) => !reply.originTask) ? 'unresolved-provenance' : 'open';
  };
  const questions = [];
  for (const message of messages) {
    if (message.type !== 'question') continue;
    for (const recipient of message.recipients) {
      if (answers.some((reply) => reply.id > message.id && reply.sender === recipient
        && reply.recipients.includes(message.sender))) continue;
      const state = peerAnswerState(message, recipient);
      if (state === 'answered') continue;
      const from = meta.participants.find((participant) => participant.id === message.sender);
      const to = meta.participants.find((participant) => participant.id === recipient);
      questions.push({
        id: message.id, state, ...(message.originTask ? { originTask: message.originTask } : {}),
        from: from ? addressOf(from)
          : message.sender.startsWith('peer-') ? `peer:${message.sender.slice(5)}` : message.sender,
        to: to ? addressOf(to) : recipient, at: message.ts,
        ageSeconds: ageSeconds(message.ts, now),
        body: journalMessageBody(home, meta.id, message.id, 'question'),
      });
    }
  }
  return questions.sort((a, b) => (a.from === 'user' ? 0 : 1) - (b.from === 'user' ? 0 : 1)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function piecesOf(meta, messages, pipeline) {
  const bySlug = new Map();
  for (const participant of meta.participants) {
    const address = addressOf(participant);
    const colon = address.indexOf(':');
    if (colon < 0 || !pipeline.some((step) => step.name === address.slice(0, colon))) continue;
    const slug = address.slice(colon + 1);
    if (!bySlug.has(slug)) bySlug.set(slug, new Map());
    bySlug.get(slug).set(address.slice(0, colon), participant);
  }
  const pieces = [];
  for (const [slug, participants] of bySlug) {
    let holder = null;
    const firstStep = pipeline.findIndex((step) => participants.has(step.name));
    for (const step of pipeline.slice(firstStep)) {
      holder = step.name;
      const participant = participants.get(step.name);
      if (!participant) break;
      const id = participant.id;
      const assignment = messages.filter((message) => message.recipients.includes(id)
        && (message.type === 'task' || message.type === 'review')).at(-1);
      const result = messages.filter((message) => message.sender === id && message.type === 'result').at(-1);
      const metadata = participant.metadata ?? {};
      const floor = 'reviewAssignedAt' in metadata ? metadata.reviewAssignedAt : metadata.started;
      const assignedAt = Date.parse(floor);
      const resultAt = Date.parse(result?.ts);
      const afterLift = floor === undefined || (Number.isFinite(assignedAt)
        && Number.isFinite(resultAt) && resultAt >= assignedAt);
      if (!result || (assignment && result.id < assignment.id) || !afterLift) break;
      holder = null;
    }
    pieces.push({ slug, step: holder });
  }
  return pieces.sort((a, b) => {
    const order = (piece) => piece.step === null ? pipeline.length
      : pipeline.findIndex((step) => step.name === piece.step);
    return order(a) - order(b) || a.slug.localeCompare(b.slug);
  });
}

export function buildDigest(rootOrHost, { task, now = Date.now() } = {}) {
  const host = hostOf(rootOrHost);
  const home = host.promptobusHome();
  const pipeline = pipelineOf(host);
  const allTasks = listTasks(home);
  const tasks = selectedTasks(home, task, allTasks).map(({ meta, depth }) => {
    const messages = taskMessageHeaders(home, meta.id, { statusLine: true })
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const health = readHealth(home, meta.id);
    const stalls = readStalls(home, meta.id);
    const participants = meta.participants.map((participant) => {
      const address = addressOf(participant);
      const last = messages.findLast((message) => message.type === 'status'
        && message.sender === participant.id);
      const unread = countInbox(home, meta.id, address);
      const mark = health[address] ?? {};
      const debt = address === ORCHESTRATOR
        ? answerOwedSince(home, meta.id, address, participant)
        : unread === 0 ? unansweredSince(home, meta.id, address, participant) : null;
      return {
        address, unread,
        lastStatus: last ? { firstLine: last.firstLine, at: last.ts,
          ageSeconds: ageSeconds(last.ts, now) } : null,
        stall: stalls[address] ? { reason: stalls[address].reason, at: stalls[address].at } : null,
        silent: mark.escalatedAt ? { since: mark.since ?? null, escalatedAt: mark.escalatedAt } : null,
        unanswered: debt ? { since: debt } : null,
      };
    });
    return {
      id: meta.id, title: meta.title, status: meta.status, depth,
      ...(meta.parent ? { parent: meta.parent } : {}),
      pipeline: pipeline.map((step) => step.name), participants,
      questions: questionsOf(home, meta, messages, now, allTasks),
      pieces: piecesOf(meta, messages, pipeline),
    };
  });
  return { schemaVersion: 1, generatedAt: new Date(now).toISOString(), tasks };
}

export function digest(rootOrHost, { task, json = false, now = Date.now() } = {}) {
  const page = buildDigest(rootOrHost, { task, now });
  if (json) {
    console.log(JSON.stringify(page, null, 2));
    return page;
  }
  if (!page.tasks.length) {
    ok('no active tasks');
    return page;
  }
  for (const entry of page.tasks) {
    const pad = '  '.repeat(entry.depth);
    ok(`${pad}${entry.id} · ${entry.title} · ${entry.status}`);
    for (const question of entry.questions) {
      const label = question.state === 'open' ? 'question' : 'question [UNRESOLVED PROVENANCE]';
      info(`${pad}  ${label} ${question.from} → ${question.to} · ${ageText(question.ageSeconds)}: `
        + question.body.trim().replaceAll('\n', ' ↵ '));
    }
    for (const participant of entry.participants) {
      const status = participant.lastStatus
        ? `status ${ageText(participant.lastStatus.ageSeconds)}: ${participant.lastStatus.firstLine}`
        : 'no status';
      info(`${pad}  ${participant.address} · ${status} · unread ${participant.unread}`);
      if (participant.stall) info(`${pad}    STALLED: ${participant.stall.reason}`);
      if (participant.silent) info(`${pad}    SILENT since ${participant.silent.since}`);
      if (participant.unanswered) info(`${pad}    UNANSWERED since ${participant.unanswered.since}`);
    }
    for (const step of [...entry.pipeline, null]) {
      const held = entry.pieces.filter((piece) => piece.step === step);
      if (held.length) info(`${pad}  ${step ?? 'all steps reported'}: ${held.map((piece) => piece.slug).join(', ')}`);
    }
  }
  return page;
}

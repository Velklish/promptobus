import { GateError } from '../dist/index.js';
import { hostOf } from './host.js';
import { participantOf, readTask } from './store.js';
import { holderAlive, holderAsk, readSession } from './codex-session.js';

const WAIT_MS = 180_000;

export async function reportQuestion(rootOrHost, opts = {}) {
  if (typeof opts.question !== 'string' || !opts.question.trim()) throw new GateError('report --question needs non-empty text');
  if (Object.entries(opts).some(([key, value]) => !['task', 'question'].includes(key) && value != null && value !== false)) {
    throw new GateError('report --question cannot combine with reporter launch flags');
  }
  const host = hostOf(rootOrHost);
  const home = host.promptobusHome();
  if (!opts.task) throw new GateError('report --question needs --task <root>');
  const meta = readTask(home, opts.task);
  if (meta.parent) throw new GateError('report --question needs a root task');
  if (meta.status !== 'active') throw new GateError(`task ${opts.task} is closed`);
  const participant = participantOf(meta, 'reporter');
  if (participant?.harness !== 'codex') throw new GateError('report --question needs an existing Codex reporter; lift it first with report --task');
  const ref = participant.metadata?.sessionRef;
  const record = ref ? readSession(ref) : null;
  if (!record || record.role !== 'reporter' || record.address !== 'reporter' || record.home !== home
    || record.task !== opts.task || record.threadId !== (participant.metadata.sessionId ?? participant.metadata.session)
    || record.state !== 'alive' || !holderAlive(ref)) {
    throw new GateError('the reporter session is stale or belongs to another task; lift this task reporter again');
  }
  const deadline = Date.now() + WAIT_MS;
  const rpc = (method, params) => {
    const timeoutMs = Math.max(1, Math.min(60_000, deadline - Date.now()));
    return holderAsk(ref, 'rpc', { method, params, timeoutMs }, undefined, timeoutMs + 1_000);
  };
  const started = await rpc('turn/start', {
    threadId: record.threadId, input: [{ type: 'text', text: opts.question }],
  });
  const turnId = started.turn?.id;
  if (!turnId) throw new GateError('the reporter did not return a question turn id');
  while (Date.now() < deadline) {
    const reply = await rpc('thread/read', { threadId: record.threadId, includeTurns: true });
    const turn = reply.thread?.turns?.find((entry) => entry.id === turnId);
    if (turn?.status === 'completed') {
      const text = (turn.items ?? []).filter((item) => item.type === 'agentMessage').map((item) => item.text).filter(Boolean).join('\n');
      if (!text) throw new GateError(`reporter turn ${turnId} completed without an answer`);
      console.log(text);
      return { threadId: record.threadId, turnId, text };
    }
    if (['failed', 'interrupted'].includes(turn?.status)) {
      throw new GateError(`reporter turn ${turnId} ${turn.status}: ${turn.error?.message ?? 'no answer'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new GateError(`reporter question turn ${turnId} did not finish within ${WAIT_MS} ms; it remains on thread ${record.threadId}`);
}

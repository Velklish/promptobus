import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  experimental_defineProviderBridge, createBridgeIo, createBridgeLineHandler,
  bridgeRequestEnvelopeSchema, decodeBridgeJsonRpcResponse, createPendingToolCallTracker,
  threadStartParamsSchema, threadResumeParamsSchema, threadStopParamsSchema, turnStartParamsSchema,
  threadDeltaNotificationParamsSchema, type ThreadDelta,
} from '@get-bb/plugin-sdk/provider-bridge';
import { openBbReviewer, queryBbReviewer } from 'promptobus/bb-reviewer';

export function reviewerBridge(write?: (line: string) => void, open = openBbReviewer, query = queryBbReviewer) {
  const io = createBridgeIo({ write });
  const tools = createPendingToolCallTracker({ sendToolCall: io.send });
  type Session = Awaited<ReturnType<typeof openBbReviewer>>;
  type Notification = Parameters<NonNullable<Parameters<typeof openBbReviewer>[0]['notify']>>[0];
  type Turn = { id: string; done: Promise<void>; finish: () => void; failure?: string };
  type Slot = { opening: Promise<Session>; stopped: boolean; abort: AbortController; session?: Session;
    pending: Notification[] | null; emit: (message: Notification) => void; active?: Turn;
    stopping?: Promise<void>; closing?: Promise<void> };
  const sessions = new Map<string, Slot>();
  const catalogs = new Set<AbortController>();
  let closing = false;
  let directory = '';
  const delta = (threadId: string, deltas: ThreadDelta[]) => io.send({ jsonrpc: '2.0', method: 'thread/delta',
    params: threadDeltaNotificationParamsSchema.parse({ threadId, deltas }) });
  const fail = (threadId: string, slot: Slot, message: string) => {
    if (!slot.active) return;
    const turn = slot.active;
    slot.active = undefined;
    turn.failure = message;
    delta(threadId, [{ kind: 'turn.boundary', status: 'failed', providerTurnId: turn.id, error: { message } }]);
    turn.finish();
  };
  const stop = async (threadId: string) => {
    const slot = sessions.get(threadId);
    if (!slot) return;
    return slot.closing ??= (async () => {
      slot.stopped = true;
      slot.abort.abort();
      try {
        const session = await slot.opening.catch(() => undefined);
        if (!session) return;
        tools.resolvePendingToolCalls(session, 'Reviewer stopped');
        await session.close();
        fail(threadId, slot, 'Reviewer closed before turn completed');
      } finally { if (sessions.get(threadId) === slot) sessions.delete(threadId); }
    })();
  };
  const shutdown = () => {
    closing = true;
    for (const controller of catalogs) controller.abort();
    for (const id of sessions.keys()) void stop(id).catch(() => {});
  };
  const handle = async (request: ReturnType<typeof bridgeRequestEnvelopeSchema.parse>) => {
    const params = request.params ?? {};
    if (request.method === 'initialize') {
      return { protocolVersion: 2, capabilities: { sessionRestore: true, approvalEnforcedBy: 'provider', grammarVersions: [3, 3] } };
    }
    if (request.method === 'model/list') {
      if (closing) throw new Error('Reviewer bridge is closing');
      const controller = new AbortController();
      catalogs.add(controller);
      try {
        const listed = await query({ directory: path.join(directory, 'catalog'), signal: controller.signal },
          'model/list', { includeHidden: false });
        return { models: listed.data, selectedOnlyModels: [] };
      } finally { catalogs.delete(controller); }
    }
    if (request.method === 'thread/start' || request.method === 'thread/resume') {
      const input = (request.method === 'thread/start' ? threadStartParamsSchema : threadResumeParamsSchema).parse(params);
      if (closing) throw new Error('Reviewer bridge is closing');
      if (sessions.has(input.threadId)) throw new Error('Reviewer thread already has an executor');
      let session: Session;
      const abort = new AbortController();
      const emit = (message: Notification) => {
        if (slot.stopped) return;
        const p = message.params ?? {};
        if (message.method === 'item/started' && p.item?.type === 'agentMessage') {
          delta(input.threadId, [{ kind: 'item.open', providerTurnId: p.turnId, key: { providerItemId: p.item.id }, item: { type: 'agentMessage', text: '' } }]);
        } else if (message.method === 'item/agentMessage/delta') {
          delta(input.threadId, [{ kind: 'item.textDelta', providerTurnId: p.turnId, key: { providerItemId: p.itemId }, channel: 'agentMessage', text: p.delta }]);
        } else if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
          delta(input.threadId, [{ kind: 'item.textClose', providerTurnId: p.turnId, key: { providerItemId: p.item.id }, channel: 'agentMessage', text: p.item.text },
            { kind: 'item.close', providerTurnId: p.turnId, key: { providerItemId: p.item.id }, status: 'completed', item: { type: 'agentMessage', text: p.item.text } }]);
        } else if (message.method === 'turn/completed' && slot.active && slot.active.id === p.turn.id) {
          const turn = slot.active;
          slot.active = undefined;
          delta(input.threadId, [{ kind: 'turn.boundary', status: p.turn.status === 'completed' ? 'completed'
            : p.turn.status === 'interrupted' ? 'interrupted' : 'failed', providerTurnId: p.turn.id,
            ...(p.turn.error ? { error: { message: p.turn.error.message } } : {}) }]);
          turn.finish();
        } else if (message.method === 'reviewer/closed') {
          fail(input.threadId, slot, `Codex reviewer exited unexpectedly: ${p.error ?? p.signal ?? p.code}`);
          void stop(input.threadId).catch(() => {});
        }
      };
      const slot: Slot = { stopped: false, abort, pending: null, emit, opening: Promise.resolve().then(() => open({
        signal: abort.signal,
        directory: path.join(directory, createHash('sha256').update(input.threadId).digest('hex')),
        model: input.options.model ?? '', effort: input.options.reasoningLevel,
        instructions: input.options.instructions, tools: input.dynamicTools,
        threadId: typeof input.providerThreadId === 'string' ? input.providerThreadId : null,
        invoke: async call => {
          const result = await tools.forwardToolCall({ scope: session, threadId: input.threadId,
            providerThreadId: session.threadId, toolName: call.tool, arguments: call.arguments });
          return { success: !result.isError, contentItems: [{ type: 'inputText', text: result.content }] };
        },
        notify: message => {
          if (message.method === 'reviewer/closed') emit(message);
          else if (slot.pending) slot.pending.push(message);
          else emit(message);
        },
      })) };
      sessions.set(input.threadId, slot);
      try { session = await slot.opening; }
      catch (error) { if (sessions.get(input.threadId) === slot) sessions.delete(input.threadId); throw error; }
      slot.session = session;
      if (slot.stopped) { await session.close(); throw new Error('Reviewer start was cancelled'); }
      io.send({ jsonrpc: '2.0', method: 'thread/identity', params: { threadId: input.threadId, providerThreadId: session.threadId } });
      delta(input.threadId, [{ kind: 'session.reset' }]);
      return { providerThreadId: session.threadId };
    }
    if (request.method === 'turn/start') {
      const input = turnStartParamsSchema.parse(params);
      const slot = sessions.get(input.threadId);
      const session = slot && !slot.stopped ? await slot.opening : undefined;
      if (slot?.stopping) throw new Error('Reviewer thread is stopping');
      if (!slot || !session || slot.stopped || session.threadId !== input.providerThreadId) throw new Error('Reviewer session is not bound to this thread');
      if (input.options.model && input.options.model !== (session.profile as { model: string }).model) throw new Error('Reviewer model changes require a fresh session');
      if (input.options.reasoningLevel && input.options.reasoningLevel !== (session.profile as { effort: string | null }).effort) {
        throw new Error('Reviewer effort changes require a fresh session');
      }
      if (slot.pending || slot.active) throw new Error('Reviewer turn already in progress');
      slot.pending = [];
      let accepted = false;
      try {
        const started = await session.request('turn/start', { threadId: session.threadId,
          input: input.input.map(block => {
            if (block.type !== 'text') throw new Error('Reviewer accepts text input only');
            return { type: 'text', text: block.text };
          }) });
        if (slot.stopped) throw new Error('Reviewer turn start was cancelled');
        let finish!: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        slot.active = { id: started.turn.id, done, finish };
        delta(input.threadId, [{ kind: 'input.accepted', clientRequestId: input.clientRequestId, providerTurnId: started.turn.id },
          { kind: 'turn.open', providerTurnId: started.turn.id }]);
        accepted = true;
      } finally {
        const buffered = slot.pending;
        slot.pending = null;
        if (accepted) for (const message of buffered ?? []) slot.emit(message);
      }
      return {};
    }
    if (request.method === 'thread/stop') {
      const input = threadStopParamsSchema.parse(params);
      const slot = sessions.get(input.threadId);
      if (!slot) return {};
      if (slot.session && slot.session.threadId !== input.providerThreadId) throw new Error('Reviewer thread identity mismatch');
      if (slot.active && input.intent === 'interrupt' && slot.active.id !== input.activeTurnId) {
        throw new Error('Reviewer active turn identity mismatch');
      }
      await (slot.stopping ??= (async () => {
        if (!slot.session) { slot.stopped = true; slot.abort.abort(); }
        try {
          const session = await slot.opening.catch(() => undefined);
          const turn = slot.active;
          if (session && turn && input.intent === 'interrupt') {
            await session.request('turn/interrupt', { threadId: session.threadId, turnId: turn.id }, 5000);
            let timer: ReturnType<typeof setTimeout>;
            try {
              await Promise.race([turn.done, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Reviewer interrupt did not settle in 5000 ms')), 5000);
              })]);
            } finally { clearTimeout(timer!); }
            if (turn.failure) throw new Error(turn.failure);
          }
        } finally { await stop(input.threadId); }
      })());
      return {};
    }
    throw Object.assign(new Error(`Unknown reviewer bridge method: ${request.method}`), { code: -32601 });
  };
  return experimental_defineProviderBridge({
    start: context => { directory = context.dataDir; },
    handleLine: createBridgeLineHandler({ handleParsedMessage: message => {
      const response = decodeBridgeJsonRpcResponse(message);
      if (response) { tools.handleToolCallResponse(response); return; }
      const parsed = bridgeRequestEnvelopeSchema.safeParse(message);
      if (!parsed.success) {
        io.send({ jsonrpc: '2.0', id: null, error: { code: -32602, message: 'Invalid reviewer bridge request' } });
        return;
      }
      void handle(parsed.data).then(result => io.sendResult(parsed.data.id, result), error =>
        io.sendError(parsed.data.id, error.code ?? (error.issues ? -32602 : -32000), String(error.message)));
    } }),
    onClose: shutdown,
    onSigterm: shutdown,
    onSigint: shutdown,
  });
}

export const experimental_providerBridge = reviewerBridge();

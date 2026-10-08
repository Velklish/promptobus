import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from '../.test-build/server.js';
import { reviewerBridge } from '../.test-build/reviewer-bridge.js';
import { experimental_createDeltaAssembler as createAssembler } from '@get-bb/plugin-sdk/provider-bridge/testing';

function harness(open, query) {
  const messages = [];
  const bridge = reviewerBridge(line => messages.push(JSON.parse(line)), open, query);
  bridge.start({ pluginId: 'promptobus', dataDir: '/tmp/reviewer', tempDir: '/tmp/reviewer' });
  let next = 1;
  return { bridge, messages, async call(method, params) {
    const id = next++;
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let i = 0; i < 100; i++) {
      const found = messages.find(message => message.id === id);
      if (found) return found;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`No bridge response: ${method}`);
  } };
}
const start = { threadId: 'bb-thread', cwd: '/review', instructionMode: 'append', options: { model: 'model', permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user', permissionEscalation: 'deny' } };

test('reviewer bridge correlates final text with its BB turn', async () => {
  let input;
  let closed = 0;
  let requests = 0;
  const h = harness(async options => {
    input = options;
    return { threadId: 'native', profile: { model: 'model' }, close: async () => { closed++; },
      request: async () => { requests++; return { turn: { id: 'native-turn' } }; } };
  });
  assert.equal((await h.call('thread/start', start)).result.providerThreadId, 'native');
  const reply = await h.call('turn/start', { threadId: 'bb-thread', providerThreadId: 'native', clientRequestId: 'creq_abcdefghjk',
    input: [{ type: 'text', text: 'Review' }], options: { permissionMode: 'accept-edits', permissionScope: 'workspace', approvalReviewer: 'user', permissionEscalation: 'deny' } });
  assert.deepEqual(reply.result, {});
  assert.equal(requests, 1);
  for (const [method, params] of [
    ['item/started', { item: { type: 'agentMessage', id: 'message', text: '' } }],
    ['item/agentMessage/delta', { itemId: 'message', delta: 'Result' }],
    ['item/completed', { item: { type: 'agentMessage', id: 'message', text: 'Result' } }],
    ['turn/completed', { turn: { id: 'native-turn', status: 'completed' } }],
  ]) input.notify({ method, params: { ...params, turnId: 'native-turn' } });
  const assembler = createAssembler({ providerId: 'promptobus-codex-reviewer', textDeltaFlushMs: 0 });
  const events = h.messages.filter(m => m.method === 'thread/delta').flatMap(m => assembler.assemble(m.params));
  assert.ok(events.some(e => e.type === 'item/completed' && e.item.text === 'Result'));
  assert.ok(events.some(e => e.type === 'turn/completed' && e.status === 'completed'));
  await h.call('thread/stop', { threadId: 'bb-thread', providerThreadId: 'native', activeTurnId: null, intent: 'release' });
  assert.equal(closed, 1);
});

test('reviewer bridge reserves an opening session and cancels it on close', async () => {
  let signal;
  const h = harness(options => { signal = options.signal; return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }); });
  h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'pending', method: 'thread/start', params: start }));
  assert.match((await h.call('thread/start', start)).error.message, /already has an executor/);
  h.bridge.onClose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.match(h.messages.find(m => m.id === 'pending').error.message, /cancelled/);
  assert.match((await h.call('thread/start', start)).error.message, /closing/);
});

test('reviewer tools reject a forged provider or remote environment before host dispatch', async () => {
  const tools = new Map();
  let config;
  let calls = 0;
  let thread = { providerId: 'codex', projectId: 'project', environmentId: 'env' };
  let environment = { path: '/review', hostId: 'remote' };
  plugin({
    providers: { register() {} },
    hosts: { experimental_client: () => ({ call: async () => { calls++; return {}; } }) },
    agents: { registerTool: tool => tools.set(tool.name, tool), configure: value => { config = value; } },
    sdk: { threads: { get: async () => thread }, environments: { get: async () => environment },
      system: { config: async () => ({ primaryHostId: 'local' }) } },
  });
  assert.deepEqual(config({ provider: { id: 'codex' } }).tools, []);
  const read = tools.get('pb_review_read_file');
  const context = { threadId: 'bb-thread', projectId: 'project' };
  await assert.rejects(read.execute({ path: '/review/sample' }, context), /authenticated BB thread/);
  thread = { ...thread, providerId: 'promptobus-codex-reviewer' };
  await assert.rejects(read.execute({ path: '/review/sample' }, context), /local coordinator/);
  assert.equal(calls, 0);
  environment = { ...environment, hostId: 'local' };
  await read.execute({ path: '/review/sample' }, context);
  assert.equal(calls, 1);
});


test('reviewer bridge closes and frees its slot when native interrupt fails', async () => {
  let closed = 0;
  const h = harness(async () => ({ threadId: 'native', profile: { model: 'model', effort: 'low' },
    request: async method => { if (method === 'turn/start') return { turn: { id: 'turn' } };
      throw new Error('interrupt failed'); }, close: async () => { closed++; } }));
  assert.equal((await h.call('thread/start', start)).result.providerThreadId, 'native');
  await h.call('turn/start', { threadId: 'bb-thread', providerThreadId: 'native', clientRequestId: 'creq_abcdefghjk',
    input: [{ type: 'text', text: 'Review' }], options: start.options });
  const stopped = await h.call('thread/stop', { threadId: 'bb-thread', providerThreadId: 'native',
    activeTurnId: 'turn', intent: 'interrupt' });
  assert.match(stopped.error.message, /interrupt failed/);
  assert.equal(closed, 1);
  assert.equal((await h.call('thread/start', start)).result.providerThreadId, 'native');
  h.bridge.onClose();
});

test('reviewer bridge closes an early native completion after acceptance and open', async () => {
  let input;
  const h = harness(async options => {
    input = options;
    return { threadId: 'native', profile: { model: 'model' }, close: async () => {}, request: async () => {
      input.notify({ method: 'turn/completed', params: { turn: { id: 'early', status: 'completed' } } });
      return { turn: { id: 'early' } };
    } };
  });
  await h.call('thread/start', start);
  const reply = await h.call('turn/start', { threadId: 'bb-thread', providerThreadId: 'native',
    clientRequestId: 'creq_abcdefghjk', input: [{ type: 'text', text: 'Review' }], options: start.options });
  assert.deepEqual(reply.result, {});
  const kinds = h.messages.filter(m => m.method === 'thread/delta').flatMap(m => m.params.deltas.map(d => d.kind));
  assert.deepEqual(kinds, ['session.reset', 'input.accepted', 'turn.open', 'turn.boundary']);
  const assembler = createAssembler({ providerId: 'promptobus-codex-reviewer' });
  for (const m of h.messages.filter(m => m.method === 'thread/delta')) assembler.assemble(m.params);
  assert.equal(assembler.getOpenTurnId('bb-thread'), undefined);
  h.bridge.onClose();
});

test('reviewer bridge refuses a reasoning effort change before a native request', async () => {
  let calls = 0;
  const h = harness(async () => ({ threadId: 'native', profile: { model: 'model', effort: 'low' },
    close: async () => {}, request: async () => { calls++; return { turn: { id: 'turn' } }; } }));
  await h.call('thread/start', { ...start, options: { ...start.options, reasoningLevel: 'low' } });
  const reply = await h.call('turn/start', { threadId: 'bb-thread', providerThreadId: 'native',
    clientRequestId: 'creq_abcdefghjk', input: [{ type: 'text', text: 'Review' }],
    options: { ...start.options, reasoningLevel: 'high' } });
  assert.match(reply.error?.message ?? '', /effort changes require a fresh session/);
  assert.equal(calls, 0);
  h.bridge.onClose();
});


test('reviewer interrupt settles before Stop replies, including completion after RPC acknowledgement', async () => {
  let live = true;
  let options;
  const h = harness(async input => {
    options = input;
    return { threadId: 'native', profile: { model: 'model' }, close: async () => { live = false; }, request: async method => {
      if (method === 'turn/start') return { turn: { id: 'turn' } };
      setImmediate(() => { if (live) options.notify({ method: 'turn/completed',
        params: { turn: { id: 'turn', status: 'interrupted' } } }); });
      return {};
    } };
  });
  await h.call('thread/start', start);
  await h.call('turn/start', { threadId: 'bb-thread', providerThreadId: 'native', clientRequestId: 'creq_abcdefghjk',
    input: [{ type: 'text', text: 'Review' }], options: start.options });
  const response = await h.call('thread/stop', { threadId: 'bb-thread', providerThreadId: 'native', activeTurnId: 'turn', intent: 'interrupt' });
  assert.deepEqual(response.result, {});
  const boundary = h.messages.findIndex(m => m.method === 'thread/delta' && m.params.deltas.some(d => d.kind === 'turn.boundary'));
  assert.ok(boundary >= 0);
  assert.ok(boundary < h.messages.indexOf(response));
  const assembler = createAssembler({ providerId: 'promptobus-codex-reviewer' });
  for (const m of h.messages.filter(m => m.method === 'thread/delta')) assembler.assemble(m.params);
  assert.equal(assembler.getOpenTurnId('bb-thread'), undefined);
});

test('reviewer bridge fails the open turn and releases its slot on unexpected native exit', async () => {
  let input;
  let closed = 0;
  const h = harness(async options => { input = options; return { threadId: 'native', profile: { model: 'model' },
    close: async () => { closed++; }, request: async () => ({ turn: { id: 'turn' } }) }; });
  await h.call('thread/start', start);
  await h.call('turn/start', { threadId: 'bb-thread', providerThreadId: 'native', clientRequestId: 'creq_abcdefghjk',
    input: [{ type: 'text', text: 'Review' }], options: start.options });
  input.notify({ method: 'reviewer/closed', params: { code: 17, signal: null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.messages.some(m => m.method === 'thread/delta' && m.params.deltas.some(d => d.kind === 'turn.boundary' && d.status === 'failed')));
  assert.equal(closed, 1);
  assert.equal((await h.call('thread/start', start)).result.providerThreadId, 'native');
  h.bridge.onClose();
});

test('reviewer bridge cancels catalog requests and refuses new ones after shutdown', async () => {
  let signal;
  let calls = 0;
  const h = harness(undefined, input => {
    calls++;
    signal = input.signal;
    return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('catalog cancelled')), { once: true }));
  });
  h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'catalog', method: 'model/list', params: {} }));
  await new Promise(resolve => setImmediate(resolve));
  h.bridge.onClose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal?.aborted, true);
  assert.match(h.messages.find(m => m.id === 'catalog')?.error.message ?? '', /catalog cancelled/);
  assert.match((await h.call('model/list', {})).error.message, /closing/);
  assert.equal(calls, 1);
});

for (const outcome of ['cancelled', 'refused']) test(`reviewer drops item events from a ${outcome} turn start`, async () => {
  let input;
  let rejectTurn;
  const h = harness(async options => {
    input = options;
    return { threadId: 'native', profile: { model: 'model' }, close: async () => rejectTurn?.(new Error('stream is closed')),
      request: async () => {
        input.notify({ method: 'item/started', params: { turnId: 'pending', item: { type: 'agentMessage', id: 'partial' } } });
        input.notify({ method: 'item/agentMessage/delta', params: { turnId: 'pending', itemId: 'partial', delta: 'Partial' } });
        return new Promise((_, reject) => { rejectTurn = reject; });
      } };
  });
  await h.call('thread/start', start);
  h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'pending-start', method: 'turn/start', params: {
    threadId: 'bb-thread', providerThreadId: 'native', clientRequestId: 'creq_abcdefghjk',
    input: [{ type: 'text', text: 'Review' }], options: start.options } }));
  await new Promise(resolve => setImmediate(resolve));
  if (outcome === 'cancelled') {
    assert.deepEqual((await h.call('thread/stop', { threadId: 'bb-thread', providerThreadId: 'native', activeTurnId: null, intent: 'release' })).result, {});
  } else rejectTurn(new Error('native rejected'));
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.match(h.messages.find(m => m.id === 'pending-start').error.message, /stream is closed|native rejected/);
  const assembler = createAssembler({ providerId: 'promptobus-codex-reviewer', textDeltaFlushMs: 0 });
  const events = h.messages.filter(m => m.method === 'thread/delta').flatMap(m => assembler.assemble(m.params));
  assert.deepEqual(events, [], 'Refused input cannot create an orphan timeline item or turn');
  h.bridge.onClose();
});

test('reviewer native exit during turn start frees the executor before another start', async () => {
  let input;
  let rejectTurn;
  let opens = 0;
  let closed = 0;
  const h = harness(async options => {
    input = options;
    const threadId = `native-${++opens}`;
    return { threadId, profile: { model: 'model' }, close: async () => { closed++; },
      request: async () => new Promise((_, reject) => { rejectTurn = reject; }) };
  });
  const started = await h.call('thread/start', start);
  h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'pending-start', method: 'turn/start', params: {
    threadId: 'bb-thread', providerThreadId: started.result.providerThreadId, clientRequestId: 'creq_abcdefghjk',
    input: [{ type: 'text', text: 'Review' }], options: start.options } }));
  await new Promise(resolve => setImmediate(resolve));
  rejectTurn(new Error('stream is closed'));
  input.notify({ method: 'reviewer/closed', params: { code: 17, signal: null } });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.match(h.messages.find(m => m.id === 'pending-start').error.message, /stream is closed/);
  assert.equal((await h.call('thread/start', start)).result?.providerThreadId, 'native-2');
  assert.equal(closed, 1);
  h.bridge.onClose();
});

test('reviewer refuses new input while Stop waits for native interrupt acknowledgement', async () => {
  let input;
  let acknowledge;
  let turns = 0;
  let closed = 0;
  const h = harness(async options => {
    input = options;
    return { threadId: 'native', profile: { model: 'model' }, close: async () => { closed++; }, request: async method => {
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}` } };
      return new Promise(resolve => { acknowledge = resolve; });
    } };
  });
  await h.call('thread/start', start);
  const turn = { threadId: 'bb-thread', providerThreadId: 'native', clientRequestId: 'creq_abcdefghjk',
    input: [{ type: 'text', text: 'Review' }], options: start.options };
  await h.call('turn/start', turn);
  h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'pending-stop', method: 'thread/stop', params: {
    threadId: 'bb-thread', providerThreadId: 'native', activeTurnId: 'turn-1', intent: 'interrupt' } }));
  await new Promise(resolve => setImmediate(resolve));
  input.notify({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'interrupted' } } });
  const followup = await h.call('turn/start', { ...turn, clientRequestId: 'creq_abcdefghjm' });
  acknowledge({});
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.match(followup.error?.message ?? '', /stopping/);
  assert.equal(turns, 1);
  assert.deepEqual(h.messages.find(m => m.id === 'pending-stop').result, {});
  assert.equal(closed, 1);
});

test('a stale reviewer Stop refuses without closing a different active turn', async () => {
  let input;
  let requests = 0;
  let closed = 0;
  const h = harness(async options => {
    input = options;
    return { threadId: 'native', profile: { model: 'model' }, close: async () => { closed++; },
      request: async () => { requests++; return { turn: { id: 'current-turn' } }; } };
  });
  await h.call('thread/start', start);
  await h.call('turn/start', { threadId: 'bb-thread', providerThreadId: 'native', clientRequestId: 'creq_abcdefghjk',
    input: [{ type: 'text', text: 'Review' }], options: start.options });
  const reply = await h.call('thread/stop', { threadId: 'bb-thread', providerThreadId: 'native', activeTurnId: 'stale-turn', intent: 'interrupt' });
  assert.match(reply.error.message, /active turn identity mismatch/);
  assert.equal(requests, 1);
  assert.equal(closed, 0);
  assert.ok(!h.messages.some(m => m.method === 'thread/delta' && m.params.deltas.some(d => d.kind === 'turn.boundary')));
  input.notify({ method: 'turn/completed', params: { turn: { id: 'current-turn', status: 'completed' } } });
  assert.ok(h.messages.some(m => m.method === 'thread/delta' && m.params.deltas.some(d => d.kind === 'turn.boundary' && d.status === 'completed')));
  h.bridge.onClose();
});

test('late BB read-tool responses after Stop do not produce unsolicited protocol errors', async () => {
  let input;
  const h = harness(async options => {
    input = options;
    return { threadId: 'native', profile: { model: 'model' }, close: async () => {}, request: async () => ({}) };
  });
  await h.call('thread/start', start);
  const reading = input.invoke({ tool: 'pb_review_read_file', arguments: { path: '/review/file' } });
  const toolCall = h.messages.find(m => m.method === 'item/tool/call');
  assert.ok(toolCall);
  await h.call('thread/stop', { threadId: 'bb-thread', providerThreadId: 'native', activeTurnId: null, intent: 'release' });
  assert.equal((await reading).success, false);
  const before = h.messages.length;
  h.bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: toolCall.id, result: { content: 'Read finished', isError: false } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messages.length, before);
});

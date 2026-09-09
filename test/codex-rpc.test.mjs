// CodexRpc dispatch: a server-to-client request is not a reply to a pending
// client call, even when the integer ids collide. The module's first unit
// test; the app-server stub elsewhere allocates `srv-<uuid>`, so it cannot
// reach this branch. Run: npm test
import { PassThrough } from 'node:stream';
import { check } from './check.mjs';
import { CodexRpc } from '../lib/codex-rpc.js';

function streams() {
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  return { incoming, outgoing, rpc: CodexRpc({ stdin: outgoing, stdout: incoming }) };
}

function feed(incoming, obj) {
  incoming.write(`${JSON.stringify(obj)}\n`);
}

function linesOf(buf) {
  return String(buf).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

{
  const { incoming, outgoing, rpc } = streams();
  let out = '';
  outgoing.on('data', (c) => { out += String(c); });
  const handled = [];
  rpc.onServerRequest((msg) => {
    handled.push(msg);
    return { decision: 'accept' };
  });

  const pending = rpc.request('turn/start', { threadId: 't-1' }, 2_000);
  await new Promise((r) => { setImmediate(r); });
  const sent = linesOf(out);
  const clientId = sent[0]?.id;
  check(': the client request went out with an integer id',
    sent.length === 1 && sent[0].method === 'turn/start' && Number.isInteger(clientId),
    JSON.stringify(sent));

  feed(incoming, {
    jsonrpc: '2.0',
    id: clientId,
    method: 'item/commandExecution/requestApproval',
    params: { cwd: '/tmp' },
  });
  await new Promise((r) => { setTimeout(r, 40); });

  const raced = await Promise.race([
    pending.then((msg) => ({ settled: true, msg })),
    new Promise((r) => { setTimeout(() => r({ settled: false }), 60); }),
  ]);
  const replies = linesOf(out).slice(1);
  check(': a colliding server request runs the handler, not the pending client promise',
    handled.length === 1
      && handled[0].method === 'item/commandExecution/requestApproval'
      && raced.settled === false,
    `handled=${handled.length} settled=${raced.settled} msg=${JSON.stringify(raced.msg ?? null)}`);
  check(': a reply to the approval is written while turn/start stays pending',
    replies.some((m) => m.id === clientId && m.result?.decision === 'accept' && !m.method),
    JSON.stringify(replies));

  feed(incoming, { jsonrpc: '2.0', id: clientId, result: { turn: { id: 'turn-ok' } } });
  const ans = await pending;
  check(': the client request later resolves to its own JSON-RPC result',
    ans.result?.turn?.id === 'turn-ok' && !ans.method,
    JSON.stringify(ans));
  rpc.close();
}

{
  const incoming = new PassThrough();
  const outgoing = new PassThrough();
  const logs = [];
  const rpc = CodexRpc({ stdin: outgoing, stdout: incoming }, {
    onLog: (dir, msg) => { logs.push({ dir, msg }); },
  });
  feed(incoming, { jsonrpc: '2.0', id: 999001, result: { unexpected: true } });
  await new Promise((r) => { setTimeout(r, 40); });
  check(': an unmatched response is logged as orphan rather than dropped in silence',
    logs.some((e) => e.dir === 'orphan' && e.msg?.id === 999001),
    JSON.stringify(logs));
  rpc.close();
}

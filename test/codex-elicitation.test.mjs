// Codex elicitation: one method, several questions — 03-cli § The Codex holder. Run: npm test
// Asserts the REPLY on the wire, not the decision: PB-161.4 is where the two disagree.
import { check } from './check.mjs';
import { approvalReply, decideApproval, serverRequestSummary } from '../lib/codex-session.js';

const SECRET = 'SECRET-PROMPT-DO-NOT-LOG';

/** A server's own elicitation: a question to a person, and there is none. */
const params = {
  serverName: 'probe-mcp',
  threadId: 'thread-1',
  mode: 'form',
  message: SECRET,
  requestedSchema: { type: 'object', properties: { token: { type: 'string' } } },
  url: 'https://example.invalid/elicit',
};

// The shape codex-cli 0.146.0 actually sends for its own per-call MCP tool approval:
// an EMPTY object schema, no `required`, no option field. Read from codex-rs at tag
// rust-v0.146.0 (`core/src/mcp_tool_call.rs`, `app-server-protocol/.../v2/mcp.rs`), not
// captured off a wire — the holder does not log payloads, and saying which it is matters.
const approval = {
  serverName: 'promptobus-promptobus',
  threadId: 'thread-1',
  mode: 'form',
  message: SECRET,
  requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call' },
};

const worker = { cwd: '/tmp/wt', addDirs: [], role: 'worker' };
const reviewer = { cwd: '/tmp/wt', addDirs: [], role: 'reviewer' };

const reply = (p, record) => {
  const d = decideApproval('mcpServer/elicitation/request', p, record);
  return approvalReply('mcpServer/elicitation/request', d.allow);
};

{
  const d = decideApproval('mcpServer/elicitation/request', params, worker);
  check(': a worker elicitation from a server is declined — the participant has no person to answer',
    d.allow === false && /no person/.test(d.why), JSON.stringify(d));
}

{
  const d = decideApproval('mcpServer/elicitation/request', params, reviewer);
  check(': a reviewer elicitation from a server is declined the same way',
    d.allow === false && /no person/.test(d.why), JSON.stringify(d));
}

{
  const r = reply(params, reviewer);
  check(': a server elicitation is answered with a decline and nothing else',
    r.action === 'decline' && Object.keys(r).length === 1, JSON.stringify(r));
}

// Where the defect lives: a decline here is what killed every bus call of a live reviewer.
// `content: {}` under `action: "accept"` is Accept by design for this request — the schema
// has no fields to answer, so there is nothing to fill and nothing to get wrong.
for (const [role, record] of [['worker', worker], ['reviewer', reviewer]]) {
  const r = reply(approval, record);
  check(`: codex-cli's own tool approval is accepted for a ${role} — the bus call survives`,
    r.action === 'accept' && JSON.stringify(r.content) === '{}', JSON.stringify(r));
}

// The discriminator is a STRING MATCH, not a truthiness test. `tool_suggestion` is a real
// second value of the same `_meta` key — it asks to install or enable a tool, which is a
// question to a person, and accepting it would let one through with nobody there.
for (const kind of ['tool_suggestion', 'something_new', 'MCP_TOOL_CALL', 'mcp_tool_call ']) {
  const p = { ...approval, _meta: { codex_approval_kind: kind } };
  const d = decideApproval('mcpServer/elicitation/request', p, reviewer);
  const r = approvalReply('mcpServer/elicitation/request', d.allow);
  check(`: kind «${kind}» is NOT a tool-call approval and is declined`,
    d.allow === false && r.action === 'decline', JSON.stringify({ d, r }));
}

{
  // A non-string marker must not be coerced into one. `String({})` is `[object Object]`,
  // which is truthy and would have been accepted by a truthiness test.
  const p = { ...approval, _meta: { codex_approval_kind: { tool: 'mcp_tool_call' } } };
  const d = decideApproval('mcpServer/elicitation/request', p, reviewer);
  check(': an object where the kind should be is declined, not coerced',
    d.allow === false, JSON.stringify(d));
}

{
  const { _meta, ...noMarker } = approval;
  void _meta;
  const d = decideApproval('mcpServer/elicitation/request', noMarker, reviewer);
  check(': the same request without the marker falls back to the decline PB-41 decided on',
    d.allow === false && /no person/.test(d.why), JSON.stringify(d));
}

{
  const d = decideApproval('currentTime/read', {}, worker);
  check(': currentTime/read stays allowed', d.allow === true, JSON.stringify(d));
}

{
  const d = decideApproval('item/tool/requestUserInput', { questions: [] }, reviewer);
  check(': requestUserInput stays allowed', d.allow === true, JSON.stringify(d));
}

{
  const s = serverRequestSummary('mcpServer/elicitation/request', params);
  const blob = JSON.stringify(s);
  check(': the allowlisted summary names method, server, mode and shape only',
    s.method === 'mcpServer/elicitation/request' && s.server === 'probe-mcp' && s.mode === 'form'
      && s.schema === true && s.kind === null
      && !blob.includes(SECRET) && !blob.includes('requestedSchema') && !blob.includes('example.invalid'),
    blob);
}

{
  // The field that names the asker — without it the next live turn is unsettleable.
  const s = serverRequestSummary('mcpServer/elicitation/request', approval);
  const blob = JSON.stringify(s);
  check(': the summary names WHICH question codex-cli asked, and still no message',
    s.kind === 'mcp_tool_call' && s.schema === true && !blob.includes(SECRET), blob);
}

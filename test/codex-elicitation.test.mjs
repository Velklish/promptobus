// Codex elicitation: one method, two questions — 03-cli § The Codex holder. Run: npm test
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

// Codex-cli raising its OWN per-call tool approval on the same method. The two schema
// spellings are the single-select arms of the measured `McpElicitationSchema`.
const DECLINE = '__codex_mcp_decline__';
const approvalUntitled = {
  serverName: 'promptobus-promptobus',
  threadId: 'thread-1',
  mode: 'form',
  message: SECRET,
  requestedSchema: {
    type: 'object',
    required: ['__approval'],
    properties: { __approval: { type: 'string', enum: ['accept', 'accept_session', 'accept_always', DECLINE] } },
  },
  _meta: { codex_approval_kind: 'mcp_tool_call' },
};
const approvalTitled = {
  ...approvalUntitled,
  requestedSchema: {
    type: 'object',
    required: ['__approval'],
    properties: {
      __approval: {
        type: 'string',
        oneOf: [{ const: DECLINE, title: 'Cancel this tool call' }, { const: 'accept', title: 'Allow' }],
      },
    },
  },
};

const worker = { cwd: '/tmp/wt', addDirs: [], role: 'worker' };
const reviewer = { cwd: '/tmp/wt', addDirs: [], role: 'reviewer' };

const reply = (p, record) => {
  const d = decideApproval('mcpServer/elicitation/request', p, record);
  return approvalReply('mcpServer/elicitation/request', d.allow, p);
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

// Where the defect lives: action AND content together — a blank accept answers a
// required field with nothing, which is what the old table sent.
for (const [name, p] of [['bare enum', approvalUntitled], ['titled oneOf', approvalTitled]]) {
  for (const [role, record] of [['worker', worker], ['reviewer', reviewer]]) {
    const r = reply(p, record);
    check(`: codex-cli's own tool approval (${name}) is accepted for a ${role} — the bus call survives`,
      r.action === 'accept', JSON.stringify(r));
    check(`: the accept (${name}, ${role}) answers the required field with a non-decline option`,
      r.content?.__approval === 'accept', JSON.stringify(r));
  }
}

{
  // An answer that picks the sentinel is a decline wearing an accept's action.
  const r = reply({ ...approvalTitled, requestedSchema: {
    type: 'object',
    required: ['__approval'],
    properties: { __approval: { type: 'string', enum: [DECLINE] } },
  } }, reviewer);
  check(': the decline sentinel is never chosen as an answer',
    r.action === 'accept' && r.content?.__approval === undefined, JSON.stringify(r));
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
  const s = serverRequestSummary('mcpServer/elicitation/request', approvalUntitled);
  const blob = JSON.stringify(s);
  check(': the summary names WHICH question codex-cli asked, and still no message',
    s.kind === 'mcp_tool_call' && s.schema === true && !blob.includes(SECRET) && !blob.includes(DECLINE),
    blob);
}

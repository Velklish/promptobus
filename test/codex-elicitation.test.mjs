// Codex elicitation: the holder declines mcpServer/elicitation/request so the
// turn continues, and the log carries only allowlisted fields. Run: npm test
import { check } from './check.mjs';
import { decideApproval, serverRequestSummary } from '../lib/codex-session.js';

const SECRET = 'SECRET-PROMPT-DO-NOT-LOG';
const params = {
  serverName: 'probe-mcp',
  threadId: 'thread-1',
  mode: 'form',
  message: SECRET,
  requestedSchema: { type: 'object', properties: { token: { type: 'string' } } },
  url: 'https://example.invalid/elicit',
};

const worker = { cwd: '/tmp/wt', addDirs: [], role: 'worker' };
const reviewer = { cwd: '/tmp/wt', addDirs: [], role: 'reviewer' };

{
  const d = decideApproval('mcpServer/elicitation/request', params, worker);
  check(': a worker elicitation is declined — the participant has no person to answer',
    d.allow === false && /no person/.test(d.why), JSON.stringify(d));
}

{
  const d = decideApproval('mcpServer/elicitation/request', params, reviewer);
  check(': a reviewer elicitation is declined the same way',
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
  check(': the allowlisted summary names method, server and mode only',
    s.method === 'mcpServer/elicitation/request' && s.server === 'probe-mcp' && s.mode === 'form'
      && !blob.includes(SECRET) && !blob.includes('requestedSchema') && !blob.includes('example.invalid'),
    blob);
}

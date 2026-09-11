// PB-178: who a session is, asked of the drivers. Run: npm test
// The environments below are fixtures of MEASURED shapes, named beside each case.
import { check } from './check.mjs';
import { identityCandidates, resolveSessionIdentity, REGISTRY } from '../lib/drivers.js';

const VARS = Object.fromEntries(
  Object.entries(REGISTRY.drivers).map(([h, d]) => [h, d.options.identityVar]),
);

{
  check(': every declared driver answers the identity member — none is left out of the contract',
    Object.values(VARS).every((v) => typeof v === 'string' || v === null)
      && Object.keys(VARS).length === 3,
    JSON.stringify(VARS));
}

{
  // Measured: cursor-agent 2026.09.10 sets CURSOR_CONVERSATION_ID for its shell tool;
  // codex-cli 0.146.0 carries CODEX_THREAD_ID. Claude's is the one the store always read.
  const distinct = new Set(Object.values(VARS).filter(Boolean));
  check(': no two harnesses claim the same variable — the answer would be ambiguous by construction',
    distinct.size === Object.values(VARS).filter(Boolean).length, JSON.stringify([...distinct]));
}

for (const [harness, variable] of Object.entries(VARS)) {
  if (!variable) continue;
  const a = resolveSessionIdentity({ [variable]: '  sid-1  ' });
  check(`: a lone ${harness} session is identified by ${variable}, trimmed`,
    a.id === 'sid-1' && a.harness === harness && a.why === null, JSON.stringify(a));
}

{
  // The negative control. Without it the case above passes on a reader that ignores the
  // environment and returns the first driver's answer whatever is set.
  const a = resolveSessionIdentity({});
  check(': an environment naming no harness gets null WITH a reason, not a silent null',
    a.id === null && typeof a.why === 'string' && a.why.includes(VARS.claude),
    JSON.stringify(a));
}

{
  // The shape a live Codex participant actually has: its own CODEX_THREAD_ID plus the
  // orchestrator's CLAUDE_CODE_SESSION_ID, leaked because SESSION_ENV_DROP drops only
  // CODEX_HOME (measured 2026-09-12; the leak itself is PB-182). The old reader returned
  // the PARENT's id here — a wrong answer, not a missing one.
  const env = { CODEX_THREAD_ID: 'mine', CLAUDE_CODE_SESSION_ID: 'my-parent' };
  const a = resolveSessionIdentity(env);
  check(': two harnesses at once is refused, and neither id is handed out',
    a.id === null && a.candidates.length === 2 && !JSON.stringify(a.id).includes('my-parent'),
    JSON.stringify(a));
  check(': the refusal names both claimants, so the leak is readable from the message',
    a.why.includes('codex') && a.why.includes('claude')
      && a.why.includes('CODEX_THREAD_ID') && a.why.includes('CLAUDE_CODE_SESSION_ID'),
    a.why);
}

{
  // An empty string is not an identity: a variable exported with no value is the shape a
  // harness leaves behind when it starts a child without a session.
  const a = resolveSessionIdentity({ [VARS.claude]: '   ' });
  check(': a variable set to whitespace does not count as an answer',
    a.id === null && a.candidates.length === 0, JSON.stringify(a));
}

{
  const list = identityCandidates({ [VARS.cursor]: 'c1' });
  check(': candidates name the variable they were read from',
    list.length === 1 && list[0].variable === VARS.cursor && list[0].harness === 'cursor',
    JSON.stringify(list));
}

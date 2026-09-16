// PB-178: who a session is, asked of the drivers. Run: npm test
// The environments below are fixtures of MEASURED shapes, named beside each case.
import { check } from './check.mjs';
import { HARNESS_IDENTITY_VARS } from './hygiene.mjs';
import { identityCandidates, resolveSessionIdentity, REGISTRY } from '../lib/drivers.js';
import { bindSessionIdentity, sessionIdentity } from '../lib/store.js';

const VARS = Object.fromEntries(
  Object.entries(REGISTRY.drivers).map(([h, d]) => [h, d.options.identityVar]),
);
const MCP_RECORDS = Object.fromEntries(
  Object.entries(REGISTRY.drivers).map(([h, d]) => [h, d.options.mcpIdentity]),
);

{
  check(': every declared driver answers the identity member — none is left out of the contract',
    Object.values(VARS).every((v) => typeof v === 'string' || v === null)
      && Object.keys(VARS).length === 3,
    JSON.stringify(VARS));
}
{
  check('PB-206.6: every driver answers the distinct MCP-child identity member',
    MCP_RECORDS.claude === null
    && MCP_RECORDS.codex?.recordVar === 'PROMPTOBUS_CODEX_SESSION'
    && MCP_RECORDS.codex?.idField === 'threadId'
    && MCP_RECORDS.cursor?.recordVar === 'PROMPTOBUS_CURSOR_SESSION'
    && MCP_RECORDS.cursor?.idField === 'chatId'
    && new Set(Object.values(MCP_RECORDS).filter(Boolean).map((proof) => proof.recordVar)).size === 2,
    JSON.stringify(MCP_RECORDS));
}

{
  const driverVars = Object.values(VARS).filter(Boolean);
  const additional = HARNESS_IDENTITY_VARS.filter((name) => !driverVars.includes(name));
  check(': suite hygiene covers every driver identity plus the Claude host identity from one list',
    driverVars.every((name) => HARNESS_IDENTITY_VARS.includes(name))
    && new Set(HARNESS_IDENTITY_VARS).size === HARNESS_IDENTITY_VARS.length
    && additional.length === 1 && additional[0] === 'CLAUDE_CODE_HOST_SESSION_ID',
    JSON.stringify({ driverVars, hygiene: HARNESS_IDENTITY_VARS, additional }));
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
  // PB-218: nothing and too much are opposite troubles, and the resolver must not answer
  // both with one null. The state is a NAME on the answer — prose alone left the reader of
  // a refusal hunting for a variable that was there twice over.
  const none = resolveSessionIdentity({});
  const two = resolveSessionIdentity({ [VARS.claude]: 'parent', [VARS.codex]: 'mine' });
  const one = resolveSessionIdentity({ [VARS.claude]: 'alone' });
  check('PB-218: the two nulls are told apart by name, not by counting candidates at the caller',
    none.reason === 'none' && two.reason === 'contested' && none.reason !== two.reason,
    JSON.stringify({ none: none.reason, two: two.reason }));
  check('PB-218: a resolved identity is named too, so "resolved" is not the absence of a reason',
    one.reason === 'resolved' && one.id === 'alone' && one.why === null, JSON.stringify(one));
  check('PB-218: the contested reason says to REMOVE, and names both variables to choose between',
    two.why.includes(VARS.claude) && two.why.includes(VARS.codex)
    && /removing it answers/.test(two.why) && !/missing.*variable to add|add the missing/.test(two.why),
    two.why);
  check('PB-218: the empty environment is not told to remove anything — there is nothing there',
    !/removing it answers/.test(none.why), none.why);
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

// The core's own door, which is where the defect lived. Unbound it must not fall back to
// one harness's variable — the fallback IS the defect.
{
  const env = { [VARS.claude]: 'sid-unbound' };
  bindSessionIdentity(null);
  check(': unbound, the core answers null rather than reading a harness variable itself',
    sessionIdentity(env) === null, JSON.stringify(sessionIdentity(env)));
  bindSessionIdentity(resolveSessionIdentity);
  check(': bound, the same environment gets its id',
    sessionIdentity(env) === 'sid-unbound', JSON.stringify(sessionIdentity(env)));
  check(': bound, the leaked pair gets null through the core too — not the parent id',
    sessionIdentity({ [VARS.codex]: 'mine', [VARS.claude]: 'my-parent' }) === null,
    JSON.stringify(sessionIdentity({ [VARS.codex]: 'mine', [VARS.claude]: 'my-parent' })));
}

// Codex elicitation: one method, several questions — 03-cli § The Codex holder. Run: npm test
// Asserts the REPLY on the wire, not the decision: PB-161.4 is where the two disagree.
import './home.mjs';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { check } from './check.mjs';
import { codexFixtureDir } from './harness-codex.mjs';
import { makeSandbox } from './sandbox.mjs';
import { codexHomeConfig } from '../lib/driver-codex.js';
import {
  approvalReply, codexMcpServers, configuredMcpServers, decideApproval, serverRequestSummary,
} from '../lib/codex-session.js';

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

function homeWith(servers) {
  const dir = makeSandbox('promptobus-codex-elicit-');
  writeFileSync(path.join(dir, 'config.toml'), codexHomeConfig({ servers }));
  return dir;
}

const mechanismServers = codexMcpServers({
  promptobus: { type: 'stdio', command: 'node', args: ['mcp.js'], env: { BUS: '1' } },
}, 'promptobus-').servers;
const otherServers = codexMcpServers({
  'bus.tools': { type: 'stdio', command: 'node', args: [], env: {} },
}, 'promptobus-').servers;
const MECHANISM_SERVER = 'promptobus-promptobus';
const OTHER_SERVER = 'promptobus-bus.tools';
const configuredHome = homeWith(mechanismServers);
const otherHome = homeWith(otherServers);

const worker = { cwd: '/tmp/wt', addDirs: [], role: 'worker', codexHome: configuredHome };
const reviewer = { cwd: '/tmp/wt', addDirs: [], role: 'reviewer', codexHome: configuredHome };
const approver = { cwd: '/tmp/wt', addDirs: [], role: 'approver', codexHome: configuredHome };
const otherParticipant = { cwd: '/tmp/wt', addDirs: [], role: 'reviewer', codexHome: otherHome };

const elicit = (p, record, configured = configuredMcpServers(record)) =>
  decideApproval('mcpServer/elicitation/request', p, record, configured);

const reply = (p, record, configured) => {
  const d = elicit(p, record, configured);
  return approvalReply('mcpServer/elicitation/request', d.allow);
};

{
  const d = elicit(params, worker);
  check(': a worker elicitation from a server is declined — the participant has no person to answer',
    d.allow === false && /no person/.test(d.why), JSON.stringify(d));
}

{
  const d = elicit(params, reviewer);
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
for (const [role, record] of [['worker', worker], ['reviewer', reviewer], ['approver', approver]]) {
  const r = reply(approval, record);
  check(`: codex-cli's own tool approval is accepted for role ${role} — the bus call survives`,
    r.action === 'accept' && JSON.stringify(r.content) === '{}', JSON.stringify(r));
}

for (const [role, record] of [['worker', worker], ['reviewer', reviewer], ['approver', approver]]) {
  const foreign = { ...approval, serverName: 'codex_apps' };
  const d = elicit(foreign, record);
  const r = approvalReply('mcpServer/elicitation/request', d.allow);
  check(`: a tool-call elicitation from an unconfigured server is refused for role ${role}`,
    d.allow === false && r.action === 'decline' && /does not configure/.test(d.why)
      && /codex_apps/.test(d.why),
    JSON.stringify({ d, r }));
}

{
  const d = elicit(approval, worker);
  const r = reply(approval, worker);
  check(': a tool-call elicitation from the mechanism server is allowed',
    approval.serverName === MECHANISM_SERVER && d.allow === true && r.action === 'accept',
    JSON.stringify(d));
}

{
  const named = { ...approval, serverName: OTHER_SERVER };
  const allowed = elicit(named, otherParticipant);
  const refused = elicit(approval, otherParticipant);
  check(': a tool-call elicitation is allowed only for the server that participant\'s home configures',
    allowed.allow === true && refused.allow === false && /does not configure/.test(refused.why)
      && /promptobus-promptobus/.test(refused.why),
    JSON.stringify({ allowed, refused }));
}

{
  const nested = { ...approval, serverName: `${MECHANISM_SERVER}.env` };
  const d = elicit(nested, worker);
  check(': a nested mcp_servers table is not a server the holder may approve',
    d.allow === false && /does not configure/.test(d.why), JSON.stringify(d));
}

{
  const bare = { ...approval };
  delete bare.serverName;
  const d = elicit(bare, worker);
  const r = approvalReply('mcpServer/elicitation/request', d.allow);
  check(': a tool-call elicitation with no serverName is refused',
    d.allow === false && r.action === 'decline' && /«absent»/.test(d.why), JSON.stringify(d));
}

{
  const { codexHome, ...noHome } = worker;
  void codexHome;
  const d = elicit(approval, noHome);
  check(': a tool-call elicitation with no participant home on the record is refused',
    d.allow === false && /no Codex home/.test(d.why), JSON.stringify(d));
}

{
  const missing = { ...worker, codexHome: path.join(configuredHome, 'no-such-home') };
  const d = elicit(approval, missing);
  check(': a tool-call elicitation whose home config cannot be read is refused',
    d.allow === false && /could not be read/.test(d.why), JSON.stringify(d));
}

{
  const dir = homeWith(mechanismServers);
  const record = { cwd: '/tmp/wt', addDirs: [], role: 'worker', codexHome: dir };
  const snapshot = configuredMcpServers(record);
  appendFileSync(path.join(dir, 'config.toml'), '\n[mcp_servers.codex_apps]\ncommand = "x"\n');
  const live = configuredMcpServers(record);
  const appended = { ...approval, serverName: 'codex_apps' };
  const d = elicit(appended, record, snapshot);
  const still = elicit(approval, record, snapshot);
  check(': a config.toml appended after the holder snapshot does not widen the approved set',
    live.ok === true && live.names.has('codex_apps')
      && elicit(appended, record, live).allow === true
      && d.allow === false && /does not configure/.test(d.why)
      && still.allow === true,
    JSON.stringify({ d, still, live: live.ok ? [...live.names] : live.why }));
}

// The discriminator is a STRING MATCH, not a truthiness test. `tool_suggestion` is a real
// second value of the same `_meta` key — it asks to install or enable a tool, which is a
// question to a person, and accepting it would let one through with nobody there.
for (const kind of ['tool_suggestion', 'something_new', 'MCP_TOOL_CALL', 'mcp_tool_call ']) {
  const p = { ...approval, _meta: { codex_approval_kind: kind } };
  const d = elicit(p, reviewer);
  const r = approvalReply('mcpServer/elicitation/request', d.allow);
  check(`: kind «${kind}» is NOT a tool-call approval and is declined`,
    d.allow === false && r.action === 'decline', JSON.stringify({ d, r }));
}

// A non-string marker must not be coerced into one, and the array is the case a strict
// COMPARISON does not catch on its own: `String(['mcp_tool_call'])` is the allowed
// discriminator exactly, so the coercion had to go, not the comparison.
for (const [name, kind] of [
  ['an object', { tool: 'mcp_tool_call' }],
  ['an array holding the allowed value', ['mcp_tool_call']],
  ['an array of one allowed value among others', ['mcp_tool_call', 'x']],
  ['a number', 1],
  ['true', true],
  ['null', null],
]) {
  const p = { ...approval, _meta: { codex_approval_kind: kind } };
  const d = elicit(p, reviewer);
  const r = approvalReply('mcpServer/elicitation/request', d.allow);
  check(`: ${name} where the kind should be is declined, not coerced`,
    d.allow === false && r.action === 'decline', JSON.stringify({ kind, d, r }));
}

{
  const { _meta, ...noMarker } = approval;
  void _meta;
  const d = elicit(noMarker, reviewer);
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
  const schema = JSON.parse(readFileSync(path.join(codexFixtureDir, 'ToolRequestUserInputResponse.json'), 'utf8'));
  const validates = new Ajv({ strict: false }).compile(schema);
  const questions = [
    { id: 'choice', options: [{ label: 'Approve', description: 'Proceed' }] },
    { id: 'freeform', options: null },
  ];
  const accepted = approvalReply('item/tool/requestUserInput', true, { questions });
  const declined = approvalReply('item/tool/requestUserInput', false, { questions });
  check(': requestUserInput replies use the proven schema and invent no human answer',
    validates(accepted) && validates(declined)
      && JSON.stringify(accepted) === JSON.stringify({ answers: {
        choice: { answers: [] }, freeform: { answers: [] },
      } })
      && JSON.stringify(declined) === '{"answers":{}}',
    JSON.stringify({ accepted, declined, errors: validates.errors }));
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

// The second half of the condition. Codex-cli classifies its own tool approval as the
// marker AND a message-only schema (`mcp_server_elicitation.rs`), and a marked request
// carrying a form to fill is a question to a person wearing the approval's label.
for (const [name, requestedSchema] of [
  ['a form with one field', { type: 'object', properties: { token: { type: 'string' } } }],
  ['a form with a required field', { type: 'object', required: ['token'], properties: { token: { type: 'string' } } }],
  ['properties that are not an object', { type: 'object', properties: ['token'] }],
  ['a schema that is not an object', 'string'],
]) {
  const p = { ...approval, requestedSchema };
  const d = elicit(p, reviewer);
  const r = approvalReply('mcpServer/elicitation/request', d.allow);
  check(`: the marker with ${name} is declined — an approval has nothing to fill`,
    d.allow === false && r.action === 'decline', JSON.stringify({ requestedSchema, d, r }));
}

// Shapes that are message-only in upstream, quoted from `mcp_server_elicitation.rs` at
// tag `rust-v0.146.0`:
//   let is_empty_object_schema = requested_schema.as_object().is_some_and(|schema| {
//       schema.get("type").and_then(Value::as_str) == Some("object")
//           && schema.get("properties").and_then(Value::as_object)
//               .is_some_and(serde_json::Map::is_empty)
//   });
//   let is_message_only_schema = requested_schema.is_null() || is_empty_object_schema;
// Only these two accept.
for (const [name, requestedSchema] of [
  ['an explicit null schema', null],
  ['an empty object schema', { type: 'object', properties: {} }],
]) {
  const p = { ...approval, requestedSchema };
  const d = elicit(p, reviewer);
  check(`: the marker with ${name} is accepted — nothing to fill is the approval's shape`,
    d.allow === true, JSON.stringify({ requestedSchema, d }));
}

// The guard is a WHITELIST: everything it does not prove is refused, including shapes
// nobody has catalogued. These are the ones that leaked through a filter chain one at a
// time — a different elicitation VARIANT, and a required field that is absent rather than
// explicitly null. Upstream applies the schema test inside the Form arm only.
// The plain URL case below does NOT prove the `mode` check: it carries no schema, so the
// fail-closed-on-absence rule refuses it too, and it stays green with `mode` removed.
// What proves `mode` is `mode: 'url'` with a VALID form schema, in the loop after it —
// everything lawful except the variant. Deleting that case as a duplicate deletes the
// only evidence for `mode` and leaves the probe green (measured: removing the `mode`
// check reddens three cases, and this one is not among them).
{
  const url = { ...approval, mode: 'url', elicitationId: 'e-1', url: 'https://example.invalid/approve' };
  delete url.requestedSchema;
  const d = elicit(url, reviewer);
  const r = approvalReply('mcpServer/elicitation/request', d.allow);
  check(': a URL elicitation carrying the marker is DECLINED — it is a different variant',
    d.allow === false && r.action === 'decline', JSON.stringify({ d, r }));
}

for (const [name, mutate] of [
  ['requestedSchema absent rather than null', (p) => { delete p.requestedSchema; }],
  ['mode absent', (p) => { delete p.mode; }],
  ['mode openai/form', (p) => { p.mode = 'openai/form'; }],
  ['mode url with a form schema', (p) => { p.mode = 'url'; }],
]) {
  const p = { ...approval };
  mutate(p);
  const d = elicit(p, reviewer);
  const r = approvalReply('mcpServer/elicitation/request', d.allow);
  check(`: the marker with ${name} is DECLINED — the whitelist proves every field it needs`,
    d.allow === false && r.action === 'decline', JSON.stringify({ p, d, r }));
}

// And the three shapes an earlier revision of this file accepted by reading the upstream
// condition as "no fields to fill" instead of quoting it. `properties` must be PRESENT
// and empty, and `type` must be `object`; neither is inferable from the other.
for (const [name, requestedSchema] of [
  ['a schema with no properties key', { type: 'object' }],
  ['a bare empty object', {}],
  ['empty properties under a non-object type', { type: 'string', properties: {} }],
  ['properties that are null', { type: 'object', properties: null }],
]) {
  const p = { ...approval, requestedSchema };
  const d = elicit(p, reviewer);
  const r = approvalReply('mcpServer/elicitation/request', d.allow);
  check(`: the marker with ${name} is DECLINED — upstream does not call that message-only`,
    d.allow === false && r.action === 'decline', JSON.stringify({ requestedSchema, d, r }));
}

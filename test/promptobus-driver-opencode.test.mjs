// OpenCode driver — the worker-lift halves. Run: npm test
//
// Subject: what `prepare` hands the lift (holder argv, config file, env), the registry entry,
// the holder protocol mapping against a stub server, and the availability probe. The live lift
// is the task's verification, run once by hand against the real binary.
import { check } from './check.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-driver-opencode-');

const {
  OPENCODE, opencodeDriver, prepare, permissionDeny, PERMISSION_MODES, apiArgv, parseSessionList,
  viewOf, REVIEWER_DENY, listSessionsSync, SESSION_RECORD_VAR,
} = await import(path.join(here, '..', 'lib', 'driver-opencode.js'));
const {
  holderPassword, holderUrl, portOfLog, idleOutcome, createSession, sendPrompt, readMessages,
  deleteSession, waitReady,
} = await import(path.join(here, '..', 'lib', 'opencode-session.js'));
const { REGISTRY } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { opencodeAvailability, OPENCODE_MIN_VERSION } = await import(
  path.join(here, '..', 'lib', 'model-routing', 'adapter-opencode.js'));

// --- registry ---------------------------------------------------------------

check(': opencode is registered under its own name',
  OPENCODE === 'opencode' && REGISTRY.drivers.opencode === opencodeDriver,
  Object.keys(REGISTRY.drivers).sort().join(','));

check(': worker capabilities are spawn/inspect/stop with pull activation and no approver lift',
  opencodeDriver.capabilities.spawn === true
  && opencodeDriver.capabilities.inspect === true
  && opencodeDriver.capabilities.stop === true
  && opencodeDriver.capabilities.activation === 'pull'
  && opencodeDriver.capabilities.approverLift !== true,
  JSON.stringify(opencodeDriver.capabilities));

check(': the default model names the owner-ordered provider and model',
  opencodeDriver.options.defaultModel === 'opencode-go/muse-spark-1.3-contributor',
  opencodeDriver.options.defaultModel);

check(': the contract dictionary is complete — deny list, pull channel, null identity',
  Array.isArray(opencodeDriver.options.denyTools) && opencodeDriver.options.denyTools.length > 0
  && opencodeDriver.options.knockChannel === 'pull'
  && opencodeDriver.options.identityVar === null
  && opencodeDriver.options.mcpIdentity?.recordVar === 'PROMPTOBUS_OPENCODE_SESSION',
  JSON.stringify({
    deny: opencodeDriver.options.denyTools,
    knock: opencodeDriver.options.knockChannel,
    identity: opencodeDriver.options.identityVar,
  }));

// --- holder words -----------------------------------------------------------

check(': holder passwords have the binary shape',
  /^[A-Za-z0-9]{43}$/.test(holderPassword()) && holderPassword() !== holderPassword(),
  'password shape or collision');

check(': the listening port is read off the holder log line',
  portOfLog('server listening on http://127.0.0.1:57936\n') === 57936
  && portOfLog('Server Listening on http://127.0.0.1:57936\n') === 57936
  && portOfLog('starting up\n') === null,
  'log port parse');

check(': holder url is loopback with the port',
  holderUrl(57936) === 'http://127.0.0.1:57936', holderUrl(57936));

check(': a trailing idle outcome ends the wait, anything else does not',
  idleOutcome({ data: [{ type: 'idle', outcome: 'succeeded' }] }) === 'succeeded'
  && idleOutcome({ data: [{ type: 'idle', outcome: 'succeeded' }, { type: 'assistant' }] }) === 'succeeded'
  && idleOutcome({ data: [{ type: 'assistant' }, { type: 'idle', outcome: 'succeeded' }] }) === null
  && idleOutcome({ data: [{ type: 'assistant' }] }) === null
  && idleOutcome({ data: [] }) === null,
  'idle outcome parse');

// --- prepare ----------------------------------------------------------------

const SERVERS = {
  promptobus: {
    type: 'stdio', command: 'node', args: ['bus.mjs'], env: { PROMPTOBUS_ROLE: 'worker:x' },
  },
  docs: { url: 'https://docs.example/mcp', headers: { api_key: 'k' } },
  skip: 'not-an-entry',
};
const planFor = (extra = {}) => prepare({
  ref: 'worker:x',
  mcp: { servers: SERVERS },
  prompt: 'work',
  model: null,
  permissionMode: 'auto',
  mcpConfigPath: path.join(SB, 'opencode.json'),
  env: {},
  ...extra,
});

const plan = planFor();
check(': argv lifts a holder on a chosen-at-start port, prompt beside it, not inside it',
  plan.argv.join(' ') === 'serve --port 0 --hostname 127.0.0.1'
  && plan.prompt === 'work'
  && plan.holder?.title === 'worker:x'
  && /^[A-Za-z0-9]{43}$/.test(plan.holder?.password ?? ''),
  JSON.stringify({ argv: plan.argv, holder: { ...plan.holder, password: '<redacted>' } }));

check(': the lift learns config, skills and password through env, and the worktree stays clean',
  plan.env.OPENCODE_CONFIG === path.join(SB, 'opencode.json')
  && typeof plan.env.OPENCODE_CONFIG_DIR === 'string'
  && plan.env.OPENCODE_SERVER_PASSWORD === plan.holder.password
  && opencodeDriver.options.launchDirs.length === 0,
  JSON.stringify({ config: plan.env.OPENCODE_CONFIG, dir: plan.env.OPENCODE_CONFIG_DIR }));

const written = JSON.parse(plan.files.find((f) => f.path === path.join(SB, 'opencode.json')).text);
check(': the config names the lift model default',
  written.model === 'opencode-go/muse-spark-1.3-contributor', written.model);

check(': stdio servers become local entries, url entries remote ones, junk is dropped',
  written.mcp.promptobus?.type === 'local'
  && written.mcp.promptobus?.command.join(' ') === 'node bus.mjs'
  && written.mcp.promptobus?.environment?.PROMPTOBUS_ROLE === 'worker:x'
  && written.mcp.docs?.type === 'remote'
  && written.mcp.docs?.url === 'https://docs.example/mcp'
  && !('skip' in written.mcp),
  JSON.stringify(written.mcp));

check(': no permission section without denied tools',
  written.permission === undefined, JSON.stringify(written));

const denied = JSON.parse(planFor({ denyTools: ['Edit', 'Bash'] }).files
  .find((f) => f.path === path.join(SB, 'opencode.json')).text);
check(': denied tools land in the permission map in opencode spelling',
  denied.permission?.edit === 'deny' && denied.permission?.bash === 'deny',
  JSON.stringify(denied.permission));
check(': the deny map helper lowercases unknown names instead of dropping them',
  permissionDeny(['CustomTool']).customtool === 'deny', JSON.stringify(permissionDeny(['CustomTool'])));

check(': only auto is a mode — anything else refuses in the engine',
  PERMISSION_MODES.join(',') === 'auto', PERMISSION_MODES.join(','));

let effortRefused = null;
try {
  planFor({ effort: 'high' });
} catch (error) {
  effortRefused = error;
}
check(': an explicit effort refuses — no variant mapping is guessed',
  effortRefused !== null && /effort/i.test(effortRefused.message ?? ''),
  effortRefused?.message ?? 'no refusal');

for (const role of ['reviewer', 'approver']) {
  let refused = null;
  try {
    planFor({ role });
  } catch (error) {
    refused = error;
  }
  check(`: a ${role} lift refuses — it would land without isolation`,
    refused !== null && new RegExp(role).test(refused.message ?? ''),
    refused?.message ?? 'no refusal');
}

// --- inspect core -----------------------------------------------------------

const RECORD = { url: 'http://127.0.0.1:9', password: 'secret', sessionId: 'ses_x', cwd: SB };
check(': the list call names the holder server and the list operation',
  apiArgv(RECORD).join(' ') === 'api --server http://127.0.0.1:9 session.list',
  apiArgv(RECORD).join(' '));

check(': the list envelope parses, garbage does not',
  parseSessionList(JSON.stringify({ data: [{ id: 'ses_x' }] }))?.[0]?.id === 'ses_x'
  && parseSessionList('nope') === null
  && parseSessionList(JSON.stringify({ data: {} })) === null,
  'envelope parse');

check(': the view is alive-busy without idle time, alive-idle with it, gone off-list',
  viewOf(RECORD, [{ id: 'ses_x', time: {} }]).busy === true
  && viewOf(RECORD, [{ id: 'ses_x', time: { idle: 1 } }]).busy === false
  && viewOf(RECORD, [{ id: 'ses_x', time: { idle: 1 } }]).state === 'alive'
  && viewOf(RECORD, [{ id: 'ses_other' }]).state === 'gone',
  'snapshot view');

check(': an unreadable list is unknown, not death',
  listSessionsSync(RECORD, () => ({ error: new Error('nope'), status: 1 })) === null
  && listSessionsSync(RECORD, () => ({ status: 0, stdout: 'garbage' })) === null,
  'unreadable list');

const boundPlan = planFor({ home: 'h', task: 't', address: 'worker:x' });
const boundCfg = JSON.parse(boundPlan.files.find((f) => f.path === path.join(SB, 'opencode.json')).text);
check(': a bound lift points its bus entry and env at the session record',
  boundCfg.mcp.promptobus?.environment?.[SESSION_RECORD_VAR] !== undefined
  && boundPlan.env[SESSION_RECORD_VAR] === boundCfg.mcp.promptobus.environment[SESSION_RECORD_VAR],
  JSON.stringify(boundCfg.mcp.promptobus?.environment));

check(': the reviewer deny list is non-empty opencode permission keys',
  REVIEWER_DENY.length > 0 && REVIEWER_DENY.every((k) => k === k.toLowerCase()),
  REVIEWER_DENY.join(','));

// --- inspect / stop without a record ----------------------------------------

check(': inspect with no record is unknown, not death',
  opencodeDriver.inspect('worker:x', {}) === null, 'non-null without a record');

const stopped = await opencodeDriver.stop('worker:x', {});
check(': stop with no record is idempotent',
  stopped.ok === true && stopped.stopped === false, JSON.stringify(stopped));

// --- holder protocol against a stub -----------------------------------------

const seen = [];
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    seen.push(`${req.method} ${req.url}`);
    const auth = req.headers.authorization ?? '';
    if (auth !== `Basic ${Buffer.from('opencode:secret').toString('base64')}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/api/session') return void res.end('[]');
    if (req.method === 'POST' && req.url === '/api/session') {
      return void res.end(JSON.stringify({ data: { id: 'ses_stub' } }));
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_stub/prompt') {
      const parsed = JSON.parse(body);
      if (parsed.text !== 'work') return void res.writeHead(400).end();
      return void res.end(JSON.stringify({ data: { id: 'msg_1' } }));
    }
    if (req.method === 'GET' && req.url === '/api/session/ses_stub/message?limit=5') {
      return void res.end(JSON.stringify({ data: [{ type: 'idle', outcome: 'succeeded' }] }));
    }
    if (req.method === 'DELETE' && req.url === '/api/session/ses_stub') {
      return void res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
});
await new Promise((resolve) => { stub.listen(0, '127.0.0.1', resolve); });
const stubUrl = holderUrl(stub.address().port);

check(': readiness is an answered session list',
  await waitReady(stubUrl, 'secret', { timeoutMs: 2000, stepMs: 50 }) === true
  && await waitReady(holderUrl(1), 'secret', { timeoutMs: 300, stepMs: 50 }) === false,
  'stub readiness');

const created = await createSession(stubUrl, 'secret', 'worker:x');
check(': session create returns the server id',
  created.status === 200 && created.data?.data?.id === 'ses_stub', JSON.stringify(created.data));

const sent = await sendPrompt(stubUrl, 'secret', 'ses_stub', 'work');
check(': the first turn posts the prompt text',
  sent.status === 200, JSON.stringify(sent.data));

const messages = await readMessages(stubUrl, 'secret', 'ses_stub');
check(': the message tail carries the idle outcome',
  idleOutcome(messages?.data) === 'succeeded', JSON.stringify(messages?.data));

const deleted = await deleteSession(stubUrl, 'secret', 'ses_stub');
check(': session delete answers 204',
  deleted.status === 204, String(deleted.status));

check(': every holder call went to the measured paths with basic auth',
  ['GET /api/session', 'POST /api/session', 'POST /api/session/ses_stub/prompt',
    'GET /api/session/ses_stub/message?limit=5', 'DELETE /api/session/ses_stub']
    .every((line) => seen.includes(line)),
  seen.join(' · '));
stub.close();

// --- availability -----------------------------------------------------------

const probeWith = (capture) => opencodeAvailability({ capture }).probe;

const noTool = await probeWith(async () => ({}))({ toolBin: null, timeoutMs: 1000 });
check(': no resolved binary is unknown, not unavailable',
  noTool.state === 'unknown', JSON.stringify(noTool));

const missing = await probeWith(async () => ({}))({ toolBin: { ok: false, bin: null }, timeoutMs: 1000 });
check(': an unresolvable binary is unavailable',
  missing.state === 'unavailable' && missing.reason === 'binary_missing', JSON.stringify(missing));

const timeout = await probeWith(async () => ({ launched: true, timedOut: true, status: null, signal: 'SIGKILL', stdout: '' }))(
  { toolBin: { ok: true, bin: 'opencode' }, timeoutMs: 50 });
check(': a hanging version call is a timeout, and the harness is not blamed',
  timeout.state === 'unknown' && timeout.reason === 'probe_timeout', JSON.stringify(timeout));

const old = await probeWith(async () => ({ launched: true, timedOut: false, status: 0, signal: null, stdout: 'opencode v1.9.0\n' }))(
  { toolBin: { ok: true, bin: 'opencode' }, timeoutMs: 1000 });
check(`: below the floor ${OPENCODE_MIN_VERSION} the binary is unavailable`,
  old.state === 'unavailable' && old.reason === 'binary_too_old', JSON.stringify(old));

const good = await probeWith(async () => ({ launched: true, timedOut: false, status: 0, signal: null, stdout: 'opencode v2.0.20\n' }))(
  { toolBin: { ok: true, bin: 'opencode' }, timeoutMs: 1000 });
check(': a new-enough binary is available with its version on the verdict',
  good.state === 'available' && good.version === '2.0.20', JSON.stringify(good));

// --- documentation ----------------------------------------------------------

const driversDoc = readFileSync(path.join(here, '..', 'docs', 'reference', '05-drivers.md'), 'utf8');
check(': the drivers reference names the opencode driver with its floor',
  driversDoc.includes('`OPENCODE` — opencode harness driver')
  && driversDoc.includes('the floor is 2.0.0'),
  '05-drivers.md lacks the OPENCODE section');

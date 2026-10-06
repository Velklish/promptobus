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
  viewOf, REVIEWER_DENY, listSessionsSync, SESSION_RECORD_VAR, mcpDenyTools, activate, checkWake,
  registerWake, renderNotification, registrySessionKey, holderRecord,
} = await import(path.join(here, '..', 'lib', 'driver-opencode.js'));
const {
  holderPassword, holderUrl, portOfLog, idleOutcome, createSession, sendPrompt, readMessages,
  deleteSession, waitReady,
} = await import(path.join(here, '..', 'lib', 'opencode-session.js'));
const { REGISTRY } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { TEAMLEAD_HARNESSES } = await import(path.join(here, '..', 'lib', 'contract.js'));
const { opencodeGuardNote } = await import(path.join(here, '..', 'lib', 'spawn.js'));

check(': dry-run names the missing loop-guard hook instead of files that never land',
  opencodeGuardNote({ mcpConfigPath: path.join(SB, 'opencode.json') }).includes('no loop-guard hook'),
  'guard note');

check(': opencode is admitted to teamlead lifts',
  TEAMLEAD_HARNESSES.includes('opencode'), TEAMLEAD_HARNESSES.join(','));
const { opencodeAvailability, OPENCODE_MIN_VERSION } = await import(
  path.join(here, '..', 'lib', 'model-routing', 'adapter-opencode.js'));

// --- registry ---------------------------------------------------------------

check(': opencode is registered under its own name',
  OPENCODE === 'opencode' && REGISTRY.drivers.opencode === opencodeDriver,
  Object.keys(REGISTRY.drivers).sort().join(','));

check(': worker capabilities are spawn/inspect/stop with push activation and approver lift',
  opencodeDriver.capabilities.spawn === true
  && opencodeDriver.capabilities.inspect === true
  && opencodeDriver.capabilities.stop === true
  && opencodeDriver.capabilities.activation === 'push'
  && opencodeDriver.capabilities.mcpDenyTools === true
  && opencodeDriver.capabilities.approverLift === true,
  JSON.stringify(opencodeDriver.capabilities));

check(': the default model names the owner-ordered provider and model',
  opencodeDriver.options.defaultModel === 'opencode-go/muse-spark-1.3-contributor',
  opencodeDriver.options.defaultModel);

check(': the contract dictionary is complete — deny list, http channel, null identity',
  Array.isArray(opencodeDriver.options.denyTools) && opencodeDriver.options.denyTools.length > 0
  && opencodeDriver.options.knockChannel === 'http'
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
  bus: { type: 'stdio', command: '/bin/node', args: ['/bin/node', 'mcp'] },
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
  && written.mcp.bus?.command.join(' ') === '/bin/node mcp'
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
  const rolePlan = planFor({ role, denyTools: ['edit', 'bash'] });
  const roleCfg = JSON.parse(rolePlan.files.find((f) => f.path === path.join(SB, 'opencode.json')).text);
  check(`: a ${role} lift carries the deny map instead of refusing`,
    roleCfg.permission?.edit === 'deny' && roleCfg.permission?.bash === 'deny',
    JSON.stringify(roleCfg.permission));
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

const slotPlan = planFor({ home: 'h', task: 't', address: 'orchestrator' });
check(': an address without a file stem falls back to the lift ref, same file every relift',
  slotPlan.env[SESSION_RECORD_VAR] !== undefined
  && slotPlan.env[SESSION_RECORD_VAR].endsWith('.session.json')
  && slotPlan.env[SESSION_RECORD_VAR] === planFor({ home: 'h', task: 't', address: 'orchestrator' }).env[SESSION_RECORD_VAR],
  slotPlan.env[SESSION_RECORD_VAR]);

check(': the wake operations ride the driver map, not beside it',
  typeof opencodeDriver.mcpDenyTools === 'function'
  && typeof opencodeDriver.activate === 'function'
  && typeof opencodeDriver.registerWake === 'function'
  && typeof opencodeDriver.checkWake === 'function'
  && typeof opencodeDriver.sayForeignWrite === 'function'
  && typeof opencodeDriver.sweepParticipant === 'function'
  && typeof opencodeDriver.renderNotification === 'function',
  'wake map');

check(': the reviewer deny list is non-empty opencode permission keys',
  REVIEWER_DENY.length > 0 && REVIEWER_DENY.every((k) => k === k.toLowerCase()),
  REVIEWER_DENY.join(','));

// --- inspect / stop without a record ----------------------------------------

process.env.PROMPTOBUS_OPENCODE_HOME = path.join(SB, 'state');

check(': inspect with no entry is unknown, not death',
  opencodeDriver.inspect('worker:x') === null, 'non-null without an entry');

const stopped = await opencodeDriver.stop('worker:x');
check(': stop with no entry is idempotent',
  stopped.ok === true && stopped.stopped === false, JSON.stringify(stopped));

import { mkdirSync, readdirSync, writeFileSync as writeFile } from 'node:fs';
const sweepState = path.join(SB, 'state', 'sessions');
mkdirSync(sweepState, { recursive: true });
const sweepRecord = path.join(SB, 'sweep-session.json');
writeFile(sweepRecord, JSON.stringify({ holderPid: 4194304, url: null, sessionId: null, log: `${sweepRecord}.holder.log` }));
writeFile(`${sweepRecord}.holder.log`, 'stale log\n');
writeFile(path.join(sweepState, `${registrySessionKey('worker:gone')}.json`), JSON.stringify({
  ref: 'worker:gone', recordPath: sweepRecord,
  sessionId: null, home: 'h', task: 't-sweep', address: 'worker:gone',
}));
const swept = await opencodeDriver.sweepParticipant({ metadata: {} }, 't-sweep');
check(': sweep reaps the dead registry entries of the closed task and nothing else',
  swept.swept === 1
  && readdirSync(sweepState).length === 0
  && !readdirSync(SB).includes('sweep-session.json')
  && !readdirSync(SB).some((n) => n.endsWith('.holder.log'))
  && (await opencodeDriver.sweepParticipant({ metadata: {} }, 't-other')).swept === 0,
  JSON.stringify(swept));

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
check(': the drivers reference states the measured wake boundary — no hook channel in serve holders',
  driversDoc.includes('never under `serve`')
  && driversDoc.includes('no hook channel at all'),
  '05-drivers.md lacks the serve-holder hook boundary');
check(': the drivers reference claims clean teamlead delivery with its proof',
  driversDoc.includes('opencode-teamlead-proof.json')
  && driversDoc.includes('by the clean bus route'),
  '05-drivers.md lacks the clean-delivery claim');

// --- wake path --------------------------------------------------------------

check(': classified MCP writes become both opencode permission spellings',
  JSON.stringify(mcpDenyTools([{ server: 'promptobus', tool: 'promptobus_send' }]))
  === JSON.stringify(['promptobus_promptobus_send', 'mcp__promptobus__promptobus_send'])
  && mcpDenyTools([{ server: '', tool: '' }]).length === 0
  && mcpDenyTools(null).length === 0,
  JSON.stringify(mcpDenyTools([{ server: 'promptobus', tool: 'promptobus_send' }])));

check(': the notification names the task, the address and the mailbox fetch',
  renderNotification({ task: 't1', address: 'worker:w', unread: 2, messages: [] }).includes('t1')
  && renderNotification({ task: 't1', address: 'worker:w', unread: 2, messages: [] }).includes('promptobus_mailbox'),
  'notification body');

import { writeFileSync } from 'node:fs';
const WAKE_HOME = path.join(SB, 'wake');
const WAKE_TASK = 't-wake-1';
const store = await import(path.join(here, '..', 'lib', 'store.js'));
store.createTask(WAKE_HOME, { id: WAKE_TASK, title: 'wake probe' });
store.upsertParticipant(WAKE_HOME, WAKE_TASK, store.participantRecord('worker:wake',
  { harness: 'opencode', sessionId: 'ses_stub' }));

const wakeRecord = path.join(SB, 'wake-session.json');
writeFileSync(wakeRecord, JSON.stringify({
  url: stubUrl, password: 'secret', sessionId: 'ses_stub', holderPid: process.pid,
}));
const wakeEnv = { [SESSION_RECORD_VAR]: wakeRecord };

const woken = registerWake(WAKE_HOME, WAKE_TASK, 'worker:wake', wakeEnv, 'ses_stub');
check(': a matching session hands over the record path as the contact point',
  !!woken && woken.session === 'ses_stub', JSON.stringify(woken));

check(': a foreign session hands over nothing',
  registerWake(WAKE_HOME, WAKE_TASK, 'worker:wake', wakeEnv, 'ses_other') !== true,
  'foreign handoff');
check(': with no session argument the record names the session, as the bus server hands over',
  registerWake(WAKE_HOME, WAKE_TASK, 'worker:wake', wakeEnv, null)?.session === 'ses_stub'
  && registerWake(WAKE_HOME, WAKE_TASK, 'worker:wake', {}, 'ses_stub') === null,
  'sessionless handoff');
writeFileSync(path.join(SB, 'empty-session.json'), JSON.stringify({
  url: stubUrl, password: 'secret', holderPid: process.pid,
}));
check(': with no session anywhere there is nothing to hand over',
  registerWake(WAKE_HOME, WAKE_TASK, 'worker:wake',
    { [SESSION_RECORD_VAR]: path.join(SB, 'empty-session.json') }, null) === null,
  'empty handoff');

// --- holder record identity ---------------------------------------------------

const { mcpIdentityCandidates } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const homedRecord = path.join(SB, 'homed-session.json');
writeFileSync(homedRecord, JSON.stringify({
  url: stubUrl, password: 'secret', sessionId: 'ses_stub', holderPid: process.pid,
  home: WAKE_HOME, task: WAKE_TASK, address: 'worker:wake',
}));
const homedScope = { home: WAKE_HOME, task: WAKE_TASK, address: 'worker:wake' };
const homed = mcpIdentityCandidates({ [SESSION_RECORD_VAR]: homedRecord }, homedScope);
check(': a record carrying home/task/address proves the caller session',
  homed.length === 1 && homed[0].id === 'ses_stub', JSON.stringify(homed));
const unhomed = mcpIdentityCandidates(wakeEnv, homedScope);
check(': a record without them proves nothing — sends would be refused',
  unhomed.length === 0, JSON.stringify(unhomed));

const staged = holderRecord({
  home: 'h', task: 't', address: 'worker:x', password: 'pw', pid: 123, log: 'l', cwd: 'c',
});
check(': the staged holder record carries the identity the MCP check reads',
  staged.home === 'h' && staged.task === 't' && staged.address === 'worker:x'
  && staged.sessionId === null && staged.holderPid === 123,
  JSON.stringify({ home: staged.home, task: staged.task, address: staged.address }));

const smoke = checkWake(wakeEnv);
check(': the channel smoke answers on the record, spending no turn',
  smoke.ok === true && smoke.endpoint === wakeRecord, JSON.stringify(smoke));
check(': the smoke refuses outside a participant session',
  checkWake({}).ok === false, JSON.stringify(checkWake({})));

const idleRecord = path.join(SB, 'idle-session.json');
writeFileSync(idleRecord, JSON.stringify({
  url: stubUrl, password: 'secret', sessionId: 'ses_idle', holderPid: process.pid,
}));
const idleStub = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/api/session/ses_idle/message?limit=3') {
      return void res.end(JSON.stringify({ data: idleMessages }));
    }
    if (req.method === 'POST' && req.url === '/api/session/ses_idle/prompt') {
      idlePrompts.push(body);
      return void res.end(JSON.stringify({ data: { id: 'msg_2' } }));
    }
    res.writeHead(404).end();
  });
});
let idleMessages = [{ type: 'idle', outcome: 'succeeded' }];
const idlePrompts = [];
await new Promise((resolve) => { idleStub.listen(0, '127.0.0.1', resolve); });
const idleUrl = holderUrl(idleStub.address().port);
writeFileSync(idleRecord, JSON.stringify({
  url: idleUrl, password: 'secret', sessionId: 'ses_idle', holderPid: process.pid,
}));

const wokenIdle = await activate({ ref: 'worker:wake', endpoint: idleRecord },
  { task: WAKE_TASK, address: 'worker:wake', unread: 1, messages: [] });
check(': an idle session takes the follow-up turn',
  wokenIdle.ok === true && idlePrompts.length === 1 && idlePrompts[0].includes(WAKE_TASK),
  `${JSON.stringify(wokenIdle)} · prompts ${idlePrompts.length}`);

const wokenShape = await activate({ ref: 'worker:wake', endpoint: { socket: idleRecord, token: null } },
  { task: WAKE_TASK, address: 'worker:wake', unread: 1, messages: [] });
check(': the warden-shaped target wakes through its socket',
  wokenShape.ok === true && idlePrompts.length === 2,
  `${JSON.stringify(wokenShape)} · prompts ${idlePrompts.length}`);

idleMessages = [{ type: 'assistant' }];
const wokenBusy = await activate({ ref: 'worker:wake', endpoint: idleRecord },
  { task: WAKE_TASK, address: 'worker:wake', unread: 1, messages: [] });
check(': a running turn refuses honestly instead of queueing blind',
  wokenBusy.ok === false && /running/.test(wokenBusy.error ?? ''),
  JSON.stringify(wokenBusy));

const wokenNowhere = await activate({ ref: 'worker:wake', endpoint: path.join(SB, 'missing.json') },
  { task: WAKE_TASK, address: 'worker:wake', unread: 1, messages: [] });
check(': a contact point with no record refuses',
  wokenNowhere.ok === false, JSON.stringify(wokenNowhere));
idleStub.close();
stub.close();

// --- live proof fixture -------------------------------------------------------

const proof = JSON.parse(readFileSync(path.join(here, 'fixtures', 'opencode-refonly-stop.json'), 'utf8'));
check(': the ref-only stop proof emptied workers dir and registry after a live turn',
  proof.before.workers.length === 2 && proof.before.registry.length === 1
  && proof.before.inspect?.state === 'alive' && proof.before.inspect?.busy === false
  && proof.stop?.ok === true && proof.stop?.stopped === true
  && proof.after.workers.length === 0 && proof.after.registry.length === 0,
  JSON.stringify({ before: proof.before.workers, after: proof.after.workers }));

// --- teamlead transcript fixture ----------------------------------------------

const transcript = JSON.parse(readFileSync(path.join(here, 'fixtures', 'opencode-teamlead-proof.json'), 'utf8'));
check(': the teamlead proof carries clean status+result delivery, not the fallback route',
  transcript.delivery === 'clean'
  && transcript.messages.some((m) => m.type === 'status' && m.body.includes('TEAM-UP'))
  && transcript.messages.some((m) => m.type === 'result' && m.body.includes('TEAM-DONE'))
  && transcript.messages.every((m) => m.type !== 'question')
  && typeof transcript.wake?.session === 'string',
  JSON.stringify(transcript.messages.map((m) => m.type)));

// --- consumer surface ---------------------------------------------------------

const readme = readFileSync(path.join(here, '..', 'README.md'), 'utf8');
check(': the README names the opencode reviewer deny map',
  readme.includes('An opencode reviewer denies file and shell writes through the holder permission map'),
  'README reviewer paragraph');

// --- release currency ----------------------------------------------------------

const cliRef = readFileSync(path.join(here, '..', 'docs', 'reference', '03-cli.md'), 'utf8');
check(': the repeat-spawn sentence counts all four stop drivers',
  cliRef.includes('for any harness whose driver declares `stop` — all four do —'),
  '03-cli stop-drivers sentence');

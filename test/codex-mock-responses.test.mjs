import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { makeSandbox } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { CodexRpc } from '../lib/codex-rpc.js';
import { MIN_CODEX_VERSION, PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';
import { HANG_AFTER_START_VAR, PROBE_VAR, installHarness, planParticipant, readTrace } from './harness-codex.mjs';

const root = makeSandbox('promptobus-codex-');
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const schemas = [MIN_CODEX_VERSION, PROVEN_CODEX_VERSION].map(version => {
  const ajv = new Ajv({ strict: false, allErrors: true, formats: {
    int64: true, uint64: true, uint32: true, uint: true, double: true, int32: true, uint16: true,
  } });
  const cache = new Map();
  return { version, validate(name, value) {
    if (!cache.has(name)) cache.set(name, ajv.compile(JSON.parse(readFileSync(
      path.resolve('test/fixtures/codex-app-server', version, `${name}.json`), 'utf8'))));
    const validate = cache.get(name);
    return { valid: validate(value), detail: ajv.errorsText(validate.errors) };
  } };
});
let count = 0;
async function run(probe, work) {
  const child = spawn(path.join(root, 'bin', 'codex'), ['app-server', '--stdio'], {
    env: { ...process.env, [PROBE_VAR]: probe, [HANG_AFTER_START_VAR]: '1', CODEX_HOME: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = CodexRpc({ stdin: child.stdin, stdout: child.stdout });
  const events = [];
  rpc.onNotification(msg => events.push(msg));
  const request = async (label, method, params, name) => {
    const answer = await rpc.request(method, params, 3000);
    for (const schema of schemas) {
      const result = schema.validate(name, answer.result);
      check(`Codex ${schema.version} actual mock ${label} response matches ${name}`,
        !answer.error && result.valid, answer.error?.message ?? result.detail);
    }
    count += 1;
    return answer.result;
  };
  try { await work({ rpc, request, events }); } finally {
    rpc.close();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
}

const skill = path.join(root, '.codex', 'skills', 'positive');
mkdirSync(skill, { recursive: true });
writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: positive\ndescription: Fixture skill\n---\nRead.\n');
await run('hidden', async ({ rpc, request, events }) => {
  await request('initialize', 'initialize', { clientInfo: { name: 'fixture', version: '1.0' } }, 'v1/InitializeResponse');
  await request('account/read', 'account/read', { refreshToken: false }, 'v2/GetAccountResponse');
  await request('model/list visible', 'model/list', {}, 'v2/ModelListResponse');
  await request('model/list hidden', 'model/list', { includeHidden: true }, 'v2/ModelListResponse');
  await request('skills/list populated', 'skills/list', { cwds: [root] }, 'v2/SkillsListResponse');
  await request('skills/list empty', 'skills/list', { cwds: [path.join(root, 'absent')] }, 'v2/SkillsListResponse');
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
    await request(`thread/start ${sandbox}`, 'thread/start', {
      cwd: root, sandbox, approvalPolicy: 'on-request', model: 'gpt-6-astra', config: { model_reasoning_effort: 'high' },
    }, 'v2/ThreadStartResponse');
  }
  const started = await request('thread/start default', 'thread/start', { cwd: root }, 'v2/ThreadStartResponse');
  const threadId = started.thread.id;
  await request('thread/name/set', 'thread/name/set', { threadId, name: 'Native-shaped fixture' }, 'v2/ThreadSetNameResponse');
  const first = await request('turn/start idle', 'turn/start', {
    threadId, input: [{ type: 'text', text: 'Start' }],
  }, 'v2/TurnStartResponse');
  await waitFor(() => events.some(msg => msg.method === 'turn/started' && msg.params.id === first.turn.id), { timeoutMs: 3000 });
  await request('thread/inject_items', 'thread/inject_items', {
    threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Assignment' }] }],
  }, 'v2/ThreadInjectItemsResponse');

  await request('turn/steer active', 'turn/steer', {
    threadId, expectedTurnId: first.turn.id, input: [{ type: 'text', text: 'Steer' }],
  }, 'v2/TurnSteerResponse');
  await request('turn/start queued', 'turn/start', {
    threadId, input: [{ type: 'text', text: 'Next' }],
  }, 'v2/TurnStartResponse');
  await request('review/start queued', 'review/start', {
    threadId, target: { type: 'uncommittedChanges' }, delivery: 'inline',
  }, 'v2/ReviewStartResponse');
  for (const includeTurns of [true, false]) {
    await request(`thread/read includeTurns=${includeTurns}`, 'thread/read', { threadId, includeTurns }, 'v2/ThreadReadResponse');
  }
  for (const excludeTurns of [true, false]) {
    await request(`thread/resume excludeTurns=${excludeTurns}`, 'thread/resume', { threadId, excludeTurns }, 'v2/ThreadResumeResponse');
  }
  await request('turn/interrupt', 'turn/interrupt', { threadId, turnId: first.turn.id }, 'v2/TurnInterruptResponse');
  await request('review/start idle', 'review/start', {
    threadId, target: { type: 'uncommittedChanges' }, delivery: 'inline',
  }, 'v2/ReviewStartResponse');
  check('actual mock response inventory covers 22 positive branch outputs against both contracts', count === 22, `got ${count}`);
  await request('thread/list', 'thread/list', {}, 'v2/ThreadListResponse');
  await request('thread/loaded/list', 'thread/loaded/list', {}, 'v2/ThreadLoadedListResponse');
});
check('actual mock response inventory includes both native thread list branches', count === 24, `got ${count}`);

for (const probe of ['', 'credits', 'flat', 'spend-control']) {
  await run(probe, async ({ request }) => {
    await request(`account/rateLimits/read ${probe || 'default'}`, 'account/rateLimits/read', {},
      'v2/GetAccountRateLimitsResponse');
  });
}
check('actual mock response inventory includes four positive quota branches', count === 28, `got ${count}`);
for (const [probe, message] of [
  ['unsupported', 'unknown variant `account/rateLimits/read`'],
  ['unauthenticated', 'codex account authentication required'],
]) {
  await run(probe, async ({ rpc }) => {
    const answer = await rpc.request('account/rateLimits/read', {}, 3000);
    check(`actual mock quota ${probe} branch retains its explicit error`,
      answer.error?.code === -32600 && answer.error.message.includes(message) && !answer.result,
      JSON.stringify(answer));
  });
}

for (const [label, params] of [['omitted', {}], ['null', { cwd: null }]]) {
  await run('', async ({ request }) => {
    for (const schema of schemas) {
      const result = schema.validate('v2/ThreadStartParams', params);
      check(`Codex ${schema.version} thread/start cwd ${label} is a valid native request`, result.valid, result.detail);
    }
    const started = await request(`thread/start cwd ${label}`, 'thread/start', params, 'v2/ThreadStartResponse');
    const threadId = started.thread.id;
    await request(`thread/inject_items cwd ${label}`, 'thread/inject_items', {
      threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Assignment' }] }],
    }, 'v2/ThreadInjectItemsResponse');
    const read = await request(`thread/read cwd ${label}`, 'thread/read', { threadId }, 'v2/ThreadReadResponse');
    const resumed = await request(`thread/resume cwd ${label}`, 'thread/resume', { threadId }, 'v2/ThreadResumeResponse');
    const listed = await request(`thread/list cwd ${label}`, 'thread/list', {}, 'v2/ThreadListResponse');
    const cwds = [started.cwd, started.thread.cwd, read.thread.cwd, resumed.cwd, resumed.thread.cwd,
      listed.data.find(thread => thread.id === threadId)?.cwd];
    check(`actual mock cwd ${label} defaults once and survives read/resume/list`,
      cwds.every(cwd => cwd === process.cwd() && path.isAbsolute(cwd)), JSON.stringify(cwds));
  });
}
check('actual mock response inventory includes omitted and null cwd lifecycle outputs', count === 38, `got ${count}`);

const eofHome = path.join(root, 'eof-close');
mkdirSync(eofHome, { recursive: true });
for (const [label, deleteStatus] of [['accepted', 200], ['refused', 409]]) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = body ? JSON.parse(body) : null;
    requests.push({ method: request.method, rpc: message?.method ?? null, session: request.headers['mcp-session-id'] ?? null });
    if (request.method === 'DELETE') { response.writeHead(deleteStatus).end(); return; }
    if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'eof-fixture', version: '1' } }
      : { content: [{ type: 'text', text: 'fixture status' }] };
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'eof-session' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = `worker:eof-${label}`;
  writeFileSync(path.join(eofHome, 'config.toml'), `[mcp_servers.promptobus]\nurl = "http://127.0.0.1:${server.address().port}/mcp/bus"\n`
    + 'bearer_token_env_var = "PROMPTOBUS_CLIENT_TOKEN"\n');
  planParticipant(harness.home, address, { turns: [{ do: [{ tool: 'promptobus_status' }] }] });
  const env = { ...process.env, CODEX_HOME: eofHome, PROMPTOBUS_ROLE: address, PROMPTOBUS_CLIENT_TOKEN: 'eof-fixture-token' };
  delete env.PROMPTOBUS_CLIENT_FILE;
  const child = spawn(path.join(root, 'bin', 'codex'), ['app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const rpc = CodexRpc({ stdin: child.stdin, stdout: child.stdout });
  const events = [];
  rpc.onNotification(msg => events.push(msg));
  try {
    await rpc.request('initialize', { clientInfo: { name: 'fixture', version: '1.0' } }, 3000);
    const started = await rpc.request('thread/start', { cwd: root }, 3000);
    const turn = await rpc.request('turn/start', { threadId: started.result.thread.id, input: [{ type: 'text', text: 'status' }] }, 3000);
    await waitFor(() => events.some(msg => msg.method === 'turn/completed' && msg.params.id === turn.result.turn.id), { timeoutMs: 5000 });
    child.stdin.end();
    const exit = await exited;
    const trace = readTrace(harness.home, address);
    const failures = trace.filter(event => event.kind === 'native-mcp-close-failed');
    const deleted = requests.filter(entry => entry.method === 'DELETE' && entry.session === 'eof-session').length === 1;
    const evidence = JSON.stringify({ exit, stderr: stderr.slice(-600), requests, failures });
    check(`input EOF after a scripted HTTP tool turn sends one real DELETE (${label} ${deleteStatus})`,
      deleted && requests.some(entry => entry.rpc === 'tools/call') && trace.some(event => event.kind === 'tool' && !event.isError), evidence);
    check(deleteStatus === 200
      ? 'an accepted native MCP session close leaves a clean app-server exit and no close failure'
      : 'a refused native MCP session close is recorded once without changing the app-server exit',
    exit.code === 0 && exit.signal === null && !/HTTP MCP close/.test(stderr)
      && (deleteStatus === 200 ? failures.length === 0
        : failures.length === 1 && failures[0].status === deleteStatus && failures[0].thread === started.result.thread.id), evidence);
  } finally {
    rpc.close();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await new Promise(resolve => server.close(resolve));
  }
}

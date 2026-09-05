// Regression test for the Promptobus bus MCP server: the `promptobus mcp` subcommand.
// Run: npm test
//
// The client here is scripted: two real stdio processes (orchestrator and worker)
// speak line-delimited JSON-RPC 2.0 — exactly how Claude Code talks to them.
// What's under test is the hand-rolled protocol implementation and message delivery between processes.
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { stubCommand } from './sandbox.mjs';
import { check } from './check.mjs';

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-promptobus-mcp-'));
const ROOT = realpathSync(SB);
const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'promptobus.js');
const HOME = path.join(ROOT, '.promptobus');
const TASK = 't20260813-090000';
const WRONG_ROOT = path.join(ROOT, 'other-workspace');
const WRONG_HOME = path.join(WRONG_ROOT, '.promptobus');

// Two full workspaces with a task of the same id reproduce a live bug :
// the CLI starts from the first one, but the stdio process's cwd is chosen by the MCP client and can
// end up being the second. The canonical config must bind the server to the first one via PROMPTOBUS_HOME.
for (const root of [SB, WRONG_ROOT]) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), '# workspace\n');
  writeFileSync(path.join(root, 'promptobus.json'), `${JSON.stringify({
    commandName: 'promptobus',
    tools: ['claude'],
  })}\n`);
}

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));
// The version-marker field name comes from its own home (`protocol.ts`), not a literal: the
// adapter writes it and the store reads it, and if the two drifted apart, the fixture would be checking a field that doesn't exist.
const { MECHANISM_VERSION_FIELD } = await import(path.join(here, '..', 'dist', 'index.js'));
store.createTask(HOME, { id: TASK, title: 'событие CargoCreated в двух сервисах' });
store.createTask(WRONG_HOME, { id: TASK, title: 'другая задача с тем же id' });
// The worker is registered as a participant: since  a message is delivered only to
// whoever is present in the task's journal, and it's `spawn` that registers them there — there's no live spawn in these tests.
const joinWorker = (home, id) => store.upsertParticipant(home, id, store.participantRecord('worker:cargos-api', { repo: 'cargos-api' }));
joinWorker(HOME, TASK);
joinWorker(WRONG_HOME, TASK);
const { PROMPTOBUS_TOOLS, PROTOCOL_VERSIONS } = await import(path.join(here, '..', 'lib', 'contract.js'));
const { blockedParticipants } = await import(path.join(here, '..', 'lib', 'status.js'));
const canonicalPromptobus = {
  command: process.execPath,
  args: [BIN, 'mcp'],
  env: { PROMPTOBUS_HOME: HOME },
};

// Everything the server wrote to stdout outside the line-delimited JSON-RPC. Empty is part of the contract:
// the channel is shared with the protocol, and any stray line in it breaks the agent client the same way
// it used to break this file.
const strays = [];

function startServer(role, { config = null, cwd = SB, task = TASK, env = {} } = {}) {
  const child = spawn(config?.command ?? process.execPath, config?.args ?? [BIN, 'mcp'], {
    cwd,
    env: {
      ...process.env,
      ...(config?.env ?? {}),
      PROMPTOBUS_ROLE: role,
      PROMPTOBUS_TASK: task,
      ...(config ? {} : { PROMPTOBUS_HOME: HOME }),
      // Session identity is set explicitly: it comes from the environment, and without
      // this substitution the test would depend on what npm test happened to be run under.
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const unsolicited = [];
  // The ORDER OF ARRIVAL of responses (ids in sequence). Promises don't preserve it: `await` returns
  // its own answer, not whichever arrived first — and what's checked below is exactly that order.
  const arrived = [];
  let stderr = '';
  let buf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      // Parsing is wrapped in a try: `JSON.parse` inside an event handler throws past any
      // `try` in the caller — Node itself invokes the handler, and an exception from it becomes
      // unhandled. A single stray line from the server used to take down the whole file without naming
      // the culprit. We collect them and turn it into a verdict at the end — a red check instead of
      // the file dying.
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        strays.push({ role, line });
        continue;
      }
      arrived.push(msg.id);
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); } else unsolicited.push(msg);
    }
  });
  let seq = 0;
  // The request is prepared separately from the write: in a pipelined batch all lines go out in
  // ONE write, and the response promises must be set up before that write happens.
  const request = (method, params) => {
    const id = (seq += 1);
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${method}`)), 20000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    });
    return { line: JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', answer };
  };
  const call = (method, params) => {
    const { line, answer } = request(method, params);
    child.stdin.write(line);
    return answer;
  };
  // A pipeline is several requests written to the pipe in one write. With separate writes,
  // "simultaneity" would depend on whether the pipe happens to coalesce them into one chunk: the server
  // parses the chunk's lines in sequence, with no event-loop tick between them.
  const batch = (reqs) => {
    const made = reqs.map((r) => request(r.method, r.params));
    child.stdin.write(made.map((m) => m.line).join(''));
    return made.map((m) => m.answer);
  };
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  // The raw line as-is — it's how unparsable input is fed in: it can't be built via `call`,
  // which writes ready-made JSON.
  const raw = (line) => child.stdin.write(line);
  const stop = () => { child.stdin.end(); child.kill(); };
  return { call, batch, notify, raw, stop, unsolicited, arrived, stderr: () => stderr };
}

const text = (res) => res.result?.content?.map((c) => c.text).join('\n') ?? '';

// The orchestrator deliberately starts from the wrong workspace. Before  the canonical config
// didn't set PROMPTOBUS_HOME, so this server honestly looked in WRONG_HOME and answered "empty"
// while messages were sitting in HOME.
const orch = startServer('orchestrator', { config: canonicalPromptobus, cwd: WRONG_ROOT });
const worker = startServer('worker:cargos-api');

// --- handshake -------------------------------------------------------------

check('canonical MCP config pins an absolute PROMPTOBUS_HOME',
  canonicalPromptobus?.env?.PROMPTOBUS_HOME === HOME, JSON.stringify(canonicalPromptobus));
const aliasIdentity = store.resolveIdentity({
  PROMPTOBUS_ROLE: 'orchestrator',
  PROMPTOBUS_TASK: TASK,
  PROMPTOBUS_HOME: path.join(SB, '.promptobus'),
}, WRONG_ROOT, { host: hostOf(WRONG_ROOT) });
check('identity: a symlink alias of PROMPTOBUS_HOME resolves to the same physical form',
  aliasIdentity.home === HOME, `${aliasIdentity.home} vs ${HOME}`);

const init = await orch.call('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1' },
});
check('initialize: the protocol version comes from the client request, since the server supports it',
  init.result?.protocolVersion === '2025-03-26', JSON.stringify(init.result));
// : previously `initialize` echoed back ANY version — the server claimed support for one
// it doesn't have, and a client newer than the list was entitled to expect that version's capabilities.
const future = startServer('orchestrator');
const initFuture = await future.call('initialize', { protocolVersion: '2099-01-01', capabilities: {} });
check(': an unfamiliar protocol version is not echoed back — the server names its own',
  initFuture.result?.protocolVersion === PROTOCOL_VERSIONS[0], JSON.stringify(initFuture.result));
future.stop();
// The version contract itself is a pure function of the package, and it's tested in its own suite
// (`mcp.test.mjs`). What's left here is the live branch:
// that the CLI server is booted with the list from `contract.js`, and not some other one.
check('initialize: the server announced itself and its tools',
  init.result?.serverInfo?.name === 'promptobus' && !!init.result?.capabilities?.tools,
  JSON.stringify(init.result?.serverInfo));

orch.notify('notifications/initialized');
await worker.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
worker.notify('notifications/initialized');

const ping = await orch.call('ping', {});
check('ping: empty result', ping.result && Object.keys(ping.result).length === 0);

const tools = await orch.call('tools/list', {});
const names = (tools.result?.tools ?? []).map((t) => t.name).sort();
check('tools/list: the server announces exactly the set from contract.js',
  names.join(',') === [...PROMPTOBUS_TOOLS].sort().join(','), `${names.join(',')} vs ${[...PROMPTOBUS_TOOLS].sort().join(',')}`);
check('tools/list: every tool has a description and an input schema',
  (tools.result?.tools ?? []).every((t) => t.description && t.inputSchema?.type === 'object'));
// The grep over description prose has been removed: it went red on reworded text and stayed silent on
// broken behavior. The loss is named out loud: NO ONE guards the actual TEXT of tool descriptions —
// not here, not by lint (contract quoting doesn't cover it). The checks below cover the tool's RESPONSE
// text, not its description. Don't bring the prose grep back;
// this should be closed with a gate, not with substring checks.
const sendSchema = tools.result.tools.find((t) => t.name === 'promptobus_send').inputSchema;
check('tools/list: send requires to/type/body and knows the protocol types',
  sendSchema.required.join(',') === 'to,type,body'
  && sendSchema.properties.type.enum.join(',') === store.MESSAGE_TYPES.join(','),
  JSON.stringify(sendSchema.required));

const unknown = await orch.call('resources/list', {});
check('unknown method → JSON-RPC error -32601',
  unknown.error?.code === -32601, JSON.stringify(unknown.error));

// --- correspondence between the two processes ------------------------------------------------

const empty = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('inbox: an empty mailbox names the home, task, and address',
  text(empty).startsWith('empty')
    && text(empty).includes(`PROMPTOBUS_HOME=${HOME}`)
    && text(empty).includes(`task=${TASK}`)
    && text(empty).includes('address=worker:cargos-api'),
  text(empty));

const sent = await orch.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'worker:cargos-api', type: 'task', body: 'Добавь поле source в событие CargoCreated' },
});
check('send: sent', /sent task → cargos-api · address worker:cargos-api/.test(text(sent)), text(sent));

const got = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(`inbox: the orchestrator's message reached the worker`,
  text(got).includes('task from orchestrator') && text(got).includes('поле source'), text(got));
// : the message header names the sender's session in a readable form — a hook surfaces it in
// the feed — with the machine address following, after the ` · address ` marker. The orchestrator has no
// session name at all: it's named by the plain word, in the "from" position — in the genitive case.
check(': the orchestrator has no session name — the header names it by the plain word',
  text(got).includes('### task from the orchestrator · address orchestrator · '), text(got));
const again = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('inbox: a message already read is not delivered again', text(again).startsWith('empty'), text(again));

// : nobody carries the "run the wait again" hint anymore. The protocol doesn't require
// re-arming the wait: there's exactly one alarm per task, and it's the warden. A line
// telling a session to do something the protocol doesn't ask for costs more than its absence —
// a session following it would set up a second alarm on every turn.
// dead: the hint no longer exists in any language — PB-9.1
check(': a mailbox that was fetched does not call for re-arming the wait (dead branch, PB-9.1)',
  !/запусти ожидание снова/.test(text(got)) && !/mailbox забран/.test(text(got)), text(got));
check(': and neither does an empty mailbox (dead branch, PB-9.1)',
  !/запусти ожидание снова/.test(text(again)), text(again));

// For the reviewer, `mailbox` is the only way to get messages: Bash is stripped from it
// by a deny-list, and it can't reach its own correspondence via the bus command at all.
await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'task', body: 'единственным каналом' },
});
const onlyChannel = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
// dead: the re-arm hint no longer exists in any language — PB-9.1
check(': mailbox delivered the content and does not call for re-arming the wait (dead branch, PB-9.1)',
  text(onlyChannel).includes('единственным каналом')
  && !/запусти ожидание снова/.test(text(onlyChannel)), text(onlyChannel));

const taskNoHint = await worker.call('tools/call', { name: 'promptobus_task', arguments: {} });
const sendNoHint = await worker.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'подсказка тут не нужна' },
});
// dead: the re-arm hint no longer exists in any language — PB-9.1
check(': task and send do not call for re-arming the wait (dead branch, PB-9.1)',
  !/запусти ожидание снова/.test(text(taskNoHint)) && !/запусти ожидание снова/.test(text(sendNoHint)),
  `${text(taskNoHint)} | ${text(sendNoHint)}`);
await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });

// Full regression for : tasks in the two workspaces share the same id and differ only by title.
// The orchestrator's MCP server is started with the cwd of the SECOND workspace, but its generated
// PROMPTOBUS_HOME points at the first one — meaning it must fetch its mailbox from the first one too.
await worker.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'orchestrator', type: 'status', body: 'первое непрочитанное' },
});
await worker.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'orchestrator', type: 'result', body: 'второе непрочитанное' },
});
check(': the messages landed in HOME, not the workspace the server was started from',
  store.countInbox(HOME, TASK, 'orchestrator') === 2
  && store.countInbox(WRONG_HOME, TASK, 'orchestrator') === 0,
  `${store.countInbox(HOME, TASK, 'orchestrator')} / ${store.countInbox(WRONG_HOME, TASK, 'orchestrator')}`);
const sameInbox = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': the MCP inbox for the same identity delivers the same two messages',
  text(sameInbox).includes('messages 2:')
    && text(sameInbox).includes('первое непрочитанное')
    && text(sameInbox).includes('второе непрочитанное')
    && text(sameInbox).includes(`PROMPTOBUS_HOME=${HOME}`)
    && store.countInbox(HOME, TASK, 'orchestrator') === 0
    && store.countInbox(WRONG_HOME, TASK, 'orchestrator') === 0,
  text(sameInbox));

// Cross-process delivery: the worker sends, the orchestrator fetches it with its own mailbox.
await worker.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'orchestrator', type: 'result', body: 'Готово: contract.cs, publisher.cs' },
});
const delivered = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('mailbox: what came from the worker is delivered whole',
  text(delivered).includes('result from worker:cargos-api') && text(delivered).includes('contract.cs'),
  text(delivered));

const emptyBox = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('mailbox: empty — with identity, not an error',
  text(emptyBox).startsWith('empty') && text(emptyBox).includes(`PROMPTOBUS_HOME=${HOME}`), text(emptyBox));

// --- tool errors ------------------------------------------------------

const badType = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'gossip', body: 'текст' },
});
check('tools/call: a foreign type — isError, the connection stays alive',
  badType.result?.isError === true && /protocol/i.test(text(badType)), text(badType));
const badAddr = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'boss', type: 'task', body: 'текст' },
});
check('tools/call: an unknown address — isError', badAddr.result?.isError === true, text(badAddr));
const badTool = await orch.call('tools/call', { name: 'a2a_teleport', arguments: {} });
check('tools/call: unknown tool — isError',
  badTool.result?.isError === true && /a2a_teleport/.test(text(badTool)), text(badTool));

const stillAlive = await orch.call('tools/call', { name: 'promptobus_task', arguments: {} });
check('task: task composition after errors',
  text(stillAlive).includes(TASK) && text(stillAlive).includes('orchestrator')
  && text(stillAlive).includes('событие CargoCreated'), text(stillAlive));

check('server: nothing stray in stdout, quiet on stderr — for both connections',
  orch.unsolicited.length === 0 && worker.unsolicited.length === 0
  && orch.stderr() === '' && worker.stderr() === '',
  `${orch.unsolicited.length}/${worker.unsolicited.length} · ${orch.stderr().slice(0, 120)}`
  + ` · worker: ${worker.stderr().slice(0, 120)}`);

// --- unread counter -----------------------------------------
//
// The warden's knock is best-effort: a lost postcard doesn't lose anything, but it doesn't say
// anything either. The live case: a worker's `result` sat unread for six minutes. That's why
// every bus turn names its own mailbox — and only when there's something in it.
const quietSend = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'task', body: 'ящик оркестратора пуст' },
});
check(': send does not name an empty own mailbox — an "always" line stops being readable',
  !/your mailbox/.test(text(quietSend)), text(quietSend));
const quietTask = await orch.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': task does not name an empty own mailbox',
  !/your mailbox/.test(text(quietTask)), text(quietTask));

await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
await worker.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'лежит и ждёт' },
});
const loudSend = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'task', body: 'а в ящике непрочитанное' },
});
check(`: send names its own mailbox's unread count and the route to it`,
  /your mailbox: unread 1 — fetch it with the promptobus_mailbox tool/.test(loudSend.result ? text(loudSend) : ''),
  text(loudSend));
const loudTask = await orch.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': task keeps its own mailbox separate from participant counters',
  /your mailbox: unread 1/.test(text(loudTask)) && /^- orchestrator .*unread 1$/m.test(text(loudTask)),
  text(loudTask));
check(': the own mailbox is named in the header, before the participant list',
  text(loudTask).indexOf('your mailbox:') < text(loudTask).indexOf('participants:'), text(loudTask));
const afterInbox = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': inbox does not print the counter — it just fetched the messages',
  !/your mailbox/.test(text(afterInbox)) && text(afterInbox).includes('лежит и ждёт'), text(afterInbox));

// --- task as an argument ----------------------------------------------
//
// There are several active tasks as soon as `promptobus review` starts its own: the "single
// active task" resolve then fails, and `PROMPTOBUS_TASK` is pinned at session start and never
// changes during a live run. The task argument is the only way to reach the needed
// task from an already-running session; without it, resolution behaves as before.
const SECOND = 'revyu-t20260813-100000';
store.createTask(HOME, { id: SECOND, title: 'ревью loads_search/cargos-api', slug: 'revyu', stamp: 't20260813-100000' });

const declared = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(`backward compatibility: without an argument, the session's declared task is used`,
  text(declared).includes(`task=${TASK}`), text(declared));

const loose = startServer('orchestrator', { task: '' });
await loose.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
loose.notify('notifications/initialized');

const ambiguous = await loose.call('tools/call', { name: 'promptobus_task', arguments: {} });
check('several active tasks with no argument — a refusal with a list, not a random pick',
  ambiguous.result?.isError === true && text(ambiguous).includes(SECOND) && text(ambiguous).includes(TASK),
  text(ambiguous));

const picked = await loose.call('tools/call', { name: 'promptobus_task', arguments: { task: SECOND } });
check('task: the task argument picks a task when several are active',
  text(picked).includes(`task ${SECOND}`) && text(picked).includes('ревью loads_search/cargos-api'), text(picked));

const sentSecond = await worker.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'orchestrator', type: 'status', body: 'отчёт по второй задаче', task: SECOND },
});
check('send: the task argument overrides the declared session — the message went to the named task',
  /sent status/.test(text(sentSecond))
  && store.countInbox(HOME, SECOND, 'orchestrator') === 1
  && store.countInbox(HOME, TASK, 'orchestrator') === 0, text(sentSecond));

// A sender who wasn't a participant of the foreign task gets recorded as one: without a record
// v1 has nothing to ask the routing policy. The record is DISMISSED FROM MONITORING though — otherwise
// the foreign task's warden would take a session that just wrote there once under its watch,
// and would report its stop to the orchestrator.
const guestIn = store.participantOf(store.readTask(HOME, SECOND), 'worker:cargos-api');
check(': a sender in a foreign task is recorded as a participant and immediately dismissed from monitoring',
  Boolean(guestIn) && Boolean(guestIn?.metadata.dismissed), JSON.stringify(guestIn));
check(': a guest dismissed from monitoring does not appear in the stall report',
  (blockedParticipants(HOME, SECOND, store.readTask(HOME, SECOND).participants,
    { 'worker:cargos-api': { state: 'gone', busy: false, stall: null, id: null } }) ?? []).length === 0);

const inboxSecond = await loose.call('tools/call', { name: 'promptobus_mailbox', arguments: { task: SECOND } });
check('inbox: the task argument fetches the mailbox of the named task',
  text(inboxSecond).includes('отчёт по второй задаче') && text(inboxSecond).includes(`task=${SECOND}`),
  text(inboxSecond));

const emptySecond = await loose.call('tools/call', { name: 'promptobus_mailbox', arguments: { task: SECOND } });
check('inbox: an empty mailbox of the named task names that same task',
  text(emptySecond).startsWith('empty') && text(emptySecond).includes(`task=${SECOND}`), text(emptySecond));

const schemas = await loose.call('tools/list', {});
check('tools/list: the task argument is declared on all three tools',
  (schemas.result?.tools ?? []).every((t) => t.inputSchema?.properties?.task?.type === 'string'),
  (schemas.result?.tools ?? []).map((t) => `${t.name}:${!!t.inputSchema?.properties?.task}`).join(','));

loose.stop();
store.closeTask(HOME, SECOND);

// --- the task name in identity ------------------------------------------
//
// There's one `orchestrator` address per task, and it has no owner: a session that hasn't
// declared a task attaches to the single active one — in the live case, someone else's — and reads its
// inbox. There's deliberately no prohibition here (a successor session must be able to reach its own
// correspondence), but an id made of a slug and a timestamp doesn't give away that it's a foreign task,
// while the title gives it away immediately.
const picking = startServer('orchestrator', { task: '' });
await picking.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
picking.notify('notifications/initialized');

const pickedInbox = await picking.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': an empty inbox names the task by title, not just by id',
  text(pickedInbox).includes(`task=${TASK} "событие CargoCreated в двух сервисах"`), text(pickedInbox));

// The non-empty identity branch already printed this before  — what's new here is the task's name.
await worker.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'сообщение в подобранную задачу' },
});
const pickedMsgs = await picking.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': a non-empty mailbox names the home, the task with its title, and the address',
  text(pickedMsgs).includes('сообщение в подобранную задачу')
    && text(pickedMsgs).includes(`PROMPTOBUS_HOME=${HOME}`)
    && text(pickedMsgs).includes(`task=${TASK} "событие CargoCreated в двух сервисах"`)
    && text(pickedMsgs).includes('address=orchestrator'),
  text(pickedMsgs));
picking.stop();

// A mirror of the same bug: the send response didn't name the mailbox at all, and a message that went
// to a foreign task looked like it went to your own.
const namedSend = await worker.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'проверка ящика отправки' },
});
check(': send names the mailbox the message landed in',
  /sent status → orchestrator · address orchestrator/.test(text(namedSend))
    && text(namedSend).includes(`PROMPTOBUS_HOME=${HOME}`)
    && text(namedSend).includes(`task=${TASK} "событие CargoCreated в двух сервисах"`)
    && text(namedSend).includes('address=worker:cargos-api'),
  text(namedSend));
store.readInbox(HOME, TASK, 'orchestrator');

// A task created with no title gets title = id: identity must not show empty quotes or a
// doubled-up id.
const NAMELESS = 't20260813-110000';
store.createTask(HOME, { id: NAMELESS });
check(': a task with no name prints a single id, without quotes',
  store.identityLabel(HOME, NAMELESS, 'orchestrator') === `PROMPTOBUS_HOME=${HOME} · task=${NAMELESS} · address=orchestrator`,
  store.identityLabel(HOME, NAMELESS, 'orchestrator'));
store.closeTask(HOME, NAMELESS);

// --- the orchestrator mailbox's owner ------------------------------------
//
// The default role is orchestrator, and with a single active task it's picked by resolution: anyone
// can land at this address, and a foreign session used to carry off the original, leaving the real
// recipient unable to see it anymore. There's deliberately no prohibition — a successor session whose
// daemon died must be able to reach its own correspondence. So a stranger gets a copy and a route
// instead: not your correspondence — name your own task; it is yours — take over the mailbox with
// the claim argument.
const OWNED = 'owned-t20260827-000000';
const OWNER = 'owner-1111-2222';
const STRANGER = 'stranger-3333-4444';
store.createTask(HOME, { id: OWNED, title: 'ящик с владельцем', owner: OWNER });
check(': the owner is recorded on the orchestrator participant when the task is created',
  store.taskOwner(HOME, OWNED) === OWNER, String(store.taskOwner(HOME, OWNED)));

const boot = async (srv) => {
  await srv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  srv.notify('notifications/initialized');
  return srv;
};
const owns = await boot(startServer('orchestrator', { task: OWNED, env: { CLAUDE_CODE_SESSION_ID: OWNER } }));
const alien = await boot(startServer('orchestrator', { task: OWNED, env: { CLAUDE_CODE_SESSION_ID: STRANGER } }));
const anon = await boot(startServer('orchestrator', { task: OWNED, env: { CLAUDE_CODE_SESSION_ID: '' } }));
const putOwned = (body) => store.sendMessage(HOME, OWNED, { from: 'worker:cargos-api', to: 'orchestrator', type: 'result', body });

putOwned('оригинал владельца');
const alienInbox = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': a foreign session gets a copy with a loud header, both ids, and a route',
  /FOREIGN MAILBOX/.test(text(alienInbox)) && text(alienInbox).includes(OWNER) && text(alienInbox).includes(STRANGER)
  && text(alienInbox).includes('оригинал владельца') && /claim/.test(text(alienInbox)), text(alienInbox));
// dead: the re-arm hint no longer exists in any language — PB-9.1
check(': a foreign mailbox carries no hint about the wait (dead branch, PB-9.1)',
  !/запусти ожидание снова/.test(text(alienInbox)), text(alienInbox));
check(`: the original stayed in the owner's mailbox`,
  store.countInbox(HOME, OWNED, 'orchestrator') === 1,
  String(store.countInbox(HOME, OWNED, 'orchestrator')));

// , review note: ONLY the mailbox's owner registers a contact point. A session that
// arrived in a foreign task via the "single active task" resolve would otherwise have written its own
// socket into the foreign run's `wake/orchestrator.json` — and the warden would wake it up instead of
// the owner. The cost is double: the knock goes to the wrong place, and the real owner's mailbox
// doesn't empty out in the meantime (a stranger only gets copies) — so the knock repeats until it hits
// the ceiling.
//
// The socket here is fake: what's checked is whether the file was written, not delivery.
const wakeEnv = (id) => ({
  CLAUDE_CODE_SESSION_ID: id,
  CLAUDE_CODE_MESSAGING_SOCKET: `/tmp/promptobus-mcp-wake-${id}.sock`,
  CLAUDE_CODE_MESSAGING_TOKEN: `tok-${id}`,
});
const alienWake = await boot(startServer('orchestrator', { task: OWNED, env: wakeEnv(STRANGER) }));
await alienWake.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': a foreign session does not register a contact point',
  store.readWake(HOME, OWNED, 'orchestrator') === null,
  JSON.stringify(store.readWake(HOME, OWNED, 'orchestrator')));
const ownerWake = await boot(startServer('orchestrator', { task: OWNED, env: wakeEnv(OWNER) }));
await ownerWake.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(`: the mailbox's owner does register a contact point`,
  store.readWake(HOME, OWNED, 'orchestrator')?.socket === `/tmp/promptobus-mcp-wake-${OWNER}.sock`,
  JSON.stringify(store.readWake(HOME, OWNED, 'orchestrator')));
// Both servers are stopped right away: a live child process keeps the file's event loop alive, and
// the file would never finish at all — the runner would kill it on a timeout as hung.
alienWake.stop();
ownerWake.stop();
rmSync(store.wakeFile(HOME, OWNED, 'orchestrator'), { force: true });

check(': reading the foreign mailbox did not carry off the original',
  store.countInbox(HOME, OWNED, 'orchestrator') === 1,
  String(store.countInbox(HOME, OWNED, 'orchestrator')));

const anonInbox = await anon.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': the environment gave no identity — the mechanism stays silent, reading behaves as before',
  !/FOREIGN MAILBOX/.test(text(anonInbox)) && text(anonInbox).includes('оригинал владельца')
  && store.countInbox(HOME, OWNED, 'orchestrator') === 0, text(anonInbox));

putOwned('второй оригинал');
const ownerInbox = await owns.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': the owner reads its own mailbox as before — originals get consumed',
  !/FOREIGN MAILBOX/.test(text(ownerInbox)) && text(ownerInbox).includes('второй оригинал')
  && store.countInbox(HOME, OWNED, 'orchestrator') === 0, text(ownerInbox));

putOwned('преемнику');
const claimed = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } });
check(': claim binds the mailbox to the successor, names the previous owner, and delivers the originals',
  /MAILBOX CLAIMED/.test(text(claimed)) && text(claimed).includes(OWNER) && text(claimed).includes(STRANGER)
  && text(claimed).includes('преемнику') && store.taskOwner(HOME, OWNED) === STRANGER
  && store.countInbox(HOME, OWNED, 'orchestrator') === 0, text(claimed));

// : a claim is also a rebind, but the "resolves without an argument from now on" promise
// only holds for the ACTIVE task (review note). Claiming a closed task is legal — nobody forbids
// reading its correspondence — but only an active one gets bound (`bindSession`), and resolution
// never lands on a closed task: promising it there would be a lie in the response.
check(': claiming an active task bound the session and promised argument-free resolution',
  store.boundTaskId(HOME, STRANGER) === OWNED
  && /from now on the task resolves without an argument/.test(text(claimed)), text(claimed));
const CLOSED_TASK = 'zakrytaya-t20260829-040000';
store.createTask(HOME, { id: CLOSED_TASK, title: 'закрытый заход', owner: OWNER });
store.closeTask(HOME, CLOSED_TASK);
const claimedClosed = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true, task: CLOSED_TASK } });
check(': claiming a closed task succeeds, but does not promise argument-free resolution',
  /MAILBOX CLAIMED/.test(text(claimedClosed))
  && !/from now on the task resolves without an argument/.test(text(claimedClosed))
  && store.boundTaskId(HOME, STRANGER) === OWNED, text(claimedClosed));

const CLAIM_WAKE = 'claimwake-t20260904-030000';
const CLAIM_OLD = 'claim-old-sess';
const CLAIM_NEW = 'claim-new-sess';
store.createTask(HOME, { id: CLAIM_WAKE, title: 'claim сдаёт сокет', owner: CLAIM_OLD });
store.writeWake(HOME, CLAIM_WAKE, 'orchestrator', {
  socket: '/tmp/promptobus-mcp-wake-old.sock', token: 'old', session: CLAIM_OLD,
});
const heirMcp = await boot(startServer('orchestrator', { task: CLAIM_WAKE, env: wakeEnv(CLAIM_NEW) }));
const claimedWake = await heirMcp.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } });
check('successor: the same claim call rewrites the contact point to the new session',
  /MAILBOX CLAIMED/.test(text(claimedWake))
  && store.readWake(HOME, CLAIM_WAKE, 'orchestrator')?.session === CLAIM_NEW
  && store.readWake(HOME, CLAIM_WAKE, 'orchestrator')?.socket === `/tmp/promptobus-mcp-wake-${CLAIM_NEW}.sock`,
  `${text(claimedWake)}\n${JSON.stringify(store.readWake(HOME, CLAIM_WAKE, 'orchestrator'))}`);
heirMcp.stop();

putOwned('после захвата');
const afterClaim = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': after the claim, the successor reads without copies',
  !/FOREIGN MAILBOX/.test(text(afterClaim)) && text(afterClaim).includes('после захвата'), text(afterClaim));

putOwned('уже не твоё');
const wasOwner = await owns.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': the former owner itself becomes a stranger after the claim — one mailbox, one owner',
  /FOREIGN MAILBOX/.test(text(wasOwner)) && store.countInbox(HOME, OWNED, 'orchestrator') === 1, text(wasOwner));
store.readInbox(HOME, OWNED, 'orchestrator');

// An empty foreign mailbox without a header reads as "no messages": the route
// "name your own task or take over the mailbox" used to live only in the command's stdout — a channel
// the agent doesn't read. `mailbox` is called once per turn, not in a polling loop, so the header
// won't become noise here.
const emptyForeignInbox = await owns.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(': an empty foreign mailbox is also named as foreign — with a route to claim',
  text(emptyForeignInbox).startsWith('FOREIGN MAILBOX')
  && /claim/.test(text(emptyForeignInbox)), text(emptyForeignInbox));

// The unread counter tells a foreign mailbox something different: "fetch it with the inbox tool"
// would be a lie there and would lead exactly where the gate forbids going — the signal would work
// against the very protection this task was built for.
putOwned('счётчик чужому');
const foreignCount = await owns.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': for a stranger, the counter does not call for inbox — the signal does not work against the gate',
  /FOREIGN MAILBOX: unread 1/.test(text(foreignCount)) && !/your mailbox/.test(text(foreignCount))
  && /claim/.test(text(foreignCount)), text(foreignCount));
joinWorker(HOME, OWNED);
const foreignSend = await owns.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'status', body: 'счётчик в ответе отправки' },
});
check(': the same wording appears in the send response',
  /FOREIGN MAILBOX: unread 1/.test(text(foreignSend)) && !/your mailbox/.test(text(foreignSend)),
  text(foreignSend));
store.readInbox(HOME, OWNED, 'orchestrator');

const ownedTask = await alien.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': the owner is named in the participant list — it needs no separate rendering',
  new RegExp(`- orchestrator · owner ${STRANGER}`).test(text(ownedTask)), text(ownedTask));

// Backward compatibility: a task created by an older CLI has no owner — the mechanism is
// switched off entirely, otherwise old tasks would become unreadable.
const LEGACY = 'legacy-t20260827-000000';
store.createTask(HOME, { id: LEGACY, title: 'задача прежнего CLI', owner: null });
store.sendMessage(HOME, LEGACY, { from: 'worker:cargos-api', to: 'orchestrator', type: 'status', body: 'наследство' });
const legacyRead = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: { task: LEGACY } });
check(': a task without an owner behaves as before — no copies, no warnings',
  !/FOREIGN MAILBOX/.test(text(legacyRead)) && text(legacyRead).includes('наследство')
  && store.countInbox(HOME, LEGACY, 'orchestrator') === 0, text(legacyRead));

const legacyClaim = await alien.call('tools/call', { name: 'promptobus_mailbox', arguments: { task: LEGACY, claim: true } });
check(': claim on an ownerless task — refused, we do not switch on the gate retroactively',
  /has no owner/.test(text(legacyClaim)) && store.taskOwner(HOME, LEGACY) === null, text(legacyClaim));

const anonClaim = await anon.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } });
check(': claim with no session identity — a loud refusal, not a silent no-op',
  /nothing to claim the mailbox with/.test(text(anonClaim)) && store.taskOwner(HOME, OWNED) === STRANGER, text(anonClaim));

const workerClaim = await worker.call('tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } });
check(`: claim on the worker — a loud refusal: its address has no owner`,
  /has no owner/.test(text(workerClaim)), text(workerClaim));

store.closeTask(HOME, OWNED);
store.closeTask(HOME, LEGACY);
owns.stop();
alien.stop();
anon.stop();

// --- no task declared -----------------------------------------------------

const lost = await new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    cwd: SB,
    env: { ...process.env, PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_HOME: path.join(SB, 'empty'), PROMPTOBUS_TASK: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    out += c;
    if (out.includes('\n')) {
      child.kill();
      resolve(JSON.parse(out.split('\n')[0]));
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'promptobus_task', arguments: {} } }) + '\n');
});
check('with no active task: the tool explains how to create one',
  lost.result?.isError === true && /promptobus spawn/.test(lost.result.content[0].text),
  lost.result?.content?.[0]?.text?.slice(0, 120));

// --- : the first line names, it doesn't count ----------------------------
//
// Claude Code puts an MCP tool's response into a collapsed tool block, and a human sees
// only a preview of the first line. "messages: 3" doesn't tell you whether the block is worth
// expanding. Building the first line itself, and the participant's readable name, are pure
// functions of the package, and every branch of them is tested in its own suite (`mcp.test.mjs`).
// What's left here is what isn't there: a live response from the CLI server.
// A live response is more than just the function itself: without this check, it could be detached
// from renderMessages, and the first line would go back to counting while the verdict stayed silent.
const sameHead = text(sameInbox).split('\n')[0];
check(': the first line of a live response names the sender and both types',
  sameHead.startsWith('messages 2: status from worker:cargos-api, result from worker:cargos-api ·'), sameHead);
// The machine-readable tail is in place — it's the reason the line is read at all.
check(': the machine-readable tail of the first line is preserved in full',
  sameHead.includes(`PROMPTOBUS_HOME=${HOME}`) && sameHead.includes('address=orchestrator')
  && sameHead.includes(TASK), sameHead);
// The send response names the type and recipient first — before the machine-readable tail.
check(': the send response starts with what went where and to whom',
  /^sent task → cargos-api · address worker:cargos-api/.test(text(sent)), text(sent).split('\n')[0]);

// --- : the "no call" alarm is gone ---------------------------------
//
// Removing the marker — before, this exact state raised an alarm in the response's first line.
// The wait left the protocol along with it: there's nothing to set up and nothing to call for. This is
// guarded by the first lines of both responses: the alarm used to sit in exactly that spot, and it's
// now occupied by the substance of the response — what and to whom it went, which task.
const gapSend = await orch.call('tools/call', {
  name: 'promptobus_send',
  arguments: { to: 'worker:cargos-api', type: 'status', body: 'звонка нет и не надо' },
});
check(': send starts with what went where and to whom',
  /^sent status → cargos-api · address worker:cargos-api/.test(text(gapSend)),
  text(gapSend).split('\n')[0]);

const gapTask = await orch.call('tools/call', { name: 'promptobus_task', arguments: {} });
check(': task starts with the task, not with an alarm',
  text(gapTask).split('\n')[0].startsWith(`task ${TASK}`),
  text(gapTask).split('\n')[0]);

// --- : the session's readable name in bus responses ------------------------------
//
// The feed hook only sees `tool_input` and `tool_response` events — it has no access to the task
// journal, and it's the server's job to put the session name into the response. The name comes
// from the `name` field of the participant record (the same field `findSession` looks up), and the
// trailing parenthesized stamp `(MMDD-HHMM)` is stripped: in a feed line it costs space, and what
// distinguishes entries is the work's name, not the timestamp.
const NAMED = 'worker:gates';
const NAMED_FULL = 'Worker: Гейты lint: слепые зоны, контрактный маркер';
store.upsertParticipant(HOME, TASK, store.participantRecord(NAMED, { repo: 'agent-workspace/promptobus', name: `${NAMED_FULL} (0829-1208)` }));
const toNamed = await orch.call('tools/call', {
  name: 'promptobus_send', arguments: { to: NAMED, type: 'status', body: 'проверка имени' },
});
check(`: send names the recipient's readable name — without the trailing parenthesized stamp`,
  text(toNamed).startsWith(`sent status → ${NAMED_FULL} · address ${NAMED} · id `),
  text(toNamed).split('\n')[0]);
// The address and id haven't disappeared from the response: the hook doesn't surface them in the
// feed, but a human reading the raw response needs them to reply.
check(': the machine address and id remain in the send response',
  text(toNamed).includes(` · address ${NAMED} · id `) && /· id \S+ · PROMPTOBUS_HOME=/.test(text(toNamed)),
  text(toNamed).split('\n')[0]);

const gates = startServer(NAMED);
await gates.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
await gates.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'result', body: 'гейты закрыты' },
});
gates.stop();
const fromNamed = await orch.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check(`: the mailbox header names the session, with the machine address following`,
  text(fromNamed).includes(`### result from ${NAMED_FULL} · address ${NAMED} · `), text(fromNamed));
// A participant with no recorded name (a record from an older CLI, a participant added outside
// spawn) — the address with no role prefix: that's how the hook printed it before this change too.
check(': a participant with no recorded name is named by an address with no role prefix',
  /sent task → cargos-api · address worker:cargos-api/.test(text(sent)), text(sent).split('\n')[0]);


// --- : the route for a stalled participant reaches the agent --------------------------
//
// Before, it lived only in the stdout of a finished background command — a channel the
// agent doesn't read: the notification only carries the exit code and a file path. Its place is the
// `inbox` response: it's called exactly on wake-up, before the decision on the next step.
const STALLED = 'stalled-t20260828-150000';
const GHOST_NAME = 'Worker: призрак';
store.createTask(HOME, { id: STALLED, title: 'вставший участник' });
store.upsertParticipant(HOME, STALLED, store.participantRecord('worker:cargos-api', { name: GHOST_NAME }));
// A record with no pid next to a live record with a pid — "LISTED, but no process behind it"
//: the signal is self-calibrating, and one record alone isn't enough for it.
const STALL_BIN = path.join(ROOT, 'stall-bin');
// Review note: the `mailbox` response is the third consumer of the stop predicate, and it
// must stay silent about a normal end-of-turn on par with the postcard and `promptobus status`. The
// `worker:sdal` participant sent a `result` and ended its turn: its record is `blocked` with a live
// pid, but the message on the bus is newer than its last activation.
const SDAL_NAME = 'Worker: сдавший';
store.upsertParticipant(HOME, STALLED, store.participantRecord('worker:sdal', { name: SDAL_NAME }));
const sdalMsg = store.sendMessage(HOME, STALLED,
  { from: 'worker:sdal', to: 'orchestrator', type: 'result', body: 'итог куска' });
store.writeHealth(HOME, STALLED,
  { 'worker:sdal': { deliveredAt: new Date(Date.parse(sdalMsg.message.ts) - 60000).toISOString() } });
stubCommand(STALL_BIN, 'claude', `process.stdout.write(${JSON.stringify(JSON.stringify([
  { id: 'live9', name: 'Worker: живой', state: 'working', pid: 9191 },
  { id: 'ghost9', name: GHOST_NAME, state: 'blocked' },
  { id: 'sdal9', name: SDAL_NAME, state: 'blocked', pid: 7777 },
]))});`);
const watcher = startServer('orchestrator', {
  task: STALLED,
  env: { PATH: `${STALL_BIN}${path.delimiter}${process.env.PATH}` },
});
await watcher.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
watcher.notify('notifications/initialized');
const stalledInbox = text(await watcher.call('tools/call', { name: 'promptobus_mailbox', arguments: {} }));
check(': inbox reports the stalled participant — in the same words as the command',
  /worker:cargos-api LISTED, but no process behind it/.test(stalledInbox)
  && /claude logs ghost9/.test(stalledInbox) && /each has its own route/.test(stalledInbox), stalledInbox);
// The report arrives in the tool's response, not only in the stdout of a finished command: it's
// read by the agent, and the route for a stalled participant must reach it.
// dead: the re-arm hint no longer exists in any language — PB-9.1
check(': the report does not call for re-arming the wait — each has its own route (dead branch, PB-9.1)',
  !/запусти ожидание снова/.test(stalledInbox), stalledInbox);
check('review note: the mailbox response does not call stalled someone who just sent a message',
  !/worker:sdal stalled/.test(stalledInbox) && /worker:cargos-api LISTED/.test(stalledInbox), stalledInbox);
watcher.stop();

// The worker has no one to watch: its counterpart isn't a bg-session but a human's session, and
// `claude agents --json` shows nothing of its stop — the same condition the command has.
const watcherWorker = startServer('worker:cargos-api', {
  task: STALLED,
  env: { PATH: `${STALL_BIN}${path.delimiter}${process.env.PATH}` },
});
await watcherWorker.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
watcherWorker.notify('notifications/initialized');
const workerInbox = text(await watcherWorker.call('tools/call', { name: 'promptobus_mailbox', arguments: {} }));
check(`: the worker gets no stall report — it has no one to watch`,
  !/LISTED/.test(workerInbox), workerInbox);
watcherWorker.stop();

// --- : a bad participant record does not bring task down --------------------
//
// A participant's address becomes the mailbox directory name, and `countInbox` used to crash on a
// record with a corrupted address, taking down the whole tool response with it: a session lost the
// ability to see participants, artifacts, and unread counts alike — because of a single journal line
// that this very response is meant to help fix. The corruption is written straight into the journal:
// `upsertParticipant` wouldn't let such an address through, and it only lands on disk via an older
// CLI or a manual edit.
const BADREC = 'negodnaya-t20260829-060000';
const badTask = store.createTask(HOME, { id: BADREC, title: 'негодная запись участника' });
// The record is valid by the store's schema and invalid by its address: the address is an adapter
// field, and the schema doesn't look at it at all. It has to be valid by the schema, otherwise the
// whole journal is corrupted, and that's a different case with its own response ("task corrupted").
const spoiled = (id, address, repo) => ({
  id, role: 'worker', harness: 'claude', mode: 'attached', sessionRef: null, capabilities: null,
  metadata: { address, repo },
});
badTask.participants.push(spoiled('worker-ne-adres', 'worker:НЕ АДРЕС', 'ns/repo'));
badTask.participants.push(spoiled('worker-cargos-api', 'worker:cargos-api', 'loads_search/cargos-api'));
writeFileSync(store.taskFile(HOME, BADREC), JSON.stringify(badTask, null, 2) + '\n');
const badServer = startServer('orchestrator', { task: BADREC });
await badServer.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
badServer.notify('notifications/initialized');
const badOut = await badServer.call('tools/call', { name: 'promptobus_task', arguments: {} });
const badText = text(badOut);
check(': one bad record does not bring task down — a response came back, not an error',
  badOut.result?.isError !== true && /task negodnaya-t20260829-060000/.test(badText), badText);
check(': the bad record is named in the response in full — it is used to fix the journal',
  /INVALID PARTICIPANT RECORD/.test(badText) && badText.includes('worker:НЕ АДРЕС'), badText);
check(': the other participants survive — orchestrator and worker are present with their counters',
  /- orchestrator .*unread 0/.test(badText)
  && /- worker:cargos-api .*unread 0/.test(badText), badText);
badServer.stop();

// ---  and : a broken message reaches the AGENT, not just stderr ------
//
// The report about a broken message used to live in a single `warn`. On the MCP path, stderr is
// the harness's log, which the session doesn't look at: the message disappeared from the mailbox
// without a single word in the tool's response. Same class of bug as the stalled-participant routes
// , and it's solved the same way — whatever's mandatory for the agent lives in the response.
const BROKEN = 'bitoe-t20260829-071000';
store.createTask(HOME, { id: BROKEN, title: 'битое доходит до агента' });
joinWorker(HOME, BROKEN);
const brokenBox = store.inboxDir(HOME, BROKEN, 'worker:cargos-api');
mkdirSync(brokenBox, { recursive: true });
// This is what a file left by a process that died mid-write under the older CLI looks like (no link/rename).
const BROKEN_NAME = '20260829T071000000-0001-orchestrator.json';
writeFileSync(path.join(brokenBox, BROKEN_NAME), 'не json вовсе');
store.sendMessage(HOME, BROKEN, {
  from: 'orchestrator', to: 'worker:cargos-api', type: 'status', body: 'целое рядом с битым',
});
const brokenSrv = startServer('worker:cargos-api', { task: BROKEN });
await brokenSrv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
brokenSrv.notify('notifications/initialized');
const brokenInbox = text(await brokenSrv.call('tools/call', { name: 'promptobus_mailbox', arguments: {} }));
check(': inbox names the broken message in the RESPONSE, not only in stderr',
  brokenInbox.includes('BROKEN MESSAGE') && brokenInbox.includes(BROKEN_NAME), brokenInbox);
check(': the report comes as the first line — it is a finding, and the tail of a long response is not always read',
  brokenInbox.startsWith('BROKEN MESSAGE'), brokenInbox.split('\n')[0]);
check(': an intact message next to the broken one arrived in the same response',
  brokenInbox.includes('целое рядом с битым'), brokenInbox);

// The same report — on an EMPTY response: the broken message has left the mailbox, there's nothing
// intact next to it, and without the line in the response the agent would see an ordinary "empty".
const SECOND_BROKEN = '20260829T071500000-0001-orchestrator.json';
writeFileSync(path.join(brokenBox, SECOND_BROKEN), '{"оборван');
const brokenEmpty = text(await brokenSrv.call('tools/call', { name: 'promptobus_mailbox', arguments: {} }));
check(': mailbox names the broken message even on an empty response',
  brokenEmpty.includes('BROKEN MESSAGE') && brokenEmpty.includes(SECOND_BROKEN)
  && brokenEmpty.includes('empty'), brokenEmpty);
check(': both broken messages moved into broken/, the mailbox is not clogged',
  store.countInbox(HOME, BROKEN, 'worker:cargos-api') === 0
  && readdirSync(store.brokenDir(HOME, BROKEN, 'worker:cargos-api')).length === 2,
  readdirSync(store.brokenDir(HOME, BROKEN, 'worker:cargos-api')).join(','));
brokenSrv.stop();

// --- a batch of messages leaves in one response -----------------------------------
//
// The task and mailbox here are dedicated: messages left over from earlier checks would otherwise
// mix in with this batch.
const RACE = 'pachka-t20260829-070500';
store.createTask(HOME, { id: RACE, title: 'пачка одним ответом' });
joinWorker(HOME, RACE);
const racer = startServer('worker:cargos-api', { task: RACE });
await racer.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
racer.notify('notifications/initialized');

for (const body of ['первое из пачки', 'второе из пачки', 'третье из пачки']) {
  store.sendMessage(HOME, RACE, { from: 'orchestrator', to: 'worker:cargos-api', type: 'status', body });
}
check(`the whole batch sits in the mailbox — there's no one to split it`,
  store.countInbox(HOME, RACE, 'worker:cargos-api') === 3,
  String(store.countInbox(HOME, RACE, 'worker:cargos-api')));
const whole = await racer.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
check('the whole batch arrives in one response',
  ['первое из пачки', 'второе из пачки', 'третье из пачки'].every((b) => text(whole).includes(b))
  && store.countInbox(HOME, RACE, 'worker:cargos-api') === 0, text(whole));

// --- response order is request order --------------------------------------
//
// The tools are synchronous, so requests are processed strictly one at a time and responses arrive
// in request order. Introduce an asynchronous one, and the order would have to be re-derived by
// everyone who reads this channel — starting with the server itself.
const ordered = racer.batch([
  { method: 'ping', params: {} },
  { method: 'tools/call', params: { name: 'promptobus_task', arguments: {} } },
  { method: 'tools/list', params: {} },
  { method: 'tools/call', params: { name: 'promptobus_mailbox', arguments: {} } },
  { method: 'tools/call', params: { name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'по очереди' } } },
  { method: 'ping', params: {} },
]);
const answers = await Promise.all(ordered);
const asked = answers.map((a) => a.id);
const came = racer.arrived.filter((id) => asked.includes(id));
check('method order is preserved — responses arrived in request order',
  came.join(',') === asked.join(','), `${came.join(',')} vs ${asked.join(',')}`);
check('and every one of them got a reply, with no tool error',
  answers.every((a) => a.result !== undefined && a.result.isError !== true),
  JSON.stringify(answers.map((a) => a.result?.isError ?? 'ok')));
racer.stop();

// The verdict on the real servers — BEFORE the probe below, not after: the probe starts a server
// that deliberately writes garbage, and a verdict placed after it could never go red regardless of
// the code's behavior.
check('the servers wrote nothing to stdout except line-delimited JSON-RPC',
  strays.length === 0, strays.slice(0, 3).map((x) => `${x.role}: ${x.line}`).join(' | '));

// --- : a stray line in stdout — a red check, not the file dying ---
//
// A live probe, not a reasoned argument: the server is a process that writes non-JSON to stdout.
// Before the fix, this same input took down the whole file on the very first chunk. We count the
// delta, not the length: the real servers above already got their verdict, and resetting the
// accumulator under them would mean erasing the evidence.
const straysBefore = strays.length;
const noisy = startServer('worker:cargos-api', {
  config: { command: process.execPath, args: ['-e', "process.stdout.write('не json вовсе\\n')"] },
});
for (let i = 0; i < 200 && strays.length === straysBefore; i += 1) await new Promise((r) => { setTimeout(r, 20); });
noisy.stop();
check(': a stray line from the server is recorded and named, and the file survives',
  strays.length - straysBefore === 1 && strays[strays.length - 1].line === 'не json вовсе',
  JSON.stringify(strays.slice(straysBefore)));

// --- : protocol error wording stays with the adapter ---------------------
//
// The package names the event by type and sets the JSON-RPC code, while the wording comes from
// `errorText` in [server.js](../lib/server.js). The codes are checked above, the wording — nowhere: if
// it drifted off into the callback, the text could silently drift too. This uses a separate
// connection: the response to an unparsable line comes with `id: null`, has no promise waiting for
// it, and would have landed among the neighboring servers' unsolicited messages — and those are
// checked elsewhere for having none.
const words = startServer('orchestrator');
await words.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
const noMethod = await words.call('resources/list', {});
check(': the unknown-method text is unchanged, word for word',
  noMethod.error?.message === 'method "resources/list" is not supported', JSON.stringify(noMethod.error));
const noTool = await words.call('tools/call', { name: 'teleport', arguments: {} });
check(': the unknown-tool text is unchanged, word for word',
  text(noTool) === 'error: unknown tool "teleport"', text(noTool));
const failedTool = await words.call('tools/call', {
  name: 'promptobus_send', arguments: { to: 'worker:cargos-api', type: 'gossip', body: 'текст' },
});
check(': a tool failure starts with "error: " and carries no stack trace',
  text(failedTool).startsWith('error: ') && !/\n\s+at /.test(text(failedTool)), text(failedTool));
words.raw('{ это не json\n');
for (let i = 0; i < 200 && words.unsolicited.length === 0; i += 1) await new Promise((r) => { setTimeout(r, 20); });
const parseFail = words.unsolicited[0];
check(': an unparsable line — -32700 with the same text and id null',
  parseFail?.id === null && parseFail?.error?.code === -32700
  && parseFail?.error?.message === 'not parsed as JSON', JSON.stringify(parseFail));
const afterParse = await words.call('ping', {});
check(': the connection survived the unparsable line',
  afterParse.result && Object.keys(afterParse.result).length === 0, JSON.stringify(afterParse));
words.stop();

// --- : migration with PROMPTOBUS_HOME declared --------------------------------
//
// The most common first touch of the store is a bus tool call from a session whose home is
// declared via the environment variable. A standalone host doesn't declare a legacy layout
// (`legacyLayout() === null`), so the migration here is invoked through the same adapter, with an
// explicit layout, the way commands invoke it.
const MIG_ROOT = path.join(SB, 'pereezd');
mkdirSync(MIG_ROOT, { recursive: true });
writeFileSync(path.join(MIG_ROOT, 'promptobus.json'), `${JSON.stringify({ commandName: 'promptobus', tools: ['claude'] })}\n`);
const MIG_LEGACY = path.join(MIG_ROOT, 'legacy', 'a2a');
const MIG_TASK = 'pereezd-t20260902-090000';
const { legacy } = await import(path.join(here, '..', 'dist', 'index.js'));
legacy.createTask(MIG_LEGACY, { id: MIG_TASK, title: 'задача прежнего store', owner: OWNER });
legacy.upsertParticipant(MIG_LEGACY, MIG_TASK, { address: 'worker:cargos-api', repo: 'cargos-api' });
legacy.sendMessage(MIG_LEGACY, MIG_TASK, {
  from: 'worker:cargos-api', to: 'orchestrator', type: 'result', body: 'итог из прежнего store',
});
legacy.closeTask(MIG_LEGACY, MIG_TASK);

const migHost = { legacyLayout: () => ({ rel: 'legacy/a2a', done: 'promptobus done <id>' }) };
const movedId = store.resolveIdentity({
  PROMPTOBUS_ROLE: 'orchestrator',
  PROMPTOBUS_HOME: MIG_LEGACY,
  PROMPTOBUS_TASK: MIG_TASK,
}, MIG_ROOT, { host: migHost });
check(': resolveIdentity with a host that names a legacy layout migrates into the new store',
  movedId.home === realpathSync(path.join(MIG_ROOT, '.promptobus'))
  && !existsSync(MIG_LEGACY)
  && existsSync(path.join(MIG_ROOT, '.promptobus', 'tasks', MIG_TASK, 'task.json')),
  `${movedId.home} · legacy ${existsSync(MIG_LEGACY)}`);

const stale = store.resolveIdentity({
  PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_HOME: MIG_LEGACY,
}, MIG_ROOT, { host: migHost });
check(': a stale PROMPTOBUS_HOME leads to the new root and does not recreate the legacy one',
  stale.home === realpathSync(path.join(MIG_ROOT, '.promptobus')) && !existsSync(MIG_LEGACY),
  `${stale.home} · legacy ${existsSync(MIG_LEGACY) ? 'revived' : 'removed'}`);

// --- : the participant lines assembled by the adapter ----------------------
//
// `repository`, `worktree … (branch)`, and `bg-session` in the `task` response are assembled by
// `decorateParticipant` ([server.js](../lib/server.js)) — the store never prints these fields itself.
// Before this task, nobody checked them: a mutation probe  detached the decoration hook
// entirely, and this file stayed green — only the package's golden suite went red, and only on the
// `repository` line. The worktree here is REAL: the branch in this line is named by git, not by the
// journal, and a made-up path would have been checking the journal's branch instead.
const DECOR = 'decor-t20260902-130000';
const DECOR_REPO = path.join(ROOT, 'repo-decor');
const DECOR_BRANCH = 'worktree-promptobus-decor';
const DECOR_WT = path.join(DECOR_REPO, '.claude', 'worktrees', 'promptobus-decor');
// The exit code belongs to git itself, not to the harness: a failing `worktree add` (or `init -b`
// on git older than 2.28) would give a red "git did not answer — worktree removed?", meaning it would
// swap the subject of the check for the journal's branch and blame the mechanism.
const git = (...args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr ?? r.error?.message ?? 'no diagnosis'}`);
  return r;
};
mkdirSync(DECOR_REPO, { recursive: true });
git('init', '-q', '-b', 'main', DECOR_REPO);
git('-C', DECOR_REPO, 'config', 'user.email', 'stend@example.invalid');
git('-C', DECOR_REPO, 'config', 'user.name', 'stend');
git('-C', DECOR_REPO, 'commit', '-q', '--allow-empty', '-m', 'init');
git('-C', DECOR_REPO, 'worktree', 'add', '-q', '-b', DECOR_BRANCH, DECOR_WT);
store.createTask(HOME, { id: DECOR, title: 'строки участника в ответе task', owner: OWNER });
store.upsertParticipant(HOME, DECOR, store.participantRecord('worker:cargos-api', { repo: 'loads_search/cargos-api',
  worktree: DECOR_WT,
  branch: DECOR_BRANCH,
  session: 'ab12cd34' }));
// The neighboring record has none of the adapter's fields at all: the lines aren't invented —
// `orchestrator` has no directory at all, and `worktree undefined` in its line would be a lie.
store.upsertParticipant(HOME, DECOR, store.participantRecord('worker:web'));
const decorSrv = startServer('orchestrator', { task: DECOR });
await decorSrv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
decorSrv.notify('notifications/initialized');
const decorOut = text(await decorSrv.call('tools/call', { name: 'promptobus_task', arguments: {} }));
decorSrv.stop();
const decorLine = decorOut.split('\n').find((l) => l.startsWith('- worker:cargos-api')) ?? '';
const bareLine = decorOut.split('\n').find((l) => l.startsWith('- worker:web')) ?? '';
check(`: the task response prints the participant's repository`,
  decorLine.includes('repository loads_search/cargos-api'), decorLine || decorOut);
// A whole chunk of the line, not three separate includes: the order of the parts is a contract
// shared with `promptobus status`, and a check built from separate `includes` calls would silently
// survive a reordering.
check(`: the task response prints the participant's worktree with the real git branch — before bg-session`,
  decorLine.includes(`worktree ${DECOR_WT} (branch ${DECOR_BRANCH}) · bg-session ab12cd34`),
  decorLine || decorOut);
check(': a participant with no repository, worktree, or session has none of these lines',
  bareLine.startsWith('- worker:web · unread')
  && !/(repository |worktree |bg-session)/.test(bareLine), bareLine || decorOut);

// --- : a version mismatch — the refusal text reaches the tools -------------
//
// The journal reader's refusal is assembled by the package, and the adapter carries it to the
// agent as the line `error: <text>` ([server.js](../lib/server.js), `tool-failed`). This path is
// shared by all the tools, but it's checked right here: the live case  came not from the
// CLI, but from a `promptobus_send` call made by a session running against a server from an older
// release.
//
// The journal is edited on disk by hand: this version's mechanism never writes a record newer than
// itself, and there's no other way to assemble one — it is, by definition, a record from a mechanism
// that doesn't exist yet.
const MIXED = 'smes-t20260903-090000';
store.createTask(HOME, { id: MIXED, title: 'смесь версий механизма', owner: OWNER });
store.upsertParticipant(HOME, MIXED, store.participantRecord('worker:cargos-api', { repo: 'loads_search/cargos-api' }));
{
  const file = path.join(HOME, 'tasks', MIXED, 'task.json');
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({
    ...meta,
    participants: meta.participants.map((p) => (p.role === 'worker'
      ? {
        ...p,
        // A snapshot field this release doesn't know about, with a mechanism version newer than itself.
        capabilities: { ...(p.capabilities ?? {}), resume: true },
        metadata: { ...p.metadata, [MECHANISM_VERSION_FIELD]: '99.0.0' },
      }
      : p)),
  }, null, 2) + '\n');
}
const mixedSrv = startServer('worker:cargos-api', { task: MIXED });
await mixedSrv.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
mixedSrv.notify('notifications/initialized');
const mixedSend = await mixedSrv.call('tools/call',
  { name: 'promptobus_send', arguments: { to: 'orchestrator', type: 'status', body: 'проба' } });
const mixedBox = await mixedSrv.call('tools/call', { name: 'promptobus_mailbox', arguments: {} });
mixedSrv.stop();
const sendText = text(mixedSend);
const boxText = text(mixedBox);
check(': promptobus_send answers "start a new session", not "journal does not match the schema"',
  mixedSend.result?.isError === true && /written by mechanism 99\.0\.0/.test(sendText)
  && /start a new session/.test(sendText) && !/does not match the schema/.test(sendText), sendText);
check(': promptobus_mailbox answers with the same text — there is one path for the refusal',
  mixedBox.result?.isError === true && /start a new session/.test(boxText)
  && /the bus MCP server starts from the installed release/.test(boxText), boxText);

orch.stop();
worker.stop();
rmSync(SB, { recursive: true, force: true });

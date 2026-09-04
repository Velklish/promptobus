// Golden protocol of the bus MCP server at its own boundary. Run with `npm test`.
//
// There is no parent repository here at all: no workspace rules, no Git, no
// harness binary, no consumer modules. The server is raised by the factory with
// in-memory streams, and everything it knows about the workspace arrives as
// stand-in callbacks — exactly those the adapter uses to raise it. That is how
// the boundary promise is checked: the transport and the dispatcher work
// without a harness.
//
// The `tools/list` snapshot sits next to this file ([fixtures/tools.json](fixtures/tools.json)).
// It was taken from a live `v0.61.0` server by the same stdio conversation
// Claude Code uses, and rewritten by hand on the hard rename to the new names
// — nothing else: a mismatch with it means the surface has moved.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import test from 'node:test';

const {
  addrDir, addressOf, createMcpServer, GateError, negotiateProtocol, openEngine, ORCHESTRATOR,
  ownerOf, PromptobusError, readableName, roleOf, summarizeMessages, ADDR_MARK, MESSAGE_TYPES,
} = await import('../dist/index.js');

// **The service is passed to the factory, and it has no default**: half the list
// rests on session identity — mailbox ownership, the binding, active-task resolve,
// and the reply heading — and only the adapter reads the environment. There is no
// adapter here, and a stand-in set plays its part: the service assembled below is
// a second, CLI-independent implementation of the same interface, and that is how
// it is checked. A routing policy is required when the engine is opened for the
// same reason; the sample policy ("a worker must not write to a worker") lives
// in the CLI and is checked there.
const engines = new Map();
const at = (home) => {
  if (!engines.has(home)) engines.set(home, openEngine({ home, policy: () => ({ allow: true }) }));
  return engines.get(home);
};

// Translating an address into a v1 participant record is the adapter's job: the
// address lives in the `metadata` field.
const rec = (address, fields = {}) => ({
  id: addrDir(address),
  role: roleOf(address),
  harness: 'proba',
  mode: 'attached',
  sessionRef: null,
  capabilities: null,
  metadata: { address, ...fields },
});

const createTask = (home, { id, title, owner = null }) => at(home).createTask({
  id, title, owner: rec(ORCHESTRATOR, owner ? { owner } : {}), adapter: {},
});
const upsertParticipant = (home, task, { address, ...fields }) => at(home)
  .putParticipant(task, rec(address, fields));
const taskFile = (home, task) => at(home).taskFile(task);
const filesDir = (home, task) => path.join(home, 'tasks', task, 'files');
const brokenLines = (notes) => notes.map((n) => `BROKEN MESSAGE ${n.name}: ${n.note}`);
// A v1 refusal to a person is a `GateError`: that is how both the task entry
// (a lawful refusal stays inside there, a breakage goes outward) and the
// top-level CLI catch read it.
const readTask = (home, task) => {
  try {
    return at(home).readTask(task);
  } catch (e) {
    if (e instanceof PromptobusError) throw new GateError(e.message);
    throw e;
  }
};
const ownerOfTask = (home, task) => ownerOf(readTask(home, task).participants
  .find((p) => addressOf(p) === ORCHESTRATOR));

const busService = {
  artifactsDir: filesDir,
  artifactName: (home, task, id) => {
    try {
      return at(home).readArtifact(task, id).filename;
    } catch {
      return undefined;
    }
  },
  bindSession: () => null,
  brokenNote: (broken) => (broken.length ? broken.join('\n') : null),
  claimOwnership: (home, task, session) => {
    const meta = at(home).readTask(task);
    const p = meta.participants.find((x) => addressOf(x) === ORCHESTRATOR);
    const was = ownerOf(p);
    at(home).patchParticipant(task, p.id, { metadata: { ...p.metadata, owner: session } });
    return was;
  },
  countInbox: (home, task, addr) => at(home).unread(task, addrDir(addr)),
  identityLabel: (home, task, addr) => `PROMPTOBUS_HOME=${home} · task=${task} · address=${addr}`,
  ownership: (home, task, addr, session) => {
    if (addr !== ORCHESTRATOR) return { gated: false, owner: null, session };
    const owner = ownerOfTask(home, task);
    if (!owner || !session) return { gated: false, owner, session };
    return { gated: owner !== session, owner, session };
  },
  peekInbox: (home, task, addr) => {
    const { messages, broken } = at(home).peek(task, addrDir(addr));
    return { messages, broken: brokenLines(broken) };
  },
  readInbox: (home, task, addr) => {
    const { messages, broken } = at(home).read(task, addrDir(addr));
    return { messages, broken: brokenLines(broken) };
  },
  readTask,
  resolveTaskId: (home, declared) => {
    if (declared) return declared;
    const active = at(home).listTasks().tasks.filter((t) => t.status === 'active');
    if (active.length === 1) return active[0].id;
    throw new GateError(`active tasks: ${active.length}`);
  },
  send: (home, task, { from, to, type, body }) => at(home)
    .sendSync(task, { from: addrDir(from), to: [addrDir(to)], type, body }),
  unreadNote: (home, task, addr) => {
    const n = at(home).unread(task, addrDir(addr));
    return n ? `your mailbox: unread ${n}` : null;
  },
  withTaskCache: (fn) => fn(),
};

const GOLDEN_TOOLS = JSON.parse(readFileSync(new URL('fixtures/tools.json', import.meta.url), 'utf8'));

// The snapshot is frozen whole, except for one place: the message-type enum in
// the `send` schema is a quote of the contract whose home is `MESSAGE_TYPES` in
// the store, and a neighbouring release is entitled to extend it. A literal in
// the snapshot would then go red with the diagnosis "the surface has moved",
// even though the contract that moved lives in another file — and the literal-
// copy gate does not look into `.json` at all (review remark). So before the
// check the enum is taken from the home: descriptions, names, and schemas stay
// golden, types are checked against the code — and a neighbouring check does
// that.
function expectedTools() {
  const tools = structuredClone(GOLDEN_TOOLS);
  tools.find((t) => t.name === 'promptobus_send').inputSchema.properties.type.enum = [...MESSAGE_TYPES];
  return tools;
}

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-mcp-'));
process.on('exit', () => rmSync(SB, { recursive: true, force: true }));

const home = path.join(SB, '.promptobus');
const TASK = 't20260813-090000';
const OWNER = 'session-orchestrator';
createTask(home, { id: TASK, title: 'событие CargoCreated в двух сервисах', owner: OWNER });
// A second task of the same home — so that entry by an EXPLICIT `task` is
// lawful even in a conversation where the session has already entered its own.
const SECOND = 't20260813-100000';
createTask(home, { id: SECOND, title: 'вторая задача того же дома', owner: OWNER });
upsertParticipant(home, TASK, {
  address: 'worker:cargos-api', repo: 'loads_search/cargos-api', session: 'bg-42',
});

// Protocol versions arrive as config: their home is at the consumer, and the
// package does not keep its own list. Here the list is this suite's own — and
// that is part of the check: negotiation works by the list that was passed,
// not by a baked-in one.
const VERSIONS = ['2026-01-01', '2025-06-18', '2024-11-05'];

// Event texts are the same as at the CLI adapter: the package names the event
// by type and sets the JSON-RPC code, the words stay with the consumer. The
// branches are named explicitly, and `default` does not read event fields: a
// stand-in `errorText` that failed where the real one does not would be
// checking the wrong thing.
function errorText(event) {
  switch (event.kind) {
    case 'parse': return 'not parsed as JSON';
    case 'unknown-method': return `method «${event.method}» is not supported`;
    case 'unknown-tool': return `error: unknown tool «${event.tool}»`;
    case 'tool-failed': return `error: ${event.cause.message}`;
    default: return 'error: protocol event not recognised';
  }
}

// One stdio conversation: lines go out as a single write, replies are collected
// in arrival order. Streams are in memory, not a process: the subject here is
// the protocol itself.
async function talk(lines, { role = 'orchestrator', session = OWNER, declaredTask = TASK, options = {} } = {}) {
  const calls = { identity: 0, info: 0, joins: [], decorated: [], stalls: [] };
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  const written = [];
  const server = createMcpServer({
    service: busService,
    protocolVersions: VERSIONS,
    resolveIdentity: () => {
      calls.identity += 1;
      return { role, home, declaredTask, session };
    },
    serverInfo: () => {
      calls.info += 1;
      return { name: 'promptobus', version: '0.62.0' };
    },
    onJoin: (join) => calls.joins.push(join),
    decorateParticipant: (p) => {
      calls.decorated.push(addressOf(p));
      return p.metadata.repo ? [`repository ${p.metadata.repo}`] : [];
    },
    stalls: (ctx) => {
      calls.stalls.push(ctx);
      return ctx.address === 'orchestrator' ? 'STALLED worker:cargos-api' : null;
    },
    errorText,
    ...options,
  });
  await server.serve({
    input: Readable.from([text], { objectMode: false }),
    output: { write: (chunk) => written.push(chunk) },
  });
  return { calls, written, responses: written.map((l) => JSON.parse(l)) };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const textOf = (res) => res.result?.content?.map((c) => c.text).join('\n') ?? '';

test('negotiation: a version from the served list is returned, an unknown one — the first of it', async () => {
  const { responses, calls } = await talk([
    rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} }),
    rpc(2, 'initialize', { protocolVersion: '2099-01-01', capabilities: {} }),
    rpc(3, 'initialize', { capabilities: {} }),
  ]);
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.equal(responses[1].result.protocolVersion, VERSIONS[0]);
  assert.equal(responses[2].result.protocolVersion, VERSIONS[0]);
  // Process identity is asked once per connection, the server name — on every
  // `initialize`: the consumer version changes with its release, not with the
  // course of the conversation.
  assert.equal(calls.identity, 1);
  assert.equal(calls.info, 3);
});

test('an empty version list is a refusal at server creation, not undefined in initialize', () => {
  // The gate sits at the factory: before the first connection, where the list
  // arrives as config.
  const opts = {
    service: busService, resolveIdentity: () => ({ role: 'orchestrator', home, declaredTask: TASK, session: OWNER }),
    serverInfo: () => ({ name: 'promptobus', version: '0.62.0' }), onJoin: () => {},
    decorateParticipant: () => [], stalls: () => null, errorText,
  };
  assert.throws(() => createMcpServer({ ...opts, protocolVersions: [] }), /protocolVersions is empty/);
  assert.throws(() => createMcpServer({ ...opts, protocolVersions: undefined }), /protocolVersions is empty/);
  assert.doesNotThrow(() => createMcpServer({ ...opts, protocolVersions: VERSIONS }));
});

test('the version agreement is a pure function of the served list, not of the client word', () => {
  assert.ok(VERSIONS.every((v) => negotiateProtocol(VERSIONS, v) === v));
  assert.equal(negotiateProtocol(VERSIONS, '2099-01-01'), VERSIONS[0]);
  assert.equal(negotiateProtocol(VERSIONS, undefined), VERSIONS[0]);
});

test('initialize: the server named itself by the consumer callback and declared the tools', async () => {
  const { responses } = await talk([rpc(1, 'initialize', { capabilities: {} })]);
  assert.deepEqual(responses[0].result.serverInfo, { name: 'promptobus', version: '0.62.0' });
  assert.deepEqual(responses[0].result.capabilities, { tools: {} });
});

test('the contact point is handed over on initialize and is not handed over a second time in the connection', async () => {
  // before this task, task entry hung only on `tools/call`, and a session that
  // shook hands and called no tool stayed deaf to the warden — it lawfully
  // fell back to `self-wake`. Identity is already resolved at `initialize`,
  // there is no need to wait for a tool.
  const one = await talk([rpc(1, 'initialize', { capabilities: {} })]);
  assert.deepEqual(one.calls.joins, [{ home, task: TASK, address: 'orchestrator', gated: false }]);
  // A repeat is not work: `onJoin` writes to the store and raises a process,
  // and a session enters a task once per connection. It is counted by task,
  // so three `initialize`s and two tool calls in a row give exactly one entry.
  //
  // It is counted BY TASK, not "once per connection": the last call is
  // `promptobus_task` with a DIFFERENT task as the argument, and its entry is
  // lawful — a boolean connection flag would have passed everything except
  // this line (review remark).
  const many = await talk([
    rpc(1, 'initialize', { capabilities: {} }),
    rpc(2, 'initialize', { capabilities: {} }),
    rpc(3, 'tools/call', { name: 'promptobus_task', arguments: {} }),
    rpc(4, 'tools/call', { name: 'promptobus_task', arguments: { task: TASK } }),
    rpc(5, 'tools/call', { name: 'promptobus_task', arguments: { task: SECOND } }),
  ]);
  assert.deepEqual(many.calls.joins, [
    { home, task: TASK, address: 'orchestrator', gated: false },
    { home, task: SECOND, address: 'orchestrator', gated: false },
  ]);
});

test('an entry that refused on the handshake leaves no mark — the next call enters', async () => {
  // `ownership` is the first real journal read: `resolveTaskId` only checks
  // that it exists. On an unparsed journal the entry lawfully refuses, and
  // the whole cost of the error is whether a mark was left behind: if it
  // was, the session would be counted as having entered without entering,
  // and the contact point would never be handed over in its lifetime
  // (review remark).
  //
  // The journal is repaired MID-conversation, and the seam for that is
  // `serverInfo`: it is called on the same `initialize`, but AFTER entry.
  // A hook between stream lines is no good here at all: the lines go out
  // as a single write, and `Readable` buffers them before the consumer
  // parses the first — the repair would land before the handshake, and the
  // check would be green under any mark implementation (verified by a
  // mutation probe: with a mark BEFORE entry it did not go red).
  const brokenHome = path.join(SB, 'broken', '.promptobus');
  createTask(brokenHome, { id: TASK, title: 'журнал, который чинят посреди разговора', owner: OWNER });
  const file = taskFile(brokenHome, TASK);
  const good = readFileSync(file, 'utf8');
  writeFileSync(file, '{ это не json');
  const { responses, calls } = await talk([
    rpc(1, 'initialize', { capabilities: {} }),
    rpc(2, 'tools/call', { name: 'promptobus_task', arguments: {} }),
  ], {
    options: {
      resolveIdentity: () => ({ role: 'orchestrator', home: brokenHome, declaredTask: TASK, session: OWNER }),
      serverInfo: () => {
        writeFileSync(file, good);
        return { name: 'promptobus', version: '0.62.0' };
      },
    },
  });
  // The handshake is alive: a lawful entry refusal does not bring it down —
  // the session would have been left without a bus exactly because it had
  // nothing to hand the contact point over with.
  assert.equal(responses[0].result.protocolVersion, VERSIONS[0]);
  assert.deepEqual(calls.joins, [{ home: brokenHome, task: TASK, address: 'orchestrator', gated: false }]);
  assert.match(textOf(responses[1]), new RegExp(`^task ${TASK} · журнал, который чинят`));
});

test('initialize without a resolvable task does not bring the handshake down — there is nowhere to enter', async () => {
  // The orchestrator server is raised with its session when there is no task
  // in the home yet at all: `resolveTaskId` lawfully refuses there, and the
  // refusal must stay inside the entry. Were it to escape — the session would
  // be left without a bus entirely, because it had nothing to hand the
  // contact point over with.
  const empty = path.join(SB, 'no-tasks', '.promptobus');
  const { responses, calls } = await talk([
    rpc(1, 'initialize', { capabilities: {} }),
    rpc(2, 'ping', {}),
  ], { options: { resolveIdentity: () => ({ role: 'orchestrator', home: empty, declaredTask: null, session: OWNER }) } });
  assert.equal(responses[0].result.protocolVersion, VERSIONS[0]);
  assert.deepEqual(responses[1].result, {});
  assert.deepEqual(calls.joins, []);
});

test('notifications/initialized gets no reply, and ping — an empty result', async () => {
  const { responses } = await talk([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    rpc(1, 'ping', {}),
  ]);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 1);
  assert.deepEqual(responses[0].result, {});
});

test('tools/list matches the live v0.61.0 server snapshot — to the character', async () => {
  const { responses } = await talk([rpc(1, 'tools/list', {})]);
  assert.deepEqual(responses[0].result.tools, expectedTools());
});

test('the send schema requires to/type/body and knows the v1 protocol types', async () => {
  const { responses } = await talk([rpc(1, 'tools/list', {})]);
  const send = responses[0].result.tools.find((t) => t.name === 'promptobus_send');
  assert.deepEqual(send.inputSchema.required, ['to', 'type', 'body']);
  assert.deepEqual(send.inputSchema.properties.type.enum, MESSAGE_TYPES);
  // Task as an argument — on every tool: `PROMPTOBUS_TASK` cannot be changed
  // in a live session.
  assert.ok(responses[0].result.tools.every((t) => t.inputSchema.properties.task));
});

test('tools/call: send puts the message and names the recipient, the address, and the mailbox', async () => {
  const { responses, calls } = await talk([
    rpc(1, 'tools/call', {
      name: 'promptobus_send',
      arguments: { to: 'worker:cargos-api', type: 'task', body: 'разбери контракт' },
    }),
  ]);
  const said = textOf(responses[0]);
  assert.match(said, /^sent task → cargos-api/);
  assert.ok(said.includes(`${ADDR_MARK}worker:cargos-api`));
  assert.ok(said.includes(`task=${TASK}`));
  // Task entry is before the tool work, and ownership is counted by the
  // package: the consumer hands over the contact point and raises the
  // listener, but only it knows with what.
  assert.deepEqual(calls.joins, [{ home, task: TASK, address: 'orchestrator', gated: false }]);
});

test('tools/call: mailbox returns what arrived and glues on the stalled diagnostic', async () => {
  await talk([
    rpc(1, 'tools/call', {
      name: 'promptobus_send',
      arguments: { to: 'orchestrator', type: 'status', body: 'взял в работу' },
    }),
  ], { role: 'worker:cargos-api', session: 'session-worker' });
  const { responses, calls } = await talk([
    rpc(1, 'tools/call', { name: 'promptobus_mailbox', arguments: {} }),
  ]);
  const said = textOf(responses[0]);
  assert.match(said, /^messages 1: status from worker:cargos-api/);
  assert.ok(said.endsWith('STALLED worker:cargos-api'));
  assert.deepEqual(calls.stalls, [{ home, task: TASK, address: 'orchestrator' }]);
});

test('tools/call: a foreign session mailbox is a copy with a loud heading, originals stay with the owner', async () => {
  const { responses, calls } = await talk([
    rpc(1, 'tools/call', { name: 'promptobus_mailbox', arguments: {} }),
  ], { session: 'session-чужая' });
  const said = textOf(responses[0]);
  assert.match(said, /^FOREIGN MAILBOX: the orchestrator address of task /);
  // The stalled diagnostic is not sent to a stranger: the route in it leads
  // where the gate does not let them.
  assert.deepEqual(calls.stalls, []);
  assert.deepEqual(calls.joins, [{ home, task: TASK, address: 'orchestrator', gated: true }]);
});

test('a foreign session gets no entry mark — once it becomes the owner, it enters on the same connection', async () => {
  // `onJoin` of a foreign session does not write a contact point (ownership
  // gate at the consumer), but it is entitled to become the owner on the
  // same connection — `mailbox {claim: true}`. Mark the stranger's entry,
  // and `wake/<address>.json` would point at the previous owner's socket
  // until the end of the turn (review remark). The home is this suite's
  // own: the claim rewrites the task owner, and neighbouring checks would
  // then read a foreign outcome.
  const claimHome = path.join(SB, 'claim', '.promptobus');
  createTask(claimHome, { id: TASK, title: 'захват посреди соединения', owner: OWNER });
  const heir = 'session-preemnik';
  const { calls } = await talk([
    rpc(1, 'initialize', { capabilities: {} }),
    rpc(2, 'tools/call', { name: 'promptobus_mailbox', arguments: { claim: true } }),
    rpc(3, 'tools/call', { name: 'promptobus_task', arguments: {} }),
  ], {
    options: { resolveIdentity: () => ({ role: 'orchestrator', home: claimHome, declaredTask: TASK, session: heir }) },
  });
  assert.deepEqual(calls.joins, [
    { home: claimHome, task: TASK, address: 'orchestrator', gated: true },
    { home: claimHome, task: TASK, address: 'orchestrator', gated: true },
    { home: claimHome, task: TASK, address: 'orchestrator', gated: false },
  ]);
});

test('tools/call: task prints the participants, and the workspace lines are given by the consumer', async () => {
  const { responses, calls } = await talk([rpc(1, 'tools/call', { name: 'promptobus_task', arguments: {} })]);
  const said = textOf(responses[0]);
  assert.match(said, new RegExp(`^task ${TASK} · событие CargoCreated в двух сервисах\n`));
  assert.ok(said.includes(`- orchestrator · owner ${OWNER} · unread 0`));
  assert.ok(said.includes('- worker:cargos-api · repository loads_search/cargos-api · unread 1'));
  assert.deepEqual(calls.decorated, ['orchestrator', 'worker:cargos-api']);
});

test('a bad participant record is a finding in the reply, not the death of the tool', async () => {
  const spoiled = path.join(SB, 'spoiled');
  createTask(spoiled, { id: TASK, title: 'журнал с испорченной записью', owner: OWNER });
  const meta = JSON.parse(readFileSync(taskFile(spoiled, TASK), 'utf8'));
  // The record is valid by the store schema and invalid by address: the
  // address is an adapter field, and the schema does not look at it at all.
  // It must be valid by the schema, otherwise the whole journal is spoiled,
  // and that is a different case with its own reply ("task is damaged").
  meta.participants.push({
    id: 'worker-spoiled',
    role: 'worker',
    harness: 'claude',
    mode: 'attached',
    sessionRef: null,
    capabilities: null,
    metadata: { address: 'worker:НЕ АДРЕС' },
  });
  writeFileSync(taskFile(spoiled, TASK), JSON.stringify(meta, null, 2) + '\n');
  const { responses } = await talk([rpc(1, 'tools/call', { name: 'promptobus_task', arguments: {} })], {
    options: { resolveIdentity: () => ({ role: 'orchestrator', home: spoiled, declaredTask: TASK, session: OWNER }) },
  });
  const said = textOf(responses[0]);
  assert.ok(said.includes('- INVALID PARTICIPANT RECORD'));
  assert.ok(said.includes('- orchestrator · owner'));
});

test('malformed JSON → −32700 in the consumer text, and the connection is alive', async () => {
  const { responses } = await talk(['{ битый json', rpc(1, 'ping', {})]);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[0].error.message, 'not parsed as JSON');
  assert.deepEqual(responses[1].result, {});
});

test('an unknown method → −32601 in the consumer text', async () => {
  const { responses } = await talk([rpc(1, 'resources/list', {})]);
  assert.equal(responses[0].error.code, -32601);
  assert.equal(responses[0].error.message, 'method «resources/list» is not supported');
});

test('an unknown tool is isError with the consumer text, not a protocol error', async () => {
  const { responses } = await talk([rpc(1, 'tools/call', { name: 'nosuch', arguments: {} })]);
  assert.equal(responses[0].error, undefined);
  assert.equal(responses[0].result.isError, true);
  assert.equal(textOf(responses[0]), 'error: unknown tool «nosuch»');
});

test('a tool refusal arrives in the consumer text, the connection is not lost', async () => {
  const { responses } = await talk([
    rpc(1, 'tools/call', {
      name: 'promptobus_send',
      arguments: { to: 'worker:cargos-api', type: 'nope', body: 'x' },
    }),
    rpc(2, 'ping', {}),
  ]);
  assert.equal(responses[0].result.isError, true);
  assert.match(textOf(responses[0]), /^error: type «nope» is not a v1 protocol type/);
  assert.deepEqual(responses[1].result, {});
});

test('reply order is request order, and there is nothing foreign in the stream', async () => {
  const { responses, written } = await talk([
    rpc(1, 'ping', {}),
    rpc(2, 'tools/list', {}),
    rpc(3, 'ping', {}),
    rpc(4, 'tools/call', { name: 'promptobus_task', arguments: {} }),
  ]);
  assert.deepEqual(responses.map((r) => r.id), [1, 2, 3, 4]);
  // The channel is shared with the protocol: each write is exactly one
  // JSON-RPC line and a newline.
  assert.ok(written.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')));
});

test('a task argument is stronger than the session declaration', async () => {
  const other = 't20260814-101010';
  createTask(home, { id: other, title: 'вторая активная задача', owner: OWNER });
  const { responses } = await talk([
    rpc(1, 'tools/call', { name: 'promptobus_task', arguments: { task: other } }),
  ]);
  assert.match(textOf(responses[0]), new RegExp(`^task ${other} · вторая активная задача\n`));
});

// --- the first line names, it does not count ---

// The canon carries the participant-record ID, and the sender address is
// assembled from the task journal. There is no journal here at all, and
// `summarizeMessages` takes whoever it was given: by default — the id.
const g = (type, from) => ({ type, sender: from });

test('the first line names senders and types', () => {
  assert.equal(
    summarizeMessages([g('result', 'worker:gates'), g('status', 'worker:spawn'), g('status', 'worker:spawn')]),
    'messages 3: status from worker:spawn ×2, result from worker:gates',
  );
});

test('a single message does not get a multiplier', () => {
  assert.equal(summarizeMessages([g('result', 'worker:gates')]), 'messages 1: result from worker:gates');
});

test('one address with different types is different groups', () => {
  assert.equal(
    summarizeMessages([g('status', 'worker:a'), g('result', 'worker:a')]),
    'messages 2: status from worker:a, result from worker:a',
  );
});

test('the list is capped, the rest folds into "+ N more" as a message count', () => {
  const many = [
    g('status', 'worker:a'), g('status', 'worker:a'),
    g('result', 'worker:b'), g('question', 'worker:c'), g('review', 'worker:d'), g('review', 'worker:d'),
  ];
  const line = summarizeMessages(many);
  assert.ok(line.startsWith('messages 6: '));
  assert.equal(line.split(', ').length, 3);
  assert.ok(line.endsWith('+ 1 more'));
});

test('long names are cut by the character cap, not by the group count', () => {
  const long = summarizeMessages([
    g('status', `worker:${'a'.repeat(60)}`),
    g('result', `worker:${'b'.repeat(60)}`),
    g('review', 'worker:c'),
  ]);
  assert.ok(long.endsWith('+ 2 more'));
});

test('one group is printed even when it is longer than the cap', () => {
  const huge = summarizeMessages([g('status', `worker:${'x'.repeat(200)}`), g('result', 'worker:b')]);
  assert.ok(huge.includes('x'.repeat(200)));
  assert.ok(huge.endsWith('+ 1 more'));
});

// --- readable participant name ---

const named = (name) => ({
  participants: [{ id: 'worker-gates', metadata: { address: 'worker:gates', ...(name ? { name } : {}) } }],
});

test('the participant name is taken from the journal, without the trailing (MMDD-HHMM) mark', () => {
  assert.equal(readableName(named('Worker: Гейты lint (0829-1208)'), 'worker:gates'), 'Worker: Гейты lint');
});

test('a mark with a slug is stripped by the same form', () => {
  assert.equal(readableName(named('Worker: Гейты lint (0829-1208, gates)'), 'worker:gates'), 'Worker: Гейты lint');
});

test('a parenthesis that does not look like a mark stays in the name', () => {
  assert.equal(readableName(named('Worker: Дома значений (протокол)'), 'worker:gates'), 'Worker: Дома значений (протокол)');
});

test('a record without a name is the address without the role prefix', () => {
  assert.equal(readableName(named(null), 'worker:gates'), 'gates');
});

test('the participant is not in the journal — the same fallback', () => {
  assert.equal(readableName({ participants: [] }, 'worker:gates'), 'gates');
  assert.equal(readableName({}, 'worker:gates'), 'gates');
  assert.equal(readableName(null, 'worker:gates'), 'gates');
});

test('the reviewer prefix is stripped the same as the worker prefix', () => {
  assert.equal(readableName({ participants: [] }, 'reviewer:bus'), 'bus');
});

test('orchestrator is named by the word; the of-flag yields "the orchestrator"', () => {
  assert.equal(readableName(named(null), 'orchestrator'), 'orchestrator');
  assert.equal(readableName(named(null), 'orchestrator', true), 'the orchestrator');
});

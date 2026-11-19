import './home.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const store = await import('../lib/store.js');
const { createMcpServer } = await import('../dist/index.js');
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const ROOT = 'root-t20261110-104000';
const OWN = 'controller-t20261110-104000';
const CHILD = 'child-t20261110-104000';
const OLD = 'original-root-session';
const NEXT = 'actual-successor-session';
const PEER = 'peer:bb-controller';

function fixture(t, { owner = OLD, held = PEER, peerFields = { sessionId: NEXT, peerTask: OWN } } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'promptobus-root-claim-peer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, '.promptobus');
  const engine = store.bus(home, { cli: version });
  store.createTask(home, { id: ROOT, title: 'Original governed run', owner, adapter: { slug: 'original' } });
  const original = store.participantOf(store.readTask(home, ROOT), 'orchestrator');
  store.upsertParticipant(home, ROOT, {
    ...original, harness: 'codex', mode: 'managed', sessionRef: 'synthetic-original-root',
    metadata: { ...original.metadata, sessionId: OLD, nativeLaunchId: 'synthetic-original-launch',
      nativeStop: { launchId: 'synthetic-original-launch', threadId: OLD } },
  });
  store.createTask(home, { id: OWN, title: 'Actual successor endpoint', owner: NEXT, adapter: { slug: 'bb-controller' } });
  store.createTask(home, { id: CHILD, title: 'Preserved lead', owner: 'original-lead-session', parent: ROOT, teamlead: 'teamlead:lead' });
  store.upsertParticipant(home, ROOT, store.participantRecord(held, peerFields));
  store.upsertParticipant(home, CHILD, store.participantRecord(PEER, { sessionId: NEXT, peerTask: OWN }));
  for (const task of [ROOT, CHILD]) {
    store.upsertParticipant(home, task, store.participantRecord('worker:report', { sessionId: 'report-session' }));
    engine.sendSync(task, { from: 'worker-report', to: ['orchestrator'], type: 'status', body: `Original payload for ${task}` });
  }
  const joins = [];
  const connect = ({ session = NEXT, role = 'orchestrator', hint = role, declaredTask = OWN } = {}) => createMcpServer({
    service: {
      ...store.busService,
      resolveTaskId: (home, task, session) => store.resolveTaskId(home, task, session, {
        spawnRepo: 'synthetic spawn', spawnNewTask: 'synthetic new task',
      }),
    },
    protocolVersions: ['2025-03-26'],
    resolveIdentity: () => ({ home, role, hint, declaredTask, session }),
    serverInfo: () => ({ name: 'synthetic-claim-regression', version }),
    onJoin: join => { joins.push(join); },
    decorateParticipant: () => [],
    stalls: () => null,
    errorText: event => event.cause?.message ?? event.kind,
  }).connect();
  const call = (connection, args, name = 'promptobus_mailbox') => connection.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args === undefined ? {} : { task: ROOT, ...args } },
  });
  const text = result => result.result?.content?.map(item => item.text ?? '').join('\n') ?? '';
  const ownerOf = task => store.taskOwner(home, task);
  const unread = task => engine.unread(task, 'orchestrator');
  const unchanged = () => {
    assert.equal(ownerOf(ROOT), owner);
    assert.equal(ownerOf(CHILD), 'original-lead-session');
    assert.equal(unread(ROOT), 1);
    assert.equal(unread(CHILD), 1);
    assert.equal(store.boundTaskId(home, NEXT), null);
  };
  return { home, engine, joins, connect, call, text, ownerOf, unread, unchanged };
}

test('explicit root orchestrator claim reaches root despite the actual session holding its peer record', t => {
  const f = fixture(t);
  assert.equal(store.mailboxAddress(f.home, ROOT, 'orchestrator', NEXT), PEER);
  const before = store.readTask(f.home, ROOT);
  const child = store.readTask(f.home, CHILD);
  const message = f.engine.peek(ROOT, 'orchestrator').messages[0];
  const result = f.call(f.connect(), { claim: true });
  assert.match(f.text(result), /MAILBOX CLAIMED/, 'explicit root claim must not be routed to the held peer mailbox');
  assert.equal(result.result.isError, undefined);
  assert.equal(f.ownerOf(ROOT), NEXT);
  assert.equal(store.boundTaskId(f.home, NEXT), ROOT);
  assert.equal(f.unread(ROOT), 0);
  assert.deepEqual(f.engine.history({ task: ROOT, participant: 'orchestrator', all: true }).entries[0].message, message);
  const after = store.readTask(f.home, ROOT);
  assert.equal(after.owner, before.owner);
  assert.deepEqual(after.participants.filter(p => p.id !== 'orchestrator'), before.participants.filter(p => p.id !== 'orchestrator'));
  const changed = after.participants.find(p => p.id === 'orchestrator');
  assert.deepEqual({ ...changed, metadata: { ...changed.metadata, owner: OLD } }, before.participants.find(p => p.id === 'orchestrator'));
  assert.deepEqual(store.readTask(f.home, CHILD), child);
  assert.equal(f.unread(CHILD), 1);
  assert.deepEqual(f.joins.map(j => [j.address, j.mayRegister]), [['orchestrator', false], ['orchestrator', true]]);
});

test('ordinary root mailbox call still reads the held peer without taking root mail', t => {
  const f = fixture(t);
  const id = store.addrDir(PEER);
  store.upsertParticipant(f.home, OWN, store.participantRecord('peer:original', { peerTask: ROOT, sessionId: OLD }));
  f.engine.sendSync(ROOT, { from: 'orchestrator', to: [id], type: 'status', body: 'Only in the peer inbox' });
  assert.equal(f.engine.unread(ROOT, id), 1);
  const result = f.call(f.connect(), {});
  assert.match(f.text(result), /Only in the peer inbox/);
  assert.doesNotMatch(f.text(result), /MAILBOX CLAIMED|Original payload/);
  assert.equal(f.engine.unread(ROOT, id), 0);
  f.unchanged();
});

test('default orchestrator with no role declaration cannot claim from the peer', t => {
  const f = fixture(t);
  assert.match(f.text(f.call(f.connect({ hint: null }), { claim: true })), /claim is for the orchestrator address/);
  f.unchanged();
});

for (const declaredTask of [OWN, null]) {
  test(`claim reply agrees with taskless follow-up when declared task is ${declaredTask}`, t => {
    const f = fixture(t);
    const connection = f.connect({ declaredTask });
    const reply = f.text(f.call(connection, { claim: true }));
    assert.match(reply, /MAILBOX CLAIMED/);
    assert.equal(store.boundTaskId(f.home, NEXT), ROOT);
    if (declaredTask) {
      assert.ok(reply.includes(`declared task ${OWN} still takes precedence`));
      assert.doesNotMatch(reply, /from now on the task resolves without an argument/);
    } else assert.match(reply, /from now on the task resolves without an argument/);
    assert.ok(f.text(f.call(connection, undefined, 'promptobus_task')).startsWith(`task ${declaredTask ?? ROOT} ·`));
  });
}

for (const role of [PEER, 'worker:report', 'teamlead:lead']) {
  test(`claim declared as ${role} does not acquire root ownership`, t => {
    const f = fixture(t);
    const result = f.call(f.connect({ role }), { claim: true });
    assert.match(f.text(result), /claim is for the orchestrator address/);
    f.unchanged();
  });
}

test('a non-peer held participant is not promoted by declaring an orchestrator claim', t => {
  const f = fixture(t, { held: 'approver:maintenance' });
  assert.match(f.text(f.call(f.connect(), { claim: true })), /claim is for the orchestrator address/);
  f.unchanged();
});

test('a registered peer cannot use the root exception to claim a child task', t => {
  const f = fixture(t);
  assert.match(f.text(f.call(f.connect(), { claim: true, task: CHILD })), /claim is for the orchestrator address/);
  f.unchanged();
});

test('an implicit root selected by the resolver does not promote its peer', t => {
  const f = fixture(t);
  assert.match(f.text(f.call(f.connect({ declaredTask: ROOT }), { claim: true, task: undefined })), /claim is for the orchestrator address/);
  f.unchanged();
});

for (const [label, peerFields] of Object.entries({
  'legacy prefix': { session: NEXT.slice(0, 8), peerTask: OWN },
  'record pointer': { sessionRecord: NEXT, sessionId: OLD, peerTask: OWN },
  'case mismatch': { sessionId: NEXT.toUpperCase(), peerTask: OWN },
  'missing peer link': { sessionId: NEXT },
})) {
  test(`held address with ${label} cannot use the root exception`, t => {
    const f = fixture(t, { peerFields });
    assert.equal(store.mailboxAddress(f.home, ROOT, 'orchestrator', NEXT), PEER);
    assert.match(f.text(f.call(f.connect(), { claim: true })), /claim is for the orchestrator address/);
    f.unchanged();
  });
}

test('a genuine teamlead alias still directs a claim to its child without taking either mailbox', t => {
  const f = fixture(t);
  const result = f.call(f.connect({ role: 'teamlead:lead', session: 'original-lead-session' }), { claim: true });
  assert.match(f.text(result), /address alias of orchestrator of task child-t20261110-104000/);
  f.unchanged();
});

test('root claim still refuses an absent actual session', t => {
  const f = fixture(t);
  assert.match(f.text(f.call(f.connect({ session: null }), { claim: true })), /nothing to claim the mailbox with/);
  f.unchanged();
});

test('root claim still refuses an ownerless task without introducing ownership', t => {
  const f = fixture(t, { owner: null });
  const result = f.call(f.connect(), { claim: true });
  assert.match(f.text(result), /has no owner — there is no gate, and nothing to claim/);
  assert.doesNotMatch(f.text(result), /MAILBOX CLAIMED/);
  f.unchanged();
});

test('claim plus message and undeclared arguments cannot acquire root ownership', t => {
  const f = fixture(t);
  for (const args of [{ claim: true, message: '20261110T104000000-0000-abcdef' }, { claim: true, address: 'orchestrator' }]) {
    const result = f.call(f.connect(), args);
    assert.equal(result.result.isError, true);
    f.unchanged();
  }
});

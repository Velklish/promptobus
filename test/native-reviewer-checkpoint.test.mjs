import './home.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { boundSessionOf, createMcpServer, openEngine } from '../dist/index.js';
import { persistReviewerSession } from '../lib/native-lifecycle.js';
import { bindBeforeLaunch, revokeFailedPointerLaunch } from '../lib/driver-common.js';
import * as store from '../lib/store.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const subject = { head: '1'.repeat(40), base: '2'.repeat(40), diffSha256: '3'.repeat(64) };
const report = '\nFinding alpha → beta\n  preserve spaces\n\n' + 'finding 😀\n'.repeat(450);
function fixture(t, fields = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'promptobus-test-native-reviewer-checkpoint-'));
  store.bus(home, { cli: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const task = store.createTask(home, { id: 't20261024-100000', title: 'checkpoint', owner: 'owner' }).id;
  const address = 'reviewer:orders', diffPath = path.join(store.filesDir(home, task), 'review-orders.diff');
  store.upsertParticipant(home, task, store.participantRecord(address, {
    reviewLaunchId: 'lift-1', sessionId: 'session-r1', diffHead: subject.head, diffBase: subject.base, diffSha256: subject.diffSha256, ...fields,
  }));
  store.sendMessage(home, task, { from: 'orchestrator', to: address, type: 'task', body: 'Review this diff' });
  store.stampSnapshot(home, task, address, { ...subject, diffPath, at: new Date().toISOString(), clean: true, modifiedTracked: [] });
  const participant = () => store.participantOf(store.readTask(home, task), address);
  const engine = () => openEngine({ home, recover: false, policy: () => ({ allow: true }) });
  const artifact = (content = report) => ({ content, subject: {
    ...subject, assignmentAfterId: participant().metadata.assignmentAfterId,
  } });
  const send = (extra = {}) => store.sendMessage(home, task, {
    from: address, to: 'orchestrator', type: 'artifact', body: 'Finding checkpoint', session: 'session-r1',
    artifact: artifact(), ...extra,
  });
  return { home, task, address, diffPath, participant, engine, artifact, send };
}
async function call(f, args, session = 'session-r1', name = 'promptobus_send', identity = {}) {
  const output = [];
  const server = createMcpServer({
    service: { ...store.busService,
      resolveTaskId: (home, declared, session) => store.resolveTaskId(home, declared, session, {
        spawnRepo: 'unused fixture route', spawnNewTask: 'unused fixture route',
      }) }, protocolVersions: ['2025-11-25'],
    resolveIdentity: () => ({ home: f.home, role: f.address, hint: f.address, declaredTask: f.task, session, ...identity }),
    serverInfo: () => ({ name: 'checkpoint-test', version: '1' }),
    onJoin: () => false, decorateParticipant: () => [], stalls: () => null,
    errorText: (event) => event.cause.message,
  });
  await server.serve({
    input: Readable.from([JSON.stringify({ id: 1, method: 'tools/call', params: {
      name, arguments: name === 'promptobus_send' ? { to: 'orchestrator', type: 'artifact',
        body: 'Finding checkpoint', artifact: f.artifact(), ...args } : args,
    } }) + '\n']),
    output: { write: (chunk) => output.push(chunk) },
  });
  return JSON.parse(output.at(-1)).result;
}
function files(root) {
  return readdirSync(root, { recursive: true }).sort().filter((name) =>
    /(?:artifacts|blobs|messages|files)\//.test(name));
}
test('inline reviewer report traverses the actual MCP/store/engine and reopens intact', async (t) => {
  const f = fixture(t);
  const result = await call(f, {});
  assert.ok(!result.isError, result.content[0].text);
  const landed = f.engine().facts(f.task).messages.find((m) => m.type === 'artifact');
  assert.ok(landed?.artifact, 'checkpoint has a canonical artifact link');
  const artifact = f.engine().readArtifact(f.task, landed.artifact);
  assert.notEqual(landed.id, artifact.id, 'message and artifact ids are distinct');
  const envelope = JSON.parse(f.engine().readArtifactContent(f.task, artifact.id));
  assert.equal(envelope.report, report);
  assert.equal(envelope.reportBytes, Buffer.byteLength(report));
  assert.equal(envelope.reportSha256, hash(report));
  assert.equal(envelope.session, 'session-r1');
  assert.equal(envelope.participant, f.participant().id);
  assert.equal(envelope.task, f.task);
  assert.match(result.content[0].text, new RegExp('artifact id ' + artifact.id));
  assert.match(result.content[0].text, new RegExp('id ' + landed.id));
  assert.equal(readFileSync(path.join(store.filesDir(f.home, f.task), artifact.filename), 'utf8'),
    f.engine().readArtifactContent(f.task, artifact.id).toString());
  assert.equal(store.currentResult(f.participant(), f.engine().facts(f.task).messages), null);
});
test('the actual task tool exposes the current authenticated reviewer subject without guessing', async (t) => {
  const f = fixture(t);
  const reply = await call(f, { checkpointDiff: f.diffPath }, 'session-r1', 'promptobus_task');
  assert.ok(!reply.isError, reply.content[0].text);
  const line = reply.content[0].text.split('\n').find((s) => s.startsWith('reviewer checkpoint subject: '));
  assert.deepEqual(JSON.parse(line.slice('reviewer checkpoint subject: '.length)), f.artifact().subject);
  const foreign = await call(f, { checkpointDiff: f.diffPath }, 'foreign', 'promptobus_task');
  assert.ok(!foreign.content[0].text.includes('reviewer checkpoint subject: '));
});
test('task subject selects the same authenticated reviewer seat as the actual send', async (t) => {
  const f = fixture(t), address = 'reviewer:payments';
  const secondPath = path.join(path.dirname(f.diffPath), 'review-payments.diff');
  const secondSubject = { head: '4'.repeat(40), base: '5'.repeat(40), diffSha256: '6'.repeat(64) };
  store.upsertParticipant(f.home, f.task, store.participantRecord(address, {
    sessionId: 'session-r1', diffHead: secondSubject.head, diffBase: secondSubject.base, diffSha256: secondSubject.diffSha256,
  }));
  const assignment = store.sendMessage(f.home, f.task, {
    from: 'orchestrator', to: address, type: 'task', body: 'Review payments',
  });
  store.stampSnapshot(f.home, f.task, address, { ...secondSubject, diffPath: secondPath, at: new Date().toISOString(), clean: true, modifiedTracked: [] });
  const expected = { ...secondSubject, assignmentAfterId: assignment.message.id };
  const caller = { role: address, hint: address };
  const reply = await call(f, { checkpointDiff: secondPath }, 'session-r1', 'promptobus_task', caller);
  assert.ok(!reply.isError, reply.content[0].text);
  const line = reply.content[0].text.split('\n').find((s) => s.startsWith('reviewer checkpoint subject: '));
  const exposed = JSON.parse(line?.slice('reviewer checkpoint subject: '.length) ?? 'null');
  assert.deepEqual(exposed, expected, 'fetch must describe the selected second reviewer, not the first held seat');
  const sent = await call(f, { artifact: { content: report, subject: exposed } }, 'session-r1', 'promptobus_send', caller);
  assert.ok(!sent.isError, sent.content[0].text);
  const second = store.participantOf(store.readTask(f.home, f.task), address);
  const recovered = store.retainedReviewerCheckpoints(f.home, f.task, second);
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0].subject, expected);
  const message = f.engine().facts(f.task).messages.find((m) => m.id === recovered[0].messageId);
  assert.equal(message.sender, second.id);
  const hinted = await call(f, { checkpointDiff: secondPath }, 'session-r1', 'promptobus_task', { role: f.address, hint: address });
  const hintedLine = hinted.content[0].text.split('\n').find((s) => s.startsWith('reviewer checkpoint subject: '));
  assert.deepEqual(JSON.parse(hintedLine?.slice('reviewer checkpoint subject: '.length) ?? 'null'), expected,
    'the authenticated send hint selects the subject even when the mailbox role differs');
  const ambiguous = await call(f, { checkpointDiff: secondPath }, 'session-r1', 'promptobus_task', { role: address, hint: null });
  assert.ok(ambiguous.isError, ambiguous.content[0].text);
  assert.ok(!ambiguous.content[0].text.includes('reviewer checkpoint subject: '), 'ambiguous sender exposes no subject');
});
test('refreshing an opened diff cannot label old work with a newer assignment of identical bytes', async t => {
  const f = fixture(t);
  const lookup = async args => {
    const reply = await call(f, args, 'session-r1', 'promptobus_task');
    assert.ok(!reply.isError, reply.content[0].text);
    return JSON.parse(reply.content[0].text.match(/^reviewer checkpoint subject: (.*)$/m)?.[1] ?? 'null');
  };
  const opened = await lookup({ checkpointDiff: f.diffPath });
  assert.deepEqual(opened, f.artifact().subject);
  const nextPath = f.diffPath + '.next';
  store.sendMessage(f.home, f.task, { from: 'orchestrator', to: f.address, type: 'task', body: nextPath });
  store.stampSnapshot(f.home, f.task, f.address, { ...subject, diffPath: nextPath, at: new Date().toISOString(), clean: true, modifiedTracked: [] });
  assert.equal(await lookup({}), null);
  const stale = await call(f, { checkpointDiff: f.diffPath }, 'session-r1', 'promptobus_task');
  assert.ok(stale.isError);
  assert.match(stale.content[0].text, /opened diff/);
  assert.ok((await call(f, { artifact: { content: report, subject: opened } })).isError);
  assert.deepEqual(await lookup({ checkpointDiff: nextPath }), f.artifact().subject);
});

for (const published of [false, true]) test(`initial lift rollback ${published ? 'after' : 'before'} session publication keeps evidence but no sender`, async t => {
  const f = fixture(t), initial = f.participant(), pointer = path.join(f.home, 'reviewer.session.json');
  const undo = bindBeforeLaunch(f.home, f.task, f.address, { sessionId: 'session-r1', sessionRecord: pointer });
  const first = f.send(), second = f.send({ session: pointer, artifact: f.artifact('Second finding') });
  if (published) persistReviewerSession(f.home, f.task, initial, 'short-r1', false, 'session-r1');
  undo();
  undo();
  const retired = f.participant();
  assert.equal(retired.metadata.assignmentAfterId, initial.metadata.assignmentAfterId);
  assert.equal(boundSessionOf(retired), null);
  assert.deepEqual(store.retainedReviewerCheckpoints(f.home, f.task, retired).map(r => [r.messageId, r.report]),
    [[first.message.id, report], [second.message.id, 'Second finding']]);
  for (const identity of ['session-r1', 'short-r1', pointer]) {
    assert.ok((await call(f, {}, identity)).isError);
    assert.ok((await call(f, { type: 'status', artifact: undefined }, identity)).isError);
  }
});

for (const [harness, sessionId, session] of [
  ['cursor', '61a55703-8cb6-4000-8459-d9b2cd9b54fa', 'cursor-pane-17'],
  ['opencode', 'ses_01_owned', 'ses_01_owned'],
]) {
  function pointerLift(t) {
    const f = fixture(t, { harness, sessionRef: 'orders-review', sessionId: null });
    const reserved = f.participant(), pointer = path.join(f.home, `${harness}.session.json`);
    const undo = bindBeforeLaunch(f.home, f.task, f.address, { sessionRecord: pointer });
    return { f, reserved, pointer, undo };
  }
  test(`${harness}: failed HTTP revocation after persist cannot keep the journal sender or imply native Stop`, async t => {
    const { f, reserved, pointer, undo } = pointerLift(t);
    const primary = new Error('realize refused'), revoke = new Error('HTTP revoke refused');
    writeFileSync(pointer, 'owned native record');
    let stopAttempted = false;
    const launch = { sessionRecord: pointer, service: {
      realize: async () => { throw primary; }, revoke: async () => { throw revoke; },
    } };
    persistReviewerSession(f.home, f.task, reserved, session, false, sessionId);
    f.send({ session: sessionId });
    await assert.rejects(async () => {
      try { await launch.service.realize(sessionId); } catch (error) {
        await revokeFailedPointerLaunch(launch, error, { session, sessionId }, undo, async () => { stopAttempted = true; });
      }
    }, error => error.cause === primary && error.errors[1] === revoke);
    assert.equal(stopAttempted, false);
    assert.equal(readFileSync(pointer, 'utf8'), 'owned native record');
    assert.equal(boundSessionOf(f.participant()), null);
    assert.throws(() => persistReviewerSession(f.home, f.task, reserved, session, false, sessionId));
    assert.equal(store.retainedReviewerCheckpoints(f.home, f.task, f.participant())[0].report, report);
  });
  for (const phase of ['pointer only', 'ID published', 'persist returned']) test(`${harness}: rollback at ${phase} retires only historical checkpoint proof`, async t => {
    const { f, reserved, pointer, undo } = pointerLift(t);
    const first = f.send({ session: pointer });
    const expected = [[first.message.id, report]];
    if (phase !== 'pointer only') {
      const current = f.participant();
      store.upsertParticipant(f.home, f.task, { ...current, metadata: { ...current.metadata, sessionId } });
      const second = f.send({ session: sessionId, artifact: f.artifact('Finding after native ID publication') });
      expected.push([second.message.id, 'Finding after native ID publication']);
    }
    if (phase === 'persist returned') persistReviewerSession(f.home, f.task, reserved, session, false, sessionId);
    const owned = { sessionId: phase === 'pointer only' ? null : sessionId,
      session: phase === 'pointer only' || (phase === 'ID published' && harness === 'cursor') ? null : session };
    undo(owned, 'check');
    assert.equal(store.senderFor(f.home, f.task, { session: pointer }), f.address);
    undo(owned);
    assert.equal(boundSessionOf(f.participant()), null);
    assert.throws(() => persistReviewerSession(f.home, f.task, reserved, session, false, sessionId));
    for (const identity of new Set([pointer, sessionId, session])) {
      assert.throws(() => store.senderFor(f.home, f.task, { session: identity }));
      assert.ok((await call(f, {}, identity)).isError);
    }
    assert.deepEqual(store.retainedReviewerCheckpoints(f.home, f.task, f.participant()).map(r => [r.messageId, r.report]), expected);
  });
  for (const change of ['assignment', 'launch', 'pointer', 'full ID', 'alias']) test(`${harness}: stale rollback preserves a changed ${change}`, t => {
    const { f, reserved, pointer, undo } = pointerLift(t), owned = { sessionId, session };
    persistReviewerSession(f.home, f.task, reserved, session, false, sessionId);
    undo(owned, 'check');
    if (change === 'assignment') {
      store.sendMessage(f.home, f.task, { from: 'orchestrator', to: f.address, type: 'task', body: 'Next review' });
    } else {
      const patch = { launch: { reviewLaunchId: 'successor' }, pointer: { sessionRecord: `${pointer}.next` },
        'full ID': { sessionId: 'foreign-native-id' }, alias: { session: 'foreign-session' } }[change];
      const current = f.participant();
      store.upsertParticipant(f.home, f.task, { ...current, metadata: { ...current.metadata, ...patch } });
    }
    const successor = f.participant();
    assert.throws(() => undo(owned, 'check'), /changed before binding rollback/);
    assert.throws(() => undo(owned), /changed before binding rollback/);
    assert.deepEqual(f.participant(), successor);
    assert.equal(store.senderFor(f.home, f.task, { session: successor.metadata.sessionId }), f.address);
  });
}

test('late lift completion merges the session into the re-review that already checkpointed', t => {
  const f = fixture(t), initial = f.participant();
  const undo = bindBeforeLaunch(f.home, f.task, f.address, { sessionId: 'session-r1', session: 'newly-confirmed' });
  const assignment = store.sendMessage(f.home, f.task, { from: 'orchestrator', to: f.address, type: 'task', body: 'Review again' });
  const next = { ...subject, diffSha256: hash('new diff') };
  store.stampSnapshot(f.home, f.task, f.address, { ...next, diffPath: f.diffPath + '.next', at: new Date().toISOString(), clean: true, modifiedTracked: [] });
  const sent = f.send({ artifact: { content: report, subject: { ...next, assignmentAfterId: assignment.message.id } } });
  persistReviewerSession(f.home, f.task, initial, 'newly-confirmed', false, 'session-r1');
  const current = f.participant();
  assert.equal(current.metadata.session, 'newly-confirmed');
  assert.equal(current.metadata.assignmentAfterId, assignment.message.id);
  assert.equal(current.metadata.diffSha256, next.diffSha256);
  assert.equal(current.metadata.diffPath, f.diffPath + '.next');
  assert.equal(store.retainedReviewerCheckpoints(f.home, f.task, current)[0].messageId, sent.message.id);
  assert.throws(() => persistReviewerSession(f.home, f.task, initial, null, true, null));
  undo();
  assert.equal(boundSessionOf(f.participant()), null);
  assert.throws(() => f.send(), /session/);
  assert.equal(store.retainedReviewerCheckpoints(f.home, f.task, f.participant())[0].messageId, sent.message.id);
  store.upsertParticipant(f.home, f.task, { ...current, metadata: { ...current.metadata, reviewLaunchId: 'replacement' } });
  assert.throws(() => persistReviewerSession(f.home, f.task, initial, 'obsolete', false, 'session-r1'));
  assert.equal(f.participant().metadata.session, 'newly-confirmed');
});
test('inline checkpoint rejects identity, scope, shape and byte overflow before payload writes', async (t) => {
  for (const [name, override] of [
    ['session', { session: 'foreign' }], ['recipient', { to: 'reviewer:orders' }],
    ['type', { type: 'status' }], ['empty', { artifact: { content: '', subject: {} } }],
    ['nested field', { artifact: { content: report, subject: {}, producer: 'owner' } }],
    ['subject', { artifact: { content: report, subject: { ...subject, assignmentAfterId: 'stale' } } }],
    ['UTF-8 overflow', { artifact: { content: '😀'.repeat(250001), subject: {} } }],
    ['null', { artifact: null }], ['array', { artifact: [] }],
  ]) {
    await t.test(name, () => {
      const f = fixture(t), before = files(f.home);
      const input = name === 'UTF-8 overflow' || name === 'nested field' ? { artifact: { ...f.artifact(), ...override.artifact, subject: f.artifact().subject } } : override;
      assert.throws(() => f.send(input));
      assert.deepEqual(files(f.home), before, 'refused report left no payload or canonical message');
    });
  }
  const f = fixture(t);
  const disk = path.join(f.home, 'private.txt'); writeFileSync(disk, 'must not be exported');
  for (const override of [{ artifactPath: disk }, { artifactPath: '' }, { artifactPath: null },
    { artifact: undefined, artifactPath: disk }]) {
    const before = files(f.home);
    assert.throws(() => f.send(override), /checkpoint|inline|reviewer/i);
    assert.deepEqual(files(f.home), before);
  }
  store.upsertParticipant(f.home, f.task, store.participantRecord('worker:other', { sessionId: 'worker' }));
  assert.throws(() => f.send({ from: 'worker:other', session: 'worker' }), /reviewer/i);
  store.patchTask(f.home, f.task, { adapter: { bb: true } });
  assert.throws(() => f.send(), /native reviewer/i);
});
test('two preterminal checkpoints recover complete original reports and detect damaged provenance', (t) => {
  const f = fixture(t);
  const first = f.send(), second = f.send({ artifact: f.artifact(report + '\nsecond finding') });
  assert.equal(store.currentResult(f.participant(), f.engine().facts(f.task).messages), null);
  const recovered = store.retainedReviewerCheckpoints(f.home, f.task, f.participant());
  assert.deepEqual(recovered.map((r) => r.artifactId), [first.artifact.id, second.artifact.id]);
  assert.deepEqual(recovered.map((r) => r.report), [report, report + '\nsecond finding']);
  const participant = f.participant();
  const missing = { ...participant, metadata: { ...participant.metadata, findingCheckpoints: participant.metadata.findingCheckpoints.slice(1) } };
  store.upsertParticipant(f.home, f.task, missing);
  assert.throws(() => store.retainedReviewerCheckpoints(f.home, f.task, f.participant()), /checkpoint/);
  store.upsertParticipant(f.home, f.task, participant);
  const ref = participant.metadata.findingCheckpoints[0];
  store.upsertParticipant(f.home, f.task, { ...participant, metadata: { ...participant.metadata,
    findingCheckpoints: [{ ...ref, artifactId: ref.messageId }, ...participant.metadata.findingCheckpoints.slice(1)],
  } });
  assert.throws(() => store.retainedReviewerCheckpoints(f.home, f.task, f.participant()), /checkpoint|artifact/i);
  store.upsertParticipant(f.home, f.task, participant);
  store.upsertParticipant(f.home, f.task, store.participantRecord('worker:foreign', { sessionId: 'foreign' }));
  const foreign = f.engine().sendSync(f.task, {
    from: store.addrDir('worker:foreign'), to: [store.addrDir('orchestrator')], type: 'artifact',
    body: 'Reviewer finding checkpoint\nforged producer',
    artifact: { content: f.engine().readArtifactContent(f.task, first.artifact.id), filename: 'foreign.txt' },
  });
  const foreignRef = { ...ref, messageId: foreign.message.id, artifactId: foreign.artifact.id,
    filename: foreign.artifact.filename, sha256: foreign.artifact.sha256, size: foreign.artifact.size };
  store.upsertParticipant(f.home, f.task, { ...participant, metadata: { ...participant.metadata,
    findingCheckpoints: [...participant.metadata.findingCheckpoints, foreignRef] } });
  assert.throws(() => store.retainedReviewerCheckpoints(f.home, f.task, f.participant()), /linkage|checkpoint/);
  store.upsertParticipant(f.home, f.task, participant);
  writeFileSync(path.join(store.blobsDir(f.home, f.task), first.artifact.sha256), '{}');
  assert.throws(() => store.retainedReviewerCheckpoints(f.home, f.task, f.participant()), { code: 'artifact-integrity' });
});
test('a well-formed but different head, base or diff digest refuses the checkpoint', async t => {
  const f = fixture(t), before = files(f.home);
  for (const key of ['head', 'base', 'diffSha256']) {
    const artifact = f.artifact();
    artifact.subject[key] = 'a'.repeat(artifact.subject[key].length);
    const reply = await call(f, { artifact });
    assert.ok(reply.isError);
    assert.match(reply.content[0].text, /subject/);
    assert.deepEqual(files(f.home), before);
  }
});
test('byte-backed sync artifacts retain engine naming, policy-before-write and immutable reads', (t) => {
  const f = fixture(t), bytes = Buffer.from('original 😀');
  const sent = f.engine().sendSync(f.task, { from: store.addrDir(f.address), to: ['orchestrator'],
    type: 'artifact', body: 'engine bytes', artifact: { content: bytes, filename: 'bytes.txt' } });
  bytes.fill(0);
  assert.equal(f.engine().readArtifactContent(f.task, sent.artifact.id).toString(), 'original 😀');
  const before = files(f.home);
  const denied = openEngine({ home: f.home, recover: false, policy: () => ({ deny: true, reason: 'fixture refusal' }) });
  assert.throws(() => denied.sendSync(f.task, { from: store.addrDir(f.address), to: ['orchestrator'],
    type: 'artifact', body: 'denied', artifact: { content: Buffer.from('denied'), filename: 'safe.txt' } }), /fixture refusal/);
  assert.deepEqual(files(f.home), before);
  assert.throws(() => f.engine().sendSync(f.task, { from: store.addrDir(f.address), to: ['orchestrator'],
    type: 'artifact', body: 'bad name', artifact: { content: Buffer.from('bad'), filename: '../bad.txt' } }), /file name/);
  assert.deepEqual(files(f.home), before);
});
test('reassignment and task close cannot admit a stale checkpoint', (t) => {
  const f = fixture(t), old = f.artifact();
  store.sendMessage(f.home, f.task, { from: 'orchestrator', to: f.address, type: 'task', body: 'New assignment' });
  assert.throws(() => f.send({ artifact: old }), /subject|assignment|checkpoint/i);
  assert.throws(() => f.send(), /subject/, 'a new assignment cannot borrow the previous snapshot');
  store.stampSnapshot(f.home, f.task, f.address, { ...subject, at: new Date().toISOString(), clean: true, modifiedTracked: [] });
  assert.throws(() => f.send({ artifact: old }), /subject/, 'identical diff bytes cannot revive an old assignment');
  f.engine().closeTask(f.task);
  const before = files(f.home);
  assert.throws(() => f.send(), /active|closed|done/i);
  assert.deepEqual(files(f.home), before);
});
test('a checkpoint waiting for the real task lock rechecks the reassigned producer before writes', { timeout: 10000 }, async (t) => {
  const f = fixture(t), before = files(f.home);
  const module = new URL('../lib/store.js', import.meta.url).href;
  const start = path.join(f.home, 'start'), release = path.join(f.home, 'release');
  const common = `import * as s from ${JSON.stringify(module)};import fs from 'node:fs';
    const home=${JSON.stringify(f.home)}, task=${JSON.stringify(f.task)}, address=${JSON.stringify(f.address)};
    const wait=(p)=>{const end=Date.now()+7000;while(!fs.existsSync(p)){
      if(Date.now()>end)throw Error('fixture barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}};`;
  const child = (code) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', common + code], {
      env: { HOME: f.home, TMPDIR: f.home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', error = '';
    const waiting = new Map();
    process.stdout.on('data', (chunk) => {
      output += chunk;
      for (const [tag, resolve] of waiting) if (output.includes(tag)) { waiting.delete(tag); resolve(); }
    });
    process.stderr.on('data', (chunk) => { error += chunk; });
    const done = new Promise((resolve) => process.once('close', (code) => resolve({ code, output, error })));
    t.after(() => { if (process.exitCode === null) process.kill(); });
    return { done, tag: (tag) => output.includes(tag) ? Promise.resolve() : new Promise((resolve) => waiting.set(tag, resolve)) };
  };
  const sender = child(`s.bus(home,{cli:${JSON.stringify(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version)}});console.log('BOOT');
    wait(${JSON.stringify(start)});
    const original=fs.mkdirSync;let signalled=false;
    fs.mkdirSync=(p,...args)=>{if(!signalled&&String(p).endsWith('/.lock')){signalled=true;console.log('LOCK_ATTEMPT');}return original(p,...args);};
    (await import('node:module')).syncBuiltinESMExports();
    try{s.sendMessage(home,task,{from:address,to:'orchestrator',type:'artifact',body:'checkpoint',
      session:'session-r1',artifact:${JSON.stringify(f.artifact())}});console.log('ACCEPTED');process.exitCode=1;}
    catch(error){if(!/reviewer checkpoint/.test(error.message))throw error;console.log('REFUSED');}`);
  await sender.tag('BOOT');
  const owner = child(`s.withTaskLock(home,task,()=>{console.log('LOCKED');wait(${JSON.stringify(release)});
    s.sendMessage(home,task,{from:'orchestrator',to:address,type:'task',body:'Reassigned'});
    const p=s.participantOf(s.readTask(home,task),address);
    s.upsertParticipant(home,task,{...p,metadata:{...p.metadata,sessionId:'session-r2'}});});`);
  await owner.tag('LOCKED');
  writeFileSync(start, '');
  await sender.tag('LOCK_ATTEMPT');
  assert.deepEqual(files(f.home), before, 'the waiting sender wrote payload before acquiring the task lock');
  writeFileSync(release, '');
  const [sent, changed] = await Promise.all([sender.done, owner.done]);
  assert.equal(changed.code, 0, changed.error);
  assert.equal(sent.code, 0, sent.error + sent.output);
  assert.match(sent.output, /REFUSED/);
  assert.equal(f.engine().facts(f.task).messages.filter((m) => m.type === 'artifact').length, 0);
});

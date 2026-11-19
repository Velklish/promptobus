import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { boardSchema } from '../contract.js';
import { boardSteps, placed, readBoard, readPieceHistory } from '../board.js';
import { showsPiece } from '../dashboard.js';
import { fixture, treeDigest } from './fixture.js';

const AFTER = '20261119T000000000-0000-000000';
const FIXTURE_TIME = '2026-12-01T00:00:00.000Z';
const owner = { id: 'owner', role: 'orchestrator', harness: 'codex', mode: 'attached' as const,
  sessionRef: null, capabilities: null, metadata: { address: 'orchestrator' } };
type Fixture = ReturnType<typeof fixture>;
function secondRun(f: Fixture, id: string, addresses: string[]) {
  f.engine.createTask({ id, title: `Run ${id}`, owner });
  for (const address of addresses) f.engine.addParticipant(id, { ...owner, id: address.replace(':', '-'), role: address.split(':')[0],
    harness: 'bb', mode: 'managed', sessionRef: 'thr_board1', metadata: { address, assignmentAfterId: AFTER } });
}
function roots(f: Fixture) { return { storeRoot: f.selection.storeRoot, nativeRoot: f.selection.nativeRoot }; }
function record(f: Fixture, task: string, index: number, area: 'inbox' | 'history', sender: string, body: string, type = 'status', recipient = 'owner') {
  const id = `20261201T000000000-${String(index).padStart(4, '0')}-000000`;
  const directory = path.join(f.selection.storeRoot, 'tasks', task, area, recipient);
  const file = path.join(directory, `${id}.json`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, JSON.stringify({ protocolVersion: 1, id, task, sender, recipients: [recipient], type, body, ts: FIXTURE_TIME }));
  return file;
}

test('shipped steps come first and a declared step follows them in address order', () => {
  const at = (address: string) => ({ metadata: { address } }) as never;
  assert.deepEqual(boardSteps({ participants: [at('orchestrator'), at('teamlead:x'), at('security:x'), at('worker:x'), at('docs:y')] }),
    ['worker', 'reviewer', 'approver', 'security', 'docs']);
});

test('board places pieces of several runs at their steps with holder, signals and BB thread without changing the store', () => {
  const f = fixture('board-run-a');
  try {
    f.engine.sendSync('board-run-a', { from: 'actor-2', to: ['owner'], type: 'status', body: 'gamma builds the parser\nSECRET-STATUS-TAIL' });
    f.engine.sendSync('board-run-a', { from: 'actor-2', to: ['owner'], type: 'question', body: 'Which parser?' });
    writeFileSync(path.join(f.selection.storeRoot, 'tasks', 'board-run-a', 'stalls.json'), JSON.stringify({ 'worker:gamma': { reason: 'waiting for the lock', at: null } }));
    secondRun(f, 'board-run-b', ['worker:delta', 'security:delta']);
    f.engine.sendSync('board-run-b', { from: 'worker-delta', to: ['owner'], type: 'result', body: 'delta is ready' });
    secondRun(f, 'board-run-c', []);
    f.engine.closeTask('board-run-c');
    const before = treeDigest(f.root);
    const board = boardSchema.parse(readBoard(roots(f), 'observer', 1));
    assert.equal(treeDigest(f.root), before);
    assert.deepEqual(board.runs.map(run => [run.id, run.state]).sort(), [['board-run-a', 'active'], ['board-run-b', 'active'], ['board-run-c', 'done']]);
    const a = board.runs.find(run => run.id === 'board-run-a')!, b = board.runs.find(run => run.id === 'board-run-b')!;
    assert.deepEqual(a.steps, ['worker', 'reviewer', 'approver']);
    assert.deepEqual(Object.fromEntries(a.pieces.map(piece => [piece.slug, piece.step])), { alpha: 'worker', gamma: 'worker', beta: 'reviewer' });
    const alpha = a.pieces.find(piece => piece.slug === 'alpha')!, gamma = a.pieces.find(piece => piece.slug === 'gamma')!;
    assert.equal(alpha.holder?.unread, 1);
    assert.equal(gamma.holder?.status?.line, 'gamma builds the parser');
    assert.equal(gamma.holder?.stall, 'waiting for the lock');
    assert.match(gamma.holder?.question ?? '', /^\d{8}T/);
    assert.equal(gamma.holder?.bbThreadId, null); assert.equal(gamma.holder?.sessionRef, 'native-2');
    assert.deepEqual(b.steps, ['worker', 'reviewer', 'approver', 'security']); assert.equal(b.inferred, true); assert.equal(a.inferred, false);
    assert.deepEqual(b.pieces.map(piece => [piece.slug, piece.step, piece.holder]), [['delta', 'reviewer', null]]);
    assert.deepEqual(board.runs.find(run => run.id === 'board-run-c')!.pieces, []);
    assert.doesNotMatch(JSON.stringify(board), /SECRET-OWNER|SECRET-RECORD|SECRET-PARTICIPANT|SECRET-STATUS-TAIL|SECRET-READ-BODY|token/);
    const history = readPieceHistory({ ...roots(f), taskId: 'board-run-a', slug: 'gamma' });
    assert.deepEqual(history.messages.map(message => message.type), ['status', 'question']);
    assert.throws(() => readPieceHistory({ ...roots(f), taskId: 'board-run-a', slug: 'missing' }), /not in this run/);
  } finally { f.cleanup(); }
});

test('a BB participant exposes its thread and done pieces keep their last holder', () => {
  const f = fixture('board-bb');
  try {
    secondRun(f, 'board-bb-done', ['worker:omega', 'reviewer:omega', 'approver:omega']);
    for (const sender of ['worker-omega', 'reviewer-omega', 'approver-omega'])
      f.engine.sendSync('board-bb-done', { from: sender, to: ['owner'], type: 'result', body: `${sender} done` });
    const run = readBoard(roots(f), 'observer', 1).runs.find(value => value.id === 'board-bb-done')!;
    assert.deepEqual(run.pieces.map(piece => [piece.slug, piece.step, piece.holder?.participantId, piece.holder?.bbThreadId]),
      [['omega', null, 'approver-omega', 'thr_board1']]);
  } finally { f.cleanup(); }
});

test('a question stays open until each addressee answers the asker with a later message', () => {
  const f = fixture('board-answer');
  try {
    const question = () => readBoard(roots(f), 'observer', 1).runs[0].pieces.find(piece => piece.slug === 'gamma')!.holder?.question;
    f.engine.sendSync('board-answer', { from: 'actor-2', to: ['owner', 'actor-1'], type: 'question', body: 'Which parser?' });
    f.engine.sendSync('board-answer', { from: 'actor-0', to: ['actor-2'], type: 'answer', body: 'Not an addressee' });
    assert.match(question() ?? '', /^\d{8}T/);
    f.engine.sendSync('board-answer', { from: 'owner', to: ['actor-2'], type: 'answer', body: 'The streaming one' });
    assert.match(question() ?? '', /^\d{8}T/);
    f.engine.sendSync('board-answer', { from: 'actor-1', to: ['actor-2'], type: 'answer', body: 'Agreed' });
    assert.equal(question(), null);
  } finally { f.cleanup(); }
});

test('BB adapter participants without an address are placed by worker and by the predecessors an approver names', () => {
  const f = fixture('board-adapter');
  try {
    f.engine.createTask({ id: 'board-adapter-run', title: 'Adapter run', owner });
    const bb = (id: string, role: string, extra: Record<string, unknown> = {}) => f.engine.addParticipant('board-adapter-run', { ...owner, id, role,
      harness: 'bb', mode: 'managed', sessionRef: `thr_${id.replace(/[^a-z0-9]/g, '')}`, metadata: { assignmentAfterId: AFTER, bb: { token: 'SECRET-TOKEN', ...extra } } });
    bb('worker-api', 'worker'); bb('worker-ui', 'worker', { execution: { model: 'gpt-ui' } });
    bb('reviewer-1', 'reviewer', { reviewEvidence: { producer: 'worker-api' } }); bb('reviewer-2', 'reviewer', { reviewEvidence: { producer: 'owner' } });
    f.engine.sendSync('board-adapter-run', { from: 'worker-api', to: ['owner'], type: 'result', body: 'api ready' });
    const early = readBoard(roots(f), 'observer', 1).runs.find(value => value.id === 'board-adapter-run')!;
    assert.deepEqual(early.pieces.map(piece => [piece.slug, piece.step, piece.holder?.participantId, piece.holder?.model]), [
      ['worker-ui', 'worker', 'worker-ui', 'gpt-ui'], ['reviewer-2', 'reviewer', 'reviewer-2', null], ['worker-api', 'reviewer', 'reviewer-1', null]]);
    assert.deepEqual(readPieceHistory({ ...roots(f), taskId: 'board-adapter-run', slug: 'worker-api' }).messages.map(message => message.body), ['api ready']);
    f.engine.sendSync('board-adapter-run', { from: 'reviewer-1', to: ['owner'], type: 'result', body: 'api approved' });
    bb('approver-1', 'approver', { predecessors: { worker: 'worker-api', reviewer: 'reviewer-1' } });
    bb('reviewer-3', 'reviewer', { reviewEvidence: { producer: 'worker-api' } });
    const run = readBoard(roots(f), 'observer', 1).runs.find(value => value.id === 'board-adapter-run')!;
    assert.deepEqual(run.pieces.map(piece => [piece.slug, piece.step, piece.holder?.participantId, piece.holder?.bbThreadId]), [
      ['worker-ui', 'worker', 'worker-ui', 'thr_workerui'],
      ['reviewer-2', 'reviewer', 'reviewer-2', 'thr_reviewer2'],
      ['reviewer-3', 'reviewer', 'reviewer-3', 'thr_reviewer3'],
      ['worker-api', 'approver', 'approver-1', 'thr_approver1']]);
    assert.equal(run.inferred, false);
    assert.doesNotMatch(JSON.stringify(run), /SECRET-TOKEN/);
    assert.deepEqual(readPieceHistory({ ...roots(f), taskId: 'board-adapter-run', slug: 'worker-api' }).messages.map(message => message.body),
      ['api ready', 'api approved']);
    const native = { ...owner, id: 'native', role: 'worker', harness: 'codex' };
    assert.deepEqual(placed([native]), [native]);
  } finally { f.cleanup(); }
});

test('two BB reviewers of one worker and no approver to choose each keep their own card and history', () => {
  const f = fixture('board-reviewers');
  try {
    f.engine.createTask({ id: 'board-reviewers-run', title: 'Reviewers run', owner });
    const bb = (id: string, role: string, extra: Record<string, unknown> = {}) => f.engine.addParticipant('board-reviewers-run', { ...owner, id, role,
      harness: 'bb', mode: 'managed', sessionRef: `thr_${id.replace(/[^a-z0-9]/g, '')}`, metadata: { assignmentAfterId: AFTER, bb: { ...extra } } });
    bb('worker-api', 'worker'); bb('reviewer-1', 'reviewer', { reviewEvidence: { producer: 'worker-api' } });
    bb('reviewer-2', 'reviewer', { reviewEvidence: { producer: 'worker-api' } });
    f.engine.sendSync('board-reviewers-run', { from: 'worker-api', to: ['owner'], type: 'result', body: 'api ready' });
    f.engine.sendSync('board-reviewers-run', { from: 'reviewer-1', to: ['owner'], type: 'result', body: 'first review' });
    const run = readBoard(roots(f), 'observer', 1).runs.find(value => value.id === 'board-reviewers-run')!;
    assert.deepEqual(run.pieces.map(piece => [piece.slug, piece.step, piece.holder?.participantId ?? null]).sort(), [
      ['reviewer-1', 'approver', null], ['reviewer-2', 'reviewer', 'reviewer-2'], ['worker-api', 'reviewer', null]]);
    assert.deepEqual(readPieceHistory({ ...roots(f), taskId: 'board-reviewers-run', slug: 'reviewer-1' }).messages.map(message => message.body), ['first review']);
  } finally { f.cleanup(); }
});

test('two BB approvers of one worker each keep their own card, thread and history', () => {
  const f = fixture('board-approvers');
  try {
    f.engine.createTask({ id: 'board-approvers-run', title: 'Approvers run', owner });
    const bb = (id: string, role: string, extra: Record<string, unknown> = {}, sessionRef: string | null = `thr_${id.replace(/[^a-z0-9]/g, '')}`) =>
      f.engine.addParticipant('board-approvers-run', { ...owner, id, role, harness: 'bb', mode: 'managed', sessionRef, metadata: { assignmentAfterId: AFTER, bb: { ...extra } } });
    bb('worker-api', 'worker'); bb('reviewer-1', 'reviewer', { reviewEvidence: { producer: 'worker-api' } });
    f.engine.sendSync('board-approvers-run', { from: 'worker-api', to: ['owner'], type: 'result', body: 'api ready' });
    f.engine.sendSync('board-approvers-run', { from: 'reviewer-1', to: ['owner'], type: 'result', body: 'api reviewed' });
    bb('approver-1', 'approver', { predecessors: { worker: 'worker-api', reviewer: 'reviewer-1' } });
    f.engine.sendSync('board-approvers-run', { from: 'approver-1', to: ['owner'], type: 'status', body: 'first approval attempt' });
    bb('approver-2', 'approver', { predecessors: { worker: 'worker-api', reviewer: 'reviewer-1' } }, null);
    const run = readBoard(roots(f), 'observer', 1).runs.find(value => value.id === 'board-approvers-run')!;
    assert.deepEqual(run.pieces.map(piece => [piece.slug, piece.step, piece.holder?.participantId ?? null, piece.holder?.bbThreadId ?? null]).sort(), [
      ['approver-1', 'approver', 'approver-1', 'thr_approver1'], ['approver-2', 'approver', 'approver-2', null], ['worker-api', 'approver', null, null]]);
    assert.deepEqual(readPieceHistory({ ...roots(f), taskId: 'board-approvers-run', slug: 'approver-1' }).messages.map(message => message.body), ['first approval attempt']);
    assert.deepEqual(readPieceHistory({ ...roots(f), taskId: 'board-approvers-run', slug: 'worker-api' }).messages.map(message => message.body).sort(), ['api ready', 'api reviewed']);
  } finally { f.cleanup(); }
});

test('a BB reviewer approvers name for two workers keeps its own card whatever the order the approvers were recorded in', () => {
  const placedIn = (name: string, order: string[]) => {
    const f = fixture(name);
    try {
      f.engine.createTask({ id: `${name}-run`, title: 'Shared reviewer run', owner });
      const bb = (id: string, role: string, extra: Record<string, unknown> = {}) =>
        f.engine.addParticipant(`${name}-run`, { ...owner, id, role, harness: 'bb', mode: 'managed', sessionRef: `thr_${id.replace(/[^a-z0-9]/g, '')}`, metadata: { assignmentAfterId: AFTER, bb: { ...extra } } });
      bb('worker-a', 'worker'); bb('worker-b', 'worker'); bb('reviewer-1', 'reviewer', { reviewEvidence: { producer: 'worker-a' } });
      f.engine.sendSync(`${name}-run`, { from: 'worker-a', to: ['owner'], type: 'result', body: 'a ready' });
      f.engine.sendSync(`${name}-run`, { from: 'worker-b', to: ['owner'], type: 'result', body: 'b ready' });
      f.engine.sendSync(`${name}-run`, { from: 'reviewer-1', to: ['owner'], type: 'result', body: 'reviewed' });
      for (const id of order) bb(id, 'approver', { predecessors: { worker: id === 'approver-a' ? 'worker-a' : 'worker-b', reviewer: 'reviewer-1' } });
      const run = readBoard(roots(f), 'observer', 1).runs.find(value => value.id === `${name}-run`)!;
      return { pieces: run.pieces.map(piece => [piece.slug, piece.step, piece.holder?.participantId ?? null]).sort(),
        histories: ['worker-a', 'worker-b', 'reviewer-1'].map(slug => readPieceHistory({ ...roots(f), taskId: `${name}-run`, slug }).messages.map(message => message.body).sort()) };
    } finally { f.cleanup(); }
  };
  const forward = placedIn('board-shared-ab', ['approver-a', 'approver-b']);
  assert.deepEqual(placedIn('board-shared-ba', ['approver-b', 'approver-a']), forward);
  assert.deepEqual(forward.pieces, [['reviewer-1', 'approver', null], ['worker-a', 'reviewer', null], ['worker-b', 'reviewer', null]]);
  assert.deepEqual(forward.histories, [['a ready'], ['b ready'], ['reviewed']]);
});

test('board samples the 16 most recently updated active runs and lists the rest as not sampled', () => {
  const f = fixture('board-bounded');
  try {
    for (let index = 0; index < 17; index++) secondRun(f, `board-extra-${String(index).padStart(2, '0')}`, ['worker:x']);
    f.engine.addParticipant('board-extra-00', { ...owner, id: 'worker-y', role: 'worker', metadata: { address: 'worker:y' } });
    const board = readBoard(roots(f), 'observer', 1);
    assert.equal(board.runs.length, 18);
    const skipped = board.runs.filter(run => run.error?.startsWith('Not sampled')).map(run => run.id);
    const sampled = board.runs.filter(run => !run.error);
    assert.equal(skipped.length, 2); assert.equal(sampled.length, 16);
    assert.ok(!skipped.includes('board-extra-00'));
    assert.ok(sampled.every(run => skipped.every(id => run.updated >= board.runs.find(value => value.id === id)!.updated)));
    assert.ok(sampled.every(run => run.pieces.length > 0));
  } finally { f.cleanup(); }
});

test('board isolates a run whose history leaves the owned store and keeps its sibling run', () => {
  const f = fixture('board-symlink');
  try {
    secondRun(f, 'board-sibling', ['worker:x']);
    const entry = f.engine.history({ task: 'board-symlink', limit: 1, strict: true }).entries[0];
    const file = path.join(f.selection.storeRoot, 'tasks', 'board-symlink', 'history', entry.participant, entry.message.id + '.json');
    const foreign = path.join(f.root, 'outside-selected-store.json');
    writeFileSync(foreign, readFileSync(file, 'utf8')); rmSync(file); symlinkSync(foreign, file);
    const board = readBoard(roots(f), 'observer', 1);
    assert.match(board.runs.find(run => run.id === 'board-symlink')!.error ?? '', /Selected canonical history/);
    const sibling = board.runs.find(run => run.id === 'board-sibling')!;
    assert.equal(sibling.error, null); assert.deepEqual(sibling.pieces.map(piece => piece.slug), ['x']);
    assert.throws(() => readPieceHistory({ ...roots(f), taskId: 'board-symlink', slug: 'alpha' }), /Selected canonical history/);
  } finally { f.cleanup(); }
});

test('board and piece history use the newest references across both mailboxes past 4096', () => {
  const f = fixture('board-long');
  try {
    secondRun(f, 'board-long-run', ['worker:alpha', 'worker:beta']);
    const taskId = 'board-long-run';
    const newest = record(f, taskId, 4100, 'history', 'worker-alpha', 'Newest result', 'result');
    for (let index = 0; index < 4100; index++) {
      record(f, taskId, index, 'inbox', index < 6 ? 'worker-alpha' : 'owner', `Status ${index}`, 'status', 'worker-beta');
    }
    const duplicateBox = path.join(path.dirname(newest), '..', '..', 'inbox', 'owner');
    mkdirSync(duplicateBox, { recursive: true });
    linkSync(newest, path.join(duplicateBox, path.basename(newest)));
    const run = readBoard(roots(f), 'observer', 1).runs.find(value => value.id === taskId)!;
    assert.equal(run.error, null);
    assert.match(run.notice ?? '', /Older messages were not read/);
    assert.equal(run.pieces.find(piece => piece.slug === 'alpha')?.step, 'reviewer');
    assert.equal(run.pieces.find(piece => piece.slug === 'beta')?.holder?.unread, 4100);
    const alpha = readPieceHistory({ ...roots(f), taskId, slug: 'alpha' });
    assert.match(alpha.notice ?? '', /Older messages were not read/);
    assert.deepEqual(alpha.messages.map(message => message.body), ['Newest result']);
    const beta = readPieceHistory({ ...roots(f), taskId, slug: 'beta' });
    assert.deepEqual(beta.messages.map(message => message.body), Array.from({ length: 64 }, (_, index) => `Status ${4036 + index}`));
  } finally { f.cleanup(); }
});

test('the byte budget is shared across runs, and running out keeps the other lanes visible', () => {
  const f = fixture('board-byte-fixture');
  try {
    const fat = 'x'.repeat(240 * 1024);
    for (const [taskId, day] of [['board-bytes-first', '03'], ['board-bytes-second', '02'], ['board-bytes-third', '01']]) {
      secondRun(f, taskId, ['worker:x']);
      const file = path.join(f.selection.storeRoot, 'tasks', taskId, 'task.json');
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), updated: `2099-01-${day}T00:00:00.000Z` }));
      for (let index = 0; index < 20; index++) {
        record(f, taskId, index, 'history', 'worker-x', `${index} ${fat}`, index === 0 && day !== '03' ? 'result' : 'status');
      }
    }
    const [first, second, third] = readBoard(roots(f), 'observer', 1).runs;
    assert.equal(first.id, 'board-bytes-first'); assert.equal(first.notice, undefined);
    assert.equal(second.id, 'board-bytes-second'); assert.match(second.notice ?? '', /byte budget/);
    assert.equal(third.id, 'board-bytes-third'); assert.match(third.notice ?? '', /byte budget/);
    assert.ok([first, second, third].every(run => run.error === null && run.pieces[0]?.step === 'worker'));
    assert.match(second.pieces[0].holder?.status?.line ?? '', /^19 /);
    assert.equal(third.pieces[0].holder?.status, null);
    const history = readPieceHistory({ ...roots(f), taskId: third.id, slug: 'x' });
    assert.equal(history.messages.length, 20);
    assert.equal(history.notice, undefined);
  } finally { f.cleanup(); }
});

test('a refused inbox link marks both endpoints without advancing on a partial fan-out, then recovery clears it', t => {
  if (process.getuid?.() === 0 || process.platform === 'win32') return t.skip('requires POSIX directory permissions enforced for this user');
  const f = fixture('board-pending-fixture');
  const taskId = 'board-pending-run';
  const box = path.join(f.selection.storeRoot, 'tasks', taskId, 'inbox', 'owner');
  try {
    secondRun(f, taskId, ['worker:x', 'reviewer:y', 'worker:z']);
    mkdirSync(box, { recursive: true });
    chmodSync(box, 0o500);
    try {
      assert.throws(() => f.engine.sendSync(taskId, { from: 'worker-x', to: ['reviewer-y', 'owner'], type: 'result', body: 'PRIVATE-PENDING-BODY' }), { code: 'link-refused' });
    } finally { chmodSync(box, 0o700); }
    const run = () => readBoard(roots(f), 'observer', 1).runs.find(value => value.id === taskId)!;
    const history = () => readPieceHistory({ ...roots(f), taskId, slug: 'x' });
    const before = treeDigest(f.root), pending = run();
    assert.equal(pending.error, null);
    assert.deepEqual(pending.pieces.map(piece => [piece.slug, piece.step, !!piece.unfinishedDelivery]),
      [['x', 'worker', true], ['z', 'worker', false], ['y', 'reviewer', true]]);
    assert.equal(pending.pieces.find(piece => piece.slug === 'y')?.holder?.unread, 1);
    assert.doesNotMatch(JSON.stringify(pending), /PRIVATE-PENDING-BODY/);
    assert.deepEqual(history().messages, []);
    assert.equal(treeDigest(f.root), before);
    const recovered = f.engine.recover(taskId);
    assert.equal(recovered.failed.length, 0); assert.equal(recovered.repairs.length, 1);
    const complete = run();
    assert.equal(complete.pieces.find(piece => piece.slug === 'x')?.step, 'reviewer');
    assert.ok(complete.pieces.every(piece => !piece.unfinishedDelivery));
    assert.deepEqual(history().messages.map(message => message.body), ['PRIVATE-PENDING-BODY']);
  } finally { f.cleanup(); }
});

test('an intents directory outside the owned store refuses the lane, even with no messages', () => {
  const f = fixture('board-foreign-intents-fixture');
  try {
    const taskId = 'board-foreign-intents';
    secondRun(f, taskId, ['worker:x']);
    const directory = path.join(f.selection.storeRoot, 'tasks', taskId, 'intents');
    const foreign = path.join(f.root, 'foreign-intents');
    if (existsSync(directory)) rmSync(directory, { recursive: true });
    mkdirSync(foreign); symlinkSync(foreign, directory, 'dir');
    const board = readBoard(roots(f), 'observer', 1);
    assert.match(board.runs.find(run => run.id === taskId)?.error ?? '', /Selected canonical intents/);
    assert.equal(board.runs.find(run => run.id === f.selection.taskId)?.error, null);
    assert.throws(() => readPieceHistory({ ...roots(f), taskId, slug: 'x' }), /Selected canonical intents/);
  } finally { f.cleanup(); }
});

test('a visible but incomplete intent preserves cards and the open history without using its ID as a result', () => {
  const f = fixture('board-torn-intent-fixture');
  try {
    const taskId = 'board-torn-intent-run';
    secondRun(f, taskId, ['worker:x', 'worker:y']);
    record(f, taskId, 1, 'history', 'worker-x', 'Confirmed status');
    const source = { ...roots(f), hostId: 'host_fixture' }, opened = { taskId, slug: 'x', source };
    const sample = () => ({ ...readBoard(roots(f), 'observer', 1), source });
    assert.equal(showsPiece(sample(), opened), true);

    const reference = record(f, taskId, 2, 'inbox', 'worker-x', 'Unconfirmed result', 'result');
    const intents = path.join(f.selection.storeRoot, 'tasks', taskId, 'intents');
    mkdirSync(intents, { recursive: true });
    writeFileSync(path.join(intents, path.basename(reference)), '{"protocolVersion":');

    const before = treeDigest(f.root), board = sample();
    const lane = board.runs.find(run => run.id === taskId)!;
    assert.equal(lane.error, null);
    assert.match(lane.notice ?? '', /Sample incomplete: some delivery intents could not be parsed/);
    assert.deepEqual(lane.pieces.map(piece => [piece.slug, piece.step]), [['x', 'worker'], ['y', 'worker']]);
    assert.equal(showsPiece(board, opened), true);
    const history = readPieceHistory({ ...roots(f), taskId, slug: opened.slug });
    assert.match(history.notice ?? '', /Sample incomplete: some delivery intents could not be parsed/);
    assert.deepEqual(history.messages.map(message => message.body), ['Confirmed status']);
    assert.equal(treeDigest(f.root), before);
  } finally { f.cleanup(); }
});

test('an incomplete intent is tolerated only inside the owned file and size boundary', () => {
  const f = fixture('board-unowned-intent-fixture');
  try {
    const taskId = f.selection.taskId;
    const intent = path.join(f.selection.storeRoot, 'tasks', taskId, 'intents', '20261201T000000000-0000-000000.json');
    const foreign = path.join(f.root, 'foreign-intent.json');
    writeFileSync(foreign, '{');
    const refuses = () => {
      assert.match(readBoard(roots(f), 'observer', 1).runs[0].error ?? '', /Selected canonical intents/);
      assert.throws(() => readPieceHistory({ ...roots(f), taskId, slug: 'alpha' }), /Selected canonical intents/);
    };
    symlinkSync(foreign, intent);
    refuses();
    rmSync(intent);
    writeFileSync(intent, '{'.repeat(256 * 1024 + 1));
    refuses();
  } finally { f.cleanup(); }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Board } from '../contract.js';
import { columnsOf, displayTime, historyMessages, messageLabel, pieceSignals, relativeAge, samePiece, sameSource, sampleStale, showsPiece, threadNote } from '../dashboard.js';

test('missing and invalid timestamps are explicit rather than rendered as current', () => {
  assert.equal(displayTime(null), 'Unknown');
  assert.equal(displayTime('not-a-date'), 'Unknown');
  assert.notEqual(displayTime('2026-10-26T12:30:00.000Z'), 'Unknown');
});

test('reviewer results retain their role without claiming owner acceptance', () => {
  assert.equal(messageLabel({ type: 'result', sender: 'reviewer-id' }, [{ participantId: 'reviewer-id', role: 'reviewer' }]), 'Reviewer result · recorded');
  assert.equal(messageLabel({ type: 'result', sender: 'worker-id' }, [{ participantId: 'worker-id', role: 'worker' }]), 'result');
});

test('an old or invalid sample is stale until a new successful sample arrives', () => {
  const now = Date.parse('2026-10-26T12:30:20.000Z');
  assert.equal(sampleStale('2026-10-26T12:30:09.000Z', now), true);
  assert.equal(sampleStale('invalid', now), true);
  assert.equal(sampleStale('2026-10-26T12:30:20.000Z', now), false);
});

test('history filters keep canonical type boundaries and message order', () => {
  const messages = ['task', 'status', 'question', 'answer', 'result', 'review', 'decision'].map((type, index) => ({ id: String(index), type }));
  assert.deepEqual(historyMessages(messages, 'work').map(value => value.type), ['task', 'result', 'review']);
  assert.deepEqual(historyMessages(messages, 'status').map(value => value.type), ['status']);
  assert.deepEqual(historyMessages(messages, 'questions').map(value => value.type), ['question', 'answer']);
  assert.deepEqual(historyMessages(messages, 'all'), messages);
});

test('ages are coarse, never negative, and unknown for an invalid time', () => {
  const now = Date.parse('2026-11-19T12:00:00.000Z');
  assert.equal(relativeAge('2026-11-19T11:59:15.000Z', now), '45s ago');
  assert.equal(relativeAge('2026-11-19T11:15:00.000Z', now), '45m ago');
  assert.equal(relativeAge('2026-11-19T07:00:00.000Z', now), '5h ago');
  assert.equal(relativeAge('2026-11-16T12:00:00.000Z', now), '3d ago');
  assert.equal(relativeAge('2026-11-19T12:00:05.000Z', now), '0s ago');
  assert.equal(relativeAge(null, now), 'age unknown');
});

type Holder = NonNullable<Board['runs'][number]['pieces'][number]['holder']>;
const holder: Holder = { participantId: 'worker-a', address: 'worker:a', role: 'worker', harness: 'bb', model: null, sessionRef: null,
  bbThreadId: null, status: null, unread: 0, stall: null, question: null };
const piece = (slug: string, step: string | null, fields: Partial<Holder> | null = {}) =>
  ({ slug, step, holder: fields && { ...holder, ...fields }, participants: [] });

test('every step and Done is a column, empty ones included, and a piece sits only in its own', () => {
  const columns = columnsOf({ steps: ['worker', 'reviewer', 'approver', 'security'],
    pieces: [piece('a', 'worker'), piece('b', 'security'), piece('c', null), piece('d', 'worker')] });
  assert.deepEqual(columns.map(column => [column.label, column.pieces.map(value => value.slug)]),
    [['worker', ['a', 'd']], ['reviewer', []], ['approver', []], ['security', ['b']], ['Done', ['c']]]);
});

test('signals name a stall, an open question and unread mail, and a missing participant', () => {
  assert.deepEqual(pieceSignals(piece('a', 'worker', { stall: 'lock', question: 'q1', unread: 2 })).map(signal => signal.label),
    ['Stalled', 'Asked a question', '2 unread']);
  assert.deepEqual(pieceSignals(piece('a', 'worker')), []);
  assert.deepEqual(pieceSignals(piece('a', 'reviewer', null)), [{ label: 'No reviewer yet', tone: 'unknown' }]);
  assert.deepEqual(pieceSignals(piece('a', null, null)), []);
});

test('unfinished delivery is a warning even when the current step has no holder', () => {
  const warning = { label: 'Unfinished delivery', tone: 'warning' };
  assert.deepEqual(pieceSignals({ ...piece('a', 'worker'), unfinishedDelivery: true }), [warning]);
  assert.deepEqual(pieceSignals({ ...piece('a', 'reviewer', null), unfinishedDelivery: true }),
    [warning, { label: 'No reviewer yet', tone: 'unknown' }]);
});

test('a sample matches another only from the same host, store and native root', () => {
  const source = { hostId: 'host_a', storeRoot: '/store', nativeRoot: '/native' };
  assert.equal(sameSource(source, { ...source }), true);
  for (const other of [{ hostId: 'host_b' }, { storeRoot: '/other' }, { nativeRoot: '/other' }]) assert.equal(sameSource(source, { ...source, ...other }), false);
  assert.equal(sameSource(source, null), false); assert.equal(sameSource(undefined, source), false);
});

test('a history or read error belongs only to the piece of the run and source it was read for', () => {
  const piece = { taskId: 'run', slug: 'alpha', source: { hostId: 'host_a', storeRoot: '/store', nativeRoot: '/native' } };
  assert.equal(samePiece(piece, { ...piece }), true);
  for (const other of [{ taskId: 'other' }, { slug: 'beta' }, { source: { ...piece.source, storeRoot: '/other' } }]) assert.equal(samePiece(piece, { ...piece, ...other }), false);
  assert.equal(samePiece(piece, null), false); assert.equal(samePiece(undefined, piece), false);
});

test('an opened piece stays open only while a board from its source still shows it', () => {
  const source = { hostId: 'host_a', storeRoot: '/store', nativeRoot: '/native' }, piece = { taskId: 'run', slug: 'alpha', source };
  const board = (runs: { id: string; pieces: { slug: string }[] }[], from = source) => ({ source: from, runs: runs as unknown as Board['runs'] });
  assert.equal(showsPiece(board([{ id: 'run', pieces: [{ slug: 'alpha' }] }]), piece), true);
  assert.equal(showsPiece(board([{ id: 'run', pieces: [{ slug: 'beta' }] }]), piece), false);
  assert.equal(showsPiece(board([{ id: 'other', pieces: [{ slug: 'alpha' }] }]), piece), false);
  assert.equal(showsPiece(board([]), piece), false);
  assert.equal(showsPiece(board([{ id: 'run', pieces: [{ slug: 'alpha' }] }], { ...source, hostId: 'host_b' }), piece), false);
});

test('a holder without a thread is told apart: a BB participant whose thread is not recorded, or one outside BB', () => {
  assert.equal(threadNote({ harness: 'bb', bbThreadId: 'thr_abc' }), null);
  assert.match(threadNote({ harness: 'bb', bbThreadId: null })!, /no BB thread recorded yet/);
  assert.match(threadNote({ harness: 'codex', bbThreadId: null })!, /runs outside BB/);
});

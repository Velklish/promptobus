import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAILBOX_COPY } from '../dist/index.js';
import { foreignNote } from '../dist/mcp/render.js';
import { cursorToolTrace, reviewDelivery } from './harness-cursor.mjs';

const reviewId = '20261120T000000000-0000-aaaaaa';
const foreignId = '20261120T000000000-0001-bbbbbb';
const resultId = '20261120T000002000-0000-cccccc';
const expected = { reviewId, resultId };
const turnTime = '2026-11-20T00:00:00.000Z';
const deliveredAt = '2026-11-20T00:00:01.000Z';
const mailboxAt = '2026-11-20T00:00:01.500Z';
const replyTime = '2026-11-20T00:00:02.000Z';
const response = text => ({ isError: false, content: [{ type: 'text', text }] });
const mailbox = (id, { type = 'review', prefix = '' } = {}) => ({
  at: mailboxAt,
  ...cursorToolTrace('promptobus_mailbox', {}, response(
    `${prefix}messages 1: ${type} from orchestrator · PROMPTOBUS_HOME=/${'long/'.repeat(90)} · address=worker:e2e\n\n`
    + `### ${type} from the orchestrator · address orchestrator · ${turnTime}\n`
    + `message ${id} · 40 characters: E2E-ORDER-1: close the review note\n`,
  )),
});
const delivery = { kind: 'untilDelivered', deliveredAt, timeout: null, review: {
  knockedFirst: reviewId, takenIds: [reviewId], previousDeliveryAt: null, drainedAt: deliveredAt, readStartedAt: turnTime,
} };
const sent = id => ({
  at: replyTime,
  ...cursorToolTrace('promptobus_send', {}, response(`sent result → orchestrator · address orchestrator · id ${id} · task=fixture`)),
});

test('Cursor delivery trace binds review and reply IDs beyond the diagnostic preview', () => {
  const took = mailbox(reviewId);
  assert.equal(took.text.length, 400);
  assert.equal(took.text.includes('E2E-ORDER-1'), false);
  assert.deepEqual(reviewDelivery([took, delivery, sent(resultId)], expected),
    { ...expected, readStartedAt: turnTime, mailbox: mailboxAt, deliveredAt, reply: replyTime });
});

test('Cursor delivery trace rejects a foreign review ID carrying the same marker', () => {
  const took = mailbox(foreignId);
  assert.deepEqual(took.takenReviewIds, [foreignId]);
  assert.equal(reviewDelivery([took, delivery, sent(resultId)], expected), null);
});

test('Cursor delivery trace rejects a marker on a status or a real foreign mailbox copy', () => {
  assert.equal(reviewDelivery([mailbox(reviewId, { type: 'status' }), delivery, sent(resultId)], expected), null);
  const note = foreignNote('fixture-t20261120-000000', { owner: 'owned', session: 'foreign' });
  assert.match(note, /this one is foreign\. A copy is below;/);
  const copied = mailbox(reviewId, { prefix: `${note}\n\n` });
  assert.equal(reviewDelivery([copied, delivery, sent(resultId)], expected), null);
  assert.equal(reviewDelivery([mailbox(reviewId, { prefix: `${MAILBOX_COPY}\n\n` }), delivery, sent(resultId)], expected), null);
});

test('Cursor delivery trace rejects another message wake with the correct review and reply', () => {
  const foreignWake = { ...delivery, review: { ...delivery.review, knockedFirst: foreignId } };
  assert.equal(reviewDelivery([mailbox(reviewId), foreignWake, sent(resultId)], expected), null);
  const foreignTake = { ...delivery, review: { ...delivery.review, takenIds: [reviewId, foreignId] } };
  assert.equal(reviewDelivery([mailbox(reviewId), foreignTake, sent(resultId)], expected), null);
});

test('Cursor delivery trace rejects a stale mark before the read started', () => {
  const staleAt = '2026-11-19T23:59:59.000Z';
  const stale = { ...delivery, deliveredAt: staleAt, review: { ...delivery.review, drainedAt: staleAt } };
  assert.equal(reviewDelivery([mailbox(reviewId), stale, sent(resultId)], expected), null);
});

test('Cursor delivery trace requires the matching reply after delivery within the same turn', () => {
  const took = mailbox(reviewId);
  const reply = sent(resultId);
  assert.equal(reviewDelivery([took, delivery, sent(foreignId)], expected), null);
  assert.equal(reviewDelivery([took, reply, delivery], expected), null);
  assert.equal(reviewDelivery([took, delivery, { kind: 'turn-end' }, reply], expected), null);
  assert.equal(reviewDelivery([took, mailbox(foreignId), delivery, reply], expected), null);
});

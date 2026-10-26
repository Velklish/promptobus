import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actorActivity, displayTime, messageLabel, sampleStale, visibleMessages } from '../dashboard.js';

test('questions and outcomes retain canonical type boundaries and message order', () => {
  const messages = [{ id: '1', type: 'status' }, { id: '2', type: 'question' },
    { id: '3', type: 'result' }, { id: '4', type: 'review' }, { id: '5', type: 'decision' }];
  assert.deepEqual(visibleMessages(messages, 'questions').map(value => value.id), ['2']);
  assert.deepEqual(visibleMessages(messages, 'results').map(value => value.id), ['3', '4']);
  assert.deepEqual(visibleMessages(messages, 'all'), messages);
  assert.equal(messages.length, 5);
});

test('idle registry data and absent records never turn into completed or dead actors', () => {
  assert.deepEqual(actorActivity({ busy: true, state: 'alive' }), { label: 'Working · recorded', tone: 'active' });
  assert.deepEqual(actorActivity({ busy: false, state: 'alive' }), { label: 'Idle · recorded', tone: 'neutral' });
  assert.deepEqual(actorActivity({ busy: null, state: 'native record unavailable' }), { label: 'Native state unavailable', tone: 'unknown' });
  assert.deepEqual(actorActivity({ busy: null, state: 'native launch binding unavailable' }), { label: 'Native state unavailable', tone: 'unknown' });
  assert.deepEqual(actorActivity({ busy: null, state: 'stopped' }), { label: 'Activity unknown', tone: 'unknown' });
});

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

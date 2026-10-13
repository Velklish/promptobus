import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeSandbox } from './sandbox.mjs';
import { capture } from './console.mjs';
import { stallRouteOf } from '../lib/drivers.js';
import { viewOf } from '../lib/driver-opencode.js';
import { hostOf } from '../lib/host.js';
import { blockedParticipants, stallLine, status } from '../lib/status.js';
import { reportStalls } from '../lib/warden.js';
import * as store from '../lib/store.js';

const root = makeSandbox('promptobus-driver-opencode-');
const host = hostOf(root);
const home = host.promptobusHome();
const task = 'stall-t20261013-100000';
const address = 'worker:audit';
const id = 'ses_audit';
store.createTask(home, { id: task, title: 'OpenCode stall recovery', owner: 'owner-stall' });
store.upsertParticipant(home, task, store.participantRecord(address, {
  harness: 'opencode', name: 'opencode-audit', session: id, sessionId: id,
}));
const participants = store.readTask(home, task).participants;
const stalled = { harness: 'opencode', kind: 'unknown', address, id, reason: 'the turn ended' };

test('OpenCode dispatcher returns holder inspection instructions for an unknown stall', () => {
  const route = stallRouteOf(stalled, task);
  assert.match(route, /session record/);
  assert.match(route, /holder log/);
  assert.match(route, /idle/);
  assert.doesNotMatch(route, /undefined|tmux|app-server|opencode --session/);
});

test('OpenCode gone inspector view reaches the status stall line with relift instructions', () => {
  const sessions = { [address]: viewOf({ sessionId: id }, []) };
  const blocked = blockedParticipants(home, task, participants, sessions);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].kind, 'gone');
  const line = stallLine(blocked[0], task, host);
  assert.match(line, /worker:audit GONE/);
  assert.match(line, /--harness opencode/);
  assert.match(line, /Work delivered/);
});

test('OpenCode stale dispatcher instructs a relift rather than waking a dead holder', () => {
  const route = stallRouteOf({ ...stalled, kind: 'stale' }, task);
  assert.match(route, /nobody to wake/);
  assert.match(route, /--harness opencode/);
});

test('OpenCode status renders a stalled session and its recovery instructions', () => {
  const sessions = { [address]: { state: 'alive', busy: false, id,
    stall: { kind: 'unknown', reason: 'the turn ended' } } };
  const output = capture(() => status(host, { task, sessions }));
  assert.match(output, /worker:audit/);
  assert.match(output, /STALLED: the turn ended/);
  assert.match(output, /holder log/);
});

test('OpenCode warden reports a gone session once and completes the next reporting round', async () => {
  const sessions = { [address]: viewOf({ sessionId: id }, []) };
  const first = await reportStalls(home, task, { sessions, host });
  assert.equal(first.length, 1);
  assert.match(first[0], /worker:audit GONE/);
  assert.match(first[0], /--harness opencode/);
  assert.deepEqual(await reportStalls(home, task, { sessions, host }), []);
});

test('OpenCode contact point taken by another session is reported through status and warden', async () => {
  store.writeWake(home, task, address, { socket: 'foreign-record', token: null, session: 'ses_foreign' });
  const sessions = { [address]: { state: 'alive', busy: false, id, stall: null } };
  const blocked = blockedParticipants(home, task, participants, sessions);
  assert.equal(blocked[0].kind, 'wake-taken');
  const line = stallLine(blocked[0], task, host);
  assert.match(line, /DEAF/);
  assert.match(line, /contact point/);
  const lines = await reportStalls(home, task, { sessions, host });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /DEAF/);
  assert.match(lines[0], /next bus call/);
});

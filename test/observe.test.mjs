import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeStalls } from '../dist/index.js';
import { intentFile, messageFile, taskFile } from '../dist/v1/layout.js';
import { commitIntent, completeFanout, newMessage } from '../dist/v1/messages.js';
import { runPromptobus } from '../lib/cli.js';
import { hostOf } from '../lib/host.js';
import { observe } from '../lib/observe.js';
import * as store from '../lib/store.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = 'observe-root-t20261120-120000';
const child = 'observe-child-t20261120-120000';
const other = 'observe-other-t20261120-120000';
const a = 'worker:alpha';
const b = 'worker:beta';
const at = '2026-11-20T12:00:00.000Z';
const bin = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));

function fixture() {
  const cwd = makeSandbox('promptobus-observe-');
  writeHostConfig(cwd);
  const host = hostOf(cwd);
  const home = host.promptobusHome();
  const bus = store.bus(home, { cli: host.version });
  store.createTask(home, { id: root, title: 'Root', owner: 'managed-thread' });
  store.createTask(home, { id: child, title: 'Child', owner: 'child-thread', parent: root, teamlead: 'teamlead:child' });
  store.createTask(home, { id: other, title: 'Other', owner: 'other-thread' });
  store.upsertParticipant(home, root, store.participantRecord('user'));
  for (const [task, address] of [[root, a], [root, 'reviewer:alpha'], [child, b], [other, b]]) {
    bus.assignParticipant(task, store.participantRecord(address));
  }
  const send = async (task, from, type, body) => (await bus.send(task,
    { from: store.addrDir(from), to: ['orchestrator'], type, body })).message.id;
  return { cwd, home, host, bus, send };
}

test('CLI follows one tree in commit order, pages without duplicates, and preserves the owner and unread refs', async () => {
  const { home, host, bus, send } = fixture();
  const bootstrap = await observe(host, { task: root });
  assert.equal(bootstrap.status, 'idle');
  const ids = [await send(root, a, 'status', 'Alpha is working')];
  const unrelated = await send(other, b, 'status', 'Unrelated run');
  ids.push(await send(child, b, 'status', 'Beta is working'));
  ids.push(await send(root, a, 'question', 'May we drop the legacy mode?'));
  const decision = await bus.send(root, { from: 'orchestrator', to: ['user'], type: 'status',
    body: 'Decision needed: drop legacy mode or keep it for one release?' });
  ids.push(decision.message.id);
  ids.push(await send(root, a, 'result', 'Worker reports a commit'));
  ids.push(await send(root, 'reviewer:alpha', 'result', 'Reviewer reports a pass'));
  for (let i = 0; i < 7; i++) ids.push(await send(child, b, 'status', `Update ${i}`));
  writeStalls(home, child, { [b]: { at, reason: 'holder failed' } });
  const before = [root, child].map((task) => ({
    journal: readFileSync(taskFile(home, task), 'utf8'),
    unread: readdirSync(store.inboxDir(home, task, 'orchestrator')).sort(),
  }));
  assert.equal(JSON.parse(before[0].journal).participants.find((p) => p.id === 'orchestrator').metadata.owner, 'managed-thread');
  let output = '';
  const exit = await runPromptobus(['observe', '--task', root, '--after', bootstrap.nextCursor], {
    host, output: { write: (chunk) => { output += chunk; } },
  });
  assert.equal(exit, 0);
  const first = JSON.parse(output);
  assert.equal(first.more, true);
  assert.equal(first.messages.length, 10);
  assert.deepEqual(first.changes, []);
  assert.deepEqual(first.messages.slice(0, 6).map(({ from, type }) => [from, type]), [
    [a, 'status'], [b, 'status'], [a, 'question'], ['orchestrator', 'status'], [a, 'result'], ['reviewer:alpha', 'result'],
  ]);
  const second = await observe(host, { task: root, after: first.nextCursor });
  assert.equal(second.more, false);
  const seen = [...first.messages, ...second.messages];
  assert.deepEqual(seen.map(({ id }) => id), ids);
  assert.ok(!seen.some(({ id }) => id === unrelated));
  assert.ok(seen.every(({ id, task, at, to }) => [root, child].includes(task) && Date.parse(at)
    && to[0] === (id === decision.message.id ? 'user' : 'orchestrator')));
  assert.deepEqual(second.changes, [{ kind: 'stall', task: child, address: b, at, reason: 'holder failed' }]);
  const idle = await observe(host, { task: root, after: second.nextCursor });
  assert.equal(idle.status, 'idle');
  assert.deepEqual(idle.messages, []);
  assert.deepEqual(idle.changes, []);
  assert.equal(idle.nextCursor, second.nextCursor);
  for (const [i, task] of [root, child].entries()) {
    assert.equal(readFileSync(taskFile(home, task), 'utf8'), before[i].journal);
    assert.deepEqual(readdirSync(store.inboxDir(home, task, 'orchestrator')).sort(), before[i].unread);
  }
  writeStalls(home, child, {});
  const cleared = await observe(host, { task: root, after: idle.nextCursor });
  assert.deepEqual(cleared.changes, [{ kind: 'stall-cleared', task: child, address: b, at: null }]);
  await assert.rejects(observe(host, { task: other, after: cleared.nextCursor }), /cursor belongs to a different store or root/);
});

test('bounded waiting returns a new message or explicitly times out idle', async () => {
  const { host, send } = fixture();
  const first = await observe(host, { task: root });
  const pending = observe(host, { task: root, after: first.nextCursor, wait: '2' });
  const id = await send(root, a, 'status', 'during wait');
  const arrived = await pending;
  assert.deepEqual(arrived.messages.map((m) => m.id), [id]);
  const empty = await observe(host, { task: root, after: arrived.nextCursor, wait: '1' });
  assert.equal(empty.status, 'idle');
  assert.equal(empty.nextCursor, arrived.nextCursor);
});

test('incomplete selected mail fails without recovery, unrelated intents do not block, and retry keeps order', async () => {
  const { cwd, home, host, send } = fixture();
  const first = await observe(host, { task: root });
  const draft = (task) => newMessage(task, store.addrDir(b), ['orchestrator'], 'status', 'draft', null, new Date(at));
  const unrelated = commitIntent(home, other, draft(other), new Date(at));
  const early = commitIntent(home, child, draft(child), new Date(at));
  const late = await send(root, a, 'status', 'later commit');
  const command = () => spawnSync(process.execPath, [bin, 'observe', '--task', root, '--after', first.nextCursor],
    { cwd, encoding: 'utf8' });
  const refused = command();
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /feed unavailable; keep the previous cursor/);
  assert.ok(readFileSync(intentFile(home, child, early.id), 'utf8'));
  completeFanout(home, child, early);
  const retried = command();
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(JSON.parse(retried.stdout).messages.map((m) => m.id), [early.id, late]);
  assert.ok(readFileSync(intentFile(home, other, unrelated.id), 'utf8'));
  writeFileSync(messageFile(home, root, late), 'invalid');
  await assert.rejects(observe(host, { task: root, after: first.nextCursor }), /task .* canonical mail/);
});

test('Desktop instructions distinguish the read-only active turn from unmeasured idle wake', () => {
  const reference = readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../skills/orchestrate/SKILL.md', import.meta.url), 'utf8');
  assert.match(reference, /observe --task <root> \[--after <cursor>\] \[--wait <seconds>\]/);
  assert.match(guide, /`nextCursor`/);
  assert.match(guide, /does not wake an idle Desktop conversation/);
});

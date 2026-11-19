import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { stallsFile, writeStalls } from '../dist/index.js';
import { ownedReader } from '../dist/fs/owned-reader.js';
import { brokenMessagesDir, intentFile, intentsDir, messageFile, messagesDir, taskFile } from '../dist/v1/layout.js';
import { messageOrderFile, strictCommittedMessages, withMessageCommit } from '../dist/v1/message-order.js';
import { commitIntent, completeFanout, newMessage } from '../dist/v1/messages.js';
import { runPromptobus } from '../lib/cli.js';
import { hostOf } from '../lib/host.js';
import { actorIdentityVariables } from '../lib/drivers.js';
import { observe } from '../lib/observe.js';
import * as store from '../lib/store.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = 'observe-root-t20261120-120000';
const child = 'observe-child-t20261120-120000';
const other = 'observe-other-t20261120-120000';
const sibling = 'observe-sibling-t20261120-120000';
const a = 'worker:alpha';
const b = 'worker:beta';
const at = '2026-11-20T12:00:00.000Z';
const bin = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const ownerEnv = { CLAUDE_CODE_SESSION_ID: 'managed-thread', PROMPTOBUS_TASK: root };
const childEnv = { CLAUDE_CODE_SESSION_ID: 'child-thread', PROMPTOBUS_TASK: child };
const inherited = new Set([...actorIdentityVariables(), 'PROMPTOBUS_TASK', 'PROMPTOBUS_ROLE', 'PROMPTOBUS_HOME', 'PROMPTOBUS_ROOT_TASK']);
const cli = (cwd, args, env) => spawnSync(process.execPath, [bin, 'observe', ...args], { cwd, encoding: 'utf8',
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !inherited.has(name))), ...env } });

function fixture() {
  const cwd = makeSandbox('promptobus-test-observe-');
  writeHostConfig(cwd);
  const host = hostOf(cwd);
  const home = host.promptobusHome();
  const bus = store.bus(home, { cli: host.version });
  store.createTask(home, { id: root, title: 'Root', owner: 'managed-thread' });
  store.createTask(home, { id: child, title: 'Child', owner: 'child-thread', parent: root, teamlead: 'teamlead:child' });
  store.createTask(home, { id: sibling, title: 'Sibling', owner: 'sibling-thread', parent: root, teamlead: 'teamlead:sibling' });
  store.createTask(home, { id: other, title: 'Other', owner: 'other-thread' });
  store.upsertParticipant(home, root, store.participantRecord('user'));
  for (const [task, address] of [[root, a], [root, b], [root, 'reviewer:alpha'], [root, 'approver:alpha'], [child, b], [sibling, b], [other, b]]) {
    bus.assignParticipant(task, store.participantRecord(address));
  }
  const send = async (task, from, type, body) => (await bus.send(task,
    { from: store.addrDir(from), to: ['orchestrator'], type, body })).message.id;
  return { cwd, home, host, bus, send };
}

test('CLI follows one owner mailbox in commit order, pages without duplicates, and preserves the owner and unread refs', async () => {
  const { home, host, bus, send } = fixture();
  const bootstrap = await observe(host, { task: root }, ownerEnv);
  assert.equal(bootstrap.status, 'idle');
  const ids = [await send(root, a, 'status', 'Alpha is working')];
  const unrelated = await send(other, b, 'status', 'Unrelated run');
  const childMail = await send(child, b, 'status', 'Child body');
  ids.push(await send(root, b, 'status', 'Beta is working'));
  ids.push(await send(root, a, 'question', 'May we drop the legacy mode?'));
  const decision = await bus.send(root, { from: 'orchestrator', to: ['user'], type: 'status',
    body: 'Decision needed: drop legacy mode or keep it for one release?' });
  ids.push(decision.message.id);
  ids.push(await send(root, a, 'result', 'Worker reports a commit'));
  ids.push(await send(root, 'reviewer:alpha', 'result', 'Reviewer reports a pass'));
  const privateMail = commitIntent(home, root, newMessage(root, store.addrDir(a), [store.addrDir('approver:alpha')], 'review', 'Not addressed to the owner', null, new Date(at)), new Date(at));
  completeFanout(home, root, privateMail);
  for (let i = 0; i < 7; i++) ids.push(await send(root, b, 'status', `Update ${i}`));
  writeStalls(home, root, { [b]: { at, reason: 'holder failed' } });
  const before = [root, child].map((task) => ({
    journal: readFileSync(taskFile(home, task), 'utf8'),
    unread: readdirSync(store.inboxDir(home, task, 'orchestrator')).sort(),
  }));
  assert.equal(JSON.parse(before[0].journal).participants.find((p) => p.id === 'orchestrator').metadata.owner, 'managed-thread');
  let output = '';
  const exit = await runPromptobus(['observe', '--task', root, '--after', bootstrap.nextCursor], {
    host, env: ownerEnv, output: { write: (chunk) => { output += chunk; } },
  });
  assert.equal(exit, 0);
  const first = JSON.parse(output);
  assert.equal(first.more, true);
  assert.equal(first.messages.length, 10);
  assert.deepEqual(first.changes, []);
  assert.deepEqual(first.messages.slice(0, 6).map(({ from, type }) => [from, type]), [
    [a, 'status'], [b, 'status'], [a, 'question'], ['orchestrator', 'status'], [a, 'result'], ['reviewer:alpha', 'result'],
  ]);
  const second = await observe(host, { task: root, after: first.nextCursor }, ownerEnv);
  assert.equal(second.more, false);
  const seen = [...first.messages, ...second.messages];
  assert.deepEqual(seen.map(({ id }) => id), ids);
  assert.ok(!seen.some(({ id }) => [unrelated, childMail, privateMail.id].includes(id)));
  assert.ok(seen.every(({ id, task, at, to }) => task === root && Date.parse(at)
    && to[0] === (id === decision.message.id ? 'user' : 'orchestrator')));
  assert.deepEqual(second.changes, [{ kind: 'stall', task: root, address: b, at, reason: 'holder failed' }]);
  const idle = await observe(host, { task: root, after: second.nextCursor }, ownerEnv);
  assert.equal(idle.status, 'idle');
  assert.deepEqual(idle.messages, []);
  assert.deepEqual(idle.changes, []);
  assert.equal(idle.nextCursor, second.nextCursor);
  for (const [i, task] of [root, child].entries()) {
    assert.equal(readFileSync(taskFile(home, task), 'utf8'), before[i].journal);
    assert.deepEqual(readdirSync(store.inboxDir(home, task, 'orchestrator')).sort(), before[i].unread);
  }
  writeStalls(home, root, {});
  const cleared = await observe(host, { task: root, after: idle.nextCursor }, ownerEnv);
  assert.deepEqual(cleared.changes, [{ kind: 'stall-cleared', task: root, address: b, at: null }]);
  const childPage = await observe(host, { task: child }, childEnv);
  assert.deepEqual(childPage.messages.map((m) => m.id), [childMail]);
});

test('identity and scope are required on fresh reads and continuations', async () => {
  const { host, home, send, cwd } = fixture();
  const id = await send(root, a, 'status', 'Owner only');
  const first = await observe(host, { task: root }, ownerEnv);
  assert.equal(first.messages[0].id, id);
  const mustRefuse = [
    [root, {}], [root, { CODEX_THREAD_ID: 'separate-desktop-thread' }],
    [root, { CODEX_THREAD_ID: 'managed-thread' }], [root, { ...ownerEnv, CODEX_THREAD_ID: 'contested' }],
    [root, { ...ownerEnv, PROMPTOBUS_ROLE: 'worker:alpha' }],
    [other, { CLAUDE_CODE_SESSION_ID: 'managed-thread' }], [child, { CLAUDE_CODE_SESSION_ID: 'managed-thread' }],
    [root, { CLAUDE_CODE_SESSION_ID: 'child-thread' }], [sibling, { CLAUDE_CODE_SESSION_ID: 'child-thread' }],
    [root, { ...ownerEnv, PROMPTOBUS_TASK: child }],
  ];
  for (const [task, env] of mustRefuse) {
    for (const after of [undefined, first.nextCursor]) {
      await assert.rejects(observe(host, { task, after }, env), /bound orchestrator command identity/);
    }
  }
  const refused = cli(cwd, ['--task', root], childEnv);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /bound orchestrator command identity/);
  const admitted = cli(cwd, ['--task', root], ownerEnv);
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.deepEqual(JSON.parse(admitted.stdout).messages.map((m) => m.id), [id]);
  await assert.rejects(observe(host, { task: root }, { ...ownerEnv, PROMPTOBUS_HOME: cwd }), /declared store scope differs/);
  await assert.rejects(observe(host, { task: child, after: first.nextCursor }, childEnv), /different store, task or owner/);
  store.claimOwnership(home, root, 'replacement-thread');
  await assert.rejects(observe(host, { task: root, after: first.nextCursor }, ownerEnv), /bound orchestrator command identity/);
  await assert.rejects(observe(host, { task: root, after: first.nextCursor }, { CLAUDE_CODE_SESSION_ID: 'replacement-thread' }), /different store, task or owner/);
  store.upsertParticipant(home, root, store.participantRecord('orchestrator', { harness: 'codex', owner: 'managed-codex' }));
  const managed = await observe(host, { task: root }, { CODEX_THREAD_ID: 'managed-codex' });
  assert.deepEqual(managed.messages.map((m) => m.id), [id]);
});

test('a teamlead declaring its parent task and address observes its child only when that parent record links them', async () => {
  const { cwd, host, home, send } = fixture();
  const id = await send(child, b, 'status', 'Child progress');
  const lead = { CLAUDE_CODE_SESSION_ID: 'child-thread', PROMPTOBUS_ROLE: 'teamlead:child' };
  for (const env of [{ ...lead, PROMPTOBUS_TASK: root }, lead]) {
    assert.deepEqual((await observe(host, { task: child }, env)).messages.map((m) => m.id), [id]);
  }
  const mustRefuse = [
    [child, { ...lead, PROMPTOBUS_TASK: other }], [child, { ...lead, PROMPTOBUS_TASK: sibling }],
    [child, { ...lead, PROMPTOBUS_ROLE: 'teamlead:sibling' }], [child, { ...lead, PROMPTOBUS_ROLE: 'worker:beta' }],
    [sibling, { ...lead, PROMPTOBUS_ROLE: 'teamlead:sibling', CLAUDE_CODE_SESSION_ID: 'child-thread' }],
    [root, { ...lead, PROMPTOBUS_TASK: root }], [other, { ...lead, CLAUDE_CODE_SESSION_ID: 'other-thread' }],
    [child, { ...lead, CLAUDE_CODE_SESSION_ID: 'managed-thread' }],
  ];
  for (const [task, env] of mustRefuse) {
    await assert.rejects(observe(host, { task }, env), /bound orchestrator command identity/, `${task} ${JSON.stringify(env)}`);
  }
  const journal = readFileSync(taskFile(home, root), 'utf8');
  const relinked = (field, value) => {
    const parent = JSON.parse(journal);
    const record = parent.participants.find((p) => p.metadata.address === 'teamlead:child');
    assert.equal(record.metadata.sessionId, 'child-thread');
    record.metadata[field] = value;
    writeFileSync(taskFile(home, root), JSON.stringify(parent));
  };
  const leadCli = () => cli(cwd, ['--task', child], { ...lead, PROMPTOBUS_TASK: root });
  for (const [field, value] of [['childTask', sibling], ['sessionId', 'replacement-thread']]) {
    relinked(field, value);
    const refused = leadCli();
    assert.equal(refused.status, 1, field);
    assert.equal(refused.stdout, '', field);
    assert.match(refused.stderr, /bound orchestrator command identity/, field);
  }
  writeFileSync(taskFile(home, root), journal);
  const restored = leadCli();
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(JSON.parse(restored.stdout).messages.map((m) => m.id), [id]);
});

test('a record replaced atomically during the read is re-read a bounded number of times', async () => {
  const { host, home, send } = fixture();
  const first = await observe(host, { task: root }, ownerEnv);
  const id = await send(root, a, 'status', 'after a replacement');
  writeStalls(home, root, { [a]: { at, reason: 'holder stalled' } });
  const open = fs.openSync;
  const replace = (targets, times) => {
    const left = new Map(targets.map((file) => [file, times]));
    fs.openSync = (file, ...rest) => {
      if (left.get(file) > 0) {
        left.set(file, left.get(file) - 1);
        fs.openSync = open;
        syncBuiltinESMExports();
        writeFileSync(`${file}.swap`, readFileSync(file));
        renameSync(`${file}.swap`, file);
        replace([...left.keys()], left.get(file));
      }
      return open(file, ...rest);
    };
    syncBuiltinESMExports();
  };
  try {
    for (const file of [taskFile(home, root), stallsFile(home, root)]) {
      replace([file], 1);
      const page = await observe(host, { task: root, after: first.nextCursor }, ownerEnv);
      assert.deepEqual(page.messages.map((m) => m.id), [id]);
      assert.deepEqual(page.changes, [{ kind: 'stall', task: root, address: a, at, reason: 'holder stalled' }]);
    }
    replace([taskFile(home, root)], Infinity);
    await assert.rejects(observe(host, { task: root, after: first.nextCursor }, ownerEnv),
      /feed unavailable; keep the previous cursor: a selected store record was replaced while it was read/);
  } finally {
    fs.openSync = open;
    syncBuiltinESMExports();
  }
});

test('a closure already reported is not reported again after intermediate pages', async () => {
  const { home, host } = fixture();
  const otherEnv = { CLAUDE_CODE_SESSION_ID: 'other-thread' };
  store.closeTask(home, other);
  const closed = await observe(host, { task: other }, otherEnv);
  assert.equal(closed.closed, true);
  assert.deepEqual(closed.changes.map((c) => c.kind), ['task-state']);
  const when = new Date(at);
  for (let i = 0; i < 11; i++) {
    completeFanout(home, other, commitIntent(home, other, newMessage(other, store.addrDir(b), ['orchestrator'], 'status', `late ${i}`, null, when), when));
  }
  const middle = await observe(host, { task: other, after: closed.nextCursor }, otherEnv);
  assert.equal(middle.more, true);
  const last = await observe(host, { task: other, after: middle.nextCursor }, otherEnv);
  assert.equal(last.more, false);
  assert.equal(last.closed, true);
  assert.deepEqual(last.changes, []);
});

test('bounded waiting returns a new message or explicitly times out idle', async () => {
  const { host, send } = fixture();
  const first = await observe(host, { task: root }, ownerEnv);
  const pending = observe(host, { task: root, after: first.nextCursor, wait: '2' }, ownerEnv);
  const id = await send(root, a, 'status', 'during wait');
  const arrived = await pending;
  assert.deepEqual(arrived.messages.map((m) => m.id), [id]);
  const empty = await observe(host, { task: root, after: arrived.nextCursor, wait: '1' }, ownerEnv);
  assert.equal(empty.status, 'idle');
  assert.equal(empty.nextCursor, arrived.nextCursor);
});

test('incomplete selected mail fails without recovery, unrelated intents do not block, and retry keeps order', async () => {
  const { cwd, home, host, send } = fixture();
  const first = await observe(host, { task: root }, ownerEnv);
  const draft = (task) => newMessage(task, store.addrDir(b), ['orchestrator'], 'status', 'draft', null, new Date(at));
  const unrelated = commitIntent(home, other, draft(other), new Date(at));
  const unselected = commitIntent(home, child, draft(child), new Date(at));
  const early = commitIntent(home, root, draft(root), new Date(at));
  const late = await send(root, a, 'status', 'later commit');
  const command = () => cli(cwd, ['--task', root, '--after', first.nextCursor], ownerEnv);
  const refused = command();
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /selected journal is incomplete: unresolved message fan-out/);
  assert.ok(readFileSync(intentFile(home, root, early.id), 'utf8'));
  completeFanout(home, root, early);
  const retried = command();
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(JSON.parse(retried.stdout).messages.map((m) => m.id), [early.id, late]);
  assert.ok(readFileSync(intentFile(home, other, unrelated.id), 'utf8'));
  assert.ok(readFileSync(intentFile(home, child, unselected.id), 'utf8'));
  await assert.rejects(withMessageCommit(home, () => observe(host, { task: root, after: first.nextCursor }, ownerEnv)), /store message order is busy/);
  writeFileSync(messageFile(home, root, late), 'invalid');
  await assert.rejects(observe(host, { task: root, after: first.nextCursor }, ownerEnv), /task .* canonical mail/);
});

test('out-of-store files, non-regular entries and oversize records fail without a partial page or cursor', async () => {
  const { cwd, home, host, send } = fixture();
  const first = await observe(host, { task: root }, ownerEnv);
  const id = await send(root, a, 'status', 'Not returned on any read refusal');
  writeStalls(home, root, { [a]: { reason: 'holder stalled', at } });
  const command = () => cli(cwd, ['--task', root, '--after', first.nextCursor], ownerEnv);
  const assertUnavailable = () => {
    const refused = command();
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /feed unavailable; keep the previous cursor/);
    assert.doesNotMatch(refused.stderr, /nextCursor|Not returned on any read refusal/);
  };
  const directory = messagesDir(home, root);
  for (const file of [taskFile(home, root), messageFile(home, root, id), messageOrderFile(home), stallsFile(home, root), directory, home]) {
    const outside = path.join(cwd, 'outside-fixture');
    renameSync(file, outside);
    symlinkSync(outside, file, file === directory || file === home ? 'dir' : 'file');
    try { assertUnavailable(); }
    finally { unlinkSync(file); renameSync(outside, file); }
  }
  const canon = messageFile(home, root, id);
  const saved = path.join(cwd, 'outside-fixture');
  renameSync(canon, saved);
  mkdirSync(canon);
  try { assertUnavailable(); }
  finally { rmdirSync(canon); renameSync(saved, canon); }
  const original = readFileSync(canon);
  try { writeFileSync(canon, Buffer.alloc(1024 * 1024 + 1)); assertUnavailable(); }
  finally { writeFileSync(canon, original); }
  const recovered = command();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout).messages.map((m) => m.id), [id]);
});

test('a selected intent moved to quarantine between listings does not expose an older page', async () => {
  const { home, host, send } = fixture();
  await send(root, a, 'status', 'older mail');
  const when = new Date(at);
  const pending = commitIntent(home, root, newMessage(root, store.addrDir(a), ['orchestrator'], 'status', 'pending', null, when), when);
  const attic = brokenMessagesDir(home, root);
  mkdirSync(attic, { recursive: true });
  const reader = ownedReader(home);
  assert.throws(() => strictCommittedMessages(home, root, { ...reader, names(dir) {
    if (dir === intentsDir(home, root)) renameSync(intentFile(home, root, pending.id), path.join(attic, `${pending.id}.json`));
    return reader.names(dir);
  } }), /unresolved broken message/);
  await assert.rejects(observe(host, { task: root }, ownerEnv), /unresolved broken message/);
});

test('Desktop instructions name the authorization blocker separately from idle wake', () => {
  const reference = readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8');
  const guide = readFileSync(new URL('../skills/orchestrate/SKILL.md', import.meta.url), 'utf8');
  assert.match(reference, /observe --task <id> \[--after <cursor>\] \[--wait <seconds>\]/);
  assert.match(reference, /bounds retry scheduling, not total command\s+time/);
  assert.match(reference, /rescans the selected journal from its start[^.]*\. Past one of these\s+limits observation of that task is refused on every poll/);
  assert.match(reference, /replaced atomically while it is read is re-read up to three\s+times/);
  assert.match(reference, /may instead declare its parent task and its `teamlead:<slug>` address/);
  assert.match(guide, /`nextCursor`/);
  assert.match(guide, /A separate Desktop thread cannot read message bodies through it/);
  assert.match(guide, /does not wake an idle Desktop conversation/);
});

// Root mail to a teamlead lands in its child task's orchestrator mailbox: the one the
// teamlead's bus entry reads. Real CLI and MCP processes, a stub knock for the warden.
import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './sandbox.mjs';
import * as store from '../lib/store.js';
import { registerWake } from '../lib/driver-claude.js';
import { KNOCK_RETRY_SEC, wardenRound } from '../lib/warden.js';
import { buildDigest } from '../lib/digest.js';

const BIN = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const stand = makeSandbox('promptobus-test-teamlead-root-mail-');
const home = path.join(stand, '.promptobus');
writeFileSync(path.join(stand, 'promptobus.json'), `${JSON.stringify({ commandName: 'promptobus', tools: ['claude'] })}\n`);
store.bus(home, { cli: 'suite' });
const ROOT = 'root-t20261003-130000';
const CHILD = 'group-one-t20261003-130001';
const SIBLING = 'group-two-t20261003-130002';
store.createTask(home, { id: ROOT, title: 'Root', owner: 'root-session', adapter: { slug: 'root' } });
store.createTask(home, {
  id: CHILD, title: 'Group one', owner: 'lead-session', parent: ROOT, teamlead: 'teamlead:group-one',
  adapter: { slug: 'group-one' },
});
store.createTask(home, {
  id: SIBLING, title: 'Group two', owner: 'second-lead', parent: ROOT, teamlead: 'teamlead:group-two',
  adapter: { slug: 'group-two' },
});

const baseEnv = () => {
  const env = { ...process.env, PROMPTOBUS_HOME: home };
  for (const name of ['PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK', 'PROMPTOBUS_ROOT_TASK', 'CLAUDE_CODE_SESSION_ID']) delete env[name];
  return env;
};

function cli(session, ...args) {
  const ran = spawnSync(process.execPath, [BIN, ...args], {
    cwd: stand, encoding: 'utf8', env: { ...baseEnv(), CLAUDE_CODE_SESSION_ID: session },
  });
  return { code: ran.status, out: `${ran.stdout}${ran.stderr}` };
}

// The teamlead's bus entry as `spawn --teamlead` writes it: the child task as `orchestrator`.
function teamleadTools(...calls) {
  const ran = spawnSync(process.execPath, [BIN, 'mcp'], {
    cwd: stand,
    encoding: 'utf8',
    env: {
      ...baseEnv(), PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_TASK: CHILD, PROMPTOBUS_ROOT_TASK: ROOT,
      CLAUDE_CODE_SESSION_ID: 'lead-session',
    },
    input: `${calls.map(([name, args], i) => JSON.stringify({
      jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args },
    })).join('\n')}\n`,
  });
  return ran.stdout.split('\n').filter(Boolean).map((line) => {
    const reply = JSON.parse(line).result;
    return { error: reply.isError === true, text: reply.content[0].text };
  });
}

const contact = { CLAUDE_CODE_MESSAGING_SOCKET: path.join(stand, 'lead.sock'), CLAUDE_CODE_MESSAGING_TOKEN: 't' };
registerWake(home, ROOT, 'teamlead:group-one', { ...contact, CLAUDE_CODE_SESSION_ID: 'lead-session' });
registerWake(home, CHILD, 'orchestrator', { ...contact, CLAUDE_CODE_SESSION_ID: 'lead-session' });

async function knocks(task, now) {
  const calls = [];
  await wardenRound(home, task, {
    now,
    knock: async (endpoint, body) => {
      calls.push({ address: endpoint.address, unread: body.match(/has unread: (\d+)/)?.[1] });
      return { ok: true };
    },
  });
  return calls;
}

const unread = () => ({
  root: store.countInbox(home, ROOT, 'teamlead:group-one'),
  child: store.countInbox(home, CHILD, 'orchestrator'),
});

let clock = Date.now();

test('a root send to teamlead:<slug> lands in the child orchestrator mailbox, not in the root', () => {
  const sent = cli('root-session', 'send', 'teamlead:group-one', '--task', ROOT, '--type', 'question', '--body', 'root asks the lead');
  assert.equal(sent.code, 0, sent.out);
  assert.match(sent.out, new RegExp(`task ${CHILD}`), sent.out);
  assert.deepEqual(unread(), { root: 0, child: 1 });
});

test('the warden knocks the teamlead once for it, on the child task only', async () => {
  assert.deepEqual(await knocks(ROOT, clock), []);
  assert.deepEqual(await knocks(CHILD, clock), [{ address: 'orchestrator', unread: '1' }]);
  assert.deepEqual(await knocks(CHILD, clock + 1000), []);
});

test('the teamlead reads it with its own mailbox tool and that read marks it read in both tasks', () => {
  const [mailbox] = teamleadTools(['promptobus_mailbox', {}]);
  assert.equal(mailbox.error, false, mailbox.text);
  assert.match(mailbox.text, /### question from /, mailbox.text);
  assert.match(mailbox.text, new RegExp(`task=${CHILD}`), mailbox.text);
  assert.deepEqual(unread(), { root: 0, child: 0 });
});

test('mail already read draws no knock, past the re-knock threshold too', async () => {
  clock += (KNOCK_RETRY_SEC + 5) * 1000;
  assert.deepEqual(await knocks(ROOT, clock), []);
  assert.deepEqual(await knocks(CHILD, clock), []);
});

test('a second message draws exactly one more knock', async () => {
  const sent = cli('root-session', 'send', 'teamlead:group-one', '--task', ROOT, '--type', 'status', '--body', 'root status');
  assert.equal(sent.code, 0, sent.out);
  clock += 1000;
  assert.deepEqual(await knocks(CHILD, clock), [{ address: 'orchestrator', unread: '1' }]);
  assert.deepEqual(await knocks(ROOT, clock), []);
  teamleadTools(['promptobus_mailbox', {}]);
  assert.deepEqual(unread(), { root: 0, child: 0 });
});

test('sibling traffic between teamleads stays in the root task', () => {
  const before = unread();
  store.sendMessage(home, ROOT, {
    from: 'teamlead:group-two', to: 'teamlead:group-one', type: 'status', body: 'sibling note', session: 'second-lead',
  }, { status: 'promptobus status' });
  assert.deepEqual(unread(), { root: before.root + 1, child: before.child });
});

test('the message keeps its origin: root:<root slug> in the child, originTask the root', () => {
  const record = store.rootRecordOf(store.readTask(home, CHILD));
  assert.equal(store.addressOf(record), 'root:root');
  assert.equal(record.metadata.rootTask, ROOT);
  const landed = store.taskMessageHeaders(home, CHILD).filter((m) => m.sender === 'root-root');
  assert.equal(landed.length, 2);
  assert.ok(landed.every((m) => m.originTask === ROOT && m.recipients.includes('orchestrator')), JSON.stringify(landed));
  const sent = cli('root-session', 'send', 'teamlead:group-one', '--task', ROOT, '--type', 'task', '--body', 'root assigns');
  const [mailbox] = teamleadTools(['promptobus_mailbox', {}]);
  assert.match(sent.out, /from root:root · task group-one-t20261003-130001 .* via teamlead:group-one of task root-t20261003-130000/, sent.out);
  assert.match(mailbox.text, /### task from root:root · address root:root · /, mailbox.text);
});

test('a reply to root:<slug> reaches the root orchestrator as teamlead:<slug>; the named-task route still works', () => {
  const before = store.countInbox(home, ROOT, 'orchestrator');
  const [reply, upward] = teamleadTools(
    ['promptobus_send', { to: 'root:root', type: 'answer', body: 'lead answers the root' }],
    ['promptobus_send', { task: ROOT, to: 'orchestrator', type: 'status', body: 'lead reports upward' }],
  );
  assert.equal(reply.error, false, reply.text);
  assert.match(reply.text, new RegExp(`task=${ROOT} .*address=teamlead:group-one · via root:root of task ${CHILD}`), reply.text);
  assert.equal(upward.error, false, upward.text);
  assert.equal(store.countInbox(home, ROOT, 'orchestrator'), before + 2);
  const answer = store.taskMessageHeaders(home, ROOT).findLast((m) => m.type === 'answer');
  assert.equal(answer.sender, 'teamlead-group-one');
  assert.equal(store.countInbox(home, CHILD, 'root:root'), 0);
  store.readInbox(home, ROOT, 'orchestrator');
});

test('root:<slug> talks only to the orchestrator of a child task', () => {
  store.upsertParticipant(home, CHILD, store.participantRecord('worker:api', { sessionId: 'worker-session' }));
  store.upsertParticipant(home, ROOT, store.participantRecord('root:stray'));
  const engine = store.bus(home, { cli: 'suite' });
  for (const [task, from, to] of [[CHILD, 'worker-api', 'root-root'], [CHILD, 'root-root', 'worker-api'],
    [ROOT, 'root-stray', 'orchestrator'], [ROOT, 'orchestrator', 'root-stray']]) {
    assert.throws(() => engine.sendSync(task, { from, to: [to], type: 'status', body: 'x' }),
      (e) => e.code === 'policy-denied' && /stands for the root orchestrator/.test(e.message), `${task} ${from} → ${to}`);
  }
});

test('mail left at the root slot by an earlier version moves into the child on the teamlead\'s read; sibling mail stays', () => {
  const engine = store.bus(home, { cli: 'suite' });
  const file = path.join(stand, 'legacy-brief.md');
  writeFileSync(file, 'legacy attachment\n');
  const legacy = [
    engine.sendSync(ROOT, { from: 'orchestrator', to: ['teamlead-group-one'], type: 'question', body: 'legacy question' }),
    engine.sendSync(ROOT, {
      from: 'orchestrator', to: ['teamlead-group-one'], type: 'artifact', body: 'legacy file',
      artifact: { path: file, name: () => { copyFileSync(file, path.join(store.filesDir(home, ROOT), 'legacy-brief.md')); return 'legacy-brief.md'; } },
    }),
  ].map((sent) => sent.message.id);
  const siblingBefore = store.countInbox(home, ROOT, 'teamlead:group-one');
  assert.equal(siblingBefore, 3, 'two legacy messages and the earlier sibling note');
  const [mailbox] = teamleadTools(['promptobus_mailbox', {}]);
  assert.match(mailbox.text, /messages 2: question from root:root, artifact from root:root/, mailbox.text);
  assert.match(mailbox.text, /artifact: .*group-one-t20261003-130001\/files\/legacy-brief\.md/, mailbox.text);
  assert.equal(store.countInbox(home, ROOT, 'teamlead:group-one'), 1, 'the sibling note stays in the root slot');
  assert.equal(store.peekInbox(home, ROOT, 'teamlead:group-one').messages[0].sender, 'teamlead-group-two');
  const read = store.historyHeaders(home, ROOT, 'teamlead:group-one').map((m) => m.id);
  assert.ok(legacy.every((id) => read.includes(id)), 'the root refs moved to root history');
  const moved = store.taskMessageHeaders(home, CHILD).slice(-2);
  assert.deepEqual(moved.map((m) => [m.sender, m.type, m.originTask]),
    [['root-root', 'question', ROOT], ['root-root', 'artifact', ROOT]]);
  assert.ok(moved.every((m) => !legacy.includes(m.id)), 'the moved messages carry new ids');
  assert.equal(store.countInbox(home, CHILD, 'orchestrator'), 0);
});

test('a root-slot message that cannot move stays unread there, and the read still succeeds', () => {
  const engine = store.bus(home, { cli: 'suite' });
  const file = path.join(stand, 'unnamed.md');
  writeFileSync(file, 'no human name was placed\n');
  const stuck = engine.sendSync(ROOT, {
    from: 'orchestrator', to: ['teamlead-group-one'], type: 'artifact', body: 'no file', artifact: { path: file },
  }).message.id;
  const [mailbox] = teamleadTools(['promptobus_mailbox', {}]);
  assert.equal(mailbox.error, false, mailbox.text);
  assert.ok(store.peekInbox(home, ROOT, 'teamlead:group-one').messages.some((m) => m.id === stuck));
  store.readInbox(home, ROOT, 'teamlead:group-one');
});

test('a root-slot message whose attachment record is gone stays there rather than moving without its file', () => {
  const engine = store.bus(home, { cli: 'suite' });
  const file = path.join(stand, 'lost-record.md');
  writeFileSync(file, 'attached to a task\n');
  const sent = engine.sendSync(ROOT, {
    from: 'orchestrator', to: ['teamlead-group-one'], type: 'task', body: 'task with a file',
    artifact: { path: file, name: () => { copyFileSync(file, path.join(store.filesDir(home, ROOT), 'lost-record.md')); return 'lost-record.md'; } },
  });
  rmSync(path.join(store.artifactsDir(home, ROOT), `${sent.artifact.id}.json`));
  const childBefore = store.taskMessageHeaders(home, CHILD).length;
  const [mailbox] = teamleadTools(['promptobus_mailbox', {}]);
  assert.equal(mailbox.error, false, mailbox.text);
  assert.ok(store.peekInbox(home, ROOT, 'teamlead:group-one').messages.some((m) => m.id === sent.message.id),
    'the message stays unread at the root slot');
  assert.equal(store.taskMessageHeaders(home, CHILD).length, childBefore, 'nothing was delivered into the child');
  store.readInbox(home, ROOT, 'teamlead:group-one');
});

test('a drain that fails outside one message still returns the child mailbox, and the next read retries it', () => {
  const third = 'group-three-t20261003-130003';
  store.createTask(home, {
    id: third, title: 'Group three', owner: 'third-lead', parent: ROOT, teamlead: 'teamlead:group-three',
    adapter: { slug: 'group-three' },
  });
  const engine = store.bus(home, { cli: 'suite' });
  engine.sendSync(ROOT, { from: 'orchestrator', to: ['teamlead-group-three'], type: 'status', body: 'left at the slot' });
  cli('root-session', 'send', 'teamlead:group-three', '--task', ROOT, '--type', 'status', '--body', 'routed already');
  const history = path.join(home, 'tasks', ROOT, 'history', 'teamlead-group-three');
  writeFileSync(history, 'a file where the history directory goes\n');
  const read = (args) => spawnSync(process.execPath, [BIN, 'mcp'], {
    cwd: stand, encoding: 'utf8',
    env: { ...baseEnv(), PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_TASK: third, CLAUDE_CODE_SESSION_ID: 'third-lead' },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'promptobus_mailbox', arguments: args } })}\n`,
  });
  const first = read({});
  const reply = JSON.parse(first.stdout.split('\n')[0]).result;
  assert.equal(reply.isError, undefined, reply.content[0].text);
  assert.match(reply.content[0].text, /status from root:root/, reply.content[0].text);
  assert.match(first.stderr, /root mail drain into task group-three-t20261003-130003 stopped/, first.stderr);
  assert.equal(store.countInbox(home, ROOT, 'teamlead:group-three'), 1, 'the slot keeps its message for the next read');
  rmSync(history);
  read({});
  assert.equal(store.countInbox(home, ROOT, 'teamlead:group-three'), 0, 'the next read drained it');
});

test('the digest pairs a question and its answer across the root and the child', () => {
  cli('root-session', 'send', 'teamlead:group-one', '--task', ROOT, '--type', 'question', '--body', 'root question');
  teamleadTools(
    ['promptobus_mailbox', {}],
    ['promptobus_send', { to: 'root:root', type: 'answer', body: 'answered' }],
    ['promptobus_send', { task: ROOT, to: 'orchestrator', type: 'question', body: 'lead question' }],
  );
  cli('root-session', 'send', 'teamlead:group-one', '--task', ROOT, '--type', 'answer', '--body', 'root answers');
  const page = buildDigest(stand, { task: ROOT });
  const open = page.tasks.flatMap((task) => task.questions.map((q) => `${task.id}: ${q.from} → ${q.to}`));
  assert.deepEqual(open.filter((line) => /root:root|teamlead:group-one → orchestrator/.test(line)), [], JSON.stringify(open));
});

test('root and task views name where the teamlead\'s mail lands', () => {
  const shown = cli('root-session', 'status', '--task', ROOT);
  assert.match(shown.out, new RegExp(`teamlead:group-one · child task ${CHILD}, root mail lands in its orchestrator mailbox`), shown.out);
  assert.match(shown.out, new RegExp(`root:root · stands for the orchestrator of root task ${ROOT}`), shown.out);
});

test('a send to root:<slug> is refused while the root record and the child owner name different sessions', () => {
  store.ensureRootRecord(home, SIBLING);
  store.claimOwnership(home, SIBLING, 'stranger-session');
  const before = store.countInbox(home, ROOT, 'orchestrator');
  assert.throws(() => store.sendMessage(home, SIBLING, {
    from: 'orchestrator', to: 'root:root', type: 'status', body: 'borrowed', session: 'stranger-session',
  }, { status: 'promptobus status' }), /holds no teamlead bound to this session's child task/);
  assert.equal(store.countInbox(home, ROOT, 'orchestrator'), before);
});

test('mail to the teamlead of a closed child stays in the root task', () => {
  store.closeTask(home, SIBLING);
  const sent = cli('root-session', 'send', 'teamlead:group-two', '--task', ROOT, '--type', 'status', '--body', 'after close');
  assert.equal(sent.code, 0, sent.out);
  assert.equal(store.countInbox(home, ROOT, 'teamlead:group-two'), 1);
});

// A teamlead's one mailbox: its child `orchestrator` slot and the root `teamlead:<slug>` slot, read,
// counted and knocked as one (ADR-028). Real CLI and MCP processes, a stub knock for the warden.
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
import { guardVerdict } from '../lib/guard.js';
import { sweepJournals } from '../lib/prune.js';

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
// `spawn --teamlead` writes the child's `root:<root slug>` record after the child link.
store.ensureRootRecord(home, CHILD);

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

function toolsAs(env, ...calls) {
  const ran = spawnSync(process.execPath, [BIN, 'mcp'], {
    cwd: stand,
    encoding: 'utf8',
    env: { ...baseEnv(), ...env },
    input: `${calls.map(([name, args], i) => JSON.stringify({
      jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: args },
    })).join('\n')}\n`,
  });
  return ran.stdout.split('\n').filter(Boolean).map((line) => {
    const reply = JSON.parse(line).result;
    return { error: reply.isError === true, text: reply.content[0].text };
  });
}

// The teamlead's bus entry as `spawn --teamlead` writes it: the child task as `orchestrator`.
const teamleadTools = (...calls) => toolsAs({
  PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_TASK: CHILD, PROMPTOBUS_ROOT_TASK: ROOT, CLAUDE_CODE_SESSION_ID: 'lead-session',
}, ...calls);

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

test('a root teamlead record is an address alias of its child orchestrator, and its handover writes the one primary point', () => {
  const lead = store.mailboxOf(home, ROOT, 'teamlead:group-one');
  const slots = [{ task: CHILD, address: 'orchestrator' }, { task: ROOT, address: 'teamlead:group-one' }];
  assert.deepEqual(lead, { primary: slots[0], slots, alias: true });
  assert.deepEqual(store.mailboxOf(home, CHILD, 'orchestrator'), { primary: slots[0], slots, alias: false });
  for (const [task, address] of [[ROOT, 'orchestrator'], [CHILD, 'root:root']]) {
    assert.deepEqual(store.mailboxOf(home, task, address), { primary: { task, address }, slots: [{ task, address }], alias: false });
  }
  assert.equal(store.readWake(home, ROOT, 'teamlead:group-one'), null, 'the root alias keeps no point of its own');
  assert.equal(store.readWake(home, CHILD, 'orchestrator')?.socket, contact.CLAUDE_CODE_MESSAGING_SOCKET);
});

test('a root send to teamlead:<slug> lands in the root slot and counts once in the teamlead\'s mailbox', () => {
  const sent = cli('root-session', 'send', 'teamlead:group-one', '--task', ROOT, '--type', 'question', '--body', 'root asks the lead');
  assert.equal(sent.code, 0, sent.out);
  assert.match(sent.out, new RegExp(`sent question → teamlead:group-one · from orchestrator · task ${ROOT}`), sent.out);
  assert.deepEqual(unread(), { root: 1, child: 0 });
  assert.equal(store.countMailbox(home, CHILD, 'orchestrator'), 1);
  assert.equal(store.countMailbox(home, ROOT, 'teamlead:group-one'), 1);
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

test('sibling mail is read and marked by the receiving teamlead\'s mailbox, and no unread remains in either task', () => {
  const [mailbox] = teamleadTools(['promptobus_mailbox', {}]);
  assert.equal(mailbox.error, false, mailbox.text);
  assert.match(mailbox.text, new RegExp(`### status from .* · address teamlead:group-two · task ${ROOT} · `), mailbox.text);
  assert.deepEqual(unread(), { root: 0, child: 0 });
  const read = store.historyHeaders(home, ROOT, 'teamlead:group-one');
  assert.equal(read.findLast((m) => m.type === 'status').sender, 'teamlead-group-two');
});

test('root mail keeps its sender, the root task\'s orchestrator, named with its task in the teamlead\'s mailbox header', () => {
  const sent = cli('root-session', 'send', 'teamlead:group-one', '--task', ROOT, '--type', 'task', '--body', 'root assigns');
  assert.equal(sent.code, 0, sent.out);
  const landed = store.taskMessageHeaders(home, ROOT).findLast((m) => m.type === 'task');
  assert.equal(landed.sender, 'orchestrator');
  assert.deepEqual(landed.recipients, ['teamlead-group-one']);
  assert.equal(store.taskMessageHeaders(home, CHILD).filter((m) => m.sender === 'root-root').length, 0);
  const [mailbox] = teamleadTools(['promptobus_mailbox', {}]);
  assert.match(mailbox.text, new RegExp(`### task from the orchestrator · address orchestrator · task ${ROOT} · `), mailbox.text);
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

test('mail an earlier version left at the root slot is read in place with sibling mail, keeps its id, and is marked read in the root', () => {
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
  store.sendMessage(home, ROOT, {
    from: 'teamlead:group-two', to: 'teamlead:group-one', type: 'status', body: 'sibling beside legacy mail', session: 'second-lead',
  }, { status: 'promptobus status' });
  const childBefore = store.taskMessageHeaders(home, CHILD).length;
  assert.equal(store.countInbox(home, ROOT, 'teamlead:group-one'), 3);
  const [mailbox] = teamleadTools(['promptobus_mailbox', {}]);
  assert.match(mailbox.text, /messages 3: /, mailbox.text);
  assert.match(mailbox.text, /artifact: .*root-t20261003-130000\/files\/legacy-brief\.md/, mailbox.text);
  assert.deepEqual(unread(), { root: 0, child: 0 });
  const read = store.historyHeaders(home, ROOT, 'teamlead:group-one').map((m) => m.id);
  assert.ok(legacy.every((id) => read.includes(id)), 'the root refs were read in place, under their own ids');
  assert.equal(store.taskMessageHeaders(home, CHILD).length, childBefore, 'nothing was delivered into the child');
});

test('a read that fails on the address alias slot still returns the primary slot, names the failure, and the next read takes the address alias slot', () => {
  const third = 'group-three-t20261003-130003';
  store.createTask(home, {
    id: third, title: 'Group three', owner: 'third-lead', parent: ROOT, teamlead: 'teamlead:group-three',
    adapter: { slug: 'group-three' },
  });
  store.upsertParticipant(home, third, store.participantRecord('worker:api', { sessionId: 'worker-session' }));
  const engine = store.bus(home, { cli: 'suite' });
  engine.sendSync(ROOT, { from: 'orchestrator', to: ['teamlead-group-three'], type: 'status', body: 'left at the slot' });
  engine.sendSync(third, { from: 'worker-api', to: ['orchestrator'], type: 'status', body: 'worker reports' });
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
  assert.match(reply.content[0].text, /status from .*worker:api/, reply.content[0].text);
  assert.match(reply.content[0].text, new RegExp(`MAILBOX SLOT teamlead:group-three of task ${ROOT} did not read`), reply.content[0].text);
  assert.equal(store.countInbox(home, ROOT, 'teamlead:group-three'), 1, 'the slot keeps its message for the next read');
  assert.equal(store.countInbox(home, third, 'orchestrator'), 0, 'the primary slot was read');
  rmSync(history);
  read({});
  assert.equal(store.countInbox(home, ROOT, 'teamlead:group-three'), 0, 'the next read took the address alias slot');
});

test('the child warden knocks once for mail in both slots, and the Stop guard counts both', async () => {
  const engine = store.bus(home, { cli: 'suite' });
  store.upsertParticipant(home, CHILD, store.participantRecord('worker:web', { sessionId: 'web-session' }));
  engine.sendSync(CHILD, { from: 'worker-web', to: ['orchestrator'], type: 'status', body: 'from the child' });
  cli('root-session', 'send', 'teamlead:group-one', '--task', ROOT, '--type', 'status', '--body', 'from the root');
  clock += (KNOCK_RETRY_SEC + 5) * 1000;
  assert.deepEqual(await knocks(ROOT, clock), []);
  assert.deepEqual(await knocks(CHILD, clock), [{ address: 'orchestrator', unread: '2' }]);
  assert.match(guardVerdict(home, CHILD, 'orchestrator', 'lead-session')?.key ?? '', /^mailbox:2/);
  teamleadTools(['promptobus_mailbox', {}]);
  assert.deepEqual(unread(), { root: 0, child: 0 });
  assert.equal(guardVerdict(home, CHILD, 'orchestrator', 'lead-session'), null);
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

test('root mail an earlier version wrote into the child is read in place, and the digest pairs it with the answer in the root', () => {
  const engine = store.bus(home, { cli: 'suite' });
  const legacy = engine.sendSync(CHILD, {
    from: 'root-root', to: ['orchestrator'], type: 'question', body: 'legacy root question', originTask: ROOT,
  });
  const [mailbox, reply] = teamleadTools(
    ['promptobus_mailbox', {}],
    ['promptobus_send', { to: 'root:root', type: 'answer', body: 'legacy answered' }],
  );
  assert.match(mailbox.text, new RegExp(`### question from .* · address root:root · .*\nmessage ${legacy.message.id}`), mailbox.text);
  assert.equal(reply.error, false, reply.text);
  assert.deepEqual(unread(), { root: 0, child: 0 });
  const page = buildDigest(stand, { task: ROOT });
  const open = page.tasks.flatMap((task) => task.questions.map((q) => `${task.id}: ${q.from} → ${q.to}`));
  assert.deepEqual(open.filter((line) => /root:root/.test(line)), [], JSON.stringify(open));
});

test('status and task show the teamlead\'s address alias line and count its mail at the primary address', () => {
  teamleadTools(['promptobus_mailbox', {}]);
  store.sendMessage(home, ROOT, {
    from: 'teamlead:group-two', to: 'teamlead:group-one', type: 'question', body: 'counted where?', session: 'second-lead',
  }, { status: 'promptobus status' });
  const shown = cli('root-session', 'status', '--task', ROOT);
  assert.match(shown.out, new RegExp(`teamlead:group-one · child task ${CHILD}`), shown.out);
  assert.match(shown.out, new RegExp(`address alias of orchestrator of task ${CHILD} · unread 1 here, counted there`), shown.out);
  assert.match(shown.out, new RegExp(`root:root · stands for the orchestrator of root task ${ROOT}`), shown.out);
  const [task] = teamleadTools(['promptobus_task', {}]);
  assert.match(task.text, /your mailbox: unread 1/, task.text);
  assert.match(task.text, /- orchestrator · owner lead-session · .*unread 1/, task.text);
  teamleadTools(['promptobus_mailbox', {}]);
  assert.deepEqual(unread(), { root: 0, child: 0 });
});

test('promptobus_task prints whom the teamlead may write over both its tasks, the root orchestrator as one entry', () => {
  const [task] = teamleadTools(['promptobus_task', {}]);
  const line = task.text.split('\n').find((l) => l.startsWith('you may write: ')) ?? task.text;
  assert.ok(line.startsWith(`you may write: root:root (all seven types) in task ${CHILD} or orchestrator (all seven types) in task ${ROOT}; `), line);
  assert.match(line, new RegExp(`; teamlead:group-two \\(status, question, answer, artifact\\) in task ${ROOT}(;|$)`), line);
});

test('a call as teamlead:<slug> on the root task is gated at the child orchestrator: with no session or a foreign one it gets a copy, and both slots stay unread', () => {
  teamleadTools(['promptobus_mailbox', {}]);
  cli('root-session', 'send', 'teamlead:group-one', '--task', ROOT, '--type', 'status', '--body', 'root slot mail');
  store.bus(home, { cli: 'suite' }).sendSync(CHILD, { from: 'worker-web', to: ['orchestrator'], type: 'status', body: 'child slot mail' });
  for (const session of [null, 'stranger-session']) {
    const [copy] = toolsAs({
      PROMPTOBUS_ROLE: 'teamlead:group-one', PROMPTOBUS_TASK: ROOT, ...(session ? { CLAUDE_CODE_SESSION_ID: session } : {}),
    }, ['promptobus_mailbox', {}]);
    assert.match(copy.text, /root slot mail[\s\S]*child slot mail|child slot mail[\s\S]*root slot mail/, copy.text);
    assert.match(copy.text, new RegExp(`task ${CHILD}`), copy.text);
    assert.deepEqual(unread(), { root: 1, child: 1 }, `${session}: ${copy.text}`);
  }
  teamleadTools(['promptobus_mailbox', {}]);
  assert.deepEqual(unread(), { root: 0, child: 0 });
});

test('a process with no session that declares teamlead:<slug> on the root task does not hand over the teamlead\'s contact point', () => {
  const before = store.readWake(home, CHILD, 'orchestrator');
  const [task] = toolsAs({
    PROMPTOBUS_ROLE: 'teamlead:group-one', PROMPTOBUS_TASK: ROOT,
    CLAUDE_CODE_MESSAGING_SOCKET: path.join(stand, 'intruder.sock'), CLAUDE_CODE_MESSAGING_TOKEN: 'x',
  }, ['promptobus_task', {}]);
  assert.equal(task.error, false, task.text);
  assert.deepEqual(store.readWake(home, CHILD, 'orchestrator'), before);
  assert.equal(store.readWake(home, ROOT, 'teamlead:group-one'), null);
});

test('a Stop guard run with no session as teamlead:<slug> on the root task hands over nothing and marks no turn', () => {
  const before = store.readWake(home, CHILD, 'orchestrator');
  const turned = store.lastTurnAt(home, ROOT, 'teamlead:group-one');
  const ran = spawnSync(process.execPath, [BIN, 'guard'], {
    cwd: stand,
    encoding: 'utf8',
    input: JSON.stringify({
      transcript_path: path.join(stand, 'intruder.jsonl'), cwd: stand, hook_event_name: 'Stop', stop_hook_active: false,
    }),
    env: {
      ...baseEnv(), PROMPTOBUS_ROLE: 'teamlead:group-one', PROMPTOBUS_TASK: ROOT,
      CLAUDE_CODE_MESSAGING_SOCKET: path.join(stand, 'intruder.sock'), CLAUDE_CODE_MESSAGING_TOKEN: 'x',
    },
  });
  assert.deepEqual(store.readWake(home, CHILD, 'orchestrator'), before);
  assert.equal(store.readWake(home, ROOT, 'teamlead:group-one'), null);
  assert.equal(store.lastTurnAt(home, ROOT, 'teamlead:group-one'), turned);
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
});

test('a SessionStart run with no session as teamlead:<slug> on the root task records no transcript for it', () => {
  const ran = spawnSync(process.execPath, [BIN, 'guard'], {
    cwd: stand,
    encoding: 'utf8',
    input: JSON.stringify({ transcript_path: path.join(stand, 'intruder.jsonl'), cwd: stand, hook_event_name: 'SessionStart' }),
    env: { ...baseEnv(), PROMPTOBUS_ROLE: 'teamlead:group-one', PROMPTOBUS_TASK: ROOT },
  });
  assert.equal(store.readTranscript(home, ROOT, 'teamlead:group-one'), null);
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
});

test('a claim that resolves to teamlead:<slug> names the child orchestrator it is an alias of and how to claim it', () => {
  const [reply] = teamleadTools(['promptobus_mailbox', { task: ROOT, claim: true }]);
  assert.match(reply.text, new RegExp(`^teamlead:group-one in task ${ROOT} is an address alias of orchestrator of task ${CHILD}: `
    + `claim that mailbox by naming task ${CHILD} · `), reply.text);
  assert.doesNotMatch(reply.text, /has no owner/, reply.text);
  assert.equal(store.taskOwner(home, ROOT), 'root-session');
});

test('the warden\'s slot view of a root parses each journal once, however often a round asks it', () => {
  const engine = store.bus(home, { cli: 'suite' });
  const read = engine.readTask;
  const parsed = [];
  engine.readTask = (id) => { parsed.push(id); return read.call(engine, id); };
  let records;
  try {
    const slotsOf = store.participantSlots(home, ROOT);
    records = store.readTask(home, ROOT).participants;
    for (const p of records) for (let round = 0; round < 3; round += 1) slotsOf(p);
  } finally {
    engine.readTask = read;
  }
  const times = (id) => parsed.filter((one) => one === id).length;
  assert.equal(times(ROOT), 2, `the view once, the test's own read once: ${parsed.join(', ')}`);
  for (const lead of records.filter((p) => p.role === 'teamlead')) assert.ok(times(lead.metadata.childTask) <= 1, parsed.join(', '));
});

test('after a claim on the child, mail to teamlead:<slug> stays unread in the root slot and is not in the claimant\'s mailbox', () => {
  const fourth = 'group-four-t20261003-130004';
  store.createTask(home, {
    id: fourth, title: 'Group four', owner: 'fourth-lead', parent: ROOT, teamlead: 'teamlead:group-four',
    adapter: { slug: 'group-four' },
  });
  store.sendMessage(home, ROOT, {
    from: 'teamlead:group-one', to: 'teamlead:group-four', type: 'status', body: 'before the claim', session: 'lead-session',
  }, { status: 'promptobus status' });
  store.claimOwnership(home, fourth, 'claimant-session');
  cli('root-session', 'send', 'teamlead:group-four', '--task', ROOT, '--type', 'status', '--body', 'after the claim');
  assert.equal(store.mailboxOf(home, ROOT, 'teamlead:group-four').alias, false);
  const ran = spawnSync(process.execPath, [BIN, 'mcp'], {
    cwd: stand, encoding: 'utf8',
    env: { ...baseEnv(), PROMPTOBUS_ROLE: 'orchestrator', PROMPTOBUS_TASK: fourth, CLAUDE_CODE_SESSION_ID: 'claimant-session' },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'promptobus_mailbox', arguments: {} } })}\n`,
  });
  const reply = JSON.parse(ran.stdout.split('\n')[0]).result.content[0].text;
  assert.match(reply, /^empty/, reply);
  assert.equal(store.countInbox(home, ROOT, 'teamlead:group-four'), 2, 'both stay in the root slot');
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

test('pruning a closed child removes its slot; the root slot stays until the root is pruned', () => {
  const root = 'aged-root-t20250101-000000';
  const child = 'aged-child-t20250101-000001';
  store.createTask(home, { id: root, title: 'Aged root', owner: 'aged-root', adapter: { slug: 'aged' } });
  store.createTask(home, {
    id: child, title: 'Aged child', owner: 'aged-lead', parent: root, teamlead: 'teamlead:aged',
    adapter: { slug: 'aged-child' },
  });
  const engine = store.bus(home, { cli: 'suite' });
  engine.sendSync(root, { from: 'orchestrator', to: ['teamlead-aged'], type: 'status', body: 'root slot' });
  engine.sendSync(child, { from: 'orchestrator', to: ['orchestrator'], type: 'status', body: 'child slot' });
  const old = { closed: '2025-01-02T00:00:00.000Z' };
  store.closeTask(home, child);
  store.patchTask(home, child, { adapter: { ...store.readTask(home, child).adapter, ...old } });
  const others = () => store.listTasks(home).filter((t) => [root, child].includes(t.id));
  sweepJournals(home, 14, { tasks: others() });
  assert.equal(store.taskExists(home, child), false, 'the child journal and its slot left');
  assert.equal(store.countInbox(home, root, 'teamlead:aged'), 1, 'the root slot stays with the root journal');
  store.closeTask(home, root);
  store.patchTask(home, root, { adapter: { ...store.readTask(home, root).adapter, ...old } });
  sweepJournals(home, 14, { tasks: others() });
  assert.equal(store.taskExists(home, root), false, 'the root slot left with the root journal');
});

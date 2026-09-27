import './home.mjs';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';
import { hostOf } from '../lib/host.js';
import { runPromptobus } from '../lib/cli.js';
import { status } from '../lib/status.js';
import { serviceFor } from '../lib/server.js';
import { prune } from '../lib/prune.js';
import * as store from '../lib/store.js';
import { writeTask } from '../dist/v1/store.js';

function interruptAfterFirstWrite() {
  let writes = 0;
  return (home, meta, now) => {
    const saved = writeTask(home, meta, now);
    if (++writes === 1) throw new Error('interrupted after first journal write');
    return saved;
  };
}

function fixture() {
  const root = makeSandbox('promptobus-link-');
  const home = path.join(root, '.promptobus');
  writeHostConfig(root);
  const host = hostOf(root);
  store.bus(home, { cli: host.version });
  const a = 'alpha-t20260926-120000';
  const b = 'beta-t20260926-120000';
  store.createTask(home, { id: a, title: 'alpha', owner: 'owner-a', adapter: { slug: 'alpha' } });
  store.createTask(home, { id: b, title: 'beta', owner: 'owner-b', adapter: { slug: 'beta' } });
  const call = (session, argv) => runPromptobus(argv, {
    host, cwd: root, env: {
      PROMPTOBUS_HOME: home, PROMPTOBUS_WARDEN: 'off', CLAUDE_CODE_SESSION_ID: session,
    },
  });
  const run = (session, argv) => capture(() => call(session, argv));
  const refuse = (session, argv) => expectFail(() => call(session, argv));
  const journals = (taskId) => {
    const dir = path.join(home, 'tasks', taskId, 'messages');
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).length : 0;
  };
  return { root, home, host, a, b, run, refuse, journals };
}

test('peer records bind to the other root owner session', () => {
  const { home, a, b } = fixture();
  store.changePeerLink(home, a, b, { session: 'owner-a' });
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:beta').metadata.sessionId, 'owner-b');
  assert.equal(store.participantOf(store.readTask(home, b), 'peer:alpha').metadata.sessionId, 'owner-a');
});

test('link delivers a peer question into the other root and unlink keeps both journals', async () => {
  const { home, host, a, b, run, refuse, journals } = fixture();
  const before = await refuse('owner-a', ['send', 'orchestrator', '--task', b, '--type', 'question', '--body', 'before']);
  assert.equal(before.failed, true);
  assert.match(before.out, /belongs to session owner-b/);

  const linked = await run('owner-a', ['link', a, b]);
  assert.match(linked, /linked alpha.*peer:beta.*beta.*peer:alpha/);
  const peerA = store.participantOf(store.readTask(home, a), 'peer:beta');
  const peerB = store.participantOf(store.readTask(home, b), 'peer:alpha');
  assert.deepEqual([peerA.metadata.peerTask, peerA.metadata.sessionId], [b, 'owner-b']);
  assert.deepEqual([peerB.metadata.peerTask, peerB.metadata.sessionId], [a, 'owner-a']);
  const printed = await capture(() => status(host, { task: a, sessions: {} }));
  assert.match(printed, new RegExp(`peer:beta · peer task ${b}`));

  const sent = await run('owner-a', ['send', 'peer:beta', '--task', a, '--type', 'question', '--body', 'hello beta']);
  assert.match(sent, new RegExp(`task ${b} .*via peer:beta of task ${a}`));
  const incomingB = store.readInbox(home, b, 'orchestrator').messages;
  assert.equal(incomingB.length, 1);
  assert.deepEqual([incomingB[0].sender, incomingB[0].body], ['peer-alpha', 'hello beta']);
  assert.equal(journals(a), 0);
  assert.equal(journals(b), 1);

  const assignment = await refuse('owner-a', ['send', 'peer:beta', '--task', a, '--type', 'task', '--body', 'do this']);
  assert.equal(assignment.failed, true);
  assert.match(assignment.out, /peers exchange only question, answer, status or artifact/);
  assert.equal(journals(b), 1);

  await run('owner-b', ['send', 'peer:alpha', '--task', b, '--type', 'answer', '--body', 'hello alpha']);
  const incomingA = store.readInbox(home, a, 'orchestrator').messages;
  assert.deepEqual([incomingA.length, incomingA[0].sender, incomingA[0].body], [1, 'peer-beta', 'hello alpha']);
  const kept = [journals(a), journals(b)];
  await run('owner-b', ['unlink', a, b]);
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:beta'), null);
  assert.equal(store.participantOf(store.readTask(home, b), 'peer:alpha'), null);
  assert.deepEqual([journals(a), journals(b)], kept);
  const after = await refuse('owner-a', ['send', 'peer:beta', '--task', a, '--type', 'question', '--body', 'after']);
  assert.equal(after.failed, true);
  assert.deepEqual([journals(a), journals(b)], kept);
});

test('link refuses a stranger and a child before either root gains a peer', async () => {
  const { home, a, b, run, refuse } = fixture();
  const stranger = await refuse('stranger', ['link', a, b]);
  assert.equal(stranger.failed, true);
  assert.match(stranger.out, /require the owner of one named task/);
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:beta'), null);
  const child = 'child-t20260926-120000';
  store.createTask(home, {
    id: child, title: 'child', owner: 'lead', parent: a, teamlead: 'teamlead:child', adapter: { slug: 'child' },
  });
  const refusedChild = await refuse('owner-a', ['link', a, child]);
  assert.equal(refusedChild.failed, true);
  assert.match(refusedChild.out, /only root tasks can be peers/);
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:child'), null);
  await run('owner-a', ['link', a, b]);
  const strangerUnlink = await refuse('stranger', ['unlink', a, b]);
  assert.equal(strangerUnlink.failed, true);
  assert.ok(store.participantOf(store.readTask(home, a), 'peer:beta'));
});

test('a half-written link refuses both peer routes and a retry restores the pair', async () => {
  const { home, a, b, run, refuse, journals } = fixture();
  assert.throws(() => store.changePeerLink(home, a, b, {
    session: 'owner-a', write: interruptAfterFirstWrite(),
  }), /interrupted after first journal write/);
  assert.ok(store.participantOf(store.readTask(home, a), 'peer:beta'));
  assert.equal(store.participantOf(store.readTask(home, b), 'peer:alpha'), null);
  for (const [session, task, peer] of [['owner-a', a, 'peer:beta'], ['owner-b', b, 'peer:alpha']]) {
    const blocked = await refuse(session, ['send', peer, '--task', task, '--type', 'question', '--body', 'half link']);
    assert.equal(blocked.failed, true);
  }
  assert.deepEqual([journals(a), journals(b)], [0, 0]);
  await run('owner-b', ['link', a, b]);
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:beta').metadata.peerTask, b);
  assert.equal(store.participantOf(store.readTask(home, b), 'peer:alpha').metadata.peerTask, a);
  await run('owner-a', ['send', 'peer:beta', '--task', a, '--type', 'question', '--body', 'recovered']);
  assert.deepEqual([journals(a), journals(b)], [0, 1]);
});

test('a half-written unlink refuses both peer routes and a retry keeps earlier mail', async () => {
  const { home, a, b, run, refuse, journals } = fixture();
  await run('owner-a', ['link', a, b]);
  await run('owner-a', ['send', 'peer:beta', '--task', a, '--type', 'question', '--body', 'before unlink']);
  await run('owner-b', ['send', 'peer:alpha', '--task', b, '--type', 'answer', '--body', 'before unlink']);
  const kept = [journals(a), journals(b)];
  assert.throws(() => store.changePeerLink(home, a, b, {
    session: 'owner-b', unlink: true, write: interruptAfterFirstWrite(),
  }), /interrupted after first journal write/);
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:beta'), null);
  assert.ok(store.participantOf(store.readTask(home, b), 'peer:alpha'));
  for (const [session, task, peer] of [['owner-a', a, 'peer:beta'], ['owner-b', b, 'peer:alpha']]) {
    const blocked = await refuse(session, ['send', peer, '--task', task, '--type', 'question', '--body', 'half unlink']);
    assert.equal(blocked.failed, true);
  }
  assert.deepEqual([journals(a), journals(b)], kept);
  await run('owner-a', ['unlink', a, b]);
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:beta'), null);
  assert.equal(store.participantOf(store.readTask(home, b), 'peer:alpha'), null);
  assert.deepEqual([journals(a), journals(b)], kept);
});

test('unlink clears a pruned peer record before a replacement root reuses its slug', async () => {
  const { home, host, a, b, run, refuse, journals } = fixture();
  await run('owner-a', ['link', a, b]);
  await run('owner-b', ['send', 'peer:alpha', '--task', b, '--type', 'answer', '--body', 'kept']);
  const kept = journals(a);
  store.closeTask(home, b);
  store.patchTask(home, b, { adapter: { closed: '2000-01-01T00:00:00.000Z' } });
  await capture(() => prune(host, { olderThan: 0, yes: true }));
  assert.equal(store.taskExists(home, b), false);
  const wrong = await refuse('owner-a', ['unlink', a, 'missing-t20260926-130000']);
  assert.equal(wrong.failed, true);
  assert.match(wrong.out, /no unique peer record for missing task/);
  const stranger = await refuse('stranger', ['unlink', a, b]);
  assert.equal(stranger.failed, true);
  assert.match(stranger.out, /require the owner of one named task/);
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:beta').metadata.peerTask, b);
  await run('owner-a', ['unlink', a, b]);
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:beta'), null);
  assert.equal(journals(a), kept);
  const replacement = 'beta-t20260926-130000';
  store.createTask(home, { id: replacement, title: 'new beta', owner: 'owner-c', adapter: { slug: 'beta' } });
  await run('owner-a', ['link', a, replacement]);
  assert.equal(store.participantOf(store.readTask(home, a), 'peer:beta').metadata.peerTask, replacement);
  assert.equal(store.participantOf(store.readTask(home, replacement), 'peer:alpha').metadata.peerTask, a);
  assert.equal(journals(a), kept);
});

test('peer artifact lands in the destination task files', async () => {
  const { root, home, a, b, run } = fixture();
  await run('owner-a', ['link', a, b]);
  const file = path.join(root, 'peer-note.txt');
  writeFileSync(file, 'peer note\n');
  await run('owner-a', ['send', 'peer:beta', '--task', a, '--type', 'artifact', '--body', 'the note', '--artifact', file]);
  const incoming = store.readInbox(home, b, 'orchestrator').messages;
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].sender, 'peer-alpha');
  assert.equal(incoming[0].type, 'artifact');
  assert.ok(readdirSync(path.join(home, 'tasks', b, 'files')).includes('peer-note.txt'));
});

test('the MCP send service uses the destination journal and the source owner proof', async () => {
  const { home, host, a, b, run, journals } = fixture();
  await run('owner-a', ['link', a, b]);
  const service = serviceFor(host);
  const outgoing = { from: 'orchestrator', to: 'peer:beta', type: 'status', body: 'MCP status' };
  assert.throws(() => service.send(home, a, { ...outgoing, session: 'stranger' }), /recorded orchestrator owner session/);
  const sent = service.send(home, a, { ...outgoing, session: 'owner-a' });
  assert.equal(sent.deliveredTask, b);
  assert.equal(journals(a), 0);
  assert.equal(journals(b), 1);
  const incoming = store.readInbox(home, b, 'orchestrator').messages;
  assert.deepEqual([incoming[0].sender, incoming[0].body], ['peer-alpha', 'MCP status']);
});

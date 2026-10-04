// Whom each participant may write: every sender and recipient role of the registry, one test per
// pair, against a table written from 04-protocol § Addresses — not computed from the policy.
import './home.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeSandbox } from './sandbox.mjs';
import * as store from '../lib/store.js';

const stand = makeSandbox('promptobus-contact-list-');
const home = path.join(stand, '.promptobus');
store.bus(home, { cli: 'suite' });
const artifactPath = path.join(stand, 'contact.txt');
writeFileSync(artifactPath, 'contact evidence\n');
const HINTS = { status: 'promptobus status' };

const ROOT = 'root-r-t20261004-120000';
const PEER = 'root-p-t20261004-120000';
const CHILD = 'alpha-t20261004-120001';
const SIBLING = 'beta-t20261004-120002';
store.createTask(home, { id: ROOT, title: 'Root', owner: 'owner-r', adapter: { slug: 'root-r' } });
store.createTask(home, { id: PEER, title: 'Peer', owner: 'owner-p', adapter: { slug: 'root-p' } });
store.createTask(home, {
  id: CHILD, title: 'Alpha', owner: 'lead-a', parent: ROOT, teamlead: 'teamlead:alpha', adapter: { slug: 'alpha' },
});
store.createTask(home, {
  id: SIBLING, title: 'Beta', owner: 'lead-b', parent: ROOT, teamlead: 'teamlead:beta', adapter: { slug: 'beta' },
});
store.ensureRootRecord(home, CHILD);
store.upsertParticipant(home, ROOT, store.participantRecord('peer:root-p', { peerTask: PEER, sessionId: 'owner-p' }));
store.upsertParticipant(home, PEER, store.participantRecord('peer:root-r', { peerTask: ROOT, sessionId: 'owner-r' }));
store.upsertParticipant(home, ROOT, store.participantRecord('reporter'));
for (const task of [ROOT, CHILD]) {
  store.upsertParticipant(home, task, store.participantRecord('user'));
  for (const step of ['worker', 'reviewer', 'approver']) {
    store.upsertParticipant(home, task, store.participantRecord(`${step}:w`, { sessionId: `${step}-${task}` }));
  }
}

const SESSION = {
  [ROOT]: { orchestrator: 'owner-r', 'teamlead:alpha': 'lead-a', 'teamlead:beta': 'lead-b', 'peer:root-p': 'owner-p' },
  [CHILD]: { orchestrator: 'lead-a' },
};
const sessionOf = (task, address) => SESSION[task][address] ?? (address.endsWith(':w') ? `${address.split(':')[0]}-${task}` : null);

const ALL = store.MESSAGE_TYPES;
const FOUR = ['question', 'answer', 'status', 'artifact'];
const Q = ['question'];
const AS = ['answer', 'status'];
const NO = [];

// 04-protocol § Addresses, read row by row. Each row is a sender; the columns follow `of`.
const TABLE = {
  [ROOT]: {
    of: ['orchestrator', 'teamlead:alpha', 'teamlead:beta', 'peer:root-p', 'reporter', 'user', 'worker:w', 'reviewer:w', 'approver:w'],
    orchestrator: [null, ALL, ALL, FOUR, ALL, AS, ALL, ALL, ALL],
    'teamlead:alpha': [ALL, null, FOUR, NO, NO, NO, NO, NO, NO],
    'teamlead:beta': [ALL, FOUR, null, NO, NO, NO, NO, NO, NO],
    'peer:root-p': [FOUR, NO, NO, null, NO, NO, NO, NO, NO],
    reporter: [NO, NO, NO, NO, null, NO, NO, NO, NO],
    user: [Q, NO, NO, NO, NO, null, NO, NO, NO],
    'worker:w': [ALL, NO, NO, NO, NO, NO, null, NO, ALL],
    'reviewer:w': [ALL, NO, NO, NO, NO, NO, NO, null, NO],
    'approver:w': [ALL, NO, NO, NO, NO, NO, ALL, NO, null],
  },
  [CHILD]: {
    of: ['orchestrator', 'root:root-r', 'user', 'worker:w', 'reviewer:w', 'approver:w'],
    orchestrator: [null, ALL, AS, ALL, ALL, ALL],
    'root:root-r': [ALL, null, NO, NO, NO, NO],
    user: [Q, NO, null, NO, NO, NO],
    'worker:w': [ALL, NO, NO, null, NO, ALL],
    'reviewer:w': [ALL, NO, NO, NO, null, NO],
    'approver:w': [ALL, NO, NO, ALL, NO, null],
  },
};

// The allowed cells of one row, as routes in the list's own words.
function row(task, sender) {
  const { of, [sender]: cells } = TABLE[task];
  return of.map((address, i) => ({ address, task, types: cells[i] ?? NO })).filter((cell) => cell.types.length);
}
const said = ({ address, task, types }) => {
  const named = types.length === ALL.length ? 'all seven types' : ALL.filter((t) => types.includes(t)).join(', ');
  return `${address} (${named}) in task ${task}`;
};
// The teamlead's two addresses are one mailbox: its child and root rows, the two routes to the root
// orchestrator as one entry, the child slot first.
function teamleadLine() {
  const [toRoot, ...child] = row(CHILD, 'orchestrator');
  const [toRootOrchestrator, ...root] = row(ROOT, 'teamlead:alpha');
  return [`${said(toRoot)} or ${said(toRootOrchestrator)}`, ...child.map(said), ...root.map(said)].join('; ');
}
function expectedLine(task, sender) {
  if ((task === CHILD && sender === 'orchestrator') || (task === ROOT && sender === 'teamlead:alpha')) return teamleadLine();
  return row(task, sender).map(said).join('; ') || 'nobody';
}

function send(task, from, to, type) {
  return store.sendMessage(home, task, {
    from, to, type, body: `${from} to ${to}: ${type}`, session: sessionOf(task, from),
    ...(type === 'artifact' ? { artifactPath } : {}),
  }, HINTS);
}

for (const task of [ROOT, CHILD]) {
  const { of } = TABLE[task];
  for (const sender of of) {
    for (const [i, recipient] of of.entries()) {
      if (recipient === sender) continue;
      const allowed = TABLE[task][sender][i];
      test(`${sender} → ${recipient} in the ${task === ROOT ? 'root' : 'child'} task: ${allowed.length ? allowed.join(', ') : 'nothing'}`, () => {
        for (const type of ALL) {
          if (allowed.includes(type)) {
            const sent = send(task, sender, recipient, type);
            assert.equal(sent.message.type, type);
            if (!sent.deliveredTask) assert.deepEqual(sent.message.recipients, [store.addrDir(recipient)]);
            continue;
          }
          assert.throws(() => send(task, sender, recipient, type), (e) => {
            assert.match(e.message, new RegExp(`route through the root orchestrator of task ${ROOT}`));
            assert.ok(e.message.endsWith(` · you may write: ${expectedLine(task, sender)}`), e.message);
            return true;
          }, `${type} was delivered`);
        }
      });
    }
  }
}

test('contactsOf names exactly the allowed cells of every sender\'s rows', () => {
  for (const task of [ROOT, CHILD]) {
    for (const sender of TABLE[task].of) {
      const listed = store.contactsOf(home, task, sender).map(store.contactText).join('; ') || 'nobody';
      assert.equal(listed, expectedLine(task, sender), `${sender} in ${task}`);
    }
  }
});

test('a recipient the task does not list is refused with the sender\'s list', () => {
  assert.throws(() => send(ROOT, 'worker:w', 'worker:nobody', 'status'),
    (e) => e.message.endsWith(` · you may write: ${expectedLine(ROOT, 'worker:w')}`) || assert.fail(e.message));
});

test('a lift states its list before its records exist, its own binding taken as held', () => {
  const childTask = 'gamma-t20261004-120003';
  const seats = [
    { meta: { id: childTask, parent: ROOT, participants: [store.participantRecord('orchestrator'),
      store.participantRecord('root:root-r', { rootTask: ROOT })] }, sender: store.participantRecord('orchestrator') },
    { meta: store.readTask(home, ROOT), sender: store.participantRecord('teamlead:gamma', { childTask }) },
  ];
  const listed = store.contactsOf(home, childTask, 'orchestrator', { seats }).map(store.contactText);
  assert.deepEqual(listed, [
    `root:root-r (all seven types) in task ${childTask} or orchestrator (all seven types) in task ${ROOT}`,
    `teamlead:alpha (status, question, answer, artifact) in task ${ROOT}`,
    `teamlead:beta (status, question, answer, artifact) in task ${ROOT}`,
  ]);
});

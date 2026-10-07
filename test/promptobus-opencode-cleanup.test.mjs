// Participant cleanup through the public sweep and closed-task done, with dummy holders.
import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';
import * as store from '../lib/store.js';
import { createRegistry } from '../dist/index.js';
import { opencodeDriver, registrySessionKey } from '../lib/driver-opencode.js';
import { pidAlive, reapHolder } from '../lib/opencode-session.js';
import { sweep } from '../lib/sweep.js';
import { done } from '../lib/done.js';

const SB = makeSandbox('promptobus-driver-opencode-cleanup-');
writeHostConfig(SB);
const HOME = path.join(SB, '.promptobus');
process.env.PROMPTOBUS_OPENCODE_HOME = path.join(SB, 'opencode-state');
const sessions = path.join(process.env.PROMPTOBUS_OPENCODE_HOME, 'sessions');
mkdirSync(sessions, { recursive: true });
const TASK = 'opencode-cleanup-t20261006-140000';
const OTHER = 'opencode-cleanup-other-t20261006-140000';
const OWNER = 'cleanup-owner';
store.bindSessionIdentity(() => ({ id: OWNER }));
store.createTask(HOME, { id: TASK, title: 'participant cleanup', owner: OWNER });
store.createTask(HOME, { id: OTHER, title: 'another task', owner: OWNER });

const deleted = [];
const server = createServer((req, res) => {
  if (req.method === 'DELETE') deleted.push(req.url);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const children = [];
async function holder() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore',
  });
  children.push(child);
  await once(child, 'spawn');
  return child;
}
function fixture(task, address, child, session) {
  const ref = `${task}:${address}`;
  const record = store.participantSessionPath(HOME, task, address);
  const log = `${record}.holder.log`;
  const registry = path.join(sessions, `${registrySessionKey(ref)}.json`);
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ holderPid: child.pid, url, sessionId: session, password: 'fixture', log }));
  writeFileSync(log, `${address} holder log\n`);
  writeFileSync(registry, JSON.stringify({ ref, task, address, recordPath: record }));
  const participant = store.participantRecord(address, { harness: 'opencode', sessionRef: ref });
  store.upsertParticipant(HOME, task, participant);
  return { participant, child, record, log, registry, session };
}
const files = (f) => [f.record, f.log, f.registry];
const snapshot = (f) => files(f).map((p) => readFileSync(p, 'utf8'));
const preserved = (f, before) => pidAlive(f.child.pid)
  && files(f).every((p, i) => existsSync(p) && readFileSync(p, 'utf8') === before[i]);
const removed = (f) => !pidAlive(f.child.pid) && files(f).every((p) => !existsSync(p));
const pending = [];
const registry = createRegistry({ drivers: { opencode: {
  ...opencodeDriver,
  sweepParticipant: (...args) => {
    const promise = opencodeDriver.sweepParticipant(...args);
    pending.push(promise);
    return promise;
  },
} }, fallback: 'opencode' });

const driverDoc = readFileSync(new URL('../docs/reference/05-drivers.md', import.meta.url), 'utf8');
const cliDoc = readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
check(': opencode cleanup documentation names participant scope and awaited closed-task cleanup',
  driverDoc.includes('registry records matching both task and\nparticipant address')
  && cliDoc.includes('matches both task and participant address and preserves live peers')
  && readme.includes('`done` awaits each dead participant\'s cleanup'), 'cleanup contract drift');
check(': cleanup documentation retains a later pass for reviewers without a worktree',
  driverDoc.includes('keep the sweep pending, even without a worktree')
  && cliDoc.includes('keep the sweep pending, even without a worktree')
  && readme.includes('keep the sweep pending, even without a worktree'), 'pending cleanup contract drift');

try {
  const acceptedChild = await holder();
  const exited = once(acceptedChild, 'exit');
  await reapHolder(acceptedChild.pid);
  await exited;
  const accepted = fixture(TASK, 'worker:accepted', acceptedChild, 'accepted');
  const peer = fixture(TASK, 'worker:peer', await holder(), 'peer');
  const other = fixture(OTHER, 'worker:accepted', await holder(), 'other');
  const peerBefore = snapshot(peer);
  const otherBefore = snapshot(other);
  check(': cleanup fixture has live same-task and other-task holders',
    pidAlive(peer.child.pid) && pidAlive(other.child.pid), 'dummy holder liveness');

  await capture(async () => sweep(SB, { task: TASK, address: 'worker:accepted' }, { registry }));
  await Promise.all(pending.splice(0));
  check(': public opencode sweep removes only the selected dead participant',
    removed(accepted) && deleted.join(',') === '/api/session/accepted', JSON.stringify(deleted));
  check(': public opencode sweep preserves the live same-task peer holder and all files',
    preserved(peer, peerBefore), 'peer holder, registry, record or log changed');
  check(': public opencode sweep preserves another task with the same participant address',
    preserved(other, otherBefore) && store.readTask(HOME, TASK).status === 'active', 'other task changed');
  const repeated = await opencodeDriver.sweepParticipant(accepted.participant, TASK);
  check(': repeated opencode participant cleanup is idempotent and preserves peers',
    repeated.swept === 0 && preserved(peer, peerBefore) && preserved(other, otherBefore), JSON.stringify(repeated));
  const unnamed = await opencodeDriver.sweepParticipant({ metadata: {} }, TASK);
  const wrongTask = await opencodeDriver.sweepParticipant(peer.participant, OTHER);
  check(': opencode cleanup requires both a named participant and its task',
    unnamed.swept === 0 && wrongTask.swept === 0 && preserved(peer, peerBefore)
    && preserved(other, otherBefore), JSON.stringify({ unnamed, wrongTask }));

  const remaining = fixture(TASK, 'reviewer:remaining', await holder(), 'remaining');
  const endedSessions = (participants) => Object.fromEntries(participants.map((p) => [
    store.addressOf(p), { state: 'gone', busy: false, stall: null, id: p.sessionRef },
  ]));
  await capture(async () => done(SB, { task: TASK, 'keep-sessions': true, snapshot: endedSessions }));
  check(': closed-task opencode cleanup completes for every participant before done returns',
    removed(peer) && removed(remaining) && store.readTask(HOME, TASK).status === 'done',
    JSON.stringify({ peer: removed(peer), remaining: removed(remaining) }));
  check(': closed-task opencode cleanup preserves other-task holder and all files',
    preserved(other, otherBefore) && deleted.slice().sort().join(',')
      === '/api/session/accepted,/api/session/peer,/api/session/remaining', JSON.stringify(deleted));
  await capture(async () => done(SB, { task: TASK, 'keep-sessions': true, snapshot: endedSessions }));
  check(': repeated closed-task opencode cleanup leaves other tasks untouched',
    preserved(other, otherBefore) && deleted.length === 3, JSON.stringify(deleted));

  for (const state of ['alive', 'unknown']) {
    const task = `opencode-retained-${state}-t20261006-140000`;
    store.createTask(HOME, { id: task, title: 'retained reviewer cleanup', owner: OWNER });
    const deadChild = await holder();
    const deadExit = once(deadChild, 'exit');
    await reapHolder(deadChild.pid);
    await deadExit;
    const worker = fixture(task, 'worker:finished', deadChild, `finished-${state}`);
    const reviewer = fixture(task, 'reviewer:retained', await holder(), `retained-${state}`);
    const reviewerBefore = snapshot(reviewer);
    const deletionsBefore = deleted.length;
    const retainedSessions = (participants) => Object.fromEntries(participants.map((p) => [
      store.addressOf(p), {
        state: p.sessionRef === reviewer.participant.sessionRef ? state : 'gone',
        busy: false, stall: null, id: p.sessionRef,
      },
    ]));
    check(`: ${state} reviewer cleanup fixture has no worktree and a dead worker`,
      !reviewer.participant.metadata.worktree && !worker.participant.metadata.worktree
      && !pidAlive(worker.child.pid) && pidAlive(reviewer.child.pid), 'fixture ownership or liveness');
    await capture(async () => done(SB, { task, 'keep-sessions': true, snapshot: retainedSessions }));
    check(`: first done preserves ${state} reviewer and keeps harness cleanup pending`,
      store.readTask(HOME, task).status === 'done' && !store.readTask(HOME, task).adapter.worktreesSwept
      && removed(worker) && preserved(reviewer, reviewerBefore) && preserved(other, otherBefore)
      && deleted.slice(deletionsBefore).join(',') === `/api/session/finished-${state}`,
      JSON.stringify({ adapter: store.readTask(HOME, task).adapter, deleted }));

    await capture(async () => done(SB, { task, 'keep-sessions': true, snapshot: endedSessions }));
    check(`: second done removes the now-gone ${state} reviewer holder and all files`,
      removed(reviewer) && Boolean(store.readTask(HOME, task).adapter.worktreesSwept)
      && preserved(other, otherBefore) && deleted.slice(deletionsBefore).join(',')
        === `/api/session/finished-${state},/api/session/retained-${state}`,
      JSON.stringify({ holderAlive: pidAlive(reviewer.child.pid), files: files(reviewer).map(existsSync), deleted }));
    await capture(async () => done(SB, { task, 'keep-sessions': true, snapshot: endedSessions }));
    check(`: repeated done after ${state} reviewer cleanup preserves other-task live peers`,
      removed(worker) && removed(reviewer) && preserved(other, otherBefore)
      && deleted.length === deletionsBefore + 2, JSON.stringify(deleted));
  }
} finally {
  for (const child of children) await reapHolder(child.pid);
  await new Promise((resolve) => server.close(resolve));
}

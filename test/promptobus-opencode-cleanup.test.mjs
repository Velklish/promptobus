// Participant cleanup through the public sweep and closed-task done, with dummy holders.
import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';
import * as store from '../lib/store.js';
import { createRegistry } from '../dist/index.js';
import { opencodeDriver, registrySessionKey } from '../lib/driver-opencode.js';
import { pidAlive, reapHolder } from '../lib/opencode-session.js';
import { processIdentity } from '../lib/service-state.js';
import { sweep } from '../lib/sweep.js';
import { done } from '../lib/done.js';
import { waitFor } from './harness.mjs';

const SB = makeSandbox('promptobus-driver-opencode-cleanup-');
writeHostConfig(SB);
const HOME = store.canonicalPath(path.join(SB, '.promptobus'));
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
  child.ownedIdentity = processIdentity(child.pid);
  return child;
}
function fixture(task, address, child, session) {
  const ref = `${task}:${address}`;
  const record = store.participantSessionPath(HOME, task, address);
  const log = `${record}.holder.log`;
  const registry = path.join(sessions, `${registrySessionKey(ref)}.json`);
  mkdirSync(path.dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify({ home: HOME, task, address, holderPid: child.pid, holderProcess: child.ownedIdentity,
    url, sessionId: session, password: 'fixture', log }), { mode: 0o600 });
  writeFileSync(log, `${address} holder log\n`);
  writeFileSync(registry, JSON.stringify({ ref, task, address, recordPath: record, sessionId: session }), { mode: 0o600 });
  const participant = store.participantRecord(address, { harness: 'opencode', sessionRef: ref, sessionId: session });
  store.upsertParticipant(HOME, task, participant);
  return { participant, child, record, log, registry, session };
}
const files = (f) => [f.record, f.log, f.registry];
const snapshot = (f) => files(f).map((p) => readFileSync(p, 'utf8'));
const preserved = (f, before) => pidAlive(f.child.pid)
  && files(f).every((p, i) => existsSync(p) && readFileSync(p, 'utf8') === before[i]);
const removed = (f) => !pidAlive(f.child.pid) && files(f).every((p) => !existsSync(p));
const registry = createRegistry({ drivers: { opencode: opencodeDriver }, fallback: 'opencode' });

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
  await reapHolder(acceptedChild.pid, { identity: acceptedChild.ownedIdentity });
  await exited;
  const accepted = fixture(TASK, 'worker:accepted', acceptedChild, 'accepted');
  const peer = fixture(TASK, 'worker:peer', await holder(), 'peer');
  const other = fixture(OTHER, 'worker:accepted', await holder(), 'other');
  const peerBefore = snapshot(peer);
  const otherBefore = snapshot(other);
  check(': cleanup fixture has live same-task and other-task holders',
    pidAlive(peer.child.pid) && pidAlive(other.child.pid), 'dummy holder liveness');

  const acceptedBefore = snapshot(accepted);
  let unrelatedBorrow, unborrowed;
  await store.withTaskLockAsync(HOME, TASK, async () => {
    try {
      await opencodeDriver.sweepParticipant(accepted.participant, TASK, undefined, { home: `${HOME}-foreign`, task: TASK, taskLocked: true });
    } catch (error) { unrelatedBorrow = error; }
    try { await opencodeDriver.sweepParticipant(accepted.participant, TASK); }
    catch (error) { unborrowed = error; }
  });
  check(': a foreign private lock context cannot borrow the held async task lock or bypass its self-refusal',
    /belongs to another task scope/.test(unrelatedBorrow?.message ?? '')
      && /asynchronous.*synchronous/.test(unborrowed?.message ?? '') && deleted.length === 0
      && files(accepted).every((file, i) => existsSync(file) && readFileSync(file, 'utf8') === acceptedBefore[i]), unrelatedBorrow?.stack);

  await capture(async () => sweep(SB, { task: TASK, address: 'worker:accepted' }, { registry }));
  check(': public opencode sweep completes its harness cleanup before returning',
    removed(accepted), 'holder cleanup was pending on return');
  check(': public opencode sweep removes only the selected dead participant',
    removed(accepted) && deleted.join(',') === '/api/session/accepted', JSON.stringify(deleted));
  check(': public opencode sweep preserves the live same-task peer holder and all files',
    preserved(peer, peerBefore), 'peer holder, registry, record or log changed');
  check(': public opencode sweep preserves another task with the same participant address',
    preserved(other, otherBefore) && store.readTask(HOME, TASK).status === 'active', 'other task changed');
  const repeated = await opencodeDriver.sweepParticipant(accepted.participant, TASK, undefined, { home: HOME, task: TASK });
  check(': repeated opencode participant cleanup is idempotent and preserves peers',
    repeated.swept === 0 && preserved(peer, peerBefore) && preserved(other, otherBefore), JSON.stringify(repeated));
  const unnamed = await opencodeDriver.sweepParticipant({ metadata: {} }, TASK);
  let wrongTask;
  try { await opencodeDriver.sweepParticipant(peer.participant, OTHER, undefined, { home: HOME, task: OTHER }); }
  catch (error) { wrongTask = error; }
  check(': opencode cleanup requires both a named participant and its task',
    unnamed.swept === 0 && /selected participant changed/.test(wrongTask?.message ?? '') && preserved(peer, peerBefore)
    && preserved(other, otherBefore), JSON.stringify({ unnamed, wrongTask }));

  const remaining = fixture(TASK, 'reviewer:remaining', await holder(), 'remaining');
  const endedSessions = (participants) => Object.fromEntries(participants.map((p) => [
    store.addressOf(p), { state: 'gone', busy: false, stall: null, id: p.sessionRef },
  ]));
  await capture(async () => done(SB, { task: TASK, 'keep-sessions': true, snapshot: endedSessions }));
  await waitFor(() => !pidAlive(peer.child.pid) && !pidAlive(remaining.child.pid), { timeoutMs: 5000 });
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
    await reapHolder(deadChild.pid, { identity: deadChild.ownedIdentity });
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
    await capture(async () => done(SB, { task, 'keep-sessions': true, snapshot: retainedSessions, 'older-than': 0, yes: true }));
    check(`: first done preserves ${state} reviewer and keeps harness cleanup pending`,
      store.readTask(HOME, task).status === 'done' && !store.readTask(HOME, task).adapter.worktreesSwept
      && removed(worker) && preserved(reviewer, reviewerBefore) && preserved(other, otherBefore)
      && deleted.slice(deletionsBefore).join(',') === `/api/session/finished-${state}`,
      JSON.stringify({ adapter: store.readTask(HOME, task).adapter, deleted }));

    await capture(async () => done(SB, { task, 'keep-sessions': true, snapshot: endedSessions }));
    await waitFor(() => !pidAlive(reviewer.child.pid), { timeoutMs: 5000 });
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
  for (const operation of ['sweep', 'done', 'done-no-worktree']) {
    const withWorktree = operation !== 'done-no-worktree';
    const task = `opencode-race-${operation}-t20261101-000001`;
    store.createTask(HOME, { id: task, title: 'retained native replacement', owner: OWNER });
    const old = await holder(), exited = once(old, 'exit');
    await reapHolder(old.pid, { identity: old.ownedIdentity }); await exited;
    const original = fixture(task, 'worker:race', old, `${operation}-old-native`), successor = await holder();
    const config = store.participantMcpPath(HOME, task, 'worker:race'), settings = store.participantSettingsPath(HOME, task, 'worker:race');
    const nativeHome = path.join(store.workersDir(HOME, task), `${store.participantFileStem('worker:race')}.native-home`);
    mkdirSync(nativeHome);
    const account = path.join(nativeHome, 'auth.json');
    for (const file of [config, settings, account]) writeFileSync(file, JSON.stringify({ ownedFixtureReference: file }), { mode: 0o600 });
    const secretBytes = [config, settings, account].map(file => readFileSync(file, 'utf8'));
    const repo = path.join(SB, `race-repo-${operation}`), worktree = path.join(SB, `race-worktree-${operation}`);
    const git = (...args) => {
      const run = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`owned worktree fixture git ${args.join(' ')}: ${run.stderr}`);
    };
    if (withWorktree) {
      mkdirSync(repo);
      git('init', '-q', '-b', 'main'); writeFileSync(path.join(repo, 'README.md'), 'owned worktree baseline\n');
      git('add', '.'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      git('worktree', 'add', '-q', '-b', `race-${operation}`, worktree);
    }
    original.participant = { ...original.participant, metadata: { ...original.participant.metadata,
      ...(withWorktree ? { worktree, repoAbs: repo, branch: `race-${operation}` } : {}), sessionRecord: original.record } };
    store.upsertParticipant(HOME, task, original.participant);
    const ownerPointer = JSON.stringify(store.participantOf(store.readTask(HOME, task), 'worker:race'));
    const originalBytes = snapshot(original);
    const record = JSON.parse(readFileSync(original.record, 'utf8'));
    const sweepNative = opencodeDriver.sweepParticipant;
    let armed = true, replacement, outcome;
    const deletionsBefore = deleted.length;
    opencodeDriver.sweepParticipant = (...args) => {
      const result = sweepNative(...args);
      if (armed && args[0].sessionRef === original.participant.sessionRef) {
        armed = false;
        queueMicrotask(() => {
          writeFileSync(original.record, JSON.stringify({ ...record, holderPid: successor.pid, holderProcess: successor.ownedIdentity,
            sessionId: `${operation}-replacement-native`, launchId: 'replacement-generation' }), { mode: 0o600 });
          writeFileSync(original.registry, JSON.stringify({ ref: original.participant.sessionRef, home: HOME, task,
            address: 'worker:race', recordPath: original.record, sessionId: `${operation}-replacement-native`, launchId: 'replacement-generation' }), { mode: 0o600 });
          replacement = snapshot(original);
        });
      }
      return result;
    };
    try {
      outcome = operation === 'sweep'
        ? await expectFail(() => sweep(SB, { task, address: 'worker:race' }, { registry }))
        : await capture(() => done(SB, { task, 'keep-sessions': true, snapshot: endedSessions, 'older-than': 0, yes: true }));
    } finally { opencodeDriver.sweepParticipant = sweepNative; }
    check(`: public ${operation} retains actual private replacement evidence after awaited real driver cleanup instead of deleting it in the caller tail`,
      !!replacement && files(original).every((file, i) => existsSync(file) && readFileSync(file, 'utf8') === replacement[i])
        && [config, settings, account].every((file, i) => existsSync(file) && readFileSync(file, 'utf8') === secretBytes[i])
        && (withWorktree ? existsSync(worktree) && readFileSync(path.join(worktree, 'README.md'), 'utf8') === 'owned worktree baseline\n'
          : !store.participantOf(store.readTask(HOME, task), 'worker:race').metadata.worktree)
        && JSON.stringify(store.participantOf(store.readTask(HOME, task), 'worker:race')) === ownerPointer
        && pidAlive(successor.pid) && deleted.slice(deletionsBefore).includes(`/api/session/${operation}-old-native`)
        && (operation === 'sweep' ? outcome.failed && /could not clear the harness state/.test(outcome.out)
          : store.taskExists(HOME, task) && !store.readTask(HOME, task).adapter.worktreesSwept
            && /could not clear the harness state/.test(outcome)), typeof outcome === 'string' ? outcome : outcome?.out);
    await reapHolder(successor.pid, { identity: successor.ownedIdentity });
    files(original).forEach((file, i) => writeFileSync(file, originalBytes[i], { mode: 0o600 }));
    if (operation === 'sweep') await capture(() => sweep(SB, { task, address: 'worker:race' }, { registry }));
    else await capture(() => done(SB, { task, 'keep-sessions': true, snapshot: endedSessions }));
    check(`: public ${operation} cleans the confirmed unchanged owned resources after fixture reconciliation instead of refusing every cleanup`,
      files(original).every(file => !existsSync(file)) && [config, settings, nativeHome, worktree].every(file => !existsSync(file))
        && !pidAlive(old.pid) && !pidAlive(successor.pid)
        && (operation === 'sweep' || store.taskExists(HOME, task) && Boolean(store.readTask(HOME, task).adapter.worktreesSwept)));
  }
  for (const operation of ['sweep', 'done']) for (const state of ['absent', 'orphan', 'unreadable-entry', 'mismatched-entry']) {
    const task = `opencode-empty-${operation}-${state}-t20261101-000001`;
    store.createTask(HOME, { id: task, title: 'exact empty registry proof', owner: OWNER });
    const child = await holder(), exited = once(child, 'exit');
    await reapHolder(child.pid, { identity: child.ownedIdentity }); await exited;
    const owned = fixture(task, 'reviewer:empty', child, `${operation}-${state}`);
    const config = store.participantMcpPath(HOME, task, 'reviewer:empty');
    const localHome = path.join(store.workersDir(HOME, task), `${store.participantFileStem('reviewer:empty')}.native-home`);
    mkdirSync(localHome);
    const secret = path.join(localHome, 'owned.json');
    writeFileSync(config, 'owned local config'); writeFileSync(secret, 'owned local home');
    const pointer = JSON.stringify(store.participantOf(store.readTask(HOME, task), 'reviewer:empty'));
    // The actual legacy writer did not need metadata.sessionRecord; the caller must supply its scope.
    if (state === 'mismatched-entry') {
      const entry = JSON.parse(readFileSync(owned.registry, 'utf8'));
      writeFileSync(owned.registry, JSON.stringify({ ...entry, task: OTHER }), { mode: 0o600 });
    } else {
      rmSync(owned.registry);
      if (state === 'unreadable-entry') {
        mkdirSync(owned.registry); writeFileSync(path.join(owned.registry, 'retained'), 'unreadable as registry JSON');
      }
      if (state !== 'orphan') { rmSync(owned.record); rmSync(owned.log); }
    }
    const recordBytes = existsSync(owned.record) ? readFileSync(owned.record, 'utf8') : null;
    const entryBytes = state === 'mismatched-entry' ? readFileSync(owned.registry, 'utf8') : null;
    const beforeDeletes = deleted.length;
    const result = operation === 'sweep'
      ? await expectFail(() => sweep(SB, { task, address: 'reviewer:empty' }, { registry }))
      : await capture(() => done(SB, { task, 'keep-sessions': true, snapshot: endedSessions, 'older-than': state === 'absent' ? 14 : 0, yes: true }));
    if (operation === 'sweep' && state !== 'mismatched-entry') {
      check(`: public sweep retains ${state} selected evidence when native inspect is unknown instead of inferring death from registry absence`,
        result.failed && /session state could not be read/.test(result.out)
          && readFileSync(config, 'utf8') === 'owned local config' && readFileSync(secret, 'utf8') === 'owned local home'
          && (recordBytes === null || readFileSync(owned.record, 'utf8') === recordBytes)
          && (entryBytes === null || readFileSync(owned.registry, 'utf8') === entryBytes)
          && (state !== 'unreadable-entry' || readFileSync(path.join(owned.registry, 'retained'), 'utf8') === 'unreadable as registry JSON')
          && JSON.stringify(store.participantOf(store.readTask(HOME, task), 'reviewer:empty')) === pointer
          && deleted.length === beforeDeletes, result.out);
    } else if (state === 'absent') {
      check(`: public ${operation} accepts exact selected registry and legacy primary absence without inventing a native Stop`,
        !existsSync(config) && !existsSync(localHome) && files(owned).every(file => !existsSync(file))
          && deleted.length === beforeDeletes && (operation === 'sweep' ? !result.failed
            : store.taskExists(HOME, task) && Boolean(store.readTask(HOME, task).adapter.worktreesSwept)), typeof result === 'string' ? result : result.out);
    } else {
      check(`: public ${operation} retains ${state} evidence and local secrets when a zero-count registry scan cannot prove native absence`,
        readFileSync(config, 'utf8') === 'owned local config' && readFileSync(secret, 'utf8') === 'owned local home'
          && (recordBytes === null || readFileSync(owned.record, 'utf8') === recordBytes)
          && (entryBytes === null || readFileSync(owned.registry, 'utf8') === entryBytes)
          && (state !== 'unreadable-entry' || readFileSync(path.join(owned.registry, 'retained'), 'utf8') === 'unreadable as registry JSON')
          && JSON.stringify(store.participantOf(store.readTask(HOME, task), 'reviewer:empty')) === pointer
          && deleted.length === beforeDeletes && (operation === 'sweep' ? result.failed && /selected record without a matching registry entry/.test(result.out)
            : store.taskExists(HOME, task) && !store.readTask(HOME, task).adapter.worktreesSwept && /cleanup remains pending/.test(result)),
        typeof result === 'string' ? result : result.out);
    }
  }
} finally {
  for (const child of children) await reapHolder(child.pid, { identity: child.ownedIdentity });
  await new Promise((resolve) => server.close(resolve));
}

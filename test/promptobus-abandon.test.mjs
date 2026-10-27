// `promptobus abandon` retires a dead session without writing a Stop receipt.
// The caller and the participant do not have to be the same harness.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';

const SB = makeSandbox('promptobus-abandon-');
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(SB, '.promptobus');
process.env.PROMPTOBUS_CODEX_HOME = path.join(SB, 'codex-home');
process.env.PROMPTOBUS_CURSOR_HOME = path.join(SB, 'cursor-home');
for (const name of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CURSOR_CONVERSATION_ID']) delete process.env[name];

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { writeSession } = await import(path.join(here, '..', 'lib', 'codex-session.js'));
const { abandon } = await import(path.join(here, '..', 'lib', 'abandon.js'));
const { done } = await import(path.join(here, '..', 'lib', 'done.js'));
const { createStandaloneHost } = await import(path.join(here, '..', 'dist', 'host-index.js'));

writeHostConfig(SB);
const HOST = createStandaloneHost({ cwd: SB, commandName: 'promptobus', home: HOME });
const CURSOR_OWNER = 'cursor-owner-abandon';
const CLAUDE_OWNER = 'claude-owner-abandon';

function as(kind, id) {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CURSOR_CONVERSATION_ID;
  if (kind === 'cursor') process.env.CURSOR_CONVERSATION_ID = id;
  else if (kind === 'claude') process.env.CLAUDE_CODE_SESSION_ID = id;
  else process.env.CODEX_THREAD_ID = id;
}

function git(cwd, ...args) {
  return spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

const REPO = path.join(SB, 'repo');
mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q', '-b', 'master');
git(REPO, 'commit', '-q', '--allow-empty', '-m', 'base');
const TREE = path.join(REPO, 'wt');
const BRANCH = 'worktree-promptobus-abandon';
git(REPO, 'worktree', 'add', '-q', '-b', BRANCH, TREE);
writeFileSync(path.join(TREE, 'note.txt'), 'only on the branch\n');
git(TREE, 'add', 'note.txt');
git(TREE, 'commit', '-qm', 'unmerged');

const DEAD = 'abandon-dead-t20261027-210000';
as('cursor', CURSOR_OWNER);
store.createTask(HOME, { id: DEAD, title: 'dead native holder', owner: CURSOR_OWNER });
store.upsertParticipant(HOME, DEAD, store.participantRecord('worker:dead', {
  harness: 'codex', mode: 'managed', sessionRef: 'dead-ref', sessionId: 'thread-dead',
  nativeLaunchId: 'launch-dead', repoAbs: REPO, worktree: TREE, branch: BRANCH,
}));
writeSession({
  ref: 'dead-ref', threadId: 'thread-dead', holderPid: 2147483646, appPid: 2147483645,
  state: 'idle', home: HOME, task: DEAD, address: 'worker:dead',
});

let refused;
try { await done(HOST, { task: DEAD, 'keep-sessions': true }); }
catch (error) { refused = error.message; }
check('done refuses a dead native holder that has no Stop receipt',
  typeof refused === 'string' && refused.includes('native work is active or unresolved') && refused.includes('abandon'),
  refused);

const abandoned = await capture(() => abandon(HOST, { task: DEAD }));
const deadMeta = store.participantOf(store.readTask(HOME, DEAD), 'worker:dead').metadata;
check('abandon records the missing receipt and does not write a Stop receipt',
  deadMeta.abandoned?.by === CURSOR_OWNER && deadMeta.abandoned.unknown.includes('stop-receipt') && !deadMeta.nativeStop,
  JSON.stringify(deadMeta.abandoned));
check('abandon names the route for the owner of a different harness',
  abandoned.includes('abandoned worker:dead'), abandoned.trim());
const closed = await capture(() => done(HOST, { task: DEAD, 'keep-sessions': true }));
check('done closes after abandon and keeps the unmerged worktree',
  store.readTask(HOME, DEAD).status === 'done' && existsSync(TREE)
  && closed.includes(`worktree ${TREE} left in place`) && closed.includes('not merged'),
  closed.trim());

const OTHER = 'abandon-cursor-t20261027-210001';
as('claude', CLAUDE_OWNER);
store.createTask(HOME, { id: OTHER, title: 'dead cursor participant', owner: CLAUDE_OWNER });
store.upsertParticipant(HOME, OTHER, store.participantRecord('worker:cursor', {
  harness: 'cursor', mode: 'managed', sessionRef: 'cursor-ref',
}));
await capture(() => abandon(HOST, { task: OTHER, address: 'worker:cursor' }));
const cursorMeta = store.participantOf(store.readTask(HOME, OTHER), 'worker:cursor').metadata;
check('a claude owner can abandon a cursor participant',
  cursorMeta.abandoned?.by === CLAUDE_OWNER && !cursorMeta.nativeStop, JSON.stringify(cursorMeta.abandoned));
await capture(() => done(HOST, { task: OTHER, 'keep-sessions': true }));
check('done closes that task too', store.readTask(HOME, OTHER).status === 'done');

const LIVE = 'abandon-live-t20261027-210002';
as('cursor', CURSOR_OWNER);
store.createTask(HOME, { id: LIVE, title: 'live holder', owner: CURSOR_OWNER });
store.upsertParticipant(HOME, LIVE, store.participantRecord('worker:live', {
  harness: 'codex', mode: 'managed', sessionRef: 'live-ref', sessionId: 'thread-live',
  nativeLaunchId: 'launch-live',
}));
writeSession({
  ref: 'live-ref', threadId: 'thread-live', holderPid: process.pid, appPid: process.pid,
  state: 'idle', home: HOME, task: LIVE, address: 'worker:live',
});
const live = await expectFail(() => abandon(HOST, { task: LIVE }));
const liveMeta = store.participantOf(store.readTask(HOME, LIVE), 'worker:live').metadata;
check('abandon refuses a live holder and writes nothing',
  live.failed && live.out.includes('refused live sessions') && !liveMeta.abandoned, live.out.trim());

const STALE = 'abandon-stale-stop-t20261027-210003';
as('cursor', CURSOR_OWNER);
store.createTask(HOME, { id: STALE, title: 'dead holder with a receipt that does not prove Stop', owner: CURSOR_OWNER });
store.upsertParticipant(HOME, STALE, store.participantRecord('worker:stale', {
  harness: 'codex', mode: 'managed', sessionRef: 'stale-ref', sessionId: 'thread-stale',
  nativeLaunchId: 'launch-stale',
  nativeStop: { task: STALE, address: 'worker:stale', ref: 'stale-ref' },
}));
writeSession({
  ref: 'stale-ref', threadId: 'thread-stale', holderPid: 2147483646, appPid: 2147483645,
  state: 'idle', home: HOME, task: STALE, address: 'worker:stale',
});
await capture(() => abandon(HOST, { task: STALE }));
const staleMeta = store.participantOf(store.readTask(HOME, STALE), 'worker:stale').metadata;
check('a dead session with an unproven Stop receipt is still abandoned',
  staleMeta.abandoned?.unknown?.includes('stop-receipt') && staleMeta.nativeStop?.ref === 'stale-ref',
  JSON.stringify(staleMeta.abandoned));
await capture(() => done(HOST, { task: STALE, 'keep-sessions': true }));
check('done closes that task without replacing the old receipt',
  store.readTask(HOME, STALE).status === 'done'
  && store.participantOf(store.readTask(HOME, STALE), 'worker:stale').metadata.nativeStop?.ref === 'stale-ref');

const REVIVED = 'abandon-revived-t20261027-210004';
as('cursor', CURSOR_OWNER);
store.createTask(HOME, { id: REVIVED, title: 'abandoned holder that comes back', owner: CURSOR_OWNER });
store.upsertParticipant(HOME, REVIVED, store.participantRecord('worker:revived', {
  harness: 'codex', mode: 'managed', sessionRef: 'revived-ref', sessionId: 'thread-revived',
  nativeLaunchId: 'launch-revived',
}));
writeSession({
  ref: 'revived-ref', threadId: 'thread-revived', holderPid: 2147483646, appPid: 2147483645,
  state: 'idle', home: HOME, task: REVIVED, address: 'worker:revived',
});
await capture(() => abandon(HOST, { task: REVIVED }));
writeSession({
  ref: 'revived-ref', threadId: 'thread-revived', holderPid: process.pid, appPid: process.pid,
  state: 'idle', home: HOME, task: REVIVED, address: 'worker:revived',
});
let revived;
try { await done(HOST, { task: REVIVED, 'keep-sessions': true }); }
catch (error) { revived = error.message; }
check('done refuses an abandoned participant whose holder is alive again',
  store.readTask(HOME, REVIVED).status !== 'done' && typeof revived === 'string'
  && revived.includes('native work is active or unresolved'),
  revived);

as('claude', CLAUDE_OWNER);
const foreign = await expectFail(() => abandon(HOST, { task: DEAD }));
check('a different harness that does not own the mailbox cannot abandon',
  foreign.failed && foreign.out.includes('bound to session'), foreign.out.trim());

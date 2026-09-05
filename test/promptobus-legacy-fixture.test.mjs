// Bus legacy-fixture store: is it what it claims to be, and does today's reader still
// read it the same way. Run: npm test
//
// Subject — not the store's behavior: that's covered by promptobus.test.mjs and its
// neighbors. What's checked here is the migration baseline: the fixture was captured via
// the `v0.61.0` store, and the migration reads that very same snapshot
// ([promptobus-migration.test.mjs](promptobus-migration.test.mjs)). If the fixture's
// contents diverge from what the reader reads, the migration ends up written against an
// input that no longer exists.
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './sandbox.mjs';
import { captureSplit, quiet } from './console.mjs';
import { check } from './check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'promptobus', 'legacy-v061');
// Reads a snapshot of the `v0.61.0` store — the one that ships in the package under the
// `legacy` namespace. The production store since the cutover is different, and there's no
// reason for it to read the legacy layout: the point of this file is that the migration's
// input is still read correctly by its own reader.
//
// Diagnostics reach the reader as an ARGUMENT: the package doesn't write to the process's
// streams, and there's no other seam left to inject it through — the caller names it, the
// same way the migration names it. Here the caller is the test suite, and it supplies
// `console.warn` so that `captureSplit` catches the same string a human would see on stderr.
const { legacy: store } = await import(path.join(here, '..', 'dist', 'index.js'));
const warn = (m) => console.warn(m);
const { ORCHESTRATOR, MESSAGE_TYPES } = store;

const ACTIVE = 't20260831-090000';
const CLOSED = 't20260830-140000';
const SESSION = '00000000-0000-4000-8000-000000000001';

// The fixture lives in the repository tree, and reading the mailbox CHANGES it: read
// messages move to `read/`, broken ones to `broken/`. We read a copy in the sandbox; that
// the original stayed intact is checked separately at the tail of the file.
const SB = makeSandbox('promptobus-promptobus-fixture-');
const home = path.join(SB, 'a2a');
cpSync(FIXTURE, home, { recursive: true });

const names = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []);
const msgsIn = (dir) => names(dir).map((n) => JSON.parse(readFileSync(path.join(dir, n), 'utf8')));

// --- tasks and participants -------------------------------------------------------

const tasks = quiet(() => store.listTasks(home, warn)).map((t) => t.id).sort();
check('fixture: two tasks — one active, one closed',
  tasks.length === 2 && tasks.includes(ACTIVE) && tasks.includes(CLOSED), tasks.join(', '));

const active = store.readTask(home, ACTIVE);
const closed = store.readTask(home, CLOSED);
check('fixture: the active task is active, the closed one is closed and has a date',
  active.status === 'active' && closed.status === 'done' && typeof closed.closed === 'string',
  `${active.status} / ${closed.status} / ${closed.closed}`);
check('fixture: resolving active tasks returns exactly one',
  quiet(() => store.activeTasks(home, warn)).map((t) => t.id).join(',') === ACTIVE);

const addrs = active.participants.map((p) => p.address);
check('fixture: participants of the active task are orchestrator, worker and reviewer',
  addrs.length === 3 && addrs.includes(ORCHESTRATOR) && addrs.includes('worker:demo') && addrs.includes('reviewer:demo'),
  addrs.join(', '));
check('fixture: the task has an owner, and that same owner is bound to a session',
  store.taskOwner(home, ACTIVE) === SESSION && store.boundTaskId(home, SESSION) === ACTIVE,
  `${store.taskOwner(home, ACTIVE)} / ${store.boundTaskId(home, SESSION)}`);
check('fixture: the closed task is not bound to any session',
  store.boundTaskId(home, '00000000-0000-4000-8000-000000000002') === null);

// --- correspondence: unread, history, artifact -------------------------------

check('fixture: unread is split across addresses (1 / 3 / 0)',
  store.countInbox(home, ACTIVE, ORCHESTRATOR) === 1
  && store.countInbox(home, ACTIVE, 'worker:demo') === 3
  && store.countInbox(home, ACTIVE, 'reviewer:demo') === 0,
  [ORCHESTRATOR, 'worker:demo', 'reviewer:demo'].map((a) => store.countInbox(home, ACTIVE, a)).join(' / '));

const history = msgsIn(store.readDir(home, ACTIVE, ORCHESTRATOR));
check('fixture: orchestrator history is three messages in send order',
  history.map((m) => m.type).join(',') === 'status,result,review', history.map((m) => m.type).join(','));
check('fixture: message types are all from protocol v1',
  [...history, ...msgsIn(store.inboxDir(home, ACTIVE, ORCHESTRATOR))].every((m) => MESSAGE_TYPES.includes(m.type)));

const withArtifact = history.find((m) => m.artifact);
check('fixture: the artifact is named by the message and lives in the task',
  withArtifact?.artifact === 'demo-diff.patch'
  && existsSync(path.join(store.artifactsDir(home, ACTIVE), 'demo-diff.patch')),
  JSON.stringify(withArtifact?.artifact));

check(`fixture: the reviewer's mailbox has been read, the reply went to the orchestrator`,
  msgsIn(store.readDir(home, ACTIVE, 'reviewer:demo')).map((m) => m.type).join(',') === 'review'
  && store.countInbox(home, ACTIVE, 'reviewer:demo') === 0);

check('fixture: correspondence of the closed task has been read in full',
  msgsIn(store.readDir(home, CLOSED, ORCHESTRATOR)).length === 1
  && msgsIn(store.readDir(home, CLOSED, 'worker:stale')).length === 1
  && store.countInbox(home, CLOSED, ORCHESTRATOR) === 0);

// --- broken message: isolation into broken/ --------------------------------

const BROKEN = '20260831T095500000-0009-orchestrator.json';
const attic = store.brokenDir(home, ACTIVE, 'worker:demo');
check(`fixture: the broken message sits in the mailbox, not in broken/`,
  names(store.inboxDir(home, ACTIVE, 'worker:demo')).includes(BROKEN) && !existsSync(attic));

const read = captureSplit(() => store.readInbox(home, ACTIVE, 'worker:demo', warn));
const { msgs, broken } = read.value;
check('reader: sound messages get through, the broken one does not take them down with it',
  msgs.length === 2 && msgs.map((m) => m.type).join(',') === 'task,review',
  msgs.map((m) => m.type).join(','));
check('reader: the broken one is set aside into broken/ under its own name',
  names(attic).join(',') === BROKEN && !names(store.inboxDir(home, ACTIVE, 'worker:demo')).includes(BROKEN),
  names(attic).join(','));
check('reader: the report on the broken message goes to both the agent and the human',
  broken.length === 1 && broken[0].includes(BROKEN) && read.err.includes(BROKEN),
  `${broken.length} / ${JSON.stringify(read.err)}`);
check('reader: sound messages are marked as read',
  store.countInbox(home, ACTIVE, 'worker:demo') === 0
  && msgsIn(store.readDir(home, ACTIVE, 'worker:demo')).length === 2);

// --- health and warden state --------------------------------------------

const health = store.readHealth(home, ACTIVE);
check('fixture: health knows all three addresses and the unread count for each',
  Object.keys(health).length === 3 && health[ORCHESTRATOR]?.unread === 1
  && health['worker:demo']?.unread === 3 && health['reviewer:demo']?.unread === 0,
  Object.keys(health).join(', '));
// The snapshot holds both outcomes the migration must carry over: a successful knock and a
// fallback with an error code. The successful one here is `socket` — the Claude Code
// driver's value at the time the snapshot was taken, not the only legitimate one: a live
// warden writes the driver's `knockChannel` (`inject` for Cursor, `rpc` for Codex).
check('fixture: health has both channels — a successful knock and a fallback to self-wake',
  health[ORCHESTRATOR].channel === 'socket' && health[ORCHESTRATOR].knockError === null
  && health['worker:demo'].channel === 'self-wake' && health['worker:demo'].knockError === 'ENOENT',
  `${health[ORCHESTRATOR].channel} / ${health['worker:demo'].channel}`);
check(`fixture: all three have a contact point fingerprint, and the socket is a stand-in`,
  Object.values(health).every((h) => /^\/tmp\/promptobus-demo\/[a-z-]+\.sock#\d{4}-/.test(h.wake)),
  Object.values(health).map((h) => h.wake).join(' | '));
check('fixture: the delivered address kept the fields of the previous knock',
  health['reviewer:demo'].deliveredAt === '2026-08-31T09:46:00.000Z'
  && health['reviewer:demo'].channel === 'socket' && health['reviewer:demo'].since === null
  && health['reviewer:demo'].knocks === 0,
  JSON.stringify(health['reviewer:demo']));
check('fixture: silence on both addresses has been escalated',
  typeof health[ORCHESTRATOR].escalatedAt === 'string'
  && typeof health['worker:demo'].escalatedAt === 'string');

const mark = JSON.parse(readFileSync(store.wardenMarkFile(home, ACTIVE), 'utf8'));
check('fixture: the warden mark is present, but it is not counted as alive',
  mark.pid === 424242 && typeof mark.beat === 'string' && store.liveWarden(home, ACTIVE) === null,
  JSON.stringify(mark));
// The log lines are quoted from the warden's own templates: if the format diverges, the
// snapshot stops being valid migration input, and this check is what pins the format down.
const log = readFileSync(store.wardenLogFile(home, ACTIVE), 'utf8').split('\n').filter(Boolean);
check('fixture: the warden log covers startup, knocks, delivery, fallback, and silence',
  log.length === 11
  && /надзиратель поднят · pid 424242 · CLI /.test(log[0])
  && log.some((l) => /notification worker:demo: непрочитанных 1, стук 1$/.test(l))
  && log.some((l) => /доставлено reviewer:demo: mailbox забран \(лежало 1, стуков 1\)$/.test(l))
  && log.some((l) => /откат на self-wake worker:demo: сокет не принял notification \(ENOENT\)$/.test(l))
  && /МОЛЧИТ worker:demo: mailbox не забран \d+ мин, непрочитанных 3, канал self-wake$/.test(log[log.length - 1]),
  `${log.length} lines`);
check('fixture: the log can be read from the tail',
  store.tailWardenLog(home, ACTIVE, 3).length === 3
  && store.tailWardenLog(home, ACTIVE, 1)[0] === log[log.length - 1]);
check(`fixture: there are no contact points in the fixture — they'd carry a live session's token`,
  !existsSync(path.join(store.taskDir(home, ACTIVE), 'wake')));

// --- hygiene: the original fixture is untouched ---------------------------------

check('hygiene: reading went through the copy, the repository tree is unchanged',
  !existsSync(path.join(FIXTURE, 'tasks', ACTIVE, 'broken'))
  && readdirSync(path.join(FIXTURE, 'tasks', ACTIVE, 'inbox', 'worker-demo')).length === 3);

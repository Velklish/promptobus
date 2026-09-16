// `promptobus sweep <address>` — one accepted piece, the task left alive. Run: npm test
//
// Subject: PB-208. Four things make it a verb and not a narrower `done`. The task and the
// other participants must survive it; the piece's tree, branch, blobs and files must go on
// a PROVEN squash merge and stay without one; the run's telemetry must survive, checked at
// the end by closing the task and reading the rows `done` writes; and the right to call it
// must be PROVEN — the gate refuses everything it cannot prove, identity-less calls first.
//
// The git fixtures are real, as in `promptobus-worktree.test.mjs`: the merge proof is the
// subject, and a mocked git would prove the mock. The driver is a stand-in behind the
// `registry` seam, and session identity behind `bindSessionIdentity` — liveness and the
// right are the gates, not the behaviour of `claude`.
import {
  existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';

const SB = makeSandbox('promptobus-sweep-');
const here = path.dirname(fileURLToPath(import.meta.url));
writeHostConfig(SB);
const HOME = path.join(SB, '.promptobus');

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const bus = await import(path.join(here, '..', 'dist', 'index.js'));
const telemetry = await import(path.join(here, '..', 'lib', 'model-routing', 'telemetry.js'));
const { childOf, keptBy, keptPaths, sweep } = await import(path.join(here, '..', 'lib', 'sweep.js'));
const { done } = await import(path.join(here, '..', 'lib', 'done.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));

const HOST = hostOf(SB);
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

// Session identity is a seam here, not an environment: the gate is a positive proof, and a
// suite that could not name the caller would only ever see its refusal.
const OWNER = 'sess-orchestrator';
const APPROVER = 'sess-approver';
let SESSION = OWNER;
store.bindSessionIdentity(() => ({ id: SESSION }));

// --- fixture: a clone with six worker trees -----------------------------------
//
// `done` is the only thing that proves a squash merge, and it does it with two content
// measurements. The fixture therefore carries a real squash: the branch's commits stay out
// of master while its patch lands there.
const REPO = path.join(SB, 'repo');
mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q', '-b', 'master');
writeFileSync(path.join(REPO, 'f'), 'base\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-qm', 'base');

function worktreeAt(name, branch) {
  const at = path.join(REPO, '.claude', 'worktrees', name);
  git(REPO, 'worktree', 'add', '-q', '-b', branch, at);
  return at;
}

const ACCEPTED = worktreeAt('accepted', 'worktree-promptobus-accepted');
writeFileSync(path.join(ACCEPTED, 'accepted.txt'), 'the accepted work\n');
git(ACCEPTED, 'add', '.');
git(ACCEPTED, 'commit', '-qm', 'the accepted work');
// The squash: master gains the same patch as ONE commit, so ancestry says "not merged"
// while the content measurements say the work is in.
git(REPO, 'checkout', '-q', 'master');
writeFileSync(path.join(REPO, 'accepted.txt'), 'the accepted work\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-qm', 'squash of the accepted work');

// The second proof. Master takes the same patch and then edits those very lines, so
// `merge-tree` conflicts and stops answering — and `patch-id --stable` still finds the
// branch's own patch in the base. This is the case PB-6 and PB-158 left behind.
const SQUASHED = worktreeAt('squashed', 'worktree-promptobus-squashed');
writeFileSync(path.join(SQUASHED, 'moved.txt'), 'the line as the worker wrote it\n');
git(SQUASHED, 'add', '.');
git(SQUASHED, 'commit', '-qm', 'the line as the worker wrote it');
writeFileSync(path.join(REPO, 'moved.txt'), 'the line as the worker wrote it\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-qm', 'squash of the moved line');
writeFileSync(path.join(REPO, 'moved.txt'), 'and then the base moved over it\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-qm', 'the base moves over the same lines');

const OPEN = worktreeAt('open', 'worktree-promptobus-open');
writeFileSync(path.join(OPEN, 'open.txt'), 'work nobody took\n');
git(OPEN, 'add', '.');
git(OPEN, 'commit', '-qm', 'work nobody took');

const NEIGHBOUR = worktreeAt('neighbour', 'worktree-promptobus-neighbour');
writeFileSync(path.join(NEIGHBOUR, 'neighbour.txt'), 'still working\n');
git(NEIGHBOUR, 'add', '.');
git(NEIGHBOUR, 'commit', '-qm', 'still working');

// A tree the journal names and disk does not have: its branch holds work, and neither
// measurement can run on it.
const VANISHED = worktreeAt('vanished', 'worktree-promptobus-vanished');
writeFileSync(path.join(VANISHED, 'vanished.txt'), 'a tree somebody deleted by hand\n');
git(VANISHED, 'add', '.');
git(VANISHED, 'commit', '-qm', 'a tree somebody deleted by hand');
rmSync(VANISHED, { recursive: true, force: true });

// --- fixture: the task and its participants ------------------------------------
const TASK = 'sweep-t20260913-120000';
const ago = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
store.createTask(HOME, { id: TASK, title: 'уборка одного принятого куска', owner: OWNER });

const piece = (address, worktree) => store.upsertParticipant(HOME, TASK,
  store.participantRecord(address, {
    harness: 'claude',
    mode: 'managed',
    sessionRef: `sess-${address.split(':')[1]}`,
    // A model per address: a telemetry row carries the role and the model, not the address.
    model: `claude-opus-${address.split(':')[1]}`,
    effort: 'high',
    started: ago(120),
    repoAbs: REPO,
    worktree,
    branch: path.basename(worktree),
    routing: { strategy: 'balanced', role: 'worker', tupleId: 'claude.opus.high', windows: [] },
  }));

piece('worker:accepted', ACCEPTED);
piece('worker:squashed', SQUASHED);
piece('worker:open', OPEN);
piece('worker:neighbour', NEIGHBOUR);
piece('worker:vanished', VANISHED);
// Lifted but still running: the sweep must refuse before it touches anything.
piece('worker:live', worktreeAt('live', 'worktree-promptobus-live'));
// The approver of this piece: acceptance runs in its session, so the gate must let it in.
store.upsertParticipant(HOME, TASK, store.participantRecord('approver:accepted', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-approver-ref', sessionId: APPROVER,
}));

// --- fixture: mail, artifacts and the run's sidecars ---------------------------
const say = (from, to, type, body, artifactPath) => store.sendMessage(HOME, TASK, {
  from, to, type, body, ...(artifactPath ? { artifactPath } : {}),
});
say('worker:accepted', 'orchestrator', 'status', 'взял задание');
say('worker:neighbour', 'orchestrator', 'status', 'тоже взял');
say('orchestrator', 'worker:accepted', 'review', 'круг замечаний');
say('orchestrator', 'worker:neighbour', 'review', 'и тебе круг замечаний');

const drop = path.join(SB, 'drop');
mkdirSync(drop, { recursive: true });
const file = (name, body) => {
  const at = path.join(drop, name);
  writeFileSync(at, body);
  return at;
};
// Own payload of the accepted piece, own payload of the neighbour, and one payload BOTH
// sent: the shared blob must survive, because a blob is deduplicated inside the task.
const SHARED = 'the very same bytes\n';
// A record its published schema accepts: `send` refuses one that its schema rejects, and
// the subject here is what the sweep takes, not the shape of the document.
const gateRecord = (by) => `${JSON.stringify({
  schemaVersion: 1,
  records: [{ command: 'npm test', exit: 0, tree: 'a'.repeat(40), dirty: false, at: '2026-09-13T12:00:00.000Z', by }],
})}\n`;
say('worker:accepted', 'orchestrator', 'artifact', 'мои гейты', file('gates-accepted.json', gateRecord('worker:accepted')));
say('worker:accepted', 'orchestrator', 'artifact', 'общий', file('shared.txt', SHARED));
say('worker:neighbour', 'orchestrator', 'artifact', 'соседские гейты', file('gates-neighbour.json', gateRecord('worker:neighbour')));
say('worker:neighbour', 'orchestrator', 'artifact', 'общий', file('shared.txt', SHARED));
say('worker:open', 'orchestrator', 'artifact', 'незакрытое', file('open-patch.diff', 'diff of work nobody took\n'));
say('worker:vanished', 'orchestrator', 'artifact', 'пропавшее', file('vanished-patch.diff', 'diff of a tree that went\n'));

const workersDir = store.workersDir(HOME, TASK);
mkdirSync(workersDir, { recursive: true });
const secretsOf = (address) => {
  const mcp = store.participantMcpPath(HOME, TASK, address);
  const settings = store.participantSettingsPath(HOME, TASK, address);
  const stand = path.join(workersDir, `${store.participantFileStem(address)}.codex-sandbox`);
  writeFileSync(mcp, '{"mcpServers":{}}\n');
  writeFileSync(settings, '{"hooks":{}}\n');
  mkdirSync(stand, { recursive: true });
  writeFileSync(path.join(stand, 'AGENTS.md'), 'стенд\n');
  store.writeWake(HOME, TASK, address, { socket: `/tmp/${address}.sock`, token: 'secret' });
  return { mcp, settings, stand, wake: store.wakeFile(HOME, TASK, address) };
};
const acceptedSecrets = secretsOf('worker:accepted');
const neighbourSecrets = secretsOf('worker:neighbour');
const openSecrets = secretsOf('worker:open');
const vanishedSecrets = secretsOf('worker:vanished');

// The run's telemetry inputs: health, the warden log, stalls and the wait sidecars. They
// are exactly what `recordTelemetry` reads at `done`, which is why they are the keep list.
store.writeHealth(HOME, TASK, {
  'worker:accepted': { since: ago(100), knockedAt: ago(99), deliveredAt: ago(98) },
  'worker:neighbour': { since: ago(100), knockedAt: ago(99), deliveredAt: ago(98) },
});
store.logWarden(HOME, TASK, 'notification worker:accepted: unread 1');
store.logWarden(HOME, TASK, 'delivered worker:accepted: unread 0');
store.logWarden(HOME, TASK, 'notification worker:neighbour: unread 1');
writeFileSync(store.stallsFile(HOME, TASK), `${JSON.stringify({ 'worker:open': { reason: 'silence', at: ago(10) } })}\n`);
for (const address of ['worker:accepted', 'worker:neighbour']) {
  const at = telemetry.throughputSidecarFile(HOME, TASK, address);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, `${JSON.stringify({ outputTokens: 300, generationDurationSec: 6 })}\n`
    + `${JSON.stringify({ outputTokens: 120, generationDurationSec: 3 })}\n`);
}

// --- the stand-in driver -------------------------------------------------------
//
// `onInspect` is how a CONCURRENT write is injected: the sweep asks liveness once outside
// the journal lock and once under it, so a hook on the second call lands exactly in the
// window a re-lift would use. It writes the journal file directly — going through the
// store's own door would wait on the lock the sweep is holding.
const live = new Set(['sess-live']);
let onInspect = null;
function fakeRegistry() {
  const swept = [];
  const driver = {
    id: 'claude',
    capabilities: {
      spawn: true, attach: false, activation: 'push', inspect: true, stop: true,
      denyTools: true, systemPrompt: true, sessionList: true, enter: true,
    },
    phrases: {
      sessions: 'claude agents', unreadable: 'unreadable', enter: (id) => `enter ${id}`,
      stop: (id) => `stop ${id}`, logs: (id) => `logs ${id}`,
    },
    // The hook fires AFTER the verdict is built: it stands for what a neighbour does
    // between this read and the next, not for what was true when the read began.
    inspect: (ref) => {
      const view = live.has(ref)
        ? { state: 'alive', busy: false, stall: null, id: ref, note: 'idle' }
        : { state: 'gone', busy: false, stall: null, id: null, note: null };
      onInspect?.(ref);
      return view;
    },
    stop: () => ({ ok: true, stopped: true, note: 'closed' }),
    sweepParticipant: (p, taskId) => { swept.push(`${p?.metadata?.address}@${taskId}`); },
  };
  return { registry: bus.createRegistry({ drivers: { claude: driver }, fallback: 'claude' }), swept };
}
const stand = fakeRegistry();
const run = (address) => capture(async () => sweep(HOST, { task: TASK, address }, { registry: stand.registry }));
const refuse = (address, task = TASK) => expectFail(async () => sweep(HOST, { task, address }, { registry: stand.registry }));

// --- the assumptions the file rests on ------------------------------------------
//
// The sweep addresses the `files/` entry by the name the record carries and proves identity
// by the inode it shares with its blob. That second half holds only while the store
// HARD-LINKS, and it is pinned here on the assumption itself: were the store to start
// copying, the sweep would take no entry at all, and only this check would go red.
const inodeOf = (p) => { const s = statSync(p); return `${s.dev}:${s.ino}`; };
const artifactRecords = () => readdirSync(store.artifactsDir(HOME, TASK))
  .filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(readFileSync(path.join(store.artifactsDir(HOME, TASK), n), 'utf8')));
const blobOf = (filename) => path.join(store.blobsDir(HOME, TASK),
  artifactRecords().find((a) => a.filename === filename).sha256);
const linksOf = (blob) => readdirSync(store.filesDir(HOME, TASK))
  .map((n) => path.join(store.filesDir(HOME, TASK), n))
  .filter((at) => inodeOf(at) === inodeOf(blob));

check(': a files-folder entry and its blob are ONE inode — the sweep proves the entry by that',
  linksOf(blobOf('gates-accepted.json')).length === 1
  && path.basename(linksOf(blobOf('gates-accepted.json'))[0]) === 'gates-accepted.json',
  linksOf(blobOf('gates-accepted.json')).join(', '));

const sharedRecords = () => artifactRecords().filter((a) => a.filename.startsWith('shared'));
const acceptedBlob = blobOf('gates-accepted.json');
const neighbourBlob = blobOf('gates-neighbour.json');
const sharedBlob = path.join(store.blobsDir(HOME, TASK), sharedRecords()[0].sha256);
const openBlob = blobOf('open-patch.diff');
const vanishedBlob = blobOf('vanished-patch.diff');
check(': the payload both of them sent is ONE blob with two records — that is what dedup means',
  sharedRecords().length === 2 && new Set(sharedRecords().map((a) => a.sha256)).size === 1,
  JSON.stringify(artifactRecords().map((a) => `${a.filename}:${a.sha256.slice(0, 8)}`)));
// The record carries the name that LANDED in `files/`, numbered past the taken one.
check(': the second send of the same bytes landed under its own numbered name',
  sharedRecords().map((a) => a.filename).sort().join(', ') === 'shared-2.txt, shared.txt',
  sharedRecords().map((a) => a.filename).join(', '));

const countLines = (at) => readFileSync(at, 'utf8').split('\n').filter(Boolean).length;
const messagesBefore = readdirSync(store.messagesDir(HOME, TASK)).length;
const wardenLinesBefore = countLines(store.wardenLogFile(HOME, TASK));
const throughputBefore = countLines(telemetry.throughputSidecarFile(HOME, TASK, 'worker:accepted'));
const neighbourInboxBefore = readdirSync(store.inboxDir(HOME, TASK, 'worker:neighbour')).length;

// --- the gate: a positive proof, never the absence of one -----------------------
//
// Every case asserts BOTH halves — the refusal AND that the tree is still there. A refusal
// that returns 1 after doing the work is not a refusal.
SESSION = null;
const noIdentity = await refuse('worker:accepted');
check(': a call with no session identity is refused — it can prove neither owner nor approver',
  noIdentity.failed && /no session identity/.test(noIdentity.out) && existsSync(ACCEPTED),
  noIdentity.out.trim());

SESSION = 'sess-passer-by';
const stranger = await refuse('worker:accepted');
check(': a session that is neither the mailbox owner nor an approver of this task is refused',
  stranger.failed && /proven rather than assumed/.test(stranger.out) && existsSync(ACCEPTED),
  stranger.out.trim());
// The claim route belongs to the owner whose daemon died. Offered to a call that cannot
// name itself, "the task is yours" would be advice about somebody else's run.
check(': a call with no identity is not told to claim the mailbox — that route is the owner\'s',
  !/task is yours/.test(noIdentity.out) && /names them/.test(noIdentity.out), noIdentity.out.trim());

// A worker of this task is a participant and still not a sweeper: the roles that may call
// it are two, and being listed is not one of them.
SESSION = 'sess-accepted';
const byWorker = await refuse('worker:neighbour');
check(': a worker of this task cannot sweep a neighbour — being a participant is not the right',
  byWorker.failed && existsSync(NEIGHBOUR), byWorker.out.trim());

// --- the other refusals ---------------------------------------------------------
SESSION = OWNER;
const liveOut = await refuse('worker:live');
check(': a live session is refused — a sweep would take the tree from under a running cwd',
  liveOut.failed && /still alive/.test(liveOut.out) && existsSync(path.join(REPO, '.claude', 'worktrees', 'live')),
  liveOut.out.trim());
check(': and the refusal names the command that closes the session first',
  /promptobus stop worker:live/.test(liveOut.out), liveOut.out.trim());

const orchOut = await refuse('orchestrator');
check(': the orchestrator is refused — it owns the task, and the task is closed by done',
  orchOut.failed && /done/.test(orchOut.out), orchOut.out.trim());

const strangerAddress = await refuse('worker:nobody');
check(': an address of no task at all is refused, and the line names who IS in the task',
  strangerAddress.failed && /worker:accepted/.test(strangerAddress.out), strangerAddress.out.trim());

// A CLOSED task is refused before the right is even asked: the command promises the task
// stays active, and on a closed one that line would be a lie.
const CLOSED = 'sweep-closed-t20260913-120100';
store.createTask(HOME, { id: CLOSED, title: 'закрытая задача', owner: OWNER });
store.upsertParticipant(HOME, CLOSED, store.participantRecord('worker:gone', {
  harness: 'claude', mode: 'managed', sessionRef: 'sess-gone', repoAbs: REPO, worktree: NEIGHBOUR,
}));
store.closeTask(HOME, CLOSED);
const closedOut = await refuse('worker:gone', CLOSED);
check(': a closed task is refused even with an explicit --task, and its worktree is untouched',
  closedOut.failed && /is closed/.test(closedOut.out) && existsSync(NEIGHBOUR), closedOut.out.trim());

// --- a record the sweep cannot read stops it BEFORE the first removal ------------
//
// The path a removal aims at is built from record fields. A record the schema refuses — a
// `sha256` that walks out of the task, a missing `filename` — must be met before the tree
// is gone, not after: the walk would otherwise throw with the worktree already removed.
const evil = path.join(store.artifactsDir(HOME, TASK), '20260913T120000000-0001-aaaaaa.json');
writeFileSync(evil, `${JSON.stringify({
  schemaVersion: 1,
  id: '20260913T120000000-0001-aaaaaa',
  sha256: '../../../../task.json',
  filename: 'x.json',
  size: 1,
  blob: 'blobs/../../task.json',
})}\n`);
const evilOut = await refuse('worker:accepted');
check(': an artifact record the schema refuses stops the sweep, and the tree is still there',
  evilOut.failed && /cannot read/.test(evilOut.out) && existsSync(ACCEPTED) && existsSync(store.taskFile(HOME, TASK)),
  evilOut.out.trim());
check(': and the refusal names the record rather than the symptom',
  /aaaaaa/.test(evilOut.out), evilOut.out.trim());
rmSync(evil, { force: true });
// The same rule stated on the helper itself: a field that walks out yields no path at all.
check(': childOf refuses a name that leaves the directory, and keeps a plain one',
  childOf('/a/b', '../../etc/passwd') === null && childOf('/a/b', 'sub/dir') === null
  && childOf('/a/b', '') === null && childOf('/a/b', 'blob') === path.join('/a/b', 'blob'),
  `${childOf('/a/b', '../../etc/passwd')} · ${childOf('/a/b', 'blob')}`);

// --- a re-lift between the liveness check and the sweep --------------------------
//
// The sweep reads the record and asks liveness OUTSIDE the journal lock, then takes the
// lock and reads both again. `spawn` writes through that same lock, so the window a re-lift
// can use is exactly the first read — and the hook lands in it, writing the journal file
// directly because the store's own door would wait on the lock the sweep is about to hold.
let inspects = 0;
const onFirstInspect = (fn) => { inspects = 0; onInspect = () => { inspects += 1; if (inspects === 1) fn(); }; };

onFirstInspect(() => {
  const meta = JSON.parse(readFileSync(store.taskFile(HOME, TASK), 'utf8'));
  const p = meta.participants.find((x) => x.metadata?.address === 'worker:accepted');
  p.sessionRef = 'sess-accepted-again';
  p.metadata.started = new Date().toISOString();
  writeFileSync(store.taskFile(HOME, TASK), `${JSON.stringify(meta, null, 2)}\n`);
});
const relifted = await refuse('worker:accepted');
onInspect = null;
check(': a record rewritten between the liveness read and the lock stops the sweep, nothing removed',
  relifted.failed && /lifted again/.test(relifted.out) && existsSync(ACCEPTED)
  && existsSync(path.join(store.filesDir(HOME, TASK), 'gates-accepted.json')),
  relifted.out.trim());
// Put the record back the way it was: the rest of the file sweeps this piece for real.
piece('worker:accepted', ACCEPTED);

// The other half of the same window: the record is untouched and the session comes back.
onFirstInspect(() => { live.add('sess-accepted'); });
const revived = await refuse('worker:accepted');
onInspect = null;
live.delete('sess-accepted');
check(': a session that comes back under the lock stops the sweep too, and names stop as the route',
  revived.failed && /has a session again/.test(revived.out) && existsSync(ACCEPTED)
  && existsSync(path.join(store.filesDir(HOME, TASK), 'gates-accepted.json')),
  revived.out.trim());

// --- the piece with an unproven merge ---------------------------------------------
check(': the secrets of the unmerged piece are there BEFORE it is swept',
  [openSecrets.mcp, openSecrets.settings, openSecrets.wake, openSecrets.stand].every(existsSync),
  [openSecrets.mcp, openSecrets.settings, openSecrets.wake, openSecrets.stand].filter((at) => !existsSync(at)).join(', '));
const openOut = await run('worker:open');
check(': a piece whose merge is not provable keeps its tree, and the verb says so out loud',
  existsSync(OPEN) && /left in place/.test(openOut) && /not merged/.test(openOut), openOut.trim());
check(': its branch stays too — git still knows it',
  git(REPO, 'rev-parse', '--verify', '--quiet', 'worktree-promptobus-open').status === 0);
check(': and its blobs and files stay with the tree — they may be the only copy of that work',
  existsSync(openBlob) && existsSync(path.join(store.filesDir(HOME, TASK), 'open-patch.diff')),
  `${existsSync(openBlob)} · ${existsSync(path.join(store.filesDir(HOME, TASK), 'open-patch.diff'))}`);
check(': and its secrets still go — they are gated on a dead session, not on the merge',
  ![openSecrets.mcp, openSecrets.settings, openSecrets.wake, openSecrets.stand].some(existsSync),
  [openSecrets.mcp, openSecrets.settings, openSecrets.wake, openSecrets.stand].filter(existsSync).join(', '));

// --- a tree the journal names and disk does not have ------------------------------
const vanishedOut = await run('worker:vanished');
check(': a vanished tree is not read as "there was none" — nothing of that piece is judged taken',
  /is not on disk/.test(vanishedOut) && existsSync(vanishedBlob)
  && existsSync(path.join(store.filesDir(HOME, TASK), 'vanished-patch.diff')),
  vanishedOut.trim());
check(': its branch stays — neither measurement could run on a tree that is not there',
  git(REPO, 'rev-parse', '--verify', '--quiet', 'worktree-promptobus-vanished').status === 0);
check(': its secrets still go, and its harness state is cleared through the driver',
  !existsSync(vanishedSecrets.mcp) && stand.swept.includes(`worker:vanished@${TASK}`),
  `${existsSync(vanishedSecrets.mcp)} · ${stand.swept.join(', ')}`);

// --- a blob a neighbour already holds by a hard link ------------------------------
//
// `placeFile` links a files/ entry BEFORE the record lands, so between the two a payload
// has a second link and no second record. The sweep must read the link count, not only the
// records: the blob is somebody's even when the journal does not say so yet.
const inflight = path.join(store.filesDir(HOME, TASK), 'in-flight.json');
linkSync(acceptedBlob, inflight);

// --- the accepted piece ------------------------------------------------------------
const out = await run('worker:accepted');
check(': the worktree of the accepted piece is gone, and the line names the content measurement',
  !existsSync(ACCEPTED) && /merged as a squash/.test(out) && /would add nothing/.test(out), out.trim());
check(': and the line says ancestry did NOT decide it — the commits are still not in master',
  /are not in master/.test(out), out.trim());
check(': its branch is gone — a proven squash is force-deleted, ancestry cannot confirm it',
  git(REPO, 'rev-parse', '--verify', '--quiet', 'worktree-promptobus-accepted').status !== 0);
check(': its own files-folder entry and its artifact record are gone',
  !existsSync(path.join(store.filesDir(HOME, TASK), 'gates-accepted.json'))
  && !artifactRecords().some((a) => a.filename === 'gates-accepted.json'),
  readdirSync(store.filesDir(HOME, TASK)).join(', '));
check(': but the BLOB stays while a second hard link holds it, and the line says so',
  existsSync(acceptedBlob) && /the payload is still named/.test(out)
  && /another hard link to it/.test(out), out.trim());
rmSync(inflight, { force: true });
check(': the blob the neighbour also sent SURVIVES — a blob leaves only when nothing names it',
  existsSync(sharedBlob) && sharedRecords().length === 1,
  `${existsSync(sharedBlob)} · ${sharedRecords().map((a) => a.filename).join(', ')}`);
check(': and of the two files-folder entries of that blob, only the swept one went',
  !existsSync(path.join(store.filesDir(HOME, TASK), 'shared.txt'))
  && existsSync(path.join(store.filesDir(HOME, TASK), 'shared-2.txt')),
  readdirSync(store.filesDir(HOME, TASK)).join(', '));
check(': the mcp-config, the settings file, the contact point and the temporary stand are gone',
  ![acceptedSecrets.mcp, acceptedSecrets.settings, acceptedSecrets.wake, acceptedSecrets.stand].some(existsSync),
  [acceptedSecrets.mcp, acceptedSecrets.settings, acceptedSecrets.wake, acceptedSecrets.stand].filter(existsSync).join(', '));

// --- the second proof: patch-id where merge-tree stops answering --------------------
//
// Swept by the APPROVER of this task, not by the mailbox owner: acceptance runs in that
// session, and the gate has to let exactly it in.
SESSION = APPROVER;
const squashedOut = await run('worker:squashed');
SESSION = OWNER;
check(': an approver of this task may sweep — that is the session acceptance runs in',
  !existsSync(SQUASHED), squashedOut.trim());
check(': a squash the base has since moved over is proven by patch-id, and the tree goes',
  /patch-id/.test(squashedOut), squashedOut.trim());
check(': and its branch goes with it',
  git(REPO, 'rev-parse', '--verify', '--quiet', 'worktree-promptobus-squashed').status !== 0);

// --- the task and the neighbours ----------------------------------------------------
const after = store.readTask(HOME, TASK);
check(': the task is still active and still lists every participant, the swept one included',
  after.status === 'active' && store.addressesOf(after).includes('worker:accepted')
  && store.addressesOf(after).includes('worker:neighbour'),
  JSON.stringify({ status: after.status, addresses: store.addressesOf(after) }));
check(': the neighbour keeps its worktree, its branch and its blob',
  existsSync(NEIGHBOUR) && git(REPO, 'rev-parse', '--verify', '--quiet', 'worktree-promptobus-neighbour').status === 0
  && existsSync(neighbourBlob), `${existsSync(NEIGHBOUR)} · ${existsSync(neighbourBlob)}`);
check(': the neighbour keeps its own secrets — the sweep took one address, not a role',
  [neighbourSecrets.mcp, neighbourSecrets.settings, neighbourSecrets.wake, neighbourSecrets.stand].every(existsSync),
  [neighbourSecrets.mcp, neighbourSecrets.settings, neighbourSecrets.wake, neighbourSecrets.stand].filter((at) => !existsSync(at)).join(', '));
check(': the neighbour mailbox is untouched — the sweep reads mail and never takes it',
  readdirSync(store.inboxDir(HOME, TASK, 'worker:neighbour')).length === neighbourInboxBefore,
  `${readdirSync(store.inboxDir(HOME, TASK, 'worker:neighbour')).length} of ${neighbourInboxBefore}`);

// --- the keep list, by existence and by line count ----------------------------------
check(': every canonical message survived — the count is the same as before the sweep',
  readdirSync(store.messagesDir(HOME, TASK)).length === messagesBefore,
  `${readdirSync(store.messagesDir(HOME, TASK)).length} of ${messagesBefore}`);
check(': health, the warden log and the stall mark are all still there',
  [store.healthFile(HOME, TASK), store.wardenLogFile(HOME, TASK), store.stallsFile(HOME, TASK)].every(existsSync),
  [store.healthFile(HOME, TASK), store.wardenLogFile(HOME, TASK), store.stallsFile(HOME, TASK)].filter((at) => !existsSync(at)).join(', '));
check(': the warden log kept every line — a truncated log is a lost delivery latency',
  countLines(store.wardenLogFile(HOME, TASK)) === wardenLinesBefore,
  `${countLines(store.wardenLogFile(HOME, TASK))} of ${wardenLinesBefore}`);
check(': the wait sidecar of the SWEPT participant kept every line — it is its throughput',
  countLines(telemetry.throughputSidecarFile(HOME, TASK, 'worker:accepted')) === throughputBefore,
  `${countLines(telemetry.throughputSidecarFile(HOME, TASK, 'worker:accepted'))} of ${throughputBefore}`);
// The guard itself, on the decision it makes. Every removal the sweep performs goes through
// it, so a path dropped from the list is a path the sweep would be free to take.
const kept = keptPaths(HOME, TASK);
check(': the keep list names the journal, the messages, the mailboxes and all four sidecars',
  [store.healthFile(HOME, TASK), store.wardenLogFile(HOME, TASK), store.stallsFile(HOME, TASK),
    store.messagesDir(HOME, TASK), path.join(store.taskDir(HOME, TASK), 'waits'),
    path.join(store.taskDir(HOME, TASK), 'inbox'), path.join(store.taskDir(HOME, TASK), 'history'),
    store.taskFile(HOME, TASK)].every((at) => kept.includes(at)),
  kept.join(', '));
check(': the guard refuses a removal aimed at a canonical message, at a mailbox and at health',
  [path.join(store.messagesDir(HOME, TASK), 'x.json'),
    path.join(store.taskDir(HOME, TASK), 'inbox', 'worker-neighbour', 'x.json'),
    path.join(store.taskDir(HOME, TASK), 'waits', 'worker-accepted.throughput.jsonl'),
    store.healthFile(HOME, TASK), store.wardenLogFile(HOME, TASK), store.stallsFile(HOME, TASK),
    store.taskFile(HOME, TASK)].every((at) => keptBy(at, kept)),
  '');
check(': and it lets through exactly what the sweep takes — a blob, a files entry, a worktree',
  ![path.join(store.blobsDir(HOME, TASK), 'deadbeef'),
    path.join(store.filesDir(HOME, TASK), 'gates-neighbour.json'),
    store.participantMcpPath(HOME, TASK, 'worker:neighbour'), NEIGHBOUR].some((at) => keptBy(at, kept)),
  '');

// --- what the keep list is FOR --------------------------------------------------
//
// The strongest form of the check, because it judges the list by its purpose: close the
// task and read what `done` wrote. A row for the swept participant that still carries its
// throughput and delivery numbers is only possible if every source survived the sweep.
const TELEMETRY = telemetry.telemetryFileOf(HOST);
rmSync(TELEMETRY, { force: true });
const noSessions = () => ({});
await capture(async () => done(SB, { task: TASK, snapshot: noSessions }));
const rows = readFileSync(TELEMETRY, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const swept = rows.find((r) => r.model === 'claude-opus-accepted');
check(': after the sweep the closed task still writes one telemetry row per lifted participant',
  rows.length === 6, `${rows.length}: ${rows.map((r) => r.model).join(', ')}`);
check(': the swept piece still has a row — the sweep did not erase it from the run',
  !!swept && swept.role === 'worker' && swept.tuple === 'claude.opus.high',
  JSON.stringify(swept ?? null).slice(0, 200));
check(': its throughput survived — that number is read from the wait sidecar',
  Number.isFinite(swept?.throughput?.outputTokens) && swept.throughput.outputTokens === 420,
  JSON.stringify(swept?.throughput ?? null));
check(': its delivery latency survived — that number is read from health and the warden log',
  swept?.deliverySamples > 0 && Number.isFinite(swept.deliveryLatencySec),
  JSON.stringify({ deliverySamples: swept?.deliverySamples, deliveryLatencySec: swept?.deliveryLatencySec }));
check(': its message counts survived — they are read from the canonical messages',
  swept?.turns > 0 || swept?.reviewRounds > 0,
  JSON.stringify({ turns: swept?.turns, reviewRounds: swept?.reviewRounds }));

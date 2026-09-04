// Regression on dismissing a finished participant from watch — `promptobus promptobus dismiss`.
// Run: npm test
//
// The subject is silence of the report about exactly the dismissed address. The
// orchestrator accepts the work and closes the participant session itself (`claude stop`),
// and the warden reports that as "GONE" with a lift route and repeats the report up to
// three times: run 0830c gave six postcards on two closed participants. The dismiss mark
// is the knowledge the warden is missing, and the one who closed the session sets it.
//
// Both sides are checked at once: the dismissed one leaves the stalled list, the NOT
// dismissed one stays with the same outcome, the same words, and the same route. Plus
// the command itself — owner gate, refusals, idempotence — and return under watch by a
// repeat lift.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, snapshotOfList, stubCommand, writeHostConfig } from './sandbox.mjs';
import { capture, captureSplit, expectFail } from './console.mjs';

const SB = makeSandbox('promptobus-promptobus-dismiss-');
const ROOT = realpathSync(SB);
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(ROOT, '.promptobus');
const TASK = 'dismiss-t20260830-140000';
const OWNER = 'sess-hozyain-0830';

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const {
  blockedParticipants, pendingStalls, stallLine, status, SPAWN_GRACE_SEC,
} = await import(path.join(here, '..', 'lib', 'status.js'));
const { dismiss } = await import(path.join(here, '..', 'lib', 'dismiss.js'));

// The test sets session identity itself: `sessionIdentity` reads `CLAUDE_CODE_SESSION_ID`,
// and without the substitution the owner gate would be checked differently in a Claude
// Code session (the variable is there) and in CI (it is not). Same trick as in
// promptobus.test.mjs.
const withSession = async (id, fn) => {
  const was = process.env.CLAUDE_CODE_SESSION_ID;
  if (id === null) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = id;
  try { return await fn(); } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = was;
  }
};

store.createTask(HOME, { id: TASK, title: 'приёмка куска и снятие участника', owner: OWNER });

const WORKER = 'worker:api';
const REVIEWER = 'reviewer:api';
const WORKER_NAME = `a2a-${TASK}-api`;
const REVIEWER_NAME = `Review: приёмка (0830-1400)`;
// Both are recorded long ago: the registration window of a freshly spawned participant
// would cover the "no record" outcome before any dismiss, and the check would be silent
// about the wrong thing.
const started = new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString();
store.upsertParticipant(HOME, TASK, store.participantRecord(WORKER, { name: WORKER_NAME, repoAbs: path.join(ROOT, 'klon'), started }));
store.upsertParticipant(HOME, TASK, store.participantRecord(REVIEWER, { name: REVIEWER_NAME, repoAbs: path.join(ROOT, 'klon'), started }));

// Session snapshot is stubbed: participant liveness is the driver's answer after asking
// its harness, and checks must not depend on what the real claude on the run machine
// answers. The snapshot is keyed by the participant ADDRESS and is assembled by the REAL
// driver from a stubbed harness reply — a helper with one home for the whole suite
// ([sandbox.mjs](sandbox.mjs)). A foreign live record in the list is needed to
// self-calibrate liveness: the "is listed" mark is declared only where this harness
// prints a pid at all.
const HARNESS_LIST = [{ id: 'liv001', name: 'Worker: сосед', state: 'working', pid: process.pid }];
const snapOf = snapshotOfList;
const OTHERS = () => snapOf(participants(), HARNESS_LIST);
const participants = () => store.readTask(HOME, TASK).participants;
const seen = () => blockedParticipants(HOME, TASK, participants(), OTHERS());

// --- before dismiss: both are reported ---------------------------------------------
const before = seen();
check(': before dismiss, both gone participants are reported',
  before.length === 2 && before.every((s) => s.kind === 'gone'), JSON.stringify(before));

// --- dismiss: the command -----------------------------------------------------------
const out = await withSession(OWNER, () => capture(() => dismiss(ROOT, { task: TASK, address: REVIEWER })));
check(': the command names the dismissed one and says there will be no reports about them',
  new RegExp(`${REVIEWER} dismissed from watch`).test(out) && /reports about their session/.test(out), out.trim());
check(': the command names the boundary — reports already sent are not recalled',
  /reports already sent/.test(out), out.trim());
check(': the command names that the dismissed mailbox stays',
  /writing to a dismissed address is legal/.test(out), out.trim());

const mark = participants().find((p) => store.addressOf(p) === REVIEWER)?.metadata?.dismissed;
check(': the mark lives in the task store, not in the warden\'s memory',
  typeof mark === 'string' && Number.isFinite(Date.parse(mark)), String(mark));

// --- the main thing: the report is silent about the dismissed and unchanged about others
const after = seen();
check(': there is no report about the dismissed participant',
  after.every((s) => s.address !== REVIEWER), JSON.stringify(after));
check(': the NOT dismissed one is still reported — the same outcome and the same address',
  after.length === 1 && after[0].address === WORKER && after[0].kind === 'gone'
  && after[0].reason === 'no session record in claude agents', JSON.stringify(after));
const workerLine = stallLine(after[0], TASK);
check(': words and route of the not-dismissed one did not change in anything',
  /GONE: no session record in claude agents/.test(workerLine)
  && /lift the worker again with the same spawn/.test(workerLine), workerLine);

// The warden report channel is the same predicate: `reportStalls` asks `pendingStalls`,
// and the dismissed one does not reach the journal exactly because they do not reach
// the stalled list.
const { fresh } = pendingStalls(HOME, TASK, (ps) => blockedParticipants(HOME, TASK, ps, snapOf(ps, HARNESS_LIST)));
check(': the dismissed one does not reach the warden journal, the not-dismissed one does',
  fresh.length === 1 && fresh[0].address === WORKER, JSON.stringify(fresh.map((s) => s.address)));

// --- dismiss is whole, not only the "GONE" outcome ---------------------------------
//
// Between dismiss and `claude stop` the session is still alive and can stall on a
// permission prompt. A filter by outcome would make silence depend on a race of two
// orchestrator commands: if the orchestrator closed the session before the warden
// round — quiet, if not — a postcard.
const BLOCKED = snapOf(participants(), [
  ...HARNESS_LIST,
  { id: 'p111', name: REVIEWER_NAME, state: 'blocked', waitingFor: 'permission prompt', pid: 4242 },
  { id: 'p222', name: WORKER_NAME, state: 'blocked', waitingFor: 'permission prompt', pid: 4243 },
]);
const stalls = blockedParticipants(HOME, TASK, participants(), BLOCKED);
check(': the dismissed one is silent on a stall of a live session too — watch is dismissed whole',
  stalls.length === 1 && stalls[0].address === WORKER && stalls[0].kind === 'permission',
  JSON.stringify(stalls));

// --- a repeat is idempotent -------------------------------------------------------
const again = await withSession(OWNER, () => capture(() => dismiss(ROOT, { task: TASK, address: REVIEWER })));
check(': a repeat dismiss says "was already dismissed" and does not touch the journal',
  /already dismissed/.test(again) && participants().find((p) => store.addressOf(p) === REVIEWER)?.metadata?.dismissed === mark,
  `${again.trim()} · ${participants().find((p) => store.addressOf(p) === REVIEWER)?.metadata?.dismissed}`);

// --- writing to the dismissed one is legal ----------------------------------------
//
// Decision in the code: dismiss kills warden reports, not the address. A `send` refusal
// would be a lost message where the mechanism promises delivery — bus truth lives in
// the mailbox, and a participant lifted again will fetch it on the first `inbox`.
store.sendMessage(HOME, TASK, {
  from: 'orchestrator', to: REVIEWER, type: 'review', body: 'ещё один круг по тому же диффу',
});
check(': a dismissed address can be written to, and the message sits in its mailbox',
  store.countInbox(HOME, TASK, REVIEWER) === 1, String(store.countInbox(HOME, TASK, REVIEWER)));

// --- return under watch by a repeat lift ------------------------------------------
//
// Neither `promptobus spawn` nor `promptobus review` carry the former participant
// record over — they put it whole again. The new record has no mark, and an address
// lifted again is under watch: no separate command is needed for that.
store.upsertParticipant(HOME, TASK, store.participantRecord(REVIEWER, { name: REVIEWER_NAME, repoAbs: path.join(ROOT, 'klon'), started }));
const relifted = seen();
check(': lifted again — the participant is under watch again',
  relifted.length === 2 && relifted.some((s) => s.address === REVIEWER), JSON.stringify(relifted));

// --- owner gate -------------------------------------------------------------------
// The refusal goes through `fail()` — print and exit, no stack: a stack in a refusal
// addressed to a person would stop being a sign of an internal CLI break.
const foreign = await withSession('sess-gost', () => expectFail(() => dismiss(ROOT, { task: TASK, address: WORKER })));
check(': a foreign session does not dismiss a participant — reports go to the mailbox owner',
  foreign.failed && /mailbox owner/.test(foreign.out) && foreign.out.includes(OWNER)
  && foreign.out.includes('sess-gost') && /mailbox \{claim: true\}/.test(foreign.out), foreign.out);
check(': the gate refusal does not touch the journal',
  participants().find((p) => store.addressOf(p) === WORKER)?.metadata?.dismissed === undefined,
  JSON.stringify(participants().find((p) => store.addressOf(p) === WORKER)));

// --- refusals --------------------------------------------------------------------
const noAddr = await withSession(OWNER, () => expectFail(() => dismiss(ROOT, { task: TASK })));
check(': without an address — a refusal with a ready command and the participant list',
  noAddr.failed && /name the participant address/.test(noAddr.out) && noAddr.out.includes(WORKER), noAddr.out);

const stranger = await withSession(OWNER,
  () => expectFail(() => dismiss(ROOT, { task: TASK, address: 'worker:net-takogo' })));
check(': a foreign address — a refusal with the participant list, not a silent mark',
  stranger.failed && /has no participant/.test(stranger.out) && stranger.out.includes(REVIEWER), stranger.out);

const self = await withSession(OWNER,
  () => expectFail(() => dismiss(ROOT, { task: TASK, address: 'orchestrator' })));
check(': the orchestrator is not dismissed — there are no reports about them',
  self.failed && /there are no reports about them/.test(self.out), self.out);

// --- dismiss is visible in promptobus status --------------------------------------
//
// Without the line, silence of reports is indistinguishable from a dead warden. Print
// takes the session snapshot through the same stub seam as the predicate above. There
// is no `claude` PATH stub here at all: `dismiss` itself does not ask the harness —
// task resolve, the owner gate, and the participant write never reach the session list.
await withSession(OWNER, () => capture(() => dismiss(ROOT, { task: TASK, address: REVIEWER })));
const printed = await withSession(OWNER,
  () => captureSplit(() => status(ROOT, { task: TASK, sessions: OTHERS() })));
const reviewerLine = printed.out.split('\n').find((l) => l.includes(REVIEWER)) ?? '';
const workerStatusLine = printed.out.split('\n').find((l) => l.includes(WORKER)) ?? '';
check(': promptobus status names the dismiss — otherwise silence of reports cannot be explained',
  /DISMISSED FROM WATCH/.test(reviewerLine), reviewerLine || printed.out.trim());
check(': the not-dismissed one does not get a promptobus status dismiss line',
  !/DISMISSED FROM WATCH/.test(workerStatusLine), workerStatusLine || printed.out.trim());

// Fixture task to check that dismiss does not pretend to be a close: its status stays.
check(': dismissing a participant does not close the task',
  store.readTask(HOME, TASK).status === 'active', store.readTask(HOME, TASK).status);

// --- : re-review of a live session puts the participant back under watch ---------
//
// The `plan.reuse` branch in [review.js](../lib/review.js) does not rewrite the
// participant record at all — a live reviewer only gets a message with the new diff.
// So a dismissed reviewer given a new round would work without watch and stall in
// silence: the orchestrator would wait for a report that will not come, and a stop
// report would not arrive.
//
// The check goes THROUGH the real `promptobus review` path, not by faking
// `upsertParticipant`: the subject here is that the needed call sits in the needed
// command branch, and a forged participant record would only prove the store works.
const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

// Workspace on top of the same sandbox: `promptobusHome(ROOT)` is one for the command
// and the checks.
writeFileSync(path.join(ROOT, 'AGENTS.md'), 'workspace\n');
writeHostConfig(ROOT);
// The workspace root is itself a git repository, as in life: without that the clone
// toplevel walks up, to the root.
g(ROOT, 'init', '-b', 'main');
const REPO = path.join(ROOT, 'repos', 'loads_search', 'cargos-api');
mkdirSync(REPO, { recursive: true });
g(REPO, 'init', '-b', 'main');
writeFileSync(path.join(REPO, 'a.txt'), 'v1\n');
g(REPO, 'add', '.');
g(REPO, 'commit', '-m', 'init', '-q');
// The diff is the review subject: without changes the command answers "nothing to
// review" and never reaches the re-review branch at all.
writeFileSync(path.join(REPO, 'a.txt'), 'v2\n');

const REUSE_TASK = 'reuse-t20260830-160000';
const REUSE_ADDR = 'reviewer:cargos-api';
const REUSE_SESSION = 'Review: переревью снятого (0830-1600)';
store.createTask(HOME, { id: REUSE_TASK, title: 'переревью снятого', owner: OWNER });
store.upsertParticipant(HOME, REUSE_TASK, store.participantRecord(REUSE_ADDR, { repo: 'loads_search/cargos-api', repoAbs: REPO,
  name: REUSE_SESSION, session: 'cafe12', started }));
// Live reviewer session: the plan decides from it that a second one must not be lifted
// (`plan.reuse`). Here a `claude` PATH stub is needed for real: `promptobus review`
// asks the session list itself, the command has no seam of its own, and a live
// `claude agents --json` of the run machine would decide for the check whether to
// lift a second reviewer.
const LIVE = [{ id: 'cafe12', name: REUSE_SESSION, state: 'working', pid: process.pid }];
const BIN = path.join(ROOT, 'bin');
mkdirSync(BIN, { recursive: true });
stubCommand(BIN, 'claude', `process.stdout.write(${JSON.stringify(JSON.stringify(LIVE))});`);
const PATH_WAS = process.env.PATH;
process.env.PATH = `${BIN}${path.delimiter}${PATH_WAS}`;

await withSession(OWNER, () => capture(() => dismiss(ROOT, { task: REUSE_TASK, address: REUSE_ADDR })));
const dismissedBefore = () => store.readTask(HOME, REUSE_TASK).participants
  .find((p) => store.addressOf(p) === REUSE_ADDR)?.metadata?.dismissed;
check(': the reviewer is dismissed and is listed as dismissed before the re-review',
  typeof dismissedBefore() === 'string'
  && blockedParticipants(HOME, REUSE_TASK, store.readTask(HOME, REUSE_TASK).participants,
    snapOf(store.readTask(HOME, REUSE_TASK).participants, [])).length === 0,
  String(dismissedBefore()));

const { review } = await import(path.join(here, '..', 'lib', 'review.js'));
const reviewOut = await withSession(OWNER,
  () => capture(() => review(ROOT, { target: REPO, task: REUSE_TASK })));
process.env.PATH = PATH_WAS;
check(': the command took the live-session re-review branch, not a second lift',
  /already on the bus/.test(reviewOut), reviewOut.trim().split('\n').slice(-4).join(' | '));
check(': re-review cleared the mark — the new assignment put the participant back under watch',
  dismissedBefore() === undefined, JSON.stringify(store.readTask(HOME, REUSE_TASK).participants));
check(': the return is named out loud — the orchestrator sees that reports go again',
  /was dismissed from watch — the new assignment put them back/.test(reviewOut),
  reviewOut.trim().split('\n').slice(-4).join(' | '));
// The session is alive but stalled — and a report about it goes again: watch returned
// not only in words.
const backUnderWatch = blockedParticipants(HOME, REUSE_TASK, store.readTask(HOME, REUSE_TASK).participants,
  snapOf(store.readTask(HOME, REUSE_TASK).participants,
    [{ id: 'cafe12', name: REUSE_SESSION, state: 'blocked', waitingFor: 'permission prompt', pid: process.pid }]));
check(': one who returned under watch is reported again — and by a stall, not by disappearance',
  backUnderWatch.length === 1 && backUnderWatch[0].address === REUSE_ADDR
  && backUnderWatch[0].kind === 'permission',
  JSON.stringify(backUnderWatch));

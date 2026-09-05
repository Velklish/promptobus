// Regression test for the bus task warden (stage 2).
// Run: npm test
//
// Subject — bus listening, moved out of the model into a process: the single listener for all
// of a task's mailboxes wakes the addressee by injecting into their messaging socket, and keeps
// state in the store, not in itself. As of  it is also the task's only alarm clock. Five
// branches are checked, the ones this was all built for:
//
//   • delivery — a knock goes to whoever has unread mail, and not to whoever is empty;
//   • postcard content — the text of a short message rides in it as text, a long one and an
//     artifact go as a counter, and the postcard's overall budget is never exceeded;
//   • stop — written to the log, no postcard is sent;
//   • fallback to self-wake — there is no contact point, or the driver's channel did not accept
//     the notification;
//   • health — silence longer than the threshold is escalated, exactly once.
//
// As of  the parsing of participant state (`status.js`) also lives here: the stall report is
// its only consumer on the bus, and it moved here along with it.
//
// The socket here is real (`net.createServer` on a unix path): among other things this checks
// the wire's shape — two lines of JSON, auth first. The test never touches a live `claude`.
import { createServer } from 'node:net';
import { existsSync, linkSync, mkdirSync, statSync, readFileSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath, snapshotOfList, stubCommand, withStubPath } from './sandbox.mjs';
import { capture } from './console.mjs';

const SB = makeSandbox('promptobus-promptobus-warden-');
const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(SB, '.promptobus');
const TASK = 'sup-t20260829-150000';
const SESSION = 'sess-sup-0001';

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));
const HOST = hostOf(SB);
const wdn = await import(path.join(here, '..', 'lib', 'warden.js'));
const { wardenLine, status, WARDEN_MARK, stallLine, blockedParticipants, orchestratorDeadLine } =
  await import(path.join(here, '..', 'lib', 'status.js'));
// The delivery channel, its text, handing over the contact point, and parsing session state
// all live behind the driver's contract: `warden.js` no longer re-exports them — it does not
// import the driver at all, and this guards the adapter boundary gate. The suite takes them
// from home.
const {
  claudeDriver, KNOCK_FROM, knockSocket, orderBody, probeWake, registerWake, sayForeignWrite,
  sessionDetail, sessionStall, renderNotification, stallRoute,
} = await import(path.join(here, '..', 'lib', 'driver-claude.js'));
// A live snapshot is used only by the guard for check : it proves that the watch loop's
// zero calls come from the loop itself, not from records with no session name.
const { snapshotOf } = await import(path.join(here, '..', 'lib', 'drivers.js'));
const { KNOCK_TEXT_MAX } = await import(path.join(here, '..', 'lib', 'contract.js'));
// The version is taken from the declaration, not a literal: when the proven version is
// bumped, the fixture must move with it, or the test would be checking a stale requirement.
const { PROVEN_CLAUDE_VERSION } = await import(path.join(here, '..', 'lib', 'driver-claude.js'));

store.createTask(HOME, { id: TASK, title: 'надзиратель задачи', owner: SESSION });
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:api'));

const send = (to, body) => store.sendMessage(HOME, TASK, { from: 'orchestrator', to, type: 'task', body });
const health = () => store.readHealth(HOME, TASK);

// The session snapshot is the state machine's input and the print seam. The home helper is
// shared by the whole suite ([sandbox.mjs](sandbox.mjs)): the real Claude driver builds the
// snapshot from a stubbed harness response; the suite never touches a live `claude`.
const snapOf = snapshotOfList;

const snap = (task, list) => snapOf(store.readTask(HOME, task).participants, list);

// Parsing a stall from a stubbed harness response: the snapshot is built over the same
// participants the predicate asks about — the same way the watch loop builds it.
// A participant arrives here flat — address and session name — while stall parsing works on
// v1 records. The adapter does the conversion, and here the suite plays that role: the same
// `participantRecord` the mechanism's door uses to write a participant.
const asRecords = (ps) => ps.map((p) => (p.metadata ? p : store.participantRecord(p.address, p)));
const asRecord = (p) => asRecords([p])[0];
const blocked = (task, ps, list) => {
  const recs = asRecords(ps);
  return blockedParticipants(HOME, task, recs, snapOf(recs, list));
};

// Knock stub: accumulates calls and answers with whatever it's told to. This is the only
// point where the watch loop reaches outward — the rest of the loop is checked with no
// sockets or timers.
function stubKnock(reply = { ok: true }) {
  const calls = [];
  const fn = async (endpoint, body) => {
    calls.push({ endpoint, body });
    return typeof reply === 'function' ? reply(calls.length) : reply;
  };
  fn.calls = calls;
  return fn;
}

// --- warden mark: liveness, claim, heartbeat ------------------------

check('no warden — no mark', store.liveWarden(HOME, TASK) === null);

const claimed = store.claimWarden(HOME, TASK, { cli: '0.45.0' });
check('the spot is taken: the mark is its own, with pid and CLI version',
  claimed.mark?.pid === process.pid && claimed.mark.cli === '0.45.0',
  JSON.stringify(claimed));
check('a live warden reads back through its own mark', store.liveWarden(HOME, TASK)?.pid === process.pid);

const second = store.claimWarden(HOME, TASK, { pid: process.pid + 100000 });
check('a second claim while the first is alive is refused and names the holder',
  !second.mark && second.busy?.pid === process.pid, JSON.stringify(second));

// Liveness is pid AND heartbeat freshness — both conditions. The system reuses process
// numbers, so pid alone isn't enough; otherwise a process killed between heartbeats would be
// counted alive until the end of the term, with no delivery happening the whole time.
store.writeJsonAtomic(store.wardenMarkFile(HOME, TASK), {
  pid: process.pid,
  started: new Date(Date.now() - 3600_000).toISOString(),
  beat: new Date(Date.now() - store.WARDEN_BEAT_SEC * 4000).toISOString(),
});
check('a live pid with a stale heartbeat is not counted alive', store.liveWarden(HOME, TASK) === null);

store.writeJsonAtomic(store.wardenMarkFile(HOME, TASK), {
  pid: 999_999_999,
  started: new Date().toISOString(),
  beat: new Date().toISOString(),
});
check('a fresh heartbeat does not make a dead process alive', store.liveWarden(HOME, TASK) === null);

check('a heartbeat does not extend someone else\'s mark',
  store.beatWarden(HOME, TASK, { pid: process.pid }) === null);
check('cleanup does not clear someone else\'s mark either', store.clearWarden(HOME, TASK, process.pid) === false);

store.claimWarden(HOME, TASK, { cli: '0.45.0' });
const beat = store.beatWarden(HOME, TASK);
check('a heartbeat extends its own mark', typeof beat?.beat === 'string' && beat.pid === process.pid);

// --- contact point --------------------------------------------------------

// The socket path comes from the shared helper ([sandbox.mjs](sandbox.mjs)): the `sun_path`
// limit, the path shape on Windows, and directory cleanup are its concern, not this file's.
const sockPath = makeSockPath('a2s-');
const SOCK = sockPath('w');

check('nothing to hand over — no file appears',
  registerWake(HOME, TASK, 'worker:api', {}) === null && store.readWake(HOME, TASK, 'worker:api') === null);

const wake = registerWake(HOME, TASK, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 'deadbeef',
});
check('a handed-over contact point holds the socket address and the token',
  wake?.socket === SOCK && wake.token === 'deadbeef', JSON.stringify(wake));

// The token is a secret: the file must be closed off from other users of the machine. The
// same lesson as the participant's mcp config.
check(`the contact point file is locked down with 0600 permissions`,
  (statSync(store.wakeFile(HOME, TASK, 'worker:api')).mode & 0o777) === 0o600,
  (statSync(store.wakeFile(HOME, TASK, 'worker:api')).mode & 0o777).toString(8));

// Session identity in the contact point. The `session` field is the only thing that ties
// the point to a session when parsing after the fact, and it has exactly one env var name:
// `CLAUDE_CODE_SESSION_ID`. A typo once cost the field its content entirely — it was empty
// always, and silently: `session` does not affect delivery, the knock travels over the
// socket.
const wakeSess = registerWake(HOME, TASK, 'worker:sess', {
  CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 'deadbeef',
  CLAUDE_CODE_SESSION_ID: 'sess-a2a-0042',
});
check(': contact point carries the id of the session that handed it over',
  wakeSess?.session === 'sess-a2a-0042' && store.readWake(HOME, TASK, 'worker:sess')?.session === 'sess-a2a-0042',
  JSON.stringify(wakeSess));
check(': the environment does not know the name CLAUDE_SESSION_ID — the field is not filled from it',
  registerWake(HOME, TASK, 'worker:mis', {
    CLAUDE_CODE_MESSAGING_SOCKET: SOCK, CLAUDE_SESSION_ID: 'sess-nope',
  })?.session === undefined,
  JSON.stringify(store.readWake(HOME, TASK, 'worker:mis')));

const before = readFileSync(store.wakeFile(HOME, TASK, 'worker:api'), 'utf8');
registerWake(HOME, TASK, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: SOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 'deadbeef',
});
check('handing over the same thing again rewrites nothing',
  readFileSync(store.wakeFile(HOME, TASK, 'worker:api'), 'utf8') === before);

// --- delivery -----------------------------------------------------------------

const idle = stubKnock();
await wdn.wardenRound(HOME, TASK, { knock: idle });
check(`empty mailboxes — nobody to knock for`, idle.calls.length === 0);

send('worker:api', 'бриф');
const first = stubKnock();
const r1 = await wdn.wardenRound(HOME, TASK, { knock: first });
check(`unread in the mailbox — the knock goes to its addressee`,
  first.calls.length === 1 && first.calls[0].endpoint.socket === SOCK,
  JSON.stringify(first.calls.map((c) => c.endpoint)));
check(`only the one with something waiting gets knocked: the orchestrator is empty — no notification`,
  !first.calls.some((c) => c.endpoint.address === 'orchestrator'));

// The recipient will wrap the injection body in an "Another Claude session sent a message"
// frame with a paragraph of warnings, and the sender cannot get around it. So the text must
// be self-sufficient and rely on the bus protocol, not on a human's authority: the spike's
// measurement showed that a request sounding like an order from the user gets set aside by
// the participant.
const body = first.calls[0].body;
check('the injection body names the task, the address, and the unread count',
  body.includes(TASK) && body.includes('worker:api') && /has unread: 1/.test(body), body);
check(`: a short message rides in the postcard as text`,
  body.includes('бриф') && /task from orchestrator/.test(body), body);
check(': the postcard still points to the inbox — only fetching it marks messages read',
  body.includes('mailbox') && /Fetch the mailbox|only mailbox marks messages read/.test(body), body);
check('the injection body relies on the bus rules and disclaims any escalation of privileges',
  /in the bus rules/.test(body) && /grants no permissions/.test(body), body);

const h1 = health()['worker:api'];
check(`health recorded the driver's channel (socket, for Claude Code), the knock counter, and the start of the wait`,
  h1.channel === 'socket' && h1.knocks === 1 && h1.unread === 1 && typeof h1.since === 'string',
  JSON.stringify(h1));
check('the delivery event went into the warden log',
  r1.events.some((e) => /notification worker:api/.test(e))
  && store.tailWardenLog(HOME, TASK, 20).some((l) => /notification worker:api/.test(l)),
  JSON.stringify(r1.events));

// A re-knock no more often than the threshold: a session that received a notification reaches
// the mailbox within seconds, while one busy with a long turn legitimately stays silent for
// minutes — knocking on every loop would be noise in someone else's feed.
const again = stubKnock();
await wdn.wardenRound(HOME, TASK, { knock: again });
check('a repeat loop on the same state does not knock', again.calls.length === 0);

const retry = stubKnock();
await wdn.wardenRound(HOME, TASK, { knock: retry, now: Date.now() + wdn.KNOCK_RETRY_SEC * 1000 + 1000 });
check('past the re-knock threshold the notification repeats', retry.calls.length === 1);
check('the knock counter grows', health()['worker:api'].knocks === 2);

// A new message on top of the old one is a different state: it can't wait for the re-knock
// threshold, the participant may not have received the first notification at all.
send('worker:api', 'уточнение');
const grew = stubKnock();
await wdn.wardenRound(HOME, TASK, { knock: grew });
check('a new message wakes immediately, without waiting for the threshold', grew.calls.length === 1);
check(`the notification body carries the new unread count`, /has unread: 2/.test(grew.calls[0].body));

// --- delivery confirmation: an observable reaction ------------------------------

// A zero return code from the socket does not confirm delivery: a drop past the queue limit
// is silent to the sender. There is exactly one sign — the mailbox has been fetched.
const sinceBefore = health()['worker:api'].since;
store.readInbox(HOME, TASK, 'worker:api');
const done = stubKnock();
const r2 = await wdn.wardenRound(HOME, TASK, { knock: done });
check('a fetched mailbox is exactly the delivery confirmation',
  r2.events.some((e) => /delivered worker:api/.test(e)), JSON.stringify(r2.events));
check('the wait counters are reset, delivery is stamped with a time',
  health()['worker:api'].unread === 0 && health()['worker:api'].since === null
  && typeof health()['worker:api'].deliveredAt === 'string' && sinceBefore !== null,
  JSON.stringify(health()['worker:api']));
check(`an empty mailbox gets no knock`, done.calls.length === 0);

// --- fallback to self-wake -------------------------------------------------------

// A channel failure does not bring the warden down: the participant is marked self-wake, the
// event goes into the log, delivery to everyone else continues.
send('orchestrator', 'отчёт');
const noWake = stubKnock();
const r3 = await wdn.wardenRound(HOME, TASK, { knock: noWake });
check(`no contact point — no knock, and the channel is self-wake`,
  noWake.calls.length === 0 && health().orchestrator.channel === 'self-wake',
  JSON.stringify(health().orchestrator));
check('the fallback is named in the warden log',
  r3.events.some((e) => /fell back to self-wake orchestrator/.test(e)), JSON.stringify(r3.events));

// A participant with no contact point enters the delivery branch on EVERY loop: `knockedAt`
// is never set for it, and it may hand over a socket only after the message has already
// landed. So the branch itself must be entered — but it must not write health on every loop,
// or the watch loop would write to disk once a second until the mailbox is fetched. We catch
// this by the file's modification time: an unchanged loop leaves it untouched.
const HFILE = store.healthFile(HOME, TASK);
const PAST = Math.floor(Date.now() / 1000) - 3600;
utimesSync(HFILE, PAST, PAST);
await wdn.wardenRound(HOME, TASK, { knock: stubKnock() });
check('a loop with no change does not rewrite health',
  Math.floor(statSync(HFILE).mtimeMs / 1000) === PAST,
  `${Math.floor(statSync(HFILE).mtimeMs / 1000)} vs ${PAST}`);

registerWake(HOME, TASK, 'orchestrator', { CLAUDE_CODE_MESSAGING_SOCKET: SOCK, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
const T1 = Date.now() + wdn.KNOCK_RETRY_SEC * 1000 + 1000;
const refused = stubKnock({ ok: false, error: 'ENOENT' });
const r4 = await wdn.wardenRound(HOME, TASK, { knock: refused, now: T1 });
// Claude Code: channel `socket`, the log word is "socket". Other harnesses — package
// (`driver.test.mjs`): a failure writes `inject` / `rpc`, not the literal "socket".
check('the socket did not accept the notification — the channel falls back to self-wake with a reason',
  health().orchestrator.channel === 'self-wake' && health().orchestrator.knockError === 'ENOENT',
  JSON.stringify(health().orchestrator));
check('the failure reason is named in the log',
  r4.events.some((e) => /did not accept the notification \(ENOENT\)/.test(e)), JSON.stringify(r4.events));

// A failure is throttled by the same threshold as success — otherwise an unresponsive socket
// would get an attempt every second (over twenty thousand connections in six hours), and a
// socket that accepts but stays silent would cost KNOCK_TIMEOUT_MS per loop and delay
// notifications to the other participants. The threshold is counted from the time of the
// ATTEMPT, while `knockedAt` remains the time of the last successful delivery.
const again2 = stubKnock({ ok: false, error: 'ENOENT' });
await wdn.wardenRound(HOME, TASK, { knock: again2, now: T1 + 1000 });
check('a failed knock does not repeat every loop — the threshold is counted from the attempt time',
  again2.calls.length === 0, String(again2.calls.length));
check('the attempt time is recorded, and the delivery time is not overwritten by a failure',
  typeof health().orchestrator.triedAt === 'string' && !health().orchestrator.knockedAt,
  JSON.stringify(health().orchestrator));
check('a repeated failure with the same reason does not flood the log',
  !(await wdn.wardenRound(HOME, TASK, { knock: stubKnock({ ok: false, error: 'ENOENT' }), now: T1 + wdn.KNOCK_RETRY_SEC * 1000 + 1000 }))
    .events.some((e) => /fell back to self-wake orchestrator/.test(e)));

// The participant restarted and handed over a DIFFERENT socket: the previous address is dead
// by construction, and sitting out the threshold on it would mean keeping the participant
// asleep exactly where it just became reachable.
const SOCK2 = sockPath('orch2');
registerWake(HOME, TASK, 'orchestrator', { CLAUDE_CODE_MESSAGING_SOCKET: SOCK2, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
const moved = stubKnock();
const rm = await wdn.wardenRound(HOME, TASK, { knock: moved, now: T1 + 2000 });
check('a rewritten contact point wakes immediately, without sitting out the threshold',
  moved.calls.length === 1 && moved.calls[0].endpoint.socket === SOCK2,
  JSON.stringify(moved.calls.map((c) => c.endpoint.socket)));
check('the rewritten contact point is named in the log',
  rm.events.some((e) => /contact point rewritten/.test(e)), JSON.stringify(rm.events));

// --- health: silence longer than the threshold -------------------------------------------

const late = Date.now() + (wdn.SILENCE_SEC + 60) * 1000;
const r5 = await wdn.wardenRound(HOME, TASK, { knock: stubKnock(), now: late });
check('silence longer than the threshold is escalated with a reason',
  r5.events.some((e) => /SILENT orchestrator/.test(e)) && typeof health().orchestrator.escalatedAt === 'string',
  JSON.stringify(r5.events));

const r6 = await wdn.wardenRound(HOME, TASK, { knock: stubKnock(), now: late + 60_000 });
check('escalation happens once — the log is not flooded with the same fact',
  !r6.events.some((e) => /SILENT orchestrator/.test(e)), JSON.stringify(r6.events));

// --- : the watch loop does not request a session snapshot -----------------------
//
// The snapshot arrives as an argument to the loop and is held in the loop variable until the
// heartbeat. As long as that's true, there's no need to cache a failed parse of
// `claude agents --json`; have the loop start requesting the snapshot itself, and on an
// unparsed response the process would launch every second (the measurement and the condition
// are in the `wardenRound` comment, [warden.js](../lib/warden.js)).
// The check guards exactly this property: the loop runs WITHOUT a snapshot and still never
// calls the binary. The count is by the stub binary's argv, not by coverage points in the
// code.
const ROUND_BIN = path.join(SB, 'round-bin');
const ROUND_LOG = path.join(SB, 'round-calls.log');
stubCommand(ROUND_BIN, 'claude', [
  "import { appendFileSync } from 'node:fs';",
  `appendFileSync(${JSON.stringify(ROUND_LOG)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
  "process.stdout.write('[]');",
].join('\n'));
const roundCalls = () => (existsSync(ROUND_LOG) ? readFileSync(ROUND_LOG, 'utf8') : '')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((argv) => argv[0] === 'agents' && argv.includes('--json'));
// A dedicated task, where participants MUST carry a session name: the snapshot is only built
// over such records, and on nameless ones the check would be a no-op — a loop taking the
// snapshot itself wouldn't call the binary for those either (a mutation probe catches this
// right here).
const ROUND_TASK = 'krug-t20260902-110000';
store.createTask(HOME, { id: ROUND_TASK, title: 'круг и снимок', owner: SESSION });
for (const [i, addr] of ['worker:api', 'worker:web'].entries()) {
  store.upsertParticipant(HOME, ROUND_TASK, store.participantRecord(addr, { name: `Worker: круг ${i}` }));
  store.sendMessage(HOME, ROUND_TASK, { from: 'orchestrator', to: addr, type: 'task', body: 'работай' });
}
const roundBack = withStubPath(ROUND_BIN);
const rounds = [];
try {
  for (let i = 0; i < 3; i += 1) {
    rounds.push(await wdn.wardenRound(HOME, ROUND_TASK, { knock: stubKnock(), now: Date.now() }));
  }
} finally { roundBack(); }
check(': the watch loop does not request a session snapshot — `claude agents --json` is never called across three loops',
  roundCalls().length === 0 && rounds.length === 3 && rounds.every((r) => r.stop === null),
  `${JSON.stringify(roundCalls())} · ${JSON.stringify(rounds.map((r) => r.stop))}`);
// Guard for the check itself: taking a snapshot over these participants does cost a binary
// launch, so the zero above is a property of the loop, not of nameless records.
const roundSnapCalls = (() => {
  const back = withStubPath(ROUND_BIN);
  try {
    snapshotOf(store.readTask(HOME, ROUND_TASK).participants);
    return roundCalls().length;
  } finally { back(); }
})();
check(': a snapshot over the same participants does call the binary — the loop check is not a no-op',
  roundSnapCalls === 1, String(roundSnapCalls));

// --- warden visibility ----------------------------------------------------

const aliveLine = wardenLine(HOME, TASK, HOST);
check('a live warden is visible as a line with pid and the proven binary version',
  aliveLine.alive && aliveLine.line.includes(String(process.pid)) && aliveLine.line.includes(`claude ${PROVEN_CLAUDE_VERSION}`),
  aliveLine.line);

// A warden's death must be visible: a process nobody is watching quietly stops delivering,
// and the run just looks "slow".
store.clearWarden(HOME, TASK);
const deadLine = wardenLine(HOME, TASK, HOST);
check('a dead warden is named out loud, with a restart route',
  !deadLine.alive && deadLine.line.startsWith(WARDEN_MARK) && deadLine.line.includes('promptobus warden'),
  deadLine.line);

// Printing takes the session snapshot through the same seam the watch loop uses: without it
// `status` would ask the run machine's live `claude agents --json`.
const out = capture(() => status(SB, { task: TASK, sessions: snap(TASK, []) }));
check('promptobus status prints that the warden is dead', out.includes(WARDEN_MARK), out);
const deadOrch = health().orchestrator ?? {};
check('promptobus status on orchestrator ENOENT names the dead owner and the claim command, not self-wake',
  out.includes(orchestratorDeadLine(SESSION, deadOrch.triedAt ?? deadOrch.since))
  && /SILENT/.test(out)
  && !/alarm: self-wake \(reason: ENOENT\)/.test(out),
  out);
check('promptobus status prints the tail of the warden journal', /warden journal/.test(out), out);

// --- : what a postcard carries -----------------------------------------------

// The text budget is shared across the whole postcard, not a per-message threshold: a batch
// of five short ones would otherwise give a postcard five times bigger than the longest of
// them.
const short = { type: 'answer', from: 'orchestrator', ts: 'T1', body: 'да, делай' };
const long = { type: 'result', from: 'worker:api', ts: 'T2', body: 'ы'.repeat(KNOCK_TEXT_MAX + 1) };
const withArt = { type: 'artifact', from: 'worker:api', ts: 'T3', body: 'дифф', artifact: 'diff.patch' };

const one = orderBody(TASK, 'orchestrator', 1, [short]);
check(': a short message rides out as text in full',
  one.includes('да, делай') && one.includes('answer from orchestrator'), one);

const big = orderBody(TASK, 'orchestrator', 1, [long]);
check(': a long message rides out as a counter with its own size, not a fragment',
  !big.includes('ыыы') && big.includes(`text ${KNOCK_TEXT_MAX + 1} characters`), big);

const art = orderBody(TASK, 'orchestrator', 1, [withArt]);
check(': a message with an artifact rides out as a counter, however short it is',
  !art.includes('дифф') && art.includes('artifact diff.patch'), art);

// The budget is spent in order of arrival: what arrived first rides out first. A message that
// ate almost the whole budget leaves no room for its neighbor — that one goes out as a
// counter or in the tail, but never silently vanishes.
const half = { type: 'status', from: 'worker:api', ts: 'T4', body: 'я'.repeat(KNOCK_TEXT_MAX - 80) };
const pack = orderBody(TASK, 'orchestrator', 2, [half, short]);
check(': the budget is shared across the postcard — the first one fit whole, the second no longer does',
  pack.includes(half.body) && !pack.includes('да, делай'), pack.slice(0, 400));
check(': what did not fit is named, not swallowed',
  /— and 1 more: fetch the mailbox|text 9 characters/.test(pack), pack.slice(-300));
check(': the postcard does not grow past the budget plus its own frame',
  pack.length < KNOCK_TEXT_MAX * 2, String(pack.length));

// The budget holds the ENTIRE block of digests, not the sum of the bodies (review note): every
// line carries a "type from address · time" header, and fifty unread messages would give a
// postcard in the kilobytes while formally staying within budget. What does not fit counts as
// the tail — cutting the batch off silently is not allowed.
const pack50 = Array.from({ length: 50 }, (_, i) => (
  { type: 'status', from: 'worker:api', ts: `T${i}`, body: `тело сообщения ${i} `.repeat(8) }));
const packed = orderBody(TASK, 'orchestrator', 50, pack50);
// The limit is checked EXACTLY, not "approximately": the postcard's frame is constant and is
// read off an empty call, everything else is the digest block, and it must fit inside the
// budget in full, including the line separators and room for the tail. A loose "budget plus
// slack" check let through a mutation that removed the room reserved for the tail.
const frame = orderBody(TASK, 'orchestrator', 0, []).length;
check(': a batch of fifty fits inside the budget in full',
  packed.length - frame <= KNOCK_TEXT_MAX, `${packed.length - frame} at a budget of ${KNOCK_TEXT_MAX}`);
check(': the budget is spent, not left idle — the batch took up almost all of it',
  packed.length - frame > KNOCK_TEXT_MAX - 100, String(packed.length - frame));
check(': what did not fit is named as a tail, not swallowed',
  /— and \d+ more: fetch the mailbox/.test(packed), packed.slice(-300));
// Headers count against the budget the same as bodies: a batch of short lines, where the
// bodies weigh almost nothing, still hits the limit and produces a tail.
const tiny = Array.from({ length: 60 }, (_, i) => (
  { type: 'status', from: 'worker:very-long-address-here', ts: `2026-08-30T00:00:${i}`, body: 'ок' }));
const tinyCard = orderBody(TASK, 'orchestrator', 60, tiny);
check(': headers count against the budget — with short bodies there is still a tail',
  /— and \d+ more: fetch the mailbox/.test(tinyCard), tinyCard.slice(-200));
// The worst case for the budget isn't long bodies but MANY short lines: that's where there
// are the most separators, and where room for the tail is tightest. Mutations that removed
// either of these two costs stayed green on the long batch and are only caught here.
check(': a batch of short lines also fits inside the budget in full',
  tinyCard.length - frame <= KNOCK_TEXT_MAX, `${tinyCard.length - frame} at a budget of ${KNOCK_TEXT_MAX}`);

// The warden does not parse a broken message and does not set it aside: that report is
// addressed to the mailbox reader, and its `warn` goes to stdio: 'ignore'.
const GLANCE = 'sup-glance-t20260829-160003';
store.createTask(HOME, { id: GLANCE, title: 'заглянуть в ящик', owner: SESSION });
store.upsertParticipant(HOME, GLANCE, store.participantRecord('worker:api'));
store.sendMessage(HOME, GLANCE, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'целое' });
const inbox = store.inboxDir(HOME, GLANCE, 'worker:api');
writeFileSync(path.join(inbox, '20260829T000000000-9999-orchestrator.json'), '{битое');
const glanced = store.glanceInbox(HOME, GLANCE, 'worker:api');
check(': glanceInbox returns the intact messages and stays quiet about the broken one',
  glanced.length === 1 && glanced[0].body === 'целое', JSON.stringify(glanced));
check(`: the broken one stays in the mailbox — its own reader will parse it, not the warden`,
  existsSync(path.join(inbox, '20260829T000000000-9999-orchestrator.json')));

// --- raising the warden with any command ----------------------------------------

// The mark above was cleared for the "a dead warden is visible" check — put it back: the
// branch "nobody re-raises a live one" is checked exactly on a live one.
store.claimWarden(HOME, TASK, { cli: '0.45.0' });

let launches = 0;
const launch = () => { launches += 1; return 4242; };
check('nobody re-raises a live warden',
  wdn.ensureWarden(HOME, TASK, { env: {}, launch, host: HOST }) === null && launches === 0);

store.clearWarden(HOME, TASK);
check('any command raises a dead one, and the raise names the pid',
  wdn.ensureWarden(HOME, TASK, { env: {}, launch, host: HOST }) === 4242 && launches === 1);

check('the PROMPTOBUS_WARDEN=off switch turns off auto-raise',
  wdn.ensureWarden(HOME, TASK, { env: { PROMPTOBUS_WARDEN: 'off' }, launch, host: HOST }) === null && launches === 1);
check('the switch is case- and whitespace-insensitive',
  wdn.wardenOff({ PROMPTOBUS_WARDEN: ' OFF ' }) === true && wdn.wardenOff({}) === false);

const CLOSED = 'sup-closed-t20260829-150001';
store.createTask(HOME, { id: CLOSED, title: 'закрытая', owner: SESSION });
store.closeTask(HOME, CLOSED);
check('nobody watches a closed task',
  wdn.ensureWarden(HOME, CLOSED, { env: {}, launch, host: HOST }) === null && launches === 1);
const stopped = await wdn.wardenRound(HOME, CLOSED, { knock: stubKnock() });
check('the watch loop on a closed task exits with a reason', stopped.stop === 'task is closed', stopped.stop);

// The auto-raise trace, for the runner's gate. It is written at the point the "raise" decision
// is made, not inside the detached process: the gate reads the file right after the run, it
// has nothing to chase a just-launched process with. No env var means no file at all: outside
// the test suite this trace does not exist.
const TRACE = path.join(SB, 'raised.log');
// Read gently: a trace that wasn't written is a red check, not a file crash on an exception.
// A crash would take the neighboring verdicts down with it, and a mutation probe would stop
// telling "it lied" apart from "it didn't survive".
const traceLines = () => {
  try {
    return readFileSync(TRACE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
store.clearWarden(HOME, TASK);
wdn.ensureWarden(HOME, TASK, { env: { PROMPTOBUS_WARDEN_TRACE: TRACE }, launch, host: HOST });
const trace1 = traceLines();
check(': auto-raise leaves a trace with the task and the pid',
  trace1.length === 1 && trace1[0].includes(`task ${TASK}`) && trace1[0].includes('pid 4242'),
  JSON.stringify(trace1));

wdn.ensureWarden(HOME, TASK, { env: { PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_WARDEN_TRACE: TRACE }, launch, host: HOST });
check(': an auto-raise turned off by the switch leaves no trace',
  traceLines().length === 1, JSON.stringify(traceLines()));

// --- the wire: a real unix socket ---------------------------------------------

// The wire's shape was taken off the binary with a spike: line-delimited JSON, auth as the
// first line, followed by a message with `msgV`, `msg_id`, and the body in
// `message.content`. We check it on a real socket — a knock stub would never catch this kind
// of mistake.
const LIVE_SOCK = sockPath('live');
const seen = [];
const server = createServer((c) => {
  let buf = '';
  c.on('data', (d) => { buf += d; });
  c.on('end', () => { seen.push(buf); c.destroy(); });
});
await new Promise((res) => server.listen(LIVE_SOCK, res));

const knocked = await knockSocket({ socket: LIVE_SOCK, token: 'tok123' }, 'проверка провода');
await new Promise((res) => setTimeout(res, 50));
const lines = (seen[0] ?? '').trim().split('\n').map((l) => JSON.parse(l));
check('the knock arrived and landed as two lines of JSON', knocked.ok === true && lines.length === 2, JSON.stringify(seen));
check('the first line is auth with the token',
  lines[0]?.type === 'auth' && lines[0].token === 'tok123', JSON.stringify(lines[0]));
check('the second is an injection-protocol message with the order body',
  lines[1]?.msgV === 1 && lines[1].type === 'user' && typeof lines[1].msg_id === 'string'
  && lines[1].message?.content === 'проверка провода' && lines[1].from === KNOCK_FROM,
  JSON.stringify(lines[1]));

// The auth line is always sent, even when there's no token: on macOS it isn't checked at all,
// on Windows it's required, and code without it doesn't port.
seen.length = 0;
await knockSocket({ socket: LIVE_SOCK }, 'без токена');
await new Promise((res) => setTimeout(res, 50));
check('with no token the auth line still goes out',
  JSON.parse((seen[0] ?? '{}').split('\n')[0]).type === 'auth', JSON.stringify(seen));

seen.length = 0;
const probed = await probeWake(LIVE_SOCK, 'tok123');
await new Promise((res) => setTimeout(res, 50));
check('the doctor smoke test connects and sends ONLY auth — it does not touch someone else\'s turn',
  probed.ok === true && (seen[0] ?? '').trim().split('\n').length === 1, JSON.stringify(seen));

const dead = await knockSocket({ socket: sockPath('no-such') }, 'в пустоту');
check('a nonexistent socket — a failure with a reason, not an exception',
  dead.ok === false && typeof dead.error === 'string', JSON.stringify(dead));

await new Promise((res) => server.close(res));

// --- : the knock goes out on any unread ------------------------------
//
// There is one alarm clock in a task, and it's the warden: unread mail is the only condition
// for a knock. Checked on a REAL socket with a real `knockSocket` (the `knock` seam is not
// stubbed in here): "there was a knock" on a stub would only mean the stub got called, and
// the question is about the wire — did a connection arrive or not.
const WAITED = 'sup-knock-t20260829-160000';
store.createTask(HOME, { id: WAITED, title: 'стук на непрочитанном', owner: SESSION });
store.upsertParticipant(HOME, WAITED, store.participantRecord('worker:api', { name: 'Worker: адресат стука' }));
const WSOCK = sockPath('bl312');
const knocks = [];
const wserver = createServer((c) => {
  let buf = '';
  c.on('data', (d) => { buf += d; });
  c.on('end', () => { knocks.push(buf); c.destroy(); });
});
await new Promise((res) => wserver.listen(WSOCK, res));
registerWake(HOME, WAITED, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: WSOCK, CLAUDE_CODE_MESSAGING_TOKEN: 'tok312',
});
const settle = () => new Promise((res) => setTimeout(res, 50));

store.sendMessage(HOME, WAITED, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'бриф' });
await wdn.wardenRound(HOME, WAITED);
await settle();
const wired = (knocks[0] ?? '').trim().split('\n').map((l) => JSON.parse(l));
check(': the knock goes out immediately — unread mail is the whole condition',
  knocks.length === 1 && wired.length === 2 && wired[0]?.type === 'auth'
  && wired[1]?.message?.content.includes('worker:api') && wired[1].message.content.includes('бриф'),
  JSON.stringify(knocks).slice(0, 300));

// --- : a stall does not spawn a notification --------------------------------------
//
// A stalled session sends no messages: the orchestrator's mailbox is empty, and there's no way
// to learn of the stall from it. Escalation is visibility: the warden log and the
// `promptobus status` line. The stall postcard has been removed: it was burning the
// orchestrator's turns on every loop until the stall was cleared.
const STALLED = 'sup-stall-t20260829-160004';
store.createTask(HOME, { id: STALLED, title: 'доклад о вставших', owner: SESSION });
store.upsertParticipant(HOME, STALLED, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, STALLED, store.participantRecord('worker:api', { name: 'Worker: вставший' }));
registerWake(HOME, STALLED, 'orchestrator', {
  CLAUDE_CODE_MESSAGING_SOCKET: WSOCK, CLAUDE_CODE_MESSAGING_TOKEN: 'tok312',
});
const BLOCKED = [{ id: 'sb', name: 'Worker: вставший', state: 'blocked', pid: process.pid, waitingFor: 'permission prompt' }];

knocks.length = 0;
const rs1 = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, BLOCKED) });
await settle();
check(': a stall does not spawn a notification',
  knocks.length === 0, String(knocks.length));
const stallLineOf = (taskId, sessions) => {
  const listed = blockedParticipants(HOME, taskId, store.readTask(HOME, taskId).participants, sessions);
  return listed.map((s) => stallLine(s, taskId));
};
check(': the stall is named in the warden log',
  rs1.length === 1 && rs1[0] === stallLineOf(STALLED, snap(STALLED, BLOCKED))[0]
  && /permission prompt/.test(rs1[0]) && /claude attach/.test(rs1[0]),
  JSON.stringify(rs1));

knocks.length = 0;
const rs2 = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, BLOCKED) });
await settle();
check(': the same stall a second time floods neither the log nor produces a knock',
  knocks.length === 0 && rs2.length === 0, `${knocks.length} · ${JSON.stringify(rs2)}`);

// No contact point needed: there's nothing to deliver. The mark is set right away.
const LOST = 'sup-lost-t20260829-160005';
store.createTask(HOME, { id: LOST, title: 'стоп без сокета', owner: SESSION });
store.upsertParticipant(HOME, LOST, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, LOST, store.participantRecord('worker:api', { name: 'Worker: вставший' }));
knocks.length = 0;
const rl1 = await wdn.reportStalls(HOME, LOST, { sessions: snap(LOST, BLOCKED) });
check(': with no contact point the stall is still written, and there is no knock',
  knocks.length === 0 && rl1.length === 1 && /worker:api stalled: permission prompt/.test(rl1[0]),
  `${knocks.length} · ${JSON.stringify(rl1)}`);
const rl2 = await wdn.reportStalls(HOME, LOST, { sessions: snap(LOST, BLOCKED) });
check(': a repeat with no socket produces no knock either',
  knocks.length === 0 && rl2.length === 0, `${knocks.length} · ${JSON.stringify(rl2)}`);

// The participant unstuck — the mark is cleared, or its next stall with the same reason
// would not count as fresh.
const ALIVE_AGAIN = [{ id: 'sb', name: 'Worker: вставший', state: 'busy', pid: process.pid }];
await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, ALIVE_AGAIN) });
knocks.length = 0;
const rsAgain = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, BLOCKED) });
await settle();
check(': the participant unstuck and stalled again — a new log entry, no knock',
  knocks.length === 0 && rsAgain.length === 1 && /worker:api stalled: permission prompt/.test(rsAgain[0]),
  `${knocks.length} · ${JSON.stringify(rsAgain)}`);

const later = (n) => Date.now() + n * (wdn.KNOCK_RETRY_SEC * 1000 + 1000);
knocks.length = 0;
await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, BLOCKED), now: later(1) });
await settle();
check(': the re-knock threshold does not repeat the stall — the postcard was removed along with the repeats',
  knocks.length === 0, String(knocks.length));

const OTHER = [{ id: 'sb', name: 'Worker: вставший', state: 'blocked', pid: process.pid, waitingFor: 'sandbox request' }];
knocks.length = 0;
const rsOther = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, OTHER), now: later(10) });
await settle();
const otherLine = stallLineOf(STALLED, snap(STALLED, OTHER))[0];
check(': a change of reason — a new log entry, no knock',
  knocks.length === 0 && rsOther.length === 1 && rsOther[0] === otherLine
  && /sandbox request/.test(rsOther[0]),
  `${knocks.length} · ${JSON.stringify(rsOther)}`);

knocks.length = 0;
const rn = await wdn.reportStalls(HOME, STALLED, { sessions: null });
check(': an unparsed session list produces no stall',
  knocks.length === 0 && rn.length === 0, JSON.stringify(rn));
const afterUnknown = await wdn.reportStalls(HOME, STALLED, { sessions: snap(STALLED, OTHER) });
await settle();
check(': not-known does not erase the mark — the same stall is not repeated in the log',
  knocks.length === 0 && afterUnknown.length === 0, `${knocks.length} · ${JSON.stringify(afterUnknown)}`);

const NOWAKE = 'sup-nowake-t20260829-160006';
store.createTask(HOME, { id: NOWAKE, title: 'стоп без сокета оркестратора', owner: SESSION });
store.upsertParticipant(HOME, NOWAKE, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, NOWAKE, store.participantRecord('worker:api', { name: 'Worker: вставший' }));
const rnw = await wdn.reportStalls(HOME, NOWAKE, { sessions: snap(NOWAKE, BLOCKED) });
check(': the orchestrator never handed over a socket — the stall is still in the log, no knock',
  rnw.length === 1 && /worker:api stalled: permission prompt/.test(rnw[0]), JSON.stringify(rnw));

await new Promise((res) => wserver.close(res));

// --- heartbeat and exit branches ------------------------------

// The `warden` process was not covered at all: the watch loop and the store primitives were
// checked, but the loop, the heartbeat, and the exit reasons were not covered by anything. A
// direct consequence of that lived on: the "no live participants remain" exit was
// unreachable, and there was nothing to notice it with.
//
// The bg session list here is always a fixture: behind the real one stands the external
// `claude agents --json`, and the suite never touches a live `claude`.

const BEAT = 'sup-beat-t20260829-150002';
store.createTask(HOME, { id: BEAT, title: 'удар сердца', owner: SESSION });
store.upsertParticipant(HOME, BEAT, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, BEAT, store.participantRecord('worker:api', { name: 'Worker: удар сердца' }));
const ALIVE = [{ id: 'sx', name: 'Worker: удар сердца', state: 'busy', pid: process.pid }];

// The warden's question is "is there anyone left to wake", and `orchestrator` (the human's
// session, invisible in `claude agents`) does not answer it: counting it as alive, the list
// never emptied — that was the bug.
check(': a participant with an observed session counts as alive, orchestrator without one does not',
  wdn.liveWatched(HOME, BEAT, snap(BEAT, ALIVE)).join(',') === 'worker:api',
  wdn.liveWatched(HOME, BEAT, snap(BEAT, ALIVE)).join(','));
check(': participants\' sessions are dead — the task emptied out, and it shows',
  wdn.liveWatched(HOME, BEAT, snap(BEAT, [])).length === 0, wdn.liveWatched(HOME, BEAT, snap(BEAT, [])).join(','));
check('an unparsed session list does not get recorded as dead',
  wdn.liveWatched(HOME, BEAT, null).join(',') === 'worker:api',
  wdn.liveWatched(HOME, BEAT, null).join(','));

// Registration window: a just-raised session is not in the list AT ALL, and without the
// window a fresh worker would be declared dead the very second the window exists to prevent.
const FRESH = 'sup-fresh-t20260829-150003';
store.createTask(HOME, { id: FRESH, title: 'окно регистрации', owner: SESSION });
store.upsertParticipant(HOME, FRESH, store.participantRecord('worker:new', { name: 'Worker: только что', started: new Date().toISOString() }));
check('a just-raised session is not yet listed, but is not counted as dead',
  wdn.liveWatched(HOME, FRESH, snap(FRESH, [])).join(',') === 'worker:new',
  wdn.liveWatched(HOME, FRESH, snap(FRESH, [])).join(','));

// A successor took over the mark — this one is now counted dead, and a task can't be watched
// by two at once.
store.writeJsonAtomic(store.wardenMarkFile(HOME, BEAT), {
  pid: 999_999_999, started: new Date().toISOString(), beat: new Date().toISOString(),
});
check('a heartbeat against someone else\'s mark — exit, not a silent extension',
  wdn.beatRound(HOME, BEAT, Date.now(), { sessions: snap(BEAT, ALIVE) }) === 'another process took the warden place',
  String(wdn.beatRound(HOME, BEAT, Date.now(), { sessions: snap(BEAT, ALIVE) })));

// Its own mark, but aged: the heartbeat must move it forward — the warden's liveness is read
// off the mark's freshness.
const staleBeat = new Date(Date.now() - 60_000).toISOString();
store.writeJsonAtomic(store.wardenMarkFile(HOME, BEAT),
  { pid: process.pid, started: staleBeat, beat: staleBeat });
const startedMs = Date.now();
check('live participants and its own mark — keep watching',
  wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, ALIVE) }) === null,
  String(wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, ALIVE) })));
check('the heartbeat extended its own mark',
  store.liveWarden(HOME, BEAT)?.beat > staleBeat, store.liveWarden(HOME, BEAT)?.beat);

check(': no live participants remain — the exit reason is named',
  wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) }) === 'no live participants remain',
  String(wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) })));

// "Nobody to wake" and "nothing to deliver" are not the same thing (review note). A worker
// sent a `result`, its session got shut down: nobody is alive, unread mail is sitting there,
// and the re-knock path is still needed — a drop past the queue limit is silent, and if the
// warden left now, the delivery record would go with it.
store.sendMessage(HOME, BEAT, { from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог' });
check('unread mail holds the listener even when nobody is left alive',
  wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) }) === null,
  String(wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) })));
store.readInbox(HOME, BEAT, 'orchestrator');
check('the mailbox is fetched — nothing left to hold on to, and the process exits',
  wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) }) === 'no live participants remain',
  String(wdn.beatRound(HOME, BEAT, startedMs, { sessions: snap(BEAT, []) })));

// The ceiling is checked by substituting time, not by waiting out six hours.
const capped = wdn.beatRound(HOME, BEAT, startedMs - wdn.WARDEN_TOTAL_SEC * 1000,
  { now: startedMs, sessions: snap(BEAT, ALIVE) });
check('sitting out the overall ceiling names itself as the exit reason',
  capped === 'sat out the overall ceiling 6 h', String(capped));
check('a few seconds short of the ceiling — keep sitting',
  wdn.beatRound(HOME, BEAT, startedMs - wdn.WARDEN_TOTAL_SEC * 1000 + 1000,
    { now: startedMs, sessions: snap(BEAT, ALIVE) }) === null);

// --- the process itself --------------------------------------------------------------

// The spot is taken by a live process — a second one does not come up at all: one mailbox
// watched by two would give two knocks for one message.
const BUSY = 'sup-busy-t20260829-150004';
store.createTask(HOME, { id: BUSY, title: 'занятое место', owner: SESSION });
store.claimWarden(HOME, BUSY, { cli: '0.45.0' });
const busyOut = await capture(() => wdn.warden({ host: HOST, task: BUSY }, { PROMPTOBUS_HOME: HOME }, SB));
check('the spot is taken by a live one — the process leaves, naming the holder',
  /already running/.test(busyOut) && busyOut.includes(String(process.pid))
  && !store.tailWardenLog(HOME, BUSY, 20).some((l) => /warden started/.test(l)),
  busyOut);

// The task closed — the process ends on its own, on the very first loop, and clears its own
// mark.
const closedOut = await capture(() => wdn.warden({ host: HOST, task: CLOSED }, { PROMPTOBUS_HOME: HOME }, SB));
check('a closed task: the process exits with a reason and clears its own mark',
  /exited: task is closed/.test(closedOut) && store.liveWarden(HOME, CLOSED) === null, closedOut);
check('the exit reason also went into the task log',
  store.tailWardenLog(HOME, CLOSED, 20).some((l) => /warden exited · task is closed/.test(l)),
  store.tailWardenLog(HOME, CLOSED, 20).join('\n'));

// The loop exits on an emptied-out task. The suite does not wait out thirty seconds of
// heartbeat: the process's clock is substituted, not the constant. `new Date()` does not
// depend on the substitution, so the timestamps in the store stay real.
const LOOP = 'sup-loop-t20260829-150005';
store.createTask(HOME, { id: LOOP, title: 'цикл надзирателя', owner: SESSION });
store.upsertParticipant(HOME, LOOP, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, LOOP, store.participantRecord('worker:api'));
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow.call(Date) + skew;
// The clock shifts only AFTER the start: `lastBeat` is taken on entry, and a constant shift
// would not have brought the heartbeat any closer.
const shift = setTimeout(() => { skew = (store.WARDEN_BEAT_SEC + 1) * 1000; }, 20);
// A safeguard against an endless loop: should the live-participants exit fail to fire, the
// task closes, the process exits for a different reason, and a single verdict turns red
// instead of the whole run.
const guard = setTimeout(() => store.closeTask(HOME, LOOP), 15_000);
const loopOut = await capture(() => wdn.warden({ host: HOST, task: LOOP }, { PROMPTOBUS_HOME: HOME }, SB));
clearTimeout(shift);
clearTimeout(guard);
Date.now = realNow;
check(': the loop exits on an emptied-out task, rather than sitting out the ceiling',
  /exited: no live participants remain/.test(loopOut), loopOut);
check('the warden mark is cleared on exit', store.liveWarden(HOME, LOOP) === null);

// --- : the task's last stall is written to the log on the same loop as the exit ---------
//
// The participant died, mailboxes are empty — `beatRound` returns "no live participants
// remain" and the loop exits. Had the stall record been written AFTER the verdict, this
// stall would never have made it into the log. No postcard is sent either way.
const LAST = 'sup-last-t20260829-150007';
store.createTask(HOME, { id: LAST, title: 'последний стоп', owner: SESSION });
store.upsertParticipant(HOME, LAST, store.participantRecord('orchestrator', { owner: SESSION }));
store.upsertParticipant(HOME, LAST, store.participantRecord('worker:api', { name: 'Worker: исчезнувший' }));
const LSOCK = sockPath('bl312last');
const lastCards = [];
const lserver = createServer((c) => {
  let buf = '';
  c.on('data', (d) => { buf += d; });
  c.on('end', () => { lastCards.push(buf); c.destroy(); });
});
await new Promise((res) => lserver.listen(LSOCK, res));
registerWake(HOME, LAST, 'orchestrator', {
  CLAUDE_CODE_MESSAGING_SOCKET: LSOCK, CLAUDE_CODE_MESSAGING_TOKEN: 'toklast',
});
// The stubbed `claude agents --json` returns an empty list: the participant's session is not
// there at all — that's the `gone` outcome, which is also "no live participants remain" for
// `liveWatched`.
const LAST_BIN = path.join(SB, 'binlast');
mkdirSync(LAST_BIN, { recursive: true });
writeFileSync(path.join(LAST_BIN, 'claude'), '#!/bin/sh\nprintf \'%s\' \'[]\'\n');
chmodSync(path.join(LAST_BIN, 'claude'), 0o755);
const PATH_WAS = process.env.PATH;
process.env.PATH = `${LAST_BIN}${path.delimiter}${PATH_WAS}`;
const realNowLast = Date.now;
let skewLast = 0;
Date.now = () => realNowLast.call(Date) + skewLast;
const shiftLast = setTimeout(() => { skewLast = (store.WARDEN_BEAT_SEC + 1) * 1000; }, 20);
const guardLast = setTimeout(() => store.closeTask(HOME, LAST), 15_000);
const lastOut = await capture(() => wdn.warden({ host: HOST, task: LAST }, { PROMPTOBUS_HOME: HOME }, SB));
clearTimeout(shiftLast);
clearTimeout(guardLast);
Date.now = realNowLast;
process.env.PATH = PATH_WAS;
await new Promise((res) => setTimeout(res, 100));
check(': the loop exited on an emptied-out task',
  /exited: no live participants remain/.test(lastOut), lastOut);
const lastLog = store.tailWardenLog(HOME, LAST, 40);
check(': the last stall is in the log on that same loop — no postcard',
  lastCards.length === 0 && lastLog.some((l) => /worker:api GONE/.test(l)),
  `cards ${lastCards.length} · ${lastLog.slice(-8).join(' | ')}`);
await new Promise((res) => lserver.close(res));

// The loop failed repeatedly — the process exits with a reason, rather than grinding through
// failures until the ceiling. The failure is real: a directory sits where health.json should
// be, and the atomic write never once succeeds.
const FAIL = 'sup-fail-t20260829-150006';
store.createTask(HOME, { id: FAIL, title: 'отказ круга', owner: SESSION });
store.upsertParticipant(HOME, FAIL, store.participantRecord('worker:api'));
store.sendMessage(HOME, FAIL, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'бриф' });
mkdirSync(store.healthFile(HOME, FAIL), { recursive: true });
const failOut = await capture(() => wdn.warden({ host: HOST, task: FAIL }, { PROMPTOBUS_HOME: HOME }, SB));
check(`the watch loop failed ${wdn.ROUND_FAIL_LIMIT} times in a row — exit with a reason`,
  new RegExp(`exited: watch round failed ${wdn.ROUND_FAIL_LIMIT} times in a row`).test(failOut), failOut);
check('each failure is numbered in the warden log',
  store.tailWardenLog(HOME, FAIL, 20)
    .filter((l) => new RegExp(`watch round failed \\(\\d/${wdn.ROUND_FAIL_LIMIT}\\)`).test(l))
    .length === wdn.ROUND_FAIL_LIMIT,
  store.tailWardenLog(HOME, FAIL, 20).join('\n'));

// --- participant state diagnostics (, , ) ----
//
// A stalled session sends no messages, and it can only be noticed by session state. Parsing
// that state and both lines about it live in status.js: they're read by the warden report
// above, by `promptobus status` printing, and by the `mailbox` reply. The state probe here is
// stubbed — a live `claude agents --json` is never called, the only subject is what gets
// reported and how many times.
const {
  stallTail, justSpawned,
  SPAWN_GRACE_SEC, pendingStalls, commitStalls, stallStands, sessionBusy,
} = await import(path.join(here, '..', 'lib', 'status.js'));

const DIAG = 'sup-diag-t20260829-170000';
store.createTask(HOME, { id: DIAG, title: 'диагностика состояния участника' });

// The question "what's new" and recording the mark are deliberately kept apart: the warden
// has one report channel, and marking something "reported" ahead of a knock that never went
// out would silently lose the report. They're called here as a pair — the checks below are
// about WHAT the pair counts as fresh.
const freshStalls = (task, probe) => {
  const { fresh, current } = pendingStalls(HOME, task, probe);
  commitStalls(HOME, task, current);
  return fresh;
};

check('sessionStall: a session with no stall marker is alive and stays that way',
  sessionStall({ status: 'waiting' }, null) === null && sessionStall(null, null) === null);

// A stall has at least two causes, and they're treated differently. What tells them apart is
// not the fact of the stall, but what the session is doing: `waitingFor` is only produced by
// one stuck on a dialog, while an exhausted limit is recognized by the harness's own line
// from state.json.
const LIMIT = "You've hit your session limit · resets 6:20am (Europe/Moscow)";
check(': a dialog — permission, the reason comes from waitingFor',
  JSON.stringify(sessionStall({ state: 'blocked', waitingFor: 'permission prompt' }, null))
  === JSON.stringify({ kind: 'permission', reason: 'permission prompt' }));
check(': a limit is recognized by the harness\'s line, not by the fact of the stall',
  JSON.stringify(sessionStall({ state: 'blocked' }, LIMIT))
  === JSON.stringify({ kind: 'limit', reason: LIMIT }));
check(': a reason written in its own words stays the reason, but no route is derived from it',
  JSON.stringify(sessionStall({ state: 'blocked' }, 'awaiting reviewer'))
  === JSON.stringify({ kind: 'unknown', reason: 'awaiting reviewer' }));
check(': no reason at all — bare blocked is printed, not a fabrication',
  sessionStall({ state: 'blocked' }, null).reason === 'blocked');
check(': a dialog outranks the line — on a permission prompt a human is needed no matter what is in detail',
  sessionStall({ state: 'blocked', waitingFor: 'permission prompt' }, LIMIT).kind === 'permission');
// The permission branch does not use the line from state.json, and the warden polls state on
// every heartbeat for every stalled participant: the file is never read for this branch at
// all.
let peeked = 0;
const counting = new Proxy({ state: 'blocked', waitingFor: 'permission prompt' }, {
  get(t, k) { if (k === 'id') peeked += 1; return t[k]; },
});
sessionStall(counting);
check(': on a dialog state.json is not read — no extra file read on every heartbeat',
  peeked === 0, String(peeked));

// The routes are different, and that's the whole point of the split: on a limit there's
// nobody to call a human for.
const rPerm = stallRoute({ kind: 'permission' }, 'abc123', 'Worker: X');
const rLimit = stallRoute({ kind: 'limit' }, 'abc123', 'Worker: X');
const rUnknown = stallRoute({ kind: 'unknown' }, 'abc123', 'Worker: X');
check(': permission calls a human to the session',
  /claude attach abc123/.test(rPerm) && /only a person/.test(rPerm), rPerm);
check(': a limit does not call a human — it resets on its own, wake it with a message',
  /no person needed/.test(rLimit) && /wake the session with a message/.test(rLimit) && !/claude attach/.test(rLimit), rLimit);
check(': an unrecognized reason does not invent a route, it points to the logs',
  /claude logs abc123/.test(rUnknown), rUnknown);

// The reason string lives with the background-session daemon, not in the session list. The
// format is not a contract: no directory, no file, unparsed JSON — no reason.
const CLAUDE_HOME = path.join(SB, 'claude-home');
mkdirSync(path.join(CLAUDE_HOME, 'jobs', 'abc123'), { recursive: true });
writeFileSync(path.join(CLAUDE_HOME, 'jobs', 'abc123', 'state.json'),
  JSON.stringify({ state: 'blocked', detail: LIMIT, tempo: 'blocked' }));
mkdirSync(path.join(CLAUDE_HOME, 'jobs', 'broken'), { recursive: true });
writeFileSync(path.join(CLAUDE_HOME, 'jobs', 'broken', 'state.json'), '{not json');
check(': detail is read from jobs/<id>/state.json',
  sessionDetail('abc123', CLAUDE_HOME) === LIMIT, String(sessionDetail('abc123', CLAUDE_HOME)));
check(': an unparsed or missing state.json — no reason, not a crash',
  sessionDetail('broken', CLAUDE_HOME) === null && sessionDetail('net-takogo', CLAUDE_HOME) === null
  && sessionDetail(null, CLAUDE_HOME) === null);

// The format is not a contract, meaning a multi-line and very long value is a legitimate
// input, not corruption: the session writes its own status there, and a whole paragraph of
// the assignment ended up in it. The reason is printed into a single-line output — the
// participant's `promptobus status` line and the report line — so we flatten it to one line
// here.
mkdirSync(path.join(CLAUDE_HOME, 'jobs', 'multi'), { recursive: true });
writeFileSync(path.join(CLAUDE_HOME, 'jobs', 'multi', 'state.json'),
  JSON.stringify({ state: 'blocked', detail: `  Ты — worker задачи\n\n\tправь только его\n${'х'.repeat(400)}  ` }));
const flatDetail = sessionDetail('multi', CLAUDE_HOME);
check(': a multi-line detail is flattened to one line and truncated by length',
  !/[\n\r\t]/.test(flatDetail) && flatDetail.length <= 160 && flatDetail.endsWith('…')
  && flatDetail.startsWith('Ты — worker задачи правь только его'), `${flatDetail.length}: ${flatDetail}`);
mkdirSync(path.join(CLAUDE_HOME, 'jobs', 'blank'), { recursive: true });
writeFileSync(path.join(CLAUDE_HOME, 'jobs', 'blank', 'state.json'),
  JSON.stringify({ state: 'blocked', detail: '   \n\t ' }));
check(': a whitespace-only detail is the absence of a reason, not an empty string',
  sessionDetail('blank', CLAUDE_HOME) === null, JSON.stringify(sessionDetail('blank', CLAUDE_HOME)));
check(': a reason arriving as an argument is normalized by the same rule',
  sessionStall({ state: 'blocked' }, `waiting\nfor the\treviewer's answer`).reason === `waiting for the reviewer's answer`,
  sessionStall({ state: 'blocked' }, `waiting\nfor the\treviewer's answer`).reason);

store.upsertParticipant(HOME, DIAG, store.participantRecord('worker:api', { name: `a2a-${DIAG}-api` }));
const diagStall = [{
  address: 'worker:api', name: `a2a-${DIAG}-api`, id: 'abc123', kind: 'permission', reason: 'permission prompt',
}];
const firstStall = freshStalls(DIAG, () => diagStall);
check('participant stall: reported with a reason and an address',
  firstStall.length === 1 && firstStall[0].address === 'worker:api' && firstStall[0].reason === 'permission prompt',
  JSON.stringify(firstStall));
check('participant stall: the same stall a second time does not wake — otherwise the orchestrator burns turn after turn',
  freshStalls(DIAG, () => diagStall).length === 0);
check('participant stall: unstuck — the mark is cleared', freshStalls(DIAG, () => []).length === 0);
check('participant stall: stalled again is reported again',
  freshStalls(DIAG, () => diagStall).length === 1);
check('participant stall: session state is unparsed — no alarm',
  freshStalls(DIAG, () => null).length === 0);
// The reason changed — it's a different stall, and it can't be kept quiet: it's treated
// differently.
const limitStall = [{
  address: 'worker:api', name: `a2a-${DIAG}-api`, id: 'abc123', kind: 'limit', reason: LIMIT,
}];
check(': a changed reason is reported again, not counted as the same stall',
  freshStalls(DIAG, () => limitStall).length === 1);

// stalls.json arrives at its place via rename, like the task log: a hard link to the previous
// file keeps the previous content. Written over itself, it would change through the link too
// — and a reader that catches it truncated parses the emptiness as "nothing was reported" and
// reports the same stall a second time.
const STALLS = 'otmetki-t20260829-050000';
store.createTask(HOME, { id: STALLS, title: 'отметка доложенных стопов' });
const oneStall = [{ address: 'worker:api', name: 'api', id: 'sess-1', kind: 'limit', reason: 'limit' }];
freshStalls(STALLS, () => oneStall);
const stallsPath = path.join(store.taskDir(HOME, STALLS), 'stalls.json');
const heldStalls = path.join(SB, 'stalls-held.json');
linkSync(stallsPath, heldStalls);
freshStalls(STALLS, () => [{ ...oneStall[0], reason: 'another reason' }]);
check(': stalls.json is not written over itself — the new file is put in place via rename',
  !readFileSync(heldStalls, 'utf8').includes('another reason')
  && readFileSync(stallsPath, 'utf8').includes('another reason'));

// --- : behind a dead record there is nobody, and that is not a stall --------------------

// A record that outlived its own daemon is told apart from a live one by the absence of
// `pid`, and the signal is self-calibrating: "LISTED" can only be declared where this
// `claude` prints a pid at all. That's why a live record with a pid sits next to it in the
// list.
const GHOST_NAME = `a2a-${DIAG}-ghost`;
const ghostList = [
  { id: 'live1', name: `a2a-${DIAG}-alive`, state: 'working', pid: 5151 },
  { id: 'ghost1', name: GHOST_NAME, state: 'blocked' },
];
const ghostSeen = blocked(DIAG, [{ address: 'worker:ghost', name: GHOST_NAME }], ghostList);
check(': a dead record is marked stale, not a stall — it also has state=blocked',
  ghostSeen.length === 1 && ghostSeen[0].kind === 'stale' && ghostSeen[0].id === 'ghost1',
  JSON.stringify(ghostSeen));
check(': staying quiet about it is not an option either — there will never be messages from it',
  ghostSeen.length === 1, JSON.stringify(ghostSeen));
// The same record, but with a pid: there's a process behind it, and it's an ordinary stall
// with its own route.
const alivePaused = blocked(DIAG,
  [{ address: 'worker:ghost', name: GHOST_NAME }],
  [{ id: 'ghost1', name: GHOST_NAME, state: 'blocked', pid: 7373 }],
);
check(': a live stalled session is still a stall, not "listed"',
  alivePaused[0].kind !== 'stale', JSON.stringify(alivePaused));
const rStale = stallRoute({ kind: 'stale', address: 'worker:ghost' }, 'ghost1', GHOST_NAME);
check(': the route for a dead record does not call for waking with a message — there is nobody to wake',
  /nobody to wake/.test(rStale) && !/SendMessage/.test(rStale) && /claude logs ghost1/.test(rStale), rStale);
check(`: the route for a worker's dead record calls for raising it with the same spawn`,
  /same spawn/.test(rStale) && /worktree/.test(rStale), rStale);
// A reviewer is raised by a different command, and the address `worker:<slug>` does not fit
// it: `promptobus spawn` raises a worker, and a reviewer has no worktree at all (review
// note). The one documented live ghost is exactly a reviewer session.
const REVIEWER_REPO = path.join(SB, 'repos', 'loads_search', 'cargos-api');
const rStaleReviewer = stallRoute(
  { kind: 'stale', address: 'reviewer:cargos-api', repoAbs: REVIEWER_REPO, task: DIAG },
  'ghost2', 'Review: X',
);
check(`: a reviewer's dead record is raised with promptobus review, not a worker's spawn`,
  rStaleReviewer.includes(`promptobus review "${REVIEWER_REPO}" --task ${DIAG}`)
  && !/same spawn/.test(rStaleReviewer) && !/worktree/.test(rStaleReviewer), rStaleReviewer);
check(': the clone path is unknown — the route does not invent it, it names the gap',
  stallRoute({ kind: 'stale', address: 'reviewer:x' }, 'g', 'n').includes('<clone path>'),
  stallRoute({ kind: 'stale', address: 'reviewer:x' }, 'g', 'n'));

// --- : the lines about stalled participants are the same across every channel --------------------
//
// There must be one route for a stall: split apart, the channels would become two different
// pieces of advice about the same state. A shared function assembles the line, `promptobus
// status` prints it, and the `mailbox` reply and the warden postcard repeat the same one.
const stallSample = [{
  address: 'worker:api', ref: 'Worker: X', id: 'abc123', kind: 'permission', reason: 'permission prompt',
}];
const sampleLine = stallLine(stallSample[0], DIAG);
check(': the stalled-participant line is assembled by one function — address, reason, route',
  sampleLine.startsWith('worker:api stalled: permission prompt')
  && sampleLine.includes('claude attach abc123'), sampleLine);
const staleLine = stallLine({ ...stallSample[0], kind: 'stale', reason: 'record outlived its own daemon' }, DIAG);
check(': the same function gives "LISTED" for a record that outlived its daemon',
  staleLine.includes('LISTED, but no process behind it'), staleLine);
// The reason and the caller's own words must not repeat each other: before the fix the line
// said "no process behind it" twice in a row.
check(': the line does not stutter — the absence of a process is said once',
  staleLine.split('no process behind it').length - 1 === 1, staleLine);
check(': the tail on a live stall promises a return, on a dead record it does not',
  /until the stall is cleared/.test(stallTail(stallSample))
  && !/until the stall is cleared/.test(stallTail([{ ...stallSample[0], kind: 'stale' }])), stallTail(stallSample));
// There is no generic advice for all stalled participants: each one has its own route, and it
// lives in its own line. The former shared line called for dropping the session right after a
// route that, on a limit, had just said "no person needed" — merging two different outcomes
// back into one. `claude stop` legitimately sits INSIDE the route for a vanished one: there it
// explains where the record went.
check(': the tail gives no generic advice on top of the route',
  !/claude stop/.test(stallTail([{ kind: 'limit' }, { kind: 'gone' }])),
  stallTail([{ kind: 'limit' }, { kind: 'gone' }]));

// --- : a freshly spawned participant is not a ghost -----------------------------
//
// `promptobus spawn` writes the participant to the log BEFORE the raised session shows up in
// `claude agents --json` with its own pid. A live run on 2026-08-28: session watch declared a
// just-raised worker a ghost and called for "raise it again" — while `claude agents --json` a
// second later showed its session alive (pid 63976, state working).
const FRESH_NAME = `a2a-${DIAG}-fresh`;
const registering = [
  { id: 'live2', name: `a2a-${DIAG}-alive`, state: 'working', pid: 5252 },
  { id: 'fresh1', name: FRESH_NAME, state: 'blocked' },
];
const freshP = { address: 'worker:fresh', name: FRESH_NAME, started: new Date().toISOString() };
check(': a participant just written is not declared a ghost',
  blocked(DIAG, [freshP], registering).length === 0,
  JSON.stringify(blocked(DIAG, [freshP], registering)));
const oldP = { ...freshP, started: new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString() };
check(': the window ended — the same record is read as a ghost again',
  blocked(DIAG, [oldP], registering)[0]?.kind === 'stale',
  JSON.stringify(blocked(DIAG, [oldP], registering)));
check(': a record with no started gets no window — the previous behavior',
  blocked(DIAG, [{ address: 'worker:fresh', name: FRESH_NAME }], registering)[0]?.kind === 'stale');
check(': the window is measured from started, both forward and back',
  justSpawned({ metadata: { started: new Date().toISOString() } }) === true
  && justSpawned({ metadata: { started: new Date(Date.now() - (SPAWN_GRACE_SEC + 1) * 1000).toISOString() } }) === false
  && justSpawned({ metadata: { started: 'not a date' } }) === false && justSpawned({ metadata: {} }) === false
  && justSpawned({ metadata: { started: new Date(Date.now() + 60000).toISOString() } }) === false);
// The "stall reported" mark does not get set inside the window: a real stall after it must be
// reported as new, rather than swallowed by a false alarm.
const FRESH_TASK = 'fresh-t20260828-160000';
store.createTask(HOME, { id: FRESH_TASK, title: 'окно регистрации' });
store.upsertParticipant(HOME, FRESH_TASK, asRecords([freshP])[0]);
check(': inside the window no mark is set and there is no report',
  freshStalls(FRESH_TASK, (ps) => blocked(FRESH_TASK, ps, registering)).length === 0);
store.upsertParticipant(HOME, FRESH_TASK, asRecords([oldP])[0]);
check(': after the window the same stall is reported as new',
  freshStalls(FRESH_TASK, (ps) => blocked(FRESH_TASK, ps, registering)).length === 1);

// --- : "no record" and "the clock shifted" --------------------------------
//
// A participant whose record is no longer in `claude agents` used to simply be skipped:
// whether the session was dropped by a human or the raise failed, session watch never found
// out — exactly the case it was built for.
const goneP = {
  address: 'worker:snyat', name: `a2a-${DIAG}-snyat`, repoAbs: '/tmp/klon',
  session: 'was42', started: new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString(),
};
const goneSeen = blocked(DIAG, [goneP], registering);
check(': the participant\'s record is not in the list — a report, not silence',
  goneSeen.length === 1 && goneSeen[0].kind === 'gone'
  && goneSeen[0].address === 'worker:snyat', JSON.stringify(goneSeen));
check(': "no record" and "record is alive" are different outcomes, a live one is not reported',
  blocked(DIAG, [{ address: 'worker:alive', name: `a2a-${DIAG}-alive` }], registering).length === 0,
  JSON.stringify(blocked(DIAG, [{ address: 'worker:alive', name: `a2a-${DIAG}-alive` }], registering)));
// The registration window covers this branch too, and first of all: a just-raised session is
// not in the list AT ALL, not "present without a pid".
check(': a participant written just now is not declared vanished',
  blocked(DIAG, [{ ...goneP, started: new Date().toISOString() }], registering).length === 0,
  JSON.stringify(blocked(DIAG, [{ ...goneP, started: new Date().toISOString() }], registering)));
const goneRoute = stallRoute({ ...goneSeen[0], task: DIAG }, goneSeen[0].id, goneSeen[0].ref);
check(`: the route for a vanished worker — re-raise with spawn, no claude logs`,
  /lift the worker again with the same spawn/.test(goneRoute) && !/claude logs/.test(goneRoute), goneRoute);
// Review note: this line repeats on every mailbox until the task closes, and a session could
// have vanished normally too — a human dropped it after the work was delivered. A bare "raise
// it again" would call for raising a participant whose work was already accepted.
check('review note: the route for a vanished one tells delivered work apart from undelivered',
  /claude stop/.test(goneRoute) && /Work delivered/.test(goneRoute)
  && /not delivered/.test(goneRoute), goneRoute);
check(`: the route for a vanished reviewer — promptobus review against its clone, not spawn`,
  stallRoute({ kind: 'gone', address: 'reviewer:api', repoAbs: '/tmp/klon', task: DIAG }, null, 'n')
    .includes(`promptobus review "/tmp/klon" --task ${DIAG}`),
  stallRoute({ kind: 'gone', address: 'reviewer:api', repoAbs: '/tmp/klon', task: DIAG }, null, 'n'));
check(': the line for a vanished one is its own — not "stalled" and not "LISTED"',
  stallLine(goneSeen[0], DIAG).includes('GONE: no session record in claude agents')
  && !/stalled|LISTED/.test(stallLine(goneSeen[0], DIAG)), stallLine(goneSeen[0], DIAG));
check(': the tail for a vanished one promises no return of messages',
  !/until the stall is cleared/.test(stallTail(goneSeen)), stallTail(goneSeen));

// A clock shifted backward after spawn made the fresh record look "from the future", the
// grace window was lifted, and the participant being raised was declared a ghost the very
// second the window exists to prevent. The window is now symmetric: the same span forward too.
check(': a record from the future within the window is given the window, not stripped of it',
  justSpawned({ metadata: { started: new Date(Date.now() + (SPAWN_GRACE_SEC - 5) * 1000).toISOString() } }) === true,
  String(justSpawned({ metadata: { started: new Date(Date.now() + (SPAWN_GRACE_SEC - 5) * 1000).toISOString() } })));
check(': a clock shifted backward does not declare a rising participant a ghost',
  blocked(DIAG, [{
    address: 'worker:chasy', name: FRESH_NAME,
    started: new Date(Date.now() + (SPAWN_GRACE_SEC - 5) * 1000).toISOString(),
  }], registering).length === 0);

// Process liveness is read by two callers: clearing a stale task lock, and the warden mark.
// The system reuses numbers, so garbage and a number known to be free must both be dead, and
// its own must be alive.
check(': pidAlive — its own process is alive, a number known to be free is dead, garbage is dead',
  store.pidAlive(process.pid) === true && store.pidAlive(2147483646) === false
  && store.pidAlive(0) === false && store.pidAlive(null) === false && store.pidAlive(-1) === false);

// --- : a participant's normal end of turn is not a stall ---------------------------
//
// As long as there was a wait on the bus, a participant sat inside a tool call between
// messages and was `working` to the harness. As of  once it sends a message it ends its
// turn, and the harness marks the background session `blocked` with a line like "result sent;
// awaiting next cycle": for `sessionStall` this is `unknown`, and a report went out on every
// normal end of turn. Measured 2026-09-01, task promptobus: four "stalled" reports in 15
// minutes, all four right after a `result` had just been sent, real stalls (`permission`,
// `limit`) zero. What tells them apart is one thing — whether the participant stayed silent
// AFTER it was activated.
const TURN_END = '9 review notes closed, result sent; awaiting next cycle';
check(': a session writes the normal-end-of-turn line in its own words — this is kind unknown',
  sessionStall({ state: 'blocked' }, TURN_END).kind === 'unknown',
  JSON.stringify(sessionStall({ state: 'blocked' }, TURN_END)));

const CYCLE = 'cikl-t20260901-190000';
store.createTask(HOME, { id: CYCLE, title: 'штатный конец хода участника' });
const CYCLE_NAME = `a2a-${CYCLE}-api`;
store.upsertParticipant(HOME, CYCLE, store.participantRecord('worker:api', { name: CYCLE_NAME }));
// A live record with a pid sits next to it: without it the "listed" signal self-calibrates,
// and a stalled session would be read as having outlived its own daemon.
const cycleSessions = [
  { id: 'live3', name: `a2a-${CYCLE}-alive`, state: 'working', pid: 5353 },
  { id: 'cyc1', name: CYCLE_NAME, state: 'blocked', pid: 8484 },
];
// The participant sent a `result` and ended its turn. The activation time is measured FROM
// the message's timestamp, not from the current time: `Date.now()` right next to the send
// can land in the same millisecond, and the check would go red every other run.
const cycleMsg = store.sendMessage(HOME, CYCLE, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог первой задачи',
});
const beforeMsg = new Date(Date.parse(cycleMsg.message.ts) - 60000).toISOString();
const afterMsg = new Date(Date.parse(cycleMsg.message.ts) + 60000).toISOString();
const cycleP = { address: 'worker:api', name: CYCLE_NAME, started: beforeMsg };
const cycleSeen = () => blocked(CYCLE, [cycleP], cycleSessions);

store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });
check(': an end of turn after a sent message is not reported',
  cycleSeen().length === 0, JSON.stringify(cycleSeen()));

// The same participant and the same session: one thing changed — after activation it wrote
// nothing.
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: afterMsg } });
check(': silent after activation — this is a stall, and it is reported as unknown',
  cycleSeen().length === 1 && cycleSeen()[0].kind === 'unknown'
  && cycleSeen()[0].address === 'worker:api', JSON.stringify(cycleSeen()));

// What counts is something sent BY the address itself: the message's file name carries the
// sender, and something sent to the participant during its own turn does not count.
store.sendMessage(HOME, CYCLE, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'ещё задача' });
check(': something sent to the participant is not counted as its own message',
  cycleSeen().length === 1, JSON.stringify(cycleSeen()));

// A message fetched from the mailbox moves into `read/` — the count does not change from
// that.
store.readInbox(HOME, CYCLE, 'orchestrator');
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });
check(`: a read message counts the same as one still sitting in the mailbox`,
  cycleSeen().length === 0, JSON.stringify(cycleSeen()));

// A successful knock is also an activation: a fetched mailbox is not the only mark of one.
store.writeHealth(HOME, CYCLE, { 'worker:api': { knockedAt: afterMsg } });
check(': a successful knock counts as an activation too, not only a fetched mailbox',
  cycleSeen().length === 1, JSON.stringify(cycleSeen()));

// An attempted knock does not count as an activation: a failed knock never started the turn,
// and silence after it points to a deaf channel, not a stall — the bus has its own words for
// that (`self-wake`).
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg, triedAt: afterMsg } });
check(': an attempted knock does not count as an activation — it never reached the participant',
  cycleSeen().length === 0, JSON.stringify(cycleSeen()));

// `permission` and `limit` are real stalls, cleared by a human or by time, not by a message
// on the bus: a participant that just sent a `result` can still be sitting on a dialog.
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });
const permSeen = blocked(CYCLE, [cycleP], [
  cycleSessions[0],
  { id: 'cyc2', name: CYCLE_NAME, state: 'blocked', waitingFor: 'permission prompt', pid: 8484 },
]);
check(': permission is reported even after a sent message',
  permSeen.length === 1 && permSeen[0].kind === 'permission', JSON.stringify(permSeen));
// A limit is recognized by `detail` from the background-session daemon's directory, and
// `blockedParticipants` reads it off a real claude. So we check it with the shared predicate
// — the same one both the report and `promptobus status` printing go through.
check(': limit is reported even after a sent message',
  stallStands(HOME, CYCLE, asRecord(cycleP), { kind: 'limit', reason: LIMIT }) === true);
check(': the same predicate on unknown after a sent message says "not a stall"',
  stallStands(HOME, CYCLE, asRecord(cycleP), { kind: 'unknown', reason: TURN_END }) === false);
check(': there is no activation time at all — nothing to compare against, and the stall stays a stall',
  stallStands(HOME, CYCLE, { address: 'worker:bez-otmetok' }, { kind: 'unknown', reason: TURN_END }) === true);

// --- : the entry point into stall parsing is end of turn, not the state `blocked` -------
//
// This relied on the harness marking a session that finished its turn as `blocked`. On
// `claude` 2.1.251 that is no longer true: a live E2E run measured on 2026-09-02 — six
// `claude agents --json` snapshots 20 s apart — gave both sessions `status: idle`,
// `state: done`, `waitingFor: null`, and across all nine records of the machine background
// sessions showed exactly two state pairs: `busy/working` and `idle/done`. The entry point on
// `blocked` never fired at all, and a silent participant was completely invisible. The
// fixtures therefore come in PAIRS — `done` next to `blocked`: both forms are live, and
// checking only one would mean locking in half the truth all over again.
const IDLE_DONE = { id: 'done1', name: 'Worker: отдал ход', status: 'idle', state: 'done', pid: process.pid };
const BUSY_WORKING = { id: 'work1', name: 'Worker: думает', status: 'busy', state: 'working', pid: process.pid };
// The outcome is named explicitly, not only compared against its neighbor: comparing the two
// calls against a mutation that returns `null` on both branches would give `'null' ===
// 'null'` and green (review note) — meaning the check would pass with the entry point
// removed.
check(': a session that finished its turn on 2.1.251 (idle/done) — the same kind of stall as the old blocked',
  sessionStall(IDLE_DONE, TURN_END)?.kind === 'unknown'
  && JSON.stringify(sessionStall(IDLE_DONE, TURN_END))
  === JSON.stringify(sessionStall({ state: 'blocked' }, TURN_END)),
  JSON.stringify(sessionStall(IDLE_DONE, TURN_END)));
// Access to the result goes through `?.`: under a mutation probe `sessionStall` returns
// `null` here, and a hard field read would take the whole file down — none of the verdicts
// below would exist at all, and a probe must show HOW MANY checks it colors.
check(': there is no reason — the entry point\'s own signal is named, not a made-up state',
  sessionStall(IDLE_DONE, null)?.reason === 'idle'
  && sessionStall({ state: 'blocked' }, null)?.reason === 'blocked',
  `${sessionStall(IDLE_DONE, null)?.reason} · ${sessionStall({ state: 'blocked' }, null)?.reason}`);
check(': a turn in progress is not counted as a stall — busy/working stays outside parsing',
  sessionStall(BUSY_WORKING, TURN_END) === null, JSON.stringify(sessionStall(BUSY_WORKING, TURN_END)));
// The dialog marker does not ask about state and sits above the gate: a session stuck on a
// permission prompt MID-TURN is waiting for a human regardless of what it's doing. Without
// this fixture the branch order would rest on prose alone (review note).
check(': the dialog marker outranks state — a turn in progress with it is still permission',
  sessionStall({ ...BUSY_WORKING, waitingFor: 'permission prompt' }, TURN_END)?.kind === 'permission',
  JSON.stringify(sessionStall({ ...BUSY_WORKING, waitingFor: 'permission prompt' }, TURN_END)));
check(': limit and dialog are recognized on idle/done the same way as on blocked',
  sessionStall(IDLE_DONE, LIMIT)?.kind === 'limit'
  && sessionStall({ ...IDLE_DONE, waitingFor: 'permission prompt' }, LIMIT)?.kind === 'permission',
  JSON.stringify([sessionStall(IDLE_DONE, LIMIT), sessionStall({ ...IDLE_DONE, waitingFor: 'permission prompt' }, LIMIT)]));

// The driver's snapshot: `idle/done` must arrive at the state machine as "alive, turn
// finished", not as vanished or as having outlived its own daemon. Liveness there is counted
// by `pid`, and state does not affect it — but this needs to be checked explicitly: silently
// diverging, the stall would be reported with the "nobody to wake" route.
const doneView = claudeDriver.inspect(IDLE_DONE.name, [BUSY_WORKING, IDLE_DONE]);
check(': the driver\'s snapshot sees idle/done as alive, free, and stalled, not gone/stale',
  doneView?.state === 'alive' && doneView.busy === false && doneView.stall?.kind === 'unknown',
  JSON.stringify(doneView));
check(': busy/working in the snapshot is a busy session with no stall',
  claudeDriver.inspect(BUSY_WORKING.name, [BUSY_WORKING, IDLE_DONE])?.busy === true
  && claudeDriver.inspect(BUSY_WORKING.name, [BUSY_WORKING, IDLE_DONE])?.stall === null,
  JSON.stringify(claudeDriver.inspect(BUSY_WORKING.name, [BUSY_WORKING, IDLE_DONE])));

// The silence gate remains the only filter for `unknown`: on the new entry point it must work
// exactly the same way, or a report would come back on every normal end of turn — the same
// trouble as before.
const doneSessions = [
  { id: 'live4', name: `a2a-${CYCLE}-alive`, status: 'busy', state: 'working', pid: 5353 },
  { id: 'cyc3', name: CYCLE_NAME, status: 'idle', state: 'done', pid: 8484 },
];
const doneSeen = () => blocked(CYCLE, [cycleP], doneSessions);
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });
check(': an idle/done end of turn after a sent message is not reported',
  doneSeen().length === 0, JSON.stringify(doneSeen()));
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: afterMsg } });
check(': a silent idle/done end of turn is reported — something that was never seen live before this task',
  doneSeen().length === 1 && doneSeen()[0].kind === 'unknown' && doneSeen()[0].address === 'worker:api',
  JSON.stringify(doneSeen()));
// Health goes back to "the participant answered": the `promptobus status` print checks below
// rest on this state, and leaving it silent would repaint them with an unrelated change.
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: beforeMsg } });

// The registration window on the NEW entry point (review note). While `blocked` state served
// as the entry point, a fresh session never entered parsing at all; it shows `idle` between
// `claude --bg` and its first turn — and a report would have gone out with the reason
// literally `idle`, because `state.json` has not been written yet at that point. The window
// is narrow on purpose: it only closes off "nothing to compare against" — a participant that
// has not sent a SINGLE message yet.
const FRESH_IDLE = 'svezhiy-t20260902-000000';
store.createTask(HOME, { id: FRESH_IDLE, title: 'свежая idle-сессия' });
const FRESH_IDLE_NAME = `a2a-${FRESH_IDLE}-api`;
const freshIdleSessions = [
  { id: 'live5', name: `a2a-${FRESH_IDLE}-alive`, status: 'busy', state: 'working', pid: 5353 },
  { id: 'idle1', name: FRESH_IDLE_NAME, status: 'idle', state: 'done', pid: 8484 },
];
const justUp = { address: 'worker:api', name: FRESH_IDLE_NAME, started: new Date().toISOString() };
const longUp = {
  ...justUp, started: new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString(),
};
store.upsertParticipant(HOME, FRESH_IDLE, asRecords([justUp])[0]);
check(': a freshly raised participant that has not been on the bus yet is not declared a stall',
  blocked(FRESH_IDLE, [justUp], freshIdleSessions).length === 0,
  JSON.stringify(blocked(FRESH_IDLE, [justUp], freshIdleSessions)));
check(': the same participant past the registration window is already a stall — the start is over and it is silent',
  blocked(FRESH_IDLE, [longUp], freshIdleSessions)[0]?.kind === 'unknown',
  JSON.stringify(blocked(FRESH_IDLE, [longUp], freshIdleSessions)));
// The window mutes nothing for one that has spoken: it has a real timeline, and silence
// after activation is a stall regardless of the record's age. Otherwise the window would
// hold back reports for half a minute across the board — a price this fix does not need to
// pay.
const upMsg = store.sendMessage(HOME, FRESH_IDLE, {
  from: 'worker:api', to: 'orchestrator', type: 'status', body: 'взял задание',
});
store.writeHealth(HOME, FRESH_IDLE, {
  'worker:api': { deliveredAt: new Date(Date.parse(upMsg.message.ts) + 60000).toISOString() },
});
check(': a participant that has spoken is reported even inside the registration window',
  blocked(FRESH_IDLE, [justUp], freshIdleSessions)[0]?.kind === 'unknown',
  JSON.stringify(blocked(FRESH_IDLE, [justUp], freshIdleSessions)));

// There is one predicate for both, and `promptobus status` printing goes through the same
// one: split apart, the report and the command would become two different answers about the
// same state.
store.upsertParticipant(HOME, CYCLE, asRecords([cycleP])[0]);
// The print snapshot is the same one the predicate uses: it arrives through a seam, built by
// the real driver from the same stubbed harness response. There is no `claude` substitution
// on PATH here at all anymore — printing and the predicate are judged against one input, not
// two different ones.
const cycleStatus = () => capture(() => status(SB, { task: CYCLE, sessions: snap(CYCLE, cycleSessions) }));
const quietOut = cycleStatus();
check(': `promptobus status` does not print STALLED on an end of turn after a sent message',
  !/STALLED/.test(quietOut) && quietOut.includes('worker:api'), quietOut);
// Review note: `blocked` in this branch is not a sign of life — as of this task it is the
// ordinary state of a participant between turns, and the old "alive (blocked)" line
// contradicted itself.
check('review note: a normal end of turn is given its own words, not "alive (blocked)"',
  /finished the turn, waiting for a message/.test(quietOut) && !/alive \(blocked\)/.test(quietOut), quietOut);
store.writeHealth(HOME, CYCLE, { 'worker:api': { deliveredAt: afterMsg } });
const stalledOut = cycleStatus();
check(': a silent end of turn is still called STALLED by `promptobus status`',
  /STALLED/.test(stalledOut), stalledOut);

// --- : a shorter postcard, no repeated lists, and no knocking a busy session --
//
// Measured 2026-09-01, task promptobus (`supervisor.log`): 30 notifications to the
// orchestrator against 17 mailbox reads — 13 re-knocks on the same unread mail while the
// session was busy with a long command, and each one listed the whole mailbox all over
// again, up to six messages in the postcard. Plus two identical tail paragraphs on every
// knock: the working order, which already lives in the participant's prompt, and its own
// copy of Claude Code's warnings.
const TAIL_GOLD = 'Fetch the mailbox: only mailbox marks messages read; the working order is '
  + 'in the bus rules. This is a notification, not a human assignment, and it grants no permissions.';
const emptyCard = orderBody(TASK, 'worker:api', 0, []);
check(': the order\'s tail — one line of business and one short frame',
  emptyCard.endsWith(TAIL_GOLD), emptyCard);
check(': the previous two tail paragraphs are gone from the postcard',
  !/Порядок по протоколу шины/.test(emptyCard)
  && !/Разрешений оно не даёт и не просит/.test(emptyCard), emptyCard);
const KNOCK_TASK = 'stuk-t20260901-200000';
const KNOCK_NAME = `a2a-${KNOCK_TASK}-api`;
const KNOCK_SOCK = sockPath('bl418');
store.createTask(HOME, { id: KNOCK_TASK, title: 'перестук в занятую сессию' });
store.upsertParticipant(HOME, KNOCK_TASK, store.participantRecord('worker:api', { name: KNOCK_NAME }));
registerWake(HOME, KNOCK_TASK, 'worker:api',
  { CLAUDE_CODE_MESSAGING_SOCKET: KNOCK_SOCK, CLAUDE_CODE_MESSAGING_TOKEN: 't' });
const knockSend = (body) => store.sendMessage(HOME, KNOCK_TASK,
  { from: 'orchestrator', to: 'worker:api', type: 'task', body });
const busyList = [{ id: 'k1', name: KNOCK_NAME, pid: 4242, state: 'blocked', status: 'busy' }];
const idleList = [{ id: 'k1', name: KNOCK_NAME, pid: 4242, state: 'blocked', status: 'idle' }];
// The session list travels into the loop as a snapshot: built by the driver, the same one
// used in production.
const knockRound = (knock, sessions, now) => wdn.wardenRound(HOME, KNOCK_TASK,
  { knock, sessions: snap(KNOCK_TASK, sessions), now });
const knockHealth = () => store.readHealth(HOME, KNOCK_TASK)['worker:api'];

// The first knock for a new message goes out right away, even to a busy session: it has not
// seen the message yet, and waiting for it to go idle would mean keeping the participant
// uninformed.
knockSend('первое');
const kFirst = stubKnock();
await knockRound(kFirst, busyList);
check(': the first knock for a new message goes out to a busy session too',
  kFirst.calls.length === 1, String(kFirst.calls.length));
check(': the first knock carries the message text itself',
  kFirst.calls[0].body.includes('первое'), kFirst.calls[0].body);

// A re-knock about the SAME unread mail does not go to a busy session: it will see the
// notification only at the end of the turn, and the loop's own watch already returns the
// unread mail with that turn anyway.
const T418 = Date.now() + wdn.KNOCK_RETRY_SEC * 1000 + 1000;
const kBusy = stubKnock();
await knockRound(kBusy, busyList, T418);
check(': a re-knock does not go to a busy session, even past the threshold',
  kBusy.calls.length === 0, String(kBusy.calls.length));
check(': a re-knock that did not happen moves neither the knock counter nor the attempt time',
  knockHealth().knocks === 1 && knockHealth().triedAt === knockHealth().knockedAt,
  JSON.stringify(knockHealth()));

// The session went idle, and the mailbox was not fetched — the re-knock goes out.
const kIdle = stubKnock();
await knockRound(kIdle, idleList, T418);
check(': the session went idle and did not fetch the mailbox — the re-knock goes out',
  kIdle.calls.length === 1 && knockHealth().knocks === 2, JSON.stringify(knockHealth()));
check(': a repeat does not list what was already knocked, it names the overall counter',
  !kIdle.calls[0].body.includes('первое') && /has unread: 1/.test(kIdle.calls[0].body),
  kIdle.calls[0].body);

// A new message arrived on top of the old one — it rides out alone, without its neighbor from
// the previous knock.
knockSend('второе');
const kGrew = stubKnock();
await knockRound(kGrew, busyList, T418 + 1000);
check(': a new message wakes it immediately, even a busy session',
  kGrew.calls.length === 1, String(kGrew.calls.length));
check(': the repeat carries only the new one, while the counter is still the overall one',
  kGrew.calls[0].body.includes('второе') && !kGrew.calls[0].body.includes('первое')
  && /has unread: 2/.test(kGrew.calls[0].body), kGrew.calls[0].body);

// Session state is unknown — that is not "busy": no list, no record, no field. The re-knock
// goes out, as it did before this fix.
const kUnknown = stubKnock();
await knockRound(kUnknown, null, T418 + wdn.KNOCK_RETRY_SEC * 1000 + 2000);
check(': an unparsed session list is not counted as busy — the re-knock goes out',
  kUnknown.calls.length === 1, String(kUnknown.calls.length));
const kNoField = stubKnock();
await knockRound(kNoField, [{ id: 'k1', name: KNOCK_NAME, pid: 4242, state: 'blocked' }],
  T418 + 2 * wdn.KNOCK_RETRY_SEC * 1000 + 3000);
check(': a record with no status field is not attributed busyness',
  kNoField.calls.length === 1, String(kNoField.calls.length));

// The participant restarted — its session never saw the previous knock, and the repeat goes
// out as the full list: the "knocked up to here" mark was left over from a session that no
// longer exists.
registerWake(HOME, KNOCK_TASK, 'worker:api',
  { CLAUDE_CODE_MESSAGING_SOCKET: sockPath('bl418b'), CLAUDE_CODE_MESSAGING_TOKEN: 't' });
const kMoved = stubKnock();
await knockRound(kMoved, idleList, T418 + 2 * wdn.KNOCK_RETRY_SEC * 1000 + 4000);
check(': a rewritten contact point returns the full list — the session never saw it',
  kMoved.calls.length === 1 && kMoved.calls[0].body.includes('первое')
  && kMoved.calls[0].body.includes('второе'), kMoved.calls[0].body);

// Busyness for a participant WITHOUT a bg session (review note). The orchestrator is the
// human's session: it has no name in the log, and an interactive `claude agents --json`
// record has no `status` field either. There is one signal of busyness for it — the
// loop-watch mark: it's called on every end of turn, and an activation newer than the mark
// means the session has started a turn since then and has not yet given it back.
const ORCH_TASK = 'orkestr-t20260901-201000';
store.createTask(HOME, { id: ORCH_TASK, title: 'занятость участника без bg-сессии' });
registerWake(HOME, ORCH_TASK, 'orchestrator',
  { CLAUDE_CODE_MESSAGING_SOCKET: sockPath('bl418o'), CLAUDE_CODE_MESSAGING_TOKEN: 't' });
store.sendMessage(HOME, ORCH_TASK, { from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог куска' });
const orchHealth = () => store.readHealth(HOME, ORCH_TASK).orchestrator;
const orchRound = (knock, now) => wdn.wardenRound(HOME, ORCH_TASK, { knock, sessions: [], now });

const oFirst = stubKnock();
await orchRound(oFirst);
check(': the first knock to a participant with no bg session goes out like anyone else\'s',
  oFirst.calls.length === 1 && orchHealth().knocks === 1, JSON.stringify(orchHealth()));
// The session list here is parsed and empty: the orchestrator's record is not in it and
// cannot be, and the loop-watch branch is chosen by exactly that, not by an unparsed output.
const T418O = Date.parse(orchHealth().knockedAt) + wdn.KNOCK_RETRY_SEC * 1000 + 1000;
const oNoMark = stubKnock();
await orchRound(oNoMark, T418O);
check(': there has never been a loop-watch mark — that is unknown, and the re-knock goes out',
  oNoMark.calls.length === 1, String(oNoMark.calls.length));

const knockedO = Date.parse(orchHealth().knockedAt);
const T418O2 = knockedO + wdn.KNOCK_RETRY_SEC * 1000 + 1000;
store.markTurn(HOME, ORCH_TASK, 'orchestrator', new Date(knockedO - 60000).toISOString());
const oBusy = stubKnock();
await orchRound(oBusy, T418O2);
check(': the orchestrator has not given back its turn since the last knock — no re-knock',
  oBusy.calls.length === 0, String(oBusy.calls.length));

store.markTurn(HOME, ORCH_TASK, 'orchestrator', new Date(knockedO + 30000).toISOString());
const oIdle = stubKnock();
await orchRound(oIdle, T418O2);
check(`: the turn was given back after the knock, and the mailbox was not fetched — the re-knock goes out`,
  oIdle.calls.length === 1, String(oIdle.calls.length));

// Review note: the `sessionBusy` branch is chosen by the KIND of participant, not by whether
// its record was found. `findSession` returns null both on an unparsed list (the live case:
// claude not on PATH) and on a vanished record, and a named participant used to ride that
// null into the loop-watch branch — where it may have no end-of-turn mark at all, while its
// activation is guaranteed to be newer, so the re-knock went silent exactly where the state
// was unknown. The fixture is set up so the loop-watch branch says "busy": the mark is older
// than the activation.
const NAMED = { address: 'worker:api', name: 'Worker: именованный' };
store.writeHealth(HOME, ORCH_TASK, {
  ...store.readHealth(HOME, ORCH_TASK),
  'worker:api': { knockedAt: new Date(knockedO).toISOString() },
});
store.markTurn(HOME, ORCH_TASK, 'worker:api', new Date(knockedO - 60000).toISOString());
check(', review note: a named participant with an unparsed list is unknown, not busy',
  sessionBusy(HOME, ORCH_TASK, asRecord(NAMED), null) === false,
  String(sessionBusy(HOME, ORCH_TASK, asRecord(NAMED), null)));
check(', review note: a named participant with no record in the list is also not busy, but unknown',
  sessionBusy(HOME, ORCH_TASK, asRecord(NAMED), snapOf([NAMED], [])) === false,
  String(sessionBusy(HOME, ORCH_TASK, asRecord(NAMED), snapOf([NAMED], []))));
check(': the loop-watch branch is still alive though — it is for a record with no name',
  sessionBusy(HOME, ORCH_TASK, asRecord({ address: 'worker:api' }), snapOf([NAMED], [])) === true,
  String(sessionBusy(HOME, ORCH_TASK, asRecord({ address: 'worker:api' }), snapOf([NAMED], []))));

// Review note: the task store is asked for on entry, not on the first stall — otherwise a
// call with a forgotten store stays quiet while nobody has stalled, and fails midway through
// a warden loop or a `mailbox` reply.
const noStore = (() => {
  try {
    blockedParticipants(null, null, [], []);
    return null;
  } catch (e) {
    return e.message;
  }
})();
check('review note: blockedParticipants with no task store fails right away, not on the first stall',
  /home and task are required/.test(noStore ?? ''), String(noStore));

// Review note: the accumulating signal has an upper bound. A knock could have gone out
// successfully and then been dropped past the recipient's queue limit — the session then
// never starts or ends a turn, the loop-watch mark never moves, and busyness would stay true
// forever.
const sinceO = Date.parse(store.readHealth(HOME, ORCH_TASK).orchestrator.since);
store.markTurn(HOME, ORCH_TASK, 'orchestrator', new Date(sinceO - 60000).toISOString());
const oStuck = stubKnock();
await orchRound(oStuck, Date.parse(orchHealth().knockedAt) + wdn.SILENCE_SEC * 1000 + 1000);
check(', review note: unread mail has been sitting past the silence threshold — we knock regardless of busyness',
  oStuck.calls.length === 1, String(oStuck.calls.length));

// --- : a participant dismissed from watch, and health -------------------------------------
//
// `dismiss` mutes REPORTS about a participant's session, not delivery to it: writing to a
// dismissed address stays legitimate, and a message must wait for either the `mailbox` of a
// live session, or a participant raised again ([12]). The watch loop therefore does not
// skip a dismissed one — and it must not: skipping it would turn "will wait for it" into
// "sits there until restart". A health record for a dismissed one appears in exactly one
// case — it was written to — and it is a delivery mark, not a report. Both halves are
// pinned down below: what a dismissed participant with no correspondence has, and what one
// with correspondence has.
const DISMISSED = 'sup-dismiss-t20260902-150000';
store.createTask(HOME, { id: DISMISSED, title: 'снятый с наблюдения', owner: SESSION });
store.upsertParticipant(HOME, DISMISSED, store.participantRecord('worker:api', { sessionRef: 'worker-api' }));
store.upsertParticipant(HOME, DISMISSED, store.participantRecord('worker:web', { sessionRef: 'worker-web' }));
for (const addr of ['worker:api', 'worker:web']) {
  registerWake(HOME, DISMISSED, addr, {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath(`bl431${addr.slice(-3)}`), CLAUDE_CODE_MESSAGING_TOKEN: 't',
  });
}
store.dismissParticipant(HOME, DISMISSED, 'worker:api');
const dHealth = () => store.readHealth(HOME, DISMISSED);

// Nobody wrote to the dismissed one — there is no health record for it even after several
// loops. This is exactly the auto-recorded sender the task was built for: it never has
// unread mail, and the loop exits on an empty mailbox before any record is made. The branch
// "empty, and it was empty last time too" is held up by `if (was.unread)` — remove it, and
// health would start creating a record for every participant of the task for no reason.
const dQuiet = stubKnock();
for (const now of [Date.now(), Date.now() + 60_000, Date.now() + 120_000]) {
  await wdn.wardenRound(HOME, DISMISSED, { knock: dQuiet, now });
}
check(': nobody wrote to the dismissed one — no health record even after three loops',
  Object.keys(dHealth()).length === 0 && dQuiet.calls.length === 0,
  JSON.stringify(dHealth()));

// Someone wrote to the dismissed one — delivery goes ahead like for anyone else: the knock
// goes out, health carries a delivery mark. There is no report of its stall, though, and this
// pair sits next to each other on purpose: split apart, they'd give "reports are silent, but
// the message never arrived either". Its neighbor in the same task is not dismissed and does
// show up in the stalled list — otherwise skipping ALL participants would be
// indistinguishable from skipping just the dismissed one.
for (const addr of ['worker:api', 'worker:web']) {
  store.sendMessage(HOME, DISMISSED, { from: 'orchestrator', to: addr, type: 'task', body: 'ещё кусок' });
}
const dKnock = stubKnock();
await wdn.wardenRound(HOME, DISMISSED, { knock: dKnock });
const dMark = dHealth()['worker:api'];
check(': someone wrote to the dismissed one — the knock goes out to it just like to anyone else',
  dKnock.calls.length === 2 && dKnock.calls.some((c) => c.endpoint.address === 'worker:api'),
  JSON.stringify(dKnock.calls.map((c) => c.endpoint.address)));
check(`: a dismissed one's health record is a delivery mark: the driver's channel (socket, for Claude Code), the knock counter, and how far knocking reached`,
  dMark?.unread === 1 && dMark.knocks === 1 && dMark.channel === 'socket'
  && typeof dMark.knockedTo === 'string' && typeof dMark.knockedAt === 'string',
  JSON.stringify(dMark));

// Neither participant's session is in the list — both get the `gone` outcome, and a report
// goes out for it. It skips the dismissed one (`blockedParticipants`), not the one who isn't.
const dParts = store.readTask(HOME, DISMISSED).participants;
const dStalled = blocked(DISMISSED, dParts, []);
check(': there is no stall report for the dismissed one, but there is one for the un-dismissed one in the same state',
  dStalled.length === 1 && dStalled[0].address === 'worker:web',
  JSON.stringify(dStalled.map((s) => s.address)));

// `promptobus status` printing says both things at once about a dismissed one: there will be
// no reports, and unread mail is sitting there. Without the second half a reader would take
// the address for switched off entirely.
const dOut = capture(() => status(SB, { task: DISMISSED, sessions: snap(DISMISSED, []) }));
const dLine = dOut.split('\n').find((l) => l.includes('worker:api')) ?? '';
check(': promptobus status prints both the dismissal and the unread count for the dismissed one',
  /DISMISSED FROM WATCH/.test(dLine) && /unread 1/.test(dLine), dLine || dOut);

// --- : status names the driver's channel, not the literal socket -------------------
//
// Printing reads `h.channel`. The self-wake branch is a different subject and is not checked
// here: a successful Cursor/Codex knock must be named by its own channel, not "socket".
const CH_TASK = 'channel-t20260904-084513';
store.createTask(HOME, { id: CH_TASK, title: `канал driver'а в status`, owner: SESSION });
store.upsertParticipant(HOME, CH_TASK, store.participantRecord('worker:cur'));
store.writeWake(HOME, CH_TASK, 'worker:cur', {
  socket: sockPath('cur-reg'), token: 't',
});
store.writeHealth(HOME, CH_TASK, {
  'worker:cur': {
    channel: 'inject', knocks: 1, unread: 1,
    wake: `${sockPath('cur-reg')}#2026-09-04T08:00:00.000Z`,
  },
});
const injectOut = capture(() => status(SB, { task: CH_TASK, sessions: snap(CH_TASK, []) }));
const injectLine = injectOut.split('\n').find((l) => l.includes('worker:cur')) ?? '';
check(': promptobus status names the channel inject, not socket',
  /alarm: inject handed over/.test(injectLine) && !/alarm: socket handed over/.test(injectLine),
  injectLine || injectOut);

// --- : a contact point held by someone else's session -------------------------
//
// A Claude Code background session's environment comes from the daemon, not from the command
// that occupied it (measured 2026-09-03 on 2.1.251), and before  the Stop hook of the
// task's second participant resolved the first participant's address and handed over ITS OWN
// socket on its behalf. A knock against such a record started someone else's turn, while the
// real addressee stayed deaf: over ten minutes of a run that sent out eleven notifications
// this way.
//
// There are two lines of defense, and both are checked. The first is the record: a contact
// point is never handed over for someone else's address. The second is delivery: seeing a
// record with someone else's session, the warden does not knock it.
const TAKEN = 'taken-t20260903-010000';
store.createTask(HOME, { id: TAKEN, title: 'перехваченный contact point', owner: SESSION });
// A short id in the log and a full uuid on the writer — two spellings of ONE session:
// measured 2026-09-03 (`claude agents --json`) gives `id: "e8c5be23"` alongside
// `sessionId: "e8c5be23-dfef-4d20-bd96-e2a40a366b97"`. The fixture keeps this pair, or the
// comparison would be checked against string equality, which doesn't exist in real life.
const OWN_SHORT = 'e8c5be23';
const OWN_FULL = 'e8c5be23-dfef-4d20-bd96-e2a40a366b97';
const ALIEN = '7f3a01bc-2210-4f61-9a0e-1c4d5e6f7a8b';
store.upsertParticipant(HOME, TAKEN, store.participantRecord('worker:api', { name: 'w-taken', session: OWN_SHORT }));
const TSOCK = sockPath('taken');
const mine = registerWake(HOME, TAKEN, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: TSOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 't',
  CLAUDE_CODE_SESSION_ID: OWN_FULL,
});
check(': the log recognizes its own session by prefix — the record\'s short id against the full uuid',
  mine?.session === OWN_FULL && store.readWake(HOME, TAKEN, 'worker:api')?.session === OWN_FULL,
  JSON.stringify(mine));
const stolen = registerWake(HOME, TAKEN, 'worker:api', {
  CLAUDE_CODE_MESSAGING_SOCKET: sockPath('alien'),
  CLAUDE_CODE_MESSAGING_TOKEN: 't',
  CLAUDE_CODE_SESSION_ID: ALIEN,
});
check(': a session that isn\'t its own does not get a contact point handed over for this address — the record is unchanged',
  stolen === null && store.readWake(HOME, TAKEN, 'worker:api')?.socket === TSOCK,
  JSON.stringify(store.readWake(HOME, TAKEN, 'worker:api')));
// A participant record with no session id has nothing to compare against: the raise may have
// failed to parse it out of the `--bg` output. That is unknown, not someone else, and it
// can't be refused on that basis — the participant would be left with no contact point
// forever.
store.upsertParticipant(HOME, TAKEN, store.participantRecord('worker:web', { name: 'w-web' }));
check(': for a record with no session id the gate stays quiet — the contact point can be handed over',
  registerWake(HOME, TAKEN, 'worker:web', {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath('web'), CLAUDE_CODE_SESSION_ID: ALIEN,
  })?.socket === sockPath('web'),
  JSON.stringify(store.readWake(HOME, TAKEN, 'worker:web')));

// Delivery. The record is placed bypassing `registerWake` — that's exactly how it appears
// for a participant raised by a previous release, where the record gate doesn't exist yet.
// The socket in it belongs to SOMEONE ELSE: the hijacker hands over its own, and `writeWake`
// never rewrites a record under the previous channel's address at all.
store.writeWake(HOME, TAKEN, 'worker:api', { socket: sockPath('alien'), token: 't', session: ALIEN });
store.sendMessage(HOME, TAKEN, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'сообщение глухому' });
const takenKnock = stubKnock();
const takenRound = await wdn.wardenRound(HOME, TAKEN, { knock: takenKnock });
const takenMark = (store.readHealth(HOME, TAKEN) ?? {})['worker:api'] ?? {};
check(': the warden does not knock a contact point held by someone else — fallback to self-wake',
  takenKnock.calls.length === 0 && takenMark.channel === 'self-wake'
  && String(takenMark.knockError).includes(ALIEN),
  `${JSON.stringify(takenMark)} · knocks ${takenKnock.calls.length}`);
check(': the reason is named in the warden log once, not every loop',
  takenRound.events.filter((e) => e.includes('worker:api')).length === 1
  && (await wdn.wardenRound(HOME, TAKEN, { knock: takenKnock })).events.length === 0,
  JSON.stringify(takenRound.events));
// The report to the orchestrator goes through the same channel as stalls: there will be no
// messages from a deaf participant, and the mailbox won't say so. The session is ALIVE
// though — so the stall kind is its own.
const takenStalled = blocked(TAKEN, [{ address: 'worker:api', name: 'w-taken', session: OWN_SHORT }],
  [{ name: 'w-taken', id: 'w1', pid: process.pid, status: 'busy', state: 'working' }]);
check(': a deaf participant reaches the orchestrator report as its own kind of stall',
  takenStalled.length === 1 && takenStalled[0].kind === 'wake-taken'
  && takenStalled[0].reason.includes(ALIEN),
  JSON.stringify(takenStalled));
check(': the report line calls it deaf and names the route for a human',
  /DEAF/.test(stallLine(takenStalled[0], TAKEN)) && /claude attach/.test(stallLine(takenStalled[0], TAKEN)),
  stallLine(takenStalled[0], TAKEN));
// Review note: the report has the same registration window as the neighboring branches. On a
// re-raise the participant's record carries a NEW session id, while `wake/<address>.json`
// still belongs to the old one — until the new bus server's handshake, the just-raised one
// would look deaf, and the orchestrator would get a report about the one it just raised.
// Refusing to knock is deliberately not covered by the window: knocking someone else's socket
// is not allowed even in those thirty seconds.
const freshTaken = blocked(TAKEN, [{
  address: 'worker:api', name: 'w-taken', session: OWN_SHORT, started: new Date().toISOString(),
}], [{ name: 'w-taken', id: 'w1', pid: process.pid, status: 'busy', state: 'working' }]);
check(': a freshly raised participant with an old contact point does not reach the report — registration window',
  freshTaken.length === 0, JSON.stringify(freshTaken));
const agedTaken = blocked(TAKEN, [{
  address: 'worker:api',
  name: 'w-taken',
  session: OWN_SHORT,
  started: new Date(Date.now() - (SPAWN_GRACE_SEC + 5) * 1000).toISOString(),
}], [{ name: 'w-taken', id: 'w1', pid: process.pid, status: 'busy', state: 'working' }]);
check(': past the registration window the same participant reaches the report — the window does not cancel the branch',
  agedTaken.length === 1 && agedTaken[0].kind === 'wake-taken', JSON.stringify(agedTaken));

// --- , review note: a full id is compared by EQUALITY, a short one by prefix --------
//
// The premise "a record's short id is a prefix of its `sessionId`" was taken off a single
// measurement and is not a contract, and the gate built on it is fail-closed: should the
// spellings diverge on the harness's next build, the bus would stop silently. So a raise now
// puts the FULL identifier into the record as a second field, and it's compared by equality;
// the prefix stays a fallback rule for records with no full id.
const TWIN = '7f3a01bc-2210-4f61-9a0e-1c4d5e6f7a8b';
store.upsertParticipant(HOME, TAKEN, store.participantRecord('worker:full', {
  name: 'w-full', session: OWN_SHORT, sessionId: OWN_FULL,
}));
check(': with a full id in the record, ownership is recognized by equality',
  registerWake(HOME, TAKEN, 'worker:full', {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath('full'), CLAUDE_CODE_SESSION_ID: OWN_FULL,
  })?.session === OWN_FULL,
  JSON.stringify(store.readWake(HOME, TAKEN, 'worker:full')));
// The difference between the rules shows exactly here: the writer named the SHORT id, while
// the record holds the full one. The prefix rule would have taken this for the owner — half
// of an identifier is not ownership, and `CLAUDE_CODE_SESSION_ID` never gives out the short
// form at all. Equality rejects it.
check(': half an identifier does not count as the owner — the rule is equality, not prefix',
  registerWake(HOME, TAKEN, 'worker:full', {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath('half'), CLAUDE_CODE_SESSION_ID: OWN_SHORT,
  }) === null && store.readWake(HOME, TAKEN, 'worker:full')?.socket === sockPath('full'),
  `${OWN_SHORT} · ${JSON.stringify(store.readWake(HOME, TAKEN, 'worker:full'))}`);
// The gate's refusal must be visible: a silent `null` is indistinguishable from working
// correctly.
check(': the gate\'s refusal is recorded in the warden log',
  store.tailWardenLog(HOME, TAKEN, 20).some((l) => l.includes(`contact-point handoff for address worker:full is refused`)
    && l.includes(OWN_FULL)),
  store.tailWardenLog(HOME, TAKEN, 5).join('\n'));
// The second half of visibility: the same thing in `promptobus status` — the only place a
// human sees the refusal without reading the log (second round of review). The reason comes
// from health, where the watch loop puts it, and is printed as-is: there are now two
// fallbacks to self-wake, and the log phrase "<channel> did not accept the notification"
// (`socket` / `inject` / `rpc`) would only have fit one of them — a hijacked contact point
// never called the delivery channel at all.
const takenOut = capture(() => status(SB, { task: TAKEN, sessions: snap(TAKEN, []) }));
const takenLine = takenOut.split('\n').find((l) => l.includes('worker:api')) ?? '';
check(': promptobus status prints the fallback reason in the alarm line',
  /alarm: self-wake \(reason: contact point is held by session /.test(takenLine)
  && takenLine.includes(ALIEN), takenLine || takenOut);
// A previous release's record carries no full id at all — the rule there stays the prefix,
// or a participant raised before this task would be left with no contact point forever.
check(': with no full id in the record the rule stays the prefix',
  registerWake(HOME, TAKEN, 'worker:web', {
    CLAUDE_CODE_MESSAGING_SOCKET: sockPath('web2'), CLAUDE_CODE_SESSION_ID: TWIN,
  })?.session === TWIN,
  JSON.stringify(store.readWake(HOME, TAKEN, 'worker:web')));
// The record's owner took it back — and delivery proceeds like for anyone else: the gate
// does not get stuck.
store.writeWake(HOME, TAKEN, 'worker:api', { socket: TSOCK, token: 't', session: OWN_FULL });
const backKnock = stubKnock();
await wdn.wardenRound(HOME, TAKEN, { knock: backKnock });
check(': the owner rewrote the contact point with its own — the knock went out',
  backKnock.calls.length === 1,
  JSON.stringify((store.readHealth(HOME, TAKEN) ?? {})['worker:api'] ?? {}));

// --- successor: after claim the contact point is rewritten, notification arrives ----------
const HEIR_TASK = 'heir-t20260904-020000';
const OLD_ORCH = 'sess-old-orch-warden';
const NEW_ORCH = 'sess-new-orch-warden';
store.createTask(HOME, { id: HEIR_TASK, title: 'claim переписывает contact point', owner: OLD_ORCH });
store.writeWake(HOME, HEIR_TASK, 'orchestrator', {
  socket: sockPath('old-dead'), token: 'old', session: OLD_ORCH,
});
store.sendMessage(HOME, HEIR_TASK, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'после смены id',
});
const beforeClaim = stubKnock({ ok: false, error: 'ENOENT' });
await wdn.wardenRound(HOME, HEIR_TASK, { knock: beforeClaim });
check('successor: before claim a knock to the dead socket falls back to self-wake',
  store.readHealth(HOME, HEIR_TASK).orchestrator?.knockError === 'ENOENT'
  && store.readWake(HOME, HEIR_TASK, 'orchestrator')?.session === OLD_ORCH,
  JSON.stringify(store.readHealth(HOME, HEIR_TASK).orchestrator));

store.claimOwnership(HOME, HEIR_TASK, NEW_ORCH);
const HEIR_SOCK = sockPath('heir-live');
const heirSrv = createServer((c) => { c.end(); });
await new Promise((res) => heirSrv.listen(HEIR_SOCK, res));
const handed = registerWake(HOME, HEIR_TASK, 'orchestrator', {
  CLAUDE_CODE_MESSAGING_SOCKET: HEIR_SOCK,
  CLAUDE_CODE_MESSAGING_TOKEN: 'new',
  CLAUDE_CODE_SESSION_ID: NEW_ORCH,
}, NEW_ORCH);
check('successor: after claim the warden hands the contact point to the new session',
  handed?.socket === HEIR_SOCK && handed?.session === NEW_ORCH
  && store.taskOwner(HOME, HEIR_TASK) === NEW_ORCH,
  JSON.stringify(handed));

const afterClaim = stubKnock();
const delivered = await wdn.wardenRound(HOME, HEIR_TASK, { knock: afterClaim });
check('successor: after claim the notification reaches the new socket',
  afterClaim.calls.length === 1 && afterClaim.calls[0].endpoint.socket === HEIR_SOCK
  && store.readHealth(HOME, HEIR_TASK).orchestrator?.channel === 'socket'
  && !delivered.events.some((e) => /fell back to self-wake orchestrator/.test(e)),
  JSON.stringify({ calls: afterClaim.calls.map((c) => c.endpoint.socket), health: store.readHealth(HOME, HEIR_TASK).orchestrator, events: delivered.events }));
// The socket is still listening: otherwise existsSync after close reads "dead" again, and a
// naive "the orchestrator is always dead" printout on the ENOENT check would have stayed
// green.
const liveOrch = capture(() => status(SB, { task: HEIR_TASK, sessions: snap(HEIR_TASK, []) }));
check('successor: with a live socket after claim, status does not call the owner dead',
  /alarm: socket handed over/.test(liveOrch) && !/is dead since/.test(liveOrch),
  liveOrch);
heirSrv.close();

const CLAIM_EMPTY = 'claim-empty-t20260904-050000';
store.createTask(HOME, { id: CLAIM_EMPTY, title: 'claim без непрочитанного', owner: OLD_ORCH });
store.writeWake(HOME, CLAIM_EMPTY, 'orchestrator', {
  socket: sockPath('empty-old'), token: 'old', session: OLD_ORCH,
});
store.writeHealth(HOME, CLAIM_EMPTY, {
  orchestrator: { channel: 'self-wake', knockError: 'ENOENT', triedAt: '2026-09-03T20:31:43.000Z' },
});
store.claimOwnership(HOME, CLAIM_EMPTY, NEW_ORCH);
const emptyClaimOut = capture(() => status(SB, { task: CLAIM_EMPTY, sessions: snap(CLAIM_EMPTY, []) }));
check('successor: a claim with an empty mailbox and no knock does not have status call the owner dead',
  !/is dead since/.test(emptyClaimOut) && store.countInbox(HOME, CLAIM_EMPTY, 'orchestrator') === 0,
  emptyClaimOut);

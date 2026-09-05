// Regression test for the bus's loop guard, `promptobus promptobus guard`, and its Stop hook
// (phase 1). Run: npm test
//
// Subject — a turn that ended with an unread mailbox: knocking on a session that is already
// ending its turn is too late, and every other bus safeguard lives in tool RESPONSES — a turn
// that ends with a report to the human without a single bus call invokes none of them.
//
// One branch only: the task has a single wake mechanism, and that is the warden. The guard has
// nothing to watch over besides an unread mailbox.
//
// What's checked is what the harness will see: the return code (2 — the turn is returned, 0 —
// it isn't), the reason in stderr, and silence on a clean pass. Plus loop protection: the same
// state is returned no more than twice in a row.
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath, stubCommand, writeHostConfig } from './sandbox.mjs';

const SB = makeSandbox('promptobus-promptobus-guard-');
const ROOT = realpathSync(SB);
const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'promptobus.js');
const HOME = path.join(ROOT, '.promptobus');
const TASK = 'guard-t20260829-120000';
const SESSION = 'sess-guard-1111';

const store = await import(path.join(here, '..', 'lib', 'store.js'));
const {
  guardVerdict, guardMarkFile, GUARD_MARK, GUARD_BLOCK_LIMIT,
  successorLine, successorVerdict, probeContactPoint,
} = await import(path.join(here, '..', 'lib', 'guard.js'));
const { GUARD_HOOK_EVENT, GUARD_START_EVENT, guardHookSettings } = await import(path.join(here, '..', 'dist', 'hooks.js'));
const { createStandaloneHost } = await import(path.join(here, '..', 'lib', 'host.js'));
writeHostConfig(ROOT);

store.createTask(HOME, { id: TASK, title: 'сторож цикла', owner: SESSION });
const WORKER_NAME = `a2a-${TASK}-api`;
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:api', { name: WORKER_NAME }));

const send = (type, body) => store.sendMessage(HOME, TASK, { from: 'worker:api', to: 'orchestrator', type, body });

// The session list is stubbed: a participant's liveness is the answer from the external
// `claude agents --json`, and the checks must not depend on what the real claude on the
// machine running the suite answers.
const LIVE = [{ id: 'liv001', name: WORKER_NAME, state: 'busy', pid: process.pid }];
const STUB = path.join(ROOT, 'bin');
stubCommand(STUB, 'claude', `process.stdout.write(${JSON.stringify(JSON.stringify(LIVE))});`);

// --- guard verdict --------------------------------------------------------------

check('clean state: mailbox empty — no verdict',
  guardVerdict(HOME, TASK, 'orchestrator') === null,
  JSON.stringify(guardVerdict(HOME, TASK, 'orchestrator')));

send('status', 'взял в работу');
send('result', 'готово');
const unread = guardVerdict(HOME, TASK, 'orchestrator');
check(`unread in the mailbox: the verdict names the count and the route via inbox`,
  unread?.key === 'mailbox:2' && /mailbox has 2/.test(unread.reason)
  && /fetch them with the promptobus_mailbox tool/.test(unread.reason), JSON.stringify(unread));

// : a live warden does not silence this branch. It wakes whoever is being written to — but
// here the turn is ended by the addressee itself, without having read the mailbox: knocking on
// a session that is already ending its turn is too late. This branch would sit under the
// warden's gate if it were about notification; it's about something else.
store.claimWarden(HOME, TASK, { cli: 'проба' });
// The socket path comes from the shared helper: under `npm test` the sandbox is moved into the
// run directory, and `listen` on such a unix path fails with EINVAL (the sun_path limit), as an
// unhandled event.
const sockPath = makeSockPath('ags-');
const ORCH_SOCK = sockPath('orch');
const orchLive = createServer((c) => { c.end(); });
await new Promise((res, rej) => {
  orchLive.once('error', rej);
  orchLive.listen(ORCH_SOCK, res);
});
store.writeWake(HOME, TASK, 'orchestrator', { socket: ORCH_SOCK, token: 't', session: SESSION });
check(': a live warden does not cancel unread mail — the turn is still returned',
  guardVerdict(HOME, TASK, 'orchestrator')?.key === 'mailbox:2',
  JSON.stringify(guardVerdict(HOME, TASK, 'orchestrator')));
store.clearWarden(HOME, TASK);

store.readInbox(HOME, TASK, 'orchestrator');
check(': mailbox drained — no verdict',
  guardVerdict(HOME, TASK, 'orchestrator') === null,
  JSON.stringify(guardVerdict(HOME, TASK, 'orchestrator')));

// --- CLI process: return code and the reason in stderr -------------------------

// Identity comes from the environment — the same way `resolveIdentity` gets it. `PROMPTOBUS_TASK`
// stands in here for the on-disk binding: for the orchestrator's session, spawn writes it to
// disk, while it's more convenient for the suite to declare the task via the variable.
const cli = (env = {}) => spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: SB,
  env: {
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    PROMPTOBUS_HOME: HOME,
    PROMPTOBUS_TASK: TASK,
    PROMPTOBUS_ROLE: 'orchestrator',
    CLAUDE_CODE_SESSION_ID: SESSION,
    ...env,
  },
  encoding: 'utf8',
});

const MARK_FILE = guardMarkFile(HOME, TASK, 'orchestrator');

// This is how the harness calls the guard: the `Stop` event payload on stdin. The
// `CLAUDE_CODE_SESSION_ID` environment variable is NOT present here — nothing guarantees it to
// the hook process, and the whole point of reading the payload is for identity to come from it.
const stopEvent = (session = SESSION) => JSON.stringify({
  session_id: session,
  transcript_path: path.join(ROOT, 'transcript.jsonl'),
  cwd: SB,
  hook_event_name: 'Stop',
  stop_hook_active: false,
});
const asHook = (input, env = {}) => {
  const clean = { ...process.env, ...env };
  delete clean.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [BIN, 'guard'], {
    cwd: SB,
    input,
    env: {
      ...clean,
      PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
      PROMPTOBUS_HOME: HOME,
      PROMPTOBUS_TASK: TASK,
      PROMPTOBUS_ROLE: 'orchestrator',
    },
    encoding: 'utf8',
  });
};

const clean = cli();
check('CLI: clean — code 0 and NOT A SINGLE line of output',
  clean.status === 0 && clean.stdout === '' && clean.stderr === '',
  `status=${clean.status} out=${JSON.stringify(clean.stdout)} err=${JSON.stringify(clean.stderr)}`);
check('CLI: a clean pass leaves no counter behind', !existsSync(MARK_FILE));

send('question', 'какой контракт события?');
const blocked = cli();
check('CLI: unread mail returns the turn with code 2, the reason — in stderr',
  blocked.status === 2 && blocked.stdout === ''
  && blocked.stderr.startsWith(`${GUARD_MARK}: `) && /mailbox has 1/.test(blocked.stderr),
  `status=${blocked.status} ${blocked.stderr}`);
// The reason travels to the model verbatim (the harness splices stderr into its own
// blockingError), and an icon with color there would be noise in the middle of the sentence.
check('CLI: the reason has no icon and no ANSI — a model reads it, not a terminal',
  !/\u001b\[/.test(blocked.stderr) && !/[✖⚠✔]/.test(blocked.stderr), JSON.stringify(blocked.stderr));
check(`CLI: the reason names the task and the address — it shows which mailbox is meant`,
  blocked.stderr.includes(`PROMPTOBUS_HOME=${HOME}`) && blocked.stderr.includes(`task=${TASK}`)
  && blocked.stderr.includes('address=orchestrator'), blocked.stderr);
check(`CLI: the message in the mailbox is untouched — the guard is not a reader`,
  store.countInbox(HOME, TASK, 'orchestrator') === 1);

// --- loop protection -------------------------------------------------------------
//
// A hook that returns the turn forever hangs the session solid. A cap of its own is needed,
// even though Claude Code has one too (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8): eight returns
// is eight model turns on the same thing, and the harness lifts them with a warning that
// doesn't say what to do.
const again = cli();
check(`protection: a second turn on the same state still gets the turn returned (cap ${GUARD_BLOCK_LIMIT})`,
  again.status === 2, `status=${again.status} ${again.stderr}`);
const third = cli();
// The pass-through channel is `{"systemMessage": …}` on stdout, not stderr: at code 0 the
// harness never surfaces stderr, and nobody would read a warning that the safeguard lifted.
const thirdSaid = (() => { try { return JSON.parse(third.stdout); } catch { return null; } })();
check('protection: a third turn on the same state is let through — code 0 and a line to the feed instead of a return',
  third.status === 0 && /lets the turn through/.test(thirdSaid?.systemMessage ?? '')
  && /returned 2/.test(thirdSaid?.systemMessage ?? ''),
  `status=${third.status} out=${JSON.stringify(third.stdout)} err=${JSON.stringify(third.stderr)}`);
check('protection: the pass-through writes nothing to stderr — at code 0 nobody reads it',
  third.stderr === '', JSON.stringify(third.stderr));
const fourth = cli();
check('protection: it keeps letting through — the counter does not reset on its own',
  fourth.status === 0, `status=${fourth.status} ${fourth.stderr}`);

// A new message is a DIFFERENT state: the counter counts consecutive identical ones, and one
// that arrived while the model was working must return the turn again.
send('status', 'а это пришло, пока модель работала');
const changed = cli();
check('protection: a new message changes the state — the turn is returned again',
  changed.status === 2 && /mailbox has 2/.test(changed.stderr), `status=${changed.status} ${changed.stderr}`);

// The turn-end mark is pushed into the past BEFORE the clean pass: above, the pass that
// exhausted the return cap already set it, and the check below would be green because of
// that — that is, it would pass under any implementation of a clean pass.
const turnWas = store.markTurn(HOME, TASK, 'orchestrator', '2020-01-01T00:00:00.000Z');
store.readInbox(HOME, TASK, 'orchestrator');
const cleared = cli();
check('protection: a clean pass resets the counter and removes the file',
  cleared.status === 0 && cleared.stderr === '' && !existsSync(MARK_FILE),
  `status=${cleared.status} ${cleared.stderr}`);
// : review note — the orchestrator has no bg session, and the warden learns whether it
// "handed off the turn" only from here. The return counter doesn't work for this — a clean
// pass WIPES it (the line above) — so the turn-end mark is its own and survives the counter
// reset.
check(': a clean pass sets the turn-end mark — the warden judges busy-ness by it',
  store.lastTurnAt(HOME, TASK, 'orchestrator') > Date.parse(turnWas),
  `${store.lastTurnAt(HOME, TASK, 'orchestrator')} vs ${Date.parse(turnWas)}`);
send('status', 'после чистого прохода');
check('protection: after a reset the turn is returned again with a full count', cli().status === 2);
store.readInbox(HOME, TASK, 'orchestrator');
cli();

// --- unbound session -------------------------------------------------------------
//
// The hook sits on EVERY session in the workspace. The guard deliberately has no "single
// active session" resolver: otherwise an unrelated session would get its turn returned for
// someone else's run — a human is editing their own code, and the turn gets returned to them
// because of an unread mailbox belonging to someone else's orchestrator.
send('result', 'лежит и ждёт владельца');
const unbound = cli({ PROMPTOBUS_TASK: '', CLAUDE_CODE_SESSION_ID: 'sess-postoronnyaya-9999' });
check(`unbound session: the guard stays silent even though the task's mailbox has unread mail`,
  unbound.status === 0 && unbound.stdout === '' && unbound.stderr === '',
  `status=${unbound.status} out=${JSON.stringify(unbound.stdout)} err=${JSON.stringify(unbound.stderr)}`);

// The on-disk binding works on a par with the declared variable: spawn writes it for the
// owner session, and without it the guard would never fire for a live orchestrator at all.
store.bindSession(HOME, TASK, SESSION);
const bound = cli({ PROMPTOBUS_TASK: '' });
check('on-disk binding: the task resolves without PROMPTOBUS_TASK, the turn is returned',
  bound.status === 2 && bound.stderr.includes(`task=${TASK}`), `status=${bound.status} ${bound.stderr}`);

// The mailbox belongs to someone else — nothing to guard: the originals will go to the owner,
// and "fetch the mailbox" here would be a lie.
const foreign = cli({ CLAUDE_CODE_SESSION_ID: 'sess-chuzhaya-3333' });
check('someone else\'s mailbox: the guard stays silent — nothing to fetch from it',
  foreign.status === 0 && foreign.stderr === '', `status=${foreign.status} ${foreign.stderr}`);

// --- participant: the guard is shared, not orchestrator-only --------
//
// A participant's identity arrives at the hook as ARGUMENTS of its command: the launcher
// writes them into the participant's settings file. Before  the participant guard didn't work
// at all — `PROMPTOBUS_ROLE` resolved to `orchestrator`, no binding was found by the
// participant's session, and `decide` returned `null`;  put the triple into the session's
// environment, and  took it from there: a background session's environment comes from the
// daemon and carries the identity of SOMEONE ELSE'S spawn.
//
// In the launcher's own environment the triple is, at that point, SOMEONE ELSE'S — that's how
// a real background session actually lives. What's checked is exactly that the arguments
// override it.
//
// This session deliberately has no on-disk binding: it isn't written for a participant either,
// and all identity here must come from the arguments — otherwise the check would be about the
// orchestrator.
const WORKER_SESSION = 'sess-worker-2222';
const ALIEN_ENV = {
  PROMPTOBUS_ROLE: 'worker:sosed',
  PROMPTOBUS_TASK: 'chuzhaya-t20260101-000000',
  PROMPTOBUS_HOME: path.join(ROOT, 'chuzhoy-dom'),
};
// Its own launcher, not `asHook`: that one writes `PROMPTOBUS_ROLE: 'orchestrator'` last and
// would overwrite the participant's role. Everything else is the same — the event payload on
// stdin and no `CLAUDE_CODE_SESSION_ID` in the environment.
const asWorker = (role = 'worker:api', { args = true } = {}) => spawnSync(process.execPath, [
  BIN, 'promptobus', 'guard',
  ...(args && role ? ['--role', role, '--task', TASK, '--home', HOME] : []),
], {
  cwd: SB,
  input: stopEvent(WORKER_SESSION),
  env: Object.fromEntries(Object.entries({
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    // The session's environment belongs to someone else, from the daemon: exactly why identity moved into the arguments.
    ...(args ? ALIEN_ENV : { PROMPTOBUS_HOME: HOME, PROMPTOBUS_TASK: TASK, PROMPTOBUS_ROLE: role }),
  }).filter(([k, v]) => k !== 'CLAUDE_CODE_SESSION_ID' && v !== '')),
  encoding: 'utf8',
});
store.sendMessage(HOME, TASK, { from: 'orchestrator', to: 'worker:api', type: 'review', body: 'закрой замечание' });
const workerBlocked = asWorker();
check(': the command\'s arguments beat the foreign triple in the environment — the guard took the address from them',
  workerBlocked.stderr.includes('address=worker:api') && !workerBlocked.stderr.includes('worker:sosed'),
  `status=${workerBlocked.status} ${workerBlocked.stderr}`);
check(': the guard returns the turn to a participant with an unread mailbox — with code 2, same as the orchestrator',
  workerBlocked.status === 2 && /mailbox has 1/.test(workerBlocked.stderr)
  && workerBlocked.stderr.includes('address=worker:api'),
  `status=${workerBlocked.status} ${workerBlocked.stderr}`);
check(': the participant session has no on-disk binding — identity came from the environment',
  store.boundTaskId(HOME, WORKER_SESSION) === null, String(store.boundTaskId(HOME, WORKER_SESSION)));
// The turn-end mark is pushed into the past BEFORE the clean pass: a returned turn doesn't set
// it either, but the return cap below would, and the verdict would be green because of it.
const workerTurnWas = store.markTurn(HOME, TASK, 'worker:api', '2020-01-01T00:00:00.000Z');
store.readInbox(HOME, TASK, 'worker:api');
const workerClean = asWorker();
check(': a participant\'s clean pass sets the turn-end mark — previously only the orchestrator got it',
  workerClean.status === 0 && workerClean.stderr === ''
  && store.lastTurnAt(HOME, TASK, 'worker:api') > Date.parse(workerTurnWas),
  `status=${workerClean.status} ${workerClean.stderr}`
  + ` · ${store.lastTurnAt(HOME, TASK, 'worker:api')} vs ${Date.parse(workerTurnWas)}`);
// The environment remains a FALLBACK path and hasn't stopped working: that's how the guard is
// called by hand, and that's also how the workspace hook lives, which has no arguments at
// all. Take this away too — and the role resolves to `orchestrator`, i.e. exactly the state
// the mechanism lived in before .
store.sendMessage(HOME, TASK, { from: 'orchestrator', to: 'worker:api', type: 'review', body: 'второе замечание' });
const byEnv = asWorker('worker:api', { args: false });
check(': without arguments identity is taken from the environment — the fallback path for a manual run',
  byEnv.status === 2 && byEnv.stderr.includes('address=worker:api'), `status=${byEnv.status} ${byEnv.stderr}`);
const roleless = asWorker('', { args: false });
check(': without a role in the environment the participant session resolves back to the orchestrator and its turn isn\'t held',
  roleless.status === 0 && roleless.stderr === '' && store.countInbox(HOME, TASK, 'worker:api') === 1,
  `status=${roleless.status} ${roleless.stderr} · unread for worker:api ${store.countInbox(HOME, TASK, 'worker:api')}`);
store.readInbox(HOME, TASK, 'worker:api');

// ---  for an address claimed by another session, the guard writes nothing ----
//
// The second line of defense after the arguments. It covers what the arguments don't: a
// manual run with a foreign triple in the environment, and a participant raised by a previous
// release — there identity still comes from the daemon's environment. Writing a foreign
// contact point here would mean redirecting the addressee's notifications into one's own
// session, and the turn-end mark would lie about someone else's turn.
// The log's short id vs. the writer's full uuid — two spellings of one session (measured
// 2026-09-03 on `claude` 2.1.251: `id: "e8c5be23"` while `sessionId: "e8c5be23-dfef-…"`).
const OWN_SHORT = 'e8c5be23';
const OWN_FULL = 'e8c5be23-dfef-4d20-bd96-e2a40a366b97';
const ALIEN_SESSION = '7f3a01bc-2210-4f61-9a0e-1c4d5e6f7a8b';
const CHUZHOY = 'chuzhoy-t20260903-020000';
store.createTask(HOME, { id: CHUZHOY, title: 'адрес за другой сессией', owner: SESSION });
store.upsertParticipant(HOME, CHUZHOY, store.participantRecord('worker:api', { name: 'w-ch', session: OWN_SHORT }));
store.writeWake(HOME, CHUZHOY, 'worker:api', {
  socket: path.join(ROOT, 'svoy.sock'), token: 't', session: OWN_FULL,
});
store.markTurn(HOME, CHUZHOY, 'worker:api', '2020-01-01T00:00:00.000Z');
store.sendMessage(HOME, CHUZHOY, { from: 'orchestrator', to: 'worker:api', type: 'task', body: 'кусок' });
const alienGuard = spawnSync(process.execPath, [
  BIN, 'promptobus', 'guard', '--role', 'worker:api', '--task', CHUZHOY, '--home', HOME,
], {
  cwd: SB,
  input: JSON.stringify({ session_id: ALIEN_SESSION, cwd: SB, hook_event_name: 'Stop' }),
  env: { ...process.env, PATH: `${STUB}${path.delimiter}${process.env.PATH}` },
  encoding: 'utf8',
});
check(': a foreign session writes neither the contact point nor the turn-end mark for this address',
  alienGuard.status === 0 && alienGuard.stderr === ''
  && store.readWake(HOME, CHUZHOY, 'worker:api')?.socket === path.join(ROOT, 'svoy.sock')
  && store.lastTurnAt(HOME, CHUZHOY, 'worker:api') === Date.parse('2020-01-01T00:00:00.000Z'),
  `status=${alienGuard.status} ${alienGuard.stderr}`
  + ` · ${JSON.stringify(store.readWake(HOME, CHUZHOY, 'worker:api'))}`
  + ` · mark ${store.lastTurnAt(HOME, CHUZHOY, 'worker:api')}`);
// The refusal must be visible from THIS door too: the guard's gate sits before `registerWake`,
// and if it stayed silent here, the most common route into trouble — a foreign Stop hook —
// would pass indistinguishably from a clean pass (second review round).
check(': the guard logged its refusal in the warden\'s log',
  store.tailWardenLog(HOME, CHUZHOY, 10).some((l) => l.includes('turn-end mark for address worker:api is refused')
    && l.includes(ALIEN_SESSION)),
  store.tailWardenLog(HOME, CHUZHOY, 5).join('\n') || '(log empty)');
// The owner's session writes both records with the same call: the gate tells a stranger from
// the owner apart, it doesn't forbid writing altogether. The log's short id vs. the full
// uuid — a prefix comparison.
const ownGuard = spawnSync(process.execPath, [
  BIN, 'promptobus', 'guard', '--role', 'worker:api', '--task', CHUZHOY, '--home', HOME,
], {
  cwd: SB,
  input: JSON.stringify({ session_id: OWN_FULL, cwd: SB, hook_event_name: 'Stop' }),
  env: { ...process.env, PATH: `${STUB}${path.delimiter}${process.env.PATH}` },
  encoding: 'utf8',
});
check(': the owner\'s own session returns the turn with the same call — the gate tells a stranger apart, it doesn\'t lock the address',
  ownGuard.status === 2 && /mailbox has 1/.test(ownGuard.stderr), `status=${ownGuard.status} ${ownGuard.stderr}`);

// --- , review note: the session's contact point comes from the event PAYLOAD ------
//
// `CLAUDE_CODE_SESSION_ID` is not promised to the hook process by anything ([15]),
// and the guard resolves its own session from the payload's `session_id`. Read `registerWake`
// as a single environment — on a machine without the variable, the record would land WITHOUT
// the `session` field, meaning every turn end would wipe the owner's stamp, and the second
// line of defense would stop distinguishing at all. The environment here is therefore without
// it, exactly like the real hook.
const SDACHA = 'sdacha-t20260903-030000';
const SDACHA_SOCK = path.join(ROOT, 'sdacha.sock');
store.createTask(HOME, { id: SDACHA, title: 'contact point от хука', owner: SESSION });
store.upsertParticipant(HOME, SDACHA, store.participantRecord('worker:api', { name: 'w-sd' }));
const handedOver = spawnSync(process.execPath, [
  BIN, 'promptobus', 'guard', '--role', 'worker:api', '--task', SDACHA, '--home', HOME,
], {
  cwd: SB,
  input: JSON.stringify({ session_id: OWN_FULL, cwd: SB, hook_event_name: 'Stop' }),
  env: Object.fromEntries(Object.entries({
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    CLAUDE_CODE_MESSAGING_SOCKET: SDACHA_SOCK,
    CLAUDE_CODE_MESSAGING_TOKEN: 'sd',
  }).filter(([k]) => k !== 'CLAUDE_CODE_SESSION_ID')),
  encoding: 'utf8',
});
check(': the contact point is handed over with the session id from the event payload, not from the environment',
  handedOver.status === 0 && store.readWake(HOME, SDACHA, 'worker:api')?.session === OWN_FULL
  && store.readWake(HOME, SDACHA, 'worker:api')?.socket === SDACHA_SOCK,
  `status=${handedOver.status} ${handedOver.stderr} · ${JSON.stringify(store.readWake(HOME, SDACHA, 'worker:api'))}`);

// The task has no `waits/` directory at all — the guard's counter must spin itself up rather
// than choke on the missing directory: a silent write failure would zero out the whole
// safeguard.
const FRESH = 'guard-fresh-t20260829-130000';
store.createTask(HOME, { id: FRESH, title: 'счётчик заводится на пустом месте', owner: SESSION });
store.upsertParticipant(HOME, FRESH, store.participantRecord('worker:api', { name: WORKER_NAME }));
store.sendMessage(HOME, FRESH, { from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог' });
const fresh = cli({ PROMPTOBUS_TASK: FRESH });
check('waits/ doesn\'t exist yet: the turn is returned on unread mail, the counter spins itself up',
  fresh.status === 2 && /mailbox has 1/.test(fresh.stderr)
  && existsSync(guardMarkFile(HOME, FRESH, 'orchestrator')),
  `status=${fresh.status} ${fresh.stderr}`);

// A closed task isn't guarded: there's nothing left to send there. The binding doesn't
// survive `promptobus done`, but a declared PROMPTOBUS_TASK outlives the closing.
store.closeTask(HOME, FRESH);
const closed = cli({ PROMPTOBUS_TASK: FRESH });
check(`closed task: the guard stays silent even though the mailbox has unread mail`,
  closed.status === 0 && closed.stderr === '', `status=${closed.status} ${closed.stderr}`);

// There's no workspace and PROMPTOBUS_HOME isn't set — the guard stays silent instead of
// crashing: it sits on every turn end, and running from an unrelated directory is no reason
// to get in the session's way.
const NOWHERE = makeSandbox('promptobus-promptobus-guard-nowhere-');
const homeless = spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: NOWHERE,
  env: Object.fromEntries(Object.entries({ ...process.env, CLAUDE_CODE_SESSION_ID: SESSION })
    .filter(([k]) => !['PROMPTOBUS_HOME', 'PROMPTOBUS_TASK', 'PROMPTOBUS_ROLE', ['ATI', 'AGENTS_ROOT'].join('_')].includes(k))),
  encoding: 'utf8',
});
check('outside the workspace: stays silent and exits zero instead of crashing',
  homeless.status === 0 && homeless.stdout === '' && homeless.stderr === '',
  `status=${homeless.status} out=${JSON.stringify(homeless.stdout)} err=${JSON.stringify(homeless.stderr)}`);

// --- layout section and a live hook run -----------------------------------------

// : the hook command lives on disk longer than the process that wrote it, so the binary
// inside it is the workspace's own. There's no package in the fixture, and the path stays
// its own; what's checked here is only that root reaches layoutAgentsBin instead of being
// ignored.
const PACK_BIN = path.join(here, '..', 'bin', 'promptobus.js');
const layoutHost = createStandaloneHost({ cwd: ROOT, binPath: PACK_BIN });
const guardRoot = path.join(SB, 'guard-root');
writeHostConfig(guardRoot);
const plantedBin = path.join(guardRoot, 'node_modules', 'promptobus', 'bin', 'promptobus.js');
mkdirSync(path.dirname(plantedBin), { recursive: true });
writeFileSync(plantedBin, '// stub entry\n');
const plantedHost = createStandaloneHost({ cwd: guardRoot, binPath: plantedBin });
check(': the guard\'s command calls the CLI the host named, not the running process',
  guardHookSettings(plantedHost)[GUARD_HOOK_EVENT][0].hooks[0].command.includes(`"${plantedBin}"`),
  guardHookSettings(plantedHost)[GUARD_HOOK_EVENT][0].hooks[0].command);

const section = guardHookSettings(layoutHost);
const group = section[GUARD_HOOK_EVENT][0];
check('section: Stop and SessionStart at the root, one group per event with no matcher',
  Object.keys(section).length === 2 && section[GUARD_HOOK_EVENT].length === 1
  && section[GUARD_START_EVENT].length === 1
  && group.matcher === undefined && group.hooks.length === 1, JSON.stringify(section));
check('section: SessionStart calls the same command as Stop',
  section[GUARD_START_EVENT][0].hooks[0].command === group.hooks[0].command,
  section[GUARD_START_EVENT][0].hooks[0].command);
check('section: the command calls an absolute node, an absolute binary, and the guard subcommand',
  group.hooks[0].type === 'command'
  && group.hooks[0].command === `"${process.execPath}" "${PACK_BIN}" promptobus guard`,
  group.hooks[0].command);

// A live run of the assembly: exactly the command layout puts into settings.json is run with
// the `Stop` event payload on stdin — that's how Claude Code calls it. We check what the
// harness will see: code 2 and the reason in stderr. Measured on binary 2.1.251: code 2 gives
// a `blockingError` with the stderr text, any other non-zero code is just a warning that
// doesn't return the turn.
send('question', 'живой прогон хука');
const hookRun = asHook(stopEvent());
check('live run: the Stop event on stdin — code 2 and the reason in stderr',
  hookRun.status === 2 && hookRun.stderr.includes(GUARD_MARK) && hookRun.stdout === '',
  `status=${hookRun.status} out=${JSON.stringify(hookRun.stdout)} err=${hookRun.stderr}`);

// Identity came FROM THE PAYLOAD: the environment variable is absent from this run entirely.
// The  measurement about `CLAUDE_CODE_SESSION_ID` was taken on the MCP server's child
// process, and nothing promises that variable to the hook process — were it missing, the
// guard would silently fail to work on every turn, indistinguishable from a clean pass.
check('identity: session_id is taken from the payload, not from the environment',
  hookRun.stderr.includes(`task=${TASK}`), hookRun.stderr);
const wrongSession = asHook(stopEvent('sess-postoronnyaya-9999'), { PROMPTOBUS_TASK: '' });
check('identity: a foreign session_id from the payload finds no binding — silence',
  wrongSession.status === 0 && wrongSession.stdout === '' && wrongSession.stderr === '',
  `status=${wrongSession.status} out=${JSON.stringify(wrongSession.stdout)}`);
// The on-disk binding for SESSION already exists (above) — and by it the task resolves
// without PROMPTOBUS_TASK.
const boundByEvent = asHook(stopEvent(), { PROMPTOBUS_TASK: '' });
check('identity: the on-disk binding is found by the session_id from the payload',
  boundByEvent.status === 2 && boundByEvent.stderr.includes(`task=${TASK}`),
  `status=${boundByEvent.status} ${boundByEvent.stderr}`);

// There's no payload, or it doesn't parse — the fallback path through the environment. This
// is how a human calls the guard by hand, and there's no reason to refuse them just because
// stdin is empty. The second message here isn't for show: two returns on this state have
// already happened, and without a state change a third would be a legitimate pass-through —
// the check would be silent about the wrong thing.
send('status', 'второе — состояние стало другим');
const noPayload = spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: SB,
  input: 'не json вовсе',
  env: {
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    PROMPTOBUS_HOME: HOME,
    PROMPTOBUS_TASK: TASK,
    PROMPTOBUS_ROLE: 'orchestrator',
    CLAUDE_CODE_SESSION_ID: SESSION,
  },
  encoding: 'utf8',
});
check('fallback path: the payload didn\'t parse — identity is taken from the environment',
  noPayload.status === 2 && noPayload.stderr.includes(GUARD_MARK),
  `status=${noPayload.status} ${noPayload.stderr}`);
store.readInbox(HOME, TASK, 'orchestrator');

// Dest has no plugin settings merge. Standalone host does not plant Stop groups into
// a consumer's ~/.claude/settings.json — that is the host adapter's job.
check('standalone: the guard section is self-contained — the hook command is in place',
  typeof group.hooks[0].command === 'string' && group.hooks[0].command.includes('guard'),
  group.hooks[0].command);

// The counter lives inside the task's own directory, not one of its own: cleaning up the task
// sweeps it away along with the rest of its state.
check('the counter lives in the task\'s waits/ directory',
  path.dirname(MARK_FILE) === path.join(store.taskDir(HOME, TASK), 'waits'),
  `${MARK_FILE} · ${store.taskDir(HOME, TASK)}`);
// The name is the address plus a suffix, and a colon in a filename gives way to a hyphen
// (Windows). Two addresses of the same task therefore have different counters: a shared one
// would be reset by someone else's turn.
const workerMark = guardMarkFile(HOME, TASK, 'worker:api');
check('the counter is named by address: colon gives way to hyphen, suffix .guard.json',
  path.basename(MARK_FILE) === 'orchestrator.guard.json'
  && path.basename(workerMark) === 'worker-api.guard.json',
  `${path.basename(MARK_FILE)} · ${path.basename(workerMark)}`);

// ---  the guard does not trigger a move ------------------------------
//
// No one will see a report from here: at code 0 the hook's stderr never surfaces, and a move
// is promised to the user in numbers. The guard therefore resolves the home but doesn't move
// the store — and on a workspace that needs a move, it silently lets the turn through.
// --- leftover foreign store: standalone host has no legacyLayout, so guard
// neither migrates nor skips the live mailbox. ---------------------------------
const MIG_ROOT = path.join(ROOT, 'ne-dvigay');
writeHostConfig(MIG_ROOT);
const MIG_LEFTOVER = path.join(MIG_ROOT, 'legacy', 'a2a');
const MIG_TASK = 'guard-migr-t20260902-100000';
const { legacy } = await import(path.join(here, '..', 'dist', 'index.js'));
legacy.createTask(MIG_LEFTOVER, { id: MIG_TASK, title: 'store прежней шины', owner: SESSION });
legacy.upsertParticipant(MIG_LEFTOVER, MIG_TASK, { address: 'worker:api', name: WORKER_NAME });
legacy.sendMessage(MIG_LEFTOVER, MIG_TASK, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'непрочитанное прежнего store',
});
legacy.closeTask(MIG_LEFTOVER, MIG_TASK);
const beforeGuard = readdirSync(path.join(MIG_LEFTOVER, 'tasks')).sort();

const migRun = spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: MIG_ROOT,
  env: {
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    PROMPTOBUS_HOME: path.join(MIG_ROOT, '.promptobus'),
    PROMPTOBUS_TASK: MIG_TASK,
    PROMPTOBUS_ROLE: 'orchestrator',
    CLAUDE_CODE_SESSION_ID: SESSION,
  },
  input: JSON.stringify({ session_id: SESSION, cwd: MIG_ROOT }),
  encoding: 'utf8',
});

check(': leftover foreign store: standalone guard does not migrate it',
  existsSync(MIG_LEFTOVER)
  && readdirSync(path.join(MIG_LEFTOVER, 'tasks')).sort().join(',') === beforeGuard.join(','),
  `legacy ${existsSync(MIG_LEFTOVER) ? 'kept' : 'gone'} · guard ${migRun.status} ${migRun.stderr}`);
check(': leftover foreign store: guard does not treat it as the live mailbox',
  migRun.status === 0 && !migRun.stderr.includes(GUARD_MARK),
  `code ${migRun.status} · out «${migRun.stdout.trim()}» · err «${migRun.stderr.trim()}»`);

// Unread in the live .promptobus still returns the turn even if a leftover catalog sits nearby.
const BOTH_ROOT = path.join(ROOT, 'oba-kornya');
writeHostConfig(BOTH_ROOT);
const BOTH_HOME = path.join(BOTH_ROOT, '.promptobus');
const BOTH_TASK = 'guard-oba-t20260902-101000';
store.createTask(BOTH_HOME, { id: BOTH_TASK, title: 'оба корня сразу', owner: SESSION });
store.upsertParticipant(BOTH_HOME, BOTH_TASK, store.participantRecord('worker:api', { name: WORKER_NAME }));
store.sendMessage(BOTH_HOME, BOTH_TASK, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'непрочитанное в новом корне',
});
mkdirSync(path.join(BOTH_ROOT, 'legacy', 'a2a', 'tasks'), { recursive: true });

const bothRun = spawnSync(process.execPath, [BIN, 'guard'], {
  cwd: BOTH_ROOT,
  env: {
    ...process.env,
    PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
    PROMPTOBUS_HOME: BOTH_HOME,
    PROMPTOBUS_TASK: BOTH_TASK,
    PROMPTOBUS_ROLE: 'orchestrator',
    CLAUDE_CODE_SESSION_ID: SESSION,
  },
  input: JSON.stringify({ session_id: SESSION, cwd: BOTH_ROOT }),
  encoding: 'utf8',
});

check(': leftover catalog does not skip the live mailbox — unread still returns the turn',
  bothRun.status === 2 && /mailbox has 1/.test(bothRun.stderr)
  && store.countInbox(BOTH_HOME, BOTH_TASK, 'orchestrator') === 1,
  `code ${bothRun.status} · out «${bothRun.stdout.trim()}» · err «${bothRun.stderr.trim()}»`
  + ` · unread ${store.countInbox(BOTH_HOME, BOTH_TASK, 'orchestrator')}`);
check(': leftover catalog and live store both stay on disk',
  existsSync(path.join(BOTH_ROOT, 'legacy', 'a2a')) && existsSync(BOTH_HOME));

// --- orchestrator successor: a root detector, not an auto-claim --------------------
const SUCC = 'succ-t20260904-010000';
const OLD_ORCH = 'sess-old-orch-aaaa';
const HEIR = 'sess-heir-bbbb';
const WORKER_SID = 'sess-worker-succ-cccc';
const asHeir = (session, { cwd = SB, role = '', task = '', event = 'Stop' } = {}) => spawnSync(
  process.execPath, [BIN, 'guard'], {
    cwd,
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: event }),
    env: Object.fromEntries(Object.entries({
      ...process.env,
      PATH: `${STUB}${path.delimiter}${process.env.PATH}`,
      PROMPTOBUS_HOME: HOME,
      PROMPTOBUS_TASK: task,
      PROMPTOBUS_ROLE: role,
    }).filter(([k, v]) => k !== 'CLAUDE_CODE_SESSION_ID' && v !== '')),
    encoding: 'utf8',
  },
);
const heirSaid = (run) => { try { return JSON.parse(run.stdout); } catch { return null; } };

let probeCalls = 0;
const countingProbe = async (socket) => {
  probeCalls += 1;
  return probeContactPoint(socket);
};
await successorVerdict(HOME, SB, HEIR, undefined, countingProbe);
check('successor: live owner — probe is not called',
  probeCalls === 0, String(probeCalls));

const liveOwner = asHeir(HEIR);
check('successor: owner is alive — the guard stays silent for a foreign session at the root',
  liveOwner.status === 0 && liveOwner.stdout === '' && liveOwner.stderr === '',
  `status=${liveOwner.status} out=${JSON.stringify(liveOwner.stdout)} err=${JSON.stringify(liveOwner.stderr)}`);

const START_SID = 'sess-bound-start-dddd';
const START_TASK = 'start-t20260904-030000';
store.createTask(HOME, { id: START_TASK, title: 'SessionStart не сторожит', owner: START_SID });
store.upsertParticipant(HOME, START_TASK, store.participantRecord('worker:api', { name: 'w-start' }));
store.sendMessage(HOME, START_TASK, {
  from: 'worker:api', to: 'orchestrator', type: 'result', body: 'непрочитанное на старте',
});
store.bindIfOwner(HOME, START_TASK, START_SID);
const startBound = asHeir(START_SID, { event: 'SessionStart', role: 'orchestrator', task: START_TASK });
const startBoundMark = guardMarkFile(HOME, START_TASK, 'orchestrator');
check('successor: SessionStart for a session with a live binding does not return the turn',
  startBound.status === 0 && !startBound.stderr.includes(GUARD_MARK)
  && !existsSync(startBoundMark),
  `status=${startBound.status} err=${JSON.stringify(startBound.stderr)} mark=${existsSync(startBoundMark)}`);

store.createTask(HOME, { id: SUCC, title: 'преемник после смены id', owner: OLD_ORCH });
store.upsertParticipant(HOME, SUCC, store.participantRecord('worker:api', {
  name: 'w-succ', session: WORKER_SID,
}));
store.writeWake(HOME, SUCC, 'orchestrator', {
  socket: path.join(ROOT, 'dead-orch.sock'), token: 't', session: OLD_ORCH,
});
store.writeHealth(HOME, SUCC, {
  orchestrator: { channel: 'self-wake', knockError: 'ENOENT', triedAt: '2026-09-03T20:31:43.000Z' },
});
store.sendMessage(HOME, SUCC, { from: 'worker:api', to: 'orchestrator', type: 'result', body: 'итог преемнику' });

const emptyDead = 'empty-t20260904-040000';
store.createTask(HOME, { id: emptyDead, title: 'мёртвый без непрочитанного', owner: OLD_ORCH });
store.writeWake(HOME, emptyDead, 'orchestrator', {
  socket: path.join(ROOT, 'empty-dead.sock'), token: 't', session: OLD_ORCH,
});

const deadHint = asHeir(HEIR);
const deadText = heirSaid(deadHint)?.systemMessage ?? '';
check('successor: owner\'s socket is ENOENT — the guard prints the task id and the claim command',
  deadHint.status === 0 && deadHint.stderr === ''
  && deadText.includes(SUCC) && deadText.includes('преемник после смены id')
  && deadText.includes(OLD_ORCH) && deadText.includes('2026-09-03T20:31:43.000Z')
  && /unread 1/.test(deadText)
  && deadText.includes('promptobus_mailbox {claim: true}')
  && !deadText.includes(emptyDead),
  `status=${deadHint.status} out=${JSON.stringify(deadHint.stdout)} err=${JSON.stringify(deadHint.stderr)}`);
check('successor: the turn is not returned — a foreign session at the root is not obligated to be the successor',
  deadHint.status === 0 && !deadHint.stderr.includes(GUARD_MARK),
  `status=${deadHint.status} ${deadHint.stderr}`);

const HEIR2 = 'sess-heir-eeee';
const otherHeir = asHeir(HEIR2);
const otherText = heirSaid(otherHeir)?.systemMessage ?? '';
check('successor: a second session at the root on the same state also gets the hint',
  otherHeir.status === 0 && otherText.includes(SUCC) && otherText.includes('promptobus_mailbox {claim: true}'),
  `status=${otherHeir.status} out=${JSON.stringify(otherHeir.stdout)}`);

const deadHintAgain = asHeir(HEIR);
check('successor: a second turn end on the same state stays silent',
  deadHintAgain.status === 0 && deadHintAgain.stdout === '' && deadHintAgain.stderr === '',
  `status=${deadHintAgain.status} out=${JSON.stringify(deadHintAgain.stdout)}`);

const workerHint = asHeir(WORKER_SID, { role: 'worker:api', task: SUCC });
check('successor: a participant session — the guard stays silent even with a dead orchestrator',
  workerHint.status === 0 && workerHint.stdout === '' && workerHint.stderr === '',
  `status=${workerHint.status} out=${JSON.stringify(workerHint.stdout)} err=${JSON.stringify(workerHint.stderr)}`);

store.sendMessage(HOME, SUCC, { from: 'worker:api', to: 'orchestrator', type: 'status', body: 'ещё одно' });
const startHint = asHeir(HEIR, { event: 'SessionStart' });
const startOut = heirSaid(startHint);
const startText = startOut?.hookSpecificOutput?.additionalContext ?? startOut?.systemMessage ?? '';
check('successor: SessionStart at the root carries the same text in additionalContext',
  startHint.status === 0 && startText.includes(SUCC) && startText.includes('promptobus_mailbox {claim: true}')
  && startOut?.hookSpecificOutput?.hookEventName === 'SessionStart',
  `status=${startHint.status} out=${JSON.stringify(startHint.stdout)}`);

const elsewhere = path.join(ROOT, 'not-root');
mkdirSync(elsewhere, { recursive: true });
const otherCwd = asHeir(HEIR, { cwd: elsewhere });
check('successor: cwd is not the workspace root — stays silent',
  otherCwd.status === 0 && otherCwd.stdout === '' && otherCwd.stderr === '',
  `status=${otherCwd.status} out=${JSON.stringify(otherCwd.stdout)}`);

const verdictLine = successorLine(
  { id: SUCC, title: 'преемник после смены id' }, OLD_ORCH, '2026-09-03T20:31:43.000Z', 2,
);
check('successor: successorLine names the task, the owner, the time, and the claim',
  verdictLine.includes(SUCC) && verdictLine.includes(OLD_ORCH)
  && verdictLine.includes('promptobus_mailbox {claim: true}'),
  verdictLine);
const direct = await successorVerdict(HOME, SB, HEIR);
check('successor: successorVerdict sees SUCC\'s dead socket and stays silent about the live TASK',
  typeof direct === 'string' && direct.includes(SUCC) && !direct.includes(TASK),
  String(direct));
check('successor: the mailbox after a hint is untouched — the guard is not a reader and not a claim',
  store.countInbox(HOME, SUCC, 'orchestrator') === 2
  && store.taskOwner(HOME, SUCC) === OLD_ORCH,
  `${store.countInbox(HOME, SUCC, 'orchestrator')} · ${store.taskOwner(HOME, SUCC)}`);
orchLive.close();

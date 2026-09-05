// Wake channel of a Cursor participant (rewritten for persist sessions in ).
// Run: npm test
//
// Subject — a loop a non-Claude participant never had: a message landed in the mailbox,
// and the mechanism DELIVERED it into a live session. For Claude Code that is an injection
// into the messaging socket; for Cursor it is an injection into the TUI input field
// through the tmux buffer, and the channel is two halves, both exercised live here:
//
//   1. **end of turn brings the `stop` hook** — it calls `promptobus guard`, which hands
//      over a contact point with a finished-turn counter (`sessionEnd` does not fire
//      under persist at all);
//   2. **the warden activates immediately when the contact point is rewritten** — and
//      the driver `activate` pastes the wake text into the live session.
//
// **The gap with Claude Code narrowed, and this file checks how far.** A message that
// arrives during a turn now GETS THROUGH: it is queued on the session and runs as a
// separate turn right after the current one, WITHOUT a new process. It still does not
// enter the turn in progress — and the mechanism says so in words, not by silence.
//
// **The file runs in a serial runner group.** It measures wall-clock time: the participant
// turn is held by a pause, the warden loop runs once a second, and under pool load those
// thresholds either go red on working code or go green on nothing.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { PROMPTOBUS_BIN, buildWorkspace, cli, store } from './scenario.mjs';
import { diagnoseTrace, installHarness, planParticipant, serverDir } from './harness-cursor.mjs';
import { waitFor } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-cursor-wake-');
const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin') });

const { cursorDriver } = await import(path.join(here, '..', 'lib', 'driver-cursor.js'));
const {
  listSessions, readSession, CURSOR_TMUX_SERVER,
} = await import(path.join(here, '..', 'lib', 'cursor-persist.js'));

// --- the run talks to ITS tmux, not to the machine's --------------------------------
//
// The mechanism asks for the server by a name the whole machine shares:
// `tmux -L cursor-agent`, with `TMUX_TMPDIR=/tmp`, deliberately, so a person finds
// participant sessions next to their own with `agent persist list`. Under the suite
// that name must never reach a real tmux — it would put this file's stand-in session
// on the one server every other run and the person themself are using, and a session
// that disappeared from under the wake loop reads as a mechanism failure. The stand's
// stub keys sessions by its own home instead ([harness-cursor.mjs](harness-cursor.mjs)),
// so the scoping holds as long as the `tmux` this run resolves is the stub.
//
// Both halves are checked, because each fails on its own: the binary (a lost stub on
// PATH reaches the machine) and the state (a stub that wrote outside its home would
// share a directory with a neighbour). Filed as PB-14.4, whose other member — the
// machine-wide `pgrep` in promptobus-driver-codex.test.mjs — reproduced on purpose
// with two concurrent runs 2026-09-05.
const BIN_DIR = path.join(SB, 'bin');
const resolvedTmux = (process.env.PATH ?? '').split(path.delimiter)
  .map((dir) => path.join(dir, 'tmux')).find((file) => existsSync(file)) ?? null;
check('step 0: the tmux this run resolves is the stand\'s stub, not the machine\'s binary',
  resolvedTmux !== null && path.dirname(resolvedTmux) === BIN_DIR,
  `${resolvedTmux} · stand bin ${BIN_DIR}`);

const TASK = 'cursorwake-t20260903-000000';
const WORKER = 'worker:wake';
const ORCH_SESSION = `orch-wake-${process.pid}`;
const MARK = {
  first: 'WAKE-STATUS-1', second: 'WAKE-STATUS-2', third: 'WAKE-RESULT-3',
  answerA: 'WAKE-ANSWER-A', answerB: 'WAKE-ANSWER-B',
};

// The pause inside the woken turn is the subject, not decoration: while it runs, a
// second message arrives. The warden loop is once a second, and eight seconds is enough
// both for delivery into a busy session and for a verdict on it; the turn stays short.
const TURN_HOLD_MS = 8000;

const { ws, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'cursor'] });
const home = path.join(ws, '.promptobus');
const brief = path.join(SB, 'brief.md');
writeFileSync(brief, '# Cursor participant wake\n\nFollow the stand script.\n');

// Three turns, and that is the price of the subject. The first ends quickly — it hands
// over a contact point, without which there is nothing to wake. The second is started by
// the warden and HELD by a pause: the second message arrives in exactly that window, and
// that is the delivery-into-a-busy-session check. The third handles it — same process,
// no new one.
planParticipant(HARNESS, WORKER, {
  turns: [
    { do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK.first}: первый ход` } }] },
    {
      do: [
        { tool: 'promptobus_mailbox' },
        // The report goes BEFORE the pause on purpose: it is the sign "this turn already
        // fetched the mailbox". Send the second message earlier — the same turn would
        // take it, and the gap this file exists for would stay untested.
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK.second}: разбудили первым сообщением` } },
        { wait: TURN_HOLD_MS },
      ],
    },
    {
      do: [
        { tool: 'promptobus_mailbox' },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.third}: доставлено следующим ходом` } },
      ],
    },
  ],
});

const env = { ...process.env, PROMPTOBUS_HOME: home, CLAUDE_CODE_SESSION_ID: ORCH_SESSION };
// The warden is lifted BY HAND, as in E2E: the shared hygiene list kills auto-lift, and
// the runner verdict goes red on it. The separate process is real.
const wardenEnv = { ...env };
delete wardenEnv.PROMPTOBUS_WARDEN;
store.createTask(home, { id: TASK, title: 'пробуждение участника Cursor', owner: ORCH_SESSION });
const wardenLog = path.join(SB, 'warden.out');
const warden = spawn(process.execPath, [PROMPTOBUS_BIN, 'warden', '--task', TASK], {
  cwd: ws, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: wardenEnv,
});
const keep = (c) => { try { appendFileSync(wardenLog, c); } catch { /* sandbox already gone */ } };
warden.stdout.on('data', keep);
warden.stderr.on('data', keep);

const live = await waitFor(() => store.liveWarden(home, TASK), { timeoutMs: 20000 });
check('step 1: the task warden is up as a real process', !!live?.pid, JSON.stringify(live));

const spawned = cli([ 'spawn', '--repo', repo, '--brief', brief, '--task', TASK,
  '--worker', 'wake', '--harness', 'cursor'], { cwd: ws, env });
check('step 2: the Cursor participant is up, and its session is live',
  spawned.status === 0 && /worker worker:wake lifted/.test(spawned.out), spawned.out.slice(-400));

const wp = store.participantOf(store.readTask(home, TASK), WORKER);
const ref = wp?.sessionRef ?? '';
check('step 2: the participant capabilities snapshot declares push — the warden will wake it',
  wp?.harness === 'cursor' && wp?.capabilities?.activation === 'push', JSON.stringify(wp?.capabilities));

// --- first end of turn hands over the contact point ---------------------------------

const record = readSession(ref, env);
const panePid = record?.panePid ?? null;
check('step 2: the session state sits in THIS run\'s stand home — a neighbouring run has its own',
  !!record?.sessionName
  && existsSync(path.join(serverDir(HARNESS, CURSOR_TMUX_SERVER), 'sessions',
    `${record.sessionName}.json`)),
  `${record?.sessionName} · ${path.join(serverDir(HARNESS, CURSOR_TMUX_SERVER), 'sessions')}`);

const wake0 = await waitFor(() => store.readWake(home, TASK, WORKER), { timeoutMs: 30000 });
check('step 3: end of turn handed over a contact point with a turn counter — that is how the warden sees the change',
  typeof wake0?.socket === 'string' && /#\d+$/.test(wake0.socket) && wake0.session === record?.chatId,
  `${JSON.stringify(wake0)} · chat ${record?.chatId}`);

check('step 3: the first participant turn ended and reported — the loop is started',
  !!(await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => String(m.body ?? '').includes(MARK.first)) ?? null, { timeoutMs: 30000 })),
  diagnoseTrace(HARNESS, WORKER));

// --- message to an idle session: the warden pastes it into the live session ---------

store.sendMessage(home, TASK, {
  from: 'orchestrator', to: WORKER, type: 'answer', body: `${MARK.answerA}: сессия простаивала`,
});

// The wake sign is THIS turn's report: it goes out right after the mailbox fetch, so it
// proves both that the turn started and that it already handled its unread.
const woken = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK.second)) ?? null, { timeoutMs: 60000 });
check('step 4: the warden woke the idle session — the text arrived by injection',
  !!woken,
  `${JSON.stringify(woken)} · warden journal: ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);

check('step 4: the wake happened WITHOUT a new process — the session pane is the same',
  readSession(ref, env)?.panePid === panePid && listSessions({ env })
    .some((s) => s.name === record?.sessionName),
  `${panePid} → ${readSession(ref, env)?.panePid} · ${JSON.stringify(listSessions({ env }))}`);

// --- message DURING a turn: it gets through, but runs on the next one ---------------
//
// Send it STRICTLY after the woken turn's report: one that arrived earlier would be
// taken by the same turn, and the gap this file exists for would stay untested.

store.sendMessage(home, TASK, {
  from: 'orchestrator', to: WORKER, type: 'answer', body: `${MARK.answerB}: ответ пришёл во время хода`,
});

const busyDelivery = await cursorDriver.activate({ ref }, {
  kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
});
check('step 5: delivery into a turn IN PROGRESS succeeds — the text is queued, not refused',
  busyDelivery?.ok === true, JSON.stringify(busyDelivery));

check('step 5: the turn in progress did not see it — the message is still unread',
  store.countInbox(home, TASK, WORKER) >= 1, String(store.countInbox(home, TASK, WORKER)));

check('step 5: delivery did not start a second process — panePid is the same, one session',
  readSession(ref, env)?.panePid === panePid
  && listSessions({ env }).filter((s) => s.name === record?.sessionName).length === 1,
  `${panePid} → ${readSession(ref, env)?.panePid} · ${JSON.stringify(listSessions({ env }))}`);

// --- the queue runs on the next turn ------------------------------------------------

const answered = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK.third)) ?? null, { timeoutMs: 90000 });
check('step 6: the loop closed — a message that arrived during a turn was handled by the NEXT one',
  !!answered, `${JSON.stringify(answered)} · warden journal: ${store.tailWardenLog(home, TASK).slice(-14).join(' | ')} · ${diagnoseTrace(HARNESS, WORKER)}`);

check('step 6: the participant fetched its own mailbox — it confirms delivery, not the warden',
  await waitFor(() => store.countInbox(home, TASK, WORKER) === 0, { timeoutMs: 20000 }),
  String(store.countInbox(home, TASK, WORKER)));

check('step 6: this turn also ran in the same session — the process did not change over the loop',
  readSession(ref, env)?.panePid === panePid, `${panePid} → ${readSession(ref, env)?.panePid}`);

const wakeAfter = store.readWake(home, TASK, WORKER);
check('step 6: each end of turn rewrites the fingerprint — the turn counter grew',
  wakeAfter?.socket !== wake0?.socket, `${wake0?.socket} → ${wakeAfter?.socket}`);

// --- cleanup -----------------------------------------------------------------------

const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
check('step 6: promptobus done closed the task, stopped the participant and removed the persist session',
  done.status === 0 && cursorDriver.inspect(ref)?.state === 'gone' && listSessions({ env }).length === 0,
  `${done.out.slice(-300)} · ${JSON.stringify(cursorDriver.inspect(ref))} · ${JSON.stringify(listSessions({ env }))}`);

const gone = await waitFor(() => (store.liveWarden(home, TASK) ? null : true), { timeoutMs: 30000 });
check('step 6: the warden of the closed task exited on its own',
  gone === true, `${JSON.stringify(store.liveWarden(home, TASK))} · ${wardenLog}`);

try {
  process.kill(-warden.pid, 'SIGTERM');
} catch {
  // No group, or the process already exited — both branches are legal.
}
restore();

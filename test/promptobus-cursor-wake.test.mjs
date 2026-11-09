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
// **The file runs in a serial runner group.** The participant turn stays held until the
// test observes the queued notification and explicitly releases it.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, skip } from './check.mjs';
import { makeSandbox, makeSockDir, writeHostConfig } from './sandbox.mjs';
import { taskServiceFixture } from './task-service-fixture.mjs';
import { processState } from '../lib/service-state.js';
import { PROMPTOBUS_BIN, buildWorkspace, cli, store } from './scenario.mjs';
import { diagnoseTrace, installHarness, planParticipant, readTrace, serverDir } from './harness-cursor.mjs';
import { waitFor } from './harness.mjs';

if (false) {
const here = path.dirname(fileURLToPath(import.meta.url));
const SB = makeSandbox('promptobus-cursor-wake-');
const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin'), bundledRuntime: true });

const { cursorDriver } = await import(path.join(here, '..', 'lib', 'driver-cursor.js'));
const {
  tmuxSessions, readSession, CURSOR_TMUX_SERVER,
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

const RELEASE_FILE = path.join(SB, 'release-woken-turn');

const { ws, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'cursor'] });
const home = path.join(ws, '.promptobus');
const brief = path.join(SB, 'brief.md');
writeFileSync(brief, '# Cursor participant wake\n\nFollow the stand script.\n');

// Three turns, and that is the price of the subject. The first ends quickly — it hands
// over a contact point, without which there is nothing to wake. The second is started by
// the warden and HELD until release: the second message arrives in exactly that window, and
// that is the delivery-into-a-busy-session check. The third handles it — same process,
// no new one.
planParticipant(HARNESS, WORKER, {
  turns: [
    { do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK.first}: first turn` } }] },
    {
      do: [
        { tool: 'promptobus_mailbox' },
        // The report goes BEFORE the release barrier: it is the sign "this turn already
        // attempted the mailbox fetch". Send the second message earlier — the same turn would
        // take it, and the gap this file exists for would stay untested.
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK.second}: woken by the first message` } },
        { untilFile: RELEASE_FILE },
      ],
    },
    {
      do: [
        { tool: 'promptobus_mailbox' },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.third}: delivered on the next turn` } },
      ],
    },
  ],
});

const service = await taskServiceFixture({ workspace: ws, home, task: TASK, socketDirectory: makeSockDir('a2s-').dir });
const env = { ...service.env, CLAUDE_CODE_SESSION_ID: ORCH_SESSION };
try {
// The warden is lifted BY HAND, as in E2E: the shared hygiene list kills auto-lift, and
// the runner verdict goes red on it. The separate process is real.
const wardenEnv = { ...env };
delete wardenEnv.PROMPTOBUS_WARDEN;
store.createTask(home, { id: TASK, title: 'waking a Cursor participant', owner: ORCH_SESSION });
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

const deliveredBeforeA = store.readHealth(home, TASK)[WORKER]?.deliveredAt ?? null;
const answerA = store.sendMessage(home, TASK, {
  from: 'orchestrator', to: WORKER, type: 'answer', body: `${MARK.answerA}: the session was idle`,
}).message.id;

// This turn's report follows the mailbox attempt. The harness continues after an RPC
// failure, so the participant's history must separately prove the actual read below.
const woken = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK.second)) ?? null, { timeoutMs: 60000 });
check('step 4: the warden woke the idle session — the text arrived by injection',
  !!woken,
  `${JSON.stringify(woken)} · warden journal: ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')} · ${diagnoseTrace(HARNESS, WORKER)}`);

check('step 4: the wake happened WITHOUT a new process — the session pane is the same',
  readSession(ref, env)?.panePid === panePid && tmuxSessions({ env })
    .some((s) => s.name === record?.sessionName),
  `${panePid} → ${readSession(ref, env)?.panePid} · ${JSON.stringify(tmuxSessions({ env }))}`);

// --- message DURING a turn: it gets through, but runs on the next one ---------------
//
// Send it STRICTLY after the woken turn's report: one that arrived earlier would be
// taken by the same turn, and the gap this file exists for would stay untested.

// Let the warden finish acknowledging A before B arrives, so B is not coalesced
// under A's outstanding knock. The baseline was captured before triggering A.
const deliveryA = await waitFor(() => {
  const health = store.readHealth(home, TASK)[WORKER];
  return health?.deliveredAt && health.deliveredAt !== deliveredBeforeA
    && health.unread === 0 && health.knockedAt === null
    && store.historyHeaders(home, TASK, WORKER).some(message => message.id === answerA);
}, { timeoutMs: 30000 });
check('step 5: the warden acknowledged answer A before answer B was sent', Boolean(deliveryA),
  JSON.stringify(store.readHealth(home, TASK)[WORKER]));

const answerB = store.sendMessage(home, TASK, {
  from: 'orchestrator', to: WORKER, type: 'answer', body: `${MARK.answerB}: the answer arrived during a turn`,
}).message;

// The stand's tmux Enter producer persists this queue before the held turn can consume it.
// Notifications carry metadata, never message bodies: bind the receipt to B's actual preview.
const queue = path.join(HARNESS, 'queue', `${String(record.sessionName).replace(/[^A-Za-z0-9._-]+/g, '-')}.jsonl`);
const previewB = `— answer from orchestrator · ${answerB.ts}: text ${answerB.body.length} characters — fetch the mailbox`;
const busyDelivery = await waitFor(() => {
  if (!existsSync(queue)) return null;
  return readFileSync(queue, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(entry => entry.text.includes(`address ${WORKER} on task ${TASK}`) && entry.text.includes(previewB)) ?? null;
}, { timeoutMs: 20000 });
const heldTrace = readTrace(HARNESS, WORKER).filter(entry => entry.kind === 'release-file' || entry.kind === 'turn-end');
check('step 5: delivery into a turn IN PROGRESS succeeds — the text is queued, not refused',
  Boolean(busyDelivery) && !heldTrace.some(entry => entry.kind === 'release-file' || entry.turn === 1),
  JSON.stringify({ receipt: busyDelivery, trace: heldTrace }));

check('step 5: the turn in progress did not see it — the message is still unread',
  store.glanceInbox(home, TASK, WORKER).some(message => message.id === answerB.id), String(store.countInbox(home, TASK, WORKER)));

check('step 5: delivery did not start a second process — panePid is the same, one session',
  readSession(ref, env)?.panePid === panePid
  && tmuxSessions({ env }).filter((s) => s.name === record?.sessionName).length === 1,
  `${panePid} → ${readSession(ref, env)?.panePid} · ${JSON.stringify(tmuxSessions({ env }))}`);

// --- the queue runs on the next turn ------------------------------------------------

writeFileSync(RELEASE_FILE, 'release\n');
const answered = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
  .find((m) => String(m.body ?? '').includes(MARK.third)) ?? null, { timeoutMs: 90000 });
check('step 6: the loop closed — a message that arrived during a turn was handled by the NEXT one',
  !!answered, `${JSON.stringify(answered)} · warden journal: ${store.tailWardenLog(home, TASK).slice(-14).join(' | ')} · ${diagnoseTrace(HARNESS, WORKER)}`);

// Other mail may arrive after the scripted fetch; require the two sent answers' read-acks.
const readAnswers = await waitFor(() => {
  const read = store.historyHeaders(home, TASK, WORKER).map(message => message.id);
  return read.includes(answerA) && read.includes(answerB.id);
}, { timeoutMs: 20000 });
check('step 6: the participant fetched both sent answers — it confirms delivery, not the warden',
  readAnswers,
  readAnswers ? undefined : JSON.stringify({
    expectedIds: [answerA, answerB.id],
    mailbox: readTrace(HARNESS, WORKER).filter(entry => entry.tool === 'promptobus_mailbox' || entry.kind === 'action-failed'),
    unread: store.glanceInbox(home, TASK, WORKER).map(({ id, type, sender, recipients }) => ({ id, type, sender, recipients })),
  }));

check('step 6: this turn also ran in the same session — the process did not change over the loop',
  readSession(ref, env)?.panePid === panePid, `${panePid} → ${readSession(ref, env)?.panePid}`);

const wakeAfter = store.readWake(home, TASK, WORKER);
check('step 6: each end of turn rewrites the fingerprint — the turn counter grew',
  wakeAfter?.socket !== wake0?.socket, `${wake0?.socket} → ${wakeAfter?.socket}`);
const busSessions = readTrace(HARNESS, WORKER).filter(entry => entry.kind === 'mcp-session');
check('step 6: all three turns use the same actual HTTP MCP session in the owned pane',
  busSessions.length === 3 && busSessions.every((entry, turn) => entry.turn === turn
    && typeof entry.sessionId === 'string' && entry.sessionId.length > 0 && entry.sessionId === busSessions[0].sessionId),
  JSON.stringify(busSessions));

// --- cleanup -----------------------------------------------------------------------

const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
check('step 6: promptobus done closed the task, stopped the participant and removed the persist session',
  done.status === 0 && cursorDriver.inspect(ref)?.state === 'gone' && tmuxSessions({ env }).length === 0,
  `${done.out.slice(-300)} · ${JSON.stringify(cursorDriver.inspect(ref))} · ${JSON.stringify(tmuxSessions({ env }))}`);

const gone = await waitFor(() => (store.liveWarden(home, TASK) ? null : true), { timeoutMs: 30000 });
check('step 6: the warden of the closed task exited on its own',
  gone === true, `${JSON.stringify(store.liveWarden(home, TASK))} · ${wardenLog}`);

const closedService = await service.close();
check('step 6: the owned shared service physically exited after the task seat settled', closedService.stopped
  && processState(closedService.process) === 'dead');
} finally { writeFileSync(RELEASE_FILE, 'release\n'); await service.close(); restore(); }
} else {
  skip('Cursor wake integration', 'PB-428.7: temporarily disabled by the owner; retained handshake repair awaits independent acceptance and re-enable proof');
}

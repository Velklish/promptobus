#!/usr/bin/env node
// Live Cursor persist scenario; see docs/guides/contributing.md#live-harness-scenarios.
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { finishLiveArgs, parseLiveArgs } from './live-args.mjs';
import { guardStubLaunch, liveRoutingEnv, refuseImportedEntry } from './live-entry.mjs';
import { makeSandbox, retainSandbox, writeHostConfig, resolveToolBin } from '../test/sandbox.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { freshScenarioIdentity, buildWorkspace, cli, MECHANISM_ROOT, sentBy, store } from '../test/scenario.mjs';
import { makeServiceTestDirectory } from '../test/service-test-directory.mjs';
import { taskServiceFixture } from '../test/task-service-fixture.mjs';
import { waitFor } from '../test/harness.mjs';
import { markRunOwner, sweepLiveRuns, sweepPreviousRuns, sweptLine } from './canary-runs.mjs';
import { onAbort } from './live-abort.mjs';
import { reportMentionsDiff } from './review-events.mjs';
import { optionalEntries } from './live-home.mjs';
import { cursorProcessVerdict } from './cursor-cleanup.mjs';
import { requiredTmuxSessions, tmuxAbsenceVerdict } from './tmux-check.mjs';
import { addrKey } from '../test/harness-cursor.mjs';

refuseImportedEntry(import.meta.url);

const LIVE_FLAGS = {
  '--model': { key: 'model', display: '--model <id>', description: 'model of the live Cursor sessions' },
};
const LIVE_ARGS = finishLiveArgs(parseLiveArgs(process.argv.slice(2), LIVE_FLAGS), {
  usage: 'scripts/live-cursor.mjs [--model <id>]',
  purpose: 'check the Cursor driver and its persist sessions against a live agent',
  price: 'raises live Cursor sessions and spends the account limit',
  flags: LIVE_FLAGS,
});

const { cursorDriver, reviewSandbox } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-cursor.js'));
const {
  cursorStateHome, readTmuxSessions, tmuxSessions, readSession, reapOrphans, sessionMarker, tmux, findTranscript, pidAlive,
  LAUNCH_TMUX_SERVER,
} = await import(path.join(MECHANISM_ROOT, 'lib', 'cursor-persist.js'));
const { processState } = await import(path.join(MECHANISM_ROOT, 'lib', 'service-state.js'));

// The model is named by a flag, not taken from the driver default: the live
// check is driven on the one the owner named, and it goes into the report.
const MODEL = LIVE_ARGS.model ?? 'cursor-grok-4.6-xhigh-fast';

const toolName = cursorDriver.options.tool;
const guarded = guardStubLaunch(process.env, {
  names: [toolName, 'agent', 'cursor', { name: 'tmux', probe: ['-V'] }],
  homes: ['PROMPTOBUS_CURSOR_HOME', 'PROMPTOBUS_CURSOR_USER_HOME', 'PROMPTOBUS_E2E_CURSOR'],
});
if (guarded.stub && !guarded.ok) {
  console.error(`✖ live run not started: ${guarded.reason}`);
  process.exit(1);
}
const tool = guarded.stub ? guarded.tools[cursorDriver.options.tool] : resolveToolBin(cursorDriver.options.tool);
if (!tool.ok) {
  console.error(`✖ nothing to drive the live run with: ${tool.reason}`);
  process.exit(1);
}

// Strip session identity before issuing sandbox commands.
const leaked = SESSION_LEAK_VARS.filter((name) => name in process.env);
dropSessionLeaks(process.env);

const verdicts = [];
const times = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  verdicts.push({ name, ok, detail: ok ? '' : String(detail).slice(0, 600) });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 600)}`}\n`);
}
function at_(name, ms) {
  times.push(`${name} ${(ms / 1000).toFixed(1)} s`);
  process.stdout.write(`  · ${name}: ${(ms / 1000).toFixed(1)} s\n`);
}

// Compare directory composition rather than timestamps in the owner home.
const CURSOR_HOME = path.join(homedir(), '.cursor');
function snapshotHome() {
  return {
    chats: new Set(optionalEntries(path.join(CURSOR_HOME, 'chats'))),
    projects: new Set(optionalEntries(path.join(CURSOR_HOME, 'projects'))),
  };
}
const before = snapshotHome();

// Name the real registry explicitly; the stand observes it rather than redirecting it.
process.env.PROMPTOBUS_CURSOR_HOME = process.env.PROMPTOBUS_CURSOR_HOME
  ?? path.join(homedir(), '.promptobus', 'cursor');
const STATE_HOME = cursorStateHome();
const snapshotState = () => optionalEntries(path.join(STATE_HOME, 'sessions'));
const stateBefore = snapshotState();

// Record pre-existing persist sessions so teardown does not count them as leaks.
let sessionsBefore;
try {
  sessionsBefore = new Set(requiredTmuxSessions(readTmuxSessions).map((s) => s.name));
} catch (error) {
  console.error(`✖ no persist session list to subtract before the run: ${error.message}`);
  process.exit(1);
}

// Not a prefix of the logs prefix: sandboxes are swept with none kept, logs keep the three newest.
const RUN_PREFIX = 'promptobus-live-cursor-run-';
const SB = makeSandbox(RUN_PREFIX, { signalCleanup: false });
markRunOwner(SB);
for (const line of sweepLiveRuns(tmpdir(), { prefix: RUN_PREFIX, current: SB })) process.stdout.write(`▸ ${line}\n`);
// Turn logs outlive the run: the sandbox is swept, and the stream is needed to
// debug a red.
const LOGS_PREFIX = 'promptobus-live-cursor-logs-';
const KEPT_LOGS = path.join(tmpdir(), `${LOGS_PREFIX}${process.pid}`);
const identity = freshScenarioIdentity('livecursor');
const TASK = identity.id;
const WORKER = 'worker:live';
const REVIEWER = 'reviewer:live';
const ORCH_SESSION = `orch-live-cursor-${process.pid}`;
const MARK = {
  hello: 'LIVE-CURSOR-HELLO',
  skill: 'LIVE-CURSOR-SKILL',
  woke: 'LIVE-CURSOR-WOKE',
  pairA: 'LIVE-CURSOR-PAIR-A',
  pairB: 'LIVE-CURSOR-PAIR-B',
  review: 'LIVE-CURSOR-REVIEW',
};

const { ws, repoAbs, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'cursor'] });
mkdirSync(path.join(ws, '.cursor', 'skills', 'live-cursor-probe'), { recursive: true });
writeFileSync(path.join(ws, '.cursor', 'skills', 'live-cursor-probe', 'SKILL.md'),
  `---\nname: live-cursor-probe\ndescription: stub skill for the live Cursor run — return the marker in the first bus message\n---\n\nMarker of this skill: ${MARK.skill}\n`);
const home = path.join(ws, '.promptobus');

const workerBrief = path.join(SB, 'worker-brief.md');
writeFileSync(workerBrief, `# Live check of the bus loop from Cursor

You are a Promptobus bus participant. Do exactly this and nothing more:

1. Read the \`live-cursor-probe\` skill in \`.cursor/skills\` of your working directory.
2. Send the orchestrator a status message whose body starts with the line «${MARK.hello}»,
   and include in that same body the marker from that skill.
3. End the turn.

Messages will arrive after that. For each: fetch the mailbox, read what it asks, and send
the orchestrator a result message whose body starts with exactly the marker line the
message named. Put the marker as the FIRST line of the body and write nothing before it.
One message — one result. Do nothing else.
`);

const serviceDirectory = makeServiceTestDirectory('pbcur-', 'service');
const taskService = await taskServiceFixture({ workspace: ws, home, task: TASK, socketDirectory: serviceDirectory,
  mechanismRoot: MECHANISM_ROOT, env: { ...liveRoutingEnv(SB), CLAUDE_CODE_SESSION_ID: ORCH_SESSION } });
const env = taskService.env;
let serviceClosed = false, taskCreated = false;
process.once('exit', () => { if (serviceClosed) rmSync(serviceDirectory, { recursive: true, force: true }); });
const wardenEnv = { ...env };
delete wardenEnv.PROMPTOBUS_WARDEN;

process.stdout.write(`▸ live Cursor run: ${tool.path}${tool.version ? ` (${tool.version})` : ''}\n`);
process.stdout.write(`▸ model: ${MODEL}\n`);
process.stdout.write(`▸ mechanism: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ sandbox: ${SB} · store: ${home}\n`);
process.stdout.write(`▸ task: ${TASK}\n`);
process.stdout.write(`▸ owned service directory: ${serviceDirectory}\n`);
if (leaked.length) process.stdout.write(`▸ stripped from the run environment: ${leaked.join(', ')}\n`);

// Copy transcripts before teardown drops the session records that name them.
const transcripts = new Map();
function rememberTranscript(addr) {
  try {
    const kept = store.participantOf(store.readTask(home, TASK), addr)?.sessionRef;
    const record = kept ? readSession(kept) : null;
    const from = record?.transcript && existsSync(record.transcript) ? record.transcript : findTranscript(record?.chatId);
    if (from) transcripts.set(addr, from);
    return from;
  } catch {
    return null;
  }
}

function keepTranscripts() {
  for (const addr of [WORKER, REVIEWER]) {
    try {
      const from = transcripts.get(addr) ?? rememberTranscript(addr);
      if (!from || !existsSync(from)) continue;
      mkdirSync(KEPT_LOGS, { recursive: true });
      copyFileSync(from, path.join(KEPT_LOGS, `${addrKey(addr)}.jsonl`));
    } catch {
      // No transcript, or the directory was not created — that does not cancel the run.
    }
  }
}

let ref = '';
let reviewerRef = '';
let sandboxDir = '';
// Session markers share one machine-wide directory; compare only this run’s markers.
const probeMarks = [];
function rememberProbeMarks() {
  for (const addr of [WORKER, REVIEWER]) {
    try {
      const kept = store.participantOf(store.readTask(home, TASK), addr)?.sessionRef;
      const mark = kept ? sessionMarker(readSession(kept) ?? {}) : null;
      if (mark && !probeMarks.includes(mark)) probeMarks.push(mark);
    } catch {
      // The record is already gone — the marker cannot be restored, leftovers
      // are then judged by the run directory.
    }
  }
}
let newChats, newProjects;
function checkMachineCleanup() {
  const stateLeft = snapshotState().filter(n => !stateBefore.includes(n));
  check('after the loop the mechanism session registry is empty — records were dropped by stop', !stateLeft.length, stateLeft.join(' | '));
  const processes = cursorProcessVerdict([SB, ws, ...probeMarks]);
  check('no run processes left after the loop', processes.ok, processes.detail);
  const panes = tmuxAbsenceVerdict(readTmuxSessions, sessionsBefore);
  check('no persist sessions of the run after cleanup', panes.ok, panes.detail);
  const after = snapshotHome();
  newChats = [...after.chats].filter(n => !before.chats.has(n));
  newProjects = [...after.projects].filter(n => !before.projects.has(n));
  return !stateLeft.length && processes.ok && panes.ok;
}
const PARTICIPANT_STOP_MS = 5_000;
let aborted = false, runFailed = false, runFailure, cleanupPromise;
const assertRunning = () => { if (aborted) throw new Error('live run aborted'); };
async function waitForRunning(probe, options) {
  assertRunning();
  const result = await waitFor(() => aborted ? true : probe(), options);
  assertRunning();
  return result;
}
const cleanupRun = () => cleanupPromise ??= (async () => {
  const startedAt = Date.now(), deadline = startedAt + PARTICIPANT_STOP_MS, errors = [];
  let retained = false;
  try { retainSandbox(SB); retained = true; } catch (error) { errors.push(error); }
  rememberProbeMarks(); keepTranscripts();
  const refs = new Map([[WORKER, ref], [REVIEWER, reviewerRef]]);
  if (taskCreated) for (const address of [WORKER, REVIEWER]) {
    try { refs.set(address, store.participantOf(store.readTask(home, TASK), address)?.sessionRef || refs.get(address)); }
    catch (error) { errors.push(error); }
  }
  const raised = [...refs].filter(([, owned]) => owned).map(([address, owned]) => {
    let panePid = null;
    try { panePid = readSession(owned)?.panePid ?? null; } catch (error) { errors.push(error); }
    return { address, ref: owned, panePid };
  });
  const native = await Promise.all(raised.map(async owned => {
    let result;
    try { result = await cursorDriver.stop(owned.ref, { timeoutMs: Math.max(0, deadline - Date.now()) }); }
    catch (error) { result = { ok: false, stopped: false, note: error?.message ?? String(error) }; }
    if (result?.ok !== true || typeof result.stopped !== 'boolean' || (result.attempted === true && !result.stopped)) {
      errors.push(new Error(`${owned.ref}: ${result?.note ?? 'native Stop unconfirmed'}`));
    }
    return { ...owned, result };
  }));
  let service;
  try {
    service = await taskService.close();
    if (service.stopped && (!service.process || processState(service.process) !== 'dead')) throw new Error('Owned service physical exit unconfirmed');
    serviceClosed = true;
  } catch (error) { errors.push(error); service = { stopped: false, error: error?.message ?? String(error) }; }
  return { native, service, retained, elapsedMs: Date.now() - startedAt,
    error: errors.length ? new AggregateError([...(runFailed ? [runFailure] : []), ...errors], 'Live Cursor cleanup unconfirmed') : null };
})();
onAbort(async (signal) => {
  aborted = true;
  const say = (line) => writeSync(1, line);
  say(`\n▸ run cut off by ${signal}: keeping the logs and stopping the loop\n`);
  const result = await cleanupRun();
  for (const owned of result.native) say(`  · stop returned: ${owned.address} → ${owned.ref}: ${owned.result?.note ?? 'no result'}\n`);
  say(`  · pre-exit: ${JSON.stringify({ sandbox: SB, sandboxPresent: existsSync(SB), elapsedMs: result.elapsedMs,
    native: result.native.map(owned => ({ ...owned, alive: owned.panePid == null ? null : pidAlive(owned.panePid) })),
    service: result.service, seat: taskCreated ? store.liveWarden(home, TASK) : null })}\n`);
  let observed = false;
  try { observed = checkMachineCleanup(); } catch (error) { say(`  · cleanup observation failed: ${error.message}\n`); }
  if (result.error || !observed) {
    say(`  · cleanup unconfirmed; sandbox ${result.retained ? 'retained' : 'retention unconfirmed'}: ${SB}\n`);
    for (const error of result.error?.errors ?? []) say(`  · cleanup error: ${error?.message ?? String(error)}\n`);
  } else {
    rmSync(SB, { recursive: true, force: true });
    say('  · owned native cleanup and service exit confirmed\n');
  }
  say(`  · turn logs: ${KEPT_LOGS}\n`);
}, { waitMs: 30_000 });

const t0 = Date.now();
try {
  assertRunning();
  store.createTask(home, { ...identity, owner: ORCH_SESSION }); taskCreated = true;
  const warden = cli(['warden', '--task', TASK], { cwd: ws, env: wardenEnv });
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  const live = await waitForRunning(() => store.liveWarden(home, TASK), { timeoutMs: 30000 });
  check('step 1: the task warden is up as a real process', warden.status === 0 && !!live?.pid, `${warden.out} · ${JSON.stringify(live)}`);

  // --- step 2: raise a Cursor participant ------------------------------------------------
  const t2 = Date.now();
  assertRunning();
  const spawned = cli([ 'spawn', '--repo', repo, '--brief', workerBrief, '--task', TASK, '--title', identity.title,
    '--worker', 'live', '--harness', 'cursor', '--model', MODEL], { cwd: ws, env });
  check('step 2: promptobus spawn --harness cursor raised a live participant',
    spawned.status === 0 && /worker worker:live lifted/.test(spawned.out), spawned.out.slice(-600));
  at_('participant start', Date.now() - t2);

  const wp = store.participantOf(store.readTask(home, TASK), WORKER);
  ref = wp?.sessionRef ?? '';
  const record = readSession(ref);
  check('step 2: persist session is up, the chat is recognised, and both sit in the participant record',
    !!record?.sessionName && !!record?.chatId
    && wp?.metadata?.session === record.sessionName && wp?.metadata?.sessionId === record.chatId,
    `${JSON.stringify(record)} · ${wp?.metadata?.session} · ${wp?.metadata?.sessionId}`);
  // Taken at the lift: after `done` the record is gone, and leftovers are judged by these marks.
  rememberProbeMarks();

  const mine = tmuxSessions().find((s) => s.name === record?.sessionName) ?? null;
  check('step 2: the session is visible in the tmux list, marked with the task and address, and its chat is the same',
    !!mine && mine.managed && mine.task === TASK && mine.address === WORKER && mine.chatId === record?.chatId,
    JSON.stringify(tmuxSessions()));

  const listOut = spawnSync(tool.path, ['persist', 'list'], { encoding: 'utf8' });
  check('step 2: the mechanism session is visible to a human agent persist list — it is on the shared server',
    listOut.status === 0 && String(listOut.stdout ?? '').includes((record?.sessionName || 'no-name')),
    String(listOut.stdout ?? '').slice(-500));

  const launchList = tmuxAbsenceVerdict(readTmuxSessions, new Set(), { server: LAUNCH_TMUX_SERVER });
  check('step 2: the one-shot pty-provider pane is down — the launch server is empty',
    launchList.ok, launchList.detail);

  assertRunning();
  const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
  check('step 2: promptobus status shows the Cursor session is alive',
    statusOut.status === 0 && statusOut.out.includes(WORKER) && /session /.test(statusOut.out),
    statusOut.out.slice(-500));

  const liveWt = wp?.metadata?.worktree ?? '';
  check('step 2: the stub skill landed in the participant worktree',
    existsSync(path.join(liveWt, '.cursor', 'skills', 'live-cursor-probe', 'SKILL.md'))
    && readFileSync(path.join(liveWt, '.cursor', 'skills', 'live-cursor-probe', 'SKILL.md'), 'utf8').includes(MARK.skill),
    liveWt);

  // --- step 3: bus loop from a live Cursor session ---------------------------------------
  const t3 = Date.now();
  const hello = await waitForRunning(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => String(m.body ?? '').includes(MARK.hello)) ?? null, { timeoutMs: 300000 });
  check('step 3: the first-turn result reached the orchestrator — the bus loop from Cursor closed',
    !!hello, JSON.stringify(hello ?? readSession(ref)?.last));
  check('step 3: the participant read the skill from its .cursor/skills — the marker is in the first message',
    !!hello && String(hello.body ?? '').includes(MARK.skill),
    JSON.stringify(hello ?? readSession(ref)?.last));
  at_('participant first turn', Date.now() - t3);

  // A store message can come from the shell. Read the transcript to prove a tool call.
  const toolCalls = () => {
    const record = readSession(ref);
    const file = record?.transcript && existsSync(record.transcript) ? record.transcript : findTranscript(record?.chatId);
    if (!file || !existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return [];
      }
      return (event?.message?.content ?? []).filter((c) => c?.type === 'tool_use')
        .map((c) => JSON.stringify(c).slice(0, 400));
    });
  };
  const calledBus = await waitForRunning(() => (toolCalls().some((n) => /promptobus/.test(String(n))) ? toolCalls() : null),
    { timeoutMs: 120000 });
  check('step 3: the bus was called as a TOOL — the call is visible in the chat transcript',
    !!calledBus, `transcript calls: ${JSON.stringify(toolCalls()).slice(0, 500)}`);
  rememberTranscript(WORKER);

  // --- step 4: wake by injection into a live session ------------------------------------
  const t4 = Date.now();
  const paneWas = readSession(ref)?.panePid ?? null;
  assertRunning();
  store.sendMessage(home, TASK, {
    from: 'orchestrator', to: WORKER, type: 'answer',
    body: `Woke you. Fetch the mailbox and reply to the orchestrator with a result message whose body starts with the line «${MARK.woke}».`,
  });
  // Match the start of the body: a model can quote the next marker in an earlier turn.
  const woke = await waitForRunning(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => m.type === 'result' && String(m.body ?? '').trimStart().startsWith(MARK.woke)) ?? null,
  { timeoutMs: 300000 });
  check('step 4: the warden woke the Cursor session by injection, and the participant replied',
    !!woke, `${JSON.stringify(readSession(ref)?.last)} · ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);
  // Persist wake must reuse the pane rather than start a process.
  check('step 4: the wake went WITHOUT a new process — the session pane is the same',
    !!paneWas && readSession(ref)?.panePid === paneWas
    && tmuxSessions().some((s) => s.name === record?.sessionName && s.panePid === paneWas),
    `${paneWas} → ${readSession(ref)?.panePid} · ${JSON.stringify(tmuxSessions())}`);
  check('step 4: the participant fetched the mailbox itself — it confirms delivery',
    store.countInbox(home, TASK, WORKER) === 0, String(store.countInbox(home, TASK, WORKER)));
  at_('wake and second turn', Date.now() - t4);

  // Attach in a wide pane because tmux sizes the window to the narrowest client.
  const t4b = Date.now();
  const seat = `promptobus-live-attach-${process.pid}`;
  assertRunning();
  tmux(['new-session', '-d', '-s', seat, '-x', '200', '-y', '50',
    `${tool.path} persist attach ${record?.sessionName}`], { server: LAUNCH_TMUX_SERVER });
  const attached = await waitForRunning(() => {
    const s = tmuxSessions().find((x) => x.name === record?.sessionName);
    return s && s.attached > 0 ? s : null;
  }, { timeoutMs: 30000 });
  check('step 4b: a human attaches to the live session — attach gives a second client',
    !!attached, `${JSON.stringify(tmuxSessions())} · attach pane: ${JSON.stringify(tmuxSessions({ server: LAUNCH_TMUX_SERVER }))}`);
  tmux(['kill-session', '-t', seat], { server: LAUNCH_TMUX_SERVER });
  const leftSeat = await waitForRunning(() => {
    const s = tmuxSessions().find((x) => x.name === record?.sessionName);
    return s && s.attached === 0 ? s : null;
  }, { timeoutMs: 30000 });
  check('step 4b: the human left, and the session stayed alive — it outlives its clients',
    !!leftSeat, JSON.stringify(tmuxSessions()));
  at_('human attach and leave', Date.now() - t4b);

  // A delivery during a turn queues a separate turn in the same process.
  const t4c = Date.now();
  assertRunning();
  store.sendMessage(home, TASK, {
    from: 'orchestrator', to: WORKER, type: 'answer',
    body: `First of a pair. Fetch the mailbox and reply to the orchestrator with a result whose body starts with the line «${MARK.pairA}».`,
  });
  const first = await cursorDriver.activate({ ref }, {
    kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
  });
  check('step 4c: the first delivery went into an idle session', first?.ok === true, JSON.stringify(first));
  // Wait until the turn actually starts: an injection into a turn that is NOT
  // going does not check the gap.
  assertRunning();
  const busy = await waitForRunning(() => (cursorDriver.inspect(ref)?.busy ? cursorDriver.inspect(ref) : null),
    { timeoutMs: 60000 });
  check('step 4c: the participant turn started — there is something to deliver into', !!busy, JSON.stringify(cursorDriver.inspect(ref)));
  assertRunning();
  store.sendMessage(home, TASK, {
    from: 'orchestrator', to: WORKER, type: 'answer',
    body: `Second of a pair, arrived during a turn. Reply to the orchestrator with a result whose body starts with the line «${MARK.pairB}».`,
  });
  const second = await cursorDriver.activate({ ref }, {
    kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
  });
  assertRunning();
  check('step 4c: delivery into a GOING turn succeeds, and is not refused as "turn in progress"',
    second?.ok === true, `${JSON.stringify(second)} · ${JSON.stringify(cursorDriver.inspect(ref))}`);
  const pairA = await waitForRunning(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => m.type === 'result' && String(m.body ?? '').trimStart().startsWith(MARK.pairA)) ?? null,
  { timeoutMs: 300000 });
  const pairB = await waitForRunning(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => m.type === 'result' && String(m.body ?? '').trimStart().startsWith(MARK.pairB)) ?? null,
  { timeoutMs: 300000 });
  check('step 4c: both messages were handled — the second on the next turn, without a new process',
    !!pairA && !!pairB && readSession(ref)?.panePid === paneWas,
    `${JSON.stringify(pairA)} · ${JSON.stringify(pairB)} · pane ${paneWas} → ${readSession(ref)?.panePid}`);
  at_('pair of messages in a row', Date.now() - t4c);

  // Concurrent injections must not interleave one writer’s text with the other’s paste and Enter.
  assertRunning();
  const race = await Promise.all([1, 2].map(() => cursorDriver.activate({ ref }, {
    kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
  })));
  assertRunning();
  check('step 4d: two injections at once — one delivered, the other refused by the lock',
    race.filter((r) => r.ok).length === 1 && /already writing/.test(String(race.find((r) => !r.ok)?.error)),
    JSON.stringify(race));

  // --- step 5: a Cursor reviewer and its read-only ----------------------------------------
  const t5 = Date.now();
  const wt = wp?.metadata?.worktree ?? repoAbs;
  // Signed with its own marker, so the round's diff file can be shown to carry this edit.
  writeFileSync(path.join(wt, 'live-note.md'), `# ${MARK.review}\n\nAn edit for the review subject.\n`);
  spawnSync('git', ['-C', wt, '-c', 'user.name=live', '-c', 'user.email=live@example.invalid', 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', wt, '-c', 'user.name=live', '-c', 'user.email=live@example.invalid', 'commit', '-m', 'live: review subject'], { encoding: 'utf8' });

  assertRunning();
  const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'cursor', '--model', MODEL],
    { cwd: ws, env });
  reviewerRef = store.participantOf(store.readTask(home, TASK), REVIEWER)?.sessionRef ?? '';
  check('step 5: promptobus review --harness cursor raised a live reviewer',
    reviewed.status === 0 && /reviewer reviewer:live started/.test(reviewed.out), reviewed.out.slice(-600));
  rememberProbeMarks();
  sandboxDir = reviewSandbox(store.participantSettingsPath(home, TASK, REVIEWER));
  check('step 5: the reviewer sandbox is a git directory with its own deny',
    existsSync(path.join(sandboxDir, '.git'))
    && /Write\(\*\*\)/.test(readFileSync(path.join(sandboxDir, '.cursor', 'cli.json'), 'utf8')),
    sandboxDir);

  const probe = path.join(wt, 'PWNED.txt');
  // Omit plan mode so only the deny rule prevents the write. Clean up this probe’s own orphan.
  const probeMark = path.join(SB, 'readonly-probe');
  const denied = spawnSync(tool.path, ['-p', '--output-format', 'stream-json', '--workspace', sandboxDir,
    '--trust', '--force', '--model', MODEL, '--add-dir', wt,
    `Create the file ${probe} with the word PWNED. Write it with the file-write tool, not the shell.`],
  { encoding: 'utf8', cwd: sandboxDir, timeout: 300000, env: { ...process.env, PROMPTOBUS_CURSOR_SESSION: probeMark } });
  reapOrphans(`PROMPTOBUS_CURSOR_SESSION=${probeMark}`);
  check('step 5: the reviewer read-only holds — the file in the reviewed tree was not created',
    !existsSync(probe), `${probe} · ${String(denied.stdout ?? '').slice(-400)}`);
  check('step 5: the refuse arrived as a STRUCTURAL stream event, not as prose',
    /writePermissionDenied|permissionDenied|Blocked by permissions/.test(String(denied.stdout ?? '')),
    String(denied.stdout ?? '').slice(-500));

  const reviewSaid = await waitForRunning(() => store.glanceInbox(home, TASK, 'orchestrator')
    .filter((m) => sentBy(m, REVIEWER) && m.type === 'result').pop() ?? null,
  { timeoutMs: 300000 });
  check('step 5: the Cursor reviewer report reached the orchestrator on the same bus',
    !!reviewSaid, JSON.stringify(readSession(store.participantOf(store.readTask(home, TASK), REVIEWER)?.sessionRef ?? '')?.last));
  const diffs = (() => {
    try {
      return readdirSync(store.filesDir(home, TASK)).filter((n) => n.endsWith('.diff'));
    } catch {
      return [];
    }
  })();
  check('step 5: the review diff landed as a task file and carries the review subject',
    diffs.length === 1 && readFileSync(path.join(store.filesDir(home, TASK), diffs[0]), 'utf8').includes(MARK.review),
    JSON.stringify(diffs));
  check('step 5: the reviewer report names the diff file it was given',
    !!reviewSaid && reportMentionsDiff(reviewSaid.body, diffs[0]),
    `${String(reviewSaid?.body ?? '(no report)').slice(0, 400)} · diff ${diffs.join(', ')}`);
  rememberTranscript(REVIEWER);
  at_('review', Date.now() - t5);

  // --- step 6: stop and cleanup --------------------------------------------------------
  const t6 = Date.now();
  assertRunning();
  const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
  check('step 6: promptobus done closed the task and stopped the Cursor participants',
    done.status === 0, done.out.slice(-600));
  check('step 6: no session records left in the mechanism registry',
    cursorDriver.inspect(ref)?.state === 'gone' && !existsSync(sandboxDir),
    `${JSON.stringify(cursorDriver.inspect(ref))} · ${sandboxDir}`);
  // Judge teardown by the recorded sessions, not every session on the server.
  const finalList = tmuxAbsenceVerdict(readTmuxSessions, sessionsBefore);
  check('step 6: no persist sessions of the run left on the tmux server, foreign ones untouched',
    finalList.ok, finalList.detail);
  const persistOut = spawnSync(tool.path, ['persist', 'list'], { encoding: 'utf8' });
  check('step 6: agent persist list does not show the run — the list is clean for the person',
    !String(persistOut.stdout ?? '').includes(TASK) && !String(persistOut.stdout ?? '').includes((record?.sessionName || 'no-name')),
    String(persistOut.stdout ?? '').slice(-400));
  at_('stop and cleanup', Date.now() - t6);
} catch (e) {
  if (!aborted) { runFailed = true; runFailure = e; check('the run reached the end without a break', false, e?.stack ?? e?.message ?? String(e)); }
} finally {
  if (!aborted) {
    const result = await cleanupRun();
    if (!aborted) {
      if (result.error) throw result.error;
      if (!checkMachineCleanup()) throw Error(`Cursor cleanup unconfirmed; sandbox retained: ${SB}`);
      rmSync(SB, { recursive: true, force: true });
    }
  }
}

if (!aborted) {
const passed = verdicts.filter((v) => v.ok).length;
process.stdout.write(`\n${passed}/${verdicts.length} verdicts passed\n`);
process.stdout.write(`durations: ${times.join(' · ')} · total ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
process.stdout.write(`binary: ${tool.path}${tool.version ? ` (${tool.version})` : ''} · model: ${MODEL}\n`);
const refusedLogs = [];
const sweptLogs = sweepPreviousRuns(tmpdir(), {
  prefix: LOGS_PREFIX, current: KEPT_LOGS, refused: refusedLogs,
});
process.stdout.write(`${sweptLine('previous-run logs', sweptLogs)}\n`);
if (refusedLogs.length) process.stdout.write(`sweep refused (busy or foreign permissions): ${refusedLogs.join(', ')}\n`);
// Name the logs only if the run reached the point of creating them.
process.stdout.write(existsSync(KEPT_LOGS)
  ? `run turn logs: ${KEPT_LOGS}\n`
  : 'no run turn logs — the first turn was never reached\n');
if (newChats && newProjects) process.stdout.write(`entries in ${CURSOR_HOME}: new chat directories ${newChats.length}`
  + `${newChats.length ? ` (${newChats.map((n) => path.join(CURSOR_HOME, 'chats', n)).join(', ')})` : ''}`
  + `; new project entries ${newProjects.length}`
  + `${newProjects.length ? ` (${newProjects.map((n) => path.join(CURSOR_HOME, 'projects', n)).join(', ')})` : ''}\n`);
process.exitCode = passed === verdicts.length ? 0 : 1;
}

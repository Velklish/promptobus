#!/usr/bin/env node
// Live Cursor worker and Codex reviewer scenario; see docs/guides/contributing.md#live-harness-scenarios.
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync,
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
import { waitFor } from '../test/harness.mjs';
import { taskServiceFixture } from '../test/task-service-fixture.mjs';
import { markRunOwner, sweepLiveRuns, sweepPreviousRuns, sweptLine } from './canary-runs.mjs';
import { onAbort } from './live-abort.mjs';
import { checkCodexHygiene, readCodexHygiene } from './codex-hygiene.mjs';
import { codexCatalogEntries, pickCodexModel } from './codex-models.mjs';
import { messageKey, reportMentionsDiff, unseenResult } from './review-events.mjs';
import { optionalEntries } from './live-home.mjs';
import { cursorProcessVerdict } from './cursor-cleanup.mjs';
import { requiredTmuxSessions, tmuxAbsenceVerdict } from './tmux-check.mjs';
import { addrKey } from '../test/harness-cursor.mjs';

refuseImportedEntry(import.meta.url);

const LIVE_FLAGS = {
  '--cursor-model': { key: 'cursorModel', display: '--cursor-model <id>', description: 'model of the live Cursor worker' },
  '--codex-model': { key: 'codexModel', display: '--codex-model <id>', description: 'model of the live Codex reviewer' },
};
const LIVE_ARGS = finishLiveArgs(parseLiveArgs(process.argv.slice(2), LIVE_FLAGS), {
  usage: 'scripts/live-mixed.mjs [--cursor-model <id>] [--codex-model <id>]',
  purpose: 'check a mixed loop: a live Cursor worker and a live Codex reviewer',
  price: 'raises sessions of two tools and spends the limits of two accounts',
  flags: LIVE_FLAGS,
});

const { cursorDriver } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-cursor.js'));
const { codexDriver, DEFAULT_MODEL: CODEX_DEFAULT } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-codex.js'));
const { hostOf } = await import(path.join(MECHANISM_ROOT, 'lib', 'host.js'));
const { READS_DIFF, registryOf, roleEntry } = await import(path.join(MECHANISM_ROOT, 'dist', 'index.js'));
const { wardenMarkFile } = await import(path.join(MECHANISM_ROOT, 'dist', 'sidecar.js'));
const cursorPersist = await import(path.join(MECHANISM_ROOT, 'lib', 'cursor-persist.js'));
const codexSession = await import(path.join(MECHANISM_ROOT, 'lib', 'codex-session.js'));

// The Cursor model is named by its flag or the default here; the Codex one is verified below,
// against the binary's own catalog, before the first raise — no reason to invent a number here.
const CURSOR_MODEL = LIVE_ARGS.cursorModel ?? 'cursor-grok-4.6-xhigh-fast';

// Check both binaries before any lift can leave a participant behind.
const guarded = guardStubLaunch(process.env, {
  names: ['cursor-agent', 'agent', 'cursor', { name: 'tmux', probe: ['-V'] }, 'codex'],
  homes: [
    'PROMPTOBUS_CURSOR_HOME', 'PROMPTOBUS_CURSOR_USER_HOME', 'PROMPTOBUS_E2E_CURSOR',
    'PROMPTOBUS_E2E_CODEX', 'PROMPTOBUS_CODEX_HOME',
  ],
});
if (guarded.stub && !guarded.ok) {
  console.error(`✖ live run not started: ${guarded.reason}`);
  process.exit(1);
}
const tools = guarded.stub ? guarded.tools : { cursor: resolveToolBin('cursor'), codex: resolveToolBin('codex') };
const missing = Object.entries(tools).filter(([, t]) => !t.ok);
if (missing.length) {
  for (const [name, t] of missing) console.error(`✖ nothing to drive the live run with: ${name} — ${t.reason}`);
  process.exit(1);
}

// The Codex reviewer's model is verified against the binary's own catalog BEFORE any layout —
// a refusal after the worker is up would leave a live session behind (codex debug models).
const pickedCodex = pickCodexModel(codexCatalogEntries(tools.codex.path), LIVE_ARGS.codexModel, CODEX_DEFAULT);
if (pickedCodex.reason) {
  console.error(`✖ live run not started: ${pickedCodex.reason}`);
  process.exit(1);
}
const CODEX_MODEL = pickedCodex.model;

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

const CODEX_CONFIG = path.join(homedir(), '.codex', 'config.toml');
let codexBefore;
try {
  codexBefore = readCodexHygiene(CODEX_CONFIG);
} catch (error) {
  console.error(`✖ live run not started: could not observe Codex hygiene baseline: ${error.message}`);
  process.exit(1);
}

// The Cursor registry stays in the person home, named, since the helpers refuse to guess one;
// what the run leaves there is compared before and after, the person's own sessions subtracted.
process.env.PROMPTOBUS_CURSOR_HOME = process.env.PROMPTOBUS_CURSOR_HOME ?? path.join(homedir(), '.promptobus', 'cursor');
const CURSOR_STATE = cursorPersist.sessionsDir();
// The person's Codex registry is only compared: the run's own Codex home goes under the sandbox below.
const USER_CODEX_STATE = codexSession.sessionsDir({
  PROMPTOBUS_CODEX_HOME: process.env.PROMPTOBUS_CODEX_HOME ?? path.join(homedir(), '.promptobus', 'codex'),
});
const stateBefore = { cursor: optionalEntries(CURSOR_STATE), codex: optionalEntries(USER_CODEX_STATE) };
function checkRegistries() {
  const owned = optionalEntries(CODEX_STATE);
  const stateLeft = {
    cursor: optionalEntries(CURSOR_STATE).filter((n) => !stateBefore.cursor.includes(n)),
    codex: optionalEntries(USER_CODEX_STATE).filter((n) => !stateBefore.codex.includes(n)),
  };
  check('after the loop the Cursor registry is clean and the person\'s Codex registry untouched',
    stateLeft.cursor.length === 0 && stateLeft.codex.length === 0,
    `cursor: ${stateLeft.cursor.join(', ') || 'clean'} · codex: ${stateLeft.codex.join(', ') || 'clean'}`);
  check('after the stop the run\'s own Codex registry was empty before the sandbox went',
    owned.length === 0, owned.join(', ') || 'clean');
  if (stateLeft.cursor.length || stateLeft.codex.length || owned.length) {
    throw new Error('session registry entries remain after Stop');
  }
}
let panesBefore;
try {
  panesBefore = new Set(requiredTmuxSessions(cursorPersist.readTmuxSessions).map((s) => s.name));
} catch (error) {
  console.error(`✖ no persist session list to subtract before the run: ${error.message}`);
  process.exit(1);
}

// Keep sandbox and log prefixes distinct: logs survive by design, not as leaked sandboxes.
const RUN_PREFIX = 'promptobus-live-mixed-run-';
const born = Date.now();
const bornAfter = (file) => {
  try {
    const st = statSync(file);
    return (st.birthtimeMs || st.mtimeMs) >= born;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
// The run's own sandbox stays out of the sandbox helper's SIGNAL cleanup: the abort cleanup
// below is awaited, and that handler would remove it and exit 130 before the stops return.
const SB = makeSandbox(RUN_PREFIX, { signalCleanup: false });
markRunOwner(SB);
for (const line of sweepLiveRuns(tmpdir(), { prefix: RUN_PREFIX, current: SB })) process.stdout.write(`▸ ${line}\n`);
// The reviewer's thread record lives under the sandbox: a holder that outlives this process
// exits once the sandbox is gone, and the person's registry stays outside every cleanup.
const CODEX_HOME = path.join(SB, 'codex-state');
process.env.PROMPTOBUS_CODEX_HOME = CODEX_HOME;
const CODEX_STATE = codexSession.sessionsDir();
// Turn logs outlive the run: the sandbox is swept, and the Cursor transcript
// and the Codex holder log are what a red is debugged by.
const LOGS_PREFIX = 'promptobus-live-mixed-logs-';
const KEPT_LOGS = path.join(tmpdir(), `${LOGS_PREFIX}${process.pid}`);
const identity = freshScenarioIdentity('livemixed');
const TASK = identity.id;
const WORKER = 'worker:live';
const REVIEWER = 'reviewer:live';
const ORCH_SESSION = `orch-live-mixed-${process.pid}`;
const MARK = {
  hello: 'LIVE-MIXED-HELLO',
  fix: 'LIVE-MIXED-FIX',
  reviewA: 'LIVE-MIXED-REVIEW-A',
  reviewB: 'LIVE-MIXED-REVIEW-B',
};

const { ws, repoAbs, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'cursor', 'codex'] });
const roleRegistry = registryOf(hostOf(ws));
const home = path.join(ws, '.promptobus');

const workerBrief = path.join(SB, 'worker-brief.md');
writeFileSync(workerBrief, `# Live check of a mixed bus loop

You are a Promptobus bus participant. Do exactly this and nothing more:

1. Send the orchestrator a result message whose body starts with the line «${MARK.hello}».
2. End the turn.

Messages will arrive after that, including review notes. For each: fetch the
mailbox, read what it asks, and send the orchestrator a result message whose body
starts with exactly the marker line the message named. Put the marker as the FIRST
line of the body and write nothing before it. One message — one result. Do nothing
else.
`);

const serviceDirectory = mkdtempSync(path.join(realpathSync(process.platform === 'win32' ? tmpdir() : '/tmp'), 'pbmix-'));
const taskService = await taskServiceFixture({ workspace: ws, home, task: TASK, socketDirectory: serviceDirectory,
  mechanismRoot: MECHANISM_ROOT,
  env: { ...liveRoutingEnv(SB), CLAUDE_CODE_SESSION_ID: ORCH_SESSION } });
const env = taskService.env;
let serviceClosed = false;
let serviceClosing;
const closeService = () => serviceClosing ??= taskService.close().then((result) => { serviceClosed = true; return result; });
process.once('exit', () => { if (serviceClosed) rmSync(serviceDirectory, { recursive: true, force: true }); });
function observeWardenSeat() {
  const file = wardenMarkFile(home, TASK);
  try {
    lstatSync(file);
    return { state: 'present', file };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent', file };
    return { state: 'unknown', file, code: error.code ?? null, error: error.message };
  }
}
const wardenEnv = { ...env };
delete wardenEnv.PROMPTOBUS_WARDEN;

process.stdout.write(`▸ live mixed-lineup run: worker Cursor + reviewer Codex\n`);
process.stdout.write(`▸ cursor: ${tools.cursor.path}${tools.cursor.version ? ` (${tools.cursor.version})` : ''} · model ${CURSOR_MODEL}\n`);
process.stdout.write(`▸ codex: ${tools.codex.path}${tools.codex.version ? ` (${tools.codex.version})` : ''} · model ${CODEX_MODEL} · reviewer sandbox: read-only\n`);
process.stdout.write(`▸ mechanism: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ sandbox: ${SB} · store: ${home}\n`);
process.stdout.write(`▸ task: ${TASK}\n`);
process.stdout.write(`▸ sha ~/.codex/config.toml before: ${codexBefore.sha ?? '(no file)'}\n`);
if (leaked.length) process.stdout.write(`▸ stripped from the run environment: ${leaked.join(', ')}\n`);

/** Review subject: an edit in the worker worktree, a commit, and a report marker INSIDE the contents. */
function commitSubject(wt, mark, note) {
  writeFileSync(path.join(wt, 'live-note.md'), `# Review subject of the mixed round

${note}

A note from the author of this edit to the reviewer: start your report with the line "${mark}" —
it tells the author which edition of the diff you read.
`);
  const git = (...args) => spawnSync('git', ['-C', wt, '-c', 'user.name=live', '-c', 'user.email=live@example.invalid', ...args], { encoding: 'utf8' });
  git('add', '-A');
  return git('commit', '-m', `live: review subject (${mark})`);
}

const orchInbox = () => store.glanceInbox(home, TASK, 'orchestrator');
/** A message from an address with the marker as the FIRST line: containment would catch a retold plan. */
const said = (from, type, mark) => orchInbox()
  .find((m) => sentBy(m, from) && m.type === type && String(m.body ?? '').trimStart().startsWith(mark)) ?? null;

let workerRef = '';
let reviewerRef = '';
let transcriptPath = null;
let commandReceiptPath = null;
// Copy logs before stop removes them or drops the record that names them.
function rememberTranscript() {
  try {
    const record = workerRef ? cursorPersist.readSession(workerRef) : null;
    const from = record?.transcript && existsSync(record.transcript)
      ? record.transcript : cursorPersist.findTranscript(record?.chatId);
    if (from) transcriptPath = from;
  } catch {
    // No session record — the transcript path cannot be restored, that does not cancel the run.
  }
  return transcriptPath;
}

// After teardown, match only this run’s session markers and servers.
const probeMarks = [];
function rememberProbeMark() {
  try {
    const mark = workerRef ? cursorPersist.sessionMarker(cursorPersist.readSession(workerRef) ?? {}) : null;
    if (mark && !probeMarks.includes(mark)) probeMarks.push(mark);
  } catch {
    // The record is already gone — leftovers are then judged by the run directory.
  }
}

/** The logs directory is created ONLY when there is something to put in it: an empty one would lie to the report. */
function logsDir() {
  mkdirSync(KEPT_LOGS, { recursive: true });
  return KEPT_LOGS;
}

function keepHolderLog() {
  try {
    const from = reviewerRef ? codexSession.holderLogFile(reviewerRef) : null;
    if (!from || !existsSync(from)) return;
    copyFileSync(from, path.join(logsDir(), `${addrKey(REVIEWER)}.log`));
  } catch {
    // No log, or the directory was not created — that does not cancel the run.
  }
}

function keepTranscript() {
  try {
    const from = rememberTranscript();
    if (!from || !existsSync(from)) return;
    copyFileSync(from, path.join(logsDir(), `${addrKey(WORKER)}.jsonl`));
  } catch {
    // No log, or the directory was not created — that does not cancel the run.
  }
}

function keepCommandReceipts() {
  try {
    commandReceiptPath = (reviewerRef ? codexSession.readSession(reviewerRef)?.commandReceiptFile : null) ?? commandReceiptPath;
    if (commandReceiptPath && existsSync(commandReceiptPath)) {
      copyFileSync(commandReceiptPath, path.join(logsDir(), `${addrKey(REVIEWER)}.commands.jsonl`));
    }
  } catch {
    // A missing receipt cannot be reconstructed; the Stop result remains unconfirmed.
  }
}

/** Any outcome: a holder copy — a repeat for a red loop that never reached stop. */
function keepLogs() {
  keepTranscript();
  keepHolderLog();
  keepCommandReceipts();
}

/** The owned pane pid recorded at lift, without a synchronous tmux preflight before Stop. */
function panePidOf(ref) {
  try {
    const record = cursorPersist.readSession(ref);
    const pid = record?.panePid;
    return typeof pid === 'number' && Number.isInteger(pid) ? pid : null;
  } catch {
    // No record — no pane to name; the pre-exit verdict below says unknown, never invents one.
    return null;
  }
}

/** The holder and app-server pids of a Codex thread, read while its record still exists. */
function holderPidsOf(ref) {
  try {
    const record = codexSession.readSession(ref);
    return [record?.holderPid, record?.appPid].filter(Number.isInteger);
  } catch {
    // No record — no pids to name; the pre-exit verdict below says unknown, never invents them.
    return [];
  }
}

// The same cleanup as `finally`, and it is awaited: logs first, every raised participant
// stopped by its own driver within the budget, then its task seat and owned service close.
let codexHygiene;
function checkMachineCleanup() {
  const processes = cursorProcessVerdict([SB, ws, ...probeMarks]);
  check('no Cursor processes of the run left after the loop', processes.ok, processes.detail);
  const panes = tmuxAbsenceVerdict(cursorPersist.readTmuxSessions, panesBefore);
  check('no persist sessions of the run on the tmux server after the loop, foreign ones intact', panes.ok, panes.detail);
  const tmpLeft = optionalEntries(tmpdir())
    .filter(n => n !== path.basename(SB) && n.startsWith(RUN_PREFIX))
    .filter(n => bornAfter(path.join(tmpdir(), n)));
  check('no other run directories left in $TMPDIR after the loop', !tmpLeft.length, tmpLeft.join(', '));
  codexHygiene = checkCodexHygiene(CODEX_CONFIG, codexBefore, check);
  return processes.ok && panes.ok && !tmpLeft.length && codexHygiene.ok;
}
const ABORT_STOP_MS = 5_000;
const NORMAL_STOP_MS = 5_000;
let aborted = false;
let workerStopping, reviewerStopping;
let sandboxRetained = false;
const retainOwnedSandbox = () => { if (!sandboxRetained) { retainSandbox(SB); sandboxRetained = true; } };
const stopWorker = (deadline) => workerStopping ??= Promise.resolve().then(() =>
  cursorDriver.stop(workerRef, { timeoutMs: Math.max(0, deadline - Date.now()) }));
const stopReviewer = (allowance) => reviewerStopping ??= Promise.resolve().then(() =>
  codexDriver.stop(reviewerRef, { timeoutMs: allowance() }));
const stopUnconfirmed = (result) => result?.ok !== true || typeof result.stopped !== 'boolean'
  || result.deferred === true || (result.attempted === true && !result.stopped);
const assertRunning = () => { if (aborted) throw new Error('live run aborted'); };
async function waitForRunning(probe, options) {
  assertRunning();
  const result = await waitFor(() => aborted ? true : probe(), options);
  assertRunning();
  return result;
}
onAbort(async (signal) => {
  aborted = true;
  const say = (line) => writeSync(1, line);
  const deadline = Date.now() + ABORT_STOP_MS;
  let retentionError;
  try { retainOwnedSandbox(); } catch (error) { retentionError = error; }
  say(`\n▸ run cut off by ${signal}: keeping the logs and stopping the loop\n`);
  keepLogs();
  // The owned PIDs are read BEFORE the stops: the records go with them, and the pre-exit
  // verdict below must name the processes the stops were sent to.
  const workerPane = workerRef ? panePidOf(workerRef) : null;
  const reviewerPids = reviewerRef ? holderPidsOf(reviewerRef) : [];
  // Start both stops before awaiting either, retaining the abort caller's Codex allowance.
  const stopping = Promise.all([
    workerRef ? stopWorker(deadline) : null,
    reviewerRef ? stopReviewer(() => Math.max(0, Math.floor((deadline - Date.now()) / 2))) : null,
  ].map((stop) => Promise.resolve(stop).catch((error) => ({ ok: false, stopped: false, note: error.message }))));
  const closingService = closeService().catch(error => ({ stopped: false, error: error.message }));
  const serviceStopped = await closingService;
  const [workerStopped, reviewerStopped] = await stopping;
  keepCommandReceipts();
  if (workerRef) say(`  · stop returned for the Cursor worker ${workerRef}: ${workerStopped?.note ?? 'no stop result'}\n`);
  if (reviewerRef) say(`  · stop returned for the Codex reviewer ${reviewerRef}: ${reviewerStopped?.note ?? 'no stop result'}\n`);
  // The stop verdict is sampled HERE, while the sandbox still exists: once
  // the exit hook takes them, a reader cannot tell a real stop from the teardown.
  const seat = observeWardenSeat();
  if (serviceStopped.stopped) {
    say(seat.state === 'absent' ? '  · task warden and owned service physically stopped\n'
      : '  · owned service physically stopped. Task seat cleanup unconfirmed\n');
  } else say(`  · owned service stop unconfirmed: ${serviceStopped.error ?? 'no live owner'}\n`);
  say(`  · pre-exit: ${JSON.stringify({ sandbox: SB, sandboxPresent: existsSync(SB), elapsedMs: Date.now() - (deadline - ABORT_STOP_MS),
    warden: { process: serviceStopped.process ?? null, seat, stopped: serviceStopped.stopped },
    worker: { ref: workerRef, pids: [workerPane], alive: [workerPane == null ? null : cursorPersist.pidAlive(workerPane)], stop: workerStopped },
    reviewer: { ref: reviewerRef, pids: reviewerPids, alive: reviewerPids.map((pid) => codexSession.pidAlive(pid)), stop: reviewerStopped },
  })}\n`);
  let observed = false;
  try { checkRegistries(); observed = checkMachineCleanup(); }
  catch (error) { say(`  · cleanup observation failed: ${error.message}\n`); }
  if (!observed || (workerRef && stopUnconfirmed(workerStopped)) || (reviewerRef && stopUnconfirmed(reviewerStopped))
    || serviceStopped.error || seat.state !== 'absent' || retentionError) {
    say(`  · cleanup unconfirmed; sandbox ${sandboxRetained ? 'retained' : 'retention unconfirmed'}: ${SB}\n`);
    if (retentionError) say(`  · sandbox retention error: ${retentionError?.message ?? String(retentionError)}\n`);
  } else {
    rmSync(SB, { recursive: true, force: true });
    say(`  · sandbox removed after confirmed cleanup: ${SB}\n`);
  }
  say(`  · turn logs: ${KEPT_LOGS}\n`);
}, { waitMs: 30_000 });

const t0 = Date.now();
let runFailed = false, runFailure;
try {
  assertRunning();
  store.createTask(home, { ...identity, owner: ORCH_SESSION });
  const wardenDemand = cli(['warden', '--task', TASK], { cwd: ws, env: wardenEnv });
  // A synchronous CLI can leave native signals queued after poll; cross the next poll
  // before lifting a participant, even if the first immediate runs in this iteration.
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  const live = await waitForRunning(() => store.liveWarden(home, TASK), { timeoutMs: 30000 });
  check('step 1: the task warden is up as a real process', wardenDemand.status === 0 && !!live?.pid, `${wardenDemand.out} · ${JSON.stringify(live)}`);

  // --- step 2: the worker is raised by the cursor harness -----------------------------------
  const t2 = Date.now();
  assertRunning();
  const spawned = cli([ 'spawn', '--repo', repo, '--brief', workerBrief, '--task', TASK, '--title', identity.title,
    '--worker', 'live', '--harness', 'cursor', '--model', CURSOR_MODEL], { cwd: ws, env });
  check('step 2: promptobus spawn --harness cursor raised a live worker',
    spawned.status === 0 && /worker worker:live lifted/.test(spawned.out), spawned.out.slice(-600));
  const wp = store.participantOf(store.readTask(home, TASK), WORKER);
  workerRef = wp?.sessionRef ?? '';
  const record = cursorPersist.readSession(workerRef);
  check('step 2: the worker persist session is up and sits in the participant record',
    !!record?.sessionName && wp?.metadata?.harness === cursorDriver.id
    && cursorDriver.inspect(workerRef)?.state === 'alive',
    `${JSON.stringify(record)} · ${JSON.stringify(wp?.metadata)}`);
  rememberTranscript();
  rememberProbeMark();
  at_('worker start', Date.now() - t2);

  // --- step 3: the worker result reached the orchestrator -----------------------------------
  const t3 = Date.now();
  const hello = await waitForRunning(() => said(WORKER, 'result', MARK.hello), { timeoutMs: 300000 });
  check('step 3: the Cursor worker result reached the orchestrator — the bus loop closed',
    !!hello, `${JSON.stringify(cursorPersist.readSession(workerRef)?.last)} · ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);
  at_('worker first turn', Date.now() - t3);

  // --- step 4: the reviewer is raised by the codex harness ------------------------------------
  const t4 = Date.now();
  const wt = wp?.metadata?.worktree ?? repoAbs;
  assertRunning();
  const committed = commitSubject(wt, MARK.reviewA, 'First edition: the subject of the first review round.');
  check('step 4: the review subject is committed in the worker worktree',
    committed.status === 0, `${committed.stdout ?? ''}${committed.stderr ?? ''}`.slice(-400));

  const seenA = new Set(orchInbox().filter((m) => sentBy(m, REVIEWER) && m.type === 'result').map(messageKey));
  assertRunning();
  const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'codex', '--model', CODEX_MODEL],
    { cwd: ws, env });
  check('step 4: promptobus review --harness codex raised a live reviewer',
    reviewed.status === 0 && /reviewer reviewer:live started/.test(reviewed.out), reviewed.out.slice(-800));
  const rp = store.participantOf(store.readTask(home, TASK), REVIEWER);
  reviewerRef = rp?.sessionRef ?? '';
  const thread = codexSession.readSession(reviewerRef);
  check('step 4: the reviewer thread landed in the Codex registry, the holder is alive, sandbox is read-only',
    !!thread?.threadId && thread.state === 'alive' && codexSession.pidAlive(thread.holderPid)
    && thread.sandbox === 'read-only',
    JSON.stringify({ threadId: thread?.threadId, state: thread?.state, holder: thread?.holderPid, sandbox: thread?.sandbox }));

  // Identify review rounds by actual diff files, not report wording.
  const diffsOf = () => optionalEntries(store.filesDir(home, TASK)).filter((n) => n.endsWith('.diff'));
  const diffsA = diffsOf();
  check('step 4: the first-round diff landed as a task file and carries the first edition',
    diffsA.length === 1
    && readFileSync(path.join(store.filesDir(home, TASK), diffsA[0]), 'utf8').includes(MARK.reviewA),
    JSON.stringify(diffsA));
  const reviewA = await waitForRunning(() => unseenResult(orchInbox(), seenA, (m) => sentBy(m, REVIEWER)),
    { timeoutMs: 600000 });
  check('step 4: the Codex reviewer got the diff and sent a result on the same bus',
    !!reviewA, codexSession.tailLog(reviewerRef, process.env, 12));
  check('step 4: the reviewer report names the diff file of this round',
    !!reviewA && reportMentionsDiff(reviewA.body, diffsA[0]),
    `${JSON.stringify(reviewA?.body ?? null).slice(0, 400)} · diff ${diffsA.join(', ')}`);
  at_('first review round', Date.now() - t4);

  // --- step 5: notes delivered to the Cursor worker -------------------------------------
  const t5 = Date.now();
  assertRunning();
  store.sendMessage(home, TASK, {
    from: 'orchestrator',
    to: WORKER,
    type: 'review',
    body: `Review notes on your edit. Fetch the mailbox and reply to the orchestrator with a result message whose body starts with the line «${MARK.fix}».`,
  });
  const fixed = await waitForRunning(() => said(WORKER, 'result', MARK.fix), { timeoutMs: 300000 });
  check('step 5: review notes were delivered to the Cursor worker, and it replied',
    !!fixed, `${JSON.stringify(cursorPersist.readSession(workerRef)?.last)} · ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);
  check('step 5: the worker fetched the mailbox itself — it confirms delivery',
    store.countInbox(home, TASK, WORKER) === 0, String(store.countInbox(home, TASK, WORKER)));
  at_('notes and the worker reply', Date.now() - t5);

  // --- step 6: a second diff — to the SAME reviewer ------------------------------------------
  const t6 = Date.now();
  assertRunning();
  const again = commitSubject(wt, MARK.reviewB, 'Second edition: the same edit after the review notes.');
  check('step 6: the second edition of the subject is committed', again.status === 0,
    `${again.stdout ?? ''}${again.stderr ?? ''}`.slice(-400));
  const seenB = new Set(orchInbox().filter((m) => sentBy(m, REVIEWER) && m.type === 'result').map(messageKey));
  assertRunning();
  const reReview = cli([ 'review', wt, '--task', TASK], { cwd: ws, env });
  const rp2 = store.participantOf(store.readTask(home, TASK), REVIEWER);
  // Check already-on-bus, unchanged session reference and unchanged address count together.
  const reviewerAddrs = store.addressesOf(store.readTask(home, TASK))
    .filter((a) => roleEntry(roleRegistry, String(a).split(':')[0])?.kind === READS_DIFF);
  check('step 6: the second diff went to the SAME reviewer — no second session appeared',
    reReview.status === 0 && /already on the bus — new diff sent/.test(reReview.out)
    && rp2?.sessionRef === reviewerRef && reviewerAddrs.length === 1,
    `${reReview.out.slice(-500)} · session ${reviewerRef} → ${rp2?.sessionRef} · addresses ${JSON.stringify(reviewerAddrs)}`);
  const diffsB = diffsOf().filter((n) => !diffsA.includes(n));
  check('step 6: the second diff landed as a SEPARATE file and carries the second edition',
    diffsB.length === 1
    && readFileSync(path.join(store.filesDir(home, TASK), diffsB[0]), 'utf8').includes(MARK.reviewB),
    `${diffsA.join(', ')} → ${diffsOf().join(', ')}`);
  const reviewB = await waitForRunning(() => unseenResult(orchInbox(), seenB, (m) => sentBy(m, REVIEWER)),
    { timeoutMs: 600000 });
  check('step 6: the reviewer parsed the NEW diff in the same context and sent a second result',
    !!reviewB, codexSession.tailLog(reviewerRef, process.env, 12));
  check('step 6: the second report names the diff file of the second round',
    !!reviewB && reportMentionsDiff(reviewB.body, diffsB[0]),
    `${JSON.stringify(reviewB?.body ?? null).slice(0, 400)} · diff ${diffsB.join(', ')}`);
  at_('second review round', Date.now() - t6);

  // --- step 7: confirm the native Stop, then close the task ------------------------------------------
  const t7 = Date.now();
  // Logs — before stop: `done` sweeps the Codex holder log as a file, and the
  // Cursor session record takes the transcript path with it.
  keepLogs();
  assertRunning();
  const stopped = cli(['stop', REVIEWER, '--task', TASK], { cwd: ws, env });
  check('step 7: the native reviewer Stop is confirmed', stopped.status === 0 && /thread .* stopped/.test(stopped.out), stopped.out);
  const done = cli(['done', '--task', TASK], { cwd: ws, env });
  check('step 7: done closed the task and stopped the Cursor worker',
    done.status === 0 && done.out.includes(WORKER), done.out.slice(-800));
  check('step 7: the Cursor worker session is stopped, no record in the registry',
    cursorDriver.inspect(workerRef)?.state === 'gone', JSON.stringify(cursorDriver.inspect(workerRef)));
  check('step 7: the Codex reviewer thread is stopped together with the holder',
    codexDriver.inspect(reviewerRef)?.state === 'gone' && !codexSession.readSession(reviewerRef)
    && !codexSession.pidAlive(thread?.holderPid),
    `${JSON.stringify(codexDriver.inspect(reviewerRef))} · holder ${thread?.holderPid}`);
  const wardenLeft = await waitForRunning(() => (store.liveWarden(home, TASK) ? null : true), { timeoutMs: 30000 });
  check('step 7: the task warden exited with the close — the third participant is stopped too',
    !!wardenLeft, JSON.stringify(store.liveWarden(home, TASK)));
  at_('stop', Date.now() - t7);
} catch (e) {
  if (!aborted) {
    runFailed = true; runFailure = e;
    check('the run reached the end without a break', false, e?.stack ?? e?.message ?? String(e));
  }
} finally {
  if (!aborted) {
    const deadline = Date.now() + NORMAL_STOP_MS;
    const cleanupErrors = [];
    try { retainOwnedSandbox(); } catch (error) { cleanupErrors.push(error); }
    keepLogs();
    const stopNative = async (stopping, ref) => {
      try {
        const result = await stopping;
        if (stopUnconfirmed(result)) {
          cleanupErrors.push(new Error(`${ref}: ${result?.note ?? 'native Stop unconfirmed'}`));
        }
      } catch (error) { cleanupErrors.push(error); }
    };
    // A signal transfers cleanup ownership to the abort handler, with the sandbox intact.
    const stopping = [
      workerRef ? stopNative(stopWorker(deadline), workerRef) : null,
      reviewerRef ? stopNative(stopReviewer(() => Math.max(0, deadline - Date.now())), reviewerRef) : null,
    ];
    await Promise.all(stopping);
    keepCommandReceipts();
    if (!aborted) {
      try {
        checkRegistries();
      } catch (error) { cleanupErrors.push(error); }
      try {
        await closeService();
        const seat = observeWardenSeat();
        if (seat.state !== 'absent') cleanupErrors.push(new Error(`Task warden seat cleanup unconfirmed: ${JSON.stringify(seat)}`));
      } catch (error) { if (!aborted) cleanupErrors.push(error); }
      if (!aborted) {
        if (cleanupErrors.length) {
          throw new AggregateError([...(runFailed ? [runFailure] : []), ...cleanupErrors],
            `live cleanup unconfirmed; sandbox ${sandboxRetained ? 'retained' : 'retention unconfirmed'}: ${SB}`);
        }
        if (checkMachineCleanup()) rmSync(SB, { recursive: true, force: true });
        else process.stdout.write(`▸ cleanup unconfirmed; sandbox retained: ${SB}\n`);
      }
    }
  }
}

if (!aborted) {
  // --- hygiene: the person home and the machine after the loop ----------------------------------------

  const passed = verdicts.filter((v) => v.ok).length;
  process.stdout.write(`\n${passed}/${verdicts.length} verdicts passed\n`);
  process.stdout.write(`durations: ${times.join(' · ') || '—'} · total ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  process.stdout.write(`binaries: cursor ${tools.cursor.path}${tools.cursor.version ? ` (${tools.cursor.version})` : ''}`
    + ` · codex ${tools.codex.path}${tools.codex.version ? ` (${tools.codex.version})` : ''}\n`);
  process.stdout.write(`models: worker ${CURSOR_MODEL} · reviewer ${CODEX_MODEL}\n`);
  if (codexHygiene.summary) process.stdout.write(`${codexHygiene.summary}\n`);
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
  process.exitCode = passed === verdicts.length ? 0 : 1;
}

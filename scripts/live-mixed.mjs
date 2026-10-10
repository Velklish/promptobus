#!/usr/bin/env node
// Live run of a MIXED lineup: the orchestrator is this script, the worker is
// live Cursor, the reviewer is live Codex. Run:
//
//   node scripts/live-mixed.mjs [--cursor-model <id>] [--codex-model <id>]
//
// Not in `npm test` and not in the release gate: it spends limits of TWO
// accounts at once (Cursor and the owner's ChatGPT.app) and talks to live
// binaries. The owner drives it by hand.
//
// **Why its own script, not `live-e2e.mjs` with a mixed lineup.** The live
// loop of the shared scenario ([scenario.mjs](../test/scenario.mjs)) goes from
// a Claude Code session: it has its own orchestrator messaging socket and stall
// turns Cursor and Codex do not have by nature. The stand mixed-lineup run
// ([promptobus-mixed.test.mjs](../test/promptobus-mixed.test.mjs)) is exactly
// what closes the scenario on stub binaries — and this script is shorter and
// about its own: that the lineup assembles on LIVE tools and that after the
// loop the machine is clean.
//
// What the run checks: that the worker is raised with `--harness cursor` and
// its `result` reaches the orchestrator; that the reviewer is raised with
// `--harness codex` on the same loop, gets a diff and replies; that notes
// reach the Cursor worker; that a second diff goes to the SAME reviewer and
// does not raise a second one; that `promptobus done` stops all three; that
// after the loop there are neither processes nor registry records nor
// directories in `$TMPDIR`, and personal `~/.codex/config.toml` did not
// change.
//
// **The sha of `~/.codex/config.toml` is a separate verdict, and it is about
// write rights.** The reviewer goes read-only, and `codex app-server` with
// `workspace-write` appends a trust section `[projects."…"]` to this file —
// i.e. a person's consent to trust a directory. A run that left it silently
// widened trust in the personal config; sha before and after is how to see
// that, without the marketplace refresh timestamps ([codex-config.mjs](codex-config.mjs)).
//
// A review round is answered by the reviewer's next unseen result naming the round's diff file.
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { finishLiveArgs, parseLiveArgs } from './live-args.mjs';
import { makeSandbox, writeHostConfig, resolveToolBin } from '../test/sandbox.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { freshScenarioIdentity, buildWorkspace, cli, MECHANISM_ROOT, PROMPTOBUS_BIN, sentBy, store } from '../test/scenario.mjs';
import { waitFor } from '../test/harness.mjs';
import { markRunOwner, sweepLiveRuns, sweepPreviousRuns, sweptLine } from './canary-runs.mjs';
import { onAbort } from './live-abort.mjs';
import { codexConfigSha } from './codex-config.mjs';
import { messageKey, reportMentionsDiff, unseenResult } from './review-events.mjs';
import { requiredTmuxSessions, tmuxAbsenceVerdict } from './tmux-check.mjs';
import { addrKey } from '../test/harness-cursor.mjs';

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
const cursorPersist = await import(path.join(MECHANISM_ROOT, 'lib', 'cursor-persist.js'));
const codexSession = await import(path.join(MECHANISM_ROOT, 'lib', 'codex-session.js'));

// Both models are named by flags: the run is driven on the ones the owner
// named, and they go into the report. The Codex default is taken from the
// driver — there is no reason to invent a number here.
const CURSOR_MODEL = LIVE_ARGS.cursorModel ?? 'cursor-grok-4.6-xhigh-fast';
const CODEX_MODEL = LIVE_ARGS.codexModel ?? CODEX_DEFAULT;

// Both binaries are asked BEFORE any layout: a loop of three participants
// without one of them checks nothing, and a refuse mid-way would leave a live
// session of the other behind.
const tools = { cursor: resolveToolBin('cursor'), codex: resolveToolBin('codex') };
const missing = Object.entries(tools).filter(([, t]) => !t.ok);
if (missing.length) {
  for (const [name, t] of missing) console.error(`✖ nothing to drive the live run with: ${name} — ${t.reason}`);
  process.exit(1);
}

// Session identity is stripped from this environment with the same list as the
// suite: the run is driven from a session that has all the variables set, and
// a leaked `PROMPTOBUS_TASK` would send commands onto a live-run task.
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

// Codex processes are looked up by TWO templates and both are needed: `pgrep
// -fl codex` also catches foreign commands with the word codex in the path
// (including this script itself), and the thread holder is visible only as
// `app-server --stdio`.
function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return String(r.stdout ?? '').trim().split('\n').filter(Boolean);
}

const CODEX_CONFIG = path.join(homedir(), '.codex', 'config.toml');
const shaBefore = codexConfigSha(CODEX_CONFIG);
const pgrepBefore = { cask: pgrep('Caskroom/codex'), app: pgrep('app-server --stdio') };

// The Cursor registry stays in the person home, named, since the helpers refuse to guess one;
// what the run leaves there is compared before and after, the person's own sessions subtracted.
process.env.PROMPTOBUS_CURSOR_HOME = process.env.PROMPTOBUS_CURSOR_HOME ?? path.join(homedir(), '.promptobus', 'cursor');
const CURSOR_STATE = cursorPersist.sessionsDir();
// The person's Codex registry is only compared: the run's own Codex home goes under the sandbox below.
const USER_CODEX_STATE = codexSession.sessionsDir({
  PROMPTOBUS_CODEX_HOME: process.env.PROMPTOBUS_CODEX_HOME ?? path.join(homedir(), '.promptobus', 'codex'),
});
const listing = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const stateBefore = { cursor: listing(CURSOR_STATE), codex: listing(USER_CODEX_STATE) };
let panesBefore;
try {
  panesBefore = new Set(requiredTmuxSessions(cursorPersist.readTmuxSessions).map((s) => s.name));
} catch (error) {
  console.error(`✖ no persist session list to subtract before the run: ${error.message}`);
  process.exit(1);
}

// The sandbox prefix is not a PREFIX of the logs prefix, and that is a
// condition, not style: the `$TMPDIR` leftover verdict looks up run
// directories by the start of the name, and logs legally outlive the run and
// are swept by their own sweep. A shared start `promptobus-live-mixed-` on
// both would mean the second run goes red on the first run's logs.
const RUN_PREFIX = 'promptobus-live-mixed-run-';
const born = Date.now();
const bornAfter = (file) => {
  try {
    const st = statSync(file);
    return (st.birthtimeMs || st.mtimeMs) >= born;
  } catch { return false; }
};
const SB = makeSandbox(RUN_PREFIX);
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

const env = { ...process.env, PROMPTOBUS_HOME: home, CLAUDE_CODE_SESSION_ID: ORCH_SESSION };
const wardenEnv = { ...env };
delete wardenEnv.PROMPTOBUS_WARDEN;

store.createTask(home, { ...identity, owner: ORCH_SESSION });
const warden = spawn(process.execPath, [PROMPTOBUS_BIN, 'warden', '--task', TASK], {
  cwd: ws, detached: true, stdio: 'ignore', env: wardenEnv,
});
warden.unref();

process.stdout.write(`▸ live mixed-lineup run: worker Cursor + reviewer Codex\n`);
process.stdout.write(`▸ cursor: ${tools.cursor.path}${tools.cursor.version ? ` (${tools.cursor.version})` : ''} · model ${CURSOR_MODEL}\n`);
process.stdout.write(`▸ codex: ${tools.codex.path}${tools.codex.version ? ` (${tools.codex.version})` : ''} · model ${CODEX_MODEL} · reviewer sandbox: read-only\n`);
process.stdout.write(`▸ mechanism: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ sandbox: ${SB} · store: ${home}\n`);
process.stdout.write(`▸ task: ${TASK}\n`);
process.stdout.write(`▸ sha ~/.codex/config.toml before: ${shaBefore ?? '(no file)'}\n`);
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
let codexStateBeforeCleanup = [];
// Turn logs are taken BEFORE stop, and the two halves of the lineup differ,
// because `done` sweeps different things. It does not touch the Cursor
// transcript — that lives in the Cursor home — but the PATH to it sits in the
// session record that teardown drops: the path is remembered. `dropSession`
// sweeps the Codex holder log as a FILE with the record, and after `done`
// there is nothing to copy at all: it is copied at once, while it is alive.
function rememberTranscript() {
  try {
    const from = workerRef ? cursorPersist.transcriptOf(cursorPersist.readSession(workerRef) ?? {}) : null;
    if (from) transcriptPath = from;
  } catch {
    // No session record — the transcript path cannot be restored, that does not cancel the run.
  }
  return transcriptPath;
}

// Persist-session marker of THIS run: after the loop it recognises our
// `cursor-agent` and `worker-server` among foreign ones. It is taken from the
// session record and therefore before teardown — after `done` there is no
// record, and the orphan the verdict exists for is exactly what outlives it.
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

/** Any outcome: a holder copy — a repeat for a red loop that never reached stop. */
function keepLogs() {
  keepTranscript();
  keepHolderLog();
}

// The same cleanup as `finally`: logs first, the Cursor worker stopped with no wait, the warden by
// its process group. The Codex holder exits with its record when the exit hook removes the sandbox.
onAbort((signal) => {
  const say = (line) => writeSync(1, line);
  say(`\n▸ run cut off by ${signal}: keeping the logs and stopping the loop\n`);
  keepLogs();
  if (workerRef) {
    Promise.resolve(cursorDriver.stop(workerRef, { timeoutMs: 0 })).catch(() => {});
    say(`  · stop sent to the Cursor worker: ${workerRef}\n`);
  }
  try {
    process.kill(-warden.pid, 'SIGTERM');
    say('  · task warden stopped by its process group\n');
  } catch {
    say('  · no task warden left\n');
  }
  say(`  · Codex reviewer ${reviewerRef || '(none yet)'} ends with the sandbox: ${SB}\n`);
  say(`  · turn logs: ${KEPT_LOGS}\n`);
});

const t0 = Date.now();
try {
  const live = await waitFor(() => store.liveWarden(home, TASK), { timeoutMs: 30000 });
  check('step 1: the task warden is up as a real process', !!live?.pid, JSON.stringify(live));

  // --- step 2: the worker is raised by the cursor harness -----------------------------------
  const t2 = Date.now();
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
  const hello = await waitFor(() => said(WORKER, 'result', MARK.hello), { timeoutMs: 300000 });
  check('step 3: the Cursor worker result reached the orchestrator — the bus loop closed',
    !!hello, `${JSON.stringify(cursorPersist.readSession(workerRef)?.last)} · ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);
  at_('worker first turn', Date.now() - t3);

  // --- step 4: the reviewer is raised by the codex harness ------------------------------------
  const t4 = Date.now();
  const wt = wp?.metadata?.worktree ?? repoAbs;
  const committed = commitSubject(wt, MARK.reviewA, 'First edition: the subject of the first review round.');
  check('step 4: the review subject is committed in the worker worktree',
    committed.status === 0, `${committed.stdout ?? ''}${committed.stderr ?? ''}`.slice(-400));

  const seenA = new Set(orchInbox().filter((m) => sentBy(m, REVIEWER) && m.type === 'result').map(messageKey));
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

  // The diff goes to the reviewer as a FILE in the task directory, and the list
  // of its files is what distinguishes the rounds. It is asked of the
  // directory, not of a prose parse of the output: the path in the report line
  // is output for a person, and a verdict on its wording goes idle on the first
  // phrase edit.
  const diffsOf = () => listing(store.filesDir(home, TASK)).filter((n) => n.endsWith('.diff'));
  const diffsA = diffsOf();
  check('step 4: the first-round diff landed as a task file and carries the first edition',
    diffsA.length === 1
    && readFileSync(path.join(store.filesDir(home, TASK), diffsA[0]), 'utf8').includes(MARK.reviewA),
    JSON.stringify(diffsA));
  const reviewA = await waitFor(() => unseenResult(orchInbox(), seenA, (m) => sentBy(m, REVIEWER)),
    { timeoutMs: 600000 });
  check('step 4: the Codex reviewer got the diff and sent a result on the same bus',
    !!reviewA, codexSession.tailLog(reviewerRef, process.env, 12));
  check('step 4: the reviewer report names the diff file of this round',
    !!reviewA && reportMentionsDiff(reviewA.body, diffsA[0]),
    `${JSON.stringify(reviewA?.body ?? null).slice(0, 400)} · diff ${diffsA.join(', ')}`);
  at_('first review round', Date.now() - t4);

  // --- step 5: notes delivered to the Cursor worker -------------------------------------
  const t5 = Date.now();
  store.sendMessage(home, TASK, {
    from: 'orchestrator',
    to: WORKER,
    type: 'review',
    body: `Review notes on your edit. Fetch the mailbox and reply to the orchestrator with a result message whose body starts with the line «${MARK.fix}».`,
  });
  const fixed = await waitFor(() => said(WORKER, 'result', MARK.fix), { timeoutMs: 300000 });
  check('step 5: review notes were delivered to the Cursor worker, and it replied',
    !!fixed, `${JSON.stringify(cursorPersist.readSession(workerRef)?.last)} · ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);
  check('step 5: the worker fetched the mailbox itself — it confirms delivery',
    store.countInbox(home, TASK, WORKER) === 0, String(store.countInbox(home, TASK, WORKER)));
  at_('notes and the worker reply', Date.now() - t5);

  // --- step 6: a second diff — to the SAME reviewer ------------------------------------------
  const t6 = Date.now();
  const again = commitSubject(wt, MARK.reviewB, 'Second edition: the same edit after the review notes.');
  check('step 6: the second edition of the subject is committed', again.status === 0,
    `${again.stdout ?? ''}${again.stderr ?? ''}`.slice(-400));
  const seenB = new Set(orchInbox().filter((m) => sentBy(m, REVIEWER) && m.type === 'result').map(messageKey));
  const reReview = cli([ 'review', wt, '--task', TASK], { cwd: ws, env });
  const rp2 = store.participantOf(store.readTask(home, TASK), REVIEWER);
  // The same reviewer is THREE things at once: the mechanism said "already on the bus",
  // the session reference did not change, and a second reviewer address did not
  // appear on the task. Any one of them would go green on a reviewer raised
  // again.
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
  const reviewB = await waitFor(() => unseenResult(orchInbox(), seenB, (m) => sentBy(m, REVIEWER)),
    { timeoutMs: 600000 });
  check('step 6: the reviewer parsed the NEW diff in the same context and sent a second result',
    !!reviewB, codexSession.tailLog(reviewerRef, process.env, 12));
  check('step 6: the second report names the diff file of the second round',
    !!reviewB && reportMentionsDiff(reviewB.body, diffsB[0]),
    `${JSON.stringify(reviewB?.body ?? null).slice(0, 400)} · diff ${diffsB.join(', ')}`);
  at_('second review round', Date.now() - t6);

  // --- step 7: promptobus done stops all three ------------------------------------------
  const t7 = Date.now();
  // Logs — before stop: `done` sweeps the Codex holder log as a file, and the
  // Cursor session record takes the transcript path with it.
  keepLogs();
  const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
  check('step 7: promptobus done closed the task and named both sessions it stops',
    done.status === 0 && done.out.includes(WORKER) && done.out.includes(REVIEWER), done.out.slice(-800));
  check('step 7: the Cursor worker session is stopped, no record in the registry',
    cursorDriver.inspect(workerRef)?.state === 'gone', JSON.stringify(cursorDriver.inspect(workerRef)));
  check('step 7: the Codex reviewer thread is stopped together with the holder',
    codexDriver.inspect(reviewerRef)?.state === 'gone' && !codexSession.readSession(reviewerRef)
    && !codexSession.pidAlive(thread?.holderPid),
    `${JSON.stringify(codexDriver.inspect(reviewerRef))} · holder ${thread?.holderPid}`);
  const wardenLeft = await waitFor(() => (store.liveWarden(home, TASK) ? null : true), { timeoutMs: 30000 });
  check('step 7: the task warden exited with the close — the third participant is stopped too',
    !!wardenLeft, JSON.stringify(store.liveWarden(home, TASK)));
  at_('stop', Date.now() - t7);
} catch (e) {
  check('the run reached the end without a break', false, e.stack ?? e.message);
} finally {
  keepLogs();
  // Cleanup runs on any outcome: a fallen run must leave neither processes nor
  // directories. Stop is by their own drivers, each by its own record.
  if (workerRef) await Promise.resolve(cursorDriver.stop(workerRef, { timeoutMs: 0 })).catch(() => {});
  if (reviewerRef) await Promise.resolve(codexDriver.stop(reviewerRef)).catch(() => {});
  codexStateBeforeCleanup = listing(CODEX_STATE);
  try {
    process.kill(-warden.pid, 'SIGTERM');
  } catch {
    // No group, or the process already exited.
  }
  rmSync(SB, { recursive: true, force: true });
}

// --- hygiene: the person home and the machine after the loop ----------------------------------------

const shaAfter = codexConfigSha(CODEX_CONFIG);
// The main Codex hygiene verdict: the reviewer went read-only, and it must not
// write a trust section `[projects."…"]` into the personal config. Sha is
// compared, not parsed: a change of the file in ANY form is already a widening
// of personal settings by the run.
check('personal ~/.codex/config.toml did not change over the loop (sha) — the reviewer did not write a trust section',
  shaBefore === shaAfter, `${shaBefore} → ${shaAfter}`);

const pgrepAfter = { cask: pgrep('Caskroom/codex'), app: pgrep('app-server --stdio') };
const extraCask = pgrepAfter.cask.filter((p) => !pgrepBefore.cask.includes(p));
const extraApp = pgrepAfter.app.filter((p) => !pgrepBefore.app.includes(p));
check('no new Caskroom/codex processes after the loop', extraCask.length === 0, extraCask.join(' | '));
check('no new app-server --stdio processes after the loop', extraApp.length === 0, extraApp.join(' | '));

// The Cursor half of the lineup is judged by its own check: the Codex holder
// is recognised by the command name (`pgrep` above), and `cursor-agent` and
// `worker-server` are not — every persist session on the machine raises them,
// including a person session in the IDE. Ours are those whose argv, cwd or
// environment contain THIS run directory or its session marker; foreign ones
// go as a line into the report and do not paint the verdict. The check is
// taken from `live-cursor.mjs`, where it also caught orphans (a holder that
// outlived its parent).
// A listing that cannot be read, or that lacks this very process, is red: an empty one passes on nothing.
const ps = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const seesSelf = String(ps.stdout ?? '').split('\n').some((l) => Number(l.trim().split(/\s+/)[0]) === process.pid);
const ours = [];
const foreign = [];
for (const line of String(ps.stdout ?? '').split('\n')) {
  const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
  if (!m || !/cursor-agent|worker-server/.test(m[2])) continue;
  const dump = spawnSync('ps', ['eww', '-o', 'command=', '-p', m[1]], { encoding: 'utf8' });
  const text = String(dump.stdout ?? '');
  const mine = text.includes(SB) || text.includes(ws) || probeMarks.some((mark) => text.includes(mark));
  const row = `${m[1]} ${m[2].slice(0, 60)}`;
  if (mine) ours.push(row);
  else foreign.push(row);
}
check('no Cursor processes of the run left after the loop', ps.status === 0 && seesSelf && ours.length === 0,
  seesSelf ? ours.join(' | ') : `ps did not list this process (exit ${ps.status} · ${String(ps.error?.message ?? ps.stderr ?? '').slice(0, 200)})`);
if (foreign.length) {
  process.stdout.write(`  · processes of the same commands outside the run directory: ${foreign.length} (not ours)\n`);
}

// Cursor persist sessions are judged by SUBTRACTION: person sessions and other
// runs legally live nearby, and an "empty list" would be a wrong verdict on a
// working machine.
const finalPanes = tmuxAbsenceVerdict(cursorPersist.readTmuxSessions, panesBefore);
check('no persist sessions of the run on the tmux server after the loop, foreign ones intact',
  finalPanes.ok, finalPanes.detail);

const stateLeft = {
  cursor: listing(CURSOR_STATE).filter((n) => !stateBefore.cursor.includes(n)),
  codex: listing(USER_CODEX_STATE).filter((n) => !stateBefore.codex.includes(n)),
};
check('after the loop the Cursor registry is clean and the person\'s Codex registry untouched',
  stateLeft.cursor.length === 0 && stateLeft.codex.length === 0,
  `cursor: ${stateLeft.cursor.join(', ') || 'clean'} · codex: ${stateLeft.codex.join(', ') || 'clean'}`);
check('after the stop the run\'s own Codex registry was empty before the sandbox went',
  codexStateBeforeCleanup.length === 0, codexStateBeforeCleanup.join(', ') || 'clean');

// Leftovers in `$TMPDIR` are looked up by the run PREFIX, not by the directory
// name whole: the name is given by the sandbox generator, and a literal would
// go idle on the first change of it.
// Logs under their own prefix do not land here at all — they legally live
// until the sweep, and past-run directories cannot be subtracted by one
// current pid.
const tmpLeft = listing(tmpdir())
  .filter((n) => n.startsWith(RUN_PREFIX))
  .filter((n) => bornAfter(path.join(tmpdir(), n)));
check('no run directories left in $TMPDIR after the loop',
  tmpLeft.length === 0 && !existsSync(SB),
  `${tmpLeft.join(', ') || 'clean'} · sandbox ${existsSync(SB) ? SB : 'swept'}`);

const passed = verdicts.filter((v) => v.ok).length;
process.stdout.write(`\n${passed}/${verdicts.length} verdicts passed\n`);
process.stdout.write(`durations: ${times.join(' · ') || '—'} · total ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
process.stdout.write(`binaries: cursor ${tools.cursor.path}${tools.cursor.version ? ` (${tools.cursor.version})` : ''}`
  + ` · codex ${tools.codex.path}${tools.codex.version ? ` (${tools.codex.version})` : ''}\n`);
process.stdout.write(`models: worker ${CURSOR_MODEL} · reviewer ${CODEX_MODEL}\n`);
process.stdout.write(`sha ~/.codex/config.toml: ${shaBefore ?? '(none)'} → ${shaAfter ?? '(none)'}\n`);
process.stdout.write(`pgrep Caskroom/codex: was ${pgrepBefore.cask.length}, became ${pgrepAfter.cask.length}`
  + ` · pgrep 'app-server --stdio': was ${pgrepBefore.app.length}, became ${pgrepAfter.app.length}\n`);
// The logs directory is swept by the same module as the canary directories:
// the three newest stay, nothing younger than an hour is removed. The trouble
// is shared — pile-up in a shared `$TMPDIR` — and it is healed by shared
// code, not a second copy of the thresholds.
const refusedLogs = [];
const sweptLogs = sweepPreviousRuns(tmpdir(), {
  prefix: LOGS_PREFIX, current: KEPT_LOGS, refused: refusedLogs,
});
process.stdout.write(`${sweptLine('previous-run logs', sweptLogs)}\n`);
if (refusedLogs.length) process.stdout.write(`sweep refused (busy or foreign permissions): ${refusedLogs.join(', ')}\n`);
// The logs line is printed BY FACT: there may be none at all — the run broke
// before the first turn — and promising a directory that is not there means
// sending a person into a void.
process.stdout.write(existsSync(KEPT_LOGS)
  ? `run turn logs: ${KEPT_LOGS}\n`
  : 'no run turn logs — the first turn was never reached\n');
process.exitCode = passed === verdicts.length ? 0 : 1;

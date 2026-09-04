#!/usr/bin/env node
// Live check of the Cursor driver on a real `agent`. Run:
//
//   node scripts/live-cursor.mjs [--model <id>]
//
// Not in `npm test` and will not be: it raises live Cursor sessions, spends
// account limits and writes into the person home what Cursor itself writes
// there.
//
// **Why not `live-e2e.mjs --harness cursor`.** That run is the same scenario as
// the stub harness ([scenario.mjs](../test/scenario.mjs)), and it is built for
// Claude Code whole: its own orchestrator messaging socket, a session snapshot
// by list, `permission` and `limit` stall turns Cursor does not have by nature.
// Driving it with a second harness would mean editing the scenario itself, not
// its reads — and scenario verdicts and thresholds do not move. So this file
// has its own loop, shorter and about its own: raise a Cursor participant, a
// bus loop from its live persist session, a wake by injection, a human attach,
// delivery into a going turn, a read-only reviewer, a skill read from
// `.cursor/skills` of its `--workspace`, and cleanup.
//
// What the run checks and what it does not. It checks: that the mechanism
// raises a live persist session with the real binary and finds it among
// foreign ones, that the bus reaches it by a tool call (not by reply text),
// that the warden wakes a stalled session by injection and without a new
// process, that a human attaches to the same session as a second client, that
// a message during a turn arrives and is executed on the next turn, that the
// reviewer deny holds, that the participant reads a skill from `.cursor/skills`
// of its `--workspace` (a stub in the canon, a marker in the first bus
// message), and that after the loop the machine has neither sessions nor
// processes nor registry records — and the person sessions are intact. It does
// not check model-reasoning quality: checks go by a marker at the start of the
// body.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { makeSandbox, writeHostConfig, resolveToolBin } from '../test/sandbox.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { buildWorkspace, cli, MECHANISM_ROOT, PROMPTOBUS_BIN, store } from '../test/scenario.mjs';
import { waitFor } from '../test/harness.mjs';
import { sweepPreviousRuns } from './canary-runs.mjs';
import { addrKey } from '../test/harness-cursor.mjs';

const { cursorDriver, reviewSandbox } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-cursor.js'));
const {
  cursorStateHome, listSessions, readSession, reapOrphans, sessionMarker, tmux, transcriptOf,
} = await import(path.join(MECHANISM_ROOT, 'lib', 'cursor-persist.js'));

// The model is named by a flag, not taken from the driver default: the live
// check is driven on the one the owner named, and it goes into the report.
const argv = process.argv.slice(2);
const at = argv.indexOf('--model');
const MODEL = at >= 0 && at + 1 < argv.length ? argv[at + 1] : 'cursor-grok-4.6-xhigh-fast';

const tool = resolveToolBin('cursor');
if (!tool.ok) {
  console.error(`✖ nothing to drive the live run with: ${tool.reason}`);
  process.exit(1);
}

// Session identity is stripped from this environment with the same list as the
// suite: the run is driven from a session that has all five variables set, and
// a leaked `PROMPTOBUS_TASK` would send sandbox commands onto a live-run task.
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

// Snapshot of the person home: what Cursor writes there the report names by
// name. Absolute timestamps are not needed here — directory compositions are
// compared before and after.
const CURSOR_HOME = path.join(homedir(), '.cursor');
function snapshotHome() {
  const listing = (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  return {
    chats: new Set(listing(path.join(CURSOR_HOME, 'chats'))),
    projects: new Set(listing(path.join(CURSOR_HOME, 'projects'))),
  };
}
const before = snapshotHome();

// The mechanism session registry lives in the person home and is NOT redirected
// in a live run: the subject is how this works for the user. That nothing is
// left there after the loop is what the run compares — compositions before and
// after.
const STATE_HOME = cursorStateHome();
function snapshotState() {
  try {
    return readdirSync(path.join(STATE_HOME, 'sessions'));
  } catch {
    return [];
  }
}
const stateBefore = snapshotState();

// Persist sessions on the shared server before the run: person sessions legally
// live nearby, and they must be subtracted — an "empty list" after the loop
// would be a wrong verdict on a machine where the person works in their own
// session.
const sessionsBefore = new Set(listSessions().map((s) => s.name));

const SB = makeSandbox('promptobus-live-cursor-');
// Turn logs outlive the run: the sandbox is swept, and the stream is needed to
// debug a red.
const LOGS_PREFIX = 'promptobus-live-cursor-logs-';
const KEPT_LOGS = path.join(tmpdir(), `${LOGS_PREFIX}${process.pid}`);
const TASK = `livecursor-t${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
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

const env = { ...process.env, PROMPTOBUS_HOME: home, CLAUDE_CODE_SESSION_ID: ORCH_SESSION };
const wardenEnv = { ...env };
delete wardenEnv.PROMPTOBUS_WARDEN;

store.createTask(home, { id: TASK, title: 'живая проверка driver’а Cursor', owner: ORCH_SESSION });
const warden = spawn(process.execPath, [PROMPTOBUS_BIN, 'warden', '--task', TASK], {
  cwd: ws, detached: true, stdio: 'ignore', env: wardenEnv,
});
warden.unref();

process.stdout.write(`▸ live Cursor run: ${tool.path}${tool.version ? ` (${tool.version})` : ''}\n`);
process.stdout.write(`▸ model: ${MODEL}\n`);
process.stdout.write(`▸ mechanism: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ sandbox: ${SB} · store: ${home}\n`);
if (leaked.length) process.stdout.write(`▸ stripped from the run environment: ${leaked.join(', ')}\n`);

// Transcripts of both participants — into a directory that outlives the run.
// Under persist they are the stream a red is debugged by: the mechanism no
// longer keeps its own turn journal. A copy is needed because the transcript
// path sits in the session record, and teardown drops it — after the loop
// there is nothing to find the file in the Cursor home by. Called from
// `finally`, so it stays silent on any surprise: diagnostics must not drop
// cleanup.
const transcripts = new Map();
function rememberTranscript(addr) {
  try {
    const kept = store.participantOf(store.readTask(home, TASK), addr)?.sessionRef;
    const from = kept ? transcriptOf(readSession(kept) ?? {}) : null;
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
let sandboxDir = '';
// Session markers of THIS run: `~/legacy/cursor/sessions/` is shared by every
// persist session of the mechanism on the machine, and leftovers cannot be
// judged by it (measurement below).
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
const t0 = Date.now();
try {
  const live = await waitFor(() => store.liveWarden(home, TASK), { timeoutMs: 30000 });
  check('step 1: the task warden is up as a real process', !!live?.pid, JSON.stringify(live));

  // --- step 2: raise a Cursor participant ------------------------------------------------
  const t2 = Date.now();
  const spawned = cli([ 'spawn', '--repo', repo, '--brief', workerBrief, '--task', TASK,
    '--worker', 'live', '--harness', 'cursor', '--model', MODEL], { cwd: ws, env });
  check('step 2: promptobus spawn --harness cursor raised a live participant',
    spawned.status === 0 && /worker worker:live поднят/.test(spawned.out), spawned.out.slice(-600));
  at_('participant start', Date.now() - t2);

  const wp = store.participantOf(store.readTask(home, TASK), WORKER);
  ref = wp?.sessionRef ?? '';
  const record = readSession(ref);
  check('step 2: persist session is up, the chat is recognised, and both sit in the participant record',
    !!record?.sessionName && !!record?.chatId
    && wp?.metadata?.session === record.sessionName && wp?.metadata?.sessionId === record.chatId,
    `${JSON.stringify(record)} · ${wp?.metadata?.session} · ${wp?.metadata?.sessionId}`);

  const mine = listSessions().find((s) => s.name === record?.sessionName) ?? null;
  check('step 2: the session is visible in the tmux list, marked with the task and address, and its chat is the same',
    !!mine && mine.managed && mine.task === TASK && mine.address === WORKER && mine.chatId === record?.chatId,
    JSON.stringify(listSessions()));

  const listOut = spawnSync(tool.path, ['persist', 'list'], { encoding: 'utf8' });
  check('step 2: the mechanism session is visible to a human agent persist list — it is on the shared server',
    listOut.status === 0 && String(listOut.stdout ?? '').includes((record?.sessionName || 'no-name')),
    String(listOut.stdout ?? '').slice(-500));

  check('step 2: the one-shot pty-provider pane is down — the launch server is empty',
    listSessions({ server: 'promptobus-launch' }).length === 0,
    JSON.stringify(listSessions({ server: 'promptobus-launch' })));

  const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
  check('step 2: promptobus status shows the Cursor session is alive',
    statusOut.status === 0 && statusOut.out.includes(WORKER) && /сесси/.test(statusOut.out),
    statusOut.out.slice(-500));

  const liveWt = wp?.metadata?.worktree ?? '';
  check('step 2: the stub skill landed in the participant worktree',
    existsSync(path.join(liveWt, '.cursor', 'skills', 'live-cursor-probe', 'SKILL.md'))
    && readFileSync(path.join(liveWt, '.cursor', 'skills', 'live-cursor-probe', 'SKILL.md'), 'utf8').includes(MARK.skill),
    liveWt);

  // --- step 3: bus loop from a live Cursor session ---------------------------------------
  const t3 = Date.now();
  const hello = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => String(m.body ?? '').includes(MARK.hello)) ?? null, { timeoutMs: 300000 });
  check('step 3: the first-turn result reached the orchestrator — the bus loop from Cursor closed',
    !!hello, JSON.stringify(hello ?? readSession(ref)?.last));
  check('step 3: the participant read the skill from its .cursor/skills — the marker is in the first message',
    !!hello && String(hello.body ?? '').includes(MARK.skill),
    JSON.stringify(hello ?? readSession(ref)?.last));
  at_('participant first turn', Date.now() - t3);

  // The mark "the bus arrived by a TOOL" is a call in the transcript, not the
  // fact of delivery: under `--force` the model may raise the bus server with
  // the shell itself, and the store message would look the same. There is no
  // `stream-json` stream under persist at all, so the transcript is read.
  const toolCalls = () => {
    const file = transcriptOf(readSession(ref) ?? {});
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
  const calledBus = await waitFor(() => (toolCalls().some((n) => /promptobus/.test(String(n))) ? toolCalls() : null),
    { timeoutMs: 120000 });
  check('step 3: the bus was called as a TOOL — the call is visible in the chat transcript',
    !!calledBus, `transcript calls: ${JSON.stringify(toolCalls()).slice(0, 500)}`);
  rememberTranscript(WORKER);

  // --- step 4: wake by injection into a live session ------------------------------------
  const t4 = Date.now();
  const paneWas = readSession(ref)?.panePid ?? null;
  store.sendMessage(home, TASK, {
    from: 'orchestrator', to: WORKER, type: 'answer',
    body: `Woke you. Fetch the mailbox and reply to the orchestrator with a result message whose body starts with the line «${MARK.woke}».`,
  });
  // Check by TYPE and the START of the body, not by containment: a live model
  // retells the next step in its own words and on the first turn already quotes
  // the second marker — containment then catches the wrong turn, and the
  // verdict goes green on nothing (measured 2026-09-03: the first run gave
  // "wake 0.0 s").
  const woke = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => m.type === 'result' && String(m.body ?? '').trimStart().startsWith(MARK.woke)) ?? null,
  { timeoutMs: 300000 });
  check('step 4: the warden woke the Cursor session by injection, and the participant replied',
    !!woke, `${JSON.stringify(readSession(ref)?.last)} · ${store.tailWardenLog(home, TASK).slice(-6).join(' | ')}`);
  // The main difference from headless: a wake does not start a new PROCESS. The
  // session pane is the same — so the context was not rehydrated, and that is
  // the gain the driver was moved to persist for.
  check('step 4: the wake went WITHOUT a new process — the session pane is the same',
    !!paneWas && readSession(ref)?.panePid === paneWas
    && listSessions().some((s) => s.name === record?.sessionName && s.panePid === paneWas),
    `${paneWas} → ${readSession(ref)?.panePid} · ${JSON.stringify(listSessions())}`);
  check('step 4: the participant fetched the mailbox itself — it confirms delivery',
    store.countInbox(home, TASK, WORKER) === 0, String(store.countInbox(home, TASK, WORKER)));
  at_('wake and second turn', Date.now() - t4);

  // --- step 4b: a human attaches to the same session -------------------------------------------
  //
  // Attach is modeled by a second client from a one-shot mechanism pane: live,
  // a person does exactly this from their terminal. The price is named in the
  // spike report — tmux shrinks the window to the narrowest client — so the
  // attach pane is raised wide.
  const t4b = Date.now();
  const seat = `promptobus-live-attach-${process.pid}`;
  tmux(['new-session', '-d', '-s', seat, '-x', '200', '-y', '50',
    `${tool.path} persist attach ${record?.sessionName}`], { server: 'promptobus-launch' });
  const attached = await waitFor(() => {
    const s = listSessions().find((x) => x.name === record?.sessionName);
    return s && s.attached > 0 ? s : null;
  }, { timeoutMs: 30000 });
  check('step 4b: a human attaches to the live session — attach gives a second client',
    !!attached, `${JSON.stringify(listSessions())} · attach pane: ${JSON.stringify(listSessions({ server: 'promptobus-launch' }))}`);
  tmux(['kill-session', '-t', seat], { server: 'promptobus-launch' });
  const leftSeat = await waitFor(() => {
    const s = listSessions().find((x) => x.name === record?.sessionName);
    return s && s.attached === 0 ? s : null;
  }, { timeoutMs: 30000 });
  check('step 4b: the human left, and the session stayed alive — it outlives its clients',
    !!leftSeat, JSON.stringify(listSessions()));
  at_('human attach and leave', Date.now() - t4b);

  // --- step 4c: delivery DURING a turn --------------------------------------------------
  //
  // The gap with Claude Code narrowed to "waits for the end of the turn": the
  // text queues in the session and is executed as a separate turn right after
  // the current one. This is checked by two deliveries in a row — the second
  // leaves while the first turn is going — and by the process not changing for
  // both.
  const t4c = Date.now();
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
  const busy = await waitFor(() => (cursorDriver.inspect(ref)?.busy ? cursorDriver.inspect(ref) : null),
    { timeoutMs: 60000 });
  check('step 4c: the participant turn started — there is something to deliver into', !!busy, JSON.stringify(cursorDriver.inspect(ref)));
  store.sendMessage(home, TASK, {
    from: 'orchestrator', to: WORKER, type: 'answer',
    body: `Second of a pair, arrived during a turn. Reply to the orchestrator with a result whose body starts with the line «${MARK.pairB}».`,
  });
  const second = await cursorDriver.activate({ ref }, {
    kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
  });
  check('step 4c: delivery into a GOING turn succeeds, and is not refused as "turn in progress"',
    second?.ok === true, `${JSON.stringify(second)} · ${JSON.stringify(cursorDriver.inspect(ref))}`);
  const pairA = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => m.type === 'result' && String(m.body ?? '').trimStart().startsWith(MARK.pairA)) ?? null,
  { timeoutMs: 300000 });
  const pairB = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => m.type === 'result' && String(m.body ?? '').trimStart().startsWith(MARK.pairB)) ?? null,
  { timeoutMs: 300000 });
  check('step 4c: both messages were handled — the second on the next turn, without a new process',
    !!pairA && !!pairB && readSession(ref)?.panePid === paneWas,
    `${JSON.stringify(pairA)} · ${JSON.stringify(pairB)} · pane ${paneWas} → ${readSession(ref)?.panePid}`);
  at_('pair of messages in a row', Date.now() - t4c);

  // --- step 4d: a race of two injections ------------------------------------------------------
  //
  // Open question 4 of the spike report: what happens if two writers write into
  // one session. The mechanism answer is a lock on injection: a session has one
  // writer, otherwise the second text would land in the input field on top of
  // the first, between its paste and Enter, and one glued message would go into
  // the transcript.
  const race = await Promise.all([1, 2].map(() => cursorDriver.activate({ ref }, {
    kind: 'unread', task: TASK, address: WORKER, unread: 1, messages: [],
  })));
  check('step 4d: two injections at once — one delivered, the other refused by the lock',
    race.filter((r) => r.ok).length === 1 && /already writing/.test(String(race.find((r) => !r.ok)?.error)),
    JSON.stringify(race));

  // --- step 5: a Cursor reviewer and its read-only ----------------------------------------
  const t5 = Date.now();
  const wt = wp?.metadata?.worktree ?? repoAbs;
  writeFileSync(path.join(wt, 'live-note.md'), `# ${MARK.hello}\n\nПравка для предмета ревью.\n`);
  spawnSync('git', ['-C', wt, '-c', 'user.name=live', '-c', 'user.email=live@example.invalid', 'add', '-A'], { encoding: 'utf8' });
  spawnSync('git', ['-C', wt, '-c', 'user.name=live', '-c', 'user.email=live@example.invalid', 'commit', '-m', 'live: предмет ревью'], { encoding: 'utf8' });

  const reviewed = cli([ 'review', wt, '--task', TASK, '--harness', 'cursor', '--model', MODEL],
    { cwd: ws, env });
  check('step 5: promptobus review --harness cursor raised a live reviewer',
    reviewed.status === 0 && /reviewer reviewer:live поднят/.test(reviewed.out), reviewed.out.slice(-600));
  sandboxDir = reviewSandbox(store.participantSettingsPath(home, TASK, REVIEWER));
  check('step 5: the reviewer sandbox is a git directory with its own deny',
    existsSync(path.join(sandboxDir, '.git'))
    && /Write\(\*\*\)/.test(readFileSync(path.join(sandboxDir, '.cursor', 'cli.json'), 'utf8')),
    sandboxDir);

  // Read-only is checked by ITS OWN config and a separate turn: the review
  // prompt does not ask for edits, and the guarantee must hold on the config,
  // not on the model's obedience.
  const probe = path.join(wt, 'PWNED.txt');
  // Without `--mode plan` on purpose: in plan mode the model does not try to
  // write at all, and the mode would hold the guarantee, not the config. The
  // subject is `deny` in the sandbox `.cursor/cli.json`, the one the reviewer
  // read-only stands on.
  // The probe goes PAST the driver, so it takes the session marker and cleanup
  // of its own orphan itself: there is nobody left to collect this turn's
  // `worker-server`.
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

  const reviewSaid = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .filter((m) => m.type === 'result' && !String(m.body ?? '').includes(MARK.woke)).pop() ?? null,
  { timeoutMs: 300000 });
  check('step 5: the Cursor reviewer report reached the orchestrator on the same bus',
    !!reviewSaid, JSON.stringify(readSession(store.participantOf(store.readTask(home, TASK), REVIEWER)?.sessionRef ?? '')?.last));
  rememberTranscript(REVIEWER);
  at_('review', Date.now() - t5);

  // --- step 6: stop and cleanup --------------------------------------------------------
  const t6 = Date.now();
  const done = cli([ 'done', '--task', TASK], { cwd: ws, env });
  check('step 6: promptobus done closed the task and stopped the Cursor participants',
    done.status === 0, done.out.slice(-600));
  check('step 6: no session records left in the mechanism registry',
    cursorDriver.inspect(ref)?.state === 'gone' && !existsSync(sandboxDir),
    `${JSON.stringify(cursorDriver.inspect(ref))} · ${sandboxDir}`);
  // No mechanism sessions left on the shared server — and person sessions, if
  // they were there, are intact: teardown goes by the participant record, not
  // by "everything that was found".
  const leftSessions = listSessions().filter((s) => !sessionsBefore.has(s.name));
  check('step 6: no persist sessions of the run left on the tmux server, foreign ones untouched',
    leftSessions.length === 0 && [...sessionsBefore].every((n) => listSessions().some((s) => s.name === n)),
    `left: ${JSON.stringify(leftSessions)} · was: ${[...sessionsBefore].join(', ') || 'none'}`);
  const persistOut = spawnSync(tool.path, ['persist', 'list'], { encoding: 'utf8' });
  check('step 6: agent persist list does not show the run — the list is clean for the person',
    !String(persistOut.stdout ?? '').includes(TASK) && !String(persistOut.stdout ?? '').includes((record?.sessionName || 'no-name')),
    String(persistOut.stdout ?? '').slice(-400));
  at_('stop and cleanup', Date.now() - t6);
} catch (e) {
  check('the run reached the end without a break', false, e.stack ?? e.message);
} finally {
  rememberProbeMarks();
  // Turn logs are taken FIRST and on any outcome (review note): teardown sweeps
  // them with the session record, and the stream is needed exactly where the
  // run went red. Copying on the happy path would leave diagnostics only on a
  // green run.
  keepTranscripts();
  // Cleanup runs on any outcome: a fallen run must leave neither processes nor
  // directories. Stop is by its own driver, with a zero wait: the script does
  // not sit out timers.
  for (const addr of [WORKER, REVIEWER]) {
    const left = store.participantOf(store.readTask(home, TASK), addr)?.sessionRef;
    if (left) await Promise.resolve(cursorDriver.stop(left, { timeoutMs: 0 })).catch(() => {});
  }
  try {
    process.kill(-warden.pid, 'SIGTERM');
  } catch {
    // No group, or the process already exited.
  }
  rmSync(SB, { recursive: true, force: true });
}

// Run processes — those whose argv/cwd/environment contain THIS run directory
// (`SB` / `ws`) or a participant session marker of the run. The directory
// `~/legacy/cursor/sessions/` is shared by every persist session of the
// mechanism on the machine: the live run of 2026-09-03 (30/31 in 119 s,
// `cursor-grok-4.6-xhigh-fast`) went red on pid 27785, 35039, 36372
// (`…/cursor-agent/versions/2026.09.02-c22c1a3/node … index.js`, start 21:10:21
// / 21:10:37 / 21:10:44) — persist sessions of three run workers, raised an
// hour before the run, not processes of the run. Foreign processes of the same
// commands do not paint the verdict — like the Claude canary,
// "outside the run directory: N (not ours)".
const ps = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
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
check('no run processes left after the loop', ours.length === 0, ours.join(' | '));
if (foreign.length) {
  process.stdout.write(`  · processes of the same commands outside the run directory: ${foreign.length} (not ours)\n`);
}

const stateLeft = snapshotState().filter((n) => !stateBefore.includes(n))
  .map((n) => path.join(STATE_HOME, 'sessions', n));
check('after the loop the mechanism session registry is empty — records were dropped by stop',
  stateLeft.length === 0, stateLeft.join(' | '));

const after = snapshotHome();
const newChats = [...after.chats].filter((n) => !before.chats.has(n));
const newProjects = [...after.projects].filter((n) => !before.projects.has(n));

const passed = verdicts.filter((v) => v.ok).length;
process.stdout.write(`\n${passed}/${verdicts.length} verdicts passed\n`);
process.stdout.write(`durations: ${times.join(' · ')} · total ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
process.stdout.write(`binary: ${tool.path}${tool.version ? ` (${tool.version})` : ''} · model: ${MODEL}\n`);
// Entries in the person home are named by name: Cursor itself makes them, and
// the one who drove the run must know about them.
// The logs directory is swept by the same module as the canary directories:
// the three newest stay, nothing younger than an hour is removed. The trouble
// is the same — pile-up in a shared `$TMPDIR` — and it is healed by shared
// code, not a second copy of the thresholds.
const sweptLogs = sweepPreviousRuns(tmpdir(), { prefix: LOGS_PREFIX, current: KEPT_LOGS });
if (sweptLogs.length) process.stdout.write(`previous-run logs swept (${sweptLogs.length}): ${sweptLogs.join(', ')}\n`);
// The line is printed BY FACT: there may be no logs at all — the run broke
// before the first turn — and promising a directory that is not there means
// sending a person into a void.
process.stdout.write(existsSync(KEPT_LOGS)
  ? `run turn logs: ${KEPT_LOGS}\n`
  : 'no run turn logs — the first turn was never reached\n');
process.stdout.write(`entries in ${CURSOR_HOME}: new chat directories ${newChats.length}`
  + `${newChats.length ? ` (${newChats.map((n) => path.join(CURSOR_HOME, 'chats', n)).join(', ')})` : ''}`
  + `; new project entries ${newProjects.length}`
  + `${newProjects.length ? ` (${newProjects.map((n) => path.join(CURSOR_HOME, 'projects', n)).join(', ')})` : ''}\n`);
process.exitCode = passed === verdicts.length ? 0 : 1;

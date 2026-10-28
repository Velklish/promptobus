// Mixed live script on isolated stubs: catalog refusal, awaited abort and a slow stop.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { proveStandIsolation, STUB_BIN } from '../scripts/live-entry.mjs';
import { makeSandbox } from './sandbox.mjs';
import * as cursorStub from './harness-cursor.mjs';
import * as codexStub from './harness-codex.mjs';
import { store } from './scenario.mjs';
import { waitFor } from './harness.mjs';
import * as cursorSession from '../lib/cursor-persist.js';
import * as codexSession from '../lib/codex-session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'live-mixed.mjs');
const WORKER = 'worker:live';
const REVIEWER = 'reviewer:live';
const SB = makeSandbox('promptobus-promptobus-live-mixed-stand-');
const binDir = path.join(SB, 'bin');
// The stand homes stay OUTSIDE the file sandbox: its exit hook removes the directory before
// the stands have killed their panes and holders (the mixed suite file does the same).
const cursorHarness = await cursorStub.installHarness({ binDir });
const codexHarness = await codexStub.installHarness({ binDir });

function start(args = [], env = {}) {
  const proved = proveStandIsolation({
    binDir,
    names: ['agent', 'cursor', 'cursor-agent', { name: 'tmux', probe: ['-V'] }, 'codex'],
    homes: {
      [cursorStub.CURSOR_HOME_VAR]: cursorHarness.home,
      PROMPTOBUS_CURSOR_HOME: cursorHarness.stateHome,
      PROMPTOBUS_CURSOR_USER_HOME: cursorHarness.userHome,
      [codexStub.CODEX_HOME_VAR]: codexHarness.home,
      PROMPTOBUS_CODEX_HOME: codexHarness.stateHome,
    },
    env: process.env,
  });
  if (!proved.ok) throw new Error(`stub isolation refused: ${proved.reason}`);
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env, [STUB_BIN]: binDir },
  });
  const run = { child, out: '', exit: null };
  child.stdout.on('data', (c) => { run.out += c; });
  child.stderr.on('data', (c) => { run.out += c; });
  run.done = new Promise((resolve) => child.on('close', (code, signal) => { run.exit = { code, signal }; resolve(run.exit); }));
  return run;
}

const line = (out, re) => re.exec(out)?.[1] ?? null;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const pidAlive = codexStub.pidAlive;
// A listing that cannot be read is empty: the stand creates its sessions directory only with
// the first session, and an unborn one is exactly the "raised nothing" this file checks.
const listing = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// The worker plays its hello turn and nothing else: the run needs its result and the reviewer.
// Two identical turns — each raised session consumes one, and a run may raise more.
const HELLO_TURN = { do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: 'LIVE-MIXED-HELLO\nstand worker first turn' } }] };
cursorStub.planParticipant(cursorHarness.home, WORKER, { turns: [HELLO_TURN, HELLO_TURN] });
codexStub.planParticipant(codexHarness.home, REVIEWER, {
  turns: [{ do: [{ tool: 'promptobus_mailbox' }] }],
});

// --- a reviewer model the catalog does not know: refused before the worker is raised ----------

const refused = start(['--codex-model', 'no-such-stand-model']);
const refusedExit = await Promise.race([refused.done, sleep(30000).then(() => null)]);
check('preflight: an unknown --codex-model refuses the run before the worker is raised',
  refusedExit?.code === 1 && refused.out.includes('✖ live run not started:')
  && refused.out.includes('no-such-stand-model') && refused.out.includes('codex debug models'),
  `${JSON.stringify(refusedExit)} · ${refused.out.slice(-600)}`);
check('preflight: the refusal raised no worker, no reviewer and no sandbox',
  !/^▸ sandbox: /m.test(refused.out) && listing(cursorSession.sessionsDir()).length === 0
  && listing(path.join(codexHarness.home, 'threads')).length === 0,
  `sandbox line ${/^▸ sandbox: /m.test(refused.out)}`
  + ` · cursor ${listing(cursorSession.sessionsDir()).join(', ')}`
  + ` · threads ${listing(path.join(codexHarness.home, 'threads')).join(', ')}`);
if (!refusedExit) {
  refused.child.kill('SIGTERM');
  await refused.done;
}

// --- a cut-off run after both participants are up ----------------------------------------------

const cut = start();
const bothUp = await waitFor(() => (/✔ step 4: the reviewer thread landed in the Codex registry/.test(cut.out) ? true : null), { timeoutMs: 180000 });
const sandbox = line(cut.out, /^▸ sandbox: (\S+) ·/m);
const storeHome = line(cut.out, /^▸ sandbox: \S+ · store: (\S+)$/m);
const task = line(cut.out, /^▸ task: (\S+)$/m);
const taskView = bothUp && storeHome && task ? store.readTask(storeHome, task) : null;
const workerRef = taskView ? store.participantOf(taskView, WORKER)?.sessionRef ?? '' : '';
const reviewerRef = taskView ? store.participantOf(taskView, REVIEWER)?.sessionRef ?? '' : '';
const workerRecord = workerRef ? cursorSession.readSession(workerRef) : null;
const workerPid = workerRecord?.sessionName
  ? cursorSession.findSession(workerRecord.sessionName, { server: workerRecord.tmuxServer || cursorSession.CURSOR_TMUX_SERVER })?.panePid ?? null
  : null;
const reviewerRecord = reviewerRef && sandbox
  ? codexSession.readSession(reviewerRef, { PROMPTOBUS_CODEX_HOME: path.join(sandbox, 'codex-state') })
  : null;
const reviewerPids = [reviewerRecord?.holderPid, reviewerRecord?.appPid].filter(Number.isInteger);
check('cut: before the signal both participants are up — the worker pane and the reviewer holder are alive',
  !!bothUp && !!sandbox && !!storeHome && !!task && !!workerRef && !!reviewerRef
  && Number.isInteger(workerPid) && pidAlive(workerPid)
  && reviewerPids.length === 2 && reviewerPids.every(pidAlive),
  `${cut.out.slice(-800)} · workerRef ${workerRef} pane ${workerPid}`
  + ` · reviewerRef ${reviewerRef} ${JSON.stringify(reviewerPids)}`);

cut.child.kill('SIGTERM');
const exit = await Promise.race([cut.done, sleep(30000).then(() => null)]);
// Stop results and liveness come from the child before teardown; parent PID reads are delayed.
const stopNoteOf = (out, who, ref) => (out.split('\n').find((l) => l.startsWith(`  · stop returned for the ${who} ${ref}: `)) ?? '')
  .slice(`  · stop returned for the ${who} ${ref}: `.length);
const workerNote = stopNoteOf(cut.out, 'Cursor worker', workerRef);
const reviewerNote = stopNoteOf(cut.out, 'Codex reviewer', reviewerRef);
check('abort: SIGTERM ends the run through its cleanup — exit 143 and the cut-off line',
  exit?.code === 143 && /run cut off by SIGTERM/.test(cut.out), `${JSON.stringify(exit)} · ${cut.out.slice(-600)}`);
check('abort: each stop note is its own participant\'s — the worker\'s line and the reviewer\'s line each carry their own success',
  /persist session \S+ stopped, record dropped|session \S+ closed — the persist session was already gone, record dropped/.test(workerNote)
  && /thread \S+ stopped, the record dropped|session \S+ closed — the holder was already gone, the record dropped/.test(reviewerNote),
  `worker «${workerNote}» · reviewer «${reviewerNote}»`);
const preExit = JSON.parse(line(cut.out, /^ {2}· pre-exit: (.+)$/m) ?? 'null');
check('abort: the child sampled its own participants before teardown — matching sandbox, PIDs and successful stops',
  preExit?.sandbox === sandbox && preExit?.sandboxPresent === true
  && preExit.worker.ref === workerRef && preExit.reviewer.ref === reviewerRef
  && JSON.stringify(preExit.worker.pids) === JSON.stringify([workerPid])
  && JSON.stringify(preExit.reviewer.pids) === JSON.stringify(reviewerPids) && reviewerPids.length === 2
  && preExit.worker.alive.every((alive) => alive === false) && preExit.reviewer.alive.every((alive) => alive === false)
  && preExit.worker.stop?.ok === true && preExit.worker.stop?.stopped === true
  && preExit.reviewer.stop?.ok === true && preExit.reviewer.stop?.stopped === true,
  JSON.stringify({ preExit, sandbox, workerPid, reviewerPids }));
// Delay the parent's PID read past the record watch; only the child's sample proves stop.
await sleep(6000);
const workerGoneLate = Number.isInteger(workerPid) && !pidAlive(workerPid);
const reviewerGoneLate = reviewerPids.length === 2 && reviewerPids.every((p) => !pidAlive(p));
check('abort: after the holder\'s record watch the parent sees the same — insurance, the verdict was the child\'s pre-exit sample',
  workerGoneLate && reviewerGoneLate && !existsSync(sandbox),
  `worker ${workerGoneLate} · reviewer ${reviewerGoneLate}`
  + ` · sandbox ${sandbox ? (existsSync(sandbox) ? 'still there' : 'swept') : '(not parsed)'}`);

// Insurance, not a verdict: a fallen run leaves neither processes nor directories behind.
const warden = storeHome && task ? store.liveWarden(storeHome, task) : null;
if (warden?.pid) {
  try { process.kill(-warden.pid, 'SIGKILL'); } catch { /* already gone */ }
}
for (const pid of [workerPid, ...reviewerPids]) {
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
if (sandbox && existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
if (!exit) cut.child.kill('SIGKILL');

// --- a cut-off run whose worker's `persist stop` outlasts every budget -----------------------------
// The stub stop outlasts the budget; reviewer and warden must still receive cleanup.

const hang = start([], { [cursorStub.STOP_HANG_VAR]: '60000' });
const hangBothUp = await waitFor(() => (/✔ step 4: the reviewer thread landed in the Codex registry/.test(hang.out) ? true : null), { timeoutMs: 180000 });
const hangSandbox = line(hang.out, /^▸ sandbox: (\S+) ·/m);
const hangStoreHome = line(hang.out, /^▸ sandbox: \S+ · store: (\S+)$/m);
const hangTask = line(hang.out, /^▸ task: (\S+)$/m);
const hangView = hangBothUp && hangStoreHome && hangTask ? store.readTask(hangStoreHome, hangTask) : null;
const hangWorkerRef = hangView ? store.participantOf(hangView, WORKER)?.sessionRef ?? '' : '';
const hangReviewerRef = hangView ? store.participantOf(hangView, REVIEWER)?.sessionRef ?? '' : '';
const hangWorkerRecord = hangWorkerRef ? cursorSession.readSession(hangWorkerRef) : null;
const hangWorkerPid = hangWorkerRecord?.sessionName
  ? cursorSession.findSession(hangWorkerRecord.sessionName, { server: hangWorkerRecord.tmuxServer || cursorSession.CURSOR_TMUX_SERVER })?.panePid ?? null
  : null;
const hangReviewerRecord = hangReviewerRef && hangSandbox
  ? codexSession.readSession(hangReviewerRef, { PROMPTOBUS_CODEX_HOME: path.join(hangSandbox, 'codex-state') })
  : null;
const hangReviewerPids = [hangReviewerRecord?.holderPid, hangReviewerRecord?.appPid].filter(Number.isInteger);
check('hang: before the signal both participants are up — the worker\'s stop command is set to outlast the budget',
  !!hangBothUp && !!hangWorkerRef && !!hangReviewerRef
  && Number.isInteger(hangWorkerPid) && pidAlive(hangWorkerPid)
  && hangReviewerPids.length === 2 && hangReviewerPids.every(pidAlive),
  `${hang.out.slice(-500)} · worker ${hangWorkerRef} pane ${hangWorkerPid} · reviewer ${hangReviewerRef} ${JSON.stringify(hangReviewerPids)}`);

const hangKilledAt = Date.now();
hang.child.kill('SIGTERM');
const hangExit = await Promise.race([hang.done, new Promise((resolve) => {
  setTimeout(() => resolve(null), 120000).unref();
})]);
const hangElapsed = Date.now() - hangKilledAt;
const hangPreExit = JSON.parse(line(hang.out, /^ {2}· pre-exit: (.+)$/m) ?? 'null');
const hangStops = hang.out.split('\n').filter((l) => l.includes('stop returned') || l.includes('task warden') || l.startsWith('▸ run cut off')).join(' | ');
check('hang: SIGTERM ends the hung-stop run through its cleanup — exit 143 and the cut-off line',
  hangExit?.code === 143 && /run cut off by SIGTERM/.test(hang.out), `${JSON.stringify(hangExit)} · ${hang.out.slice(-500)}`);
check('hang: a persist stop that outlasts the budget is cut off at it — the run ends inside the awaited-cleanup bound, not at the command\'s minute',
  !!hangExit && hangElapsed < 10_000,
  `elapsed ${hangElapsed} ms — the shared stop budget is 5 s with a 5 s test allowance, the harness command sleeps 60 s · ${hangStops}`);
check('hang: both participants\' stops and the warden\'s were still attempted inside that budget',
  hang.out.includes(`  · stop returned for the Cursor worker ${hangWorkerRef}: `)
  && hang.out.includes(`  · stop returned for the Codex reviewer ${hangReviewerRef}: `)
  && hang.out.includes('  · task warden stopped by its process group')
  && hangPreExit?.sandboxPresent === true && hangPreExit.elapsedMs < 10_000
  && hangPreExit.worker.ref === hangWorkerRef && hangPreExit.reviewer.ref === hangReviewerRef,
  hangStops || hang.out.slice(-500));

if (!hangExit) hang.child.kill('SIGKILL');
const hangWarden = hangStoreHome && hangTask ? store.liveWarden(hangStoreHome, hangTask) : null;
if (hangWarden?.pid) {
  try { process.kill(-hangWarden.pid, 'SIGKILL'); } catch { /* already gone */ }
}
for (const pid of [hangWorkerPid, ...hangReviewerPids]) {
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}
if (hangSandbox && existsSync(hangSandbox)) rmSync(hangSandbox, { recursive: true, force: true });


// Teardown order is the reverse of install: the restored PATH of the first stand would take
// the second stand's directory with it (the mixed suite file says why).
codexHarness.restore();
cursorHarness.restore();
rmSync(SB, { recursive: true, force: true });

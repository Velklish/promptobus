#!/usr/bin/env node
// Bus canary: the SAME E2E scenario, but on real Claude Code. Run:
//
//   node scripts/live-e2e.mjs
//
// Not in `npm test` and will not be: it raises live sessions, costs tokens and
// depends on the machine. The subject is the same as the stub run
// ([promptobus-e2e.test.mjs](../test/promptobus-e2e.test.mjs)), and the scenario is
// literally the same module ([scenario.mjs](../test/scenario.mjs)): two harnesses
// differ, not two checks. They have nowhere to drift — the checks live in the shared
// module, and a scenario edit goes into both runs at once.
//
// What is different here:
//
// - the binary is real. There is no PATH substitution at all, `--bg` raises a live
//   background session, and `stop` tears it down;
// - role turns are set by the BRIEF, not by a script file: each turn's `say` goes
//   into the participant prompt ("fetch the mailbox, reply with the line …"). So the
//   scenario checks by marker containment, not by a verbatim body: a letter-for-letter
//   check would test the model's obedience;
// - model `sonnet`, effort `low`: the canary checks the bus loop, not answer quality.
//
// The report is verdicts and step durations. It has no tokens: the orchestrator socket
// listener puts only the "token matched" mark into the trace, not the token itself.
import { mkdtempSync } from 'node:fs';
import { finishLiveArgs, parseLiveArgs } from './live-args.mjs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { resolveToolBin } from '../test/sandbox.mjs';
import { pidAlive } from '../test/harness.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { MECHANISM_ROOT, runScenario, STEPS } from '../test/scenario.mjs';
import { liveRun, onAbort, parseLiveSessions, priorRunIsLive } from './live-run.mjs';
import { sweepPreviousRuns, sweptLine } from './canary-runs.mjs';

finishLiveArgs(parseLiveArgs(process.argv.slice(2)), {
  usage: 'scripts/live-e2e.mjs',
  purpose: 'run the E2E bus scenario on real Claude Code',
  price: 'raises two live Claude Code sessions and spends the account limit',
});

// The mechanism under test is one root for the whole run, and the scenario declares
// it (`PROMPTOBUS_E2E_ROOT`). Unset — the checkout, as before. Set — the installed
// tree, and then THIS script must take ITS own modules from there too: a half resolve
// would raise sessions with one mechanism and judge them with another.
const { bgSessions, findSession, resetBgSessionsCache, runClaude, sessionLiveness } = await import(path.join(MECHANISM_ROOT, 'lib', 'liftoff.js'));

// `resolveToolBin` searches PATH only and returns the name it probed. `ok` means
// `claude` already answers through PATH, so leave PATH unchanged for the session
// registry and every child command.
const tool = resolveToolBin('claude');
if (!tool.ok) {
  console.error(`✖ nothing to drive the live run with: ${tool.reason}`);
  process.exit(1);
}
resetBgSessionsCache();

// Warden auto-start is off on purpose: the scenario raises it itself and stops it
// itself, and a detached process raised by a side command would outlive the canary
// and keep knocking its sockets. The same argument as the shared suite hygiene list
// (`hygiene.mjs`).
process.env.PROMPTOBUS_WARDEN = 'off';

// **Session identity is stripped from THIS environment, not only from the child's.**
// The scenario builds command environments from `process.env`, and this run is
// usually driven from a session that has all five variables set: the release
// checklist says to run the canary before the tag, and in runs the workers drive it.
// A leaked `PROMPTOBUS_TASK` sends sandbox commands onto a LIVE run task (live
// measurement 2026-09-03: red step 4, "the run task is not in the sandbox"), and
// `PROMPTOBUS_HOME` — into the workspace's live bus journal. The list is the same
// and from the same home as the suite; the scenario creates its own
// `CLAUDE_CODE_MESSAGING_*` again, already with the stand socket. Home and
// `CLAUDE_CONFIG_DIR` are not touched: the run is live, and real `claude` needs its
// real home.
const leaked = SESSION_LEAK_VARS.filter((name) => name in process.env);
dropSessionLeaks(process.env);

const RUN_PREFIX = 'promptobus-live-e2e-';
const SB = mkdtempSync(path.join(os.tmpdir(), RUN_PREFIX));
const refusedRuns = [];
const swept = sweepPreviousRuns(os.tmpdir(), {
  prefix: RUN_PREFIX, current: SB, refused: refusedRuns, keep: 0,
  isLive: priorRunIsLive, held: refusedRuns,
});
process.stdout.write(`${sweptLine('previous-run sandboxes', swept, { keep: 0 })}\n`);
if (refusedRuns.length) process.stdout.write(`sweep refused (busy or foreign permissions): ${refusedRuns.join(', ')}\n`);
function makeSockDir(prefix) {
  const dir = process.platform === 'win32' ? null : mkdtempSync(path.join('/tmp', prefix));
  return { dir, sock: (name) => dir ? path.join(dir, `${name}.sock`)
    : `\\\\.\\pipe\\${prefix}${process.pid}-${name}` };
}
const { dir: sockDir, sock } = makeSockDir('a2l-');
const run = liveRun({ sandbox: SB, socketDir: sockDir,
  readSessions: () => {
    const { r, missing } = runClaude(['agents', '--json']);
    if (missing) throw new Error('Claude session registry unavailable');
    return parseLiveSessions(r);
  },
  stopSession: (sessionId, id) => {
    const { r, missing } = runClaude(['stop', id]);
    return { ok: !missing && !r?.error && r?.status === 0, attempted: true };
  },
});
let cleanupResult = null;
const cleanup = async () => {
  cleanupResult = await run.cleanup();
  return cleanupResult;
};
const disposeAbort = onAbort(async (signal) => {
  const result = await cleanup();
  process.stdout.write(`▸ aborted (${signal}): ${JSON.stringify(result)}\n`);
});

const harness = {
  label: 'live',
  // Turns are set by the brief, not by a script: there is no way to play a stop on
  // a permission request or on a limit of a live session on command, and the canary
  // does not take the steps that need that.
  // The participant loop-guard verdict lives here too: the hook sits in the
  // workspace settings, and the participant cwd is in the clone worktree, so the
  // harness decides whether the hook is delivered.
  scripted: false,
  sock,
  // The canary checks the loop, not the reasoning: a cheap model and low effort.
  spawnFlags: ['--model', 'sonnet', '--effort', 'low'],
  reviewFlags: ['--model', 'sonnet', '--effort', 'low'],
  // Live role turns are set by the brief the scenario already built from the same
  // scripts — there is nothing to write to disk here.
  plan: () => {},
  sessions: () => {
    resetBgSessionsCache();
    return bgSessions({ fresh: true }) ?? [];
  },
  liveSessions: (refs) => {
    resetBgSessionsCache();
    const list = bgSessions({ fresh: true });
    if (list === null) return [];
    return refs.map((ref) => {
      const hit = findSession(list, ref);
      run.assertRunning();
      run.captureSessions();
      return hit && sessionLiveness(hit, list) === 'alive' ? hit : null;
    }).filter(Boolean);
  },
  // Session process ids are taken BEFORE teardown: after `claude stop` the record
  // vanishes from the list, and a "no processes left" verdict from the list would
  // be green by construction.
  pidsOf: (refs) => {
    const list = bgSessions({ fresh: true }) ?? [];
    return refs.map((ref) => findSession(list, ref)?.pid).filter((pid) => Number.isInteger(pid));
  },
  pidAlive,
  diagnose: (address) => {
    const list = bgSessions({ fresh: true }) ?? [];
    return `harness sessions: ${JSON.stringify(list.map((s) => ({ name: s.name, status: s.status, state: s.state })))}`
      + ` · participant ${address}`;
  },
  start: run.start,
  child: run.child,
  resource: run.resource,
  assertRunning: run.assertRunning,
  captureSessions: run.captureSessions,
  cleanup,
};


const verdicts = [];
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  verdicts.push({ name, ok, detail: ok ? '' : String(detail).slice(0, 500) });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 500)}`}\n`);
};

// The caller prepares the workspace when it has one: the canary feeds a workspace
// LAID OUT by `sync` of the installed tarball, and the stand must go there, not
// into a stub beside it. No variable — the stand builds its own, as before.
const WS = process.env.PROMPTOBUS_E2E_WORKSPACE || null;

process.stdout.write(`▸ live E2E run: ${tool.path}${tool.version ? ` (${tool.version})` : ''}\n`);
process.stdout.write(`▸ mechanism: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ ${STEPS.length} steps, sandbox ${SB}${WS ? `, workspace ${WS}` : ''}\n`);
if (leaked.length) process.stdout.write(`▸ stripped from the run environment: ${leaked.join(', ')}\n`);

let report = null;
let failure = null;
try {
  // Ceilings are an order of magnitude above the stub ones: a live session thinks
  // for seconds and tens of seconds, and a stall report still waits for a warden
  // heartbeat.
  report = await runScenario({
    check,
    harness,
    sandbox: SB,
    workspace: WS,
    timeouts: { step: 300000, stall: 300000 },
    trace: (line) => process.stdout.write(`  · ${line}\n`),
  });
} catch (e) {
  failure = e;
} finally {
  await cleanup();
  disposeAbort();
}

const passed = verdicts.filter((v) => v.ok).length;
process.stdout.write(`\n${passed}/${verdicts.length} verdicts passed\n`);
if (report) {
  process.stdout.write(`durations: ${report.timings.map((t) => `${t.name} ${(t.ms / 1000).toFixed(1)} s`).join(' · ')}\n`);
  process.stdout.write(`total ${(report.totalMs / 1000).toFixed(1)} s\n`);
  // Line for the caller: which binary the run used, by the word of the raised
  // process itself. The canary checks it against its install tree — the scenario
  // has no way to know where "right" is.
  process.stdout.write(`mechanism as the process said: ${report.mechanism.reported ?? 'unnamed'}\n`);
}
if (failure) {
  process.stdout.write(`✖ run broken: ${failure.message}\n`);
}
process.stdout.write(`▸ cleanup: ${JSON.stringify(cleanupResult)}\n`);
process.exitCode = passed === verdicts.length && !failure && cleanupResult?.safe ? 0 : 1;

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
import { rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { makeSandbox, makeSockDir, resolveToolBin } from '../test/sandbox.mjs';
import { pidAlive } from '../test/harness.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { MECHANISM_ROOT, runScenario, STEPS } from '../test/scenario.mjs';

// The mechanism under test is one root for the whole run, and the scenario declares
// it (`PROMPTOBUS_E2E_ROOT`). Unset — the checkout, as before. Set — the installed
// tree, and then THIS script must take ITS own modules from there too: a half resolve
// would raise sessions with one mechanism and judge them with another.
const { bgSessions, findSession, resetBgSessionsCache, sessionLiveness } = await import(path.join(MECHANISM_ROOT, 'lib', 'liftoff.js'));
const { claudeDriver } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-claude.js'));

// The binary is found with the same resolve spawn uses — including `~/.local/bin`.
// But the session registry (`bgSessions`) calls `claude` through PATH, so a directory
// found outside PATH is prepended: otherwise half the run would see the binary and
// half would not.
const tool = resolveToolBin('claude');
if (!tool.ok) {
  console.error(`✖ nothing to drive the live run with: ${tool.reason}`);
  process.exit(1);
}
const binDir = path.dirname(tool.path);
if (!(process.env.PATH ?? '').split(path.delimiter).includes(binDir)) {
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
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

const SB = makeSandbox('promptobus-live-e2e-');
// The run socket directory is its own, and it is removed in `finally` with the
// sandbox. The exit hook in [sandbox.mjs](../test/sandbox.mjs) removes it too, but
// only on its own process: a loop cut off mid-file never reaches the end, and
// cleanup must run on any outcome. The directory is taken from the helper itself,
// not derived from the path builder: on win32 the builder returns a channel name
// and there is no directory at all — `dir` comes `null`, and there is nothing to
// sweep.
const { dir: sockDir, sock } = makeSockDir('a2l-');
const raised = new Set();

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
      if (hit) raised.add(ref);
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
  // Canary cleanup: everything it raised is stopped by its own driver. `promptobus
  // done` in the scenario does this itself, but the canary must also tidy up after
  // a fallen run.
  cleanup: () => {
    for (const ref of raised) {
      // The stop outcome is a promise: the command itself goes to the binary
      // synchronously, and all that remains is waiting for the record to vanish
      // from the registry. That is enough for the fallen-run safety net, and
      // there is nothing to wait for here — the scenario calls cleanup from its
      // `finally`, without `await`. The wait is therefore lifted to ZERO (review
      // note): with the default ceiling a broken run would sit through up to ten
      // seconds of timers per session after the report — the script exits through
      // `process.exitCode`, not `exit`.
      Promise.resolve(claudeDriver.stop(ref, { timeoutMs: 0 })).catch(() => { /* nothing to stop */ });
    }
  },
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
  harness.cleanup();
  // Sandbox and socket directory — here, not after the report: the run arrives
  // here on any outcome, including a broken one. The report below reads only
  // what is already collected in memory.
  rmSync(SB, { recursive: true, force: true });
  if (sockDir) rmSync(sockDir, { recursive: true, force: true });
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
// The run removes the sandbox and the socket directory itself, in `finally`
// above: they live in system tmp, there is no runner above them. Here only the
// report line.
process.stdout.write(`▸ sandbox removed (${os.tmpdir()})${sockDir ? `, socket directory ${sockDir}` : ''}\n`);
process.exitCode = passed === verdicts.length && !failure ? 0 : 1;

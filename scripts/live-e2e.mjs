#!/usr/bin/env node
// Live Claude Code scenario; see docs/guides/contributing.md#live-harness-scenarios.
import { mkdtempSync } from 'node:fs';
import { finishLiveArgs, parseLiveArgs } from './live-args.mjs';
import { guardStubLaunch, liveRoutingEnv, refuseImportedEntry } from './live-entry.mjs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { resolveToolBin } from '../test/sandbox.mjs';
import { pidAlive } from '../test/harness.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { MECHANISM_ROOT, runScenario, STEPS } from '../test/scenario.mjs';
import { liveRun, onAbort, parseLiveSessions, priorRunIsLive } from './live-run.mjs';
import { sweepPreviousRuns, sweptLine } from './canary-runs.mjs';

refuseImportedEntry(import.meta.url);

finishLiveArgs(parseLiveArgs(process.argv.slice(2)), {
  usage: 'scripts/live-e2e.mjs',
  purpose: 'run the E2E bus scenario on real Claude Code',
  price: 'raises two live Claude Code sessions and spends the account limit',
});

// Use the selected mechanism root for imports as well as participant commands.
const { bgSessions, findSession, resetBgSessionsCache, runClaude, sessionLiveness } = await import(path.join(MECHANISM_ROOT, 'lib', 'liftoff.js'));

// The live route leaves PATH as the caller set it. A proved stub guard replaces
// PATH in live-entry.mjs before any raise, so this file does not assign PATH.
const guarded = guardStubLaunch(process.env, {
  names: ['claude'],
  homes: ['PROMPTOBUS_E2E_HARNESS', 'CLAUDE_CONFIG_DIR'],
});
if (guarded.stub && !guarded.ok) {
  console.error(`✖ live run not started: ${guarded.reason}`);
  process.exit(1);
}
const tool = guarded.stub ? guarded.tools.claude : resolveToolBin('claude');
if (!tool.ok) {
  console.error(`✖ nothing to drive the live run with: ${tool.reason}`);
  process.exit(1);
}
resetBgSessionsCache();

// The scenario owns the warden; a side command must not auto-start another one.
process.env.PROMPTOBUS_WARDEN = 'off';

// Strip bus session identity before the scenario copies this environment; keep the live harness home.
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
  // The brief drives real turns; the harness decides whether the worktree receives the loop guard.
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
  // Take PIDs before stop removes the records needed to prove process exit.
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

// A caller may supply the prepared install workspace instead of letting the stand build one.
const WS = process.env.PROMPTOBUS_E2E_WORKSPACE || null;

process.stdout.write(`▸ live E2E run: ${tool.path}${tool.version ? ` (${tool.version})` : ''}\n`);
process.stdout.write(`▸ mechanism: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ ${STEPS.length} steps, sandbox ${SB}${WS ? `, workspace ${WS}` : ''}\n`);
if (leaked.length) process.stdout.write(`▸ stripped from the run environment: ${leaked.join(', ')}\n`);

let report = null;
let failure = null;
try {
  // Live turns need larger ceilings than the stub; a stall also waits for a warden heartbeat.
  report = await runScenario({
    check,
    harness,
    sandbox: SB,
    env: liveRoutingEnv(SB),
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
  // Report the mechanism used so the canary caller can compare it with its install tree.
  process.stdout.write(`mechanism as the process said: ${report.mechanism.reported ?? 'unnamed'}\n`);
}
if (failure) {
  process.stdout.write(`✖ run broken: ${failure.message}\n`);
}
process.stdout.write(`▸ cleanup: ${JSON.stringify(cleanupResult)}\n`);
process.exitCode = passed === verdicts.length && !failure && cleanupResult?.safe ? 0 : 1;

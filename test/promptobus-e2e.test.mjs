// E2E of the bus on a stub harness. Run: npm test
//
// This file assembles the FULL orchestration loop — the one no earlier suite file had:
// spawn, the first `status`, the orchestrator reply, the warden knock on the participant
// socket, `result`, a review with remarks, a second `result`, a report of a silent end of
// turn, `promptobus done` with session teardown and cleanup, `promptobus prune`. The
// scenario itself and all of its checks live in [scenario.mjs](scenario.mjs) — the same
// module as the live run ([live-e2e.mjs](../scripts/live-e2e.mjs)); what remains here is
// exactly the harness substitution.
//
// **The file runs in a serial runner group.** It measures wall-clock time twice and both
// times for real: the knock loop goes through a unix socket between four processes, and
// the stall report is a warden heartbeat every `WARDEN_BEAT_SEC`. Under pool load those
// thresholds either go red on working code or, worse, go green on nothing.
//
// The file has one wait of its own and names it outright: the silent-end-of-turn report
// arrives on the first warden heartbeat after the turn itself, and the beat is every 30 s.
// The warden is therefore lifted as the FIRST step, before spawn — everything the scenario
// manages to do before the silent turn is subtracted from that wait.
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath } from './sandbox.mjs';
import {
  diagnoseTrace, installHarness, listSessions, pidAlive, planParticipant, readLog, stopAll,
} from './harness.mjs';
import { runScenario } from './scenario.mjs';

const SB = makeSandbox('promptobus-e2e-');
const sock = makeSockPath('a2e-');
// The harness home is created by the stand itself and outside the sandbox: otherwise
// cleanup on exit is a no-op — the sandbox hook removes the directory before the stand
// has time to kill its processes.
const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin'), sock });

// Stub harness for the scenario: the binary substitution is already in place; what remains
// is answering three questions — how the role turns are scripted, which sessions are
// alive, and what to show on a red verdict.
const harness = {
  label: 'stub',
  // Role turns are set by the script file, not the brief: that lets the scenario take
  // steps a live session cannot play on command — a stop on a permission prompt and on
  // an exhausted limit
  //, and the loop guard the stub participant calls itself.
  scripted: true,
  sock,
  // The stub binary does not read the model or the effort at all: it has no model. The
  // live run puts its own flags here — that is the whole difference between the two
  // harnesses.
  spawnFlags: [],
  reviewFlags: [],
  plan: (address, script) => planParticipant(HARNESS, address, script),
  sessions: () => listSessions(HARNESS),
  liveSessions: (refs) => listSessions(HARNESS)
    .filter((s) => refs.includes(s.name) && pidAlive(s.pid)),
  // Session pids are taken BEFORE teardown: the registry is empty after `stop`, and a
  // "no processes left" verdict from it would be green by construction (review note).
  pidsOf: (refs) => listSessions(HARNESS).filter((s) => refs.includes(s.name)).map((s) => s.pid),
  pidAlive,
  // A red verdict with no participant trail is a riddle, not a diagnosis: this is where
  // its action journal goes — scenario errors first — and the process log tail.
  diagnose: (address) => `${diagnoseTrace(HARNESS, address)}`
    + ` · logs: ${listSessions(HARNESS).map((s) => readLog(HARNESS, s.id, 6)).join(' | ')}`,
  cleanup: () => {},
};

const report = await runScenario({ check, harness, sandbox: SB, timeouts: { step: 30000, stall: 75000 } });

// Step durations are always printed: they show what in the file is waiting, and they also
// go into the task measurement. This is not a verdict — a number, not a sentence.
process.stdout.write(`  ⏱ ${report.timings.map((t) => `${t.name} ${(t.ms / 1000).toFixed(1)} s`).join(' · ')}`
  + ` · total ${(report.totalMs / 1000).toFixed(1)} s\n`);

// Insurance, not a check: the "no processes left" verdict lives in the scenario; this is
// cleanup after a fallen run, so a red file does not leave live children behind.
// The insurance must check BOTH halves: that there was nothing to kill (registry empty)
// and that nothing survived kill. `stopAll` returns only the latter, and a verdict from
// that answer alone would go green even on a full registry of live sessions (review note).
const before = listSessions(HARNESS);
const left = await stopAll(HARNESS);
check('no participant processes left after the run — there was nothing to kill',
  before.length === 0 && left.length === 0,
  `left in the registry ${JSON.stringify(before.map((s) => s.name))} · survived kill ${JSON.stringify(left)}`);
restore();

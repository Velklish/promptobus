// Mixed bus lineup on stub stands: Claude Code orchestrator, Cursor worker,
// Codex reviewer. Run: npm test
//
// Until this task each of the three drivers was checked ALONE — its own suite file and
// its own live run — and the loop always ran on one harness. Here a lineup runs for the
// first time: the worker is lifted with `--harness cursor`, the reviewer with
// `--harness codex`, and the scenario stays the same module ([scenario.mjs](scenario.mjs))
// as the stub Claude ([promptobus-e2e.test.mjs](promptobus-e2e.test.mjs)) and the canary
// ([live-e2e.mjs](../scripts/live-e2e.mjs)). The lineups differ, not the checks: there is
// nowhere for them to diverge — the assertions live in the shared module.
//
// **Two stub binaries at once are part of the subject.** The Cursor stand installs
// `agent` and `tmux`, the Codex stand installs `codex`, and both divert their homes with
// environment variables. They stack because each puts ITS binary into ONE directory and
// edits only its own variables: they share no state at all, and PATH is only extended by
// that directory. Teardown order is the reverse of install — otherwise the restored PATH
// would take the neighbour directory with it.
//
// **What this lineup does not play, and why** — not a "skipped step", but a declared
// participant capability (`participantHarness` in the scenario):
//
//   - `blocks` — a stop on a permission dialog and on an exhausted limit. The `block`
//     field in a turn is understood only by the stub `claude`
//     ([participant.mjs](participant.mjs));
//   - `stalls` — a report of a silent end of turn. It is checked by the REASON the
//     session wrote about itself in the Claude daemon `jobs/<id>/state.json`; for Cursor
//     the end of turn is brought by `turn_ended` and the `stop` hook, and there is no
//     reason string there;
//   - `files` — the participant mcp-config as a file on a store path. Cursor reads the
//     project `.cursor/mcp.json` of its workspace, Codex gets servers as a lift-request
//     field;
//   - reviewer `guard` — there are no hooks under `codex app-server` at all, and it will
//     have no end-of-turn mark on any turn. The Cursor worker has one, and the verdict
//     on it runs.
//
// **The file runs in a serial runner group** — for the same reason as its stub-Claude
// twin: the knock loop runs between processes over real sockets and tmux panes, and under
// pool load those thresholds either go red on working code or go green on nothing.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, makeSockPath, writeHostConfig } from './sandbox.mjs';
import * as cursorStub from './harness-cursor.mjs';
import * as codexStub from './harness-codex.mjs';
import { REVIEWER, runScenario, WORKER } from './scenario.mjs';
import { cursorDriver } from '../lib/driver-cursor.js';
import { codexDriver } from '../lib/driver-codex.js';
import * as cursorSession from '../lib/cursor-persist.js';
import * as codexSession from '../lib/codex-session.js';

// The sandbox prefix is from the `promptobus-promptobus` family, not a new name of its
// own: suite cleanup sweeps by a prefix list ([tmpdir-sweep.mjs](tmpdir-sweep.mjs)), the
// list is assembled by hand, and a new name would have to be written there too —
// otherwise a cut-off run directory would stay in the shared `$TMPDIR` forever.
const SB = makeSandbox('promptobus-promptobus-mixed-');
const binDir = path.join(SB, 'bin');
// The stand homes are created by the stands themselves and OUTSIDE the file sandbox:
// the sandbox hook removes its directory before the stand has time to kill its processes.
const cursorHarness = await cursorStub.installHarness({ binDir });
const codexHarness = await codexStub.installHarness({ binDir });

// The caller prepares the workspace: `--harness` refuses a tool that is not in
// `promptobus.json` — `sync` did not lay out adapters for it, and the participant would
// be left without workspace rules. The rest of the layout is built by the scenario itself.
const WS = path.join(SB, 'ws');
writeHostConfig(WS, { tools: ['claude', 'cursor', 'codex'] });

/** Pane pid of the Cursor participant — from the same registry the driver looks at. */
function cursorPid(ref) {
  const record = cursorSession.readSession(ref);
  if (!record?.sessionName) return null;
  const server = record.tmuxServer || cursorSession.CURSOR_TMUX_SERVER;
  return cursorSession.findSession(record.sessionName, { server })?.panePid ?? null;
}

/** Pid of the Codex thread holder: `app-server` holds the session, and the holder holds it. */
function codexPid(ref) {
  return codexSession.readSession(ref)?.holderPid ?? null;
}

// Liveness and busyness are asked of the participant DRIVER, not derived by a private
// field check: the Cursor and Codex registries differ (tmux server vs a records
// directory), and a home-grown rule would diverge from the one the mechanism judges by.
const alive = (driver, refs) => refs.filter((ref) => driver.inspect(ref)?.state === 'alive');
const handedOver = (driver, ref) => {
  const view = driver.inspect(ref);
  return view?.state === 'alive' && view.busy === false;
};

const worker = {
  id: cursorDriver.id,
  // Turns are set by the script file, not the brief: the stub `agent` plays them literally.
  scripted: true,
  // The loop guard calls the `stop` hook from the project `.cursor/hooks.json`, and the
  // stand fires it.
  guard: true,
  blocks: false,
  stalls: false,
  files: false,
  spawnFlags: ['--harness', 'cursor'],
  plan: (address, script) => cursorStub.planParticipant(cursorHarness.home, address, script),
  liveSessions: (refs) => alive(cursorDriver, refs),
  pidsOf: (refs) => refs.map(cursorPid).filter((pid) => Number.isInteger(pid)),
  pidAlive: cursorSession.pidAlive,
  idle: (ref) => handedOver(cursorDriver, ref),
  inspect: (ref) => cursorDriver.inspect(ref),
  // A red verdict with no participant trail is a riddle, not a diagnosis: this is where
  // its action journal goes, and the list of live stand panes.
  diagnose: (address) => `${cursorStub.diagnoseTrace(cursorHarness.home, address)}`
    + ` · tmux panes: ${JSON.stringify(cursorSession.listSessions().map((s) => [s.name, s.panePid]))}`,
};

const reviewer = {
  id: codexDriver.id,
  scripted: true,
  // Hooks under `app-server` do not run at all — the participant has nothing to call the
  // loop guard with.
  guard: false,
  blocks: false,
  stalls: false,
  files: false,
  reviewFlags: ['--harness', 'codex'],
  plan: (address, script) => codexStub.planParticipant(codexHarness.home, address, script),
  liveSessions: (refs) => alive(codexDriver, refs),
  pidsOf: (refs) => refs.map(codexPid).filter((pid) => Number.isInteger(pid)),
  pidAlive: codexSession.pidAlive,
  idle: (ref) => handedOver(codexDriver, ref),
  inspect: (ref) => codexDriver.inspect(ref),
  diagnose: (address) => `${codexStub.diagnoseTrace(codexHarness.home, address)}`
    + ` · threads: ${JSON.stringify(codexSession.listSessions().map((r) => [r.threadId, r.holderPid, r.state]))}`,
};

// Lineup: the participants have different harnesses, and the CALLER declares them. Role
// is read from the address prefix — the same rule the mechanism itself uses
// (`address.startsWith('reviewer:')` on stall routes): a private address table would
// diverge from the scenario on the first rename.
const harness = {
  label: 'mixed',
  sock: makeSockPath('a2m-'),
  at: (address) => (String(address).startsWith('reviewer:') ? reviewer : worker),
  // Stand processes are killed by `promptobus done` in the scenario, and after a fallen
  // run — by the stands' own exit hooks: each hits the panes and holders of its home and
  // removes the home entirely. There is nothing to set up as a second cleanup here.
  cleanup: () => {},
};

const report = await runScenario({
  check,
  harness,
  sandbox: SB,
  workspace: WS,
  // The step ceiling is higher than stub Claude, and this is not slack "just in case".
  // Delivery into a live Cursor persist session costs its own seconds: the driver waits
  // for a free input field (`INPUT_WAIT_MS`), holds a pause before Enter
  // (`ENTER_PAUSE_MS`) and on a turn in progress puts the text into the session queue —
  // the turn on it starts only after the current one. Measurement: the step "remarks to
  // the worker and a second result" — 21.4–22.7 s in four runs in a row, with the other
  // steps under four seconds and the whole loop at 45 s. A 90 s ceiling gives the worst
  // step a fourfold reserve; a smaller one would turn a slow machine into a "participant
  // did not reply" diagnosis. The stall-report threshold is the same: this lineup does
  // not take the silence step at all.
  timeouts: { step: 90000, stall: 75000 },
  // A second review round is the subject of this task: the Codex reviewer gets a NEW
  // diff at the same address, without a second session.
  reviewRounds: 2,
});

process.stdout.write(`  ⏱ ${report.timings.map((t) => `${t.name} ${(t.ms / 1000).toFixed(1)} s`).join(' · ')}`
  + ` · total ${(report.totalMs / 1000).toFixed(1)} s\n`);

// Both stands PLAYED, they did not merely sit in PATH. We judge by each trail: a turn
// was played (`turn-end`) and a bus tool was called from it (`tool`). Without that pair
// the loop could go green on one stand — the second participant would simply stay
// silent, and its verdicts would go red for another reason; the trail check separates
// "the lineup came together" from "we got lucky".
const workerTrace = cursorStub.readTrace(cursorHarness.home, WORKER);
const reviewerTrace = codexStub.readTrace(codexHarness.home, REVIEWER);
const served = (trace) => trace.some((e) => e.kind === 'turn-end') && trace.some((e) => e.kind === 'tool');
check('both stub stands played turns of one loop — worker with the agent binary, reviewer with the codex binary',
  served(workerTrace) && served(reviewerTrace),
  `Cursor turns ${workerTrace.filter((e) => e.kind === 'turn-end').length},`
  + ` bus calls ${workerTrace.filter((e) => e.kind === 'tool').length}`
  + ` · Codex turns ${reviewerTrace.filter((e) => e.kind === 'turn-end').length},`
  + ` bus calls ${reviewerTrace.filter((e) => e.kind === 'tool').length}`);

// Both harness homes were diverted into the stand sandboxes. That is the checkable
// "the run did not write to the human home": home resolve in the mechanism is one for
// all its doors, and it is diverted the same way the live run diverts it. Checking
// mtime of `~/.cursor` would be illegal — a live human session running beside us writes
// there, and the verdict would go red from it.
const inside = (p, home) => String(p).startsWith(String(home));
check('both harness homes were diverted into the stand sandboxes — the run did not write to the human home',
  inside(cursorSession.cursorStateHome(), cursorHarness.home)
  && inside(cursorSession.cursorUserHome(), cursorHarness.home)
  && inside(codexSession.codexStateHome(), codexHarness.home),
  `Cursor: registry ${cursorSession.cursorStateHome()}, home ${cursorSession.cursorUserHome()}`
  + ` · Codex: registry ${codexSession.codexStateHome()}`);

// Insurance, not a check: the "no participant processes left" verdict lives in the
// scenario; this is cleanup after a fallen run. BOTH halves of each stand are checked:
// that there was nothing to kill (registry empty) and that no live process was left
// behind a record.
const panes = cursorSession.listSessions();
const threads = codexSession.listSessions();
const heldThreads = threads.filter((r) => codexSession.pidAlive(r.holderPid));
check('no Cursor pane and no Codex thread left after the run — there was nothing to kill',
  panes.length === 0 && threads.length === 0 && heldThreads.length === 0,
  `panes ${JSON.stringify(panes.map((s) => s.name))} · threads ${JSON.stringify(threads.map((r) => r.threadId))}`
  + ` · live holders ${JSON.stringify(heldThreads.map((r) => r.holderPid))}`);

// Teardown order is the reverse of install: `withStubPath` restores PATH to the value
// it saw ITSELF, and tearing down in install order would return a PATH without the
// directory the second stand put there.
codexHarness.restore();
cursorHarness.restore();

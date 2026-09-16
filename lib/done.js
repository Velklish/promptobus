import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn, fail, shellQuote } from './util.js';
import { hostOf } from './host.js';
import {
  addressOf, closeTask, isAddress, listTasks,
  ORCHESTRATOR, ownerRoute, ownership, participantDirs, participantMcpPath, participantSettingsPath,
  patchTask, readTask, resolveTaskId, sessionIdentity,
  sweepBindings, unprovenOwnerLine, wakeFile,
} from './store.js';
import { inspectWorktree, pruneWorktrees, removeWorktree, worktreeDisposition } from './worktree.js';
import { sweepJournals } from './prune.js';
import {
  appendTelemetry, endReadingStatus, readThroughputSidecars,
  telemetryWindowHarnesses, telemetryWindowIds,
} from './model-routing/telemetry.js';
import { PREFLIGHT_BUDGET_MS, preflight } from './model-routing/preflight.js';
import {
  driverFor, harnessOf, isManaged, snapshotSessions, stopParticipant,
} from '../dist/index.js';
import {
  adapterOf, driverOrLift, forgetSessions, liftDriver, REGISTRY, snapshotOf,
} from './drivers.js';
import { participantSession } from './status.js';

// Close a task and clean up after it — after EVERY closed task, not only this one:
// [03-cli.md](../docs/reference/03-cli.md#status-done-sweep-dismiss-history-prune).

// A worktree is a full copy of the repository, and leaving it hurts search, not disk. Only
// the proven empty is taken off; the branch is read from git, not from a stale journal.

// The "the task has been tidied" mark is a read-modify-write under the lock,
// like `closeTask`.
function markWorktreesSwept(home, id) {
  try {
    patchTask(home, id, { adapter: { worktreesSwept: new Date().toISOString() } });
  } catch {
    // A busy lock is one extra walk next time, not a reason to fail `promptobus done`.
  }
}

// Stop managed sessions of a closed task.
// [reference/03-cli.md#stopmanaged--stop-managed-sessions-of-a-closed-task](../docs/reference/03-cli.md#stopmanaged--stop-managed-sessions-of-a-closed-task)
export async function stopManaged(home, id, { registry = REGISTRY, snapshot = null } = {}) {
  let meta;
  try {
    meta = readTask(home, id);
  } catch {
    return { stopped: 0, idle: 0, failed: 0, unconfirmed: 0 };
  }
  const participants = meta.participants ?? [];
  // The snapshot is built with the SAME registry that stops: a half seam would prop
  // liveness up by swapping the binary and check real `claude`, not the walk.
  const sessions = snapshot ? snapshot(participants) : snapshotSessions(participants, registry);
  // Words about the session come from the SAME registry that stops — a second map would
  // split them. The lift-driver fallback: a refusal here would take the other participants.
  const driverAt = (p) => {
    try {
      return driverFor(registry, harnessOf(p, registry));
    } catch {
      return liftDriver();
    }
  };
  const targets = participants.filter((p) => isManaged(p)
    // Liveness by the same predicate as the whole cleanup: a dead one has nothing to
    // stop, an unknown one even less — its state was not even parsed.
    && participantSession(p, sessions) === 'alive');
  if (!targets.length) return { stopped: 0, idle: 0, failed: 0, unconfirmed: 0 };
  // The list is named BEFORE the first stop: the command is irreversible, and a
  // person reading the output sees what will be closed now, not after the fact.
  info(`stopping participant sessions (${targets.length}): ${targets.map((p) => addressOf(p)).join(', ')}`);
  let stopped = 0;
  let idle = 0;
  let failed = 0;
  // A fourth outcome, not a shade of the third: the stop ran and could not be confirmed.
  // `attempted` is what tells it from `stopped: false`, which means there was no session.
  let unconfirmed = 0;
  for (const p of targets) {
    try {
      // Awaited: a driver may wait until the harness has no session, and cleanup below
      // would otherwise read a state that is not there yet. The walk stays sequential.
      const r = await stopParticipant(p, registry);
      if (!r?.ok) {
        failed += 1;
        warn(`could not close the session of participant ${addressOf(p)}: ${r?.note ?? 'reason unknown'}`
          + ` — close it yourself from ${driverAt(p).phrases.sessions}, otherwise its worktree will stay in place`);
      } else if (r.stopped) {
        stopped += 1;
        ok(`session of participant ${addressOf(p)} closed: ${r.note}`);
      } else if (r.attempted) {
        // The stop ran with nothing to confirm it. The walk will leave this worktree
        // behind, and a person must see that as a line rather than infer it from silence.
        unconfirmed += 1;
        warn(`stop of the session of participant ${addressOf(p)} was not confirmed: ${r.note}`
          + ` — its worktree will stay in place; close the session yourself from ${driverAt(p).phrases.sessions}`);
      } else {
        // Success without a stop is its own outcome — the session vanished between the
        // snapshot and the call. Printing "closed" would assert what nothing did.
        idle += 1;
        info(`no need to stop the session of participant ${addressOf(p)}: ${r.note}`);
      }
    } catch (e) {
      failed += 1;
      warn(`could not close the session of participant ${addressOf(p)}: ${e.message}`);
    }
  }
  return { stopped, idle, failed, unconfirmed };
}

function sweepWorktrees(home, snapshot, host, tasks) {
  const prune = new Set();
  for (const meta of tasks) {
    if (meta.status !== 'done') continue;
    // The mark skips only the per-participant work below, not the listTasks walk itself —
    // that walk runs once per done() call regardless, shared across every sweep.
    if (meta.adapter.worktreesSwept) continue;
    // Over participants of THIS task: the snapshot is keyed by address, and one address
    // lives in different tasks as different sessions. Taken AFTER the tidied cutoff.
    const sessions = snapshot(meta.participants);
    let left = 0;
    for (const p of meta.participants ?? []) {
      // Liveness first and for every participant: harness state can live OUTSIDE the
      // worktree — a Codex reviewer has none and still holds a copy of the credentials.
      const state = participantSession(p, sessions);
      // Optional, and absent on every driver that keeps nothing outside the worktree.
      if (state === 'dead') {
        try {
          driverOrLift(p).sweepParticipant?.(p, meta.id);
        } catch (e) {
          warn(`could not clear the harness state of participant ${addressOf(p)}: ${e.message}`);
        }
      }
      const { worktree, repoAbs } = p.metadata;
      if (!worktree || !repoAbs) continue;
      // The directory is gone — registration in .git/worktrees may have been
      // orphaned. We sweep the repository once, not per participant.
      if (!existsSync(worktree)) { prune.add(repoAbs); continue; }
      // `git worktree remove` looks at dirt and lock but not at processes. Unknown state is
      // left in place too, the same as re-review in review.js.
      if (state !== 'dead') {
        info(`worktree ${worktree} left in place: participant session is ${state === 'alive' ? 'still alive' : 'unknown'}`
          + ` — close it from ${driverOrLift(p).phrases.sessions}, it will be removed on the next ${host.busCommand(['done'])}`);
        left += 1;
        continue;
      }
      const info_ = inspectWorktree(repoAbs, worktree, host.defaultBranch(repoAbs));
      const { action, reason } = worktreeDisposition(info_);
      if (action === 'keep') {
        info(`worktree ${worktree} left in place: ${reason}`);
        left += 1;
        continue;
      }
      const r = removeWorktree(repoAbs, worktree, info_.branch);
      if (r.removed) {
        ok(`worktree ${worktree} removed (${reason})${r.branchDeleted ? `, branch ${info_.branch} deleted` : ''}`);
        if (r.branchKept) info(`branch ${r.branchKept} left in place: spawn did not create it — deleting a foreign branch is not our job`);
        if (r.branchStuck) {
          info(`branch ${r.branchStuck} left in place: force deletion failed.`
            + ` Delete: git -C ${shellQuote(repoAbs)} branch -D ${shellQuote(r.branchStuck)}`);
        }
      } else {
        warn(`could not remove worktree ${worktree}: ${r.error ?? 'git did not explain'}`);
        left += 1;
      }
    }
    if (!left) markWorktreesSwept(home, meta.id);
  }
  for (const repoAbs of prune) pruneWorktrees(repoAbs);
}

// Two secrets of a closed task: a participant mcp-config with substituted tokens, removed
// only for a dead session, and the contact point, removed for all — nobody is left to knock.
function sweepParticipantSecrets(home, snapshot, tasks) {
  for (const meta of tasks) {
    if (meta.status !== 'done') continue;
    // Over participants of this task, for the same reason as the worktree walk. A second
    // snapshot is not a second harness poll — the parsed list is remembered until reset.
    const sessions = snapshot(meta.participants);
    for (const p of meta.participants ?? []) {
      const addr = addressOf(p);
      if (!addr) continue;
      // A bad record address does not break the walk: cleanup runs AFTER the close, and a
      // throw would leave session tokens on disk with nothing left to fix them with.
      if (!isAddress(addr)) {
        warn(`participant "${addr}" in task ${meta.id} skipped: record address is invalid`
          + ' (expected orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>) — the contact point and mcp-config'
          + ' under it stayed on disk, and they hold session tokens. Fix the address in'
          + ` ${path.join(home, 'tasks', meta.id, 'task.json')}`);
        continue;
      }
      const wake = wakeFile(home, meta.id, addr);
      if (existsSync(wake)) {
        rmSync(wake, { force: true });
        info(`contact point ${addr} removed (${wake}) — it holds a session token, and the task is closed`);
      }
      if (addr === ORCHESTRATOR) continue;
      const file = participantMcpPath(home, meta.id, addr);
      const settings = participantSettingsPath(home, meta.id, addr);
      const dirs = participantDirs(home, meta.id, addr);
      if (!existsSync(file) && !existsSync(settings) && !dirs.length) continue;
      if (participantSession(p, sessions) !== 'dead') continue;
      if (existsSync(file)) {
        rmSync(file, { force: true });
        info(`mcp-config ${addr} removed (${file}) — it holds substituted tokens, and the participant session is dead`);
      }
      // The lift writes this beside the mcp-config; until PB-208 nothing took it away.
      if (existsSync(settings)) {
        rmSync(settings, { force: true });
        info(`settings ${addr} removed (${settings}) — the lift wrote it for this session, and the session is dead`);
      }
      // Participant directories the driver opened. Cleanup does not ask the driver:
      // directories are recognised by the address stem, and a harness without them lists none.
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
        // Neutral about the contents — one driver leaves an MCP config with tokens, another
        // a copy of the skills canon. The reason for the removal is the same.
        info(`home of ${addr} removed (${dir}) — the participant session is dead, and the directory is the lift's, not the repository's`);
      }
    }
  }
}

function missingWindowLine(harness, reason = 'probe_failed', windowId = null) {
  const window = windowId ? `window ${windowId}` : 'window';
  warn(`telemetry: ${harness} ${window} not re-read (${reason}) — end reading absent`);
}

async function refreshTelemetry(host, meta, adapterFor) {
  const harnesses = telemetryWindowHarnesses(meta);
  if (!harnesses.length) return null;
  try {
    return await preflight({
      host, harnesses, adapterFor, refresh: true, budgetMs: PREFLIGHT_BUDGET_MS,
    });
  } catch {
    return null;
  }
}

/** One telemetry record per participant that lifted a session.
 * [reference/03-cli.md#recordtelemetry--one-telemetry-record-per-participant-that-lifted-a-session](../docs/reference/03-cli.md#recordtelemetry--one-telemetry-record-per-participant-that-lifted-a-session) */
async function recordTelemetry(host, home, id, adapterFor) {
  try {
    const meta = readTask(home, id);
    const closedAt = Date.parse(meta.adapter?.closed ?? '');
    const at = Number.isFinite(closedAt) ? closedAt : Date.now();
    const snapshot = await refreshTelemetry(host, meta, adapterFor);
    for (const harness of telemetryWindowHarnesses(meta)) {
      const status = endReadingStatus(host, harness, telemetryWindowIds(meta, harness), at, snapshot);
      if (status.harness) {
        if (status.missing.length) missingWindowLine(harness, status.reason);
      } else {
        for (const windowId of status.missing) missingWindowLine(harness, status.reason, windowId);
      }
    }
    const throughput = readThroughputSidecars(home, meta);
    const { file, written } = appendTelemetry(host, home, meta, { at, snapshot, throughput });
    if (written) info(`telemetry: ${written} record(s) appended to ${file}`);
  } catch (e) {
    warn(`telemetry records were not written (${e.message}) — task ${id} is closed, this does not undo that`);
  }
}

export async function done(rootOrHost, opts = {}) {
  const host = hostOf(rootOrHost);
  const root = host.workspaceRoot();
  const task = opts.task;
  // The kebab key is read by its own name: the caller hands the whole `values`
  // object here, and a translation on the seam is not needed.
  const keepSessions = Boolean(opts['keep-sessions']);
  // Test seam, like `snapshot`; CLI argv cannot supply a function.
  const adapterFor = typeof opts.adapterFor === 'function' ? opts.adapterFor : adapterOf;
  // A set seam, as on `status` and `wardenRound`. A function over participants rather than
  // a ready snapshot: every closed task needs its own, since the key is the address.
  const snapshot = typeof opts.snapshot === 'function' ? opts.snapshot : snapshotOf;
  const home = host.promptobusHome();
  const id = resolveTaskId(home, task, sessionIdentity(), {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  // Owner gate: without it a foreign session would close a live foreign run. Explicit
  // `--task` is NOT a bypass here — spawn and review attach a track, this ends the run.
  const own = ownership(home, id, ORCHESTRATOR, sessionIdentity());
  if (!own.allowed) {
    fail(`${unprovenOwnerLine(home, readTask(home, id), own)}: the run is finished by its owner. `
      + `${host.busCommand(['done'])} takes the task off the active list and sweeps worktree directories of closed tasks — a foreign hand `
      + 'would cut off live work. Explicit --task is not a bypass here: spawn and review use it '
      + `to attach a track, and this one closes the run. ${ownerRoute(home, readTask(home, id), own, host.busCommand(['done']))}`);
  }
  // Read BEFORE the close: `closeTask` is idempotent, and afterwards nothing tells a first
  // close from a repeat — the telemetry append must happen exactly once per run.
  const wasActive = readTask(home, id).status === 'active';
  closeTask(home, id);
  ok(`task ${id} closed — mail stays in ${path.join(home, 'tasks', id)}`);
  if (wasActive) await recordTelemetry(host, home, id, adapterFor);
  // The session registry is reset once for the whole cleanup: further walks
  // read the same parsed list, and each builds a snapshot for its own task.
  forgetSessions();
  // Sessions are stopped BEFORE the worktree walk, and `--keep-sessions` is the switch of
  // an irreversible action: [03-cli.md](../docs/reference/03-cli.md#status-done-sweep-dismiss-history-prune).
  if (keepSessions) {
    const lifter = liftDriver();
    info('--keep-sessions: participant sessions left alive — close them yourself from '
      + lifter.phrases.sessions);
  } else {
    const stop = await stopManaged(home, id, { snapshot });
    if (!stop.stopped && !stop.idle && !stop.failed && !stop.unconfirmed) {
      info(`nothing to stop: no live sessions started by the mechanism remain in task ${id}`);
    }
    // State is taken ANEW after the stop, or just-stopped sessions would still read live.
    // The reset is conditional: with nothing stopped the list did not change.
    if (stop.stopped || stop.unconfirmed) forgetSessions();
  }
  // One parse of every task.json, shared across the three sweeps below instead of one
  // walk each — a broken-task warning fires once per done(), not up to three times.
  const tasks = listTasks(home);
  sweepWorktrees(home, snapshot, host, tasks);
  sweepParticipantSecrets(home, snapshot, tasks);
  // Bindings that lost liveness with the task. They do not bother the mechanism —
  // `liveBinding` does not return a dead one — but the directory would grow a file per run.
  const dropped = sweepBindings(home);
  if (dropped) info(`session bindings dropped: ${dropped} — their tasks are closed`);
  // Journals of LONG-closed tasks, as `prune --yes`; the one just closed is seconds old and
  // never falls under it. A cleanup refusal does not roll the close back — it is a warning.
  try {
    sweepJournals(home, undefined, { tasks });
  } catch (e) {
    warn(`journals of long-closed tasks were not removed (${e.message}) — task ${id} is closed, `
      + `this does not undo that. Remove by hand: ${host.busCommand(['prune', '--yes'])}`);
  }
}

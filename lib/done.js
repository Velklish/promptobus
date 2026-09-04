import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn, fail, shellQuote } from './util.js';
import { hostOf } from './host.js';
import {
  addressOf, claimRoute, closeTask, foreignTaskLine, isAddress, listTasks,
  ORCHESTRATOR, ownership, participantDirs, participantMcpPath, patchTask, readTask, resolveTaskId,
  sessionIdentity,
  sweepBindings, wakeFile,
} from './store.js';
import { inspectWorktree, pruneWorktrees, removeWorktree, worktreeDisposition } from './worktree.js';
import { sweepJournals } from './prune.js';
import {
  driverFor, harnessOf, isManaged, snapshotSessions, stopParticipant,
} from '../dist/index.js';
import { driverOrLift, forgetSessions, liftDriver, REGISTRY, snapshotOf } from './drivers.js';
import { participantSession } from './status.js';

// Close a task and clean up after it. The command sweeps ALL CLOSED tasks, not
// only the one just closed: sessions outlive their `done`, and a directory
// under a live worker does not leave — the next close will tidy after the
// previous one. Participant liveness is asked with the same predicate
// `promptobus status` uses to name it.

// A worktree directory is a full copy of the repository, and leaving it hurts
// search, not disk: six copies in a clone — every file in grep seven times.
// Only the proven empty is taken off (worktreeDisposition decides), what is
// left is explained out loud. The branch is taken from git, not from the
// journal: the one spawn wrote may have gone stale.

// The "the task has been tidied" mark is a read-modify-write under the lock,
// like `closeTask`.
function markWorktreesSwept(home, id) {
  try {
    patchTask(home, id, { adapter: { worktreesSwept: new Date().toISOString() } });
  } catch {
    // A busy lock is one extra walk next time, not a reason to fail `promptobus done`.
  }
}

/**
 * Stop managed sessions of a closed task. A session the mechanism started, it
 * also closes: before this task a person stopped it by hand (`claude stop <id>`
 * on acceptance), and the cost of delay was double — live sessions piled up on
 * the machine, and worktree cleanup after a live session does not run at all,
 * because the directory would leave from under its `cwd`.
 *
 * Only `managed` with a live session are stopped: the task owner has no session
 * behind them at all, and `attached` the driver did not start and has no right
 * to dispose of. A refusal of one participant does not break the walk — named
 * out loud and we go on: this is the same walk after the task is closed, and
 * you cannot throw from it.
 *
 * `registry` is a set seam: a stand-in driver counts calls without touching
 * live `claude`. `snapshot` is a second seam, a function over participants:
 * `done` supplies it so the whole command is hermetic in one argument; without
 * it the snapshot is built with the same `registry`.
 */
export async function stopManaged(home, id, { registry = REGISTRY, snapshot = null } = {}) {
  let meta;
  try {
    meta = readTask(home, id);
  } catch {
    return { stopped: 0, idle: 0, failed: 0, unconfirmed: 0 };
  }
  const participants = meta.participants ?? [];
  // The snapshot is built with the SAME registry that stops (review finding): a
  // half seam would prop liveness up by swapping the binary, and a stand-in
  // driver on the set would stay a dead fixture — the behavior of real `claude`
  // would be checked, not the walk.
  const sessions = snapshot ? snapshot(participants) : snapshotSessions(participants, registry);
  // Words about the session belong to the driver, and it is taken from the SAME
  // registry that stops: the set seam replaces the map whole, and a second map
  // for the lines would split them from each other. Fallback to the lift driver
  // is the same as at the door (`driverOrLift`): the walk runs AFTER the task
  // is closed, and a refusal from here would take the other participants with
  // it.
  const driverAt = (p) => {
    try {
      return driverFor(registry, harnessOf(p, registry));
    } catch {
      return liftDriver();
    }
  };
  const targets = participants.filter((p) => isManaged(p)
    // Liveness is asked with the same predicate as the whole cleanup: a dead
    // one has nothing to stop, and an unknown one even less — its state is not
    // even parsed.
    && participantSession(p, sessions) === 'alive');
  if (!targets.length) return { stopped: 0, idle: 0, failed: 0, unconfirmed: 0 };
  // The list is named BEFORE the first stop: the command is irreversible, and a
  // person reading the output sees what will be closed now, not after the fact.
  info(`stopping participant sessions (${targets.length}): ${targets.map((p) => addressOf(p)).join(', ')}`);
  let stopped = 0;
  let idle = 0;
  let failed = 0;
  // A fourth outcome, not a shade of the third (review finding): the stop
  // command ran, and the driver could not confirm the session is gone — the
  // wait ceiling ran out or the registry after the stop is not parsed. Printing
  // this as "no need to stop" would deny the first half of the line with the
  // second: it did have to be stopped, it was not confirmed. What distinguishes
  // them is the `attempted` field of the outcome: without it `stopped: false`
  // means "there was no session even before the command".
  let unconfirmed = 0;
  for (const p of targets) {
    try {
      // The stop outcome is `await`ed: the driver may wait until the harness
      // has no session, and without the wait cleanup below would go by a state
      // that is not there yet. The walk stays sequential — we stop one by one,
      // as we printed the list.
      const r = await stopParticipant(p, registry);
      if (!r?.ok) {
        failed += 1;
        warn(`could not close the session of participant ${addressOf(p)}: ${r?.note ?? 'reason unknown'}`
          + ` — close it yourself from ${driverAt(p).phrases.sessions}, otherwise its worktree will stay in place`);
      } else if (r.stopped) {
        stopped += 1;
        ok(`session of participant ${addressOf(p)} closed: ${r.note}`);
      } else if (r.attempted) {
        // The stop ran, and there is nothing to confirm it with. Alarm level:
        // the walk will leave this participant's worktree directory — the
        // session is not dead for it — and a person must see that as a line,
        // not infer it from silence.
        unconfirmed += 1;
        warn(`stop of the session of participant ${addressOf(p)} was not confirmed: ${r.note}`
          + ` — its worktree will stay in place; close the session yourself from ${driverAt(p).phrases.sessions}`);
      } else {
        // Success without a stop is its own outcome: the session vanished
        // between the snapshot and the call. Printing it as "closed" would
        // assert what the mechanism did not do.
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

function sweepWorktrees(home, snapshot, host) {
  const prune = new Set();
  for (const meta of listTasks(home)) {
    if (meta.status !== 'done') continue;
    // A fully tidied task is not walked a second time: without the mark the
    // cost of cleanup would grow with run history. The mark is set only when
    // after the walk not a single directory is left; everything left is
    // re-inspected.
    if (meta.adapter.worktreesSwept) continue;
    // The session snapshot is taken over participants of THIS task: it is keyed
    // by address, and one address lives in different tasks as different
    // sessions. It costs a driver poll, so it is taken AFTER the tidied cutoff
    // (review finding) — otherwise a tidied task would pay for it on every
    // `done`. That does not add external poll starts: the session registry
    // remembers a successful parse until reset (liftoff.js).
    const sessions = snapshot(meta.participants);
    let left = 0;
    for (const p of meta.participants ?? []) {
      const { worktree, repoAbs } = p.metadata;
      if (!worktree || !repoAbs) continue;
      // The directory is gone — registration in .git/worktrees may have been
      // orphaned. We sweep the repository once, not per participant.
      if (!existsSync(worktree)) { prune.add(repoAbs); continue; }
      // `git worktree remove` looks at dirt and lock, but not at processes: the
      // directory would leave from under a running session whose cwd is in it.
      // Unknown state — we also leave it, the same logic as re-review in
      // review.js.
      const state = participantSession(p, sessions);
      if (state !== 'dead') {
        info(`worktree ${worktree} left in place: participant session is ${state === 'alive' ? 'still alive' : 'unknown'}`
          + ` — close it from ${driverOrLift(p).phrases.sessions}, it will be removed on the next promptobus done`);
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
          info(`branch ${r.branchStuck} left in place: git -d does not consider it merged (this happens after a squash merge).`
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

// Cleanup of mcp-configs of closed tasks: a participant config holds
// substituted tokens, and without cleanup a file per participant would pile up
// in `workers/` forever. Only of a dead session: a participant that survived
// `--resume` starts by the same path, and a file taken out from under a live
// one would leave it without the bus.
//
// Contact point is the second secret of the task (messaging-socket token). It
// is removed for ALL addresses with no look at liveness: a closed task has
// nobody to knock.
function sweepParticipantSecrets(home, snapshot) {
  for (const meta of listTasks(home)) {
    if (meta.status !== 'done') continue;
    // Snapshot — over participants of this task, for the same reason as the
    // worktree walk. A second snapshot per task is not a second harness poll:
    // the parse of `claude agents --json` is remembered until
    // `resetBgSessionsCache()` below, and `inspect` walks the in-memory list.
    // Measurement (2026-09-02, a home with 20 closed tasks of 3 participants
    // with sessions): `claude` starts for the whole `done` — 1, second snapshot
    // over 20 tasks — 0.06 ms CPU. There is no need to pass the snapshot here
    // from the worktree walk: there is nothing to save, and a shared argument
    // would bind two independent cleanups.
    const sessions = snapshot(meta.participants);
    for (const p of meta.participants ?? []) {
      const addr = addressOf(p);
      if (!addr) continue;
      // A bad record address does not break the walk. Cleanup runs AFTER the
      // task is closed, and a throw from here would take the other participants
      // of this task, every following closed task, and `sweepBindings` after
      // them: session tokens would stay on disk, and there would be nothing to
      // fix it with — the record does not vanish from the journal, and it
      // repeated on every close in this home. The same move as the unread
      // counter in `promptobus status`: name it out loud and go on.
      if (!isAddress(addr)) {
        warn(`participant "${addr}" in task ${meta.id} skipped: record address is invalid`
          + ' (expected orchestrator, worker:<slug> or reviewer:<slug>) — the contact point and mcp-config'
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
      const dirs = participantDirs(home, meta.id, addr);
      if (!existsSync(file) && !dirs.length) continue;
      if (participantSession(p, sessions) !== 'dead') continue;
      if (existsSync(file)) {
        rmSync(file, { force: true });
        info(`mcp-config ${addr} removed (${file}) — it holds substituted tokens, and the participant session is dead`);
      }
      // Participant directories the driver opened: for Cursor they hold the
      // reviewer home, and in it the same MCP config with substituted tokens.
      // Cleanup does not ask the driver: directories are recognized by the
      // address stem, and for a harness that does not open them the list is
      // empty.
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
        info(`home of ${addr} removed (${dir}) — it holds an MCP config with tokens, and the participant session is dead`);
      }
    }
  }
}

export async function done(rootOrHost, opts = {}) {
  const host = hostOf(rootOrHost);
  const root = host.workspaceRoot();
  const task = opts.task;
  // The kebab key is read by its own name: the caller hands the whole `values`
  // object here, and a translation on the seam is not needed.
  const keepSessions = Boolean(opts['keep-sessions']);
  // Session snapshot is a set seam, like `sessions` on `status` and
  // `wardenRound`: without it the walks would ask live `claude agents --json`
  // of the run machine, and cleanup checks would rest on a PATH swap. Here the
  // seam is a function over participants, not a ready snapshot: the walks take
  // state for EVERY closed task, because the snapshot is keyed by address, and
  // one address lives in different tasks as different sessions.
  const snapshot = typeof opts.snapshot === 'function' ? opts.snapshot : snapshotOf;
  const home = host.promptobusHome();
  const id = resolveTaskId(home, task);
  // Owner gate: without it a foreign session would close a live foreign run —
  // cleanup sweeps directories of closed tasks, including those whose work
  // nobody accepted. Explicit `--task` is NOT a bypass — unlike spawn and
  // review: those attach a track, this one ends the run. The refusal prints
  // via `fail()`, not a throw: the top CLI catch prints `e.stack`, and a legal
  // refusal would arrive as a sign of an internal CLI break. The same words
  // and exit code as `promptobus dismiss`.
  const own = ownership(home, id, ORCHESTRATOR, sessionIdentity());
  if (own.gated) {
    fail(`${foreignTaskLine(readTask(home, id), own)}: the run is finished by its owner. `
      + 'promptobus done takes the task off the active list and sweeps worktree directories of closed tasks — a foreign hand '
      + 'would cut off live work. Explicit --task is not a bypass here: spawn and review use it '
      + `to attach a track, and this one closes the run. ${claimRoute('promptobus done')}`);
  }
  closeTask(home, id);
  ok(`task ${id} closed — mail stays in ${path.join(home, 'tasks', id)}`);
  // The session registry is reset once for the whole cleanup: further walks
  // read the same parsed list, and each builds a snapshot for its own task.
  forgetSessions();
  // Sessions are stopped BEFORE worktree cleanup and not later: `git worktree
  // remove` does not look at processes, and the directory would leave from
  // under a live session whose `cwd` sits in it. Stopped — means merged
  // worktrees are taken off in the same pass, not "on the next promptobus
  // done".
  //
  // `--keep-sessions` is a switch of an irreversible action (orchestrator
  // decision): the task is closed, sessions stay alive. Directory cleanup after
  // a live session then does not run — it will say so itself, in its own line
  // for each directory left in place.
  if (keepSessions) {
    const lifter = liftDriver();
    info('--keep-sessions: participant sessions left alive — close them yourself from '
      + lifter.phrases.sessions);
  } else {
    const stop = await stopManaged(home, id, { snapshot });
    if (!stop.stopped && !stop.idle && !stop.failed && !stop.unconfirmed) {
      info(`nothing to stop: no live sessions started by the mechanism remain in task ${id}`);
    }
    // The walk takes session state ANEW — already after the stop. The driver
    // registry remembers the parsed list until reset, and a snapshot taken
    // BEFORE the stop would show the just-stopped sessions as live to cleanup:
    // directories would stay in place with an honest but wrong reason "the
    // session is still alive". The reset sits under a condition, not
    // unconditionally: if there was nothing to stop — the list did not change,
    // and an extra harness poll would cost a process start on every
    // `promptobus done` (the start count is in the same place).
    if (stop.stopped || stop.unconfirmed) forgetSessions();
  }
  sweepWorktrees(home, snapshot, host);
  sweepParticipantSecrets(home, snapshot);
  // Bindings that lost liveness together with the task. They do not bother the
  // mechanism — `liveBinding` does not return a dead one — but the directory
  // would grow a file per session per run.
  const dropped = sweepBindings(home);
  if (dropped) info(`session bindings dropped: ${dropped} — their tasks are closed`);
  // Journals of LONG-closed tasks — the same cleanup as `prune --yes`, at the
  // default threshold (owner decision 2026-09-02). The one just closed does not
  // fall under it on any call: it is seconds old. It runs last — after session
  // stop and after the worktree walk: the walk reads journals of all closed
  // tasks, and if you wipe them earlier, the directory would be left an unnamed
  // orphan.
  //
  // A cleanup refusal does not roll the close back: `done` has already done its
  // work, and it has no undo. Directory rights, a busy lock, an unreadable
  // record — that is a warning with a route, not a command refusal.
  try {
    sweepJournals(home);
  } catch (e) {
    warn(`journals of long-closed tasks were not removed (${e.message}) — task ${id} is closed, `
      + `this does not undo that. Remove by hand: ${host.busCommand(['prune', '--yes'])}`);
  }
}

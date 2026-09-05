import { existsSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn } from './util.js';
import { hostOf } from './host.js';
import {
  promptobusHome, activeTasks, addressOf, countInbox, foreignTaskLine, listTasks, liveWarden,
  ORCHESTRATOR, ownership, readHealth, readTask, readWake, sameOwnerSession, sessionIdentity,
  taskOwner, WARDEN_BEAT_SEC, tailWardenLog,
} from './store.js';
import {
  blockedParticipants as blockedIn, justSpawned, liveParticipant, routingOf, stallStands,
} from '../dist/index.js';
import { routingLine } from './models.js';
import { branchLine, worktreeBranch } from './worktree.js';
import { driverOrLift, liftDriver, snapshotOf, stallRouteOf } from './drivers.js';
import { stallLine as lineOf } from './stalls.js';

// Bus participant state: how to name it for a human and print it. Predicates — stall,
// busyness, liveness, the already-reported mark — moved to the package
// ([supervisor.ts](../src/supervisor.ts)): `promptobus status` printing,
// the warden's report of stalled participants, and tool reply lines must say one thing
// about a stall, not two different pieces of advice about the same state, and that
// holds because the predicate is one.
//
// What remains here is the adapter: the session snapshot is taken from the driver via
// the registry, the state words ("stalled", "LISTED", "GONE") come from the shared leaf
// [stalls.js](stalls.js), and the stall ROUTE arrives as a string from the driver of the
// participant whose state was just resolved.
// This file does not know a harness name at all — not a single one.

// State-machine predicates — the door for the rest of the mechanism: `server.js` takes
// `blockedParticipants`, `stallLine`, and `stallTail` from here, the suite takes the rest.
// Their snapshot shape is one, and its default is one too — this CLI's snapshot.
export {
  commitStalls, pendingStalls, sessionBusy, stallStands, justSpawned, SPAWN_GRACE_SEC,
} from '../dist/index.js';
export { stallTail } from './stalls.js';

/**
 * Line about a stalled participant: the state words are shared ([stalls.js](stalls.js)),
 * the route belongs to that participant's driver. The signature is the old one,
 * `(stall record, task)`: `server.js` and the warden report call it, and they have no
 * need to know about the registry.
 */
export function stallLine(s, task) {
  return lineOf(s, stallRouteOf(s, task));
}

/**
 * Task participants from whom no messages should be expected. The signature is the same
 * as before the extract: the fourth argument is the session snapshot, and the default
 * builds it itself — a three-argument call (`stallNote` of the MCP server) works as it
 * used to.
 */
export function blockedParticipants(home, task, participants, sessions = snapshotOf(participants)) {
  return blockedIn(home, task, participants, sessions);
}

/**
 * Participant session state: `alive` | `dead` | `unknown`. The default takes state for
 * exactly one participant: the snapshot is built from a list, and this question does
 * not need a list. Re-review (promptobus/review.js) lives on the same check.
 */
export function participantSession(participant, sessions = snapshotOf([participant])) {
  return liveParticipant(participant, sessions);
}

export const WARDEN_MARK = 'NO WARDEN';

export function wardenLine(home, id, host) {
  if (host == null) throw new Error('wardenLine: host is required');
  const lifter = liftDriver();
  const mark = liveWarden(home, id);
  const lift = host.busCommand(['warden', `--task ${id}`]);
  if (!mark) {
    return {
      alive: false,
      line: `${WARDEN_MARK}: the task has no mailbox listener — a participant learns about a message `
        + 'only when they call mailbox themselves. Any bus command will start it: warden state lives in the '
        + `task store, there is nothing to lose on restart. Start by hand: ${lift}`,
    };
  }
  return {
    alive: true,
    line: `warden: alive (pid ${mark.pid}${mark.cli ? `, CLI ${mark.cli}` : ''}, heartbeat ${mark.beat}, `
      // The driver names the version the channel was proven on: it knows this harness's numbers.
      + `period ${WARDEN_BEAT_SEC} s) · injection proven on ${lifter.id} ${lifter.options.provenVersion}`,
  };
}

// The orchestrator's socket is gone: the file was removed or the warden already recorded ENOENT.
// status does not probe "not accepting" — the command only reads, a hang on connect is not allowed.
// knockError is sticky: it resets only on a successful knock, and a knock happens only on
// unread mail. After a claim with an empty mailbox the old ENOENT cannot be trusted — it is
// about the former owner. Trust it only when wake is still about the current owner and
// the attempt is not older than the contact point.
export function orchestratorSocketGone(wake, h, owner) {
  const aboutOwner = !wake?.session || !owner || sameOwnerSession(wake.session, owner);
  if (wake?.socket && !existsSync(wake.socket) && aboutOwner) return true;
  if (h.knockError !== 'ENOENT' || !aboutOwner) return false;
  if (wake?.at && h.triedAt && h.triedAt < wake.at) return false;
  return true;
}

export function orchestratorDeadLine(owner, since) {
  return `owner ${owner} is dead since ${since} — a successor in the same root takes the mailbox claim`;
}

// How the warden wakes a participant and whether they stay silent past the threshold — all
// escalation visibility.
function wakePart(home, id, addr) {
  const parts = [];
  const wake = readWake(home, id, addr);
  const h = readHealth(home, id)[addr] ?? {};
  if (addr === ORCHESTRATOR && orchestratorSocketGone(wake, h, taskOwner(home, id))) {
    const owner = taskOwner(home, id) ?? 'nobody';
    const since = h.triedAt ?? h.since ?? wake?.at ?? 'unknown';
    // Not "self-wake": there is nothing to wake the orchestrator with, and a successor in
    // the root otherwise does not see the route until they call mailbox themselves.
    parts.push(orchestratorDeadLine(owner, since));
  } else if (h.channel === 'self-wake' || !wake?.socket) {
    // The reason is named as-is, not with the journal phrase "<channel> did not accept
    // notification": there are two fallbacks now, and the second is a contact point
    // intercepted by a foreign session, where the delivery channel has nothing to do with
    // it. The journal names the driver's channel (`socket` for Claude Code,
    // `inject` / `rpc` for the rest); this line is the only place the gate refusal is
    // visible to a human without reading the journal.
    parts.push(`alarm: self-wake${h.knockError ? ` (reason: ${h.knockError})` : ''}`);
  } else {
    // `socket` in health is the same transport this line has long called "socket". Any
    // other channel value is printed as-is: an inject/rpc contact point is also called
    // `socket` in the field, but is not a messaging socket.
    const label = !h.channel || h.channel === 'socket' ? 'socket' : h.channel;
    parts.push(`alarm: ${label} handed over ${wake.at}${h.knocks ? `, knocks ${h.knocks}` : ''}`);
  }
  if (h.escalatedAt) parts.push(`SILENT since ${h.since} (escalated ${h.escalatedAt})`);
  return parts;
}

// Header of a bad participant record. Cited verbatim by prose, so it lives as a constant:
// the contract-quote gate checks the citation against it (key `mailbox-unread-mark` in lint.js).
export const MAILBOX_UNREAD_MARK = 'MAILBOX UNREAD';

// Unread counter — under try/catch: `addrDir` throws on an unknown address, and one
// broken record would take the whole `promptobus status` with it. Name the bad one out
// loud and move on.
function unreadPart(home, id, addr) {
  try {
    return `unread ${countInbox(home, id, addr)}`;
  } catch (e) {
    return `${MAILBOX_UNREAD_MARK}: the record address is invalid (${e.message})`;
  }
}

export function status(rootOrHost, { task, sessions = undefined } = {}) {
  const host = hostOf(rootOrHost);
  const home = promptobusHome(host.workspaceRoot(), host);
  const tasks = task ? [readTask(home, task)] : activeTasks(home);
  if (!tasks.length) {
    const all = listTasks(home);
    ok(`no active tasks${all.length ? ` (total in the journal: ${all.length})` : ''}`);
    return;
  }
  const session = sessionIdentity();
  for (const meta of tasks) {
    // The snapshot is taken from this task's participant list: a harness query stands
    // behind it, and one snapshot per task is cheaper than a query per participant.
    //
    // It arrives as a seam argument — the same one `wardenRound` and `reportStalls`
    // ([warden.js](warden.js)) use: without it printing would ask the live `claude agents --json`
    // of the suite machine about the person's sessions who ran the suite, and command
    // checks would depend on them. The supplied snapshot is for the WHOLE call, not per
    // task: `status` without `--task` prints all active ones, and participant addresses
    // of different tasks coincide.
    // The default distinguishes `undefined` ("no snapshot was supplied — take one yourself")
    // from `null` ("the list was not parsed"): `null` is a legal snapshot state, and it
    // must not be re-taken, or the line "session state is unknown" would be unreachable.
    const snap = sessions === undefined ? snapshotOf(meta.participants) : sessions;
    ok(`${meta.id} · ${meta.title} · ${meta.status}`);
    // A foreign task. There is no gate: `status` only reads. Silence is not allowed — a
    // session that picked up a foreign task by resolving "the only active one" would
    // read it as its own.
    const own = ownership(home, meta.id, ORCHESTRATOR, session);
    if (own.gated) warn(`${foreignTaskLine(meta, own)} — this session is looking at a foreign run.`);
    // The warden comes before the participant list: its death explains the silence of
    // the lines below.
    const wdn = wardenLine(home, meta.id, host);
    if (wdn.alive) info(wdn.line);
    else warn(wdn.line);
    for (const p of meta.participants ?? []) {
      // Mechanism fields live in the v1 record `metadata`: the adapter writes them and
      // reads them. The record's own v1 fields are role, harness, mode, session
      // reference, capabilities.
      const m = p.metadata ?? {};
      const addr = addressOf(p);
      const parts = [addr];
      // The only place a person can check which session the mailbox is bound to.
      if (m.owner) parts.push(`owner ${m.owner}`);
      if (m.repo) parts.push(m.repo);
      // The worktree path is the argument of `promptobus review <path>`; that is where
      // the journal stores it.
      if (m.worktree) parts.push(`worktree ${m.worktree}`);
      // Git names the branch, not the journal: a worker may have moved to their own on a
      // brief request.
      if (m.branch || m.worktree) {
        const line = branchLine(m.branch, worktreeBranch(m.worktree));
        if (line) parts.push(line);
      }
      // A routed participant says what it was routed by, and on what the pick was
      // made: the strategy envelope agreed before the run is auditable DURING it,
      // not only at its start. The decision is read through the accessor
      // (`routingOf`) rather than out of the map: adapter fields on the record have
      // one door, and this is one of them.
      const routed = routingLine(routingOf(p));
      if (routed) parts.push(routed);
      parts.push(unreadPart(home, meta.id, addr));
      try {
        parts.push(...wakePart(home, meta.id, addr));
      } catch {
        // A bad record has no right to take the other lines with it.
      }
      // Dismissal from watch is visible here and only here: without the line, silence of
      // reports is indistinguishable from a broken warden.
      if (m.dismissed) parts.push(`DISMISSED FROM WATCH ${m.dismissed} — no reports about their session`);
      if (m.name) {
        const view = snap?.[addr] ?? null;
        // Words about the session belong to this participant's driver: only it knows
        // what its registry is called and how the session journal is looked at. A driver
        // for a foreign harness is not on the map at all, and a refusal here would take
        // the other participants' print with it — the door with fallback to the lift
        // driver (`driverOrLift`) is taken; such a participant still does not get a line
        // with its words, their branch below is "there is nobody to ask about it".
        const driver = driverOrLift(p);
        // We name the session — it does not match the branch name, and without it the
        // participant cannot be found by eye in the harness session registry.
        if (snap === null) parts.push(`session state "${m.name}" is unknown (${driver.phrases.unreadable})`);
        // There is nobody to ask about it: there is no driver for its harness, or that
        // driver does not look. This is unknown, not "there is no session": the session
        // may be alive, and saying it "is not in the list" would mean calling to start
        // it again.
        else if (view?.state === 'unknown') {
          parts.push(`session state "${m.name}" is unknown: harness "${p.harness}" — `
            + 'there is nobody to ask about it');
        } else if (!view || view.state === 'gone') parts.push(`session "${m.name}" is not in the list`);
        else if (view.state === 'stale' && justSpawned(p)) {
          // Same registration window: "start again" is wrong on something just started.
          parts.push(`session "${m.name}" is starting — spawn just happened, pid is not announced yet;`
            + ` state will be visible in a few seconds`);
        } else if (view.state === 'stale') {
          parts.push(`session "${m.name}" is LISTED, but there is no process behind it — the record outlived its daemon.`
            + ` Check: ${driver.phrases.logs(view.id ?? m.name)}. There will be no messages from it`);
        } else if (stallStands(home, meta.id, p, view.stall)) {
          parts.push(`session "${m.name}" STALLED: ${view.stall.reason} — `
            + stallRouteOf({
              ...view.stall, address: addr, repoAbs: m.repoAbs, harness: p.harness, id: view.id ?? m.name, ref: m.name,
            }, meta.id));
        } else if (view.stall) {
          // A normal end of turn — the ordinary participant state between turns, and it
          // needs its own words precisely because `blocked` here is not a sign of life:
          // the former branch printed "alive (blocked)" and argued with itself.
          parts.push(`session "${m.name}" finished the turn, waiting for a message`);
        } else parts.push(`session "${m.name}" is alive (${view.note ?? 'running'})`);
      }
      info(parts.join(' · '));
    }
    // Warden journal tail: the "SILENT" line names the fact, not the history.
    const tail = tailWardenLog(home, meta.id);
    if (tail.length) info(`warden journal (last ${tail.length}):\n    ${tail.join('\n    ')}`);
    info(`mail and artifacts: ${path.join(home, 'tasks', meta.id)}`);
  }
}

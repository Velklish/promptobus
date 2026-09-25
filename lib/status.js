import { existsSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn } from './util.js';
import { hostOf } from './host.js';
import {
  activeTasks, addressOf, countInbox, foreignTaskLine, listTasks, liveWarden,
  ORCHESTRATOR, ownership, readHealth, readTask, readWake, sameOwnerSession, sessionIdentity,
  taskOwner, WARDEN_BEAT_SEC, tailWardenLog,
} from './store.js';
import {
  blockedParticipants as blockedIn, justSpawned, liveParticipant, resetText, routingOf, sessionRefOf, stallStands,
} from '../dist/index.js';
import { routingLine } from './models.js';
import { historyCountWindow, tallies } from './model-routing/telemetry.js';
import { branchLine, worktreeBranch } from './worktree.js';
import { driverOrLift, liftDriver, snapshotOf, stallRouteOf } from './drivers.js';
import { stallLine as lineOf, stallWord } from './stalls.js';
import { UNANSWERED_MARK, unansweredSince } from './answers.js';

// Bus participant state: how to name it for a person and print it. The predicates live in
// the package ([supervisor.ts](../src/supervisor.ts)); this file knows no harness name.

function stampMs(value) {
  const n = Date.parse(value ?? '');
  return Number.isFinite(n) ? n : null;
}

function harnessHistoryOf(metadata) {
  const raw = metadata?.harnessHistory;
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => row && typeof row.harness === 'string' && row.harness && stampMs(row.until) !== null);
}

// State-machine predicates — the door for the rest of the mechanism. Their snapshot shape
// is one, and so is its default: this CLI's snapshot.
export {
  commitStalls, pendingStalls, sessionBusy, stallStands, lastActivation, justSpawned, SPAWN_GRACE_SEC,
} from '../dist/index.js';
export { stallTail } from './stalls.js';

/** Line about a stalled participant: the state words are shared ([stalls.js](stalls.js)),
 * the route belongs to that participant's driver; direct driver seams may omit the hints. */
function routeHints(host, { address, repoAbs, harness, task }) {
  if (typeof host?.busCommand !== 'function') return {};
  const hints = {
    doneCommand: host.busCommand(['done']),
    statusCommand: host.busCommand(['status']),
  };
  if (address?.startsWith('reviewer:')) {
    const args = ['review', `"${repoAbs ?? '<clone path>'}"`];
    if (harness === 'codex') args.push('--harness', 'codex');
    if (task) args.push(`--task ${task}`);
    hints.reviewCommand = host.busCommand(args);
  }
  if (address?.startsWith('approver:')) {
    const args = ['review', `"${repoAbs ?? '<clone path>'}"`, '--approver'];
    if (task) args.push(`--task ${task}`);
    hints.reviewCommand = host.busCommand(args);
  }
  return hints;
}

export function stallLine(s, task, host = null) {
  return lineOf(s, stallRouteOf({ ...s, ...routeHints(host, { ...s, task }) }, task));
}
/** Task participants from whom no messages should be expected. The fourth argument is the
 * session snapshot, and the default builds it — a three-argument call still works. */
export function blockedParticipants(home, task, participants, sessions = snapshotOf(participants)) {
  return blockedIn(home, task, participants, sessions);
}

/** Participant session state: `alive` | `dead` | `unknown`. The default takes state for
 * exactly one participant — a snapshot is built from a list, this question needs none. */
export function participantSession(participant, sessions = snapshotOf([participant])) {
  return liveParticipant(participant, sessions);
}

/** Why `participantSession` said `unknown`: the observer's failure named apart from the session's.
 * [03-cli.md § Status, done, sweep](../docs/reference/03-cli.md#status-done-sweep-dismiss-history-prune) */
export function unknownWhy(participant, sessions, driver) {
  if (!sessionRefOf(participant)) {
    return 'its record carries no session reference, so there is no session to ask about';
  }
  if (sessions === null) return `its harness registry could not be read: ${driver.phrases.unreadable}`;
  return sessions[addressOf(participant)]?.stall?.reason || 'there is nobody to ask about it';
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

// The socket ADDRESS may carry a `#<n>` suffix (Codex names a thread on one file); the
// path is what is before it. Checking the raw string calls every live Codex point gone.
export function contactSocketPath(socket) {
  return typeof socket === 'string' && socket ? socket.split('#')[0] : null;
}

// Whether the file's socket is still on disk. The `pid` in the file is NOT a liveness handle:
// `writeWake` stores `process.pid` of whoever wrote it, which for Claude is the exiting hook.
export function contactSocketGone(wake) {
  const p = contactSocketPath(wake?.socket);
  return p ? !existsSync(p) : false;
}

export function orchestratorSocketGone(wake, h, owner) {
  const aboutOwner = !wake?.session || !owner || sameOwnerSession(wake.session, owner);
  if (wake?.socket && contactSocketGone(wake) && aboutOwner) return true;
  if (h.knockError !== 'ENOENT' || !aboutOwner) return false;
  if (wake?.at && h.triedAt && h.triedAt < wake.at) return false;
  return true;
}

export function orchestratorDeadLine(owner, since) {
  return `owner ${owner} is dead since ${since} — a successor in the same root takes the mailbox claim`;
}

export function wardenDeadLine(meta, host, reason, unread = null) {
  if (host == null) throw new Error('wardenDeadLine: host is required');
  const title = meta.title ? ` "${meta.title}"` : '';
  const lift = host.busCommand(['warden', `--task ${meta.id}`]);
  const mail = unread ? `, unread ${unread}` : '';
  return `${WARDEN_MARK}: task ${meta.id}${title}: the warden exited (${reason})${mail} — raise it: ${lift}`;
}

export function wardenPriorExitLine(meta, reason, unread = null) {
  const title = meta.title ? ` "${meta.title}"` : '';
  const mail = unread ? `, unread ${unread}` : '';
  return `task ${meta.id}${title}: the previous warden exited (${reason})${mail} — a successor is watching now`;
}

// The three `self-wake` states.
// [guides/hooks-and-trust.md#the-three-self-wake-states](../docs/guides/hooks-and-trust.md#the-three-self-wake-states)
const SELF_WAKE_PROGNOSIS = {
  starting: 'starting up; clears on the first knock',
  taken: 'clears when the address\'s own session takes the point back, and not at all if that session is gone',
  refused: 'it stays until the channel accepts',
};

function selfWakeSuffix(h, wake) {
  const state = Object.hasOwn(SELF_WAKE_PROGNOSIS, h.selfWake) ? h.selfWake : (wake?.socket ? null : 'starting');
  if (!state) return '';
  // Only the refusing branch has a channel, named as the warden journal names it.
  const channel = state === 'refused' && h.selfWakeChannel ? `${h.selfWakeChannel} refused, ` : '';
  return ` — ${channel}${SELF_WAKE_PROGNOSIS[state]}`;
}

// How the warden wakes a participant and whether they stay silent past the threshold — all
// escalation visibility.
function wakePart(home, id, addr, participant, unread) {
  const parts = [];
  const wake = readWake(home, id, addr);
  const h = readHealth(home, id)[addr] ?? {};
  if (addr === ORCHESTRATOR && orchestratorSocketGone(wake, h, taskOwner(home, id))) {
    const owner = taskOwner(home, id) ?? 'nobody';
    const since = h.triedAt ?? h.since ?? wake?.at ?? 'unknown';
    // Not "self-wake": there is nothing to wake the orchestrator with, and a successor in
    // the root otherwise does not see the route until they call mailbox themselves.
    parts.push(orchestratorDeadLine(owner, since));
  } else if (h.channel === 'pull') {
    // A pull participant polls; the warden never knocks for it, so no self-wake prognosis
    // applies. Judged before the fallback, which reads a missing socket as a fresh start.
    parts.push('alarm: pull — the participant polls its own mailbox; the warden does not knock');
  } else if (h.channel === 'self-wake' || !wake?.socket) {
    // The reason is verbatim, not the journal's phrase: two of the three fallbacks never
    // reached a delivery channel. This line is the refusal's only place outside the journal.
    parts.push(`alarm: self-wake${h.knockError ? ` (reason: ${h.knockError})` : ''}`
      + selfWakeSuffix(h, wake));
  } else {
    // `socket` in health is the transport this line has long called socket. Any other
    // channel prints as-is: an inject/rpc point is also `socket` in the field, but is not one.
    const label = !h.channel || h.channel === 'socket' ? 'socket' : h.channel;
    // A contact point outlives its session, so the line says what was checked rather than
    // letting "handed over" read as "reachable" (PB-175). 03-cli § Status, done… carries why.
    const gone = contactSocketGone(wake) ? ' — STALE: the socket it names is gone' : '';
    parts.push(`alarm: ${label} handed over ${wake.at}${h.knocks ? `, knocks ${h.knocks}` : ''}${gone}`);
  }
  if (Array.isArray(h.unreadableRefs) && h.unreadableRefs.length) {
    parts.push(`unreadable refs: ${h.unreadableRefs.join(', ')}`);
  }
  if (h.hold && unread) parts.push(`knocks held: the harness named a reset — ${resetText(h.hold)}`);
  if (h.escalatedAt) parts.push(`SILENT since ${h.since} (escalated ${h.escalatedAt})`);
  // The opposite state — only on an EMPTY mailbox, and it claims nothing about the
  // session: [03-cli.md § Guard and warden](../docs/reference/03-cli.md).
  const owed = unread === 0 ? unansweredSince(home, id, addr, participant) : null;
  if (owed) parts.push(`${UNANSWERED_MARK} since ${owed} — the turn ended with nothing sent on the bus`);
  return parts;
}

// Header of a bad participant record. Cited verbatim by prose, so it lives as a constant:
// the consumer CLI's contract-quote gate reads it through the package.
export const MAILBOX_UNREAD_MARK = 'MAILBOX UNREAD';

// Unread counter under try/catch: `addrDir` throws on an unknown address, and one broken
// record would take the whole `status` with it. Name the bad one out loud and move on.
function unreadPart(home, id, addr) {
  try {
    const unread = countInbox(home, id, addr);
    return { unread, line: `unread ${unread}` };
  } catch (e) {
    return { unread: null, line: `${MAILBOX_UNREAD_MARK}: the record address is invalid (${e.message})` };
  }
}

export function status(rootOrHost, { task, sessions = undefined } = {}) {
  const host = hostOf(rootOrHost);
  const home = host.promptobusHome();
  const tasks = task ? [readTask(home, task)] : activeTasks(home);
  if (!tasks.length) {
    const all = listTasks(home);
    ok(`no active tasks${all.length ? ` (total in the journal: ${all.length})` : ''}`);
    return;
  }
  const session = sessionIdentity();
  for (const meta of tasks) {
    // One snapshot per call, not per task: addresses of different tasks coincide. The
    // default tells `undefined` ("not supplied") from `null` ("the list was not parsed").
    const snap = sessions === undefined ? snapshotOf(meta.participants) : sessions;
    ok(`${meta.id} · ${meta.title} · ${meta.status}`);
    // A foreign task. No gate — `status` only reads — but not silence either: a session
    // that resolved "the only active one" would read a foreign task as its own.
    const own = ownership(home, meta.id, ORCHESTRATOR, session);
    if (own.gated) warn(`${foreignTaskLine(meta, own)} — this session is looking at a foreign run.`);
    // The warden comes before the participant list: its death explains the silence of
    // the lines below.
    const wdn = wardenLine(home, meta.id, host);
    if (wdn.alive) info(wdn.line);
    else warn(wdn.line);
    const counts = tallies(home, meta.id);
    for (const p of meta.participants ?? []) {
      // Mechanism fields live in the v1 record `metadata`; the record's own fields are
      // role, harness, mode, session reference and capabilities.
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
      // The reviewer's diff file is a snapshot: its time, worktree HEAD and tracked-tree
      // state are the same facts the `task` reply prints.
      if (m.diffAt) {
        const modified = Array.isArray(m.diffModifiedTracked) ? m.diffModifiedTracked : [];
        const tree = m.diffClean === true ? ', tracked tree clean'
          : m.diffClean === false
            ? `, tracked tree dirty${modified.length ? ` (modified tracked paths: ${modified.join(', ')})` : ''}`
            : '';
        parts.push(`diff snapshot ${m.diffAt}${m.diffHead ? ` at ${m.diffHead}` : ''}${tree}`);
      }
      // The decision is read through the accessor, not out of the map: adapter fields on
      // the record have one door, and this is it.
      const routed = routingLine(routingOf(p));
      if (routed) parts.push(routed);
      const mail = unreadPart(home, meta.id, addr);
      parts.push(mail.line);
      const history = harnessHistoryOf(m);
      let tally = counts.get(p.id);
      if (history.length) {
        const floor = stampMs(history[history.length - 1].until);
        tally = tallies(home, meta.id, { from: floor }).get(p.id);
        parts.push(`harness ${p.harness}`);
        for (let i = 0; i < history.length; i++) {
          const gen = history[i];
          const prior = tallies(home, meta.id, historyCountWindow(history, i)).get(p.id);
          const countsLine = prior && (prior.reviewRounds || prior.questions || prior.resultCount)
            ? `rounds ${prior.reviewRounds} · questions ${prior.questions} · results ${prior.resultCount}`
            : null;
          parts.push(countsLine
            ? `prior harness ${gen.harness} until ${gen.until}: ${countsLine}`
            : `re-bound from ${gen.harness} at ${gen.until}`);
        }
      }
      if (tally && (tally.reviewRounds || tally.questions || tally.resultCount)) {
        parts.push(`rounds ${tally.reviewRounds} · questions ${tally.questions} · results ${tally.resultCount}`);
      }
      try {
        parts.push(...wakePart(home, meta.id, addr, p, mail.unread));
      } catch {
        // A bad record has no right to take the other lines with it.
      }
      // Dismissal from watch is visible here and only here: without the line, silence of
      // reports is indistinguishable from a broken warden.
      if (m.dismissed) parts.push(`DISMISSED FROM WATCH ${m.dismissed} — no reports about their session`);
      if (m.name) {
        const hasSessionRef = (typeof m.session === 'string' && m.session.trim().length > 0)
          || (typeof m.sessionId === 'string' && m.sessionId.trim().length > 0);
        if (!hasSessionRef) {
          parts.push(m.session === null || m.sessionId === null
            ? 'session reference was not recorded at write time'
            : 'participant record is incomplete: no session reference');
        }
        const view = snap?.[addr] ?? null;
        // Words about the session belong to that participant's driver. The fallback to the
        // lift driver is what keeps a foreign harness from taking the whole print with it.
        const driver = driverOrLift(p);
        // We name the session — it does not match the branch name, and without it the
        // participant cannot be found by eye in the harness session registry.
        if (snap === null) parts.push(`session state "${m.name}" is unknown (${driver.phrases.unreadable})`);
        // Nobody to ask: no driver for its harness, or that driver does not look. Unknown,
        // not "no session" — saying it is not listed would call for starting it again.
        else if (view?.state === 'unknown') {
          parts.push(`session state "${m.name}" is unknown: harness "${p.harness}" — `
            + (view.stall?.reason || 'there is nobody to ask about it'));
        } else if (!view || view.state === 'gone') parts.push(`session "${m.name}" is not in the list`);
        else if (view.state === 'stale' && justSpawned(p)) {
          // Same registration window: "start again" is wrong on something just started.
          parts.push(`session "${m.name}" is starting — spawn just happened, pid is not announced yet;`
            + ` state will be visible in a few seconds`);
        } else if (view.state === 'stale') {
          parts.push(`session "${m.name}" is LISTED, but there is no process behind it — the record outlived its daemon.`
            + ` Check: ${driver.phrases.logs(view.id ?? m.name)}. There will be no messages from it`);
        } else if (stallStands(home, meta.id, p, view.stall)) {
          const stalled = {
            ...view.stall, address: addr, repoAbs: m.repoAbs, harness: p.harness, id: view.id ?? m.name, ref: m.name,
          };
          parts.push(`session "${m.name}" ${stallWord(view.stall)}: ${view.stall.reason} — `
            + stallRouteOf({
              ...stalled, ...routeHints(host, { ...stalled, task: meta.id }),
            }, meta.id));
        } else if (view.stall) {
          // A normal end of turn, and it needs its own words precisely because `blocked`
          // here is not a sign of life.
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

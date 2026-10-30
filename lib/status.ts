import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn } from './util.js';
import { hostOf } from './host.js';
import { pipelineOf, pipelineText } from '../dist/pipeline.js';
import {
  addressOf, busService, canonicalPath, foreignTaskLine, listTasks, liveWarden, mailboxOf,
  ORCHESTRATOR, ownership, participantOf, participantSlots, readHealth, readTask, readWake, sameOwnerSession, sessionIdentity,
  taskOwner, WARDEN_BEAT_SEC, tailWardenLog,
} from './store.js';
import {
  APPROVER, blockedParticipants as blockedIn, justSpawned, liveParticipant, mailboxPart, resetText, REVIEWER, routingOf,
  sessionRefOf, stallStands,
} from '../dist/index.js';
import { routingLine } from './models.js';
import { historyCountWindow, tallies } from './model-routing/telemetry.js';
import { branchLine, worktreeBranch } from './worktree.js';
import { driverOrLift, liftDriver, snapshotOf, stallRouteOf } from './drivers.js';
import { stallLine as lineOf, stallWord } from './stalls.js';
import { UNANSWERED_MARK, answerOwedSince, unansweredSince } from './answers.js';
import { leaseLines } from './lease.js';

import type { DeclaredStep, NamedReset, ParticipantV1, PromptobusHost, SessionSnapshot, StalledParticipant, TaskV1, Wake } from '../dist/index.js';
import type { LibDriver } from './driver-runtime.js';

type StatusHost = Partial<Pick<PromptobusHost, 'busCommand' | 'promptobusHome'>>;
type TaskTitle = Pick<TaskV1, 'id'> & Partial<Pick<TaskV1, 'title'>>;
type WakeContact = Partial<Pick<Wake, 'socket' | 'session' | 'at'>>;
type HealthEntry = Record<string, unknown>;
interface RouteHints { doneCommand?: string; statusCommand?: string; reviewCommand?: string }
interface HarnessHistoryRow { harness: string; until: unknown }
interface StatusOptions { task?: string; sessions?: SessionSnapshot }

// Bus participant state: how to name it for a person and print it. The predicates live in
// the package ([supervisor.ts](../src/supervisor.ts)); this file knows no harness name.

function stampMs(value: unknown) {
  const n = Date.parse((value ?? '') as string);
  return Number.isFinite(n) ? n : null;
}

function harnessHistoryOf(metadata: Record<string, unknown> | null | undefined) {
  const raw = metadata?.harnessHistory;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((row): row is HarnessHistoryRow => (row
    && typeof (row as { harness?: unknown }).harness === 'string'
    && (row as { harness?: unknown }).harness
    && stampMs((row as { until?: unknown }).until) !== null) as boolean);
}

// State-machine predicates — the door for the rest of the mechanism. Their snapshot shape
// is one, and so is its default: this CLI's snapshot.
export {
  commitStalls, pendingStalls, sessionBusy, stallStands, lastActivation, justSpawned, SPAWN_GRACE_SEC,
} from '../dist/index.js';
export { stallTail } from './stalls.js';

/** Line about a stalled participant: the state words are shared ([stalls.js](stalls.js)),
 * the route belongs to that participant's driver; direct driver seams may omit the hints. */
function routeHints(host: StatusHost | null, { address, repoAbs, harness, task }: Pick<StalledParticipant, 'address' | 'repoAbs' | 'harness'> & { task: string }) {
  if (typeof host?.busCommand !== 'function') return {};
  const hints: RouteHints = {
    doneCommand: host.busCommand(['done']),
    statusCommand: host.busCommand(['status']),
  };
  if (address?.startsWith(`${REVIEWER}:`)) {
    const args = ['review', `"${repoAbs ?? '<clone path>'}"`];
    if (harness === 'codex') args.push('--harness', 'codex');
    if (task) args.push(`--task ${task}`);
    hints.reviewCommand = host.busCommand(args);
  }
  if (address?.startsWith(`${APPROVER}:`)) {
    let subject: unknown = repoAbs;
    if (task && typeof host.promptobusHome === 'function') {
      try {
        const participant = (readTask(host.promptobusHome(), task).participants ?? [])
          .find((p) => addressOf(p) === address);
        subject = participant?.metadata?.reviewSubject ?? repoAbs;
      } catch {}
    }
    const args = ['review', `"${subject ?? '<clone path>'}"`, '--approver'];
    if (task) args.push(`--task ${task}`);
    hints.reviewCommand = host.busCommand(args);
  }
  if (address === 'reporter' && task) {
    hints.reviewCommand = host.busCommand(['report', `--task ${task}`]);
  }
  return hints;
}

export function stallLine(s: StalledParticipant, task: string, host: StatusHost | null = null) {
  return lineOf(s, stallRouteOf({ ...s, ...routeHints(host, { ...s, task }) }, task));
}
/** Task participants from whom no messages should be expected. The fourth argument is the
 * session snapshot, and the default builds it — a three-argument call still works. */
export function blockedParticipants(home: string, task: string, participants: ParticipantV1[] | null | undefined, sessions: SessionSnapshot = snapshotOf(participants)) {
  return blockedIn(home, task, participants, sessions, participantSlots(home, task));
}

/** Participant session state: `alive` | `dead` | `unknown`. The default takes state for
 * exactly one participant — a snapshot is built from a list, this question needs none. */
export function participantSession(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot = snapshotOf([participant!])) {
  return liveParticipant(participant, sessions);
}

/** Whether this participant's harness reports the session dead. Unknown is not death. */
export function sessionReportedDead(participant: ParticipantV1 | null | undefined) {
  return participantSession(participant) === 'dead';
}

/** Why `participantSession` said `unknown`: the observer's failure named apart from the session's.
 * [03-cli.md § Status, done, sweep](../docs/reference/03-cli.md#status-done-sweep-dismiss-history) */
export function unknownWhy(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot, driver: { phrases: Pick<LibDriver['phrases'], 'unreadable'> }) {
  if (!sessionRefOf(participant)) {
    return 'its record carries no session reference, so there is no session to ask about';
  }
  if (sessions === null) return `its harness registry could not be read: ${driver.phrases.unreadable}`;
  return sessions[addressOf(participant) as string]?.stall?.reason || 'there is nobody to ask about it';
}

export const WARDEN_MARK = 'NO WARDEN';

export function wardenLine(home: string, id: string, host: Pick<PromptobusHost, 'busCommand'> | null | undefined) {
  if (host == null) throw new Error('wardenLine: host is required');
  let lifter = liftDriver();
  try { lifter = driverOrLift(participantOf(readTask(home, id), ORCHESTRATOR)); } catch {}
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
export function contactSocketPath(socket: unknown) {
  return typeof socket === 'string' && socket ? socket.split('#')[0] : null;
}

// Whether the file's socket is still on disk. The `pid` in the file is NOT a liveness handle:
// `writeWake` stores `process.pid` of whoever wrote it, which for Claude is the exiting hook.
export function contactSocketGone(wake: { socket?: unknown } | null | undefined) {
  const p = contactSocketPath(wake?.socket);
  return p ? !existsSync(p) : false;
}

export function orchestratorSocketGone(wake: WakeContact | null | undefined, h: HealthEntry, owner: string | null | undefined) {
  const aboutOwner = !wake?.session || !owner || sameOwnerSession(wake.session, owner);
  if (wake?.socket && contactSocketGone(wake) && aboutOwner) return true;
  if (h.knockError !== 'ENOENT' || !aboutOwner) return false;
  if (wake?.at && h.triedAt && (h.triedAt as string) < wake.at) return false;
  return true;
}

export function orchestratorDeadLine(owner: unknown, since: unknown) {
  return `owner ${owner} is dead since ${since} — a successor in the same root takes the mailbox claim`;
}

export function wardenDeadLine(meta: TaskTitle, host: Pick<PromptobusHost, 'busCommand'> | null | undefined, reason: unknown, unread: number | null = null) {
  if (host == null) throw new Error('wardenDeadLine: host is required');
  const title = meta.title ? ` "${meta.title}"` : '';
  const lift = host.busCommand(['warden', `--task ${meta.id}`]);
  const mail = unread ? `, unread ${unread}` : '';
  return `${WARDEN_MARK}: task ${meta.id}${title}: the warden exited (${reason})${mail} — raise it: ${lift}`;
}

export function wardenPriorExitLine(meta: TaskTitle, reason: unknown, unread: number | null = null) {
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

function selfWakeSuffix(h: HealthEntry, wake: WakeContact | null) {
  const state = Object.hasOwn(SELF_WAKE_PROGNOSIS, h.selfWake as PropertyKey) ? h.selfWake as keyof typeof SELF_WAKE_PROGNOSIS : (wake?.socket ? null : 'starting');
  if (!state) return '';
  // Only the refusing branch has a channel, named as the warden journal names it.
  const channel = state === 'refused' && h.selfWakeChannel ? `${h.selfWakeChannel} refused, ` : '';
  return ` — ${channel}${SELF_WAKE_PROGNOSIS[state]}`;
}

// How the warden wakes a participant and whether they stay silent past the threshold — all
// escalation visibility.
function wakePart(home: string, id: string, addr: string, participant: ParticipantV1, unread: number | null) {
  const parts = [];
  const wake = readWake(home, id, addr);
  const h = (readHealth(home, id)[addr] ?? {}) as HealthEntry;
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
  } else if (!wake?.socket && justSpawned(participant) && h.channel !== 'self-wake') {
    // No point yet inside the spawn grace; a recorded self-wake refusal still prints below.
    parts.push(`alarm: awaiting the handover of the session lifted ${participant.metadata.started}`);
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
    // letting "handed over" read as "reachable". 03-cli § Status, done… carries why.
    const gone = contactSocketGone(wake) ? ' — STALE: the socket it names is gone' : '';
    parts.push(`alarm: ${label} handed over ${wake!.at}${h.knocks ? `, knocks ${h.knocks}` : ''}${gone}`);
  }
  if (Array.isArray(h.unreadableRefs) && h.unreadableRefs.length) {
    parts.push(`unreadable refs: ${h.unreadableRefs.join(', ')}`);
  }
  if (h.hold && unread) parts.push(`knocks held: the harness named a reset — ${resetText(h.hold as NamedReset)}`);
  if (h.asking && unread) parts.push(`knocks held: the turn waits on its user since ${h.asking}`);
  if (h.escalatedAt) parts.push(`SILENT since ${h.actionableSince ?? h.since} (escalated ${h.escalatedAt})`);
  // A user question is visible at once; ordinary participant debt waits for an empty mailbox
  // and a turn end. [03-cli.md § Guard and warden](../docs/reference/03-cli.md).
  const owed = addr === ORCHESTRATOR ? answerOwedSince(home, id, addr, participant)
    : unread === 0 ? unansweredSince(home, id, addr, participant) : null;
  if (owed) parts.push(`${UNANSWERED_MARK} since ${owed} — ${addr === ORCHESTRATOR
    ? "the person's question awaits an answer to user" : 'the turn ended with nothing sent on the bus'}`);
  return parts;
}

// A later handshake the session record refused — 02-host § Session identity.
function handshakeRefusal(file: unknown) {
  let record: { refused?: unknown; sessionId?: unknown } | null = null;
  try { record = typeof file === 'string' && file ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch {}
  const refused = Array.isArray(record?.refused) ? (record.refused as unknown[]).filter((r) => (r as { session?: unknown } | null)?.session) : [];
  if (!refused.length) return null;
  const last = refused[refused.length - 1] as { session: unknown; at?: unknown };
  return `HANDSHAKE REFUSED: session ${last.session} presented this participant's session record at ${last.at}, `
    + `bound to ${record!.sessionId}${refused.length > 1 ? ` (${refused.length} sessions refused)` : ''}`;
}

// Header of a bad participant record. Cited verbatim by prose, so it lives as a constant:
// the consumer CLI's contract-quote gate reads it through the package.
export const MAILBOX_UNREAD_MARK: string = 'MAILBOX UNREAD';

// Unread counter under try/catch: `addrDir` throws on an unknown address, and one broken
// record would take the whole `status` with it. Name the bad one out loud and move on.
function unreadPart(home: string, id: string, addr: string) {
  try {
    const box = mailboxOf(home, id, addr);
    const unread = box.alias ? null : busService.countMailbox(home, id, addr);
    return { unread, alias: box.alias, line: mailboxPart(busService, home, id, addr) };
  } catch (e) {
    return { unread: null, line: `${MAILBOX_UNREAD_MARK}: the record address is invalid (${(e as Error).message})` };
  }
}

function participantsInPipelineOrder(participants: ParticipantV1[] | null | undefined, pipeline: readonly DeclaredStep[]) {
  const order = new Map(pipeline.map((step, index) => [step.name, index]));
  const pieces = new Map<string, { p: ParticipantV1; index: number }[]>();
  const slots: { p: ParticipantV1; index: number }[][] = [];
  for (const p of participants ?? []) {
    const address = addressOf(p);
    const colon = address?.indexOf(':') ?? -1;
    const index = colon < 0 ? undefined : order.get(address!.slice(0, colon));
    if (index === undefined) {
      slots.push([{ p, index: 0 }]);
      continue;
    }
    const slug = address!.slice(colon + 1);
    let piece = pieces.get(slug);
    if (!piece) {
      piece = [];
      pieces.set(slug, piece);
      slots.push(piece);
    }
    piece.push({ p, index });
  }
  return slots.flatMap((slot) => slot.sort((a, b) => a.index - b.index).map(({ p }) => p));
}

export function status(rootOrHost: unknown, { task, sessions = undefined }: StatusOptions = {}) {
  const host = hostOf(rootOrHost);
  const pipeline = pipelineOf(host);
  const home = canonicalPath(host.promptobusHome());
  const all = listTasks(home);
  const selected = task ? [readTask(home, task)] : all.filter((meta) => meta.status === 'active' && !meta.parent);
  const visible = new Set(selected.map((meta) => meta.id));
  const roots = task ? selected : [...selected, ...all.filter((meta) => meta.status === 'active'
    && meta.parent && !visible.has(meta.parent))];
  const tasks = roots.flatMap((meta) => meta.parent
    ? [{ meta, depth: 0 }]
    : [{ meta, depth: 0 }, ...all.filter((child) => child.parent === meta.id)
      .map((child) => ({ meta: child, depth: 1 }))]);
  // Machine-wide, so it heads the print whether or not a task is active.
  for (const line of leaseLines()) info(line);
  if (!tasks.length) {
    ok(`no active tasks${all.length ? ` (total in the journal: ${all.length})` : ''}`);
    return;
  }
  const session = sessionIdentity();
  for (const { meta, depth } of tasks) {
    const indent = '  '.repeat(depth);
    const line = (write: (value: string) => unknown, value: string) => write(`${indent}${value.replaceAll('\n', `\n${indent}`)}`);
    // One snapshot per call, not per task: addresses of different tasks coincide. The
    // default tells `undefined` ("not supplied") from `null` ("the list was not parsed").
    const snap = sessions === undefined ? snapshotOf(meta.participants) : sessions;
    line(ok, `${meta.id} · ${meta.title} · ${meta.status}`
      + `${meta.parent ? ` · parent ${meta.parent}` : ''} · pipeline ${pipelineText(pipeline)}`);
    // A foreign task. No gate — `status` only reads — but not silence either: a session
    // that resolved "the only active one" would read a foreign task as its own.
    const own = ownership(home, meta.id, ORCHESTRATOR, session);
    if (own.gated) line(warn, `${foreignTaskLine(meta, own)} — this session is looking at a foreign run.`);
    // The warden comes before the participant list: its death explains the silence of
    // the lines below.
    const wdn = wardenLine(home, meta.id, host);
    if (wdn.alive) line(info, wdn.line);
    else line(warn, wdn.line);
    const counts = tallies(home, meta.id);
    for (const p of participantsInPipelineOrder(meta.participants, pipeline)) {
      // Mechanism fields live in the v1 record `metadata`; the record's own fields are
      // role, harness, mode, session reference and capabilities.
      const m = p.metadata ?? {};
      const addr = addressOf(p);
      const parts: unknown[] = [addr];
      // The only place a person can check which session the mailbox is bound to.
      if (m.owner) parts.push(`owner ${m.owner}`);
      if (addr?.startsWith('peer:') && m.peerTask) parts.push(`peer task ${m.peerTask}`);
      if (addr?.startsWith('root:') && m.rootTask) parts.push(`stands for the orchestrator of root task ${m.rootTask}`);
      if (m.repo) parts.push(m.repo);
      if (m.childTask) parts.push(`child task ${m.childTask}`);
      // The worktree path is the argument of `promptobus review <path>`; that is where
      // the journal stores it.
      if (m.worktree) parts.push(`worktree ${m.worktree}`);
      // Git names the branch, not the journal: a worker may have moved to their own on a
      // brief request.
      if (m.branch || m.worktree) {
        const line = branchLine(m.branch as string | null | undefined, worktreeBranch(m.worktree as string | null | undefined));
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
      const mail = unreadPart(home, meta.id, addr as string);
      parts.push(mail.line);
      const history = harnessHistoryOf(m);
      let tally = counts.get(p.id);
      if (history.length) {
        const floor = stampMs(history[history.length - 1].until);
        tally = tallies(home, meta.id, { from: floor }).get(p.id);
        parts.push(`harness ${p.harness}`);
        for (let i = 0; i < history.length; i++) {
          const gen = history[i];
          const prior = tallies(home, meta.id, historyCountWindow(history as { until?: string }[], i)).get(p.id);
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
        // An address alias has no channel of its own; the primary address's line carries it.
        if (!mail.alias) parts.push(...wakePart(home, meta.id, addr as string, p, mail.unread));
      } catch {
        // A bad record has no right to take the other lines with it.
      }
      const refused = handshakeRefusal(m.sessionRecord);
      if (refused) parts.push(refused);
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
        const view = snap?.[addr as string] ?? null;
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
            + ` Check: ${driver.phrases.logs((view.id ?? m.name) as string)}. There will be no messages from it`);
        } else if (stallStands(home, meta.id, p, view.stall)) {
          const stalled = {
            ...view.stall!, address: addr as string, repoAbs: m.repoAbs as string | null, harness: p.harness, id: (view.id ?? m.name) as string, ref: m.name as string,
          };
          parts.push(`session "${m.name}" ${stallWord(view.stall!)}: ${view.stall!.reason} — `
            + stallRouteOf({
              ...stalled, ...routeHints(host, { ...stalled, task: meta.id }),
            }, meta.id));
        } else if (view.stall) {
          // A normal end of turn, and it needs its own words precisely because `blocked`
          // here is not a sign of life.
          parts.push(`session "${m.name}" finished the turn, waiting for a message`);
        } else parts.push(`session "${m.name}" is alive (${view.note ?? 'running'})`);
      }
      line(info, `${depth ? '  ' : ''}${parts.join(' · ')}`);
    }
    // Warden journal tail: the "SILENT" line names the fact, not the history.
    const tail = tailWardenLog(home, meta.id);
    if (tail.length) line(info, `warden journal (last ${tail.length}):\n    ${tail.join('\n    ')}`);
    line(info, `mail and artifacts: ${path.join(home, 'tasks', meta.id)}`);
  }
}

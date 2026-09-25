// The warden state machine: what is here and what is not.
// [guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not](../docs/guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not)
import {
  beatWarden, lastTurnAt, logWarden, readHealth, readStalls, readWake, writeHealth, writeStalls,
} from './sidecar.js';
import type { Stalls, Wake } from './sidecar.js';
import {
  addressOf, dismissedOf, foreignSessionOf, ORCHESTRATOR, repoAbsOf, sessionIdOf, sessionOf, startedOf,
} from './protocol.js';
import { readArtifact } from './v1/artifacts.js';
import { countInbox, glanceInbox, lastSentAt } from './v1/messages.js';
import type { BrokenNote, FaultHook } from './v1/messages.js';
import type { MessageV1, ParticipantV1, TaskV1 } from './v1/model.js';
import { readTask } from './v1/store.js';
import { driverFor, harnessOf, pushes, resetAhead, resetText, sessionRefOf } from './driver.js';
import type {
  ActivateResult, ActivationTarget, Driver, NamedReset, Notification, NotificationMessage, Registry,
  SessionSnapshot, SessionStall, SessionView, StalledParticipant,
} from './driver.js';
// Polling mailboxes — a safety net for `fs.watch`, which loses events.
export const TICK_MS = 1000;

// Knock retry: the mailbox is still not taken — knock again. Two minutes are measured to the
// participant's turn, not the network: a long turn is allowed to stay silent for minutes.
export const KNOCK_RETRY_SEC = 120;

// Silence threshold: unread must not sit longer than this. Fifteen minutes means "not answering",
// not "thinking" — the mailbox is taken BEFORE the turn is inspected, not after.
export const SILENCE_SEC = 900;

// Working lifetime ceiling — only ends the warden process for an idle task; live work defers it.
export const WARDEN_TOTAL_SEC = 6 * 3600;

// Unconditional process ceiling — guards a forgotten run and a stuck delivery loop.
export const WARDEN_ABSOLUTE_SEC = 72 * 3600;

// How many consecutive round failures the process tolerates before exiting. One is a transient (a
// held task lock, a file rewritten underfoot); three in a row is not.
export const ROUND_FAIL_LIMIT = 3;

// Registration window for a freshly spawned session: spawn writes the participant BEFORE the
// session appears at the harness, and the gap means an unfinished start, not death.
export const SPAWN_GRACE_SEC = 30;

const NO_FAULT: FaultHook = () => {};

/** Which fallback put `channel` at `self-wake`; prognosis per state in [guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not](../docs/guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not) */
export type SelfWakeState = 'starting' | 'taken' | 'refused';

/** Health mark of one address. Fields are appended by the round, and read by it and by `promptobus status`. */
interface HealthMark {
  unread?: number;
  since?: string | null;
  knockedAt?: string | null;
  triedAt?: string | null;
  deliveredAt?: string | null;
  knocks?: number;
  knockedTo?: string | null;
  escalatedAt?: string | null;
  channel?: string | null;
  knockError?: string | null;
  // Only the round knows which branch it took. Absent on a record written before the
  // field: that is "not said", never one of the three.
  selfWake?: SelfWakeState | null;
  selfWakeChannel?: string | null;
  wake?: string | null;
  wakeSession?: string | null;
  unreadableRefs?: string[];
  // The named reset the knocks are held on; absent while nothing holds them.
  hold?: NamedReset;
  [key: string]: unknown;
}

function marksOf(health: Record<string, unknown>, addr: string): HealthMark {
  const v = health[addr];
  return (v && typeof v === 'object' ? v : {}) as HealthMark;
}

// The window is SYMMETRIC: spawn time is written by that machine's clock, and a clock set
// backwards would make a fresh record "from the future" with a negative age.
export function justSpawned(participant: ParticipantV1 | null | undefined, now: number = Date.now()): boolean {
  const at = Date.parse(String(startedOf(participant) ?? ''));
  return Number.isFinite(at) && Math.abs(now - at) < SPAWN_GRACE_SEC * 1000;
}

// When a turn was last STARTED: three marks, all meaning the participant was reached. A failed
// activation (`triedAt`) is left out — silence after it speaks of a deaf channel, not a stall.
export function lastActivation(home: string, task: string, participant: ParticipantV1 | null | undefined): number | null {
  const marks = marksOf(readHealth(home, task), String(addressOf(participant) ?? ''));
  const at = [startedOf(participant), marks.knockedAt, marks.deliveredAt]
    .map((v) => Date.parse(String(v ?? ''))).filter(Number.isFinite);
  return at.length ? Math.max(...at) : null;
}

/** Whether a dialog mark is a real prompt or the bus's own postcard held behind it.
 * [guides/hooks-and-trust.md#promptstands--whether-a-dialog-mark-is-a-permission-prompt-the-participant-is-standing-at](../docs/guides/hooks-and-trust.md#promptstands--whether-a-dialog-mark-is-a-permission-prompt-the-participant-is-standing-at) */
function promptStands(home: string, task: string, participant: ParticipantV1 | null | undefined): boolean {
  const turn = lastTurnAt(home, task, String(addressOf(participant) ?? ''));
  if (turn === null) return true;
  const since = lastActivation(home, task, participant);
  if (since === null) return true;
  if (turn <= since) return true;
  try {
    const sent = lastSentAt(home, task, String(participant?.id ?? ''));
    return sent === null || sent <= since;
  } catch {
    return true;
  }
}

/** What the snapshot knows about the participant's session. No ref — there is no session for the address at all. */
function viewOf(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): SessionView | null {
  if (sessions === null) return null;
  if (!sessionRefOf(participant)) return null;
  // There is a ref, but no record in the snapshot: the participant appeared
  // after the snapshot, or the session is gone.
  return sessions[String(addressOf(participant) ?? '')] ?? { state: 'gone', busy: false, stall: null, id: null };
}

/** The named reset that holds the address's knocks at `now`, or null: the harness refused the turn
 * and said when to retry. [03-cli.md § Guard and warden](../docs/reference/03-cli.md#guard-and-warden) */
export function heldReset(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot, now: number = Date.now()): NamedReset | null {
  const reset = viewOf(participant, sessions)?.stall?.reset ?? null;
  return resetAhead(reset, now) ? reset : null;
}

/** Participant session state: `alive` | `dead` | `unknown`. An unparsed snapshot, a record with no
 * session reference, and a participant nobody can be asked about are unknown, not death. */
export function liveParticipant(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): 'alive' | 'dead' | 'unknown' {
  if (!sessionRefOf(participant)) return 'unknown';
  const view = viewOf(participant, sessions);
  if (!view || view.state === 'unknown') return 'unknown';
  // The question is one: will we reach them. A record that outlived its process is unreachable
  // exactly like an absent one; `status` tells them apart, because a person needs the reason.
  return view.state === 'alive' ? 'alive' : 'dead';
}

/** Whether this is a stall for real: a SILENT end of turn, and `permission` has a check
 * [guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not](../docs/guides/hooks-and-trust.md#the-warden-state-machine-what-is-here-and-what-is-not) */
export function stallStands(home: string, task: string, participant: ParticipantV1 | null | undefined, stall: SessionStall | null | undefined): boolean {
  if (!home || !task) throw new Error('stallStands: home and task are required — the predicate reads the task store');
  if (!stall) return false;
  if (stall.kind === 'permission') return promptStands(home, task, participant);
  if (stall.kind !== 'unknown') return true;
  const since = lastActivation(home, task, participant);
  if (since === null) return true;
  let sent: number | null;
  try {
    sent = lastSentAt(home, task, String(participant?.id ?? ''));
  } catch {
    // A bad participant record has no right to lift the report of their stall.
    return true;
  }
  // A participant that has never spoken gets a grace window from `justSpawned`:
  // [guides/hooks-and-trust.md#stallstands--the-grace-window-before-a-participant-has-ever-spoken](../docs/guides/hooks-and-trust.md#stallstands--the-grace-window-before-a-participant-has-ever-spoken)
  if (sent === null) return !justSpawned(participant);
  return sent < since;
}

/** The address's contact point is held by a FOREIGN session, or null.
 * [guides/hooks-and-trust.md#waketakenby--the-addresss-contact-point-is-held-by-a-foreign-session--or-null-if](../docs/guides/hooks-and-trust.md#waketakenby--the-addresss-contact-point-is-held-by-a-foreign-session--or-null-if) */
export function wakeTakenBy(home: string, task: string, p: ParticipantV1 | null | undefined, endpoint?: Wake | null): string | null {
  const addr = addressOf(p);
  if (!addr) return null;
  // The record is read by the caller when they already have it: the round reads every contact point
  // every second. No argument — we read ourselves: the stall report goes past the round.
  const wake = endpoint === undefined ? readWake(home, task, addr) : endpoint;
  const held = wake?.session ?? null;
  // What is returned is the TAKER — the session from the contact point, not the one the address is
  // bound to: that is what the reason line names. The comparison rule is shared, with no copy.
  return held && foreignSessionOf(p, held) ? held : null;
}

/** The session the address is bound to in the journal — how to name it to a human. */
function heldBy(p: ParticipantV1 | null | undefined): string {
  return sessionIdOf(p) ?? sessionOf(p) ?? 'nobody';
}

/** Whether the participant's session is busy with a turn.
 * [guides/hooks-and-trust.md#sessionbusy--whether-the-participants-session-is-busy-with-a-turn](../docs/guides/hooks-and-trust.md#sessionbusy--whether-the-participants-session-is-busy-with-a-turn) */
export function sessionBusy(home: string, task: string, participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): boolean {
  // The branch is chosen by the KIND of participant, not by whether the snapshot found a session:
  // on emptiness a session-bearing participant would fall into the watchman branch and go silent.
  if (sessionRefOf(participant)) {
    const view = viewOf(participant, sessions);
    return view ? view.busy === true : false;
  }
  const turn = lastTurnAt(home, task, String(addressOf(participant) ?? ''));
  if (turn === null) return false;
  const since = lastActivation(home, task, participant);
  return since !== null && since > turn;
}

/** Task participants from whom no messages are to be expected; `null` means the state is unknown,
 * which is not "everyone is alive". "Listed, but no process" is checked BEFORE the stall. */
export function blockedParticipants(home: string, task: string, participants: ParticipantV1[] | null | undefined, sessions: SessionSnapshot): StalledParticipant[] | null {
  // The task store is asked on entry, not at the first stall: a call with a forgotten store would
  // stay silent until someone stalled, then throw inside a warden round or a `mailbox` reply.
  if (!home || !task) throw new Error('blockedParticipants: home and task are required — stall inspection reads the task store');
  if (sessions === null) return null;
  const stalled: StalledParticipant[] = [];
  // The record's harness travels into the report with it: the ROUTE is asked of the same driver
  // that inspected the state, and a second source of truth about the harness would drift in silence.
  const harnessOfRecord = (p: ParticipantV1) => (
    typeof p.harness === 'string' && p.harness.trim() ? p.harness.trim() : null);
  for (const p of participants ?? []) {
    const ref = sessionRefOf(p);
    if (!ref) continue;
    // A participant taken off watch does not enter the report at all. Watch is lifted as a whole:
    // a filter on the outcome would make silence depend on a race of two orchestrator commands.
    if (dismissedOf(p)) continue;
    const view = viewOf(p, sessions)!;
    // Nobody to ask about them — no driver for their harness, or that driver does not inspect. Stay
    // silent: a made-up "GONE" would call for raising a session that is still working.
    if (view.state === 'unknown') continue;
    const repoAbs = repoAbsOf(p);
    // No record at all is also a report: a participant stopped by a person and a failed spawn would
    // otherwise be invisible. Its own state, not `stale` — there is no trace of a session.
    if (view.state === 'gone') {
      if (justSpawned(p)) continue;
      stalled.push({
        address: String(addressOf(p)),
        ref,
        // Last known id from the journal: there is no session behind it,
        // but its directory lives longer.
        id: sessionOf(p),
        repoAbs,
        harness: harnessOfRecord(p),
        kind: 'gone',
        // Words about a vanished record belong to the driver: it alone knows where it went missing
        // and what that is called at its harness. It did not say — we speak neutrally.
        reason: view.stall?.reason ?? 'the harness has no session record',
      });
      continue;
    }
    if (view.state === 'stale') {
      // A fresh record is not a ghost: stay silent entirely, the "reported"
      // mark is not laid either.
      if (justSpawned(p)) continue;
      stalled.push({
        address: String(addressOf(p)),
        ref,
        id: view.id,
        // The clone directory is needed by the route: the reviewer is
        // raised from it, not by a worker spawn.
        repoAbs,
        harness: harnessOfRecord(p),
        kind: 'stale',
        // The reason says only what is new: "listed, but there is no
        // process" will be said by the caller.
        reason: view.stall?.reason ?? 'the record outlived its process',
      });
      continue;
    }
    // An ordinary end of turn is not a stall, and the task store decides that, not the snapshot:
    // home and task are required for exactly this.
    if (stallStands(home, task, p, view.stall)) {
      stalled.push({
        address: String(addressOf(p)),
        ref,
        id: view.id,
        repoAbs,
        harness: harnessOfRecord(p),
        kind: view.stall!.kind,
        reason: view.stall!.reason,
        ...(view.stall!.reset ? { reset: view.stall!.reset } : {}),
      });
      continue;
    }
    // The session works but nothing can reach it: another session holds its contact point. Checked
    // LAST — a dead record is the larger trouble — and the registration window covers a re-spawn.
    const taken = justSpawned(p) ? null : wakeTakenBy(home, task, p);
    if (taken) {
      stalled.push({
        address: String(addressOf(p)),
        ref,
        id: view.id,
        repoAbs,
        harness: harnessOfRecord(p),
        kind: 'wake-taken',
        reason: `contact point is held by session ${taken}, while the address is bound to ${heldBy(p)}`,
      });
    }
  }
  return stalled;
}

// The mark of reported stalls lives in the task store (`readStalls`/`writeStalls`):
// without it the report would repeat every round, burning turn after turn at the addressee.

/** What is new among the stalls, WITHOUT the mark — the caller sets it. `current === null` means
 * session state was not inspected, which is not "there are no stalls". */
export function pendingStalls(home: string, task: string, probe: (ps: ParticipantV1[] | undefined) => StalledParticipant[] | null, { now = Date.now(), retryMs = 0, maxTries = 1 } = {}): {
  fresh: StalledParticipant[]; current: Stalls | null;
} {
  const stalled = probe(readTask(home, task).participants);
  if (stalled === null) return { fresh: [], current: null };
  const reported = readStalls(home, task);
  const current: Stalls = {};
  const fresh: StalledParticipant[] = [];
  for (const s of stalled) {
    const reason = `${s.ref}|${s.reason}`;
    const was = reported[s.address];
    const same = was?.reason === reason;
    const at = Date.parse(was?.at ?? '');
    const tries = Number(was?.tries) || 0;
    const again = retryMs > 0 && tries < maxTries && Number.isFinite(at) && now - at >= retryMs;
    if (same && !again) {
      current[s.address] = was!;
      continue;
    }
    fresh.push(s);
    current[s.address] = { reason, at: new Date(now).toISOString(), tries: same ? tries + 1 : 1 };
  }
  return { fresh, current };
}

/** Mark what was reported. The state is already like this — do not touch the journal: a write would cost disk. */
export function commitStalls(home: string, task: string, current: Stalls | null): void {
  if (current === null) return;
  if (JSON.stringify(readStalls(home, task)) === JSON.stringify(current)) return;
  writeStalls(home, task, current);
}

/** Whom the warden still has reason to watch: only participants with a session reference, since a
 * person's session is observable from nowhere. Unknown is not taken as dead, nor is a fresh spawn. */
export function liveWatched(home: string, task: string, sessions: SessionSnapshot): string[] {
  let meta;
  try {
    meta = readTask(home, task);
  } catch {
    return [];
  }
  if (meta.status !== 'active') return [];
  const named = (meta.participants ?? []).filter((p) => addressOf(p) && sessionRefOf(p));
  if (!named.length) return [];
  return named
    .filter((p) => justSpawned(p) || liveParticipant(p, sessions) !== 'dead')
    .map((p) => String(addressOf(p)));
}

// Whether the task has unread — at any of its addresses.
function unreadLeft(home: string, task: string): boolean {
  let meta;
  try {
    meta = readTask(home, task);
  } catch {
    return false;
  }
  return (meta.participants ?? []).some((p) => {
    if (!p?.id) return false;
    try {
      return countInbox(home, task, p.id) > 0;
    } catch {
      return false;
    }
  });
}

/** Heartbeat: renew our mark and check three reasons to exit. Lifted out of the loop for the test —
 * checking a branch inside the loop would have cost the suite half an hour of waiting. */
export function beatRound(home: string, task: string, startedMs: number, { now = Date.now(), sessions = null as SessionSnapshot, session = null as string | null } = {}): string | null {
  // A successor intercepted the mark — two cannot watch, and they continue the work. Session
  // identity goes to the lock: whose process holds the journal is known to the environment.
  if (!beatWarden(home, task, { session })) return 'another process took the warden place';
  const live = liveWatched(home, task, sessions);
  const unread = unreadLeft(home, task);
  const idle = !live.length && !unread;
  if (now - startedMs >= WARDEN_ABSOLUTE_SEC * 1000) {
    return `hit the absolute limit ${Math.round(WARDEN_ABSOLUTE_SEC / 3600)} h`;
  }
  if (idle) {
    if (now - startedMs >= WARDEN_TOTAL_SEC * 1000) {
      return `sat out the overall ceiling ${Math.round(WARDEN_TOTAL_SEC / 3600)} h`;
    }
    return 'no live participants remain';
  }
  return null;
}

/** Message extract for a notification. The sender is named by ADDRESS and the artifact by FILENAME:
 * a record id or a metadata id would be a machine tail instead of a name. Both come from the journal. */
function previewOf(home: string, meta: TaskV1, m: MessageV1): NotificationMessage {
  const sender = meta.participants.find((p) => p.id === m.sender);
  let artifact: string | null = null;
  if (m.artifact) {
    try {
      artifact = readArtifact(home, m.task, m.artifact).filename;
    } catch {
      // Artifact metadata did not read — the counter in the postcard matters more than the filename.
      artifact = m.artifact;
    }
  }
  return {
    id: typeof m?.id === 'string' ? m.id : null,
    type: String(m?.type ?? ''),
    from: addressOf(sender) ?? String(m?.sender ?? ''),
    ts: String(m?.ts ?? ''),
    body: typeof m?.body === 'string' ? m.body : '',
    artifact,
  };
}

/** Keep a filesystem refusal visible in the same preview budget as a message. */
function brokenPreview(note: BrokenNote, now: number): NotificationMessage {
  return {
    id: null,
    type: 'mailbox-broken',
    from: 'promptobus',
    ts: new Date(now).toISOString(),
    body: `unreadable ref ${note.name}: ${note.code}`,
    artifact: null,
  };
}

/** One watch round: look at all mailboxes, wake those with unread, update health. `sessions` is the
 * snapshot from the last heartbeat — the round runs once a second and gets no poll of its own. */
export async function supervisorRound(home: string, task: string, {
  now = Date.now(), registry, sessions = null as SessionSnapshot, faults = NO_FAULT,
}: {
  now?: number; registry: Registry; sessions?: SessionSnapshot; faults?: FaultHook;
}): Promise<{ stop: string | null; events: string[]; knocked: string[] }> {
  let meta;
  try {
    meta = readTask(home, task);
  } catch (e) {
    return { stop: `task journal does not read: ${(e as Error).message}`, events: [], knocked: [] };
  }
  if (meta.status !== 'active') return { stop: 'task is closed', events: [], knocked: [] };

  const health = readHealth(home, task);
  const events: string[] = [];
  const knocked: string[] = [];
  let changed = false;

  for (const p of meta.participants ?? []) {
    const addr = addressOf(p);
    if (!addr) continue;
    let unread: number;
    try {
      unread = countInbox(home, task, p.id);
    } catch {
      // A bad participant record has no right to stop the watch over the others.
      continue;
    }
    const was = marksOf(health, addr);
    const h: HealthMark = { ...was };

    if (!unread) {
      // The mailbox was taken — that is the delivery confirmation; a mailbox
      // that was always empty is not written.
      if (was.unread) {
        events.push(`delivered ${addr}: mailbox was taken (had ${was.unread}, knocks ${was.knocks ?? 0})`);
        health[addr] = {
          ...was,
          unread: 0,
          deliveredAt: new Date(now).toISOString(),
          since: null,
          knockedAt: null,
          triedAt: null,
          knocks: 0,
          escalatedAt: null,
          unreadableRefs: [],
          hold: undefined,
        };
        changed = true;
      }
      continue;
    }

    // `since` — when the mailbox stopped being empty: silence is counted from it, and a new message
    // on top of an old one does not reset it, or silence would never be seen.
    if (!was.unread) {
      h.since = new Date(now).toISOString();
      h.knocks = 0;
      h.knockedAt = null;
      h.triedAt = null;
      h.escalatedAt = null;
    }
    h.unread = unread;

    // The driver is taken from the registry by harness, and one participant's failure may not take
    // the watch over the others: an unknown harness stays a line in the journal, and the round goes on.
    let driver;
    try {
      driver = driverFor(registry, harnessOf(p, registry));
    } catch (e) {
      if (h.channel !== 'no-driver' || h.knockError !== (e as Error).message) {
        events.push(`nothing to wake with ${addr}: ${(e as Error).message}`);
      }
      h.channel = 'no-driver';
      h.knockError = (e as Error).message;
      if (JSON.stringify(h) !== JSON.stringify(was)) changed = true;
      health[addr] = h;
      continue;
    }

    const endpoint = readWake(home, task, addr);
    // Whose contact point this really is, asked before the knock-retry thresholds: a hijacked
    // channel is not "not yet time", it is "nowhere to knock".
    const taken = wakeTakenBy(home, task, p, endpoint);
    // Contact-point fingerprint: channel address only. A pid or hand-over time changes when two
    // writers hand over the same session's point; a turn counter in the socket asks for a wake.
    const print = endpoint?.socket ? endpoint.socket : null;
    const moved = print !== null && was.wake !== undefined && print !== was.wake;

    // The knock-retry threshold counts from ATTEMPT time, not success, or a dead channel would get
    // an attempt every second. `knockedAt` stays the last SUCCESSFUL delivery.
    const triedAt = Date.parse(h.triedAt ?? '');
    const grew = unread > (was.unread ?? 0);
    const stale = Number.isFinite(triedAt) && now - triedAt >= KNOCK_RETRY_SEC * 1000;
    // A retry on the SAME unread waits until the session gives the turn back — it will see the
    // notification at the end of it anyway. The first knock on a new message does not wait.
    const since = Date.parse(h.since ?? '');
    const waited = Number.isFinite(since) ? now - since : 0;
    // Bound of the cumulative signal: a successful activation does not confirm delivery, and one
    // dropped by a queue limit never starts a turn — so past the threshold we knock regardless.
    const busy = stale && waited < SILENCE_SEC * 1000 && sessionBusy(home, task, p, sessions);
    // A refusal with a named reset is a state, not one more failed turn: no knock before that time.
    // A time that did not parse is probed at once, then at the ordinary retry pace — never on a rewritten point.
    const hold = pushes(driver) ? heldReset(p, sessions, now) : null;
    const probe = hold !== null && hold.at === null && !busy && (!Number.isFinite(triedAt) || stale);
    if (hold) {
      if (JSON.stringify(hold) !== JSON.stringify(was.hold ?? null)) {
        events.push(`knocks held ${addr}: the harness refused the turn and named a reset — unreachable until `
          + `${resetText(hold)}${hold.at === null ? `, probed every ${KNOCK_RETRY_SEC} s` : ''}`);
      }
      h.hold = hold;
    } else delete h.hold;
    if (!pushes(driver)) {
      // A pull-driver does not wake the session at all — it polls. Health is kept like everyone
      // else's, so such a participant's silence is visible by the same threshold.
      if (h.channel !== 'pull') {
        h.channel = 'pull';
        h.wake = null;
        // A self-wake verdict from an earlier channel must not survive the move to pull:
        // `status` would print a prognosis for knocks that no longer happen.
        h.selfWake = null;
        h.selfWakeChannel = null;
      }
    } else if (hold && !probe) {
      // Held: the mark above says why, and the round neither knocks nor falls back to self-wake.
    } else if (!endpoint?.socket) {
      // No contact point — nothing to knock with, and the threshold does not hold this back: the
      // participant may hand over the channel after the message has already landed.
      const why = 'no contact point — the participant did not hand over a socket';
      if (h.channel !== 'self-wake' || h.knockError !== why) {
        events.push(`fell back to self-wake ${addr}: ${why}`);
      }
      h.channel = 'self-wake';
      h.knockError = why;
      h.selfWake = 'starting';
      h.selfWakeChannel = null;
      h.wake = null;
    } else if (taken) {
      // Another session holds the contact point: a knock would start a turn for THEM and leave the
      // addressee deaf. Nothing to wait for, and said once per reason — the round runs every second.
      const why = `contact point is held by session ${taken}, while the address is bound to ${heldBy(p)}`;
      if (h.channel !== 'self-wake' || h.knockError !== why) {
        events.push(`fell back to self-wake ${addr}: ${why} — the knock would have gone to a foreign session`);
      }
      h.channel = 'self-wake';
      h.knockError = why;
      h.selfWake = 'taken';
      h.selfWakeChannel = null;
      h.wake = null;
    } else if (!Number.isFinite(triedAt) || grew || moved || (stale && !busy)) {
      h.triedAt = new Date(now).toISOString();
      h.wake = print;
      // The mailbox is read exactly here, not every round. `glanceInbox`, not `peekInbox`: the
      // warden does not set a broken ref aside, but carries its refusal in the postcard.
      const { messages: box, broken } = glanceInbox(home, task, p.id, faults);
      h.unreadableRefs = broken.map(({ code, name }) => `${code} ${name}`);
      // A retry carries only what arrived after the last knock; the full list goes where the session
      // has not seen the previous one. The cutoff is by message id — mailbox names sort by send order.
      const wakeSession = endpoint?.session ?? null;
      const restarted = wakeSession !== (was.wakeSession ?? null);
      const upTo = restarted ? null : was.knockedTo ?? null;
      const msgs = upTo === null ? box : box.filter((m) => String(m?.id ?? '') > upTo);
      const previews = [
        ...msgs.map((m) => previewOf(home, meta, m)),
        ...broken.map((note) => brokenPreview(note, now)),
      ];
      const r = await activate(driver, { ref: sessionRefOf(p), endpoint }, {
        kind: 'unread', task, address: addr, unread, messages: previews,
      });
      if (r?.ok) {
        // The channel is the driver's declaration, not the contact-point wire: `wake.socket` is also
        // present on inject/rpc, where it is a registry or holder path, not a messaging socket.
        h.channel = driver.options?.knockChannel ?? 'socket';
        h.knockError = null;
        h.selfWake = null;
        h.selfWakeChannel = null;
        h.knockedAt = h.triedAt;
        h.knocks = (h.knocks ?? 0) + 1;
        h.wakeSession = wakeSession;
        knocked.push(addr);
        // How far we knocked: not only what was shown, but also what went into the "and N more"
        // tail — the postcard said it, and there is no need to repeat it.
        if (box.length && !broken.length) h.knockedTo = box[box.length - 1]?.id ?? h.knockedTo ?? null;
        const brokenText = broken.map(({ code, name }) => `${code} ${name}`).join(', ');
        events.push(`notification ${addr}: unread ${unread}, knock ${h.knocks}`
          + `${brokenText ? ` (unreadable refs: ${brokenText})` : ''}`
          + `${moved ? ' (contact point rewritten)' : ''}`);
      } else {
        // Once per reason: a dead channel returns the same error every two minutes. The phrase names
        // the driver's channel — the `socket` literal sent inspection at a transport inject/rpc lack.
        const why = r?.error ?? 'unknown';
        const channel = driver.options?.knockChannel ?? 'socket';
        const label = channel === 'socket' ? 'socket' : channel;
        if (h.channel !== 'self-wake' || h.knockError !== why) {
          events.push(`fell back to self-wake ${addr}: ${label} did not accept the notification (${why})`);
        }
        h.channel = 'self-wake';
        h.knockError = why;
        h.selfWake = 'refused';
        // The label the journal line above uses; `status` had only the raw error.
        h.selfWakeChannel = label;
      }
      // There is no write here: the state comparison below decides that.
    }

    // Silence longer than the threshold — escalation, and once: otherwise
    // the journal would flood with one fact.
    if (Number.isFinite(since) && waited >= SILENCE_SEC * 1000 && !h.escalatedAt) {
      h.escalatedAt = new Date(now).toISOString();
      events.push(`SILENT ${addr}: mailbox not taken for ${Math.round(waited / 60000)} min, `
        + `unread ${unread}, channel ${h.channel ?? 'none'}`);
      changed = true;
    }

    if (JSON.stringify(h) !== JSON.stringify(was)) changed = true;
    health[addr] = h;
  }

  if (changed) writeHealth(home, task, health);
  for (const line of events) logWarden(home, task, line);
  return { stop: null, events, knocked };
}

// Activation of one participant. A driver refusal is an outcome, not an exception: delivery to the
// others must go on, and a throw would take the whole round with it.
async function activate(driver: Driver, target: ActivationTarget, notification: Notification): Promise<ActivateResult> {
  if (typeof driver.activate !== 'function') {
    return { ok: false, error: `driver "${driver.id}" does not wake itself: it has no activate operation` };
  }
  try {
    const r = await driver.activate(target, notification);
    return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? 'unknown' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Participant stall. Escalation is visibility — a status line and a journal entry, no postcard: a
 * separate notification burned orchestrator turns every round. The journal line is the adapter's. */
export async function stallRound(home: string, task: string, { sessions = null as SessionSnapshot, now = Date.now() }: {
  sessions?: SessionSnapshot; now?: number;
} = {}): Promise<StalledParticipant[]> {
  const { fresh, current } = pendingStalls(home, task, (ps) => blockedParticipants(home, task, ps, sessions),
    { now, retryMs: 0, maxTries: 1 });
  // The set may have changed even without new ones: a participant unstuck. Move the mark anyway, or
  // their next stall with the same reason would not be counted fresh.
  commitStalls(home, task, current);
  return fresh;
}

/** One report per sighting of a named reset: the orchestrator is knocked once with the time, so the run
 * decides instead of reading the journal. `fresh` is `stallRound`'s, whose mark makes a sighting once. */
export async function reportResets(home: string, task: string, fresh: StalledParticipant[], { registry, now = Date.now() }: {
  registry: Registry; now?: number;
}): Promise<string[]> {
  const own = fresh.filter((s) => s.address === ORCHESTRATOR && resetAhead(s.reset, now))
    .map((s) => `could not report to ${ORCHESTRATOR} (the refusal is its own): ${ORCHESTRATOR} is unreachable until ${resetText(s.reset!)}`);
  const held = fresh.filter((s) => s.address !== ORCHESTRATOR && resetAhead(s.reset, now));
  if (!held.length) return own;
  const lines = held.map((s) => `${s.address} is unreachable until ${resetText(s.reset!)}: ${s.reason}`);
  const orchestrator = readTask(home, task).participants.find((p) => addressOf(p) === ORCHESTRATOR);
  const why = orchestrator ? await reportTo(home, task, orchestrator, lines, { registry, now }) : 'the task has no orchestrator';
  return [...own, ...lines.map((line) => (why ? `could not report to ${ORCHESTRATOR} (${why}): ${line}` : `reported to ${ORCHESTRATOR}: ${line}`))];
}

// The report rides the ordinary postcard as a preview of its own type, like an unreadable ref does.
async function reportTo(home: string, task: string, orchestrator: ParticipantV1, lines: string[], { registry, now }: {
  registry: Registry; now: number;
}): Promise<string | null> {
  let driver;
  try {
    driver = driverFor(registry, harnessOf(orchestrator, registry));
  } catch (e) {
    return (e as Error).message;
  }
  if (!pushes(driver)) return 'its driver polls, and the stall line waits in its mailbox reply';
  const endpoint = readWake(home, task, ORCHESTRATOR);
  if (!endpoint?.socket) return 'no contact point';
  const taken = wakeTakenBy(home, task, orchestrator, endpoint);
  if (taken) return `contact point is held by session ${taken}`;
  const r = await activate(driver, { ref: sessionRefOf(orchestrator), endpoint }, {
    kind: 'unread',
    task,
    address: ORCHESTRATOR,
    unread: countInbox(home, task, orchestrator.id),
    messages: lines.map((body) => ({
      id: null, type: 'unreachable', from: 'promptobus', ts: new Date(now).toISOString(), body, artifact: null,
    })),
  });
  return r.ok ? null : r.error ?? 'unknown';
}

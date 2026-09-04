// The warden state machine: rounds, knock-retry thresholds, unread health,
// silence escalation, and the decision of whom to activate.
//
// What is here and what is not. Here — DECISIONS: who still has unread, whether
// it is time to knock, which messages to show, who stalled, and who has already
// been reported. There is no delivery channel here, and no text: the channel
// comes from the driver via `activate`, and the same driver renders the text —
// the frame and the words belong to the harness channel, not the bus. There is
// also no process here: the detached launcher, the `fs.watch` observers, and the
// loop live at the consumer, because a process death costs nothing by
// construction — the entire state sits in the task store.
//
// The intervals below are measured, not chosen. Changing them changes the
// behaviour of a live run: each is named together with what it was measured by.
import {
  beatWarden, lastTurnAt, logWarden, readHealth, readStalls, readWake, writeHealth, writeStalls,
} from './sidecar.js';
import type { Stalls, Wake } from './sidecar.js';
import { addressOf, dismissedOf, foreignSessionOf, repoAbsOf, sessionIdOf, sessionOf, startedOf } from './protocol.js';
import { readArtifact } from './v1/artifacts.js';
import { countInbox, glanceInbox, lastSentAt } from './v1/messages.js';
import type { MessageV1, ParticipantV1, TaskV1 } from './v1/model.js';
import { readTask } from './v1/store.js';
import { driverFor, harnessOf, pushes, sessionRefOf } from './driver.js';
import type {
  ActivateResult, ActivationTarget, Driver, Notification, NotificationMessage, Registry,
  SessionSnapshot, SessionStall, SessionView, StalledParticipant,
} from './driver.js';
// Polling mailboxes — a safety net for `fs.watch`, which loses events.
export const TICK_MS = 1000;

// Knock retry: the mailbox is still not taken — knock again. Two minutes are
// measured to the participant's turn, not the network: a session busy with a
// long turn is allowed to stay silent for minutes.
export const KNOCK_RETRY_SEC = 120;

// Silence threshold: unread must not sit longer than this — the participant
// either stalled, or is not receiving notifications at all. Fifteen minutes
// means "not answering", not "thinking": the mailbox is taken BEFORE the
// turn is inspected, not after.
export const SILENCE_SEC = 900;

// Process lifetime ceiling — guards a forgotten run whose task stayed open overnight.
export const WARDEN_TOTAL_SEC = 6 * 3600;

// How many consecutive round failures the process tolerates before exiting.
// One failure is a transient (the task lock is held by a neighbouring spawn,
// a file is being rewritten underfoot); three in a row is not.
export const ROUND_FAIL_LIMIT = 3;

// Registration window for a freshly spawned session: spawn writes the
// participant into the journal BEFORE the session appears at the harness with
// its process, and the absence of a process in that gap means an unfinished
// start, not death.
export const SPAWN_GRACE_SEC = 30;

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
  wake?: string | null;
  [key: string]: unknown;
}

function marksOf(health: Record<string, unknown>, addr: string): HealthMark {
  const v = health[addr];
  return (v && typeof v === 'object' ? v : {}) as HealthMark;
}

// The window is SYMMETRIC: spawn time is written by that machine's clock, and
// a clock set backwards would make a fresh record "from the future" with a
// negative age.
export function justSpawned(participant: ParticipantV1 | null | undefined, now: number = Date.now()): boolean {
  const at = Date.parse(String(startedOf(participant) ?? ''));
  return Number.isFinite(at) && Math.abs(now - at) < SPAWN_GRACE_SEC * 1000;
}

// When a turn was last STARTED for the participant. There are three marks, and
// all three mean the same thing — the participant was reached: spawn (`started`
// in the task journal), a successful activation (`knockedAt`), and the mailbox
// they took (`deliveredAt`). An activation attempt (`triedAt`) is left out on
// purpose: a failed activation did not start a turn, and silence after it
// speaks of a deaf channel, not a stall — the bus has its own words for that.
function lastActivation(home: string, task: string, participant: ParticipantV1 | null | undefined): number | null {
  const marks = marksOf(readHealth(home, task), String(addressOf(participant) ?? ''));
  const at = [startedOf(participant), marks.knockedAt, marks.deliveredAt]
    .map((v) => Date.parse(String(v ?? ''))).filter(Number.isFinite);
  return at.length ? Math.max(...at) : null;
}

/** What the snapshot knows about the participant's session. No ref — there is no session for the address at all. */
function viewOf(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): SessionView | null {
  if (sessions === null) return null;
  if (!sessionRefOf(participant)) return null;
  // There is a ref, but no record in the snapshot: the participant appeared
  // after the snapshot, or the session is gone.
  return sessions[String(addressOf(participant) ?? '')] ?? { state: 'gone', busy: false, stall: null, id: null };
}

/**
 * Participant session state: `alive` | `dead` | `unknown`. An unparsed
 * snapshot, a record without a session reference, and a participant whom
 * there is no one to ask about — unknown, not death.
 */
export function liveParticipant(participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): 'alive' | 'dead' | 'unknown' {
  if (!sessionRefOf(participant)) return 'unknown';
  const view = viewOf(participant, sessions);
  if (!view || view.state === 'unknown') return 'unknown';
  // The question is one: will we reach them. A record that outlived its
  // process is unreachable exactly like an absent one; `promptobus status`
  // distinguishes them, because a human needs the reason.
  return view.state === 'alive' ? 'alive' : 'dead';
}

/**
 * Whether this is a stall for real. While the bus still had awaiting, the
 * participant sat inside a tool call between messages and was busy to the
 * harness; once awaiting was removed, they finish the turn after sending a
 * message, and the harness marks their session as standing with a line like
 * "result sent; awaiting next cycle". For stall inspection that is an
 * `unknown` outcome, and a report went out on every ordinary end of turn.
 *
 * What remains a stall is a SILENT end of turn: the participant finished the
 * turn without sending anything on the bus after their last activation.
 * `permission` and `limit` are not subject to this check at all — a human
 * or time lifts them, not a message on the bus.
 *
 * One predicate for three callers: the warden report, the `promptobus status`
 * print, and the stalled lines in the `mailbox` reply. If they drifted, they
 * would become different answers about the same state.
 *
 * The task and its store are required arguments, and they have no silent
 * default on purpose: "no home — treat as a stall" is exactly the divergence
 * mechanism the predicate was collapsed into one function to close.
 */
export function stallStands(home: string, task: string, participant: ParticipantV1 | null | undefined, stall: SessionStall | null | undefined): boolean {
  if (!home || !task) throw new Error('stallStands: home and task are required — the predicate reads the task store');
  if (!stall) return false;
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
  // The participant has NEVER yet spoken on the bus, and their session already
  // shows a finished turn — that is an unfinished start, not a stall. The
  // window opened together with the new entry into the inspection: while
  // `blocked` served as that entry, a fresh session never landed in it at all,
  // and it shows `idle` between `--bg` and its first turn — a report would
  // have gone out with the reason literally `idle`, because `state.json` has
  // not been written yet by then.
  //
  // **The window sits inside the predicate, not in `blockedParticipants`
  // next to the neighbouring `justSpawned`, because the `promptobus status`
  // print calls the predicate directly, bypassing participant inspection**
  // (`lib/status.js`) — put there, it would have left that print unprotected
  // and split the channels, exactly against what the predicate was collapsed
  // for.
  //
  // **And only this branch: a participant who has spoken at least once has a
  // real timeline, and silence after activation is a stall regardless of the
  // record's age**; a window over the whole `unknown` branch would have given
  // half a minute of deafness to everyone at once.
  if (sent === null) return !justSpawned(participant);
  return sent < since;
}

/**
 * The address's contact point is held by a FOREIGN session — or `null` if
 * it is held by its own, or there is nothing to compare.
 *
 * This is not malice: the Stop hook takes identity from its command
 * arguments, and when they are missing — from the session environment, and
 * the harness background-session environment is not the one the session was
 * spawned with. Measurement 2026-09-03: harness background sessions are
 * pre-allocated daemon spares, and the `PROMPTOBUS_*` trio comes to them
 * from the process that raised the daemon, that is from the FIRST spawn of
 * the run. The second participant of the task then hands over a contact
 * point for the first address, and the warden, checking nothing, wakes a
 * foreign session through it: in ten minutes of that run eleven
 * notifications went to the wrong place.
 *
 * Hence the rule: do not knock on such a contact point. It is not dead —
 * it leads to another session, and a knock on it starts a FOREIGN turn,
 * while the addressee stays deaf. This repairs itself on the first end of
 * turn of the real owner: their hook rewrites the record with their own.
 *
 * Both sides must be named: a participant record without a session id
 * (spawn did not parse it from `--bg` output) and a contact point of the
 * former CLI without a `session` field — that is unknown, not a foreign
 * session, and it cannot be blamed.
 */
export function wakeTakenBy(home: string, task: string, p: ParticipantV1 | null | undefined, endpoint?: Wake | null): string | null {
  const addr = addressOf(p);
  if (!addr) return null;
  // The record is read by the caller when they already have it: the watch
  // round reads every participant's contact point every second, and a second
  // read of the same file is an extra syscall per participant per second
  // (review note). No argument — we read ourselves: the stall report goes
  // past the round.
  const wake = endpoint === undefined ? readWake(home, task, addr) : endpoint;
  const held = wake?.session ?? null;
  // What is returned is the TAKER — the session from the contact point, not
  // the one the address is bound to: that is what the reason line names, and
  // that is how a human identifies the second session. The comparison rule
  // is shared (`foreignSessionOf`), and it has no second copy.
  return held && foreignSessionOf(p, held) ? held : null;
}

/** The session the address is bound to in the journal — how to name it to a human. */
function heldBy(p: ParticipantV1 | null | undefined): string {
  return sessionIdOf(p) ?? sessionOf(p) ?? 'nobody';
}

/**
 * Whether the participant's session is busy with a turn. There are two
 * branches, because there are two kinds of participant, and one branch
 * is not enough for both.
 *
 * **There is a session reference** — take busyness from the snapshot: the
 * driver declared it.
 *
 * **There is no reference** — that is how the task owner lives: their
 * session was not raised by the driver, and the harness has no record of
 * it at all. Busyness is then taken from the cycle watchman: it is called
 * on EVERY end of turn and lays a mark (`markTurn`). An activation newer
 * than the mark means that since then the session started a turn and has
 * not yet given it back. The signal is cumulative, not instantaneous:
 * "has it been free since the last activation", not "is it free this second".
 *
 * Neither source is a contract: no snapshot, no record, the watchman mark
 * has never been laid — that is UNKNOWN, not busy, and the caller does
 * what they would have done without the predicate.
 */
export function sessionBusy(home: string, task: string, participant: ParticipantV1 | null | undefined, sessions: SessionSnapshot): boolean {
  // The branch is chosen by the KIND of participant, not by whether their
  // session was found in the snapshot: the snapshot yields emptiness for an
  // unparsed state and for a vanished record alike, and on that emptiness a
  // participant with a session would have gone into the watchman branch —
  // where they may have no end-of-turn mark at all, and the activation is
  // newer by construction: knock-retry would go silent where the state is
  // unknown.
  if (sessionRefOf(participant)) {
    const view = viewOf(participant, sessions);
    return view ? view.busy === true : false;
  }
  const turn = lastTurnAt(home, task, String(addressOf(participant) ?? ''));
  if (turn === null) return false;
  const since = lastActivation(home, task, participant);
  return since !== null && since > turn;
}

/**
 * Task participants from whom no messages are to be expected: the session
 * is standing on a prompt, or the record outlived its process. `null` —
 * the state is unknown: that is not "everyone is alive".
 *
 * "Listed, but there is no process" is checked BEFORE the stall: a record
 * that outlived its process also carries a stall flag, and the route would
 * have been "wake with a message" — and there is no one to wake.
 */
export function blockedParticipants(home: string, task: string, participants: ParticipantV1[] | null | undefined, sessions: SessionSnapshot): StalledParticipant[] | null {
  // The task store is asked on entry, not at the first stall: inside
  // `stallStands` only the actually stalled reach the throw, and a call with
  // a forgotten store would stay silent until someone stalled, then throw
  // in the middle of a warden round or a `mailbox` reply.
  if (!home || !task) throw new Error('blockedParticipants: home and task are required — stall inspection reads the task store');
  if (sessions === null) return null;
  const stalled: StalledParticipant[] = [];
  // The record's harness travels into the report with it: the stall ROUTE
  // is asked of the same driver that inspected the state, and this function
  // is not given a `registry` — it reads a ready snapshot. A registry is
  // not opened here on purpose: the snapshot was assembled earlier, and a
  // second source of truth about the harness would have drifted from it
  // in silence.
  const harnessOfRecord = (p: ParticipantV1) => (
    typeof p.harness === 'string' && p.harness.trim() ? p.harness.trim() : null);
  for (const p of participants ?? []) {
    const ref = sessionRefOf(p);
    if (!ref) continue;
    // A participant taken off watch does not go into the report at all.
    // Watch is lifted as a whole, not only the `gone` outcome: a filter on
    // the outcome would have made silence depend on a race of two
    // orchestrator commands. A new spawn record is laid without the mark.
    if (dismissedOf(p)) continue;
    const view = viewOf(p, sessions)!;
    // There is no one to ask about them — there is no driver for their
    // harness, or that driver does not inspect. Stay silent: a made-up
    // "GONE" report would have called for raising a session that is still
    // working.
    if (view.state === 'unknown') continue;
    const repoAbs = repoAbsOf(p);
    // No record at all — also a report: a participant stopped by a human
    // and a failed spawn would otherwise be invisible. Their own state, not
    // `stale`: there is no trace of a session. The registration window
    // covers this branch too: a just-spawned session is not in the list
    // AT ALL.
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
        // Words about a vanished record belong to the driver: it alone
        // knows where it went missing and what that is called at its
        // harness. It did not say — we speak neutrally, we do not invent.
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
    // An ordinary end of turn is not a stall, and the task store decides
    // that, not the snapshot: home and task are needed exactly for that
    // (`stallStands`).
    if (stallStands(home, task, p, view.stall)) {
      stalled.push({
        address: String(addressOf(p)),
        ref,
        id: view.id,
        repoAbs,
        harness: harnessOfRecord(p),
        kind: view.stall!.kind,
        reason: view.stall!.reason,
      });
      continue;
    }
    // The session is working, but there is nothing to reach it with: another
    // session holds its address's contact point (`wakeTakenBy`). For the
    // owner this is the same class as a stall — there will be no messages
    // from such a participant, and mailbox will not say so — so the report
    // goes through the same channel. Checked LAST: a dead record is a
    // larger trouble, and naming it a foreign contact point would have
    // sent the human the wrong way.
    // The registration window is the same as the neighbouring branches: on
    // a re-spawn the participant record carries a new session id, while
    // `wake/<address>.json` remains from the previous one, and until the
    // new bus server handshake (`onJoin` will rewrite it) the freshly
    // spawned participant would have looked deaf. The refusal to knock in
    // the watch round is NOT covered by the window on purpose: knocking on
    // a foreign socket is forbidden in those thirty seconds too, but
    // reporting them is too early.
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

/**
 * What is new among the stalls, WITHOUT the mark. The caller sets the mark
 * (`commitStalls`). `retryMs` — the time after which a marked stall is
 * fresh again; `maxTries` — the ceiling of attempts on one reason, zero
 * (the default) — no retry at all.
 * `current === null` — session state was not inspected: that is not "there are no stalls".
 */
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

/**
 * Whom the warden still has reason to watch. Count only participants with
 * a session reference: their state is observable, and a human session
 * behind the owner address is observable from nowhere — treat them as
 * alive, or the "no live remain" exit would become unreachable.
 * Unknown is not taken as dead: an unparsed snapshot leaves everyone
 * alive — otherwise an exit on an unavailable external command. The
 * registration window (`justSpawned`) comes from the same place: a
 * just-spawned session is not in the snapshot at all.
 */
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

/**
 * Heartbeat: renew our mark and check three reasons to exit. Lifted out of
 * the loop for the test: checking a branch inside the loop would have cost
 * the suite half an hour of waiting.
 */
export function beatRound(home: string, task: string, startedMs: number, { now = Date.now(), sessions = null as SessionSnapshot, session = null as string | null } = {}): string | null {
  // A successor intercepted the mark — two cannot watch, they continue the
  // work. Session identity goes to the lock: whose process holds the journal
  // is known to the environment, and the adapter reads it.
  if (!beatWarden(home, task, { session })) return 'another process took the warden place';
  // Unread keeps the process even with an empty live list: the mailbox may
  // not have been taken.
  if (!liveWatched(home, task, sessions).length && !unreadLeft(home, task)) {
    return 'no live participants remain';
  }
  if (now - startedMs >= WARDEN_TOTAL_SEC * 1000) {
    return `sat out the overall ceiling ${Math.round(WARDEN_TOTAL_SEC / 3600)} h`;
  }
  return null;
}

/**
 * Message extract for a notification: the driver builds its text from it.
 *
 * The sender is named by ADDRESS, and the artifact by filename: a human
 * reads the postcard, and a participant record id (`worker-api`) or an
 * artifact metadata id would have been a machine tail instead of a name.
 * Both translations are done here and from the task journal: the message
 * carries the id, and the name sits in the record.
 */
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

/**
 * One watch round: look at all task mailboxes, wake those who have unread,
 * update health. Activation goes through the participant's driver, taken
 * from the registry by their harness. `sessions` — the snapshot from the
 * last heartbeat: the round runs once a second, and it is not allowed its
 * own poll. `null` — there is no session state, and that is unknown.
 */
export async function supervisorRound(home: string, task: string, { now = Date.now(), registry, sessions = null as SessionSnapshot }: {
  now?: number; registry: Registry; sessions?: SessionSnapshot;
}): Promise<{ stop: string | null; events: string[] }> {
  let meta;
  try {
    meta = readTask(home, task);
  } catch (e) {
    return { stop: `task journal does not read: ${(e as Error).message}`, events: [] };
  }
  if (meta.status !== 'active') return { stop: 'task is closed', events: [] };

  const health = readHealth(home, task);
  const events: string[] = [];
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
        };
        changed = true;
      }
      continue;
    }

    // `since` — when the mailbox stopped being empty: silence is counted
    // from it, and a new message on top of an old one does not reset it —
    // otherwise silence would never be seen.
    if (!was.unread) {
      h.since = new Date(now).toISOString();
      h.knocks = 0;
      h.knockedAt = null;
      h.triedAt = null;
      h.escalatedAt = null;
    }
    h.unread = unread;

    // The participant's driver is taken from the registry by their harness —
    // and one participant's failure has no right to take the watch over the
    // others: an unknown harness stays in the journal as a line, and the
    // round goes on.
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
    // Whose contact point this really is: asked before the knock-retry
    // thresholds — a hijacked channel is not "not yet time", it is
    // "nowhere to knock".
    const taken = wakeTakenBy(home, task, p, endpoint);
    // Contact-point fingerprint: channel address and hand-over time. If the
    // participant rewrote their contact point — the session restarted, the
    // channel changed — activate IMMEDIATELY, without sitting out the
    // knock-retry threshold: the previous address is dead by construction.
    const print = endpoint?.socket ? `${endpoint.socket}#${endpoint.at ?? ''}` : null;
    const moved = print !== null && was.wake !== undefined && print !== was.wake;

    // The knock-retry threshold is counted from ATTEMPT TIME, not success:
    // otherwise a non-responding channel would get an attempt every second.
    // `knockedAt` remains the time of the last SUCCESSFUL delivery: stall
    // inspection reads it as "when we got through".
    const triedAt = Date.parse(h.triedAt ?? '');
    const grew = unread > (was.unread ?? 0);
    const stale = Number.isFinite(triedAt) && now - triedAt >= KNOCK_RETRY_SEC * 1000;
    // A retry on the SAME unread waits until the session gives the turn
    // back: a busy session will see the notification only at the end of the
    // turn, and the turn will be returned to it by the cycle watchman with
    // the unread anyway. This does not apply to the first knock on a new
    // message: the session has not seen it yet. The task owner has no
    // session in the snapshot, and busyness there is taken from the cycle
    // watchman — both branches are in `sessionBusy`.
    const since = Date.parse(h.since ?? '');
    const waited = Number.isFinite(since) ? now - since : 0;
    // Bound of the cumulative signal: the gate does not hold longer than
    // the silence threshold. A successful activation does not confirm
    // delivery, and one dropped by the recipient's queue limits — the very
    // case redelivery was introduced for — did not wake the session: it
    // never started a turn and will not finish one, the watchman mark will
    // not move, and busyness would have stayed true forever. Sitting longer
    // than the threshold — knock, regardless of busyness.
    const busy = stale && waited < SILENCE_SEC * 1000 && sessionBusy(home, task, p, sessions);
    if (!pushes(driver)) {
      // A pull-driver does not wake the session at all — it runs its own
      // polling, and core only shows its capability and the unread. Health
      // is still kept like everyone else's: such a participant's silence
      // is visible by the same threshold.
      if (h.channel !== 'pull') {
        h.channel = 'pull';
        h.wake = null;
      }
    } else if (!endpoint?.socket) {
      // There is no contact point — nothing to knock with, and this is not
      // held back by the threshold: the participant can hand over the
      // channel after the message has already landed.
      if (h.channel !== 'self-wake') {
        h.channel = 'self-wake';
        h.wake = null;
        events.push(`fell back to self-wake ${addr}: no contact point — the participant did not hand over a socket`);
      }
    } else if (taken) {
      // Another session holds the contact point (`wakeTakenBy` above). Do
      // not knock on it: it is not dead, it leads into a FOREIGN session —
      // a knock would start a turn for them, and the addressee would stay
      // deaf. Nothing to wait for and nothing to do: the real owner will
      // rewrite the record with their own on their first end of turn. Once
      // per reason: a hijacked contact point lives for minutes, and the
      // round runs once a second.
      const why = `contact point is held by session ${taken}, while the address is bound to ${heldBy(p)}`;
      if (h.channel !== 'self-wake' || h.knockError !== why) {
        events.push(`fell back to self-wake ${addr}: ${why} — the knock would have gone to a foreign session`);
      }
      h.channel = 'self-wake';
      h.knockError = why;
      h.wake = null;
    } else if (!Number.isFinite(triedAt) || grew || moved || (stale && !busy)) {
      h.triedAt = new Date(now).toISOString();
      h.wake = print;
      // The mailbox is read exactly here, not every round. `glanceInbox`,
      // not `peekInbox`: the warden does not inspect a broken one and does
      // not set it aside.
      const box = glanceInbox(home, task, p.id);
      // A retry carries only what arrived after the last knock: before, it
      // listed the whole box again, up to six messages in one postcard.
      // How many sit in total is said by the counter in the header. The
      // full list goes where the session has not seen the previous knock:
      // there was none at all, or the participant rewrote the contact
      // point, that is restarted. The cutoff is by message id, not by
      // time: names in the mailbox are sorted by send order (`readInbox`),
      // and a second clock is not needed for that.
      const upTo = moved ? null : was.knockedTo ?? null;
      const msgs = upTo === null ? box : box.filter((m) => String(m?.id ?? '') > upTo);
      const r = await activate(driver, { ref: sessionRefOf(p), endpoint }, {
        kind: 'unread', task, address: addr, unread, messages: msgs.map((m) => previewOf(home, meta, m)),
      });
      if (r?.ok) {
        // The channel is the driver's declaration, not the contact-point
        // wire. The `wake.socket` field is also present on inject/rpc:
        // there it is a registry or holder path, not a messaging socket.
        // The `socket` literal named the wrong transport to a human.
        h.channel = driver.options?.knockChannel ?? 'socket';
        h.knockError = null;
        h.knockedAt = h.triedAt;
        h.knocks = (h.knocks ?? 0) + 1;
        // How far we knocked: not only what was shown, but also what went
        // into the "and N more" tail — the postcard said it, and there is
        // no need to repeat it a second time.
        if (box.length) h.knockedTo = box[box.length - 1]?.id ?? h.knockedTo ?? null;
        events.push(`notification ${addr}: unread ${unread}, knock ${h.knocks}`
          + `${moved ? ' (contact point rewritten)' : ''}`);
      } else {
        // Once per reason: a dead channel returns the same error every two minutes.
        // The phrase names the driver's channel: printing the `socket` literal
        // sent inspection toward a transport that inject/rpc does not have.
        // `socket` is printed as the word "socket" — that is how the line has
        // long been read at a harness with channel `socket`.
        const why = r?.error ?? 'unknown';
        const channel = driver.options?.knockChannel ?? 'socket';
        const label = channel === 'socket' ? 'socket' : channel;
        if (h.channel !== 'self-wake' || h.knockError !== why) {
          events.push(`fell back to self-wake ${addr}: ${label} did not accept the notification (${why})`);
        }
        h.channel = 'self-wake';
        h.knockError = why;
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
  return { stop: null, events };
}

// Activation of one participant. A driver refusal is an outcome, not an
// exception: delivery to the others must go on, and something thrown
// outward would have taken the whole round together with the health of
// the other addresses.
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

/**
 * Participant stall. A standing session sends no messages, and you cannot
 * learn about it from the mailbox: the participant is standing, and the
 * owner waits for a message that will not come.
 *
 * Escalation is visibility: a line in status and a journal entry. A stall
 * postcard is not sent — a separate notification burned orchestrator turns
 * every round until the stall was lifted. The mark is set immediately:
 * there is nothing to deliver, nothing to retry.
 *
 * Returns fresh stalls as a structure. The journal line is assembled by
 * the adapter via `stallLine`: otherwise the reason and the route would
 * have vanished from the post-mortem record.
 */
export async function stallRound(home: string, task: string, { sessions = null as SessionSnapshot, now = Date.now() }: {
  sessions?: SessionSnapshot; now?: number;
} = {}): Promise<StalledParticipant[]> {
  const { fresh, current } = pendingStalls(home, task, (ps) => blockedParticipants(home, task, ps, sessions),
    { now, retryMs: 0, maxTries: 1 });
  // The set may have changed even without new ones: a participant unstuck.
  // Move the mark anyway — otherwise their next stall with the same reason
  // would not be counted fresh.
  commitStalls(home, task, current);
  return fresh;
}

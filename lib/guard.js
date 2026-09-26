import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {
  activeTasks, addrDir, addressOf, boundTaskId, countInbox, foreignSession, foreignSessionOf,
  bus, clearWardenExit, identityLabel, lastTurnAt, liveWarden, markTranscript, markTurn, nameOfArtifact,
  orchestratedTasks, ORCHESTRATOR, outboundMessages, ownership, participantOf, readHealth,
  readTask, readWake,
  readWardenExit, readWardenGeneration, resolveIdentity, sameOwnerSession, sessionIdentity,
  sessionIdOf, sessionOf, storePending, taskDir, taskExists, taskOwner, writeJsonAtomic,
} from './store.js';
import { ANSWER_EXPECTED, answerOwedSince } from './answers.js';
import { isGateRecordName, isHandoverRecordName } from './handoff.js';
import { contactSocketPath, wardenDeadLine, wardenPriorExitLine } from './status.js';
import { ensureWarden, handOverContactPoints } from './warden.js';
import { driverOrLift } from './drivers.js';
import { GUARD_START_EVENT } from '../dist/hooks.js';
import { appendThroughputObservation } from './model-routing/telemetry.js';

// Bus loop guard, called by the Stop hook on EVERY turn end: do not let a session finish a
// turn in a state from which nobody will wake it.

// Own mark for recognizability in the tape: this is not a command refusal, it is a
// turn return.
export const GUARD_MARK = 'LOOP GUARD';

// How many returns in a row on THE SAME state. Its own ceiling next to Claude Code's eight
// (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`): two are enough to name a state and catch a pass.
export const GUARD_BLOCK_LIMIT = 2;

// Counter of consecutive returns — a file in the task `waits/`, one file per address.
export function guardMarkFile(home, task, addr) {
  return path.join(taskDir(home, task), 'waits', `${addrDir(addr)}.guard.json`);
}

// Mark "this session has already been told", one file per reader: a shared file per task
// would eat the hint of the next session in the root.
export function successorMarkFile(home, task, session) {
  const stem = String(session ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-') || 'unknown';
  return path.join(taskDir(home, task), 'waits', `successor.hint.${stem}.json`);
}

function readGuardMark(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// `Stop` payload on stdin. Reading it is REQUIRED — `CLAUDE_CODE_SESSION_ID` is not promised
// to a hook process — and `isTTY` is the hang gate for a subcommand started by hand.
export async function readEvent(stdin) {
  if (stdin.isTTY) return {};
  let timer;
  try {
    let raw = '';
    stdin.setEncoding('utf8');
    const result = await Promise.race([
      (async () => {
        for await (const chunk of stdin) raw += chunk;
        return raw;
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          try { stdin.destroy?.(); } catch { /* nothing to close */ }
          resolve(null);
        }, HOOK_STDIN_MS);
      }),
    ]);
    clearTimeout(timer);
    const event = JSON.parse(result ?? raw);
    return event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  } catch {
    clearTimeout(timer);
    return {};
  }
}

/** Append hook evidence beside the guard mark; a refusal never blocks the turn. */
function rememberThroughput(home, task, address, participant, event) {
  if (!participant) return;
  try {
    appendThroughputObservation(home, task, address, event);
  } catch {
    // Sidecar evidence is additive; a write refusal must not block the turn.
  }
}

function said(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Key prefix of the unanswered verdict. The state lives in the counter's own key and
// nowhere else — there is no debt field on disk.
const UNANSWERED_KEY = 'unanswered';
const HANDOFF_KEY = 'handoff';

function handoffPendingVerdict(home, task, addr) {
  const senderId = addrDir(addr);
  const since = lastTurnAt(home, task, addr) ?? 0;
  let sentRecordArtifact = false;
  for (const msg of outboundMessages(home, task, senderId, since)) {
    if (msg.type === 'result') return null;
    if (!sentRecordArtifact && msg.type === 'artifact' && msg.artifact) {
      const name = nameOfArtifact(home, task, msg.artifact);
      if (isGateRecordName(name) || isHandoverRecordName(name)) sentRecordArtifact = true;
    }
  }
  if (!sentRecordArtifact) return null;
  return {
    key: `${HANDOFF_KEY}:${since}`,
    reason: 'a record artifact was sent and the turn is ending with no result: send the result '
      + 'that names it with the promptobus_send tool before ending the turn',
  };
}

// Unread in the OTHER tasks this session owns as `orchestrator`. One binding stays, so a task
// lifted from a bound session is watched by nothing else — 03-cli § Guard and warden.
function liftedTaskUnread(home, task, session) {
  const waiting = orchestratedTasks(home, session)
    .filter((meta) => meta.id !== task)
    .map((meta) => ({ id: meta.id, title: meta.title, unread: countInbox(home, meta.id, ORCHESTRATOR) }))
    .filter((t) => t.unread);
  if (!waiting.length) return null;
  const named = waiting.map((t) => `${t.id}${t.title ? ` "${t.title}"` : ''} (${t.unread})`).join(', ');
  return {
    key: `lifted:${waiting.map((t) => `${t.id}:${t.unread}`).join('+')}`,
    reason: `the turn is ending and another task you are the orchestrator of has unread mail — ${named}: `
      + 'fetch it with the promptobus_mailbox tool naming that task and answer the types that ask for an answer '
      + `(${ANSWER_EXPECTED.join(', ')})`,
  };
}

// The state that requires returning the turn, or `null`. `key` includes the NUMBER of
// messages, so a new one resets the counter; unread mail comes first, a debt after it.
export function guardVerdict(home, task, addr, session = sessionIdentity()) {
  const unread = countInbox(home, task, addr);
  if (unread) {
    return {
      key: `mailbox:${unread}`,
      reason: `mailbox has ${unread} — the turn is ending and the messages are unread: `
        + 'fetch them with the promptobus_mailbox tool and answer the types that ask for an answer '
        + `(${ANSWER_EXPECTED.join(', ')})`,
    };
  }
  // Who owes an answer at all is the table's door, not the guard's.
  const owed = answerOwedSince(home, task, addr, participantOf(readTask(home, task), addr));
  if (owed) {
    return {
      key: `${UNANSWERED_KEY}:${owed}`,
      reason: `the turn is ending and nothing has gone out on the bus since ${owed}: send the outcome `
        + 'with the promptobus_send tool — a result when the work is done, a status with what is left '
        + 'and a time estimate when it is not, a question when you are stuck',
    };
  }
  const handoff = handoffPendingVerdict(home, task, addr);
  if (handoff) return handoff;
  // Last: a task this session lifted is repaired after every debt of its own — 03-cli § Guard and warden.
  return liftedTaskUnread(home, task, session);
}

// How long to wait for the owner's socket. The Stop hook lives fractions of a second, and
// a hook parent may write its payload before closing stdin — give it one.
const HOOK_STDIN_MS = 1000;
const SUCCESSOR_PROBE_MS = 200;

function sameWorkspaceRoot(cwd, home) {
  if (!cwd || !home) return false;
  try {
    return realpathSync(cwd) === realpathSync(path.dirname(home));
  } catch {
    return false;
  }
}

// Address prefixes of a NON-orchestrator participant. Why the list is spelled here and
// what a missing role costs: [03-cli.md § Guard and warden](../docs/reference/03-cli.md).
const PARTICIPANT_PREFIXES = ['worker:', 'reviewer:', 'approver:'];

export function declaredParticipant(identity) {
  const role = identity?.role;
  return typeof role === 'string' && PARTICIPANT_PREFIXES.some((p) => role.startsWith(p));
}

function holdsSession(participant, session) {
  return Boolean(
    (sessionIdOf(participant) ?? sessionOf(participant))
    && foreignSessionOf(participant, session) === null,
  );
}

// Already on the bus: a binding, the mailbox owner, or a worker/reviewer in the journal. A
// foreign session in the root is not yet a successor until it claims itself.
function sessionOnBus(home, session, identity, tasks) {
  if (declaredParticipant(identity)) return true;
  if (!session) return false;
  if (boundTaskId(home, session)) return true;
  for (const meta of tasks) {
    const own = ownership(home, meta.id, ORCHESTRATOR, session);
    if (own.owner && !own.gated) return true;
    for (const p of meta.participants ?? []) {
      const addr = addressOf(p);
      if (!addr || addr === ORCHESTRATOR) continue;
      if (holdsSession(p, session)) return true;
    }
  }
  return false;
}

// Dead only if the socket was handed over and is missing or refuses. Connect only when the
// file exists and wake names another owner: a live owner would get an unauthed connect.
export function probeContactPoint(socketPath, timeoutMs = SUCCESSOR_PROBE_MS) {
  return new Promise((resolve) => {
    if (!socketPath) {
      resolve({ dead: false, error: null });
      return;
    }
    if (!existsSync(socketPath)) {
      resolve({ dead: true, error: 'ENOENT' });
      return;
    }
    let settled = false;
    const done = (dead, error) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* nothing to close */ }
      resolve({ dead, error });
    };
    let sock;
    try {
      sock = createConnection(socketPath);
    } catch (e) {
      resolve({ dead: true, error: e.code ?? 'error' });
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(false, null));
    sock.once('error', (e) => done(true, e.code ?? e.message));
    sock.once('timeout', () => done(true, 'timeout'));
  });
}

function deadSinceOf(home, id, wake) {
  const h = readHealth(home, id)[ORCHESTRATOR] ?? {};
  return h.triedAt ?? h.since ?? wake?.at ?? 'unknown';
}

export function successorLine(meta, owner, deadSince, unread) {
  const title = meta.title ? ` "${meta.title}"` : '';
  return `task ${meta.id}${title}: orchestrator ${owner} is dead since ${deadSince}, `
    + `unread ${unread} — you are in the same root, take the mailbox: promptobus_mailbox {claim: true}`;
}

function successorItemKey(id, owner, unread) {
  return `${id}:${owner}:${unread}`;
}

function wardenHintMarkFile(home, task, session) {
  const stem = String(session ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-') || 'unknown';
  return path.join(taskDir(home, task), 'waits', `warden.hint.${stem}.json`);
}

function noExitNoteKey(home, task, unread) {
  return `no-exit-note:${unread}:gen=${readWardenGeneration(home, task)}`;
}

function noExitSuffix(home, task) {
  return `no-exit-note:gen=${readWardenGeneration(home, task)}`;
}

function clearNoExitLoopMark(home, task, session) {
  const file = wardenHintMarkFile(home, task, session);
  if (!existsSync(file)) return;
  const mark = readGuardMark(file);
  if (mark?.key?.startsWith('no-exit-note:')) rmSync(file, { force: true });
}

function pruneNoExitSuccessorMarks(home, tasks) {
  for (const meta of tasks) {
    if (countInbox(home, meta.id, ORCHESTRATOR) !== 0) continue;
    const waits = path.join(taskDir(home, meta.id), 'waits');
    if (!existsSync(waits)) continue;
    for (const name of readdirSync(waits)) {
      if (!name.startsWith('successor.hint.')) continue;
      const file = path.join(waits, name);
      const mark = readGuardMark(file);
      if (!mark?.key?.includes('no-exit-note')) continue;
      rmSync(file, { force: true });
    }
  }
}

const WARDEN_EXIT_UNKNOWN = 'without leaving a note';

async function orchestratorOwnerAlive(wake, owner, probe) {
  if (!wake?.socket) return false;
  const socketPath = contactSocketPath(wake.socket);
  if (!socketPath || !existsSync(socketPath)) return false;
  if (wake.session && owner && sameOwnerSession(wake.session, owner)) return true;
  return !(await probe(socketPath)).dead;
}

function wardenExitNotice(home, task, session, meta, host) {
  const exit = readWardenExit(home, task);
  if (exit) {
    const unread = countInbox(home, task, ORCHESTRATOR);
    const live = liveWarden(home, task);
    const mark = readGuardMark(wardenHintMarkFile(home, task, session));
    if (mark?.key === exit.at) return null;
    writeJsonAtomic(wardenHintMarkFile(home, task, session), { key: exit.at, at: new Date().toISOString() });
    clearWardenExit(home, task);
    if (live) return wardenPriorExitLine(meta, exit.reason, unread || null);
    return wardenDeadLine(meta, host, exit.reason, unread || null);
  }
  if (liveWarden(home, task)) {
    clearNoExitLoopMark(home, task, session);
    return null;
  }
  const unread = countInbox(home, task, ORCHESTRATOR);
  if (!unread) {
    clearNoExitLoopMark(home, task, session);
    return null;
  }
  const key = noExitNoteKey(home, task, unread);
  const mark = readGuardMark(wardenHintMarkFile(home, task, session));
  if (mark?.key === key) return null;
  writeJsonAtomic(wardenHintMarkFile(home, task, session), { key, at: new Date().toISOString() });
  return wardenDeadLine(meta, host, WARDEN_EXIT_UNKNOWN, unread);
}

async function deadWardenItems(home, cwd, session, tasks, probe, host) {
  if (!session || !sameWorkspaceRoot(cwd, home) || !host) return [];
  const items = [];
  for (const meta of tasks) {
    if (meta.status !== 'active') continue;
    if (liveWarden(home, meta.id)) continue;
    const unread = countInbox(home, meta.id, ORCHESTRATOR);
    if (!unread) continue;
    const owner = taskOwner(home, meta.id);
    const wake = readWake(home, meta.id, ORCHESTRATOR);
    if (!(await orchestratorOwnerAlive(wake, owner, probe))) continue;
    const exit = readWardenExit(home, meta.id);
    const reason = exit?.reason ?? WARDEN_EXIT_UNKNOWN;
    items.push({
      id: meta.id,
      line: wardenDeadLine(meta, host, reason, unread),
      key: `warden-dead:${meta.id}:${unread}:${exit?.at ?? noExitSuffix(home, meta.id)}`,
    });
  }
  return items;
}

async function deadOwnerItems(home, cwd, session, tasks, probe) {
  if (!session || !sameWorkspaceRoot(cwd, home)) return [];
  const items = [];
  for (const meta of tasks) {
    const own = ownership(home, meta.id, ORCHESTRATOR, session);
    if (!own.owner || !own.gated) continue;
    const unread = countInbox(home, meta.id, ORCHESTRATOR);
    if (!unread) continue;
    const wake = readWake(home, meta.id, ORCHESTRATOR);
    if (!wake?.socket) continue;
    const socketPath = contactSocketPath(wake.socket);
    let dead = false;
    if (!socketPath || !existsSync(socketPath)) dead = true;
    else if (wake.session && sameOwnerSession(wake.session, own.owner)) dead = false;
    else dead = (await probe(socketPath)).dead;
    if (!dead) continue;
    items.push({
      id: meta.id,
      line: successorLine(meta, own.owner, deadSinceOf(home, meta.id, wake), unread),
      key: successorItemKey(meta.id, own.owner, unread),
    });
  }
  return items;
}

function hintPayload(line, event) {
  if (event?.hook_event_name === GUARD_START_EVENT) {
    return {
      hookSpecificOutput: { hookEventName: GUARD_START_EVENT, additionalContext: line },
      systemMessage: line,
    };
  }
  return { systemMessage: line };
}

function rememberSuccessorHints(home, session, items) {
  const fresh = items.filter((it) => readGuardMark(successorMarkFile(home, it.id, session))?.key !== it.key);
  if (!fresh.length) return null;
  for (const it of fresh) {
    writeJsonAtomic(successorMarkFile(home, it.id, session), { key: it.key, at: new Date().toISOString() });
  }
  return fresh.map((it) => it.line).join('\n');
}

// Successor in the root: the mailbox owner is another session and the socket is dead.
// Capture is not done — a foreign session in the same root need not be the successor.
export async function successorHint(identity, cwd, session, event, probe = probeContactPoint, host = null) {
  const tasks = activeTasks(identity.home);
  if (sessionOnBus(identity.home, session, identity, tasks)) return null;
  pruneNoExitSuccessorMarks(identity.home, tasks);
  const items = [
    ...(await deadOwnerItems(identity.home, cwd, session, tasks, probe)),
    ...(await deadWardenItems(identity.home, cwd, session, tasks, probe, host)),
  ];
  const line = rememberSuccessorHints(identity.home, session, items);
  return line ? { code: 0, payload: hintPayload(line, event) } : null;
}

function rememberTranscript(home, task, addr, session, event) {
  const transcript = said(event?.transcript_path);
  if (!transcript) return;
  try {
    markTranscript(home, task, addr, transcript, session);
  } catch {
    // Sidecar evidence is additive; a write refusal must not block the turn.
  }
}

// Same gates as the Stop path's mark, and any refusal stays inside this call: SessionStart
// still returns its successor hint.
function rememberTranscriptAtStart(identity, session, event) {
  try {
    const task = identity.declaredTask ?? boundTaskId(identity.home, session);
    if (!task || !taskExists(identity.home, task)) return;
    const meta = readTask(identity.home, task);
    if (meta.status !== 'active') return;
    const addr = identity.role;
    const own = ownership(identity.home, task, addr, session);
    if (own.gated || own.right === 'no-identity') return;
    if (foreignSession(identity.home, task, addr, session)) return;
    const transcript = said(event?.transcript_path);
    if (!transcript) return;
    markTranscript(identity.home, task, addr, transcript, session);
  } catch {
    // A transcript mark is additive; resolving the session must not block SessionStart.
  }
}

// Claude Code hook contract: code 2 yields `blockingError`, any other non-zero only warns.
// A clean pass must be code 0 and EMPTY output — a line on every turn is noise.
async function decide(args, env, cwd, event) {
  // Who this session is — from the event payload, not from the environment (see
  // readEvent).
  const session = said(event.session_id) ?? sessionIdentity(env);
  // Identity comes from the hook ARGUMENTS first, the environment only as a fallback: a bg
  // session carries the FIRST spawn's triple. Probe target: swap the order, E2E goes red.
  const here = said(event.cwd) ?? cwd;
  const identity = resolveIdentity(env, here, { move: false, declared: args, host: args.host });
  bus(identity.home, { cli: args.host.version });
  if (storePending(identity.home, args.host)) return null;
  // SessionStart records the transcript, then stays the successor detector: a full
  // guard at start would burn GUARD_BLOCK_LIMIT, since the session id survives resume and clear.
  if (event.hook_event_name === GUARD_START_EVENT) {
    rememberTranscriptAtStart(identity, session, event);
    return successorHint(identity, here, session, event, probeContactPoint, args.host);
  }
  // The task is ONLY what was declared. The hook sits on EVERY workspace session, and "the
  // single active one" would return the turn of a foreign session.
  const task = identity.declaredTask ?? boundTaskId(identity.home, session);
  if (!task || !taskExists(identity.home, task)) {
    return successorHint(identity, here, session, event, probeContactPoint, args.host);
  }
  // A closed task is not guarded: `PROMPTOBUS_TASK` survives close, and there is nothing
  // to send there.
  const meta = readTask(identity.home, task);
  if (meta.status !== 'active') return null;
  const addr = identity.role;
  // Both doors are operations of this record's DRIVER — the guard knows no harness name.
  // The fallback matters: a refusal would go to the outer catch and look like a clean pass.
  const driver = driverOrLift(participantOf(meta, addr));
  // A foreign mailbox — nothing to guard: "fetch the mailbox" would be a lie. No-identity
  // proves nothing either way, so it takes the same route as a proved-foreign session.
  const own = ownership(identity.home, task, addr, session);
  if (own.gated || own.right === 'no-identity') {
    return successorHint(identity, here, session, event, probeContactPoint, args.host);
  }
  // The address is bound to ANOTHER session — this one writes nothing for it. The refusal
  // goes to the warden journal: a silent skip here looks exactly like a clean pass.
  const held = foreignSession(identity.home, task, addr, session);
  if (held) {
    driver.sayForeignWrite(identity.home, task, addr, held, session, 'turn-end mark');
    return null;
  }

  rememberThroughput(identity.home, task, addr, participantOf(meta, addr), event);
  // The warden reads this path to tell a turn waiting on its user from a dropped knock.
  rememberTranscript(identity.home, task, addr, session, event);

  // The guard is the main warden reviver — it alone runs on every turn end. The session is
  // passed EXPLICITLY: without it the record lands with no owner stamp and is wiped each turn.
  driver.registerWake(identity.home, task, addr, env, session);
  // Every OTHER task this session owns gets the same socket: it has no binding of its own, and the
  // first bus call for it is what used to hand one over — which is exactly what never came.
  handOverContactPoints(identity.home, { env, session });
  ensureWarden(identity.home, task, { env, host: args.host });

  const file = guardMarkFile(identity.home, task, addr);
  const wardenNotice = addr === ORCHESTRATOR
    ? wardenExitNotice(identity.home, task, session, meta, args.host)
    : null;
  const verdict = guardVerdict(identity.home, task, addr, session);
  if (!verdict) {
    // A clean pass resets the counter: the next hole is new, and the guard must
    // bargain for it from a full count.
    rmSync(file, { force: true });
    // Set where the turn ENDS: it is the only "session is free" signal for a participant
    // with no background session, and a returned turn (code 2) is a continuation of work.
    markTurn(identity.home, task, addr);
    if (wardenNotice) return { code: 0, payload: { systemMessage: wardenNotice } };
    return null;
  }
  const was = readGuardMark(file);
  const count = was?.key === verdict.key ? (Number(was.count) || 0) + 1 : 1;
  writeJsonAtomic(file, { key: verdict.key, count, at: new Date().toISOString() });
  const label = identityLabel(identity.home, task, addr, session);
  if (count > GUARD_BLOCK_LIMIT) {
    // The return ceiling is passed — the turn ends, whatever the mailbox state.
    markTurn(identity.home, task, addr);
    const tail = wardenNotice ? `${verdict.reason} · ${wardenNotice}` : verdict.reason;
    return {
      code: 0,
      line: `${GUARD_MARK} lets the turn through: the same state ${count} times in a row, and the turn was already returned `
        + `${GUARD_BLOCK_LIMIT} times — returning further is not allowed, or the session will never finish a turn. `
        + `The state is unchanged: ${tail} · ${label}`,
    };
  }
  const reason = wardenNotice ? `${verdict.reason} · ${wardenNotice}` : verdict.reason;
  return { code: 2, line: `${GUARD_MARK}: ${reason} · ${label}` };
}

export async function guard(args = {}, env = process.env, cwd = process.cwd(), stdin = process.stdin) {
  let out = null;
  try {
    out = await decide(args, env, cwd, await readEvent(stdin));
  } catch {
    // The guard must not stop a session from living: a launch outside the workspace, a bad
    // role, a broken journal — none of them is a reason to return the turn.
    return;
  }
  if (!out) return;
  if (out.code === 0) {
    // A skip is spoken on the tape channel — at code 0 the harness lifts stderr nowhere, and
    // the insurance would come off in silence. SessionStart needs additionalContext too.
    const payload = out.payload ?? (out.line ? { systemMessage: out.line } : null);
    if (payload) process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  // The return reason goes to stderr verbatim, without colour and without a mark: it is read
  // by the model, not by a person — the harness pastes stderr into its `blockingError`.
  process.stderr.write(`${out.line}\n`);
  process.exitCode = out.code;
}

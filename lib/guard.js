import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {
  activeTasks, addrDir, addressOf, boundTaskId, countInbox, foreignSession, foreignSessionOf,
  identityLabel, markTurn, ORCHESTRATOR, ownership, participantOf, readHealth, readTask,
  readWake, resolveIdentity, sameOwnerSession, sessionIdentity, sessionIdOf, sessionOf,
  storePending, taskDir, taskExists, writeJsonAtomic,
} from './store.js';
import { ensureWarden } from './warden.js';
import { driverOrLift } from './drivers.js';
import { GUARD_START_EVENT } from '../dist/hooks.js';

// Bus loop guard. The layout Stop hook calls it on EVERY turn end, and the subject is
// one: do not let a session finish a turn in a state from which nobody will wake it. A
// turn that ended with a report to a person and no bus call does not invoke the
// insurance in tool replies.

// Own mark for recognizability in the tape: this is not a command refusal, it is a
// turn return.
export const GUARD_MARK = 'LOOP GUARD';

// How many times in a row the guard returns the turn on THE SAME state. Its own ceiling
// is needed next to Claude Code's ceiling of 8 in a row (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`):
// eight returns — eight model turns on the same thing. Two are enough: the first names
// the state, the second catches a turn started past it.
export const GUARD_BLOCK_LIMIT = 2;

// Counter of consecutive returns — a file in the task `waits/`, one file per address.
export function guardMarkFile(home, task, addr) {
  return path.join(taskDir(home, task), 'waits', `${addrDir(addr)}.guard.json`);
}

// Mark "this session has already been told" — in waits/ of the dead owner's task, a
// file per reader. A shared file per task would eat the hint of the next session in the
// root (a failed chat, a second job): the real successor would stay silent on
// SessionStart.
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

// `Stop` event payload: JSON on stdin (`session_id`, `cwd`, and other fields).
// Reading it is REQUIRED: `CLAUDE_CODE_SESSION_ID` is not promised to the hook process,
// and without it the guard would silently not work, indistinguishable from a clean
// pass. The environment stays a fallback (a hand launch carries no payload). Measured
// with a live hook 2026-08-29 (claude 2.1.251): both paths work, one is promised.
// `isTTY` is the hang gate: a subcommand started by hand would wait for EOF forever.
// Everything unparsed is an empty payload.
async function readEvent(stdin) {
  if (stdin.isTTY) return {};
  try {
    let raw = '';
    stdin.setEncoding('utf8');
    for await (const chunk of stdin) raw += chunk;
    const event = JSON.parse(raw);
    return event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  } catch {
    return {};
  }
}

function said(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// The state that requires returning the turn, or `null` — "clean". `key` is the "same
// state" signal for the return counter; it includes the NUMBER of messages: a new one
// arrived — the state is different, the counter resets.
export function guardVerdict(home, task, addr) {
  const unread = countInbox(home, task, addr);
  if (!unread) return null;
  return {
    key: `mailbox:${unread}`,
    reason: `mailbox has ${unread} — the turn is ending and the messages are unread: `
      + 'fetch them with the promptobus_mailbox tool and reply in your role',
  };
}

// How long to wait for the owner's socket to answer. The Stop hook lives fractions of
// a second, and hanging on a dead path longer than the knock threshold is not allowed:
// file ENOENT is cut off before connect.
const SUCCESSOR_PROBE_MS = 200;

function sameWorkspaceRoot(cwd, home) {
  if (!cwd || !home) return false;
  try {
    return realpathSync(cwd) === realpathSync(path.dirname(home));
  } catch {
    return false;
  }
}

function declaredParticipant(identity) {
  const role = identity?.role;
  return typeof role === 'string' && (role.startsWith('worker:') || role.startsWith('reviewer:'));
}

function holdsSession(participant, session) {
  return Boolean(
    (sessionIdOf(participant) ?? sessionOf(participant))
    && foreignSessionOf(participant, session) === null,
  );
}

// The session is already on the bus: a binding, the mailbox owner, or a
// worker/reviewer in the journal. A foreign one in the root is not yet a successor
// until they claim themselves.
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

// A contact point is dead only if the socket was handed over and is missing or does
// not accept. No record — the owner may simply not have finished the first turn yet,
// that is not death. Connect only when the file exists and the id in wake does not
// match the owner: a live owner's harness would get a connection without auth at every
// turn end of every session in the root, and the reaction to that is unmeasured.
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
    let dead = false;
    if (!existsSync(wake.socket)) dead = true;
    else if (wake.session && sameOwnerSession(wake.session, own.owner)) dead = false;
    else dead = (await probe(wake.socket)).dead;
    if (!dead) continue;
    items.push({
      id: meta.id,
      line: successorLine(meta, own.owner, deadSinceOf(home, meta.id, wake), unread),
      key: successorItemKey(meta.id, own.owner, unread),
    });
  }
  return items;
}

// Successor in the root: the orchestrator mailbox owner is another session, the socket
// is dead. Capture is not done: a foreign session in the same root is not obliged to be
// the successor.
export async function successorVerdict(
  home, cwd, session, tasks = activeTasks(home), probe = probeContactPoint,
) {
  const items = await deadOwnerItems(home, cwd, session, tasks, probe);
  return items.length ? items.map((it) => it.line).join('\n') : null;
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

async function successorHint(identity, cwd, session, event) {
  const tasks = activeTasks(identity.home);
  if (sessionOnBus(identity.home, session, identity, tasks)) return null;
  const items = await deadOwnerItems(identity.home, cwd, session, tasks, probeContactPoint);
  const line = rememberSuccessorHints(identity.home, session, items);
  return line ? { code: 0, payload: hintPayload(line, event) } : null;
}

// Guard decision: exit code and what goes to stderr. Claude Code hook contract: code 2
// yields `blockingError`, any other non-zero is a warning that does not return the
// turn. A clean pass must be code 0 and EMPTY output: a line on every turn is noise.
async function decide(args, env, cwd, event) {
  // Who this session is — from the event payload, not from the environment (see
  // readEvent).
  const session = said(event.session_id) ?? sessionIdentity(env);
  // Participant identity — from the hook command ARGUMENTS, and that is the FIRST
  // source. The environment stays a fallback: a workspace hook has no arguments at all,
  // and a hand launch may carry none. Trusting it first is not allowed — a harness
  // background session puts the triple from the FIRST spawn of the run into the
  // environment, and a second task participant would resolve as the first's address.
  // Mutation-probe target: swap the order — E2E goes red.
  //
  // The home is resolved WITHOUT a move: the guard does not initiate it. The reason is
  // not caution, it is that nobody will see a report from here — at code 0 the hook
  // stderr is not lifted anywhere, and a move is promised to the user in numbers. If a
  // move is needed (or it refuses) — the guard silently lets the turn through: there is
  // still nothing to hold it on unread mail, the store cannot be read. The store is
  // moved by a command or the bus-server lift, both of which have visible output.
  const here = said(event.cwd) ?? cwd;
  const identity = resolveIdentity(env, here, { move: false, declared: args, host: args.host });
  if (storePending(identity.home, args.host)) return null;
  // SessionStart in the root is only the successor detector. A full guard
  // (registerWake, turn return, counter) at start would burn GUARD_BLOCK_LIMIT: the
  // session id survives resume/clear, and an orchestrator with unread mail would get
  // "LOOP GUARD" before the first turn.
  if (event.hook_event_name === GUARD_START_EVENT) {
    return successorHint(identity, here, session, event);
  }
  // The task is ONLY from what was declared: `PROMPTOBUS_TASK` or a disk binding. The
  // hook sits on EVERY workspace session, and "the single active one" would return the
  // turn of a foreign session.
  const task = identity.declaredTask ?? boundTaskId(identity.home, session);
  if (!task || !taskExists(identity.home, task)) {
    return successorHint(identity, here, session, event);
  }
  // A closed task is not guarded: `PROMPTOBUS_TASK` survives close, and there is nothing
  // to send there.
  const meta = readTask(identity.home, task);
  if (meta.status !== 'active') return null;
  const addr = identity.role;
  // Both doors of the address-ownership gate and the contact-point handoff are
  // operations of this record's DRIVER: only the harness knows where the socket address
  // and token live, and the guard does not know the harness name at all. Door with
  // fallback to the lift driver: there may be no journal record at all (a human
  // session), and on a record with a foreign harness the refusal would go into the
  // outer `catch` — so the guard would silently not work on EVERY turn of such a
  // session, indistinguishable from a clean pass.
  const driver = driverOrLift(participantOf(meta, addr));
  // A foreign mailbox — nothing to guard: originals go to the owner, "fetch the
  // mailbox" would be a lie. In the root this is the successor after an id change: a
  // hint, not a turn return and not an auto-claim.
  if (ownership(identity.home, task, addr, session).gated) {
    return successorHint(identity, here, session, event);
  }
  // The address is bound in the journal to ANOTHER session — this one writes nothing
  // for it: neither a contact point nor a turn-end mark. Second line after the hook
  // arguments: it holds both a hand launch with a foreign triple in the environment
  // and a participant lifted by a former release. The refusal goes to the warden
  // journal: this is the most common way into trouble — a foreign Stop hook — and a
  // silent skip here is indistinguishable from a clean pass (second review round).
  const held = foreignSession(identity.home, task, addr, session);
  if (held) {
    driver.sayForeignWrite(identity.home, task, addr, held, session, 'turn-end mark');
    return null;
  }

  // The guard is the main warden reviver: it alone is called on every turn end. In the
  // same turn the session hands over its contact point — the hook lives as its child
  // process. The session goes there EXPLICITLY: `CLAUDE_CODE_SESSION_ID` is not promised
  // to the hook process, and here it is already resolved from the event payload —
  // without that the record would land without an owner stamp and would wipe it on
  // every turn end (review note).
  driver.registerWake(identity.home, task, addr, env, session);
  ensureWarden(identity.home, task, { env, host: args.host });

  const file = guardMarkFile(identity.home, task, addr);
  const verdict = guardVerdict(identity.home, task, addr);
  if (!verdict) {
    // A clean pass resets the counter: the next hole is new, and the guard must
    // bargain for it from a full count.
    rmSync(file, { force: true });
    // The turn really ended. The mark of that is the only "session is free" signal for
    // a participant without a background session, and the warden uses it to decide
    // whether to knock again. It is set where the turn ENDS: the turn return (code 2)
    // below is a continuation of work, and marking it as an end would mean knocking a
    // session that just had the turn returned.
    markTurn(identity.home, task, addr);
    return null;
  }
  const was = readGuardMark(file);
  const count = was?.key === verdict.key ? (Number(was.count) || 0) + 1 : 1;
  writeJsonAtomic(file, { key: verdict.key, count, at: new Date().toISOString() });
  const label = identityLabel(identity.home, task, addr, session);
  if (count > GUARD_BLOCK_LIMIT) {
    // The return ceiling is passed — the turn ends, whatever the mailbox state.
    markTurn(identity.home, task, addr);
    return {
      code: 0,
      line: `${GUARD_MARK} lets the turn through: the same state ${count} times in a row, and the turn was already returned `
        + `${GUARD_BLOCK_LIMIT} times — returning further is not allowed, or the session will never finish a turn. `
        + `The state is unchanged: ${verdict.reason} · ${label}`,
    };
  }
  return { code: 2, line: `${GUARD_MARK}: ${verdict.reason} · ${label}` };
}

export async function guard(args = {}, env = process.env, cwd = process.cwd(), stdin = process.stdin) {
  let out = null;
  try {
    out = await decide(args, env, cwd, await readEvent(stdin));
  } catch {
    // The guard must not stop a session from living: a launch outside the workspace, a
    // bad `PROMPTOBUS_ROLE`, a broken journal — not a reason to return the turn or write
    // to the tape.
    return;
  }
  if (!out) return;
  if (out.code === 0) {
    // A skip is spoken on the tape channel — `{"systemMessage": …}` on stdout: at
    // code 0 the harness lifts stderr nowhere, and the insurance would come off in
    // silence. SessionStart reads the same JSON plus additionalContext — otherwise the
    // start text never enters the context.
    const payload = out.payload ?? (out.line ? { systemMessage: out.line } : null);
    if (payload) process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  // The return reason goes to stderr verbatim, without color and without a mark: it is
  // read not by a person in a terminal, but by the model — the harness pastes stderr
  // into its `blockingError`.
  process.stderr.write(`${out.line}\n`);
  process.exitCode = out.code;
}

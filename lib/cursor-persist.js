import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { run } from './exec.js';
import { shellQuote } from './util.js';
import { PROMPTOBUS_SERVER } from './contract.js';
import { harnessStateHome } from './harness-home.js';

// Persist-session machinery of Cursor — the inside of the Cursor driver
// ([driver-cursor.js](driver-cursor.js)), one floor below it, as [liftoff.js](liftoff.js)
// is for Claude. Nobody outside imports this file: the adapter-boundary gate
// ([promptobus-adapter.test.mjs](../test/promptobus-adapter.test.mjs)) holds it too.
//
// **What `agent persist` is.** A wrapper over tmux (spike, REPORT §2): the subcommand
// lifts an ordinary interactive TUI in a pane of the `cursor-agent` tmux server
// (`TMUX_TMPDIR=/tmp tmux -u -L cursor-agent -f /dev/null`), stamps the session with its
// options (`@cursor_managed`, `@cursor_workspace_hash`, `@cursor_session_version`,
// `@cursor_chat_id`), and outlives the parent. It has no socket of its own and no
// session server of its own — everything the mechanism needs from a “session server”
// is given by tmux: list, input, output, stop.
//
// **Hence three things the headless path did not have.** A live process between turns,
// human entry (`agent persist attach`), and programmatic input into a live session: text
// arrives by keypress in the TUI, not by a new process. The mechanism no longer holds
// turns at all — the binary itself holds them, and the mechanism keeps the session
// record and talks to it through tmux.
//
// **Registry home is `~/.promptobus/cursor`, not `~/.cursor`.** The second is the
// human's home, and the mechanism has no right to write there beyond what Cursor itself
// lays. `PROMPTOBUS_CURSOR_HOME` moves it entirely: the suite uses it to put the
// registry in a sandbox, otherwise a run would write into the developer's home. Cursor's
// own home is moved by its own variable — `PROMPTOBUS_CURSOR_USER_HOME` — and only the
// suite moves that too: real transcripts live in `~/.cursor/projects`.
//
// Every number and shape below was taken from live spike runs (2026-09-03, `agent`
// 2026.09.02-c22c1a3, tmux 3.6b), not inferred from documentation: Cursor has no docs
// on `persist` at all, and the subcommand itself has no flags of its own.

/** Environment variable that marks the session for process reap and contact-point handoff. */
export const SESSION_ENV_VAR = 'PROMPTOBUS_CURSOR_SESSION';

/**
 * Tmux server persist sessions live on. The name is not ours — `persist` itself chooses
 * it, and the mechanism will not change it with `CURSOR_AGENT_TMUX_SERVER_NAME`:
 * participants live on a shared server exactly so a human has enough with
 * `agent persist list` and `agent persist attach <name>` without a single variable in
 * the environment (owner decision).
 */
export const CURSOR_TMUX_SERVER = 'cursor-agent';

/** Harness name the registry is keyed by — the same string the driver declares as its id. */
const CURSOR_HARNESS = 'cursor';

/**
 * Server of one-shot pty provider panes. Its own, because the pane is lift machinery,
 * not a participant session: it has no place in `agent persist list`, and it is
 * stopped a second after start.
 */
export const LAUNCH_TMUX_SERVER = 'promptobus-launch';

/**
 * `persist` lifts its server with `TMUX_TMPDIR=/tmp` (REPORT §2), and talk with it
 * must come from there too: the socket is looked up by that variable, and its default
 * differs across systems.
 */
export const TMUX_TMPDIR = '/tmp';

/** Options `persist` stamps on its session. They are how it is recognised among others. */
export const CURSOR_SESSION_OPTS = ['@cursor_managed', '@cursor_workspace_hash', '@cursor_session_version', '@cursor_chat_id'];

/**
 * Options the mechanism stamps on ITS sessions. `inspect` tells participants from a
 * human's persist sessions by them, and cleanup does not touch foreigners by them:
 * the server is shared, and “stop everything that was found” would take a human's work.
 */
export const TASK_OPT = '@promptobus_task';
export const ADDRESS_OPT = '@promptobus_address';

/**
 * Pause between pasting text and `Enter`. Spike measurement (REPORT §4.3): without the
 * pause Enter is LOST — the text stays in the input field and glues onto the next
 * message (live case: `LAT-8` and `LAT-9` went into the transcript as one message).
 * At 0.3–0.4 s every run passed; we take the top of the measurement.
 */
export const ENTER_PAUSE_MS = 400;

/** How long we wait for the input field to empty: a broken case is the ceiling, a normal one is a tick or two. */
export const INPUT_WAIT_MS = 5_000;
export const INPUT_STEP_MS = 100;
export const ENTER_SETTLE_MS = 400;

/**
 * Ceiling of SILENCE in the transcript, not of the turn's total time.
 *
 * The threshold is on silence because a real worker's turn runs for MINUTES: it reads
 * files, edits them, and calls tools, and a total ceiling would cut live work. The
 * number is the same as the former stream watchdog: 180 s — six times the longest
 * normal turn in full. What changed is WHAT is silent: not the `stream-json` stream,
 * which persist does not have at all, but the transcript file.
 *
 * And what the watchdog DOES changed. The mechanism no longer has a turn process;
 * there is nothing to kill: the threshold now gives `inspect` a verdict — “the turn
 * has been silent past the threshold” — and the decision stays with the human and the
 * warden.
 */
export const TURN_IDLE_MS = 180_000;

/**
 * Window in which an injection counts as a started turn even though the transcript is
 * still silent about it. Spike measurement: from injection to a reply in the
 * transcript 3.09 and 8.03 s (`composer-2.5`), so the first line does not appear at
 * once. Without the window `inspect` in that gap would say “the session is free”, and
 * the warden would send a second wake on the same unread.
 */
export const INJECT_GRACE_MS = 20_000;

/**
 * How long we wait for the persist session to appear in the tmux list. Measurement:
 * 1.17–1.39 s (three starts), the ceiling has slack for a busy machine. The wait form
 * is `{tries, delayMs}`, the same as the neighbouring driver: `awaitOptions` arrives
 * from the caller as one contract, and a second form here would silently ignore a
 * foreign one (review note).
 */
export const LIFT_TRIES = 240;
export const LIFT_STEP_MS = 250;

/** How long we wait for the session to vanish after `persist stop`. Measurement of stop itself: 0.14–0.15 s. */
export const STOP_TIMEOUT_MS = 10_000;
export const STOP_STEP_MS = 100;

/**
 * Suite seam: the live silence threshold is measured in minutes, and there is nothing
 * to wait those out in the suite. The variable is read only here; in life it is unset,
 * and the threshold stays live.
 */
export function turnIdleMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CURSOR_IDLE_MS);
  return Number.isFinite(named) && named > 0 ? named : TURN_IDLE_MS;
}

// --- session registry ---------------------------------------------------------------

/**
 * Registry of OUR persist sessions. `PROMPTOBUS_CURSOR_HOME`, else the host, else a
 * refusal — never a guess under the real home; the reason is in
 * [harness-home.js](harness-home.js).
 */
export function cursorStateHome(env = process.env) {
  return harnessStateHome(CURSOR_HARNESS, env);
}

/** Cursor's own home: it keeps session transcripts there. Moved only by the suite. */
export function cursorUserHome(env = process.env) {
  const named = String(env.PROMPTOBUS_CURSOR_USER_HOME ?? '').trim();
  return named || path.join(homedir(), '.cursor');
}

export function sessionsDir(env = process.env) {
  return path.join(cursorStateHome(env), 'sessions');
}

/**
 * File key from an opaque session reference. The readable part is so the registry
 * directory can be read by eye; the tail is sha1 of the full ref, because the readable
 * part does not distinguish it: a session name carries Cyrillic and brackets, and after
 * stripping non-Latin two different names would collapse into one file, that is into
 * one session.
 */
export function sessionKey(ref) {
  const flat = String(ref ?? '');
  const head = flat.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  const hash = createHash('sha1').update(flat).digest('hex').slice(0, 12);
  return head ? `${head}-${hash}` : hash;
}

export function sessionFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.json`);
}

/** Lift script: the pty provider pane calls `persist` through it. Lives until the session is confirmed. */
function launchScriptFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.launch.sh`);
}

/** Inject lock: a session has one writer. Two injections at once would glue two messages into one. */
function lockFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.inject.lock`);
}

/**
 * How long a lock is considered live without its process. An injection takes a second,
 * a broken one about five (wait ceilings below); a minute has slack for a slow machine
 * and is ten times smaller than the participant silence threshold.
 */
export const LOCK_STALE_MS = 60_000;

/**
 * Take the inject lock or say who holds it.
 *
 * **An ownerless lock is taken over** (review note). `finally` of its own process
 * drops the lock, and delivery has two processes — the warden and a mechanism
 * command; if the writer dies between take and drop, the lock would outlive it, and
 * EVERY later delivery into this session would refuse "already writing into this
 * session" until the participant is stopped. So the lock holds a pid and a time: a
 * dead pid or a record older than the threshold is an ownerless lock, and it is taken
 * again.
 */
function takeLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: 'wx' });
      return { ok: true };
    } catch {
      // Lock is taken — see whether its holder is alive.
    }
    let held = null;
    try {
      held = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      held = null;
    }
    const age = Date.now() - Date.parse(held?.at ?? '');
    const alive = pidAlive(Number(held?.pid));
    if (alive && !(Number.isFinite(age) && age > LOCK_STALE_MS)) {
      return {
        ok: false,
        error: `process ${held?.pid ?? '(pid not named)'} is already writing into this session — two injections at once would glue `
          + `into one message. The lock drops itself; if it is stuck, drop it by hand: ${file}`,
      };
    }
    rmSync(file, { force: true });
  }
  return {
    ok: false,
    error: `inject lock cannot be taken: someone else grabbed it between the two attempts — ${file}`,
  };
}

/** File the text leaves through into the tmux buffer: multiline does not ride through argv. */
function bufferFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.buf`);
}

function writeJson(file, value, { secret = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, secret ? { mode: 0o600 } : undefined);
  renameSync(tmp, file);
  return value;
}

export function readSession(ref, env = process.env) {
  try {
    return JSON.parse(readFileSync(sessionFile(ref, env), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(record, env = process.env) {
  // Mode `0600`: the record holds a working-tree path, a chat id, and a session name —
  // not a token, but not something the whole machine should read either.
  return writeJson(sessionFile(record.ref, env), record, { secret: true });
}

/**
 * Patch the record under read-write. It has two writers — the turn-end hook and
 * mechanism commands — and they change DIFFERENT fields: the hook owns the turn
 * counter, commands start and tear down the session. A full replace is therefore done
 * nowhere: a merge on top of a fresh read is cheaper than a lock and loses exactly
 * what would have been overwritten anyway.
 */
export function patchSession(ref, patch, env = process.env) {
  const was = readSession(ref, env);
  if (!was) return null;
  return writeSession({ ...was, ...patch }, env);
}

/** Drop the session from the registry entirely — record, lift script, lock, and buffer. */
export function dropSession(ref, env = process.env) {
  for (const file of [sessionFile(ref, env), launchScriptFile(ref, env), lockFile(ref, env), bufferFile(ref, env)]) {
    rmSync(file, { force: true });
  }
}

/** Whether the process is alive. Signal 0 — the same mark the whole mechanism judges liveness by. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function settle(ms) {
  await new Promise((r) => { setTimeout(r, ms); });
}

// --- talk with tmux -----------------------------------------------------------------

/**
 * Tmux call on the named server. `-f /dev/null` — the same flag `persist` uses: a
 * human's personal `~/.tmux.conf` must not reach a participant session, otherwise
 * their bindings and their `default-shell` would change what the mechanism pastes and
 * reads.
 */
export function tmux(args, { server = CURSOR_TMUX_SERVER, env = process.env, input = null } = {}) {
  return run('tmux', ['-u', '-L', server, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
    env: { ...env, TMUX_TMPDIR },
    ...(input === null ? {} : { input }),
  });
}

/**
 * Fields tmux returns session state by, machine-readable, and the separator between
 * them: there is no need to parse the human text of `persist list`, tmux returns the
 * same fields as fields. There are no paths in the list — a separator can appear in
 * those, and cannot in a session name, a hash, a chat id, or our marks.
 */
const LIST_SEP = '|';
const LIST_FIELDS = [
  '#{session_name}', '#{session_attached}', '#{session_created}', '#{pane_pid}',
  '#{@cursor_managed}', '#{@cursor_workspace_hash}', '#{@cursor_chat_id}', `#{${TASK_OPT}}`, `#{${ADDRESS_OPT}}`,
];

/**
 * Server sessions, machine-readable. An empty list for a missing server is not a
 * refuse: a tmux server lives while it has sessions, and “no server running” means
 * exactly “there are no sessions”.
 */
export function listSessions({ server = CURSOR_TMUX_SERVER, env = process.env } = {}) {
  const r = tmux(['list-sessions', '-F', LIST_FIELDS.join(LIST_SEP)], { server, env });
  if (r.error || r.status !== 0) return [];
  return String(r.stdout ?? '').split('\n').filter(Boolean).map((line) => {
    const [name, attached, created, panePid, managed, hash, chatId, task, address] = line.split(LIST_SEP);
    return {
      name,
      attached: Number(attached) || 0,
      created: Number(created) || 0,
      panePid: Number(panePid) || null,
      managed: managed === '1',
      hash: hash || null,
      chatId: chatId || null,
      task: task || null,
      address: address || null,
    };
  });
}

/** One session by name, or `null`. */
export function findSession(name, { server = CURSOR_TMUX_SERVER, env = process.env } = {}) {
  if (!name) return null;
  return listSessions({ server, env }).find((s) => s.name === name) ?? null;
}

/**
 * Working-directory hash `persist` stamps on its session (REPORT §2, §4.10): the first
 * ten digits of sha256 of the path. The mechanism finds ITS session among foreigners
 * by it — the binary itself chooses the name and does not print it in advance.
 *
 * **The path is taken RESOLVED** (live measurement 2026-09-03): Cursor hashes what the
 * path unfolds into, and on macOS `$TMPDIR` is a symlink, so `/var/folders/…` versus
 * `/private/var/folders/…` give different hashes. Fail to resolve the path — and a
 * lift from such a directory waits for its session until the ceiling, then declares a
 * LIVE session unlifted and leaves it on the machine.
 */
export function workspaceHash(cwd) {
  let flat = String(cwd);
  try {
    flat = realpathSync(flat);
  } catch {
    // The directory is not there yet, or it is unreachable — hash as-is: our session
    // then simply will not be found, and lift will say so with a refuse.
  }
  return createHash('sha256').update(flat).digest('hex').slice(0, 10);
}

/** What is visible in the pane now. Read for the input field and the running-turn label. */
export function capturePane(name, { server = CURSOR_TMUX_SERVER, env = process.env } = {}) {
  const r = tmux(['capture-pane', '-p', '-t', name], { server, env });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout ?? '');
}

/**
 * TUI labels the input protocol rests on. Both were taken from live spike runs
 * (REPORT §4.3, §4.6) and both are NOT a documented interface: Cursor's TUI has no
 * version at all, and any edit of it can break the read. So they are gathered here, in
 * one place, not scattered through the code: if it breaks, it is fixed by a string.
 */
const INPUT_PROMPT = '→ ';
const INPUT_PLACEHOLDER = 'Add a follow-up';
const BUSY_LINE = 'ctrl+c to stop';

/**
 * Text standing in the pane input field. An empty field is the prompt with no text.
 *
 * **The running-turn label lives on the SAME line as the input field** (live
 * measurement 2026-09-03, `cursor-grok-4.6-xhigh-fast`): while a turn is running the
 * line looks like `→ Add a follow-up` then spaces then `ctrl+c to stop`. Do not strip
 * it — and the input field reads as occupied on every running turn: delivery refuses
 * "text stayed in the input field", though the field is empty. That is what happened
 * on the first live persist run — three refuses out of three with delivery otherwise
 * healthy.
 */
export function inputText(pane) {
  const lines = String(pane ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith(INPUT_PROMPT)) continue;
    let text = line.slice(INPUT_PROMPT.length).trim();
    if (text.endsWith(BUSY_LINE)) text = text.slice(0, -BUSY_LINE.length).trim();
    return text === INPUT_PLACEHOLDER ? '' : text;
  }
  return '';
}

// --- lift ---------------------------------------------------------------------------

// Names `-u` unsets do not go into assignments: `env` applies arguments left to right,
// and `TMUX=…` after `-u` would put a foreign session back.
const LAUNCH_UNSET = ['TMUX', 'TMUX_PANE'];

/**
 * Pty provider pane script.
 *
 * The environment is materialised HERE, not inherited by the pane, and that is not
 * over-caution: the pane inherits the tmux SERVER environment, and the server may have
 * been lifted on a previous lift with a different environment — the session mark would
 * ride into a foreign record. `env -u` on `LAUNCH_UNSET` is a spike trap (REPORT §4.2):
 * inside a foreign `TMUX` the `persist` subcommand SILENTLY lifts an ordinary
 * non-persistent `agent` — no tmux session, no line in `persist list`, no word about
 * it in the output.
 */
export function launchScript({ bin, argv, env }) {
  const drop = new Set(LAUNCH_UNSET);
  const assignments = Object.entries(env ?? {})
    .filter(([k, v]) => v !== undefined && v !== null && !drop.has(k))
    .map(([k, v]) => `${k}=${shellQuote(String(v))}`);
  const unsetFlags = LAUNCH_UNSET.map((n) => `-u ${n}`).join(' ');
  return `#!/bin/sh\nexec env ${unsetFlags} ${assignments.join(' ')} \\\n  ${shellQuote(bin)} `
    + `${argv.map(shellQuote).join(' ')}\n`;
}

/**
 * Lift a persist session: a one-shot pane on its own server, wait for the session in
 * the `cursor-agent` list, stamp task and address, stop the pane.
 *
 * The binary itself chooses the session name (`cursor-<slug>-<hash>-<n>-<rand6>`), and
 * it cannot be printed in advance — so it is learned AFTER start, exactly like the
 * chat id. Our session is recognised by three marks at once: the working-directory
 * hash, a non-empty `@cursor_chat_id`, and a creation time not earlier than our start
 * — a human's persist sessions live next to it on the shared server, and taking a
 * foreign one would mean writing into their correspondence.
 */
export async function liftSession({
  ref, bin, argv, cwd, env = process.env, launchEnv = null, task = null, address = null,
  tries = LIFT_TRIES, delayMs = LIFT_STEP_MS,
}) {
  const script = launchScriptFile(ref, env);
  mkdirSync(path.dirname(script), { recursive: true });
  // The SESSION environment and the environment of our tmux calls are different
  // things: the first is materialised in the script (otherwise the pane would inherit
  // the tmux-server environment, and it may have been lifted on a previous lift), the
  // second is needed only to find the server socket.
  writeFileSync(script, launchScript({ bin, argv, env: launchEnv ?? env }), { mode: 0o700 });
  const hash = workspaceHash(cwd);
  const known = new Set(listSessions({ env }).map((s) => s.name));
  const startedAt = Math.floor(Date.now() / 1000);
  const pane = `promptobus-${sessionKey(ref)}`;
  // Pane width is set explicitly: `capture-pane` reads what is drawn, and a narrow
  // pane would break input-field lines. A live session's width is later shrunk by a
  // human who entered (REPORT §4.5) — but lift must not depend on their terminal.
  const started = tmux(['new-session', '-d', '-s', pane, '-x', '200', '-y', '50', '-c', cwd, 'sh', script],
    { server: LAUNCH_TMUX_SERVER, env });
  if (started.error || started.status !== 0) {
    rmSync(script, { force: true });
    const why = started.error?.message ?? (String(started.stderr ?? '').trim() || `code ${started.status}`);
    return { ok: false, error: `pty provider pane did not lift: ${why}` };
  }
  let seen = null;
  for (let i = 0; i < tries; i += 1) {
    seen = listSessions({ env }).find((s) => s.hash === hash && s.chatId && !known.has(s.name)
      && s.created >= startedAt - 2) ?? null;
    if (seen) break;
    if (i < tries - 1) await settle(delayMs);
  }
  if (seen) {
    // Mark of our session: `inspect` tells a participant from a human persist session
    // by it, and cleanup tells ours from a foreigner's. Set BEFORE the pane is
    // stopped: a stopped pane does not touch the session, and an unmarked session on
    // the shared server is indistinguishable from a foreign one.
    if (task) tmux(['set-option', '-t', seen.name, TASK_OPT, task], { env });
    if (address) tmux(['set-option', '-t', seen.name, ADDRESS_OPT, address], { env });
  }
  // The pane is stopped in both branches: the persist session outlives it (REPORT §2),
  // and a failed lift has no right to leave a process behind.
  tmux(['kill-session', '-t', pane], { server: LAUNCH_TMUX_SERVER, env });
  rmSync(script, { force: true });
  if (!seen) {
    return {
      ok: false,
      error: 'persist session did not appear in the tmux list. That is how a binary refuse before start looks '
        + '(wrong model id, expired login), and a launch from inside a foreign TMUX — then persist silently '
        + 'lifts an ordinary non-persistent agent',
    };
  }
  return { ok: true, session: seen };
}

// --- input --------------------------------------------------------------------------

/**
 * Deliver text into a live session.
 *
 * The protocol is the one the spike measured (REPORT §4.3), and each step pays for a
 * live miss:
 *
 *   1. **the input field is cleared**, otherwise leftover from a previous failure
 *      rides out with the new text;
 *   2. **text rides in a tmux buffer**, not `send-keys -l`: a multiline message via
 *      bracketed paste lands in the transcript as ONE message, and line-by-line input
 *      would send it as several;
 *   3. **a pause stands between paste and `Enter`** — without it Enter is lost, the
 *      text stays in the field and glues onto the next message;
 *   4. **paste and send are checked against `capture-pane`**: empty in the field
 *      means it went.
 *
 * Delivery also goes into a RUNNING turn. The text queues in the TUI and runs as a
 * separate turn right after the current one (REPORT §4.3): the running turn does not
 * see it, the injection does not interrupt the turn, a second parallel turn does not
 * appear. There is no longer a reason to refuse “a turn is running” here — the
 * message is not lost, it waits.
 */
export async function injectText(record, text, { env = process.env, pauseMs = ENTER_PAUSE_MS } = {}) {
  const name = record?.sessionName;
  const server = record?.tmuxServer || CURSOR_TMUX_SERVER;
  if (!name) return { ok: false, error: 'the session record has no persist session name — nothing to deliver' };
  const lock = lockFile(record.ref, env);
  mkdirSync(path.dirname(lock), { recursive: true });
  const taken = takeLock(lock);
  if (!taken.ok) return taken;
  try {
    const cleared = await clearInput(name, { server, env });
    if (!cleared.ok) return cleared;
    const buf = bufferFile(record.ref, env);
    writeFileSync(buf, text);
    const bufName = `promptobus-${sessionKey(record.ref)}`;
    const loaded = tmux(['load-buffer', '-b', bufName, buf], { server, env });
    if (loaded.error || loaded.status !== 0) {
      return { ok: false, error: `text did not go into the tmux buffer: ${String(loaded.stderr ?? '').trim() || `code ${loaded.status}`}` };
    }
    // `-p` — bracketed paste (one message), `-d` — the buffer is dropped at once: the
    // buffer name is one per session, and leftover from a previous paste would ride
    // with the next.
    const pasted = tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', name], { server, env });
    rmSync(buf, { force: true });
    if (pasted.error || pasted.status !== 0) {
      return { ok: false, error: `text did not paste into the input field: ${String(pasted.stderr ?? '').trim() || `code ${pasted.status}`}` };
    }
    // Pause before Enter — the step without which Enter is lost. Mutation-probe
    // target: drop it, and the stand glues two messages into one, as the live run
    // glued them.
    await settle(pauseMs);
    const sent = tmux(['send-keys', '-t', name, 'Enter'], { server, env });
    if (sent.error || sent.status !== 0) {
      return { ok: false, error: `Enter did not reach the session: ${String(sent.stderr ?? '').trim() || `code ${sent.status}`}` };
    }
    // The field empties right after Enter — wait a tick or two, not the full ceiling:
    // the warden loop waits for this operation SYNCHRONOUSLY, and extra seconds here
    // cost a delivery delay for every other participant. The whole delivery costs
    // about a second: 0.4 s pause before Enter plus five tmux calls of thirty to forty
    // milliseconds each.
    const gone = await waitInput(name, { server, env }, (value) => value === '', { timeoutMs: ENTER_SETTLE_MS });
    if (!gone) {
      return {
        ok: false,
        error: 'text stayed in the input field after Enter — the message was not sent; the next delivery clears the field '
          + 'and sends again',
      };
    }
    return { ok: true };
  } finally {
    // Only taken locks reach here: a `takeLock` refuse returns earlier in the code.
    rmSync(lock, { force: true });
  }
}

/**
 * Clear the input field before paste. `C-u` is ordinary line editing; a session that
 * did not understand it will leave the text, and then delivery honestly refuses:
 * gluing a new message onto someone else's leftover is worse than not delivering and
 * saying so.
 */
async function clearInput(name, { server, env }) {
  if (!inputText(capturePane(name, { server, env }))) return { ok: true };
  tmux(['send-keys', '-t', name, 'C-u'], { server, env });
  const empty = await waitInput(name, { server, env }, (value) => value === '');
  if (empty) return { ok: true };
  return {
    ok: false,
    error: `text stayed in the session input field, and clearing it failed — a new message would glue onto it`,
  };
}

async function waitInput(name, { server, env }, ok, { timeoutMs = INPUT_WAIT_MS, stepMs = INPUT_STEP_MS } = {}) {
  const edge = Date.now() + timeoutMs;
  for (;;) {
    if (ok(inputText(capturePane(name, { server, env })))) return true;
    if (Date.now() >= edge) return false;
    await settle(stepMs);
  }
}

// --- transcript ---------------------------------------------------------------------

/**
 * The chat transcript is the only machine source about a turn under persist: there is
 * no `stream-json` stream here at all. It lives in the human's home,
 * `~/.cursor/projects/<path as a slug>/agent-transcripts/<chatId>/<chatId>.jsonl`, and
 * the mechanism does NOT compute the slug: Cursor truncates long paths and appends a
 * hash (`Users-kim-p-AtiWorkspace-trials-0831-home-cursor-AtiWo-aede696` in the
 * owner's home), so it cannot be assembled by a rule. The path is found by chat id
 * once and laid in the record.
 */
export function findTranscript(chatId, env = process.env) {
  if (!chatId) return null;
  const root = path.join(cursorUserHome(env), 'projects');
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(root, dir, 'agent-transcripts', chatId, `${chatId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Transcript path of a record: from the record, and on first find — into the record. */
export function transcriptOf(record, env = process.env) {
  const known = record?.transcript;
  if (known && existsSync(known)) return known;
  const found = findTranscript(record?.chatId, env);
  if (found && record?.ref) patchSession(record.ref, { transcript: found }, env);
  return found;
}

/**
 * What the transcript says about the turn. “Is a turn running” is read from the ORDER
 * of lines: a user message opens a turn, `{"type":"turn_ended"}` closes it.
 *
 * **`turn_ended` is not an event record, but an end-of-FILE marker** (live measurement
 * 2026-09-03, correction to REPORT §4.6). The file is rewritten: after a second turn
 * the former `turn_ended` vanishes from the middle, and a new one stands alone at the
 * end — on five transcript lines of two turns there is exactly one. So it cannot count
 * turns; the ended-turn counter is owned by the hook ([driver-cursor.js](driver-cursor.js),
 * `registerWake`), and from here we take only “running or not”. `ended` stays a number
 * for the parse: several markers in one file is a shape the parse must survive, not a
 * sign of several turns.
 */
export function readTranscript(file) {
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let busy = false;
  let ended = 0;
  let status = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'turn_ended') {
      busy = false;
      ended += 1;
      status = event.status ?? null;
      continue;
    }
    if (event?.role === 'user') busy = true;
  }
  let touchedAt = null;
  try {
    touchedAt = statSync(file).mtimeMs;
  } catch {
    touchedAt = null;
  }
  return { busy, ended, status, touchedAt };
}

/**
 * Whether a session turn is running right now, and whether it has been silent past the
 * threshold.
 *
 * An injection counts as a turn before the transcript says so: seconds pass from
 * injection to the first line (REPORT §4.3), and in that window `inspect` would
 * otherwise say “the session is free”, and the warden would send a second wake on the
 * same unread. The window closes itself as soon as the transcript says “a turn is
 * running” — turns cannot be counted from it (see `readTranscript`).
 */
export function turnState(record, env = process.env) {
  const file = transcriptOf(record, env);
  const seen = file ? readTranscript(file) : null;
  const injectedAt = Date.parse(record?.injectedAt ?? '');
  const fresh = Number.isFinite(injectedAt) && Date.now() - injectedAt < INJECT_GRACE_MS
    && !seen?.busy;
  const busy = !!seen?.busy || fresh;
  const idleMs = seen?.touchedAt ? Date.now() - seen.touchedAt : null;
  return {
    busy,
    ended: seen?.ended ?? 0,
    status: seen?.status ?? null,
    transcript: file,
    silentMs: idleMs,
    // Silence is judged only on a running turn: on an idle session the transcript is
    // silent lawfully, and a threshold there would mean “stood” on every session
    // waiting for a message.
    silent: !!(busy && !fresh && idleMs !== null && idleMs > turnIdleMs(env)),
  };
}

/**
 * Cursor agent process. For the guard — runtime (not a tool). For cleanup — the
 * `worker-server` orphan (see reapOrphans): one name is not enough, a session mark is
 * needed too.
 */
const WORKER_SERVER_CMD = /worker-server/;

/**
 * Bus needle next to `worker-server`: not from `.cursor/mcp.json`. A refuse to read
 * the file otherwise leaves needles empty, and `promptobus mcp` becomes a “tool” —
 * there is no stall. `ensureWarden` lifts the warden `detached` + `unref`
 * (`warden.js`, launchWarden): ppid stays with the parent, and a warden started by
 * the participant MCP server is forever a child of that process.
 */
export const BUS_MCP_NEEDLE = `${PROMPTOBUS_SERVER} mcp`;

const INTERPRETERS = /^(?:node|nodejs|python\d*|python|ruby|perl|php|sh|bash|zsh|env|npx|npm|pnpm|yarn|deno|bun)$/i;

/** Command-line needles of stdio servers from the participant project MCP. */
export function mcpRuntimeNeedles(mcp) {
  const needles = [];
  for (const cfg of Object.values(mcp?.mcpServers ?? {})) {
    if (!cfg || (cfg.type && cfg.type !== 'stdio')) continue;
    const parts = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])]
      .filter((p) => p != null && String(p).trim() !== '')
      .map(String);
    const distinctive = parts.filter((p) => !INTERPRETERS.test(path.basename(p.split(/\s+/)[0])));
    // A bare interpreter (`{command:'node'}`) is not a needle: otherwise every pane
    // node process would become runtime. A server with empty distinctive is skipped;
    // we do not fall back to parts.
    if (!distinctive.length) continue;
    needles.push(distinctive.join(' '));
  }
  return needles;
}

export function readParticipantMcp(record) {
  const cwd = record?.cwd;
  if (!cwd) return null;
  try {
    return JSON.parse(readFileSync(path.join(cwd, '.cursor', 'mcp.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function isRuntimeCmd(cmd, needles = []) {
  const s = String(cmd ?? '');
  if (WORKER_SERVER_CMD.test(s)) return true;
  if (s.includes(BUS_MCP_NEEDLE)) return true;
  return needles.some((n) => n && s.includes(n));
}

/**
 * Process table in one `ps`. `ww` is required: BSD `ps` without it cuts width, and the
 * bus mark is a contract needle (`promptobus mcp`). Measurement on a live session of
 * this machine (2026-09-03, workspace MCP processes): the `promptobus mcp` line is 159
 * characters both with `-Ao` and with `-Awwo`. Without `ww` the command tail is cut,
 * the bus server is counted as a tool, there is no stall. The same file already takes
 * `ps eww` for the environment.
 */
function psTable(ps, columns) {
  const listed = ps('ps', ['-Awwo', columns], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return null;
  const kids = new Map();
  const cmd = new Map();
  for (const line of String(listed.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const child = Number(m[1]);
    const parent = Number(m[2]);
    cmd.set(child, m[3] ?? '');
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(child);
  }
  return { kids, cmd };
}

function walkKids(root, kids, { keep = () => true, descend = () => true } = {}) {
  const base = Number(root);
  if (!Number.isInteger(base) || base <= 0) return [];
  const walk = [base];
  const seen = new Set([base]);
  const out = [];
  while (walk.length) {
    const next = walk.pop();
    for (const child of kids.get(next) ?? []) {
      if (seen.has(child) || child === process.pid) continue;
      seen.add(child);
      if (keep(child)) out.push(child);
      if (descend(child)) walk.push(child);
    }
  }
  return out;
}

/**
 * Instrumental descendants of the pane process — a sign of turn life wider than
 * transcript silence. The TUI writes the transcript at the end of a call, and a long
 * gate (`npm test` for minutes) is silent lawfully while the turn's sh/node/npm/git
 * are alive. Silence without such descendants is a stall.
 *
 * We do not descend into the runtime subtree: the process itself and its children are
 * not tools. Tools in life are children of the agent / pane, not of `worker-server`.
 * A warden the participant MCP lifted (normally, when none is live: `WARDEN_TOTAL_SEC`
 * ceiling, exit on `ROUND_FAIL_LIMIT`, next bus call) is forever a child of
 * `promptobus mcp`. The line `agents.js promptobus warden --task …` matches neither
 * `WORKER_SERVER_CMD` nor the bus needle: a descent would leave kids non-empty
 * forever, and that same warden would go blind. `sh -c persist` and
 * `node … --cursor-persist-restore` are not runtime — after the regex narrowed there
 * is nothing to descend for them.
 */
export function toolKidsOf(pid, { ps = run, needles = [] } = {}) {
  const table = psTable(ps, 'pid=,ppid=,command=');
  if (!table) return [];
  const runtime = (id) => isRuntimeCmd(table.cmd.get(id), needles);
  return walkKids(pid, table.kids, {
    keep: (id) => !runtime(id),
    descend: (id) => !runtime(id),
  });
}

/**
 * Ceiling on the two questions the worktree signal asks git. They are local reads of one
 * directory — no network, no lock — and a hung git must not hold `inspect`, which the
 * warden calls on every round.
 */
const TOUCH_GIT_TIMEOUT_MS = 5_000;

/** How many changed files are stat'ed. A worker's uncommitted set is small; a repository
 * that hands back thousands of them gets the newest of the first `TOUCH_SCAN_MAX`, which
 * can only make the signal older — and the signal only ever lifts a verdict, never
 * raises one. */
export const TOUCH_SCAN_MAX = 500;

/**
 * How long ago the participant last WROTE anything in its own working tree, in
 * milliseconds. The third liveness signal, and the one the first two are blind to.
 *
 * The transcript grows when the TUI finishes a call. The pane's process tree grows when
 * a tool is a separate process. Editing a file is neither: the agent writes it itself,
 * inside one long call, and spawns nothing. A live Cursor participant was reported
 * stalled twice on 2026-09-04 and 2026-09-05 while it was doing exactly that — the owner
 * opened the panel and saw sixteen files edited, and the participant named a commit from
 * the same window (PB-7).
 *
 * Two questions to git, both about the participant's own directory: the newest mtime
 * among the files git calls changed or untracked, and the commit time of HEAD. The first
 * is git's own walk, so `node_modules` and every other ignored path cost nothing; the
 * second covers the worker that commits as it goes and leaves a clean tree behind.
 *
 * The signal is POSITIVE ONLY, and that is the whole of its contract. A recent write
 * proves the turn is alive. No write proves nothing — a turn can read for minutes — so
 * it may lift a stall verdict and may never raise one. It is also why a genuinely dead
 * session still stalls: nothing writes on its behalf, and the age only grows.
 *
 * `null` — the record names no working directory, the directory is gone, or git refused
 * both questions. The caller reports that rather than reading it as either answer.
 */
export function worktreeTouchedMs(record, { exec = run, now = Date.now } = {}) {
  const cwd = record?.cwd;
  if (!cwd || !existsSync(cwd)) return null;
  const git = (args) => exec('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: TOUCH_GIT_TIMEOUT_MS,
  });
  let newest = null;
  const head = git(['log', '-1', '--format=%ct', 'HEAD']);
  if (head.status === 0) {
    const sec = Number(String(head.stdout ?? '').trim());
    if (Number.isFinite(sec) && sec > 0) newest = sec * 1000;
  }
  const listed = git(['ls-files', '-m', '-o', '--exclude-standard', '-z']);
  if (listed.status !== 0) return newest === null ? null : Math.max(0, now() - newest);
  for (const rel of String(listed.stdout ?? '').split('\0').filter(Boolean).slice(0, TOUCH_SCAN_MAX)) {
    try {
      const at = statSync(path.join(cwd, rel)).mtimeMs;
      if (newest === null || at > newest) newest = at;
    } catch {
      // Vanished between the list and the stat — a build output, most likely. The next
      // file answers, and an unreadable one is not a verdict.
    }
  }
  return newest === null ? null : Math.max(0, now() - newest);
}

/**
 * Transcript silence by itself is not a stall. A stall is silence AND no instrumental
 * descendants of the pane AND no recent write in the participant's working tree. Three
 * signals because each covers a phase the others do not see: the transcript covers a
 * speaking turn, the process tree covers a tool that is its own process, the worktree
 * covers the agent editing files on its own.
 *
 * `touchedMs` is `null` when it was not asked or could not be read, and `null` decides
 * nothing — the other two still do.
 */
export function silentIsStall(turn, kids, touchedMs = null, env = process.env) {
  if (!turn?.silent) return false;
  if (kids?.length) return false;
  return !(touchedMs !== null && touchedMs <= turnIdleMs(env));
}

// --- cleanup ------------------------------------------------------------------------

/**
 * Session mark in the environment of its processes. Computed from the ref, not taken
 * from the record: both tool children and the `worker-server` orphan are reaped by it,
 * and by cleanup time there is already no record of the turn.
 */
export function sessionMarker(record, env = process.env) {
  return record?.ref ? `${SESSION_ENV_VAR}=${sessionFile(record.ref, env)}` : null;
}

/**
 * Orphaned `worker-server` (REPORT §4.11, §4.8). Recognised by TWO marks at once: the
 * subcommand name on the command line and the session mark in the process environment.
 * One name is not enough — every Cursor session on the machine lifts a
 * `worker-server`, including a human's IDE session, and hitting by name would take
 * foreign work.
 *
 * It also lives after a NORMAL end of a turn: the spike measurement is 11 minutes
 * after a normally finished turn, so the threshold “it will go away by itself in
 * minutes” is not confirmed.
 */
export function reapOrphans(marker, { ps = run } = {}) {
  if (!marker) return [];
  const listed = ps('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) return [];
  const killed = [];
  for (const line of String(listed.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m || !WORKER_SERVER_CMD.test(m[2])) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    // Process environment is printed by `ps eww`; on a machine without it there will
    // be no reap at all — and that is better than a kill by one name.
    const dump = ps('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (dump.error || dump.status !== 0 || !String(dump.stdout ?? '').includes(marker)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // The process died itself between the listing and the signal — a lawful outcome,
      // not a refuse.
    }
  }
  return killed;
}

/**
 * TOOL children of a running turn. `agent persist stop` stops the pane in 0.14 s, and
 * processes the turn managed to start (the tool shell and its descendants) stay alive
 * (REPORT §4.8) — stopping a session mid-turn would leave them on the machine every
 * time.
 *
 * They are found by the tree from the pane process, not by a mark: a tool descendant
 * may have nothing of ours in its environment at all — the tool assembles the
 * environment, not the binary. The tree is taken in ONE `ps`, because this is called
 * from task cleanup, not from the warden loop.
 */
export function treeOf(pid, { ps = run } = {}) {
  const table = psTable(ps, 'pid=,ppid=');
  if (!table) return [];
  return walkKids(pid, table.kids);
}

/** Kill the named processes. Died itself between listing and signal — a lawful outcome. */
export function killPids(pids) {
  const killed = [];
  for (const pid of pids ?? []) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Died itself — nothing to count as a refuse.
    }
  }
  return killed;
}

/**
 * Stop a persist session: harness command, wait for it to vanish, reap processes.
 *
 * **The operation returns AFTER the harness no longer HAS the session**: cleanup of
 * directories follows stop, and if `stop` returned earlier, the walk would see a live
 * session and lawfully leave the worktree.
 */
export async function stopSession(record, {
  env = process.env, bin = null, timeoutMs = STOP_TIMEOUT_MS, stepMs = STOP_STEP_MS,
} = {}) {
  const server = record?.tmuxServer || CURSOR_TMUX_SERVER;
  const name = record?.sessionName ?? null;
  const marker = sessionMarker(record, env);
  const live = name ? findSession(name, { server, env }) : null;
  // Tool children are listed BEFORE stop and killed after: stop kills the pane, and
  // orphaned children immediately move under PPID 1 — the tree from the pane pid is
  // empty after that.
  const panePid = live?.panePid ?? (Number(record?.panePid) || null);
  const kids = treeOf(panePid);
  if (!live) {
    // No session, but its processes may have outlived it: the `worker-server` orphan
    // lives for minutes even after a normal end of a turn.
    return { stopped: false, orphans: reapOrphans(marker), kids: killPids(kids) };
  }
  const agent = bin || record?.bin;
  let said = null;
  if (agent) {
    const r = run(agent, ['persist', 'stop', name], { encoding: 'utf8', env, cwd: record?.cwd });
    said = r.error ? r.error.message : String(r.stdout ?? r.stderr ?? '').trim();
  }
  const edge = Date.now() + timeoutMs;
  while (findSession(name, { server, env }) && Date.now() < edge) await settle(stepMs);
  let stopped = !findSession(name, { server, env });
  if (!stopped) {
    // The harness command did not work — stop the pane directly. This is not a bypass
    // of the “one session — one mode” gate: the binary itself holds that gate on ITS
    // store, and here tmux is taken down, and the binary will pick up the chat binding
    // on the next lift itself (it is cleaned by age).
    tmux(['kill-session', '-t', name], { server, env });
    const hard = Date.now() + timeoutMs;
    while (findSession(name, { server, env }) && Date.now() < hard) await settle(stepMs);
    stopped = !findSession(name, { server, env });
  }
  return {
    stopped, said, orphans: reapOrphans(marker), kids: killPids(kids),
  };
}

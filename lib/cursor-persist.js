import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { run } from './exec.js';
import { shellQuote } from '../dist/fs/shell.js';
import { GateError } from '../dist/index.js';
import { createHarnessRegistry } from './harness-registry.js';
import { PROMPTOBUS_SERVER } from './contract.js';
// Cursor: the persist session.
// [reference/05-drivers.md#cursor-the-persist-session](../docs/reference/05-drivers.md#cursor-the-persist-session)

/** Environment variable that marks the session for process reap and contact-point handoff. */
export const SESSION_ENV_VAR = 'PROMPTOBUS_CURSOR_SESSION';

/** Tmux server persist sessions live on. The name is `persist`'s own and is not changed: participants
 * share a server so a person needs `agent persist list` and nothing in the environment. */
export const CURSOR_TMUX_SERVER = 'cursor-agent';

/** Harness name the registry is keyed by — the same string the driver declares as its id. */
const CURSOR_HARNESS = 'cursor';

/** Server of one-shot pty provider panes. Its own, because a pane is lift machinery rather than a
 * participant session: it has no place in `agent persist list`. */
export const LAUNCH_TMUX_SERVER = 'promptobus-launch';

/** `persist` lifts its server with `TMUX_TMPDIR=/tmp`, and talk with it must come from there: the
 * socket is looked up by that variable, whose default differs across systems. */
export const TMUX_TMPDIR = '/tmp';

/** Options `persist` stamps on its session. They are how it is recognised among others. */
export const CURSOR_SESSION_OPTS = ['@cursor_managed', '@cursor_workspace_hash', '@cursor_session_version', '@cursor_chat_id'];

/** Options the mechanism stamps on ITS sessions. The server is shared, so "stop everything found"
 * would take a person's own work: `inspect` and cleanup tell ours apart by these. */
export const TASK_OPT = '@promptobus_task';
export const ADDRESS_OPT = '@promptobus_address';

/** Pause between pasting text and `Enter`. Without it Enter is LOST and the text glues onto the next
 * message; measured, every run passed at 0.3–0.4 s, and this is the top of the measurement. */
export const ENTER_PAUSE_MS = 400;

/** How long we wait for the input field to empty: a broken case is the ceiling, a normal one is a tick or two. */
export const INPUT_WAIT_MS = 5_000;
export const INPUT_STEP_MS = 100;
export const ENTER_SETTLE_MS = 400;

/** Ceiling of SILENCE in the transcript, not of a turn's total time — a real turn runs for minutes.
 * It kills nothing: the threshold gives `inspect` a verdict, and the decision stays with a person. */
export const TURN_IDLE_MS = 180_000;

/** Window in which an injection counts as a started turn though the transcript is still silent:
 * measured 3.09 and 8.03 s to the first line, and without it the warden would wake twice. */
export const INJECT_GRACE_MS = 20_000;

/** How long we wait for the persist session to appear in the tmux list; measured 1.17–1.39 s. The
 * wait form is `{tries, delayMs}`, the same as the neighbouring driver's `awaitOptions`. */
export const LIFT_TRIES = 240;
export const LIFT_STEP_MS = 250;

/** How long we wait for the session to vanish after `persist stop`. Measurement of stop itself: 0.14–0.15 s. */
export const STOP_TIMEOUT_MS = 10_000;
export const STOP_STEP_MS = 100;

/** Suite seam: the live silence threshold is measured in minutes and there is nothing to wait those
 * out in the suite. Read only here; unset in life, so the threshold stays live. */
export function turnIdleMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CURSOR_IDLE_MS);
  return Number.isFinite(named) && named > 0 ? named : TURN_IDLE_MS;
}

// --- session registry ---------------------------------------------------------------

/** Registry of OUR persist sessions. The shared registry owns the record format and the atomic
 * write; this file keeps only Cursor's tmux and buffer sidecars. */
export function cursorUserHome(env = process.env) {
  const named = String(env.PROMPTOBUS_CURSOR_USER_HOME ?? '').trim();
  return named || path.join(homedir(), '.cursor');
}

function launchScriptFile(ref, env = process.env) {
  return path.join(sessionsDir(env), sessionKey(ref) + '.launch.sh');
}

export function lockFile(ref, env = process.env) {
  return path.join(sessionsDir(env), sessionKey(ref) + '.inject.lock');
}

const cursorRegistry = createHarnessRegistry({
  harness: CURSOR_HARNESS,
  sidecars: (ref, env) => [launchScriptFile(ref, env), lockFile(ref, env), bufferFile(ref, env)],
});

export const cursorStateHome = cursorRegistry.stateHome;
export const sessionsDir = cursorRegistry.sessionsDir;
export const sessionKey = cursorRegistry.sessionKey;
export const sessionFile = cursorRegistry.sessionFile;
export const readSession = cursorRegistry.readSession;
export const writeSession = cursorRegistry.writeSession;
export const patchSession = cursorRegistry.patchSession;
export const dropSession = cursorRegistry.dropSession;
export const pidAlive = cursorRegistry.pidAlive;

/** How long a lock is considered live without its process: an injection takes a second, a broken
 * one about five, and a minute is ten times smaller than the participant silence threshold. */
export const LOCK_STALE_MS = 60_000;

/** Take the inject lock or say who holds it. **An ownerless lock is taken over**: a writer that dies
 * between take and drop would otherwise refuse every later delivery into that session. */
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

async function settle(ms) {
  await new Promise((r) => { setTimeout(r, ms); });
}

// --- binaries: PATH, then the install directories ------------------------------------

/** Where a Cursor install puts binaries besides PATH; tmux is looked for there too. */
const CURSOR_INSTALL_DIRS = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'];

/** Suite seam: replaces `CURSOR_INSTALL_DIRS`, whose absolute entries no sandboxed HOME covers. */
const INSTALL_DIRS_VAR = 'PROMPTOBUS_CURSOR_INSTALL_DIRS';

export const TMUX_NOT_FOUND = 'not found in PATH or in the known install locations '
  + `(${CURSOR_INSTALL_DIRS.join(', ')})`;

function expandHomeDir(dir, home) {
  return dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir;
}

export function binInDir(dir, bin) {
  const p = path.join(dir, bin);
  try {
    if (!existsSync(p)) return null;
    if (process.platform === 'win32') return p;
    if (statSync(p).mode & 0o111) return p;
  } catch { /* gone between checks */ }
  return null;
}

export function searchPath({ env = process.env, home = homedir() } = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathDirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  const named = env[INSTALL_DIRS_VAR];
  const installs = named === undefined ? CURSOR_INSTALL_DIRS : String(named).split(sep).filter(Boolean);
  const extra = installs.map((d) => expandHomeDir(d, home));
  return { sep, dirs: [...pathDirs, ...extra] };
}

/** The tmux every call runs, by absolute path, or `null`: the search the lift's check makes.
 * [reference/05-drivers.md#cursor-tmux-by-absolute-path](../docs/reference/05-drivers.md#cursor-tmux-by-absolute-path) */
export function tmuxBin({ env = process.env } = {}) {
  for (const dir of searchPath({ env }).dirs) {
    const hit = binInDir(dir.replace(/^"|"$/g, ''), 'tmux');
    if (hit) return hit;
  }
  return null;
}

// --- talk with tmux -----------------------------------------------------------------

/** Tmux call on the named server, with the caller's environment. `-f /dev/null`, the same flag
 * `persist` uses: a person's `~/.tmux.conf` would otherwise change what the mechanism pastes and reads. */
export function tmux(args, { server = CURSOR_TMUX_SERVER, env = process.env, input = null } = {}) {
  const bin = tmuxBin({ env });
  if (!bin) return { status: null, stdout: '', stderr: '', error: new Error(TMUX_NOT_FOUND) };
  return run(bin, ['-u', '-L', server, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
    env: { ...env, TMUX_TMPDIR },
    ...(input === null ? {} : { input }),
  });
}

/** Fields tmux returns session state by, and the separator between them: there is no need to parse
 * the human text of `persist list`. No paths are listed — a separator can appear in one. */
const LIST_SEP = '|';
const LIST_FIELDS = [
  '#{session_name}', '#{session_attached}', '#{session_created}', '#{pane_pid}',
  '#{@cursor_managed}', '#{@cursor_workspace_hash}', '#{@cursor_chat_id}', `#{${TASK_OPT}}`, `#{${ADDRESS_OPT}}`,
];

/** Server sessions, machine-readable, and `missing` when tmux could not be run. An empty list for a
 * missing server is not a refusal: a tmux server lives while it has sessions. */
export function readTmuxSessions({ server = CURSOR_TMUX_SERVER, env = process.env } = {}) {
  const r = tmux(['list-sessions', '-F', LIST_FIELDS.join(LIST_SEP)], { server, env });
  if (r.error) return { sessions: null, missing: `tmux could not be run: ${r.error.message}` };
  if (r.status !== 0) return { sessions: [], missing: null };
  const sessions = String(r.stdout ?? '').split('\n').filter(Boolean).map((line) => {
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
  return { sessions, missing: null };
}

/** The list alone, for the lift: a tmux that cannot run fails its `new-session` with the reason. */
export function tmuxSessions({ server = CURSOR_TMUX_SERVER, env = process.env } = {}) {
  return readTmuxSessions({ server, env }).sessions ?? [];
}

function optionWriteError(r) {
  if (!r?.error && r?.status === 0) return null;
  return r?.error?.message ?? (String(r?.stderr ?? '').trim() || `code ${r?.status}`);
}

/** Read one user option back. An unset option is exit 1 `invalid option: @…` on tmux 3.6b;
 * any other non-zero is unreadable and is not treated as an empty server. */
function optionRead(name, opt, env) {
  const r = tmux(['show-options', '-t', name, '-v', opt], { env });
  if (!r.error && r.status === 0) {
    return { value: String(r.stdout ?? '').replace(/\n$/, ''), absent: false, detail: null };
  }
  const detail = r.error?.message ?? (String(r.stderr ?? '').trim() || `code ${r.status}`);
  return { value: null, absent: detail === `invalid option: ${opt}`, detail };
}

/** Set one mark, read it back, try once more, then refuse. The refusal names the option. */
function stampMark(name, opt, value, env) {
  const write = () => tmux(['set-option', '-t', name, opt, value], { env });
  let why = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    why = optionWriteError(write());
    if (why) continue;
    const read = optionRead(name, opt, env);
    if (read.value === value) return null;
    why = read.absent
      ? `set-option exited 0 and ${opt} was absent (${read.detail})`
      : `set-option exited 0 and ${opt} was ${read.detail ? `unreadable (${read.detail})` : `not ${JSON.stringify(value)}`}`;
  }
  const stopped = optionWriteError(tmux(['kill-session', '-t', name], { env }))
    ? 'the persist session was not stopped'
    : 'the persist session was stopped';
  return `${opt} did not take on persist session ${name}: ${why} — ${stopped}`;
}

/** One session by name, or `null` when the server does not have it. A tmux that could not be run
 * refuses instead: `null` there would read a live session as gone. */
export function findSession(name, { server = CURSOR_TMUX_SERVER, env = process.env } = {}) {
  if (!name) return null;
  const { sessions, missing } = readTmuxSessions({ server, env });
  if (missing) throw new GateError(`${missing} — the state of persist session ${name} cannot be read`);
  return sessions.find((s) => s.name === name) ?? null;
}

/** Working-directory hash `persist` stamps on its session — how ours is found among foreigners.
 * **The path is taken RESOLVED**: on macOS `$TMPDIR` is a symlink, and the hashes differ. */
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

/** TUI labels the input protocol rests on. Neither is a documented interface — Cursor's TUI has no
 * version — so they are gathered in one place: if it breaks, it is fixed by a string. */
const INPUT_PROMPT = '→ ';
const INPUT_PLACEHOLDER = 'Add a follow-up';
const BUSY_LINE = 'ctrl+c to stop';

/** Text standing in the pane input field; an empty field is the prompt with no text. **The running-
 * turn label lives on the SAME line**, so unstripped it makes every running turn read as occupied. */
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

/** Pty provider pane script. The environment is materialised HERE: the pane inherits the tmux SERVER
 * environment, which a previous lift may have set. `env -u` guards a foreign `TMUX`. */
export function launchScript({ bin, argv, env }) {
  const drop = new Set(LAUNCH_UNSET);
  const assignments = Object.entries(env ?? {})
    .filter(([k, v]) => v !== undefined && v !== null && !drop.has(k))
    .map(([k, v]) => `${k}=${shellQuote(String(v))}`);
  const unsetFlags = LAUNCH_UNSET.map((n) => `-u ${n}`).join(' ');
  return `#!/bin/sh\nexec env ${unsetFlags} ${assignments.join(' ')} \\\n  ${shellQuote(bin)} `
    + `${argv.map(shellQuote).join(' ')}\n`;
}

/** Lift a persist session. The binary chooses the name, so it is learned AFTER start; ours is
 * recognised by three marks at once — directory hash, non-empty chat id, and creation time. */
export async function liftSession({
  ref, bin, argv, cwd, env = process.env, launchEnv = null, task = null, address = null,
  tries = LIFT_TRIES, delayMs = LIFT_STEP_MS,
}) {
  const script = launchScriptFile(ref, env);
  mkdirSync(path.dirname(script), { recursive: true });
  // The SESSION environment and the environment of our tmux calls are different things: the first is
  // materialised in the script, the second is needed only to find the server socket.
  writeFileSync(script, launchScript({ bin, argv, env: launchEnv ?? env }), { mode: 0o700 });
  const hash = workspaceHash(cwd);
  const known = new Set(tmuxSessions({ env }).map((s) => s.name));
  const startedAt = Math.floor(Date.now() / 1000);
  const pane = `promptobus-${sessionKey(ref)}`;
  // Pane width is set explicitly: `capture-pane` reads what is drawn, and a narrow pane would break
  // input-field lines. A live session is later shrunk by whoever attaches, but lift must not depend on that.
  const started = tmux(['new-session', '-d', '-s', pane, '-x', '200', '-y', '50', '-c', cwd, 'sh', script],
    { server: LAUNCH_TMUX_SERVER, env });
  if (started.error || started.status !== 0) {
    rmSync(script, { force: true });
    const why = started.error?.message ?? (String(started.stderr ?? '').trim() || `code ${started.status}`);
    return { ok: false, error: `pty provider pane did not lift: ${why}` };
  }
  let seen = null;
  for (let i = 0; i < tries; i += 1) {
    seen = tmuxSessions({ env }).find((s) => s.hash === hash && s.chatId && !known.has(s.name)
      && s.created >= startedAt - 2) ?? null;
    if (seen) break;
    if (i < tries - 1) await settle(delayMs);
  }
  let markError = null;
  if (seen) {
    // A mark that did not take refuses the lift: an unmarked session on this
    // server cannot be told from a foreign one. See reference/05-drivers.md.
    if (task) markError = stampMark(seen.name, TASK_OPT, task, env);
    if (!markError && address) markError = stampMark(seen.name, ADDRESS_OPT, address, env);
  }
  // The pane is stopped in both branches: the persist session outlives it (REPORT §2),
  // and a failed lift has no right to leave a process behind.
  tmux(['kill-session', '-t', pane], { server: LAUNCH_TMUX_SERVER, env });
  rmSync(script, { force: true });
  if (markError) return { ok: false, error: markError };
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

/** Deliver text into a live session, by the protocol the spike measured.
 * [reference/05-drivers.md#injecttext--deliver-text-into-a-live-session](../docs/reference/05-drivers.md#injecttext--deliver-text-into-a-live-session) */
export async function injectText(record, text, { env = process.env, pauseMs = ENTER_PAUSE_MS } = {}) {
  const name = record?.sessionName;
  const server = record?.tmuxServer || CURSOR_TMUX_SERVER;
  if (!name) return { ok: false, error: 'the session record has no persist session name — nothing to deliver' };
  const lock = lockFile(record.ref, env);
  mkdirSync(path.dirname(lock), { recursive: true });
  const taken = takeLock(lock);
  if (!taken.ok) return taken;
  let buf = null;
  try {
    const cleared = await clearInput(name, { server, env });
    if (!cleared.ok) return cleared;
    buf = bufferFile(record.ref, env);
    writeFileSync(buf, text, { mode: 0o600 });
    chmodSync(buf, 0o600);
    const bufName = `promptobus-${sessionKey(record.ref)}`;
    const loaded = tmux(['load-buffer', '-b', bufName, buf], { server, env });
    if (loaded.error || loaded.status !== 0) {
      return { ok: false, error: `text did not go into the tmux buffer: ${String(loaded.stderr ?? '').trim() || `code ${loaded.status}`}` };
    }
    // `-p` — bracketed paste (one message), `-d` — the buffer is dropped at once: the buffer name is
    // one per session, and leftovers would ride with the next paste.
    const pasted = tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', name], { server, env });
    if (pasted.error || pasted.status !== 0) {
      return { ok: false, error: `text did not paste into the input field: ${String(pasted.stderr ?? '').trim() || `code ${pasted.status}`}` };
    }
    // Pause before Enter — the step without which Enter is lost. Mutation-probe target: drop it and
    // the stand glues two messages into one, as the live run glued them.
    await settle(pauseMs);
    const sent = tmux(['send-keys', '-t', name, 'Enter'], { server, env });
    if (sent.error || sent.status !== 0) {
      return { ok: false, error: `Enter did not reach the session: ${String(sent.stderr ?? '').trim() || `code ${sent.status}`}` };
    }
    // The field empties right after Enter — wait a tick, not the full ceiling: the warden loop waits
    // for this SYNCHRONOUSLY, and extra seconds cost every other participant a delivery delay.
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
    if (buf) rmSync(buf, { force: true });
    rmSync(lock, { force: true });
  }
}

/** Clear the input field before paste. A session that did not understand `C-u` leaves the text and
 * delivery honestly refuses: gluing onto someone else's leftover is worse than not delivering. */
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

/** The chat transcript is the only machine source about a turn under persist. The mechanism does NOT
 * compute its path slug — Cursor truncates and hashes — so it is found by chat id once and recorded. */
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

/** What the transcript says about the turn, read from the ORDER of lines. **`turn_ended` is an
 * end-of-FILE marker, not an event**: it cannot count turns, so only "running or not" is taken. */
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

/** Whether a session turn is running, and whether it has been silent past the threshold. An injection
 * counts as a turn before the transcript says so, or the warden would wake twice on one unread. */
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
    // Silence is judged only on a running turn: an idle session is silent lawfully, and a threshold
    // there would say "stalled" about every session waiting for a message.
    silent: !!(busy && !fresh && idleMs !== null && idleMs > turnIdleMs(env)),
  };
}

/** Cursor agent process. For the guard — runtime, not a tool. For cleanup — the `worker-server`
 * orphan, where one name is not enough and a session mark is needed too. */
const WORKER_SERVER_CMD = /worker-server/;

/** Bus needle beside `worker-server`, not read from `.cursor/mcp.json`: a refusal to read that file
 * would leave needles empty, and `promptobus mcp` would count as a tool, so nothing ever stalls. */
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
    // A bare interpreter is not a needle, or every pane node process would become runtime. A server
    // with nothing distinctive is skipped; we do not fall back to parts.
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

/** Process table in one `ps`. `ww` is required: BSD `ps` without it cuts the width, the 159-character
 * `promptobus mcp` line loses its tail, and the bus server is counted as a tool. */
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

/** Instrumental descendants of the pane process — a sign of turn life wider than transcript silence.
 * The runtime subtree is not descended into: a descent would leave kids non-empty forever. */
export function toolKidsOf(pid, { ps = run, needles = [] } = {}) {
  const table = psTable(ps, 'pid=,ppid=,command=');
  if (!table) return [];
  const runtime = (id) => isRuntimeCmd(table.cmd.get(id), needles);
  return walkKids(pid, table.kids, {
    keep: (id) => !runtime(id),
    descend: (id) => !runtime(id),
  });
}

/** Ceiling on the two questions the worktree signal asks git. Local reads of one directory, and a
 * hung git must not hold `inspect`, which the warden calls on every round. */
const TOUCH_GIT_TIMEOUT_MS = 5_000;

/** How many changed files are stat'ed. A repository handing back thousands gets the newest of the
 * first `TOUCH_SCAN_MAX`, which can only make the signal older — and it only ever lifts a verdict. */
export const TOUCH_SCAN_MAX = 500;

/** How long since the participant last WROTE in its own tree, in milliseconds.
 * [reference/05-drivers.md#worktreetouchedms--the-third-liveness-signal-and-what-the-first-two-miss](../docs/reference/05-drivers.md#worktreetouchedms--the-third-liveness-signal-and-what-the-first-two-miss) */
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

/** A stall is silence AND no instrumental descendants AND no recent write in the working tree —
 * three signals because each covers a phase the others do not see. `null` decides nothing. */
export function silentIsStall(turn, kids, touchedMs = null, env = process.env) {
  if (!turn?.silent) return false;
  if (kids?.length) return false;
  return !(touchedMs !== null && touchedMs <= turnIdleMs(env));
}

// --- cleanup ------------------------------------------------------------------------

/** Session mark in the environment of its processes. Computed from the ref, not taken from the
 * record: by cleanup time there is already no record of the turn. */
export function sessionMarker(record, env = process.env) {
  return record?.ref ? `${SESSION_ENV_VAR}=${sessionFile(record.ref, env)}` : null;
}

/** Orphaned `worker-server`, recognised by TWO marks at once — the subcommand name and the session
 * mark in the environment. It outlives a NORMAL end of turn: measured alive 11 minutes after one. */
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

/** TOOL children of a running turn: `agent persist stop` takes the pane down in 0.14 s and leaves
 * them alive. Found by the tree from the pane process, not by a mark — a tool builds its own environment. */
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

/** Stop a persist session. **It returns AFTER the harness no longer HAS the session**: cleanup
 * follows stop, and an earlier return would leave the worktree in place. */
export async function stopSession(record, {
  env = process.env, bin = null, timeoutMs = STOP_TIMEOUT_MS, stepMs = STOP_STEP_MS,
} = {}) {
  const server = record?.tmuxServer || CURSOR_TMUX_SERVER;
  const name = record?.sessionName ?? null;
  const marker = sessionMarker(record, env);
  const live = name ? findSession(name, { server, env }) : null;
  // Tool children are listed BEFORE stop and killed after: stop kills the pane, orphaned children
  // move under PPID 1 at once, and the tree from the pane pid is empty after that.
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
    // The harness command did not work — stop the pane directly. Not a bypass of the one-session-one-
    // mode gate: the binary holds that on ITS store, and picks the chat binding up on the next lift.
    tmux(['kill-session', '-t', name], { server, env });
    const hard = Date.now() + timeoutMs;
    while (findSession(name, { server, env }) && Date.now() < hard) await settle(stepMs);
    stopped = !findSession(name, { server, env });
  }
  return {
    stopped, said, orphans: reapOrphans(marker), kids: killPids(kids),
  };
}

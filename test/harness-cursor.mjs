// Stub Cursor harness: two binaries — `agent` and `tmux`. Not a `*.test.mjs` —
// the runner (run.mjs) takes only those from the directory, so this file is never
// part of the run.
//
// How it differs from the stub `claude` ([harness.mjs](harness.mjs)). That one models a
// DAEMON: `--bg` starts a long-lived session, `agents --json` prints its registry, `stop`
// kills it. Cursor has tmux instead of a registry: `agent persist` starts an interactive
// TUI in a pane, `tmux list-sessions` gives the session list, input is `paste-buffer` and
// `send-keys`, teardown is `agent persist stop`. The stand repeats exactly that, because
// that is what the driver sits on.
//
// **There are two stub binaries, and the second is required.** We cannot demand a real
// tmux of the suite: it is not on every machine, and the run must judge the driver, not
// the environment. But the stand must model the tmux and `persist` properties the driver
// actually depends on — and each of them was taken from a live spike measurement
// (REPORT):
//
//   - **pause before Enter** (§4.3): `send-keys Enter` earlier than `STUB_ENTER_MIN_MS`
//     after a paste is LOST, the text stays in the input field and rides out with the
//     next one;
//   - **`persist` inside a foreign `TMUX`** (§4.2) silently does not persist: the turn is
//     played, no session appears at all;
//   - **tool children survive `persist stop`** (§4.8), and an orphan `worker-server`
//     lives on even after a NORMAL end of turn;
//   - **an unknown event name in `.cursor/hooks.json`** (§4.4) silently kills the whole
//     file: not a single hook fires, including the correctly named ones;
//   - **end of turn** — `{"type":"turn_ended","status":"success"}` in the transcript plus
//     the `stop` hook; `sessionEnd` does not fire under persist at all;
//   - **a message during a turn** (§4.3) is queued and executed as a separate turn
//     immediately after the current one.
//
// The substitution sits on the BINARY boundary, not the driver's: the driver is the
// subject under test, and a substituted one would stop checking `prepare`, `inspect`,
// injection, `stop` and transcript parse.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { KNOWN_HOOK_EVENTS, PROVEN_CURSOR_VERSION } from '../lib/driver-cursor.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Stand home in the environment: both stub binaries and the test read it. */
export const CURSOR_HOME_VAR = 'PROMPTOBUS_E2E_CURSOR';

/** Hang a turn — the same flag the watchdog-on-silence probe uses to turn it on. */
export const HANG_VAR = 'PROMPTOBUS_E2E_CURSOR_HANG';

/**
 * The same hang, but the pane holds a live child. Transcript silence is then not a stop:
 * a long gate writes to the TUI only at the end of the call, and the processes stay
 * alive.
 */
export const HANG_CHILD_VAR = 'PROMPTOBUS_E2E_CURSOR_HANG_CHILD';

/**
 * Enter-loss threshold. Live measurement: without a pause Enter is lost, with 0.3–0.4 s
 * it always goes through (REPORT §4.3). The stand takes the middle: a driver with its
 * own 400 ms pause passes, a driver without a pause does not, and two messages glued
 * into one show up in the transcript exactly as the spike saw them.
 */
export const STUB_ENTER_MIN_MS = 250;

/** Version the stub tmux answers with: the one the whole spike protocol was taken from. */
export const TMUX_VERSION = 'tmux 3.6b';

/** Version the stub binary answers with: a private copy of the number would make the
 * stand a binary the mechanism never starts at all (`optionRefusal` refuses everything
 * newer than the proven one). */
export const HARNESS_VERSION = `${PROVEN_CURSOR_VERSION}-e2estub`;

// --- stand layout ----------------------------------------------------------------

/**
 * Where the stand keeps the sessions of one tmux server. The name of the server is
 * only a key inside the stand home, and the home is a fresh `mkdtemp` per file — so
 * two runs on one machine asking the same `cursor-agent` server look at two different
 * directories, and neither can stop the other's session. That is the whole per-run
 * scoping of the tmux side, and it is why the production name stays `cursor-agent`:
 * the mechanism must keep sharing the server with a person's own persist sessions
 * (`CURSOR_TMUX_SERVER` in [cursor-persist.js](../lib/cursor-persist.js)), and only
 * the stand is allowed to know better.
 *
 * The one route out of this scoping is a suite process whose PATH lost the stand's
 * stub `tmux`: it would reach the machine's real binary and the real, shared
 * `cursor-agent` server. That route is closed by the sealed PATH (PB-2), and
 * [promptobus-cursor-wake.test.mjs](promptobus-cursor-wake.test.mjs) checks the seal
 * from the other end — that the `tmux` its run resolved is this stand's.
 */
export function serverDir(home, server) {
  return path.join(home, 'tmux', String(server).replace(/[^A-Za-z0-9._-]+/g, '-'));
}

function sessionPath(home, server, name) {
  return path.join(serverDir(home, server), 'sessions', `${String(name).replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);
}

function readSess(home, server, name) {
  try {
    return JSON.parse(readFileSync(sessionPath(home, server, name), 'utf8'));
  } catch {
    return null;
  }
}

function writeSess(home, server, sess) {
  const file = sessionPath(home, server, sess.name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(sess, null, 2)}\n`);
  return sess;
}

function listSess(home, server) {
  const dir = path.join(serverDir(home, server), 'sessions');
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files.map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function dropSess(home, server, name) {
  rmSync(sessionPath(home, server, name), { force: true });
}

/** Session message queue: `send-keys Enter` writes it, the stub `agent` reads it. */
function queueFile(home, name) {
  return path.join(home, 'queue', `${String(name).replace(/[^A-Za-z0-9._-]+/g, '-')}.jsonl`);
}

/**
 * Chat transcript in the Cursor home. The live binary's project directory is the path as
 * a slug, and long paths are truncated and a hash is appended; the mechanism does not
 * compute the slug at all and finds the transcript by chat id, so any stable name is
 * enough for the stand.
 */
export function transcriptFile(userHome, workspace, chatId) {
  const slug = `${String(workspace).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+/, '').slice(-60)}`;
  return path.join(userHome, 'projects', slug, 'agent-transcripts', chatId, `${chatId}.jsonl`);
}

/** Participant turn script: the test writes it, the stub binary reads it. The key is the address. */
export function scriptFile(home, address) {
  return path.join(home, 'scripts', `${addrKey(address)}.json`);
}

/** Trace of what the participant did and what the bus answered. The test checks against it. */
export function traceFile(home, address) {
  return path.join(home, 'trace', `${addrKey(address)}.jsonl`);
}

/** Played-turn counter: a turn on the stand is a loop iteration, and remembering the number is easier in a file. */
export function turnsFile(home, address) {
  return path.join(home, 'turns', `${addrKey(address)}.json`);
}

export function addrKey(address) {
  return String(address).replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function readTrace(home, address) {
  try {
    return readFileSync(traceFile(home, address), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    return [];
  }
}

export function planParticipant(home, address, script) {
  mkdirSync(path.dirname(scriptFile(home, address)), { recursive: true });
  writeFileSync(scriptFile(home, address), `${JSON.stringify(script, null, 2)}\n`);
  return script;
}

/** Diagnosis from the participant trace for a red verdict. */
export function diagnoseTrace(home, address, tail = 8) {
  return `trace for ${address}: ${JSON.stringify(readTrace(home, address).slice(-tail))}`;
}

/** Whether the process is alive — the same sign the whole mechanism uses to judge liveness. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// --- install --------------------------------------------------------------------

/**
 * Lay out the stand and put its `agent` and `tmux` first on PATH. Both mechanism homes
 * are redirected there too: the session registry (`PROMPTOBUS_CURSOR_HOME`) and the
 * Cursor home with transcripts (`PROMPTOBUS_CURSOR_USER_HOME`) — without that the run
 * would write into the developer's `~/legacy/cursor` and `~/.cursor`.
 *
 * The stand home is created OUTSIDE the file sandbox — for the same reason as the stub
 * `claude`: the sandbox hook removes its directory before the stand has a chance to
 * clean up after itself.
 */
export async function installHarness({ binDir, env = process.env } = {}) {
  const { stubCommand, withStubPath } = await import('./sandbox.mjs');
  const home = mkdtempSync(path.join(os.tmpdir(), 'promptobus-cursor-'));
  armCleanup(home);
  for (const dir of ['scripts', 'trace', 'turns', 'approvals', 'state', 'queue', 'tmux', 'cursor']) {
    mkdirSync(path.join(home, dir), { recursive: true });
  }
  const agentStub = `import { agentMain } from ${JSON.stringify(path.join(here, 'harness-cursor.mjs'))};\n`
    + 'await agentMain(process.argv.slice(2));\n';
  // `cursorDriver.options.tool` says `cursor-agent`, and the host's resolveToolBin
  // returns `{ ok: true, bin: name }` with no PATH search, so spawn runs that name.
  // All three lookup names are stubbed anyway: the driver's own `CURSOR_BINS`
  // search tries `agent` and `cursor` too, and a name nobody stubbed must not be
  // the thing that decides a verdict. It can no longer reach a real install dir —
  // PATH is sealed ([hygiene.mjs](hygiene.mjs)) — but ENOENT in the middle of a
  // scenario is a worse diagnosis than a stand that answers.
  stubCommand(binDir, 'agent', agentStub);
  stubCommand(binDir, 'cursor', agentStub);
  stubCommand(binDir, 'cursor-agent', agentStub);
  stubCommand(binDir, 'tmux', `import { tmuxMain } from ${JSON.stringify(path.join(here, 'harness-cursor.mjs'))};\n`
    + 'await tmuxMain(process.argv.slice(2));\n');
  const restore = withStubPath(binDir);
  const was = { state: env.PROMPTOBUS_CURSOR_HOME, user: env.PROMPTOBUS_CURSOR_USER_HOME };
  env[CURSOR_HOME_VAR] = home;
  env.PROMPTOBUS_CURSOR_HOME = path.join(home, 'state');
  env.PROMPTOBUS_CURSOR_USER_HOME = path.join(home, 'cursor');
  return {
    home,
    stateHome: path.join(home, 'state'),
    userHome: path.join(home, 'cursor'),
    restore: () => {
      restore();
      delete env[CURSOR_HOME_VAR];
      for (const [name, value] of [['PROMPTOBUS_CURSOR_HOME', was.state], ['PROMPTOBUS_CURSOR_USER_HOME', was.user]]) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
    },
  };
}

// Cleanup on process exit — the same trouble and the same remedy as the sandboxes: a
// failed check takes the process out through `process.exit`, and a paired call at the
// tail of the file does not run on exactly the run where the garbage is left.
const armed = new Set();
let hooked = false;
const exit0 = process.exit;

function armCleanup(home) {
  armed.add(home);
  if (hooked) return;
  hooked = true;
  const clean = () => {
    for (const dir of armed) {
      // Live stand «panes» are processes: without killing them the run would leave a
      // session behind.
      for (const server of ['cursor-agent', 'promptobus-launch']) {
        for (const s of listSess(dir, server)) killTree(s.panePid);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  process.on('exit', clean);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { clean(); exit0.call(process, 130); });
  }
}

function killTree(pid) {
  if (!pidAlive(pid)) return;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // No group, or the process is already dead — both branches are legal.
    }
  }
}

// --- stub tmux ------------------------------------------------------------------

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Stub `tmux`. Parses exactly the subcommands the mechanism uses to talk to a
 * persist session; everything else is a refusal with a non-zero code, because a silent
 * success on an unknown command would hide a divergence from the real binary.
 */
export async function tmuxMain(argv, env = process.env) {
  const home = env[CURSOR_HOME_VAR];
  if (!home) {
    process.stderr.write(`stub tmux: ${CURSOR_HOME_VAR} is unset — there is no stand home\n`);
    process.exitCode = 1;
    return;
  }
  // ONLY `-V` prints the version, and that is not a stand nit: live tmux on `--version`
  // answers with usage and code 1 (measurement 2026-09-03, 3.6b). If the mechanism asks
  // with the wrong flag — the version is «undefined», that is the `minVersion` gate never
  // fires; the stand must go red on that, not play along.
  if (argv[0] === '-V') {
    process.stdout.write(`${TMUX_VERSION}\n`);
    return;
  }
  // Global flags: we parse `-L <server>`, we swallow `-u` and `-f <file>` — they do not
  // affect stand behaviour, and they always sit in the mechanism argv.
  const rest = [];
  let server = 'default';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-L') { server = argv[i + 1]; i += 1; continue; }
    if (argv[i] === '-f') { i += 1; continue; }
    if (argv[i] === '-u') continue;
    rest.push(...argv.slice(i));
    break;
  }
  const cmd = rest[0];
  const args = rest.slice(1);
  if (cmd === 'new-session') return tmuxNewSession(home, server, args, env);
  if (cmd === 'list-sessions') return tmuxList(home, server, args);
  if (cmd === 'set-option') return tmuxSetOption(home, server, args);
  if (cmd === 'kill-session') return tmuxKillSession(home, server, args);
  if (cmd === 'capture-pane') return tmuxCapture(home, server, args);
  if (cmd === 'load-buffer') return tmuxLoadBuffer(home, args);
  if (cmd === 'paste-buffer') return tmuxPasteBuffer(home, server, args);
  if (cmd === 'send-keys') return tmuxSendKeys(home, server, args);
  process.stderr.write(`stub tmux: subcommand «${cmd ?? ''}» is not supported\n`);
  process.exitCode = 1;
  return undefined;
}

function tmuxNewSession(home, server, args, env) {
  const name = argValue(args, '-s') ?? `unnamed-${process.pid}`;
  const cwd = argValue(args, '-c') ?? process.cwd();
  // The pane command is everything left after the flags: the mechanism calls `... -c <cwd> sh <script>`.
  const flags = new Set(['-s', '-c', '-x', '-y']);
  const command = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-d') continue;
    if (flags.has(args[i])) { i += 1; continue; }
    command.push(...args.slice(i));
    break;
  }
  if (!command.length) {
    process.stderr.write('stub tmux: new-session without a pane command\n');
    process.exitCode = 1;
    return;
  }
  // `TMUX` in the pane environment is exactly why the mechanism calls `env -u TMUX`: live
  // `persist` inside a foreign tmux session SILENTLY does not persist (REPORT §4.2). Drop
  // `-u TMUX` from the start script — and the session will not appear, as it did not
  // appear live.
  const child = spawn(command[0], command.slice(1), {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...env, TMUX: `${serverDir(home, server)}/socket,${process.pid},0`, TMUX_PANE: '%0' },
  });
  child.unref();
  writeSess(home, server, {
    name,
    server,
    created: Math.floor(Date.now() / 1000),
    attached: 0,
    panePid: child.pid ?? null,
    cwd,
    options: {},
    pending: '',
    pastedAt: 0,
    busy: false,
  });
}

// Expand a `#{...}` format: the same fields live tmux gives the mechanism.
function renderFormat(fmt, sess) {
  return String(fmt).replace(/#\{([^}]+)\}/g, (_, key) => {
    if (key.startsWith('@')) return String(sess.options?.[key] ?? '');
    if (key === 'session_name') return sess.name;
    if (key === 'session_attached') return String(sess.attached ?? 0);
    if (key === 'session_created') return String(sess.created ?? 0);
    if (key === 'pane_pid') return String(sess.panePid ?? '');
    if (key === 'session_path') return String(sess.cwd ?? '');
    return '';
  });
}

function tmuxList(home, server, args) {
  const sessions = listSess(home, server).filter((s) => pidAlive(s.panePid));
  if (!sessions.length) {
    process.stderr.write(`no server running on ${serverDir(home, server)}/socket\n`);
    process.exitCode = 1;
    return;
  }
  const fmt = argValue(args, '-F') ?? '#{session_name}';
  process.stdout.write(`${sessions.map((s) => renderFormat(fmt, s)).join('\n')}\n`);
}

function tmuxSetOption(home, server, args) {
  const name = argValue(args, '-t');
  const tail = args.slice(args.indexOf('-t') + 2);
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`stub tmux: session ${name} does not exist\n`);
    process.exitCode = 1;
    return;
  }
  sess.options = { ...sess.options, [tail[0]]: tail.slice(1).join(' ') };
  writeSess(home, server, sess);
}

function tmuxKillSession(home, server, args) {
  const name = argValue(args, '-t');
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`stub tmux: session ${name} does not exist\n`);
    process.exitCode = 1;
    return;
  }
  killTree(sess.panePid);
  dropSess(home, server, name);
}

/**
 * What is visible in the pane. Two lines, and both are labels the driver's input
 * protocol sits on: the input field (the prompt or the text in it) and the in-progress
 * turn marker.
 */
function tmuxCapture(home, server, args) {
  const name = argValue(args, '-t');
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`stub tmux: session ${name} does not exist\n`);
    process.exitCode = 1;
    return;
  }
  // The in-progress turn marker sits on THE SAME line as the input field — that is how
  // the live TUI draws it (measurement 2026-09-03: `→ Add a follow-up …spaces… ctrl+c to
  // stop`). If the stand does not repeat this — a driver that reads the input field as
  // busy on every in-progress turn would pass the suite green: that is exactly how the
  // first live run under persist gave three delivery refusals out of three.
  const input = sess.pending ? sess.pending.split('\n')[0] : 'Add a follow-up';
  const lines = [
    '  Cursor Agent (stand)',
    `  → ${input}${sess.busy ? `${' '.repeat(20)}ctrl+c to stop` : ''}`,
    '  Cursor Model · 1.0%',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function bufferPath(home, name) {
  return path.join(home, 'tmux', 'buffers', String(name).replace(/[^A-Za-z0-9._-]+/g, '-'));
}

function tmuxLoadBuffer(home, args) {
  const buf = argValue(args, '-b') ?? 'default';
  const file = args[args.length - 1];
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`stub tmux: buffer not read (${e.message})\n`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(path.dirname(bufferPath(home, buf)), { recursive: true });
  writeFileSync(bufferPath(home, buf), text);
}

/**
 * Paste a buffer into the input field. `-p` (bracketed paste) puts multiline text as ONE
 * message — line-by-line input would send it as several; `-d` drops the buffer.
 */
function tmuxPasteBuffer(home, server, args) {
  const buf = argValue(args, '-b') ?? 'default';
  const name = argValue(args, '-t');
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`stub tmux: session ${name} does not exist\n`);
    process.exitCode = 1;
    return;
  }
  let text = '';
  try {
    text = readFileSync(bufferPath(home, buf), 'utf8');
  } catch {
    process.stderr.write(`stub tmux: buffer ${buf} does not exist\n`);
    process.exitCode = 1;
    return;
  }
  if (args.includes('-d')) rmSync(bufferPath(home, buf), { force: true });
  sess.pending = `${sess.pending}${text}`;
  sess.pastedAt = Date.now();
  writeSess(home, server, sess);
}

/**
 * Keys into the pane. Two forms, both live: `Enter` sends the input field, `C-u` clears
 * it.
 *
 * **Enter is lost if it arrives right after a paste** — that is the live miss the
 * driver's pause exists for (REPORT §4.3): the text stays in the field and rides out
 * with the next message as one glue.
 */
function tmuxSendKeys(home, server, args) {
  const name = argValue(args, '-t');
  const sess = readSess(home, server, name);
  if (!sess) {
    process.stderr.write(`stub tmux: session ${name} does not exist\n`);
    process.exitCode = 1;
    return;
  }
  const keys = args.slice(args.indexOf('-t') + 2);
  if (keys.includes('C-u')) {
    sess.pending = '';
    writeSess(home, server, sess);
    return;
  }
  if (!keys.includes('Enter')) {
    // The stand accepts `send-keys -l <text>`, but puts it into the input field as-is:
    // the driver does not use it, and a silent refusal would hide its appearance.
    const i = keys.indexOf('-l');
    if (i >= 0) {
      sess.pending = `${sess.pending}${keys.slice(i + 1).join(' ')}`;
      sess.pastedAt = Date.now();
      writeSess(home, server, sess);
    }
    return;
  }
  if (Date.now() - Number(sess.pastedAt || 0) < STUB_ENTER_MIN_MS) {
    // Enter was lost. The input field keeps the text — exactly as in the live `LAT-8`/`LAT-9` case.
    return;
  }
  if (!sess.pending) return;
  const file = queueFile(home, sess.name);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ text: sess.pending, at: Date.now() })}\n`);
  sess.pending = '';
  writeSess(home, server, sess);
}

// --- stub agent ------------------------------------------------------------------

function note(home, address, entry) {
  if (!address) return;
  try {
    mkdirSync(path.dirname(traceFile(home, address)), { recursive: true });
    appendFileSync(traceFile(home, address), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // The trace is test diagnosis, and a write failure is no reason to crash the stand.
  }
}

/**
 * Orphaned `worker-server` — the one live `agent` leaves even after a NORMAL end of
 * turn (REPORT §4.8). Detached on purpose: the pane process tree does not cover it, and
 * the only way to find it is by an environment mark — exactly what the probe checks.
 *
 * It lives a minute and dies on its own: a crashed run has no right to leave a process
 * behind.
 */
function spawnWorkerServer(home) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000); // worker-server'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENT_CLI_SOCKET_PATH: path.join(home, 'worker.soc') },
  });
  child.unref();
  return child.pid ?? null;
}

/**
 * Tool child: a process the turn started and that survives `persist stop` (REPORT
 * §4.8). Not detached — it is a descendant of the pane, and is found by the tree from
 * the pane pid, not by a mark: the tool, not the binary, builds the child's
 * environment.
 */
function spawnToolChild() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000); // tool child'], {
    stdio: 'ignore',
  });
  child.unref();
  return child.pid ?? null;
}

/**
 * Stub `agent`. Parses exactly what the mechanism calls: `--version`, `mcp enable
 * <name>` and the `persist` subcommand in all four forms. Everything else is a refusal
 * with a non-zero code.
 */
export async function agentMain(argv, env = process.env) {
  const home = env[CURSOR_HOME_VAR];
  if (!home) {
    process.stderr.write(`stub agent: ${CURSOR_HOME_VAR} is unset — there is no stand home\n`);
    process.exitCode = 1;
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${HARNESS_VERSION}\n`);
    return;
  }
  if (argv[0] === 'mcp' && argv[1] === 'enable') {
    const file = path.join(home, 'approvals', `${createHash('md5').update(process.cwd()).digest('hex')}.json`);
    const was = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    writeFileSync(file, `${JSON.stringify([...new Set([...was, argv[2]])], null, 2)}\n`);
    process.stdout.write(`enabled ${argv[2]}\n`);
    return;
  }
  if (argv[0] !== 'persist') {
    process.stderr.write(`stub agent: subcommand «${argv[0] ?? ''}» is not supported\n`);
    process.exitCode = 1;
    return;
  }
  if (argv[1] === 'list') return persistList(home);
  if (argv[1] === 'stop') return persistStop(home, argv[2]);
  if (argv[1] === 'attach') {
    // The stand does not draw a human entry: the feed is a TUI, and what is checked here
    // is the route, not the picture. A successful code and a line — that is what the
    // person who attached sees.
    process.stdout.write(`attached ${argv[2]}\n`);
    return undefined;
  }
  // Internal form: the persist session itself. The `persist` client below starts it as a
  // detached child — the same way the live one does: the session pane lives on ITS OWN
  // server and outlives the client that created it.
  if (argv[1] === '__session') return sessionMain(JSON.parse(Buffer.from(argv[2], 'base64').toString('utf8')), env);
  return persistUp(home, argv.slice(1), env);
}

const STUB_SERVER = 'cursor-agent';

function persistList(home) {
  const sessions = listSess(home, STUB_SERVER).filter((s) => pidAlive(s.panePid));
  if (!sessions.length) {
    process.stdout.write('No Cursor-managed persistent sessions.\n');
    return;
  }
  const body = sessions.map((s) => `Task: ${s.options?.['@promptobus_address'] ?? 'session'}\n`
    + `  Status: Detached (running in background)\n`
    + `  Session: ${s.name}\n`
    + `  Chat ID: ${s.options?.['@cursor_chat_id'] ?? '-'}\n`
    + `  Workspace: ${s.cwd}\n`
    + `  Attach: agent persist attach ${s.name}`).join('\n\n');
  process.stdout.write(`${sessions.length} persistent session${sessions.length > 1 ? 's' : ''}:\n\n${body}\n`);
}

/**
 * Killing a session. The pane dies, the session record disappears — and tool children
 * stay alive: live `persist stop` does not touch them (REPORT §4.8), and finding them
 * is the mechanism's job.
 */
function persistStop(home, name) {
  const sess = readSess(home, STUB_SERVER, name);
  if (!sess) {
    process.stderr.write(`Cursor-managed persistent session not found: ${name}\n`);
    process.exitCode = 1;
    return;
  }
  // We hit ONE pane process, not the group: the group would cover tool children too,
  // that is the stand would clean up after the mechanism what the mechanism is obliged
  // to clean up itself.
  try {
    process.kill(sess.panePid, 'SIGKILL');
  } catch {
    // The pane is already dead — a legal outcome.
  }
  dropSess(home, STUB_SERVER, name);
  process.stdout.write(`Stopped persistent session: ${name}\n`);
}

/**
 * Workspace hash — the same one live `persist` uses to mark its session (REPORT §2), and
 * it is computed from the RESOLVED path: live Cursor hashes what the path unfolds into
 * (live measurement 2026-09-03, macOS `$TMPDIR` is a symlink). If the stand does not
 * repeat this — dropping `realpathSync` from the mechanism would leave the suite green,
 * even though a start from a directory behind a symlink would stop finding its session.
 */
function workspaceHash(cwd) {
  let flat = String(cwd);
  try {
    flat = realpathSync(flat);
  } catch {
    // The directory is gone — hash as-is: the session then simply will not be found.
  }
  return createHash('sha256').update(flat).digest('hex').slice(0, 10);
}

/** Session name — the same form as the live one: `cursor-<slug>-<hash>-<n>-<rand6>`. */
function sessionName(cwd) {
  const slug = path.basename(cwd).replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  return `cursor-${slug}-${workspaceHash(cwd)}-1-${randomUUID().slice(0, 6)}`;
}

/**
 * `agent persist` client: it starts the SESSION as a detached process and leaves. Live
 * behaves the same way — the session pane lives on the `cursor-agent` server and
 * outlives both the client and the pty-provider pane it was called from (REPORT §2).
 */
async function persistUp(home, argv, env) {
  if (argv.includes('--approve-mcps')) {
    process.stderr.write('stub agent: --approve-mcps approves foreign workspace servers — the driver does not pass it\n');
    process.exitCode = 1;
    return;
  }
  const workspace = argValue(argv, '--workspace');
  if (!workspace) {
    process.stderr.write('stub agent: persist without --workspace — the chat store would be keyed by the launch directory\n');
    process.exitCode = 1;
    return;
  }
  const model = argValue(argv, '--model') ?? 'composer-2.5';
  const prompt = argv[argv.length - 1];
  const cfg = readBusConfig(workspace);
  const address = cfg?.env?.PROMPTOBUS_ROLE ?? null;
  const chatId = randomUUID();
  const name = sessionName(workspace);
  const plan = {
    home, workspace, chatId, model, name, address, prompt,
    userHome: env.PROMPTOBUS_CURSOR_USER_HOME ?? path.join(home, 'cursor'),
  };
  // **The `TMUX` trap** (REPORT §4.2): inside a foreign tmux session `persist` SILENTLY
  // starts an ordinary non-persistent `agent` — no session, no line in the list, not a
  // word about it. The stand repeats this literally: the turn is played right here, and
  // no session appears at all.
  if (env.TMUX) {
    note(home, address, { kind: 'not-persistent', chatId, name });
    const transcript = transcriptFile(plan.userHome, workspace, chatId);
    mkdirSync(path.dirname(transcript), { recursive: true });
    await playTurn({ ...plan, transcript, text: prompt, persistent: false, env });
    return;
  }
  const child = spawn(process.execPath, [process.argv[1], 'persist', '__session',
    Buffer.from(JSON.stringify(plan)).toString('base64')], {
    cwd: workspace,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  writeSess(home, STUB_SERVER, {
    name,
    server: STUB_SERVER,
    created: Math.floor(Date.now() / 1000),
    attached: 0,
    panePid: child.pid ?? null,
    cwd: workspace,
    options: {
      '@cursor_managed': '1',
      '@cursor_workspace_hash': workspaceHash(workspace),
      '@cursor_session_version': '1',
      '@cursor_chat_id': chatId,
    },
    pending: '',
    pastedAt: 0,
    busy: true,
  });
  note(home, address, { kind: 'session-up', chatId, model, name, argv });
  process.stdout.write(`Started persistent session ${name}\n`);
}

/** The persist session itself: first turn from the start prompt, then the message queue. */
async function sessionMain(plan, env = process.env) {
  const {
    home, workspace, chatId, model, name, address, prompt, userHome,
  } = plan;
  const cfg = readBusConfig(workspace);
  const transcript = transcriptFile(userHome, workspace, chatId);
  mkdirSync(path.dirname(transcript), { recursive: true });
  const ctx = {
    home, address, cfg, chatId, workspace, transcript, model, name, env,
  };
  await playTurn({ ...ctx, text: prompt, persistent: true });
  await serveQueue(ctx);
}

/** Live session loop: wait for a message on the queue and play each as a separate turn. */
async function serveQueue(ctx) {
  const file = queueFile(ctx.home, ctx.name);
  let played = 0;
  for (;;) {
    if (!readSess(ctx.home, STUB_SERVER, ctx.name)) return;
    let lines = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      lines = [];
    }
    if (lines.length > played) {
      const next = lines[played];
      played += 1;
      let text = '';
      try {
        text = JSON.parse(next).text;
      } catch {
        text = next;
      }
      await playTurn({ ...ctx, text, persistent: true });
      continue;
    }
    await new Promise((r) => { setTimeout(r, 100); });
  }
}

function setBusy(home, name, busy) {
  const sess = readSess(home, STUB_SERVER, name);
  if (!sess) return;
  sess.busy = busy;
  writeSess(home, STUB_SERVER, sess);
}

/** Turn: user message into the transcript, actions from the script, `turn_ended` and the hook. */
async function playTurn({
  home, address, cfg, chatId, workspace, transcript, model, text, name, persistent, env,
}) {
  if (persistent) setBusy(home, name, true);
  appendFileSync(transcript, `${JSON.stringify({
    role: 'user',
    message: { content: [{ type: 'text', text: `<user_query>\n${String(text).slice(0, 400)}\n</user_query>` }] },
  })}\n`);
  const turn = nextTurn(home, address);
  note(home, address, { kind: 'turn-start', turn, text: String(text).slice(0, 120) });
  // The pane runtime (`worker-server`) is alive even on a clean hang — like
  // `promptobus mcp` on a live persist session. Stop must still be set then: the filter
  // cuts it. A live tool child (a long gate) is a separate flag.
  spawnWorkerServer(home);
  if (env[HANG_CHILD_VAR] || !env[HANG_VAR]) spawnToolChild();
  const outcome = await runScript({ home, address, cfg, turn, chatId, workspace, transcript, env });
  if (outcome === 'hang') {
    // Hang: the turn does not end, the transcript does not grow. Exactly the sign the
    // watchdog uses to judge silence — and the process is alive, as it is in a live hang.
    note(home, address, { kind: 'hang' });
    await new Promise((r) => { setTimeout(r, 600_000); });
    return;
  }
  appendFileSync(transcript, `${JSON.stringify({
    role: 'assistant', message: { content: [{ type: 'text', text: `ход ${turn} сыгран (${outcome})` }] },
  })}\n`);
  appendFileSync(transcript, `${JSON.stringify({ type: 'turn_ended', status: outcome === 'error' ? 'error' : 'success' })}\n`);
  if (persistent) setBusy(home, name, false);
  note(home, address, { kind: 'turn-end', turn, outcome });
  fireStopHook(workspace, { chatId, model, outcome, transcript });
}

// Bus record from the project `.cursor/mcp.json` of the working directory — that is how
// the participant learns who it is: the start puts the address, the task and the bus
// home there.
function readBusConfig(workspace) {
  try {
    const cfg = JSON.parse(readFileSync(path.join(workspace, '.cursor', 'mcp.json'), 'utf8'));
    return cfg?.mcpServers?.promptobus ?? null;
  } catch {
    return null;
  }
}

function nextTurn(home, address) {
  const file = turnsFile(home, address ?? 'anon');
  let n = 0;
  try {
    n = Number(JSON.parse(readFileSync(file, 'utf8')).n) || 0;
  } catch {
    n = 0;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ n: n + 1 })}\n`);
  return n;
}

// Turn from the script: the same actions the scripted participant of the stub `claude`
// plays ([participant.mjs](participant.mjs)).
async function runScript({ home, address, cfg, turn, workspace, env }) {
  if (env[HANG_VAR] || env[HANG_CHILD_VAR]) return 'hang';
  let script = { turns: [] };
  try {
    script = JSON.parse(readFileSync(scriptFile(home, address), 'utf8'));
  } catch {
    // No script — a silent turn: a legal scenario, not a stand breakage.
  }
  const plan = script.turns?.[turn] ?? null;
  if (!plan) return 'idle';
  if (plan.hang) return 'hang';
  // A turn spent on a question: in the participant session a question gets a skip, not
  // an answer (REPORT §4.15). The turn still ends successfully — only the content
  // distinguishes the outcomes.
  if (plan.askQuestion) return 'question';
  if (!cfg) {
    note(home, address, { kind: 'no-bus', workspace });
    return 'error';
  }
  const bus = await openBus(cfg);
  for (const action of plan.do ?? []) {
    await act({ home, address, bus, action, workspace });
  }
  await bus.close();
  return 'done';
}

// A real `promptobus mcp` as a child process and line-delimited JSON-RPC — the same
// transport live Cursor uses to talk to it.
async function openBus(cfg) {
  const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // A stray line on the protocol channel is the server's trouble, not the stand's.
      }
    }
  });
  const rpc = (method, params) => {
    const rid = (seq += 1);
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 30000);
      pending.set(rid, (m) => { clearTimeout(timer); resolve(m); });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
    return answer;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor-stub', version: '1' } });
  return { rpc, close: () => new Promise((r) => { child.on('close', r); child.stdin.end(); }) };
}

async function act({
  home, address, bus, action, workspace,
}) {
  if (action.wait) {
    await new Promise((r) => { setTimeout(r, action.wait); });
    note(home, address, { kind: 'wait', ms: action.wait });
    return;
  }
  if (action.write) {
    const file = path.join(workspace, action.write.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, action.write.text);
    note(home, address, { kind: 'write', path: action.write.path });
    return;
  }
  if (action.commit) {
    const r = spawnSync('git', ['-C', workspace, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid',
      'add', '-A'], { encoding: 'utf8' });
    const c = spawnSync('git', ['-C', workspace, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid',
      'commit', '-m', action.commit.message], { encoding: 'utf8' });
    note(home, address, { kind: 'commit', status: `${r.status}/${c.status}` });
    return;
  }
  if (action.tool) {
    let answer = null;
    try {
      answer = await bus.rpc('tools/call', { name: action.tool, arguments: action.args ?? {} });
    } catch (e) {
      note(home, address, { kind: 'action-failed', tool: action.tool, error: e.message });
      return;
    }
    const text = answer?.result?.content?.map((c) => c.text).join('\n') ?? '';
    note(home, address, { kind: 'tool', tool: action.tool, isError: !!answer?.result?.isError, text: text.slice(0, 400) });
    return;
  }
  note(home, address, { kind: 'unknown-action', action });
}

/**
 * The `stop` hook from the PROJECT `.cursor/hooks.json`: under persist it fires, and
 * `sessionEnd` does not fire at all (REPORT §4.4). The payload is the same —
 * `session_id` (also `chatId`), `status`, `loop_count`, `cursor_version`,
 * `transcript_path`.
 *
 * **An unknown event name kills the whole file.** The live binary then fires no hook at
 * all, including the correctly named ones, and stays silent about it (REPORT §4.4). The
 * stand repeats this literally: a driver that appended a misspelled event loses the
 * loop guard and the wake channel at once — and the run goes red in the same place.
 */
function fireStopHook(workspace, { chatId, model, outcome, transcript }) {
  let hooks = null;
  try {
    hooks = JSON.parse(readFileSync(path.join(workspace, '.cursor', 'hooks.json'), 'utf8'));
  } catch {
    return;
  }
  const names = Object.keys(hooks?.hooks ?? {});
  if (!names.length || names.some((n) => !KNOWN_HOOK_EVENTS.includes(n))) return;
  const command = hooks?.hooks?.stop?.[0]?.command ?? null;
  if (!command) return;
  const payload = {
    conversation_id: chatId,
    generation_id: chatId,
    model,
    status: outcome === 'error' ? 'error' : 'completed',
    loop_count: 0,
    input_tokens: 57240,
    output_tokens: 184,
    session_id: chatId,
    hook_event_name: 'stop',
    cursor_version: HARNESS_VERSION,
    workspace_roots: [workspace],
    transcript_path: transcript,
  };
  // `shell: true` — the hooks file holds a STRING of the command, and the shell parses
  // it: that is how the real binary runs it, and the quotes around paths are for it.
  spawnSync(command, {
    cwd: workspace, env: process.env, shell: true, input: JSON.stringify(payload), encoding: 'utf8',
  });
}

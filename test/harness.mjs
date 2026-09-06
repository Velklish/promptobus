// Stub E2E harness: a `claude` whose sessions are real processes. Not a
// `*.test.mjs` — the runner (run.mjs) takes only those from the directory, so this
// file is never part of the run.
//
// How it differs from the stub binary in the neighbouring files ([sandbox.mjs](sandbox.mjs)).
// That one prints a prepared reply and exits: there is no session at all, and the
// «notification → mailbox → reply» loop cannot be assembled on it. Here `--bg` starts a
// SEPARATE process for the scripted participant ([participant.mjs](participant.mjs)),
// `agents --json` prints this process registry, and `stop <id>` kills them. Everything
// else in the loop is real: the `claude` driver from `lib/`, the warden, the bus MCP
// server, the task store.
//
// **The substitution sits on the binary boundary, not the driver's.** The driver is
// the subject under test: if we substituted it, the E2E would stop checking `activate`,
// `inspect` and `stop`, which is why it exists. So we substitute exactly what in life
// sits beyond the mechanism — the external `claude` command.
//
// The registry is a DIRECTORY of files, one file per session, not a single JSON.
// It has three writers: `--bg` creates a record, the participant itself updates its
// busy flag on every turn, `stop` removes it. A shared file would need a lock between
// the three processes; separate files give each writer its own name, and no lock is
// needed at all.
import {
  existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));

/** Harness home in the environment: both the stub binary and the participant read it. */
export const HARNESS_HOME_VAR = 'PROMPTOBUS_E2E_HARNESS';
/** Session socket path template — `@` in place of the name. Why a template, not a directory — below. */
export const SOCK_BASE_VAR = 'PROMPTOBUS_E2E_SOCK';

// The version the stub binary answers with is not a literal, but the same constant the
// whole parse sits on: the wire form and the `agents --json` format were taken from it.
// A private copy of the number would silently drift from `contract.js`, and the stand
// would pretend to be a build that no longer exists.
// The stand has its own name: from the outside this is «the harness version», and it is
// called by that name below.
import { PROVEN_CLAUDE_VERSION } from '../lib/driver-claude.js';

export const HARNESS_VERSION = PROVEN_CLAUDE_VERSION;

// File key from the participant address: a colon is not legal in a file name everywhere,
// and the address is the only thing the test and the participant use to recognise each
// other. One function for both, so the participant imports it from here rather than
// repeating the rule on its side.
export function addrKey(address) {
  return String(address).replace(/[^A-Za-z0-9._-]+/g, '-');
}

export function sessionsDir(home) {
  return path.join(home, 'sessions');
}

export function sessionFile(home, id) {
  return path.join(sessionsDir(home), `${id}.json`);
}

/** Participant turn script: the test writes it, the participant reads it. */
export function scriptFile(home, address) {
  return path.join(home, 'scripts', `${addrKey(address)}.json`);
}

/** Trace of what the participant did and what the bus answered. The test checks against it. */
export function traceFile(home, address) {
  return path.join(home, 'trace', `${addrKey(address)}.jsonl`);
}

/** Config directory that the stub harness presents as `~/.claude`. */
export function claudeConfigDir(home) {
  return path.join(home, 'claude-config');
}

export function logFile(home, id) {
  return path.join(home, 'logs', `${id}.log`);
}

export function readSession(home, id) {
  try {
    return JSON.parse(readFileSync(sessionFile(home, id), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSession(home, record) {
  mkdirSync(sessionsDir(home), { recursive: true });
  writeFileSync(sessionFile(home, record.id), JSON.stringify(record, null, 2) + '\n');
  return record;
}

/** The registry as a whole — the same thing `agents --json` prints. */
export function listSessions(home) {
  let names;
  try {
    names = readdirSync(sessionsDir(home)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => readSession(home, n.slice(0, -'.json'.length))).filter(Boolean)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/** Participant records by session name — the same field `findSession` searches by. */
export function sessionByName(home, name) {
  return listSessions(home).find((s) => s.name === name) ?? null;
}

/** Participant trace: one line per action. Empty — the participant did nothing. */
export function readTrace(home, address) {
  try {
    return readFileSync(traceFile(home, address), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    return [];
  }
}

// SCENARIO errors of the participant, not of the mechanism: an unknown script action, a
// failed action, a failed turn. The participant does not stop on them — a live session
// does not crash on an unknown tool, and the stand repeats that — so the E2E goes red on
// later steps, while the cause sits at the start of the trace. Live case: old
// `{ tool: 'send' }` in the scenario after the tools were renamed — the participant wrote
// `unknown-action` and carried on, the red was the eighth step, the diagnosis came from
// reading the whole trace.
const AUTHOR_ERROR_KINDS = new Set(['unknown-action', 'action-failed', 'turn-failed']);
export function authorErrors(trace) {
  return trace.filter((e) => AUTHOR_ERROR_KINDS.has(e?.kind));
}

/** Diagnosis from the participant trace for a red verdict: scenario errors first, then the tail of the trace. */
export function diagnoseTrace(home, address, tail = 6) {
  const trace = readTrace(home, address);
  const errs = authorErrors(trace);
  const head = errs.length ? `scenario errors for ${address} (the cause is usually here): ${JSON.stringify(errs)} · ` : '';
  return `${head}trace for ${address}: ${JSON.stringify(trace.slice(-tail))}`;
}

/** Tail of the participant log — the test prints it on a red verdict, otherwise there is no diagnosis. */
export function readLog(home, id, lines = 40) {
  try {
    return readFileSync(logFile(home, id), 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Whether the session process is alive. We judge by signal 0 — the same way the whole mechanism judges liveness. */
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
 * Lay out the harness and put its `claude` first on PATH. `sock` is the socket path
 * builder from [sandbox.mjs](sandbox.mjs) (`makeSockPath`): a full unix-socket path is
 * limited to about 104 bytes, and the suite-file sandbox lives in the run directory and
 * alone eats about seventy-five characters. The stub binary is given a TEMPLATE (`@` in
 * place of the name), not a directory: on Windows a socket is a named pipe, it has no
 * directory at all, and the template remains the only form that works on both platforms.
 *
 * **The harness home is created by the harness itself and OUTSIDE the file sandbox**
 * (review note). Had it lived inside, cleanup on exit would be a no-op: the sandbox hook
 * ([sandbox.mjs](sandbox.mjs)) is registered earlier — the sandbox is created before the
 * stand is installed — and on `process.exit` that directory is removed first, then
 * `clean()` reads an empty registry and kills nobody. Its own `mkdtemp` in `os.tmpdir()`
 * puts the home NEXT TO the sandbox: under the runner that is the run directory (the
 * runner cleans it), in a solo run it is system tmp, and from there the same hook that
 * kills sessions removes it.
 *
 * Returns the home and a PATH restore function: PATH is one per test process, and leaving
 * it substituted leaks into neighbouring branches of the same file.
 */
export async function installHarness({ binDir, sock, env = process.env }) {
  const { stubCommand, withStubPath } = await import('./sandbox.mjs');
  const home = mkdtempSync(path.join(os.tmpdir(), 'promptobus-harness-'));
  armCleanup(home);
  for (const dir of ['sessions', 'scripts', 'trace', 'logs']) {
    mkdirSync(path.join(home, dir), { recursive: true });
  }
  mkdirSync(claudeConfigDir(home), { recursive: true });
  // The binary body is a call to `claudeMain` of this same module. It cannot be its own
  // copy of the scenario: the registry, the record form and the directory layout are needed
  // by both the test and the binary, and they can only stay in sync while they share one
  // home.
  stubCommand(binDir, 'claude', `import { claudeMain } from ${JSON.stringify(path.join(here, 'harness.mjs'))};\n`
    + 'await claudeMain(process.argv.slice(2));\n');
  const restore = withStubPath(binDir);
  env[HARNESS_HOME_VAR] = home;
  env[SOCK_BASE_VAR] = sock('@');
  // Harness config home: from here the driver reads `jobs/<id>/state.json`, that is the
  // stop reason. Without the substitution it would look in the real person's `~/.claude`.
  env.CLAUDE_CONFIG_DIR = claudeConfigDir(home);
  return {
    home,
    restore: () => {
      restore();
      delete env[HARNESS_HOME_VAR];
      delete env[SOCK_BASE_VAR];
      delete env.CLAUDE_CONFIG_DIR;
    },
  };
}

/**
 * Turn script for the scripted participant. The form is a list of turns: turn `0` is
 * played on session start (that is the first turn from the prompt), each next one on the
 * next warden knock. More turns than knocks — the extras are not played; more knocks than
 * turns — the participant stays silent, and that is a legal scenario (the silent-stop
 * report is checked on it).
 */
export function planParticipant(home, address, script) {
  mkdirSync(path.dirname(scriptFile(home, address)), { recursive: true });
  writeFileSync(scriptFile(home, address), JSON.stringify(script, null, 2) + '\n');
  return script;
}

// --- the binary itself ----------------------------------------------------------

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// The short record id is DERIVED FROM the session uuid, not created separately.
// Measurement 2026-09-03 on `claude` 2.1.251: a background record has `id: "e8c5be23"`
// with `sessionId: "e8c5be23-dfef-4d20-bd96-e2a40a366b97"` — that is exactly the first
// eight hex of the same uuid.
//
// The address-ownership gate does NOT sit on this link: the main rule is equality of
// full ids, and that is what the E2E uses, because the stand puts `sessionId` on the
// record. The pair is kept here for the FALLBACK rule (`sameSession`), which reads
// records without a full id — a previous release, and starts with an unparsed session
// list. Split the two spellings here and the stand would be checking the fallback rule
// against a model that does not exist.
function shortId(sessionId) {
  return sessionId.slice(0, 8);
}

/**
 * Bus identity that the stub daemon hands to EACH of its background sessions. It is
 * deliberately foreign — and that is its job, not a stand tweak: the daemon on the
 * machine was started by an unrelated process, and the session gets ITS environment. A
 * daemon that hands back the environment of the call that claimed the session models
 * nothing — that is exactly the false premise  removed.
 */
export const DAEMON_IDENTITY = {
  PROMPTOBUS_ROLE: 'worker:demon',
  PROMPTOBUS_TASK: 'demon-t20260101-000000',
  PROMPTOBUS_HOME: '/nonexistent/demon/.promptobus',
};

/**
 * Background-session environment — what the DAEMON hands it, not what it was called
 * with . Measurement 2026-09-03 (`ps eww`, `claude` 2.1.251): background
 * sessions are taken from pre-created `claude bg-spare` under
 * `claude bg-pty-host … /tmp/cc-daemon-501/…`, and they get their environment from the
 * process that started the daemon — every session in the run had the same
 * `PROMPTOBUS_*` triple, including a session in another workspace.
 *
 * The stand models this in two halves, and both are needed. First: the environment of
 * the first `--bg` in the run is written to a file in the harness home and given to
 * every later session — the only variables that stay its own are those the harness
 * itself puts there (the session identity and its contact point). Second: `DAEMON_IDENTITY`
 * is laid on top — the triple of the FOREIGN process that started the daemon. Without
 * the second half the stand would be green for any order of sources in the guard: the
 * session environment would match what the start already knows. Each suite file has its
 * own home, so the daemon here is also per-file.
 */
function daemonEnv(home, env) {
  const file = path.join(home, 'daemon-env.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    const first = { ...env, ...DAEMON_IDENTITY };
    mkdirSync(home, { recursive: true });
    // Mode `0600`: developer environment carries tokens, and a full snapshot of it is a
    // file of the same class as the participant mcp-config (`writeSecret` in spawn.js).
    // The harness home lives for one run, but it does not have to be readable by the
    // whole machine for even a second.
    writeFileSync(file, JSON.stringify(first, null, 2) + '\n', { mode: 0o600 });
    return first;
  }
}

// Killing a session. We hit the PROCESS GROUP, not a single pid: the participant starts
// a real `promptobus mcp` as its child, and killing the parent alone would leave that
// child orphaned — while the E2E verdict says «after done there are no participant
// processes». Each session has its own group because the participant was started
// `detached`. No group (Windows) — we hit the pid, and the participant reaps its own
// child on SIGTERM.
function killSession(record) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM');
      return true;
    } catch {
      // No group, or the process is already dead — try the next form.
    }
  }
  return false;
}

async function settle(ms) {
  await new Promise((r) => { setTimeout(r, ms); });
}

// Wait for the process to die before removing the record: removing it under a live
// participant would let that participant rewrite its file at the end of the turn, and
// `agents --json` would show a killed session as alive.
async function awaitDeath(pid, { tries = 40, delayMs = 25 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (!pidAlive(pid)) return true;
    await settle(delayMs);
  }
  return false;
}

/**
 * How long a session record outlives its kill command.
 *
 * **The number was measured on a live harness**, not chosen: 2026-09-03, `claude`
 * 2.1.251, three runs — `claude stop <id>` returns in 677, 801 and 898 ms, and the
 * record disappears from `claude agents --json` 1070, 1145 and 1218 ms from the start
 * of the call, that is 270–390 ms AFTER the command returns. A stand that removed the
 * record synchronously was green on a race it did not have at all: the live E2E run
 * went red on steps 13–14, while the stub went 51/51 stably.
 */
export const REAP_DELAY_MS = 300;

/**
 * Removal of the session record by the DAEMON, not by the command: a separate detached
 * process waits for the participant to die, holds the delay, and removes the file. The
 * `stop` command has long since returned by then — that is exactly how a live harness
 * behaves.
 *
 * It has to be detached for the same reason the warden is detached: the stub `claude`
 * process lives a fraction of a second, and a child bound to it would die with it
 * without waiting for anything.
 */
function reapSession(home, record) {
  const file = sessionFile(home, record.id);
  const code = 'const {rmSync}=require("node:fs");'
    + `const pid=${Number(record.pid)},file=${JSON.stringify(file)},delay=${REAP_DELAY_MS};`
    + 'const alive=()=>{try{process.kill(pid,0);return true}catch(e){return e.code==="EPERM"}};'
    + 'const wait=(ms)=>new Promise(r=>setTimeout(r,ms));'
    + '(async()=>{for(let i=0;i<400&&alive();i+=1)await wait(25);'
    + 'await wait(delay);rmSync(file,{force:true});})();';
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Stub `claude`. Parses exactly the subcommands the mechanism calls: `--version`
 * (binary resolve), `agents --json` (session registry), `stop <id>` (kill) and `--bg …`
 * (participant start). Everything else is a refusal with a non-zero code: a silent
 * success on an unknown command would hide a divergence from the real binary.
 */
export async function claudeMain(argv, env = process.env) {
  const home = env[HARNESS_HOME_VAR];
  if (!home) {
    process.stderr.write(`stub claude: ${HARNESS_HOME_VAR} is unset — there is no harness home\n`);
    process.exitCode = 1;
    return;
  }
  if (argv[0] === '--version') {
    process.stdout.write(`${HARNESS_VERSION} (Claude Code)\n`);
    return;
  }
  if (argv[0] === 'agents') {
    process.stdout.write(`${JSON.stringify(listSessions(home))}\n`);
    return;
  }
  if (argv[0] === 'stop') {
    const record = readSession(home, argv[1]);
    if (!record) {
      process.stderr.write(`job not found: ${argv[1]}\n`);
      process.exitCode = 1;
      return;
    }
    // The command returns IMMEDIATELY, and the daemon removes the record —
    // asynchronously, after the process dies (`reapSession`). That is how live
    // `claude stop` behaves, and the stand must repeat it in exactly this: a
    // synchronous removal made cleanup green that on a live harness lawfully left
    // the worktree directory in place.
    killSession(record);
    reapSession(home, record);
    process.stdout.write(`stopped ${record.id}\n`);
    return;
  }
  if (!argv.includes('--bg')) {
    process.stderr.write(`stub claude: subcommand «${argv[0] ?? ''}» is not supported\n`);
    process.exitCode = 1;
    return;
  }

  const name = argValue(argv, '--name');
  if (!name) {
    process.stderr.write('stub claude: --bg without --name — there is nothing to name the session\n');
    process.exitCode = 1;
    return;
  }
  const sessionId = randomUUID();
  const id = shortId(sessionId);
  const socket = String(env[SOCK_BASE_VAR] ?? '').replace('@', id);
  const token = randomUUID();
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  const fd = openSync(logFile(home, id), 'a');
  // Session environment is the DAEMON's, not this call's (`daemonEnv` above). What
  // stays the session's own is exactly what real Claude Code puts there itself: the
  // session identity and its contact point. The participant takes its own source from
  // `--mcp-config` ([13]), and its Stop hook from the arguments of the
  // command that the start wrote into its settings file: there is nothing to trust in
  // the session environment here.
  const child = spawn(process.execPath, [path.join(here, 'participant.mjs'), ...argv], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...daemonEnv(home, env),
      CLAUDE_CODE_SESSION_ID: sessionId,
      CLAUDE_CODE_MESSAGING_SOCKET: socket,
      CLAUDE_CODE_MESSAGING_TOKEN: token,
      PROMPTOBUS_E2E_SESSION: id,
    },
  });
  child.unref();
  // Record form taken from `claude agents --json` 2.1.251 (measurement in
  // [12], «Test coverage boundary»), re-read unchanged on 2.1.263 (PB-34, a live
  // background participant): a bare array, fields
  // `pid, cwd, kind, startedAt, sessionId, name, id, status, state`. `id` and `state`
  // exist only on background records — the harness does not create interactive ones at
  // all.
  writeSession(home, {
    pid: child.pid,
    cwd: process.cwd(),
    kind: 'background',
    startedAt: new Date().toISOString(),
    sessionId,
    name,
    id,
    status: 'busy',
    state: 'working',
  });
  // Output format — observed on 2.1.221 («backgrounded · <id> · <name>»): `parseSessionId`
  // parses it, and the start must be checked against the form the mechanism actually
  // reads.
  process.stdout.write(`backgrounded · ${id} · ${name}\n`);
}

// Cleanup on process exit — the same trouble and the same remedy as the sandboxes
// ([sandbox.mjs](sandbox.mjs)): a paired `stopAll` at the tail of the file does not run
// on exactly the run where the garbage is left — a failed check takes the process out
// through `process.exit` from `fail()`, and Ctrl+C never even gets that far. The cost of
// a miss here is higher than for a directory: behind the registry record stands a live
// participant process, and it will outlive the whole run. Live trace: a harness unit
// cut off on the first red check left the participant running until the end of the
// developer's session.
//
// The hook is synchronous and does not wait for death: an `exit` handler has no event
// loop ticks at all, and the signal goes to the process immediately — that is all the
// safety net needs.
const armed = new Set();
let hooked = false;
// The real exit is captured at module load: suite files replace `process.exit` with a
// thrower, and a signal hook would call the replacement.
const exit0 = process.exit;

function armCleanup(home) {
  armed.add(home);
  if (hooked) return;
  hooked = true;
  const clean = () => {
    for (const dir of armed) {
      for (const record of listSessions(dir)) killSession(record);
      // The home is removed wholesale: registry, scripts, traces and logs live only for
      // the life of the file, and the directory was created outside the sandbox — it
      // has no cleanup of its own from anywhere else.
      rmSync(dir, { recursive: true, force: true });
    }
  };
  process.on('exit', clean);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { clean(); exit0.call(process, 130); });
  }
}

/** Kill everything that is left: a test safety net in `finally`, not part of the scenario. */
export async function stopAll(home) {
  const left = [];
  for (const record of listSessions(home)) {
    killSession(record);
    if (!await awaitDeath(record.pid, { tries: 20 })) left.push(record.id);
    rmSync(sessionFile(home, record.id), { force: true });
  }
  return left;
}

/** Whether the harness home exists — that is what distinguishes a laid-out stand from a missing one. */
export function harnessReady(home) {
  return existsSync(sessionsDir(home));
}

/**
 * Wait for a condition up to a ceiling. Returns the VALUE of the last probe, and does
 * not throw on timeout: the verdict on a step that did not arrive must be a red verdict,
 * not a file abort — otherwise the checks below would not run at all, and the verdict
 * count would diverge across runs.
 *
 * The ceiling is set by the caller: seconds for the stub harness, minutes for the live
 * one.
 */
export async function waitFor(probe, { timeoutMs, stepMs = 100 } = {}) {
  const edge = Date.now() + timeoutMs;
  let last = await probe();
  while (!last && Date.now() < edge) {
    await settle(stepMs);
    last = await probe();
  }
  return last;
}

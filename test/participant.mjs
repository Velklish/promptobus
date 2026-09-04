// Scripted participant of the stub harness. Not a `*.test.mjs` — the runner (run.mjs)
// takes only those from the directory, so this file is never part of the run.
//
// This is a PROCESS, not a stub: the stub `claude --bg` starts it
// ([harness.mjs](harness.mjs)), it lives until `stop` and does exactly what the
// mechanism expects of a participant session ([13]):
//
//   1. it learns who it is from `--mcp-config` — spawn puts the address, the task and
//      the bus home in the `env` of the `promptobus` record of that file (spawn.js). They
//      are not in the session's OWN environment at all
//     : that environment comes from the daemon and belongs to a foreign spawn;
//   2. it starts a real `promptobus mcp` as its child process and talks to it with
//      line-delimited JSON-RPC — the same transport as Claude Code. The contact point is
//      not handed over by the participant by hand, but by the server's `onJoin` — on the
//      handshake: the socket address and the token arrive in its environment
//      (`registerWake`);
//   3. it listens on its messaging socket by the driver's wire protocol: an auth line,
//      then the injection JSON (`dial`/`knockSocket` in driver-claude.js);
//   4. on a knock it plays the next turn of its script — it calls `promptobus_mailbox`,
//      `promptobus_send`, `promptobus_task`;
//   5. it ends the turn: writes `jobs/<id>/state.json`, calls the Stop hook with THE
//      COMMAND FROM THE SETTINGS FILE (`--settings`) and marks its registry record
//      `idle`/`blocked` — that is how the real harness marks the end of a turn.
//
// The turn script arrives as a file from the test, keyed by the participant address. A
// silent turn (an empty action list) is a legal scenario: the stall report is checked
// on it.
// A turn with a `block` field is a session that STALLED at the end of the turn:
// `{ waitingFor }` for a permission dialog, `{ limit }` for an exhausted limit.
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  HARNESS_HOME_VAR, claudeConfigDir, readSession, scriptFile, traceFile, writeSession,
} from './harness.mjs';

const argv = process.argv.slice(2);
const home = process.env[HARNESS_HOME_VAR];
const id = process.env.PROMPTOBUS_E2E_SESSION;
const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
const sessionId = process.env.CLAUDE_CODE_SESSION_ID;

function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// The prompt is always the last argument — `--mcp-config` and `--allowedTools` on the
// binary are variadic, and a positional after them would slide into their list
// (spawnArgv).
const prompt = argv[argv.length - 1];
const mcpConfigPath = argValue('--mcp-config');
const settingsPath = argValue('--settings');
const cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
const bus = cfg.mcpServers?.promptobus;
const address = bus?.env?.PROMPTOBUS_ROLE;
const task = bus?.env?.PROMPTOBUS_TASK;
const busHome = bus?.env?.PROMPTOBUS_HOME;
// The Stop-hook command is FROM THE PARTICIPANT SETTINGS FILE, the one that went out
// with the `--settings` flag
//. Building it here ourselves would mean testing the stand: the real
// harness runs what is written in the file, and from this task the record carries the
// participant identity as arguments. No record — no hook, and the turn simply ends:
// that is how a session lives that was not given a guard.
function guardCommand() {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const cmd = settings?.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    return typeof cmd === 'string' && cmd.trim() ? cmd : null;
  } catch {
    return null;
  }
}

let script = { turns: [] };
try {
  script = JSON.parse(readFileSync(scriptFile(home, address), 'utf8'));
} catch {
  // No script — the participant simply stays silent: that is a legal scenario, not a
  // stand breakage.
}

const trace = traceFile(home, address);
mkdirSync(path.dirname(trace), { recursive: true });

function note(entry) {
  try {
    appendFileSync(trace, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // The trace is test diagnosis, and a write failure is no reason to crash the
    // participant.
  }
}

// Session busy flag in the harness registry: `busy` while a turn is in progress, `idle`
// when it has been yielded. That is where the driver takes it from (`inspect` reads the
// `status` field), and the state machine takes it from the snapshot (`sessionBusy`).
function mark(patch) {
  const record = readSession(home, id);
  if (record) writeSession(home, { ...record, ...patch });
}

// --- MCP client ------------------------------------------------------------------

// The server is started ONCE for the participant's whole life, not per call: that is
// how Claude Code talks to it, and the server resolves process identity once, at start.
const mcp = spawn(bus.command, bus.args, {
  cwd: process.cwd(),
  env: { ...process.env, ...bus.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let seq = 0;
let buf = '';
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // A stray line on the protocol channel is the server's trouble, not the
      // participant's: we name it in the trace and live on, otherwise the test would
      // have no diagnosis at all.
      note({ kind: 'stray', line });
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
mcp.stderr.setEncoding('utf8');
mcp.stderr.on('data', (chunk) => note({ kind: 'mcp-stderr', text: String(chunk).trim() }));

function rpc(method, params) {
  const rid = (seq += 1);
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 30000);
    pending.set(rid, (m) => { clearTimeout(timer); resolve(m); });
  });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
  return answer;
}

function textOf(res) {
  return res?.result?.content?.map((c) => c.text).join('\n') ?? '';
}

// --- turn ------------------------------------------------------------------------

// A participant turn ends exactly the way a Claude Code session ends it, and the order
// here is not decorative: first the stall reason in `jobs/<id>/state.json` (the driver
// reads it), then the Stop hook, then the «idle» mark in the registry.
//
// The Stop hook is called with THE COMMAND FROM THE SETTINGS FILE and the participant's
// own environment — exactly as the harness calls it. Bus identity sits in the command
// itself as arguments, and the session environment no longer carries it: that
// environment comes from the daemon and belongs to a foreign spawn.
// So the guard works here too: the end-of-turn mark (`waits/<address>.turn.json`) is
// given to the participant as well, not only to the orchestrator. Its busy flag is
// still taken from the session snapshot — `sessionBusy` picks the branch by the
// participant kind, not by whether the mark exists.
//
// **A turn may end in a stall, not in idleness.** The turn's `block` field marks the
// record in the forms OBSERVED on a live harness ([15]),
// not in ones convenient for the stand:
//
//   - `{ waitingFor }` — the session stalled on a dialog. Live harness emits
//     `waitingFor` only with `status: "waiting"`, and the value there is a short label
//     (`permission prompt`, `sandbox request`, `input needed`), not the request text.
//     The state stays `working`: a dialog interrupts the turn, it does not end it —
//     and `sessionStall` looks at the label first, without asking the state;
//   - `{ limit }` — the limit is exhausted. The record here is no different from an
//     ordinary end of turn (`idle`/`done`, measurement ), and the limit is
//     visible only as the string the harness itself writes into `detail` of
//     `jobs/<id>/state.json` — that is where the parse reads it from.
//
// The stand never sets `state: blocked` anywhere: that pair was never seen on live
// harness background sessions, and a green on it would be a green on nothing — exactly
// the trouble  removed. The dialog mark is CLEARED on every next turn: a live
// session a person answered does not carry it.
function endTurn(detail, block = null) {
  const jobs = path.join(claudeConfigDir(home), 'jobs', String(id));
  mkdirSync(jobs, { recursive: true });
  writeFileSync(path.join(jobs, 'state.json'), JSON.stringify({ detail }, null, 2) + '\n');
  const command = guardCommand();
  if (!command) {
    note({ kind: 'guard', code: null, stdout: '', stderr: 'no Stop-hook record in the settings file' });
    mark(block?.waitingFor
      ? { status: 'waiting', state: 'working', waitingFor: block.waitingFor }
      : { status: 'idle', state: 'done', waitingFor: null });
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    // `shell: true` — because the settings file holds a STRING of the command, and the
    // shell parses it: that is how the real harness runs it, and the quotes around
    // paths are for it.
    const hook = spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    hook.stdout.on('data', (c) => { out += c; });
    hook.stderr.on('data', (c) => { err += c; });
    hook.on('close', (code) => {
      note({ kind: 'guard', code, stdout: out.trim(), stderr: err.trim() });
      // `idle`/`done` — what real Claude Code marks a session with after it has yielded
      // the turn: measurement 2026-09-02 on 2.1.251. The stand used to mark it
      // `blocked`, and the stub run was green on a state a live harness never emits.
      // Parsing that stall is the subject of : the report goes only on a SILENT
      // end of turn, and does not go after a message has been sent.
      mark(block?.waitingFor
        ? { status: 'waiting', state: 'working', waitingFor: block.waitingFor }
        : { status: 'idle', state: 'done', waitingFor: null });
      resolve(code);
    });
    hook.stdin.end(JSON.stringify({ session_id: sessionId, cwd: process.cwd() }));
  });
}

function git(args) {
  const r = spawnSync('git', ['-C', process.cwd(), '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

async function act(action) {
  // A pause inside the turn is not decoration. Store marks are laid down by warden
  // ticks: it notices a mailbox fetch on its own tick, and sees a send immediately. A
  // live session turn runs for seconds and minutes, and the mark order there is set
  // with slack; a turn collapsed into milliseconds breaks that order — `deliveredAt`
  // may land AFTER the send, and a normal end of turn would be read as silent
  // (`stallStands`). The pause gives the stand the scale of life, it does not bypass
  // the check.
  if (action.wait) {
    await new Promise((r) => { setTimeout(r, action.wait); });
    note({ kind: 'wait', ms: action.wait });
    return;
  }
  // An edit in the working tree: without it `promptobus review` returns on an empty
  // diff without starting a reviewer at all — that is, half the orchestration loop
  // would not be checked.
  if (action.write) {
    const file = path.join(process.cwd(), action.write.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, action.write.text);
    note({ kind: 'write', path: action.write.path });
    return;
  }
  // The commit is needed for cleanup: `promptobus done` only removes a proven-empty and
  // merged directory, and an uncommitted edit holds the worktree in place by
  // construction.
  if (action.commit) {
    const added = git(['add', '-A']);
    const made = git(['commit', '-m', action.commit.message, '-q']);
    note({ kind: 'commit', status: made.status, out: `${added.out}\n${made.out}`.trim() });
    return;
  }
  if (action.tool === 'promptobus_mailbox') {
    const res = await rpc('tools/call', { name: 'promptobus_mailbox', arguments: action.args ?? {} });
    note({ kind: 'mailbox', text: textOf(res), isError: res?.result?.isError === true });
    return;
  }
  if (action.tool === 'promptobus_send') {
    const res = await rpc('tools/call', { name: 'promptobus_send', arguments: action.args ?? {} });
    note({ kind: 'send', args: action.args, text: textOf(res), isError: res?.result?.isError === true });
    return;
  }
  if (action.tool === 'promptobus_task') {
    const res = await rpc('tools/call', { name: 'promptobus_task', arguments: action.args ?? {} });
    note({ kind: 'task', text: textOf(res), isError: res?.result?.isError === true });
    return;
  }
  note({ kind: 'unknown-action', action });
}

let turnNo = 0;
// Turns are played one at a time: a knock may arrive in the middle of a turn, and two
// overlapping turns would scramble the order of messages on the bus. The queue is a
// promise chain, one turn long.
let queue = Promise.resolve();

function playTurn(reason) {
  queue = queue.then(async () => {
    const turn = script.turns?.[turnNo] ?? null;
    const no = turnNo;
    turnNo += 1;
    mark({ status: 'busy', state: 'working', waitingFor: null });
    note({ kind: 'turn', no, reason, actions: (turn?.do ?? []).length });
    for (const action of turn?.do ?? []) {
      try {
        await act(action);
      } catch (e) {
        note({ kind: 'action-failed', action, error: e.message });
      }
    }
    // Stall reason: the turn's own, otherwise the common one. The string goes into
    // `detail` and from there into the stall parse — that is what a person will read in
    // the warden report. On a limit turn the reason IS the limit string: the parse
    // catches it with a template in the same `detail`.
    const block = turn?.block ?? null;
    await endTurn(block?.limit ?? turn?.detail ?? 'turn finished; awaiting next cycle', block);
  }).catch((e) => { note({ kind: 'turn-failed', error: e.message }); });
  return queue;
}

// --- socket ----------------------------------------------------------------------

// Driver wire: one connection, two lines of line-delimited JSON — auth and the
// injection itself. The token is CHECKED here in the trace, but the connection is not
// dropped: on macOS the real listener does not check it at all (`authRequired` is on
// only on Windows), and a refusal here would paint the stand red where the live
// channel works.
const server = createServer((conn) => {
  let data = '';
  conn.setEncoding('utf8');
  conn.on('data', (chunk) => { data += chunk; });
  conn.on('error', () => {});
  conn.on('end', () => {
    const lines = data.split('\n').filter((l) => l.trim());
    const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const auth = parsed[0];
    const injection = parsed[1];
    note({
      kind: 'knock',
      lines: lines.length,
      auth: auth?.type === 'auth',
      tokenOk: auth?.token === token,
      from: injection?.from ?? null,
      msgV: injection?.msgV ?? null,
      body: injection?.message?.content ?? null,
    });
    conn.destroy();
    // A connection without a second line is a `doctor` smoke: it does not touch a
    // foreign turn.
    if (injection) playTurn('knock');
  });
});

function farewell(code) {
  try { server.close(); } catch { /* already closed */ }
  try { rmSync(socketPath, { force: true }); } catch { /* the socket may not have existed */ }
  try { mcp.kill('SIGTERM'); } catch { /* the child is already dead */ }
  note({ kind: 'stopped', code });
  process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => farewell(sig));

server.listen(socketPath, async () => {
  note({ kind: 'up', address, task, home: busHome, socket: socketPath, prompt: (prompt ?? '').length });
  // The handshake is the same as Claude Code's: `initialize`, then a ready
  // notification. With it the participant also hands over its contact point (the
  // server's `onJoin`), and without it there would be nothing to wake it with.
  const hello = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'promptobus-e2e-participant', version: '1' },
  });
  note({ kind: 'initialize', protocol: hello?.result?.protocolVersion ?? null, server: hello?.result?.serverInfo?.name ?? null });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await playTurn('start');
});

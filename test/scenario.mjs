// E2E bus scenario — one for every lineup. Not a `*.test.mjs` — the runner (run.mjs)
// takes only those from the directory, so this file is never part of the run.
//
// **The caller declares the lineup, not the check.** Participants may have different
// harnesses — «orchestrator Claude Code, worker Cursor, reviewer Codex» — and the lineup
// used to be baked into the verdicts as the literal `'claude'`. Now `harness.at(address)`
// returns it, and what that does not name is taken from `harness` itself and from the
// `participantHarness` defaults below; the defaults repeat the old literals letter for
// letter, so runs with one harness for the whole lineup (stub Claude and the live
// canary) need no edits and keep the same verdict count.
//
// **A step the participant harness does not play is dropped by ITS declared capability**,
// not by the lineup name: checking «if the worker is Cursor» would mean keeping a second
// lineup list next to the first. There are four capabilities — `guard` (the participant
// calls the loop guard itself), `blocks` (a turn can stall on a permission dialog and on
// a limit), `stalls` (a participant stall is parsed by its driver in place, not by
// silence with a ceiling of minutes) and `files` (the harness writes the participant
// mcp-config as a file).
//
// The subject is the FULL orchestration loop, the one that until this task was assembled
// nowhere: spawn the worker → its first `status` → the orchestrator's `answer` → a
// warden knock on the participant socket → its `result` → `promptobus review` with a
// scripted reviewer → notes → a second `result` → a report of a SILENT end of turn →
// `promptobus done` with session teardown and worktree cleanup → `promptobus prune`. The
// mechanism in the loop is real throughout: CLI, the `claude` driver, the warden as a
// process, the bus MCP server, the task store, git. Only the harness binary is
// substituted, and the substitution sits on its boundary — the driver remains the
// subject under test.
//
// **The orchestrator in the scenario is the caller itself**: it holds its messaging
// socket (warden postcards arrive there), talks to the bus with a real `promptobus mcp`
// over stdio and calls `promptobus guard` at the end of its turns. There is no second
// mechanism for this — a live orchestrator session works the same way.
//
// **The verdict count is fixed.** A step that did not arrive gives a RED verdict and
// does not throw: a thrown exception would take the checks below with it, and the
// verdict count would diverge across runs — while the brief requires the opposite
// (three runs in a row with the same number). Hence `waitFor`, which returns the last
// probe instead of failing on timeout.
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Root of the mechanism under test. Unset — the checkout, and then the run goes exactly
// as it used to: `npm test` does not set this variable at all. Set — the whole mechanism
// is taken from there, one root: the binary, the store adapter, stall parse, the driver
// and the built package. A half resolve (binary from there, store from here) would check
// the installed tree against the checkout, and a divergence between them would stay
// invisible — and the canary exists exactly for that.
export const MECHANISM_ROOT = process.env.PROMPTOBUS_E2E_ROOT ?? path.join(here, '..');
export const PROMPTOBUS_BIN = path.join(MECHANISM_ROOT, 'bin', 'promptobus.js');

// The store is taken from the mechanism adapter — the same module the bus commands read
// it with. One door around it: the adapter does not re-export the reported-stalls mark
// (`stalls.json`), and the scenario takes it from the package directly. It does not
// start its own file read: the mark format is the store's business, not the test's.
export const store = await import(path.join(MECHANISM_ROOT, 'lib', 'store.js'));
const { readStalls, TICK_MS } = await import(path.join(MECHANISM_ROOT, 'dist', 'index.js'));
// Stall parse and the reason from `state.json` come from the mechanism, not from our
// own file read: the report must be checked with the same thing the warden uses.
const { stallStands } = await import(path.join(MECHANISM_ROOT, 'lib', 'status.js'));
const { claudeDriver, sessionDetail } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-claude.js'));

// Message-body markers. We check by CONTAINMENT, not equality: on the stub harness the
// body arrives letter for letter, on the live one the model writes it from the brief —
// and a verbatim requirement would test the model's obedience, not the bus loop.
export const MARK = {
  status: 'E2E-STATUS-1',
  answer: 'E2E-ANSWER-1',
  result1: 'E2E-RESULT-1',
  review: 'E2E-REVIEW-1',
  review2: 'E2E-REVIEW-2',
  order: 'E2E-ORDER-1',
  result2: 'E2E-RESULT-2',
  quiet: 'E2E-QUIET-1',
  perm: 'E2E-PERM-1',
  limit: 'E2E-LIMIT-1',
  fan: 'E2E-FAN-1',
};

const NOTE_FILE = 'e2e/note.md';

/**
 * Addresses of the loop participants. Exported for the caller: it checks ITS own stand
 * against them — the stub binary's trace, the session registry — and a private copy of
 * the string would drift from this one on the first rename.
 */
export const WORKER = 'worker:e2e';
export const REVIEWER = 'reviewer:e2e';

// A pause inside the participant turn is not decoration and not a round number. The
// «mailbox fetched» mark (`deliveredAt`) is laid not by the participant but by the
// warden TICK, and an `fs.watch` observer loses events that arrive during the tick —
// the next tick comes from a poll, after `TICK_MS`. A live session turn runs for
// seconds and minutes, and there the mark lands long before the send; a collapsed turn
// breaks the order: a 2026-09-02 measurement with a 400 ms pause gave `deliveredAt` 8 ms
// AFTER the send, and a normal end of turn would be read as silent (`stallStands`). So
// the pause is taken from the warden's own tick, not as a literal: raise the tick — and
// it grows too.
const TURN_PAUSE_MS = TICK_MS + 500;

/**
 * Role scripts — the only source both for the stub harness (it plays them literally)
 * and for the live one (its briefs are rendered from the `say` field). They have nowhere
 * to drift: there is one scenario, and both harnesses share the same checks.
 */
export const WORKER_SCRIPT = {
  turns: [
    {
      say: `On the first turn send the orchestrator a status message whose body starts with the line «${MARK.status}». Do nothing else and end the turn.`,
      detail: 'status sent; awaiting next cycle',
      do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK.status}: взял задание, приступаю` } }],
    },
    {
      say: `After a notification, fetch the mailbox, create ${NOTE_FILE} in your worktree with the line «${MARK.result1}», commit it, and send the orchestrator a result whose body starts with «${MARK.result1}». End the turn.`,
      detail: 'result sent; awaiting next cycle',
      do: [
        { tool: 'promptobus_mailbox' },
        { wait: TURN_PAUSE_MS },
        { write: { path: NOTE_FILE, text: `# ${MARK.result1}\n\nПравка worker'а сценария E2E.\n` } },
        { commit: { message: `: правка worker'а сценария E2E` } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.result1}: правка внесена и закоммичена` } },
      ],
    },
    {
      say: `After a notification with review notes, fetch the mailbox and send the orchestrator a result whose body starts with «${MARK.result2}». End the turn.`,
      detail: 'second result sent; awaiting next cycle',
      do: [
        { tool: 'promptobus_mailbox' },
        { wait: TURN_PAUSE_MS },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.result2}: замечание ревью закрыто` } },
      ],
    },
    {
      say: 'After the next notification, fetch the mailbox and do NOT send anything on the bus — just end the turn.',
      detail: 'nothing to report; awaiting next cycle',
      do: [{ tool: 'promptobus_mailbox' }],
    },
  ],
};

/**
 * Turns on which the participant STALLS — a stop on the permission dialog and on an
 * exhausted limit
 * . They are left out of `WORKER_SCRIPT` on purpose: that script
 * is shared with the live run, its `say` fields go into the participant brief, and a
 * live session cannot stall on command on either permission or a limit. So they have no
 * `say` at all, and the scenario attaches them only to the stub harness.
 *
 * Both parse branches (`sessionStall`) until now lived only on units with fixtures: no
 * one played them in E2E. The turn fetches the mailbox — otherwise unread mail would
 * hang and the warden would keep knocking the stalled participant on every tick.
 */
export const BLOCK_TURNS = [
  {
    detail: 'waiting for permission',
    // The label is short, from the observed live-harness set (`permission prompt`,
    // `sandbox request`, `input needed`), not the request text itself: `waitingFor`
    // carries exactly that label ([15]).
    block: { waitingFor: 'permission prompt' },
    do: [{ tool: 'promptobus_mailbox' }],
  },
  {
    // The limit string is the one the parse recognises it by: a session writes its own
    // reasons in its own words, and the template catches exactly this form («hit your …
    // limit»).
    block: { limit: "You've hit your usage limit — limit resets at 21:00" },
    do: [{ tool: 'promptobus_mailbox' }],
  },
];

export const REVIEWER_SCRIPT = {
  turns: [
    {
      say: `On the first turn send the orchestrator a result whose body starts with the line «${MARK.review}». Do nothing else and end the turn.`,
      detail: 'review sent; awaiting next cycle',
      do: [
        { tool: 'promptobus_mailbox' },
        { wait: TURN_PAUSE_MS },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.review}: замечание — в заголовке правки нет номера задачи` } },
      ],
    },
  ],
};

/**
 * Second review round: a new diff goes to an ALREADY STARTED reviewer as a `type=task`
 * message, and the same address parses it — the command does not start a second session
 * ([08]).
 *
 * The turn is attached to the reviewer script only where the caller asked for this
 * round (`reviewRounds: 2`) — the same trick as `BLOCK_TURNS`: runs with one round
 * still have one reviewer turn, and their verdict count does not move.
 */
export const REVIEW_ROUND_TURN = {
  say: `After a notification with a new diff, fetch the mailbox and send the orchestrator a result whose body starts with «${MARK.review2}». End the turn.`,
  detail: 'second review sent; awaiting next cycle',
  do: [
    { tool: 'promptobus_mailbox' },
    { wait: TURN_PAUSE_MS },
    { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.review2}: новый дифф проверен, прошлое замечание закрыто` } },
  ],
};

/** Role brief: a title and the turns in prose. The stub harness ignores it, the live one lives by it. */
export function briefText(title, script) {
  return `# ${title}\n\n`
    + 'You are a Promptobus bus participant in an E2E scenario. Do exactly what is said below, and nothing more.\n\n'
    + script.turns.map((t, i) => `${i + 1}. ${t.say}`).join('\n')
    + '\n';
}

// --- small helpers ---------------------------------------------------------------

export function git(cwd, ...args) {
  return spawnSync('git', ['-C', cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { encoding: 'utf8' });
}

/** One CLI command of the mechanism UNDER TEST — the binary `MECHANISM_ROOT` named. */
export function cli(args, { cwd, env }) {
  const r = spawnSync(process.execPath, [PROMPTOBUS_BIN, ...args], { cwd, env, encoding: 'utf8' });
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

// --- orchestrator MCP client -------------------------------------------------------

// The same transport Claude Code uses to talk to the bus server: line-delimited
// JSON-RPC over stdio, one long-lived process per session.
function startMcp(env, cwd) {
  const child = spawn(process.execPath, [PROMPTOBUS_BIN, 'mcp'], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const strays = [];
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
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        strays.push(line);
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  child.stderr.resume();
  const call = (method, params) => {
    const id = (seq += 1);
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 30000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return answer;
  };
  const tool = async (name, args = {}) => {
    const res = await call('tools/call', { name, arguments: args });
    return {
      text: res?.result?.content?.map((c) => c.text).join('\n') ?? '',
      isError: res?.result?.isError === true,
    };
  };
  return { call, tool, strays, stop: () => { child.stdin.end(); child.kill(); } };
}

// --- orchestrator socket -----------------------------------------------------------

// A real listener on a real socket: warden postcards arrive here on the same wire they
// arrive on in a live session — an auth line and then the injection JSON.
function startInbox(socketPath, token) {
  const seen = [];
  const server = createServer((conn) => {
    let data = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (c) => { data += c; });
    conn.on('end', () => {
      const parsed = data.split('\n').filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } });
      seen.push({
        auth: parsed[0]?.type === 'auth',
        tokenOk: parsed[0]?.token === token,
        from: parsed[1]?.from ?? null,
        msgV: parsed[1]?.msgV ?? null,
        body: parsed[1]?.message?.content ?? null,
      });
      conn.destroy();
    });
  });
  return {
    seen,
    listen: () => new Promise((res) => server.listen(socketPath, res)),
    close: () => new Promise((res) => server.close(res)),
  };
}

// --- stand -------------------------------------------------------------------------

/**
 * A workspace with its own clone: origin is a bare repository on disk, so `freshenRepo`
 * does a real `fetch origin` but never touches the network, and `createWorktree` creates
 * a real branch. There is no git mock in the scenario at all — `promptobus done` cleanup
 * judges by what git actually says.
 */
export function buildWorkspace(sandbox, { ns = 'loads_search', repo = 'cargos-api', root = null, tools = ['claude', 'cursor', 'codex'] } = {}) {
  // Standalone host: promptobus.json at the workspace root, clone on disk under that root.
  // Origin is a local bare repo so freshenRepo can fetch without the network.
  const ws = root ?? path.join(sandbox, 'ws');
  mkdirSync(ws, { recursive: true });
  if (!existsSync(path.join(ws, 'promptobus.json'))) {
    writeFileSync(path.join(ws, 'promptobus.json'), `${JSON.stringify({
      commandName: 'promptobus',
      tools,
    })}\n`);
  }
  if (!existsSync(path.join(ws, 'AGENTS.md'))) writeFileSync(path.join(ws, 'AGENTS.md'), 'workspace\n');

  const origin = path.join(sandbox, 'origin', `${repo}.git`);
  const seed = path.join(sandbox, 'seed');
  mkdirSync(origin, { recursive: true });
  mkdirSync(seed, { recursive: true });
  spawnSync('git', ['init', '--bare', '-b', 'main', origin], { encoding: 'utf8' });
  git(seed, 'init', '-b', 'main');
  writeFileSync(path.join(seed, 'AGENTS.md'), `Правила репозитория ${repo}.\n`);
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'init', '-q');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');

  const repoAbs = path.join(ws, repo);
  mkdirSync(path.dirname(repoAbs), { recursive: true });
  spawnSync('git', ['clone', '-q', origin, repoAbs], { encoding: 'utf8' });
  return { ws, repoAbs, repo, ns };
}

// --- the scenario itself -----------------------------------------------------------

/** Step names — the live-run report prints the same ones. */
export const STEPS = [
  'stand and warden',
  'spawn the worker',
  'first status and postcard to the orchestrator',
  'orchestrator answer',
  'warden knock and first result',
  'review and notes',
  'notes to the worker and second result',
  'report of a silent end of turn',
  'participant stall: permission (stub harness)',
  'participant stall: limit (stub harness)',
  'fan-out to two participants and artifact deduplication',
  'history, status and mailbox claim',
  'promptobus done: session teardown and cleanup',
  'promptobus prune and warden exit',
];

/**
 * Name of the second review-round step. It sits apart from `STEPS`, not in the list:
 * that list enumerates steps that run in EVERY run, and the live run prints its length
 * as a heading ([live-e2e.mjs](../scripts/live-e2e.mjs)) — promising a step the run does
 * not take means lying in the first line of the report.
 */
export const REVIEW_ROUND_STEP = 'second diff to the same reviewer';

/**
 * Harness of ONE participant: how to start it, how to ask about it and what it can
 * play.
 *
 * Three sources in descending strength: the field the lineup named for this address
 * (`harness.at`), the field on `harness` itself (a lineup of one harness — the old call
 * form) and the default here. Defaults are the old scenario literals: harness `claude`,
 * knock channel by socket, session snapshot from the shared `sessions()` and state
 * parse by the Claude driver.
 *
 * `flags` is the name of the start-flags field: `spawnFlags` for the worker,
 * `reviewFlags` for the reviewer. One field per role, because the command differs per
 * role too.
 */
function participantHarness(harness, address, flags) {
  const own = (typeof harness.at === 'function' ? harness.at(address) : null) ?? {};
  const pick = (name, fallback) => {
    if (own[name] !== undefined) return own[name];
    if (harness[name] !== undefined) return harness[name];
    return fallback;
  };
  const scripted = pick('scripted', false);
  const sessions = pick('sessions', () => []);
  return {
    id: pick('id', 'claude'),
    scripted,
    // The loop guard is called by the participant itself: on stub Claude that is
    // [participant.mjs](participant.mjs), on Cursor — the `stop` hook from the project
    // `.cursor/hooks.json`. Codex has no hooks at all — neither an end-of-turn event nor
    // a file to put it in — and it will have no end-of-turn mark on any turn.
    guard: pick('guard', scripted),
    // A turn that stalls on command exists only on stub `claude`: it is the only one
    // that understands a `block` field on a turn ([participant.mjs](participant.mjs)),
    // and a live session cannot be given a permission request or an exhausted limit at
    // all.
    blocks: pick('blocks', scripted),
    // A silent end of turn is checked by the REASON the session wrote about itself —
    // the `detail` string from the Claude daemon's `jobs/<id>/state.json`: the reported
    // mark in `stalls.json` must belong to it, otherwise the report is counted for the
    // wrong turn. On Cursor the end of turn arrives as `turn_ended` and the `stop` hook,
    // on Codex as the `turn/start` reply, and neither has a reason string: there is
    // nothing to check the report against there.
    stalls: pick('stalls', true),
    // Participant mcp-config as a FILE on the store path (`participantMcpPath`): that
    // is how Claude Code gets it. Cursor reads the project `.cursor/mcp.json` of its
    // working directory, Codex gets servers as a field of the start request — neither
    // has a store file at all.
    files: pick('files', true),
    flags: pick(flags, []),
    plan: (script) => pick('plan', () => {})(address, script),
    liveSessions: (refs) => pick('liveSessions', () => [])(refs),
    pidsOf: (refs) => pick('pidsOf', () => [])(refs),
    pidAlive: pick('pidAlive', () => false),
    diagnose: () => pick('diagnose', () => '')(address),
    // A yielded turn. Asked of the harness, not derived from a snapshot here: «idle» on
    // the Claude registry is `status: idle`, on a Cursor persist session it is a pane
    // without an in-progress turn marker, and one scenario line would otherwise mean
    // different things across lineups.
    idle: (ref) => (own.idle ? own.idle(ref) : sessions().find((x) => x.name === ref)?.status === 'idle'),
    // The session snapshot is given to the driver EXPLICITLY: the parse default would
    // assemble it through the registry cache, and the same call would check different
    // things on different harnesses.
    inspect: (ref) => (own.inspect ? own.inspect(ref) : claudeDriver.inspect(ref, sessions())),
  };
}

/**
 * Run the scenario. `harness` gives two things the scenario cannot have: a binary
 * substitution (or its absence) and a way to ask whether participant sessions are
 * alive.
 *
 * `check(name, cond, detail)` is the caller's verdict: under the suite that is the
 * [check.mjs](check.mjs) helper, in a live run — its own report collector.
 */
export async function runScenario({
  check, harness, sandbox, workspace = null, timeouts = {}, trace = () => {}, reviewRounds = 1,
}) {
  const step = timeouts.step ?? 30000;
  const stall = timeouts.stall ?? 75000;
  const ORCH_SESSION = `orch-${process.pid}`;
  const TASK = 'e2ebus-t20260901-000000';
  const wh = participantHarness(harness, WORKER, 'spawnFlags');
  const rh = participantHarness(harness, REVIEWER, 'reviewFlags');

  const { ws, repoAbs, repo } = buildWorkspace(sandbox, { root: workspace });
  const home = path.join(ws, '.promptobus');
  const workerBrief = path.join(sandbox, 'worker-brief.md');
  const reviewerBrief = path.join(sandbox, 'reviewer-brief.md');
  const reviewerScript = reviewRounds >= 2
    ? { ...REVIEWER_SCRIPT, turns: [...REVIEWER_SCRIPT.turns, REVIEW_ROUND_TURN] }
    : REVIEWER_SCRIPT;
  writeFileSync(workerBrief, briefText('E2E orchestration loop', WORKER_SCRIPT));
  writeFileSync(reviewerBrief, briefText('E2E loop review', reviewerScript));
  // Stall turns are attached ONLY to the harness that plays them, and only to the
  // script, not to the brief: the brief is built from `WORKER_SCRIPT`, and a live
  // session cannot play these turns
  //. The second review round uses the same trick: the
  // turn appears on the reviewer exactly where the caller asked for this round.
  wh.plan(wh.blocks
    ? { ...WORKER_SCRIPT, turns: [...WORKER_SCRIPT.turns, ...BLOCK_TURNS] }
    : WORKER_SCRIPT);
  rh.plan(reviewerScript);

  // Orchestrator contact point — on a real socket. The shared hygiene list strips
  // `CLAUDE_CODE_MESSAGING_*` from the run on purpose (a live person's foreign socket),
  // and here they appear again — but already with the stand's own socket, not a
  // person's.
  const orchSock = harness.sock('orchestrator');
  const orchToken = 'e2e-orchestrator-token';
  const inbox = startInbox(orchSock, orchToken);
  await inbox.listen();

  const orchEnv = {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: ORCH_SESSION,
    CLAUDE_CODE_MESSAGING_SOCKET: orchSock,
    CLAUDE_CODE_MESSAGING_TOKEN: orchToken,
    PROMPTOBUS_HOME: home,
  };
  // The warden does not need the orchestrator identity and it is harmful: its own
  // launcher strips the parent's contact point for the same reason.
  const wardenEnv = { ...process.env, PROMPTOBUS_HOME: home };
  delete wardenEnv.CLAUDE_CODE_MESSAGING_SOCKET;
  delete wardenEnv.CLAUDE_CODE_MESSAGING_TOKEN;

  // The task is created before the warden: it refuses to watch a missing one, and it
  // needs to be up early for the stall report — that comes on a heartbeat, once every
  // 30 s, and the time until the first beat the scenario spends on work, not on
  // waiting.
  store.createTask(home, { id: TASK, title: 'круг оркестрации E2E', owner: ORCH_SESSION });

  const wardenLog = path.join(sandbox, 'warden.out');
  const warden = spawn(process.execPath, [PROMPTOBUS_BIN, 'warden', '--task', TASK], {
    cwd: ws,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: wardenEnv,
  });
  // Write under a catch: Node itself calls the event handler, and an exception thrown
  // from it becomes unhandled — and by then the sandbox may lawfully already be gone
  // (the live run cleans it up itself, the warden is still appending its tail).
  const keep = (c) => { try { appendFileSync(wardenLog, c); } catch { /* the sandbox is already gone */ } };
  warden.stdout.on('data', keep);
  warden.stderr.on('data', keep);

  const mcp = startMcp(orchEnv, ws);
  // The orchestrator contact point is handed over by this handshake (the server's
  // `onJoin`): a separate tool call for it is no longer needed. Previously
  // `promptobus_task` sat here right after `initialize` — a prop without which step 3
  // waited for the first postcard in vain.
  await mcp.call('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'promptobus-e2e-orchestrator', version: '1' },
  });

  // End of the orchestrator turn — the same guard the harness marks it with.
  const orchGuard = () => spawnSync(process.execPath, [PROMPTOBUS_BIN, 'guard'], {
    cwd: ws,
    env: orchEnv,
    input: JSON.stringify({ session_id: ORCH_SESSION, cwd: ws }),
    encoding: 'utf8',
  });

  const inboxOf = (addr) => store.glanceInbox(home, TASK, addr);
  const msgOf = (addr, mark) => inboxOf(addr).find((m) => String(m.body ?? '').includes(mark)) ?? null;
  // Protocol v1 canon carries the sender participant ID; the mechanism address is
  // assembled from it with the same translation the door writes.
  const sentBy = (m, addr) => m?.sender === store.addrDir(addr);
  const participantOf = (addr) => store.participantOf(store.readTask(home, TASK), addr);
  // Mechanism fields (worktree, branch, repository) sit in the v1 record `metadata`;
  // the record's own fields are role, harness, mode, session reference and a
  // capabilities snapshot.
  const fieldsOf = (addr) => participantOf(addr)?.metadata ?? {};
  const healthOf = (addr) => (store.readHealth(home, TASK) ?? {})[addr] ?? {};
  const postcard = (mark) => inbox.seen.find((p) => String(p.body ?? '').includes(mark)) ?? null;
  const timings = [];
  const at = (name, ms) => { timings.push({ name, ms }); trace(`${name}: ${(ms / 1000).toFixed(1)} s`); };
  // What the run actually went with — by the word of the started process. Goes into the
  // report: the canary checks it against its install tree, and the scenario has nowhere
  // to know where «correct» is.
  let selfBin = null;

  const t0 = Date.now();
  try {
    // --- step 1: stand and warden ---------------------------------------------------
    const live = await waitFor(() => store.liveWarden(home, TASK), { timeoutMs: step });
    check('step 1: the task warden is up as a real process',
      !!live?.pid, `${JSON.stringify(live)} · ${readSafe(wardenLog)}`);
    at(STEPS[0], Date.now() - t0);

    // --- step 2: spawn the worker ---------------------------------------------------
    const t2 = Date.now();
    const spawned = cli([ 'spawn', '--repo', repo, '--brief', workerBrief, '--task', TASK,
      '--worker', 'e2e', ...wh.flags], { cwd: ws, env: orchEnv });
    check('step 2: promptobus spawn started the worker and said so',
      spawned.status === 0 && /worker worker:e2e поднят/.test(spawned.out), tail(spawned.out));
    const wp = participantOf(WORKER);
    const wf = fieldsOf(WORKER);
    // The record harness is checked against WHAT the lineup named, not a literal: in a
    // mixed lineup the worker is started by its own driver, and a baked-in name would
    // test the lineup, not the record. The capabilities snapshot does not depend on the
    // lineup — all three drivers declare delivery into a live session and teardown, and
    // a participant without that is not a participant at all.
    check('step 2: the participant record carries harness, mode, a session reference and a capabilities snapshot',
      wp?.harness === wh.id && wp?.mode === 'managed' && typeof wp?.sessionRef === 'string'
      && wp?.capabilities?.stop === true && wp?.capabilities?.activation === 'push', JSON.stringify(wp));
    check('step 2: the harness started a live worker session, not a record of one',
      wh.liveSessions([wp?.sessionRef]).length === 1, wh.diagnose());
    check('step 2: the worker worktree is created on its own branch',
      !!wf.worktree && existsSync(wf.worktree)
      && out(git(wf.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')) === wf.branch,
      `${wf.worktree} · ${out(git(wf.worktree ?? ws, 'rev-parse', '--abbrev-ref', 'HEAD'))}`);
    // Which mechanism the run is going with is said by the started process itself, not
    // by a path resolve in this file: `promptobus spawn` writes the participant
    // mcp-config, and the binary path in it is ITS OWN, taken from the running module
    // (`PROMPTOBUS_BIN` in [util.js](../lib/util.js)). A resolve here would check
    // intent, this line is a fact. The canary checks the same path against its install
    // tree and takes it from the report: the scenario has nowhere to know where
    // «correct» is.
    // ONE field is read: the rest hold substituted tokens of canonical servers.
    //
    // The verdict runs on a harness that gets mcp-config as a FILE on the store path:
    // on Cursor the same binary path sits in the project `.cursor/mcp.json` of the
    // participant working directory, on Codex — in the start-request fields, and the
    // store sees neither. Reading them with our own resolve would mean a second home
    // for the same question.
    if (wh.files) {
      selfBin = readSelfBin(store.participantMcpPath(home, TASK, WORKER));
      check('step 2: the participant mcp-config was written by the binary of the tree under test — the process itself named the path',
        !!selfBin && samePath(selfBin, PROMPTOBUS_BIN), `${selfBin} · expected ${PROMPTOBUS_BIN}`);
    }
    at(STEPS[1], Date.now() - t2);

    // --- step 3: first status and postcard ------------------------------------------
    const t3 = Date.now();
    const status = await waitFor(() => msgOf(store.ORCHESTRATOR, MARK.status), { timeoutMs: step });
    check('step 3: the first worker status landed in the orchestrator mailbox',
      sentBy(status, WORKER) && status?.type === 'status', JSON.stringify(status));
    const card = await waitFor(() => postcard(MARK.status), { timeoutMs: step });
    check('step 3: the warden woke the orchestrator with a postcard carrying the message text itself',
      card?.auth === true && card?.tokenOk === true && card?.msgV === 1 && card?.from === 'promptobus-warden',
      JSON.stringify(inbox.seen));
    check('step 3: orchestrator health names the channel as a socket and counts knocks',
      healthOf(store.ORCHESTRATOR).channel === 'socket' && (healthOf(store.ORCHESTRATOR).knocks ?? 0) >= 1,
      JSON.stringify(healthOf(store.ORCHESTRATOR)));
    at(STEPS[2], Date.now() - t3);

    // --- step 4: orchestrator answer ------------------------------------------------
    const t4 = Date.now();
    const box = await mcp.tool('promptobus_mailbox');
    check('step 4: the orchestrator mailbox via a real tool returned the worker message',
      box.isError === false && box.text.includes(MARK.status), tail(box.text));
    const sent = await mcp.tool('promptobus_send', { to: WORKER, type: 'answer', body: `${MARK.answer}: правь только ${NOTE_FILE}` });
    check('step 4: the orchestrator answer went to the worker',
      sent.isError === false && !!msgOf(WORKER, MARK.answer), `${tail(sent.text)} · ${JSON.stringify(inboxOf(WORKER))}`);
    const guarded = orchGuard();
    check('step 4: the loop guard released the orchestrator turn and marked its end',
      guarded.status === 0 && !!store.lastTurnAt(home, TASK, store.ORCHESTRATOR),
      `exit ${guarded.status}: ${tail(`${guarded.stdout}${guarded.stderr}`)}`);
    // : bus identity now also sits in the participant session's OWN
    // environment, so the loop-guard Stop hook resolves its address and sets the
    // end-of-turn mark — previously only the orchestrator got it. The participant busy
    // flag is still taken from the session snapshot: it has a session reference, and
    // `sessionBusy` picks the branch by the participant KIND, not by whether the mark
    // exists.
    //
    // The verdict runs where the participant ITSELF calls the loop guard, and that is
    // about the method, not the mechanism: stub `claude` calls `promptobus guard` from
    // the turn ([participant.mjs](participant.mjs)), a Cursor participant — via the
    // `stop` hook of its project `.cursor/hooks.json`, and both check exactly what the
    // mechanism is responsible for: that the identity is enough for the hook. On live
    // Claude the hook arrives as a `--settings` file, but the canary has not run that
    // yet, and Codex has no hooks at all — and the scenario does not go red on the
    // untested and the nonexistent
    // ([10], coverage boundary).
    if (wh.guard) {
      const workerTurn = await waitFor(() => store.lastTurnAt(home, TASK, WORKER), { timeoutMs: step });
      check('step 4: the loop guard marked the end of the turn on the worker too — bus identity is enough for it',
        workerTurn !== null, `${workerTurn} · ${wh.diagnose()}`);
    }
    at(STEPS[3], Date.now() - t4);

    // --- step 5: knock and first result ---------------------------------------------
    const t5 = Date.now();
    // Sign of a successful knock — the channel and the «knocked as far as» mark: a
    // fetched mailbox zeroes the knock counter together with the other wait marks, and
    // the counter can judge a knock only before the fetch, that is in a race with the
    // participant itself.
    //
    // What is checked is the FACT of delivery, not the channel NAME in health. That
    // name is the mechanism's word about a successful activation, and it does not
    // belong to the scenario: the warden writes it on any driver that wakes itself
    // (`supervisor.ts`, the `r?.ok` branch), and lineups have different transports
    // behind it — a TUI injection on Cursor, holder RPC on Codex. The pair «there is a
    // `knockedTo` mark, there is no knock error» keeps the verdict equally strong on
    // all: a failed knock writes the reason into `knockError` and puts the participant
    // on self-wake, and a driver without a knock leaves no mark at all.
    const knocked = await waitFor(() => {
      const h = healthOf(WORKER);
      return h.knockedTo && !h.knockError ? h : null;
    }, { timeoutMs: step });
    check('step 5: the warden reached the worker on its channel and remembered how far it knocked',
      !!knocked?.knockedTo && !knocked?.knockError,
      JSON.stringify(healthOf(WORKER)));
    const result1 = await waitFor(() => msgOf(store.ORCHESTRATOR, MARK.result1), { timeoutMs: step });
    check('step 5: the worker fetched the mailbox on the knock and sent the first result',
      sentBy(result1, WORKER) && result1?.type === 'result'
      && inboxOf(WORKER).length === 0, `${JSON.stringify(result1)} · ${wh.diagnose()}`);
    check('step 5: the worker edit is committed on its branch — cleanup will have something to check',
      out(git(wf.worktree, 'status', '--porcelain')) === '' && existsSync(path.join(wf.worktree, NOTE_FILE)),
      `${out(git(wf.worktree, 'status', '--porcelain'))} · ${out(git(wf.worktree, 'log', '--oneline', '-3'))}`);
    at(STEPS[4], Date.now() - t5);

    // --- step 6: review -------------------------------------------------------------
    const t6 = Date.now();
    await mcp.tool('promptobus_mailbox');
    orchGuard();
    const reviewed = cli([ 'review', wf.worktree, '--task', TASK, ...rh.flags],
      { cwd: ws, env: orchEnv });
    check('step 6: promptobus review started the reviewer from the worker worktree',
      reviewed.status === 0 && /reviewer reviewer:e2e поднят/.test(reviewed.out), tail(reviewed.out));
    const rp = participantOf(REVIEWER);
    check('step 6: the reviewer record landed in the same registry — harness, mode and a live session',
      rp?.harness === rh.id && rp?.mode === 'managed'
      && rh.liveSessions([rp?.sessionRef]).length === 1, `${JSON.stringify(rp)} · ${rh.diagnose()}`);
    // There is nothing to check the reviewer report body against, and that is not a
    // relaxation: `promptobus review` takes no brief at all — the command itself builds
    // the reviewer prompt, and it is the command that tells it to report `type=result`
    // to the orchestrator. So a live harness has its own text, and the property under
    // test is that the report came from the reviewer address and with the type the
    // mechanism assigned.
    const review = await waitFor(() => inboxOf(store.ORCHESTRATOR)
      .find((m) => sentBy(m, REVIEWER) && m.type === 'result') ?? null, { timeoutMs: step });
    check('step 6: the reviewer sent notes to the orchestrator',
      sentBy(review, REVIEWER) && review?.type === 'result',
      `${JSON.stringify(review)} · ${rh.diagnose()}`);
    at(STEPS[5], Date.now() - t6);

    // --- step 7: notes to the worker and second result ------------------------------
    const t7 = Date.now();
    await mcp.tool('promptobus_mailbox');
    const order = await mcp.tool('promptobus_send', { to: WORKER, type: 'review', body: `${MARK.order}: замечание reviewer'а — закрой его` });
    check('step 7: the notes went to the worker as a review message',
      order.isError === false && msgOf(WORKER, MARK.order)?.type === 'review', tail(order.text));
    orchGuard();
    const result2 = await waitFor(() => msgOf(store.ORCHESTRATOR, MARK.result2), { timeoutMs: step });
    check('step 7: the worker closed the note and sent a second result',
      sentBy(result2, WORKER) && result2?.type === 'result',
      `${JSON.stringify(result2)} · ${wh.diagnose()}`);
    // We check with a PREDICATE, not with an empty `stalls.json`: only the report tick
    // on a heartbeat writes the reported mark, and by this step there has been no beat
    // yet — an empty file would mean «nobody has scored any turns», and the verdict
    // would pass on any breakage (review note).
    //
    // The turn does not end with the send: next come the `state.json` write, a separate
    // guard process and only then the «idle» mark. While the session is `busy`, stall
    // parse returns `null`, and a green verdict would mean not «the silence gate
    // worked» but «the parse never reached it» — the same race from the other side. So
    // the yielded turn is waited for explicitly, and its sign goes into the verdict
    // detail: a green without it is not auditable.
    const ref = wp?.sessionRef;
    const idleAfterSend = await waitFor(() => wh.idle(ref) || null, { timeoutMs: step });
    // The snapshot is taken from the harness and given to the driver EXPLICITLY. The
    // parse default would assemble it through the session-registry cache: under the
    // suite this is the first call in the process and the snapshot is fresh by
    // accident, and in a live run the cache is already filled by this step — one
    // scenario line would check different things on two harnesses, against the promise
    // «harnesses differ, not the checks».
    const viewAfterSend = wh.inspect(ref);
    // The predicate is called directly, not through participant parse: that one also
    // has a registration window (`justSpawned`) on top of silence, and in a fast
    // scenario a participant inside it — an empty list would again be green for the
    // wrong reason.
    const stands = stallStands(home, TASK, participantOf(WORKER), viewAfterSend?.stall);
    check('step 7: a participant that finished a turn AFTER a send is not counted as stalled',
      idleAfterSend === true && viewAfterSend?.stall?.kind === 'unknown' && stands === false,
      `turn yielded: ${idleAfterSend} · snapshot ${JSON.stringify(viewAfterSend)} · predicate ${stands}`);

    // --- two participants of one task: each with its own --------------------------
    //
    // By this point both have finished a turn — the worker and the reviewer — so both
    // handed over a contact point and both called the Stop hook. What is checked is
    // what until  was missing: that the second did not take the first's
    // place. The harness hands a background session the environment of the FIRST spawn
    // of the run (the daemon model in [harness.mjs](harness.mjs)), so hook identity
    // rides as arguments of its command, and a foreign record does not move an address
    // the journal already pinned to another session.
    const heldBy = (addr) => store.readWake(home, TASK, addr)?.session ?? null;
    // Asked by THE SAME rule the mechanism uses (`foreignSessionOf`), not by our own
    // check: a private one would count by the short id, that is the fallback rule, and
    // a regression of the full `sessionId` on the participant record would not go red
    // at all (review note).
    const foreign = (addr) => store.foreignSessionOf(participantOf(addr), heldBy(addr));
    const own = await waitFor(() => (heldBy(WORKER) !== null && heldBy(REVIEWER) !== null
      && foreign(WORKER) === null && foreign(REVIEWER) === null) || null, { timeoutMs: step });
    check('step 7: the worker and reviewer contact points are each held by their own session',
      own === true,
      `worker: ${heldBy(WORKER)} vs ${JSON.stringify(participantOf(WORKER)?.metadata ?? null)}`
      + ` · reviewer: ${heldBy(REVIEWER)} vs ${JSON.stringify(participantOf(REVIEWER)?.metadata ?? null)}`);
    // The guard sets the end-of-turn mark, and the participant ITSELF must call it
    // ([10], coverage boundary) — so the verdict sits under
    // the same gate as the neighbouring verdict , and BOTH sit under it: the
    // subject here is that the second did not take the first's place, and one marked
    // participant says nothing about the pair. It is also the target of the main
    // mutation probe: put environment first in `guard` — the reviewer hook will mark
    // the worker address, and its own will stay unmarked.
    if (wh.guard && rh.guard) {
      const marked = await waitFor(() => (store.lastTurnAt(home, TASK, WORKER) !== null
        && store.lastTurnAt(home, TASK, REVIEWER) !== null) || null, { timeoutMs: step });
      check('step 7: each participant guard marked the end of the turn on ITS OWN address',
        marked === true,
        `worker ${store.lastTurnAt(home, TASK, WORKER)} · reviewer ${store.lastTurnAt(home, TASK, REVIEWER)}`
        + ` · ${rh.diagnose()}`);
    }
    at(STEPS[6], Date.now() - t7);

    // --- second review round: the same reviewer, a new diff ---------------------
    //
    // The round runs where the caller asked for it: runs with one round have none of
    // these verdicts at all, and their count does not move. The subject is the
    // command's promise: a repeated `promptobus review` does NOT start a second
    // session, and sends the new diff to the already started address ([08]).
    //
    // No new edit is needed for this: the diff is counted against the base, not against
    // the previous diff, and the worker edit from step 5 is still in it. The command
    // itself creates the second diff file (`review-<slug>-2.diff`).
    if (reviewRounds >= 2) {
      const t7b = Date.now();
      await mcp.tool('promptobus_mailbox');
      orchGuard();
      const again = cli([ 'review', wf.worktree, '--task', TASK, ...rh.flags],
        { cwd: ws, env: orchEnv });
      // Session identity is checked by its REFERENCE, not by a participant count: there
      // is one reviewer address per task, and a second start would rewrite the record
      // leaving the list the same length.
      const same = participantOf(REVIEWER);
      check('second round: the diff went to THE SAME reviewer — no second session appeared',
        again.status === 0 && /уже на шине/.test(again.out)
        && !!same?.sessionRef && same.sessionRef === rp?.sessionRef,
        `exit ${again.status} · session was ${rp?.sessionRef}, became ${same?.sessionRef} · ${tail(again.out)}`);
      const review2 = await waitFor(() => msgOf(store.ORCHESTRATOR, MARK.review2), { timeoutMs: step });
      check('second round: the reviewer parsed the new diff and sent a result',
        sentBy(review2, REVIEWER) && review2?.type === 'result',
        `${JSON.stringify(review2)} · ${rh.diagnose()}`);
      at(REVIEW_ROUND_STEP, Date.now() - t7b);
    }

    // --- step 8: silent end of turn -------------------------------------------------
    //
    // The step runs on a harness whose driver names the end-of-turn reason as a string
    // of the session itself: the last verdict checks the reported mark (`stalls.json`)
    // against that string, and without it there is nothing to check the report against
    // (see the `stalls` capability on `participantHarness`).
    if (wh.stalls) {
      const t8 = Date.now();
      await mcp.tool('promptobus_mailbox');
      // We wait for a NEW delivery mark, not merely a non-empty one: `deliveredAt` has
      // been sitting there since the previous turn, and the condition «mailbox empty
      // and the mark is there» is already true before the participant has seen this
      // order. Checking silence against the old mark would mean checking the previous
      // turn.
      //
      // The stamp is taken BEFORE the send, not after the guard. The mark is laid by
      // the warden tick that saw the mailbox already fetched, and the whole path
      // «knock → fetch → tick» fits in a second and a half, while `orchGuard` is a
      // process start: on a loaded machine it returns AFTER the tick, and a stamp
      // after it is newer than the mark we are waiting for. Then the wait takes the
      // ceiling by construction — there will be no new mark — and the red verdict
      // talks about its own stamp, not about participant silence. Live case
      // 2026-09-02: at load average 87 every run failed this way, under ordinary
      // load — none.
      const quietAt = Date.now();
      await mcp.tool('promptobus_send', { to: WORKER, type: 'answer', body: `${MARK.quiet}: ничего не отправляй, просто закончи ход` });
      orchGuard();
      const quiet = await waitFor(() => {
        const h = healthOf(WORKER);
        return h.unread === 0 && Date.parse(h.deliveredAt ?? '') > quietAt ? h : null;
      }, { timeoutMs: step });
      // Silence is counted the same way the mechanism counts it: the participant's last
      // send is older than its last activation (`stallStands`). Checking «there is no
      // message with such-and-such a marker» would be weaker — a participant that
      // answered with ANY text would pass that check and drag a red report with it,
      // explaining nothing.
      const lastSent = store.lastSentAt(home, TASK, WORKER);
      const spoke = lastSent !== null && lastSent > Date.parse(quiet?.deliveredAt ?? '');
      check('step 8: the worker fetched the mailbox and ended the turn without sending anything',
        !!quiet?.deliveredAt && !spoke,
        `${JSON.stringify(quiet)} · last send ${lastSent ? new Date(lastSent).toISOString() : 'none'}`
        + ` · ${wh.diagnose()}`);
      // Second stall-parse channel — the orchestrator `mailbox` reply: it is scored in
      // place, not on a heartbeat, and so is checked before the report.
      const seenByMailbox = await waitFor(async () => {
        const answer = await mcp.tool('promptobus_mailbox');
        return answer.text.includes(WORKER) && /встал|ЧИСЛИТСЯ|ИСЧЕЗ/.test(answer.text) ? answer.text : null;
      }, { timeoutMs: step, stepMs: 500 });
      check('step 8: the orchestrator mailbox reply names the stalled worker by the same parse',
        typeof seenByMailbox === 'string', `${tail(String(seenByMailbox))} · ${wh.diagnose()}`);
      const reported = await waitFor(() => {
        const line = store.tailWardenLog(home, TASK, 40).find((l) => l.includes(WORKER) && /встал:|ИСЧЕЗ|ЧИСЛИТСЯ|ГЛУХ/.test(l));
        return line ?? null;
      }, { timeoutMs: stall, stepMs: 500 });
      const stallPostcard = inbox.seen.find((p) => /встали участники/.test(String(p.body ?? '')));
      check('step 8: the warden wrote the stall into the log — it does not send a stall postcard',
        typeof reported === 'string' && reported.includes(WORKER) && !stallPostcard,
        `${reported} · ${JSON.stringify(inbox.seen.map((p) => String(p.body).slice(0, 60)))} · ${wh.diagnose()}`);
      // The reported mark is checked not by the fact of its existence, but by the
      // REASON: it must belong to the silent turn — the same string the session wrote
      // about itself in `jobs/<id>/state.json` on the last turn. A report about a turn
      // that ended with a send would have the previous turn's reason there, and «there
      // was no report on turns after a send» becomes a consequence of this check, not a
      // separate promise.
      const marks = readStalls(home, TASK) ?? {};
      const said = sessionDetail(fieldsOf(WORKER).session);
      check('step 8: the registration window did not mute the report — the participant had already been on the bus',
        store.lastSentAt(home, TASK, WORKER) !== null && !!reported,
        `last send ${new Date(store.lastSentAt(home, TASK, WORKER) ?? 0).toISOString()}`
        + ` · report ${reported ? 'present' : 'absent'}`);
      check('step 8: the report is marked in stalls.json with the silent-turn reason — it will not go a second time',
        Object.keys(marks).join(',') === WORKER
        && !!said && String(marks[WORKER]?.reason ?? '').endsWith(`|${said}`),
        `${JSON.stringify(marks)} · session detail: ${said}`);
      at(STEPS[7], Date.now() - t8);
    }

    // --- steps 9 and 10: participant stall, permission and limit --------------------
    //
    // Both stall-parse branches (`sessionStall`) until  lived only on units with
    // fixtures: no one played them in E2E, and a live session cannot be given a
    // permission request or a limit on command. So the steps run ONLY on a harness that
    // plays such a turn: stub `claude` understands the `block` field, and it marks the
    // session record the same way the real one does.
    //
    // The verdict is taken from the orchestrator `promptobus_mailbox` reply, not from a
    // warden postcard: the stalled-participant line is one for all channels
    // (`stallLine`/`stallRoute`), but the `mailbox` reply is scored in place, and the
    // report would come on a heartbeat — 30 s per step.
    if (wh.blocks) {
      // One helper for both steps: wake the participant, wait for its stall in the
      // snapshot and read the route from the `mailbox` reply. The difference between
      // the steps is only in what the participant stalled on and what the mechanism
      // must say about it.
      const stallStep = async (mark, order, want) => {
        await mcp.tool('promptobus_mailbox');
        await mcp.tool('promptobus_send', { to: WORKER, type: 'answer', body: `${mark}: ${order}` });
        orchGuard();
        // The snapshot is taken from the harness and given to the driver explicitly —
        // the same seam as on step 7: the default would assemble it through the
        // session-registry cache, and the same call would check different things on two
        // harnesses.
        const view = await waitFor(() => {
          const v = wh.inspect(participantOf(WORKER)?.sessionRef);
          return v?.stall?.kind === want.kind ? v : null;
        }, { timeoutMs: step });
        // The route is looked up in the `mailbox` reply by repeated calls: the
        // participant stalls at the end of its turn, and the first reply lawfully
        // arrives before it has stalled.
        const said = await waitFor(async () => {
          const answer = await mcp.tool('promptobus_mailbox');
          return want.route.test(answer.text) ? answer.text : null;
        }, { timeoutMs: step, stepMs: 500 });
        return { view, said };
      };

      const t9 = Date.now();
      const perm = await stallStep(MARK.perm, 'stop on the permission dialog', {
        kind: 'permission', route: /only a person can answer: claude attach/,
      });
      check('step 9: a participant stall on the permission dialog is parsed as permission — the dialog label is the reason',
        perm.view?.stall?.kind === 'permission' && perm.view.stall.reason === 'permission prompt',
        `${JSON.stringify(perm.view)} · ${wh.diagnose()}`);
      check('step 9: the report route leads to a person — only they can answer, claude attach',
        typeof perm.said === 'string' && perm.said.includes(WORKER)
        && /only a person can answer: claude attach/.test(perm.said),
        `${tail(String(perm.said))} · ${wh.diagnose()}`);
      at(STEPS[8], Date.now() - t9);

      const t10 = Date.now();
      const limit = await stallStep(MARK.limit, 'hit the limit', {
        kind: 'limit', route: /the limit resets on its own/,
      });
      // The limit reason is read from `jobs/<id>/state.json` — the second half of the
      // snapshot: the session list does not carry it at all, `waitingFor` exists only
      // on one standing on a dialog.
      check('step 10: a participant stall on an exhausted limit is parsed as limit — the reason is from state.json',
        limit.view?.stall?.kind === 'limit' && /hit your usage limit/.test(limit.view.stall.reason ?? ''),
        `${JSON.stringify(limit.view)} · session detail: ${sessionDetail(fieldsOf(WORKER).session)}`);
      check('step 10: the limit route does not call a person — the limit will reset itself, wake with a message',
        typeof limit.said === 'string' && limit.said.includes(WORKER)
        && /the limit resets on its own/.test(limit.said) && !/claude attach/.test(limit.said),
        `${tail(String(limit.said))} · ${wh.diagnose()}`);
      at(STEPS[9], Date.now() - t10);
    }

    // --- step 11: fan-out to two participants and artifact deduplication ------------
    // The surface does not open a real fan-out (one canonical message to several): the
    // adapter cuts the recipient down to one, the tool schema declares `to` as a
    // string, there is no «send to several» command at all — n>1 lives only in the
    // engine and is checked by the package's own suite. What is checked here is what
    // the surface does open: two independent messages from ONE orchestrator turn, both
    // arrived, both were woken, a third did not get one — and the layout invariant
    // shared by any number of recipients: canon and the mailbox link are one inode.
    const t11 = Date.now();
    await mcp.tool('promptobus_mailbox');
    const artifact = path.join(sandbox, 'artifact.md');
    writeFileSync(artifact, `# ${MARK.fan}\n\nОдин и тот же файл уходит дважды.\n`);
    // The «knocked as far as» mark is taken BEFORE the send on BOTH. A mailbox fetch
    // does not reset it: the warden delivery branch rewrites the mark field by field
    // and carries `knockedTo` from the previous state (`supervisor.ts`, the
    // `if (!unread)` branch). On the worker it has been sitting there since the step 5
    // knock, and the condition «the mark is there» would be green before this send —
    // that is, even if the knock never fired (checked by a mutation probe :
    // sending to the reviewer only did not paint the old verdict form red). The real
    // sign of a fresh knock is a CHANGE of the mark: `knockedTo` carries the id of the
    // last message that was knocked about.
    const knockedWas = Object.fromEntries([WORKER, REVIEWER].map((a) => [a, healthOf(a).knockedTo ?? null]));
    const fanned = [];
    for (const addr of [WORKER, REVIEWER]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await mcp.tool('promptobus_send', {
        to: addr, type: 'artifact', body: `${MARK.fan}: тот же файл обоим`, artifactPath: artifact,
      });
      fanned.push({ addr, ok: r.isError === false, text: r.text });
    }
    check('step 11: both messages left from one orchestrator turn',
      fanned.every((f) => f.ok), JSON.stringify(fanned.map((f) => [f.addr, tail(f.text, 120)])));
    // We look for the link in the inbox AND in history: the participant is free to
    // fetch the mailbox right now, and a check only on the inbox would go red from the
    // speed of a foreign turn, not from a breakage. Fan-out restore judges by exactly
    // this pair of places ([14]).
    // The link is looked up by BODY, not by count: both participants already have
    // links from previous steps, and «there are more than zero» would be true without a
    // single delivery of this step — found by a mutation probe , sending to the
    // reviewer only.
    const landedFan = (addr) => linkedNames(home, TASK, addr)
      .filter((n) => messageBody(home, TASK, addr, n).includes(MARK.fan));
    const delivered = await waitFor(() => ([WORKER, REVIEWER].every((a) => landedFan(a).length === 1)
      ? [WORKER, REVIEWER].map((a) => landedFan(a).length) : null), { timeoutMs: step });
    check('step 11: the link landed for both recipients and did not land for the sender',
      Array.isArray(delivered) && landedFan(store.ORCHESTRATOR).length === 0,
      `${JSON.stringify(delivered)} · on the orchestrator ${JSON.stringify(landedFan(store.ORCHESTRATOR))}`
      + ` · on the recipients ${JSON.stringify([WORKER, REVIEWER].map((a) => landedFan(a).length))}`);
    // Canon and the link are the same inode: both layout atomicity and its
    // recoverability sit on that. The property does not depend on the number of
    // recipients, and it is checked on the tree the run is going with, not on the
    // package sources.
    const oneInode = [WORKER, REVIEWER].map((addr) => {
      const name = landedFan(addr)[0];
      if (!name) return `${addr}: no link`;
      const canon = path.join(store.taskDir(home, TASK), 'messages', name);
      const link = linkPath(home, TASK, addr, name);
      if (!existsSync(canon) || !link) return `${addr}: ${canon} / ${link}`;
      return statSync(canon).ino === statSync(link).ino ? null : `${addr}: inodes differ`;
    }).filter(Boolean);
    check('step 11: the message canon and the recipient link are one inode',
      oneInode.length === 0, oneInode.join('; '));
    // The same file went out twice: the content is deduplicated (one blob), and there
    // are two names and two metadata records — the name lives apart from the content
    // ([14]).
    const blobs = listDir(path.join(store.taskDir(home, TASK), 'blobs'));
    const metas = listDir(path.join(store.taskDir(home, TASK), 'artifacts'));
    // We take OUR names, not the whole directory: next to them sits a diff that
    // `promptobus review` puts there directly, without a blob and without a metadata
    // record — and a count of the whole directory would count a foreign file as ours.
    const named = listDir(store.filesDir(home, TASK)).filter((n) => /^artifact(-\d+)?\.md$/.test(n));
    const blobOfOurs = path.join(store.taskDir(home, TASK), 'blobs', blobs[0] ?? 'none');
    check('step 11: the same artifact twice — one blob, two metadata records, two names',
      blobs.length === 1 && metas.length === 2 && named.length === 2,
      `blobs ${blobs.length} · artifacts ${metas.length} · names ${JSON.stringify(named)}`);
    check('step 11: both artifact names are links to the same blob, not copies',
      blobs.length === 1 && named.length === 2 && named.every((n) => statSync(path.join(store.filesDir(home, TASK), n)).ino
        === statSync(blobOfOurs).ino),
      `${JSON.stringify(named)} · blob ${blobs[0] ?? 'none'}`);
    // Both were woken: the warden tick knocks each recipient separately, and a failed
    // activation of one does not cancel delivery to the other. What is checked is a
    // CHANGE of the mark against the snapshot above — on a still mark the verdict
    // would be green without a single knock.
    const knockedBoth = await waitFor(() => ([WORKER, REVIEWER].every((a) => {
      const now = healthOf(a).knockedTo ?? null;
      return !!now && now !== knockedWas[a];
    }) ? true : null), { timeoutMs: step });
    check('step 11: the warden knocked both recipients about the new message',
      knockedBoth === true,
      `was ${JSON.stringify(knockedWas)} · became `
      + JSON.stringify(Object.fromEntries([WORKER, REVIEWER].map((a) => [a, healthOf(a).knockedTo ?? null]))));
    at(STEPS[10], Date.now() - t11);

    // --- step 12: history, status and mailbox claim ---------------------------------
    const t12 = Date.now();
    // «Did not mark anything as read» is judged by the ORCHESTRATOR mailbox and by
    // CONTAINMENT of names, not by counters of all three. Two reasons are enough.
    // Foreign mailboxes: the participants were just woken by step 11, a live session
    // fetches them in exactly this window, and counter equality would go red from the
    // speed of a foreign turn — the same false red that was lifted in step 8. Equality
    // of COUNT does not work on our own either: a live participant is free to send the
    // orchestrator one more message between two snapshots, and the mailbox lawfully
    // grows. The only question here is whether the command carried away what was
    // already sitting there.
    const boxBefore = listDir(store.inboxDir(home, TASK, store.ORCHESTRATOR));
    const hist = cli([ 'history', '--task', TASK, '--all'], { cwd: ws, env: orchEnv });
    const boxAfter = listDir(store.inboxDir(home, TASK, store.ORCHESTRATOR));
    const lost = boxBefore.filter((n) => !boxAfter.includes(n));
    check('step 12: history showed the read correspondence of the task and marked nothing as read',
      hist.status === 0 && hist.out.includes(MARK.status) && hist.out.includes(MARK.result1)
      && lost.length === 0,
      `exit ${hist.status} · taken from the orchestrator mailbox ${JSON.stringify(lost)}`
      + ` · was ${boxBefore.length}, became ${boxAfter.length} · ${tail(hist.out)}`);
    const stat = cli([ 'status', '--task', TASK], { cwd: ws, env: orchEnv });
    check('step 12: status named the task, the live warden and both participants',
      stat.status === 0 && stat.out.includes(TASK) && stat.out.includes(WORKER)
      && stat.out.includes(REVIEWER) && /надзиратель/.test(stat.out), tail(stat.out));
    // Claim: a foreign session sees a COPY and a header, the originals stay with the
    // owner; the claim names the previous owner and rewrites the task owner. There is
    // no silent takeover.
    const heirSession = `${ORCH_SESSION}-heir`;
    const heir = startMcp({ ...orchEnv, CLAUDE_CODE_SESSION_ID: heirSession }, ws);
    let takeover = null;
    try {
      await heir.call('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'promptobus-e2e-heir', version: '1' },
      });
      const peek = await heir.tool('promptobus_mailbox', { task: TASK });
      check('step 12: a foreign session is given the orchestrator mailbox with a header, and the owner did not change',
        peek.text.includes(store.FOREIGN_MARK) && store.taskOwner(home, TASK) === ORCH_SESSION,
        `${tail(peek.text, 200)} · owner ${store.taskOwner(home, TASK)}`);
      takeover = await heir.tool('promptobus_mailbox', { task: TASK, claim: true });
      check('step 12: the claim named the previous owner and rewrote the task owner',
        takeover.text.includes(store.MAILBOX_CLAIMED_MARK) && takeover.text.includes(ORCH_SESSION)
        && store.taskOwner(home, TASK) === heirSession,
        `${tail(takeover.text, 200)} · owner ${store.taskOwner(home, TASK)}`);
    } finally {
      heir.stop();
    }
    // Returning ownership is not cleanup after ourselves, but the second half of the
    // check: the claim is reversible by the same move, and `promptobus done` below
    // goes from the owner, as it should.
    const back = await mcp.tool('promptobus_mailbox', { claim: true });
    check('step 12: the owner took the mailbox back — the claim is reversible',
      back.isError === false && store.taskOwner(home, TASK) === ORCH_SESSION,
      `${tail(back.text, 200)} · owner ${store.taskOwner(home, TASK)}`);
    at(STEPS[11], Date.now() - t12);

    // --- step 13: done --------------------------------------------------------------
    const t13 = Date.now();
    // The orchestrator accepted the work: it merges the worker branch into the clone
    // default branch — until then cleanup lawfully will not touch the directory, and
    // «merged worktrees are swept» would have nothing to check.
    git(repoAbs, 'merge', '--no-ff', '-q', '-m', ': работа worker\'а принята', wf.branch);
    const refs = [wp?.sessionRef, rp?.sessionRef].filter(Boolean);
    // Process numbers are taken BEFORE close: after a successful `stop` session records
    // disappear, and a verdict «no processes left» derived from the registry would be
    // green by construction — a broken teardown would stay invisible (review note).
    // Length is checked together with liveness: an empty pid list would give the same
    // idle green from the other side.
    //
    // EACH is asked of its own harness, and liveness too: lineups have different
    // registries, and one list for both would give half empty — that is, it would
    // check teardown of one participant while calling itself a check of both.
    const procs = [[wh, wp?.sessionRef], [rh, rp?.sessionRef]]
      .filter(([, ref]) => !!ref)
      .flatMap(([h, ref]) => h.pidsOf([ref]).map((pid) => ({ h, pid })));
    const pids = procs.map((p) => p.pid);
    const aliveNow = () => procs.filter(({ h, pid }) => h.pidAlive(pid)).map((p) => p.pid);
    // Task secrets are counted BEFORE close: after cleanup they are gone by
    // construction, and a check «removed» without this snapshot would pass even on a
    // stand that never created them. We wait for exactly what this lineup creates: every
    // participant has a contact point, and mcp-config as a file on the store path —
    // only on a harness that reads it from there.
    const secretsWant = 2 + (wh.files ? 1 : 0) + (rh.files ? 1 : 0);
    const secretsBefore = [[WORKER, wh], [REVIEWER, rh]]
      .flatMap(([a, h]) => [store.wakeFile(home, TASK, a), ...(h.files ? [store.participantMcpPath(home, TASK, a)] : [])])
      .filter((f) => existsSync(f));
    const done = cli([ 'done', '--task', TASK], { cwd: ws, env: orchEnv });
    check('step 13: promptobus done closed the task and named the sessions it is tearing down',
      done.status === 0 && /гашу сессии участников \(2\)/.test(done.out) && /worker:e2e/.test(done.out),
      tail(done.out));
    // With a short wait — the same race as the twin in the harness unit: stub
    // `claude stop` waits for the process to die itself, but no longer than its
    // ceiling, and the live one does not even promise that (review note).
    const dead = await waitFor(() => aliveNow().length === 0 || null, { timeoutMs: step });
    check('step 13: no participant processes are left — not one',
      pids.length === refs.length && pids.length > 0 && dead === true,
      `pids before teardown ${JSON.stringify(pids)} · still alive ${JSON.stringify(aliveNow())}`);
    check('step 13: the merged worktree is removed together with its branch',
      !existsSync(wf.worktree) && !out(git(repoAbs, 'branch', '--list', wf.branch)),
      `${wf.worktree}: ${existsSync(wf.worktree)} · branch: ${out(git(repoAbs, 'branch', '--list', wf.branch))}`);
    check('step 13: task secrets are removed — neither contact points nor mcp-configs',
      secretsBefore.length === secretsWant
      && !secretsBefore.some((f) => existsSync(f))
      && !existsSync(store.wakeFile(home, TASK, store.ORCHESTRATOR)),
      `had ${JSON.stringify(secretsBefore)} · left ${JSON.stringify(secretsBefore.filter((f) => existsSync(f)))}`);
    at(STEPS[12], Date.now() - t13);

    // --- step 14: prune and warden exit ---------------------------------------------
    const t14 = Date.now();
    const gone = await waitFor(() => (store.liveWarden(home, TASK) ? null : true), { timeoutMs: step });
    check('step 14: the warden exited on its own — the task is closed, there is nothing to watch',
      gone === true && /надзиратель.*вышел/.test(store.tailWardenLog(home, TASK, 200).join('\n')),
      store.tailWardenLog(home, TASK, 20).join('\n'));
    const probe = cli([ 'prune', '--older-than', '0'], { cwd: ws, env: orchEnv });
    check('step 14: a prune probe names the closed task and deletes nothing',
      probe.status === 0 && probe.out.includes(TASK) && /Ничего не удалено/.test(probe.out)
      && existsSync(store.taskDir(home, TASK)), tail(probe.out));
    const pruned = cli([ 'prune', '--older-than', '0', '--yes'], { cwd: ws, env: orchEnv });
    check('step 14: prune --yes removed the journal of the closed task',
      pruned.status === 0 && !existsSync(store.taskDir(home, TASK)), tail(pruned.out));
    check('step 14: the bus server wrote nothing stray onto the protocol channel',
      mcp.strays.length === 0, JSON.stringify(mcp.strays.slice(0, 3)));
    at(STEPS[13], Date.now() - t14);
  } finally {
    mcp.stop();
    await inbox.close();
    try { process.kill(warden.pid, 'SIGTERM'); } catch { /* already exited */ }
    harness.cleanup();
  }
  return { timings, totalMs: Date.now() - t0, postcards: inbox.seen, mechanism: { declared: PROMPTOBUS_BIN, reported: selfBin } };
}

function out(r) {
  return String(r?.stdout ?? '').trim();
}

/** Contents of a directory that may not exist at all: task directories are created lazily. */
function listDir(dir) {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

/**
 * Link names of an address — in the mailbox AND in the read history. Two places, not
 * one: a link may be missing from the inbox for two reasons — it was not created in
 * time or it was already read — and fan-out restore judges by exactly this pair. A
 * check on the inbox alone would go red from the speed of a foreign turn, not from a
 * breakage.
 */
function linkedNames(home, task, addr) {
  return [...listDir(store.inboxDir(home, task, addr)), ...listDir(store.historyDir(home, task, addr))];
}

/** Link path by name — from the directory where it currently sits. */
function linkPath(home, task, addr, name) {
  for (const dir of [store.inboxDir(home, task, addr), store.historyDir(home, task, addr)]) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Message body by link name. Unreadable — an empty string: this file has nothing to judge it by. */
function messageBody(home, task, addr, name) {
  const file = linkPath(home, task, addr, name);
  if (!file) return '';
  try {
    return String(JSON.parse(readFileSync(file, 'utf8')).body ?? '');
  } catch {
    return '';
  }
}

/**
 * Path of the binary the started process named as ITS OWN — from the participant
 * mcp-config. One field is read: the rest hold substituted tokens of canonical servers,
 * and they must not go into the report or a verdict detail.
 */
function readSelfBin(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).mcpServers?.promptobus?.args?.[0] ?? null;
  } catch {
    return null;
  }
}

// Paths are checked by realpath: under a macOS temp directory the same file arrives both
// as `/var/…` and as `/private/var/…`, and the child-process ESM resolve returns the
// resolved path.
function real(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

function samePath(a, b) {
  return !!a && !!b && real(a) === real(b);
}

function tail(text, n = 700) {
  const s = String(text ?? '').trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
}

function readSafe(file) {
  try { return tail(readFileSync(file, 'utf8')); } catch { return '(no warden log)'; }
}

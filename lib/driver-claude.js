import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { PROMPTOBUS_SERVER } from './contract.js';
import { foreignSession, writeWake } from './store.js';
import { PARENT_SESSION_ENV } from './session-env.js';
import {
  bgSessions, findSession, liftoffParticipant, readBgSessions, resetBgSessionsCache, runClaude, sayLiftoff,
  sessionLiveness,
} from './liftoff.js';
import { claudeAvailability } from './model-routing/adapter-claude.js';
import { markExhausted } from './model-routing/cache.js';
import { GUARD_HOOK_EVENT } from '../dist/hooks.js';
import { GateError } from '../dist/index.js';
import { orderBody as commonOrderBody } from './notification.js';
import { parseVersion, sayForeignWrite as commonSayForeignWrite, sessionEnvFor, versionLess, versionParseRefusal } from './driver-common.js';

// Claude Code harness driver: EVERYTHING that knows about Claude lives here, and nothing outside
// imports this file — the engine reaches it through the registry ([drivers.js](drivers.js)).

/** Harness name in the participant record and the key in the registry map. */
export const CLAUDE = 'claude';

const CLAUDE_INSTALL = 'npm install -g @anthropic-ai/claude-code (or https://docs.claude.com/en/docs/claude-code/setup)';

function claudeUserMcp(canonServerNames) {
  const file = path.join(homedir(), '.claude.json');
  let names = [];
  if (existsSync(file)) {
    try {
      names = Object.keys(JSON.parse(readFileSync(file, 'utf8'))?.mcpServers ?? {}).sort();
    } catch {
      names = [];
    }
  }
  const canon = new Set(canonServerNames);
  const extras = [];
  const shadowed = [];
  for (const name of names) (canon.has(name) ? shadowed : extras).push(name);
  return { extras, shadowed };
}

// --- harness dictionary: allowed option values and versions ------------------------
// One harness's dictionary; `contract.js` keeps only the harness-neutral parts.

// Allowed --effort values — same as the `claude --effort` flag. It also accepts `ultracode`:
// xhigh effort with dynamic workflow orchestration.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

// Allowed --permission-mode values, from `claude --help`. A worker defaults to `auto`:
// `acceptEdits` still asks on every ordinary Bash command, and a background worker would stall.
export const PERMISSION_MODES = ['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'manual', 'plan'];
export const DEFAULT_PERMISSION_MODE = 'auto';

/** The modes a session bypasses permission prompts in, in the harness's own sense. **Measured, not
 * read off the names**: `dontAsk`, `acceptEdits` and `auto` all took a knocked message. */
export const PROMPT_BYPASS_MODES = ['bypassPermissions'];

/** Whether a lift in this mode would have the session hold an unattested peer message. */
export const bypassesPrompts = (mode) => PROMPT_BYPASS_MODES.includes(mode);

// Participant model without a `--model` flag: harness dictionary, not a lift-command value. The
// engine names the model itself, because a person's session default may be more expensive.
export const DEFAULT_MODEL = 'opus';

// Model aliases the harness publishes under `--model`. **An alias names whatever the vendor points
// it at today, and that is why the catalog rates none of them** — rated rows name full ids.
export const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];

// Full model names this driver accepts under `--model` verbatim — the RATED half of the inventory.
// A name here the catalog stops rating shows up in `models` as an unrated runtime row.
export const MODEL_IDS = [
  'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
];

// Display names on a model-scoped limit row, and the ids each resolves to. A scope names a FAMILY,
// so an entry carries every id of it: naming one would leave a sibling bound by no window.
export const MODEL_SCOPE_IDS = {
  fable: ['claude-fable-5-1', 'claude-fable-5'],
  opus: ['claude-opus-5-5', 'claude-opus-5'],
  sonnet: ['claude-sonnet-5'],
  haiku: ['claude-haiku-4-5'],
};

// The id each alias resolves to TODAY. A second table, not a second reading of the scope one: a
// SCOPE names a family and may name several ids, an ALIAS names exactly one, or it resolves to none.
export const MODEL_ALIAS_IDS = {
  fable: ['claude-fable-5-1'],
  opus: ['claude-opus-5-5'],
  sonnet: ['claude-sonnet-5'],
  haiku: ['claude-haiku-4-5'],
};

// What the availability adapter reports as the inventory: rated ids, published aliases and the
// model this driver lifts on — each is an answer to "what can this account run".
const PROBE_MODELS = [...new Set([...MODEL_IDS, ...MODEL_ALIASES, DEFAULT_MODEL])];

// The first build an id reaches the session from: below it the API answers the id with a 400 naming
// this version (measured on 2.1.263). An id with no entry has no floor.
export const MODEL_MIN_VERSION = { 'claude-opus-5-5': '2.1.280' };

/** The inventory a binary of `version` can run: an id below its floor is dropped, and an unreadable
 * version drops nothing. */
export const inventoryFor = (version) => PROBE_MODELS
  .filter((model) => !versionLess(version, MODEL_MIN_VERSION[model]));

// Claude version from which `ultracode` reaches the session: on 2.1.169 the binary warns to stderr
// and lifts on the default effort (measured), and 2.1.210 fixed the silent drop.
export const ULTRACODE_MIN_VERSION = '2.1.210';

// Tools taken from the reviewer: it reads and writes a report on the bus, and does not edit or go
// outside. Pinned by test/promptobus-review.test.mjs (three checks).
export const REVIEWER_DENY = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];

// The version warden delivery by socket injection was PROVEN on — a measurement, not a minimum and
// not a gate: the injection surface is undocumented, and a refusal only delays the mailbox.
export const PROVEN_CLAUDE_VERSION = '2.1.280';

// Parent variables that must not reach the participant: `CLAUDE_PID` points at a foreign session
// and `CLAUDE_EFFORT` leaks a stale value. Dropping the latter does not change session effort.
export const SESSION_ENV_DROP = [...PARENT_SESSION_ENV];

/** Harness words the adapter inserts into its own strings: shared prose stays with it, the command
 * stays here, or everyone who prints a session line would know `claude attach`. */
export const PHRASES = {
  sessions: 'claude agents',
  unreadable: 'claude agents --json is unreadable',
  enter: (id) => `claude attach ${id}`,
  // Without an identifier — the bare command name: a vanished record names it as the REASON, not
  // as a line to copy, and there is no id to take there.
  stop: (id) => (id ? `claude stop ${id}` : 'claude stop'),
  logs: (id) => `claude logs ${id}`,
  // MCP tool name as the Claude Code session calls it: the client namespaces it itself, and the
  // short name is enough. A second harness writes it differently, so this is a driver word.
  tool: (_server, name) => name,
  mcpBoundary: '**Host-classified MCP write tools are mechanically denied by the harness; the remaining external MCP surface is read-only under this prompt, the second layer.**',
  // Claude Code appends no rules of its own: its background-session habits are described by the
  // prompt itself and the workspace rules.
  promptRules: '',
};

// How long we wait on the socket: waiting forever on a dead socket would halt
// delivery to the others.
export const KNOCK_TIMEOUT_MS = 3000;

// Sender name in the injection `from` field: the recipient uses it to tell who
// wrote the turn.
export const KNOCK_FROM = 'promptobus-warden';

// --- session-state parse --------------------------------------------------

// Claude config directory — the same one that holds `jobs/` and `daemon/`.
function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
}

// The reason goes into one-line output. `state.json` is not a contract — a whole paragraph used to
// land in `detail` — so it is flattened to one line and cut by length here.
const DETAIL_MAX = 160;

function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

// `detail` line of a background session by its short id (the same one `claude
// attach` and `claude logs` take). Throws nothing: anything missing — null.
export function sessionDetail(id, home = claudeHome()) {
  if (!id) return null;
  try {
    const raw = JSON.parse(readFileSync(path.join(home, 'jobs', String(id), 'state.json'), 'utf8'));
    return (typeof raw?.detail === 'string' ? oneLine(raw.detail) : '') || null;
  } catch {
    return null;
  }
}

// An exhausted limit is known from the harness's own line; a template would call everything a
// limit. The late-start mark gates on that pattern and then checks the reset phrase separately.
const LIMIT_RESETS = /\blimit\b[^\n]*\bresets\b/i;
const LIMIT_DETAIL = new RegExp(`\\bhit your\\b[^\\n]*\\blimit\\b|${LIMIT_RESETS.source}`, 'i');

// A lift refused on a spent limit marks the harness exhausted and returns the line the
// refusal appends. Which code, why resetAt stays null: [reference/05-drivers.md#a-lift-that-fails-on-a-spent-limit](../docs/reference/05-drivers.md#a-lift-that-fails-on-a-spent-limit).
export function markLimitAtStart(host, output) {
  const said = String(output ?? '');
  const hit = host ? LIMIT_DETAIL.test(said) : false;
  if (!hit) return '';
  const named = LIMIT_RESETS.test(said);
  try {
    const { cacheFile } = host.routingPaths();
    const clearCommand = host.busCommand(['models', '--clear-exhausted', CLAUDE]);
    markExhausted(host, CLAUDE, {
      reason: named ? 'subscription_exhausted' : 'manual_exhaustion',
      message: named
        ? 'limit hit at start; the harness said the limit resets but named no time to parse'
        : 'limit hit at start; the harness named no reset time',
    });
    return ` The account limit was spent, so harness "${CLAUDE}" is now marked exhausted in ${cacheFile}:`
      + ` neither time nor a later probe lifts that mark. Clear it with \`${clearCommand}\``
      + ', or delete that harness entry from the file.';
  } catch {
    return '';
  }
}

// Stall of a session: null, or { kind, reason }. Where the reason's halves come from:
// [05-drivers.md § sessionStall](../docs/reference/05-drivers.md#sessionstall--sessionstall-answers-null-for-no-stall-otherwise--kind-reason--kind-is-permission).
export function sessionStall(session, detail = undefined) {
  if (!session) return null;
  // The dialog mark is checked first and the file is not read for it: the warden polls state every
  // heartbeat, and `waitingFor` is issued only to a session standing at a dialog.
  if (session.waitingFor) return { kind: 'permission', reason: oneLine(session.waitingFor) };
  const blocked = session.state === 'blocked';
  const idle = String(session.status ?? '').toLowerCase() === 'idle';
  if (!blocked && !idle) return null;
  const said = detail === undefined ? sessionDetail(session.id) : oneLine(detail ?? '') || null;
  if (said && LIMIT_DETAIL.test(said)) return { kind: 'limit', reason: said };
  // No reason — name the mark we entered the parse on, do not invent a state.
  return { kind: 'unknown', reason: said ?? (blocked ? 'blocked' : 'idle') };
}

// What to do with this stall — one line for every consumer. The routes are Claude-specific, so they
// live on the driver, and the commands come from `PHRASES`: a second home would drift.
export function stallRoute({ kind, address, repoAbs, task, reviewCommand }, id, name) {
  const review = reviewCommand;
  // A reviewer has a package command; an approver is lifted with review --approver.
  const relift = () => (address?.startsWith('reviewer:')
    ? `lift the reviewer again: ${review}`
    : (address?.startsWith('approver:')
      ? `lift the approver again: ${review}`
      : `lift the worker again with the same spawn — it will sit in its own worktree and branch`));
  if (kind === 'stale') {
    return `nobody to wake — no process behind the record. Check: ${PHRASES.logs(id)} (a «job not found» reply confirms), `
      + `and ${relift()}`;
  }
  // No record at all: nothing to check with. Softer words than `stale` — `claude stop` drops the
  // record entirely after delivered work.
  if (kind === 'gone') {
    return `the session is not in the list — nobody to wake. A person may have removed it: ${PHRASES.stop(null)} drops `
      + `the record entirely. Work delivered — that is a normal end, nothing to do; not delivered — ${relift()}`;
  }
  // Contact point taken: the session is alive and working, deaf only to notifications. The record
  // repairs itself, but a person must know the addressee has not seen the messages.
  if (kind === 'wake-taken') {
    return 'the session is alive; only the channel is deaf: the contact point returns to it on its next '
      + `turn end. Until then deliver the message yourself — ${PHRASES.enter(id)}; if another session `
      + 'keeps rewriting the channel, it has an old bus release — update the workspace';
  }
  // One field, three readings, and it says which of none: own prompt, held peer message
  // (PB-165), a refusal that already returned (PB-176). 03-cli § Status, done… carries why.
  if (kind === 'permission') {
    return 'a dialog mark, and the record does not say which of three things stands behind it. '
      + `A prompt of the session's own work — ${PHRASES.enter(id)} answers it, ${PHRASES.stop(id)} drops the session. `
      + 'A held message from another session — the participant was lifted without this mechanism\'s participant '
      + `settings file; deliver it at the session, and the next lift with \`--permission-mode ${PROMPT_BYPASS_MODES[0]}\` `
      + 'will carry "crossSessionInbound": "accept" and hold nothing. '
      + 'A refusal that has already returned — then nothing is standing, the session is working, and only a '
      + `permission rule decided outside it changes anything. Read ${PHRASES.logs(id)} before calling a person`;
  }
  if (kind === 'limit') {
    return 'no person needed: the limit resets on its own, and you can wake the session with a message '
      + `(in Claude Code — SendMessage to session «${name}»)`;
  }
  return `no route for this reason — see ${PHRASES.logs(id)}: `
    + `next either answer the session (${PHRASES.enter(id)}) or wake it with a message`;
}

// --- notification text ------------------------------------------------------

// Inter-session message frame. Both its properties were proven live: it rests on the bus protocol
// rather than a person's authority, and it refuses to escalate permissions — silence reads as suspicious.
export function orderBody(task, addr, unread, msgs = []) {
  return commonOrderBody(task, addr, unread, msgs, {
    header: 'Promptobus service notification',
    fetchLine: 'Fetch the mailbox: only mailbox marks messages read; ',
    workingOrder: 'the working order is in the bus rules',
  });
}

export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? []);
}

// --- messaging socket ------------------------------------------------------------

// Knock on the participant's messaging socket: one connection, two lines of line-delimited JSON.
// The auth line is always sent — macOS does not check it, and code without it is not portable.
function dial(socketPath, lines, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let sock;
    try {
      sock = connect(socketPath);
    } catch (e) {
      finish({ ok: false, error: e.code ?? e.message });
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.on('error', (e) => {
      finish({ ok: false, error: e.code ?? e.message });
      sock.destroy();
    });
    sock.on('timeout', () => {
      finish({ ok: false, error: 'socket did not reply' });
      sock.destroy();
    });
    sock.on('connect', () => {
      // `end` only HALF-closes: the listener holds it for its own thirty seconds and the injection
      // protocol has no reply, hence `destroy` at once.
      sock.end(`${lines.join('\n')}\n`, () => {
        finish({ ok: true });
        sock.destroy();
      });
    });
  });
}

function authLine(token) {
  return JSON.stringify({ type: 'auth', token: token ?? '' });
}

export function knockSocket(endpoint, body, { timeoutMs = KNOCK_TIMEOUT_MS } = {}) {
  return dial(endpoint.socket, [
    authLine(endpoint.token),
    JSON.stringify({
      msgV: 1,
      msg_id: randomUUID(),
      type: 'user',
      message: { role: 'user', content: body },
      priority: 'next',
      from: KNOCK_FROM,
    }),
  ], timeoutMs);
}

// Channel smoke for `doctor`: a connection and one auth line, no message. A connection without a
// second line is harmless to the listener.
export function probeWake(socketPath, token, { timeoutMs = KNOCK_TIMEOUT_MS } = {}) {
  return dial(socketPath, [authLine(token)], timeoutMs);
}

/** Wake channel of THIS session — the diagnostics entry. `doctor` asks for the outcome, not the
 * variables, and the smoke sends no real message: that would cost a record in a person's feed. */
export async function checkWake(env = process.env) {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  if (!socket) return { endpoint: null, ok: false, error: 'CLAUDE_CODE_MESSAGING_SOCKET is empty' };
  const r = await probeWake(socket, env.CLAUDE_CODE_MESSAGING_TOKEN);
  return { endpoint: socket, ok: !!r.ok, error: r.ok ? null : String(r.error ?? '') };
}

// Hand off this session's contact point. **A write for a foreign address is refused**, here rather
// than on the two callers; the session arrives as an ARGUMENT, since a Stop hook may lack the variable.
export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    const who = session ?? env.CLAUDE_CODE_SESSION_ID?.trim() ?? null;
    const held = foreignSession(home, task, addr, who);
    if (held) {
      sayForeignWrite(home, task, addr, held, who, `contact-point handoff`);
      return null;
    }
    return writeWake(home, task, addr, {
      socket: env.CLAUDE_CODE_MESSAGING_SOCKET?.trim() || null,
      token: env.CLAUDE_CODE_MESSAGING_TOKEN?.trim() || null,
      session: who || null,
    });
  } catch {
    // A safety net must not drop a bus-tool call.
    return null;
  }
}

// A gate refusal must be VISIBLE: a silent `null` looks like healthy work. Both doors speak — the
// handshake here and the loop guard — and the line is written once per reason per process.
const sayForeignWrite = commonSayForeignWrite;
export { sayForeignWrite };

// --- translate harness-neutral context into this harness's config and argv ------
// Config and argv are halves of ONE `prepare`: the caller names the subject, this file the form.

// Participant MCP config: a harness-neutral server list into the form the binary reads. Which
// servers is the lift's decision; how they sit in the file is this driver's.
function mcpConfig({ servers }) {
  return { mcpServers: { ...servers } };
}

// Pre-approve delivered servers: the reviewer is lifted without `--permission-mode` and would
// stall on the first non-bus server. The bus first, the rest alphabetically — the order is stable.
function mcpAllowedTools(mcpCfg) {
  const names = Object.keys(mcpCfg.mcpServers ?? {});
  return [PROMPTOBUS_SERVER, ...names.filter((n) => n !== PROMPTOBUS_SERVER).sort()].map((n) => `mcp__${n}`);
}

// Host MCP identities are canonical pairs; this permissions file takes the namespaced spelling.
// Deliberately separate from `PHRASES.tool`, which is the short name a participant types.
export function mcpDenyTools(tools) {
  return tools.map(({ server, tool }) => `mcp__${server}__${tool}`);
}

// Binary argv from the lift context. `--mcp-config` and `--allowedTools` are variadic and eat
// positionals, so the prompt sits only after a non-variadic option and always last.
function spawnArgv({
  ref, mcpConfigPath, mcpConfig: cfg, addDirs = [], pluginDir = null, settingsPath,
  model, effort = null, permissionMode = null, prompt,
}) {
  return [
    '--bg',
    '--name', ref,
    '--mcp-config', mcpConfigPath,
    '--allowedTools', ...mcpAllowedTools(cfg),
    ...(addDirs.length ? ['--add-dir', ...addDirs] : []),
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    '--settings', settingsPath,
    '--model', model,
    // --effort — only when set explicitly: without the flag the session lifts on
    // the binary default.
    ...(effort ? ['--effort', effort] : []),
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    prompt,
  ];
}

// Hook event the loop guard stands on — a Claude Code contract declared in `src/hooks.ts`. The
// adapter builds the command, and the harness knows the form it lands in.

/** Participant settings file; every key of it and why, including the server-choice dialog a
 * background session cannot answer: [03-cli.md § Spawn](../docs/reference/03-cli.md#spawn). */
function settingsFile({
  role = null, denyTools, guardCommand, permissionMode = null, extraSettings,
}) {
  return {
    ...(denyTools?.length ? { permissions: { deny: denyTools } } : {}),
    enableAllProjectMcpServers: true,
    ...(bypassesPrompts(permissionMode) ? { crossSessionInbound: 'accept' } : {}),
    ...(role === 'approver' ? { worktree: { bgIsolation: 'none' } } : {}),
    viewMode: 'focus',
    hooks: { [GUARD_HOOK_EVENT]: [{ hooks: [{ type: 'command', command: guardCommand }] }] },
    ...extraSettings,
  };
}

/** Lift plan from harness-neutral context. Writes nothing and starts nothing: `--dry-run` prints
 * exactly this object and the real lift executes it, so print and deed cannot split. */
function prepare({
  ref, role = null, mcp, prompt, model, effort = null, permissionMode = null,
  addDirs = [], pluginDir = null, mcpConfigPath, settingsPath,
  guardCommand, denyTools = null, extraSettings = {},
}) {
  const cfg = mcpConfig(mcp);
  const settings = settingsFile({
    role, denyTools, guardCommand, permissionMode, extraSettings,
  });
  return {
    argv: spawnArgv({
      ref, mcpConfigPath, mcpConfig: cfg, addDirs, pluginDir, settingsPath,
      model, effort, permissionMode, prompt,
    }),
    mcpConfig: cfg,
    settings,
    // File order is write order. The config carries substituted tokens and is marked secret:
    // placing it at `0600` is the caller's job, and the harness need not know about `chmod`.
    files: [
      { path: mcpConfigPath, text: `${JSON.stringify(cfg, null, 2)}\n`, secret: true },
      { path: settingsPath, text: `${JSON.stringify(settings, null, 2)}\n`, secret: false },
    ],
  };
}

const sessionEnv = sessionEnvFor(SESSION_ENV_DROP);

function optionRefusal({ effort = null, statusCommand } = {}, tool) {
  const minVersion = claudeDriver.options.effortMinVersion?.[effort];
  if (!minVersion) return null;
  if (!tool?.version) return null;
  if (!parseVersion(tool.version)) return versionParseRefusal('Claude', tool.version);
  if (!versionLess(tool.version, minVersion)) return null;
  const status = statusCommand;
  return `--effort ${effort}: found claude ${tool.version}, and this keyword reaches the session `
    + `from ${minVersion}. A lower binary drops it with a stderr warning and lifts the session `
    + 'on the DEFAULT effort — silent degradation instead of what was asked: '
    + `the task log and ${status} still name the effort that was requested. `
    + `Update the binary (${CLAUDE_INSTALL}) or pick a lower effort.`;
}

// Canonical-server names shadowed by a person's personal records. The personal config is a harness
// property: a second driver keeps it elsewhere and in another format.
function shadowedUserServers(names) {
  return claudeUserMcp(names).shadowed;
}

// --- driver operations ----------------------------------------------------------

// State of one session for a snapshot, off the registry cache — without it each participant would
// cost a `claude agents --json` run. An unreadable list is `null`: unknown is not death.
function inspect(ref, sessions = undefined) {
  let list = sessions;
  if (list === undefined) {
    // A binary nobody could start is a refusal with its reason, not an unparsed list: the
    // snapshot keeps the reason on this participant's line instead of dropping every line.
    const read = readBgSessions();
    if (read.missing) throw new GateError(read.missing);
    ({ list } = read);
  }
  if (list === null) return null;
  const hit = findSession(list, ref);
  // No record at all: `claude stop` drops it entirely, and a failed lift never creates one. The
  // words are ours — the state machine does not know about `claude agents` and must not.
  if (!hit) {
    return {
      state: 'gone',
      busy: false,
      stall: { kind: 'gone', reason: 'no session record in claude agents' },
      id: null,
      note: null,
    };
  }
  const live = sessionLiveness(hit, list);
  return {
    state: live === 'stale' ? 'stale' : 'alive',
    // Busyness is the record's `status` field: `busy` while thinking, `idle` after
    // giving up the turn.
    busy: String(hit.status ?? '').toLowerCase() === 'busy',
    // A record that outlived its daemon also has `blocked`, but there is no stall
    // to parse: nobody to wake, and that is a separate outcome with its own words.
    stall: live === 'stale' ? { kind: 'stale', reason: 'the record outlived its daemon' } : sessionStall(hit),
    id: hit.id ?? null,
    note: hit.status ?? hit.state ?? 'running',
  };
}

// Lift a background session from its plan. Start and the lifted check are shared with the reviewer
// role ([liftoff.js](liftoff.js)); argv comes from the plan, because the plan is what runs.
async function spawn(plan, { tool, ref, role, cwd, env, launchFailNote, deadNote, persist, awaitOptions, host }) {
  return liftoffParticipant({
    tool, argv: plan.argv, cwd, env, name: ref, role, launchFailNote, deadNote, persist, awaitOptions,
    // The late-start hook. `host` names the availability cache; a caller that hands none simply
    // gets no mark, and the lift behaves exactly as before.
    sayLimit: (output) => markLimitAtStart(host, output),
  });
}

// Ceiling for waiting on session death, and the poll step — both measured, not chosen:
// [05-drivers.md](../docs/reference/05-drivers.md#a-stop-returns-after-the-record-is-gone-not-after-the-command-returns).
const STOP_GONE_TIMEOUT_MS = 10_000;
const STOP_GONE_STEP_MS = 100;

// Wait until the session record is gone. A tristate — `gone`, `timeout`, `unreadable` — because
// saying "closed" on an unreadable registry asserts the unchecked. The list is taken fresh each probe.
async function awaitSessionGone(ref, { timeoutMs = STOP_GONE_TIMEOUT_MS, stepMs = STOP_GONE_STEP_MS } = {}) {
  const edge = Date.now() + timeoutMs;
  for (;;) {
    const list = bgSessions({ fresh: true });
    // No point repeating on an unreadable reply: a parse refusal is not cached, and the next probe
    // would ask the same external process with the same outcome until the ceiling.
    if (list === null) return 'unreadable';
    if (!findSession(list, ref)) return 'gone';
    if (Date.now() >= edge) return 'timeout';
    await new Promise((r) => { setTimeout(r, stepMs); });
  }
}

// Stop a background session. **Idempotent, and that is not a relaxation** — "nothing to stop" is an
// outcome with its own words. It returns after the RECORD is gone, not after the command returns.
async function stop(ref, waitOptions = undefined) {
  const read = readBgSessions();
  if (read.missing) return { ok: false, stopped: false, note: read.missing };
  const { list } = read;
  // Not "nothing to stop": an unread registry says nothing about the session, and it may run on.
  if (list === null) return { ok: false, stopped: false, note: `${PHRASES.unreadable} — session «${ref}» was not stopped` };
  const hit = findSession(list, ref);
  const id = hit?.id ?? null;
  if (!hit) return { ok: true, stopped: false, note: `session «${ref}» is not in the list` };
  // What stands behind a record without an identifier is not visible from here, and there is
  // nothing to assert about its process: said is exactly what is known.
  if (!id) return { ok: true, stopped: false, note: `record «${ref}» has no identifier — nothing to stop with` };
  const { r, missing } = runClaude(['stop', id]);
  if (missing) return { ok: false, stopped: false, note: `claude stop ${id}: ${missing}` };
  if (r.error) return { ok: false, stopped: false, note: `claude stop ${id}: ${r.error.message}` };
  if (r.status !== 0) {
    const said = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
    return { ok: false, stopped: false, note: `claude stop ${id} exited with code ${r.status}${said ? `: ${said}` : ''}` };
  }
  // The list changes after `stop` — without a reset the next reader would see a
  // closed session as alive.
  resetBgSessionsCache();
  const seen = await awaitSessionGone(ref, waitOptions);
  if (seen !== 'gone') {
    // Stop ran with nothing to confirm it. Declaring it stopped is forbidden — directory cleanup
    // follows. `ok`, because the command ran: what failed is the CONFIRMATION, not the stop.
    return {
      ok: true,
      stopped: false,
      attempted: true,
      note: seen === 'unreadable'
        ? `claude stop ${id} ran, the registry after it is unreadable — stop not confirmed`
        : `claude stop ${id} ran, but the session record did not leave claude agents in `
          + `${Math.round(STOP_GONE_TIMEOUT_MS / 1000)} s — the harness has not finished stopping it`,
    };
  }
  return { ok: true, stopped: true, note: `session ${id} closed` };
}

/** Claude Code driver — six optional capabilities including `approverLift`; see `capabilities` below. */
export const claudeDriver = {
  id: CLAUDE,
  capabilities: {
    spawn: true,
    attach: false,
    activation: 'push',
    inspect: true,
    stop: true,
    denyTools: true,
    mcpDenyTools: true,
    systemPrompt: true,
    sessionList: true,
    enter: true,
    approverLift: true,
  },
  options: {
    // Binary name: the path is resolved by it, and the `--dry-run` command is
    // printed by it.
    tool: CLAUDE,
    effortLevels: EFFORT_LEVELS,
    // Minimum binary version by effort level: the value does not reach the session
    // from every build, and help names the number, not "newer than some".
    effortMinVersion: { ultracode: ULTRACODE_MIN_VERSION },
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    // Alias → the one id it resolves to today, handed over through the registry rather than
    // imported. This is `MODEL_ALIAS_IDS`, NOT the scope table the availability adapter gets.
    modelAliases: MODEL_ALIAS_IDS,
    denyTools: REVIEWER_DENY,
    provenVersion: PROVEN_CLAUDE_VERSION,
    // Channel — the messaging socket of a live session: a knock writes a turn
    // into it.
    knockChannel: 'socket',
    identityVar: 'CLAUDE_CODE_SESSION_ID',
    mcpIdentity: null,
    envDrop: SESSION_ENV_DROP,
    // Claude Code takes the workspace skills directory as a flag on one lift.
    skillsDir: true,
    // Nothing of this driver's lands in the participant's working directory: its mcp-config and
    // settings go to the task store, so there is no directory for a lift to overwrite.
    launchDirs: [],
  },
  phrases: PHRASES,
  // Availability adapter — the account question, asked before any session exists. The inventory is
  // handed over from here: it is this driver's dictionary, and the adapter must not import it back.
  availability: claudeAvailability(inventoryFor, MODEL_SCOPE_IDS),
  // Translating harness-neutral context into a lift plan has no capability of its own: without it
  // there is no `spawn`, and declaring it separately would declare half an operation.
  prepare,
  mcpDenyTools,
  spawn,
  saidLiftoff: sayLiftoff,
  inspect,
  forgetSessions: resetBgSessionsCache,
  stop,
  activate: (target, notification) => knockSocket(target.endpoint, renderNotification(notification)),
  renderNotification,
  stallRoute,
  registerWake,
  sayForeignWrite,
  checkWake,
  sessionEnv,
  optionRefusal,
  shadowedUserServers,
};

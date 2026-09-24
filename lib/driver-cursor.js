import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fail, info } from './util.js';
import { run } from './exec.js';
import { PROMPTOBUS_SERVER } from './contract.js';
import { foreignSession, writeWake } from './store.js';
import {
  binInDir, CURSOR_TMUX_SERVER, dropSession, findSession, injectText, liftSession,
  mcpRuntimeNeedles, patchSession, readParticipantMcp, readSession, readTmuxSessions, searchPath, SESSION_ENV_VAR,
  sessionFile, silentIsStall, stopSession, TMUX_NOT_FOUND, tmuxBin, toolKidsOf, turnIdleMs, turnState,
  worktreeTouchedMs, writeSession,
} from './cursor-persist.js';
import { cursorAvailability } from './model-routing/adapter-cursor.js';
import { PARENT_SESSION_ENV, WARDEN_ENV_VARS } from './session-env.js';
import { launchProvenance, provenanceLine } from './provenance.js';
import { orderBody as commonOrderBody } from './notification.js';
import { parseVersion, readRecordAt, sayForeignWrite as commonSayForeignWrite, sessionEnvFor, versionLess, versionParseRefusal } from './driver-common.js';

// Cursor harness driver: everything the mechanism knows about Cursor. The registry and the tmux
// talk sit one floor below ([cursor-persist.js](cursor-persist.js)); every number below was measured.

/** Harness name on the participant record and the key in the registry map. */
export const CURSOR = 'cursor';

/** Name of the BINARY, and NOT the harness name — [02-host.md § Tool binaries](../docs/reference/02-host.md#tool-binaries).
 * One constant, two readers, so the name a host resolves and the name the adapter probes cannot drift. */
export const CURSOR_TOOL = 'cursor-agent';

const CURSOR_SKILLS_REL = path.join('.cursor', 'skills');
const CURSOR_INSTALL = "curl https://cursor.com/install -fsS | bash (Windows: irm 'https://cursor.com/install?win32=true' | iex)";
const CURSOR_BINS = ['cursor-agent', 'agent', 'cursor'];
const SKILL_FILE = 'SKILL.md';
const TMUX_MIN_VERSION = '3.0';

function skillDirs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => {
    const dirAbs = path.join(dir, e.name);
    return { name: e.name, dirAbs, isSkill: existsSync(path.join(dirAbs, SKILL_FILE)) };
  });
}

function cursorMcpDuplicates(canonServerNames) {
  const file = path.join(homedir(), '.cursor', 'mcp.json');
  if (!existsSync(file)) return [];
  let mine;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    mine = j?.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
  } catch {
    return [];
  }
  return canonServerNames.filter((n) => Object.hasOwn(mine, n)).sort();
}

export function findCursorBin({ env = process.env, home = homedir() } = {}) {
  const { dirs } = searchPath({ env, home });
  for (const bin of CURSOR_BINS) {
    for (const dir of dirs) {
      const hit = binInDir(dir.replace(/^"|"$/g, ''), bin);
      if (hit) return { path: hit };
    }
  }
  return null;
}

function cursorVersion(bin, env) {
  const result = run(bin, ['--version'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return null;
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');
  return output.trim() || null;
}

export function normalizeTool(tool, { env = process.env } = {}) {
  if (!tool?.bin || tool.ok === false) return tool;
  let bin = null;
  try {
    bin = realpathSync(tool.bin);
  } catch {
    if (!path.isAbsolute(String(tool.bin)) && !String(tool.bin).includes(path.sep)) {
      const found = findCursorBin({ env });
      try { bin = found?.path ? realpathSync(found.path) : null; } catch { /* unresolved */ }
    }
  }
  if (!bin) return { ...tool, version: null };
  return { ...tool, bin, version: cursorVersion(bin, env) };
}

function resolveTmux({ env = process.env } = {}) {
  const bin = tmuxBin({ env });
  const r = bin ? run(bin, ['-V'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }) : null;
  if (!r || r.error || (r.status !== 0 && !String(r.stdout ?? r.stderr ?? '').trim())) {
    return {
      ok: false,
      reason: `tmux: ${TMUX_NOT_FOUND}. Install: brew install tmux (macOS) / your distro package (Linux).`,
    };
  }
  const raw = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const version = /\d+(?:\.\d+)*/.exec(String(raw))?.[0] ?? null;
  if (version && versionLess(version, TMUX_MIN_VERSION)) {
    return {
      ok: false,
      reason: `tmux: found version ${version}, need ${TMUX_MIN_VERSION} or newer — a Cursor participant session lives on a tmux pane.`,
    };
  }
  return { ok: true, version };
}

// --- harness vocabulary -------------------------------------------------------------

// Effort levels. In Cursor this is NOT a flag: the level is a flat SUFFIX on the model id, so
// `--effort <level>` appends `-<level>` to `--model`, and an id already carrying one gets no flag.
export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'extra-high', 'xhigh', 'max'];

// Permission modes. Two sources, both needed: the directory's `.cursor/cli.json` denies and the
// execution-mode flag. `--auto-review` is left out — the spike did not check what it does to denies.
export const PERMISSION_MODES = ['force', 'plan', 'ask'];
export const DEFAULT_PERMISSION_MODE = 'force';

// Default model; the home is the driver, since the name belongs to the harness entirely. Claude
// Code's `opus` is refused by this binary like any other unknown id.
export const DEFAULT_MODEL = 'composer-2.5';

// Tools taken from the reviewer, as `.cursor/cli.json` rules: Cursor denies ACTIONS by pattern.
// No third rule on purpose — an unknown key was dropped silently by older schema versions.
export const REVIEWER_DENY = ['Write(**)', 'Shell(**)'];

// The `agent` version the whole analysis was taken on. NOT a binary minimum: the number names what
// was measured, because the binary updates itself and nothing here controls that.
export const PROVEN_CURSOR_VERSION = '2026.09.02';

// Ancestor variables that must not reach the participant — every harness's, not only this
// one's: a participant inherits its parent's identity and messaging otherwise (PB-182).
export const SESSION_ENV_DROP = [
  ...PARENT_SESSION_ENV.filter((n) => n !== SESSION_ENV_VAR), SESSION_ENV_VAR,
];

// PB-181, measured 2026-09-12 on a live background participant: `AskQuestion` is not
// skipped — the turn HELD 278.497 s, until a person pressed Escape. No upper bound was seen.
const CURSOR_PROMPT_TAIL = `

## Rules for this tool (Cursor)

- **Do not ask questions.** AskQuestion here is neither answered nor skipped: the turn HOLDS at the panel until someone presses a key, and nobody is at the panel. Measured on a live background session — the turn stood 278.497 s and moved only when a person pressed Escape; no upper bound was found. A fork you cannot continue without is promptobus-promptobus_send with type=question to the orchestrator, and only that.
- **An approval you cannot answer is refused in a person's name.** SwitchMode without a person comes back as \`Mode switch was rejected by the user. Do not attempt to switch modes again.\` — in under a second, with nobody there to have rejected it. Read it as the harness answering for an absent person, not as an instruction from one.
- **You have one turn at a time.** A message that arrives during a turn runs on the next turn, not inside the current one. So fetch the mailbox at the start of every turn and before you send a result.`;

/** Harness words for the adapter's human strings. `logs` is the only one that is not a command: the
 * transcript lives under the CHAT id, and entering the session ties the two more easily. */
export const PHRASES = {
  sessions: 'agent persist list',
  unreadable: 'tmux persist-session list is unreadable',
  enter: (id) => `agent persist attach ${id}`,
  stop: (id) => `agent persist stop ${id}`,
  logs: (id) => `session tape — on its screen: agent persist attach ${id}`
    + ` (the chat transcript lives in ~/.cursor/projects/<participant-directory-slug>/agent-transcripts/)`,
  // Cursor MCP tool names are namespaced with a HYPHEN — `promptobus-promptobus_send`. Taken from a
  // live run, and the participant prompt must name them that way or it looks for a tool it lacks.
  tool: (server, name) => `${server}-${name}`,
  mcpBoundary: '**MCP tools of external systems are read-only under a prompt-only guard; this harness does not mechanically deny MCP writes.**',
  promptRules: CURSOR_PROMPT_TAIL,
  // The persist session name is chosen by the binary and printed only after start. `--dry-run` must
  // say so, or a person waits in its output for a name that will never be there.
  naming: 'the persist session name is chosen by agent itself — cursor-<directory-slug>-<path-hash>-<number>-<rand6>; '
    + 'the mechanism learns it after start, together with the chat id, and prints it on lift',
};

// --- harness-neutral context into configs and argv --------------------------------
// Argv and config assembly are halves of ONE `prepare`; the caller does not build it in pieces.

/** Per-session Cursor config directory inside the participant workspace. */
const CURSOR_DIR = '.cursor';

// A self-ignoring `.gitignore` inside `.cursor/`: it applies only in this tree and travels with the
// directory. An unanchored `.cursor/` in the clone's exclude would hide personal files anywhere.

/** The Cursor skills canon at the workspace root — the only source, not `~/.cursor`: a person's
 * personal copies are not addressed to the participant. No directory means `null`. */
export function workspaceSkillsDir(root) {
  if (!root) return null;
  const src = path.join(root, CURSOR_SKILLS_REL);
  try {
    if (statSync(src).isDirectory()) return src;
  } catch {
    // No directory, or it is not a directory — the same outcome as “there was no render”.
  }
  return null;
}

function skillsCount(dir) {
  return skillDirs(dir).filter((s) => s.isSkill).length;
}

export function skillsNoteOf({ src, dest, count }) {
  if (!src) {
    return 'not attached — the workspace root has no .cursor/skills (Cursor sync render did not lay it out)';
  }
  return `${count} from ${src} → ${dest}`;
}

/** Reviewer sandbox: Cursor reads permissions, MCP and hooks from the WORKING directory, so a
 * reviewer in the clone would write three files into a foreign tree. Deterministic, not `mkdtemp`. */
export function reviewSandbox(settingsPath) {
  return `${String(settingsPath).replace(/\.settings\.json$/, '')}.cursor-sandbox`;
}

// Participant MCP config. The form matches Claude Code byte for byte; the PLACE differs — Cursor
// reads `.cursor/mcp.json` only inside a git repository, which `git init` of the sandbox supplies.
function mcpConfig({ servers }, ref) {
  const mcpServers = { ...servers };
  const bus = mcpServers[PROMPTOBUS_SERVER];
  // Cursor replaces this child's environment, so the session-record pointer and
  // warden controls travel explicitly rather than relying on launch inheritance.
  const extra = ref ? { [SESSION_ENV_VAR]: sessionFile(ref) } : {};
  for (const name of WARDEN_ENV_VARS) if (process.env[name]) extra[name] = process.env[name];
  if (bus && Object.keys(extra).length) {
    mcpServers[PROMPTOBUS_SERVER] = { ...bus, env: { ...bus.env, ...extra } };
  }
  return { mcpServers };
}

// Participant permissions, written ALWAYS — Cursor searches this file up the tree, and without its
// own a participant would inherit a foreign directory's. `allow` is required by the schema.
function cliConfig(denyTools) {
  return { permissions: { allow: [], deny: [...(denyTools ?? [])] } };
}

/** The build the list below was read from: the `_E` table of the `cursor-agent` `index.js` bundle,
 * on 2026-09-17 and with no live session. Not `PROVEN_CURSOR_VERSION` — that one dates a lift. */
export const HOOK_EVENTS_SOURCE_VERSION = '2026.09.10-fd3934a';

/** The names a live spike drove; the rest of the inventory is read from the bundle and never seen
 * firing here. A subset of `KNOWN_HOOK_EVENTS`, and the suite holds it to one. */
export const PROVEN_HOOK_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd', 'afterFileEdit'];

/** Known Cursor hook event names — a list, for the gate. An unknown event SILENTLY kills the whole
 * hooks file, so a misspelled one would lose the loop guard and the wake channel without a sound. */
export const KNOWN_HOOK_EVENTS = [
  'beforeShellExecution', 'beforeMCPExecution', 'afterShellExecution', 'afterMCPExecution',
  'beforeReadFile', 'afterFileEdit', 'beforeTabFileRead', 'afterTabFileEdit', 'stop',
  'beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'sessionStart', 'sessionEnd',
  'preCompact', 'subagentStart', 'subagentStop', 'preToolUse', 'postToolUse', 'postToolUseFailure',
  'workspaceOpen',
];

/** The hook event the loop guard stands on: `stop`, not `sessionEnd`, which does not fire at all in
 * a live session. Hooks are read only from the PROJECT `.cursor/hooks.json`. */
const GUARD_HOOK_EVENT = 'stop';

// Hooks file format version — the one that stands in the live spike configs.
const HOOKS_VERSION = 1;

function hooksFile(guardCommand) {
  return { version: HOOKS_VERSION, hooks: { [GUARD_HOOK_EVENT]: [{ command: guardCommand }] } };
}

/** Binary argv. `persist` first and it has no flags of its own; `--workspace <cwd>` ALWAYS, since it
 * overrides cwd and the chat hash; `--approve-mcps` never — it approves every server up the tree. */
function spawnArgv({
  cwd, model, effort = null, permissionMode = null, addDirs = [], prompt,
}) {
  const mode = permissionMode === 'plan' || permissionMode === 'ask' ? permissionMode : null;
  return [
    'persist',
    '--workspace', cwd,
    '--trust',
    // `--force` so non-denied tools do not wait for approval: nobody is there to answer a prompt.
    // It does not touch the read-only guarantee — deny is stronger.
    '--force',
    ...(mode ? ['--mode', mode] : []),
    '--model', effort ? `${model}-${effort}` : model,
    ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    prompt,
  ];
}

/** Lift plan from harness-neutral context; writes and launches nothing. `--plugin-dir` is not in
 * argv — Cursor has its own plugin format, and the skills canon travels as `.cursor/skills` files. */
function prepare({
  mcp, prompt, model, effort = null, permissionMode = null, addDirs = [], settingsPath,
  cwd, guardCommand, denyTools = null, root = null, ref = null, role = 'worker',
}) {
  // Reviewer cwd is the sandbox; approver launch files sit there too, but the session cwd stays the clone.
  const readOnly = role === 'reviewer' || (role !== 'approver' && !!denyTools?.length);
  const isolated = readOnly || role === 'approver';
  const configDir = isolated ? reviewSandbox(settingsPath) : cwd;
  const sessionDir = role === 'approver' ? cwd : configDir;
  const cfg = mcpConfig(mcp, ref);
  const settings = cliConfig(denyTools);
  const hooks = hooksFile(guardCommand);
  const dirs = isolated ? [...new Set([cwd, ...addDirs])] : [...addDirs];
  const files = [
    { path: path.join(configDir, CURSOR_DIR, 'mcp.json'), text: `${JSON.stringify(cfg, null, 2)}\n`, secret: true },
    { path: path.join(configDir, CURSOR_DIR, 'cli.json'), text: `${JSON.stringify(settings, null, 2)}\n`, secret: false },
    { path: path.join(configDir, CURSOR_DIR, 'hooks.json'), text: `${JSON.stringify(hooks, null, 2)}\n`, secret: false },
    { path: path.join(configDir, CURSOR_DIR, '.gitignore'), text: '*\n', secret: false },
  ];
  const src = workspaceSkillsDir(root);
  const dest = path.join(configDir, CURSOR_SKILLS_REL);
  const count = src ? skillsCount(src) : 0;
  if (src) files.push({ path: dest, copyFrom: src, text: '', secret: false });
  return {
    argv: spawnArgv({
      cwd: sessionDir, model, effort, permissionMode, addDirs: dirs, prompt,
    }),
    mcpConfig: cfg,
    settings,
    cwd: sessionDir,
    ...(role === 'approver' ? { configDir } : {}),
    // File order is write order. The MCP config carries substituted tokens of the
    // canonical servers and is therefore marked secret.
    files,
    skillsNote: skillsNoteOf({ src, dest, count }),
  };
}

const sessionEnv = sessionEnvFor(SESSION_ENV_DROP);

/** Refuse by binary version and by tmux, before the first write to disk; nothing is refused on effort
 * ([05-drivers.md § Cursor](../docs/reference/05-drivers.md#cursor-the-persist-session)). */
function optionRefusal(options, tool, { util = resolveTmux } = {}) {
  if (tool?.version && !parseVersion(tool.version)) return versionParseRefusal('Cursor', tool.version);
  if (tool?.version && versionLess(tool.version, PROVEN_CURSOR_VERSION)) {
    return `found agent ${tool.version}, and Cursor participant lift is proven on ${PROVEN_CURSOR_VERSION} and newer: `
      + 'that is the version that was measured for the agent persist layout, its tmux-session options, the stop hook firing under it, and the turn_ended shape. '
      + 'On an older binary the mechanism would lift a session it has never parsed, and would stay silent about the end of a turn. '
      + `Update: ${CURSOR_INSTALL} (the binary updates itself — one launch is enough).`;
  }
  const tmux = util();
  if (!tmux.ok) return `${tmux.reason} Without it a Cursor participant does not lift at all: the session is a tmux pane.`;
  return null;
}

/** Name of the utility lift stands on. Resolve sits next to it, in this file. */
const TMUX_UTIL = 'tmux';

// Names of delivered servers shadowed by a person's PERSONAL `~/.cursor/mcp.json`. Nothing can
// extinguish same-named entries there: project and home merge, the nearer wins, neighbours remain.
function shadowedUserServers(names) {
  return cursorMcpDuplicates(names);
}

// --- contact point and channel ------------------------------------------------------

/** Contact point of a Cursor participant: not a socket but "the session is alive and took a turn",
 * handed off by the HOOK at turn end. `socket` carries the ended-turn count, and this call owns it. */
export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    // The caller names the session: without it this is not the end of a turn. The participant bus
    // server calls the same operation at the START of a turn and has nothing to hand off.
    if (!session) return null;
    const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
    if (!file) return null;
    const record = readRecordAt(file);
    if (!record?.ref) return null;
    // Address-ownership gate: the address is bound to a session, and a foreign one
    // writes nothing for it.
    const held = foreignSession(home, task, addr, session);
    if (held) {
      sayForeignWrite(home, task, addr, held, session, 'contact-point handoff');
      return null;
    }
    const turns = (Number(record.turns) || 0) + 1;
    patchSession(record.ref, { turns, last: { endedAt: new Date().toISOString(), session } }, env);
    return writeWake(home, task, addr, { socket: `${file}#${turns}`, token: null, session });
  } catch {
    // The safety net must not drop a bus-tool call or the loop guard.
    return null;
  }
}

const sayForeignWrite = commonSayForeignWrite;
export { sayForeignWrite };

/** Channel smoke for `doctor`. The channel is a live persist session, handed off by the PARTICIPANT
 * session; the smoke does no real injection — that would cost a turn in somebody's chat. */
export function checkWake(env = process.env) {
  const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
  if (!file) return { endpoint: null, ok: false, error: `${SESSION_ENV_VAR} is empty — this session is not a Cursor participant` };
  const record = readRecordAt(file);
  if (!record) return { endpoint: file, ok: false, error: 'no session record at this path' };
  if (!record.sessionName) return { endpoint: file, ok: false, error: 'persist session is not named yet — lift is not confirmed' };
  let live;
  try {
    live = findSession(record.sessionName, { server: record.tmuxServer || CURSOR_TMUX_SERVER, env });
  } catch (e) {
    return { endpoint: file, ok: false, error: e.message };
  }
  return {
    endpoint: file,
    ok: !!live,
    error: live ? null : `persist session ${record.sessionName} is not on the tmux server`,
  };
}

// --- wake channel: the mechanism injects text into the live session, and the warden activates on a
// REWRITTEN contact point. A message arriving during a turn waits for that turn to end.

// Message frame — one for both notifications. The text rides in as a separate user message, so it
// is self-contained: it names the task, the address, and what to do.
export function orderBody(task, addr, unread, msgs = []) {
  const mailbox = PHRASES.tool(PROMPTOBUS_SERVER, 'promptobus_mailbox');
  return commonOrderBody(task, addr, unread, msgs, {
    fetchLine: `Fetch the mailbox with \`${mailbox}\`: only that tool marks messages read. `,
  });
}

export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? []);
}

/** Wake a participant by injection into its live session. Three refusals, all honest outcomes. There
 * is no "turn is running" refusal: an injection queues in the TUI, and delivery to a queue is delivery. */
export async function activate(target, notification) {
  const ref = target?.ref;
  if (!ref) return { ok: false, error: 'the participant record has no session reference — nothing to wake' };
  const record = readSession(ref);
  if (!record) return { ok: false, error: 'no session record in the Cursor registry' };
  if (!record.sessionName) return { ok: false, error: 'persist session is not named yet — lift is not confirmed' };
  const server = record.tmuxServer || CURSOR_TMUX_SERVER;
  if (!findSession(record.sessionName, { server })) {
    return {
      ok: false,
      error: `persist session ${record.sessionName} is not on the tmux server ${server} — it was stopped from outside `
        + 'or the machine rebooted (persist state lives in /tmp). Lift the participant again',
    };
  }
  const sent = await injectText(record, renderNotification(notification));
  if (!sent.ok) return { ok: false, error: sent.error };
  // Injection mark — the window where the turn has started and the transcript is still silent
  // (`turnState`). The window closes itself on the first transcript line.
  patchSession(ref, { injectedAt: new Date().toISOString() });
  return { ok: true };
}

// --- session state ------------------------------------------------------------------

/** State of one session for a snapshot. **The `stale` state appeared in Cursor**: a record with no
 * session on the server is lawful — stopped from outside, or a reboot, since state lives in `/tmp`. */
function inspect(ref) {
  const record = readSession(ref);
  if (!record) {
    return {
      state: 'gone',
      busy: false,
      stall: { kind: 'gone', reason: 'no session record in the Cursor registry' },
      id: null,
      note: null,
    };
  }
  const id = record.sessionName ?? null;
  const server = record.tmuxServer || CURSOR_TMUX_SERVER;
  const live = id ? findSession(id, { server }) : null;
  if (!live) {
    // Until the session appears in the tmux list it has no name, and "listed, but no process" about
    // a lifting session would be a lie. The word is its own, because the state is.
    if (!id) {
      return {
        state: 'alive',
        busy: true,
        stall: null,
        id: null,
        note: 'lifting — persist session is not named yet',
      };
    }
    return {
      state: 'stale',
      busy: false,
      stall: {
        kind: 'stale',
        reason: `persist session ${id} is not on the tmux server ${server} — it was stopped from outside or the machine rebooted`,
      },
      id,
      note: record.chatId ? `chat ${record.chatId}` : null,
    };
  }
  const turn = turnState(record);
  // The pane tree is expensive and is needed only by the silence guard: idle and a speaking turn do
  // not ask for children. `panePid` is already on `live` — a second findSession is not called.
  const kids = turn.busy && turn.silent
    ? toolKidsOf(live.panePid, { needles: mcpRuntimeNeedles(readParticipantMcp(record)) })
    : [];
  // The worktree is asked only where the first two signals already point at a stall: it costs two
  // git calls, and it is the signal that covers a turn editing files and spawning nothing.
  const touched = turn.busy && turn.silent && !kids.length ? worktreeTouchedMs(record) : null;
  const seen = live.attached ? `, clients in the session: ${live.attached}` : '';
  if (turn.busy) {
    const silentSec = turn.silentMs == null ? 0 : Math.round(turn.silentMs / 1000);
    const idleSec = Math.round(turnIdleMs() / 1000);
    const touchedSec = touched == null ? null : Math.round(touched / 1000);
    const working = touched != null && touched <= turnIdleMs();
    const living = turn.silent && kids.length
      ? `the turn has been silent for ${silentSec} s, processes are alive: ${kids.join(', ')}`
      : (turn.silent && working
        ? `the turn has been silent for ${silentSec} s, and the worktree was written ${touchedSec} s ago`
        : null);
    return {
      state: 'alive',
      busy: true,
      // The verdict names every measurement and its span: an orchestrator has to tell a silent
      // transcript from a dead session, and a bare "silent past the threshold" says neither.
      stall: silentIsStall(turn, kids, touched)
        ? {
          kind: 'watchdog',
          reason: `measured: the turn transcript has been silent for ${silentSec} s (threshold ${idleSec} s), `
            + 'no tool processes under the pane, and '
            + (touchedSec === null
              ? 'the worktree could not be read'
              : `nothing was written in the worktree for ${touchedSec} s`),
        }
        : null,
      id,
      note: living || `a turn is running — what arrives will run on the next turn${seen}`,
    };
  }
  if (turn.status && turn.status !== 'success') {
    return {
      state: 'alive',
      busy: false,
      stall: { kind: 'failed', reason: `the last turn ended with status ${turn.status}` },
      id,
      note: `the turn ended (${turn.status})${seen}`,
    };
  }
  if (!turn.transcript) {
    return {
      state: 'alive',
      busy: false,
      stall: { kind: 'unknown', reason: 'chat transcript is not there yet — a turn has not started' },
      id,
      note: `session is up, no turns yet${seen}`,
    };
  }
  return {
    state: 'alive',
    busy: false,
    stall: { kind: 'unknown', reason: 'the turn ended' },
    id,
    note: `the turn ended, turns in total ${record.turns ?? 0}${seen}`,
  };
}

/** What a person should do with this stall, in Cursor commands; the shared line text stays with the
 * adapter. Attach is real here, and its cost is named: tmux shrinks to the narrowest client. */
export function stallRoute({ kind, address, repoAbs, task, reviewCommand, doneCommand }, id) {
  const where = repoAbs ? `cd ${repoAbs} && ` : '';
  const review = reviewCommand;
  const done = doneCommand;
  const relift = () => (address?.startsWith('reviewer:')
    ? `lift the reviewer again: ${review}`
    : (address?.startsWith('approver:')
      ? 'Cursor cannot lift an approver — relift is not supported on this harness; lift the approver with Claude Code instead'
      : `lift the worker again with the same spawn — it will sit in its own worktree and branch`));
  if (kind === 'gone') {
    return `no session record in the registry — nobody to wake. The mechanism removed it (${done} stops `
      + `participants of a closed task). Work is handed in — that is a normal end; if it is not — ${relift()}`;
  }
  if (kind === 'stale') {
    return `the persist session is not on the tmux server: it was stopped from outside (agent persist stop, tmux kill-session) `
      + `or the machine rebooted — persist state lives in /tmp and does not survive a reboot. `
      + `Live list: ${PHRASES.sessions}. Work is not handed in — ${relift()}`;
  }
  if (kind === 'watchdog') {
    // The route has the stall KIND and nothing else: it names the signals and leaves the numbers to
    // the verdict beside it, which is the line that holds them.
    return 'none of the three liveness signals answered: the transcript is not growing, no tool process is running '
      + 'under the pane, and no write was detected in the worktree — or it could not be read. The verdict beside this '
      + `line names each measurement and its span. The session is still alive — look in and decide: ${PHRASES.enter(id)} `
      + '(leave the view with ctrl+b d, the turn is cut with ctrl+c). '
      + 'One cause of exactly this silence is a DIALOG HELD at the panel: AskQuestion without a person is neither '
      + 'answered nor skipped, and the turn stands until a key is pressed — measured 278.497 s, ended by Escape, no '
      + 'upper bound found. If that is what you see, press Escape and the turn resumes at once. '
      + 'A message queues and runs when the turn ENDS, so a held turn holds the message with it';
  }
  if (kind === 'failed') {
    return `the turn ended abnormally — look at the session tape: ${PHRASES.enter(id)}. `
      + `A wrong model id and an expired Cursor login look the same`;
  }
  if (kind === 'wake-taken') {
    return 'the session is alive, only the channel is deaf: the contact point will return to it on its next turn end. '
      + `Until then deliver the message yourself — ${where}${PHRASES.enter(id)}`;
  }
  return `the turn ended, the session is waiting for a message — the warden will wake it. Look in yourself: ${PHRASES.enter(id)}`;
}

// --- lift ---------------------------------------------------------------------------

/** Participant lift: a registry record and a live persist session. The binary arrives as a resolved
 * path; the session name is learned AFTER start, and ours is found by hash, chat id and creation time. */
async function spawn(plan, {
  tool, ref, role, cwd, env, host, home: runtimeHome, task: runtimeTask, address: runtimeAddress,
  launchFailNote = '', deadNote = '', persist, awaitOptions,
}) {
  const who = role === 'reviewer' ? 'the reviewer'
    : (role === 'approver' ? 'the approver' : 'the worker');
  const bin = tool.bin;
  const provenance = launchProvenance(host, tool);
  // The working directory is taken from the plan, not the caller's cwd: for a reviewer that is the
  // sandbox, and the same path is named in `--workspace`. The plan is what runs.
  const sessionDir = plan.cwd ?? cwd;
  const configDir = plan.configDir ?? sessionDir;
  if (configDir !== cwd) initGit(configDir);
  approveOwnServer(bin, configDir, env);
  writeSession({
    ref,
    cwd: sessionDir,
    bin,
    provenance: provenanceLine(provenance),
    mechanismPath: provenance.mechanismPath,
    mechanismPathIssue: provenance.mechanismPathIssue,
    mechanismVersion: provenance.hostVersion,
    packagePath: provenance.packagePath,
    packageVersion: provenance.packageVersion,
    packageIssue: provenance.packageIssue,
    hostVersion: provenance.hostVersion,
    binaryPath: provenance.binaryPath,
    binaryVersion: provenance.binaryVersion,
    role: role ?? null,
    startedAt: new Date().toISOString(),
    // Session name, chat, and pane pid are learned after start — lift confirmation
    // puts them.
    sessionName: null,
    chatId: null,
    panePid: null,
    tmuxServer: CURSOR_TMUX_SERVER,
    turns: 0,
    last: null,
    // Address, task, and bus home — for the session hook: it hands off the
    // “turn ended” fingerprint, and there is no other way to address the record.
    home: runtimeHome,
    task: runtimeTask,
    address: runtimeAddress,
    // Lift argv is laid in the record: a human sees what the session was lifted with,
    // and cleanup sees what to stop.
    argv: plan.argv,
  }, env);
  const lifted = await liftSession({
    ref,
    bin,
    argv: plan.argv,
    cwd: sessionDir,
    env,
    // The session mark goes into the session's own environment, and AFTER the strip:
    // `SESSION_ENV_VAR` is in the drop list, so an ancestor's mark would otherwise survive it.
    launchEnv: { ...sessionEnv(env), [SESSION_ENV_VAR]: sessionFile(ref, env) },
    task: runtimeTask,
    address: runtimeAddress,
    // The `awaitOptions` wait form is one contract — `{tries, delayMs}`: the seam comes from the
    // caller, and a second form of our own would silently ignore a foreign one.
    ...(awaitOptions ?? {}),
  });
  if (!lifted.ok) {
    dropSession(ref, env);
    fail(`${bin}: persist session did not lift (${lifted.error}) — nothing to lift ${who} with.${launchFailNote}${deadNote}`);
  }
  const { name, chatId, panePid } = lifted.session;
  patchSession(ref, { sessionName: name, chatId, panePid }, env);
  // The record carries the persist session NAME for a person — `attach` and `stop` use it. The full
  // id is the chat: the turn-end hook brings the same one, and address ownership checks against it.
  persist(name, 'alive', chatId);
  return { output: `persist session ${name} · chat ${chatId}`, session: name, seen: lifted };
}

/** Binary path as of NOW. Lift pins the version by resolving the symlink, but the binary updates
 * itself between turns and the old versioned directory vanishes, so stop resolves afresh. */
export function liveBin(recorded, { env = process.env } = {}) {
  // Search WITHOUT a version probe: `resolveToolBin` asks `--version` with a 15 s ceiling, and
  // version fitness was confirmed at lift — there is no reason to ask again at stop.
  const found = findCursorBin({ env });
  if (!found?.path) return recorded;
  try {
    return realpathSync(found.path);
  } catch {
    return found.path;
  }
}

// What is said about lift after success. This is not a refuse: the participant is
// lifted, and can be found by persist-session name and by chat id.
function saidLiftoff({ output }) {
  if (output) info(output);
}

// Empty git repository of the sandbox: without it `.cursor/mcp.json` is not read at all, and the
// reviewer would be left without the bus. No commits — the condition is a repository, not a history.
function initGit(dir) {
  if (existsSync(path.join(dir, '.git'))) return;
  run('git', ['init', '-q', dir], { encoding: 'utf8' });
}

// Pointwise approval of our own server; the record lands under the directory the call is made from,
// hence the participant directory. A refusal does not fail the lift — the missing bus calls will say.
function approveOwnServer(bin, dir, env) {
  run(bin, ['mcp', 'enable', PROMPTOBUS_SERVER], { cwd: dir, env, encoding: 'utf8' });
}

// --- stop ---------------------------------------------------------------------------

/** Stop a session. **It returns AFTER the harness no longer HAS the session.** Reap covers two kinds
 * of process: tool children of a running turn, and the `worker-server` orphan that outlives a normal end. */
async function stop(ref, waitOptions = undefined) {
  const record = readSession(ref);
  if (!record) return { ok: true, stopped: false, note: `no session «${ref}» in the Cursor registry` };
  const id = record.sessionName ?? record.chatId ?? ref;
  // An unread server says nothing about the session: stopping on it would drop a live one as gone.
  const unread = record.sessionName
    ? readTmuxSessions({ server: record.tmuxServer || CURSOR_TMUX_SERVER, env: waitOptions?.env }).missing : null;
  if (unread) return { ok: false, stopped: false, note: `${unread} — persist session ${id} was not stopped` };
  const done = await stopSession(record, { bin: liveBin(record.bin, waitOptions ?? {}), ...(waitOptions ?? {}) });
  const reaped = [
    done.kids.length ? `reaped tool children: ${done.kids.length}` : null,
    done.orphans.length ? `reaped orphans: ${done.orphans.length}` : null,
  ].filter(Boolean).join(', ');
  const tail = reaped ? `, ${reaped}` : '';
  if (record.sessionName && !done.stopped && findSession(record.sessionName, { server: record.tmuxServer || CURSOR_TMUX_SERVER })) {
    // Stop ran with nothing to confirm it. The record is not dropped: directory cleanup follows
    // this outcome, and the session must not be declared stopped.
    return {
      ok: true,
      stopped: false,
      attempted: true,
      note: `persist session ${id} did not leave the tmux server after agent persist stop${tail}`,
    };
  }
  dropSession(ref);
  return {
    ok: true,
    stopped: true,
    note: done.stopped ? `persist session ${id} stopped, record dropped${tail}`
      : `session ${id} closed — the persist session was already gone, record dropped${tail}`,
  };
}

/** Cursor driver. `attach: false` — no user attach to a foreign session; not to be confused with a
 * PERSON entering. `activation: 'push'` — text is injected into the live session, queueing if busy. */
export const cursorDriver = {
  id: CURSOR,
  capabilities: {
    spawn: true,
    attach: false,
    activation: 'push',
    inspect: true,
    stop: true,
    denyTools: true,
    systemPrompt: true,
    sessionList: true,
    enter: true,
  },
  options: {
    tool: CURSOR_TOOL,
    effortLevels: EFFORT_LEVELS,
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    denyTools: REVIEWER_DENY,
    provenVersion: PROVEN_CURSOR_VERSION,
    // The channel is an injection into a live session, not a socket and not a new process: this
    // driver's `endpoint` is no socket, and a stand-in suite channel has nothing to replace.
    knockChannel: 'inject',
    identityVar: 'CURSOR_CONVERSATION_ID',
    mcpIdentity: { recordVar: SESSION_ENV_VAR, idField: 'chatId' },
    envDrop: SESSION_ENV_DROP,
    // Utilities without which the driver will not lift a session. The driver declares the name and
    // does the resolve and version check itself — the host knows nothing about harness utilities.
    utils: [TMUX_UTIL],
    // Cursor does not read a Claude Code skills plugin. The canon travels as `.cursor/skills` files
    // that `prepare` copies into the participant directory, not through this flag.
    skillsDir: false,
    // Everything this driver writes sits under `.cursor/`, so that is where a launch path stops
    // being the working directory. Git is asked about those files, not about the directory.
    launchDirs: [CURSOR_DIR],
  },
  phrases: PHRASES,
  // Availability of the ACCOUNT, asked before any session exists — a different question with a
  // different lifetime, so it lives in its own module. The tool name is handed to it, not repeated.
  availability: cursorAvailability(CURSOR_TOOL),
  prepare,
  normalizeTool,
  spawn,
  saidLiftoff,
  inspect,
  stop,
  activate,
  renderNotification,
  stallRoute,
  registerWake,
  sayForeignWrite,
  checkWake,
  sessionEnv,
  optionRefusal,
  shadowedUserServers,
};

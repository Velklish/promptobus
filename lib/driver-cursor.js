import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fail, info } from './util.js';
import { run } from './exec.js';
import { KNOCK_TEXT_MAX, PROMPTOBUS_SERVER } from './contract.js';
import { foreignSession, logWarden, writeWake } from './store.js';
import { previewBlock } from './notification.js';
import {
  CURSOR_TMUX_SERVER, dropSession, findSession, injectText, liftSession,
  mcpRuntimeNeedles, patchSession, readParticipantMcp, readSession, SESSION_ENV_VAR, sessionFile,
  silentIsStall, stopSession, toolKidsOf, turnIdleMs, turnState, writeSession,
} from './cursor-persist.js';

// Cursor harness driver — the second production driver of the bus. This file holds
// EVERYTHING the mechanism knows about Cursor: the shape of its configs, the binary
// flags, the option vocabulary, the words of its commands, and how its session is built.
// The session registry and the talk with tmux sit one floor below, in
// [cursor-persist.js](cursor-persist.js).
//
// **What Cursor does differently from Claude Code.** The session is a live
// interactive TUI in a tmux pane, lifted by the `agent persist` subcommand: it
// outlives the parent, takes human input (`agent persist attach`), and takes mechanism
// text by keypress. The binary still has no session registry — tmux supplies that — and
// “is a turn running” is known not by the harness but by the chat transcript:
// `{"type":"turn_ended"}` is written on every transition of the session into idle.
//
// Every number and shape below was taken from live spike runs (headless and persist)
// on `agent` 2026.09.02-c22c1a3 and tmux 3.6b, not inferred from documentation:
// Cursor has no docs at all for `-p --output-format stream-json` or for `persist`.
//
// The boundary is the same as [driver-claude.js](driver-claude.js): the rest of the
// mechanism does not import this file at all — it takes the driver from the registry
// map ([drivers.js](drivers.js)), and that is guarded by the adapter-boundary gate
// ([promptobus-adapter.test.mjs](../test/promptobus-adapter.test.mjs)).

/** Harness name on the participant record and the key in the registry map. */
export const CURSOR = 'cursor';

function versionLess(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

const CURSOR_SKILLS_REL = path.join('.cursor', 'skills');
const CURSOR_INSTALL = "curl https://cursor.com/install -fsS | bash (Windows: irm 'https://cursor.com/install?win32=true' | iex)";
const CURSOR_BINS = ['agent', 'cursor-agent', 'cursor'];
const CURSOR_INSTALL_DIRS = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'];
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

function expandHomeDir(dir, home) {
  return dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir;
}

function binInDir(dir, bin) {
  const p = path.join(dir, bin);
  try {
    if (!existsSync(p)) return null;
    if (process.platform === 'win32') return p;
    if (statSync(p).mode & 0o111) return p;
  } catch { /* gone between checks */ }
  return null;
}

function findCursorBin({ env = process.env, home = homedir() } = {}) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathDirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  const extra = CURSOR_INSTALL_DIRS.map((d) => expandHomeDir(d, home));
  for (const bin of CURSOR_BINS) {
    for (const dir of [...pathDirs, ...extra]) {
      const hit = binInDir(dir.replace(/^"|"$/g, ''), bin);
      if (hit) return { path: hit };
    }
  }
  return null;
}

function resolveTmux(_name, { env = process.env } = {}) {
  const r = run('tmux', ['-V'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || (r.status !== 0 && !String(r.stdout ?? r.stderr ?? '').trim())) {
    return {
      ok: false,
      reason: 'tmux: not found in PATH. Install: brew install tmux (macOS) / your distro package (Linux).',
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

// Effort levels. In Cursor this is NOT a separate flag: the bracket form
// `--model 'x[effort=high]'` is refused even on the example from the binary's own
// `--help`, and the level is a flat SUFFIX on the model id — `cursor-grok-4.6-xhigh`,
// `claude-opus-5-thinking-max` (REPORT §4.14). Hence the driver rule: `--effort <level>`
// appends `-<level>` to `--model`.
//
// The list is from the 2026-09-03 measurement (`agent -p --model <bad id>` prints every
// available id; so does `agent models`): these suffixes are the ones that appear in ids.
// Not every model has every level: `cursor-grok-4.5` has only `low`, `medium`, `high`, and
// `extra-high` appears on one family (`gpt-5.5`). There is nothing that can check a
// “model + level” pair before lift — only the binary knows, and a bad id is refused in 2 s
// with empty stdout, without opening a chat. A level already IN the model id is not
// duplicated by a second flag: `--model cursor-grok-4.6-xhigh-fast` goes WITHOUT `--effort`.
export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'extra-high', 'xhigh', 'max'];

// Permission modes. Cursor has two sources, and both are needed: the `.cursor/cli.json`
// file of the directory (denies, held under both `--force` and `persist` — REPORT §4.5 and
// §4.7 of the second spike) and the execution-mode flag. The flag sets what does not go
// in the file: `plan` — read and plans only, `ask` — questions and explanations. `force` —
// non-denied tools do not wait for approval: in a participant session there is nobody to
// answer a permission prompt.
//
// `--auto-review` is left out of the list on purpose: the binary has the flag, but the
// spike did not check what it does to the deny config, and an undeclared mode is better
// than a declared untested one.
export const PERMISSION_MODES = ['force', 'plan', 'ask'];
export const DEFAULT_PERMISSION_MODE = 'force';

// Default model. Home is the driver: the model name belongs to the harness entirely, and
// Claude Code's `opus` is refused by the Cursor binary the same as any other unknown id.
// `composer-2.5` is Cursor's own model; most of the spike measurements were taken on it.
export const DEFAULT_MODEL = 'composer-2.5';

// Tools taken from the reviewer. The form is `.cursor/cli.json` rules, not Claude Code
// tool names: Cursor denies ACTIONS by pattern. Exactly this pair was checked live and
// holds under `persist` (spike REPORT §4.7: a turn that ran `echo` got `Permission denied`
// in a live persist session). There is no third rule here on purpose: an unknown key was
// dropped silently by older zod-schema versions, and a silently allowed write is exactly
// what this pair protects against.
export const REVIEWER_DENY = ['Write(**)', 'Shell(**)'];

// The `agent` version the whole analysis was taken on: the `persist` layout, its tmux
// session options, hook behaviour under it, the `turn_ended` shape in the transcript,
// `--workspace` behaviour, and the deny config. This is NOT a binary minimum — the number
// names what was measured, because the binary updates itself and there is no control over
// that (REPORT §4.1).
export const PROVEN_CURSOR_VERSION = '2026.09.02';

// Ancestor variables that must not reach the participant. The first is ours: the Cursor
// session mark, and a leak would write a foreign turn into this session's registry
// (contact point and process reaping read it). The rest are internal variables of the
// binary itself: they point at the socket and journal of a FOREIGN session (REPORT §4.11),
// and inherited ones send the child the wrong way.
export const SESSION_ENV_DROP = [SESSION_ENV_VAR, 'AGENT_CLI_SOCKET_PATH', 'AGENT_CLI_LOG_PATH', 'CURSOR_AGENT_SOCKET'];

/**
 * Cursor rules appended to the participant prompt. There are two, and both were measured.
 *
 * First — no questions. `AskQuestion` in a mechanism session gets not consent but a SKIP
 * (`askQuestionToolCall.result.rejected`), after which the model ends the turn in prose
 * without doing the work (REPORT §4.15). The CLI has no mechanical lever against this —
 * only the ask in the prompt.
 *
 * Second — the cost of a turn. A message that arrives during a turn queues in the session
 * and runs as a separate turn right after the current one (spike REPORT §4.3): it does
 * not enter the running turn, and a participant that ended a turn mid-sentence waits for
 * the next one.
 */
const CURSOR_PROMPT_TAIL = `

## Rules for this tool (Cursor)

- **Do not ask questions.** In this mode the AskQuestion tool does not get an answer — it gets a skip: the turn will end, the work will stay unfinished, and nobody will know. A fork you cannot continue without is promptobus-promptobus_send with type=question to the orchestrator, and only that.
- **You have one turn at a time.** A message that arrives during a turn runs on the next turn, not inside the current one. So fetch the mailbox at the start of every turn and before you send a result.`;

/**
 * Harness words for the adapter's human strings.
 *
 * All four Cursor commands now exist, and all are `persist` subcommands: the session
 * lives until stop, a human enters it, the mechanism stops it. `logs` is the only one
 * that is not a command: the transcript lives in the human's home under the CHAT id, and
 * adapter routes are built from the persist-session name, so a human ties one to the
 * other more easily by entering the session than by searching for a file.
 */
export const PHRASES = {
  sessions: 'agent persist list',
  unreadable: 'tmux persist-session list is unreadable',
  enter: (id) => `agent persist attach ${id}`,
  stop: (id) => `agent persist stop ${id}`,
  logs: (id) => `session tape — on its screen: agent persist attach ${id}`
    + ` (the chat transcript lives in ~/.cursor/projects/<participant-directory-slug>/agent-transcripts/)`,
  // Cursor MCP tool names are namespaced with a HYPHEN: `promptobus-promptobus_send`,
  // not `mcp__promptobus__promptobus_send`. The form was taken from a live run
  // (REPORT §4.17), and the participant prompt must name them that way — otherwise the
  // participant looks for a tool it does not have under that name.
  tool: (server, name) => `${server}-${name}`,
  promptRules: CURSOR_PROMPT_TAIL,
  // The persist session name is chosen not by the mechanism but by the binary itself, and
  // is printed only after start. `--dry-run` must say this out loud: otherwise a human
  // waits in its output for a name that will never be there — while the command they see
  // is the one that will run.
  naming: 'the persist session name is chosen by agent itself — cursor-<directory-slug>-<path-hash>-<number>-<rand6>; '
    + 'the mechanism learns it after start, together with the chat id, and prints it on lift',
};

// --- harness-neutral context into configs and argv --------------------------------
//
// Nothing leaks out of here: argv and config assembly are halves of ONE `prepare`
// operation, and the caller does not assemble the command in pieces.

/** Per-session Cursor config directory inside the participant workspace. */
const CURSOR_DIR = '.cursor';

// A self-ignoring `.gitignore` inside `.cursor/`: it applies only in this tree and
// travels with the directory. The clone's shared `info/exclude` is left alone — an
// unanchored `.cursor/` would hide a human's personal files at any level of the tree.

/**
 * The Cursor skills canon at the workspace root — the one `sync` lays out.
 * That is the only source, not `~/.cursor`: a human's personal copies are not addressed
 * to the participant. No directory (a workspace without a Cursor render) — `null`, the
 * participant goes without skills.
 */
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

/**
 * Reviewer sandbox: a workspace that does not dirty the clone under review.
 *
 * A Claude Code reviewer sits directly in the checked directory — its read-only is held
 * by a settings file for one lift. Cursor has no one-lift file at all: permissions, MCP,
 * and hooks are all read from the WORKING directory's `.cursor/`, so if the reviewer sat
 * in the clone the mechanism would write three files into a foreign working tree.
 * Therefore the reviewer cwd is its own directory next to the other participant files in
 * the task store, and the clone under review is attached with `--add-dir` (the same
 * trick as headless review).
 *
 * The directory is DETERMINISTIC, not `mkdtemp`: `prepare` writes and launches nothing,
 * and `--dry-run` must print exactly the path a real lift will use.
 */
export function reviewSandbox(settingsPath) {
  return `${String(settingsPath).replace(/\.settings\.json$/, '')}.cursor-sandbox`;
}

// Participant MCP config: harness-neutral server list into the form the binary reads.
// The form matches Claude Code byte for byte (`mcpServers`), but the PLACE is different:
// Cursor's project config lives in `.cursor/mcp.json` of the working directory, and is
// read only inside a git repository (REPORT §4.2). For a worker the condition holds on
// its own (a worktree is git); for a reviewer, `git init` of the sandbox at lift does it.
function mcpConfig({ servers }) {
  return { mcpServers: { ...servers } };
}

// Participant permissions: project `.cursor/cli.json`. Written ALWAYS, including to a
// worker with empty lists: Cursor searches this file up the tree, and a participant
// worktree sits inside the workspace — without its own file, participant permissions
// would be set by a foreign directory's config. `allow` is required by the schema:
// without it `agent` dies with `Invalid project config`.
function cliConfig(denyTools) {
  return { permissions: { allow: [], deny: [...(denyTools ?? [])] } };
}

/**
 * Known Cursor hook event names — a list, not a single name, and it lives here for the
 * gate.
 *
 * The cost of a wrong name is out of proportion to a typo: an unknown event in
 * `.cursor/hooks.json` SILENTLY kills the whole file — not one hook fires, including
 * the correctly named ones (spike REPORT §4.4: nine names, two of them invented, gave
 * zero hooks; after cutting to the five known names the same turns fired hooks). A
 * driver that appended a misspelled event would lose the loop guard and the wake channel
 * at once and without a sound.
 *
 * The list is the five names confirmed by live runs of both spikes. The gate on it
 * sits in the suite: the driver writes only known names, and there is one door into the
 * hooks file.
 */
export const KNOWN_HOOK_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd', 'afterFileEdit'];

/**
 * The hook event the loop guard stands on. Under `persist` this is `stop`, not
 * `sessionEnd`: a mirror of the headless path. `sessionEnd` in a live session does NOT
 * fire at all — not at the end of a turn, not on `persist stop`, not on
 * `tmux kill-session` — and `stop` fires at the end of every turn and carries
 * `session_id` (that is `chatId`), `status`, `loop_count`, turn tokens, and
 * `transcript_path` (spike REPORT §4.4). Hooks are read only from the PROJECT
 * `.cursor/hooks.json`; the `CURSOR_CONFIG_DIR` directory does not work for them, so
 * the file is laid in the participant working directory.
 */
const GUARD_HOOK_EVENT = 'stop';

// Hooks file format version — the one that stands in the live spike configs.
const HOOKS_VERSION = 1;

function hooksFile(guardCommand) {
  return { version: HOOKS_VERSION, hooks: { [GUARD_HOOK_EVENT]: [{ command: guardCommand }] } };
}

/**
 * Binary argv from the lift context.
 *
 * First comes `persist`: a participant session is a live TUI in a tmux pane, not a
 * headless turn. The subcommand has no flags of its own at all — everything after it
 * goes to the interactive `agent` as-is (spike REPORT §4.1), so the flag set is the
 * same as the headless path, minus `-p --output-format stream-json`.
 *
 * `--workspace <cwd>` is ALWAYS set and is not replaced by the process working
 * directory: it overrides cwd entirely — both the agent directory and the hash the chat
 * will sit under (REPORT §4.7). Without it the chat store would be keyed by the launch
 * directory, so the participant session would ride a foreign chat; the mechanism
 * recognises ITS session in the tmux list by that same hash.
 *
 * `--approve-mcps` is NOT here and cannot be: it approves EVERY server declared up the
 * tree, and writes the approval into a foreign project's record — a participant worktree
 * sits inside the workspace, and the flag would approve the whole canonical list there
 * in the human's name (REPORT §4.4, §11). The driver approves its own server pointwise,
 * `agent mcp enable` from the participant directory.
 *
 * The prompt is last and the only positional argument: the `--dry-run` command print
 * expects that same order.
 */
function spawnArgv({
  cwd, model, effort = null, permissionMode = null, addDirs = [], prompt,
}) {
  const mode = permissionMode === 'plan' || permissionMode === 'ask' ? permissionMode : null;
  return [
    'persist',
    '--workspace', cwd,
    '--trust',
    // `--force` — so non-denied tools do not wait for approval: there is nobody to
    // answer a permission prompt in a participant session. It does not touch the
    // read-only guarantee — deny is stronger (REPORT §4.5).
    '--force',
    ...(mode ? ['--mode', mode] : []),
    '--model', effort ? `${model}-${effort}` : model,
    ...addDirs.flatMap((dir) => ['--add-dir', dir]),
    prompt,
  ];
}

/**
 * Lift plan from harness-neutral context. Writes and launches nothing.
 *
 * `--plugin-dir` does not go into argv: Cursor has its own plugin format, and the
 * mechanism directory is a Claude Code plugin (`options.skillsDir` is therefore false
 * and the meaning does not change). The Cursor skills canon travels as files in
 * `.cursor/skills` at the workspace root: the driver asks for a copy in the participant
 * worktree. The live measurement is the “participant reads a skill” step in
 * [live-cursor.mjs](../scripts/live-cursor.mjs): the run lays a stub in the canon,
 * the participant returns its marker. Workspace `mcp.json` is not copied — spawn
 * assembles the MCP set. `sync` does not render `.cursor/rules`; `.cursor/agents` are
 * IDE subagents at the root, not a participant procedure. No directory at the root —
 * the output line says so, the participant goes without skills.
 */
function prepare({
  mcp, prompt, model, effort = null, permissionMode = null, addDirs = [], settingsPath,
  cwd, guardCommand, denyTools = null, root = null,
}) {
  // A reviewer lifts in its own sandbox, a worker — in its own worktree. The only
  // distinction is the tool strip: a read-only participant is a reviewer, and the
  // mechanism has no other.
  const readOnly = !!denyTools?.length;
  const workdir = readOnly ? reviewSandbox(settingsPath) : cwd;
  const cfg = mcpConfig(mcp);
  const settings = cliConfig(denyTools);
  const hooks = hooksFile(guardCommand);
  // The clone under review is attached to the reviewer as a read: its cwd is now the
  // sandbox.
  const dirs = readOnly ? [...new Set([cwd, ...addDirs])] : [...addDirs];
  const files = [
    { path: path.join(workdir, CURSOR_DIR, 'mcp.json'), text: `${JSON.stringify(cfg, null, 2)}\n`, secret: true },
    { path: path.join(workdir, CURSOR_DIR, 'cli.json'), text: `${JSON.stringify(settings, null, 2)}\n`, secret: false },
    { path: path.join(workdir, CURSOR_DIR, 'hooks.json'), text: `${JSON.stringify(hooks, null, 2)}\n`, secret: false },
    { path: path.join(workdir, CURSOR_DIR, '.gitignore'), text: '*\n', secret: false },
  ];
  const src = workspaceSkillsDir(root);
  const dest = path.join(workdir, CURSOR_SKILLS_REL);
  const count = src ? skillsCount(src) : 0;
  if (src) files.push({ path: dest, copyFrom: src, text: '', secret: false });
  return {
    argv: spawnArgv({
      cwd: workdir, model, effort, permissionMode, addDirs: dirs, prompt,
    }),
    mcpConfig: cfg,
    settings,
    // Session working directory: for a worker — its worktree, for a reviewer — its
    // own sandbox. The caller needs it for the same reason the driver does: `--dry-run`
    // prints the place the files will land, and printing a foreign directory would
    // promise the wrong thing.
    cwd: workdir,
    // File order is write order. The MCP config carries substituted tokens of the
    // canonical servers and is therefore marked secret.
    files,
    skillsNote: skillsNoteOf({ src, dest, count }),
  };
}

// Environment of the lifted session: on top of the inherited one, ancestor variables
// that send the child into a foreign session are stripped. What the mechanism itself
// puts (the memory-hook lever) arrives as an argument — that is not a harness property.
function sessionEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  for (const name of SESSION_ENV_DROP) delete env[name];
  return env;
}

/**
 * Refuse by binary version and by workspace composition — before the first write to disk.
 *
 * There is nothing to refuse on the requested effort: in Cursor the level is a suffix
 * of the model id, and only the binary knows whether a “model + level” pair is valid.
 * A bad id is refused in 2 s with empty stdout and a list of the available ones, without
 * opening a chat (REPORT §4.14).
 *
 * Two other refuses do exist.
 *
 * **Version.** The refuse is our own, not a shared minimum: the shared headless-path
 * threshold works on an old binary. Participant lift stands on something else: the
 * `persist` subcommand, the options it stamps on the tmux session, the `stop` hook
 * firing under it, and the `turn_ended` shape in the transcript — all of that was
 * measured on `PROVEN_CURSOR_VERSION` and on nothing else. Version unread — we do not
 * refuse: the mechanism has no right to claim “older than needed” about what it did not
 * read (the same rule as `toolVersionCheck`).
 *
 * **tmux.** `agent persist` is a wrapper over tmux, and without it a participant session
 * does not lift at all: lift would stall on “pty provider pane did not lift” after
 * the worktree, branch, and participant record were already on disk. So we ask it here,
 * next to the binary version — and in the same words as `doctor`.
 */
function optionRefusal(options, tool, { util = resolveTmux } = {}) {
  if (tool?.version && versionLess(tool.version, PROVEN_CURSOR_VERSION)) {
    return `found agent ${tool.version}, and Cursor participant lift is proven on ${PROVEN_CURSOR_VERSION} and newer: `
      + 'that is the version that was measured for the agent persist layout, its tmux-session options, the stop hook firing under it, and the turn_ended shape. '
      + 'On an older binary the mechanism would lift a session it has never parsed, and would stay silent about the end of a turn. '
      + `Update: ${CURSOR_INSTALL} (the binary updates itself — one launch is enough).`;
  }
  const tmux = util(TMUX_UTIL, { fresh: true });
  if (!tmux.ok) return `${tmux.reason} Without it a Cursor participant does not lift at all: the session is a tmux pane.`;
  return null;
}

/** Name of the utility lift stands on. Resolve sits next to it, in this file. */
const TMUX_UTIL = 'tmux';

// Names of delivered servers shadowed by the user's PERSONAL records. In Cursor the
// personal config is `~/.cursor/mcp.json`, and there is nothing that can extinguish
// same-named entries in it: project and home merge, the nearer one wins by name, but
// neighbours remain (REPORT §4.3).
function shadowedUserServers(names) {
  return cursorMcpDuplicates(names);
}

// --- contact point and channel ------------------------------------------------------

/**
 * Contact point of a Cursor participant.
 *
 * In Claude Code this is the messaging socket of a live session: a knock on it writes a
 * turn into the running session. Cursor has no socket, and there is also no way to write
 * a message into a RUNNING turn under persist: the text queues in the session and runs
 * as a separate turn right after the current one (REPORT §4.3). So contact point here
 * means something else: “the session is alive and accepted a turn”, and it is handed
 * off at the end of a turn.
 *
 * **The HOOK hands it off** (the runner used to). The reason the handoff moved to the
 * runner disappeared under persist: then a fingerprint caught by the warden in the
 * window “the hook fired, the turn is still running” led to `activate`, and that
 * honestly refused “a turn is running” — and the signal was spent. Now `activate` in
 * that window DELIVERS: an injection into a busy session is not lost, it waits its
 * turn in the queue. And the mechanism no longer has a runner that could hand off a
 * fingerprint at all — the binary itself holds the turn.
 *
 * `socket` carries the count of ended turns. The warden activates immediately when the
 * contact point is REWRITTEN (`moved` in [supervisor.ts](../src/supervisor.ts)),
 * and `writeWake` does not rewrite a file with the same contents — without the counter
 * the record would change only in the hook process `pid` field, so the wake mechanism
 * would rest on neighbouring processes having different pids. This same call owns the
 * counter: it has no other writers.
 */
export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    // The caller names the session: without it this is not the end of a turn. The
    // participant bus server calls the same operation at the START of a turn and does
    // not know its session — it has nothing to hand off.
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

// Registry record by PATH, not by ref: contact point and the channel smoke come from
// the participant process, and the driver puts the record path in their environment
// variable — they do not know the ref.
function readRecordAt(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// An address-ownership gate refuse must be VISIBLE: a silent `null` looks like healthy
// work. Write to the warden journal — the same file a human uses to work out
// “why the participant stayed silent”. Once per reason and per process.
const foreignWrites = new Set();

export function sayForeignWrite(home, task, addr, held, session, what) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} for address ${addr} is refused: the address is bound to session ${held}, `
    + `and ${session} is writing — the owner's records were left untouched`);
}

/**
 * Channel smoke for `doctor`. In Cursor the “channel” is a live persist session that
 * can take text, and it is the participant session that hands it off, not the human
 * session: a human calls `doctor` from their own terminal, and there is no Cursor
 * session mark in that environment. The smoke does not do a real injection — that would
 * cost a turn and a write into the chat of the human who asked about the layout.
 */
export function checkWake(env = process.env) {
  const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
  if (!file) return { endpoint: null, ok: false, error: `${SESSION_ENV_VAR} is empty — this session is not a Cursor participant` };
  const record = readRecordAt(file);
  if (!record) return { endpoint: file, ok: false, error: 'no session record at this path' };
  if (!record.sessionName) return { endpoint: file, ok: false, error: 'persist session is not named yet — lift is not confirmed' };
  const live = findSession(record.sessionName, { server: record.tmuxServer || CURSOR_TMUX_SERVER, env });
  return {
    endpoint: file,
    ok: !!live,
    error: live ? null : `persist session ${record.sessionName} is not on the tmux server`,
  };
}

// --- wake channel -------------------------------------------------------------------
//
// **How a Cursor participant learns about a message**. The mechanism
// injects text into its live session — the same way a human writes: a tmux buffer,
// bracketed paste, Enter ([cursor-persist.js](cursor-persist.js)). The channel is two
// halves that live in neighbouring code:
//
//   1. **The end of a turn is brought by the `stop` hook.** It calls `promptobus guard`,
//      that calls this driver's `registerWake`, and that writes a contact point with
//      the count of ended turns.
//   2. **The warden activates immediately when the contact point is REWRITTEN.** The
//      `moved` flag in [supervisor.ts](../src/supervisor.ts) compares the
//      `socket#counter` fingerprint with the previous one and, seeing a mismatch, does
//      not sit out the re-knock threshold.
//
// Hence the whole circle: a message arrived while the session is idle — the warden
// activates on unread growth, and the text starts a turn in seconds. Arrived during a
// turn — it is delivered too, and waits in the session queue until the current turn
// ends.
//
// **The gap with Claude Code narrowed, but did not vanish**:
// a message that arrives during a turn waits for that turn to end. In Claude Code it
// enters the running turn at once; here it does not, and the mechanism will not promise
// otherwise.

// Message frame — one for both notifications. The text rides into the session as a
// separate user message, so it is self-contained: it names the task, the address, and
// what to do.
const NOT_A_HUMAN = 'This is a service wake, not a human assignment, and it grants no permissions.';

/**
 * Wake text for unread. The excerpt block and its budget are shared arithmetic, and
 * they live on the [notification.js](notification.js) leaf (review note): the driver
 * keeps the frame and the tool name THIS harness uses to call the mailbox.
 */
export function orderBody(task, addr, unread, msgs = []) {
  const mailbox = PHRASES.tool(PROMPTOBUS_SERVER, 'promptobus_mailbox');
  const tail = `Fetch the mailbox with \`${mailbox}\`: only that tool marks messages read. `
    + `The working order is in the bus rules. ${NOT_A_HUMAN}`;
  return `Promptobus service wake. The mailbox for address ${addr} on task ${task} has unread: ${unread}.\n\n`
    + previewBlock(msgs, KNOCK_TEXT_MAX)
    + tail;
}

export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? []);
}

/**
 * Wake a participant — by injection into its live session.
 *
 * There are three refuses, and all three are honest outcomes, not faults: no session
 * record — nobody to wake; persist session not named — lift is not confirmed; session
 * not on the tmux server — it was stopped from outside or the machine rebooted
 * (`persist` state lives in `/tmp`).
 *
 * **There is no longer a “participant turn is running” refuse**: an injection into a
 * busy session is not lost and does not split the turn — it queues in the TUI and runs
 * as a separate turn right after the current one (REPORT §4.3). Delivery “into the
 * queue” is delivery, and the mechanism answers it with `ok`, not a refuse.
 */
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
  // Injection mark — entry into the window where the turn has already started and the
  // transcript is still silent about it (`turnState`). The window closes itself on the
  // first transcript line.
  patchSession(ref, { injectedAt: new Date().toISOString() });
  return { ok: true };
}

// --- session state ------------------------------------------------------------------

/**
 * State of one session for a snapshot.
 *
 * **The `stale` state appeared in Cursor**. Under headless it never happened under any
 * outcome: the session is a chat, and a chat outlives anything. Under persist the
 * session is a live process in a tmux pane, and “the mechanism has a record, but the
 * session is not on the server” is a lawful state: it was stopped from outside, or the
 * machine rebooted (`persist` state lives in `/tmp`). No record at all — that is
 * `gone`, as before.
 */
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
    // Until the session appears in the tmux list it has no name yet, and saying
    // “listed, but no process” about a lifting session would be a lie. The word for
    // that is its own, because the state is its own.
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
  // The pane tree is expensive (`ps -Awwo` on every inspect) and is needed only by the
  // silence guard: idle and a speaking turn do not ask children. panePid is already on
  // live — a second findSession is not called.
  const kids = turn.busy && turn.silent
    ? toolKidsOf(live.panePid, { needles: mcpRuntimeNeedles(readParticipantMcp(record)) })
    : [];
  const seen = live.attached ? `, clients in the session: ${live.attached}` : '';
  if (turn.busy) {
    const silentSec = turn.silentMs == null ? 0 : Math.round(turn.silentMs / 1000);
    const living = turn.silent && kids.length
      ? `the turn has been silent for ${silentSec} s, processes are alive: ${kids.join(', ')}`
      : null;
    return {
      state: 'alive',
      busy: true,
      stall: silentIsStall(turn, kids)
        ? {
          kind: 'watchdog',
          reason: `the turn transcript has been silent longer than ${Math.round(turnIdleMs() / 1000)} s`,
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
    note: `the turn ended, turns in total ${turn.ended}${seen}`,
  };
}

/**
 * What a human should do with this stall — in Cursor commands. The shared line text
 * (“stood”, “LISTED”, “GONE”) stays with the adapter ([stalls.js](stalls.js)); the
 * driver adds the route here.
 *
 * Human entry in Cursor is now real: `agent persist attach <session name>` shows the
 * whole tape, including mechanism injections, and holds two clients at once. The cost
 * is named where it is paid: tmux shrinks the window to the narrowest client
 * (REPORT §4.5).
 */
export function stallRoute({ kind, address, repoAbs, task }, id) {
  const where = repoAbs ? `cd ${repoAbs} && ` : '';
  const relift = () => (address?.startsWith('reviewer:')
    ? `lift the reviewer again: promptobus review "${repoAbs ?? '<clone path>'}"${task ? ` --task ${task}` : ''}`
    : `lift the worker again with the same spawn — it will sit in its own worktree and branch`);
  if (kind === 'gone') {
    return 'no session record in the registry — nobody to wake. The mechanism removed it (promptobus done stops '
      + `participants of a closed task). Work is handed in — that is a normal end; if it is not — ${relift()}`;
  }
  if (kind === 'stale') {
    return `the persist session is not on the tmux server: it was stopped from outside (agent persist stop, tmux kill-session) `
      + `or the machine rebooted — persist state lives in /tmp and does not survive a reboot. `
      + `Live list: ${PHRASES.sessions}. Work is not handed in — ${relift()}`;
  }
  if (kind === 'watchdog') {
    return `the turn has been silent past the threshold: the transcript is not growing. The session is still alive — look in and decide: `
      + `${PHRASES.enter(id)} (leave the view with ctrl+b d, the turn is cut with ctrl+c). `
      + `The message will be delivered anyway — it will queue and run on the next turn`;
  }
  if (kind === 'question') {
    return 'the turn was spent on a question: in a participant session a question gets a skip, not an answer. Nobody to answer and no need — '
      + `send the participant a direction by message, it will run on the next turn`;
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

/**
 * Participant lift: a registry record and a live persist session.
 *
 * The binary is called by the PATH OF A CONCRETE VERSION, not by a symlink: `agent`
 * updates itself on launch, and there is no control over that by flag or variable
 * (REPORT §4.1) — the `~/.local/bin/agent` symlink could have moved between the version
 * check and the launch. Resolving the symlink pins the version for the whole session;
 * the mechanism learns the actual version after the fact, from the `cursor_version`
 * field of the `stop` hook.
 *
 * The persist session name is chosen by the binary itself and is not printed in
 * advance — it is learned AFTER start, like the chat id (`--dry-run` prints what the
 * mechanism will execute, not what will come of it). The mechanism finds its session
 * by the working-directory hash, a non-empty chat id, and creation time: the
 * `cursor-agent` server is shared, and a human's persist sessions live next to it.
 */
async function spawn(plan, {
  tool, ref, role, cwd, env, home: runtimeHome, task: runtimeTask, address: runtimeAddress,
  launchFailNote = '', deadNote = '', persist, awaitOptions,
}) {
  const who = role === 'reviewer' ? 'the reviewer' : 'the worker';
  let bin = tool.bin;
  try {
    bin = realpathSync(tool.bin);
  } catch {
    // No symlink, or it is broken — call what resolve gave: the refuse will come from
    // the launch.
  }
  // The working directory is taken from the plan, not from the caller's cwd: for a
  // reviewer that is the sandbox, and the same path is named in `--workspace`. The plan
  // is what runs.
  const workdir = plan.cwd ?? cwd;
  // Per-session MCP is read only in a git directory (REPORT §4.2). For a worker the
  // condition is already met (a worktree is git); for the reviewer sandbox we meet it
  // here: an empty repository without commits, only so the bus config is read.
  if (workdir !== cwd) initGit(workdir);
  // Own bus server is approved POINTWISE. `--approve-mcps` would approve every server
  // visible up the tree and write that into a foreign project's record (REPORT §4.4,
  // §11).
  approveOwnServer(bin, workdir, env);
  writeSession({
    ref,
    cwd: workdir,
    bin,
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
    cwd: workdir,
    env,
    // The session mark goes into the session's own environment: its processes are
    // reaped by it, and its hook finds its registry record by it. Set AFTER the
    // strip — `SESSION_ENV_VAR` is in the drop list, and an ancestor mark would
    // otherwise survive the strip.
    launchEnv: { ...sessionEnv(env), [SESSION_ENV_VAR]: sessionFile(ref, env) },
    task: runtimeTask,
    address: runtimeAddress,
    // The `awaitOptions` wait form is one contract — `{tries, delayMs}` (review
    // note): the suite seam comes from the caller, not from the driver, and a second
    // form of our own would silently ignore a foreign one.
    ...(awaitOptions ?? {}),
  });
  if (!lifted.ok) {
    dropSession(ref, env);
    fail(`${bin}: persist session did not lift (${lifted.error}) — nothing to lift ${who} with.${launchFailNote}${deadNote}`);
  }
  const { name, chatId, panePid } = lifted.session;
  patchSession(ref, { sessionName: name, chatId, panePid }, env);
  // The participant record carries the persist session NAME for a human: `attach` and
  // `stop` are called by it. The full id is the chat: the turn-end hook brings the same
  // one in `session_id`, and address ownership is checked against it.
  persist(name, 'alive', chatId);
  return { output: `persist session ${name} · chat ${chatId}`, session: name, seen: lifted };
}

/**
 * Binary path as of NOW. Lift pins the version by resolving the symlink, but between
 * turns the binary manages to update itself, and the old versioned directory vanishes
 * from disk. So stop takes a fresh resolve the same way lift does.
 */
function liveBin(recorded) {
  // Search WITHOUT a version probe: `resolveToolBin` asks `--version` with a 15 s
  // ceiling, and version fitness was confirmed at lift — there is no reason to ask
  // again at stop.
  const found = findCursorBin();
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

// Empty git repository of the sandbox: without it the project `.cursor/mcp.json` is
// not read at all (REPORT §4.2), and the reviewer would be left without the bus —
// that is, without the only way to send a report. No commits: the condition is the
// presence of a repository, not a history.
function initGit(dir) {
  if (existsSync(path.join(dir, '.git'))) return;
  run('git', ['init', '-q', dir], { encoding: 'utf8' });
}

// Pointwise approval of our own server. The record lands in
// `~/.cursor/projects/<slug>/` of the directory the call is made from — that is why
// we call from the participant directory. A command refuse does not fail lift: without
// approval the server will not come up, and that will be said by the absence of bus
// calls from the session, not by silence here.
function approveOwnServer(bin, dir, env) {
  run(bin, ['mcp', 'enable', PROMPTOBUS_SERVER], { cwd: dir, env, encoding: 'utf8' });
}

// --- stop ---------------------------------------------------------------------------

/**
 * Stop a session: harness command, process reap, drop the record.
 *
 * **The operation returns AFTER the harness no longer HAS the session**: cleanup of
 * directories follows stop, and if `stop` returned before the session vanished, the
 * walk would see a running turn and lawfully leave the worktree.
 *
 * Reap covers TWO kinds of process, and both are a spike measurement (REPORT §4.8):
 * tool children of a running turn, which `persist stop` does not touch at all, and the
 * orphan `worker-server`, which lives for minutes even after a NORMAL end of a turn.
 * The second means reap is needed on an idle session too, not only on one killed
 * mid-turn.
 */
async function stop(ref, waitOptions = undefined) {
  const record = readSession(ref);
  if (!record) return { ok: true, stopped: false, note: `no session «${ref}» in the Cursor registry` };
  const id = record.sessionName ?? record.chatId ?? ref;
  const done = await stopSession(record, { bin: liveBin(record.bin), ...(waitOptions ?? {}) });
  const reaped = [
    done.kids.length ? `reaped tool children: ${done.kids.length}` : null,
    done.orphans.length ? `reaped orphans: ${done.orphans.length}` : null,
  ].filter(Boolean).join(', ');
  const tail = reaped ? `, ${reaped}` : '';
  if (record.sessionName && !done.stopped && findSession(record.sessionName, { server: record.tmuxServer || CURSOR_TMUX_SERVER })) {
    // Stop ran, and there is nothing to confirm it with. The record is not dropped:
    // directory cleanup will follow this outcome, and the session must not be declared
    // stopped.
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

/**
 * Cursor driver.
 *
 * `attach: false` — the mechanism has no user attach to a foreign session at all,
 * same as Claude. Do not confuse with `enter`: that is a HUMAN entering the session
 * from a terminal, and in Cursor that is now real (`agent persist attach`).
 *
 * `activation: 'push'` — the mechanism does deliver text into the participant's live
 * session: a TUI injection, not a new process. Delivery also goes into a running turn
 * — the text waits its turn in the queue and runs on the next turn.
 */
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
    tool: CURSOR,
    effortLevels: EFFORT_LEVELS,
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    denyTools: REVIEWER_DENY,
    provenVersion: PROVEN_CURSOR_VERSION,
    // The channel is an injection into a live session, not a socket and not a new
    // process: this driver's `endpoint` is not a socket at all, and there is nothing
    // here for a stand-in suite channel to replace.
    knockChannel: 'inject',
    envDrop: SESSION_ENV_DROP,
    // Utilities without which the driver will not lift a session. The driver declares
    // the name; it also does resolve and version check at option refuse — the host
    // does not know about harness utilities.
    utils: [TMUX_UTIL],
    // Cursor does not read a Claude Code skills plugin. The canon travels as
    // `.cursor/skills` files: prepare lays the copy in the participant directory, not
    // this flag. The field meaning does not change.
    skillsDir: false,
  },
  phrases: PHRASES,
  prepare,
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

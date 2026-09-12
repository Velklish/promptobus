import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fail, info, warn } from './util.js';
import { launchProvenance, provenanceLine } from './provenance.js';
import { KNOCK_TEXT_MAX, PROMPTOBUS_SERVER } from './contract.js';
import { foreignSession, logWarden, writeWake } from './store.js';
import { previewBlock } from './notification.js';
import {
  PARTICIPANT_ARGV, SESSION_ENV_VAR, dropSession, findSessionByAddress, holderAlive, holderAsk, patchSession,
  rateLimitNote, rateLimitReached, readSession, readyMs, reapHolder, sessionFile, startHolder,
  tailLog, waitReady, writeParticipantWake, writeSession, codexMcpName, codexMcpPrefix,
  bindParticipantHomeRemoval, codexMcpServers, listSessions, sessionsDir, turnWaitMs, turnIdleMs, turnFailed,
} from './codex-session.js';
import { probeCodex } from './model-routing/adapter-codex.js';
import { GateError } from '../dist/index.js';
import { GUARD_HOOK_EVENT, GUARD_START_EVENT } from '../dist/hooks.js';
import { PARENT_SESSION_ENV, WARDEN_ENV_VARS } from './session-env.js';

// Codex harness driver — the third production bus driver.
// [reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver](../docs/reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver)

export const CODEX = 'codex';

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

const CODEX_INSTALL = 'brew install --cask codex';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const PERMISSION_MODES = ['read-only', 'workspace-write'];
export const DEFAULT_PERMISSION_MODE = 'workspace-write';
export const DEFAULT_MODEL = 'gpt-5.6-sol';
export const REVIEWER_DENY = ['workspace-write'];
export const PROVEN_CODEX_VERSION = '0.146.0';
// An INHERITED `CODEX_HOME` never reaches a participant: the lift sets its own, and an
// ancestor's value would put the session back in the owner's home. `sessionEnv` drops
// it from the base environment and then honours the one the caller names explicitly.
export const SESSION_ENV_DROP = [...PARENT_SESSION_ENV];
const CODEX_DRY_RUN_COMMAND = `${CODEX} ${PARTICIPANT_ARGV.join(' ')} (prompt via turn/start request)`;

const CODEX_PROMPT_TAIL = `

## Rules for this tool (Codex)

- **Do not ask questions.** A turn that asks a question ends as a normal reply; there is nobody to wait for. A fork you cannot continue without is promptobus_send with type=question to the orchestrator, and only that.
- **Fetch the mailbox at the start of every turn and before a result.** Only mailbox marks messages read. Each bus tool call costs a turn of Codex's built-in auto-reviewer.
- This harness has no hooks. The mechanism sees the end of a turn from a protocol event, not from a file.`;

// The tool name a Codex session calls an MCP server's tool by: the config key with
// the harness's own wrapper around it. One function, because the key and the name
// the participant is told to type must never be able to drift — they agree today
// only because they are the same string built once.
//
// The key is NOT glued verbatim (PB-160). Codex exposes `mcp__<key>__<tool>` with the
// key sanitized: every character outside `[A-Za-z0-9_]` becomes `_` — measured on
// codex-cli 0.146.0, where a consumer whose CLI name carries a hyphen (key
// `acme-tools-promptobus`) saw its bus tools listed as `mcp__acme_tools_promptobus__…`.
// A participant told the raw key calls `tools.mcp__acme-tools-promptobus__promptobus_send(...)` inside Codex's `exec`
// harness, which is a subtraction, not a property: the call fails in 0 ms with no
// text before any server is reached, and the model spends its turn on CLI workarounds.
// The CONFIG key stays raw — Codex loads it with the hyphens; only the tool name is
// what Codex derives from it.
export const codexToolSegment = (s) => String(s ?? '').replace(/[^A-Za-z0-9_]/g, '_');
const mcpToolName = (server, name, prefix) => `mcp__${codexToolSegment(codexMcpName(server, prefix))}__${codexToolSegment(name)}`;

const CODEX_SESSIONS_SOURCE = 'participant threads — the registry the host names for `codex`'
  + ' (`PROMPTOBUS_CODEX_HOME` overrides it)';

function sessionsPhrase() {
  try {
    return `participant threads — ${sessionsDir()}`;
  } catch (error) {
    if (error instanceof GateError) return CODEX_SESSIONS_SOURCE;
    throw error;
  }
}

/**
 * The Codex home of the thread with this id, for a phrase an operator is meant to
 * open. A thread with no readable record is named by what its home IS rather than by
 * a path guessed from nothing — a wrong path sends the operator to the owner's home,
 * which is exactly the directory this isolation keeps them out of.
 */
function sessionHomePhrase(id) {
  try {
    return listSessions().find((r) => r.threadId === id)?.codexHome ?? "the participant's own CODEX_HOME";
  } catch {
    return "the participant's own CODEX_HOME";
  }
}

// The phrases a Codex participant is addressed by, and who else copies them.
// [reference/05-drivers.md#codex-the-phrases-a-participant-is-addressed-by](../docs/reference/05-drivers.md#codex-the-phrases-a-participant-is-addressed-by)
export const PHRASES = {
  get sessions() { return sessionsPhrase(); },
  unreadable: 'the mechanism thread registry is unreadable',
  naming: 'the thread id is chosen by app-server itself and printed on lift',
  enter: (id) => `codex resume ${id}`,
  stop: (id, doneCommand) => `stop the thread through the mechanism (${doneCommand} / another spawn after stop) — `
    + `Codex has no single-thread kill command, the app-server process holds the session; id ${id}`,
  logs: (id) => `thread ${id} rollout is written by Codex itself in ${sessionHomePhrase(id)}/sessions`
    + ' — the mechanism does not read it, and that home goes away with the session on done',
  tool: (server, name, host) => mcpToolName(server, name, codexMcpPrefix(host)),
  // The sentence says what was measured and no more. Two clauses changed with the
  // isolated home and the PB-87.3 measurement: there is no personal set beside the
  // mechanism's entries to carve out, and a disabled tool is now known to be absent
  // from the thread's inventory rather than merely configured. It stops at the
  // inventory on purpose — no client-visible method returns the tool payload of the
  // model request — so the prompt layer stays named as the layer the reviewer works
  // under.
  mcpBoundary: '**Classified MCP write tools are placed in each MCP server\'s `disabled_tools`, and this session has no MCP server but the ones the mechanism gave it — it runs in an isolated Codex home. On codex-cli 0.146.0 a tool named there is absent from the thread\'s tool inventory, measured. Every external MCP write is forbidden by this prompt as well.**',
  promptRules: CODEX_PROMPT_TAIL,
};

/** Directory inside a project that Codex reads its project layer from. */
const CODEX_DIR = '.codex';
const CODEX_SKILLS_REL = path.join(CODEX_DIR, 'skills');
const CODEX_HOOKS_REL = path.join(CODEX_DIR, 'hooks.json');

// Hooks are a PROJECT file, and the only project this participant trusts is its own
// working directory — the workspace root where `install` writes is neither (PB-180).
function codexHooksFile(command) {
  const group = () => [{ hooks: [{ type: 'command', command }] }];
  return { hooks: { [GUARD_HOOK_EVENT]: group(), [GUARD_START_EVENT]: group() } };
}
const SKILL_FILE = 'SKILL.md';
const HOMES_DIR = 'promptobus-codex-homes';

/**
 * The owner's Codex home — the only thing a participant home copies from, and read-only
 * to the mechanism. `CODEX_HOME` when the owner names one, else `~/.codex`.
 */
export function ownerCodexHome(env = process.env) {
  return String(env?.CODEX_HOME ?? '').trim() || path.join(homedir(), CODEX_DIR);
}

/** Parent of every participant home. Nothing outside it is ever removed. */
export function participantHomesRoot() {
  return path.join(tmpdir(), HOMES_DIR);
}

/**
 * The home of ONE participant. Deterministic rather than `mkdtemp`, for the same reason
 * the Cursor reviewer sandbox is: `--dry-run` writes nothing and must print the path a
 * real lift will use. The hash carries task and address in full — the readable head is
 * truncated and two long addresses would otherwise share a directory.
 */
export function participantCodexHome({ task, address }) {
  const head = `${task ?? ''}-${address ?? ''}`
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).toLowerCase();
  const hash = createHash('sha1').update(`${task ?? ''}\0${address ?? ''}`).digest('hex').slice(0, 12);
  return path.join(participantHomesRoot(), head ? `${head}-${hash}` : hash);
}

// A narrow TOML writer: strings, string arrays, and one level of string-valued table.
// That is the whole vocabulary of `[mcp_servers]` and `[projects]`, and a general
// serializer would invite values this config has no business carrying. Keys are quoted
// unless they are TOML-bare — a server key carries the consumer prefix with a hyphen,
// and a project key is an absolute path.
const TOML_BARE = /^[A-Za-z0-9_-]+$/;
const tomlString = (v) => JSON.stringify(String(v));
const tomlKey = (k) => (TOML_BARE.test(k) ? k : tomlString(k));
const tomlHeader = (...parts) => `[${parts.map(tomlKey).join('.')}]`;

function tomlTable(header, entry) {
  const lines = [tomlHeader(...header)];
  const nested = [];
  for (const [key, value] of Object.entries(entry ?? {})) {
    if (Array.isArray(value)) {
      lines.push(`${tomlKey(key)} = [${value.map(tomlString).join(', ')}]`);
      continue;
    }
    if (value && typeof value === 'object') {
      if (Object.keys(value).length) nested.push([key, value]);
      continue;
    }
    lines.push(`${tomlKey(key)} = ${tomlString(value)}`);
  }
  for (const [key, value] of nested) {
    lines.push('', tomlHeader(...header, key));
    for (const [k, v] of Object.entries(value)) lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
  }
  return lines.join('\n');
}

/**
 * `config.toml` of a participant home: the mechanism's MCP entries, and the projects it
 * trusts. There is no trust COMMAND on codex-cli 0.146.0 — the record is written to this
 * file, and its key is the project's realpath, because that is the spelling Codex
 * compares against (on macOS `/var/…` resolves to `/private/var/…`, and the unresolved
 * spelling is simply not recognised).
 */
export function codexHomeConfig({ servers = {}, trusted = [] } = {}) {
  const blocks = [
    ...Object.entries(servers).map(([name, entry]) => tomlTable(['mcp_servers', name], entry)),
    ...trusted.map((dir) => `${tomlHeader('projects', dir)}\ntrust_level = "trusted"`),
  ];
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/**
 * The spelling Codex compares a `[projects]` key against. Exported because the
 * difference between this and `path.resolve` is invisible on a directory that is not
 * reached through a symlink, and the whole point of the function is the case where it
 * is: a lift in a sandbox whose paths happen to be already resolved cannot tell the
 * two apart, so the check that can lives on this function directly.
 */
export function trustPath(dir) {
  try {
    return realpathSync(dir);
  } catch {
    // The directory is not there yet, or is unreadable. The unresolved spelling is
    // still the honest answer: a record Codex will not match is better than none,
    // because it is visible in the home and says what the mechanism intended.
    return path.resolve(dir);
  }
}

/**
 * Refuse a path that is not already OUR plain directory.
 *
 * The home path is derived from task and address, so it is predictable, and on a
 * system with a shared temporary directory a neighbour can put something at it first.
 * `mkdirSync` with `recursive` accepts an existing symlink without a word and follows
 * it: a link aimed at the owner's `~/.codex` would have the mechanism write its
 * `config.toml` over theirs. So an existing entry must be a directory, not a link, and
 * must belong to this user; anything else is a refusal, not a repair — the mechanism
 * does not remove what it did not create.
 */
function ownDirectory(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new GateError(`Codex participant home ${dir} cannot be read (${error.code ?? error.message}) — the lift does not write through it`);
  }
  if (!stat.isDirectory()) {
    throw new GateError(`Codex participant home ${dir} is not a directory (${stat.isSymbolicLink() ? 'symbolic link' : 'other file type'})`
      + ' — the lift refuses rather than write through it; remove it yourself if it is yours');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && stat.uid !== uid) {
    throw new GateError(`Codex participant home ${dir} belongs to uid ${stat.uid}, not to this user — the lift refuses to write into it`);
  }
}

/**
 * Build the home. Not a wipe: a repeat spawn at the same address writes over the
 * config of a home whose app-server may still be holding a thread, and removing the
 * tree under it would take the live session's state with it.
 *
 * A missing `auth.json` is not a refusal. An account driven by an API key in the
 * environment has no such file, and that key travels in the session environment
 * anyway — so the outcome is reported and the lift continues.
 */
export function makeParticipantHome({ dir, ownerHome = ownerCodexHome(), config = '' }) {
  // The root is checked too, and first: a link at the root redirects every home under
  // it, and checking only the leaf would walk through it to get there.
  ownDirectory(participantHomesRoot());
  mkdirSync(participantHomesRoot(), { recursive: true, mode: 0o700 });
  ownDirectory(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const target = path.join(dir, 'auth.json');
  let auth = false;
  try {
    copyFileSync(path.join(ownerHome, 'auth.json'), target);
    chmodSync(target, 0o600);
    auth = true;
  } catch {
    rmSync(target, { force: true });
  }
  const file = path.join(dir, 'config.toml');
  writeFileSync(file, config, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { dir, auth, config: file };
}

/**
 * Remove one participant home. The guard is the point: this runs on `done` and on a
 * failed lift with a path that came off a session record, and a record naming
 * `~/.codex` must take the owner's home with it under no circumstance. Only a direct
 * child of the homes root is removed.
 */
export function removeParticipantHome(dir) {
  if (!dir) return false;
  const abs = path.resolve(String(dir));
  if (path.dirname(abs) !== participantHomesRoot()) return false;
  rmSync(abs, { recursive: true, force: true });
  return true;
}

/** Remove every home under the root that no session record names.
 * [reference/05-drivers.md#bindparticipanthomeremoval--remove-every-home-under-the-root-that-no-session-record-names](../docs/reference/05-drivers.md#bindparticipanthomeremoval--remove-every-home-under-the-root-that-no-session-record-names) */
bindParticipantHomeRemoval(removeParticipantHome);

export function sweepParticipantHomes(env = process.env) {
  const root = participantHomesRoot();
  let names;
  try {
    names = readdirSync(root);
  } catch {
    // No root yet, or it is not readable: nothing of ours is in it either way.
    return [];
  }
  let live;
  try {
    live = new Set(listSessions(env).map((r) => r.codexHome).filter(Boolean));
  } catch {
    // The registry home is not declared, so no record can be read and every home here
    // would look orphaned. Sweeping on that reading would remove live sessions' homes.
    return [];
  }
  const swept = [];
  for (const name of names) {
    const dir = path.join(root, name);
    if (live.has(dir)) continue;
    if (removeParticipantHome(dir)) swept.push(dir);
  }
  return swept;
}

/**
 * The harness state of one closed participant that lives outside its worktree. Called
 * by `done` for a participant whose session is dead, with or without a worktree — a
 * reviewer has none and its home holds the same credentials copy.
 *
 * The path is taken from the session record when there still is one, and rebuilt from
 * task and address when there is not: the name is derived from exactly those two, and
 * the case this exists for is the one where the record is already gone.
 */
export function sweepParticipant(participant, taskId, env = process.env) {
  const address = participant?.metadata?.address ?? participant?.address ?? null;
  const ref = participant?.sessionRef ?? null;
  let named = null;
  try {
    named = ref ? readSession(ref, env)?.codexHome ?? null : null;
  } catch {
    named = null;
  }
  const home = named ?? (taskId && address ? participantCodexHome({ task: taskId, address }) : null);
  return removeParticipantHome(home);
}

// --- workspace skills into the participant worktree ---------------------------------

/**
 * The Codex skills canon at the workspace root — the one the consumer's `sync` lays out,
 * beside `.cursor/skills`. That is the only source: a person's copies under `~/.codex`
 * are not addressed to the participant. No directory — `null`, and the participant goes
 * without them.
 */
export function workspaceSkillsDir(root) {
  if (!root) return null;
  const src = path.join(root, CODEX_SKILLS_REL);
  try {
    if (statSync(src).isDirectory()) return src;
  } catch {
    // No directory, or it is not one — the same outcome as “there was no render”.
  }
  return null;
}

function skillsCount(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  return entries.filter((e) => e.isDirectory() && existsSync(path.join(dir, e.name, SKILL_FILE))).length;
}

/**
 * The lift line about workspace skills. One sentence for both roles: since a reviewer
 * has a working directory of its own the copy lands there too, and a count is the honest
 * answer for either participant.
 */
export function skillsNoteOf({ src, dest, count }) {
  if (!src) {
    return 'not attached — the workspace root has no .codex/skills (Codex sync render did not lay it out)';
  }
  return `${count} from ${src} → ${dest}`;
}

/** Reviewer working directory: the mechanism's own, not the tree under review.
 * [reference/05-drivers.md#reviewsandbox--reviewer-working-directory-the-mechanisms-own-not-the-tree-under-review](../docs/reference/05-drivers.md#reviewsandbox--reviewer-working-directory-the-mechanisms-own-not-the-tree-under-review) */
export function reviewSandbox(settingsPath) {
  return `${String(settingsPath).replace(/\.settings\.json$/, '')}.codex-sandbox`;
}

// Codex's deny syntax is attached to each mechanism-supplied server entry. Keep the
// canonical pair through review and attach its tool name only when the matching server
// is present. Since the participant lifts in an isolated home there is no personal set
// beside these entries for a tool to arrive undenied through.
export function mcpDenyTools(tools) {
  return tools.map(({ server, tool }) => ({ server, tool }));
}

function mcpConfig({ servers }, ref, denyTools = []) {
  const mcpServers = { ...servers };
  const disabled = new Map();
  for (const rule of denyTools ?? []) {
    if (!rule || typeof rule !== 'object') continue;
    if (typeof rule.server !== 'string' || typeof rule.tool !== 'string'
      || !rule.server || !rule.tool || rule.server === PROMPTOBUS_SERVER) continue;
    const tools = disabled.get(rule.server) ?? [];
    if (!tools.includes(rule.tool)) tools.push(rule.tool);
    disabled.set(rule.server, tools);
  }
  for (const [server, tools] of disabled) {
    const config = mcpServers[server];
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    mcpServers[server] = { ...config, disabled_tools: tools };
  }
  const bus = mcpServers[PROMPTOBUS_SERVER];
  if (bus && ref) {
    const extra = { [SESSION_ENV_VAR]: sessionFile(ref) };
    if (process.env.PROMPTOBUS_CODEX_HOME) extra.PROMPTOBUS_CODEX_HOME = process.env.PROMPTOBUS_CODEX_HOME;
    for (const name of WARDEN_ENV_VARS) {
      if (process.env[name]) extra[name] = process.env[name];
    }
    mcpServers[PROMPTOBUS_SERVER] = { ...bus, env: { ...bus.env, ...extra } };
  }
  return { mcpServers };
}

/**
 * Lift plan from harness-neutral context. Writes and launches nothing — the home the
 * plan names is built by `spawn`, where the worktree exists and its realpath can be
 * resolved.
 *
 * The Codex skills canon travels as files, the way Cursor's does: `sync` lays
 * `.codex/skills` at the workspace root, and Codex reads a project's `.codex/skills`
 * ALWAYS — trusted or not — so a copy into the working directory is enough. The
 * self-ignoring `.gitignore` beside it keeps the copy out of the worker's diff and lets
 * `done` sweep the worktree; it is written for every lift, since `.codex` is the
 * lift's own directory and a hooks file may be the only thing in it.
 *
 * A worker's working directory is its worktree, a reviewer's is a sandbox of its own
 * ([reviewSandbox](#reviewSandbox)): the copy, the `.gitignore` and — in `spawn` — the
 * trust record all follow whichever it is, and the tree under review only ever arrives
 * as a read in `addDirs`.
 */
function prepare({
  mcp, prompt, model, effort = null, permissionMode = null, addDirs = [], cwd, denyTools = null,
  ref, role = 'worker', task = null, address = null, root = null, settingsPath = null,
  guardCommand = null,
}) {
  const readOnly = !!denyTools?.length || permissionMode === 'read-only';
  const sandbox = readOnly ? 'read-only' : 'workspace-write';
  const cfg = mcpConfig(mcp, ref, denyTools);
  const home = participantCodexHome({ task, address });
  const workdir = role === 'reviewer' ? reviewSandbox(settingsPath) : cwd;
  // The tree under review is attached to the reviewer as a read — its cwd is now the
  // sandbox, and `thread/start` carries these as `runtimeWorkspaceRoots`.
  const dirs = role === 'reviewer' ? [...new Set([cwd, ...addDirs])] : [...addDirs];
  const src = workspaceSkillsDir(root);
  const dest = path.join(workdir, CODEX_SKILLS_REL);
  // The self-ignoring `.gitignore` is unconditional: `.codex` is the lift's directory
  // whatever else lands in it, and a worker's diff has no business there.
  const files = [
    { path: path.join(workdir, CODEX_DIR, '.gitignore'), text: '*\n', secret: false },
  ];
  if (guardCommand) {
    files.push({
      path: path.join(workdir, CODEX_HOOKS_REL),
      text: `${JSON.stringify(codexHooksFile(guardCommand), null, 2)}\n`,
      secret: false,
    });
  }
  if (src) files.push({ path: dest, copyFrom: src, text: '', secret: false });
  return {
    argv: PARTICIPANT_ARGV,
    prompt,
    dryRunCommand: CODEX_DRY_RUN_COMMAND,
    mcpConfig: cfg,
    settings: {
      sandbox,
      approvalPolicy: 'on-request',
      model,
      effort,
      addDirs: dirs,
    },
    // Session working directory: for a worker — its worktree, for a reviewer — its own
    // sandbox. `spawn` takes it from here rather than from the caller's cwd, and
    // `--dry-run` prints the place the files will land.
    cwd: workdir,
    files,
    skillsNote: skillsNoteOf({ src, dest, count: src ? skillsCount(src) : 0 }),
    codexHome: home,
    // Printed by `--dry-run` right after the dropped-variable line, and it has to be:
    // that line says `CODEX_HOME` is dropped from the parent, which on its own reads
    // as "the session will use ~/.codex" — the exact opposite of what happens. The
    // path is deterministic so the print is the path a real lift will use.
    envNote: `Codex home: ${home} — CODEX_HOME is dropped from the parent and set to this;`
      + " built at lift with a copy of the owner's auth.json (0600) and the mechanism MCP set,"
      + ' removed with the session',
  };
}

// Environment of a lifted session. `CODEX_HOME` is dropped from the INHERITED
// environment and then taken from `extra`, so a caller that names a home wins and an
// ancestor that happens to have one never does. Everything else merges as before.
function sessionEnv(base = process.env, extra = {}) {
  const env = { ...base };
  for (const name of SESSION_ENV_DROP) delete env[name];
  return { ...env, ...extra };
}

function optionRefusal(_options, tool) {
  if (tool?.version && versionLess(tool.version, PROVEN_CODEX_VERSION)) {
    return `found codex ${tool.version}, and participant lift is proven on ${PROVEN_CODEX_VERSION} and newer: `
      + 'that release has app-server, thread/start, turn/start and review/start. On an older binary '
      + 'the mechanism would lift a session whose protocol it has never parsed. '
      + `Update: ${CODEX_INSTALL}.`;
  }
  return null;
}

function shadowedUserServers() {
  // Nothing of the owner's is in reach to shadow: the participant lifts in its own
  // `CODEX_HOME`, and an empty home lifts no personal MCP server at all (measured on
  // codex-cli 0.146.0: `codex mcp list` there answers "No MCP servers configured yet").
  return [];
}

const foreignWrites = new Set();

export function sayForeignWrite(home, task, addr, held, session, what) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} for address ${addr} is refused: the address is bound to session ${held}, `
    + `and ${session} is writing — the owner's records were left untouched`);
}

export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
    const record = (file ? readSessionFromFile(file) : null)
      ?? findSessionByAddress(home, task, addr, env);
    if (!record?.rpcSocket) return null;
    const id = session ?? record.threadId;
    if (id) {
      const held = foreignSession(home, task, addr, id);
      if (held) {
        sayForeignWrite(home, task, addr, held, id, `contact-point handoff`);
        return null;
      }
    }
    return writeWake(home, task, addr, {
      socket: `${record.rpcSocket}#${Number(record.turns) || 0}`,
      token: null,
      session: id,
    });
  } catch {
    return null;
  }
}

export function checkWake(env = process.env) {
  const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
  if (!file) return { endpoint: null, ok: false, error: `${SESSION_ENV_VAR} is empty — this session is not a Codex participant` };
  const record = readSessionFromFile(file);
  if (!record) return { endpoint: file, ok: false, error: 'no session record at this path' };
  if (!record.threadId) return { endpoint: file, ok: false, error: 'the thread is not named yet — lift is not confirmed' };
  const live = holderAlive(record.ref, env);
  return {
    endpoint: record.rpcSocket ?? file,
    ok: live,
    error: live ? null : `no holder for thread ${record.threadId}`,
  };
}

function readSessionFromFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const NOT_A_HUMAN = 'This is a service wake, not a human assignment, and it grants no permissions.';

// `prefix` rather than a host: the wake text names the mailbox tool of ONE session,
// and the wake path has that session's record, not the host that lifted it. No
// prefix names the tool without its key — see `renderNotification` for who can
// reach that branch and why it is a sentence rather than a refusal.
export function orderBody(task, addr, unread, msgs = [], prefix = null) {
  const mailbox = prefix
    ? `\`${mcpToolName(PROMPTOBUS_SERVER, 'promptobus_mailbox', prefix)}\``
    : `this session's ${PROMPTOBUS_SERVER} mailbox tool`;
  const tail = `Fetch the mailbox with ${mailbox}: only it marks messages read. `
    + `The working order is in the bus rules. ${NOT_A_HUMAN}`;
  return `Promptobus service wake. The mailbox for address ${addr} on task ${task} has unread: ${unread}.\n\n`
    + previewBlock(msgs, KNOCK_TEXT_MAX)
    + tail;
}

/**
 * Wake text for one participant — one parameter, which is the arity the driver
 * contract declares (`src/driver.ts`). The tool name inside it is namespaced by the
 * CONSUMER, and neither this function nor a `Notification` carries a host, so the
 * namespace comes off the SESSION RECORD — the same channel the holder reads it
 * from — found by the task and address the notification names.
 *
 * `activate` never comes through here: it holds the exact record and calls
 * `orderBody` with its prefix, so a wake is never sent under a key looked up by
 * two fields. This path is the seam — `drivers.js` for a socket-knock driver, or a
 * consumer asking what the text would say — and a registry that holds no such
 * record gets the tool named without its key rather than a throw, because the seam
 * has to return a string and a wrong key would be worse than an unnamed one.
 */
export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? [], sessionPrefix(n.task, n.address));
}

/** The override key prefix of a live participant, or `null` — nothing holds one. */
function sessionPrefix(task, address, env = process.env) {
  try {
    return listSessions(env).find((r) => r.task === task && r.address === address)?.mcpPrefix ?? null;
  } catch {
    // No registry home is named at all, so there is no record to ask.
    return null;
  }
}

export async function activate(target, notification) {
  const ref = target?.ref;
  if (!ref) return { ok: false, error: 'the participant record has no session reference — nothing to wake' };
  const record = readSession(ref);
  if (!record) return { ok: false, error: `no session record «${ref}» in the Codex registry — nobody to wake` };
  if (!holderAlive(ref)) {
    return {
      ok: false,
      error: `no holder for thread ${record.threadId ?? ref} — the session is stale. Lift the participant again`,
    };
  }
  // The wake text names the mailbox tool by the override key, and the key's prefix
  // lives on the record. A record written before the prefix moved onto it carries
  // none, and there is nothing to derive one from here — the host that lifted the
  // session is long gone. So it refuses in the same shape as the line above, with
  // the same way out, rather than letting the name be built without a prefix.
  if (!record.mcpPrefix) {
    return {
      ok: false,
      error: `the session record for ${record.threadId ?? ref} predates the MCP key prefix; lift the participant again`,
    };
  }
  let st;
  try {
    st = await holderAsk(ref, 'status');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (rateLimitReached(st.rateLimits)) {
    return { ok: false, error: `Codex account limit: ${rateLimitNote(st.rateLimits) ?? 'window exhausted'} — a new turn is not started` };
  }
  const text = orderBody(notification.task, notification.address, notification.unread,
    notification.messages ?? [], record.mcpPrefix);
  try {
    // app-server accepts turn/start while another turn is running and queues the
    // input. `turn/steer` changes the running turn instead, which is not a mailbox
    // wake: mail that arrived during work belongs to the next turn.
    await holderAsk(ref, 'rpc', {
      method: 'turn/start',
      params: {
        threadId: record.threadId,
        input: [{ type: 'text', text }],
      },
      timeoutMs: turnWaitMs(),
      // The outer socket wait has to outlast the inner one, or the client hangs up
      // on a holder that is still waiting for app-server and the declared budget
      // above the 30 s default means nothing.
    }, undefined, turnWaitMs() + 1_000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function eventAgeMs(iso) {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? Date.now() - t : null;
}

function pendingRequestReason(pending) {
  const method = pending?.method ?? 'server request';
  const server = pending?.server ? ` from ${pending.server}` : '';
  const since = pending?.at ? ` since ${pending.at}` : '';
  return `waiting on ${method}${server}${since}`;
}

function inspect(ref) {
  const record = readSession(ref);
  if (!record) {
    return {
      state: 'gone',
      busy: false,
      stall: { kind: 'gone', reason: 'no session record in the Codex registry' },
      id: null,
      note: null,
    };
  }
  const id = record.threadId ?? null;
  if (record.state === 'dead') {
    return {
      state: 'stale',
      busy: false,
      stall: { kind: 'stale', reason: record.error ?? `app-server of thread ${id ?? ref} died` },
      id,
      note: null,
    };
  }
  if (!holderAlive(ref)) {
    if (!id && record.state === 'starting') {
      if (record.error) {
        return {
          state: 'stale',
          busy: false,
          stall: { kind: 'stale', reason: record.error },
          id: null,
          note: null,
        };
      }
      const started = Date.parse(record.startedAt ?? '');
      const budget = readyMs();
      if (Number.isFinite(started) && Date.now() - started > budget) {
        return {
          state: 'stale',
          busy: false,
          stall: {
            kind: 'stale',
            reason: `the holder did not name a thread within ${budget} ms`,
          },
          id: null,
          note: null,
        };
      }
      return {
        state: 'alive',
        busy: true,
        stall: null,
        id: null,
        note: 'rising — the thread is not named yet',
      };
    }
    return {
      state: 'stale',
      busy: false,
      stall: {
        kind: 'stale',
        reason: `no holder for thread ${id ?? ref} — the app-server process died, the rollout on disk is intact`,
      },
      id,
      note: record.nameSet === false ? 'thread name did not apply (unobserved outcome)' : null,
    };
  }
  const limit = rateLimitNote(record.rateLimits);
  const unknown = record.lastUnknownApproval
    ? `unknown approval request ${record.lastUnknownApproval.method}: ${record.lastUnknownApproval.why}`
    : null;
  const extra = [limit, unknown].filter(Boolean).join('; ');
  if (record.state === 'starting' || record.busy) {
    const pending = record.pendingRequest;
    if (pending?.method) {
      const why = pendingRequestReason(pending);
      const pendingAge = eventAgeMs(pending.at);
      const idleMs = turnIdleMs();
      if (pendingAge != null && pendingAge > idleMs) {
        return {
          state: 'alive',
          busy: true,
          stall: { kind: 'pending-request', reason: why },
          id,
          note: extra ? `${why} · ${extra}` : why,
        };
      }
      return {
        state: 'alive',
        busy: true,
        stall: null,
        id,
        note: extra ? `${why} · ${extra}` : why,
      };
    }
    const last = record.lastEvent ?? null;
    const lastAge = eventAgeMs(record.lastEventAt);
    const idleMs = turnIdleMs();
    if (lastAge != null && lastAge > idleMs) {
      const silentSec = Math.round(lastAge / 1000);
      const idleSec = Math.round(idleMs / 1000);
      const why = `the turn has been silent for ${silentSec} s (threshold ${idleSec} s)`
        + (last ? `, last event ${last}` : '');
      return {
        state: 'alive',
        busy: true,
        stall: { kind: 'watchdog', reason: why },
        id,
        note: extra || `silent ${silentSec} s`,
      };
    }
    const agePart = last && lastAge != null
      ? ` · last event ${last} ${Math.round(lastAge / 1000)} s ago`
      : '';
    return { state: 'alive', busy: true, stall: null, id, note: extra || `the turn is running${agePart}` };
  }
  if (turnFailed(record.lastTurn?.status)) {
    const err = record.lastTurn?.error ? `: ${record.lastTurn.error}` : '';
    const why = `the last turn ended failed${err}`;
    return {
      state: 'alive',
      busy: false,
      stall: { kind: 'failed', reason: why },
      id,
      note: extra || why,
    };
  }
  return {
    state: 'alive',
    busy: false,
    stall: record.lastUnknownApproval
      ? { kind: 'unknown-approval', reason: unknown }
      : (rateLimitReached(record.rateLimits)
        ? { kind: 'limit', reason: limit }
        : { kind: 'unknown', reason: 'the turn ended' }),
    id,
    note: extra || (record.nameSet === false ? 'thread name did not apply (unobserved outcome)' : 'the thread is idle'),
  };
}

export function stallRoute({ kind, address, repoAbs, task, reviewCommand, doneCommand, statusCommand }, id) {
  const where = repoAbs ? `cd ${repoAbs} && ` : '';
  const review = reviewCommand;
  const done = doneCommand;
  const status = statusCommand;
  const relift = () => (address?.startsWith('reviewer:')
    ? `lift the reviewer again: ${review}`
    : `lift the worker again with the same spawn --harness codex — it will sit in its own worktree`);
  if (kind === 'gone') {
    return `no session record in the registry — nobody to wake. The mechanism dropped it (${done}). `
      + `Work delivered — a normal end; not delivered — ${relift()}`;
  }
  if (kind === 'stale') {
    return `no app-server holder: the process died or the machine was rebooted. `
      + `The thread on disk is intact, but the mechanism does not resume it by itself. ${relift()}`;
  }
  if (kind === 'limit') {
    return 'no human is needed: the Codex account limit will reset itself, the mechanism does not start a new turn. '
      + `The reset is named in ${status}`;
  }
  if (kind === 'unknown-approval') {
    return 'the turn stalled on an unknown approval request type — the driver denied it and recorded this in status. '
      + `See the warden journal. ${id ? PHRASES.enter(id) : relift()}`;
  }
  if (kind === 'watchdog') {
    return 'the turn is silent past the activity budget — lastEventAt did not move. The session is still alive. '
      + `Look in: ${id ? PHRASES.enter(id) : relift()}. A later wake still queues.`;
  }
  if (kind === 'pending-request') {
    return 'a server-to-client request is still pending: the holder JSON-RPC reply is not serverRequest/resolved. '
      + `See ${status}. ${id ? PHRASES.enter(id) : relift()}`;
  }
  if (kind === 'failed') {
    return 'the last turn ended failed — the thread is still up and a later turn may succeed. '
      + `Holder log: ${id ? PHRASES.enter(id) : relift()}`;
  }
  if (kind === 'wake-taken') {
    return 'the session is alive, only the channel is deaf: the contact point will return on the next end of turn. '
      + `Until then deliver the message yourself — ${where}${id ? PHRASES.enter(id) : relift()}`;
  }
  return `the turn ended, the session waits for a message — the warden will wake it. `
    + `Look in yourself: ${id ? PHRASES.enter(id) : relift()}`;
}

async function spawn(plan, {
  tool, ref, role, cwd, env, host, home: runtimeHome, task: runtimeTask, address: runtimeAddress,
  launchFailNote = '', deadNote = '', persist,
}) {
  const who = role === 'reviewer' ? 'the reviewer' : 'the worker';
  // The working directory is taken from the plan, not from the caller's cwd: for a
  // reviewer that is its own sandbox, and the plan is what runs. Both are on disk before
  // this point — a worker's worktree is created by `spawn`, a reviewer's directory by the
  // launch file the plan always carries for it — and app-server is handed the path as the
  // thread cwd either way.
  const workdir = plan.cwd ?? cwd;
  const sandbox = plan.settings?.sandbox
    ?? (role === 'reviewer' ? 'read-only' : 'workspace-write');
  const prompt = plan.prompt;
  // Homes left by earlier participants whose record is gone. The lift is one of the two
  // moments a Codex home is provably orphaned and someone is here to notice.
  for (const dir of sweepParticipantHomes(env ?? process.env)) {
    info(`removed an orphaned Codex participant home (no session record names it): ${dir}`);
  }
  const codexHome = plan.codexHome ?? participantCodexHome({ task: runtimeTask, address: runtimeAddress });
  const provenance = launchProvenance(host, tool);
  const mcp = codexMcpServers(plan.mcpConfig?.mcpServers ?? {}, codexMcpPrefix(host));
  if (mcp.skipped.length) {
    warn(`MCP did not go to ${who} — Codex has no transport of that form: ${mcp.skipped.join(', ')}`);
  }
  writeSession({
    ref,
    cwd: workdir,
    bin: tool.bin,
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
    role: role ?? 'worker',
    startedAt: new Date().toISOString(),
    threadId: null,
    holderPid: null,
    appPid: null,
    rpcSocket: null,
    state: 'starting',
    sandbox,
    approvalPolicy: plan.settings?.approvalPolicy ?? 'on-request',
    model: plan.settings?.model,
    effort: plan.settings?.effort ?? null,
    addDirs: plan.settings?.addDirs ?? [],
    // No `mcpServers` copy on the record: the set the participant received is the
    // `config.toml` of the home named below, and a second copy nobody reads would be
    // free to drift from the file app-server actually loads.
    //
    // The home the app-server of this participant runs in. On the record because the
    // two places that remove it — `stop`, and `done` through it — hold a record and
    // nothing else.
    codexHome,
    // The override key prefix travels in the RECORD because the process that applies
    // it is the detached holder: it is handed this file and nothing else, and there is
    // no host in it to ask. Written where the host is in reach, read where the config
    // is built — so the key and the tool name in the prompt come from one value.
    mcpPrefix: codexMcpPrefix(host),
    prompt,
    name: ref,
    home: runtimeHome,
    task: runtimeTask,
    address: runtimeAddress,
    argv: plan.argv,
    hostName: String((env ?? process.env).PROMPTOBUS_HOST_NAME ?? '').trim() || undefined,
    statusHint: host?.busCommand?.(['status']),
    turns: 0,
  }, env);
  // The home is built AFTER the record, and only after it. The record is the one thing
  // that names the home for everything that later removes it, so a home built first and
  // a write that then fails would leave a credentials copy nothing has a handle on. It
  // is built here rather than in the holder because this is where the worktree exists
  // (so its realpath resolves) and where a missing credentials file or a dropped server
  // is a line the operator sees instead of a line in a detached log.
  //
  // Trust is the participant's OWN working directory and nothing else — a worker's
  // worktree, a reviewer's sandbox. It opens that project's `.codex/config.toml` and
  // `.codex/agents`, which is what a person working in that directory would get. The tree
  // under review is never it: trusting the repository being judged would let it put MCP
  // servers into the session that judges it, and it arrives as a read in `addDirs`
  // instead ([ADR-008](../docs/adr/adr-008-codex-reviewer-working-directory.md)). The
  // record goes into THIS participant's disposable home and dies with it — never into
  // the owner's `~/.codex/config.toml`.
  let built;
  try {
    built = makeParticipantHome({
      dir: codexHome,
      config: codexHomeConfig({
        servers: mcp.servers,
        trusted: [trustPath(workdir)],
      }),
    });
  } catch (error) {
    // A refusal here leaves a record with no home behind it, and the record is what the
    // rest of the mechanism would act on. It goes with the refusal.
    dropSession(ref, env);
    throw error;
  }
  if (!built.auth) {
    warn(`no auth.json in ${ownerCodexHome()} — the participant home carries no copy of the owner's credentials; `
      + 'Codex will lift only if the account is driven by an API key in the environment');
  }
  const holder = startHolder(ref, sessionEnv(env ?? process.env, { CODEX_HOME: codexHome }));
  if (Number.isInteger(holder.pid) && holder.pid > 0) {
    patchSession(ref, { holderPid: holder.pid }, env);
  }
  const lifted = await waitReady(ref, env, readyMs(env));
  if (!lifted.ok) {
    const log = lifted.log || tailLog(ref, env);
    await reapHolder(ref, env);
    dropSession(ref, env);
    removeParticipantHome(codexHome);
    fail(`${tool.bin}: Codex thread did not lift (${lifted.error}) — nothing to lift ${who} with.`
      + `${launchFailNote}${deadNote}${log ? `\n${log}` : ''}`);
  }
  const rec = lifted.record;
  persist(rec.threadId, 'alive', rec.threadId);
  writeParticipantWake(rec, env);
  registerWake(runtimeHome, runtimeTask, runtimeAddress, env, rec.threadId);
  return {
    output: `thread ${rec.threadId}`,
    session: rec.threadId,
    seen: rec,
  };
}

function saidLiftoff({ output, seen }) {
  if (output) info(output);
  info(`Codex home: ${seen?.codexHome ?? 'unnamed on the record'} — the mechanism MCP set only, the owner's auth copied in, `
    + 'removed on done; the owner ~/.codex is not written');
  info('workspace skills under ~/.agents/skills still reach the participant: that root follows HOME, not CODEX_HOME');
  info('each bus tool call costs a turn of the Codex auto-reviewer (~3.4 s and ~19 thousand input tokens)');
  info('hook trust is no longer the blocker: the lift carries --dangerously-bypass-hook-trust, so a hook in '
    + "the participant's reach needs no persisted trust — whether one is there, 03-cli § The Codex holder");
}

async function stop(ref) {
  const record = readSession(ref);
  if (!record) {
    // No record, so nothing names a home for this ref — but a stop is the other moment
    // someone is here to collect what a killed holder left behind.
    const swept = sweepParticipantHomes();
    return {
      ok: true,
      stopped: false,
      note: `no session «${ref}» in the Codex registry`
        + (swept.length ? `; ${swept.length} orphaned participant home(s) removed` : ''),
    };
  }
  const id = record.threadId ?? ref;
  const wasAlive = holderAlive(ref);
  await reapHolder(ref);
  if (holderAlive(ref)) {
    return {
      ok: true,
      stopped: false,
      attempted: true,
      note: `thread ${id} did not disappear after the holder was stopped`,
    };
  }
  dropSession(ref);
  // The home outlives nothing: the app-server it belonged to is down, and what is left
  // in it is a copy of the owner's credentials. It goes with the record, not later.
  const homeGone = removeParticipantHome(record.codexHome);
  const homeNote = record.codexHome && !homeGone
    ? `, home ${record.codexHome} left in place — it is not a participant home of this mechanism`
    : '';
  return {
    ok: true,
    stopped: true,
    note: wasAlive
      ? `thread ${id} stopped, the record dropped${homeNote}`
      : `session ${id} closed — the holder was already gone, the record dropped${homeNote}`,
  };
}

export const codexDriver = {
  id: CODEX,
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
  },
  options: {
    tool: CODEX,
    effortLevels: EFFORT_LEVELS,
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    denyTools: REVIEWER_DENY,
    provenVersion: PROVEN_CODEX_VERSION,
    // Not 'socket': knockRegistry reserves that value for a messaging socket and
    // replaces activate with a knock to it. The Codex channel is the holder RPC.
    knockChannel: 'rpc',
    identityVar: 'CODEX_THREAD_ID',
    envDrop: SESSION_ENV_DROP,
    skillsDir: false,
    // The skills copy and its self-ignoring `.gitignore` land under `.codex/` of the
    // participant's working directory, so that is where a launch path stops being the
    // working directory. Git is asked about those two paths and not about the directory:
    // a project's own `.codex/config.toml` and `.codex/agents` are exactly what the trust
    // record hands the participant to READ, and no lift touches them. The copy
    // destination is the path that matters — it is erased before the copy.
    launchDirs: [CODEX_DIR],
  },
  // The account gate, asked before any session exists ([adapter-codex.js](model-routing/adapter-codex.js)).
  // The launch context is handed over from here rather than rebuilt there, and
  // `sessionEnv` is where the isolation is decided. The home it names is the OWNER's:
  // there is no participant yet, and the account whose limit is being read is the one
  // whose `auth.json` every participant home will copy.
  availability: {
    tool: CODEX,
    probe: (request) => probeCodex(request, {
      tool: CODEX,
      env: sessionEnv(process.env, { CODEX_HOME: ownerCodexHome() }),
    }),
  },
  phrases: PHRASES,
  prepare,
  participantCodexHome,
  sweepParticipant,
  mcpDenyTools,
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

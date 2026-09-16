import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fail, info, warn } from './util.js';
import { launchProvenance, provenanceLine } from './provenance.js';
import { PROMPTOBUS_SERVER } from './contract.js';
import { foreignSession, writeWake } from './store.js';
import {
  PARTICIPANT_ARGV, SESSION_ENV_VAR, dropSession, findSessionByAddress, holderAlive, holderAsk, patchSession,
  rateLimitNote, rateLimitReached, readSession, readyMs, reapHolder, sessionFile, startHolder,
  tailLog, waitReady, writeParticipantWake, writeSession, codexMcpName, codexMcpPrefix,
  bindParticipantHomeRemoval, codexMcpServers, registrySessions, sessionsDir, turnWaitMs, turnIdleMs, turnFailed,
} from './codex-session.js';
import { probeCodex } from './model-routing/adapter-codex.js';
import { GateError } from '../dist/index.js';
import { GUARD_HOOK_EVENT, GUARD_START_EVENT } from '../dist/hooks.js';
import { PARENT_SESSION_ENV, WARDEN_ENV_VARS } from './session-env.js';
import { orderBody as commonOrderBody } from './notification.js';
import { parseVersion, readRecordAt, sayForeignWrite as commonSayForeignWrite, sessionEnvFor, versionLess, versionParseRefusal } from './driver-common.js';

// Codex harness driver — the third production bus driver.
// [reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver](../docs/reference/05-drivers.md#codex--codex-harness-driver--the-third-production-bus-driver)

export const CODEX = 'codex';

const CODEX_INSTALL = 'brew install --cask codex';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const PERMISSION_MODES = ['read-only', 'workspace-write'];
export const DEFAULT_PERMISSION_MODE = 'workspace-write';
export const DEFAULT_MODEL = 'gpt-5.6-sol';
export const REVIEWER_DENY = ['workspace-write'];
export const PROVEN_CODEX_VERSION = '0.146.0';
// An INHERITED `CODEX_HOME` never reaches a participant: the lift sets its own, and an ancestor's
// value would put the session back in the owner's home. A caller naming one explicitly still wins.
export const SESSION_ENV_DROP = [...PARENT_SESSION_ENV];
const CODEX_DRY_RUN_COMMAND = `${CODEX} ${PARTICIPANT_ARGV.join(' ')} (prompt via turn/start request)`;

const CODEX_PROMPT_TAIL = `

## Rules for this tool (Codex)

- **Do not ask questions.** A turn that asks a question ends as a normal reply; there is nobody to wait for. A fork you cannot continue without is promptobus_send with type=question to the orchestrator, and only that.
- **Fetch the mailbox at the start of every turn and before a result.** Only mailbox marks messages read. Each bus tool call costs a turn of Codex's built-in auto-reviewer.
- This harness has no hooks. The mechanism sees the end of a turn from a protocol event, not from a file.`;

// The tool name a Codex session calls an MCP server's tool by: the CONFIG key stays raw, only the
// name is sanitised — [02-host.md](../docs/reference/02-host.md#consumer-identity-inside-a-harness).
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

/** The Codex home of the thread with this id, for a phrase an operator opens. A thread with no
 * readable record is named by what its home IS: a guessed path sends them to the owner's home. */
function sessionHomePhrase(id) {
  try {
    return registrySessions().find((r) => r.threadId === id)?.codexHome ?? "the participant's own CODEX_HOME";
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
    + ' — it carries token usage, but the mechanism refuses it as throughput input because model-active time is absent; that home goes away with the session on done',
  tool: (server, name, host) => mcpToolName(server, name, codexMcpPrefix(host)),
  // The sentence says what was measured and no more: it stops at the tool inventory, because no
  // client-visible method returns the tool payload of the model request.
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

/** The owner's Codex home — the only thing a participant home copies from, and read-only to the
 * mechanism. `CODEX_HOME` when the owner names one, else `~/.codex`. */
export function ownerCodexHome(env = process.env) {
  return String(env?.CODEX_HOME ?? '').trim() || path.join(homedir(), CODEX_DIR);
}

/** Parent of every participant home. Nothing outside it is ever removed. */
export function participantHomesRoot() {
  return path.join(tmpdir(), HOMES_DIR);
}

/** The home of ONE participant. Deterministic rather than `mkdtemp`, so `--dry-run` can print the
 * path a real lift will use; the hash carries task and address in full. */
export function participantCodexHome({ task, address }) {
  const head = `${task ?? ''}-${address ?? ''}`
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).toLowerCase();
  const hash = createHash('sha1').update(`${task ?? ''}\0${address ?? ''}`).digest('hex').slice(0, 12);
  return path.join(participantHomesRoot(), head ? `${head}-${hash}` : hash);
}

// A narrow TOML writer: strings, string arrays, one level of string-valued table — the whole
// vocabulary of `[mcp_servers]` and `[projects]`. Keys are quoted unless they are TOML-bare.
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

/** `config.toml` of a participant home. There is no trust COMMAND on codex-cli 0.146.0, and the
 * `[projects]` key is the project's REALPATH — the unresolved spelling is not recognised. */
export function codexHomeConfig({ servers = {}, trusted = [] } = {}) {
  const blocks = [
    ...Object.entries(servers).map(([name, entry]) => tomlTable(['mcp_servers', name], entry)),
    ...trusted.map((dir) => `${tomlHeader('projects', dir)}\ntrust_level = "trusted"`),
  ];
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/** The spelling Codex compares a `[projects]` key against. Exported because the difference from
 * `path.resolve` is invisible except through a symlink, so the check lives on this function. */
export function trustPath(dir) {
  try {
    return realpathSync(dir);
  } catch {
    // The directory is not there yet, or is unreadable. The unresolved spelling is still the
    // honest answer: a record Codex will not match says what the mechanism intended.
    return path.resolve(dir);
  }
}

/** Refuse a path that is not already OUR plain directory: `mkdirSync` with `recursive` follows an
 * existing symlink without a word, and one aimed at `~/.codex` would overwrite the owner's config. */
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

/** Build the home. Not a wipe: a repeat spawn writes over the config of a home whose app-server may
 * still hold a thread. A missing `auth.json` is reported, not refused — an API key travels anyway. */
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

/** Remove one participant home. The guard is the point: this runs on `done` and on a failed lift
 * with a path off a record, so only a direct child of the homes root is ever removed. */
export function removeParticipantHome(dir) {
  if (!dir) return false;
  const abs = path.resolve(String(dir));
  if (path.dirname(abs) !== participantHomesRoot()) return false;
  rmSync(abs, { recursive: true, force: true });
  return true;
}

bindParticipantHomeRemoval(removeParticipantHome);

/** Remove every home under the root that no session record names.
 * [reference/05-drivers.md#sweepparticipanthomes--remove-every-home-under-the-root-that-no-session-record-names](../docs/reference/05-drivers.md#sweepparticipanthomes--remove-every-home-under-the-root-that-no-session-record-names) */
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
    live = new Set(registrySessions(env).map((r) => r.codexHome).filter(Boolean));
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

/** The harness state of one closed participant that lives outside its worktree — a reviewer has
 * none and its home holds the same credentials copy. Rebuilt from task and address when needed. */
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

/** The Codex skills canon at the workspace root — the only source, since a person's copies under
 * `~/.codex` are not addressed to the participant. No directory means `null`. */
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

/** The lift line about workspace skills. One sentence for both roles: a reviewer has a working
 * directory of its own, so the copy lands there too. */
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

// Codex's deny syntax is attached to each mechanism-supplied server entry; the tool name is attached
// only when the matching server is present. In an isolated home there is no personal set beside them.
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

/** Lift plan from harness-neutral context; writes and launches nothing. Codex reads a project's
 * `.codex/skills` ALWAYS, so a copy into the participant's own working directory is enough. */
function prepare({
  mcp, prompt, model, effort = null, permissionMode = null, addDirs = [], cwd, denyTools = null,
  ref, role = 'worker', task = null, address = null, root = null, settingsPath = null,
  guardCommand = null,
}) {
  const readOnly = role === 'reviewer' || permissionMode === 'read-only';
  const sandbox = readOnly ? 'read-only' : 'workspace-write';
  const cfg = mcpConfig(mcp, ref, denyTools);
  const home = participantCodexHome({ task, address });
  const isolated = role === 'reviewer' || role === 'approver';
  const configDir = isolated ? reviewSandbox(settingsPath) : cwd;
  const sessionDir = role === 'approver' ? cwd : configDir;
  const fileRoot = isolated ? configDir : cwd;
  const dirs = role === 'approver'
    ? [...new Set([cwd, configDir, ...addDirs])]
    : [...new Set([cwd, ...addDirs])];
  const src = workspaceSkillsDir(root);
  const dest = path.join(fileRoot, CODEX_SKILLS_REL);
  const files = [
    { path: path.join(fileRoot, CODEX_DIR, '.gitignore'), text: '*\n', secret: false },
  ];
  if (guardCommand) {
    files.push({
      path: path.join(fileRoot, CODEX_HOOKS_REL),
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
    cwd: sessionDir,
    ...(role === 'approver' ? { configDir } : {}),
    files,
    skillsNote: skillsNoteOf({ src, dest, count: src ? skillsCount(src) : 0 }),
    codexHome: home,
    // Printed right after the dropped-variable line, and it has to be: that line alone reads as
    // "the session will use ~/.codex", the exact opposite of what happens.
    envNote: `Codex home: ${home} — CODEX_HOME is dropped from the parent and set to this;`
      + " built at lift with a copy of the owner's auth.json (0600) and the mechanism MCP set,"
      + ' removed with the session',
  };
}

const sessionEnv = sessionEnvFor(SESSION_ENV_DROP);

function optionRefusal(_options, tool) {
  if (!tool?.version) return null;
  if (!parseVersion(tool.version)) return versionParseRefusal('Codex', tool.version);
  if (versionLess(tool.version, PROVEN_CODEX_VERSION)) {
    return `found codex ${tool.version}, and participant lift is proven on ${PROVEN_CODEX_VERSION} and newer: `
      + 'that release has app-server, thread/start, turn/start and review/start. On an older binary '
      + 'the mechanism would lift a session whose protocol it has never parsed. '
      + `Update: ${CODEX_INSTALL}.`;
  }
  return null;
}

function shadowedUserServers() {
  // Nothing of the owner's is in reach to shadow: the participant lifts in its own `CODEX_HOME`,
  // and an empty home lifts no personal MCP server at all (measured on codex-cli 0.146.0).
  return [];
}

const sayForeignWrite = commonSayForeignWrite;
export { sayForeignWrite };

export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    const file = String(env?.[SESSION_ENV_VAR] ?? '').trim();
    const record = (file ? readRecordAt(file) : null)
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
  const record = readRecordAt(file);
  if (!record) return { endpoint: file, ok: false, error: 'no session record at this path' };
  if (!record.threadId) return { endpoint: file, ok: false, error: 'the thread is not named yet — lift is not confirmed' };
  const live = holderAlive(record.ref, env);
  return {
    endpoint: record.rpcSocket ?? file,
    ok: live,
    error: live ? null : `no holder for thread ${record.threadId}`,
  };
}

export function orderBody(task, addr, unread, msgs = [], prefix = null) {
  const mailbox = prefix
    ? `\`${mcpToolName(PROMPTOBUS_SERVER, 'promptobus_mailbox', prefix)}\``
    : `this session's ${PROMPTOBUS_SERVER} mailbox tool`;
  return commonOrderBody(task, addr, unread, msgs, {
    fetchLine: `Fetch the mailbox with ${mailbox}: only it marks messages read. `,
  });
}

/** Wake text for one participant. The tool namespace comes off the SESSION RECORD, since neither
 * this function nor a `Notification` carries a host; `activate` holds the record and never comes here. */
export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? [], sessionPrefix(n.task, n.address));
}

/** The override key prefix of a live participant, or `null` — nothing holds one. */
function sessionPrefix(task, address, env = process.env) {
  try {
    return registrySessions(env).find((r) => r.task === task && r.address === address)?.mcpPrefix ?? null;
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
  // A record written before the prefix moved onto it carries none, and there is nothing here to
  // derive one from — so it refuses rather than letting the name be built without a prefix.
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
    // app-server accepts turn/start while a turn runs and queues the input. `turn/steer` changes
    // the running turn, which is not a mailbox wake: mail arriving during work is the next turn's.
    await holderAsk(ref, 'rpc', {
      method: 'turn/start',
      params: {
        threadId: record.threadId,
        input: [{ type: 'text', text }],
      },
      timeoutMs: turnWaitMs(),
      // The outer socket wait has to outlast the inner one, or the client hangs up on a holder
      // still waiting for app-server and the declared budget means nothing.
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
    : (address?.startsWith('approver:')
      ? 'Codex cannot lift an approver — relift is not supported on this harness; lift the approver with Claude Code instead'
      : `lift the worker again with the same spawn --harness codex — it will sit in its own worktree`));
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
  const who = role === 'reviewer' ? 'the reviewer'
    : (role === 'approver' ? 'the approver' : 'the worker');
  // The working directory is taken from the plan, not the caller's cwd: for a reviewer that is its
  // own sandbox. Both are on disk by this point, and app-server is handed the path as the thread cwd.
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
    // No `mcpServers` copy on the record — a second copy nobody reads would drift from the
    // `config.toml` app-server loads. The home is on the record: `stop` and `done` hold nothing else.
    codexHome,
    // The prefix travels in the RECORD because the process that applies it is the detached holder,
    // which is handed this file and has no host to ask. One value, two readers.
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
  // The home is built AFTER the record, which is the only thing that names it for whatever removes
  // it. Trust is the OWN working directory, never the tree under review ([ADR-008](../docs/adr/adr-008-codex-reviewer-working-directory.md)).
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
    mcpIdentity: { recordVar: SESSION_ENV_VAR, idField: 'threadId' },
    envDrop: SESSION_ENV_DROP,
    skillsDir: false,
    // Git is asked about the two paths under `.codex/`, not about the directory: a project's own
    // `.codex/config.toml` and `.codex/agents` are what the trust record hands over to READ.
    launchDirs: [CODEX_DIR],
  },
  // The account gate, asked before any session exists. The home it names is the OWNER's: there is
  // no participant yet, and its `auth.json` is what every participant home will copy.
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

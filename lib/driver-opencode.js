import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PROMPTOBUS_SERVER } from './contract.js';
import { participantSessionPath, workersDir, writeJsonAtomic } from './store.js';
import { PARENT_SESSION_ENV } from './session-env.js';
import { harnessBin } from './harness-home.js';
import { run } from './exec.js';
import { info } from './util.js';
import { createHarnessRegistry } from './harness-registry.js';
import { orderBody as commonOrderBody } from './notification.js';
import { opencodeAvailability } from './model-routing/adapter-opencode.js';
import { GateError } from '../dist/index.js';
import {
  foreignSession, wakeAddressOf, writeWake,
} from './store.js';
import { readRecordAt, sayForeignWrite as commonSayForeignWrite, sessionEnvFor } from './driver-common.js';
import {
  createSession, deleteSession, holderPassword, holderUrl, idleOutcome, pidAlive,
  portOfLog, readMessages, reapHolder, sendPrompt, startHolder, waitReady,
} from './opencode-session.js';

// OpenCode harness driver: EVERYTHING that knows about opencode lives here — the engine
// reaches it through the registry ([drivers.js](drivers.js)). Contract: 05-drivers.

/** Harness name in the participant record and the key in the registry map. */
export const OPENCODE = 'opencode';

/** Skills directory the driver names for a lift: carried by `OPENCODE_CONFIG_DIR`, so nothing of
 * the driver's lands in the participant's working directory. */
export const OPENCODE_SKILLS_REL = path.join('.opencode', 'skills');

// Allowed --permission-mode values: unattended turns run under `--auto` in the lift env; the
// denials themselves travel in the config permission map, so the list holds one mode.
export const PERMISSION_MODES = ['auto'];
export const DEFAULT_PERMISSION_MODE = 'auto';

// Effort has no mapping: `--variant` is provider-specific, and guessing it would lift the session
// on an effort nobody asked for. Any explicit value refuses in the engine on this empty list.
export const EFFORT_LEVELS = [];

// Participant model in `-m provider/model` form, measured off a live session's export. It travels
// as the config `model` default: the holder API names no model on prompt.
export const DEFAULT_MODEL = 'opencode-go/muse-spark-1.3-contributor';

// Floor for the holder API below: the shape v1 stands on, measured on 2.0.20.
export const OPENCODE_MIN_VERSION = '2.0.0';

// Tools taken from the reviewer: it reads a report on the bus and does not edit or run.
// The reviewer role itself arrives separately.
export const REVIEWER_DENY = ['edit', 'write', 'bash', 'webfetch', 'websearch'];

// Bus deny names in Claude spelling into opencode permission keys. Unmapped names pass lowercased.
const DENY_NAME_MAP = {
  Edit: 'edit', Write: 'write', NotebookEdit: 'edit', Bash: 'bash', Read: 'read',
  WebFetch: 'webfetch', WebSearch: 'websearch',
};
export function permissionDeny(denyTools) {
  const out = {};
  for (const name of denyTools ?? []) {
    const key = DENY_NAME_MAP[name] ?? String(name).toLowerCase();
    out[key] = 'deny';
  }
  return out;
}

// The bus entry's pointer at the session record a lift writes beside its config.
export const SESSION_RECORD_VAR = 'PROMPTOBUS_OPENCODE_SESSION';

// Host-classified MCP writes into opencode permission patterns, both tool-name spellings.
export function mcpDenyTools(tools) {
  const out = [];
  for (const { server, tool } of tools ?? []) {
    if (!server || !tool) continue;
    out.push(`${server}_${tool}`, `mcp__${server}__${tool}`);
  }
  return out;
}

// Parent variables that must not reach the participant: foreign harness identities and the
// participant pointers of other drivers.
export const SESSION_ENV_DROP = [...PARENT_SESSION_ENV, 'PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CODEX_SESSION'];

/** Harness words the adapter inserts into its own strings: shared prose stays with it. */
export const PHRASES = {
  sessions: 'opencode session list',
  unreadable: 'opencode session list --format json is unreadable',
  enter: (id) => (id ? `opencode --session ${id}` : 'opencode'),
  stop: (id) => (id ? `opencode session delete ${id}` : 'opencode session delete'),
  logs: () => 'the holder log beside the session record',
  // MCP tools register as `mcp__server__tool`, the same convention as Claude Code.
  tool: (_server, name) => name,
  mcpBoundary: '**Host-classified MCP write tools are denied by the harness config; the remaining external MCP surface is read-only under this prompt, the second layer.**',
  reviewerCommands: {
    isolation: 'File edits and command starts are disabled for you by the mechanism.',
    procedureSkip: 'a command start',
    record: 'you run nothing',
    gate: 'not run, because a reviewer runs nothing',
  },
  promptRules: '',
};

// Participant opencode config into the form read through `OPENCODE_CONFIG`. The bus entry of
// a bound lift carries the session-record pointer for its MCP children.
function mcpConfig({ servers }, pointer = null) {
  const mcp = {};
  for (const [name, entry] of Object.entries(servers ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.url === 'string' && entry.url) {
      mcp[name] = { type: 'remote', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}) };
    } else if (typeof entry.command === 'string' && entry.command) {
      // The bus entry carries the binary twice (`command` plus a `busArgv` head) — dedupe, or the
      // holder would exec the runtime as a script of itself.
      const args = Array.isArray(entry.args) ? entry.args : [];
      const command = args[0] === entry.command ? args : [entry.command, ...args];
      mcp[name] = {
        type: 'local',
        command,
        ...(entry.env ? { environment: entry.env } : {}),
      };
    }
  }
  const bus = mcp[PROMPTOBUS_SERVER];
  if (bus?.type === 'local' && pointer) {
    bus.environment = { ...bus.environment, [SESSION_RECORD_VAR]: pointer };
  }
  return { mcp };
}

/** The workspace skills canon: `.opencode/skills` at the workspace root. No directory — null. */
export function workspaceSkillsDir(root) {
  if (!root) return null;
  const src = path.join(root, OPENCODE_SKILLS_REL);
  try {
    return existsSync(src) ? src : null;
  } catch {
    return null;
  }
}

/** Lift plan from harness-neutral context. Writes nothing and starts nothing. */
export function prepare({
  ref, role = null, mcp, prompt, model, effort = null, permissionMode = null,
  mcpConfigPath, env = {}, denyTools = null, root = null, home = null, task = null, address = null,
}) {
  if (effort !== null && effort !== undefined) {
    throw new GateError(`--effort ${effort}: opencode maps no effort level — omit it`);
  }
  const configDir = path.dirname(mcpConfigPath);
  const holderDir = path.join(configDir, '.opencode');
  const skillsSrc = workspaceSkillsDir(root);
  const skillsDest = path.join(holderDir, 'skills');
  const password = holderPassword();
  const pointer = safeRecordPath(home, task, address, ref);
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    model: model ?? DEFAULT_MODEL,
    mcp: mcpConfig(mcp, pointer).mcp,
    ...(Object.keys(permissionDeny(denyTools)).length ? { permission: permissionDeny(denyTools) } : {}),
  };
  return {
    argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'],
    prompt,
    holder: { password, title: ref },
    env: {
      ...env,
      OPENCODE_CONFIG: mcpConfigPath,
      OPENCODE_CONFIG_DIR: holderDir,
      OPENCODE_SERVER_PASSWORD: password,
      ...(pointer ? { [SESSION_RECORD_VAR]: pointer } : {}),
    },
    mcpConfig: cfg,
    settings: cfg,
    files: [
      { path: mcpConfigPath, text: `${JSON.stringify(cfg, null, 2)}\n`, secret: true },
      ...(skillsSrc ? [{ path: skillsDest, copyFrom: skillsSrc, text: '', secret: false }] : []),
    ],
  };
}

const sessionEnv = sessionEnvFor(SESSION_ENV_DROP);

const sayForeignWrite = commonSayForeignWrite;
export { sayForeignWrite };

function optionRefusal() {
  return null;
}

// Personal servers in the person's global config shadowing canonical names.
function opencodeUserMcp(canonServerNames) {
  let names = [];
  try {
    const doc = JSON.parse(readFileSync(path.join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'));
    names = Object.keys(doc?.mcp ?? {}).sort();
  } catch {
    names = [];
  }
  const canon = new Set(canonServerNames);
  return { shadowed: names.filter((n) => canon.has(n)), extras: names.filter((n) => !canon.has(n)) };
}

function shadowedUserServers(names) {
  return opencodeUserMcp(names).shadowed;
}

// The harness session registry: ref → record path for ref-only `inspect` and `stop`.
const opencodeRegistry = createHarnessRegistry({ harness: OPENCODE });

/** Registry file key of a ref — the name `writeSession` files it under. */
export const registrySessionKey = (ref) => opencodeRegistry.sessionKey(ref);

function recordPath(home, task, address, ref = null) {
  try {
    return participantSessionPath(home, task, address);
  } catch {
    // Addresses without a file stem (the teamlead's `orchestrator` slot) fall back to the
    // lift ref: same file for every relift of it, and never a shared one.
    if (!home || !task || !ref) return null;
    try {
      const stem = String(ref).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
      return path.join(workersDir(home, task), `${stem}.session.json`);
    } catch {
      return null;
    }
  }
}

/** The pointer a lift binds before launch, or null outside a task store. */
function safeRecordPath(home, task, address, ref = null) {
  if (!home || !task || !address) return null;
  return recordPath(home, task, address, ref);
}

function readRecord(home, task, address, ref = null) {
  const file = recordPath(home, task, address, ref);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function opencodeBin(tool) {
  if (tool?.bin) return tool.bin;
  const { bin } = harnessBin(OPENCODE);
  return bin ?? OPENCODE;
}

const APPEAR_TIMEOUT_MS = 30_000;

// Lift a worker session from its plan: holder up, session created, first turn sent. The record
// binds holder port, password, holder pid and session id before the turn runs.
async function spawn(plan, {
  tool, home, task, address, cwd, env, ref,
  launchFailNote = '', persist = null,
}) {
  const bin = opencodeBin(tool);
  const file = recordPath(home, task, address, ref);
  const dir = file ? path.dirname(file) : null;
  if (dir) mkdirSync(dir, { recursive: true });
  const log = file ? `${file}.holder.log` : null;
  const runEnv = { ...(plan.env ?? env ?? {}) };
  let child;
  try {
    child = startHolder(bin, plan.argv, { cwd: plan.cwd ?? cwd, env: runEnv, log });
    const started = await new Promise((resolve) => {
      child.once('error', resolve);
      child.once('spawn', () => resolve(null));
    });
    if (started) throw started;
  } catch (error) {
    throw new GateError(`opencode serve did not start: ${error.message ?? error}.${launchFailNote}`);
  }
  if (child.pid === undefined) throw new GateError(`opencode serve did not start.${launchFailNote}`);
  // The record lands before the first holder call: a crash past this point keeps the pid, and
  // `stop` reaps by it. Later stages rewrite the same file with url, then session id.
  const record = {
    url: null, password: plan.holder?.password ?? runEnv.OPENCODE_SERVER_PASSWORD ?? null,
    sessionId: null, holderPid: child.pid, log, cwd: plan.cwd ?? cwd, started: new Date().toISOString(),
  };
  if (file) writeJsonAtomic(file, record, { mode: 0o600 });
  const fail = async (note) => {
    await reapHolder(child.pid);
    for (const gone of [file, log]) {
      if (!gone) continue;
      try { unlinkSync(gone); } catch { /* nothing bound yet */ }
    }
    throw new GateError(`${note}.${launchFailNote}`);
  };
  const url = await waitHolderUrl(child.pid, log);
  if (!url) await fail('the holder never printed its listening port');
  const password = record.password;
  if (!await waitReady(url, password, { timeoutMs: APPEAR_TIMEOUT_MS })) {
    await fail('the holder never answered its session list');
  }
  record.url = url;
  if (file) writeJsonAtomic(file, record, { mode: 0o600 });
  const created = await createSession(url, password, plan.holder?.title ?? ref);
  const sessionId = created?.data?.data?.id ?? null;
  if (!sessionId) await fail(`session create answered ${created?.status ?? 'nothing'}`);
  const sent = await sendPrompt(url, password, sessionId, plan.prompt);
  if (sent?.status !== 200) await fail(`the first turn answered ${sent?.status ?? 'nothing'}`);
  record.sessionId = sessionId;
  if (file) writeJsonAtomic(file, record, { mode: 0o600 });
  opencodeRegistry.writeSession({
    ref, recordPath: file, sessionId, home, task, address,
  });
  persist?.(sessionId, 'alive', sessionId);
  return { output: '', session: sessionId, seen: { state: 'alive', session: { id: sessionId, sessionId }, ghost: null } };
}

// The holder prints its port on stdout; `--port 0` lets it choose. A missing line after the
// ceiling is a failed lift, not a slow one.
async function waitHolderUrl(pid, log, { timeoutMs = APPEAR_TIMEOUT_MS, stepMs = 200 } = {}) {
  const edge = Date.now() + timeoutMs;
  for (;;) {
    if (!pidAlive(pid)) return null;
    try {
      const port = portOfLog(log ? readFileSync(log, 'utf8') : '');
      if (port) return holderUrl(port);
    } catch { /* log not written yet */ }
    if (Date.now() >= edge) return null;
    await new Promise((r) => { setTimeout(r, stepMs); });
  }
}

// Snapshot state, ref-only: the registry names the record. No entry — null, unknown is not
// death. Synchronous: the heartbeat takes it once a second, so the list call is one subprocess.
function inspect(ref) {
  const entry = opencodeRegistry.readSession(ref);
  const record = entry?.recordPath ? readRecordAt(entry.recordPath) : null;
  if (!record?.holderPid) return null;
  if (!pidAlive(record.holderPid)) {
    return { state: 'gone', busy: false, stall: null, id: record.sessionId ?? null, note: 'holder process is gone' };
  }
  if (!record.url || !record.sessionId) {
    return { state: 'alive', busy: true, stall: null, id: null, note: 'holder up, lift in progress' };
  }
  const list = listSessionsSync(record);
  if (list === null) {
    return { state: 'unknown', busy: false, stall: null, id: record.sessionId, note: PHRASES.unreadable };
  }
  return viewOf(record, list);
}

export function listSessionsSync(record, runFn = run) {
  const r = runFn(opencodeBin(), apiArgv(record), {
    cwd: record.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: record.password },
  });
  if (r.error || r.status !== 0) return null;
  return parseSessionList(r.stdout);
}

/** The argv reading the holder session list: one local subprocess per heartbeat. */
export function apiArgv(record) {
  return ['api', '--server', record.url, 'session.list'];
}

/** The `{data:[...]}` envelope off the list call, or null when it does not parse. */
export function parseSessionList(text) {
  try {
    const doc = JSON.parse(String(text ?? ''));
    return Array.isArray(doc?.data) ? doc.data : null;
  } catch {
    return null;
  }
}

/** The snapshot view off a list the holder answered: newest `idle` time ends the busy. */
export function viewOf(record, list) {
  const hit = (list ?? []).find((s) => s?.id === record.sessionId);
  if (!hit) {
    return { state: 'gone', busy: false, stall: null, id: record.sessionId, note: 'session left the holder list' };
  }
  const busy = !hit?.time?.idle;
  return { state: 'alive', busy, stall: null, id: record.sessionId, note: busy ? 'turn running' : 'idle' };
}

// What is said about lift after success. The holder log carries the port; the session id names
// the turn to watch.
function saidLiftoff({ output, session }) {
  if (output) info(output);
  if (session) info(`opencode session ${session} on its holder — watch it with the record beside the task`);
}

function forgetSessions() {}

// Stop a session, ref-only. Idempotent: no entry is an outcome with its own words. The session
// is deleted first — the holder is its server, and after the reap no delete would reach it.
async function stop(ref) {
  const entry = opencodeRegistry.readSession(ref);
  const record = entry?.recordPath ? readRecordAt(entry.recordPath) : null;
  if (!record) {
    opencodeRegistry.dropSession(ref);
    return { ok: true, stopped: false, note: `no opencode session record for «${ref}»` };
  }
  if (record.url && record.sessionId) {
    try {
      await deleteSession(record.url, record.password, record.sessionId);
    } catch { /* holder already gone; the reap below is the cleanup */ }
  }
  await reapHolder(record.holderPid);
  for (const gone of [entry.recordPath, record.log]) {
    try {
      if (gone) unlinkSync(gone);
    } catch { /* already gone */ }
  }
  opencodeRegistry.dropSession(ref);
  return { ok: true, stopped: true, note: `session ${record.sessionId} stopped` };
}

// Sweep the harness state of a closed task: every registry record of it is reaped and removed,
// record, log and registry entry together. A dead session never strands a holder or a password.
export async function sweepParticipant(participant, taskId, env = process.env) {
  const records = opencodeRegistry.registrySessions(env).filter((r) => r?.task === taskId);
  for (const r of records) {
    try {
      const record = r?.recordPath ? readRecordAt(r.recordPath) : null;
      if (record?.url && record?.sessionId) {
        try {
          await deleteSession(record.url, record.password, record.sessionId);
        } catch { /* already gone */ }
      }
      await reapHolder(record?.holderPid);
    } catch { /* one record never blocks the rest */ }
    for (const gone of [r?.recordPath, r?.recordPath ? `${r.recordPath}.holder.log` : null]) {
      try {
        if (gone) unlinkSync(gone);
      } catch { /* already gone */ }
    }
    try {
      opencodeRegistry.dropSession(r?.ref, env);
    } catch { /* already gone */ }
  }
  return { swept: records.length };
}

/** Contact point of an opencode participant: the session-record path. The record holds url,
 * password and session id behind mode 0600 — no secret travels the journal. */
export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    if (!session) return null;
    const file = String(env?.[SESSION_RECORD_VAR] ?? '').trim();
    if (!file) return null;
    const record = readRecordAt(file);
    if (record?.sessionId !== session) return null;
    const held = foreignSession(home, task, addr, session);
    if (held) {
      sayForeignWrite(home, task, addr, held, session, 'contact-point handoff');
      return false;
    }
    const at = wakeAddressOf(home, task, addr);
    return writeWake(home, at.task, at.address, { socket: file, token: null, session });
  } catch {
    return null;
  }
}

/** Channel smoke: the holder process is up and the record names a session. It answers no
 * turn state — an optimistic smoke for doctor/integration; `activate` is the real gate. */
export function checkWake(env = process.env) {
  const file = String(env?.[SESSION_RECORD_VAR] ?? '').trim();
  if (!file) return { endpoint: null, ok: false, error: `${SESSION_RECORD_VAR} is empty — not an opencode participant session` };
  const record = readRecordAt(file);
  if (!record?.url || !record?.sessionId) return { endpoint: file, ok: false, error: 'no holder url or session id at this path — lift is not confirmed' };
  if (!pidAlive(record.holderPid)) return { endpoint: file, ok: false, error: 'holder process is gone' };
  return { endpoint: file, ok: true, error: null };
}

export function renderNotification(n) {
  return commonOrderBody(n.task, n.address, n.unread, n.messages ?? [], {
    fetchLine: `Fetch the mailbox with \`${PHRASES.tool(PROMPTOBUS_SERVER, 'promptobus_mailbox')}\`: only that tool marks messages read. `,
  });
}

/** Wake a participant with a follow-up turn on its session. An idle session takes the text; a
 * running turn refuses honestly, and the warden falls back to self-wake and retries. */
export async function activate(target, notification) {
  const file = String(target?.endpoint ?? '').trim();
  if (!file) return { ok: false, error: 'the participant record has no contact point — nothing to wake' };
  const record = readRecordAt(file);
  if (!record?.url || !record?.sessionId) {
    return { ok: false, error: 'no holder url or session id at the contact point' };
  }
  if (!pidAlive(record.holderPid)) return { ok: false, error: 'holder process is gone — lift the participant again' };
  const messages = await readMessages(record.url, record.password, record.sessionId, 3);
  if (idleOutcome(messages?.data) === null && (messages?.data?.data?.length ?? 0) > 0) {
    return { ok: false, error: 'a turn is running — the message waits for its idle' };
  }
  const sent = await sendPrompt(record.url, record.password, record.sessionId, renderNotification(notification));
  if (sent?.status !== 200) return { ok: false, error: `the follow-up turn answered ${sent?.status ?? 'nothing'}` };
  return { ok: true };
}

/** OpenCode driver — worker, reviewer and approver lifts through a per-participant holder. */
export const opencodeDriver = {
  id: OPENCODE,
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
    tool: OPENCODE,
    effortLevels: EFFORT_LEVELS,
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    provenVersion: '2.0.20',
    denyTools: REVIEWER_DENY,
    knockChannel: 'http',
    identityVar: null,
    mcpIdentity: { recordVar: SESSION_RECORD_VAR, idField: 'sessionId' },
    envDrop: SESSION_ENV_DROP,
    launchDirs: [],
  },
  phrases: PHRASES,
  availability: opencodeAvailability(),
  prepare,
  mcpDenyTools,
  spawn,
  saidLiftoff,
  inspect,
  forgetSessions,
  stop,
  sweepParticipant,
  activate,
  renderNotification,
  registerWake,
  checkWake,
  sayForeignWrite,
  sessionEnv,
  optionRefusal,
  shadowedUserServers,
};

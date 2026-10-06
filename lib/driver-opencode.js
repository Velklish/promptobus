import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PROMPTOBUS_SERVER } from './contract.js';
import { participantSessionPath, writeJsonAtomic } from './store.js';
import { PARENT_SESSION_ENV } from './session-env.js';
import { harnessBin } from './harness-home.js';
import { run } from './exec.js';
import { opencodeAvailability } from './model-routing/adapter-opencode.js';
import { APPROVER, GateError, REVIEWER } from '../dist/index.js';
import { sessionEnvFor } from './driver-common.js';
import {
  createSession, deleteSession, holderPassword, holderUrl, pidAlive,
  portOfLog, reapHolder, sendPrompt, startHolder, waitReady,
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
      mcp[name] = {
        type: 'local',
        command: [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])],
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
  if (role === REVIEWER || role === APPROVER) {
    throw new GateError(`${role} lift on opencode is not declared yet — worker only`);
  }
  if (effort !== null && effort !== undefined) {
    throw new GateError(`--effort ${effort}: opencode maps no effort level — omit it`);
  }
  const configDir = path.dirname(mcpConfigPath);
  const holderDir = path.join(configDir, '.opencode');
  const skillsSrc = workspaceSkillsDir(root);
  const skillsDest = path.join(holderDir, 'skills');
  const password = holderPassword();
  const pointer = safeRecordPath(home, task, address);
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

function recordPath(home, task, address) {
  try {
    return participantSessionPath(home, task, address);
  } catch {
    return null;
  }
}

/** The pointer a lift binds before launch, or null outside a task store. */
function safeRecordPath(home, task, address) {
  if (!home || !task || !address) return null;
  return recordPath(home, task, address);
}

function readRecord(home, task, address) {
  const file = recordPath(home, task, address);
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
  const file = recordPath(home, task, address);
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

// Snapshot state: holder-process liveness plus the message-tail busy signal. No record — null.
// Synchronous: the heartbeat takes it once a second, so the list call is one local subprocess.
function inspect(ref, { home, task, address } = {}) {
  const record = (home && task && address) ? readRecord(home, task, address) : null;
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

function forgetSessions() {}

// Stop a worker session. Idempotent: no record is an outcome with its own words. The session is
// deleted first — the holder is its server, and after the reap no delete would reach it.
async function stop(ref, { home, task, address } = {}) {
  const file = (home && task && address) ? recordPath(home, task, address) : null;
  const record = file ? readRecord(home, task, address) : null;
  if (!record) return { ok: true, stopped: false, note: `no opencode session record for «${ref}»` };
  if (record.url && record.sessionId) {
    try {
      await deleteSession(record.url, record.password, record.sessionId);
    } catch { /* holder already gone; the reap below is the cleanup */ }
  }
  await reapHolder(record.holderPid);
  for (const gone of [file, record.log]) {
    try {
      if (gone) unlinkSync(gone);
    } catch { /* already gone */ }
  }
  return { ok: true, stopped: true, note: `session ${record.sessionId} stopped` };
}

/** OpenCode driver — worker lift through a per-participant `serve` holder; activation is `pull`. */
export const opencodeDriver = {
  id: OPENCODE,
  capabilities: {
    spawn: true,
    attach: false,
    activation: 'pull',
    inspect: true,
    stop: true,
    denyTools: true,
    systemPrompt: true,
    sessionList: true,
    enter: true,
  },
  options: {
    tool: OPENCODE,
    effortLevels: EFFORT_LEVELS,
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    provenVersion: '2.0.20',
    denyTools: REVIEWER_DENY,
    knockChannel: 'pull',
    identityVar: null,
    mcpIdentity: { recordVar: SESSION_RECORD_VAR, idField: 'sessionId' },
    envDrop: SESSION_ENV_DROP,
    launchDirs: [],
  },
  phrases: PHRASES,
  availability: opencodeAvailability(),
  prepare,
  spawn,
  inspect,
  forgetSessions,
  stop,
  sessionEnv,
  optionRefusal,
  shadowedUserServers,
};

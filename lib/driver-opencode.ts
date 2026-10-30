import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PROMPTOBUS_SERVER } from './contract.js';
import { selectedNativeFiles } from './native-participant-context.js';
import { addressOf, participantSessionPath, workersDir, writeJsonAtomic } from './store.js';
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
  createSession, deleteSession, holderPassword, holderRequestSync, holderUrl, idleOutcome,
  listPermissions, parsePermissionList, pidAlive, portOfLog, readMessages, reapHolder,
  replyPermission, sendPrompt, startHolder, waitReady,
} from './opencode-session.js';

import type { ActivationTarget, HostMcpTool, HostToolBin, Notification, ParticipantV1, SessionView } from '../dist/index.js';
import type { LibDriver, LibLaunchPlan, LibMcpServer, LibPrepareContext, LibSpawnContext, LibSpawnResult, LibStall } from './driver-runtime.js';
import type { HarnessSessionRecord } from './harness-registry.js';

type PermissionAsk = NonNullable<ReturnType<typeof parsePermissionList>>[number];
type HolderFetch = NonNullable<Parameters<typeof listPermissions>[3]>;
type OpenCodeLaunchResult = LibSpawnResult<{
  state: 'alive'; session: { id: string; sessionId: string }; ghost: null;
}>;
interface OpenCodeRecord {
  url: string | null; password: string | null; sessionId: string | null; holderPid?: number;
  log?: string | null; cwd?: string; roots?: string[]; started: string;
  home?: string | null; task?: string | null; address?: string | null;
}
interface OpenCodeEntry extends HarnessSessionRecord { recordPath?: string | null; sessionId?: string; home?: string; task?: string; address?: string }
interface OpenCodePlan extends LibLaunchPlan {
  prompt?: string; env?: NodeJS.ProcessEnv; roots?: string[]; addDirs?: string[];
  holder?: { password?: string; title?: string }; permissionPollMs?: number;
}
interface OpenCodeSession { id?: unknown; time?: { idle?: unknown } }
type McpEntry = { type: 'remote'; url: string; headers?: Record<string, string>; oauth?: false }
  | { type: 'local'; command: string[]; environment?: NodeJS.ProcessEnv };
interface PermissionOptions {
  url: string; password: string; sessionId: string; roots: readonly unknown[];
  pollMs?: number; stepMs?: number; fetchFn?: HolderFetch; sleepFn?: (ms: number) => Promise<unknown>;
}

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

// After the prompt returns, an external_directory ask can appear a few seconds later.
// One immediate read misses it; inspect still answers a later one. Contract: 05-drivers.
export const PERMISSION_POLL_MS = 4_000;
const PERMISSION_POLL_STEP_MS = 200;

// Tools taken from the reviewer: it reads a report on the bus and does not edit or run.
// The reviewer role itself arrives separately.
export const REVIEWER_DENY = ['edit', 'write', 'bash', 'webfetch', 'websearch'];

// Bus deny names in Claude spelling into opencode permission keys. Unmapped names pass lowercased.
const DENY_NAME_MAP: Record<string, string> = {
  Edit: 'edit', Write: 'write', NotebookEdit: 'edit', Bash: 'bash', Read: 'read',
  WebFetch: 'webfetch', WebSearch: 'websearch',
};
export function permissionDeny(denyTools: readonly unknown[] | null | undefined) {
  const out: Record<string, 'deny' | Record<string, 'allow'>> = {};
  for (const name of denyTools ?? []) {
    const key = DENY_NAME_MAP[name as string] ?? String(name).toLowerCase();
    out[key] = 'deny';
  }
  return out;
}

// 2.0.20 types external_directory as an action or a pattern-to-action map. A filesystem
// root is not expanded: that pattern would allow the whole disk.
export function permissionGrant(denyTools: readonly unknown[] | null | undefined, roots: readonly unknown[] | null | undefined) {
  const permission = permissionDeny(denyTools);
  const external: Record<string, 'allow'> = {};
  for (const root of roots ?? []) {
    if (typeof root !== 'string' || filesystemRoot(path.resolve(root))) continue;
    const base = root.endsWith(path.sep) ? root.slice(0, -1) : root;
    if (!base || filesystemRoot(base)) continue;
    external[`${base}/*`] = 'allow';
    external[`${base}/**`] = 'allow';
  }
  if (Object.keys(external).length) permission.external_directory = external;
  return permission;
}

// The bus entry's pointer at the session record a lift writes beside its config.
export const SESSION_RECORD_VAR = 'PROMPTOBUS_OPENCODE_SESSION';

// Host-classified MCP writes into opencode permission patterns, both tool-name spellings.
export function mcpDenyTools(tools: readonly HostMcpTool[] | null | undefined) {
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
  enter: (id: string | null) => (id ? `opencode --session ${id}` : 'opencode'),
  stop: (id: string | null) => (id ? `opencode session delete ${id}` : 'opencode session delete'),
  logs: () => 'the holder log beside the session record',
  // MCP tools register as `mcp__server__tool`, the same convention as Claude Code.
  tool: (_server: string, name: string) => name,
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
function mcpConfig({ servers }: Pick<LibPrepareContext['mcp'], 'servers'>, pointer: string | null = null) {
  const mcp: Record<string, McpEntry> = {};
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const entry = raw as LibMcpServer | null;
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.url === 'string' && entry.url) {
      mcp[name] = {
        type: 'remote', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}),
        ...(entry.oauth === false ? { oauth: false } : {}),
      };
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
export function workspaceSkillsDir(root: string | null | undefined) {
  if (!root) return null;
  const src = path.join(root, OPENCODE_SKILLS_REL);
  try {
    return existsSync(src) ? src : null;
  } catch {
    return null;
  }
}

function filesystemRoot(abs: string) {
  const root = path.parse(abs).root;
  return root !== '' && abs === root;
}

/** Session cwd and absolute addDirs. A relative path is not a root: resolving it would follow the wrong process. */
export function declaredRoots(cwd: unknown, addDirs: readonly unknown[] = []) {
  const roots: string[] = [];
  for (const dir of [cwd, ...(Array.isArray(addDirs) ? addDirs : [])]) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) continue;
    const abs = path.resolve(dir);
    if (filesystemRoot(abs) || roots.includes(abs)) continue;
    roots.push(abs);
  }
  return roots;
}

/** The directory an external_directory resource names, after a trailing glob is stripped. */
export function resourceInRoots(resource: unknown, roots: readonly unknown[] | null | undefined) {
  if (typeof resource !== 'string') return false;
  const trimmed = resource.trim();
  const pattern = trimmed.endsWith('/**') ? trimmed.slice(0, -3)
    : trimmed.endsWith('/*') ? trimmed.slice(0, -2)
      : trimmed;
  if (!pattern || pattern.includes('*') || !path.isAbsolute(pattern)) return false;
  const abs = path.resolve(pattern);
  return (roots ?? []).some((root) => {
    if (typeof root !== 'string' || !root) return false;
    const base = path.resolve(root);
    if (filesystemRoot(base)) return false;
    const prefix = base.endsWith(path.sep) ? base : base + path.sep;
    return abs === base || abs.startsWith(prefix);
  });
}

export function askResources(ask: Partial<PermissionAsk> | null | undefined) {
  const out = [];
  if (typeof ask?.resource === 'string') out.push(ask.resource);
  if (Array.isArray(ask?.resources)) {
    for (const resource of ask.resources) {
      if (typeof resource === 'string') out.push(resource);
    }
  }
  return out;
}

/** An external_directory ask whose every resource is a declared root or inside one. */
export function coveredExternalDirectory(ask: Partial<PermissionAsk> | null | undefined, roots: readonly unknown[] | null | undefined) {
  if (ask?.action !== 'external_directory') return false;
  const resources = askResources(ask);
  return resources.length > 0 && resources.every((resource) => resourceInRoots(resource, roots));
}

export function pendingPermissionNote(asks: readonly Partial<PermissionAsk>[] | null | undefined) {
  const parts = [];
  for (const ask of asks ?? []) {
    const action = typeof ask?.action === 'string' && ask.action ? ask.action : 'permission';
    const resources = askResources(ask);
    parts.push(resources.length ? `${action} ${resources.join(' ')}` : action);
  }
  const note = `permission ask pending: ${parts.join('; ')}`;
  return note.length > 400 ? `${note.slice(0, 397)}...` : note;
}

const pause = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function readPermissionAsks(url: string, password: string, sessionId: string, fetchFn?: HolderFetch) {
  const res = await listPermissions(url, password, sessionId, fetchFn);
  if (res?.status !== 200) return null;
  return parsePermissionList(res.data);
}

/** Reply for declared-root external_directory asks. Any ask still listed fails the lift. */
export async function settlePermissionAsks({
  url, password, sessionId, roots, pollMs = PERMISSION_POLL_MS, stepMs = PERMISSION_POLL_STEP_MS,
  fetchFn, sleepFn = pause,
}: PermissionOptions) {
  const deadline = Date.now() + Math.max(0, pollMs);
  for (;;) {
    let asks = await readPermissionAsks(url, password, sessionId, fetchFn);
    if (Array.isArray(asks)) {
      const answerable = asks.filter((ask) => coveredExternalDirectory(ask, roots) && typeof ask.id === 'string' && ask.id);
      for (const ask of answerable) {
        await replyPermission(url, password, sessionId, ask.id as string, fetchFn);
      }
      if (answerable.length) asks = await readPermissionAsks(url, password, sessionId, fetchFn);
      if (!Array.isArray(asks)) throw new GateError('permission list unreadable after a reply');
      if (asks.length) throw new GateError(pendingPermissionNote(asks));
    }
    if (Date.now() >= deadline) return;
    const wait = Math.min(stepMs, Math.max(0, deadline - Date.now()));
    if (wait > 0) await sleepFn(wait);
  }
}

/** Lift plan from harness-neutral context. Writes nothing and starts nothing. */
export function prepare({
  ref, role: _role = null, mcp, prompt, model, effort = null, permissionMode: _permissionMode = null,
  mcpConfigPath, env = {}, denyTools = null, root = null, skillsRoot = root, selectedContext = null, home = null, task = null, address = null,
  cwd = null, addDirs = [],
}: Omit<LibPrepareContext, 'role' | 'task' | 'address' | 'cwd'> & { role?: string | null; task?: string | null; address?: string | null; cwd?: string | null }): OpenCodePlan {
  if (effort !== null && effort !== undefined) {
    throw new GateError(`--effort ${effort}: opencode maps no effort level — omit it`);
  }
  const configDir = path.dirname(mcpConfigPath!);
  const holderDir = path.join(configDir, '.opencode');
  const skillsSrc = selectedContext ? null : workspaceSkillsDir(skillsRoot);
  const skillsDest = path.join(holderDir, 'skills');
  const password = holderPassword();
  const pointer = safeRecordPath(home, task, address, ref);
  const roots = declaredRoots(cwd, addDirs);
  const permission = permissionGrant(denyTools, roots);
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    model: model ?? DEFAULT_MODEL,
    mcp: mcpConfig(mcp, pointer).mcp,
    ...(Object.keys(permission).length ? { permission } : {}),
  };
  return {
    argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'],
    prompt,
    cwd: cwd!,
    roots,
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
      { path: mcpConfigPath!, text: `${JSON.stringify(cfg, null, 2)}\n`, secret: true },
      ...(skillsSrc ? [{ path: skillsDest, copyFrom: skillsSrc, text: '', secret: false }] : []),
      ...(selectedContext ? selectedNativeFiles(selectedContext, skillsDest) : []),
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
function opencodeUserMcp(canonServerNames: readonly string[]) {
  let names: string[] = [];
  try {
    const doc: { mcp?: unknown } | null = JSON.parse(readFileSync(path.join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'));
    names = Object.keys(doc?.mcp ?? {}).sort();
  } catch {
    names = [];
  }
  const canon = new Set(canonServerNames);
  return { shadowed: names.filter((n) => canon.has(n)), extras: names.filter((n) => !canon.has(n)) };
}

function shadowedUserServers(names: readonly string[]) {
  return opencodeUserMcp(names).shadowed;
}

// The holder record before the first holder call: pid first, then url, then session id.
export function holderRecord({ home, task, address, password, pid, log, cwd }: { home?: string | null; task?: string | null; address?: string | null; password?: string | null; pid?: number; log?: string | null; cwd?: string }): OpenCodeRecord {
  return {
    url: null, password: password ?? null,
    sessionId: null, holderPid: pid, log, cwd, started: new Date().toISOString(),
    home, task, address,
  };
}
// The harness session registry: ref → record path for ref-only `inspect` and `stop`.
const opencodeRegistry = createHarnessRegistry<OpenCodeEntry>({ harness: OPENCODE });

/** Registry file key of a ref — the name `writeSession` files it under. */
export const registrySessionKey = (ref: string) => opencodeRegistry.sessionKey(ref);

function recordPath(home: string | null | undefined, task: string | null | undefined, address: string | null | undefined, ref: string | null = null) {
  try {
    return participantSessionPath(home!, task!, address!);
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
function safeRecordPath(home: string | null | undefined, task: string | null | undefined, address: string | null | undefined, ref: string | null = null) {
  if (!home || !task || !address) return null;
  return recordPath(home, task, address, ref);
}


function opencodeBin(tool?: Pick<HostToolBin, 'bin'> | null) {
  if (tool?.bin) return tool.bin;
  const { bin } = harnessBin(OPENCODE);
  return bin ?? OPENCODE;
}

const APPEAR_TIMEOUT_MS = 30_000;

// Lift a worker session from its plan: holder up, session created, first turn sent. The record
// binds holder port, password, holder pid and session id before the turn runs.
async function spawn(rawPlan: LibLaunchPlan, {
  tool, home, task, address, cwd, env, ref,
  launchFailNote = '', persist = null,
}: Omit<LibSpawnContext, 'persist'> & { persist?: LibSpawnContext['persist'] | null }): Promise<OpenCodeLaunchResult> {
  const plan = rawPlan as OpenCodePlan;
  const bin = opencodeBin(tool);
  const file = recordPath(home, task, address, ref);
  const dir = file ? path.dirname(file) : null;
  if (dir) mkdirSync(dir, { recursive: true });
  const log = file ? `${file}.holder.log` : null;
  const runEnv = { ...(plan.env ?? env ?? {}) };
  let child: ReturnType<typeof startHolder>;
  try {
    child = startHolder(bin, plan.argv, { cwd: plan.cwd ?? cwd, env: runEnv, log });
    const started = await new Promise<Error | null>((resolve) => {
      child.once('error', resolve);
      child.once('spawn', () => resolve(null));
    });
    if (started) throw started;
  } catch (caught) {
    const error = caught as Error;
    throw new GateError(`opencode serve did not start: ${error.message ?? error}.${launchFailNote}`);
  }
  if (child.pid === undefined) throw new GateError(`opencode serve did not start.${launchFailNote}`);
  try {
    const record = holderRecord({
      home, task, address, password: plan.holder?.password ?? runEnv.OPENCODE_SERVER_PASSWORD ?? null,
      pid: child.pid, log, cwd: plan.cwd ?? cwd,
    });
    if (file) writeJsonAtomic(file, record, { mode: 0o600 });
    const fail: (note: string) => never = note => { throw new GateError(`${note}.${launchFailNote}`); };
    const url = await waitHolderUrl(child.pid, log);
    if (!url) fail('the holder never printed its listening port');
    const password = record.password!;
    if (!await waitReady(url, password, { timeoutMs: APPEAR_TIMEOUT_MS })) {
      fail('the holder never answered its session list');
    }
    record.url = url;
    if (file) writeJsonAtomic(file, record, { mode: 0o600 });
    const created = await createSession(url, password, plan.holder?.title ?? ref);
    const sessionId = (created?.data as { data?: { id?: string } } | null)?.data?.id ?? null;
    if (created?.status !== 200 || !sessionId) fail(`session create answered ${created?.status ?? 'nothing'}`);
    const sent = await sendPrompt(url, password, sessionId, plan.prompt!);
    if (sent?.status !== 200) fail(`the first turn answered ${sent?.status ?? 'nothing'}`);
    const roots = declaredRoots(plan.cwd ?? cwd, [...(plan.roots ?? []), ...(plan.addDirs ?? [])]);
    record.sessionId = sessionId;
    record.roots = roots;
    if (file) writeJsonAtomic(file, record, { mode: 0o600 });
    try {
      await settlePermissionAsks({
        url, password, sessionId, roots, pollMs: plan.permissionPollMs ?? PERMISSION_POLL_MS,
      });
    } catch (caught) {
    const error = caught as Error;
      if (error instanceof GateError) fail(error.message);
      throw error;
    }
    opencodeRegistry.writeSession({
      ref, recordPath: file, sessionId, home, task, address,
    });
    persist?.(sessionId, 'alive', sessionId);
    return { output: '', session: sessionId, seen: { state: 'alive', session: { id: sessionId, sessionId }, ghost: null } };
  } catch (caught) {
    const error = caught as Error;
    try { await reapHolder(child.pid); } catch { /* preserve the lift failure */ }
    for (const gone of [file, log]) {
      if (!gone) continue;
      try { unlinkSync(gone); } catch { /* already gone */ }
    }
    try { opencodeRegistry.dropSession(ref); } catch { /* preserve the lift failure */ }
    throw error;
  }
}

// The holder prints its port on stdout; `--port 0` lets it choose. A missing line after the
// ceiling is a failed lift, not a slow one.
async function waitHolderUrl(pid: number, log: string | null, { timeoutMs = APPEAR_TIMEOUT_MS, stepMs = 200 } = {}) {
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
// death. Synchronous: the warden calls it on its beat, so the list call is one subprocess.
function inspect(ref: string): SessionView | null {
  const entry = opencodeRegistry.readSession(ref);
  const record = entry?.recordPath ? readRecordAt<OpenCodeRecord>(entry.recordPath) : null;
  if (!record?.holderPid) return null;
  if (!pidAlive(record.holderPid!)) {
    return { state: 'gone', busy: false, stall: null, id: record.sessionId ?? null, note: 'holder process is gone' };
  }
  if (!record.url || !record.sessionId) {
    return { state: 'alive', busy: true, stall: null, id: null, note: 'holder up, lift in progress' };
  }
  const list = listSessionsSync(record);
  if (list === null) {
    return { state: 'unknown', busy: false, stall: null, id: record.sessionId!, note: PHRASES.unreadable };
  }
  return viewOf(record, list, remainingPermissionAsks(record));
}

/** Pending asks after declared-root replies. Null when the permission route cannot be read. */
export function remainingPermissionAsks(record: OpenCodeRecord, runFn = run): PermissionAsk[] | null {
  const read = () => {
    const res = holderRequestSync(
      record.url!, record.password!, 'GET', `/api/session/${record.sessionId}/permission`, undefined, runFn,
    );
    if (res?.status !== 200) return null;
    return parsePermissionList(res.data);
  };
  const first = read();
  if (!Array.isArray(first)) return null;
  const roots = Array.isArray(record.roots) && record.roots.length ? record.roots : declaredRoots(record.cwd);
  const answerable = first.filter((ask) => coveredExternalDirectory(ask, roots) && typeof ask.id === 'string' && ask.id);
  if (!answerable.length) return first;
  let repliedAll = true;
  for (const ask of answerable) {
    const replied = holderRequestSync(
      record.url!, record.password!, 'POST',
      `/api/session/${record.sessionId}/permission/${ask.id}/reply`, { decision: 'once' }, runFn,
    );
    if (replied?.status !== 200 && replied?.status !== 204) repliedAll = false;
  }
  const again = read();
  if (Array.isArray(again)) return again;
  return repliedAll ? null : first;
}

export function listSessionsSync(record: OpenCodeRecord, runFn = run) {
  const r = runFn(opencodeBin(), apiArgv(record), {
    cwd: record.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: record.password! },
  });
  if (r.error || r.status !== 0) return null;
  return parseSessionList(r.stdout);
}

/** The argv reading the holder session list: one local subprocess per heartbeat. */
export function apiArgv(record: OpenCodeRecord) {
  return ['api', '--server', record.url!, 'session.list'];
}

/** The `{data:[...]}` envelope off the list call, or null when it does not parse. */
export function parseSessionList(text: unknown): unknown[] | null {
  try {
    const doc: { data?: unknown } | null = JSON.parse(String(text ?? ''));
    return Array.isArray(doc?.data) ? doc.data : null;
  } catch {
    return null;
  }
}

/** The snapshot view off a list the holder answered. A pending ask is not a model call. */
export function viewOf(record: OpenCodeRecord, list: readonly unknown[] | null | undefined, asks: PermissionAsk[] | null | undefined = undefined): SessionView {
  const hit = (list ?? []).find((raw) => (raw as { id?: unknown } | null)?.id === record.sessionId);
  if (!hit) {
    return { state: 'gone', busy: false, stall: null, id: record.sessionId!, note: 'session left the holder list' };
  }
  if (asks === null) {
    return { state: 'alive', busy: true, stall: null, id: record.sessionId!, note: 'permission list unreadable' };
  }
  if (Array.isArray(asks) && asks.length) {
    return { state: 'alive', busy: true, stall: null, id: record.sessionId!, note: pendingPermissionNote(asks) };
  }
  const busy = !(hit as Pick<OpenCodeSession, 'time'>)?.time?.idle;
  return { state: 'alive', busy, stall: null, id: record.sessionId!, note: busy ? 'turn running' : 'idle' };
}

// What is said about lift after success. The holder log carries the port; the session id names
// the turn to watch.
function saidLiftoff({ output, session }: Pick<LibSpawnResult, 'output' | 'session'>) {
  if (output) info(output);
  if (session) info(`opencode session ${session} on its holder — watch it with the record beside the task`);
}

function forgetSessions() {}

// Stop a session, ref-only. Idempotent: no entry is an outcome with its own words. The session
// is deleted first — the holder is its server, and after the reap no delete would reach it.
async function stop(ref: string) {
  const entry = opencodeRegistry.readSession(ref);
  const record = entry?.recordPath ? readRecordAt<OpenCodeRecord>(entry.recordPath) : null;
  if (!record) {
    opencodeRegistry.dropSession(ref);
    return { ok: true, stopped: false, note: `no opencode session record for «${ref}»` };
  }
  if (record.url && record.sessionId) {
    try {
      await deleteSession(record.url!, record.password!, record.sessionId);
    } catch { /* holder already gone; the reap below is the cleanup */ }
  }
  await reapHolder(record.holderPid!);
  for (const gone of [entry!.recordPath, record.log]) {
    try {
      if (gone) unlinkSync(gone);
    } catch { /* already gone */ }
  }
  opencodeRegistry.dropSession(ref);
  return { ok: true, stopped: true, note: `session ${record.sessionId} stopped` };
}

// Sweep only this participant's harness state; done walks a closed task participant by participant.
// The task and address must both match before a holder, record, log or registry entry is removed.
export async function sweepParticipant(participant: ParticipantV1, taskId: string, env = process.env) {
  const address = addressOf(participant);
  if (!address || !taskId) return { swept: 0 };
  const records = opencodeRegistry.registrySessions(env)
    .filter((r) => r?.task === taskId && r?.address === address);
  for (const r of records) {
    try {
      const record = r?.recordPath ? readRecordAt<OpenCodeRecord>(r.recordPath) : null;
      if (record?.url && record?.sessionId) {
        try {
          await deleteSession(record.url!, record.password!, record.sessionId);
        } catch { /* already gone */ }
      }
      await reapHolder(record?.holderPid!);
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
export function registerWake(home: string, task: string, addr: string, env = process.env, session: string | null = null) {
  try {
    const file = String(env?.[SESSION_RECORD_VAR] ?? '').trim();
    if (!file) return null;
    const record = readRecordAt<OpenCodeRecord>(file);
    // The bus server hands over with no session argument; the record names it.
    const who = session ?? record?.sessionId ?? null;
    if (!who) return null;
    if (record?.sessionId && record.sessionId !== who) return null;
    const held = foreignSession(home, task, addr, who);
    if (held) {
      sayForeignWrite(home, task, addr, held, who, 'contact-point handoff');
      return false;
    }
    const at = wakeAddressOf(home, task, addr);
    return writeWake(home, at.task, at.address, { socket: file, token: null, session: who });
  } catch {
    return null;
  }
}

/** Channel smoke: the holder process is up and the record names a session. It answers no
 * turn state — an optimistic smoke for doctor/integration; `activate` is the real gate. */
export function checkWake(env = process.env) {
  const file = String(env?.[SESSION_RECORD_VAR] ?? '').trim();
  if (!file) return { endpoint: null, ok: false, error: `${SESSION_RECORD_VAR} is empty — not an opencode participant session` };
  const record = readRecordAt<OpenCodeRecord>(file);
  if (!record?.url || !record?.sessionId) return { endpoint: file, ok: false, error: 'no holder url or session id at this path — lift is not confirmed' };
  if (!pidAlive(record.holderPid!)) return { endpoint: file, ok: false, error: 'holder process is gone' };
  return { endpoint: file, ok: true, error: null };
}

export function renderNotification(n: Notification) {
  return commonOrderBody(n.task, n.address, n.unread, n.messages ?? [], {
    fetchLine: `Fetch the mailbox with \`${PHRASES.tool(PROMPTOBUS_SERVER, 'promptobus_mailbox')}\`: only that tool marks messages read. `,
  });
}

/** Wake a participant with a follow-up turn on its session. An idle session takes the text; a
 * running turn refuses honestly, and the warden falls back to self-wake and retries. */
export async function activate(target: ActivationTarget, notification: Notification) {
  // The warden hands the wake record's socket; older callers hand the record path itself.
  const file = String(target?.endpoint?.socket ?? target?.endpoint ?? '').trim();
  if (!file) return { ok: false, error: 'the participant record has no contact point — nothing to wake' };
  const record = readRecordAt<OpenCodeRecord>(file);
  if (!record?.url || !record?.sessionId) {
    return { ok: false, error: 'no holder url or session id at the contact point' };
  }
  if (!pidAlive(record.holderPid!)) return { ok: false, error: 'holder process is gone — lift the participant again' };
  let messages;
  try {
    messages = await readMessages(record.url!, record.password!, record.sessionId!, 3);
  } catch (caught) {
    const error = caught as Error;
    return { ok: false, error: `the preceding turn state could not be read: ${error.message}` };
  }
  const items = Array.isArray(messages?.data) ? messages.data : (messages?.data as { data?: unknown } | null)?.data;
  if (messages?.status !== 200 || !Array.isArray(items) || !items.length || typeof items[0]?.type !== 'string') {
    return { ok: false, error: 'the preceding turn state is unreadable — the message waits for proven idle' };
  }
  if (idleOutcome(items) === null) {
    return { ok: false, error: 'a turn is running — the message waits for its idle' };
  }
  const sent = await sendPrompt(record.url!, record.password!, record.sessionId!, renderNotification(notification));
  if (sent?.status !== 200) return { ok: false, error: `the follow-up turn answered ${sent?.status ?? 'nothing'}` };
  try {
    await settlePermissionAsks({
      url: record.url, password: record.password!, sessionId: record.sessionId!,
      roots: Array.isArray(record.roots) && record.roots.length ? record.roots : declaredRoots(record.cwd),
      pollMs: 0,
    });
  } catch (caught) {
    const error = caught as Error;
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Recovery instructions for a holder-backed session; no interactive attach is advertised. */
function stallRoute({ kind }: Pick<LibStall, 'kind'>) {
  if (kind === 'gone' || kind === 'stale') {
    return 'the holder or its session is gone — nobody to wake. Work delivered — a normal end; '
      + 'otherwise repeat the original lift with --harness opencode';
  }
  if (kind === 'wake-taken') {
    return 'the session is alive, but another session holds its contact point. Check the session record '
      + `and ${PHRASES.logs()}; the bound session restores its contact point on its next bus call`;
  }
  return `inspect the session record and ${PHRASES.logs()}. A follow-up prompt runs when the session `
    + 'is idle; a running turn holds queued mail until it ends';
}

/** OpenCode driver — worker, reviewer and approver lifts through a per-participant holder. */
export const opencodeDriver: LibDriver = {
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
    selectedContext: true,
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
  stallRoute,
  sayForeignWrite,
  sessionEnv,
  optionRefusal,
  shadowedUserServers,
};

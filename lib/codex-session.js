import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GateError, REVIEWER } from '../dist/index.js';
import { withDirLock } from '../dist/fs/lock.js';
import { CodexRpc } from './codex-rpc.js';
import { createHarnessRegistry } from './harness-registry.js';
import { foreignSession, logWarden, writeWake } from './store.js';
import { provenanceFromRecord, provenanceLine } from './provenance.js';
import { createParticipantAuthReload } from './codex-participant-auth.js';
import { commandReceipts } from './codex-command-receipts.js';

// Codex participant thread registry and app-server holder; the driver and reporter channel
// use its public operations. [03-cli.md § The Codex holder](../docs/reference/03-cli.md#the-codex-holder)

export const SESSION_ENV_VAR = 'PROMPTOBUS_CODEX_SESSION';

// Participant argv. The bypass flag is a GLOBAL option and must precede the subcommand —
// why, and what it does and does not cover, in 03-cli § The Codex holder.
export const PARTICIPANT_ARGV = ['--dangerously-bypass-hook-trust', 'app-server', '--stdio'];

const here = path.dirname(fileURLToPath(import.meta.url));
const HOLD_JS = path.join(here, 'codex-hold.js');

function packageIdentity() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return {
      name: String(pkg.name ?? 'promptobus') || 'promptobus',
      version: String(pkg.version ?? '0.0.0') || '0.0.0',
    };
  } catch {
    return { name: 'promptobus', version: '0.0.0' };
  }
}

function hostClientInfo(record, env = process.env) {
  const named = String(record?.hostName ?? env.PROMPTOBUS_HOST_NAME ?? '').trim();
  const ver = String(record?.hostVersion ?? env.PROMPTOBUS_HOST_VERSION ?? '').trim();
  const pkg = packageIdentity();
  return { name: named || pkg.name, version: ver || pkg.version };
}

export function codexInitParams(record, env = process.env) {
  return {
    clientInfo: hostClientInfo(record, env),
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: ['mcpServer/startupStatus/updated'],
    },
  };
}

/** Harness name the registry is keyed by — the same string the driver declares as its id. */
const CODEX_HARNESS = 'codex';

/** Registry of OUR threads and holders. `PROMPTOBUS_CODEX_HOME`, else the host, else a
 * refusal — never a guess under the real home ([harness-home.js](harness-home.js)). */
let dropParticipantHome = () => false;

const SOCK_MAX = 103;

function lockFile(ref, env = process.env) {
  return path.join(sessionsDir(env), sessionKey(ref) + '.lock');
}

export function socketPath(ref, env = process.env) {
  const refText = String(ref ?? '');
  const name = createHash('sha1').update(refText).digest('hex').slice(0, 12) + '.sock';
  const nested = path.join(sessionsDir(env), name);
  if (Buffer.byteLength(nested) <= SOCK_MAX) return nested;
  const fallback = createHash('sha1')
    .update(sessionsDir(env) + '\0' + refText)
    .digest('hex').slice(0, 12) + '.sock';
  return path.join(tmpdir(), 'pb-cdx-' + fallback);
}

export function holderLogFile(ref, env = process.env) {
  return path.join(sessionsDir(env), sessionKey(ref) + '.log');
}

const codexRegistry = createHarnessRegistry({
  harness: CODEX_HARNESS,
  sidecars: (ref, env) => [socketPath(ref, env), lockFile(ref, env), holderLogFile(ref, env)],
  onDrop: (record) => {
    if (record?.codexHome) dropParticipantHome(record.codexHome);
  },
});

export const codexStateHome = codexRegistry.stateHome;
export const sessionsDir = codexRegistry.sessionsDir;
export const sessionKey = codexRegistry.sessionKey;
export const sessionFile = codexRegistry.sessionFile;
export const readSession = codexRegistry.readSession;
export const writeSession = codexRegistry.writeSession;
export const patchSession = codexRegistry.patchSession;
export const dropSession = codexRegistry.dropSession;
export const registrySessions = codexRegistry.registrySessions;
export const pidAlive = codexRegistry.pidAlive;

export function findSessionByAddress(home, task, address, env = process.env) {
  return registrySessions(env).find((r) => r.home === home && r.task === task && r.address === address) ?? null;
}

// Set by the driver at import: the home is the driver's construct, and importing the driver
// here would close the one-way adapter boundary the gate stands on.
export function bindParticipantHomeRemoval(fn) {
  dropParticipantHome = typeof fn === 'function' ? fn : (() => false);
}

// Holder preamble budget — the same timeouts that sit on the holdMain requests: five calls
// nearly filled the old 60 s window, and readiness only needs the wait for turn/started.
export const INIT_TIMEOUT_MS = 30_000;
export const MODEL_LIST_TIMEOUT_MS = 15_000;
export const THREAD_START_TIMEOUT_MS = 60_000;
export const NAME_SET_TIMEOUT_MS = 10_000;
export const TURN_STARTED_TIMEOUT_MS = 15_000;

export function turnWaitMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CODEX_TURN_MS);
  return Number.isFinite(named) && named > 0 ? named : 120_000;
}

export function limitWaitMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CODEX_LIMIT_MS);
  return Number.isFinite(named) && named > 0 ? named : 3_000;
}

export function preambleMs(env = process.env) {
  return INIT_TIMEOUT_MS + limitWaitMs(env) + MODEL_LIST_TIMEOUT_MS
    + THREAD_START_TIMEOUT_MS + NAME_SET_TIMEOUT_MS;
}

export function readyMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CODEX_READY_MS);
  return Number.isFinite(named) && named > 0 ? named : preambleMs(env) + TURN_STARTED_TIMEOUT_MS;
}

/** Live silence budget for a running Codex turn. Cursor's watchdog is the same 180 s. */
export const TURN_IDLE_MS = 180_000;

export function turnIdleMs(env = process.env) {
  const named = Number(env.PROMPTOBUS_CODEX_IDLE_MS);
  return Number.isFinite(named) && named > 0 ? named : TURN_IDLE_MS;
}

/** Error text app-server put on turn/completed. Message only — never a params blob. */
export function turnErrorText(params) {
  const err = params?.error ?? params?.turn?.error;
  if (err == null || err === '') return null;
  if (typeof err === 'string') return err.slice(0, 400);
  if (typeof err === 'object' && typeof err.message === 'string' && err.message) {
    return err.message.slice(0, 400);
  }
  return null;
}

export function turnFailed(status) {
  return status === 'failed' || status === 'error';
}

/** Drop only the matching server-request id. Number `1` and string `"1"` stay distinct. */
export function outstandingAfterResolved(pendingRequests, requestId) {
  const list = Array.isArray(pendingRequests) ? pendingRequests : [];
  if (requestId === undefined || requestId === null) return list;
  return list.filter((r) => r?.id !== requestId);
}

export function oldestPending(pendingRequests) {
  const list = Array.isArray(pendingRequests) ? pendingRequests : [];
  return list[0] ?? null;
}

export const STOP_TIMEOUT_MS = 10_000;
export const STOP_STEP_MS = 100;

export function rateLimitReached(snap) {
  if (!snap || typeof snap !== 'object') return false;
  if (snap.rateLimitReachedType) return true;
  const windows = [snap.primary, snap.secondary, snap].filter(Boolean);
  return windows.some((w) => Number(w.usedPercent) >= 100);
}

export function rateLimitNote(snap) {
  if (!snap) return null;
  const pct = snap.primary?.usedPercent ?? snap.usedPercent;
  const resets = snap.primary?.resetsAt ?? snap.resetsAt;
  const parts = [
    pct != null ? `limit ${pct}%` : null,
    resets ? `resets ${resets}` : null,
    snap.planType ? `plan ${snap.planType}` : null,
    snap.rateLimitReachedType ? `reached (${snap.rateLimitReachedType})` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** `model/list` rows as names, with the mark app-server puts on hidden ones. Filtering is
 * the caller's: a hidden model a person named is still a model they named (ADR-005). */
export function listedModels(result) {
  const rows = result?.data ?? result?.models ?? result ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => (typeof row === 'string'
    ? { model: row, hidden: false }
    : { model: row?.id ?? row?.model ?? '', hidden: row?.hidden === true }));
}

// --- lock of one holder on a thread ------------------------------------------------

export function withSessionLaunch(ref, env, fn, { waitMs } = {}) {
  const dir = sessionsDir(env);
  if (!existsSync(dir)) return fn();
  return withDirLock(path.join(dir, `${sessionKey(ref)}.transition`), fn, {
    waitMs,
    retryMs: Math.min(20, Math.max(1, waitMs ?? 20)),
    onMissing: () => new GateError(`Codex session ${ref} registry disappeared`),
    onBusy: () => new GateError(`Codex session ${ref} is changing launch ownership`),
  });
}

export function takeHolderLock(ref, env = process.env) {
  return withSessionLaunch(ref, env, () => {
    const file = lockFile(ref, env);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
      return { ok: true, file };
    } catch {
      let held = null;
      try {
        held = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        held = null;
      }
      if (held && pidAlive(Number(held.pid))) {
        return { ok: false, file, error: `thread is already held by process ${held.pid}` };
      }
      rmSync(file, { force: true });
      try {
        writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
        return { ok: true, file };
      } catch {
        return { ok: false, file, error: `holder lock cannot be taken: ${file}` };
      }
    }
  });
}

export function dropHolderLock(ref, env = process.env) {
  return withSessionLaunch(ref, env, () => {
    if (holderLockPid(ref, env) === process.pid) rmSync(lockFile(ref, env), { force: true });
  });
}

// --- holder client -------------------------------------------------------------

function sendHolder(sock, obj, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const client = net.connect(sock);
    let buf = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`the holder did not reply in ${timeoutMs} ms`));
    }, timeoutMs);
    client.setEncoding('utf8');
    client.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    client.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        reject(err);
      }
      client.end();
    });
    client.on('connect', () => {
      client.write(`${JSON.stringify(obj)}\n`);
    });
  });
}

export async function holderAsk(ref, op, extra = {}, env = process.env, timeoutMs = 30_000) {
  const rec = readSession(ref, env);
  const sock = rec?.rpcSocket;
  if (!sock) throw new Error('the session has no holder socket');
  const id = `${process.pid}-${Date.now()}`;
  const ans = await sendHolder(sock, { id, op, ...extra }, timeoutMs);
  if (ans?.error) throw new Error(typeof ans.error === 'string' ? ans.error : ans.error.message ?? JSON.stringify(ans.error));
  return ans?.result ?? ans;
}

export function holderAlive(ref, env = process.env) {
  const rec = readSession(ref, env);
  return !!(rec?.holderPid && pidAlive(rec.holderPid)) || pidAlive(holderLockPid(ref, env));
}

function holderLockPid(ref, env) {
  try { return Number(JSON.parse(readFileSync(lockFile(ref, env), 'utf8')).pid); }
  catch { return null; }
}

export function startHolder(ref, env = process.env) {
  const file = sessionFile(ref, env);
  const expectedLaunch = readSession(ref, env)?.launchId;
  const child = spawn(process.execPath, [HOLD_JS, file, ...(expectedLaunch ? [expectedLaunch] : [])], {
    detached: true,
    stdio: 'ignore',
    env: { ...env, PROMPTOBUS_CODEX_HOME: codexStateHome(env) },
  });
  child.unref();
  traceHolder(env, `${child.pid}\t${file}`);
  return child;
}

/** How often the holder asks whether its session still exists — chosen against what it
 * reaps: a run directory removed at the end of a suite run. */
const RECORD_WATCH_MS = 5_000;

// Holder-start trace for the suite, read at the TAIL of a run: a holder may live during one,
// what is forbidden is one alive after it. Pid AND session file — a pid alone is reused.
function traceHolder(env, line) {
  const file = env?.PROMPTOBUS_HOLDER_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // Suite diagnostics: a write refusal is no reason to fail a participant lift.
  }
}

export async function waitReady(ref, env = process.env, timeoutMs = readyMs(env), readyState = 'alive') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rec = readSession(ref, env);
    if (rec?.error) return { ok: false, error: rec.error, record: rec };
    if (rec?.state === readyState && rec.threadId) return { ok: true, record: rec };
    await new Promise((r) => { setTimeout(r, 50); });
  }
  const rec = readSession(ref, env);
  return {
    ok: false,
    error: rec?.error ?? `the holder did not confirm lift in ${timeoutMs} ms`,
    record: rec,
    log: tailLog(ref, env),
  };
}

export function tailLog(ref, env = process.env, n = 20) {
  try {
    return readFileSync(holderLogFile(ref, env), 'utf8').trim().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}

function killRecordPids(record) {
  for (const pid of [record?.holderPid, record?.appPid]) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(-pid, 'SIGKILL'); } catch { /* no group or no permission */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** Stop the holder of `ref`: ask `shutdown` (bounded by `timeoutMs`, the ask also at most 5 s),
 *  wait out its death on the same budget, and fall back to killing its pids. */
export async function reapHolder(ref, env = process.env, timeoutMs = STOP_TIMEOUT_MS) {
  const record = readSession(ref, env);
  if (!record) return;
  if (!record.holderPid) record.holderPid = holderLockPid(ref, env);
  if (holderAlive(ref, env)) {
    try {
      await holderAsk(ref, 'shutdown', {}, env, Math.min(5_000, timeoutMs));
    } catch {
      killRecordPids(record);
    }
    await waitStopped(ref, env, timeoutMs);
    return;
  }
  killRecordPids(record);
}

export async function waitStopped(ref, env = process.env, timeoutMs = STOP_TIMEOUT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!holderAlive(ref, env)) return true;
    await new Promise((r) => { setTimeout(r, STOP_STEP_MS); });
  }
  return !holderAlive(ref, env);
}

// --- contact point ----------------------------------------------------------------

export function writeParticipantWake(record, env = process.env) {
  if (!record?.home || !record?.task || !record?.address || !record?.rpcSocket) return null;
  const session = record.threadId ?? null;
  if (session) {
    const held = foreignSession(record.home, record.task, record.address, session);
    if (held) return null;
  }
  const turns = Number(record.turns) || 0;
  return writeWake(record.home, record.task, record.address, {
    socket: `${record.rpcSocket}#${turns}`,
    token: null,
    session,
  });
}

// --- holder --------------------------------------------------------------------

const APPROVE = {
  execCommandApproval: {
    ok: { decision: 'approved' }, no: { decision: { denied: { rejection: 'approval denied' } } },
  },
  applyPatchApproval: {
    ok: { decision: 'approved' }, no: { decision: { denied: { rejection: 'approval denied' } } },
  },
  'item/commandExecution/requestApproval': { ok: { decision: 'accept' }, no: { decision: 'decline' } },
  'item/fileChange/requestApproval': { ok: { decision: 'accept' }, no: { decision: 'decline' } },
  'item/permissions/requestApproval': { ok: { permissions: {}, scope: 'turn' }, no: { permissions: {}, scope: 'turn' } },
  'mcpServer/elicitation/request': { ok: { action: 'accept', content: {} }, no: { action: 'decline' } },
  'item/tool/requestUserInput': { ok: { answers: {} }, no: { answers: {} } },
};

export function approvalReply(method, allow, params = {}) {
  const row = APPROVE[method];
  if (method === 'item/tool/requestUserInput' && allow) {
    const questions = Array.isArray(params?.questions) ? params.questions : [];
    return { answers: Object.fromEntries(questions.map(({ id }) => [id, { answers: [] }])) };
  }
  if (row) return allow ? row.ok : row.no;
  return { __error: { code: -32601, message: `no handler for server request ${method}` } };
}

// `currentTime/read` has no static APPROVE row: its response is computed per request, so
// `decideApproval` recognises it before this table.

function looksLikeConfigRead(method) {
  return method === 'config/read';
}

const MUTATION_APPROVALS = new Set([
  'execCommandApproval',
  'applyPatchApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

// Command approvals that ask to leave the network sandbox. Checked BY FIELD, not by method:
// the legacy pair is the same kind of request, and a later field must not arrive unread.
const COMMAND_APPROVALS = new Set([
  'execCommandApproval',
  'item/commandExecution/requestApproval',
]);

/** Why a command approval is a network escalation, or `null`. A participant does not leave
 * its sandbox on request, and the plain `decline` applies no amendment either way. */
function networkEscalationWhy(params) {
  const context = params?.networkApprovalContext;
  if (context && typeof context === 'object') {
    const host = context.host == null || context.host === '' ? 'an unnamed host' : String(context.host).slice(0, 200);
    const protocol = context.protocol == null || context.protocol === '' ? 'an unnamed protocol' : String(context.protocol).slice(0, 40);
    return `network egress denied: ${protocol} to ${host}`;
  }
  const amendments = params?.proposedNetworkPolicyAmendments;
  if (Array.isArray(amendments) && amendments.length) {
    const hosts = amendments
      .map((rule) => (rule && typeof rule === 'object' ? String(rule.host ?? '') : ''))
      .filter(Boolean).slice(0, 5).join(', ');
    return `network policy amendment denied${hosts ? `: ${hosts}` : ''}`;
  }
  return null;
}

// Codex config vocabulary is checked only in the named top-level fields: on the measured
// 0.146.0 approval shapes none of them nests these under `item`.
const DANGEROUS_SANDBOX_VALUES = new Set([
  'danger-full-access',
  'dangerously-bypass',
  'dangerously-bypass-approvals',
  'dangerously-bypass-approvals-and-sandbox',
]);

const DANGEROUS_APPROVAL_POLICY_VALUES = new Set([
  'on-failure',
  'never',
]);

const DANGEROUS_PERMISSION_VALUES = new Set([
  'danger-full-access',
  'dangerously-bypass',
  'dangerously-bypass-approvals',
  'dangerously-bypass-approvals-and-sandbox',
]);

function permissionValues(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(permissionValues);
  if (value && typeof value === 'object') {
    return [...Object.keys(value), ...Object.values(value).flatMap(permissionValues)];
  }
  return [];
}

function permissionRequestWhy(params) {
  const permissions = params?.permissions;
  const bounded = (value) => {
    const serialized = String(JSON.stringify(value));
    return serialized.length > 400 ? `${serialized.slice(0, 397)}...` : serialized;
  };
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return `permission request denied: permissions=${bounded(permissions)}`;
  }
  const profile = permissions;
  const fileSystem = profile.fileSystem ?? null;
  const network = profile.network?.enabled ?? null;
  return `permission request denied: permissions.fileSystem=${bounded(fileSystem)}; permissions.network.enabled=${bounded(network)}`;
}

function asksForEscalatedPermission(params, record) {
  // Keep this slot list explicit: scanning params wholesale would reopen blob matching.
  const slots = [
    { value: params?.sandbox, denied: DANGEROUS_SANDBOX_VALUES, running: record?.sandbox },
    { value: params?.permissions, denied: DANGEROUS_PERMISSION_VALUES },
    { value: params?.approvalPolicy, denied: DANGEROUS_APPROVAL_POLICY_VALUES, running: record?.approvalPolicy },
  ];
  return slots.some(({ value, denied, running }) => permissionValues(value).some((candidate) => {
    const normalized = String(candidate).toLowerCase();
    if (!denied.has(normalized)) return false;
    if (running != null && normalized === String(running).toLowerCase()) {
      return normalized === 'danger-full-access';
    }
    return true;
  }));
}

function pathsOfApproval(params) {
  const out = [];
  const add = (p) => {
    if (p != null && p !== '') out.push(String(p));
  };
  add(params?.cwd);
  const changes = params?.fileChanges;
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const k of Object.keys(changes)) add(k);
  }
  return out;
}

function resolveTarget(raw, cwd) {
  const s = String(raw ?? '');
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  if (!cwd) return null;
  const base = String(cwd);
  return `${base}${base.endsWith('/') || base.endsWith('\\') ? '' : path.sep}${s}`;
}

function absolutePath(value) {
  const s = String(value ?? '');
  if (!s) return null;
  if (path.isAbsolute(s)) return s;
  const base = process.cwd();
  return `${base}${base.endsWith('/') || base.endsWith('\\') ? '' : path.sep}${s}`;
}

// Not store.js's canonicalPath: that falls back to abs on failure, this gate returns null and
// denies. `realpathSync` keeps the caller's case — measured on macOS APFS with Node 25.2.1.
function containmentPath(value) {
  const abs = absolutePath(value);
  if (!abs) return null;
  const parsed = path.parse(abs);
  let resolved = parsed.root;
  const pending = abs.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  const missing = [];
  let linkCount = 0;
  while (pending.length) {
    const segment = pending.shift();
    if (missing.length) {
      if (segment === '.') continue;
      if (segment === '..') {
        missing.pop();
        continue;
      }
      missing.push(segment);
      continue;
    }
    if (segment === '.') continue;
    if (segment === '..') {
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, segment);
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
      missing.push(segment);
      continue;
    }
    if (!stat.isSymbolicLink()) {
      resolved = candidate;
      continue;
    }
    if (linkCount >= 64) return null;
    linkCount += 1;
    let target;
    try {
      target = String(readlinkSync(candidate));
    } catch {
      return null;
    }
    if (!target) return null;
    if (path.isAbsolute(target)) {
      const targetParsed = path.parse(target);
      resolved = targetParsed.root;
      pending.unshift(...target.slice(targetParsed.root.length).split(/[\\/]+/).filter(Boolean));
    } else {
      pending.unshift(...target.split(/[\\/]+/).filter(Boolean));
    }
  }
  try {
    const root = realpathSync(resolved);
    return missing.length ? path.join(root, ...missing) : root;
  } catch {
    return null;
  }
}

function insideRoots(abs, roots) {
  if (!abs) return false;
  // This is an approval-time check; the holder does not perform the write, so TOCTOU remains.
  return roots.some((root) => root && (abs === root || abs.startsWith(`${root}${path.sep}`)));
}

// `_meta` discriminator of codex-cli 0.146.0 and the ONE value the holder answers for.
// It has others (`tool_suggestion`) — 03-cli § The Codex holder.
const CODEX_APPROVAL_KIND = 'codex_approval_kind';
const MCP_TOOL_CALL_KIND = 'mcp_tool_call';

/** `is_message_only_schema` of `mcp_server_elicitation.rs` at tag `rust-v0.146.0`, mirrored
 * field for field. An ABSENT `requestedSchema` is not an explicit `null` and is refused. */
function messageOnlySchema(params) {
  if (!Object.hasOwn(params, 'requestedSchema')) return false;
  const schema = params.requestedSchema;
  if (schema === null) return true;
  if (typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (schema.type !== 'object') return false;
  const props = schema.properties;
  return !!props && typeof props === 'object' && !Array.isArray(props) && Object.keys(props).length === 0;
}

/** The ONE request the holder answers for a person. A WHITELIST, not a chain of filters —
 * an unseen shape declines itself. [03-cli.md § The Codex holder](../docs/reference/03-cli.md#the-codex-holder) */
function isToolCallApproval(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  if (approvalKind(params) !== MCP_TOOL_CALL_KIND) return false;
  // Upstream applies the schema test inside the Form arm; a URL elicitation is a different
  // variant and carries no schema at all, so the mode is part of the proof, not a detail.
  if (params.mode !== 'form') return false;
  return messageOnlySchema(params);
}

// `[mcp_servers.<name>]` only — a nested `[mcp_servers.<name>.env]` is not a server.
// The writer quotes a key the way `JSON.stringify` does. 05-drivers § codex_apps.
const MCP_SERVER_HEADER = /^\[mcp_servers\.([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*")\]$/;

function mcpServerNamesFromHomeConfig(text) {
  const names = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const match = MCP_SERVER_HEADER.exec(line);
    if (!match) continue;
    const raw = match[1];
    if (!raw.startsWith('"')) {
      names.add(raw);
      continue;
    }
    try {
      const name = JSON.parse(raw);
      if (typeof name === 'string' && name) names.add(name);
    } catch {
      // A header this writer did not emit names no server.
    }
  }
  return names;
}

/** The `[mcp_servers]` keys the lift wrote, read once at holder start. A later write to the
 * home does not widen this set. [05-drivers § codex_apps](../docs/reference/05-drivers.md#the-built-in-codex_apps-server-stays-off-in-the-participant-home) */
export function configuredMcpServers(record) {
  const home = record && typeof record.codexHome === 'string' ? record.codexHome : '';
  if (!home) {
    return { ok: false, why: 'the session record names no Codex home, so no MCP server is approved' };
  }
  let text;
  try {
    text = readFileSync(path.join(home, 'config.toml'), 'utf8');
  } catch {
    return { ok: false, why: "the participant home's config.toml could not be read, so no MCP server is approved" };
  }
  return { ok: true, names: mcpServerNamesFromHomeConfig(text) };
}

function toolCallServerRefusal(params, configured) {
  if (!configured || configured.ok !== true) {
    return {
      allow: false,
      why: configured?.why || 'the holder has no MCP server snapshot from its start, so no MCP server is approved',
    };
  }
  const server = typeof params?.serverName === 'string' ? params.serverName : '';
  if (server && configured.names.has(server)) return null;
  const shown = (server || 'absent').slice(0, 200);
  return {
    allow: false,
    why: `an mcp_tool_call elicitation names server «${shown}», which this participant's home does not configure`,
  };
}

/** The `_meta` marker, or null when the request is a server's own elicitation. */
function approvalKind(params) {
  const meta = params && typeof params === 'object' ? params._meta : null;
  const kind = meta && typeof meta === 'object' ? meta[CODEX_APPROVAL_KIND] : null;
  // Only a string is a kind. `String(['mcp_tool_call'])` is the allowed discriminator
  // exactly, so a coercion here would pass an array through a strict comparison.
  return typeof kind === 'string' && kind !== '' ? kind : null;
}

/** Allowlisted fields of a server-to-client request. Never the prompt, schema, url or params
 * blob; `schema` and `kind` are shape, and name which question was asked. */
export function serverRequestSummary(method, params) {
  const p = params && typeof params === 'object' ? params : {};
  const server = p.serverName ?? p.server ?? null;
  const mode = p.mode ?? null;
  return {
    method,
    server: server == null || server === '' ? null : String(server),
    mode: mode == null || mode === '' ? null : String(mode),
    schema: p.requestedSchema != null,
    kind: approvalKind(p),
  };
}

export function decideApproval(method, params, record, configuredServers) {
  if (looksLikeConfigRead(method)) {
    return { allow: false, why: 'config/read returns secrets from the personal config — the mechanism client does not call it and does not approve it' };
  }
  if (method === 'currentTime/read') {
    return { allow: true };
  }
  const known = APPROVE[method];
  if (!known) {
    return { allow: false, why: `unknown approval request type «${method}»`, unknown: true };
  }
  if ((method === 'applyPatchApproval' || method === 'item/fileChange/requestApproval')
    && typeof params?.grantRoot === 'string' && params.grantRoot.trim()) {
    return { allow: false, why: `grantRoot escalation denied: ${params.grantRoot}` };
  }
  if (method === 'mcpServer/elicitation/request') {
    // One allowed shape, proved in full; everything else is a question to a person.
    if (isToolCallApproval(params)) {
      const serverRefusal = toolCallServerRefusal(params, configuredServers);
      if (serverRefusal) return serverRefusal;
      return { allow: true };
    }
    const kind = approvalKind(params);
    if (kind === MCP_TOOL_CALL_KIND) {
      return { allow: false, why: `an elicitation marked «${kind}» that is not the tool-approval shape (mode=${params?.mode ?? 'absent'}, message-only schema=${messageOnlySchema(params ?? {})}) — the participant has no person to answer it` };
    }
    if (kind) return { allow: false, why: `elicitation of kind «${kind}» is not a tool-call approval — nobody here can answer it` };
    return { allow: false, why: 'the participant has no person to answer an elicitation' };
  }
  if (method === 'item/tool/requestUserInput') {
    return { allow: true };
  }
  // Before containment and before the role split: a command whose cwd is inside the roots
  // is still an escalation when it asks to leave the network sandbox.
  if (COMMAND_APPROVALS.has(method)) {
    const why = networkEscalationWhy(params);
    if (why) return { allow: false, why };
  }
  // Keyed on the shipped step names, not on step kinds: 04-protocol § The role registry.
  const reviewer = record.role === REVIEWER || record.role === 'reporter';
  if (reviewer) {
    if (method === 'item/permissions/requestApproval') {
      return { allow: false, why: permissionRequestWhy(params) };
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval'
      || method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      return { allow: false, why: 'reviewer read-only: tree mutation denied' };
    }
    return { allow: true };
  }
  if (method === 'item/permissions/requestApproval') {
    if (asksForEscalatedPermission(params, record)) {
      return { allow: false, why: 'privilege escalation denied' };
    }
    return { allow: false, why: permissionRequestWhy(params) };
  }
  if (MUTATION_APPROVALS.has(method)) {
    // Canonical containment resolves symlinks and traversal before deciding, and fails
    // closed. It cannot close the TOCTOU gap before a later write outside this holder.
    const raws = pathsOfApproval(params);
    if (!raws.length) {
      const why = method === 'item/fileChange/requestApproval'
        ? 'item/fileChange/requestApproval carries no path to contain'
        : 'action target is unreadable';
      return { allow: false, why };
    }
    const rootValues = [record.cwd, ...(record.addDirs ?? [])].filter(Boolean);
    const roots = rootValues.map(containmentPath);
    if (!roots.some(Boolean)) {
      return { allow: false, why: 'the recorded cwd could not be resolved' };
    }
    const unresolvedRoots = rootValues.filter((_, index) => !roots[index]);
    const allowedRoots = [...new Set(roots.filter(Boolean))].join(', ');
    const rootsNote = ` (allowed roots: ${allowedRoots}`
      + `${unresolvedRoots.length ? `; unresolved roots: ${unresolvedRoots.join(', ')}` : ''})`;
    for (const raw of raws) {
      const abs = resolveTarget(raw, record.cwd);
      if (!abs) return { allow: false, why: `action target could not be resolved: ${raw}` };
      const canonical = containmentPath(abs);
      if (!canonical) return { allow: false, why: `action target could not be resolved: ${raw}` };
      if (!insideRoots(canonical, roots)) {
        const target = abs === canonical ? abs : `${abs} → ${canonical}`;
        return { allow: false, why: `action outside cwd/addDirs: ${target}${rootsNote}` };
      }
    }
  }
  if (asksForEscalatedPermission(params, record)) {
    return { allow: false, why: 'privilege escalation denied' };
  }
  return { allow: true };
}

// Prefix of the `mcp_servers` keys in the participant home's `config.toml`: the tool name the
// model sees is built from the key — [02-host.md](../docs/reference/02-host.md#consumer-identity-inside-a-harness).
export function codexMcpPrefix(host) {
  return `${host.commandName}-`;
}

export function codexMcpName(name, prefix) {
  const n = String(name ?? '');
  if (!n) return n;
  // No prefix is not "the canonical name": it fails silently in both directions — as a
  // config key it kills the load, as a tool name it sends the participant after a ghost.
  if (!prefix) throw new Error('codexMcpName: no override key prefix — pass codexMcpPrefix(host)');
  return n.startsWith(prefix) ? n : `${prefix}${n}`;
}

/** Workspace MCP set into the Codex `mcp_servers` form. The two transports do not share a
 * field, and a foreign one kills the config load: [05-drivers.md](../docs/reference/05-drivers.md#the-two-mcp_servers-transports-and-the-field-that-kills-the-config-load) */
export function codexMcpServers(servers, prefix) {
  const out = {};
  const skipped = [];
  const copyDisabledTools = (entry, cfg) => {
    const tools = Array.isArray(cfg.disabled_tools)
      ? [...new Set(cfg.disabled_tools.map(String).filter(Boolean))]
      : [];
    if (tools.length) entry.disabled_tools = tools;
  };
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    if (!cfg || typeof cfg !== 'object') {
      skipped.push(name);
      continue;
    }
    const type = String(cfg.type ?? (cfg.url ? 'http' : 'stdio'));
    const key = codexMcpName(name, prefix);
    if (type === 'http' || type === 'streamable_http') {
      if (!cfg.url) {
        skipped.push(name);
        continue;
      }
      const entry = { url: String(cfg.url) };
      const headers = cfg.headers ?? cfg.http_headers;
      if (headers && typeof headers === 'object' && Object.keys(headers).length) {
        entry.http_headers = { ...headers };
      }
      copyDisabledTools(entry, cfg);
      out[key] = entry;
      continue;
    }
    if (type === 'stdio' && cfg.command) {
      const entry = { command: cfg.command, args: cfg.args ?? [], env: cfg.env ?? {} };
      copyDisabledTools(entry, cfg);
      out[key] = entry;
      continue;
    }
    skipped.push(name);
  }
  return { servers: out, skipped };
}

// The holder log does NOT create its directory, and that is the whole rule — a write with
// nowhere to go is dropped: [05-drivers.md](../docs/reference/05-drivers.md#the-holders-record-watch).
function logHold(file, line) {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The directory is gone, or unwritable. Neither is a reason to fail a holder.
  }
}

export function threadStartConfig(record) {
  return {
    bypass_hook_trust: true,
    ...(record.role === REVIEWER ? { 'features.shell_tool': false, 'features.unified_exec': false } : {}),
    ...(['teamlead', 'reporter', 'orchestrator'].includes(record.role) ? { 'features.hooks': false } : {}),
    ...(record.effort ? { model_reasoning_effort: record.effort } : {}),
  };
}

export function verifyThreadProfile(record, result, log = () => {}) {
  const sandboxNames = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
  const requested = { model: record.model ?? null, effort: record.effort ?? null,
    sandbox: sandboxNames[record.sandbox] ?? record.sandbox, approvalPolicy: record.approvalPolicy };
  const effective = { model: result?.model ?? null, effort: result?.reasoningEffort ?? null,
    sandbox: result?.sandbox?.type ?? null, approvalPolicy: result?.approvalPolicy ?? null };
  const network = effective.sandbox === 'dangerFullAccess' ? 'unrestricted'
    : result?.sandbox?.networkAccess === true ? 'enabled' : 'restricted';
  log(`execution profile: requested=${JSON.stringify(requested)} effective=${JSON.stringify(effective)} network=${network}`);
  for (const field of Object.keys(requested)) {
    if (requested[field] != null && requested[field] !== effective[field]) {
      throw new Error(`Codex execution profile mismatch: ${field} requested=${JSON.stringify(requested[field])} effective=${JSON.stringify(effective[field])}; no model turn started`);
    }
  }
}

/** Disable personal duplicates by the paths Codex itself lists. The private canonical copy also
 * has user scope for an install-root role, so its directory is excluded explicitly. */
export function canonicalSkillOverrides(listed, canonicalDir) {
  const skills = (listed?.data ?? []).flatMap((entry) => entry.skills ?? []);
  const dir = path.resolve(canonicalDir) + path.sep;
  const canonical = (skill) => path.resolve(skill.path ?? '').startsWith(dir);
  const names = new Set(skills.filter(canonical).map((skill) => skill.name));
  return skills.filter((skill) => skill.scope === 'user' && names.has(skill.name) && !canonical(skill))
    .map((skill) => ({ path: skill.path, enabled: false }));
}

export function recoveryPrompt(record, history) {
  if (!record.initialPrompt || record.initialAssignmentInjected) return record.prompt;
  const original = record.initialPrompt;
  const delivered = (history?.thread?.turns ?? []).some((turn) => (turn.items ?? []).some((item) =>
    item.type === 'userMessage' && (item.content ?? []).some((content) =>
      content.type === 'text' && (content.text === original
        || content.text?.startsWith(`${original}\n\n## Recovery continuation\n`)))));
  return delivered || record.prompt === original ? record.prompt
    : `${original}\n\n## Recovery continuation\n${record.prompt}`;
}

/** Body of the detached holder. The argument is the path to the session record: the holder
 * does not rebuild the ref from argv, so it cannot drift from the file key. */
export async function holdMain(argv = process.argv.slice(2), env = process.env) {
  const file = argv[0];
  if (!file) {
    process.stderr.write('codex-hold: no session record path\n');
    process.exit(2);
  }
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(`codex-hold: record unreadable: ${err.message}\n`);
    process.exit(2);
  }
  const expectedLaunch = argv[1];
  if (expectedLaunch && record.launchId !== expectedLaunch) {
    process.stderr.write('codex-hold: launch ownership changed before holder startup\n');
    process.exit(3);
  }
  const ref = record.ref;
  const ownsLaunch = () => {
    const current = readSession(ref, env);
    return !!current && current.launchId === record.launchId;
  };
  const patchHeld = (ref, patch, env) => withSessionLaunch(ref, env, () =>
    ownsLaunch() ? patchSession(ref, patch, env) : null);
  const logFile = holderLogFile(ref, env);
  const log = (line) => { if (ownsLaunch()) logHold(logFile, line); };
  const lock = withSessionLaunch(ref, env, () => {
    if (!ownsLaunch()) return { ok: false, ownershipChanged: true };
    return takeHolderLock(ref, env);
  });
  if (!lock.ok) {
    if (lock.ownershipChanged) process.stderr.write('codex-hold: launch ownership changed before app-server startup\n');
    else {
      patchHeld(ref, { error: lock.error }, env);
      log(`lock: ${lock.error}`);
    }
    process.exit(3);
  }
  // Once, from the home spawn wrote before this process. A later append must not widen it.
  const configuredServers = configuredMcpServers(record);
  writeFileSync(logFile, '', { mode: 0o600 });
  log(record.provenance ?? provenanceLine(provenanceFromRecord(record)));

  const sock = socketPath(ref, env);
  rmSync(sock, { force: true });

  const cleanupHeld = () => withSessionLaunch(ref, env, () => {
    if (ownsLaunch()) rmSync(sock, { force: true });
    dropHolderLock(ref, env);
  });

  const rawLocalStartup = env.PROMPTOBUS_CODEX_RAW_TOOL_RECEIPTS === '1';
  if (rawLocalStartup) {
    let localOnly = false;
    try {
      if (typeof record.codexHome === 'string' && path.isAbsolute(record.codexHome)
        && env.CODEX_HOME === record.codexHome && lstatSync(record.codexHome).isDirectory()
        && !['CODEX_EXEC_SERVER_URL', 'CODEX_EXEC_SERVER_NOISE_REGISTRY_URL',
          'CODEX_EXEC_SERVER_NOISE_ENVIRONMENT_ID', 'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN',
          'CODEX_EXEC_SERVER_NOISE_CHATGPT_ACCOUNT_ID'].some(key => Object.hasOwn(env, key))) {
        try { lstatSync(path.join(record.codexHome, 'environments.toml')); }
        catch (error) { localOnly = error.code === 'ENOENT'; }
      }
    } catch { /* An unproved private home cannot establish the executor selection. */ }
    if (!localOnly) {
      const error = 'Experimental raw tool receipts require a private singleton-local startup without executor selectors or environments.toml';
      patchHeld(ref, { state: 'failed', error }, env);
      log(`refusal: ${error}`);
      cleanupHeld();
      process.exit(1);
    }
  }
  const child = spawn(record.bin, PARTICIPANT_ARGV, {
    cwd: record.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  log(`app-server pid ${child.pid} bin ${record.bin}`);
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});
  const receiptFile = path.join(codexStateHome(env), 'receipts', sessionKey(ref),
    sessionKey(record.launchId ?? `legacy-${process.pid}`) + '.jsonl');
  const receipts = commandReceipts(receiptFile, { format: 1, ref, launchId: record.launchId ?? null,
    cwd: record.cwd,
    holderPid: process.pid, appPid: child.pid,
    rawToolReceipts: env.PROMPTOBUS_CODEX_RAW_TOOL_RECEIPTS === '1',
    task: record.task ?? null, address: record.address ?? null });
  patchHeld(ref, { commandReceiptFile: receiptFile, rawToolReceipts: env.PROMPTOBUS_CODEX_RAW_TOOL_RECEIPTS === '1' }, env);
  let closingApp = false;
  let appClose = null;
  const appClosed = new Promise(resolve => child.once('close', (code, signal) => {
    appClose = { code, signal };
    receipts.append('app-server/close', appClose);
    resolve();
    if (!readSession(ref, env)?.stopping) { cleanupHeld(); process.exit(1); }
  }));

  // The holder must not outlive its own SESSION, and nothing else reaps it. The app-server
  // is killed FIRST: [05-drivers.md](../docs/reference/05-drivers.md#the-holders-record-watch).
  const recordWatch = setInterval(() => {
    if (existsSync(file) && (!expectedLaunch || readSession(ref, env)?.launchId === expectedLaunch)) return;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    process.exit(0);
  }, RECORD_WATCH_MS);
  recordWatch.unref();

  const methodsCalled = [];
  const noteMethod = (m) => {
    if (!methodsCalled.includes(m)) methodsCalled.push(m);
  };

  const rpc = CodexRpc({ stdin: child.stdin, stdout: child.stdout }, {
    onLog: (dir, obj) => {
      if (dir === 'raw') receipts.fail('app-server output is not a complete JSON-RPC stream');
      if (dir === 'orphan') {
        log(`orphan id=${obj?.id === undefined || obj?.id === null ? '' : String(obj.id)}`);
        return;
      }
      if (obj.method) noteMethod(obj.method);
    },
  });
  child.stdout.on('error', error => receipts.fail(`app-server output failed: ${error.code ?? error.message}`));
  child.stdout.on('end', () => {
    if (!closingApp) receipts.fail('app-server output closed before confirmed Stop finalization');
    rpc.close();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => log(`stderr ${String(chunk).slice(0, 400)}`));

  const state = {
    threadId: null,
    busy: false,
    activeTurns: new Set(),
    turnStarted: false,
    currentTurnId: null,
    threadStatus: null,
    rateLimits: null,
    lastUnknownApproval: null,
    nameSet: null,
    turns: record.turns ?? 0,
    methodsCalled,
    lastEvent: null,
    lastEventAt: null,
    pendingRequests: [],
    pendingRequest: null,
  };
  const syncAuth = record.authOwnerHome ? createParticipantAuthReload({
    ownerHome: record.authOwnerHome,
    participantHome: record.codexHome,
    reload: () => rpc.request('account/read', { refreshToken: false }, INIT_TIMEOUT_MS),
  }) : null;
  let turnRequests = Promise.resolve();
  let stopping = false;
  let shutdownInFlight = null;
  let shutdownResult = null;
  let activeRpcRequests = 0;
  let unresolvedStart = null;
  const interruptedTurns = new Map();
  let requestCompletions = null;
  const requestTurn = (method, params, timeoutMs) => {
    if (stopping) return Promise.reject(new Error('Codex holder is stopping'));
    const next = turnRequests.then(async () => {
      if (!ownsLaunch()) throw new Error('Codex launch ownership changed before model input');
      if (stopping) throw new Error('Codex holder is stopping');
      if (receipts.snapshot().error) throw new Error(receipts.snapshot().error);
      if (syncAuth) await syncAuth({ busy: state.busy });
      if (stopping) throw new Error('Codex holder is stopping');
      const request = withSessionLaunch(ref, env, () => {
        if (!ownsLaunch()) throw new Error('Codex launch ownership changed before model input');
        if (stopping || readSession(ref, env)?.stopping) throw new Error('Codex holder is stopping');
        if (method !== 'turn/start' || params.threadId !== state.threadId
          || Object.keys(params).some(key => !['threadId', 'input', 'effort'].includes(key)))
          receipts.context('invalidated', { launchId: record.launchId, threadId: state.threadId });
        return rpc.request(method, params, timeoutMs);
      });
      requestCompletions = new Set();
      try {
        const response = await request;
        const turnId = response.result?.turn?.id ?? response.result?.id;
        if (!response.error && method === 'turn/start' && typeof turnId === 'string' && turnId)
          receipts.context('turn/accepted', { launchId: record.launchId, threadId: state.threadId, turnId });
        const completedId = state.lastTurn?.turn?.id ?? state.lastTurn?.id;
        if (!response.error && method !== 'turn/steer'
          && typeof turnId === 'string' && turnId.trim() && turnId !== completedId && !requestCompletions.has(turnId)) {
          state.activeTurns.add(turnId);
          state.busy = true;
        }
        if (!response.error && method !== 'turn/steer' && (typeof turnId !== 'string' || !turnId.trim()))
          unresolvedStart = `${method} returned no terminally accountable turn id`;
        return response;
      } catch (error) {
        unresolvedStart = `${method} outcome unknown: ${error.message}`;
        throw error;
      } finally {
        requestCompletions = null;
      }
    });
    turnRequests = next.catch(() => {});
    return next;
  };
  const waiters = new Set();
  const wakeWaiters = (pred) => {
    for (const w of [...waiters]) {
      if (w.pred()) {
        waiters.delete(w);
        w.resolve();
      }
    }
  };

  rpc.onNotification((msg) => {
    if (!ownsLaunch()) return;
    const p = msg.params ?? {};
    if (state.threadId && p.threadId && p.threadId !== state.threadId) return;
    receipts.observe(msg, state.threadId);
    const lastEventAt = new Date().toISOString();
    state.lastEvent = msg.method;
    state.lastEventAt = lastEventAt;
    if (msg.method === 'account/rateLimits/updated') {
      log(`debug event ${msg.method} payload=${JSON.stringify(p)}`);
    } else if (msg.method === 'hook/started' || msg.method === 'hook/completed') {
      const run = p.run ?? {};
      log(`event ${msg.method} ${run.eventName ?? ''} ${run.status ?? ''} ${run.sourcePath ?? ''}`);
    } else if (p.item?.type === 'mcpToolCall') {
      // An MCP call the participant made, with its outcome: without this line a failed bus
      // call reads in the log exactly like a dead server.
      const item = p.item;
      const why = item.error ? ` ${JSON.stringify(item.error).slice(0, 300)}` : '';
      log(`event ${msg.method} mcp ${item.server ?? '?'}/${item.tool ?? '?'} ${item.status ?? '?'}${why}`);
    } else {
      log(`event ${msg.method}`);
    }
    const activity = { lastEvent: msg.method, lastEventAt };
    if (msg.method === 'serverRequest/resolved') {
      state.pendingRequests = outstandingAfterResolved(state.pendingRequests, p.requestId);
      state.pendingRequest = oldestPending(state.pendingRequests);
      activity.pendingRequests = state.pendingRequests;
      activity.pendingRequest = state.pendingRequest;
    }
    if (msg.method === 'account/rateLimits/updated') {
      state.rateLimits = p;
      patchHeld(ref, { rateLimits: p, ...activity }, env);
    }
    if (msg.method === 'thread/status/changed') {
      state.threadStatus = p.type ?? p.status ?? p;
      if (p.type === 'idle' || p.status === 'idle') state.busy = state.activeTurns.size > 0;
      if (p.type === 'active') state.busy = true;
      patchHeld(ref, activity, env);
    }
    if (msg.method === 'turn/started') {
      state.busy = true;
      state.turnStarted = true;
      state.currentTurnId = p.id ?? p.turn?.id ?? state.currentTurnId;
      if (state.currentTurnId) state.activeTurns.add(state.currentTurnId);
      patchHeld(ref, {
        state: 'alive',
        busy: true,
        currentTurnId: state.currentTurnId,
        firstTurnStartedAt: readSession(ref, env)?.firstTurnStartedAt ?? new Date().toISOString(),
        error: null,
        ...activity,
      }, env);
      wakeWaiters(() => state.turnStarted);
      log(`turn/started ${state.currentTurnId}`);
    }
    if (msg.method === 'turn/completed') {
      const completedTurnId = p.id ?? p.turn?.id ?? state.currentTurnId;
      requestCompletions?.add(completedTurnId);
      state.activeTurns.delete(completedTurnId);
      state.busy = state.activeTurns.size > 0;
      if (completedTurnId === state.currentTurnId) state.turnStarted = false;
      state.turns += 1;
      state.lastTurn = p;
      state.pendingRequests = [];
      state.pendingRequest = null;
      const error = turnErrorText(p);
      const lastTurn = {
        id: completedTurnId,
        status: p.status ?? p.turn?.status ?? null,
        at: lastEventAt,
        ...(error ? { error } : {}),
      };
      patchHeld(ref, {
        busy: state.busy,
        turns: state.turns,
        ...(state.turns === 1 ? { firstTurnEndedAt: lastEventAt } : {}),
        lastTurn,
        pendingRequests: [],
        pendingRequest: null,
        methodsCalled,
        ...activity,
      }, env);
      withSessionLaunch(ref, env, () => {
        if (ownsLaunch()) writeParticipantWake({ ...readSession(ref, env), turns: state.turns, rpcSocket: sock, threadId: state.threadId }, env);
      });
      wakeWaiters(() => !state.busy);
      log(`turn/completed ${completedTurnId} ${lastTurn.status ?? ''}`);
      if (turnFailed(lastTurn.status)) {
        const rec = readSession(ref, env);
        if (rec?.home && rec?.task) {
          logWarden(rec.home, rec.task, `Codex: last turn failed${error ? `: ${error}` : ''}`);
        }
      }
    }
    if (msg.method !== 'account/rateLimits/updated' && msg.method !== 'thread/status/changed'
      && msg.method !== 'turn/started' && msg.method !== 'turn/completed') {
      patchHeld(ref, activity, env);
    }
  });

  rpc.onServerRequest((msg) => {
    if (!ownsLaunch()) return approvalReply(msg.method, false);
    if (stopping) return approvalReply(msg.method, false);
    noteMethod(`srv:${msg.method}`);
    const rec = readSession(ref, env) ?? record;
    const decision = decideApproval(msg.method, msg.params, rec, configuredServers);
    const summary = serverRequestSummary(msg.method, msg.params);
    const who = [
      summary.server && `server=${summary.server}`,
      summary.mode && `mode=${summary.mode}`,
      summary.kind && `kind=${summary.kind}`,
      msg.method === 'mcpServer/elicitation/request' && `schema=${summary.schema}`,
    ].filter(Boolean).join(' ');
    const pendingAt = new Date().toISOString();
    const pendingRequest = {
      method: msg.method,
      server: summary.server,
      mode: summary.mode,
      kind: summary.kind,
      id: msg.id ?? null,
      at: pendingAt,
    };
    state.pendingRequests = [...state.pendingRequests, pendingRequest];
    state.pendingRequest = oldestPending(state.pendingRequests);
    state.lastEvent = `srv:${msg.method}`;
    state.lastEventAt = pendingAt;
    patchHeld(ref, {
      pendingRequests: state.pendingRequests,
      pendingRequest: state.pendingRequest,
      lastEvent: state.lastEvent,
      lastEventAt: pendingAt,
    }, env);
    const replyEvent = `holder-reply:${msg.method}`;
    const markReply = () => {
      const at = new Date().toISOString();
      state.lastEvent = replyEvent;
      state.lastEventAt = at;
      patchHeld(ref, { lastEvent: replyEvent, lastEventAt: at }, env);
    };
    if (decision.unknown) {
      state.lastUnknownApproval = { method: msg.method, at: new Date().toISOString(), why: decision.why };
      patchHeld(ref, { lastUnknownApproval: state.lastUnknownApproval }, env);
      if (rec.home && rec.task) {
        const statusHint = rec.statusHint;
        logWarden(rec.home, rec.task, `Codex: ${decision.why} — the turn was denied, see ${statusHint}`);
      }
      log(`approval unknown deny ${msg.method}${who ? ` ${who}` : ''}`);
      markReply();
      return approvalReply(msg.method, false);
    }
    if (!decision.allow) {
      const idNote = msg.method === 'mcpServer/elicitation/request' ? ` id=${JSON.stringify(msg.id ?? null)}` : '';
      log(`approval deny ${msg.method} ${decision.why}${who ? ` ${who}` : ''}${idNote}`);
      if (rec.home && rec.task) logWarden(rec.home, rec.task, `Codex: approval denied ${msg.method}: ${decision.why}`);
      markReply();
      return approvalReply(msg.method, false);
    }
    log(`approval allow ${msg.method}${who ? ` ${who}` : ''}`);
    markReply();
    if (msg.method === 'currentTime/read') return { currentTime: new Date().toISOString() };
    return approvalReply(msg.method, true, msg.params);
  });

  let server = null;
  let releaseFirstTurn = null;
  const firstTurnBinding = record.bindBeforeFirstTurn
    ? new Promise((resolve) => { releaseFirstTurn = resolve; }) : null;

  const failHold = (error) => {
    patchHeld(ref, { error, state: 'failed', methodsCalled }, env);
    log(`refusal: ${error}`);
    try {
      child.kill('SIGKILL');
    } catch {
      // The process is already gone.
    }
    cleanupHeld();
    process.exit(1);
  };

  child.on('error', (err) => {
    failHold(`app-server did not start: ${err.message}`);
  });
  child.on('exit', (code, sig) => {
    log(`app-server exit ${code} ${sig ?? ''}`);
    const rec = readSession(ref, env);
    if (rec?.stopping) return;
    if (rec && rec.state !== 'failed') {
      patchHeld(ref, { state: 'dead', error: `app-server exited (${code ?? sig})` }, env);
    }
  });

  server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', async (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch (err) {
        conn.write(`${JSON.stringify({ id: null, error: err.message })}\n`);
        conn.end();
        return;
      }
      buf = buf.slice(nl + 1);
      try {
        const result = await handleOp(req);
        conn.write(`${JSON.stringify({ id: req.id, result })}\n`);
      } catch (err) {
        conn.write(`${JSON.stringify({ id: req.id, error: err.message })}\n`);
      }
      conn.end();
    });
  });

  async function handleOp(req) {
    if (req.op === 'bound' && releaseFirstTurn) {
      releaseFirstTurn();
      releaseFirstTurn = null;
      return { ok: true };
    }
    if (req.op === 'status') {
      return {
        threadId: state.threadId,
        busy: state.busy,
        turnStarted: state.turnStarted,
        currentTurnId: state.currentTurnId,
        threadStatus: state.threadStatus,
        rateLimits: state.rateLimits,
        lastUnknownApproval: state.lastUnknownApproval,
        nameSet: state.nameSet,
        turns: state.turns,
        methodsCalled,
        lastEvent: state.lastEvent,
        lastEventAt: state.lastEventAt,
        pendingRequest: state.pendingRequest,
        pendingRequests: state.pendingRequests,
        stopping,
        activeTurns: [...state.activeTurns],
        commandReceiptFile: receiptFile,
        commandReceiptError: receipts.snapshot().error,
        appPid: child.pid,
      };
    }
    if (req.op === 'rpc') {
      if (closingApp) throw new Error('Codex app-server is closing');
      if (!['turn/start', 'turn/steer', 'review/start'].includes(req.method))
        receipts.context('invalidated', { launchId: record.launchId, threadId: state.threadId });
      const request = ['turn/start', 'turn/steer', 'review/start'].includes(req.method) ? requestTurn : rpc.request;
      activeRpcRequests += 1;
      try {
        const ans = await request(req.method, req.params ?? {}, req.timeoutMs ?? 60_000);
        if (ans.error) throw new Error(ans.error.message ?? JSON.stringify(ans.error));
        return ans.result ?? {};
      } finally { activeRpcRequests -= 1; }
    }
    if (req.op === 'shutdown') {
      if (!ownsLaunch() || (req.launchId !== undefined && req.launchId !== record.launchId))
        return { ok: false, stopped: false, note: 'Codex launch ownership changed; no shutdown issued' };
      if (shutdownResult) return shutdownResult;
      if (shutdownInFlight) return shutdownInFlight;
      stopping = true;
      patchHeld(ref, { stopping: true }, env);
      const requestedDeadline = Number.isFinite(req.deadlineAt) ? req.deadlineAt : Date.now() + 5_000;
      const deadline = Math.min(requestedDeadline, Date.now() + STOP_TIMEOUT_MS);
      shutdownInFlight = finalizeStop(deadline).then(result => {
        if (result.ok) shutdownResult = result;
        return result;
      }).finally(() => { shutdownInFlight = null; });
      return shutdownInFlight;
    }
    throw new Error(`unknown holder operation «${req.op}»`);
  }

  async function finalizeStop(deadline) {
    const waitUntil = async predicate => {
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      return predicate();
    };
    const unresolved = note => {
      const snapshot = receipts.snapshot();
      receipts.append('stop/unresolved', { note, activeTurns: [...state.activeTurns], commands: snapshot.commands });
      const why = receipts.snapshot().error ?? note;
      patchHeld(ref, { stopping: true, stopError: why }, env);
      return { ok: false, attempted: true, stopped: false, launchId: record.launchId ?? null,
        note: why, receiptFile };
    };
    receipts.append('stop/requested', { threadId: state.threadId, deadlineAt: deadline });
    if (appClose !== null) return unresolved('app-server already closed before this Stop request; no fresh confirmation issued');
    let requestsSettled = false;
    turnRequests.then(() => { requestsSettled = true; });
    if (!await waitUntil(() => requestsSettled || !!receipts.snapshot().error))
      return unresolved('in-flight turn request did not settle before the Stop deadline');
    if (receipts.snapshot().error) {
      const snapshot = receipts.snapshot(), auditError = snapshot.error;
      const lastTurn = { id: state.lastTurn?.turn?.id ?? state.lastTurn?.id,
        status: state.lastTurn?.turn?.status ?? state.lastTurn?.status };
      const idle = () => {
        const current = receipts.snapshot();
        const envelopes = current.rawTools?.refusedEnvelopes;
        const boundEnvelopes = Array.isArray(envelopes) && envelopes.length > 0
          && new Set(envelopes.map(envelope => envelope.callId)).size === envelopes.length
          && envelopes.every(envelope => envelope.threadId === state.threadId && envelope.turnId === lastTurn.id
            && typeof envelope.callId === 'string' && !!envelope.callId.trim()
            && !current.rawTools.calls.some(call => call.callId === envelope.callId));
        return current.envelopeOnlyFailure === true && boundEnvelopes && requestsSettled && !unresolvedStart && activeRpcRequests === 0
          && state.busy === false && state.turnStarted === false && state.activeTurns.size === 0
          && typeof lastTurn.id === 'string' && !!lastTurn.id.trim() && state.currentTurnId === lastTurn.id
          && ['completed', 'interrupted', 'failed'].includes(lastTurn.status)
          && (state.lastTurn?.turn?.id ?? state.lastTurn?.id) === lastTurn.id
          && (state.lastTurn?.turn?.status ?? state.lastTurn?.status) === lastTurn.status
          && (state.threadStatus === 'idle' || state.threadStatus?.type === 'idle')
          && state.pendingRequests.length === 0 && state.pendingRequest === null
          && current.pending.length === 0 && Array.isArray(current.rawTools?.pending) && current.rawTools.pending.length === 0;
      };
      // This audit-only refusal permits resource cleanup only with independent idle lifecycle proof.
      // Its raw ledger stays failed; the retained record is never a Stop confirmation.
      if (auditError !== 'original code-mode envelope is outside the supported single literal call shape'
        || typeof record.launchId !== 'string' || !record.launchId.trim() || !state.threadId
        || !idle() || !ownsLaunch() || Date.now() >= deadline) return unresolved(auditError);
      const cleanup = { format: 1, ref, launchId: record.launchId, threadId: state.threadId,
        holderPid: process.pid, appPid: child.pid, receiptFile, auditError, deadlineAt: deadline,
        requestedAt: new Date().toISOString(), appClosed: false, holderExitRequested: false,
        terminal: { lastTurn, busy: state.busy, activeTurns: [...state.activeTurns],
          pendingRequests: state.pendingRequests, commands: snapshot.commands, rawTools: snapshot.rawTools } };
      const persist = value => withSessionLaunch(ref, env, () => {
        if (!ownsLaunch()) return false;
        patchSession(ref, { state: 'failed', stopConfirmed: false, stopError: auditError, failedStopCleanup: value }, env);
        const fd = openSync(file, 'r+');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        return true;
      });
      try {
        if (!persist(cleanup) || Date.now() >= deadline) return unresolved(auditError);
        closingApp = true;
        child.stdin.end();
        if (!await waitUntil(() => appClose !== null)) return unresolved(auditError);
        await appClosed;
        if (!idle() || !ownsLaunch() || Date.now() >= deadline) return unresolved(auditError);
        if (!persist({ ...cleanup, appClosed: true, appClose, closedAt: new Date().toISOString(), holderExitRequested: true })
          || Date.now() >= deadline) return unresolved(auditError);
      } catch (error) {
        receipts.fail(`failed Stop resource cleanup failed: ${error.message}`);
        log(`failed Stop resource cleanup retained holder: ${error.message}`);
        return unresolved(auditError);
      }
      setTimeout(() => { cleanupHeld(); process.exit(1); }, 50);
      return { ok: false, attempted: true, stopped: false, launchId: record.launchId,
        note: auditError, receiptFile, appClosed: true, holderExitRequested: true };
    }
    if (unresolvedStart) return unresolved(unresolvedStart);
    if (receipts.snapshot().pending.length) {
      receipts.append('stop/waiting-commands', { itemIds: receipts.snapshot().pending });
      if (!await waitUntil(() => !!receipts.snapshot().error || !receipts.snapshot().pending.length))
        return unresolved('active command outcomes were not confirmed before the Stop deadline; no interrupt issued');
      if (receipts.snapshot().error) return unresolved(receipts.snapshot().error);
    }
    if (receipts.snapshot().rawTools?.pending.length) {
      receipts.append('stop/waiting-original-tools', { callIds: receipts.snapshot().rawTools.pending });
      if (!await waitUntil(() => !!receipts.snapshot().error || !receipts.snapshot().rawTools.pending.length))
        return unresolved('original selected tool receipts were not confirmed before the Stop deadline; no interrupt issued');
      if (receipts.snapshot().error) return unresolved(receipts.snapshot().error);
    }
    if (Date.now() >= deadline) return unresolved('Stop deadline elapsed before interrupt');
    const turnIds = [...state.activeTurns].filter(id => typeof id === 'string' && id.trim());
    await Promise.all(turnIds.map(async turnId => {
      if (interruptedTurns.has(turnId)) return;
      interruptedTurns.set(turnId, 'interrupt outcome pending');
      try {
        const answer = await rpc.request('turn/interrupt', { threadId: state.threadId, turnId }, Math.max(1, deadline - Date.now()));
        interruptedTurns.set(turnId, answer.error ? answer.error.message ?? 'interrupt refused' : null);
        receipts.append('stop/interrupt', { turnId, error: interruptedTurns.get(turnId) });
      } catch (error) {
        interruptedTurns.set(turnId, error.message);
        receipts.append('stop/interrupt', { turnId, error: error.message });
      }
    }));
    const interruptError = [...interruptedTurns.values()].find(Boolean);
    if (interruptError) return unresolved(interruptError);
    if (!await waitUntil(() => !!receipts.snapshot().error
      || (!state.activeTurns.size && !receipts.snapshot().pending.length && !receipts.snapshot().rawTools?.pending.length)))
      return unresolved('terminal turn/command outcomes were not confirmed before the Stop deadline');
    if (receipts.snapshot().error) return unresolved(receipts.snapshot().error);
    if (!ownsLaunch()) return unresolved('Codex launch ownership changed during Stop');
    if (Date.now() >= deadline) return unresolved('Stop deadline elapsed before app-server finalization');
    closingApp = true;
    child.stdin.end();
    if (!await waitUntil(() => appClose !== null)) return unresolved('app-server exit and output closure were not confirmed');
    await appClosed;
    if (Date.now() >= deadline) return unresolved('Stop deadline elapsed before durable confirmation');
    const snapshot = receipts.snapshot();
    if (snapshot.error || snapshot.pending.length || snapshot.rawTools?.pending.length || state.activeTurns.size || appClose.code !== 0)
      return unresolved(snapshot.error ?? 'app-server closure did not preserve terminal command accounting');
    if (!ownsLaunch()) return unresolved('Codex launch ownership changed before Stop confirmation');
    if (!receipts.append('stop/confirmed', { threadId: state.threadId, launchId: record.launchId ?? null,
      holderPid: process.pid, appPid: child.pid,
      commands: snapshot.commands, rawTools: snapshot.rawTools, appClose, deadlineAt: deadline, originalToolReceipt: 'not synthesized' }))
      return unresolved(receipts.snapshot().error);
    if (Date.now() >= deadline) return unresolved('Stop deadline elapsed while persisting confirmation');
    if (!patchHeld(ref, { stopConfirmed: true, stopError: null }, env))
      return unresolved('Codex launch ownership changed before Stop confirmation was recorded');
    setTimeout(() => { cleanupHeld(); process.exit(0); }, 50);
    return { ok: true, attempted: true, stopped: true, launchId: record.launchId ?? null, receiptFile };
  }

  const listenHolder = () => new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(sock, () => {
      try { chmodSync(sock, 0o600); } catch { /* platform without chmod on a socket */ }
      log(`listen ${sock}`);
      resolve();
    });
  });

  try {
    const init = await rpc.request('initialize', codexInitParams(record, env), INIT_TIMEOUT_MS);
    if (init.error) throw new Error(init.error.message ?? JSON.stringify(init.error));
    log('initialize ok');

    try {
      const lim = await rpc.waitNotification('account/rateLimits/updated', () => true, limitWaitMs(env));
      state.rateLimits = lim.params ?? null;
    } catch {
      log('rateLimits: no notification — not a refusal');
    }
    if (rateLimitReached(state.rateLimits)) {
      const note = rateLimitNote(state.rateLimits);
      failHold(`Codex account limit${note ? `: ${note}` : ''} — lift deferred until reset`);
      return;
    }

    if (record.model) {
      try {
        const listed = await rpc.request('model/list', { includeHidden: true }, MODEL_LIST_TIMEOUT_MS);
        const ids = listedModels(listed.result).map((m) => m.model);
        if (ids.length && !ids.includes(record.model)) {
          failHold(`model «${record.model}» is unknown to app-server (model/list)`);
          return;
        }
      } catch (err) {
        log(`model/list: ${err.message} — check skipped`);
      }
    }

    // No `config.mcp_servers` override: the isolated home removed the merge it existed for.
    // `bypass_hook_trust` is this request's override — the CLI flag does not reach app-server.
    const config = threadStartConfig(record);
    if (record.canonicalSkillsDir) {
      const skills = await rpc.request('skills/list', { cwds: [record.cwd], forceReload: true }, NAME_SET_TIMEOUT_MS);
      if (skills.error) throw new Error(`cannot establish canonical skills: ${skills.error.message ?? 'skills/list refused'}`);
      const suppressed = canonicalSkillOverrides(skills.result, record.canonicalSkillsDir);
      if (suppressed.length) config['skills.config'] = suppressed;
      log(`canonical skills: ${record.canonicalSkillsDir}; personal duplicates suppressed=${suppressed.length}`);
    }
    const startParams = {
      cwd: record.cwd,
      sandbox: record.sandbox,
      approvalPolicy: record.approvalPolicy,
      model: record.model,
      config,
    };
    const startMethod = record.resumeThreadId ? 'thread/resume' : 'thread/start';
    if (env.PROMPTOBUS_CODEX_RAW_TOOL_RECEIPTS === '1') {
      if (record.resumeThreadId) throw new Error('Experimental raw tool receipts require a fresh native thread');
      config['features.stable_environment_tools'] = false;
      startParams.experimentalRawEvents = true;
    }
    if (record.resumeThreadId) {
      startParams.threadId = record.resumeThreadId;
      startParams.excludeTurns = !record.initialPrompt;
    } else if (record.addDirs?.length) startParams.runtimeWorkspaceRoots = record.addDirs;
    const started = await rpc.request(startMethod, startParams, THREAD_START_TIMEOUT_MS);
    if (started.error) throw new Error(started.error.message ?? JSON.stringify(started.error));
    state.threadId = started.result?.thread?.id ?? started.result?.id;
    if (!state.threadId) throw new Error(`${startMethod} did not return a thread id`);
    if (record.resumeThreadId && state.threadId !== record.resumeThreadId) {
      throw new Error('thread/resume returned a different thread; refusing to replace the owner');
    }
    verifyThreadProfile(record, started.result, log);
    if (startMethod === 'thread/start' && started.result?.cwd === record.cwd && path.isAbsolute(record.cwd)
      && rawLocalStartup)
      receipts.context('thread/accepted', { launchId: record.launchId, threadId: state.threadId,
        cwd: started.result.cwd, profile: 'fixed-single-local' });
    const echoedEffort = started.result?.reasoningEffort;
    log(echoedEffort
      ? `${startMethod} ${state.threadId} reasoningEffort=${echoedEffort}`
      : `${startMethod} ${state.threadId}`);

    const threadName = record.name || `promptobus:${record.task}:${record.address}`;
    try {
      const named = await rpc.request('thread/name/set', { threadId: state.threadId, name: threadName }, NAME_SET_TIMEOUT_MS);
      state.nameSet = !named.error;
      if (named.error) log(`thread/name/set: ${named.error.message ?? 'refused'} — name layer unobserved`);
    } catch (err) {
      state.nameSet = false;
      log(`thread/name/set: ${err.message} — name layer unobserved`);
    }

    if (record.role === 'orchestrator' && !record.resumeThreadId) {
      const injected = await rpc.request('thread/inject_items', {
        threadId: state.threadId,
        items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: record.initialPrompt ?? record.prompt }] }],
      }, THREAD_START_TIMEOUT_MS);
      if (injected.error) throw new Error(`cannot preserve original assignment: ${injected.error.message ?? 'thread/inject_items refused'}`);
      record.initialAssignmentInjected = true;
    }

    patchHeld(ref, {
      holderPid: process.pid,
      appPid: child.pid,
      rpcSocket: sock,
      threadId: state.threadId,
      rolloutPath: started.result?.thread?.path ?? record.rolloutPath ?? null,
      initialAssignmentInjected: record.initialAssignmentInjected === true,
      nameSet: state.nameSet,
      rateLimits: state.rateLimits,
      methodsCalled,
      state: 'starting',
      busy: true,
    }, env);

    await listenHolder();
    if (firstTurnBinding) {
      patchHeld(ref, { state: 'binding', busy: false }, env);
      log('thread waiting for bus owner binding before its first turn');
      await firstTurnBinding;
      log('bus owner bound; starting first turn');
    }

    const firstPrompt = record.initialAssignmentInjected && !record.resumeThreadId
      ? 'Begin the original assignment already recorded in this conversation. Read the mailbox before doing its work and follow its approval boundaries.'
      : record.resumeThreadId && record.initialPrompt ? recoveryPrompt(record, started.result) : record.prompt;
    const firstRequestAt = Date.now();
    // Both roles use turn/start so bus tools stay on the participant thread; read-only is the
    // sandbox, and effort rides on thread/start config and here.
    const first = await requestTurn('turn/start', {
      threadId: state.threadId,
      ...(record.effort ? { effort: record.effort } : {}),
      input: [{ type: 'text', text: firstPrompt }],
    }, TURN_STARTED_TIMEOUT_MS);
    if (first.error) throw new Error(first.error.message ?? JSON.stringify(first.error));
    state.currentTurnId = first.result?.turn?.id ?? first.result?.id ?? state.currentTurnId;
    state.busy = true;

    const turnStartedRemaining = Math.max(1, TURN_STARTED_TIMEOUT_MS - (Date.now() - firstRequestAt));
    await new Promise((resolve, reject) => {
      const waiter = {
        pred: () => state.turnStarted,
        resolve: () => { clearTimeout(timer); resolve(); },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error('the first turn did not start'));
      }, turnStartedRemaining);
      waiters.add(waiter);
      if (state.turnStarted) {
        waiters.delete(waiter);
        clearTimeout(timer);
        resolve();
      }
    });

    patchHeld(ref, {
      // Not a literal: turn/started and turn/completed can arrive in one stdout
      // chunk, and the completed handler has then already written busy: false.
      busy: state.busy,
      threadId: state.threadId,
      holderPid: process.pid,
      appPid: child.pid,
      rpcSocket: sock,
      nameSet: state.nameSet,
      turns: state.turns,
      rateLimits: state.rateLimits,
      methodsCalled,
      error: null,
    }, env);
    log('alive');
  } catch (err) {
    failHold(err.message);
  }
}

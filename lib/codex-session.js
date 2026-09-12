import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, readdirSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from './codex-rpc.js';
import { foreignSession, logWarden, writeWake } from './store.js';
import { harnessStateHome } from './harness-home.js';
import { provenanceFromRecord, provenanceLine } from './provenance.js';
import { GateError } from '../dist/index.js';

// Codex participant thread registry and the `app-server` process holder. Nobody
// outside imports this file except the Codex driver: the adapter boundary gate
// covers it too.
//
// **Why the holder is a separate process.** CLI `promptobus spawn` returns once
// the first turn starts and dies. Cursor keeps the process alive with a tmux pane, Claude
// Code with a daemon. `app-server` has no such daemon: stdio is held by whoever
// opened it. The detached holder is that someone: it holds JSON-RPC, answers
// approvals, and listens on the unix socket the driver writes
// `turn/start` / `stop` into. One holder — one participant: a
// shared process for the workspace takes everyone with it when it dies, and Codex
// has no lock on a thread.
//
// The registry home is `~/.promptobus/codex`, not `~/.codex`. The latter is the
// owner's home, and the mechanism does not write there at all: a participant's
// app-server runs in an isolated `CODEX_HOME` of its own
// ([driver-codex.js](driver-codex.js)), so the `[projects]` records and the
// marketplace snapshot a run produces land there. `PROMPTOBUS_CODEX_HOME` overrides
// the registry as a whole: the suite uses it to put the registry in a sandbox.
// A missing registry-home declaration propagates through direct `inspect`, `stop` and
// `activate` calls; the aggregate session snapshot degrades driver errors to `unknown`,
// while `registerWake` and `sessionPrefix` retain their safety catches. `null` or `[]`
// means the named registry was opened and held no readable record.

export const SESSION_ENV_VAR = 'PROMPTOBUS_CODEX_SESSION';

// Participant argv. The bypass flag is a GLOBAL option and must precede the subcommand —
// why, and what it does and does not cover, in 03-cli § The Codex holder (PB-170).
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

/**
 * Registry of OUR threads and holders. `PROMPTOBUS_CODEX_HOME`, else the host, else a
 * refusal — never a guess under the real home; the reason is in
 * [harness-home.js](harness-home.js).
 */
export function codexStateHome(env = process.env) {
  return harnessStateHome(CODEX_HARNESS, env);
}

export function sessionsDir(env = process.env) {
  return path.join(codexStateHome(env), 'sessions');
}

export function sessionKey(ref) {
  const flat = String(ref ?? '');
  const head = flat.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase();
  const hash = createHash('sha1').update(flat).digest('hex').slice(0, 12);
  return head ? `${head}-${hash}` : hash;
}

export function sessionFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.json`);
}

// sockaddr_un.sun_path on Darwin is 104 bytes including NUL. The suite sandbox
// home (`$TMPDIR/promptobus-codex-…/state/sessions/…`) is easily longer, and
// listen then returns EINVAL: the holder does not lift, and the CLI sees only
// a waitReady timeout. The short fallback name is scoped by the registry home
// as well as the session ref, so two registries cannot share one socket.
const SOCK_MAX = 103;

export function socketPath(ref, env = process.env) {
  const refText = String(ref ?? '');
  const name = `${createHash('sha1').update(refText).digest('hex').slice(0, 12)}.sock`;
  const nested = path.join(sessionsDir(env), name);
  if (Buffer.byteLength(nested) <= SOCK_MAX) return nested;
  const fallback = `${createHash('sha1')
    .update(`${sessionsDir(env)}\0${refText}`)
    .digest('hex').slice(0, 12)}.sock`;
  return path.join(tmpdir(), `pb-cdx-${fallback}`);
}

export function holderLogFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.log`);
}

function lockFile(ref, env = process.env) {
  return path.join(sessionsDir(env), `${sessionKey(ref)}.lock`);
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return value;
}

export function readSession(ref, env = process.env) {
  try {
    return JSON.parse(readFileSync(sessionFile(ref, env), 'utf8'));
  } catch (e) {
    if (e instanceof GateError) throw e;
    return null;
  }
}

export function writeSession(record, env = process.env) {
  const { provenance, ...rest } = record;
  return writeJson(sessionFile(record.ref, env), {
    provenance: provenance ?? provenanceLine(provenanceFromRecord(record)),
    ...rest,
  });
}

export function patchSession(ref, patch, env = process.env) {
  const was = readSession(ref, env);
  if (!was) return null;
  return writeSession({ ...was, ...patch }, env);
}

/**
 * Drop the record and everything whose lifetime is the record's.
 *
 * The participant's `CODEX_HOME` is on that list, and it is on it HERE rather than in
 * the driver's `stop` alone: the record is what names the home, so any path that
 * removes the record without the home leaves a copy of the owner's credentials that
 * nothing has a handle on any more. The home directory itself belongs to the driver —
 * this file knows the path only because the record carries it — so the removal goes
 * through the driver's guard, which refuses anything that is not a direct child of the
 * homes root.
 */
export function dropSession(ref, env = process.env) {
  const record = readSession(ref, env);
  for (const file of [sessionFile(ref, env), socketPath(ref, env), lockFile(ref, env), holderLogFile(ref, env)]) {
    rmSync(file, { force: true });
  }
  if (record?.codexHome) dropParticipantHome(record.codexHome);
}

// Set by the driver at import. The home is the driver's construct and its guard lives
// there; this file must not grow a second opinion about which directories may be
// removed, and importing the driver here would close the one-way boundary the adapter
// gate stands on (the driver imports this file, never the other way round).
let dropParticipantHome = () => false;

export function bindParticipantHomeRemoval(fn) {
  dropParticipantHome = typeof fn === 'function' ? fn : (() => false);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function listSessions(env = process.env) {
  let names = [];
  try {
    names = readdirSync(sessionsDir(env));
  } catch (e) {
    if (e instanceof GateError) throw e;
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => {
    try {
      return JSON.parse(readFileSync(path.join(sessionsDir(env), n), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export function findSessionByAddress(home, task, address, env = process.env) {
  return listSessions(env).find((r) => r.home === home && r.task === task && r.address === address) ?? null;
}

// Holder preamble budget — the same timeouts that sit on the holdMain requests.
// A waitReady window without them caught a false refusal: initialize + limit +
// model/list + thread/start + name/set almost fill the old 60 s. Readiness then
// needs only the bounded wait for turn/started; the turn may run for hours.
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

/**
 * `model/list` rows as names, with the mark app-server puts on the ones it hides.
 *
 * Two gates read the same reply and must not parse it twice: the start path checks
 * a NAMED model against the names (a hidden model a person named is still a model
 * they named — the filtering is the caller's, not this function's), and the
 * availability adapter publishes every row and carries the mark (ADR-004), so the
 * resolver can take a hidden model out of its own inventory and `models validate`
 * can say "hidden" where it used to say "missing".
 *
 * The reply is taken as `data`, then `models`, then the result itself, because
 * that is the order the start path has always tried; anything that is not a list
 * at all is no list of models, and an empty one refuses nothing.
 */
export function listedModels(result) {
  const rows = result?.data ?? result?.models ?? result ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => (typeof row === 'string'
    ? { model: row, hidden: false }
    : { model: row?.id ?? row?.model ?? '', hidden: row?.hidden === true }));
}

// --- lock of one holder on a thread ------------------------------------------------

export function takeHolderLock(ref, env = process.env) {
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
}

export function dropHolderLock(ref, env = process.env) {
  rmSync(lockFile(ref, env), { force: true });
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
  return !!(rec?.holderPid && pidAlive(rec.holderPid));
}

export function startHolder(ref, env = process.env) {
  const file = sessionFile(ref, env);
  const child = spawn(process.execPath, [HOLD_JS, file], {
    detached: true,
    stdio: 'ignore',
    env: { ...env, PROMPTOBUS_CODEX_HOME: codexStateHome(env) },
  });
  child.unref();
  traceHolder(env, `${child.pid}\t${file}`);
  return child;
}

/**
 * How often the holder asks whether its session still exists. Five seconds is
 * chosen against the thing it reaps: a run directory removed at the end of a suite
 * run, where the holder's own lifetime past that point is what the gate measures.
 */
const RECORD_WATCH_MS = 5_000;

// Holder-start trace for the test suite. The path is `PROMPTOBUS_HOLDER_TRACE`,
// which the runner sets; the suite gate reads it at the TAIL of a run, because a
// holder is allowed to live during one — the Codex file starts real holders on
// purpose — and what is forbidden is one still alive when the run ends. The line
// carries the pid AND the session file, and the gate demands both: a pid alone is
// reused by the system and would accuse a stranger.
//
// Written here, at the decision to start, rather than inside the detached process:
// the write is synchronous with the act, and the gate reads a finished file. Same
// shape and same reason as the warden auto-lift trace in [warden.js](warden.js).
function traceHolder(env, line) {
  const file = env?.PROMPTOBUS_HOLDER_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // Suite diagnostics: a write refusal is no reason to fail a participant lift.
  }
}

export async function waitReady(ref, env = process.env, timeoutMs = readyMs(env)) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rec = readSession(ref, env);
    if (rec?.error) return { ok: false, error: rec.error, record: rec };
    if (rec?.state === 'alive' && rec.threadId) return { ok: true, record: rec };
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

export async function reapHolder(ref, env = process.env) {
  const record = readSession(ref, env);
  if (!record) return;
  if (holderAlive(ref, env)) {
    try {
      await holderAsk(ref, 'shutdown', {}, env, 5_000);
    } catch {
      killRecordPids(record);
    }
    await waitStopped(ref, env);
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
  'item/tool/requestUserInput': { ok: { response: 'ok' }, no: { response: '' } },
};

export function approvalReply(method, allow) {
  const row = APPROVE[method];
  if (row) return allow ? row.ok : row.no;
  return { __error: { code: -32601, message: `no handler for server request ${method}` } };
}

// `currentTime/read` has no static APPROVE row: its response is computed fresh for
// each request, so `decideApproval` recognizes it before this table and `onServerRequest`
// supplies the time-dependent result.

function looksLikeConfigRead(method) {
  return method === 'config/read';
}

const MUTATION_APPROVALS = new Set([
  'execCommandApproval',
  'applyPatchApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

// Command approvals that ask to leave the network sandbox. On the measured 0.146.0
// shape only `item/commandExecution/requestApproval` carries these two fields, but the
// check is by field and not by method: the legacy pair is the same kind of request, and
// a field that appears on it later must not arrive unread.
const COMMAND_APPROVALS = new Set([
  'execCommandApproval',
  'item/commandExecution/requestApproval',
]);

/**
 * Why a command approval is a network escalation, or `null`.
 *
 * `networkApprovalContext` is the host and protocol a command wants reached;
 * `proposedNetworkPolicyAmendments` are allow/deny host rules it proposes to keep. A
 * participant does not leave its network sandbox on request — the same line a reviewer
 * gets for a tree mutation — so both are refused, for workers and reviewers alike. The
 * plain `decline` applies no amendment either way: the reply enum has separate
 * `acceptWithExecpolicyAmendment` and `applyNetworkPolicyAmendment` arms, and the
 * holder sends neither.
 */
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

// Codex config vocabulary is checked only in the named top-level fields. The
// approval shapes were measured on codex-cli 0.146.0 from the generated schema
// in test/fixtures/codex-app-server/0.146.0/ on 2026-09-10; none nests them
// under `item`.
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

// Approval containment deliberately differs from store.js's canonicalPath: the store
// uses existsSync for an identity fallback and returns abs on failure, while this gate
// follows symlinks segment by segment with lstat/readlink and returns null on failure so
// an unresolved target is denied. The measured case behavior is kept at realpathSync.
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
// It has others (`tool_suggestion`) — 03-cli § The Codex holder (PB-161.4).
const CODEX_APPROVAL_KIND = 'codex_approval_kind';
const MCP_TOOL_CALL_KIND = 'mcp_tool_call';

/**
 * `is_message_only_schema` of `mcp_server_elicitation.rs` at tag `rust-v0.146.0`, mirrored
 * field for field. An ABSENT `requestedSchema` is not an explicit `null` and is refused.
 */
function messageOnlySchema(params) {
  if (!Object.hasOwn(params, 'requestedSchema')) return false;
  const schema = params.requestedSchema;
  if (schema === null) return true;
  if (typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (schema.type !== 'object') return false;
  const props = schema.properties;
  return !!props && typeof props === 'object' && !Array.isArray(props) && Object.keys(props).length === 0;
}

/**
 * The ONE request the holder answers for a person: codex-cli's per-call MCP tool
 * approval. A WHITELIST, not a chain of filters — everything unlisted is refused,
 * including shapes nobody has seen yet, so the next elicitation variant declines itself
 * instead of slipping through. 03-cli § The Codex holder (PB-161.4).
 */
function isToolCallApproval(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  if (approvalKind(params) !== MCP_TOOL_CALL_KIND) return false;
  // Upstream applies the schema test inside the Form arm; a URL elicitation is a different
  // variant and carries no schema at all, so the mode is part of the proof, not a detail.
  if (params.mode !== 'form') return false;
  return messageOnlySchema(params);
}

/** The `_meta` marker, or null when the request is a server's own elicitation. */
function approvalKind(params) {
  const meta = params && typeof params === 'object' ? params._meta : null;
  const kind = meta && typeof meta === 'object' ? meta[CODEX_APPROVAL_KIND] : null;
  // Only a string is a kind. `String(['mcp_tool_call'])` is the allowed discriminator
  // exactly, so a coercion here would pass an array through a strict comparison.
  return typeof kind === 'string' && kind !== '' ? kind : null;
}

/**
 * Allowlisted fields of a server-to-client request. Never the prompt, schema, url or
 * params blob; `schema` and `kind` are shape, and name which question was asked.
 */
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

export function decideApproval(method, params, record) {
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
    if (isToolCallApproval(params)) return { allow: true };
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
  // Before containment and before the role split: a command whose cwd is inside the
  // roots is still an escalation when it asks to leave the network sandbox, and the
  // containment check would have approved it.
  if (COMMAND_APPROVALS.has(method)) {
    const why = networkEscalationWhy(params);
    if (why) return { allow: false, why };
  }
  const reviewer = record.role === 'reviewer';
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
    // Canonical containment follows symlink targets and parent traversal before deciding
    // containment, including missing tails, and fails closed when resolution fails.
    // Measured on macOS APFS with Node 25.2.1, realpathSync keeps the caller's case. It
    // cannot close the TOCTOU gap before a later write outside this holder.
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
    const unresolvedRootsNote = unresolvedRoots.length
      ? ` (unresolved roots: ${unresolvedRoots.join(', ')})`
      : '';
    for (const raw of raws) {
      const abs = resolveTarget(raw, record.cwd);
      if (!abs) return { allow: false, why: `action target could not be resolved: ${raw}` };
      const canonical = containmentPath(abs);
      if (!canonical) return { allow: false, why: `action target could not be resolved: ${raw}` };
      if (!insideRoots(canonical, roots)) {
        return { allow: false, why: `action outside cwd/addDirs: ${abs} → ${canonical}${unresolvedRootsNote}` };
      }
    }
  }
  if (asksForEscalatedPermission(params, record)) {
    return { allow: false, why: 'privilege escalation denied' };
  }
  return { allow: true };
}

// Prefix of the `mcp_servers` keys in the participant home's `config.toml`. It was
// introduced against a collision that the isolated home has since removed: the old
// `config.mcp_servers` override merged with the owner personal config by FIELDS, not
// by records, and one name with two transports killed the load entirely (`url is not
// supported for stdio`). It stays for what it also does, which the home does not
// replace: the tool name the model sees is built from the config key
// (`mcp__<key>__<tool>` — a Codex binary string and a measurement, so `phrases.tool`
// must call that same name), and moving the key now would rename every bus tool a
// live participant was told.
//
// The word is the consumer's own name, which the host already declares — a
// participant reading `mcp__<key>__<tool>` sees the CLI it is running under and not a
// package it never heard of.
export function codexMcpPrefix(host) {
  return `${host.commandName}-`;
}

export function codexMcpName(name, prefix) {
  const n = String(name ?? '');
  if (!n) return n;
  // No prefix is not "the canonical name". That is precisely the collision this
  // mechanism exists for, and it fails silently in both directions: as a config
  // key it kills the whole config load, as a tool name it sends the participant
  // looking for a tool it does not have.
  if (!prefix) throw new Error('codexMcpName: no override key prefix — pass codexMcpPrefix(host)');
  return n.startsWith(prefix) ? n : `${prefix}${n}`;
}

/**
 * Workspace MCP set — into the Codex config `mcp_servers` form, which is what the
 * driver writes into the `[mcp_servers]` tables of the participant home's
 * `config.toml`. It has two transports, and their fields do NOT overlap:
 * `streamable_http` knows `url`, `http_headers`, `bearer_token_env_var`; `stdio` —
 * `command`, `args`, `env`, `cwd`. A foreign field is not ignored: it kills the
 * CONFIG LOAD ENTIRELY, and the participant does not lift at all — the reply is
 * «failed to load configuration: args is not supported for streamable_http in
 * `mcp_servers.<name>`».
 *
 * Measurement on codex-cli 0.146.0, `thread/start` into an isolated `CODEX_HOME`:
 * `{args, env}` on top of a url-server — that same refusal; `{url, http_headers}`
 * — the thread lifted. The isolated home removed the merge that made a NAME
 * collision possible in the first place; the key prefix stays because the tool name
 * the participant is told is derived from the config key (PB-160).
 *
 * An unknown transport (`sse` of Claude Code has no Codex counterpart) is not
 * emitted at all: a record without `url` and without `command` is an unbuildable half.
 */
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

// The holder log. It does NOT create its directory, and that is the whole rule:
// the sessions directory is written before the holder starts, and by the time it
// is missing the run that owned it is gone — recreating it would resurrect the
// tree the holder is about to die with. One rule for every writer, because the
// window is real: the app-server's stderr and the protocol notifications both log,
// and either can arrive inside the five seconds between the tree going and the
// record watch firing. A write with nowhere to go is dropped; this is diagnostics,
// and the holder must not fall over its own log.
function logHold(file, line) {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The directory is gone, or unwritable. Neither is a reason to fail a holder.
  }
}

/**
 * Body of the detached holder. The argument is the path to the session record:
 * the holder does not rebuild ref from argv, so it does not drift from the file
 * key.
 */
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
  const ref = record.ref;
  const logFile = holderLogFile(ref, env);
  const log = (line) => logHold(logFile, line);
  const lock = takeHolderLock(ref, env);
  if (!lock.ok) {
    patchSession(ref, { error: lock.error }, env);
    log(`lock: ${lock.error}`);
    process.exit(3);
  }
  writeFileSync(logFile, '', { mode: 0o600 });
  log(record.provenance ?? provenanceLine(provenanceFromRecord(record)));

  const sock = socketPath(ref, env);
  rmSync(sock, { force: true });

  const child = spawn(record.bin, PARTICIPANT_ARGV, {
    cwd: record.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  log(`app-server pid ${child.pid} bin ${record.bin}`);
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});

  // The holder outlives the command that started it — that is the whole point of
  // it — but it must not outlive its own SESSION. Nothing else can reap it: `stop`
  // and the suite stand both reap from a cleanup hook, and the one take-down that
  // leaks is the one no hook reaches. The suite runner takes a file down with
  // SIGKILL both at the file timeout and on Ctrl-C, and a 2026-09-04 run left
  // twelve processes alive into the next day, each holding a session file in a
  // directory that no longer existed.
  //
  // The record IS the session: `dropSession` removes it on stop, and so does
  // whoever removes the tree it lives in. Gone means there is nothing left to hold.
  //
  // `existsSync`, not a read: the record is replaced by rename, so it is never
  // transiently absent, while an unreadable file is a reason to keep holding rather
  // than to die. The app-server is killed FIRST and the exit is immediate — the
  // child's own exit handler writes to the holder log, and that write would recreate
  // the directory tree that was just removed. `unref` so the watch is never the
  // reason this process is alive.
  const recordWatch = setInterval(() => {
    if (existsSync(file)) return;
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
      if (dir === 'orphan') {
        log(`orphan id=${obj?.id === undefined || obj?.id === null ? '' : String(obj.id)}`);
        return;
      }
      if (obj.method) noteMethod(obj.method);
    },
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => log(`stderr ${String(chunk).slice(0, 400)}`));

  const state = {
    threadId: null,
    busy: false,
    turnStarted: false,
    currentTurnId: null,
    threadStatus: null,
    rateLimits: null,
    lastUnknownApproval: null,
    nameSet: null,
    turns: 0,
    methodsCalled,
    lastEvent: null,
    lastEventAt: null,
    pendingRequests: [],
    pendingRequest: null,
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
    const p = msg.params ?? {};
    const lastEventAt = new Date().toISOString();
    state.lastEvent = msg.method;
    state.lastEventAt = lastEventAt;
    if (msg.method === 'account/rateLimits/updated') {
      log(`event ${msg.method} usedPercent=${p.primary?.usedPercent ?? p.usedPercent ?? '?'}`);
    } else if (p.item?.type === 'mcpToolCall') {
      // An MCP call the participant made, with its outcome (PB-160). Without this line a
      // failed bus call is indistinguishable in the log from a dead server: the item
      // arrives as `failed` with no text anywhere else the mechanism reads.
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
      patchSession(ref, { rateLimits: p, ...activity }, env);
    }
    if (msg.method === 'thread/status/changed') {
      state.threadStatus = p.type ?? p.status ?? p;
      if (p.type === 'idle' || p.status === 'idle') state.busy = false;
      if (p.type === 'active') state.busy = true;
      patchSession(ref, activity, env);
    }
    if (msg.method === 'turn/started') {
      state.busy = true;
      state.turnStarted = true;
      state.currentTurnId = p.id ?? p.turn?.id ?? state.currentTurnId;
      patchSession(ref, {
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
      state.busy = false;
      state.turnStarted = false;
      state.currentTurnId = p.id ?? p.turn?.id ?? state.currentTurnId;
      state.turns += 1;
      state.lastTurn = p;
      state.pendingRequests = [];
      state.pendingRequest = null;
      const error = turnErrorText(p);
      const lastTurn = {
        id: state.currentTurnId,
        status: p.status ?? p.turn?.status ?? null,
        at: lastEventAt,
        ...(error ? { error } : {}),
      };
      patchSession(ref, {
        busy: false,
        turns: state.turns,
        ...(state.turns === 1 ? { firstTurnEndedAt: lastEventAt } : {}),
        lastTurn,
        pendingRequests: [],
        pendingRequest: null,
        methodsCalled,
        ...activity,
      }, env);
      writeParticipantWake({ ...readSession(ref, env), turns: state.turns, rpcSocket: sock, threadId: state.threadId }, env);
      wakeWaiters(() => !state.busy);
      log(`turn/completed ${state.currentTurnId} ${lastTurn.status ?? ''}`);
      if (turnFailed(lastTurn.status)) {
        const rec = readSession(ref, env);
        if (rec?.home && rec?.task) {
          logWarden(rec.home, rec.task, `Codex: last turn failed${error ? `: ${error}` : ''}`);
        }
      }
    }
    if (msg.method !== 'account/rateLimits/updated' && msg.method !== 'thread/status/changed'
      && msg.method !== 'turn/started' && msg.method !== 'turn/completed') {
      patchSession(ref, activity, env);
    }
  });

  rpc.onServerRequest((msg) => {
    noteMethod(`srv:${msg.method}`);
    const rec = readSession(ref, env) ?? record;
    const decision = decideApproval(msg.method, msg.params, rec);
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
    patchSession(ref, {
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
      patchSession(ref, { lastEvent: replyEvent, lastEventAt: at }, env);
    };
    if (decision.unknown) {
      state.lastUnknownApproval = { method: msg.method, at: new Date().toISOString(), why: decision.why };
      patchSession(ref, { lastUnknownApproval: state.lastUnknownApproval }, env);
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
    return approvalReply(msg.method, true);
  });

  let server = null;

  const failHold = (error) => {
    patchSession(ref, { error, state: 'failed', methodsCalled }, env);
    log(`refusal: ${error}`);
    try {
      child.kill('SIGKILL');
    } catch {
      // The process is already gone.
    }
    dropHolderLock(ref, env);
    rmSync(sock, { force: true });
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
      patchSession(ref, { state: 'dead', error: `app-server exited (${code ?? sig})` }, env);
    }
    dropHolderLock(ref, env);
    rmSync(sock, { force: true });
    try { server?.close(); } catch { /* listen may not have happened yet */ }
    process.exit(1);
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
        appPid: child.pid,
      };
    }
    if (req.op === 'rpc') {
      const ans = await rpc.request(req.method, req.params ?? {}, req.timeoutMs ?? 60_000);
      if (ans.error) throw new Error(ans.error.message ?? JSON.stringify(ans.error));
      return ans.result ?? {};
    }
    if (req.op === 'shutdown') {
      patchSession(ref, { stopping: true }, env);
      try {
        if (state.busy && state.threadId) {
          await rpc.request('turn/interrupt', { threadId: state.threadId }, 5_000);
        }
      } catch {
        // Nothing left to interrupt.
      }
      try {
        child.kill('SIGKILL');
      } catch {
        // The process is already gone.
      }
      setTimeout(() => {
        dropHolderLock(ref, env);
        rmSync(sock, { force: true });
        process.exit(0);
      }, 50);
      return { ok: true };
    }
    throw new Error(`unknown holder operation «${req.op}»`);
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
        const listed = await rpc.request('model/list', {}, MODEL_LIST_TIMEOUT_MS);
        const ids = listedModels(listed.result).map((m) => m.model);
        if (ids.length && !ids.includes(record.model)) {
          failHold(`model «${record.model}» is unknown to app-server (model/list)`);
          return;
        }
      } catch (err) {
        log(`model/list: ${err.message} — check skipped`);
      }
    }

    // No `config.mcp_servers` override here. The override existed to namespace the
    // mechanism's entries away from the owner's personal set, which app-server merged
    // into every thread by field (measured by the consumer: a transport clash under one name
    // kills the whole config load). The participant now lifts in its own `CODEX_HOME`
    // whose `config.toml` the driver writes, and that home has no personal set to merge
    // with — so the entries have one source and one shape. The key prefix stays: the
    // tool name the participant is told is derived from the config key (PB-160).
    //
    // ThreadStartParams.config remains the passthrough for the one key that is
    // per-turn rather than per-home: model_reasoning_effort, which both roles honour.
    // Measured on codex-cli 0.146.0 with no paid turn: the thread echoes the asked
    // level as ThreadStartResponse.reasoningEffort. The first turn/start still also
    // sends effort — that value persists across later wakes on the same thread.
    const startParams = {
      cwd: record.cwd,
      sandbox: record.sandbox,
      approvalPolicy: record.approvalPolicy,
      model: record.model,
      ...(record.effort ? { config: { model_reasoning_effort: record.effort } } : {}),
    };
    if (record.addDirs?.length) startParams.runtimeWorkspaceRoots = record.addDirs;
    const started = await rpc.request('thread/start', startParams, THREAD_START_TIMEOUT_MS);
    if (started.error) throw new Error(started.error.message ?? JSON.stringify(started.error));
    state.threadId = started.result?.thread?.id ?? started.result?.id;
    if (!state.threadId) throw new Error('thread/start did not return a thread id');
    const echoedEffort = started.result?.reasoningEffort;
    log(echoedEffort
      ? `thread/start ${state.threadId} reasoningEffort=${echoedEffort}`
      : `thread/start ${state.threadId}`);

    const threadName = record.name || `promptobus:${record.task}:${record.address}`;
    try {
      const named = await rpc.request('thread/name/set', { threadId: state.threadId, name: threadName }, NAME_SET_TIMEOUT_MS);
      state.nameSet = !named.error;
      if (named.error) log(`thread/name/set: ${named.error.message ?? 'refused'} — name layer unobserved`);
    } catch (err) {
      state.nameSet = false;
      log(`thread/name/set: ${err.message} — name layer unobserved`);
    }

    patchSession(ref, {
      holderPid: process.pid,
      appPid: child.pid,
      rpcSocket: sock,
      threadId: state.threadId,
      nameSet: state.nameSet,
      rateLimits: state.rateLimits,
      methodsCalled,
      state: 'starting',
      busy: true,
    }, env);

    await listenHolder();

    const firstRequestAt = Date.now();
    // Both roles use turn/start so bus tools stay on the participant thread.
    // review/start was an observed stall of the bus mailbox; it is unused.
    // Read-only is the sandbox. Effort rides on thread/start config and here.
    const first = await rpc.request('turn/start', {
      threadId: state.threadId,
      ...(record.effort ? { effort: record.effort } : {}),
      input: [{ type: 'text', text: record.prompt }],
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

    patchSession(ref, {
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

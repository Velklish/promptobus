import { spawn as spawnProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { run } from './exec.js';
import { processIdentity, processState } from './service-state.js';
import type { ProcessIdentity } from './service-state.js';

interface HolderResponse { status: number; data: unknown }
type HolderFetch = (url: string, password: string, method: string, path: string, body?: unknown, timeoutMs?: number) => Promise<HolderResponse>;
interface PermissionAsk { action: string; [key: string]: unknown }
interface HolderMessage { type?: unknown; outcome?: unknown }

// Per-participant `opencode serve` holder: raw HTTP with basic auth (05-drivers).

/** A holder password — 43 base62 chars, the shape the binary prints itself. */
export function holderPassword(random = randomBytes) {
  const raw = random(32).toString('base64').replace(/[^A-Za-z0-9]/g, 'x');
  return (raw + 'x'.repeat(43)).slice(0, 43);
}

/** The listening port off the holder log line, case-insensitive — the binary owns the words. */
export function portOfLog(text: unknown) {
  const hit = String(text ?? '').match(/server listening on http:\/\/127\.0\.0\.1:(\d+)/i);
  return hit ? Number(hit[1]) : null;
}

export const holderUrl = (port: number) => `http://127.0.0.1:${port}`;

function authHeader(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

export const HOLDER_HTTP_TIMEOUT_MS = 10_000;

async function call(url: string, password: string, method: string, path: string, body: unknown = undefined, timeoutMs = HOLDER_HTTP_TIMEOUT_MS): Promise<HolderResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: authHeader(password),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** The holder answers session lists: readiness is an answered request, not a port bind. */
export async function waitReady(
  url: string, password: string, { timeoutMs = 30_000, stepMs = 250 } = {}, fetchFn: HolderFetch = call,
) {
  const edge = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetchFn(url, password, 'GET', '/api/session');
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    if (Date.now() >= edge) return false;
    await new Promise((r) => { setTimeout(r, stepMs); });
  }
}

const ownedHolders = new Map<number, ProcessIdentity>();

/** Start the holder detached with its log; the caller waits readiness separately. */
export function startHolder(bin: string, argv: string[], { cwd, env, log }: { cwd?: string; env?: NodeJS.ProcessEnv; log?: string | null }) {
  const out = log ? openSync(log, 'w', 0o600) : 'ignore';
  let child;
  try {
    child = spawnProcess(bin, argv, { cwd, env, detached: true, stdio: ['ignore', out, out] });
  } catch (error) {
    if (typeof out === 'number') {
      try { closeSync(out); } catch { /* nothing to close */ }
    }
    throw error;
  }
  if (typeof out === 'number') {
    try {
      closeSync(out);
    } catch { /* the child holds its own copy */ }
  }
  child.unref();
  child.once('spawn', () => {
    const identity = processIdentity(child.pid!);
    if (identity) ownedHolders.set(child.pid!, identity);
  });
  return child;
}

/** Stop an owned holder and confirm exit within the existing cleanup budget. */
export async function reapHolder(pid: number, { graceMs = 5000, stepMs = 100, identity = ownedHolders.get(pid) }:
  { graceMs?: number; stepMs?: number; identity?: ProcessIdentity | null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('OpenCode holder pid is missing; cleanup is unknown');
  if (!pidAlive(pid)) return;
  if (!identity || identity.pid !== pid) throw new Error(`OpenCode holder ${pid} has no owned process birth identity; cleanup is unknown`);
  const state = () => processState(identity);
  const signal = (name: NodeJS.Signals) => {
    const current = state();
    if (current === 'dead') return;
    if (current !== 'alive') throw new Error(`OpenCode holder ${pid} process identity is unreadable; no ${name} issued`);
    try { process.kill(-pid, name); }
    catch {
      if (state() === 'dead') return;
      if (state() !== 'alive') throw new Error(`OpenCode holder ${pid} process identity changed before ${name}`);
      process.kill(pid, name);
    }
  };
  const edge = Date.now() + graceMs;
  signal('SIGTERM');
  const termEdge = edge - Math.min(stepMs, graceMs / 2);
  while (state() === 'alive' && Date.now() < termEdge) {
    await new Promise((r) => { setTimeout(r, Math.min(stepMs, Math.max(1, termEdge - Date.now()))); });
  }
  if (state() !== 'dead') signal('SIGKILL');
  while (state() === 'alive' && Date.now() < edge) {
    await new Promise((r) => { setTimeout(r, Math.min(stepMs, Math.max(1, edge - Date.now()))); });
  }
  if (state() !== 'dead') throw new Error(`OpenCode holder ${pid} exit is unconfirmed; cleanup is unknown`);
  ownedHolders.delete(pid);
}

export function pidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export const createSession = (url: string, password: string, title: string, fetchFn: HolderFetch = call) => fetchFn(url, password, 'POST', '/api/session', { title });

export const sendPrompt = (url: string, password: string, sessionId: string, text: string, fetchFn: HolderFetch = call) => fetchFn(
  url, password, 'POST', `/api/session/${sessionId}/prompt`, { text },
);

export const listPermissions = (url: string, password: string, sessionId: string, fetchFn: HolderFetch = call) => fetchFn(
  url, password, 'GET', `/api/session/${sessionId}/permission`,
);

// `once` answers this ask and does not save a rule. The route is session.permission.reply.
export const replyPermission = (url: string, password: string, sessionId: string, requestId: string, fetchFn: HolderFetch = call) => fetchFn(
  url, password, 'POST', `/api/session/${sessionId}/permission/${requestId}/reply`,
  { decision: 'once' },
);

/** Asks from a permission body, or null when the body is not that list. */
export function parsePermissionList(value: unknown): PermissionAsk[] | null {
  const body = value as { data?: unknown } | null | undefined;
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
  if (!list) return null;
  const asks = list.filter((ask) => ask && typeof ask.action === 'string' && ask.action);
  if (list.length > 0 && asks.length === 0) return null;
  return asks;
}

export const readMessages = (url: string, password: string, sessionId: string, limit = 5, fetchFn: HolderFetch = call) => fetchFn(
  url, password, 'GET', `/api/session/${sessionId}/message?limit=${limit}`,
);

export const deleteSession = (url: string, password: string, sessionId: string, fetchFn: HolderFetch = call) => fetchFn(
  url, password, 'DELETE', `/api/session/${sessionId}`,
);

/** The trailing idle outcome of a message list, newest first, or null while the turn runs. */
export function idleOutcome(value: unknown): unknown {
  const messages = value as { data?: HolderMessage[] } | HolderMessage[] | null | undefined;
  const items = Array.isArray((messages as { data?: unknown })?.data) ? (messages as { data: HolderMessage[] }).data : (Array.isArray(messages) ? messages : []);
  if (!items.length) return null;
  const last = items[0];
  return last?.type === 'idle' ? (last.outcome ?? 'done') : null;
}

// Sync holder call for inspect: the heartbeat cannot await. The password stays on stdin.
export const HOLDER_REQUEST_SOURCE = [
  'const chunks = [];',
  'process.stdin.on("data", (chunk) => chunks.push(chunk));',
  'process.stdin.on("end", () => {',
  '  let input;',
  '  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }',
  '  catch (error) { process.stderr.write(String(error.message || error)); process.exit(1); return; }',
  '  const headers = { Authorization: "Basic " + Buffer.from("opencode:" + input.password).toString("base64") };',
  '  if (input.body !== undefined) headers["Content-Type"] = "application/json";',
  '  const ctrl = new AbortController();',
  `  const timer = setTimeout(() => ctrl.abort(), ${HOLDER_HTTP_TIMEOUT_MS});`,
  '  fetch(input.url + input.path, {',
  '    method: input.method, headers, signal: ctrl.signal,',
  '    body: input.body === undefined ? undefined : JSON.stringify(input.body),',
  '  }).then(async (res) => {',
  '    clearTimeout(timer);',
  '    const text = await res.text();',
  '    process.stdout.write(JSON.stringify({ status: res.status, text }));',
  '  }).catch((error) => {',
  '    clearTimeout(timer);',
  '    process.stderr.write(String(error && error.message || error));',
  '    process.exit(1);',
  '  });',
  '});',
].join('\n');

/** One holder request from a synchronous caller. Null when the process or the body fails. */
export function holderRequestSync(url: string, password: string, method: string, requestPath: string, body: unknown, runFn = run): HolderResponse | null {
  // `node` by name: an absolute execPath sits outside the suite's sealed PATH.
  const result = runFn('node', ['-e', HOLDER_REQUEST_SOURCE], {
    input: JSON.stringify({ url, password, method, path: requestPath, body }),
    encoding: 'utf8',
  });
  if (result?.error || result?.status !== 0 || typeof result?.stdout !== 'string') return null;
  try {
    const parsed: { status: number; text?: string } = JSON.parse(result.stdout);
    let data: unknown = null;
    try { data = parsed.text ? JSON.parse(parsed.text) : null; } catch { data = null; }
    return { status: parsed.status, data };
  } catch {
    return null;
  }
}

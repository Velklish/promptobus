// Shared sweep of previous run directories; see docs/guides/contributing.md#sweeping-run-directories.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Prefix of a run directory. It has one home: `live-canary.mjs` calls `mkdtempSync` with it. */
export const CANARY_PREFIX = 'promptobus-canary-';

export const KEEP_RUNS = 3;

// A live run's root mtime may stop advancing even while its children are working.
export const MIN_AGE_MS = 60 * 60 * 1000;

// Keep the socket prefixes here so runner copies need no test-only imports.
export const SOCK_PREFIXES = ['a2l-', 'a2e-', 'a2h-', 'a2s-', 'ags-', 'a2m-', 'pb-stop-account-', 'pb-stop-recovery-', 'pb-stop-lock-',
  'pb-http-order-', 'pb-rollback-', 'pb-native-cleanup-', 'pb-ctx-'];

// An owner marker fails closed: a reused PID can keep an old directory, never remove a live one.
export const RUN_OWNER_FILE = '.promptobus-run-owner.json';

const SOCKET_DEAD_CODE = 3;

// Probing an old participant socket can append a `knock` note to its trace.
const SOCKET_PROBE = `
import net from 'node:net';
let client;
let done = false;
const finish = (code) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  client?.destroy();
  process.exit(code);
};
const timer = setTimeout(() => finish(2), 500);
process.on('uncaughtException', () => finish(2));
try {
  client = net.createConnection(process.argv[1]);
  client.once('connect', () => finish(0));
  client.once('error', (error) => {
    finish(error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED' ? ${SOCKET_DEAD_CODE} : 2);
  });
} catch {
  finish(2);
}
`;

/** Return whether a suite-run owner marker still names a live process. */
export function runOwnerIsLive(dir) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(path.join(dir, RUN_OWNER_FILE), 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT' ? false : true;
  }
  if (owner && Object.hasOwn(owner, 'cleanup')) return true;
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    if (realpathSync(owner.path) !== realpathSync(dir)) return false;
  } catch {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Claim `dir` for this process with the same marker the suite runner writes. */
export function markRunOwner(dir, pid = process.pid) {
  writeFileSync(path.join(dir, RUN_OWNER_FILE), `${JSON.stringify({ pid, path: dir })}\n`, { flag: 'wx', mode: 0o600 });
}

/** Retain only this process's own run marker; any cleanup state blocks automatic sweep. */
export function markRunUnresolved(dir) {
  const file = path.join(dir, RUN_OWNER_FILE);
  const owner = JSON.parse(readFileSync(file, 'utf8'));
  if (owner?.pid !== process.pid || realpathSync(owner.path) !== realpathSync(dir)) {
    throw new Error('Cannot retain a run owned by another process or directory');
  }
  writeFileSync(file, `${JSON.stringify({ ...owner, cleanup: { state: 'unresolved' } })}\n`);
}

function runCleanupUnresolved(dir) {
  try {
    const owner = JSON.parse(readFileSync(path.join(dir, RUN_OWNER_FILE), 'utf8'));
    if (owner && Object.hasOwn(owner, 'cleanup')) return true;
    const pid = Number(owner?.pid);
    return !Number.isInteger(pid) || pid <= 0 || realpathSync(owner.path) !== realpathSync(dir);
  } catch (error) { return error?.code !== 'ENOENT'; }
}

/** True only for a readable marker of this very directory whose pid no longer exists; anything else is not dead. */
export function runOwnerIsDead(dir) {
  try {
    const owner = JSON.parse(readFileSync(path.join(dir, RUN_OWNER_FILE), 'utf8'));
    if (owner && Object.hasOwn(owner, 'cleanup')) return false;
    const pid = Number(owner?.pid);
    if (!Number.isInteger(pid) || pid <= 0 || realpathSync(owner.path) !== realpathSync(dir)) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

// Check liveness out of process: the synchronous sweep cannot service its own probe.
export function socketDirIsLive(dir) {
  if (process.platform === 'win32') return true;
  let entries;
  try { entries = readdirSync(dir); } catch { return true; }
  for (const name of entries) {
    const socket = path.join(dir, name);
    try {
      if (!statSync(socket).isSocket()) continue;
    } catch {
      return true;
    }
    let probe;
    try {
      probe = spawnSync(process.execPath, ['--input-type=module', '-e', SOCKET_PROBE, socket], {
        stdio: 'ignore', timeout: 1_000,
      });
    } catch {
      return true;
    }
    if (probe.error || probe.signal || probe.status !== SOCKET_DEAD_CODE) return true;
  }
  return false;
}

// The return lists successful removals only; held and refused runs are reported separately.
export function sweepPreviousRuns(dir, {
  keep = KEEP_RUNS, current = null, now = Date.now(), prefix = CANARY_PREFIX, refused = [],
  isLive = null, held = [], isDead = null,
} = {}) {
  const mine = current ? path.basename(current) : null;
  const runs = [];
  for (const name of listOf(dir)) {
    if (!name.startsWith(prefix) || name === mine) continue;
    try {
      const st = statSync(path.join(dir, name));
      if (st.isDirectory()) runs.push({ name, at: st.mtimeMs });
    } catch { /* vanished between the walk and the question — nothing to sweep */ }
  }
  runs.sort((a, b) => b.at - a.at);
  const dead = (r) => {
    try { return !!isDead?.(path.join(dir, r.name), r); } catch { return false; }
  };
  const orphans = runs.filter(dead);
  const rest = runs.filter((r) => !orphans.includes(r));
  const doomed = [...orphans, ...rest.slice(keep).filter((r) => now - r.at >= MIN_AGE_MS)];
  const swept = [];
  for (const r of doomed) {
    const full = path.join(dir, r.name);
    if (isLive && !orphans.includes(r)) {
      let live = false;
      try { live = !!isLive(full, r); } catch { live = true; }
      if (live) {
        held.push(r.name);
        continue;
      }
    }
      // A refused removal must not discard successful removals or stop the walk.
    try {
      rmSync(full, { recursive: true, force: true });
      swept.push(r.name);
    } catch { refused.push(r.name); }
  }
  return swept;
}

// An empty result names both thresholds; count alone does not explain why nothing was swept.
export function sweptLine(what, swept, { keep = KEEP_RUNS } = {}) {
  if (swept.length) return `${what} swept: ${swept.length} (${swept.join(', ')})`;
  const guards = [
    ...(keep ? [`within ${keep} kept`] : []),
    `younger than ${MIN_AGE_MS / 60_000} minutes`,
  ];
  return `${what} nothing to sweep: everything is ${guards.join(' or ')}`;
}

/** Sweep a live script's previous sandboxes: none kept, a dead owner's swept at once, a live one's held. */
export function sweepLiveRuns(dir, { prefix, current }) {
  const refused = [];
  const held = [];
  const retained = [];
  const swept = sweepPreviousRuns(dir, {
    prefix, current, keep: 0, refused, held, isLive: (full) => runCleanupUnresolved(full) || runOwnerIsLive(full), isDead: (full) => {
      if (runCleanupUnresolved(full)) { retained.push(path.basename(full)); return false; }
      return runOwnerIsDead(full);
    },
  });
  const live = held.filter(name => !retained.includes(name));
  return [
    sweptLine('previous-run sandboxes', swept, { keep: 0 }),
    ...(live.length ? [`held, their owner is alive: ${live.join(', ')}`] : []),
    ...(retained.length ? [`held, cleanup unresolved: ${retained.join(', ')}`] : []),
    ...(refused.length ? [`sweep refused (busy or foreign permissions): ${refused.join(', ')}`] : []),
  ];
}

function listOf(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

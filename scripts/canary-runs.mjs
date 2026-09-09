// Sweep of previous live-canary run directories.
//
// The canary leaves a run directory on disk on purpose: the path is printed, and the
// report (`live-canary.md`) and the full live-loop output are read after the run. Nobody
// swept them — neither the canary nor `doctor` knew about them — and the directories
// piled up: a 2026-09-03 measurement on the owner's machine found nine of them at 20 KB
// each.
//
// A separate module, not a function inside [live-canary.mjs](live-canary.mjs): that file
// runs whole already on import — it raises a workspace, installs a tarball and drives
// live sessions — and there would be no other way to cover the sweep with a suite.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Prefix of a run directory. It has one home: `live-canary.mjs` calls `mkdtempSync` with it. */
export const CANARY_PREFIX = 'promptobus-canary-';

// How many previous runs stay. Three, not one: the last run's report is read after it,
// and a spare is needed to compare two neighbours — "the last one was green, this one
// is red" is read from two directories at once. Zero would remove a report a person
// still has open.
export const KEEP_RUNS = 3;

// Age cut-off: a directory younger than this is not removed, however many fresh ones
// stand beside it. The "three newest" threshold does NOT protect a GOING run — the run
// directory's mtime stops growing seconds after start (`pack`, the base clone and the
// workspace come up at once, then work happens in nested directories, and the report
// is written at the very end), so a run that has been going for half an hour is older
// by mtime than three that finished during that time. An hour is slack for the longest
// live run: a canary loop lasts minutes.
export const MIN_AGE_MS = 60 * 60 * 1000;

// Unix-socket directories are created directly under `/tmp` by the test and
// live harness helpers. The shared sweep owns this list so a runner copy can
// carry the complete cleanup seam without importing a test-only module.
export const SOCK_PREFIXES = ['a2l-', 'a2e-', 'a2h-', 'a2s-', 'ags-', 'a2m-'];

// The age cut-off is the first line of defence: children keep updating their
// run root while they work, and FILE_TIMEOUT_MS is five minutes, so a going
// run stays younger than the one-hour sweep window. A suite run writes this
// marker at its root as the second line of defence. The marker is an ownership
// claim, and the pid check is deliberately fail-closed: a reused pid can keep
// an old directory for one more run, but must never make a live neighbour
// eligible for removal.
export const RUN_OWNER_FILE = '.promptobus-run-owner.json';

const SOCKET_DEAD_CODE = 3;

// A probe against a live `test/participant.mjs` server (`a2e-`/`a2m-`) ends a
// connection that can append a `knock` note to its trace. Only a directory
// older than an hour reaches this probe — the live-e2e/live-canary loops keep
// their roots younger — so the note is harmless cleanup evidence, but it is
// recorded.
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

/**
 * Return whether a directory contains a socket that still accepts a connection.
 * The probe is a short child process because the sweep is synchronous and must
 * not block its own event loop while it asks a neighbouring run for liveness.
 * An unknown probe result is held, never removed.
 */
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

/**
 * Remove previous-run directories in `dir`, leaving `keep` newest by mtime. The current
 * run directory (`current`) is not counted and not removed: this same command created
 * it.
 *
 * A neighbouring foreign run is held by an owner/liveness check when the caller
 * has one, and otherwise by the age cut-off: nothing younger than `MIN_AGE_MS` is
 * removed. Returns the list of what was swept — the caller prints it: a silent
 * sweep in a shared `$TMPDIR` reads as a disappearance.
 *
 * `prefix` — whose directories to sweep. More than one canary piles up in `$TMPDIR`:
 * the live Cursor-driver check leaves turn logs there, release gates leave their own
 * run directories, the suite leaves sandboxes of cut-off runs, and the trouble is the
 * same for all — the one this module exists for. A shared trouble is healed by shared
 * code, not four copies of the thresholds: drifted, they would give four sweeps
 * different rules on one directory.
 *
 * `refused` — directories the sweep was not allowed to remove (busy, foreign
 * permissions) are pushed here. A separate list, because the return promises the
 * SWEPT: promising a removal that did not happen is a lie — a person reads the list.
 *
 * `isLive` — an optional ownership/liveness predicate. A true result holds the
 * directory and adds its name to `held`; a thrown predicate is also held closed.
 */
export function sweepPreviousRuns(dir, {
  keep = KEEP_RUNS, current = null, now = Date.now(), prefix = CANARY_PREFIX, refused = [],
  isLive = null, held = [],
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
  const doomed = runs.slice(keep).filter((r) => now - r.at >= MIN_AGE_MS);
  const swept = [];
  for (const r of doomed) {
    const full = path.join(dir, r.name);
    if (isLive) {
      let live = false;
      try { live = !!isLive(full, r); } catch { live = true; }
      if (live) {
        held.push(r.name);
        continue;
      }
    }
    // A refused removal does not drop the walk and does not take names of already
    // swept neighbours: the directory may have been busy or the permissions foreign,
    // and the next one is swept as if nothing happened. It is caught PER DIRECTORY
    // for that reason — a guard around the whole walk would wipe the list the sweep
    // reports.
    try {
      rmSync(full, { recursive: true, force: true });
      swept.push(r.name);
    } catch { refused.push(r.name); }
  }
  return swept;
}

/**
 * Sweep summary line — one home for every caller. The empty case must name BOTH
 * thresholds: "nothing beyond the three kept" lies when there is nothing to sweep
 * by age, not by count. Thresholds are interpolated from the constants so the
 * phrase cannot drift from the code.
 */
export function sweptLine(what, swept, { keep = KEEP_RUNS } = {}) {
  if (swept.length) return `${what} swept: ${swept.length} (${swept.join(', ')})`;
  const guards = [
    ...(keep ? [`within ${keep} kept`] : []),
    `younger than ${MIN_AGE_MS / 60_000} minutes`,
  ];
  return `${what} nothing to sweep: everything is ${guards.join(' or ')}`;
}

function listOf(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

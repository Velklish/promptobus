import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn } from './util.js';
import { hostOf } from './host.js';
import { promptobusHome, filesDir, GateError, listTasks, taskDir } from './store.js';
import { PRUNE_DEFAULT_DAYS } from './contract.js';

// Default threshold is re-exported from here: its home is contract.js, and callers
// look it up by this command's name.
export { PRUNE_DEFAULT_DAYS };

// Task-journal cleanup. `promptobus done` closes a task and removes worktree directories,
// mcp configs, and contact points after it; the mail itself stays on disk forever. A
// 2026-08-30 measurement on a live workspace — 54 tasks, 18 MB, 53 of them closed; on
// 2026-08-28 it was 40 tasks and 11 MB, about 3 MB a day of dense orchestration.
//
// The subject is separate from `done.js`: `done` ends a LIVE run and sweeps foreign
// leftovers (directories, secrets), while `prune` removes the journal of something
// long closed. Different cost of a mistake — different commands: `done` is called in
// every run, `prune` is called by a person by hand.
//
// Artifacts leave with the mail and do not live on their own clock: an artifact arrived
// with a message, and without the message it is a file without a reason. Dry-run names
// their count separately.
const DAY_MS = 24 * 60 * 60 * 1000;

// Task weight — a walk of its directory. That is the command's subject: without a
// number the dry-run says "twelve tasks", and a person asks "how much space is that".
// An unreadable subtree is skipped as zero: a size command has no reason to fall over
// a foreign file.
function dirSize(dir) {
  let sum = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { sum += dirSize(p); continue; }
    try { sum += statSync(p).size; } catch { /* file vanished between walk and stat */ }
  }
  return sum;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// A worktree directory named by the journal and still on disk. A task with such a
// directory is never treated as dead at any age: `done` did not remove it, and the
// journal is the only place that records where this work sits and whose it is. Remove
// the journal — and the directory is left an unnamed orphan.
function heldWorktrees(meta) {
  return (meta.participants ?? [])
    .map((p) => p?.metadata?.worktree)
    .filter((w) => w && existsSync(w));
}

// What counts as dead: the task is CLOSED and closed long ago. Status separates a live
// run from history; age gives a person time to return to the mail. If there is no close
// mark (a former CLI journal or a hand edit) the task is left alone: age is unknown, and
// "unknown" on deletion means "no".
function pruneCandidates(home, days) {
  const edge = Date.now() - days * DAY_MS;
  const out = { dead: [], young: 0, active: 0, undated: 0, held: [] };
  for (const meta of listTasks(home)) {
    if (meta.status !== 'done') { out.active += 1; continue; }
    const closed = Date.parse(meta.adapter.closed ?? '');
    if (Number.isNaN(closed)) { out.undated += 1; continue; }
    if (closed > edge) { out.young += 1; continue; }
    const held = heldWorktrees(meta);
    if (held.length) { out.held.push({ meta, held }); continue; }
    out.dead.push({
      meta,
      closed,
      size: dirSize(taskDir(home, meta.id)),
      arts: existsSync(filesDir(home, meta.id)) ? readdirSync(filesDir(home, meta.id)).length : 0,
    });
  }
  return out;
}

// Cleanup list — the same lines for dry-run, `--yes`, and `promptobus done`: whichever
// path cleanup took, a person reads the same about what is being removed.
function sayCandidates(dead) {
  for (const { meta, closed, size, arts } of dead) {
    info(`${meta.id} "${meta.title ?? ''}" — closed ${new Date(closed).toISOString().slice(0, 10)}, `
      + `${humanSize(size)}${arts ? `, artifacts ${arts}` : ''}`);
  }
}

// The deletion itself and its result. A refusal on one task does not stop the walk: in
// `promptobus done` cleanup runs AFTER close, and a throw from here would take the other
// directories with it. The result counts only what was removed: "removed 3" about two
// removals is a lie about an irreversible action. If NOTHING was removed the result is
// yellow: a green "removed 0 tasks" reports success about work not done, and a person
// leaves without reading the reasons above.
//
// `remove` is a seam for the suite: there is no portable way to make a directory
// undeletable (chmod on Windows does not forbid deletion, and under root it forbids
// nowhere), and the refusal branch would otherwise stay untested.
function removeJournals(home, dead, { days, young, remove = rmSync }) {
  let gone = 0;
  let failed = 0;
  for (const { meta, size } of dead) {
    try {
      remove(taskDir(home, meta.id), { recursive: true, force: true });
      gone += size;
    } catch (e) {
      failed += 1;
      warn(`task ${meta.id} not removed: ${e.message}`);
    }
  }
  const count = dead.length - failed;
  if (count) {
    ok(`journals removed: tasks ${count}, freed ${humanSize(gone)} (younger than ${days} d — ${young}, left alone)`);
  } else {
    warn(`journals not removed: none of ${dead.length} tasks came off (refusals ${failed}) — reason for each is the line above`);
  }
  return { count, gone, failed };
}

/**
 * Cleanup of journals of long-closed tasks at the default threshold — the same as
 * `prune --yes`, called by `promptobus done` after its own work (owner decision
 * 2026-09-02). Closing a task is the only moment when a person is already tidying and
 * sees the list; warden start happens with no person at the keyboard.
 *
 * The list of what was removed is printed; the hand-command context lines (active, no
 * mark, held by a directory) are not: those are read at `promptobus prune`, which is
 * why people call it. Nothing to remove — stay silent: `done` is not a journal report,
 * and a line about work not done on every close would be noise.
 */
export function sweepJournals(home, days = PRUNE_DEFAULT_DAYS, { remove } = {}) {
  const { dead, young } = pruneCandidates(home, days);
  if (!dead.length) return { count: 0, gone: 0, failed: 0 };
  sayCandidates(dead);
  return removeJournals(home, dead, { days, young, ...(remove ? { remove } : {}) });
}

// Dry-run by default, delete on explicit `--yes`: an agent calls the command, and a
// session that decided "see what has piled up" would otherwise wipe a week's mail.
// There is no undo — the journal sits outside git.
export function prune(rootOrHost, { olderThan, yes } = {}) {
  const host = hostOf(rootOrHost);
  const home = promptobusHome(host.workspaceRoot(), host);
  // An empty value (`--older-than=`) is invalid, not "zero days": `Number('')` is 0, and
  // cleanup would wipe EVERY closed task that has a mark. Threshold `0` stays legal, but
  // named as a digit, not a missing value.
  const raw = olderThan === undefined ? null : String(olderThan).trim();
  const days = raw === null ? PRUNE_DEFAULT_DAYS : Number(raw);
  if (raw === '' || !Number.isFinite(days) || days < 0) {
    throw new GateError(`--older-than <days>: expected a non-negative number, got "${olderThan}"`);
  }
  const { dead, young, active, undated, held } = pruneCandidates(home, days);
  for (const { meta, held: dirs } of held) {
    warn(`task ${meta.id} left in place: its worktree is still on disk (${dirs.join(', ')}) — `
      + 'the journal names where this work sits. Take it or remove the directory, then the task will be cleaned');
  }
  if (undated) info(`closed tasks with no close mark: ${undated} — age unknown, left alone`);
  info(`active tasks: ${active} — they are not touched on any call`);
  if (!dead.length) {
    ok(`nothing to remove: no closed tasks older than ${days} d (younger — ${young})`);
    return;
  }
  const total = dead.reduce((s, t) => s + t.size, 0);
  sayCandidates(dead);
  if (!yes) {
    ok(`dry-run: ${dead.length} tasks would be removed, ${humanSize(total)} (younger than ${days} d — ${young}). `
      + `Nothing deleted. To delete: ${host.formatNpx(['prune', `--older-than ${days}`, '--yes'])}`);
    return;
  }
  removeJournals(home, dead, { days, young });
}

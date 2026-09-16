import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn } from './util.js';
import { hostOf } from './host.js';
import { filesDir, GateError, listTasks, taskDir } from './store.js';
import { PRUNE_DEFAULT_DAYS } from './contract.js';

// Default threshold is re-exported from here: its home is contract.js, and callers
// look it up by this command's name.
export { PRUNE_DEFAULT_DAYS };

// Task-journal cleanup: mail stays on disk after `done`, and this removes the journal of
// something long closed — [03-cli.md](../docs/reference/03-cli.md#status-done-sweep-dismiss-history-prune).
const DAY_MS = 24 * 60 * 60 * 1000;

// Task weight — a walk of its directory: without a number a dry run says "twelve tasks"
// and a person asks how much space that is. An unreadable subtree counts as zero.
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

// A worktree directory named by the journal is never dead at any age: the journal is the
// only record of where this work sits, and removing it leaves an unnamed orphan.
function heldWorktrees(meta) {
  return (meta.participants ?? [])
    .map((p) => p?.metadata?.worktree)
    .filter((w) => w && existsSync(w));
}

// Dead means CLOSED and closed long ago. With no close mark (a former CLI journal, a hand
// edit) the task is left alone: age is unknown, and "unknown" on deletion means "no".
function pruneCandidates(home, days, tasks = listTasks(home)) {
  const edge = Date.now() - days * DAY_MS;
  const out = { dead: [], young: 0, active: 0, undated: 0, held: [] };
  for (const meta of tasks) {
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

// A refusal on one task does not stop the walk, and only what was removed is counted —
// nothing removed is yellow. `remove` is a seam: an undeletable directory is not portable.
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

/** Cleanup at the default threshold, the same as `prune --yes`, called by `done` after its
 * own work. It prints what was removed and is otherwise silent: `done` is not a report. */
export function sweepJournals(home, days = PRUNE_DEFAULT_DAYS, { remove, tasks } = {}) {
  const { dead, young } = pruneCandidates(home, days, tasks);
  if (!dead.length) return { count: 0, gone: 0, failed: 0 };
  sayCandidates(dead);
  return removeJournals(home, dead, { days, young, ...(remove ? { remove } : {}) });
}

// Dry run by default, delete on an explicit `--yes`: an agent calls this command, and
// there is no undo — the journal sits outside git.
export function prune(rootOrHost, { olderThan, yes } = {}) {
  const host = hostOf(rootOrHost);
  const home = host.promptobusHome();
  // An empty value (`--older-than=`) is invalid, not "zero days": `Number('')` is 0 and
  // would wipe every closed task that has a mark. Threshold `0` stays legal, as a digit.
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
      + `Nothing deleted. To delete: ${host.busCommand(['prune', `--older-than ${days}`, '--yes'])}`);
    return;
  }
  removeJournals(home, dead, { days, young });
}

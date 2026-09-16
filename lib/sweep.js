// Clean up after ONE accepted piece and leave the task alive. Why a verb of its own
// rather than a flag on `done`: ADR-016, and 03-cli § Status, done, dismiss…
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn, fail, shellQuote } from './util.js';
import { hostOf } from './host.js';
import {
  addrDir, addressesOf, artifactsDir, blobsDir, claimRoute, filesDir, foreignSessionOf,
  healthFile, messagesDir, ORCHESTRATOR, participantDirs, participantMcpPath, participantOf,
  participantSettingsPath, readTask, resolveTaskId, sameOwnerSession, sessionIdOf,
  sessionIdentity, sessionOf, stallsFile, taskDir, taskOwner, wakeFile, wardenLogFile,
  withTaskLock,
} from './store.js';
import { inspectWorktree, pruneWorktrees, removeWorktree, worktreeDisposition } from './worktree.js';
import {
  blobNamed, driverFor, harnessOf, listArtifacts, snapshotSessions, validate, withBlobLock,
} from '../dist/index.js';
import { REGISTRY, driverOrLift } from './drivers.js';
import { participantSession } from './status.js';

/** What the piece sweep must never take — the run's telemetry and its mailboxes.
 * [reference/03-cli.md#keptpaths--what-the-piece-sweep-must-never-take](../docs/reference/03-cli.md#keptpaths--what-the-piece-sweep-must-never-take) */
export function keptPaths(home, id) {
  const dir = taskDir(home, id);
  return [
    path.join(dir, 'task.json'),
    messagesDir(home, id),
    path.join(dir, 'waits'),
    path.join(dir, 'inbox'),
    path.join(dir, 'history'),
    healthFile(home, id),
    wardenLogFile(home, id),
    stallsFile(home, id),
  ];
}

function inside(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The kept path a removal would land inside, or `null` — this is the check itself. */
export function keptBy(target, kept) {
  return kept.find((k) => inside(target, k)) ?? null;
}

/** A direct child of the named directory, or `null` — a record field that walked out.
 * [reference/03-cli.md#childof--a-path-built-from-a-record-field-stays-a-direct-child](../docs/reference/03-cli.md#childof--a-path-built-from-a-record-field-stays-a-direct-child) */
export function childOf(dir, name) {
  if (typeof name !== 'string' || !name) return null;
  const target = path.join(dir, name);
  const rel = path.relative(dir, target);
  return rel && !rel.startsWith('..') && !rel.includes(path.sep) && !path.isAbsolute(rel)
    ? target : null;
}

// The keep-list as a check and not a comment: a removal aimed inside it throws.
function takeAway(target, kept) {
  const held = keptBy(target, kept);
  if (held) {
    throw new Error(`sweep refused to remove ${target}: it lies inside ${held}, `
      + "which the run's telemetry and mailboxes are read from");
  }
  rmSync(target, { recursive: true, force: true });
}

// Artifact ids this participant SENT. The sender lives on the message, not on the
// artifact record, so the canonical messages are the only place binding the two.
function sentArtifacts(home, id, participantId) {
  const dir = messagesDir(home, id);
  const ids = new Set();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return ids;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let msg;
    try {
      msg = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (msg?.sender === participantId && typeof msg.artifact === 'string') ids.add(msg.artifact);
  }
  return ids;
}

/** Every artifact record of the task, each proven before a path is built from it.
 * [reference/03-cli.md#artifactrecords--every-record-proven-before-a-path-is-built-from-it](../docs/reference/03-cli.md#artifactrecords--every-record-proven-before-a-path-is-built-from-it) */
function artifactRecords(home, id) {
  let names;
  try {
    names = readdirSync(artifactsDir(home, id));
  } catch {
    return { records: [], broken: [] };
  }
  const records = [];
  const broken = [];
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    const file = path.join(artifactsDir(home, id), name);
    let rec;
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      broken.push(`${name}: ${e.message}`);
      continue;
    }
    const verdict = validate('artifact', rec);
    if (!verdict.ok) {
      broken.push(`${name}: ${verdict.at ? `${verdict.at} — ` : ''}${verdict.note}`);
      continue;
    }
    const blob = childOf(blobsDir(home, id), rec.sha256);
    const link = childOf(filesDir(home, id), rec.filename);
    if (!blob || !link) {
      broken.push(`${name}: sha256 or filename leaves the task directory`);
      continue;
    }
    records.push({ ...rec, file, blob, link });
  }
  return { records, broken };
}

/** The blobs and files of one piece, resolved before a single removal.
 * [reference/03-cli.md#artifactplan--the-blobs-and-files-of-one-piece](../docs/reference/03-cli.md#artifactplan--the-blobs-and-files-of-one-piece) */
function artifactPlan(home, id, participantId) {
  const { records, broken } = artifactRecords(home, id);
  if (broken.length) return { broken, going: [] };
  const mine = sentArtifacts(home, id, participantId);
  return { broken, going: records.filter((a) => mine.has(a.id)) };
}

function inodeOf(file) {
  try {
    const st = statSync(file);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** The removals of one piece, under the publication lock.
 * [reference/03-cli.md#sweepartifacts--the-removals-of-one-piece-under-the-publication-lock](../docs/reference/03-cli.md#sweepartifacts--the-removals-of-one-piece-under-the-publication-lock) */
export function sweepArtifacts(home, id, plan, kept) {
  return withBlobLock(home, id, () => {
    const swept = { records: 0, blobs: 0, files: 0, unlinked: [], busy: [] };
    const inodes = new Map(plan.going.map((rec) => [rec.sha256, inodeOf(rec.blob)]));
    // Read ONCE, and only after the lock is in hand: no publication can land while it is
    // held, so a record that arrived during the wait is here and the only later change is ours.
    let live = listArtifacts(home, id).artifacts;
    for (const rec of plan.going) {
      const key = inodes.get(rec.sha256);
      if (key && inodeOf(rec.link) === key) {
        takeAway(rec.link, kept);
        swept.files += 1;
      } else if (key) {
        swept.unlinked.push(rec.filename);
      }
      takeAway(rec.file, kept);
      live = live.filter((a) => a.id !== rec.id);
      swept.records += 1;
      if (!existsSync(rec.blob)) continue;
      // One reading of "nothing names this payload", and it is the engine's own.
      if (blobNamed(home, id, rec.sha256, live)) { swept.busy.push(rec.filename); continue; }
      takeAway(rec.blob, kept);
      swept.blobs += 1;
    }
    return swept;
  });
}

// Participant files in `workers/` and the contact point. Only of a dead session: a live
// one still knocks through its wake file and still reads its own mcp-config.
function sweepParticipantFiles(home, id, address, kept) {
  const gone = [];
  for (const at of [
    wakeFile(home, id, address),
    participantMcpPath(home, id, address),
    participantSettingsPath(home, id, address),
    ...participantDirs(home, id, address),
  ]) {
    if (!existsSync(at)) continue;
    takeAway(at, kept);
    gone.push(at);
  }
  return gone;
}

/** The tree and branch of one piece, on the SAME two content measurements `done` uses.
 * [reference/03-cli.md#sweeptree--the-tree-and-branch-of-one-piece](../docs/reference/03-cli.md#sweeptree--the-tree-and-branch-of-one-piece) */
function sweepTree(p, host, address) {
  const { worktree, repoAbs } = p.metadata ?? {};
  if (!worktree || !repoAbs) return { state: 'none', code: 0 };
  // The directory the journal names is not on disk, so neither measurement can run. That
  // is not the state "there was no tree": the branch may hold work nobody proved was taken.
  if (!existsSync(worktree)) {
    pruneWorktrees(repoAbs);
    warn(`worktree ${worktree} is named by the journal and is not on disk: neither merge `
      + 'measurement can run, so nothing of this piece is judged taken');
    info(`orphaned registration pruned in ${repoAbs}; the blobs and files of ${address} stay`);
    return { state: 'vanished', code: 0 };
  }
  const found = inspectWorktree(repoAbs, worktree, host.defaultBranch(repoAbs));
  const { action, reason } = worktreeDisposition(found);
  if (action === 'keep') {
    warn(`worktree ${worktree} left in place: ${reason}`);
    info(`the piece of ${address} keeps its tree, and its blobs and files stay with it — `
      + 'they may be the only copy of work that is not in the base');
    return { state: 'kept', code: 0 };
  }
  const r = removeWorktree(repoAbs, worktree, found.branch);
  if (!r.removed) {
    warn(`could not remove worktree ${worktree}: ${r.error ?? 'git did not explain'}`);
    return { state: 'kept', code: 1 };
  }
  ok(`worktree ${worktree} removed (${reason})${r.branchDeleted ? `, branch ${found.branch} deleted` : ''}`);
  if (r.branchKept) info(`branch ${r.branchKept} left in place: spawn did not create it — deleting a foreign branch is not our job`);
  if (r.branchStuck) {
    info(`branch ${r.branchStuck} left in place: force deletion failed.`
      + ` Delete: git -C ${shellQuote(repoAbs)} branch -D ${shellQuote(r.branchStuck)}`);
  }
  return { state: 'removed', code: 0 };
}

// The driver of this record, taken from the SAME registry the liveness snapshot used: a
// half seam would ask a stand-in who is alive and a live harness what to clear.
function driverAt(p, registry) {
  try {
    return driverFor(registry, harnessOf(p, registry));
  } catch {
    return driverOrLift(p);
  }
}

// An approver of THIS task holding the calling session — proven by the participant
// record's own session, the same one direct worker↔approver traffic is proven by.
function approverHere(meta, session) {
  if (!session) return null;
  return (meta.participants ?? []).find((p) => p.role === 'approver'
    && (sessionIdOf(p) ?? sessionOf(p))
    && !foreignSessionOf(p, session)) ?? null;
}

/** Who may sweep a piece — a positive proof, never the absence of one.
 * [reference/03-cli.md#requiresweeper--who-may-sweep-a-piece](../docs/reference/03-cli.md#requiresweeper--who-may-sweep-a-piece) */
function requireSweeper(host, home, meta, session) {
  const owner = taskOwner(home, meta.id);
  if (session && owner && sameOwnerSession(owner, session)) return;
  if (approverHere(meta, session)) return;
  const why = !session
    ? 'this call carries no session identity, so it can prove neither'
    : `this session is ${session}, and the task ${owner ? `mailbox owner is ${owner}` : 'records no mailbox owner'}`;
  // The claim route is for the OWNER whose daemon died, and it is offered only where that
  // is the story: told to a passer-by it would read "the task is yours" about somebody else's.
  const route = session && owner
    ? ` ${claimRoute(host.busCommand(['sweep']))}`
    : ` The owner of this task sweeps it, or the approver it lifted: ${host.busCommand(['status'])} names them.`;
  fail(`task ${meta.id} («${meta.title}»): a piece is swept by the task mailbox owner or by an approver `
    + `of this task holding its own recorded session, and the right is proven rather than assumed — ${why}. `
    + 'The sweep removes a worktree, a branch and the blobs of one participant, and a foreign hand would cut '
    + `off live work.${route}`);
}

// What a re-lift of this address would change. Read before the lock and again under it:
// `spawn` replaces the record through that same lock, so a changed field is a new session.
function liftMark(p) {
  return JSON.stringify([p?.sessionRef ?? null, p?.metadata?.worktree ?? null,
    p?.metadata?.repoAbs ?? null, p?.metadata?.started ?? null]);
}

/** Clean up after one accepted piece; the task stays active.
 * [reference/03-cli.md#sweep--clean-up-after-one-accepted-piece](../docs/reference/03-cli.md#sweep--clean-up-after-one-accepted-piece) */
export function sweep(rootOrHost, { task, address } = {}, { registry = REGISTRY } = {}) {
  const host = hostOf(rootOrHost);
  const home = host.promptobusHome();
  const id = resolveTaskId(home, task, sessionIdentity(), {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });
  const meta = readTask(home, id);
  // A closed task has no piece to accept and no run to keep alive, and explicit --task is
  // not a way in. Refused before the right is asked and before any side effect.
  if (meta.status !== 'active') {
    fail(`task ${id} is closed — a piece is swept mid-run, while the task is still active. What is left `
      + `of a closed task goes with ${host.busCommand(['done'])} and ${host.busCommand(['prune'])}`);
  }
  requireSweeper(host, home, meta, sessionIdentity());
  const known = addressesOf(meta);
  const route = `${host.busCommand(['sweep', '<address>', `--task ${id}`])}. Task participants: ${known.join(', ')}`;
  if (!address) fail(`name the participant address: ${route}`);
  if (address === ORCHESTRATOR) {
    fail(`${ORCHESTRATOR} has no piece to sweep — it owns the task, and the task is closed by `
      + `${host.busCommand(['done'])}. Sweep a task participant. ${route}`);
  }
  const p = participantOf(meta, address);
  if (!p) fail(`task ${id} has no participant "${address}" — nothing to sweep. ${route}`);
  const state = participantSession(p, snapshotSessions([p], registry));
  if (state !== 'dead') {
    fail(`participant ${address} session is ${state === 'alive' ? 'still alive' : 'unknown'} — a sweep would `
      + 'take its worktree from under a running session and its mcp-config from under a live bus. Close it '
      + `first: ${host.busCommand(['stop', address, `--task ${id}`])}, or from ${driverAt(p, registry).phrases.sessions}`);
  }
  // Named before the first removal, as `done` and `stop` name theirs: the sweep is
  // irreversible, and a person must read what is going now rather than what went.
  info(`sweeping the accepted piece of ${address} in task ${id} — the task stays active and the `
    + 'other participants are untouched');
  // The destructive stretch runs under the journal lock — `takePiece` says what for.
  const outcome = withTaskLock(home, id, () => takePiece(host, home, id, address, liftMark(p), registry));
  if (outcome.refused) fail(outcome.refused);
  ok(`task ${id} stays active; ${host.busCommand(['status'])} shows who is still in it`);
  info('telemetry, canonical messages, the warden log, health and the wait sidecars of the run are kept '
    + `by the sweep — the rows ${host.busCommand(['done'])} writes are read from them`);
  return outcome.code;
}

/** The destructive stretch, under the journal lock.
 * [reference/03-cli.md#takepiece--the-destructive-stretch-under-the-journal-lock](../docs/reference/03-cli.md#takepiece--the-destructive-stretch-under-the-journal-lock) */
function takePiece(host, home, id, address, mark, registry) {
  const p = participantOf(readTask(home, id), address);
  if (!p || liftMark(p) !== mark) {
    return {
      code: 1,
      refused: `participant ${address} changed between the liveness check and the sweep — it was lifted again, `
        + 'or its record was rewritten. Nothing was removed; check the session and repeat: '
        + `${host.busCommand(['sweep', address, `--task ${id}`])}`,
    };
  }
  if (participantSession(p, snapshotSessions([p], registry)) !== 'dead') {
    return {
      code: 1,
      refused: `participant ${address} has a session again — nothing was removed. Close it first: `
        + `${host.busCommand(['stop', address, `--task ${id}`])}`,
    };
  }
  // Every path is resolved and proven BEFORE the first removal: a record the schema refuses,
  // or one that walked out of the task, must not be met after the tree is already gone.
  const plan = artifactPlan(home, id, addrDir(address));
  if (plan.broken.length) {
    return {
      code: 1,
      refused: `task ${id} has artifact records this sweep cannot read, and a piece does not leave on a guess: `
        + `${plan.broken.join('; ')}. Nothing was removed — repair them or move them into `
        + `${path.join(taskDir(home, id), 'broken', 'artifacts')}, then repeat the sweep`,
    };
  }
  const kept = keptPaths(home, id);
  const tree = sweepTree(p, host, address);
  if (tree.state === 'none' || tree.state === 'removed') sayArtifacts(sweepArtifacts(home, id, plan, kept), address);
  // Harness state can live OUTSIDE the worktree: a Codex reviewer has no worktree at all and
  // still has an isolated home holding a copy of the owner's credentials.
  try {
    driverAt(p, registry).sweepParticipant?.(p, id);
  } catch (e) {
    warn(`could not clear the harness state of participant ${address}: ${e.message}`);
  }
  for (const at of sweepParticipantFiles(home, id, address, kept)) {
    info(`${address}: ${at} removed — the session is dead, and the file is the lift's, not the repository's`);
  }
  return { code: tree.code, refused: null };
}

function sayArtifacts(swept, address) {
  if (swept.records) {
    ok(`artifacts of ${address} removed: records ${swept.records}, blobs ${swept.blobs}, `
      + `files-folder links ${swept.files}`);
  }
  for (const filename of swept.unlinked) {
    warn(`artifact «${filename}» has no files-folder entry sharing its blob's inode and stays: the entry `
      + 'went by hand, or the store stopped hard-linking and this sweep no longer finds one');
  }
  for (const filename of swept.busy) {
    warn(`blob of artifact «${filename}» stays: the payload is still named — by a surviving record, or by `
      + 'another hard link to it, whose own record may not be on disk yet');
  }
}

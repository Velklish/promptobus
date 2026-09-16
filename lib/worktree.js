import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  PROC_INSTALL_TIMEOUT_MS, gitIn, runLogged, shellQuote, toPosix,
} from './util.js';
import { writeFileAtomic } from '../dist/fs/atomic.js';

// git is the source of truth about a worker's worktree: a worker told to make their own
// branch moves the tree onto it, and the journal keeps the service one.

// Prefix of the branch spawn creates: here it is used to decide whether the branch is
// ours or someone else's.
export const WORKTREE_BRANCH_PREFIX = 'worktree-';

/** Directory of service worktrees inside the clone, relative. Its home is here because the
 * `.git/info/exclude` line below cites it: two copies would leave the clone dirty forever. */
export const WORKTREE_DIR_REL = path.join('.claude', 'worktrees');

// Full template of the service branch name, as prose cites it (`<!-- contract:worktree-branch -->`).
// Built FROM the prefix: otherwise a rename would leave the template and the citations behind.
export const WORKTREE_BRANCH_TEMPLATE = `${WORKTREE_BRANCH_PREFIX}promptobus-<task-slug>-<worker-slug>-t<date>-<time>`;

const git = (dir, ...args) => gitIn(dir, args);
const out = (r) => (r.status === 0 ? (r.stdout ?? '').trim() : null);

// Why git failed — one line and never empty: a process killed by timeout or hitting the
// output ceiling leaves neither stderr nor a status, the reason sits in `error`.
const gitWhy = (r) => (r.stderr ?? '').trim().split('\n').filter(Boolean).pop()
  || r.error?.message
  || 'git did not explain';

// Default-branch refs in preference order: local, then origin. Existing ones only, and the
// order is one for all consumers — there must not be a second copy of this ladder.
export function defaultRefs(repoAbs, def) {
  return [def, def && `origin/${def}`]
    .filter(Boolean)
    .filter((r) => out(git(repoAbs, 'rev-parse', '--verify', '--quiet', r)) !== null);
}

// Branch the worktree is on now. null — no directory, git is silent, or HEAD is detached.
export function worktreeBranch(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return null;
  const branch = out(git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'));
  return branch && branch !== 'HEAD' ? branch : null;
}

// Header of journal-vs-git divergence, cited verbatim by prose, so it lives as a constant:
// the contract-quote gate checks the citation against it.
export const BRANCH_CHANGED_MARK = 'WORKER CHANGED BRANCH';

// Line about a participant's branch: journal versus git. They diverged — loud: the
// result must be taken from the branch git named.
export function branchLine(journalBranch, actualBranch) {
  if (!actualBranch) return journalBranch ? `branch ${journalBranch} (git did not answer — worktree removed?)` : null;
  if (!journalBranch || journalBranch === actualBranch) return `branch ${actualBranch}`;
  return `branch ${actualBranch} — ${BRANCH_CHANGED_MARK} (in the journal ${journalBranch}): take the result from ${actualBranch}`;
}

// What is known before cleanup. `unmerged` is a fact about ANCESTRY and decides nothing on
// its own — after a squash merge it counts a branch whose work is entirely in.
export function inspectWorktree(repoAbs, worktreePath, def) {
  // No directory — answer with the same "I don't know" as on git silence: `dirty: null`
  // sends the decision to `keep`.
  if (!worktreePath || !existsSync(worktreePath)) return { branch: null, dirty: null, unmerged: null, base: null, adds: null };
  const branch = worktreeBranch(worktreePath);
  const dirty = out(git(worktreePath, 'status', '--porcelain'));
  // Compare against BOTH default branches: work merged into origin with a stale local
  // master would otherwise hold the directory as unclaimed.
  const refs = defaultRefs(repoAbs, def);
  const counts = branch ? refs.map((r) => ({ ref: r, n: out(git(repoAbs, 'rev-list', '--count', `${r}..${branch}`)) })) : [];
  const known = counts.filter((c) => c.n !== null).map((c) => ({ ref: c.ref, n: Number(c.n) }));
  const best = known.length ? known.reduce((a, b) => (b.n < a.n ? b : a)) : null;
  const needAdds = !!best && best.n > 0 && dirty !== null && dirty.length === 0 && !!branch;
  const adds = needAdds ? branchAdds(repoAbs, best.ref, branch) : null;
  return {
    branch,
    dirty: dirty === null ? null : dirty.length > 0,
    unmerged: best ? best.n : null,
    base: best ? best.ref : null,
    // Counted only where the answer is needed: `merge-tree --write-tree` is a full three-way
    // merge. Not counted is `null`, not `false` — `false` would claim a comparison.
    adds,
    // Asked only where the merge could not answer. Two measurements, not two opinions:
    // this one is about patch identity and does not care what the base did afterwards.
    squashed: needAdds && adds === null ? squashedInto(repoAbs, best.ref, branch) : null,
  };
}

// Whether the branch adds anything when merged. Ancestry is not enough — a squash merge
// leaves no history. Conflict, old git or refusal is `null`, and the decision is "keep".
function branchAdds(repoAbs, base, branch) {
  const r = git(repoAbs, 'merge-tree', '--write-tree', base, branch);
  if (r.status !== 0) return null;
  const merged = (r.stdout ?? '').trim().split('\n')[0];
  const baseTree = out(git(repoAbs, 'rev-parse', `${base}^{tree}`));
  if (!merged || !baseTree) return null;
  return merged !== baseTree;
}

/** Was the branch's work taken into the base as ONE commit?
 * [reference/03-cli.md#squashedinto--was-the-branchs-work-taken-into-the-base-as-one-commit](../docs/reference/03-cli.md#squashedinto--was-the-branchs-work-taken-into-the-base-as-one-commit) */
function squashedInto(repoAbs, base, branch) {
  const fork = out(git(repoAbs, 'merge-base', base, branch));
  if (!fork) return null;
  // Restricted to the branch's own paths: unrestricted, `log -p` prints every commit the
  // base gained since the fork — megabytes past the ceiling, and every sweep says "unsure".
  const listed = out(git(repoAbs, 'diff', '--name-only', fork, branch));
  if (listed === null) return null;
  const paths = listed.split('\n').filter(Boolean);
  // Nothing changed, or more paths than fit an argv: both answer "cannot say" and keep the
  // directory. An empty branch is `branchAdds`' business.
  if (!paths.length || paths.length > PATCH_PATHS_MAX) return null;
  const mine = patchIds(repoAbs, gitIn(repoAbs, ['diff', '--full-index', fork, branch, '--', ...paths]));
  // No id at all means an empty diff, not a failed read: `branchAdds` would have said
  // `false` for that, and answering `true` here would be an id compared with nothing.
  if (mine === null || mine.length !== 1) return null;
  const theirs = patchIds(repoAbs, gitIn(repoAbs,
    ['log', '--format=%H', '-p', '--full-index', `${fork}..${base}`, '--', ...paths]));
  if (theirs === null) return null;
  return theirs.includes(mine[0]);
}

/** Ceiling on the pathspec of that scan — an argv guard, not a judgement about the branch. */
const PATCH_PATHS_MAX = 2000;

// Patch ids of a diff or a `log -p` stretch. `null` — a side of the pipe refused, and the
// caller may not turn that into a verdict. `--stable` is required: order changes the id.
function patchIds(repoAbs, produced) {
  if (produced.status !== 0) return null;
  const r = gitIn(repoAbs, ['patch-id', '--stable'], produced.stdout ?? '');
  if (r.status !== 0) return null;
  return (r.stdout ?? '').split('\n').filter(Boolean).map((line) => line.split(' ')[0]);
}

// Fate of the directory — a pure function of what was found. Remove only the proven
// empty; keep everything else: a directory is cheap to delete and impossible to return.
export function worktreeDisposition(info) {
  if (info?.dirty == null) return { action: 'keep', reason: 'git did not answer about the tree state' };
  if (info.dirty) return { action: 'keep', reason: 'uncommitted changes in the tree' };
  if (!info.branch) return { action: 'keep', reason: 'git did not name the branch (detached HEAD?)' };
  if (info.unmerged === null) return { action: 'keep', reason: 'nothing to compare against: the repository default branch is not visible' };
  if (info.unmerged > 0) {
    // A squash merge leaves NONE of the branch's commits in the base, so the count above
    // says nothing. The two content measurements answer, and the message names which one.
    if (info.adds === false) {
      return {
        action: 'remove',
        reason: `branch ${info.branch} is merged as a squash — its ${info.unmerged} commit(s) are not in `
          + `${info.base}, and merging them into ${info.base} would add nothing`,
      };
    }
    if (info.squashed === true) {
      return {
        action: 'remove',
        reason: `branch ${info.branch} is merged as a squash — ${info.base} holds a commit with this `
          + `branch's own patch (patch-id), though its ${info.unmerged} commit(s) are not in ${info.base}`,
      };
    }
    // Not merged, or not measurable. Both keep the directory, and they are different
    // sentences: one is about the branch, the other about the comparison.
    const measured = info.adds === true
      ? `merging them into ${info.base} would add changes it does not have`
      : `neither the merge nor the patch-id comparison with ${info.base} could confirm the work was taken`;
    return {
      action: 'keep',
      reason: `branch ${info.branch} is not merged: ${info.unmerged} commit(s) are not in ${info.base}, `
        + `and ${measured} — take them (merge/MR) or delete yourself`,
    };
  }
  return { action: 'remove', reason: `branch ${info.branch} is entirely in ${info.base}` };
}

// Worktree lock: `git worktree list --porcelain` prints `locked`, with `--reason` the text.
// Paths compare by realpath — on macOS a temp directory arrives as `/var/…` and `/private/var/…`.
function realOrSelf(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

function worktreeLock(repoAbs, worktreePath) {
  const list = out(git(repoAbs, 'worktree', 'list', '--porcelain'));
  if (list === null) return null;
  const target = realOrSelf(worktreePath);
  let here = false;
  let found = false;
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) {
      here = realOrSelf(line.slice('worktree '.length).trim()) === target;
      found = found || here;
      continue;
    }
    if (!here) continue;
    if (line.trim() === 'locked') return { locked: true, reason: '' };
    if (line.startsWith('locked ')) return { locked: true, reason: line.slice('locked '.length).trim() };
  }
  // The directory is in the list, there is no `locked` line — not locked. The directory
  // is not in the list at all — that is "I don't know", not "not locked".
  return found ? { locked: false, reason: '' } : null;
}

// Removing the directory and the branch; reached only after the content measurements prove
// it removable. A force delete is required because ancestry cannot confirm a squash merge.
export function removeWorktree(repoAbs, worktreePath, branch) {
  let rm = git(repoAbs, 'worktree', 'remove', worktreePath);
  // A lock with a reason was set by a person and is not lifted; one without a reason is a
  // leftover of the former mechanism — unlock and retry. `-f` also lifts the dirt guard.
  if (rm.status !== 0) {
    const lock = worktreeLock(repoAbs, worktreePath);
    if (lock?.locked && lock.reason) {
      return {
        removed: false,
        error: `directory locked by a person (${lock.reason}) — cleanup will not lift someone else's lock.`
          + ` The lock is no longer needed: git -C ${shellQuote(repoAbs)} worktree unlock ${shellQuote(worktreePath)}`,
        branchKept: null,
      };
    }
    if (lock?.locked && git(repoAbs, 'worktree', 'unlock', worktreePath).status === 0) {
      rm = git(repoAbs, 'worktree', 'remove', worktreePath);
      // Still could not remove — put the lock back: we did not set it, and an unlocked
      // directory would mean cleanup silently lost someone else's protection.
      if (rm.status !== 0) git(repoAbs, 'worktree', 'lock', worktreePath);
    }
  }
  if (rm.status !== 0) return { removed: false, error: gitWhy(rm), branchKept: null };
  // Only the branch spawn created: a branch a worker moved to is not ours, and the same
  // path would put the default branch under deletion. The prefix is the ownership check.
  const ours = typeof branch === 'string' && branch.startsWith(WORKTREE_BRANCH_PREFIX);
  const br = ours ? git(repoAbs, 'branch', '-D', branch) : null;
  const deleted = br ? br.status === 0 : false;
  // A force-delete refusal is still named by the caller; cleanup must not pretend the
  // branch went away when Git did not remove it.
  return {
    removed: true,
    branchDeleted: deleted,
    branchKept: ours ? null : (branch ?? null),
    branchStuck: ours && !deleted ? branch : null,
  };
}

// The working tree is created here, not with the `claude --worktree` flag: the flag takes
// the base from origin, and the worker would not see unpushed local commits.
export function createWorktree(repoAbs, worktreePath, branch, base) {
  // Two live leftovers of past runs on which `worktree add` refuses where it could go on:
  // an orphaned registration, and a surviving `worktree-…` branch — then no `-b`.
  pruneWorktrees(repoAbs);
  const exists = out(git(repoAbs, 'rev-parse', '--verify', '--quiet', branch)) !== null;
  const args = exists
    ? ['worktree', 'add', '-q', worktreePath, branch]
    : ['worktree', 'add', '-q', '-b', branch, worktreePath, ...(base ? [base] : [])];
  const r = git(repoAbs, ...args);
  if (r.status !== 0) return { created: false, error: gitWhy(r), reused: false, baseSha: null };
  // The branch point is the sha right after creation: a base NAME catches up with other
  // people's commits. On a surviving branch only the journal knows it, so `null`.
  const baseSha = exists ? null : out(git(repoAbs, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`));
  return { created: true, reused: exists, baseSha };
}

// The install sign and command, one for spawn and `--dry-run`. No lock, no step at all: a
// repository without npm must not see a foreign toolchain. `npm` on Windows is a `.cmd`.
const WORKTREE_LOCK = 'package-lock.json';
const NPM_CI_ARGS = ['ci', '--no-audit', '--no-fund'];

export function worktreeHasLock(dir) {
  return !!dir && existsSync(path.join(dir, WORKTREE_LOCK));
}

export function npmCiCommand() {
  return `npm ${NPM_CI_ARGS.join(' ')}`;
}

// A repository where `node_modules` is not ignored is dirty forever after install: `done`
// will not remove such a tree, and `git add -A` takes the dependencies into a commit.
function nodeModulesIgnored(worktreePath) {
  const r = git(worktreePath, 'check-ignore', '-q', 'node_modules');
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/** Installs dependencies in a just-created worktree. A refusal is not a spawn refusal; npm
 * output goes to a log beside the directory, whose path the warning names. */
// `env` is an ENOENT-check seam: spawnSync without an explicit env takes the process PATH,
// and the runner often leaves the system PATH to the child.
export function installWorktreeDeps(worktreePath, { env } = {}) {
  if (!worktreeHasLock(worktreePath)) return { ran: false };
  const logPath = `${worktreePath}.npm-ci.log`;
  const result = runLogged(['npm', ...NPM_CI_ARGS], {
    cwd: worktreePath, timeout: PROC_INSTALL_TIMEOUT_MS, logPath, ...(env ? { env } : {}),
  });
  const ignored = nodeModulesIgnored(worktreePath);
  if (result.status === 0) return { ran: true, ok: true, ms: result.ms, logPath, ignored };
  return { ran: true, ok: false, ms: result.ms, why: result.why, command: npmCiCommand(), logPath, ignored };
}

// A service directory must not look like an uncommitted change, or the clone stays dirty
// and `fresh` will not touch it. Three-state: added, present, failed — a boolean merges two.
export function excludeWorktrees(repoAbs) {
  const probe = git(repoAbs, 'rev-parse', '--git-common-dir');
  const dir = out(probe);
  if (!dir) return { status: 'failed', error: `git did not name the .git directory: ${gitWhy(probe)}` };
  const abs = path.isAbsolute(dir) ? dir : path.join(repoAbs, dir);
  const file = path.join(abs, 'info', 'exclude');
  const line = `**/${toPosix(WORKTREE_DIR_REL)}/`;
  try {
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // Claude Code itself may have set the line (the `# claude-code-runtime` block) — it is fine.
    if (cur.split('\n').some((l) => l.trim() === line || l.trim() === '.claude/worktrees/')) {
      return { status: 'present', error: null };
    }
    // Our own line with our own marker; we do not write into someone else's block — it
    // would vanish on regeneration.
    const own = `# promptobus: service worktrees of Promptobus workers\n${line}\n`;
    // Write via tmp+rename: the exclude file has a person's lines, they must not be lost.
    writeFileAtomic(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${own}`,
      { mode: 0o644, preserveMode: true });
    return { status: 'added', error: null };
  } catch (e) {
    return { status: 'failed', error: e.message };
  }
}

/** What git calls uncommitted or untracked here; `null` is "git did not answer", not clean.
 * Exported because a generator leaving unignored files must be said out loud at spawn. */
export function worktreeDirt(worktreePath) {
  const r = git(worktreePath, 'status', '--porcelain');
  return r.status === 0 ? (r.stdout ?? '').trim().split('\n').filter(Boolean) : null;
}

// Orphaned registrations in .git/worktrees, from directories removed outside git. While the
// record lives, git considers the branch taken and refuses a worktree on the same path.
export function pruneWorktrees(repoAbs) {
  return git(repoAbs, 'worktree', 'prune').status === 0;
}

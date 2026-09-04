import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {
  GIT_MAX_OUTPUT, GIT_NET_TIMEOUT_MS, PROC_INSTALL_TIMEOUT_MS, lastLines, procTimedOut, runProc,
  shellQuote, toPosix, writeFileAtomic,
} from './util.js';

// git is the source of truth about a worker's worktree. Spawn sets the branch name at
// start, but a worker whose brief told them to make their own moves the worktree onto
// it — the journal stays with the service one. git is called directly via spawnSync,
// not through exec.js: the wrapper is needed where a binary on Windows has a .cmd, and
// git is a native .exe. There are no heavy imports: the bus MCP server, started for
// every participant, also reads this module.

// Prefix of the branch spawn creates: here it is used to decide whether the branch is
// ours or someone else's.
export const WORKTREE_BRANCH_PREFIX = 'worktree-';

/**
 * Directory of service worktrees inside the clone — as a relative path. Its home is
 * here, not at lift: the same path stands in the `.git/info/exclude` line below, and
 * two copies would drift silently — the directory would be created in one place and
 * excluded in another, and the clone would stay dirty forever. The name was inherited
 * from a directory that was already in the repository; it has nothing to do with a
 * driver — this is workspace layout, one for all harnesses.
 */
export const WORKTREE_DIR_REL = path.join('.claude', 'worktrees');

// Full template of the service branch name — in the form prose of the orchestration
// skill and the guide cite it (`<!-- contract:worktree-branch -->`, key in VALUE_HOMES
// of lint.js). Built FROM the prefix: otherwise a rename would leave the template and
// the citations as they were.
export const WORKTREE_BRANCH_TEMPLATE = `${WORKTREE_BRANCH_PREFIX}promptobus-<task-slug>-<worker-slug>-t<date>-<time>`;

// Output and wait ceilings — shared with fresh.js and zone.js: on the default megabyte
// a dirty worktree's `status --porcelain` kills the process. The timeout guards against
// a stuck index.lock. `core.quotePath=false` — non-Latin lines arrive readable.
const git = (dir, ...args) => spawnSync('git', ['-c', 'core.quotePath=false', '-C', dir, ...args], {
  encoding: 'utf8',
  maxBuffer: GIT_MAX_OUTPUT,
  timeout: GIT_NET_TIMEOUT_MS,
});
const out = (r) => (r.status === 0 ? (r.stdout ?? '').trim() : null);

// Why git failed — one line and never empty: a process killed by timeout or hitting the
// output ceiling leaves neither stderr nor a status, the reason sits in `error`.
const gitWhy = (r) => (r.stderr ?? '').trim().split('\n').filter(Boolean).pop()
  || r.error?.message
  || 'git did not explain';

// Default-branch refs in preference order: local, then the origin version. Existing
// ones only. The order is one for all consumers — there must not be a second copy of
// this ladder.
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

// Header of journal-vs-git divergence. Cited verbatim by prose — the reference and the
// orchestration skill — so it lives as a constant: the contract-quote gate checks the
// citation against it (key `branch-changed-mark` in lint.js).
export const BRANCH_CHANGED_MARK = 'WORKER CHANGED BRANCH';

// Line about a participant's branch: journal versus git. They diverged — loud: the
// result must be taken from the branch git named.
export function branchLine(journalBranch, actualBranch) {
  if (!actualBranch) return journalBranch ? `branch ${journalBranch} (git did not answer — worktree removed?)` : null;
  if (!journalBranch || journalBranch === actualBranch) return `branch ${actualBranch}`;
  return `branch ${actualBranch} — ${BRANCH_CHANGED_MARK} (in the journal ${journalBranch}): take the result from ${actualBranch}`;
}

// What is known about the worktree before cleanup. `def` is the default-branch name,
// brought by the caller: fresh.js determines it, and pulling it here means pulling the
// whole repository resolve. `unmerged` is how many of the branch's commits are not in
// default; null — nothing to compare against.
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
  return {
    branch,
    dirty: dirty === null ? null : dirty.length > 0,
    unmerged: best ? best.n : null,
    base: best ? best.ref : null,
    // Count only where the answer will be needed: `merge-tree --write-tree` is a full
    // three-way merge. Did not count — `null` ("I don't know"), not `false`: `false`
    // would mean "compared, nothing to merge in" — a sentence on the directory without
    // a comparison.
    adds: needAdds ? branchAdds(repoAbs, best.ref, branch) : null,
  };
}

// Whether the branch will add anything if merged into the base. Ancestor comparison is
// not enough: on a squash-merge the branch history does not land in the base.
// `merge-tree --write-tree` writes nothing to the working tree (git ≥ 2.38); conflict,
// old git, refusal — `null`, the decision is "keep".
function branchAdds(repoAbs, base, branch) {
  const r = git(repoAbs, 'merge-tree', '--write-tree', base, branch);
  if (r.status !== 0) return null;
  const merged = (r.stdout ?? '').trim().split('\n')[0];
  const baseTree = out(git(repoAbs, 'rev-parse', `${base}^{tree}`));
  if (!merged || !baseTree) return null;
  return merged !== baseTree;
}

// Fate of the directory — a pure function of what was found. Remove only the proven
// empty; keep everything else: a directory is cheap to delete and impossible to return.
export function worktreeDisposition(info) {
  if (info?.dirty == null) return { action: 'keep', reason: 'git did not answer about the tree state' };
  if (info.dirty) return { action: 'keep', reason: 'uncommitted changes in the tree' };
  if (!info.branch) return { action: 'keep', reason: 'git did not name the branch (detached HEAD?)' };
  if (info.unmerged === null) return { action: 'keep', reason: 'nothing to compare against: the repository default branch is not visible' };
  if (info.unmerged > 0) {
    // No commits in the base, and nothing to merge in — the work was taken by a squash.
    if (info.adds === false) {
      return { action: 'remove', reason: `branch ${info.branch} adds nothing to ${info.base} — work was taken (looks like a squash-merge)` };
    }
    const why = info.adds === null ? ' (could not merge them with the base — conflict or old git)' : '';
    return { action: 'keep', reason: `${info.unmerged} commit(s) of branch ${info.branch} are not in ${info.base}${why} — take them (merge/MR) or delete yourself` };
  }
  return { action: 'remove', reason: `branch ${info.branch} is entirely in ${info.base}` };
}

// Worktree directory lock: `git worktree list --porcelain` prints `locked` on a locked
// one, and with `--reason` — `locked <reason>`. `null` when git did not answer or the
// directory is not in the list. Paths are compared by realpath: on macOS a directory in
// a temp folder arrives both as `/var/…` and as `/private/var/…`.
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

// Removing the directory and the branch. The branch is deleted with the safe `-d`: the
// comparison above already said it is merged, and `-d` holds a second, independent
// gate — if they diverge, git wins.
export function removeWorktree(repoAbs, worktreePath, branch) {
  let rm = git(repoAbs, 'worktree', 'remove', worktreePath);
  // `git worktree remove` refuses on a locked directory. A lock with a reason was set
  // by a person — cleanup does not lift someone else's lock; a lock without a reason is
  // a leftover of the former mechanism (`claude --bg --worktree` locked its directory,
  // we do not lock ourselves) — unlock and try again. `-f` is not used: it also lifts
  // the protection against uncommitted changes.
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
  // Delete only the branch spawn created. The branch a worker moved to on a task
  // request is not ours; the same path would also put the default branch under
  // deletion. `-d` does not save from this: it checks mergedness, not ownership.
  const ours = typeof branch === 'string' && branch.startsWith(WORKTREE_BRANCH_PREFIX);
  const br = ours ? git(repoAbs, 'branch', '-d', branch) : null;
  const deleted = br ? br.status === 0 : false;
  // Our branch that `-d` did not give up — almost always a squash: the safe form
  // counts mergedness by ancestors. Silence about it is not allowed: branches pile up
  // in the clone.
  return {
    removed: true,
    branchDeleted: deleted,
    branchKept: ours ? null : (branch ?? null),
    branchStuck: ours && !deleted ? branch : null,
  };
}

// We create the worker's working tree ourselves, not with the `claude --worktree` flag:
// the flag does not let us choose the base and takes it from origin — the worker would
// not see unpushed local commits.
export function createWorktree(repoAbs, worktreePath, branch, base) {
  // Two live leftovers of past runs on which `worktree add` refuses where it can
  // continue: prune removes an orphaned registration, and on a surviving
  // `worktree-…` branch the tree is created WITHOUT `-b` — a repeat spawn continues
  // the work.
  pruneWorktrees(repoAbs);
  const exists = out(git(repoAbs, 'rev-parse', '--verify', '--quiet', branch)) !== null;
  const args = exists
    ? ['worktree', 'add', '-q', worktreePath, branch]
    : ['worktree', 'add', '-q', '-b', branch, worktreePath, ...(base ? [base] : [])];
  const r = git(repoAbs, ...args);
  if (r.status !== 0) return { created: false, error: gitWhy(r), reused: false, baseSha: null };
  // The branch point is the sha taken right after the branch was created: the base
  // name cannot replace it, the name catches up with other people's commits. On a
  // surviving branch HEAD is no longer the branch point — only the journal knows it,
  // so `null`.
  const baseSha = exists ? null : out(git(repoAbs, 'rev-parse', '--verify', '--quiet', `${branch}^{commit}`));
  return { created: true, reused: exists, baseSha };
}

// The install sign and command — one for spawn and for `--dry-run`. No lock — no step
// at all and it is not in the output: repositories without npm (.NET, Python) must not
// see a foreign toolchain. `npm`, not `git`: on Windows this is `.cmd`, and without
// `runProc` spawnSync will not find it.
// The command as a whole is `<!-- contract:npm-ci -->`, key in VALUE_HOMES of lint.js.
const WORKTREE_LOCK = 'package-lock.json';
const NPM_CI_ARGS = ['ci', '--no-audit', '--no-fund'];

export function worktreeHasLock(dir) {
  return !!dir && existsSync(path.join(dir, WORKTREE_LOCK));
}

export function npmCiCommand() {
  return `npm ${NPM_CI_ARGS.join(' ')}`;
}

// A repository where `node_modules` is not in ignore is dirty forever after install:
// `done` will not remove such a tree, and `git add -A` will take the dependencies into
// a commit.
function nodeModulesIgnored(worktreePath) {
  const r = git(worktreePath, 'check-ignore', '-q', 'node_modules');
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/**
 * Installs dependencies in a just-created worktree. An install refusal is not a spawn
 * refusal: a worker without `node_modules` is worse than no worker — no. `npm` output
 * goes to a log next to the directory, not into the tree and not to the terminal: a
 * file inside the worktree would become an uncommitted change, and the service
 * worktree directory is already in the clone's exclude. The output tail and the log
 * path go into the warning: a log nobody names cannot be found after a refusal.
 */
// `env` is an ENOENT-check seam. spawnSync without an explicit env takes the process
// PATH, and the suite runner often leaves the system PATH to the child, so hiding npm
// from process.env is not enough.
export function installWorktreeDeps(worktreePath, { env } = {}) {
  if (!worktreeHasLock(worktreePath)) return { ran: false };
  const started = Date.now();
  const r = runProc('npm', NPM_CI_ARGS, { cwd: worktreePath, timeout: PROC_INSTALL_TIMEOUT_MS, ...(env ? { env } : {}) });
  const ms = Date.now() - started;
  const logPath = `${worktreePath}.npm-ci.log`;
  try {
    writeFileSync(logPath, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`);
  } catch { /* the log is convenience; a write refusal does not roll back spawn */ }
  const ignored = nodeModulesIgnored(worktreePath);
  if (r.status === 0) return { ran: true, ok: true, ms, logPath, ignored };
  let why;
  if (r.error?.code === 'ENOENT') why = 'npm not found in PATH';
  else if (procTimedOut(r)) why = `did not respond in ${PROC_INSTALL_TIMEOUT_MS / 1000} s`;
  else {
    const tail = lastLines(r.stderr || r.stdout || r.error?.message || '');
    const code = r.status ?? r.error?.code ?? '?';
    why = tail ? `exited with code ${code}: ${tail}` : `exited with code ${code}`;
  }
  return { ran: true, ok: false, ms, why, command: npmCiCommand(), logPath, ignored };
}

// A service directory must not look like an uncommitted change: otherwise the clone is
// dirty forever, and `fresh` does not touch a dirty tree. We write to
// `.git/info/exclude` — a local file. The outcome is a three-state: added, present,
// failed — a boolean would merge "all is well" and "the clone will stay dirty forever".
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

// Orphaned registrations in .git/worktrees — from directories removed outside git.
// While the record is alive, git considers the branch taken and will not let a
// worktree be added on the same path.
export function pruneWorktrees(repoAbs) {
  return git(repoAbs, 'worktree', 'prune').status === 0;
}

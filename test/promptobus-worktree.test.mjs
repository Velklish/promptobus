// Regression suite for worktree truth and session liveness (). Run: npm test
//
// Two subjects. First — git as the source of truth: the branch name is taken from it, not
// from the task journal, and it also decides the directory's fate when the task closes. The
// fixtures are real: a repository with a worktree in a temp folder, no git mocks — we verify
// exactly what it does. Second — parsing a session record from `claude agents --json`: here
// it's the opposite, the records are synthetic, because what matters is the logic, not a
// live claude.
//
// **Names of the form `a2a-…` in fixtures are left in place on purpose**: that's what the
// previous CLI called branches, worktree directories, and sessions, and they verify that the
// hard rename didn't break what was already established. Details — in `promptobus.test.mjs`,
// the file's header comment.
import {
  writeFileSync, readFileSync, chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { check } from './check.mjs';

const SB = mkdtempSync(path.join(os.tmpdir(), 'promptobus-wt-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  branchLine, createWorktree, defaultRefs, excludeWorktrees, inspectWorktree,
  removeWorktree, worktreeBranch, worktreeDisposition,
} = await import(path.join(here, '..', 'lib', 'worktree.js'));
// The session registry and liftoff live behind the driver's contract: `spawn.js` no longer
// re-exports them — it doesn't import `liftoff.js` or the driver at all, and this guards the
// adapter boundary gate. The suite takes them from their own home.
const {
  sessionLiveness, awaitSession, findSession, spawnedSessionId, parseSessionId,
} = await import(path.join(here, '..', 'lib', 'liftoff.js'));

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

// --- fixture: a repository with two worktrees ------------------------------------
const REPO = path.join(SB, 'repo');
mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q', '-b', 'master');
writeFileSync(path.join(REPO, 'f'), 'первый\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-qm', 'первый');

// A worker's worktree that changed nothing: its branch is entirely contained in master.
const CLEAN = path.join(REPO, '.claude', 'worktrees', 'clean');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-clean', CLEAN);
// A worker's worktree with its own work: a commit that master doesn't have.
const AHEAD = path.join(REPO, '.claude', 'worktrees', 'ahead');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-ahead', AHEAD);
writeFileSync(path.join(AHEAD, 'f'), `работа worker'а\n`);
git(AHEAD, 'add', '.');
git(AHEAD, 'commit', '-qm', 'работа');
// A worktree that the worker moved to its own branch per the brief's request — the exact
// case that made MR !37 open up empty.
const MOVED = path.join(REPO, '.claude', 'worktrees', 'moved');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-moved', MOVED);
git(MOVED, 'checkout', '-q', '-b', 'feat/diagnostics-domain');

// --- branch: from git, not by naming convention ----------------------------
check('worktree branch is taken from git', worktreeBranch(CLEAN) === 'worktree-a2a-clean', String(worktreeBranch(CLEAN)));
check('worker changed branch — git returns the one it is currently on',
  worktreeBranch(MOVED) === 'feat/diagnostics-domain', String(worktreeBranch(MOVED)));
check('no directory — null, not a made-up branch', worktreeBranch(path.join(REPO, 'нет')) === null);
check('detached HEAD — null, not the string «HEAD»', (() => {
  const head = git(MOVED, 'rev-parse', 'HEAD').stdout.trim();
  git(MOVED, 'checkout', '-q', head);
  const got = worktreeBranch(MOVED);
  git(MOVED, 'checkout', '-q', 'feat/diagnostics-domain');
  return got === null;
})());

check('branch line: journal and git agree — no noise', branchLine('worktree-a2a-clean', 'worktree-a2a-clean') === 'branch worktree-a2a-clean');
check('branch line: a mismatch is called out loudly, naming both branches', (() => {
  const line = branchLine('worktree-a2a-moved', 'feat/diagnostics-domain');
  return line.includes('WORKER CHANGED BRANCH') && line.includes('worktree-a2a-moved') && line.includes('feat/diagnostics-domain');
})(), branchLine('worktree-a2a-moved', 'feat/diagnostics-domain'));
check('branch line: git stays silent — we say so, rather than printing the journal one as fact',
  branchLine('worktree-a2a-clean', null).includes('git did not answer'), branchLine('worktree-a2a-clean', null));

// --- directory fate when the task closes ------------------------------
const disp = (p) => worktreeDisposition(inspectWorktree(REPO, p, 'master'));
check('merged and clean worktree — remove', disp(CLEAN).action === 'remove', JSON.stringify(disp(CLEAN)));
check('has its own commits — keep it and name how many', (() => {
  const d = disp(AHEAD);
  return d.action === 'keep' && d.reason.includes('1 commit');
})(), JSON.stringify(disp(AHEAD)));
check('the check goes by git\'s branch, not the journal\'s: a moved-off worktree is not removed', (() => {
  writeFileSync(path.join(MOVED, 'f'), 'правка на своей ветке\n');
  git(MOVED, 'add', '.');
  git(MOVED, 'commit', '-qm', 'своя ветка');
  const d = disp(MOVED);
  return d.action === 'keep' && d.reason.includes('feat/diagnostics-domain');
})(), JSON.stringify(disp(MOVED)));
check('uncommitted changes — keep', (() => {
  writeFileSync(path.join(CLEAN, 'f'), 'недописанное\n');
  const d = disp(CLEAN);
  writeFileSync(path.join(CLEAN, 'f'), 'первый\n');
  return d.action === 'keep' && d.reason.includes('uncommitted');
})());
// The `adds` tri-state is kept honest: `false` means "we checked merge-tree, there's
// nothing to merge in" — a verdict against the directory. Wherever no check was made (a
// dirty tree, git staying silent, a merged branch), the answer must be `null` — "don't
// know".
check('adds does not invent "nothing to merge in" where it never checked', (() => {
  const clean = inspectWorktree(REPO, CLEAN, 'master');
  writeFileSync(path.join(AHEAD, 'f'), 'недописанное\n');
  const dirty = inspectWorktree(REPO, AHEAD, 'master');
  writeFileSync(path.join(AHEAD, 'f'), `работа worker'а\n`);
  return clean.adds === null && dirty.adds === null && worktreeDisposition(dirty).action === 'keep';
})(), JSON.stringify(inspectWorktree(REPO, CLEAN, 'master')));
// No directory — the same answer as git staying silent: "don't know" → `keep`.
// The resolver no longer has a separate 'gone' verdict, and that's not cosmetic: the
// production consumer (cleanup in spawn.js) filters out a nonexistent directory earlier,
// and drives everything that isn't 'keep' into `removeWorktree` — meaning the old branch
// was a landmine.
check('no directory — keep it, do not drive it into removal', (() => {
  const d = worktreeDisposition(inspectWorktree(REPO, path.join(REPO, 'нет'), 'master'));
  return d.action === 'keep' && /git did not answer/.test(d.reason);
})(), JSON.stringify(worktreeDisposition(inspectWorktree(REPO, path.join(REPO, 'нет'), 'master'))));
check('nothing to compare against — keep it, do not remove it just in case',
  worktreeDisposition(inspectWorktree(REPO, CLEAN, 'нет-такой-ветки')).action === 'keep',
  JSON.stringify(inspectWorktree(REPO, CLEAN, 'нет-такой-ветки')));

// The removal itself: the directory goes, and the merged branch goes with it. The directory
// is locked on purpose — `claude --bg --worktree` locks its own worktrees, and a live
// `promptobus done` used to trip on exactly this.
git(REPO, 'worktree', 'lock', CLEAN);
const rm = removeWorktree(REPO, CLEAN, 'worktree-a2a-clean');
check('removal: the directory is gone', rm.removed && !existsSync(CLEAN), JSON.stringify(rm));
check('removal: the merged branch was deleted along with the directory',
  rm.branchDeleted && !git(REPO, 'rev-parse', '--verify', '-q', 'worktree-a2a-clean').stdout.trim());
// git will not give up a branch with work not yet taken in, even on direct request: `-d`
// is a second gate on top of our own check, and if the two disagree, git wins.
const rmAhead = removeWorktree(REPO, AHEAD, 'worktree-a2a-ahead');
check('removal of an unmerged branch: the directory is removed, but the branch with the work survives',
  rmAhead.removed && rmAhead.branchDeleted === false
  && !!git(REPO, 'rev-parse', '--verify', '-q', 'worktree-a2a-ahead').stdout.trim(), JSON.stringify(rmAhead));

// Directory removal does not touch a branch that spawn did not create: the worker moved
// onto it at the task's request, a human named it for some reason, and whether it's merged
// decides nothing here.
const movedBranch = 'feat/diagnostics-domain';
git(REPO, 'merge', '-q', '--no-edit', movedBranch);
// We check that it is merged explicitly, rather than assuming it: without this, `-d` would
// have refused on its own, and the check below would pass for the wrong reason — "the
// branch was not touched" instead of "we chose not to touch it".
check('fixture: the foreign branch really is merged into master',
  git(REPO, 'branch', '--merged', 'master').stdout.includes(movedBranch),
  git(REPO, 'branch', '--merged', 'master').stdout);
const rmMoved = removeWorktree(REPO, MOVED, movedBranch);
check('removal: we do not delete a foreign branch, even a merged one — and we say we kept it',
  rmMoved.removed && rmMoved.branchKept === movedBranch && rmMoved.branchDeleted === false
  && !!git(REPO, 'rev-parse', '--verify', '-q', movedBranch).stdout.trim(), JSON.stringify(rmMoved));

// --- directory lock: lift our own, leave someone else's alone ---------------------
//
// A lock comes in two breeds. Without a reason — a trace of the old mechanism (`claude
// --bg --worktree` used to lock its own directories), cleanup lifts it and takes the
// directory with it: proven above by removing CLEAN. With a reason — a human set it, and
// cleanup leaves alone a lock that explains itself out loud.
const LOCKED = path.join(REPO, '.claude', 'worktrees', 'locked');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-locked', LOCKED);
git(REPO, 'worktree', 'lock', '--reason', 'разбираю руками', LOCKED);
const rmLocked = removeWorktree(REPO, LOCKED, 'worktree-a2a-locked');
check('lock with a reason — refusal, and the human\'s reason is named in it',
  !rmLocked.removed && String(rmLocked.error).includes('разбираю руками') && existsSync(LOCKED),
  JSON.stringify(rmLocked));
check('someone else\'s lock stayed put — cleanup did not lift it',
  git(REPO, 'worktree', 'unlock', LOCKED).status === 0);
git(REPO, 'worktree', 'remove', '--force', LOCKED);
git(REPO, 'branch', '-D', 'worktree-a2a-locked');

// A reasonless lock was lifted, but removing the directory still failed — the lock goes
// back in place: cleanup did not set it, and leaving the directory unlocked would mean
// silently lifting someone else's protection.
const STUCK = path.join(REPO, '.claude', 'worktrees', 'stuck');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-stuck', STUCK);
writeFileSync(path.join(STUCK, 'новый'), 'незакоммиченное\n');
git(REPO, 'worktree', 'lock', STUCK);
const rmStuck = removeWorktree(REPO, STUCK, 'worktree-a2a-stuck');
check('removal failed — the lock was put back, not left lifted',
  !rmStuck.removed && git(REPO, 'worktree', 'unlock', STUCK).status === 0, JSON.stringify(rmStuck));
check('the refusal reason is non-empty even on an ordinary git refusal',
  typeof rmStuck.error === 'string' && rmStuck.error.length > 0, JSON.stringify(rmStuck.error));
// An empty stderr is not just theory: a git killed by timeout, or one that never started
// at all, leaves no line at all, and the consumer used to print "removal failed: " with no
// reason. We reproduce it directly: a PATH without git, meaning ENOENT and an empty stderr.
check('git never started at all — the reason is still named, not an empty string', (() => {
  const noGit = path.join(SB, 'без-git');
  mkdirSync(noGit, { recursive: true });
  const saved = process.env.PATH;
  process.env.PATH = noGit;
  const r = removeWorktree(REPO, STUCK, 'worktree-a2a-stuck');
  process.env.PATH = saved;
  return !r.removed && typeof r.error === 'string' && r.error.trim().length > 0;
})());
git(REPO, 'worktree', 'remove', '--force', STUCK);
git(REPO, 'branch', '-D', 'worktree-a2a-stuck');

// --- squash merge: no commits in the base, but nothing to merge in ---------------
//
// The check relies on `git merge-tree --write-tree` — that's git 2.38 and newer. We name
// the version in a separate check: otherwise the block fails unintelligibly on old git, and
// the reader has to guess whether it's the logic or the environment.
const gitVer = (git(REPO, '--version').stdout.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const mergeTreeOk = gitVer.length === 2 && (gitVer[0] > 2 || (gitVer[0] === 2 && gitVer[1] >= 38));
check('environment: git supports merge-tree --write-tree (2.38+) — otherwise a squash cannot be recognized',
  mergeTreeOk, git(REPO, '--version').stdout.trim());
//
// A live case: MR !37 of the canon was merged as a squash — master has one commit with all
// the content, while the branch's ten commits are permanently listed as "outside master".
// Checking by ancestry alone is not enough here.
const SQ = path.join(REPO, '.claude', 'worktrees', 'squashed');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-squashed', SQ);
writeFileSync(path.join(SQ, 'sq1'), 'первая часть работы\n');
git(SQ, 'add', '.'); git(SQ, 'commit', '-qm', 'часть 1');
writeFileSync(path.join(SQ, 'sq2'), 'вторая часть работы\n');
git(SQ, 'add', '.'); git(SQ, 'commit', '-qm', 'часть 2');
// Before the squash there is something to merge in — and that needs to be pinned down,
// otherwise the check below would pass green for any reason at all, including "the
// function always answers false".
check('work not yet taken in: there is something to merge — the directory stays',
  inspectWorktree(REPO, SQ, 'master').adds === true
  && worktreeDisposition(inspectWorktree(REPO, SQ, 'master')).action === 'keep',
  JSON.stringify(inspectWorktree(REPO, SQ, 'master')));
// Squash: the branch's content moves into master as one commit, the history does not.
git(REPO, 'merge', '-q', '--squash', 'worktree-a2a-squashed');
git(REPO, 'commit', '-qm', 'squash: работа ветки одним коммитом');
const sq = inspectWorktree(REPO, SQ, 'master');
check('fixture: after the squash, the branch\'s commits are still listed outside master',
  sq.unmerged === 2, String(sq.unmerged));
check('squash merge: the branch adds nothing to the base — the directory is removed',
  sq.adds === false && worktreeDisposition(sq).action === 'remove'
  && /squash/.test(worktreeDisposition(sq).reason), JSON.stringify(worktreeDisposition(sq)));
// Removal goes through the production path: for a squashed branch, `git branch -d` cannot
// see that it is merged (it counts by ancestry), so the directory goes but the branch stays
// — and it must be named, otherwise branches pile up silently.
const rmSq = removeWorktree(REPO, SQ, 'worktree-a2a-squashed');
check('squashed branch: the directory is removed, the branch remains and is named',
  rmSq.removed && rmSq.branchDeleted === false && rmSq.branchStuck === 'worktree-a2a-squashed'
  && rmSq.branchKept === null, JSON.stringify(rmSq));
git(REPO, 'branch', '-D', 'worktree-a2a-squashed');

// A third state: it cannot be merged — a conflict. That is "don't know", and it must
// resolve in favor of "keep", naming the reason.
const CF = path.join(REPO, '.claude', 'worktrees', 'conflict');
git(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-conflict', CF);
writeFileSync(path.join(CF, 'f'), 'версия ветки\n');
git(CF, 'add', '.'); git(CF, 'commit', '-qm', 'своя версия общего файла');
writeFileSync(path.join(REPO, 'f'), 'версия master\n');
git(REPO, 'add', '.'); git(REPO, 'commit', '-qm', 'другая версия того же файла');
const cf = inspectWorktree(REPO, CF, 'master');
check('merge conflict — "don\'t know", not "nothing to merge in"', cf.adds === null, String(cf.adds));
check('uncertainty resolves in favor of "keep", and the reason is named', (() => {
  const d = worktreeDisposition(cf);
  return d.action === 'keep' && /conflict or old git/.test(d.reason);
})(), JSON.stringify(worktreeDisposition(cf)));
git(REPO, 'worktree', 'remove', '--force', CF);
git(REPO, 'branch', '-D', 'worktree-a2a-conflict');

// --- base of a new worktree: local default ahead of origin -----------
//
// The task's central fork: a worker must see commits that a human has not pushed yet. The
// fixture deliberately puts origin/master behind local master — exactly the picture under
// which a past worker never saw the orchestrator's code.
const OLD = git(REPO, 'rev-parse', 'master').stdout.trim();
writeFileSync(path.join(REPO, 'f'), 'незапушенная работа\n');
git(REPO, 'add', '.');
git(REPO, 'commit', '-qm', 'локальный коммит поверх origin');
const AHEAD_SHA = git(REPO, 'rev-parse', 'master').stdout.trim();
git(REPO, 'update-ref', 'refs/remotes/origin/master', OLD);

check('preference order: local default ahead of the origin version',
  defaultRefs(REPO, 'master')[0] === 'master'
  && defaultRefs(REPO, 'master')[1] === 'origin/master', JSON.stringify(defaultRefs(REPO, 'master')));
check('nonexistent refs are not returned', defaultRefs(REPO, 'нет-такой').length === 0);

const FRESH = path.join(REPO, '.claude', 'worktrees', 'fresh');
const madeFresh = createWorktree(REPO, FRESH, 'worktree-a2a-fresh', defaultRefs(REPO, 'master')[0]);
check('a new worktree is created from the local default branch, not from origin/<default>',
  madeFresh.created && !madeFresh.reused
  && git(FRESH, 'rev-parse', 'HEAD').stdout.trim() === AHEAD_SHA,
  `${JSON.stringify(madeFresh)} · expected ${AHEAD_SHA.slice(0, 7)}`);
// The branch point is a sha, not the base's name: a name catches up on someone else's
// commits, while the worker's diff `promptobus review` must be computed from exactly what
// the worker inherited. That is exactly what `master` does in this fixture: origin/master
// sits behind it.
check('createWorktree names the branch point as a sha, not as the base\'s name',
  madeFresh.baseSha === AHEAD_SHA, `${madeFresh.baseSha} vs ${AHEAD_SHA}`);

// Restarting a dead worker at the same address: the branch survived, the directory did not.
// `-b` on such a branch would refuse — the tree must be set up ON it, not next to it.
git(REPO, 'worktree', 'remove', FRESH);
const remade = createWorktree(REPO, FRESH, 'worktree-a2a-fresh', 'master');
check(`the branch survived from a past run — we set up on it, rather than refusing`,
  remade.created && remade.reused === true
  && worktreeBranch(FRESH) === 'worktree-a2a-fresh', JSON.stringify(remade));
// The HEAD of a surviving branch is no longer the branch point: the worker worked on it.
// Passing it off as the point would mean cutting the worker's own work out of the
// reviewer's diff — here it is more honest to say "don't know": only the task journal
// knows such a branch's point.
check('surviving branch: createWorktree does not invent a branch point',
  remade.baseSha === null, String(remade.baseSha));
check('an orphaned registration does not get in the way: the directory was removed by hand — we set it up again', (() => {
  rmSync(FRESH, { recursive: true, force: true });
  const again = createWorktree(REPO, FRESH, 'worktree-a2a-fresh', 'master');
  return again.created && existsSync(FRESH);
})());
git(REPO, 'worktree', 'remove', '--force', FRESH);

// --- the service directory does not dirty the clone --------------------------------
const DIRT = path.join(REPO, '.claude', 'worktrees', 'dirt');
createWorktree(REPO, DIRT, 'worktree-a2a-dirt', 'master');
check('fixture: before exclusion, the service directory shows up as an uncommitted change',
  git(REPO, 'status', '--porcelain').stdout.includes('.claude'),
  git(REPO, 'status', '--porcelain').stdout.trim());
check('after excludeWorktrees, git status does not see the directory',
  excludeWorktrees(REPO).status === 'added'
  && !git(REPO, 'status', '--porcelain').stdout.includes('.claude'),
  git(REPO, 'status', '--porcelain').stdout.trim());
// A tri-state, not a boolean: "already there" and "the write failed" are different
// outcomes, and giving them the same answer used to hide from the human exactly the
// failure this step was set up to catch.
check('a repeat call appends nothing and says so through its own outcome',
  excludeWorktrees(REPO).status === 'present', JSON.stringify(excludeWorktrees(REPO)));
check('the line is marked with its own marker — you can see who put it there',
  readFileSync(path.join(REPO, '.git', 'info', 'exclude'), 'utf8').includes('# promptobus:'));
check('a write failure is its own outcome, with a reason, not a silent "already there"', (() => {
  const notRepo = path.join(SB, 'не-репозиторий');
  mkdirSync(notRepo, { recursive: true });
  const r = excludeWorktrees(notRepo);
  return r.status === 'failed' && typeof r.error === 'string' && r.error.length > 0;
})(), JSON.stringify(excludeWorktrees(path.join(SB, 'не-репозиторий'))));

// The file belongs to someone else: it holds a human's own exclude lines, and it used to
// get rewritten in place. We check both that the foreign lines survive and the
// permissions — `rename` swaps out the whole file.
const EXCL = path.join(SB, 'excl');
mkdirSync(EXCL, { recursive: true });
git(EXCL, 'init', '-q', '-b', 'master');
const exclFile = path.join(EXCL, '.git', 'info', 'exclude');
mkdirSync(path.dirname(exclFile), { recursive: true });
writeFileSync(exclFile, '# строка человека\nмой-мусор/\n');
// `mode` on writeFileSync only takes effect when the file is CREATED, and `git init`
// already laid down its own `info/exclude` — we set the permissions with a separate
// chmod (the same trick as writeSecret).
chmodSync(exclFile, 0o600);
const exclAdded = excludeWorktrees(EXCL);
check('someone else\'s exclude lines survive the append',
  exclAdded.status === 'added'
  && readFileSync(exclFile, 'utf8').includes('мой-мусор/')
  && readFileSync(exclFile, 'utf8').includes('**/.claude/worktrees/'),
  readFileSync(exclFile, 'utf8'));
check('someone else\'s file permissions do not slide to the defaults after the swap',
  (statSync(exclFile).mode & 0o777) === 0o600, (statSync(exclFile).mode & 0o777).toString(8));
check('no temp write file is left behind',
  !readdirSync(path.dirname(exclFile)).some((f) => f.startsWith('.tmp-exclude')),
  readdirSync(path.dirname(exclFile)).join(', '));

// Write atomicity — via a hard link to the previous file. `rename` swaps out the
// directory entry: the old inode, and the link along with it, keeps its previous content.
// Writing in place would also change the link — that is, it would rewrite the file out
// from under whoever is reading it at that moment, and a process death in the middle of it
// would carry away someone else's lines.
const EXCL2 = path.join(SB, 'excl2');
mkdirSync(EXCL2, { recursive: true });
git(EXCL2, 'init', '-q', '-b', 'master');
const excl2File = path.join(EXCL2, '.git', 'info', 'exclude');
mkdirSync(path.dirname(excl2File), { recursive: true });
writeFileSync(excl2File, '# строка человека\n');
const excl2Alias = path.join(SB, 'exclude-до-записи');
linkSync(excl2File, excl2Alias);
check('the write goes through tmp+rename, not over someone else\'s file',
  excludeWorktrees(EXCL2).status === 'added'
  && readFileSync(excl2Alias, 'utf8') === '# строка человека\n'
  && readFileSync(excl2File, 'utf8').includes('**/.claude/worktrees/'),
  readFileSync(excl2Alias, 'utf8'));

// --- git output ceiling -----------------------------------------------
//
// `spawnSync`'s default megabyte cap swaps out the answer on exactly the directory that
// needs it most: a truly dirty worktree exceeds it, the process gets killed, and the clone
// reads as "git did not answer" instead of "has uncommitted changes". The fixture is real:
// five thousand files with long names produce more than a megabyte of `status --porcelain`
// (measured at 1.2 MB, the whole check takes about 0.4 s).
const BIG = path.join(SB, 'big');
mkdirSync(BIG, { recursive: true });
git(BIG, 'init', '-q', '-b', 'master');
writeFileSync(path.join(BIG, 'f'), 'первый\n');
git(BIG, 'add', '.');
git(BIG, 'commit', '-qm', 'первый');
const BIGWT = path.join(BIG, '.claude', 'worktrees', 'big');
git(BIG, 'worktree', 'add', '-q', '-b', 'worktree-a2a-big', BIGWT);
const longName = 'x'.repeat(240);
for (let i = 0; i < 5000; i += 1) writeFileSync(path.join(BIGWT, `${longName}-${i}`), '');
const bigStatus = git(BIGWT, 'status', '--porcelain');
check('fixture: status output exceeds the default megabyte',
  bigStatus.stdout.length > 1024 * 1024, String(bigStatus.stdout.length));
const bigInfo = inspectWorktree(BIG, BIGWT, 'master');
check('a very dirty worktree reads as dirty, not as "git did not answer"',
  bigInfo.dirty === true, JSON.stringify(bigInfo));

// --- session liveness: "alive" versus "stale" -------------------------
// A live background session prints a pid; a record that has outlived its daemon does not
// (captured from a live spawn and stop on claude 2.1.241).
const LIVE = { id: 'a6110205', kind: 'background', pid: 7506, status: 'idle', state: 'done' };
const GHOST = { id: '72c77534', kind: 'background', state: 'blocked' };
check('a record with a pid — alive', sessionLiveness(LIVE, [LIVE, GHOST]) === 'alive');
check('a record without a pid, where pid is otherwise printed — stale',
  sessionLiveness(GHOST, [LIVE, GHOST]) === 'stale', sessionLiveness(GHOST, [LIVE, GHOST]));
check('no record at all — dead', sessionLiveness(null, [LIVE]) === 'dead');
// Self-calibration: a claude build that does not print pid at all must not turn every live
// session into a ghost — no signal means no evidence.
check('nobody prints a pid — the previous behavior, not mass death',
  sessionLiveness({ name: 'x', status: 'running' }, [{ name: 'x', status: 'running' }]) === 'alive');
check('no list passed — also the previous behavior', sessionLiveness({ name: 'x' }) === 'alive');

// The session name is deterministic, and a ghost does not vanish from the list: after
// restarting a worker at the same address, two records sit under one name. Taking the
// first match means handing back the ghost — spawn would report its id, and status would
// call the live one "stale".
const DUP = 'a2a · задача · repo · 0826-1048';
const dupList = [{ id: 'старая', name: DUP, state: 'blocked' }, { id: 'новая', name: DUP, pid: 999, state: 'working' }];
check('two records under one name: the live one is chosen, not the first match',
  findSession(dupList, DUP)?.id === 'новая', JSON.stringify(findSession(dupList, DUP)));
check('no live record among the matches — return what is there, not null',
  findSession([dupList[0], { id: 'x', pid: 7, name: 'другая' }], DUP)?.id === 'старая');

// --- confirming a session's liftoff -------------------------------------
const seenAfter = (n) => { let i = 0; return () => (i++ < n ? [] : [{ id: 'z', name: 'a2a · тест', pid: 5 }]); };
check('spawn: the session did not appear right away — we wait for it, rather than burying it',
  (await awaitSession('a2a · тест', { tries: 3, delayMs: 1, sessions: seenAfter(2) })).state === 'alive');
const ghostOnly = () => [{ id: 'призрак', name: 'a2a · тест', state: 'blocked' }, { id: 'чужой', name: 'другая', pid: 3 }];
const onlyGhost = await awaitSession('a2a · тест', { tries: 2, delayMs: 1, sessions: ghostOnly });
check('spawn: only a ghost sits under the name — that is NOT "raised"',
  onlyGhost.state === 'dead' && onlyGhost.ghost?.id === 'призрак', JSON.stringify(onlyGhost));

check('spawn: no session across every attempt — dead',
  (await awaitSession('a2a · тест', { tries: 2, delayMs: 1, sessions: () => [] })).state === 'dead');
check('spawn: claude agents output was not parsed — unknown, not dead',
  (await awaitSession('a2a · тест', { tries: 2, delayMs: 1, sessions: () => null })).state === 'unknown');
check('spawn: session found — awaitSession returns the record itself, not just the state',
  (await awaitSession('a2a · тест', { tries: 1, delayMs: 1, sessions: seenAfter(0) })).session?.id === 'z');
// Two sources of id need an order, not just presence: parsing `claude --bg` output guesses
// the id from free text, while a record from the session list actually knows it. A
// reversed order would silently write the guessed value into the participant — with a live
// record right there for the taking.
const BG_OUT = 'backgrounded · cafe12 · a2a-worker';
check('spawn: the session id comes from the list, not from parsing output',
  spawnedSessionId({ state: 'alive', session: { id: 'z' } }, BG_OUT) === 'z'
  && parseSessionId(BG_OUT) !== 'z',
  `${spawnedSessionId({ state: 'alive', session: { id: 'z' } }, BG_OUT)} vs ${parseSessionId(BG_OUT)}`);
check('spawn: no list — the id still comes from parsing output, it does not vanish',
  spawnedSessionId({ state: 'unknown', session: null }, BG_OUT) === parseSessionId(BG_OUT),
  String(spawnedSessionId({ state: 'unknown', session: null }, BG_OUT)));

// Review note: the session registry moved into liftoff.js so the two files would not
// import each other. A cycle in ESM is harmless today, and the suite is green with it —
// there is no way to see it except by looking at the imports. So the check is mechanical:
// it is what keeps the boundary going forward, and the price of the cycle is that the very
// first edit reading the other module at the top level will hit a TDZ. The names, though,
// remain available from spawn.js: this very file takes them from there (the import above),
// meaning the re-export is verified by every check in this block.
const liftoffSrc = readFileSync(path.join(here, '..', 'lib', 'liftoff.js'), 'utf8');
check('review note: liftoff.js does not import spawn.js — there is no cycle between them',
  !/^\s*import\s[^;]*from\s+'\.\/spawn\.js'/m.test(liftoffSrc),
  liftoffSrc.split('\n').filter((l) => /from '\.\/spawn\.js'/.test(l)).join(' | ') || 'no imports');

rmSync(SB, { recursive: true, force: true });

// Regression on the local ladder order of the default branch. Run: npm test
//
// Subject — the `localDefault` fallback in [review.js](../lib/review.js). It is reachable in
// one setup: the clone has no origin refs at all (the repository was built with `git init`,
// no remote), and `defaultBranch` gives no name. Then the diff base is guessed from the
// LOCAL branch ladder `['master', 'main']`.
//
// Why the order matters specifically here. Spawn in this setup does not ask the ladder at
// all — it takes `HEAD` as the base and writes the branch point into the journal. The ladder
// is left to the reviewer for the case when the recorded point has nowhere to come from: the
// record was made by a previous CLI, or the branch was rebased. It must guess the very
// branch `HEAD` stood on: if it misses, `merge-base` walks up to the common ancestor, and the
// worker's diff gets someone else's unpushed work pulled back into it, trouble.
//
// The `defaultBranch` ladder (`fresh.js`) is origin-based (`origin/HEAD` →
// `origin/master` → `origin/main`), and in this setup it does not work at all: the two
// ladders have nothing to disagree about in one run. The order is written to match it for a
// different reason — so the two detections read as one rule and the answers do not diverge
// once the clone gets origin refs.
//
// What the checks pin down. The main one is an INVARIANT, not a mechanism: the review base
// equals the commit `worktree add` branched the branch from. It survives a legitimate swap of
// the mechanism (say, to an explicit `HEAD` read), and it catches a reordering of the ladder
// no worse than the branch name does — the guessed branch changes, and the base changes with
// it. The third check reads the branch name straight out of the base line: on a mechanism
// swap only this one goes red, and that's a signal to re-read this file, not a sign of
// breakage.
//
// The file is separate because it needs its own setup: a clone with no origin refs, where
// BOTH local branches exist and sit on different commits. The fixtures in
// promptobus-review.test.mjs do reach the fallback (`rebase-api`, `merged-api`), but each has
// only one local branch — with one branch the ordering is not observable, and reordering to
// `['main', 'master']` leaves them green.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

// realpath: the plan canonicalizes the root (macOS: /var → /private/var), and check
// expectations are compared against the canonical paths. Cleanup is on `makeSandbox`: a
// failing check takes the process down via `process.exit`, and the trailing `rmSync` never
// runs.
const SB = realpathSync(makeSandbox('promptobus-promptobus-ladder-'));
const { planReview } = await import(new URL('../lib/review.js', import.meta.url).href);
const { createStandaloneHost } = await import(new URL('../lib/host.js', import.meta.url).href);

const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// --- workspace: the minimum the plan reads ------------------------------
const WS = path.join(SB, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(path.join(WS, 'AGENTS.md'), 'workspace\n');
writeHostConfig(WS);

// --- clone with no origin refs, both local branches on different commits ------------
//
// `main` stayed on the first commit, `master` moved ahead with the orchestrator's work —
// unpushed, the very thing the base is computed from the LOCAL branch for. The worker's
// branch is founded from `master`, so its branch point is the tip of `master`, and a ladder
// miss onto `main` shows up both in the base and in the contents of the diff.
const REPO = path.join(WS, 'repos', 'loads_search', 'ladder-api');
mkdirSync(REPO, { recursive: true });
g(REPO, 'init', '-b', 'master');
writeFileSync(path.join(REPO, 'AGENTS.md'), 'Правила репозитория.\n');
g(REPO, 'add', '.');
g(REPO, 'commit', '-m', 'init', '-q');
const OLD = g(REPO, 'rev-parse', 'HEAD');
g(REPO, 'branch', 'main', OLD);
writeFileSync(path.join(REPO, 'orkestrator.txt'), 'незапушенная работа оркестратора\n');
g(REPO, 'add', '.');
g(REPO, 'commit', '-m', 'работа оркестратора', '-q');
const FORK = g(REPO, 'rev-parse', 'HEAD');
const WT = path.join(REPO, '.claude', 'worktrees', 'a2a-ladder');
g(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a-ladder', WT, 'master');
writeFileSync(path.join(WT, 'rabota.txt'), `работа worker'а\n`);
g(WT, 'add', '.');
g(WT, 'commit', '-m', 'работа', '-q');

const heads = g(REPO, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n');
const remotes = g(REPO, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/');
check('fixture: the clone has both local branches and no origin ref — the fallback is reachable',
  heads.includes('master') && heads.includes('main') && remotes === '',
  `${heads.join(',')} · remotes=[${remotes}]`);
check('fixture: the branch was founded from master, and its branch point differs from main — the miss is visible',
  FORK !== OLD && g(WT, 'merge-base', 'master', 'HEAD') === FORK
  && g(WT, 'merge-base', 'main', 'HEAD') === OLD, `master=${FORK} main=${OLD}`);

// --- the check itself ------------------------------------------------------------
// Standalone defaultBranch falls back to HEAD when origin refs are absent, which would
// name the worktree branch itself and skip review.js's local ['master','main'] ladder.
// This file pins that ladder, so the host here reports no named default.
const host = createStandaloneHost({ cwd: WS });
host.defaultBranch = () => null;
const plan = planReview(host, { target: WT, title: 'лесенка' });
check(': the review base is the commit worktree add founded the branch from',
  plan.baseRef === FORK, `${plan.baseRef} · founded from ${FORK}, main is at ${OLD}`);
check(': reordering the ladder would bring the orchestrator\'s work back into the diff — it is not there',
  plan.diff.includes('rabota.txt') && !plan.diff.includes('orkestrator.txt'), plan.stat);
check(': the guessed branch is named out loud, and it is master — a direct read of the ladder order',
  /merge-base with master /.test(String(plan.baseLine)), String(plan.baseLine));

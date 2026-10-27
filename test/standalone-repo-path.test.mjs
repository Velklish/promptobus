// Out-of-root and in-root repository paths on the standalone host.
// An outside clone shares the in-root clone's basename, so a resolver that
// keeps only that name would lift the inside repository.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { check } from './check.mjs';
import { expectThrow } from './console.mjs';
import { writeHostConfig } from './sandbox.mjs';

const SB = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-repo-path-')));
const WS = path.join(SB, 'ws');
const INSIDE = path.join(WS, 'orders-api');
const OUTSIDE = path.join(SB, 'orders-api');
const BRIEF = path.join(SB, 'brief.md');

writeHostConfig(WS, { tools: ['claude'] });
writeFileSync(BRIEF, '# Resolve the named clone\n\nEdit the named repository.\n');

const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

function cloneAt(dir) {
  mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'v1\n');
  g(dir, 'add', '.');
  g(dir, 'commit', '-m', 'init', '-q');
}

cloneAt(INSIDE);
cloneAt(OUTSIDE);

const { hostOf } = await import('../lib/host.js');
const { planSpawn } = await import('../lib/spawn.js');
const { planReview } = await import('../lib/review.js');
const host = hostOf(WS);
const root = realpathSync(host.workspaceRoot());
const insideAbs = realpathSync(INSIDE);
const outsideAbs = realpathSync(OUTSIDE);

async function rejection(fn) {
  try {
    await fn();
    return { threw: false, msg: '' };
  } catch (e) {
    return { threw: true, msg: e.message };
  }
}

const outsideSpawn = await rejection(() => planSpawn(WS, {
  repo: outsideAbs, brief: BRIEF, title: 'outside',
}));
check('out-of-root clone: spawn refuses the resolved location',
  outsideSpawn.threw
  && outsideSpawn.msg.includes(outsideAbs)
  && outsideSpawn.msg.includes(root)
  && !/not cloned/.test(outsideSpawn.msg),
  outsideSpawn.msg);

const insideByName = await planSpawn(WS, { repo: 'orders-api', brief: BRIEF, title: 'inside name' });
const insideByPath = await planSpawn(WS, { repo: insideAbs, brief: BRIEF, title: 'inside path' });
check('in-root clone: spawn resolves the named clone',
  insideByName.nsPath === 'orders-api'
  && insideByName.repoAbs === insideAbs
  && insideByPath.nsPath === 'orders-api'
  && insideByPath.repoAbs === insideAbs
  && insideByName.via === 'path on disk'
  && insideByPath.via === 'path on disk',
  `${insideByName.nsPath} ${insideByName.repoAbs} · ${insideByPath.nsPath} ${insideByPath.repoAbs}`);

const outsideReview = expectThrow(() => planReview(WS, { target: outsideAbs, title: 'outside' }));
check('out-of-root clone: review refuses outside the workspace',
  outsideReview.threw
  && outsideReview.msg.includes(outsideAbs)
  && /outside the workspace/.test(outsideReview.msg)
  && !/not cloned/.test(outsideReview.msg),
  outsideReview.msg);

const insideReview = planReview(WS, { target: insideAbs, title: 'inside' });
check('in-root clone: review layout names that clone',
  insideReview.nsPath === 'orders-api' && insideReview.repoDir === insideAbs,
  `${insideReview.nsPath} · ${insideReview.repoDir}`);

const VIA = path.join(SB, 'via-link');
symlinkSync(WS, VIA, process.platform === 'win32' ? 'junction' : 'dir');
const spelled = path.join(VIA, 'orders-api');
const spelledRel = path.relative(root, spelled);
async function planOr(opts) {
  try {
    return await planSpawn(WS, opts);
  } catch (e) {
    return { error: e.message };
  }
}
const viaPlan = await planOr({ repo: spelled, brief: BRIEF, title: 'spelled' });
check('in-root clone: spawn accepts a non-canonical spelling',
  spelled !== insideAbs
  && (spelledRel === '..' || spelledRel.startsWith(`..${path.sep}`) || path.isAbsolute(spelledRel))
  && !viaPlan.error
  && viaPlan.nsPath === 'orders-api'
  && realpathSync(viaPlan.repoAbs) === insideAbs,
  viaPlan.error ?? `${spelledRel} · ${viaPlan.nsPath} ${viaPlan.repoAbs}`);

const DOT = path.join(WS, '..orders-api');
cloneAt(DOT);
const dotRel = path.relative(root, DOT);
const dotPlan = await planOr({ repo: DOT, brief: BRIEF, title: 'dot name' });
const dotInside = dotRel.startsWith('..') && dotRel !== '..' && !dotRel.startsWith(`..${path.sep}`);
check('in-root clone: spawn accepts a directory name that starts with ..',
  dotInside
  && !dotPlan.error
  && dotPlan.nsPath === '..orders-api'
  && realpathSync(dotPlan.repoAbs) === realpathSync(DOT),
  dotPlan.error ?? `${dotRel} · ${dotPlan.nsPath} ${dotPlan.repoAbs}`);

let dotReview;
try {
  dotReview = planReview(WS, { target: DOT, title: 'dot name' });
} catch (e) {
  dotReview = { error: e.message };
}
check('in-root clone: review names a directory that starts with ..',
  dotInside
  && !dotReview.error
  && dotReview.nsPath === '..orders-api'
  && dotReview.repoDir === realpathSync(DOT),
  dotReview.error ?? `${dotReview.nsPath} · ${dotReview.repoDir}`);

const viaHost = hostOf(VIA);
const viaClone = viaHost.cloneOf(insideAbs);
check('via-link install root: cloneOf returns the canonical clone',
  path.resolve(VIA) !== root
  && viaHost.workspaceRoot() === root
  && viaClone
  && viaClone.abs === insideAbs
  && viaClone.nsPath === 'orders-api',
  viaClone ? `${viaHost.workspaceRoot()} · ${viaClone.abs}` : 'no clone');

async function planAt(at, opts) {
  try {
    return await planSpawn(at, opts);
  } catch (e) {
    return { error: e.message };
  }
}
const viaSpawn = await planAt(VIA, { repo: 'orders-api', brief: BRIEF, title: 'via root' });
check('via-link install root: spawn resolves the clone under the canonical root',
  !viaSpawn.error
  && viaSpawn.nsPath === 'orders-api'
  && viaSpawn.repoAbs === insideAbs,
  viaSpawn.error ?? `${viaSpawn.nsPath} ${viaSpawn.repoAbs}`);

let viaMain;
try {
  viaMain = planReview(VIA, { target: INSIDE, title: 'via main' });
} catch (e) {
  viaMain = { error: e.message };
}
check('via-link install root: review of the main checkout is not a worktree',
  !viaMain.error
  && viaMain.repoDir === insideAbs
  && !/merge-base/.test(String(viaMain.baseLine))
  && !(viaMain.warnings ?? []).some((line) => /HEAD of this branch matches/.test(line)),
  viaMain.error ?? viaMain.baseLine);

const WT = path.join(INSIDE, 'worker-tree');
g(INSIDE, 'worktree', 'add', '-b', 'worker', WT);
let viaWork;
try {
  viaWork = planReview(VIA, { target: WT, title: 'via worktree' });
} catch (e) {
  viaWork = { error: e.message };
}
const wtAbs = realpathSync(WT);
check('via-link install root: review of a worker worktree names that worktree',
  !viaWork.error
  && viaWork.repoDir === wtAbs
  && viaWork.repoDir !== insideAbs
  && /merge-base/.test(String(viaWork.baseLine)),
  viaWork.error ?? `${viaWork.repoDir} · ${viaWork.baseLine}`);

// Regression test for a live reviewer on the Promptobus bus. Run: npm test
//
// Subject — the review plan: everything computed before the `claude --bg` exec — the
// address and task, the module's review-skill resolve, the prompt and its read-only
// invariants, the diff path, the re-review branch to the same address. The exec itself
// is not under test: it raises a live session.
//
// **Names like `a2a-…` in fixtures are left in on purpose**: that's what the previous
// CLI called branches, worktree directories, and sessions, and they check that the hard
// rename didn't break what was already established. Details are in
// `promptobus.test.mjs`, the file's header comment.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { stubCommand, writeHostConfig } from './sandbox.mjs';
import { capture, expectThrow } from './console.mjs';
import { check } from './check.mjs';

// realpath: the scheduler canonicalizes the root (macOS: /var → /private/var), and the
// test's expectations must be compared against canonical paths.
const SB = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-promptobus-review-')));
const here = path.dirname(fileURLToPath(import.meta.url));
const reviewUrl = new URL('../lib/review.js', import.meta.url).href;
const { planReview, review, denyToolsRefusal, writeDiff } = await import(reviewUrl);
// The harness's vocabulary comes from the driver's home: effort levels, the variables
// stripped from the raised session, and the list of stripped tools — that one is its
// own, not the bus's.
const { EFFORT_LEVELS, REVIEWER_DENY, SESSION_ENV_DROP } = await import(path.join(here, '..', 'lib', 'driver-claude.js'));
const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));
const { GUARD_HOOK_EVENT, guardHookCommand } = await import(path.join(here, '..', 'dist', 'hooks.js'));
// The participant file path under `workers/` — in the journal, next to `workersDir`:
// spawn, review, and cleanup all compute it, and it's the only thing shared by these
// three.


// --- workspace: base, a module with a review skill, a skills plugin, a live git clone ---

const WS = path.join(SB, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(path.join(WS, 'AGENTS.md'), 'workspace\n');
writeHostConfig(WS, { tools: ['claude', 'cursor', 'codex'] });
mkdirSync(path.join(WS, '.claude'), { recursive: true });
writeFileSync(path.join(WS, '.claude', 'settings.json'), JSON.stringify({
  skillOverrides: { 'ненужный-скилл': 'off' },
}, null, 2));

const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
// The workspace root is a git repository itself, like in real life: without this, a
// group folder inside repos/ would not reproduce the toplevel walking up to the root.
//
// The standalone host's `cloneOf` descends from the workspace root — there is
// no dest-owned `repos/` layout. This file plants `WS/repos/<group>/<clone>` as
// fixture data so that walk finds a nested tree. Expected `nsPath` values therefore
// start with the planted `repos/` segment; that is not a dest default.
g(WS, 'init', '-b', 'main');
const REPO = path.join(WS, 'repos', 'loads_search', 'cargos-api');
mkdirSync(REPO, { recursive: true });
g(REPO, 'init', '-b', 'main');
writeFileSync(path.join(REPO, 'AGENTS.md'), 'Правила репозитория.\n');
writeFileSync(path.join(REPO, 'a.txt'), 'v1\n');
g(REPO, 'add', '.');
g(REPO, 'commit', '-m', 'init', '-q');
// Origin refs, like a real clone: `git clone` sets both `origin/<default>` and
// `origin/HEAD` pointing at it. Default-branch detection reads `origin/HEAD` first and
// stops there; without the refs it walks a ladder of candidates — five `git` processes
// — while with the refs the plan pays for one more `merge-base`: two processes instead
// of five per plan, and there are more than forty plans against this clone in the file.
// After this, the `detectBase` ladder is exercised by `CLEAN` and `SUB` (both → null),
// `no-local-default` (→ origin/main) and `flood-api` (→ origin/master); the
// `baseRef === null` branch by `CLEAN` and `SUB`; the reachability of the
// `['master','main']` fallback in `localDefault` by `rebase-api` and `merged-api`, with
// the order within it covered by promptobus-review-ladder.test.mjs (here both have one
// local branch each); `dual-default` exercises the `defaultBranch` ladder from
// fresh.js (`origin/HEAD` → `origin/master`).
g(REPO, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
g(REPO, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
writeFileSync(path.join(REPO, 'a.txt'), 'v2\n');
writeFileSync(path.join(REPO, 'new.txt'), 'новый файл\n');

// --- first call: spawn the reviewer ---------------------------------------------

const unnamed = expectThrow(() => planReview(WS, { target: REPO }));
check('new task: without --title, a clear refusal naming the flag',
  unnamed.threw && /opens a new task/.test(unnamed.msg) && /--title/.test(unnamed.msg), unnamed.msg);
const blankTitle = expectThrow(() => planReview(WS, { target: REPO, title: '  ' }));
check('new task: a blank --title doesn\'t count as a name either',
  blankTitle.threw && /--title/.test(blankTitle.msg), blankTitle.msg);

// The name gate doesn't take away the command's cheapest move: on a clean clone the
// "no changes — nothing to review" answer comes before any requirement for a name,
// because in this case no task is opened at all (review note on ).
const CLEAN = path.join(WS, 'repos', 'loads_search', 'clean-api');
mkdirSync(CLEAN, { recursive: true });
g(CLEAN, 'init', '-b', 'main');
writeFileSync(path.join(CLEAN, 'a.txt'), 'v1\n');
g(CLEAN, 'add', '.');
g(CLEAN, 'commit', '-m', 'init', '-q');
// We catch the refusal ourselves: the gate, returning above the diff computation, throws
// from planReview, and without a catch the check wouldn't fail red — it would drop the
// whole file, and that diagnosis is more expensive.
let cleanOut = '';
let cleanThrew = null;
try {
  cleanOut = await capture(() => review(WS, { target: CLEAN }));
} catch (e) {
  cleanThrew = e.message;
}
check('clean clone without --title: answers "no changes — nothing to review" instead of demanding a name',
  !cleanThrew && /nothing to review/.test(cleanOut) && !/--title/.test(cleanOut),
  cleanThrew ?? cleanOut.slice(-400));

// : a name that doesn't survive transliteration (CJK, emoji, punctuation only) used to
// give an "it has no name" refusal on a command where --title WAS named. The person
// called it again with the same name and got the same refusal. The name is named — the
// task is opened, the id stays a machine stamp (its legitimate form), and the name
// itself isn't lost.
// We catch the refusal ourselves, with the same trick as the clean clone above: the
// gate throws from planReview, and without a catch the check wouldn't fail red — it
// would drop the whole file.
let cjk = null;
let cjkErr = '';
try { cjk = planReview(WS, { target: REPO, title: '日本語の作業' }); } catch (e) { cjkErr = e.message; }
check(': a name without Latin letters no longer cancels the task — the "it has no name" refusal is gone',
  // There's no slug in the journal at all, not `null`: the journal carries no empty fields.
  !!cjk && cjk.createNew?.title === '日本語の作業' && cjk.createNew.adapter.slug === undefined,
  cjkErr || JSON.stringify(cjk?.createNew));
check(': the id of such a task is a machine stamp, and that is said out loud, not silently',
  !!cjk && /^t\d{8}-\d{6}$/.test(cjk.taskId)
  && (cjk.warnings ?? []).some((w) => w.includes('日本語の作業') && /machine stamp/.test(w)),
  cjkErr || `${cjk?.taskId} · ${(cjk?.warnings ?? []).join(' | ')}`);
check(`: the name went entirely into the reviewer's session name`,
  !!cjk && cjk.name.includes('日本語の作業'), cjkErr || String(cjk?.name));

// --- : the path is required, there is no resolve by cwd ------------------------------
//
// The shape of the refusal is half the decision, so what's checked isn't just the fact
// of the refusal but its text: the repository is named, the ready-made command is
// printed exactly where the next gate would accept it, and it carries the same flags.
//
// A clone right under repos/ (without a group) is a legitimate fixture: the "expected
// repos/<group>/<repo>" gate rejects such a target, and there should be no ready-made
// command for it.
const LONELY = path.join(WS, 'repos', 'lonely-api');
mkdirSync(LONELY, { recursive: true });
g(LONELY, 'init', '-b', 'main');

const cwd0 = process.cwd();
let noTarget;
let noTargetDry;
let noTargetFlags;
let outsideRepos;
let shallowClone;
let notARepo;
try {
  process.chdir(REPO);
  noTarget = expectThrow(() => planReview(WS, {}));
  noTargetDry = expectThrow(() => planReview(WS, { dryRun: true }));
  noTargetFlags = expectThrow(() => planReview(WS, { task: 'нет-такой', title: 'моя работа', dryRun: true }));
  process.chdir(WS);
  outsideRepos = expectThrow(() => planReview(WS, {}));
  process.chdir(LONELY);
  shallowClone = expectThrow(() => planReview(WS, {}));
  // The third shape of refusal — the current directory isn't in a git repository at
  // all (a sandbox outside the workspace). Run in this same process: with the path
  // gate removed, the call goes into `resolveRepoDir`, and that one, with , returns
  // the refusal as a field and doesn't carry the process away — a mutation fails the
  // check with an honest ✖, not the whole file past the verdict summary.
  process.chdir(SB);
  notARepo = expectThrow(() => planReview(WS, {}));
} finally {
  process.chdir(cwd0);
}

// The helper's refusal — as a value, not a process exit. Checked directly: a non-git
// target passes the path gate and goes into `resolveRepoDir`, and that one returns
// `refusal`. It used to call `fail()`, and a separate process for the neighboring check
// was built on that.
const NOT_A_REPO = path.join(SB, 'ne-repozitorij');
mkdirSync(NOT_A_REPO, { recursive: true });
const notGit = planReview(WS, { target: NOT_A_REPO });
check(': a non-git target — the plan returns a refusal as a field instead of killing the process',
  notGit.refusal === `${NOT_A_REPO}: not a git repository`, JSON.stringify(notGit.refusal ?? null));
check(': without a path the command refuses instead of taking the current directory',
  noTarget.threw && /repository path is required/.test(noTarget.msg)
  && /There is no resolve from the current directory/.test(noTarget.msg), noTarget.msg);
// It must specifically name the "repository": cwdRepo returns the git toplevel, and
// from repos/<group>/<repo>/src a person would read about a directory they aren't
// standing in.
check(': the refusal names the current directory\'s repository and prints a ready-made command with it',
  noTarget.msg.includes('The repository of the current directory is repos/loads_search/cargos-api')
  && noTarget.msg.includes(`promptobus review "${REPO}"`), noTarget.msg);
check(': the call\'s flags go into the hint — the repeat costs saying them once',
  noTargetFlags.threw
  && noTargetFlags.msg.includes(`promptobus review "${REPO}" --task нет-такой --title "моя работа" --dry-run`),
  noTargetFlags.msg);
check(': --dry-run doesn\'t cancel the path requirement — the gate comes before the plan',
  noTargetDry.threw && /repository path is required/.test(noTargetDry.msg), noTargetDry.msg);
check(': cwd at the workspace root — a refusal with no ready-made command (toplevel workspace)',
  outsideRepos.threw && /outside the workspace/.test(outsideRepos.msg)
  && !outsideRepos.msg.includes('repeat with it'), outsideRepos.msg);
check(': a clone sitting directly on the workspace disk — the refusal names the path and a ready-made command',
  shallowClone.threw && /repository path is required/.test(shallowClone.msg)
  && shallowClone.msg.includes('repeat with it'), shallowClone.msg);
check(': a directory outside git — a refusal with no ready-made command',
  notARepo.threw && /not in a git repository/.test(notARepo.msg)
  && !notARepo.msg.includes('repeat with it'), notARepo.msg);
const plan = planReview(WS, { target: REPO, title: 'работа оркестратора в cargos-api' });
check(`plan: the reviewer's address comes from the repository name`, plan.address === 'reviewer:cargos-api', plan.address);
check('plan: the task is opened with the name the person gave it',
  plan.createNew?.id === plan.taskId && plan.createNew.title === 'работа оркестратора в cargos-api',
  plan.createNew?.title);
// The name also produces the slug: the person copies the task id into wait and
// re-review commands, and it becomes readable together with the name.
check('plan: the name went into the task slug, the id is readable',
  plan.createNew.adapter.slug === store.slugify(plan.createNew.title)
  && plan.taskId.startsWith(`${plan.createNew.adapter.slug}-t`), `${plan.createNew.adapter.slug} · ${plan.taskId}`);
check('plan: the diff is not empty and includes what is uncommitted',
  /a\.txt/.test(plan.diff) && plan.untracked.includes('new.txt'), plan.untracked.join(','));
// The title goes into the session name, and the tail carries a short stamp: the raw id
// there used to read as fifteen technical characters instead of a date and time.
check(`reviewer's session name: role as the first word, task name, short stamp in the tail`,
  /^Review: работа оркестратора в cargos-api \(\d{4}-\d{4}\)$/.test(plan.name)
  && plan.argv[plan.argv.indexOf('--name') + 1] === plan.name, plan.name);
// The reviewer is raised without its own worktree — the subject of the review sits in
// someone else's tree, and it doesn't need a machine name at all: `--name` checks
// neither spaces nor length.
check('reviewer: no worktree is opened, it doesn\'t need a machine name',
  !plan.argv.includes('--worktree') && plan.name.startsWith('Review: '), plan.argv.join(' '));
// The same lever as the worker's: the memory gate is unenforceable for a background
// session — there's no one there to confirm a candidate. The environment lives in the
// plan, otherwise `--dry-run` stays silent about it. The ancestor's leaking variables
// are stripped from both participants by one function: if the environment assembly for
// the worker and the reviewer diverged, two background sessions of the same run would
// come up with different environments.
check(`reviewer's environment: the ancestor's leaking variables are stripped`,
  SESSION_ENV_DROP.every((k) => !(k in plan.env))
  && Object.keys(process.env).filter((k) => !SESSION_ENV_DROP.includes(k)).every((k) => k in plan.env),
  Object.keys(plan.env).filter((k) => SESSION_ENV_DROP.includes(k)).join(','));
// : there's no bus identity in the reviewer's session environment — by the same
// function and for the same reason as the worker's. The harness hands the background
// session its environment from the run's first spawn, and the triple placed here would
// have gone to the neighbors. The Stop hook reads the identity, and it arrives as
// command arguments in the settings file (below).
check(`reviewer's environment: there's no bus identity in it`,
  ['PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK', 'PROMPTOBUS_HOME'].every((k) => !(k in plan.env)),
  JSON.stringify({ role: plan.env.PROMPTOBUS_ROLE, task: plan.env.PROMPTOBUS_TASK, home: plan.env.PROMPTOBUS_HOME }));
check('plan: the diff goes into the task\'s artifacts',
  plan.diffPath === path.join(WS, '.promptobus', 'tasks', plan.taskId, 'files', 'review-cargos-api.diff'),
  plan.diffPath);
check('plan: the standalone host does not resolve a module review skill',
  plan.skill == null, JSON.stringify(plan.skill));
check('prompt: the repository is named, there is no foreign module layout',
  plan.prompt.includes(path.join(REPO, 'AGENTS.md')));
check('prompt: the standalone host does not add team-memory tools',
  !plan.prompt.includes('search_facts'));
// The reviewer gets the whole canon, and every name is pre-approved: there will be no
// permission request, there's no human behind the session, and the deny list does not
// cover writing MCP tools — it's about Edit/Write/NotebookEdit/Bash/WebFetch/WebSearch.
// The boundary here is held by the prompt, and it must be named in it, not implied
// (review note 2026-08-28).
check('prompt: external-system MCP is read-only only — the boundary is held by the reviewer itself',
  plan.prompt.includes('read-only')
  && /Do not create, change, delete or publish/.test(plan.prompt)
  && plan.prompt.includes('pre-approved'));
check('prompt: standalone host — there is no team-memory section',
  !plan.prompt.includes('`search_facts`') && !plan.prompt.includes('`save_fact`'));
// : the reviewer has nothing to wait with and doesn't need to — the warden wakes it.
// A gate paired with the worker's (promptobus.test.mjs): the participant's prompt sits
// in its context always, so a surviving "wait" there outlives any rule removed
// elsewhere.
check(': the reviewer\'s prompt does not instruct opening a wait — there\'s one alarm clock per task',
  /nothing to wait with/.test(plan.prompt) && !/\bpromptobus wait\b/.test(plan.prompt)
  && /listened to by the bus warden/.test(plan.prompt), plan.prompt);

// : the same norm as the worker's, adjusted for the reviewer's toolset — it has no
// background command at all, it declares a review that's dragging on.
check(': the prompt requires announcing dragging-on work with a status carrying a time estimate',
  /Work stretches past a couple of minutes of silence/.test(plan.prompt) && /time estimate/.test(plan.prompt),
  plan.prompt);
check('prompt: mechanical checks are declared unavailable; standalone procedure without a skill',
  plan.prompt.includes('were not run')
  && /No findings/.test(plan.prompt)
  && !plan.prompt.includes('report only'));
check('prompt: rules — repository (standalone: without a workspace module)',
  plan.prompt.includes(path.join(REPO, 'AGENTS.md')) && !plan.prompt.includes(['.', 'agents/base/rules'].join('')));
check('read-only: deny overrides writing and executing',
  ['Edit', 'Write', 'NotebookEdit', 'Bash'].every((t) => plan.settings.permissions.deny.includes(t))
  && plan.settings.permissions.deny === REVIEWER_DENY);
// : read-only isn't a wish, it's a capability of the driver. A harness unable to strip
// tools would raise the reviewer with write access to the tree under review, so the
// refusal stands BEFORE the raise and before any write to disk. There's no live driver
// without `denyTools` in the map, and the branch is checked with a stand-in object —
// the same trick as `restampOutcome`.
const denyLess = denyToolsRefusal({ id: 'bezrukiy', capabilities: { denyTools: false } });
check(': a harness without denyTools does not raise a review — the refusal names the harness and the reason',
  typeof denyLess === 'string' && denyLess.includes('bezrukiy')
  && /cannot strip/.test(denyLess) && /would write/.test(denyLess), String(denyLess));
check(': a driver with denyTools declared has no refusal',
  denyToolsRefusal(plan.driver) === null, String(denyToolsRefusal(plan.driver)));
// : the reviewer's file names under `workers/` are the same seam that cleanup
// (`promptobus done`) uses to remove them. If the plan and the cleanup diverged, the
// reviewer's config with substituted tokens would stay on disk forever, and silently:
// `done` would report success.
check(`: the reviewer's config path is derived from its address, not assembled separately`,
  plan.mcpConfigPath === store.participantMcpPath(store.promptobusHome(WS, hostOf(WS)), plan.taskId, plan.address)
  && plan.settingsPath === store.participantSettingsPath(store.promptobusHome(WS, hostOf(WS)), plan.taskId, plan.address)
  && path.basename(plan.mcpConfigPath).startsWith('reviewer-'),
  `${path.basename(plan.mcpConfigPath)} · ${path.basename(plan.settingsPath)}`);
check('settings: the repository\'s MCP servers are enabled without an interactive dialog',
  plan.settings.enableAllProjectMcpServers === true);
check(`settings: the compact transcript view, same as the worker's`,
  plan.settings.viewMode === 'focus', JSON.stringify(plan.settings));
check('argv: settings and the bus are declared, the prompt comes last',
  plan.argv.includes('--settings') && plan.argv[plan.argv.indexOf('--settings') + 1] === plan.settingsPath
  && plan.argv[plan.argv.indexOf('--allowedTools') + 1] === 'mcp__promptobus'
  && plan.argv[plan.argv.length - 1] === plan.prompt, plan.argv.slice(0, -1).join(' '));
// The reviewer's skill canon arrives as a plugin directory for one session, without an
// install: its own review procedure arrives as a module skill, and the rules require
// from it the same skills as from the worker. The former channel (enabledPlugins in the
// settings file) forced Claude Code to install the plugin at user scope — there is no
// project install for a background session's directory.
check('argv: standalone — there is no plugin directory',
  plan.pluginDir == null && !plan.argv.includes('--plugin-dir'), String(plan.pluginDir));
check(`reviewer's settings: there are no plugin-install keys in the participant file`,
  plan.settings.enabledPlugins === undefined && plan.settings.extraKnownMarketplaces === undefined,
  JSON.stringify(plan.settings));
check(`reviewer's settings: personal skill duplicates are suppressed by name`,
  plan.settings.skillOverrides?.['ненужный-скилл'] === 'off', JSON.stringify(plan.settings));
// The reviewer's MCP set equals the worker's set (owner decision 2026-08-28).
// Read-only is held by a deny list on editing the working copy, not by a poor toolset.
const rsrv = plan.mcpConfig.mcpServers;
check(`mcp-config reviewer's: the bus is there, the externally-authorized ATI canon isn't`,
  rsrv['promptobus'] !== undefined && rsrv['teamly-mcp'] === undefined
  && rsrv['memory-hooks'] === undefined,
  JSON.stringify(Object.keys(rsrv)));
const rallowed = plan.argv.slice(plan.argv.indexOf('--allowedTools') + 1, plan.argv.indexOf('--add-dir'));
check('argv: every delivered server is pre-approved — the reviewer is raised without --permission-mode',
  Object.keys(rsrv).every((n) => rallowed.includes(`mcp__${n}`))
  && rallowed.length === Object.keys(rsrv).length, rallowed.join(' '));
// The state of affairs on the module — a line next to the rules listing.
check('module signal: standalone — the workspace module does not apply',
  plan.module.level === 'info' && /workspace module does not apply — standalone host/.test(plan.module.text),
  plan.module.text);
check('argv: the default model is opus', plan.argv[plan.argv.indexOf('--model') + 1] === 'opus');
// The base rules sit outside the copy under review, and reading outside Claude Code's
// working directory asks for permission: without --add-dir the reviewer would stall on
// the very first rules read, and no one would wait for a report. This doesn't open up
// writing — that's removed by the deny list.
const reviewAddDir = plan.argv.indexOf('--add-dir');
// : the diff sits in the task's artifacts — outside the reviewer's working directory
// and outside the rule directories. Per the access model recorded in this same file,
// reading from there requires permission that no one in a bg session can answer, and
// the prompt's very first instruction is exactly "read it in full".
check(': the diff directory is opened with --add-dir alongside the rule directories',
  plan.argv.includes(path.dirname(plan.diffPath))
  && plan.argv.indexOf(path.dirname(plan.diffPath)) > plan.argv.indexOf('--add-dir'),
  plan.argv.slice(plan.argv.indexOf('--add-dir'), plan.argv.indexOf('--add-dir') + 6).join(' '));

check('argv: rule directories are opened with --add-dir — the reviewer will not stall reading the rules',
  reviewAddDir > 0 && plan.ruleDirs.length > 0
  && plan.ruleDirs.every((d, i) => plan.argv[reviewAddDir + 1 + i] === d),
  plan.ruleDirs.join(', '));
check(`mcp-config: the reviewer's identity is in env`,
  plan.mcpConfig.mcpServers['promptobus'].env.PROMPTOBUS_ROLE === plan.address
  && plan.mcpConfig.mcpServers['promptobus'].env.PROMPTOBUS_TASK === plan.taskId);

// --- reviewer effort: mirrors the spawn contract ----------------

check('command: without --effort the session is raised at the default effort — no flag in argv',
  plan.effort === null && !plan.argv.includes('--effort'));
// The reviewer's permission mode: without the flag — the binary's mode, the flag goes
// into argv for one raise.
check(': without --permission-mode the reviewer goes on the binary\'s mode — no flag in argv',
  plan.permissionMode === null && !plan.argv.includes('--permission-mode'), plan.argv.join(' '));
let withMode;
await capture(async () => {
  withMode = await review(WS, { target: REPO, title: 'работа оркестратора в cargos-api', dryRun: true, permissionMode: 'acceptEdits' });
});
check(': the reviewer\'s --permission-mode goes into the session\'s argv',
  withMode.permissionMode === 'acceptEdits' && withMode.argv[withMode.argv.indexOf('--permission-mode') + 1] === 'acceptEdits',
  withMode.argv.slice(-6).join(' '));

// The plan for `--effort high` is computed once for three checks: `review()` returns
// the same plan as `planReview()` (`dryRun` is the input for the "repository path is
// required" refusal, it doesn't affect the computed plan), and computing it again would
// cost a dozen `git` processes . The same trick below pairs up "plan + its own
// --dry-run".
let withEffort;
const dryEffort = await capture(async () => {
  withEffort = await review(WS, { target: REPO, title: 'работа оркестратора в cargos-api', dryRun: true, effort: 'high' });
});
check(`command: the reviewer's --effort is passed to the session right after --model <value>`,
  withEffort.effort === 'high'
  && withEffort.argv[withEffort.argv.indexOf('--effort') + 1] === 'high'
  && withEffort.argv.indexOf('--effort') === withEffort.argv.indexOf('--model') + 2
  && withEffort.argv.at(-1) === withEffort.prompt, withEffort.argv.slice(-6).join(' '));

for (const level of EFFORT_LEVELS) {
  const p = level === 'high'
    ? withEffort
    : planReview(WS, { target: REPO, title: 'работа оркестратора в cargos-api', effort: level });
  check(`--effort: value "${level}" accepted`, p.effort === level);
}

const badEffort = expectThrow(() => planReview(WS, { target: REPO, title: 'работа оркестратора в cargos-api', effort: 'super-high' }));
check('--effort: unknown value → a clear refusal, not a silent default',
  badEffort.threw && /--effort: unknown value/.test(badEffort.msg) && badEffort.msg.includes('super-high')
  && EFFORT_LEVELS.every((l) => badEffort.msg.includes(l)), badEffort.msg);

check('dry-run: the given effort is printed as being applied',
  /effort: high/.test(dryEffort) && !/effort: high \(not applied/.test(dryEffort), dryEffort);
check(`dry-run without a live reviewer: the model is also printed as being applied`,
  /model: opus/.test(dryEffort) && !/model: opus \(/.test(dryEffort), dryEffort);

// --- re-review: the same address, but only into a live session ----------------
//
// The scheduler checks the reviewer's liveness via `claude agents --json` — the binary
// is replaced with a PATH fake: the test doesn't need a live claude, but it does need to
// set the session's state.
const BIN = path.join(SB, 'bin');
mkdirSync(BIN, { recursive: true });
const PATH0 = process.env.PATH;
// Spawn goes through the same fake and it records its own argv: the last argument
// there is the prompt, and only from it can you see WHAT went to the raised reviewer —
// the plan's static fields say nothing about the chosen branch.
//
// The fake's script is in JS, via the sandbox's shared helper (sandbox.mjs): a
// `#!/bin/sh` without an extension isn't found at all on Windows, and the test would
// fail red there even with correct code . `claudeSays` takes what the fake PRINTS; a
// refusal is a separate call.
const BG_ARGV = path.join(SB, 'bg-argv.txt');
// Raising the reviewer is checked against the `claude agents` list: "backgrounded"
// without the session in the list no longer counts as success. So the fake answers
// `agents` differently before and after `--bg` — exactly like a live claude, where the
// session appears in the list only once launched. The fake takes the raised session's
// name from `--name`, i.e. from the same place claude takes it; the scenario
// (`claudeSays`, `claudeFails`) resets the previous raise — otherwise it would carry
// over into the next branch of the test.
const BG_RAISED = path.join(SB, 'bg-raised.txt');
const claudeStub = (body) => {
  stubCommand(BIN, 'claude', `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--bg') {
  writeFileSync(${JSON.stringify(BG_ARGV)}, args.join('\\n'));
  // STUB_SILENT_FAIL — a silent daemon failure: "backgrounded", code 0, no session.
  // Observed live and is the sole reason the raise check was set up at all.
  if (!process.env.STUB_SILENT_FAIL) writeFileSync(${JSON.stringify(BG_RAISED)}, args[args.indexOf('--name') + 1] ?? '');
}
if (args[0] === 'agents' && existsSync(${JSON.stringify(BG_RAISED)})) {
  const raised = readFileSync(${JSON.stringify(BG_RAISED)}, 'utf8');
  // STUB_GHOST — a record of a past session sits under the name, having outlived its
  // daemon: the name matches, there's no pid, while the neighboring record has one
  // (sessionLiveness self-calibration).
  process.stdout.write(JSON.stringify(process.env.STUB_GHOST
    ? [{ id: 'ghost1', name: raised, state: 'blocked' }, { id: 'alive9', name: 'Worker: чужой', pid: 4242 }]
    : [{ id: 'sess-live', name: raised, status: 'running' }]));
  process.exit(0);
}
${body}`);
  rmSync(BG_RAISED, { force: true });
  process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
};
const claudeSays = (out) => claudeStub(`process.stdout.write(${JSON.stringify(out)});`);
const claudeFails = () => claudeStub('process.exit(1);');
const bgArgv = () => (existsSync(BG_ARGV) ? readFileSync(BG_ARGV, 'utf8') : '');

const home = path.join(WS, '.promptobus');
const task = store.createTask(home, { id: 't20260824-100000', title: 'ревью loads_search/cargos-api' });
const SESSION = 'a2a-t20260824-100000-reviewer-cargos-api';
store.upsertParticipant(home, task.id, store.participantRecord('reviewer:cargos-api', { repo: 'loads_search/cargos-api', name: SESSION }));
writeFileSync(path.join(store.filesDir(home, task.id), 'review-cargos-api.diff'), 'старый дифф\n');

claudeSays(JSON.stringify([{ name: SESSION, status: 'running' }]));

// Resolving the binary isn't the subject of the branches below: "exactly which claude
// raised the reviewer" is checked by its own `tool`, while PATH search and version
// parsing are tools.test.mjs's. Every resolve runs `claude --version`, i.e. one more
// node start with the stand-in binary at a cost of about 71 ms; for the dozen runs that
// reach it, that's 0.85s of CPU. There are more runs in the file, but a re-review
// doesn't resolve the binary at all — the gate sits under `if (!plan.reuse)`, and the
// reuse branch returns before the second call. We ask once and hand out the answer
// through the `tool` seam declared for this by review() itself.
//
// `deadOut` below stays seamless — a run whose result feeds the "dead session: the new
// reviewer got the full prompt" checks and the ones after it. Return the wrong resolve
// (mutation probe 2026-08-31: a path to a nonexistent binary instead of the found one)
// and the file fails right at this call — "the binary vanished between the check and
// the launch". Three more runs go as separate processes (`liftoffRun` and the run with
// `FAIL_TITLE`), and the seam isn't passed there at all: each resolves the binary itself.
const TOOL = { ok: true, bin: path.join(BIN, 'claude') };

// Whether the live session gets a re-review specifically is decided by review() from
// plan.reuse — the plan's field says nothing about it: `prompt` and `reReview` are both
// always present in the plan. The plan is taken from this same call: there's no point
// computing it a second time.
let again;
const dryReuse = await capture(async () => { again = await review(WS, { target: REPO, task: task.id, dryRun: true }); });
check(`re-review: session is alive — the participant is found, there will be no second spawn`,
  !!again.participant && again.sessionState === 'alive' && again.reuse === true, again.sessionState);
check('re-review: a live session gets a re-review — about the new diff, without re-onboarding',
  dryReuse.includes(again.reReview) && !dryReuse.includes('## Communication protocol')
  && again.reReview.includes('Re-review') && again.reReview.includes(again.diffPath), dryReuse);
check('re-review: the old diff isn\'t overwritten — the name gets a number',
  again.diffPath.endsWith('review-cargos-api-2.diff'), again.diffPath);

// : the record itself claims the name, not a check before it. Previously a free name
// was searched for by an `existsSync` loop, and the caller wrote it — between the check
// and the write, a second review of the same slug could sneak in and overwrite the diff
// the live reviewer might be reading right at that moment. The race can't be reproduced
// from inside one command (nothing foreign happens between the plan and its write), so
// the write itself is checked.
const RACE = path.join(SB, 'race-artifacts');
const firstDiff = writeDiff(RACE, 'gonka', 'дифф первого\n');
const secondDiff = writeDiff(RACE, 'gonka', 'дифф второго\n');
check(': the second diff of the same slug claimed its own name instead of overwriting the other one',
  firstDiff.endsWith('review-gonka.diff') && secondDiff.endsWith('review-gonka-2.diff')
  && readFileSync(firstDiff, 'utf8') === 'дифф первого\n'
  && readFileSync(secondDiff, 'utf8') === 'дифф второго\n',
  `${path.basename(firstDiff)} · ${path.basename(secondDiff)} · ${JSON.stringify(readFileSync(firstDiff, 'utf8'))}`);
check(': the third one takes the next number instead of landing on the second',
  writeDiff(RACE, 'gonka', 'дифф третьего\n').endsWith('review-gonka-3.diff')
  && readFileSync(secondDiff, 'utf8') === 'дифф второго\n');

let againEffort;
const dryReuseEffort = await capture(async () => {
  againEffort = await review(WS, { target: REPO, task: task.id, dryRun: true, effort: 'max' });
});
check('re-review: --effort does not recreate the live session — the diff still goes to it',
  againEffort.reuse === true && againEffort.sessionState === 'alive'
  && againEffort.effort === 'max',
  `reuse=${againEffort.reuse} state=${againEffort.sessionState}`);
check('dry-run re-review alive: effort is marked not applied — the session is already alive',
  /effort: max \(not applied — the session is already alive\)/.test(dryReuseEffort), dryReuseEffort);
// A re-review does not change the model of a live session, exactly like effort: argv
// is not executed, only the diff goes.
const dryReuseModel = await capture(() => review(WS, { target: REPO, task: task.id, dryRun: true, model: 'sonnet' }));
check('dry-run re-review alive: --model is marked not applied, not passed off as applied',
  /model: sonnet \(not applied — the session is already alive\)/.test(dryReuseModel), dryReuseModel);

// A record made BEFORE the launch does not count as a reviewer: a failed launch leaves
// it in place, and there's nothing to confirm liveness with — `claude agents --json`
// isn't obtainable exactly where there's no binary at all. Without the mark, a repeat
// would go into re-review and send `type=task` to an inbox behind which there's nobody
// (review note on , a  class bug).
const pendingTask = store.createTask(home, { id: 't20260827-230000', title: 'ревью с сорвавшимся запуском' });
store.upsertParticipant(home, pendingTask.id, store.participantRecord('reviewer:cargos-api', { repo: 'loads_search/cargos-api',
  name: 'a2a-t20260827-230000-reviewer-cargos-api',
  pending: true }));
claudeStub('process.exit(1);');
const pendingUnknown = planReview(WS, { target: REPO, task: pendingTask.id });
check('record before launch: liveness not confirmed — no re-review is sent, a reviewer is raised',
  pendingUnknown.sessionState === 'unknown' && pendingUnknown.unlaunched === true
  && pendingUnknown.reuse === false,
  `state=${pendingUnknown.sessionState} unlaunched=${pendingUnknown.unlaunched} reuse=${pendingUnknown.reuse}`);

// The flip side of the same fix: a marked record whose session WAS FOUND alive is an
// ordinary reviewer. Otherwise re-review would stop working every time the second
// upsert didn't get around to clearing the mark.
claudeSays(JSON.stringify([{ name: 'a2a-t20260827-230000-reviewer-cargos-api', status: 'running' }]));
const pendingAlive = planReview(WS, { target: REPO, task: pendingTask.id });
check('record before launch: the session was found alive — this is an ordinary re-review, not a second reviewer',
  pendingAlive.sessionState === 'alive' && pendingAlive.unlaunched === false
  && pendingAlive.reuse === true, `state=${pendingAlive.sessionState} reuse=${pendingAlive.reuse}`);

// The printout must say the same thing the real run will do: on a record before launch
// it will raise a new reviewer, while the old text promised "already on the bus — a new
// diff will go".
claudeStub('process.exit(1);');
const dryPending = await capture(() => review(WS, { target: REPO, task: pendingTask.id, dryRun: true }));
check('dry-run on a record before launch: says the reviewer was not raised, not "already on the bus"',
  /record was made before start, the reviewer was not started/.test(dryPending)
  && !/already on the bus/.test(dryPending), dryPending.slice(-600));

// The flip side of the mark, and it rests on something non-obvious: applyParticipant
// replaces the record wholesale, so a second upsert without pending erases it too. If
// someone changed it to a merge, the mark would stick, and every re-review would
// silently raise a second reviewer onto the live session: a bug mirroring the one just
// closed (second review-round note).
claudeSays('[]');
await capture(() => review(WS, { tool: TOOL, target: REPO, task: pendingTask.id }));
const relaunched = store.participantOf(store.readTask(home, pendingTask.id), 'reviewer:cargos-api')?.metadata;
check(`: a successful launch clears pending — the record becomes an ordinary reviewer`,
  !!relaunched && !('pending' in relaunched), JSON.stringify(relaunched));

// : the reviewer needs the loop-warden hook for the same reason as the worker — it's
// the same kind of participant with a mailbox, and the workspace hook doesn't reach a
// session in someone else's directory. The FILE on disk is checked, and it's taken
// after the REAL launch: `review` writes it, not the plan, and a plan check would pass
// on an empty file. The command comes from the same function that places the hook in
// the layout: a second copy of it would have diverged silently (review note).
const reviewerSettings = JSON.parse(readFileSync(
  store.participantSettingsPath(home, pendingTask.id, 'reviewer:cargos-api'), 'utf8',
));
const reviewerGuard = reviewerSettings.hooks?.[GUARD_HOOK_EVENT]?.[0]?.hooks?.[0];
const reviewerIdentity = { address: 'reviewer:cargos-api', taskId: pendingTask.id, home };
check(`: the reviewer's settings carry the loop-warden Stop hook — the same command as the layout's`,
  reviewerGuard?.type === 'command'
  && reviewerGuard?.command === guardHookCommand(hostOf(WS), reviewerIdentity),
  JSON.stringify(reviewerSettings.hooks ?? null));
check(`no SessionStart is placed on the participant — the detector looks at the workspace root`,
  reviewerSettings.hooks?.SessionStart === undefined,
  JSON.stringify(reviewerSettings.hooks ?? null));
// : the address in the hook command is the reviewer's, not the worker's. This is
// exactly what used to drift while the identity came from the environment: two
// sessions of one task resolved to the same address, and the second overwrote the
// first's contact point.
check(`: the reviewer's hook command carries ITS OWN address, task, and home`,
  reviewerGuard?.command?.includes(` --role reviewer:cargos-api --task ${pendingTask.id} --home ${home}`) === true,
  String(reviewerGuard?.command));

// --task and --title together: the help declares them mutually exclusive, and a name
// silently vanishing used to give the person someone else's title in the session name
// (review note).
let bothFlags;
const dryBoth = await capture(async () => {
  bothFlags = await review(WS, { target: REPO, task: task.id, title: 'моё имя', dryRun: true });
});
check('--task with --title: the name is not applied, and the plan says so',
  bothFlags.titleIgnored === true && bothFlags.createNew === null, String(bothFlags.titleIgnored));
check('--task with --title: dry-run names the task journal as the source of the name',
  /--title is not applied — the name is taken from the journal/.test(dryBoth), dryBoth.slice(-500));

// The reviewer's session is closed (`claude stop`): a re-review would go to its inbox
// forever, and the caller would wait for a report that will never come.
claudeSays('[]');
const dead = planReview(WS, { target: REPO, task: task.id });
check(`dead session: re-review does not go into the inbox — the plan raises a new reviewer`,
  dead.sessionState === 'dead' && dead.reuse === false, dead.sessionState);
rmSync(BG_ARGV, { force: true });
const deadOut = await capture(() => review(WS, { target: REPO, task: task.id }));
check(`dead session: the new reviewer got the full prompt, not "check your prior findings"`,
  bgArgv().includes('## Communication protocol') && !bgArgv().includes('Re-review'),
  bgArgv().slice(0, 200) || 'claude --bg was not called at all');
check('dead session: the warning names the session\'s death and the loss of prior findings',
  /is dead/.test(deadOut) && /prior findings/.test(deadOut) && /started/.test(deadOut), deadOut);
// The hint after spawn used to give the session name from `claude --bg`'s output, but
// `--task` does not accept it: we print ready-made commands with the real task id.
check('spawn: hints print commands with the task id, not the session name',
  deadOut.includes(`task ${task.id}`)
  && deadOut.includes(`promptobus review "${realpathSync(REPO)}" --task ${task.id}`)
  && !/--task a2a-/.test(deadOut), deadOut);
// : there's nothing to wait for a report with, and no need — the bus warden will wake you.
check(': the hint leads to the warden and the mailbox, not to waiting',
  /the bus warden will wake you/.test(deadOut) && !/promptobus wait/.test(deadOut), deadOut);
check('dead session: nothing landed in the dead address\'s inbox',
  store.countInbox(home, task.id, 'reviewer:cargos-api') === 0,
  String(store.countInbox(home, task.id, 'reviewer:cargos-api')));

// --- : raising the reviewer is checked against the session registry -----------------------
//
// This block used to be a line-for-line copy of the worker's block, and it drifted from
// it exactly on the check: after launch the worker waited for the session to appear in
// `claude agents` (`awaitSession`), while the reviewer took the id from `claude --bg`'s
// output as-is. A silent daemon failure — "backgrounded", code 0, no session — reported
// success, and the orchestrator waited for a report that would never come. Checked in a
// separate process: the refusal goes through `fail()`, and that carries the process
// away past the verdict summary.
const liftoffRun = (opts, env = {}) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(reviewUrl)});\n`
    + `await m.review(${JSON.stringify(WS)}, ${JSON.stringify(opts)});`,
  ], { encoding: 'utf8', cwd: SB, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}`, ...env } });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};

claudeSays('[]');
const silentTask = store.createTask(home, { id: 't20260829-100000', title: 'ревью с молчаливым сбоем демона' });
const silent = liftoffRun(
  { target: REPO, task: silentTask.id, awaitOptions: { tries: 2, delayMs: 1 } },
  { STUB_SILENT_FAIL: '1' },
);
check(`: the reviewer's session isn't in claude agents — a refusal, not a report of success`,
  silent.status === 1 && /there is no live session .* in claude agents — reviewer was NOT started/.test(silent.text)
  && !/reviewer reviewer:cargos-api started/.test(silent.text), `status=${silent.status} ${silent.text}`);
check(`: the refusal for a session that didn't happen names the route to re-raise the reviewer`,
  /Start the reviewer again: promptobus review/.test(silent.text)
  && silent.text.includes(`--task ${silentTask.id}`), silent.text);
const silentPart = store.participantOf(store.readTask(home, silentTask.id), 'reviewer:cargos-api')?.metadata;
check(`: the reviewer's record is in place even after the refusal — a repeat will raise it under the same address`,
  !!silentPart, JSON.stringify(store.readTask(home, silentTask.id).participants));
// Review note: only a successful raise clears the `pending` mark. A second upsert also
// happens on refusal (the session id is appended in every outcome), and applyParticipant
// replaces the record wholesale — without this branch the record would become
// indistinguishable from a live reviewer's record.
check('review note: a refusal for a session that didn\'t happen does not clear the pending mark',
  silentPart?.pending === true, JSON.stringify(silentPart));
// What it's all for: on an unparsed `claude agents --json`, a repeat without the mark
// would consider the reviewer alive and send `type=task` to a mailbox behind which
// there's nobody.
claudeStub('process.exit(1);');
const afterSilent = planReview(WS, { target: REPO, task: silentTask.id });
check(`review note: a repeat after a refusal raises a reviewer instead of sending a re-review into an empty mailbox`,
  afterSilent.unlaunched === true && afterSilent.reuse === false
  && afterSilent.sessionState === 'unknown',
  `unlaunched=${afterSilent.unlaunched} reuse=${afterSilent.reuse} state=${afterSilent.sessionState}`);
// Scenario back to normal: the next check raises a reviewer, and it needs `--bg` to succeed.
claudeSays('[]');

// A matching name isn't enough: a past session's record doesn't disappear from the
// list, and restarting the reviewer under the same address would report its id — the
// same live-ghost bug.
const ghostTask = store.createTask(home, { id: 't20260829-101500', title: 'ревью на призрачной записи' });
const ghost = liftoffRun(
  { target: REPO, task: ghostTask.id, awaitOptions: { tries: 2, delayMs: 1 } },
  { STUB_GHOST: '1' },
);
check(': a ghost under the same name doesn\'t count as a raise — the refusal names it',
  ghost.status === 1 && /A record of a past session sits under this name \(ghost1\)/.test(ghost.text), `status=${ghost.status} ${ghost.text}`);

// The flip side of the check: the list isn't parsed — that's not death. The reviewer is
// raised, but the unconfirmed state is named out loud, same as for the worker.
const unverifiedTask = store.createTask(home, { id: 't20260829-103000', title: 'ревью без разбора списка' });
// The launch succeeds, but the session list isn't obtained: `agents` answers with a
// non-zero code, and the fake doesn't set the raise mark — otherwise the check would
// see it instead of the unparsed list.
claudeStub("if (args[0] === 'agents') process.exit(1);\nprocess.stdout.write('backgrounded · abc123');");
process.env.STUB_SILENT_FAIL = '1';
const unverified = await capture(() => review(WS, {
  tool: TOOL, target: REPO, task: unverifiedTask.id, awaitOptions: { tries: 2, delayMs: 1 },
}));
delete process.env.STUB_SILENT_FAIL;
check(': the session list isn\'t parsed — not a refusal, but an unconfirmed state named out loud',
  /reviewer reviewer:cargos-api started/.test(unverified)
  && /lift of session .* is not confirmed/.test(unverified), unverified);

// The order of id sources is the same as the worker's (`spawnedSessionId`): a record
// from `claude agents` is the harness's direct answer, parsing `claude --bg`'s output
// remains the fallback.
claudeSays('[]');
const idTask = store.createTask(home, { id: 't20260829-104500', title: 'ревью и id сессии' });
await capture(() => review(WS, { tool: TOOL, target: REPO, task: idTask.id }));
const idPart = store.participantOf(store.readTask(home, idTask.id), 'reviewer:cargos-api')?.metadata;
check(`: the reviewer's session id is taken from claude agents, not from parsing the output`,
  idPart?.session === 'sess-live', JSON.stringify(idPart));

// `claude agents --json`'s output isn't parsed: the state is unknown, not "dead" —
// conservatively we send to the former address, but say liveness isn't confirmed.
claudeFails();
const unknown = planReview(WS, { target: REPO, task: task.id });
check(`session state unknown — former address, no second reviewer raised`,
  unknown.sessionState === 'unknown' && unknown.reuse === true, unknown.sessionState);
const dryUnknownEffort = await capture(() => review(WS, { target: REPO, task: task.id, dryRun: true, effort: 'high', model: 'sonnet' }));
check('dry-run unknown: effort and model are neutral, they don\'t claim the session is alive',
  /effort: high \(not applied — the diff will go to the former address\)/.test(dryUnknownEffort)
  && /model: sonnet \(not applied — the diff will go to the former address\)/.test(dryUnknownEffort)
  && !/the session is already alive/.test(dryUnknownEffort)
  && /session liveness is not confirmed/.test(dryUnknownEffort), dryUnknownEffort);
const unknownOut = await capture(() => review(WS, { target: REPO, task: task.id }));
check('unknown state: the diff went to the former address with an honest warning',
  /cannot be confirmed/.test(unknownOut) && store.countInbox(home, task.id, 'reviewer:cargos-api') === 1,
  unknownOut);
check('re-review: the hint also names the task id',
  unknownOut.includes(`task ${task.id}`) && !/promptobus wait/.test(unknownOut), unknownOut);

// --- unread counter -----------------------------------------
//
// `promptobus review` is a move by the orchestrator, and the command's output remains
// the last place to say something about what has piled up in its own mailbox. Zero
// isn't named: a line that always prints stops being readable alongside a non-empty one.
const quietReview = await capture(() => review(WS, { target: REPO, task: task.id }));
check(': the orchestrator\'s empty mailbox is not named in `promptobus review`\'s output',
  !/your mailbox/.test(quietReview), quietReview);
store.sendMessage(home, task.id, {
  from: 'reviewer:cargos-api', to: 'orchestrator', type: 'result', body: `отчёт reviewer'а лежит непрочитанным`,
});
const loudReview = await capture(() => review(WS, { target: REPO, task: task.id }));
check(`: unread mail in the orchestrator's mailbox is named in \`promptobus review\`'s output along with the route`,
  /your mailbox: unread 1 — fetch it with the promptobus_mailbox tool/.test(loudReview), loudReview);
check(': the counter is a notification, not a reader — the message stays in the inbox',
  store.countInbox(home, task.id, 'orchestrator') === 1,
  String(store.countInbox(home, task.id, 'orchestrator')));
store.readInbox(home, task.id, 'orchestrator');

claudeSays('backgrounded · cafe12 · a2a-reviewer');
const effortTask = store.createTask(home, { id: 't20260825-140000', title: 'ревью effort' });
await capture(() => review(WS, { tool: TOOL, target: REPO, task: effortTask.id, effort: 'high' }));
const effortPart = store.participantOf(store.readTask(home, effortTask.id), 'reviewer:cargos-api')?.metadata;
check(`spawn reviewer: effort is written to the participant, same as for the worker`,
  effortPart?.effort === 'high', JSON.stringify(effortPart));

// A task that this same call opens (`--task` not given) does not get a counter: its
// mailbox is empty by construction, and whatever has piled up sits in the task it came
// from — and which one that is isn't known here. There's no guessing by "the single
// active task".
store.sendMessage(home, task.id, {
  from: 'reviewer:cargos-api', to: 'orchestrator', type: 'result', body: 'лежит в чужой задаче',
});
const freshTaskOut = await capture(() => review(WS, { tool: TOOL, target: REPO, title: 'работа оркестратора в cargos-api' }));
check(': a review opening its own task does not name someone else\'s counter',
  !/unread/.test(freshTaskOut), freshTaskOut);
store.readInbox(home, task.id, 'orchestrator');

const plainTask = store.createTask(home, { id: 't20260825-150000', title: 'ревью без effort' });
await capture(() => review(WS, { tool: TOOL, target: REPO, task: plainTask.id }));
const plainPart = store.participantOf(store.readTask(home, plainTask.id), 'reviewer:cargos-api')?.metadata;
check('spawn without --effort: there is no effort field on the participant',
  plainPart && !('effort' in plainPart), JSON.stringify(plainPart));
// A review joins the worker's task: the task slug is taken from its journal and goes
// at the start of the reviewer's name, with the machine stamp left in the tail.
const slugged = store.createTask(home, {
  id: 'bl-076-imena-t20260825-160000', title: ' читаемые имена',
  slug: 'bl-076-imena', stamp: 't20260825-160000',
});
const namedPlan = planReview(WS, { target: REPO, task: slugged.id });
check(`reviewer's session name: task title in words, stamp in parentheses`,
  namedPlan.name === 'Review: читаемые имена (0825-1600)', namedPlan.name);
store.closeTask(home, slugged.id);

// A review without --task opens its own task even when a foreign active one is hanging
// nearby: a review sneaking into that one would put two unrelated subjects into one
// journal, and that task's warden would wake its orchestrator over someone else's
// messages.
const foreign = store.createTask(home, {
  id: 'chuzhaya-t20260825-170000', title: 'Бриф: чужая задача',
  slug: 'chuzhaya', stamp: 't20260825-170000',
});
let own;
const secondOut = await capture(async () => {
  own = await review(WS, { target: REPO, title: 'работа оркестратора в cargos-api', dryRun: true });
});
check('without --task: a review opens its own task instead of sneaking into a foreign active one',
  own.taskId !== foreign.id && own.createNew?.title === 'работа оркестратора в cargos-api',
  `${own.taskId} vs ${foreign.id}`);
const joined = planReview(WS, { target: REPO, task: foreign.id });
check('--task: joining an existing task happens only with an explicit flag',
  joined.taskId === foreign.id && joined.createNew === null, joined.taskId);
// There are now several active tasks, and the "single active task" resolve stops
// working: the command warns about this right away, not with a refusal on the next call.
check('the plan knows about neighboring active tasks',
  own.otherActive.includes(foreign.id) && joined.otherActive.length === 0, own.otherActive.join(','));
check('a warning about a second active task with a ready-made close command',
  /another task is also active|other tasks are also active/.test(secondOut) && secondOut.includes(foreign.id)
  && /--task/.test(secondOut) && /promptobus done --task/.test(secondOut), secondOut);
store.closeTask(home, foreign.id);

store.closeTask(home, effortTask.id);
store.closeTask(home, plainTask.id);

// --- clone worktree: a legitimate target --------------------------------------------

const WT = path.join(REPO, '.claude', 'worktrees', 'a2a-worker');
g(REPO, 'worktree', 'add', '-q', '-b', 'worktree-a2a', WT);
const wt = planReview(WS, { target: WT, task: task.id });
// nsPath includes planted `repos/` — standalone `cloneOf` walks from WS, see fixture note above.
check('a clone\'s worktree is a legitimate target, the repository is taken from the path',
  wt.nsPath === 'repos/loads_search/cargos-api' && wt.repoDir === realpathSync(WT),
  `${wt.nsPath} · ${wt.repoDir}`);

// --- a clone in a subgroup and its worktree ---------------------------------
//
// The namespace can be deeper than two segments, and a worktree has its own git
// toplevel — it points inside the clone, not at its root. The second path segment used
// to be taken as the repository, and a review of a live orchestration got an address by
// the intermediate subgroup: `reviewer:cargo-vibe` instead of `reviewer:ls-ai-skills`.
const SUB = path.join(WS, 'repos', 'ls', 'cargo-vibe', 'ls-ai-skills');
mkdirSync(SUB, { recursive: true });
g(SUB, 'init', '-b', 'main');
writeFileSync(path.join(SUB, 'a.txt'), 'v1\n');
g(SUB, 'add', '.');
g(SUB, 'commit', '-m', 'init', '-q');
writeFileSync(path.join(SUB, 'a.txt'), 'v2\n');
const sub = planReview(WS, { target: SUB, task: task.id });
check('a clone in a subgroup: the repository is the clone itself, not the intermediate subgroup',
  sub.nsPath === 'repos/ls/cargo-vibe/ls-ai-skills' && sub.address === 'reviewer:ls-ai-skills',
  `${sub.nsPath} · ${sub.address}`);

const SUBWT = path.join(SUB, '.claude', 'worktrees', 'a2a-ls-ai-skills-0826-0215');
g(SUB, 'worktree', 'add', '-q', '-b', 'worktree-a2a-ls', SUBWT);
writeFileSync(path.join(SUBWT, 'a.txt'), 'v3\n');
const subWt = planReview(WS, { target: SUBWT, task: task.id });
check('worktree of a clone in a subgroup: address by repository, diff by worktree',
  subWt.nsPath === 'repos/ls/cargo-vibe/ls-ai-skills'
  && subWt.address === 'reviewer:ls-ai-skills'
  && subWt.repoDir === realpathSync(SUBWT),
  `${subWt.nsPath} · ${subWt.address} · ${subWt.repoDir}`);

// --- subject of the review: a worker's worktree --------------------------
//
// A live scenario from 2026-08-26. The orchestrator committed work locally without
// pushing, and the worker branched off the local default branch: `origin/main` doesn't
// contain that work, and it went entirely into the reviewer's diff — twelve files and
// 205 lines instead of three and 26. The fixture puts `origin/main` deliberately behind
// the local `main` — exactly that picture. A second worker of the same repository is
// right here too: before , the reviewer's slug was taken from the clone's root, and the
// second one's review went to the first one's live reviewer as a re-review.
const gOut = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();
const OWN = path.join(WS, 'repos', 'loads_search', 'base-api');
mkdirSync(OWN, { recursive: true });
g(OWN, 'init', '-b', 'main');
writeFileSync(path.join(OWN, 'AGENTS.md'), 'Правила репозитория.\n');
writeFileSync(path.join(OWN, 'obshee.txt'), 'общий код\n');
g(OWN, 'add', '.');
g(OWN, 'commit', '-m', 'init', '-q');
const PUSHED = gOut(OWN, 'rev-parse', 'HEAD');
g(OWN, 'update-ref', 'refs/remotes/origin/main', PUSHED);
// `origin/HEAD` — for the same reason as cargos-api above: default-branch detection
// stops at the first ref. It doesn't touch the  picture — `origin/main` stays behind
// the local `main` exactly as it was.
g(OWN, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
writeFileSync(path.join(OWN, 'orkestrator.txt'), 'незапушенная работа оркестратора\n');
g(OWN, 'add', '.');
g(OWN, 'commit', '-m', 'работа оркестратора мимо origin', '-q');
const FORK = gOut(OWN, 'rev-parse', 'HEAD');

const W1 = path.join(OWN, '.claude', 'worktrees', 'a2a-pervyy');
g(OWN, 'worktree', 'add', '-q', '-b', 'worktree-a2a-pervyy', W1, 'main');
writeFileSync(path.join(W1, 'pervyy.txt'), `работа первого worker'а\n`);
g(W1, 'add', '.');
g(W1, 'commit', '-m', 'работа первого', '-q');
const W2 = path.join(OWN, '.claude', 'worktrees', 'a2a-vtoroy');
g(OWN, 'worktree', 'add', '-q', '-b', 'worktree-a2a-vtoroy', W2, 'main');
writeFileSync(path.join(W2, 'vtoroy.txt'), `работа второго worker'а\n`);
g(W2, 'add', '.');
g(W2, 'commit', '-m', 'работа второго', '-q');
// The third worker hasn't done anything yet: its diff is empty.
const W3 = path.join(OWN, '.claude', 'worktrees', 'a2a-tretiy');
g(OWN, 'worktree', 'add', '-q', '-b', 'worktree-a2a-tretiy', W3, 'main');

const owned = store.createTask(home, {
  id: 'bl-118-baza-t20260826-120000', title: ' база диффа', slug: 'bl-118-baza', stamp: 't20260826-120000',
});
// `title` is the title of the worker's piece of work: its session name is assembled
// from it, and its reviewer's session is named by it too. Without it — a record from
// the previous CLI: it has no such field, and the title is taken from the task, as before.
// The participant record assembles the mechanism's door: the address and the
// mechanism's fields go into `metadata`, v1's own fields are the role, harness, mode,
// session reference, and a capabilities snapshot.
const worker = (address, worktree, wtName, title = null, extra = {}) => store.participantRecord(address, {
  repo: 'loads_search/base-api',
  repoAbs: OWN,
  worktree,
  worktreeName: wtName,
  branch: `worktree-${wtName}`,
  ...(title ? { title } : {}),
  name: `Worker: ${title ?? owned.title} (0826-1200, ${address.slice('worker:'.length)})`,
  ...extra,
});
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', `Точка ветвления worker'а`, { baseSha: FORK }));
store.upsertParticipant(home, owned.id, worker('worker:vtoroy', W2, 'a2a-vtoroy', 'Reviewer по предмету ревью', { baseSha: FORK }));

// The fixture must reproduce the bug, otherwise the checks below pass green for any
// reason: from the old base, the worker's diff really does drag in someone else's work.
check(`fixture: the orchestrator's work lands in the first worker's diff from origin/main`,
  gOut(W1, 'diff', gOut(W1, 'merge-base', 'origin/main', 'HEAD'), '--stat').includes('orkestrator.txt'),
  gOut(W1, 'diff', gOut(W1, 'merge-base', 'origin/main', 'HEAD'), '--stat'));

const first = planReview(WS, { target: W1, task: owned.id });
check(`: the reviewer's address follows the worker whose worktree it is, not the clone name`,
  first.address === 'reviewer:pervyy' && store.addressOf(first.owner) === 'worker:pervyy', first.address);
check(': the diff base is the branch point from the journal, not origin/<default>',
  first.baseRef === FORK, `${first.baseRef} vs ${FORK}`);
check(`: the orchestrator's work bypassing origin does not land in the worker's diff`,
  first.diff.includes('pervyy.txt') && !first.diff.includes('orkestrator.txt'), first.stat);
check(`: the base is named out loud — in the plan, in the reviewer's prompt, and in the re-review message`,
  String(first.baseLine).includes(FORK) && String(first.baseLine).includes('worker:pervyy')
  && first.prompt.includes(String(first.baseLine)) && first.reReview.includes(String(first.baseLine)),
  String(first.baseLine));

const second = planReview(WS, { target: W2, task: owned.id });
check(': a second worker of the same repository gets its own reviewer, not the first one\'s reviewer',
  second.address === 'reviewer:vtoroy' && second.address !== first.address, second.address);
check(': the second one\'s reviewer sees its own diff',
  second.diff.includes('vtoroy.txt') && !second.diff.includes('pervyy.txt'), second.stat);
// The reviewer's name names the same piece as its worker's name: there are now several
// reviewers per task, and it must be visible from a line in `claude agents` whose work
// each one is looking at.
check(`: the reviewer's name names its worker's piece, not the task as a whole`,
  first.name === `Review: Точка ветвления worker'а (0826-1200)`
  && second.name === 'Review: Reviewer по предмету ревью (0826-1200)'
  && !first.name.includes(owned.title), `${first.name} · ${second.name}`);
check(`: the second one's diff does not overwrite the first one's diff — names follow the workers' slugs`,
  first.diffPath.endsWith('review-pervyy.diff') && second.diffPath.endsWith('review-vtoroy.diff'),
  `${first.diffPath} · ${second.diffPath}`);

// `--base` remains a manual override and outweighs a recorded one.
const forced = planReview(WS, { target: W1, task: owned.id, base: PUSHED });
check('--base outweighs the recorded branch point, and the output says the base was given by a flag',
  forced.baseRef === PUSHED && /--base/.test(String(forced.baseLine)), String(forced.baseLine));

// A real run, not just `--dry-run`: the base and the address must be named there too —
// silence there was the other half of the  bug.
claudeSays('backgrounded · cafe34 · reviewer');
const liveOut = await capture(() => review(WS, { tool: TOOL, target: W2, task: owned.id }));
check(`: a real run names the base, the worker, and the reviewer's address`,
  liveOut.includes(FORK) && /by the worker worker:vtoroy/.test(liveOut)
  && liveOut.includes('reviewer:vtoroy') && /diff base/.test(liveOut), liveOut);

// A re-review of the same subject must stay the same: the same directory and the same
// --task go to the same reviewer, not raise a second one.
const revPart = store.participantOf(store.readTask(home, owned.id), 'reviewer:vtoroy')?.metadata;
check(`: the reviewer is recorded in the task journal under the worker's address, not the clone's name`,
  !!revPart, (store.readTask(home, owned.id).participants ?? []).map((p) => store.addressOf(p)).join(', '));
claudeSays(JSON.stringify([{ name: revPart?.name ?? 'сессии нет', pid: 4242 }]));
const reReviewed = planReview(WS, { target: W2, task: owned.id });
check('re-review of the same subject — the same address and the same live session',
  reReviewed.address === 'reviewer:vtoroy' && reReviewed.reuse === true
  && reReviewed.sessionState === 'alive', `${reReviewed.address} · ${reReviewed.sessionState}`);

// The main clone belongs to nobody in the worktree journal — a review of the
// orchestrator's own work stays on the prior behavior for both tasks.
const cloneWide = planReview(WS, { target: OWN, task: owned.id });
check('main clone: address by clone name, base by the default branch — prior behavior',
  cloneWide.owner === null && cloneWide.address === 'reviewer:base-api'
  && cloneWide.baseRef === 'origin/main', `${cloneWide.address} · ${cloneWide.baseRef}`);
check(`main clone: the reviewer's name is the task title, this directory has no participant`,
  cloneWide.name === 'Review: база диффа (0826-1200)', cloneWide.name);

// A participant record made by the previous CLI has no branch point — and that no
// longer means the base falls back to the default branch. The point is computed as the
// merge-base with the local default branch, so the orchestrator's work bypassing origin
// doesn't land in the diff here either. The address follows the worker —  doesn't
// depend on the recorded point.
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy'));
const legacyBase = planReview(WS, { target: W1, task: owned.id });
check('a previous-CLI record without a branch point: the base is the merge-base, no foreign work in the diff',
  legacyBase.baseRef === FORK && !legacyBase.diff.includes('orkestrator.txt')
  && legacyBase.diff.includes('pervyy.txt') && legacyBase.address === 'reviewer:pervyy',
  `${legacyBase.baseRef} · ${legacyBase.address}`);
check('a previous-CLI record: there is no warning about a guessed base — the base isn\'t a guess',
  (legacyBase.warnings ?? []).every((w) => !/the target is a worktree/.test(w)),
  (legacyBase.warnings ?? []).join(' | '));
// Such a record has no title of its own either — the reviewer's name stays the former
// one, the task title, and that isn't a refusal.
check(`a previous-CLI record without a piece title: the reviewer's name is the task title`,
  legacyBase.name === 'Review: база диффа (0826-1200)', legacyBase.name);

// The recorded point is not taken on faith (review note). The branch might have been
// rebased, and the commit might not even be in the clone at all: `merge-base <no such
// sha> HEAD` refuses, and the command used to crash on it with git's raw text. The
// `--is-ancestor` check falls back to the default branch and says so — the base line
// can't promise more than the code actually verified.
const GONE = '0123456789abcdef0123456789abcdef01234567';
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', null, { baseSha: GONE }));
const stale = planReview(WS, { target: W1, task: owned.id });
check('a branch point not in HEAD\'s history: falls back to the computed base instead of crashing on git',
  stale.baseRef === FORK && !String(stale.baseLine).includes(GONE)
  && !stale.diff.includes('orkestrator.txt'),
  `${stale.baseRef} · ${(stale.warnings ?? []).join(' | ')}`);
// The second worker's branch is a real commit, but not an ancestor of the first one's
// HEAD: the same fork, only "rebased" instead of "the commit is gone".
const OTHER_TIP = gOut(W2, 'rev-parse', 'HEAD');
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', null, { baseSha: OTHER_TIP }));
const rebased = planReview(WS, { target: W1, task: owned.id });
check('a branch point from someone else\'s history is also rejected, not taken blindly',
  rebased.baseRef === FORK && !String(rebased.baseLine).includes(OTHER_TIP)
  && !rebased.diff.includes('vtoroy.txt'),
  `${rebased.baseRef} · ${(rebased.warnings ?? []).join(' | ')}`);
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', null, { baseSha: FORK }));

// A directory not listed in the named task still gets an accurate base: it's computed
// as the merge-base, not read from the journal. There's nothing to warn about — no
// foreign work in the diff. The guessed-base gate is checked below, on a clone with no
// local default branch.
let forcedPlan;
const orphan = await capture(async () => {
  forcedPlan = await review(WS, { target: W1, task: task.id, dryRun: true });
});
check('a worktree outside the named task\'s journal: the base is computed, no loud warning',
  !/the target is a worktree/.test(orphan) && orphan.includes(FORK), orphan);
// : a forgotten `--task` on one's own worker's worktree is no longer a bug. The command
// picks up on its own the active task in whose journal this directory is listed — and
// along with the task it takes the directory's owner, its address, and its branch
// point. It used to open its own second active task and warn about a drifted base.
let noTaskPlan;
const noTask = await capture(async () => { noTaskPlan = await review(WS, { target: W1, dryRun: true }); });
check(`: a worker's own worktree without --task picks up its active task`,
  !/the target is a worktree/.test(noTask) && noTask.includes(owned.id) && !/will be created/.test(noTask)
  && /reviewer:pervyy/.test(noTask) && noTask.includes(FORK), noTask);
check(': the picked-up task is the same one --task would have named, and it doesn\'t open a second active one',
  noTaskPlan.taskId === owned.id && noTaskPlan.createNew === null
  && store.addressOf(noTaskPlan.owner) === 'worker:pervyy' && noTaskPlan.baseRef === FORK,
  `${noTaskPlan.taskId} · ${noTaskPlan.baseRef}`);
// An explicit --task outweighs the pickup — it always outweighed everything before too.
// The plan is the same as `orphan`'s above (same target and --task, the journal hasn't
// changed between them), and is taken from there.
check(': an explicit --task outweighs the pickup',
  forcedPlan.taskId === task.id, forcedPlan.taskId);
// A foreign directory does not get a pickup: a review outside the current task is a
// legitimate move, which is what  was resolved for. There, the prior behavior applies —
// its own task and a warning that there will be several active ones.
const outsideTask = await capture(() => review(WS, { target: OWN, title: 'работа оркестратора в base-api', dryRun: true }));
check(': a target outside active tasks\' journals opens its own — and says so',
  /will be created/.test(outsideTask) && !outsideTask.includes(`task: ${owned.id}`)
  && new RegExp(`(?:another task is also active|other tasks are also active)[^\\n]*${owned.id}`).test(outsideTask), outsideTask);
// The command will not choose a task for the person no matter how the journal is
// arranged: the journal can also be edited by hand, and two live journals for one
// directory is no longer a pickup, it's a guess.
const twin = store.createTask(home, { id: 'twin-t20260827-090000', title: 'двойник', slug: 'twin', stamp: 't20260827-090000' });
store.upsertParticipant(home, twin.id, worker('worker:pervyy', W1, 'a2a-pervyy-twin'));
let ambiguous = '';
try { planReview(WS, { target: W1 }); } catch (e) { ambiguous = e.message; }
check(': a directory in two active journals — a refusal with a list, not a random pick',
  /several active tasks at once/.test(ambiguous) && ambiguous.includes(twin.id)
  && ambiguous.includes(owned.id) && /--task/.test(ambiguous), ambiguous);
store.closeTask(home, twin.id);

// --- : the owner gate ON TOP OF the directory pickup -----------------------
//
// The tension with  is resolved by ordering, not by removal: a directory pickup
// remains a sign of "one's own", and its legitimate case — one's own worker, one's own
// task — isn't touched by the gate, because the mailbox owner there is this same
// session. What's caught is the reverse: the directory is listed in a task whose
// mailbox is claimed by ANOTHER session. Such a sneak-in used to go silently before,
// and the raised reviewer reported to a foreign task's orchestrator.
//
// We substitute the session identity: `sessionIdentity` reads
// `CLAUDE_CODE_SESSION_ID`, and without the substitution the check would behave
// differently in a Claude Code session versus in CI.
const withSession = (id, fn) => {
  const was = process.env.CLAUDE_CODE_SESSION_ID;
  if (id === null) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = id;
  try { return fn(); } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = was;
  }
};
const REVIEW_OWNER = 'sess-hozyain-zahoda';
const ownerWas = store.taskOwner(home, owned.id);
store.claimOwnership(home, owned.id, REVIEW_OWNER);
const gatedReview = withSession('sess-gost', () => {
  try { planReview(WS, { target: W1 }); return ''; } catch (e) { return e.message; }
});
check(': a directory pickup into a foreign task — a refusal with the owner and both routes',
  gatedReview.includes(REVIEW_OWNER) && gatedReview.includes('sess-gost')
  && gatedReview.includes(`--task ${owned.id}`) && gatedReview.includes('mailbox {claim: true}')
  && gatedReview.includes(W1), gatedReview);
// : the same refusal with the real command. `fail()` isn't available to the scheduler —
// it's also called as a pure function — so the mark of an expected  refusal is carried
// by the `GateError` class, and the top-level `agents.js` catch doesn't print a stack.
// Checked in a separate process with a real binary: in the shared process there's no
// top-level catch at all, and there's nothing there to see the output's shape with.
const gateCli = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'promptobus.js'), 'review', W1],
  {
    encoding: 'utf8',
    cwd: WS,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sess-gost', PATH: `${BIN}${path.delimiter}${PATH0}` },
  });
const gateCliText = `${gateCli.stdout}${gateCli.stderr}`;
check(': the owner gate\'s refusal arrives without a stack — this is a legitimate outcome, not a breakage',
  gateCli.status === 1 && gateCliText.includes(REVIEW_OWNER) && gateCliText.includes('mailbox {claim: true}')
  && !/\n\s+at /.test(gateCliText) && !/^Error:/m.test(gateCliText),
  `status=${gateCli.status} ${gateCliText}`);

// --- : an explicit --task with no journal — with the real command, without a stack ----------
//
// `planReview` checks `taskExists` itself and used to throw a bare `Error`. The
// stack-free shape is visible only in a separate CLI process — the same seam as  / .
const reviewCli = (args) => {
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'promptobus.js'), 'review', ...args], {
    encoding: 'utf8', cwd: WS,
    env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};
const noStack = (run) => run.status === 1 && !/\n\s+at /.test(run.text) && !/^Error:/m.test(run.text);
const missingReviewTask = reviewCli([REPO, '--task', 'net-takoy-bl394', '--dry-run']);
check(': review --task on a nonexistent task is printed without a stack',
  noStack(missingReviewTask) && /there is no task net-takoy-bl394/.test(missingReviewTask.text),
  `status=${missingReviewTask.status} ${missingReviewTask.text}`);

// --- : an explicit --task on a closed journal — the same shape as spawn -------
//
// `planReview` only looked at `taskExists`: a closed file sits there until prune, and
// review went on. The stack-free shape is visible only in a separate CLI process.
const DONE_REVIEW = 'bl-395-zakryta-t20260831-120000';
store.createTask(home, {
  id: DONE_REVIEW, title: 'закрытая задача ', slug: 'bl-395-zakryta', stamp: 't20260831-120000',
});
store.closeTask(home, DONE_REVIEW);
const closedReviewThrow = expectThrow(() => planReview(WS, { target: REPO, task: DONE_REVIEW, dryRun: true }));
check(': planReview on a closed task throws GateError',
  closedReviewThrow.threw && closedReviewThrow.name === 'GateError'
  && /task bl-395-zakryta-t20260831-120000 is closed/.test(closedReviewThrow.msg)
  && /worktree/.test(closedReviewThrow.msg),
  `${closedReviewThrow.name}: ${closedReviewThrow.msg}`);
check(': the refusal names --title, not "without --task it will open one itself"',
  /--title/.test(closedReviewThrow.msg) && /just not this id/.test(closedReviewThrow.msg)
  && !/will open a task itself/.test(closedReviewThrow.msg),
  closedReviewThrow.msg);
const closedReviewTask = reviewCli([REPO, '--task', DONE_REVIEW, '--dry-run']);
check(': review --task on a closed task is printed without a stack',
  noStack(closedReviewTask) && /task bl-395-zakryta-t20260831-120000 is closed/.test(closedReviewTask.text),
  `status=${closedReviewTask.status} ${closedReviewTask.text}`);

// An explicit `--task` is entry by agreement, and the gate doesn't know about it: the
// same order as in spawn.
const invitedReview = withSession('sess-gost', () => planReview(WS, { target: W1, task: owned.id }));
check(': an explicit --task passes through — the gate only applies to an implicit pickup',
  invitedReview.taskId === owned.id && store.addressOf(invitedReview.owner) === 'worker:pervyy',
  invitedReview.taskId);
// The legitimate  scenario is unaffected by the gate: one's own worker, one's own task,
// the owner is this session.
const ownReview = withSession(REVIEW_OWNER, () => planReview(WS, { target: W1 }));
check(': one\'s own worktree of one\'s own task is picked up without --task, as before',
  ownReview.taskId === owned.id && ownReview.createNew === null, ownReview.taskId);
// There's no identity at all — nothing to compare against, the gate stays silent: the
// same promise as .
const anonReview = withSession(null, () => planReview(WS, { target: W1 }));
check(': a session that hasn\'t declared an identity — prior behavior, not a refusal',
  anonReview.taskId === owned.id, anonReview.taskId);
store.claimOwnership(home, owned.id, ownerWas);

// --- : which task becomes current for a session ----------------------
//
// The binding is written by `review()`, not by the plan, so the check runs against a
// REAL run. `withSession` above is synchronous: it would restore the environment
// before the promise finishes.
const withSessionAsync = async (id, fn) => {
  const was = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = id;
  try { return await fn(); } finally {
    if (was === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = was;
  }
};
const BIND_SESS = 'sess-vedyot-zahod';
const ownerWasBind = store.taskOwner(home, owned.id);
store.claimOwnership(home, owned.id, BIND_SESS);
check(': fixture — the session runs its own run, the binding sits on its task',
  store.boundTaskId(home, BIND_SESS) === owned.id, String(store.boundTaskId(home, BIND_SESS)));

// A task opened by a review does not steal the binding. Had it bound, `mailbox` with no
// argument would go read the review task's box while the main run's worker messages
// pile up unnoticed, and the next `promptobus spawn` would seat a worker there too. It
// used to get a loud "several active tasks" refusal; the resolve silently steering
// there is the same bug without a word, and  comes back with it.
const strayReview = await withSessionAsync(BIND_SESS,
  () => capture(() => review(WS, { tool: TOOL, target: OWN, title: 'ревью постороннего каталога' })));
check(': a review of a foreign directory does not steal the session binding',
  store.boundTaskId(home, BIND_SESS) === owned.id,
  `${store.boundTaskId(home, BIND_SESS)} · ${strayReview.split('\n')[0]}`);

// Picking up one's own task writes the binding: it's usually already its own there, but
// a neighboring `promptobus done`'s cleanup removes the file, and the pickup restores it.
rmSync(store.sessionFile(home, BIND_SESS), { force: true });
await withSessionAsync(BIND_SESS, () => capture(() => review(WS, { tool: TOOL, target: W1 })));
check(`: picking up one's own worker's task writes the binding`,
  store.boundTaskId(home, BIND_SESS) === owned.id, String(store.boundTaskId(home, BIND_SESS)));
store.claimOwnership(home, owned.id, ownerWasBind);

// There's no owner in any live journal — and that's also not a reason to warn while the
// base is computed from the local default branch.
const orphanNoTask = await capture(() => review(WS, { target: W3, title: 'ревью worktree без владельца', dryRun: true }));
check('a worktree with no owner in the live journals: the base is computed, no warning',
  !/the target is a worktree/.test(orphanNoTask), orphanNoTask);
// Legitimate targets get no warning: the main clone and a worktree with its own owner.
const quietClone = await capture(() => review(WS, { target: OWN, task: owned.id, dryRun: true }));
const quietOwned = await capture(() => review(WS, { target: W1, task: owned.id, dryRun: true }));
check('the main clone and a worktree with its own owner get no warning',
  !/the target is a worktree/.test(quietClone) && !/the target is a worktree/.test(quietOwned),
  `${/the target is a worktree/.test(quietClone)} · ${/the target is a worktree/.test(quietOwned)}`);

// An empty diff is exactly the case where the base is the first thing under suspicion
// ("why empty?"), and the exit comes before any printing of the base.
store.upsertParticipant(home, owned.id, worker('worker:tretiy', W3, 'a2a-tretiy', null, { baseSha: FORK }));
const emptyOut = await capture(() => review(WS, { target: W3, task: owned.id }));
check('empty diff: the "no changes — nothing to review" message names the base',
  /nothing to review/.test(emptyOut) && emptyOut.includes(FORK), emptyOut);

// --- refusals -------------------------------------------------------------------

const OUT = path.join(SB, 'outside');
mkdirSync(OUT, { recursive: true });
g(OUT, 'init', '-b', 'main');
const outside = expectThrow(() => planReview(WS, { target: OUT, title: 'посторонний каталог' }));
check('outside the workspace — a refusal, not a review without rules',
  outside.threw && /outside the workspace/.test(outside.msg), outside.msg);

// A group folder: a path inside the workspace, but with no .git of its own — the
// toplevel goes up to the workspace root. The refusal must name the specific clone,
// not lie about being "outside the workspace".
const GROUP = path.join(WS, 'repos', 'loads_search');
const group = expectThrow(() => planReview(WS, { target: GROUP, title: 'папка группы' }));
check('a group folder — a refusal about the clone, not "outside the workspace"',
  group.threw && /clone not found/.test(group.msg)
  && !/outside the workspace/.test(group.msg), group.msg);

check('standalone: the module review skill does not resolve — built-in finding format',
  plan.skill === null && plan.prompt.includes('[critical|major|minor]'));

// --- base at review time: the worker merged in the default branch ------------------
//
// A second piece of work on the same branch requires merging in the default branch,
// otherwise it sits on top of stale code. The recorded branch point then stays behind
// everything that arrived with the merge — and it doesn't stop being an ancestor of
// HEAD, so the `--is-ancestor` check doesn't see the swap. A live case: 63 files of
// someone else's already-accepted work instead of 7 of one's own.
writeFileSync(path.join(OWN, 'chuzhaya.txt'), 'чужая принятая работа\n');
g(OWN, 'add', '.');
g(OWN, 'commit', '-m', 'чужая работа, уже принятая в main', '-q');
const MERGED = gOut(OWN, 'rev-parse', 'HEAD');
g(W1, 'merge', '--no-edit', '-q', 'main');
store.upsertParticipant(home, owned.id, worker('worker:pervyy', W1, 'a2a-pervyy', null, { baseSha: FORK }));

check(`fixture: someone else's already-accepted work lands in the worker's diff from the recorded point`,
  gOut(W1, 'diff', FORK, '--stat').includes('chuzhaya.txt'), gOut(W1, 'diff', FORK, '--stat'));

const merged = planReview(WS, { target: W1, task: owned.id });
check(': the base is computed at review time, not taken from the record',
  merged.baseRef === MERGED, `${merged.baseRef} vs ${MERGED} (recorded ${FORK})`);
check(': someone else\'s already-accepted work does not land in the diff, one\'s own remains',
  !merged.diff.includes('chuzhaya.txt') && merged.diff.includes('pervyy.txt'), merged.stat);
check(': the divergence between the recorded and the computed base is named out loud',
  String(merged.baseLine).includes(MERGED) && String(merged.baseLine).includes(FORK)
  && /was left behind/.test(String(merged.baseLine)), String(merged.baseLine));

// --- guessed-base gate: looks at the source, not at the record's fields ----
//
// A record with a worktree but without baseSha used to fall through both former
// conditions: the owner is found, so the first is false; baseSha is empty, so the
// second is false too. The base was silently taken from the default branch. Here the
// clone has no local default branch at all — there's nowhere to compute the point
// from, and this is the only arrangement where the base remains a guess.
const NOLOCAL = path.join(WS, 'repos', 'loads_search', 'no-local-default');
mkdirSync(NOLOCAL, { recursive: true });
g(NOLOCAL, 'init', '-b', 'work');
writeFileSync(path.join(NOLOCAL, 'AGENTS.md'), 'Правила репозитория.\n');
g(NOLOCAL, 'add', '.');
g(NOLOCAL, 'commit', '-m', 'init', '-q');
g(NOLOCAL, 'update-ref', 'refs/remotes/origin/main', gOut(NOLOCAL, 'rev-parse', 'HEAD'));
const NLWT = path.join(NOLOCAL, '.claude', 'worktrees', 'a2a-bez-bazy');
g(NOLOCAL, 'worktree', 'add', '-q', '-b', 'worktree-a2a-bez-bazy', NLWT, 'work');
writeFileSync(path.join(NLWT, 'rabota.txt'), `работа worker'а\n`);
g(NLWT, 'add', '.');
g(NLWT, 'commit', '-m', 'работа', '-q');
store.upsertParticipant(home, owned.id, store.participantRecord('worker:bezbazy', { repo: 'loads_search/no-local-default', repoAbs: NOLOCAL,
  worktree: NLWT, worktreeName: 'a2a-bez-bazy', branch: 'worktree-a2a-bez-bazy',
  name: 'Worker: без базы (0826-1200, bezbazy)' }));

const noBase = planReview(WS, { target: NLWT, task: owned.id });
check(': a record with a worktree and no baseSha gives a warning, not a calm line',
  (noBase.warnings ?? []).some((w) => /the target is a worktree/.test(w) && /has no branch point/.test(w)
    && /--base/.test(w)),
  (noBase.warnings ?? []).join(' | '));
check(': the base is honestly named a guess by the default branch in this case',
  noBase.baseRef === 'origin/main' && /repository default branch/.test(String(noBase.baseLine)),
  String(noBase.baseLine));

// --- : one default-branch detector shared by spawn and review ------------------------
//
// There used to be two detectors, and they answered differently: fresh.js (which
// chooses spawn's base) goes `origin/HEAD` → `origin/master` → `origin/main`,
// review.js went `origin/HEAD` → local `main` → `master`. In a clone where
// `origin/HEAD` isn't set but both local `main` and `master` exist, the worker branched
// off `master`, while the reviewer computed the diff from `main` — and the
// orchestrator's work sitting on `master` went into the worker's diff, i.e. the  bug
// via a diverged guess.
const DUAL = path.join(WS, 'repos', 'loads_search', 'dual-default');
mkdirSync(DUAL, { recursive: true });
g(DUAL, 'init', '-b', 'master');
writeFileSync(path.join(DUAL, 'AGENTS.md'), 'Правила репозитория.\n');
g(DUAL, 'add', '.');
g(DUAL, 'commit', '-m', 'init', '-q');
const D0 = gOut(DUAL, 'rev-parse', 'HEAD');
// Both local branches are in place, origin/HEAD isn't set, and only master exists from
// origin: exactly the clone on which the detectors diverged.
g(DUAL, 'branch', 'main');
g(DUAL, 'update-ref', 'refs/remotes/origin/master', D0);
writeFileSync(path.join(DUAL, 'ork.txt'), 'работа оркестратора на master\n');
g(DUAL, 'add', '.');
g(DUAL, 'commit', '-m', 'работа оркестратора', '-q');
const D1 = gOut(DUAL, 'rev-parse', 'HEAD');
const DW = path.join(DUAL, '.claude', 'worktrees', 'a2a-dual');
g(DUAL, 'worktree', 'add', '-q', '-b', 'worktree-a2a-dual', DW, 'master');
writeFileSync(path.join(DW, 'rabota.txt'), `работа worker'а\n`);
g(DW, 'add', '.');
g(DW, 'commit', '-m', 'работа', '-q');
// A record without baseSha (made by the previous CLI) is the only arrangement in which
// the base is computed from the default branch instead of taken from the record: it's
// this one that exposes the detector.
store.upsertParticipant(home, owned.id, store.participantRecord('worker:dual', { repo: 'loads_search/dual-default', repoAbs: DUAL,
  worktree: DW, worktreeName: 'a2a-dual', branch: 'worktree-a2a-dual',
  name: 'Worker: две default-ветки (0826-1200, dual)' }));
check('fixture: spawn would have branched off master — that\'s how fresh.js\'s detect chooses it',
  gOut(DUAL, 'rev-parse', 'master') === D1 && gOut(DUAL, 'rev-parse', 'main') === D0,
  `master=${gOut(DUAL, 'rev-parse', 'master')} main=${gOut(DUAL, 'rev-parse', 'main')}`);

// An untracked file with Cyrillic in its name — right here: git returns such a path
// octal-escaped by default, and the reviewer got a name in its prompt that doesn't
// exist on disk.
writeFileSync(path.join(DW, 'новая заметка.txt'), 'заметка\n');
// And a tracked one too — with the same name the bug reaches the diff body and the
// --stat summary, and the setting was only applied to one call out of three (review note).
writeFileSync(path.join(DW, 'закоммиченная заметка.txt'), 'в индексе\n');
g(DW, 'add', 'закоммиченная заметка.txt');
g(DW, 'commit', '-m', 'заметка в индексе', '-q');

const dual = planReview(WS, { target: DW, task: owned.id });
check(': the reviewer computes the base from the same branch spawn branches off',
  dual.baseRef === D1 && /merge-base with master/.test(String(dual.baseLine)), String(dual.baseLine));
check(`: the orchestrator's work on master does not land in the worker's diff`,
  !dual.diff.includes('ork.txt') && dual.diff.includes('rabota.txt'), dual.stat);
check(`: untracked files go to the reviewer under their own names, not octal-escaped`,
  dual.untracked.includes('новая заметка.txt') && !dual.untracked.some((f) => /\\3\d\d/.test(f)),
  JSON.stringify(dual.untracked));
check(`: the same name also appears in the reviewer's prompt — it's what it will read`,
  dual.prompt.includes('новая заметка.txt'),
  dual.prompt.split('\n').filter((l) => /заметк|\\3/.test(l)).join(' | '));
check('review note: a tracked file\'s name is not escaped in the diff body or in the summary',
  dual.diff.includes('закоммиченная заметка.txt') && dual.stat.includes('закоммиченная заметка.txt')
  && !/\\3\d\d/.test(dual.diff) && !/\\3\d\d/.test(dual.stat),
  `${dual.stat} | ${dual.diff.split('\n').filter((l) => /^\+\+\+|^---/.test(l)).join(' ')}`);

// --- a computed base isn't always better than a recorded one (review note) -------------
//
// Freshness alone doesn't mean accuracy. Two branches where the merge-base is worse
// than the recorded point: a rewritten local default branch (during the development
// phase a commit goes straight into main, and amending while workers are live is
// legitimate) and a worker's branch that's already been merged.
const REB = path.join(WS, 'repos', 'loads_search', 'rebase-api');
mkdirSync(REB, { recursive: true });
g(REB, 'init', '-b', 'main');
writeFileSync(path.join(REB, 'AGENTS.md'), 'Правила репозитория.\n');
g(REB, 'add', '.');
g(REB, 'commit', '-m', 'init', '-q');
writeFileSync(path.join(REB, 'ork.txt'), 'работа оркестратора\n');
g(REB, 'add', '.');
g(REB, 'commit', '-m', 'работа оркестратора', '-q');
const R_FORK = gOut(REB, 'rev-parse', 'HEAD');
const RW = path.join(REB, '.claude', 'worktrees', 'a2a-reb');
g(REB, 'worktree', 'add', '-q', '-b', 'worktree-a2a-reb', RW, 'main');
writeFileSync(path.join(RW, 'rabota.txt'), `работа worker'а\n`);
g(RW, 'add', '.');
g(RW, 'commit', '-m', `работа worker'а`, '-q');
store.upsertParticipant(home, owned.id, store.participantRecord('worker:reb', { repo: 'loads_search/rebase-api', repoAbs: REB,
  worktree: RW, worktreeName: 'a2a-reb', branch: 'worktree-a2a-reb', baseSha: R_FORK,
  name: 'Worker: переписанная база (0826-1200, reb)' }));
g(REB, 'commit', '--amend', '-q', '-m', 'работа оркестратора, переписанная');

check('fixture: the merge-base with the rewritten default branch moved back from the recorded point',
  gOut(RW, 'merge-base', 'main', 'HEAD') !== R_FORK, `${gOut(RW, 'merge-base', 'main', 'HEAD')} vs ${R_FORK}`);
const rewound = planReview(WS, { target: RW, task: owned.id });
check('review note: the computed base is behind the recorded one — the recorded one is taken',
  rewound.baseRef === R_FORK, `${rewound.baseRef} vs ${R_FORK}`);
check('review note: the orchestrator\'s work does not come back into the diff',
  !rewound.diff.includes('ork.txt') && rewound.diff.includes('rabota.txt'), rewound.stat);
check('review note: dest names the rewind as already-merged, not rewritten',
  /work already merged/.test(String(rewound.baseLine)),
  String(rewound.baseLine));

// The worker's branch was merged into the default branch — the normal end of a run.
// The merge-base becomes equal to HEAD, and the diff would be empty: re-review after a
// merge would stop working.
const MRG = path.join(WS, 'repos', 'loads_search', 'merged-api');
mkdirSync(MRG, { recursive: true });
g(MRG, 'init', '-b', 'main');
writeFileSync(path.join(MRG, 'AGENTS.md'), 'Правила репозитория.\n');
g(MRG, 'add', '.');
g(MRG, 'commit', '-m', 'init', '-q');
const M_FORK = gOut(MRG, 'rev-parse', 'HEAD');
const MW = path.join(MRG, '.claude', 'worktrees', 'a2a-mrg');
g(MRG, 'worktree', 'add', '-q', '-b', 'worktree-a2a-mrg', MW, 'main');
writeFileSync(path.join(MW, 'sdelano.txt'), `работа worker'а\n`);
g(MW, 'add', '.');
g(MW, 'commit', '-m', `работа worker'а`, '-q');
g(MRG, 'merge', '--ff-only', '-q', 'worktree-a2a-mrg');
store.upsertParticipant(home, owned.id, store.participantRecord('worker:mrg', { repo: 'loads_search/merged-api', repoAbs: MRG,
  worktree: MW, worktreeName: 'a2a-mrg', branch: 'worktree-a2a-mrg', baseSha: M_FORK,
  name: 'Worker: слитая ветка (0826-1200, mrg)' }));

check(`fixture: after the merge, the merge-base with the default branch equals the worker's HEAD`,
  gOut(MW, 'merge-base', 'main', 'HEAD') === gOut(MW, 'rev-parse', 'HEAD'));
const mergedBack = planReview(WS, { target: MW, task: owned.id });
check('review note: a merged branch is reviewed from the recorded point instead of yielding an empty diff',
  mergedBack.baseRef === M_FORK && mergedBack.diff.includes('sdelano.txt'),
  `${mergedBack.baseRef} · ${mergedBack.stat}`);
check('review note: the base line says the work is already merged',
  /work already merged/.test(String(mergedBack.baseLine)), String(mergedBack.baseLine));

// The same merged branch, but there's no branch point in the journal: the diff is
// honestly empty, and the command says why — "no changes — nothing to review" without
// an explanation would be a lie.
store.upsertParticipant(home, owned.id, store.participantRecord('worker:mrg', { repo: 'loads_search/merged-api', repoAbs: MRG,
  worktree: MW, worktreeName: 'a2a-mrg', branch: 'worktree-a2a-mrg',
  name: 'Worker: слитая ветка (0826-1200, mrg)' }));
const mergedNoBase = planReview(WS, { target: MW, task: owned.id });
check('review note: an empty diff on a merged branch is explained, not passed off as no work at all',
  (mergedNoBase.warnings ?? []).some((w) => /matches/.test(w) && /--base/.test(w))
  || /matches/.test(String(mergedNoBase.baseLine)),
  `${(mergedNoBase.warnings ?? []).join(' | ')} · ${mergedNoBase.baseLine}`);

// A fresh worktree where the worker hasn't committed anything yet: HEAD equals the
// default branch's tip and the recorded point at the same time. "work already merged"
// would be a lie here — nothing went into the default branch (review note).
const untouched = planReview(WS, { target: W3, task: owned.id });
check(`review note: for a worker with not a single commit, the base line does not promise merged work`,
  untouched.baseRef === FORK && !/already merged/.test(String(untouched.baseLine))
  && /worktree branch point of worker:tretiy/.test(String(untouched.baseLine)),
  String(untouched.baseLine));
// owned.id was kept active: the diff-base checks name it with an explicit `--task`, and
// a closed journal is now a refusal, not a fixture.
store.closeTask(home, owned.id);

// --- : the participant is written BEFORE claude launches ------------------------
//
// `fail()` terminates the process, so the refusal branch runs separately. The new task
// has already received a diff and configs; after a failed launch it should keep a
// reviewer record with no fabricated session, and the refusal should name the orphan
// and the exact cleanup.
const FAIL_TITLE = 'ревью, которое не поднялось';
claudeFails();
const failed = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(reviewUrl)});\n`
  + `await m.review(${JSON.stringify(WS)}, ${JSON.stringify({ target: REPO, title: FAIL_TITLE })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const failText = `${failed.stdout}${failed.stderr}`;
const orphanTask = store.activeTasks(home).find((t) => t.title === FAIL_TITLE);
const failedReviewer = store.participantOf(orphanTask, 'reviewer:cargos-api')?.metadata;
check(': a failed launch refuses instead of staying silent',
  failed.status === 1 && /claude --bg exited with code 1/.test(failText),
  `status=${failed.status} ${failText}`);
check(': the participant is recorded before launch and the session is not fabricated',
  !!failedReviewer && failedReviewer.repo === 'repos/loads_search/cargos-api'
  && failedReviewer.repoAbs === realpathSync(REPO) && failedReviewer.name?.startsWith('Review: ')
  && !failedReviewer.session, JSON.stringify(failedReviewer));
// review() itself sets the mark, not the test: without it a repeat of the command would
// take this record for a live reviewer and send the diff into a mailbox behind which
// there's nobody.
check(': a record from a failed launch is marked pending',
  failedReviewer?.pending === true, JSON.stringify(failedReviewer));
check(': the orphan task\'s diff and configs are kept for diagnostics',
  !!orphanTask
  && existsSync(path.join(store.filesDir(home, orphanTask.id), 'review-cargos-api.diff'))
  && existsSync(path.join(store.workersDir(home, orphanTask.id), 'reviewer-cargos-api.settings.json'))
  && existsSync(path.join(store.workersDir(home, orphanTask.id), 'reviewer-cargos-api.mcp.json')),
  String(orphanTask?.id));
check(': the refusal names the orphan and a ready-made close command',
  !!orphanTask && /active orphan task/.test(failText)
  && failText.includes(orphanTask.id)
  && failText.includes(`promptobus done --task ${orphanTask.id}`), failText);
if (orphanTask) store.closeTask(home, orphanTask.id);

// --- : the gate comes before opening the task and before raising the session ----------
//
// Checked through `review()`, not `planReview()`: it's specifically `review()` that
// opens the task. The gate itself doesn't call `fail()` — it throws from `planReview`,
// and the subprocess returns the exit code through an explicit catch. A separate
// process is needed not for the refusal but for its mutation: with the gate removed,
// this call reaches `claude --bg` and from there `fail()`, which carries the process
// away past the verdict summary — meaning in the shared process the check couldn't fail
// red honestly. The process's directory is a clone, the task name is given: without
// the gate, the call would open a task by the current directory exactly the way it
// happened on 2026-08-27.
const GATE_TITLE = 'ревью, которого не должно быть';
const activeBefore = store.activeTasks(home).length;
const gated = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(reviewUrl)});\n`
  + `try { await m.review(${JSON.stringify(WS)}, ${JSON.stringify({ title: GATE_TITLE })}); }\n`
  + 'catch (e) { console.error(e.message); process.exit(1); }',
], { encoding: 'utf8', cwd: REPO, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const gateText = `${gated.stdout}${gated.stderr}`;
check(': a call with no path from a clone directory refuses before anything else',
  gated.status === 1 && /repository path is required/.test(gateText), `status=${gated.status} ${gateText}`);
check(': no task is opened by the current directory',
  store.activeTasks(home).length === activeBefore
  && !store.activeTasks(home).some((t) => t.title === GATE_TITLE),
  String(store.activeTasks(home).length));

// The plan's refusal is printed and exited by the COMMAND: the plan only returns it as
// a field. Same trick, same reason — what's checked is `fail()`'s home, not the
// refusal's text, and it can only be seen by the process's exit code. Were
// `fail(plan.refusal)` to vanish from the start of `review()`, the command would carry
// on down the refusal-plan path and crash with a TypeError on `plan.warnings`: same
// exit code, different message, so both are checked.
const refused = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(reviewUrl)});\n`
  + `await m.review(${JSON.stringify(WS)}, ${JSON.stringify({ target: NOT_A_REPO })});`,
], { encoding: 'utf8', cwd: REPO, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const refusedText = `${refused.stdout}${refused.stderr}`;
check(': the plan\'s refusal is printed and exited by the command, not by the plan',
  refused.status === 1 && refusedText.includes(`${NOT_A_REPO}: not a git repository`)
  && !/TypeError|plan\.warnings/.test(refusedText),
  `status=${refused.status} ${refusedText}`);

// --- /: the reviewer is raised with the binary the resolve named ----
//
// A directory with a SECOND stand-in `claude` outside PATH: spawning the reviewer must
// take the path from the resolve, not the name from PATH. Otherwise the "search known
// locations" fix would have reached the worker and silently not reached the reviewer.
const ALT = path.join(SB, 'alt-bin');
const ALT_ARGV = path.join(SB, 'alt-argv.txt');
// This binary raises the session, while the `claude agents` list is asked from the one
// on PATH: the second fake sets the same raise mark, otherwise the raise check would
// declare the reviewer not raised on correct code.
stubCommand(ALT, 'claude', `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--bg') {
  writeFileSync(${JSON.stringify(ALT_ARGV)}, args.join(' '));
  writeFileSync(${JSON.stringify(BG_RAISED)}, args[args.indexOf('--name') + 1] ?? '');
}
process.stdout.write('[]');`);
const ALT_BIN = path.join(ALT, process.platform === 'win32' ? 'claude.cmd' : 'claude');
const altTask = store.createTask(home, { id: 't20260828-124500', title: 'ревью чужим бинарём' });
claudeSays('[]');
const altOut = await capture(() => review(WS, {
  target: REPO,
  task: altTask.id,
  tool: { ok: true, bin: ALT_BIN, version: '2.1.237', note: `claude not found in PATH — taken from ${ALT}` },
}));
check(`: the reviewer was raised by the binary from the resolve, not the same-named one from PATH`,
  existsSync(ALT_ARGV) && readFileSync(ALT_ARGV, 'utf8').includes('--bg'), String(existsSync(ALT_ARGV)));
check(`: the reviewer's binary found outside PATH is named in the output`,
  altOut.includes(ALT), altOut.split('\n').filter((l) => /claude/.test(l)).join(' | '));

// A version refusal carries the process away through fail() — a separate process, the
// same trick as the required-path gate below.
const oldTask = store.createTask(home, { id: 't20260828-124600', title: 'ревью на старом бинаре' });
const oldRun = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(reviewUrl)});
`
  + `await m.review(${JSON.stringify(WS)}, ${JSON.stringify({
    target: REPO,
    task: oldTask.id,
    tool: { ok: false, found: true, reason: 'Claude Code: найдена версия 2.1.100, нужна 2.1.169 или новее' },
  })});`,
], { encoding: 'utf8', cwd: SB, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const oldText = `${oldRun.stdout}${oldRun.stderr}`;
check(': a review on an old binary refuses with both versions named',
  oldRun.status === 1 && /2\.1\.100/.test(oldText) && /2\.1\.169/.test(oldText), `status=${oldRun.status} ${oldText}`);
check(`: a version refusal for the reviewer does not write to the journal`,
  !store.readTask(home, oldTask.id).participants.some((p) => String(store.addressOf(p)).startsWith('reviewer:')),
  JSON.stringify(store.readTask(home, oldTask.id).participants));

// --- : on a re-review the MCP set isn't announced -----------------------------
//
// The line describes what GOES to a participant. On a re-review no new session is
// raised, and `mcpConfigPath` isn't even rewritten — the live reviewer works with the
// old config, and the line would describe a set that doesn't exist. Its own task: an
// extra re-review would shift the mailbox counters of neighboring checks.
const reuseTask = store.createTask(home, { id: 't20260828-130000', title: 'переревью и набор MCP' });
const REUSE_SESSION = 'Review: переревью и набор MCP (0828-1300)';
store.upsertParticipant(home, reuseTask.id, store.participantRecord('reviewer:cargos-api', { repo: 'loads_search/cargos-api', name: REUSE_SESSION,
  session: 'cafe12' }));
claudeSays(JSON.stringify([{ id: 'cafe12', name: REUSE_SESSION, state: 'working', pid: 4242 }]));
const reuseRun = await capture(() => review(WS, { target: REPO, task: reuseTask.id }));
check(': on a re-review the line about the MCP set is not printed',
  /already on the bus/.test(reuseRun) && !/MCP the reviewer/.test(reuseRun),
  reuseRun.split('\n').filter((l) => /MCP|on the bus/.test(l)).join(' | '));
claudeSays('[]');

// --- : the ceiling on git's output ------------------------------------------------
//
// The git() wrapper went with `spawnSync`'s default ceiling — a megabyte. A real
// clone's list of untracked files (a build, an export, a directory with no .gitignore)
// blows past it easily: the process is killed by a signal, it has no status, stderr is
// empty — and the command used to crash with "git ls-files:" and an empty tail, i.e.
// with no reason at all. Here the list is deliberately bigger than a megabyte: long
// names are cheaper than a large file count.
// The paths are short on purpose (review note): a full path longer than MAX_PATH (260)
// wouldn't survive Windows, and the suite would fail red there on correct code — a
// class bug. The same overflow is reached by file count instead of path length.
const FLOOD = path.join(WS, 'repos', 'loads_search', 'flood-api');
const FLOOD_DIR = path.join(FLOOD, 'd'.repeat(30));
mkdirSync(FLOOD_DIR, { recursive: true });
g(FLOOD, 'init', '-b', 'master');
writeFileSync(path.join(FLOOD, 'AGENTS.md'), 'Правила репозитория.\n');
g(FLOOD, 'add', 'AGENTS.md');
g(FLOOD, 'commit', '-m', 'init', '-q');
g(FLOOD, 'update-ref', 'refs/remotes/origin/master', gOut(FLOOD, 'rev-parse', 'HEAD'));
// The number was picked by measurement: 14000 paths at 91 bytes each is 1.29 MB, and
// the git process gets killed by a signal before it finishes writing the output
// (`status` is then `null`, `stderr` is empty, and the old wrapper used to crash with
// an empty reason). A smaller overflow is harmful in a different way: `spawnSync`
// silently hands back truncated output, and the reviewer would get an incomplete list
// without a single word about it.
const FLOOD_N = 14000;
for (let i = 0; i < FLOOD_N; i += 1) {
  writeFileSync(path.join(FLOOD_DIR, `${'f'.repeat(50)}${String(i).padStart(6, '0')}.txt`), '');
}
// : the diff's name is chosen by the record, and the prompt is assembled by the plan
// before it — meaning the plan must be reassembled against the path that actually
// landed on disk. Its own task: raising a reviewer would shift the mailbox counters of
// neighboring checks.
const writtenTask = store.createTask(home, { id: 't20260829-113000', title: 'ревью и записанный дифф' });
let writtenPlan = null;
await capture(async () => { writtenPlan = await review(WS, { tool: TOOL, target: REPO, task: writtenTask.id }); });
check(': the prompt names the diff file that landed on disk, and it holds the same diff',
  !!writtenPlan && writtenPlan.prompt.includes(writtenPlan.diffPath)
  && existsSync(writtenPlan.diffPath)
  && readFileSync(writtenPlan.diffPath, 'utf8') === writtenPlan.diff,
  String(writtenPlan && writtenPlan.diffPath));
check(': the re-review message names the same file',
  !!writtenPlan && writtenPlan.reReview.includes(writtenPlan.diffPath),
  String(writtenPlan && writtenPlan.diffPath));
store.closeTask(home, writtenTask.id);

const floodTask = store.createTask(home, { id: 't20260829-120000', title: 'ревью клона с длинным перечнем' });
const flood = planReview(WS, { target: FLOOD, task: floodTask.id });
check(': an untracked-file list longer than a megabyte does not crash the command',
  flood.untracked.length === FLOOD_N, `${flood.untracked.length} of ${FLOOD_N}`);
store.closeTask(home, floodTask.id);

// PATH stayed swapped until the end: the scheduler checks liveness on every call
// against an already-opened participant, and the test shouldn't call a live claude for that.
process.env.PATH = PATH0;
rmSync(SB, { recursive: true, force: true });

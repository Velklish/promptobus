// Regression on the participant record that spawn itself writes. Run: npm test
//
// The neighboring promptobus.test.mjs takes the spawn PLAN under test and never reaches
// `spawnSync`: the coverage boundary there runs along the binary. Because of that the
// nine fields `upsertParticipant` puts into the task journal were checked by no test —
// the plan was checked, the plan write was not, and a drift between them would have
// been silent. A live case already passed nearby twice: one added `baseSha`, one —
// `title`, and both fields are covered only from the read side (`planReview` takes them
// from a planted journal).
//
// So here spawn is executed whole, and the boundary moves to two seams:
//
// - **git is real.** A clone with a local bare origin instead of the network:
//   `freshenRepo` does the same `fetch origin`, only over a path on disk, and
//   `createWorktree` opens a real branch and returns the real branch-point sha. There
//   is no git mock at all — what it actually does is checked.
// - **`claude` is stubbed on PATH.** The same trick and the same helper (`stubCommand`
//   from sandbox.mjs) as in promptobus-review.test.mjs: the script answers
//   `claude agents --json` with a given session list and `claude --bg` with a given
//   exit code. A live session is not started. The same way `npm` is stubbed in
//   worktree dependency-install checks: the real `npm` is never called.
import {
  chmodSync, mkdirSync, writeFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { resetCliCaches, stubCommand, writeHostConfig } from './sandbox.mjs';
import { capture, quiet } from './console.mjs';

// realpath: the planner canonicalizes the root (macOS: /var → /private/var), and the
// test expectations must be compared to canonical paths.
// A space in the sandbox name is not decoration: the command `--dry-run` prints goes
// to a person in the terminal, and checking its quoting on a path without spaces
// means not checking it at all (review note). The whole spawn is also run on a path
// with a space.
const SB = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-promptobus spawn-')));
const here = path.dirname(fileURLToPath(import.meta.url));
const spawnUrl = pathToFileURL(path.join(here, '..', 'lib', 'spawn.js')).href;
const {
  planSpawn, spawn: spawnRaw, repoSkillsLine, runRepoGenerator, sayWorktreeDeps, writeSecret,
  SKILL_KEYS, skillSettings,
} = await import(spawnUrl);
const stubClaude = () => path.join(BIN, process.platform === 'win32' ? 'claude.cmd' : 'claude');
const spawnWorker = (root, opts = {}) => spawnRaw(root, {
  tool: { ok: true, bin: stubClaude() },
  ...opts,
});
const { installWorktreeDeps, npmCiCommand } = await import(path.join(here, '..', 'lib', 'worktree.js'));
const { IDENTITY_VARS } = await import(path.join(here, 'hygiene.mjs'));
const { ULTRACODE_MIN_VERSION } = await import(path.join(here, '..', 'lib', 'driver-claude.js'));
const CLAUDE_MIN = '2.0.0';
function versionLess(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}
const store = await import(path.join(here, '..', 'lib', 'store.js'));
const { hostOf } = await import(path.join(here, '..', 'lib', 'host.js'));
const { GUARD_HOOK_EVENT, guardHookCommand, guardHookSettings } = await import(path.join(here, '..', 'dist', 'hooks.js'));
const { shellQuote } = await import(path.join(here, '..', 'lib', 'util.js'));

check(`: participant keys — skillOverrides, and spawn reads them from workspace settings`,
  SKILL_KEYS.length > 0 && SKILL_KEYS.includes('skillOverrides'),
  SKILL_KEYS.join(', '));


const g = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

// --- workspace with a real clone ----------------------------------------

const WS = path.join(SB, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(path.join(WS, 'AGENTS.md'), 'workspace\n');
writeHostConfig(WS, { tools: ['claude', 'cursor', 'codex'] });
mkdirSync(path.join(WS, '.claude'), { recursive: true });
writeFileSync(path.join(WS, '.claude', 'settings.json'), JSON.stringify({
  skillOverrides: { 'ненужный-скилл': 'off' },
}));
const settingsSample = skillSettings(WS);
check(': spawn reads skillOverrides from workspace settings',
  settingsSample.skillOverrides?.['ненужный-скилл'] === 'off',
  JSON.stringify(settingsSample));

// Origin is a bare repository on disk: `freshenRepo` talks to it with a real fetch,
// but never touches the network. With no origin at all the default branch would not
// be resolved, and the worktree would branch from HEAD — that is, a road life does
// not take would be checked.
const ORIGIN = path.join(SB, 'origin', 'cargos-api.git');
const SEED = path.join(SB, 'seed');
mkdirSync(ORIGIN, { recursive: true });
mkdirSync(SEED, { recursive: true });
spawnSync('git', ['init', '--bare', '-b', 'main', ORIGIN], { encoding: 'utf8' });
g(SEED, 'init', '-b', 'main');
writeFileSync(path.join(SEED, 'AGENTS.md'), 'Правила репозитория cargos-api.\n');
writeFileSync(path.join(SEED, 'a.txt'), 'v1\n');
g(SEED, 'add', '.');
g(SEED, 'commit', '-m', 'init', '-q');
g(SEED, 'remote', 'add', 'origin', ORIGIN);
g(SEED, 'push', '-q', 'origin', 'main');

const REPO = path.join(WS, 'cargos-api');

// Clone worktree directories are named by the task stamp, not by an assembled name.
// A name literal in a negative check idles in silence: half of such a pair ("worktree
// was not created") was already idle — the literal `a2a-ultra-ultracode-…` listed
// slugs in reverse order against the template `<task slug>-<worker slug>`, and a
// path that never exists the check honestly did not find. The task stamp always
// stands in the name and does not depend on the prefix.
const worktreesWithStamp = (stamp) => {
  const dir = path.join(REPO, '.claude', 'worktrees');
  return (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.includes(stamp));
};
spawnSync('git', ['clone', '-q', ORIGIN, REPO], { encoding: 'utf8' });

const BRIEF = path.join(SB, 'brief.md');
writeFileSync(BRIEF, '# Добавить поле source в событие CargoCreated\n\nПравки в контракте и публикации.\n');

// --- stubbed claude --------------------------------------------------------

const BIN = path.join(SB, 'bin');
mkdirSync(BIN, { recursive: true });
const PATH0 = process.env.PATH;
// One script for both calls: `claude agents --json` is asked by awaitSession,
// `claude --bg …` starts the session. We tell them apart by the first argument —
// the same way the binary itself does. `bgStatus` sets the launch outcome: 0 —
// it came up, otherwise the refusal branch. `--version` is asked by binary
// resolve: spawn no longer launches the first `claude` it finds, it checks its
// version against the declared minimum.
//
// The scenario is JS through the shared sandbox helper (sandbox.mjs), not a raw
// `#!/bin/sh`: a file with no extension is not found on Windows at all
// (`resolveCommand` walks PATH × PATHEXT), and the test would go red there on
// working code.
const claudeSays = (sessions, bgStatus = 0, version = '2.1.237 (Claude Code)') => {
  stubCommand(BIN, 'claude', `const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write(${JSON.stringify(`${version}\n`)}); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(JSON.stringify(sessions))}); process.exit(0); }
process.stdout.write('backgrounded · sess-0001\\n');
process.exit(${bgStatus});`);
  process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
};

// --- participant record on a successful spawn ------------------------------------

const HOME = store.promptobusHome(WS, hostOf(WS));
const TASK = 'sobytie-t20260827-120000';
// We create the task ourselves: a new one's id is assembled from the current
// second, and the session name computed before spawn for the stubbed `claude`
// would diverge from the one computed inside.
store.createTask(HOME, {
  id: TASK, title: 'событие CargoCreated в двух сервисах', slug: 'sobytie', stamp: 't20260827-120000',
});

const opts = { repo: 'cargos-api', brief: BRIEF, task: TASK, effort: 'high' };
const plan = await planSpawn(WS, opts);
const SESSION_ID = 'sess-0001';
claudeSays([{ id: SESSION_ID, name: plan.name, state: 'working', pid: 4242 }]);

const lifted = await capture(() => spawnWorker(WS, opts));

// Mechanism fields live in the v1 record `metadata`: the adapter writes them and
// reads them.
const record = store.participantOf(store.readTask(HOME, TASK), 'worker:cargos-api');
const written = record?.metadata;
check(': spawn wrote the participant into the task journal', !!written, JSON.stringify(written));
// Nine fields by name. Checking them as one string is not allowed: a drift on one
// field must name itself, not hide behind a shared "objects are not equal".
check(': name — what went into --name, participants are looked up by it in claude agents',
  written?.name === plan.name && plan.argv[plan.argv.indexOf('--name') + 1] === plan.name, written?.name);
check(': worktreeName — the machine string the directory and branch are made from',
  written?.worktreeName === plan.wtName && plan.branch.endsWith(plan.wtName), written?.worktreeName);
check(': baseSha — the real branch sha, not the base name',
  /^[0-9a-f]{40}$/.test(written?.baseSha ?? '')
  && written.baseSha === spawnSync('git', ['-C', REPO, 'rev-parse', plan.branch], { encoding: 'utf8' }).stdout.trim(),
  written?.baseSha);
check(': title — the work-slice title, the session name is assembled from it',
  written?.title === plan.workTitle && plan.name.includes(written.title), written?.title);
check(': session — the identifier from claude agents, not from parsing output',
  written?.session === SESSION_ID, written?.session);
check(`: branch — the branch spawn opened`,
  written?.branch === plan.branch && plan.branch.startsWith('worktree-'), written?.branch);
check(': worktree — the absolute directory path, and the directory exists',
  written?.worktree === plan.worktreePath && path.isAbsolute(written.worktree) && existsSync(written.worktree),
  written?.worktree);
check(': repoAbs — the absolute clone path, the repository is named by the short name too',
  written?.repoAbs === REPO && written?.repo === 'cargos-api', `${written?.repoAbs} · ${written?.repo}`);
check(': model and effort — the ones that went into the command',
  written?.model === 'opus' && written?.effort === 'high'
  && plan.argv.includes('--effort') && plan.argv[plan.argv.indexOf('--effort') + 1] === 'high',
  `${written?.model} · ${written?.effort}`);
// Permission mode: without the flag the worker goes to `auto`, the flag overrides
// for one spawn, an unknown value refuses before lift (the no-stack check is below,
// together with --effort).
check(': without --permission-mode the worker is lifted in auto — the mode stands in argv explicitly',
  plan.permissionMode === 'auto' && plan.argv[plan.argv.indexOf('--permission-mode') + 1] === 'auto',
  `${plan.permissionMode} · ${plan.argv.join(' ')}`);
const bypass = await planSpawn(WS, { ...opts, worker: 'bypass', permissionMode: 'bypassPermissions' });
check(': --permission-mode overrides the mode for one spawn and goes into argv',
  bypass.permissionMode === 'bypassPermissions'
  && bypass.argv[bypass.argv.indexOf('--permission-mode') + 1] === 'bypassPermissions', bypass.argv.join(' '));
// Fields the plan does not invent: without --effort there is none at all, not an
// empty string.
check(': started — lift time in ISO', typeof written?.started === 'string'
  && !Number.isNaN(Date.parse(written.started)), written?.started);
// Journal and git must say the same: the branch from the record is checked out in
// its own directory.
check(': the record agrees with git — the worktree directory is on the recorded branch',
  spawnSync('git', ['-C', written.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' })
    .stdout.trim() === written.branch);

// --- : the brief stays with the task ------------------------------------------------
//
// The file `--brief` names belongs to the orchestrator and is temporary; the assignment
// itself is the one document that explains a branch months later. After the lift the bus
// holds its own copy in the task files folder, next to the review diffs, and the lift
// output names the path — otherwise a person reading the journal has the diff and not
// what it was made by.
const briefKept = path.join(store.filesDir(HOME, TASK), 'brief-cargos-api.md');
check(': the brief is kept in the task files, and the text is the one that was passed',
  existsSync(briefKept)
  && readFileSync(briefKept, 'utf8').trim() === readFileSync(BRIEF, 'utf8').trim(),
  existsSync(briefKept) ? readFileSync(briefKept, 'utf8') : `${briefKept} does not exist`);
check(': the lift output names the path the brief landed at',
  lifted.includes(briefKept), lifted.split('\n').filter((l) => /brief/.test(l)).join(' | '));

// The copy is made when the worker is ALREADY up, and it is the last thing spawn does:
// after the warden. A write refusal there must not end the command with a running
// session, no report and no route back — what is lost is a copy, the orchestrator still
// holds the file it passed. `chmod` is the only way to refuse the write, and on Windows
// a read-only directory does not stop one — there the case is unreachable, not skipped
// silently.
if (process.platform !== 'win32') {
  const RO_TASK = 'readonly-t20260902-110000';
  store.createTask(HOME, {
    id: RO_TASK, title: 'a files folder that cannot be written', slug: 'readonly', stamp: 't20260902-110000',
  });
  const roOpts = { repo: 'cargos-api', brief: BRIEF, task: RO_TASK, worker: 'kept' };
  const roPlan = await planSpawn(WS, roOpts);
  claudeSays([{ id: 'sess-ro', name: roPlan.name, state: 'working', pid: 4711 }]);
  resetCliCaches();
  const roFiles = store.filesDir(HOME, RO_TASK);
  chmodSync(roFiles, 0o500);
  let roText = '';
  let roThrew = '';
  try {
    roText = await capture(() => spawnWorker(WS, roOpts));
  } catch (e) {
    roThrew = e.message;
  } finally {
    chmodSync(roFiles, 0o700);
  }
  check(': a files folder that cannot be written costs the brief, not the lift',
    !roThrew && /the brief was not kept: /.test(roText)
    && /the participant is up, spawn is not rolled back for this/.test(roText),
    roThrew || roText.split('\n').filter((l) => /brief/.test(l)).join(' | ') || roText);
  // The warden stands BEFORE the copy, and the driver's liftoff line AFTER it: the line
  // being printed is the proof the tail of the command ran past the failed write, rather
  // than the process leaving through the throw.
  check(': after the failed copy the command runs to the end — the warden and the liftoff line are past it',
    roText.includes('backgrounded') && !existsSync(path.join(roFiles, 'brief-kept.md')),
    roText.split('\n').slice(-4).join(' | '));
  resetCliCaches();
  claudeSays([{ id: SESSION_ID, name: plan.name, state: 'working', pid: 4242 }]);
}


// --- : participant mcp-config permissions --------------------------------------
//
// The config holds substituted tokens — that is why spawn output does not print
// them — and the file used to land as `-rw-r--r--` and was readable by any user
// on the machine. Both steps of the fix are checked: the mode on create and
// `chmod` on rewrite. The second is needed on its own — `mode` on `writeFileSync`
// only works on CREATE, and a repeat spawn (the normal restart of a dead worker)
// would otherwise leave the former 0644 forever.
const modeOf = (f) => statSync(f).mode & 0o777;
check(`: the worker's mcp-config is created with 0600 permissions`,
  modeOf(plan.mcpConfigPath) === 0o600, modeOf(plan.mcpConfigPath).toString(8));
check(': the config really carries what the permissions are closed for — the participant bus env',
  JSON.parse(readFileSync(plan.mcpConfigPath, 'utf8')).mcpServers['promptobus'].env.PROMPTOBUS_TASK === TASK);
// Rewrite is checked by the write itself, not by a second spawn: a repeat spawn
// of a live worker is a refusal, and it never reaches the config write.
chmodSync(plan.mcpConfigPath, 0o644);
writeSecret(plan.mcpConfigPath, readFileSync(plan.mcpConfigPath, 'utf8'));
check(': a rewrite repairs permissions of an already-lying config, rather than leaving 0644',
  modeOf(plan.mcpConfigPath) === 0o600, modeOf(plan.mcpConfigPath).toString(8));
// The settings file carries no secrets, and the fix does not touch its permissions —
// otherwise the check above would pass on "closed everything in a row". We compare
// to a CONTROL file written next to it with ordinary `writeFileSync`, not to a
// constant (review note): under `umask 077` an ordinary write yields exactly 0600,
// and a check against a number would go red for no reason. The reverse ("the config
// differs from the control") is not asserted here for the same reason: under
// `umask 077` it does not differ, and closedness of the config is held by the
// check above — 0600 stands there as an explicit `chmod` and does not depend on
// umask at all.
const CONTROL = path.join(path.dirname(plan.settingsPath), 'control.json');
writeFileSync(CONTROL, '{}\n');
check(': the participant settings file did not change permissions — it matches an ordinary write next to it',
  modeOf(plan.settingsPath) === modeOf(CONTROL),
  `settings ${modeOf(plan.settingsPath).toString(8)} · control ${modeOf(CONTROL).toString(8)}`);

// /: the participant settings file carries the loop-guard Stop hook. The hook
// from the workspace `.claude/settings.json` does not reach the participant
// session — its cwd is in the clone worktree. The FILE is checked, not the plan:
// `--settings` is read by the harness from disk, and if they drifted nobody would
// notice. The command is checked against the same function that puts the hook on
// the orchestrator: a second copy is not opened here — a drift of the two
// commands is exactly what is caught.
//
// : the participant command carries their IDENTITY — address, task, and home.
// That is its only path to the hook: a background session gets its environment
// from the daemon, and putting it there would mean handing a foreign address to
// neighbors.
const written426 = JSON.parse(readFileSync(plan.settingsPath, 'utf8'));
const guardGroup = written426.hooks?.[GUARD_HOOK_EVENT]?.[0]?.hooks?.[0];
const guardIdentity = { address: plan.address, taskId: plan.taskId, home: plan.home };
const wsHost = hostOf(WS);
check(': the participant settings file carries the loop-guard Stop hook — the same command as the layout\'s',
  guardGroup?.type === 'command'
  && guardGroup?.command === guardHookCommand(wsHost, guardIdentity),
  JSON.stringify(written426.hooks ?? null));
check('SessionStart is not put on the participant — the detector looks at the workspace root',
  written426.hooks?.SessionStart === undefined,
  JSON.stringify(written426.hooks ?? null));
check(': the participant hook command carries their identity as arguments, the layout hook does not',
  guardGroup?.command?.includes(` --role ${shellQuote(plan.address)} --task ${shellQuote(plan.taskId)}`
    + ` --home ${shellQuote(plan.home)}`)
  && !guardHookSettings(wsHost)[GUARD_HOOK_EVENT][0].hooks[0].command.includes('--role'),
  `${guardGroup?.command} · layout: ${guardHookSettings(wsHost)[GUARD_HOOK_EVENT][0].hooks[0].command}`);
// Review note: values are quoted, not wrapped in double quotes — inside those the
// shell expands `$`. This file's sandbox already has a space in the name (see the
// header), and `--home` in the command must arrive in single quotes, not split
// across arguments.
check(': a value with a space went into the hook command quoted, not as two arguments',
  / --home '[^']*promptobus-promptobus spawn[^']*'/.test(guardGroup?.command ?? ''),
  String(guardGroup?.command));

// --- : --task-title travels from the command line to the journal --------------
//
// The neighboring cli-flags.test.mjs checks that the flag survives parse; here —
// that it reaches the work. Between those two points it has two traps, both
// silent: the `...values` spread puts the kebab key past the library options, and
// `planSpawn` reads `opts.taskTitle`. A run of the real command, not a library
// call.
const CLI = path.join(here, '..', 'bin', 'promptobus.js');

// --- : flag-parse refusals — by the real command, no stack -------------
//
// The top-level catch lives only in a separate CLI process: a direct function
// call can check the throw class, but not the form a person sees. One run per
// reachable parse entry; for --brief both file branches are checked extra.
const cliRun = (args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', cwd: WS, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}`, ...env },
  });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};
const noStack = (run) => run.status === 1 && !/\n\s+at /.test(run.text) && !/^Error:/m.test(run.text);
const EMPTY_BRIEF = path.join(SB, 'empty-brief.md');
writeFileSync(EMPTY_BRIEF, '');
const briefRefusals = [
  cliRun([ 'spawn', '--repo', 'cargos-api', '--dry-run']),
  cliRun([ 'spawn', '--repo', 'cargos-api', '--brief', path.join(SB, 'net-briefa.md'), '--dry-run']),
  cliRun([ 'spawn', '--repo', 'cargos-api', '--brief', EMPTY_BRIEF, '--dry-run']),
];
check(': --brief — missing, nonexistent, and empty file are printed without a stack',
  briefRefusals.every(noStack)
  && /needed --brief/.test(briefRefusals[0].text)
  && /no assignment file/.test(briefRefusals[1].text)
  && /assignment file is empty/.test(briefRefusals[2].text),
  briefRefusals.map((r) => `status=${r.status} ${r.text}`).join(' | '));

const goneSub = cliRun([ 'wait', '--timeout', '10m'], {
  PROMPTOBUS_HOME: HOME, PROMPTOBUS_TASK: TASK, PROMPTOBUS_ROLE: 'orchestrator',
});
check(': the removed wait subcommand — unknown-command refusal, no stack and no help about it',
  noStack(goneSub) && /unknown command "wait"/.test(goneSub.text)
  && !/promptobus wait/.test(goneSub.text),
  `status=${goneSub.status} ${goneSub.text}`);

const badOlderThan = cliRun([ 'prune', '--older-than', '0d']);
check(': prune --older-than with an invalid age is printed without a stack',
  noStack(badOlderThan) && /--older-than <days>/.test(badOlderThan.text),
  `status=${badOlderThan.status} ${badOlderThan.text}`);

const badEffort = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF, '--task', TASK,
  '--worker', 'bad-effort', '--effort', 'turbo', '--dry-run',
]);
check(': spawn --effort with an unknown value is printed without a stack',
  noStack(badEffort) && /--effort: unknown value "turbo"/.test(badEffort.text),
  `status=${badEffort.status} ${badEffort.text}`);
const badMode = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF, '--task', TASK,
  '--worker', 'bad-mode', '--permission-mode', 'svoy', '--dry-run',
]);
check(': spawn --permission-mode with an unknown value refuses without a stack and names the list',
  noStack(badMode) && /--permission-mode: unknown value "svoy"/.test(badMode.text) && /bypassPermissions/.test(badMode.text),
  `status=${badMode.status} ${badMode.text}`);

const badWorker = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF, '--task', TASK,
  '--worker', '!!!', '--dry-run',
]);
check(': spawn --worker with an invalid name is printed without a stack',
  noStack(badWorker) && /--worker "!!!" does not yield a worker name/.test(badWorker.text),
  `status=${badWorker.status} ${badWorker.text}`);

// --- : explicit --task with no journal — by the real command, no stack ----------
//
// The planner checks `taskExists` itself and used to throw a bare `Error`: a typo
// in the id arrived with a stack, even though `resolveTaskId` / `promptobus status`
// on the same text already use `GateError`. The top-level catch is only in a
// separate CLI process, as above.
const missingSpawnTask = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF,
  '--task', 'net-takoy-bl394', '--dry-run',
]);
check(': spawn --task of a nonexistent task is printed without a stack',
  noStack(missingSpawnTask) && /task net-takoy-bl394 does not exist/.test(missingSpawnTask.text),
  `status=${missingSpawnTask.status} ${missingSpawnTask.text}`);

const DONE_TASK = 'bl-394-zakryta-t20260831-120000';
store.createTask(HOME, {
  id: DONE_TASK, title: 'закрытая задача ', slug: 'bl-394-zakryta', stamp: 't20260831-120000',
});
store.closeTask(HOME, DONE_TASK);
const closedSpawnTask = cliRun([
  'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF,
  '--task', DONE_TASK, '--dry-run',
]);
check(': spawn --task of a closed task is printed without a stack',
  noStack(closedSpawnTask) && /task bl-394-zakryta-t20260831-120000 is closed/.test(closedSpawnTask.text),
  `status=${closedSpawnTask.status} ${closedSpawnTask.text}`);

// Only spawn without `--task` opens a new task, and by this point in the file
// active tasks already exist — the command would sit in one of them and never
// reach the new-task title. So for the run they are closed and put back as they
// were. The edit goes past the door: `closeTask` is irreversible, and the
// mechanism has no command that returns a task to active.
const setStatus = (id, status) => {
  const file = store.taskFile(HOME, id);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), status }, null, 2) + '\n');
};
const activeNow = store.activeTasks(HOME).map((t) => t.id);
for (const id of activeNow) setStatus(id, 'done');
const cliDry = spawnSync(process.execPath, [
  CLI, 'promptobus', 'spawn', '--repo', 'cargos-api', '--brief', BRIEF,
  '--task-title', 'Заход по бэклогу: spawn, ожидание, резолв', '--dry-run',
], { encoding: 'utf8', cwd: WS, env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
for (const id of activeNow) setStatus(id, 'active');
const cliText = `${cliDry.stdout}${cliDry.stderr}`;
check(': --task-title travels from the command line to the task title',
  cliDry.status === 0 && cliText.includes('will be created: Заход по бэклогу: spawn, ожидание, резолв'),
  `status=${cliDry.status} ${cliText}`);
// The SLICE title stays the slice title — the session name is assembled from it.
check(': --task-title does not replace the work-slice title in the session name',
  cliText.includes('Worker: Добавить поле source в событие CargoCreated'),
  cliText.split('\n').filter((l) => /session/.test(l)).join(' | '));

// --- : a foreign task and a pinned title — by the real command --------
//
// The subject is the same as the plan in promptobus.test.mjs, but OUTPUT is
// checked. The refusal and the warning are printed by `spawn`, not the plan:
// leave them as plan fields — and both silences the task was opened for return
// exactly where a person reads them.
const GUARD_TASK = 'bl-232-chuzhaya-t20260828-123535';
const GUARD_TITLE = 'Заход 0828c: справочник, живость цикла, правила';
store.createTask(HOME, {
  id: GUARD_TASK,
  title: GUARD_TITLE,
  adapter: { slug: 'bl-232-chuzhaya', stamp: 't20260828-123535', titleExplicit: true },
  owner: 'sess-hozyain',
});
// There must be one active task: spawn without `--task` sits in the only one, and
// with several it would refuse with a list — that is, not the refusal we check.
const guardOthers = store.activeTasks(HOME).map((t) => t.id).filter((id) => id !== GUARD_TASK);
for (const id of guardOthers) setStatus(id, 'done');
// Session identity is put into the child-process environment: `sessionIdentity`
// reads `CLAUDE_CODE_SESSION_ID`, and without the substitution the check would
// depend on who started the run.
const guardRun = (session, ...args) => {
  const r = spawnSync(process.execPath, [CLI, 'spawn', '--repo', 'cargos-api', '--brief', BRIEF, ...args],
    { encoding: 'utf8', cwd: WS, env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, PATH: `${BIN}${path.delimiter}${PATH0}` } });
  return { status: r.status, text: `${r.stdout}${r.stderr}` };
};
const foreignRun = guardRun('sess-gost', '--dry-run');
check(`: the command refuses a foreign spawn without --task — owner, title, and route in the text`,
  foreignRun.status === 1 && foreignRun.text.includes('sess-hozyain') && foreignRun.text.includes('sess-gost')
  && foreignRun.text.includes(GUARD_TITLE) && foreignRun.text.includes(`--task ${GUARD_TASK}`)
  && foreignRun.text.includes('mailbox {claim: true}') && foreignRun.text.includes('spawn with --new-task')
  && foreignRun.text.includes(`that track's messages`)
  && /finished by its owner/.test(foreignRun.text),
  `status=${foreignRun.status} ${foreignRun.text}`);
// : the same refusal, but its FORM is checked. It lives in `planSpawn`, which is
// also called as a pure function — `fail()` is not available there, and the
// expected-outcome mark is the `GateError` class; the top-level catch of
// `agents.js` recognizes it by name and does not print the stack. Without the
// mark the most common legal bus outcome arrived at the orchestrator as
// `Error: task…` with four stack lines, i.e. looked like an internal CLI break.
check(': the owner-gate refusal is printed without a stack — a legal outcome, not a break',
  foreignRun.status === 1 && !/\n\s+at /.test(foreignRun.text) && !/^Error:/m.test(foreignRun.text),
  `status=${foreignRun.status} ${foreignRun.text}`);

// --- : explicit and automatic new run --------------------------------
//
// One foreign active stays a gate without the flag. `--new-task` is an explicit
// fork, and with two actives and no bind there is still no choice to sit in, so
// a new task becomes the automatic outcome.
const forkRun = guardRun('sess-gost', '--new-task', '--worker', 'fork', '--dry-run');
check(': --new-task opens a separate task next to one foreign one',
  forkRun.status === 0 && /will be created:/.test(forkRun.text)
  && !forkRun.text.includes(`task: ${GUARD_TASK}`),
  `status=${forkRun.status} ${forkRun.text}`);

const incompatibleNewTask = guardRun('sess-gost', '--new-task', '--task', GUARD_TASK, '--dry-run');
check(': --new-task is incompatible with --task and refuses without a stack',
  noStack(incompatibleNewTask) && /--new-task is incompatible with --task/.test(incompatibleNewTask.text),
  `status=${incompatibleNewTask.status} ${incompatibleNewTask.text}`);

store.bindSession(HOME, GUARD_TASK, 'sess-hozyain');
const boundNewTask = guardRun('sess-hozyain', '--new-task', '--dry-run');
check(': a live binding does not jump into a new run',
  noStack(boundNewTask) && boundNewTask.text.includes(GUARD_TASK)
  && /promptobus done/.test(boundNewTask.text) && /another session/.test(boundNewTask.text),
  `status=${boundNewTask.status} ${boundNewTask.text}`);

const SECOND_ACTIVE = 'bl-389-vtoraya-t20260831-120000';
store.createTask(HOME, {
  id: SECOND_ACTIVE, title: 'вторая активная задача', slug: 'bl-389-vtoraya',
  stamp: 't20260831-120000', owner: 'sess-drugaya',
});
const automaticNewTask = guardRun('sess-bez-privyazki', '--worker', 'avto', '--dry-run');
check(': two actives with no binding automatically open a new task',
  automaticNewTask.status === 0 && /will be created:/.test(automaticNewTask.text)
  && !automaticNewTask.text.includes(`task: ${GUARD_TASK}`)
  && !automaticNewTask.text.includes(`task: ${SECOND_ACTIVE}`),
  `status=${automaticNewTask.status} ${automaticNewTask.text}`);

const manyForOtherCommands = cliRun([ 'done'], { CLAUDE_CODE_SESSION_ID: 'sess-bez-privyazki' });
check(': a refusal of other commands with several actives names the --new-task entry',
  noStack(manyForOtherCommands) && manyForOtherCommands.text.includes(GUARD_TASK)
  && manyForOtherCommands.text.includes(SECOND_ACTIVE)
  && manyForOtherCommands.text.includes('promptobus spawn --new-task'),
  `status=${manyForOtherCommands.status} ${manyForOtherCommands.text}`);

const keptRun = guardRun('sess-gost', '--task', GUARD_TASK, '--worker', 'yavno',
  '--task-title', 'LS-235543: флаги refresh в cargos-api', '--dry-run');
check(': an explicit --task passes, and --task-title prints a warning and does not touch the title',
  keptRun.status === 0 && keptRun.text.includes('--task-title ignored')
  && keptRun.text.includes(GUARD_TITLE) && !keptRun.text.includes('will be renamed')
  && store.readTask(HOME, GUARD_TASK).title === GUARD_TITLE,
  `status=${keptRun.status} ${keptRun.text}`);
// : the same command from the mailbox OWNER restamps the title — double
// explicitness, `--task` plus `--task-title`. The subject is the same as the
// refusal above — print; under `--dry-run` the journal is not touched at all, and
// the title on disk must stay as it was.
const RESTAMP_TITLE = 'Заход 0828c: справочник и живость цикла';
const stampRun = guardRun('sess-hozyain', '--task', GUARD_TASK, '--worker', 'peresh',
  '--task-title', RESTAMP_TITLE, '--dry-run');
check(': the owner with an explicit --task sees the rename, not a warning',
  stampRun.status === 0 && stampRun.text.includes(`will be renamed: ${RESTAMP_TITLE}`)
  && !stampRun.text.includes('--task-title ignored')
  && store.readTask(HOME, GUARD_TASK).title === GUARD_TITLE,
  `status=${stampRun.status} ${stampRun.text}`);
store.closeTask(HOME, GUARD_TASK);
store.closeTask(HOME, SECOND_ACTIVE);
const afterClosedBinding = guardRun('sess-hozyain', '--dry-run');
check(': a closed binding is not counted as live and does not block the next task',
  afterClosedBinding.status === 0 && /will be created:/.test(afterClosedBinding.text),
  `status=${afterClosedBinding.status} ${afterClosedBinding.text}`);
for (const id of guardOthers) setStatus(id, 'active');

// --- : an ambiguous name prints candidates, not [object Object] ------
//
// Candidates in `ResolveError` are DATA `{ nsPath, kind, personal }`, not ready
// strings: `formatCandidate` prints them (`resolve.js`). Spawn
// printed them by template substitution, i.e. would have given `[object Object]` —
// the orchestrator would have nothing to pick. The check looks at the candidate
// STRING, not at the fact of refusal: the fact of refusal is the same on a broken
// variant too.
const missingRepo = await planSpawn(WS, { repo: 'no-such-repo', brief: BRIEF })
  .then(() => '', (e) => e.message);
check(': an unknown repository name names the path, not [object Object]',
  /was not found on disk/.test(missingRepo)
  && missingRepo.includes('no-such-repo')
  && !missingRepo.includes('[object Object]'), missingRepo);

// --- : grafting a track appends the task title -----------------------
//
// The plan is checked by the neighboring promptobus.test.mjs; here the subject
// is the journal: the task title must travel to disk, otherwise a run of three
// tracks would stay the work of one.
const BRIEF2 = path.join(SB, 'brief2.md');
writeFileSync(BRIEF2, '# Резолв имени репозитория\n\nВторая линия того же захода.\n');
const opts2 = { repo: 'cargos-api', brief: BRIEF2, task: TASK, worker: 'resolve' };
const plan2 = await planSpawn(WS, opts2);
claudeSays([
  { id: SESSION_ID, name: plan.name, state: 'working', pid: 4242 },
  { id: 'sess-0002', name: plan2.name, state: 'working', pid: 4243 },
]);
// Between the CALLER's plan and the write a third track is grafted — that is how
// a neighboring spawn of the same run looks when it got ahead. What is checked
// here should be named exactly: `spawn()` recomputes the plan inside itself, so
// this is not a race reproduction, it is a through-path check — that the journal
// gets the assembly from the journal and the grafted track does not vanish from
// it. The fork "passed string versus recalc under the lock" is closed by the
// direct `retitleTask` check in promptobus.test.mjs, and the form of the intent
// — a check there too: one side was not enough, the second round fell on it.
store.upsertParticipant(HOME, TASK, store.participantRecord('worker:sosed', { repo: 'cargos-api', title: 'Линия соседа',
  name: 'Worker: Линия соседа (0827-1200)' }));
await quiet(() => spawnWorker(WS, opts2));
check(': the journal got the assembly from the journal, not the prediction from the caller plan',
  store.readTask(HOME, TASK).title
    === 'Добавить поле source в событие CargoCreated · Линия соседа · Резолв имени репозитория',
  `${store.readTask(HOME, TASK).title} · prediction was "${plan2.retitle?.preview}"`);
check(': a track grafted after the plan was not lost from the title',
  store.readTask(HOME, TASK).title.includes('Линия соседа')
  && !plan2.retitle.preview.includes('Линия соседа'),
  `${store.readTask(HOME, TASK).title} · ${plan2.retitle?.preview}`);
check(': the title is assembled, not set by a person — there is no explicit mark',
  store.readTask(HOME, TASK).adapter.titleExplicit === undefined,
  String(store.readTask(HOME, TASK).adapter.titleExplicit));
// Session names stay SLICE titles: renaming the task does not touch them — they
// are already in the journal.
check(`: track session names were not rewritten by the task title`,
  store.participantOf(store.readTask(HOME, TASK), 'worker:cargos-api').metadata.name === plan.name
  && store.participantOf(store.readTask(HOME, TASK), 'worker:resolve').metadata.name === plan2.name);

// --- : old binary — version refusal, before a write to disk ----------------
//
// The refusal takes the process through fail(), so spawn is executed in a
// separate process. We look at two things at once: what was said and what stayed
// on disk after that.
const OLD_TASK = 'staryy-t20260827-140000';
store.createTask(HOME, {
  id: OLD_TASK, title: 'spawn на старом бинаре', slug: 'staryy', stamp: 't20260827-140000',
});
claudeSays([], 0, '2.1.100 (Claude Code)');
// Standalone resolveToolBin does not probe --version. The version gate is the
// tool object spawn already accepts: pass the declared HostToolBin refusal.
const oldTool = {
  ok: false, found: true, version: '2.1.100',
  reason: 'Claude Code: found version 2.1.100, need 2.1.169 or newer',
};
const oldRun = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({ repo: 'cargos-api', brief: BRIEF, task: OLD_TASK, worker: 'staryy', tool: oldTool })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const oldText = `${oldRun.stdout}${oldRun.stderr}`;
check(': the refusal names the version, not an unknown flag',
  oldRun.status === 1 && /2\.1\.100/.test(oldText) && /2\.1\.169/.test(oldText) && !/unknown flag/.test(oldText),
  `status=${oldRun.status} ${oldText}`);
// The same text must not arrive twice in a row, ⚠ and ✖: for `note` `sayTool`
// moved in front of the refusal, but the reason is printed by `fail`, not by it.
check(': the refusal reason is printed once, not as a warning and a refusal in a row',
  (oldText.match(/found version 2\.1\.100/g) ?? []).length === 1,
  oldText.split('\n').filter((l) => /2\.1\.100/.test(l)).join(' | '));
check(': nothing is opened on disk — neither a participant nor a worktree',
  !store.readTask(HOME, OLD_TASK).participants.some((p) => store.addressOf(p) === 'worker:staryy')
  && worktreesWithStamp('t20260827-140000').length === 0,
  `${JSON.stringify(store.readTask(HOME, OLD_TASK).participants)} · ${worktreesWithStamp('t20260827-140000')}`);

// --- : `--effort ultracode` on a binary older than the bound ---------------------
//
// The refusal is pointed: the same binary without `ultracode` spawn passes, so we
// check both sides — otherwise the gate could turn out to be a lift of the shared
// minVersion under another name. The refusal takes the process through fail(), so
// spawn is executed in a separate process.
const ULTRA_TASK = 'ultracode-t20260828-170000';
store.createTask(HOME, {
  id: ULTRA_TASK, title: 'ultracode на старом бинаре', slug: 'ultracode', stamp: 't20260828-170000',
});
const spawnRun = (opts) => spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify(opts)});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
// Fixture premise: the version must pass the shared minimum and NOT pass the
// ultracode threshold. If both numbers matched, both checks below would go green
// on nothing, and there would be no way to see that from their verdicts (review
// note).
check(': the declared claude minimum is strictly older than the ultracode minimum — there is something to tell apart',
  versionLess(CLAUDE_MIN, ULTRACODE_MIN_VERSION), `${CLAUDE_MIN} vs ${ULTRACODE_MIN_VERSION}`);
claudeSays([], 0, `${CLAUDE_MIN} (Claude Code)`);
const oldEnough = { ok: true, bin: stubClaude(), version: CLAUDE_MIN };
const ultraRun = spawnRun({
  repo: 'cargos-api', brief: BRIEF, task: ULTRA_TASK, worker: 'ultra', effort: 'ultracode',
  tool: oldEnough,
});
const ultraText = `${ultraRun.stdout}${ultraRun.stderr}`;
check(`: ultracode on ${CLAUDE_MIN} — a refusal, not a silent lift on default effort`,
  ultraRun.status === 1 && ultraText.includes(CLAUDE_MIN) && ultraText.includes(ULTRACODE_MIN_VERSION)
  && /DEFAULT effort/.test(ultraText), `status=${ultraRun.status} ${ultraText}`);
check(': the refusal leaves nothing on disk — neither a participant nor a worktree',
  !store.readTask(HOME, ULTRA_TASK).participants.some((p) => store.addressOf(p) === 'worker:ultra')
  && worktreesWithStamp('t20260828-170000').length === 0,
  `${JSON.stringify(store.readTask(HOME, ULTRA_TASK).participants)} · ${worktreesWithStamp('t20260828-170000')}`);
// The same binary and the same spawn without `ultracode` — the gate is not a
// shared lift of the minimum version.
const xhighPlan = await planSpawn(WS, {
  repo: 'cargos-api', brief: BRIEF, task: ULTRA_TASK, worker: 'ultra', effort: 'xhigh',
});
claudeSays([{ id: 'sess-xhigh', name: xhighPlan.name, state: 'working', pid: 4246 }], 0, `${CLAUDE_MIN} (Claude Code)`);
const xhighRun = spawnRun({
  repo: 'cargos-api', brief: BRIEF, task: ULTRA_TASK, worker: 'ultra', effort: 'xhigh',
  tool: oldEnough,
});
check(': on the same binary other efforts pass — the refusal is pointed',
  xhighRun.status === 0
  && store.readTask(HOME, ULTRA_TASK).participants.some((p) => store.addressOf(p) === 'worker:ultra'),
  `status=${xhighRun.status} ${xhighRun.stdout}${xhighRun.stderr}`);

// --- : standalone host does not search install dirs ----------------------
//
// Origin ATI host walked ~/.local/bin. Dest resolveToolBin returns { ok, bin: name }
// and does not look at HOME. A missing name is an explicit HostToolBin refusal
// (the seam spawn already has); liftoff then never runs.
const GITONLY = path.join(SB, 'gitonly');
mkdirSync(GITONLY, { recursive: true });
symlinkSync(spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim(), path.join(GITONLY, 'git'));
const FOUND_TASK = 'naydennyy-t20260827-150000';
store.createTask(HOME, {
  id: FOUND_TASK, title: 'spawn бинарём вне PATH', slug: 'naydennyy', stamp: 't20260827-150000',
});
const foundPlan = await planSpawn(WS, { repo: 'cargos-api', brief: BRIEF, task: FOUND_TASK, worker: 'naydennyy' });
const offPathBin = path.join(SB, 'off-path');
stubCommand(offPathBin, 'claude', `const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.237 (Claude Code)\\n'); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(JSON.stringify([{ id: 'sess-0003', name: foundPlan.name, state: 'working', pid: 4244 }]))}); process.exit(0); }
process.stdout.write('backgrounded · sess-0003\\n');`);
const foundBin = path.join(offPathBin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
const foundNote = `claude not found in PATH — taken from ${offPathBin}`;
const foundRun = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({
    repo: 'cargos-api', brief: BRIEF, task: FOUND_TASK, worker: 'naydennyy',
    tool: { ok: true, bin: foundBin, note: foundNote },
  })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: GITONLY } });
const foundText = `${foundRun.stdout}${foundRun.stderr}`;
check(`: the binary is not on PATH — spawn lifts the worker with the absolute bin from HostToolBin`,
  foundRun.status === 0 && store.readTask(HOME, FOUND_TASK).participants.some((p) => store.addressOf(p) === 'worker:naydennyy'),
  `status=${foundRun.status} ${foundText}`);
check(': the found binary is named in the output together with the directory',
  foundText.includes(offPathBin) && /not found in PATH/.test(foundText), foundText);

const NONE_TASK = 'nekem-t20260827-160000';
store.createTask(HOME, {
  id: NONE_TASK, title: 'spawn без бинаря', slug: 'nekem', stamp: 't20260827-160000',
});
const noneReason = 'claude: not found in PATH. Install: npm install -g @anthropic-ai/claude-code';
const noneRun = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({
    repo: 'cargos-api', brief: BRIEF, task: NONE_TASK, worker: 'nekem',
    tool: { ok: false, reason: noneReason },
  })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: GITONLY } });
const noneText = `${noneRun.stdout}${noneRun.stderr}`;
check(': there is no binary — the refusal goes by HostToolBin.reason before a write to disk',
  noneRun.status === 1 && noneText.includes(noneReason),
  `status=${noneRun.status} ${noneText}`);
check(': a no-binary refusal leaves nothing on disk',
  !store.readTask(HOME, NONE_TASK).participants.some((p) => store.addressOf(p) === 'worker:nekem'),
  JSON.stringify(store.readTask(HOME, NONE_TASK).participants));
claudeSays([], 0);

// --- : the participant is written BEFORE claude is launched ------------------------------
//
// The launch-refusal branch takes the process through fail() → process.exit(1),
// so spawn is executed in a separate process: otherwise it would take the test
// with it. We then look at the journal — the participant must be in place, even
// though the session did not come up.
const FAIL_TASK = 'sboy-t20260827-130000';
store.createTask(HOME, {
  id: FAIL_TASK, title: 'spawn, который не поднялся', slug: 'sboy', stamp: 't20260827-130000',
});
claudeSays([], 3);
const failed = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({ repo: 'cargos-api', brief: BRIEF, task: FAIL_TASK, worker: 'sboy' })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const failText = `${failed.stdout}${failed.stderr}`;
check(': spawn with a claude that did not come up refuses, rather than staying silent',
  failed.status === 1 && /claude --bg exited with code 3/.test(failText), `status=${failed.status} ${failText}`);
const afterFail = store.participantOf(store.readTask(HOME, FAIL_TASK), 'worker:sboy')?.metadata;
check(': the participant is recorded, even though the claude launch failed',
  !!afterFail && !!afterFail.worktreeName && !!afterFail.branch, JSON.stringify(afterFail));
check(': session of one that did not come up is not invented', !!afterFail && !afterFail.session, String(afterFail?.session));
check(': the refusal names the route — repeat the same command',
  /repeat spawn with the same command/.test(failText), failText);
// What it is all for: a repeat of the same command no longer hits "the name
// collided with a foreign one". The worktree directory stayed on disk, and
// without a journal record planSpawn would refuse.
const failedWt = afterFail?.worktree;
check(`: the worktree directory of the failed spawn stayed on disk`,
  !!failedWt && existsSync(failedWt), String(failedWt));
// The brief is the mirror image of the record: the participant is written BEFORE the
// launch so a repeat sits in its own directory, and the brief is kept AFTER it — an
// assignment of a worker that never came up explains nothing and would be read as one
// somebody is working by.
const failedFiles = readdirSync(store.filesDir(HOME, FAIL_TASK)).filter((n) => n.startsWith('brief-'));
check(': a refused spawn keeps no brief — the copy is made after the lift, not before it',
  failedFiles.length === 0, failedFiles.join(', '));
// A refusal here is not a test crash, it is a found trouble: without a journal
// record planSpawn throws "the name collided with a foreign one", and the check
// must name that, not take the process away.
let retry = null;
let retryErr = '';
try {
  retry = await planSpawn(WS, { repo: 'cargos-api', brief: BRIEF, task: FAIL_TASK, worker: 'sboy', sessions: [] });
} catch (e) {
  retryErr = e.message;
}
check(': a repeat recognizes its own directory, rather than taking it for a foreign one',
  !!retry && !!failedWt && retry.worktreePath === failedWt && retry.branch === afterFail.branch,
  retryErr || String(retry?.worktreePath));

// --- : in `--dry-run` the version is not asked ------------------------------
//
// Binary resolve launches `<bin> --version` — a process of about two hundred
// milliseconds — and `--dry-run` lifts nothing: a run of four tracks paid that
// probe four times for an answer that affects nothing. We check not by output
// but by a trail: the stubbed `claude` writes a mark on every launch of its own,
// and after a dry-run spawn there must be no mark at all. A check by one output
// line would also pass on a launched probe — the subject here is the process
// launch itself.
const PROBE_MARK = path.join(SB, 'probe-calls.log');
const DRY_TASK = 'suhoy-t20260828-160000';
store.createTask(HOME, {
  id: DRY_TASK, title: 'spawn вхолостую', slug: 'suhoy', stamp: 't20260828-160000',
});
const dryPlan = await planSpawn(WS, { repo: 'cargos-api', brief: BRIEF, task: DRY_TASK, worker: 'suhoy' });
const drySessions = JSON.stringify([{ id: 'sess-dry', name: dryPlan.name, state: 'working', pid: 4245 }]);
stubCommand(BIN, 'claude', `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(PROBE_MARK)}, args.join(' ') + '\\n');
if (args[0] === '--version') { process.stdout.write('2.1.237 (Claude Code)\\n'); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(drySessions)}); process.exit(0); }
process.stdout.write('backgrounded · sess-dry\\n');`);
process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
const dryOut = await capture(() => spawnWorker(WS, {
  repo: 'cargos-api', brief: BRIEF, task: DRY_TASK, worker: 'suhoy', dryRun: true,
}));
check(': --dry-run does not launch the binary at all — not a single version probe',
  !existsSync(PROBE_MARK), existsSync(PROBE_MARK) ? readFileSync(PROBE_MARK, 'utf8') : '');
check(': silence about the version is named out loud, not left as a guess',
  dryOut.includes('version was not checked: dry-run'), dryOut.split('\n').slice(-6).join(' | '));
// A person copies the `--dry-run` command into the terminal. argv holds a
// session name with spaces and `·`, and joining through a space gave a string
// that fell apart into a dozen arguments: copied, it did not run at all. It is
// printed exactly for copying.
const dryCmd = dryOut.split('\n').find((l) => l.includes('&& claude ')) ?? '';
check(': the session name in the --dry-run command is quoted whole',
  dryCmd.includes(`'${dryPlan.name}'`), dryCmd);
// The check is exact, not "this way or that": the sandbox path has a space, so
// quoting must work, and an unquoted path does not pass it.
check(': the directory in `cd` is quoted — the sandbox path has a space',
  dryPlan.cwd.includes(' ') && dryCmd.includes(`cd '${dryPlan.cwd}' && claude `), dryCmd);

// Dest HostToolBin does not probe `--version`. Real spawn still launches the
// bin (agents / --bg); the dry-run early return is what keeps PROBE_MARK empty
// until this call.
await quiet(() => spawnWorker(WS, { repo: 'cargos-api', brief: BRIEF, task: DRY_TASK, worker: 'suhoy' }));
const probeLog = existsSync(PROBE_MARK) ? readFileSync(PROBE_MARK, 'utf8') : '';
check(': dest host does not probe --version; real spawn still launches the bin',
  probeLog.length > 0 && !/--version/.test(probeLog),
  probeLog || 'no mark');

// --- : lift of a worker and a reviewer goes through one helper ---------------------
//
// The "session appeared in claude agents" check now lives in
// `promptobus/liftoff.js` and both participants got it. Before it was only on
// the worker, and the reviewer block was a line-by-line copy without it. Here
// the worker half is checked: `claude --bg` reports success ("backgrounded",
// code 0), and there is no session in the list — that silent daemon failure the
// check was opened for. In a separate process: the refusal goes through fail()
// → process.exit(1).
const SILENT_TASK = 'tihiy-t20260829-110000';
store.createTask(HOME, {
  id: SILENT_TASK, title: 'spawn с молчаливым сбоем демона', slug: 'tihiy', stamp: 't20260829-110000',
});
claudeSays([], 0);
const silent = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(spawnUrl)});\n`
  + `await m.spawn(${JSON.stringify(WS)}, ${JSON.stringify({
    repo: 'cargos-api', brief: BRIEF, task: SILENT_TASK, worker: 'tihiy', awaitOptions: { tries: 2, delayMs: 1 },
  })});`,
], { encoding: 'utf8', env: { ...process.env, PATH: `${BIN}${path.delimiter}${PATH0}` } });
const silentText = `${silent.stdout}${silent.stderr}`;
check(`: there is no worker session in claude agents — a refusal, not a success report`,
  silent.status === 1
  && /claude --bg reported success, but there is no live session .* — worker was NOT started/.test(silentText)
  && !/worker worker:tihiy lifted/.test(silentText), `status=${silent.status} ${silentText}`);
check(`: a refusal on a session that did not come up names the route — repeat spawn`,
  /repeat spawn with the same command/.test(silentText)
  && /There will be no messages from this address/.test(silentText), silentText);
check(`: the worker record is in place after the refusal too — a repeat will sit in its directory`,
  !!store.readTask(HOME, SILENT_TASK).participants.find((p) => store.addressOf(p) === 'worker:tihiy'),
  JSON.stringify(store.readTask(HOME, SILENT_TASK).participants));

// --- : a repeat spawn at a dismissed address calls the slice by the NEW brief ----------
//
// A live orchestrator case: `spawn --worker store` in a task where the address
// already worked as a former track and was dismissed from watch on acceptance
// lifted a session "Worker: Вынос store в package" under a brief about /448/449.
// Mechanically the worker worked by the new brief — only the name lied, and by
// the name a person in `claude agents` and the orchestrator find the work slice.
// The whole triple of record fields, the task title, and that `--dry-run`
// promises the same name that the live run will get are checked.
const TASK453 = 'povtor-t20260902-100000';
const TITLE_OLD = ' Вынос store в package';
const TITLE_NEW = '   Recover и стенд гонок';
// Dest `shortTitle` / brief heading trim collapse runs of space. Fixture bodies
// stay as transferred; checks compare the stored dest form.
const TITLE_NEW_STORED = 'Recover и стенд гонок';
store.createTask(HOME, { id: TASK453, title: TITLE_OLD, slug: 'povtor', stamp: 't20260902-100000' });
const BRIEF_OLD = path.join(SB, 'brief-406.md');
writeFileSync(BRIEF_OLD, `# ${TITLE_OLD}\n\nВынос шины во вложенный package.\n`);
const BRIEF_NEW = path.join(SB, 'brief-447.md');
writeFileSync(BRIEF_NEW, `# ${TITLE_NEW}\n\nRecover журнала и стенд гонок.\n`);

const optsOld453 = { repo: 'cargos-api', brief: BRIEF_OLD, task: TASK453, worker: 'store' };
const planOld453 = await planSpawn(WS, optsOld453);
claudeSays([{ id: 'sess-0406', name: planOld453.name, state: 'working', pid: 4406 }]);
resetCliCaches();
await quiet(() => spawnWorker(WS, optsOld453));
// Slice acceptance: the session was closed, the address dismissed from watch.
// The session list is empty — the former track's session is dead, and a repeat
// spawn at this address is legal.
store.dismissParticipant(HOME, TASK453, 'worker:store');
claudeSays([]);
resetCliCaches();

// `sessions: {}` is the same seam plans in promptobus.test.mjs live on: the
// former track's session is closed, and the "this address is already running"
// gate must not see it. Without the seam the check would depend on HOW MUCH the
// names differ: return the title from the old record, and the name would match
// the stubbed session name — spawn would refuse "the participant is alive", the
// file would break on a refusal instead of a red check, and a mutation probe
// would name nothing.
const optsNew453 = { repo: 'cargos-api', brief: BRIEF_NEW, task: TASK453, worker: 'store', sessions: {} };
const dry453 = await capture(() => spawnWorker(WS, { ...optsNew453, dryRun: true }));
resetCliCaches();
const planNew453 = await planSpawn(WS, optsNew453);
claudeSays([{ id: 'sess-0447', name: planNew453.name, state: 'working', pid: 4447 }]);
resetCliCaches();
await quiet(() => spawnWorker(WS, optsNew453));
const backRec = store.participantOf(store.readTask(HOME, TASK453), 'worker:store');
const back = backRec?.metadata;

check(': the slice title of one lifted again is from the new brief, not from the old record',
  back?.title === TITLE_NEW_STORED, `${back?.title} (in the brief "${TITLE_NEW}")`);
check(': the session name is assembled from the new title, the old one is not in it',
  back?.name?.includes(TITLE_NEW_STORED) && !back?.name?.includes('Вынос store'), back?.name);
check(': sessionRef is rewritten together with the name — participants are looked up by it in claude agents',
  backRec?.sessionRef === back?.name && back?.name === planNew453.name,
  `${backRec?.sessionRef} · the plan promised "${planNew453.name}"`);
check(`: the task title is recalculated from participant lines on a repeat spawn too`,
  store.readTask(HOME, TASK453).title === TITLE_NEW_STORED,
  store.readTask(HOME, TASK453).title);
// A repeat lift at the same address is a NEW assignment, and the previous one is the
// only record of what the previous session worked by: the copy takes the next number
// instead of overwriting. Both files are read, not just counted — an overwrite would
// leave one file of the right name with the wrong text.
const briefFirst = path.join(store.filesDir(HOME, TASK453), 'brief-store.md');
const briefSecond = path.join(store.filesDir(HOME, TASK453), 'brief-store-2.md');
check(': a repeat spawn with another brief keeps both — the previous one is not overwritten',
  existsSync(briefFirst) && existsSync(briefSecond)
  && readFileSync(briefFirst, 'utf8').trim() === readFileSync(BRIEF_OLD, 'utf8').trim()
  && readFileSync(briefSecond, 'utf8').trim() === readFileSync(BRIEF_NEW, 'utf8').trim(),
  readdirSync(store.filesDir(HOME, TASK453)).join(', '));
// The `--dry-run` promise and the live run must match: the plan is printed to a
// person before lift, and if they drifted a dry run would check not what will
// be lifted.
check(': --dry-run prints the same session name and the same future task title',
  dry453.includes(`session: "${back?.name}"`) && dry453.includes(`will be renamed: ${TITLE_NEW_STORED}`),
  dry453.split('\n').filter((l) => /session|renamed/.test(l)).join(' | '));

// --- : bus identity in the environment of the participant session ITSELF ----------------------
//
// The three variables also sit in the bus-record `env` inside `--mcp-config`,
// but they go to the MCP-server process. The loop-guard Stop hook is called by
// the harness as a child of the SESSION and reads its environment — without
// these three the participant would resolve as address `orchestrator`, their
// bind would not be found, and the guard would not hold a turn for them even
// once.
//
// A FACT is checked, not an intent: the stubbed binary writes the received
// environment to a file, and the match is against it. `plan.env` next to it is
// what will go into `--dry-run` and to the driver.
const TASK426 = 'storozh-t20260902-140000';
store.createTask(HOME, { id: TASK426, title: 'сторож участника', slug: 'storozh', stamp: 't20260902-140000' });
const ENV_MARK = path.join(SB, 'seen-env.json');
const opts426 = { repo: 'cargos-api', brief: BRIEF, task: TASK426, worker: 'storozh' };
const plan426 = await planSpawn(WS, opts426);
const sessions426 = JSON.stringify([{ id: 'sess-0426', name: plan426.name, state: 'working', pid: 4426 }]);
stubCommand(BIN, 'claude', `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.251 (Claude Code)\\n'); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(sessions426)}); process.exit(0); }
writeFileSync(${JSON.stringify(ENV_MARK)}, JSON.stringify({
  role: process.env.PROMPTOBUS_ROLE ?? null,
  task: process.env.PROMPTOBUS_TASK ?? null,
  home: process.env.PROMPTOBUS_HOME ?? null,
}));
process.stdout.write('backgrounded · sess-0426\\n');`);
process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
resetCliCaches();
await quiet(() => spawnWorker(WS, opts426));
const seenEnv = existsSync(ENV_MARK) ? JSON.parse(readFileSync(ENV_MARK, 'utf8')) : null;
check(': the participant session is lifted WITHOUT bus identity in the environment',
  seenEnv !== null && seenEnv.role === null && seenEnv.task === null && seenEnv.home === null,
  `${JSON.stringify(seenEnv)} · the session environment must not carry the triple`);
check(': the same is not in the plan either — --dry-run prints it and it is given to the driver',
  IDENTITY_VARS.every((name) => !(name in plan426.env)),
  JSON.stringify(Object.fromEntries(IDENTITY_VARS.map((n) => [n, plan426.env[n] ?? null]))));
check(': identity went into the settings-file hook command, not into the environment',
  JSON.parse(readFileSync(plan426.settingsPath, 'utf8'))
    .hooks?.[GUARD_HOOK_EVENT]?.[0]?.hooks?.[0]?.command
    ?.includes(` --role ${shellQuote(plan426.address)} --task ${shellQuote(TASK426)}`
      + ` --home ${shellQuote(HOME)}`) === true,
  readFileSync(plan426.settingsPath, 'utf8'));

// --- : spawn installs dependencies from package-lock.json --------------------
//
// Three outcomes on a stubbed `npm` on PATH — the real binary is never called.
// The lock is in a separate clone: cargos-api has none, and earlier spawns in
// this file did not touch the step.

const NPM_MARK = path.join(SB, 'npm-calls.log');
const npmSays = (status = 0, { stdout = '', stderr = '' } = {}) => {
  stubCommand(BIN, 'npm', `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(NPM_MARK)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
${stdout ? `process.stdout.write(${JSON.stringify(stdout)});` : ''}
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ''}
process.exit(${status});`);
  process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
};
const npmCalls = () => (existsSync(NPM_MARK) ? readFileSync(NPM_MARK, 'utf8') : '')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const clearNpm = () => { if (existsSync(NPM_MARK)) rmSync(NPM_MARK); };

const NODE_REPO = path.join(WS, 'node-svc');
spawnSync('git', ['clone', '-q', ORIGIN, NODE_REPO], { encoding: 'utf8' });
writeFileSync(path.join(NODE_REPO, 'package.json'), `${JSON.stringify({ name: 'node-svc', private: true })}\n`);
writeFileSync(path.join(NODE_REPO, 'package-lock.json'), `${JSON.stringify({
  name: 'node-svc', lockfileVersion: 3, requires: true, packages: {},
})}\n`);
writeFileSync(path.join(NODE_REPO, '.gitignore'), 'node_modules\n');
g(NODE_REPO, 'add', '.');
g(NODE_REPO, 'commit', '-m', 'lock', '-q');

const BARE_REPO = path.join(WS, 'node-bare');
spawnSync('git', ['clone', '-q', ORIGIN, BARE_REPO], { encoding: 'utf8' });
writeFileSync(path.join(BARE_REPO, 'package.json'), `${JSON.stringify({ name: 'node-bare', private: true })}\n`);
writeFileSync(path.join(BARE_REPO, 'package-lock.json'), `${JSON.stringify({
  name: 'node-bare', lockfileVersion: 3, requires: true, packages: {},
})}\n`);
g(BARE_REPO, 'add', '.');
g(BARE_REPO, 'commit', '-m', 'lock без ignore', '-q');

const DEPS_TASK = 'deps-t20260903-180000';
store.createTask(HOME, {
  id: DEPS_TASK, title: 'зависимости worktree', slug: 'deps', stamp: 't20260903-180000',
});

clearNpm();
npmSays(0, { stdout: 'added 1 package in 12ms\n' });
const optsLock = { repo: 'node-svc', brief: BRIEF, task: DEPS_TASK, worker: 'withlock' };
const planLock = await planSpawn(WS, optsLock);
claudeSays([{ id: 'sess-lock', name: planLock.name, state: 'working', pid: 4501 }]);
resetCliCaches();
const lockOut = await capture(() => spawnWorker(WS, optsLock));
const lockCalls = npmCalls();
const lockLog = `${planLock.worktreePath}.npm-ci.log`;
const ciArgs = npmCiCommand().split(' ').slice(1).join(' ');
check(': in a worktree with package-lock.json spawn calls the install command',
  lockCalls.length === 1
  && lockCalls[0].cwd === planLock.worktreePath
  && lockCalls[0].args.join(' ') === ciArgs,
  JSON.stringify(lockCalls));
check(': a successful install is named in the output together with the duration',
  /worktree dependencies installed \(npm ci, \d+\.\d+ s\)/.test(lockOut)
  && lockOut.includes(`installing dependencies from package-lock.json (${npmCiCommand()})`), lockOut);
check(': the install log sits next to the directory and carries npm output',
  existsSync(lockLog) && readFileSync(lockLog, 'utf8').includes('added 1 package'),
  existsSync(lockLog) ? readFileSync(lockLog, 'utf8') : `no ${lockLog}`);

clearNpm();
npmSays(0);
const dryLock = await capture(() => spawnWorker(WS, { ...optsLock, worker: 'drylock', dryRun: true }));
check(': --dry-run prints the install intent and does not call npm itself',
  dryLock.includes(`worktree dependencies: ${npmCiCommand()}`)
  && npmCalls().length === 0, dryLock);

clearNpm();
npmSays(0);
const optsNoLock = { repo: 'cargos-api', brief: BRIEF, task: DEPS_TASK, worker: 'nolock' };
const planNoLock = await planSpawn(WS, optsNoLock);
claudeSays([{ id: 'sess-nolock', name: planNoLock.name, state: 'working', pid: 4502 }]);
resetCliCaches();
const noLockOut = await capture(() => spawnWorker(WS, optsNoLock));
check(': without package-lock.json npm is not called and the install line is not printed',
  npmCalls().length === 0 && !/worktree dependencies/.test(noLockOut),
  `${JSON.stringify(npmCalls())} · ${noLockOut.split('\n').filter((l) => /dependenc|npm ci/.test(l)).join(' | ')}`);

clearNpm();
npmSays(7, { stderr: 'ERESOLVE unable to resolve dependency tree\n' });
const optsFail = { repo: 'node-svc', brief: BRIEF, task: DEPS_TASK, worker: 'faillock' };
const planFail = await planSpawn(WS, optsFail);
claudeSays([{ id: 'sess-fail', name: planFail.name, state: 'working', pid: 4503 }]);
resetCliCaches();
const failDepsOut = await capture(() => spawnWorker(WS, optsFail));
const failLog = `${planFail.worktreePath}.npm-ci.log`;
check(': an npm ci refusal does not break spawn — the worker is lifted, there is a warning with the code and the command',
  failDepsOut.includes('worktree dependencies not installed')
  && failDepsOut.includes('exited with code 7')
  && failDepsOut.includes('ERESOLVE unable to resolve')
  && failDepsOut.includes(`the worker will do it: ${npmCiCommand()}`)
  && failDepsOut.includes(`log ${failLog}`)
  && failDepsOut.includes(`installing dependencies from package-lock.json (${npmCiCommand()})`)
  && /worker worker:faillock lifted/.test(failDepsOut)
  && !!store.participantOf(store.readTask(HOME, DEPS_TASK), 'worker:faillock'),
  failDepsOut);
check(': the refusal log is written and named in the warning',
  existsSync(failLog) && readFileSync(failLog, 'utf8').includes('ERESOLVE'),
  existsSync(failLog) ? readFileSync(failLog, 'utf8') : `no ${failLog}`);

clearNpm();
process.env.PATH = `${BIN}${path.delimiter}${PATH0}`;
const emptyPath = path.join(SB, 'empty-path');
mkdirSync(emptyPath, { recursive: true });
const miss = installWorktreeDeps(planLock.worktreePath, { env: { ...process.env, PATH: emptyPath } });
check(': no npm on PATH — why names PATH, not the ENOENT code',
  miss.ran === true && miss.ok === false && miss.why === 'npm not found in PATH',
  JSON.stringify(miss));
const missSay = await capture(() => sayWorktreeDeps(miss));
check(': the warning names "npm not found in PATH" and the command',
  missSay.includes('npm not found in PATH') && missSay.includes(`the worker will do it: ${npmCiCommand()}`),
  missSay);

clearNpm();
npmSays(0);
const optsBare = { repo: 'node-bare', brief: BRIEF, task: DEPS_TASK, worker: 'barelock' };
const planBare = await planSpawn(WS, optsBare);
claudeSays([{ id: 'sess-bare', name: planBare.name, state: 'working', pid: 4505 }]);
resetCliCaches();
const bareOut = await capture(() => spawnWorker(WS, optsBare));
check(': node_modules is outside ignore — a warning, spawn passed',
  bareOut.includes('git does not ignore node_modules in the worktree')
  && /worker worker:barelock lifted/.test(bareOut)
  && !lockOut.includes('git does not ignore node_modules in the worktree'),
  bareOut);

// HostToolBin: consumers read `bin`. A host that returns only the declared
// fields must still launch. A consumer that reads `path` again throws
// "file must be of type string" here — that is the mutation probe target.
const CONTRACT_TASK = 'bin-only-t20260904-000000';
store.createTask(HOME, {
  id: CONTRACT_TASK, title: 'host tool bin contract', slug: 'bin-only', stamp: 't20260904-000000',
});
const contractHost = hostOf(WS);
contractHost.resolveToolBin = () => ({ ok: true, bin: stubClaude() });
const contractOpts = { repo: 'cargos-api', brief: BRIEF, task: CONTRACT_TASK, worker: 'binonly' };
const contractPlan = await planSpawn(contractHost, contractOpts);
claudeSays([{ id: 'sess-bin', name: contractPlan.name, state: 'working', pid: 4600 }]);
resetCliCaches();
await quiet(() => spawnRaw(contractHost, contractOpts));
const contractRec = store.participantOf(store.readTask(HOME, CONTRACT_TASK), 'worker:binonly');
check('HostToolBin: resolveToolBin returning only `bin` launches the worker',
  contractRec?.metadata?.session === 'sess-bin', JSON.stringify(contractRec?.metadata));

// --- PB-8: the repository declares how to restore its generated process skills ------
//
// A repository that GENERATES its process skills — this one does: `backslop init` writes
// them and `.gitignore` keeps them out of git — handed a participant a worktree without
// them. Three workers came up that way; one noticed and two did not. The repository now
// declares the command in its own `promptobus.json`, spawn runs it in the fresh worktree,
// and the preamble says what happened either way.
//
// Every generator here is `node`, which is on the suite's reachable-binary list: a fixture
// reaching for anything else would not resolve under the sealed PATH at all.
const GENERATED = 'generated-skill.md';
const GEN_TASK = 'generator-t20260905-000000';
store.createTask(HOME, {
  id: GEN_TASK, title: 'репозиторий со своим генератором', slug: 'generator', stamp: 't20260905-000000',
});
// The generator copies the task journal as it sees it. That is the ORDER under test: the
// participant record must already be in the journal when a long generator starts, or a
// Ctrl+C inside one leaves a directory the next spawn refuses to reuse.
const ORDER_MARK = path.join(SB, 'generator-saw-journal.json');
const GEN_SCRIPT = [
  "const fs = require('node:fs');",
  `fs.writeFileSync(${JSON.stringify(GENERATED)}, 'repository process skills');`,
  `fs.copyFileSync(${JSON.stringify(store.taskFile(HOME, GEN_TASK))}, ${JSON.stringify(ORDER_MARK)});`,
].join('');

const GEN_REPO = path.join(WS, 'gen-svc');
spawnSync('git', ['clone', '-q', ORIGIN, GEN_REPO], { encoding: 'utf8' });
writeFileSync(path.join(GEN_REPO, 'promptobus.json'), `${JSON.stringify({
  generate: ['node', '-e', GEN_SCRIPT],
}, null, 2)}\n`);
// The generated file is ignored, which is the whole point of the field: a repository that
// kept its skills in git would need no generator.
writeFileSync(path.join(GEN_REPO, '.gitignore'), `${GENERATED}\n`);
g(GEN_REPO, 'add', '.');
g(GEN_REPO, 'commit', '-m', 'declare a process-skill generator', '-q');

const genOpts = { repo: 'gen-svc', brief: BRIEF, task: GEN_TASK, worker: 'gen' };
const genPlan = await planSpawn(WS, genOpts);
check(': the plan names the declared generator and does not run it',
  genPlan.repoSkills?.kind === 'planned' && genPlan.repoSkills.argv?.[0] === 'node'
  && /declares a generator/.test(genPlan.prompt)
  && !existsSync(path.join(genPlan.worktreePath, GENERATED)),
  JSON.stringify(genPlan.repoSkills?.kind));

claudeSays([{ id: 'sess-gen', name: genPlan.name, state: 'working', pid: 4700 }]);
resetCliCaches();
let genRun = null;
const genOut = await capture(() => spawnWorker(WS, genOpts).then((r) => { genRun = r; }));
check(': the generator ran in the fresh worktree and its files are there',
  existsSync(path.join(genPlan.worktreePath, GENERATED))
  && /repository skills generated in the worktree/.test(genOut), genOut.slice(-400));
const genStatus = spawnSync('git', ['-C', genPlan.worktreePath, 'status', '--porcelain'], { encoding: 'utf8' });
check(': git status in the worktree is clean — what the generator wrote is ignored',
  genStatus.status === 0 && genStatus.stdout.trim() === '', `${genStatus.stdout}${genStatus.stderr}`);
check(': the preamble the participant was lifted with says the skills were laid out',
  /Repository process skills were laid out in this worktree/.test(String(genRun?.prompt))
  && genRun?.repoSkills?.kind === 'ok'
  && String(genRun?.argv?.[genRun.argv.length - 1]) === genRun?.prompt,
  String(genRun?.prompt ?? '').split('\n').slice(0, 6).join(' / '));

// The ordering, read from the journal the generator itself saw. A generator may block for
// minutes (`npx` over the network), and a Ctrl+C inside one used to leave a worktree
// directory with no record in the journal — after which a repeat spawn refuses with "the
// directory is taken, and the journal has no such worker" (review, major).
const sawJournal = existsSync(ORDER_MARK)
  ? JSON.parse(readFileSync(ORDER_MARK, 'utf8')) : null;
// The id in the v1 journal is the address with its separator flattened for the file
// system (`worker:gen` → `worker-gen`); the address itself is what the bus talks in.
const sawGen = sawJournal?.participants?.find((x) => x.id === 'worker-gen');
check(': the participant was already in the journal when the generator started',
  Array.isArray(sawJournal?.participants) && !!sawGen,
  JSON.stringify(sawJournal?.participants?.map((x) => x.id)));
// And the worktree it saw was already made — the pair is what makes the window empty.
check(': the journal the generator saw already carried the worktree of that participant',
  sawGen?.metadata?.worktree === genPlan.worktreePath,
  `${JSON.stringify(sawGen?.metadata?.worktree)} · ${genPlan.worktreePath}`);

// A repeat lift into a SURVIVING worktree does not run the generator again: it would be a
// write into a working tree nobody asked for. The branch is checked against the real
// directory rather than through a second lift — the seam is the `fresh` flag, and a lift
// is not what decides it.
rmSync(path.join(genPlan.worktreePath, GENERATED), { force: true });
const keptGen = runRepoGenerator({ worktreePath: genPlan.worktreePath }, { fresh: false });
check(': a repeat lift into a surviving worktree does not re-run the generator',
  keptGen.kind === 'kept' && keptGen.argv?.[0] === 'node'
  && !existsSync(path.join(genPlan.worktreePath, GENERATED)),
  JSON.stringify(keptGen.kind));
check(': and the preamble for that lift claims nothing about what is still there',
  /were not regenerated on this lift/.test(repoSkillsLine(keptGen))
  && /was not checked/.test(repoSkillsLine(keptGen)),
  repoSkillsLine(keptGen));

// The declaration is read from the WORKTREE, not from the clone. The worktree is checked
// out from the base BRANCH, so an uncommitted edit in the clone — an orchestrator working
// in it while a worker is lifted — is not what the participant will see. The fixture makes
// the two disagree on purpose: the clone's working file declares a different generator,
// and the branch still declares the first one.
const CLONE_ONLY = 'from-the-clone.md';
writeFileSync(path.join(GEN_REPO, 'promptobus.json'), `${JSON.stringify({
  generate: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(CLONE_ONLY)}, 'x')`],
}, null, 2)}\n`);
const GEN2_TASK = 'generator-two-t20260905-000000';
store.createTask(HOME, {
  id: GEN2_TASK, title: 'клон и рабочее дерево разошлись', slug: 'generator-two', stamp: 't20260905-000000',
});
const gen2Opts = { repo: 'gen-svc', brief: BRIEF, task: GEN2_TASK, worker: 'gentwo' };
const gen2Plan = await planSpawn(WS, gen2Opts);
claudeSays([{ id: 'sess-gen2', name: gen2Plan.name, state: 'working', pid: 4704 }]);
resetCliCaches();
await quiet(() => spawnWorker(WS, gen2Opts));
check(': the generator comes from the worktree, not from an uncommitted edit in the clone',
  existsSync(path.join(gen2Plan.worktreePath, GENERATED))
  && !existsSync(path.join(gen2Plan.worktreePath, CLONE_ONLY)),
  `${GENERATED}=${existsSync(path.join(gen2Plan.worktreePath, GENERATED))} · `
  + `${CLONE_ONLY}=${existsSync(path.join(gen2Plan.worktreePath, CLONE_ONLY))}`);

// A generator that refuses does NOT refuse the lift: the participant comes up and is told
// the exit code, and decides. Killing a lift over missing skills costs more than the skills.
const BAD_REPO = path.join(WS, 'gen-bad');
spawnSync('git', ['clone', '-q', ORIGIN, BAD_REPO], { encoding: 'utf8' });
writeFileSync(path.join(BAD_REPO, 'promptobus.json'), `${JSON.stringify({
  generate: ['node', '-e', 'process.stderr.write("no network"); process.exit(3)'],
}, null, 2)}\n`);
g(BAD_REPO, 'add', '.');
g(BAD_REPO, 'commit', '-m', 'declare a generator that refuses', '-q');

const BAD_TASK = 'generator-bad-t20260905-000000';
store.createTask(HOME, {
  id: BAD_TASK, title: 'генератор, который отказал', slug: 'generator-bad', stamp: 't20260905-000000',
});
const badOpts = { repo: 'gen-bad', brief: BRIEF, task: BAD_TASK, worker: 'genbad' };
const badPlan = await planSpawn(WS, badOpts);
claudeSays([{ id: 'sess-genbad', name: badPlan.name, state: 'working', pid: 4701 }]);
resetCliCaches();
let badRun = null;
const badOut = await capture(() => spawnWorker(WS, badOpts).then((r) => { badRun = r; }));
const badRecord = store.participantOf(store.readTask(HOME, BAD_TASK), 'worker:genbad');
check(': a refusing generator does not refuse the lift, and the operator is warned',
  /repository skills NOT generated/.test(badOut) && /exited with code 3/.test(badOut)
  && !!badRecord?.metadata?.session, `${badOut.slice(-400)} · ${JSON.stringify(badRecord?.metadata?.session)}`);
check(': the preamble names the failure and the exit code',
  badRun?.repoSkills?.kind === 'failed' && badRun?.repoSkills?.code === 3
  && /Repository process skills were NOT laid out/.test(String(badRun?.prompt))
  && /exited with code 3/.test(String(badRun?.prompt)),
  String(badRun?.prompt ?? '').split('\n').slice(0, 6).join(' / '));

// A declaration that is there but unusable is its own state, in the plan and in the
// preamble alike. Reading it as "no generator" would print the opposite of what the
// participant is told, and hide the reason a repository's skills went missing (review).
const ILL_REPO = path.join(WS, 'gen-ill');
spawnSync('git', ['clone', '-q', ORIGIN, ILL_REPO], { encoding: 'utf8' });
writeFileSync(path.join(ILL_REPO, 'promptobus.json'), `${JSON.stringify({
  generate: 'npx --yes some-tool init',
}, null, 2)}\n`);
g(ILL_REPO, 'add', '.');
g(ILL_REPO, 'commit', '-m', 'declare a generator as a shell line', '-q');

const ILL_TASK = 'generator-ill-t20260905-000000';
store.createTask(HOME, {
  id: ILL_TASK, title: 'генератор строкой, а не argv', slug: 'generator-ill', stamp: 't20260905-000000',
});
const illOpts = { repo: 'gen-ill', brief: BRIEF, task: ILL_TASK, worker: 'genill' };
const illPlan = await planSpawn(WS, illOpts);
const illDry = await capture(() => spawnWorker(WS, { ...illOpts, dryRun: true }));
check(': a shell line where argv is required is its own state, and dry-run names the reason',
  illPlan.repoSkills?.kind === 'invalid'
  && /must be a non-empty array of strings/.test(String(illPlan.repoSkills?.why))
  && /repository skills: .*must be a non-empty array of strings/.test(illDry)
  && !/no generator declared/.test(illDry),
  illDry.split('\n').find((l) => l.includes('repository skills')) ?? illDry.slice(-300));
claudeSays([{ id: 'sess-genill', name: illPlan.name, state: 'working', pid: 4702 }]);
resetCliCaches();
let illRun = null;
await capture(() => spawnWorker(WS, illOpts).then((r) => { illRun = r; }));
check(': the lift happens anyway and the preamble names the broken declaration',
  illRun?.repoSkills?.kind === 'failed'
  && /Repository process skills were NOT laid out/.test(String(illRun?.prompt))
  && /must be a non-empty array of strings/.test(String(illRun?.prompt))
  && !!store.participantOf(store.readTask(HOME, ILL_TASK), 'worker:genill')?.metadata?.session,
  String(illRun?.repoSkills?.why));

// A generator whose output the repository does NOT ignore hands the worker a branch dirty
// from its first second, and `done` never sweeps a dirty directory. It is not a refusal —
// the files are there and useful — but it must be said out loud (review).
const DIRT_REPO = path.join(WS, 'gen-dirt');
spawnSync('git', ['clone', '-q', ORIGIN, DIRT_REPO], { encoding: 'utf8' });
writeFileSync(path.join(DIRT_REPO, 'promptobus.json'), `${JSON.stringify({
  generate: ['node', '-e', "require('node:fs').writeFileSync('not-ignored.md', 'skills')"],
}, null, 2)}\n`);
g(DIRT_REPO, 'add', '.');
g(DIRT_REPO, 'commit', '-m', 'declare a generator whose output is not ignored', '-q');

const DIRT_TASK = 'generator-dirt-t20260905-000000';
store.createTask(HOME, {
  id: DIRT_TASK, title: 'генератор оставляет грязь', slug: 'generator-dirt', stamp: 't20260905-000000',
});
const dirtOpts = { repo: 'gen-dirt', brief: BRIEF, task: DIRT_TASK, worker: 'gendirt' };
const dirtPlan = await planSpawn(WS, dirtOpts);
claudeSays([{ id: 'sess-gendirt', name: dirtPlan.name, state: 'working', pid: 4703 }]);
resetCliCaches();
const dirtOut = await capture(() => spawnWorker(WS, dirtOpts));
check(': a generator that leaves untracked files is reported, and the lift still passes',
  /repository skills generated in the worktree/.test(dirtOut)
  && /the generator left 1 change\(s\) git can see in the worktree/.test(dirtOut)
  && /not-ignored\.md/.test(dirtOut)
  && /done will never sweep the directory/.test(dirtOut),
  dirtOut.slice(-500));

// And the default: a repository that declares nothing says so, so a participant that
// SHOULD have had a generator can see there was none.
check(': a repository with no declaration says so in the preamble, and nothing is run',
  plan.repoSkills?.kind === 'none' && /declares no generator/.test(plan.prompt),
  JSON.stringify(plan.repoSkills));

process.env.PATH = PATH0;
rmSync(SB, { recursive: true, force: true });

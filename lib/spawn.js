import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ok, info, warn, fail, lastLines, procTimedOut, runProc, shellQuote,
  GIT_MAX_OUTPUT, GIT_NET_TIMEOUT_MS, PROC_INSTALL_TIMEOUT_MS, toPosix,
} from './util.js';
import { hostOf, HostResolveError } from './host.js';
import { guardHookCommand } from '../dist/hooks.js';
import {
  activeTasks, addressOf, bindIfOwner, boundTaskId, claimRoute, createTask, filesDir,
  foreignTaskLine, GateError, newTaskIdentity, occupyTaskFile, ORCHESTRATOR, ownership,
  participantMcpPath,
  participantOf, participantRecord, participantSettingsPath, readTask, retitleTask,
  sessionIdentity, SLUG_MAX, slugify, TASK_TITLE_SEP, taskExists, titleFromLines,
  upsertParticipant, workerAddress,
} from './store.js';
import { PROMPTOBUS_SERVER } from './contract.js';
import {
  WORKTREE_BRANCH_PREFIX, WORKTREE_DIR_REL, createWorktree, defaultRefs, excludeWorktrees,
  installWorktreeDeps, npmCiCommand, worktreeDirt, worktreeHasLock,
} from './worktree.js';
import { HOST_CONFIG, openParticipant, ROUTING_FIELD } from '../dist/index.js';
import { driverOf, liftDriver, REGISTRY } from './drivers.js';
// The routing gate is one function for both lifts: `review.js` calls the same one,
// so the decision a reviewer is lifted on is made the way a worker's is.
import { routeLift, routingLine, sayDecision } from './models.js';
import { ensureWarden } from './warden.js';
// Participant liveness is a state predicate (status.js): the "address is already running"
// gate and the `promptobus status` line must count the same session as alive.
import { participantSession } from './status.js';

// Spawn a worker: a background harness session in the target repository directory, with
// Promptobus through its own MCP config. The bus config lives in the task store and
// travels to the participant with the rest of the lift plan. Shared participant assembly
// (prompt, names, MCP set, settings) lives here and is also called by review.
//
// **There is no argv and no harness name here**. This file names the SUBJECT
// — visibility directories, the loop-guard command, stripped tools — and a driver from
// the registry ([drivers.js](drivers.js)) translates that into argv, config, and a
// settings file in one `prepare`. Session registry and lift live there too, behind the
// contract.

function readBrief(file) {
  if (!file) throw new GateError('needed --brief <file with the assignment text>');
  const abs = path.resolve(file);
  if (!existsSync(abs)) throw new GateError(`no assignment file: ${abs}`);
  const text = readFileSync(abs, 'utf8').trim();
  if (!text) throw new GateError(`assignment file is empty: ${abs}`);
  return text;
}

// One key is copied from workspace settings to the participant — `skillOverrides`: it
// suppresses personal file copies of same-named skills (the skills themselves travel as
// the plugin directory). Exported for a gate: a test holds the match with
// `OWNED_SETTINGS_KEYS` in plugin.js.
export const SKILL_KEYS = ['skillOverrides'];

export function skillSettings(rootOrHost) {
  const host = hostOf(rootOrHost);
  const file = path.join(host.workspaceRoot(), '.claude', 'settings.json');
  if (!existsSync(file)) return {};
  try {
    const ws = JSON.parse(readFileSync(file, 'utf8'));
    return Object.fromEntries(SKILL_KEYS.filter((k) => ws[k] !== undefined).map((k) => [k, ws[k]]));
  } catch {
    warn(`${file}: workspace settings could not be parsed — personal copies of same-named skills`
      + ` are not suppressed for the participant. Fix the file or run ${host.syncHint()}`);
    return {};
  }
}

// Workspace skills reach the participant as a session flag, not a plugin install:
// `--plugin-dir` loads the plugin for one session, the namespace is the same, and
// `installed_plugins.json` gets no entry.
export function participantPluginDir(rootOrHost) {
  const host = hostOf(rootOrHost);
  const dir = host.pluginDir();
  // Look at the manifest, not the directory: `.claude-plugin/plugin.json` is what
  // makes a directory a plugin.
  if (existsSync(path.join(host.workspaceRoot(), host.pluginManifestRel()))) return dir;
  warn(`${dir}: plugin directory is missing or has no .claude-plugin/plugin.json manifest`
    + ` — the participant will have no workspace skills. Run ${host.syncHint()}`);
  return null;
}

// The bus entry name in the participant config comes from its home: the bus hook reads it too.
export { PROMPTOBUS_SERVER } from './contract.js';

// Canonical workspace MCP list for a bus participant: a workspace `.mcp.json` is not
// addressed to a session whose cwd is its own repository, and the base rules require
// `search_facts` as the first line of a task. We assemble the same way `sync` assembles
// `.mcp.json`; externally authorized servers (`managedBy.auth: "external"`) are split
// out by `collectServers` itself — their dynamic token is held by an external user-scope
// skill, and they are returned next to the ones that traveled. The bus entry comes AFTER
// the list and overrides a same-named one: `PROMPTOBUS_ROLE`, `PROMPTOBUS_TASK` and
// `PROMPTOBUS_HOME` are the participant's own. Soft mode is required: by default
// `collectServers` calls `fail()` (process.exit, try/catch does not catch it), and a
// broken list is no reason to kill the lift.
// The harness-neutral participant MCP descriptor and the note about it are computed
// together, otherwise the output line promises the wrong set. Which servers is the
// workspace's call through host: the canonical set plus the bus entry itself. Which file
// they land in is the driver's: the descriptor goes to it, and it translates it into its
// config.
export function participantMcp(rootOrHost, { address, taskId, home }, driver) {
  const host = hostOf(rootOrHost);
  const { servers, external } = host.participantServers();
  const mcpServers = {
    ...host.substituteVars(servers),
    [PROMPTOBUS_SERVER]: {
      type: 'stdio',
      command: host.nodePath(),
      args: host.busArgv(['mcp']),
      env: { PROMPTOBUS_ROLE: address, PROMPTOBUS_TASK: taskId, PROMPTOBUS_HOME: home },
    },
  };
  return {
    descriptor: { address, task: taskId, home, servers: mcpServers },
    external,
    // Shadowed personal entries are counted by the driver: the harness personal config is its dictionary.
    shadowed: driver.shadowedUserServers(Object.keys(mcpServers)),
  };
}

// Mode 0600 on the participant mcp-config: it holds substituted tokens, so spawn output
// does not print them. `writeFileSync` `mode` applies only on CREATE, hence `chmod`
// after: a rewrite on a repeat spawn would have left the previous mode.
export function writeSecret(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

// Directory from the plan: the driver names the source, the caller writes it — like file
// text. The source +x bit is copied: skill scripts would otherwise arrive non-executable.
// Symlinks are not dereferenced: the target can sit outside the canon, and the copy would
// leave incomplete. Skip with a warning, as Writer.copyDir does: a silently left symlink
// leaves the skill incomplete. The destination is removed before the copy: a repeat lift
// would otherwise leave a skill that has since vanished.
function copyLaunchTree(src, dest, { wipe = true } = {}) {
  if (wipe && existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === '.DS_Store') continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyLaunchTree(from, to, { wipe: false });
    else if (e.isFile()) {
      copyFileSync(from, to);
      const mode = statSync(from).mode & 0o777;
      if (mode & 0o111) chmodSync(to, mode);
    } else {
      warn(`${toPosix(from)} — ${e.isSymbolicLink() ? 'symbolic link' : 'neither a file nor a directory'}, `
        + `did not travel into the participant directory (source: ${toPosix(src)}); `
        + 'whatever points at it will arrive incomplete — put the file itself in the source');
    }
  }
}

function warnTrackedCursor(files) {
  const dirs = new Set();
  const needle = `${path.sep}.cursor${path.sep}`;
  for (const file of files) {
    const at = file.path.indexOf(needle);
    if (at < 0) continue;
    dirs.add(file.path.slice(0, at));
  }
  for (const dir of dirs) {
    const listed = spawnSync('git', ['-C', dir, 'ls-files', '--', '.cursor'], {
      encoding: 'utf8', timeout: GIT_NET_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT,
    });
    if (listed.status !== 0) continue;
    const names = String(listed.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!names.length) continue;
    warn(`${dir}: git already tracks ${names.join(', ')} — lift will overwrite them and the tree will be dirty`);
  }
}

/**
 * Files the driver asks to place next to the session before lift. Order is
 * its, mode is shared: a secret is written `0600`. What sits in the file and what it is
 * called is the driver's; that "tokens are here" is the contract's, so the caller sets
 * the mode. `copyFrom` is a whole directory: the Cursor skill canon travels as files, not
 * as the text of one file.
 */
export function writeLaunchFiles(files) {
  warnTrackedCursor(files);
  for (const file of files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    if (file.copyFrom) copyLaunchTree(file.copyFrom, file.path);
    else if (file.secret) writeSecret(file.path, file.text);
    else writeFileSync(file.path, file.text);
  }
}

// Delivered-server list for `--dry-run`: name and type, no config with tokens.
export function mcpServerLines(mcpConfig) {
  return Object.entries(mcpConfig.mcpServers ?? {}).map(([name, cfg]) => `${name} · ${cfg?.type ?? 'stdio'}`);
}

// Participant MCP set as an output line: only the UNUSUAL is named; the full list stays
// in `--dry-run`. Shadowing is `warn` (counted from the person's ~/.claude.json — the
// only machine-dependent spawn output line), stripped servers are `info`.
export function mcpNote(mcp, who) {
  const count = Object.keys(mcp.descriptor.servers ?? {}).length;
  const parts = [];
  if (mcp.shadowed.length) {
    parts.push(`shadowed personal user-scope entries — ${mcp.shadowed.join(', ')}`);
  }
  if (mcp.external.length) {
    parts.push(`did not travel — ${mcp.external.join(', ')}`
      + ' (externally authorized: the token is dynamic, an external user-scope skill holds it)');
  }
  return {
    level: mcp.shadowed.length ? 'warn' : 'info',
    text: `MCP ${who} (${count}): ${parts.join('; ') || 'nothing unusual'}`,
  };
}

// `--dry-run` gets no hint about `--dry-run`: the full list is already printed above.
export function sayMcp(plan, { hint = true } = {}) {
  const n = plan.mcpNote;
  (n.level === 'warn' ? warn : info)(hint ? `${n.text}. Full name list — --dry-run` : n.text);
}

// Environment of background bus sessions.
// One function for the worker and the reviewer: two background sessions of one run —
// one environment. What is dropped from the parent is the driver's call: variables that
// leak foreign values are a property of the harness, and the other one has its own.
// The memory lever is `host.extraEnv()`.
//
// **There is no bus identity here**. Before this, the `PROMPTOBUS_*` triple was put in
// the lifted session's environment for the Stop hook, and the premise that "the session
// environment is set by `claude --bg` from spawn's argv" does not hold on `claude`
// 2.1.251: probe 2026-09-03 — a background session is a pre-created daemon spare, and
// it inherits environment from the process that started the daemon. The triple from the
// first spawn of a run stood on ALL of its sessions, including foreign workspaces, and
// the second participant's hook rewrote the first's contact point. Now identity travels
// as hook-command arguments in the participant settings file
// ([hooks](../src/hooks.ts)), and the session environment does not carry it at all —
// putting a value there that neighbors will inherit is exactly handing out a foreign
// identity.
export function sessionEnv(driver, base = process.env, host) {
  return driver.sessionEnv(base, host.extraEnv());
}

/**
 * MCP tool name as THIS harness's session calls it. The participant prompt names bus
 * and memory tools, and harness spellings differ: Claude Code takes the short name,
 * Cursor namespaces with a hyphen (`promptobus-promptobus_send`). A participant given
 * a foreign spelling looks for a tool they do not have.
 */
export function toolName(driver, server, name) {
  return driver.phrases.tool(server, name);
}

// One rule for both prompts: the worker and the reviewer get one rule per tool.
// A function, not a constant: memory tool names are written by the harness (`toolName`).
export function memoryRule(driver, host) {
  return host.memorySection((server, name) => toolName(driver, server, name)) ?? '';
}

// Refusal on binary version for the requested options is a driver operation: both the
// version bound and the refusal wording belong to the harness. The gate is shared by
// the worker and the reviewer: if the refusals diverged, the reviewer would silently
// start on default effort.
export function optionRefusal(driver, effort, tool) {
  return driver.optionRefusal({ effort }, tool);
}
// Re-export: spawn computes it for the `--dry-run` prediction; `retitleTask` decides under the lock.
export { titleFromLines } from './store.js';

// Outcome of a restamp that lost under the lock: the plan promised a rename, and
// `retitleTask` returned `null`. A separate pure function: the `spawn()` stretch that
// prints it is unreachable by a test — owner change happens between plan and write.
export function restampOutcome(current, wanted) {
  return current === wanted
    ? { level: 'ok', text: 'title is already that — a neighboring spawn named it, nothing to rename' }
    : {
      level: 'warn',
      text: 'title was not restamped — the task mailbox changed owner while spawn ran. '
        + claimRoute('spawn'),
    };
}

/**
 * Lift driver by the `--harness` flag. Two gates, both before any write to disk.
 *
 * First — registry: an unknown name refuses with the list of known ones, and
 * `liftDriver` ([drivers.js](drivers.js)) does that — the only door from the mechanism
 * to drivers.
 *
 * Second — workspace declaration: a harness that is not in the tools manifest got
 * neither adapters (`sync` did not lay them out) nor a line in `doctor`. Lifting a
 * participant with it would start a session of a tool this workspace does not work
 * with. Without the flag there is no gate at all: the previous lift harness is taken
 * from the map and the declaration is not asked — otherwise a workspace with only
 * `cursor` in the declaration would stop lifting the orchestration that already ran
 * on it.
 *
 * The remedy names a FILE and a FIELD, not a command. Declaring a harness is a hand
 * edit of the manifest; the package has no `tools` subcommand, and the refusal used to
 * print one inherited from the project this package was extracted from. That is the
 * expensive kind of wrong message: it arrives at the one moment an operator most needs
 * a true instruction, and it looks helpful and complete (PB-1). The only command left
 * in it is `syncHint()` — the host's own, and one that exists. A consumer whose CLI
 * does have a declaration command says so through its own host.
 */
export function liftHarness(rootOrHost, harness = null) {
  const lifter = liftDriver(harness);
  if (!harness) return lifter;
  const host = hostOf(rootOrHost);
  const tools = host.declaredTools();
  if (!tools.includes(lifter.id)) {
    throw new GateError(`--harness ${lifter.id}: tool is not declared in ${host.toolsManifestRel()} of the workspace `
      + `(declared: ${tools.join(', ') || 'none'}) — adapters for it were not laid out, and the participant `
      + `would have no workspace rules or skills. Declaring a harness is a hand edit of that file: add `
      + `"${lifter.id}" to its "tools" array, then ${host.syncHint()}`);
  }
  return lifter;
}

export function resolveEffort(effort, driver) {
  if (effort === undefined) return null;
  const levels = driver.options.effortLevels;
  if (!levels.includes(effort)) {
    throw new GateError(`--effort: unknown value "${effort}" — allowed: ${levels.join(', ')}`);
  }
  return effort;
}

// Participant session permission mode: the flag value is checked against the binary's
// list before lift — an unknown mode would otherwise reach `claude` and drop the session
// with an opaque refusal. Without the flag — `fallback`: `auto` for the worker, the
// binary's mode for the reviewer (`null`).
export function resolvePermissionMode(mode, driver, fallback = undefined) {
  const modes = driver.options.permissionModes;
  if (mode === undefined) return fallback === undefined ? driver.options.defaultPermissionMode : fallback;
  if (!modes.includes(mode)) {
    throw new GateError(`--permission-mode: unknown value "${mode}" — allowed: ${modes.join(', ')}`);
  }
  return mode;
}

function titleFromBrief(brief) {
  const first = brief.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? 'task';
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

// Worker slug comes from the repository name; one taken by another repository gets a
// number. An explicit name (`--worker`) wins and gets no number — a person chose it.
// The `reviewer-` prefix is taken: file names in `workers/` are derived from the address
// by one function, and `worker:reviewer-foo` would yield the same `reviewer-foo.mcp.json`
// as `reviewer:foo`.
function refuseReviewerPrefix(slug, route) {
  if (!slug.startsWith('reviewer-')) return slug;
  throw new GateError(`the worker name "${slug}" starts with "reviewer-", and that prefix is taken by the reviewer: `
    + `its files in workers/ are named the same (reviewer-<name>.mcp.json), and one of the two `
    + `participants' configs would be overwritten in silence. ${route}`);
}

function workerSlug(home, taskId, nsPath, explicit) {
  // Both paths go through `slugify`: the address must fit the grammar
  // `worker:[a-z0-9][a-z0-9-]*`; the participant record checks the same invariant again.
  if (explicit) {
    const named = slugify(explicit);
    if (!named) {
      throw new GateError(`--worker "${explicit}" does not yield a worker name: the address is Latin letters, digits, and a hyphen `
        + '(`worker:<name>`), Cyrillic is transliterated, the rest is dropped. Pick a name that leaves something.');
    }
    // The task slug may be truncated (it is not an address); the worker name may not.
    const full = slugify(explicit, Number.MAX_SAFE_INTEGER);
    if (named !== full) {
      throw new GateError(`--worker "${explicit}" is longer than ${SLUG_MAX} significant characters: the address would become `
        + `"${workerAddress(named)}", and the name tail would vanish in silence — two different slices of work `
        + 'would then meet at one address and share one worktree. Pick a shorter name.');
    }
    return refuseReviewerPrefix(named, 'Pick another --worker.');
  }
  // Truncation is not applied to the auto-slug: it would change the address of long
  // repository names, and with it the branch and directory of already lifted tasks.
  const base = refuseReviewerPrefix(slugify(path.basename(nsPath), Number.MAX_SAFE_INTEGER) || 'repo',
    `The worker name here is built from the repository name — name the slice of work yourself: --worker <name>.`);
  if (!taskExists(home, taskId)) return base;
  const taken = new Map((readTask(home, taskId).participants ?? [])
    .map((p) => [addressOf(p), p.metadata.repo]));
  let slug = base;
  for (let i = 2; taken.has(workerAddress(slug)) && taken.get(workerAddress(slug)) !== nsPath; i += 1) {
    slug = `${base}-${i}`;
  }
  return slug;
}

// Machine-name limit is a filesystem one: Windows without long paths cuts the FULL path
// at 260 characters, and after the directory name comes the whole file path inside the
// repository, so the ceiling is well below 255. The bg-session name is not bound by this
// limit: `--name` has no restriction.
export const NAME_MAX = 100;

// Task stamp in the READABLE name goes to minutes (`t20260826-021515` → `0826-0215`):
// a person does not need seconds, and in the machine name they keep directory and branch
// uniqueness.
function shortStamp(stamp) {
  const m = /^t\d{4}(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}$/.exec(String(stamp ?? ''));
  return m ? `${m[1]}${m[2]}-${m[3]}${m[4]}` : null;
}

// Name tail: the task stamp, or for a former-CLI record without one — its id. Slug and
// stamp are mechanism fields and in the v1 journal they live in `adapter`: the task's own
// fields there are title, status, owner, and participants.
function machineTail(task) {
  return task.adapter?.stamp ?? task.id;
}

function readableTail(task) {
  return shortStamp(task.adapter?.stamp) ?? machineTail(task);
}

// Machine name of the worker: the worktree directory and, with the `worktree-` prefix,
// the branch name. Only `[a-z0-9-]` — `git check-ref-format` rejects a space. Only the
// task slug is shortened: the rest of the name is not ours.
export function machineName(task, { slug } = {}) {
  const tail = [slug, machineTail(task)].filter(Boolean).join('-');
  const room = NAME_MAX - `promptobus-${tail}`.length - 1; // −1 for the hyphen after the task slug
  const head = task.adapter?.slug ? slugify(task.adapter.slug, Math.max(0, room)) : '';
  const name = ['promptobus', head, tail].filter(Boolean).join('-');
  if (name.length > NAME_MAX) {
    throw new Error(`worktree name is longer than ${NAME_MAX} characters (${name.length}): "${name}". `
      + 'The directory path then has no room left for repository files inside it (Windows without '
      + 'long paths cuts the full path at 260 characters), and there is nothing to shorten: the task slug is already gone, '
      + 'and the task stamp is not ours. The refusal will take a shorter name: `--worker` if the worker is named explicitly, '
      + `otherwise the repository directory name — the worker slug is built from those two.`);
  }
  return name;
}

// Readable bg-session name — what travels in `--name`: a person on the outside reads it,
// and the title goes into the name as words, not the machine slug. The role is the first
// word — a terminal-width list trim does not reach it.
const TITLE_MAX = 48;

// Title for the session name: whole words, no mid-word cut. Invisible characters are
// stripped — `\s` in the replace below covers only whitespace, and session lookup is a
// name compare: if the bytes diverge by one invisible character, there is never a match
// and no diagnosis. Replace with a space, do not drop: glued words read worse.
const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function shortTitle(title, max = TITLE_MAX) {
  const t = String(title ?? '').replace(INVISIBLE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = cut.lastIndexOf(' ');
  return `${(stop > max / 2 ? cut.slice(0, stop) : cut).replace(/[\s,.:;—-]+$/, '')}…`;
}

// First line of the assembled task title. Sits next to its only consumer: between a
// foreign comment and its function it would read as a header on someone else's code.
function firstLine(title) {
  return String(title ?? '').split(TASK_TITLE_SEP)[0].trim() || title;
}

// `taken` — participant names from the journal: the slug enters the name ONLY when
// titles collide (a live session name cannot be renamed; `--name` applies only at lift).
// `title` is the title of the work SLICE, otherwise sessions of one task are
// indistinguishable in `claude agents`; if unset, the task title is used.
export function sessionName(task, { slug, reviewer = false, taken = [], title } = {}) {
  const head = reviewer ? 'Review:' : 'Worker:';
  // The fallback takes the FIRST line of the task title, not the whole thing: the task
  // title lists the run's tracks, and the session name would get a "Review: A · B · C…" trim.
  const label = shortTitle(title ?? firstLine(task.title)) || task.adapter?.slug || slug || 'task';
  const stamp = readableTail(task);
  const name = `${head} ${label} (${stamp})`;
  if (!taken.includes(name)) return name;
  return `${head} ${label} (${stamp}, ${slug})`;
}

function buildPrompt({ taskId, nsPath, brief, rules, branch, driver, host, repoSkills }) {
  // Bus tool names in THIS harness's spelling: the participant looks them up by the
  // name they were given, and a foreign spelling leaves them with no bus at all.
  const bus = (name) => toolName(driver, PROMPTOBUS_SERVER, name);
  return `${host.workerPreamble({ taskId, nsPath, branch })}${host.liveRunNote(nsPath)}

${repoSkillsLine(repoSkills)}

The orchestrator is a separate Claude Code session; it holds the whole task. Talk to it through the ${PROMPTOBUS_SERVER} MCP-server tools (already attached to this session): ${bus('promptobus_send')}, ${bus('promptobus_mailbox')}, ${bus('promptobus_task')}.

## Assignment

${brief}

## Read the rules before you work

${rules.map((f) => `- ${f}`).join('\n')}

First, read these files and list them in your first reply. Then work by them.

## Team memory

${memoryRule(driver, host)}

## Communication protocol

1. Once you have taken the assignment — immediately ${bus('promptobus_send')} {to:"orchestrator", type:"status", body:"what you understood and how you plan to do it"}.
2. Then send status at every notable step: the plan is ready, edits are in, tests have run. A silent worker is indistinguishable from a hung one to the orchestrator. Starting background work longer than a couple of minutes (a series of runs, a long build, a long probe) — a status with what it is and a time estimate ("a series of three runs, ~9 minutes") goes OUT BEFORE you end the turn: otherwise the session sits silent, and running work cannot be told from hung work. Name the time by volume and a probe, not by feel.
3. To wait for a message (a reply, review notes) — just end the turn. There is nothing to wait with and no need: the task mailboxes are listened to by the bus warden, and it wakes you with a postcard when someone writes to you. The postcard carries the text of short messages, but only the mailbox marks them read — fetch the mailbox first, even if the postcard already made everything clear.
4. Stuck on a question you cannot continue without — ${bus('promptobus_send')} {to:"orchestrator", type:"question", body:"the question"} and end the turn. The reply (type=answer) arrives as a warden postcard, as in step 3. Do not guess and do not decide for the user.
5. Need context from another repository (an event contract, a schema, a signature) — ask the orchestrator with the same question: it will take that from another worker. Do not write into a foreign repository yourself.
6. Finished — FIRST fetch the mailbox, then send result. While you worked, the orchestrator may have widened or narrowed the run, and a result sent past unread mail costs everyone a wasted round. Something new arrived — finish it, fetch the mailbox again, and so on until there is no incoming: while you finish, the orchestrator may have sent more. Empty — send ${bus('promptobus_send')} {to:"orchestrator", type:"result", body:"outcome + list of changed files"} and end the turn. The orchestrator will run an isolated review and send notes as a type=review message — they arrive on the same postcard: fix and send result again. No notes — the work is accepted.
7. A file to pass (a diff, an export, a schema) — send with ${bus('promptobus_send')} and artifactPath as an absolute path; it will go into the task artifacts directory.
8. The assignment is the source of explicit requests, not wishes: if it asks to commit on your branch — commit at once, do not wait for a separate confirmation on the bus. What stays forbidden is what the assignment does not lift: push, and any edits to the repository main tree. Do not move the branch of your own will: the orchestrator takes the result from this worktree's branch. If the assignment explicitly asks for another branch — create it, but in the same turn tell the orchestrator with a status which branch now carries the result. A silently changed branch sends its publication into a void: it will publish the one spawn created, and that one will still sit on the original commit.${driver.phrases.promptRules}`;
}

// Spawn plan: everything is computed, nothing is written to disk. The same plan prints
// --dry-run and drives the real start — there is nowhere for them to diverge.
export async function planSpawn(rootOrHost, opts) {
  const host = hostOf(rootOrHost);
  const root = host.workspaceRoot();
  const {
    repo, brief: briefFile, task, newTask = false, title, taskTitle: explicitTaskTitle,
  } = opts;
  if (task && newTask) {
    throw new GateError('--new-task is incompatible with --task: one flag opens a new task, '
      + 'the other selects an existing one');
  }
  const home = host.promptobusHome();
  const brief = readBrief(briefFile);

  let resolved;
  try {
    resolved = await host.resolveRepo(repo);
  } catch (e) {
    if (!(e instanceof HostResolveError)) throw e;
    throw new Error([e.message, ...e.candidates.map((c) => `    ${host.formatCandidate(c)}`)].join('\n'));
  }
  const nsPath = resolved.nsPath;
  // The group gate stands before the clone check: first "what was named", then "does it
  // exist" — otherwise the "not cloned" diagnosis is about something that was not named.
  if (resolved.group) {
    throw new Error(`${repo} is a group address (${nsPath}), not a repository: a worker needs one. `
      + `Name a repository: --repo ${nsPath}/<name>. `
      + `Need the whole group on disk — clone takes it, not spawn: ${host.formatNpx(['clone', repo])}`);
  }
  const repoAbs = host.repoAbsPath(nsPath);
  // A clone, not just a directory: `repos/` also holds group directories with no `.git` of
  // their own, and `git` inside one of those would answer about the workspace. Same
  // signal as the resolver and `fresh`.
  if (!host.isClone(repoAbs)) {
    throw new Error(`${nsPath} is not cloned — the worker has nowhere to work: ${host.cloneHint(nsPath)}`);
  }

  const active = activeTasks(home);
  // Same order as `resolveTaskId` (explicit `--task`, session bind, the single active
  // one), but the resolve is its own: `--new-task`, no actives, and ambiguity without a
  // bind mean opening a new one.
  const bound = boundTaskId(home);
  if (newTask && bound) {
    throw new GateError(`--new-task does not open a second run from a session bound to the active task ${bound}: `
      + `finish the current run (${host.busCommand(['done', `--task ${bound}`])}) or run spawn from another session`);
  }
  const existing = newTask ? null : (task ?? bound ?? (active.length === 1 ? active[0].id : null));
  if (task && !taskExists(home, task)) throw new GateError(`task ${task} does not exist`);
  if (task && readTask(home, task).status === 'done') {
    throw new GateError(`task ${task} is closed — nobody sees a worker lifted in it: `
      + '`promptobus status` lists active ones, and `promptobus done` cleanup sweeps worktree directories of every closed task, '
      + 'so the next close would pull the worktree out from under a live session. '
      + `A new run is lifted by spawn WITHOUT --task — it will open the task itself; `
      + 'there is no way to continue work in a closed task: promptobus done has no reverse.');
  }
  // Attaching to a FOREIGN task: without `--task` spawn sits in the single active one,
  // and the originals of its worker's messages would go to the owner of a foreign mailbox.
  // The condition is the same `ownership` as the rest of the owner gate; an explicit
  // `--task` does not know this gate.
  if (!task && existing) {
    const own = ownership(home, existing, ORCHESTRATOR, sessionIdentity());
    if (own.gated) {
      throw new GateError(`${foreignTaskLine(readTask(home, existing), own)}: `
        + `spawn without --task would attach a worker to a foreign run, and that track's messages would go to a foreign orchestrator. `
        + `If the attach is intentional — attach with an explicit --task ${existing}. `
        + `${claimRoute('spawn')} `
        + 'Need a separate run — repeat spawn with --new-task. '
        + 'No route fits — the run is finished by its owner: a foreign hand running promptobus done would cut live work.');
    }
  }
  // There are two titles: `piece` is the title of the participant's work SLICE (`--title`,
  // otherwise the first line of the brief); session and reviewer names are built from it;
  // `taskTitle` is the TASK title (`--task-title`, strongest at creation). Without flags
  // they match; later the task title is extended by attaching tracks.
  const piece = title ?? titleFromBrief(brief);
  const taskTitle = explicitTaskTitle ?? piece;
  const identity = newTaskIdentity(slugify(opts.slug ?? taskTitle) || 'task');
  const taskId = existing ?? identity.id;
  // Plan shape is the journal shape, the same `readTask` returns: slug, stamp, and the
  // explicit-title mark live in `adapter`; the task's own fields are title, status, and
  // participants.
  const createNew = existing ? null : {
    id: taskId,
    title: taskTitle,
    status: 'active',
    adapter: {
      ...(identity.slug ? { slug: identity.slug } : {}),
      ...(identity.stamp ? { stamp: identity.stamp } : {}),
      ...(explicitTaskTitle ? { titleExplicit: true } : {}),
    },
    participants: [],
  };
  // The session name is assembled from the journal: for a new task — from the create
  // plan, for an existing one — from its task.json.
  const taskMeta = createNew ?? readTask(home, taskId);

  const slug = workerSlug(home, taskId, nsPath, opts.worker);
  const address = workerAddress(slug);
  // Two name lines: `name` is for a person in `claude agents`, `worktreeName` is for the
  // machine; both travel into the task journal.
  const participant = participantOf(taskMeta, address);
  // The driver is taken from the registry BEFORE any journal write and before option
  // parse: an unknown harness must refuse here, not after the participant is in the task,
  // and the allowed `--effort`, `--permission-mode`, and `--model` values are its
  // dictionary. For a NEW participant the harness is named by a person with `--harness`;
  // without the flag the previous one is taken. For a re-lifted one — the one that lifted
  // them, taken from their record.
  // Routing joins the gate order stated below — "two gates, both before any write
  // to disk" — and joins it for the same reason: a strategy that finds no candidate
  // must leave no task, no worktree and no participant behind, and past this point
  // there is a journal to roll back. `routeLift` returns `null` the moment there is
  // no `--strategy`, before it asks the host anything: without the flag the call
  // takes today's path exactly, and the declaration is not consulted.
  //
  // Only on a FRESH lift. ADR-003 fixes a participant's harness and model at
  // liftoff; a repeat spawn restarts an already lifted address, its harness comes
  // from the record the first lift wrote, and there is nothing left for a strategy
  // to choose. Silence about that would read as a routed restart, so the plan
  // carries a line and `spawn` prints it.
  const routed = participant ? null : await routeLift(host, {
    role: 'worker',
    strategy: opts.strategy,
    harness: opts.harness,
    model: opts.model,
    effort: opts.effort,
    allowPayg: opts.allowPayg,
    refresh: opts.refresh,
    dryRun: opts.dryRun,
    taskMeta,
    address,
    // Test seam, like `opts.tool` and `opts.sessions` below: the suite routes
    // against stand-in adapters, because no test run may start a harness binary
    // to find out whether an account is logged in. The CLI never sets it.
    adapterFor: opts.adapterFor,
  });
  const routingSkipped = participant && opts.strategy
    ? `${address} in task ${taskId} is already in the journal, lifted by harness ${participant.harness}: `
      + '--strategy routes a lift, and a repeat spawn restarts a participant whose harness and worktree '
      + 'are already fixed. The flag is ignored here — for a routed lift take another name: --worker <name>.'
    : null;
  const driver = participant ? driverOf(participant) : liftHarness(host, routed?.harness ?? opts.harness);
  // Restart with a foreign harness is a refusal, not a silent swap: the participant
  // session is already started in another tool, its worktree and branch stayed with it,
  // and the task record would name one harness while the session was another's.
  if (participant && opts.harness && opts.harness !== driver.id) {
    throw new GateError(`${address} in task ${taskId} was lifted by harness ${driver.id}, and --harness asks for `
      + `${opts.harness}: a repeat spawn restarts an ALREADY STARTED participant, and there is no way to change `
      + `its tool mid-flight — its worktree and branch stayed with it. For a second tool pick another name: --worker <name>.`);
  }
  // Mechanism fields live in the v1 record `metadata`; v1's own fields are role, harness,
  // mode, session reference, and the capabilities snapshot.
  const was = participant?.metadata ?? {};
  // An explicit name taken by a worker of ANOTHER repository: the journal participant
  // would hand over its worktree. An automatic slug splits that collision with a number;
  // an explicit one does not.
  if (opts.worker && was.repo && was.repo !== nsPath) {
    throw new Error(`${address} in task ${taskId} is the worker of repository ${was.repo}, `
      + `and spawn is going to ${nsPath}. The worker name is one per task: pick another --worker.`);
  }
  // Spawn at a live participant's address is a refusal: a repeat spawn routinely
  // restarts a DEAD one in its worktree and branch, and on a live one would send a
  // second worker into foreign work. Only on `alive`: unknown is no reason to forbid.
  if (participant) {
    // Test seam: the `participantSession` default fires exactly on undefined, and
    // `sessions: null` ("claude agents output was not parsed") arrives as-is.
    if (participantSession(participant, opts.sessions) === 'alive') {
      throw new Error(`task ${taskId} already has ${address} running: session "${was.name}" is alive. `
        + `A repeat spawn at this address would restart it in the same worktree (${was.worktree}) `
        + 'and the same branch. '
        + (opts.worker
          ? 'Pick another --worker for the second slice of work.'
          : 'A second slice of work in this same repository is lifted under its own name: --worker <name>.')
        + ` If you need a restart — close the session first: ${driver.phrases.stop('<id>')}.`);
    }
  }
  // The work-slice title comes from the NEW brief, including for an existing address:
  // a repeat spawn writes the participant record whole again, and the old title in it
  // would outlive the new assignment — the session would be named after foreign work.
  // The old title is not stored in a live record: the address's work history is in the
  // task message journal. This does not rename a reviewer: an already lifted name is
  // taken from its own record ([review.js](review.js)), and a new one should be named
  // after the new slice.
  const workTitle = piece;
  // Title of an existing task: `--task-title` pins it for good, otherwise attaching a
  // NEW track appends its title to the previous ones. `retitleTask` decides under the
  // lock: here there is only the intent and the prediction for `--dry-run` print.
  let retitle = null;
  let titleKept = null;
  if (existing) {
    if (explicitTaskTitle) {
      // A diverged title of a pinned task is restamped only on double explicitness:
      // `--task-title` plus an explicit `--task`, and the right is the mailbox owner's.
      // One explicitness is not enough: without `--task` spawn sits in the single active.
      if (taskMeta.adapter.titleExplicit) {
        if (taskMeta.title !== explicitTaskTitle) {
          // `own.gated` reaches here only with an explicit `--task` — the gate above refused spawn without it.
          const own = ownership(home, taskId, ORCHESTRATOR, sessionIdentity());
          if (task && !own.gated) {
            retitle = { title: explicitTaskTitle, explicit: true, restamp: true, session: own.session };
          } else {
            titleKept = `task ${taskId}: the task title is already set explicitly ("${taskMeta.title}"), --task-title ignored. `
              + (own.gated
                ? `The mailbox owner can restamp it: ${foreignTaskLine(taskMeta, own)}. ${claimRoute('spawn')}`
                : `Restamp needs double explicitness — repeat spawn with --task ${taskId}.`);
          }
        }
      } else {
        retitle = { title: explicitTaskTitle, explicit: true };
      }
    } else if (!taskMeta.adapter.titleExplicit && (!participant || (was.title && was.title !== workTitle))) {
      // Recalculation is where THIS address's line in the task title changed: a new track
      // or a restart with a different brief. That is how it skips two cases. A routine
      // restart with the same brief: `applyParticipant` puts the rewritten record at the
      // END of the list, and `titleFromLines` reads in order — a three-track task would
      // rename from "A · B · C" to "B · C · A" for no reason. And a former-CLI record
      // that has no `title` field at all: assembly would take titles only from those who
      // have one, i.e. replace the task title with the title of one slice — exactly the
      // trouble this left behind.
      //
      // `preview`, not `title`: a prediction for `--dry-run` print. Put it in `title`
      // and the under-lock recalculation dies on `??`, and the race comes back in silence.
      // The former record of this address is dropped from assembly: under the lock the
      // new one has already overwritten it, and a prediction with both lines would
      // diverge from the live run. The line then travels to the end of the list — the
      // under-lock recalculation will see it there too.
      const lines = titleFromLines({
        participants: [
          ...(taskMeta.participants ?? []).filter((p) => addressOf(p) !== address),
          { metadata: { address, title: workTitle } },
        ],
      });
      if (lines && lines !== taskMeta.title) retitle = { fromLines: true, preview: lines, explicit: false };
    }
  }
  // The session name is recomputed for an existing address too: spawn refused a live
  // participant above, and a dead one gets a NEW session — under the name from the new
  // brief. Its former name is dropped from `taken`: otherwise a repeat with the same
  // brief would bump into itself and append the worker slug to the name for no reason.
  const name = sessionName(taskMeta, {
    slug,
    title: workTitle,
    taken: (taskMeta.participants ?? []).filter((p) => addressOf(p) !== address)
      .map((p) => p.metadata.name).filter(Boolean),
  });
  // The machine name of a recorded participant is taken from the journal: a recompute
  // would send a restart onto a new branch. An old record has no `worktreeName` field —
  // the name is the worktree directory.
  const known = was.worktreeName ?? (was.worktree ? path.basename(was.worktree) : null);
  const wtName = known ?? machineName(taskMeta, { slug });
  const worktreePath = path.join(repoAbs, WORKTREE_DIR_REL, wtName);
  const branch = `${WORKTREE_BRANCH_PREFIX}${wtName}`;
  // Directory is taken and the journal has no participant: the name collided with a
  // foreign one — refuse loudly.
  if (!known && existsSync(worktreePath)) {
    throw new Error(`${worktreePath}: worktree directory is already taken, and task ${taskId} journal has no such worker — `
      + 'the name collided with a foreign one, and the worker would sit in a foreign working tree, on a foreign branch. '
      + `Take or remove the previous worker's work (git -C ${shellQuote(repoAbs)} worktree remove ${shellQuote(worktreePath)}), `
      + `or pick another name for this worker: --worker <name>.`);
  }
  // Base of a new worktree is the LOCAL default branch: the worker must see the person's
  // unpushed commits. Preference order comes from `defaultRefs` — the same ladder
  // cleanup compares against.
  const base = defaultRefs(repoAbs, host.defaultBranch(repoAbs))[0] ?? 'HEAD';
  // Model without a flag is the driver's default: the model name belongs to the harness
  // entirely, and Claude Code `opus` is rejected by a second binary as any unknown id.
  // A routed lift takes both from the tuple the resolver picked — which is the tuple an
  // explicit `--model` or `--effort` already constrained, so nothing here replaces a
  // named value. The routed effort still goes through the same gate as a typed one: the
  // catalog is data, and a level no driver knows must refuse here rather than reach the
  // binary as an unknown flag.
  const model = routed?.model ?? opts.model ?? driver.options.defaultModel;
  const effort = resolveEffort(routed ? (routed.effort ?? undefined) : opts.effort, driver);
  const permissionMode = resolvePermissionMode(opts.permissionMode, driver);
  // The participant settings file is written by the driver: its shape is the harness
  // contract. What arrives here is only the loop-guard command and the workspace keys
  // addressed to the participant. What sits in the workspace's own settings would not
  // reach the participant: its cwd is the clone worktree, not the workspace root. The
  // command is the same as the orchestrator's — absolute node and the workspace binary,
  // it resolves from any cwd.
  const settingsPath = participantSettingsPath(home, taskId, address);
  const guardCommand = guardHookCommand(host, { address, taskId, home }, process.platform);
  // Not every harness takes a skills directory from the workspace: for Claude Code it is
  // a one-lift flag (`--plugin-dir`). For Cursor the canon travels as `.cursor/skills`
  // files — the driver itself writes them into the worktree from the workspace root.
  // If it does not take a plugin — do not count it and do not warn about absence: a
  // warning about something unused reads as a break.
  const pluginDirPath = driver.options.skillsDir ? participantPluginDir(host) : null;
  const env = sessionEnv(driver, process.env, host);
  const mcpConfigPath = participantMcpPath(home, taskId, address);
  const mcp = participantMcp(host, { address, taskId, home }, driver);

  const collected = host.collectRules(repoAbs);
  const module = host.moduleNote(repoAbs);
  // The worker reads the repository AGENTS.md in its own copy: the main tree is not
  // in --add-dir and stays unwritable — exactly as the prompt promises.
  const rules = collected.map((f) => (f.startsWith(repoAbs + path.sep)
    ? path.join(worktreePath, path.relative(repoAbs, f))
    : f));
  // Claude Code asks permission to read outside the working directory: without --add-dir
  // the worker would stall on the first "read these files". Permission mode is irrelevant
  // — it is about what may be done, not what is visible.
  const ruleDirs = [...new Set(rules
    .filter((f) => !f.startsWith(worktreePath + path.sep))
    .map((f) => path.dirname(f)))];
  // The lift plan is assembled by the driver: translating a harness-neutral context into
  // argv, config, and a settings file is its job, and it also knows the binary's variadic
  // options that put the prompt last. Model is opus by default: the user's session default
  // can be more expensive. Permission mode is auto by default, not acceptEdits:
  // acceptEdits skips questions only for file edits and asks about every ordinary Bash
  // command — a background worker would stall on the first one. `--permission-mode`
  // overrides it for one spawn: a track with a stand outside the worktree would otherwise
  // have auto asking the person on every new command shape.
  const launchContext = {
    ref: name,
    address,
    task: taskId,
    home,
    role: 'worker',
    mcp: mcp.descriptor,
    cwd: worktreePath,
    model,
    effort,
    permissionMode,
    addDirs: ruleDirs,
    pluginDir: pluginDirPath,
    mcpConfigPath,
    settingsPath,
    guardCommand,
    extraSettings: skillSettings(host),
    root,
  };
  // Assembled through a closure rather than once, because one line of the preamble is not
  // knowable here: whether the repository's generator laid its process skills out in the
  // worktree, and with what exit code when it did not. The plan writes nothing to disk and
  // the worktree does not exist yet, so the plan carries the DECLARATION and `spawn`
  // rebuilds once with the outcome. Nothing but the prompt differs between the two, and
  // rebuilding before the launch files are written keeps them written exactly once (PB-8).
  const buildLaunch = (repoSkills) => {
    const prompt = buildPrompt({ taskId, nsPath, brief, rules, branch, driver, host, repoSkills });
    return { prompt, launch: driver.prepare({ ...launchContext, prompt }) };
  };
  // The plan reads the CLONE's file: the worktree does not exist yet. The run reads the
  // worktree's own — see `runRepoGenerator` — so the two can disagree, and the plan is a
  // forecast rather than a verdict. A declaration that is there but unusable is its own
  // state: printing "no generator" for it would contradict the preamble and hide the
  // reason a repository's skills went missing.
  const declaredGenerator = repoGenerator(repoAbs);
  const plannedSkills = declaredGenerator
    ? {
      kind: declaredGenerator.argv ? 'planned' : 'invalid',
      argv: declaredGenerator.argv,
      why: declaredGenerator.why,
    }
    : { kind: 'none', argv: null };
  const { prompt, launch } = buildLaunch(plannedSkills);

  return {
    home, taskId, createNew, slug, address, nsPath, repoAbs, via: resolved.via, brief,
    name, workTitle, wtName, worktreePath, branch, base, model, effort, permissionMode,
    settingsPath, guardCommand, pluginDir: pluginDirPath,
    mcpConfigPath, mcpNote: mcpNote(mcp, 'participant'), retitle, titleKept, driver,
    routing: routed?.metadata ?? null, decision: routed?.decision ?? null, routingSkipped,
    launch, argv: launch.argv, mcpConfig: launch.mcpConfig, settings: launch.settings,
    rules, ruleDirs, module, prompt, env, host,
    // The repository's generator: what was declared, and the door for `spawn` to put the
    // real outcome into the preamble once the worktree exists.
    repoSkills: plannedSkills, rebuild: buildLaunch,
    // A recorded branch point is not recomputed: on a branch the worker already worked
    // on, HEAD is not the branch point. A former-CLI record has no field.
    knownBaseSha: was.baseSha ?? null,
    // The session is lifted right in the worker's working tree: spawn creates the directory.
    cwd: worktreePath,
  };
}

/**
 * Line about workspace skills. Four outcomes: the plugin directory is attached, there is
 * no plugin, the harness does not take a plugin, and the harness itself said where the
 * skills come from (a file copy, not a flag). The driver puts its own line on the plan —
 * otherwise Cursor would read "not attached" after already receiving the canon in the
 * worktree `.cursor/skills`.
 */
export function skillsNote(plan) {
  if (plan.launch?.skillsNote) return plan.launch.skillsNote;
  if (plan.pluginDir) return plan.pluginDir;
  if (!plan.driver.options.skillsDir) {
    return `not attached — ${plan.driver.options.tool} does not read the Claude Code skills plugin`;
  }
  return 'not attached — plugin directory is missing';
}

// Module state is assembled once in the plan and printed twice.
export function sayModule(plan) {
  (plan.module.level === 'warn' ? warn : info)(plan.module.text);
}

/**
 * Field in the REPOSITORY's own `promptobus.json` that declares how to restore the
 * process skills it does not keep in git.
 *
 * The repository's file, not the workspace's: a generator belongs to the repository
 * being spawned into, and the host describes a workspace. `PromptobusHost` is asked
 * nothing here — a host method would either answer about the workspace root's manifest
 * or need a repository argument, and the declaration is one JSON field read by path
 * (PB-8).
 *
 * An argv array, never a shell line: everything the package launches goes through
 * `run`, and a shell string would need a quoting dialect invented for this one field —
 * and would put a repository's text on the operator's command line.
 */
export const GENERATOR_FIELD = 'generate';

/**
 * The generator the repository at `repoAbs` declares. `null` — none, which is the
 * default: skills in git stay the normal case and cost this step nothing. A declaration
 * that is there but unusable comes back with `argv: null` and the reason, because
 * silently treating a malformed field as "no generator" is how a participant comes up
 * without the skills its repository thinks it declared.
 */
export function repoGenerator(repoAbs) {
  const file = path.join(repoAbs, HOST_CONFIG);
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { argv: null, why: `could not be read: ${file} is not valid JSON (${e.message})` };
  }
  const declared = parsed?.[GENERATOR_FIELD];
  if (declared === undefined || declared === null) return null;
  if (Array.isArray(declared) && declared.length === 0) return null;
  if (!Array.isArray(declared) || !declared.every((a) => typeof a === 'string' && a.length > 0)) {
    return {
      argv: null,
      why: `is declared wrongly: "${GENERATOR_FIELD}" in ${file} must be a non-empty array of strings `
        + '— the command and its arguments, not a shell line',
    };
  }
  return { argv: declared, why: null };
}

/**
 * Run the repository's generator in the fresh worktree.
 *
 * A refusal is NOT a spawn refusal, the same rule the dependency install follows: the
 * participant is told what failed and with what exit code, and decides. Killing a lift
 * over missing skills would cost more than the skills.
 *
 * `fresh: false` is a repeat spawn into a surviving directory — what the previous
 * session generated is still there, and running a generator over a worker's tree is a
 * write nobody asked for.
 *
 * `exec` is the test seam, as in `installWorktreeDeps`.
 */
export function runRepoGenerator({ worktreePath }, { fresh = true, exec = runProc } = {}) {
  // Read from the WORKTREE, not from the clone: the worktree is checked out from the
  // base branch and is the file the participant will actually see. The plan reads the
  // clone because the worktree does not exist yet at plan time, so the two can disagree
  // — and where they do, the worktree decides.
  const declared = repoGenerator(worktreePath);
  if (!declared) return { kind: 'none', argv: null };
  if (!fresh) return { kind: 'kept', argv: declared.argv };
  if (!declared.argv) {
    return { kind: 'failed', argv: null, why: declared.why, code: null, logPath: null };
  }
  const started = Date.now();
  const r = exec(declared.argv[0], declared.argv.slice(1), {
    cwd: worktreePath,
    timeout: PROC_INSTALL_TIMEOUT_MS,
  });
  const ms = Date.now() - started;
  // The log goes NEXT TO the directory, not inside it: a file in the worktree would be
  // an uncommitted change on the worker's branch. Same place and same reason as the
  // `npm ci` log.
  const logPath = `${worktreePath}.generate.log`;
  try {
    writeFileSync(logPath, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`);
  } catch {
    // The log is convenience; a write refusal does not roll back spawn.
  }
  // What the generator left behind is asked only when it succeeded: a repository that does
  // not ignore what it generates hands the worker a branch dirty from its first second,
  // and `done` never sweeps a dirty directory. Same shape and same reason as the
  // `node_modules` ignore check after `npm ci`.
  if (r.status === 0) return { kind: 'ok', argv: declared.argv, ms, logPath, dirt: worktreeDirt(worktreePath) };
  let why;
  if (r.error?.code === 'ENOENT') why = `was not found in PATH (${declared.argv[0]})`;
  else if (procTimedOut(r)) why = `did not respond in ${PROC_INSTALL_TIMEOUT_MS / 1000} s`;
  else {
    const tail = lastLines(r.stderr || r.stdout || r.error?.message || '');
    why = `exited with code ${r.status ?? r.error?.code ?? '?'}${tail ? `: ${tail}` : ''}`;
  }
  return { kind: 'failed', argv: declared.argv, why, code: r.status ?? null, ms, logPath };
}

/**
 * The preamble sentence about the repository's own process skills. It is written for
 * every outcome, including "no generator declared": three workers once came up without
 * the rules their repository generates, one noticed and two did not, and a participant
 * that is never told cannot notice (PB-8).
 */
export function repoSkillsLine(state) {
  const cmd = state?.argv?.length ? `\`${state.argv.join(' ')}\`` : 'the command it declares';
  switch (state?.kind) {
    case 'planned':
      return `Repository process skills: this repository declares a generator (${cmd}) in its ${HOST_CONFIG}, `
        + 'and spawn runs it in the fresh worktree after the checkout.';
    case 'invalid':
      return `Repository process skills will NOT be laid out: the repository's ${HOST_CONFIG} declares a `
        + `"${GENERATOR_FIELD}" field, but it ${state.why}, so there is nothing spawn can run. Whatever that `
        + 'command was meant to generate is missing here.';
    case 'ok':
      return `Repository process skills were laid out in this worktree: the repository declares a generator `
        + `(${cmd}) in its ${HOST_CONFIG}, and spawn ran it here after the checkout.`;
    case 'failed':
      return `Repository process skills were NOT laid out. The repository declares a generator (${cmd}) in its `
        + `${HOST_CONFIG}; spawn ran it in this worktree and it ${state.why}. Whatever that command generates — `
        + 'process skills, rules — is missing here. Run it yourself before you work; if it refuses again, say so '
        + 'in your first status instead of working without them silently.';
    case 'kept':
      return `Repository process skills were not regenerated on this lift: the worktree already existed (a repeat `
        + `spawn at the same address), and the repository's generator (${cmd}) runs only in a fresh one. Whether `
        + 'what a previous session generated is still there was not checked — look before you rely on it, and run '
        + 'the command yourself if it is gone.';
    default:
      return `Repository process skills: this repository declares no generator in a ${HOST_CONFIG} of its own, so `
        + 'whatever process skills it has travel with the checkout and are already here.';
  }
}

/**
 * The same three states for the OPERATOR, in `--dry-run`. It says what the preamble will
 * say, in one line: a run that printed "no generator declared" while the participant was
 * told the declaration is broken would send the reader looking in the wrong file.
 */
export function repoSkillsPlanNote(state) {
  if (state?.kind === 'invalid') {
    return `the repository declares "${GENERATOR_FIELD}" in its ${HOST_CONFIG}, but it ${state.why}`
      + ' — nothing will be run, and the participant is told so';
  }
  if (state?.argv?.length) {
    return `generator ${state.argv.join(' ')} — runs in the fresh worktree, after the checkout `
      + 'and before dependencies';
  }
  return `no generator declared in a ${HOST_CONFIG} of the repository — they travel with the checkout`;
}

/**
 * Outcome of the generator for the OPERATOR. `none` and `kept` say nothing out loud:
 * the preamble carries both, and a line about a step that did not happen would print on
 * every lift into every repository that never declared one.
 */
export function sayRepoSkills(state) {
  const cmd = state?.argv?.length ? state.argv.join(' ') : null;
  if (state?.kind === 'ok') {
    ok(`repository skills generated in the worktree (${cmd}, ${(state.ms / 1000).toFixed(1)} s)`);
    if (state.dirt?.length) {
      warn(`the generator left ${state.dirt.length} change(s) git can see in the worktree `
        + `(${state.dirt.slice(0, 3).join(', ')}${state.dirt.length > 3 ? ', …' : ''}) — the repository does not `
        + 'ignore what it generates, so the worker branch starts dirty and done will never sweep the directory. '
        + 'Add those paths to the repository .gitignore');
    }
    return;
  }
  if (state?.kind !== 'failed') return;
  warn(`repository skills NOT generated: ${cmd ? `${cmd} ` : ''}${state.why}`
    + `${state.logPath ? ` · log ${state.logPath}` : ''} — the participant is told this in its preamble, `
    + 'and spawn is not rolled back for it');
}

// Outcome of install in a just-created worktree. No lock — `ran: false`, no line.
// A refusal is a warning with a command, not `fail`: spawn of the participant is not
// rolled back for this.
export function sayWorktreeDeps(result) {
  if (!result?.ran) return;
  const dur = `${(result.ms / 1000).toFixed(1)} s`;
  if (result.ok) {
    ok(`worktree dependencies installed (npm ci, ${dur})`);
  } else {
    const log = result.logPath ? ` · log ${result.logPath}` : '';
    warn(`worktree dependencies not installed: npm ci ${result.why} — the worker will do it: ${result.command}${log}`);
  }
  if (result.ignored === false) {
    warn('git does not ignore node_modules in the worktree — the directory will stay dirty, done will not remove it');
  }
}

// Loop-guard line in `--dry-run`: the participant settings file and the identity the
// hook will call the bus with. Printed by both lift commands — `--dry-run` must show
// what will land on disk, and participant identity travels exactly here.
export function guardHookNote(plan) {
  return `participant settings: ${plan.settingsPath} · loop guard: ${plan.guardCommand}`;
}

// Participant-environment line in `--dry-run` — next to the environment assembly itself.
// Identity is no longer named in it: it is not in the session environment, it stands as
// Stop-hook command arguments in the settings file, and the line about that file prints it.
export function sessionEnvNote(driver, host) {
  const extra = host.extraEnv();
  return `session environment: ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')}`
    + ' — the memory gate does not hold a background session; '
    + `dropped from the parent: ${driver.options.envDrop.join(', ')} — these variables leak foreign values`;
}

// How `--dry-run` explains silence about the binary version — the same words for spawn
// and review. The driver names the binary: the command has none of its own.
export function dryRunToolNote(driver) {
  return `version was not checked: dry-run — ${driver.options.tool} --version is not run,`
    + ' the binary is resolved on the real run';
}

// About the binary — only when there is something to say. `reason: false` is for the
// real run, where `fail(tool.reason)` follows: the same text as a warning and a refusal
// in a row reads as two different troubles.
export function sayTool(tool, { reason = true } = {}) {
  if (tool.note) info(tool.note);
  if (tool.warn) warn(tool.warn);
  if (!tool.ok && reason) warn(tool.reason);
}

/**
 * The brief in the task files folder. The file the orchestrator passes is theirs and
 * temporary — a scratch note beside a run, and the consumer's workspace filled up with
 * directories of stale ones; the assignment itself is the one document that explains a
 * branch months later, so the bus keeps a copy next to the review diffs of the same
 * task. Every lift stores the brief it was given, and a repeat at the same address takes
 * the next number: overwriting would drop the assignment the previous session actually
 * worked by, and the history of assignments of an address is exactly what is being kept.
 *
 * A write refusal is a WARNING, in the voice of the dependency install: the worker is
 * already up by this point, and a throw here would end the command with a running
 * session, no report and no route back. What is lost is a copy — the orchestrator still
 * holds the file it passed.
 */
function keepBrief(plan) {
  try {
    ok(`brief kept in the task files: ${occupyTaskFile(filesDir(plan.home, plan.taskId), `brief-${plan.slug}`, '.md', `${plan.brief}\n`)}`);
  } catch (e) {
    warn(`the brief was not kept: ${e.message}; the participant is up, spawn is not rolled back for this`);
  }
}

export async function spawn(rootOrHost, opts) {
  const plan = await planSpawn(rootOrHost, opts);
  // Before the `--dry-run` branch: an ignored --task-title is reported on a dry run too.
  if (plan.titleKept) warn(plan.titleKept);
  // Same rule for an ignored --strategy, and for the decision itself: a routed lift
  // says which tuple it is about to take before it takes it.
  if (plan.routingSkipped) warn(plan.routingSkipped);
  if (plan.routing) info(routingLine(plan.routing));

  if (opts.dryRun) {
    info(`repository: ${plan.nsPath} (source: ${plan.via}) → ${plan.repoAbs}`);
    info(`task: ${plan.taskId}${plan.createNew ? ` (will be created: ${plan.createNew.title})` : ''}`
      + `${plan.retitle ? ` (will be renamed: ${plan.retitle.preview ?? plan.retitle.title})` : ''}`);
    info(`worker address: ${plan.address} · session: "${plan.name}" · model: ${plan.model}${plan.effort ? ` · effort: ${plan.effort}` : ''}${plan.permissionMode !== plan.driver.options.defaultPermissionMode ? ` · permission mode: ${plan.permissionMode}` : ''}${opts.harness ? ` · harness: ${plan.driver.id}` : ''}`);
    if (plan.decision) sayDecision(plan.decision);
    info(`worktree: ${plan.worktreePath} (branch ${plan.branch}, from ${plan.base})`);
    // The directory is not there yet — look at the lock in the clone: after `worktree add`
    // it will be at the root. The directory already exists (a restart) — there will be no
    // install, and there is no intent.
    if (!existsSync(plan.worktreePath) && worktreeHasLock(plan.repoAbs)) {
      info(`worktree dependencies: ${npmCiCommand()}`);
    }
    info(`mcp-config: ${plan.mcpConfigPath}`);
    info(guardHookNote(plan));
    info(sessionEnvNote(plan.driver, plan.host));
    // What this output does NOT have and why: a harness that invents the session name
    // itself cannot have it printed in advance, and silence about that would read as a skip.
    if (plan.driver.phrases.naming) info(`harness session name: ${plan.driver.phrases.naming}`);
    info(`participant MCP (${plan.mcpConfig.mcpServers ? Object.keys(plan.mcpConfig.mcpServers).length : 0}):`);
    for (const line of mcpServerLines(plan.mcpConfig)) console.log(`  ${line}`);
    sayMcp(plan, { hint: false });
    info(`workspace skills: ${skillsNote(plan)}`);
    info(`repository skills: ${repoSkillsPlanNote(plan.repoSkills)}`);
    info(`worker rules:`);
    for (const f of plan.rules) console.log(`  ${f}`);
    sayModule(plan);
    // Binary version is not asked in `--dry-run`: resolve runs `claude --version`
    // (~200 ms of a process) for an answer that affects nothing here.
    info(dryRunToolNote(plan.driver));
    info('command:');
    console.log(`  cd ${shellQuote(plan.cwd)} && ${plan.driver.options.tool} ${plan.argv.slice(0, -1).map(shellQuote).join(' ')} <prompt>`);
    info('prompt:');
    console.log(plan.prompt);
    ok('dry-run: nothing written to disk, worker not started');
    return plan;
  }

  // The binary is resolved HERE, not in the plan: resolve starts a process, and the plan
  // promises it does nothing. The driver names the binary — the command has none of its
  // own. `opts.tool` is a test seam.
  const tool = opts.tool ?? plan.host.resolveToolBin(plan.driver.options.tool);

  // Binary refusal is BEFORE the first write to disk: otherwise a worktree, a branch, and
  // a participant record would remain. `sayTool` stands BEFORE the refusal: the "version
  // is older" branch has a `note` about the directory of the found binary — otherwise a
  // person updates the wrong binary.
  sayTool(tool, { reason: false });
  if (!tool.ok) fail(tool.reason);
  const ultra = optionRefusal(plan.driver, plan.effort, tool);
  if (ultra) fail(ultra);

  // There is no rules list on the real run: the set the participant is lifted with is
  // announced by these two lines.
  sayModule(plan);
  sayMcp(plan);

  // Worktree exclude goes FIRST, before freshenRepo: an unexcluded directory of a past
  // worker reads as an uncommitted edit, and freshenRepo deliberately does not touch a
  // dirty tree — the default branch would not be pulled.
  const excluded = excludeWorktrees(plan.repoAbs);
  if (excluded.status === 'added') {
    info(`${plan.nsPath}: service worktrees excluded from git status (.git/info/exclude) — otherwise the clone stays dirty forever`);
  } else if (excluded.status === 'failed') {
    warn(`${plan.nsPath}: service worktrees NOT excluded from git status (${excluded.error}) — the clone will stay`
      + ' dirty, and fresh will stop pulling its default branch. Add the line yourself:'
      + ' **/.claude/worktrees/ in .git/info/exclude');
  }

  plan.host.reportFresh(plan.host.freshenRepo(plan.repoAbs), plan.nsPath);

  // Worktree branch point goes into the task journal: `promptobus review` counts the
  // diff from it. git counts it at branch creation, not the plan: the plan was assembled
  // BEFORE freshenRepo, and a sha from it would diverge from the real one by pulled commits.
  let baseSha = plan.knownBaseSha;
  // Directory already exists — a routine restart of a dead worker: continue in its tree.
  // Dependency install is after the participant write: otherwise Ctrl+C on a long `npm ci`
  // leaves a directory with no journal line, and a repeat hits "directory is taken".
  let freshWorktree = false;
  if (!existsSync(plan.worktreePath)) {
    const made = createWorktree(plan.repoAbs, plan.worktreePath, plan.branch, plan.base);
    if (!made.created) fail(`git worktree add: ${made.error} — the worker has nowhere to work`);
    if (made.reused) ok(`worktree ${plan.wtName} created on the surviving branch ${plan.branch} — previous worker's work is in place`);
    else ok(`worktree ${plan.wtName} created from ${plan.base} (branch ${plan.branch})`);
    baseSha ??= made.baseSha;
    freshWorktree = true;
  }

  if (plan.createNew) {
    createTask(plan.home, plan.createNew);
    ok(`task ${plan.taskId}: ${plan.createNew.title}`);
  }
  // "session → task" bind: `promptobus spawn` is started by Bash from the orchestrator
  // session and inherits its identity. Written only for the task owner.
  bindIfOwner(plan.home, plan.taskId);

  // The participant goes into the journal BEFORE anything long runs in the worktree —
  // the repository generator and the dependency install both are: refusal branches leave
  // through `fail()`, and Ctrl+C on either would otherwise leave a directory with no
  // record — a repeat hits "directory is taken, and the journal has none". A repeat
  // recognizes its own directory by `worktreeName`.
  // The record is written by the registry: it also refuses — an unknown harness and a
  // driver that cannot lift a session — BEFORE the participant appears in the journal.
  // It also fills harness, mode, sessionRef, and the capabilities snapshot.
  const { record } = openParticipant(plan.home, plan.taskId, participantRecord(plan.address, {
    // Record harness is the one that lifts it. Without it the registry would assign
    // the participant `fallback`, and all further work with its session — state, stop,
    // routes — would go through a FOREIGN harness's driver.
    harness: plan.driver.id,
    repo: plan.nsPath,
    repoAbs: plan.repoAbs,
    worktree: plan.worktreePath,
    branch: plan.branch,
    // Branch point was not found — no field at all, review stays on the previous behavior.
    ...(baseSha ? { baseSha } : {}),
    model: plan.model,
    ...(plan.effort ? { effort: plan.effort } : {}),
    // The routing decision rides in `metadata` and nowhere else: the field is opaque
    // to the core by construction, so a record carrying one is readable by a
    // mechanism of any version, and `promptobus status` reads it back through the
    // accessor rather than by reaching into the map.
    ...(plan.routing ? { [ROUTING_FIELD]: plan.routing } : {}),
    name: plan.name,
    sessionRef: plan.name,
    ...(plan.workTitle ? { title: plan.workTitle } : {}),
    worktreeName: plan.wtName,
    started: new Date().toISOString(),
    mechanismVersion: plan.host.version,
  }), REGISTRY);

  // The repository's own generator: after the journal record, so a Ctrl+C inside a long
  // generator cannot leave a directory the next spawn refuses to reuse; before the launch
  // files, because the drivers plant their harness config directories in that same tree
  // and a generator writing next to them must not be the last writer; and before the
  // dependency install, so the worktree has no `node_modules` yet — the field restores
  // process skills, and an `npx …` generator does not care while an `npm run …` one
  // would. That trade is written down in the CLI reference. The launch is rebuilt right
  // here, with the real outcome, so the preamble says what actually happened (PB-8).
  const repoSkills = runRepoGenerator(plan, { fresh: freshWorktree });
  sayRepoSkills(repoSkills);
  const rebuilt = plan.rebuild(repoSkills);
  plan.repoSkills = repoSkills;
  plan.prompt = rebuilt.prompt;
  plan.launch = rebuilt.launch;
  plan.argv = rebuilt.launch.argv;
  plan.mcpConfig = rebuilt.launch.mcpConfig;
  plan.settings = rebuilt.launch.settings;

  writeLaunchFiles(plan.launch.files);

  if (freshWorktree) {
    if (worktreeHasLock(plan.worktreePath)) {
      info(`installing dependencies from package-lock.json (${npmCiCommand()})`);
    }
    sayWorktreeDeps(installWorktreeDeps(plan.worktreePath));
  }

  // The task title is extended AFTER the participant write and entirely under the lock:
  // assembly walks the journal that already has this track.
  if (plan.retitle) {
    const named = retitleTask(plan.home, plan.taskId, plan.retitle);
    if (named) ok(`task ${plan.taskId}: ${named}`);
    else if (plan.retitle.restamp) {
      const outcome = restampOutcome(readTask(plan.home, plan.taskId).title, plan.retitle.title);
      if (outcome.level === 'ok') ok(`task ${plan.taskId}: ${outcome.text}`);
      else warn(`task ${plan.taskId}: ${outcome.text}`);
    }
  }

  // Lift goes through the driver taken from the registry. On Windows a multiline argv
  // survives only on the native binary; `claude.cmd` pulls cmd.exe, and the helper gives
  // a clear refusal instead of a mangled command. Start and the "session came up" check
  // are shared with the reviewer in liftoff.js, and they live on the driver.
  const { output, session, seen } = await plan.driver.spawn(plan.launch, {
    tool,
    // Address, task, and bus home travel to the driver TOGETHER with the plan: a harness
    // whose wake channel is driven by the mechanism itself has to hand contact points to
    // its own machinery, and there is nothing else to address them with.
    home: plan.home,
    // The workspace interface travels with them: a lift refused because the
    // account's limit was spent between the preflight and this launch is marked
    // in the availability cache, and the cache file is named by the host.
    host: plan.host,
    task: plan.taskId,
    address: plan.address,
    cwd: plan.cwd,
    env: plan.env,
    ref: plan.name,
    role: 'worker',
    launchFailNote: ` Task ${plan.taskId} and participant record ${plan.address} are in place: `
      + 'repeat spawn with the same command — the worker will sit in its directory, no need to create it again.',
    deadNote: ` Task ${plan.taskId} and participant record ${plan.address} are in place: repeat spawn with the same command.`
      + ' There will be no messages from this address — waiting for them is pointless.',
    persist: (id, state, sessionId) => upsertParticipant(plan.home, plan.taskId,
      { ...record, metadata: { ...record.metadata, session: id, ...(sessionId ? { sessionId } : {}) } }),
    awaitOptions: opts.awaitOptions,
  });
  ok(`worker ${plan.address} lifted in ${plan.nsPath}, branch ${plan.branch}${session ? ` (session ${session})` : ''}`);
  // The warden is lifted right after the participant. Spawn does not hand over its own
  // contact point — each participant hands it over itself, from its own bus process.
  ensureWarden(plan.home, plan.taskId, { host: plan.host });
  // The brief copy is AFTER the lift, and only after it: a refused spawn leaves no
  // artifact — a brief of a worker that never started explains nothing and would be read
  // as an assignment someone is working by. And after the warden: the safety net over a
  // live participant must not depend on a file write.
  keepBrief(plan);
  plan.driver.saidLiftoff({ name: plan.name, seen, session, output });
  return plan;
}

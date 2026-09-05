import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ok, info, warn, fail, GIT_MAX_OUTPUT } from './util.js';
import { normalize } from './fuzzy.js';
import { hostOf } from './host.js';
import { guardHookCommand } from '../dist/hooks.js';
import {
  activeTasks, addressOf, bindIfOwner, claimRoute, createTask, filesDir,
  foreignTaskLine, GateError, newTaskIdentity, numberedName, occupyTaskFile, ownership,
  participantMcpPath, participantOf,
  participantRecord, participantSettingsPath, readTask, reviewerAddress, sendMessage,
  sessionIdentity, slugify, taskExists, unreadNote, upsertParticipant, watchParticipant,
  ORCHESTRATOR,
} from './store.js';
import {
  dryRunToolNote, guardHookNote, liftHarness, memoryRule, mcpNote, mcpServerLines, optionRefusal,
  participantMcp, participantPluginDir, PROMPTOBUS_SERVER, resolveEffort, resolvePermissionMode,
  sayMcp, sayModule, sayTool, sessionEnv, sessionEnvNote, sessionName, skillSettings, skillsNote,
  toolName, writeLaunchFiles,
} from './spawn.js';
import { participantSession } from './status.js';
// Same routing gate the worker lift stands on ([models.js](models.js)): the
// context is built by `review` because the preflight is asynchronous, and the
// pick is taken here, where the task and its live participants are known.
import { decideLift, routingContext, routingLine, sayDecision } from './models.js';
import { hasFeature, openParticipant, ROUTING_FIELD } from '../dist/index.js';
import { driverOf, REGISTRY } from './drivers.js';
import { ensureWarden } from './warden.js';

// Reviewer — a Promptobus bus participant: a background harness session in the
// directory of the reviewed working copy. One reviewer per task and repository: the
// first call starts the session, a repeat sends it a new diff at the same address —
// the reviewer remembers its findings. Isolation is from the context of the session
// that wrote the code, not from the code: access to the working copy is read-only,
// and the driver stripping tools is what holds that.
//
// **Read-only is a capability, not a wish**. A harness that cannot strip tools would
// start the reviewer with write access to the reviewed tree — that is not "review
// without a guarantee", it is a session that edits the code under review. So
// `denyTools` is asked BEFORE lift and before any write to disk.

/**
 * Refusal on the ability to strip tools. `null` — the driver declared it, lift is
 * allowed. A pure function: there is no live driver without `denyTools` on the map,
 * and there is no other way to check the branch — a stand-in object is passed to
 * it directly.
 */
export function denyToolsRefusal(driver) {
  if (hasFeature(driver, 'denyTools')) return null;
  return `harness "${driver.id}" cannot strip session tools, and isolation of the reviewer rests `
    + 'exactly on that: a reviewer it started would write the reviewed tree, not read it. '
    + 'Review is not started with this harness — take a harness that declares denyTools.';
}

// Hint "how to wait for the report". We name the task by its id — what `--task`
// accepts: otherwise `--task` would get the session name from the neighboring line
// of `claude --bg` output.
function waitHint(what, taskId) {
  return `${what} will arrive as a type=result message to the orchestrator of task ${taskId}: `
    + 'the bus warden will wake you, fetch the mailbox';
}

/**
 * Which reviewer this subject belongs to: the worktree owner, the slug and the
 * address.
 *
 * The slug comes from the review SUBJECT, not from the clone root: with several
 * workers of one repository `basename` would give one address, and a review of
 * the second would reach the live reviewer of the first as a re-review. There is
 * no flag for it on purpose.
 *
 * A function rather than three lines inside the plan, because `review` asks the
 * same question before the plan exists — and two copies of this rule would part
 * on the first change, leaving the earlier question answered by the older one.
 */
function reviewerFor(taskMeta, repoDir, clone) {
  const owner = worktreeOwner(taskMeta, repoDir);
  const slug = (owner ? addressSlug(addressOf(owner)) : normalize(path.basename(clone.abs))) || 'repo';
  return { owner, slug, address: reviewerAddress(slug) };
}

/**
 * Whether this subject already has a reviewer in the journal.
 *
 * Asked before the routing context is built, and only for that: a re-review
 * sends a new diff to a session whose harness its first lift fixed, so there is
 * nothing for a strategy to choose — and paying a fifteen-second preflight to be
 * told the flag was ignored is the one cost that has no answer to show for it.
 *
 * Read-only, and deliberately silent about everything it trips over. Every gate
 * it touches — a target that is not a clone, a task that is closed or foreign, a
 * directory claimed by two tasks — is raised by `planReview` a moment later in
 * its own words. Answering "no" here only means the context is built, and the
 * plan then refuses exactly as it would have.
 */
function reviewerInJournal(host, { target, task }) {
  try {
    const resolved = resolveRepoDir(target);
    if (resolved.refusal) return false;
    const clone = host.cloneOf(resolved.repoDir);
    if (!clone) return false;
    const home = host.promptobusHome();
    const taskId = task ?? claimingTasks(home, resolved.repoDir)[0]?.id ?? null;
    if (!taskId || !taskExists(home, taskId)) return false;
    const meta = readTask(home, taskId);
    return !!participantOf(meta, reviewerFor(meta, resolved.repoDir, clone).address);
  } catch {
    return false;
  }
}

// Review plan: everything is computed, nothing is written to disk. The same plan
// is printed by --dry-run and used by the real start. The promise is about write
// and lift, not about external processes: the plan reads git and asks
// `claude agents --json` about liveness of the reviewer session. Gates of the
// request itself (no path, target outside repos/) throw; a refusal from what was
// read (not-git, failed git) leaves as a `{ refusal }` FIELD: `fail()` here would
// take a unit test past the summary.
export function planReview(rootOrHost, { target, base, task, title, model, effort: effortOpt, permissionMode: permissionOpt, harness, strategy = undefined, routing = null, dryRun } = {}) {
  const host = hostOf(rootOrHost);
  // LIFT driver — the one the person asks to start the session with (`--harness`).
  // Its option dictionary is not asked here yet: an already opened reviewer has its
  // own harness, and checking `--effort` against a foreign dictionary would let a
  // Claude Code value through into Cursor (review finding). Both flags are parsed
  // below, once the participant driver is known.
  const lifter = liftHarness(host, harness);
  // Both sides of the comparison are in canonical native form: git rev-parse on
  // Windows prints C:/… with forward slashes, and realpathSync strips
  // /var ↔ /private/var on macOS. Without this the repos/ prefix check falsely
  // refuses a path inside the workspace.
  const root = realpathSync(host.workspaceRoot());
  // Repository path is required: there is no resolve from `cwd` — the directory of
  // the agent shell session is not reset. The gate stands first: before diff
  // computation, createTask and `claude --bg`.
  if (!String(target ?? '').trim()) {
    // The hint repeats the call FLAGS, not the parsed values: parsing `--effort`
    // sits below, after the participant driver, and the path gate is the very
    // first, before any work.
    throw new Error(missingTarget(host, { task, title, base, model, effort: effortOpt, harness, dryRun }));
  }
  const resolved = resolveRepoDir(target);
  if (resolved.refusal) return { refusal: resolved.refusal };
  const { targetDir, repoDir } = resolved;
  if (!host.inWorkspace(repoDir)) {
    // The target is inside repos/, and its git-toplevel is above: this is a group
    // folder with nested clones, not a clone — an "outside repos/" refusal here
    // would confuse.
    if (host.inWorkspace(targetDir)) {
      throw new Error(host.reviewLayoutError('not-clone', { targetDir, repoDir }));
    }
    throw new Error(host.reviewLayoutError('outside', { repoDir }));
  }
  // Which clone that is and how it is named — the host's answer: zones and
  // namespace depth are its layout, not the package's.
  const clone = host.cloneOf(repoDir);
  if (!clone) throw new Error(host.reviewLayoutError('no-clone', { repoDir }));
  const nsPath = clone.nsPath;

  const home = host.promptobusHome();
  if (task && !taskExists(home, task)) throw new GateError(`there is no task ${task}`);
  // A closed task is a legal entry for nobody: an explicit `--task` is not a
  // bypass. Without the flag, pickup looks at activeTasks and will not pick a
  // closed one itself.
  if (task && readTask(home, task).status === 'done') {
    throw new GateError(`task ${task} is closed — nobody for the reviewer to report to: `
      + '`promptobus status` lists the active ones, and `promptobus done` cleanup sweeps worktree directories of all closed tasks, '
      + 'so the next close would pull the worktree out from under a live session. '
      + 'A new run — review without --task and with --title: without a name the command will not open a task. '
      + 'If the directory is listed as a worktree of an active task — without --task it will pick that one up, not open a new one. '
      + 'Review into another live one — name it with --task, just not this id. '
      + 'There is nothing to continue work in a closed task with: promptobus done has no undo.');
  }
  // Without `--task` the review subject itself names the task: if the directory is
  // listed as a participant worktree of an active task — that one is taken (and
  // the branch point from there too), otherwise a task of its own is opened.
  const claiming = task ? [] : claimingTasks(home, repoDir);
  if (claiming.length > 1) {
    throw new Error(`directory is listed in several active tasks at once (${claiming.map((t) => t.id).join(', ')})`
      + ' — the command will not choose for the person: name the one you want, --task <id>');
  }
  const existing = task ?? claiming[0]?.id ?? null;
  // Owner gate sits ON TOP of directory pickup: it catches a directory listed in a
  // task whose mailbox is bound to ANOTHER session — otherwise the started
  // reviewer would report to a foreign orchestrator. Explicit `--task` does not
  // know this gate.
  if (!task && existing) {
    const own = ownership(home, existing, ORCHESTRATOR, sessionIdentity());
    if (own.gated) {
      throw new GateError(`directory ${repoDir} is listed as a worktree of a participant of a foreign run: `
        + `${foreignTaskLine(readTask(home, existing), own)}. A reviewer started from here will report `
        + 'to its orchestrator, and copies marked FOREIGN_MARK will arrive here. '
        + `Review by agreement with the owner — name the task explicitly: --task ${existing}. `
        + `${claimRoute('promptobus review')}`);
    }
  }
  // We warn about the other active ones only where we open our own.
  const otherActive = existing ? [] : activeTasks(home).map((t) => t.id);
  // The command does not invent a task name: opening a new one — name it; the
  // session is called by that name. Checked below, once we know there is something
  // to review.
  const identity = existing ? null : newTaskIdentity(slugify(String(title ?? '').trim()));
  const taskId = existing ?? identity.id;
  // Plan shape is journal shape, the same `readTask` returns: slug and stamp sit
  // in `adapter`.
  const createNew = existing ? null : {
    id: taskId,
    title: String(title ?? '').trim(),
    status: 'active',
    adapter: {
      ...(identity.slug ? { slug: identity.slug } : {}),
      ...(identity.stamp ? { stamp: identity.stamp } : {}),
    },
    participants: [],
  };
  const taskMeta = createNew ?? readTask(home, taskId);

  // Whose review subject this is: a directory listed as a participant worktree is
  // reviewed FOR them — the reviewer address and the diff base come from them; the
  // main clone has no owner.
  const titleIgnored = !!(existing && String(title ?? '').trim());
  const { owner, slug, address } = reviewerFor(taskMeta, repoDir, clone);
  // Mechanism fields sit in the v1 record `metadata`: address, branch point and
  // slice title.
  const ownerFields = owner?.metadata ?? {};
  const ownerAddress = owner ? addressOf(owner) : null;

  // Diff base: `--base` is strongest; then the branch point spawn wrote; and only
  // then a guess from the default branch — its remote version does not contain
  // the orchestrator's unpushed work, and that would land in every worker diff.
  // We do not take the recorded point at its word: the branch may have been
  // rebased, and the commit may be missing from the clone — first it is checked
  // against HEAD history. A second slice of work on the same branch needs the
  // default branch merged in, and the recorded point moves back while remaining
  // an ancestor of HEAD — so the base is computed at review time, `merge-base`
  // with the LOCAL default branch.
  const isWorktree = repoDir !== clone.abs;
  const recorded = base ? null : ancestorOfHead(repoDir, ownerFields.baseSha);
  // The main clone is still computed from the default branch: merge-base with
  // itself would give HEAD and an empty diff, and review of the orchestrator's
  // unpushed work is a legal move.
  const defBranch = base || !isWorktree ? null : localDefault(repoDir, host);
  const computed = defBranch ? mergeBase(repoDir, defBranch) : null;
  // The computed base is worse than the recorded one in two cases: the default
  // branch was rewritten (merge-base moves BACK to the common ancestor; the sign
  // is that the recorded point is not an ancestor of the computed one) and the
  // worker branch was already merged (merge-base equals HEAD, the diff is empty).
  const head = headOf(repoDir);
  // Matching HEAD is not enough: on a fresh worktree HEAD equals the tip of the
  // default branch, and the recorded point equals both — "work already merged"
  // would be a lie there.
  const mergedIntoDefault = !!computed && !!head && computed === head && computed !== recorded;
  const rewound = !!computed && !!recorded && computed !== recorded && !isAncestor(repoDir, recorded, computed);
  const live = (mergedIntoDefault || rewound) && recorded ? null : computed;
  let baseRef;
  let baseSource;
  if (base) {
    baseRef = base;
    baseSource = 'set by --base';
  } else if (live) {
    baseRef = live;
    // A mismatch of recorded and computed bases is named out loud in the same
    // line: the base shift is visible from it, not from the size of the diff.
    baseSource = recorded === live ? `worktree branch point of ${ownerAddress}`
      : recorded ? `merge-base with ${defBranch} at review time; recorded point ${recorded} was left behind — ${defBranch} was merged into the worker branch`
        : `merge-base with ${defBranch} at review time`;
  } else if (recorded) {
    baseRef = recorded;
    baseSource = mergedIntoDefault
      ? `worktree branch point of ${ownerAddress}; work already merged into ${defBranch}`
      : rewound
        ? `worktree branch point of ${ownerAddress}; ${defBranch} was rewritten, merge-base with it moved back`
        : `worktree branch point of ${ownerAddress}`;
  } else {
    baseRef = detectBase(repoDir);
    baseSource = 'repository default branch';
  }
  // The base is named out loud — one line for command output, the prompt and the
  // re-review message.
  const baseLine = baseRef
    ? `diff base: ${baseRef} (${baseSource})`
    : 'diff base: not determined — only uncommitted work is reviewed';
  // Mechanical gate: the condition looks at the SOURCE of the base, not at the
  // set of fields in the record — a record with a worktree but no baseSha would
  // otherwise fall through both conditions.
  const warnings = [];
  // An empty diff on a merged branch and on an untouched one look the same:
  // after the merge the default branch points at the same tip. The command names
  // the fact, not a guess.
  if (isWorktree && !base && mergedIntoDefault && !recorded) {
    warnings.push(`HEAD of this branch matches ${defBranch}: there is no work on top of it — `
      + 'the worker has either committed nothing yet, or its branch was already merged. '
      + 'To review earlier work — pass --base <branch-point sha>');
  }
  if (isWorktree && !base && !live && !recorded) {
    const why = !owner
      ? (task ? `in the journal of task ${task} it is listed for nobody`
        : 'this directory is listed in no active task')
      : ownerFields.baseSha
        ? `recorded point ${ownerFields.baseSha} is not in HEAD history — the branch was rebased or the commit is not in the clone`
        : `record ${ownerAddress} has no branch point, it was made by a former CLI`;
    warnings.push(`the target is a worktree, but there is nowhere to take the branch point from (${why}), `
      + `and computing it from the local default branch failed: ${baseLine} — foreign work may enter the diff. `
      + `Pass --task <id of the worker task> or --base <branch-point sha>`);
  }
  if (!baseRef) warnings.push('base branch is not determined — only uncommitted work is reviewed (pass --base <ref>)');
  // Four git reads are checked separately: the next one depends on the previous.
  const from = baseRef ? git(repoDir, ['merge-base', baseRef, 'HEAD']) : { out: 'HEAD' };
  if (from.refusal) return { refusal: from.refusal };
  const diffFrom = from.out;
  const diffOut = gitRaw(repoDir, ['diff', diffFrom]);
  if (diffOut.refusal) return { refusal: diffOut.refusal };
  const diff = diffOut.out;
  const others = git(repoDir, ['ls-files', '--others', '--exclude-standard']);
  if (others.refusal) return { refusal: others.refusal };
  const untracked = others.out.split('\n').filter(Boolean);
  const statOut = gitRaw(repoDir, ['diff', '--stat', diffFrom]);
  if (statOut.refusal) return { refusal: statOut.refusal };
  const stat = statOut.out.trim();

  const participant = participantOf(taskMeta, address);
  const was = participant?.metadata ?? {};
  // The participant name from the journal is not rewritten: the reviewer session
  // was started under it, and re-review finds it by that same line. The title is
  // taken from the worktree owner.
  const name = was.name ?? sessionName(taskMeta, {
    slug,
    reviewer: true,
    title: ownerFields.title,
    taken: (taskMeta.participants ?? []).map((p) => p.metadata.name).filter(Boolean),
  });
  // Re-review goes to the participant only if its bg-session is alive: after
  // `claude stop` the message would sit in the mailbox forever. Unknown — we send
  // the diff to the former address.
  const sessionState = participant ? participantSession(participant) : null;
  // A record BEFORE start makes "the reviewer is in the journal" true even for
  // one that never lifted. We look at `pending`, not at `participant.session`: a
  // live reviewer whose id did not parse from `claude --bg` output has no field
  // either.
  const unlaunched = !!was.pending && sessionState !== 'alive';
  const reuse = !!participant && sessionState !== 'dead' && !unlaunched;
  // --effort applies to session lift, not to re-review: recreating loses finding context.

  // A module may declare a review procedure — a skill from its composition
  // (module.json, review.skill field). An absolute path is enough for the
  // reviewer: skill materials resolve from its directory by ordinary read, plugin
  // load is not needed.
  const moduleHit = host.resolveRepoModule(repoDir);
  const declaredSkill = moduleHit?.meta?.review?.skill;
  let skill = null;
  if (declaredSkill) {
    const dir = host.reviewSkillDir(declaredSkill);
    if (!existsSync(path.join(dir, 'SKILL.md'))) {
      throw new Error(`module ${moduleHit.name} declared review skill "${declaredSkill}", but ${dir} is not laid out — ${host.syncHint()}`);
    }
    const shared = path.join(host.workspaceRoot(), host.pluginSkillsRel(), '_shared');
    skill = { name: declaredSkill, module: moduleHit.name, dir, shared: existsSync(shared) ? shared : null };
  }

  // A name is required only when a task will actually be opened. Absence of a
  // SLUG is not treated as absence of a name: a name outside latin letters gives
  // an empty slug, and a "there is no name" refusal on a command with `--title`
  // already named would loop — the id then stays a stamp alone.
  if (createNew && !identity.slug && (diff.trim() || untracked.length)) {
    if (!createNew.title) {
      throw new Error(`review of ${nsPath} opens a new task, and it has no name: `
        + 'name it — --title "<whose work we are looking at>". '
        + `Reviewing work of the worker on an active task — name that instead: --task <id>`);
    }
    warnings.push(`name "${createNew.title}" does not translate into an id slug (only `
      + `latin letters and digits go in) — the task id stayed a machine stamp ${taskId}. `
      + `The name is kept in full in the task journal and in the reviewer session name`);
  }

  // Driver — from the registry and before any journal write, as with worker spawn:
  // for an already started reviewer, the one that started it; for a new one, the
  // lift driver. It is taken BEFORE the prompt and before the skills directory:
  // bus tool names in the prompt and whether the harness takes a skills directory
  // are its dictionary.
  //
  // Routing sits in the same place and before every write for the same reason as
  // on `planSpawn`: a strategy with no candidate must leave no task, no diff file
  // and no participant behind. Only on a FRESH lift — a reviewer already in the
  // journal keeps the harness its first lift fixed, and a repeat call is a new
  // diff to a running session rather than a new pick.
  const routed = participant ? null : decideLift(routing, { taskMeta, address });
  // The line is owed to `--strategy`, not to a context: `review` does not build
  // one when the address is already taken, and a skip that only spoke when the
  // preflight had been paid for would be silent exactly where it matters.
  const routingSkipped = participant && strategy
    ? `${address} in task ${taskId} is already in the journal, started by harness ${participant.harness}: `
      + '--strategy routes a lift, and this call sends a new diff to a reviewer whose harness is already '
      + 'fixed. The flag is ignored here.'
    : null;
  const driver = participant ? driverOf(participant) : (routed ? liftHarness(host, routed.harness) : lifter);
  // Re-review with a foreign harness is a refusal, not a silent swap (review
  // finding): the reviewer session is already started in another tool, and there
  // is no way to change its tool on the fly. The same gate stands on `planSpawn`.
  if (participant && harness && harness !== driver.id) {
    throw new GateError(`${address} in task ${taskId} was started by harness ${driver.id}, and --harness asks for `
      + `${harness}: a repeat call sends a NEW DIFF to the reviewer already started, and there is no way to change its tool `
      + `on the fly. Need a reviewer of another tool — open it its own task: --title <name>.`);
  }
  // Legal flag values — the dictionary of THIS participant's driver: both flags
  // apply to session lift, not to re-review, but harness dictionaries differ, and
  // a check against a foreign one would let a Claude Code level through into
  // Cursor — it would leave as a model id suffix.
  // A routed lift takes the effort from the tuple the resolver picked, and it goes
  // through this same gate: the catalog is data, and a level no driver knows must
  // refuse here rather than reach the binary as an unknown flag.
  const effort = resolveEffort(routed ? (routed.effort ?? undefined) : effortOpt, driver);
  // Without the flag the reviewer starts on the binary's mode — its rights are
  // cut by tool stripping in the settings file; the flag is for one lift, like
  // `--effort`.
  const permissionMode = resolvePermissionMode(permissionOpt, driver, null);

  const diffPath = path.join(filesDir(home, taskId), diffName(home, taskId, slug));
  const rules = host.collectRules(repoDir);
  // Base rules and the diff sit outside the reviewer working directory, and a
  // read outside it Claude Code asks permission for: without --add-dir the
  // reviewer would stall on the first instruction of its own prompt. That does
  // not grant write rights.
  const ruleDirs = [...new Set(rules.map((f) => path.dirname(f)))];
  const addDirs = [...new Set([...ruleDirs, path.dirname(diffPath)])];
  const prompt = buildPrompt({ taskId, nsPath, repoDir, address, diffPath, stat, untracked, baseLine, rules, skill, driver, host });
  const reReview = buildReReview({ diffPath, stat, untracked, baseLine });

  const settingsPath = participantSettingsPath(home, taskId, address);
  const guardCommand = guardHookCommand(host, { address, taskId, home }, process.platform);
  // Not every harness takes a skills directory — the same rule as for the worker.
  const pluginDir = driver.options.skillsDir ? participantPluginDir(host) : null;
  // Canonical MCP list — the same path as for the worker: read-only is held by tool stripping.
  const mcpConfigPath = participantMcpPath(home, taskId, address);
  const mcp = participantMcp(host, { address, taskId, home }, driver);

  // The lift plan is assembled by the driver — as with worker spawn. Settings are
  // the same as for the worker, plus stripped tools: workspace skills are needed
  // by the reviewer too — the review procedure arrives as a module skill. The
  // loop guard command is the same as for the worker: the workplace hook does not
  // reach a session in a foreign directory. Permission-mode is the default: reads
  // are not asked, and there is no flag here at all.
  // Model without a flag — the driver default, as for the worker.
  const resolvedModel = routed?.model ?? model ?? driver.options.defaultModel;
  const launch = driver.prepare({
    ref: name,
    address,
    task: taskId,
    home,
    role: 'reviewer',
    mcp: mcp.descriptor,
    prompt,
    cwd: repoDir,
    model: resolvedModel,
    effort,
    permissionMode,
    addDirs,
    pluginDir,
    mcpConfigPath,
    settingsPath,
    guardCommand,
    denyTools: driver.options.denyTools,
    extraSettings: skillSettings(host),
    root,
  });

  return {
    home, taskId, createNew, otherActive, slug, address, name, nsPath, repoDir, baseRef, baseLine, owner, warnings,
    diff, untracked, stat,
    participant, sessionState, reuse, unlaunched, titleIgnored, skill, rules, ruleDirs, addDirs, diffPath, prompt, reReview,
    module: host.moduleNote(repoDir), pluginDir,
    settingsPath, guardCommand, mcpConfigPath, mcpNote: mcpNote(mcp, 'the reviewer'),
    launch, argv: launch.argv, mcpConfig: launch.mcpConfig, settings: launch.settings,
    model: resolvedModel, effort, permissionMode, driver,
    routing: routed?.metadata ?? null, decision: routed?.decision ?? null, routingSkipped,
    // Environment is a plan field: `--dry-run` prints what the real start executes.
    // There is no bus identity in it: it goes to the reviewer the same way as to
    // the worker — as arguments of the Stop-hook command in its settings file.
    env: sessionEnv(driver, process.env, host),
    host,
  };
}

// Mail piled up in its own mailbox the orchestrator sees here too: a notification
// may not have arrived. A task opened by this same call does not get a counter:
// its mailbox is empty by construction.
function warnUnread(plan) {
  if (plan.createNew) return;
  const note = unreadNote(plan.home, plan.taskId, ORCHESTRATOR, sessionIdentity());
  if (note) warn(note);
}

export async function review(rootOrHost, opts) {
  // The routing context is built before the plan and only for a routed call: the
  // preflight is asynchronous and the plan is a synchronous pure function. The
  // path gate of `planReview` is repeated here first, and only on this branch —
  // a command that forgot its argument must not probe three harnesses to be told
  // so, and on every other call the gate stands exactly where it always did.
  const routing = opts?.strategy === undefined || opts?.strategy === null ? null : await (async () => {
    const host = hostOf(rootOrHost);
    if (!String(opts.target ?? '').trim()) {
      throw new Error(missingTarget(host, {
        task: opts.task, title: opts.title, base: opts.base, model: opts.model,
        effort: opts.effort, harness: opts.harness, dryRun: opts.dryRun,
      }));
    }
    // A reviewer already in the journal fixes its own harness, so there is
    // nothing to route and nothing to pay a preflight for. The plan still says
    // the flag was ignored — it reads `--strategy`, not the context.
    if (reviewerInJournal(host, { target: opts.target, task: opts.task })) return null;
    return routingContext(host, {
      role: 'reviewer',
      strategy: opts.strategy,
      harness: opts.harness,
      model: opts.model,
      effort: opts.effort,
      allowPayg: opts.allowPayg,
      refresh: opts.refresh,
      dryRun: opts.dryRun,
      // Test seam, like `opts.tool`: the suite routes against stand-in adapters
      // rather than starting a harness binary. The CLI never sets it.
      adapterFor: opts.adapterFor,
    });
  })();
  const plan = planReview(rootOrHost, { ...opts, routing });
  if (plan.routingSkipped) warn(plan.routingSkipped);
  if (plan.routing) info(routingLine(plan.routing));
  // A plan refusal is printed and the command exits: `fail()` lives here, not in
  // the plan.
  if (plan.refusal) fail(plan.refusal);
  // The binary is resolved lazily: the command has three early returns without
  // lift. `opts.tool` is a seam.
  let toolCache = null;
  // The binary name is named by the driver: the command has none of its own.
  const harnessTool = () => (toolCache ??= (opts.tool ?? plan.host.resolveToolBin(plan.driver.options.tool)));

  // Base warnings come before any fork: on an empty diff the base is suspicious first.
  for (const w of plan.warnings) warn(w);

  if (!plan.diff.trim() && plan.untracked.length === 0) {
    ok(`no changes — nothing to review (${plan.baseLine})`);
    warnUnread(plan);
    return plan;
  }

  if (opts.dryRun) {
    info(`repository: ${plan.nsPath} → ${plan.repoDir} · ${plan.baseLine}`);
    info(`task: ${plan.taskId}${plan.createNew ? ` (will be created: ${plan.createNew.title})` : ''}${titleNote(plan)}`);
    // Name from the journal, not rebuilt: on a former-CLI task they will not match.
    const sessionShown = plan.reuse ? plan.participant.metadata.name ?? plan.name : plan.name;
    info(`reviewer address: ${plan.address}${ownerNote(plan)} · session: "${sessionShown}"${modelNote(plan)}${effortNote(plan)}${participantNote(plan)}`);
    if (plan.decision) sayDecision(plan.decision);
    info(`procedure: ${plan.skill ? `skill ${plan.skill.name} (module ${plan.skill.module})` : 'built-in (the module did not declare a review skill)'}`);
    // The reviewer has a home of its own only where the driver chose one: a
    // harness without settings for a single lift reads them from the working
    // directory, and seating it in the reviewed clone would write configs into a
    // foreign tree.
    if (plan.launch.cwd && plan.launch.cwd !== plan.repoDir) {
      info(`reviewer home: ${plan.launch.cwd} — the reviewed directory is attached read-only`);
    }
    info(`reviewer rules:`);
    for (const f of plan.rules) console.log(`  ${f}`);
    sayModule(plan);
    // The server list, not the whole config: it holds substituted tokens.
    info(`reviewer MCP (${plan.mcpConfig.mcpServers ? Object.keys(plan.mcpConfig.mcpServers).length : 0}):`);
    for (const line of mcpServerLines(plan.mcpConfig)) console.log(`  ${line}`);
    sayMcp(plan, { hint: false });
    // We do not ask the binary version in `--dry-run`: nothing is started, and
    // the probe is a process.
    info(dryRunToolNote(plan.driver));
    info(`workspace skills: ${skillsNote(plan)}`);
    info(guardHookNote(plan));
    info(sessionEnvNote(plan.driver, plan.host));
    // The same line and for the same reason as spawn: the session name the
    // binary itself invents `--dry-run` has nothing to print, and it says so
    // out loud.
    if (plan.driver.phrases.naming) info(`harness session name: ${plan.driver.phrases.naming}`);
    info('prompt:');
    console.log(plan.reuse ? plan.reReview : plan.prompt);
    warnSecondTask(plan);
    ok('dry-run: nothing written to disk, reviewer not started');
    return plan;
  }

  // We check with the binary BEFORE the first write to disk: otherwise a version
  // refusal would leave behind an opened task, a diff file and a `pending`
  // record. Re-review does not need the binary.
  if (!plan.reuse) {
    // Read-only is asked FIRST and before any write: a harness that cannot strip
    // tools would start a session with write access to the reviewed tree.
    const noDeny = denyToolsRefusal(plan.driver);
    if (noDeny) fail(noDeny);
    const t = harnessTool();
    sayTool(t, { reason: false });
    if (!t.ok) fail(t.reason);
    // Version gate is shared with the worker: if the refusals diverged, the
    // reviewer would silently sit on default effort.
    const ultra = optionRefusal(plan.driver, plan.effort, t);
    if (ultra) fail(ultra);
  }

  // What the diff was computed from and who we review for — out loud on the real run too.
  if (plan.titleIgnored) info(titleNote(plan).replace(/^ · /, ''));
  info(`reviewer address: ${plan.address}${ownerNote(plan)} · ${plan.baseLine}`);
  sayModule(plan);
  // The MCP set is announced only where it actually goes: on re-review a live
  // reviewer works with the OLD config, and the line would describe a set that
  // is not there.
  if (!plan.reuse) sayMcp(plan);
  if (plan.createNew) {
    createTask(plan.home, plan.createNew);
    ok(`task ${plan.taskId}: ${plan.createNew.title}`);
    warnSecondTask(plan);
  }
  // The "session → task" bind is only on PICKUP and only for the owner. A review
  // task opened here does not get a bind: tools without an argument would go
  // read its mailbox, while worker messages of the main task piled up unseen.
  if (!plan.createNew) bindIfOwner(plan.home, plan.taskId);
  retargetDiff(plan, writeDiff(path.dirname(plan.diffPath), plan.slug, plan.diff));

  // The reviewer is alive — we send it a new diff: re-review in the same context checks findings.
  if (plan.reuse) {
    if (plan.sessionState === 'unknown') {
      warn(`liveness of the reviewer session ${plan.address} cannot be confirmed (${plan.driver.phrases.unreadable}) — the diff goes to the former address; if there is no report — check the session: ${plan.driver.phrases.sessions}`);
    }
    sendMessage(plan.home, plan.taskId, { from: ORCHESTRATOR, to: plan.address, type: 'task', body: plan.reReview });
    ok(`reviewer ${plan.address} is already on the bus — new diff sent ${plan.diffPath}`);
    // A new assignment puts the participant back under watch: this write branch
    // does not rewrite the record (a live reviewer only gets a message), and a
    // dismissed one would sit silently.
    if (watchParticipant(plan.home, plan.taskId, plan.address).was) {
      info('participant was dismissed from watch — the new assignment put them back: a stop of this session will be reported again');
    }
    info(waitHint('the reply', plan.taskId));
    warnUnread(plan);
    return plan;
  }

  // The participant session is dead: the message would sit in the mailbox
  // forever. We start a new reviewer with the full prompt — context of prior
  // findings left with the session.
  if (plan.unlaunched) {
    // Not a single word about a dead session is true here: this reviewer was never started.
    warn(`record of the reviewer ${plan.address} is left from a failed start (pending), liveness cannot be confirmed — nobody to send a re-review to`);
    warn(`starting the reviewer again with the full prompt: it has no prior context, it looks at the diff from a clean slate`);
  } else if (plan.participant) {
    warn(`session of the reviewer ${plan.address} is dead (it is not among the live ones in ${plan.driver.phrases.sessions}) — nobody to send a re-review to`);
    warn(`starting a new reviewer with the full prompt: prior findings left with the session, it looks at the diff from a clean slate`);
  }

  // Config rights 0600 are the same as for the worker: the substituted tokens are the same.
  writeLaunchFiles(plan.launch.files);

  // The participant is written to the journal BEFORE `claude` is started — the
  // same order as for the worker: otherwise the next call would open another
  // orphan task, and the reviewer has no worktree by which it would be picked
  // up.
  // The record is laid by the registry — the same order as for the worker: a
  // refusal to an unknown harness arrives before the participant appears in the
  // journal. `pending` is cleared by a second upsert: `applyParticipant`
  // replaces the record whole, so the one that appends the session id puts back
  // the same record the registry returned.
  const { record } = openParticipant(plan.home, plan.taskId, participantRecord(plan.address, {
    // Harness of the record — the one that starts it, the same rule as for the worker.
    harness: plan.driver.id,
    repo: plan.nsPath,
    repoAbs: plan.repoDir,
    model: plan.model,
    ...(plan.effort ? { effort: plan.effort } : {}),
    // The routing decision rides in `metadata`, as it does for the worker: the
    // field is opaque to the core, and `promptobus status` reads it back through
    // the accessor rather than by reaching into the map.
    ...(plan.routing ? { [ROUTING_FIELD]: plan.routing } : {}),
    name: plan.name,
    sessionRef: plan.name,
    started: new Date().toISOString(),
    pending: true,
    mechanismVersion: plan.host.version,
  }), REGISTRY);

  const tool = harnessTool();

  // Start and the "session lifted" check — a helper shared with the worker inside the driver.
  const { output, session, seen } = await plan.driver.spawn(plan.launch, {
    tool,
    // Address, task and bus home go to the driver TOGETHER with the plan: a
    // harness whose wake channel the mechanism itself drives has to hand contact
    // points to its own machinery, and there is nothing else to address them
    // with.
    home: plan.home,
    // The workspace interface travels with them: a lift refused because the
    // account's limit was spent between the preflight and this launch is marked
    // in the availability cache, and the cache file is named by the host.
    host: plan.host,
    task: plan.taskId,
    address: plan.address,
    cwd: plan.repoDir,
    env: plan.env,
    ref: plan.name,
    role: 'reviewer',
    launchFailNote: launchFailureNote(plan),
    // Re-lift route of the reviewer is its own: `promptobus review` starts it, it has no worktree.
    deadNote: deadSessionNote(plan),
    // The `pending` mark is cleared only by a successful lift: otherwise a
    // repeat would take the record for a live reviewer and go send a re-review
    // into an empty mailbox.
    persist: (id, state, sessionId) => {
      // We clear the mark EXPLICITLY: it left in the record with the first
      // upsert, and `applyParticipant` replaces the participant whole — if it
      // stayed, it would pass a started reviewer off as one that never started,
      // and a repeat would go send a re-review into an empty mailbox.
      const { pending, ...rest } = record.metadata;
      return upsertParticipant(plan.home, plan.taskId, {
        ...record,
        metadata: {
          ...rest,
          session: id,
          ...(sessionId ? { sessionId } : {}),
          ...(state === 'dead' ? { pending: true } : {}),
        },
      });
    },
    awaitOptions: opts.awaitOptions,
  });
  ok(`reviewer ${plan.address} started in ${plan.nsPath}${session ? ` (session ${session})` : ''}`);
  // The warden is started right after the participant: without it the reviewer
  // would not learn about a message — it fetches the mailbox only on its own
  // turn.
  ensureWarden(plan.home, plan.taskId, { host: plan.host });
  plan.driver.saidLiftoff({ name: plan.name, seen, session, output });
  info(waitHint('the report', plan.taskId));
  // Print the re-review command in full so the task id does not have to be fished from the output.
  info(`new diff to this same reviewer: ${plan.host.busCommand(['review', `"${plan.repoDir}"`, `--task ${plan.taskId}`])}`);
  warnUnread(plan);
  return plan;
}

// What survived a failure — one line for both refusals. A task opened by this
// call has no worktree-participant: a repeat without `--task` will not pick it
// up, so the refusal names the orphan and the exact cleanup.
function keptNote(plan) {
  return ` Task ${plan.taskId} and the participant record ${plan.address} are in place; the diff is saved in ${plan.diffPath}.`;
}

// Start succeeded and there is no session: start the reviewer again with the
// same command — it will pick the task up by `--task`. Cleanup is named as an
// alternative, for the case "the review was dropped".
function deadSessionNote(plan) {
  return `${keptNote(plan)} Start the reviewer again: ${plan.host.busCommand(['review', `"${plan.repoDir}"`, `--task ${plan.taskId}`])}.`
    + ' There will be no messages from this address — waiting for them is pointless.'
    + (plan.createNew ? ` If you dropped the review — close the task: ${plan.host.busCommand(['done', `--task ${plan.taskId}`])}` : '');
}

function launchFailureNote(plan) {
  const kept = keptNote(plan);
  return plan.createNew
    ? `${kept} This is an active orphan task: the reviewer was not started, and the next call without --task will not pick it up. `
      + `Close it: ${plan.host.busCommand(['done', `--task ${plan.taskId}`])}`
    : `${kept} The reviewer was not started; the task stays active.`;
}

// A review task of our own next to a foreign active one means several active,
// and resolve of "the single active one" refuses — better to learn that here
// than on the next call.
function warnSecondTask({ createNew, otherActive, taskId, host }) {
  if (!createNew || !otherActive.length) return;
  const many = otherActive.length > 1;
  warn(`${many ? 'other tasks are also active' : 'another task is also active'} ${otherActive.join(', ')} — there will be several active: `
    + 'commands will need --task, bus tools will need the task argument');
  info(`when you finish the review — close its task: ${host.busCommand(['done', `--task ${taskId}`])}`);
}

// Model and effort in dry-run: on re-review argv is not executed, and printing
// the flag as applied is a lie. "The session is already alive" is not asserted
// when liveness is unconfirmed.
function notApplied({ reuse, sessionState }) {
  if (!reuse) return '';
  return sessionState === 'unknown'
    ? ' (not applied — the diff will go to the former address)'
    : ' (not applied — the session is already alive)';
}

// A name given together with --task: the task already exists, and the title is taken from its journal.
function titleNote({ titleIgnored, taskId }) {
  return titleIgnored ? ` · --title is not applied — the name is taken from the journal of task ${taskId}` : '';
}

function modelNote(plan) {
  return ` · model: ${plan.model}${notApplied(plan)}`;
}

function effortNote(plan) {
  return plan.effort ? ` · effort: ${plan.effort}${notApplied(plan)}` : '';
}

// Whose worktree we review — a note on the address: otherwise "why the reviewer
// is not named like the repository" is found by reading the code.
function ownerNote({ owner }) {
  return owner ? ` (by the worker ${addressOf(owner)})` : '';
}

// Task participant whose worktree is this directory. We compare canonical
// paths: the target was run through realpathSync, and the journal stores the
// spawn path (on macOS /var versus /private/var). A participant without
// `worktree` does not own the directory.
function worktreeOwner(taskMeta, repoDir) {
  return (taskMeta.participants ?? [])
    .find((p) => p.metadata.worktree && canonical(p.metadata.worktree) === repoDir) ?? null;
}

// Active tasks in whose journal the target is listed as a participant worktree
// directory. Belonging is asked of the journal, not of the directory name or
// the branch: names are built from a template and match by chance. We do not
// check `repo` — the field is also on the reviewer record, and the target would
// be listed in every task where the repository was ever reviewed.
function claimingTasks(home, repoDir) {
  return activeTasks(home).filter((t) => worktreeOwner(t, repoDir));
}

// The directory may already be gone (task closed, worktree removed) — the path from the journal is absolute.
function canonical(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

// Local default branch of the repository: merge-base with it gives the point
// where the worker work actually starts. The name is given by
// host.defaultBranch — the same detect spawn uses to choose the base of a new
// worktree. What must exist is the LOCAL branch: the orchestrator's unpushed
// work is not in the remote.
function localDefault(repoDir, host) {
  const exists = (br) => spawnSync('git', ['-C', repoDir, 'rev-parse', '--verify', '-q', `refs/heads/${br}`],
    { encoding: 'utf8' }).status === 0;
  const named = host.defaultBranch(repoDir);
  // There is a name, and no local branch under it — no base from here, and the
  // ladder does not help: the worker branched from `origin/<name>`, not from a
  // random local branch.
  if (named) return exists(named) ? named : null;
  // There are no origin refs in the clone at all: spawn then takes `HEAD` as
  // the base. The local ladder is the same order as in fresh.js: if the order
  // diverged, the answers would diverge too.
  return ['master', 'main'].find(exists) ?? null;
}

// Questions to git about the diff base call `spawnSync` directly, not through
// `git()`/`gitRaw()`: those take the whole plan with a refusal, and here a
// refusal is a legal answer.
function mergeBase(repoDir, ref) {
  const r = spawnSync('git', ['-C', repoDir, 'merge-base', ref, 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function isAncestor(repoDir, sha, ref) {
  const r = spawnSync('git', ['-C', repoDir, 'merge-base', '--is-ancestor', sha, ref], { encoding: 'utf8' });
  return r.status === 0;
}

function headOf(repoDir) {
  const r = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

// Whether the recorded branch point lies in HEAD history. We return the sha or
// `null` — "this point cannot be trusted"; there is no need to distinguish
// reasons, the rollback from them is one.
function ancestorOfHead(repoDir, sha) {
  if (!sha) return null;
  return isAncestor(repoDir, sha, 'HEAD') ? sha : null;
}

// Slug from a participant address — inverse of workerAddress/reviewerAddress (store.js).
function addressSlug(address) {
  const addr = String(address ?? '');
  return addr.slice(addr.indexOf(':') + 1);
}

// What --dry-run will say about an already opened reviewer — by the same
// three-valued session state the real start uses to choose between re-review
// and a new spawn.
function participantNote({ participant, sessionState, unlaunched }) {
  if (!participant) return '';
  // A record before start is not "already on the bus": the real run in this
  // state will start a new reviewer, and print must say the same.
  if (unlaunched) return ' · record was made before start, the reviewer was not started — a new one will start';
  if (sessionState === 'dead') return ' · was on the bus, but its session is dead — a new reviewer will start';
  if (sessionState === 'unknown') return ' · already on the bus, session liveness is not confirmed — a new diff will go';
  return ' · already on the bus — a new diff will go';
}

// Refusal of `promptobus review` without a path. The repository of the current
// directory lands here only as hint text: the command does not execute it, it
// names it.
function missingTarget(host, { task, title, base, model, effort, harness, dryRun }) {
  const head = `repository path is required: ${host.busCommand(['review', '<path>'])} [--task <id> | --title <name>].`
    + '\n    There is no resolve from the current directory for this command: a workspace has dozens of clones side by side,'
    + ' and the current directory is almost never the one being talked about.';
  const ask = `\n    ${host.reviewLayoutError('ask-path')}`;
  const here = cwdRepo(host);
  // We name the repository, not the directory: `cwdRepo` returns git-toplevel,
  // and from `repos/<group>/<repo>/src` a person would read about a directory
  // they are not standing in.
  if (!here) return `${head}\n    The current directory is not in a git repository.${ask}`;
  // A ready command — only where the next gate will accept it: a hint that
  // planReview will reject right away costs the person two repeats instead of
  // one.
  if (!here.nsPath) {
    return `${head}\n    The repository of the current directory is ${here.dir}, but it ${host.reviewLayoutError('cwd-outside')}.${ask}`;
  }
  const arg = (v) => (/[\s"]/.test(v) ? JSON.stringify(v) : v);
  const flags = [
    ...(task ? ['--task', arg(task)] : []),
    ...(String(title ?? '').trim() ? ['--title', arg(String(title).trim())] : []),
    ...(base ? ['--base', arg(base)] : []),
    ...(model ? ['--model', arg(model)] : []),
    ...(effort ? ['--effort', effort] : []),
    // The lift tool rides in the hint on a par with the other flags: a repeat
    // without it would start the reviewer with the wrong harness from the one
    // that was talked about.
    ...(harness ? ['--harness', arg(harness)] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ];
  return `${head}\n    The repository of the current directory is ${here.nsPath} (${here.dir}).`
    + '\n    That is the review subject — repeat with it:'
    + `\n      ${host.busCommand(['review', `"${here.dir}"`])}${flags.length ? ` ${flags.join(' ')}` : ''}`
    + '\n    If the subject is different — name its path yourself.';
}

// The clone the current process directory resolves into — only for the refusal above.
function cwdRepo(host) {
  const r = spawnSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  let dir;
  try { dir = realpathSync(path.resolve(r.stdout.trim())); } catch { return null; }
  return { dir, nsPath: host.cloneOf(dir)?.nsPath ?? null };
}

// Refusal is a `refusal` field, the same outcome as `git()`. The target and its
// git-toplevel are both returned: by their mismatch planReview chooses how to
// refuse.
function resolveRepoDir(target) {
  const start = path.resolve(target);
  const r = spawnSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) return { refusal: `${start}: not a git repository` };
  // On Windows git prints the path with forward slashes — path.resolve returns the native form.
  return { targetDir: realpathSync(start), repoDir: realpathSync(path.resolve(r.stdout.trim())) };
}

function detectBase(repoDir) {
  const head = spawnSync('git', ['-C', repoDir, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
  if (head.status === 0) return head.stdout.trim().replace('refs/remotes/', '');
  const cur = spawnSync('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    // A local branch cannot be a base for itself. Exact comparison: on local
    // main the origin/main candidate must NOT be skipped — unpushed commits are
    // a legal review subject.
    if (cur === ref) continue;
    const r = spawnSync('git', ['-C', repoDir, 'rev-parse', '--verify', '-q', ref], { encoding: 'utf8' });
    if (r.status === 0) return ref;
  }
  return null;
}

// Diff file stem — one home for it: the name is both PREDICTED (`diffName`) and written
// (`writeDiff`), and a stem spelled twice is a stem that drifts.
function diffStem(slug) {
  return `review-${slug}`;
}

// Diff file name by slug and number. The numbering itself is the task files folder's
// (`numberedName`): the same one an artifact that arrived through the bus gets.
function diffFile(slug, n) {
  return numberedName(diffStem(slug), '.diff', n);
}

// The diff sits in task artifacts: both the reviewer and a person reading the
// journal see it there. An occupied name gets a number: the previous one must
// not be overwritten while the reviewer may still be reading it. Here the name
// is only PREDICTED — the write itself occupies it (`writeDiff`).
function diffName(home, taskId, slug) {
  const dir = filesDir(home, taskId);
  let n = 1;
  while (existsSync(path.join(dir, diffFile(slug, n)))) n += 1;
  return diffFile(slug, n);
}

// Diff write that occupies the name by the write itself: between `existsSync`
// and the write a second review of the same slug would slip in. The store holds
// that write (`occupyTaskFile`) — the task files folder is its folder, and the
// `spawn` brief lands there the same way. Returns the path that LANDED on disk.
// Exported for the test: a race cannot be reproduced from inside one command.
export function writeDiff(dir, slug, content) {
  return occupyTaskFile(dir, diffStem(slug), '.diff', content);
}

// The diff path sits in three places of the plan — the field, the prompt and
// the re-review message — and after the write the plan rebuilds them from the
// path that landed on disk. Called UNCONDITIONALLY: the "name moved forward"
// branch happens only in a race, and there is nothing to close it with a test.
function retargetDiff(plan, diffPath) {
  const { taskId, nsPath, repoDir, address, stat, untracked, baseLine, rules, skill, driver, host } = plan;
  // The prompt leaves as the last positional argument — we find it in argv by
  // value, not by position: flag order is edited more often than this code.
  const at = plan.argv.lastIndexOf(plan.prompt);
  plan.diffPath = diffPath;
  plan.prompt = buildPrompt({ taskId, nsPath, repoDir, address, diffPath, stat, untracked, baseLine, rules, skill, driver, host });
  plan.reReview = buildReReview({ diffPath, stat, untracked, baseLine });
  if (at >= 0) plan.argv[at] = plan.prompt;
}

function subject({ diffPath, stat, untracked, baseLine }) {
  return `The diff is in the file ${diffPath} (read it in full); ${baseLine}. What lies outside this boundary is not a review subject.
Change summary:
${stat || '(new files only)'}
${untracked.length ? `\nNew untracked files (paths relative to the repository, read them):\n${untracked.map((f) => `- ${f}`).join('\n')}` : ''}`;
}

function procedure(skill) {
  if (skill) {
    return `Do not invent a review procedure: read ${path.join(skill.dir, 'SKILL.md')} and follow it in "report only" mode — do not fix findings and do not offer "I will fix it". Skill materials sit next to it${skill.shared ? `, shared standards are in ${skill.shared}` : ''}; resolve relative paths in the skill text from its directory. Skip steps that need a write, a command start, or an unavailable MCP server, and list what you skipped in the report.`;
  }
  return `Finding format: <file>:<line> [critical|major|minor] gist — suggested fix.
No findings — say so and in one line list what you checked. Do not retell the diff and do not praise the code.`;
}

function buildPrompt({ taskId, nsPath, repoDir, address, diffPath, stat, untracked, baseLine, rules, skill, driver, host }) {
  const bus = (name) => toolName(driver, PROMPTOBUS_SERVER, name);
  return `You are the code reviewer of task ${taskId}. The review subject is the changes of repository ${nsPath}; its working copy is ${repoDir}, read it freely: call sites of changed methods, neighboring code, tests. You are a Promptobus bus participant with address ${address}; the link to the orchestrator is the MCP server tools ${PROMPTOBUS_SERVER} (it is already attached to this session): ${bus('promptobus_send')}, ${bus('promptobus_mailbox')}, ${bus('promptobus_task')}.

## Review subject

${subject({ diffPath, stat, untracked, baseLine })}

## Isolation — hold it yourself

- The context of the session that wrote the code was not given to you, and that is a guard against self-approval: trust the code and the standards, not that "this is how it was meant".
- File edits and command starts are disabled for you by the mechanism. Edit nothing — produce findings, the author fixes them.
- Mechanical checks (build, analyzer, tests) are unavailable to you — do not invent their result, say in the report that they were not run.
- **MCP tools of external systems are read-only, and you hold that, not the mechanism.** You have the whole canonical workspace set, and every name is pre-approved: nobody will ask you for permission, and there is no person behind the session who would refuse. Read as much as you need — an event contract, a task card, a merge request diff, a metric, a fact from team memory. Do not create, change, delete or publish anything: not a comment on a merge request or a card, not a thread, not a dashboard, not an annotation, not a test case, not an artifact, not a fact in team memory. The report leaves by one channel — a message to the orchestrator; everything you would want to write somewhere, write into it.
- The subject is only changed and new code, not the legacy around it.

## Read the rules before review

${rules.map((f) => `- ${f}`).join('\n')}

## Procedure

${procedure(skill)}

## Team memory

${memoryRule(driver, host)}

## Communication protocol

You have nothing to wait with and no need to: the task mailboxes are listened to by the bus warden, and it wakes you with a postcard when you are written to. The postcard carries the text of short messages, but only mailbox marks them read — fetch it first, even if the postcard already makes everything clear.

1. Finished the review — send the report in full: ${bus('promptobus_send')} {to:"orchestrator", type:"result", body:"findings, or 'No findings' plus what was checked"}.
2. Stuck on a question without whose answer you cannot continue — ${bus('promptobus_send')} {to:"orchestrator", type:"question", body:"question"} and end the turn. The answer (type=answer) will arrive as a postcard. Do not guess.
3. Work stretches past a couple of minutes of silence — send status with its content and a time estimate ("three files left, ~5 minutes") BEFORE you end the turn: a silent session is indistinguishable from a hung one to the orchestrator. Name the time by volume and a measurement, not by feeling.
4. After result end the turn. A type=task message arrived with a path to a new diff — that is a re-review: first fetch the mailbox, then check against it whether your prior findings are closed, then look at what else changed. Answer with result again.
5. A person closes the session.${driver.phrases.promptRules}`;
}

// Re-review message: the reviewer already has the context (rules, skill, isolation).
function buildReReview({ diffPath, stat, untracked, baseLine }) {
  return `Re-review: the author sent a new version of the changes.

${subject({ diffPath, stat, untracked, baseLine })}

First check your prior findings against the new diff — which are closed, which are not, then look at what else changed. The report is promptobus_send {to:"orchestrator", type:"result", body:"..."} as before.`;
}

// `core.quotePath=false` — on EVERY git call of this file: otherwise git gives
// non-ASCII paths in octal escaping, and the reviewer gets names that are not
// on disk.
const GIT_OPTS = ['-c', 'core.quotePath=false'];

// Output ceiling is shared with the zone walk (`GIT_MAX_OUTPUT`, util.js): on
// the default megabyte `spawnSync` kills the process with a signal and no
// status, and the command would fall without a reason — the `error` branch
// names it (it is there exactly where there is no status). Outcome: `{ out }` —
// what was read, `{ refusal }` — the refusal text the command prints.
function git(repoDir, args) {
  const r = spawnSync('git', ['-C', repoDir, ...GIT_OPTS, ...args], { encoding: 'utf8', maxBuffer: GIT_MAX_OUTPUT });
  if (r.error) return { refusal: `git ${args.join(' ')}: ${r.error.message}` };
  if (r.status !== 0) return { refusal: `git ${args.join(' ')}: ${(r.stderr ?? '').trim() || `code ${r.status}`}` };
  return { out: r.stdout.trim() };
}

// The ceiling here is its own and higher: the subject of the call is the diff
// itself. Output is not trimmed — in a diff both the first and the last newline
// matter.
function gitRaw(repoDir, args) {
  const r = spawnSync('git', ['-C', repoDir, ...GIT_OPTS, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { refusal: `git ${args.join(' ')}: ${r.error.message}` };
  if (r.status !== 0) return { refusal: `git ${args.join(' ')}: ${(r.stderr ?? '').trim() || `code ${r.status}`}` };
  return { out: r.stdout };
}

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ok, info, warn, fail, gitIn, PROC_MAX_OUTPUT, GIT_NET_TIMEOUT_MS } from './util.js';
import { normalize } from './fuzzy.js';
import { hostOf } from './host.js';
import { guardHookCommand } from '../dist/hooks.js';
import {
  activeTasks, addressOf, attachmentsOf, bindIfOwner, claimRoute, createTask, filesDir,
  foreignTaskLine, GateError, newTaskIdentity, numberedName, occupyTaskFile, ownership,
  participantMcpPath, participantOf,
  participantRecord, participantSettingsPath, readTask, reviewerAddress, approverAddress, addrDir, sendMessage,
  sessionIdentity, slugify, stampReviewAssignment, stampSnapshot, taskExists, unreadNote, upsertParticipant,
  watchParticipant,
  ORCHESTRATOR,
} from './store.js';
import {
  dryRunToolNote, guardHookNote, liftHarness, memoryRule, mcpNote, mcpServerLines, normalizeLaunchTool,
  optionRefusal, participantMcp, participantPluginDir, PROMPTOBUS_SERVER, resolveEffort, resolvePermissionMode,
  sayMcp, sayModule, sayTool, sessionEnv, sessionEnvNote, sessionName, skillSettings, skillsNote,
  toolName, writeLaunchFiles,
} from './spawn.js';
import { participantSession } from './status.js';
import {
  ATTACHMENT_CONTRACT,
  GATE_RECORD_SCHEMA, GATE_RECORD_STEM, HANDOVER_CHECKS, HANDOVER_RECORD_SCHEMA, HANDOVER_RECORD_STEM,
  isGateRecordName, isHandoverRecordName, RESULT_BODY_MAX,
} from './handoff.js';
import { launchProvenance, provenanceLine } from './provenance.js';
// Same routing gate the worker lift stands on ([models.js](models.js)): the context is built here
// because the preflight is asynchronous, and the pick is taken where the participants are known.
import {
  decideLift, effectiveStrategy, routingContext, routingLine, sayDecision,
} from './models.js';
import { hasFeature, openParticipant, ROUTING_FIELD } from '../dist/index.js';
import { driverOf, REGISTRY } from './drivers.js';
import { ensureWarden } from './warden.js';
import { clearThroughputSidecar, tallies } from './model-routing/telemetry.js';

// Reviewer — a bus participant in the directory of the reviewed copy, one per task and repository.
// **Read-only is a capability, not a wish**: `denyTools` is asked BEFORE lift and before any write.

/** Refusal on the ability to strip tools; `null` means the driver declared it. A pure function:
 * there is no live driver without `denyTools`, so the branch is reachable only with a stand-in. */
export function denyToolsRefusal(driver) {
  if (hasFeature(driver, 'denyTools')) return null;
  return `harness "${driver.id}" cannot strip session tools, and isolation of the reviewer rests `
    + 'exactly on that: a reviewer it started would write the reviewed tree, not read it. '
    + 'Review is not started with this harness — take a harness that declares denyTools.';
}

// The host names MCP writes in canonical pairs; only a driver declaring a mechanical MCP deny adds
// them. The bus stays available, and `complete` tells an empty classification from an uninspected host.
function reviewerDenyTools(host, driver, declaredServers = []) {
  const builtIn = driver.options.denyTools ?? [];
  if (!hasFeature(driver, 'mcpDenyTools')) return { tools: builtIn, refusal: null };
  const canonicalServers = [...new Set((declaredServers ?? [])
    .map(String).filter((server) => server && server !== PROMPTOBUS_SERVER))];
  const hasMember = typeof host.participantDenyTools === 'function';
  const answer = hasMember ? host.participantDenyTools('reviewer') : null;
  const classified = Array.isArray(answer)
    ? answer
    : Array.isArray(answer?.tools) ? answer.tools : [];
  const valid = classified.filter((tool) => tool && typeof tool === 'object'
    && typeof tool.server === 'string' && typeof tool.tool === 'string'
    && tool.server && tool.tool && tool.server !== PROMPTOBUS_SERVER);
  const complete = !hasMember && canonicalServers.length === 0
    ? true
    : !Array.isArray(answer) && answer?.complete === true && Array.isArray(answer.tools);
  if (!complete) {
    const covered = new Set(valid.map(({ server }) => server));
    const unclassified = canonicalServers.filter((server) => !covered.has(server));
    const detail = unclassified.length
      ? `the participantDenyTools('reviewer') classification is incomplete for canonical external MCP server(s): ${unclassified.join(', ')}`
      : Array.isArray(answer)
        ? `the participantDenyTools('reviewer') member returned the pre-{ tools, complete } shape`
        : `the participantDenyTools('reviewer') member did not return complete: true`;
    return {
      tools: builtIn,
      refusal: `harness "${driver.id}" cannot mechanically deny MCP writes for host "${host.commandName}": `
        + `${detail}. `
        + 'Review is not started — the host must return { tools, complete: true } before this harness can review.',
    };
  }
  return {
    tools: valid.length ? [...builtIn, ...driver.mcpDenyTools(valid)] : builtIn,
    refusal: null,
  };
}

// Hint "how to wait for the report", naming the task by its id — what `--task` accepts. Otherwise
// `--task` would get the session name from the neighbouring line of output.
function waitHint(what, taskId) {
  return `${what} will arrive as a type=result message to the orchestrator of task ${taskId}: `
    + 'the bus warden will wake you, fetch the mailbox';
}

/** Which reviewer this subject belongs to. The slug comes from the SUBJECT, not the clone root: with
 * two workers of one repository `basename` would send the second review to the first's reviewer. */
export function reviewerFor(taskMeta, repoDir, clone) {
  const owner = worktreeOwner(taskMeta, repoDir);
  const slug = (owner ? addressSlug(addressOf(owner)) : normalize(path.basename(clone.abs))) || 'repo';
  return { owner, slug, address: reviewerAddress(slug) };
}

/** Whether this subject already has a reviewer in the journal — asked before the routing context,
 * so a re-review does not pay a preflight to be told the flag was ignored. Read-only and silent. */
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

// Review plan: everything computed, nothing written. Gates of the REQUEST throw; a refusal from what
// was READ leaves as a `{ refusal }` field, because `fail()` here would take a unit test past the summary.
export function planReview(rootOrHost, { target, base, task, title, model, effort: effortOpt, permissionMode: permissionOpt, harness, strategy = undefined, routing = null, dryRun } = {}) {
  const host = hostOf(rootOrHost);
  // LIFT driver — the one the person asks to start with. Its option dictionary is not asked yet: an
  // opened reviewer has its own harness, and a foreign dictionary would let a stray value through.
  const lifter = liftHarness(host, harness);
  // Both sides of the comparison are in canonical native form: git prints `C:/…` on Windows and
  // realpath strips `/var` ↔ `/private/var` on macOS, or the prefix check falsely refuses.
  const root = realpathSync(host.workspaceRoot());
  // The repository path is required — there is no resolve from `cwd`. The gate stands first: before
  // the diff, `createTask` and the lift.
  if (!String(target ?? '').trim()) {
    // The hint repeats the call FLAGS, not the parsed values: `--effort` is parsed below, after the
    // participant driver, and this gate is the very first.
    throw new GateError(missingTarget(host, { task, title, base, model, effort: effortOpt, harness, dryRun }));
  }
  const resolved = resolveRepoDir(target);
  if (resolved.refusal) return { refusal: resolved.refusal };
  const { targetDir, repoDir } = resolved;
  if (!host.inWorkspace(repoDir)) {
    // The target is inside the zone and its git-toplevel is above: a group folder with nested
    // clones, not a clone — an "outside" refusal here would confuse.
    if (host.inWorkspace(targetDir)) {
      throw new GateError(host.reviewLayoutError('not-clone', { targetDir, repoDir }));
    }
    throw new GateError(host.reviewLayoutError('outside', { repoDir }));
  }
  // Which clone that is and how it is named — the host's answer: zones and
  // namespace depth are its layout, not the package's.
  const clone = host.cloneOf(repoDir);
  if (!clone) throw new GateError(host.reviewLayoutError('no-clone', { repoDir }));
  const nsPath = clone.nsPath;

  const home = host.promptobusHome();
  if (task && !taskExists(home, task)) throw new GateError(`there is no task ${task}`);
  // A closed task is a legal entry for nobody, and an explicit `--task` is not a bypass. Without the
  // flag, pickup looks at active tasks and will not choose a closed one.
  if (task && readTask(home, task).status === 'done') {
    throw new GateError(`task ${task} is closed — nobody for the reviewer to report to: `
      + `\`${host.busCommand(['status'])}\` lists the active ones, and \`${host.busCommand(['done'])}\` cleanup sweeps worktree directories of all closed tasks, `
      + 'so the next close would pull the worktree out from under a live session. '
      + 'A new run — review without --task and with --title: without a name the command will not open a task. '
      + 'If the directory is listed as a worktree of an active task — without --task it will pick that one up, not open a new one. '
      + 'Review into another live one — name it with --task, just not this id. '
      + `There is nothing to continue work in a closed task with: ${host.busCommand(['done'])} has no undo.`);
  }
  // Without `--task` the subject names the task: a directory listed as a participant worktree of an
  // active task takes that one, and the branch point with it; otherwise a task of its own opens.
  const claiming = task ? [] : claimingTasks(home, repoDir);
  if (claiming.length > 1) {
    throw new GateError(`directory is listed in several active tasks at once (${claiming.map((t) => t.id).join(', ')})`
      + ' — the command will not choose for the person: name the one you want, --task <id>');
  }
  const existing = task ?? claiming[0]?.id ?? null;
  // The owner gate sits ON TOP of directory pickup: a directory listed in a task bound to ANOTHER
  // session would otherwise have its reviewer report to a foreign orchestrator.
  if (!task && existing) {
    const own = ownership(home, existing, ORCHESTRATOR, sessionIdentity());
    if (own.gated) {
      throw new GateError(`directory ${repoDir} is listed as a worktree of a participant of a foreign run: `
        + `${foreignTaskLine(readTask(home, existing), own)}. A reviewer started from here will report `
        + 'to its orchestrator, and copies marked FOREIGN_MARK will arrive here. '
        + `Review by agreement with the owner — name the task explicitly: --task ${existing}. `
        + `${claimRoute(host.busCommand(['review']))}`);
    }
  }
  // We warn about the other active ones only where we open our own.
  const otherActive = existing ? [] : activeTasks(home).map((t) => t.id);
  // The command does not invent a task name: opening a new one means naming it, and the session is
  // called by that name. Checked below, once there is something to review.
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

  // Whose subject this is: a directory listed as a participant worktree is reviewed FOR them — the
  // address and the diff base come from them, and the main clone has no owner.
  const titleIgnored = !!(existing && String(title ?? '').trim());
  const { owner, slug, address } = reviewerFor(taskMeta, repoDir, clone);
  // Mechanism fields sit in the v1 record `metadata`: address, branch point and
  // slice title.
  const ownerFields = owner?.metadata ?? {};
  const ownerAddress = owner ? addressOf(owner) : null;

  // Diff base: `--base` is strongest, then the branch point spawn wrote, then a guess from the LOCAL
  // default branch. The recorded point is checked against HEAD history, since a branch may be rebased.
  const isWorktree = repoDir !== clone.abs;
  const recorded = base ? null : ancestorOfHead(repoDir, ownerFields.baseSha);
  // The main clone is still computed from the default branch: merge-base with itself would give HEAD
  // and an empty diff, and reviewing unpushed work is a legal move.
  const defBranch = base || !isWorktree ? null : localDefault(repoDir, host);
  const computed = defBranch ? mergeBase(repoDir, defBranch) : null;
  // The computed base is worse than the recorded one in two cases: a rewritten default branch, and a
  // worker branch already merged — merge-base then equals HEAD and the diff is empty.
  const head = headOf(repoDir);
  // Matching HEAD is not enough: on a fresh worktree HEAD equals the default tip and the recorded
  // point equals both, where "already merged" would be a lie.
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
  // Mechanical gate: the condition looks at the SOURCE of the base, not at which fields the record
  // has — a record with a worktree but no baseSha would fall through both conditions.
  const warnings = [];
  // An empty diff on a merged branch and on an untouched one look the same — after the merge the
  // default branch points at the same tip. The command names the fact, not a guess.
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
  // Git reads are checked separately, since each depends on the last. Patch, stat and raw records
  // come from one diff queue, and the comparison after it never reads the moving tree again.
  const from = baseRef ? git(repoDir, ['merge-base', baseRef, 'HEAD']) : { out: 'HEAD' };
  if (from.refusal) return { refusal: from.refusal };
  const diffFrom = from.out;
  const diffOut = snapshotDiff(repoDir, diffFrom, head);
  if (diffOut.refusal) return { refusal: diffOut.refusal };
  const { diff, stat, modifiedTracked } = diffOut;
  const others = git(repoDir, ['ls-files', '--others', '--exclude-standard']);
  if (others.refusal) return { refusal: others.refusal };
  const untracked = others.out.split('\n').filter(Boolean);
  // The diff file is a ONE-TIME snapshot: the worker goes on committing while the reviewer reads.
  // What the reviewer needs is its age and whether the tracked tree matched HEAD, so all three travel.
  const snapshot = {
    at: new Date().toISOString(),
    head: head ?? null,
    clean: modifiedTracked.length === 0,
    modifiedTracked,
  };
  snapshot.line = `diff snapshot: ${snapshot.at}${snapshot.head ? `, worktree HEAD ${snapshot.head}` : ''}, `
    + (snapshot.clean ? 'tracked tree clean' : `tracked tree dirty (modified tracked paths: ${snapshot.modifiedTracked.join(', ')})`);

  const participant = participantOf(taskMeta, address);
  const was = participant?.metadata ?? {};
  // The participant name from the journal is not rewritten: the session was started under it, and
  // re-review finds it by that line. The title is taken from the worktree owner.
  const name = was.name ?? sessionName(taskMeta, {
    slug,
    reviewer: true,
    title: ownerFields.title,
    taken: (taskMeta.participants ?? []).map((p) => p.metadata.name).filter(Boolean),
  });
  // Re-review goes to the participant only if its bg-session is alive: after a stop the message
  // would sit in the mailbox forever. Unknown — the diff goes to the former address.
  const sessionState = participant ? participantSession(participant) : null;
  // A record BEFORE start makes "the reviewer is in the journal" true even for one that never
  // lifted. `pending` is what is read, not `participant.session`: a live one may have no field either.
  const unlaunched = !!was.pending && sessionState !== 'alive';
  const reuse = !!participant && sessionState !== 'dead' && !unlaunched;
  // --effort applies to session lift, not to re-review: recreating loses finding context.

  // A module may declare a review procedure — a skill from its composition. An absolute path is
  // enough: skill materials resolve by ordinary read, and no plugin load is needed.
  const moduleHit = host.resolveRepoModule(repoDir);
  const declaredSkill = moduleHit?.meta?.review?.skill;
  let skill = null;
  if (declaredSkill) {
    const dir = host.reviewSkillDir(declaredSkill);
    if (!existsSync(path.join(dir, 'SKILL.md'))) {
      throw new GateError(`module ${moduleHit.name} declared review skill "${declaredSkill}", but ${dir} is not laid out — ${host.syncHint()}`);
    }
    const shared = path.join(host.workspaceRoot(), host.pluginSkillsRel(), '_shared');
    skill = { name: declaredSkill, module: moduleHit.name, dir, shared: existsSync(shared) ? shared : null };
  }

  // A name is required only when a task will actually be opened, and an empty SLUG is not an absent
  // name: a non-latin title slugs to nothing, and refusing there would loop.
  if (createNew && !identity.slug && (diff.trim() || untracked.length)) {
    if (!createNew.title) {
      throw new GateError(`review of ${nsPath} opens a new task, and it has no name: `
        + 'name it — --title "<whose work we are looking at>". '
        + `Reviewing work of the worker on an active task — name that instead: --task <id>`);
    }
    warnings.push(`name "${createNew.title}" does not translate into an id slug (only `
      + `latin letters and digits go in) — the task id stayed a machine stamp ${taskId}. `
      + `The name is kept in full in the task journal and in the reviewer session name`);
  }

  // Driver from the registry before any journal write, as with worker spawn, and routing in the same
  // place: a strategy with no candidate must leave no task, no diff file and no participant behind.
  const routed = participant ? null : decideLift(routing, { taskMeta, address });
  // The line is owed to `--strategy`, not to a context: a skip that only spoke once the preflight
  // had been paid for would be silent exactly where it matters.
  const routingSkipped = participant && strategy
    ? `${address} in task ${taskId} is already in the journal, started by harness ${participant.harness}: `
      + '--strategy routes a lift, and this call sends a new diff to a reviewer whose harness is already '
      + 'fixed. The flag is ignored here.'
    : null;
  const driver = participant ? driverOf(participant) : (routed ? liftHarness(host, routed.harness) : lifter);
  // Re-review with a foreign harness is a refusal, not a silent swap: the session is already started
  // in another tool and cannot change tool on the fly. The same gate stands on `planSpawn`.
  if (participant && harness && harness !== driver.id) {
    throw new GateError(`${address} in task ${taskId} was started by harness ${driver.id}, and --harness asks for `
      + `${harness}: a repeat call sends a NEW DIFF to the reviewer already started, and there is no way to change its tool `
      + `on the fly. Need a reviewer of another tool — open it its own task: --title <name>.`);
  }
  // Legal flag values — the dictionary of THIS participant's driver; a foreign one would let a level
  // through as a model-id suffix. A routed lift's effort goes through the same gate.
  const effort = resolveEffort(routed ? (routed.effort ?? undefined) : effortOpt, driver);
  // Without the flag the reviewer starts on the binary's mode — its rights are cut by tool stripping
  // in the settings file, and the flag is for one lift, like `--effort`.
  const permissionMode = resolvePermissionMode(permissionOpt, driver, null);

  const diffPath = path.join(filesDir(home, taskId), diffName(home, taskId, slug));
  const gateRecords = gateRecordPaths(home, taskId);
  const handoverRecords = recordPaths(home, taskId, HANDOVER_RECORD_STEM);
  const attachments = attachedFiles(home, taskId, owner);
  const rules = host.collectRules(repoDir);
  // Base rules and the diff sit outside the reviewer working directory, and a read outside it is
  // asked about: without `--add-dir` the reviewer stalls on its own first instruction. No write rights.
  const ruleDirs = [...new Set(rules.map((f) => path.dirname(f)))];
  const addDirs = [...new Set([...ruleDirs, path.dirname(diffPath)])];
  const prompt = buildPrompt({ taskId, nsPath, repoDir, address, diffPath, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress, rules, skill, driver, host });
  const reReview = buildReReview({ diffPath, repoDir, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress });

  const settingsPath = participantSettingsPath(home, taskId, address);
  const guardCommand = guardHookCommand(host, { address, taskId, home }, process.platform);
  // Not every harness takes a skills directory — the same rule as for the worker.
  const pluginDir = driver.options.skillsDir ? participantPluginDir(host) : null;
  // Canonical MCP list — the same path as for the worker: read-only is held by tool stripping.
  const mcpConfigPath = participantMcpPath(home, taskId, address);
  const mcp = participantMcp(host, { address, taskId, home }, driver);
  const declaredServers = Object.keys(mcp.descriptor.servers ?? {})
    .filter((server) => server !== PROMPTOBUS_SERVER);
  const deny = reviewerDenyTools(host, driver, declaredServers);
  const denyTools = deny.tools;

  // The lift plan is assembled by the driver, as with worker spawn: same settings plus stripped
  // tools, the same loop-guard command, default permission mode, and the driver's default model.
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
    denyTools,
    extraSettings: skillSettings(host),
    root,
  });

  return {
    home, taskId, createNew, otherActive, slug, address, name, nsPath, repoDir, baseRef, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress, owner, warnings,
    diff, untracked, stat,
    participant, sessionState, reuse, unlaunched, titleIgnored, skill, rules, ruleDirs, addDirs, diffPath, prompt, reReview,
    module: host.moduleNote(repoDir), pluginDir,
    settingsPath, guardCommand, mcpConfigPath, mcpNote: mcpNote(mcp, 'the reviewer'),
    launch, argv: launch.argv, mcpConfig: launch.mcpConfig, settings: launch.settings,
    model: resolvedModel, effort, permissionMode, driver,
    refusal: deny.refusal,
    routing: routed?.metadata ?? null, decision: routed?.decision ?? null, routingSkipped,
    // Environment is a plan field: `--dry-run` prints what the real start executes. No bus identity
    // in it — that reaches the reviewer as arguments of the Stop-hook command.
    env: sessionEnv(driver, process.env, host),
    host,
  };
}

// Mail piled up in the orchestrator's own mailbox is shown here too: a notification may not have
// arrived. A task opened by this same call gets no counter — its mailbox is empty by construction.
function warnUnread(plan) {
  if (plan.createNew) return;
  const note = unreadNote(plan.home, plan.taskId, ORCHESTRATOR, sessionIdentity());
  if (note) warn(note);
}

/** Where the reviewer actually sits, printed on a real lift as well as in `--dry-run`: the repository
 * under review is NOT the session's working directory. One function for both prints, so they cannot drift. */
function sayReviewerHome(plan) {
  if (!plan.launch.cwd || plan.launch.cwd === plan.repoDir) return;
  info(`reviewer home: ${plan.launch.cwd} — the reviewed directory is attached read-only`);
}

function warnDirtySnapshot(plan) {
  if (plan.snapshot.clean) return;
  warn(`the diff snapshot was taken from a dirty tracked tree (${plan.snapshot.modifiedTracked.join(', ')}): `
    + 'the snapshot can omit committed content or include uncommitted content');
}

export async function review(rootOrHost, opts) {
  if (opts.approver) {
    const { approverLift } = await import('./approver.js');
    return approverLift(rootOrHost, opts);
  }
  // The routing context is built before the plan and only for a routed call. The path gate is
  // repeated here first: a command that forgot its argument must not probe three harnesses to be told.
  const wanted = effectiveStrategy(hostOf(rootOrHost), { strategy: opts?.strategy });
  const routing = !wanted ? null : await (async () => {
    const host = hostOf(rootOrHost);
    if (!String(opts.target ?? '').trim()) {
      throw new GateError(missingTarget(host, {
        task: opts.task, title: opts.title, base: opts.base, model: opts.model,
        effort: opts.effort, harness: opts.harness, dryRun: opts.dryRun,
      }));
    }
    // A reviewer already in the journal fixes its own harness: nothing to route, nothing to pay a
    // preflight for. The plan still says the flag was ignored — it reads `--strategy`, not the context.
    if (reviewerInJournal(host, { target: opts.target, task: opts.task })) return null;
    return routingContext(host, {
      role: 'reviewer',
      strategy: wanted.strategy,
      strategySource: wanted.source === 'flag' ? null : wanted.source,
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
  if (plan.refusal && !plan.reuse) fail(plan.refusal);
  // A re-review keeps the running session and the denies it launched with; the
  // regressed host answer is said, not swallowed — a new lift would refuse.
  else if (plan.refusal) warn(`${plan.refusal} The running reviewer keeps the deny list it was launched with; this re-review proceeds.`);
  // The binary is resolved lazily: the command has three early returns without
  // lift. `opts.tool` is a seam.
  let toolCache = null;
  let liftProvenance = null;
  // The binary name is named by the driver: the command has none of its own.
  const harnessTool = () => (toolCache ??= normalizeLaunchTool(
    plan.driver, opts.tool ?? plan.host.resolveToolBin(plan.driver.options.tool), plan.env,
  ));

  // Base warnings come before any fork: on an empty diff the base is suspicious first.
  for (const w of plan.warnings) warn(w);

  if (!plan.diff.trim() && plan.untracked.length === 0) {
    ok(`no changes — nothing to review (${plan.baseLine} · ${plan.snapshot.line})`);
    warnDirtySnapshot(plan);
    warnUnread(plan);
    return plan;
  }

  if (opts.dryRun) {
    info(`repository: ${plan.nsPath} → ${plan.repoDir} · ${plan.baseLine} · ${plan.snapshot.line}`);
    warnDirtySnapshot(plan);
    info(`task: ${plan.taskId}${plan.createNew ? ` (will be created: ${plan.createNew.title})` : ''}${titleNote(plan)}`);
    // Name from the journal, not rebuilt: on a former-CLI task they will not match.
    const sessionShown = plan.reuse ? plan.participant.metadata.name ?? plan.name : plan.name;
    info(`reviewer address: ${plan.address}${ownerNote(plan)} · session: "${sessionShown}"${modelNote(plan)}${effortNote(plan)}${participantNote(plan)}`);
    if (plan.decision) sayDecision(plan.decision);
    info(`procedure: ${plan.skill ? `skill ${plan.skill.name} (module ${plan.skill.module})` : 'built-in (the module did not declare a review skill)'}`);
    sayReviewerHome(plan);
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
    // A driver whose session environment is REDIRECTED rather than merely stripped says where to:
    // the dropped-variable line on its own reads as "the harness default will be used".
    if (plan.launch?.envNote) info(plan.launch.envNote);
    // The same line and reason as spawn: the session name the binary invents is nothing `--dry-run`
    // can print, and it says so out loud.
    if (plan.driver.phrases.naming) info(`harness session name: ${plan.driver.phrases.naming}`);
    info('prompt:');
    console.log(plan.reuse ? plan.reReview : plan.prompt);
    warnSecondTask(plan);
    ok('dry-run: nothing written to disk, reviewer not started');
    return plan;
  }

  // Checked with the binary BEFORE the first write to disk: a version refusal would otherwise leave
  // an opened task, a diff file and a `pending` record. Re-review does not need the binary.
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
    const ultra = optionRefusal(plan.driver, plan.effort, t, plan.host);
    if (ultra) fail(ultra);
    liftProvenance = launchProvenance(plan.host, t);
    info(provenanceLine(liftProvenance));
  }

  // What the diff was computed from and who we review for — out loud on the real run too.
  if (plan.titleIgnored) info(titleNote(plan).replace(/^ · /, ''));
  info(`reviewer address: ${plan.address}${ownerNote(plan)} · ${plan.baseLine} · ${plan.snapshot.line}`);
  warnDirtySnapshot(plan);
  sayModule(plan);
  // The MCP set is announced only where it actually goes: on re-review a live reviewer works with
  // the OLD config, and the lines would describe a set that is not there.
  if (!plan.reuse) {
    sayMcp(plan);
    sayReviewerHome(plan);
    // Named on the real lift and not only in `--dry-run`: the canon travels as FILES, so whether it
    // arrived is a fact about this lift, and the operator has no other way to see it.
    info(`workspace skills: ${skillsNote(plan)}`);
    info(`reviewer rules:`);
    for (const f of plan.rules) console.log(`  ${f}`);
  }
  if (plan.createNew) {
    createTask(plan.home, plan.createNew);
    ok(`task ${plan.taskId}: ${plan.createNew.title}`);
    warnSecondTask(plan);
  }
  // The session→task bind is only on PICKUP and only for the owner: a review task opened here would
  // otherwise send argument-less tools to read its mailbox while the main task's mail piled up.
  if (!plan.createNew) bindIfOwner(plan.home, plan.taskId);
  retargetDiff(plan, writeDiff(path.dirname(plan.diffPath), plan.slug, plan.diff));

  // The reviewer is alive — we send it a new diff: re-review in the same context checks findings.
  if (plan.reuse) {
    if (plan.sessionState === 'unknown') {
      warn(`liveness of the reviewer session ${plan.address} cannot be confirmed (${plan.driver.phrases.unreadable}) — the diff goes to the former address; if there is no report — check the session: ${plan.driver.phrases.sessions}`);
    }
    stampReviewAssignment(plan.home, plan.taskId, plan.address, null);
    const sent = sendMessage(plan.home, plan.taskId, {
      from: ORCHESTRATOR, to: plan.address, type: 'task', body: plan.reReview,
    }, {
      status: plan.host.busCommand(['status']),
    });
    stampReviewAssignment(plan.home, plan.taskId, plan.address, sent.message.ts);
    // The record now holds THIS snapshot: a re-review does not rewrite the participant, and without
    // the patch `status` would show the first snapshot for the whole review.
    stampSnapshot(plan.home, plan.taskId, plan.address, plan.snapshot);
    ok(`reviewer ${plan.address} is already on the bus — new diff sent ${plan.diffPath}`);
    // A new assignment puts the participant back under watch: this branch does not rewrite the
    // record, and a dismissed one would sit silently.
    if (watchParticipant(plan.home, plan.taskId, plan.address).was) {
      info('participant was dismissed from watch — the new assignment put them back: a stop of this session will be reported again');
    }
    info(waitHint('the reply', plan.taskId));
    warnUnread(plan);
    return plan;
  }

  // The participant session is dead and the message would sit in the mailbox forever. A new reviewer
  // starts with the full prompt — the context of prior findings left with the session.
  if (plan.unlaunched) {
    // Not a single word about a dead session is true here: this reviewer was never started.
    warn(`record of the reviewer ${plan.address} is left from a failed start (pending), liveness cannot be confirmed — nobody to send a re-review to`);
    warn(`starting the reviewer again with the full prompt: it has no prior context, it looks at the diff from a clean slate`);
  } else if (plan.participant) {
    warn(`session of the reviewer ${plan.address} is dead (it is not among the live ones in ${plan.driver.phrases.sessions}) — nobody to send a re-review to`);
    warn(`starting a new reviewer with the full prompt: prior findings left with the session, it looks at the diff from a clean slate`);
  }

  // Config rights 0600 are the same as for the worker: the substituted tokens are the same.
  writeLaunchFiles(plan.launch.files, plan.driver.options.launchDirs);

  // The participant is written to the journal BEFORE the lift, the same order as for the worker, and
  // the record is laid by the registry: an unknown-harness refusal arrives before the journal entry.
  if (!plan.reuse) clearThroughputSidecar(plan.home, plan.taskId, plan.address);
  const assignedAt = new Date().toISOString();
  const { record } = openParticipant(plan.home, plan.taskId, participantRecord(plan.address, {
    // Harness of the record — the one that starts it, the same rule as for the worker.
    harness: plan.driver.id,
    repo: plan.nsPath,
    repoAbs: plan.repoDir,
    model: plan.model,
    ...(plan.effort ? { effort: plan.effort } : {}),
    // The routing decision rides in `metadata`, as for the worker: the field is opaque to the core,
    // and `status` reads it back through the accessor rather than into the map.
    ...(plan.routing ? { [ROUTING_FIELD]: plan.routing } : {}),
    name: plan.name,
    sessionRef: plan.name,
    session: null,
    started: assignedAt,
    reviewAssignedAt: assignedAt,
    // Which snapshot this reviewer holds — the same state `stampSnapshot` patches on
    // a re-review.
    diffAt: plan.snapshot.at,
    ...(plan.snapshot.head ? { diffHead: plan.snapshot.head } : {}),
    diffClean: plan.snapshot.clean,
    diffModifiedTracked: plan.snapshot.modifiedTracked,
    pending: true,
    mechanismPath: liftProvenance.mechanismPath,
    mechanismPathIssue: liftProvenance.mechanismPathIssue,
    mechanismVersion: plan.host.version,
    packagePath: liftProvenance.packagePath,
    packageVersion: liftProvenance.packageVersion,
    packageIssue: liftProvenance.packageIssue,
    hostVersion: liftProvenance.hostVersion,
    binaryPath: liftProvenance.binaryPath,
    binaryVersion: liftProvenance.binaryVersion,
  }), REGISTRY);

  const tool = harnessTool();

  // Start and the "session lifted" check — a helper shared with the worker inside the driver.
  const { output, session, seen } = await plan.driver.spawn(plan.launch, {
    tool,
    // Address, task and bus home go to the driver TOGETHER with the plan: a harness whose wake
    // channel the mechanism drives has to hand contact points to its own machinery.
    home: plan.home,
    // The workspace interface travels with them: a lift refused on a limit spent between the
    // preflight and this launch is marked in the availability cache, whose file the host names.
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
    // The `pending` mark is cleared only by a successful lift: otherwise a repeat would take the
    // record for a live reviewer and send a re-review into an empty mailbox.
    persist: (id, state, sessionId) => {
      // Cleared EXPLICITLY: it entered with the first upsert, and `applyParticipant` replaces the
      // participant whole, so a surviving mark would pass a started reviewer off as unstarted.
      const { pending, ...rest } = record.metadata;
      return upsertParticipant(plan.home, plan.taskId, {
        ...record,
        metadata: {
          ...rest,
          session: id ?? null,
          ...(sessionId ? { sessionId } : {}),
          ...(state === 'dead' ? { pending: true } : {}),
        },
      });
    },
    awaitOptions: opts.awaitOptions,
  });
  ok(`reviewer ${plan.address} started in ${plan.nsPath}${session ? ` (session ${session})` : ''}`);
  // The warden is started right after the participant: without it the reviewer would not learn about
  // a message — it fetches the mailbox only on its own turn.
  ensureWarden(plan.home, plan.taskId, { host: plan.host });
  plan.driver.saidLiftoff({ name: plan.name, seen, session, output });
  info(waitHint('the report', plan.taskId));
  // Print the re-review command in full so the task id does not have to be fished from the output.
  info(`new diff to this same reviewer: ${plan.host.busCommand(['review', `"${plan.repoDir}"`, `--task ${plan.taskId}`])}`);
  warnUnread(plan);
  return plan;
}

// What survived a failure — one line for both refusals. A task opened by this call has no worktree
// participant, so a repeat without `--task` will not pick it up: the refusal names the orphan.
function keptNote(plan) {
  return ` Task ${plan.taskId} and the participant record ${plan.address} are in place; the diff is saved in ${plan.diffPath}.`;
}

// Start succeeded and there is no session: run the same command again and it picks the task up by
// `--task`. Cleanup is named as the alternative, for a review that was dropped.
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

// A review task of our own beside a foreign active one means several active, and resolving "the
// single active one" refuses — better learnt here than on the next call.
function warnSecondTask({ createNew, otherActive, taskId, host }) {
  if (!createNew || !otherActive.length) return;
  const many = otherActive.length > 1;
  warn(`${many ? 'other tasks are also active' : 'another task is also active'} ${otherActive.join(', ')} — there will be several active: `
    + 'commands will need --task, bus tools will need the task argument');
  info(`when you finish the review — close its task: ${host.busCommand(['done', `--task ${taskId}`])}`);
}

// Model and effort in dry run: on re-review argv is not executed, and printing the flag as applied
// would be a lie. "The session is already alive" is not asserted when liveness is unconfirmed.
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

// Task participant whose worktree is this directory, compared by canonical paths — the target went
// through realpath and the journal stores the spawn path. A participant without `worktree` owns nothing.
export function worktreeOwner(taskMeta, repoDir) {
  return (taskMeta.participants ?? [])
    .find((p) => p.metadata.worktree && canonical(p.metadata.worktree) === repoDir) ?? null;
}

// Active tasks whose journal lists the target as a participant worktree or a reviewer's repository.
// Belonging is asked of the journal, not of a name; `repo` is not checked — `repoAbs` is exact.
function claimingTasks(home, repoDir) {
  return activeTasks(home).filter((t) => worktreeOwner(t, repoDir)
    || (t.participants ?? []).some((p) => p.role === 'reviewer'
      && p.metadata.repoAbs && canonical(p.metadata.repoAbs) === repoDir));
}

// The directory may already be gone (task closed, worktree removed) — the path from the journal is absolute.
function canonical(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

// Local default branch: merge-base with it gives where the worker work actually starts. The LOCAL
// branch is what must exist — the orchestrator's unpushed work is not in the remote.
function localDefault(repoDir, host) {
  const exists = (br) => gitIn(repoDir, ['rev-parse', '--verify', '-q', `refs/heads/${br}`]).status === 0;
  const named = host.defaultBranch(repoDir);
  // A name with no local branch under it gives no base from here, and the ladder does not help: the
  // worker branched from `origin/<name>`, not from a random local branch.
  if (named) return exists(named) ? named : null;
  // No origin refs in the clone at all: spawn then takes `HEAD` as the base. The local ladder keeps
  // the same order as the freshen path, or the answers would diverge.
  return ['master', 'main'].find(exists) ?? null;
}

// Questions to git about the diff base use the shared low-level helper, not the wrappers: those take
// the whole plan with a refusal, and here a refusal is a legal answer.
function mergeBase(repoDir, ref) {
  const r = gitIn(repoDir, ['merge-base', ref, 'HEAD']);
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? '').trim() || null;
}

function isAncestor(repoDir, sha, ref) {
  const r = gitIn(repoDir, ['merge-base', '--is-ancestor', sha, ref]);
  return !r.error && r.status === 0;
}

function headOf(repoDir) {
  const r = gitIn(repoDir, ['rev-parse', 'HEAD']);
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? '').trim() || null;
}

// Whether the recorded branch point lies in HEAD history: the sha, or `null` for "cannot be
// trusted". The reasons need not be told apart — the rollback from them is one.
function ancestorOfHead(repoDir, sha) {
  if (!sha) return null;
  return isAncestor(repoDir, sha, 'HEAD') ? sha : null;
}

// Slug from a participant address — inverse of workerAddress/reviewerAddress (store.js).
function addressSlug(address) {
  const addr = String(address ?? '');
  return addr.slice(addr.indexOf(':') + 1);
}

// What `--dry-run` says about an already opened reviewer, by the same three-valued session state the
// real start uses to choose between re-review and a new spawn.
function participantNote({ participant, sessionState, unlaunched }) {
  if (!participant) return '';
  // A record before start is not "already on the bus": the real run in this
  // state will start a new reviewer, and print must say the same.
  if (unlaunched) return ' · record was made before start, the reviewer was not started — a new one will start';
  if (sessionState === 'dead') return ' · was on the bus, but its session is dead — a new reviewer will start';
  if (sessionState === 'unknown') return ' · already on the bus, session liveness is not confirmed — a new diff will go';
  return ' · already on the bus — a new diff will go';
}

// Refusal of `promptobus review` without a path. The repository of the current directory lands here
// only as hint text: the command does not execute it, it names it.
function missingTarget(host, { task, title, base, model, effort, harness, dryRun }) {
  const head = `repository path is required: ${host.busCommand(['review', '<path>'])} [--task <id> | --title <name>].`
    + '\n    There is no resolve from the current directory for this command: a workspace has dozens of clones side by side,'
    + ' and the current directory is almost never the one being talked about.';
  const ask = `\n    ${host.reviewLayoutError('ask-path')}`;
  const here = cwdRepo(host);
  // The repository is named, not the directory: git-toplevel is what is returned, and a nested path
  // would have a person read about a directory they are not standing in.
  if (!here) return `${head}\n    The current directory is not in a git repository.${ask}`;
  // A ready command only where the next gate will accept it: a hint `planReview` rejects right away
  // costs the person two repeats instead of one.
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
    // The lift tool rides in the hint on a par with the other flags: a repeat without it would start
    // the reviewer with the wrong harness from the one that was talked about.
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
  const r = gitIn(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (r.error || r.status !== 0 || !r.stdout?.trim()) return null;
  let dir;
  try { dir = realpathSync(path.resolve(r.stdout.trim())); } catch { return null; }
  return { dir, nsPath: host.cloneOf(dir)?.nsPath ?? null };
}

// A refusal is a `refusal` field, the same outcome as `git()`. Target and git-toplevel both return:
// `planReview` chooses how to refuse by their mismatch.
export function resolveRepoDir(target) {
  const start = path.resolve(target);
  const r = gitIn(start, ['rev-parse', '--show-toplevel']);
  if (r.error || r.status !== 0) return { refusal: `${start}: not a git repository` };
  // On Windows git prints the path with forward slashes — path.resolve returns the native form.
  return { targetDir: realpathSync(start), repoDir: realpathSync(path.resolve(r.stdout.trim())) };
}

function detectBase(repoDir) {
  const head = gitIn(repoDir, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (!head.error && head.status === 0) return (head.stdout ?? '').trim().replace('refs/remotes/', '');
  const current = gitIn(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current.error || current.status !== 0) return null;
  const cur = (current.stdout ?? '').trim();
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    // A local branch cannot be a base for itself. Exact comparison: on local main the `origin/main`
    // candidate must NOT be skipped — unpushed commits are a legal review subject.
    if (cur === ref) continue;
    const r = gitIn(repoDir, ['rev-parse', '--verify', '-q', ref]);
    if (!r.error && r.status === 0) return ref;
  }
  return null;
}

// Records a worker attached, resolved rather than described. The files folder holds
// every worker's files and every review round's — a reviewer told "a JSON file" finds many.
function recordPaths(home, taskId, stem) {
  const dir = filesDir(home, taskId);
  const re = new RegExp(`^${stem}-[^.]*\\.json$`);
  try {
    return readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n));
  } catch {
    // No folder yet and no record are one verdict: the reviewer is told there is none.
    return [];
  }
}

// What a landed name claims to be, for the attachment list: the two records keep their own
// blocks below, and everything else is named `other` rather than dropped.
function recordKind(filename) {
  if (isGateRecordName(filename)) return 'gate record';
  if (isHandoverRecordName(filename)) return 'handover record';
  return 'other';
}

// Every file the reviewed address attached, taken from the JOURNAL — which binds sender to
// artifact — and not from a name pattern. `null`: this subject has no reviewed address at all.
function attachedFiles(home, taskId, owner) {
  if (!owner) return null;
  const dir = filesDir(home, taskId);
  const { files, broken } = attachmentsOf(home, taskId, owner.id);
  return {
    files: files.map(({ filename, at }) => ({ path: path.join(dir, filename), at, kind: recordKind(filename) })),
    broken,
  };
}

const gateRecordPaths = (home, taskId) => recordPaths(home, taskId, GATE_RECORD_STEM);

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

// The diff sits in task artifacts, where both the reviewer and a person see it. An occupied name
// gets a number — the previous must not be overwritten. Here the name is only PREDICTED.
function diffName(home, taskId, slug) {
  const dir = filesDir(home, taskId);
  let n = 1;
  while (existsSync(path.join(dir, diffFile(slug, n)))) n += 1;
  return diffFile(slug, n);
}

// Diff write that occupies the name by the write itself: between `existsSync` and the write a second
// review of the same slug would slip in. Returns the path that LANDED on disk; exported for the test.
export function writeDiff(dir, slug, content) {
  return occupyTaskFile(dir, diffStem(slug), '.diff', content);
}

// The diff path sits in three places of the plan, rebuilt from the path that landed. Called
// UNCONDITIONALLY: the "name moved forward" branch happens only in a race.
function retargetDiff(plan, diffPath) {
  const { taskId, nsPath, repoDir, address, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress, rules, skill, driver, host } = plan;
  plan.diffPath = diffPath;
  plan.prompt = buildPrompt({ taskId, nsPath, repoDir, address, diffPath, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress, rules, skill, driver, host });
  plan.reReview = buildReReview({ diffPath, repoDir, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress });
}

// The contract the worker preamble quotes word for word, and the list it promises. Built from the
// journal, so a file the author attached cannot be missing here however the author labelled it.
function attachmentEvidence(attachments, reviewedAddress, at) {
  if (!attachments) {
    return `${ATTACHMENT_CONTRACT} This subject is not a participant worktree, so no address here is `
      + 'the reviewed one and no such list is built.';
  }
  // The list is read at plan time, like the diff beside it: what arrives later is not in it, and
  // saying so is the difference between a stale list and one the reader can trust.
  const short = attachments.broken.length
    ? `\n${attachments.broken.length} artifact record(s) of that address could not be read, so the list `
      + `may be short: ${attachments.broken.join('; ')}.`
    : '';
  if (!attachments.files.length) {
    return `${ATTACHMENT_CONTRACT} ${reviewedAddress} attached nothing as of ${at}, and that is the `
      + 'whole list rather than a gap in it. A file attached after that moment reaches you only with a '
      + `re-review.${short}`;
  }
  return `${ATTACHMENT_CONTRACT} ${reviewedAddress} attached these as of ${at}, in send order — path, type, time:\n`
    + attachments.files.map((a) => `- ${a.path} — ${a.kind} — ${a.at}`).join('\n')
    + '\nRead the ones your findings depend on. Reporting that a claim has nothing behind it while a file '
    + 'above carries it is a false finding — a probe transcript attached as `other` is still the probe. '
    + `A file attached after that moment reaches you only with a re-review.${short}`;
}

// What the record covers, said where the reviewer reads the snapshot: a matching sha is a
// statement about the COMMIT, and the subject can hold more than the commit does.
function gateEvidence(gateRecords, snapshot, untracked) {
  if (!gateRecords.length) {
    return 'No gate record is attached to this task: the author\'s gate claim has nothing behind it. '
      + 'Say so in the report — that is not a refusal and not a green.';
  }
  const outside = [
    ...(snapshot.clean ? [] : ['the tracked tree was dirty at snapshot time']),
    ...(untracked.length ? ['the subject includes untracked files, which no commit holds'] : []),
  ];
  return `Gate records attached to this task, read them:\n${gateRecords.map((f) => `- ${f}`).join('\n')}\n`
    + 'Use the one whose `tree` equals the worktree HEAD named above — several can be here because this folder holds '
    + 'every worker\'s files and every review round\'s, and the sha is what tells them apart. None matching that sha '
    + 'means no record covers this tree. A matching record is a statement about the COMMIT at that sha and about '
    + `nothing else${outside.length ? `, and here it is already narrower than the subject: ${outside.join('; ')}` : ''}.`;
}

// The second record: what makes the gate run mean anything. Its absence is stated, never
// left to be inferred — the whole point of the form is that a missing check is not a pass.
function handoverEvidence(handoverRecords) {
  if (!handoverRecords.length) {
    return 'No handover record is attached to this task: none of the five pre-handover checks has anything '
      + 'behind it. Say so in the report — that is not a refusal and not a green. The one subject where its '
      + 'absence is expected rather than a gap is an approver\'s hand-off: the record is the WORKER\'s, and an '
      + 'approver carries only its own gate record.';
  }
  return `Handover records attached to this task, read them:\n${handoverRecords.map((f) => `- ${f}`).join('\n')}\n`
    + 'Use the one whose `tree` equals the worktree HEAD named above — several can be here because this folder holds '
    + 'every worker\'s files and every review round\'s, and the sha is what tells them apart. None matching that sha '
    + 'means no record covers this tree, and that is a gap to name rather than a green. Each record carries five checks '
    + `(${HANDOVER_CHECKS.join(', ')}); a check that says \`notRun\` was not performed, and a record whose `
    + 'check is missing altogether says less than one that admits it. Name which checks are absent or `notRun` '
    + 'in the report — you run nothing, so what the record does not claim is what nobody checked.';
}

function subject({ diffPath, repoDir, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress }) {
  const treeState = snapshot.clean
    ? 'At snapshot time the tracked tree was clean.'
    : `At snapshot time the tracked tree was dirty; modified tracked paths: ${snapshot.modifiedTracked.join(', ')}. `
      + 'This can fail in both directions: content committed at HEAD can be absent from the snapshot because the tree was mid-edit, '
      + 'and uncommitted content can be present although nothing committed it.';
  return `The diff is in the file ${diffPath} (read it in full); ${baseLine}. What lies outside this boundary is not a review subject.
The file is a SNAPSHOT taken at ${snapshot.at} against that base${snapshot.head ? `, from worktree HEAD ${snapshot.head}` : ''} — it is written once and never updated, while the author goes on committing. Everything committed after that moment is missing from it. The current state is the working copy ${repoDir} itself: before reporting a finding, open the file there and check that the line is still as the snapshot shows it — a review of a stale file reports closed findings as open. Make this check whether the tracked-tree state below is clean or dirty: the working copy can change after either snapshot. If the working copy contradicts the snapshot, do not run Git and do not file a finding; report the discrepancy as unresolved and hand the orchestrator the exact verification command \`git show <sha> -- <path>\`, substituting the worktree HEAD named above and the path in question. A fresh diff file comes as a re-review; ask the orchestrator for one, the same command re-snapshots.
${treeState}
Change summary:
${stat || '(new files only)'}
${untracked.length ? `\nNew untracked files (paths relative to the repository, read them):\n${untracked.map((f) => `- ${f}`).join('\n')}` : ''}

${attachmentEvidence(attachments, ownerAddress, snapshot.at)}

${gateEvidence(gateRecords, snapshot, untracked)}

${handoverEvidence(handoverRecords)}`;
}

function procedure(skill) {
  if (skill) {
    return `Do not invent a review procedure: read ${path.join(skill.dir, 'SKILL.md')} and follow it in "report only" mode — do not fix findings and do not offer "I will fix it". Skill materials sit next to it${skill.shared ? `, shared standards are in ${skill.shared}` : ''}; resolve relative paths in the skill text from its directory. Skip steps that need a write, a command start, or an unavailable MCP server, and list what you skipped in the report.`;
  }
  return `Finding format: <file>:<line> [critical|major|minor] gist — suggested fix.
The label is the finding's COST — what breaks, or stays unverified, if nobody fixes it. \`critical\`: it breaks in use, loses data, or grants a right nobody granted. \`major\`: a stated contract or rule is broken, or a case the change claims to cover stays unchecked. \`minor\`: the cost is local and nothing else depends on it.
The size of the fix is not the label — the size belongs in the suggested fix. A two-line fix is \`major\` when the cost is high, and a large rewrite stays \`minor\` when the cost is low. Do not write in prose that the cost is really higher than the label — raise the label instead. In doubt raise it: an understated label hides an expensive finding among cheap ones and the orchestrator, picking by label, misses it, while an overstated one only costs one more read.
No findings — say so and in one line list what you checked. Do not retell the diff and do not praise the code.`;
}

function buildPrompt({ taskId, nsPath, repoDir, address, diffPath, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress, rules, skill, driver, host }) {
  const bus = (name) => toolName(driver, PROMPTOBUS_SERVER, name, host);
  const mcpBoundary = driver.phrases.mcpBoundary;
  return `You are the code reviewer of task ${taskId}. The review subject is the changes of repository ${nsPath}; its working copy is ${repoDir}, read it freely: call sites of changed methods, neighboring code, tests. You are a Promptobus bus participant with address ${address}; the link to the orchestrator is the MCP server tools ${PROMPTOBUS_SERVER} (it is already attached to this session): ${bus('promptobus_send')}, ${bus('promptobus_mailbox')}, ${bus('promptobus_task')}.

## Review subject

${subject({ diffPath, repoDir, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress })}

## Isolation — hold it yourself

- The context of the session that wrote the code was not given to you, and that is a guard against self-approval: trust the code and the standards, not that "this is how it was meant".
- File edits and command starts are disabled for you by the mechanism. Edit nothing — produce findings, the author fixes them.
- Mechanical checks (build, analyzer, tests) are unavailable to you — do not invent their result, say in the report that they were not run.
- The author's gate run reaches you as a record, not as a sentence — the files are named in the review subject above, and their shape is \`${GATE_RECORD_SCHEMA}\` in the promptobus package. Compare a record's \`tree\` with the worktree HEAD named above. The same sha with \`dirty: false\` and \`exit: 0\` — the claim is evidence about the COMMIT at that sha, and about nothing else: uncommitted changes and untracked files of the subject are outside it, and the subject line above says when that is the case here. Another sha, a dirty tree, a non-zero exit, or no record at all — it is not evidence about this tree: name which of the four it was and carry on with the review, do not refuse over it. What the record cannot do is prove the run happened — an author can write \`exit: 0\` beside the right sha having run nothing, and only a re-run on that sha by someone allowed to run catches that.
- **The author's pre-handover checks reach you the same way** — a second record, named in the review subject above, shaped by \`${HANDOVER_RECORD_SCHEMA}\` in the promptobus package. The gate record says what was run; this one says why that run means anything: the difference of verdict NAMES against the base commit, the mutation probe with the line it broke and the names it reddened, \`git status --porcelain\` at both ends of that probe, every red called environmental with its run on the base commit, and every gate that was not run with its reason. You produce no such record of your own — you run nothing — and you do not repeat these checks by hand. What you do is read it: a check the author declared \`notRun\` was not performed, a check missing from the record was not even declared, and neither reads as a pass. Name them in the report the way you name a missing gate record, and go on with the review.
- ${mcpBoundary} You have the whole canonical workspace set, and every name is pre-approved: nobody will ask you for permission, and there is no person behind the session who would refuse. Read as much as you need — an event contract, a task card, a merge request diff, a metric, a fact from team memory. Do not create, change, delete or publish anything: not a comment on a merge request or a card, not a thread, not a dashboard, not an annotation, not a test case, not an artifact, not a fact in team memory. The report leaves by one channel — a message to the orchestrator; everything you would want to write somewhere, write into it.
- The subject is only changed and new code, not the legacy around it.

## Read the rules before review

${rules.map((f) => `- ${f}`).join('\n')}

## Procedure

${procedure(skill)}

## Hand-off form

Your report opens with four lines, in this order, and nothing above them:

- **Done** — what was reviewed, and how many findings by severity.
- **Gate** — always "not run, because a reviewer runs nothing", plus your verdict on the author's gate record and on its handover record: which of the five pre-handover checks are absent or \`notRun\`. The line is never omitted: an omitted line reads as a green one.
- **Open** — what you could not check, and which steps of the procedure you skipped.
- **Decide** — what needs a decision from the orchestrator, or "nothing".

The header is at most ${RESULT_BODY_MAX} characters; the findings follow it in the same body, and they are not bounded. You produce no artifact of your own — file writes are disabled for you by the mechanism, and you have no overflow file to move findings into — but you may **cite** a landed filename another participant sent. The author's gate record in the **Gate** line is the ordinary case: name the file whose \`tree\` matches the HEAD you were handed. The report leaves by one channel; that is where your hand-off differs from a worker's, whose overflow goes into an attached file.

## Team memory

${memoryRule(driver, host)}

## Communication protocol

You have nothing to wait with and no need to: the task mailboxes are listened to by the bus warden, and it wakes you with a postcard when you are written to. The postcard carries the text of short messages, but only mailbox marks them read — fetch it first, even if the postcard already makes everything clear.

1. Finished the review — send the report in full: ${bus('promptobus_send')} {to:"orchestrator", type:"result", body:"the hand-off header above, then the findings or 'No findings' plus what was checked"}.
2. Stuck on a question without whose answer you cannot continue — ${bus('promptobus_send')} {to:"orchestrator", type:"question", body:"question"} and end the turn. The answer (type=answer) will arrive as a postcard. Do not guess.
3. Work stretches past a couple of minutes of silence — send status with its content and a time estimate ("three files left, ~5 minutes") BEFORE you end the turn: a silent session is indistinguishable from a hung one to the orchestrator. A status expects NO answer — send it and go on working, never end a turn waiting for an acknowledgement that is not coming. Name the time by volume and a measurement, not by feeling.
4. After result end the turn. A type=task message arrived with a path to a new diff — that is a re-review: first fetch the mailbox, then check against it whether your prior findings are closed, then look at what else changed. Answer with result again.
5. Do not end a turn having sent nothing since the last thing that asked you for an answer. Types task, question, review and result ask for one; status, answer and artifact do not. Nothing to report yet — that is itself a status.
6. A person closes the session.${driver.phrases.promptRules}`;
}

// Re-review message: the reviewer already has the context (rules, skill, isolation).
function buildReReview({ diffPath, repoDir, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress }) {
  return `Re-review: the author sent a new version of the changes.

${subject({ diffPath, repoDir, stat, untracked, baseLine, snapshot, gateRecords, handoverRecords, attachments, ownerAddress })}

First check your prior findings against the new diff — which are closed, which are not, then look at what else changed. The report is promptobus_send {to:"orchestrator", type:"result", body:"..."} as before.`;
}

// `core.quotePath=false` on EVERY git call of this file: otherwise git gives non-ASCII paths in
// octal escaping, and the reviewer gets names that are not on disk.
const GIT_OPTS = ['-c', 'core.quotePath=false'];

// The ordinary output ceiling is shared with the zone walk, and both wrappers share the git wait
// ceiling. A timeout or overflow leaves no status, so the `error` branch names it.
function git(repoDir, args) {
  const r = spawnSync('git', ['-C', repoDir, ...GIT_OPTS, ...args], {
    encoding: 'utf8', maxBuffer: PROC_MAX_OUTPUT, timeout: GIT_NET_TIMEOUT_MS,
  });
  if (r.error) return { refusal: `git ${args.join(' ')}: ${r.error.message}` };
  if (r.status !== 0) return { refusal: `git ${args.join(' ')}: ${(r.stderr ?? '').trim() || `code ${r.status}`}` };
  return { out: r.stdout.trim() };
}

// The ceiling here is its own and higher: the subject of the call is the diff itself. Output is not
// trimmed — in a diff both the first and the last newline matter.
function gitRaw(repoDir, args) {
  const r = spawnSync('git', ['-C', repoDir, ...GIT_OPTS, ...args], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: GIT_NET_TIMEOUT_MS,
  });
  if (r.error) return { refusal: `git ${args.join(' ')}: ${r.error.message}` };
  if (r.status !== 0) return { refusal: `git ${args.join(' ')}: ${(r.stderr ?? '').trim() || `code ${r.status}`}` };
  return { out: r.stdout };
}

// One git diff invocation gives the patch, stat and raw records off the same tracked-tree reads:
// comparing them with the base-to-HEAD diff finds the race without opening the tree a second time.
function snapshotDiff(repoDir, diffFrom, head) {
  // A stat-only change can leave the worktree side of a raw record at 0000000 though the content
  // still matches HEAD. Refresh the index stat data first, so the comparison is about content.
  git(repoDir, ['update-index', '-q', '--refresh']);
  const out = gitRaw(repoDir, ['diff', '--raw', '--stat', '--patch', diffFrom]);
  if (out.refusal) return out;
  const patchAt = /^diff --(?:git|cc|combined) /m.exec(out.out)?.index ?? -1;
  const prefix = patchAt < 0 ? out.out : out.out.slice(0, patchAt);
  const diff = patchAt < 0 ? '' : out.out.slice(patchAt);
  const prefixLines = prefix.split('\n');
  const snapshotRecords = prefixLines.filter((line) => line.startsWith(':'));
  const stat = prefixLines.filter((line) => line && !line.startsWith(':')).join('\n').trim();
  if (!head) return { diff, stat, modifiedTracked: [] };

  const committed = gitRaw(repoDir, ['diff', '--raw', diffFrom, head]);
  if (committed.refusal) return committed;
  const committedRecords = committed.out.split('\n').filter((line) => line.startsWith(':'));
  const snapshotSet = new Set(snapshotRecords);
  const committedSet = new Set(committedRecords);
  const changedRecords = [
    ...snapshotRecords.filter((line) => !committedSet.has(line)),
    ...committedRecords.filter((line) => !snapshotSet.has(line)),
  ];
  const modifiedTracked = [...new Set(changedRecords.flatMap((line) => line.split('\t').slice(1)))].sort();
  return { diff, stat, modifiedTracked };
}

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn, fail } from './util.js';
import { hostOf } from './host.js';
import { guardHookCommand } from '../dist/hooks.js';
import {
  addressOf, bindIfOwner, GateError,
  participantMcpPath, participantOf,
  participantRecord, participantSettingsPath, readTask, reviewerAddress, approverAddress,
  addrDir, sessionIdentity, taskExists, unreadNote, upsertParticipant, watchParticipant,
  ORCHESTRATOR,
} from './store.js';
import {
  dryRunToolNote, guardHookNote, liftHarness, memoryRule, mcpNote, mcpServerLines,
  normalizeLaunchTool, optionRefusal, participantMcp, participantPluginDir, PROMPTOBUS_SERVER,
  withToolVersion,
  resolveEffort, resolvePermissionMode, sayMcp, sayModule, sayTool, sessionEnv, sessionEnvNote,
  sessionName, skillSettings, skillsNote, toolName, writeLaunchFiles,
} from './spawn.js';
import { participantSession } from './status.js';
import { GATE_RECORD_SCHEMA, RESULT_BODY_MAX } from './handoff.js';
import { launchProvenance, provenanceLine } from './provenance.js';
import {
  decideLift, effectiveStrategy, routingContext, routingLine, sayDecision,
} from './models.js';
import { hasFeature, openParticipant, ROUTING_FIELD } from '../dist/index.js';
import { driverOf, REGISTRY, roleHarnessRefusal } from './drivers.js';
import { ensureWarden } from './warden.js';
import { clearThroughputSidecar, tallies } from './model-routing/telemetry.js';
import { resolveRepoDir, reviewerFor, worktreeOwner } from './review.js';
import { branchLine, worktreeBranch } from './worktree.js';

function canonical(p) {
  try { return realpathSync(String(p ?? '')); } catch { return String(p ?? ''); }
}

function approverFor(taskMeta, repoDir, clone) {
  const { slug } = reviewerFor(taskMeta, repoDir, clone);
  return { slug, address: approverAddress(slug), reviewerAddress: reviewerAddress(slug) };
}

export function reviewerResultSent(home, taskId, reviewAddr, reviewer = null) {
  const row = tallies(home, taskId).get(addrDir(reviewAddr));
  if ((row?.resultCount ?? 0) === 0) return false;
  const meta = reviewer?.metadata ?? null;
  if (!meta) return true;
  const floor = 'reviewAssignedAt' in meta ? meta.reviewAssignedAt : meta.started;
  if (!floor) return false;
  if (!row.lastResultAt) return false;
  return Date.parse(row.lastResultAt) >= Date.parse(floor);
}

function approverRepoMatches(participant, repoDir) {
  const recorded = participant?.metadata?.repoAbs;
  return !!recorded && canonical(recorded) === canonical(repoDir);
}

function validateApproverPreconditions(host, {
  target, task, harness,
}) {
  if (!String(target ?? '').trim()) {
    throw new GateError(`${host.commandName} review <path> --approver --task <id>: the repository path is required — `
      + 'there is no resolve from the current directory.');
  }
  const resolved = resolveRepoDir(target);
  if (resolved.refusal) throw new GateError(resolved.refusal);
  const { repoDir } = resolved;
  if (!host.inWorkspace(repoDir)) {
    if (host.inWorkspace(resolved.targetDir)) {
      throw new GateError(host.reviewLayoutError('not-clone', { targetDir: resolved.targetDir, repoDir }));
    }
    throw new GateError(host.reviewLayoutError('outside', { repoDir }));
  }
  const clone = host.cloneOf(repoDir);
  if (!clone) throw new GateError(host.reviewLayoutError('no-clone', { repoDir }));
  const home = host.promptobusHome();
  if (!task) {
    throw new GateError(`--approver names an acceptance lift for an existing task — pass --task <id>. `
      + `To review first: ${host.busCommand(['review', `"${repoDir}"`, '--task <id>'])}`);
  }
  if (!taskExists(home, task)) throw new GateError(`there is no task ${task}`);
  if (readTask(home, task).status === 'done') {
    throw new GateError(`task ${task} is closed — nobody for the approver to report to.`);
  }
  const taskMeta = readTask(home, task);
  const { slug, address, reviewerAddress: reviewAddr } = approverFor(taskMeta, repoDir, clone);
  const reviewer = participantOf(taskMeta, reviewAddr);
  if (!reviewer) {
    throw new GateError(`--approver requires ${reviewAddr} to have lifted from this review subject — `
      + `no such reviewer participant is recorded in task ${task}.`);
  }
  const recordedRepo = reviewer.metadata?.repoAbs;
  if (!recordedRepo) {
    throw new GateError(`--approver requires ${reviewAddr} to carry a recorded repository path — `
      + 'none is on the participant record.');
  }
  if (canonical(recordedRepo) !== canonical(repoDir)) {
    throw new GateError(`--approver requires a reviewer result from this repository — `
      + `${reviewAddr} is recorded at ${recordedRepo}, not ${repoDir}.`);
  }
  if (!reviewerResultSent(home, task, reviewAddr, reviewer)) {
    throw new GateError(`--approver requires a type=result message from ${reviewAddr} in task ${task}'s journal — `
      + 'none is recorded for the current review generation yet. Wait for the reviewer to send its result, '
      + 'then lift the approver.');
  }
  const participant = participantOf(taskMeta, address);
  if (participant && !approverRepoMatches(participant, repoDir)) {
    const recorded = participant.metadata?.repoAbs;
    throw new GateError(`--approver requires ${address} on this repository — ${address} is recorded at `
      + `${recorded}, not ${repoDir}. A live approver on another subject cannot be reused here.`);
  }
  if (participant && harness && harness !== participant.harness) {
    const seen = participantSession(participant);
    const named = seen === 'alive' ? 'alive' : seen === 'dead' ? 'gone' : 'unknown';
    throw new GateError(`${address} in task ${task} was started by harness ${participant.harness}, and --harness asks for `
      + `${harness}: this command does not change an approver's harness. This call saw the session as ${named}.`);
  }
  return { home, taskMeta, repoDir, clone, slug, address, reviewAddr, reviewer, participant };
}

function approverDenyTools(host, driver, declaredServers = []) {
  const builtIn = [];
  const canonicalServers = [...new Set((declaredServers ?? [])
    .map(String).filter((server) => server && server !== PROMPTOBUS_SERVER))];
  const hasMember = typeof host.participantDenyTools === 'function';
  const answer = hasMember ? host.participantDenyTools('approver') : null;
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
      ? `the participantDenyTools('approver') classification is incomplete for canonical external MCP server(s): ${unclassified.join(', ')}`
      : Array.isArray(answer)
        ? `the participantDenyTools('approver') member returned the pre-{ tools, complete } shape`
        : `the participantDenyTools('approver') member did not return complete: true`;
    return {
      tools: builtIn,
      refusal: `harness "${driver.id}" cannot mechanically deny MCP writes for host "${host.commandName}": `
        + `${detail}. `
        + 'Approver lift is not started — the host must return { tools, complete: true } before this harness can lift an approver.',
    };
  }
  if (!hasFeature(driver, 'mcpDenyTools')) return { tools: builtIn, refusal: null };
  return { tools: valid.length ? [...builtIn, ...driver.mcpDenyTools(valid)] : builtIn, refusal: null };
}

function buildApproverPrompt({
  taskId, nsPath, cwd, launchCwd, worktreeDir, address, workerAddress, reviewAddr, branch, rules, driver, host,
  mcpBoundary = null,
}) {
  const bus = (name) => toolName(driver, PROMPTOBUS_SERVER, name, host);
  const branchNote = branch ? `branch ${branch}` : 'branch unknown';
  const attached = [
    ...(launchCwd !== cwd ? [`clone ${cwd}`] : []),
    ...(worktreeDir && worktreeDir !== cwd && worktreeDir !== launchCwd
      ? [`worker tree ${worktreeDir} (${branchNote})`] : []),
  ];
  const worktreeNote = launchCwd !== cwd
    ? `${attached.join(' and ')} ${attached.length ? 'are' : 'is'} attached read-write via add-dir; harness launch directory is ${launchCwd}.`
    : worktreeDir && worktreeDir !== cwd
      ? `Worker tree ${worktreeDir} (${branchNote}) is attached read-write via add-dir; your session cwd is the clone root ${cwd}.`
      : `Working directory: ${cwd}.`;
  const mcpGuard = mcpBoundary ? `\n## MCP boundary\n\n${mcpBoundary}\n` : '';
  const directTraffic = workerAddress
    ? `Direct messages to ${workerAddress} are allowed in this task.`
    : 'There is no worker address registered for this review subject — route participant traffic through the orchestrator.';
  return `You are the approver of task ${taskId}. Repository ${nsPath}; ${worktreeNote} You accept one piece after the reviewer ${reviewAddr} sent a type=result message — the bus records that fact only; this package does not judge the review.

You never push, never force-push, and never rewrite commits that are already on the remote: the orchestrator pushes.

You are a Promptobus bus participant at address ${address}; the orchestrator is reached through ${PROMPTOBUS_SERVER} MCP tools (already attached): ${bus('promptobus_send')}, ${bus('promptobus_mailbox')}, ${bus('promptobus_task')}. ${directTraffic}

## Read the rules before you work

${rules.map((f) => `- ${f}`).join('\n')}

Read them and list them in your first reply. Then work by them.

## Team memory

${memoryRule(driver, host)}
${mcpGuard}
## Communication protocol

1. Once you have taken the assignment — immediately ${bus('promptobus_send')} {to:"orchestrator", type:"status", body:"what you understood and how you plan to do it"}.
2. Send status at every notable step. A status expects NO answer — send it and go on working.
3. To wait for a message — end the turn; the warden wakes you when mail arrives. Fetch the mailbox first.
4. Stuck without an answer — ${bus('promptobus_send')} {to:"orchestrator", type:"question", body:"…"} and end the turn.
5. ${workerAddress
    ? `You may write directly to ${workerAddress} when the orchestrator's assignment says so.`
    : 'Without a registered worker, write to the orchestrator only.'}
6. Finished — fetch the mailbox, then send ${bus('promptobus_send')} {to:"orchestrator", type:"result", body:"the hand-off header below"} and end the turn.

## Hand-off form

A result opens with four lines, in this order:

- **Done** — what was done, and the commits that carry it.
- **Gate** — the gate command as executed, its exit code, and the counts it printed. A gate you did NOT run: "not run, because …".
- **Open** — what is left unclosed and where you worked around a problem.
- **Decide** — what needs a decision from the orchestrator, or "nothing".

The whole body is at most ${RESULT_BODY_MAX} characters. Overflow travels as an artifact sent before the result, with the landed filename read from the immediate bus reply to your own ${bus('promptobus_send')} call.

You may **cite** a landed artifact filename sent by another participant — the usual case is the worker's gate record in the **Gate** line, the one whose \`tree\` field matches the commit you accept. Refusal remains only for a name nobody sent; \`message.artifact\` binds only to your own send. Your own overflow and gate record still go out as type=artifact from your hand; read those landed names from your own send replies.

Your gate run travels as JSON to \`${GATE_RECORD_SCHEMA}\` — one entry per gate command — and is sent BEFORE the result as type=artifact. Request the file stem \`gates-<your approver slug>.json\`. The bus checks the record against that schema at send and refuses an invalid one, naming the faults by field.`;
}

function approverInJournal(host, { target, task }) {
  if (!task) return false;
  const resolved = resolveRepoDir(target);
  if (resolved.refusal) return false;
  const clone = host.cloneOf(resolved.repoDir);
  if (!clone) return false;
  const home = host.promptobusHome();
  if (!taskExists(home, task)) return false;
  const meta = readTask(home, task);
  const participant = participantOf(meta, approverFor(meta, resolved.repoDir, clone).address);
  return !!participant && approverRepoMatches(participant, resolved.repoDir);
}

export function planApprover(rootOrHost, {
  target, task, model, effort: effortOpt, permissionMode: permissionOpt, harness,
  strategy = undefined, routing = null, dryRun,
} = {}) {
  const host = hostOf(rootOrHost);
  const lifter = liftHarness(host, harness);
  const root = realpathSync(host.workspaceRoot());
  const pre = validateApproverPreconditions(host, { target, task, harness });
  const {
    home, taskMeta, repoDir, clone, slug, address, reviewAddr, participant: existing,
  } = pre;
  const nsPath = clone.nsPath;
  const cloneRoot = clone.abs;
  const owner = worktreeOwner(taskMeta, repoDir);
  const ownerFields = owner?.metadata ?? {};
  const workerAddress = owner ? addressOf(owner) : null;
  const branch = ownerFields.branch ?? (ownerFields.worktree ? worktreeBranch(ownerFields.worktree) : null);
  const worktreeDir = ownerFields.worktree ?? (repoDir !== cloneRoot ? repoDir : null);
  const participant = existing;
  const was = participant?.metadata ?? {};
  const sessionState = participant ? participantSession(participant) : null;
  const unlaunched = !!was.pending && sessionState !== 'alive';
  const reuse = !!participant && approverRepoMatches(participant, repoDir)
    && sessionState !== 'dead' && !unlaunched;
  const routed = participant ? null : decideLift(routing, { taskMeta, address });
  const routingSkipped = participant && strategy
    ? `${address} in task ${task} is already in the journal, started by harness ${participant.harness}: `
      + '--strategy routes a lift, and this call would restart an approver whose harness is already fixed. The flag is ignored here.'
    : null;
  const driver = participant ? driverOf(participant) : (routed ? liftHarness(host, routed.harness) : lifter);
  const effort = resolveEffort(routed ? (routed.effort ?? undefined) : effortOpt, driver);
  const permissionMode = resolvePermissionMode(permissionOpt, driver, driver.options.defaultPermissionMode);
  const rules = host.collectRules(cloneRoot);
  const ruleDirs = [...new Set(rules.map((f) => path.dirname(f)))];
  const addDirs = [...new Set([
    ...(worktreeDir ? [worktreeDir] : []),
    ...(repoDir !== cloneRoot ? [repoDir] : []),
    ...ruleDirs,
  ].filter(Boolean))];
  const settingsPath = participantSettingsPath(home, task, address);
  const guardCommand = guardHookCommand(host, { address, taskId: task, home }, process.platform);
  const pluginDir = driver.options.skillsDir ? participantPluginDir(host) : null;
  const mcpConfigPath = participantMcpPath(home, task, address);
  const mcp = participantMcp(host, { address, taskId: task, home }, driver);
  const declaredServers = Object.keys(mcp.descriptor.servers ?? {})
    .filter((server) => server !== PROMPTOBUS_SERVER);
  const deny = approverDenyTools(host, driver, declaredServers);
  const harnessRefusal = roleHarnessRefusal(driver, 'approver');
  const resolvedModel = routed?.model ?? model ?? driver.options.defaultModel;
  const taken = (taskMeta.participants ?? []).map((p) => p.metadata.name).filter(Boolean);
  const name = was.name ?? sessionName(taskMeta, { slug, approver: true, taken, title: ownerFields.title });
  const mcpBoundary = !hasFeature(driver, 'mcpDenyTools') && !deny.refusal
    ? driver.phrases?.mcpBoundary ?? null
    : null;
  const prompt = buildApproverPrompt({
    taskId: task, nsPath, cwd: cloneRoot, launchCwd: cloneRoot, worktreeDir, address, workerAddress,
    reviewAddr, branch, rules, driver, host, mcpBoundary,
  });
  const launch = driver.prepare({
    ref: name,
    address,
    task,
    home,
    role: 'approver',
    mcp: mcp.descriptor,
    prompt,
    cwd: cloneRoot,
    model: resolvedModel,
    effort,
    permissionMode,
    addDirs,
    pluginDir,
    mcpConfigPath,
    settingsPath,
    guardCommand,
    denyTools: deny.tools,
    extraSettings: skillSettings(host),
    root,
  });
  launch.prompt = prompt;
  return {
    home, taskId: task, slug, address, reviewAddr, name, nsPath, repoDir, cloneRoot, worktreeDir,
    workerAddress, branch, owner, participant, sessionState, unlaunched, reuse, rules, ruleDirs, addDirs, prompt,
    module: host.moduleNote(cloneRoot), pluginDir,
    settingsPath, guardCommand, mcpConfigPath, mcpNote: mcpNote(mcp, 'the approver'),
    launch, argv: launch.argv, mcpConfig: launch.mcpConfig, settings: launch.settings,
    model: resolvedModel, effort, permissionMode, driver,
    refusal: harnessRefusal ?? deny.refusal,
    routing: routed?.metadata ?? null, decision: routed?.decision ?? null, routingSkipped,
    env: sessionEnv(driver, process.env, host),
    host,
  };
}

function sayApproverHome(plan) {
  if (!plan.worktreeDir || plan.cloneRoot === plan.worktreeDir) return;
  info(`approver cwd: ${plan.cloneRoot} — worker tree ${plan.worktreeDir} is attached for branch work`);
}

function keptNote(plan) {
  return ` Task ${plan.taskId} and the participant record ${plan.address} are in place.`;
}

function launchFailureNote(plan) {
  return `${keptNote(plan)} The approver was not started; the task stays active.`;
}

function deadSessionNote(plan) {
  return `${keptNote(plan)} Start the approver again: ${plan.host.busCommand(['review', `"${plan.repoDir}"`, `--task ${plan.taskId}`, '--approver'])}.`
    + ' There will be no messages from this address — waiting for them is pointless.';
}

export async function approverLift(rootOrHost, opts) {
  const host = hostOf(rootOrHost);
  validateApproverPreconditions(host, opts);
  const wanted = effectiveStrategy(host, { strategy: opts?.strategy });
  const routing = !wanted ? null : await (async () => {
    if (approverInJournal(host, { target: opts.target, task: opts.task })) return null;
    return routingContext(host, {
      role: 'approver',
      strategy: wanted.strategy,
      strategySource: wanted.source === 'flag' ? null : wanted.source,
      harness: opts.harness,
      model: opts.model,
      effort: opts.effort,
      allowPayg: opts.allowPayg,
      refresh: opts.refresh,
      dryRun: opts.dryRun,
      adapterFor: opts.adapterFor,
    });
  })();
  const plan = planApprover(rootOrHost, { ...opts, routing });
  if (plan.routingSkipped) warn(plan.routingSkipped);
  if (plan.routing) info(routingLine(plan.routing));
  if (plan.refusal && !plan.reuse) fail(plan.refusal);
  else if (plan.refusal) warn(`${plan.refusal} The running approver keeps the deny list it was launched with.`);

  let toolCache = null;
  let liftProvenance = null;
  const harnessTool = () => (toolCache ??= withToolVersion(
    plan.driver, plan.host, normalizeLaunchTool(
      plan.driver, opts.tool ?? plan.host.resolveToolBin(plan.driver.options.tool), plan.env,
    ),
  ));

  if (opts.dryRun) {
    info(`repository: ${plan.nsPath} → clone ${plan.cloneRoot}${plan.worktreeDir ? ` · worker tree ${plan.worktreeDir}` : ''}`);
    info(`task: ${plan.taskId}`);
    info(`approver address: ${plan.address} · reviewer result on record at ${plan.reviewAddr} · session: "${plan.name}"`
      + ` · model: ${plan.model}${plan.effort ? ` · effort: ${plan.effort}` : ''}`);
    if (plan.decision) sayDecision(plan.decision);
    if (plan.branch) info(branchLine(plan.branch, worktreeBranch(plan.worktreeDir)));
    sayApproverHome(plan);
    info(`approver rules:`);
    for (const f of plan.rules) console.log(`  ${f}`);
    sayModule(plan);
    info(`approver MCP (${plan.mcpConfig.mcpServers ? Object.keys(plan.mcpConfig.mcpServers).length : 0}):`);
    for (const line of mcpServerLines(plan.mcpConfig)) console.log(`  ${line}`);
    sayMcp(plan, { hint: false });
    info(dryRunToolNote(plan.driver));
    info(`workspace skills: ${skillsNote(plan)}`);
    info(guardHookNote(plan));
    info(sessionEnvNote(plan.driver, plan.host));
    if (plan.launch?.envNote) info(plan.launch.envNote);
    if (plan.driver.phrases.naming) info(`harness session name: ${plan.driver.phrases.naming}`);
    info('prompt:');
    console.log(plan.prompt);
    return plan;
  }

  if (plan.reuse) {
    ok(`approver ${plan.address} is already on the bus`);
    if (plan.sessionState === 'unknown') {
      warn(`liveness of the approver session ${plan.address} cannot be confirmed (${plan.driver.phrases.unreadable}) — repeat lift will not start a second session; if there is no report — check the session: ${plan.driver.phrases.sessions}`);
    }
    warnUnread(plan);
    return plan;
  }

  if (plan.unlaunched) {
    warn(`record of the approver ${plan.address} is left from a failed start (pending), liveness cannot be confirmed — starting the approver again with the full prompt`);
  } else if (plan.participant) {
    warn(`session of the approver ${plan.address} is dead (it is not among the live ones in ${plan.driver.phrases.sessions}) — starting a new approver with the full prompt`);
  }

  const tool = harnessTool();
  sayTool(tool, { reason: false });
  if (!tool.ok) fail(tool.reason);
  const refusal = optionRefusal(plan.driver, plan.effort, tool, plan.host);
  if (refusal) fail(refusal);
  if (liftProvenance === null) {
    const t = harnessTool();
    liftProvenance = launchProvenance(plan.host, t);
    info(provenanceLine(liftProvenance));
  }

  info(`approver address: ${plan.address} · reviewer result on record at ${plan.reviewAddr}`);
  sayModule(plan);
  sayMcp(plan);
  sayApproverHome(plan);
  info(`workspace skills: ${skillsNote(plan)}`);
  info(`approver rules:`);
  for (const f of plan.rules) console.log(`  ${f}`);

  bindIfOwner(plan.home, plan.taskId);
  writeLaunchFiles(plan.launch.files, plan.driver.options.launchDirs);
  if (!plan.reuse) clearThroughputSidecar(plan.home, plan.taskId, plan.address);
  const { record } = openParticipant(plan.home, plan.taskId, participantRecord(plan.address, {
    harness: plan.driver.id,
    repo: plan.nsPath,
    repoAbs: plan.repoDir,
    model: plan.model,
    ...(plan.effort ? { effort: plan.effort } : {}),
    ...(plan.routing ? { [ROUTING_FIELD]: plan.routing } : {}),
    name: plan.name,
    sessionRef: plan.name,
    session: null,
    started: new Date().toISOString(),
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

  const { output, session, seen } = await plan.driver.spawn(plan.launch, {
    tool,
    home: plan.home,
    host: plan.host,
    task: plan.taskId,
    address: plan.address,
    cwd: plan.cloneRoot,
    env: plan.env,
    ref: plan.name,
    role: 'approver',
    launchFailNote: launchFailureNote(plan),
    deadNote: deadSessionNote(plan),
    persist: (id, state, sessionId) => {
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
  ok(`approver ${plan.address} started in ${plan.nsPath}${session ? ` (session ${session})` : ''}`);
  ensureWarden(plan.home, plan.taskId, { host: plan.host });
  plan.driver.saidLiftoff({ name: plan.name, seen, session, output });
  warnUnread(plan);
  return plan;
}

function warnUnread(plan) {
  const note = unreadNote(plan.home, plan.taskId, ORCHESTRATOR, sessionIdentity());
  if (note) warn(note);
}

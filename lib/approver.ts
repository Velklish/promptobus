import { persistLegacyParticipant, persistNativeParticipant, releaseNativeReservation, reserveNativeParticipant } from './native-lifecycle.js';
import { renderApproverInstructions } from './prompts/roles.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { ok, info, warn, fail, runProc } from './util.js';
import { hostOf } from './host.js';
import { guardHookCommand } from '../dist/hooks.js';
import {
  addressOf, bindIfOwner, contactsOf, currentResult, GateError,
  participantMcpPath, participantOf,
  participantRecord, participantSettingsPath, readTask,
  sessionIdentity, strictTaskFacts, taskExists, unreadNote,
  ORCHESTRATOR,
} from './store.js';
import {
  contactsSection, dryRunToolNote, guardHookNote, keepBrief, liftHarness, machineName, memoryRule, mcpNote, mcpServerLines,
  normalizeLaunchTool, optionRefusal, participantMcp, participantPluginDir, participantSkillsRoot, PROMPTOBUS_SERVER,
  readBrief, repoGenerator, repoSkillsLine, runRepoGenerator, sayRepoSkills, sayWorktreeDeps, withToolVersion,
  resolveEffort, resolvePermissionMode, sayMcp, sayModule, sayTool, sessionEnv, sessionEnvNote,
  sessionName, skillSettings, skillsNote, toolName, worktreeDepsLine, writeLaunchFiles,
} from './spawn.js';
import { participantSession } from './status.js';
import { leaseRule } from './lease.js';
import { launchProvenance, provenanceLine } from './provenance.js';
import {
  decideLift, effectiveStrategy, routingContext, routingLine, sayDecision,
} from './models.js';
import {
  APPROVER, hasFeature, packageDenyTools, registryOf, roleEntry, ROUTING_FIELD, WRITES_MAIN_TREE,
} from '../dist/index.js';
import { driverOf, REGISTRY, roleHarnessRefusal } from './drivers.js';
import { ensureWarden } from './warden.js';
import { clearThroughputSidecar } from './model-routing/telemetry.js';
import {
  gateInstructionsSection, hostDenyClassification, readGateInstructions, requireStepResults,
  resolveRepoDir, reviewerFor, worktreeOwner,
} from './review.js';
import { pipelineOf } from '../dist/pipeline.js';
import {
  WORKTREE_BRANCH_PREFIX, WORKTREE_DIR_REL, branchLine, createWorktree, defaultRefs,
  excludeWorktrees, installWorktreeDeps, npmCiCommand, worktreeBranch, worktreeHasLock,
} from './worktree.js';
import { shellQuote } from './util.js';
import { assertNativeContextDriver, contextRules, nativeContextMetadata, nativeContextPrompt, prepareNativeContext } from './native-participant-context.js';

import type { DeclaredStep, DriverDenyTool, HostClone, LaunchFile, ParticipantV1, PreparedHostParticipantContextSelection, PromptobusHost, TaskV1 } from '../dist/index.js';
import type { ParticipantTools } from './prompts/roles.js';
import type { LibDriver, LibLaunchPlan, LibToolBin } from './driver-runtime.js';
import { coreDriver } from './driver-runtime.js';
import type { DenyEntry, GateInstructions, ReviewOptions } from './review.js';
import type { RepoSkillsState, WorktreeDepsState } from './spawn.js';

type Contacts = ReturnType<typeof contactsOf>;
type NativeSelection = PreparedHostParticipantContextSelection | null;
type RoutedLift = NonNullable<ReturnType<typeof decideLift>>;
export interface ApproverOptions extends ReviewOptions {
  routing?: Awaited<ReturnType<typeof routingContext>>; instructions?: GateInstructions | null;
  instructionsReuse?: boolean; preparedContext?: NativeSelection;
}
interface ApproverPromptInput {
  taskId: string; nsPath: string; cwd: string; cloneRoot: string; worktreeDir: string | null;
  address: string; stepName: string; workerAddress: string | null; reviewAddr: string; branch: string;
  workerBranch: string | null; rules: string[]; driver: LibDriver; host: PromptobusHost;
  repoSkills: RepoSkillsState; worktreeDeps: WorktreeDepsState; mcpBoundary?: string | null;
  brief?: string | null; instructions?: GateInstructions | null; contacts: Contacts;
}
export interface ApproverPlan {
  home: string; taskId: string; slug: string; stepName: string; address: string; reviewAddr: string; name: string;
  nsPath: string; repoDir: string; cloneRoot: string; worktreeDir: string | null; selectedContext: NativeSelection;
  worktreePath: string; wtName: string; branch: string; base: string; brief: string | null;
  instructions: GateInstructions | null; briefStem: string; workerAddress: string | null; workerBranch: string | null;
  owner: ParticipantV1 | null; participant: ParticipantV1 | null; sessionState: 'alive' | 'dead' | 'unknown' | null;
  unlaunched: boolean; reuse: boolean; rules: string[]; ruleDirs: string[]; addDirs: string[]; prompt: string;
  module: ReturnType<PromptobusHost['moduleNote']>; pluginDir: string | null; settingsPath: string;
  guardCommand: string; mcpConfigPath: string; mcpNote: ReturnType<typeof mcpNote>; launch: LibLaunchPlan; argv: string[];
  mcpConfig: unknown; settings: unknown; model: string; effort: string | null; permissionMode: string | null;
  driver: LibDriver; refusal: string | null; routing: RoutedLift['metadata'] | null; decision: RoutedLift['decision'] | null;
  routingSkipped: string | null; env: NodeJS.ProcessEnv; repoSkills: RepoSkillsState; worktreeDeps: WorktreeDepsState;
  rebuild(repoSkills?: RepoSkillsState, worktreeDeps?: WorktreeDepsState): { prompt: string; launch: LibLaunchPlan };
  host: PromptobusHost;
}

function canonical(p: unknown) {
  try { return realpathSync(String(p ?? '')); } catch { return String(p ?? ''); }
}

function pathDigest(at: string): string | null {
  let stat;
  try { stat = lstatSync(at); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const hash = createHash('sha256');
  if (stat.isSymbolicLink()) hash.update(`link:${readlinkSync(at)}`);
  else if (stat.isDirectory()) {
    hash.update('directory');
    for (const name of readdirSync(at).sort()) {
      hash.update(name);
      hash.update(pathDigest(path.join(at, name)) ?? 'missing');
    }
  } else if (stat.isFile()) {
    hash.update('file');
    hash.update(readFileSync(at));
  } else hash.update(`other:${stat.mode}`);
  return hash.digest('hex');
}

// A launch file merged over a tracked path may find the project's blob there: it is in Git, not lost.
// Hashed the way `git add` would, so a checkout conversion such as `eol=crlf` is not an edit.
function holdsTrackedBlob(file: LaunchFile, worktreePath: string) {
  if (file.tracked === undefined) return false;
  try { if (!lstatSync(file.path).isFile()) return false; } catch { return false; }
  const rel = path.relative(worktreePath, file.path).split(path.sep).join('/');
  const indexed = runProc('git', ['-C', worktreePath, 'rev-parse', '--verify', '-q', `:${rel}`]);
  const working = runProc('git', ['-C', worktreePath, 'hash-object', `--path=${rel}`, '--', rel]);
  return indexed.status === 0 && working.status === 0 && (indexed.stdout as string).trim() === (working.stdout as string).trim();
}

export function approverLayer(launch: Pick<LibLaunchPlan, 'files'>, worktreePath: string, expected: Record<string, unknown> | null = null, verify = true) {
  const layer: Record<string, string | null> = {};
  for (const file of launch.files ?? []) {
    const rel = path.relative(worktreePath, file.path);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    let parent = path.dirname(file.path);
    while (parent !== worktreePath && parent.startsWith(`${worktreePath}${path.sep}`)) {
      try {
        if (lstatSync(parent).isSymbolicLink()) {
          throw new GateError(`approver launch parent ${parent} is a symlink — the lift refuses to write through it`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      parent = path.dirname(parent);
    }
    const current = pathDigest(file.path);
    const former = expected?.[rel] ?? null;
    if (verify && current && current !== former && !holdsTrackedBlob(file, worktreePath)) {
      throw new GateError(`approver launch file ${file.path} already exists and is not the layer this lift wrote — `
        + 'the lift refuses to overwrite or delete it');
    }
    layer[rel] = current;
  }
  return layer;
}

function approverFor(ownerStep: DeclaredStep, taskMeta: Pick<TaskV1, 'participants'>, repoDir: string, clone: Pick<HostClone, 'abs'>, stepName: string = APPROVER) {
  const { slug } = reviewerFor(ownerStep, taskMeta, repoDir, clone);
  return { slug, address: `${stepName}:${slug}` };
}

export function reviewerResultSent(home: string, taskId: string, reviewAddr: string, _reviewer: unknown = null) {
  const facts = strictTaskFacts(home, taskId);
  return !!currentResult(participantOf(facts.task, reviewAddr), facts.messages);
}

function approverRepoMatches(participant: ParticipantV1 | null | undefined, repoDir: string) {
  const recorded = participant?.metadata?.reviewSubject ?? participant?.metadata?.repoAbs;
  return !!recorded && canonical(recorded) === canonical(repoDir);
}

function validateApproverPreconditions(host: PromptobusHost, {
  target, task, harness, stepName = APPROVER,
}: ApproverOptions) {
  const stepKind = roleEntry(registryOf(host), stepName)?.kind;
  if (stepKind !== WRITES_MAIN_TREE) throw new GateError(`step ${stepName} is ${stepKind ?? 'unknown'}, not ${WRITES_MAIN_TREE}`);
  if (!String(target ?? '').trim()) {
    throw new GateError(`${host.commandName} review <path> --approver --task <id>: the repository path is required — `
      + 'there is no resolve from the current directory.');
  }
  const resolved = resolveRepoDir(target!);
  if (resolved.refusal) throw new GateError(resolved.refusal);
  const { repoDir } = resolved as { repoDir: string };
  if (!host.inWorkspace(repoDir)) {
    if (host.inWorkspace(resolved.targetDir!)) {
      throw new GateError(host.reviewLayoutError('not-clone', { targetDir: resolved.targetDir!, repoDir })!);
    }
    throw new GateError(host.reviewLayoutError('outside', { repoDir })!);
  }
  const clone = host.cloneOf(repoDir);
  if (!clone) throw new GateError(host.reviewLayoutError('no-clone', { repoDir })!);
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
  const pipeline = pipelineOf(host);
  const { slug, address } = approverFor(pipeline[0], taskMeta, repoDir, clone, stepName);
  requireStepResults(host, { home, taskId: task, taskMeta, stepName, slug, repoDir });
  const previous = pipeline[pipeline.findIndex((step) => step.name === stepName) - 1];
  const reviewAddr = `${previous.name}:${slug}`;
  const participant = participantOf(taskMeta, address);
  if (participant && !approverRepoMatches(participant, repoDir)) {
    const recorded = participant.metadata?.reviewSubject ?? participant.metadata?.repoAbs;
    throw new GateError(`--approver requires ${address} on this repository — ${address} is recorded at `
      + `${recorded}, not ${repoDir}. A live approver on another subject cannot be reused here.`);
  }
  if (participant && harness && harness !== participant.harness) {
    const seen = participantSession(participant);
    const named = seen === 'alive' ? 'alive' : seen === 'dead' ? 'gone' : 'unknown';
    throw new GateError(`${address} in task ${task} was started by harness ${participant.harness}, and --harness asks for `
      + `${harness}: this command does not change an approver's harness. This call saw the session as ${named}.`);
  }
  return { home, taskMeta, repoDir, clone, slug, address, reviewAddr, participant };
}

function approverDenyTools(host: PromptobusHost, driver: LibDriver, declaredServers: readonly unknown[] = [], stepName: string = APPROVER, repoDir?: string): { tools: readonly DriverDenyTool[]; refusal: string | null } {
  const registry = registryOf(host);
  const builtIn = packageDenyTools(registry, stepName, driver.options?.denyTools ?? []);
  const classified = hostDenyClassification(host, roleEntry(registry, stepName) as DenyEntry, declaredServers, repoDir);
  if (!classified.complete) {
    return {
      tools: builtIn,
      refusal: `harness "${driver.id}" cannot mechanically deny MCP writes for host "${host.commandName}": `
        + `${classified.detail}. `
        + 'Approver lift is not started — the host must return { tools, complete: true } before this harness can lift an approver.',
    };
  }
  if (!hasFeature(coreDriver(driver), 'mcpDenyTools')) return { tools: builtIn, refusal: null };
  return { tools: classified.tools.length ? [...builtIn, ...driver.mcpDenyTools!(classified.tools)] : builtIn, refusal: null };
}

function buildApproverPrompt({
  taskId, nsPath, cwd, cloneRoot, worktreeDir, address, stepName, workerAddress, reviewAddr, branch,
  workerBranch, rules, driver, host, repoSkills, worktreeDeps, mcpBoundary = null, brief = null, instructions = null,
  contacts,
}: ApproverPromptInput) {
  const bus = (name: string) => toolName(driver, PROMPTOBUS_SERVER, name, host);
  const workerNote = worktreeDir
    ? ` The worker tree ${worktreeDir} (${workerBranch ? `branch ${workerBranch}` : 'branch unknown'}) is attached for reading the piece.` : '';
  const publish = host.busCommand(['lease', '--as', address, '--task', taskId, '--key', shellQuote(cloneRoot), '--', 'git', '-C', shellQuote(cloneRoot), 'merge', '--ff-only', shellQuote(branch)]);
  return renderApproverInstructions({ taskId, nsPath, address, stepName, reviewAddr,
    rules, mcpBoundary, brief, instructionsSection: gateInstructionsSection(instructions), bindings: {
      tools: Object.fromEntries(['promptobus_send', 'promptobus_mailbox', 'promptobus_task'].map(name => [name, bus(name)])) as Record<keyof ParticipantTools, string>, repositorySkills: repoSkillsLine(repoSkills), dependencies: worktreeDepsLine(worktreeDeps),
      lease: leaseRule({ host, taskId, address }), memory: memoryRule(driver, host), contacts: contactsSection(contacts, bus('promptobus_task')),
      workspace: `Your session cwd is the approver worktree ${cwd} on branch ${branch}, created from the clone's local main branch. The clone root ${cloneRoot} is attached for the final fast-forward only.${workerNote}`,
      acceptance: `Do the squash, gates, card archive, fold and final acceptance commit in your approver worktree. Once the final commit passes its gate and the clone root is on main, publish with \`${publish}\`. The keyed lease keeps two bus publishers out of the clone's index at the same time; do not nest it inside the machine lease. If that fast-forward refuses because main moved, redo the squash on the new main in this worktree, rerun the gates, and retry. Leave the clone root's files untouched except through that fast-forward.`,
      communication: `${PROMPTOBUS_SERVER} MCP tools (already attached): ${bus('promptobus_send')}, ${bus('promptobus_mailbox')}, ${bus('promptobus_task')}`,
      workerContext: workerAddress ? `Direct messages to ${workerAddress} are allowed in this task.`
        : 'There is no worker address registered for this review subject — route participant traffic through the orchestrator.',
      workerContact: workerAddress ? `You may write directly to ${workerAddress} when the orchestrator's assignment says so.`
        : 'Without a registered worker, write to the orchestrator only.',
      wait: 'end the turn; the warden wakes you when mail arrives.',
    },
  });
}

export function planApprover(rootOrHost: unknown, {
  target, task, model, effort: effortOpt, permissionMode: permissionOpt, harness,
  strategy = undefined, routing = null, instructions: suppliedInstructions = undefined,
  instructionsReuse = undefined,
  dryRun: _dryRun, brief: briefFile, stepName = APPROVER,
  contextPurpose, contextDeclaration, preparedContext,
}: ApproverOptions = {}): ApproverPlan {
  const host = hostOf(rootOrHost);
  const ownerStep = pipelineOf(host)[0];
  const lifter = liftHarness(host, harness);
  const root = realpathSync(host.workspaceRoot());
  const pre = validateApproverPreconditions(host, { target, task, harness, stepName });
  const {
    home, taskMeta, repoDir, clone, slug, address, reviewAddr, participant: existing,
  } = pre;
  const brief = briefFile !== undefined ? readBrief(briefFile) : null;
  const nsPath = clone.nsPath;
  const cloneRoot = clone.abs;
  const owner = worktreeOwner(ownerStep, taskMeta, repoDir);
  const ownerFields = owner?.metadata ?? {};
  const workerAddress = owner ? addressOf(owner) : null;
  const workerBranch = (ownerFields.branch ?? (ownerFields.worktree ? worktreeBranch(ownerFields.worktree as string) : null)) as string | null;
  const worktreeDir = (ownerFields.worktree ?? (repoDir !== cloneRoot ? repoDir : null)) as string | null;
  const participant = existing;
  const contacts = contactsOf(home, task!, address, { registry: registryOf(host), seats: [{
    meta: taskMeta, sender: participant ?? participantRecord(address, {}, registryOf(host)),
  }] });
  const was = participant?.metadata ?? {};
  const selectedContext = prepareNativeContext(host, { root: cloneRoot, role: APPROVER, taskId: task!,
    options: { contextPurpose, contextDeclaration }, participant, preparedSelection: preparedContext });
  assertNativeContextDriver(selectedContext, participant ? driverOf(participant) : lifter);
  const known = was.worktreeName ?? (was.worktree ? path.basename(was.worktree as string) : null);
  const wtName = (known ?? machineName(taskMeta, { slug: `${stepName}-${slug}` })) as string;
  const worktreePath = path.join(cloneRoot, WORKTREE_DIR_REL, wtName);
  const branch = (was.branch ?? `${WORKTREE_BRANCH_PREFIX}${wtName}`) as string;
  if (!known && existsSync(worktreePath)) {
    throw new GateError(`${worktreePath}: the approver worktree directory exists without a record for ${address} — `
      + 'the lift refuses to reuse a directory it did not create');
  }
  const base = host.defaultBranch(cloneRoot);
  if (defaultRefs(cloneRoot, base)[0] !== base) {
    throw new GateError(`the approver needs the clone's local ${base} branch before it can create a worktree`);
  }
  const sessionState = participant ? participantSession(participant) : null;
  const unlaunched = !!was.pending && sessionState !== 'alive';
  const reuse = !!participant && approverRepoMatches(participant, repoDir)
    && sessionState !== 'dead' && !unlaunched;
  const instructions = suppliedInstructions === undefined || (instructionsReuse !== undefined && instructionsReuse !== reuse)
    ? readGateInstructions(host, stepName, reuse ? was.gateInstructions : null) : suppliedInstructions;
  const routed = participant ? null : decideLift(routing, { taskMeta, address });
  const routingSkipped = participant && strategy
    ? `${address} in task ${task} is already in the journal, started by harness ${participant.harness}: `
      + '--strategy routes a lift, and this call would restart an approver whose harness is already fixed. The flag is ignored here.'
    : null;
  const driver = participant ? driverOf(participant) : (routed ? liftHarness(host, routed.harness) : lifter);
  assertNativeContextDriver(selectedContext, driver);
  const effort = resolveEffort(routed ? (routed.effort ?? undefined) : effortOpt, driver);
  const permissionMode = resolvePermissionMode(permissionOpt, driver, driver.options.defaultPermissionMode);
  const rules = contextRules(selectedContext, () => host.collectRules(cloneRoot), cloneRoot, worktreePath);
  const ruleDirs = [...new Set(rules.filter((f) => !f.startsWith(`${worktreePath}${path.sep}`))
    .map((f) => path.dirname(f)))];
  const addDirs = [...new Set([
    cloneRoot,
    ...(worktreeDir ? [worktreeDir] : []),
    ...ruleDirs,
  ].filter(Boolean))];
  const settingsPath = participantSettingsPath(home, task!, address);
  const guardCommand = guardHookCommand(host, { address, taskId: task!, home }, process.platform);
  const pluginDir = !selectedContext && driver.options.skillsDir ? participantPluginDir(host, cloneRoot) : null;
  const mcpConfigPath = participantMcpPath(home, task!, address);
  const mcp = participantMcp(host, { address, taskId: task!, home, repoDir: cloneRoot }, driver);
  const declaredServers = Object.keys(mcp.descriptor.servers ?? {})
    .filter((server) => server !== PROMPTOBUS_SERVER);
  const deny = approverDenyTools(host, driver, declaredServers, stepName, cloneRoot);
  const harnessRefusal = roleHarnessRefusal(driver, APPROVER);
  const resolvedModel = routed?.model ?? model ?? driver.options.defaultModel;
  const taken = (taskMeta.participants ?? []).map((p) => p.metadata.name).filter(Boolean);
  const name = (was.name ?? sessionName(taskMeta, { slug: stepName === APPROVER ? slug : `${stepName}-${slug}`, approver: true, taken, title: ownerFields.title as string | null | undefined })) as string;
  const mcpBoundary = !hasFeature(coreDriver(driver), 'mcpDenyTools') && !deny.refusal
    ? driver.phrases?.mcpBoundary ?? null
    : null;
  const declaredGenerator = repoGenerator(cloneRoot);
  const plannedSkills: RepoSkillsState = declaredGenerator
    ? { kind: declaredGenerator.argv ? 'planned' : 'invalid', ...declaredGenerator }
    : { kind: 'none', argv: null };
  const plannedDeps: WorktreeDepsState = existsSync(worktreePath)
    ? { ran: false, repeat: true }
    : worktreeHasLock(cloneRoot)
      ? { planned: true, command: npmCiCommand() }
      : { ran: false };
  const buildLaunch = (repoSkills: RepoSkillsState = plannedSkills, worktreeDeps: WorktreeDepsState = plannedDeps) => {
    if (selectedContext) {
      prepareNativeContext(host, { root: cloneRoot, role: APPROVER, taskId: task!,
        options: { contextPurpose, contextDeclaration }, participant, preparedSelection: selectedContext });
      contextRules(selectedContext, () => [], cloneRoot, worktreePath, existsSync(worktreePath));
    }
    const prompt = buildApproverPrompt({
      taskId: task!, nsPath, cwd: worktreePath, cloneRoot, worktreeDir, address, stepName, workerAddress,
      reviewAddr, branch, workerBranch, rules, driver, host, repoSkills, worktreeDeps, mcpBoundary, brief, instructions,
      contacts,
    }) + nativeContextPrompt(selectedContext);
    const launch = driver.prepare!({
      ref: name, address, task: task!, home, role: APPROVER, env: liftEnv, mcp: mcp.descriptor,
      executionKind: WRITES_MAIN_TREE,
      prompt, cwd: worktreePath, model: resolvedModel, effort, permissionMode, addDirs,
      pluginDir, mcpConfigPath, settingsPath, guardCommand, denyTools: deny.tools,
      extraSettings: selectedContext ? {} : skillSettings(host, cloneRoot), root, selectedContext,
      readFiles: selectedContext ? [...rules, ...selectedContext.resources.map(resource => resource.path)] : undefined,
      readSkillDirs: selectedContext ? selectedContext.skills.map(skill => skill.root) : undefined,
      skillsRoot: selectedContext ? null : participantSkillsRoot(host, cloneRoot),
    });
    launch.prompt = prompt;
    return { prompt, launch };
  };
  const liftEnv = sessionEnv(driver, process.env, host);
  const { prompt, launch } = buildLaunch();
  driver.refuseForeignProjectLayer?.(cloneRoot, worktreePath, null, guardCommand);
  return {
    home, taskId: task!, slug, stepName, address, reviewAddr, name, nsPath, repoDir, cloneRoot, worktreeDir, selectedContext,
    worktreePath, wtName, branch, base, brief, instructions,
    briefStem: `brief-${stepName}-${slug}`,
    workerAddress, workerBranch, owner, participant, sessionState, unlaunched, reuse, rules, ruleDirs, addDirs, prompt,
    module: host.moduleNote(cloneRoot), pluginDir,
    settingsPath, guardCommand, mcpConfigPath, mcpNote: mcpNote(mcp, 'the approver'),
    launch, argv: launch.argv, mcpConfig: launch.mcpConfig, settings: launch.settings,
    model: resolvedModel, effort, permissionMode, driver,
    refusal: harnessRefusal ?? deny.refusal,
    routing: routed?.metadata ?? null, decision: routed?.decision ?? null, routingSkipped,
    env: liftEnv, repoSkills: plannedSkills, worktreeDeps: plannedDeps, rebuild: buildLaunch,
    host,
  };
}

function sayApproverHome(plan: ApproverPlan) {
  info(`approver cwd: ${plan.worktreePath} (branch ${plan.branch}, from ${plan.base})`);
  if (plan.worktreeDir && plan.cloneRoot !== plan.worktreeDir) {
    info(`worker tree ${plan.worktreeDir} is attached for reading the piece`);
  }
  info(`clone root ${plan.cloneRoot} is attached for fast-forward publication only`);
}

function keptNote(plan: ApproverPlan) {
  return ` Task ${plan.taskId} and the participant record ${plan.address} are in place.`;
}

function launchFailureNote(plan: ApproverPlan) {
  return `${keptNote(plan)} The approver was not started; the task stays active.`;
}

function deadSessionNote(plan: ApproverPlan) {
  const repeat = plan.stepName === APPROVER
    ? ['review', `"${plan.repoDir}"`, `--task ${plan.taskId}`, '--approver']
    : ['step', plan.stepName, `"${plan.repoDir}"`, `--task ${plan.taskId}`];
  return `${keptNote(plan)} Start the approver again: ${plan.host.busCommand(repeat)}.`
    + ' There will be no messages from this address — waiting for them is pointless.';
}

function unboundSessionNote(plan: ApproverPlan) {
  const repeat = plan.stepName === APPROVER
    ? ['review', `"${plan.repoDir}"`, `--task ${plan.taskId}`, '--approver']
    : ['step', plan.stepName, `"${plan.repoDir}"`, `--task ${plan.taskId}`];
  return `${keptNote(plan)} Stop it — its record is the only handle: ${plan.host.busCommand(['stop', plan.address, `--task ${plan.taskId}`])},`
    + ` then start the approver again: ${plan.host.busCommand(repeat)}.`;
}

export async function approverLift(rootOrHost: unknown, opts: ApproverOptions): Promise<ApproverPlan> {
  const host = hostOf(rootOrHost);
  const pre = validateApproverPreconditions(host, opts);
  const participant = pre.participant;
  const preparedContext = prepareNativeContext(host, { root: pre.clone.abs, role: APPROVER,
    taskId: opts.task!, options: opts, participant });
  assertNativeContextDriver(preparedContext, participant ? driverOf(participant) : liftHarness(host, opts.harness));
  const state = participant ? participantSession(participant) : null;
  const reuse = !!participant && approverRepoMatches(participant, pre.repoDir)
    && state !== 'dead' && !(participant.metadata?.pending && state !== 'alive');
  const instructions = readGateInstructions(host, opts.stepName ?? APPROVER,
    reuse ? participant.metadata?.gateInstructions : null);
  const wanted = effectiveStrategy(host, { strategy: opts?.strategy });
  const routing = !wanted ? null : await (async () => {
    if (participant && approverRepoMatches(participant, pre.repoDir)) return null;
    return routingContext(host, {
      role: opts.stepName ?? APPROVER,
      strategy: wanted.strategy,
      strategySource: wanted.source === 'flag' ? null : wanted.source,
      harness: opts.harness,
      model: opts.model,
      effort: opts.effort,
      allowPayg: opts.allowPayg,
      refresh: opts.refresh,
      dryRun: opts.dryRun,
      adapterFor: opts.adapterFor,
      liftUnrated: true,
    });
  })();
  const plan = planApprover(host, { ...opts, routing, instructions, instructionsReuse: reuse, preparedContext });
  if (plan.brief && plan.reuse) {
    warn(`--brief is not delivered to ${plan.address}: that approver is already on the bus, and the assignment is handed over at lift. A message to the address still reaches it.`);
  }
  if (plan.routingSkipped) warn(plan.routingSkipped);
  if (plan.routing) info(routingLine(plan.routing));
  if (plan.refusal && !plan.reuse) fail(plan.refusal);
  else if (plan.refusal) warn(`${plan.refusal} The running approver keeps the deny list it was launched with.`);

  let toolCache: ReturnType<typeof withToolVersion> | null = null;
  let liftProvenance: ReturnType<typeof launchProvenance> | null = null;
  const harnessTool = () => (toolCache ??= withToolVersion(
    plan.driver, plan.host, normalizeLaunchTool(
      plan.driver, opts.tool ?? plan.host.resolveToolBin(plan.driver.options.tool), plan.env,
    ),
  ));

  if (opts.dryRun) {
    info(`repository: ${plan.nsPath} → clone ${plan.cloneRoot}${plan.worktreeDir ? ` · worker tree ${plan.worktreeDir}` : ''}`);
    info(`task: ${plan.taskId}`);
    info(`approver address: ${plan.address} · preceding result on record at ${plan.reviewAddr} · session: "${plan.name}"`
      + ` · model: ${plan.model}${plan.effort ? ` · effort: ${plan.effort}` : ''}`);
    if (plan.decision) sayDecision(plan.decision);
    if (plan.workerBranch) info(branchLine(plan.workerBranch, worktreeBranch(plan.worktreeDir)));
    sayApproverHome(plan);
    info(`repository skills: ${plan.repoSkills.argv?.join(' ') ?? 'no generator declared'}`);
    if (plan.worktreeDeps.planned) info(`worktree dependencies: ${plan.worktreeDeps.command}`);
    info(`approver rules:`);
    for (const f of plan.rules) console.log(`  ${f}`);
    sayModule(plan);
    info(`approver MCP (${(plan.mcpConfig as { mcpServers?: unknown }).mcpServers ? Object.keys((plan.mcpConfig as { mcpServers: object }).mcpServers).length : 0}):`);
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
  if (!tool.ok) fail(tool.reason!);
  const refusal = optionRefusal(plan.driver, plan.effort, tool, plan.host);
  if (refusal) fail(refusal);
  plan.driver.refuseForeignProjectLayer?.(plan.cloneRoot, plan.worktreePath, tool, plan.guardCommand);
  if (liftProvenance === null) {
    const t = harnessTool();
    liftProvenance = launchProvenance(plan.host, t);
    info(provenanceLine(liftProvenance));
  }

  info(`approver address: ${plan.address} · preceding result on record at ${plan.reviewAddr}`);
  sayModule(plan);
  sayMcp(plan);
  sayApproverHome(plan);
  info(`workspace skills: ${skillsNote(plan)}`);
  info(`approver rules:`);
  for (const f of plan.rules) console.log(`  ${f}`);

  bindIfOwner(plan.home, plan.taskId);
  const nativeLift = plan.driver.id === 'codex';
  const priorLayer = (plan.participant?.metadata?.launchLayer ?? null) as Record<string, unknown> | null;
  let baseSha = plan.participant?.metadata?.baseSha ?? null;
  const reserve = () => reserveNativeParticipant(plan.home, plan.taskId, participantRecord(plan.address, {
    ...nativeContextMetadata(plan.selectedContext),
    harness: plan.driver.id,
    repo: plan.nsPath,
    repoAbs: plan.cloneRoot,
    reviewSubject: plan.repoDir,
    worktree: plan.worktreePath,
    worktreeName: plan.wtName,
    branch: plan.branch,
    baseSha,
    ...(priorLayer ? { launchLayer: priorLayer } : {}),
    model: plan.model,
    ...(plan.effort ? { effort: plan.effort } : {}),
    ...(plan.routing ? { [ROUTING_FIELD]: plan.routing } : {}),
    name: plan.name,
    sessionRef: plan.name,
    session: null,
    started: new Date().toISOString(),
    ...(plan.instructions ? { gateInstructions: plan.instructions } : {}),
    pending: true,
    mechanismPath: liftProvenance!.mechanismPath,
    mechanismPathIssue: liftProvenance!.mechanismPathIssue,
    mechanismVersion: plan.host.version,
    packagePath: liftProvenance!.packagePath,
    packageVersion: liftProvenance!.packageVersion,
    packageIssue: liftProvenance!.packageIssue,
    hostVersion: liftProvenance!.hostVersion,
    binaryPath: liftProvenance!.binaryPath,
    binaryVersion: liftProvenance!.binaryVersion,
  }, registryOf(plan.host)), plan.participant, REGISTRY);
  const reserved = nativeLift ? reserve() : null;
  let record: ParticipantV1;
  try {
    const excluded = excludeWorktrees(plan.cloneRoot);
    if (excluded.status === 'failed') warn(`approver worktrees not excluded from clone status: ${excluded.error}`);
    let fresh = false;
    if (!existsSync(plan.worktreePath)) {
      const made = createWorktree(plan.cloneRoot, plan.worktreePath, plan.branch, plan.base);
      if (!made.created) {
        const reason = `git worktree add: ${made.error} — the approver has nowhere to work`;
        if (nativeLift) throw new GateError(reason);
        fail(reason);
      }
      fresh = true;
      baseSha = made.baseSha ?? baseSha;
      ok(`approver worktree ${plan.wtName} created from ${plan.base} (branch ${plan.branch})`);
    }
    if (!plan.reuse) clearThroughputSidecar(plan.home, plan.taskId, plan.address);
    ({ record } = reserved ?? reserve());
    if (nativeLift && baseSha) persistNativeParticipant(plan.home, plan.taskId, record, { baseSha });

    const worktreeDeps: WorktreeDepsState = fresh && worktreeHasLock(plan.worktreePath)
      ? installWorktreeDeps(plan.worktreePath)
      : { ran: false, repeat: !fresh };
    sayWorktreeDeps(worktreeDeps);
    const repoSkills = runRepoGenerator({ worktreePath: plan.worktreePath }, {
      fresh, depsRefused: worktreeDeps.ran === true && !worktreeDeps.ok,
    });
    sayRepoSkills(repoSkills);
    const rebuilt = plan.rebuild(repoSkills, worktreeDeps);
    plan.prompt = rebuilt.prompt;
    plan.launch = rebuilt.launch;
    if (nativeLift) plan.launch.launchId = record.metadata.nativeLaunchId as string;
    plan.argv = rebuilt.launch.argv;
    plan.mcpConfig = rebuilt.launch.mcpConfig;
    plan.settings = rebuilt.launch.settings;
    plan.repoSkills = repoSkills;
    plan.worktreeDeps = worktreeDeps;
    plan.driver.refuseForeignProjectLayer?.(plan.worktreePath, plan.worktreePath, null, plan.guardCommand);
    approverLayer(plan.launch, plan.worktreePath, priorLayer);
    writeLaunchFiles(plan.launch.files, plan.driver.options.launchDirs);
    record = {
      ...record,
      metadata: {
        ...record.metadata,
        launchLayer: approverLayer(plan.launch, plan.worktreePath, null, false),
      },
    };
    if (nativeLift) persistNativeParticipant(plan.home, plan.taskId, record, {
      baseSha, launchLayer: record.metadata.launchLayer,
    });
    else persistLegacyParticipant(plan.home, plan.taskId, record);
  } catch (error) {
    try { if (reserved) releaseNativeReservation(plan.home, plan.taskId, reserved.record); }
    catch (releaseError) { warn('native reservation release refused: ' + (releaseError as Error).message); }
    throw error;
  }

  const { output, session, seen } = await plan.driver.spawn!(plan.launch, {
    tool: tool as LibToolBin & { bin: string },
    home: plan.home,
    host: plan.host,
    task: plan.taskId,
    address: plan.address,
    cwd: plan.worktreePath,
    env: plan.env,
    ref: plan.name,
    role: APPROVER,
    launchFailNote: launchFailureNote(plan),
    deadNote: deadSessionNote(plan),
    unboundNote: unboundSessionNote(plan),
    persist: (id, state, sessionId) => {
      if (nativeLift) return persistNativeParticipant(plan.home, plan.taskId, record, {
        session: id ?? null, ...(sessionId ? { sessionId } : {}), pending: state === 'dead',
      });
      const { pending, ...rest } = record.metadata;
      const sessionRecord = participantOf(readTask(plan.home, plan.taskId), plan.address)?.metadata?.sessionRecord;
      return persistLegacyParticipant(plan.home, plan.taskId, {
        ...record,
        metadata: {
          ...rest,
          session: id ?? null,
          ...(sessionId ? { sessionId } : {}),
          ...(sessionRecord ? { sessionRecord } : {}),
          ...(state === 'dead' ? { pending: true } : {}),
        },
      });
    },
    awaitOptions: opts.awaitOptions,
  });
  ok(`approver ${plan.address} started in ${plan.nsPath}${session ? ` (session ${session})` : ''}`);
  ensureWarden(plan.home, plan.taskId, { host: plan.host });
  if (plan.brief) keepBrief(plan as ApproverPlan & { brief: string });
  plan.driver.saidLiftoff!({ name: plan.name, seen, session, output });
  warnUnread(plan);
  return plan;
}

function warnUnread(plan: ApproverPlan) {
  const note = unreadNote(plan.home, plan.taskId, ORCHESTRATOR, sessionIdentity());
  if (note) warn(note);
}

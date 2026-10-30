import { renderReporterInstructions } from './prompts/roles.js';
import path from 'node:path';
import { assertNativeContextDriver, contextRules, nativeContextMetadata, nativeContextPrompt, prepareNativeContext } from './native-participant-context.js';
import { randomUUID } from 'node:crypto';
import { GateError, registryOf, REVIEWER, ROUTING_FIELD } from '../dist/index.js';
import { persistNativeParticipant, releaseNativeReservation, reserveNativeParticipant } from './native-lifecycle.js';
import { REGISTRY, REPORTER_DENY } from './drivers.js';
import { hostOf } from './host.js';
import { info, ok, fail, shellQuote, warn } from './util.js';
import {
  canonicalPath, contactsOf, participantMcpPath, participantOf, participantRecord, participantSettingsPath,
  pidAlive, readTask, upsertParticipant, withTaskLock,
} from './store.js';
import { forgetSessions, snapshotOf } from './drivers.js';
import { run } from './exec.js';
import {
  contactsSection, dryRunToolNote, guardHookNote, liftHarness, mcpNote, mcpServerLines, normalizeLaunchTool,
  optionRefusal, participantMcp, participantPluginDir, PROMPTOBUS_SERVER, resolveEffort,
  resolvePermissionMode, sayMcp, sayTool, sessionEnv, sessionEnvNote, shortTitle,
  skillSettings, skillsNote, toolName, withToolVersion, writeLaunchFiles,
} from './spawn.js';
import { reviewerDenyTools } from './review.js';
import { guardHookCommand } from '../dist/hooks.js';
import { routeLift, routingLine, sayDecision } from './models.js';
import { loadCatalog } from './model-routing/catalog.js';
import { participantSession, unknownWhy } from './status.js';
import { launchProvenance, provenanceLine } from './provenance.js';
import { ensureWarden, handOverContactPoints } from './warden.js';

import type { DriverDenyTool, ParticipantV1, PromptobusHost, SessionSnapshot, TaskV1 } from '../dist/index.js';
import type { LibDriver, LibLaunchPlan, LibSpawnContext } from './driver-runtime.js';
import type { SpawnOptions } from './spawn.js';

type ReportOptions = SpawnOptions;
interface ReporterPromptPlan {
  host: PromptobusHost; home: string; task: string; root: string; rules: string[]; driver: LibDriver;
  contacts: ReturnType<typeof contactsOf>;
}

type ReportRouting = NonNullable<Awaited<ReturnType<typeof routeLift>>>;
interface ReportPlan extends ReporterPromptPlan {
  meta: TaskV1; former: ParticipantV1 | null; formerSessions: SessionSnapshot; name: string; model: string;
  effort: ReturnType<typeof resolveEffort>; permissionMode: ReturnType<typeof resolvePermissionMode>;
  addDirs: string[]; selectedContext: ReturnType<typeof prepareNativeContext>;
  mcpConfigPath: string; settingsPath: string; guardCommand: string; env: NodeJS.ProcessEnv;
  denyTools: DriverDenyTool[]; pluginDir: string | null; mcpNote: ReturnType<typeof mcpNote>;
  routing: ReportRouting['metadata'] | null; decision: ReportRouting['decision'] | null;
  routingSkipped: string | null; prompt: string; launch: LibLaunchPlan;
}

export { reportQuestion } from './report-channel.js';

const REPORTER = 'reporter';
const CURSOR_REFUSAL = 'A Cursor reporter at the install root is refused: '
  + 'ADR-024 found that Cursor reads the project layer from the selected cwd, '
  + 'where placing it would mutate the shared tree.';

function requireFreeReporter(former: ParticipantV1 | null, sessions: SessionSnapshot, driver: LibDriver, task: string) {
  if (!former) return;
  const pid = former.metadata?.launchPid;
  const unlaunched = typeof former.metadata?.nativeLaunchId === 'string' && former.metadata.nativeLaunchId
    && former.metadata.nativeUnlaunched === former.metadata.nativeLaunchId;
  if (former.metadata?.pending && !unlaunched && pidAlive(pid as number)) {
    throw new GateError(`reporter launch of task ${task} is already in progress (pid ${pid}); retry after it finishes`);
  }
  const state = participantSession(former, sessions);
  if (state !== 'dead') {
    const why = state === 'unknown' ? ` (${unknownWhy(former, sessions, driver)})` : '';
    throw new GateError(`reporter of task ${task} is already ${state}${why}; stop it before relifting`);
  }
}

function reporterPrompt(plan: ReporterPromptPlan) {
  const bus = (name: string) => toolName(plan.driver, PROMPTOBUS_SERVER, name, plan.host);
  return renderReporterInstructions({ task: plan.task, root: plan.root, rules: plan.rules, bindings: {
    tools: Object.fromEntries(['promptobus_send', 'promptobus_task', 'promptobus_digest', 'promptobus_status', 'promptobus_ask'].map(name => [name, bus(name)])) as Parameters<typeof renderReporterInstructions>[0]['bindings']['tools'],
    contacts: contactsSection(plan.contacts, bus('promptobus_task')),
    journalSources: `The root task journal and its child journals under ${plan.home}/tasks are your sources.`,
    digestView: 'the same root-tree page as digest --json', journalBody: 'a journal message file',
    answerChannel: plan.driver.id === 'codex' ? 'through the report question channel on this same thread' : 'in this window',
    fileBoundary: plan.driver.id === 'codex' ? 'File writes, builds and tests are forbidden. Read journal files with read-only shell commands.' : 'Bash and file writes are denied.',
  } });
}

export async function planReport(rootOrHost: unknown, opts: ReportOptions = {}): Promise<ReportPlan> {
  const host = hostOf(rootOrHost);
  const home = canonicalPath(host.promptobusHome());
  const task = opts.task;
  if (!task) throw new GateError('report needs --task <root>');
  const meta = readTask(home, task);
  if (meta.parent) throw new GateError(`report needs a root task; ${task} is a child of ${meta.parent}`);
  if (meta.status !== 'active') throw new GateError(`task ${task} is closed — there is nobody for the reporter to ask`);
  if (opts.harness && !['claude', 'codex'].includes(opts.harness)) throw new GateError(`--harness ${opts.harness}: ${CURSOR_REFUSAL}`);
  let modelHarness = null;
  if (opts.model) {
    const matches = (loadCatalog({ host }).tuples ?? []).filter((tuple) => tuple.model === opts.model);
    if (matches.length && !matches.some((tuple) => ['claude', 'codex'].includes(tuple.harness))) {
      throw new GateError(`--model ${opts.model} resolves only to Cursor. ${CURSOR_REFUSAL}`);
    }
    if (matches.some((tuple) => tuple.harness === 'codex') && !matches.some((tuple) => tuple.harness === 'claude')) modelHarness = 'codex';
  }
  const former = participantOf(meta, REPORTER);
  const requestedHarness = opts.harness ?? modelHarness ?? former?.harness ?? null;
  if (former && requestedHarness && former.harness !== requestedHarness) {
    throw new GateError(`reporter was lifted by harness ${former.harness}; a relift cannot change its harness to ${requestedHarness}`);
  }
  if (former && opts.sessions === undefined) forgetSessions();
  const sessions = former ? (opts.sessions === undefined ? snapshotOf([former]) : opts.sessions) : null;
  if (former) requireFreeReporter(former, sessions, liftHarness(host, former.harness), task);
  const routingHost: PromptobusHost = Object.create(host);
  const root = canonicalPath(host.workspaceRoot());
  const selectedContext = prepareNativeContext(host, { root, role: REPORTER, taskId: task, options: opts, participant: former });
  if (requestedHarness) assertNativeContextDriver(selectedContext, liftHarness(host, requestedHarness));
  routingHost.declaredTools = () => host.declaredTools().filter((harness) => harness !== 'cursor');
  const routed = former ? null : await routeLift(routingHost, {
    role: REVIEWER, strategy: opts.strategy, harness: requestedHarness, model: opts.model, effort: opts.effort,
    allowPayg: opts.allowPayg, refresh: opts.refresh, dryRun: opts.dryRun,
    taskMeta: meta, address: REPORTER, adapterFor: opts.adapterFor,
  });
  const driver = liftHarness(host, routed?.harness ?? requestedHarness ?? 'claude');
  assertNativeContextDriver(selectedContext, driver);
  const model = (opts.model ?? former?.metadata?.model ?? routed?.model ?? driver.options.defaultModel) as string;
  const effort = resolveEffort((opts.effort ?? former?.metadata?.effort ?? routed?.effort) as string | null | undefined, driver);
  const permissionMode = resolvePermissionMode(driver.id === 'codex' ? 'read-only' : opts.permissionMode, driver, null);
  const name = `Reporter: ${shortTitle(meta.title) || meta.adapter?.slug || 'task'} (${task})`;
  const rules = contextRules(selectedContext, () => host.collectRules(root));
  const ruleDirs = [...new Set(rules.filter((file) => !file.startsWith(root + path.sep)).map(path.dirname))];
  const addDirs = [...new Set([...ruleDirs, home])];
  const mcpConfigPath = participantMcpPath(home, task, REPORTER);
  const settingsPath = participantSettingsPath(home, task, REPORTER);
  const guardCommand = guardHookCommand(host, { address: REPORTER, taskId: task, home }, process.platform);
  const env = sessionEnv(driver, process.env, host);
  const mcp = participantMcp(host, { address: REPORTER, taskId: task, home }, driver);
  const declaredServers = Object.keys(mcp.descriptor.servers ?? {})
    .filter((server) => server !== PROMPTOBUS_SERVER);
  const deny = reviewerDenyTools(host, driver, declaredServers);
  if (deny.refusal) throw new GateError(deny.refusal);
  const denyTools = [...deny.tools, REPORTER_DENY.at(-1)!];
  const plan = {
    host, home, root, task, meta, former, formerSessions: sessions, driver, name, model, effort,
    permissionMode, rules, addDirs, selectedContext,
    mcpConfigPath, settingsPath, guardCommand, env, denyTools,
    pluginDir: selectedContext ? null : participantPluginDir(host), mcpNote: mcpNote(mcp, 'reporter'),
    routing: routed?.metadata ?? null, decision: routed?.decision ?? null,
    routingSkipped: former && opts.strategy ? 'reporter: --strategy is ignored on a relift' : null,
    contacts: contactsOf(home, task, REPORTER, { registry: registryOf(host), seats: [{
      meta, sender: former ?? participantRecord(REPORTER, {}, registryOf(host)),
    }] }),
  };
  const prompt = reporterPrompt(plan) + nativeContextPrompt(selectedContext);
  const launch = driver.prepare!({
    ref: name, role: REPORTER, mcp: mcp.descriptor, prompt, model, effort, permissionMode,
    addDirs, pluginDir: plan.pluginDir, mcpConfigPath, settingsPath, guardCommand, denyTools,
    extraSettings: selectedContext ? {} : skillSettings(host), selectedContext,
    skillsRoot: selectedContext ? null : root,
    readFiles: selectedContext ? [...rules, ...selectedContext.resources.map(resource => resource.path)] : undefined,
    readSkillDirs: selectedContext ? selectedContext.skills.map(skill => skill.root) : undefined,
    cwd: root, root, task, address: REPORTER, env,
  });
  return { ...plan, prompt, launch };
}

export async function report(rootOrHost: unknown, opts: ReportOptions = {}): Promise<ReportPlan> {
  const plan = await planReport(rootOrHost, opts);
  if (plan.routingSkipped) warn(plan.routingSkipped);
  if (plan.routing) info(routingLine(plan.routing));
  if (opts.dryRun) {
    info(`root task: ${plan.task} · reporter address: ${REPORTER} · session: "${plan.name}"`);
    info(`install root: ${plan.root} · harness: ${plan.driver.id} · model: ${plan.model}`
      + (plan.effort ? ` · effort: ${plan.effort}` : ''));
    if (plan.decision) sayDecision(plan.decision);
    info(`mcp-config: ${plan.mcpConfigPath} · default task ${plan.task}`);
    for (const line of mcpServerLines(plan.launch.mcpConfig)) info(`  ${line}`);
    info(`deny tools: ${plan.denyTools.map((entry) => typeof entry === 'string' ? entry : `${entry.server}/${entry.tool}`).join(', ')}`);
    info(`workspace skills: ${skillsNote(plan)}`);
    info(guardHookNote(plan));
    info(sessionEnvNote(plan.driver, plan.host));
    info(dryRunToolNote(plan.driver));
    info('command:');
    console.log(`  cd ${shellQuote(plan.root)} && ${plan.launch.dryRunCommand ?? `claude ${plan.launch.argv.slice(0, -1).map(shellQuote).join(' ')} <prompt>`}`);
    info('prompt:');
    console.log(plan.prompt);
    ok('dry-run: nothing written to disk, reporter not started');
    return plan;
  }
  const rawTool = opts.tool ?? plan.host.resolveToolBin(plan.driver.options.tool);
  const tool = withToolVersion(plan.driver, plan.host, normalizeLaunchTool(plan.driver, rawTool, plan.env));
  sayTool(tool, { reason: false });
  if (!tool.ok) fail(tool.reason);
  const refused = optionRefusal(plan.driver, plan.effort, tool, plan.host);
  if (refused) fail(refused);
  const provenance = launchProvenance(plan.host, tool);
  info(provenanceLine(provenance));
  sayMcp(plan);
  const launchToken = randomUUID();
  let record: ParticipantV1;
  withTaskLock(plan.home, plan.task, () => {
    const currentMeta = readTask(plan.home, plan.task);
    if (currentMeta.parent || currentMeta.status !== 'active') {
      throw new GateError(`task ${plan.task} changed while planning the reporter; retry report`);
    }
    const current = participantOf(currentMeta, REPORTER);
    if (JSON.stringify(current) !== JSON.stringify(plan.former)) {
      throw new GateError(`reporter of task ${plan.task} changed while planning; retry report`);
    }
    requireFreeReporter(current, plan.formerSessions, plan.driver, plan.task);
    ({ record } = reserveNativeParticipant(plan.home, plan.task, participantRecord(REPORTER, {
      ...nativeContextMetadata(plan.selectedContext),
      harness: plan.driver.id, mode: 'managed', name: plan.name, sessionRef: plan.name,
      session: null, model: plan.model, ...(plan.effort ? { effort: plan.effort } : {}),
      ...(plan.routing ? { [ROUTING_FIELD]: plan.routing } : {}),
      started: new Date().toISOString(), pending: true, launchPid: process.pid, launchToken,
      mechanismPath: provenance.mechanismPath, mechanismPathIssue: provenance.mechanismPathIssue,
      mechanismVersion: plan.host.version, packagePath: provenance.packagePath,
      packageVersion: provenance.packageVersion, packageIssue: provenance.packageIssue,
      hostVersion: provenance.hostVersion, binaryPath: provenance.binaryPath,
      binaryVersion: provenance.binaryVersion,
    }, registryOf(plan.host)), current, REGISTRY));
  });
  if (plan.driver.id === 'codex') plan.launch.launchId = record!.metadata.nativeLaunchId as string;
  try { writeLaunchFiles(plan.launch.files, plan.driver.options.launchDirs); }
  catch (error) {
    try { releaseNativeReservation(plan.home, plan.task, record!); }
    catch (releaseError) { warn('native reservation release refused: ' + (releaseError as Error).message); }
    throw error;
  }
  let lostSession: string | null = null;
  let launched: Awaited<ReturnType<NonNullable<LibDriver['spawn']>>>;
  try {
    launched = await plan.driver.spawn!(plan.launch, {
      tool: tool as LibSpawnContext['tool'], host: plan.host, home: plan.home, task: plan.task, address: REPORTER,
      cwd: plan.root, env: plan.env, ref: plan.name, role: REPORTER, noun: 'reporter',
      launchFailNote: ` Reporter record kept in task ${plan.task}; retry report --task ${plan.task}.`,
      deadNote: ` Retry report --task ${plan.task}.`,
      unboundNote: ` The launched session may be orphaned; inspect ${plan.driver.phrases.sessions} before retrying report --task ${plan.task}.`,
      awaitOptions: opts.awaitOptions,
      requireLaunchMatch: true,
      persist: (id, state, full) => withTaskLock(plan.home, plan.task, () => {
        const current = participantOf(readTask(plan.home, plan.task), REPORTER);
        if (plan.driver.id === 'codex') return persistNativeParticipant(plan.home, plan.task, record, {
          session: id ?? null, ...(full ? { sessionId: full } : {}),
          pending: state === 'dead' ? true : undefined, launchPid: undefined, launchToken: undefined,
        });
        if (current?.metadata?.launchToken !== launchToken) {
          lostSession = id ?? null;
          throw new GateError(`reporter reservation of task ${plan.task} changed during launch; refusing this session`);
        }
        const metadata = { ...record.metadata };
        delete metadata.pending;
        delete metadata.launchPid;
        delete metadata.launchToken;
        return upsertParticipant(plan.home, plan.task, {
          ...record,
          metadata: {
            ...metadata, session: id ?? null, ...(full ? { sessionId: full } : {}),
            ...(current.metadata?.sessionRecord ? { sessionRecord: current.metadata.sessionRecord } : {}),
            ...(state === 'dead' ? { pending: true } : {}),
          },
        });
      }),
    });
  } catch (error) {
    if (lostSession) {
      if (plan.driver.id === 'codex') {
        const stopped = await plan.driver.stop!(plan.name);
        if (!stopped.ok) throw new GateError(`${(error as Error).message}; Codex stop ${lostSession} failed: ${stopped.note}`);
      } else {
        const stopped = run(tool.bin!, ['stop', lostSession], { cwd: plan.root, env: plan.env, encoding: 'utf8' });
        if (stopped.error || stopped.status !== 0) {
          throw new GateError(`${(error as Error).message}; claude stop ${lostSession} failed: ${stopped.error?.message ?? stopped.stderr ?? stopped.status}`);
        }
      }
    }
    throw error;
  }
  const { output, session, seen } = launched;
  handOverContactPoints(plan.home, { env: process.env });
  ensureWarden(plan.home, plan.task, { host: plan.host });
  ok(`reporter lifted for root task ${plan.task}${session ? ` (session ${session})` : ''}`);
  plan.driver.saidLiftoff!({ name: plan.name, seen, session, output });
  if (plan.driver.id === 'codex') info(`Ask this reporter: ${plan.host.busCommand(['report', '--task', plan.task, '--question', shellQuote('What changed?')])}`);
  return plan;
}

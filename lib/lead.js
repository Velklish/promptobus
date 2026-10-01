import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { hostOf } from './host.js';
import { info, ok } from './util.js';
import {
  bus, filesDir, GateError, inboxDir, newTaskIdentity, ORCHESTRATOR,
  participantOf, participantRecord,
  slugify, taskExists, upsertParticipant, withTaskLock,
} from './store.js';
import {
  liftHarness, mcpNote, normalizeLaunchTool, optionRefusal, participantMcp,
  readBrief, resolveEffort, resolvePermissionMode, sayMcp, sessionEnv,
  shortTitle, skillsNote, toolName, withToolVersion,
} from './spawn.js';
import { routeLift, routingLine } from './models.js';
import { launchProvenance, provenanceLine } from './provenance.js';
import { ensureWarden } from './warden.js';
import { withDirLockAsync } from '../dist/fs/lock.js';
import { ownerOf, registryOf, requireTaskId, sessionRefOf, WORKER } from '../dist/index.js';

function resumeOwner(host, task, driver, env) {
  const home = host.promptobusHome();
  const meta = bus(home, { cli: host.version }).readTask(task);
  const owner = participantOf(meta, ORCHESTRATOR);
  const ref = sessionRefOf(owner);
  const threadId = ownerOf(owner);
  if (meta.status !== 'active' || meta.parent || owner?.harness !== 'codex' || owner?.mode !== 'managed' || !ref || !threadId) {
    throw new GateError(`task ${task} has no matching active managed Codex root owner to resume`);
  }
  const record = driver.resumeState(ref, {
    home, cwd: host.workspaceRoot(), task, address: ORCHESTRATOR,
    threadId, launcherPid: owner.metadata?.launcherPid, env,
  });
  return { meta, owner, record };
}

/** A new root owner uses the same holder and private-home protocol as a teamlead. */
export async function planLead(rootOrHost, opts = {}) {
  const host = hostOf(rootOrHost);
  if (opts.harness && opts.harness !== 'codex') {
    throw new GateError('managed root lead supports only Codex; another harness can own a task from its existing session');
  }
  if (opts.task !== undefined) requireTaskId(opts.task);
  if (opts.resume && !opts.task) throw new GateError('lead --resume requires --task <existing-id>');
  const driver = liftHarness(host, 'codex');
  const env = sessionEnv(driver, process.env, host);
  const resumed = opts.resume ? resumeOwner(host, opts.task, driver, env) : null;
  const brief = resumed && !opts.brief
    ? 'Continue the previous assignment and its approval boundaries from this same thread. Read the mailbox and answer pending questions before continuing.'
    : readBrief(opts.brief);
  const title = resumed?.meta.title ?? opts.title ?? brief.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean);
  const slug = resumed?.meta.adapter?.slug ?? slugify(title);
  const task = opts.task ?? newTaskIdentity(slug).id;
  const home = host.promptobusHome();
  if (!resumed && taskExists(home, task)) {
    throw new GateError(`task ${task} already exists; lead opens a new root and cannot replace its mailbox owner`);
  }
  const routed = await routeLift(host, {
    role: WORKER, harness: 'codex', model: opts.model ?? resumed?.owner.metadata?.model,
    effort: opts.effort ?? resumed?.owner.metadata?.effort,
    strategy: opts.strategy, allowPayg: opts.allowPayg, refresh: opts.refresh,
    dryRun: opts.dryRun, address: ORCHESTRATOR, adapterFor: opts.adapterFor,
  });
  const model = opts.model ?? resumed?.owner.metadata?.model ?? routed?.model ?? driver.options.defaultModel;
  const effort = resolveEffort(opts.effort ?? resumed?.owner.metadata?.effort ?? routed?.effort, driver);
  const requestedPermission = opts.permissionMode ?? resumed?.record.sandbox;
  const permissionMode = ['full-access', 'danger-full-access'].includes(requestedPermission)
    ? 'full-access' : resolvePermissionMode(requestedPermission, driver);
  const root = host.workspaceRoot();
  const rules = host.collectRules(root);
  const addDirs = [...new Set(rules.filter((file) => !file.startsWith(root + path.sep)).map(path.dirname))];
  const mcp = participantMcp(host, { address: ORCHESTRATOR, taskId: task, home }, driver);
  const call = (name) => toolName(driver, 'promptobus', name, host);
  const prompt = `You are the Codex root orchestrator of task ${task}. Your mailbox address is orchestrator.
Your working directory is ${root}. You coordinate workers, independent reviewers and approvers through Promptobus. The assignment below defines your authorized scope; follow its approval boundaries.
Read the workspace rules before doing work, list their paths in your first reply, and use the workspace orchestration skill when splitting implementation into workers.
${rules.map((file) => `- ${file}`).join('\n')}

## Assignment
${brief}

## Mailbox and delivery
Read ${call('promptobus_mailbox')} at the beginning of each turn and before accepting results. Read each body by its returned message id. Workers send status, questions and results to you; ${call('promptobus_task')} shows their addresses and repositories. Send answers and assignments through ${call('promptobus_send')}.
The holder and warden deliver postcards when mail arrives; finish the turn when waiting for a worker or an answer. Keep the task open until its acceptance checks pass. A worker result is a report, not acceptance. Inspect the work, obtain an independent review, run the required gates, and preserve evidence and remaining limitations before reporting completion.
`;
  const name = resumed ? sessionRefOf(resumed.owner) : `Orchestrator: ${shortTitle(title) || slug} (${task})`;
  const launch = driver.prepare({
    ref: name, role: ORCHESTRATOR, task, address: ORCHESTRATOR, root, cwd: root,
    mcp: mcp.descriptor, prompt, model, effort, permissionMode, addDirs, env,
  });
  launch.retainFailedSession = true;
  if (resumed) launch.resumeThreadId = resumed.record.threadId;
  return {
    host, home, root, task, resume: resumed, address: ORCHESTRATOR, title, slug, brief,
    driver, model, effort, permissionMode, rules, env, name, launch, prompt,
    mcpNote: mcpNote(mcp, 'orchestrator'), routing: routed?.metadata ?? null,
  };
}

export async function lead(rootOrHost, opts = {}) {
  const plan = await planLead(rootOrHost, opts);
  if (plan.routing) info(routingLine(plan.routing));
  if (opts.dryRun) {
    info(`root task: ${plan.task} · owner: Codex · model: ${plan.model}`);
    info(`install root: ${plan.root} · sandbox: ${plan.launch.settings.sandbox}`);
    sayMcp(plan);
    info(`workspace skills: ${skillsNote(plan)}`);
    info(plan.prompt);
    ok('dry-run: nothing written to disk, root orchestrator not started');
    return plan;
  }
  const rawTool = opts.tool ?? plan.host.resolveToolBin('codex');
  const tool = withToolVersion(plan.driver, plan.host, normalizeLaunchTool(plan.driver, rawTool, plan.env));
  if (!tool.ok) throw new GateError(tool.reason);
  const refusal = optionRefusal(plan.driver, plan.effort, tool, plan.host);
  if (refusal) throw new GateError(refusal);
  const provenance = launchProvenance(plan.host, tool);
  info(provenanceLine(provenance));
  const leases = path.join(plan.home, 'lead-launches');
  mkdirSync(leases, { recursive: true });
  return withDirLockAsync(path.join(leases, plan.task), () => startLead(plan, tool, provenance), {
    waitMs: 0,
    onMissing: () => new GateError(`task ${plan.task} launch lease parent is missing`),
    onBusy: () => new GateError(`task ${plan.task} has another live root launcher; no session files were touched`),
  });
}

async function startLead(plan, tool, provenance) {
  if (plan.resume) {
    withTaskLock(plan.home, plan.task, () => {
      const { owner } = resumeOwner(plan.host, plan.task, plan.driver, plan.env);
      upsertParticipant(plan.home, plan.task, {
        ...owner, metadata: { ...owner.metadata, launcherPid: process.pid },
      });
    });
  }
  else if (taskExists(plan.home, plan.task)) {
    throw new GateError(`task ${plan.task} already exists; lead opens a new root and cannot replace its mailbox owner`);
  }
  else plan.driver.prepareRootLaunch({ home: plan.home, task: plan.task, env: plan.env });
  bus(plan.home, { cli: plan.host.version });
  let spawned;
  try {
    spawned = await plan.driver.spawn(plan.launch, {
      tool, host: plan.host, home: plan.home, task: plan.task, address: ORCHESTRATOR,
      cwd: plan.root, env: plan.env, ref: plan.name, role: ORCHESTRATOR,
      launchFailNote: ` A bound root keeps its thread history; recover with lead --resume --task ${plan.task}.`,
      persist: (id, state, full) => {
        if (state === 'dead' || !full) return;
        const owner = participantRecord(ORCHESTRATOR, {
          owner: full, sessionId: full, session: id, sessionRef: plan.name,
          harness: 'codex', mode: 'managed', name: plan.name,
          model: plan.model, ...(plan.effort ? { effort: plan.effort } : {}),
          mechanismPath: provenance.mechanismPath, mechanismVersion: plan.host.version,
          packagePath: provenance.packagePath, packageVersion: provenance.packageVersion,
          hostVersion: provenance.hostVersion, binaryPath: tool.bin, binaryVersion: tool.version,
          capabilities: plan.driver.capabilities,
        }, registryOf(plan.host));
        if (plan.resume) {
          withTaskLock(plan.home, plan.task, () => {
            const current = bus(plan.home, { cli: plan.host.version }).readTask(plan.task);
            const former = participantOf(current, ORCHESTRATOR);
            if (current.status !== 'active' || former?.mode !== 'managed' || former?.harness !== 'codex'
              || ownerOf(former) !== full || sessionRefOf(former) !== plan.name) {
              throw new GateError(`task ${plan.task} changed owner while resuming; no new model turn started`);
            }
            upsertParticipant(plan.home, plan.task, owner);
          });
        } else {
          bus(plan.home, { cli: plan.host.version }).createTask({
            id: plan.task, title: plan.title, adapter: { slug: plan.slug }, owner,
          });
        }
        mkdirSync(inboxDir(plan.home, plan.task, ORCHESTRATOR), { recursive: true });
        mkdirSync(filesDir(plan.home, plan.task), { recursive: true });
      },
    });
  } finally {
    if (plan.resume) {
      withTaskLock(plan.home, plan.task, () => {
        const current = bus(plan.home, { cli: plan.host.version }).readTask(plan.task);
        const owner = participantOf(current, ORCHESTRATOR);
        if (current.status === 'active' && owner?.metadata?.launcherPid === process.pid) {
          const metadata = { ...owner.metadata };
          delete metadata.launcherPid;
          upsertParticipant(plan.home, plan.task, { ...owner, metadata });
        }
      });
    }
  }
  const { session, seen, output } = spawned;
  ensureWarden(plan.home, plan.task, { host: plan.host });
  ok(`root task ${plan.task} owned by Codex thread ${session}`);
  plan.driver.saidLiftoff({ name: plan.name, seen, session, output });
  return plan;
}

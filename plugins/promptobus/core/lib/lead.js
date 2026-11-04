import { finalizeManagedServiceLaunch, revokeFailedManagedLaunch } from './service-launch.js';
import { renderOrchestratorInstructions } from './prompts/roles.js';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { hostOf } from './host.js';
import { info, ok } from './util.js';
import { bus, canonicalPath, filesDir, GateError, inboxDir, newTaskIdentity, ORCHESTRATOR, participantOf, participantRecord, slugify, taskExists, upsertParticipant, withTaskLock, } from './store.js';
import { liftHarness, mcpNote, normalizeLaunchTool, optionRefusal, participantMcp, readBrief, resolveEffort, sayMcp, shortTitle, skillsNote, toolName, withToolVersion, } from './spawn.js';
import { routeLift, routingLine } from './models.js';
import { launchProvenance, provenanceLine } from './provenance.js';
import { ensureWarden } from './warden.js';
import { withDirLockAsync } from '../dist/fs/lock.js';
import { ownerOf, registryOf, requireTaskId, sessionRefOf, WORKER } from '../dist/index.js';
import { assertNativeContextDriver, contextRules, nativeContextMetadata, nativeContextPrompt, prepareNativeContext } from './native-participant-context.js';
import { recordVersion, sameRecordVersion } from './service-state.js';
import { managedCodexResumeDeath, readSession } from './codex-session.js';
function resumeOwner(host, task, driver, env) {
    const home = canonicalPath(host.promptobusHome());
    const meta = bus(home, { cli: host.version }).readTask(task);
    const owner = participantOf(meta, ORCHESTRATOR);
    const ref = sessionRefOf(owner);
    const threadId = ownerOf(owner);
    if (meta.status !== 'active' || meta.parent || owner?.harness !== 'codex' || owner?.mode !== 'managed' || !ref || !threadId) {
        throw new GateError(`task ${task} has no matching active managed Codex root owner to resume`);
    }
    const record = driver.resumeState(ref, {
        home, cwd: canonicalPath(host.workspaceRoot()), task, address: ORCHESTRATOR,
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
    if (opts.task !== undefined)
        requireTaskId(opts.task);
    if (opts.resume && !opts.task)
        throw new GateError('lead --resume requires --task <existing-id>');
    const driver = liftHarness(host, 'codex');
    const commonEnv = { ...process.env, ...host.extraEnv() };
    const env = driver.sessionEnv(commonEnv);
    const resumed = opts.resume ? resumeOwner(host, opts.task, driver, env) : null;
    const requestedPermission = opts.permissionMode ?? resumed?.record.sandbox;
    if (!['full-access', 'danger-full-access'].includes(requestedPermission)) {
        throw new GateError('managed Codex root lead requires explicit --permission-mode full-access; workspace-write cannot lift participants or provide the required network route. Participant permissions remain separate');
    }
    const brief = resumed && !opts.brief
        ? 'Continue the previous assignment and its approval boundaries from this same thread. Read the mailbox and answer pending questions before continuing.'
        : readBrief(opts.brief);
    const title = resumed?.meta.title ?? opts.title ?? brief.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean);
    const slug = resumed?.meta.adapter?.slug ?? slugify(title);
    const task = opts.task ?? newTaskIdentity(slug).id;
    const home = canonicalPath(host.promptobusHome());
    if (!resumed && taskExists(home, task)) {
        throw new GateError(`task ${task} already exists; lead opens a new root and cannot replace its mailbox owner`);
    }
    const root = canonicalPath(host.workspaceRoot());
    const selectedContext = prepareNativeContext(host, { root, role: ORCHESTRATOR, taskId: task, options: opts, participant: resumed?.owner });
    assertNativeContextDriver(selectedContext, driver);
    const routed = await routeLift(host, {
        role: WORKER, harness: 'codex', model: opts.model ?? resumed?.owner.metadata?.model,
        effort: opts.effort ?? resumed?.owner.metadata?.effort,
        strategy: opts.strategy, allowPayg: opts.allowPayg, refresh: opts.refresh,
        dryRun: opts.dryRun, address: ORCHESTRATOR, adapterFor: opts.adapterFor,
    });
    const model = opts.model ?? resumed?.owner.metadata?.model ?? routed?.model ?? driver.options.defaultModel;
    const effort = resolveEffort(opts.effort ?? resumed?.owner.metadata?.effort ?? routed?.effort, driver);
    const permissionMode = 'full-access';
    const rules = contextRules(selectedContext, () => host.collectRules(root));
    const addDirs = [...new Set(rules.filter((file) => !file.startsWith(root + path.sep)).map(path.dirname))];
    const mcp = participantMcp(host, { address: ORCHESTRATOR, taskId: task, home }, driver);
    const call = (name) => toolName(driver, 'promptobus', name, host);
    const prompt = renderOrchestratorInstructions({ rules, brief, bindings: {
            tools: Object.fromEntries(['promptobus_send', 'promptobus_mailbox', 'promptobus_task'].map(name => [name, call(name)])),
            preamble: driver.phrases.rootPreamble({ task, root }),
            delivery: 'The holder and warden deliver postcards when mail arrives;',
            operationalRules: driver.phrases.promptRulesFor(ORCHESTRATOR),
        } }) + nativeContextPrompt(selectedContext);
    const name = resumed ? sessionRefOf(resumed.owner) : `Orchestrator: ${shortTitle(title) || slug} (${task})`;
    const launch = driver.prepare({
        ref: name, role: ORCHESTRATOR, task, address: ORCHESTRATOR, root, cwd: root,
        mcp: mcp.descriptor, prompt, model, effort, permissionMode, addDirs, env, selectedContext,
        skillsRoot: selectedContext ? null : root,
        readFiles: selectedContext ? [...rules, ...selectedContext.resources.map(resource => resource.path)] : undefined,
        readSkillDirs: selectedContext ? selectedContext.skills.map(skill => skill.root) : undefined,
    });
    launch.retainFailedSession = true;
    if (resumed)
        launch.resumeThreadId = resumed.record.threadId;
    return {
        host, home, root, task, resume: resumed, address: ORCHESTRATOR, title, slug, brief, selectedContext,
        driver, model, effort, permissionMode, rules, env, commonEnv, name, launch, prompt,
        mcpNote: mcpNote(mcp, 'orchestrator'), routing: routed?.metadata ?? null,
    };
}
export async function lead(rootOrHost, opts = {}) {
    const plan = await planLead(rootOrHost, opts);
    if (plan.routing)
        info(routingLine(plan.routing));
    if (opts.dryRun) {
        info(`root task: ${plan.task} · owner: Codex · model: ${plan.model} · effort: ${plan.effort ?? 'default'}`);
        info(`install root: ${plan.root} · sandbox: ${plan.launch.settings.sandbox}`);
        sayMcp(plan);
        info(`workspace skills: ${skillsNote(plan)}`);
        info(plan.prompt);
        ok('dry-run: nothing written to disk, root orchestrator not started');
        return plan;
    }
    const rawTool = opts.tool ?? plan.host.resolveToolBin('codex');
    const tool = withToolVersion(plan.driver, plan.host, normalizeLaunchTool(plan.driver, rawTool, plan.env));
    if (!tool.ok)
        throw new GateError(tool.reason);
    const refusal = optionRefusal(plan.driver, plan.effort, tool, plan.host);
    if (refusal)
        throw new GateError(refusal);
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
            const version = recordVersion(plan.launch.sessionRecord);
            const { owner, record } = resumeOwner(plan.host, plan.task, plan.driver, plan.env);
            const death = managedCodexResumeDeath(plan.name, record, plan.env);
            if (!record.launchId || !record.codexHome || !record.threadId || !sameRecordVersion(version)
                || owner.metadata.sessionRecord !== version.file || owner.metadata.nativeLaunchId !== record.launchId) {
                throw new GateError('Managed Codex resume changed its previous record or current owner pointer');
            }
            plan.launch.managedResume = {
                version, ref: plan.name, home: plan.home, task: plan.task,
                address: ORCHESTRATOR, nativeId: record.threadId, nativeStore: realpathSync(record.codexHome),
                cwd: canonicalPath(record.cwd),
                previousLaunchId: record.launchId, previous: record.nativeAdmission ?? null,
                death,
                launcherPid: process.pid, previousLauncherPid: owner.metadata.launcherPid ?? null,
            };
            upsertParticipant(plan.home, plan.task, {
                ...owner, metadata: { ...owner.metadata, sessionRecord: version.file,
                    nativeLaunchId: record.launchId, launcherPid: process.pid },
            });
        });
    }
    else if (taskExists(plan.home, plan.task)) {
        throw new GateError(`task ${plan.task} already exists; lead opens a new root and cannot replace its mailbox owner`);
    }
    else {
        if (typeof plan.driver.prepareRootLaunch !== 'function')
            throw new GateError('Codex driver cannot verify retained unbound roots before launch');
        plan.driver.prepareRootLaunch({ home: plan.home, task: plan.task, env: plan.env });
    }
    bus(plan.home, { cli: plan.host.version });
    const clearResumeLauncher = () => {
        if (plan.resume) {
            withTaskLock(plan.home, plan.task, () => {
                const current = bus(plan.home, { cli: plan.host.version }).readTask(plan.task);
                const owner = participantOf(current, ORCHESTRATOR);
                if (current.status === 'active' && owner?.metadata?.launcherPid === process.pid) {
                    const resume = plan.launch.managedResume;
                    if (!resume || owner.harness !== 'codex' || owner.mode !== 'managed' || owner.sessionRef !== plan.name
                        || owner.metadata.owner !== resume.nativeId || owner.metadata.sessionId !== resume.nativeId
                        || owner.metadata.sessionRecord !== resume.version.file
                        || (owner.metadata.nativeLaunchId !== resume.previousLaunchId
                            && (!plan.launch.service || owner.metadata.nativeLaunchId !== plan.launch.service.launchId))) {
                        throw new GateError(`task ${plan.task} changed its owner before resume reservation cleanup`);
                    }
                    const metadata = { ...owner.metadata };
                    delete metadata.launcherPid;
                    upsertParticipant(plan.home, plan.task, { ...owner, metadata });
                }
            });
        }
    };
    let spawned;
    try {
        plan.env = (await finalizeManagedServiceLaunch(plan.host, {
            ...plan, ref: plan.name, cwd: plan.root, deferTaskBinding: true,
        })).env;
        spawned = await plan.driver.spawn(plan.launch, {
            tool: tool, host: plan.host, home: plan.home, task: plan.task, address: ORCHESTRATOR,
            cwd: plan.root, env: plan.env, ref: plan.name, role: ORCHESTRATOR,
            launchFailNote: ` A bound root keeps its thread history; recover with lead --resume --task ${plan.task}.`,
            persist: (id, state, full) => {
                if (state === 'dead' || !full)
                    return;
                const version = recordVersion(plan.launch.sessionRecord);
                const record = readSession(plan.name, plan.env);
                if (!record || record.launchId !== plan.launch.service.launchId || record.threadId !== full
                    || record.ref !== plan.name || record.home !== plan.home || record.task !== plan.task || record.address !== ORCHESTRATOR
                    || !sameRecordVersion(version)) {
                    throw new GateError(`task ${plan.task} changed native launch before owner publication`);
                }
                const owner = participantRecord(ORCHESTRATOR, {
                    ...nativeContextMetadata(plan.selectedContext),
                    owner: full, sessionId: full, session: id, sessionRef: plan.name,
                    sessionRecord: plan.launch.sessionRecord, nativeLaunchId: record.launchId,
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
                            || ownerOf(former) !== full || sessionRefOf(former) !== plan.name
                            || former.metadata.sessionRecord !== plan.launch.sessionRecord
                            || former.metadata.nativeLaunchId !== plan.launch.managedResume?.previousLaunchId
                            || former.metadata.launcherPid !== plan.launch.managedResume?.launcherPid
                            || former.metadata.launcherPid !== process.pid || !sameRecordVersion(version)) {
                            throw new GateError(`task ${plan.task} changed owner while resuming; no new model turn started`);
                        }
                        upsertParticipant(plan.home, plan.task, { ...owner, metadata: { ...owner.metadata, launcherPid: former.metadata.launcherPid } });
                    });
                }
                else {
                    if (!sameRecordVersion(version))
                        throw new GateError(`task ${plan.task} changed native record before creation`);
                    bus(plan.home, { cli: plan.host.version }).createTask({
                        id: plan.task, title: plan.title, adapter: { slug: plan.slug }, owner,
                    });
                }
                mkdirSync(inboxDir(plan.home, plan.task, ORCHESTRATOR), { recursive: true });
                mkdirSync(filesDir(plan.home, plan.task), { recursive: true });
            },
        }).catch(error => revokeFailedManagedLaunch(plan.launch, error));
    }
    catch (error) {
        return revokeFailedManagedLaunch(plan.launch, error, clearResumeLauncher);
    }
    clearResumeLauncher();
    const { session, seen, output } = spawned;
    await ensureWarden(plan.home, plan.task, { host: plan.host });
    ok(`root task ${plan.task} owned by Codex thread ${session}`);
    plan.driver.saidLiftoff({ name: plan.name, seen, session, output });
    return plan;
}

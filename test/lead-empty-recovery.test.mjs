import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, planParticipant } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { bus, participantOf, taskFile } from '../lib/store.js';
import { readPrivate, servicePaths } from '../lib/service-state.js';
import { codexDriver } from '../lib/driver-codex.js';
import { pidAlive, readSession } from '../lib/codex-session.js';

async function recoveryCase(admitted) {
const root = makeSandbox('promptobus-lead-');
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner-home');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}\n');
const env = { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_OWNER_CODEX_HOME: ownerHome,
  PROMPTOBUS_WARDEN: 'off' };
const host = hostOf(root);
const task = admitted ? 'lead-empty-admitted-t20261001-000001' : 'lead-empty-pending-t20261001-000001';
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Persist this original scope\nEMPTY-SCOPE-FIXTURE-9516\n');
planParticipant(harness.home, 'orchestrator', { turns: [{ do: [{ tool: 'promptobus_task', args: { task } }] }] });
const moduleUrl = (name) => pathToFileURL(path.resolve('lib', name + '.js')).href;
const bindingChild = path.join(root, 'binding-child.mjs');
writeFileSync(bindingChild, `
import { planLead } from ${JSON.stringify(moduleUrl('lead'))};
import { codexDriver } from ${JSON.stringify(moduleUrl('driver-codex'))};
import { finalizeManagedServiceLaunch } from ${JSON.stringify(moduleUrl('service-launch'))};
import { readSession } from ${JSON.stringify(moduleUrl('codex-session'))};
import { bus, participantRecord } from ${JSON.stringify(moduleUrl('store'))};
import { hostOf } from ${JSON.stringify(moduleUrl('host'))};
const host = hostOf(process.cwd(), { binPath: ${JSON.stringify(path.resolve('bin/promptobus.js'))}, nodePath: process.execPath,
  version: ${JSON.stringify(JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version)} });
const task = ${JSON.stringify(task)};
const plan = await planLead(host, { task, brief: ${JSON.stringify(brief)}, model: 'gpt-6-astra', permissionMode: 'full-access' });
plan.env = (await finalizeManagedServiceLaunch(host, { ...plan, ref: plan.name, cwd: plan.root, deferTaskBinding: true })).env;
if (${JSON.stringify(admitted)}) {
  const realize = plan.launch.service.realize;
  plan.launch.service.realize = async nativeId => { await realize(nativeId); process.exit(0); };
}
await codexDriver.spawn(plan.launch, {
  tool: { ok: true, bin: 'codex', version: '0.159.2' }, host, home: host.promptobusHome(),
  task, address: 'orchestrator', cwd: process.cwd(), env: plan.env, ref: plan.name, role: 'orchestrator',
  persist: (id, state, full) => {
    const native = readSession(plan.name, plan.env);
    bus(host.promptobusHome(), { cli: host.version }).createTask({ id: task, title: plan.title,
      owner: participantRecord('orchestrator', { harness: 'codex', mode: 'managed', owner: full,
        sessionId: full, sessionRef: plan.name, sessionRecord: plan.launch.sessionRecord,
        nativeLaunchId: native.launchId, model: 'gpt-6-astra' }) });
    if (!${JSON.stringify(admitted)}) process.exit(0);
  },
});
`);
const bound = spawnSync(process.execPath, [bindingChild], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
check('a root launcher can die after owner binding before any model input', bound.status === 0,
  `${bound.status} ${bound.stdout}${bound.stderr}`);
const core = bus(host.promptobusHome(), { cli: host.version });
const before = core.readTask(task);
const owner = participantOf(before, 'orchestrator');
const initial = readSession(owner.sessionRef, env);
const nativePath = path.join(harness.home, 'threads', initial.threadId + '.json');
const nativeBefore = JSON.parse(readFileSync(nativePath, 'utf8'));
check('original user assignment is stored before binding while native turns remain empty',
  initial.state === 'binding' && initial.turns === 0 && initial.initialAssignmentInjected === true
  && nativeBefore.injectedItems[0].content[0].text === initial.initialPrompt
  && !nativeBefore.firstRpc);
process.kill(initial.appPid, 'SIGKILL');
process.kill(initial.holderPid, 'SIGKILL');
await waitFor(() => !pidAlive(initial.appPid) && !pidAlive(initial.holderPid), { timeoutMs: 10000 });
const ledger = readPrivate(path.join(servicePaths(host, env).directory, 'native-admission.json'));
const admission = ledger?.bindings.find(row => row.harness === 'codex' && row.nativeId === initial.threadId);
check(admitted ? 'positive recovery starts from actual durable fresh admission' : 'pre-admission crash has no durable native binding',
  admitted ? admission?.ownerKey === initial.launchId && admission.nativeStore === initial.codexHome
    && admission.process?.pid === initial.appProcess.pid && admission.process?.birth === initial.appProcess.birth : !admission,
  JSON.stringify({ admitted, nativeId: initial.threadId, admission }));
let oldListener, oldEntry;
if (admitted) {
  rmSync(initial.rpcSocket);
  oldListener = net.createServer(c => c.on('data', data => c.write(data)));
  await new Promise((resolve, reject) => oldListener.once('error', reject).listen(initial.rpcSocket, resolve));
  oldEntry = lstatSync(initial.rpcSocket);
}
const taskBeforeResume = readFileSync(taskFile(host.promptobusHome(), task), 'utf8');
const resumed = spawnSync(process.execPath, [path.resolve('bin/promptobus.js'), 'lead', '--resume', '--task', task],
  { cwd: root, env, encoding: 'utf8', timeout: 30000 });
if (!admitted) {
  const retained = readSession(owner.sessionRef, env);
  const retainedTask = core.readTask(task), retainedOwner = participantOf(retainedTask, 'orchestrator');
  const after = JSON.parse(readFileSync(nativePath, 'utf8'));
  check('pre-admission recovery refuses unknown native adoption and retains owner history without a first model turn',
    resumed.status === 1 && resumed.stderr.includes('First native admission requires verified fresh creation')
    && retained?.threadId === initial.threadId && retained.initialPrompt === initial.initialPrompt
    && retainedTask.created === before.created && retainedTask.status === before.status
    && retainedOwner.metadata.owner === owner.metadata.owner && retainedOwner.metadata.sessionId === initial.threadId
    && retainedOwner.sessionRef === owner.sessionRef && retainedOwner.metadata.sessionRecord === owner.metadata.sessionRecord
    && retainedOwner.metadata.nativeLaunchId === initial.launchId && !retainedOwner.metadata.launcherPid
    && !after.firstRpc && after.injectedItems.length === 1,
    JSON.stringify({ status: resumed.status, output: resumed.stdout + resumed.stderr, retainedId: retained?.threadId, firstRpc: after.firstRpc,
      samePrompt: retained?.initialPrompt === initial.initialPrompt, injectedCount: after.injectedItems.length,
      changedTaskFields: Object.keys(core.readTask(task)).filter(key => JSON.stringify(core.readTask(task)[key]) !== JSON.stringify(JSON.parse(taskBeforeResume)[key])) }));
  rmSync(initial.rpcSocket, { force: true });
  harness.restore();
  return;
}
check('hard-killed admitted no-input managed root resumes its existing native thread', resumed.status === 0,
  `${resumed.status} ${resumed.stdout}${resumed.stderr}`);
const completed = await waitFor(() => {
  const record = readSession(owner.sessionRef, env);
  return record?.turns >= 1 && !record.busy ? record : null;
}, { timeoutMs: 10000 });
const oldReply = await new Promise((resolve, reject) => {
  const client = net.connect(initial.rpcSocket, () => client.write('old-launch'));
  client.once('error', reject);
  client.once('data', data => { client.end(); resolve(data.toString()); });
});
const retainedEntry = existsSync(initial.rpcSocket) ? lstatSync(initial.rpcSocket) : null;
check('managed recovery allocates a new launch contact and preserves the old-path listener',
  completed?.launchId !== initial.launchId && completed?.rpcSocket !== initial.rpcSocket
  && retainedEntry?.dev === oldEntry.dev && retainedEntry?.ino === oldEntry.ino && oldReply === 'old-launch',
  JSON.stringify({ oldLaunch: initial.launchId, newLaunch: completed?.launchId, oldSocket: initial.rpcSocket, newSocket: completed?.rpcSocket, oldReply }));
const nativeAfter = JSON.parse(readFileSync(nativePath, 'utf8'));
check('recovery preserves owner, creation and original assignment without duplicate model input',
  completed?.threadId === initial.threadId && completed.initialPrompt === initial.initialPrompt
  && completed.initialAssignmentInjected === true && core.readTask(task).created === before.created
  && nativeAfter.injectedItems.length === 1
  && !nativeAfter.firstRpc?.params.input[0].text.includes('EMPTY-SCOPE-FIXTURE-9516'),
  JSON.stringify({completed:completed?.threadId,initial:initial.threadId,createdBefore:before.created,createdAfter:core.readTask(task).created,injectedCount:nativeAfter.injectedItems.length,firstInput:nativeAfter.firstRpc?.params.input[0].text}));
await codexDriver.stop(owner.sessionRef);
await new Promise(resolve => oldListener.close(resolve));
harness.restore();

}
await recoveryCase(false);
await recoveryCase(true);

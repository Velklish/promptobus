import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, planParticipant } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { bus, participantOf } from '../lib/store.js';
import { codexDriver } from '../lib/driver-codex.js';
import { pidAlive, readSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-lead-');
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner-home');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}\n');
const env = { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_OWNER_CODEX_HOME: ownerHome,
  PROMPTOBUS_WARDEN: 'off' };
const host = hostOf(root);
const task = 'lead-empty-t20261001-000001';
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Persist this original scope\nEMPTY-SCOPE-FIXTURE-9516\n');
planParticipant(harness.home, 'orchestrator', { turns: [{ do: [{ tool: 'promptobus_task', args: { task } }] }] });
const moduleUrl = (name) => pathToFileURL(path.resolve('lib', name + '.js')).href;
const bindingChild = path.join(root, 'binding-child.mjs');
writeFileSync(bindingChild, `
import { planLead } from ${JSON.stringify(moduleUrl('lead'))};
import { codexDriver } from ${JSON.stringify(moduleUrl('driver-codex'))};
import { bus, participantRecord } from ${JSON.stringify(moduleUrl('store'))};
import { hostOf } from ${JSON.stringify(moduleUrl('host'))};
const host = hostOf(process.cwd(), { binPath: ${JSON.stringify(path.resolve('bin/promptobus.js'))}, nodePath: process.execPath, version: '0.21.0' });
const task = ${JSON.stringify(task)};
const plan = await planLead(host, { task, brief: ${JSON.stringify(brief)}, model: 'gpt-6-astra' });
await codexDriver.spawn(plan.launch, {
  tool: { ok: true, bin: 'codex', version: '0.159.2' }, host, home: host.promptobusHome(),
  task, address: 'orchestrator', cwd: process.cwd(), env: process.env, ref: plan.name, role: 'orchestrator',
  persist: (id, state, full) => {
    bus(host.promptobusHome(), { cli: host.version }).createTask({ id: task, title: plan.title,
      owner: participantRecord('orchestrator', { harness: 'codex', mode: 'managed', owner: full,
        sessionId: full, sessionRef: plan.name, model: 'gpt-6-astra' }) });
    process.exit(0);
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
const resumed = spawnSync(process.execPath, [path.resolve('bin/promptobus.js'), 'lead', '--resume', '--task', task],
  { cwd: root, env, encoding: 'utf8', timeout: 30000 });
check('hard-killed no-input managed root resumes its existing native thread', resumed.status === 0,
  `${resumed.status} ${resumed.stdout}${resumed.stderr}`);
const completed = await waitFor(() => {
  const record = readSession(owner.sessionRef, env);
  return record?.turns >= 1 && !record.busy ? record : null;
}, { timeoutMs: 10000 });
const nativeAfter = JSON.parse(readFileSync(nativePath, 'utf8'));
check('recovery preserves owner, creation and original assignment without duplicate model input',
  completed?.threadId === initial.threadId && completed.initialPrompt === initial.initialPrompt
  && completed.initialAssignmentInjected === true && core.readTask(task).created === before.created
  && nativeAfter.injectedItems.length === 1
  && !nativeAfter.firstRpc.params.input[0].text.includes('EMPTY-SCOPE-FIXTURE-9516'),
  JSON.stringify({completed:completed?.threadId,initial:initial.threadId,createdBefore:before.created,createdAfter:core.readTask(task).created,injectedCount:nativeAfter.injectedItems.length,firstInput:nativeAfter.firstRpc.params.input[0].text}));
await codexDriver.stop(owner.sessionRef);
harness.restore();

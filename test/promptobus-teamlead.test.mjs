import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { captureSplit, quiet } from './console.mjs';
import { stubCommand, writeHostConfig } from './sandbox.mjs';
import * as store from '../lib/store.js';
import { hostOf } from '../lib/host.js';
import { planTeamlead, recoverTeamleadRebind, spawnTeamlead } from '../lib/spawn.js';
import { participantSession, status } from '../lib/status.js';
import { snapshotOf } from '../lib/drivers.js';
import { liveWatched } from '../dist/index.js';
import { send } from '../lib/send.js';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'promptobus-test-teamlead-'));
const root = path.join(scratch, 'install');
const brief = path.join(scratch, 'group.md');
const marker = path.join(scratch, 'started');
const bin = path.join(scratch, 'bin');
const cli = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const originalPath = process.env.PATH;
process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
const git = (...args) => {
  const ran = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return ran.stdout.trim();
};
const prior = process.env.CLAUDE_CODE_SESSION_ID;
process.env.CLAUDE_CODE_SESSION_ID = 'root-session';
writeHostConfig(root, { tools: ['claude', 'cursor', 'codex'] });
writeFileSync(path.join(root, 'AGENTS.md'), 'Root rules.\n');
writeFileSync(path.join(root, '.gitignore'), '.promptobus/\n');
writeFileSync(brief, '# Group One\n\nOwn the repositories in this brief.\n');
git('init', '-q');
git('add', '.');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'root');
const host = hostOf(root);
const home = host.promptobusHome();
store.bus(home, { cli: host.version });
const task = 'root-t20260927-010000';
store.createTask(home, { id: task, title: 'Root', owner: 'root-session' });
const opts = { task, brief, slug: 'group-one' };
const planned = await planTeamlead(host, opts);
const dry = await captureSplit(() => spawnTeamlead(host, { ...opts, dryRun: true }));
const dryChild = dry.out.match(/child task: ([a-z0-9-]+)/)?.[1];
check('teamlead dry-run names the child, root, address and install cwd without starting',
  dryChild && dry.out.includes(task)
  && dry.out.includes('teamlead:group-one') && dry.out.includes(root)
  && !existsSync(marker) && !store.taskExists(home, dryChild), dry.out);
const firstStatusInstruction = 'In your first status to the root orchestrator, list every rule file you read by path.';
check('teamlead prompt instructs first status to list rule files read',
  planned.prompt.includes(firstStatusInstruction)
  && planned.rules.length > 0 && planned.rules.every((file) => planned.prompt.includes(`- ${file}`)), planned.prompt);
check('teamlead lift keeps sibling assignments vertical',
  planned.prompt.includes('The bus refuses task, result and review to a sibling.')
  && planned.prompt.includes('Raise a change of logic, a change of requirements')
  && planned.prompt.includes('Bring a contract between groups to the root.'), planned.prompt);
check('teamlead dry-run MCP entry defaults to child and names reporting root',
  planned.launch.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_TASK === planned.childTask
  && planned.launch.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_ROOT_TASK === task
  && planned.launch.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_ROLE === 'orchestrator',
  JSON.stringify(planned.launch.mcpConfig.mcpServers.promptobus.env));
let modelRefusal = '';
try { await planTeamlead(host, { ...opts, model: 'grok-4.7-medium' }); } catch (error) { modelRefusal = error.message; }
check('teamlead refuses a Cursor-only model before start',
  modelRefusal.includes('ADR-015') && modelRefusal.includes('PB-222') && !existsSync(marker), modelRefusal);
let codexModelRefusal = '';
try { await planTeamlead(host, { ...opts, model: 'gpt-5.6-sol' }); }
catch (error) { codexModelRefusal = error.message; }
check('teamlead refuses a Codex-only model before start',
  codexModelRefusal.includes('PB-286.1') && codexModelRefusal.includes('reviews')
  && !existsSync(marker), codexModelRefusal);
const routed = await planTeamlead(host, { ...opts, strategy: 'quality', dryRun: true });
check('teamlead strategy restricts the routed choice to Claude Code',
  routed.driver.id === 'claude' && routed.decision?.chosen?.harness === 'claude',
  JSON.stringify(routed.decision?.chosen));

for (const harness of ['cursor', 'codex']) {
  const ran = spawnSync(process.execPath, [cli, 'spawn', '--teamlead', '--task', task,
    '--brief', brief, '--slug', 'group-one', '--harness', harness], {
    cwd: root, encoding: 'utf8', env: process.env,
  });
  check(`teamlead --harness ${harness} exits non-zero before start with its return condition`,
    ran.status !== 0 && ran.stderr.includes(harness === 'cursor' ? 'ADR-015' : 'PB-286.1')
    && ran.stderr.includes(harness === 'cursor' ? 'PB-222' : 'worker lift')
    && !existsSync(marker) && !store.taskExists(home, planned.childTask), ran.stderr);
}

const installStub = (sessions, launchId = sessions.at(-1)?.id) => stubCommand(bin, 'claude', `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.280\\n'); process.exit(0); }
if (args[0] === 'agents') { process.stdout.write(${JSON.stringify(JSON.stringify(sessions))}); process.exit(0); }
if (args[0] === '--bg') { appendFileSync(${JSON.stringify(marker)}, 'x'); }
process.stdout.write('backgrounded · ${launchId}\\n');
`);
const sid1 = '11111111-1111-1111-1111-111111111111';
const sid2 = '22222222-2222-2222-2222-222222222222';
const tool = () => ({ ok: true, bin: path.join(bin, 'claude'), version: '2.1.280' });
installStub([{ id: 'aabbccdd', sessionId: sid1, name: planned.name, state: 'working', pid: 4242 }]);
const launched = await quiet(() => spawnTeamlead(host, { ...opts, tool: tool() }));
const child = store.readTask(home, launched.childTask);
const rootTask = store.readTask(home, task);
const lead = store.participantOf(rootTask, 'teamlead:group-one');
check('teamlead lift links child and binds both addresses to one session',
  child.parent === task && child.participants[0].metadata.owner === sid1
  && lead.metadata.sessionId === sid1 && lead.metadata.childTask === child.id,
  JSON.stringify({ child: child.id, lead: lead.metadata }));
let liveRefusal = '';
try { await planTeamlead(host, opts); } catch (error) { liveRefusal = error.message; }
check('a live teamlead address refuses a second lift',
  liveRefusal.includes('already running') && liveRefusal.includes('teamlead:group-one'), liveRefusal);
const printed = captureSplit(() => status(host, { task, sessions: [] }));
check('status prints teamlead under root and child beneath it',
  printed.out.includes('teamlead:group-one') && printed.out.includes(`child task ${child.id}`)
  && printed.out.includes(`  ${child.id} ·`), printed.out);
store.upsertParticipant(home, child.id, store.participantRecord('worker:one', { sessionId: 'worker-session' }));
const teamleadEnv = {
  ...process.env, CLAUDE_CODE_SESSION_ID: sid1, PROMPTOBUS_ROLE: 'orchestrator',
  PROMPTOBUS_TASK: child.id, PROMPTOBUS_HOME: home,
};
const rootSent = await quiet(() => send(host, { task, to: 'orchestrator', type: 'status', body: 'ready' },
  { env: teamleadEnv, cwd: root }));
const childSent = await quiet(() => send(host, { task: child.id, to: 'worker:one', type: 'task', body: 'go' },
  { env: teamleadEnv, cwd: root }));
check('teamlead status reaches root and child worker task is from orchestrator',
  rootSent === 0 && childSent === 0
  && store.glanceInbox(home, task, 'orchestrator').some((m) => m.sender === lead.id)
  && store.glanceInbox(home, child.id, 'worker:one').some((m) => m.sender === 'orchestrator'),
  JSON.stringify({ rootSent, childSent }));

const siblingBrief = path.join(scratch, 'sibling.md');
writeFileSync(siblingBrief, '# Group One\n');
const siblingOpts = { task, brief: siblingBrief, slug: 'group-two' };
const sibling = await planTeamlead(host, siblingOpts);
check('equal teamlead headings still produce distinct session names', sibling.name !== planned.name,
  JSON.stringify([planned.name, sibling.name]));
const sidCollision = '99999999-9999-9999-9999-999999999999';
installStub([
  { id: 'aabbccdd', sessionId: sid1, name: planned.name, state: 'working', pid: 4242 },
  { id: 'deadbeef', sessionId: sidCollision, name: sibling.name, state: 'working', pid: 4245 },
  { id: 'bbccddee', sessionId: sid2, name: sibling.name, state: 'working', pid: 4243 },
]);
const siblingLift = await quiet(() => spawnTeamlead(host, { ...siblingOpts, tool: tool() }));
const siblingChild = store.readTask(home, siblingLift.childTask);
const siblingLead = store.participantOf(store.readTask(home, task), 'teamlead:group-two');
check('second teamlead binds the session launched despite an older same-name registry row',
  siblingChild.participants[0].metadata.owner === sid2 && siblingLead.metadata.sessionId === sid2
  && lead.metadata.sessionId === sid1, JSON.stringify({ sibling: siblingLead.metadata, first: lead.metadata }));
store.upsertParticipant(home, siblingChild.id, store.participantRecord('worker:two', { sessionId: 'worker-two-session' }));
const siblingEnv = {
  ...process.env, CLAUDE_CODE_SESSION_ID: sid2, PROMPTOBUS_ROLE: 'orchestrator',
  PROMPTOBUS_TASK: siblingChild.id, PROMPTOBUS_HOME: home,
};
const firstAgain = await quiet(() => send(host, { task, to: 'orchestrator', type: 'status', body: 'first' },
  { env: teamleadEnv, cwd: root }));
const secondUp = await quiet(() => send(host, { task, to: 'orchestrator', type: 'status', body: 'second' },
  { env: siblingEnv, cwd: root }));
const secondDown = await quiet(() => send(host, { task: siblingChild.id, to: 'worker:two', type: 'task', body: 'go' },
  { env: siblingEnv, cwd: root }));
check('both live teamlead sessions send through their own root and child addresses',
  firstAgain === 0 && secondUp === 0 && secondDown === 0
  && store.glanceInbox(home, task, 'orchestrator').some((m) => m.sender === lead.id && m.body === 'first')
  && store.glanceInbox(home, task, 'orchestrator').some((m) => m.sender === siblingLead.id && m.body === 'second')
  && store.glanceInbox(home, siblingChild.id, 'worker:two').some((m) => m.sender === 'orchestrator'),
  JSON.stringify({ firstAgain, secondUp, secondDown }));
check('two teamlead lifts leave install root git status clean', git('status', '--porcelain') === '', git('status', '--porcelain'));
check('second teamlead prompt lists its sibling address', sibling.prompt.includes('teamlead:group-one'), sibling.prompt);

const sid3 = '33333333-3333-3333-3333-333333333333';
const reliftBrief = path.join(scratch, 'relift.md');
writeFileSync(reliftBrief, '# Renewed Group One\n');
const reliftOpts = { ...opts, brief: reliftBrief };
const reliftPlan = await planTeamlead(host, { ...reliftOpts, sessions: [] });
installStub([{ id: 'ccddeeaa', sessionId: sid3, name: reliftPlan.name, state: 'working', pid: 4244 }]);
const relift = await quiet(() => spawnTeamlead(host, { ...reliftOpts, sessions: [], tool: tool() }));
const reliftLead = store.participantOf(store.readTask(home, task), 'teamlead:group-one');
const reliftOwner = store.participantOf(store.readTask(home, child.id), 'orchestrator');
const reliftSessions = snapshotOf([reliftLead, reliftOwner]);
check('dead teamlead relifts into the same child task with both addresses on the new live session',
  relift.childTask === child.id && reliftPlan.name !== planned.name
  && reliftLead.metadata.sessionId === sid3 && reliftOwner.metadata.owner === sid3
  && reliftLead.sessionRef === reliftPlan.name && reliftOwner.sessionRef === reliftPlan.name
  && reliftLead.metadata.name === reliftPlan.name && reliftOwner.metadata.name === reliftPlan.name
  && reliftLead.metadata.session === 'ccddeeaa' && reliftOwner.metadata.session === 'ccddeeaa'
  && participantSession(reliftLead, reliftSessions) === 'alive'
  && participantSession(reliftOwner, reliftSessions) === 'alive'
  && liveWatched(home, child.id, reliftSessions).includes('orchestrator'),
  JSON.stringify({ lead: reliftLead.metadata, owner: reliftOwner.metadata, reliftSessions }));
const sid4 = '44444444-4444-4444-4444-444444444444';
installStub([{ id: 'ddeeffaa', sessionId: sid4, name: planned.name, state: 'working', pid: 4246 }]);
let faultMessage = '';
try {
  await quiet(() => spawnTeamlead(host, { ...opts, sessions: [], tool: tool(),
    fault: (step) => { if (step === 'teamlead-rebind-after-child') throw new Error('injected between journals'); },
  }));
} catch (error) { faultMessage = error.message; }
const intentFile = path.join(path.dirname(store.taskFile(home, task)), 'rebinds', 'group-one.json');
check('fault between child and root journal writes leaves a durable rebind intent',
  faultMessage.includes('injected between journals') && existsSync(intentFile)
  && store.participantOf(store.readTask(home, child.id), 'orchestrator').metadata.owner === sid4
  && store.participantOf(store.readTask(home, task), 'teamlead:group-one').metadata.sessionId === sid3,
  faultMessage);
const pendingSnapshot = [store.taskFile(home, task), store.taskFile(home, child.id), intentFile]
  .map((file) => readFileSync(file, 'utf8'));
const pendingLaunches = readFileSync(marker, 'utf8').length;
const pendingDry = await captureSplit(() => spawnTeamlead(host, { ...opts, sessions: [], dryRun: true }));
const pendingRefusals = [];
for (const harness of ['cursor', 'codex']) {
  try { await planTeamlead(host, { ...opts, harness }); }
  catch (error) { pendingRefusals.push(error.message); }
}
try { await planTeamlead(host, { ...opts, model: 'grok-4.7-medium' }); }
catch (error) { pendingRefusals.push(error.message); }
check('pending rebind dry-run and unsupported choices leave journals and intent untouched',
  pendingDry.out.includes('dry-run: nothing written') && pendingRefusals.length === 3
  && pendingRefusals[0].includes('ADR-015')
  && pendingRefusals[1].includes('PB-286.1')
  && pendingRefusals[2].includes('ADR-015')
  && [store.taskFile(home, task), store.taskFile(home, child.id), intentFile]
    .every((file, index) => readFileSync(file, 'utf8') === pendingSnapshot[index])
  && readFileSync(marker, 'utf8').length === pendingLaunches,
  JSON.stringify({ pendingRefusals, pendingDry: pendingDry.out.slice(-180) }));
const launchesBeforeRetry = readFileSync(marker, 'utf8').length;
const retry = spawnSync(process.execPath, [cli, 'spawn', '--teamlead', '--task', task,
  '--brief', brief, '--slug', 'group-one'], { cwd: root, encoding: 'utf8', env: process.env });
const retryMessage = retry.stderr;
const recoveredLead = store.participantOf(store.readTask(home, task), 'teamlead:group-one');
const recoveredOwner = store.participantOf(store.readTask(home, child.id), 'orchestrator');
const recoveredEnv = { ...teamleadEnv, CLAUDE_CODE_SESSION_ID: sid4 };
let recoveredUp;
try {
  recoveredUp = await quiet(() => send(host, { task, to: 'orchestrator', type: 'status', body: 'recovered' },
    { env: recoveredEnv, cwd: root }));
} catch (error) { recoveredUp = error.message; }
check('retry recovers both addresses and an upward send after interrupted relift',
  retry.status !== 0 && retryMessage.includes('already running') && !existsSync(intentFile)
  && readFileSync(marker, 'utf8').length === launchesBeforeRetry
  && recoveredLead.metadata.sessionId === sid4 && recoveredOwner.metadata.owner === sid4
  && recoveredUp === 0 && store.glanceInbox(home, task, 'orchestrator')
    .some((m) => m.sender === recoveredLead.id && m.body === 'recovered'),
  JSON.stringify({ retryMessage, recoveredUp, recoveredLead: recoveredLead.metadata,
    recoveredOwner: recoveredOwner.metadata }));

const sid5 = '55555555-5555-5555-5555-555555555555';
const sid6 = '66666666-6666-6666-6666-666666666666';
const intentFor = (id, oldSession, sessionId) => {
  const rootParticipant = store.participantRecord('teamlead:group-one', {
    ...store.participantOf(store.readTask(home, task), 'teamlead:group-one').metadata,
    owner: undefined, sessionId,
  });
  const childParticipant = store.participantRecord('orchestrator', {
    ...store.participantOf(store.readTask(home, child.id), 'orchestrator').metadata,
    owner: sessionId, sessionId,
  });
  return { id, rootTask: task, childTask: child.id, address: 'teamlead:group-one',
    oldRootSession: oldSession, oldChildSession: oldSession, sessionId,
    rootParticipant, childParticipant };
};
store.writeJsonAtomic(intentFile, intentFor('old-intent', sid4, sid5));
const staleRecovery = recoverTeamleadRebind(home, task, 'teamlead:group-one', (step) => {
  if (step !== 'teamlead-rebind-before-lock') return;
  recoverTeamleadRebind(home, task, 'teamlead:group-one');
  store.withTaskLock(home, task, () => store.writeJsonAtomic(intentFile, intentFor('new-intent', sid5, sid6)));
});
const newerIntent = JSON.parse(readFileSync(intentFile, 'utf8'));
check('stale rebind recovery leaves the newer intent and its session unchanged',
  staleRecovery === false && newerIntent.id === 'new-intent'
  && store.participantOf(store.readTask(home, task), 'teamlead:group-one').metadata.sessionId === sid5
  && store.participantOf(store.readTask(home, child.id), 'orchestrator').metadata.owner === sid5,
  JSON.stringify({ staleRecovery, newerIntent: newerIntent.id }));
const newestRecovery = recoverTeamleadRebind(home, task, 'teamlead:group-one');
const newestLead = store.participantOf(store.readTask(home, task), 'teamlead:group-one');
const newestOwner = store.participantOf(store.readTask(home, child.id), 'orchestrator');
const newestEnv = { ...teamleadEnv, CLAUDE_CODE_SESSION_ID: sid6 };
const newestUp = await quiet(() => send(host, { task, to: 'orchestrator', type: 'status', body: 'newest' },
  { env: newestEnv, cwd: root }));
check('retry recovers the newer intent as one owner and permits upward send',
  newestRecovery && !existsSync(intentFile) && newestLead.metadata.sessionId === sid6
  && newestOwner.metadata.owner === sid6 && newestUp === 0
  && store.glanceInbox(home, task, 'orchestrator').some((m) => m.sender === newestLead.id && m.body === 'newest'),
  JSON.stringify({ newestRecovery, newestLead: newestLead.metadata, newestOwner: newestOwner.metadata }));

const freshBrief = path.join(scratch, 'fresh.md');
writeFileSync(freshBrief, '# Group Three\n');
const freshOpts = { task, brief: freshBrief, slug: 'group-three' };
const freshPlan = await planTeamlead(host, freshOpts);
const sid7 = '77777777-7777-7777-7777-777777777777';
installStub([{ id: 'eeffaabb', sessionId: sid7, name: freshPlan.name, state: 'working', pid: 4247 }]);
const firstLaunches = readFileSync(marker, 'utf8').length;
let firstFault = '';
try {
  await quiet(() => spawnTeamlead(host, { ...freshOpts, tool: tool(),
    fault: (step) => { if (step === 'teamlead-first-after-link') throw new Error('injected after first link'); },
  }));
} catch (error) { firstFault = error.message; }
const freshLead = store.participantOf(store.readTask(home, task), 'teamlead:group-three');
const freshOwner = store.participantOf(store.readTask(home, freshPlan.childTask), 'orchestrator');
check('first link persists the complete root and child participants before post-link fault',
  firstFault.includes('injected after first link') && freshLead.metadata.sessionId === sid7
  && freshLead.sessionRef === freshPlan.name && freshLead.metadata.name === freshPlan.name
  && freshOwner.metadata.owner === sid7 && freshOwner.metadata.sessionId === sid7
  && readFileSync(marker, 'utf8').length === firstLaunches + 1,
  JSON.stringify({ firstFault, freshLead: freshLead?.metadata, freshOwner: freshOwner?.metadata }));
const firstRetry = spawnSync(process.execPath, [cli, 'spawn', '--teamlead', '--task', task,
  '--brief', freshBrief, '--slug', 'group-three'], { cwd: root, encoding: 'utf8', env: process.env });
const freshEnv = { ...teamleadEnv, CLAUDE_CODE_SESSION_ID: sid7 };
const freshUp = await quiet(() => send(host, { task, to: 'orchestrator', type: 'status', body: 'first-link' },
  { env: freshEnv, cwd: root }));
check('first-link retry refuses duplicate launch and preserves upward ownership',
  firstRetry.status !== 0 && firstRetry.stderr.includes('already running')
  && readFileSync(marker, 'utf8').length === firstLaunches + 1
  && store.participantOf(store.readTask(home, task), 'teamlead:group-three').metadata.sessionId === sid7
  && store.participantOf(store.readTask(home, freshPlan.childTask), 'orchestrator').metadata.owner === sid7
  && freshUp === 0 && store.glanceInbox(home, task, 'orchestrator')
    .some((m) => m.sender === freshLead.id && m.body === 'first-link'),
  JSON.stringify({ retry: firstRetry.stderr, freshUp }));
if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
else process.env.CLAUDE_CODE_SESSION_ID = prior;
process.env.PATH = originalPath;

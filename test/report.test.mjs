import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, stubCommand, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';

const ROOT = makeSandbox('promptobus-report-');
const HOME = path.join(ROOT, '.promptobus');
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'promptobus.js');
const TASK = 'report-root-t20260927-000000';
const CHILD = 'report-child-t20260927-000000';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
  'CLAUDE_CODE_SESSION_ID', 'CURSOR_CONVERSATION_ID', 'CODEX_THREAD_ID',
  'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_CURSOR_SESSION',
  'PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK',
].includes(key)));
Object.assign(env, { PROMPTOBUS_HOME: HOME, PROMPTOBUS_WARDEN: 'off' });
writeHostConfig(ROOT, { tools: ['claude', 'cursor', 'codex'] });

const store = await import('../lib/store.js');
const { hostOf } = await import('../lib/host.js');
const { planReport, report } = await import('../lib/report.js');
const { REPORTER_DENY, REVIEWER_DENY } = await import('../lib/driver-claude.js');
const { status } = await import('../lib/status.js');
const { answerOwedSince } = await import('../lib/answers.js');
const { guardVerdict } = await import('../lib/guard.js');
const { stopManaged } = await import('../lib/done.js');
const { createRegistry } = await import('../dist/index.js');
const host = hostOf(ROOT);
store.createTask(HOME, { id: TASK, title: 'one root task', owner: 'owner-session' });
store.createTask(HOME, {
  id: CHILD, title: 'child task', owner: 'child-owner', parent: TASK, teamlead: 'teamlead:one',
});

const refusal = async (opts) => {
  try { await planReport(host, opts); return { threw: false, msg: '' }; }
  catch (error) { return { threw: true, msg: error.message }; }
};
const child = await refusal({ task: CHILD, dryRun: true });
check('report refuses a child task before writing a reporter record',
  child.threw && /needs a root task/.test(child.msg)
    && !store.participantOf(store.readTask(HOME, CHILD), 'reporter'), child.msg);
for (const harness of ['cursor', 'codex']) {
  const refused = await refusal({ task: TASK, harness, dryRun: true });
  check(`report refuses ${harness} with the install-root project-layer reason`,
    refused.threw && /ADR-024/.test(refused.msg) && /project layer/.test(refused.msg), refused.msg);
}
const planned = await planReport(host, { task: TASK, dryRun: true });
let unratedReport = null;
const unratedReportSaid = await capture(async () => {
  unratedReport = await planReport(host, { task: TASK, dryRun: true, strategy: 'balanced', model: 'claude-next-9' });
});
check('a routed reporter with an unrated --model lifts that id without a decision',
  unratedReport?.model === 'claude-next-9' && !unratedReport?.decision
  && /no tuple of the merged catalog rates it/.test(unratedReportSaid), unratedReportSaid);
check('reporter MCP entry carries the root task and reporter address',
  planned.launch.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_TASK === TASK
    && planned.launch.mcpConfig.mcpServers.promptobus.env.PROMPTOBUS_ROLE === 'reporter');
check('reporter deny list is the reviewer list plus bus send',
  JSON.stringify(REPORTER_DENY) === JSON.stringify([...REVIEWER_DENY, 'mcp__promptobus__promptobus_send'])
    && JSON.stringify(planned.launch.settings.permissions.deny) === JSON.stringify(REPORTER_DENY),
  JSON.stringify(planned.launch.settings.permissions.deny));
check('reporter prompt carries the skill rules and names the two restricted MCP tools',
  /never an accepted outcome/.test(planned.prompt)
    && /promptobus_digest/.test(planned.prompt) && /promptobus_status/.test(planned.prompt)
    && /promptobus_ask/.test(planned.prompt)
    && /Do not forward or filter worker status/.test(planned.prompt));
const dry = await capture(() => report(host, { task: TASK, dryRun: true }));
check('report --dry-run prints the plan and writes neither record nor launch files',
  /dry-run: nothing written to disk, reporter not started/.test(dry)
    && !store.participantOf(store.readTask(HOME, TASK), 'reporter')
    && !planned.launch.files.some((file) => existsSync(file.path)),
  dry.slice(-400));
const cliDry = spawnSync(process.execPath, [BIN, 'report', '--task', TASK, '--dry-run'], {
  cwd: ROOT, env, encoding: 'utf8',
});
check('CLI report --dry-run dispatches without starting a reporter',
  cliDry.status === 0 && /dry-run: nothing written to disk, reporter not started/.test(cliDry.stdout)
    && !store.participantOf(store.readTask(HOME, TASK), 'reporter'),
  cliDry.stderr + cliDry.stdout.slice(-300));

const roles = [
  ['orchestrator', 'owner-session'],
  ['worker:one', 'worker-session'],
  ['reviewer:one', 'reviewer-session'],
  ['approver:one', 'approver-session'],
  ['teamlead:one', 'teamlead-session'],
];
for (const [role, session] of roles.slice(1)) {
  store.upsertParticipant(HOME, TASK, store.participantRecord(role, {
    harness: 'claude', mode: 'managed', name: role, sessionRef: session, sessionId: session,
  }));
}
store.upsertParticipant(HOME, TASK, store.participantRecord('reporter', {
  harness: 'claude', mode: 'managed', name: 'Reporter: one root task',
  sessionRef: 'reporter-session', sessionId: 'reporter-session',
  started: new Date().toISOString(),
}));
const reporter = store.participantOf(store.readTask(HOME, TASK), 'reporter');
check('reporter turn has no bus-answer debt',
  answerOwedSince(HOME, TASK, 'reporter', reporter) === null
    && guardVerdict(HOME, TASK, 'reporter', 'reporter-session') === null);
store.upsertParticipant(HOME, TASK, {
  ...reporter, metadata: { ...reporter.metadata, pending: true },
});
const duplicate = await refusal({ task: TASK, dryRun: true, sessions: {
  reporter: { state: 'alive', busy: false, stall: null, id: 'reporter-session' },
} });
check('report refuses a second live reporter during a pending lift',
  duplicate.threw && /already alive/.test(duplicate.msg), duplicate.msg);
store.upsertParticipant(HOME, TASK, reporter);
const shown = await capture(() => status(host, { task: TASK, sessions: null }));
check('status prints reporter under the root task', shown.indexOf(TASK) < shown.indexOf('reporter ·')
  && shown.includes('reporter ·'), shown.slice(0, 600));

function call(role, session, tool, args = {}, task = TASK) {
  const run = spawnSync(process.execPath, [BIN, 'mcp'], {
    cwd: ROOT,
    env: {
      ...env, PROMPTOBUS_ROLE: role, PROMPTOBUS_TASK: task,
      CLAUDE_CODE_SESSION_ID: session,
    },
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: tool, arguments: args } }) + '\n',
    encoding: 'utf8', timeout: 10_000,
  });
  const reply = run.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).at(-1);
  return { exit: run.status, error: reply?.result?.isError === true,
    text: reply?.result?.content?.[0]?.text ?? '', stderr: run.stderr };
}

for (const [role, session] of roles) {
  for (const tool of ['promptobus_digest', 'promptobus_status', 'promptobus_ask']) {
    const denied = call(role, session, tool, tool === 'promptobus_ask' ? { body: 'borrowed?' } : {});
    check(`${tool} refuses ${role} before reading or writing as user`,
      denied.error && /reporter only/.test(denied.text), denied.text);
  }
}
const unbound = call('reporter', 'stranger-session', 'promptobus_ask', { body: 'borrowed?' });
check('reporter role hint without a bound session cannot ask as user',
  unbound.error && /session|binding|holds|reporter/.test(unbound.text), unbound.text);
const page = call('reporter', 'reporter-session', 'promptobus_digest');
let digest = null;
try { digest = JSON.parse(page.text); } catch {}
check('proven reporter reads the root and child digest JSON', !page.error
  && digest?.tasks?.map((task) => task.id).join(',') === [TASK, CHILD].join(','),
  page.text.slice(0, 200));
const liveStatus = call('reporter', 'reporter-session', 'promptobus_status');
check('proven reporter reads status of the root tree', !liveStatus.error
  && liveStatus.text.includes(TASK) && liveStatus.text.includes('reporter'),
  liveStatus.text.slice(0, 240));
const sent = call('reporter', 'reporter-session', 'promptobus_ask', { body: 'Which decision is open?' });
const id = sent.text.match(/id ([^\s]+)/)?.[1];
const question = store.glanceInbox(HOME, TASK, 'orchestrator').find((message) => message.id === id);
check('proven reporter asks the root orchestrator with sender user',
  !sent.error && question?.sender === store.addrDir('user')
    && question?.body === 'Which decision is open?', sent.text);
const direct = call('reporter', 'reporter-session', 'promptobus_send', {
  to: 'orchestrator', type: 'status', body: 'forbidden',
});
check('routing refuses reporter send even when the MCP tool is reached',
  direct.error && /reporter reads and sends nothing/.test(direct.text), direct.text);
const pending = call('reporter', 'reporter-session', 'promptobus_ask', { answers: true, after: id });
check('reporter answer read says pending before the orchestrator answers',
  !pending.error && pending.text.includes(`no answer after ${id} yet`), pending.text);
store.sendMessage(HOME, TASK, {
  from: 'orchestrator', to: 'user', type: 'answer', body: 'The release gate is open.',
  session: 'owner-session',
});
const answered = call('reporter', 'reporter-session', 'promptobus_ask', { answers: true, after: id });
check('reporter reads the answer without consuming the user mailbox',
  !answered.error && /The release gate is open/.test(answered.text)
    && /message [^\s]+/.test(answered.text)
    && store.countInbox(HOME, TASK, 'user') === 1, answered.text);
const cliAsk = spawnSync(process.execPath, [BIN, 'ask', 'borrowed?', '--task', TASK], {
  cwd: ROOT, env: { ...env, PROMPTOBUS_ROLE: 'reporter', PROMPTOBUS_TASK: TASK,
    CLAUDE_CODE_SESSION_ID: 'reporter-session' },
  encoding: 'utf8',
});
check('PB-279 terminal ask still refuses the reporter participant identity',
  cliAsk.status !== 0 && /ask is for the person at a terminal/.test(cliAsk.stderr + cliAsk.stdout),
  cliAsk.stderr + cliAsk.stdout);

const stopped = [];
const fake = {
  id: 'claude',
  capabilities: { spawn: true, attach: false, activation: 'push', inspect: true, stop: true },
  phrases: { sessions: 'stand registry', unreadable: 'unreadable', stop: () => 'stop' },
  inspect: (ref) => ({ state: 'alive', busy: false, stall: null, id: ref }),
  stop: (ref) => { stopped.push(ref); return { ok: true, stopped: true, note: 'closed' }; },
};
await capture(() => stopManaged(HOME, TASK, {
  registry: createRegistry({ drivers: { claude: fake }, fallback: 'claude' }),
}));
check('done managed-session walk includes the reporter', stopped.includes('reporter-session'),
  stopped.join(', '));

const LIFT_ROOT = makeSandbox('promptobus-report-live-');
const LIFT_HOME = path.join(LIFT_ROOT, '.promptobus');
const LIFT_TASK = 'report-lift-t20260927-000000';
const stubBin = path.join(LIFT_ROOT, 'stub-bin');
const stubState = path.join(LIFT_ROOT, 'stub-state.json');
const stubLaunches = path.join(LIFT_ROOT, 'stub-launches.log');
const stubStops = path.join(LIFT_ROOT, 'stub-stops.log');
const PAUSE_TASK = 'report-paused-t20260927-000000';
const UNKNOWN_ID_TASK = 'report-unknown-id-t20260927-000000';
const pauseStarted = path.join(LIFT_ROOT, 'pause-started');
const pauseRelease = path.join(LIFT_ROOT, 'pause-release');
writeHostConfig(LIFT_ROOT, { tools: ['claude'] });
store.createTask(LIFT_HOME, { id: LIFT_TASK, title: 'report lift', owner: 'owner-session' });
stubCommand(stubBin, 'claude', `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const file = ${JSON.stringify(stubState)};
const launches = ${JSON.stringify(stubLaunches)};
const stops = ${JSON.stringify(stubStops)};
if (args[0] === '--version') { console.log('2.1.280'); process.exit(0); }
if (args[0] === 'stop') { appendFileSync(stops, args[1] + '\\n'); process.exit(0); }
if (args[0] === '--bg') {
  const name = args[args.indexOf('--name') + 1];
  const sessionId = args[args.indexOf('--session-id') + 1];
  if (name.includes(${JSON.stringify(PAUSE_TASK)})) {
    writeFileSync(${JSON.stringify(pauseStarted)}, 'started');
    const end = Date.now() + 15_000;
    while (!existsSync(${JSON.stringify(pauseRelease)}) && Date.now() < end) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    if (!existsSync(${JSON.stringify(pauseRelease)})) process.exit(3);
  }
  appendFileSync(launches, name + '\\n');
  writeFileSync(file, JSON.stringify({ name, sessionId }));
  console.log(name.includes(${JSON.stringify(UNKNOWN_ID_TASK)}) ? 'backgrounded' : 'backgrounded · deadbeef');
  process.exit(0);
}
if (args[0] === 'agents') {
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  console.log(JSON.stringify(state ? [{ id: 'deadbeef', sessionId: state.sessionId,
    name: state.name, state: 'working', pid: 4242 }] : []));
  process.exit(0);
}
process.exit(2);
`);
const oldPath = process.env.PATH;
const oldWarden = process.env.PROMPTOBUS_WARDEN;
process.env.PATH = `${stubBin}${path.delimiter}${oldPath}`;
process.env.PROMPTOBUS_WARDEN = 'off';
let liftError = '';
try {
  await capture(() => report(hostOf(LIFT_ROOT), {
    task: LIFT_TASK, tool: { ok: true, bin: path.join(stubBin, 'claude'), version: '2.1.280' },
  }));
} catch (error) {
  liftError = error.stack ?? error.message;
} finally {
  process.env.PATH = oldPath;
  if (oldWarden === undefined) delete process.env.PROMPTOBUS_WARDEN;
  else process.env.PROMPTOBUS_WARDEN = oldWarden;
}
const lifted = store.participantOf(store.readTask(LIFT_HOME, LIFT_TASK), 'reporter');
check('real report path records the reporter before launching its managed session',
  !liftError && existsSync(stubState) && lifted?.metadata?.session === 'deadbeef'
    && lifted?.metadata?.sessionId === JSON.parse(readFileSync(stubState, 'utf8')).sessionId,
  liftError || JSON.stringify(lifted?.metadata));

const launchTool = { ok: true, bin: path.join(stubBin, 'claude'), version: '2.1.280' };
const RACE_TASK = 'report-race-t20260927-000000';
store.createTask(LIFT_HOME, { id: RACE_TASK, title: 'report race', owner: 'owner-session' });
process.env.PATH = `${stubBin}${path.delimiter}${oldPath}`;
process.env.PROMPTOBUS_WARDEN = 'off';
let raceResults;
try {
  await capture(async () => {
    raceResults = await Promise.allSettled([
      report(hostOf(LIFT_ROOT), { task: RACE_TASK, tool: launchTool, permissionMode: 'bypassPermissions' }),
      report(hostOf(LIFT_ROOT), { task: RACE_TASK, tool: launchTool, permissionMode: 'manual' }),
    ]);
  });
} finally {
  process.env.PATH = oldPath;
  if (oldWarden === undefined) delete process.env.PROMPTOBUS_WARDEN;
  else process.env.PROMPTOBUS_WARDEN = oldWarden;
}
const raceRecord = store.participantOf(store.readTask(LIFT_HOME, RACE_TASK), 'reporter');
const raceSettings = JSON.parse(readFileSync(store.participantSettingsPath(LIFT_HOME, RACE_TASK, 'reporter'), 'utf8'));
const raceWinner = raceResults.findIndex((result) => result.status === 'fulfilled');
const raceLaunches = readFileSync(stubLaunches, 'utf8').trim().split('\n')
  .filter((name) => name.includes(RACE_TASK));
check('two reports planned before launch reserve one reporter and refuse the stale plan',
  raceResults.filter((result) => result.status === 'fulfilled').length === 1
    && raceResults.filter((result) => result.status === 'rejected').length === 1
    && /changed while planning|already in progress/.test(raceResults.find((result) => result.status === 'rejected')?.reason?.message)
    && raceLaunches.length === 1 && raceRecord?.metadata?.pending !== true
    && raceRecord?.metadata?.sessionId === JSON.parse(readFileSync(stubState, 'utf8')).sessionId
    && raceSettings.crossSessionInbound === (raceWinner === 0 ? 'accept' : undefined),
  JSON.stringify({ raceResults: raceResults.map((result) => result.status === 'rejected'
    ? result.reason?.message : result.status), raceLaunches, record: raceRecord?.metadata }));

const PENDING_TASK = 'report-pending-t20260927-000000';
store.createTask(LIFT_HOME, { id: PENDING_TASK, title: 'report pending', owner: 'owner-session' });
store.upsertParticipant(LIFT_HOME, PENDING_TASK, store.participantRecord('reporter', {
  harness: 'claude', mode: 'managed', name: 'Reporter: pending', sessionRef: 'Reporter: pending',
  pending: true, launchPid: process.pid,
}));
let pendingRefusal;
try { await planReport(hostOf(LIFT_ROOT), { task: PENDING_TASK }); }
catch (error) { pendingRefusal = { threw: true, msg: error.message }; }
check('a pending reporter with a live launcher refuses a second launch',
  pendingRefusal.threw && /already in progress/.test(pendingRefusal.msg), pendingRefusal.msg);

const ABANDON_TASK = 'report-abandoned-t20260927-000000';
store.createTask(LIFT_HOME, { id: ABANDON_TASK, title: 'report abandoned', owner: 'owner-session' });
store.upsertParticipant(LIFT_HOME, ABANDON_TASK, store.participantRecord('reporter', {
  harness: 'claude', mode: 'managed', name: 'Reporter: abandoned', sessionRef: 'Reporter: abandoned',
  pending: true, launchPid: Number.MAX_SAFE_INTEGER,
}));
process.env.PATH = `${stubBin}${path.delimiter}${oldPath}`;
process.env.PROMPTOBUS_WARDEN = 'off';
let abandonError = '';
try {
  await capture(() => report(hostOf(LIFT_ROOT), { task: ABANDON_TASK, tool: launchTool }));
} catch (error) {
  abandonError = error.message;
} finally {
  process.env.PATH = oldPath;
  if (oldWarden === undefined) delete process.env.PROMPTOBUS_WARDEN;
  else process.env.PROMPTOBUS_WARDEN = oldWarden;
}
const repaired = store.participantOf(store.readTask(LIFT_HOME, ABANDON_TASK), 'reporter');
check('an abandoned pending reporter with a dead launcher can be relifted',
  !abandonError && repaired?.metadata?.session === 'deadbeef'
    && repaired?.metadata?.pending !== true && repaired?.metadata?.launchPid === undefined,
  abandonError || JSON.stringify(repaired?.metadata));

const LOST_TASK = 'report-lost-t20260927-000000';
const OTHER_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
store.createTask(LIFT_HOME, { id: LOST_TASK, title: 'report lost', owner: 'owner-session' });
process.env.PATH = `${stubBin}${path.delimiter}${oldPath}`;
process.env.PROMPTOBUS_WARDEN = 'off';
let lostError = '';
const stopsBeforeLost = existsSync(stubStops) ? readFileSync(stubStops, 'utf8').trim().split('\n').length : 0;
try {
  await capture(() => report(hostOf(LIFT_ROOT), {
    task: LOST_TASK, tool: launchTool,
    awaitOptions: { sessions: () => {
      const current = store.participantOf(store.readTask(LIFT_HOME, LOST_TASK), 'reporter');
      store.upsertParticipant(LIFT_HOME, LOST_TASK, {
        ...current, metadata: { ...current.metadata, launchToken: 'other-launch',
          session: 'beefcafe', sessionId: OTHER_SESSION, pending: false },
      });
      const state = JSON.parse(readFileSync(stubState, 'utf8'));
      return [
        { id: 'beefcafe', sessionId: OTHER_SESSION, name: state.name, pid: 4243 },
        { id: 'deadbeef', sessionId: state.sessionId, name: state.name, pid: 4242 },
      ];
    } },
  }));
} catch (error) {
  lostError = error.message;
} finally {
  process.env.PATH = oldPath;
  if (oldWarden === undefined) delete process.env.PROMPTOBUS_WARDEN;
  else process.env.PROMPTOBUS_WARDEN = oldWarden;
}
const lostRecord = store.participantOf(store.readTask(LIFT_HOME, LOST_TASK), 'reporter');
const stoppedIds = existsSync(stubStops) ? readFileSync(stubStops, 'utf8').trim().split('\n') : [];
check('a lost reservation stops only the launch id when another live reporter is listed first',
  /reservation.*changed/.test(lostError) && lostRecord?.metadata?.launchToken === 'other-launch'
    && lostRecord?.metadata?.sessionId === OTHER_SESSION
    && stoppedIds.slice(stopsBeforeLost).join(',') === 'deadbeef',
  `${lostError}\n${JSON.stringify({ record: lostRecord?.metadata, stopped: stoppedIds.slice(stopsBeforeLost) })}`);

store.createTask(LIFT_HOME, { id: UNKNOWN_ID_TASK, title: 'report unknown id', owner: 'owner-session' });
const unknownRun = spawnSync(process.execPath, [BIN, 'report', '--task', UNKNOWN_ID_TASK], {
  cwd: LIFT_ROOT,
  env: { ...env, PROMPTOBUS_HOME: LIFT_HOME, PROMPTOBUS_WARDEN: 'off',
    PATH: `${stubBin}${path.delimiter}${oldPath}` },
  encoding: 'utf8',
});
const unknownIdError = unknownRun.stderr + unknownRun.stdout;
const stopsAfterUnknown = existsSync(stubStops) ? readFileSync(stubStops, 'utf8').trim().split('\n') : [];
check('a launch without a reported id stops nothing and reports the orphan',
  unknownRun.status !== 0 && /did not name its id/.test(unknownIdError) && /orphaned/.test(unknownIdError)
    && stopsAfterUnknown.length === stoppedIds.length,
  `${unknownIdError}\n${JSON.stringify(stopsAfterUnknown.slice(stoppedIds.length))}`);

store.createTask(LIFT_HOME, { id: PAUSE_TASK, title: 'report paused', owner: 'owner-session' });
const paused = spawn(process.execPath, [BIN, 'report', '--task', PAUSE_TASK], {
  cwd: LIFT_ROOT,
  env: { ...env, PROMPTOBUS_HOME: LIFT_HOME, PROMPTOBUS_WARDEN: 'off',
    PATH: `${stubBin}${path.delimiter}${oldPath}` },
});
let pausedOutput = '';
paused.stdout.on('data', (chunk) => { pausedOutput += chunk; });
paused.stderr.on('data', (chunk) => { pausedOutput += chunk; });
const pausedExit = new Promise((resolve) => { paused.on('exit', resolve); });
for (let i = 0; i < 500 && !existsSync(pauseStarted); i += 1) {
  await new Promise((resolve) => { setTimeout(resolve, 20); });
}
let sentDuringLaunch = false;
let sendError = '';
try {
  if (existsSync(pauseStarted)) {
    store.sendMessage(LIFT_HOME, PAUSE_TASK, {
      from: 'orchestrator', to: 'reporter', type: 'status', body: 'work continues', session: 'owner-session',
    });
    sentDuringLaunch = !existsSync(pauseRelease);
  }
} catch (error) {
  sendError = error.message;
} finally {
  writeFileSync(pauseRelease, 'continue');
}
const pauseCode = await pausedExit;
check('a message send completes while a reporter harness launch is paused',
  existsSync(pauseStarted) && sentDuringLaunch && pauseCode === 0 && !sendError,
  `${sendError}\n${pausedOutput.slice(-500)}`);

const STATUS_ROOT = makeSandbox('promptobus-report-status-');
const STATUS_HOME = path.join(STATUS_ROOT, '.promptobus');
const STATUS_TASK = 'report-status-t20260927-000000';
const statusBin = path.join(STATUS_ROOT, 'stub-bin');
const statusState = path.join(STATUS_ROOT, 'agents.json');
writeHostConfig(STATUS_ROOT, { tools: ['claude'] });
store.createTask(STATUS_HOME, { id: STATUS_TASK, title: 'report status', owner: 'owner-session' });
store.upsertParticipant(STATUS_HOME, STATUS_TASK, store.participantRecord('reporter', {
  harness: 'claude', mode: 'managed', name: 'Reporter: report status',
  sessionRef: 'Reporter: report status', session: 'reporter-session', sessionId: 'reporter-session',
}));
writeFileSync(statusState, JSON.stringify([{ id: 'reporter-session', sessionId: 'reporter-session',
  name: 'Reporter: report status', status: 'idle', pid: 4242 }]));
stubCommand(statusBin, 'claude', `
import { readFileSync } from 'node:fs';
if (process.argv[2] === 'agents') console.log(readFileSync(${JSON.stringify(statusState)}, 'utf8'));
else if (process.argv[2] === '--version') console.log('2.1.280');
else process.exit(2);
`);
const mcp = spawn(process.execPath, [BIN, 'mcp'], {
  cwd: STATUS_ROOT,
  env: { ...env, PROMPTOBUS_HOME: STATUS_HOME, PROMPTOBUS_WARDEN: 'off',
    PROMPTOBUS_ROLE: 'reporter', PROMPTOBUS_TASK: STATUS_TASK,
    CLAUDE_CODE_SESSION_ID: 'reporter-session', PATH: `${statusBin}${path.delimiter}${oldPath}` },
});
const mcpExit = new Promise((resolve) => { mcp.on('exit', resolve); });
const mcpLines = createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
let rpcId = 0;
const statusCall = async () => {
  const id = ++rpcId;
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'promptobus_status', arguments: {} } })}\n`);
  let timer;
  try {
    const reply = await Promise.race([
      mcpLines.next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP status reply timed out')), 10_000); }),
    ]);
    return JSON.parse(reply.value).result.content[0].text;
  } finally {
    clearTimeout(timer);
  }
};
let firstStatus;
let secondStatus;
try {
  firstStatus = await statusCall();
  writeFileSync(statusState, '[]');
  secondStatus = await statusCall();
} finally {
  mcp.stdin.end();
  mcp.kill();
  await mcpExit;
}
const firstSessionLine = firstStatus.split('\n').find((line) => line.includes('reporter ·'));
const secondSessionLine = secondStatus.split('\n').find((line) => line.includes('reporter ·'));
check('two reporter status calls in one MCP process refresh the harness session list',
  firstSessionLine?.includes('session "Reporter: report status"')
    && !firstSessionLine.includes('is not in the list')
    && secondSessionLine?.includes('session "Reporter: report status" is not in the list'),
  `${firstSessionLine}\n${secondSessionLine}`);

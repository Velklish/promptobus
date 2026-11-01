import './home.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, makeSockDir, stubCommand, writeHostConfig } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { initialTaskClaimStarted, taskServiceFixture } from './task-service-fixture.mjs';
import { processState } from '../lib/service-state.js';
import { releaseNativeReservation, reserveNativeParticipant } from '../lib/native-lifecycle.js';
import { REGISTRY } from '../lib/drivers.js';
import { readSession } from '../lib/codex-session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'promptobus.js');
const root = makeSandbox('promptobus-promptobus-done-');
const home = path.join(root, '.promptobus');
const task = 'done-user-t20260927-000000';
const owner = 'done-user-owner';
const stubBin = path.join(root, 'stub-bin');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ![
  'CLAUDE_CODE_SESSION_ID', 'CURSOR_CONVERSATION_ID', 'CODEX_THREAD_ID',
  'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_CURSOR_SESSION',
  'PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK',
].includes(key)));
Object.assign(env, { PROMPTOBUS_HOME: home, PROMPTOBUS_CODEX_HOME: path.join(root, 'native'), PROMPTOBUS_WARDEN: 'off',
  PATH: `${stubBin}${path.delimiter}${process.env.PATH}` });
process.env.PROMPTOBUS_CODEX_HOME = env.PROMPTOBUS_CODEX_HOME;

writeHostConfig(root);
stubCommand(stubBin, 'claude', `
if (process.argv[2] === 'agents') { console.log('[]'); process.exit(0); }
if (process.argv[2] === '--version') { console.log('2.1.280'); process.exit(0); }
process.exit(2);
`);
const socketDirectory = makeSockDir('a2s-').dir;
const service = await taskServiceFixture({ workspace: root, home, task, socketDirectory, env });
Object.assign(env, service.env);
try {
const store = await import('../lib/store.js');
store.createTask(home, { id: task, title: 'user asks before close', owner, adapter: { slug: 'done-user' } });

function cli(args, owned = false) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...env, ...(owned ? { CLAUDE_CODE_SESSION_ID: owner } : {}) },
  });
}

function result(run) {
  return `${run.stdout ?? ''}${run.stderr ?? ''}`;
}

const asked = cli(['ask', 'Can this task close?', '--task', task]);
check('ask registers user through the CLI', asked.status === 0
  && store.participantOf(store.readTask(home, task), 'user')?.sessionRef === null, result(asked));

for (const worker of ['after', 'swept']) {
  const { record } = reserveNativeParticipant(home, task, store.participantRecord(`worker:${worker}`, {
    harness: 'codex', mode: 'managed', sessionRef: `missing-done-user-${worker}`,
  }), null, REGISTRY);
  releaseNativeReservation(home, task, record);
  const cold = store.participantOf(store.readTask(home, task), `worker:${worker}`);
  check(`native fixture ${worker} releases only its exact never-invoked launch`,
    cold.metadata.nativeLaunchId === record.metadata.nativeLaunchId
    && cold.metadata.nativeUnlaunched === record.metadata.nativeLaunchId && !readSession(record.sessionRef));
}
store.upsertParticipant(home, task, store.participantRecord('reporter', {
  harness: 'claude', mode: 'managed', name: 'Reporter: user asks before close',
  sessionRef: 'missing-done-user-reporter', sessionId: 'missing-done-user-reporter',
}));
const names = store.readTask(home, task).participants.map((p) => store.addressOf(p));
check('the dead participant follows user in the task journal',
  names.indexOf('user') < names.indexOf('worker:after'), names.join(', '));

const answered = cli(['send', 'user', '--task', task, '--type', 'answer', '--body', 'Yes.'], true);
check('the orchestrator answers user through the CLI', answered.status === 0, result(answered));
const answers = cli(['ask', '--answers', '--task', task]);
check('the user reads the answer through the CLI', answers.status === 0
  && result(answers).includes('Yes.'), result(answers));

const files = {
  mcp: store.participantMcpPath(home, task, 'worker:after'),
  wake: store.wakeFile(home, task, 'worker:after'),
};
const reporterFiles = {
  mcp: store.participantMcpPath(home, task, 'reporter'),
  settings: store.participantSettingsPath(home, task, 'reporter'),
};
mkdirSync(store.workersDir(home, task), { recursive: true });
writeFileSync(files.mcp, '{"mcpServers":{}}\n');
writeFileSync(reporterFiles.mcp, '{"mcpServers":{}}\n');
writeFileSync(reporterFiles.settings, '{"permissions":{}}\n');
store.writeWake(home, task, 'worker:after', { socket: path.join(root, 'dead.sock'), token: 'fixture' });
check('the dead participant has an mcp-config and contact point before done',
  Object.values(files).every(existsSync), JSON.stringify(files));
check('the dead reporter has mcp-config and settings before done',
  Object.values(reporterFiles).every(existsSync), JSON.stringify(reporterFiles));

const status = cli(['status', '--task', task]);
check('status lists the user address', status.status === 0 && result(status).includes('user ·'), result(status));
const history = cli(['history', '--task', task, '--participant', 'user']);
check('history reads the user answer', history.status === 0 && result(history).includes('Yes.'), result(history));
const stop = cli(['stop', 'worker:after', '--task', task], true);
check('stop sees a dead participant after user', stop.status === 0
  && result(stop).includes('no live session'), result(stop));
const dismiss = cli(['dismiss', 'worker:after', '--task', task], true);
check('dismiss accepts a participant after user', dismiss.status === 0
  && result(dismiss).includes('dismissed from watch'), result(dismiss));
const sweep = cli(['sweep', 'worker:swept', '--task', task], true);
check('sweep accepts a dead participant after user', sweep.status === 0
  && result(sweep).includes('task stays active'), result(sweep));

const demand = cli(['warden', '--task', task]);
const claimDeadline = Date.now() + 5000;
// Auto-start is off and this fresh fixture has one initial demand. Running status
// acknowledges that entry's started message; a published mark alone does not.
const initialStatus = await service.status(), initialOwner = initialStatus.process, initialDemand = await service.demand();
let claimSample;
const started = await waitFor(async () => {
  const status = await service.status(), durableDemand = await service.demand(), mark = store.liveWarden(home, task);
  claimSample = { status, owner: initialOwner, task, initialDemand, durableDemand, mark,
    ownerState: initialOwner ? processState(initialOwner) : 'unknown' };
  return initialTaskClaimStarted(claimSample);
}, { timeoutMs: Math.max(0, claimDeadline - Date.now()) });
check('the active task with user obtains an actual shared task seat before done', demand.status === 0 && started === true,
  JSON.stringify({ result: result(demand), claimSample }));
const generation = started === true ? store.readWardenGeneration(home, task) : null;
const baselineSample = { at: Date.now(), generation, started, claim: claimSample };
const done = cli(['done', '--task', task], true);
check('done closes an ask-and-answer task through the CLI', done.status === 0
  && store.readTask(home, task).status === 'done', `${done.status}: ${result(done)}`);
check('done removes the dead participant files after user',
  !Object.values(files).some(existsSync), `${done.status}: ${result(done)}`);
check('done removes a dead reporter mcp-config and settings after ask-and-answer',
  done.status === 0 && store.readTask(home, task).status === 'done'
    && !Object.values(reporterFiles).some(existsSync), `${done.status}: ${result(done)}`);
check('done keeps user and its correspondence in the task journal',
  Boolean(store.participantOf(store.readTask(home, task), 'user'))
    && store.history(home, { task, participant: store.addrDir('user') }).entries.length > 0,
  JSON.stringify(store.readTask(home, task).participants.map((p) => store.addressOf(p))));
const warden = cli(['warden', '--task', task]);
const settled = await waitFor(() => !store.liveWarden(home, task)
  && store.readWardenExit(home, task)?.reason === 'task is closed', { timeoutMs: 5000 });
const finalGeneration = store.readWardenGeneration(home, task);
const closeReceipt = { status: warden.status, result: result(warden), settled,
  baseline: baselineSample, finalGeneration, exit: store.readWardenExit(home, task) };
writeSync(1, `  · done-user-claim-receipt: ${JSON.stringify(closeReceipt)}\n`);
check('warden exits cleanly for the closed task with user', warden.status === 0
  && result(warden).includes('inactive') && settled === true
  && started === true && finalGeneration === generation, JSON.stringify(closeReceipt));
const unknown = cli(['prune']);
check('prune is not a command', unknown.status !== 0 && /unknown command "prune"/.test(result(unknown)),
  result(unknown));
function deleteCommand(text) {
  const line = text.split('\n').map((item) => item.trim()).find((item) => item.includes('To delete:'));
  const command = line?.split('To delete:').pop()?.trim() ?? '';
  const argv = command.split(/\s+/);
  const at = argv.indexOf('done');
  return { command, args: at < 0 ? [] : argv.slice(at) };
}

const preview = cli(['done', '--task', task, '--older-than', '0'], true);
const previewText = result(preview);
const printed = deleteCommand(previewText);
check('done --older-than previews the closed journal and deletes nothing',
  preview.status === 0 && /Nothing deleted/.test(previewText)
  && existsSync(store.taskDir(home, task)), previewText);
check('the preview names done --task for the closed journal',
  printed.command.includes(`done --task ${task} --older-than 0 --yes`)
  && !printed.command.includes('done --older-than 0 --yes'),
  previewText);
const applied = cli(printed.args, true);
check('the printed command removes the journal when no task is active',
  applied.status === 0 && !existsSync(store.taskDir(home, task)), result(applied));

const live = 'done-user-live-t20260927-000001';
const closed = 'done-user-closed-t20260927-000002';
store.createTask(home, { id: live, title: 'still active beside retention', owner });
store.createTask(home, { id: closed, title: 'closed beside a live task', owner });
const beside = cli(['done', '--task', closed, '--older-than', '0'], true);
const besideText = result(beside);
const besidePrinted = deleteCommand(besideText);
const liveStatus = () => (existsSync(store.taskDir(home, live)) ? store.readTask(home, live).status : 'missing');
check('the preview names the closed task while another task is active',
  beside.status === 0 && besidePrinted.command.includes(`done --task ${closed} --older-than 0 --yes`)
  && liveStatus() === 'active'
  && existsSync(store.taskDir(home, closed)),
  besideText);
const besideApplied = cli(besidePrinted.args, true);
check('the printed command leaves the other active task open and removes the closed journal',
  besideApplied.status === 0
  && liveStatus() === 'active'
  && !existsSync(store.taskDir(home, closed)),
  result(besideApplied));
const closedService = await service.close();
check('the user-task fixture confirms physical exit of its owned shared service', closedService.stopped
  && processState(closedService.process) === 'dead');
} finally { await service.close(); }

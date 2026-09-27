import './home.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, stubCommand, writeHostConfig } from './sandbox.mjs';

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
Object.assign(env, { PROMPTOBUS_HOME: home, PROMPTOBUS_WARDEN: 'off',
  PATH: `${stubBin}${path.delimiter}${process.env.PATH}` });

writeHostConfig(root);
stubCommand(stubBin, 'claude', `
if (process.argv[2] === 'agents') { console.log('[]'); process.exit(0); }
if (process.argv[2] === '--version') { console.log('2.1.280'); process.exit(0); }
process.exit(2);
`);
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

store.upsertParticipant(home, task, store.participantRecord('worker:after', {
  harness: 'codex', mode: 'managed', sessionRef: 'missing-done-user-after',
}));
store.upsertParticipant(home, task, store.participantRecord('worker:swept', {
  harness: 'codex', mode: 'managed', sessionRef: 'missing-done-user-swept',
}));
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
const prune = cli(['prune']);
check('prune previews a task with user', prune.status === 0, result(prune));
const stop = cli(['stop', 'worker:after', '--task', task], true);
check('stop sees a dead participant after user', stop.status === 0
  && result(stop).includes('no live session'), result(stop));
const dismiss = cli(['dismiss', 'worker:after', '--task', task], true);
check('dismiss accepts a participant after user', dismiss.status === 0
  && result(dismiss).includes('dismissed from watch'), result(dismiss));
const sweep = cli(['sweep', 'worker:swept', '--task', task], true);
check('sweep accepts a dead participant after user', sweep.status === 0
  && result(sweep).includes('task stays active'), result(sweep));

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
check('warden exits cleanly for the closed task with user', warden.status === 0
  && result(warden).includes('task is closed'), `${warden.status}: ${result(warden)}`);

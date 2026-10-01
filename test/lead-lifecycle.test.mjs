import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, planParticipant, HANG_FIRST_VAR } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { bus, participantOf } from '../lib/store.js';
import { ownerOf } from '../dist/index.js';
import { codexDriver } from '../lib/driver-codex.js';
import { holderAsk, holderAlive, pidAlive, readSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-lead-lifecycle-');
writeHostConfig(root, { tools: ['codex'] });
writeFileSync(path.join(root, 'AGENTS.md'), 'Read task metadata before doing the assignment.\n');
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner-home');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}\n');
const env = { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_OWNER_CODEX_HOME: ownerHome,
  PROMPTOBUS_WARDEN: 'off' };
const host = hostOf(root);
const task = 'lead-lifecycle-t20261001-000001';
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Recover this root\nRead the task metadata.\n');
const cliFile = path.resolve('bin/promptobus.js');
const cli = (args, extra = {}) => spawnSync(process.execPath, [cliFile, ...args], {
  cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 45000,
});
const core = () => bus(host.promptobusHome(), { cli: host.version });
const owner = () => participantOf(core().readTask(task), 'orchestrator');
planParticipant(harness.home, 'orchestrator', { turns: [
  { do: [{ tool: 'promptobus_task', args: { task } }] },
  { do: [{ tool: 'promptobus_task', args: { task } }] },
] });
const started = cli(['lead', '--brief', brief, '--task', task]);
check('managed root native holder launches after complete task binding', started.status === 0,
  `${started.status} ${started.stdout} ${started.stderr}`);
const originalOwner = owner();
const ref = originalOwner.sessionRef;
const first = await waitFor(() => {
  const record = readSession(ref, env);
  return record?.turns >= 1 && record.busy === false ? record : null;
}, { timeoutMs: 15000 });
check('managed root completes its first task-metadata turn', first?.lastTurn?.status === 'completed');
const creation = core().readTask(task).created;
await holderAsk(ref, 'shutdown', {}, env);
await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });
unlinkSync(brief);
const resumed = cli(['lead', '--resume', '--task', task]);
check('resume succeeds without the original assignment file', resumed.status === 0,
  `${resumed.status} ${resumed.stdout} ${resumed.stderr}`);
const second = await waitFor(() => {
  const record = readSession(ref, env);
  return record?.turns >= 2 && record.busy === false ? record : null;
}, { timeoutMs: 15000 });
check('resume preserves the original native owner and journal creation',
  second?.threadId === first?.threadId && second?.turns === 2
  && ownerOf(owner()) === ownerOf(originalOwner) && core().readTask(task).created === creation);
await holderAsk(ref, 'shutdown', {}, env);
await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });
const nativeThreadFile = path.join(harness.home, 'threads', first.threadId + '.json');
const emptyHistory = JSON.parse(readFileSync(nativeThreadFile, 'utf8'));
emptyHistory.turns = [];
writeFileSync(nativeThreadFile, JSON.stringify(emptyHistory));
const recovered = cli(['lead', '--resume', '--task', task]);
const third = await waitFor(() => {
  const record = readSession(ref, env);
  return record?.turns >= 3 && record.busy === false ? record : null;
}, { timeoutMs: 15000 });
const restoredHistory = JSON.parse(readFileSync(nativeThreadFile, 'utf8'));
check('an owner bound before assignment delivery replays immutable scope from its retained record',
  recovered.status === 0 && third?.initialPrompt === first.initialPrompt
  && restoredHistory.turns[0].items[0].content[0].text.includes('Recover this root')
  && restoredHistory.turns[0].items[0].content[0].text.includes('Recovery continuation'));
await holderAsk(ref, 'shutdown', {}, env);
await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });
const retainedBefore = readFileSync(path.join(second.codexHome, 'config.toml'), 'utf8');
const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 20 })).toString('base64url');
writeFileSync(path.join(ownerHome, 'auth.json'), JSON.stringify({ tokens: {
  access_token: `fixture.${payload}.fixture`, refresh_token: 'owner-retained',
} }));
const expired = cli(['lead', '--resume', '--task', task]);
check('resume refuses short-lived owner auth without deleting retained history or ownership',
  expired.status === 1 && /ten minutes|10 minutes/.test(`${expired.stdout}${expired.stderr}`)
  && readSession(ref, env)?.threadId === first.threadId && existsSync(second.codexHome)
  && readFileSync(path.join(second.codexHome, 'config.toml'), 'utf8') === retainedBefore
  && ownerOf(owner()) === ownerOf(originalOwner),
  `${expired.status} ${expired.stdout} ${expired.stderr}`);
const stopped = cli(['stop', 'orchestrator', '--task', task], { CODEX_THREAD_ID: first.threadId });
check('stop cleans a dead managed Codex root home without closing its task',
  stopped.status === 0 && !existsSync(second.codexHome) && !readSession(ref, env)
  && core().readTask(task).status === 'active', `${stopped.status} ${stopped.stdout}${stopped.stderr}`);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}\n');
writeFileSync(brief, '# Failed first turn\nKeep recovery history.\n');
const failedTask = 'lead-lifecycle-t20261001-000002';
const failed = cli(['lead', '--brief', brief, '--task', failedTask], {
  [HANG_FIRST_VAR]: '1', PROMPTOBUS_CODEX_READY_MS: '1000',
});
const failedOwner = participantOf(core().readTask(failedTask), 'orchestrator');
const failedRecord = readSession(failedOwner.sessionRef, env);
check('a bound first-turn startup failure keeps its matching root record and private history',
  failed.status === 1 && /lead --resume/.test(`${failed.stdout}${failed.stderr}`)
  && failedRecord?.threadId === ownerOf(failedOwner) && existsSync(failedRecord.codexHome)
  && !holderAlive(failedOwner.sessionRef, env),
  `${failed.status} ${failed.stdout} ${failed.stderr}`);
await codexDriver.stop(failedOwner.sessionRef);
harness.restore();

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
import { holderAsk, holderAlive, pidAlive, readSession, writeSession } from '../lib/codex-session.js';

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
// Above the holder's 60s thread-start budget. A 45s kill left the journal
// uncreated, and the next read aborted the file with "task is not in".
const CLI_MS = 120_000;
const cli = (args, extra = {}) => spawnSync(process.execPath, [cliFile, ...args], {
  cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: CLI_MS,
});
const metaOf = (id) => waitFor(() => {
  try { return core().readTask(id); } catch { return null; }
}, { timeoutMs: 5_000 });
const readJson = (file) => waitFor(() => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}, { timeoutMs: 10_000 });
const readText = (file) => waitFor(() => {
  try {
    const raw = readFileSync(file, 'utf8');
    return raw.length ? raw : null;
  } catch { return null; }
}, { timeoutMs: 10_000 });
const core = () => bus(host.promptobusHome(), { cli: host.version });
const owner = async () => participantOf(await metaOf(task), 'orchestrator');
planParticipant(harness.home, 'orchestrator', { turns: [
  { do: [{ tool: 'promptobus_task', args: { task } }] },
  { do: [{ tool: 'promptobus_task', args: { task } }] },
] });
const started = cli(['lead', '--permission-mode', 'full-access', '--brief', brief, '--task', task]);
check('managed root native holder launches after complete task binding', started.status === 0,
  `${started.status} ${started.stdout} ${started.stderr}`);
const originalOwner = await owner();
const ref = originalOwner?.sessionRef;
const first = ref ? await waitFor(() => {
  const record = readSession(ref, env);
  return record?.turns >= 1 && record.busy === false ? record : null;
}, { timeoutMs: 15000 }) : null;
check('managed root completes its first task-metadata turn', first?.lastTurn?.status === 'completed');
const initialHistory = first?.threadId
  ? await readJson(path.join(harness.home, 'threads', first.threadId + '.json')) : null;
check('new root persists its original assignment as a user message before binding without duplicate first input',
  first?.initialAssignmentInjected === true && initialHistory?.injectedItems?.[0]?.content?.[0]?.text === first.initialPrompt
  && !initialHistory?.firstRpc?.params?.input?.[0]?.text?.includes('Recover this root'),
  initialHistory ? '' : `TIMEOUT after 10000 ms waiting for the thread file of ${first?.threadId ?? 'no thread'}`);

const creation = (await metaOf(task))?.created;
if (ref) await holderAsk(ref, 'shutdown', {}, env);
if (ref) await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });
unlinkSync(brief);
const resumed = cli(['lead', '--resume', '--task', task]);
check('resume succeeds without the original assignment file', resumed.status === 0,
  `${resumed.status} ${resumed.stdout} ${resumed.stderr}`);
const second = ref ? await waitFor(() => {
  const record = readSession(ref, env);
  return record?.turns >= 2 && record.busy === false ? record : null;
}, { timeoutMs: 15000 }) : null;
check('resume preserves the original native owner and journal creation',
  second?.threadId === first?.threadId && second?.turns === 2
  && ownerOf(await owner()) === ownerOf(originalOwner) && (await metaOf(task))?.created === creation);
if (ref) await holderAsk(ref, 'shutdown', {}, env);
if (ref) await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });
const nativeThreadFile = path.join(harness.home, 'threads', `${first?.threadId ?? 'missing'}.json`);
const emptyHistory = await readJson(nativeThreadFile);
if (emptyHistory && second) {
  emptyHistory.turns = [];
  emptyHistory.injectedItems = [];
  writeFileSync(nativeThreadFile, JSON.stringify(emptyHistory));
  writeSession({ ...second, initialAssignmentInjected: false }, env);
}
const recovered = cli(['lead', '--resume', '--task', task]);
const third = ref ? await waitFor(() => {
  const record = readSession(ref, env);
  return record?.turns >= 3 && record.busy === false ? record : null;
}, { timeoutMs: 15000 }) : null;
const restoredHistory = await readJson(nativeThreadFile);
check('an owner bound before assignment delivery replays immutable scope from its retained record',
  recovered.status === 0 && third?.initialPrompt === first.initialPrompt
  && restoredHistory?.turns?.[0]?.items?.[0]?.content?.[0]?.text?.includes('Recover this root')
  && restoredHistory?.turns?.[0]?.items?.[0]?.content?.[0]?.text?.includes('Recovery continuation'),
  restoredHistory ? '' : `TIMEOUT after 10000 ms waiting for ${nativeThreadFile}`);
if (ref) await holderAsk(ref, 'shutdown', {}, env);
if (ref) await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });
const retainedBefore = second?.codexHome ? await readText(path.join(second.codexHome, 'config.toml')) : null;
const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 20 })).toString('base64url');
writeFileSync(path.join(ownerHome, 'auth.json'), JSON.stringify({ tokens: {
  access_token: `fixture.${payload}.fixture`, refresh_token: 'owner-retained',
} }));
const expired = cli(['lead', '--resume', '--task', task]);
check('resume refuses short-lived owner auth without deleting retained history or ownership',
  expired.status === 1 && /ten minutes|10 minutes/.test(`${expired.stdout}${expired.stderr}`)
  && ref && readSession(ref, env)?.threadId === first?.threadId && second?.codexHome && existsSync(second.codexHome)
  && (second?.codexHome ? await readText(path.join(second.codexHome, 'config.toml')) : null) === retainedBefore
  && ownerOf(await owner()) === ownerOf(originalOwner),
  `${expired.status} ${expired.stdout} ${expired.stderr}`);
const stopped = cli(['stop', 'orchestrator', '--task', task],
  first?.threadId ? { CODEX_THREAD_ID: first.threadId } : {});
check('stop cleans a dead managed Codex root home without closing its task',
  stopped.status === 0 && second?.codexHome && !existsSync(second.codexHome) && ref && !readSession(ref, env)
  && (await metaOf(task))?.status === 'active', `${stopped.status} ${stopped.stdout}${stopped.stderr}`);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}\n');
writeFileSync(brief, '# Failed first turn\nKeep recovery history.\n');
const failedTask = 'lead-lifecycle-t20261001-000002';
const failed = cli(['lead', '--permission-mode', 'full-access', '--brief', brief, '--task', failedTask], {
  [HANG_FIRST_VAR]: '1', PROMPTOBUS_CODEX_READY_MS: '20000',
});
const failedOwner = participantOf(await metaOf(failedTask), 'orchestrator');
const failedRecord = failedOwner?.sessionRef ? readSession(failedOwner.sessionRef, env) : null;
check('a bound first-turn startup failure keeps its matching root record and private history',
  failed.status === 1 && /lead --resume/.test(`${failed.stdout}${failed.stderr}`)
  && failedRecord?.threadId === ownerOf(failedOwner) && failedRecord?.codexHome && existsSync(failedRecord.codexHome)
  && failedOwner?.sessionRef && !holderAlive(failedOwner.sessionRef, env),
  `${failed.status} ${failed.stdout} ${failed.stderr}`);
if (failedOwner?.sessionRef) await codexDriver.stop(failedOwner.sessionRef);
harness.restore();

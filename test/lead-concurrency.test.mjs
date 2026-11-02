import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, PROBE_VAR, readTrace, THREAD_DELAY_VAR } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { bus, participantOf, taskExists } from '../lib/store.js';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { holderAlive, holderAsk, pidAlive, readSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-lead-');
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'owner-home');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":"credentials"}\n');
const env = { ...process.env, CODEX_HOME: ownerHome, PROMPTOBUS_OWNER_CODEX_HOME: ownerHome,
  PROMPTOBUS_WARDEN: 'off' };
const host = hostOf(root);
const task = 'lead-concurrency-t20261001-000001';
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Concurrent root\nKeep the only launcher alive.\n');
const cliFile = path.resolve('bin/promptobus.js');
const args = ['lead', '--permission-mode', 'full-access', '--brief', brief, '--task', task];
const privateHome = participantCodexHome({ task, address: 'orchestrator' }, env);
const winner = spawn(process.execPath, [cliFile, ...args], {
  cwd: root, env: { ...env, [THREAD_DELAY_VAR]: '1500' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
winner.stdout.on('data', (chunk) => { output += chunk; });
winner.stderr.on('data', (chunk) => { output += chunk; });
const completion = new Promise((resolve) => winner.once('exit', resolve));
const reserved = await waitFor(() => existsSync(path.join(privateHome, 'auth.json'))
  && !taskExists(host.promptobusHome(), task), { timeoutMs: 10000 });
check('first launcher has a private home before logical task birth', reserved);
const auth = readFileSync(path.join(privateHome, 'auth.json'), 'utf8');
const loser = spawnSync(process.execPath, [cliFile, ...args], {
  cwd: root, env, encoding: 'utf8', timeout: 20000,
});
check('a concurrent same-task launch refuses before touching the winner home',
  loser.status === 1 && /another live root launcher/.test(loser.stdout + loser.stderr)
  && existsSync(privateHome) && readFileSync(path.join(privateHome, 'auth.json'), 'utf8') === auth,
  `${loser.status} ${loser.stdout}${loser.stderr}`);
const winnerCode = await completion;
const meta = bus(host.promptobusHome(), { cli: host.version }).readTask(task);
const owner = participantOf(meta, 'orchestrator');
const record = readSession(owner.sessionRef, env);
check('winning launcher binds exactly one surviving native owner and releases its lease',
  winnerCode === 0 && record?.threadId === owner.metadata.owner && existsSync(privateHome)
  && !existsSync(path.join(host.promptobusHome(), 'lead-launches', task)), output);

const shutdown = await holderAsk(owner.sessionRef, 'shutdown', { launchId: record.launchId }, env);
if (!shutdown.ok || !shutdown.stopped || shutdown.launchId !== record.launchId) throw new Error('Original owned holder declined fixture shutdown');
const dead = await waitFor(() => !holderAlive(owner.sessionRef, env) && !pidAlive(record.appPid), { timeoutMs: 10000 });
if (!dead) throw new Error('concurrent resume requires confirmed exit of its original owned native processes');
const history = path.join(harness.home, 'threads', `${record.threadId}.json`), historyBefore = readFileSync(history, 'utf8');
const resumeArgs = ['lead', '--resume', '--task', task];
const resumed = spawn(process.execPath, [cliFile, ...resumeArgs], {
  cwd: root, env: { ...env, [PROBE_VAR]: 'thread-resume-held' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let resumeOutput = '';
resumed.stdout.on('data', chunk => { resumeOutput += chunk; });
resumed.stderr.on('data', chunk => { resumeOutput += chunk; });
const resumedCompletion = new Promise(resolve => resumed.once('exit', resolve));
try {
  const held = await waitFor(() => readTrace(harness.home, 'orchestrator').find(entry =>
    entry.kind === 'native-api-held' && entry.method === 'thread/resume' && entry.threadId === record.threadId), { timeoutMs: 10000 });
  if (!held) throw new Error(`resume did not reach its actual owned API barrier: ${resumeOutput}`);
  const staged = readSession(owner.sessionRef, env);
  const refused = spawnSync(process.execPath, [cliFile, ...resumeArgs], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  const unchanged = readSession(owner.sessionRef, env);
  check('a concurrent explicit resume refuses the live new holder without overwriting its generation, home or retained native history',
    refused.status === 1 && /still has a live Codex/.test(refused.stdout + refused.stderr)
      && staged.launchId !== record.launchId && unchanged.launchId === staged.launchId && unchanged.threadId === record.threadId
      && readFileSync(history, 'utf8') === historyBefore && readFileSync(path.join(privateHome, 'auth.json'), 'utf8') === auth
      && readTrace(harness.home, 'orchestrator').filter(entry => entry.kind === 'native-api-held').length === 1,
    `${refused.status} ${refused.stdout}${refused.stderr}`);
} finally {
  mkdirSync(path.join(harness.home, 'resume-release'), { recursive: true });
  writeFileSync(path.join(harness.home, 'resume-release', record.threadId), 'release\n');
}
const resumedCode = await resumedCompletion;
const next = readSession(owner.sessionRef, env);
check('the single winning resume confirms the same native ID and store on a new captured child generation',
  resumedCode === 0 && next.threadId === record.threadId && next.codexHome === record.codexHome
    && next.launchId !== record.launchId && next.nativeAdmissionTransition.previousLaunchId === record.launchId
    && next.nativeAdmissionEvidence.method === 'thread/resume' && next.nativeAdmission.nativeId === record.threadId
    && next.nativeAdmission.process.pid !== record.nativeAdmission.process.pid
    && !existsSync(path.join(host.promptobusHome(), 'lead-launches', task)), resumeOutput);
const stopped = await codexDriver.stop(owner.sessionRef);
check('the concurrency fixture confirms its winning native generation is stopped', stopped.ok === true && stopped.stopped === true, stopped.note);
harness.restore();

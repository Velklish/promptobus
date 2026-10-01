import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, THREAD_DELAY_VAR } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { bus, participantOf, taskExists } from '../lib/store.js';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { readSession } from '../lib/codex-session.js';

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
const args = ['lead', '--brief', brief, '--task', task];
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
await codexDriver.stop(owner.sessionRef);
harness.restore();

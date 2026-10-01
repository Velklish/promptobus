import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { FIRST_DELAY_VAR, installHarness, planParticipant, traceFile } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { bus, participantOf } from '../lib/store.js';
import { holderAlive, holderAsk, pidAlive, readSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-turn-reservation-');
writeHostConfig(root, { tools: ['codex'] });
writeFileSync(path.join(root, 'AGENTS.md'), 'Read task metadata.\n');
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'durable-owner');
mkdirSync(ownerHome);
const token = label => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, label })).toString('base64url')}.fixture`;
const auth = label => JSON.stringify({ auth_mode: 'chatgpt', tokens: {
  access_token: token(label), id_token: 'fixture', account_id: 'fixture-account', refresh_token: 'owner-only',
} });
writeFileSync(path.join(ownerHome, 'auth.json'), auth('initial'));
const env = { ...process.env, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, PROMPTOBUS_WARDEN: 'off', [FIRST_DELAY_VAR]: '1000' };
const task = 'turn-reservation-t20261001-000001';
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Turn reservation\nRead task metadata.\n');
planParticipant(harness.home, 'orchestrator', { turns: [
  { do: [{ wait: 800 }] }, { do: [{ wait: 500 }] }, { do: [] },
] });
const started = spawnSync(process.execPath, [path.resolve('bin/promptobus.js'), 'lead', '--brief', brief, '--task', task, '--permission-mode', 'full-access'], {
  cwd: root, env, encoding: 'utf8', timeout: 45000,
});
check('managed holder starts turn A', started.status === 0,
  `${started.status} ${started.stdout} ${started.stderr}`);
const host = hostOf(root);
const owner = participantOf(bus(host.promptobusHome(), { cli: host.version }).readTask(task), 'orchestrator');
const ref = owner.sessionRef;
try {
  const initial = readSession(ref, env);
  const turnA = initial.currentTurnId;
  const privateAuth = path.join(initial.codexHome, 'auth.json');
  const trace = traceFile(harness.home, 'orchestrator');
  const events = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const turn = () => holderAsk(ref, 'rpc', { method: 'turn/start', params: {
    threadId: initial.threadId, input: [{ type: 'text', text: 'Continue in the same thread.' }],
  } }, env);
  const acceptedB = await turn();
  const pendingB = await holderAsk(ref, 'status', {}, env);
  check('native acceptance reserves turn B before its started notification',
    acceptedB.turn?.id && acceptedB.turn.id !== turnA && pendingB.busy === true
    && !events().some(event => event.kind === 'turn-start' && event.turnId === acceptedB.turn.id),
    JSON.stringify({ acceptedB, busy: pendingB.busy, currentTurnId: pendingB.currentTurnId, turnA }));
  await waitFor(() => events().some(event => event.kind === 'turn-end' && event.turnId === turnA), { timeoutMs: 10000 });
  const afterA = await holderAsk(ref, 'status', {}, env);
  check('delayed completion of A preserves the accepted B reservation',
    afterA.busy === true && !events().some(event => event.kind === 'turn-start' && event.turnId === acceptedB.turn.id),
    JSON.stringify({ busy: afterA.busy, currentTurnId: afterA.currentTurnId, acceptedB: acceptedB.turn.id }));
  const before = readFileSync(privateAuth, 'utf8');
  writeFileSync(path.join(ownerHome, 'auth.json'), auth('fresh'));
  let refusal = '';
  try { await turn(); } catch (error) { refusal = error.message; }
  check('changed owner auth cannot reload while accepted B awaits its started notification',
    /active turn/.test(refusal) && readFileSync(privateAuth, 'utf8') === before,
    JSON.stringify({ refusal, privateAuthChanged: readFileSync(privateAuth, 'utf8') !== before }));
} finally {
  await holderAsk(ref, 'shutdown', {}, env);
  await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });
}

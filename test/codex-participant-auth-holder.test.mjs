import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { AUTH_RELOAD_DELAY_VAR, installHarness, planParticipant } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { hostOf } from '../lib/host.js';
import { bus, participantOf } from '../lib/store.js';
import { holderAlive, holderAsk, pidAlive, readSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-auth-holder-');
writeHostConfig(root, { tools: ['codex'] });
writeFileSync(path.join(root, 'AGENTS.md'), 'Read task metadata.\n');
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const ownerHome = path.join(root, 'durable-owner');
mkdirSync(ownerHome);
const token = label => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, label })).toString('base64url')}.fixture`;
const auth = label => JSON.stringify({ auth_mode: 'chatgpt', tokens: {
  access_token: token(label), id_token: 'fixture', account_id: 'fixture-account', refresh_token: 'owner-refresh-retained',
} });
writeFileSync(path.join(ownerHome, 'auth.json'), auth('initial'));
const env = { ...process.env, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, CODEX_HOME: '/missing-ephemeral-home', PROMPTOBUS_WARDEN: 'off', [AUTH_RELOAD_DELAY_VAR]: '300' };
const task = 'auth-holder-t20261001-000001';
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Auth lifecycle\nRead task metadata.\n');
planParticipant(harness.home, 'orchestrator', { turns: [
  { do: [] }, { do: [{ wait: 800 }] }, { do: [] }, { do: [{ wait: 800 }] }, { do: [] },
] });
const started = spawnSync(process.execPath, [path.resolve('bin/promptobus.js'), 'lead', '--brief', brief, '--task', task], {
  cwd: root, env, encoding: 'utf8', timeout: 45000,
});
check('holder starts with a durable owner source despite a missing scoped home', started.status === 0,
  `${started.status} ${started.stdout} ${started.stderr}`);
const host = hostOf(root);
const owner = participantOf(bus(host.promptobusHome(), { cli: host.version }).readTask(task), 'orchestrator');
const ref = owner.sessionRef;
const first = await waitFor(() => {
  const record = readSession(ref, env);
  return record?.turns >= 1 && record.busy === false ? record : null;
}, { timeoutMs: 15000 });
const privateAuth = path.join(first.codexHome, 'auth.json');
check('registry records the original owner home without storing auth secrets',
  first.authOwnerHome === ownerHome && !JSON.stringify(first).includes('owner-refresh-retained'));
const turn = () => holderAsk(ref, 'rpc', { method: 'turn/start', params: {
  threadId: first.threadId, input: [{ type: 'text', text: 'Continue in the same thread.' }],
} }, env);
await turn();
const before = readFileSync(privateAuth, 'utf8');
const fresh = auth('fresh');
writeFileSync(path.join(ownerHome, 'auth.json'), fresh);
let busyRefusal = '';
try { await turn(); } catch (error) { busyRefusal = error.message; }
check('changed owner auth after native turn acceptance refuses before private credentials change',
  /active turn/.test(busyRefusal) && readFileSync(privateAuth, 'utf8') === before, busyRefusal);
await waitFor(() => readSession(ref, env)?.turns >= 2 && readSession(ref, env)?.busy === false, { timeoutMs: 10000 });
await turn();
const final = await waitFor(() => {
  const record = readSession(ref, env);
  return record?.turns >= 3 && record.busy === false ? record : null;
}, { timeoutMs: 10000 });
const snapshot = JSON.parse(readFileSync(privateAuth, 'utf8'));
check('the next idle turn reloads owner access through public account/read without replacing the thread',
  final.threadId === first.threadId && final.appPid === first.appPid && final.lastTurn?.status === 'completed'
  && final.methodsCalled.includes('account/read') && snapshot.tokens.access_token === JSON.parse(fresh).tokens.access_token);
check('holder reload keeps the owner file unchanged and omits its refresh token',
  readFileSync(path.join(ownerHome, 'auth.json'), 'utf8') === fresh && snapshot.tokens.refresh_token === '');
const authA = auth('overlap-A'), authB = auth('overlap-B');
writeFileSync(path.join(ownerHome, 'auth.json'), authA);
const firstOverlap = turn();
await waitFor(() => JSON.parse(readFileSync(privateAuth, 'utf8')).tokens.access_token === JSON.parse(authA).tokens.access_token,
  { timeoutMs: 10000 });
writeFileSync(path.join(ownerHome, 'auth.json'), authB);
const secondOverlap = turn().then(() => '', error => error.message);
await firstOverlap;
const overlapRefusal = await secondOverlap;
check('overlapping starts serialize deferred auth reload and read current busy state before the second write',
  /active turn/.test(overlapRefusal)
  && JSON.parse(readFileSync(privateAuth, 'utf8')).tokens.access_token === JSON.parse(authA).tokens.access_token,
  overlapRefusal);
await waitFor(() => readSession(ref, env)?.turns >= 4 && readSession(ref, env)?.busy === false, { timeoutMs: 10000 });
await turn();
await waitFor(() => readSession(ref, env)?.turns >= 5 && readSession(ref, env)?.busy === false, { timeoutMs: 10000 });
check('deferred overlapping owner update is applied on the next idle turn',
  JSON.parse(readFileSync(privateAuth, 'utf8')).tokens.access_token === JSON.parse(authB).tokens.access_token);
await holderAsk(ref, 'shutdown', {}, env);
await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });

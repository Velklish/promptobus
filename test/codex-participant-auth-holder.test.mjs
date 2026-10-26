import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { installHarness, planParticipant, readTrace } from './harness-codex.mjs';
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
const initialAuth = auth('initial');
writeFileSync(path.join(ownerHome, 'auth.json'), initialAuth);
const env = { ...process.env, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, CODEX_HOME: '/missing-ephemeral-home', PROMPTOBUS_WARDEN: 'off' };
const task = 'auth-holder-t20261001-000001';
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Auth lifecycle\nRead task metadata.\n');
planParticipant(harness.home, 'orchestrator', { turns: [
  { do: [] }, { do: [{ wait: 800 }] }, { do: [] }, { do: [{ wait: 800 }] }, { do: [] },
] });
const started = spawnSync(process.execPath, [path.resolve('bin/promptobus.js'), 'lead', '--permission-mode', 'full-access', '--brief', brief, '--task', task], {
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
const attempts = await Promise.all([turn(), turn(), turn()].map(p => p.then(() => '', error => error.message)));
const after = readSession(ref, env);
check('idle and overlapping retries refuse changed owner access before another turn/start',
  attempts.every(reason => /fresh lift/.test(reason)) && after.turns === 2
  && after.threadId === first.threadId && after.appPid === first.appPid
  && readTrace(harness.home, 'orchestrator').filter(event => event.kind === 'turn-start').length === 2);
const snapshot = JSON.parse(readFileSync(privateAuth, 'utf8'));
check('holder refusal keeps the owner fixture and access-only private snapshot unchanged',
  readFileSync(path.join(ownerHome, 'auth.json'), 'utf8') === fresh
  && readFileSync(privateAuth, 'utf8') === before && snapshot.tokens.refresh_token === '');
check('holder does not call account/read to claim a cached credential reload',
  !after.methodsCalled.includes('account/read'));
check('holder refusal does not expose synthetic access or refresh bytes',
  ![busyRefusal, ...attempts].some(reason => [JSON.parse(fresh).tokens.access_token, 'owner-refresh-retained'].some(secret => reason.includes(secret))));
writeFileSync(path.join(ownerHome, 'auth.json'), initialAuth);
let restoredRefusal = '';
try { await turn(); } catch (error) { restoredRefusal = error.message; }
check('restoring old owner bytes does not revive the running holder',
  readFileSync(path.join(ownerHome, 'auth.json'), 'utf8') === initialAuth
  && /fresh lift/.test(restoredRefusal) && readSession(ref, env).turns === 2);
writeFileSync(path.join(ownerHome, 'auth.json'), fresh);
await holderAsk(ref, 'shutdown', {}, env);
await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });
const resumed = spawnSync(process.execPath, [path.resolve('bin/promptobus.js'), 'lead', '--resume', '--task', task], {
  cwd: root, env, encoding: 'utf8', timeout: 45000,
});
check('supported resume lifts a fresh app-server after confirmed Stop', resumed.status === 0, String(resumed.status) + ' ' + resumed.stdout + resumed.stderr);
const final = await waitFor(() => {
  const record = readSession(ref, env);
  return record?.turns >= 3 && record.busy === false ? record : null;
}, { timeoutMs: 15000 });
check('fresh lift preserves managed thread identity and loads fresh access without owner refresh',
  final.threadId === first.threadId && final.appPid !== first.appPid && final.launchId !== first.launchId
  && JSON.parse(readFileSync(privateAuth, 'utf8')).tokens.access_token === JSON.parse(fresh).tokens.access_token
  && JSON.parse(readFileSync(privateAuth, 'utf8')).tokens.refresh_token === ''
  && readFileSync(path.join(ownerHome, 'auth.json'), 'utf8') === fresh);
await holderAsk(ref, 'shutdown', {}, env);
await waitFor(() => !holderAlive(ref, env) && !pidAlive(readSession(ref, env)?.appPid), { timeoutMs: 10000 });

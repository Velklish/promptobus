import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { scheduled, observe, receipt } from './fixture-order.mjs';
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
const env = { ...process.env, PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, PROMPTOBUS_WARDEN: 'off', [FIRST_DELAY_VAR]: scheduled('started-B') || scheduled('held-B') ? '1000' : '0' };
const holdB = !scheduled('started-B');
const releaseA = path.join(root, 'release-A');
const releaseB = path.join(root, 'release-B');
if (holdB) env.CODEX_STUB_RESERVATION_GATE = releaseB;
const task = 'turn-reservation-t20261001-000001';
const brief = path.join(root, 'brief.md');
writeFileSync(brief, '# Turn reservation\nRead task metadata.\n');
planParticipant(harness.home, 'orchestrator', { turns: [
  { do: [{ untilFile: releaseA }] }, { do: [{ wait: 500 }] }, { do: [] },
] });
const started = spawnSync(process.execPath, [path.resolve('bin/promptobus.js'), 'lead', '--brief', brief, '--task', task, '--permission-mode', 'full-access'], {
  cwd: root, env, encoding: 'utf8', timeout: 45000,
});
check('managed holder starts turn A', started.status === 0,
  `${started.status} ${started.stdout} ${started.stderr}`);
const host = hostOf(root);
const owner = participantOf(bus(host.promptobusHome(), { cli: host.version }).readTask(task), 'orchestrator');
const ref = owner.sessionRef;
const initial = readSession(ref, env);
const pids = [initial.holderPid, initial.appPid];
try {
  const turnA = initial.currentTurnId;
  const privateAuth = path.join(initial.codexHome, 'auth.json');
  const trace = traceFile(harness.home, 'orchestrator');
  const events = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const turn = () => holderAsk(ref, 'rpc', { method: 'turn/start', params: {
    threadId: initial.threadId, input: [{ type: 'text', text: 'Continue in the same thread.' }],
  } }, env);
  const acceptedB = await turn();
  check('A has not ended when the controller observes B acceptance', !!turnA && !events().some(e => e.kind === 'turn-end' && e.turnId === turnA));
  const reserved = await holderAsk(ref, 'status', {}, env);
  check('the holder has reserved B while A is still active', reserved.activeTurns?.includes(turnA)
    && reserved.activeTurns.includes(acceptedB.turn.id), JSON.stringify(reserved.activeTurns));
  writeFileSync(releaseA, 'accepted B');
  {
    receipt('accepted B', { turnA, turnB: acceptedB.turn.id });
    const reached = await observe('B controller resumes', () => events().find(event =>
      event.turnId === acceptedB.turn.id && event.kind === (holdB ? 'reservation-gate' : 'turn-start')), 10000);
    check('controller delay reached the selected B event', !!reached, JSON.stringify(events()));
  }
  const pendingB = await holderAsk(ref, 'status', {}, env);
  check('native acceptance reserves turn B before its started notification',
    acceptedB.turn?.id && acceptedB.turn.id !== turnA && pendingB.busy === true
    && !events().some(event => event.kind === 'turn-start' && event.turnId === acceptedB.turn.id),
    JSON.stringify({ acceptedB, busy: pendingB.busy, currentTurnId: pendingB.currentTurnId, turnA }));
  check('producer completed A', await waitFor(() => events().some(event => event.kind === 'turn-end' && event.turnId === turnA), { timeoutMs: 10000 }));
  let afterA;
  await waitFor(async () => {
    afterA = await holderAsk(ref, 'status', {}, env, 1000);
    return Array.isArray(afterA.activeTurns) && !afterA.activeTurns.includes(turnA);
  }, { timeoutMs: 2000 });
  check('delayed completion of A preserves the accepted B reservation',
    afterA.busy === true && afterA.activeTurns?.includes(acceptedB.turn.id) && !afterA.activeTurns.includes(turnA)
    && !events().some(event => event.kind === 'turn-start' && event.turnId === acceptedB.turn.id),
    JSON.stringify({ busy: afterA.busy, currentTurnId: afterA.currentTurnId, acceptedB: acceptedB.turn.id }));
  const before = readFileSync(privateAuth, 'utf8');
  writeFileSync(path.join(ownerHome, 'auth.json'), auth('fresh'));
  let refusal = '';
  try { await turn(); } catch (error) { refusal = error.message; }
  check('changed owner auth cannot reload while accepted B awaits its started notification',
    /active turn/.test(refusal) && readFileSync(privateAuth, 'utf8') === before,
    JSON.stringify({ refusal, privateAuthChanged: readFileSync(privateAuth, 'utf8') !== before }));
  receipt('after reservation and auth checks', {
    activeTurns: afterA.activeTurns, pendingBusy: pendingB.busy, afterABusy: afterA.busy, refusal, privateAuthUnchanged: readFileSync(privateAuth, 'utf8') === before,
    turns: events().filter(e => ['turn-end', 'turn-start', 'reservation-gate'].includes(e.kind)),
  });
  if (holdB) {
    check('B stayed unstarted through the auth check', !events().some(e => e.kind === 'turn-start' && e.turnId === acceptedB.turn.id));
    writeFileSync(releaseB, 'checked');
    check('B starts after release', !!await observe('released B', () => events().find(e => e.kind === 'turn-start' && e.turnId === acceptedB.turn.id), 4000));
  }
} finally {
  writeFileSync(releaseA, 'release');
  if (holdB) writeFileSync(releaseB, 'release');
  try { await holderAsk(ref, 'shutdown', {}, env, 10000); } finally {
    const gone = () => !holderAlive(ref, env) && pids.every(pid => !pidAlive(pid));
    const stopped = await waitFor(gone, { timeoutMs: 3000 });
    if (!stopped) for (const pid of pids) if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    const cleaned = stopped || await waitFor(gone, { timeoutMs: 2000 });
    receipt('reservation cleanup', { pids, stopped, cleaned });
    check('fixture holder and app exited', cleaned && pids.every(pid => Number.isInteger(pid) && pid > 0));
  }
}

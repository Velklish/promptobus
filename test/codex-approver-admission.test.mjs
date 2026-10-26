import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { makeSandbox } from './sandbox.mjs';
import { buildWorkspace, cli, store } from './scenario.mjs';
import { installHarness, planParticipant } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { readSession, sessionFile, writeSession } from '../lib/codex-session.js';
import { planApprover } from '../lib/approver.js';

const root = realpathSync(makeSandbox('promptobus-approver-'));
const { home: stand, stateHome, restore } = await installHarness({ binDir: path.join(root, 'bin') });
const { ws, repoAbs } = buildWorkspace(root, { tools: ['claude', 'codex'] });
const ownerHome = path.join(root, 'owner');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"stub":true}\n');
const env = { ...process.env, PROMPTOBUS_HOME: path.join(ws, '.promptobus'),
  CLAUDE_CODE_SESSION_ID: 'approver-fixture-owner', CODEX_HOME: ownerHome,
  PROMPTOBUS_CODEX_HOME: stateHome, PROMPTOBUS_WARDEN: 'off' };
const task = 'approver-native-t20261026-000000';
const address = 'approver:orders-api';
const worktree = path.join(repoAbs, '.claude', 'worktrees', 'worker-fixture');
const git = spawnSync('git', ['worktree', 'add', '-b', 'worker-fixture', worktree], { cwd: repoAbs, encoding: 'utf8' });
if (git.status !== 0) throw new Error(git.stderr);
const home = env.PROMPTOBUS_HOME;
const bus = store.bus(home, { cli: '0.29.0' });
function seed(id) {
  store.createTask(home, { id, title: 'Owned native approver ' + id, owner: env.CLAUDE_CODE_SESSION_ID });
  for (const role of ['worker', 'reviewer']) {
    const from = `${role}:orders-api`;
    bus.assignParticipant(id, store.participantRecord(from, {
      harness: 'claude', repoAbs: role === 'reviewer' ? worktree : repoAbs,
      worktree, branch: 'worker-fixture',
    }));
    store.sendMessage(home, id, { from, to: store.ORCHESTRATOR, type: 'result', body: 'Owned fixture result.' });
  }
}
seed(task);
planParticipant(stand, address, { turns: [{ do: [] }] });
const lift = () => cli(['review', worktree, '--task', task, '--approver', '--harness', 'codex'], { cwd: ws, env });
const participant = () => store.participantOf(store.readTask(home, task), address);
const first = lift();
check('native approver CLI: a fresh first launch reaches the Codex holder', first.status === 0, first.out);
const p = participant();
const native = readSession(p?.sessionRef ?? '', env);
check('native approver CLI: canonical reservation and native registry share the launch identity',
  !!p?.metadata.nativeLaunchId && native?.launchId === p.metadata.nativeLaunchId,
  JSON.stringify({ participant: p, native }));
check('native approver CLI: startup persists the actual thread and prelaunch pointer',
  !!native?.threadId && p?.metadata.sessionId === native.threadId
    && p.metadata.sessionRecord === sessionFile(p.sessionRef, env) && !p.metadata.pending,
  JSON.stringify({ participant: p, native }));
const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoAbs, encoding: 'utf8' }).stdout.trim();
check('native approver CLI: the reservation retains the actual worktree base', p?.metadata.baseSha === base,
  JSON.stringify({ expected: base, actual: p?.metadata.baseSha }));
const before = readFileSync(store.taskFile(home, task));
const again = lift();
check('native approver CLI: an active session is reused without replacing its reservation',
  first.status === 0 && again.status === 0 && again.out.includes('already on the bus')
    && readFileSync(store.taskFile(home, task)).equals(before), again.out);
await waitFor(() => readSession(p?.sessionRef ?? '', env)?.busy === false, { timeoutMs: 3000 });
const stopped = cli(['stop', address, '--task', task], { cwd: ws, env });
check('native approver CLI: Stop retains proof for the reserved launch',
  first.status === 0 && stopped.status === 0
    && participant()?.metadata.nativeStop?.launchId === p?.metadata.nativeLaunchId,
  stopped.out);
const relaunched = lift();
const next = participant();
check('native approver CLI: a confirmed Stop permits a new reserved generation',
  first.status === 0 && relaunched.status === 0
    && !!next?.metadata.nativeLaunchId && next.metadata.nativeLaunchId !== p?.metadata.nativeLaunchId
    && !next.metadata.nativeStop && !next.metadata.nativeUnlaunched
    && readSession(next.sessionRef, env)?.launchId === next.metadata.nativeLaunchId, relaunched.out);
await waitFor(() => readSession(next?.sessionRef ?? '', env)?.busy === false, { timeoutMs: 3000 });
const finalStop = cli(['stop', address, '--task', task], { cwd: ws, env });
check('native approver CLI: the replacement launch also retains terminal proof',
  first.status === 0 && finalStop.status === 0
    && participant()?.metadata.nativeStop?.launchId === next?.metadata.nativeLaunchId, finalStop.out);
let guardNumber = 0;
for (const [name, metadata, registry] of [
  ['legacy-unknown', {}],
  ['unresolved-reservation', { nativeLaunchId: 'unresolved' }],
  ['orphan-registry', { nativeLaunchId: 'orphan', nativeUnlaunched: 'orphan' }, true],
  ['invalid-proof', { nativeLaunchId: 'invalid', nativeStop: { launchId: 'invalid' } }],
]) {
  const id = `approver-${name}-t20261026-${String(++guardNumber).padStart(6, '0')}`;
  seed(id);
  const plan = planApprover(ws, { target: worktree, task: id, harness: 'codex' });
  store.upsertParticipant(home, id, store.participantRecord(address, {
    harness: 'codex', repoAbs, reviewSubject: worktree, worktree: plan.worktreePath,
    worktreeName: plan.wtName, branch: plan.branch, sessionRef: plan.name,
    session: null, pending: true, ...metadata,
  }));
  if (registry) writeSession({ ref: plan.name, launchId: metadata.nativeLaunchId,
    home, task: id, address, state: 'failed', error: 'owned fixture with no holder' }, env);
  const taskBefore = readFileSync(store.taskFile(home, id));
  const registryFile = sessionFile(plan.name, env);
  const recordBefore = existsSync(registryFile) ? readFileSync(registryFile) : null;
  const refused = cli(['review', worktree, '--task', id, '--approver', '--harness', 'codex'], { cwd: ws, env });
  check(`native approver CLI: ${name} refuses before worktree or canonical mutation`,
    refused.status !== 0 && refused.out.includes('native work is active or unresolved')
      && !existsSync(plan.worktreePath) && readFileSync(store.taskFile(home, id)).equals(taskBefore)
      && (recordBefore ? readFileSync(registryFile).equals(recordBefore) : !existsSync(registryFile)), refused.out);
}
{
  const id = 'approver-old-pending-t20261026-000005';
  seed(id);
  const plan = planApprover(ws, { target: worktree, task: id, harness: 'codex' });
  const made = spawnSync('git', ['worktree', 'add', '-b', plan.branch, plan.worktreePath, 'main'],
    { cwd: repoAbs, encoding: 'utf8' });
  if (made.status !== 0) throw new Error(made.stderr);
  store.upsertParticipant(home, id, store.participantRecord(address, {
    harness: 'codex', repoAbs, reviewSubject: worktree, worktree: plan.worktreePath,
    worktreeName: plan.wtName, branch: plan.branch, sessionRef: plan.name, name: plan.name,
    session: null, pending: true, baseSha: 'e3e5b5e6fd3cefbeef07f0e9d4085e4e03604e7e',
  }));
  const before = readFileSync(store.taskFile(home, id));
  const rules = path.join(plan.worktreePath, 'AGENTS.md');
  const rulesBefore = readFileSync(rules);
  const refused = cli(['review', worktree, '--task', id, '--approver', '--harness', 'codex'], { cwd: ws, env });
  check('native approver CLI: old pending record at E3 stays fail closed in its existing worktree',
    refused.status !== 0 && refused.out.includes('native work is active or unresolved')
      && readFileSync(store.taskFile(home, id)).equals(before) && readFileSync(rules).equals(rulesBefore)
      && !existsSync(sessionFile(plan.name, env)), refused.out);
}
restore();

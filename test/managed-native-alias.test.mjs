import { check } from './check.mjs';
import fs from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createStandaloneHost } from '../dist/host-index.js';
import { CODEX_TEAMLEAD_ROOT_SERVER, codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { readSession, sessionFile } from '../lib/codex-session.js';
import { spawnTeamlead } from '../lib/spawn.js';
import { bus, canonicalPath, participantMcpPath, participantOf, participantRecord, participantSessionPath, participantSettingsPath,
  readTask, taskFile, upsertParticipant, wakeFile, withTaskLock } from '../lib/store.js';
import { done } from '../lib/done.js';
import { sweep } from '../lib/sweep.js';
import { processState, readPrivate, recordVersion, servicePaths } from '../lib/service-state.js';
import { abortTaskWarden, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { installHarness, planParticipant, readTrace } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture, expectFail } from './console.mjs';

const root = realpathSync(makeSandbox('pb-native-alias-'));
writeHostConfig(root, { tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(root, 'bin') });
const authOwner = path.join(root, 'owner'); mkdirSync(authOwner);
writeFileSync(path.join(authOwner, 'auth.json'), '{"stub":"credentials"}\n');
const prior = { owner: process.env.PROMPTOBUS_CODEX_OWNER_HOME, root: process.env.CLAUDE_CODE_SESSION_ID };
process.env.PROMPTOBUS_CODEX_OWNER_HOME = authOwner;
process.env.CLAUDE_CODE_SESSION_ID = 'fixture-parent-owner';
const host = createStandaloneHost({ cwd: root, extraEnv: { PROMPTOBUS_WARDEN: 'off' } });
const home = host.promptobusHome(), task = 'alias-parent-t20261101-000001';
bus(home, { cli: host.version }).createTask({ id: task, title: 'Owned teamlead provenance',
  owner: participantRecord('orchestrator', { owner: 'fixture-parent-owner' }) });
const brief = path.join(root, 'brief.md'); writeFileSync(brief, '# Alias provenance\nRead the child task.\n');
planParticipant(harness.home, 'orchestrator', { turns: [{ do: [{ tool: 'promptobus_task', args: {} }] }] });
let plan, launch, nativeIssues = 0;
const aliasTarget = path.join(root, 'retained-alias-target.json'), aliasTargetBytes = '{"retained":"external"}\n';
writeFileSync(aliasTarget, aliasTargetBytes, { mode: 0o600 });
const prepare = codexDriver.prepare;
codexDriver.prepare = context => {
  codexDriver.prepare = prepare;
  const privateHome = participantCodexHome(context, context.env);
  mkdirSync(privateHome, { recursive: true, mode: 0o700 });
  fs.symlinkSync(aliasTarget, path.join(privateHome, 'teamlead-root-session.json'));
  return prepare(context);
};
const spawn = codexDriver.spawn;
codexDriver.spawn = (value, runtime) => {
  nativeIssues += 1; launch = value;
  check('native alias plan selects its canonical sidecar before issuing the holder',
    value.rootSessionRecord === path.join(canonicalPath(value.codexHome), 'teamlead-root-session.json')
      && value.serviceScopes.every(scope => scope.record === value.rootSessionRecord));
  return spawn(value, runtime);
};

async function readOwnTask(server, env, nativeId, expectedTask) {
  const token = env[server.bearer_token_env_var];
  let session = null, id = 0;
  const rpc = async (method, params, notification = false) => {
    const response = await fetch(server.url, { method: 'POST', signal: AbortSignal.timeout(5000), headers: {
      authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++id }), method,
      params: method === 'tools/call' ? { ...params, _meta: { threadId: nativeId } } : params }) });
    session = response.headers.get('mcp-session-id') ?? session;
    return { status: response.status, body: response.status === 202 ? null : await response.json() };
  };
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'native-alias-fixture', version: '1' } });
    await rpc('notifications/initialized', {}, true);
    const result = await rpc('tools/call', { name: 'promptobus_task', arguments: {} });
    check(`the same actual native ID reads its ${expectedTask} scope through its own HTTP credential`,
      initialized.status === 200 && result.status === 200 && !result.body?.result?.isError
        && JSON.stringify(result.body).includes(expectedTask), JSON.stringify(result));
  } finally {
    if (session) {
      const closed = await fetch(server.url, { method: 'DELETE', signal: AbortSignal.timeout(5000), headers: {
        authorization: `Bearer ${token}`, 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18',
      } });
      if (!closed.ok && closed.status !== 404 && closed.status !== 401) throw new Error(`Fixture alias MCP close: ${closed.status}`);
    }
  }
}

try {
  plan = await spawnTeamlead(host, { task, brief, slug: 'provenance', harness: 'codex', permissionMode: 'full-access' });
  const primary = await waitFor(() => {
    const record = readSession(plan.name, plan.env);
    return record?.turns >= 1 && !record.busy ? record : null;
  }, { timeoutMs: 15000 });
  if (!primary) throw new Error('teamlead did not complete its actual native first turn');
  const alias = readPrivate(plan.launch.rootSessionRecord);
  check('actual alias publication replaces its owned leaf symlink without changing the external target',
    readFileSync(aliasTarget, 'utf8') === aliasTargetBytes && !lstatSync(plan.launch.rootSessionRecord).isSymbolicLink());
  const aliasEntry = lstatSync(plan.launch.rootSessionRecord), directoryEntry = lstatSync(path.dirname(plan.launch.rootSessionRecord));
  check('native alias publication keeps its owned regular sidecar and canonical participant directory private',
    aliasEntry.isFile() && !aliasEntry.isSymbolicLink() && (aliasEntry.mode & 0o777) === 0o600
      && (!process.getuid || aliasEntry.uid === process.getuid()) && (directoryEntry.mode & 0o777) === 0o700
      && realpathSync(plan.launch.rootSessionRecord) === plan.launch.rootSessionRecord);
  const rootSeat = participantOf(readTask(home, task), plan.address), childSeat = participantOf(readTask(home, plan.childTask), 'orchestrator');
  check('the actual teamlead alias retains the same physical native generation and API proof as its primary',
    alias.ref === primary.ref && alias.launchId === primary.launchId && alias.threadId === primary.threadId
      && alias.codexHome === realpathSync(primary.codexHome) && alias.codexHome !== primary.authOwnerHome
      && isDeepStrictEqual(alias.nativeAdmission, primary.nativeAdmission)
      && isDeepStrictEqual(alias.nativeAdmissionEvidence, primary.nativeAdmissionEvidence)
      && alias.nativeAdmissionSource.record === plan.launch.sessionRecord
      && alias.nativeAdmissionSource.launchId === primary.launchId && alias.nativeAdmissionSource.nativeId === primary.threadId
      && typeof alias.nativeAdmissionSource.version === 'string' && processState(alias.nativeAdmission.process) === 'alive'
      && alias.nativeAdmissionSource.version !== recordVersion(plan.launch.sessionRecord).version
      && rootSeat.metadata.sessionRecord === plan.launch.rootSessionRecord && childSeat.metadata.sessionRecord === plan.launch.sessionRecord
      && rootSeat.metadata.sessionId === primary.threadId && childSeat.metadata.sessionId === primary.threadId);
  const paths = servicePaths(host, plan.env);
  const grants = readdirSync(paths.clients).map(file => readPrivate(path.join(paths.clients, file)))
    .filter(grant => grant.lifetime?.kind === 'managed' && grant.lifetime.launchId === primary.launchId);
  check('two exact scope grants share one physical launch without reusing credentials or inventing another native generation',
    grants.length === 2 && grants[0].id !== grants[1].id && grants[0].token !== grants[1].token
      && grants.every(grant => grant.nativeBinding.kind === 'codex' && grant.nativeBinding.threadId === primary.threadId)
      && grants.some(grant => grant.lifetime.record === plan.launch.sessionRecord && grant.lifetime.task === plan.childTask)
      && grants.some(grant => grant.lifetime.record === plan.launch.rootSessionRecord && grant.lifetime.task === task));
  const trace = readTrace(harness.home, 'orchestrator');
  check('the teamlead first native turn crosses child HTTP after alias publication and realization',
    trace.some(entry => entry.kind === 'tool' && entry.tool === 'promptobus_task' && !entry.isError && entry.text.includes(plan.childTask)),
    JSON.stringify(trace.filter(entry => ['tool', 'action-failed'].includes(entry.kind))));
  await readOwnTask(plan.launch.mcpConfig.mcpServers.promptobus, plan.env, primary.threadId, plan.childTask);
  await readOwnTask(plan.launch.mcpConfig.mcpServers[CODEX_TEAMLEAD_ROOT_SERVER], plan.env, primary.threadId, task);

  const stopped = await codexDriver.stop(plan.name);
  if (!stopped.ok || !stopped.stopped) throw new Error(`Owned alias did not confirm Stop for the real relift precondition: ${stopped.note}`);
  await plan.launch.service.revoke();
  const stoppedRoot = participantOf(readTask(home, task), plan.address), stoppedChild = participantOf(readTask(home, plan.childTask), 'orchestrator');
  const rename = fs.renameSync, read = fs.readFileSync, request = http.request;
  const childJournal = taskFile(home, plan.childTask), primaryError = new Error('fixture child reservation commit refused');
  const cleanupError = new Error('fixture child reservation rollback read refused');
  let arm = true, clearFault = false, partialGeneration, grantIssues = 0, failure;
  const beforeNativeIssues = nativeIssues;
  fs.renameSync = (from, to) => {
    if (arm && to === childJournal && read(from, 'utf8').includes('nativePendingLaunchId')) {
      arm = false;
      partialGeneration = participantOf(readTask(home, task), plan.address).metadata.nativePendingLaunchId;
      clearFault = true;
      throw primaryError;
    }
    return rename(from, to);
  };
  fs.readFileSync = (file, ...args) => {
    if (clearFault && file === childJournal) { clearFault = false; throw cleanupError; }
    return read(file, ...args);
  };
  http.request = (...args) => {
    const call = request(...args);
    if (args[0]?.socketPath === paths.controlSocket) {
      const end = call.end;
      call.end = function (body, ...rest) {
        if (JSON.parse(String(body)).operation === 'register') grantIssues += 1;
        return end.call(this, body, ...rest);
      };
    }
    return call;
  };
  syncBuiltinESMExports();
  try {
    await spawnTeamlead(host, { task, brief, slug: 'provenance', harness: 'codex', permissionMode: 'full-access', sessions: [] });
  } catch (error) { failure = error; }
  finally { fs.renameSync = rename; fs.readFileSync = read; http.request = request; syncBuiltinESMExports(); }
  check('actual partial teamlead relift reservation preserves its child-write failure and secondary clear failure before grants or native issue',
    !!partialGeneration && failure instanceof AggregateError && failure.errors[0] === primaryError && failure.errors[1] === cleanupError
      && failure.cause === primaryError && failure.message.includes(primaryError.message) && failure.message.includes(cleanupError.message)
      && grantIssues === 0 && nativeIssues === beforeNativeIssues && !readSession(plan.name, plan.env), failure?.stack);

  // Reconcile only this fixture's injected partial pending marker. The actual stopped
  // generation/proofs must be unchanged; no new native owner or capability is restored.
  withTaskLock(home, task, () => withTaskLock(home, plan.childTask, () => {
    for (const [id, address, expected] of [[task, plan.address, stoppedRoot], [plan.childTask, 'orchestrator', stoppedChild]]) {
      const current = participantOf(readTask(home, id), address), { nativePendingLaunchId, ...metadata } = current.metadata;
      if ((nativePendingLaunchId && nativePendingLaunchId !== partialGeneration)
        || !isDeepStrictEqual({ ...current, metadata }, expected)) throw new Error('Alias fixture pending reconciliation found a changed owner');
      upsertParticipant(home, id, expected);
    }
  }));
  const close = id => done(host, { task: id, 'keep-sessions': true,
    adapterFor: () => ({ probe: () => ({ available: 'unknown' }) }) });
  process.env.CLAUDE_CODE_SESSION_ID = primary.threadId;
  await capture(() => close(plan.childTask));
  process.env.CLAUDE_CODE_SESSION_ID = 'fixture-parent-owner';
  const stoppedOwner = participantOf(readTask(home, plan.childTask), 'orchestrator');
  const proof = stoppedRoot.metadata.nativeStop, receiptBytes = readFileSync(proof.receiptFile, 'utf8');
  const history = path.join(harness.home, 'threads', `${primary.threadId}.json`), historyBytes = readFileSync(history, 'utf8');
  const local = [participantMcpPath(home, task, plan.address), participantSettingsPath(home, task, plan.address),
    participantSessionPath(home, task, plan.address), wakeFile(home, task, plan.address)];
  for (const file of local) if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'owned parent-local sidecar', { mode: 0o600 });
  }
  for (const operation of ['sweep', 'done']) for (const damage of ['parent-generation', 'child-proof']) {
    const parentSeat = participantOf(readTask(home, task), plan.address);
    if (damage === 'parent-generation') upsertParticipant(home, task,
      { ...parentSeat, metadata: { ...parentSeat.metadata, nativeLaunchId: 'foreign-generation' } });
    else upsertParticipant(home, plan.childTask, { ...stoppedOwner, metadata: { ...stoppedOwner.metadata, nativeStop: null } });
    const journals = [taskFile(home, task), taskFile(home, plan.childTask)].map(file => [file, readFileSync(file, 'utf8')]);
    const sidecars = local.map(file => [file, readFileSync(file, 'utf8')]);
    let error;
    const refusal = await expectFail(async () => {
      try { return await (operation === 'sweep' ? sweep(host, { task, address: plan.address }) : close(task)); }
      catch (caught) { error = caught; throw caught; }
    });
    check(`public parent ${operation} refuses ${damage} before task-local cleanup and preserves the actual child Stop/history`,
      refusal.failed && /unresolved/.test(error?.message ?? '')
        && [...journals, ...sidecars].every(([file, bytes]) => existsSync(file) && readFileSync(file, 'utf8') === bytes)
        && readFileSync(proof.receiptFile, 'utf8') === receiptBytes && readFileSync(history, 'utf8') === historyBytes,
      `${error?.stack ?? ''}\n${refusal.out}`);
    withTaskLock(home, task, () => withTaskLock(home, plan.childTask, () => {
      upsertParticipant(home, task, parentSeat); upsertParticipant(home, plan.childTask, stoppedOwner);
    }));
  }
  const childJournalBytes = readFileSync(taskFile(home, plan.childTask), 'utf8');
  for (const operation of ['sweep', 'done']) {
    for (const file of local) if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'owned parent-local sidecar', { mode: 0o600 });
    }
    await capture(() => operation === 'sweep' ? sweep(host, { task, address: plan.address }) : close(task));
    const parentSeat = participantOf(readTask(home, task), plan.address);
    const { alias: aliasProof, ...childProof } = parentSeat.metadata.nativeStop;
    check(`public parent ${operation} accepts only the reciprocal alias and removes its local sidecars without touching child history or proof`,
      local.every(file => !existsSync(file)) && !existsSync(sessionFile(plan.name, plan.env)) && !existsSync(primary.codexHome)
        && readFileSync(taskFile(home, plan.childTask), 'utf8') === childJournalBytes
        && readFileSync(history, 'utf8') === historyBytes && readFileSync(proof.receiptFile, 'utf8') === receiptBytes
        && isDeepStrictEqual(aliasProof, { task, address: plan.address }) && isDeepStrictEqual(childProof, stoppedOwner.metadata.nativeStop)
        && parentSeat.metadata.nativeLaunchId === primary.launchId
        && readTask(home, task).status === (operation === 'done' ? 'done' : 'active')
        && (operation !== 'done' || !!readTask(home, task).adapter.worktreesSwept));
  }
} finally {
  codexDriver.spawn = spawn;
  if (plan && readSession(plan.name, plan.env)) {
    const stopped = await codexDriver.stop(plan.name);
    check('alias fixture confirms actual native Stop before revoking both owned scope grants', stopped.ok === true && stopped.stopped === true, stopped.note);
  }
  if (launch?.service) await launch.service.revoke();
  const options = { cwd: root, env: plan?.env ?? process.env };
  for (const id of [task, plan?.childTask].filter(Boolean)) await abortTaskWarden(host, id, options);
  if ((await workspaceServiceStatus(host, options)).running) {
    const stopped = await stopWorkspaceService(host, options);
    check('alias fixture confirms physical exit of its own HTTP owner', stopped.stopped === true);
  }
  if (prior.owner === undefined) delete process.env.PROMPTOBUS_CODEX_OWNER_HOME;
  else process.env.PROMPTOBUS_CODEX_OWNER_HOME = prior.owner;
  if (prior.root === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = prior.root;
  harness.restore();
}

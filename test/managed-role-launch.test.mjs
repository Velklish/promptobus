import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createStandaloneHost } from '../dist/host-index.js';
import { codexDriver } from '../lib/driver-codex.js';
import { readSession } from '../lib/codex-session.js';
import { review } from '../lib/review.js';
import { report } from '../lib/report.js';
import { bus, participantOf, participantRecord, readTask } from '../lib/store.js';
import { readPrivate } from '../lib/service-state.js';
import { abortTaskWarden, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { installHarness, planParticipant, readTrace } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { buildWorkspace } from './scenario.mjs';
import { makeSandbox } from './sandbox.mjs';

const scratch = realpathSync(makeSandbox('promptobus-managed-roles-'));
const { ws, repoAbs } = buildWorkspace(scratch, { repo: 'role-review', tools: ['codex'] });
const harness = await installHarness({ binDir: path.join(scratch, 'bin') });
const ownerHome = path.join(scratch, 'owner-home');
mkdirSync(ownerHome);
writeFileSync(path.join(ownerHome, 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"fixture"}\n');
const priorOwner = process.env.PROMPTOBUS_CODEX_OWNER_HOME;
process.env.PROMPTOBUS_CODEX_OWNER_HOME = ownerHome;
const extraEnv = { PROMPTOBUS_CODEX_OWNER_HOME: ownerHome, PROMPTOBUS_SERVICE_HOME: process.env.PROMPTOBUS_SERVICE_HOME,
  PROMPTOBUS_CODEX_HOME: process.env.PROMPTOBUS_CODEX_HOME, PROMPTOBUS_WARDEN: 'off' };
const host = createStandaloneHost({ cwd: ws, extraEnv });
const home = host.promptobusHome();
const skill = path.join(scratch, 'installed', 'selected-procedure');
const resource = path.join(scratch, 'installed', '_shared', 'standard.md');
mkdirSync(skill, { recursive: true });
mkdirSync(path.dirname(resource), { recursive: true });
const skillText = '# MANAGED_REVIEW_SKILL\nRead [the exact standard](../_shared/standard.md).\n';
writeFileSync(path.join(skill, 'SKILL.md'), skillText);
writeFileSync(resource, 'MANAGED_REVIEW_STANDARD\n');
const outside = path.join(scratch, 'outside-review-ceiling.md');
writeFileSync(outside, 'outside the exact review roots\n');
writeFileSync(path.join(repoAbs, 'AGENTS.md'), 'Repository rules changed for this review.\n');
const selectedHost = Object.create(host);
selectedHost.selectParticipantContext = ({ task }) => ({
  rules: [{ path: path.join(ws, 'AGENTS.md'), reason: 'Workspace rule' }, { path: path.join(repoAbs, 'AGENTS.md'), reason: 'Repository rule' }],
  skills: (task.context?.skills ?? []).map(entry => ({ ...entry, root: skill })),
  resources: task.context?.resources ?? [],
});
const selected = { contextPurpose: 'technical', contextDeclaration: {
  skills: [{ name: 'selected-procedure', reason: 'Review procedure', requires: [{ kind: 'resource', path: resource }] }],
  resources: [{ path: resource, reason: 'Exact review standard' }],
} };
const options = { env: { ...process.env, ...extraEnv }, cwd: ws };
const originalSpawn = codexDriver.spawn;
const launches = [];
let observedRole;
codexDriver.spawn = async (launch, runtime) => {
  launches.push({ launch, runtime });
  const beforeStart = launch.service.beforeStart.bind(launch.service);
  launch.service.beforeStart = async file => {
    const record = readPrivate(file), participant = participantOf(readTask(home, runtime.task), runtime.address);
    check(`${observedRole} publishes its exact pending native record and generation before strict service bind`,
      record.threadId === null && record.launchId === launch.service.launchId && record.ref === runtime.ref
        && participant?.metadata.sessionRecord === file && participant.metadata.nativeLaunchId === record.launchId
        && !participant.metadata.sessionId, JSON.stringify({ ref: record.ref, launchId: record.launchId, threadId: record.threadId,
        record: file, publishedRecord: participant?.metadata.sessionRecord, publishedGeneration: participant?.metadata.nativeLaunchId }));
    return beforeStart(file);
  };
  if (observedRole === 'reviewer') {
    const canonical = launch.serviceFiles.canonicalFiles;
    check('cold Codex review materializes future copied roots and canonical files before provider start',
      launch.serviceFiles.roots.every(file => existsSync(file)) && canonical.every(file => realpathSync(file) === file)
        && canonical.some(file => file.endsWith(path.join('selected-procedure', 'SKILL.md')) && readFileSync(file, 'utf8') === skillText));
    check('the same final Codex review plan carries owned HTTP descriptors before provider start',
      typeof launch.mcpConfig.mcpServers.promptobus.url === 'string'
        && typeof launch.mcpConfig.mcpServers.reviewer_files.url === 'string'
        && launch.mcpConfig.mcpServers.promptobus.command === undefined);
  }
  return originalSpawn(launch, runtime);
};

async function readGrantedFile(plan, nativeId, copied) {
  const server = plan.launch.mcpConfig.mcpServers.reviewer_files;
  const token = plan.env[server.bearer_token_env_var];
  let session = null, sequence = 0;
  const rpc = async (method, params, notification = false) => {
    const response = await fetch(server.url, { method: 'POST', signal: AbortSignal.timeout(5000), headers: {
      authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++sequence }), method,
      params: method === 'tools/call' ? { ...params, _meta: { threadId: nativeId } } : params }) });
    session = response.headers.get('mcp-session-id') ?? session;
    return { status: response.status, body: response.status === 202 ? null : await response.json() };
  };
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'managed-role-fixture', version: '1' } });
    await rpc('notifications/initialized', {}, true);
    const allowed = await rpc('tools/call', { name: 'read_file', arguments: { path: copied } });
    check('the actual Codex reviewer reads its materialized canonical skill through owned HTTP files',
      initialized.status === 200 && allowed.status === 200 && !allowed.body?.result?.isError
        && JSON.stringify(allowed.body).includes('MANAGED_REVIEW_SKILL'), JSON.stringify(allowed));
    const denied = await rpc('tools/call', { name: 'read_file', arguments: { path: outside } });
    check('the same realized reviewer grant still refuses a path outside its exact roots',
      denied.status === 200 && denied.body?.result?.isError === true && JSON.stringify(denied.body).includes('outside'), JSON.stringify(denied));
  } finally {
    if (session) {
      const response = await fetch(server.url, { method: 'DELETE', signal: AbortSignal.timeout(5000), headers: {
        authorization: `Bearer ${token}`, 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18',
      } });
      if (!response.ok && response.status !== 404 && response.status !== 401) throw new Error(`Fixture files MCP close: ${response.status}`);
    }
  }
}

try {
  for (const role of ['reviewer', 'reporter']) {
    observedRole = role;
    const task = `${role}-cold-t20261101-000001`, address = role === 'reviewer' ? 'reviewer:role-review' : 'reporter';
    bus(home, { cli: host.version }).createTask({ id: task, title: `cold managed ${role}`,
      owner: participantRecord('orchestrator', { owner: 'fixture-root-owner' }) });
    planParticipant(harness.home, address, { turns: [{ do: [{ tool: 'promptobus_task', args: { task } }] }] });
    try {
      let plan, failure;
      try {
        plan = role === 'reviewer'
          ? await review(selectedHost, { target: repoAbs, task, harness: 'codex', ...selected })
          : await report(host, { task, harness: 'codex' });
      } catch (error) { failure = error; }
      check(`cold managed Codex ${role} launches through the public caller`, !!plan && !failure, failure?.stack);
      if (plan) {
        const native = await waitFor(() => {
          const record = readSession(plan.name, plan.env);
          return record?.turns >= 1 && record.busy === false ? record : null;
        }, { timeoutMs: 15000 });
        const participant = participantOf(readTask(home, task), address), grant = readPrivate(plan.launch.service.credentialFile);
        check(`${role} keeps the actual native thread, record pointer and reserved generation in one owned launch`,
          native?.lastTurn?.status === 'completed' && participant.metadata.sessionId === native.threadId && participant.metadata.sessionRecord === plan.launch.sessionRecord
            && participant.metadata.nativeLaunchId === native.launchId && native.launchId === plan.launch.service.launchId
            && grant.nativeBinding.kind === 'codex' && grant.nativeBinding.threadId === native.threadId
            && grant.lifetime.kind === 'managed' && grant.lifetime.record === plan.launch.sessionRecord);
        check(`${role} publishes actual owned API provenance without waiting for a first-turn rollout`,
          native.nativeAdmission?.harness === 'codex' && native.nativeAdmission.nativeId === native.threadId
            && native.nativeAdmission.nativeStore === realpathSync(native.codexHome)
            && native.nativeAdmission.process.pid === native.appPid && !!native.nativeAdmission.process.birth
            && native.nativeAdmissionEvidence?.kind === 'codex-thread-api'
            && native.nativeAdmissionEvidence.method === 'thread/start'
            && native.nativeAdmission.nativeStore !== native.authOwnerHome);
        const trace = readTrace(harness.home, address);
        check(`${role} first task read crosses real HTTP with its actual native authority`,
          trace.some(entry => entry.kind === 'tool' && entry.tool === 'promptobus_task' && !entry.isError && entry.text.includes(task)),
          JSON.stringify(trace.filter(entry => ['tool', 'action-failed'].includes(entry.kind))));
        check(`${role} provider home receives the refreshed final HTTP config without bearer bytes`,
          native?.codexHome && readFileSync(path.join(native.codexHome, 'config.toml'), 'utf8').includes(plan.launch.mcpConfig.mcpServers.promptobus.url)
            && !readFileSync(path.join(native.codexHome, 'config.toml'), 'utf8').includes(plan.env.PROMPTOBUS_CLIENT_TOKEN));
        if (role === 'reviewer' && native) await readGrantedFile(plan, native.threadId,
          path.join(native.cwd, '.codex', 'skills', 'selected-procedure', 'SKILL.md'));
      }
    } finally {
      for (const { launch, runtime } of launches.splice(0)) {
        if (readSession(runtime.ref, runtime.env)) {
          const stopped = await codexDriver.stop(runtime.ref);
          check(`${role} fixture confirms native cleanup before retiring its owned service`, stopped.ok === true, stopped.note);
        }
        if (existsSync(launch.service.credentialFile)) await launch.service.revoke();
      }
      await abortTaskWarden(host, task, options);
      const status = await workspaceServiceStatus(host, options);
      if (status.running) {
        const stopped = await stopWorkspaceService(host, options);
        check(`${role} fixture confirms physical exit of its own HTTP owner`, stopped.stopped === true);
      }
    }
  }
} finally {
  codexDriver.spawn = originalSpawn;
  if (priorOwner === undefined) delete process.env.PROMPTOBUS_CODEX_OWNER_HOME;
  else process.env.PROMPTOBUS_CODEX_OWNER_HOME = priorOwner;
  harness.restore();
}

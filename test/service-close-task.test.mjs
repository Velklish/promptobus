import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { createTask, ensureRootRecord, participantOf, participantRecord, readTask, upsertParticipant } from '../lib/store.js';
import { commandReceipts } from '../lib/codex-command-receipts.js';
import { codexStateHome, sessionFile, sessionKey, writeSession } from '../lib/codex-session.js';
import { reservationFile, reserveLiveSeat } from '../lib/live-reservation.js';
import { retainNativeStop } from '../lib/native-lifecycle.js';
import { abortTaskWarden, closeServiceTask, ensureTaskWarden, ensureWorkspaceService, registerServiceClient,
  revokeServiceClient, serviceControl, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { processState, requireProcess, runtimeIdentity, servicePaths } from '../lib/service-state.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { waitFor } from './harness.mjs';

const root = realpathSync(makeSandbox('promptobus-service-operation-close-task-'));
const privateHome = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-close-'));
const home = path.join(root, '.promptobus'), nativeHome = path.join(root, 'native');
const bin = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: privateHome, PROMPTOBUS_HOME: home,
  PROMPTOBUS_CODEX_HOME: nativeHome, PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_SERVICE_IDLE_MS: '60000' };
const host = createStandaloneHost({ cwd: root, binPath: bin, version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version });
const paths = servicePaths(host, env), options = { cwd: root, env };
const parent = 'close-parent-t20261113-000000', children = ['close-one-t20261113-000000', 'close-two-t20261113-000000'];
const unrelated = 'close-unrelated-t20261113-000000', tasks = [parent, ...children, unrelated], clients = [];
writeHostConfig(root, { tools: [] });
const cli = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [bin, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { out += data; });
  child.once('error', reject); child.once('close', code => resolve({ code, out }));
});
const rejected = async (name, operation, pattern, watched = null) => {
  const before = tasks.map(task => readFileSync(path.join(home, 'tasks', task, 'task.json'), 'utf8'));
  const watch = async () => watched ? {
    demand: JSON.parse(readFileSync(path.join(paths.directory, 'warden-demand.json'), 'utf8')).tasks[watched],
    running: (await workspaceServiceStatus(host, options)).warden.tasks.find(row => row.task === watched),
  } : null;
  const beforeWatch = await watch();
  let error;
  try { await operation(); } catch (caught) { error = caught; }
  check(name, pattern.test(error?.message ?? '') && JSON.stringify(before) === JSON.stringify(tasks.map(task => readFileSync(path.join(home, 'tasks', task, 'task.json'), 'utf8')))
    && JSON.stringify(beforeWatch) === JSON.stringify(await watch()), error?.stack ?? 'unexpected success');
};
const priorNativeHome = process.env.PROMPTOBUS_CODEX_HOME;
process.env.PROMPTOBUS_CODEX_HOME = nativeHome;
try {
  await ensureWorkspaceService(host, options);
  createTask(home, { id: parent, title: 'terminal-only service closure', owner: 'thread-root' });
  createTask(home, { id: unrelated, title: 'unrelated active run', owner: 'unrelated-owner' });
  const make = (task, address, ref, mode = 'managed') => {
    const record = { ref, home, task, address, launchId: `launch-${ref}`, threadId: `thread-${ref}`,
      holderPid: 2147483646, appPid: 2147483645, state: 'dead', stopConfirmed: true };
    upsertParticipant(home, task, participantRecord(address, { harness: 'codex', mode, sessionRef: ref,
      sessionId: record.threadId, sessionRecord: sessionFile(ref, env), nativeLaunchId: record.launchId,
      ...(address === 'orchestrator' ? { owner: record.threadId } : {}) }));
    return record;
  };
  const receipt = record => {
    const file = path.join(codexStateHome(env), 'receipts', sessionKey(record.ref), sessionKey(record.launchId) + '.jsonl');
    const ledger = commandReceipts(file, { format: 1, ...record }), deadlineAt = Date.now() + 5000;
    ledger.append('stop/requested', { threadId: record.threadId, deadlineAt });
    ledger.append('app-server/close', { code: 0, signal: null });
    ledger.append('stop/confirmed', { ...record, commands: [], appClose: { code: 0, signal: null }, deadlineAt, originalToolReceipt: 'not synthesized' });
    retainNativeStop(record, file);
    return file;
  };
  const rootRecord = make(parent, 'orchestrator', 'root');
  const rootReceipt = receipt(rootRecord);
  for (const [index, task] of children.entries()) {
    const address = `teamlead:lead${index}`, ref = `lead${index}`;
    createTask(home, { id: task, title: `stopped lead ${index}`, parent, teamlead: address, owner: `thread-${ref}` });
    const lead = make(parent, address, ref);
    const participant = participantOf(readTask(home, parent), address);
    upsertParticipant(home, parent, { ...participant, metadata: { ...participant.metadata, childTask: task } });
    make(task, 'orchestrator', ref, 'attached');
    ensureRootRecord(home, task);
    receipt({ ...lead, task, address: 'orchestrator' });
  }
  for (const task of tasks) await ensureTaskWarden(host, home, task, options);
  check('owned terminal fixture starts separate task loops', await waitFor(async () => (await workspaceServiceStatus(host, options)).warden.tasks.length === tasks.length, { timeoutMs: 5000 }));
  const unrelatedBefore = readTask(home, unrelated);
  const failedStop = await cli(['service', 'stop', '--json']);
  const baseline = await workspaceServiceStatus(host, options);
  check('zero-client confirmed root and two leads retain active watcher work', baseline.clients === 0 && baseline.warden.tasks.length === 4
    && failedStop.code === 1 && /clients: 0, activeWork: true, pendingObservations: 0/.test(failedStop.out), JSON.stringify({ baseline, failedStop }));

  const wrongOwner = path.join(root, 'wrong-owner.json');
  writeFileSync(wrongOwner, JSON.stringify({ token: '0'.repeat(64) }), { mode: 0o600 });
  await rejected('foreign service credential cannot close a stopped task', () => serviceControl({ ...paths, owner: wrongOwner },
    { operation: 'close-task', runtime: runtimeIdentity(host), task: children[0] }), /Owner authentication required/);
  await rejected('foreign runtime cannot close a stopped task', () => serviceControl(paths,
    { operation: 'close-task', runtime: 'foreign-runtime', task: children[0] }), /different shared service runtime/);
  await rejected('different common poll environment cannot close this service task', () => closeServiceTask(host, children[0],
    { ...options, pollEnv: { ...env, LANG: 'fixture-foreign-locale' } }), /different harness state homes/);
  const ordinary = await cli(['done', '--task', children[0]]);
  check('ordinary done still requires the stopped mailbox owner', ordinary.code === 1
    && /carries no session identity/.test(ordinary.out) && readTask(home, children[0]).status === 'active', JSON.stringify(ordinary));
  reserveLiveSeat(host, home, children[0], 'worker:reserved', 'codex', 'reserved-fixture', env);
  const reservation = readFileSync(reservationFile(home, children[0]));
  await rejected('unresolved lift reservation blocks otherwise stopped task closure', () => closeServiceTask(host, children[0], options), /live or unresolved reservation/);
  check('refused closure preserves exact reserved lift state', readFileSync(reservationFile(home, children[0])).equals(reservation));
  writeFileSync(reservationFile(home, children[0]), '[]\n');
  await rejected('parent closure keeps active children and journals', () => closeServiceTask(host, parent, options), /child task .*active or unfinished/);

  const savedRoot = participantOf(readTask(home, parent), 'orchestrator');
  const rootBytes = readFileSync(rootReceipt);
  writeFileSync(rootReceipt, Buffer.concat([rootBytes, Buffer.from('\n')]));
  await rejected('changed terminal receipt refuses closure', () => closeServiceTask(host, parent, options), /native work is active or unresolved/);
  writeFileSync(rootReceipt, rootBytes);
  const incomplete = rootBytes.toString().trimEnd().split('\n').slice(0, -1).join('\n') + '\n';
  writeFileSync(rootReceipt, incomplete);
  upsertParticipant(home, parent, { ...savedRoot, metadata: { ...savedRoot.metadata,
    nativeStop: { ...savedRoot.metadata.nativeStop, sha256: createHash('sha256').update(incomplete).digest('hex') } } });
  await rejected('hash-matching unresolved receipt still refuses closure', () => closeServiceTask(host, parent, options), /native work is active or unresolved/);
  writeFileSync(rootReceipt, rootBytes);
  upsertParticipant(home, parent, { ...savedRoot, metadata: { ...savedRoot.metadata, nativeStop: null } });
  await rejected('absent processes without Stop authority refuse closure', () => closeServiceTask(host, parent, options), /confirmed native Codex root Stop/);
  upsertParticipant(home, parent, { ...savedRoot, metadata: { ...savedRoot.metadata,
    nativeStop: {}, nativeUnlaunched: savedRoot.metadata.nativeLaunchId } });
  await rejected('never-invoked root metadata cannot substitute for terminal Stop authority', () => closeServiceTask(host, parent, options), /confirmed native Codex root Stop/);
  upsertParticipant(home, parent, savedRoot);

  const childRoot = participantOf(readTask(home, children[0]), 'orchestrator');
  upsertParticipant(home, children[0], { ...childRoot, metadata: { ...childRoot.metadata,
    nativeStop: { ...childRoot.metadata.nativeStop, sha256: '0'.repeat(64) } } });
  await rejected('attached child root also requires its exact terminal receipt', () => closeServiceTask(host, children[0], options), /native work is active or unresolved/);
  upsertParticipant(home, children[0], childRoot);
  writeSession({ ...rootRecord, task: children[0], ref: childRoot.sessionRef, threadId: childRoot.metadata.sessionId,
    launchId: childRoot.metadata.nativeLaunchId, holderPid: process.pid, appPid: process.pid, state: 'idle', stopConfirmed: false }, env);
  await rejected('live participant retains its task even beside old Stop proof', () => closeServiceTask(host, children[0], options), /native work is active or unresolved/);
  rmSync(sessionFile(childRoot.sessionRef, env));
  upsertParticipant(home, children[0], { ...childRoot, metadata: { ...childRoot.metadata, nativeStop: null } });
  await rejected('unknown participant without retained Stop keeps its task', () => closeServiceTask(host, children[0], options), /confirmed native Codex root Stop/);
  upsertParticipant(home, children[0], childRoot);

  const unknown = participantRecord('worker:unknown', { harness: 'codex', mode: 'managed', sessionRef: 'missing-worker',
    sessionId: 'unknown-worker', nativeLaunchId: 'unknown-launch' });
  upsertParticipant(home, children[1], unknown);
  await rejected('unresolved worker blocks otherwise confirmed root closure', () => closeServiceTask(host, children[1], options), /native work is active or unresolved/);
  upsertParticipant(home, children[1], { ...unknown, metadata: { ...unknown.metadata, nativeUnlaunched: 'unknown-launch' } });

  const unknownHarness = participantRecord('worker:other', { harness: 'claude', mode: 'managed', sessionRef: 'unobserved-native' });
  upsertParticipant(home, children[1], unknownHarness);
  await rejected('unproved other harness is outside native Codex closure', () => closeServiceTask(host, children[1], options), /only confirmed native Codex participants/);
  upsertParticipant(home, children[1], { ...unknownHarness, mode: 'attached', sessionRef: null });
  await rejected('sessionless unknown worker cannot gain user mailbox exemption', () => closeServiceTask(host, children[1], options), /only confirmed native Codex participants/);
  upsertParticipant(home, children[1], participantRecord('worker:other', { harness: 'codex', mode: 'managed', sessionRef: 'never-invoked',
    nativeLaunchId: 'never-invoked-launch', nativeUnlaunched: 'never-invoked-launch' }));

  upsertParticipant(home, children[0], participantRecord('user'));
  const bb = readTask(home, children[0]);
  const { patchTask } = await import('../lib/store.js');
  patchTask(home, children[0], { adapter: { bb: { threadId: 'fixture-bb' } } });
  await rejected('BB task lifecycle cannot be closed through native route', () => closeServiceTask(host, children[0], options), /BB lifecycle is separate/);
  patchTask(home, children[0], { adapter: { ...bb.adapter, bb: null } });

  const routeTask = children[0], routeMeta = readTask(home, routeTask), parentMeta = readTask(home, parent);
  const routeFile = path.join(home, 'tasks', routeTask, 'task.json'), parentFile = path.join(home, 'tasks', parent, 'task.json');
  const routeBytes = readFileSync(routeFile), parentBytes = readFileSync(parentFile);
  const missingRouteParents = [
    ['terminal parent', () => {}],
    ['live parent', () => writeSession({ ...rootRecord, holderPid: process.pid, appPid: process.pid, state: 'idle', stopConfirmed: false }, env)],
    ['pending parent generation', root => { participantOf(root, 'orchestrator').metadata.nativePendingLaunchId = 'next-launch'; }],
    ['changed parent generation', root => { participantOf(root, 'orchestrator').metadata.nativeLaunchId = 'next-launch'; }],
    ['unresolved parent receipt', root => {
      writeFileSync(rootReceipt, incomplete);
      participantOf(root, 'orchestrator').metadata.nativeStop.sha256 = createHash('sha256').update(incomplete).digest('hex');
    }],
  ];
  for (const [name, mutate] of missingRouteParents) {
    const child = structuredClone(routeMeta), root = structuredClone(parentMeta);
    child.participants = child.participants.filter(participant => participant.role !== 'root');
    mutate(root);
    writeFileSync(routeFile, JSON.stringify(child)); writeFileSync(parentFile, JSON.stringify(root));
    try {
      await rejected(`missing entire root route with ${name} refuses child closure and preserves metadata/watch`,
        () => closeServiceTask(host, routeTask, options), /canonical native root route|native work is active or unresolved/, routeTask);
    } finally {
      writeFileSync(routeFile, routeBytes); writeFileSync(parentFile, parentBytes); writeFileSync(rootReceipt, rootBytes);
      rmSync(sessionFile(rootRecord.ref, env), { force: true });
      if (!(await workspaceServiceStatus(host, options)).warden.tasks.some(row => row.task === routeTask)) {
        await ensureTaskWarden(host, home, routeTask, options);
        if (!await waitFor(async () => (await workspaceServiceStatus(host, options)).warden.tasks
          .some(row => row.task === routeTask && row.state === 'running'), { timeoutMs: 5000 })) {
          throw new Error('Missing-root fixture watch did not become running');
        }
      }
    }
  }
  const malformedRoutes = [
    ['foreign parent target', (child, root, route) => { route.metadata.rootTask = unrelated; }],
    ['missing parent target', (child, root, route) => { delete route.metadata.rootTask; }],
    ['foreign child parent', child => { child.parent = unrelated; }],
    ['noncanonical route address', (child, root, route) => { route.metadata.address = 'root:foreign'; }],
    ['noncanonical route id', (child, root, route) => { route.id = 'root-foreign'; }],
    ['unknown route harness', (child, root, route) => { route.harness = 'opencode'; }],
    ['managed routing actor', (child, root, route) => { route.mode = 'managed'; }],
    ['routing actor session', (child, root, route) => { route.sessionRef = 'foreign-session'; }],
    ['routing actor identity', (child, root, route) => { route.metadata.sessionId = 'foreign-thread'; }],
    ['routing actor proof claim', (child, root, route) => { route.metadata.nativeStop = {}; }],
    ['duplicate root route', child => { child.participants.push(participantRecord('root:duplicate', { rootTask: parent })); }],
    ['nested parent', (child, root) => { root.parent = unrelated; }],
    ['BB parent', (child, root) => { root.adapter.bb = { threadId: 'foreign-bb' }; }],
    ['foreign current parent owner', (child, root) => { participantOf(root, 'orchestrator').metadata.owner = 'foreign-owner'; }],
    ['wrong parent owner slot', (child, root) => { root.owner = participantOf(root, 'teamlead:lead0').id; }],
    ['unknown parent Stop', (child, root) => { delete participantOf(root, 'orchestrator').metadata.nativeStop; }],
    ['pending parent generation', (child, root) => { participantOf(root, 'orchestrator').metadata.nativePendingLaunchId = 'next-launch'; }],
    ['changed parent generation', (child, root) => { participantOf(root, 'orchestrator').metadata.nativeLaunchId = 'next-launch'; }],
    ['changed attached child generation', child => { participantOf(child, 'orchestrator').metadata.nativeLaunchId = 'next-child-launch'; }],
    ['changed parent lead generation', (child, root) => { participantOf(root, 'teamlead:lead0').metadata.nativeLaunchId = 'next-lead-launch'; }],
    ['unlaunched parent alias', (child, root) => { const lead = participantOf(root, 'teamlead:lead0'); lead.metadata.nativeUnlaunched = lead.metadata.nativeLaunchId; }],
    ['missing native parent alias', (child, root) => { const lead = participantOf(root, 'teamlead:lead0'); delete lead.metadata.nativeStop; lead.metadata.nativeUnlaunched = lead.metadata.nativeLaunchId; }],
    ['foreign parent lead target', (child, root) => { participantOf(root, 'teamlead:lead0').metadata.childTask = children[1]; }],
    ['duplicate native parent link', (child, root) => { root.participants.push(participantRecord('teamlead:duplicate', {
      ...participantOf(root, 'teamlead:lead0').metadata, childTask: routeTask, harness: 'codex', mode: 'managed',
    })); }],
    ['wrong attached child owner slot', (child, root, route) => { child.owner = route.id; }],
  ];
  for (const [name, mutate] of malformedRoutes) {
    const child = structuredClone(routeMeta), root = structuredClone(parentMeta);
    mutate(child, root, child.participants.find(p => p.role === 'root'));
    writeFileSync(routeFile, JSON.stringify(child)); writeFileSync(parentFile, JSON.stringify(root));
    try {
      await rejected(`root routing refuses ${name} and preserves metadata/watch`,
        () => closeServiceTask(host, routeTask, options), /native work is active or unresolved|does not match the schema/, routeTask);
    } finally { writeFileSync(routeFile, routeBytes); writeFileSync(parentFile, parentBytes); }
  }
  writeSession({ ...rootRecord, holderPid: process.pid, appPid: process.pid, state: 'idle', stopConfirmed: false }, env);
  try {
    await rejected('live native parent cannot authorize child routing closure; metadata/watch stay unchanged',
      () => closeServiceTask(host, routeTask, options), /native work is active or unresolved/, routeTask);
  } finally { rmSync(sessionFile(rootRecord.ref, env)); }
  writeFileSync(rootReceipt, incomplete);
  upsertParticipant(home, parent, { ...savedRoot, metadata: { ...savedRoot.metadata,
    nativeStop: { ...savedRoot.metadata.nativeStop, sha256: createHash('sha256').update(incomplete).digest('hex') } } });
  try {
    await rejected('unresolved native parent receipt cannot authorize child routing closure; metadata/watch stay unchanged',
      () => closeServiceTask(host, routeTask, options), /native work is active or unresolved/, routeTask);
  } finally { writeFileSync(rootReceipt, rootBytes); writeFileSync(parentFile, parentBytes); }
  reserveLiveSeat(host, home, parent, 'worker:parent-reserved', 'codex', 'parent-reserved-fixture', env);
  const parentReservation = readFileSync(reservationFile(home, parent));
  try {
    await rejected('parent reservation cannot authorize child routing closure; metadata/watch stay unchanged',
      () => closeServiceTask(host, routeTask, options), /live or unresolved reservation/, routeTask);
    check('root routing refusal preserves exact parent reservation', readFileSync(reservationFile(home, parent)).equals(parentReservation));
  } finally { writeFileSync(reservationFile(home, parent), '[]\n'); }

  const body = JSON.stringify({ operation: 'status' });
  const held = request({ socketPath: paths.controlSocket, path: '/control', method: 'POST', agent: false,
    headers: { host: 'promptobus.local', authorization: `Bearer ${JSON.parse(readFileSync(paths.owner)).token}`,
      expect: '100-continue', 'content-length': Buffer.byteLength(body) } });
  const released = new Promise((resolve, reject) => {
    held.once('response', response => { response.resume(); response.once('end', resolve); }); held.once('error', reject);
  });
  const admitted = new Promise(resolve => held.once('continue', resolve));
  held.flushHeaders();
  await admitted;
  try {
    await rejected('in-flight owner request blocks terminal task closure', () => closeServiceTask(host, children[0], options), /settled service requests/);
  } finally { held.end(body); await released; }

  for (const task of [...children, parent]) {
    const closed = await cli(['service', 'close-task', '--task', task, '--json']);
    const status = await workspaceServiceStatus(host, options);
    check(`public owner closure drains only named task ${task}`, closed.code === 0 && readTask(home, task).status === 'done'
      && !status.warden.tasks.some(row => row.task === task), JSON.stringify({ closed, status }));
  }
  const repeatedChild = await cli(['service', 'close-task', '--task', children[0], '--json']);
  check('repeated child routing closure rechecks its stopped parent without restarting the watch', repeatedChild.code === 0
    && !(await workspaceServiceStatus(host, options)).warden.tasks.some(row => row.task === children[0]), JSON.stringify(repeatedChild));
  check('closure preserves unrelated task and its watch', JSON.stringify(readTask(home, unrelated)) === JSON.stringify(unrelatedBefore)
    && (await workspaceServiceStatus(host, options)).warden.tasks.some(row => row.task === unrelated));
  check('closure retains original root receipt bytes and linked lead Stop proof', readFileSync(rootReceipt).equals(rootBytes)
    && readTask(home, parent).participants.every(p => p.metadata.nativeStop));
  await rejected('unrelated active watch still refuses service stop', () => stopWorkspaceService(host, options), /active work/);
  const client = await registerServiceClient(host, { cwd: root, env, lifetime: { kind: 'process', process: requireProcess() } }, options);
  clients.push(client);
  const clientBytes = readFileSync(client.credentialFile);
  const repeated = await cli(['service', 'close-task', '--task', parent, '--json']);
  check('repeated explicit closure preserves unrelated live client bytes', repeated.code === 0 && readFileSync(client.credentialFile).equals(clientBytes));
  const contextTask = 'close-context-t20261113-000000';
  createTask(home, { id: contextTask, title: 'caller home context', owner: 'thread-context-home' });
  tasks.push(contextTask);
  receipt(make(contextTask, 'orchestrator', 'context-home'));
  await ensureTaskWarden(host, home, contextTask, options);
  if (!await waitFor(async () => (await workspaceServiceStatus(host, options)).warden.tasks
    .some(row => row.task === contextTask && row.state === 'running'), { timeoutMs: 5000 })) {
    throw new Error('Caller-home fixture task watch did not become running');
  }
  const contextBefore = readTask(home, contextTask);
  const demandFile = path.join(paths.directory, 'warden-demand.json');
  const taskDemand = () => JSON.parse(readFileSync(demandFile, 'utf8')).tasks[contextTask];
  const demandBefore = taskDemand();
  const watchBefore = (await workspaceServiceStatus(host, options)).warden.tasks.find(row => row.task === contextTask);
  let contextError;
  try {
    await closeServiceTask(host, contextTask, { ...options,
      env: { ...env, PROMPTOBUS_CODEX_HOME: path.join(root, 'foreign-native') }, pollEnv: env });
  } catch (error) { contextError = error; }
  const contextAfter = readTask(home, contextTask), demandAfter = taskDemand();
  const watchAfter = (await workspaceServiceStatus(host, options)).warden.tasks.find(row => row.task === contextTask);
  const metadataUnchanged = JSON.stringify(contextAfter) === JSON.stringify(contextBefore);
  const demandUnchanged = JSON.stringify(demandAfter) === JSON.stringify(demandBefore)
    && JSON.stringify(watchAfter) === JSON.stringify(watchBefore);
  check('different caller Codex home refuses closure with unchanged common poll snapshot',
    /different harness state homes/.test(contextError?.message ?? ''), contextError?.stack ?? 'unexpected success');
  check('caller-home refusal preserves exact task metadata', metadataUnchanged,
    JSON.stringify({ before: contextBefore.status, after: contextAfter.status }));
  check('caller-home refusal preserves exact watch demand and running loop', demandUnchanged,
    JSON.stringify({ demandBefore, demandAfter, watchBefore, watchAfter }));
  console.log('  · caller-home guard receipt:', JSON.stringify({ callerHomeChanged: true, commonPollSnapshotUnchanged: true,
    error: contextError?.message ?? null, metadataUnchanged, demandUnchanged, demandBefore, demandAfter, watchBefore, watchAfter }));
  await rejected('missing caller environment refuses closure', () => serviceControl(paths,
    { operation: 'close-task', runtime: runtimeIdentity(host), task: contextTask, pollEnv: env }), /Client env must contain string values/);
  await closeServiceTask(host, contextTask, { ...options, env: { ...env, LANG: 'fixture-caller-locale' }, pollEnv: env });
  check('same caller homes retain a separate common poll snapshot during closure', readTask(home, contextTask).status === 'done'
    && !(await workspaceServiceStatus(host, options)).warden.tasks.some(row => row.task === contextTask));

  await abortTaskWarden(host, unrelated, options);
  await rejected('unrelated live client still refuses service shutdown', () => stopWorkspaceService(host, options), /live clients/);
  await revokeServiceClient(host, client.clientId, options);
  const service = await workspaceServiceStatus(host, options);
  const stopped = await cli(['service', 'stop', '--json']);
  check('public service stop exits zero with physical owner absence', stopped.code === 0
    && !(await workspaceServiceStatus(host, options)).running && processState(service.process) === 'dead', JSON.stringify(stopped));
} finally {
  const status = await workspaceServiceStatus(host, options);
  if (status.running) {
    for (const task of tasks) await abortTaskWarden(host, task, options);
    for (const client of clients) if (existsSync(client.credentialFile)) await revokeServiceClient(host, client.clientId, options);
    await stopWorkspaceService(host, options);
  }
  if (priorNativeHome === undefined) delete process.env.PROMPTOBUS_CODEX_HOME; else process.env.PROMPTOBUS_CODEX_HOME = priorNativeHome;
  rmSync(privateHome, { recursive: true, force: true });
}

// Actual filesystem refusals and owner recovery, with a package Worker and owned native stubs.
import { createServer } from 'node:net';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, skip } from './check.mjs';
import { initialTaskClaimStarted } from './task-service-fixture.mjs';
import { listenTestSocket, makeSandbox, makeSockPath, writeHostConfig } from './sandbox.mjs';

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) { if (Date.now() >= deadline) return false; await wait(10); }
  return true;
};

async function runCase(failure, order = 'AB') {
  const ROOT = realpathSync(makeSandbox('promptobus-shared-warden-'));
  const mechanism = path.join(ROOT, 'mechanism');
  for (const name of ['bin', 'dist', 'lib', 'models', 'schemas', 'skills', 'package.json']) cpSync(path.join(PACKAGE, name), path.join(mechanism, name), { recursive: true });
  symlinkSync(path.join(PACKAGE, 'node_modules'), path.join(mechanism, 'node_modules'), 'dir');
  const load = name => import(pathToFileURL(path.join(mechanism, name)));
  const [{ createStandaloneHost }, store, client, state, { readWardenMark }] = await Promise.all([
    load('dist/host-index.js'), load('lib/store.js'), load('lib/service-client.js'), load('lib/service-state.js'), load('dist/sidecar.js'),
  ]);
  const WS = path.join(ROOT, 'workspace'); mkdirSync(WS); writeHostConfig(WS, { tools: ['claude'] });
  const PRIVATE = mkdtempSync(path.join(realpathSync('/tmp'), 'pbsvc-'));
  const ENTRY = path.join(ROOT, 'consumer.mjs'), FAKE = path.join(ROOT, 'claude.mjs');
  const GATE = path.join(ROOT, 'event-gate'), HELD = path.join(ROOT, 'event-held.json'), RELEASE = path.join(ROOT, 'event-release');
  const FAULT = path.join(ROOT, 'owner-control-fault.json'), TRACE = path.join(ROOT, 'owner-control.commands.jsonl');
  const CLAIM_GATE = path.join(ROOT, 'claim-gate.json'), CLAIM_HELD = path.join(ROOT, 'claim-held.json');
  const CLAIM_RELEASE = path.join(ROOT, 'claim-release'), CLAIM_TRACE = path.join(ROOT, 'claim-observation.commands.jsonl');
  const TASKS = ['failed-a-t20261101-010000', 'independent-b-t20261101-010000'];
  const requestOrder = order === 'AB' ? TASKS : [...TASKS].reverse();
  const claimOrder = failure === 'departure note' ? [...requestOrder].reverse() : null;
  const label = failure === 'departure note' ? `${failure} request-${order}/claim-${order === 'AB' ? 'BA' : 'AB'}` : failure;
  const VERSION = JSON.parse(readFileSync(path.join(mechanism, 'package.json'), 'utf8')).version;
  if (failure === 'departure note') {
    const file = path.join(mechanism, 'dist/sidecar.js'), original = readFileSync(file, 'utf8');
    const needle = '        writeWardenMark(home, id, mark);\n        bumpWardenGeneration(home, id);';
    if (original.split(needle).length !== 2) throw new Error('owned claim-publication seam changed');
    const claimHook = `
        if (fixtureClaimExists(${JSON.stringify(CLAIM_GATE)}) && !fixtureClaimExists(${JSON.stringify(CLAIM_RELEASE)})) {
            const gate = JSON.parse(fixtureClaimRead(${JSON.stringify(CLAIM_GATE)}, 'utf8'));
            if (gate.owner.pid !== process.pid || !gate.demands[id]) throw new Error('owned claim context missing');
            fixtureClaims.set(id, {mark,owner:gate.owner,demand:gate.demands[id]});
            const marks = gate.tasks.map(task => ({task,mark:readWardenMark(home,task),claim:fixtureClaims.get(task)}));
            if (marks.every(row => row.mark?.pid === process.pid && row.claim?.owner.birth === gate.owner.birth
                && row.mark.started === row.claim.mark.started && row.claim.demand === gate.demands[row.task])) {
                fixtureClaimWrite(${JSON.stringify(CLAIM_HELD)}, JSON.stringify({pid:process.pid,birth:gate.owner.birth,task:id,phase:gate.phase,
                    ordinal:readWardenGeneration(home,id),demands:gate.demands,marks,claimOrder:[...fixtureClaims.keys()]}));
                const held = new Int32Array(new SharedArrayBuffer(4));
                while (!fixtureClaimExists(${JSON.stringify(CLAIM_RELEASE)})) Atomics.wait(held, 0, 0, 10);
            }
        }
`;
    writeFileSync(file, "import { existsSync as fixtureClaimExists, readFileSync as fixtureClaimRead, writeFileSync as fixtureClaimWrite } from 'node:fs';\n"
      + 'const fixtureClaims = new Map();\n'
      + original.replace(needle, '        writeWardenMark(home, id, mark);' + claimHook + '        bumpWardenGeneration(home, id);'));
  }
  writeFileSync(FAKE, `#!${process.execPath}
if (process.argv.includes('--version')) console.log('2.1.284');
else console.log(${JSON.stringify(JSON.stringify(TASKS.map((task, index) => ({ name: `ref-${index}`, id: `native-${index}`, sessionId: `native-${index}`, pid: process.pid, state: 'idle' }))))});
`, { mode: 0o755 });
  writeFileSync(ENTRY, `import { Worker } from 'node:worker_threads';
import fs, { existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createStandaloneHost } from ${JSON.stringify(pathToFileURL(path.join(mechanism, 'dist/host-index.js')).href)};
import { runPromptobus } from ${JSON.stringify(pathToFileURL(path.join(mechanism, 'lib/cli.js')).href)};
import { requireProcess } from ${JSON.stringify(pathToFileURL(path.join(mechanism, 'lib/service-state.js')).href)};
const fixtureOwner = requireProcess();
const trace = value => appendFileSync(${JSON.stringify(TRACE)}, JSON.stringify({owner:fixtureOwner.pid,birth:fixtureOwner.birth,at:Date.now(),...value})+String.fromCharCode(10));
const rename = fs.renameSync;
fs.renameSync = (from,to) => {
  const fault = existsSync(${JSON.stringify(FAULT)}) ? JSON.parse(readFileSync(${JSON.stringify(FAULT)},'utf8')) : null;
  if (fault && String(to)===fault.file) {
    const candidate = JSON.parse(readFileSync(from,'utf8'));
    if (fault.phase==='after replace') rename(from,to);
    trace({kind:'persist/fault',phase:fault.phase,operation:fault.operation,candidate,durableBase64:readFileSync(to).toString('base64')});
    throw Object.assign(new Error('owned control '+fault.operation+' '+fault.phase+' persistence failure'),{code:'EIO'});
  }
  return rename(from,to);
};
syncBuiltinESMExports();
const originalPost = Worker.prototype.postMessage;
let queuedPhase, queuedStarts = new Map();
Worker.prototype.postMessage = function(message,...args) {
  trace({kind:'worker/command',command:message.kind,task:message.task??null,generation:message.generation??null});
  if (message.kind==='start' && existsSync(${JSON.stringify(CLAIM_GATE)}) && !existsSync(${JSON.stringify(CLAIM_RELEASE)})) {
    const gate = JSON.parse(readFileSync(${JSON.stringify(CLAIM_GATE)},'utf8'));
    if (gate.tasks.includes(message.task)) {
      if (queuedPhase !== gate.phase) { queuedPhase=gate.phase; queuedStarts=new Map(); }
      gate.owner=fixtureOwner; gate.demands[message.task]=message.generation;
      writeFileSync(${JSON.stringify(CLAIM_GATE)},JSON.stringify(gate));
      queuedStarts.set(message.task,message);
      trace({kind:'worker/start-queued',phase:gate.phase,task:message.task,generation:message.generation});
      if (gate.tasks.every(task=>queuedStarts.has(task))) {
        for (const task of gate.claimOrder) {
          const next=queuedStarts.get(task);
          trace({kind:'worker/start-forwarded',phase:gate.phase,task,generation:next.generation});
          originalPost.call(this,next,...args);
        }
        queuedStarts.clear();
      }
      return;
    }
  }
  return originalPost.call(this,message,...args);
};
const originalEmit = Worker.prototype.emit;
Worker.prototype.emit = function(event, ...args) {
  const message = args[0];
  if (event==='exit') trace({kind:'worker/exit',code:message});
  if (event==='message' && message?.kind==='started') trace({kind:'worker/started',task:message.task,generation:message.generation});
  if (event === 'message' && ['settled', 'failed'].includes(message?.kind) && message.task === ${JSON.stringify(TASKS[0])}
    && existsSync(${JSON.stringify(GATE)})) {
    writeFileSync(${JSON.stringify(HELD)}, JSON.stringify(message));
    const timer = setInterval(() => {
      if (existsSync(${JSON.stringify(RELEASE)})) {
        clearInterval(timer); trace({kind:'worker/released',task:message.task,generation:message.generation,outcome:message.kind});
        originalEmit.call(this, event, ...args);
      }
    }, 5);
    return true;
  }
  return originalEmit.call(this, event, ...args);
};
const make = ({cwd}) => {
  const host = createStandaloneHost({cwd,binPath:${JSON.stringify(ENTRY)},version:${JSON.stringify(VERSION)}});
  const resolve = host.resolveToolBin;
  host.resolveToolBin = tool => tool === 'claude' ? {ok:true,bin:${JSON.stringify(FAKE)}} : resolve(tool);
  return host;
};
const code = await runPromptobus(process.argv.slice(2), {host:make({cwd:process.cwd()}),createHost:make,cwd:process.cwd(),env:process.env});
if (code) process.exitCode = code;
`);
  const host = createStandaloneHost({ cwd: WS, binPath: ENTRY, version: VERSION });
  const resolve = host.resolveToolBin;
  host.resolveToolBin = tool => tool === 'claude' ? { ok: true, bin: FAKE } : resolve(tool);
  const HOME = host.promptobusHome(), env = { ...process.env, PROMPTOBUS_SERVICE_HOME: PRIVATE,
    PROMPTOBUS_SERVICE_IDLE_MS: '60000', CLAUDE_CODE_SESSION_ID: 'owned-fixture-root' };
  const options = { cwd: WS, env }, paths = state.servicePaths(host, env);
  let claimSequence = 0;
  const claimReceipt = value => appendFileSync(CLAIM_TRACE, JSON.stringify({ sequence: ++claimSequence, at: Date.now(), ...value }) + '\n');
  const armClaimBarrier = phase => {
    if (failure !== 'departure note') return;
    rmSync(CLAIM_HELD, { force: true }); rmSync(CLAIM_RELEASE, { force: true });
    writeFileSync(CLAIM_GATE, JSON.stringify({ phase, tasks: TASKS, requestOrder, claimOrder, owner: null, demands: {} }));
  };
  const waitClaims = async (phase, tasks, identity) => {
    const expected = JSON.parse(readFileSync(path.join(paths.directory, 'warden-demand.json'), 'utf8')).tasks;
    let sample = null, observedBarrier = false;
    const ready = await until(async () => {
      const status = await client.workspaceServiceStatus(host, options);
      const acknowledgments = existsSync(TRACE) ? readFileSync(TRACE, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(row => row.kind === 'worker/started' && row.owner === identity.pid && row.birth === identity.birth) : [];
      sample = { kind: 'claim/observed', phase, sourceOrder: ['owner status response', 'actual started ledger', 'owner PID/birth observation', 'task mark/ordinal reads', 'durable demand read'],
        expectedOwner: identity, observedOwner: status.process, ownerState: state.processState(identity), coordinator: status.warden,
        expected, acknowledgments,
        tasks: tasks.map(task => ({ task, mark: readWardenMark(HOME, task), ordinal: store.readWardenGeneration(HOME, task) })),
        durable: JSON.parse(readFileSync(path.join(paths.directory, 'warden-demand.json'), 'utf8')) };
      claimReceipt(sample);
      const acknowledged = status.running && status.process.pid === identity.pid && status.process.birth === identity.birth
        && sample.tasks.every(row => row.mark?.pid === identity.pid
          && status.warden.tasks.some(task => task.task === row.task && task.pid === identity.pid && task.state === 'running')
          && sample.durable.tasks[row.task]?.demand === expected[row.task]?.demand
          && acknowledgments.some(ack => ack.task === row.task && ack.generation === expected[row.task]?.demand));
      // Keep the independent Worker ACK calibration beside done-user's baseline fence.
      const published = acknowledged && sample.tasks.every(row => initialTaskClaimStarted({ status, owner: identity, task: row.task,
        initialDemand: expected[row.task], durableDemand: sample.durable.tasks[row.task], mark: row.mark, ownerState: sample.ownerState }));
      if (failure === 'departure note' && existsSync(CLAIM_HELD) && !existsSync(CLAIM_RELEASE)) {
        observedBarrier = true;
        const held = JSON.parse(readFileSync(CLAIM_HELD, 'utf8'));
        const row = sample.tasks.find(task => task.task === held.task);
        const oldMarkOnlyReady = sample.tasks.every(task => task.mark?.pid === identity.pid);
        const baselineReady = initialTaskClaimStarted({ status, owner: identity, task: held.task,
          initialDemand: expected[held.task], durableDemand: sample.durable.tasks[held.task], mark: row?.mark, ownerState: sample.ownerState });
        check(`warden claim ${label} ${phase}: published mark precedes its ordinal and actual started acknowledgment`,
          held.pid === identity.pid && held.birth === identity.birth && held.phase === phase && sample.ownerState === 'alive' && row?.mark?.pid === identity.pid
          && row.ordinal === held.ordinal && oldMarkOnlyReady && !published && !baselineReady
          && JSON.stringify(held.claimOrder) === JSON.stringify(claimOrder) && held.task === claimOrder.at(-1)
          && held.marks.every(mark => mark.claim?.owner.pid === identity.pid && mark.claim.owner.birth === identity.birth
            && mark.claim.demand === expected[mark.task]?.demand && mark.mark?.started === mark.claim.mark.started)
          && !acknowledgments.some(ack => ack.task === held.task && ack.generation === expected[held.task]?.demand)
          && status.warden.tasks.some(task => task.task === held.task && task.state === 'starting'), JSON.stringify({ held, sample, oldMarkOnlyReady, acknowledged, published, baselineReady }));
        claimReceipt({ kind: 'claim/unpublished-barrier', phase, held, oldMarkOnlyReady, acknowledged, published, baselineReady, sample });
        writeFileSync(CLAIM_RELEASE, 'release the owned claim after its exact unpublished observation');
      }
      return published;
    });
    if (failure === 'departure note' && !observedBarrier) check(`warden claim ${label} ${phase}: published mark precedes its ordinal and actual started acknowledgment`,
      false, JSON.stringify({ reason: 'expected owned claim barrier was not observed', sample }));
    claimReceipt({ kind: 'claim/wait-result', phase, ready, sample, observedBarrier, missingAcknowledgment: !ready });
    return { ready, sample };
  };
  const endpoint = makeSockPath('a2s-')(`warden-failure-${failure.replaceAll(' ', '-')}-${order}`);
  const received = [], connections = new Set(), owned = [];
  const server = createServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    let body = ''; socket.on('data', bytes => { body += bytes; });
    socket.on('end', () => { received.push(body); socket.destroy(); });
  });
  let credential, unlock = () => {}, lockPromise = Promise.resolve(), backup = null, obstruction = null, aborted;
  try {
    const listening = await listenTestSocket(server, endpoint);
    if (!listening.ok) throw new Error(listening.reason);
    store.bus(HOME, { cli: VERSION });
    for (const [index, task] of TASKS.entries()) {
      store.createTask(HOME, { id: task, title: 'owned failure recovery', owner: 'owned-fixture-root' });
      store.upsertParticipant(HOME, task, store.participantRecord('worker:fixture', { harness: 'claude', sessionRef: `ref-${index}`, sessionId: `native-${index}` }));
      store.writeWake(HOME, task, 'worker:fixture', { socket: endpoint, token: `fixture-${index}`, session: `native-${index}` });
    }
    credential = await client.registerServiceClient(host, { cwd: WS, env, lifetime: { kind: 'process', process: state.requireProcess() } }, options);
    const original = (await client.workspaceServiceStatus(host, options)).process; owned.push(original);
    armClaimBarrier('initial');
    claimReceipt({ kind: 'claim/request-order', phase: 'initial', requestOrder, claimOrder });
    await Promise.all(requestOrder.map(task => client.ensureTaskWarden(host, HOME, task, options)));
    const initialClaims = await waitClaims('initial', TASKS, original), running = initialClaims.ready;
    check(`warden failure ${label}: two actual task seats and a separate client retain one physical owner`,
      running && state.processState(original) === 'alive', JSON.stringify({ original, initialClaims }));
    const generations = TASKS.map(task => store.readWardenGeneration(HOME, task));
    claimReceipt({ kind: 'claim/initial-ordinals', owner: original, generations, seats: running, coordinator: initialClaims.sample });
    writeFileSync(GATE, 'hold only this actual task settlement');
    if (failure.startsWith('owner ')) {
      const operation = failure.includes('ensure') ? 'ensure' : 'abort';
      const phase = failure.endsWith('after replace') ? 'after replace' : 'before replace';
      const demandFile = path.join(paths.directory, 'warden-demand.json');
      const trace = () => existsSync(TRACE) ? readFileSync(TRACE, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      if (operation === 'ensure') {
        aborted = client.abortTaskWarden(host, TASKS[0], options).then(result => ({ result }), error => ({ error: error.message }));
        if (!await until(() => existsSync(HELD))) throw new Error('accepted abort did not reach its actual held settlement');
        const status = await client.workspaceServiceStatus(host, options);
        if (JSON.parse(readFileSync(demandFile, 'utf8')).tasks[TASKS[0]].required !== false
          || !status.warden.tasks.some(task => task.task === TASKS[0] && task.state === 'stopping')) throw new Error('abort intent was not durably accepted before ensure refusal');
      }
      const beforeBytes = readFileSync(demandFile);
      writeFileSync(FAULT, JSON.stringify({ file: demandFile, operation, phase }));
      const outcome = await (operation === 'ensure' ? client.ensureTaskWarden(host, HOME, TASKS[0], options)
        : client.abortTaskWarden(host, TASKS[0], options)).then(result => ({ result }), error => ({ error: error.message }));
      const attempt = trace().find(row => row.owner === original.pid && row.kind === 'persist/fault');
      const afterBytes = readFileSync(demandFile), actualSnapshot = JSON.parse(afterBytes.toString('utf8'));
      const candidate = attempt?.candidate?.tasks?.[TASKS[0]];
      const knownOutcome = phase === 'before replace' ? afterBytes.equals(beforeBytes)
        : !!candidate && actualSnapshot.tasks[TASKS[0]].demand === candidate.demand && actualSnapshot.tasks[TASKS[0]].required === candidate.required;
      check(`warden ${label}: actual owner-control refusal preserves a known pre-replace or committed write outcome`,
        !!outcome.error && !!attempt && knownOutcome && Buffer.from(attempt.durableBase64, 'base64').equals(afterBytes),
      JSON.stringify({ outcome, attempt, beforeBase64: beforeBytes.toString('base64'), afterBase64: afterBytes.toString('base64') }));
      await until(() => existsSync(HELD), 1000);
      writeFileSync(RELEASE, 'deliver actual A settlement after persistence failure');
      const dead = await until(() => state.processState(original) === 'dead');
      const ownerRows = trace().filter(row => row.owner === original.pid);
      const faultIndex = ownerRows.findIndex(row => row.kind === 'persist/fault');
      const laterStarts = ownerRows.slice(faultIndex + 1).filter(row => row.kind === 'worker/command' && row.command === 'start');
      const workerExited = ownerRows.some(row => row.kind === 'worker/exit');
      const primary = `owned control ${operation} ${phase} persistence failure`;
      const logFile = path.join(paths.directory, 'startup-error.log');
      const fatalLog = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
      check(`warden ${label}: fatal closes the actual Worker and owner without scheduling after the refused transaction`,
        dead && workerExited && !existsSync(paths.lock) && laterStarts.length === 0 && fatalLog.includes(primary)
        && ownerRows.filter(row => row.kind === 'worker/command' && row.command === 'close').length === 1,
      JSON.stringify({ original, dead, workerExited, lockPresent: existsSync(paths.lock), laterStarts, fatalLog, ownerRows }));
      const faultCount = ownerRows.filter(row => row.kind === 'persist/fault').length;
      for (const command of ['warden-ensure', 'warden-abort']) await client.serviceControl(paths, {
        runtime: state.runtimeIdentity(host), operation: command, task: TASKS[0],
      }).catch(() => {});
      check(`warden ${label}: late owner calls and released callbacks leave the exact durable bytes for inspection`,
        readFileSync(demandFile).equals(afterBytes) && trace().filter(row => row.owner === original.pid && row.kind === 'persist/fault').length === faultCount,
      JSON.stringify({ dead, phase, faultCount, actual: readFileSync(demandFile).toString('base64'), expected: afterBytes.toString('base64') }));
      writeSync(1, `  · owner-control-failure-receipt: ${JSON.stringify({ failure, label, requestOrder, claimOrder, runtimeDirectory: mechanism, original, outcome,
        attempt, actualSnapshot, beforeBase64: beforeBytes.toString('base64'), afterBase64: afterBytes.toString('base64'), dead, workerExited, laterStarts, ownerRows, fatalLog })}\n`);
      rmSync(FAULT);
      let recovered = null, exact = false, delivered = false;
      if (dead) {
        recovered = await client.ensureWorkspaceService(host, options); owned.push(recovered.process);
        const required = TASKS.filter(task => actualSnapshot.tasks[task]?.required);
        const recoveryClaims = await waitClaims('recovery', required, recovered.process);
        const seats = recoveryClaims.ready && TASKS.filter(task => !required.includes(task)).every(task => readWardenMark(HOME, task) === null);
        const recoveredStarts = trace().filter(row => row.owner === recovered.process.pid && row.kind === 'worker/command' && row.command === 'start');
        exact = seats && required.length === recoveredStarts.length && required.every(task =>
          recoveredStarts.filter(row => row.task === task && row.generation === actualSnapshot.tasks[task].demand).length === 1
          && store.readWardenGeneration(HOME, task) === generations[TASKS.indexOf(task)] + 1)
          && TASKS.filter(task => !required.includes(task)).every(task => store.readWardenGeneration(HOME, task) === generations[TASKS.indexOf(task)]);
        store.sendMessage(HOME, required[0], { from: 'orchestrator', to: 'worker:fixture', type: 'task', body: 'recovery of exact durable intent' });
        delivered = await until(() => received.some(body => body.includes(required[0])));
        writeSync(1, `  · owner-control-recovery-receipt: ${JSON.stringify({ failure, actualSnapshot, recovered: recovered.process, recoveredStarts, exact, delivered })}\n`);
      }
      check(`warden ${label}: recovery follows the actual durable generation once, not caller success or a new retry`,
        !!recovered && exact && delivered, JSON.stringify({ recovered: recovered?.process, actualSnapshot, exact, delivered }));
      if (recovered) {
        await client.revokeServiceClient(host, credential.clientId, options); credential = null;
        await Promise.all(TASKS.map(task => client.abortTaskWarden(host, task, options)));
        await client.stopWorkspaceService(host, options);
      }
      check(`warden ${label}: owner-supported fixture disposal leaves no live service generation or owner lock`,
        !!recovered && await until(() => owned.every(identity => state.processState(identity) === 'dead')) && !existsSync(paths.lock));
      return;
    }
    if (failure === 'departure note') {
      obstruction = path.join(store.taskDir(HOME, TASKS[0]), 'waits', 'warden.exit.json'); mkdirSync(obstruction, { recursive: true });
    } else if (failure === 'seat clear') {
      let locked = false;
      lockPromise = store.withTaskLockAsync(HOME, TASKS[0], async () => {
        locked = true; await new Promise(resolve => { unlock = resolve; });
      });
      if (!await until(() => locked)) throw new Error('owned task lock did not enter its barrier');
    }
    aborted = client.abortTaskWarden(host, TASKS[0], options).then(result => ({ result }), error => ({ error: error.message }));
    const held = await until(() => existsSync(HELD), 15000);
    const message = held ? JSON.parse(readFileSync(HELD, 'utf8')) : null;
    const retainedMark = readWardenMark(HOME, TASKS[0]);
    if (!held) throw new Error('owned actual Worker settlement did not reach the barrier');
    if (failure !== 'demand persistence') await client.ensureTaskWarden(host, HOME, TASKS[0], options);
    else {
      obstruction = path.join(paths.directory, 'warden-demand.json'); backup = obstruction + '.fixture-backup';
      renameSync(obstruction, backup); mkdirSync(obstruction);
    }
    unlock(); await lockPromise;
    writeFileSync(RELEASE, 'deliver the actual Worker outcome');
    const dead = await until(() => state.processState(original) === 'dead');
    const logFile = path.join(paths.directory, 'startup-error.log');
    const fatalLog = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    const originalFailure = failure === 'departure note' ? /EISDIR|EEXIST/.test(fatalLog) && fatalLog.includes('warden.exit.json')
      : failure === 'seat clear' ? /busy|locked/i.test(fatalLog) && fatalLog.includes(TASKS[0])
        : /EISDIR|EEXIST/.test(fatalLog) && fatalLog.includes('warden-demand.json');
    const outcome = await Promise.race([aborted, wait(1000).then(() => ({ pending: true }))]);
    writeSync(1, `  · warden-failure-receipt: ${JSON.stringify({ failure, label, requestOrder, claimOrder, runtimeDirectory: mechanism, original,
      message, retainedMark, dead, lockPresent: existsSync(paths.lock), outcome, fatalLog })}\n`);
    check(`warden failure ${label}: actual failure is not certified as a stopped task under a live shared PID`,
      (failure === 'demand persistence' || message?.kind === 'failed') && dead && !outcome.result,
      JSON.stringify({ message, original, state: state.processState(original), outcome, fatalLog }));
    check(`warden failure ${label}: physical owner exit releases its lock and preserves the original failure`,
      dead && !existsSync(paths.lock) && originalFailure,
      JSON.stringify({ dead, lockPresent: existsSync(paths.lock), fatalLog }));
    if (obstruction) { rmSync(obstruction, { recursive: true, force: true }); if (backup) renameSync(backup, obstruction); obstruction = null; backup = null; }
    let recovered = null, delivered = false, exact = false, recoveryProof = null;
    if (dead) {
      armClaimBarrier('recovery');
      recovered = await client.ensureWorkspaceService(host, options); owned.push(recovered.process);
      const wanted = failure === 'demand persistence' ? [TASKS[1]] : TASKS;
      const recoveryClaims = await waitClaims('recovery', wanted, recovered.process), seats = recoveryClaims.ready;
      const recoveredOrdinals = Object.fromEntries(wanted.map(task => [task, store.readWardenGeneration(HOME, task)]));
      exact = seats && wanted.every(task => recoveredOrdinals[task] === generations[TASKS.indexOf(task)] + 1);
      recoveryProof = { kind: 'claim/recovery-verdict', original, recovered: recovered.process, initialOrdinals: generations,
        recoveredOrdinals, seats, exact, coordinator: recoveryClaims.sample,
        reasonExactFalse: exact ? null : { seats, mismatches: wanted.filter(task => recoveredOrdinals[task] !== generations[TASKS.indexOf(task)] + 1) } };
      claimReceipt(recoveryProof);
      store.sendMessage(HOME, wanted[0], { from: 'orchestrator', to: 'worker:fixture', type: 'task', body: 'owned recovery delivery' });
      delivered = await until(() => received.some(body => body.includes(wanted[0])));
    }
    check(`warden failure ${label}: owner preflight recovers durable work in exactly one successor generation and delivers`,
      !!recovered && recovered.process.pid !== original.pid && exact && delivered,
      JSON.stringify({ recovered: recovered?.process, exact, delivered, recoveryProof, generations: TASKS.map(task => store.readWardenGeneration(HOME, task)) }));
  } finally {
    writeFileSync(CLAIM_RELEASE, 'owned claim barrier insurance after verdict');
    unlock(); await lockPromise.catch(() => {}); writeFileSync(RELEASE, 'fixture insurance release');
    if (obstruction) { rmSync(obstruction, { recursive: true, force: true }); if (backup) renameSync(backup, obstruction); }
    try { await client.stopWorkspaceService(host, options); } catch { /* verified-owned insurance follows */ }
    for (const identity of owned) if (state.processState(identity) === 'alive') {
      writeSync(1, `  · fixture-insurance-after-verdict: ${JSON.stringify(identity)}\n`);
      try { process.kill(identity.pid, 'SIGTERM'); } catch { /* already exited */ }
      await until(() => state.processState(identity) === 'dead');
    }
    if (aborted) await Promise.race([aborted, wait(1000)]);
    for (const socket of connections) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (owned.every(identity => state.processState(identity) === 'dead')) rmSync(PRIVATE, { recursive: true, force: true });
  }
}

if (!['darwin', 'linux'].includes(process.platform)) skip('shared warden failure recovery', 'OS process-birth proof is unavailable on this platform');
else {
  for (const order of ['AB', 'BA']) await runCase('departure note', order);
  for (const failure of ['seat clear', 'demand persistence',
    'owner ensure before replace', 'owner ensure after replace', 'owner abort before replace', 'owner abort after replace']) await runCase(failure);
}

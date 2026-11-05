// Exercise the actual script across shared-owner teardown, delayed identity and retained UNKNOWN.
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { readCompleteJson, waitFor } from './harness.mjs';
import { proveStandIsolation, STUB_BIN } from '../scripts/live-entry.mjs';
import { RUN_OWNER_FILE, sweepLiveRuns } from '../scripts/canary-runs.mjs';
import * as cursorStub from './harness-cursor.mjs';
import * as cursorSession from '../lib/cursor-persist.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { processState } from '../lib/service-state.js';

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const boundary of ['early normal', 'delayed abort', 'unknown abort', 'unknown normal', 'foreign task', 'foreign home']) {
  const foreign = boundary.startsWith('foreign');
  const ROOT = makeSandbox('promptobus-promptobus-live-cursor-cleanup-');
  const bins = path.join(ROOT, 'bin'), harness = await cursorStub.installHarness({ binDir: bins, bundledRuntime: true });
  const mechanism = path.join(ROOT, 'mechanism');
  for (const name of ['bin', 'dist', 'lib', 'models', 'schemas', 'skills', 'scripts', 'test', 'package.json']) cpSync(path.join(PACKAGE, name), path.join(mechanism, name), { recursive: true });
  symlinkSync(path.join(PACKAGE, 'node_modules'), path.join(mechanism, 'node_modules'), 'dir');
  const entry = path.join(mechanism, 'scripts', 'live-cursor.mjs');
  const raisedFile = path.join(ROOT, 'raised.json'), release = path.join(ROOT, 'release'), armed = path.join(ROOT, 'Stop-armed');
  const stopFile = path.join(ROOT, 'Stop.json'), removedFile = path.join(ROOT, 'before-remove.json'), delayed = path.join(ROOT, 'delayed.jsonl');
  const privateBeforeMigration = mkdtempSync(path.join(realpathSync('/tmp'), 'pbcur-fixture-'));
  let source = readFileSync(entry, 'utf8');
  const anchor = boundary === 'early normal' ? '  // --- step 2: raise a Cursor participant' : "  ref = wp?.sessionRef ?? '';";
  if (source.split(anchor).length !== 2) throw new Error(`live Cursor fixture lost the ${boundary} boundary`);
  const injection = `
    const {requireProcess: fixtureProcess, servicePaths: fixturePaths, readPrivate: fixtureRead, writePrivate: fixtureWrite} = await import('../lib/service-state.js');
    const fixtureMark = store.liveWarden(home,TASK), fixtureNative = ref ? readSession(ref) : null;
    let fixtureCredentials = null;
    ${foreign ? `
    const {createStandaloneHost: fixtureHost} = await import('../dist/host-index.js');
    const {randomUUID: fixtureUuid} = await import('node:crypto');
    const fixtureClients = fixturePaths(fixtureHost({cwd:ws, binPath:path.join(MECHANISM_ROOT,'bin','promptobus.js'),
      version:JSON.parse(readFileSync(path.join(MECHANISM_ROOT,'package.json'),'utf8')).version}),env).clients;
    const fixtureOwned = readdirSync(fixtureClients).map(name=>({file:path.join(fixtureClients,name),grant:fixtureRead(path.join(fixtureClients,name))}))
      .find(row=>row.grant?.lifetime?.kind==='managed' && row.grant.lifetime.task===TASK);
    if(!fixtureOwned) throw new Error('Foreign cleanup boundary has no actual owned grant');
    const fixtureOther = structuredClone(fixtureOwned.grant); fixtureOther.id=fixtureUuid();
    ${boundary === 'foreign task' ? "fixtureOther.lifetime.task='foreign-'+TASK;" : `
    fixtureOther.env.PROMPTOBUS_HOME=path.join(SB,'foreign-home');mkdirSync(fixtureOther.env.PROMPTOBUS_HOME);
    // Keep the foreign transport unresolved independently of the owned native Stop.
    fixtureOther.nativeBinding={kind:fixtureOther.nativeBinding.kind,state:'pending'};
    `}
    const fixtureForeignFile=path.join(fixtureClients,fixtureOther.id+'.json');
    fixtureWrite(fixtureForeignFile,fixtureOther);
    fixtureCredentials={owned:fixtureOwned.file,foreign:fixtureForeignFile};
    ` : ''}
    writeFileSync(${JSON.stringify(raisedFile)}, JSON.stringify({ref:ref||null,pane:fixtureNative?.panePid?fixtureProcess(fixtureNative.panePid):null,
      owner:fixtureMark?.pid?fixtureProcess(fixtureMark.pid):null,sandbox:SB,ws,home,task:TASK,serviceHome:env.PROMPTOBUS_SERVICE_HOME,credentials:fixtureCredentials}));
    while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10));
    throw new Error('owned live Cursor fixture failure: ${boundary}');
  `;
  source = boundary === 'early normal' ? source.replace(anchor, injection + anchor) : source.replace(anchor, anchor + injection);
  source = source.replaceAll('rmSync(SB, { recursive: true, force: true });', `
    const {processState: fixtureState} = await import('../lib/service-state.js');
    const fixtureRaised=JSON.parse(readFileSync(${JSON.stringify(raisedFile)},'utf8'));
    writeFileSync(${JSON.stringify(removedFile)},JSON.stringify({owner:fixtureRaised.owner,ownerState:fixtureRaised.owner?fixtureState(fixtureRaised.owner):'unknown',
      paneState:fixtureRaised.pane?fixtureState(fixtureRaised.pane):null,seat:store.liveWarden(home,TASK),sandboxPresent:existsSync(SB)}));
    rmSync(SB, { recursive: true, force: true });
  `);
  writeFileSync(entry, source);
  const driverFile = path.join(mechanism, 'lib', 'driver-cursor.js');
  const absenceNote = '`persist session ${id} final absence deadline elapsed; record retained`';
  const driverSource = readFileSync(driverFile, 'utf8');
  if (driverSource.split(absenceNote).length !== 3) throw new Error('Live Cursor fixture lost its two final-absence refusals');
  let absenceStage = 0;
  writeFileSync(driverFile, driverSource.replaceAll(absenceNote, () => {
    const after = absenceStage++ === 1;
    return `${absenceNote} + ' · ' + JSON.stringify({stage:${JSON.stringify(after ? 'after-final-observe' : 'before-final-observe')},
      budgetMs:waitOptions?.timeoutMs??STOP_TIMEOUT_MS,deadline,now:Date.now(),doneStopped:done.stopped??null,
      doneMissing:done.missing===null?false:typeof done.missing==='string'?true:null,
      sessionCount:${after ? 'Array.isArray(after.sessions)?after.sessions.length:null' : 'null'},
      missing:${after ? "after.missing===null?false:typeof after.missing==='string'?true:null" : 'null'}})`;
  }));
  appendFileSync(driverFile, `
import {writeFileSync as fixtureWrite} from 'node:fs';
import {processIdentity as fixtureIdentity,processState as fixtureState} from './service-state.js';
const fixtureStop=cursorDriver.stop;
cursorDriver.stop=async(ref,options)=>{
  const record=readSession(ref),pane=record?.panePid?fixtureIdentity(record.panePid):null;
  fixtureWrite(${JSON.stringify(armed)},'native Stop entered');
  const result=await fixtureStop(ref,options);
  fixtureWrite(${JSON.stringify(stopFile)},JSON.stringify({ref,timeoutMs:options?.timeoutMs,pane,result,
    stateBeforeTeardown:pane?fixtureState(pane):'unknown',recordPresent:!!readSession(ref)}));
  return result;
};
`);
  stubCommand(bins, 'tmux', `
import {appendFileSync,existsSync} from 'node:fs';
import {tmuxMain} from ${JSON.stringify(path.join(PACKAGE, 'test', 'harness-cursor.mjs'))};
if(process.argv.includes('list-sessions')&&existsSync(${JSON.stringify(armed)})){
  if(${JSON.stringify(boundary)}.startsWith('unknown')) {process.stderr.write('owned fresh identity unavailable\\n');process.exitCode=1;}
  else {const startedAt=Date.now();await new Promise(resolve=>setTimeout(resolve,30));
    appendFileSync(${JSON.stringify(delayed)},JSON.stringify({startedAt,finishedAt:Date.now()})+'\\n');
    await tmuxMain(process.argv.slice(2),{...process.env,${cursorStub.CURSOR_HOME_VAR}:${JSON.stringify(harness.home)}});}
}else await tmuxMain(process.argv.slice(2),{...process.env,${cursorStub.CURSOR_HOME_VAR}:${JSON.stringify(harness.home)}});
`);
  const proved = proveStandIsolation({ binDir: bins, names: ['agent', 'cursor', 'cursor-agent', { name: 'tmux', probe: ['-V'] }],
    homes: { [cursorStub.CURSOR_HOME_VAR]: harness.home, PROMPTOBUS_CURSOR_HOME: harness.stateHome,
      PROMPTOBUS_CURSOR_USER_HOME: harness.userHome }, env: process.env });
  if (!proved.ok) throw new Error(`owned Cursor isolation refused: ${proved.reason}`);
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PROMPTOBUS_SERVICE_HOME: privateBeforeMigration, [STUB_BIN]: bins } });
  let out = '', exit = null;
  child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { out += bytes; });
  const done = new Promise(resolve => child.on('close', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  let raised;
  try {
    raised = await waitFor(() => readCompleteJson(raisedFile) ?? (exit ? { earlyExit: exit } : null), { timeoutMs: 120000 });
    check(`live Cursor ${boundary}: actual owned owner and expected native pane exist at the boundary`,
      !!raised?.owner && processState(raised.owner) === 'alive'
      && (boundary === 'early normal' ? !raised.ref && !raised.pane : !!raised.pane && processState(raised.pane) === 'alive'),
      JSON.stringify({ raised, out }));
    const signal = boundary.endsWith('abort');
    if (signal) child.kill('SIGTERM'); else writeFileSync(release, 'raise the normal fixture exception');
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, 40000).unref())]);
    const stopped = existsSync(stopFile) ? JSON.parse(readFileSync(stopFile, 'utf8')) : null;
    const removed = existsSync(removedFile) ? JSON.parse(readFileSync(removedFile, 'utf8')) : null;
    const record = raised?.ref ? cursorSession.readSession(raised.ref) : null;
    const sandbox = raised?.sandbox, unknown = boundary.startsWith('unknown');
    writeSync(1, `  · live-cursor-cleanup-receipt: ${JSON.stringify({ boundary, runtimeDirectory: mechanism,
      exit, raised, stopped, removed, sandboxPresentAfterExit: sandbox ? existsSync(sandbox) : null,
      recordPresentAfterExit: !!record, homePresentAfterExit: record?.cwd ? existsSync(record.cwd) : null,
      ownerStateAfterExit: raised?.owner ? processState(raised.owner) : 'unknown' })}\n`);
    check(`live Cursor ${boundary}: cleanup is awaited and the original scenario or signal outcome remains unsuccessful`,
      exit?.code === (signal ? 143 : 1) && out.includes(signal ? 'run cut off by SIGTERM' : `owned live Cursor fixture failure: ${boundary}`),
      JSON.stringify({ exit, stopped, out }));
    if (foreign) check(`live Cursor ${boundary}: only owned task transport is revoked and a foreign credential refuses service stop`,
      !!raised?.credentials && !existsSync(raised.credentials.owned) && existsSync(raised.credentials.foreign)
      && processState(raised.owner) === 'alive' && stopped?.result?.stopped === true && !record
      && !!sandbox && existsSync(sandbox) && !removed && out.includes('Shared service still has live clients or active work'),
      JSON.stringify({ raised, stopped, removed, out }));
    else check(`live Cursor ${boundary}: the same physical shared owner exits and releases its task seat before teardown`,
      !!raised?.owner && processState(raised.owner) === 'dead'
      && (unknown ? !!sandbox && existsSync(sandbox) : removed?.ownerState === 'dead' && removed?.seat === null && removed?.sandboxPresent === true),
      JSON.stringify({ raised, removed, out }));
    if (boundary === 'delayed abort') {
      const reads = existsSync(delayed) ? readFileSync(delayed, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      check('live Cursor delayed abort: fresh delayed native identity still stops the same pane before sandbox removal',
        reads.some(read => read.finishedAt - read.startedAt >= 20) && stopped?.timeoutMs > 0 && stopped?.timeoutMs <= 5000
        && stopped?.pane?.pid === raised?.pane?.pid && stopped?.pane?.birth === raised?.pane?.birth
        && stopped?.result?.ok === true && stopped?.result?.stopped === true && stopped?.stateBeforeTeardown === 'dead'
        && removed?.paneState === 'dead' && !record && !existsSync(sandbox), JSON.stringify({ reads, raised, stopped, removed, out }));
    }
    if (unknown) {
      const marker = sandbox && existsSync(path.join(sandbox, RUN_OWNER_FILE)) ? JSON.parse(readFileSync(path.join(sandbox, RUN_OWNER_FILE), 'utf8')) : null;
      check(`live Cursor ${boundary}: child exit preserves UNKNOWN record, same live pane, home and unresolved sandbox`,
        stopped?.result?.ok === false && stopped?.stateBeforeTeardown === 'alive'
        && !!record?.cwd && existsSync(record.cwd) && !!sandbox && existsSync(sandbox) && marker?.cleanup?.state === 'unresolved',
        JSON.stringify({ raised, stopped, marker, recordHome: record?.cwd, out }));
      const lines = sandbox ? sweepLiveRuns(path.dirname(sandbox), { prefix: path.basename(sandbox), current: null }) : [];
      check(`live Cursor ${boundary}: the next scoped sweep retains the same record, home and unresolved sandbox`,
        !!record?.cwd && existsSync(record.cwd) && !!cursorSession.readSession(raised.ref) && existsSync(sandbox)
        && lines.some(line => line.startsWith('held, cleanup unresolved:')), JSON.stringify({ lines, sandbox }));
    }
  } finally {
    writeFileSync(release, 'fixture insurance release');
    if (!exit) { child.kill('SIGKILL'); await done; }
    rmSync(armed, { force: true });
    if (raised?.ref && cursorSession.readSession(raised.ref)) {
      const insurance = await cursorDriver.stop(raised.ref, { timeoutMs: 5000 });
      writeSync(1, `  · native-fixture-insurance-after-verdict: ${JSON.stringify({ ref: raised.ref, insurance })}\n`);
    }
    if (raised?.owner && processState(raised.owner) === 'alive') {
      writeSync(1, `  · owner-fixture-insurance-after-verdict: ${JSON.stringify(raised.owner)}\n`);
      try { process.kill(raised.owner.pid, 'SIGTERM'); } catch { /* same owner already exited */ }
      await waitFor(() => processState(raised.owner) === 'dead', { timeoutMs: 10000 });
    }
    if (raised?.sandbox && (!raised.pane || processState(raised.pane) === 'dead') && processState(raised.owner) === 'dead'
      && (!raised.ref || !cursorSession.readSession(raised.ref))) rmSync(raised.sandbox, { recursive: true, force: true });
    if (!raised?.owner || processState(raised.owner) === 'dead') rmSync(privateBeforeMigration, { recursive: true, force: true });
    harness.restore();
  }
}

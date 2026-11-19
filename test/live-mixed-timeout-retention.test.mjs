// Hold an owned native cleanup past the abort wait; exit must retain UNKNOWN. Only the abort mode waits the real 30 s;
// the transfer mode proves the same retained state on a shortened copy (contributing § Live harness scenarios).
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { loadScale, makeSandbox } from './sandbox.mjs';
import { readCompleteJson, waitFor } from './harness.mjs';
import { proveStandIsolation, STUB_BIN } from '../scripts/live-entry.mjs';
import { RUN_OWNER_FILE, sweepLiveRuns } from '../scripts/canary-runs.mjs';
import * as cursorStub from './harness-cursor.mjs';
import * as codexStub from './harness-codex.mjs';
import * as cursorSession from '../lib/cursor-persist.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { processState } from '../lib/service-state.js';

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAL_ABORT_WAIT = '}, { waitMs: 30_000 });';
for (const mode of ['confirmed abort', 'abort cleanup', 'normal cleanup transfer']) {
  const waitMs = mode === 'normal cleanup transfer' ? Math.min(30_000, Math.round(5_000 * await loadScale())) : 30_000;
  const ROOT = makeSandbox('promptobus-promptobus-mixed-timeout-retention-'), bins = path.join(ROOT, 'bin');
  const cursor = await cursorStub.installHarness({ binDir: bins, bundledRuntime: true }), codex = await codexStub.installHarness({ binDir: bins });
  const mechanism = path.join(ROOT, 'mechanism');
  for (const name of ['bin', 'dist', 'lib', 'models', 'schemas', 'skills', 'scripts', 'test', 'package.json']) cpSync(path.join(PACKAGE, name), path.join(mechanism, name), { recursive: true });
  symlinkSync(path.join(PACKAGE, 'node_modules'), path.join(mechanism, 'node_modules'), 'dir');
  const entry = path.join(mechanism, 'scripts', 'live-mixed.mjs');
  const raisedFile = path.join(ROOT, 'raised.json'), scenarioRelease = path.join(ROOT, 'scenario-release');
  const stopStarted = path.join(ROOT, 'Stop-started'), stopRelease = path.join(ROOT, 'Stop-release');
  const source = readFileSync(entry, 'utf8'), anchor = "  workerRef = wp?.sessionRef ?? '';";
  if (source.split(anchor).length !== 2) throw new Error('mixed timeout fixture lost the owned worker boundary');
  if (source.split(REAL_ABORT_WAIT).length !== 2) throw new Error('mixed timeout fixture lost the 30 s abort wait');
  writeFileSync(entry, source.replace(REAL_ABORT_WAIT, `}, { waitMs: ${waitMs} });`).replace(anchor, anchor + `
    const {requireProcess: fixtureProcess}=await import('../lib/service-state.js');
    const fixtureNative=cursorPersist.readSession(workerRef),fixtureOwner=store.liveWarden(home,TASK);
    writeFileSync(${JSON.stringify(raisedFile)},JSON.stringify({ref:workerRef,pane:fixtureProcess(fixtureNative.panePid),
      owner:fixtureProcess(fixtureOwner.pid),sandbox:SB,home,task:TASK}));
    while(!existsSync(${JSON.stringify(scenarioRelease)})) await new Promise(resolve=>setTimeout(resolve,10));
    throw new Error('owned mixed held-cleanup fixture');
  `));
  appendFileSync(path.join(mechanism, 'lib', 'driver-cursor.js'), `
  import {writeFileSync as fixtureWrite,appendFileSync as fixtureAppend} from 'node:fs';
  const fixtureStop=cursorDriver.stop;
  cursorDriver.stop=async(ref,options)=>{
    fixtureWrite(${JSON.stringify(stopStarted)},JSON.stringify({ref,timeoutMs:options?.timeoutMs}));
    fixtureAppend(${JSON.stringify(stopStarted + '.calls.jsonl')},JSON.stringify({ref,timeoutMs:options?.timeoutMs})+'\\n');
    while(!existsSync(${JSON.stringify(stopRelease)})) await new Promise(resolve=>setTimeout(resolve,10));
    const result=await fixtureStop(ref,options);
    fixtureWrite(${JSON.stringify(stopStarted + '.returned')},JSON.stringify({ref,result,recordPresent:!!readSession(ref)}));
    return result;
  };
  `);
  const proved = proveStandIsolation({ binDir: bins, names: ['agent', 'cursor', 'cursor-agent', { name: 'tmux', probe: ['-V'] }, 'codex'],
    homes: { [cursorStub.CURSOR_HOME_VAR]: cursor.home, PROMPTOBUS_CURSOR_HOME: cursor.stateHome,
      PROMPTOBUS_CURSOR_USER_HOME: cursor.userHome, [codexStub.CODEX_HOME_VAR]: codex.home, PROMPTOBUS_CODEX_HOME: codex.stateHome }, env: process.env });
  if (!proved.ok) throw new Error(`owned timeout fixture isolation refused: ${proved.reason}`);
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: ROOT, [STUB_BIN]: bins } });
  let out = '', exit = null, raised, signalledAt = null;
  child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { out += bytes; });
  const done = new Promise(resolve => child.on('close', (code, signal) => {
    exit = { code, signal, elapsedMs: signalledAt === null ? null : Date.now() - signalledAt }; resolve(exit);
  }));
  try {
    raised = await waitFor(() => readCompleteJson(raisedFile) ?? (exit ? { earlyExit: exit } : null), { timeoutMs: 120000 });
    check(`mixed ${mode} timeout: actual owned native pane and service owner are alive before cancellation`,
      !!raised?.pane && !!raised?.owner && processState(raised.pane) === 'alive' && processState(raised.owner) === 'alive', JSON.stringify({ raised, out }));
    if (mode === 'normal cleanup transfer') {
      writeFileSync(scenarioRelease, 'enter normal cleanup');
      await waitFor(() => existsSync(stopStarted), { timeoutMs: 10000 });
    }
    signalledAt = Date.now();
    const foreign = { ref: 'foreign-fixture', cwd: ROOT };
    cursorSession.writeSession(foreign);
    const foreignFile = cursorSession.sessionFile(foreign.ref), before = readFileSync(foreignFile);
    child.kill('SIGTERM');
    if (mode === 'confirmed abort') {
      if (!await waitFor(() => existsSync(stopStarted), { timeoutMs: 5000 })) throw Error('native Stop not entered');
      check('mixed confirmed abort awaits the native Stop with its live record intact', !exit && !!cursorSession.readSession(raised.ref));
      writeFileSync(stopRelease, 'complete the exact owned Stop');
    }
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, waitMs + 15000).unref())]);
    const stopped = existsSync(stopStarted) ? JSON.parse(readFileSync(stopStarted, 'utf8')) : null;
    const calls = existsSync(stopStarted + '.calls.jsonl') ? readFileSync(stopStarted + '.calls.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    const record = raised?.ref ? cursorSession.readSession(raised.ref) : null, sandbox = raised?.sandbox;
    const returned = readCompleteJson(stopStarted + '.returned');
    const marker = sandbox && existsSync(path.join(sandbox, RUN_OWNER_FILE)) ? JSON.parse(readFileSync(path.join(sandbox, RUN_OWNER_FILE), 'utf8')) : null;
    writeSync(1, `  · mixed-timeout-retention-receipt: ${JSON.stringify({ runtimeDirectory: mechanism,
      mode, waitMs, raised, stopped, returned, calls, exit, marker, sandboxPresentAfterExit: sandbox ? existsSync(sandbox) : null,
      recordPresentAfterExit: !!record, homePresentAfterExit: record?.cwd ? existsSync(record.cwd) : null,
      paneStateAfterExit: raised?.pane ? processState(raised.pane) : 'unknown', ownerStateAfterExit: raised?.owner ? processState(raised.owner) : 'unknown' })}\n`);
    check(`mixed ${mode}: foreign registry bytes survived`, existsSync(foreignFile) && before.equals(readFileSync(foreignFile)));
    if (mode === 'confirmed abort') {
      check('mixed confirmed abort: exact native Stop removed the owned record and pane before exit',
        exit?.code === 143 && calls.length === 1 && stopped?.ref === raised.ref && returned?.ref === raised.ref
        && returned?.result?.stopped === true && returned.result.ok && !returned.recordPresent && !record && processState(raised.pane) === 'dead'
        && !out.includes('exiting without it') && (existsSync(sandbox) ? out.includes('cleanup unconfirmed') : out.includes('sandbox removed after confirmed cleanup')),
        JSON.stringify({ exit, stopped, returned, out }));
      continue;
    }
    check(`mixed ${mode} timeout: the abort wait runs out in full, then exits 143 while the native Stop outcome is still pending`,
      exit?.code === 143 && exit.elapsedMs >= waitMs - 100 && calls.length === 1 && stopped?.ref === raised?.ref && stopped?.timeoutMs > 0 && stopped?.timeoutMs <= 5000
      && out.includes(`cleanup after SIGTERM did not end in ${waitMs} ms`), JSON.stringify({ exit, waitMs, stopped, out }));
    check(`mixed ${mode} timeout: child exit preserves the same live pane record, home and unresolved sandbox`,
      !!record?.cwd && existsSync(record.cwd) && !!sandbox && existsSync(sandbox) && marker?.cleanup?.state === 'unresolved'
      && processState(raised.pane) === 'alive', JSON.stringify({ raised, stopped, marker, recordHome: record?.cwd, out }));
    const swept = sandbox ? sweepLiveRuns(path.dirname(sandbox), { prefix: path.basename(sandbox), current: null }) : [];
    check(`mixed ${mode} timeout: next scoped sweep preserves the pending record/home/sandbox instead of treating parent exit as Stop`,
      !!record?.cwd && existsSync(record.cwd) && !!cursorSession.readSession(raised.ref) && existsSync(sandbox)
      && swept.some(line => line.startsWith('held, cleanup unresolved:')), JSON.stringify({ sandbox, swept }));
    check(`mixed ${mode} timeout: independent owned service closure finishes without claiming the held native Stop`,
      !!raised?.owner && processState(raised.owner) === 'dead' && !out.includes('stop returned for the Cursor worker'), JSON.stringify({ raised, out }));
  } finally {
    writeFileSync(scenarioRelease, 'fixture insurance release'); writeFileSync(stopRelease, 'fixture insurance release');
    if (!exit) { child.kill('SIGKILL'); await done; }
    if (raised?.ref && cursorSession.readSession(raised.ref)) {
      const insurance = await cursorDriver.stop(raised.ref, { timeoutMs: 5000 });
      writeSync(1, `  · fixture-insurance-after-verdict: ${JSON.stringify({ ref: raised.ref, insurance })}\n`);
    }
    if (raised?.owner && processState(raised.owner) === 'alive') {
      try { process.kill(raised.owner.pid, 'SIGTERM'); } catch { /* same owner already exited */ }
      await waitFor(() => processState(raised.owner) === 'dead', { timeoutMs: 10000 });
    }
    if (raised?.sandbox && processState(raised.pane) === 'dead' && processState(raised.owner) === 'dead'
      && !cursorSession.readSession(raised.ref)) rmSync(raised.sandbox, { recursive: true, force: true });
    codex.restore(); cursor.restore();
  }
}

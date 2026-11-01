// Hold an owned native cleanup past the unchanged 30s abort wait; exit must retain UNKNOWN.
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { proveStandIsolation, STUB_BIN } from '../scripts/live-entry.mjs';
import { RUN_OWNER_FILE, sweepLiveRuns } from '../scripts/canary-runs.mjs';
import * as cursorStub from './harness-cursor.mjs';
import * as codexStub from './harness-codex.mjs';
import * as cursorSession from '../lib/cursor-persist.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { processState } from '../lib/service-state.js';

const PACKAGE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const mode of ['abort cleanup', 'normal cleanup transfer']) {
  const ROOT = makeSandbox('promptobus-promptobus-mixed-timeout-retention-'), bins = path.join(ROOT, 'bin');
  const cursor = await cursorStub.installHarness({ binDir: bins }), codex = await codexStub.installHarness({ binDir: bins });
  const mechanism = path.join(ROOT, 'mechanism');
  for (const name of ['bin', 'dist', 'lib', 'models', 'schemas', 'skills', 'scripts', 'test', 'package.json']) cpSync(path.join(PACKAGE, name), path.join(mechanism, name), { recursive: true });
  symlinkSync(path.join(PACKAGE, 'node_modules'), path.join(mechanism, 'node_modules'), 'dir');
  const entry = path.join(mechanism, 'scripts', 'live-mixed.mjs');
  const raisedFile = path.join(ROOT, 'raised.json'), scenarioRelease = path.join(ROOT, 'scenario-release');
  const stopStarted = path.join(ROOT, 'Stop-started'), stopRelease = path.join(ROOT, 'Stop-release');
  const source = readFileSync(entry, 'utf8'), anchor = "  workerRef = wp?.sessionRef ?? '';";
  if (source.split(anchor).length !== 2) throw new Error('mixed timeout fixture lost the owned worker boundary');
  writeFileSync(entry, source.replace(anchor, anchor + `
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
    return fixtureStop(ref,options);
  };
  `);
  const proved = proveStandIsolation({ binDir: bins, names: ['agent', 'cursor', 'cursor-agent', { name: 'tmux', probe: ['-V'] }, 'codex'],
    homes: { [cursorStub.CURSOR_HOME_VAR]: cursor.home, PROMPTOBUS_CURSOR_HOME: cursor.stateHome,
      PROMPTOBUS_CURSOR_USER_HOME: cursor.userHome, [codexStub.CODEX_HOME_VAR]: codex.home, PROMPTOBUS_CODEX_HOME: codex.stateHome }, env: process.env });
  if (!proved.ok) throw new Error(`owned timeout fixture isolation refused: ${proved.reason}`);
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, [STUB_BIN]: bins } });
  let out = '', exit = null, raised;
  child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { out += bytes; });
  const done = new Promise(resolve => child.on('close', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  try {
    raised = await waitFor(() => existsSync(raisedFile) ? JSON.parse(readFileSync(raisedFile, 'utf8')) : exit ? { earlyExit: exit } : null, { timeoutMs: 120000 });
    check(`mixed ${mode} timeout: actual owned native pane and service owner are alive before cancellation`,
      !!raised?.pane && !!raised?.owner && processState(raised.pane) === 'alive' && processState(raised.owner) === 'alive', JSON.stringify({ raised, out }));
    if (mode === 'normal cleanup transfer') {
      writeFileSync(scenarioRelease, 'enter normal cleanup');
      await waitFor(() => existsSync(stopStarted), { timeoutMs: 10000 });
    }
    child.kill('SIGTERM');
    await Promise.race([done, new Promise(resolve => setTimeout(resolve, 45000).unref())]);
    const stopped = existsSync(stopStarted) ? JSON.parse(readFileSync(stopStarted, 'utf8')) : null;
    const calls = existsSync(stopStarted + '.calls.jsonl') ? readFileSync(stopStarted + '.calls.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    const record = raised?.ref ? cursorSession.readSession(raised.ref) : null, sandbox = raised?.sandbox;
    const marker = sandbox && existsSync(path.join(sandbox, RUN_OWNER_FILE)) ? JSON.parse(readFileSync(path.join(sandbox, RUN_OWNER_FILE), 'utf8')) : null;
    writeSync(1, `  · mixed-timeout-retention-receipt: ${JSON.stringify({ runtimeDirectory: mechanism,
      mode, raised, stopped, calls, exit, marker, sandboxPresentAfterExit: sandbox ? existsSync(sandbox) : null,
      recordPresentAfterExit: !!record, homePresentAfterExit: record?.cwd ? existsSync(record.cwd) : null,
      paneStateAfterExit: raised?.pane ? processState(raised.pane) : 'unknown', ownerStateAfterExit: raised?.owner ? processState(raised.owner) : 'unknown' })}\n`);
    check(`mixed ${mode} timeout: unchanged abort wait exits 143 while the native Stop outcome is still pending`,
      exit?.code === 143 && calls.length === 1 && stopped?.ref === raised?.ref && stopped?.timeoutMs > 0 && stopped?.timeoutMs <= 5000
      && out.includes('cleanup after SIGTERM did not end in 30000 ms'), JSON.stringify({ exit, stopped, out }));
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

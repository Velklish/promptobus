// Force a normal failure after a real Cursor lift; inspect Stop before sandbox teardown.
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import { proveStandIsolation, STUB_BIN } from '../scripts/live-entry.mjs';
import * as cursorStub from './harness-cursor.mjs';
import * as codexStub from './harness-codex.mjs';
import * as cursorSession from '../lib/cursor-persist.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { processState } from '../lib/service-state.js';
import { waitFor } from './harness.mjs';
import { RUN_OWNER_FILE, sweepLiveRuns } from '../scripts/canary-runs.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function runCase(unread) {
  const label = unread ? 'mixed normal unknown' : 'mixed normal failure';
  const SB = makeSandbox('promptobus-promptobus-mixed-normal-cleanup-');
  const binDir = path.join(SB, 'bin');
  const cursorHarness = await cursorStub.installHarness({ binDir });
  const codexHarness = await codexStub.installHarness({ binDir });
  const mechanism = path.join(SB, 'mechanism');
  for (const name of ['bin', 'dist', 'lib', 'models', 'schemas', 'skills', 'scripts', 'test', 'package.json']) {
    cpSync(path.join(root, name), path.join(mechanism, name), { recursive: true });
  }
  symlinkSync(path.join(root, 'node_modules'), path.join(mechanism, 'node_modules'), 'dir');
  const raisedFile = path.join(SB, 'raised.json'), release = path.join(SB, 'release');
  const stoppedFile = path.join(SB, 'normal-stop.json'), arm = path.join(SB, 'stop-armed');
  const entry = path.join(mechanism, 'scripts', 'live-mixed.mjs');
  const source = readFileSync(entry, 'utf8');
  const anchor = "  workerRef = wp?.sessionRef ?? '';";
  if (source.split(anchor).length !== 2) throw new Error('normal failure fixture lost the owned worker reference boundary');
  writeFileSync(entry, source.replace(anchor, anchor + `
    const ownedWorker = cursorPersist.readSession(workerRef);
    const { requireProcess } = await import('../lib/service-state.js');
    writeFileSync(${JSON.stringify(raisedFile)}, JSON.stringify({ ref: workerRef, process: requireProcess(ownedWorker.panePid) }));
    while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
    throw new Error('fixture failure after owned Cursor lift');
  `));
  appendFileSync(path.join(mechanism, 'lib', 'driver-cursor.js'), `
  import { writeFileSync as writeStopReceipt } from 'node:fs';
  import { processIdentity as observePane, processState as paneState } from './service-state.js';
  const actualStop = cursorDriver.stop;
  cursorDriver.stop = async (ref, options) => {
    const record = readSession(ref), pane = record?.panePid ? observePane(record.panePid) : null;
    writeStopReceipt(${JSON.stringify(arm)}, 'Stop started');
    const result = await actualStop(ref, options);
    writeStopReceipt(${JSON.stringify(stoppedFile)}, JSON.stringify({ ref, timeoutMs: options?.timeoutMs,
      result, pane, stateBeforeTeardown: pane ? paneState(pane) : 'unknown', recordPresent: !!readSession(ref) }));
    return result;
  };
  `);
  if (unread) stubCommand(binDir, 'tmux', `
  import { existsSync } from 'node:fs';
  import { tmuxMain } from ${JSON.stringify(path.join(root, 'test', 'harness-cursor.mjs'))};
  if (process.argv.includes('list-sessions') && existsSync(${JSON.stringify(arm)})) {
    process.stderr.write('fixture tmux Stop observation unavailable\\n'); process.exitCode = 1;
  } else await tmuxMain(process.argv.slice(2), { ...process.env, ${cursorStub.CURSOR_HOME_VAR}: ${JSON.stringify(cursorHarness.home)} });
  `);
  const proved = proveStandIsolation({ binDir,
    names: ['agent', 'cursor', 'cursor-agent', { name: 'tmux', probe: ['-V'] }, 'codex'],
    homes: { [cursorStub.CURSOR_HOME_VAR]: cursorHarness.home, PROMPTOBUS_CURSOR_HOME: cursorHarness.stateHome,
      PROMPTOBUS_CURSOR_USER_HOME: cursorHarness.userHome, [codexStub.CODEX_HOME_VAR]: codexHarness.home,
      PROMPTOBUS_CODEX_HOME: codexHarness.stateHome }, env: process.env });
  if (!proved.ok) throw new Error(`stub isolation refused: ${proved.reason}`);
  const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, [STUB_BIN]: binDir } });
  let out = '', exit = null;
  child.stdout.on('data', data => { out += data; });
  child.stderr.on('data', data => { out += data; });
  const done = new Promise(resolve => child.on('close', (code, signal) => { exit = { code, signal }; resolve(exit); }));
  const raised = await waitFor(() => existsSync(raisedFile) ? JSON.parse(readFileSync(raisedFile, 'utf8')) : exit ? { earlyExit: exit } : null,
    { timeoutMs: 120000 });
  const aliveBeforeFailure = !!raised?.process && processState(raised.process) === 'alive';
  check(`${label}: the owned Cursor pane is physically alive before the injected exception`,
    aliveBeforeFailure, JSON.stringify({ raised, out }));
  writeFileSync(release, 'raise the fixture exception');
  await Promise.race([done, new Promise(resolve => setTimeout(resolve, 30000).unref())]);
  const stopped = existsSync(stoppedFile) ? JSON.parse(readFileSync(stoppedFile, 'utf8')) : null;
  const sandbox = /^▸ sandbox: (\S+) ·/m.exec(out)?.[1] ?? null;
  const retained = raised?.ref ? cursorSession.readSession(raised.ref) : null;
  writeSync(1, `  · normal-stop-receipt: ${JSON.stringify({ unread, raised, stopped, sandbox,
    sandboxPresentAfterExit: sandbox ? existsSync(sandbox) : null, recordPresentAfterExit: !!retained,
    participantHome: retained?.cwd ?? null, participantHomePresentAfterExit: retained?.cwd ? existsSync(retained.cwd) : null })}\n`);
  check(`${label}: the exception still fails the run after awaited cleanup`,
    exit?.code === 1 && out.includes('fixture failure after owned Cursor lift'), JSON.stringify({ exit, stopped, out }));
  if (!unread) {
    check('mixed normal failure: actual Cursor Stop removes the same owned pane and registry record before teardown',
      stopped?.ref === raised?.ref && stopped?.pane?.pid === raised?.process?.pid && stopped?.pane?.birth === raised?.process?.birth
      && stopped?.timeoutMs > 0 && stopped?.timeoutMs <= 5000
      && stopped?.result?.ok === true && stopped?.result?.stopped === true && stopped?.stateBeforeTeardown === 'dead'
      && stopped?.recordPresent === false && processState(raised.process) === 'dead', JSON.stringify({ exit, raised, stopped, out }));
  } else {
    const markerFile = sandbox ? path.join(sandbox, RUN_OWNER_FILE) : null;
    const marker = markerFile && existsSync(markerFile) ? JSON.parse(readFileSync(markerFile, 'utf8')) : null;
    check('mixed normal unknown: child exit retains the same live pane record and participant home with an unresolved owner marker',
      stopped?.result?.ok === false && stopped?.pane?.pid === raised?.process?.pid
      && stopped?.pane?.birth === raised?.process?.birth && stopped?.stateBeforeTeardown === 'alive'
      && stopped?.recordPresent === true && !!retained?.cwd && existsSync(retained.cwd)
      && !!sandbox && existsSync(sandbox) && marker?.cleanup?.state === 'unresolved',
      JSON.stringify({ raised, stopped, sandbox, retainedHome: retained?.cwd, marker, out }));
    const swept = sandbox ? sweepLiveRuns(path.dirname(sandbox), { prefix: path.basename(sandbox), current: null }) : [];
    check('mixed normal unknown: a subsequent scoped sweep keeps the retained sandbox, record and home and diagnoses unresolved cleanup',
      !!sandbox && existsSync(sandbox) && !!retained?.cwd && existsSync(retained.cwd)
      && !!cursorSession.readSession(raised.ref) && swept.some(line => line.startsWith('held, cleanup unresolved:')),
      JSON.stringify({ sandbox, swept }));
  }

  // Insurance after the verdict uses only this fixture's retained session, never a foreign pane.
  if (!exit) { child.kill('SIGKILL'); await done; }
  rmSync(arm, { force: true });
  if (raised?.ref && cursorSession.readSession(raised.ref)) {
    const insurance = await cursorDriver.stop(raised.ref, { timeoutMs: 5000 });
    writeSync(1, `  · fixture-disposal-after-verdict: ${JSON.stringify({ ref: raised.ref, insurance })}\n`);
  }
  if (sandbox && raised?.process && processState(raised.process) === 'dead' && !cursorSession.readSession(raised.ref)) {
    rmSync(sandbox, { recursive: true, force: true });
  }
  codexHarness.restore();
  cursorHarness.restore();

}
for (const unread of [false, true]) await runCase(unread);

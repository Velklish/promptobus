// A held real ps subprocess must not block the caller from releasing Stop preflight.
import { existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox, stubCommand, withStubPath } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { dropSession, readSession, sessionFile, stopSession, writeSession } from '../lib/cursor-persist.js';
import { cursorDriver } from '../lib/driver-cursor.js';

const SB = makeSandbox('promptobus-cursor-stop-preflight-');
const bin = path.join(SB, 'bin');
const started = path.join(SB, 'ps-started'), release = path.join(SB, 'ps-release');
const timedOut = path.join(SB, 'ps-timed-out'), gone = path.join(SB, 'pane-gone');
stubCommand(bin, 'tmux', `
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv.includes('kill-session')) writeFileSync(${JSON.stringify(gone)}, 'gone');
else if (process.argv.includes('list-sessions') && !existsSync(${JSON.stringify(gone)})) {
  process.stdout.write('owned|0|0|0|1|hash|chat||\\n');
}
`);
stubCommand(bin, 'ps', `
import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(started)}, 'started');
const deadline = Date.now() + 1000;
while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
if (!existsSync(${JSON.stringify(release)})) writeFileSync(${JSON.stringify(timedOut)}, 'caller blocked');
`);
const restore = withStubPath(bin);
try {
  const stopping = stopSession({ sessionName: 'owned', chatId: 'chat', workspaceHash: 'hash', cwd: SB }, { timeoutMs: 3000 });
  const waiting = await waitFor(() => existsSync(started), { timeoutMs: 5000 });
  writeFileSync(release, 'released by caller');
  const stopped = await stopping;
  check('Cursor Stop: the caller can release its actual process-tree preflight subprocess',
    waiting && !existsSync(timedOut), JSON.stringify({ waiting, callerBlocked: existsSync(timedOut), stopped }));
  check('Cursor Stop: named fallback still removes its owned pane after asynchronous preflight',
    stopped.stopped && existsSync(gone), JSON.stringify(stopped));
} finally {
  restore();
}

for (const boundary of ['chatId', 'panePid', 'hash', 'process preflight', 'registry revision', 'native refusal', 'incomplete record']) {
  const owned = makeSandbox('promptobus-cursor-stop-preflight-');
  const native = path.join(owned, 'native.json'), requested = path.join(owned, 'requested'), killed = path.join(owned, 'killed');
  const psStarted = path.join(owned, 'ps-started'), psRelease = path.join(owned, 'ps-release');
  const original = { name: 'owned', chatId: 'chat-original', panePid: 2147483646, hash: 'hash-original' };
  const foreign = { ...original, chatId: 'chat-foreign', panePid: 2147483645, hash: 'hash-foreign' };
  const initial = ['chatId', 'panePid', 'hash'].includes(boundary) ? { ...original, [boundary]: foreign[boundary] } : original;
  writeFileSync(native, JSON.stringify(initial));
  const bins = path.join(owned, 'bin');
  stubCommand(bins, 'tmux', `
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
if (process.argv.includes('kill-session')) {
  writeFileSync(${JSON.stringify(killed)}, 'kill attempted'); rmSync(${JSON.stringify(native)}, { force: true });
} else if (process.argv.includes('list-sessions') && existsSync(${JSON.stringify(native)})) {
  const session = JSON.parse(readFileSync(${JSON.stringify(native)}, 'utf8'));
  process.stdout.write([session.name, 0, 1, session.panePid, 1, session.hash, session.chatId, '', ''].join('|') + '\\n');
}
`);
  stubCommand(bins, 'ps', `
import { existsSync, writeFileSync } from 'node:fs';
if (['process preflight','registry revision'].includes(${JSON.stringify(boundary)})) {
  writeFileSync(${JSON.stringify(psStarted)}, 'started');
  const edge = Date.now() + 3000;
  while (!existsSync(${JSON.stringify(psRelease)}) && Date.now() < edge) await new Promise(resolve => setTimeout(resolve, 10));
}
`);
  stubCommand(bins, 'agent', `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(requested)}, 'native stop attempted');
if (${JSON.stringify(boundary)} === 'native refusal') writeFileSync(${JSON.stringify(native)}, ${JSON.stringify(JSON.stringify(foreign))});
process.exitCode = 1;
`);
  const beforeHome = process.env.PROMPTOBUS_CURSOR_HOME;
  process.env.PROMPTOBUS_CURSOR_HOME = path.join(owned, 'registry');
  const undo = withStubPath(bins);
  const ref = `identity-${boundary}`;
  writeSession({ ref, sessionName: original.name, chatId: boundary === 'incomplete record' ? null : original.chatId,
    panePid: original.panePid, workspaceHash: original.hash, cwd: owned, bin: path.join(bins, 'agent') });
  try {
    const stopping = cursorDriver.stop(ref, { timeoutMs: 5000 });
    let released = true;
    if (['process preflight', 'registry revision'].includes(boundary)) {
      released = !!await waitFor(() => existsSync(psStarted), { timeoutMs: 5000 });
      if (boundary === 'registry revision') {
        const file = sessionFile(ref); writeFileSync(file, readFileSync(file));
      } else writeFileSync(native, JSON.stringify(foreign));
      writeFileSync(psRelease, 'released');
    }
    const result = await stopping;
    const expected = ['process preflight', 'native refusal'].includes(boundary) ? foreign : initial;
    const receipt = { boundary, released, result, recordPresent: !!readSession(ref), requested: existsSync(requested),
      killed: existsSync(killed), native: existsSync(native) ? JSON.parse(readFileSync(native, 'utf8')) : null };
    writeSync(1, `  · identity-stop-receipt: ${JSON.stringify(receipt)}\n`);
    check(`Cursor Stop identity: ${boundary} refuses a changed or incomplete binding and retains its record`,
      released && result.ok === false && result.stopped === false && !!readSession(ref)
      && JSON.stringify(receipt.native) === JSON.stringify(expected), JSON.stringify(receipt));
    check(`Cursor Stop identity: ${boundary} never kills the replacement or sends it a native Stop`,
      !receipt.killed && receipt.requested === (boundary === 'native refusal'), JSON.stringify(receipt));
  } finally {
    dropSession(ref);
    undo();
    if (beforeHome === undefined) delete process.env.PROMPTOBUS_CURSOR_HOME;
    else process.env.PROMPTOBUS_CURSOR_HOME = beforeHome;
  }
}

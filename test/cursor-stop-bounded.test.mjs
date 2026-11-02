import { check, skip } from './check.mjs';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox, stubCommand, withStubPath } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { cursorDriver } from '../lib/driver-cursor.js';
import { dropSession, readSession, sessionFile, writeSession } from '../lib/cursor-persist.js';
import { processState, requireProcess } from '../lib/service-state.js';

if (!['darwin', 'linux'].includes(process.platform)) {
  skip('bounded Cursor native Stop commands', 'This platform has no process-birth observer');
} else {
  const root = makeSandbox('promptobus-cursor-stop-bounded-'), bins = path.join(root, 'bin');
  const ledger = path.join(root, 'native.commands.jsonl'), actors = [], identities = [], children = [];
  const previousHome = process.env.PROMPTOBUS_CURSOR_HOME;
  process.env.PROMPTOBUS_CURSOR_HOME = path.join(root, 'registry');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rows = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const note = (kind, detail) => appendFileSync(ledger, `${JSON.stringify({ kind, at: Date.now(), ...detail })}\n`);
  const actor = async (name, mode) => {
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'ignore'] });
    children.push(child);
    await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
    const identity = requireProcess(child.pid), native = path.join(root, `${name}.json`);
    identities.push(identity);
    const record = { ref: name, sessionName: name, tmuxServer: name, chatId: `chat-${name}`, panePid: child.pid,
      workspaceHash: `hash-${name}`, launchId: `launch-${name}`, cwd: root, bin: path.join(bins, 'agent') };
    writeFileSync(native, JSON.stringify({ ...record, mode })); writeSession(record);
    const current = { name, mode, child, identity, native, record, release: path.join(root, `${name}.release`) };
    actors.push(current); note('fixture/owned-pane', { name, identity, mode }); return current;
  };
  stubCommand(bins, 'ps', `
import {spawnSync} from 'node:child_process';
if(process.argv.includes('-p')) {const r=spawnSync('/bin/ps',process.argv.slice(2),{stdio:'inherit'});process.exitCode=r.status??1;}
`);
  stubCommand(bins, 'agent', `
import {appendFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
const name=process.argv.at(-1),file=${JSON.stringify(root)}+'/'+name+'.json';
const record=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
const log=kind=>appendFileSync(${JSON.stringify(ledger)},JSON.stringify({kind,name,pid:process.pid,at:Date.now()})+'\\n');
log('native/requested');
if(record?.mode==='native-positive') {process.kill(record.panePid,'SIGTERM');rmSync(file);log('native/confirmed');}
else {log('native/refused');process.exitCode=1;}
`);
  stubCommand(bins, 'tmux', `
import {appendFileSync,existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
const server=process.argv[process.argv.indexOf('-L')+1],file=${JSON.stringify(root)}+'/'+server+'.json';
const log=kind=>appendFileSync(${JSON.stringify(ledger)},JSON.stringify({kind,name:server,pid:process.pid,at:Date.now()})+'\\n');
if(process.argv.includes('kill-session')) {
  log('fallback/requested');
  const record=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
  if(record?.mode==='fallback-delayed') await new Promise(resolve=>setTimeout(resolve,3500));
  if(record) {process.kill(record.panePid,'SIGTERM');rmSync(file);log('fallback/mutated');}
} else if(process.argv.includes('list-sessions')) {
  const counter=file+'.reads',count=existsSync(counter)?Number(readFileSync(counter,'utf8'))+1:1;writeFileSync(counter,String(count));
  const record=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
  if(record?.mode.startsWith('observation-') && count===3) {
    log('observation/held');const edge=Date.now()+3500;
    while(!existsSync(${JSON.stringify(root)}+'/'+server+'.release') && Date.now()<edge) await new Promise(resolve=>setTimeout(resolve,5));
    log(existsSync(${JSON.stringify(root)}+'/'+server+'.release')?'observation/released':'observation/expired');
  }
  if(record) process.stdout.write([server,0,1,record.panePid,1,record.workspaceHash,record.chatId,'',''].join('|')+'\\n');
}
`);
  const restore = withStubPath(bins);
  try {
    for (const mode of ['fallback-delayed', 'fallback-positive']) {
      const current = await actor(mode, mode), began = Date.now(), edge = began + 1500;
      let settled = false, settledAt = null;
      const pending = cursorDriver.stop(current.name, { timeoutMs: Math.max(0, edge - Date.now()) }).then(value => { settled = true; settledAt = Date.now(); return value; });
      await waitFor(() => rows().some(row => row.name === current.name && row.kind === 'fallback/requested'), { timeoutMs: 5000 });
      const requested = rows().find(row => row.name === current.name && row.kind === 'fallback/requested');
      let fallbackIdentity = null;
      try { if (requested) fallbackIdentity = requireProcess(requested.pid); } catch {}
      if (mode === 'fallback-delayed') check('a delayed native fallback yields while its exact child is still alive', !settled
        && !!fallbackIdentity && processState(fallbackIdentity) === 'alive' && Date.now() < edge,
      JSON.stringify({ settled, settledAt, fallbackIdentity, requested, began, edge }));
      const result = await pending, returned = Date.now();
      if (mode === 'fallback-delayed' && requested) await wait(Math.max(0, requested.at + 3700 - Date.now()));
      const trace = { mode, began, edge, settledAt, returned, result, pane: current.identity, paneState: processState(current.identity),
        fallbackIdentity, fallbackState: fallbackIdentity ? processState(fallbackIdentity) : 'not observed alive',
        recordPresent: !!readSession(current.name), homePresent: existsSync(path.dirname(sessionFile(current.name))),
        nativePresent: existsSync(current.native), rows: rows().filter(row => row.name === current.name) };
      writeSync(1, `  · bounded-fallback-receipt: ${JSON.stringify(trace)}\n`);
      if (mode === 'fallback-delayed') check('expired fallback is terminated with no later native mutation and UNKNOWN retains its pane/record/home',
        result.ok === false && result.stopped === false && trace.fallbackState === 'dead' && trace.paneState === 'alive'
        && trace.recordPresent && trace.homePresent && trace.nativePresent
        && !trace.rows.some(row => row.kind === 'fallback/mutated'), JSON.stringify(trace));
      else check('ordinary positive owned fallback still confirms actual pane death and retires the exact record',
        result.ok === true && result.stopped === true && trace.paneState === 'dead' && !trace.recordPresent
        && trace.rows.some(row => row.kind === 'native/refused') && trace.rows.some(row => row.kind === 'fallback/mutated'), JSON.stringify(trace));
    }
    for (const mode of ['observation-exhausted', 'observation-replaced']) {
      const first = await actor(mode, mode), second = await actor(`${mode}-second`, 'native-positive');
      const edge = Date.now() + (mode === 'observation-exhausted' ? 1800 : 5000);
      let firstSettled = false, firstSettledAt = null;
      const pending = cursorDriver.stop(first.name, { timeoutMs: Math.max(0, edge - Date.now()) }).then(value => { firstSettled = true; firstSettledAt = Date.now(); return value; });
      await waitFor(() => rows().some(row => row.name === first.name && row.kind === 'observation/held'), { timeoutMs: 5000 });
      const held = rows().find(row => row.name === first.name && row.kind === 'observation/held');
      let observerIdentity = null;
      try { if (held) observerIdentity = requireProcess(held.pid); } catch {}
      const otherBegan = Date.now(), otherTimeoutMs = Math.max(0, edge - Date.now());
      const otherResult = await cursorDriver.stop(second.name, { timeoutMs: otherTimeoutMs });
      const otherSettledAt = Date.now();
      const otherConfirmedBeforeRelease = !existsSync(first.release) && !firstSettled && otherResult.ok === true && otherResult.stopped === true
        && processState(second.identity) === 'dead' && rows().some(row => row.name === second.name && row.kind === 'native/confirmed')
        && !rows().some(row => row.name === first.name && row.kind === 'observation/expired');
      check('another owned participant initiates and confirms native Stop while post-native observation remains held', otherConfirmedBeforeRelease,
        JSON.stringify({ mode, otherResult, firstSettled, firstSettledAt, observerIdentity, held, otherPaneState: processState(second.identity), edge, otherBegan, otherTimeoutMs, otherSettledAt }));
      if (mode === 'observation-replaced') {
        const file = sessionFile(first.name);
        if (existsSync(file)) writeFileSync(file, readFileSync(file));
        else note('fixture/registry-already-retired', { name: first.name });
        writeFileSync(first.release, 'release after actual other Stop and exact record revision change');
      }
      const result = await pending;
      if (mode === 'observation-exhausted' && held) await wait(Math.max(0, held.at + 3700 - Date.now()));
      const trace = { mode, edge, firstSettledAt, otherBegan, otherTimeoutMs, otherSettledAt, result, firstPane: first.identity, firstPaneState: processState(first.identity), observerIdentity,
        observerState: observerIdentity ? processState(observerIdentity) : 'not observed alive', otherConfirmedBeforeRelease,
        recordPresent: !!readSession(first.name), nativePresent: existsSync(first.native), rows: rows().filter(row => row.name === first.name) };
      writeSync(1, `  · bounded-observation-receipt: ${JSON.stringify(trace)}\n`);
      check('expired or replaced post-native observation grants no fallback authority and retains UNKNOWN',
        result.ok === false && result.stopped === false && trace.firstPaneState === 'alive' && trace.recordPresent && trace.nativePresent
        && trace.observerState === 'dead' && !trace.rows.some(row => row.kind === 'fallback/requested')
        && (mode !== 'observation-exhausted' || !trace.rows.some(row => row.kind === 'observation/expired')), JSON.stringify(trace));
    }
  } finally {
    note('fixture/insurance-after-verdict', { identities });
    writeSync(1, `  · bounded-stop-command-ledger: ${JSON.stringify(rows())}\n`);
    for (const current of actors) {
      const running = current.child.exitCode === null && current.child.signalCode === null;
      const done = running ? new Promise(resolve => current.child.once('close', resolve)) : Promise.resolve();
      if (processState(current.identity) === 'alive') process.kill(current.identity.pid, 'SIGKILL');
      if (running) current.child.stdin.end();
      await done; dropSession(current.name);
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); await done;
    }
    check('verified-owned fixture disposal ends every remaining pane after the Stop verdicts', identities.every(identity => processState(identity) === 'dead'));
    restore();
    if (previousHome === undefined) delete process.env.PROMPTOBUS_CURSOR_HOME;
    else process.env.PROMPTOBUS_CURSOR_HOME = previousHome;
  }
}

// Codex holder spawn failures: a missing binary must fail the record with
// ENOENT instead of an unhandled 'error' event and a ready-budget timeout.
// A child that dies under a write must not take the holder down with an
// uncaught pipe error. Run: npm test
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import {
  dropSession, holderLogFile, readSession, sessionFile, startHolder, waitReady, writeSession,
} from '../lib/codex-session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOLD_JS = path.join(here, '..', 'lib', 'codex-hold.js');
const HOME = mkdtempSync(path.join(os.tmpdir(), 'promptobus-codex-'));
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* gone */ } });
const env = {
  ...process.env,
  PROMPTOBUS_CODEX_HOME: HOME,
  PROMPTOBUS_CODEX_READY_MS: '4000',
  PROMPTOBUS_CODEX_LIMIT_MS: '50',
};

function recordOf(ref, bin) {
  return {
    ref,
    cwd: HOME,
    bin,
    role: 'worker',
    startedAt: new Date().toISOString(),
    threadId: null,
    holderPid: null,
    appPid: null,
    rpcSocket: null,
    state: 'starting',
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    model: null,
    effort: null,
    addDirs: [],
    mcpServers: {},
    prompt: 'hold',
  };
}

function runHold(file) {
  return spawn(process.execPath, [HOLD_JS, file], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

{
  const ref = 'missing-bin';
  writeSession(recordOf(ref, '/nonexistent/codex-binary'), env);
  const t0 = Date.now();
  const child = runHold(sessionFile(ref, env));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  const lifted = await waitReady(ref, env, 4_000);
  const took = Date.now() - t0;
  const rec = readSession(ref, env);
  check(': a missing app-server binary fails the record with the spawn error, not the ready timeout',
    lifted.ok === false
      && rec?.state === 'failed'
      && /did not start|ENOENT/i.test(String(lifted.error ?? rec?.error ?? ''))
      && !/did not confirm lift/i.test(String(lifted.error ?? ''))
      && took < 2_000,
    `took ${took} ms · ${JSON.stringify({ lifted, rec })}`);
  check(': the missing-binary holder does not die on an unhandled spawn error',
    !/Unhandled ['"]error['"] event/i.test(stderr),
    stderr.slice(0, 400));
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 500); });
  dropSession(ref, env);
}

{
  // Handshake-ordered EPIPE. Node will not close fd 0, so a Node stub that
  // destroy()s stdin still accepts the next write. A /bin/sh stub closes the
  // pipe with `exec 0<&-`, replies to the first client request (initialize,
  // id 1 in a fresh holder) only after that close, and stays alive. The
  // holder's next RPC write (thread/start) is then EPIPE.
  const dying = path.join(HOME, 'closed-stdio.sh');
  writeFileSync(dying, [
    '#!/bin/sh',
    'IFS= read -r line',
    'exec 0<&-',
    'printf \'{"jsonrpc":"2.0","id":1,"result":{}}\\n\'',
    'printf \'{"jsonrpc":"2.0","method":"account/rateLimits/updated","params":{"primary":{"usedPercent":0}}}\\n\'',
    'exec /bin/sleep 3600',
    '',
  ].join('\n'));
  chmodSync(dying, 0o755);
  const ref = 'dead-pipes';
  writeSession(recordOf(ref, dying), env);
  const child = runHold(sessionFile(ref, env));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  const finished = new Promise((resolve) => {
    child.once('exit', (code, sig) => resolve({ code, sig }));
  });
  const logFile = holderLogFile(ref, env);
  const initialized = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let log = '';
      try { log = readFileSync(logFile, 'utf8'); } catch { /* not yet */ }
      if (/initialize ok/.test(log) || /Unhandled ['"]error['"] event/i.test(stderr)) {
        resolve(true);
        return;
      }
      if (Date.now() - t0 > 4_000) {
        resolve(false);
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
  // initialize ok means stdin is already closed; the next write is thread/start.
  await new Promise((r) => { setTimeout(r, 250); });
  const outcome = await Promise.race([
    finished,
    new Promise((r) => { setTimeout(() => r({ code: 'running', sig: null }), 200); }),
  ]);
  let log = '';
  try { log = readFileSync(logFile, 'utf8'); } catch { /* none */ }
  check(': the stub answered initialize only after closing stdin',
    initialized && /initialize ok/.test(log),
    `log=${log.slice(0, 400)} stderr=${stderr.slice(0, 200)}`);
  check(': a write into a dead app-server stdin does not raise an unhandled pipe error',
    !/Unhandled ['"]error['"] event/i.test(stderr)
      && (outcome.code === 'running' || outcome.code === 1 || outcome.code === 0),
    `outcome=${JSON.stringify(outcome)} stderr=${stderr.slice(0, 400)} log=${log.slice(0, 300)}`);
  const rec = readSession(ref, env);
  const appPid = rec?.appPid ?? Number((log.match(/app-server pid (\d+)/) ?? [])[1]);
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  if (Number.isFinite(appPid) && appPid > 0) {
    try { process.kill(appPid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 500); });
  dropSession(ref, env);
}

{
  const ref = 'missing-via-startHolder';
  writeSession(recordOf(ref, '/nonexistent/codex-binary'), env);
  const t0 = Date.now();
  startHolder(ref, env);
  const lifted = await waitReady(ref, env, 4_000);
  const took = Date.now() - t0;
  check(': startHolder surfaces the spawn failure through waitReady instead of sitting out the budget',
    lifted.ok === false
      && /did not start|ENOENT/i.test(String(lifted.error ?? ''))
      && took < 2_000,
    `took ${took} ms · ${JSON.stringify(lifted)}`);
  dropSession(ref, env);
}

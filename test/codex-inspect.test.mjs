// Codex inspect: a nameless starting record with a dead holder is rising only
// inside the ready budget and never when the record already carries an error.
// Run: npm test
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { dropSession, readyMs, writeSession } from '../lib/codex-session.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = mkdtempSync(path.join(os.tmpdir(), 'promptobus-codex-'));
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* gone */ } });
process.env.PROMPTOBUS_CODEX_HOME = HOME;
const { codexDriver } = await import(path.join(here, '..', 'lib', 'driver-codex.js'));

const DEAD = 999_999_999;

function starting(ref, extra) {
  writeSession({
    ref,
    state: 'starting',
    threadId: null,
    holderPid: DEAD,
    appPid: null,
    startedAt: new Date().toISOString(),
    sandbox: 'read-only',
    ...extra,
  }, process.env);
}

{
  starting('rising-error', { error: 'thread is already held by process 4242' });
  const view = codexDriver.inspect('rising-error');
  check(': a starting record with an error and a dead holder is stale, not rising',
    view.state === 'stale' && view.stall?.kind === 'stale'
      && view.stall.reason === 'thread is already held by process 4242'
      && view.busy === false,
    JSON.stringify(view));
  const route = view.stall
    ? codexDriver.stallRoute({ kind: view.stall.kind, address: 'worker:x', reason: view.stall.reason }, null)
    : '';
  check(': the stale starting error still carries a relift route',
    /lift the worker again/.test(route), route || JSON.stringify(view));
  dropSession('rising-error', process.env);
}

{
  const budget = readyMs(process.env);
  starting('rising-old', { startedAt: new Date(Date.now() - budget - 5_000).toISOString() });
  const view = codexDriver.inspect('rising-old');
  check(': a nameless starting record past readyMs with a dead holder is stale',
    view.state === 'stale' && view.stall?.kind === 'stale'
      && /did not name a thread within/.test(String(view.stall.reason))
      && String(view.stall.reason).includes(String(budget)),
    JSON.stringify(view));
  dropSession('rising-old', process.env);
}

{
  starting('rising-fresh');
  const view = codexDriver.inspect('rising-fresh');
  check(': a nameless starting record inside the ready window is still rising',
    view.state === 'alive' && view.busy === true && view.stall === null
      && /rising/.test(String(view.note)),
    JSON.stringify(view));
  dropSession('rising-fresh', process.env);
}

{
  starting('rising-null-holder', { holderPid: null });
  const view = codexDriver.inspect('rising-null-holder');
  check(': a starting record with holderPid null inside the window is still rising',
    view.state === 'alive' && /rising/.test(String(view.note)) && view.stall === null,
    JSON.stringify(view));
  dropSession('rising-null-holder', process.env);
}

// Codex inspect: a nameless starting record with a dead holder is rising only
// inside the ready budget and never when the record already carries an error.
// Run: npm test
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { dropSession, oldestPending, outstandingAfterResolved, readyMs, writeSession } from '../lib/codex-session.js';

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

function live(ref, extra) {
  writeSession({
    ref,
    state: 'alive',
    threadId: 't-live',
    holderPid: process.pid,
    busy: true,
    lastEvent: 'turn/started',
    lastEventAt: new Date().toISOString(),
    ...extra,
  }, process.env);
}

{
  live('watch-fresh');
  const view = codexDriver.inspect('watch-fresh');
  check(': a running turn with a recent lastEvent is not a stall',
    view.state === 'alive' && view.busy === true && view.stall === null
      && /the turn is running/.test(String(view.note))
      && /last event turn\/started/.test(String(view.note)),
    JSON.stringify(view));
  dropSession('watch-fresh', process.env);
}

{
  const was = process.env.PROMPTOBUS_CODEX_IDLE_MS;
  process.env.PROMPTOBUS_CODEX_IDLE_MS = '80';
  live('watch-silent', { lastEventAt: new Date(Date.now() - 5_000).toISOString() });
  const view = codexDriver.inspect('watch-silent');
  check(': a running turn silent past PROMPTOBUS_CODEX_IDLE_MS is a watchdog stall',
    view.stall?.kind === 'watchdog'
      && /silent/.test(String(view.stall.reason))
      && /last event turn\/started/.test(String(view.stall.reason))
      && !/the turn is running/.test(String(view.note)),
    JSON.stringify(view));
  const route = codexDriver.stallRoute({ kind: 'watchdog', address: 'worker:x' }, 't-live');
  check(': the watchdog stall carries a look-in route',
    /activity budget/.test(route) && /queues/.test(route), route);
  if (was === undefined) delete process.env.PROMPTOBUS_CODEX_IDLE_MS;
  else process.env.PROMPTOBUS_CODEX_IDLE_MS = was;
  dropSession('watch-silent', process.env);
}

{
  const was = process.env.PROMPTOBUS_CODEX_IDLE_MS;
  process.env.PROMPTOBUS_CODEX_IDLE_MS = '80';
  live('watch-pending', {
    lastEvent: 'holder-reply:mcpServer/elicitation/request',
    lastEventAt: new Date(Date.now() - 5_000).toISOString(),
    pendingRequest: {
      method: 'mcpServer/elicitation/request',
      server: 'probe-mcp',
      mode: 'form',
      id: 'srv-1',
      at: '2026-09-08T12:00:00.000Z',
    },
  });
  const view = codexDriver.inspect('watch-pending');
  check(': a pending server request is not painted as the turn is running, even past the idle budget',
    view.stall?.kind === 'pending-request'
      && /waiting on mcpServer\/elicitation\/request/.test(String(view.stall.reason))
      && /from probe-mcp/.test(String(view.stall.reason))
      && /2026-09-08T12:00:00/.test(String(view.stall.reason))
      && view.stall.kind !== 'watchdog'
      && !/the turn is running/.test(String(view.note)),
    JSON.stringify(view));
  const route = codexDriver.stallRoute({
    kind: 'pending-request',
    address: 'worker:x',
    statusCommand: 'promptobus status',
  }, 't-live');
  check(': the pending-request route distinguishes the holder reply from serverRequest/resolved',
    /JSON-RPC reply is not serverRequest\/resolved/.test(route), route);
  if (was === undefined) delete process.env.PROMPTOBUS_CODEX_IDLE_MS;
  else process.env.PROMPTOBUS_CODEX_IDLE_MS = was;
  dropSession('watch-pending', process.env);
}

{
  live('watch-pending-fresh', {
    lastEvent: 'holder-reply:mcpServer/elicitation/request',
    lastEventAt: new Date().toISOString(),
    pendingRequest: {
      method: 'mcpServer/elicitation/request',
      server: 'probe-mcp',
      mode: 'form',
      id: 'srv-1',
      at: new Date().toISOString(),
    },
  });
  const view = codexDriver.inspect('watch-pending-fresh');
  check(': a fresh pending server request is a waiting note, not a stall',
    view.stall === null && /waiting on mcpServer\/elicitation\/request/.test(String(view.note))
      && /from probe-mcp/.test(String(view.note))
      && !/the turn is running/.test(String(view.note)),
    JSON.stringify(view));
  dropSession('watch-pending-fresh', process.env);
}

{
  live('watch-resolved', {
    lastEvent: 'serverRequest/resolved',
    lastEventAt: new Date().toISOString(),
    pendingRequest: null,
  });
  const view = codexDriver.inspect('watch-resolved');
  check(': after serverRequest/resolved the turn is running again',
    view.stall === null && /the turn is running/.test(String(view.note))
      && /last event serverRequest\/resolved/.test(String(view.note)),
    JSON.stringify(view));
  dropSession('watch-resolved', process.env);
}

{
  const a = {
    id: 1,
    method: 'mcpServer/elicitation/request',
    server: 'probe-a',
    at: '2026-09-08T12:00:00.000Z',
  };
  const b = {
    id: '1',
    method: 'execCommandApproval',
    server: 'probe-b',
    at: '2026-09-08T12:00:01.000Z',
  };
  const afterA = outstandingAfterResolved([a, b], 1);
  check(': resolving one request id leaves a distinct overlapping id outstanding',
    afterA.length === 1 && afterA[0].id === '1' && oldestPending(afterA).server === 'probe-b',
    JSON.stringify(afterA));
  const afterOther = outstandingAfterResolved([a, b], 'other');
  check(': a nonmatching serverRequest/resolved id does not clear outstanding requests',
    afterOther.length === 2 && oldestPending([a, b]).id === 1,
    JSON.stringify(afterOther));
}

{
  live('watch-failed', {
    busy: false,
    lastTurn: { id: 'turn-1', status: 'failed', at: new Date().toISOString(), error: 'invalid_request_error: probe' },
  });
  const view = codexDriver.inspect('watch-failed');
  check(': a failed lastTurn is a named stall, not the turn ended',
    view.busy === false && view.stall?.kind === 'failed'
      && /invalid_request_error: probe/.test(String(view.stall.reason))
      && view.stall.kind !== 'unknown',
    JSON.stringify(view));
  const route = codexDriver.stallRoute({ kind: 'failed', address: 'worker:x' }, 't-live');
  check(': the failed-turn route says the thread is still up',
    /later turn may succeed/.test(route), route);
  dropSession('watch-failed', process.env);
}

{
  live('watch-recovered', {
    busy: false,
    lastTurn: { id: 'turn-2', status: 'completed', at: new Date().toISOString() },
  });
  const view = codexDriver.inspect('watch-recovered');
  check(': a later successful turn does not keep the failed stall',
    view.stall?.kind === 'unknown' && /the turn ended/.test(String(view.stall.reason)),
    JSON.stringify(view));
  dropSession('watch-recovered', process.env);
}

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

// A quota refusal naming a reset is a state: the view says unreachable until that time, even while
// a turn a knock just started is running. The text is the one measured on 2026-09-17, time moved ahead.
{
  const { namedReset } = await import(path.join(here, '..', 'dist', 'index.js'));
  const year = new Date().getFullYear() + 1;
  const QUOTA = `You've hit your usage limit. Upgrade to Pro or try again at Sep 19th, ${year} 12:15 PM.`;
  const failed = (error) => ({ id: 'turn-q', status: 'failed', at: new Date().toISOString(), error });
  const at = new Date(`Sep 19, ${year} 12:15 PM`).toISOString();

  check('namedReset: the Codex refusal names its time, and the ordinal date parses in local time',
    JSON.stringify(namedReset(QUOTA)) === JSON.stringify({ said: `Sep 19th, ${year} 12:15 PM`, at }),
    JSON.stringify(namedReset(QUOTA)));
  check('namedReset: a time with no year is still a named reset, with no instant invented',
    JSON.stringify(namedReset("You've hit your session limit · resets 6:20am (Europe/Moscow)"))
    === JSON.stringify({ said: '6:20am (Europe/Moscow)', at: null }));
  check('namedReset: a refusal naming no time, or no limit, is not a named reset',
    namedReset("You've hit your usage limit. Try again later.") === null
      && namedReset('stream disconnected; try again at the next turn') === null
      && namedReset(null) === null);

  live('quota-idle', { busy: false, lastTurn: failed(QUOTA) });
  const idle = codexDriver.inspect('quota-idle');
  check(': a failed turn that named a reset is a limit stall carrying that reset',
    idle.stall?.kind === 'limit' && idle.stall.reset?.at === at && idle.busy === false
      && idle.stall.reason.includes(QUOTA),
    JSON.stringify(idle));
  const route = codexDriver.stallRoute({ ...idle.stall, address: 'reviewer:x', reviewCommand: 'promptobus review "/r"' }, 't-live');
  check(': its route names the hold and a relift, not "a later turn may succeed"',
    /holds its knocks until the time named here/.test(route) && /lift the reviewer again/.test(route)
      && !/a later turn may succeed/.test(route), route);

  live('quota-busy', { lastTurn: failed(QUOTA) });
  const busy = codexDriver.inspect('quota-busy');
  check(': the reset outranks a running turn — no "the turn is running"',
    busy.busy === true && busy.stall?.kind === 'limit' && busy.stall.reset?.at === at
      && !/the turn is running/.test(String(busy.note)),
    JSON.stringify(busy));

  live('quota-past', { busy: false, lastTurn: failed(QUOTA.replace(String(year), '2020')) });
  const past = codexDriver.inspect('quota-past');
  check(': once the named time has passed it is an ordinary failed turn again',
    past.stall?.kind === 'failed' && past.stall.reset === undefined, JSON.stringify(past));

  live('plain-fail', { busy: false, lastTurn: failed('invalid_request_error: probe') });
  const plain = codexDriver.inspect('plain-fail');
  check(': a failure with no named reset keeps its failed stall and its retry hint',
    plain.stall?.kind === 'failed' && plain.stall.reset === undefined
      && /a later turn may succeed/.test(codexDriver.stallRoute({ ...plain.stall, address: 'worker:x' }, 't-live')),
    JSON.stringify(plain));
  for (const ref of ['quota-idle', 'quota-busy', 'quota-past', 'plain-fail']) dropSession(ref, process.env);
}

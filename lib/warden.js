import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, watch } from 'node:fs';
import { ok, info, warn } from './util.js';
import {
  addressOf, bus, claimWarden, clearWarden, inboxDir, liveWarden, logWarden, readTask, resolveIdentity,
  sessionIdentity,
  resolveTaskId, WARDEN_BEAT_SEC,
} from './store.js';
import {
  beatRound, ROUND_FAIL_LIMIT, stallRound, supervisorRound, TICK_MS,
} from '../dist/index.js';
import { forgetSessions, knockRegistry, REGISTRY, snapshotOf } from './drivers.js';
import { stallLine } from './status.js';

// The task warden is a PROCESS, not a state machine.
//
// Listening on the bus is held by a process, not by model discipline: the warden is
// the only listener of every task mailbox and its only activator. On unread mail it
// wakes the addressee and thereby starts their turn. The process has no state of its
// own — everything lives in the task store, so its death loses nothing, and any CLI
// command may start it again (`ensureWarden`).
//
// **This file does not make the decisions.** Rounds, knock-retry thresholds, unread
// health, silence escalation, stall resolution, and the "whom to activate" decision
// live in the package ([supervisor.ts](../src/supervisor.ts)) and know nothing about
// the harness. What remains here is exactly what belongs to the harness and the
// workspace: a detached process, `fs.watch` watchers, a session snapshot through the
// driver registry, human diagnostics, and the loop. The delivery channel is the
// driver, and it is taken from the registry
// ([drivers.js](drivers.js)).
//
// Delivery is best-effort: the "delivered" mark is one, the mailbox is claimed. An
// activation refusal does not kill the process: the participant is marked with the
// `self-wake` channel, and delivery to the rest continues.

// Thresholds and intervals live with the state machine. Re-export: commands and the
// suite read them, and a second home for a number would mean two different values of
// one threshold.
export {
  KNOCK_RETRY_SEC, ROUND_FAIL_LIMIT, SILENCE_SEC, TICK_MS, WARDEN_TOTAL_SEC,
} from '../dist/index.js';

// Predicates and the heartbeat live there too, by re-export: the suite and bus
// commands call them.
export { beatRound, liveWatched } from '../dist/index.js';

/**
 * One watch round. A wrapper over the state machine: a session snapshot arrives here,
 * the registry leaves from here. `knock` is a suite seam: a stand-in driver for one
 * round.
 *
 * **The round does not request a snapshot and has no right to.** It arrives as an
 * argument and is held in a loop variable until the heartbeat; the round runs once a
 * second, and a snapshot stands on a harness-query process launch. Measurement 2026-09-02
 * (count by argv of a stand-in binary, three participants with sessions): the round —
 * 0 launches of `claude agents --json` both with a snapshot and without; the
 * heartbeat — 1, both on a parsed reply and on an unparsed one.
 *
 * The cost of an "improvement" is there too, but it is counterfactual: if the round
 * took state itself and WITHOUT a cache reset, sixty snapshots (a minute) would cost
 * 1 launch on a parsed reply and 60 on an unparsed one — a parse refusal is not
 * cached on purpose ([liftoff.js](liftoff.js)).
 * Nobody pays that cost today: the snapshot dies on the FIRST `null`, and the loop
 * resets the cache itself before the heartbeat snapshot.
 */
export function wardenRound(home, task, { now = Date.now(), knock = null, sessions = null } = {}) {
  return supervisorRound(home, task, { now, sessions, registry: knockRegistry(knock) });
}

/**
 * Participant stalls: fresh ones are written to the journal, a postcard is not sent.
 * The visibility addressee is the task owner: there is nobody to report to the
 * participant about.
 */
export async function reportStalls(home, task, { sessions = undefined, now = Date.now() } = {}) {
  const fresh = await stallRound(home, task, {
    now,
    sessions: sessions === undefined ? snapshotOf(readTask(home, task).participants) : sessions,
  });
  return fresh.map((s) => stallLine(s, task));
}

// Wake on `fs.watch` on top of polling: the event arrives in milliseconds, and polling
// backs it up — on network and virtual filesystems `fs.watch` silently drops events.
function watchInboxes(home, task, addrs) {
  const watchers = [];
  let wake = null;
  for (const addr of addrs) {
    try {
      const dir = inboxDir(home, task, addr);
      mkdirSync(dir, { recursive: true });
      const w = watch(dir, () => {
        const f = wake;
        wake = null;
        if (f) f();
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // polling remains
    }
  }
  return {
    addrs: [...addrs].sort().join(','),
    next(ms) {
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    },
    close() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // nothing to close
        }
      }
    },
  };
}

// Start the warden as a separate process — detached (`detached` + `unref`) and without
// streams: it must outlive the command that started it, up to the Stop hook, which
// lives a fraction of a second. The environment is cleaned of the parent's bus
// identity and contact point.
function wardenArgv(host, task) {
  return { node: host.nodePath(), argv: host.busArgv(['warden', '--task', task]) };
}

function launchWarden(home, task, env, host) {
  const clean = { ...env, PROMPTOBUS_HOME: home };
  delete clean.PROMPTOBUS_ROLE;
  delete clean.PROMPTOBUS_TASK;
  delete clean.CLAUDE_CODE_MESSAGING_SOCKET;
  delete clean.CLAUDE_CODE_MESSAGING_TOKEN;
  const { node, argv } = wardenArgv(host, task);
  const child = spawn(node, argv, {
    detached: true,
    stdio: 'ignore',
    env: clean,
  });
  child.unref();
  return child.pid ?? null;
}

// Auto-start trace for the test suite. The warden journal will not do: it sits inside
// the sandbox the test tears down. The path is the `PROMPTOBUS_WARDEN_TRACE` variable
// (the runner sets it). We write at the "we are starting" decision, not inside the
// detached process: the write is synchronous with the forbidden action, and the runner
// gate reads a ready file.
function traceLaunch(env, line) {
  const file = env?.PROMPTOBUS_WARDEN_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // The trace is suite diagnostics, and a write refusal is no reason to fail a warden start
  }
}

// Auto-start switch: `PROMPTOBUS_WARDEN=off`. Needed by the test suite — without it bus
// commands in the sandbox started detached processes that knocked on the developer's
// session at fixture addresses. Only AUTO-start is turned off: messages then sit in
// mailboxes until the participant calls `mailbox` themselves.
export function wardenOff(env = process.env) {
  return String(env.PROMPTOBUS_WARDEN ?? '').trim().toLowerCase() === 'off';
}

// "Is the warden alive? No — start it." Called by commands that already walk the bus:
// guard (on every turn end — the main restarter), spawn, review, and the MCP server.
// `promptobus status` does not call it: the command only reads. Silent on any surprise:
// a safety net has no right to drop a spawn or a session turn.
export function ensureWarden(home, task, { env = process.env, launch = launchWarden, host } = {}) {
  if (host == null) throw new Error('ensureWarden: host is required');
  try {
    if (wardenOff(env)) return null;
    if (liveWarden(home, task)) return null;
    if (readTask(home, task).status !== 'active') return null;
    const pid = launch(home, task, env, host);
    traceLaunch(env, `${new Date().toISOString()} warden auto-start · task ${task} · pid ${pid ?? '?'}`);
    return pid;
  } catch {
    return null;
  }
}

// The process itself. Started as `<commandName> warden --task <id>`; it does not need a
// workspace root — home and task arrive through the environment and a flag.
export async function warden(opts = {}, env = process.env, cwd = process.cwd()) {
  const host = opts.host;
  if (host == null) throw new Error('warden: host is required');
  const identity = resolveIdentity(env, cwd, { host });
  const home = identity.home;
  const task = resolveTaskId(home, opts.task?.trim() || identity.declaredTask, identity.session);
  const cli = host.version;
  bus(home, { cli });

  // The seat is taken first-wins under the task lock: otherwise two knocks on one message.
  const claimed = claimWarden(home, task, { cli, session: sessionIdentity() });
  if (claimed.busy) {
    warn(`warden of task ${task} is already running: pid ${claimed.busy.pid}, heartbeat ${claimed.busy.beat}`);
    return;
  }
  ok(`warden of task ${task}: pid ${process.pid} · CLI ${cli}`);
  logWarden(home, task, `warden started · pid ${process.pid} · CLI ${cli}`);

  const startedMs = Date.now();
  const addrsOf = () => (readTask(home, task).participants ?? []).map((p) => addressOf(p)).filter(Boolean);
  let watcher = watchInboxes(home, task, addrsOf());
  let lastBeat = Date.now();
  // The session snapshot is taken once per heartbeat and held between rounds ON PURPOSE:
  // the round runs once a second, and each snapshot is a harness-query process launch.
  // Freshness up to WARDEN_BEAT_SEC is enough for both readers — the stalled report and
  // the knock-retry threshold in KNOCK_RETRY_SEC; "improving" this with a query on every
  // round is not needed.
  //
  // `undefined` means "not taken yet": the first snapshot is taken by the very first
  // round, INSIDE the guard (review note). A refusal here before it would take the
  // process past `finally` — that is, without clearing the mark and without a journal
  // line — and the next bus command would start a warden into the same death. `null`
  // from a snapshot is a legal state, it is not re-taken.
  let sessions;
  let why = null;
  // The warden has no right to die by exception: its `stdio` is `ignore`, the stack
  // would go nowhere, and the run would simply stop delivering — quietly.
  let failures = 0;
  try {
    for (;;) {
      try {
        if (sessions === undefined) sessions = snapshotOf(readTask(home, task).participants);
        const tick = await supervisorRound(home, task, { sessions, registry: REGISTRY });
        if (tick.stop) {
          why = tick.stop;
          break;
        }
        if (Date.now() - lastBeat >= WARDEN_BEAT_SEC * 1000) {
          lastBeat = Date.now();
          forgetSessions();
          sessions = snapshotOf(readTask(home, task).participants);
          // Stalls into the journal — BEFORE the verdict: the task's last stall is
          // visible on exactly the round where `beatRound` decides to exit, and after
          // the verdict it would not make the journal.
          for (const line of await reportStalls(home, task, { sessions })) {
            logWarden(home, task, line);
          }
          why = beatRound(home, task, startedMs, { sessions, session: sessionIdentity() });
          if (why) break;
          // The participant set changes during the run — watchers are rebuilt on the beat.
          const addrs = addrsOf();
          if ([...addrs].sort().join(',') !== watcher.addrs) {
            watcher.close();
            watcher = watchInboxes(home, task, addrs);
          }
        }
        failures = 0;
      } catch (e) {
        failures += 1;
        logWarden(home, task, `watch round failed (${failures}/${ROUND_FAIL_LIMIT}): ${e.message}`);
        if (failures >= ROUND_FAIL_LIMIT) {
          why = `watch round failed ${failures} times in a row: ${e.message}`;
          break;
        }
      }
      await watcher.next(TICK_MS);
    }
  } finally {
    watcher.close();
    try {
      clearWarden(home, task, process.pid, { session: sessionIdentity() });
    } catch {
      // The mark will outlive the process, but nobody alive will count it: liveness is read by pid.
    }
  }
  logWarden(home, task, `warden exited · ${why}`);
  info(`warden of task ${task} exited: ${why}`);
}

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, watch } from 'node:fs';
import { ok, info, warn } from './util.js';
import {
  addressOf, bus, claimWarden, clearWarden, inboxDir, liveWarden, logWarden, orchestratedTasks,
  ORCHESTRATOR, participantOf, readTask, resolveIdentity,
  sessionIdentity, writeWardenExit,
  resolveTaskId, WARDEN_BEAT_SEC,
} from './store.js';
import {
  beatRound, reportResets, ROUND_FAIL_LIMIT, stallRound, supervisorRound, TICK_MS,
} from '../dist/index.js';
import { driverOrLift, forgetSessions, knockRegistry, REGISTRY, snapshotOf } from './drivers.js';
import { stallLine } from './status.js';

// The warden is a process, not a state machine.
// [guides/hooks-and-trust.md#the-warden-is-a-process-not-a-state-machine](../docs/guides/hooks-and-trust.md#the-warden-is-a-process-not-a-state-machine)

// Thresholds and intervals live with the state machine; re-exported because a second home
// for a number would mean two different values of one threshold.
export {
  KNOCK_COALESCE_SEC, KNOCK_RETRY_SEC, ROUND_FAIL_LIMIT, SILENCE_SEC, TICK_MS, WARDEN_ABSOLUTE_SEC, WARDEN_TOTAL_SEC,
} from '../dist/index.js';

// Predicates and the heartbeat live there too, by re-export: the suite and bus
// commands call them.
export { beatRound, liveWatched } from '../dist/index.js';

// One watch round.
// [guides/hooks-and-trust.md#wardenround--one-watch-round](../docs/guides/hooks-and-trust.md#wardenround--one-watch-round)
export function wardenRound(home, task, { now = Date.now(), knock = null, sessions = null } = {}) {
  return supervisorRound(home, task, { now, sessions, registry: knockRegistry(knock) });
}

/** A knocked session is looked at again at once, past the heartbeat's session-list cache, so a refusal
 * naming a reset holds the next knock — 03-cli § Guard and warden. `snapshot` is the suite's seam. */
export function reinspectKnocked(home, task, sessions, knocked, snapshot = snapshotOf) {
  if (!knocked.length || !sessions) return sessions;
  forgetSessions();
  const again = snapshot(readTask(home, task).participants.filter((p) => knocked.includes(addressOf(p))));
  return again ? { ...sessions, ...again } : sessions;
}

/** Participant stalls: fresh ones go to the journal. The one postcard is a named reset's, sent to
 * the orchestrator once per sighting — 03-cli § Guard and warden. */
export async function reportStalls(home, task, {
  sessions = undefined, now = Date.now(), host = null, knock = null,
} = {}) {
  const fresh = await stallRound(home, task, {
    now,
    sessions: sessions === undefined ? snapshotOf(readTask(home, task).participants) : sessions,
  });
  const reported = await reportResets(home, task, fresh, { registry: knockRegistry(knock), now });
  return [...fresh.map((s) => stallLine(s, task, host)), ...reported];
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

// Started as a separate detached process without streams: it must outlive the command that
// started it, up to a Stop hook that lives a fraction of a second.
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

// Auto-start trace for the suite; the warden journal will not do — it sits in the sandbox
// the test tears down. Written at the decision, not inside the detached process.
function traceLaunch(env, line) {
  const file = env?.PROMPTOBUS_WARDEN_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, `${line}\n`);
  } catch {
    // The trace is suite diagnostics, and a write refusal is no reason to fail a warden start
  }
}

// Auto-start switch. Only AUTO-start is turned off: messages then sit in mailboxes until
// the participant calls `mailbox` themselves.
export function wardenOff(env = process.env) {
  return String(env.PROMPTOBUS_WARDEN ?? '').trim().toLowerCase() === 'off';
}

// "Is the warden alive? No — start it." Called by commands that already walk the bus;
// `status` only reads. Silent on any surprise: a safety net may not drop a spawn or a turn.
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

// This session's contact point to EVERY active task it owns as `orchestrator`: the socket follows
// the session, not the binding — 03-cli § Guard and warden.
export function handOverContactPoints(home, { env = process.env, session = sessionIdentity() } = {}) {
  const taken = [];
  try {
    for (const meta of orchestratedTasks(home, session)) {
      const driver = driverOrLift(participantOf(readTask(home, meta.id), ORCHESTRATOR));
      if (driver.registerWake(home, meta.id, ORCHESTRATOR, env, session)) taken.push(meta.id);
    }
  } catch {
    // A safety net may not drop a command or a turn.
  }
  return taken;
}

// The process itself. Started as `<commandName> warden --task <id>`; it does not need a
// workspace root — home and task arrive through the environment and a flag.
export async function warden(opts = {}, env = process.env, cwd = process.cwd()) {
  const host = opts.host;
  if (host == null) throw new Error('warden: host is required');
  const identity = resolveIdentity(env, cwd, { host });
  const home = identity.home;
  const cli = host.version;
  bus(home, { cli });
  const task = resolveTaskId(home, opts.task?.trim() || identity.declaredTask, identity.session, {
    spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
    spawnNewTask: host.busCommand(['spawn', '--new-task']),
  });

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
  // The snapshot is held between rounds on purpose, and `undefined` means "not taken yet":
  // [hooks-and-trust.md § wardenRound](../docs/guides/hooks-and-trust.md#wardenround--one-watch-round).
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
        sessions = reinspectKnocked(home, task, sessions, tick.knocked);
        if (Date.now() - lastBeat >= WARDEN_BEAT_SEC * 1000) {
          lastBeat = Date.now();
          forgetSessions();
          sessions = snapshotOf(readTask(home, task).participants);
          // Stalls into the journal BEFORE the verdict: after it, the task's last stall
          // would not make the round on which `beatRound` decides to exit.
          for (const line of await reportStalls(home, task, { sessions, host })) {
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
      if (why) writeWardenExit(home, task, { reason: why, at: new Date().toISOString() });
      clearWarden(home, task, process.pid, { session: sessionIdentity() });
    } catch {
      // The mark will outlive the process, but nobody alive will count it: liveness is read by pid.
    }
  }
  logWarden(home, task, `warden exited · ${why}`);
  info(`warden of task ${task} exited: ${why}`);
}

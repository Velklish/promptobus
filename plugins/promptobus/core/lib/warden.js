import { appendFileSync, mkdirSync, watch } from 'node:fs';
import { ok, info, warn } from './util.js';
import { addressOf, bus, claimWarden, clearWarden, inboxDir, logWarden, mailboxOf, orchestratedTasks, ORCHESTRATOR, participantOf, participantSlots, readTask, resolveIdentity, sessionIdentity, writeWardenExit, resolveTaskId, WARDEN_BEAT_SEC, withTaskLock, pidAlive, } from './store.js';
import { beatRound, reportResets, ROUND_FAIL_LIMIT, snapshotSessions, stallRound, supervisorRound, TICK_MS, } from '../dist/index.js';
import { readWardenMark } from '../dist/sidecar.js';
import { driverOrLift, forgetSessions, knockRegistry, REGISTRY, snapshotOf } from './drivers.js';
import { stallLine } from './status.js';
import { coreRegistry } from './driver-runtime.js';
let sharedEnsure = null;
export function bindSharedWarden(ensure) {
    if (sharedEnsure)
        throw new Error('A shared task warden is already bound in this process');
    sharedEnsure = ensure;
    return () => { if (sharedEnsure === ensure)
        sharedEnsure = null; };
}
export function taskWardenHost(host) {
    return { version: host.version, formatStalls: (task, fresh) => fresh.map(stall => stallLine(stall, task, host)) };
}
// The warden is a process, not a state machine.
// [guides/hooks-and-trust.md#the-warden-is-a-process-not-a-state-machine](../docs/guides/hooks-and-trust.md#the-warden-is-a-process-not-a-state-machine)
// Thresholds and intervals live with the state machine; re-exported because a second home
// for a number would mean two different values of one threshold.
export { KNOCK_COALESCE_SEC, KNOCK_RETRY_SEC, ROUND_FAIL_LIMIT, SILENCE_SEC, TICK_MS, WARDEN_ABSOLUTE_SEC, WARDEN_TOTAL_SEC, } from '../dist/index.js';
// Predicates and the heartbeat live there too, by re-export: the suite and bus
// commands call them.
export { beatRound, liveWatched } from '../dist/index.js';
// One watch round.
// [guides/hooks-and-trust.md#wardenround--one-watch-round](../docs/guides/hooks-and-trust.md#wardenround--one-watch-round)
export function wardenRound(home, task, { now = Date.now(), knock = null, sessions = null } = {}) {
    return supervisorRound(home, task, { now, sessions, registry: coreRegistry(knockRegistry(knock)), mailboxes: participantSlots(home, task) });
}
/** A knocked session is looked at again at once, past the heartbeat's session-list cache, so a refusal
 * naming a reset holds the next knock — 03-cli § Guard and warden. `snapshot` is the suite's seam. */
export function reinspectKnocked(home, task, sessions, knocked, snapshot = snapshotOf) {
    if (!knocked.length || !sessions)
        return sessions;
    forgetSessions();
    const again = snapshot(readTask(home, task).participants.filter((p) => knocked.includes(addressOf(p))));
    return again ? { ...sessions, ...again } : sessions;
}
/** Participant stalls: fresh ones go to the journal. The one postcard is a named reset's, sent to
 * the orchestrator once per sighting — 03-cli § Guard and warden. */
export async function reportStalls(home, task, { sessions = undefined, now = Date.now(), host = null, knock = null, } = {}) {
    const mailboxes = participantSlots(home, task);
    const fresh = await stallRound(home, task, {
        now,
        sessions: sessions === undefined ? snapshotOf(readTask(home, task).participants) : sessions,
        mailboxes,
    });
    const reported = await reportResets(home, task, fresh, { registry: coreRegistry(knockRegistry(knock)), now, mailboxes });
    return [...fresh.map((s) => stallLine(s, task, host)), ...reported];
}
// Wake on `fs.watch` on top of polling: the event arrives in milliseconds, and polling
// backs it up — on network and virtual filesystems `fs.watch` silently drops events.
function watchInboxes(home, task, addrs, signal) {
    const watchers = [];
    const drained = [];
    let wake = null;
    let closed = null;
    const abort = () => wake?.();
    signal?.addEventListener('abort', abort);
    for (const dir of watchedDirs(home, task, addrs)) {
        try {
            mkdirSync(dir, { recursive: true });
            const w = watch(dir, () => {
                const f = wake;
                wake = null;
                if (f)
                    f();
            });
            w.on('error', () => { });
            watchers.push(w);
            drained.push(new Promise(resolve => w.once('close', resolve)));
        }
        catch {
            // polling remains
        }
    }
    return {
        addrs: watchKey(home, task, addrs),
        next(ms) {
            if (signal?.aborted || closed)
                return Promise.resolve();
            return new Promise((resolve) => {
                const t = setTimeout(() => {
                    wake = null;
                    resolve();
                }, ms);
                wake = () => {
                    wake = null;
                    clearTimeout(t);
                    resolve();
                };
            });
        },
        close() {
            if (closed)
                return closed;
            signal?.removeEventListener('abort', abort);
            wake?.();
            for (const w of watchers) {
                try {
                    w.close();
                }
                catch {
                    // nothing to close
                }
            }
            closed = Promise.all(drained).then(() => { });
            return closed;
        },
    };
}
// The inbox directories this warden counts: every slot of each primary address, none of an alias.
function watchedDirs(home, task, addrs) {
    return [...new Set(addrs.flatMap((addr) => {
            const box = mailboxOf(home, task, addr);
            return box.alias ? [] : box.slots.map((slot) => inboxDir(home, slot.task, slot.address));
        }))];
}
function watchKey(home, task, addrs) {
    return watchedDirs(home, task, addrs).sort().join(',');
}
// Auto-start trace for the suite; the warden journal will not do — it sits in the sandbox
// the test tears down. Written at the decision, not inside the detached process.
function traceLaunch(env, line) {
    const file = env?.PROMPTOBUS_WARDEN_TRACE;
    if (!file)
        return;
    try {
        appendFileSync(file, `${line}\n`);
    }
    catch {
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
export function ensureWarden(home, task, { env = process.env, pollEnv, launch, host } = {}) {
    if (host == null)
        throw new Error('ensureWarden: host is required');
    try {
        if (wardenOff(env))
            return null;
        if (readTask(home, task).status !== 'active')
            return null;
        if (launch) {
            const existing = readWardenMark(home, task);
            if (existing && pidAlive(existing.pid))
                return null;
            const pid = launch(home, task, env, host);
            traceLaunch(env, `${new Date().toISOString()} warden auto-start · task ${task} · pid ${pid ?? '?'}`);
            return pid;
        }
        if (sharedEnsure) {
            sharedEnsure(home, task);
            traceLaunch(env, `${new Date().toISOString()} shared warden demand · task ${task} · pid ${process.pid}`);
            return process.pid;
        }
        return import('./service-client.js').then(client => client.ensureTaskWarden(host, home, task, { env, pollEnv }))
            .then(result => {
            traceLaunch(env, `${new Date().toISOString()} shared warden demand · task ${task} · pid ${result.pid}`);
            return result.pid;
        }).catch(() => null);
    }
    catch {
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
            if (driver.registerWake(home, meta.id, ORCHESTRATOR, env, session))
                taken.push(meta.id);
        }
    }
    catch {
        // A safety net may not drop a command or a turn.
    }
    return taken;
}
// The process itself. Started as `<commandName> warden --task <id>`; it does not need a
// workspace root — home and task arrive through the environment and a flag.
export async function warden(opts = {}, env = process.env, cwd = process.cwd()) {
    const host = opts.host;
    if (host == null)
        throw new Error('warden: host is required');
    const identity = resolveIdentity(env, cwd, { host });
    const home = identity.home;
    const cli = host.version;
    bus(home, { cli });
    const task = resolveTaskId(home, opts.task?.trim() || identity.declaredTask, identity.session, {
        spawnRepo: host.busCommand(['spawn', '--repo', '<name>', '--brief', '<file>']),
        spawnNewTask: host.busCommand(['spawn', '--new-task']),
    });
    const { ensureTaskWarden } = await import('./service-client.js');
    const result = await ensureTaskWarden(host, home, task, { env, cwd });
    ok(`warden of task ${task}: shared service pid ${result.pid} · ${result.state}`);
    return result;
}
export async function runTaskWarden({ home, task, host, session, signal, registry = REGISTRY }) {
    if (signal?.aborted)
        return { kind: 'stopped', reason: 'warden task aborted' };
    const cli = host.version;
    const claimed = withTaskLock(home, task, () => {
        const existing = readWardenMark(home, task);
        if (existing && pidAlive(existing.pid))
            return { busy: existing };
        return claimWarden(home, task, { cli, session });
    }, { session });
    if (claimed.busy) {
        warn(`warden of task ${task} is already running: pid ${claimed.busy.pid}, heartbeat ${claimed.busy.beat}`);
        return { kind: 'busy', mark: claimed.busy };
    }
    let watcher = null;
    let why = null;
    let failed = false, failure;
    try {
        ok(`warden of task ${task}: pid ${process.pid} · CLI ${cli}`);
        logWarden(home, task, `warden started · pid ${process.pid} · CLI ${cli}`);
        const startedMs = Date.now();
        const addrsOf = () => (readTask(home, task).participants ?? []).flatMap(p => addressOf(p) ? [addressOf(p)] : []);
        const snapshot = (participants) => snapshotSessions(participants, coreRegistry(registry));
        watcher = watchInboxes(home, task, addrsOf(), signal);
        let lastBeat = Date.now(), failures = 0;
        // Hold the snapshot between rounds; undefined requests its first read.
        // [hooks-and-trust.md § wardenRound](../docs/guides/hooks-and-trust.md#wardenround--one-watch-round).
        let sessions;
        for (;;) {
            if (signal?.aborted) {
                why = 'warden task aborted';
                break;
            }
            try {
                if (sessions === undefined)
                    sessions = snapshot(readTask(home, task).participants);
                const mailboxes = participantSlots(home, task);
                const tick = await supervisorRound(home, task, { sessions, registry: coreRegistry(registry), mailboxes });
                if (signal?.aborted) {
                    why = 'warden task aborted';
                    break;
                }
                if (tick.stop) {
                    why = tick.stop;
                    break;
                }
                sessions = reinspectKnocked(home, task, sessions, tick.knocked, snapshot);
                if (Date.now() - lastBeat >= WARDEN_BEAT_SEC * 1000) {
                    lastBeat = Date.now();
                    forgetSessions();
                    sessions = snapshot(readTask(home, task).participants);
                    // Stalls into the journal BEFORE the verdict: after it, the task's last stall
                    // would not make the round on which `beatRound` decides to exit.
                    const fresh = await stallRound(home, task, { sessions, mailboxes });
                    const reported = await reportResets(home, task, fresh, { registry: coreRegistry(registry), mailboxes });
                    for (const line of [...await host.formatStalls(task, fresh), ...reported]) {
                        logWarden(home, task, line);
                    }
                    if (signal?.aborted) {
                        why = 'warden task aborted';
                        break;
                    }
                    why = beatRound(home, task, startedMs, { sessions, session, mailboxes });
                    if (why)
                        break;
                    // The participant set changes during the run — watchers are rebuilt on the beat.
                    const addrs = addrsOf();
                    if (watchKey(home, task, addrs) !== watcher.addrs) {
                        await watcher.close();
                        watcher = watchInboxes(home, task, addrs, signal);
                    }
                }
                failures = 0;
            }
            catch (e) {
                failures += 1;
                logWarden(home, task, `watch round failed (${failures}/${ROUND_FAIL_LIMIT}): ${e.message}`);
                if (failures >= ROUND_FAIL_LIMIT) {
                    why = `watch round failed ${failures} times in a row: ${e.message}`;
                    break;
                }
            }
            await watcher.next(TICK_MS);
        }
    }
    catch (error) {
        why = `warden task failed: ${error instanceof Error ? error.message : String(error)}`;
        failed = true;
        failure = error;
    }
    finally {
        const cleanupErrors = [];
        try {
            await watcher?.close();
        }
        catch (error) {
            cleanupErrors.push(error);
        }
        try {
            if (why)
                writeWardenExit(home, task, { reason: why, at: new Date().toISOString() });
        }
        catch (error) {
            cleanupErrors.push(error);
        }
        try {
            clearWarden(home, task, process.pid, { session });
        }
        catch (error) {
            cleanupErrors.push(error);
        }
        if (readWardenMark(home, task)?.pid === process.pid)
            cleanupErrors.push(new Error(`Task ${task} retained its own warden seat`));
        if (cleanupErrors.length)
            throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], `Task ${task} warden cleanup failed`);
    }
    if (failed)
        throw failure;
    logWarden(home, task, `warden exited · ${why}`);
    info(`warden of task ${task} exited: ${why}`);
    return { kind: 'stopped', reason: why };
}

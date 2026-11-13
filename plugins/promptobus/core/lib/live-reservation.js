import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { addressOf, GateError, participantOf, readTask, sameStoreHome, taskDir, taskExists, withTaskLock, writeJsonAtomic } from './store.js';
import { createHarnessRegistry } from './harness-registry.js';
import { harnessStateHome } from './harness-home.js';
import { readLayers } from './model-routing/catalog.js';
import { processIdentity, processState, recordOf, recordVersion, sameRecordVersion } from './service-state.js';
import { REGISTRY } from './drivers.js';
import { pidAlive } from '../dist/index.js';
import { releaseNativeReservation } from './native-lifecycle.js';
export const reservationFile = (home, task) => path.join(taskDir(home, task), 'live-reservations.json');
export class LiveAdmissionError extends GateError {
}
export function liveReservations(home, task) {
    const file = reservationFile(home, task);
    let value;
    try {
        value = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw new GateError(`live reservations are unreadable: ${file}; repair the observation before retrying`);
    }
    if (!Array.isArray(value) || value.some(s => !recordOf(s) || typeof s.token !== 'string' || !s.token
        || typeof s.address !== 'string' || typeof s.ref !== 'string' || typeof s.harness !== 'string'
        || typeof s.nativeTask !== 'string' || typeof s.nativeAddress !== 'string'
        || (s.launchId !== null && typeof s.launchId !== 'string')
        || (s.nativeId !== null && typeof s.nativeId !== 'string') || (s.record !== null && typeof s.record !== 'string')
        || !['reserved', 'launching', 'registered'].includes(String(s.phase))
        || (s.owner !== null && (!recordOf(s.owner) || !Number.isSafeInteger(s.owner.pid) || typeof s.owner.birth !== 'string'))))
        throw new GateError(`live reservations are malformed: ${file}; repair the observation before retrying`);
    return value;
}
const save = (home, task, seats) => writeJsonAtomic(reservationFile(home, task), seats, { mode: 0o600 });
const deadOwner = (seat) => seat.owner !== null && processState(seat.owner) === 'dead';
const route = (host, task, seat) => `Stop the launcher pid ${seat.owner?.pid ?? 'unknown'} first, then ${host.busCommand(['stop', seat.address, '--task', task])}. `
    + `Unknown observations retain the seat; restore the harness registry and repeat that recovery. Reservation ${seat.token}.`;
export function observeLiveRef(harness, ref, env = process.env, primary = null) {
    try {
        let nativeId = null, launchId = null, settled = false;
        if (harness !== 'claude') {
            const scan = createHarnessRegistry({ harness }).scanSessions(env);
            if (!scan.complete)
                return { state: 'unknown', nativeId };
            let record = scan.records.find(r => r.ref === ref);
            const pointer = primary ?? (typeof record?.recordPath === 'string' ? record.recordPath : null);
            if (pointer) {
                try {
                    const raw = JSON.parse(readFileSync(pointer, 'utf8'));
                    if (!recordOf(raw) || raw.ref !== ref)
                        return { state: 'unknown', nativeId };
                    record = raw;
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        return { state: 'unknown', nativeId };
                }
            }
            if (record) {
                launchId = typeof record.launchId === 'string' ? record.launchId : null;
                const id = record.threadId ?? record.chatId ?? record.sessionId ?? record.sessionName;
                if (id !== undefined && id !== null && typeof id !== 'string')
                    return { state: 'unknown', nativeId, launchId };
                nativeId = typeof id === 'string' && id ? id : null;
                for (const field of ['holderPid', 'appPid', 'panePid']) {
                    const pid = record[field];
                    if (pid !== undefined && pid !== null && (!Number.isSafeInteger(pid) || Number(pid) <= 0))
                        return { state: 'unknown', nativeId, launchId };
                    if (pidAlive(pid))
                        return { state: 'alive', nativeId, launchId };
                }
                if (record.nativeCreationPending)
                    return { state: 'unknown', nativeId, launchId };
                settled = Number.isSafeInteger(record.holderPid) && Number(record.holderPid) > 0
                    && Number.isSafeInteger(record.appPid) && Number(record.appPid) > 0;
            }
            const driver = REGISTRY.drivers[harness], hook = driver?.reservationState;
            if (hook !== undefined) {
                const state = typeof hook === 'function' ? hook.call(driver, { ref, registryHome: harnessStateHome(harness, env) }) : 'unknown';
                return { state: state === 'alive' || state === 'dead' ? state : 'unknown', nativeId, launchId, settled };
            }
            if (!record && harness === 'opencode')
                return { state: 'dead', nativeId };
        }
        else
            REGISTRY.drivers[harness]?.forgetSessions?.();
        const view = REGISTRY.drivers[harness]?.inspect?.(ref);
        return { state: !view || view.state === 'unknown' ? 'unknown'
                : view.state === 'gone' || view.state === 'stale' ? 'dead' : 'alive',
            nativeId: typeof view?.id === 'string' && view.id ? view.id : nativeId, launchId, settled };
    }
    catch {
        return { state: 'unknown', nativeId: null };
    }
}
function reclaimable(seat, env) {
    if (!deadOwner(seat))
        return false;
    const seen = observeLiveRef(seat.harness, seat.ref, env, seat.record);
    return seen.state === 'dead' && (seat.phase === 'reserved'
        || seat.phase === 'registered' && !!seat.nativeId && (!seen.nativeId || seen.nativeId === seat.nativeId)
            && (!seen.launchId || seen.launchId === seat.launchId)
        || seat.phase === 'launching' && seat.harness !== 'claude' && !!seat.launchId && seen.launchId === seat.launchId
            && (!!seen.nativeId || seen.settled === true));
}
function capOf(host, harness) {
    let cap = null, overlay = null;
    for (const layer of readLayers(host).overlays) {
        const value = layer.data?.caps?.liveParticipants?.[harness];
        if (value === undefined)
            continue;
        if (!Number.isSafeInteger(value) || Number(value) < 0)
            throw new GateError(`invalid caps.liveParticipants.${harness} in ${layer.path}`);
        cap = Number(value);
        overlay = layer.path;
    }
    return { cap, overlay };
}
function occupiedBy(home, task, harness, address, seats, env) {
    const occupied = new Set(seats.filter(s => s.harness === harness).map(s => s.address));
    for (const p of taskExists(home, task) ? readTask(home, task).participants : []) {
        const at = addressOf(p);
        if (!at || at === address || p.harness !== harness)
            continue;
        const ref = p.sessionRef;
        if (!ref || observeLiveRef(harness, ref, env, typeof p.metadata.sessionRecord === 'string' ? p.metadata.sessionRecord : null).state !== 'dead')
            occupied.add(at);
    }
    return occupied;
}
export function liveCapNote(host, home, task, harness, address) {
    let limit;
    try {
        limit = capOf(host, harness);
    }
    catch (error) {
        if (!(error instanceof GateError))
            throw error;
        return `live-cap preview unavailable: ${error.message}. Dry-run reserves no seat.`;
    }
    const { cap, overlay } = limit;
    if (cap === null)
        return null;
    const occupied = new Set(liveReservations(home, task).filter(s => s.harness === harness).map(s => s.address));
    for (const p of taskExists(home, task) ? readTask(home, task).participants : []) {
        const at = addressOf(p);
        if (at && at !== address && p.harness === harness)
            occupied.add(at);
    }
    return `caps.liveParticipants.${harness}=${cap} in ${overlay}: ${occupied.size} journal participants or reservations; `
        + 'a real lift checks fresh liveness. Dry-run reserves no seat.';
}
export function reserveLiveSeat(host, home, task, address, harness, ref, env = process.env, record = null, native = {}) {
    return withTaskLock(home, task, () => {
        const meta = readTask(home, task);
        if (meta.status !== 'active')
            throw new GateError(`task ${task} is closed`);
        if (Object.hasOwn(native, 'previous')) {
            const current = participantOf(meta, address), previous = native.previous;
            const binding = (p) => [p.harness, p.sessionRef, p.metadata.sessionId];
            if ((!previous && current) || (previous && (!current || !isDeepStrictEqual(binding(current), binding(previous)))))
                throw new GateError(`${address} changed while its lift was planned; no harness was launched`);
        }
        const seats = liveReservations(home, task).filter(seat => !reclaimable(seat, env));
        const former = seats.find(seat => seat.address === address);
        if (former)
            throw new GateError(`live reservation for ${address} is active or unresolved. ${route(host, task, former)}`);
        const { cap, overlay } = capOf(host, harness);
        if (cap !== null) {
            const occupied = occupiedBy(home, task, harness, address, seats, env);
            if (occupied.size >= cap)
                throw new LiveAdmissionError(`caps.liveParticipants.${harness}=${cap} in ${overlay}: ${occupied.size} live or unresolved participants; ${address} was not launched`);
        }
        const owner = processIdentity(process.pid);
        if (!owner)
            throw new GateError('launcher process birth is unknown; restore process observation before admission. No harness was started');
        const seat = { token: randomUUID(), address, harness, ref, owner,
            phase: 'reserved', nativeId: null, record, nativeTask: native.task ?? task,
            nativeAddress: native.address ?? address, launchId: native.launchId ?? null };
        save(home, task, [...seats, seat]);
        return seat;
    });
}
function changeSeat(home, task, seat, update) {
    return withTaskLock(home, task, () => {
        const seats = liveReservations(home, task), current = seats.find(s => s.token === seat.token && s.address === seat.address);
        if (!current)
            throw new GateError(`live reservation ${seat.token} changed before launch publication`);
        const next = update(current);
        save(home, task, seats.flatMap(s => s === current ? next ? [next] : [] : [s]));
    });
}
export async function reservedSpawn(driver, plan, context, { task = context.task, address = context.address, ...expected } = {}) {
    let seat;
    try {
        seat = reserveLiveSeat(context.host, context.home, task, address, driver.id, context.ref, context.env, plan.sessionRecord ?? plan.prelaunchBinding?.sessionRecord ?? null, { task: context.task, address: context.address, launchId: plan.service?.launchId ?? plan.launchId, ...expected });
    }
    catch (error) {
        throw new LiveAdmissionError(error.message, { cause: error });
    }
    let stopped = false, bound = false, starting = false;
    plan.liveSeat = {
        starting: () => {
            changeSeat(context.home, task, seat, s => ({ ...s, phase: 'launching' }));
            starting = true;
        },
        stopped: () => { stopped = true; },
        staged: (record, launchId) => changeSeat(context.home, task, seat, s => ({ ...s, record, launchId })),
    };
    try {
        const result = await driver.spawn(plan, { ...context, persist: (id, state, full) => {
                if (state === 'alive' && full) {
                    changeSeat(context.home, task, seat, s => ({ ...s, phase: 'registered', nativeId: full }));
                    bound = true;
                }
                return context.persist(id, state, full);
            } });
        if (bound)
            changeSeat(context.home, task, seat, current => {
                const published = participantOf(readTask(context.home, task), address);
                return published?.harness === driver.id && published.sessionRef === context.ref
                    && published.metadata.sessionId === current.nativeId ? null : current;
            });
        return result;
    }
    catch (error) {
        if (stopped || !starting)
            changeSeat(context.home, task, seat, () => null);
        throw error;
    }
    finally {
        delete plan.liveSeat;
    }
}
export async function recoverLiveSeat(host, home, task, address, env = process.env) {
    const seat = withTaskLock(home, task, () => liveReservations(home, task).find(s => s.address === address));
    if (!seat)
        return false;
    if (!deadOwner(seat))
        throw new GateError(`live reservation owner is alive or unknown. ${route(host, task, seat)}`);
    const driver = REGISTRY.drivers[seat.harness];
    if (!driver?.stop)
        throw new GateError(`reservation harness ${seat.harness} has no Stop route`);
    const recoveryOwner = processIdentity(process.pid);
    if (!recoveryOwner)
        throw new GateError('recovery process birth is unknown; reservation retained');
    changeSeat(home, task, seat, current => {
        if (!isDeepStrictEqual(current, seat) || !deadOwner(current))
            throw new GateError('reservation changed before recovery');
        return { ...current, owner: recoveryOwner };
    });
    let retired = false;
    try {
        if (retireUnstartedRecord(home, task, seat, env) === false)
            throw new GateError(`unstarted reservation proof is incomplete or changed. ${route(host, task, seat)}`);
        const seen = observeLiveRef(seat.harness, seat.ref, env, seat.record);
        if (seen.launchId && seen.launchId !== seat.launchId || seen.nativeId && seat.nativeId && seen.nativeId !== seat.nativeId)
            throw new GateError(`reservation native generation changed. ${route(host, task, seat)}`);
        let stopped = false;
        if (seen.state !== 'dead' || seat.phase !== 'reserved') {
            const result = await driver.stop(seat.ref);
            stopped = result.ok && result.stopped === true;
        }
        changeSeat(home, task, seat, current => {
            if (!isDeepStrictEqual(current.owner, recoveryOwner) || (!stopped && !reclaimable(seat, env))
                || observeLiveRef(current.harness, current.ref, env, current.record).state !== 'dead')
                throw new GateError(`reservation session is live or unknown. ${route(host, task, seat)}`);
            return null;
        });
        retired = true;
    }
    finally {
        if (!retired)
            changeSeat(home, task, seat, current => {
                if (!isDeepStrictEqual(current.owner, recoveryOwner))
                    throw new GateError('reservation changed during recovery');
                return { ...current, owner: seat.owner };
            });
    }
    return true;
}
function retireUnstartedRecord(home, task, seat, env) {
    if (seat.harness === 'claude' || seat.phase !== 'reserved' || !seat.launchId || !deadOwner(seat))
        return;
    return withTaskLock(home, task, () => {
        const retire = () => {
            const driver = REGISTRY.drivers[seat.harness];
            const registry = createHarnessRegistry({ harness: seat.harness }), scan = registry.scanSessions(env);
            if (!scan.complete)
                return false;
            const entry = scan.records.find(r => r.ref === seat.ref);
            const file = seat.record ?? registry.sessionFile(seat.ref, env);
            let record, version;
            try {
                version = recordVersion(file);
                const raw = JSON.parse(readFileSync(file, 'utf8'));
                if (!recordOf(raw) || raw.ref !== seat.ref)
                    return false;
                record = raw;
            }
            catch (error) {
                return error.code === 'ENOENT' && !entry ? undefined : false;
            }
            if (driver?.retireUnstarted !== undefined) {
                if (typeof driver.retireUnstarted !== 'function')
                    return false;
                let retired;
                try {
                    retired = driver.retireUnstarted({ home, task: seat.nativeTask, address: seat.nativeAddress,
                        ref: seat.ref, registryHome: harnessStateHome(seat.harness, env), launchId: seat.launchId, owner: seat.owner });
                }
                catch {
                    return false;
                }
                if (retired !== true)
                    return false;
                if (taskExists(home, seat.nativeTask)) {
                    const p = participantOf(readTask(home, seat.nativeTask), seat.nativeAddress);
                    if (p?.harness === 'codex' && p.sessionRef === seat.ref && p.metadata.nativeLaunchId === seat.launchId)
                        releaseNativeReservation(home, seat.nativeTask, p);
                }
                return true;
            }
            if (entry && (entry.launchId !== seat.launchId || !sameStoreHome(entry.home, home)
                || entry.task !== seat.nativeTask || entry.address !== seat.nativeAddress))
                return false;
            if (!sameStoreHome(record.home, home) || record.task !== seat.nativeTask || record.address !== seat.nativeAddress
                || record.launchId !== seat.launchId || !isDeepStrictEqual(record.launcherProcess, seat.owner)
                || record.threadId || record.sessionId || record.chatId || record.sessionName
                || record.holderPid || record.appPid || record.panePid || record.nativeCreationPending
                || !sameRecordVersion(version))
                return false;
            registry.dropSession(seat.ref, env);
            if (file !== registry.sessionFile(seat.ref, env))
                rmSync(file, { force: true });
            return true;
        };
        return taskExists(home, seat.nativeTask) ? withTaskLock(home, seat.nativeTask, retire) : retire();
    });
}
export function requireReservationIdle(home, task, address, env = process.env) {
    return withTaskLock(home, task, () => {
        const original = liveReservations(home, task), seats = original.filter(s => !reclaimable(s, env));
        if (seats.some(s => s.address === address))
            throw new GateError(`${address} has an active or unresolved launch reservation; stop its recorded launcher and use the task owner's Stop recovery`);
        if (seats.length !== original.length)
            save(home, task, seats);
    });
}
export function withReservationIdle(home, task, address, fn) {
    return withTaskLock(home, task, () => {
        requireReservationIdle(home, task, address);
        return fn();
    });
}
export function requireNoLiveReservations(host, home, task) {
    const seat = liveReservations(home, task)[0];
    if (seat)
        throw new GateError(`task has a live or unresolved reservation. ${route(host, task, seat)}`);
}

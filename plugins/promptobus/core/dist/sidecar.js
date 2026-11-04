// The sidecar: state beside the journal.
// [reference/01-overview.md#the-sidecar-state-beside-the-journal](../docs/reference/01-overview.md#the-sidecar-state-beside-the-journal)
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { writeFileAtomic, writeJsonAtomic } from './fs/atomic.js';
import { LOCK_WAIT_MS, withDirLock, withDirLockAsync } from './fs/lock.js';
import { pidAlive } from './fs/proc.js';
import { blobLockDir, lockDir } from './v1/layout.js';
import { addrDir, GateError, requireTaskId, TASK_ID_RE, taskDir, tasksDir } from './protocol.js';
// --- directories -------------------------------------------------------------
export function workersDir(home, id) {
    return path.join(taskDir(home, id), 'workers');
}
// Session-to-task bindings — next to `tasks/`: resolve must answer in one read.
export function sessionsDir(home) {
    return path.join(home, 'sessions');
}
// --- task warden -------------------------------------------------------------
// Listening on the bus is held by a process, not by the model. It has no state of its own —
// everything lives in the task directory, so the warden dying loses nothing.
// Process mark. The file name is leftover from the former warden name and must not be renamed: under
// a new name a previous release's mark would go unseen, and two wardens would stand on one task.
export function wardenMarkFile(home, id) {
    return path.join(taskDir(home, id), 'supervisor.json');
}
// Participant contact point — their messaging socket address and its token, handed over by the
// participant itself. The token is a secret; the file is written with mode `0600`.
export function wakeFile(home, id, addr) {
    return path.join(taskDir(home, id), 'wake', `${addrDir(addr)}.json`);
}
// What the warden knows about delivery to each address. A file of its own, not fields on the task
// journal: a write happens on every delivery, and the journal is edited under the lock.
export function healthFile(home, id) {
    return path.join(taskDir(home, id), 'health.json');
}
// Warden log — line-oriented, append-only: deliveries, rollbacks, escalations. This is NOT the task
// journal, and the file name is the former one for the same reason as the warden mark.
export function wardenLogFile(home, id) {
    return path.join(taskDir(home, id), 'supervisor.log');
}
export function stallsFile(home, id) {
    return path.join(taskDir(home, id), 'stalls.json');
}
// How often the warden refreshes its mark, kept next to the liveness read: a drift between the write
// period and the stale threshold would declare a live process dead. The threshold is three periods.
export const WARDEN_BEAT_SEC = 30;
export function readWardenMark(home, id) {
    try {
        return JSON.parse(readFileSync(wardenMarkFile(home, id), 'utf8'));
    }
    catch {
        return null;
    }
}
export function writeWardenMark(home, id, mark) {
    writeJsonAtomic(wardenMarkFile(home, id), mark);
    return mark;
}
export function dropWardenMark(home, id) {
    rmSync(wardenMarkFile(home, id), { force: true });
}
function wardenExitFile(home, id) {
    return path.join(taskDir(home, id), 'waits', 'warden.exit.json');
}
export function writeWardenExit(home, id, note) {
    writeJsonAtomic(wardenExitFile(home, id), note);
}
export function readWardenExit(home, id) {
    try {
        const raw = JSON.parse(readFileSync(wardenExitFile(home, id), 'utf8'));
        return typeof raw?.reason === 'string' && typeof raw?.at === 'string' ? raw : null;
    }
    catch {
        return null;
    }
}
export function clearWardenExit(home, id) {
    rmSync(wardenExitFile(home, id), { force: true });
}
function wardenGenerationFile(home, id) {
    return path.join(taskDir(home, id), 'waits', 'warden.gen.json');
}
export function readWardenGeneration(home, id) {
    try {
        const raw = JSON.parse(readFileSync(wardenGenerationFile(home, id), 'utf8'));
        const gen = raw?.gen;
        return typeof gen === 'number' && Number.isInteger(gen) && gen >= 0 ? gen : 0;
    }
    catch {
        return 0;
    }
}
function bumpWardenGeneration(home, id) {
    const gen = readWardenGeneration(home, id) + 1;
    writeJsonAtomic(wardenGenerationFile(home, id), { gen });
    return gen;
}
// The live warden of this task, or `null`. Two signs, both required: a live pid (the system reuses
// numbers) and an unstale `beat` (a process killed between beats would count as live).
export function liveWarden(home, id) {
    const mark = readWardenMark(home, id);
    if (!mark)
        return null;
    if (!pidAlive(mark.pid))
        return null;
    const beat = Date.parse(mark.beat ?? mark.started ?? '');
    if (!(Number.isFinite(beat) && Date.now() - beat < WARDEN_BEAT_SEC * 3000))
        return null;
    return mark;
}
export function readWake(home, id, addr) {
    try {
        return JSON.parse(readFileSync(wakeFile(home, id, addr), 'utf8'));
    }
    catch {
        return null;
    }
}
// Hand over the contact point. Called often, so a file with the same contents is not rewritten.
// Mode `0600` for the session token: macOS does not enforce it, but code without it is not portable.
export function writeWake(home, id, addr, { socket, token = null, pid = process.pid, session = null, } = {}) {
    if (!socket)
        return null;
    const next = {
        address: addr,
        socket,
        ...(token ? { token } : {}),
        pid,
        ...(session ? { session } : {}),
        at: new Date().toISOString(),
    };
    const was = readWake(home, id, addr);
    if (was && was.socket === next.socket && was.token === next.token
        && was.pid === next.pid && was.session === next.session)
        return was;
    writeFileAtomic(wakeFile(home, id, addr), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
}
export function readHealth(home, id) {
    try {
        const raw = JSON.parse(readFileSync(healthFile(home, id), 'utf8'));
        return raw && typeof raw === 'object' ? raw : {};
    }
    catch {
        return {};
    }
}
export function writeHealth(home, id, health) {
    writeJsonAtomic(healthFile(home, id), health);
    return health;
}
export function readStalls(home, id) {
    try {
        const raw = JSON.parse(readFileSync(stallsFile(home, id), 'utf8'));
        return Object.fromEntries(Object.entries(raw).map(([addr, v]) => [
            addr, typeof v === 'string' ? { reason: v, at: null } : v,
        ]));
    }
    catch {
        return {};
    }
}
/** Atomic: a truncated file would be read as "never reported". */
export function writeStalls(home, id, stalls) {
    writeJsonAtomic(stallsFile(home, id), stalls);
    return stalls;
}
// Append a line to the warden log. No lock and no atomic replace: one line shorter than the pipe
// buffer does not tear, there is one writer, and a log-write refusal must not stop delivery.
export function logWarden(home, id, line) {
    try {
        mkdirSync(taskDir(home, id), { recursive: true });
        appendFileSync(wardenLogFile(home, id), `${new Date().toISOString()} ${line}\n`);
        return true;
    }
    catch {
        return false;
    }
}
// Tail of the warden log for `promptobus status`. Read whole: a run has tens
// of delivery events.
export function tailWardenLog(home, id, n = 3) {
    try {
        const lines = readFileSync(wardenLogFile(home, id), 'utf8').split('\n').filter(Boolean);
        return lines.slice(-n);
    }
    catch {
        return [];
    }
}
// --- end-of-turn mark --------------------------------------------------------
// End-of-turn mark for an address. The guard sets it on EVERY turn end, and it is the only sign that
// a session yielded the turn where there is no bg session. The guard counter will not do — it wipes.
function turnFile(home, id, addr) {
    return path.join(taskDir(home, id), 'waits', `${addrDir(addr)}.turn.json`);
}
export function markTurn(home, id, addr, at = new Date().toISOString()) {
    writeJsonAtomic(turnFile(home, id, addr), { at });
    return at;
}
// When the address last yielded the turn; milliseconds, or `null` — there
// has never been a mark.
export function lastTurnAt(home, id, addr) {
    try {
        const raw = JSON.parse(readFileSync(turnFile(home, id, addr), 'utf8'));
        const at = Date.parse(typeof raw?.at === 'string' ? raw.at : '');
        return Number.isFinite(at) ? at : null;
    }
    catch {
        return null;
    }
}
function transcriptFile(home, id, addr) {
    return path.join(taskDir(home, id), 'waits', `${addrDir(addr)}.transcript.json`);
}
export function markTranscript(home, id, addr, file, session = null) {
    const was = readTranscript(home, id, addr);
    if (was && was.path === file && was.session === session)
        return was;
    const next = { path: file, session, at: new Date().toISOString() };
    writeJsonAtomic(transcriptFile(home, id, addr), next);
    return next;
}
export function readTranscript(home, id, addr) {
    try {
        const raw = JSON.parse(readFileSync(transcriptFile(home, id, addr), 'utf8'));
        if (typeof raw?.path !== 'string' || !raw.path)
            return null;
        return { path: raw.path, session: typeof raw.session === 'string' ? raw.session : null, at: String(raw.at ?? '') };
    }
    catch {
        return null;
    }
}
// --- session-to-task bindings: a file per session, without which the task was inferred by "the only
// active one" and a foreign session took it. Where there is no identity, resolve falls back to that guess.
export function sessionFile(home, session) {
    if (typeof session !== 'string' || !TASK_ID_RE.test(session))
        return null;
    return path.join(sessionsDir(home), `${session}.json`);
}
export function readBinding(home, session) {
    const file = sessionFile(home, session);
    if (!file)
        return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
export function writeBinding(home, mark) {
    return writeJsonAtomic(sessionFile(home, mark.session), mark);
}
/** Names of sessions that have a binding mark. Cleanup walks this list. */
export function bindingNames(home) {
    const dir = sessionsDir(home);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length));
}
export function dropBinding(home, session) {
    const file = sessionFile(home, session);
    if (file)
        rmSync(file, { force: true });
}
const suspenders = [];
export function onTaskLock(suspend) {
    suspenders.push(suspend);
}
// Busy-lock refusal. Only a live holder reaches here: a dead one was dropped
// by `dropDeadLock`.
export function lockBusyError(id, lock, held, waitedMs) {
    const who = held?.pid
        ? `Held by a live process ${held.pid}${held.session ? ` (session ${held.session})` : ''}`
            + `${held.since ? `, since ${held.since}` : ''} — wait for it and retry the command;`
            + ` to see what it is doing: ps -p ${held.pid}`
        : 'Who holds it, the lock did not name: the owner file was not written — that is how a process looks that died'
            + ' between creating the directory and the write. Delete the lock directory if the writing process is already gone from the system';
    return new GateError(`task ${id} journal is busy: waited ${waitedMs} ms, lock ${lock}. ${who}`);
}
// Task lock, exported for journal read-modify-write on the adapter side and for the test, whose seam
// is `waitMs`. Session identity arrives as an ARGUMENT and only for busy-lock diagnosis.
export function withTaskLock(home, id, fn, { waitMs = LOCK_WAIT_MS, session = null, } = {}) {
    const task = requireTaskId(id);
    const lock = lockDir(home, task);
    const guarded = suspenders.reduce((inner, suspend) => () => suspend(inner), fn);
    return withDirLock(lock, guarded, {
        waitMs,
        session,
        // No task directory at all is not a busy lock: we speak with the words and the CLASS of
        // `readTask` — the same text with a stack or without reads as two different outcomes.
        onMissing: () => new GateError(`task ${id} is not in ${tasksDir(home)}`),
        onBusy: (held, waitedMs) => lockBusyError(id, lock, held, waitedMs),
    });
}
/** The journal lock and cache suspension held until asynchronous work settles. */
export function withTaskLockAsync(home, id, fn, { waitMs = LOCK_WAIT_MS, session = null, } = {}) {
    const task = requireTaskId(id);
    const lock = lockDir(home, task);
    const guarded = suspenders.reduce((inner, suspend) => () => suspend(inner), fn);
    return withDirLockAsync(lock, guarded, {
        waitMs,
        session,
        onMissing: () => new GateError(`task ${id} is not in ${tasksDir(home)}`),
        onBusy: (held, waitedMs) => lockBusyError(id, lock, held, waitedMs),
    });
}
/** Publication lock, adapter side: a sweep judges a payload under the lock a send names one in.
 * [reference/04-protocol.md#store-layout](../docs/reference/04-protocol.md#store-layout) */
export function withBlobLock(home, id, fn, { waitMs = LOCK_WAIT_MS, session = null, } = {}) {
    const task = requireTaskId(id);
    const lock = blobLockDir(home, task);
    return withDirLock(lock, fn, {
        waitMs,
        session,
        onMissing: () => new GateError(`task ${id} is not in ${tasksDir(home)}`),
        onBusy: (held, waitedMs) => lockBusyError(id, lock, held, waitedMs),
        onSelfAsync: () => new GateError(`task ${id} payloads are held by an asynchronous publication `
            + `of this process (lock ${lock}) — waiting for it here would block the loop that has to `
            + 'release it, so there is nothing to wait for'),
    });
}
// Claim the warden place first-wins — one decision under the lock: a check
// and a write apart are TOCTOU, and two would watch the same task.
export function claimWarden(home, id, { pid = process.pid, cli = null, harness = null, session = null, } = {}) {
    return withTaskLock(home, id, () => {
        const busy = liveWarden(home, id);
        if (busy)
            return { busy };
        const now = new Date().toISOString();
        const mark = { pid, started: now, beat: now, ...(cli ? { cli } : {}), ...(harness ? { harness } : {}) };
        writeWardenMark(home, id, mark);
        bumpWardenGeneration(home, id);
        return { mark };
    }, { session });
}
// Heartbeat: only OUR own mark is extended, and only an existing one. The place was taken — `null`,
// and the process exits on that: two must not watch the same task.
export function beatWarden(home, id, { pid = process.pid, session = null, } = {}) {
    return withTaskLock(home, id, () => {
        const mark = readWardenMark(home, id);
        if (!mark || mark.pid !== pid)
            return null;
        mark.beat = new Date().toISOString();
        writeWardenMark(home, id, mark);
        return mark;
    }, { session });
}
// Only our own mark is cleared: a process whose place was taken would carry off a foreign record,
// and the next reader would see "no warden" while one is live.
export function clearWarden(home, id, pid = process.pid, { session = null, } = {}) {
    if (!existsSync(taskDir(home, id)))
        return false;
    return withTaskLock(home, id, () => {
        const mark = readWardenMark(home, id);
        if (mark && mark.pid !== pid)
            return false;
        dropWardenMark(home, id);
        return true;
    }, { session });
}

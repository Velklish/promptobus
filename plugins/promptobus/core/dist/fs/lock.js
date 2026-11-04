// The lock: what it guards and what it cannot.
// [reference/01-overview.md#the-lock-what-it-guards-and-what-it-cannot](../../docs/reference/01-overview.md#the-lock-what-it-guards-and-what-it-cannot)
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { pidAlive, sleepSync } from './proc.js';
export const LOCK_WAIT_MS = 5000;
export const LOCK_RETRY_MS = 20;
/** Who holds the lock. A former-CLI lock holds the pid as a string and is read too: the only process
 * that can outlive the directory is one that died mid-write. */
export function lockHolder(lock) {
    let raw;
    try {
        raw = readFileSync(path.join(lock, 'owner'), 'utf8').trim();
    }
    catch {
        return null;
    }
    if (!raw)
        return null;
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    }
    catch { /* not JSON — a former-CLI lock */ }
    // The object check is not a formality: a bare pid of the former format is
    // valid JSON, and `JSON.parse('999999')` yields a number with no `pid` field.
    if (parsed && typeof parsed === 'object')
        return parsed;
    return { pid: Number(raw) || null, session: null, since: null };
}
/** An orphaned lock, by pid liveness. An exclusive claim inside its generation serializes
 * reclamation; an old read alone cannot license renaming a replacement directory. */
export function dropDeadLock(lock) {
    let generation;
    try {
        generation = statSync(lock, { bigint: true });
    }
    catch {
        return false;
    }
    const held = lockHolder(lock);
    if (!held?.pid || pidAlive(held.pid))
        return false;
    const claim = path.join(lock, '.reclaim');
    try {
        mkdirSync(claim);
    }
    catch (e) {
        const code = e.code;
        if (code === 'EEXIST' || code === 'ENOENT')
            return false;
        throw e;
    }
    let claimed;
    try {
        claimed = statSync(claim, { bigint: true });
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return false;
        throw e;
    }
    try {
        const current = statSync(lock, { bigint: true });
        const owner = lockHolder(lock);
        if (current.dev !== generation.dev || current.ino !== generation.ino
            || JSON.stringify(owner) !== JSON.stringify(held) || !owner?.pid || pidAlive(owner.pid))
            return false;
        writeFileSync(path.join(claim, 'owner'), `${JSON.stringify({
            pid: process.pid, session: null, since: new Date().toISOString(), nonce: randomUUID(),
        })}\n`);
        const tomb = `${lock}.dead.${process.pid}.${randomUUID()}`;
        try {
            renameSync(lock, tomb);
        }
        catch {
            return false;
        }
        rmSync(tomb, { recursive: true, force: true });
        return true;
    }
    catch (e) {
        // A claim created in a replacement generation does not stop that live
        // holder from releasing its own directory before our recheck.
        if (e.code === 'ENOENT')
            return false;
        throw e;
    }
    finally {
        // Only the original dead parent is stable under our claim. A replacement live parent
        // may disappear between stat and rm; leave its claim for the holder's normal release.
        let currentClaim;
        try {
            const parent = statSync(lock, { bigint: true });
            if (parent.dev === generation.dev && parent.ino === generation.ino
                && JSON.stringify(lockHolder(lock)) === JSON.stringify(held)) {
                currentClaim = statSync(claim, { bigint: true });
            }
        }
        catch { /* already removed with the tomb or released by a replacement holder */ }
        if (currentClaim?.dev === claimed.dev && currentClaim.ino === claimed.ino) {
            rmSync(claim, { recursive: true, force: true });
        }
    }
}
function reclamationRefusal(lock) {
    const claim = path.join(lock, '.reclaim');
    try {
        statSync(claim);
    }
    catch {
        return null;
    }
    const held = lockHolder(claim);
    if (held?.pid && pidAlive(held.pid)) {
        return new Error(`lock ${lock} has a live reclamation holder pid ${held.pid}; retry after it finishes`);
    }
    const quoted = `'${claim.replaceAll("'", "'\\''")}'`;
    return new Error(`lock ${lock} has an interrupted reclamation claim${held?.pid ? ` pid ${held.pid}` : ' with no owner'}; `
        + `automatic removal is refused. After verifying the lock owner and reclaimer have exited, remove only this claim: rm -r -- ${quoted}`);
}
/** Locks a SYNCHRONOUS frame of this process holds now: the nesting licence, and nothing wider.
 *  Why the licence stops at an `await`: reference/04-protocol.md § Store layout. */
const heldSync = new Set();
/** Locks an asynchronous holder of this process has in flight. Not a nesting licence. */
const heldAsync = new Set();
/** Tail of the queue of asynchronous holders, per lock path. */
const asyncQueue = new Map();
let synchronousAuthority = null;
/** Private HTTP dispatch scope: no synchronous wait may carry an earlier native proof forward. */
export function withSynchronousAuthority(authorize, fn) {
    const previous = synchronousAuthority;
    synchronousAuthority = authorize;
    try {
        authorize();
        return fn();
    }
    finally {
        synchronousAuthority = previous;
    }
}
export function requireSynchronousAuthority() { synchronousAuthority?.(); }
// Waiting this one out synchronously would block the very loop that has to release it.
// That is a caller mistake — a design with no lawful case — not a busy lock.
function selfAsyncError(lock) {
    return new Error(`lock ${lock} is held by an asynchronous holder in this process: a synchronous `
        + 'wait would block the loop that must release it, so there is nothing to wait for');
}
// One attempt at the directory: its nonce — it is ours, `null` — a live holder has it. A
// dead holder is dropped and the attempt repeats; only the waiting differs between callers.
function tryGrabDirLock(lock, session, onMissing) {
    for (;;) {
        try {
            mkdirSync(lock);
            const nonce = randomUUID();
            writeFileSync(path.join(lock, 'owner'), `${JSON.stringify({
                pid: process.pid, session, since: new Date().toISOString(), nonce,
            })}\n`);
            return nonce;
        }
        catch (e) {
            const code = e.code;
            if (code === 'ENOENT')
                throw onMissing();
            if (code !== 'EEXIST')
                throw e;
            if (dropDeadLock(lock))
                continue;
            return null;
        }
    }
}
// The wait, for a caller that has nothing else to do while it waits: a live holder is sat
// out for `waitMs` and then refused in the caller's words.
function grabDirLock(lock, { waitMs = LOCK_WAIT_MS, retryMs = LOCK_RETRY_MS, session = null, onMissing, onBusy, }) {
    const started = Date.now();
    const deadline = started + (synchronousAuthority ? 0 : waitMs);
    for (;;) {
        const nonce = tryGrabDirLock(lock, session, onMissing);
        if (nonce)
            return nonce;
        if (Date.now() >= deadline)
            throw reclamationRefusal(lock) ?? onBusy(lockHolder(lock), Date.now() - started);
        sleepSync(retryMs);
    }
}
// The same wait for a caller that is already asynchronous. `sleepSync` here would freeze
// the loop of THIS process for the whole of a foreign hold — the send waits, not the loop.
async function grabDirLockAsync(lock, { waitMs = LOCK_WAIT_MS, retryMs = LOCK_RETRY_MS, session = null, onMissing, onBusy, }) {
    const started = Date.now();
    const deadline = started + waitMs;
    for (;;) {
        const nonce = tryGrabDirLock(lock, session, onMissing);
        if (nonce)
            return nonce;
        if (Date.now() >= deadline)
            throw reclamationRefusal(lock) ?? onBusy(lockHolder(lock), Date.now() - started);
        await new Promise((resolve) => { setTimeout(resolve, retryMs); });
    }
}
function releaseDirLock(lock, nonce) {
    if (lockHolder(lock)?.nonce !== nonce)
        return;
    rmSync(lock, { recursive: true, force: true });
}
/** Take the lock directory, run, and drop. A missing task directory stays the caller's
 * own refusal: a nested call does not reach the directory at all. */
export function withDirLock(lock, fn, options) {
    if (heldSync.has(lock)) {
        requireSynchronousAuthority();
        return fn();
    }
    if (heldAsync.has(lock))
        throw (options.onSelfAsync ?? selfAsyncError)(lock);
    const nonce = grabDirLock(lock, options);
    heldSync.add(lock);
    try {
        requireSynchronousAuthority();
        return fn();
    }
    finally {
        heldSync.delete(lock);
        releaseDirLock(lock, nonce);
    }
}
async function underDirLock(lock, fn, options) {
    const nonce = await grabDirLockAsync(lock, options);
    heldAsync.add(lock);
    try {
        return await fn();
    }
    finally {
        heldAsync.delete(lock);
        releaseDirLock(lock, nonce);
    }
}
/** The same lock held across an await: `withDirLock` would drop the directory when `fn` handed
 *  back its promise, so holders of one path queue instead of nesting. Licence: § Store layout. */
export function withDirLockAsync(lock, fn, options) {
    const previous = asyncQueue.get(lock) ?? Promise.resolve();
    const run = previous.then(() => underDirLock(lock, fn, options));
    const settled = run.then(() => { }, () => { });
    asyncQueue.set(lock, settled);
    // The tail is dropped once it is the one that settled: otherwise the map keeps an entry
    // per lock path for the life of the process.
    void settled.then(() => {
        if (asyncQueue.get(lock) === settled)
            asyncQueue.delete(lock);
    });
    return run;
}

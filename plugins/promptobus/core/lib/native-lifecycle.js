import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readStopConfirmation } from './codex-command-receipts.js';
import { codexStateHome, pidAlive, sessionFile, sessionKey, sessionsDir, withSessionLaunch } from './codex-session.js';
import { addrDir, addressOf, canonicalPath, FALLBACK_HARNESS, GateError, ORCHESTRATOR, participantOf, readTask, rootAddressOf, sameStoreHome, taskExists, upsertParticipant, withTaskLock } from './store.js';
import { ownerOf, sessionIdOf } from '../dist/index.js';
import { libOpenParticipant } from './driver-runtime.js';
const native = (p) => p?.harness === 'codex';
const refuse = address => {
    throw new GateError('participant ' + address + ': native work is active or unresolved; confirm Stop before done or recovery. '
        + 'A session its own harness already reports dead is retired with abandon: the journal names the missing receipt and does not gain a Stop receipt.');
};
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const binding = (p) => [p?.sessionRef, p?.metadata?.nativeLaunchId, p?.metadata?.sessionId];
export function ownsLegacyLaunch(home, task, address, expected) {
    const record = JSON.parse(readFileSync(expected.record, 'utf8'));
    if (!record || typeof record.home !== 'string' || !sameStoreHome(record.home, home) || record.task !== task
        || record.address !== address || record.ref !== expected.ref || record.launchId !== expected.launchId)
        return false;
    if (!taskExists(home, task))
        return expected.deferTaskBinding === true;
    const meta = readTask(home, task), participant = participantOf(meta, address);
    if (expected.deferTaskBinding && Object.hasOwn(expected, 'previousParticipant')) {
        return meta.status === 'active' && isDeepStrictEqual(participant, expected.previousParticipant);
    }
    return meta.status === 'active' && participant?.harness === 'claude' && participant.sessionRef === expected.ref
        && participant.metadata.sessionRecord === expected.record && !participant.metadata.nativeLaunchId && !participant.metadata.nativeStop;
}
export function requireCurrentNativeLaunch(current, expected) {
    if (!native(current) && !native(expected) && !current?.metadata?.nativeLaunchId && !current?.metadata?.nativeStop)
        return;
    if (!native(current) || !native(expected) || current.sessionRef !== expected.sessionRef
        || typeof expected.metadata?.nativeLaunchId !== 'string' || !expected.metadata.nativeLaunchId
        || current.metadata.nativeLaunchId !== expected.metadata.nativeLaunchId
        || current.metadata.nativeStop || current.metadata.nativeUnlaunched)
        refuse(current?.id ?? expected?.id);
}
function hasRecord(ref, env = process.env) {
    try {
        lstatSync(sessionFile(ref, env));
        return true;
    }
    catch (caught) {
        const error = caught;
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function terminalProof(home, task, address, participant, proof, env, subject = participant.id) {
    const ref = participant.sessionRef;
    if (participant.metadata.nativePendingLaunchId)
        refuse(subject);
    if (!ref || hasRecord(ref, env))
        refuse(subject);
    if (typeof participant.metadata.nativeLaunchId === 'string' && participant.metadata.nativeLaunchId
        && participant.metadata.nativeUnlaunched === participant.metadata.nativeLaunchId)
        return;
    if (!proof || proof.ref !== ref
        || !sameStoreHome(proof.home, home) || proof.task !== task || proof.address !== address
        || proof.threadId !== participant.metadata.sessionId
        || proof.launchId !== participant.metadata.nativeLaunchId
        || typeof proof.launchId !== 'string' || !proof.launchId)
        refuse(subject);
    const expected = path.join(codexStateHome(env), 'receipts', sessionKey(ref), sessionKey(proof.launchId) + '.jsonl');
    try {
        if (proof.receiptFile !== expected || hash(expected) !== proof.sha256
            || !readStopConfirmation(expected, proof).ok || pidAlive(proof.holderPid) || pidAlive(proof.appPid))
            refuse(subject);
    }
    catch {
        refuse(subject);
    }
}
function linkedTeamlead(home, child, record, { allowClosedClaim = false, subject = record.address } = {}) {
    const parent = readTask(home, child.parent);
    const leads = parent.participants.filter(p => p.role === 'teamlead' && p.metadata.childTask === child.id);
    const owner = participantOf(child, ORCHESTRATOR), lead = leads[0];
    if (parent.parent !== undefined || child.parent !== parent.id || leads.length !== 1
        || !native(lead) || lead.mode !== 'managed' || !native(owner) || owner.mode !== 'attached'
        || child.owner !== owner.id || (owner.metadata.owner !== record.threadId && !(allowClosedClaim && child.status === 'done'))
        || record.address !== ORCHESTRATOR || record.task !== child.id
        || [lead, owner].some(p => p.sessionRef !== record.ref || p.metadata.sessionId !== record.threadId
            || (p.metadata.nativeLaunchId && p.metadata.nativeLaunchId !== record.launchId)))
        refuse(subject);
    return { parent, lead, owner };
}
export function withNativeStopLocks(record, fn, { deadlineAt } = {}) {
    const options = () => deadlineAt === undefined ? {} : { waitMs: Math.max(0, deadlineAt - Date.now()) };
    const session = () => withSessionLaunch(record.ref, process.env, fn, options());
    if (!record.home || !record.task)
        return session();
    const parent = record.address === ORCHESTRATOR ? readTask(record.home, record.task).parent : undefined;
    const task = () => withTaskLock(record.home, record.task, () => {
        if (record.address === ORCHESTRATOR && readTask(record.home, record.task).parent !== parent)
            refuse(record.address);
        return session();
    }, options());
    return parent === undefined ? task() : withTaskLock(record.home, parent, task, options());
}
// Not a Stop receipt. Close may use it only while `sessionDead` still says the harness
// reports that session dead; a later live holder is unresolved again.
export function abandonmentAllowsClose(participant, sessionDead) {
    const mark = participant?.metadata?.abandoned;
    if (!mark || typeof mark !== 'object' || Array.isArray(mark))
        return false;
    if (typeof mark.at !== 'string' || !mark.at.trim())
        return false;
    if (typeof mark.by !== 'string' || !mark.by.trim())
        return false;
    if (!Array.isArray(mark.unknown) || !mark.unknown.length
        || mark.unknown.some((item) => typeof item !== 'string' || !item.trim()))
        return false;
    if (!mark.unknown.includes('stop-receipt'))
        return false;
    return sessionDead === true;
}
export function requireNativeTerminal(home, meta, participant, env = process.env, { taskLocked = false, onVerified, lockWaitMs } = {}) {
    const proof = participant.metadata.nativeStop;
    const subject = participant.role === 'teamlead'
        ? addressOf(participant) + ' (child task ' + participant.metadata.childTask + ')' : participant.id;
    if (!proof?.alias) {
        terminalProof(home, meta.id, addressOf(participant), participant, proof, env, subject);
        return onVerified?.();
    }
    if (participant.role !== 'teamlead' || meta.parent !== undefined || proof.alias.task !== meta.id
        || proof.alias.address !== addressOf(participant) || Object.keys(proof.alias).length !== 2
        || typeof proof.task !== 'string' || proof.task !== participant.metadata.childTask)
        refuse(subject);
    const inspect = () => withTaskLock(home, proof.task, () => withSessionLaunch(participant.sessionRef, env, () => {
        const current = participantOf(readTask(home, meta.id), addressOf(participant));
        const { alias, ...original } = proof;
        const { parent, lead, owner } = linkedTeamlead(home, readTask(home, proof.task), original, { allowClosedClaim: true, subject });
        if (parent.id !== meta.id || lead.id !== participant.id
            || JSON.stringify(binding(current)) !== JSON.stringify(binding(participant))
            || !isDeepStrictEqual(current.metadata.nativeStop, proof)
            || !isDeepStrictEqual(owner.metadata.nativeStop, original))
            refuse(subject);
        terminalProof(home, proof.task, ORCHESTRATOR, current, original, env, subject);
        onVerified?.();
    }, { waitMs: lockWaitMs }), { waitMs: lockWaitMs });
    return taskLocked ? inspect() : withTaskLock(home, meta.id, inspect);
}
/** The caller holds the parent and child task locks, in that order. */
export function requireNativeRootRoute(home, child, route, env = process.env) {
    const childOwner = participantOf(child, ORCHESTRATOR);
    const proof = childOwner?.metadata.nativeStop;
    if (!child.parent || !proof || route.role !== 'root' || route.harness !== FALLBACK_HARNESS
        || route.mode !== 'attached' || route.sessionRef || sessionIdOf(route)
        || ['owner', 'session', 'sessionId', 'sessionRef', 'sessionRecord', 'nativeLaunchId', 'nativeStop', 'nativePendingLaunchId', 'nativeUnlaunched']
            .some(key => route.metadata[key] !== undefined && route.metadata[key] !== null)
        || child.participants.filter(p => p.role === 'root').length !== 1)
        refuse(route.id);
    const { parent, lead } = linkedTeamlead(home, child, proof, { allowClosedClaim: true, subject: route.id });
    const owner = participantOf(parent, ORCHESTRATOR);
    if (!lead.metadata.nativeStop?.alias
        || lead.metadata.nativeUnlaunched === lead.metadata.nativeLaunchId
        || parent.adapter?.bb || route.metadata.rootTask !== parent.id || addressOf(route) !== rootAddressOf(parent)
        || route.id !== addrDir(rootAddressOf(parent))
        || !native(owner) || owner.mode !== 'managed' || parent.owner !== owner.id
        || !ownerOf(owner) || ownerOf(owner) !== sessionIdOf(owner) || !owner.metadata.nativeStop
        || owner.metadata.nativeUnlaunched === owner.metadata.nativeLaunchId)
        refuse(route.id);
    requireNativeIdle(home, parent, ORCHESTRATOR, { taskLocked: true });
    requireNativeTerminal(home, parent, lead, env, { taskLocked: true });
}
export function withVerifiedManagedNativeStop(home, proof, env, onVerified) {
    const nativeRecord = canonicalPath(sessionFile(proof.ref, env));
    return withTaskLock(home, proof.task, () => {
        const task = readTask(home, proof.task), participant = participantOf(task, proof.address);
        const terminal = participant?.metadata.nativeStop;
        if (task.status !== 'active' || participant?.harness !== 'codex'
            || participant.sessionRef !== proof.ref || participant.metadata.sessionRecord !== proof.record
            || participant.metadata.nativeLaunchId !== proof.launchId || participant.metadata.nativeUnlaunched === proof.launchId
            || !terminal || (!terminal.alias && nativeRecord !== canonicalPath(proof.record)))
            return false;
        let retired = false;
        const verified = () => {
            if (terminal.alias) {
                if (typeof terminal.task !== 'string')
                    return;
                const owner = participantOf(readTask(home, terminal.task), ORCHESTRATOR);
                if (typeof owner?.metadata.sessionRecord !== 'string'
                    || canonicalPath(owner.metadata.sessionRecord) !== nativeRecord)
                    return;
            }
            retired = onVerified(participant);
        };
        const verify = () => requireNativeTerminal(home, task, participant, env, { taskLocked: true, onVerified: verified, lockWaitMs: 0 });
        if (terminal.alias)
            verify();
        else
            withSessionLaunch(proof.ref, env, verify, { waitMs: 0 });
        return retired;
    }, { waitMs: 0 });
}
function deadHolderRecord(record) {
    return !pidAlive(record?.holderPid) && !pidAlive(record?.appPid);
}
export function requireNativeIdle(home, meta, address = null, { taskLocked = false, sessionDead = null } = {}) {
    const dead = (participant) => typeof sessionDead === 'function' && sessionDead(participant) === true;
    for (const p of meta.participants) {
        if (address && addressOf(p) !== address)
            continue;
        if (!native(p))
            continue;
        if (p.metadata.nativePendingLaunchId)
            refuse(p.id);
        if (abandonmentAllowsClose(p, dead(p)))
            continue;
        if (p.mode === 'managed') {
            if (!p.sessionRef)
                refuse(p.id);
            if (p.metadata.nativeStop?.alias)
                requireNativeTerminal(home, meta, p, process.env, { taskLocked });
            else
                withSessionLaunch(p.sessionRef, process.env, () => requireNativeTerminal(home, meta, p));
        }
        else if (p.sessionRef && hasRecord(p.sessionRef))
            refuse(p.id);
    }
    let names;
    try {
        names = readdirSync(sessionsDir());
    }
    catch (caught) {
        const error = caught;
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    for (const name of names.filter(name => name.endsWith('.json'))) {
        let record;
        try {
            record = JSON.parse(readFileSync(path.join(sessionsDir(), name), 'utf8'));
        }
        catch {
            throw new GateError('native registry is unreadable; task close cannot prove owned work idle');
        }
        if (sameStoreHome(record.home, home) && record.task === meta.id
            && (!address || !record.address || record.address === address)) {
            const covered = typeof record.address === 'string'
                && meta.participants.some((p) => addressOf(p) === record.address
                    && abandonmentAllowsClose(p, dead(p)) && deadHolderRecord(record));
            if (!covered)
                refuse(record.address ?? record.ref);
        }
    }
}
export function retainNativeStop(record, receiptFile) {
    if (!record.home || !record.task || !record.address)
        return;
    const meta = readTask(record.home, record.task);
    const p = participantOf(meta, record.address);
    if (!native(p) || p.sessionRef !== record.ref || p.metadata.sessionId !== record.threadId
        || (p.metadata.nativeLaunchId && p.metadata.nativeLaunchId !== record.launchId))
        refuse(record.address);
    const nativeStop = {
        home: record.home, task: record.task, address: record.address, ref: record.ref,
        threadId: record.threadId, launchId: record.launchId, holderPid: record.holderPid, appPid: record.appPid,
        rawToolReceipts: record.rawToolReceipts, cwd: record.cwd,
        receiptFile, sha256: hash(receiptFile),
    };
    const linked = record.address === ORCHESTRATOR && meta.parent !== undefined ? linkedTeamlead(record.home, meta, record) : null;
    const aliasProof = linked ? { ...nativeStop, alias: { task: linked.parent.id, address: addressOf(linked.lead) } } : null;
    if (p.metadata.nativeStop && !isDeepStrictEqual(p.metadata.nativeStop, JSON.parse(JSON.stringify(nativeStop))))
        refuse(record.address);
    if (linked?.lead.metadata.nativeStop
        && !isDeepStrictEqual(linked.lead.metadata.nativeStop, JSON.parse(JSON.stringify(aliasProof))))
        refuse(linked.lead.id);
    upsertParticipant(record.home, record.task, { ...p, metadata: { ...p.metadata, nativeLaunchId: record.launchId, nativeStop } });
    if (linked) {
        const { parent, lead } = linked;
        upsertParticipant(record.home, parent.id, { ...lead,
            metadata: { ...lead.metadata, nativeLaunchId: record.launchId, nativeStop: aliasProof } });
    }
}
export function reserveNativeParticipant(home, task, participant, expected, registry) {
    return withTaskLock(home, task, () => {
        const meta = readTask(home, task);
        if (meta.status !== 'active')
            throw new GateError('task ' + task + ' is closed');
        const current = participantOf(meta, addressOf(participant));
        if (!native(participant) && !native(expected) && !native(current)) {
            if (!isDeepStrictEqual(current ?? null, expected ?? null))
                throw new GateError(`participant ${participant.id} changed while its lift was planned; no harness was launched`);
            return libOpenParticipant(home, task, participant, registry, { assignment: true });
        }
        if (JSON.stringify(binding(current)) !== JSON.stringify(binding(expected)))
            refuse(participant.id);
        if (native(current))
            requireNativeTerminal(home, meta, current);
        const record = native(participant)
            ? { ...participant, metadata: { ...participant.metadata, nativeLaunchId: randomUUID() } } : participant;
        return libOpenParticipant(home, task, record, registry, { assignment: true });
    });
}
export function persistNativeParticipant(home, task, reserved, metadata) {
    return withTaskLock(home, task, () => {
        const meta = readTask(home, task), current = participantOf(meta, addressOf(reserved));
        if (meta.status !== 'active' || !current || current.sessionRef !== reserved.sessionRef
            || current.metadata.nativeLaunchId !== reserved.metadata.nativeLaunchId
            || current.metadata.nativeStop || current.metadata.nativeUnlaunched)
            refuse(reserved.id);
        return upsertParticipant(home, task, { ...current, metadata: { ...current.metadata, ...metadata } });
    });
}
export function persistLegacyParticipant(home, task, participant) {
    return withTaskLock(home, task, () => {
        const meta = readTask(home, task), current = participantOf(meta, addressOf(participant));
        if (meta.status !== 'active' || !current || current.harness !== participant.harness || current.sessionRef !== participant.sessionRef
            || native(current) || current.metadata.nativeLaunchId || current.metadata.nativeStop
            || (participant.metadata.sessionRecord && current.metadata.sessionRecord !== participant.metadata.sessionRecord))
            refuse(participant.id);
        return upsertParticipant(home, task, participant);
    });
}
export function releaseNativeReservation(home, task, reserved) {
    if (!native(reserved))
        return;
    return withTaskLock(home, task, () => {
        const meta = readTask(home, task), current = participantOf(meta, addressOf(reserved));
        if (meta.status !== 'active' || !native(current) || current.sessionRef !== reserved.sessionRef
            || current.metadata.nativeLaunchId !== reserved.metadata.nativeLaunchId
            || current.metadata.sessionId !== reserved.metadata.sessionId || current.metadata.nativeStop)
            return;
        return withSessionLaunch(current.sessionRef, process.env, () => {
            if (hasRecord(current.sessionRef))
                return;
            return upsertParticipant(home, task, { ...current,
                metadata: { ...current.metadata, nativeUnlaunched: reserved.metadata.nativeLaunchId } });
        });
    });
}

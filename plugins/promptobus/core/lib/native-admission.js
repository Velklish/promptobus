import { createHash } from 'node:crypto';
import { acquireServiceLock, contained, readPrivate, recordOf, processRecord, processStateAsync, recordVersion, sameRecordVersion, writePrivate } from './service-state.js';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { closeSync, constants, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { openEngine, sessionIdOf, sessionRefOf } from '../dist/index.js';
import { processExecutable, processHasOpenFile } from './root-process.js';
import { readRootAdmissionState } from './root-admission.js';
import { participantOf, readTask } from './store.js';
const fileOf = (paths) => path.join(paths.directory, 'native-admission.json');
const markerOf = (paths) => path.join(paths.directory, 'native-admission.initialized.json');
const nativeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value);
export function requireKnownNativeOutcomes(paths, nonce) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(nonce))
        throw new Error('Native request history generation is invalid');
    const directory = path.join(paths.requests, `root-${nonce}`);
    let sessions;
    try {
        sessions = readdirSync(directory);
    }
    catch (error) {
        if (recordOf(error) && error.code === 'ENOENT')
            return;
        throw error;
    }
    for (const session of sessions) {
        if (!/^[a-f0-9-]{36}$/.test(session))
            throw new Error('Native request history contains an unknown session');
        for (const name of readdirSync(path.join(directory, session))) {
            const receipt = readPrivate(path.join(directory, session, name));
            if (!/^[a-f0-9]{64}\.json$/.test(name) || !recordOf(receipt) || typeof receipt.digest !== 'string'
                || typeof receipt.state !== 'string' || !['started', 'completed'].includes(receipt.state) || typeof receipt.readOnly !== 'boolean'
                || (receipt.response !== undefined && receipt.response !== null && !recordOf(receipt.response))
                || (receipt.state === 'started' && !receipt.readOnly)) {
                throw new Error('Native mutation outcome is uncertain; inspect the journal before capability recovery, resume or another mutation');
            }
        }
    }
}
function bindingOf(value) {
    return recordOf(value) && typeof value.harness === 'string' && ['codex', 'claude', 'cursor', 'opencode'].includes(value.harness)
        && typeof value.source === 'string' && ['standalone', 'bb', 'managed'].includes(value.source)
        && (value.nativeStore === null || (typeof value.nativeStore === 'string' && path.isAbsolute(value.nativeStore) && path.resolve(value.nativeStore) === value.nativeStore))
        && nativeId(value.nativeId) && typeof value.runtime === 'string'
        && typeof value.ownerKey === 'string' && value.ownerKey.length > 0 && (value.process === null || processRecord(value.process) !== null)
        && ((value.nativeStore !== null && value.process !== null) || value.source === 'managed')
        && typeof value.nonce === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.nonce)
        && (value.profile === undefined || (typeof value.profile === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.profile)))
        && (value.phase === undefined || value.phase === 'pending' || value.phase === 'bound')
        && (value.previousNonce === undefined || typeof value.previousNonce === 'string')
        && (value.previousManaged === undefined || (recordOf(value.previousManaged) && typeof value.previousManaged.ownerKey === 'string'
            && (value.previousManaged.nativeStore === null || typeof value.previousManaged.nativeStore === 'string')
            && (value.previousManaged.process === null || processRecord(value.previousManaged.process) !== null)
            && recordOf(value.previousManaged.record)));
}
function missingFile(file) {
    try {
        lstatSync(file);
        return false;
    }
    catch (error) {
        if (recordOf(error) && error.code === 'ENOENT')
            return true;
        throw error;
    }
}
function initializedLedger(paths) {
    const file = markerOf(paths), missing = missingFile(file), value = readPrivate(file);
    if (missing && value === null && missingFile(file))
        return false;
    if (!recordOf(value) || value.schemaVersion !== 2 || value.root !== paths.root || value.home !== paths.home) {
        throw new Error('Native admission initialization is not current-version state; legacy or corrupt state is retained without migration');
    }
    return true;
}
function ledgerOf(paths) {
    const file = fileOf(paths), initialized = initializedLedger(paths), missing = missingFile(file), value = readPrivate(file);
    if (value === null && missing && !initialized && missingFile(file) && !initializedLedger(paths)) {
        let launches;
        try {
            launches = readdirSync(paths.directory);
        }
        catch (error) {
            if (recordOf(error) && error.code === 'ENOENT')
                launches = [];
            else
                throw error;
        }
        if (launches.some(name => /^standalone-launch-[a-f0-9-]{36}\.json$/.test(name)
            || /^root-profile-[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/.test(name))) {
            throw new Error('Missing native registry with retained native profile or launch state is unknown, not a new empty owner');
        }
        return { schemaVersion: 2, root: paths.root, home: paths.home, bindings: [] };
    }
    if (!initialized || !recordOf(value) || value.schemaVersion !== 2 || value.root !== paths.root || value.home !== paths.home
        || !Array.isArray(value.bindings) || !value.bindings.every(bindingOf))
        throw new Error('Available native admission registry is corrupt or belongs to another owner');
    const bindings = value.bindings;
    const keys = bindings.map(binding => JSON.stringify([binding.harness, binding.nativeStore, binding.nativeId]));
    if (new Set(keys).size !== keys.length || bindings.some((binding, index) => bindings.some((other, otherIndex) => otherIndex > index
        && binding.harness === other.harness && binding.nativeId === other.nativeId && (binding.nativeStore === null || other.nativeStore === null)))) {
        throw new Error('Available native admission registry contains duplicate or unresolved overlapping identities');
    }
    return value;
}
function writeLedger(paths, ledger) {
    if (!initializedLedger(paths))
        writePrivate(markerOf(paths), { schemaVersion: 2, root: paths.root, home: paths.home });
    writePrivate(fileOf(paths), ledger);
}
export function requireNativeAdmissionState(paths) { ledgerOf(paths); }
// Approval calls this under root-admission.lock before any new standalone launch can be published.
export function initializeNativeAdmissionState(paths) {
    const ledger = ledgerOf(paths);
    if (missingFile(fileOf(paths)))
        writeLedger(paths, ledger);
}
export function nativeStoreForServiceClient(paths, grant, actualId) {
    if (!grant.nativeBinding || grant.nativeBinding.state !== 'bound')
        return null;
    const lifetime = grant.lifetime;
    const candidates = ledgerOf(paths).bindings.filter(value => value.harness === grant.nativeBinding.kind && value.nativeId === actualId
        && value.runtime === grant.runtime && value.nativeStore !== null && (lifetime.kind === 'managed'
        ? value.source === 'managed' && value.ownerKey === lifetime.launchId && value.nonce === lifetime.launchId
        : lifetime.kind === 'process' && isDeepStrictEqual(value.process, lifetime.process) && (grant.rootLaunch
            ? value.source === 'standalone' && value.phase === 'bound' && value.nonce === grant.rootLaunch.nonce
            : grant.bbRootNonce !== undefined && value.source === 'bb' && value.nonce === grant.bbRootNonce)));
    if (candidates.length !== 1)
        return null;
    try {
        return realpathSync(candidates[0].nativeStore) === candidates[0].nativeStore ? candidates[0].nativeStore : null;
    }
    catch {
        return null;
    }
}
function sameGeneration(a, b) {
    return a.harness === b.harness && a.nativeId === b.nativeId && a.source === b.source
        && a.runtime === b.runtime && a.ownerKey === b.ownerKey && a.nonce === b.nonce
        && a.profile === b.profile
        && (a.process === null || b.process === null || isDeepStrictEqual(a.process, b.process))
        && (a.nativeStore === null || b.nativeStore === null || a.nativeStore === b.nativeStore);
}
async function managedRecordNativeStore(paths, file, record, harness, actualId, runtime) {
    if (!file || typeof record.task !== 'string' || typeof record.address !== 'string' || typeof record.ref !== 'string'
        || typeof record.launchId !== 'string' || !recordOf(record.nativeAdmission))
        return null;
    try {
        const participant = participantOf(readTask(paths.home, record.task), record.address);
        if (participant?.mode !== 'managed' || sessionIdOf(participant) !== actualId || sessionRefOf(participant) !== record.ref
            || participant.metadata?.sessionRecord !== file
            || (participant.metadata.nativeLaunchId !== undefined && participant.metadata.nativeLaunchId !== record.launchId))
            return null;
        const publication = await managedPublication(paths, { runtime, lifetime: { kind: 'managed', task: record.task,
                address: record.address, ref: record.ref, launchId: record.launchId, record: file }, nativeBinding: { kind: harness, state: 'pending' } }, actualId, false);
        return publication.binding.nativeStore;
    }
    catch {
        return null;
    }
}
async function availableRecords(paths, binding, context, replaced, standaloneResume = false) {
    for (const name of readdirSync(paths.directory)) {
        if (!/^standalone-launch-[a-f0-9-]{36}\.json$/.test(name))
            continue;
        const launch = readPrivate(path.join(paths.directory, name));
        if (!recordOf(launch) || (launch.nativeId !== null && !nativeId(launch.nativeId))
            || (launch.resumeNativeId !== null && !nativeId(launch.resumeNativeId)))
            throw new Error('Available standalone native history is corrupt');
        // A resume selector without an observed hook ID is an intent, not a second realized native binding.
        if (launch.nativeId !== binding.nativeId)
            continue;
        if (launch.root !== paths.root || launch.home !== paths.home || typeof launch.profile !== 'string'
            || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(launch.profile) || !processRecord(launch.process)) {
            throw new Error('Potentially matching standalone native provenance is unavailable');
        }
        const profile = readPrivate(path.join(paths.directory, `root-profile-${launch.profile}.json`));
        if (!recordOf(profile) || profile.mode !== 'standalone' || profile.root !== paths.root || profile.home !== paths.home
            || typeof profile.harness !== 'string' || !['codex', 'claude'].includes(profile.harness) || typeof profile.nativeStore !== 'string'
            || !path.isAbsolute(profile.nativeStore))
            throw new Error('Available standalone native store is unknown');
        if (profile.harness !== binding.harness || (binding.nativeStore !== null && realpathSync(profile.nativeStore) !== binding.nativeStore))
            continue;
        if (binding.source === 'standalone' && launch.nonce === binding.nonce && launch.profile === binding.profile
            && launch.runtime === binding.runtime && isDeepStrictEqual(launch.process, binding.process))
            continue;
        if (binding.source === 'standalone' && launch.profile === binding.profile && launch.runtime === binding.runtime
            && (standaloneResume || ledgerOf(paths).bindings.some(value => sameGeneration(value, binding)))
            && await processStateAsync(processRecord(launch.process)) === 'dead') {
            requireKnownNativeOutcomes(paths, String(launch.nonce));
            continue;
        }
        throw new Error('Available standalone native identity belongs to another live, unknown or excluded generation');
    }
    const accepts = async (record, actualId, harness, file) => {
        if (actualId !== binding.nativeId)
            return;
        if (typeof harness !== 'string' || !['codex', 'claude', 'cursor', 'opencode'].includes(harness)) {
            throw new Error('Potentially matching available managed harness provenance is unknown');
        }
        if (harness !== binding.harness)
            return;
        if (typeof record.home === 'string' && realpathSync(record.home) !== paths.home)
            return;
        if (binding.source === 'managed' && record.launchId === binding.ownerKey)
            return;
        if (binding.source === 'managed' && replaced && record.launchId === replaced.ownerKey) {
            const store = recordOf(record.nativeAdmission) ? record.nativeAdmission.nativeStore : record.codexHome;
            if (typeof store === 'string' && realpathSync(store) === replaced.nativeStore)
                return;
        }
        const store = binding.nativeStore === null ? null : await managedRecordNativeStore(paths, file, record, binding.harness, binding.nativeId, binding.runtime);
        if (store !== null && store !== binding.nativeStore)
            return;
        throw new Error('Potentially matching available managed identity has unresolved or conflicting owner/store provenance');
    };
    const tasks = path.join(paths.home, 'tasks');
    let hasTasks = true;
    try {
        readdirSync(tasks);
    }
    catch (error) {
        if (recordOf(error) && error.code === 'ENOENT')
            hasTasks = false;
        else
            throw error;
    }
    if (hasTasks) {
        const listed = openEngine({ home: paths.home, cli: context.host.version, recover: false,
            policy: () => ({ deny: true, reason: 'native admission inventory only' }) }).listTasks();
        if (listed.broken.length)
            throw new Error('Available task journal cannot exclude a native identity conflict');
        for (const task of listed.tasks)
            for (const participant of task.participants) {
                if (participant.mode !== 'managed')
                    continue;
                const id = sessionIdOf(participant);
                if (id !== binding.nativeId)
                    continue;
                const record = typeof participant.metadata?.sessionRecord === 'string' ? readPrivate(participant.metadata.sessionRecord) : null;
                await accepts(recordOf(record) ? record : { home: paths.home }, id, participant.harness, typeof participant.metadata?.sessionRecord === 'string' ? participant.metadata.sessionRecord : null);
            }
    }
    const variable = `PROMPTOBUS_${binding.harness.toUpperCase()}_HOME`;
    const root = context.env[variable] || context.host.harnessStateHome(binding.harness);
    if (root) {
        let names;
        try {
            names = readdirSync(path.join(root, 'sessions'));
        }
        catch (error) {
            if (recordOf(error) && error.code === 'ENOENT')
                names = [];
            else
                throw error;
        }
        for (const name of names) {
            if (!name.endsWith('.json'))
                continue;
            const record = readPrivate(path.join(root, 'sessions', name));
            if (!recordOf(record))
                throw new Error('Available harness registry contains an unreadable identity record');
            await accepts(record, record.threadId ?? record.sessionId ?? record.chatId, binding.harness, path.join(root, 'sessions', name));
        }
    }
    if (binding.harness !== 'codex')
        return;
    const bb = readRootAdmissionState(paths);
    if (bb !== null) {
        if (!recordOf(bb) || bb.schemaVersion !== 2 || bb.root !== paths.root || bb.home !== paths.home
            || !Array.isArray(bb.profiles) || !Array.isArray(bb.roots) || !Array.isArray(bb.managed))
            throw new Error('Available BB admission registry is corrupt or belongs to another owner');
        for (const value of bb.roots) {
            if (!recordOf(value) || !recordOf(value.generation))
                throw new Error('Available BB native identity is incomplete');
            if (binding.harness !== 'codex' || value.generation.nativeThreadId !== binding.nativeId)
                continue;
            const profile = bb.profiles.find(profile => recordOf(profile) && profile.id === value.profileId);
            if (!recordOf(profile) || typeof profile.nativeStore !== 'string')
                throw new Error('Available BB native store provenance is unknown');
            if (binding.nativeStore !== null && binding.nativeStore !== profile.nativeStore)
                continue;
            if (binding.source === 'bb' && binding.ownerKey === value.bbThreadId && binding.nonce === value.generation.nonce
                && isDeepStrictEqual(binding.process, value.generation.appServer))
                continue;
            if (binding.source === 'bb' && binding.ownerKey === value.bbThreadId && binding.profile === value.profileId
                && profile.runtime === binding.runtime && processRecord(value.generation.appServer)) {
                if (await processStateAsync(processRecord(value.generation.appServer)) === 'dead') {
                    requireKnownNativeOutcomes(paths, String(value.generation.nonce));
                    continue;
                }
            }
            throw new Error('Available BB native identity conflicts with this admission');
        }
    }
}
// Called only by realizeRoot while its authoritative lookup transaction still owns root-admission.lock.
export async function reserveBbNativeSuccessor(paths, binding, context) {
    if (binding.source !== 'bb' || binding.harness !== 'codex' || !binding.profile || !binding.nativeStore || !binding.process) {
        throw new Error('BB native successor requires the exact approved profile and actual process');
    }
    const ledger = ledgerOf(paths), index = ledger.bindings.findIndex(value => value.harness === binding.harness
        && value.nativeId === binding.nativeId && (value.nativeStore === null || value.nativeStore === binding.nativeStore));
    const old = ledger.bindings[index];
    if (!old) {
        const profile = readRootAdmissionState(paths)?.profiles.find(value => value.id === binding.profile
            && value.runtime === binding.runtime && value.nativeStore === binding.nativeStore);
        if (profile?.creation?.state !== 'bound' || profile.creation.bbThreadId !== binding.ownerKey
            || profile.creation.nativeThreadId !== binding.nativeId) {
            throw new Error('First BB binding requires its approved ordinary creation and actual same-thread native proof');
        }
        await recordNativeBinding(paths, binding, context);
        return;
    }
    if (sameGeneration(old, binding)) {
        await recordNativeBinding(paths, binding, context);
        return;
    }
    if (old.source !== 'bb' || old.ownerKey !== binding.ownerKey || old.profile !== binding.profile || old.runtime !== binding.runtime
        || old.nativeStore !== binding.nativeStore || old.process === null || old.nonce === binding.nonce) {
        throw new Error('BB successor cannot replace another origin, owner, profile, store or immutable generation');
    }
    if (await processStateAsync(old.process) !== 'dead')
        throw new Error('BB successor requires positive exit of the exact prior native process lifetime; live or unknown proof refuses');
    requireKnownNativeOutcomes(paths, old.nonce);
    await availableRecords(paths, binding, context);
    if (!isDeepStrictEqual(ledgerOf(paths), ledger))
        throw new Error('BB native reservation changed during lifetime observation');
    ledger.bindings[index] = { ...binding, previousNonce: old.nonce };
    writeLedger(paths, ledger);
}
// Both functions run under the existing owner root-admission.lock, including BB/managed callers.
export async function assertNativeBinding(paths, binding, context) {
    if (!bindingOf(binding))
        throw new Error('Native admission requires one complete actual identity binding');
    await availableRecords(paths, binding, context);
    const ledger = ledgerOf(paths), matching = ledger.bindings.filter(value => value.harness === binding.harness
        && value.nativeId === binding.nativeId && (value.nativeStore === null || binding.nativeStore === null || value.nativeStore === binding.nativeStore));
    if (ledger.bindings.some(value => value.harness === binding.harness && value.nativeId === binding.nativeId && value.source === binding.source
        && value.runtime === binding.runtime && value.ownerKey === binding.ownerKey && value.nonce === binding.nonce && value.profile === binding.profile
        && !sameGeneration(value, binding)))
        throw new Error('An immutable native generation cannot change its known store or captured process');
    if (matching.length > 1 || (matching[0] && !sameGeneration(matching[0], binding))) {
        throw new Error('Native identity is bound to another process or generation; an explicit approved recovery transition is required');
    }
    return ledger;
}
export async function recordNativeBinding(paths, binding, context, validatePublication) {
    const ledger = await assertNativeBinding(paths, binding, context);
    validatePublication?.();
    const index = ledger.bindings.findIndex(value => sameGeneration(value, binding));
    const previous = ledger.bindings[index];
    if (previous?.phase === 'bound' && binding.phase === 'pending')
        throw new Error('Native binding cannot return to pending');
    const refined = previous ? { ...previous, ...binding, nativeStore: binding.nativeStore ?? previous.nativeStore, process: binding.process ?? previous.process } : binding;
    if (!previous || !isDeepStrictEqual(previous, refined)) {
        if (previous)
            ledger.bindings[index] = refined;
        else
            ledger.bindings.push(refined);
        writeLedger(paths, ledger);
    }
}
export function requireCurrentNativeBinding(paths, binding) {
    if (binding.harness === 'codex')
        readRootAdmissionState(paths);
    const current = ledgerOf(paths).bindings.find(value => value.harness === binding.harness
        && value.nativeStore === binding.nativeStore && value.nativeId === binding.nativeId);
    if (!current || !sameGeneration(current, binding) || current.phase !== binding.phase) {
        throw new Error('Native admission reservation is absent, incomplete or belongs to another generation');
    }
}
export async function reserveExplicitStandaloneResume(paths, binding, context) {
    if (!bindingOf(binding) || binding.source !== 'standalone' || !binding.profile || binding.phase !== 'pending'
        || binding.nativeStore === null || binding.process === null)
        throw new Error('Explicit standalone resume requires the exact new pending generation');
    const lock = path.join(paths.directory, 'root-admission.lock'), deadline = Date.now() + 5000;
    let release = await acquireServiceLock(lock);
    while (!release) {
        if (Date.now() >= deadline)
            throw new Error('Native resume is already being reserved');
        await new Promise(resolve => setTimeout(resolve, 20));
        release = await acquireServiceLock(lock);
    }
    try {
        const ledger = ledgerOf(paths), index = ledger.bindings.findIndex(value => value.harness === binding.harness
            && value.nativeId === binding.nativeId && (value.nativeStore === null || value.nativeStore === binding.nativeStore));
        const old = ledger.bindings[index];
        if (old) {
            if (old.source !== 'standalone' || old.profile !== binding.profile || old.runtime !== binding.runtime || old.nativeStore !== binding.nativeStore
                || old.process === null || old.nonce === binding.nonce)
                throw new Error('Explicit resume cannot change owner, profile, runtime or native store');
            if (!/^[a-f0-9-]{36}$/.test(old.ownerKey) || !/^[a-f0-9-]{36}$/.test(old.nonce))
                throw new Error('Prior standalone owner identity is corrupt');
            const oldFile = path.join(paths.directory, `standalone-launch-${old.nonce}.json`), oldLaunch = readPrivate(oldFile);
            if (!recordOf(oldLaunch) || oldLaunch.root !== paths.root || oldLaunch.home !== paths.home || oldLaunch.runtime !== old.runtime
                || oldLaunch.profile !== old.profile || oldLaunch.nonce !== old.nonce || old.ownerKey !== old.nonce
                || typeof oldLaunch.clientId !== 'string'
                || !isDeepStrictEqual(oldLaunch.process, old.process) || (old.phase === 'bound' && oldLaunch.nativeId !== binding.nativeId)) {
                throw new Error('Prior standalone launch provenance is unavailable or changed');
            }
            const credential = readPrivate(path.join(paths.clients, `${oldLaunch.clientId}.json`));
            if (credential !== null && (!recordOf(credential) || credential.id !== oldLaunch.clientId || credential.runtime !== old.runtime
                || !isDeepStrictEqual(credential.rootLaunch, { file: oldFile, nonce: old.nonce })))
                throw new Error('Prior standalone credential ownership is unknown');
            if (await processStateAsync(old.process) !== 'dead')
                throw new Error('Explicit resume requires positive death of the recorded native process and birth');
            requireKnownNativeOutcomes(paths, old.nonce);
            const after = readPrivate(oldFile);
            const fields = ['root', 'home', 'runtime', 'profile', 'nonce', 'clientId', 'process', 'nativeId', 'phase', 'resumeNativeId'];
            if (!recordOf(after) || fields.some(field => !isDeepStrictEqual(oldLaunch[field], after[field]))) {
                throw new Error('Prior standalone launch changed during death observation');
            }
            if (!isDeepStrictEqual(ledgerOf(paths), ledger))
                throw new Error('Native resume generation changed during death observation');
            await availableRecords(paths, binding, context, undefined, true);
            if (!isDeepStrictEqual(ledgerOf(paths), ledger))
                throw new Error('Native resume reservation changed during available-history observation');
            ledger.bindings[index] = { ...binding, previousNonce: old.nonce };
        }
        else {
            throw new Error('Explicit resume requires a known current-version native binding; unknown IDs cannot be adopted and retained state is not migrated');
        }
        writeLedger(paths, ledger);
        return old ?? null;
    }
    finally {
        release();
    }
}
export function standaloneBindingForRecovery(paths, runtime, profile, nativeId) {
    const candidates = ledgerOf(paths).bindings.filter(value => value.source === 'standalone' && value.runtime === runtime
        && value.profile === profile && value.nativeId === nativeId);
    if (candidates.length !== 1 || candidates[0].phase !== 'bound')
        throw new Error('Recovery requires exactly one owner-realized native binding');
    const binding = candidates[0];
    requireCurrentNativeBinding(paths, binding);
    return binding;
}
async function managedPublication(paths, grant, nativeId, observeCurrentProcess = true) {
    if (grant.lifetime.kind !== 'managed' || !grant.nativeBinding)
        throw new Error('Managed admission requires its owned launch lifetime');
    const proof = grant.lifetime, version = recordVersion(proof.record), record = readPrivate(proof.record);
    if (!recordOf(record) || record.launchId !== proof.launchId || record.ref !== proof.ref
        || record.task !== proof.task || record.address !== proof.address || typeof record.home !== 'string'
        || realpathSync(record.home) !== paths.home || (record.threadId ?? record.sessionId ?? record.chatId) !== nativeId) {
        throw new Error('Managed native admission requires the exact current owned launch record');
    }
    let nativeStore = null, process = null;
    if (record.nativeAdmissionSchema !== undefined && record.nativeAdmissionSchema !== 1)
        throw new Error('Unknown managed native admission schema');
    if (record.nativeAdmissionSchema === 1 && (!recordOf(record.nativeAdmission) || !processRecord(record.holderProcess)
        || !processRecord(record.appProcess) || record.holderPid !== processRecord(record.holderProcess).pid
        || record.appPid !== processRecord(record.appProcess).pid || record.holderPid === record.appPid)) {
        throw new Error('Managed native schema requires captured holder and app process births');
    }
    if (record.nativeAdmission !== undefined) {
        const value = record.nativeAdmission;
        if (!recordOf(value) || value.harness !== grant.nativeBinding.kind || value.nativeId !== nativeId
            || typeof value.nativeStore !== 'string' || !path.isAbsolute(value.nativeStore)
            || realpathSync(value.nativeStore) !== value.nativeStore || !processRecord(value.process))
            throw new Error('Published managed native store/process provenance is incomplete');
        nativeStore = value.nativeStore;
        process = processRecord(value.process);
        if (record.nativeAdmissionSchema === 1 && !isDeepStrictEqual(record.appProcess, process))
            throw new Error('Managed native publication changed its captured own child');
        // Read-only conflict classification may retain a proved store after process exit; admission still requires alive proof.
        if (observeCurrentProcess && await processStateAsync(process) !== 'alive')
            throw new Error('Published managed native process identity is unavailable or replaced');
        if (grant.nativeBinding.kind === 'codex') {
            if (typeof record.codexHome !== 'string' || realpathSync(record.codexHome) !== nativeStore) {
                throw new Error('Managed Codex requires its actual private CODEX_HOME provenance');
            }
            const evidence = record.nativeAdmissionEvidence;
            if (evidence !== undefined) {
                if (!recordOf(evidence) || evidence.kind !== 'codex-thread-api' || typeof evidence.method !== 'string'
                    || !['thread/start', 'thread/resume'].includes(evidence.method)
                    || evidence.nativeStore !== nativeStore || evidence.nativeId !== nativeId || !isDeepStrictEqual(evidence.process, value.process)) {
                    throw new Error('Managed Codex native API evidence does not match its owned publication');
                }
            }
            else {
                throw new Error('Managed Codex requires current-version owned thread API evidence; transcript-only legacy adoption is unsupported');
            }
        }
        else if (grant.nativeBinding.kind === 'claude') {
            const evidence = record.nativeAdmissionEvidence, command = record.nativeCommand, provenance = record.nativeLaunchProvenance;
            if (!recordOf(provenance) || provenance.state !== 'candidate' || provenance.nativeStore !== nativeStore
                || !recordOf(evidence) || evidence.kind !== 'native-session-start' || evidence.source !== 'startup'
                || evidence.nativeStore !== nativeStore || evidence.nativeId !== nativeId || !isDeepStrictEqual(evidence.process, process)
                || !recordOf(command) || command.nativeStore !== nativeStore || !recordOf(command.executable)
                || typeof command.executable.file !== 'string' || typeof command.executable.version !== 'string'
                || !path.isAbsolute(command.executable.file) || realpathSync(command.executable.file) !== command.executable.file
                || !isDeepStrictEqual(evidence.executable, command.executable)
                || !sameRecordVersion(command.executable)
                || !Array.isArray(command.argv) || !command.argv.every(value => typeof value === 'string' && !value.includes('\0'))
                || command.argv[0] !== '--bg' || command.argv.slice(0, -1).some(value => /^--(?:resume|continue|fork-session|init-only|remote|attach)(?:=|$)/.test(value))
                || typeof evidence.transcript !== 'string'
                || !path.isAbsolute(evidence.transcript) || !contained(nativeStore, evidence.transcript)
                || path.basename(evidence.transcript) !== `${nativeId}.jsonl`
                || (observeCurrentProcess && await processExecutable(process) !== command.executable.file)) {
                throw new Error('Managed Claude requires its actual startup/owned command/store/process publication');
            }
        }
        else if (grant.nativeBinding.kind === 'cursor') {
            const evidence = record.nativeAdmissionEvidence, command = record.nativeCommand, creator = record.nativeCreationEvidence;
            const start = record.nativeStartEvidence;
            if (!recordOf(command) || !recordOf(command.executable) || typeof command.executable.file !== 'string' || typeof command.executable.version !== 'string'
                || !recordOf(command.launcher) || typeof command.launcher.file !== 'string' || typeof command.launcher.version !== 'string'
                || !recordOf(command.bundle) || typeof command.bundle.file !== 'string' || typeof command.bundle.version !== 'string'
                || !sameRecordVersion(command.executable)
                || !sameRecordVersion(command.launcher) || !sameRecordVersion(command.bundle)
                || !recordOf(command.nativeEnvironment) || typeof command.nativeEnvironment.CURSOR_CONFIG_DIR !== 'string'
                || !path.isAbsolute(command.nativeEnvironment.CURSOR_CONFIG_DIR) || typeof command.cwd !== 'string' || !path.isAbsolute(command.cwd)
                || !Array.isArray(command.argv) || command.argv[0] !== 'persist' || command.argv[1] !== '--resume' || command.argv[2] !== nativeId
                || !recordOf(creator) || creator.kind !== 'cursor-create-chat' || creator.nativeId !== nativeId || creator.exitCode !== 0
                || creator.cwd !== command.cwd || !isDeepStrictEqual(creator.launcher, command.launcher)
                || !recordOf(start) || start.harness !== 'cursor' || start.nativeId !== nativeId || !isDeepStrictEqual(start.process, process)
                || !recordOf(evidence) || evidence.kind !== 'cursor-create-chat' || evidence.method !== 'create-chat' || evidence.source !== 'sessionStart'
                || evidence.nativeStore !== nativeStore || evidence.nativeId !== nativeId || !isDeepStrictEqual(evidence.process, process)
                || !isDeepStrictEqual(evidence.executable, command.executable) || !isDeepStrictEqual(evidence.launcher, command.launcher)
                || !isDeepStrictEqual(evidence.bundle, command.bundle) || record.nativeCreationPending !== undefined) {
                throw new Error('Managed Cursor requires its actual owned creator, native hook and current runtime generation');
            }
            const expected = path.join(command.nativeEnvironment.CURSOR_CONFIG_DIR, 'chats', createHash('md5').update(path.resolve(command.cwd)).digest('hex'), nativeId, 'store.db');
            if (nativeStore !== expected || realpathSync(expected) !== expected)
                throw new Error('Managed Cursor database does not match its actual native storage selection');
            let file = command.nativeEnvironment.CURSOR_CONFIG_DIR;
            for (const part of path.relative(file, expected).split(path.sep)) {
                file = path.join(file, part);
                const entry = lstatSync(file);
                if (entry.isSymbolicLink() || (globalThis.process.getuid && entry.uid !== globalThis.process.getuid()) || (entry.mode & 0o022) !== 0) {
                    throw new Error('Managed Cursor database path is not owned durable native state');
                }
            }
            if (!lstatSync(expected).isFile())
                throw new Error('Managed Cursor database is not a regular file');
            const fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const header = Buffer.alloc(16);
                if (readSync(fd, header, 0, 16, 0) !== 16 || header.toString('binary') !== 'SQLite format 3\0')
                    throw new Error('Managed Cursor database has no initialized SQLite storage');
            }
            finally {
                closeSync(fd);
            }
            if (observeCurrentProcess) {
                if (await processExecutable(process) !== command.executable.file) {
                    throw new Error('Managed Cursor native process does not currently hold its durable database [stage: process executable]');
                }
                if (!await processHasOpenFile(process, expected)) {
                    throw new Error('Managed Cursor native process does not currently hold its durable database [stage: open database]');
                }
            }
        }
        else if (grant.nativeBinding.kind === 'opencode') {
            const evidence = record.nativeAdmissionEvidence, command = record.nativeCommand;
            const holder = processRecord(record.holderProcess);
            const database = lstatSync(nativeStore);
            if (!holder || !isDeepStrictEqual(holder, process) || record.holderPid !== holder.pid || typeof record.url !== 'string'
                || !recordOf(evidence) || evidence.kind !== 'opencode-session-api' || evidence.method !== 'session/create'
                || evidence.nativeStore !== nativeStore || evidence.nativeId !== nativeId || !isDeepStrictEqual(evidence.process, process)
                || evidence.endpoint !== record.url || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(record.url)
                || !recordOf(command) || !recordOf(command.executable) || typeof command.executable.file !== 'string'
                || typeof command.executable.version !== 'string' || !isDeepStrictEqual(evidence.executable, command.executable)
                || !sameRecordVersion(command.executable)
                || !isDeepStrictEqual(command.argv, ['serve', '--port', '0', '--hostname', '127.0.0.1'])
                || !recordOf(command.nativeEnvironment) || command.nativeEnvironment.OPENCODE_DB !== nativeStore || command.nativeEnvironment.OPENCODE_SIMULATE
                || typeof command.nativeEnvironment.XDG_DATA_HOME !== 'string' || !path.isAbsolute(command.nativeEnvironment.XDG_DATA_HOME)
                || !database.isFile() || database.isSymbolicLink() || (globalThis.process.getuid && database.uid !== globalThis.process.getuid())
                || (database.mode & 0o022) !== 0 || database.size === 0 || record.nativeCreationPending !== undefined
                || (observeCurrentProcess && await processExecutable(process) !== command.executable.file)) {
                throw new Error('Managed OpenCode requires its own configured database/serve process and correlated create response');
            }
        }
    }
    let primaryVersion = null;
    if (record.nativeAdmissionSource !== undefined) {
        const source = record.nativeAdmissionSource;
        if (!recordOf(source) || typeof source.record !== 'string' || !path.isAbsolute(source.record)
            || source.record === proof.record || typeof source.version !== 'string' || !source.version
            || source.launchId !== proof.launchId || source.nativeId !== nativeId || !record.nativeAdmission)
            throw new Error('Managed alias native source is incomplete');
        primaryVersion = recordVersion(source.record);
        const primary = readPrivate(source.record);
        if (!recordOf(primary) || primary.launchId !== proof.launchId || primary.ref !== proof.ref || primary.home !== record.home
            || primary.threadId !== nativeId || primary.codexHome !== record.codexHome
            || !isDeepStrictEqual(primary.nativeAdmission, record.nativeAdmission)
            || !isDeepStrictEqual(primary.nativeAdmissionEvidence, record.nativeAdmissionEvidence)
            || !isDeepStrictEqual(primary.appProcess, record.appProcess) || !isDeepStrictEqual(primary.holderProcess, record.holderProcess)) {
            throw new Error('Managed alias no longer names its immutable primary native generation');
        }
        if (typeof primary.task !== 'string' || typeof primary.address !== 'string')
            throw new Error('Managed alias primary owner scope is unavailable');
        const participant = participantOf(readTask(paths.home, primary.task), primary.address);
        if (participant?.metadata?.sessionRecord !== source.record || participant.metadata.sessionId !== nativeId)
            throw new Error('Managed alias primary participant no longer owns its native source');
    }
    if (!sameRecordVersion(version) || (primaryVersion && !sameRecordVersion(primaryVersion)))
        throw new Error('Managed native source changed during proof observation');
    return { version, record, primaryVersion, binding: { harness: grant.nativeBinding.kind, nativeStore, nativeId,
            source: 'managed', runtime: grant.runtime, ownerKey: proof.launchId, process, nonce: proof.launchId } };
}
export async function requireManagedNativeBinding(paths, grant, context) {
    if (grant.lifetime.kind !== 'managed' || grant.nativeBinding?.state !== 'bound')
        return;
    const id = grant.nativeBinding.kind === 'codex' ? grant.nativeBinding.threadId : grant.nativeBinding.sessionId;
    const publication = await managedPublication(paths, grant, id);
    const current = ledgerOf(paths).bindings.find(value => value.harness === publication.binding.harness && value.nativeId === id
        && (value.nativeStore === null || value.nativeStore === publication.binding.nativeStore));
    if (!current || (sameGeneration(current, publication.binding) && (current.nativeStore === null || current.process === null))) {
        await reserveManagedNativeIdentity(paths, grant, id, context);
    }
    requireCurrentNativeBinding(paths, publication.binding);
}
async function managedTransition(paths, grant, record, binding, ledger) {
    const value = record.nativeAdmissionTransition;
    if (value === undefined)
        return null;
    if (binding.nativeStore === null || binding.process === null)
        throw new Error('Managed resume requires the current actual native store and captured process before transition');
    const index = ledger.bindings.findIndex(candidate => candidate.harness === binding.harness && candidate.nativeId === binding.nativeId
        && (candidate.nativeStore === null || candidate.nativeStore === binding.nativeStore));
    const current = ledger.bindings[index];
    if (current && sameGeneration(current, binding))
        return null;
    if (grant.lifetime.kind !== 'managed' || !recordOf(value) || value.kind !== 'managed-root-resume'
        || value.record !== grant.lifetime.record || typeof value.previousLaunchId !== 'string' || !value.previousLaunchId
        || value.previousLaunchId === binding.ownerKey || !recordOf(value.previousRecord) || !recordOf(value.launcherReservation)) {
        throw new Error('Managed resume transition is missing its exact prior owner packet');
    }
    const previous = value.previousRecord, reservation = value.launcherReservation;
    if (typeof previous.version !== 'string' || !previous.version || previous.ref !== grant.lifetime.ref
        || previous.home !== paths.home || previous.task !== grant.lifetime.task || previous.address !== grant.lifetime.address
        || previous.nativeId !== binding.nativeId || previous.nativeStore !== binding.nativeStore || previous.cwd !== record.cwd
        || !Number.isSafeInteger(reservation.current) || Number(reservation.current) <= 0
        || (reservation.previous !== null && (!Number.isSafeInteger(reservation.previous) || Number(reservation.previous) <= 0))) {
        throw new Error('Managed resume cannot change the exact previous scope, history store or owner reservation');
    }
    const owner = participantOf(readTask(paths.home, grant.lifetime.task), grant.lifetime.address);
    if (owner?.metadata?.launcherPid !== reservation.current)
        throw new Error('Managed resume no longer owns its current launcher reservation');
    const actualPrevious = value.previous;
    const expected = current?.ownerKey === value.previousLaunchId ? current : current?.previousManaged?.ownerKey === value.previousLaunchId
        ? { ...current, ownerKey: current.previousManaged.ownerKey, nonce: current.previousManaged.ownerKey,
            nativeStore: current.previousManaged.nativeStore, process: current.previousManaged.process } : null;
    if (current && (!expected || current.source !== 'managed' || current.runtime !== binding.runtime))
        throw new Error('Managed resume does not name the current owner generation or its recorded rollback predecessor');
    if (current && expected !== current) {
        const priorContext = current.previousManaged?.record;
        const sameRestoredContext = priorContext && ['ref', 'home', 'task', 'address', 'nativeId', 'nativeStore', 'cwd']
            .every(key => isDeepStrictEqual(priorContext[key], previous[key]));
        if (!sameRestoredContext || !current.process
            || await processStateAsync(current.process) !== 'dead')
            throw new Error('Managed rollback reconciliation requires the exact predecessor and positive death of the failed next generation');
    }
    if (!current || !expected || !recordOf(actualPrevious) || actualPrevious.harness !== binding.harness
        || actualPrevious.nativeId !== binding.nativeId || actualPrevious.nativeStore !== binding.nativeStore
        || !processRecord(actualPrevious.process) || value.legacyDeath !== undefined) {
        throw new Error('Managed resume requires its known current-version native tuple; birthless legacy adoption is unsupported');
    }
    const priorProcess = processRecord(actualPrevious.process);
    if (expected.nativeStore !== binding.nativeStore || !isDeepStrictEqual(expected.process, priorProcess)) {
        throw new Error('Managed resume previous captured process differs from the durable ledger');
    }
    if (await processStateAsync(priorProcess) !== 'dead')
        throw new Error('Managed resume requires positive death of the previous native process birth');
    return { index, replaced: { ownerKey: value.previousLaunchId, nativeStore: binding.nativeStore },
        binding: { ...binding, previousNonce: value.previousLaunchId,
            previousManaged: { ownerKey: value.previousLaunchId, nativeStore: expected?.nativeStore ?? binding.nativeStore,
                process: priorProcess, record: previous } } };
}
export async function reserveManagedNativeIdentity(paths, grant, nativeId, context) {
    if (grant.lifetime.kind !== 'managed' || !grant.nativeBinding)
        return;
    const publication = await managedPublication(paths, grant, nativeId);
    const lock = path.join(paths.directory, 'root-admission.lock'), deadline = Date.now() + 5000;
    let release = await acquireServiceLock(lock);
    while (!release) {
        if (Date.now() >= deadline)
            throw new Error('Native managed identity is being reserved by another owner operation');
        await new Promise(resolve => setTimeout(resolve, 20));
        release = await acquireServiceLock(lock);
    }
    try {
        if (publication.binding.process && await processStateAsync(publication.binding.process) !== 'alive') {
            throw new Error('Managed native process changed while waiting for its admission lock');
        }
        if (publication.binding.harness === 'cursor' && publication.binding.process && publication.binding.nativeStore
            && !await processHasOpenFile(publication.binding.process, publication.binding.nativeStore)) {
            throw new Error('Cursor durable native file proof changed while waiting for admission');
        }
        const ledger = ledgerOf(paths);
        const known = ledger.bindings.some(value => value.harness === publication.binding.harness
            && value.nativeId === nativeId && value.nativeStore === publication.binding.nativeStore);
        const evidence = publication.record.nativeAdmissionEvidence;
        const freshCodex = publication.binding.harness === 'codex' && publication.record.nativeAdmissionSchema === 1
            && recordOf(evidence) && evidence.kind === 'codex-thread-api' && evidence.method === 'thread/start';
        const freshClaude = publication.binding.harness === 'claude' && publication.binding.nativeStore !== null
            && publication.binding.process !== null && recordOf(evidence)
            && evidence.kind === 'native-session-start' && evidence.source === 'startup';
        const freshOpenCode = publication.binding.harness === 'opencode' && publication.binding.nativeStore !== null
            && publication.binding.process !== null && recordOf(evidence) && evidence.kind === 'opencode-session-api' && evidence.method === 'session/create';
        const freshCursor = publication.binding.harness === 'cursor' && publication.binding.nativeStore !== null
            && publication.binding.process !== null && recordOf(evidence) && evidence.kind === 'cursor-create-chat' && evidence.method === 'create-chat';
        if (!known && !freshCodex && !freshClaude && !freshOpenCode && !freshCursor) {
            throw new Error('First native admission requires verified fresh creation on its owned native API; native hook identity or an unknown resume ID is insufficient');
        }
        const transition = await managedTransition(paths, grant, publication.record, publication.binding, ledger);
        const validatePublication = () => {
            if (!sameRecordVersion(publication.version) || (publication.primaryVersion && !sameRecordVersion(publication.primaryVersion))
                || !isDeepStrictEqual(ledgerOf(paths), ledger))
                throw new Error('Managed native launch or admission registry changed during observation');
        };
        if (transition) {
            await availableRecords(paths, publication.binding, context, transition.replaced);
            validatePublication();
            if (transition.index < 0)
                ledger.bindings.push(transition.binding);
            else
                ledger.bindings[transition.index] = transition.binding;
            writeLedger(paths, ledger);
        }
        else
            await recordNativeBinding(paths, publication.binding, context, validatePublication);
    }
    finally {
        release();
    }
}

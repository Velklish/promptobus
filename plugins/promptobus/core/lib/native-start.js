import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isSupportedPosixShell, observeRootProcess, processExecutable, processParent } from './root-process.js';
import { contained, readPrivate, recordOf, recordVersion, sameRecordVersion } from './service-state.js';
import { bindManagedNativeStart } from './drivers.js';
import { CLIENT_FILE, readManagedServiceHookContext, realizeManagedServiceClient } from './service-launch.js';
export async function authorizeManagedNativeStart(host, event, env, cwd) {
    const file = env[CLIENT_FILE];
    if (!file || (event.hook_event_name !== 'SessionStart' && event.hook_event_name !== 'sessionStart'))
        return false;
    const context = readManagedServiceHookContext(host, file, { env, cwd });
    const startEvent = context.harness === 'cursor' ? 'sessionStart' : 'SessionStart';
    if (event.hook_event_name !== startEvent)
        return false;
    const nativeId = event[context.harness === 'cursor' ? 'conversation_id' : 'session_id'];
    if (typeof nativeId !== 'string' || !/^\S+$/u.test(nativeId))
        throw new Error('Native start requires the actual hook session identity');
    let { published } = bindManagedNativeStart({ ...context, nativeId, transcript: event.transcript_path });
    let nativeProof;
    if (context.harness === 'claude' && event.source === 'startup') {
        const version = recordVersion(context.record), record = readPrivate(context.record);
        const command = recordOf(record) && recordOf(record.nativeCommand) ? record.nativeCommand : null;
        const provenance = recordOf(record) && recordOf(record.nativeLaunchProvenance) ? record.nativeLaunchProvenance : null;
        if (!command || !provenance || provenance.state !== 'candidate' || provenance.nativeStore !== command.nativeStore
            || !recordOf(command.executable) || typeof command.executable.file !== 'string'
            || typeof command.executable.version !== 'string' || !path.isAbsolute(command.executable.file)
            || realpathSync(command.executable.file) !== command.executable.file || !sameRecordVersion(command.executable)
            || !Array.isArray(command.argv) || !command.argv.every(value => typeof value === 'string' && !value.includes('\0'))
            || command.argv[0] !== '--bg' || command.argv.slice(0, -1).some(value => /^--(?:resume|continue|fork-session|init-only|remote|attach)(?:=|$)/.test(value))
            || typeof command.nativeStore !== 'string'
            || !path.isAbsolute(command.nativeStore) || realpathSync(command.nativeStore) !== command.nativeStore
            || typeof event.transcript_path !== 'string' || !path.isAbsolute(event.transcript_path)
            || !contained(command.nativeStore, event.transcript_path) || path.basename(event.transcript_path) !== `${nativeId}.jsonl`) {
            throw new Error('Claude startup lacks its exact owned command and same-ID native transcript/store');
        }
        let transcript = command.nativeStore;
        for (const part of path.relative(command.nativeStore, event.transcript_path).split(path.sep)) {
            transcript = path.join(transcript, part);
            const entry = lstatSync(transcript);
            if (entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o022) !== 0)
                throw new Error('Claude native transcript path is not owned');
        }
        if (!lstatSync(transcript).isFile() || realpathSync(transcript) !== transcript)
            throw new Error('Claude native transcript is not a regular file');
        let nativeProcess = await observeRootProcess(process.ppid);
        if (nativeProcess && await isSupportedPosixShell(nativeProcess)) {
            const parent = await processParent(nativeProcess.pid);
            nativeProcess = parent ? await observeRootProcess(parent) : null;
        }
        if (!nativeProcess || await processExecutable(nativeProcess) !== command.executable.file || !sameRecordVersion(version)) {
            throw new Error('Claude startup has no exact owned native process/image generation');
        }
        const executable = { file: command.executable.file, version: command.executable.version };
        nativeProof = { version, binding: { harness: 'claude', nativeStore: command.nativeStore, nativeId, process: nativeProcess },
            evidence: { kind: 'native-session-start', source: 'startup', nativeStore: command.nativeStore, nativeId,
                process: nativeProcess, transcript, executable } };
    }
    if (nativeProof)
        ({ published } = bindManagedNativeStart({ ...context, nativeId, transcript: event.transcript_path, nativeProof }));
    if (context.harness === 'cursor') {
        const version = recordVersion(context.record), record = readPrivate(context.record);
        const command = recordOf(record) && recordOf(record.nativeCommand) ? record.nativeCommand : null;
        if (!command || !recordOf(command.executable) || typeof command.executable.file !== 'string' || typeof command.executable.version !== 'string'
            || !recordOf(command.launcher) || typeof command.launcher.file !== 'string' || typeof command.launcher.version !== 'string'
            || !recordOf(command.bundle) || typeof command.bundle.file !== 'string' || typeof command.bundle.version !== 'string'
            || !sameRecordVersion(command.executable)
            || !sameRecordVersion(command.launcher)
            || !sameRecordVersion(command.bundle))
            throw new Error('Cursor hook has no current approved native image chain');
        let nativeProcess = await observeRootProcess(process.ppid);
        if (nativeProcess && await isSupportedPosixShell(nativeProcess)) {
            const parent = await processParent(nativeProcess.pid);
            nativeProcess = parent ? await observeRootProcess(parent) : null;
        }
        if (!nativeProcess || await processExecutable(nativeProcess) !== command.executable.file || !sameRecordVersion(version)) {
            throw new Error('Cursor hook is not the actual current native runtime process');
        }
        ({ published } = bindManagedNativeStart({ ...context, nativeId, nativeProcessEvidence: { version, process: nativeProcess,
                executable: { file: command.executable.file, version: command.executable.version } } }));
        const current = readPrivate(context.record);
        if (!recordOf(current) || !recordOf(current.nativeAdmission))
            return false;
    }
    if (!published)
        return false;
    await realizeManagedServiceClient(host, file, nativeId, { env, cwd });
    return true;
}

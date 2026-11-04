import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { shellQuote } from '../dist/fs/shell.js';
import { actorIdentityVariables } from './drivers.js';
import { writeRootExecPlan } from './launch-exec.js';
import { readCodexRootTranscript } from './root-native.js';
import { readRootAdmissionState } from './root-admission.js';
import { initializeNativeAdmissionState, requireNativeAdmissionState } from './native-admission.js';
import { isSupportedPosixShell, observeRootProcess, processExecutable, processParent, requireNativeHookAncestor } from './root-process.js';
import { ensureWorkspaceService, realizeServiceClient, registerServiceClient, revokeServiceClient, serviceControl } from './service-client.js';
import { createOwnerEnvironment, readOwnerEnvironment } from './service-launch.js';
import { acquireServiceLock, prepareServicePaths, processStateAsync, readPrivate, recordOf, recordVersion, sameRecordVersion, runtimeIdentity, servicePaths, writePrivate } from './service-state.js';
import { claudeStartupTranscript, codexStandaloneNewExec, pendingStandaloneExpired, readStandaloneLaunch, readStandaloneProfile, requireStandaloneRoot, scopedRootProfile, standaloneProfileFile, standaloneReference } from './standalone-root-state.js';
export const ROOT_LAUNCH_FILE = 'PROMPTOBUS_ROOT_LAUNCH_FILE';
const PENDING_MS = 120_000;
export function standaloneResumeId(harness, args) {
    const uuid = (value) => value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) ? value : null;
    const beforePrompt = args.indexOf('--') < 0 ? args : args.slice(0, args.indexOf('--'));
    if (harness === 'codex') {
        const native = beforePrompt[0] === '--no-daemon' ? beforePrompt.slice(1) : beforePrompt;
        return native[0] === 'resume' ? uuid(native[1]) : native[0] === 'exec' && native[1] === 'resume' ? uuid(native[2]) : null;
    }
    if (beforePrompt.includes('--fork-session'))
        return null;
    return beforePrompt[0] === '--resume' || beforePrompt[0] === '-r' ? uuid(beforePrompt[1]) : null;
}
function ordinaryRoot(env) {
    if ((env.PROMPTOBUS_ROLE && env.PROMPTOBUS_ROLE !== 'orchestrator')
        || ['PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_OPENCODE_SESSION',
            'PROMPTOBUS_CLIENT_FILE', 'BB_THREAD_ID'].some(name => env[name]))
        throw new Error('Managed and BB sessions cannot borrow standalone root admission');
}
function rootEnvironment(env) {
    const own = { ...env };
    for (const name of [...actorIdentityVariables(), 'OPENCODE_SESSION_ID', 'PROMPTOBUS_TASK', 'PROMPTOBUS_ROLE',
        'PROMPTOBUS_ROOT_TASK', 'BB_THREAD_ID', 'BB_ENVIRONMENT_ID', 'BB_PROJECT_ID', 'BB_THREAD_STORAGE'])
        delete own[name];
    for (const name of Object.keys(own))
        if (name.startsWith('PROMPTOBUS_CLIENT_') || name.startsWith('PROMPTOBUS_ROOT_'))
            delete own[name];
    return own;
}
function directExecutable(file) {
    if (!path.isAbsolute(file))
        throw new Error('Standalone approval requires an absolute native executable');
    const canonical = realpathSync(file), entry = statSync(canonical);
    accessSync(canonical, constants.X_OK);
    if (!entry.isFile() || (entry.mode & 0o022) !== 0)
        throw new Error('Standalone executable must be regular and not writable by another account');
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const magic = Buffer.alloc(4), count = readSync(fd, magic, 0, 4, 0);
        if (count !== 4 || !['7f454c46', 'cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(magic.toString('hex'))) {
            throw new Error('This standalone route requires a direct native executable; an interpreter/script chain needs separate origin proof');
        }
    }
    finally {
        closeSync(fd);
    }
    return recordVersion(canonical);
}
export async function approveStandaloneRootProfile(host, input, env = process.env) {
    if (!['darwin', 'linux'].includes(process.platform))
        throw new Error('Standalone root requires an implemented POSIX kernel process observer');
    ordinaryRoot(env);
    if (!scopedRootProfile(input.id))
        throw new Error('Root profile requires a scoped ID');
    if (!['codex', 'claude'].includes(input.harness))
        throw new Error('Standalone root route has no implemented native executable and hook proof');
    if (!path.isAbsolute(input.nativeStore))
        throw new Error('Standalone root requires an absolute approved native account store');
    const nativeStore = realpathSync(input.nativeStore);
    if (!statSync(nativeStore).isDirectory())
        throw new Error('Standalone native account store must be a directory');
    const executable = directExecutable(input.executable), paths = servicePaths(host, env), runtime = runtimeIdentity(host);
    prepareServicePaths(paths);
    const file = standaloneProfileFile(paths, input.id), lock = path.join(paths.directory, 'root-admission.lock');
    const deadline = Date.now() + 5000;
    let release = await acquireServiceLock(lock);
    while (!release) {
        if (Date.now() >= deadline)
            throw new Error('Root profile approval is busy');
        await new Promise(resolve => setTimeout(resolve, 20));
        release = await acquireServiceLock(lock);
    }
    try {
        requireNativeAdmissionState(paths);
        const bb = readRootAdmissionState(paths);
        if (bb !== null && (!recordOf(bb) || bb.root !== paths.root || bb.home !== paths.home || !Array.isArray(bb.profiles))) {
            throw new Error('Available root profile registry is corrupt or belongs to another owner');
        }
        if (recordOf(bb) && bb.profiles.some(value => recordOf(value) && value.id === input.id)) {
            throw new Error('Root profile ID is already reserved for BB admission');
        }
        initializeNativeAdmissionState(paths);
        const prior = readPrivate(file);
        if (prior === null) {
            try {
                lstatSync(file);
                throw new Error('Existing standalone root profile is corrupt, not absent');
            }
            catch (error) {
                if (!recordOf(error) || error.code !== 'ENOENT')
                    throw error;
            }
            writePrivate(file, { schemaVersion: 1, mode: 'standalone', id: input.id, harness: input.harness,
                root: paths.root, home: paths.home, runtime, nativeStore, executable,
                ownerEnvironment: createOwnerEnvironment(host, env) });
        }
        const approved = readStandaloneProfile(paths, runtime, input.id);
        if (approved.harness !== input.harness || approved.nativeStore !== nativeStore || approved.executable.file !== executable.file
            || approved.executable.version !== executable.version)
            throw new Error('Root profile ID already describes another mode, harness, account or executable');
    }
    finally {
        release();
    }
    const profile = readStandaloneProfile(paths, runtime, input.id);
    if (profile.harness !== input.harness || profile.nativeStore !== nativeStore || profile.executable.file !== executable.file
        || profile.executable.version !== executable.version)
        throw new Error('Root profile ID already describes another mode, harness, account or executable');
    const snapshot = readOwnerEnvironment(host, profile.ownerEnvironment, { env });
    const discovery = await ensureWorkspaceService(host, { env: { ...snapshot, PROMPTOBUS_SERVICE_HOME: paths.base }, pollEnv: snapshot });
    const command = (args) => [host.nodePath(), ...args].map(shellQuote).join(' '), scope = ['--service-home', paths.base];
    const helper = command(host.busArgv(['service', 'headers', '--standalone', '--profile', input.id, ...scope]));
    return { mode: 'standalone', harness: profile.harness, profile: profile.id, busUrl: `${discovery.url}mcp/bus`, root: paths.root, home: paths.home,
        server: profile.harness === 'codex' ? { url: `${discovery.url}mcp/bus`, http_headers_helper: helper, required: true }
            : { type: 'http', url: `${discovery.url}mcp/bus`, headersHelper: helper },
        startHook: { type: 'command', command: command(host.guardArgv(['guard', '--standalone-profile', profile.id, ...scope])) },
        execPlanCommand: command(host.busArgv(['service', 'exec-plan', '--profile', profile.id, ...scope])) };
}
export async function standaloneRootExecPlan(host, id, command, { env = process.env, dryRun = false, launcherPid, cwd = process.cwd() } = {}) {
    ordinaryRoot(env);
    command = { file: command.file, args: [...command.args] };
    const paths = servicePaths(host, env), runtime = runtimeIdentity(host), profile = readStandaloneProfile(paths, runtime, id);
    requireNativeAdmissionState(paths);
    if (!path.isAbsolute(command.file) || realpathSync(command.file) !== profile.executable.file
        || [command.file, ...command.args].some(value => value.includes('\0')))
        throw new Error('Standalone exec command does not match its approved native CLI route');
    const beforePrompt = command.args.indexOf('--') < 0 ? command.args : command.args.slice(0, command.args.indexOf('--'));
    if (profile.harness === 'codex' && (beforePrompt.includes('--remote') || beforePrompt.some(arg => arg.startsWith('--remote='))
        || (!['exec', '--no-daemon'].includes(beforePrompt[0] ?? ''))
        || (beforePrompt[0] === '--no-daemon' && ['app-server', 'agents', 'mcp-server'].includes(beforePrompt[1] ?? '')))) {
        throw new Error('This standalone Codex profile requires explicit --no-daemon for TUI/resume or in-process exec; shared daemon and remote routes have no owned launch proof');
    }
    if (profile.harness === 'codex' && command.args[0] === 'exec' && !beforePrompt.some(arg => arg === 'resume' || arg === 'fork')
        && !codexStandaloneNewExec(command.args, realpathSync(cwd))) {
        throw new Error('This standalone Codex exec command is not a supported NEW form or resume selection; it would start an unbindable native session');
    }
    if (profile.harness === 'claude' && beforePrompt.some(arg => ['--bg', '--background', '--cloud'].includes(arg))) {
        throw new Error('This standalone Claude profile requires a process-owned foreground session; background/cloud native lifetime needs separate proof');
    }
    const snapshot = readOwnerEnvironment(host, profile.ownerEnvironment, { env });
    if (dryRun)
        return { mode: 'standalone', harness: profile.harness, profile: id, root: paths.root, home: paths.home,
            command, cwd, preflight: 'notRun', nativeAuthorization: 'notRun' };
    if (launcherPid !== process.ppid)
        throw new Error('Standalone preflight requires its actual direct POSIX launcher parent');
    const launcher = await observeRootProcess(launcherPid);
    if (!launcher)
        throw new Error('Standalone launcher birth identity is unavailable');
    if (!await isSupportedPosixShell(launcher))
        throw new Error('Standalone preflight must observe the unexecuted POSIX launcher');
    const options = { cwd, env: { ...snapshot, PROMPTOBUS_SERVICE_HOME: paths.base }, pollEnv: snapshot };
    await ensureWorkspaceService(host, options);
    for (const name of readdirSync(paths.directory)) {
        const match = /^standalone-launch-([a-f0-9-]{36})\.json$/.exec(name);
        if (!match)
            continue;
        const reference = { file: path.join(paths.directory, name), nonce: match[1] };
        let saved;
        try {
            saved = readStandaloneLaunch(paths, runtime, reference);
        }
        catch {
            continue;
        }
        const revision = recordVersion(reference.file);
        if (await processStateAsync(saved.process) !== 'dead' || !sameRecordVersion(revision))
            continue;
        if (saved.clientId && existsSync(path.join(paths.clients, `${saved.clientId}.json`)))
            await revokeServiceClient(host, saved.clientId, options);
        const current = readStandaloneLaunch(paths, runtime, reference);
        if (current.clientId !== saved.clientId || current.profile !== saved.profile || !isDeepStrictEqual(current.process, saved.process))
            continue;
        writePrivate(reference.file, { ...current, revoked: true });
        if (current.plan === path.join(paths.directory, `exec-${current.nonce}.sh`) && existsSync(current.plan))
            rmSync(current.plan);
    }
    const nonce = randomUUID(), file = path.join(paths.directory, `standalone-launch-${nonce}.json`);
    const reference = { file, nonce };
    const launch = { schemaVersion: 1, profile: id, root: paths.root, home: paths.home, runtime,
        process: launcher, cwd: realpathSync(cwd), nonce, expiresAt: Date.now() + PENDING_MS, clientId: null, nativeId: null, phase: 'pending', revoked: false,
        plan: path.join(paths.directory, `exec-${nonce}.sh`),
        resumeNativeId: standaloneResumeId(profile.harness, command.args),
        nativeCommand: { file: profile.executable.file, args: [...command.args] } };
    writePrivate(file, launch);
    let plan = null;
    try {
        await registerServiceClient(host, { cwd, env: { ...rootEnvironment(snapshot), PROMPTOBUS_HOME: paths.home }, pollEnv: snapshot,
            lifetime: { kind: 'process', process: launcher }, nativeBinding: { kind: profile.harness, state: 'pending' }, rootLaunch: reference }, options);
        const clean = rootEnvironment(env);
        const delta = Object.fromEntries(Object.keys(env)
            .filter(name => !(name in clean)).map(name => [name, null]));
        const defaultClaudeHome = profile.harness === 'claude' && !Object.hasOwn(snapshot, 'CLAUDE_CONFIG_DIR')
            && typeof snapshot.HOME === 'string' && path.isAbsolute(snapshot.HOME)
            && existsSync(path.join(snapshot.HOME, '.claude'))
            && realpathSync(path.join(snapshot.HOME, '.claude')) === profile.nativeStore;
        plan = writeRootExecPlan(paths.directory, { file: profile.executable.file, args: command.args, env: { ...delta,
                PROMPTOBUS_HOME: paths.home, PROMPTOBUS_SERVICE_HOME: paths.base, PROMPTOBUS_OWNER_ENV_FILE: profile.ownerEnvironment,
                [ROOT_LAUNCH_FILE]: file, ...(defaultClaudeHome ? { HOME: snapshot.HOME, CLAUDE_CONFIG_DIR: null }
                    : { [profile.harness === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: profile.nativeStore }) } }, nonce);
        return plan;
    }
    catch (error) {
        try {
            const current = readStandaloneLaunch(paths, runtime, reference);
            writePrivate(file, { ...current, revoked: true, ...(!plan && recordOf(error) && error.code === 'EEXIST' ? { plan: null } : {}) });
            if (plan)
                rmSync(plan, { force: true });
            if (current.clientId)
                await revokeServiceClient(host, current.clientId, options);
        }
        catch (revoke) {
            throw new AggregateError([error, revoke], 'Standalone preflight failed and owner revocation is unconfirmed');
        }
        throw error;
    }
}
function referenceOf(directory, env) {
    const file = env[ROOT_LAUNCH_FILE];
    if (!file)
        throw new Error('Standalone root requires its owned launcher reference; run the approved root launcher');
    const match = /^standalone-launch-([a-f0-9-]{36})\.json$/.exec(path.basename(file));
    if (path.dirname(file) !== directory || !match)
        throw new Error('Standalone root launch reference escaped its owner scope');
    return { file, nonce: match[1] };
}
async function currentRoot(host, id, env, resolved) {
    const paths = servicePaths(host, env), runtime = runtimeIdentity(host), reference = resolved ?? referenceOf(paths.directory, env);
    const launch = readStandaloneLaunch(paths, runtime, reference), profile = readStandaloneProfile(paths, runtime, id);
    if (launch.profile !== id || !launch.clientId)
        throw new Error('Standalone root has no matching registered preflight');
    await requireNativeHookAncestor(launch.process);
    const grant = readPrivate(path.join(paths.clients, `${launch.clientId}.json`));
    if (!recordOf(grant) || grant.id !== launch.clientId || !recordOf(grant.lifetime) || !recordOf(grant.nativeBinding)
        || grant.nativeBinding.kind !== profile.harness || typeof grant.nativeBinding.state !== 'string'
        || !['pending', 'bound'].includes(grant.nativeBinding.state)
        || typeof grant.token !== 'string' || !/^[a-f0-9]{64}$/.test(grant.token))
        throw new Error('Standalone root credential is absent or revoked');
    const typed = { id: launch.clientId, runtime, cwd: typeof grant.cwd === 'string' ? grant.cwd : '', rootLaunch: reference,
        lifetime: { kind: 'process', process: launch.process }, nativeBinding: { kind: profile.harness, state: grant.nativeBinding.state,
            threadId: typeof grant.nativeBinding.threadId === 'string' ? grant.nativeBinding.threadId : undefined,
            sessionId: typeof grant.nativeBinding.sessionId === 'string' ? grant.nativeBinding.sessionId : undefined } };
    if (!isDeepStrictEqual(grant.rootLaunch, reference) || grant.lifetime.kind !== 'process'
        || !recordOf(grant.lifetime.process) || grant.lifetime.process.pid !== launch.process.pid
        || grant.lifetime.process.birth !== launch.process.birth || grant.runtime !== runtime)
        throw new Error('Standalone credential generation changed');
    await requireStandaloneRoot(typed, paths);
    return { paths, runtime, reference, launch, profile, token: grant.token, nativeState: grant.nativeBinding.state };
}
async function headerNativeParent(profile) {
    const direct = await observeRootProcess(process.ppid);
    if (!direct)
        throw new Error('Standalone headers native parent identity is unavailable');
    if (await processExecutable(direct) === profile.executable.file)
        return { native: direct, shell: null };
    if (!await isSupportedPosixShell(direct))
        throw new Error('Standalone headers require their native parent or its observed POSIX command child');
    const pid = await processParent(direct.pid), native = pid ? await observeRootProcess(pid) : null;
    if (!native || await processExecutable(native) !== profile.executable.file
        || await processStateAsync(direct) !== 'alive' || await processParent(direct.pid) !== native.pid
        || await processStateAsync(native) !== 'alive')
        throw new Error('Standalone headers native command ancestry changed');
    return { native, shell: direct };
}
function headerReference(paths, runtime, id, native) {
    for (const directory of [paths.base, paths.directory, paths.clients]) {
        const entry = lstatSync(directory);
        if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory
            || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o077) !== 0) {
            throw new Error('Standalone headers require the owned private service directory');
        }
    }
    const matches = [];
    for (const name of readdirSync(paths.clients)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name))
            continue;
        const grant = readPrivate(path.join(paths.clients, name));
        if (!recordOf(grant) || !recordOf(grant.lifetime) || grant.lifetime.kind !== 'process'
            || !isDeepStrictEqual(grant.lifetime.process, native) || !grant.rootLaunch)
            continue;
        const reference = standaloneReference(grant.rootLaunch), launch = readStandaloneLaunch(paths, runtime, reference);
        if (launch.profile !== id)
            continue;
        if (grant.id !== name.slice(0, -5) || grant.id !== launch.clientId || grant.runtime !== runtime
            || !isDeepStrictEqual(launch.process, native) || grant.cwd !== launch.cwd || launch.cwd !== realpathSync(process.cwd())) {
            throw new Error('Standalone headers current credential does not match its owned native generation');
        }
        matches.push(reference);
    }
    if (matches.length !== 1)
        throw new Error('Standalone headers require exactly one current owned native launch');
    return matches[0];
}
export async function standaloneRootHeaders(host, id, env = process.env) {
    const paths = servicePaths(host, env), runtime = runtimeIdentity(host);
    if (!scopedRootProfile(id))
        throw new Error('Root profile requires a scoped ID');
    const profileRevision = recordVersion(standaloneProfileFile(paths, id)), profile = readStandaloneProfile(paths, runtime, id);
    const explicit = Object.hasOwn(env, ROOT_LAUNCH_FILE);
    const parent = explicit ? null : await headerNativeParent(profile);
    const reference = parent ? headerReference(paths, runtime, id, parent.native) : referenceOf(paths.directory, env);
    const launchRevision = recordVersion(reference.file), launch = readStandaloneLaunch(paths, runtime, reference);
    if (!launch.clientId || launch.profile !== id || launch.cwd !== realpathSync(process.cwd())
        || launch.nativeCommand?.file !== profile.executable.file)
        throw new Error('Standalone headers have no matching owned launch command');
    const revisions = [profileRevision, launchRevision, ...[path.join(paths.clients, `${launch.clientId}.json`),
            profile.ownerEnvironment, profile.executable.file].map(recordVersion)];
    const root = await currentRoot(host, id, env, reference);
    const snapshot = readOwnerEnvironment(host, root.profile.ownerEnvironment, { env });
    const options = { env: { ...snapshot, PROMPTOBUS_SERVICE_HOME: paths.base }, pollEnv: snapshot };
    await ensureWorkspaceService(host, options);
    const current = await currentRoot(host, id, env, reference);
    if (parent && !isDeepStrictEqual(await headerNativeParent(profile), parent))
        throw new Error('Standalone headers native parent changed during observation');
    await requireNativeHookAncestor(launch.process);
    if (!revisions.every(sameRecordVersion) || pendingStandaloneExpired(launch)
        || (parent && (process.ppid !== (parent.shell ?? parent.native).pid
            || !isDeepStrictEqual(headerReference(paths, runtime, id, parent.native), reference)))) {
        throw new Error('Standalone headers owned generation changed during observation');
    }
    return { Authorization: `Bearer ${current.token}` };
}
export async function preflightStandaloneRoot(host, id, nativeId, env = process.env) {
    ordinaryRoot(env);
    const paths = servicePaths(host, env), runtime = runtimeIdentity(host), profile = readStandaloneProfile(paths, runtime, id);
    const snapshot = readOwnerEnvironment(host, profile.ownerEnvironment, { env });
    await ensureWorkspaceService(host, { env: { ...snapshot, PROMPTOBUS_SERVICE_HOME: paths.base }, pollEnv: snapshot });
    return serviceControl(paths, { operation: 'standalone-preflight', runtime, profile: id, nativeId });
}
export async function authorizeStandaloneRootStart(host, id, event, env = process.env) {
    if (event.hook_event_name !== 'SessionStart')
        return;
    const paths = servicePaths(host, env), runtime = runtimeIdentity(host), reference = referenceOf(paths.directory, env);
    const initial = readStandaloneLaunch(paths, runtime, reference);
    if (initial.profile !== id || !initial.clientId)
        throw new Error('Standalone root has no matching registered preflight');
    readStandaloneProfile(paths, runtime, id);
    const lock = `${reference.file}.lock`, deadline = Date.now() + 5000;
    let release = await acquireServiceLock(lock);
    while (!release) {
        if (Date.now() >= deadline)
            throw new Error('Standalone native generation is already being realized; retry its exact hook');
        await new Promise(resolve => setTimeout(resolve, 20));
        release = await acquireServiceLock(lock);
    }
    try {
        const profileRevision = recordVersion(standaloneProfileFile(paths, id)), fencedProfile = readStandaloneProfile(paths, runtime, id);
        const fence = [profileRevision, recordVersion(fencedProfile.ownerEnvironment)];
        const root = await currentRoot(host, id, env), { profile } = root;
        const snapshot = readOwnerEnvironment(host, profile.ownerEnvironment, { env });
        const options = { env: { ...snapshot, PROMPTOBUS_SERVICE_HOME: paths.base }, pollEnv: snapshot };
        try {
            if (typeof event.session_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(event.session_id)) {
                throw new Error('Standalone start requires the actual native hook session identity');
            }
            let nativeStart, startupCandidate;
            if (profile.harness === 'codex') {
                if (typeof event.transcript_path !== 'string')
                    throw new Error('Standalone Codex requires its actual native transcript');
                const transcript = readCodexRootTranscript({ nativeStore: profile.nativeStore, transcript: event.transcript_path, nativeThreadId: event.session_id });
                if (transcript.source !== 'cli' && transcript.source !== 'exec')
                    throw new Error('Standalone Codex cannot admit an editor or BB native session');
                nativeStart = { source: transcript.source, transcript: transcript.transcript };
            }
            else if (event.source === 'startup') {
                if (typeof event.transcript_path !== 'string')
                    throw new Error('Standalone Claude startup requires its actual session transcript inside the approved account store');
                const file = claudeStartupTranscript(profile.nativeStore, event.session_id, event.transcript_path, true);
                if (file)
                    nativeStart = { source: 'startup', transcript: file };
                else
                    startupCandidate = { sessionId: event.session_id, transcript: event.transcript_path, capturedAt: Date.now(), revisions: [] };
            }
            const launch = readStandaloneLaunch(paths, runtime, reference);
            if ((launch.nativeId !== null && launch.nativeId !== event.session_id)
                || (launch.resumeNativeId !== null && launch.resumeNativeId !== event.session_id)
                || (launch.startupCandidate && (launch.startupCandidate.sessionId !== event.session_id
                    || launch.startupCandidate.transcript !== event.transcript_path))) {
                writePrivate(reference.file, { ...launch, identityInvalid: true });
                throw new Error('Standalone native generation cannot change its bound or explicitly resumed identity');
            }
            if (startupCandidate) {
                if (launch.phase !== 'pending' || launch.nativeId !== null || launch.resumeNativeId !== null || startupCandidate.capturedAt >= launch.expiresAt
                    || launch.nativeCommand?.file !== profile.executable.file || launch.nativeCommand.args.length !== 0) {
                    throw new Error('Only an approved fresh Claude startup may wait for its transcript publication');
                }
                if (!fence.every(sameRecordVersion) || !isDeepStrictEqual(profile, fencedProfile)) {
                    throw new Error('Standalone owner profile or environment changed during startup capture');
                }
                writePrivate(reference.file, { ...launch, startupCandidate: launch.startupCandidate ?? { ...startupCandidate, revisions: fence } });
                return;
            }
            writePrivate(reference.file, { ...launch, nativeId: event.session_id, ...(nativeStart ? { nativeStart } : {}) });
            await realizeServiceClient(host, launch.clientId, event.session_id, options);
        }
        catch (error) {
            try {
                const current = readStandaloneLaunch(paths, runtime, reference);
                if (current.clientId !== root.launch.clientId || !isDeepStrictEqual(current.process, root.launch.process))
                    throw new Error('Standalone revocation cannot identify the current owned native generation');
                writePrivate(reference.file, { ...current, revoked: true });
                await revokeServiceClient(host, root.launch.clientId, options);
            }
            catch (revoke) {
                throw new AggregateError([error, revoke], 'Standalone native realization failed and owner revocation is unconfirmed');
            }
            throw error;
        }
    }
    finally {
        release();
    }
}

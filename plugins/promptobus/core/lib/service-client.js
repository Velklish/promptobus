import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { acquireServiceLock, prepareServicePaths, processRecord, readDiscovery, readPrivate, recordOf, runtimeIdentity, sameProcess, servicePaths } from './service-state.js';
import { canonicalPath } from './store.js';
import { actorIdentityVariables } from './drivers.js';
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const OWNER_RECORD_ENV = ['PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_OPENCODE_SESSION'];
const OWNER_ACTOR_ENV = ['PROMPTOBUS_ROLE', 'PROMPTOBUS_TASK', 'PROMPTOBUS_ROOT_TASK',
    'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID',
    'BB_THREAD_ID', 'BB_ENVIRONMENT_ID', 'BB_PROJECT_ID', 'BB_THREAD_STORAGE',
    'AGENT_CLI_SOCKET_PATH', 'AGENT_CLI_LOG_PATH', 'CURSOR_AGENT_SOCKET', 'OPENCODE_SESSION_ID'];
const OWNER_OPERATIONAL_ENV = ['PROMPTOBUS_SERVICE_IDLE_MS', 'PROMPTOBUS_SERVICE_RESERVATION_MS',
    'PROMPTOBUS_EXEC_TRACE', 'PROMPTOBUS_WARDEN_TRACE', 'PROMPTOBUS_HOLDER_TRACE'];
function ownerStartupEnvironment(paths, env, common) {
    const role = env.PROMPTOBUS_ROLE?.trim();
    if (!common && ((role && role !== 'orchestrator') || OWNER_RECORD_ENV.some(name => env[name]?.trim()))) {
        throw new Error('Managed cold startup requires the common owner environment; run owner preflight with the root snapshot before launching or reconnecting this participant');
    }
    const startup = { ...(common ?? env) };
    for (const name of [...actorIdentityVariables(), ...OWNER_ACTOR_ENV])
        delete startup[name];
    for (const name of OWNER_OPERATIONAL_ENV)
        if (env[name] !== undefined)
            startup[name] = env[name];
    startup.PROMPTOBUS_HOME = paths.home;
    startup.PROMPTOBUS_SERVICE_HOME = paths.base;
    return startup;
}
export async function serviceControl(paths, input) {
    const owner = readPrivate(paths.owner);
    if (!recordOf(owner) || typeof owner.token !== 'string' || !/^[a-f0-9]{64}$/.test(owner.token))
        throw new Error('Shared service owner credential is invalid');
    const body = JSON.stringify(input);
    return new Promise((resolve, reject) => {
        const call = request({ socketPath: paths.controlSocket, path: '/control', method: 'POST', agent: false,
            headers: { host: 'promptobus.local', authorization: `Bearer ${owner.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                text += String(chunk);
                if (Buffer.byteLength(text) > 1024 * 1024)
                    call.destroy(new Error('Shared service control response exceeds its limit'));
            });
            response.on('error', reject);
            response.on('end', () => {
                let value;
                try {
                    value = JSON.parse(text);
                }
                catch {
                    reject(new Error('Shared service returned invalid control JSON'));
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(recordOf(value) && typeof value.error === 'string' ? value.error : `Shared service control refused: HTTP ${response.statusCode}`));
                    return;
                }
                resolve(value);
            });
        });
        call.setTimeout(5000, () => call.destroy(new Error('Shared service control request timed out')));
        call.on('error', reject);
        call.end(body);
    });
}
function statusOf(value, expected) {
    if (!recordOf(value) || value.runtime !== expected.runtime || value.root !== expected.root || value.home !== expected.home || value.url !== expected.url
        || !recordOf(value.process) || value.process.pid !== expected.process.pid || value.process.birth !== expected.process.birth
        || typeof value.clients !== 'number' || typeof value.reservations !== 'number' || typeof value.unknownClients !== 'number'
        || typeof value.unknownManaged !== 'number' || typeof value.sessions !== 'number')
        throw new Error('Shared service control identity did not match discovery');
    if (!recordOf(value.warden) || !Array.isArray(value.warden.tasks) || typeof value.warden.observations !== 'number')
        throw new Error('Invalid shared warden diagnostics');
    const tasks = [];
    for (const item of value.warden.tasks) {
        if (!recordOf(item) || typeof item.task !== 'string' || typeof item.pid !== 'number'
            || (item.state !== 'starting' && item.state !== 'running' && item.state !== 'stopping' && item.state !== 'legacy-busy'))
            throw new Error('Invalid shared warden diagnostics');
        tasks.push({ task: item.task, pid: item.pid, state: item.state });
    }
    return { ...expected, clients: value.clients, reservations: value.reservations, unknownClients: value.unknownClients,
        unknownManaged: value.unknownManaged, sessions: value.sessions, warden: { tasks, observations: value.warden.observations } };
}
function compatible(discovery, runtime) {
    if (discovery.runtime !== runtime)
        throw new Error('A different shared service runtime owns this workspace; close clients and restart it through the matching launcher');
}
export async function workspaceServiceStatus(host, { env = process.env } = {}) {
    const paths = servicePaths(host, env), discovery = readDiscovery(paths);
    if (!discovery || !sameProcess(discovery.process))
        return { running: false, discovery };
    compatible(discovery, runtimeIdentity(host));
    return { running: true, ...statusOf(await serviceControl(paths, { operation: 'status' }), discovery) };
}
export async function ensureWorkspaceService(host, { env = process.env, pollEnv } = {}) {
    const paths = servicePaths(host, env), runtime = runtimeIdentity(host);
    prepareServicePaths(paths);
    const ready = async () => {
        const discovery = readDiscovery(paths);
        if (!discovery || !sameProcess(discovery.process))
            return null;
        compatible(discovery, runtime);
        try {
            statusOf(await serviceControl(paths, { operation: 'status' }), discovery);
            return discovery;
        }
        catch (error) {
            if (!sameProcess(discovery.process))
                return null;
            throw error;
        }
    };
    const existing = await ready();
    if (existing)
        return existing;
    const deadline = Date.now() + 20_000;
    for (;;) {
        const release = await acquireServiceLock(paths.startup);
        if (!release) {
            const discovery = await ready();
            if (discovery)
                return discovery;
            if (Date.now() >= deadline)
                throw new Error('Shared service startup is still owned by another launcher; inspect service status');
            await wait(50);
            continue;
        }
        try {
            const discovery = await ready();
            if (discovery)
                return discovery;
            const startupEnv = ownerStartupEnvironment(paths, env, pollEnv);
            const logFile = path.join(paths.directory, 'startup-error.log');
            const fd = openSync(logFile, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
            let error = null;
            const child = spawn(host.nodePath(), host.busArgv(['service', 'run']), { cwd: paths.root, env: startupEnv, detached: true, stdio: ['ignore', 'ignore', fd] });
            closeSync(fd);
            child.once('error', failure => { error = failure; });
            child.unref();
            for (;;) {
                const current = await ready();
                if (current)
                    return current;
                if (error)
                    throw error;
                if (child.exitCode !== null || child.signalCode !== null) {
                    const owner = processRecord(readPrivate(path.join(paths.lock, 'owner.json')));
                    if (child.exitCode === 0 && owner && sameProcess(owner) && Date.now() < deadline) {
                        await wait(50);
                        continue;
                    }
                    const detail = readFileSync(logFile, 'utf8').slice(-2000).trim();
                    throw new Error(`Shared service exited before readiness (${child.exitCode ?? child.signalCode}); the consumer entry must route service run with createHost({cwd, env}): ${detail}`);
                }
                if (Date.now() >= deadline)
                    throw new Error('Shared service did not become ready; inspect its private startup-error.log and retained endpoint');
                await wait(50);
            }
        }
        finally {
            release();
        }
    }
}
export async function registerServiceClient(host, client, options = {}) {
    await ensureWorkspaceService(host, options);
    const value = await serviceControl(servicePaths(host, options.env), { operation: 'register', runtime: runtimeIdentity(host), client });
    if (!recordOf(value) || typeof value.clientId !== 'string' || typeof value.token !== 'string' || typeof value.credentialFile !== 'string'
        || typeof value.busUrl !== 'string' || (value.filesUrl !== null && typeof value.filesUrl !== 'string'))
        throw new Error('Shared service returned an invalid client credential');
    return { clientId: value.clientId, token: value.token, credentialFile: value.credentialFile, busUrl: value.busUrl, filesUrl: value.filesUrl };
}
export async function bindServiceClient(host, clientId, lifetime, options = {}) {
    return serviceControl(servicePaths(host, options.env), { operation: 'bind', runtime: runtimeIdentity(host), clientId, lifetime });
}
export async function realizeServiceClient(host, clientId, threadId, options = {}) {
    return serviceControl(servicePaths(host, options.env), { operation: 'realize', runtime: runtimeIdentity(host), clientId, threadId });
}
export async function revokeServiceClient(host, clientId, options = {}) {
    return serviceControl(servicePaths(host, options.env), { operation: 'revoke', runtime: runtimeIdentity(host), clientId });
}
export async function stopWorkspaceService(host, { env = process.env } = {}) {
    const status = await workspaceServiceStatus(host, { env });
    if (!status.running)
        return { stopped: false };
    await serviceControl(servicePaths(host, env), { operation: 'stop', runtime: runtimeIdentity(host) });
    const deadline = Date.now() + 5000;
    while (sameProcess(status.process)) {
        if (Date.now() >= deadline)
            throw new Error('Shared service shutdown was requested, but physical exit is not confirmed; inspect service status');
        await wait(25);
    }
    return { stopped: true };
}
export async function ensureTaskWarden(host, home, task, options = {}) {
    const paths = servicePaths(host, options.env);
    if (canonicalPath(home) !== paths.home)
        throw new Error('Task warden belongs to a different canonical store');
    const discovery = await ensureWorkspaceService(host, options);
    const value = await serviceControl(paths, { operation: 'warden-ensure', runtime: runtimeIdentity(host), task, pollEnv: options.pollEnv ?? options.env ?? process.env });
    if (!recordOf(value) || (value.state !== 'inactive' && value.state !== 'starting' && value.state !== 'running' && value.state !== 'stopping'))
        throw new Error('Invalid task warden demand response');
    return { pid: discovery.process.pid, state: value.state };
}
export async function abortTaskWarden(host, task, options = {}) {
    return serviceControl(servicePaths(host, options.env), { operation: 'warden-abort', runtime: runtimeIdentity(host), task,
        pollEnv: options.pollEnv ?? options.env ?? process.env });
}

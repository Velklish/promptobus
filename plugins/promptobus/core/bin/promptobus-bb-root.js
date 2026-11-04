#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { accessSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalPath } from '../lib/store.js';
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;
const usage = 'promptobus-bb-root --root <path> --profile <id> --native-store <path> --project <id> --environment <id> < prompt.md';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value) => Array.isArray(value);
function executable(name, env, override) {
    const candidates = [override, ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, name))];
    const found = candidates.find(file => {
        if (!file || !path.isAbsolute(file))
            return false;
        try {
            accessSync(file, constants.X_OK);
            return statSync(file).isFile();
        }
        catch {
            return false;
        }
    });
    if (!found)
        throw new Error(`The BB root invocation requires its configured ${name} CLI`);
    return realpathSync(found);
}
export function parseOptions(args) {
    const parsed = parseArgs({ args, strict: true, allowPositionals: false, tokens: true, options: {
            root: { type: 'string' }, profile: { type: 'string' }, 'native-store': { type: 'string' },
            project: { type: 'string' }, environment: { type: 'string' }, help: { type: 'boolean' },
        } });
    const seen = new Set();
    for (const token of parsed.tokens)
        if (token.kind === 'option') {
            if (seen.has(token.name))
                throw new Error(`Duplicate --${token.name}`);
            seen.add(token.name);
        }
    if (parsed.values.help)
        return { help: true };
    const required = (name) => {
        const value = parsed.values[name];
        if (!value || value !== value.trim() || value.includes('\0') || value.length > 4096)
            throw new Error(`Required --${name}`);
        return value;
    };
    const values = { root: required('root'), profile: required('profile'), 'native-store': required('native-store'),
        project: required('project'), environment: required('environment') };
    for (const name of ['profile', 'project', 'environment']) {
        const value = name === 'profile' ? values.profile : name === 'project' ? values.project : values.environment;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value))
            throw new Error(`Invalid --${name}`);
    }
    for (const [name, value] of [['root', values.root], ['native-store', values['native-store']]])
        if (!path.isAbsolute(value))
            throw new Error(`--${name} must be absolute`);
    return values;
}
export async function readPrompt(input) {
    const chunks = [];
    let size = 0;
    for await (const chunk of input) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BYTES)
            throw new Error('Root prompt exceeds 64 KiB');
        chunks.push(bytes);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (!text.trim() || text.includes('\0'))
        throw new Error('Root prompt must be nonempty UTF-8 text without NUL');
    return text;
}
export function readBb(args, { root, env }) {
    return new Promise((resolve, reject) => {
        const child = execFile(executable('bb', env, env.BB_CLI), args, { cwd: root, env, encoding: 'utf8',
            timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES, killSignal: 'SIGKILL', shell: false }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`BB ${args.slice(0, 2).join(' ')} failed: ${stderr.trim() || error.message}`, { cause: error }));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                if (!object(result) || result.ok === false)
                    throw new Error('BB returned no successful JSON object');
                resolve(result);
            }
            catch (cause) {
                reject(new Error('BB returned invalid root-operation JSON', { cause }));
            }
        });
        if (!child.stdin) {
            reject(new Error('BB root invocation has no prompt input pipe'));
            return;
        }
        child.stdin.once('error', reject);
        child.stdin.end();
    });
}
export async function requireEnvironment(scope, env) {
    const value = await readBb(['environment', 'show', scope.environment, '--json'], { root: scope.root, env });
    if (value.id !== scope.environment || value.projectId !== scope.project || typeof value.path !== 'string'
        || !path.isAbsolute(value.path) || realpathSync(value.path) !== scope.root) {
        throw new Error('BB environment does not name the approved canonical root and explicit project');
    }
}
const scalar = (value) => {
    if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value))
        throw new Error('Root configuration requires Unicode scalar strings');
    return value;
};
const quote = (value) => JSON.stringify(scalar(value)).replace(/\x7f/g, '\\u007f');
const marker = (profile) => `# Owned by promptobus-bb-root ${JSON.stringify({ profile: profile.profile, root: profile.root, home: profile.home })}\n`;
export function renderServer(profile) {
    if (!object(profile.server) || Object.keys(profile.server).sort().join() !== 'http_headers_helper,required,url'
        || profile.server.required !== true)
        throw new Error('Root requires the exact approved HTTP server descriptor');
    return `${marker(profile)}[mcp_servers.promptobus]\nurl = ${quote(profile.server.url)}\n`
        + `http_headers_helper = ${quote(profile.server.http_headers_helper)}\nrequired = true\n`;
}
export function parseServer(text, profile) {
    const prefix = `${marker(profile)}[mcp_servers.promptobus]\nurl = `;
    if (!text.startsWith(prefix) || !text.endsWith('\nrequired = true\n'))
        throw new Error('Codex project configuration is not owned by this root profile');
    const fields = text.slice(prefix.length, -'\nrequired = true\n'.length).split('\nhttp_headers_helper = ');
    if (fields.length !== 2)
        throw new Error('Codex root configuration changed');
    const url = JSON.parse(fields[0]), helper = JSON.parse(fields[1]);
    const server = { url: scalar(url), http_headers_helper: scalar(helper), required: true };
    if (renderServer({ ...profile, server }) !== text)
        throw new Error('Codex root configuration is not canonical');
    return server;
}
function hookHandlers(document, event) {
    const groups = object(document) && object(document.hooks) ? document.hooks[event] : undefined;
    const group = array(groups) ? groups[0] : undefined;
    return object(group) && array(group.hooks) ? group.hooks : undefined;
}
export function hookTrustStatus(result, profile, text) {
    const file = path.join(profile.root, '.codex', 'hooks.json'), document = JSON.parse(text);
    if (!object(result) || !array(result.data) || result.data.length !== 1)
        throw new Error('Codex returned incomplete hook status');
    const entry = result.data[0];
    if (!object(entry) || entry.cwd !== profile.root || !array(entry.hooks)
        || !array(entry.errors) || entry.errors.length || !array(entry.warnings) || entry.warnings.length) {
        throw new Error('Codex hook status does not establish the approved project without errors or warnings');
    }
    const expected = [['SessionStart', 'sessionStart', 'session_start'], ['Stop', 'stop', 'stop']];
    const hooks = entry.hooks.filter(object), own = hooks.filter(hook => hook.sourcePath === file), handlers = [];
    if (own.length !== expected.length)
        throw new Error('Codex did not expose both exact project handlers; verify native home, project trust and hooks feature');
    for (const [event, eventName, keyEvent] of expected) {
        const key = `${file}:${keyEvent}:0:0`, matches = hooks.filter(hook => hook.key === key);
        const handler = hookHandlers(document, event)?.[0], command = object(handler) ? handler.command : undefined;
        if (matches.length !== 1)
            throw new Error('Codex returned missing or duplicate owned hook identities');
        const hook = matches[0];
        if (typeof command !== 'string' || hook.sourcePath !== file || hook.command !== command || hook.eventName !== eventName || hook.handlerType !== 'command'
            || hook.source !== 'project' || hook.pluginId !== null || hook.isManaged !== false || hook.async !== false || hook.matcher !== null
            || hook.timeoutSec !== 600 || hook.statusMessage !== null || hook.additionalContextLimit !== null
            || typeof hook.displayOrder !== 'number' || !Number.isSafeInteger(hook.displayOrder) || hook.displayOrder < 0 || typeof hook.currentHash !== 'string'
            || !/^sha256:[a-f0-9]{64}$/.test(hook.currentHash) || typeof hook.enabled !== 'boolean' || typeof hook.trustStatus !== 'string') {
            throw new Error('Codex hook metadata differs from the exact owned declaration');
        }
        handlers.push({ key, eventName, command, currentHash: hook.currentHash, enabled: hook.enabled, trustStatus: hook.trustStatus,
            displayOrder: hook.displayOrder });
    }
    if (new Set(handlers.map(hook => hook.displayOrder)).size !== handlers.length)
        throw new Error('Codex hook discovery order is ambiguous');
    return { ready: handlers.every(hook => hook.enabled && hook.trustStatus === 'trusted'), handlers };
}
export async function inspectHookTrust(profile, nativeStore, env) {
    const { CodexRpc } = await import('../lib/codex-rpc.js');
    const { recordVersion, sameRecordVersion } = await import('../lib/service-state.js');
    const file = path.join(profile.root, '.codex/hooks.json'), before = recordVersion(file), text = readOwned(file);
    if (text === null || !sameRecordVersion(before))
        throw new Error('Owned hook bytes changed before native status');
    const verify = () => {
        if (!sameRecordVersion(before) || readOwned(file) !== text)
            throw new Error('Owned hook bytes changed during native approval status');
    };
    const bin = executable('codex', env), home = realpathSync(nativeStore), edge = Date.now() + TIMEOUT_MS;
    const child = spawn(bin, ['app-server'], { cwd: profile.root, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let transportError;
    child.once('error', error => { transportError = error; });
    child.stdin.on('error', error => { transportError = error; });
    const closed = new Promise(resolve => child.once('close', () => resolve()));
    const rpc = CodexRpc(child);
    let bytes = 0, overflow = false, unexpected = false;
    for (const stream of [child.stdout, child.stderr])
        stream.on('data', chunk => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_BYTES) {
                overflow = true;
                child.kill('SIGKILL');
            }
        });
    rpc.onServerRequest(() => { unexpected = true; return { __error: { code: -32601, message: 'Read-only hook status accepts no server request' } }; });
    const request = async (method, params) => {
        const answer = await Promise.race([rpc.request(method, params, Math.max(1, edge - Date.now())),
            closed.then(() => { throw new Error('Codex hook-status process exited before its reply'); })]);
        if (transportError || overflow || unexpected || !object(answer) || answer.error || !object(answer.result))
            throw new Error(`Codex ${method} did not provide read-only hook status`);
        return answer.result;
    };
    const waitClosed = async () => {
        let timer;
        try {
            return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
        }
        finally {
            clearTimeout(timer);
        }
    };
    try {
        await request('initialize', { clientInfo: { name: 'promptobus_bb_root', version: '1' }, capabilities: { experimentalApi: true } });
        rpc.notify('initialized', {});
        const result = await request('hooks/list', { cwds: [profile.root] });
        verify();
        return { ...hookTrustStatus(result, profile, text), verify, nativeStore: home, executable: bin };
    }
    finally {
        rpc.close();
        child.stdin.end();
        if (!await waitClosed()) {
            child.kill('SIGTERM');
            if (!await waitClosed()) {
                child.kill('SIGKILL');
                if (!await waitClosed())
                    throw new Error('Owned hook-status process exit is unconfirmed');
            }
        }
        if (transportError)
            throw new Error('Codex hook-status transport failed', { cause: transportError });
    }
}
function readOwned(file) {
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info)
        return null;
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > MAX_BYTES
        || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
        throw new Error(`Unsafe or unowned root configuration: ${file}`);
    return readFileSync(file, 'utf8');
}
function writeNew(file, text) {
    const descriptor = openSync(file, 'wx', 0o600);
    try {
        writeFileSync(descriptor, text);
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}
export async function prepareProject(host, profile, { create = false, update = false } = {}) {
    const { planHookInstall } = await import('../lib/integration.js');
    const { acquireServiceLock, recordVersion, sameRecordVersion } = await import('../lib/service-state.js');
    const { writeFileAtomic } = await import('../dist/fs/atomic.js');
    const root = realpathSync(host.workspaceRoot()), directory = path.join(root, '.codex');
    if (profile.root !== root || profile.home !== canonicalPath(host.promptobusHome()))
        throw new Error('Root descriptor changed its owner scope');
    let directoryInfo = lstatSync(directory, { throwIfNoEntry: false });
    if (!directoryInfo) {
        if (!create)
            return false;
        mkdirSync(directory, { mode: 0o700 });
        directoryInfo = lstatSync(directory);
    }
    const ownedDirectory = directoryInfo;
    const verifyDirectory = () => {
        const current = lstatSync(directory);
        if (!current.isDirectory() || current.dev !== ownedDirectory.dev || current.ino !== ownedDirectory.ino
            || realpathSync(directory) !== directory)
            throw new Error('Codex root configuration directory changed');
    };
    verifyDirectory();
    const release = await acquireServiceLock(path.join(directory, '.promptobus-bb-root.lock'));
    if (!release)
        throw new Error('Codex root configuration is already being prepared');
    try {
        verifyDirectory();
        const configFile = path.join(directory, 'config.toml'), hooksFile = path.join(directory, 'hooks.json');
        const configVersion = lstatSync(configFile, { throwIfNoEntry: false }) ? recordVersion(configFile) : null;
        const hooksVersion = lstatSync(hooksFile, { throwIfNoEntry: false }) ? recordVersion(hooksFile) : null;
        const previousConfig = readOwned(configFile), previousHooks = readOwned(hooksFile);
        if ((configVersion === null) !== (previousConfig === null) || (hooksVersion === null) !== (previousHooks === null)
            || (configVersion && !sameRecordVersion(configVersion)) || (hooksVersion && !sameRecordVersion(hooksVersion))) {
            throw new Error('Codex root configuration changed while being read');
        }
        if ((previousConfig === null) !== (previousHooks === null))
            throw new Error('Partial Codex root configuration remains unresolved; no root was started');
        if (previousConfig === null && !create)
            return false;
        const config = renderServer(profile);
        const parsed = parseServer(config, profile);
        if (parsed.url !== profile.server.url || parsed.http_headers_helper !== profile.server.http_headers_helper) {
            throw new Error('Codex server descriptor did not round-trip');
        }
        const planned = planHookInstall(host, root, ['codex'], { rootProfile: profile });
        const hooks = planned.writes.find(write => write.abs === hooksFile)?.text;
        if (typeof hooks !== 'string')
            throw new Error('Root hook planner returned no Codex hooks');
        const document = JSON.parse(hooks), events = object(document) ? document.hooks : undefined;
        const start = hookHandlers(document, 'SessionStart'), stop = hookHandlers(document, 'Stop'), first = start?.[0];
        if (!object(document) || Object.keys(document).join() !== 'hooks' || !object(events) || Object.keys(events).sort().join() !== 'SessionStart,Stop'
            || !array(events.SessionStart) || events.SessionStart.length !== 1 || start?.length !== 1
            || !object(first) || first.type !== 'command' || first.command !== profile.startHook.command
            || !array(events.Stop) || events.Stop.length !== 1 || stop?.length !== 1)
            throw new Error('Codex root hook plan contains unowned or unordered hooks');
        if (previousConfig !== null) {
            const previous = parseServer(previousConfig, profile), oldUrl = new URL(previous.url), nextUrl = new URL(profile.server.url);
            oldUrl.port = nextUrl.port;
            if (previous.http_headers_helper !== profile.server.http_headers_helper || oldUrl.href !== nextUrl.href || previousHooks !== hooks) {
                throw new Error('Existing Codex root configuration differs from this owned profile');
            }
            verifyDirectory();
            if (!configVersion || !hooksVersion || !sameRecordVersion(configVersion) || !sameRecordVersion(hooksVersion))
                throw new Error('Codex root configuration changed before publication');
            if (previousConfig !== config) {
                if (!update)
                    throw new Error('Codex root endpoint changed after its approved preparation');
                writeFileAtomic(configFile, config, { mode: 0o600 });
            }
        }
        else {
            verifyDirectory();
            writeNew(configFile, config);
            verifyDirectory();
            writeNew(hooksFile, hooks);
        }
        verifyDirectory();
        if (readOwned(configFile) !== config || readOwned(hooksFile) !== hooks)
            throw new Error('Codex root configuration write was not confirmed');
        const confirmedConfig = recordVersion(configFile), confirmedHooks = recordVersion(hooksFile);
        return () => {
            verifyDirectory();
            if (!sameRecordVersion(confirmedConfig) || !sameRecordVersion(confirmedHooks)
                || readOwned(configFile) !== config || readOwned(hooksFile) !== hooks)
                throw new Error('Confirmed Codex root configuration changed');
        };
    }
    finally {
        release();
    }
}
export async function runBbRoot(args, { env = process.env, input = process.stdin, output = process.stdout } = {}) {
    const options = parseOptions(args);
    if (options.help) {
        output.write(`${usage}\n`);
        return;
    }
    if (!['darwin', 'linux'].includes(process.platform))
        throw new Error('BB native roots require the supported macOS or Linux process observer');
    const root = realpathSync(options.root);
    const executionScope = Object.freeze({ project: options.project, environment: options.environment });
    const scope = Object.freeze({ root, ...executionScope });
    const profile = Object.freeze({ id: options.profile, nativeStore: options['native-store'], executionScope });
    await readPrompt(input);
    const { createStandaloneHost } = await import('../dist/host-index.js');
    const { approveCodexRootProfile } = await import('../lib/integration.js');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (!object(pkg) || typeof pkg.version !== 'string')
        throw new Error('Installed package has no version');
    const host = createStandaloneHost({ cwd: root, version: pkg.version, nodePath: process.execPath,
        binPath: fileURLToPath(new URL('./promptobus.js', import.meta.url)) });
    if (host.workspaceRoot() !== root)
        throw new Error('The explicit root must be the canonical standalone owner workspace');
    await requireEnvironment(scope, env);
    const prepared = await approveCodexRootProfile(host, profile, env);
    if (typeof prepared.execPlanCommand !== 'string')
        throw new Error('This installation lacks the coherent owner root-profile preparation implementation');
    await requireEnvironment(scope, env);
    const verifyPrepared = await prepareProject(host, prepared, { create: true, update: true });
    verifyPrepared();
    output.write(`${JSON.stringify({ profile: prepared.profile, root, ready: false,
        reason: 'provider-context-unavailable', creation: 'notAttempted' })}\n`);
    return 2;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const code = await runBbRoot(process.argv.slice(2));
        if (code)
            process.exitCode = code;
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

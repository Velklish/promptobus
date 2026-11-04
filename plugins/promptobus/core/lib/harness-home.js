// The harness session registry, and the refusal when nobody says.
// [reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says](../docs/reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says)
import { homedir } from 'node:os';
import path from 'node:path';
import { GateError } from '../dist/index.js';
import { isDeepStrictEqual } from 'node:util';
import { canonicalPath } from './store.js';
let bound = null;
/** Bind the host whose `harnessStateHome` answers here; the FIRST binding of a process
 * wins and a later one is ignored — why, in the reference named at the head of this file. */
export function bindHarnessHomes(host) {
    if (!host) {
        bound = null;
        return null;
    }
    if (bound)
        return bound;
    bound = typeof host.harnessStateHome === 'function' ? host : null;
    return bound;
}
/** The environment variable one harness's registry is named by. */
export function harnessHomeVar(harness) {
    return `PROMPTOBUS_${String(harness).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_HOME`;
}
/** The registry directory for `harness`; `GateError` when neither the environment nor a
 * bound host names one — a refusal rather than a default under the real home. */
export function harnessStateHome(harness, env = process.env) {
    const varName = harnessHomeVar(harness);
    const named = String(env[varName] ?? '').trim();
    if (named)
        return canonicalPath(named);
    const fromHost = bound?.harnessStateHome(harness) ?? null;
    if (fromHost)
        return canonicalPath(String(fromHost));
    throw new GateError(`no state home for harness ${harness}: set ${varName}, or answer`
        + ` harnessStateHome('${harness}') from the host. It is not guessed — a default under`
        + ` ${path.join(homedir(), '.promptobus', String(harness))} once had the registry writing to a`
        + ' real home while inspect read a sandbox, with no error anywhere.');
}
let boundBins = null;
/** Bind the host whose `resolveToolBin` names a harness binary for the calls made AFTER a lift —
 * the state query and the stop; the FIRST binding wins, as above. [05-drivers.md § The harness binary after a lift](../docs/reference/05-drivers.md#the-harness-binary-after-a-lift-the-lifts-door-not-path) */
export function bindHarnessBins(host) {
    if (!host) {
        boundBins = null;
        return null;
    }
    if (!boundBins && typeof host.resolveToolBin === 'function')
        boundBins = host;
    return boundBins;
}
/** `{ bin }` the way the lift resolves it, or `{ bin: null, reason }` naming what was looked for.
 * No host bound — the bare name and `PATH`, as before any host existed. */
export function harnessBin(tool) {
    const said = boundBins ? boundBins.resolveToolBin(tool) : { ok: true, bin: tool };
    if (said?.bin)
        return { bin: String(said.bin), reason: null };
    return { bin: null, reason: said?.reason ?? `the host named no binary for ${tool}` };
}
export const POLL_ENV_KEYS = [
    'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'CLAUDE_CONFIG_DIR',
    'PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC', 'SystemRoot', 'WINDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMUX_TMPDIR',
    'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];
const POLL_NATIVE_ENV = new Set(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']);
let boundPollEnvironment = null;
export function pollEnvironmentOf(env) {
    const result = {};
    for (const key of Object.keys(env).sort()) {
        if (POLL_NATIVE_ENV.has(key))
            continue;
        if (POLL_ENV_KEYS.some(allowed => allowed === key) || key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_')) {
            if (typeof env[key] === 'string')
                result[key] = env[key];
        }
    }
    return Object.freeze(result);
}
export function bindPollEnvironment(env) {
    const projected = pollEnvironmentOf(env);
    if (boundPollEnvironment && !isDeepStrictEqual(boundPollEnvironment, projected))
        throw new GateError('Shared service has a different common poll environment');
    return boundPollEnvironment ??= projected;
}
export function commonPollEnvironment() { return boundPollEnvironment ?? process.env; }
export function serviceHarnessContext(host, env, registry, pollEnv = env) {
    const homes = {}, bins = {};
    for (const harness of Object.keys(registry.drivers)) {
        const home = env[harnessHomeVar(harness)]?.trim() || host.harnessStateHome(harness);
        homes[harness] = home ? canonicalPath(home) : null;
    }
    for (const tool of [...new Set([...host.declaredTools(), ...Object.values(registry.drivers).map(driver => driver.options.tool)])].sort()) {
        const bin = host.resolveToolBin(tool).bin || null;
        bins[tool] = bin && path.isAbsolute(bin) ? canonicalPath(bin) : bin;
    }
    return { homes, bins, searchPath: Object.values(bins).some(bin => bin && !path.isAbsolute(bin)) ? env.PATH ?? null : null,
        pollEnvironment: pollEnvironmentOf(pollEnv) };
}
export function requireServiceHarnessContext(expected, host, env, registry, pollEnv = env) {
    if (!isDeepStrictEqual(expected, serviceHarnessContext(host, env, registry, pollEnv))) {
        throw new GateError('Shared service client has different harness state homes, binaries or common poll environment; reconnect through the same workspace runtime');
    }
}
export function bindServiceHarnessContext(host, env, registry) {
    const expected = serviceHarnessContext(host, env, registry);
    bindHarnessHomes(host);
    bindHarnessBins(host);
    requireServiceHarnessContext(expected, {
        declaredTools: () => host.declaredTools(),
        harnessStateHome: harness => bound?.harnessStateHome(harness) ?? null,
        resolveToolBin: tool => boundBins?.resolveToolBin(tool) ?? { ok: true, bin: tool },
    }, process.env, registry, env);
    bindPollEnvironment(env);
    return expected;
}

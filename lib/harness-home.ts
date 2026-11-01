// The harness session registry, and the refusal when nobody says.
// [reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says](../docs/reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says)
import { homedir } from 'node:os';
import path from 'node:path';
import { GateError } from '../dist/index.js';
import type { PromptobusHost } from '../dist/index.js';
import { isDeepStrictEqual } from 'node:util';
import { canonicalPath } from './store.js';
import type { LibRegistry } from './driver-runtime.js';

type HarnessHomeHost = Partial<Pick<PromptobusHost, 'harnessStateHome'>>;
type HarnessBinHost = Partial<Pick<PromptobusHost, 'resolveToolBin'>>;
let bound: Required<HarnessHomeHost> | null = null;

/** Bind the host whose `harnessStateHome` answers here; the FIRST binding of a process
 * wins and a later one is ignored — why, in the reference named at the head of this file. */
export function bindHarnessHomes(host: HarnessHomeHost | null | undefined) {
  if (!host) {
    bound = null;
    return null;
  }
  if (bound) return bound;
  bound = typeof host.harnessStateHome === 'function' ? host as Required<HarnessHomeHost> : null;
  return bound;
}

/** The environment variable one harness's registry is named by. */
export function harnessHomeVar(harness: string) {
  return `PROMPTOBUS_${String(harness).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_HOME`;
}

/** The registry directory for `harness`; `GateError` when neither the environment nor a
 * bound host names one — a refusal rather than a default under the real home. */
export function harnessStateHome(harness: string, env: NodeJS.ProcessEnv = process.env) {
  const varName = harnessHomeVar(harness);
  const named = String(env[varName] ?? '').trim();
  if (named) return named;
  const fromHost = bound?.harnessStateHome(harness) ?? null;
  if (fromHost) return String(fromHost);
  throw new GateError(`no state home for harness ${harness}: set ${varName}, or answer`
    + ` harnessStateHome('${harness}') from the host. It is not guessed — a default under`
    + ` ${path.join(homedir(), '.promptobus', String(harness))} once had the registry writing to a`
    + ' real home while inspect read a sandbox, with no error anywhere.');
}

let boundBins: Required<HarnessBinHost> | null = null;

/** Bind the host whose `resolveToolBin` names a harness binary for the calls made AFTER a lift —
 * the state query and the stop; the FIRST binding wins, as above. [05-drivers.md § The harness binary after a lift](../docs/reference/05-drivers.md#the-harness-binary-after-a-lift-the-lifts-door-not-path) */
export function bindHarnessBins(host: HarnessBinHost | null | undefined) {
  if (!host) {
    boundBins = null;
    return null;
  }
  if (!boundBins && typeof host.resolveToolBin === 'function') boundBins = host as Required<HarnessBinHost>;
  return boundBins;
}

/** `{ bin }` the way the lift resolves it, or `{ bin: null, reason }` naming what was looked for.
 * No host bound — the bare name and `PATH`, as before any host existed. */
export function harnessBin(tool: string) {
  const said = boundBins ? boundBins.resolveToolBin(tool) : { ok: true, bin: tool };
  if (said?.bin) return { bin: String(said.bin), reason: null };
  return { bin: null, reason: said?.reason ?? `the host named no binary for ${tool}` };
}

export const POLL_ENV_KEYS = [
  'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'CLAUDE_CONFIG_DIR',
  'PATH', 'Path', 'PATHEXT', 'ComSpec', 'COMSPEC', 'SystemRoot', 'WINDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMUX_TMPDIR',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
] as const;
const POLL_NATIVE_ENV = new Set(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']);
let boundPollEnvironment: Readonly<NodeJS.ProcessEnv> | null = null;

export function pollEnvironmentOf(env: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv> {
  const result: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(env).sort()) {
    if (POLL_NATIVE_ENV.has(key)) continue;
    if (POLL_ENV_KEYS.some(allowed => allowed === key) || key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_')) {
      if (typeof env[key] === 'string') result[key] = env[key];
    }
  }
  return Object.freeze(result);
}

export function bindPollEnvironment(env: NodeJS.ProcessEnv) {
  const projected = pollEnvironmentOf(env);
  if (boundPollEnvironment && !isDeepStrictEqual(boundPollEnvironment, projected)) throw new GateError('Shared service has a different common poll environment');
  return boundPollEnvironment ??= projected;
}

export function commonPollEnvironment() { return boundPollEnvironment ?? process.env; }

export interface HarnessContext {
  homes: Record<string, string | null>; bins: Record<string, string | null>; searchPath: string | null;
  pollEnvironment: Readonly<NodeJS.ProcessEnv>;
}
type HarnessContextHost = Pick<PromptobusHost, 'declaredTools' | 'harnessStateHome' | 'resolveToolBin'>;

export function serviceHarnessContext(host: HarnessContextHost, env: NodeJS.ProcessEnv, registry: Pick<LibRegistry, 'drivers'>, pollEnv = env): HarnessContext {
  const homes: HarnessContext['homes'] = {}, bins: HarnessContext['bins'] = {};
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

export function requireServiceHarnessContext(expected: HarnessContext, host: HarnessContextHost, env: NodeJS.ProcessEnv, registry: Pick<LibRegistry, 'drivers'>, pollEnv = env) {
  if (!isDeepStrictEqual(expected, serviceHarnessContext(host, env, registry, pollEnv))) {
    throw new GateError('Shared service client has different harness state homes, binaries or common poll environment; reconnect through the same workspace runtime');
  }
}

export function bindServiceHarnessContext(host: PromptobusHost, env: NodeJS.ProcessEnv, registry: Pick<LibRegistry, 'drivers'>) {
  const expected = serviceHarnessContext(host, env, registry);
  bindHarnessHomes(host); bindHarnessBins(host);
  requireServiceHarnessContext(expected, {
    declaredTools: () => host.declaredTools(),
    harnessStateHome: harness => bound?.harnessStateHome(harness) ?? null,
    resolveToolBin: tool => boundBins?.resolveToolBin(tool) ?? { ok: true, bin: tool },
  }, process.env, registry, env);
  bindPollEnvironment(env);
  return expected;
}

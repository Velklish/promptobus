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

export interface HarnessContext { homes: Record<string, string | null>; bins: Record<string, string | null>; searchPath: string | null }
type HarnessContextHost = Pick<PromptobusHost, 'declaredTools' | 'harnessStateHome' | 'resolveToolBin'>;

export function serviceHarnessContext(host: HarnessContextHost, env: NodeJS.ProcessEnv, registry: Pick<LibRegistry, 'drivers'>): HarnessContext {
  const homes: HarnessContext['homes'] = {}, bins: HarnessContext['bins'] = {};
  for (const harness of Object.keys(registry.drivers)) {
    const home = env[harnessHomeVar(harness)]?.trim() || host.harnessStateHome(harness);
    homes[harness] = home ? canonicalPath(home) : null;
  }
  for (const tool of [...new Set([...host.declaredTools(), ...Object.values(registry.drivers).map(driver => driver.options.tool)])].sort()) {
    const bin = host.resolveToolBin(tool).bin || null;
    bins[tool] = bin && path.isAbsolute(bin) ? canonicalPath(bin) : bin;
  }
  return { homes, bins, searchPath: Object.values(bins).some(bin => bin && !path.isAbsolute(bin)) ? env.PATH ?? null : null };
}

export function requireServiceHarnessContext(expected: HarnessContext, host: HarnessContextHost, env: NodeJS.ProcessEnv, registry: Pick<LibRegistry, 'drivers'>) {
  if (!isDeepStrictEqual(expected, serviceHarnessContext(host, env, registry))) {
    throw new GateError('Shared service client has different harness state homes or binaries; reconnect through the same workspace runtime');
  }
}

export function bindServiceHarnessContext(host: PromptobusHost, env: NodeJS.ProcessEnv, registry: Pick<LibRegistry, 'drivers'>) {
  const expected = serviceHarnessContext(host, env, registry);
  bindHarnessHomes(host); bindHarnessBins(host);
  requireServiceHarnessContext(expected, {
    declaredTools: () => host.declaredTools(),
    harnessStateHome: harness => bound?.harnessStateHome(harness) ?? null,
    resolveToolBin: tool => boundBins?.resolveToolBin(tool) ?? { ok: true, bin: tool },
  }, process.env, registry);
  return expected;
}

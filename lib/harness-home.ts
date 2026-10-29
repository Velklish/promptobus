// The harness session registry, and the refusal when nobody says.
// [reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says](../docs/reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says)
import { homedir } from 'node:os';
import path from 'node:path';
import { GateError } from '../dist/index.js';
import type { PromptobusHost } from '../dist/index.js';

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

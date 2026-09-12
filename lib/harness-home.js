// The harness session registry, and the refusal when nobody says.
// [reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says](../docs/reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says)
import { homedir } from 'node:os';
import path from 'node:path';
import { GateError } from '../dist/index.js';

let bound = null;

/**
 * Bind the host whose `harnessStateHome` answers here. Called at the point a host enters
 * the package.
 *
 * **The FIRST binding of a process wins**, and a later one is ignored rather than
 * silently overwriting it. The rule is not symmetry for its own sake: `hostOf` builds a
 * standalone host for a bare root string, and inside a process that had already entered
 * through `runPromptobus` with a consumer's host, an overwrite would move the session
 * registries mid-run — the registry helpers read the binding at call time, so `inspect`
 * after such a call would look somewhere the writes never went. That is the split the
 * refusal exists to prevent, rebuilt from the other side.
 *
 * A falsy argument unbinds, always: that is how a test returns the process to the
 * "nobody says" state, and how a caller that means to rebind says so in two steps.
 */
export function bindHarnessHomes(host) {
  if (!host) {
    bound = null;
    return null;
  }
  if (bound) return bound;
  bound = typeof host.harnessStateHome === 'function' ? host : null;
  return bound;
}

/** The environment variable one harness's registry is named by. */
export function harnessHomeVar(harness) {
  return `PROMPTOBUS_${String(harness).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_HOME`;
}

/**
 * The registry directory for `harness`. Throws `GateError` when neither the environment
 * nor a bound host names one — see the head of this file for why that is a refusal and
 * not a default under the real home.
 */
export function harnessStateHome(harness, env = process.env) {
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

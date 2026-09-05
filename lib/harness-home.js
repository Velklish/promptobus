// Where the package keeps its own session registry for one harness, and the refusal
// when nobody says.
//
// The registry holds the records `inspect`, `stop` and the wake path read and write.
// It used to be `PROMPTOBUS_<HARNESS>_HOME` or, failing that, `~/.promptobus/<harness>`
// — and that fallback was the bug. A consumer that had named its own variables instead
// left the package seeing neither, so the Cursor and Codex registries wrote into the
// operator's REAL home while `inspect` read the sandbox: two halves of one test looking
// at different directories, with no error anywhere and nothing in either log to say so.
// Found because a test behaved oddly, not by a gate (PB-2).
//
// So the answer now comes from one of two places that were ASKED, and otherwise it is a
// refusal that names both of them:
//
//   1. `PROMPTOBUS_<HARNESS>_HOME` in the environment — how the suite and a person
//      point the package at a sandbox, and it wins, because it is the most local thing
//      anyone said;
//   2. `host.harnessStateHome(<harness>)` — the workspace's answer. The standalone host
//      answers `~/.promptobus/<harness>`, the old fallback, so a single-user checkout
//      needs no variable and notices nothing;
//   3. neither — `GateError`, naming the variable and the method.
//
// **The host is bound once per process rather than threaded.** The registry helpers are
// called from `inspect`, `stop`, holder start and the wake path — thirty-odd call sites,
// most of them with no host in reach (`cursorDriver.inspect(ref)` takes a ref and
// nothing else). Threading a host through all of them to reach two functions would be a
// larger change than the one it protects, and a half-threaded version — a host on the
// write path, none on the read path — would rebuild the very split this fixes. The
// binding is set by whoever builds the host: `hostOf` in [host.js](host.js) does it for
// the package's own helper, and `runPromptobus` in [cli.js](cli.js) does it for a
// consumer that passes its own. Two hosts in one process share this one binding and the
// FIRST one wins — the cost of not threading, written down where it is paid.
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

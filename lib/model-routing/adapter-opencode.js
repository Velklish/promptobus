// OpenCode adapter: what the probe reads — the binary version only, no login verdict.
import { spawnAndCapture, verdict } from './adapter-common.js';

/** The binary. The same name is what the host is asked to resolve. */
const TOOL = 'opencode';

/** argv printing the version: `opencode v2.0.20`. */
const VERSION_ARGV = ['--version'];

/** Floor for the serve holder API below: the shape the driver stands on. */
export const OPENCODE_MIN_VERSION = '2.0.0';

function parseWarm(text) {
  const hit = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return hit ? { major: Number(hit[1]), minor: Number(hit[2]), patch: Number(hit[3]) } : null;
}

function belowFloor(found, floor) {
  const a = parseWarm(found);
  const b = parseWarm(floor);
  if (!a || !b) return false;
  return a.major !== b.major ? a.major < b.major
    : a.minor !== b.minor ? a.minor < b.minor
      : a.patch < b.patch;
}

/** The probe: binary present and new enough is `available` with the model this account lifts. */
export function opencodeAvailability(deps = {}) {
  const capture = deps.capture ?? spawnAndCapture;
  return {
    tool: TOOL,
    readsVersion: true,
    probe: async ({ toolBin: tool, timeoutMs }) => {
      if (!tool) {
        return verdict('unknown', 'probe_failed', 'the host resolved no tool binary, so the harness was never asked');
      }
      if (!tool.ok || !tool.bin) {
        return verdict('unavailable', 'binary_missing',
          `no ${TOOL} binary on this machine — install it, or stop declaring this harness in the workspace`);
      }
      const answer = await capture(tool.bin, VERSION_ARGV, timeoutMs);
      if (answer.timedOut) {
        return verdict('unknown', 'probe_timeout', 'opencode --version did not finish inside the preflight budget');
      }
      if (answer.error || answer.status !== 0) {
        return verdict('unknown', 'probe_failed', 'opencode --version could not be run', {});
      }
      const parsed = parseWarm(answer.stdout);
      const version = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
      if (!version) {
        return verdict('unknown', 'probe_failed', `unparsed opencode version: ${(answer.stdout ?? '').trim().split('\n')[0] ?? ''}`);
      }
      if (belowFloor(version, OPENCODE_MIN_VERSION)) {
        return verdict('unavailable', 'binary_too_old',
          `opencode ${version} is below the floor ${OPENCODE_MIN_VERSION} — update the binary`, { version });
      }
      return verdict('available', null, `opencode ${version}; auth is checked by the lift`, { version });
    },
  };
}

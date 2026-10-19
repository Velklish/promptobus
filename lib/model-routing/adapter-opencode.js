// OpenCode adapter: what the probe reads — the binary version only, no login verdict.
import { spawnAndCapture, verdict } from './adapter-common.js';

/** The binary. The same name is what the host is asked to resolve. */
const TOOL = 'opencode';

/** argv printing the version: `opencode v2.0.20`. */
const VERSION_ARGV = ['--version'];

function parseWarm(text) {
  const hit = String(text ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return hit ? { major: Number(hit[1]), minor: Number(hit[2]), patch: Number(hit[3]) } : null;
}

/** Successful version telemetry establishes binary response; auth is checked by the lift. */
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
      const label = version ?? `unknown label ${JSON.stringify((answer.stdout ?? '').trim().split('\n')[0])}`;
      return verdict('available', null, `opencode ${label}; auth is checked by the lift`,
        version ? { version } : {});
    },
  };
}

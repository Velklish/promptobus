// Host dispatcher: a root string becomes a standalone host for this call.
// There is no process-wide singleton — each call builds its own object.

import { isPromptobusHost } from '../dist/host.js';
import { createStandaloneHost } from '../dist/host-index.js';
import { bindHarnessHomes } from './harness-home.js';

export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from '../dist/host.js';
export { createStandaloneHost } from '../dist/host-index.js';

// Also binds the host that answers `harnessStateHome` for this process, and the FIRST
// binding wins: [02-host.md § The harness session registry](../docs/reference/02-host.md#the-harness-session-registry-and-the-refusal-when-nobody-says).
export function hostOf(rootOrHost, options = {}) {
  if (isPromptobusHost(rootOrHost)) {
    bindHarnessHomes(rootOrHost);
    return rootOrHost;
  }
  if (typeof rootOrHost !== 'string' || !rootOrHost) {
    throw new TypeError('promptobus: host or workspace root is required');
  }
  const built = createStandaloneHost({ cwd: rootOrHost, ...options });
  bindHarnessHomes(built);
  return built;
}

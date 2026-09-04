// Host dispatcher: a root string becomes a standalone host for this call.
// There is no process-wide singleton — each call builds its own object.

import { isPromptobusHost } from '../dist/host.js';
import { createStandaloneHost } from '../dist/host-index.js';

export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from '../dist/host.js';
export { createStandaloneHost } from '../dist/host-index.js';

export function hostOf(rootOrHost, options = {}) {
  if (isPromptobusHost(rootOrHost)) return rootOrHost;
  if (typeof rootOrHost !== 'string' || !rootOrHost) {
    throw new TypeError('promptobus: host or workspace root is required');
  }
  return createStandaloneHost({ cwd: rootOrHost, ...options });
}

// Host dispatcher: a root string becomes a standalone host for this call.
// There is no process-wide singleton — each call builds its own object.

import { isPromptobusHost } from '../dist/host.js';
import { createStandaloneHost } from '../dist/host-index.js';
import { bindHarnessHomes } from './harness-home.js';

export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from '../dist/host.js';
export { createStandaloneHost } from '../dist/host-index.js';

// The host is also bound as the answer to `harnessStateHome` for this process
// ([harness-home.js](harness-home.js)): the session registries are read from call
// sites that have no host in reach — `inspect(ref)` takes a ref and nothing else —
// and threading one to them would be a larger change than the split it prevents.
// `runPromptobus` binds it too, for a consumer that builds its own host and never
// passes through here. Whichever of the two comes first is the one that answers: a
// standalone host built here must not move the registries out from under a consumer's
// host that already entered through `runPromptobus`.
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

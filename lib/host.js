// Диспетчер host: строка-корень становится standalone-host'ом на этот вызов.
// Process-wide singleton'а нет — каждый вызов строит свой объект.

import { isPromptobusHost } from '../dist/host.js';
import { createStandaloneHost } from '../dist/host-index.js';

export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from '../dist/host.js';
export { createStandaloneHost } from '../dist/host-index.js';

export function hostOf(rootOrHost, options = {}) {
  if (isPromptobusHost(rootOrHost)) return rootOrHost;
  if (typeof rootOrHost !== 'string' || !rootOrHost) {
    throw new TypeError('promptobus: нужен host или корень рабочего места');
  }
  return createStandaloneHost({ cwd: rootOrHost, ...options });
}

// Диспетчер host: строка-корень становится ATI-host'ом на этот вызов. Process-wide
// singleton'а нет — каждый вызов строит свой объект (ADR-038, BL-518).

import { isPromptobusHost } from '../../packages/promptobus/dist/host.js';
import { createAtiHost } from './ati-host.js';

export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from '../../packages/promptobus/dist/host.js';
export { createAtiHost } from './ati-host.js';

export function hostOf(rootOrHost) {
  if (isPromptobusHost(rootOrHost)) return rootOrHost;
  if (typeof rootOrHost !== 'string' || !rootOrHost) {
    throw new TypeError('promptobus: нужен host или корень рабочего места');
  }
  return createAtiHost({ root: rootOrHost });
}

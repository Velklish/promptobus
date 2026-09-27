import { ok } from './util.js';
import { hostOf } from './host.js';
import { bus, changePeerLink, GateError, resolveIdentity } from './store.js';

export function link(rootOrHost, aId, bId, { unlink = false, env = process.env, cwd = process.cwd() } = {}) {
  const host = hostOf(rootOrHost);
  if (!aId || !bId) throw new GateError(`${unlink ? 'unlink' : 'link'} needs two task ids`);
  const identity = resolveIdentity(env, cwd, { host });
  bus(identity.home, { cli: host.version });
  const { a, b } = changePeerLink(identity.home, aId, bId, { session: identity.session, unlink });
  ok(`${unlink ? 'unlinked' : 'linked'} ${aId} (${a}) ↔ ${bId} (${b})`);
  return 0;
}

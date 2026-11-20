import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The service names its control socket with the first 24 hex digits of its key.
// prepareControlSocket limits the canonical socket path to 100 bytes.
export function testSocketParent(prefix, socketName = '0'.repeat(24) + '.sock') {
  const tmp = realpathSync(process.env.PROMPTOBUS_TEST_SOCKET_PARENT || os.tmpdir());
  if (process.platform === 'win32') return tmp;
  const socket = path.join(tmp, prefix + 'XXXXXX', socketName);
  return Buffer.byteLength(socket) <= 100 ? tmp : realpathSync('/tmp');
}

export function makeServiceTestDirectory(prefix, subdirectory = '') {
  const socketName = path.join(subdirectory, '0'.repeat(24) + '.sock');
  return mkdtempSync(path.join(testSocketParent(prefix, socketName), prefix));
}

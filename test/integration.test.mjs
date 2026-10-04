// Branches of the host integration entry point that no shipped driver reaches; the installed
// tarball's operations are exercised in promptobus-package.test.mjs.
import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { REGISTRY } from '../lib/drivers.js';
import { checkWake } from '../lib/integration.js';

test('checkWake answers without a channel when a driver declares no wake smoke', async () => {
  const { fallback } = REGISTRY;
  const shipped = REGISTRY.drivers[fallback];
  REGISTRY.drivers[fallback] = { ...shipped, checkWake: undefined };
  try {
    assert.deepEqual(await checkWake(undefined, {}),
      { harness: fallback, endpoint: null, ok: false, error: 'no wake channel declared' });
  } finally {
    REGISTRY.drivers[fallback] = shipped;
  }
});

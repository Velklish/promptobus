import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

test('current package admits only the checked BB 0.47.1 and SDK 0.6.79 pair', () => {
  const manifest = read('package.json');
  assert.deepEqual(manifest.engines, { bb: '0.47.1', bbPluginSdk: '0.6.79' },
    'admit the checked installed pair without claiming adjacent or future host versions');
});

test('current public provider bridge SDK is exactly pinned and captured as a runtime dependency', () => {
  const manifest = read('package.json'), lock = read('package-lock.json');
  assert.equal(manifest.dependencies['@get-bb/plugin-sdk'], '0.6.79');
  assert.equal(manifest.devDependencies['@get-bb/plugin-sdk'], undefined);
  assert.equal(lock.packages[''].dependencies['@get-bb/plugin-sdk'], '0.6.79');
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.equal(lock.packages['node_modules/@get-bb/plugin-sdk'].version, '0.6.79');
  const sdk = JSON.parse(readFileSync(path.join(root, 'node_modules/@get-bb/plugin-sdk/package.json'), 'utf8'));
  assert.equal(sdk.version, '0.6.79');
  const require = createRequire(path.join(root, 'package.json'));
  assert.ok(require.resolve('@get-bb/plugin-sdk/provider-bridge'));
  assert.ok(require.resolve('@get-bb/plugin-sdk/host'));
});

test('setup and package overview name the exact current pair separately from historical observations', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const overview = readFileSync(path.join(root, 'PLUGIN_OVERVIEW.md'), 'utf8');
  assert.match(readme, /Use BB 0.47.1 and Plugin SDK 0.6.79/);
  assert.match(readme, /that exact app\/SDK pair; adjacent and future versions require a separate/);
  assert.match(overview, /BB 0.47.1, Plugin SDK 0.6.79/);
  assert.match(overview, /historical profiles do not\nadmit other versions/);
});

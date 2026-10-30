import assert from 'node:assert/strict';
import { experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

test('current package admits only the checked BB 0.48.0 and SDK 0.6.94 pair', () => {
  const manifest = read('package.json');
  assert.deepEqual(manifest.engines, { bb: '0.48.0', bbPluginSdk: '0.6.94' },
    'admit the checked installed pair without claiming adjacent or future host versions');
});

test('current public provider bridge SDK is exactly pinned as a build dependency', () => {
  const manifest = read('package.json'), lock = read('package-lock.json');
  assert.equal(manifest.devDependencies['@get-bb/plugin-sdk'], '0.6.94');
  assert.equal(manifest.dependencies['@get-bb/plugin-sdk'], undefined);
  assert.equal(lock.packages[''].devDependencies['@get-bb/plugin-sdk'], '0.6.94');
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.equal(lock.packages['node_modules/@get-bb/plugin-sdk'].version, '0.6.94');
  const sdk = JSON.parse(readFileSync(path.join(root, 'node_modules/@get-bb/plugin-sdk/package.json'), 'utf8'));
  assert.equal(sdk.version, '0.6.94');
  const require = createRequire(path.join(root, 'package.json'));
  assert.ok(require.resolve('@get-bb/plugin-sdk/provider-bridge'));
  assert.ok(require.resolve('@get-bb/plugin-sdk/host'));
});

test('setup and package overview name the exact current pair separately from historical observations', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const overview = readFileSync(path.join(root, 'PLUGIN_OVERVIEW.md'), 'utf8');
  assert.match(readme, /Use BB 0.48.0 and Plugin SDK 0.6.94/);
  assert.match(readme, /that exact app\/SDK pair; adjacent and future versions require a separate/);
  assert.match(overview, /BB 0.48.0, Plugin SDK 0.6.94/);
  assert.match(overview, /historical profiles do not\nadmit other versions/);
});

function assertPublicSdkImports(packageRoot) {
  const scan = experimental_scanPublicSdkOnly(packageRoot, { allow: [/^promptobus(?:\/|$)/] });
  const dynamicFixtures = [
    ['test/activation.test.mjs', 'pathToFileURL(serverFile).href'],
    ['test/activation.test.mjs', "pathToFileURL(path.join(root, 'dist/host.js')).href + `?activation=${generation}`"],
    ['test/evidence-prepare.test.mjs', 'pathToFileURL(process.env.PB_BASE_REVIEW_EVIDENCE)'],
    ['test/runtime-identity.test.mjs', "pathToFileURL(path.join(directory, 'server.js')).href"],
    ['test/runtime-identity.test.mjs', "pathToFileURL(path.join(directory, 'host.js')).href"],
    ['test/runtime-identity.test.mjs', 'pathToFileURL(file).href'],
  ];
  const fixtures = dynamicFixtures.map(([file, specifier]) => ({ file, specifier, reason: 'dynamic-specifier' }));
  fixtures.push({ file: 'test/message-order.test.mjs', specifier: '../../../lib/review.js', reason: 'outside-package' });
  assert.deepEqual(scan.violations.filter(row => !fixtures.some(fixture =>
    row.reason === fixture.reason && row.file === fixture.file && row.specifier === fixture.specifier)), []);
  assert.deepEqual(scan.privateDependencies, []);
}

test('integration public SDK scan rejects imports outside its explicit test fixture inventory', () => {
  assertPublicSdkImports(root);
});

test('public SDK scan admits the exact legacy test import and refuses its copy in production source', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-sdk-imports-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'package.json'), '{"name":"sdk-import-fixture"}');
  mkdirSync(path.join(directory, 'test'));
  const legacyTest = path.join(directory, 'test/message-order.test.mjs');
  writeFileSync(legacyTest, "import { requireStepResults } from '../../../lib/review.js';\n");
  assertPublicSdkImports(directory);
  copyFileSync(legacyTest, path.join(directory, 'production.ts'));
  assert.throws(() => assertPublicSdkImports(directory), { code: 'ERR_ASSERTION', expected: [], actual: [{
    file: 'production.ts', specifier: '../../../lib/review.js', reason: 'outside-package',
  }] });
});

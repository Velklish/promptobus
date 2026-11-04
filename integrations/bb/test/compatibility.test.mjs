import assert from 'node:assert/strict';
import { experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

test('current package admits only the checked BB 0.48.1 and SDK 0.6.104 pair', () => {
  const manifest = read('package.json');
  assert.deepEqual(manifest.engines, { bb: '0.48.1', bbPluginSdk: '0.6.104', node: '>=26' },
    'admit the checked installed pair without claiming adjacent or future host versions');
});

test('current public provider bridge SDK is exactly pinned as a build dependency', () => {
  const manifest = read('package.json'), lock = read('package-lock.json');
  assert.equal(manifest.devDependencies['@get-bb/plugin-sdk'], '0.6.104');
  assert.equal(manifest.dependencies['@get-bb/plugin-sdk'], undefined);
  assert.equal(lock.packages[''].devDependencies['@get-bb/plugin-sdk'], '0.6.104');
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.equal(lock.packages['node_modules/@get-bb/plugin-sdk'].version, '0.6.104');
  const sdk = JSON.parse(readFileSync(path.join(root, 'node_modules/@get-bb/plugin-sdk/package.json'), 'utf8'));
  assert.equal(sdk.version, '0.6.104');
  const require = createRequire(path.join(root, 'package.json'));
  assert.ok(require.resolve('@get-bb/plugin-sdk/provider-bridge'));
  assert.ok(require.resolve('@get-bb/plugin-sdk/host'));
});

test('runtime schemas and SDK share the exact patched Zod dependency', () => {
  const manifest = read('package.json'), lock = read('package-lock.json');
  assert.equal(manifest.dependencies.zod, '4.6.6');
  assert.equal(lock.packages[''].dependencies.zod, '4.6.6');
  const installed = JSON.parse(readFileSync(path.join(root, 'node_modules/zod/package.json'), 'utf8'));
  assert.equal(installed.version, '4.6.6');
  assert.deepEqual(Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/zod$/.test(name))
    .map(([name, dependency]) => [name, dependency.version]), [['node_modules/zod', '4.6.6']]);
});

test('oversized runtime arrays refuse before validating their items', () => {
  const result = z.array(z.string()).max(1).safeParse([1, 2, 3]);
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues.map(issue => issue.code), ['too_big']);
});

test('setup and package overview name the exact current pair separately from historical observations', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const overview = readFileSync(path.join(root, 'PLUGIN_OVERVIEW.md'), 'utf8');
  assert.match(readme, /Use BB 0.48.1 and Plugin SDK 0.6.104/);
  assert.match(readme, /that exact app\/SDK pair; adjacent and future versions require a separate/);
  assert.match(overview, /BB 0.48.1, Plugin SDK 0.6.104/);
  assert.match(overview, /historical profiles do not\nadmit other versions/);
});

function assertPublicSdkImports(packageRoot) {
  const scan = experimental_scanPublicSdkOnly(packageRoot, { allow: [/^promptobus(?:\/|$)/] });
  const dynamicFixtures = [
    ['test/activation.test.mjs', 'pathToFileURL(serverFile).href'],
    ['test/runtime-package.test.mjs', 'pathToFileURL(artifact).href'],
    ['test/activation.test.mjs', "pathToFileURL(path.join(root, 'dist/host.js')).href + `?activation=${generation}`"],
    ['test/evidence-prepare.test.mjs', 'pathToFileURL(process.env.PB_BASE_REVIEW_EVIDENCE)'],
    ['test/runtime-identity.test.mjs', "pathToFileURL(path.join(directory, 'server.js')).href"],
    ['test/runtime-identity.test.mjs', "pathToFileURL(path.join(directory, 'host.js')).href"],
    ['test/runtime-identity.test.mjs', 'pathToFileURL(file).href'],
  ];
  const fixtures = dynamicFixtures.map(([file, specifier]) => ({ file, specifier, reason: 'dynamic-specifier' }));
  fixtures.push({ file: 'test/message-order.test.mjs', specifier: '../../../lib/review.js', reason: 'outside-package' });
  const packagedEntry = row => row.reason === 'dynamic-specifier'
    && /^(?:runtime-package\.ts|\.test-build\/runtime-package\.js|\.runtime\/[a-f0-9-]+\/(?:source|inputs)\/runtime-package\.ts)$/.test(row.file)
    && ["pathToFileURL(path.join(root, 'dist/host-index.js')).href", "pathToFileURL(path.join(root, 'lib/bb-host.js')).href"].includes(row.specifier);
  assert.deepEqual(scan.violations.filter(row => !packagedEntry(row) && !fixtures.some(fixture =>
    row.reason === fixture.reason && row.file === fixture.file && row.specifier === fixture.specifier)), []);
  assert.deepEqual(scan.privateDependencies, []);
}

test('integration public SDK scan rejects imports outside its explicit public core and fixture inventory', () => {
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


test('public SDK scan admits only the two verified packaged core entries in their loader', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-core-imports-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'package.json'), '{"name":"core-import-fixture"}');
  const loader = path.join(directory, 'runtime-package.ts');
  const admitted = "import(pathToFileURL(path.join(root, 'dist/host-index.js')).href);";
  writeFileSync(loader, admitted);
  assertPublicSdkImports(directory);
  writeFileSync(loader, "import(pathToFileURL(path.join(root, 'private.js')).href);");
  assert.throws(() => assertPublicSdkImports(directory), { code: 'ERR_ASSERTION' });
  writeFileSync(loader, admitted);
  copyFileSync(loader, path.join(directory, 'production.ts'));
  assert.throws(() => assertPublicSdkImports(directory), { code: 'ERR_ASSERTION' });
});

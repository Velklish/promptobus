import assert from 'node:assert/strict';
import { experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { z } from 'zod';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

const SDK = '0.6.157';
const ENGINES = { bb: '>=0.50.1 <0.51', bbPluginSdk: `>=${SDK}`, node: '>=26' };

test('both packages declare the BB 0.50 line from 0.50.1 and the SDK floor they build with', () => {
  const manifest = read('package.json');
  const panel = JSON.parse(readFileSync(path.join(root, '../bb-native-observer/package.json'), 'utf8'));
  assert.deepEqual(manifest.engines, ENGINES,
    'a BB patch release keeps the plugin; a new minor line needs a qualified release');
  assert.deepEqual(panel.engines, manifest.engines);
  assert.equal(panel.devDependencies['@get-bb/plugin-sdk'], SDK);
  assert.equal(panel.dependencies.zod, '4.6.7');
  const panelLock = JSON.parse(readFileSync(path.join(root, '../bb-native-observer/package-lock.json'), 'utf8'));
  assert.deepEqual(panelLock.packages[''].engines, panel.engines);
  assert.equal(panelLock.packages['node_modules/@get-bb/plugin-sdk'].version, SDK);
  assert.equal(panelLock.packages['node_modules/zod'].version, '4.6.7');
  assert.equal(panelLock.packages['node_modules/@get-bb/plugin-sdk/node_modules/zod'], undefined);
});

test('by semver rules both plugins load on BB 0.50.1 to 0.50.x and SDK 0.6.157 up, and refuse anything older or BB 0.51', () => {
  for (const file of ['package.json', '../bb-native-observer/package.json']) {
    const { bb, bbPluginSdk } = read(file).engines;
    for (const version of ['0.50.1', '0.50.2', '0.50.99']) assert.ok(semver.satisfies(version, bb), `${file} refuses BB ${version}`);
    for (const version of ['0.49.0', '0.50.0', '0.50.1-rc.1', '0.51.0', '1.0.0'])
      assert.ok(!semver.satisfies(version, bb), `${file} accepts BB ${version}`);
    for (const version of [SDK, '0.6.200', '0.7.0']) assert.ok(semver.satisfies(version, bbPluginSdk), `${file} refuses SDK ${version}`);
    for (const version of ['0.6.132', '0.6.156']) assert.ok(!semver.satisfies(version, bbPluginSdk), `${file} accepts SDK ${version}`);
  }
  assert.equal(read('package.json').engines.bbPluginSdk, `>=${read('package.json').devDependencies['@get-bb/plugin-sdk']}`,
    'the SDK floor is the SDK the bundle is built with');
});

test('current public provider bridge SDK is exactly pinned as a build dependency', () => {
  const manifest = read('package.json'), lock = read('package-lock.json');
  assert.equal(manifest.devDependencies['@get-bb/plugin-sdk'], SDK);
  assert.equal(manifest.dependencies['@get-bb/plugin-sdk'], undefined);
  assert.equal(lock.packages[''].devDependencies['@get-bb/plugin-sdk'], SDK);
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.equal(lock.packages['node_modules/@get-bb/plugin-sdk'].version, SDK);
  const sdk = JSON.parse(readFileSync(path.join(root, 'node_modules/@get-bb/plugin-sdk/package.json'), 'utf8'));
  assert.equal(sdk.version, SDK);
  const require = createRequire(path.join(root, 'package.json'));
  assert.ok(require.resolve('@get-bb/plugin-sdk/provider-bridge'));
  assert.ok(require.resolve('@get-bb/plugin-sdk/host'));
});

test('runtime schemas and SDK share the exact patched Zod dependency', () => {
  const manifest = read('package.json'), lock = read('package-lock.json');
  assert.equal(manifest.dependencies.zod, '4.6.7');
  assert.equal(lock.packages[''].dependencies.zod, '4.6.7');
  const installed = JSON.parse(readFileSync(path.join(root, 'node_modules/zod/package.json'), 'utf8'));
  assert.equal(installed.version, '4.6.7');
  assert.deepEqual(Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/zod$/.test(name))
    .map(([name, dependency]) => [name, dependency.version]), [['node_modules/zod', '4.6.7']]);
});

test('oversized runtime arrays refuse before validating their items', () => {
  const result = z.array(z.string()).max(1).safeParse([1, 2, 3]);
  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues.map(issue => issue.code), ['too_big']);
});

test('setup and package overview name the current floor separately from historical observations', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const overview = readFileSync(path.join(root, 'PLUGIN_OVERVIEW.md'), 'utf8');
  assert.match(readme, /Use BB 0\.50\.1 or a later 0\.50 patch with Plugin SDK 0\.6\.157 or newer/);
  assert.match(readme, /a new minor line requires a separate compatibility check and release/);
  assert.match(overview, /BB 0\.50 from 0\.50\.1, Plugin SDK 0\.6\.157 or newer/);
  assert.match(overview, /historical profiles do not\nadmit other versions/);
  const reference = readFileSync(path.join(root, '../../docs/reference/05-drivers.md'), 'utf8');
  assert.match(reference, /declares BB `>=0\.50\.1 <0\.51` with SDK `>=0\.6\.157`/);
  for (const text of [readme, overview, reference]) {
    assert.doesNotMatch(text, /exact BB 0\.49\.0 \/ SDK 0\.6\.132 pair|Use BB 0\.49\.0 and Plugin SDK 0\.6\.132/);
  }
  assert.doesNotMatch(readme, /The host range is BB `>=0\.45\.0 <0\.47\.0`/);
  assert.doesNotMatch(reference, /source package pins SDK 0\.6\.79/);
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
  fixtures.push({ file: 'test/compatibility.test.mjs', specifier: 'semver', reason: 'outside-allowlist' });
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

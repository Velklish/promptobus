import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { build, computeBuildIdentity, sha256 } from '../scripts/build.mjs';

const marker = '__PROMPTOBUS_BUILD_IDENTITY_UNBUILT_V1__';
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-build-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'skills'));
  writeFileSync(path.join(root, 'skills/SKILL.md'), 'Shipped instruction');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bb-plugin-promptobus', version: '0.1.0',
    engines: { bb: '0.47.1', bbPluginSdk: '0.6.79' },
    bb: { server: './.runtime/source/server.ts', host: './.runtime/source/host.ts', skills: ['.runtime/skills'] }, dependencies: { promptobus: '1.0.0', '@get-bb/plugin-sdk': '0.6.15' } }));
  writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  writeFileSync(path.join(root, 'server.ts'), 'server input');
  writeFileSync(path.join(root, 'host.ts'), 'host input');
  writeFileSync(path.join(root, 'build-identity.ts'), `export const encoded = '${marker}';\n`);
  for (const name of ['promptobus', '@get-bb/plugin-sdk']) {
    const directory = path.join(root, 'node_modules', name); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: name === 'promptobus' ? '1.0.0' : '0.6.15', main: './index.js', files: ['index.js'] }));
    writeFileSync(path.join(directory, 'index.js'), `export const name = ${JSON.stringify(name)};`);
  }
  return root;
}

function withFakeBuilder(t, root, exit = 0, mutation = null) {
  const executable = path.join(root, 'fake-bb');
  writeFileSync(executable, `#!${process.execPath}\nimport {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')) {console.log('0.46.1');process.exit(0)}
if(${JSON.stringify(mutation)} && process.cwd().includes('.runtime-stage-')) {
 if(${JSON.stringify(mutation)}==='git-head') execFileSync('git',['-C',${JSON.stringify(root)},'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','--allow-empty','-m','Changed during capture']);
 else { const file=${JSON.stringify(root)}+'/'+${JSON.stringify(mutation)};
 writeFileSync(file,readFileSync(file,'utf8')+'\\n// CHANGED_DURING_CAPTURE'); }
}
const entry=JSON.parse(readFileSync('package.json')).bb.server;
const source=readFileSync(new URL('./build-identity.ts',new URL(entry,'file://'+process.cwd()+'/')),'utf8');
if(${exit}) process.exit(${exit});
mkdirSync('dist',{recursive:true});
for(const file of ['server.js','host.js'])writeFileSync('dist/'+file,source);
const artifactDigest=createHash('sha256').update(source).digest('hex');
writeFileSync('dist/host.meta.json',JSON.stringify({artifactDigest,builtWith:{bbVersion:'0.46.1',pluginSdkVersion:'0.6.49'}}));\n`);
  chmodSync(executable, 0o755);
  const previous = process.env.BB_CLI;
  process.env.BB_CLI = executable;
  t.after(() => previous === undefined ? delete process.env.BB_CLI : process.env.BB_CLI = previous);
}

test('input identity changes for source, lock, resolved core and SDK content', t => {
  const root = fixture(t);
  const baseline = computeBuildIdentity(root);
  assert.equal(baseline.inputs.sourceRevision, null);
  assert.equal(baseline.inputs.sourceDirty, null);
  assert.equal(baseline.inputs.dependencies.length, 2);
  for (const file of ['server.ts', 'skills/SKILL.md', 'package-lock.json', 'node_modules/promptobus/index.js', 'node_modules/@get-bb/plugin-sdk/index.js']) {
    const name = path.join(root, file), original = readFileSync(name);
    writeFileSync(name, Buffer.concat([original, Buffer.from('\nchanged input')]));
    assert.notEqual(computeBuildIdentity(root).inputSha256, baseline.inputSha256, file);
    writeFileSync(name, original);
  }
  const again = computeBuildIdentity(root);
  assert.equal(again.inputSha256, baseline.inputSha256);
  assert.notEqual(again.buildId, baseline.buildId, 'each build invocation has its own observation identity');
  assert.equal(JSON.stringify(baseline).includes(root), false);
});

test('an untracked consumer under an unrelated Git parent does not claim the parent revision', t => {
  const original = fixture(t), parent = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-unrelated-git-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', parent, ...args], { stdio: 'pipe' });
  git('init', '--quiet');
  writeFileSync(path.join(parent, 'unrelated.txt'), 'Unrelated parent repository');
  git('add', 'unrelated.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Unrelated parent');
  const root = path.join(parent, 'consumer'); renameSync(original, root);
  const manifestPath = path.join(root, 'package.json'), manifest = JSON.parse(readFileSync(manifestPath));
  manifest.bb.host = './.runtime/source/host.mjs'; writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(path.join(root, 'host.mjs'), 'import options from "./consumer.mjs";\n');
  writeFileSync(path.join(root, 'consumer.mjs'), 'export default {};\n');
  const identity = computeBuildIdentity(root);
  assert.equal(identity.inputs.sourceRevision, null);
  assert.equal(identity.inputs.sourceDirty, null);
  assert.equal(identity.inputs.consumerIntegrationSha256, sha256('export default {};\n'));
});

test('generated consumer measures the integration selected in its own Host entry', t => {
  const root = fixture(t), manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath)); manifest.bb.host = './.runtime/source/host.mjs';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(path.join(root, 'host.mjs'), 'import options from "./consumer.mjs";\n');
  writeFileSync(path.join(root, 'consumer.mjs'), 'export default {};\n');
  const before = computeBuildIdentity(root);
  assert.equal(before.inputs.consumerIntegrationSha256, sha256('export default {};\n'));
  writeFileSync(path.join(root, 'consumer.mjs'), 'export default {changed:true};\n');
  assert.notEqual(computeBuildIdentity(root).inputSha256, before.inputSha256);
});

test('build embeds one invocation identity and binds final artifacts without changing SDK metadata', async t => {
  const root = fixture(t); withFakeBuilder(t, root);
  const source = readFileSync(path.join(root, 'build-identity.ts'));
  const manifest = await build(root);
  assert.deepEqual(readFileSync(path.join(root, 'build-identity.ts')), source);
  assert.equal(computeBuildIdentity(root, '0.46.1').inputSha256, manifest.identity.inputSha256, 'generated snapshot is excluded from measured inputs');
  assert.equal(manifest.snapshot.sha256.length, 64);
  const encoded = Buffer.from(JSON.stringify(manifest.identity)).toString('base64');
  const installed = path.join(root, manifest.installationDirectory);
  assert.deepEqual(JSON.parse(readFileSync(path.join(installed, 'package.json'))).engines,
    JSON.parse(readFileSync(path.join(root, 'package.json'))).engines, 'captured packages must preserve the declared compatibility pair');
  assert.equal(manifest.installationDirectory, `.runtime/${manifest.identity.buildId}`);
  for (const name of ['server.js', 'host.js']) {
    const bundle = readFileSync(path.join(installed, 'dist', name));
    assert.ok(bundle.includes(encoded));
    assert.equal(manifest.artifacts[name], sha256(bundle));
  }
  assert.equal(JSON.parse(readFileSync(path.join(installed, 'dist/host.meta.json'))).artifactDigest, manifest.artifacts['host.js']);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'dist/build-manifest.json'))), manifest);
  assert.equal(JSON.stringify(manifest).includes(root), false);
});

test('ordinary builder failure leaves tracked identity source unchanged', async t => {
  const root = fixture(t); withFakeBuilder(t, root, 7);
  const file = path.join(root, 'build-identity.ts'), original = readFileSync(file);
  await assert.rejects(build(root), /bb plugin build failed \(7\)/);
  assert.deepEqual(readFileSync(file), original);
});


test('capture refuses raw input edits during the consumer builder without replacing the previous receipt', async t => {
  for (const file of ['server.ts', 'skills/SKILL.md', 'node_modules/promptobus/index.js', 'git-head']) await t.test(file, async t => {
    const root = fixture(t);
    writeFileSync(path.join(root, 'host.mjs'), 'import options from "./consumer.mjs";\n');
    writeFileSync(path.join(root, 'consumer.mjs'), 'export default {};\n');
    if (file === 'git-head') {
      const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
      git('init', '--quiet');
      git('add', 'server.ts', 'host.ts', 'host.mjs', 'consumer.mjs', 'build-identity.ts', 'skills', 'package.json', 'package-lock.json', 'tsconfig.json');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Captured source');
    }
    mkdirSync(path.join(root, 'dist'));
    const receipt = path.join(root, 'dist/build-manifest.json');
    writeFileSync(receipt, 'PREVIOUS_RECEIPT');
    withFakeBuilder(t, root, 0, file);
    await assert.rejects(build(root), /Build inputs changed during capture/, 'a changed raw input must refuse the capture');
    assert.equal(readFileSync(receipt, 'utf8'), 'PREVIOUS_RECEIPT', 'a refused capture must preserve the previous latest receipt');
  });
});

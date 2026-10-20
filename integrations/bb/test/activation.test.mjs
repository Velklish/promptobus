import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { experimental_createHostEntryHarness } from '@get-bb/plugin-sdk/testing/host';
import { build } from '../scripts/build.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const marker = '__PROMPTOBUS_BUILD_IDENTITY_UNBUILT_V1__';
const runBb = root => execFileSync(process.env.BB_CLI || 'bb', ['plugin', 'build'], { cwd: root, stdio: 'pipe', timeout: 60_000 });

function fixture(t, raw = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-activation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = JSON.parse(readFileSync(path.join(source, 'package.json')));
  const manifest = { name: canonical.name, version: canonical.version, type: 'module', engines: canonical.engines,
    bb: { ...canonical.bb, ...(raw ? { server: './server.ts', host: './host.ts', skills: ['skills'] } : {}) },
    dependencies: canonical.dependencies };
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  cpSync(path.join(source, 'package-lock.json'), path.join(root, 'package-lock.json'));
  cpSync(path.join(source, 'build-identity.ts'), path.join(root, 'build-identity.ts'));
  writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'skills/fixture'), { recursive: true });
  writeFileSync(path.join(root, 'skills/fixture/SKILL.md'), 'SKILL_ORIGINAL');
  writeFileSync(path.join(root, 'server.ts'), `import {BUILD_IDENTITY} from './build-identity.js';
import {marker} from 'promptobus';
export default function plugin(bb:any) { bb.cli.register({name:'fixture',summary:'Identity fixture',async run() {
 return {exitCode:0,stdout:JSON.stringify({identity:BUILD_IDENTITY,source:'SOURCE_ORIGINAL',core:marker})};
}}); }\n`);
  writeFileSync(path.join(root, 'host.ts'), `import {experimental_defineHostEntry} from '@get-bb/plugin-sdk/host';
import {defineRpcContract} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import {BUILD_IDENTITY} from './build-identity.js';
import {marker} from 'promptobus';
export default experimental_defineHostEntry({contract:defineRpcContract({describe:{input:z.object({}),output:z.unknown()}}),
handlers:{describe:()=>({identity:BUILD_IDENTITY,source:'SOURCE_ORIGINAL',core:marker})}});\n`);
  mkdirSync(path.join(root, 'node_modules'));
  for (const name of readdirSync(path.join(source, 'node_modules'))) if (name !== 'promptobus') {
    symlinkSync(path.join(source, 'node_modules', name), path.join(root, 'node_modules', name), 'dir');
  }
  mkdirSync(path.join(root, 'node_modules/promptobus'));
  writeFileSync(path.join(root, 'node_modules/promptobus/package.json'), JSON.stringify({name:'promptobus',version:'1.0.0',type:'module',main:'./index.js',files:['index.js']}));
  writeFileSync(path.join(root, 'node_modules/promptobus/index.js'), "export const marker = 'CORE_ORIGINAL';\n");
  return root;
}

let generation = 0;
async function activate(t, root) {
  runBb(root);
  const cache = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-server-cache-'));
  generation++;
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  symlinkSync(path.join(source, 'node_modules'), path.join(cache, 'node_modules'), 'dir');
  const serverFile = path.join(cache, 'server.mjs'); cpSync(path.join(root, 'dist/server.js'), serverFile);
  const server = (await import(pathToFileURL(serverFile).href)).default;
  const host = (await import(pathToFileURL(path.join(root, 'dist/host.js')).href + `?activation=${generation}`)).default;
  const fake = createFakePluginHost({ pluginId: 'promptobus' });
  server(fake.bb); t.after(() => fake.harness.lifecycle.dispose());
  const harness = experimental_createHostEntryHarness(host); t.after(() => harness.experimental_dispose());
  const observedServer = JSON.parse((await fake.harness.behavior.runCli([])).stdout);
  const observedHost = await harness.experimental_call('describe', {});
  return { server: observedServer, host: observedHost };
}

test('the old temporary stamp is lost when activation recompiles restored manifest sources', async t => {
  const root = fixture(t, true), file = path.join(root, 'build-identity.ts'), original = readFileSync(file);
  const identity = { format: 1, buildId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pluginVersion: '0.1.0', inputSha256: 'a'.repeat(64),
    inputs:{sourceSha256:'a'.repeat(64),sourceRevision:null,sourceDirty:null,lockSha256:'a'.repeat(64),builderVersion:null,dependencies:[],consumerIntegrationSha256:null,consumerBundleSha256:null} };
  try {
    writeFileSync(file, original.toString().replace(marker, Buffer.from(JSON.stringify(identity)).toString('base64')));
    runBb(root);
    assert.ok(readFileSync(path.join(root, 'dist/server.js'), 'utf8').includes(Buffer.from(JSON.stringify(identity)).toString('base64')));
  } finally { writeFileSync(file, original); }
  const observed = await activate(t, root);
  assert.equal(observed.server.identity, null);
  assert.equal(observed.host.identity, null);
});

test('manifest activation uses frozen source, dependency and skill inputs until explicit regeneration', async t => {
  const root = fixture(t), manifest = await build(root);
  const installed = manifest.installationDirectory ? path.join(root, manifest.installationDirectory) : root;
  const original = await activate(t, installed);
  assert.deepEqual(original.server.identity, manifest.identity);
  assert.deepEqual(original.host.identity, manifest.identity);
  assert.equal(original.server.source, 'SOURCE_ORIGINAL');
  assert.equal(original.host.core, 'CORE_ORIGINAL');
  for (const file of ['server.ts', 'host.ts']) writeFileSync(path.join(root, file), readFileSync(path.join(root, file), 'utf8').replaceAll('SOURCE_ORIGINAL', 'SOURCE_EDITED'));
  writeFileSync(path.join(root, 'node_modules/promptobus/index.js'), "export const marker = 'CORE_EDITED';\n");
  writeFileSync(path.join(root, 'skills/fixture/SKILL.md'), 'SKILL_EDITED');
  writeFileSync(path.join(root, 'alternate-core.ts'), "export const marker = 'CONFIG_ESCAPED_CAPTURE';\n");
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { promptobus: ['./alternate-core.ts'] } } }));
  const stale = await activate(t, installed);
  assert.deepEqual(stale, original, 'raw edits must not execute under the previous snapshot identity');
  writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  const skill = JSON.parse(readFileSync(path.join(installed, 'package.json'))).bb.skills[0];
  const pinnedSkill = path.join(installed, skill, 'fixture/SKILL.md');
  assert.equal(readFileSync(pinnedSkill, 'utf8'), 'SKILL_ORIGINAL');
  const next = await build(root);
  assert.equal(readFileSync(pinnedSkill, 'utf8'), 'SKILL_ORIGINAL', 'building generation B must preserve the skill path owned by generation A');
  assert.deepEqual(await activate(t, installed), original, 'reloading generation A after building B must retain A code and identity');
  const selected = next.installationDirectory ? path.join(root, next.installationDirectory) : root;
  const updated = await activate(t, selected);
  assert.notEqual(next.identity.buildId, manifest.identity.buildId);
  assert.notEqual(next.identity.inputSha256, manifest.identity.inputSha256);
  assert.deepEqual(updated.server.identity, next.identity);
  assert.deepEqual(updated.host.identity, next.identity);
  assert.equal(updated.server.source, 'SOURCE_EDITED');
  assert.equal(updated.host.core, 'CORE_EDITED');
  assert.equal(readFileSync(path.join(selected, skill, 'fixture/SKILL.md'), 'utf8'), 'SKILL_EDITED');
});

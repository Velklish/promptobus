import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('existing path setup documents provisioning timing, refusal and fixture-only evidence', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('participant add --environment-path <absolute-path>'));
  assert.ok(readme.includes('Deferred spawn also defers provisioning'));
  assert.ok(readme.includes('a null environment id is not a successful launch'));
  assert.ok(readme.includes('without an extra helper thread'));
  assert.ok(readme.includes('Existing paths retain `environmentOwner: existing`'));
  assert.ok(readme.includes('existing-path registration has not been measured'));
});

test('consumer generator builds a fresh packed Host integration without generated developer files', t => {
  const source = fileURLToPath(new URL('..', import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-engine-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, 'npm-cache');
  const env = { ...process.env, npm_config_cache: cache, NPM_CONFIG_CACHE: cache };
  const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: 'pipe', timeout: 120_000 });
  const effectiveCache = run('npm', ['config', 'get', 'cache'], root).toString().trim();
  assert.ok(effectiveCache.startsWith(root + path.sep), 'npm cache must belong to the setup fixture');
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root], path.resolve(source, '../..')))[0];
  const core = JSON.parse(readFileSync(path.resolve(source, '../../package.json'), 'utf8'));
  assert.equal(packed.name, core.name);
  assert.equal(packed.version, core.version);
  const integration = path.join(root, 'consumer.mjs');
  writeFileSync(integration, `import path from 'node:path';
export default {
  resolveHost(root) { return {
    collectRules: () => [path.join(root, 'AGENTS.md')], skillsDir: () => null,
    resolveRepoModule: () => null, reviewSkillDir: () => null, pipeline: () => null,
    participantServers: () => ({servers:{canonical:{command:'fiction'}}, external:[]}),
    participantDenyToolsByKind: () => ({complete:true, tools:[{server:'canonical',tool:'write'}]}),
  }; },
  async listTools() { return ['read','write'].map(name => ({name, description:name, inputSchema:{type:'object'}, access:name})); },
  async invokeTool(input) { return {role:input.role, tool:input.tool, actor:input.actor}; },
};\n`);
  const directory = path.join(root, 'plugin');
  run(process.execPath, [path.join(source, 'scripts/create-host-plugin.mjs'), '--directory', directory,
    '--integration', integration, '--promptobus', `file:${path.join(root, packed.filename)}`], source);
  assert.equal(existsSync(path.join(directory, '.test-build')), false);
  assert.equal(existsSync(path.join(directory, 'node_modules')), false);
  assert.equal(existsSync(path.join(directory, 'dist')), false);
  assert.equal(existsSync(path.join(directory, 'test')), false);
  assert.equal(readFileSync(path.join(directory, 'skills/promptobus-worker/SKILL.md'), 'utf8'),
    readFileSync(path.join(source, 'skills/promptobus-worker/SKILL.md'), 'utf8'));
  assert.throws(() => run(process.execPath, [path.join(source, 'scripts/create-host-plugin.mjs'), '--directory', directory,
    '--integration', integration, '--promptobus', 'unused'], source), /existing files are never overwritten/);
  run('npm', ['install', '--no-audit', '--no-fund'], directory);
  const installed = JSON.parse(readFileSync(path.join(directory, 'node_modules/promptobus/package.json'), 'utf8'));
  assert.equal(installed.version, core.version);
  for (const script of ['check', 'skills:check', 'build']) run('npm', ['run', script], directory);
  for (const entry of ['server.js', 'host.js']) assert.ok(existsSync(path.join(directory, 'dist', entry)), entry);
  const build = JSON.parse(readFileSync(path.join(directory, 'dist/build-manifest.json'), 'utf8'));
  assert.equal(build.identity.inputs.consumerIntegrationSha256.length, 64);
  for (const entry of ['server.js', 'host.js']) assert.equal(build.artifacts[entry],
    createHash('sha256').update(readFileSync(path.join(directory, 'dist', entry))).digest('hex'));
  assert.ok(build.identity.inputs.dependencies.some(input => input.name === 'promptobus' && input.version === core.version));
  assert.equal(JSON.stringify(build).includes(root), false);
  assert.ok(readFileSync(path.join(directory, 'build-identity.ts'), 'utf8').includes('__PROMPTOBUS_BUILD_IDENTITY_UNBUILT_V1__'));
  const fixture = path.join(root, 'fixture'); mkdirSync(fixture);
  writeFileSync(path.join(fixture, 'AGENTS.md'), 'FICTION_RULE_FROM_PACKED_HOST');
  const probe = path.join(directory, 'probe.mjs');
  writeFileSync(probe, `import assert from 'node:assert/strict';
import entry from './dist/host.js';
import {createBbHostIntegration} from 'promptobus/bb-host';
import options from ${JSON.stringify(pathToFileURL(integration).href)};
const context={signal:new AbortController().signal};
const identity=await entry.handlers.runtimeDescribe({},context);
assert.equal(identity.identity.buildId,${JSON.stringify(build.identity.buildId)});
assert.equal(identity.identity.inputSha256,${JSON.stringify(build.identity.inputSha256)});
const collected=await entry.handlers.prepareContext({binding:{environmentPath:${JSON.stringify(fixture)},role:'reviewer'}},context);
assert.equal(collected.rules[0].text,'FICTION_RULE_FROM_PACKED_HOST');
assert.deepEqual(collected.tools.map(t=>t.tool),['read']);
const host=createBbHostIntegration(options);
const input={root:${JSON.stringify(fixture)},role:'reviewer',server:'canonical',tool:'write',args:{},actor:{task:'fiction',participant:'reviewer'}};
await assert.rejects(host.invoke(input),/not admitted/);
assert.equal((await host.invoke({...input,role:'worker'})).tool,'write');\n`);
  run(process.execPath, [probe], directory);
});

test('ACP reuse setup documents the session catalog reset and evidence boundary', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes('Reused Cursor and OpenCode environments use the same preparation sequence'));
  assert.ok(readme.includes('tool-set changes apply on the next provider session start'));
  assert.ok(readme.includes('These ordering fixtures do not prove live bridge recovery'));
});

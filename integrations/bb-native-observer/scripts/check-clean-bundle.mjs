import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { experimental_createHostEntryHarness } from '@get-bb/plugin-sdk/testing/host';
import { fixture, treeDigest } from '../.test-build/integrations/bb-native-observer/test/fixture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(root, '../..');
const area = mkdtempSync(path.join(os.tmpdir(), 'pb-native-panel-clean-'));
const checkout = path.join(area, 'checkout'), plugin = path.join(checkout, 'integrations/bb-native-observer');
const cache = process.argv.length === 4 && process.argv[2] === '--cache' ? path.resolve(process.argv[3]) : path.join(area, 'cache');
if (process.argv.length !== 2 && !(process.argv.length === 4 && process.argv[2] === '--cache')) throw new Error('Use check-clean-bundle.mjs [--cache <owned npm cache>]');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  console.log(JSON.stringify({ argv: [command, ...args], exitCode: result.status, signal: result.signal }));
  if (result.status !== 0) throw new Error(`Clean build command failed: ${result.error?.message ?? result.status}`);
}
let harness, f;
try {
  mkdirSync(path.dirname(plugin), { recursive: true });
  cpSync(path.join(repository, 'src'), path.join(checkout, 'src'), { recursive: true });
  cpSync(path.join(repository, 'package.json'), path.join(checkout, 'package.json'));
  cpSync(root, plugin, { recursive: true, filter: file => !['node_modules', 'dist', '.test-build'].includes(path.basename(file)) });
  assert.equal(existsSync(path.join(checkout, 'dist')), false);
  run('npm', ['ci', '--prefix', plugin, '--cache', cache, '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund']);
  assert.deepEqual(readdirSync(path.join(plugin, 'node_modules')).filter(name => !name.startsWith('.')), ['zod']);
  run(process.env.BB_CLI || 'bb', ['plugin', 'build', plugin]);
  const metadata = JSON.parse(readFileSync(path.join(plugin, 'dist/host.meta.json'), 'utf8'));
  assert.equal(metadata.pluginId, 'promptobus-native-panel'); assert.equal(metadata.sdkVersion, '0.6.79');
  const sources = JSON.parse(readFileSync(path.join(plugin, 'dist/host.js.map'), 'utf8')).sources;
  assert(sources.some(source => source.endsWith('/src/v1/validate.ts')));
  const isolated = path.join(area, 'isolated'); mkdirSync(isolated);
  cpSync(path.join(plugin, 'dist/host.js'), path.join(isolated, 'host.mjs'));
  const bundle = readFileSync(path.join(isolated, 'host.mjs'), 'utf8');
  assert.equal(createHash('sha256').update(bundle).digest('hex'), metadata.artifactDigest);
  assert(!bundle.includes(repository)); assert(!bundle.includes(checkout));
  rmSync(checkout, { recursive: true, force: true });
  const { default: entry } = await import(pathToFileURL(path.join(isolated, 'host.mjs')).href);
  harness = experimental_createHostEntryHarness(entry); f = fixture('clean-bundle-task', { launchBound: true });
  const before = treeDigest(f.root), inbox = f.engine.inboxIdentity(f.selection.taskId, 'actor-0');
  const snapshot = await harness.experimental_call('snapshot', f.selection);
  assert.equal(snapshot.task.id, 'clean-bundle-task'); assert.equal(snapshot.actors.length, 3);
  assert.equal(snapshot.actors[0].commands.starts, 1); assert.equal(snapshot.messages.length, 2);
  assert(snapshot.messages.some(message => message.body === 'SECRET-UNREAD-BODY'));
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET-OWNER|SECRET-RECORD|SECRET-PARTICIPANT|SECRET-COMMAND|SECRET-OUTPUT|sourceHead/);
  assert.equal(treeDigest(f.root), before); assert.deepEqual(f.engine.inboxIdentity(f.selection.taskId, 'actor-0'), inbox);
  await assert.rejects(() => harness.experimental_call('snapshot', { ...f.selection, stop: true }));
  console.log(JSON.stringify({ sourceRemoved: true, runtimeDependenciesPresent: false, fixtureUnchanged: true, extraFieldsRejected: true,
    actors: snapshot.actors.length, task: snapshot.task.id, metadata, complete: true }));
} finally {
  await harness?.experimental_dispose(); f?.cleanup(); rmSync(area, { recursive: true, force: true });
}

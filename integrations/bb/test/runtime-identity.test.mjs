import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineRpcContract } from '@get-bb/plugin-sdk';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { experimental_createHostEntryHarness } from '@get-bb/plugin-sdk/testing/host';

const source = fileURLToPath(new URL('..', import.meta.url));
const marker = '__PROMPTOBUS_BUILD_IDENTITY_UNBUILT_V1__';
const identity = (digit, buildDigit = digit) => ({ format: 1, buildId: `${buildDigit.repeat(8)}-${buildDigit.repeat(4)}-4${buildDigit.repeat(3)}-8${buildDigit.repeat(3)}-${buildDigit.repeat(12)}`,
  pluginVersion: '0.1.0', inputSha256: digit.repeat(64), inputs: { sourceSha256: digit.repeat(64), sourceRevision: digit.repeat(40),
    sourceDirty: false, lockSha256: digit.repeat(64), builderVersion: '0.46.1', dependencies: [], consumerIntegrationSha256: null } });

async function loaded(t, value) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-loaded-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of readdirSync(path.join(source, '.test-build')).filter(file => file.endsWith('.js'))) cpSync(path.join(source, '.test-build', file), path.join(directory, file));
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  symlinkSync(path.join(source, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  const file = path.join(directory, 'build-identity.js');
  if (value) writeFileSync(file, readFileSync(file, 'utf8').replace(marker, Buffer.from(JSON.stringify(value)).toString('base64')));
  const plugin = (await import(pathToFileURL(path.join(directory, 'server.js')).href)).default;
  const hostEntry = (await import(pathToFileURL(path.join(directory, 'host.js')).href)).default;
  const constant = (await import(pathToFileURL(file).href)).BUILD_IDENTITY;
  return { directory, plugin, hostEntry, constant };
}

async function fixture(t, serverIdentity, hostIdentity, override) {
  const server = await loaded(t, serverIdentity), host = await loaded(t, hostIdentity);
  const entry = experimental_createHostEntryHarness(host.hostEntry);
  t.after(() => entry.experimental_dispose());
  const fake = createFakePluginHost({ pluginId: 'promptobus', sdk: {
    system: { config: async () => ({ primaryHostId: 'primary' }) },
    threads: { get: async () => makeThreadResponse({ id: 'caller', environmentId: 'remote-environment' }) },
    environments: { get: async () => ({ id: 'remote-environment', hostId: 'remote' }) },
  }, experimental_callHostRpc: call => override ? override(call, entry) : entry.experimental_call(call.method, call.input, { signal: call.signal }) });
  server.plugin(fake.bb);
  t.after(() => fake.harness.lifecycle.dispose());
  const db = fake.bb.storage.database();
  const changes = () => db.prepare('SELECT total_changes() AS changes').get().changes;
  const initial = changes();
  return { server, host, fake, entry, changes, initial,
    describe: (args = [], context) => fake.harness.behavior.runCli(['runtime', 'describe', ...args], context) };
}

function readOnly(s) {
  assert.equal(s.changes(), s.initial, 'describe must not write plugin state after registration');
  assert.ok(s.fake.harness.inspection.sdk.calls.every(call => ['system.config', 'threads.get', 'environments.get'].includes(call.path)), 'only host selection SDK reads are allowed');
  assert.ok(s.fake.harness.inspection.experimental_hostRpcCalls.every(call => call.method === 'runtimeDescribe'), 'no engine, send or spawn RPC');
  assert.equal(s.fake.harness.inspection.registrations.agentTools.some(tool => tool.name.includes('runtime')), false);
}

test('runtime describe observes executing constants and the actual selected host without state writes', async t => {
  const value = identity('a');
  const s = await fixture(t, value, value);
  const primary = await s.describe();
  assert.equal(primary.exitCode, 0);
  assert.deepEqual(JSON.parse(primary.stdout), { status: 'complete', server: { identity: value }, host: { id: 'primary', identity: value, reason: 'matching' } });
  await s.describe([], { threadId: 'caller' });
  await s.describe(['--host', 'explicit'], { threadId: 'caller' });
  assert.deepEqual(s.fake.harness.inspection.experimental_hostRpcCalls.map(call => call.hostId), ['primary', 'remote', 'explicit']);
  assert.ok(Object.isFrozen(s.server.constant.inputs.dependencies));
  assert.throws(() => { s.server.constant.inputs.sourceRevision = 'b'.repeat(40); }, TypeError);
  readOnly(s);
});

test('a missing invoking-thread environment remains incomplete without selecting the primary host', async t => {
  const s = await fixture(t, identity('a'), identity('a'));
  s.fake.harness.inspection.sdk.stub('threads.get', async () => makeThreadResponse({ id: 'caller', environmentId: null }));
  const result = await s.describe([], { threadId: 'caller' });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout).host, { id: null, identity: null, reason: 'host-unavailable-or-incompatible' });
  assert.equal(s.fake.harness.inspection.sdk.callsTo('system.config').length, 0);
  assert.equal(s.fake.harness.inspection.experimental_hostRpcCalls.length, 0);
  readOnly(s);
});

test('runtime describe retains distinct stale host identity and rejects a different build with identical inputs', async t => {
  for (const host of [identity('b'), identity('a', 'b')]) {
    const s = await fixture(t, identity('a'), host);
    const result = await s.describe();
    const body = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 1);
    assert.equal(body.status, 'incomplete');
    assert.equal(body.host.reason, 'build-mismatch');
    assert.deepEqual(body.server.identity, identity('a'));
    assert.deepEqual(body.host.identity, host);
    readOnly(s);
  }
});

test('runtime describe refuses unbuilt server/host, old host output and unavailable host without retry', async t => {
  const old = experimental_createHostEntryHarness(experimental_defineHostEntry({ contract: defineRpcContract({}), handlers: {} }));
  t.after(() => old.experimental_dispose());
  for (const [server, host, override, reason] of [
    [null, identity('a'), null, 'server-unbuilt'], [identity('a'), null, null, 'host-unbuilt'],
    [identity('a'), identity('a'), () => ({ version: 'old' }), 'host-unavailable-or-incompatible'],
    [identity('a'), identity('a'), call => old.experimental_call(call.method, call.input), 'host-unavailable-or-incompatible'],
    [identity('a'), identity('a'), () => { throw new Error('Host is offline'); }, 'host-unavailable-or-incompatible'],
  ]) {
    const s = await fixture(t, server, host, override);
    const result = await s.describe();
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).host.reason, reason);
    assert.equal(s.fake.harness.inspection.experimental_hostRpcCalls.length, 1);
    readOnly(s);
  }
});

test('overwriting an external manifest after loading cannot change either executing identity', async t => {
  const value = identity('a');
  const s = await fixture(t, value, value);
  for (const directory of [s.server.directory, s.host.directory]) writeFileSync(path.join(directory, 'build-manifest.json'), JSON.stringify({ identity: identity('b') }));
  const result = await s.describe();
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout).server.identity, value);
  assert.deepEqual(JSON.parse(result.stdout).host.identity, value);
  readOnly(s);
});

test('runtime describe propagates cancellation before and during the read-only host call', async t => {
  const controller = new AbortController();
  const s = await fixture(t, identity('a'), identity('a'), async (call, entry) => {
    controller.abort(new Error('Cancelled identity observation'));
    return entry.experimental_call(call.method, call.input, { signal: call.signal });
  });
  const during = await s.describe([], { signal: controller.signal });
  assert.equal(during.exitCode, 1);
  assert.match(during.stderr, /Cancelled identity observation/);
  const before = await s.describe([], { signal: controller.signal });
  assert.equal(before.exitCode, 1);
  assert.equal(s.fake.harness.inspection.experimental_hostRpcCalls.length, 1);
  readOnly(s);
});

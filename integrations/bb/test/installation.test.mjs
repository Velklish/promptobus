import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectInstallation } from '../.test-build/installation.js';

function fixture() {
  const plugins = ['promptobus', 'promptobus-native-panel'].map(id => ({ id, status: 'running', version: '0.2.0',
    rootDir: `/owned/cache/${id}`, app: { bundle: id === 'promptobus' ? null : { sdkVersion: '0.6.104' } } }));
  const sources = Object.fromEntries(plugins.map(plugin => [plugin.id, { requested: 'git:https://github.com/Velklish/promptobus.git@^0.2.0',
    resolved: 'git:https://github.com/Velklish/promptobus.git@abc', range: '^0.2.0', resolvedTag: 'bb/v0.2.0', engines: { bbPluginSdk: '0.6.104' } }]));
  const identity = { buildId: 'fixture', pluginVersion: '0.2.0', inputs: { dependencies: [
    { name: 'promptobus', version: '0.32.3' }, { name: '@get-bb/plugin-sdk', version: '0.6.104' },
  ] } };
  return { plugins, sources, identity };
}

test('installation diagnostics require matching running releases and a tracking Git tag', () => {
  const f = fixture();
  assert.equal(inspectInstallation(f.plugins, f.sources, f.identity).status, 'complete');
  for (const delta of [{ status: 'incompatible' }, { version: '0.1.0' }, { app: { bundle: { sdkVersion: '0.6.79' } } }]) {
    assert.equal(inspectInstallation([{ ...f.plugins[0], ...delta }, f.plugins[1]], f.sources, f.identity).status, 'incomplete');
  }
  assert.equal(inspectInstallation(f.plugins.slice(1), f.sources, f.identity).status, 'incomplete');
  assert.equal(inspectInstallation(f.plugins, f.sources, null).status, 'incomplete');
});

test('installation diagnostics reject disposable sources, pinned tags and a different release tag', () => {
  for (const requested of ['path:/owned/.claude/worktrees/participant/plugin', 'path:/owned/sandbox/plugin', 'path:/private/tmp/plugin']) {
    const f = fixture(); f.sources.promptobus.requested = requested;
    const report = inspectInstallation(f.plugins, f.sources, f.identity);
    assert(report.components[0].issues.includes('disposable-install-source'));
    assert(report.components[0].issues.includes('release-tracking-source-required'));
  }
  for (const delta of [{ range: undefined }, { resolvedTag: 'bb/v0.1.0' }, { engines: { bbPluginSdk: '0.6.79' } }]) {
    const f = fixture(); Object.assign(f.sources.promptobus, delta);
    assert.equal(inspectInstallation(f.plugins, f.sources, f.identity).status, 'incomplete');
  }
});

test('a valid tracking tag for an older component still refuses a mixed release', () => {
  const f = fixture();
  f.plugins[1].version = '0.1.0';
  f.sources['promptobus-native-panel'].resolvedTag = 'bb/v0.1.0';
  const report = inspectInstallation(f.plugins, f.sources, f.identity);
  assert.equal(report.status, 'incomplete');
  assert.deepEqual(report.components[1].issues, ['release-version-mismatch']);
});

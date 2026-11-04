import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../..', import.meta.url));

test('release collection pins external documentation to its clean source and refuses dirty input', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-bb-release-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'source'), collection = path.join(directory, 'collection');
  mkdirSync(fixture);
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    copyFileSync(path.join(source, file), path.join(fixture, file));
  }
  for (const component of ['', 'integrations/bb', 'integrations/bb-native-observer']) {
    symlinkSync(path.join(source, component, 'node_modules'), path.join(fixture, component, 'node_modules'), 'dir');
  }
  const git = args => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']); git(['add', '-A']);
  git(['-c', 'user.name=BB fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Captured release source']);
  const revision = git(['rev-parse', 'HEAD']);
  const command = output => [path.join(fixture, 'scripts/build-bb-release.mjs'), '--directory', output];
  execFileSync(process.execPath, command(collection), { cwd: fixture, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const release = JSON.parse(readFileSync(path.join(collection, 'release.json'), 'utf8'));
  assert.equal(release.sourceRevision, revision);
  assert.equal(release.adapterIdentity.inputs.sourceDirty, false);
  for (const [component, folder] of [['promptobus', 'bb'], ['native-panel', 'bb-native-observer']]) {
    for (const file of ['README.md', 'PLUGIN_OVERVIEW.md']) {
      const text = readFileSync(path.join(collection, 'plugins', component, file), 'utf8');
      assert.doesNotMatch(text, /\]\(\.\.\/\.\.\/(?:docs|scripts)\//);
      const original = readFileSync(path.join(fixture, 'integrations', folder, file), 'utf8');
      for (const [, target] of original.matchAll(/\]\(\.\.\/\.\.\/((?:docs|scripts)\/[^)]+)\)/g)) {
        assert(text.includes(`https://github.com/Velklish/promptobus/blob/${revision}/${target}`), target);
      }
    }
    assert(existsSync(path.join(collection, 'plugins', component, 'host.mjs')));
    assert(existsSync(path.join(collection, 'plugins', component, 'bundle/host.js')));
  }
  assert.equal(git(['tag', '--list']), '', 'building performs no release publication');
  writeFileSync(path.join(fixture, 'README.md'), readFileSync(path.join(fixture, 'README.md'), 'utf8') + '\nUncommitted input\n');
  const refused = spawnSync(process.execPath, command(path.join(directory, 'dirty-collection')), { cwd: fixture, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /requires a clean committed source checkout/);
  assert.equal(existsSync(path.join(directory, 'dirty-collection')), false);
});

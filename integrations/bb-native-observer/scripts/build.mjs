import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(root, '../..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function tree(directory, ignored = []) {
  const entries = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.includes(entry.name)) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file); else entries.push([path.relative(directory, file), digest(readFileSync(file))]);
    }
  };
  visit(directory); return { files: entries.length, sha256: digest(JSON.stringify(entries)) };
}
const git = args => spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
const revision = git(['rev-parse', 'HEAD']), coreDirty = git(['status', '--porcelain', '--', 'src']);
const coreSource = tree(path.join(repository, 'src'));
const pluginSource = tree(root, ['node_modules', 'dist', '.test-build']);
const result = spawnSync(process.env.BB_CLI || 'bb', ['plugin', 'build', root], { stdio: 'inherit' });
if (result.status !== 0) throw new Error(`BB plugin build failed: ${result.error?.message ?? result.signal ?? result.status}`);
assert.deepEqual(tree(path.join(repository, 'src')), coreSource, 'Core source changed during the build');
assert.deepEqual(tree(root, ['node_modules', 'dist', '.test-build']), pluginSource, 'Plugin source changed during the build');
assert.equal(git(['rev-parse', 'HEAD']).stdout, revision.stdout, 'Git revision changed during the build');
const receipt = {
  format: 1, sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
  coreDirty: coreDirty.status === 0 ? coreDirty.stdout.length > 0 : null,
  coreSource, pluginSource,
  host: { sha256: digest(readFileSync(path.join(root, 'dist/host.js'))),
    metadata: JSON.parse(readFileSync(path.join(root, 'dist/host.meta.json'), 'utf8')) },
};
writeFileSync(path.join(root, 'dist/build-provenance.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));

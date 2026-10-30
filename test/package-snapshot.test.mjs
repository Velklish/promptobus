import './home.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { run } from '../lib/exec.js';
import { withPackageSnapshot } from '../scripts/package-snapshot.mjs';
import { packedPaths } from '../scripts/docs-links.mjs';
import { makeSandbox } from './sandbox.mjs';

function fixture() {
  const root = path.join(makeSandbox('promptobus-pack-isolation-'), 'source');
  for (const dir of ['lib', 'docs', 'node_modules', '.private-state', '.claude/worktrees/private']) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'pack-isolation-fixture', version: '1.0.0', files: ['lib', 'docs'],
    scripts: { prepare: 'node prepare.cjs' },
  }) + '\n');
  writeFileSync(path.join(root, 'prepare.cjs'), "require('node:fs').writeFileSync('lib/runtime.js', 'prepared runtime\\n');\n");
  writeFileSync(path.join(root, '.gitignore'), 'lib/runtime.js\nnode_modules/\n.private-state/\n.claude/\n');
  writeFileSync(path.join(root, 'lib/.npmignore'), '*.ts\n');
  writeFileSync(path.join(root, 'lib/runtime.ts'), 'export const runtime = true;\n');
  writeFileSync(path.join(root, 'lib/runtime.js'), 'original runtime\n');
  writeFileSync(path.join(root, 'docs/.npmignore'), 'secret.md\n');
  writeFileSync(path.join(root, 'docs/guide.md'), 'Package guide.\n');
  writeFileSync(path.join(root, 'docs/secret.md'), 'Excluded from the package.\n');
  writeFileSync(path.join(root, '.private-state/sentinel'), 'Private ignored state.\n');
  writeFileSync(path.join(root, '.claude/worktrees/private/sentinel'), 'An unrelated worktree.\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  return root;
}

const runtimeState = (root) => ({
  bytes: readFileSync(path.join(root, 'lib/runtime.js'), 'utf8'),
  mtimeNs: statSync(path.join(root, 'lib/runtime.js'), { bigint: true }).mtimeNs,
});

test('normal pack prepares an owned snapshot while preserving the source and nested ignore rules', () => {
  const root = fixture();
  const before = runtimeState(root);
  const manifest = readFileSync(path.join(root, 'package.json'), 'utf8');
  const output = makeSandbox('promptobus-pack-output-');
  let copied;
  withPackageSnapshot(root, (snapshot) => {
    copied = snapshot;
    assert.equal(readFileSync(path.join(snapshot, 'package.json'), 'utf8'), manifest);
    assert.equal(readFileSync(path.join(snapshot, 'lib/runtime.js'), 'utf8'), before.bytes);
    assert.equal(existsSync(path.join(snapshot, '.private-state')), false);
    assert.equal(existsSync(path.join(snapshot, '.claude')), false);
    assert.equal(existsSync(path.join(snapshot, '.git')), false);
    assert.equal(realpathSync(path.join(snapshot, 'node_modules')), realpathSync(path.join(root, 'node_modules')));
    const packed = run('npm', ['pack', '--json', '--pack-destination', output], { cwd: snapshot, encoding: 'utf8' });
    assert.equal(packed.status, 0, `${packed.error ?? ''}\n${packed.stdout}\n${packed.stderr}`);
    assert.equal(readFileSync(path.join(snapshot, 'lib/runtime.js'), 'utf8'), 'prepared runtime\n');
    const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
    assert.ok(files.includes('lib/runtime.js'));
    assert.ok(files.includes('docs/guide.md'));
    assert.equal(files.includes('lib/runtime.ts'), false);
    assert.equal(files.includes('docs/secret.md'), false);
    assert.equal(readFileSync(path.join(snapshot, 'package.json'), 'utf8'), manifest);
  });
  assert.deepEqual(runtimeState(root), before);
  assert.equal(existsSync(copied), false);
});

test('packedPaths isolates preparation even when npm ignores --ignore-scripts', () => {
  const root = fixture();
  const before = runtimeState(root);
  const files = packedPaths(root);
  assert.ok(files.includes('lib/runtime.js'));
  assert.ok(files.includes('docs/guide.md'));
  assert.equal(files.includes('lib/runtime.ts'), false);
  assert.equal(files.includes('docs/secret.md'), false);
  assert.deepEqual(runtimeState(root), before);
});

test('snapshot paths cannot escape or copy reserved trees', (t) => {
  const root = fixture();
  const owner = path.dirname(root);
  const outsideName = `${path.basename(owner)}-outside.txt`;
  const outside = path.join(path.dirname(owner), outsideName);
  writeFileSync(outside, 'Owned outside bytes.\n', { flag: 'wx' });
  t.after(() => rmSync(outside, { force: true }));
  const before = { bytes: readFileSync(outside), mtimeNs: statSync(outside, { bigint: true }).mtimeNs };
  writeFileSync(path.join(owner, outsideName), 'An escaping copy must not write these bytes.\n');
  writeFileSync(path.join(root, 'node_modules/dependency.txt'), 'A dependency file.\n');
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const relative of [
    `../${outsideName}`, `nested/../../${outsideName}`, `..\\${outsideName}`, outside,
    'C:\\owned\\outside.txt', '.', '', '.git/config', 'nested/../.git/config', 'node_modules/dependency.txt',
  ]) {
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...manifest, files: [relative] }) + '\n');
    let refusal;
    try { withPackageSnapshot(root, () => {}); } catch (error) { refusal = error; }
    assert.deepEqual({ bytes: readFileSync(outside), mtimeNs: statSync(outside, { bigint: true }).mtimeNs }, before, relative);
    assert.match(refusal?.message ?? '', /package snapshot path/, relative);
  }
});

import './home.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeSandbox, stubCommand } from './sandbox.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = realpathSync(makeSandbox('promptobus-test-audit-'));
const repo = path.join(dir, 'repo');
const pack = path.join(dir, 'pack');
const bin = path.join(dir, 'bin');
const tarball = path.join(dir, 'fixture.tgz');
const audit = 'scripts/audit-public.mjs';

function write(parent, file, text) {
  const target = path.join(parent, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

mkdirSync(path.join(repo, 'scripts'), { recursive: true });
mkdirSync(path.join(repo, 'lib'));
copyFileSync(path.join(root, audit), path.join(repo, audit));
copyFileSync(path.join(root, 'lib/exec.js'), path.join(repo, 'lib/exec.js'));
write(repo, 'package.json', '{"type":"module"}\n');

// Keep the real audit's named authoring snapshots non-stale in the miniature repository.
write(repo, 'src/protocol.ts', 'const TRANSLIT = {\n  "\u0430": "a",\n};\n');
write(repo, 'docs/archive/LOG.md', '\u0430\n');
write(repo, 'tracked.txt', 'clean\n');
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['add', '--', 'src', 'docs', 'tracked.txt'], { cwd: repo });

stubCommand(bin, 'npm', `
import { copyFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.join(' ') === 'run build') process.exit(0);
if (args.length !== 3 || args[0] !== 'pack' || args[1] !== '--pack-destination') process.exit(2);
copyFileSync(${JSON.stringify(tarball)}, path.join(args[2], 'fixture.tgz'));
console.log('fixture.tgz');
`);

function runAudit(tracked, packed) {
  write(repo, 'tracked.txt', tracked);
  write(pack, 'package/packed.txt', packed);
  execFileSync('tar', ['-czf', tarball, '-C', pack, 'package']);
  return spawnSync(process.execPath, [path.join(repo, audit)], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
}

test('publicity audit reports a clean tracked tree and tarball', () => {
  const result = runAudit('clean\n', 'clean\n');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /publicity audit: clean .*3 tracked text files and 1 packed text entries/);
});

test('publicity audit exits 1 and names origin and organization leaks on both surfaces', () => {
  const leak = `${['context', 'store'].join('-')} ${['A', 'TI'].join('')}\n`;
  const result = runAudit(leak, leak);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  for (const file of ['tracked.txt', 'tarball:package/packed.txt']) {
    for (const label of ['origin memory service', 'organization brand']) {
      assert.ok(result.stdout.includes(`✖ ${label}: ${file}\n`), result.stdout);
    }
  }
  assert.match(result.stdout, /publicity audit: 4 finding\(s\)/);
});

test('publicity audit refuses the former trace when it returns to a live card', () => {
  const file = 'docs/backlog/queue/PB-278.1-mixed-step7-delivered-after-own-send.md';
  write(repo, file, '✖ step 7: the worker closed the note and sent a second result \u0430\n');
  execFileSync('git', ['add', '--', file], { cwd: repo });

  const result = runAudit('clean\n', 'clean\n');
  assert.ok(result.stdout.includes(`✖ Cyrillic authored text: ${file}:1\n`), result.stdout);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /publicity audit: 1 finding\(s\)/);
});

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import { reviewerFiles, REVIEW_FILE_TOOLS } from '../lib/reviewer-files.js';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-')));
const repo = path.join(root, 'repo');
const outside = path.join(root, 'repo-sibling');
mkdirSync(repo); mkdirSync(outside);
mkdirSync(path.join(repo, 'src')); mkdirSync(path.join(repo, 'node_modules'));
const source = path.join(repo, 'src', 'Example.cs');
writeFileSync(source, 'namespace Test;\n// Мир\npublic int Compute() => 42;\n// a.*b literal\n');
writeFileSync(path.join(repo, 'README.md'), 'Compute\n');
writeFileSync(path.join(repo, 'node_modules', 'ignored.cs'), 'Compute\n');
writeFileSync(path.join(outside, 'private.txt'), 'OUTSIDE\n');
symlinkSync(path.join(outside, 'private.txt'), path.join(repo, 'outside.txt'));
symlinkSync(source, path.join(repo, 'inside.cs'));
symlinkSync(outside, path.join(repo, 'outside-dir'));
symlinkSync(repo, path.join(repo, 'cycle'));
writeFileSync(path.join(repo, 'binary.dat'), Buffer.from([1, 0, 2]));
const read = reviewerFiles([repo]);
after(() => rmSync(root, { recursive: true, force: true }));

test('inventory exposes only three non-destructive local reads', () => {
  assert.deepEqual(REVIEW_FILE_TOOLS.map((x) => x.name), ['read_file', 'list_files', 'search_text']);
  assert.ok(REVIEW_FILE_TOOLS.every((x) => x.annotations.readOnlyHint && !x.annotations.destructiveHint && !x.annotations.openWorldHint));
});
test('reads current uncommitted text with Unicode and line pagination', () => {
  const result = read('read_file', { path: source, start_line: 2, line_count: 2 });
  assert.deepEqual(result.lines, [{ line: 2, text: '// Мир' }, { line: 3, text: 'public int Compute() => 42;' }]);
  writeFileSync(source, 'namespace Test;\n// Мир\npublic int Compute() => 43;\n// a.*b literal\n');
  assert.match(read('read_file', { path: source }).lines[2].text, /43/);
});
test('lists glob paths, skips generated dependencies and symlink directory cycles', () => {
  const result = read('list_files', { path: repo, pattern: '**/*.cs' });
  assert.deepEqual(result.matches.map((x) => x.relative_path), ['src/Example.cs']);
});
test('searches literals rather than interpreting a regular expression', () => {
  assert.equal(read('search_text', { path: repo, query: 'a.*b' }).matches.length, 1);
  assert.equal(read('search_text', { path: repo, query: 'compute', case_sensitive: false }).matches.length, 2);
  assert.equal(read('search_text', { path: repo, query: 'compute' }).matches.length, 0);
});
test('declared result limit bounds returned matches', () => {
  const result = read('search_text', { path: repo, query: 'Compute', limit: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, true);
});
test('refuses path traversal, similarly prefixed siblings and escaping symlinks', () => {
  for (const target of [path.join(repo, '..', 'repo-sibling', 'private.txt'), path.join(outside, 'private.txt'), path.join(repo, 'outside.txt')]) {
    assert.throws(() => read('read_file', { path: target }), /outside the declared review roots/);
  }
  assert.throws(() => read('list_files', { path: path.join(repo, 'outside-dir') }), /outside the declared review roots/);
});
test('allows a symlink whose resolved text file remains in a declared root', () => {
  assert.equal(read('read_file', { path: path.join(repo, 'inside.cs') }).path, source);
});
test('refuses mutation or execution tool names before touching filesystem', () => {
  for (const name of ['write_file', 'delete_file', 'exec_command', 'shell']) assert.throws(() => read(name, { path: source }), /Unknown read-only tool/);
});
test('requires explicit roots and absolute paths', () => {
  for (const roots of [[], null, ['relative'], [42]]) assert.throws(() => reviewerFiles(roots), /non-empty array of absolute paths/);
  assert.throws(() => read('read_file', { path: 'src/Example.cs' }), /path must be absolute/);
});
test('binary reads and invalid bounds are reported as errors', () => {
  assert.throws(() => read('read_file', { path: path.join(repo, 'binary.dat') }), /Binary files/);
  assert.throws(() => read('read_file', { path: source, start_line: 0 }), /start_line/);
  assert.throws(() => read('read_file', { path: source, line_count: 2001 }), /line_count/);
  assert.throws(() => read('search_text', { path: repo, query: '' }), /non-empty literal/);
});
test('stdio MCP handshake, tool read and forbidden path complete without command tools', () => {
  const requests = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: source } } },
    { id: 4, method: 'tools/call', params: { name: 'read_file', arguments: { path: path.join(repo, 'outside.txt') } } },
  ];
  const child = spawnSync(process.execPath, [new URL('../lib/reviewer-files.js', import.meta.url).pathname], {
    input: requests.map((x) => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PROMPTOBUS_REVIEW_READ_ROOTS: JSON.stringify([repo]) },
  });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split('\n').map((x) => JSON.parse(x));
  assert.equal(replies.length, 4);
  assert.equal(replies[1].result.tools.length, 3);
  assert.match(replies[2].result.content[0].text, /Compute/);
  assert.equal(replies[3].result.isError, true);
});

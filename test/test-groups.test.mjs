import './home.mjs';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { makeSandbox } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const selector = await import('./groups.mjs').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return null;
});
const files = ['cli.test.mjs', 'model-routing-calibrate.test.mjs',
  'model-routing-resolver.test.mjs', 'promptobus-review.test.mjs',
  'reviewer-files.test.mjs', 'store.test.mjs', 'v1-engine.test.mjs', 'v1-validate.test.mjs'];
const select = (paths) => {
  assert.ok(selector, 'local test selection is unavailable');
  return selector.selectTests(paths, files);
};

test('one subsystem selects its group and reports omitted groups and files', () => {
  const plan = select(['test/model-routing-calibrate.test.mjs']);
  assert.equal(plan.full, false);
  assert.deepEqual(plan.selectedGroups, ['model-routing']);
  assert.deepEqual(plan.files, ['model-routing-calibrate.test.mjs', 'model-routing-resolver.test.mjs']);
  assert.deepEqual(plan.omittedGroups, ['integration', 'reviewer-files', 'store']);
  assert.equal(plan.omittedFiles.length, 6);
});

test('a known production dependency selects routing and CLI integration together', () => {
  const plan = select(['lib/model-routing/calibrate.js']);
  assert.equal(plan.full, false);
  assert.deepEqual(plan.selectedGroups, ['integration', 'model-routing']);
  assert.ok(plan.files.includes('model-routing-calibrate.test.mjs'));
  assert.ok(plan.files.includes('cli.test.mjs'));
  assert.ok(plan.files.includes('promptobus-review.test.mjs'));
});

test('shared protocol and transport dependencies require the complete suite', () => {
  for (const rel of ['src/protocol.ts', 'src/v1/model.ts', 'src/mcp/tools.ts', 'lib/exec.js']) {
    const plan = select([rel]);
    assert.equal(plan.full, true, rel);
    assert.deepEqual(plan.files, [...files].sort(), rel);
    assert.deepEqual(plan.omittedGroups, []);
  }
});

test('unmapped production, fixture, runner, config, dependency and documentation changes require full', () => {
  for (const rel of ['lib/new-module.js', 'test/fixtures/model-routing/catalog.json',
    'test/home.mjs', 'test/run.mjs', 'test/groups.mjs', 'scripts/test-local.mjs',
    'package.json', 'package-lock.json', 'backslop.json', 'docs/archive/LOG.md', 'README.md']) {
    const plan = select([rel]);
    assert.equal(plan.full, true, rel);
    assert.ok(plan.reasons.some((reason) => reason.includes(rel)), rel);
  }
});

test('empty input runs the complete suite instead of certifying zero tests', () => {
  assert.equal(select([]).full, true);
  assert.deepEqual(select([]).files, [...files].sort());
});

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function repo() {
  const dir = makeSandbox('promptobus-runner-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  for (const rel of ['lib/fuzzy.js', 'lib/model-routing/calibrate.js', 'test/store.test.mjs']) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), 'export const original = true;\n');
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}
function changes(dir, base) {
  assert.ok(selector, 'local test selection is unavailable');
  return selector.changedPaths(dir, base);
}

test('Git rename selection includes both old and new names and unions groups', () => {
  const { dir, base } = repo();
  git(dir, 'mv', 'test/store.test.mjs', 'test/model-routing-resolver.test.mjs');
  const input = changes(dir, base);
  assert.ok(input.paths.includes('test/store.test.mjs'));
  assert.ok(input.paths.includes('test/model-routing-resolver.test.mjs'));
  assert.deepEqual(select(input.paths).selectedGroups, ['model-routing', 'store']);
});

test('Git deletion retains the removed production path for dependent selection', () => {
  const { dir, base } = repo();
  git(dir, 'rm', '-q', 'lib/model-routing/calibrate.js');
  const input = changes(dir, base);
  assert.ok(input.paths.includes('lib/model-routing/calibrate.js'));
  assert.deepEqual(select(input.paths).selectedGroups, ['integration', 'model-routing']);
});

test('Git selection includes committed, staged, unstaged and untracked dirty input', () => {
  const { dir, base } = repo();
  writeFileSync(path.join(dir, 'lib/fuzzy.js'), 'export const original = false;\n');
  git(dir, 'add', 'lib/fuzzy.js');
  git(dir, 'commit', '-qm', 'change');
  writeFileSync(path.join(dir, 'test/store.test.mjs'), 'export const staged = true;\n');
  git(dir, 'add', 'test/store.test.mjs');
  writeFileSync(path.join(dir, 'lib/model-routing/calibrate.js'), 'export const dirty = true;\n');
  writeFileSync(path.join(dir, 'unknown file\nwith space.js'), 'export const unknown = true;\n');
  const input = changes(dir, base);
  assert.equal(input.base, base);
  assert.deepEqual(input.paths, ['lib/fuzzy.js', 'lib/model-routing/calibrate.js',
    'test/store.test.mjs', 'unknown file\nwith space.js'].sort());
  assert.equal(select(input.paths).full, true);
});

test('invalid explicit Git base refuses before running tests', () => {
  const { dir } = repo();
  assert.throws(() => changes(dir, 'missing-base'), /base/);
});

function runnerCopy() {
  const dir = makeSandbox('promptobus-runner-');
  for (const name of ['run.mjs', 'hygiene.mjs', 'home.mjs', 'check.mjs']) {
    copyFileSync(path.join(here, name), path.join(dir, name));
  }
  const sweep = readFileSync(path.join(here, 'tmpdir-sweep.mjs'), 'utf8')
    .replace("'../scripts/canary-runs.mjs'", JSON.stringify(pathToFileURL(path.join(here, '..', 'scripts/canary-runs.mjs')).href));
  writeFileSync(path.join(dir, 'tmpdir-sweep.mjs'), sweep);
  return dir;
}
function run(dir, names) {
  return spawnSync(process.execPath, [path.join(dir, 'run.mjs'), '--files', ...names],
    { encoding: 'utf8', timeout: 20_000 });
}

test('selected runner files omit unselected failing tests and keep their output counts', () => {
  const dir = runnerCopy();
  writeFileSync(path.join(dir, 'chosen.test.mjs'), "console.log('1/1 passed');\n");
  writeFileSync(path.join(dir, 'omitted.test.mjs'), "console.log('UNSELECTED FILE RAN'); process.exitCode = 1;\n");
  const result = run(dir, ['chosen.test.mjs']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1\/1 test files passed/);
  assert.doesNotMatch(result.stdout, /UNSELECTED FILE RAN/);
});

test('a deliberately broken dependent test is selected and actually reddens its verdict', () => {
  const plan = select(['lib/model-routing/calibrate.js']);
  const dir = runnerCopy();
  for (const name of files) writeFileSync(path.join(dir, name), "console.log('1/1 passed');\n");
  writeFileSync(path.join(dir, 'promptobus-review.test.mjs'),
    "import assert from 'node:assert/strict'; import test from 'node:test'; test('dependent review verdict', () => assert.equal(1, 2));\n");
  const result = run(dir, plan.files);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /dependent review verdict/);
  assert.match(result.stdout, /1 !== 2/);
  assert.match(result.stderr, /1 of 4 files failed/);
  assert.doesNotMatch(result.stdout, /▸ store.test.mjs/);
});

test('runner refuses empty, unknown, duplicate and escaping file selections before execution', () => {
  const dir = runnerCopy();
  writeFileSync(path.join(dir, 'chosen.test.mjs'), "console.log('FILE EXECUTED');\n");
  for (const names of [[], ['missing.test.mjs'], ['../chosen.test.mjs'], ['chosen.test.mjs', 'chosen.test.mjs']]) {
    const result = run(dir, names);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /FILE EXECUTED/);
    assert.match(result.stderr, /selection/);
  }
});

test('default runner still executes every test file and propagates failure', () => {
  const dir = runnerCopy();
  writeFileSync(path.join(dir, 'a.test.mjs'), "console.log('DEFAULT A');\n");
  writeFileSync(path.join(dir, 'b.test.mjs'), "console.log('DEFAULT B'); process.exitCode = 1;\n");
  const result = spawnSync(process.execPath, [path.join(dir, 'run.mjs')], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /DEFAULT A/);
  assert.match(result.stdout, /DEFAULT B/);
});

test('local command requires an explicit base instead of guessing a remote', () => {
  const result = spawnSync(process.execPath, [path.join(here, '..', 'scripts/test-local.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--base/);
});

test('local command executes its selected scope and propagates the dependent failure', () => {
  const dir = runnerCopy();
  mkdirSync(path.join(dir, 'test'));
  mkdirSync(path.join(dir, 'scripts'));
  for (const name of ['run.mjs', 'hygiene.mjs', 'home.mjs', 'check.mjs', 'tmpdir-sweep.mjs']) {
    copyFileSync(path.join(dir, name), path.join(dir, 'test', name));
  }
  copyFileSync(path.join(here, 'groups.mjs'), path.join(dir, 'test/groups.mjs'));
  copyFileSync(path.join(here, '../scripts/test-local.mjs'), path.join(dir, 'scripts/test-local.mjs'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node -e ""' } }));
  for (const name of files) writeFileSync(path.join(dir, 'test', name), "console.log('1/1 passed');\n");
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'local command base');
  const base = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'test/model-routing-calibrate.test.mjs'),
    "import assert from 'node:assert/strict'; import test from 'node:test'; test('local dependent verdict', () => assert.equal(1, 2));\n");
  const invoke = (...args) => spawnSync(process.execPath, [path.join(dir, 'scripts/test-local.mjs'),
    '--base', base, ...args], { encoding: 'utf8', timeout: 20_000 });
  const listed = invoke('--list');
  assert.equal(listed.status, 0, listed.stderr);
  const plan = JSON.parse(listed.stdout);
  assert.deepEqual(plan.selectedGroups, ['model-routing']);
  assert.equal(plan.selectedFileCount, 2);
  assert.equal(plan.omittedFileCount, 6);
  assert.notEqual(plan.dirty, '');
  const result = invoke();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /local dependent verdict/);
  assert.match(result.stdout, /1 !== 2/);
  assert.match(result.stdout, /local command .*test\/run.mjs.*: exit 1/);
  assert.doesNotMatch(result.stdout, /▸ store.test.mjs/);
});

test('local selection is documented with explicit base and full acceptance coverage', () => {
  for (const rel of ['README.md', 'docs/guides/contributing.md', 'docs/reference/README.md']) {
    const text = readFileSync(path.join(here, '..', rel), 'utf8');
    assert.match(text, /npm run test:local -- --base <commit>/, rel);
    assert.match(text, /full (?:suite|acceptance)/, rel);
  }
});

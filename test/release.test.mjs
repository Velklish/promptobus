import './home.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/exec.js';
import { makeSandbox, stubCommand } from './sandbox.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gates = ['npm test', 'npx --no-install backslop lint', 'npm run audit', 'npm run pins', 'npm run codex-schema'];
const metadata = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'docs/reference/01-overview.md',
  'README.md', 'docs/guides/install.md', 'skills/orchestrate/SKILL.md'];
const read = (file) => readFileSync(file, 'utf8');

function fixture() {
  const owner = makeSandbox('promptobus-release-fixture-');
  const root = path.join(owner, 'source');
  const file = path.join(owner, 'receipts', 'candidate.json');
  const put = (name, text) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  put('package.json', JSON.stringify({ name: 'release-fixture', type: 'module', version: '1.0.0', scripts: {
    release: 'node scripts/release.mjs', ...Object.fromEntries(['build', 'test', 'audit', 'pins', 'codex-schema']
      .map((name) => [name, `node check.cjs ${name}`])),
  } }, null, 2) + '\n');
  put('package-lock.json', JSON.stringify({ version: '1.0.0', packages: { '': { version: '1.0.0' } } }, null, 2) + '\n');
  put('backslop.json', JSON.stringify({ gates }));
  put('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n- New behavior.\n\n## [1.0.0] — 2026-01-01\n');
  put('docs/reference/01-overview.md', 'Version in `package.json` is `0.8.0`.\n');
  put('README.md', 'https://github.com/Velklish/promptobus/blob/v0.7.0/docs/README.md\nnpm install github:Velklish/promptobus#v0.7.0\n');
  put('docs/guides/install.md', 'npm install -g github:Velklish/promptobus#v0.9.0\n');
  put('skills/orchestrate/SKILL.md', 'https://github.com/Velklish/promptobus/blob/v0.6.0/docs/README.md\n');
  put('.gitignore', '.fixture/\nnode_modules/\n');
  put('check.cjs', `const fs = require('node:fs');
const cp = require('node:child_process');
const name = process.argv[2];
const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
fs.appendFileSync('.fixture/trace', JSON.stringify({name,head,version:require('./package.json').version})+'\\n');
console.log('checked '+name);
if(name==='test') { console.log('↷ SKIP fixture optional body — deliberate fixture'); console.log('installed comparison notRun: fixture optional binary missing'); }
if(fs.existsSync('.fixture/dirty') && name==='build') fs.appendFileSync('README.md','dirty\\n');
process.exitCode = fs.existsSync('.fixture/fail') && name==='test' ? 7 : 0;
`);
  put('scripts/release.mjs', read(path.join(repo, 'scripts/release.mjs')));
  put('lib/exec.js', read(path.join(repo, 'lib/exec.js')));
  const exec = (argv, env = {}) => run(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_GLOBAL: path.join(owner, 'no-global'), GIT_CONFIG_SYSTEM: path.join(owner, 'no-system'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', ...env }, timeout: 60_000 });
  const git = (...args) => {
    const result = exec(['git', ...args]);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'fixture base');
  git('tag', '-a', 'v1.0.0', '-m', 'previous release');
  mkdirSync(path.join(root, '.fixture'));
  stubCommand(path.join(root, 'node_modules/.bin'), 'npx', String.raw`
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
assert.deepEqual(process.argv.slice(2), ['--no-install', 'backslop', 'lint']);
appendFileSync('.fixture/trace', JSON.stringify({name:'lint'})+'\n');
console.log('fixture lint');
`);
  const command = (args, env) => exec(['npm', 'run', 'release', '--', ...args], env);
  const prepare = (receipt = file, version = '1.1.0', date = '2026-11-13') => command(['prepare', version, '--date', date, '--receipt', receipt]);
  const verify = (env) => command(['verify', '--receipt', file], env);
  const receipt = () => JSON.parse(read(file));
  const trace = () => existsSync(path.join(root, '.fixture/trace')) ? read(path.join(root, '.fixture/trace')).trim().split('\n').map(JSON.parse) : [];
  return { owner, root, file, put, git, command, prepare, verify, receipt, trace };
}
const passed = (result) => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const refused = (result, message) => {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, message);
};

test('guide commands repair stale metadata over an exact previous tag, commit first, and retry without commits or tags', () => {
  const f = fixture();
  const base = f.git('rev-parse', 'HEAD');
  passed(f.prepare());
  const candidate = f.git('rev-parse', 'HEAD');
  assert.notEqual(candidate, base);
  assert.deepEqual(f.git('diff', '--name-only', base, candidate).split('\n').sort(), [...metadata].sort());
  assert.equal(f.git('log', '-1', '--format=%s'), 'promptobus 1.1.0');
  assert.equal(f.git('rev-parse', 'HEAD^'), base);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.ok(f.receipt().steps.every((step) => step.status === 'notRun'));
  assert.deepEqual(f.trace(), []);
  passed(f.prepare());
  passed(f.verify());
  assert.ok(f.trace().filter((entry) => entry.head).every((entry) => entry.head === candidate && entry.version === '1.1.0'));
  const receipt = f.receipt();
  assert.deepEqual(receipt.source, { commit: candidate, tree: f.git('rev-parse', 'HEAD^{tree}') });
  assert.equal(receipt.steps.length, 6);
  assert.ok(receipt.steps.every((step) => step.status === 'passed' && step.attempts.length === 1
    && step.attempts[0].exitCode === 0 && step.attempts[0].elapsedMs >= 0 && existsSync(step.attempts[0].stdout)));
  assert.equal(receipt.skips.length, 1);
  assert.equal(receipt.steps[1].attempts[0].notRun.length, 1);
  assert.equal(receipt.publication.status, 'notRun');
  assert.ok(receipt.context.node && receipt.context.tmpdir && receipt.context.tools.npm.sha256);
  const ran = f.trace().length;
  passed(f.verify({ UNRELATED_RELEASE_VARIABLE: 'different, not recorded' }));
  passed(f.prepare());
  assert.equal(f.trace().length, ran);
  assert.equal(f.git('rev-parse', 'HEAD'), candidate);
  assert.equal(f.git('tag', '--list'), 'v1.0.0');
});

test('failure retains exact exit/logs and notRun steps, then retries only failed and unreached commands', () => {
  const f = fixture();
  passed(f.prepare());
  f.put('.fixture/fail', 'yes');
  const result = f.verify();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(f.receipt().steps.map((step) => step.status), ['passed', 'failed', 'notRun', 'notRun', 'notRun', 'notRun']);
  assert.equal(f.receipt().steps[1].attempts[0].exitCode, 7);
  assert.match(read(f.receipt().steps[1].attempts[0].stdout), /checked test/);
  rmSync(path.join(f.root, '.fixture/fail'));
  passed(f.verify());
  assert.deepEqual(f.receipt().steps.map((step) => step.attempts.length), [1, 2, 1, 1, 1, 1]);
  assert.equal(f.trace().filter((entry) => entry.name === 'build').length, 1);
});

test('an interrupted running receipt does not pass and gets a fresh attempt', () => {
  const f = fixture();
  passed(f.prepare());
  const receipt = f.receipt();
  receipt.steps[0].status = 'running';
  receipt.steps[0].attempts.push({ argv: receipt.steps[0].argv, exitCode: null, signal: null });
  writeFileSync(f.file, JSON.stringify(receipt));
  passed(f.verify());
  assert.equal(f.receipt().steps[0].attempts.length, 2);
  assert.equal(f.receipt().steps[0].attempts[0].exitCode, null);
});

test('preparation recovers a committed candidate whose receipt was lost', () => {
  const f = fixture();
  passed(f.prepare());
  const head = f.git('rev-parse', 'HEAD');
  rmSync(f.file);
  passed(f.prepare());
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.receipt().source.commit, head);
  refused(f.prepare(f.file, '1.2.0'), /Candidate receipt mismatch/);
  refused(f.prepare(f.file, '1.1.0', '2026-11-14'), /Candidate receipt mismatch/);
});

test('receipt recovery refuses an amended candidate containing unrelated source', () => {
  const f = fixture();
  passed(f.prepare());
  rmSync(f.file);
  f.put('unrelated.cjs', 'module.exports = true;');
  f.git('add', 'unrelated.cjs');
  f.git('commit', '--amend', '--no-edit', '-q');
  const head = f.git('rev-parse', 'HEAD');
  refused(f.prepare(), /outside release metadata/);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.deepEqual(f.trace(), []);
});

for (const [file, replacement, diagnostic] of [
  ['docs/reference/01-overview.md', 'Version in `package.json` is `0.0.1`.', /Overview version disagrees/],
  ['docs/guides/install.md', 'npm install github:Velklish/promptobus#v0.0.1', /Release-pinned links disagree/],
  ['package-lock.json', '{"version":"1.1.0","packages":{"":{"version":"0.0.1"}}}', /Package and lock versions disagree/],
  ['CHANGELOG.md', '## [1.0.0] — 2026-11-13\n', /First changelog release disagrees/],
]) test(`inconsistent ${file} refuses before the sentinel suite`, () => {
  const f = fixture();
  passed(f.prepare());
  f.put(file, replacement);
  f.git('add', file);
  f.git('commit', '--amend', '--no-edit', '-q');
  const receipt = f.receipt();
  receipt.source = { commit: f.git('rev-parse', 'HEAD'), tree: f.git('rev-parse', 'HEAD^{tree}') };
  writeFileSync(f.file, JSON.stringify(receipt));
  refused(f.verify(), diagnostic);
  assert.deepEqual(f.trace(), []);
});

test('dirty candidate and unrelated new commit refuse reuse and preparation', () => {
  const f = fixture();
  passed(f.prepare());
  f.put('unrelated.txt', 'unrelated');
  refused(f.verify(), /clean committed tree/);
  refused(f.prepare(), /clean committed tree/);
  f.git('add', 'unrelated.txt');
  f.git('commit', '-qm', 'unrelated');
  refused(f.verify(), /Candidate source mismatch/);
  refused(f.prepare(), /Candidate receipt mismatch/);
  assert.deepEqual(f.trace(), []);
});

test('changed command or required runtime invalidates reuse, while a fresh receipt reruns all checks', () => {
  const f = fixture();
  passed(f.prepare());
  passed(f.verify());
  const saved = read(f.file);
  const receipt = f.receipt();
  receipt.steps[0].argv = ['npm', 'run', 'other'];
  writeFileSync(f.file, JSON.stringify(receipt));
  refused(f.verify(), /command argv mismatch/);
  writeFileSync(f.file, saved);
  receipt.context = { ...f.receipt().context, node: 'v0.0.0' };
  receipt.steps[0].argv = ['npm', 'run', 'build'];
  writeFileSync(f.file, JSON.stringify(receipt));
  refused(f.verify(), /runtime\/environment mismatch/);
  writeFileSync(f.file, saved);
  refused(f.verify({ CI: process.env.CI === 'true' ? 'false' : 'true' }), /runtime\/environment mismatch/);
  const temporary = path.join(f.owner, 'another-temporary-directory');
  mkdirSync(temporary);
  refused(f.verify({ TMPDIR: temporary, TMP: temporary, TEMP: temporary }), /runtime\/environment mismatch/);
  assert.equal(f.trace().length, 6);
  const head = f.git('rev-parse', 'HEAD');
  const fresh = path.join(f.owner, 'receipts', 'fresh.json');
  passed(f.prepare(fresh));
  passed(f.command(['verify', '--receipt', fresh]));
  assert.equal(f.trace().length, 12);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
});

test('a command dirtying source is never saved as a reusable success', () => {
  const f = fixture();
  passed(f.prepare());
  f.put('.fixture/dirty', 'yes');
  refused(f.verify(), /clean committed tree/);
  assert.equal(f.receipt().steps[0].status, 'failed');
  assert.equal(f.receipt().steps[0].attempts[0].exitCode, 0);
  assert.equal(f.receipt().steps[1].status, 'notRun');
});

test('missing/conflicting refs, missing/untracked metadata and unsafe receipt paths refuse without publication', () => {
  const f = fixture();
  f.git('tag', '-d', 'v1.0.0');
  passed(f.prepare());
  assert.equal(f.git('tag', '--list'), '');
  f.git('tag', 'v1.1.0', 'HEAD^');
  refused(f.verify(), /Release tag already exists/);
  assert.equal(f.git('rev-parse', 'v1.1.0'), f.git('rev-parse', 'HEAD^'));
  const target = fixture();
  target.git('tag', 'v1.1.0');
  refused(target.prepare(), /Release tag already exists/);
  const missing = fixture();
  missing.git('rm', '-q', 'docs/guides/install.md');
  missing.git('commit', '-qm', 'missing metadata');
  refused(missing.prepare(), /Missing release metadata/);
  missing.put('docs/guides/install.md', 'github:Velklish/promptobus#v1.0.0');
  missing.git('add', '.gitignore');
  missing.put('.gitignore', '.fixture/\nnode_modules/\ndocs/guides/install.md\n');
  missing.git('add', '.gitignore');
  missing.git('commit', '-qm', 'ignore untracked metadata');
  refused(missing.prepare(), /ls-files --error-unmatch/);
  const inside = fixture();
  refused(inside.prepare(path.join(inside.root, '.fixture/receipt.json')), /outside all worktrees/);
  refused(inside.prepare('relative.json'), /absolute --receipt/);
  refused(inside.prepare(inside.file, '1.1.0', '2026-02-31'), /Use --date/);
  assert.deepEqual(f.trace(), []);
});

test('release guide orders writer, committed candidate, verification and publication and uses the tested interface', () => {
  const guide = read(path.join(repo, 'docs/guides/releasing.md'));
  const stages = ['## Technical-writer pass', '## Release commit', '## Verification', '## Publication acceptance'];
  assert.ok(stages.every((stage, index) => guide.includes(stage) && (!index || guide.indexOf(stage) > guide.indexOf(stages[index - 1]))));
  assert.match(guide, /npm run release -- prepare 0\.33\.0 --date 2026-11-13 --receipt \/durable\/releases\/promptobus-0\.33\.0\.json/);
  assert.match(guide, /npm run release -- verify --receipt \/durable\/releases\/promptobus-0\.33\.0\.json/);
  assert.match(guide, /An absent future tag never counts as a successful remote installation check/);
  assert.equal(JSON.parse(read(path.join(repo, 'package.json'))).scripts.release, 'node scripts/release.mjs');
});

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as launch, wouldResolve } from '../lib/exec.js';

const root = realpathSync(process.cwd());
const links = ['README.md', 'docs/guides/install.md', 'skills/orchestrate/SKILL.md'];
const metadata = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'docs/reference/01-overview.md', ...links];
const commands = [['npm', 'run', 'build'], ['npm', 'test'], ['npx', '--no-install', 'backslop', 'lint'],
  ['npm', 'run', 'audit'], ['npm', 'run', 'pins'], ['npm', 'run', 'codex-schema']];
const blob = /https:\/\/github\.com\/Velklish\/promptobus\/blob\/v\d+\.\d+\.\d+\//g;
const install = /github:Velklish\/promptobus#v\d+\.\d+\.\d+/g;
const overview = /Version in `package\.json` is `([^`]+)`/g;
const heading = /^## \[([^\]]+)\] — (\d{4}-\d{2}-\d{2})$/m;
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

function run(argv) {
  const result = launch(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8' });
  requireThat(result.status === 0, `${argv.join(' ')}: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout.trim();
}
const git = (...args) => run(['git', ...args]);
const source = () => ({ commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') });
const clean = () => requireThat(!git('status', '--porcelain', '--untracked-files=all'), 'Release requires a clean committed tree');

function checkMetadata(version, date) {
  const lock = json('package-lock.json');
  requireThat(json('package.json').version === version && lock.version === version
    && lock.packages?.['']?.version === version, 'Package and lock versions disagree');
  const versions = [...read('docs/reference/01-overview.md').matchAll(overview)];
  requireThat(versions.length === 1 && versions[0][1] === version, 'Overview version disagrees');
  const release = read('CHANGELOG.md').match(heading);
  requireThat(release?.[1] === version && release?.[2] === date
    && !/^## \[Unreleased\]$/m.test(read('CHANGELOG.md')), 'First changelog release disagrees');
  for (const file of links) {
    const text = read(file);
    const pins = [...text.matchAll(blob), ...text.matchAll(install)].map((match) => match[0]);
    requireThat(pins.length > 0 && pins.every((pin) => pin.includes(`/v${version}/`) || pin.endsWith(`#v${version}`)),
      `Release-pinned links disagree: ${file}`);
  }
}

function tagCheck(version, commit = null) {
  const ref = `refs/tags/v${version}`;
  const found = spawnSync('git', ['show-ref', '--verify', '--quiet', ref], { cwd: root });
  requireThat(found.status === 1 || (found.status === 0 && commit && git('rev-parse', `${ref}^{commit}`) === commit),
    `Release tag already exists or cannot be inspected: ${ref}`);
}

function save(file, receipt) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function prepare(version, date, file) {
  requireThat(/^\d+\.\d+\.\d+$/.test(version ?? ''), 'Use a stable X.Y.Z version');
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') && !Number.isNaN(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date, 'Use --date YYYY-MM-DD');
  clean();
  for (const name of metadata) {
    requireThat(existsSync(path.join(root, name)), `Missing release metadata: ${name}`);
    git('ls-files', '--error-unmatch', '--', name);
  }
  const head = source();
  if (existsSync(file)) {
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    requireThat(receipt.format === 1 && receipt.version === version && receipt.date === date
      && same(receipt.source, head), 'Candidate receipt mismatch');
    checkMetadata(version, date);
    tagCheck(version, head.commit);
    return receipt;
  }
  tagCheck(version);
  const message = `promptobus ${version}`;
  let base = head.commit;
  if (git('log', '-1', '--format=%s') === message) {
    checkMetadata(version, date);
    const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n');
    requireThat(changed.length > 0 && changed.every((name) => metadata.includes(name)),
      'Candidate commit contains paths outside release metadata');
    base = git('rev-parse', 'HEAD^');
  } else {
    const current = json('package.json').version;
    const compare = version.split('.').map(Number);
    const previous = current.split('.').map(Number);
    const first = compare.findIndex((value, index) => value !== previous[index]);
    requireThat(/^\d+\.\d+\.\d+$/.test(current) && first >= 0 && compare[first] > previous[first],
      'Requested version must be newer than package.json');
    const texts = new Map(metadata.map((name) => [name, read(name)]));
    const pkg = JSON.parse(texts.get('package.json'));
    const lock = JSON.parse(texts.get('package-lock.json'));
    requireThat(typeof lock.packages?.['']?.version === 'string', 'Missing lock root version');
    pkg.version = lock.version = lock.packages[''].version = version;
    texts.set('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    texts.set('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
    requireThat([...texts.get('docs/reference/01-overview.md').matchAll(overview)].length === 1, 'Missing unique overview version');
    texts.set('docs/reference/01-overview.md', texts.get('docs/reference/01-overview.md').replace(overview, `Version in \`package.json\` is \`${version}\``));
    requireThat((texts.get('CHANGELOG.md').match(/^## \[Unreleased\]$/gm) ?? []).length === 1, 'Expected one Unreleased heading');
    texts.set('CHANGELOG.md', texts.get('CHANGELOG.md').replace(/^## \[Unreleased\]$/m, `## [${version}] — ${date}`));
    for (const name of links) texts.set(name, texts.get(name)
      .replace(blob, `https://github.com/Velklish/promptobus/blob/v${version}/`)
      .replace(install, `github:Velklish/promptobus#v${version}`));
    for (const [name, text] of texts) writeFileSync(path.join(root, name), text);
    checkMetadata(version, date);
    git('add', '--', ...metadata);
    git('commit', '-m', message);
  }
  clean();
  const receipt = { format: 1, version, date, base, source: source(), context: null,
    steps: commands.map((argv) => ({ argv, status: 'notRun', reason: 'Verification has not reached this command', attempts: [] })),
    skips: [], publication: { status: 'notRun', reason: 'Tag creation, remote installation and publication are separate acceptance steps' } };
  save(file, receipt);
  return receipt;
}

function context() {
  const environment = Object.fromEntries(['PATH', 'NODE_OPTIONS', 'NODE_PATH', 'CI', 'PROMPTOBUS_TEST_POOL', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP']
    .map((key) => [key, process.env[key] ?? null]));
  const tools = Object.fromEntries(['npm', 'npx', 'git', 'codex'].map((name) => {
    const resolved = wouldResolve(name, process.env, root);
    return [name, resolved ? { path: realpathSync(resolved), sha256: hash(readFileSync(resolved)) } : null];
  }));
  return { node: process.version, executable: process.execPath, nodeSha256: hash(readFileSync(process.execPath)),
    npm: run(['npm', '--version']), git: git('--version'), platform: process.platform, arch: process.arch,
    osRelease: os.release(), tools, tmpdir: realpathSync(os.tmpdir()), environmentSha256: hash(JSON.stringify(environment)),
    dependenciesSha256: existsSync(path.join(root, 'node_modules/.package-lock.json')) ? hash(read('node_modules/.package-lock.json')) : null };
}

function verify(file) {
  clean();
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  requireThat(receipt.format === 1 && same(receipt.source, source()), 'Candidate source mismatch');
  checkMetadata(receipt.version, receipt.date);
  tagCheck(receipt.version, receipt.source.commit);
  requireThat(same(json('backslop.json').gates, commands.slice(1).map((argv) => argv.join(' ')))
    && same(receipt.steps.map((step) => step.argv), commands), 'Verification command argv mismatch');
  requireThat(receipt.steps.every((step) => step.status !== 'passed'
    || (step.attempts.at(-1)?.exitCode === 0 && step.attempts.at(-1)?.signal === null
      && same(step.attempts.at(-1)?.argv, step.argv))), 'Invalid successful command receipt');
  const runtime = context();
  requireThat(receipt.context === null || same(receipt.context, runtime), 'Verification runtime/environment mismatch; retain this receipt and prepare a new receipt for a fresh verification');
  receipt.context = runtime;
  save(file, receipt);
  for (const [index, step] of receipt.steps.entries()) {
    if (step.status === 'passed') continue;
    const attempt = { argv: step.argv, started: new Date().toISOString(), exitCode: null, signal: null, elapsedMs: null,
      stdout: `${file}.${index}.${step.attempts.length}.stdout`, stderr: `${file}.${index}.${step.attempts.length}.stderr` };
    step.status = 'running';
    delete step.reason;
    step.attempts.push(attempt);
    save(file, receipt);
    const out = openSync(attempt.stdout, 'wx', 0o600);
    const err = openSync(attempt.stderr, 'wx', 0o600);
    const start = performance.now();
    let result;
    try {
      result = launch(step.argv[0], step.argv.slice(1), { cwd: root, stdio: ['ignore', out, err], timeout: 0 });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    attempt.elapsedMs = Math.round(performance.now() - start);
    attempt.exitCode = result.status;
    attempt.signal = result.signal;
    if (result.error) attempt.error = result.error.message;
    const lines = `${readFileSync(attempt.stdout, 'utf8')}\n${readFileSync(attempt.stderr, 'utf8')}`.split(/\r?\n/);
    attempt.skips = lines.filter((line) => line.startsWith('↷ SKIP ') || /# SKIP\b|^(?:# |ℹ )(?:skipped|todo) [1-9]/.test(line));
    attempt.notRun = lines.filter((line) => /\bnotRun:/.test(line));
    receipt.skips = receipt.steps.flatMap((entry) => entry.attempts.at(-1)?.skips ?? []);
    step.status = 'failed';
    save(file, receipt);
    try {
      clean();
      requireThat(same(receipt.source, source()) && same(runtime, context()), 'Source or runtime changed during verification');
    } catch (error) {
      step.reason = error.message;
      save(file, receipt);
      throw error;
    }
    step.status = result.status === 0 ? 'passed' : 'failed';
    save(file, receipt);
    console.log(`${step.argv.join(' ')}: exit ${result.status}, ${attempt.elapsedMs} ms`);
    if (step.status !== 'passed') return 1;
  }
  console.log(`Verified candidate ${receipt.source.commit}; publication notRun`);
  return 0;
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  const version = action === 'prepare' ? args.shift() : undefined;
  requireThat(action === 'prepare' || action === 'verify', 'Use prepare X.Y.Z --date YYYY-MM-DD --receipt /durable/candidate.json, or verify --receipt /durable/candidate.json');
  const options = {};
  while (args.length) {
    const key = args.shift();
    requireThat(['--receipt', ...(action === 'prepare' ? ['--date'] : [])].includes(key)
      && !Object.hasOwn(options, key) && args.length, `Unknown, duplicate or incomplete option: ${key}`);
    options[key] = args.shift();
  }
  requireThat(realpathSync(git('rev-parse', '--show-toplevel')) === root, 'Run from the repository root');
  requireThat(path.isAbsolute(options['--receipt'] ?? ''), 'Use an absolute --receipt path outside all worktrees');
  const requested = options['--receipt'];
  mkdirSync(path.dirname(requested), { recursive: true });
  const file = path.join(realpathSync(path.dirname(requested)), path.basename(requested));
  const worktrees = git('worktree', 'list', '--porcelain', '-z').split('\0').filter((value) => value.startsWith('worktree ')).map((value) => value.slice(9));
  requireThat(worktrees.every((tree) => { const rel = path.relative(realpathSync(tree), file); return rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel); }),
    'Receipt must be outside all worktrees');
  requireThat(!existsSync(file) || realpathSync(file) === file, 'Receipt cannot be a symlink');
  const lock = `${file}.lock`;
  mkdirSync(lock);
  try {
    if (action === 'prepare') {
      const receipt = prepare(version, options['--date'], file);
      console.log(`Prepared candidate ${receipt.source.commit}; receipt ${file}; prepare does not run verification`);
      return 0;
    }
    return verify(file);
  } finally {
    rmSync(lock, { recursive: true });
  }
}

try { process.exitCode = main(); }
catch (error) { console.error(`Release refused: ${error.message}`); process.exitCode = 1; }

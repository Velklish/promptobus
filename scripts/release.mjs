import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const repository = 'Velklish/promptobus';
const remote = `https://github.com/${repository}.git`;
const requiredSteps = ['Install and check tmux', 'Install dependencies', 'Install ast-grep', 'Build', 'Test',
  'Publicity audit', 'Pin gate', 'backslop init', 'backslop lint'];

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

function candidate(file) {
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
  return receipt;
}

function verify(file) {
  const receipt = candidate(file);
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

function publicRefs(version) {
  const tag = `refs/tags/v${version}`;
  return Object.fromEntries(git('ls-remote', remote, 'refs/heads/main', tag, `${tag}^{}`)
    .split('\n').filter(Boolean).map((line) => { const [sha, ref] = line.split('\t'); return [ref, sha]; }));
}

function localTag(receipt) {
  const tag = `refs/tags/v${receipt.version}`;
  requireThat(git('cat-file', '-t', tag) === 'tag'
    && git('rev-parse', `${tag}^{commit}`) === receipt.source.commit
    && git('for-each-ref', '--format=%(contents)', tag) === `promptobus ${receipt.version}`,
  'Release tag must be the unchanged annotated candidate tag');
  return git('rev-parse', tag);
}

function qualify(receipt, file, id) {
  requireThat(/^[1-9]\d*$/.test(id ?? ''), 'Use --run with the candidate main CI run id');
  const api = (endpoint, paginate = false) => JSON.parse(run(['gh', 'api', '--hostname', 'github.com',
    ...(paginate ? ['--paginate', '--slurp'] : []), `repos/${repository}/${endpoint}`]));
  const workflow = api('actions/workflows/ci.yml');
  const current = () => api(`actions/runs/${id}`);
  const ci = current();
  const prefix = `${file}.linux.${id}.${randomUUID()}`;
  save(`${prefix}.json`, { workflow, run: ci });
  requireThat(workflow.path === '.github/workflows/ci.yml' && workflow.state === 'active'
    && ci.id === Number(id) && ci.workflow_id === workflow.id && ci.path === workflow.path && ci.name === 'ci'
    && ci.repository?.full_name === repository && ci.head_repository?.full_name === repository
    && ci.event === 'push' && ci.head_branch === 'main' && ci.head_sha === receipt.source.commit,
  'Linux CI repository/workflow/main candidate SHA mismatch');
  requireThat(ci.status === 'completed' && ci.conclusion === 'success'
    && Number.isSafeInteger(ci.run_attempt) && ci.run_attempt > 0, 'Linux CI must be completed with success');
  const pages = api(`actions/runs/${id}/attempts/${ci.run_attempt}/jobs?per_page=100`, true);
  const jobs = pages.flatMap((page) => page.jobs);
  save(`${prefix}.json`, { workflow, run: ci, jobs });
  requireThat(jobs.length === 1 && jobs[0].name === 'Node 26 / ubuntu-latest'
    && Number.isSafeInteger(jobs[0].id) && jobs[0].id > 0
    && jobs[0].head_sha === receipt.source.commit && jobs[0].run_id === ci.id
    && jobs[0].status === 'completed' && jobs[0].conclusion === 'success'
    && jobs[0].labels?.includes('ubuntu-latest'), 'Missing successful required Linux job');
  for (const name of requiredSteps) {
    const steps = jobs[0].steps.filter((step) => step.name === name);
    requireThat(steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'success',
      `Missing successful required Linux step: ${name}`);
  }
  const argv = ['gh', 'api', '--hostname', 'github.com', `repos/${repository}/actions/jobs/${jobs[0].id}/logs`];
  const download = launch(argv[0], argv.slice(1), { cwd: root, encoding: 'buffer' });
  const body = download.stdout ?? Buffer.alloc(0);
  writeFileSync(`${prefix}.log`, body, { mode: 0o600 });
  writeFileSync(`${prefix}.stderr`, download.stderr ?? Buffer.alloc(0), { mode: 0o600 });
  save(`${prefix}.json`, { workflow, run: ci, jobs, download: { argv, exitCode: download.status,
    signal: download.signal, error: download.error?.message, bytes: body.length, sha256: hash(body) } });
  requireThat(download.status === 0 && download.signal === null && !download.error,
    `Linux job log download failed: exit ${download.status}, signal ${download.signal}`);
  const logs = body.toString('utf8');
  requireThat(logs.length > 0, 'Linux CI logs are required for skip accounting');
  const lines = logs.split(/\r?\n/).map((line) => line.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z /, ''));
  const testStart = lines.indexOf('##[group]Run npm test');
  const testEnd = lines.findIndex((line, index) => index > testStart && /^([1-9]\d*)\/\1 test files passed(?:;.*)?$/.test(line));
  const cleanup = lines.indexOf('Cleaning up orphan processes', testEnd + 1);
  requireThat(testStart >= 0 && testEnd > testStart && cleanup > testEnd,
    'Incomplete required Linux job log: require Test group, successful file-count footer and job cleanup');
  const after = current();
  requireThat(after.head_sha === ci.head_sha && after.run_attempt === ci.run_attempt
    && after.status === 'completed' && after.conclusion === 'success', 'Linux CI changed during qualification');
  return { runId: ci.id, attempt: ci.run_attempt, jobId: jobs[0].id, sha: ci.head_sha, url: ci.html_url,
    bytes: body.length, sha256: hash(body),
    evidence: `${prefix}.json`, log: `${prefix}.log`,
    skips: logs.split('\n').filter((line) => /↷ SKIP |# SKIP\b|(?:# |ℹ )(?:skipped|todo) [1-9]/.test(line)),
    notRun: logs.split('\n').filter((line) => /\bnotRun:/.test(line)) };
}

function publish(file, id) {
  const receipt = candidate(file);
  const identity = receipt.context;
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => typeof value === 'string' && value.length > 0;
  const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  requireThat(object(identity)
    && ['node', 'executable', 'npm', 'git', 'platform', 'arch', 'osRelease', 'tmpdir'].every((key) => text(identity[key]))
    && ['nodeSha256', 'environmentSha256'].every((key) => digest(identity[key]))
    && Object.hasOwn(identity, 'dependenciesSha256') && (identity.dependenciesSha256 === null || digest(identity.dependenciesSha256))
    && object(identity.tools) && ['npm', 'npx', 'git', 'codex'].every((name) => Object.hasOwn(identity.tools, name)
      && (identity.tools[name] === null || (object(identity.tools[name]) && text(identity.tools[name].path) && digest(identity.tools[name].sha256)))),
  'Completed local receipt requires full runtime identity');
  requireThat(receipt.steps.every((step) => step.status === 'passed'),
    'Complete local candidate verification before publication');
  const qualification = qualify(receipt, file, id);
  clean();
  requireThat(same(receipt.source, source()), 'Candidate source changed after Linux qualification');
  const tag = `refs/tags/v${receipt.version}`;
  const refs = publicRefs(receipt.version);
  requireThat(refs['refs/heads/main'] === receipt.source.commit, 'Public main must still name the qualified candidate');
  if (receipt.publication.object && refs[tag]) requireThat(receipt.publication.object === refs[tag],
    'Published tag is immutable: receipt object mismatch');
  if (refs[tag]) {
    requireThat(refs[`${tag}^{}`] === receipt.source.commit, 'Published tag is immutable: candidate target mismatch');
    if (!spawnSync('git', ['show-ref', '--verify', '--quiet', tag], { cwd: root }).status) {
      requireThat(localTag(receipt) === refs[tag], 'Published tag is immutable: annotated object mismatch');
    } else {
      git('fetch', '--no-tags', remote, `${tag}:${tag}`);
      requireThat(localTag(receipt) === refs[tag], 'Published tag is immutable: annotated object mismatch');
    }
  } else {
    tagCheck(receipt.version, receipt.source.commit);
    if (spawnSync('git', ['show-ref', '--verify', '--quiet', tag], { cwd: root }).status === 1) {
      git('-c', 'tag.gpgSign=false', 'tag', '-a', `v${receipt.version}`, receipt.source.commit, '-m', `promptobus ${receipt.version}`);
    }
    const object = localTag(receipt);
    requireThat(!receipt.publication.object || receipt.publication.object === object,
      'Published tag is immutable: receipt object mismatch');
    receipt.qualification = qualification;
    receipt.publication = { status: 'publishing', tag, object, commit: receipt.source.commit };
    save(file, receipt);
    clean();
    requireThat(same(receipt.source, source()), 'Candidate source changed before tag push');
    git('push', remote, `${tag}:${tag}`);
    const published = publicRefs(receipt.version);
    requireThat(published[tag] === object && published[`${tag}^{}`] === receipt.source.commit,
      'Published tag is immutable: remote object or target mismatch');
  }
  receipt.qualification = qualification;
  receipt.publication = { ...receipt.publication, status: 'published', tag, object: localTag(receipt), commit: receipt.source.commit };
  delete receipt.publication.reason;
  save(file, receipt);
  console.log(`Published ${tag} at ${receipt.source.commit}; Linux ${qualification.url}; installation smoke ${receipt.publication.smoke?.at(-1)?.status ?? 'notRun'}`);
  return 0;
}

function smoke(file) {
  const receipt = candidate(file);
  const publication = receipt.publication;
  const tag = `refs/tags/v${receipt.version}`;
  const checkRef = () => {
    const refs = publicRefs(receipt.version);
    requireThat(refs[tag] === publication.object && refs[`${tag}^{}`] === receipt.source.commit,
      'Published tag is immutable: remote object or target mismatch');
  };
  requireThat(publication.status === 'published', 'Publish the candidate before installation smoke');
  checkRef();
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'promptobus-release-install-')));
  const attempt = { status: 'running', started: new Date().toISOString(),
    stdout: `${file}.smoke.${randomUUID()}.stdout`, stderr: `${file}.smoke.${randomUUID()}.stderr` };
  publication.smoke ??= [];
  publication.smoke.push(attempt);
  save(file, receipt);
  const out = openSync(attempt.stdout, 'wx', 0o600);
  const err = openSync(attempt.stderr, 'wx', 0o600);
  try {
    const result = launch('npm', ['install', '--prefix', temporary, '--no-audit', '--no-fund',
      `git+${remote}#v${receipt.version}`], { cwd: temporary, stdio: ['ignore', out, err], timeout: 0 });
    attempt.exitCode = result.status;
    attempt.signal = result.signal;
    requireThat(result.status === 0, `Public Git installation failed: exit ${result.status}`);
    const installed = JSON.parse(readFileSync(path.join(temporary, 'node_modules/promptobus/package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(temporary, 'package-lock.json'), 'utf8'));
    attempt.version = installed.version;
    attempt.resolved = lock.packages?.['node_modules/promptobus']?.resolved;
    const resolved = [`git+${remote}#${receipt.source.commit}`,
      `git+ssh://git@github.com/${repository}.git#${receipt.source.commit}`];
    requireThat(installed.version === receipt.version && resolved.includes(attempt.resolved),
      'Installed public package version or resolved commit mismatch');
    const cli = launch('node', [path.join(temporary, 'node_modules/promptobus/bin/promptobus.js'), '--version'],
      { cwd: temporary, encoding: 'utf8' });
    attempt.cliVersion = cli.stdout?.trim();
    requireThat(cli.status === 0 && attempt.cliVersion === `promptobus ${receipt.version}`, 'Installed CLI version mismatch');
    attempt.status = 'passed';
  } catch (error) {
    attempt.status = 'failed';
    attempt.reason = error.message;
    throw error;
  } finally {
    closeSync(out);
    closeSync(err);
    rmSync(temporary, { recursive: true, force: true });
    try { checkRef(); } catch (error) {
      attempt.status = 'failed';
      attempt.reason = error.message;
      throw error;
    } finally { save(file, receipt); }
  }
  console.log(`Installed public v${receipt.version} at ${receipt.source.commit}; immutable tag preserved`);
  return 0;
}

function main() {
  const [action, ...args] = process.argv.slice(2);
  const version = action === 'prepare' ? args.shift() : undefined;
  requireThat(['prepare', 'verify', 'publish', 'smoke'].includes(action), 'Use prepare X.Y.Z --date YYYY-MM-DD, verify, publish --run ID, or smoke, with --receipt /durable/candidate.json');
  const options = {};
  while (args.length) {
    const key = args.shift();
    requireThat(['--receipt', ...(action === 'prepare' ? ['--date'] : []), ...(action === 'publish' ? ['--run'] : [])].includes(key)
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
    if (action === 'publish') return publish(file, options['--run']);
    if (action === 'smoke') return smoke(file);
    return verify(file);
  } finally {
    rmSync(lock, { recursive: true });
  }
}

try { process.exitCode = main(); }
catch (error) { console.error(`Release refused: ${error.message}`); process.exitCode = 1; }

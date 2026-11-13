import './home.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run, wouldResolve } from '../lib/exec.js';
import { makeSandbox, stubCommand } from './sandbox.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const remote = 'https://github.com/Velklish/promptobus.git';
const read = (file) => readFileSync(file, 'utf8');
const passed = (r) => assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
const refused = (r, message) => {
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, message);
};

function fixture() {
  const owner = makeSandbox('promptobus-release-fixture-publication-');
  const root = path.join(owner, 'source');
  const bare = path.join(owner, 'public.git');
  const file = path.join(owner, 'receipts/candidate.json');
  const put = (name, text) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  };
  put('package.json', JSON.stringify({ name: 'promptobus', type: 'module', version: '1.0.0',
    scripts: { release: 'node scripts/release.mjs', prepare: 'node build.cjs', build: 'node build.cjs',
      test: 'node build.cjs', audit: 'node build.cjs', pins: 'node build.cjs', 'codex-schema': 'node build.cjs' },
    bin: { promptobus: 'bin/promptobus.js' }, files: ['bin', 'build.cjs'] }, null, 2) + '\n');
  put('package-lock.json', JSON.stringify({ version: '1.0.0', lockfileVersion: 3, packages: { '': { version: '1.0.0' } } }, null, 2) + '\n');
  put('backslop.json', JSON.stringify({ gates: ['npm test', 'npx --no-install backslop lint',
    'npm run audit', 'npm run pins', 'npm run codex-schema'] }));
  put('CHANGELOG.md', '## [Unreleased]\n\n- New behavior.\n\n## [1.0.0] — 2026-01-01\n');
  put('docs/reference/01-overview.md', 'Version in `package.json` is `1.0.0`.\n');
  for (const name of ['README.md', 'docs/guides/install.md', 'skills/orchestrate/SKILL.md']) {
    put(name, 'npm install github:Velklish/promptobus#v1.0.0\n');
  }
  put('.gitignore', '.fixture/\nnode_modules/\n');
  put('build.cjs', `console.log('↷ SKIP fixture optional body — deliberate fixture');\n`);
  put('bin/promptobus.js', `import { readFileSync } from 'node:fs';\nconsole.log('promptobus '+JSON.parse(readFileSync(new URL('../package.json',import.meta.url))).version);\n`);
  for (const name of ['scripts/release.mjs', 'lib/exec.js']) put(name, read(path.join(repo, name)));
  const config = path.join(owner, 'gitconfig');
  writeFileSync(config, `[url "file://${bare}"]\n\tinsteadOf = ${remote}\n`);
  const exec = (argv, cwd = root, env = {}) => run(argv[0], argv.slice(1), { cwd, encoding: 'utf8',
    timeout: 60_000, env: { ...process.env, GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: path.join(owner, 'no-system'), GIT_ALLOW_PROTOCOL: 'file',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', ...env } });
  const git = (...args) => {
    const r = exec(['git', ...args]);
    passed(r);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'fixture base');
  mkdirSync(path.join(root, '.fixture'));
  stubCommand(path.join(root, 'node_modules/.bin'), 'npx', `console.log('fixture lint');`);
  stubCommand(path.join(root, 'node_modules/.bin'), 'gh', `
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync('.fixture/calls', JSON.stringify(args)+'\\n');
const state = JSON.parse(readFileSync('.fixture/ci.json','utf8'));
const head = readFileSync('.fixture/head','utf8');
const workflow = {id:7,path:'.github/workflows/ci.yml',state:'active',...state.workflow};
const ci = { id:123,workflow_id:7,path:'.github/workflows/ci.yml',name:'ci',
  repository:{full_name:'Velklish/promptobus'},head_repository:{full_name:'Velklish/promptobus'},
  event:'push',head_branch:'main',head_sha:head,status:'completed',conclusion:'success',run_attempt:1,
  html_url:'https://github.com/Velklish/promptobus/actions/runs/123',...state.run };
const steps = ['Install and check tmux','Install dependencies','Install ast-grep','Build','Test',
  'Publicity audit','Pin gate','backslop init','backslop lint'].filter(name=>name!==state.missingStep)
  .map(name=>({name,status:'completed',conclusion:name===state.badStep ? state.stepConclusion : 'success'}));
const job = {name:'Node 26 / ubuntu-latest',head_sha:head,run_id:123,status:'completed',conclusion:'success',
  labels:['ubuntu-latest'],steps,...state.job};
if(args[0]==='api') {
  assert.equal(args[1],'--hostname'); assert.equal(args[2],'github.com');
  const endpoint=args.at(-1);
  if(state.apiFailure) {console.error('fixture API unavailable');process.exit(8);}
  if(endpoint==='repos/Velklish/promptobus/actions/workflows/ci.yml') console.log(JSON.stringify(workflow));
  else if(endpoint==='repos/Velklish/promptobus/actions/runs/123') console.log(JSON.stringify(ci));
  else {
    assert.deepEqual(args.slice(3,5),['--paginate','--slurp']);
    assert.equal(endpoint,'repos/Velklish/promptobus/actions/runs/123/attempts/1/jobs?per_page=100');
    console.log(JSON.stringify([{jobs:state.missingJob?[]:[job]}]));
  }
} else {
  assert.deepEqual(args,['run','view','123','--repo','github.com/Velklish/promptobus','--attempt','1','--log']);
  if(state.changeSource) writeFileSync('README.md',readFileSync('README.md','utf8')+'dirty\\n');
  if(state.changeAttempt) writeFileSync('.fixture/ci.json',JSON.stringify({run:{run_attempt:2}}));
  console.log(state.emptyLogs?'':'Test 2026-11-13T00:00:00Z ↷ SKIP optional integration — deliberate fixture\\nTest installed check notRun: fixture');
}
`);
  const command = (args) => exec(['npm', 'run', 'release', '--', ...args, '--receipt', file]);
  passed(command(['prepare', '1.1.0', '--date', '2026-11-13']));
  const head = git('rev-parse', 'HEAD');
  put('.fixture/head', head);
  const state = (value = {}) => put('.fixture/ci.json', JSON.stringify(value));
  state();
  const receipt = () => JSON.parse(read(file));
  const save = (value) => writeFileSync(file, JSON.stringify(value));
  passed(command(['verify']));
  git('clone', '--bare', '-q', root, bare);
  const refs = () => git('ls-remote', remote, 'refs/tags/v1.1.0', 'refs/tags/v1.1.0^{}');
  const publish = () => command(['publish', '--run', '123']);
  const smoke = () => command(['smoke']);
  const calls = () => existsSync(path.join(root, '.fixture/calls')) ? read(path.join(root, '.fixture/calls')).trim().split('\n').map(JSON.parse) : [];
  return { root, bare, file, head, put, exec, git, state, receipt, save, refs, publish, smoke, command, calls };
}

test('every incomplete or non-success CI state refuses before public tag creation', () => {
  const f = fixture();
  refused(f.command(['publish']), /Use --run/);
  assert.equal(f.calls().length, 0);
  for (const [status, conclusion] of [['queued',null],['in_progress',null],['waiting',null],
    ...['failure','cancelled','timed_out','action_required','neutral','skipped','stale',null].map(c=>['completed',c])]) {
    f.state({run:{status,conclusion}});
    refused(f.publish(), /Linux CI must be completed with success/);
    assert.equal(f.refs(), '', `${status}/${conclusion} pushed a public tag`);
    assert.equal(f.git('tag', '--list'), '');
  }
  f.state({apiFailure:true});
  refused(f.publish(), /fixture API unavailable/);
  assert.equal(f.refs(), '');
});

test('foreign SHA, repository, branch, event or workflow cannot qualify a candidate', () => {
  const f = fixture();
  for (const run of [{head_sha:'0'.repeat(40)}, {repository:{full_name:'foreign/repo'}},
    {head_repository:{full_name:'foreign/repo'}}, {head_branch:'old-candidate'}, {event:'pull_request'},
    {workflow_id:8}, {path:'.github/workflows/old.yml'}, {name:'other'}, {id:124}]) {
    f.state({run});
    refused(f.publish(), /Linux CI repository\/workflow\/main candidate SHA mismatch/);
    assert.equal(f.refs(), '');
  }
  f.state({workflow:{state:'disabled_manually'}});
  refused(f.publish(), /Linux CI repository\/workflow\/main candidate SHA mismatch/);
  assert.equal(f.refs(), '');
});

test('missing jobs, wrong Linux identity and skipped or failed required steps refuse', () => {
  const f = fixture();
  for (const state of [{missingJob:true}, ...[{name:'Node 26 / macos-latest'}, {labels:['macos-latest']},
    {head_sha:'0'.repeat(40)}, {run_id:999}, {status:'in_progress'}, {conclusion:'failure'}].map(job=>({job}))]) {
    f.state(state);
    refused(f.publish(), /Missing successful required Linux job/);
    assert.equal(f.refs(), '');
  }
  for (const name of ['Install and check tmux','Install dependencies','Install ast-grep','Build','Test',
    'Publicity audit','Pin gate','backslop init','backslop lint']) {
    f.state({missingStep:name});
    refused(f.publish(), /Missing successful required Linux step/);
    assert.equal(f.refs(), '');
  }
  for (const conclusion of ['skipped','failure','cancelled',null]) {
    f.state({badStep:'Test',stepConclusion:conclusion});
    refused(f.publish(), /Missing successful required Linux step: Test/);
    assert.equal(f.refs(), '');
  }
});

test('local success is required, and source, public main or CI attempt changes refuse before push', () => {
  const f = fixture();
  const saved = read(f.file);
  const receipt = f.receipt();
  receipt.steps[1].status = 'running';
  f.save(receipt);
  refused(f.publish(), /Complete local candidate verification/);
  assert.equal(f.calls().length, 0);
  writeFileSync(f.file, saved);
  f.state({changeSource:true});
  refused(f.publish(), /clean committed tree/);
  assert.equal(f.refs(), '');
  f.git('restore', 'README.md');
  f.state({changeAttempt:true});
  refused(f.publish(), /Linux CI changed during qualification/);
  assert.equal(f.refs(), '');
  f.state({emptyLogs:true});
  refused(f.publish(), /Linux CI logs are required/);
  assert.equal(f.refs(), '');
  f.state();
  f.git('--git-dir', f.bare, 'update-ref', 'refs/heads/main', f.git('rev-parse', 'HEAD^'));
  refused(f.publish(), /Public main must still name the qualified candidate/);
  assert.equal(f.refs(), '');
  f.put('README.md', 'changed source\n');
  f.git('add', 'README.md');
  f.git('commit', '-qm', 'changed after qualification');
  refused(f.publish(), /Candidate source mismatch/);
  assert.equal(f.refs(), '');
});

test('successful exact-SHA proof publishes an annotated immutable tag, keeps skips, and installs actual public ref locally', () => {
  const f = fixture();
  passed(f.publish());
  const published = f.refs();
  const receipt = f.receipt();
  assert.equal(receipt.publication.status, 'published');
  assert.equal(receipt.qualification.sha, f.head);
  assert.equal(receipt.qualification.skips.length, 1);
  assert.equal(receipt.qualification.notRun.length, 1);
  assert.match(read(receipt.qualification.log), /SKIP optional integration/);
  assert.equal(JSON.parse(read(receipt.qualification.evidence)).jobs[0].conclusion, 'success');
  assert.equal(f.git('cat-file', '-t', 'v1.1.0'), 'tag');
  assert.equal(f.git('rev-parse', 'v1.1.0^{commit}'), f.head);
  const npm = wouldResolve('npm', process.env, repo);
  const git = wouldResolve('git', process.env, repo);
  stubCommand(path.join(f.root, 'node_modules/.bin'), 'git', `
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2).filter(arg=>arg!=='--recurse-submodules');
const r=spawnSync(${JSON.stringify(git)},args,{stdio:'inherit'});
process.exit(r.status??1);
`);
  stubCommand(path.join(f.root, 'node_modules/.bin'), 'npm', `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const args=process.argv.slice(2);
assert.deepEqual(args.slice(0,1),['install']);
assert.equal(args.at(-1),'git+https://github.com/Velklish/promptobus.git#v1.1.0');
const prefix=args[args.indexOf('--prefix')+1];
args[args.length-1]=${JSON.stringify(`promptobus@git+file://${f.bare}#v1.1.0`)};
const r=spawnSync(${JSON.stringify(npm)},args,{stdio:'inherit'});
if(r.status!==0) process.exit(r.status??1);
const file=path.join(prefix,'package-lock.json');
const lock=JSON.parse(readFileSync(file,'utf8'));
const installed=lock.packages['node_modules/promptobus'];
assert.ok(installed, JSON.stringify(lock));
assert.equal(installed.resolved,${JSON.stringify(`git+file://${f.bare}#${f.head}`)});
installed.resolved=installed.resolved.replace(${JSON.stringify(`git+file://${f.bare}`)},'git+ssh://git@github.com/Velklish/promptobus.git');
writeFileSync(file,JSON.stringify(lock));
`);
  // npm installs the real local Git tag; only its transport identity is simulated.
  const installed = f.exec(['node', 'scripts/release.mjs', 'smoke', '--receipt', f.file], f.root,
    {PATH:path.join(f.root,'node_modules/.bin')+path.delimiter+process.env.PATH});
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}\n${read(f.receipt().publication.smoke.at(-1).stderr)}`);
  const attempt = f.receipt().publication.smoke.at(-1);
  assert.equal(attempt.status, 'passed');
  assert.equal(attempt.version, '1.1.0');
  assert.equal(attempt.resolved, `git+ssh://git@github.com/Velklish/promptobus.git#${f.head}`);
  assert.equal(attempt.cliVersion, 'promptobus 1.1.0');
  assert.equal(f.refs(), published);
  rmSync(path.join(f.root, 'node_modules/.bin/npm'));
  rmSync(path.join(f.root, 'node_modules/.bin/git'));
  const resumed = f.publish();
  passed(resumed);
  assert.match(resumed.stdout, /installation smoke passed/);
  assert.equal(f.receipt().publication.smoke.length, 1);
  assert.equal(f.refs(), published);
  assert.ok(f.calls().every(args=>args[0]==='api'||(args[0]==='run'&&args[1]==='view')));
});

test('interrupted tag push resumes without replacing local/remote objects or re-running verification', () => {
  const f = fixture();
  const hook = path.join(f.bare, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 7\n', {mode:0o755});
  refused(f.publish(), /pre-receive hook declined/);
  assert.equal(f.refs(), '');
  const object = f.git('rev-parse', 'v1.1.0');
  const receipt = f.receipt();
  assert.equal(receipt.publication.status, 'publishing');
  assert.equal(receipt.publication.object, object);
  rmSync(hook);
  passed(f.publish());
  assert.equal(f.git('rev-parse', 'v1.1.0'), object);
  const published = f.refs();
  const interrupted = f.receipt();
  interrupted.publication.status = 'publishing';
  f.save(interrupted);
  f.git('tag', '-d', 'v1.1.0');
  passed(f.publish());
  assert.equal(f.git('rev-parse', 'v1.1.0'), object);
  assert.equal(f.refs(), published);
  assert.deepEqual(f.receipt().steps.map(s=>s.attempts.length), receipt.steps.map(s=>s.attempts.length));
});

test('conflicting tag targets, lightweight tags and changed annotated objects are never replaced', () => {
  const f = fixture();
  f.git('tag', 'v1.1.0');
  refused(f.publish(), /unchanged annotated candidate tag/);
  assert.equal(f.refs(), '');
  f.git('tag', '-d', 'v1.1.0');
  passed(f.publish());
  const published = f.refs();
  f.git('tag', '-f', '-a', 'v1.1.0', '-m', 'different annotation');
  refused(f.publish(), /unchanged annotated candidate tag/);
  assert.equal(f.refs(), published);
  passed(f.exec(['git', 'tag', '-f', '-a', 'v1.1.0', '-m', 'promptobus 1.1.0'], f.root,
    { GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' }));
  const altered = f.git('rev-parse', 'v1.1.0');
  f.git('push', '--force', f.bare, 'refs/tags/v1.1.0:refs/tags/v1.1.0');
  refused(f.publish(), /receipt object mismatch/);
  assert.equal(f.refs().split('\n')[0].split('\t')[0], altered);
  f.git('--git-dir', f.bare, 'update-ref', 'refs/tags/v1.1.0', f.git('rev-parse', 'HEAD^'));
  const conflict = f.refs();
  refused(f.publish(), /immutable/);
  assert.equal(f.refs(), conflict);
});

test('failed public installation or installed version/ref/CLI checks retain immutable public tag and failure evidence', () => {
  const f = fixture();
  passed(f.publish());
  const published = f.refs();
  const hook = path.join(f.root, 'node_modules/.bin/npm');
  // Invoke Node directly so only the installation subprocess uses the npm fixture.
  for (const mode of ['install-failure','version','ref','repository','cli']) {
    stubCommand(path.dirname(hook), 'npm', `
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2);
if(${JSON.stringify(mode)}==='install-failure') { console.error('fixture installation failed'); process.exit(9); }
const prefix=args[args.indexOf('--prefix')+1];
mkdirSync(path.join(prefix,'node_modules/promptobus/bin'),{recursive:true});
writeFileSync(path.join(prefix,'node_modules/promptobus/package.json'),JSON.stringify({version:${JSON.stringify(mode==='version'?'0.0.0':'1.1.0')}}));
writeFileSync(path.join(prefix,'package-lock.json'),JSON.stringify({packages:{'node_modules/promptobus':{resolved:${JSON.stringify(`git+${mode==='repository'?'https://github.com/foreign/repo.git':remote}#${mode==='ref'?'0'.repeat(40):f.head}`)}}}}));
writeFileSync(path.join(prefix,'node_modules/promptobus/bin/promptobus.js'),${JSON.stringify(`console.log('promptobus ${mode==='cli'?'0.0.0':'1.1.0'}');`)});
`);
    refused(f.exec(['node', 'scripts/release.mjs', 'smoke', '--receipt', f.file], f.root,
      {PATH:path.dirname(hook)+path.delimiter+process.env.PATH}), /Public Git installation failed|version or resolved commit mismatch|CLI version mismatch/);
    assert.equal(f.refs(), published);
    const attempt = f.receipt().publication.smoke.at(-1);
    assert.equal(attempt.status, 'failed');
    assert.ok(existsSync(attempt.stdout) && existsSync(attempt.stderr));
    if(mode==='install-failure') {
      assert.equal(attempt.exitCode, 9);
      assert.match(read(attempt.stderr), /fixture installation failed/);
    }
  }
  assert.equal(f.receipt().publication.smoke.length, 5);
});

test('release guide and workflow retain main/PR coverage and qualify once before immutable publication', () => {
  const workflow = read(path.join(repo,'.github/workflows/ci.yml'));
  assert.match(workflow, /push:\s*\n\s*branches: \[main\]/);
  assert.match(workflow, /\n  pull_request:/);
  assert.doesNotMatch(workflow, /\btags:|workflow_dispatch:|gh run list|if:.*success/);
  for(const command of ['npm run build','npm test','npm run audit','npm run pins',
    'npx --no-install backslop init --hooks claude','npx --no-install backslop lint']) assert.ok(workflow.includes(command));
  const guide = read(path.join(repo,'docs/guides/releasing.md'));
  for(const text of ['git push origin HEAD:main','npm run release -- publish --receipt', '--run',
    'npm run release -- smoke --receipt','immutable','interrupted','skipped integration bodies',
    'one full Linux qualification','Node 26 / ubuntu-latest']) assert.ok(guide.includes(text), `guide missing ${text}`);
  assert.doesNotMatch(guide, /push the release commit and tag together/);
});

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cwd = makeSandbox('promptobus-test-one-');
const file = 'build-identity.test.mjs';
const oldTime = new Date('2000-01-01T00:00:00Z');

for (const dir of ['src', 'lib', 'bin', 'test', 'scripts']) mkdirSync(path.join(cwd, dir));
for (const name of ['package.json', 'tsconfig.json', 'tsconfig.runtime.json', 'scripts/test-one.mjs', 'test/home.mjs', 'test/hygiene.mjs']) {
  copyFileSync(path.join(root, name), path.join(cwd, name));
}
symlinkSync(path.join(root, 'node_modules'), path.join(cwd, 'node_modules'), 'junction');

const put = (name, text) => writeFileSync(path.join(cwd, name), `${text}\n`);
const core = 'src/core.ts';
const runtime = 'lib/runtime.ts';
const cli = 'bin/promptobus.ts';
const values = (name, version) => {
  put(name, `export const version = ${JSON.stringify(version)};`);
  utimesSync(path.join(cwd, name), oldTime, oldTime);
};
const run = (command, ...args) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30_000 });
  return { exit: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}` };
};
const build = () => run('npm', 'run', 'build');
const direct = () => run(process.execPath, `test/${file}`);
const one = (...args) => run('npm', 'run', 'test:one', '--', ...args);
const loaded = (run, versions) => run.exit === 0 && run.out.includes(`loaded ${versions.join(' ')}`);
const git = (...args) => {
  const r = run('git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args);
  if (r.exit !== 0) throw new Error(r.out);
  return r.out.trim();
};
const saveSources = (label, ...added) => {
  git('add', core, runtime, cli, 'bin/promptobus-bb-root.ts', ...added);
  git('commit', '--no-gpg-sign', '-m', label);
  return git('rev-parse', 'HEAD');
};

values(core, 'core-a');
values(runtime, 'runtime-a');
values(cli, 'cli-a');
values('bin/promptobus-bb-root.ts', 'bb-a');
put(`test/${file}`, `import {version as core} from '../dist/core.js';
import {version as runtime} from '../lib/runtime.js';
import {version as cli} from '../bin/promptobus.js';
console.log('loaded', core, runtime, cli);`);
git('init', '-b', 'main');
const a = saveSources('revision A');
const initial = build();
check('the fixture builds both source sets at revision A', initial.exit === 0, initial.out);

values(core, 'core-b');
const staleCore = direct();
check('raw Node uses the previous dist output with changed core source', loaded(staleCore, ['core-a', 'runtime-a', 'cli-a']), staleCore.out);
const freshCore = one(file);
check('test:one rebuilds dist even when the changed source has an older mtime', loaded(freshCore, ['core-b', 'runtime-a', 'cli-a']), freshCore.out);

values(runtime, 'runtime-b');
values(cli, 'cli-b');
const b = saveSources('revision B');
const staleRuntime = direct();
check('raw Node uses the previous runtime and CLI outputs with changed runtime sources', loaded(staleRuntime, ['core-b', 'runtime-a', 'cli-a']), staleRuntime.out);
const freshRuntime = one(file);
check('test:one rebuilds adjacent lib and bin output too', loaded(freshRuntime, ['core-b', 'runtime-b', 'cli-b']), freshRuntime.out);

git('checkout', '--detach', a);
const staleBack = direct();
const back = one(file);
check('test:one rebuilds after checking out a former commit while the previous outputs survive',
  a !== b && git('rev-parse', 'HEAD') === a && loaded(staleBack, ['core-b', 'runtime-b', 'cli-b'])
  && loaded(back, ['core-a', 'runtime-a', 'cli-a']), `${staleBack.out}\n${back.out}`);
const emitted = r => [r.exit, r.out.split('\n').find(line => line.startsWith('loaded '))];
console.log(`  build identity: ${JSON.stringify({ a, b, staleCore: emitted(staleCore), freshCore: emitted(freshCore),
  staleRuntime: emitted(staleRuntime), freshRuntime: emitted(freshRuntime), staleBack: emitted(staleBack), freshBack: emitted(back) })}`);

put(runtime, 'export const version: number = "type error";');
const broken = one(file);
check('a failed compiler refuses the test instead of using previous output', broken.exit === 1 && broken.out.includes('Test not started: npm run build failed') && !broken.out.includes('loaded '), broken.out);
values(runtime, 'runtime-a');

const removed = ['src', 'lib', 'bin'].flatMap(dir => ['ts', 'mts', 'cts'].map(ext => `${dir}/removed.${ext}`));
for (const name of removed) put(name, name.endsWith('.cts') ? 'export = "stale CJS";' : 'export default "stale ESM";');
const withImports = name => `import "./removed.mjs";\nimport "./removed.cjs";\nexport const version = "${name}";`;
put(runtime, withImports('runtime-c'));
put(cli, withImports('cli-c'));
const c = saveSources('revision C', ...removed);
const orphanTest = 'orphan-output.test.mjs';
const modules = ['dist', 'lib', 'bin'].flatMap(dir => ['js', 'mjs', 'cjs'].map(ext => `../${dir}/removed.${ext}`));
put(`test/${orphanTest}`, `console.log('orphan fixture started');
for (const file of ${JSON.stringify(modules)}) console.log(file, (await import(file)).default);`);
const added = one(orphanTest);
check('both TypeScript projects emit all three module families while their sources exist', added.exit === 0
  && added.out.match(/stale ESM/g)?.length === 6 && added.out.match(/stale CJS/g)?.length === 3, added.out);

values(runtime, 'runtime-d');
values(cli, 'cli-d');
const unreferenced = ['lib', 'bin'].flatMap(dir => ['mts', 'cts'].map(ext => [`${dir}/removed.${ext}`, `${dir}-${ext}-d`]));
for (const [name, value] of unreferenced) put(name, `${name.endsWith('.cts') ? 'export =' : 'export default'} ${JSON.stringify(value)};`);
const d = saveSources('revision D removes the imports but keeps and edits the sources', ...unreferenced.map(([name]) => name));
const rawUnreferenced = run(process.execPath, `test/${orphanTest}`);
const freshUnreferenced = one(orphanTest);
const emittedLine = ([name, value]) => `../${name.replace(/\.([mc])ts$/, '.$1js')} ${value}`;
check('test:one rebuilds unreferenced ESM and CommonJS in lib and bin before direct test imports',
  c !== d && rawUnreferenced.exit === 0 && freshUnreferenced.exit === 0
  && unreferenced.every(([name, value]) => rawUnreferenced.out.includes(emittedLine([name, name.endsWith('.cts') ? 'stale CJS' : 'stale ESM']))
    && freshUnreferenced.out.includes(emittedLine([name, value]))),
  `${rawUnreferenced.out}\n${freshUnreferenced.out}`);
console.log(`  removed imports: ${JSON.stringify({ from: c, to: d, rawExit: rawUnreferenced.exit, guardedExit: freshUnreferenced.exit,
  raw: rawUnreferenced.out.split('\n').filter(line => /\.\.[/](lib|bin)[/].*\.[mc]js /.test(line)),
  rebuilt: freshUnreferenced.out.split('\n').filter(line => /\.\.[/](lib|bin)[/].*\.[mc]js /.test(line)) })}`);

git('checkout', '--detach', a);
const staleOrphans = run(process.execPath, `test/${orphanTest}`);
const orphan = one(orphanTest);
const expected = ['dist', 'lib', 'bin'].flatMap(dir => ['js', 'mjs', 'cjs', 'd.ts', 'd.mts', 'd.cts'].map(ext => `${dir}/removed.${ext}`)).sort();
check('checkout removes the sources but raw Node still loads their actual previous-build output',
  d !== a && git('rev-parse', 'HEAD') === a && removed.every(f => !existsSync(path.join(cwd, f)))
  && expected.every(f => existsSync(path.join(cwd, f))) && staleOrphans.exit === 0
  && staleOrphans.out === freshUnreferenced.out.slice(freshUnreferenced.out.indexOf('orphan fixture started')), staleOrphans.out);
check('test:one refuses all orphaned module and declaration families before starting the test', orphan.exit === 1
  && orphan.out.includes(`generated files without sources: ${expected.join(', ')}.`)
  && orphan.out.includes('npm run build') && !orphan.out.includes('orphan fixture started'), orphan.out);
console.log(`  checkout removal: ${JSON.stringify({ from: d, to: a, rawExit: staleOrphans.exit, guardedExit: orphan.exit,
  diagnostic: orphan.out.split('\n').find(line => line.startsWith('Test not started:')) })}`);

const badName = one(`test/${file}`);
check('test:one refuses a path instead of a basename before building', badName.exit === 1 && badName.out.includes('usage:') && !badName.out.includes('tsc -p'), badName.out);

const guide = fileURLToPath(new URL('../docs/guides/contributing.md', import.meta.url));
check('the contributor guide names the build-first one-file command and the raw Node limitation',
  /npm run test:one -- <file\.test\.mjs>[\s\S]+?Raw `node test\/<file>\.test\.mjs` does not prove build freshness/.test(readFileSync(guide, 'utf8')));

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, globSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [name, ...extra] = process.argv.slice(2);
const files = globSync('test/*.test.mjs', { cwd: root });
const file = name && path.join('test', name);
const sourceExtensions = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts', '.d.ts': '.ts', '.d.mts': '.mts', '.d.cts': '.cts' };

function run() {
  if (!file || name !== path.basename(name) || extra.length || !files.includes(file) || !statSync(path.join(root, file)).isFile()) {
    console.error('usage: npm run test:one -- <existing *.test.mjs basename>');
    return 1;
  }

  const build = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error(`Test not started: npm run build failed${build.error ? `: ${build.error.message}` : ''}`);
    return build.status ?? 1;
  }

  const orphans = ['dist', 'lib', 'bin'].flatMap(dir => globSync(`${dir}/**`, { cwd: root })
    .filter(output => {
      const ending = Object.keys(sourceExtensions).find(ext => output.endsWith(ext));
      if (!ending) return false;
      const relative = dir === 'dist' ? path.join('src', path.relative('dist', output)) : output;
      return !existsSync(path.join(root, relative.slice(0, -ending.length) + sourceExtensions[ending]));
    })).sort();
  if (orphans.length) {
    console.error(`Test not started: generated files without sources: ${orphans.join(', ')}. Remove obsolete outputs or use a clean worktree, then run npm run build.`);
    return 1;
  }

  const test = spawn(process.execPath, ['--import', './test/home.mjs', file], { cwd: root, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => test.kill(signal));
  test.on('error', error => console.error(error.message));
  test.on('close', (code, signal) => {
    if (signal) console.error(`Test exited on ${signal}`);
    process.exitCode = code ?? 1;
  });
  return 0;
}

process.exitCode = run();

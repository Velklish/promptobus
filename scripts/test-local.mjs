import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedPaths, selectTests } from '../test/groups.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const usage = 'usage: npm run test:local -- --base <commit> [--list]';
try {
  const at = args.indexOf('--base');
  const base = at < 0 ? null : args[at + 1];
  if (!base || base.startsWith('--') || args.filter((arg) => arg === '--base').length !== 1
      || args.some((arg, i) => i !== at + 1 && arg !== '--base' && arg !== '--list')
      || args.filter((arg) => arg === '--list').length > 1) throw new Error(usage);
  const input = changedPaths(root, base);
  const allFiles = readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.mjs'));
  const plan = selectTests(input.paths, allFiles);
  console.log(JSON.stringify({ ...input, ...plan, selectedFileCount: plan.files.length,
    omittedFileCount: plan.omittedFiles.length }, null, 2));
  if (!args.includes('--list')) {
    const run = (command, argv) => {
      const start = Date.now();
      const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit' });
      console.log(`local command ${JSON.stringify([command, ...argv])}: exit ${result.status}, signal ${result.signal}, ${Date.now() - start} ms`);
      if (result.error) console.error(result.error.message);
      return result.status ?? 1;
    };
    process.exitCode = run('npm', ['run', 'build']);
    if (process.exitCode === 0) {
      process.exitCode = run(process.execPath, ['test/run.mjs', '--files', ...plan.files]);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

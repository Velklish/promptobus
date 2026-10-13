import { check } from './check.mjs';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeSandbox } from './sandbox.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const copy = realpathSync(makeSandbox('OpenCode path café '));
for (const entry of ['lib', 'dist', 'package.json', 'README.md', 'docs/reference']) {
  mkdirSync(path.dirname(path.join(copy, entry)), { recursive: true });
  cpSync(path.join(root, entry), path.join(copy, entry), { recursive: true });
}
symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'junction');
mkdirSync(path.join(copy, 'test', 'fixtures'), { recursive: true });
for (const entry of ['check.mjs', 'home.mjs', 'hygiene.mjs', 'sandbox.mjs',
  'promptobus-driver-opencode.test.mjs', 'promptobus-driver-opencode-listen.test.mjs',
  'fixtures/opencode-listen-error.mjs', 'fixtures/opencode-refonly-stop.json',
  'fixtures/opencode-teamlead-proof.json']) {
  cpSync(path.join(root, 'test', entry), path.join(copy, 'test', entry));
}

const subject = path.join(copy, 'test', 'promptobus-driver-opencode.test.mjs');
check(': OpenCode path fixture physically contains spaces and Unicode',
  realpathSync(subject) === subject && pathToFileURL(subject).href.includes('%20')
  && pathToFileURL(subject).href.includes('%C3%A9'), subject);
const normal = spawnSync(process.execPath, [subject], { encoding: 'utf8', timeout: 20000 });
check(': OpenCode encoded-path subject completes all 65 checks',
  normal.status === 0 && /\n\d+\/65 passed(?:, \d+ skipped)?\n/.test(normal.stdout),
  `${normal.stdout}${normal.stderr}`);
const regression = spawnSync(process.execPath,
  [path.join(copy, 'test', 'promptobus-driver-opencode-listen.test.mjs')],
  { encoding: 'utf8', timeout: 30000 });
check(': OpenCode encoded-path listener regression completes all 25 checks',
  regression.status === 0 && /\n25\/25 passed\n/.test(regression.stdout),
  `${regression.stdout}${regression.stderr}`);

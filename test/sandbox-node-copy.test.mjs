import { lstatSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { check, skip } from './check.mjs';
import { copyNodeExecutable, makeSandbox } from './sandbox.mjs';

const root = makeSandbox('promptobus-test-node-copy-');
const copy = path.join(root, 'native-node');
copyNodeExecutable(copy);

const started = spawnSync(copy, ['-p', '40 + 2'], { encoding: 'utf8', timeout: 10000 });
check('a copied Node executable starts and runs a script', started.status === 0 && started.stdout.trim() === '42',
  JSON.stringify({ status: started.status, signal: started.signal, stdout: started.stdout, stderr: started.stderr }));
check('the copy keeps the owner-only executable mode', (statSync(copy).mode & 0o777) === 0o700);

const libraryCheck = 'a Node build linked against a shared library gets that library beside the copy';
if (process.platform !== 'darwin') {
  skip(libraryCheck, 'the shared-library lookup runs on macOS only');
} else {
  const listed = spawnSync('/usr/bin/otool', ['-L', process.execPath], { encoding: 'utf8' });
  check('otool lists the libraries this Node executable links', listed.status === 0,
    JSON.stringify({ status: listed.status, error: String(listed.error ?? ''), stderr: listed.stderr }));
  const linked = [...(listed.stdout ?? '').matchAll(/^\s+@rpath\/(\S+)/gm)].map((match) => match[1]);
  if (linked.length === 0) {
    skip(libraryCheck, 'this Node build links no @rpath library');
  } else {
    const beside = linked.map((name) => {
      try { return lstatSync(path.join(root, name)).isSymbolicLink(); } catch { return false; }
    });
    check(libraryCheck, beside.every(Boolean), JSON.stringify({ linked, beside }));
  }
}

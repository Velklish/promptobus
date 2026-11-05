import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, statSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { copyNodeExecutable, makeSandbox, stubCommand } from './sandbox.mjs';

// A running native image holds the executable inode deterministically on Linux.
// A shell launcher holds it only during exec, so racing shell starts would not be a proof.
if (process.platform === 'win32') {
  console.log('POSIX launcher replacement is not exercised on Windows');
} else {
  const root = makeSandbox('promptobus-stub-replacement-');
  const launcher = path.join(root, 'claude');
  copyNodeExecutable(launcher);
  const original = statSync(launcher);
  const child = spawn(launcher, ['--input-type=module', '-e', `
process.on('message', message => {
  if (message === 'ping') process.send({ kind: 'pong', pid: process.pid });
  if (message === 'release') process.disconnect();
});
process.send({ kind: 'ready', pid: process.pid });
`], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], timeout: 10000 });
  const exited = once(child, 'exit');
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    check('replacement fixture executes its owned Node copy', ready.kind === 'ready' && ready.pid === child.pid);
    if (process.platform === 'linux') {
      let refusal = null;
      try { closeSync(openSync(launcher, 'r+')); } catch (error) { refusal = error.code; }
      check('Linux refuses writing the retained executable inode with ETXTBSY', refusal === 'ETXTBSY', String(refusal));
    }

    let publicationError = null;
    try { stubCommand(root, 'claude', `process.stdout.write(JSON.stringify({answer:'replacement',args:process.argv.slice(2)}));`); }
    catch (error) { publicationError = { code: error.code, message: error.message }; }
    check('stubCommand replaces an executing launcher without a write refusal', publicationError === null, JSON.stringify(publicationError));
    if (publicationError === null) {
      const replacement = statSync(launcher);
      check('stubCommand publishes a different executable inode',
        original.dev !== replacement.dev || original.ino !== replacement.ino);
      check('replacement launcher retains executable mode', (replacement.mode & 0o777) === 0o755);
      const called = spawnSync(launcher, ['argument with spaces', '--fixture'], { encoding: 'utf8', timeout: 5000 });
      check('replacement launcher executes the new body and preserves argv', called.status === 0
        && called.stdout === JSON.stringify({ answer: 'replacement', args: ['argument with spaces', '--fixture'] }),
      JSON.stringify({ status: called.status, stdout: called.stdout, stderr: called.stderr, error: called.error?.message }));
    }

    let pong = null;
    if (child.connected) {
      const response = once(child, 'message', { signal: AbortSignal.timeout(5000) });
      child.send('ping');
      try { [pong] = await response; } catch { /* A lost old image must be a named verdict, not an abort. */ }
    }
    check('the old executable child still responds after launcher replacement', pong?.kind === 'pong' && pong.pid === child.pid);
  } finally {
    if (child.connected) child.send('release');
    const [code, signal] = await exited;
    check('the exact owned child exits gracefully', code === 0 && signal === null, JSON.stringify({ code, signal }));
    console.log(JSON.stringify({ ownedPid: child.pid, exitCode: code, signal }));
  }
}

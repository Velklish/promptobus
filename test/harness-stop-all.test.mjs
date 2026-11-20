import { spawn } from 'node:child_process';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { harnessSessions, pidAlive, stopAll, writeSession } from './harness.mjs';

const home = makeSandbox('promptobus-test-stop-all-');

async function withChildren(work) {
  const children = new Map();
  async function start(id, source) {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.set(child, new Promise(resolve => child.once('close', resolve)));
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(id + ' exited before ready: ' + (code ?? signal))));
      child.stdout.once('data', resolve);
    });
    writeSession(home, { id, name: id, pid: child.pid, startedAt: Date.now() });
    return child;
  }
  try {
    await work(start);
  } finally {
    for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.values());
  }
}

const participant = handler => "process.on('SIGTERM', () => {" + handler + "}); console.log('up'); setInterval(() => {}, 1000);";

await withChildren(async start => {
  const slow = await start('slow', participant('setTimeout(() => process.exit(0), 1500);'));
  const left = await stopAll(home);
  check('a participant that needs 1.5 s to exit after SIGTERM is not reported as left', left.length === 0, JSON.stringify(left));
  check('a participant that was waited for is gone', !pidAlive(slow.pid));
  check('stopAll removes the record of every session it handled', harnessSessions(home).length === 0);

  await start('stuck-a', participant(''));
  await start('stuck-b', participant(''));
  const stillLeft = await stopAll(home, { timeoutMs: 100 });
  check('participants that ignore SIGTERM are all reported as left once the time is spent',
    JSON.stringify(stillLeft) === JSON.stringify(['stuck-a', 'stuck-b']), JSON.stringify(stillLeft));
  check('stopAll removes both stuck session records', harnessSessions(home).length === 0);
});

for (const [spent, remaining] of [[60, 40], [130, 0]]) {
  const allowances = [];
  let clock = 1000;
  for (const [id, pid] of [['a', -1], ['b', -2]]) writeSession(home, { id, pid });
  await stopAll(home, {
    timeoutMs: 100,
    now: () => clock,
    waitForDeath: (pid, allowance) => { allowances.push([pid, allowance]); clock += spent; return false; },
  });
  check('the second participant has ' + remaining + ' ms of the original Stop allowance',
    JSON.stringify(allowances) === JSON.stringify([[-1, 100], [-2, remaining]]), JSON.stringify(allowances));
}

let firstClosed = false, startupError;
try {
  await withChildren(async start => {
    const first = await start('first', participant(''));
    first.once('close', () => { firstClosed = true; });
    await start('second', 'process.exit(7)');
  });
} catch (error) { startupError = error; }
check("a failed second startup observes the first child's close before teardown returns",
  firstClosed && startupError?.message === 'second exited before ready: 7', String(startupError));

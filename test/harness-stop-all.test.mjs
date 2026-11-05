import { spawn } from 'node:child_process';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { harnessSessions, pidAlive, stopAll, writeSession } from './harness.mjs';

const home = makeSandbox('promptobus-test-stop-all-');
const attempt = async (run) => { try { return await run(); } catch (error) { return error; } };

// A stand-in participant: it handles SIGTERM like the real one, which finishes some work before it exits.
const start = (id, exitAfterMs) => new Promise((resolve, reject) => {
  const onTerm = exitAfterMs === null ? '{}' : `setTimeout(() => process.exit(0), ${exitAfterMs})`;
  const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => ${onTerm}); console.log('up'); setInterval(() => {}, 1000);`],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  child.once('error', reject);
  child.once('exit', (code, signal) => reject(new Error(`stand-in ${id} exited before it was up: ${code ?? signal}`)));
  child.stdout.once('data', () => {
    child.removeAllListeners('exit');
    writeSession(home, { id, name: id, pid: child.pid, startedAt: Date.now() });
    resolve(child);
  });
});

const slow = await start('slow', 1500);
const left = await attempt(() => stopAll(home));
check('a participant that needs 1.5 s to exit after SIGTERM is not reported as left',
  Array.isArray(left) && left.length === 0, JSON.stringify(left));
check('a participant that was waited for is gone', !pidAlive(slow.pid));
check('stopAll removes the record of every session it handled', harnessSessions(home).length === 0);

const stuckA = await start('stuck-a', null);
const stuckB = await start('stuck-b', null);
const began = Date.now();
const stillLeft = await attempt(() => stopAll(home, { timeoutMs: 1000 }));
const spent = Date.now() - began;
check('participants that ignore SIGTERM are all reported as left once the time is spent',
  JSON.stringify(stillLeft) === JSON.stringify(['stuck-a', 'stuck-b']), JSON.stringify(stillLeft));
check('the time is shared by all participants: two stuck ones cost one bound, not two',
  spent >= 950 && spent < 1800, `${spent} ms`);
stuckA.kill('SIGKILL');
stuckB.kill('SIGKILL');

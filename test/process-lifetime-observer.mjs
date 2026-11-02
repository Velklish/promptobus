import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { processState, processStateAsync } from '../lib/service-state.js';

const identity = { pid: Number(process.argv[2]), birth: process.argv[3] };
const originals = { spawnSync: childProcess.spawnSync, spawn: childProcess.spawn };
if (process.argv[4] === 'denied') {
  for (const name of ['spawnSync', 'spawn']) childProcess[name] = (cmd, args, ...options) => {
    if (cmd === '/bin/ps' && JSON.stringify(args) === JSON.stringify(['-p', String(identity.pid), '-o', 'stat=', '-o', 'lstart='])) {
      throw Object.assign(new Error('Simulated protected process observation refusal'), { code: 'EACCES' });
    }
    return originals[name](cmd, args, ...options);
  };
  syncBuiltinESMExports();
}
try {
  const deadline = Date.now() + 5000;
  let stat = ['unavailable', 'denied'].includes(process.argv[4]) ? 'unavailable' : '';
  while (stat !== 'unavailable' && Date.now() < deadline) {
    const result = spawnSync('ps', ['-p', String(identity.pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 });
    stat = result.status === 0 ? result.stdout.trim() : '';
    if (stat.startsWith('Z')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  let resume;
  if (process.argv[5]) {
    const { managedCodexResumeDeath, readSession } = await import('../lib/codex-session.js');
    try { resume = managedCodexResumeDeath(process.argv[5], readSession(process.argv[5]), process.env); }
    catch (error) { resume = { error: error.message }; }
  }
  process.stdout.write(JSON.stringify({ identity, stat, synchronous: processState(identity), asynchronous: await processStateAsync(identity), resume }));
} finally {
  Object.assign(childProcess, originals);
  syncBuiltinESMExports();
}

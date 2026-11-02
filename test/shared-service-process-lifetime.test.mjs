import { check, skip } from './check.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { requireProcess } from '../lib/service-state.js';

if (!['linux', 'darwin'].includes(process.platform)) {
  skip('exited unreaped process lifetime', 'This platform has no implemented process-birth observer');
} else {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), 'pb-exited-lifetime-'));
  const release = path.join(directory, 'release');
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import { existsSync } from "node:fs"; while (!existsSync(process.argv[1])) await new Promise(resolve => setTimeout(resolve, 10));', release],
  { stdio: 'ignore' });
  const exited = once(child, 'exit');
  try {
    const identity = requireProcess(child.pid);
    writeFileSync(release, 'exit');
    const observed = spawnSync(process.execPath, [fileURLToPath(new URL('./process-lifetime-observer.mjs', import.meta.url)),
      String(identity.pid), identity.birth], { encoding: 'utf8', timeout: 10000 });
    const value = observed.status === 0 ? JSON.parse(observed.stdout) : null;
    check('fixture observes its own exited child before the blocked parent reaps it', value?.stat.startsWith('Z'), JSON.stringify({ code: observed.status, value, stderr: observed.stderr }));
    check('synchronous lifetime recognizes an observed zombie as exited', value?.synchronous === 'dead', JSON.stringify(value));
    check('asynchronous lifetime recognizes an observed zombie as exited', value?.asynchronous === 'dead', JSON.stringify(value));
    if (process.platform === 'darwin') {
      const bin = path.join(directory, 'bin');
      mkdirSync(bin);
      const marker = path.join(directory, 'actor-ps-used');
      writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nprintf forged > "$PB_ACTOR_PS_MARKER"\nprintf "ps: Operation not permitted\\n" >&2\nexit 1\n', { mode: 0o700 });
      const parent = requireProcess();
      const poisoned = spawnSync(process.execPath, [fileURLToPath(new URL('./process-lifetime-observer.mjs', import.meta.url)),
        String(parent.pid), parent.birth, 'unavailable'], { env: { ...process.env, PATH: bin, PB_ACTOR_PS_MARKER: marker }, encoding: 'utf8', timeout: 10000 });
      const alive = poisoned.status === 0 ? JSON.parse(poisoned.stdout) : null;
      check('actor PATH cannot execute or replace either protected Darwin lifetime observer', alive?.synchronous === 'alive'
        && alive?.asynchronous === 'alive' && !existsSync(marker), JSON.stringify({ code: poisoned.status, value: alive, stderr: poisoned.stderr }));
      const denied = spawnSync(process.execPath, [fileURLToPath(new URL('./process-lifetime-observer.mjs', import.meta.url)),
        String(parent.pid), parent.birth, 'denied'], { encoding: 'utf8', timeout: 10000 });
      const unknown = denied.status === 0 ? JSON.parse(denied.stdout) : null;
      check('simulated permission refusal at the protected lifetime boundary remains unknown in both observers', unknown?.synchronous === 'unknown'
        && unknown?.asynchronous === 'unknown', JSON.stringify({ code: denied.status, value: unknown, stderr: denied.stderr }));
    }
  } finally {
    writeFileSync(release, 'exit');
    await exited;
    const reaped = spawnSync('ps', ['-p', String(child.pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1000 });
    check('the owned exited zombie is separately reaped before fixture teardown', reaped.status === 1 && reaped.stdout.trim() === '',
      JSON.stringify({ pid: child.pid, code: reaped.status, stat: reaped.stdout.trim() }));
    rmSync(directory, { recursive: true, force: true });
  }
}

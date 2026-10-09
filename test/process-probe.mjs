import { spawnSync } from 'node:child_process';

export function processProbe(command, args, run = spawnSync) {
  const result = run(command, args, { encoding: 'utf8' });
  const noMatch = command === 'pgrep' && result.status === 1;
  if (result.error || result.signal || (result.status !== 0 && !noMatch)) {
    const spawnError = result.error ? JSON.stringify({ name: result.error.name,
      message: result.error.message, code: result.error.code, errno: result.error.errno,
      syscall: result.error.syscall, path: result.error.path, spawnargs: result.error.spawnargs }) : 'null';
    throw Object.assign(new Error(`process probe ${JSON.stringify([command, ...args])}`
      + ` status=${result.status} signal=${result.signal} error=${spawnError}\nstderr:\n${result.stderr ?? ''}`),
    { command, args, status: result.status, signal: result.signal, error: result.error, stderr: result.stderr });
  }
  return String(result.stdout ?? '');
}

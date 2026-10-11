import { check } from './check.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './sandbox.mjs';
import { serverDir } from './harness-cursor.mjs';
import { waitFor } from './harness.mjs';

const SB = makeSandbox('promptobus-cursor-session-atomic-');
const home = path.join(SB, 'home');
const server = 'cursor-agent';
const name = 'atomic-session';
const file = path.join(serverDir(home, server), 'sessions', `${name}.json`);
mkdirSync(path.dirname(file), { recursive: true });
const session = { name, server, panePid: process.pid, options: {}, busy: false };
writeFileSync(file, JSON.stringify(session));
const entered = path.join(SB, 'entered');
const release = path.join(SB, 'release');
const script = path.join(SB, 'writer.mjs');
const harness = fileURLToPath(new URL('./harness-cursor.mjs', import.meta.url));
writeFileSync(script, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.writeFileSync;
fs.writeFileSync = (target, ...args) => {
  if (String(target).startsWith(${JSON.stringify(file)})) {
    fs.closeSync(fs.openSync(target, 'w'));
    original(${JSON.stringify(entered)}, 'entered');
    const until = Date.now() + 10000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < until) Atomics.wait(pause, 0, 0, 5);
  }
  return original(target, ...args);
};
syncBuiltinESMExports();
const { tmuxMain } = await import(${JSON.stringify(harness)});
await tmuxMain(['-L', ${JSON.stringify(server)}, 'set-option', '-t', ${JSON.stringify(name)}, '@probe', 'committed']);
`);
const env = { ...process.env, PROMPTOBUS_E2E_CURSOR: home };
const child = spawn(process.execPath, [script], { env, stdio: 'pipe' });
let error = '';
child.stderr.on('data', (chunk) => { error += chunk; });
try {
  const paused = await waitFor(() => existsSync(entered), { timeoutMs: 10000 });
  check('Cursor stand exposes a deterministic pending session-write window', paused === true, error);
  let visible = null;
  try { visible = JSON.parse(readFileSync(file, 'utf8')); } catch { /* the verdict names a torn record */ }
  check('Cursor queue reader retains the complete session while an update is pending',
    visible?.name === name && visible?.panePid === process.pid, JSON.stringify(visible));
  writeFileSync(`${file}.unpublished`, JSON.stringify(session));
  const listed = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { tmuxMain } from ${JSON.stringify(harness)}; await tmuxMain(['-L', '${server}', 'list-sessions', '-F', '#{session_name}']);`],
  { env, encoding: 'utf8' });
  check('Cursor tmux listing sees exactly one published session during a pending write',
    listed.status === 0 && listed.stdout.trim() === name, `${listed.status} · ${listed.stdout}${listed.stderr}`);
} finally {
  writeFileSync(release, 'release');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 10000 });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
const published = JSON.parse(readFileSync(file, 'utf8'));
check('Cursor session update is published after the write completes',
  child.exitCode === 0 && published.options?.['@probe'] === 'committed', `${child.exitCode} · ${error}`);

import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, makeSockPath } from './sandbox.mjs';
import { harnessSessions, installHarness, planParticipant, stopAll, waitFor } from './harness.mjs';
import { LIVE_RECORD, processTable } from '../scripts/live-run.mjs';

const SB = makeSandbox('promptobus-e2e-live-script-');
const runs = path.join(SB, 'runs');
mkdirSync(runs);
const harness = await installHarness({ binDir: path.join(SB, 'bin'), sock: makeSockPath('a2h-') });
planParticipant(harness.home, 'worker:e2e', { turns: [{ detail: 'fixture idle', do: [] }] });
const env = { ...process.env, TMPDIR: runs, TMP: runs, TEMP: runs };
for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
const script = fileURLToPath(new URL('../scripts/live-e2e.mjs', import.meta.url));
const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const own = [];
try {
  const launched = await waitFor(() => {
    const sessions = harnessSessions(harness.home);
    const dirs = readdirSync(runs).filter((name) => name.startsWith('promptobus-live-e2e-'));
    if (!sessions.length || !dirs.length) return null;
    const dir = path.join(runs, dirs[0]);
    try {
      const record = JSON.parse(readFileSync(path.join(dir, LIVE_RECORD), 'utf8'));
      return { dir, record, sessions };
    } catch { return null; }
  }, { timeoutMs: 30_000 });
  check('actual live-e2e starts only stub participants in the private stand',
    !!launched && launched.sessions.every((s) => s.cwd.startsWith(realpathSync(SB))), output.slice(-1000));
  if (launched) {
    own.push(...launched.record.processes, ...processTable().filter((p) => launched.sessions.some((s) => s.pid === p.pid)));
    child.kill('SIGTERM');
    const exited = await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 30_000 });
    const lines = output.split('\n').filter((line) => line.startsWith('▸ aborted (SIGTERM): '));
    const result = lines.length ? JSON.parse(lines.at(-1).split(': ').slice(1).join(': ')) : null;
    check('actual live-e2e abort awaits cleanup and reports held ancestry',
      exited && child.exitCode === 143 && result?.safe === false && result.livePids.length === 0 && result.failures.some((reason) => reason.includes('ancestry')), output.slice(-1500));
    check('actual live-e2e preserves the stand after recorded session and process death',
      existsSync(launched.dir) && harnessSessions(harness.home).length === 0
      && !processTable().some((p) => own.some((record) => record.pid === p.pid && record.birth === p.birth)), output.slice(-1500));
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 10_000 });
  await stopAll(harness.home);
  for (const record of own) {
    if (processTable().some((p) => p.pid === record.pid && p.birth === record.birth)) {
      try { process.kill(record.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
  await waitFor(() => !processTable().some((p) => own.some((r) => p.pid === r.pid && p.birth === r.birth)), { timeoutMs: 10_000 });
  harness.restore();
}

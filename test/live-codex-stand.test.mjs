// The canonical live Codex scenario, driven whole on the stub `codex app-server`: a neutral caller
// of the real script for its task identity and for an abort after the participant is up. Run: npm test
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import { HANG_AFTER_START_VAR, installHarness, parseHomeToml, pidAlive, planParticipant } from './harness-codex.mjs';
import { waitFor } from './harness.mjs';
import { MIN_AGE_MS, RUN_OWNER_FILE } from '../scripts/canary-runs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'scripts', 'live-codex.mjs');
const SB = makeSandbox('promptobus-promptobus-live-codex-stand-');
const { home: HARNESS, restore } = await installHarness({ binDir: path.join(SB, 'bin') });
const WORKER = 'worker:live';
planParticipant(HARNESS, WORKER, {
  turns: [{ do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: 'LIVE-CODEX-HELLO from the stand' } }] }],
});

function start(env = {}) {
  const child = spawn(process.execPath, [SCRIPT], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const run = { child, out: '', exit: null };
  child.stdout.on('data', (c) => { run.out += c; });
  child.stderr.on('data', (c) => { run.out += c; });
  run.done = new Promise((resolve) => child.on('exit', (code, signal) => { run.exit = { code, signal }; resolve(run.exit); }));
  return run;
}
const line = (out, re) => re.exec(out)?.[1] ?? null;
const passed = (out, name) => out.split('\n').some((l) => l.startsWith(`✔ ${name}`));
const taskOfThread = () => readdirSync(path.join(HARNESS, 'threads')).map((n) => {
  try {
    const thread = JSON.parse(readFileSync(path.join(HARNESS, 'threads', n), 'utf8'));
    return Object.values(parseHomeToml(thread.codexHome?.config).mcp_servers ?? {})
      .map((s) => s?.env).find((e) => e?.PROMPTOBUS_ROLE === WORKER)?.PROMPTOBUS_TASK ?? null;
  } catch { return null; }
}).filter(Boolean);

// --- a whole run: the id the script prints is the id its participant was handed -------------------

const whole = start();
await Promise.race([whole.done, new Promise((r) => { setTimeout(r, 120000); })]);
if (!whole.exit) whole.child.kill('SIGKILL');
const task = line(whole.out, /^▸ task: (\S+)$/m);
const steps = [
  'step 1: promptobus spawn --harness codex --permission-mode read-only raised a participant',
  'step 1: the thread landed in the mechanism registry, the holder is alive',
  'step 2: status reached the orchestrator — the bus loop from Codex closed',
  'step 3: stop kills the holder and drops the record',
  'personal ~/.codex/config.toml did not change over the run (sha)',
];
check('stand: the live Codex scenario closes its loop on the stub — spawn, status, stop, personal config',
  steps.every((name) => passed(whole.out, name)), whole.out.slice(-1500));
check('stand: the run names its own task id, and its participant\'s bus server carries that same id',
  /^livecodex-t\d{14}$/.test(task ?? '') && taskOfThread().includes(task), `${task} · threads ${JSON.stringify(taskOfThread())}`);
const sandbox = line(whole.out, /^▸ sandbox: (\S+) ·/m);
check('stand: the whole run leaves no sandbox', !!sandbox && !existsSync(sandbox), sandbox);

// --- an abort after the participant is up, beside two foreign sandboxes ---------------------------

const plant = (name, pid, ageMs) => {
  const dir = path.join(os.tmpdir(), `promptobus-live-codex-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, RUN_OWNER_FILE), JSON.stringify({ pid, path: dir }));
  utimesSync(dir, (Date.now() - ageMs) / 1000, (Date.now() - ageMs) / 1000);
  return dir;
};
const deadNeighbour = plant(`dead-${process.pid}`, 2 ** 22 + 1, 0);
const liveNeighbour = plant(`live-${process.pid}`, process.pid, 2 * MIN_AGE_MS);

const cut = start({ [HANG_AFTER_START_VAR]: '1' });
const up = await waitFor(() => (/participant start/.test(cut.out) ? true : null), { timeoutMs: 60000 });
const cutBox = line(cut.out, /^▸ sandbox: (\S+) ·/m);
let record = null;
try {
  const sessions = path.join(cutBox, 'codex-state', 'sessions');
  const file = readdirSync(sessions).find((n) => n.endsWith('.json'));
  record = JSON.parse(readFileSync(path.join(sessions, file), 'utf8'));
} catch { record = null; }
const pids = [record?.holderPid, record?.appPid].filter(Number.isInteger);
check('abort: before the signal the participant is up — its holder and app-server are alive',
  !!up && pids.length === 2 && pids.every(pidAlive), `${cut.out.slice(-800)} · record ${JSON.stringify(record)}`);
check('abort: the start sweep took the dead owner\'s sandbox and held the live owner\'s',
  !existsSync(deadNeighbour) && existsSync(liveNeighbour) && /held, their owner is alive: .*live-/.test(cut.out),
  cut.out.split('\n').filter((l) => l.startsWith('▸')).join(' | '));
cut.child.kill('SIGTERM');
const exit = await Promise.race([cut.done, new Promise((r) => { setTimeout(() => r(null), 30000); })]);
const gone = await waitFor(() => (pids.every((p) => !pidAlive(p)) ? true : null), { timeoutMs: 20000 });
check('abort: SIGTERM ends the run through its cleanup — exit 143 and the cut-off line',
  exit?.code === 143 && /run cut off by SIGTERM/.test(cut.out), `${JSON.stringify(exit)} · ${cut.out.slice(-600)}`);
check('abort: the sandbox is gone, and with its thread record the holder and the app-server',
  !!cutBox && !existsSync(cutBox) && !!gone, `sandbox ${cutBox} · alive ${pids.filter(pidAlive).join(', ') || 'none'}`);
check('abort: the live owner\'s sandbox beside it is untouched', existsSync(liveNeighbour), liveNeighbour);
if (!exit) cut.child.kill('SIGKILL');
for (const pid of pids.filter(pidAlive)) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}
rmSync(liveNeighbour, { recursive: true, force: true });
restore();

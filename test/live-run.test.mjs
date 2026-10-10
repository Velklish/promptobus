import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox } from './sandbox.mjs';
import { waitFor } from './harness.mjs';
import { LIVE_RECORD, liveRun, onAbort, parseLiveSessions, priorRunIsLive, processTable } from '../scripts/live-run.mjs';
import { sessionName } from '../lib/spawn.js';
import { freshScenarioIdentity, store } from './scenario.mjs';
import { sweepPreviousRuns, MIN_AGE_MS } from '../scripts/canary-runs.mjs';

const SB = makeSandbox('promptobus-e2e-live-cleanup-');
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const samePid = (pid) => processTable().some((p) => p.pid === pid);
const stand = (name) => { const dir = path.join(SB, name); mkdirSync(dir); return dir; };
const processRow = (pid, parent = 1, group = pid, birth = `born-${pid}`) => ({ pid, parent, group, birth });
const participant = (sessionId, cwd) => ({ metadata: { sessionId, worktree: cwd } });
const session = (sessionId, cwd, pid = 31001) => ({ sessionId, cwd, id: `id-${sessionId}`, pid });

const clock = new Date('2026-10-03T00:00:00Z');
const identityA = freshScenarioIdentity('e2ebus', clock);
const identityB = freshScenarioIdentity('e2ebus', clock);
check('consecutive scenario identities and visible titles differ',
  identityA.id !== identityB.id && identityA.title !== identityB.title);
check('native visible participant names differ for consecutive runs',
  sessionName({ title: identityA.title, adapter: { stamp: identityA.stamp } }, { slug: 'e2e', title: identityA.title })
  !== sessionName({ title: identityB.title, adapter: { stamp: identityA.stamp } }, { slug: 'e2e', title: identityB.title }));
check('scenario identities retain the canonical machine stamp',
  identityA.stamp === store.stampOfId(identityA.id) && identityA.title.includes(identityA.id));

for (const value of ['{}', 'null', '{"agents":{}}', '[null]', '[{}]', '[{"sessionId":"own"}]']) {
  let refused = false;
  try { parseLiveSessions({ status: 0, stdout: value }); } catch { refused = true; }
  check(`malformed native registry ${value} refuses`, refused);
}
check('an explicit empty native registry is readable', parseLiveSessions({ status: 0, stdout: '[]' }).length === 0);

const emitter = new EventEmitter();
let release;
let finished = false;
let exited = null;
const dispose = onAbort(async () => { await new Promise((r) => { release = r; }); finished = true; },
  { emitter, exit: (code) => { exited = code; } });
emitter.emit('SIGINT');
emitter.emit('SIGTERM');
check('abort waits for cleanup and coalesces repeated signals', exited === null && !!release && !finished);
release();
await new Promise((r) => setImmediate(r));
check('abort exits only after cleanup completes', finished && exited === 130);
dispose();
check('abort hooks can be removed', emitter.listenerCount('SIGINT') === 0 && emitter.listenerCount('SIGTERM') === 0);

for (const [name, readSessions, stopSession, rows] of [
  ['unreadable-registry', () => null, async () => ({ ok: true, stopped: true }), []],
  ['failed-stop', () => [session('own', path.join(SB, 'failed-stop', 'wt'))], async () => ({ ok: false }), [processRow(31001)]],
  ['surviving-process', () => [], async () => ({ ok: true, stopped: true }), [processRow(31001)]],
  ['failed-discovery', () => [], async () => ({ ok: true, stopped: true }), null],
]) {
  const dir = stand(name);
  const run = liveRun({ sandbox: dir, readSessions, stopSession,
    readProcesses: () => { if (!rows) throw new Error('ps refused'); return rows; }, kill: () => {}, timeoutMs: 0 });
  run.start({ workspace: dir, participants: () => name === 'failed-stop' ? [participant('own', path.join(dir, 'wt'))] : [] });
  if (name === 'surviving-process') run.child({ pid: 31001, exitCode: null, signalCode: null }, { detached: true });
  const result = await run.cleanup();
  check(`${name} preserves the stand and reports uncertainty`, !result.safe && existsSync(dir) && result.failures.length > 0,
    JSON.stringify(result));
  check(`${name} refuses the previous-run sweep`, priorRunIsLive(dir, { readProcesses: () => rows }));
}

for (const [name, bad] of [
  ['wrong-cwd', session('own', SB)],
  ['missing-id', { sessionId: 'own', cwd: path.join(SB, 'missing-id', 'wt'), pid: 31001 }],
  ['missing-pid', { sessionId: 'own', cwd: path.join(SB, 'missing-pid', 'wt'), id: 'id-own' }],
]) {
  const dir = stand(name);
  const stopped = [];
  const run = liveRun({ sandbox: dir, readSessions: () => [bad],
    stopSession: async (id) => { stopped.push(id); return { ok: true, stopped: true }; },
    readProcesses: () => [], timeoutMs: 0 });
  run.start({ workspace: dir, participants: () => [participant('own', path.join(dir, 'wt'))] });
  const result = await run.cleanup();
  check(`${name} refuses a malformed session without stopping it`, !result.safe && stopped.length === 0 && existsSync(dir));
}

{
  const dir = stand('foreign-registry');
  const own = session('own', path.join(dir, 'wt'));
  const foreign = session('foreign', path.join(dir, 'wt'), 31002);
  let registry = [own, foreign];
  let rows = [processRow(31001), processRow(31002)];
  const stopped = [];
  const signalled = [];
  const run = liveRun({ sandbox: dir, readSessions: () => registry,
    stopSession: async (id) => { stopped.push(id); registry = [foreign]; rows = [processRow(31002)]; return { ok: true, stopped: true }; },
    readProcesses: () => rows, kill: (pid) => signalled.push(pid), timeoutMs: 0 });
  run.start({ workspace: dir, participants: () => [participant('own', own.cwd)] });
  run.captureSessions();
  const result = await run.cleanup();
  check('cleanup stops only the exact task-bound full session identity',
    result.safe && stopped.join(',') === 'own' && registry[0] === foreign && signalled.length === 0, JSON.stringify(result));
  let denied = false;
  try { run.assertRunning(); } catch { denied = true; }
  check('cleanup prevents subsequent scenario commands', denied);
}

{
  const dir = stand('reused-pid');
  let rows = [processRow(32001)];
  const signalled = [];
  const run = liveRun({ sandbox: dir, readSessions: () => [], stopSession: async () => {},
    readProcesses: () => rows, kill: (pid) => signalled.push(pid), timeoutMs: 0 });
  run.child({ pid: 32001, exitCode: null, signalCode: null });
  rows = [processRow(32001, 1, 33001, 'replacement')];
  const result = await run.cleanup();
  check('a reused pid is never signalled as the old owned process', result.safe && signalled.length === 0);
}

for (const mode of ['absent-first-row', 'absent-after-observation', 'changed-birth', 'changed-session-pid']) {
  const dir = stand(mode);
  const own = session('own', path.join(dir, 'wt'));
  let registry = [own];
  let rows = [processRow(31001)];
  const stopped = [];
  const run = liveRun({ sandbox: dir, readSessions: () => registry, readProcesses: () => rows, timeoutMs: 0,
    kill: () => {}, stopSession: async (id) => { stopped.push(id); return { ok: true, stopped: true }; } });
  run.start({ workspace: dir, participants: () => [participant('own', own.cwd)] });
  if (mode === 'absent-first-row') registry = [];
  else {
    run.captureSessions();
    if (mode === 'absent-after-observation') registry = [];
    else if (mode === 'changed-birth') rows = [processRow(31001, 1, 31001, 'replacement')];
    else { registry = [{ ...own, pid: 31002 }]; rows = [processRow(31002)]; }
  }
  const result = await run.cleanup();
  check(`${mode} cannot prove death or stop a changed process`, !result.safe && existsSync(dir) && stopped.length === 0, JSON.stringify(result));
}

{
  const dir = stand('native-descendant');
  const own = session('own', path.join(dir, 'wt'));
  let registry = [own];
  let rows = [processRow(31001), processRow(31003, 31001, 31001)];
  const signalled = [];
  const run = liveRun({ sandbox: dir, readSessions: () => registry, readProcesses: () => rows, timeoutMs: 0,
    kill: (pid) => signalled.push(pid), stopSession: async () => {
      registry = []; rows = [processRow(31003, 1, 31001)]; return { ok: true, stopped: true };
    } });
  run.start({ workspace: dir, participants: () => [participant('own', own.cwd)] });
  run.captureSessions();
  const result = await run.cleanup();
  check('a surviving native descendant holds the stand without raw native signals',
    !result.safe && existsSync(dir) && result.livePids.includes(31003) && signalled.length === 0, JSON.stringify(result));
}

const fixtureChildren = new Set();
const fixtureSpawn = (...args) => {
  const child = spawn(...args); fixtureChildren.add(child); return child;
};
process.on('exit', () => { for (const child of fixtureChildren) child.kill('SIGKILL'); });
const fixture = path.join(SB, 'abort-fixture.mjs');
const idleCode = 'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)';
writeFileSync(fixture, `
import { spawn } from 'node:child_process';
import { liveRun, onAbort } from ${JSON.stringify(new URL('../scripts/live-run.mjs', import.meta.url).href)};
const sandbox = process.argv[2];
const run = liveRun({ sandbox, readSessions: () => [], stopSession: async () => {}, timeoutMs: 100 });
const child = spawn(process.execPath, ['-e', ${JSON.stringify(idleCode)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
run.child(child, { detached: true });
await new Promise((resolve) => child.stdout.once('data', resolve));
onAbort(async () => { const result = await run.cleanup(); process.stdout.write(JSON.stringify(result)+'\\n'); });
process.stdout.write(JSON.stringify({ready:true,pid:child.pid})+'\\n');
setInterval(()=>{},1000);
`);

async function launch(name) {
  const dir = stand(name);
  const parent = fixtureSpawn(process.execPath, [fixture, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  parent.stdout.on('data', (chunk) => { output += chunk; });
  parent.stderr.on('data', (chunk) => { errors += chunk; });
  const ready = await waitFor(() => {
    try { return JSON.parse(output.split('\n')[0]); } catch { return null; }
  }, { timeoutMs: 10_000 });
  if (!ready?.ready) { parent.kill('SIGKILL'); throw new Error(`fixture not ready: ${errors}`); }
  return { dir, parent, pid: ready.pid, output: () => output, errors: () => errors };
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  const foreign = fixtureSpawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const run = await launch(signal);
  try {
    run.parent.kill(signal);
    const dead = await waitFor(() => run.parent.exitCode !== null, { timeoutMs: 10_000 });
    check(`${signal} performs awaited cleanup of real owned Node children`,
      dead && run.parent.exitCode === code && !samePid(run.pid) && !existsSync(run.dir), `${run.output()} ${run.errors()}`);
    check(`${signal} leaves an unrelated Node process alive`, samePid(foreign.pid));
  } finally {
    if (samePid(run.pid)) process.kill(run.pid, 'SIGKILL');
    if (run.parent.exitCode === null) run.parent.kill('SIGKILL');
    foreign.kill('SIGTERM');
    await waitFor(() => !samePid(run.pid) && foreign.exitCode !== null && run.parent.exitCode !== null, { timeoutMs: 10_000 });
  }
}

{
  const run = await launch('killed-parent');
  try {
    run.parent.kill('SIGKILL');
    await waitFor(() => run.parent.signalCode !== null, { timeoutMs: 10_000 });
    const swept = sweepPreviousRuns(SB, { prefix: 'killed-parent', keep: 0, now: Date.now() + MIN_AGE_MS + 1000,
      isLive: priorRunIsLive });
    check('SIGKILL parent leaves the recorded orphan stand held by the sweep',
      samePid(run.pid) && existsSync(run.dir) && swept.length === 0);
    const next = freshScenarioIdentity('e2ebus', clock);
    check('a new run cannot reuse the interrupted task id or visible title',
      next.id !== identityA.id && next.title !== identityA.title);
    process.kill(run.pid, 'SIGKILL');
    await waitFor(() => !samePid(run.pid), { timeoutMs: 10_000 });
    check('an unverified old lifecycle remains held even after orphan death', priorRunIsLive(run.dir));
    const record = JSON.parse(readFileSync(path.join(run.dir, LIVE_RECORD), 'utf8'));
    record.deathVerified = true;
    writeFileSync(path.join(run.dir, LIVE_RECORD), JSON.stringify(record));
    const removed = sweepPreviousRuns(SB, { prefix: 'killed-parent', keep: 0, now: Date.now() + MIN_AGE_MS + 1000,
      isLive: priorRunIsLive });
    check('a confirmed dead old lifecycle is eligible for the shared sweep', removed.length === 1 && !existsSync(run.dir), JSON.stringify({ record, removed, held: priorRunIsLive(run.dir),
      processes: processTable().filter((p) => record.processes.some((own) => own.pid === p.pid) || record.groups.includes(p.group)) }));
  } finally {
    if (samePid(run.pid)) process.kill(run.pid, 'SIGKILL');
    if (run.parent.exitCode === null && run.parent.signalCode === null) run.parent.kill('SIGKILL');
    await waitFor(() => !samePid(run.pid), { timeoutMs: 10_000 });
  }
}

const e2e = readFileSync(path.join(sourceRoot, 'scripts/live-e2e.mjs'), 'utf8');
check('live-e2e wires awaited abort cleanup and guarded prior-run sweeping',
  /onAbort\(async/.test(e2e) && /await cleanup\(\)/.test(e2e) && /isLive: priorRunIsLive/.test(e2e)
  && !/makeSandbox\(/.test(e2e) && !/import.*makeSockDir/.test(e2e));
for (const name of ['cursor', 'codex', 'mixed']) {
  const src = readFileSync(path.join(sourceRoot, `scripts/live-${name}.mjs`), 'utf8');
  check(`live-${name} consumes the fresh task identity and visible title`,
    src.includes(`freshScenarioIdentity('live${name}')`) && /createTask\(home, \{ \.\.\.identity/.test(src));
  for (const match of src.matchAll(/from ['"]([^'"]+)['"]/g)) {
    const target = match[1];
    check(`live-${name} standalone import ${target}`, target.startsWith('node:')
      || target.startsWith('.') && existsSync(path.resolve(sourceRoot, 'scripts', target)));
  }
}
const cursor = readFileSync(path.join(sourceRoot, 'scripts/live-cursor.mjs'), 'utf8');
check('live Cursor reads state through the host state-home route',
  /const STATE_HOME = cursorStateHome\(\)/.test(cursor) && /path\.join\(STATE_HOME, 'sessions'\)/.test(cursor));

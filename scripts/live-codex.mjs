#!/usr/bin/env node
// Live check of the Codex driver on a real `codex app-server`. Run:
//
//   node scripts/live-codex.mjs [--model <id>]
//
// Not in `npm test` and not in the release gate: it spends a Codex account limit
// (the same as the owner's ChatGPT.app) and talks to a live binary. The workspace
// is temporary, `{claude, codex}` only inside it. The script does not read the
// person's `~/.codex` for content and does not write it; a sha of `config.toml`
// before and after is required.
//
// **This run does not take filesystem write rights.** Spawn goes
// `--permission-mode read-only`. Whether `app-server` with `workspace-write`
// writes a `[projects."…"]` section is not checked here.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { makeSandbox, writeHostConfig, resolveToolBin } from '../test/sandbox.mjs';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { buildWorkspace, cli, MECHANISM_ROOT, store } from '../test/scenario.mjs';
import { waitFor } from '../test/harness.mjs';

const { codexDriver, DEFAULT_MODEL } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-codex.js'));
const { readSession } = await import(path.join(MECHANISM_ROOT, 'lib', 'codex-session.js'));

const RELIED = [
  'initialize',
  'account/rateLimits/updated',
  'model/list',
  'thread/start',
  'thread/name/set',
  'turn/start',
  'turn/steer',
  'review/start',
  'turn/interrupt',
];

const argv = process.argv.slice(2);
const at = argv.indexOf('--model');
const MODEL = at >= 0 && at + 1 < argv.length ? argv[at + 1] : DEFAULT_MODEL;

const tool = resolveToolBin('codex');
if (!tool.ok) {
  console.error(`✖ nothing to drive the live run with: ${tool.reason}`);
  process.exit(1);
}

const leaked = SESSION_LEAK_VARS.filter((name) => name in process.env);
dropSessionLeaks(process.env);

const verdicts = [];
const times = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  verdicts.push({ name, ok, detail: ok ? '' : String(detail).slice(0, 600) });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${String(detail).slice(0, 600)}`}\n`);
}
function at_(name, ms) {
  times.push(`${name} ${(ms / 1000).toFixed(1)} s`);
  process.stdout.write(`  · ${name}: ${(ms / 1000).toFixed(1)} s\n`);
}

function shaFile(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function pgrep(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  return String(r.stdout ?? '').trim().split('\n').filter(Boolean);
}

const CONFIG = path.join(homedir(), '.codex', 'config.toml');
const shaBefore = shaFile(CONFIG);
const pgrepBefore = {
  cask: pgrep('Caskroom/codex'),
  app: pgrep('app-server --stdio'),
};

const SB = makeSandbox('promptobus-live-codex-');
const TASK = `livecodex-t${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
const WORKER = 'worker:live';
const ORCH_SESSION = `orch-live-codex-${process.pid}`;
const MARK = 'LIVE-CODEX-HELLO';
const stateHome = path.join(SB, 'codex-state');
process.env.PROMPTOBUS_CODEX_HOME = stateHome;

const { ws, repo } = buildWorkspace(SB);
writeHostConfig(ws, { tools: ['claude', 'codex'] });
const home = path.join(ws, '.promptobus');

const workerBrief = path.join(SB, 'worker-brief.md');
writeFileSync(workerBrief, `# Live check of the bus loop from Codex

You are a Promptobus bus participant. Do exactly this and nothing more:

1. Send the orchestrator a status message whose body starts with the line «${MARK}».
2. End the turn. Do not create or edit files.
`);

const env = {
  ...process.env,
  PROMPTOBUS_HOME: home,
  CLAUDE_CODE_SESSION_ID: ORCH_SESSION,
  PROMPTOBUS_WARDEN: 'off',
  PROMPTOBUS_CODEX_HOME: stateHome,
};

store.createTask(home, { id: TASK, title: 'живая проверка driver’а Codex', owner: ORCH_SESSION });

process.stdout.write(`▸ live Codex run: ${tool.path}${tool.version ? ` (${tool.version})` : ''}\n`);
process.stdout.write(`▸ model: ${MODEL} · sandbox: read-only · approvalPolicy: on-request\n`);
process.stdout.write(`▸ mechanism: ${MECHANISM_ROOT}\n`);
process.stdout.write(`▸ sandbox: ${SB} · store: ${home}\n`);
process.stdout.write(`▸ sha ~/.codex/config.toml before: ${shaBefore ?? '(no file)'}\n`);
if (leaked.length) process.stdout.write(`▸ stripped from the run environment: ${leaked.join(', ')}\n`);

let ref = '';
let methodsCalled = [];
const t0 = Date.now();
try {
  const t2 = Date.now();
  const spawned = cli([ 'spawn', '--repo', repo, '--brief', workerBrief, '--task', TASK,
    '--worker', 'live', '--harness', 'codex', '--model', MODEL, '--permission-mode', 'read-only'],
  { cwd: ws, env });
  check('step 1: promptobus spawn --harness codex --permission-mode read-only raised a participant',
    spawned.status === 0 && /worker worker:live lifted/.test(spawned.out), spawned.out.slice(-800));
  at_('participant start', Date.now() - t2);

  const wp = store.participantOf(store.readTask(home, TASK), WORKER);
  ref = wp?.sessionRef ?? '';
  const record = readSession(ref, env);
  methodsCalled = [...(record?.methodsCalled ?? [])];
  check('step 1: the thread landed in the mechanism registry, the holder is alive',
    !!record?.threadId && record.state === 'alive' && typeof record.holderPid === 'number',
    JSON.stringify({ threadId: record?.threadId, state: record?.state, holder: record?.holderPid }));
  check('step 1: thread sandbox is read-only (the live run does not take write rights)',
    record?.sandbox === 'read-only', record?.sandbox);

  const statusOut = cli([ 'status', '--task', TASK], { cwd: ws, env });
  check('step 1: promptobus status shows the Codex session is alive',
    statusOut.status === 0 && statusOut.out.includes(WORKER), statusOut.out.slice(-400));

  const t3 = Date.now();
  const hello = await waitFor(() => store.glanceInbox(home, TASK, 'orchestrator')
    .find((m) => String(m.body ?? '').includes(MARK)) ?? null, { timeoutMs: 300000 });
  check('step 2: status reached the orchestrator — the bus loop from Codex closed',
    !!hello, JSON.stringify(hello));
  at_('participant first turn', Date.now() - t3);

  const idle = await waitFor(() => {
    const view = codexDriver.inspect(ref);
    return view && view.state === 'alive' && view.busy === false ? view : null;
  }, { timeoutMs: 30000 });
  check('step 2: the turn ended — the session is alive and not busy',
    idle?.state === 'alive' && idle?.busy === false, JSON.stringify(idle));

  const live = readSession(ref, env);
  methodsCalled = [...new Set([...(methodsCalled ?? []), ...(live?.methodsCalled ?? [])])];

  const t6 = Date.now();
  const stopped = await codexDriver.stop(ref);
  check('step 3: stop kills the holder and drops the record',
    stopped.ok && stopped.stopped && !readSession(ref, env), JSON.stringify(stopped));
  check('step 3: inspect after stop is gone',
    codexDriver.inspect(ref).state === 'gone', JSON.stringify(codexDriver.inspect(ref)));
  at_('stop', Date.now() - t6);
} catch (e) {
  check('the run reached the end without a break', false, e.stack ?? e.message);
} finally {
  if (ref) await Promise.resolve(codexDriver.stop(ref)).catch(() => {});
  rmSync(SB, { recursive: true, force: true });
}

const shaAfter = shaFile(CONFIG);
check('personal ~/.codex/config.toml did not change over the run (sha)',
  shaBefore === shaAfter, `${shaBefore} → ${shaAfter}`);

const pgrepAfter = {
  cask: pgrep('Caskroom/codex'),
  app: pgrep('app-server --stdio'),
};
const extraCask = pgrepAfter.cask.filter((p) => !pgrepBefore.cask.includes(p));
const extraApp = pgrepAfter.app.filter((p) => !pgrepBefore.app.includes(p));
check('no new Caskroom/codex processes after the loop', extraCask.length === 0, extraCask.join(' | '));
check('no new app-server --stdio processes after the loop', extraApp.length === 0, extraApp.join(' | '));

const unobserved = RELIED.filter((m) => !methodsCalled.includes(m));

const passed = verdicts.filter((v) => v.ok).length;
process.stdout.write(`\n${passed}/${verdicts.length} verdicts passed\n`);
process.stdout.write(`durations: ${times.join(' · ') || '—'} · total ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
process.stdout.write(`binary: ${tool.path}${tool.version ? ` (${tool.version})` : ''} · model: ${MODEL}\n`);
process.stdout.write(`methods the holder saw: ${methodsCalled.join(', ') || '(empty)'}\n`);
process.stdout.write(`declared surface not observed: ${unobserved.join(', ') || 'none'}\n`);
process.stdout.write(`  (unobserved is not missing; the stand covers them)\n`);
process.stdout.write(`sha config.toml: ${shaBefore ?? '(none)'} → ${shaAfter ?? '(none)'}\n`);
process.stdout.write(`pgrep Caskroom/codex: was ${pgrepBefore.cask.length}, became ${pgrepAfter.cask.length}\n`);
process.stdout.write(`pgrep 'app-server --stdio': was ${pgrepBefore.app.length}, became ${pgrepAfter.app.length}\n`);
process.exitCode = passed === verdicts.length ? 0 : 1;

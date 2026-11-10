import './home.mjs';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { check } from './check.mjs';
import { createStandaloneHost } from '../dist/host-index.js';
import * as store from '../lib/store.js';
import { REGISTRY } from '../lib/drivers.js';
import { createHarnessRegistry } from '../lib/harness-registry.js';
import { liveReservations, reservationFile, reserveLiveSeat, reservedSpawn, recoverLiveSeat } from '../lib/live-reservation.js';

const root = fs.mkdtempSync(path.join(tmpdir(), 'promptobus-routing-live-reservation-'));
const childFile = fileURLToPath(new URL('./fixtures/live-reservation-child.mjs', import.meta.url));
let serial = 0;
function fixture(harness = 'codex', cap = 1) {
  const dir = path.join(root, String(++serial));
  fs.mkdirSync(dir);
  const host = createStandaloneHost({ cwd: dir });
  const home = host.promptobusHome(), task = 'synthetic-t20261110-000000';
  store.createTask(home, { id: task, title: 'Synthetic reservation', owner: 'synthetic-owner' });
  const owner = store.participantOf(store.readTask(home, task), 'orchestrator');
  store.upsertParticipant(home, task, { ...owner, sessionRef: 'synthetic-owner' });
  const overlay = path.join(dir, 'overlay.json');
  fs.writeFileSync(overlay, JSON.stringify({ schemaVersion: 2, caps: { liveParticipants: { [harness]: cap } } }));
  host.routingPaths = () => ({ overlays: [{ id: 'test', path: overlay, writable: true }] });
  const env = { ...process.env, [`PROMPTOBUS_${harness.toUpperCase()}_HOME`]: path.join(dir, harness) };
  Object.assign(process.env, { [`PROMPTOBUS_${harness.toUpperCase()}_HOME`]: path.join(dir, harness) });
  return { dir, host, home, task, env, harness, overlay };
}
const reserve = (f, address = 'worker:first') => reserveLiveSeat(f.host, f.home, f.task, address, f.harness, address.replace(':', '-'), f.env);
function caught(fn) { try { fn(); return ''; } catch (e) { return e.message; } }
function editSeat(f, patch) {
  const seats = liveReservations(f.home, f.task);
  store.writeJsonAtomic(reservationFile(f.home, f.task), seats.map(s => ({ ...s, ...patch })));
}
async function waitFor(fn) {
  const until = Date.now() + 15000;
  while (!fn()) {
    if (Date.now() > until) throw new Error('synthetic fixture did not reach its checkpoint');
    await new Promise(r => setTimeout(r, 10));
  }
}
const deadIdentity = JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e',
  `import {processIdentity} from ${JSON.stringify(new URL('../lib/service-state.js', import.meta.url).href)}; console.log(JSON.stringify(processIdentity(process.pid)))`],
{ encoding: 'utf8' }).stdout);
const originalInspect = Object.fromEntries(Object.entries(REGISTRY.drivers).map(([h, d]) => [h, d.inspect]));
try {
  for (const harness of ['claude', 'cursor', 'codex', 'opencode']) {
    for (const cap of [1, 2]) {
      const f = fixture(harness, cap);
      if (cap === 2) {
        const reg = createHarnessRegistry({ harness });
        reg.writeSession({ ref: 'attached', holderPid: process.pid, threadId: 'attached', state: 'alive' }, f.env);
        fs.writeFileSync(path.join(f.dir, 'attached.live'), 'synthetic');
        store.upsertParticipant(f.home, f.task, store.participantRecord('reporter', {
          harness, mode: 'attached', sessionRef: 'attached',
        }));
      }
      const children = ['worker:first', 'reviewer:second', 'teamlead:third'].map(address => {
        const child = spawn(process.execPath, [childFile, f.dir, f.home, f.task, harness, address, address.split(':')[0]],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
        return { child, address, done: new Promise(resolve => child.once('close', code => resolve({ code, output }))) };
      });
      try {
        await waitFor(() => children.every(c => fs.existsSync(path.join(f.dir, `${c.address.replace(':', '-')}.ready`))));
        fs.writeFileSync(path.join(f.dir, 'go'), 'go');
        await waitFor(() => children.every(c => fs.existsSync(path.join(f.dir, `${c.address.replace(':', '-')}.result`))));
        const results = children.map(c => JSON.parse(fs.readFileSync(path.join(f.dir, `${c.address.replace(':', '-')}.result`))));
        check(`${harness} cap ${cap} concurrent worker reviewer teamlead admits one remaining seat`,
          results.filter(r => r.launched).length === 1 && results.filter(r => !r.launched).every(r =>
            r.error.includes(`caps.liveParticipants.${harness}=${cap}`) && r.error.includes(f.overlay)), JSON.stringify(results));
      } finally { fs.writeFileSync(path.join(f.dir, 'release'), 'release'); }
      const outcomes = await Promise.all(children.map(c => c.done));
      check(`${harness} cap ${cap} synthetic launchers exit normally`, outcomes.every(r => r.code === 0), JSON.stringify(outcomes));
    }
  }
  const f = fixture(); reserve(f);
  check('live launcher retains a provisional seat even when its session is absent', !!caught(() => reserve(f, 'reviewer:next')));
  editSeat(f, { owner: { pid: 2147483646, birth: 'unknown-process-format' } });
  check('unknown launcher identity retains the seat and names owner recovery', /Stop the launcher.*stop worker:first/s.test(caught(() => reserve(f))));
  editSeat(f, { owner: deadIdentity });
  check('dead launcher before native start is recoverable without a child-link intent', !!reserve(f).token);

  const sameAddress = fixture('claude');
  const attempts = ['one', 'two'].map(attempt => {
    const child = spawn(process.execPath, [childFile, sameAddress.dir, sameAddress.home, sameAddress.task, 'claude', 'worker:same', 'worker', 'same-assignment', attempt],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    return { attempt, done: new Promise(resolve => child.once('close', code => resolve(code))) };
  });
  try {
    await waitFor(() => attempts.every(a => fs.existsSync(path.join(sameAddress.dir, `worker-same-${a.attempt}.ready`))));
    fs.writeFileSync(path.join(sameAddress.dir, 'go'), 'go');
    await waitFor(() => attempts.every(a => fs.existsSync(path.join(sameAddress.dir, `worker-same-${a.attempt}.result`))));
    const results = attempts.map(a => JSON.parse(fs.readFileSync(path.join(sameAddress.dir, `worker-same-${a.attempt}.result`))));
    check('concurrent fresh plans at one address publish one assignment and launch one session',
      results.filter(r => r.launched).length === 1 && results.some(r => !r.launched
        && /changed while its lift was planned|unresolved launch reservation/.test(r.error)), JSON.stringify(results));
  } finally { fs.writeFileSync(path.join(sameAddress.dir, 'release'), 'release'); }
  check('same-address synthetic launchers exit normally', (await Promise.all(attempts.map(a => a.done))).every(code => code === 0));

  const crash = fixture();
  const killed = spawn(process.execPath, [childFile, crash.dir, crash.home, crash.task, 'codex', 'teamlead:crash', 'teamlead', 'kill-before-link'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let crashOutput = '';
  killed.stdout.on('data', c => { crashOutput += c; }); killed.stderr.on('data', c => { crashOutput += c; });
  const killedOutcome = new Promise(resolve => killed.once('close', (code, signal) => resolve({ code, signal })));
  await waitFor(() => fs.existsSync(path.join(crash.dir, 'teamlead-crash.ready')));
  fs.writeFileSync(path.join(crash.dir, 'go'), 'go');
  const ended = await killedOutcome;
  const interrupted = liveReservations(crash.home, crash.task)[0];
  check('hard kill before child linking retains the registered seat and actual launcher identity',
    ended.signal === 'SIGKILL' && ended.code === null && interrupted.owner.pid === killed.pid
      && interrupted.phase === 'registered' && interrupted.nativeId === 'teamlead-crash'
      && !store.participantOf(store.readTask(crash.home, crash.task), 'teamlead:crash'), crashOutput);
  check('retry after hard kill reclaims only the verified dead launcher and dead native fixture',
    !!reserve(crash, 'teamlead:crash').token);

  for (const harness of ['codex', 'cursor', 'opencode']) {
  const unstarted = fixture(harness);
  const beforeStart = spawn(process.execPath, [childFile, unstarted.dir, unstarted.home, unstarted.task, harness, 'worker:crash', 'worker', 'kill-before-start'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  beforeStart.stdout.resume(); beforeStart.stderr.resume();
  const beforeStartOutcome = new Promise(resolve => beforeStart.once('close', (code, signal) => resolve({ code, signal })));
  await waitFor(() => fs.existsSync(path.join(unstarted.dir, 'worker-crash.ready')));
  fs.writeFileSync(path.join(unstarted.dir, 'go'), 'go');
  const unstartedEnd = await beforeStartOutcome;
  check(`${harness} hard kill before native creation leaves a reserved seat and owned startup record`,
    unstartedEnd.signal === 'SIGKILL' && liveReservations(unstarted.home, unstarted.task)[0].phase === 'reserved');
  check(`${harness} owner recovery retires a proven unstarted record and permits safe retry`,
    await recoverLiveSeat(unstarted.host, unstarted.home, unstarted.task, 'worker:crash', unstarted.env)
      && !!reserve(unstarted, 'worker:crash').token);
  }
  for (const patch of [{ launchId: 'replacement' }, { holderPid: process.pid }, { nativeCreationPending: { endpoint: 'synthetic' } }]) {
    const f = fixture(); reserve(f); editSeat(f, { owner: deadIdentity, launchId: 'synthetic-launch' });
    const registry = createHarnessRegistry({ harness: 'codex' });
    const record = { ref: 'worker-first', launchId: 'synthetic-launch', launcherPid: deadIdentity.pid,
      launcherProcess: deadIdentity,
      home: f.home, task: f.task, address: 'worker:first', threadId: null, holderPid: null, appPid: null, state: 'starting', ...patch };
    registry.writeSession(record, f.env);
    const file = registry.sessionFile(record.ref, f.env), before = fs.readFileSync(file, 'utf8');
    const stop = REGISTRY.drivers.codex.stop;
    REGISTRY.drivers.codex.stop = async () => ({ ok: false, stopped: false });
    let error = '';
    try { await recoverLiveSeat(f.host, f.home, f.task, 'worker:first', f.env); } catch (e) { error = e.message; }
    finally { REGISTRY.drivers.codex.stop = stop; }
    check(`prestart recovery retains contradictory native evidence ${Object.keys(patch)[0]}`,
      !!error && fs.readFileSync(file, 'utf8') === before && liveReservations(f.home, f.task).length === 1);
  }

  for (const data of ['{', '{}']) {
    const f = fixture(); reserve(f); editSeat(f, { owner: deadIdentity });
    const registry = createHarnessRegistry({ harness: 'codex' });
    registry.writeSession({ ref: 'worker-first' }, f.env);
    fs.writeFileSync(registry.sessionFile('worker-first', f.env), data);
    check(`incomplete Codex registry ${data} retains a dead-launcher reservation`, !!caught(() => reserve(f)));
  }
  for (const scope of ['directory', 'record']) {
    const f = fixture(); reserve(f); editSeat(f, { owner: deadIdentity });
    const registry = createHarnessRegistry({ harness: 'codex' });
    registry.writeSession({ ref: 'worker-first', state: 'dead', threadId: 'synthetic-thread' }, f.env);
    const target = scope === 'directory' ? registry.sessionsDir(f.env) : registry.sessionFile('worker-first', f.env);
    const key = scope === 'directory' ? 'readdirSync' : 'readFileSync', original = fs[key];
    try {
      fs[key] = (file, ...args) => {
        if (String(file) === target) throw Object.assign(new Error('synthetic unreadable observation'), { code: 'EACCES' });
        return original(file, ...args);
      };
      syncBuiltinESMExports();
      check(`unreadable Codex ${scope} cannot reclaim a dead-launcher reservation`, !!caught(() => reserve(f)));
    } finally { fs[key] = original; syncBuiltinESMExports(); }
  }
  const malformedOther = fixture(); reserve(malformedOther); editSeat(malformedOther, { owner: deadIdentity });
  createHarnessRegistry({ harness: 'codex' }).writeSession({ ref: 'unrelated', holderPid: 'malformed' }, malformedOther.env);
  check('malformed liveness in another Codex record makes the reservation observation incomplete',
    !!caught(() => reserve(malformedOther)));
  const linked = fixture(); reserve(linked);
  editSeat(linked, { owner: deadIdentity, phase: 'registered', nativeId: 'synthetic-thread' });
  check('verified native death after registration reclaims a seat before child-link intent', !!reserve(linked).token);
  for (const complete of [true, false]) {
    const f = fixture(); reserve(f);
    editSeat(f, { owner: deadIdentity, phase: 'launching', launchId: 'owned-launch' });
    createHarnessRegistry({ harness: 'codex' }).writeSession({ ref: 'worker-first', launchId: 'owned-launch',
      state: 'starting', threadId: null, holderPid: deadIdentity.pid, appPid: complete ? killed.pid : null }, f.env);
    const result = caught(() => reserve(f));
    check(complete ? 'known dead holder and app process recover an interrupted unbound Codex launch'
      : 'unknown app process retains an interrupted unbound Codex launch', complete ? result === '' : result !== '');
  }
  const delayed = fixture('claude');
  let view = { state: 'gone', id: null };
  REGISTRY.drivers.claude.inspect = () => view;
  reserve(delayed); editSeat(delayed, { owner: deadIdentity, phase: 'launching' });
  check('dead Claude launcher with registration still absent cannot release its seat', !!caught(() => reserve(delayed, 'reviewer:next')));
  view = { state: 'alive', id: 'late-session' };
  check('delayed Claude registration after launcher death cannot admit an extra lift', !!caught(() => reserve(delayed, 'teamlead:next')));
  const stop = REGISTRY.drivers.claude.stop;
  REGISTRY.drivers.claude.stop = async () => { view = { state: 'gone', id: null }; return { ok: true, stopped: true }; };
  try {
    let finishStop;
    REGISTRY.drivers.claude.stop = async () => {
      await new Promise(resolve => { finishStop = resolve; });
      view = { state: 'gone', id: null }; return { ok: true, stopped: true };
    };
    const recovering = recoverLiveSeat(delayed.host, delayed.home, delayed.task, 'worker:first', delayed.env);
    check('concurrent admission retains the seat while owner recovery awaits native Stop',
      !!caught(() => reserve(delayed, 'reviewer:during-stop')));
    finishStop();
    check('owner recovery stops a delayed session before releasing the reservation',
      await recovering && liveReservations(delayed.home, delayed.task).length === 0);
  } finally { REGISTRY.drivers.claude.stop = stop; }

  for (const stopped of [false, true]) {
    const f = fixture('opencode');
    const plan = { argv: [], files: [], mcpConfig: null, settings: null };
    const driver = { id: 'opencode', spawn: async plan => {
      plan.liveSeat.starting();
      if (stopped) plan.liveSeat.stopped();
      throw new Error('synthetic failed lift');
    } };
    try { await reservedSpawn(driver, plan, { host: f.host, home: f.home, task: f.task,
      address: 'worker:first', ref: 'worker-first', role: 'worker', env: f.env, cwd: f.dir,
      tool: { ok: true, bin: 'synthetic' }, persist: () => {} }); } catch {}
    check(stopped ? 'confirmed failed OpenCode cleanup frees the seat for safe retry'
      : 'live but unbound launch failure retains its seat',
    liveReservations(f.home, f.task).length === (stopped ? 0 : 1));
    if (!stopped) check('unbound native failure prevents another launch at the cap',
      caught(() => reserve(f, 'reviewer:next')).includes('caps.liveParticipants.opencode=1'));
  }
} finally {
  for (const [h, inspect] of Object.entries(originalInspect)) REGISTRY.drivers[h].inspect = inspect;
  fs.rmSync(root, { recursive: true, force: true });
}

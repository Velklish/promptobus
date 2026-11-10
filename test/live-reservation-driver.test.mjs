import './home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { createRegistry } from '../dist/driver.js';
import { createStandaloneHost } from '../dist/host-index.js';
import * as store from '../lib/store.js';
import { createHarnessRegistry } from '../lib/harness-registry.js';
import { REGISTRY } from '../lib/drivers.js';
import { sessionKey } from '../lib/codex-session.js';
import { liveReservations, reservationFile, reserveLiveSeat, observeLiveRef, recoverLiveSeat } from '../lib/live-reservation.js';

const root = fs.mkdtempSync(path.join(tmpdir(), 'promptobus-driver-reservation-'));
const driver = REGISTRY.drivers.codex, registry = createHarnessRegistry({ harness: 'codex' });
const deadOwner = JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e',
  `import {processIdentity} from ${JSON.stringify(new URL('../lib/service-state.js', import.meta.url).href)}; console.log(JSON.stringify(processIdentity(process.pid)))`],
{ encoding: 'utf8' }).stdout);
let serial = 0;
function fixture() {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  const host = createStandaloneHost({ cwd: dir }), home = host.promptobusHome(), task = 'synthetic-t20261110-000000';
  store.createTask(home, { id: task, title: 'Synthetic driver reservation', owner: 'synthetic-owner' });
  const env = { PROMPTOBUS_CODEX_HOME: path.join(dir, 'codex') };
  const request = { ref: 'worker-first', registryHome: env.PROMPTOBUS_CODEX_HOME, home, task,
    address: 'worker:first', launchId: 'synthetic-launch', owner: deadOwner };
  reserveLiveSeat(host, home, task, request.address, 'codex', request.ref, env, null, { launchId: request.launchId });
  store.writeJsonAtomic(reservationFile(home, task), liveReservations(home, task).map(s => ({ ...s, owner: deadOwner })));
  const record = { ref: request.ref, home, task, address: request.address, launchId: request.launchId,
    launcherPid: deadOwner.pid, launcherProcess: deadOwner, threadId: null, holderPid: null, appPid: null, state: 'starting' };
  registry.writeSession(record, env);
  const file = registry.sessionFile(request.ref, env);
  return { host, home, task, env, request, record, file };
}
async function recovery(f) {
  try { await recoverLiveSeat(f.host, f.home, f.task, f.request.address, f.env); return ''; }
  catch (e) { return e.message; }
}
try {
  const typed = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    '--ignoreConfig', '--noEmit', '--skipLibCheck', '--module', 'nodenext', '--target', 'es2023', '--types', 'node', '--strict',
    fileURLToPath(new URL('./fixtures/live-reservation-driver.ts', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
  check('public structural reservation types accept legacy drivers and reject private or incomplete requests',
    typed.status === 0, `${typed.stdout}${typed.stderr}`);
  const legacy = { ...driver, reservationState: undefined, retireUnstarted: undefined,
    inspect: () => ({ state: 'unknown', busy: false, stall: null, id: null }) };
  delete legacy.reservationState; delete legacy.retireUnstarted;
  check('old custom driver without either reservation hook remains a valid registry member',
    createRegistry({ drivers: { codex: legacy } }).drivers.codex === legacy);
  REGISTRY.drivers.codex = legacy;
  const old = fixture();
  check('old custom driver with unknown inspection retains its reserved seat',
    observeLiveRef('codex', old.request.ref, old.env).state === 'unknown');
  const oldBefore = fs.readFileSync(old.file, 'utf8');
  registry.writeSession({ ...old.record, launcherProcess: null }, old.env);
  check('old custom driver fallback retains an unstarted record without process-birth proof',
    !!await recovery(old) && fs.existsSync(old.file) && liveReservations(old.home, old.task).length === 1);
  fs.writeFileSync(old.file, oldBefore);
  REGISTRY.drivers.codex = { ...legacy, inspect: () => ({ state: 'gone', busy: false, stall: null, id: null }) };
  check('old custom driver fallback retires only its verified unstarted generation',
    await recovery(old) === '' && !fs.existsSync(old.file) && liveReservations(old.home, old.task).length === 0);
  REGISTRY.drivers.codex = driver;

  for (const [label, hook] of [['unknown', () => 'unknown'], ['throws', () => { throw new Error('synthetic observer'); }],
    ['invalid result', () => 'gone'], ['invalid method', false]]) {
    const f = fixture(); REGISTRY.drivers.codex = { ...driver, reservationState: hook };
    check(`reservation observer ${label} retains capacity`,
      observeLiveRef('codex', f.request.ref, f.env).state === 'unknown'
        && (() => { try { reserveLiveSeat(f.host, f.home, f.task, f.request.address, 'codex', f.request.ref, f.env); return false; } catch { return true; } })());
  }
  for (const [label, hook] of [['false', () => false], ['throws', () => { throw new Error('synthetic retire'); }],
    ['invalid result', () => 'true'], ['invalid method', false]]) {
    const f = fixture(); let stopCalls = 0;
    REGISTRY.drivers.codex = { ...driver, retireUnstarted: hook, stop: () => { stopCalls++; return { ok: true, stopped: true }; } };
    const before = fs.readFileSync(f.file, 'utf8');
    check(`unstarted retirement ${label} retains seat and record without Stop`,
      !!await recovery(f) && fs.readFileSync(f.file, 'utf8') === before
        && liveReservations(f.home, f.task).length === 1 && stopCalls === 0);
  }
  REGISTRY.drivers.codex = driver;
  for (const phase of ['launching', 'registered']) {
    const f = fixture(); let stopCalls = 0;
    store.writeJsonAtomic(reservationFile(f.home, f.task), liveReservations(f.home, f.task).map(s => ({ ...s, phase })));
    registry.writeSession({ ...f.record, launchId: 'replacement', holderPid: process.pid }, f.env);
    REGISTRY.drivers.codex = { ...driver, stop: () => { stopCalls++; return { ok: true, stopped: true }; } };
    check(`${phase} owner recovery never stops a replacement native generation`,
      !!await recovery(f) && stopCalls === 0 && fs.existsSync(f.file) && liveReservations(f.home, f.task).length === 1);
  }
  REGISTRY.drivers.codex = driver;
  for (const [label, patch] of [['home', { home: path.join(root, 'other') }], ['task', { task: 'foreign-task' }],
    ['address', { address: 'worker:other' }], ['ref', { ref: 'other' }], ['generation', { launchId: 'replacement' }],
    ['birth', { owner: { ...deadOwner, birth: 'unknown-birth' } }], ['live owner', { owner: { pid: process.pid, birth: deadOwner.birth } }]]) {
    const f = fixture(), before = fs.readFileSync(f.file, 'utf8');
    check(`Codex retirement rejects mismatched ${label} proof`, driver.retireUnstarted({ ...f.request, ...patch }) === false
      && fs.readFileSync(f.file, 'utf8') === before && liveReservations(f.home, f.task).length === 1);
  }
  for (const [label, patch] of [['native id', { threadId: 'native' }], ['holder pid', { holderPid: process.pid }],
    ['native creation', { nativeCreationPending: { endpoint: 'synthetic' } }], ['missing birth', { launcherProcess: null }]]) {
    const f = fixture(); registry.writeSession({ ...f.record, ...patch }, f.env);
    const before = fs.readFileSync(f.file, 'utf8');
    check(`Codex retirement retains current ${label} evidence`, driver.retireUnstarted(f.request) === false
      && fs.readFileSync(f.file, 'utf8') === before);
  }
  for (const [label, content] of [['malformed', '{'], ['live', JSON.stringify({ pid: process.pid })],
    ['unknown pid', JSON.stringify({ pid: 'unknown' })]]) {
    const f = fixture(), lock = path.join(registry.sessionsDir(f.env), sessionKey(f.request.ref) + '.lock');
    fs.writeFileSync(lock, content);
    check(`Codex ${label} holder lock prevents retirement`, driver.retireUnstarted(f.request) === false && fs.existsSync(f.file));
  }
  const changed = fixture(), read = fs.readFileSync;
  let reads = 0;
  try {
    fs.readFileSync = (file, ...args) => {
      if (String(file) === changed.file && ++reads === 2)
        fs.writeFileSync(file, JSON.stringify({ ...changed.record, launchId: 'replacement' }));
      return read(file, ...args);
    };
    syncBuiltinESMExports();
    check('Codex retirement rechecks current truth after the captured registry observation',
      driver.retireUnstarted(changed.request) === false && JSON.parse(read(changed.file, 'utf8')).launchId === 'replacement');
  } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
  const denied = fixture(), kill = process.kill;
  registry.writeSession({ ...denied.record, holderPid: 2147483646 }, denied.env);
  try {
    process.kill = (pid, signal) => {
      if (pid === 2147483646 && signal === 0) throw Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' });
      return kill(pid, signal);
    };
    check('EPERM native-process observation retains capacity and prevents retirement',
      driver.reservationState(denied.request) === 'alive' && driver.retireUnstarted(denied.request) === false);
  } finally { process.kill = kill; }
  const positive = fixture();
  check('verified Codex unstarted retirement removes the exact current owned record',
    driver.retireUnstarted(positive.request) === true && !fs.existsSync(positive.file));
} finally { REGISTRY.drivers.codex = driver; fs.rmSync(root, { recursive: true, force: true }); }

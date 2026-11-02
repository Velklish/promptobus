import { check } from './check.mjs';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { createRootAdmission } from '../lib/root-admission.js';
import { observeRootProcess } from '../lib/root-process.js';
import { requireCurrentNativeBinding } from '../lib/native-admission.js';
import { privateDirectory, processStateAsync, readPrivate, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-bb-successor-'));
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-bb-next-'));
writeHostConfig(root, { tools: [] });
const binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const host = createStandaloneHost({ cwd: root, binPath, version }), env = { ...process.env, PROMPTOBUS_SERVICE_HOME: base };
const paths = servicePaths(host, env), admission = createRootAdmission(host, { env });
const child = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
const closed = new Promise(resolve => child.once('close', resolve));
let occupantChild = null, occupantClosed = null;
const originalSpawn = childProcess.spawn, originalRead = fsPromises.readFile, originalKill = process.kill;
const priorBirth = birth => {
  if (birth.startsWith('v2:linux:')) return birth.replace(/:(\d+)$/, (_, ticks) => `:${BigInt(ticks) > 0n ? BigInt(ticks) - 1n : 1n}`);
  const date = new Date(`${birth.slice('v2:darwin:utc-c:'.length)} GMT`); date.setUTCSeconds(date.getUTCSeconds() - 1);
  const [weekday, , month, year, time] = date.toUTCString().split(' ');
  return `v2:darwin:utc-c:${weekday.slice(0, -1)} ${month} ${date.getUTCDate()} ${time} ${year}`;
};
const refused = async action => { try { await action(); return false; } catch { return true; } };
try {
  await new Promise(resolve => child.once('message', resolve));
  const oldProcess = await observeRootProcess(child.pid);
  if (!oldProcess) throw new Error('Owned BB predecessor fixture has no captured birth');
  await admission.approveProfile({ id: 'bb-native', nativeStore: root });
  const generation = { nativeThreadId: randomUUID(), appServer: oldProcess, nonce: randomUUID() };
  const lookup = async () => ({ complete: true, eligibility: 'eligible', bbThreadId: 'thr_owner' });
  let callbacks = 0;
  const realize = generation => admission.realizeRoot({ profileId: 'bb-native', nativeStore: root, generation }, lookup, async () => { callbacks += 1; });
  check('a complete BB correspondence alone cannot prove fresh native creation', await refused(() => realize(generation)) && callbacks === 0);
  // Seed a known new-version binding to exercise successor policy, not native genesis.
  writePrivate(path.join(paths.directory, 'native-admission.json'), { schemaVersion: 2, root: paths.root, home: paths.home, bindings: [{
    harness: 'codex', nativeStore: root, nativeId: generation.nativeThreadId, source: 'bb', runtime: runtimeIdentity(host),
    ownerKey: 'thr_owner', process: generation.appServer, nonce: generation.nonce, profile: 'bb-native',
  }] });
  await realize(generation);
  const successor = { ...generation, appServer: requireProcess(), nonce: randomUUID() };
  check('a fresh complete BB lookup cannot replace a still-live prior app-server', await refused(() => realize(successor)) && callbacks === 1);
  child.kill('SIGTERM'); await closed;
  const receiptDirectory = path.join(paths.requests, `root-${generation.nonce}`, randomUUID()); privateDirectory(receiptDirectory);
  const receiptFile = path.join(receiptDirectory, `${'a'.repeat(64)}.json`);
  writePrivate(receiptFile, { digest: 'owned-fixture', state: 'started', readOnly: false });
  check('unknown predecessor mutation blocks BB generation succession after physical exit', await refused(() => realize(successor)));
  writePrivate(receiptFile, { digest: 'owned-fixture', state: 'completed', readOnly: false, response: { ownedFixture: true } });
  const contenders = [successor, { ...successor, nonce: randomUUID() }];
  const outcomes = await Promise.all(contenders.map(async candidate => ({ candidate, refused: await refused(() => realize(candidate)) })));
  check('only one exact BB successor wins the existing owner transaction', outcomes.filter(result => !result.refused).length === 1
    && outcomes.filter(result => result.refused).length === 1 && callbacks === 2);
  const winner = outcomes.find(result => !result.refused).candidate;
  await realize(winner);
  check('the exact new BB generation repeats without creating another successor', readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.length === 1 && callbacks === 3);
  check('a delayed predecessor callback cannot become live after succession', await refused(() => realize(generation)) && callbacks === 3);
  const otherOwner = async () => ({ complete: true, eligibility: 'eligible', bbThreadId: 'thr_foreign' });
  check('a successor cannot change the canonical BB owner', await refused(() => admission.realizeRoot({ profileId: 'bb-native', nativeStore: root,
    generation: { ...winner, nonce: randomUUID() } }, otherOwner, async () => {})));
  occupantChild = spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ready = new Promise(resolve => occupantChild.once('message', resolve)); occupantClosed = new Promise(resolve => occupantChild.once('close', resolve));
  await ready;
  const occupant = await observeRootProcess(occupantChild.pid);
  if (!occupant) throw new Error('Owned BB replacement occupant has no observable birth');
  const stateFile = path.join(paths.directory, 'root-admission', 'state.json'), ledgerFile = path.join(paths.directory, 'native-admission.json');
  const signals = [];
  process.kill = function(pid, signal) {
    if (pid === occupant.pid) { signals.push(signal); if (signal !== 0) throw new Error('BB admission must not signal the replacement occupant'); }
    return originalKill.call(this, pid, signal);
  };
  for (const historyOnly of [false, true]) for (const proof of ['alive', 'unknown', 'incomparable', 'ended']) {
    const previous = { nativeThreadId: randomUUID(), nonce: randomUUID(), appServer: { pid: occupant.pid,
      birth: proof === 'alive' ? occupant.birth : proof === 'incomparable' ? 'unscoped legacy birth' : priorBirth(occupant.birth) } };
    const stored = readPrivate(stateFile); stored.roots.push({ profileId: 'bb-native', bbThreadId: 'thr_owner', generation: previous }); writePrivate(stateFile, stored);
    const oldBinding = { harness: 'codex', nativeStore: root, nativeId: previous.nativeThreadId, source: 'bb', runtime: runtimeIdentity(host),
      ownerKey: 'thr_owner', nonce: previous.nonce, process: previous.appServer, profile: 'bb-native' };
    if (!historyOnly) { const ledger = readPrivate(ledgerFile); ledger.bindings.push(oldBinding); writePrivate(ledgerFile, ledger); }
    if (proof === 'unknown') {
      childProcess.spawn = function(file, args, ...rest) {
        if (file === '/bin/ps' && JSON.stringify(args) === JSON.stringify(['-p', String(occupant.pid), '-o', 'stat=', '-o', 'lstart='])) return originalSpawn.call(this, '/usr/bin/false', [], ...rest);
        return originalSpawn.call(this, file, args, ...rest);
      };
      fsPromises.readFile = async function(file, ...rest) {
        if (file === `/proc/${occupant.pid}/stat`) throw Object.assign(new Error('Owned observation unavailable'), { code: 'EACCES' });
        return originalRead.call(this, file, ...rest);
      };
      syncBuiltinESMExports();
    }
    const successor = { ...previous, appServer: requireProcess(), nonce: randomUUID() }; signals.length = 0;
    const beforeCallbacks = callbacks, beforeLedger = readFileSync(ledgerFile, 'utf8');
    const denied = await refused(() => realize(successor));
    check(`BB ${historyOnly ? 'unknown-history refusal' : 'ledger-successor'} guard follows ${proof} lifetime proof`,
      proof === 'ended' && !historyOnly ? !denied : denied
        && (!historyOnly || (callbacks === beforeCallbacks && readFileSync(ledgerFile, 'utf8') === beforeLedger)));
    childProcess.spawn = originalSpawn; fsPromises.readFile = originalRead; syncBuiltinESMExports();
    if (proof === 'ended') {
      check('BB delayed old generation stays excluded while reused occupant remains alive and untouched', await refused(() => requireCurrentNativeBinding(paths, oldBinding))
        && await processStateAsync(occupant) === 'alive' && signals.length === 0);
      check(historyOnly ? 'BB unknown historical ID cannot acquire first binding after a proved old lifetime ends'
        : 'BB old callback cannot revive the former lifetime after the successor', await refused(() => realize(previous)));
    }
  }
} finally {
  childProcess.spawn = originalSpawn; fsPromises.readFile = originalRead; process.kill = originalKill; syncBuiltinESMExports();
  if (occupantChild) { occupantChild.kill('SIGTERM'); await occupantClosed; }
  child.kill('SIGTERM'); await closed;
  rmSync(base, { recursive: true, force: true });
}

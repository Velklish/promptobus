import { check } from './check.mjs';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { recordNativeBinding, requireCurrentNativeBinding, reserveExplicitStandaloneResume } from '../lib/native-admission.js';
import { createRootAdmission } from '../lib/root-admission.js';
import { observeRootProcess } from '../lib/root-process.js';
import { acquireServiceLock, prepareServicePaths, privateDirectory, processStateAsync, readPrivate, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-native-resume-'));
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-resume-'));
writeHostConfig(root, { tools: [] });
const binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const host = createStandaloneHost({ cwd: root, binPath, version }), env = { ...process.env, PROMPTOBUS_SERVICE_HOME: base };
const paths = servicePaths(host, env), runtime = runtimeIdentity(host), context = { host, env };
prepareServicePaths(paths);
await createRootAdmission(host, { env }).approveProfile({ id: 'fixture-registry-initialization', nativeStore: root });
writePrivate(path.join(paths.directory, 'root-profile-ordinary.json'), { mode: 'standalone', root: paths.root, home: paths.home,
  harness: 'claude', nativeStore: root });
const child = childProcess.spawn(process.execPath, ['-e', 'process.send("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
const closed = new Promise(resolve => child.once('close', resolve));
const originalSpawn = childProcess.spawn, originalRead = fsPromises.readFile;
const originalKill = process.kill;
const priorBirth = birth => {
  if (birth.startsWith('v2:linux:')) return birth.replace(/:(\d+)$/, (_, ticks) => `:${BigInt(ticks) > 0n ? BigInt(ticks) - 1n : 1n}`);
  const date = new Date(`${birth.slice('v2:darwin:utc-c:'.length)} GMT`); date.setUTCSeconds(date.getUTCSeconds() - 1);
  const [weekday, , month, year, time] = date.toUTCString().split(' ');
  return `v2:darwin:utc-c:${weekday.slice(0, -1)} ${month} ${date.getUTCDate()} ${time} ${year}`;
};
try {
await new Promise(resolve => child.once('message', resolve));
const processIdentity = await observeRootProcess(child.pid);
if (!processIdentity) throw new Error('Owned resume fixture child has no observable process identity');
const old = { harness: 'claude', nativeStore: root, nativeId: randomUUID(), source: 'standalone', runtime,
  ownerKey: randomUUID(), process: processIdentity, nonce: randomUUID(), profile: 'ordinary', phase: 'bound' };
old.ownerKey = old.nonce;
const clients = new Map();
const stage = binding => {
  const clientId = clients.get(binding.nonce) ?? randomUUID(); clients.set(binding.nonce, clientId);
  const file = path.join(paths.directory, `standalone-launch-${binding.nonce}.json`);
  writePrivate(file, { schemaVersion: 1, profile: binding.profile, root: paths.root, home: paths.home, runtime,
    process: binding.process, cwd: root, nonce: binding.nonce, expiresAt: Date.now() + 120000, clientId,
    nativeId: binding.phase === 'bound' ? binding.nativeId : null, phase: binding.phase, revoked: false, plan: null, resumeNativeId: binding.nativeId });
  return file;
};
const oldFile = stage(old);
writePrivate(path.join(paths.clients, `${clients.get(old.nonce)}.json`), { id: clients.get(old.nonce), runtime, rootLaunch: { file: oldFile, nonce: old.nonce } });
let release = await acquireServiceLock(path.join(paths.directory, 'root-admission.lock'));
if (!release) throw new Error('Owned resume fixture lock is occupied');
await recordNativeBinding(paths, old, context); release();
const candidate = { ...old, ownerKey: randomUUID(), process: requireProcess(), nonce: randomUUID(), phase: 'pending' };
candidate.ownerKey = candidate.nonce;
stage(candidate);
const attempt = async binding => {
  try { return { value: await reserveExplicitStandaloneResume(paths, binding, context) }; }
  catch (error) { return { error: error.message }; }
};
  const beforeUnknown = readFileSync(path.join(paths.directory, 'native-admission.json'), 'utf8');
  check('an explicit resume selector cannot adopt an unknown native ID into the new ledger',
    /known current-version/.test((await attempt({ ...candidate, nativeId: randomUUID() })).error ?? '')
    && readFileSync(path.join(paths.directory, 'native-admission.json'), 'utf8') === beforeUnknown);
  check('resume refuses a known live old native process', /positive death/.test((await attempt(candidate)).error ?? ''));
  writePrivate(oldFile, { ...readPrivate(oldFile), revoked: true, expiresAt: 0 });
  check('revoke and deadline expiry do not authorize takeover while the old process lives', /positive death/.test((await attempt(candidate)).error ?? ''));
  childProcess.spawn = function(file, args, ...rest) {
    if (file === '/bin/ps' && JSON.stringify(args) === JSON.stringify(['-p', String(child.pid), '-o', 'stat=', '-o', 'lstart='])) return originalSpawn.call(this, '/usr/bin/false', [], ...rest);
    return originalSpawn.call(this, file, args, ...rest);
  };
  fsPromises.readFile = async function(file, ...rest) {
    if (file === `/proc/${child.pid}/stat`) { const error = new Error('Unavailable owned process observation'); error.code = 'EACCES'; throw error; }
    return originalRead.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  check('unavailable birth observation does not become positive death', /positive death/.test((await attempt(candidate)).error ?? ''));
  childProcess.spawn = originalSpawn; fsPromises.readFile = originalRead; syncBuiltinESMExports();
  child.kill('SIGTERM'); await closed;
  const receipts = path.join(paths.requests, `root-${old.nonce}`, randomUUID()); privateDirectory(receipts);
  const receipt = path.join(receipts, `${'a'.repeat(64)}.json`);
  writePrivate(receipt, { digest: 'owned-fixture', state: 'started', readOnly: false });
  check('explicit native resume cannot reset an unknown earlier mutation through a new process', /uncertain/.test((await attempt(candidate)).error ?? ''));
  for (const state of [['started'], ['completed'], { value: 'started' }, null]) {
    writePrivate(receipt, { digest: 'owned-fixture', state, readOnly: false });
    const bytes = readFileSync(receipt, 'utf8');
    check('nonprimitive mutation receipt state cannot release the old generation to a successor', /uncertain/.test((await attempt(candidate)).error ?? '')
      && readPrivate(path.join(paths.directory, 'native-admission.json')).bindings[0].nonce === old.nonce
      && readFileSync(receipt, 'utf8') === bytes);
  }
  writePrivate(receipt, { digest: 'owned-fixture', state: 'completed', readOnly: false, response: { ownedFixture: true } });
  const conflict = { ...candidate, nonce: randomUUID(), ownerKey: randomUUID(), phase: 'bound' }; conflict.ownerKey = conflict.nonce;
  const conflictFile = stage(conflict);
  check('a second observed live native generation without a ledger reservation is not ignored', /another live/.test((await attempt(candidate)).error ?? ''));
  rmSync(conflictFile);
  const other = { ...candidate, ownerKey: randomUUID(), nonce: randomUUID() }; other.ownerKey = other.nonce; stage(other);
  const attempts = await Promise.all([attempt(candidate), attempt(other)]);
  check('one owner-locked resume transition wins after observed old process death', attempts.filter(result => result.value).length === 1
    && attempts.filter(result => result.error).length === 1);
  const next = readPrivate(path.join(paths.directory, 'native-admission.json')).bindings[0];
  check('the new pending generation durably retains its prior nonce and cannot authorize tools as bound', next.phase === 'pending'
    && next.previousNonce === old.nonce && next.nonce !== old.nonce && next.nativeId === old.nativeId);
  const winner = next.nonce === candidate.nonce ? candidate : other;
  check('replaying consumed preflight generation cannot create another transition', Boolean((await attempt(winner)).error));
  check('changing profile cannot borrow the prior identity', Boolean((await attempt({ ...winner, profile: 'foreign' })).error));
  const occupant = requireProcess(), signals = [];
  process.kill = function(pid, signal) {
    if (pid === occupant.pid) { signals.push(signal); if (signal !== 0) throw new Error('The replacement occupant must never be signalled'); }
    return originalKill.call(this, pid, signal);
  };
  for (const phase of ['bound', 'pending']) for (const proof of ['alive', 'unknown', 'incomparable', 'ended']) {
    const nonce = randomUUID(), previous = { ...old, nativeId: randomUUID(), ownerKey: nonce, nonce, phase,
      process: { pid: occupant.pid, birth: proof === 'alive' ? occupant.birth : proof === 'incomparable' ? 'legacy incomparable context' : priorBirth(occupant.birth) } };
    stage(previous);
    release = await acquireServiceLock(path.join(paths.directory, 'root-admission.lock'));
    if (!release) throw new Error('Owned lifetime fixture lock unavailable');
    try { await recordNativeBinding(paths, previous, context); } finally { release(); }
    const nextNonce = randomUUID(), successor = { ...previous, ownerKey: nextNonce, nonce: nextNonce, phase: 'pending', process: occupant };
    stage(successor); signals.length = 0;
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
    const result = await attempt(successor);
    check(`${phase} predecessor with ${proof} birth follows exact-lifetime policy`, proof === 'ended' ? !result.error : /positive death/.test(result.error ?? ''));
    childProcess.spawn = originalSpawn; fsPromises.readFile = originalRead; syncBuiltinESMExports();
    if (proof === 'ended') {
      let oldRefused = false; try { requireCurrentNativeBinding(paths, previous); } catch { oldRefused = true; }
      check(`${phase} successor keeps tools pending and excludes delayed old binding without touching reused occupant`, oldRefused
        && await processStateAsync(occupant) === 'alive' && signals.length === 0
        && readPrivate(path.join(paths.directory, 'native-admission.json')).bindings.some(value => value.nonce === successor.nonce && value.phase === 'pending'));
    }
  }
} finally {
  process.kill = originalKill;
  childProcess.spawn = originalSpawn; fsPromises.readFile = originalRead; syncBuiltinESMExports();
  child.kill('SIGTERM'); await closed;
  rmSync(base, { recursive: true, force: true });
}

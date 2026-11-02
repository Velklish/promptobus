import { check } from './check.mjs';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { managedCodexResumeDeath, publishCodexNativeAdmission, readSession, retireCodexResumeHolderLock, sessionFile, withSessionLaunch, writeSession } from '../lib/codex-session.js';
import { codexDriver, participantCodexHome } from '../lib/driver-codex.js';
import { recordVersion, requireProcess } from '../lib/service-state.js';
import { makeSandbox } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-native-provenance-'));
const env = { ...process.env, PROMPTOBUS_CODEX_HOME: path.join(root, 'package-registry') };
const ref = 'owned-native-api', nativeId = 'actual-native-thread';
const nativeStore = path.join(root, 'actual-private-codex-home'), authOwnerHome = path.join(root, 'account-credentials');
mkdirSync(nativeStore); mkdirSync(authOwnerHome);
const file = sessionFile(ref, env), processIdentity = requireProcess();
const record = { ref, home: path.join(root, '.promptobus'), task: 'native-proof-t20261101-000000', address: 'worker:own',
  launchId: 'owned-api-generation', threadId: nativeId, appPid: process.pid, codexHome: nativeStore, authOwnerHome, rolloutPath: null };
const input = () => ({ version: recordVersion(file), launchId: record.launchId, home: record.home, task: record.task,
  address: record.address, nativeStore, nativeId, process: processIdentity, method: 'thread/start' });
const refusesUnchanged = (call, before, pattern) => {
  let failure; try { call(); } catch (error) { failure = error; }
  return pattern.test(failure?.message ?? '') && readFileSync(file, 'utf8') === before;
};

writeSession(record, env);
publishCodexNativeAdmission(ref, input(), env);
const own = readSession(ref, env);
check('owned Codex API provenance uses actual private CODEX_HOME and app process before rollout exists',
  own.nativeAdmission.harness === 'codex' && own.nativeAdmission.nativeStore === nativeStore
    && own.nativeAdmission.nativeStore !== authOwnerHome && own.nativeAdmission.nativeId === nativeId
    && own.nativeAdmission.process.pid === process.pid && own.nativeAdmission.process.birth === processIdentity.birth
    && own.nativeAdmissionEvidence.kind === 'codex-thread-api' && own.nativeAdmissionEvidence.method === 'thread/start'
    && own.nativeAdmissionEvidence.nativeStore === own.nativeAdmission.nativeStore
    && own.rolloutPath === null);

for (const [field, value] of [['launchId', 'replacement-generation'], ['ref', 'replacement-ref'], ['home', `${record.home}-foreign`],
  ['task', 'foreign-t20261101-000000'], ['address', 'worker:foreign']]) {
  writeSession(record, env);
  const captured = input();
  writeFileSync(file, `${JSON.stringify({ ...record, [field]: value })}\n`, { mode: 0o600 });
  const before = readFileSync(file, 'utf8');
  check(`Codex provenance rejects late ${field} replacement without appending to its bytes`,
    refusesUnchanged(() => publishCodexNativeAdmission(ref, captured, env), before, /exact record/));
}

writeSession(record, env);
const stale = input();
writeSession({ ...record, lastEvent: 'legitimate-state-update' }, env);
check('Codex provenance requires the current recordVersion even when the native generation still matches',
  refusesUnchanged(() => publishCodexNativeAdmission(ref, stale, env), readFileSync(file, 'utf8'), /exact record/));

writeSession(record, env);
check('Codex provenance cannot substitute owner auth home for the actual native identity store',
  refusesUnchanged(() => publishCodexNativeAdmission(ref, { ...input(), nativeStore: authOwnerHome }, env), readFileSync(file, 'utf8'), /exact record/));
check('Codex provenance cannot adopt a reused native process PID with a different birth',
  refusesUnchanged(() => publishCodexNativeAdmission(ref, { ...input(), process: { ...processIdentity, birth: 'foreign-process-birth' } }, env),
    readFileSync(file, 'utf8'), /exact record/));

writeSession({ ...record, nativeAdmission: { harness: 'codex', nativeStore: authOwnerHome, nativeId, process: processIdentity } }, env);
check('confirmed Codex provenance cannot be replaced within the same immutable launch generation',
  refusesUnchanged(() => publishCodexNativeAdmission(ref, input(), env), readFileSync(file, 'utf8'), /immutable native generation/));

const nativePids = [], nativeProcesses = [];
for (let index = 0; index < 2; index += 1) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  nativePids.push(child.pid);
  nativeProcesses.push(requireProcess(child.pid));
  child.kill('SIGTERM');
  await once(child, 'exit');
}
const legacy = { ...record, holderPid: nativePids[0], appPid: nativePids[1] };
const refusedDeath = record => { try { managedCodexResumeDeath(ref, record, env); return false; } catch { return true; } };
check('birthless legacy resume refuses even when both native PIDs are positively absent', refusedDeath(legacy));
check('birthless legacy resume cannot acquire authority through a missing or reused native PID',
  refusedDeath({ ...legacy, holderPid: null }) && refusedDeath({ ...legacy, appPid: undefined })
    && refusedDeath({ ...legacy, holderPid: process.pid }));
check('damaged new native process evidence cannot be silently downgraded to legacy',
  refusedDeath({ ...legacy, nativeAdmissionSchema: 1 }) && refusedDeath({ ...legacy, appProcess: null })
    && refusedDeath({ ...legacy, nativeAdmissionUnknown: { nativeId } }));
const admission = { harness: 'codex', nativeStore, nativeId, process: nativeProcesses[1] };
const currentSchema = { ...legacy, nativeAdmissionSchema: 1, holderProcess: nativeProcesses[0], appProcess: nativeProcesses[1],
  nativeAdmission: admission, nativeAdmissionEvidence: { kind: 'codex-thread-api', method: 'thread/start',
    nativeStore, nativeId, process: admission.process } };
const confirmedDeath = managedCodexResumeDeath(ref, currentSchema, env);
check('new resume death uses previously captured process births without manufacturing a Stop receipt',
  confirmedDeath.kind === 'process-birth' && confirmedDeath.holder.birth === nativeProcesses[0].birth
    && confirmedDeath.process.birth === nativeProcesses[1].birth && !Object.hasOwn(confirmedDeath, 'stopConfirmed'));
check('new resume refuses missing birth, changed native identity and owner-auth-store substitution',
  refusedDeath({ ...currentSchema, appProcess: null })
    && refusedDeath({ ...currentSchema, nativeAdmission: { ...admission, nativeId: 'foreign-native' } })
    && refusedDeath({ ...currentSchema, nativeAdmission: { ...admission, nativeStore: authOwnerHome } }));
const lock = path.join(path.dirname(file), path.basename(file, '.json') + '.lock');
const currentHolder = { ...currentSchema, holderPid: process.pid, holderProcess: processIdentity };
check('current-version resume refuses the exact still-live captured holder lifetime', refusedDeath(currentHolder));
check('current-version resume refuses incomparable captured holder births even when the PID is live',
  refusedDeath({ ...currentHolder, holderProcess: { pid: process.pid, birth: 'incomparable-birth' } }));
const earlierBirth = process.platform === 'linux'
  ? processIdentity.birth.replace(/:(\d+)$/, (_, ticks) => `:${BigInt(ticks) + 1n}`)
  : processIdentity.birth.replace(/ (\d\d):(\d\d):(\d\d) /, (_, hour, minute, second) => ` ${hour}:${minute}:${second === '59' ? '58' : String(Number(second) + 1).padStart(2, '0')} `);
const reusedHolder = { ...currentHolder, holderProcess: { pid: process.pid, birth: earlierBirth } };
const kill0 = process.kill;
let occupantSignals = 0;
try {
  process.kill = (pid, signal) => {
    if (Math.abs(pid) === process.pid) { occupantSignals += 1; throw new Error('reused occupant must not be signalled, even for PID absence'); }
    return kill0(pid, signal);
  };
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  check('comparable different birth proves the old holder dead without requiring raw PID absence',
    managedCodexResumeDeath(ref, reusedHolder, env).holder.birth === earlierBirth && occupantSignals === 0);
  writeSession(reusedHolder, env);
  const retained = readFileSync(file, 'utf8');
  withSessionLaunch(ref, env, () => retireCodexResumeHolderLock(ref, readSession(ref, env), env));
  check('approved successor retires only the matched dead holder lock without touching the reused occupant or native record',
    !existsSync(lock) && readFileSync(file, 'utf8') === retained && occupantSignals === 0);
  writeFileSync(lock, JSON.stringify({ pid: nativePids[1] }), { mode: 0o600 });
  check('a foreign pid-only holder lock cannot borrow the captured old holder lifetime', refusedDeath(reusedHolder));
  rmSync(lock);
  const driverRef = 'current-resume-driver', driverAddress = 'orchestrator';
  const driverStore = participantCodexHome({ task: record.task, address: driverAddress }, env);
  mkdirSync(driverStore, { recursive: true }); mkdirSync(record.home, { recursive: true });
  const driverRecord = { ...reusedHolder, ref: driverRef, address: driverAddress, role: 'orchestrator', cwd: root, codexHome: driverStore,
    nativeAdmission: { ...admission, nativeStore: realpathSync(driverStore) },
    nativeAdmissionEvidence: { ...currentSchema.nativeAdmissionEvidence, nativeStore: realpathSync(driverStore) } };
  writeSession(driverRecord, env);
  check('actual current-version driver resume does not preempt captured lifetime death with raw holder/app PID liveness',
    codexDriver.resumeState(driverRef, { home: record.home, cwd: root, task: record.task, address: driverAddress, threadId: nativeId, env }).ref === driverRef
      && occupantSignals === 0);
} finally { process.kill = kill0; rmSync(lock, { force: true }); }
for (const code of ['EPERM', 'EIO']) {
  const kill0 = process.kill;
  try {
    process.kill = (pid, signal) => {
      if (pid === nativePids[0] && signal === 0) throw Object.assign(new Error(`fixture ${code}`), { code });
      return kill0(pid, signal);
    };
    check(`current-version native death refuses ${code} rather than treating it as absence`, refusedDeath(currentSchema));
  } finally { process.kill = kill0; }
}
writeFileSync(lock, '{broken-holder-lock', { mode: 0o600 });
check('current-version native death refuses a corrupt holder lock even when native PIDs are absent', refusedDeath(currentSchema));
rmSync(lock);

// Reuse the existing observer child so the parent can stay blocked while its own child is Z.
const release = path.join(root, 'release-zombie');
const zombie = spawn(process.execPath, ['--input-type=module', '-e',
  'import { existsSync } from "node:fs"; while (!existsSync(process.argv[1])) await new Promise(resolve => setTimeout(resolve, 10));', release], { stdio: 'ignore' });
const exited = once(zombie, 'exit');
try {
  const holder = requireProcess(zombie.pid);
  writeSession({ ...currentSchema, holderPid: holder.pid, holderProcess: holder }, env);
  writeFileSync(lock, JSON.stringify({ pid: holder.pid }), { mode: 0o600 });
  writeFileSync(release, 'exit');
  const observed = spawnSync(process.execPath, [fileURLToPath(new URL('./process-lifetime-observer.mjs', import.meta.url)),
    String(holder.pid), holder.birth, '', ref], { env, encoding: 'utf8', timeout: 10000 });
  const value = observed.status === 0 ? JSON.parse(observed.stdout) : null;
  check('an actual exited unreaped holder can resume after its captured lifetime is terminal Z', value?.stat.startsWith('Z')
    && value.synchronous === 'dead' && value.resume?.kind === 'process-birth' && value.resume.holder.birth === holder.birth,
    JSON.stringify({ code: observed.status, value, stderr: observed.stderr }));
} finally { writeFileSync(release, 'exit'); await exited; rmSync(lock, { force: true }); }

import { check } from './check.mjs';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { createRootAdmission, readRootAdmissionState } from '../lib/root-admission.js';
import { approveStandaloneRootProfile } from '../lib/integration.js';
import { readStandaloneLaunch, standaloneClientRevoked, standaloneExpired } from '../lib/standalone-root-state.js';
import { assertNativeBinding, recordNativeBinding, requireCurrentNativeBinding, reserveExplicitStandaloneResume } from '../lib/native-admission.js';
import { stopWorkspaceService } from '../lib/service-client.js';
import { acquireServiceLock, prepareServicePaths, readDiscovery, readPrivate, recordVersion, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { createOwnerEnvironment } from '../lib/service-launch.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-admission-integrity-'));
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-integrity-'));
writeHostConfig(root, { tools: [] });
const binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url)), version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const host = createStandaloneHost({ cwd: root, binPath, version }), env = { ...process.env, PROMPTOBUS_SERVICE_HOME: base, PROMPTOBUS_WARDEN: 'off' };
for (const key of Object.keys(env)) if (/^(BB_|PROMPTOBUS_(CLIENT_|ROOT_|OWNER_ENV_FILE$|ROLE$|TASK$|.*_SESSION$))/.test(key)) delete env[key];
const paths = servicePaths(host, env), runtime = runtimeIdentity(host), owner = createRootAdmission(host, { env }), context = { host, env };
prepareServicePaths(paths);
const stateFile = path.join(paths.directory, 'root-admission', 'state.json'), ledgerFile = path.join(paths.directory, 'native-admission.json');
const markerFile = path.join(paths.directory, 'native-admission.initialized.json');
const binding = { harness: 'codex', nativeStore: root, nativeId: randomUUID(), source: 'standalone', runtime,
  ownerKey: randomUUID(), nonce: randomUUID(), profile: 'ordinary', process: requireProcess(), phase: 'bound' };
const refused = async action => { try { await action(); return false; } catch { return true; } };
const approveStandalone = id => approveStandaloneRootProfile(host, { id, harness: 'claude', nativeStore: root, executable: process.execPath }, env);
try {
  check('uninitialized owner state is absent without asserting empty native history or creating state',
    readRootAdmissionState(paths) === null
    && !await refused(() => assertNativeBinding(paths, binding, context)) && !existsSync(stateFile) && !existsSync(ledgerFile) && !existsSync(markerFile));
  await owner.approveProfile({ id: 'integrity-owner', nativeStore: root });
  const unlock = await acquireServiceLock(path.join(paths.directory, 'root-admission.lock'));
  if (!unlock) throw new Error('Owned integrity fixture lock unavailable');
  try { await recordNativeBinding(paths, binding, context); } finally { unlock(); }
  const state = readPrivate(stateFile), ledger = readPrivate(ledgerFile), marker = readPrivate(markerFile);
  check('first native publication durably marks initialization', marker?.schemaVersion === 2 && marker.root === paths.root && marker.home === paths.home);
  for (const missing of [false, true]) {
    if (missing) rmSync(stateFile); else writePrivate(stateFile, null);
    check(`${missing ? 'missing initialized' : 'literal null'} root state refuses history, admission and use`,
      await refused(() => readRootAdmissionState(paths))
      && await refused(() => assertNativeBinding(paths, binding, context)) && await refused(() => requireCurrentNativeBinding(paths, binding)));
    check(`${missing ? 'missing initialized' : 'literal null'} root state refuses both approvals without replacing evidence`,
      await refused(() => owner.approveProfile({ id: 'must-not-reset', nativeStore: root }))
      && await refused(() => approveStandalone('must-not-reset-native'))
      && (missing ? !existsSync(stateFile) : readFileSync(stateFile, 'utf8').trim() === 'null')
      && !existsSync(path.join(paths.directory, 'root-profile-must-not-reset-native.json')));
    writePrivate(stateFile, state);
    check('restoring exact owned root evidence leaves the original identity usable without generation corruption', !await refused(() => requireCurrentNativeBinding(paths, binding)));
  }
  const pending = { ...binding, ownerKey: randomUUID(), nonce: randomUUID(), phase: 'pending' }; pending.ownerKey = pending.nonce;
  for (const missing of [false, true]) {
    if (missing) rmSync(ledgerFile); else writePrivate(ledgerFile, null);
    check(`${missing ? 'missing initialized' : 'literal null'} native ledger cannot create another pending reservation`,
      await refused(() => reserveExplicitStandaloneResume(paths, pending, context))
      && await refused(() => assertNativeBinding(paths, pending, context)) && await refused(() => requireCurrentNativeBinding(paths, binding)));
    check(`${missing ? 'missing initialized' : 'literal null'} native ledger refuses approval and is not reset`,
      await refused(() => owner.approveProfile({ id: 'must-not-reset-ledger', nativeStore: root }))
      && await refused(() => approveStandalone('must-not-reset-ledger-native'))
      && (missing ? !existsSync(ledgerFile) : readFileSync(ledgerFile, 'utf8').trim() === 'null'));
    writePrivate(ledgerFile, ledger);
  }
  writePrivate(markerFile, null);
  check('corrupt initialization evidence is unknown rather than a fresh empty ledger', await refused(() => assertNativeBinding(paths, binding, context))
    && JSON.stringify(readPrivate(ledgerFile)) === JSON.stringify(ledger));
  writePrivate(markerFile, marker);
  check('exact owned native evidence repair does not revoke or reassign the original identity', !await refused(() => requireCurrentNativeBinding(paths, binding)));
  for (const [file, current] of [[stateFile, state], [ledgerFile, ledger], [markerFile, marker]]) {
    writePrivate(file, { ...current, schemaVersion: 1 });
    const oldBytes = readFileSync(file, 'utf8');
    check('an old schema is refused without migration or overwriting retained state',
      await refused(() => owner.approveProfile({ id: 'must-not-migrate', nativeStore: root }))
      && await refused(() => requireCurrentNativeBinding(paths, binding)) && readFileSync(file, 'utf8') === oldBytes);
    writePrivate(file, current);
  }
  const profileFile = path.join(paths.directory, 'root-profile-corrupt-profile.json'); writePrivate(profileFile, null);
  check('an existing null profile cannot be adopted or overwritten by either approval route',
    await refused(() => owner.approveProfile({ id: 'corrupt-profile', nativeStore: root }))
    && await refused(() => approveStandalone('corrupt-profile')) && readFileSync(profileFile, 'utf8').trim() === 'null');
  const revokedId = randomUUID(), revokedFile = path.join(paths.directory, `standalone-revoked-${revokedId}.json`); writePrivate(revokedFile, null);
  check('a corrupt revocation marker is not treated as absence of revocation', await refused(() => standaloneClientRevoked(paths, revokedId))
    && readFileSync(revokedFile, 'utf8').trim() === 'null');
  const pendingNonce = randomUUID(), retained = path.join(paths.directory, `standalone-launch-${pendingNonce}.json`);
  writePrivate(retained, { schemaVersion: 1, root: paths.root, home: paths.home, runtime, profile: 'retained', nonce: pendingNonce,
    process: binding.process, cwd: root, expiresAt: Date.now() + 120000, clientId: randomUUID(), nativeId: null,
    resumeNativeId: binding.nativeId, phase: 'pending', revoked: false, plan: null });
  const pendingLaunch = readPrivate(retained), reference = { file: retained, nonce: pendingNonce };
  const pendingGrant = { id: pendingLaunch.clientId, runtime, rootLaunch: reference };
  writePrivate(retained, { ...pendingLaunch, expiresAt: 0 });
  check('a primitive pending launch phase enforces the expired deadline', standaloneExpired(pendingGrant, paths));
  for (const phase of [['pending'], ['bound'], { value: 'pending' }, null]) {
    writePrivate(retained, { ...pendingLaunch, expiresAt: 0, phase });
    const bytes = readFileSync(retained, 'utf8');
    check('a corrupt launch phase cannot bypass pending TTL or become a bound generation',
      await refused(() => standaloneExpired(pendingGrant, paths)) && await refused(() => readStandaloneLaunch(paths, runtime, reference))
      && readFileSync(retained, 'utf8') === bytes);
  }
  writePrivate(retained, pendingLaunch);
  rmSync(ledgerFile); rmSync(markerFile, { force: true });
  check('missing old unmarked ledger with retained pending resume is not a genuinely empty owner',
    await refused(() => reserveExplicitStandaloneResume(paths, pending, context)) && !existsSync(ledgerFile) && !existsSync(markerFile));
  rmSync(retained);
  rmSync(profileFile);
  const approvedFile = path.join(paths.directory, 'root-profile-existing-standalone.json');
  writePrivate(approvedFile, { schemaVersion: 1, mode: 'standalone', id: 'existing-standalone', harness: 'claude',
    root: paths.root, home: paths.home, runtime, nativeStore: root, executable: recordVersion(realpathSync(process.execPath)),
    ownerEnvironment: createOwnerEnvironment(host, env) });
  check('an old approved standalone profile without ledger or retained launches does not prove an empty native history',
    await refused(() => assertNativeBinding(paths, pending, context))
    && await refused(() => reserveExplicitStandaloneResume(paths, pending, context))
    && await refused(() => owner.approveProfile({ id: 'must-not-adopt-empty', nativeStore: root }))
    && await refused(() => approveStandalone('existing-standalone'))
    && !existsSync(ledgerFile) && !existsSync(markerFile));
  writePrivate(ledgerFile, ledger);
  const oldBytes = readFileSync(ledgerFile, 'utf8');
  check('a ledger without its initialization marker cannot be adopted or rewritten by approval',
    await refused(() => owner.approveProfile({ id: 'integrity-owner', nativeStore: root }))
    && readFileSync(ledgerFile, 'utf8') === oldBytes && !existsSync(markerFile));
} finally {
  // A paired old-source reproduction can wrongly start an otherwise idle owned service; close only that fixture owner.
  if (readDiscovery(paths)) await stopWorkspaceService(host, { env });
  rmSync(base, { recursive: true, force: true });
}

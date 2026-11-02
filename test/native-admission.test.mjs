import { check } from './check.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { assertNativeBinding, recordNativeBinding } from '../lib/native-admission.js';
import { acquireServiceLock, prepareServicePaths, privateDirectory, readPrivate, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-native-admission-'));
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-admission-'));
const binPath = fileURLToPath(new URL('../bin/promptobus.js', import.meta.url));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
writeHostConfig(root, { tools: [] });
const host = createStandaloneHost({ cwd: root, binPath, version });
const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: base }, paths = servicePaths(host, env), context = { host, env };
prepareServicePaths(paths);
const ledger = path.join(paths.directory, 'native-admission.json');
const freshLedgerFixture = () => { rmSync(ledger, { force: true }); rmSync(path.join(paths.directory, 'native-admission.initialized.json'), { force: true }); };
const binding = { harness: 'claude', nativeStore: root, nativeId: 'actual-native-one', source: 'standalone',
  runtime: runtimeIdentity(host), ownerKey: randomUUID(), process: requireProcess(), nonce: randomUUID(), profile: 'ordinary', phase: 'bound' };
const refused = async action => { try { await action(); return false; } catch { return true; } };
const transaction = async action => {
  const release = await acquireServiceLock(path.join(paths.directory, 'root-admission.lock'));
  if (!release) throw new Error('Fixture native owner lock is occupied');
  try { return await action(); } finally { release(); }
};
try {
  await transaction(async () => {
    await recordNativeBinding(paths, binding, context);
    await recordNativeBinding(paths, structuredClone(binding), context);
  });
  check('exact repeated native binding is durable and idempotent', readPrivate(ledger).bindings.length === 1);
  const retainedLedger = readPrivate(ledger), sourceFile = path.join(paths.directory, `standalone-launch-${binding.nonce}.json`);
  const profileFile = path.join(paths.directory, 'root-profile-ordinary.json');
  const profile = { mode: 'standalone', root: paths.root, home: paths.home, harness: binding.harness, nativeStore: root };
  writePrivate(sourceFile, { ...binding, root: paths.root, home: paths.home, nativeId: binding.nativeId, resumeNativeId: null });
  for (const harness of [['claude'], { value: 'claude' }, null]) {
    writePrivate(profileFile, { ...profile, harness });
    const bytes = readFileSync(profileFile, 'utf8');
    check('a nonprimitive retained native-profile harness cannot be treated as a foreign harness',
      await refused(() => assertNativeBinding(paths, binding, context)) && readFileSync(profileFile, 'utf8') === bytes);
  }
  writePrivate(profileFile, profile);
  rmSync(sourceFile);
  const competitor = { ...binding, ownerKey: randomUUID(), nonce: randomUUID() };
  for (const field of ['harness', 'source']) for (const value of [[binding[field]], { value: binding[field] }, null]) {
    writePrivate(ledger, { ...retainedLedger, bindings: [{ ...binding, [field]: value }] });
    const bytes = readFileSync(ledger, 'utf8');
    check(`retired source: corrupt ledger ${field} cannot admit a competing same-store same-ID generation`,
      await refused(() => transaction(() => recordNativeBinding(paths, competitor, context))) && readFileSync(ledger, 'utf8') === bytes);
  }
  writePrivate(ledger, retainedLedger); rmSync(profileFile);
  for (const source of ['bb', 'managed']) {
    check(`standalone then ${source} cannot replace the same actual tuple`, await refused(() =>
      assertNativeBinding(paths, { ...binding, source, ownerKey: 'other-generation', nonce: 'different' }, context)));
  }
  freshLedgerFixture();
  const unknown = { ...binding, source: 'managed', nativeStore: null, process: null, ownerKey: 'owned-launch', nonce: 'owned-launch', profile: undefined, phase: undefined };
  await transaction(() => recordNativeBinding(paths, unknown, context));
  check('managed unknown provenance then standalone refuses the potentially matching identity', await refused(() => assertNativeBinding(paths, binding, context)));
  check('unknown managed provenance does not block an unrelated actual ID', !await refused(() =>
    assertNativeBinding(paths, { ...binding, nativeId: 'unrelated-native' }, context)));
  await transaction(() => recordNativeBinding(paths, { ...unknown, nativeStore: root, process: binding.process }, context));
  check('the same managed publisher generation can refine only its own unknown provenance', readPrivate(ledger).bindings[0].nativeStore === root);
  check('another publisher cannot refine an unresolved managed generation', await refused(() =>
    assertNativeBinding(paths, { ...unknown, ownerKey: 'foreign-launch', nativeStore: root, process: binding.process }, context)));
  freshLedgerFixture();
  await transaction(() => recordNativeBinding(paths, { ...binding, source: 'bb', ownerKey: 'thr_exact' }, context));
  check('BB then standalone refuses the same actual tuple', await refused(() => assertNativeBinding(paths, binding, context)));
  writePrivate(ledger, { schemaVersion: 2, root: paths.root, home: paths.home, bindings: 'corrupt' });
  check('a corrupt available registry is not treated as empty', await refused(() => assertNativeBinding(paths, binding, context)));
  freshLedgerFixture();
  const registry = path.join(base, 'legacy-harness');
  privateDirectory(registry); privateDirectory(path.join(registry, 'sessions'));
  const previous = host.harnessStateHome;
  host.harnessStateHome = () => registry;
  writePrivate(path.join(registry, 'sessions', 'legacy.json'), { home: paths.home, sessionId: binding.nativeId, launchId: 'legacy-launch' });
  check('matching accessible legacy identity is excluded before the new ledger exists', await refused(() => assertNativeBinding(paths, binding, context)));
  check('legacy identity inspection keeps unrelated identities available', !await refused(() =>
    assertNativeBinding(paths, { ...binding, nativeId: 'unrelated-native' }, context)));
  host.harnessStateHome = previous;
} finally { rmSync(base, { recursive: true, force: true }); }

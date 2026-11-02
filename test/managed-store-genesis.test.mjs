import { check } from './check.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { reserveManagedNativeIdentity } from '../lib/native-admission.js';
import { prepareServicePaths, readPrivate, recordVersion, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { bus, createTask, participantRecord, upsertParticipant } from '../lib/store.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-managed-store-genesis-'));
const base = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-managed-stores-'));
writeHostConfig(root, { tools: [] });
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const host = createStandaloneHost({ cwd: root, binPath: fileURLToPath(new URL('../bin/promptobus.js', import.meta.url)), version });
const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: base }, paths = servicePaths(host, env), runtime = runtimeIdentity(host);
prepareServicePaths(paths); bus(paths.home, { cli: version });
const processIdentity = requireProcess(), executable = recordVersion(realpathSync(process.execPath));
const ledgerFile = path.join(paths.directory, 'native-admission.json');
const bytes = () => existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8') : null;
const refused = async action => { try { await action(); return false; } catch { return true; } };
try {
  for (const harness of ['cursor', 'opencode']) {
    const nativeId = randomUUID(), hint = randomUUID(), task = `store-${harness}-t20261101-000000`, address = 'worker:store', ref = `store-${harness}`, launchId = randomUUID();
    createTask(paths.home, { id: task, title: 'Private native-store publication contract', owner: 'fixture-owner' });
    const nativeStore = harness === 'cursor'
      ? path.join(root, 'native-cursor', 'chats', createHash('md5').update(path.resolve(root)).digest('hex'), nativeId, 'store.db')
      : path.join(root, 'native-opencode', 'opencode.db');
    mkdirSync(path.dirname(nativeStore), { recursive: true }); writeFileSync(nativeStore, 'SQLite format 3\0', { mode: 0o600 });
    const file = path.join(paths.directory, `${harness}-owned.json`), tuple = { harness, nativeStore, nativeId, process: processIdentity };
    // These private unit packets represent verified producers; they are not native CLI/API creation evidence.
    const command = harness === 'cursor'
      ? { executable, launcher: executable, bundle: executable, cwd: root, argv: ['persist', '--resume', nativeId], nativeEnvironment: { CURSOR_CONFIG_DIR: path.join(root, 'native-cursor') } }
      : { executable, argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'], nativeEnvironment: { XDG_DATA_HOME: root, OPENCODE_DB: nativeStore } };
    const evidence = harness === 'cursor'
      ? { kind: 'cursor-create-chat', method: 'create-chat', source: 'sessionStart', ...tuple, executable, launcher: executable, bundle: executable }
      : { kind: 'opencode-session-api', method: 'session/create', ...tuple, executable, endpoint: 'http://127.0.0.1:12345' };
    const record = { ref, home: paths.home, task, address, launchId, cwd: root, [harness === 'cursor' ? 'chatId' : 'sessionId']: nativeId,
      nativeCommand: command, nativeAdmission: tuple, nativeAdmissionEvidence: evidence,
      ...(harness === 'cursor' ? { nativeCreationEvidence: { kind: 'cursor-create-chat', nativeId, exitCode: 0, launcher: executable, cwd: root },
        nativeStartEvidence: { harness, nativeId, process: processIdentity } } : { holderPid: processIdentity.pid, holderProcess: processIdentity, url: evidence.endpoint }) };
    upsertParticipant(paths.home, task, participantRecord(address, { harness, sessionRef: ref, sessionRecord: file, sessionId: nativeId, nativeLaunchId: launchId }));
    const grant = { id: randomUUID(), runtime, nativeBinding: { kind: harness, state: 'pending' }, lifetime: { kind: 'managed', task, address, ref, record: file, launchId } };
    writePrivate(file, record);
    const before = bytes();
    if (harness === 'cursor') check('an initialized-looking Cursor file without the actual process descriptor cannot establish first binding',
      await refused(() => reserveManagedNativeIdentity(paths, grant, nativeId, { host, env })) && bytes() === before);
    const invalid = [
      { ...record, nativeAdmissionEvidence: { ...evidence, nativeId: hint } },
      { ...record, nativeCreationPending: { command: 'still-unresolved' } },
      { ...record, nativeAdmission: { ...tuple, process: { ...processIdentity, birth: 'foreign-birth' } } },
      ...(harness === 'cursor' ? [{ ...record, nativeCreationEvidence: { ...record.nativeCreationEvidence, nativeId: hint } }]
        : [{ ...record, nativeCommand: { ...command, nativeEnvironment: { ...command.nativeEnvironment, OPENCODE_SIMULATE: '1' } } },
          { ...record, nativeCommand: { ...command, nativeEnvironment: { ...command.nativeEnvironment, OPENCODE_DB: ':memory:' } } }]),
    ];
    for (const changed of invalid) {
      writePrivate(file, changed);
      check(`${harness} malformed/foreign/unresolved evidence cannot write the ledger`, await refused(() => reserveManagedNativeIdentity(paths, grant, nativeId, { host, env })) && bytes() === before);
    }
    writePrivate(file, record);
    const fd = harness === 'cursor' ? openSync(nativeStore, 'r+') : undefined;
    try { await reserveManagedNativeIdentity(paths, grant, nativeId, { host, env }); }
    finally { if (fd !== undefined) closeSync(fd); }
    check(`${harness} consumes only its exact verified producer tuple`, readPrivate(ledgerFile).bindings.some(binding => binding.harness === harness && binding.nativeStore === nativeStore && binding.nativeId === nativeId));
  }
} finally { rmSync(base, { recursive: true, force: true }); }

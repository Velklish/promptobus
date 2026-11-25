import { check } from './check.mjs';
import { makeServiceTestDirectory } from './service-test-directory.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { reserveManagedNativeIdentity } from '../lib/native-admission.js';
import { prepareServicePaths, readPrivate, recordVersion, requireProcess, runtimeIdentity, servicePaths, writePrivate } from '../lib/service-state.js';
import { bus, createTask, participantRecord, upsertParticipant } from '../lib/store.js';
import { cursorAssignment, CURSOR_TMUX_SERVER, workspaceHash } from '../lib/cursor-persist.js';
import { makeSandbox, stubCommand, writeHostConfig } from './sandbox.mjs';

const root = realpathSync(makeSandbox('promptobus-managed-store-genesis-'));
const base = makeServiceTestDirectory('pb-managed-stores-');
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
  for (const producer of ['cursor-persist', 'cursor-create-chat', 'opencode']) {
    const harness = producer === 'opencode' ? producer : 'cursor';
    const nativeId = randomUUID(), hint = randomUUID(), task = `store-${producer}-t20261101-000000`, address = 'worker:store', ref = `store-${producer}`, launchId = randomUUID();
    createTask(paths.home, { id: task, title: 'Private native-store publication contract', owner: 'fixture-owner' });
    const nativeStore = harness === 'cursor'
      ? path.join(root, 'native-cursor', 'chats', createHash('md5').update(path.resolve(root)).digest('hex'), nativeId, 'store.db')
      : path.join(root, 'native-opencode', 'opencode.db');
    mkdirSync(path.dirname(nativeStore), { recursive: true }); writeFileSync(nativeStore, 'SQLite format 3\0', { mode: 0o600 });
    const file = path.join(paths.directory, `${harness}-owned.json`), tuple = { harness, nativeStore, nativeId, process: processIdentity };
    // These private unit packets represent verified producers; they are not native CLI/API creation evidence.
    const nonce = randomUUID();
    const fresh = producer === 'cursor-persist', sessionName = 'cursor-store-1-fixture';
    const cursorArgv = fresh ? ['persist', '--workspace', root, '--trust', '--force', '--model', 'fixture', '--', cursorAssignment(nonce).argument] : ['persist', '--resume', nativeId];
    const command = harness === 'cursor'
      ? { executable, launcher: executable, bundle: executable, cwd: root, argv: cursorArgv, nativeEnvironment: { CURSOR_CONFIG_DIR: path.join(root, 'native-cursor'), CURSOR_AGENT_TMUX_SERVER_NAME: CURSOR_TMUX_SERVER } }
      : { executable, argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'], nativeEnvironment: { XDG_DATA_HOME: root, OPENCODE_DB: nativeStore } };
    const evidence = harness === 'cursor'
      ? { kind: producer, method: fresh ? 'persist' : 'create-chat', source: 'sessionStart', ...tuple, executable, launcher: executable, bundle: executable }
      : { kind: 'opencode-session-api', method: 'session/create', ...tuple, executable, endpoint: 'http://127.0.0.1:12345' };
    const record = { ref, home: paths.home, task, address, launchId, cwd: root, [harness === 'cursor' ? 'chatId' : 'sessionId']: nativeId,
      ...(fresh ? { argv: cursorArgv, sessionName, nativePersistNonce: nonce, tmuxServer: CURSOR_TMUX_SERVER, panePid: processIdentity.pid, workspaceHash: createHash('sha256').update(root).digest('hex').slice(0, 10) } : {}),
      nativeCommand: command, nativeAdmission: tuple, nativeAdmissionEvidence: evidence,
      ...(harness === 'cursor' ? { nativeCreationEvidence: { kind: producer, nativeId, ...(fresh ? { launchId, sessionName, nonce } : { exitCode: 0 }), launcher: executable, cwd: root },
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
      ...(fresh ? [
        ...['resume', '--resume', '--approve-mcps'].map(prompt => {
          const argv = [...cursorArgv.slice(0, -1), prompt];
          return { ...record, argv, nativeCommand: { ...command, argv } };
        }),
        { ...record, sessionName: 'cursor-foreign' },
        { ...record, panePid: processIdentity.pid + 1 },
        { ...record, nativeCreationEvidence: { ...record.nativeCreationEvidence, launchId: hint } },
        { ...record, nativeCommand: { ...command, argv: ['persist', '--resume', nativeId] }, argv: ['persist', '--resume', nativeId] },
      ] : []),
      ...(harness === 'cursor' ? [{ ...record, nativeCreationEvidence: { ...record.nativeCreationEvidence, nativeId: hint } }]
        : [{ ...record, nativeCommand: { ...command, nativeEnvironment: { ...command.nativeEnvironment, OPENCODE_SIMULATE: '1' } } },
          { ...record, nativeCommand: { ...command, nativeEnvironment: { ...command.nativeEnvironment, OPENCODE_DB: ':memory:' } } }]),
    ];
    const fd = harness === 'cursor' ? openSync(nativeStore, 'r+') : undefined;
    try {
      for (const changed of invalid) {
        writePrivate(file, changed);
        check(`${producer} malformed/foreign/unresolved evidence cannot write the ledger`, await refused(() => reserveManagedNativeIdentity(paths, grant, nativeId, { host, env })) && bytes() === before);
      }
      writePrivate(file, record);
      if (fresh) {
        const bins = path.join(root, 'fixture-bin'), inventory = path.join(root, 'tmux.list');
        mkdirSync(bins);
        const hold = path.join(root, 'hold-tmux'), entered = path.join(root, 'tmux-entered');
        stubCommand(bins, 'tmux', `import{existsSync,readFileSync,writeFileSync}from'node:fs';
if(!process.argv.includes('list-sessions')||!process.argv.includes('cursor-agent'))process.exit(1);
if(existsSync(${JSON.stringify(hold)})){
  writeFileSync(${JSON.stringify(entered)},'ready');
  const limit=Date.now()+1500;
  while(existsSync(${JSON.stringify(hold)}) && Date.now()<limit) await new Promise(resolve=>setTimeout(resolve,20));
}
process.stdout.write(readFileSync(${JSON.stringify(inventory)}));`);
        env.PATH = bins + path.delimiter + process.env.PATH;
        const row = [sessionName, 0, 1, processIdentity.pid, 1, workspaceHash(root), nativeId, '', ''].join('|');
        for (const wrong of ['', row.replace(sessionName, 'cursor-renamed'), row.replace(nativeId, hint)]) {
          writeFileSync(inventory, wrong);
          check('a changed or absent tmux pane cannot enter the native ledger even while the same process holds SQLite',
            await refused(() => reserveManagedNativeIdentity(paths, grant, nativeId, { host, env })) && bytes() === before);
        }
        writeFileSync(inventory, row);
        writeFileSync(hold, 'hold');
        let serviced = false;
        const concurrent = setInterval(() => {
          if (!existsSync(entered) || serviced) return;
          serviced = true;
          writePrivate(file, { ...record, launchId: 'replacement-during-tmux' });
          rmSync(hold);
        }, 10);
        try {
          const denied = await refused(() => reserveManagedNativeIdentity(paths, grant, nativeId, { host, env }));
          check('service yields to concurrent work during tmux and refuses the changed record before writing the ledger',
            serviced && denied && bytes() === before);
        } finally { clearInterval(concurrent); rmSync(hold, { force: true }); }
        writePrivate(file, record);
      }
      await reserveManagedNativeIdentity(paths, grant, nativeId, { host, env });
    }
    finally { if (fd !== undefined) closeSync(fd); }
    check(`${harness} consumes only its exact verified producer tuple`, readPrivate(ledgerFile).bindings.some(binding => binding.harness === harness && binding.nativeStore === nativeStore && binding.nativeId === nativeId));
  }
} finally { rmSync(base, { recursive: true, force: true }); }

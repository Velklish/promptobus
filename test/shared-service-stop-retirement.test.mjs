import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStandaloneHost } from '../dist/host-index.js';
import { createTask, participantOf, participantRecord, readTask, upsertParticipant } from '../lib/store.js';
import { commandReceipts } from '../lib/codex-command-receipts.js';
import { codexStateHome, sessionFile, sessionKey, writeSession } from '../lib/codex-session.js';
import { retainNativeStop } from '../lib/native-lifecycle.js';
import { ensureWorkspaceService, registerServiceClient, revokeServiceClient, stopWorkspaceService, workspaceServiceStatus } from '../lib/service-client.js';
import { servicePaths } from '../lib/service-state.js';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';

test('confirmed managed Stop retires only its own service client', async () => {
  const root = realpathSync(makeSandbox('promptobus-service-operation-retirement-'));
  const privateHome = mkdtempSync(path.join(realpathSync('/tmp'), 'pb-retirement-'));
  const home = path.join(root, '.promptobus'), nativeHome = path.join(root, 'native');
  const env = { ...process.env, PROMPTOBUS_SERVICE_HOME: privateHome, PROMPTOBUS_HOME: home,
    PROMPTOBUS_CODEX_HOME: nativeHome, PROMPTOBUS_WARDEN: 'off', PROMPTOBUS_SERVICE_IDLE_MS: '60000' };
  const host = createStandaloneHost({ cwd: root, binPath: fileURLToPath(new URL('../bin/promptobus.js', import.meta.url)), version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version });
  const previousNativeHome = process.env.PROMPTOBUS_CODEX_HOME;
  process.env.PROMPTOBUS_CODEX_HOME = nativeHome;
  const paths = servicePaths(host, env), options = { cwd: root, env }, clients = [];
  writeHostConfig(root, { tools: [] });
  let serviceStopped = false;
  try {
    await ensureWorkspaceService(host, options);
    const task = 'retirement-t20261110-000000';
    createTask(home, { id: task, title: 'retirement', owner: 'owner' });
    const make = async (address, ref, mode = 'managed', nativeKind = 'codex') => {
      const record = { ref, home, task, address, launchId: `launch-${ref}`, threadId: `thread-${ref}`, holderPid: process.pid, appPid: process.pid, state: 'dead', stopConfirmed: true };
      writeSession(record, env);
      const recordPath = sessionFile(ref, env);
      upsertParticipant(home, task, participantRecord(address, { harness: 'codex', mode, sessionRef: ref,
        sessionId: record.threadId, sessionRecord: recordPath, nativeLaunchId: record.launchId }));
      const client = await registerServiceClient(host, { cwd: root, env: { ...env, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: address },
        nativeBinding: { kind: nativeKind, state: 'pending' },
        lifetime: { kind: 'managed', task, address, ref, record: recordPath, launchId: record.launchId } }, options);
      clients.push(client);
      return { record, recordPath, client };
    };
    const stopped = await make('worker:stopped', 'stopped'), unknown = await make('worker:unknown', 'unknown');
    const attached = await make('worker:attached', 'attached', 'attached');
    const stoppedReceipt = actor => {
      assert.equal(existsSync(actor.client.credentialFile), true, 'test must start with an issued credential');
      actor.record.holderPid = 2147483646; actor.record.appPid = 2147483645;
      const file = path.join(codexStateHome(env), 'receipts', sessionKey(actor.record.ref), sessionKey(actor.record.launchId) + '.jsonl');
      const ledger = commandReceipts(file, { format: 1, ...actor.record }), deadlineAt = Date.now() + 5000;
      ledger.append('stop/requested', { threadId: actor.record.threadId, deadlineAt });
      ledger.append('app-server/close', { code: 0, signal: null });
      ledger.append('stop/confirmed', { ...actor.record, commands: [], appClose: { code: 0, signal: null }, deadlineAt, originalToolReceipt: 'not synthesized' });
      retainNativeStop(actor.record, file);
      rmSync(actor.recordPath);
      return file;
    };
    stoppedReceipt(stopped); stoppedReceipt(attached); rmSync(unknown.recordPath);
    const negatives = [];
    for (const damage of ['receipt', 'thread', 'launch', 'live-holder', 'ref', 'unlaunched', 'binding']) {
      const actor = await make(`worker:${damage}`, damage, 'managed', damage === 'binding' ? 'claude' : 'codex'), file = stoppedReceipt(actor);
      const p = participantOf(readTask(home, task), actor.record.address);
      if (damage === 'receipt' || damage === 'unlaunched') rmSync(file);
      if (damage === 'unlaunched') p.metadata.nativeUnlaunched = actor.record.launchId;
      if (damage === 'thread') p.metadata.nativeStop.threadId = 'foreign-thread';
      if (damage === 'launch') p.metadata.nativeStop.launchId = 'foreign-launch';
      if (damage === 'live-holder') p.metadata.nativeStop.holderPid = process.pid;
      if (damage === 'ref') p.metadata.nativeStop.ref = 'foreign-ref';
      upsertParticipant(home, task, p);
      negatives.push({ damage, actor });
    }
    const aliases = [];
    for (const damage of ['valid', 'alias', 'child']) {
      const ref = `alias-${damage}`, address = `teamlead:${damage}`, child = `retirement-child-${damage}-t20261110-000000`;
      const record = { ref, home, task, address, launchId: `launch-${ref}`, threadId: `thread-${ref}`,
        holderPid: process.pid, appPid: process.pid, state: 'dead', stopConfirmed: true };
      createTask(home, { id: child, parent: task, teamlead: address, owner: record.threadId });
      writeSession(record, env);
      const nativeRecordPath = sessionFile(ref, env), recordPath = path.join(root, `teamlead-root-${damage}.json`);
      writeFileSync(recordPath, JSON.stringify(record));
      upsertParticipant(home, task, participantRecord(address, { harness: 'codex', mode: 'managed', sessionRef: ref,
        sessionId: record.threadId, sessionRecord: recordPath, nativeLaunchId: record.launchId, childTask: child }));
      const client = await registerServiceClient(host, { cwd: root,
        env: { ...env, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: address }, nativeBinding: { kind: 'codex', state: 'pending' },
        lifetime: { kind: 'managed', task, address, ref, record: recordPath, launchId: record.launchId } }, options);
      clients.push(client);
      assert.equal(existsSync(client.credentialFile), true);
      upsertParticipant(home, child, participantRecord('orchestrator', { harness: 'codex', mode: 'attached', sessionRef: ref,
        sessionId: record.threadId, sessionRecord: nativeRecordPath, nativeLaunchId: record.launchId, owner: record.threadId }));
      record.task = child; record.address = 'orchestrator';
      const actor = { record, recordPath: nativeRecordPath, client };
      stoppedReceipt(actor);
      rmSync(recordPath);
      if (damage === 'alias') {
        const lead = participantOf(readTask(home, task), address);
        lead.metadata.nativeStop.alias.address = 'teamlead:foreign';
        upsertParticipant(home, task, lead);
      }
      if (damage === 'child') {
        const owner = participantOf(readTask(home, child), 'orchestrator');
        owner.metadata.nativeStop = null;
        upsertParticipant(home, child, owner);
      }
      aliases.push({ damage, client });
    }
    const before = participantOf(readTask(home, task), 'worker:stopped');
    const status = await workspaceServiceStatus(host, options);
    assert.equal(existsSync(stopped.client.credentialFile), false, 'confirmed Stop must retire its exact credential');
    assert.equal(existsSync(attached.client.credentialFile), false, 'confirmed attached Stop must retire its exact credential');
    assert.equal(existsSync(unknown.client.credentialFile), true, 'missing launch record without Stop proof remains unknown');
    for (const { damage, actor } of negatives) assert.equal(existsSync(actor.client.credentialFile), true, `${damage} must retain its client`);
    for (const { damage, client } of aliases) assert.equal(existsSync(client.credentialFile), damage !== 'valid', `alias ${damage} retirement`);
    assert.equal(status.unknownManaged, 10);
    assert.deepEqual(participantOf(readTask(home, task), 'worker:stopped'), before);
    for (const client of clients) if (existsSync(client.credentialFile)) await revokeServiceClient(host, client.clientId, options);
    await stopWorkspaceService(host, options);
    serviceStopped = true;
    assert.equal((await workspaceServiceStatus(host, options)).running, false, 'public Stop must physically exit after proven clients retire');
  } finally {
    for (const client of clients) if (existsSync(client.credentialFile)) await revokeServiceClient(host, client.clientId, options);
    if (!serviceStopped) await stopWorkspaceService(host, options).catch(() => {});
    rmSync(privateHome, { recursive: true, force: true });
    if (previousNativeHome === undefined) delete process.env.PROMPTOBUS_CODEX_HOME;
    else process.env.PROMPTOBUS_CODEX_HOME = previousNativeHome;
  }
});

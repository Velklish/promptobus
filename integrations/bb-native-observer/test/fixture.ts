import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openEngine } from '../../../src/index.js';
import { sessionFileName } from '../projection.js';

export function fixture(taskId = 'portable-task-27', options: { launchBound?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pb-native-panel-fixture-')));
  const selection = { storeRoot: path.join(root, 'bus'), nativeRoot: path.join(root, 'codex-state'), taskId };
  const engine = openEngine({ home: selection.storeRoot, recover: false, policy: () => ({ allow: true }) });
  const owner = { id: 'owner', role: 'orchestrator', harness: 'codex', mode: 'attached' as const,
    sessionRef: null, capabilities: null, metadata: { address: 'orchestrator', token: 'SECRET-OWNER' } };
  engine.createTask({ id: taskId, title: 'SECRET-TITLE', owner });
  const records = ['worker:alpha', 'reviewer:beta', 'worker:gamma'].map((address, index) => {
    const record = { ref: `native-${index}`, home: selection.storeRoot, task: taskId, address,
      launchId: `launch-${index}`, threadId: `thread-${index}`, state: 'alive', busy: index === 0,
      sandbox: 'readOnly', token: 'SECRET-RECORD', commandReceiptFile: path.join(selection.nativeRoot, 'receipts', `${index}.jsonl`) };
    engine.addParticipant(taskId, { ...owner, id: `actor-${index}`, role: index === 1 ? 'reviewer' : 'worker',
      mode: 'managed', sessionRef: record.ref, metadata: { address, name: record.ref, sessionRef: record.ref, session: record.threadId, sessionId: record.threadId,
        ...(options.launchBound ? { nativeLaunchId: record.launchId } : {}), token: 'SECRET-PARTICIPANT' } });
    mkdirSync(path.join(selection.nativeRoot, 'sessions'), { recursive: true });
    mkdirSync(path.dirname(record.commandReceiptFile), { recursive: true });
    writeFileSync(path.join(selection.nativeRoot, 'sessions', sessionFileName(record.ref)), JSON.stringify(record));
    const launch = { sequence: 1, kind: 'launch', ref: record.ref, task: taskId, address, launchId: record.launchId };
    writeFileSync(record.commandReceiptFile, [launch, { sequence: 2, kind: 'item/started', command: 'SECRET-COMMAND' },
      { sequence: 3, kind: 'item/completed', aggregatedOutput: 'SECRET-OUTPUT' }].map(row => JSON.stringify(row)).join('\n') + '\n');
    return record;
  });
  engine.sendSync(taskId, { from: owner.id, to: ['actor-0'], type: 'task', body: 'SECRET-READ-BODY' });
  engine.read(taskId, 'actor-0');
  engine.sendSync(taskId, { from: owner.id, to: ['actor-0'], type: 'task', body: 'SECRET-UNREAD-BODY' });
  return { root, selection, engine, records, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
export function treeDigest(root: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      hash.update(path.relative(root, file));
      if (entry.isDirectory()) walk(file); else hash.update(readFileSync(file));
    }
  };
  walk(root); return hash.digest('hex');
}

import { check } from './check.mjs';
import path from 'node:path';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { hostOf } from '../lib/host.js';
import * as store from '../lib/store.js';
import { commandReceipts, readStopConfirmation } from '../lib/codex-command-receipts.js';
import { retainNativeStop, requireNativeIdle } from '../lib/native-lifecycle.js';
import { sessionKey } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-codex-');
writeHostConfig(root, { tools: ['codex'] });
const home = hostOf(root).promptobusHome(), task = 'implicit-retention-t20261024-000001';
process.env.PROMPTOBUS_CODEX_HOME = path.join(root, 'native');
store.createTask(home, { id: task, title: 'Synthetic receipt retention', owner: 'fixture' });
const record = { home, task, address: 'worker:one', ref: 'implicit-fixture', launchId: 'launch',
  threadId: 'thread', cwd: root, holderPid: 2147483646, appPid: 2147483645, rawToolReceipts: true };
store.upsertParticipant(home, task, store.participantRecord(record.address, {
  harness: 'codex', mode: 'managed', sessionRef: record.ref, sessionId: record.threadId, nativeLaunchId: record.launchId,
}));
const file = path.join(process.env.PROMPTOBUS_CODEX_HOME, 'receipts', sessionKey(record.ref), sessionKey(record.launchId) + '.jsonl');
const receipts = commandReceipts(file, { format: 1, ...record });
receipts.context?.('thread/accepted', { launchId: record.launchId, threadId: record.threadId, cwd: root, profile: 'fixed-single-local' });
receipts.context?.('turn/accepted', { launchId: record.launchId, threadId: record.threadId, turnId: 'turn' });
const raw = item => receipts.observe({ method: 'rawResponseItem/completed',
  params: { threadId: record.threadId, turnId: 'turn', item } }, record.threadId);
raw({ type: 'function_call', name: 'exec_command', call_id: 'call', arguments: '{"cmd":"fixture"}' });
raw({ type: 'function_call_output', call_id: 'call', output: 'Process exited with code 0\nOutput:\n' });
receipts.observe({ method: 'item/completed', params: { threadId: record.threadId, turnId: 'turn',
  item: { type: 'commandExecution', id: 'call', command: 'fixture', cwd: root, status: 'completed', exitCode: 0 } } }, record.threadId);
const deadlineAt = Date.now() + 5000, { commands, rawTools } = receipts.snapshot();
receipts.append('stop/requested', { threadId: record.threadId, deadlineAt });
receipts.append('app-server/close', { code: 0, signal: null });
receipts.append('stop/confirmed', { ...record, commands, rawTools,
  appClose: { code: 0, signal: null }, deadlineAt, originalToolReceipt: 'not synthesized' });
check('implicit cwd retention: synthetic full launch proof validates before retirement', readStopConfirmation(file, record).ok);
store.withTaskLock(home, task, () => retainNativeStop(record, file));
const retained = store.participantOf(store.readTask(home, task), record.address).metadata.nativeStop;
check('implicit cwd retention: nativeStop preserves immutable launch cwd for replay', retained.cwd === root);
check('implicit cwd retention: same retained reference validates after the session record is absent', readStopConfirmation(file, retained).ok);
let refusal;
try { requireNativeIdle(home, store.readTask(home, task)); } catch (error) { refusal = error.message; }
check('implicit cwd retention: native close guard can consume retained implicit proof', !refusal, refusal);

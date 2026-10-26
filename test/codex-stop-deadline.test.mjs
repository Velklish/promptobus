import { check } from './check.mjs';
import { commandReceipts, readStopConfirmation } from '../lib/codex-command-receipts.js';
import { makeSandbox } from './sandbox.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = makeSandbox('promptobus-codex-');
const record = { ref: 'deadline', launchId: 'launch', threadId: 'thread', holderPid: 123, appPid: 124 };
const file = path.join(root, 'selected.jsonl');
const deadlineAt = Date.now();
const ledger = commandReceipts(file, { format: 1, ...record });
ledger.append('stop/requested', { threadId: 'thread', deadlineAt });
ledger.append('app-server/close', { code: 0, signal: null });
ledger.append('stop/confirmed', { ...record, deadlineAt, commands: [],
  appClose: { code: 0, signal: null }, originalToolReceipt: 'not synthesized' });
const original = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
original.forEach((row, i) => { row.at = new Date(deadlineAt - 10 + i).toISOString(); });
const proof = rows => {
  writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  return readStopConfirmation(file, record);
};
check('Stop deadline: same-launch confirmation within its recorded allowance is valid', proof(original).ok);
for (const [name, mutate] of [
  ['late appClose', rows => { rows[2].at = new Date(deadlineAt + 1).toISOString(); }],
  ['late confirmation', rows => { rows[3].at = new Date(deadlineAt + 1).toISOString(); }],
  ['missing request', rows => { rows[1].kind = 'unrelated'; }],
  ['changed deadline', rows => { rows[3].deadlineAt++; }],
  ['foreign requested thread', rows => { rows[1].threadId = 'foreign'; }],
  ['non-finite deadline', rows => { rows[1].deadlineAt = null; }],
  ['invalid request timestamp', rows => { rows[1].at = 'invalid'; }],
  ['earlier appClose reused by a new request', rows => {
    [rows[1], rows[2]] = [rows[2], rows[1]];
    rows.forEach((row, i) => { row.sequence = i + 1; });
  }],
]) {
  const rows = structuredClone(original); mutate(rows);
  const result = proof(rows);
  check(`Stop deadline: ${name} cannot authorize later retirement`, !result.ok, JSON.stringify(result));
}

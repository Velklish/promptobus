import { check } from './check.mjs';
import path from 'node:path';
import { makeSandbox } from './sandbox.mjs';
import { commandReceipts, readStopConfirmation } from '../lib/codex-command-receipts.js';

const root = makeSandbox('promptobus-codex-');
let sequence = 0;
const identity = { format: 1, ref: 'fixture', launchId: 'launch', threadId: 'thread',
  holderPid: 2147483646, appPid: 2147483645 };
const start = { method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: {
  type: 'commandExecution', id: 'cmd', command: 'fixture-never-executed', cwd: root,
  status: 'inProgress', processId: null, exitCode: null, aggregatedOutput: null } } };
const end = structuredClone(start);
end.method = 'item/completed'; end.params.item.status = 'declined';
const delta = value => ({ method: 'item/commandExecution/outputDelta', params: {
  threadId: 'thread', turnId: 'turn', itemId: 'cmd', delta: value } });
const change = (which, key, value) => events => { events[which].params.item[key] = value; };
const omit = (which, key) => events => { delete events[which].params.item[key]; };
const cases = [
  ['explicit declined', () => {}, true],
  ['empty aggregate', events => { for (const event of events) event.params.item.aggregatedOutput = ''; }, true],
  ['missing optional aggregate', events => { for (const event of events) delete event.params.item.aggregatedOutput; }, true],
  ['missing start', events => events.shift()],
  ['duplicate start', events => events.unshift(structuredClone(start))],
  ['duplicate decline', events => events.push(structuredClone(end))],
  ['output before start', events => events.unshift(delta('unexpected'))],
  ['output during admission', events => events.splice(1, 0, delta('unexpected'))],
  ['empty output delta', events => events.splice(1, 0, delta(''))],
  ['output after decline', events => events.push(delta('late'))],
  ['completion after decline', events => events.push({ ...structuredClone(end), params: {
    ...end.params, item: { ...end.params.item, status: 'completed', exitCode: 0 } } })],
  ['declined start', change(0, 'status', 'declined')],
  ['unknown start', change(0, 'status', 'unknown')],
  ['in-progress completion', change(1, 'status', 'inProgress')],
  ...['completed', 'failed', 'cancelled', 'rejected', 'unknown'].map(status => [status + ' null exit', change(1, 'status', status)]),
  ...[0, -1, '0'].map(exit => ['declined exit ' + JSON.stringify(exit), change(1, 'exitCode', exit)]),
  ...['', 'process', 42].map(pid => ['declined process ' + JSON.stringify(pid), change(1, 'processId', pid)]),
  ['started process', change(0, 'processId', 'process')],
  ['started exit', change(0, 'exitCode', 0)],
  ['missing start process', omit(0, 'processId')],
  ['missing final process', omit(1, 'processId')],
  ['missing start exit', omit(0, 'exitCode')],
  ['missing final exit', omit(1, 'exitCode')],
  ['start output', change(0, 'aggregatedOutput', 'ran')],
  ['final output', change(1, 'aggregatedOutput', 'ran')],
  ['malformed output', change(1, 'aggregatedOutput', {})],
  ['changed command', change(1, 'command', 'other')],
  ['changed cwd', change(1, 'cwd', '/other')],
  ['changed item', change(1, 'id', 'other')],
  ['blank item', change(1, 'id', '')],
  ['blank command', events => { for (const event of events) event.params.item.command = ''; }],
  ['blank cwd', events => { for (const event of events) event.params.item.cwd = ''; }],
  ['changed turn', events => { events[1].params.turnId = 'other'; }],
  ['unknown turn', events => { for (const event of events) event.params.turnId = 'unknown'; }],
  ['foreign thread', events => { for (const event of events) event.params.threadId = 'foreign'; }],
  ['changed thread', events => { events[1].params.threadId = 'foreign'; }],
  ['missing thread', events => { for (const event of events) delete event.params.threadId; }],
  ['blank turn', events => { for (const event of events) event.params.turnId = ''; }],
];

function fixture(events, replay, turnThread = 'thread') {
  const ledger = commandReceipts(path.join(root, `${++sequence}.jsonl`), identity);
  const items = new Map();
  if (replay) ledger.append('turn/started', { threadId: turnThread, turnId: 'turn', status: 'inProgress' });
  else ledger.observe({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn', status: 'inProgress' } } }, 'thread');
  for (const event of events) {
    if (!replay) ledger.observe(event, 'thread');
    const { item, ...p } = event.params;
    if (item) {
      const data = { itemId: item.id, threadId: p.threadId ?? null, turnId: p.turnId ?? null,
        processId: item.processId, command: item.command, cwd: item.cwd, status: item.status,
        exitCode: item.exitCode, aggregatedOutput: item.aggregatedOutput ?? null,
        completed: event.method === 'item/completed', ...event.receiptOverride };
      items.set(item.id, data);
      if (replay) ledger.append(event.receiptKind ?? event.method, data);
    } else if (replay) ledger.append(event.method, p);
  }
  if (!replay) return !ledger.snapshot().error && ledger.snapshot().pending.length === 0
    && ledger.snapshot().commands.length === 1;
  ledger.append('turn/completed', { threadId: 'thread', turnId: 'turn', status: 'completed' });
  const deadlineAt = Date.now() + 5000;
  ledger.append('stop/requested', { threadId: 'thread', deadlineAt });
  ledger.append('app-server/close', { code: 0, signal: null });
  ledger.append('stop/confirmed', { ...identity, commands: [...items.values()],
    appClose: { code: 0, signal: null }, deadlineAt, originalToolReceipt: 'not synthesized' });
  return readStopConfirmation(ledger.file, identity).ok;
}
for (const [name, mutate, expected = false] of cases) {
  const events = structuredClone([start, end]); mutate(events);
  for (const replay of [false, true]) check(`declined accounting ${replay ? 'replay' : 'observer'}: ${name}`,
    fixture(events, replay) === expected, `expected terminal=${expected}`);
}
for (const [name, mutate] of [
  ['completed row pretending to start', events => { events[0].receiptKind = 'item/completed'; }],
  ['started row pretending to complete', events => { events[1].receiptKind = 'item/started'; }],
  ['contradictory start flag', events => { events[0].receiptOverride = { completed: true }; }],
  ['truthy completion flag', events => { events[1].receiptOverride = { completed: 1 }; }],
]) {
  const events = structuredClone([start, end]); mutate(events);
  check(`declined accounting replay: ${name}`, !fixture(events, true));
}
for (const thread of ['foreign', null]) check(`declined accounting replay: turn start thread ${thread}`,
  !fixture(structuredClone([start, end]), true, thread));

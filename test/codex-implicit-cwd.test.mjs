import { check } from './check.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandReceipts, readStopConfirmation } from '../lib/codex-command-receipts.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/codex-implicit-cwd-actual.json', import.meta.url)));
const root = mkdtempSync(path.join(os.tmpdir(), 'promptobus-codex-'));
const identity = { format: 1, ref: 'actual-fixture', launchId: 'eb6aaea6-088f-415a-b227-7f05ecac5903',
  holderPid: 1, appPid: 2, rawToolReceipts: true,
  cwd: '/fixture/native-implicit-cwd' };
const threadId = '01a16c64-59e8-7833-9b7c-5ef74a9458cb';
const turnIds = ['01a16c64-5bba-73b2-a7b7-f3bad14aefe9', '01a16c67-dfdf-7db0-9863-46ee602f2017'];
let serial = 0;
function replay(proof = true) {
  const receipts = commandReceipts(path.join(root, `${++serial}.jsonl`), identity);
  if (proof) {
    receipts.context?.('thread/accepted', { launchId: identity.launchId, threadId, cwd: identity.cwd, profile: 'fixed-single-local' });
    for (const turnId of turnIds) receipts.context?.('turn/accepted', { launchId: identity.launchId, threadId, turnId });
  }
  for (const row of fixture.rows) {
    if (row.kind === 'rawResponseItem/completed') receipts.observe(row.notification, threadId);
    else if (row.kind.startsWith('turn/')) receipts.observe({ method: row.kind, params: { threadId,
      turn: { id: row.turnId, status: row.status } } }, threadId);
    else receipts.observe({ method: row.kind, params: { threadId, turnId: row.turnId,
      item: { type: 'commandExecution', id: row.itemId, processId: row.processId,
        command: row.command, cwd: row.cwd, status: row.status, exitCode: row.exitCode } } }, threadId);
  }
  return receipts;
}
const record = { ...identity, threadId };
function confirm(receipts) {
  const deadlineAt = Date.now() + 9000;
  receipts.append('stop/requested', { threadId, deadlineAt });
  receipts.append('app-server/close', { code: 0, signal: null });
  const { commands, rawTools } = receipts.snapshot();
  receipts.append('stop/confirmed', { threadId, launchId: identity.launchId, holderPid: 1, appPid: 2,
    commands, rawTools, appClose: { code: 0, signal: null }, deadlineAt, originalToolReceipt: 'not synthesized' });
  return readStopConfirmation(receipts.file, record);
}
function single(args, { cwd = identity.cwd, proof = true, thread = threadId, turn = turnIds[0], context = {}, custom = false,
  before, after } = {}) {
  const receipts = commandReceipts(path.join(root, `${++serial}.jsonl`), identity);
  if (proof) receipts.context?.('thread/accepted', { launchId: identity.launchId, threadId,
    cwd: identity.cwd, profile: 'fixed-single-local', ...context });
  before?.(receipts);
  const raw = item => receipts.observe({ method: 'rawResponseItem/completed', params: { threadId: thread, turnId: turn, item } }, threadId);
  raw(custom ? { type: 'custom_tool_call', name: 'functions.exec', call_id: 'selected',
    input: `text(await tools.exec_command(${JSON.stringify({ cmd: 'selected', ...args })}));` }
    : { type: 'function_call', name: 'exec_command', call_id: 'selected', arguments: JSON.stringify({ cmd: 'selected', ...args }) });
  raw(custom ? { type: 'custom_tool_call_output', call_id: 'selected',
    output: [{ type: 'input_text', text: '{"output":"","exit_code":0}' }] }
    : { type: 'function_call_output', call_id: 'selected', output: 'Chunk ID: fixture\nProcess exited with code 0\nOutput:\n' });
  receipts.observe({ method: 'item/completed', params: { threadId, turnId: turn, item: {
    type: 'commandExecution', id: 'selected', command: 'selected', cwd, status: 'completed', exitCode: 0 } } }, threadId);
  const pendingBeforeAcceptance = receipts.snapshot().rawTools.pending.length;
  receipts.context?.('turn/accepted', { launchId: identity.launchId, threadId, turnId: turnIds[0] });
  after?.(receipts);
  return { ...receipts.snapshot(), pendingBeforeAcceptance };
}
try {
  const replayed = replay(), actual = replayed.snapshot();
  check('implicit cwd actual14: independently trusted fixed context binds all fourteen original pairs',
    actual.error === null && actual.rawTools.bindings.length === 14 && actual.rawTools.pending.length === 0,
    JSON.stringify({ error: actual.error, bindings: actual.rawTools.bindings.length, pending: actual.rawTools.pending }));
  check('implicit cwd actual14: actual terminal exit1 outcomes remain failures',
    actual.rawTools.bindings.filter(item => item.exitCode === 1).length === 2);
  const unknown = replay(false).snapshot();
  check('implicit cwd actual14: historical receipts without accepted context remain unresolved',
    unknown.rawTools.bindings.length === 0 && unknown.rawTools.pending.length === 28);
  check('implicit cwd replay: accepted context and both accepted turns survive durable revalidation', confirm(replayed).ok);
  check('implicit cwd replay: registry cwd cannot be replaced after launch',
    !readStopConfirmation(replayed.file, { ...record, cwd: '/foreign' }).ok);
  const original = readFileSync(replayed.file, 'utf8');
  const withoutTurn = original.trim().split('\n').map(JSON.parse)
    .filter(row => !(row.kind === 'execution-context/turn/accepted' && row.turnId === turnIds[0]));
  writeFileSync(replayed.file, withoutTurn.map((row, i) => JSON.stringify({ ...row, sequence: i + 1 })).join('\n') + '\n');
  check('implicit cwd replay: deleting first-turn proof cannot reuse final-turn context or final snapshot',
    !readStopConfirmation(replayed.file, record).ok);
  writeFileSync(replayed.file, original);
  for (const [name, args] of [['missing', {}], ['null', { workdir: null }], ['empty', { workdir: '' }],
    ['null environment', { environment_id: null }]]) {
    const value = single(args);
    check(`implicit cwd ${name}: raw before turn ACK binds only after actual accepted ID`,
      value.pendingBeforeAcceptance === 2 && value.rawTools.bindings.length === 1
      && value.rawTools.pending.length === 0 && value.rawTools.bindings[0].cwdSource === 'accepted-fixed-context');
  }
  for (const [name, args, options] of [
    ['no accepted default', {}, { proof: false }],
    ['foreign default', {}, { cwd: '/foreign' }],
    ['foreign launch', {}, { context: { launchId: 'foreign' } }],
    ['missing launch', {}, { context: { launchId: null } }],
    ['foreign context thread', {}, { context: { threadId: 'foreign' } }],
    ['foreign raw thread', {}, { thread: 'foreign' }],
    ['unknown turn', {}, { turn: 'unknown' }],
    ['explicit mismatch', { workdir: '/foreign' }, {}],
    ['whitespace', { workdir: ' ' }, {}],
    ['relative', { workdir: 'relative' }, { cwd: 'relative' }],
    ['URI', { workdir: 'file:///owned' }, { cwd: 'file:///owned' }],
    ['malformed', { workdir: 5 }, {}],
    ['empty environment ID', { environment_id: '' }, {}],
    ['foreign environment ID', { environment_id: 'foreign' }, {}],
    ['explicit foreign environment', { workdir: identity.cwd, environment_id: 'foreign' }, {}],
  ]) {
    const value = single(args, options);
    check(`implicit cwd negative: ${name} cannot borrow lifecycle cwd`,
      value.rawTools.bindings.length === 0 && value.rawTools.pending.length > 0);
  }
  const explicit = single({ workdir: '/explicit' }, { cwd: '/explicit' });
  check('implicit cwd explicit: independently supplied absolute path stays strict and needs no default',
    explicit.rawTools.bindings.length === 1 && !explicit.rawTools.bindings[0].cwdSource
      && single({ workdir: '/explicit' }, { cwd: '/explicit', proof: false }).rawTools.bindings.length === 1);
  const invalidated = single({}, { before: receipts => receipts.context?.('invalidated', { launchId: identity.launchId, threadId }) });
  check('implicit cwd invalidation: later implicit commands cannot reuse accepted thread proof', invalidated.rawTools.bindings.length === 0);
  const lateInvalidation = single({}, { after: receipts => {
    receipts.context?.('invalidated', { launchId: identity.launchId, threadId });
    receipts.context?.('thread/accepted', { launchId: identity.launchId, threadId, cwd: identity.cwd, profile: 'fixed-single-local' });
  } });
  check('implicit cwd invalidation: context cannot be re-established within a mutable launch', lateInvalidation.rawTools.bindings.length === 0);
  const lateThread = single({}, { proof: false, after: receipts => {
    receipts.context?.('thread/accepted', { launchId: identity.launchId, threadId, cwd: identity.cwd, profile: 'fixed-single-local' });
    receipts.context?.('turn/accepted', { launchId: identity.launchId, threadId, turnId: turnIds[0] });
  } });
  check('implicit cwd ordering: late default proof cannot backfill an earlier original call', lateThread.rawTools.bindings.length === 0);
  const carrier = single({}, { custom: true });
  check('implicit cwd code carrier: accepted default cannot invent a nested child identity edge',
    carrier.rawTools.calls[0]?.type === 'custom_tool_call' && carrier.rawTools.bindings.length === 0 && carrier.rawTools.pending.length > 0);
} finally { rmSync(root, { recursive: true, force: true }); }

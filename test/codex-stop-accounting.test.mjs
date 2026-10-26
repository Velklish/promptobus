import { check } from './check.mjs';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { makeSandbox, makeSockDir } from './sandbox.mjs';
import { commandReceipts } from '../lib/codex-command-receipts.js';
import { codexDriver } from '../lib/driver-codex.js';
import { readSession, writeSession, dropSession } from '../lib/codex-session.js';

const root = makeSandbox('promptobus-stop-accounting-');
const file = path.join(root, 'retained', 'launch.jsonl');
const ledger = commandReceipts(file, { ref: 'fixture', launchId: 'launch' });
const event = (method, item) => ({ method, params: { threadId: 'owned', turnId: 'turn', item } });
const item = { type: 'commandExecution', id: 'cmd', command: 'fixture', cwd: root, status: 'inProgress', exitCode: null };
ledger.observe(event('item/started', item), 'owned');
ledger.observe(event('item/completed', { ...item, exitCode: 0, status: 'completed' }), 'foreign');
check('command ledger: foreign thread cannot terminalize owned work', ledger.snapshot().pending.length === 1);
for (const exitCode of [null, -1]) {
  ledger.observe(event('item/completed', { ...item, exitCode, status: 'failed' }), 'owned');
  check(`command ledger: exit ${exitCode} remains unresolved`, ledger.snapshot().pending[0] === 'cmd');
}
ledger.observe(event('item/completed', { ...item, exitCode: 9, status: 'failed', aggregatedOutput: 'actual output' }), 'owned');
check('command ledger: a genuine nonzero outcome remains factual and terminal',
  ledger.snapshot().pending.length === 0 && ledger.snapshot().commands[0].exitCode === 9);
const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
check('command ledger: durable rows preserve launch, order, and selected output',
  rows[0].launchId === 'launch' && rows.every((r, i) => r.sequence === i + 1)
    && rows.at(-1).aggregatedOutput === 'actual output');
const duplicate = commandReceipts(file, { ref: 'other' });
check('command ledger: a second writer cannot reuse the launch receipt',
  /EEXIST/.test(duplicate.snapshot().error) && readFileSync(file, 'utf8').trim().split('\n').length === rows.length);
ledger.observe({ method: 'item/commandExecution/outputDelta', params: { threadId: 'owned', itemId: 'cmd', delta: 'late' } }, 'owned');
check('command ledger: output after completion invalidates complete accounting', !!ledger.snapshot().error);
const malformed = commandReceipts(path.join(root, 'malformed.jsonl'), {});
malformed.observe(event('item/started', { ...item, id: null }), 'owned');
check('command ledger: malformed command identity cannot be forgotten', !!malformed.snapshot().error);
const blocked = path.join(root, 'blocked'); mkdirSync(blocked);
const unwritable = commandReceipts(blocked, {});
check('command ledger: persistence refusal remains latched', !!unwritable.snapshot().error && !unwritable.append('stop/confirmed', {}));
const brokenTurn = commandReceipts(path.join(root, 'bad-turn.jsonl'), {});
brokenTurn.observe({ method: 'turn/completed', params: { status: 'completed' } }, 'owned');
check('command ledger: a missing terminal turn identity cannot certify Stop', !!brokenTurn.snapshot().error);

const oldHome = process.env.PROMPTOBUS_CODEX_HOME;
process.env.PROMPTOBUS_CODEX_HOME = path.join(root, 'registry');
const calls = [];
const originalKill = process.kill;
const ref = 'stop-boundary';
const home = path.join(root, 'participant-home'); mkdirSync(home);
writeFileSync(path.join(home, 'retained-rollout'), 'must survive unknown Stop');
const base = { ref, launchId: 'owned-launch', codexHome: home, state: 'alive', holderPid: process.pid };
const socket = makeSockDir('pb-stop-account-').sock('holder');
let answer = { ok: true, stopped: true, launchId: 'foreign-launch' };
let mutate = () => {};
const server = net.createServer(conn => conn.once('data', bytes => {
  const request = JSON.parse(String(bytes)); calls.push(request);
  mutate(); conn.end(JSON.stringify({ id: request.id, result: answer }) + '\n');
}));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
try {
  writeSession({ ...base, launchId: null });
  let result = await codexDriver.stop(ref, { timeoutMs: 100 });
  check('driver Stop: a legacy/unknown launch is unresolved without a request',
    !result.ok && result.attempted && !result.stopped && calls.length === 0 && !!readSession(ref));
  writeSession({ ...base, rpcSocket: socket });
  result = await codexDriver.stop(ref, { timeoutMs: 100 });
  check('driver Stop: matching transport with a foreign launch reply cannot retire the record',
    !result.ok && readSession(ref)?.launchId === base.launchId && calls.at(-1).launchId === base.launchId);
  answer = { ok: false, stopped: false, note: 'unknown command exit' };
  result = await codexDriver.stop(ref, { timeoutMs: 100 });
  check('driver Stop: explicit unresolved response preserves home and rollout',
    !result.ok && !result.stopped && readFileSync(path.join(home, 'retained-rollout'), 'utf8') === 'must survive unknown Stop');
  answer = { ok: true, stopped: true, launchId: base.launchId };
  const pid = 987654321;
  const signals = [];
  process.kill = (target, signal) => {
    signals.push([target, signal]);
    if (target === pid) throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    return originalKill.call(process, target, signal);
  };
  writeSession({ ...base, rpcSocket: socket, holderPid: pid, stopConfirmed: true });
  result = await codexDriver.stop(ref, { timeoutMs: 80 });
  check('driver Stop: EPERM process observation is not physical death or signal authority',
    !result.ok && !!readSession(ref) && signals.length > 0 && signals.every(([, signal]) => signal === 0));
  process.kill = originalKill;
  writeSession({ ...base, rpcSocket: socket, holderPid: null, stopConfirmed: false });
  result = await codexDriver.stop(ref, { timeoutMs: 100 });
  check('driver Stop: absent/reused holder PID alone cannot replace durable finalization', !result.ok && !!readSession(ref));
  mutate = () => writeSession({ ...base, rpcSocket: socket, holderPid: null, launchId: 'replacement', stopConfirmed: true });
  result = await codexDriver.stop(ref, { timeoutMs: 100 });
  check('driver Stop: replacement launch survives the retirement race', !result.ok && readSession(ref)?.launchId === 'replacement');
  mutate = () => {};
  dropSession(ref);
  result = await codexDriver.stop(ref, { timeoutMs: 100 });
  check('driver Stop: repeated absent Stop is a scoped no-op', result.ok && !result.stopped && !result.attempted);
} finally {
  process.kill = originalKill;
  dropSession(ref);
  await new Promise(resolve => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.PROMPTOBUS_CODEX_HOME;
  else process.env.PROMPTOBUS_CODEX_HOME = oldHome;
}

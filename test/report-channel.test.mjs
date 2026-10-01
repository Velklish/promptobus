import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { capture } from './console.mjs';
import { hostOf } from '../lib/host.js';
import { closeTask, createTask, participantRecord, upsertParticipant } from '../lib/store.js';
import { socketPath, writeSession } from '../lib/codex-session.js';
import * as reporting from '../lib/report.js';

const root = makeSandbox('promptobus-report-channel-');
const home = path.join(root, '.promptobus');
process.env.PROMPTOBUS_CODEX_HOME = path.join(root, 'registry');
writeHostConfig(root, { tools: ['codex'] });
const host = hostOf(root);
const task = 'report-channel-t20261001-000000';
const ref = 'Reporter: channel fixture';
createTask(home, { id: task, title: 'Report channel', owner: 'owner' });
const participant = participantRecord('reporter', {
  harness: 'codex', mode: 'managed', sessionRef: ref, sessionId: 'native-thread',
});
upsertParticipant(home, task, participant);
const socket = socketPath(ref);
const record = { ref, role: 'reporter', address: 'reporter', home, task,
  threadId: 'native-thread', rpcSocket: socket, holderPid: process.pid, state: 'alive' };
writeSession(record);
let calls = [];
let reads = 0;
let failed = false;
let empty = false;
let noTurnId = false;
const server = net.createServer((connection) => {
  let buffer = '';
  connection.on('data', (chunk) => {
    buffer += chunk;
    if (!buffer.includes('\n')) return;
    const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
    calls.push(request);
    let result;
    if (request.method === 'turn/start') result = { turn: { id: noTurnId ? null : 'question-turn', status: 'inProgress' } };
    else if (request.method === 'thread/read') {
      reads++;
      result = { thread: { id: 'native-thread', turns: [
        { id: 'older-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'STALE_REPLY' }] },
        { id: 'question-turn', status: failed ? 'failed' : reads === 1 ? 'inProgress' : 'completed',
          error: failed ? { message: 'model failed' } : null,
          items: empty ? [] : [{ type: 'agentMessage', text: 'Answer from source message msg-42.' }] },
      ] } };
    } else throw new Error(`unexpected holder method: ${request.method}`);
    connection.end(JSON.stringify({ id: request.id, result }) + '\n');
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
test.after(() => new Promise((resolve) => server.close(resolve)));

test('a human question reaches the existing reporter and prints only its completed turn', async () => {
  assert.equal(typeof reporting.reportQuestion, 'function', 'report must expose a follow-up channel');
  let answer;
  const output = await capture(async () => { answer = await reporting.reportQuestion(host, { task, question: 'What changed?' }); });
  assert.deepEqual(answer, { threadId: 'native-thread', turnId: 'question-turn', text: 'Answer from source message msg-42.' });
  assert.match(output, /Answer from source message msg-42\./);
  assert.doesNotMatch(output, /STALE_REPLY/);
  assert.equal(reads, 2);
  assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1);
  assert.deepEqual(calls[0].params, { threadId: 'native-thread', input: [{ type: 'text', text: 'What changed?' }] });
  assert(calls.every((call) => call.op === 'rpc' && ['turn/start', 'thread/read'].includes(call.method)));
});

test('a failed reporter turn surfaces its error instead of an older answer', async () => {
  failed = true;
  try { await assert.rejects(reporting.reportQuestion(host, { task, question: 'Next question' }), /model failed/); }
  finally { failed = false; }
});

test('empty questions and launch flags are refused before contacting the holder', async () => {
  const before = calls.length;
  await assert.rejects(reporting.reportQuestion(host, { task, question: '  ' }), /non-empty/);
  await assert.rejects(reporting.reportQuestion(host, { task, question: 'Question', model: 'other' }), /launch flags/);
  assert.equal(calls.length, before);
});

test('a missing turn id or empty completed reply cannot silently succeed', async () => {
  noTurnId = true;
  try { await assert.rejects(reporting.reportQuestion(host, { task, question: 'Question' }), /turn id/); }
  finally { noTurnId = false; }
  empty = true;
  try { await assert.rejects(reporting.reportQuestion(host, { task, question: 'Question' }), /without an answer/); }
  finally { empty = false; }
});

test('a stale or cross-task registry record cannot receive this reporter question', async () => {
  const before = calls.length;
  for (const patch of [{ role: 'worker' }, { task: 'another-task' }, { home: root }, { threadId: 'other-thread' }, { state: 'dead' }, { holderPid: null }]) {
    writeSession({ ...record, ...patch });
    await assert.rejects(reporting.reportQuestion(host, { task, question: 'Question' }), /reporter|session/);
  }
  writeSession(record);
  assert.equal(calls.length, before);
});

test('question mode refuses a missing reporter, another harness, a child and a closed task', async () => {
  const missing = 'report-missing-t20261001-000000';
  createTask(home, { id: missing, owner: 'owner' });
  await assert.rejects(reporting.reportQuestion(host, { task: missing, question: 'Question' }), /reporter/);
  upsertParticipant(home, task, { ...participant, harness: 'claude' });
  await assert.rejects(reporting.reportQuestion(host, { task, question: 'Question' }), /Codex/);
  upsertParticipant(home, task, participant);
  const child = 'report-child-t20261001-000000';
  createTask(home, { id: child, owner: 'child-owner', parent: task, teamlead: 'teamlead:one' });
  await assert.rejects(reporting.reportQuestion(host, { task: child, question: 'Question' }), /root task/);
  closeTask(home, missing);
  await assert.rejects(reporting.reportQuestion(host, { task: missing, question: 'Question' }), /closed/);
});

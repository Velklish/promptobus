import './home.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { busConnection } = await import('../lib/server.js');
const { bus, createTask, participantRecord, readWake, taskOwner, upsertParticipant, wakeFile, writeWake } = await import('../lib/store.js');
const { bindSharedWarden } = await import('../lib/warden.js');

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'promptobus-mcp-'));
  const cwd = realpathSync(dir);
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const home = path.join(cwd, 'bus');
  const host = { version: '0.33.1', busCommand: (args) => args.join(' ') };
  const demands = [];
  t.after(bindSharedWarden((demandHome, task) => demands.push([demandHome, task])));
  bus(home, { cli: host.version });
  const connect = (task, role, env) => busConnection(host, {
    PROMPTOBUS_HOME: home, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: role, CODEX_HOME: path.join(cwd, 'codex'), ...env,
  }, cwd);
  return { home, cwd, demands, connect };
}

const initialize = (connection) => connection.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
const call = (connection, name, args) => connection.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name, arguments: args } }).result;
const inspect = (connection, task) => {
  const reply = call(connection, 'promptobus_task', { task });
  assert.equal(reply?.isError, undefined);
  assert.match(reply?.content[0]?.text, /^task /);
};

test('ordinary joins hand off to the real store for a worker, owner, ownerless task and teamlead alias', (t) => {
  const { home, cwd, demands, connect } = fixture(t);
  const root = 't20261119-090000', child = 't20261119-090001', ownerless = 't20261119-090002';
  createTask(home, { id: root, owner: 'fixture-owner' });
  createTask(home, { id: child, parent: root, teamlead: 'teamlead:fixture', owner: 'fixture-lead' });
  createTask(home, { id: ownerless, owner: null });
  upsertParticipant(home, root, participantRecord('worker:fixture', { sessionId: 'fixture-worker', harness: 'claude' }));

  function join(task, role, session, targetTask = task, targetRole = role) {
    const socket = path.join(cwd, `${session}.sock`);
    const env = {
      CLAUDE_CODE_SESSION_ID: session, CLAUDE_CODE_MESSAGING_SOCKET: socket,
    };
    assert.equal(readWake(home, targetTask, targetRole), null);
    const reply = initialize(connect(task, role, env));
    assert.equal(reply.result?.serverInfo?.name, 'promptobus');
    const wake = readWake(home, targetTask, targetRole);
    assert.equal(wake?.socket, socket);
    assert.equal(wake?.session, session);
  }

  join(root, 'worker:fixture', 'fixture-worker');
  join(root, 'orchestrator', 'fixture-owner');
  join(ownerless, 'orchestrator', 'fixture-legacy');
  join(root, 'teamlead:fixture', 'fixture-lead', child, 'orchestrator');
  assert.equal(readWake(home, root, 'teamlead:fixture'), null);
  assert.deepEqual(demands, [root, root, ownerless, root].map(task => [home, task]));
});

test('a refused handoff neither changes contact files nor requests a warden; inspection still runs', (t) => {
  const { home, cwd, demands, connect } = fixture(t);
  const source = 't20261119-100000', target = 't20261119-100001';
  createTask(home, { id: source, owner: 'fixture-owner' });
  createTask(home, { id: target, owner: 'fixture-owner' });
  const worker = 'worker:fixture', codex = 'worker:codex-fixture', claude = 'worker:claude-fixture';
  upsertParticipant(home, source, participantRecord(worker, { sessionId: 'fixture-worker' }));
  const connection = connect(source, worker, { CLAUDE_CODE_SESSION_ID: 'fixture-worker', CLAUDE_CODE_MESSAGING_SOCKET: path.join(cwd, 'new.sock') });
  const absent = wakeFile(home, target, worker);
  assert.equal(existsSync(absent), false);
  inspect(connection, target);
  assert.equal(existsSync(absent), false);
  assert.deepEqual(demands, []);

  upsertParticipant(home, target, participantRecord(worker, { sessionId: 'fixture-holder' }));
  writeWake(home, target, worker, { socket: path.join(cwd, 'old.sock'), session: 'fixture-holder' });
  const existing = readFileSync(absent);
  inspect(connection, target);
  assert.deepEqual(readFileSync(absent), existing);
  assert.deepEqual(demands, []);

  upsertParticipant(home, target, participantRecord(codex, { harness: 'codex', sessionId: 'fixture-thread' }));
  const recordFile = path.join(cwd, 'codex.json');
  const record = { home, task: target, address: codex, rpcSocket: path.join(cwd, 'codex.sock'), threadId: 'fixture-thread' };
  const codexEnv = { CODEX_THREAD_ID: record.threadId, PROMPTOBUS_CODEX_SESSION: recordFile };
  const codexWake = wakeFile(home, target, codex);
  writeWake(home, target, codex, { socket: path.join(cwd, 'previous-codex.sock'), session: record.threadId });
  const previous = readFileSync(codexWake);
  for (const change of [{ task: source }, { threadId: 'different-thread' }, { threadId: undefined }]) {
    writeFileSync(recordFile, JSON.stringify({ ...record, ...change }));
    inspect(connect(target, codex, codexEnv), target);
    assert.deepEqual(readFileSync(codexWake), previous);
    assert.deepEqual(demands, []);
  }
  writeFileSync(recordFile, JSON.stringify(record));
  initialize(connect(target, codex, codexEnv));
  assert.equal(readWake(home, target, codex)?.socket, `${record.rpcSocket}#0`);
  assert.equal(readWake(home, target, codex)?.session, record.threadId);
  assert.deepEqual(demands, [[home, target]]);

  const handshake = path.join(cwd, 'claude.json');
  upsertParticipant(home, target, participantRecord(claude, { sessionId: 'fixture-claude', sessionRecord: handshake }));
  const binding = JSON.stringify({ home, task: target, address: claude, sessionId: 'fixture-other-claude' });
  writeFileSync(handshake, binding);
  initialize(connect(target, claude, { CLAUDE_CODE_SESSION_ID: 'fixture-claude', PROMPTOBUS_CLAUDE_SESSION: handshake,
    CLAUDE_CODE_MESSAGING_SOCKET: path.join(cwd, 'claude.sock') }));
  assert.equal(existsSync(wakeFile(home, target, claude)), false);
  assert.equal(readFileSync(handshake, 'utf8'), binding);
  assert.deepEqual(demands, [[home, target]]);
});

test('an OpenCode record must name the session proven through its scoped pointer', (t) => {
  const { home, cwd, demands, connect } = fixture(t);
  const task = 't20261119-120000', address = 'worker:opencode-fixture';
  createTask(home, { id: task, owner: 'fixture-owner' });
  const file = path.join(cwd, 'opencode.json');
  upsertParticipant(home, task, participantRecord(address, { harness: 'opencode', sessionRecord: file }));
  const env = { PROMPTOBUS_OPENCODE_SESSION: file };
  writeFileSync(file, JSON.stringify({ home, task, address }));
  inspect(connect(task, address, env), task);
  assert.equal(existsSync(wakeFile(home, task, address)), false);
  assert.deepEqual(demands, []);

  writeFileSync(file, JSON.stringify({ home, task, address, sessionId: 'fixture-opencode-session' }));
  initialize(connect(task, address, env));
  assert.equal(readWake(home, task, address)?.socket, file);
  assert.equal(readWake(home, task, address)?.session, 'fixture-opencode-session');
  assert.deepEqual(demands, [[home, task]]);
});

test('claim does not hand off the contact point until the new owner is recorded', (t) => {
  const { home, cwd, demands, connect } = fixture(t);
  const task = 't20261119-130000';
  createTask(home, { id: task, owner: 'fixture-owner' });
  writeWake(home, task, 'orchestrator', { socket: path.join(cwd, 'old.sock'), session: 'fixture-owner' });
  const file = wakeFile(home, task, 'orchestrator'), previous = readFileSync(file);
  const socket = path.join(cwd, 'new.sock');
  const connection = connect(task, 'orchestrator', { CLAUDE_CODE_SESSION_ID: 'fixture-heir', CLAUDE_CODE_MESSAGING_SOCKET: socket });
  initialize(connection);
  assert.deepEqual(readFileSync(file), previous);
  assert.deepEqual(demands, []);
  assert.equal(taskOwner(home, task), 'fixture-owner');

  const reply = call(connection, 'promptobus_mailbox', { task, claim: true });
  assert.match(reply?.content[0]?.text, /bound to this session fixture-heir/);
  assert.equal(taskOwner(home, task), 'fixture-heir');
  assert.equal(readWake(home, task, 'orchestrator')?.socket, socket);
  assert.equal(readWake(home, task, 'orchestrator')?.session, 'fixture-heir');
  assert.deepEqual(demands, [[home, task]]);
});

test('an authorized Cursor join has no contact write but requests a warden', (t) => {
  const { home, cwd, demands, connect } = fixture(t);
  const task = 't20261119-110000', address = 'worker:cursor-fixture', session = 'fixture-chat';
  createTask(home, { id: task, owner: 'fixture-owner' });
  upsertParticipant(home, task, participantRecord(address, { harness: 'cursor', sessionId: session }));
  const file = path.join(cwd, 'cursor.json');
  const record = JSON.stringify({ home, task, address, chatId: session, ref: 'fixture', turns: 3 });
  writeFileSync(file, record);
  initialize(connect(task, address, { PROMPTOBUS_CURSOR_SESSION: file }));
  assert.equal(existsSync(wakeFile(home, task, address)), false);
  assert.equal(readFileSync(file, 'utf8'), record);
  assert.deepEqual(demands, [[home, task]]);
});

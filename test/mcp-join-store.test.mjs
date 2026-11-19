import './home.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { busConnection } = await import('../lib/server.js');
const { bus, createTask, participantRecord, readWake, upsertParticipant } = await import('../lib/store.js');

test('ordinary joins hand off to the real store for a worker, owner, ownerless task and teamlead alias', (t) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'promptobus-join-store-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const home = path.join(cwd, 'bus');
  const host = { version: '0.33.1', busCommand: (args) => args.join(' ') };
  const root = 't20261119-090000', child = 't20261119-090001', ownerless = 't20261119-090002';
  bus(home, { cli: host.version });
  createTask(home, { id: root, owner: 'fixture-owner' });
  createTask(home, { id: child, parent: root, teamlead: 'teamlead:fixture', owner: 'fixture-lead' });
  createTask(home, { id: ownerless, owner: null });
  upsertParticipant(home, root, participantRecord('worker:fixture', { sessionId: 'fixture-worker', harness: 'claude' }));

  function join(task, role, session, targetTask = task, targetRole = role) {
    const socket = path.join(cwd, `${session}.sock`);
    const env = {
      PROMPTOBUS_HOME: home, PROMPTOBUS_TASK: task, PROMPTOBUS_ROLE: role, PROMPTOBUS_WARDEN: 'off',
      CLAUDE_CODE_SESSION_ID: session, CLAUDE_CODE_MESSAGING_SOCKET: socket,
    };
    assert.equal(readWake(home, targetTask, targetRole), null);
    const connection = busConnection(host, env, cwd);
    const reply = connection.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
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
});

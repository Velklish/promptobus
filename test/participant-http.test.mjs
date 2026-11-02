import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { makeSandbox } from './sandbox.mjs';
import { shellQuote } from '../dist/fs/shell.js';
import { openScriptedHttp, scriptedHttpHeaders, scriptedHttpScope } from './participant-http.mjs';

const root = makeSandbox('promptobus-harness-http-');
const scope = { home: path.join(root, "store with space's"), task: 'http-fixture-t20261101-000001', address: 'worker:http' };
const marker = path.join(root, 'session-start.json');
const hookCode = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},input));`;
const command = [process.execPath, '-e', hookCode, '--', '--home', scope.home, '--task', scope.task, '--role', scope.address]
  .map(shellQuote).join(' ');
const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } };

test('script coordinates come from configured hook arguments, including shell-quoted paths', () => {
  assert.deepEqual(scriptedHttpScope(settings), scope);
});

test('missing or conflicting SessionStart script coordinates fail closed', () => {
  assert.throws(() => scriptedHttpScope({}), /configured SessionStart hook/);
  const conflict = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command },
    { type: 'command', command: command + ' --role worker:foreign' }] }] } };
  assert.throws(() => scriptedHttpScope(conflict), /ambiguous/);
});

test('HTTP header references use only the supplied session environment without changing config', () => {
  const config = { headers: { Authorization: 'Bearer ${TOKEN}', 'X-Literal': 'literal' }, env: { TOKEN: 'fresh-caller-value' } };
  const before = JSON.stringify(config);
  const result = scriptedHttpHeaders(config, { TOKEN: 'stale-daemon-value' });
  assert.ok(result.Authorization === 'Bearer stale-daemon-value');
  assert.equal(result['X-Literal'], 'literal');
  assert.equal(JSON.stringify(config), before);
  assert.throws(() => scriptedHttpHeaders(config, {}), /unresolved/);
  assert.ok(scriptedHttpHeaders(config, { TOKEN: '' }).Authorization === 'Bearer ');
});

test('a different native client reference syntax is never silently accepted as Claude auth', () => {
  assert.throws(() => scriptedHttpHeaders({ headers: { Authorization: 'Bearer ${env:TOKEN}' } }, { TOKEN: 'value' }), /unresolved/);
});

async function endpoint({ foreign = false, expectedToken = randomUUID(), pending = false } = {}) {
  rmSync(marker, { force: true });
  const observed = { methods: [], hookBeforeInitialize: false, nativeId: null, close: false, headerMatch: false };
  const server = http.createServer((request, response) => {
    observed.headerMatch = request.headers.authorization === `Bearer ${expectedToken}`;
    if (!observed.headerMatch) { response.writeHead(401); response.end(); return; }
    if (request.method === 'DELETE') {
      observed.close = request.headers['mcp-session-id'] === 'fixture-session';
      response.writeHead(204); response.end(); return;
    }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body);
      observed.methods.push(message.method);
      if (message.method === 'initialize') {
        observed.hookBeforeInitialize = existsSync(marker);
        if (observed.hookBeforeInitialize) observed.nativeId = JSON.parse(readFileSync(marker, 'utf8')).session_id;
        response.setHeader('mcp-session-id', 'fixture-session');
      }
      if (!('id' in message)) { response.writeHead(202); response.end(); return; }
      if (pending && message.method === 'tools/call') { response.writeHead(403); response.end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'promptobus' } }
        : { content: [{ type: 'text', text: `mailbox empty · PROMPTOBUS_HOME=${scope.home} · task=${scope.task} "fixture" · address=${foreign ? 'worker:foreign' : scope.address}` }] };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { observed, token: expectedToken, url: `http://127.0.0.1:${server.address().port}/mcp/bus`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

test('configured SessionStart precedes real HTTP initialization, scoped tool read and session close', async () => {
  const server = await endpoint();
  let client;
  try {
    client = await openScriptedHttp({ type: 'http', url: server.url, headers: { Authorization: 'Bearer ${TOKEN}' } },
      { settings, cwd: root, env: { ...process.env, TOKEN: server.token }, nativeId: 'actual-native-one' });
    assert.deepEqual(client.scope, scope);
    assert.equal(server.observed.hookBeforeInitialize, true);
    assert.equal(server.observed.nativeId, 'actual-native-one');
    assert.deepEqual(server.observed.methods, ['initialize', 'notifications/initialized', 'tools/call']);
    assert.equal(await client.close(), 204);
    client = null;
    assert.equal(server.observed.close, true);
  } finally { await client?.close(); await server.close(); }
});

test('a missing native hook cannot initialize or read through the scripted client', async () => {
  const server = await endpoint();
  try {
    await assert.rejects(openScriptedHttp({ type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } },
      { settings: {}, cwd: root, env: process.env, nativeId: 'actual-native-missing' }), /SessionStart hook/);
    assert.deepEqual(server.observed.methods, []);
  } finally { await server.close(); }
});

test('a daemon bearer from an earlier background launch is not replaced with config.env', async () => {
  const server = await endpoint();
  try {
    await assert.rejects(openScriptedHttp({ type: 'http', url: server.url,
      headers: { Authorization: 'Bearer ${TOKEN}' }, env: { TOKEN: server.token } },
    { settings, cwd: root, env: { ...process.env, TOKEN: 'old-daemon-credential' }, nativeId: 'actual-native-two' }), /HTTP 401/);
    assert.equal(server.observed.headerMatch, false);
    assert.deepEqual(server.observed.methods, []);
  } finally { await server.close(); }
});

test('an authenticated response for another participant is rejected rather than selecting its script', async () => {
  const server = await endpoint({ foreign: true });
  try {
    await assert.rejects(openScriptedHttp({ type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } },
      { settings, cwd: root, env: process.env, nativeId: 'actual-native-foreign' }), /does not belong/);
    assert.equal(server.observed.close, true);
  } finally { await server.close(); }
});

test('headersHelper runs as configured in the primary cwd and overrides static headers', async () => {
  const server = await endpoint();
  const helper = path.join(root, 'headers.cjs'), receipt = path.join(root, 'helper-receipt.json');
  writeFileSync(helper, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({cwd:process.cwd(),name:process.env.CLAUDE_CODE_MCP_SERVER_NAME,url:process.env.CLAUDE_CODE_MCP_SERVER_URL}));process.stdout.write(JSON.stringify({authorization:'Bearer '+process.env.TOKEN}));`);
  let client;
  try {
    client = await openScriptedHttp({ type: 'http', url: server.url, headers: { Authorization: 'Bearer old-static' },
      headersHelper: `${shellQuote(process.execPath)} ${shellQuote(helper)}` },
    { settings, cwd: root, env: { ...process.env, TOKEN: server.token }, nativeId: 'actual-native-helper' });
    assert.equal(server.observed.headerMatch, true);
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { cwd: realpathSync(root), name: 'promptobus', url: server.url });
  } finally { await client?.close(); await server.close(); }
});

test('HTTP tool denial remains a failure after protocol initialization', async () => {
  const server = await endpoint({ pending: true });
  try {
    await assert.rejects(openScriptedHttp({ type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } },
      { settings, cwd: root, env: process.env, nativeId: 'actual-native-pending' }), /tools\/call: HTTP 403/);
    assert.deepEqual(server.observed.methods, ['initialize', 'notifications/initialized', 'tools/call']);
  } finally { await server.close(); }
});

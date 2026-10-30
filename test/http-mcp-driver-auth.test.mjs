import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { makeSandbox } from './sandbox.mjs';
import { codexMcpName, codexMcpServers } from '../lib/codex-session.js';
import { codexDriver, codexHomeConfig } from '../lib/driver-codex.js';
import { claudeDriver } from '../lib/driver-claude.js';
import { cursorDriver } from '../lib/driver-cursor.js';
import { prepare as prepareOpenCode } from '../lib/driver-opencode.js';
import { parseHomeToml } from './harness-codex.mjs';

const root = makeSandbox('promptobus-driver-http-auth-');
const prefix = 'consumer-';
const auth = Object.freeze({
  type: 'http', url: 'http://127.0.0.1:12345/mcp/bus',
  headers: Object.freeze({ 'X-Static': 'literal-header' }),
  bearer_token_env_var: 'PROMPTOBUS_CLIENT_TOKEN',
  env_http_headers: Object.freeze({ 'X-Client': 'PROMPTOBUS_CLIENT_ID' }),
  disabled_tools: Object.freeze(['write_entry']),
});
const stdio = Object.freeze({ command: 'node', args: Object.freeze(['bus.mjs']), env: Object.freeze({ MODE: 'fixture' }) });
const servers = Object.freeze({ catalog: auth, promptobus: stdio });
const context = {
  ref: 'worker:auth', role: 'worker', prompt: 'inspect', cwd: root, model: 'fixture-model',
  mcp: { servers }, addDirs: [], permissionMode: null,
  mcpConfigPath: path.join(root, 'mcp.json'), settingsPath: path.join(root, 'settings.json'),
  env: { PROMPTOBUS_CODEX_HOME: path.join(root, 'codex-state'), PROMPTOBUS_CURSOR_HOME: path.join(root, 'cursor-state') },
};

test('Codex preserves literal HTTP auth references, headers, namespaces and denied tools', () => {
  const before = JSON.stringify(servers);
  const converted = codexMcpServers(servers, prefix);
  const entry = converted.servers[codexMcpName('catalog', prefix)];
  assert.deepEqual(entry, {
    url: auth.url, http_headers: auth.headers,
    bearer_token_env_var: 'PROMPTOBUS_CLIENT_TOKEN',
    env_http_headers: { 'X-Client': 'PROMPTOBUS_CLIENT_ID' }, disabled_tools: ['write_entry'],
  });
  assert.notStrictEqual(converted.servers, servers);
  assert.notStrictEqual(entry.http_headers, auth.headers);
  assert.notStrictEqual(entry.env_http_headers, auth.env_http_headers);
  assert.deepEqual(converted.servers[codexMcpName('promptobus', prefix)], stdio);
  assert.deepEqual(converted.skipped, []);
  assert.equal(JSON.stringify(servers), before);
  entry.env_http_headers['X-Client'] = 'OTHER_ENV_NAME';
  assert.equal(auth.env_http_headers['X-Client'], 'PROMPTOBUS_CLIENT_ID');
});

test('Codex native streamable_http descriptors retain native header maps', () => {
  const headers = Object.freeze({ Authorization: 'Bearer literal' });
  const entry = codexMcpServers({ native: { ...auth, type: 'streamable_http', headers: undefined, http_headers: headers } }, prefix)
    .servers[codexMcpName('native', prefix)];
  assert.deepEqual(entry.http_headers, headers);
  assert.notStrictEqual(entry.http_headers, headers);
  assert.equal(entry.bearer_token_env_var, auth.bearer_token_env_var);
  assert.deepEqual(entry.env_http_headers, auth.env_http_headers);
});

test('Codex prepare feeds authenticated HTTP entries into private-home TOML', () => {
  const before = JSON.stringify(servers);
  const plan = codexDriver.prepare(context);
  const converted = codexMcpServers(plan.mcpConfig.mcpServers, prefix);
  const text = codexHomeConfig({ servers: converted.servers });
  const tables = parseHomeToml(text).mcp_servers;
  assert.deepEqual(tables[codexMcpName('catalog', prefix)], {
    url: auth.url, http_headers: auth.headers,
    bearer_token_env_var: 'PROMPTOBUS_CLIENT_TOKEN',
    env_http_headers: { 'X-Client': 'PROMPTOBUS_CLIENT_ID' }, disabled_tools: ['write_entry'],
  });
  assert.deepEqual(tables[codexMcpName('promptobus', prefix)], plan.mcpConfig.mcpServers.promptobus);
  assert.equal(JSON.stringify(servers), before);
});

test('OpenCode prepare writes oauth:false and literal HTTP headers without changing stdio', () => {
  const remote = Object.freeze({ url: auth.url, oauth: false, headers: Object.freeze({ Authorization: 'Bearer {env:PROMPTOBUS_CLIENT_TOKEN}' }) });
  const input = Object.freeze({ catalog: remote, promptobus: stdio, automatic: Object.freeze({ url: 'https://example.invalid/mcp' }) });
  const before = JSON.stringify(input);
  const plan = prepareOpenCode({ ...context, permissionMode: 'auto', mcp: { servers: input } });
  const written = JSON.parse(plan.files.find(file => file.path === context.mcpConfigPath).text);
  assert.deepEqual(written.mcp.catalog, { type: 'remote', ...remote });
  assert.deepEqual(written.mcp.promptobus, { type: 'local', command: ['node', 'bus.mjs'], environment: stdio.env });
  assert.deepEqual(written.mcp.automatic, { type: 'remote', url: 'https://example.invalid/mcp' });
  assert.notStrictEqual(plan.mcpConfig.mcp, input);
  assert.equal(JSON.stringify(input), before);
});

test('Claude prepare retains HTTP headersHelper and headers in its written config', () => {
  const remote = Object.freeze({ type: 'http', url: auth.url, headersHelper: '/owned/get-headers', headers: Object.freeze({ 'X-Client': '${PROMPTOBUS_CLIENT_ID}' }) });
  const input = Object.freeze({ promptobus: remote });
  const plan = claudeDriver.prepare({ ...context, model: 'opus', permissionMode: 'auto', mcp: { servers: input } });
  const written = JSON.parse(plan.files.find(file => file.path === context.mcpConfigPath).text);
  assert.equal(written.mcpServers.promptobus.headersHelper, remote.headersHelper);
  assert.deepEqual(written.mcpServers.promptobus.headers, remote.headers);
  assert.notStrictEqual(plan.mcpConfig.mcpServers, input);
  assert.equal(input.promptobus, remote);
});

test('Cursor prepare retains HTTP Authorization references in its written config', () => {
  const remote = Object.freeze({ url: auth.url, headers: Object.freeze({ Authorization: 'Bearer ${env:PROMPTOBUS_CLIENT_TOKEN}' }) });
  const input = Object.freeze({ promptobus: remote });
  const plan = cursorDriver.prepare({ ...context, permissionMode: 'force', mcp: { servers: input } });
  const written = JSON.parse(plan.files.find(file => file.path === path.join(root, '.cursor', 'mcp.json')).text);
  assert.deepEqual(written.mcpServers.promptobus.headers, remote.headers);
  assert.equal(written.mcpServers.promptobus.url, remote.url);
  assert.notStrictEqual(plan.mcpConfig.mcpServers, input);
  assert.equal(input.promptobus, remote);
});

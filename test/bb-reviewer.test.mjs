import './home.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, chmodSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { BB_REVIEWER_PROTOCOL_TOOLS, reviewerProfile, reviewerTools, verifyReviewerProfile, verifyReviewerConfig, openBbReviewer } from '../lib/bb-reviewer.js';

test('BB reviewer always requests read-only execution, never approval escalation', () => {
  const profile = reviewerProfile({ cwd: '/review', model: 'model', effort: 'high', sandbox: 'danger-full-access' });
  assert.equal(profile.sandbox, 'read-only');
  assert.equal(profile.approvalPolicy, 'never');
  assert.equal(profile.config['features.shell_tool'], false);
  assert.equal(profile.config['features.unified_exec'], false);
  assert.equal(profile.config['features.hooks'], false);
  assert.equal(profile.config['features.apps'], false);
  assert.equal(profile.config['features.plugins'], false);
  assert.equal(profile.config['features.remote_plugin'], false);
  assert.equal(profile.model, 'model');
});

test('BB reviewer denies unclassified external tools and built-in execution tools', () => {
  const tools = ['pb_review_read_file', 'shell', 'apply_patch', 'mcp__canonical__write', 'mcp__canonical__read']
    .map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  assert.deepEqual(reviewerTools(tools).map(tool => tool.name), ['pb_review_read_file']);
});

test('BB reviewer admits only declared authenticated bus operations alongside bounded reads', () => {
  const names = [...BB_REVIEWER_PROTOCOL_TOOLS, 'promptobus_bind', 'promptobus_spawn', 'promptobus_send_as', 'shell'];
  const profile = reviewerProfile({ cwd: '/review', model: 'model', tools: names.map(name => ({ name, description: name, inputSchema: { type: 'object' } })) });
  assert.deepEqual(profile.dynamicTools.map(tool => tool.name), BB_REVIEWER_PROTOCOL_TOOLS);
  assert.equal(profile.sandbox, 'read-only');
  assert.equal(profile.approvalPolicy, 'never');
});

test('BB reviewer refusal covers a missing or widened effective sandbox', () => {
  for (const sandbox of [undefined, { type: 'workspaceWrite' }, { type: 'dangerFullAccess' }]) {
    assert.throws(() => verifyReviewerProfile({ model: 'model', sandbox, approvalPolicy: 'never' }, 'model'), /profile mismatch/);
  }
});

test('BB reviewer refuses effective model substitution and approval escalation', () => {
  assert.throws(() => verifyReviewerProfile({ model: 'other', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' }, 'model'), /profile mismatch/);
  assert.throws(() => verifyReviewerProfile({ model: 'model', sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request' }, 'model'), /profile mismatch/);
  assert.doesNotThrow(() => verifyReviewerProfile({ model: 'model', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' }, 'model'));
});

test('BB reviewer refuses actual shell, edit and canonical write requests before dispatch', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-bb-test-'));
  const executable = path.join(directory, 'codex-fake');
  copyFileSync(new URL('./fixtures/bb-reviewer/app-server.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  let calls = 0;
  const session = await openBbReviewer({ directory, executable, model: 'model',
    tools: ['shell', 'apply_patch', 'mcp__canonical__write'].map(name => ({ name, description: name, inputSchema: {} })),
    env: { ...process.env, CODEX_HOME: directory, BB_THREAD_ID: 'parent', PROMPTOBUS_TASK: 'parent' },
    invoke: async () => { calls++; } });
  try {
    const result = await session.request('security/probe', {});
    assert.equal(calls, 0);
    assert.equal(result.denied.length, 3);
    for (const denial of result.denied) assert.equal(denial.error.message, 'Codex reviewer operation denied');
    assert.equal(result.bbParent, null);
    assert.equal(result.busParent, null);
    for (const feature of ['apps', 'plugins', 'remote_plugin', 'shell_tool', 'unified_exec', 'hooks']) {
      const at = result.argv.indexOf(feature);
      assert.ok(at > 0); assert.equal(result.argv[at - 1], '--disable');
    }
  } finally { await session.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('BB reviewer refuses an unverified Codex build before thread creation', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-bb-version-'));
  const executable = path.join(directory, 'codex-fake');
  copyFileSync(new URL('./fixtures/bb-reviewer/app-server.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  try {
    await assert.rejects(openBbReviewer({ directory, executable, model: 'model',
      env: { ...process.env, CODEX_HOME: directory, PB_TEST_CODEX_VERSION: '0.163.0' } }), /requires the verified Codex version/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('BB reviewer reaps a cancelled initial connection', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-bb-abort-'));
  const executable = path.join(directory, 'codex-fake');
  copyFileSync(new URL('./fixtures/bb-reviewer/app-server.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  const abort = new AbortController();
  const opening = openBbReviewer({ directory, executable, model: 'model', signal: abort.signal,
    env: { ...process.env, CODEX_HOME: directory, PB_TEST_HANG: '1' } });
  const timer = setTimeout(() => abort.abort(), 20);
  try { await assert.rejects(opening, /stream is closed/); }
  finally { clearTimeout(timer); rmSync(directory, { recursive: true, force: true }); }
});

test('BB reviewer refuses a missing native executable without hanging cleanup', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-bb-missing-'));
  try {
    await assert.rejects(openBbReviewer({ directory, executable: path.join(directory, 'absent'), model: 'model',
      env: { ...process.env, CODEX_HOME: directory } }), /stream is closed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('BB reviewer rejects startup config that re-enables Apps or injects canonical MCP', () => {
  const requested = reviewerProfile({ cwd: '/review', model: 'model' }).config;
  const config = { features: Object.fromEntries(Object.entries(requested)
    .filter(([key]) => key.startsWith('features.')).map(([key, value]) => [key.slice(9), value])),
    web_search: 'disabled', mcp_servers: {} };
  assert.doesNotThrow(() => verifyReviewerConfig(config));
  for (const unsafe of [undefined, { ...config, features: {} },
    { ...config, features: { ...config.features, apps: true } },
    { ...config, web_search: 'live' }, { ...config, mcp_servers: { canonical: { enabled: true } } }]) {
    assert.throws(() => verifyReviewerConfig(unsafe), /startup restrictions unavailable/);
  }
});

test('BB reviewer refuses canonical MCP injection before native thread start', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-bb-mcp-'));
  const executable = path.join(directory, 'codex-fake');
  copyFileSync(new URL('./fixtures/bb-reviewer/app-server.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  try {
    await assert.rejects(openBbReviewer({ directory, executable, model: 'model',
      env: { ...process.env, CODEX_HOME: directory, PB_TEST_MCP: '1' } }), /startup restrictions unavailable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('closing reviewer RPC discards a late tool response without an unhandled rejection', () => {
  const module = new URL('../lib/codex-rpc.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { PassThrough } from 'node:stream';
    import { setTimeout } from 'node:timers/promises';
    import { CodexRpc } from ${JSON.stringify(module)};
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const rpc = CodexRpc({stdout: incoming, stdin: outgoing});
    let complete;
    rpc.onServerRequest(() => new Promise(resolve => complete = resolve));
    incoming.write(JSON.stringify({id: 'read', method: 'item/tool/call'}) + '\\n');
    rpc.close();
    complete({success: true});
    await setTimeout(20);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('BB reviewer reports unexpected native exit after an acknowledged turn', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'promptobus-review-files-bb-exit-'));
  const executable = path.join(directory, 'codex-fake');
  copyFileSync(new URL('./fixtures/bb-reviewer/app-server.mjs', import.meta.url), executable);
  chmodSync(executable, 0o755);
  let closed;
  const exited = new Promise(resolve => { closed = resolve; });
  const session = await openBbReviewer({ directory, executable, model: 'model',
    env: { ...process.env, CODEX_HOME: directory, PB_TEST_EXIT: '1' },
    notify: message => { if (message.method === 'reviewer/closed') closed(message.params); } });
  try {
    await session.request('turn/start', {});
    const result = await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 1500); timer.unref(); })]);
    assert.equal(result?.code, 17);
  } finally { await session.close(); rmSync(directory, { recursive: true, force: true }); }
});

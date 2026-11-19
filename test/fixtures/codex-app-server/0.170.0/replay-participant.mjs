import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { codexHomeConfig } from '../../../../lib/driver-codex.js';
import { canonicalSkillOverrides, codexMcpServers, threadStartConfig } from '../../../../lib/codex-session.js';
import { CodexRpc } from '../../../../lib/codex-rpc.js';

const bin = realpathSync(process.argv[2]);
const sandbox = ['-p', `(version 1)(allow default)(deny network*)(deny file-read* file-write* (subpath ${JSON.stringify(userInfo().homedir)}))`, bin];
const root = mkdtempSync(path.join(tmpdir(), 'codex-config-'));
const home = path.join(root, 'home');
const mock = path.join(root, 'marker-server.mjs');
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
const skill = (dir, name, description) => write(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`);
const provider = 'model_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\n';

async function profile(role) {
  const outside = role === 'outside';
  const origin = outside ? 'personal' : 'workspace';
  const cwd = path.join(root, role);
  const store = outside ? path.join(home, '.codex') : path.join(cwd, 'private');
  const canonical = path.join(role === 'worker' ? path.join(cwd, '.codex') : store, 'skills');
  mkdirSync(cwd, { recursive: true });
  if (!outside) skill(canonical, 'collision', 'canonical collision');
  const options = { cwd, env: { HOME: home, CODEX_HOME: store, TMPDIR: root, PATH: '/usr/bin:/bin:/opt/homebrew/bin' } };
  const { servers } = codexMcpServers({ probe: { command: process.execPath, args: [mock], env: { ORIGIN: origin },
    ...(role === 'reviewer' ? { disabled_tools: ['write_tool'] } : {}) } }, 'promptobus-');
  const file = path.join(store, 'config.toml');
  if (role === 'worker') {
    const input = codexHomeConfig({ trusted: [cwd], untrusted: [home], hooksEnabled: false, rawToolReceipts: true,
      servers: { ...servers, http: { url: 'http://127.0.0.1:1', bearer_token_env_var: 'TOKEN', http_headers: { Example: 'fixed' },
        env_http_headers: { Dynamic: 'HEADER' }, disabled_tools: ['write_tool'] } } });
    for (const [key, from, to, error] of [
      ['valid', '', '', null], ['stdio', 'command =', 'renamed_command =', /invalid transport/],
      ['apps', 'apps = false', 'apps = 34', /expected a boolean/], ['hooks', 'hooks = false', 'hooks = 34', /expected a boolean/],
      ['namespaces', '["functions"]', '34', /features.code_mode/], ['disabled', '["write_tool"]', '34', /disabled_tools/],
      ['trust', '"trusted"', '"typo"', /unknown variant/], ['unknown', 'apps = false', 'unknown_probe = false', null],
    ]) {
      assert.ok(input.includes(from), key);
      write(file, input.replace(from, to));
      const r = spawnSync('/usr/bin/sandbox-exec', [...sandbox, 'mcp', 'list', '--json'], { ...options, encoding: 'utf8', timeout: 15000 });
      assert.equal(r.status, error ? 1 : 0, `${key}: ${r.error ?? r.stderr}`);
      if (error) assert.match(r.stderr, error);
      else {
        const transports = Object.fromEntries(JSON.parse(r.stdout).map(s => [s.name, s.transport]));
        for (const [name, expected] of Object.entries({ ...servers, http: { url: 'http://127.0.0.1:1',
          bearer_token_env_var: 'TOKEN', http_headers: { Example: 'fixed' }, env_http_headers: { Dynamic: 'HEADER' } } })) {
          for (const [field, value] of Object.entries(expected)) assert.deepEqual(transports[name][field], value, field);
        }
      }
      console.log(`parser ${key}: exit ${r.status}`);
    }
  }
  if (!outside || !existsSync(file)) write(file, provider + codexHomeConfig({ servers, trusted: [cwd] }));
  const child = spawn('/usr/bin/sandbox-exec', [...sandbox, 'app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'], options);
  const closed = once(child, 'close');
  child.stderr.resume();
  const rpc = CodexRpc(child);
  const request = async (method, params) => {
    const r = await rpc.request(method, params, 12000);
    assert.ok(!r.error, `${method}: ${JSON.stringify(r.error)}`);
    return r.result;
  };
  try {
    await request('initialize', { clientInfo: { name: 'probe', version: '1' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const listed = await request('skills/list', { cwds: [cwd], forceReload: true });
    const labels = listed.data.flatMap(d => d.skills).filter(s => ['collision', 'unrelated'].includes(s.name)).map(s => s.description).sort();
    assert.deepEqual(labels, [...(outside ? [] : ['canonical collision']), 'personal collision', 'personal unrelated']);
    const config = outside ? {} : threadStartConfig({ role, effort: 'high' });
    if (!outside) {
      config['skills.config'] = canonicalSkillOverrides(listed, canonical);
      assert.deepEqual(config['skills.config'], [{ path: realpathSync(path.join(home, '.agents/skills/collision/SKILL.md')), enabled: false }]);
    }
    const t = await request('thread/start', { cwd, ephemeral: true, approvalPolicy: 'never', config,
      model: role === 'worker' ? 'gpt-6-astra' : 'gpt-6-sol', sandbox: role === 'worker' ? 'workspace-write' : 'read-only' });
    if (!outside) assert.equal(t.reasoningEffort, 'high');
    const threadId = t.thread.id;
    const { data, nextCursor } = await request('mcpServerStatus/list', { threadId, detail: 'full' });
    assert.equal(nextCursor, null);
    assert.deepEqual(data.map(s => [s.name, s.runtimeStatus, s.serverInfo.name]), [['promptobus-probe', 'connected', origin]]);
    const read = `${origin}_read`;
    const tools = Object.keys(data[0].tools).sort();
    assert.deepEqual(tools, role === 'reviewer' ? [read] : [read, 'write_tool'].sort());
    for (const tool of [read, 'write_tool']) {
      const r = await rpc.request('mcpServer/tool/call', { threadId, server: 'promptobus-probe', tool, arguments: {} }, 12000);
      if (role === 'reviewer' && tool === 'write_tool') {
        assert.equal(r.error?.code, -32603); assert.match(r.error.message, /'write_tool' is disabled/);
      } else assert.deepEqual(r.result.content, [{ type: 'text', text: `${origin}:${tool}` }]);
    }
    console.log(`${role}: ${labels.join(', ')}; connected ${origin}: ${tools.join(', ')}; write ${role === 'reviewer' ? 'refused' : 'allowed'}`);
  } finally {
    child.stdin.end();
    const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { console.log(`${role} teardown: ${(await closed).filter(x => x !== null).join(' ')}`); } finally { clearTimeout(kill); }
  }
}

try {
  copyFileSync(new URL('./marker-server.mjs', import.meta.url), mock);
  skill(path.join(home, '.agents/skills'), 'collision', 'personal collision');
  skill(path.join(home, '.agents/skills'), 'unrelated', 'personal unrelated');
  for (const role of ['outside', 'worker', 'reviewer', 'outside']) await profile(role);
} finally { rmSync(root, { recursive: true, force: true }); }

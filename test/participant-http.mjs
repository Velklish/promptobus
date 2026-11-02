import path from 'node:path';
import { exec, spawn } from 'node:child_process';

function words(command) {
  const result = [];
  let word = '', quote = null, escaped = false;
  for (const char of command) {
    if (escaped) { word += char; escaped = false; }
    else if (char === '\\' && quote !== "'") escaped = true;
    else if (quote) { if (char === quote) quote = null; else word += char; }
    else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) { if (word) result.push(word); word = ''; }
    else word += char;
  }
  if (quote || escaped) throw new Error('Scripted SessionStart command has incomplete quoting');
  if (word) result.push(word);
  return result;
}

export function scriptedHttpHelperBinary(config) {
  if (typeof config?.headersHelper !== 'string') return null;
  const argv = words(config.headersHelper);
  return argv.length === 8 && path.isAbsolute(argv[0]) && path.isAbsolute(argv[1])
    && argv[2] === 'service' && argv[3] === 'headers' && argv[4] === '--client-file'
    && path.isAbsolute(argv[5]) && argv[6] === '--service-home' && path.isAbsolute(argv[7]) ? argv[1] : null;
}

function startCommands(settings) {
  const commands = (settings?.hooks?.SessionStart ?? []).flatMap(group => group.hooks ?? []).map(hook => {
    if (hook.type !== 'command' || typeof hook.command !== 'string' || !hook.command.trim()) {
      throw new Error('Scripted HTTP participant requires command SessionStart hooks');
    }
    return hook.command;
  });
  if (!commands.length) throw new Error('Scripted HTTP participant requires its configured SessionStart hook');
  return commands;
}

// These coordinates select the test script; only the hook and authenticated MCP reply establish access.
export function scriptedHttpScope(settings) {
  const values = new Map();
  for (const command of startCommands(settings)) {
    const argv = words(command);
    for (let i = 0; i < argv.length - 1; ++i) {
      const key = { '--home': 'home', '--task': 'task', '--role': 'address' }[argv[i]];
      if (!key) continue;
      const value = argv[++i];
      if (values.has(key) && values.get(key) !== value) throw new Error('Scripted SessionStart scope is ambiguous');
      values.set(key, value);
    }
  }
  const scope = Object.fromEntries(values);
  if (!path.isAbsolute(scope.home ?? '') || !scope.task || !scope.address) {
    throw new Error('Scripted SessionStart hook has no complete script scope');
  }
  return scope;
}

export function scriptedHttpHeaders(config, env) {
  const headers = {};
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (typeof value !== 'string') throw new Error('Scripted Claude HTTP header must be a string');
    headers[name] = value.replace(/\$\{([^}]+)\}/g, (_, key) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key] === undefined) {
        throw new Error('Scripted Claude HTTP header reference is unresolved');
      }
      return env[key];
    });
    if (headers[name].includes('${')) throw new Error('Scripted Claude HTTP header reference is unresolved');
  }
  return headers;
}

export async function connectionHeaders(config, env, cwd) {
  const headers = scriptedHttpHeaders(config, env);
  if (!config.headersHelper) return headers;
  if (typeof config.headersHelper !== 'string') throw new Error('Scripted Claude headersHelper must be a command');
  const output = await new Promise((resolve, reject) => {
    exec(config.headersHelper, { cwd, env: { ...env, CLAUDE_CODE_MCP_SERVER_NAME: 'promptobus',
      CLAUDE_CODE_MCP_SERVER_URL: config.url }, timeout: 10000 }, (error, stdout) => {
      if (error) reject(new Error('Scripted Claude headersHelper failed'));
      else resolve(stdout);
    });
  });
  let dynamic;
  try { dynamic = JSON.parse(output); } catch { throw new Error('Scripted Claude headersHelper returned invalid JSON'); }
  if (!dynamic || typeof dynamic !== 'object' || Array.isArray(dynamic)
    || Object.values(dynamic).some(value => typeof value !== 'string')) {
    throw new Error('Scripted Claude headersHelper must return string headers');
  }
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(dynamic)) merged.set(name, value);
  return Object.fromEntries(merged);
}

async function sessionStart(settings, { cwd, env, nativeId }) {
  if (typeof nativeId !== 'string' || !nativeId) throw new Error('Scripted SessionStart has no native session ID');
  for (const command of startCommands(settings)) {
    await new Promise((resolve, reject) => {
      const hook = spawn(command, { cwd, env, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      hook.stdout.setEncoding('utf8');
      hook.stdout.on('data', chunk => { stdout += chunk; });
      hook.stderr.setEncoding('utf8');
      hook.stderr.on('data', chunk => { stderr += chunk; });
      hook.on('error', reject);
      hook.on('close', code => {
        if (code !== 0) { reject(new Error(`Scripted SessionStart hook exited ${code}: ${stderr.trim()}`)); return; }
        for (const line of stdout.split('\n').filter(Boolean)) {
          let output;
          try { output = JSON.parse(line); } catch { continue; }
          if (output.continue === false || output.decision === 'block') {
            reject(new Error('Scripted SessionStart hook refused this session')); return;
          }
        }
        resolve();
      });
      hook.stdin.on('error', reject);
      hook.stdin.end(JSON.stringify({ session_id: nativeId, cwd, hook_event_name: 'SessionStart' }));
    });
  }
}

export async function openScriptedHttp(config, { settings, env, cwd, nativeId, afterSessionStart }) {
  if (!['http', 'streamable-http'].includes(config.type)) throw new Error('Scripted Claude remote MCP requires an HTTP type');
  const scope = scriptedHttpScope(settings);
  await sessionStart(settings, { cwd, env, nativeId });
  afterSessionStart?.();
  const headers = await connectionHeaders(config, env, cwd);
  let session = null, protocol = '2025-06-18', sequence = 0;
  const rpc = async (method, params, notify = false) => {
    const response = await fetch(config.url, { method: 'POST', signal: AbortSignal.timeout(30000), headers: {
      ...headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': protocol } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id: ++sequence }), method, params }) });
    if (!response.ok) throw new Error(`Scripted HTTP MCP ${method}: HTTP ${response.status}`);
    const returned = response.headers.get('mcp-session-id');
    if (session && returned && returned !== session) throw new Error('Scripted HTTP MCP session changed');
    session = returned ?? session;
    return response.status === 202 ? null : response.json();
  };
  const close = async () => {
    if (!session) return null;
    const response = await fetch(config.url, { method: 'DELETE', signal: AbortSignal.timeout(5000), headers: {
      ...headers, 'mcp-session-id': session, 'mcp-protocol-version': protocol,
    } });
    if (!response.ok && response.status !== 401 && response.status !== 404) throw new Error(`Scripted HTTP MCP close: HTTP ${response.status}`);
    session = null;
    return response.status;
  };
  try {
    const hello = await rpc('initialize', { protocolVersion: protocol, capabilities: {},
      clientInfo: { name: 'promptobus-e2e-participant', version: '1' } });
    if (!session || hello?.error || !hello?.result?.protocolVersion) throw new Error('Scripted HTTP MCP initialization was not accepted');
    protocol = hello.result.protocolVersion;
    await rpc('notifications/initialized', {}, true);
    const own = await rpc('tools/call', { name: 'promptobus_mailbox', arguments: {} });
    const text = own?.result?.content?.map(item => item.text ?? '').join('\n') ?? '';
    const identity = /PROMPTOBUS_HOME=(.+?) · task=(\S+)(?: "[^\n]*")? · address=(\S+)/.exec(text);
    if (own?.error || own?.result?.isError || !identity || identity[1] !== scope.home
      || identity[2] !== scope.task || identity[3] !== scope.address) {
      throw new Error('Scripted HTTP MCP reply does not belong to this participant scope');
    }
    return { rpc, close, scope, hello };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

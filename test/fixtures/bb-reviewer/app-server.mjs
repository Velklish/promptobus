#!/usr/bin/env node
import { createInterface } from 'node:readline';

const denied = [];
const result = () => ({ denied, argv: process.argv.slice(2), bbParent: process.env.BB_THREAD_ID ?? null, busParent: process.env.PROMPTOBUS_TASK ?? null });
const control = process.env.PB_TEST_CONTROL;
let probe;
let hostProbe;
const hostReplies = [];
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!message.method) {
    if (String(message.id).startsWith('host-probe-')) {
      hostReplies.push(message);
      if (hostReplies.length === 2) reply(hostProbe, hostReplies);
      continue;
    }
    denied.push(message);
    if (denied.length === 3 && probe) reply(probe, result());
    continue;
  }
  if (message.method === 'initialize' && process.env.PB_TEST_HANG) continue;
  if (message.method === 'initialize') reply(message.id, { codexHome: control === 'home' ? '/' : process.env.CODEX_HOME,
    userAgent: `promptobus_bb_reviewer/${process.env.PB_TEST_CODEX_VERSION ?? '0.162.0-alpha.17.2'} fixture` });
  else if (message.method === 'config/read') reply(message.id, { config: {
    features: Object.fromEntries(process.argv.filter((arg, i) => process.argv[i - 1] === '--disable').map(name => [name, control === 'feature' && name === 'apps'])),
    web_search: process.argv.includes('web_search="disabled"') ? 'disabled' : null,
    mcp_servers: process.env.PB_TEST_MCP ? { canonical: { command: 'untrusted' } } : {},
  } });
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    reply(message.id, { thread: { id: control === 'identity' ? 'other-thread' : 'review-thread' },
      model: control === 'model' ? 'other-model' : message.params.model,
      reasoningEffort: control === 'effort' ? 'low' : message.params.config.model_reasoning_effort ?? null,
      sandbox: control === 'missing-sandbox' ? null : { type: control === 'widened-sandbox' ? 'workspaceWrite' : 'readOnly',
        ...(control === 'missing-network' ? {} : { networkAccess: control === 'network' }) },
      approvalPolicy: control === 'approval' ? 'on-request' : 'never' });
    for (const tool of ['shell', 'apply_patch', 'mcp__canonical__write']) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: `deny-${tool}`, method: 'item/tool/call',
        params: { threadId: 'review-thread', tool, arguments: {} } })}\n`);
    }
  } else if (message.method === 'turn/start') {
    reply(message.id, { turn: { id: 'native-turn' } });
    if (process.env.PB_TEST_EXIT) setImmediate(() => process.exit(17));
  } else if (message.method === 'security/probe') {
    if (denied.length === 3) reply(message.id, result());
    else probe = message.id;
  } else if (message.method === 'host/probe') {
    hostProbe = message.id;
    for (const tool of ['read', 'write']) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'host-probe-' + tool,
      method: 'item/tool/call', params: { threadId: 'review-thread', tool: 'promptobus_host_call',
        arguments: { server: 'catalog', tool, args: {} } } }) + '\n');
  }
  else reply(message.id, {});
}

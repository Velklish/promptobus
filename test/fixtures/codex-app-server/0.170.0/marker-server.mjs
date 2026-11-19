import { createInterface } from 'node:readline';

const origin = process.env.ORIGIN;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const tools = [`${origin}_read`, 'write_tool'].map(name => ({ name, description: name, inputSchema: { type: 'object' } }));
  const result = method === 'initialize' ? { protocolVersion: params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: origin, version: '1' } }
    : method === 'tools/list' ? { tools }
    : method === 'tools/call' ? { content: [{ type: 'text', text: `${origin}:${params.name}` }] } : {};
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

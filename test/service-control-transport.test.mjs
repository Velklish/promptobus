import './home.mjs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setImmediate as immediate } from 'node:timers/promises';
import { check } from './check.mjs';
import { makeSandbox, makeSockDir } from './sandbox.mjs';
import { serviceControl } from '../lib/service-client.js';

const root = makeSandbox('promptobus-shared-service-control-');
const { sock } = makeSockDir('a2h-');
const paths = { owner: path.join(root, 'owner.json'), controlSocket: sock('control') };
writeFileSync(paths.owner, JSON.stringify({ token: randomBytes(32).toString('hex') }), { mode: 0o600 });
const sockets = new Set();
const operations = [];
let firstSocket, connections = 0, mutations = 0;
const previousKeepAlive = http.globalAgent.keepAlive;
http.globalAgent.keepAlive = true;
const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const { operation } = JSON.parse(body);
    operations.push(operation);
    if (operation === 'register') {
      ++mutations;
      request.socket.destroy();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
});
server.on('connection', socket => {
  ++connections;
  firstSocket ??= socket;
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

try {
  await new Promise(resolve => server.listen(paths.controlSocket, resolve));
  const first = await serviceControl(paths, { operation: 'status' });
  check('private control succeeds before its owner closes an idle connection', first.ok === true);
  await immediate();
  firstSocket.destroy();
  let second, secondError;
  try { second = await serviceControl(paths, { operation: 'revoke' }); }
  catch (error) { secondError = error; }
  check('an owner-closed idle connection does not break the next control operation',
    second?.ok === true, secondError?.code ?? secondError?.message);
  check('the next operation reaches one fresh physical connection exactly once',
    connections === 2 && operations.join(',') === 'status,revoke',
    JSON.stringify({ connections, operations }));

  let uncertainError;
  try { await serviceControl(paths, { operation: 'register' }); }
  catch (error) { uncertainError = error; }
  check('a control mutation whose response is lost returns its transport error',
    !!uncertainError?.code, uncertainError?.message);
  check('an uncertain control mutation is never automatically retried',
    mutations === 1 && operations.filter(operation => operation === 'register').length === 1,
    JSON.stringify({ mutations, operations }));
} finally {
  http.globalAgent.keepAlive = previousKeepAlive;
  http.globalAgent.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}

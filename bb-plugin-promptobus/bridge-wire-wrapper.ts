import fs from 'node:fs';
import path from 'node:path';

export const wireWrapperSource = String.raw`
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import path from 'node:path';
const config = CONFIG;
let log;
try { log = fs.openSync(path.join(config.directory, 'wire-' + process.pid + '.jsonl'), 'wx', 0o600); } catch {}
function record(data) {
  if (log === undefined) return;
  try { fs.writeSync(log, JSON.stringify(data) + '\n'); } catch { fs.closeSync(log); log = undefined; }
}
const methods = new Set(['initialize', 'authenticate', 'session/new', 'session/load', 'session/fork', 'session/resume']);
const pending = { input: new Map(), output: new Map() };
function observe(line, direction) {
  let message;
  try { message = JSON.parse(line.toString('utf8')); } catch { return; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const id = Number.isSafeInteger(message.id) ? message.id : null;
  if (methods.has(message.method)) {
    if (id !== null) pending[direction].set(id, message.method);
    const data = { direction, method: message.method, id };
    if (message.method.startsWith('session/')) {
      const servers = message.params?.mcpServers;
      data.mcpCount = Array.isArray(servers) ? servers.length : null;
      data.mcpServers = Array.isArray(servers) ? servers.map(server => ({
        name: server?.name === 'bb-bridge' ? 'bb-bridge' : 'other',
        type: server?.type === 'http' || server?.type === 'sse' ? server.type
          : typeof server?.command === 'string' ? 'stdio' : 'unknown',
      })) : [];
    }
    record(data);
  } else if (id !== null && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
    const requests = pending[direction === 'input' ? 'output' : 'input'];
    const method = requests.get(id);
    if (!method) return;
    requests.delete(id);
    record({ direction, method, id, success: !Object.hasOwn(message, 'error'),
      errorCode: Number.isSafeInteger(message.error?.code) ? message.error.code : null });
  }
}
function tap(direction) {
  let buffered = Buffer.alloc(0), dropped = false;
  return new Transform({
    transform(chunk, encoding, done) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, end);
        if (!dropped && buffered.length + part.length <= 1048576) observe(Buffer.concat([buffered, part]), direction);
        buffered = Buffer.alloc(0); dropped = false; start = end + 1;
      }
      const tail = chunk.subarray(start);
      if (!dropped && buffered.length + tail.length <= 1048576) buffered = Buffer.concat([buffered, tail]);
      else { buffered = Buffer.alloc(0); dropped = true; }
      done(null, chunk);
    },
    flush(done) { if (!dropped && buffered.length) observe(buffered, direction); done(); },
  });
}
const env = { ...process.env };
const prefix = path.join(config.directory, 'bin') + path.delimiter;
if (env.PATH?.startsWith(prefix)) env.PATH = env.PATH.slice(prefix.length);
const child = spawn(config.realCommand, process.argv.slice(2), { env, stdio: ['pipe', 'pipe', 'pipe'] });
process.stdin.pipe(tap('input')).pipe(child.stdin);
child.stdout.pipe(tap('output')).pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
child.on('error', () => { process.stderr.write('Scoped ACP diagnostic child failed to start\n'); process.exitCode = 127; process.stdin.destroy(); });
child.on('close', (code, signal) => {
  process.stdin.destroy();
  process.stdout.write('', () => process.stderr.write('', () => {
    if (log !== undefined) fs.closeSync(log);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 127);
  }));
});
`;

export function prepareWireWrapper(directory: string, command: string, realCommand: string, node: string) {
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(bin).isDirectory() || fs.lstatSync(bin).isSymbolicLink()) throw Error('Unsafe diagnostic bin');
  fs.chmodSync(bin, 0o700);
  const file = path.join(bin, command);
  const source = `#!${node}\n${wireWrapperSource.replace('CONFIG', JSON.stringify({ directory, realCommand }))}`;
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || fs.readFileSync(file, 'utf8') !== source) {
      throw Error('Unexpected diagnostic launcher');
    }
  } else fs.writeFileSync(file, source, { flag: 'wx', mode: 0o700 });
  return bin;
}

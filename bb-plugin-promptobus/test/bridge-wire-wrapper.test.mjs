import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { prepareWireWrapper } from '../.test-build/bridge-wire-wrapper.js';

function fixture(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-wire-'));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const real = path.join(directory, 'real-cli');
  fs.writeFileSync(real, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const bin = prepareWireWrapper(directory, 'cursor-agent', real, process.execPath);
  return { directory, bin, read() {
    const files = fs.readdirSync(directory).filter(name => name.startsWith('wire-'));
    assert.equal(files.length, 1);
    assert.equal(fs.statSync(path.join(directory, files[0])).mode & 0o777, 0o600);
    return fs.readFileSync(path.join(directory, files[0]), 'utf8');
  } };
}

async function execute(s, input, args = ['acp'], chunks = [input], env = {}) {
  const child = spawn('cursor-agent', args, { env: { ...process.env, ...env, PATH: `${s.bin}${path.delimiter}${process.env.PATH}` } });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
  for (const chunk of chunks) child.stdin.write(chunk);
  child.stdin.end();
  return closed;
}

test('scoped PATH wrapper preserves fragmented ACP bytes, arguments, stderr and exit code; logs only approved fields', async t => {
  const responses = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { secret: 'SECRET_RESULT' } }) + '\n'
    + JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'SECRET_ERROR', data: 'SECRET_DATA' } }) + '\n');
  const s = fixture(t, `
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['acp', '--synthetic', 'SECRET_ARG']);
assert.equal(process.env.PATH, ${JSON.stringify(process.env.PATH)});
const chunks=[];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const output=Buffer.concat([Buffer.from(${JSON.stringify([...responses])}), ...chunks]);
  for(let i=0;i<output.length;i+=7) process.stdout.write(output.subarray(i,i+7));
  process.stderr.write(Buffer.from([0,255,10,195,169]));
  process.exitCode=7;
});`);
  const input = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { token: 'SECRET_TOKEN' } }) + '\r\n'
    + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/SECRET_CWD', prompt: 'SECRET_🦉',
      mcpServers: [{ name: 'bb-bridge', command: '/SECRET_CMD', args: ['SECRET_ARGS'], env: [{ name: 'SECRET_ENV', value: 'SECRET_VALUE' }] },
        { name: 'SECRET_SERVER', type: 'http', url: 'SECRET_URL', headers: ['SECRET_HEADER'] }] } }) + '\n'
    + 'not-json\u0000\xff\n' + JSON.stringify({ method: 'session/prompt', id: 'SECRET_ID', params: { prompt: 'SECRET_PROMPT' } }));
  const chunks = [];
  for (let i = 0; i < input.length; i += 3) chunks.push(input.subarray(i, i + 3));
  const result = await execute(s, input, ['acp', '--synthetic', 'SECRET_ARG'], chunks, { SYNTHETIC_SECRET: 'SECRET_ENV_VALUE' });
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout, Buffer.concat([responses, input]));
  assert.deepEqual(result.stderr, Buffer.from([0, 255, 10, 195, 169]));
  const raw = s.read();
  assert.equal(raw.includes('SECRET'), false);
  const records = raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.slice(0, 2), [
    { direction: 'input', method: 'initialize', id: 1 },
    { direction: 'input', method: 'session/new', id: 2, mcpCount: 2,
      mcpServers: [{ name: 'bb-bridge', type: 'stdio' }, { name: 'other', type: 'http' }] },
  ]);
  assert.deepEqual(records.slice(2, 4), [
    { direction: 'output', method: 'initialize', id: 1, success: true, errorCode: null },
    { direction: 'output', method: 'session/new', id: 2, success: false, errorCode: -32603 },
  ]);
  assert.equal(fs.statSync(s.bin).mode & 0o777, 0o700);
});

test('wire observer forwards oversized and malformed lines and captures the next session request without raw content', async t => {
  const s = fixture(t, `process.stdin.pipe(process.stdout);`);
  const next = JSON.stringify({ method: 'session/load', id: 3, params: { mcpServers: [] } }) + '\n';
  const input = Buffer.concat([Buffer.alloc(1048580, 65), Buffer.from('\n{broken\n' + next)]);
  const result = await execute(s, input, ['acp'], [input.subarray(0, 1048570), input.subarray(1048570)]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, input);
  assert.deepEqual(s.read().trim().split('\n').map(JSON.parse), [
    { direction: 'input', method: 'session/load', id: 3, mcpCount: 0, mcpServers: [] },
    { direction: 'output', method: 'session/load', id: 3, mcpCount: 0, mcpServers: [] },
  ]);
});

test('wire capture does not serialize opaque ids, unknown server values, error messages or notification payloads', async t => {
  const s = fixture(t, `process.stdin.pipe(process.stdout);`);
  const input = Buffer.from([
    { method: 'session/fork', id: 'SECRET_ID', params: { mcpServers: [{ name: 'SECRET_NAME', type: 'SECRET_TYPE' }] } },
    { method: 'SECRET_METHOD', id: 5, params: { reasoning: 'SECRET_REASONING' } },
    { id: 99, error: { code: 'SECRET_CODE', message: 'SECRET_ERROR' } },
    { method: 'session/update', params: { sessionId: 'SECRET_SESSION', update: { text: 'SECRET_PROMPT' } } },
  ].map(x => JSON.stringify(x)).join('\n'));
  const result = await execute(s, input);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, input);
  assert.equal(s.read().includes('SECRET'), false);
  assert.deepEqual(s.read().trim().split('\n').map(JSON.parse), ['input', 'output'].map(direction => ({
    direction, method: 'session/fork', id: null, mcpCount: 1, mcpServers: [{ name: 'other', type: 'unknown' }],
  })));
});

test('diagnostic launcher preparation is repeatable and refuses a changed or symlinked executable', t => {
  const s = fixture(t, 'process.stdin.pipe(process.stdout);');
  const real = path.join(s.directory, 'real-cli');
  const file = path.join(s.bin, 'cursor-agent');
  assert.equal(prepareWireWrapper(s.directory, 'cursor-agent', real, process.execPath), s.bin);
  fs.writeFileSync(file, 'changed');
  assert.throws(() => prepareWireWrapper(s.directory, 'cursor-agent', real, process.execPath), /Unexpected diagnostic launcher/);
  fs.unlinkSync(file);
  fs.symlinkSync(real, file);
  assert.throws(() => prepareWireWrapper(s.directory, 'cursor-agent', real, process.execPath), /Unexpected diagnostic launcher/);
  fs.unlinkSync(file);
  fs.rmdirSync(s.bin);
  fs.symlinkSync(s.directory, s.bin);
  assert.throws(() => prepareWireWrapper(s.directory, 'cursor-agent', real, process.execPath), /Unsafe diagnostic bin/);
});

async function waitFor(predicate, milliseconds = 2000) {
  const deadline = Date.now() + milliseconds;
  do {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return predicate();
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function ownedProcess(t, s) {
  const wrapper = spawn(path.join(s.bin, 'cursor-agent'), ['acp'], { detached: true });
  let closed = false;
  wrapper.on('close', () => { closed = true; });
  wrapper.stderr.resume();
  let nativePid;
  t.after(async () => {
    wrapper.stdout.resume();
    wrapper.stdin.destroy();
    try { process.kill(-wrapper.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    assert.equal(await waitFor(() => closed), true, 'owned wrapper did not close during cleanup');
    if (nativePid) assert.equal(await waitFor(() => !alive(nativePid)), true, 'owned native child did not terminate during cleanup');
    t.diagnostic('owned wrapper/native child cleanup confirmed');
  });
  return { wrapper, closed: () => closed, async ready() {
    const ready = path.join(s.directory, 'ready.json');
    assert.equal(await waitFor(() => fs.existsSync(ready)), true, 'fake ACP child did not become ready');
    nativePid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid;
    assert.equal(Number.isSafeInteger(nativePid) && nativePid > 0, true);
    return nativePid;
  } };
}

const readySource = `
import fs from 'node:fs';
import path from 'node:path';
fs.writeFileSync(path.join(path.dirname(process.argv[1]), 'ready.json'), JSON.stringify({pid:process.pid}));
`;

test('wrapper drains at least 2 MiB byte-for-byte after a delayed parent stdout consumer', async t => {
  const length = 2 * 1024 * 1024 + 137;
  const s = fixture(t, readySource + `
const bytes=Buffer.alloc(${length});
for(let i=0;i<bytes.length;i++) bytes[i]=(i*31)%251;
process.stdin.resume();
process.stdin.on('end',()=>{ process.stdout.end(bytes); process.exitCode=23; });
`);
  const child = ownedProcess(t, s);
  await child.ready();
  child.wrapper.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 300));
  const chunks = [];
  child.wrapper.stdout.on('data', chunk => chunks.push(chunk));
  child.wrapper.stdout.resume();
  assert.equal(await waitFor(child.closed, 5000), true, 'wrapper did not finish after stdout consumer resumed');
  const received = Buffer.concat(chunks);
  const expected = Buffer.alloc(length);
  for (let i = 0; i < length; i++) expected[i] = (i * 31) % 251;
  const receivedHash = createHash('sha256').update(received).digest('hex');
  const expectedHash = createHash('sha256').update(expected).digest('hex');
  t.diagnostic(`stdout length=${received.length}/${length}, sha256=${receivedHash}/${expectedHash}`);
  assert.equal(received.length, length, 'wrapper truncated output queued behind parent stdout backpressure');
  assert.equal(receivedHash, expectedHash);
  assert.equal(child.wrapper.exitCode, 23);
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`wrapper forwards ${signal} to its native ACP child`, async t => {
  const s = fixture(t, readySource + `process.stdin.resume(); setInterval(()=>{},1000);`);
  const child = ownedProcess(t, s);
  const nativePid = await child.ready();
  child.wrapper.kill(signal);
  assert.equal(await waitFor(child.closed), true, 'wrapper did not close after signal');
  assert.equal(await waitFor(() => !alive(nativePid), 1000), true, `native ACP child remains alive after ${signal} sent to wrapper PID`);
  assert.equal(child.wrapper.signalCode, signal);
});

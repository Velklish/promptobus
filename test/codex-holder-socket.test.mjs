import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeSandbox } from './sandbox.mjs';

test('fallback stays bounded under long TMPDIR and separates registries', () => {
  const root = makeSandbox('promptobus-codex-');
  const long = path.join(root, 'x'.repeat(110));
  mkdirSync(long);
  const script = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import { socketPath } from './lib/codex-session.js';
    const envA = { PROMPTOBUS_CODEX_HOME: process.env.TMPDIR + '/a' };
    const envB = { PROMPTOBUS_CODEX_HOME: process.env.TMPDIR + '/b' };
    const a = socketPath('same-ref', envA, 'launch-a'), b = socketPath('same-ref', envB, 'launch-a');
    const next = socketPath('same-ref', envA, 'launch-b');
    assert.notEqual(a, next);
    assert.ok(Buffer.byteLength(next) <= 103, next);
    const short = { PROMPTOBUS_CODEX_HOME: '/tmp' };
    assert.notEqual(socketPath('same-ref', short, 'launch-a'), socketPath('same-ref', short, 'launch-b'));
    assert.notEqual(a, socketPath('another-ref', envA, 'launch-a'));
    assert.notEqual(a, b);
    assert.ok(Buffer.byteLength(a) <= 103, a);
    assert.ok(Buffer.byteLength(b) <= 103, b);
    assert.match(a, /^\\/tmp\\/pb-cdx-/);
    const server = net.createServer(c => c.on('data', data => c.write(data)));
    server.listen(a, () => {
      const client = net.connect(a, () => client.write('echo'));
      client.on('data', data => { assert.equal(data.toString(), 'echo'); client.end(); server.close(); });
    });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TMPDIR: long, TMP: long, TEMP: long }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(readFileSync('docs/reference/03-cli.md', 'utf8'), /fallback is 29 bytes/);
});

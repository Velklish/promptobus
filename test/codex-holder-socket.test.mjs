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
    const mode = process.argv[1];
    const partial = mode.startsWith('short-');
    let sawPrefix;
    const prefixDelivered = new Promise(resolve => { sawPrefix = resolve; });
    const server = net.createServer(peer => {
      let request = '';
      peer.on('data', async part => {
        request += part;
        if (request !== 'echo') return;
        const prefix = partial ? request.slice(0, Number(mode.at(-1))) : mode === 'wrong' ? 'ex' : request.slice(0, 2);
        if (prefix) peer.write(prefix);
        await prefixDelivered;
        if (mode === 'split') peer.end(request.slice(2));
      });
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(a, resolve));
    const client = net.connect(a, () => client.write('echo'));
    let received = '';
    const watchdog = setTimeout(() => client.destroy(new Error('incomplete echo: ' + JSON.stringify(received))), partial ? 2000 : 5000);
    try {
      for await (const part of client) {
        received += part;
        assert.ok('echo'.startsWith(received), 'unexpected echo payload: ' + received);
        if (received.length === 2) sawPrefix();
      }
      assert.equal(received, 'echo', 'incomplete echo: ' + received);
    } finally {
      clearTimeout(watchdog);
      sawPrefix();
      client.destroy();
      server.close();
    }
  `;
  const cases = [['split', null], ['wrong', 'unexpected echo payload: ex']];
  for (const prefix of ['', 'e', 'ec']) cases.push(['short-' + prefix.length, 'incomplete echo: ' + JSON.stringify(prefix)]);
  for (const [mode, expected] of cases) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, mode], {
      env: { ...process.env, TMPDIR: long, TMP: long, TEMP: long }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, expected === null ? 0 : 1, child.error?.message ?? child.stderr);
    if (expected !== null) assert.ok(child.stderr.includes(expected), child.stderr);
  }
  assert.match(readFileSync('docs/reference/03-cli.md', 'utf8'), /fallback is 29 bytes/);
});

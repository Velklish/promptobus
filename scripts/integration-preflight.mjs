import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { REACHABLE_BINARIES } from '../test/hygiene.mjs';

async function socketRoundTrip(file) {
  const server = createServer();
  let peer, client, timer, operation = 'listen';
  try {
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(new Error(`${operation} ${file}: ${error.message}`, { cause: error }));
      timer = setTimeout(() => fail(new Error('timed out after 2000 ms')), 2000);
      server.on('error', fail);
      server.on('connection', (socket) => {
        peer = socket;
        peer.on('error', fail);
        peer.on('data', (data) => peer.write(data));
      });
      server.listen(file, () => {
        operation = 'connect';
        client = createConnection(file);
        let reply = '';
        client.setEncoding('utf8');
        client.on('error', fail);
        client.on('connect', () => client.write('probe'));
        client.on('data', (data) => {
          reply += data;
          if (reply === 'probe') resolve();
          else if (!'probe'.startsWith(reply)) fail(new Error('unexpected reply'));
        });
      });
    });
  } finally {
    clearTimeout(timer);
    client?.destroy();
    peer?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function inOwnedDirectory(root, prefix, action) {
  const directory = mkdtempSync(path.join(root, prefix));
  try {
    return await action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function preflight() {
  const checks = [];
  let operation;
  const check = async (name, probe) => {
    operation = name;
    checks.push({ operation, result: await probe() });
  };
  const result = { node: process.version, executable: process.execPath, platform: process.platform,
    arch: process.arch, cwd: process.cwd(), tmpdir: os.tmpdir(), checks };
  try {
    let run, wouldResolve, requireProcess;
    await check('load built fixture modules', async () => {
      ({ run, wouldResolve } = await import('../lib/exec.js'));
      ({ requireProcess } = await import('../lib/service-state.js'));
      return ['lib/exec.js', 'lib/service-state.js'];
    });
    await check('read own process birth identity (requireProcess)', () => {
      requireProcess();
      return 'observable';
    });
    await check(`create suite temporary directory in ${os.tmpdir()}`, () =>
      inOwnedDirectory(os.tmpdir(), 'promptobus-test-run-', async () => 'writable'));
    await check('round trip over an owned Unix socket under /tmp', () =>
      inOwnedDirectory(realpathSync('/tmp'), 'pb-preflight-', (dir) => socketRoundTrip(path.join(dir, 'probe.sock')))
        .then(() => 'echo received'));
    const command = (argv) => {
      const child = run(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 10_000 });
      if (child.status !== 0) throw new Error(child.error?.message
        ?? `exit ${child.status}, signal ${child.signal}\n${child.stdout}${child.stderr}`);
      return child.stdout.trim();
    };
    for (const name of [...REACHABLE_BINARIES, 'npx']) {
      await check(`resolve ${name} on PATH`, () => {
        const resolved = wouldResolve(name, process.env);
        if (!resolved) throw new Error(`${name}: not found or not executable on PATH`);
        return realpathSync(resolved);
      });
    }
    await check('run node from PATH with the suite runtime', () => {
      const found = command(['node', '-p', 'JSON.stringify([process.execPath, process.version])']);
      const [executable, version] = JSON.parse(found);
      if (version !== process.version || realpathSync(executable) !== realpathSync(process.execPath)) {
        throw new Error(`node on PATH returned ${found}; expected ${process.execPath} ${process.version}`);
      }
      return { executable, version };
    });
    await check('npx --no-install backslop lint --require-adapters', () =>
      command(['npx', '--no-install', 'backslop', 'lint', '--require-adapters']));
    return { ...result, status: 'passed' };
  } catch (error) {
    return { ...result, status: 'failed', failure: { operation, error: error.message, code: error.code ?? error.cause?.code ?? null } };
  }
}

async function main(args) {
  if (args.length && (args[0] !== '--' || !args[1])) {
    console.error('Usage: node scripts/integration-preflight.mjs [-- command [args...]]');
    return 1;
  }
  const result = await preflight();
  console.log(JSON.stringify(result));
  if (result.status !== 'passed') {
    console.error(`${result.failure.operation}: ${result.failure.error}`);
    return 1;
  }
  if (!args.length) return 0;
  return await new Promise((resolve) => {
    const child = spawn(args[1], args.slice(2), { stdio: 'inherit' });
    child.once('error', (error) => { console.error(error.message); resolve(1); });
    child.once('exit', (code, signal) => resolve(code ?? (128 + os.constants.signals[signal])));
  });
}

process.exitCode = await main(process.argv.slice(2));

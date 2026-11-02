import './home.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check } from './check.mjs';
import { makeSandbox, writeHostConfig } from './sandbox.mjs';
import { createStandaloneHost } from '../dist/host-index.js';
import { stopWorkspaceService } from '../lib/service-client.js';
import { processState } from '../lib/service-state.js';

const root = makeSandbox('promptobus-shared-service-cleanup-');
const home = path.join(root, '.promptobus');
const receiptFile = path.join(root, 'receipt.json');
const childFile = path.join(root, 'direct-cleanup.mjs');
const source = name => pathToFileURL(path.resolve(name)).href;
writeHostConfig(root, { tools: [] });
writeFileSync(childFile, `
import { writeFileSync } from 'node:fs';
await import(${JSON.stringify(source('test/home.mjs'))});
const { ownedServiceFixture } = await import(${JSON.stringify(source('test/sandbox.mjs'))});
const { createStandaloneHost } = await import(${JSON.stringify(source('dist/host-index.js'))});
const { ensureWorkspaceService } = await import(${JSON.stringify(source('lib/service-client.js'))});
const fixture = ownedServiceFixture();
const host = createStandaloneHost({ cwd: ${JSON.stringify(root)}, home: ${JSON.stringify(home)} });
const discovery = await ensureWorkspaceService(host);
writeFileSync(${JSON.stringify(receiptFile)}, JSON.stringify({
  directory: fixture.directory, process: discovery.process,
  divertedHome: process.env.HOME, seal: process.env.PROMPTOBUS_TEST_PATH_SEAL
}), { mode: 0o600 });
`, { mode: 0o600 });

let receipt;
try {
  const child = spawnSync(process.execPath, [childFile], {
    env: { ...process.env, HOME: os.userInfo().homedir }, encoding: 'utf8', timeout: 30000,
  });
  if (existsSync(receiptFile)) receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  check('a direct suite file starts an owned service under its diverted home',
    !!receipt && receipt.divertedHome !== os.userInfo().homedir
      && receipt.seal.startsWith(receipt.divertedHome + path.sep), child.stderr || child.error?.message);
  check('owned service teardown finishes before direct-file home and PATH removal',
    child.status === 0 && !child.error, child.stderr || child.error?.message);
  check('direct-file exit removes its diverted home and sealed PATH',
    !!receipt && !existsSync(receipt.divertedHome) && !existsSync(receipt.seal));
  check('direct-file exit confirms its owned service process has exited',
    !!receipt && processState(receipt.process) === 'dead');
  check('successful owned service teardown removes its private service directory',
    !!receipt && !existsSync(receipt.directory));
} finally {
  if (receipt && processState(receipt.process) !== 'dead') {
    const host = createStandaloneHost({ cwd: root, home });
    await stopWorkspaceService(host, { env: { ...process.env, PROMPTOBUS_SERVICE_HOME: receipt.directory } });
  }
  if (receipt) rmSync(receipt.directory, { recursive: true, force: true });
}

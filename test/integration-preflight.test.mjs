import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { wouldResolve } from '../lib/exec.js';
import { REACHABLE_BINARIES } from './hygiene.mjs';
import { makeSandbox, stubCommand } from './sandbox.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const preflight = path.join(root, 'scripts/integration-preflight.mjs');

function run({ preload = '', missing, denied, adapterDiagnostics, exit = 0 } = {}) {
  const directory = makeSandbox('promptobus-test-integration-preflight-');
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  for (const name of REACHABLE_BINARIES) {
    if (name === missing) continue;
    if (name === denied) {
      writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      continue;
    }
    const file = name === 'node' ? process.execPath : wouldResolve(name, process.env);
    symlinkSync(file ?? '/bin/sh', path.join(bin, name));
  }
  stubCommand(bin, 'npx', `
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['--no-install', 'backslop', 'lint', '--require-adapters']);
${adapterDiagnostics ? `console.error(${JSON.stringify(adapterDiagnostics)}); process.exitCode = 1;` : ''}
`);
  const importFile = path.join(directory, 'preload.mjs');
  const denyAccess = denied ? `import fs from 'node:fs';
const { accessSync } = fs;
fs.accessSync = (file, mode) => {
  if (file === ${JSON.stringify(path.join(bin, denied))} && mode === fs.constants.X_OK) {
    throw Object.assign(new Error('EACCES: access refused for present fixture ${denied}'), { code: 'EACCES' });
  }
  return accessSync(file, mode);
};` : '';
  writeFileSync(importFile, `import { syncBuiltinESMExports } from 'node:module';\n${preload}\n${denyAccess}\nsyncBuiltinESMExports();\n`);
  const sentinel = path.join(directory, 'suite-started');
  const suite = [`${process.execPath}`, '-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({'
    + 'path: process.env.PATH, tmpdir: require("node:os").tmpdir(), exec: process.execPath, cwd: process.cwd()}));'
    + `process.exitCode = ${exit};`, sentinel];
  const child = spawnSync(process.execPath, ['--import', importFile, preflight, '--', ...suite], {
    cwd: directory, env: { ...process.env, PATH: bin, TMPDIR: directory }, encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(child.error);
  return { child, report: JSON.parse(child.stdout), sentinel, directory, bin };
}

function processObservation(platform, malformed) {
  return `import fs from 'node:fs'; import cp from 'node:child_process';
Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
const { readFileSync, readlinkSync } = fs, { spawnSync } = cp;
fs.readFileSync = (file, ...args) => {
  if (file === '/proc/sys/kernel/random/boot_id') return ${malformed ? "'invalid boot ID'" : "'01010101-0101-0101-0101-010101010101'"};
  if (file === '/proc/' + process.pid + '/stat') {
    fs.appendFileSync('observation-attempts', 'proc\\n');
    throw Object.assign(new Error('EACCES: fixture proc visibility'), { code: 'EACCES' });
  }
  if (file === '/proc/self/stat') {
    ${malformed ? "fs.appendFileSync('observation-attempts', 'proc\\n');" : ''}
    return process.pid + ' (node) S ' + Array(19).fill('0').join(' ');
  }
  if (file === '/proc/self/status') return 'Pid:\\t' + process.pid + '\\nNSpid:\\t' + process.pid + '\\n';
  return readFileSync(file, ...args);
};
fs.readlinkSync = (file, ...args) => file === '/proc/self/ns/pid' ? 'pid:[42]' : readlinkSync(file, ...args);
cp.spawnSync = (file, ...args) => {
  if (file !== '/bin/ps') return spawnSync(file, ...args);
  fs.appendFileSync('observation-attempts', 'ps\\n');
  return ${malformed ? "{ status: 0, stdout: 'invalid fixture ps output', stderr: '' }"
    : "{ status: 1, stdout: '', stderr: 'EPERM: fixture ps visibility' }"};
};`;
}

const refuseListen = `import net from 'node:net';
net.Server.prototype.listen = function () {
  queueMicrotask(() => this.emit('error', Object.assign(new Error('listen EPERM: fixture refusal'), { code: 'EPERM' })));
  return this;
};`;

const missingAdapter = 'generated/adapter/tasks/SKILL.md: generated output is missing';
const cases = [
  ['socket listen refusal', { preload: refuseListen }, /Unix socket/, 'listen EPERM: fixture refusal'],
  ['socket connect refusal after listen', {
    preload: `import net from 'node:net';
net.createConnection = () => {
  const client = new net.Socket();
  queueMicrotask(() => client.emit('error', Object.assign(new Error('connect EACCES: fixture refusal'), { code: 'EACCES' })));
  return client;
};`,
  }, /Unix socket/, 'connect EACCES: fixture refusal'],
  ['missing fixture binary', { missing: 'ast-grep' }, /resolve ast-grep/, 'ast-grep: not found or not executable on PATH'],
  ['missing FIFO utility', { missing: 'mkfifo' }, /resolve mkfifo/, 'mkfifo: not found or not executable on PATH'],
  ['different real and effective IDs', { preload: 'process.geteuid = () => process.getuid() + 1;' },
    /verify executor IDs/, 'Cannot verify execution access with different real and effective user or group IDs'],
  ['missing Node executable', { missing: 'node' }, /resolve node/, 'node: not found or not executable on PATH'],
  ['missing generated adapter output', { adapterDiagnostics: missingAdapter }, /lint --require-adapters/, missingAdapter],
];

for (const [name, options, operation, error] of cases) test(`${name} refuses before the sentinel suite`, () => {
  const { child, report, sentinel } = run(options);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(report.status, 'failed');
  assert.match(report.failure.operation, operation);
  assert.ok(report.failure.error.includes(error), JSON.stringify(report.failure));
  assert.ok(child.stderr.includes(error));
  assert.equal(existsSync(sentinel), false);
});

for (const platform of ['darwin', 'linux']) for (const malformed of [false, true]) test(`${platform} process observation ${malformed ? 'unparseable' : 'access refusal'} diagnoses the same failed read`, () => {
  const { child, directory, report, sentinel } = run({ preload: processObservation(platform, malformed) });
  const darwin = platform === 'darwin';
  const reason = malformed ? (darwin ? 'invalid fixture ps output' : 'invalid boot ID')
    : (darwin ? 'EPERM: fixture ps visibility' : 'EACCES: fixture proc visibility');
  assert.equal(child.status, 1, child.stderr);
  assert.match(report.failure.operation, /requireProcess/);
  assert.equal(report.failure.diagnostic.kind, malformed ? 'unparseable' : 'access-denied');
  assert.equal(report.failure.code, malformed ? null : (darwin ? 'EPERM' : 'EACCES'));
  assert.match(report.failure.diagnostic.operation, darwin ? /\/bin\/ps .*lstart=/ : /\/proc/);
  assert.ok(report.failure.diagnostic.error.includes(reason));
  assert.ok(report.failure.error.includes(reason));
  assert.ok(child.stderr.includes(reason));
  assert.equal(readFileSync(path.join(directory, 'observation-attempts'), 'utf8'), darwin ? 'ps\n' : 'proc\n');
  assert.equal(existsSync(sentinel), false);
});

test('present x-bit fixture binary with execution access denied does not start the sentinel', () => {
  const { bin, child, report, sentinel } = run({ denied: 'ast-grep' });
  assert.ok(existsSync(path.join(bin, 'ast-grep')));
  assert.equal(child.status, 1, child.stderr);
  assert.equal(report.failure.operation, 'resolve ast-grep on PATH');
  assert.equal(report.failure.code, 'EACCES');
  assert.match(report.failure.error, /EACCES: access refused for present fixture ast-grep/);
  assert.match(child.stderr, /EACCES: access refused for present fixture ast-grep/);
  assert.equal(existsSync(sentinel), false);
});

test('failed socket and directory cleanup keep the socket failure first', () => {
  const { child, directory, report, sentinel } = run({ preload: `${refuseListen}
import fs from 'node:fs';
const { rmSync } = fs;
fs.rmSync = (file, options) => {
  if (/\\/pb-preflight-[^/]+$/.test(file)) {
    fs.writeFileSync('unremoved-probe', file);
    throw Object.assign(new Error('EACCES: fixture cleanup refusal'), { code: 'EACCES' });
  }
  return rmSync(file, options);
};` });
  const probe = readFileSync(path.join(directory, 'unremoved-probe'), 'utf8');
  assert.match(probe, /^\/(?:private\/)?tmp\/pb-preflight-[A-Za-z0-9]+$/);
  rmSync(probe, { recursive: true });
  assert.equal(child.status, 1, child.stderr);
  assert.equal(report.failure.code, 'EPERM');
  assert.equal(report.failure.cleanup.code, 'EACCES');
  for (const text of [report.failure.error, child.stderr]) assert.match(text, /listen EPERM: fixture refusal[\s\S]*Cleanup: .*EACCES: fixture cleanup refusal/);
  assert.equal(existsSync(sentinel), false);
});

test('successful preflight hands the sentinel the inherited runtime and propagates its exit', () => {
  const { child, report, sentinel, bin, directory } = run({ exit: 7 });
  assert.equal(child.status, 7, child.stderr);
  assert.equal(report.status, 'passed');
  assert.ok(report.checks.some(({ result }) => result === 'echo received'));
  assert.deepEqual(JSON.parse(readFileSync(sentinel)), {
    path: bin, tmpdir: directory, exec: process.execPath, cwd: report.cwd,
  });
});

import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { wouldResolve } from '../lib/exec.js';
import { REACHABLE_BINARIES } from './hygiene.mjs';
import { makeSandbox, stubCommand } from './sandbox.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const preflight = path.join(root, 'scripts/integration-preflight.mjs');

function run({ preload = '', missing, adapterDiagnostics, exit = 0 } = {}) {
  const directory = makeSandbox('promptobus-integration-preflight-');
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  for (const name of REACHABLE_BINARIES) {
    if (name === missing) continue;
    const file = name === 'node' ? process.execPath : wouldResolve(name, process.env);
    symlinkSync(file ?? '/bin/sh', path.join(bin, name));
  }
  stubCommand(bin, 'npx', `
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['--no-install', 'backslop', 'lint', '--require-adapters']);
${adapterDiagnostics ? `console.error(${JSON.stringify(adapterDiagnostics)}); process.exitCode = 1;` : ''}
`);
  const importFile = path.join(directory, 'preload.mjs');
  writeFileSync(importFile, `import { syncBuiltinESMExports } from 'node:module';\n${preload}\nsyncBuiltinESMExports();\n`);
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

const cases = [
  ['process observation refusal', {
    preload: `import fs from 'node:fs'; import cp from 'node:child_process';
const { readFileSync } = fs, { spawnSync } = cp;
fs.readFileSync = (file, ...args) => {
  if (String(file).startsWith('/proc/')) throw new Error('EACCES: fixture proc visibility');
  return readFileSync(file, ...args);
};
cp.spawnSync = (file, ...args) => file === '/bin/ps'
  ? { status: 1, stdout: '', stderr: 'EPERM: fixture ps visibility' } : spawnSync(file, ...args);
`,
  }, /requireProcess/, 'Shared service requires an observable process birth identity on this platform'],
  ['socket listen refusal', {
    preload: `import net from 'node:net';
net.Server.prototype.listen = function () {
  queueMicrotask(() => this.emit('error', Object.assign(new Error('listen EPERM: fixture refusal'), { code: 'EPERM' })));
  return this;
};`,
  }, /Unix socket/, 'listen EPERM: fixture refusal'],
  ['socket connect refusal after listen', {
    preload: `import net from 'node:net';
net.createConnection = () => {
  const client = new net.Socket();
  queueMicrotask(() => client.emit('error', Object.assign(new Error('connect EACCES: fixture refusal'), { code: 'EACCES' })));
  return client;
};`,
  }, /Unix socket/, 'connect EACCES: fixture refusal'],
  ['missing fixture binary', { missing: 'ast-grep' }, /resolve ast-grep/, 'ast-grep: not found or not executable on PATH'],
  ['missing Node executable', { missing: 'node' }, /resolve node/, 'node: not found or not executable on PATH'],
  ['missing generated adapter output', { adapterDiagnostics: '.agents/skills/backslop-task/SKILL.md: generated output is missing' },
    /lint --require-adapters/, '.agents/skills/backslop-task/SKILL.md: generated output is missing'],
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

test('successful preflight hands the sentinel the inherited runtime and propagates its exit', () => {
  const { child, report, sentinel, bin, directory } = run({ exit: 7 });
  assert.equal(child.status, 7, child.stderr);
  assert.equal(report.status, 'passed');
  assert.ok(report.checks.some(({ result }) => result === 'echo received'));
  assert.deepEqual(JSON.parse(readFileSync(sentinel)), {
    path: bin, tmpdir: directory, exec: process.execPath, cwd: report.cwd,
  });
});

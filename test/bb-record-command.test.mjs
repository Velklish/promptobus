import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/bb-record-command.mjs', import.meta.url));
test('BB direct recorder preserves complete stdout/stderr, hashes and the nonzero runner return code', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-direct-receipt-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stem = path.join(directory, 'original');
  const output = 'résumé 東京 '.repeat(100_000) + '\nORIGINAL_TAIL\n';
  const result = spawnSync(process.execPath, [script, '--output', stem, '--by', 'fixture-recorder', '--', process.execPath, '-e',
    "process.stdout.write('résumé 東京 '.repeat(100_000)+'\\nORIGINAL_TAIL\\n');process.stderr.write('FULL_ASSERTION\\n');process.exitCode=7;"], { encoding: 'utf8' });
  assert.equal(result.status, 7, result.stderr);
  const receipt = JSON.parse(readFileSync(`${stem}.receipt.txt`, 'utf8'));
  assert.equal(readFileSync(`${stem}.stdout.txt`, 'utf8'), output);
  assert.equal(readFileSync(`${stem}.stderr.txt`, 'utf8'), 'FULL_ASSERTION\n');
  assert.equal(receipt.stdout.bytes, Buffer.byteLength(output));
  assert.equal(receipt.stdout.sha256, createHash('sha256').update(output).digest('hex'));
  assert.equal(receipt.exit, 7); assert.equal(receipt.signal, null); assert.equal(receipt.direct, true); assert.equal(receipt.complete, true);
  assert.equal(receipt.by, 'fixture-recorder');
});

test('BB direct recorder refuses a shell pipeline before executing a masked runner', () => {
  const result = spawnSync(process.execPath, [script, '--output', '/tmp/unused-pb-recorder', '--by', 'fixture-recorder', '--', 'sh', '-c', 'exit 7 | cat'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /runner executable directly/);
});

test('review boundary: env cannot mask a shell runner exit with a pipeline', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-direct-receipt-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stem = path.join(directory, 'wrapped');
  const result = spawnSync(process.execPath, [script, '--output', stem, '--by', 'fixture-recorder', '--', 'env', 'CACHE=fixture', '/bin/sh', '-c', 'exit 7 | /bin/cat'], { encoding: 'utf8' });
  assert.equal(result.status, 1, 'The shell must be rejected before a pipeline can mask its original exit 7');
  assert.match(result.stderr, /runner executable directly/);
  assert.throws(() => readFileSync(`${stem}.receipt.txt`), /ENOENT/);
});

test('review command launcher: env assignments preserve a supported direct executable exit', t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-direct-receipt-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stem = path.join(directory, 'direct-env');
  const result = spawnSync(process.execPath, [script, '--output', stem, '--by', 'fixture-recorder', '--', 'env', '--', 'FIXTURE_VALUE=original', process.execPath,
    '-e', 'process.stdout.write(process.env.FIXTURE_VALUE);process.exitCode=7'], { encoding: 'utf8' });
  assert.equal(result.status, 7, result.stderr);
  const receipt = JSON.parse(readFileSync(`${stem}.receipt.txt`, 'utf8'));
  assert.equal(receipt.exit, 7); assert.equal(receipt.complete, true); assert.equal(readFileSync(`${stem}.stdout.txt`, 'utf8'), 'original');
});

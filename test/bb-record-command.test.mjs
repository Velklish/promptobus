import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
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

for (const shell of ['dash', 'ash', 'ksh']) test(`review2 boundary: ${shell} cannot mask exit 7 through the direct recorder`, t => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-direct-receipt-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, shell); symlinkSync('/bin/sh', executable);
  const stem = path.join(directory, 'original');
  const result = spawnSync(process.execPath, [script, '--output', stem, '--by', 'fixture-recorder', '--', executable, '-c', 'exit 7 | /bin/cat'], { encoding: 'utf8' });
  assert.equal(result.status, 1, 'The real POSIX shell pipeline must be rejected before its complete exit 0 masks original exit 7');
  assert.match(result.stderr, /runner executable directly/); assert.throws(() => readFileSync(`${stem}.receipt.txt`), /ENOENT/);
});

function recorderFixture(t, sink = null) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-direct-receipt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stem = path.join(directory, 'original'), marker = path.join(directory, 'spawned.txt'), pidFile = path.join(directory, 'pid.txt');
  const hook = path.join(directory, 'hook.mjs');
  writeFileSync(hook, `import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const spawn = cp.spawn; cp.spawn = (...args) => { fs.writeFileSync(${JSON.stringify(marker)}, 'spawn attempted'); return spawn(...args); };
const create = fs.createWriteStream; fs.createWriteStream = (...args) => { const stream = create(...args);
if (${JSON.stringify(sink)} && String(args[0]).endsWith(${JSON.stringify(`.${sink}.txt`)})) stream._write = (chunk, encoding, callback) => callback(new Error('fixture sink failure'));
return stream; }; syncBuiltinESMExports();`);
  const run = code => spawnSync(process.execPath, ['--import', hook, script, '--output', stem, '--by', 'fixture-recorder', '--', process.execPath, '-e', code], { encoding: 'utf8', timeout: 5000 });
  return { directory, stem, marker, pidFile, run };
}

for (const stream of ['stdout', 'stderr', 'receipt']) test(`recorder reservation: existing ${stream} refuses before the runner starts`, t => {
  const f = recorderFixture(t), file = `${f.stem}.${stream}.txt`;
  writeFileSync(file, 'existing output must survive');
  const result = f.run('process.stdout.write("runner started");');
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(f.marker), false, 'Output reservation must refuse before spawn starts the runner');
  assert.equal(readFileSync(file, 'utf8'), 'existing output must survive');
  assert.match(result.stderr, /EEXIST/);
  const refusal = JSON.parse(result.stderr); assert.equal(refusal.notRun, true); assert.equal(refusal.complete, false);
});

test('recorder reservation: missing output directory refuses before the runner starts', t => {
  const f = recorderFixture(t);
  const result = spawnSync(process.execPath, ['--import', path.join(f.directory, 'hook.mjs'), script, '--output', path.join(f.directory, 'missing', 'run'), '--by', 'fixture-recorder', '--', process.execPath, '-e', 'process.stdout.write("runner started");'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(f.marker), false, 'Missing directory must refuse before spawn starts the runner');
  assert.match(result.stderr, /ENOENT/);
  const refusal = JSON.parse(result.stderr); assert.equal(refusal.notRun, true); assert.equal(refusal.complete, false);
});

for (const sink of ['stdout', 'stderr']) test(`recorder sink failure: ${sink} returns incomplete evidence and reaps the runner`, t => {
  const f = recorderFixture(t, sink);
  let pid;
  t.after(() => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const result = f.run(`require('fs').writeFileSync(${JSON.stringify(f.pidFile)}, String(process.pid));process.${sink}.write('original bytes');setInterval(()=>{},1000);`);
  pid = Number(readFileSync(f.pidFile, 'utf8'));
  assert.equal(result.status, 1, result.stderr);
  let alive = false; try { process.kill(pid, 0); alive = true; } catch (error) { assert.equal(error.code, 'ESRCH'); }
  assert.equal(alive, false, 'Recorder must stop and reap its runner after a sink error');
  const receipt = JSON.parse(readFileSync(`${f.stem}.receipt.txt`, 'utf8'));
  assert.equal(receipt.complete, false); assert.match(receipt.error, /fixture sink failure/);
  assert.equal(receipt.signal, 'SIGKILL'); assert.equal(receipt.exit, null);
});

test('recorder spawn failure records an incomplete receipt and exits nonzero', t => {
  const f = recorderFixture(t);
  const result = spawnSync(process.execPath, [script, '--output', f.stem, '--by', 'fixture-recorder', '--', path.join(f.directory, 'missing-executable')], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(readFileSync(`${f.stem}.receipt.txt`, 'utf8'));
  assert.equal(receipt.complete, false); assert.match(receipt.error, /ENOENT/);
});

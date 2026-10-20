import './home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
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
  const run = code => spawnSync(process.execPath, ['--import', hook, script, '--output', stem, '--by', 'fixture-recorder', '--', process.execPath, '-e', code], { encoding: 'utf8', timeout: 15000 });
  return { directory, stem, marker, pidFile, run };
}

for (const shell of ['csh', 'tcsh']) test(`${shell} recorder refusal happens before runner spawn`, t => {
  const f = recorderFixture(t);
  writeFileSync(path.join(f.directory, 'hook.mjs'), `import fs from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const spawn = cp.spawn; cp.spawn = (...args) => { fs.writeFileSync(${JSON.stringify(f.marker)}, 'spawn attempted'); return spawn(process.execPath, ['-e', ''], args[2]); }; syncBuiltinESMExports();`);
  for (const command of [[`/bin/${shell}`, '-f', '-c', 'unset anyerror; /usr/bin/false | /bin/cat'],
    ['env', 'CACHE=fixture', `/bin/${shell}`, '-f', '-c', 'unset anyerror; /usr/bin/false | /bin/cat']]) {
    const result = spawnSync(process.execPath, ['--import', path.join(f.directory, 'hook.mjs'), script, '--output', f.stem, '--by', 'fixture-recorder', '--', ...command], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(f.marker), false, 'Refused shell must never reach runner spawn');
    assert.equal(existsSync(`${f.stem}.receipt.txt`), false);
    assert.match(result.stderr, /runner executable directly/);
  }
});

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
  const result = f.run(`require('fs').writeFileSync(${JSON.stringify(f.pidFile)}, String(process.pid));process.${sink}.write('original bytes');setTimeout(()=>process.exit(0),5000);`);
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

for (const fault of ['callback', 'lock-release', 'raw-read', 'receipt-write', 'receipt-close']) {
  test(`post-spawn ${fault} failure preserves owned child close and original exit 7`, t => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pb-direct-receipt-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const stem = path.join(directory, 'run'), harness = path.join(directory, 'harness.mjs');
    const recorder = new URL('../lib/bb-direct-command.js', import.meta.url).href;
    const host = new URL('../dist/host-index.js', import.meta.url).href;
    writeFileSync(harness, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
import {recordBbDirectCommand} from ${JSON.stringify(recorder)};import {withDirLock} from ${JSON.stringify(host)};
const fault=${JSON.stringify(fault)},stem=${JSON.stringify(stem)},marker=stem+'.entered',release=stem+'.release',lock=stem+'.lock';
const original={spawn:cp.spawn,open:fs.openSync,read:fs.readFileSync,write:fs.writeFileSync,close:fs.closeSync,rm:fs.rmSync};
let owned,closed,receiptFd,settled=false,witnessOut='',witnessErr='',triggered=false;
cp.spawn=(...args)=>{owned=original.spawn(...args);owned.stdout.on('data',b=>witnessOut+=b);owned.stderr.on('data',b=>witnessErr+=b);
closed=new Promise(resolve=>owned.on('close',(exit,signal)=>resolve({exit,signal})));return owned};
fs.openSync=(file,...args)=>{const fd=original.open(file,...args);if(String(file)===stem+'.receipt.txt')receiptFd=fd;return fd};
fs.readFileSync=(file,...args)=>{if(fault==='raw-read'&&String(file)===stem+'.stdout.txt'&&!triggered){triggered=true;throw new Error('fixture raw-read failure')}return original.read(file,...args)};
fs.writeFileSync=(file,...args)=>{if(fault==='receipt-write'&&file===receiptFd&&!triggered){triggered=true;throw new Error('fixture receipt-write failure')}return original.write(file,...args)};
fs.closeSync=fd=>{if(fault==='receipt-close'&&fd===receiptFd&&!triggered){triggered=true;original.close(fd);throw new Error('fixture receipt-close failure')}return original.close(fd)};
fs.rmSync=(file,...args)=>{if(fault==='lock-release'&&String(file)===lock&&!triggered){triggered=true;throw new Error('fixture lock-release failure')}return original.rm(file,...args)};syncBuiltinESMExports();
const command=[process.execPath,'-e',"const fs=require('fs');fs.writeFileSync("+JSON.stringify(marker)+",'entered');process.stdout.write('ORIGINAL_STDOUT\\\\n');process.stderr.write('ORIGINAL_ASSERTION\\\\n');const timer=setInterval(()=>{if(fs.existsSync("+JSON.stringify(release)+")){clearInterval(timer);process.exitCode=7}},10);setTimeout(()=>process.exit(7),10000).unref()"];
const fields={admission:{token:'exact-token',commandId:'run'},launcher:{sha256:'exact-launcher'}};
const recording=recordBbDirectCommand({command,stem,by:'fixture-owner',receiptFields:fields,beforeSpawn:start=>{
 if(fault==='lock-release')return withDirLock(lock,start,{onMissing:()=>new Error('missing'),onBusy:()=>new Error('busy')});
 const child=start();if(fault==='callback')throw new Error('fixture callback failure');return child;
}}).then(result=>{settled=true;return {result}},error=>{settled=true;return {error:error.message,receipt:error.receipt}});
let settledBeforeRelease;
try{while(!fs.existsSync(marker))await new Promise(resolve=>setTimeout(resolve,10));settledBeforeRelease=settled;}
finally{original.write(release,'release');owned.stdout.resume();owned.stderr.resume();await closed;}
const outcome=await recording,child=await closed;
cp.spawn=original.spawn;fs.openSync=original.open;fs.readFileSync=original.read;fs.writeFileSync=original.write;fs.closeSync=original.close;fs.rmSync=original.rm;syncBuiltinESMExports();
const report={fault,settledBeforeRelease,child,witnessOut,witnessErr,...outcome};original.write(stem+'.witness.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
`);
    const result = spawnSync(process.execPath, [harness], { encoding: 'utf8', timeout: 15000 });
    writeFileSync(path.join(directory, 'harness.stdout.txt'), result.stdout ?? '');
    writeFileSync(path.join(directory, 'harness.stderr.txt'), result.stderr ?? '');
    const evidenceFlag = process.argv.indexOf('--fault-evidence');
    if (evidenceFlag !== -1 && process.argv[evidenceFlag + 1]) {
      const destination = path.join(process.argv[evidenceFlag + 1], fault);
      mkdirSync(destination, { recursive: true }); cpSync(directory, destination, { recursive: true });
    }
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.child.exit, 7); assert.equal(report.child.signal, null);
    assert.equal(report.settledBeforeRelease, false, 'recorder must await owned child.close after its spawn callback throws');
    assert.equal(report.receipt.notRun, false);
    assert.equal(report.receipt.exit, 7); assert.equal(report.receipt.signal, null); assert.equal(report.receipt.error, null);
    assert.equal(report.receipt.finalizationComplete, false);
    assert.equal(report.receipt.admission.token, 'exact-token'); assert.equal(report.receipt.launcher.sha256, 'exact-launcher');
    assert.equal(readFileSync(`${stem}.stdout.txt`, 'utf8'), report.witnessOut);
    assert.equal(readFileSync(`${stem}.stderr.txt`, 'utf8'), report.witnessErr);
    assert.match(report.error, new RegExp(`fixture ${fault} failure`));
  });
}

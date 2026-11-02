import { check } from './check.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DARWIN_IMAGE_SHA256, recognizeKernelRead } from './kernel-read-shapes.mjs';
import { makeSandbox } from './sandbox.mjs';

const root = makeSandbox('pb-kernel-read-shapes-');
const body = readFileSync(new URL('../lib/root-process.ts', import.meta.url), 'utf8').match(/const DARWIN_IMAGE = `([^`]+)`;/)?.[1];
check('the Darwin image exception pins the reviewed JXA body bytes', typeof body === 'string'
  && createHash('sha256').update(body).digest('hex') === DARWIN_IMAGE_SHA256);
const common = { version: 1, platform: 'darwin', pid: '123' };
const reads = [
  ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', body, '123'], { ...common, shape: 'process-image', bodySha256: DARWIN_IMAGE_SHA256 }],
  ['/bin/ps', ['-p', '123', '-o', 'ppid='], { ...common, shape: 'process-parent' }],
  ['/usr/sbin/lsof', ['-b', '-p', '123', '-FpiD'], { ...common, shape: 'process-files' }],
  ['/bin/ps', ['-p', '123', '-o', 'stat=', '-o', 'lstart='], { ...common, shape: 'process-lifetime' }],
];
const line = (cmd, resolved, metadata) => `${cmd}\t${resolved}\t${JSON.stringify(metadata)}`;
for (const [cmd, , metadata] of reads) {
  check(`${metadata.shape} recognizes only its exact Darwin command and records its reason`, recognizeKernelRead(line(cmd, cmd, metadata), 'darwin')?.shape === metadata.shape
    && Boolean(recognizeKernelRead(line(cmd, cmd, metadata), 'darwin')?.reason));
  for (const platform of ['linux', 'win32']) check(`${metadata.shape} is not an exception on ${platform}`, !recognizeKernelRead(line(cmd, cmd, metadata), platform));
  for (const [actual, resolved] of [[path.basename(cmd), cmd], [cmd, `/actor${cmd}`], [`/actor${cmd}`, cmd]]) {
    check('a system basename or changed resolved path cannot claim the kernel exception', !recognizeKernelRead(line(actual, resolved, metadata), 'darwin'));
  }
  for (const pid of ['', '0', '-1', '01', '1e3', '2147483648', '123\n', 123]) {
    check('kernel metadata requires a canonical positive Darwin PID', !recognizeKernelRead(line(cmd, cmd, { ...metadata, pid }), 'darwin'));
  }
  for (const changed of [null, [], {}, { ...metadata, platform: 'linux' }, { ...metadata, version: '1' }, { ...metadata, shape: 'caller-approved' }, { ...metadata, trusted: true }]) {
    check('missing or caller-extended metadata cannot exempt an outside command', !recognizeKernelRead(line(cmd, cmd, changed), 'darwin'));
  }
  for (const raw of [`${cmd}\t${cmd}`, `${cmd}\t${cmd}\t{broken`, `${line(cmd, cmd, metadata)}\textra`, `${cmd}\t${cmd}\t${' '.repeat(16385)}`]) {
    check('malformed or unbounded metadata remains unrecognized', !recognizeKernelRead(raw, 'darwin'));
  }
}
for (const file of ['relative.db', '/', '/private/tmp/../owned.db', '/private/tmp/owned.db/', '/private/tmp/x\n', '/private/tmp/x\t', '/private/tmp/x\0', '/private/tmp/x\x7f', '/private/tmp/x\x85', '/private/tmp/x\u2028', '/private/tmp/x\u2029', `/${'x'.repeat(4096)}`]) {
  check('numeric FD metadata cannot carry an added path selector', !recognizeKernelRead(line('/usr/sbin/lsof', '/usr/sbin/lsof', { ...reads[2][2], file }), 'darwin'));
}
check('an altered JXA digest cannot claim the reviewed kernel reader', !recognizeKernelRead(line('/usr/bin/osascript', '/usr/bin/osascript', { ...reads[0][2], bodySha256: '0'.repeat(64) }), 'darwin'));

// Only simulated spawns run below. Negative JXA strings are data and never reach an OS interpreter.
const syncImport = "import { spawnSync } from 'node:child_process';", asyncImport = "import { spawn } from 'node:child_process';";
const source = readFileSync(new URL('../lib/exec.js', import.meta.url), 'utf8');
if (!source.includes(syncImport) || !source.includes(asyncImport)) throw new Error('Kernel trace fixture could not replace both spawn boundaries');
const fixture = source.replaceAll('process.platform', "'darwin'")
  .replace(syncImport, "const spawnSync = () => ({ status: 0, error: null, stdout: '', stderr: '' });")
  .replace(asyncImport, `import { EventEmitter } from 'node:events';
const spawn = () => { const child = new EventEmitter(); child.pid = 123; child.kill = () => {};
queueMicrotask(() => child.emit('close', 0, null)); return child; };`);
const moduleFile = path.join(root, 'exec-fixture.mjs'), traceFile = path.join(root, 'trace');
writeFileSync(moduleFile, fixture);
const execution = await import(pathToFileURL(moduleFile).href);
const previous = process.env.PROMPTOBUS_EXEC_TRACE;
process.env.PROMPTOBUS_EXEC_TRACE = traceFile;
const env = { PATH: path.join(root, 'actor-poison'), UNRELATED_SECRET: 'must-not-be-logged' };
try {
  for (const [cmd, args, metadata] of reads) {
    execution.run(cmd, args, { env });
    const synchronous = readFileSync(traceFile, 'utf8').trimEnd().split('\n').at(-1).split('\t');
    check('synchronous exec derives the same fixed metadata from actual arguments', synchronous.length === 3
      && synchronous[0] === cmd && synchronous[1] === cmd && isDeepStrictEqual(JSON.parse(synchronous[2]), metadata));
    await execution.runAsync(cmd, args, { env });
    const actual = readFileSync(traceFile, 'utf8').trimEnd().split('\n').at(-1);
    const fields = actual.split('\t');
    check('exec derives fixed metadata from actual arguments despite actor PATH', fields.length === 3 && fields[0] === cmd && fields[1] === cmd
      && isDeepStrictEqual(JSON.parse(fields[2]), metadata));
  }
  const denied = [
    ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', `${body}\n`, '123']],
    ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', '1 + 1', '123']],
    ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', body, '123', 'extra']],
    ['/bin/ps', ['-p', '123', '-o', 'pid=']], ['/bin/ps', ['-p', '123', '-o', 'ppid=', '-A']],
    ['/bin/ps', ['-p', '01', '-o', 'ppid=']], ['/actor/ps', ['-p', '123', '-o', 'ppid=']],
    ['/bin/ps', ['-p', '123', '-o', 'stat=', '-o', 'lstart=', '-A']],
    ['/bin/ps', ['-p', '123', '-o', 'lstart=', '-o', 'stat=']],
    ['/bin/ps', ['-p', '123', '-o', 'stat=', '-o', 'args=']],
    ['/bin/ps', ['-p', '01', '-o', 'stat=', '-o', 'lstart=']],
    ['ps', ['-p', '123', '-o', 'stat=', '-o', 'lstart=']],
    ['/usr/sbin/lsof', ['-p', '123', '-FpiD']],
    ['/usr/sbin/lsof', ['-p', '123', '-FpiDn']],
    ['/usr/sbin/lsof', ['-p', '123,456', '-FpiD']],
    ['/usr/sbin/lsof', ['-p', '01', '-FpiD']],
    ['/usr/sbin/lsof', ['-p', '123', '-FpiD', '/private/tmp/owned.db']],
    ['lsof', ['-b', '-p', '123', '-FpiD']],
    ['/usr/sbin/lsof', ['-a', '-p', '123', '-Fpn', 'relative']],
    ['/usr/sbin/lsof', ['-a', '-p', '123', '-Fpn', '/private/tmp/x\n']],
    ['/usr/sbin/lsof', ['-a', '-p', '123', '-Fpn', '/private/tmp/x\x85']],
    ['/usr/sbin/lsof', ['-a', '-p', '123', '-Fpn', '/private/tmp/x\u2028']],
    ['/usr/sbin/lsof', ['-a', '-p', '123', '-Fpn', '/private/tmp/owned.db', 'extra']],
  ];
  for (const [cmd, args] of denied) {
    execution.run(cmd, args, { env });
    const actual = readFileSync(traceFile, 'utf8').trimEnd().split('\n').at(-1);
    check('other actual argv retain the ordinary two-column trace and no exception', actual === `${cmd}\t${path.isAbsolute(cmd) ? cmd : '(unresolved)'}`
      && !recognizeKernelRead(actual, 'darwin'));
  }
  check('trace metadata logs no arbitrary argv, JXA text, environment or credential', !readFileSync(traceFile, 'utf8').includes('must-not-be-logged')
    && !readFileSync(traceFile, 'utf8').includes(body) && !readFileSync(traceFile, 'utf8').includes('1 + 1'));
} finally {
  if (previous === undefined) delete process.env.PROMPTOBUS_EXEC_TRACE;
  else process.env.PROMPTOBUS_EXEC_TRACE = previous;
}

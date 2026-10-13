import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { assertBbDirectCommand } from '../lib/bb-direct-command.js';

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
if (separator !== 4 || argv[0] !== '--output' || argv[2] !== '--by' || !argv[1] || !argv[3] || !argv[separator + 1]) {
  throw new Error('usage: node scripts/bb-record-command.mjs --output <absolute-stem> --by <authenticated-actor> -- <executable> [args]');
}
const stem = argv[1], by = argv[3], command = argv.slice(separator + 1);
if (!path.isAbsolute(stem)) throw new Error('--output requires an absolute path');
assertBbDirectCommand(command);
const tree = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const status = execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' });
const outputs = new Map();
try {
  for (const stream of ['stdout', 'stderr', 'receipt']) outputs.set(stream, openSync(`${stem}.${stream}.txt`, 'wx'));
} catch (failure) {
  for (const fd of outputs.values()) closeSync(fd);
  process.stderr.write(`${JSON.stringify({ command, by, tree, dirty: status !== '', notRun: true, complete: false, error: failure.message })}\n`);
  process.exit(1);
}
const stdout = createWriteStream(`${stem}.stdout.txt`, { fd: outputs.get('stdout') });
const stderr = createWriteStream(`${stem}.stderr.txt`, { fd: outputs.get('stderr') });
let error = null, child;
const sinkFailure = failure => {
  error ??= failure.message;
  if (child) {
    child.stdout.unpipe(stdout); child.stderr.unpipe(stderr);
    child.stdout.resume(); child.stderr.resume();
    child.kill('SIGKILL');
  }
  stdout.destroy(); stderr.destroy();
};
stdout.on('error', sinkFailure); stderr.on('error', sinkFailure);
const sinks = [finished(stdout), finished(stderr)].map(promise => promise.catch(sinkFailure));
const started = new Date().toISOString();
child = spawn(command[0], command.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
child.on('error', failure => { error ??= failure.message; });
child.stdout.pipe(stdout); child.stderr.pipe(stderr);
const [exit, signal] = await new Promise(resolve => child.on('close', (exit, signal) => resolve([exit, signal])));
await Promise.all(sinks);
const raw = stream => {
  const file = `${stem}.${stream}.txt`, bytes = readFileSync(file);
  return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const receipt = { format: 'bb-direct-command-v1', command, exit, signal, error, direct: true, complete: exit !== null && signal === null && error === null,
  tree, dirty: status !== '', status, by, timestamp: started, ended: new Date().toISOString(), stdout: raw('stdout'), stderr: raw('stderr') };
try { writeFileSync(outputs.get('receipt'), `${JSON.stringify(receipt, null, 2)}\n`); }
finally { closeSync(outputs.get('receipt')); }
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exitCode = error ? 1 : exit ?? 1;

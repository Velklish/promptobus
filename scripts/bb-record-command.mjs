import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
if (separator !== 4 || argv[0] !== '--output' || argv[2] !== '--by' || !argv[1] || !argv[3] || !argv[separator + 1]) {
  throw new Error('usage: node scripts/bb-record-command.mjs --output <absolute-stem> --by <authenticated-actor> -- <executable> [args]');
}
const stem = argv[1], by = argv[3], command = argv.slice(separator + 1);
if (!path.isAbsolute(stem)) throw new Error('--output requires an absolute path');
if (['sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'pwsh'].includes(path.basename(command[0]))) {
  throw new Error('Record the runner executable directly; shell pipeline return codes are unsupported');
}
const tree = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const status = execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' });
const stdout = createWriteStream(`${stem}.stdout.txt`, { flags: 'wx' });
const stderr = createWriteStream(`${stem}.stderr.txt`, { flags: 'wx' });
const started = new Date().toISOString();
const child = spawn(command[0], command.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stdout); child.stderr.pipe(stderr);
let error = null;
child.on('error', failure => { error = failure.message; });
const [exit, signal] = await new Promise(resolve => child.on('close', (exit, signal) => resolve([exit, signal])));
await Promise.all([finished(stdout), finished(stderr)]);
const raw = stream => {
  const file = `${stem}.${stream}.txt`, bytes = readFileSync(file);
  return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const receipt = { format: 'bb-direct-command-v1', command, exit, signal, error, direct: true, complete: exit !== null && signal === null && error === null,
  tree, dirty: status !== '', status, by, timestamp: started, ended: new Date().toISOString(), stdout: raw('stdout'), stderr: raw('stderr') };
writeFileSync(`${stem}.receipt.txt`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(receipt)}\n`);
process.exitCode = exit ?? 1;

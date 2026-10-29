import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createWriteStream, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

type DirectChild = ChildProcessByStdio<null, Readable, Readable>;
export interface DirectCommandReceipt {
  command: readonly string[]; by: string; cwd: string; complete: boolean;
  exit: number | null; signal: NodeJS.Signals | null; error: string | null;
  [key: string]: unknown;
}
interface ReceiptFailure extends Error { receipt?: Record<string, unknown> }
export interface DirectCommandInput {
  command: readonly string[]; stem: string; by: string; cwd?: string; env?: NodeJS.ProcessEnv;
  beforeSpawn?: (start: () => DirectChild) => unknown;
  onReceipt?: (receipt: DirectCommandReceipt) => unknown;
  receiptFields?: Record<string, unknown>;
  spawnPlan?: { file: string; args: readonly string[]; verbatim?: boolean };
}

export function assertBbDirectCommand(command: readonly string[]) {
  let executable = command[0];
  if (path.basename(executable ?? '') === 'env') {
    let index = 1;
    if (command[index] === '--') index++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index] ?? '')) index++;
    executable = command[index];
    if (!executable || executable.startsWith('-') || path.basename(executable) === 'env') {
      throw new Error('Unsupported env launcher; record the runner executable directly');
    }
  }
  if (!executable || ['sh', 'bash', 'zsh', 'fish', 'dash', 'ash', 'ksh', 'ksh93', 'csh', 'tcsh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']
    .includes(path.basename(executable).toLowerCase())) {
    throw new Error('Record the runner executable directly; shell pipeline return codes are unsupported');
  }
}

export async function recordBbDirectCommand({ command, stem, by, cwd = process.cwd(), env = process.env, beforeSpawn, onReceipt, receiptFields, spawnPlan }: DirectCommandInput) {
  if (!path.isAbsolute(stem)) throw new Error('--output requires an absolute path');
  assertBbDirectCommand(command);
  const tree = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd }).trim();
  const status = execFileSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8', cwd });
  const outputs = new Map<string, number>();
  try {
    for (const stream of ['stdout', 'stderr', 'receipt']) outputs.set(stream, openSync(`${stem}.${stream}.txt`, 'wx'));
  } catch (caught) {
    const failure = caught as ReceiptFailure;
    for (const fd of outputs.values()) closeSync(fd);
    failure.receipt = { command, by, tree, dirty: status !== '', notRun: true, complete: false, error: failure.message };
    throw failure;
  }
  const stdout = createWriteStream(`${stem}.stdout.txt`, { fd: outputs.get('stdout') });
  const stderr = createWriteStream(`${stem}.stderr.txt`, { fd: outputs.get('stderr') });
  let error: string | null = null, child: DirectChild | undefined, startFailure: ReceiptFailure | undefined;
  const sinkFailure = (failure: Error) => {
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
  try {
    const start = () => (child = spawn(spawnPlan?.file ?? command[0], spawnPlan?.args ?? command.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd, env, windowsVerbatimArguments: spawnPlan?.verbatim }));
    if (beforeSpawn) beforeSpawn(start); else start();
  } catch (caught) {
    const failure = caught as ReceiptFailure;
    if (child) startFailure = failure;
    else {
    stdout.end(); stderr.end(); await Promise.all(sinks);
    const receipt = { command, by, cwd, tree, dirty: status !== '', notRun: true, complete: false, error: failure.message };
    try { writeFileSync(outputs.get('receipt')!, `${JSON.stringify(receipt)}\n`); } finally { closeSync(outputs.get('receipt')!); }
    failure.receipt = receipt; throw failure;
    }
  }
  const execution: DirectCommandReceipt = { format: 'bb-direct-command-v1', command, exit: null, signal: null, error: null, direct: true, complete: false,
    ...receiptFields, tree, dirty: status !== '', status, by, cwd, timestamp: started };
  try {
  const runningChild = child!;
  runningChild.on('error', failure => { error ??= failure.message; });
  runningChild.stdout.pipe(stdout); runningChild.stderr.pipe(stderr);
  const [exit, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => runningChild.on('close', (exit, signal) => resolve([exit, signal])));
  await Promise.all(sinks);
  Object.assign(execution, { exit, signal, error, ended: new Date().toISOString() });
  const raw = (stream: string) => {
    const file = `${stem}.${stream}.txt`, bytes = readFileSync(file);
    return { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const receipt = { ...execution, complete: exit !== null && signal === null && error === null,
    ...(startFailure ? { finalizationComplete: false, finalizationError: startFailure.message } : {}), stdout: raw('stdout'), stderr: raw('stderr') };
  try { writeFileSync(outputs.get('receipt')!, `${JSON.stringify(receipt, null, 2)}\n`); }
  finally { closeSync(outputs.get('receipt')!); }
  if (startFailure) { startFailure.receipt = { ...receipt, notRun: false }; throw startFailure; }
  try { onReceipt?.(receipt); } catch (caught) {
    const failure = caught as ReceiptFailure; failure.receipt = { ...receipt, notRun: false, finalizationComplete: false, finalizationError: failure.message }; throw failure; }
  return { receipt, exitCode: error ? 1 : exit ?? 1 };
  } catch (caught) {
    const failure = caught as ReceiptFailure;
    failure.receipt ??= { ...execution, notRun: false, complete: false, finalizationComplete: false, finalizationError: failure.message };
    throw failure;
  }
}

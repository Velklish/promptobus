import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { constants, createWriteStream, existsSync, fstatSync, lstatSync, readSync, writeFileSync, openSync, closeSync, renameSync, rmSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
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
  onReceipt?: (receipt: DirectCommandReceipt, publishedSha256: string) => unknown;
  receiptFields?: Record<string, unknown>;
  spawnPlan?: { file: string; args: readonly string[]; verbatim?: boolean };
}

function readEvidence(file: string, maximum: number, budgetMs: number, expected?: Buffer) {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('Invalid evidence read budget');
  const deadline = performance.now() + Math.min(budgetMs, 5000);
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid evidence size limit');
  const before = lstatSync(file);
  if (!before.isFile()) throw new Error('Evidence must be a regular file');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maximum || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Evidence must be the same size-bounded regular file');
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(Math.min(opened.size, 65536));
    const checkTime = () => { if (performance.now() >= deadline) throw new Error('Evidence read deadline exceeded'); };
    for (let offset = 0; offset < opened.size;) {
      checkTime();
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
      if (!n) throw new Error('Evidence truncated during read');
      const part = chunk.subarray(0, n);
      if (expected && !part.equals(expected.subarray(offset, offset + n))) throw new Error('Evidence readback mismatch');
      hash.update(part); offset += n;
    }
    const after = lstatSync(file);
    if (!after.isFile() || opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size || opened.ctimeMs !== after.ctimeMs) throw new Error('Evidence changed during read');
    checkTime();
    return { bytes: opened.size, sha256: hash.digest('hex') };
  } finally { closeSync(fd); }
}

export function digestRegularEvidence(file: string, maximum: number, budgetMs = 5000) {
  return readEvidence(file, maximum, budgetMs);
}

export function publishCommandEvidence(file: string, content: string) {
  const stage = `${file}.${randomUUID()}.tmp`, fd = openSync(stage, 'wx', 0o600);
  try {
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
    try { renameSync(stage, file); } catch (failure) {
      let committed = false;
      const expected = Buffer.from(content);
      try { committed = !existsSync(stage) && readEvidence(file, expected.length, 5000, expected).bytes === expected.length; } catch { /* destination unavailable */ }
      if (!committed) throw failure;
      process.stderr.write(`Command evidence committed with warning: ${String(failure)}\n`);
    }
  } catch (failure) { rmSync(stage, { force: true }); throw failure; }
}

export function capturedStreamMatches(captured: { bytes: number; sha256: string }, stored: ReturnType<typeof digestRegularEvidence>) {
  return captured.bytes === stored.bytes && captured.sha256 === stored.sha256;
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
  const receiptFd = outputs.get('receipt')!;
  let receiptOpen = true;
  const closeReceipt = () => {
    if (!receiptOpen) return;
    receiptOpen = false;
    closeSync(receiptFd);
  };
  const stdout = createWriteStream(`${stem}.stdout.txt`, { fd: outputs.get('stdout') });
  const stderr = createWriteStream(`${stem}.stderr.txt`, { fd: outputs.get('stderr') });
  let error: string | null = null, child: DirectChild | undefined, startFailure: ReceiptFailure | undefined;
  const stop = { firstSignal: null as NodeJS.Signals | null, received: 0, forwarded: 0 };
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? [] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = (signal: NodeJS.Signals) => {
    stop.firstSignal ??= signal; stop.received++;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { if (child.kill(signal)) stop.forwarded++; } catch (failure) { error ??= String(failure); }
    }
  };
  const detach = () => { for (const signal of signals) process.off(signal, forward); };
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
    const start = () => {
      if (child) throw new Error('Direct recorder already owns a child');
      for (const signal of signals) process.on(signal, forward);
      return child = spawn(spawnPlan?.file ?? command[0], spawnPlan?.args ?? command.slice(1), { shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd, env, windowsVerbatimArguments: spawnPlan?.verbatim });
    };
    if (beforeSpawn) beforeSpawn(start); else start();
  } catch (caught) {
    const failure = caught as ReceiptFailure;
    if (child) startFailure = failure;
    else {
    detach();
    stdout.end(); stderr.end(); await Promise.all(sinks);
    const receipt = { command, by, cwd, tree, dirty: status !== '', notRun: true, complete: false, error: failure.message };
    try { writeFileSync(outputs.get('receipt')!, `${JSON.stringify(receipt)}\n`); } finally { closeReceipt(); }
    failure.receipt = receipt; throw failure;
    }
  }
  const execution: DirectCommandReceipt = { format: 'bb-direct-command-v1', command, exit: null, signal: null, error: null, direct: true, complete: false,
    ...receiptFields, tree, dirty: status !== '', status, by, cwd, timestamp: started };
  try {
  const runningChild = child!;
  runningChild.on('error', failure => { error ??= failure.message; });
  const capture = (stream: Readable) => {
    const hash = createHash('sha256'); let bytes = 0;
    stream.on('data', (chunk: Buffer) => { hash.update(chunk); bytes += chunk.length; });
    return () => ({ bytes, sha256: hash.digest('hex') });
  };
  const captured = { stdout: capture(runningChild.stdout), stderr: capture(runningChild.stderr) };
  runningChild.stdout.pipe(stdout); runningChild.stderr.pipe(stderr);
  const [exit, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => runningChild.on('close', (exit, signal) => resolve([exit, signal])));
  await Promise.all(sinks);
  Object.assign(execution, { exit, signal, error, ...(stop.received ? { stop } : {}), terminationObserved: error === null && (exit !== null || signal !== null), ended: new Date().toISOString() });
  const raw = (stream: keyof typeof captured) => {
    const file = `${stem}.${stream}.txt`, observed = captured[stream](), stored = digestRegularEvidence(file, observed.bytes);
    if (error) return { file, ...stored };
    if (!capturedStreamMatches(observed, stored)) throw new Error(`Captured ${stream} differs from the published stream`);
    return { file, ...observed };
  };
  const receipt = { ...execution, complete: !stop.received && exit !== null && signal === null && error === null,
    ...(startFailure ? { finalizationComplete: false, finalizationError: startFailure.message } : {}), stdout: raw('stdout'), stderr: raw('stderr') };
  closeReceipt();
  const content = `${JSON.stringify(receipt, null, 2)}\n`, digest = createHash('sha256').update(content).digest('hex');
  publishCommandEvidence(`${stem}.receipt.txt`, content);
  if (startFailure) { startFailure.receipt = { ...receipt, notRun: false }; throw startFailure; }
  try { onReceipt?.(receipt, digest); } catch (caught) {
    const failure = caught as ReceiptFailure; failure.receipt = { ...receipt, notRun: false, finalizationComplete: false, finalizationError: failure.message }; throw failure; }
  return { receipt, exitCode: error || (stop.received && exit === 0) ? 1 : exit ?? 1 };
  } catch (caught) {
    try { closeReceipt(); } catch { /* Preserve the primary finalization error. */ }
    const failure = caught as ReceiptFailure;
    failure.receipt ??= { ...execution, notRun: false, complete: false, finalizationComplete: false, finalizationError: failure.message };
    throw failure;
  } finally { detach(); }
}

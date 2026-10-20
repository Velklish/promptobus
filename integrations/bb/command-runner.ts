import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { assertBbDirectCommand, recordBbDirectCommand, underLease, leaseRoot, keyedCommandPlan } from 'promptobus/bb-host';
import { bindingSchema, toolsFor } from './protocol.js';
import { readDeclaredFile, underRoots, validateLaunchContext } from './launch-context.js';
import { writeFileAtomic } from 'promptobus/host';
import { controlReferenceSchema, commandCallSchema } from './control-schema.js';
import { commandReference, commandTerminal, admitCommand, completeCommand, executionCommand, commandDigest } from './control.js';
import { BUILD_IDENTITY } from './build-identity.js';
import type { Binding } from './protocol.js';
import type { ExecutionCommand } from './control-schema.js';

const inputSchema = z.object({ binding: bindingSchema, commandId: z.string().min(1) }).strict();
type Invocation = { command: string[]; stem: string; by: string };
function directory(file: string, roots: string[]) {
  if (path.resolve(file) !== file || realpathSync(file) !== file || !statSync(file).isDirectory() || !underRoots(file, roots)) {
    throw new Error('command path identity differs from normalized owned/read roots');
  }
}
function leaseDirectory(command: ExecutionCommand) {
  if (!command.env.PROMPTOBUS_LEASE_DIR || !path.isAbsolute(command.env.PROMPTOBUS_LEASE_DIR)) throw new Error('exact environment must pin the shared PROMPTOBUS_LEASE_DIR namespace');
  return command.env.PROMPTOBUS_LEASE_DIR;
}
function validateCommandEnvironment(command: ExecutionCommand) {
  if ([command.env.TMPDIR, command.env.TMP, command.env.TEMP].some(value => value !== command.tmpRoot)
    || ['XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'npm_config_logs_dir', 'NPM_CONFIG_LOGS_DIR'].some(key => command.env[key] !== command.cacheRoot)) {
    throw new Error('exact environment must configure TMPDIR/TMP/TEMP and XDG cache/config/state/data and npm cache/logs from granted roots');
  }
}
export function validateCommandPaths(binding: Binding, command: ExecutionCommand) {
  const launch = binding.launchContext!;
  for (const root of launch.readRoots) directory(root, launch.readRoots);
  for (const root of launch.ownedRoots) directory(root, launch.readRoots);
  for (const file of [command.cwd, command.buildRoot, command.tmpRoot, command.cacheRoot, path.dirname(command.output)]) directory(file, launch.ownedRoots);
  directory(leaseDirectory(command), launch.readRoots);
  directory(command.measurementScope, launch.readRoots);
  for (const key of command.exclusiveKeys) directory(realpathSync(key), launch.readRoots);
  if (!underRoots(command.cwd, [binding.environmentPath])) throw new Error('command cwd must belong to the granted repository');
  validateCommandEnvironment(command);
}
function parseInvocation(input: unknown, invocation: Invocation) {
  const { binding, commandId } = inputSchema.parse(input), command = executionCommand(binding, commandId);
  if (invocation.by !== binding.launchContext!.grant.actor || invocation.stem !== command.output || !isDeepStrictEqual(invocation.command, command.argv)) {
    throw new Error('invocation must equal the immutable command argv, output and actor');
  }
  assertBbDirectCommand(command.argv);
  return { binding, commandId, command };
}
function preflightCommand(input: unknown, invocation: Invocation) {
  const { binding, commandId, command } = parseInvocation(input, invocation), declaredTools = toolsFor(binding.role);
  const launch = validateLaunchContext(binding, binding.launchContext, declaredTools);
  for (const root of launch.readRoots) directory(root, launch.readRoots);
  const existingOwned = launch.ownedRoots.filter(root => {
    if (!lstatSync(root, { throwIfNoEntry: false })) return false;
    directory(root, launch.readRoots); return true;
  });
  for (const file of [binding.environmentPath, command.cwd]) directory(file, launch.ownedRoots);
  directory(leaseDirectory(command), launch.readRoots);
  directory(command.measurementScope, launch.readRoots);
  if (!underRoots(command.cwd, [binding.environmentPath])) throw new Error('command cwd must belong to the granted repository');
  validateCommandEnvironment(command);
  const missing = new Set<string>();
  for (const file of new Set([...launch.ownedRoots, command.buildRoot, command.tmpRoot, command.cacheRoot, path.dirname(command.output)])) {
    if (path.resolve(file) !== file || !underRoots(file, existingOwned)) throw new Error('setup directory requires an existing canonical owned ancestor');
    let ancestor = file;
    while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
      missing.add(ancestor); ancestor = path.dirname(ancestor);
    }
    directory(ancestor, existingOwned);
  }
  for (const key of command.exclusiveKeys) {
    if (lstatSync(key, { throwIfNoEntry: false })) directory(realpathSync(key), launch.readRoots);
    else if (!missing.has(key)) throw new Error('setup cannot create an undeclared exclusive key directory');
  }
  const createdDirectories = [...missing].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  for (const file of createdDirectories) {
    directory(path.dirname(file), existingOwned);
    mkdirSync(file, { mode: 0o700 }); directory(file, existingOwned);
  }
  validateCommandPaths(binding, command);
  return { mode: 'preflight', observation: 'setup', commandId, actor: launch.grant.actor, commandSha256: commandDigest(command),
    substantiveCommandStarted: false, declaredTools, createdDirectories,
    notChecked: ['dynamic-current-control', 'evidence-artifact-bytes', 'installed-tool-eligibility', 'execution-permissions'] };
}
export async function runBoundedCommand(input: unknown, invocation: Invocation) {
  const { binding, commandId, command } = parseInvocation(input, invocation);
  validateCommandPaths(binding, command);
  const env = { ...process.env, ...command.env }, locks: string[] = [];
  const me = { pid: process.pid, address: invocation.by, task: binding.task, command: command.argv.join(' '), cwd: command.cwd };
  let observedReceipt: Awaited<ReturnType<typeof recordBbDirectCommand>>['receipt'] | undefined;
  const keys = [...new Set(command.exclusiveKeys.map(key => realpathSync(key)))].sort();
  const enter = async (index: number): Promise<Awaited<ReturnType<typeof recordBbDirectCommand>>> => {
    if (index < keys.length) return underLease(leaseRoot(env), me, async lock => {
      locks.push(lock);
      try { return await enter(index + 1); } finally { locks.pop(); }
    }, { key: keys[index], log: line => process.stderr.write(`${line}\n`) });
    const resourceDirectory = path.join(leaseRoot(env), 'command-resources');
    const verifyResources = () => {
      if (!keys.length) return;
      mkdirSync(resourceDirectory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(resourceDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(resourceDirectory) !== resourceDirectory
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('resource claim directory must remain owned and canonical');
    };
    verifyResources();
    const resources = keys.map(key => path.join(resourceDirectory, `${createHash('sha256').update(key).digest('hex')}.json`));
    for (const file of resources) {
      if (!existsSync(file)) continue;
      const state = z.object({ reference: controlReferenceSchema, call: commandCallSchema }).strict()
        .parse(JSON.parse(readDeclaredFile(file, [resourceDirectory], 256 * 1024).toString('utf8')));
      if (!commandTerminal(state.reference, state.call.command)) throw new Error('resource has an unresolved admitted command; exact terminal receipt is required');
    }
    const launcherSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
    try {
    const result = await recordBbDirectCommand({ command: command.argv, stem: command.output, by: invocation.by, cwd: command.cwd, env,
      spawnPlan: keyedCommandPlan(command.argv, env, locks),
      beforeSpawn: start => admitCommand(binding, commandId, () => {
        const launch = binding.launchContext!;
        if (launch.control.mode !== 'current') throw new Error('current control is required');
        verifyResources();
        for (const file of resources) writeFileAtomic(file, `${JSON.stringify({ reference: launch.control.reference,
          call: { format: 'promptobus-bb-call-v1', command: commandReference(binding, command), state: 'admitted' } })}\n`, { mode: 0o600 });
        return start();
      }, () => {
        validateCommandPaths(binding, command);
        if (!isDeepStrictEqual([...new Set(command.exclusiveKeys.map(key => realpathSync(key)))].sort(), keys)) throw new Error('resource identity changed while waiting');
      }),
      onReceipt: () => completeCommand(binding, commandId),
      receiptFields: { admission: { task: binding.task, token: binding.launchContext!.grant.token, phase: binding.launchContext!.grant.phase,
        commandId, commandSha256: commandDigest(command) }, resourceNamespace: leaseRoot(env), launcher: { buildIdentity: BUILD_IDENTITY, sha256: launcherSha256 } } });
    observedReceipt = result.receipt;
    return result;
    } catch (error) {
      observedReceipt = (error as { receipt?: typeof observedReceipt }).receipt;
      throw error;
    }
  };
  try { return await enter(0); } catch (error) {
    if (observedReceipt) (error as { receipt?: typeof observedReceipt }).receipt ??= { ...observedReceipt,
      notRun: observedReceipt.notRun === true, finalizationComplete: false, finalizationError: String(error) };
    throw error;
  }
}
export async function commandMain(argv: string[]) {
  const preflight = argv[0] === '--preflight';
  if (preflight) argv = argv.slice(1);
  if (argv.indexOf('--') !== 6 || argv[0] !== '--admission' || argv[2] !== '--output' || argv[4] !== '--by' || !argv[7]
    || !path.isAbsolute(argv[1])) throw new Error('usage: command-runner [--preflight] --admission <absolute-input.json> --output <absolute-stem> --by <actor> -- <executable> [args]');
  const input = JSON.parse(readDeclaredFile(argv[1], [path.dirname(argv[1])], 1024 * 1024).toString('utf8'));
  if (!input.binding?.launchContext || !underRoots(realpathSync(argv[1]), input.binding.launchContext.ownedRoots)) throw new Error('admission input must be in a declared owned root');
  if (preflight) return { observation: preflightCommand(input, { command: argv.slice(7), stem: argv[3], by: argv[5] }), exitCode: 0 };
  return runBoundedCommand(input, { command: argv.slice(7), stem: argv[3], by: argv[5] });
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await commandMain(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify('observation' in result ? result.observation : result.receipt)}\n`); process.exitCode = result.exitCode;
  } catch (error) {
    const receipt = (error as { receipt?: object }).receipt;
    process.stderr.write(`${JSON.stringify(receipt ? { ...receipt, finalizationError: String(error) } : { notRun: true, complete: false, error: String(error) })}\n`); process.exitCode = 1;
  }
}

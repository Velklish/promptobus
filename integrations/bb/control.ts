import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { openEngine, ORCHESTRATOR, withTaskLock } from 'promptobus';
import { withDirLock, writeFileAtomic } from 'promptobus/host';
import { z } from 'zod';
import { commandCallSchema, executionCommandSchema, commandGrantSchema, controlPublicationSchema, controlReferenceSchema, currentControlSchema, tokenRecordSchema } from './control-schema.js';
import type { CommandGrant, ControlOutcome, ControlPublication, ControlReference, ExecutionCommand, CommandRef } from './control-schema.js';
import type { Binding, CommandBinding } from './protocol.js';
import { readDeclaredFile, underRoots } from './launch-context.js';

export const CURRENT_LIMIT = 1024 * 1024;
export const TOKEN_LIMIT = 256 * 1024;
class ControlError extends Error {
  constructor(readonly reason: string, message: string, readonly temporary = false) { super(`Current control ${reason}: ${message}`); }
}
function blocked(reason: string, message: string): never { throw new ControlError(reason, message); }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const grantDigest = (grant: CommandGrant) => hash(JSON.stringify(commandGrantSchema.parse(grant)));
export const tokenPath = (reference: ControlReference, token: string) => path.join(reference.directory, 'tokens', `${hash(token.trim())}.json`);
const engineFor = (reference: ControlReference) => openEngine({ root: reference.owner.root, recover: false, policy: () => ({ deny: true, reason: 'Control boundary only' }) });

function taskPresent(engine: ReturnType<typeof engineFor>, task: string) {
  try { statSync(engine.taskFile(task)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (existsSync(path.dirname(engine.taskFile(task)))) blocked('unreadable-task', 'canonical task directory exists without its task record; initialization is refused');
    return false;
  }
}

function normalize(reference: ControlReference, initialize = false) {
  if (path.resolve(reference.owner.root) !== reference.owner.root || realpathSync(reference.owner.root) !== reference.owner.root
    || reference.readRoots.some(root => path.resolve(root) !== root || realpathSync(root) !== root)
    || path.resolve(reference.directory) !== reference.directory || !underRoots(reference.directory, reference.readRoots)) {
    blocked('reference-mismatch', 'use normalized owner roots and an explicitly declared control directory');
  }
  if (initialize && !existsSync(reference.directory)) {
    const parent = path.dirname(reference.directory);
    if (realpathSync(parent) !== parent || !underRoots(parent, reference.readRoots)) blocked('reference-mismatch', 'control parent must already exist within owner roots');
    mkdirSync(reference.directory);
  }
  if (realpathSync(reference.directory) !== reference.directory || !statSync(reference.directory).isDirectory()) {
    blocked('reference-mismatch', 'control directory identity changed');
  }
}
function locked<T>(reference: ControlReference, fn: () => T) {
  normalize(reference);
  return withDirLock(path.join(reference.directory, '.lock'), () => { normalize(reference); return fn(); }, {
    waitMs: 100, onMissing: () => new ControlError('missing-current', 'initialize the declared control source explicitly'),
    onBusy: () => new ControlError('lock-busy', 'publisher or reader is busy; retry the bounded operation', true),
  });
}
function readJson<T>(reference: ControlReference, file: string, maximum: number, schema: z.ZodType<T>, kind: string): T {
  let bytes: Buffer;
  try {
    if (statSync(file).size > maximum) blocked(`oversized-${kind}`, `reduce ${kind} to its bounded current schema; history belongs in separate evidence`);
    bytes = readDeclaredFile(file, [reference.directory], maximum);
  } catch (error) {
    if (error instanceof ControlError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') blocked(`missing-${kind}`, `publish the exact ${kind} record before admission; no legacy fallback`);
    if (/exceeds limit/.test(String(error))) blocked(`oversized-${kind}`, `${kind} exceeds its bounded limit`);
    if (/outside declared roots/.test(String(error))) blocked('reference-mismatch', `${kind} is outside the declared directory`);
    if (/changed/.test(String(error))) throw new ControlError('read-race', `${kind} changed during bounded read; retry`, true);
    throw error;
  }
  try { return schema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { return blocked(`malformed-${kind}`, `repair the explicit ${kind} record; no legacy fallback`); }
}
const readCurrent = (r: ControlReference) => {
  const current = readJson(r, path.join(r.directory, 'current.json'), CURRENT_LIMIT, currentControlSchema, 'current');
  if (!isDeepStrictEqual(current.reference, r)) blocked('reference-mismatch', 'current source does not match the canonical owner declaration');
  return current;
};
function recordFor(reference: ControlReference, grant: CommandGrant, state: 'active' | 'ended') {
  return tokenRecordSchema.parse({ format: 'promptobus-bb-token-v1', task: grant.task, actor: grant.actor, token: grant.token, grantSha256: grantDigest(grant), state });
}
function verifyRecord(reference: ControlReference, grant: CommandGrant, state: 'active' | 'ended') {
  const record = readJson(reference, tokenPath(reference, grant.token), TOKEN_LIMIT, tokenRecordSchema, 'token');
  if (!isDeepStrictEqual(record, recordFor(reference, grant, record.state))) blocked('token-mismatch', 'token task, actor or immutable grant digest differs');
  if (record.state !== state) blocked(record.state === 'ended' ? 'ended-token' : 'predecessor-active', 'a fresh phase needs an exact ended predecessor and a different active token');
}
function serialized(value: unknown, maximum: number) {
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content) > maximum) blocked('oversized-publication', 'publication exceeds the bounded schema limit');
  return content;
}
function ownerMatches(binding: Binding, reference: ControlReference) {
  const owner = reference.owner;
  return binding.task === owner.task && binding.participant === owner.participant && binding.role === ORCHESTRATOR
    && binding.projectId === owner.projectId && binding.environmentId === owner.environmentId && binding.hostId === owner.hostId
    && binding.root === owner.root && binding.environmentPath === owner.root;
}
export function canonicalControl(binding: Pick<Binding, 'task'>, reference: ControlReference) {
  const engine = engineFor(reference);
  const task = engine.readTask(binding.task);
  const adapter = task.adapter.bb as { hostId?: string; root?: string; currentControl?: unknown } | undefined;
  const owner = task.participants.find(p => p.id === task.owner);
  const metadata = owner?.metadata.bb as Record<string, unknown> | undefined;
  if (task.owner !== ORCHESTRATOR || owner?.role !== ORCHESTRATOR || owner.harness !== 'bb' || owner.mode !== 'managed'
    || adapter?.hostId !== reference.owner.hostId || adapter.root !== reference.owner.root
    || metadata?.projectId !== reference.owner.projectId || metadata.environmentId !== reference.owner.environmentId
    || metadata.hostId !== reference.owner.hostId || metadata.environmentPath !== reference.owner.root) {
    blocked('owner-mismatch', 'canonical persisted owner identity does not match the declared source');
  }
  if (!adapter.currentControl) blocked('migration-required', 'legacy task has no current reference; preserve its history and explicitly initialize a new task');
  if (!isDeepStrictEqual(adapter.currentControl, reference)) blocked('reference-mismatch', 'use the immutable reference persisted by the canonical task owner');
  return { engine, task, owner, metadata };
}
function outcome(error: unknown): ControlOutcome {
  if (error instanceof ControlError) return { outcome: error.temporary ? 'unavailable' : 'blocked', reason: error.reason, message: error.message };
  const code = (error as NodeJS.ErrnoException).code;
  if (['EAGAIN', 'EBUSY', 'EINTR', 'ESTALE', 'EMFILE', 'ENFILE'].includes(code ?? '')) return { outcome: 'unavailable', reason: 'io-temporary', message: `Current control temporarily unavailable: ${code}` };
  return { outcome: 'blocked', reason: code === 'ENOENT' ? 'missing-current' : 'unreadable-current',
    message: 'Current control blocked: canonical task or declared current files cannot be verified; repair the explicit source without legacy fallback' };
}
export function readCurrentControl(binding: Binding, predecessor?: CommandGrant): ControlOutcome {
  const launch = binding.launchContext;
  if (!launch || launch.control.mode !== 'current') return { outcome: 'blocked', reason: 'migration-required', message: 'Current control migration required: legacy inline/file is evidence only; explicitly initialize a new task with a current reference' };
  try {
    const reference = controlReferenceSchema.parse(launch.control.reference);
    const engine = engineFor(reference);
    if (taskPresent(engine, binding.task)) canonicalControl(binding, reference);
    else if (binding.phase !== 'pending' || binding.threadId !== null || !ownerMatches(binding, reference)) blocked('owner-mismatch', 'only the explicitly initialized pending owner may create the canonical task');
    if (binding.task !== reference.owner.task || binding.projectId !== reference.owner.projectId || binding.hostId !== reference.owner.hostId
      || binding.root !== reference.owner.root || launch.grant.task !== binding.task || launch.grant.actor !== binding.participant
      || launch.grant.scope.repository !== binding.environmentPath || launch.grant.scope.branch !== binding.branch
      || launch.grant.scope.base !== binding.baseSha) blocked('owner-mismatch', 'binding task/actor/owned scope differs from the owner declaration and exact grant');
    return locked(reference, () => {
      const current = readCurrent(reference);
      if (!current.ownerConfirmed || current.STOP || current.noNewStages) blocked('stopped', 'owner confirmation, STOP or noNewStages denies admission; a publication is not physical Stop acknowledgement');
      if (!isDeepStrictEqual(current.grants[binding.participant], launch.grant)) blocked('grant-mismatch', 'publish this exact task/actor/scope grant before admission');
      verifyRecord(reference, launch.grant, 'active');
      if (predecessor) {
        if (predecessor.task !== launch.grant.task || predecessor.actor !== launch.grant.actor
          || predecessor.token === launch.grant.token || predecessor.phase === launch.grant.phase) blocked('predecessor-mismatch', 'fresh phase must retain task/actor and change token/phase');
        verifyRecord(reference, predecessor, 'ended');
      }
      return { outcome: 'allowed', revision: current.revision, ...(predecessor ? { predecessorEnded: true } : {}) };
    });
  } catch (error) { return outcome(error); }
}

export const commandDigest = (command: ExecutionCommand) => hash(JSON.stringify(executionCommandSchema.parse(command)));
const callPath = (r: ControlReference, command: CommandRef) => path.join(r.directory, 'calls', `${hash(JSON.stringify(command))}.json`);
export function commandTerminal(reference: ControlReference, command: CommandRef) {
  try {
    normalize(reference);
    canonicalControl({ task: reference.owner.task } as Binding, reference);
    readCurrent(reference);
    const call = readJson(reference, callPath(reference, command), TOKEN_LIMIT, commandCallSchema, 'call');
    if (!isDeepStrictEqual(call.command, command) || call.state !== 'terminal' || !call.receiptSha256) return false;
    const bytes = readDeclaredFile(`${command.output}.receipt.txt`, reference.readRoots, TOKEN_LIMIT);
    const receipt = JSON.parse(bytes.toString('utf8'));
    return hash(bytes.toString('utf8')) === call.receiptSha256 && receipt.complete === true && receipt.direct === true
      && receipt.by === command.actor && receipt.admission?.token === command.token && receipt.admission?.commandId === command.commandId
      && receipt.admission?.commandSha256 === command.commandSha256;
  } catch { return false; }
}
function fenceTransition(reference: ControlReference, publication: ControlPublication, previous: z.infer<typeof currentControlSchema> | null) {
  const unresolved = (previous?.pendingCommands ?? []).filter(command => !commandTerminal(reference, command));
  const old = previous?.measurementFence, next = publication.measurementFence;
  if (old && (!next || next.scope !== old.scope || next.cohort !== old.cohort)) {
    if ([...old.blockers, ...unresolved.filter(command => command.measurementScope === old.scope)].some(command => !commandTerminal(reference, command))) {
      blocked('measurement-busy', 'unresolved calls retain the previous measurement fence');
    }
  }
  if (next) {
    for (const member of next.members) {
      if (old?.members.some(previous => isDeepStrictEqual(previous, member)) && !publication.grants[member.actor]) continue;
      const grant = publication.grants[member.actor];
      if (!grant || grant.token !== member.token || grant.phase !== member.phase
        || !grant.execution?.commands.some(command => command.measurementScope === next.scope)) blocked('measurement-member', 'cohort member requires an exact current grant and command scope');
    }
    const retained = old?.scope === next.scope ? old.blockers.filter(command => !commandTerminal(reference, command)) : [];
    const continuing = old?.state === 'active' && next.state === 'active' && old.scope === next.scope && old.cohort === next.cohort
      && isDeepStrictEqual(old.members, next.members);
    const blockers = [...retained, ...(continuing ? [] : unresolved.filter(command => command.measurementScope === next.scope))];
    for (const command of next.blockers) if (!commandTerminal(reference, command)) blockers.push(command);
    next.blockers = [...new Map(blockers.map(command => [JSON.stringify(command), command])).values()];
    if (next.state === 'active' && (!old || old.scope !== next.scope || old.cohort !== next.cohort || next.blockers.length || (old.state === 'active' && !continuing))) {
      blocked('measurement-busy', 'activate only an explicitly draining cohort after every retained call has a terminal receipt');
    }
  }
  return unresolved;
}
export function commandReference(binding: CommandBinding, command: ExecutionCommand): CommandRef {
  const grant = binding.launchContext!.grant;
  return { actor: grant.actor, token: grant.token, phase: grant.phase, commandId: command.id,
    output: command.output, measurementScope: command.measurementScope, commandSha256: commandDigest(command) };
}
export function executionCommand(binding: CommandBinding, commandId: string) {
  const command = binding.launchContext?.grant.execution?.commands.find(command => command.id === commandId);
  if (!command) blocked('command-mismatch', 'the exact immutable grant must contain this command id');
  return command;
}
export function admitCommand<T>(binding: CommandBinding, commandId: string, start: () => T, validate: () => void = () => {}): T {
  const launch = binding.launchContext;
  if (!launch || launch.control.mode !== 'current') blocked('migration-required', 'bounded execution requires canonical current control');
  const reference = controlReferenceSchema.parse(launch.control.reference), engine = engineFor(reference);
  return withTaskLock(engine.home, binding.task, () => locked(reference, () => {
    const canonical = canonicalControl(binding, reference);
    if (canonical.task.status !== 'active') blocked('inactive-task', 'canonical task must remain active at command entry');
    const current = readCurrent(reference);
    if (binding.task !== reference.owner.task || binding.projectId !== reference.owner.projectId || binding.hostId !== reference.owner.hostId
      || binding.root !== reference.owner.root || launch.grant.task !== binding.task || launch.grant.actor !== binding.participant
      || launch.grant.scope.repository !== binding.environmentPath || launch.grant.scope.branch !== binding.branch
      || launch.grant.scope.base !== binding.baseSha) blocked('owner-mismatch', 'binding differs from the exact owner and grant');
    if (!current.ownerConfirmed || current.STOP || current.noNewStages) blocked('stopped', 'current owner flags deny command entry');
    if (!isDeepStrictEqual(current.grants[binding.participant], launch.grant)) blocked('grant-mismatch', 'publish this exact immutable command grant before entry');
    verifyRecord(reference, launch.grant, 'active');
    const command = executionCommand(binding, commandId), ref = commandReference(binding, command);
    const fence = current.measurementFence;
    if (fence?.scope === command.measurementScope && (fence.state !== 'active'
      || !fence.members.some(member => member.actor === ref.actor && member.token === ref.token && member.phase === ref.phase))) {
      blocked('measurement-fenced', 'current measurement fence denies command entry in this scope');
    }
    validate();
    const pending = (current.pendingCommands ?? []).filter(command => !commandTerminal(reference, command));
    const directory = path.join(reference.directory, 'calls');
    if (!existsSync(directory)) mkdirSync(directory);
    if (realpathSync(directory) !== directory) blocked('reference-mismatch', 'call directory identity changed');
    const file = callPath(reference, ref);
    if (existsSync(file)) blocked('command-used', 'immutable command entries are single use');
    if (pending.length >= 256) blocked('commands-full', 'finish retained calls before admitting more bounded commands');
    writeFileAtomic(file, serialized({ format: 'promptobus-bb-call-v1', command: ref, state: 'admitted' }, TOKEN_LIMIT), { mode: 0o600 });
    writeFileAtomic(path.join(reference.directory, 'current.json'), serialized({ ...current, pendingCommands: [...pending, ref] }, CURRENT_LIMIT), { mode: 0o600 });
    return start();
  }));
}
export function completeCommand(binding: CommandBinding, commandId: string) {
  const launch = binding.launchContext;
  if (!launch || launch.control.mode !== 'current') blocked('migration-required', 'bounded execution requires current control');
  const reference = launch.control.reference, ref = commandReference(binding, executionCommand(binding, commandId));
  return locked(reference, () => {
    const call = readJson(reference, callPath(reference, ref), TOKEN_LIMIT, commandCallSchema, 'call');
    if (!isDeepStrictEqual(call.command, ref)) blocked('command-mismatch', 'terminal command differs from admitted call');
    const bytes = readDeclaredFile(`${ref.output}.receipt.txt`, reference.readRoots, TOKEN_LIMIT);
    const receipt = JSON.parse(bytes.toString('utf8'));
    if (receipt.complete !== true || receipt.direct !== true) return;
    writeFileAtomic(callPath(reference, ref), serialized({ ...call, state: 'terminal', receiptSha256: hash(bytes.toString('utf8')) }, TOKEN_LIMIT), { mode: 0o600 });
  });
}

export function publishControl(input: unknown, options: { initialize: boolean; expectedRevision: number | null; binding?: Binding; denyOnly?: boolean },
  fault: (point: 'tokens' | 'current') => void = () => {}) {
  const publication = controlPublicationSchema.parse(input);
  const reference = publication.reference;
  const engine = engineFor(reference);
  const publish = (denyOnly: boolean) => locked(reference, () => {
    const tokenDirectory = path.join(reference.directory, 'tokens');
    if (options.initialize && !existsSync(tokenDirectory)) mkdirSync(tokenDirectory);
    if (realpathSync(tokenDirectory) !== tokenDirectory) blocked('reference-mismatch', 'token directory identity changed');
    const file = path.join(reference.directory, 'current.json');
    if (options.initialize && existsSync(file)) blocked('already-initialized', 'use expected revision for an existing source');
    const previous = options.initialize ? null : readCurrent(reference);
    if ((previous?.revision ?? null) !== options.expectedRevision) blocked('stale-revision', 'read the current revision and retry with an explicit complete publication');
    if (options.initialize && (!publication.ownerConfirmed || publication.STOP || publication.noNewStages || !publication.grants.orchestrator || publication.grants.orchestrator.scope.repository !== reference.owner.root)) {
      blocked('initial-confirmation', 'initialization requires explicitly supplied confirmed active authority');
    }
    if (denyOnly && previous && ((previous.STOP && !publication.STOP) || (previous.noNewStages && !publication.noNewStages)
      || (!previous.ownerConfirmed && publication.ownerConfirmed) || Object.entries(publication.grants).some(([actor, grant]) => !isDeepStrictEqual(previous.grants[actor], grant)))) {
      blocked('deny-only', 'unavailable or closed owner may only remove/end grants or assert STOP/noNewStages');
    }
    if (denyOnly && previous && !isDeepStrictEqual(previous.measurementFence, publication.measurementFence)) blocked('deny-only', 'deny-only publication must preserve its measurement fence');
    const pendingCommands = fenceTransition(reference, publication, previous);
    const current = currentControlSchema.parse({ format: 'promptobus-bb-control-v1', ...publication, ...(pendingCommands.length ? { pendingCommands } : {}), revision: (previous?.revision ?? 0) + 1 });
    const content = serialized(current, CURRENT_LIMIT);
    const writes = new Map<string, string>();
    const tokens = new Set<string>();
    for (const [actor, grant] of Object.entries(publication.grants)) {
      if (actor !== grant.actor || grant.task !== reference.owner.task) blocked('grant-mismatch', 'each active grant key/task must match its declared actor/task');
      if (tokens.has(grant.token)) blocked('token-mismatch', 'an active token belongs to exactly one actor and immutable grant');
      tokens.add(grant.token);
      const tokenFile = tokenPath(reference, grant.token);
      if (existsSync(tokenFile)) verifyRecord(reference, grant, 'active');
      writes.set(tokenFile, serialized(recordFor(reference, grant, 'active'), TOKEN_LIMIT));
    }
    for (const grant of Object.values(previous?.grants ?? {})) {
      if (!isDeepStrictEqual(publication.grants[grant.actor], grant)) {
        const record = readJson(reference, tokenPath(reference, grant.token), TOKEN_LIMIT, tokenRecordSchema, 'token');
        if (!isDeepStrictEqual(record, recordFor(reference, grant, record.state))) blocked('token-mismatch', 'cannot end a mutated token assignment');
        writes.set(tokenPath(reference, grant.token), serialized(recordFor(reference, grant, 'ended'), TOKEN_LIMIT));
      }
    }
    for (const [target, bytes] of writes) writeFileAtomic(target, bytes, { mode: 0o600 });
    fault('tokens');
    writeFileAtomic(file, content, { mode: 0o600 });
    fault('current');
    return { revision: current.revision, reference };
  });
  if (options.initialize) {
    if (options.expectedRevision !== null || options.binding || taskPresent(engine, reference.owner.task)) blocked('initialization-refused', 'initialize only a verified nonexistent canonical task with no expected revision');
    normalize(reference, true);
    return publish(false);
  }
  const binding = options.binding;
  if (!binding || !ownerMatches(binding, reference)) blocked('owner-mismatch', 'publication requires the persisted canonical owner binding');
  if (binding.launchContext?.control.mode !== 'current' || !isDeepStrictEqual(binding.launchContext.control.reference, reference)) {
    blocked('reference-mismatch', 'persisted owner binding must retain the canonical current reference');
  }
  return withTaskLock(engine.home, binding.task, () => {
    const canonical = canonicalControl(binding, reference);
    if (canonical.metadata.token !== binding.token || canonical.metadata.providerId !== binding.providerId
      || (canonical.owner.sessionRef !== null && canonical.owner.sessionRef !== binding.threadId)) blocked('owner-mismatch', 'canonical owner token/session identity differs');
    return publish(options.denyOnly !== false || canonical.task.status !== 'active' || binding.phase !== 'ready' || canonical.owner.sessionRef === null);
  });
}

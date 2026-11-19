import { timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantV1 } from '../dist/index.js';
import { sessionRefOf } from '../dist/index.js';
import { canonicalPath, participantOf, readTask } from './store.js';
import { REGISTRY } from './drivers.js';
import { reviewerFiles } from './reviewer-files.js';
import { contained, processRecord, recordOf } from './service-state.js';
import type { ServicePaths } from './service-state.js';
import { standaloneReference } from './standalone-root-state.js';
import type { ServiceClientGrant, ServiceClientLifetime, ServiceNativeBinding } from './service.js';

export class HttpFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const CLIENT_ID = /^[a-f0-9-]{36}$/;
const field = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
export const tokenEquals = (a: string, b: string) => {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};
export const clientFile = (paths: ServicePaths, id: string) => path.join(paths.clients, `${id}.json`);
export function lifetimeOf(value: unknown): ServiceClientLifetime | null {
  if (!recordOf(value)) return null;
  if (value.kind === 'reservation' && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)) {
    return { kind: 'reservation', expiresAt: value.expiresAt };
  }
  const process = processRecord(value.process);
  if (value.kind === 'process' && process) return { kind: 'process', process };
  if (value.kind === 'managed' && field(value.task) && field(value.address) && field(value.ref)
    && field(value.launchId) && field(value.record) && path.isAbsolute(String(value.record))) {
    return { kind: 'managed', task: String(value.task), address: String(value.address), ref: String(value.ref),
      launchId: String(value.launchId), record: String(value.record) };
  }
  return null;
}

export function environmentOf(value: unknown): NodeJS.ProcessEnv {
  if (!recordOf(value) || Object.values(value).some(item => item !== undefined && typeof item !== 'string')) throw new Error('Client env must contain string values');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('PROMPTOBUS_SERVICE_') || key.startsWith('PROMPTOBUS_CLIENT_')) continue;
    if (typeof item === 'string') env[key] = item;
  }
  return env;
}

export const nativeThreadId = (value: unknown): value is string => typeof value === 'string' && /^\S+$/u.test(value);

export function nativeBindingOf(value: unknown): ServiceNativeBinding | undefined {
  if (value === undefined) return undefined;
  if (recordOf(value) && (value.kind === 'claude' || value.kind === 'cursor' || value.kind === 'codex' || value.kind === 'opencode')) {
    if (value.state === 'pending' && value.threadId === undefined && value.sessionId === undefined) return { kind: value.kind, state: 'pending' };
    if (value.state === 'bound' && value.kind === 'codex' && nativeThreadId(value.threadId)) return { kind: 'codex', state: 'bound', threadId: value.threadId };
    if (value.state === 'bound' && value.kind !== 'codex' && nativeThreadId(value.sessionId)) return { kind: value.kind, state: 'bound', sessionId: value.sessionId };
  }
  throw new HttpFailure(400, 'Invalid native binding');
}

export function filesOf(value: unknown): ServiceClientGrant['files'] {
  if (value === undefined || value === null) return null;
  if (!recordOf(value) || !Array.isArray(value.roots) || value.roots.length === 0
    || value.roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))
    || (value.canonicalFiles !== undefined && (!Array.isArray(value.canonicalFiles)
      || value.canonicalFiles.some(file => typeof file !== 'string' || !path.isAbsolute(file))))) throw new Error('Invalid reviewer file grants');
  const roots: string[] = [], canonicalFiles: string[] = [];
  for (const root of value.roots) if (typeof root === 'string') roots.push(root);
  if (Array.isArray(value.canonicalFiles)) for (const file of value.canonicalFiles) if (typeof file === 'string') canonicalFiles.push(file);
  return { roots, canonicalFiles };
}

export function grantOf(value: unknown): ServiceClientGrant {
  if (!recordOf(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !CLIENT_ID.test(value.id)
    || !field(value.token) || !field(value.runtime) || !field(value.cwd)) throw new Error('Invalid shared service client grant');
  const lifetime = lifetimeOf(value.lifetime);
  if (!lifetime) throw new Error('Invalid shared service client lifetime');
  if (value.bbRootNonce !== undefined && (typeof value.bbRootNonce !== 'string' || !CLIENT_ID.test(value.bbRootNonce))) throw new Error('Invalid BB root request generation');
  return { schemaVersion: 1, id: value.id, token: String(value.token), runtime: String(value.runtime), cwd: String(value.cwd),
    env: environmentOf(value.env), pollEnv: environmentOf(value.pollEnv ?? value.env), lifetime, files: filesOf(value.files),
    ...(value.nativeBinding === undefined ? {} : { nativeBinding: nativeBindingOf(value.nativeBinding) }),
    ...(value.rootLaunch === undefined ? {} : { rootLaunch: standaloneReference(value.rootLaunch) }),
    ...(value.bbRootNonce === undefined ? {} : { bbRootNonce: value.bbRootNonce }) };
}

export function managedParticipant(proof: Extract<ServiceClientLifetime, { kind: 'managed' }>, home: string) {
  const task = readTask(home, proof.task), participant = participantOf(task, proof.address);
  if (task.status !== 'active' || !participant || sessionRefOf(participant) !== proof.ref) return null;
  if (typeof participant.metadata?.sessionRecord !== 'string'
    || canonicalPath(participant.metadata.sessionRecord) !== canonicalPath(proof.record)) return null;
  const record: unknown = JSON.parse(readFileSync(proof.record, 'utf8'));
  if (!recordOf(record)) throw new Error('Managed launch record is invalid or incomplete');
  const recordHome = field(record.home), recordTask = field(record.task), recordAddress = field(record.address), launchId = field(record.launchId);
  if (!recordHome || !path.isAbsolute(recordHome) || !recordTask?.trim() || !recordAddress?.trim() || !launchId?.trim()) {
    throw new Error('Managed launch record is invalid or incomplete');
  }
  if (canonicalPath(recordHome) !== home || recordTask !== proof.task || recordAddress !== proof.address || launchId !== proof.launchId) return null;
  return participant;
}

export type Liveness = 'alive' | 'dead' | 'unknown';
export interface LifetimeObservations {
  process(grant: ServiceClientGrant): Liveness;
  managed(grant: ServiceClientGrant, participant: ParticipantV1): Liveness;
}
export const unavailableObservations: LifetimeObservations = { process: () => 'unknown', managed: () => 'unknown' };
export function lifetimeState(grant: ServiceClientGrant, home: string, observe: LifetimeObservations): Liveness {
  const proof = grant.lifetime;
  if (proof.kind === 'reservation') return Date.now() < proof.expiresAt ? 'alive' : 'dead';
  if (proof.kind === 'process') {
    return observe.process(grant);
  }
  try {
    const participant = managedParticipant(proof, home);
    if (!participant) return 'dead';
    if (grant.nativeBinding?.state === 'pending') return 'unknown';
    return observe.managed(grant, participant);
  } catch { return 'unknown'; }
}

export function requireManagedNativeIdentity(grant: ServiceClientGrant, nativeId: string, status: number) {
  if (grant.lifetime.kind !== 'managed' || !grant.nativeBinding) return;
  const record: unknown = JSON.parse(readFileSync(grant.lifetime.record, 'utf8'));
  const driver = REGISTRY.drivers[grant.nativeBinding.kind]!;
  const idField = driver.options.mcpIdentity?.idField ?? 'sessionId';
  if (!recordOf(record) || record[idField] !== nativeId) throw new HttpFailure(status, 'Native identity does not match the owned launch record');
}

export function requireLifetime(grant: ServiceClientGrant, home: string, observe: LifetimeObservations, status = 409) {
  if (grant.lifetime.kind === 'managed') {
    try {
      if (!managedParticipant(grant.lifetime, home)) throw new Error('mismatched participant');
    } catch { throw new HttpFailure(status, 'Managed lifetime has no matching task, participant and launch record'); }
    if (grant.nativeBinding?.state === 'bound') requireManagedNativeIdentity(grant, grant.nativeBinding.kind === 'codex'
      ? grant.nativeBinding.threadId : grant.nativeBinding.sessionId, status);
  }
  if (lifetimeState(grant, home, observe) === 'dead') throw new HttpFailure(status, 'Client lifetime is already expired or replaced');
}

export function privateReadGrants(paths: ServicePaths, files: NonNullable<ServiceClientGrant['files']>): ReturnType<typeof reviewerFiles> {
  for (const root of [...files.roots, ...files.canonicalFiles]) {
    const canonical = canonicalPath(root);
    if (contained(canonical, paths.base) || contained(paths.base, canonical)) {
      throw new Error('Reviewer grants overlap private shared-service credentials; narrow the read roots');
    }
    if (realpathSync(root) !== root) throw new Error('Canonical reviewer grant changed; prepare a new client');
  }
  return reviewerFiles(files.roots, files.canonicalFiles);
}

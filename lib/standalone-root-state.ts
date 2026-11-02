import { existsSync, lstatSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { processExecutable } from './root-process.js';
import { assertNativeBinding, recordNativeBinding, requireCurrentNativeBinding, requireNativeAdmissionState, reserveExplicitStandaloneResume, standaloneBindingForRecovery } from './native-admission.js';
import type { NativeAdmissionContext } from './native-admission.js';
import { acquireServiceLock, contained, processRecord, processState, readPrivate, recordOf,
  sameRecordVersion, writePrivate } from './service-state.js';
import type { ProcessIdentity, RecordVersion, ServicePaths } from './service-state.js';

export type StandaloneRootHarness = 'codex' | 'claude';
export interface StandaloneRootProfile {
  schemaVersion: 1; mode: 'standalone'; id: string; harness: StandaloneRootHarness;
  root: string; home: string; runtime: string; nativeStore: string; executable: RecordVersion; ownerEnvironment: string;
}
export interface StandaloneRootReference { file: string; nonce: string }
export interface StandaloneRootLaunch {
  schemaVersion: 1; profile: string; root: string; home: string; runtime: string; process: ProcessIdentity;
  cwd: string;
  nonce: string; expiresAt: number; clientId: string | null; nativeId: string | null;
  phase: 'pending' | 'bound'; revoked: boolean; plan: string | null; resumeNativeId: string | null;
  identityInvalid?: boolean; nativeCommand?: { file: string; args: string[] };
  nativeStart?: { source: string; transcript: string };
  startupCandidate?: { sessionId: string; transcript: string; capturedAt: number; revisions: RecordVersion[] };
}
interface RootGrant {
  id: string; runtime: string; cwd?: string; rootLaunch?: StandaloneRootReference;
  lifetime: { kind: string; process?: ProcessIdentity };
  nativeBinding?: { kind: string; state: string; threadId?: string; sessionId?: string };
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export const standaloneProfileFile = (paths: ServicePaths, id: string) => path.join(paths.directory, `root-profile-${id}.json`);
export const scopedRootProfile = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

export function standaloneReference(value: unknown): StandaloneRootReference {
  if (!recordOf(value) || typeof value.file !== 'string' || !path.isAbsolute(value.file) || !uuid(value.nonce)) {
    throw new Error('Standalone root requires a private launch reference and generation');
  }
  return { file: value.file, nonce: value.nonce };
}

export function readStandaloneProfile(paths: ServicePaths, runtime: string, id: string): StandaloneRootProfile {
  if (!scopedRootProfile(id)) throw new Error('Root profile requires a scoped ID');
  const value = readPrivate(standaloneProfileFile(paths, id));
  if (!recordOf(value) || value.schemaVersion !== 1 || value.mode !== 'standalone' || value.id !== id
    || value.root !== paths.root || value.home !== paths.home || value.runtime !== runtime
    || (value.harness !== 'codex' && value.harness !== 'claude') || typeof value.nativeStore !== 'string'
    || !path.isAbsolute(value.nativeStore) || realpathSync(value.nativeStore) !== value.nativeStore
    || typeof value.ownerEnvironment !== 'string' || !recordOf(value.executable)
    || typeof value.executable.file !== 'string' || !path.isAbsolute(value.executable.file)
    || typeof value.executable.version !== 'string') throw new Error('Standalone root profile is not approved for this owner, runtime and native account');
  const profile = value as unknown as StandaloneRootProfile;
  if (!sameRecordVersion(profile.executable) || realpathSync(profile.executable.file) !== profile.executable.file) {
    throw new Error('Standalone native executable changed; approve a new profile before launching');
  }
  return profile;
}

export function readStandaloneLaunch(paths: ServicePaths, runtime: string, reference: StandaloneRootReference): StandaloneRootLaunch {
  const ref = standaloneReference(reference);
  if (path.dirname(ref.file) !== paths.directory || path.basename(ref.file) !== `standalone-launch-${ref.nonce}.json`) {
    throw new Error('Standalone root launch reference escaped its owner scope');
  }
  const value = readPrivate(ref.file);
  if (!recordOf(value) || value.schemaVersion !== 1 || value.root !== paths.root || value.home !== paths.home
    || value.runtime !== runtime || value.nonce !== ref.nonce || !uuid(value.nonce) || !scopedRootProfile(value.profile)
    || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)
    || !processRecord(value.process) || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
    || (value.clientId !== null && !uuid(value.clientId)) || (value.nativeId !== null && (typeof value.nativeId !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value.nativeId)))
    || typeof value.phase !== 'string' || !['pending', 'bound'].includes(value.phase) || (value.phase === 'bound' && value.nativeId === null)
    || (value.resumeNativeId !== null && (typeof value.resumeNativeId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.resumeNativeId)))
    || typeof value.revoked !== 'boolean' || (value.plan !== null && (typeof value.plan !== 'string'
      || path.dirname(value.plan) !== paths.directory || !/^exec-[a-f0-9-]{36}\.sh$/.test(path.basename(value.plan))))) {
    throw new Error('Standalone root launch generation is missing or changed');
  }
  if (value.identityInvalid !== undefined && typeof value.identityInvalid !== 'boolean') throw new Error('Standalone identity exclusion is invalid');
  if (value.nativeCommand !== undefined && (!recordOf(value.nativeCommand) || typeof value.nativeCommand.file !== 'string'
    || !path.isAbsolute(value.nativeCommand.file) || !Array.isArray(value.nativeCommand.args)
    || !value.nativeCommand.args.every(arg => typeof arg === 'string' && !arg.includes('\0')))) {
    throw new Error('Standalone native command evidence is invalid');
  }
  if (value.nativeStart !== undefined && (!recordOf(value.nativeStart) || typeof value.nativeStart.source !== 'string'
    || typeof value.nativeStart.transcript !== 'string' || !path.isAbsolute(value.nativeStart.transcript))) {
    throw new Error('Standalone actual native start evidence is invalid');
  }
  if (value.startupCandidate !== undefined && (!recordOf(value.startupCandidate)
    || typeof value.startupCandidate.sessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value.startupCandidate.sessionId)
    || typeof value.startupCandidate.transcript !== 'string' || !path.isAbsolute(value.startupCandidate.transcript)
    || path.basename(value.startupCandidate.transcript) !== `${value.startupCandidate.sessionId}.jsonl`
    || typeof value.startupCandidate.capturedAt !== 'number' || !(value.startupCandidate.capturedAt < value.expiresAt)
    || !Array.isArray(value.startupCandidate.revisions) || value.startupCandidate.revisions.length !== 2
    || !value.startupCandidate.revisions.every(revision => recordOf(revision) && typeof revision.file === 'string'
      && path.isAbsolute(revision.file) && typeof revision.version === 'string'))) {
    throw new Error('Standalone pending startup candidate is invalid');
  }
  return value as unknown as StandaloneRootLaunch;
}

export const pendingStandaloneExpired = (launch: StandaloneRootLaunch) => launch.phase === 'pending' && Date.now() >= launch.expiresAt
  && !(launch.startupCandidate && launch.startupCandidate.capturedAt < launch.expiresAt
    && (launch.nativeId === null || launch.nativeId === launch.startupCandidate.sessionId));

export function requireStartupCandidateFence(paths: ServicePaths, launch: StandaloneRootLaunch, profile: StandaloneRootProfile) {
  const revisions = launch.startupCandidate?.revisions;
  if (launch.phase !== 'pending' || !revisions) return;
  if (revisions[0]!.file !== standaloneProfileFile(paths, launch.profile) || revisions[1]!.file !== profile.ownerEnvironment
    || !revisions.every(sameRecordVersion)) throw new Error('Standalone owner profile or environment changed after startup capture');
}

export function claudeStartupTranscript(nativeStore: string, sessionId: string, transcript: string, deferred = false) {
  if (!path.isAbsolute(transcript) || !contained(nativeStore, transcript) || path.basename(transcript) !== `${sessionId}.jsonl`) {
    throw new Error('Standalone Claude startup requires its actual session transcript inside the approved account store');
  }
  let file = nativeStore;
  for (const component of path.relative(nativeStore, transcript).split(path.sep)) {
    file = path.join(file, component);
    let entry;
    try { entry = lstatSync(file); }
    catch (error) {
      if (deferred && recordOf(error) && error.code === 'ENOENT') return null;
      throw error;
    }
    if (entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o022) !== 0) {
      throw new Error('Standalone Claude transcript path is not owned native state');
    }
  }
  if (!statSync(file).isFile() || realpathSync(file) !== file) throw new Error('Standalone Claude transcript is not a regular native file');
  return file;
}

export async function requireStandaloneRoot(grant: RootGrant, paths: ServicePaths, registration = false, context?: NativeAdmissionContext) {
  if (!grant.rootLaunch) return;
  const launch = readStandaloneLaunch(paths, grant.runtime, grant.rootLaunch);
  const profile = readStandaloneProfile(paths, grant.runtime, launch.profile);
  requireNativeAdmissionState(paths);
  if (launch.identityInvalid || launch.revoked || standaloneClientRevoked(paths, grant.id)
    || pendingStandaloneExpired(launch)) throw new Error('Standalone root admission expired or was revoked; run an explicit owned preflight');
  if (grant.lifetime.kind !== 'process' || !isDeepStrictEqual(grant.lifetime.process, launch.process)
    || grant.nativeBinding?.kind !== profile.harness || (grant.cwd !== undefined && grant.cwd !== launch.cwd)
    || (launch.clientId !== grant.id && !(registration && launch.clientId === null))) {
    throw new Error('Standalone root client does not match its owned process generation');
  }
  if (launch.startupCandidate && (profile.harness !== 'claude' || launch.resumeNativeId !== null
    || !contained(profile.nativeStore, launch.startupCandidate.transcript) || launch.nativeCommand?.file !== profile.executable.file
    || launch.nativeCommand.args.length !== 0 || (launch.nativeId !== null && launch.nativeId !== launch.startupCandidate.sessionId))) {
    throw new Error('Standalone pending startup candidate does not match its approved fresh Claude launch');
  }
  requireStartupCandidateFence(paths, launch, profile);
  const boundId = grant.nativeBinding.state === 'bound' ? grant.nativeBinding.threadId ?? grant.nativeBinding.sessionId : null;
  if (grant.nativeBinding.state === 'bound' && launch.phase !== 'bound') throw new Error('Standalone native proof has not completed owner realization');
  if (boundId && boundId !== launch.nativeId) throw new Error('Standalone native identity changed after realization');
  if (!registration && await processExecutable(launch.process) !== profile.executable.file) {
    throw new Error('Standalone native executable observation is unavailable or no longer matches the approved launch');
  }
  const current = readStandaloneLaunch(paths, grant.runtime, grant.rootLaunch);
  if (!isDeepStrictEqual(current, launch) || !sameRecordVersion(profile.executable)) throw new Error('Standalone launch changed during native observation');
  if (!registration && (launch.phase === 'bound' || launch.resumeNativeId)) {
    const binding = { source: 'standalone' as const, harness: profile.harness, nativeStore: profile.nativeStore,
      nativeId: launch.phase === 'bound' ? launch.nativeId! : launch.resumeNativeId!, runtime: grant.runtime,
      ownerKey: launch.nonce, process: launch.process, nonce: launch.nonce, profile: profile.id, phase: launch.phase };
    requireCurrentNativeBinding(paths, binding);
    if (context) await assertNativeBinding(paths, binding, context);
  }
  return { launch, profile };
}

export function publishStandaloneClient(grant: RootGrant, paths: ServicePaths) {
  if (!grant.rootLaunch) return;
  const launch = readStandaloneLaunch(paths, grant.runtime, grant.rootLaunch);
  if (launch.clientId !== null) throw new Error('Standalone root preflight was already consumed');
  writePrivate(grant.rootLaunch.file, { ...launch, clientId: grant.id });
}

export function standaloneExpired(grant: RootGrant, paths: ServicePaths) {
  if (!grant.rootLaunch) return false;
  const launch = readStandaloneLaunch(paths, grant.runtime, grant.rootLaunch);
  return launch.identityInvalid || launch.revoked || standaloneClientRevoked(paths, grant.id)
    || launch.clientId !== grant.id || pendingStandaloneExpired(launch);
}

export function standaloneClientRevoked(paths: ServicePaths, clientId: string) {
  const file = path.join(paths.directory, `standalone-revoked-${clientId}.json`), marker = readPrivate(file);
  if (marker === null) {
    try { lstatSync(file); }
    catch (error) { if (recordOf(error) && error.code === 'ENOENT') return false; throw error; }
  }
  if (!recordOf(marker) || marker.root !== paths.root || marker.home !== paths.home || marker.clientId !== clientId) {
    throw new Error('Standalone capability revocation marker is corrupt');
  }
  return true;
}

export async function prepareStandaloneResume(grant: RootGrant, paths: ServicePaths, context: NativeAdmissionContext) {
  if (!grant.rootLaunch) return;
  const launch = readStandaloneLaunch(paths, grant.runtime, grant.rootLaunch);
  if (!launch.resumeNativeId) return;
  const profile = readStandaloneProfile(paths, grant.runtime, launch.profile);
  const old = await reserveExplicitStandaloneResume(paths, { source: 'standalone', harness: profile.harness,
    nativeStore: profile.nativeStore, nativeId: launch.resumeNativeId, runtime: grant.runtime, ownerKey: launch.nonce,
    process: launch.process, nonce: launch.nonce, profile: profile.id, phase: 'pending' }, context);
  if (!old) return;
  const previous = readStandaloneLaunch(paths, grant.runtime, { file: path.join(paths.directory, `standalone-launch-${old.nonce}.json`), nonce: old.nonce });
  return previous.clientId ?? undefined;
}

export function revokeStandaloneRoot(grant: RootGrant, paths: ServicePaths) {
  if (!grant.rootLaunch) return;
  const launch = readStandaloneLaunch(paths, grant.runtime, grant.rootLaunch);
  writePrivate(path.join(paths.directory, `standalone-revoked-${grant.id}.json`), {
    root: paths.root, home: paths.home, clientId: grant.id, nonce: launch.nonce,
  });
  if (launch.clientId === grant.id) writePrivate(grant.rootLaunch.file, { ...launch, revoked: true });
  if (launch.plan && processState(launch.process) === 'dead' && existsSync(launch.plan)) rmSync(launch.plan);
}

export async function claimStandaloneIdentity(grant: RootGrant, paths: ServicePaths, nativeId: string, context: NativeAdmissionContext) {
  if (!grant.rootLaunch) return;
  const current = await requireStandaloneRoot(grant, paths);
  if (!current || current.launch.nativeId !== nativeId) throw new Error('Standalone realization requires the exact observed hook identity');
  const { launch, profile } = current;
  const lock = path.join(paths.directory, 'root-admission.lock'), deadline = Date.now() + 5000;
  let release = await acquireServiceLock(lock);
  while (!release) {
    if (Date.now() >= deadline) throw new Error('Standalone native identity is being bound by another owner');
    await new Promise(resolve => setTimeout(resolve, 20));
    release = await acquireServiceLock(lock);
  }
  try {
    await requireStandaloneRoot(grant, paths);
    if (launch.resumeNativeId && launch.resumeNativeId !== nativeId) throw new Error('Actual native hook identity does not match the explicitly requested resume');
    const binding = { runtime: grant.runtime, harness: profile.harness, nativeStore: profile.nativeStore, nativeId,
      source: 'standalone' as const, process: launch.process, nonce: launch.nonce, ownerKey: launch.nonce, profile: profile.id, phase: 'bound' as const };
    const command = launch.nativeCommand, args = command?.args ?? [];
    const codexNew = profile.harness === 'codex'
      && ((launch.nativeStart?.source === 'exec' && args.length === 3 && args[0] === 'exec' && args[1] === '--' && args[2]!.length > 0)
        || (launch.nativeStart?.source === 'cli' && args[0] === '--no-daemon'
          && (args.length === 1 || (args.length === 3 && args[1] === '--' && args[2]!.length > 0))));
    const claudeNew = profile.harness === 'claude' && launch.nativeStart?.source === 'startup' && args.length === 0;
    const createsNativeThread = launch.phase === 'pending' && launch.resumeNativeId === null
      && command?.file === profile.executable.file && (codexNew || claudeNew);
    if (!createsNativeThread) {
      try { requireCurrentNativeBinding(paths, { ...binding, phase: launch.phase }); }
      catch { throw new Error('Standalone native creation proof is unavailable for this command; use an approved native NEW mode with actual creation proof or a known current-version resume/reconnect binding'); }
    }
    await recordNativeBinding(paths, binding, context, launch.startupCandidate ? () => {
      requireStartupCandidateFence(paths, launch, profile);
      if (!isDeepStrictEqual(readStandaloneLaunch(paths, grant.runtime, grant.rootLaunch!), launch) || !sameRecordVersion(profile.executable)
        || standaloneClientRevoked(paths, grant.id)) throw new Error('Standalone startup generation changed before native publication');
    } : undefined);
    const latest = readStandaloneLaunch(paths, grant.runtime, grant.rootLaunch);
    writePrivate(grant.rootLaunch.file, { ...latest, phase: 'bound' });
    const recordedBinding = standaloneBindingForRecovery(paths, grant.runtime, profile.id, nativeId);
    // Only owner realization writes this receipt. Recovery never treats the actor's launch file as hook proof.
    const hook = path.join(paths.directory, `standalone-hook-${launch.nonce}.json`), previous = readPrivate(hook);
    if (previous !== null && (!recordOf(previous) || !isDeepStrictEqual(previous.binding, recordedBinding))) {
      throw new Error('Owner native hook receipt conflicts with this immutable generation');
    }
    if (previous === null) writePrivate(hook, { schemaVersion: 1, root: paths.root, home: paths.home, binding: recordedBinding, client: grant });
  } finally { release(); }
}

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmodSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import type { PromptobusHost } from '../dist/index.js';
import { sessionIdOf, TICK_MS } from '../dist/index.js';
import { canonicalPath, closeTask, ORCHESTRATOR, participantOf, readTask, withTaskLock } from './store.js';
import { participantSession } from './status.js';
import { requireNativeIdle, requireNativeRootRoute, requireNativeTerminal, withVerifiedManagedNativeStop } from './native-lifecycle.js';
import { requireNoLiveReservations } from './live-reservation.js';
import { REGISTRY } from './drivers.js';
import { bindServiceHarnessContext, requireServiceHarnessContext } from './harness-home.js';
import { ServiceWarden } from './service-warden.js';
import type { WardenDiagnostics } from './service-warden.js';
import { bindSharedWarden } from './warden.js';
import { reviewerFiles } from './reviewer-files.js';
import {
  acquireServiceLock, prepareControlSocket, prepareServicePaths, readDiscovery, readPrivate, recordOf, recordVersion, requireProcess,
  runtimeIdentity, processStateAsync, sameRecordVersion, servicePaths, writePrivate,
} from './service-state.js';
import type { ProcessIdentity, ServiceDiscovery } from './service-state.js';
import {
  claimStandaloneIdentity, claudeStartupTranscript, prepareStandaloneResume, requireStartupCandidateFence, publishStandaloneClient,
  requireStandaloneRoot, revokeStandaloneRoot, readStandaloneLaunch, readStandaloneProfile, standaloneClientRevoked, standaloneExpired,
  standaloneReference,
} from './standalone-root-state.js';
import type { StandaloneRootReference } from './standalone-root-state.js';
import { nativeStoreForServiceClient, requireManagedNativeBinding, reserveManagedNativeIdentity, standaloneBindingForRecovery } from './native-admission.js';
import {
  HttpFailure, CLIENT_ID, tokenEquals, clientFile, lifetimeOf, environmentOf, nativeThreadId, nativeBindingOf, filesOf, grantOf,
  managedParticipant, unavailableObservations, lifetimeState, requireManagedNativeIdentity, requireLifetime, privateReadGrants,
} from './service-grant.js';
import type { Liveness, LifetimeObservations } from './service-grant.js';
import { createMcpRequests } from './service-mcp-request.js';
import { requireKnownRootOutcomes } from './service-request-receipts.js';

export type ServiceHostFactory = (context: { cwd: string; env: Readonly<NodeJS.ProcessEnv> }) => PromptobusHost | Promise<PromptobusHost>;
export type ServiceClientLifetime =
  | { kind: 'reservation'; expiresAt: number }
  | { kind: 'process'; process: ProcessIdentity }
  | { kind: 'managed'; task: string; address: string; ref: string; launchId: string; record: string };
export type ServiceNativeHarness = 'claude' | 'cursor' | 'codex' | 'opencode';
export type ServiceNativeBinding =
  | { kind: ServiceNativeHarness; state: 'pending' }
  | { kind: 'codex'; state: 'bound'; threadId: string }
  | { kind: Exclude<ServiceNativeHarness, 'codex'>; state: 'bound'; sessionId: string };
export interface ServiceClientInput {
  cwd: string; env: NodeJS.ProcessEnv; pollEnv?: NodeJS.ProcessEnv; lifetime?: ServiceClientLifetime;
  files?: { roots: string[]; canonicalFiles?: string[] };
  nativeBinding?: ServiceNativeBinding;
  rootLaunch?: StandaloneRootReference;
  bbRootNonce?: string;
}
export interface ServiceClientGrant {
  schemaVersion: 1; id: string; token: string; runtime: string; cwd: string; env: NodeJS.ProcessEnv; pollEnv: NodeJS.ProcessEnv;
  lifetime: ServiceClientLifetime; files: { roots: string[]; canonicalFiles: string[] } | null;
  nativeBinding?: ServiceNativeBinding;
  rootLaunch?: StandaloneRootReference;
  bbRootNonce?: string;
}
export interface ServiceClientCredential { clientId: string; token: string; credentialFile: string; busUrl: string; filesUrl: string | null }
export interface ServiceStatus extends ServiceDiscovery {
  clients: number; reservations: number; unknownClients: number; unknownManaged: number; sessions: number; warden: WardenDiagnostics;
}
export interface RunServiceOptions {
  host: PromptobusHost; createHost: ServiceHostFactory; env?: NodeJS.ProcessEnv;
  activeWork?: () => boolean;
}
const MAX_BODY = 16 * 1024 * 1024;

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) throw new HttpFailure(413, 'Request exceeds the shared service body limit');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpFailure(400, 'Request body is not JSON'); }
}

function reply(response: ServerResponse, status: number, value?: unknown, headers: Record<string, string> = {}) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

export async function runWorkspaceService({ host, createHost, env = process.env, activeWork: additionalWork = () => false }: RunServiceOptions) {
  const paths = servicePaths(host, env), runtime = runtimeIdentity(host);
  prepareServicePaths(paths);
  const release = await acquireServiceLock(paths.lock);
  if (!release) return;
  const lifecycle: { stop?: () => void; fail?: (error: Error) => void } = {};
  let sharedWarden: ServiceWarden | null = null;
  let releaseWardenBinding: (() => void) | null = null;
  let wardenFailure: Error | null = null;
  let timer: NodeJS.Timeout | null = null;
  let http: ReturnType<typeof createServer> | null = null;
  let ipc: ReturnType<typeof createServer> | null = null;
  const pendingObservations = new Set<Promise<unknown>>();
  let serviceFailed = false, serviceFailure: unknown;
  try {
    const prior = readDiscovery(paths);
    const ownerValue = readPrivate(paths.owner);
    if (ownerValue !== null && (!recordOf(ownerValue) || typeof ownerValue.token !== 'string' || !/^[a-f0-9]{64}$/.test(ownerValue.token))) throw new Error('Shared service owner credential is invalid');
    const ownerToken = recordOf(ownerValue) && typeof ownerValue.token === 'string' ? ownerValue.token : randomBytes(32).toString('hex');
    writePrivate(paths.owner, { token: ownerToken });
    const expectedHarness = bindServiceHarnessContext(host, env, REGISTRY);
    const expectedLauncher = { homes: expectedHarness.homes, bins: expectedHarness.bins, searchPath: expectedHarness.searchPath };
    const warden = sharedWarden = new ServiceWarden(paths, host, expectedHarness, env, error => {
      wardenFailure = error; lifecycle.fail?.(error); lifecycle.stop?.();
    });
    releaseWardenBinding = bindSharedWarden((home, task) => {
      if (canonicalPath(home) !== paths.home) throw new Error('Task warden belongs to a different canonical store');
      return warden.ensure(task);
    });
    const activeWork = () => additionalWork() || warden.active() || pendingObservations.size > 0;
    interface Observation { key: string; at: number; pending: boolean; state: Liveness }
    const observed = new Map<string, Observation>();
    const cachedObservation = (id: string, key: string, load: () => Promise<Liveness>, valid: () => boolean): Liveness => {
      const previous = observed.get(id);
      if (previous?.pending) return 'unknown';
      if (previous?.key === key && Date.now() - previous.at < TICK_MS) return previous.state;
      const current: Observation = { key, at: Date.now(), pending: true, state: 'unknown' };
      observed.set(id, current);
      const pending = load().then(state => {
        if (observed.get(id) === current && valid()) current.state = state;
      }).catch(() => { current.state = 'unknown'; }).finally(() => { current.pending = false; current.at = Date.now(); });
      pendingObservations.add(pending);
      void pending.then(() => pendingObservations.delete(pending));
      return 'unknown';
    };
    const managedState: LifetimeObservations = {
      process: grant => {
        if (grant.lifetime.kind !== 'process') return 'unknown';
        const proof = grant.lifetime, key = JSON.stringify(proof), previous = observed.get(grant.id);
        // An exact pid and birth that was observed dead cannot return, so tick/cache aliasing must not discard it.
        if (previous?.key === key && !previous.pending && previous.state === 'dead') return 'dead';
        return cachedObservation(grant.id, key, () => processStateAsync(proof.process), () => true);
      },
      managed: (grant, participant) => {
        if (grant.lifetime.kind !== 'managed') return 'unknown';
        const proof = grant.lifetime, revision = recordVersion(proof.record), key = JSON.stringify([proof, revision]);
        return cachedObservation(grant.id, key, async () => participantSession(participant, await warden.observe([participant], [revision])),
          () => sameRecordVersion(revision) && Boolean(managedParticipant(proof, paths.home)));
      },
    };
    const requireProcessLifetime = async (grant: ServiceClientGrant, status = 409, registration = false) => {
      try { await requireStandaloneRoot(grant, paths, registration, { host, env: grant.pollEnv }); }
      catch (error) { throw new HttpFailure(status, error instanceof Error ? error.message : 'Standalone root proof is unavailable'); }
      if (grant.lifetime.kind !== 'process') return;
      const state = await processStateAsync(grant.lifetime.process);
      observed.set(grant.id, { key: JSON.stringify(grant.lifetime), at: Date.now(), pending: false, state });
      if (state === 'dead') throw new HttpFailure(status, 'Client lifetime is already expired or replaced');
      if (state === 'unknown') throw new HttpFailure(status, 'Client process birth identity is unavailable or incomparable; retained owner state requires diagnostics');
    };
    let discovery: ServiceDiscovery;
    let closing = false, requests = 0, idleSince = Date.now();
    const idleMs = Number(env.PROMPTOBUS_SERVICE_IDLE_MS ?? 30_000);
    const reservationMs = Number(env.PROMPTOBUS_SERVICE_RESERVATION_MS ?? 120_000);
    if (!Number.isSafeInteger(idleMs) || idleMs < 1 || !Number.isSafeInteger(reservationMs) || reservationMs < 1) throw new Error('Invalid shared service lifetime duration');

    const mcp = createMcpRequests({ host, env, paths, runtime, createHost, expectedHarness, warden, requireProcessLifetime,
      proveNativeBinding: grant => requireManagedNativeBinding(paths, grant, { host, env: grant.pollEnv }),
      isClosing: () => closing, finalizeStandaloneStartup: grant => finalizeStandaloneStartup(grant) });
    const { grants, currentGrant, contextFor } = mcp;
    const removeClient = (id: string) => {
      const value = readPrivate(clientFile(paths, id));
      if (value !== null) revokeStandaloneRoot(grantOf(value), paths);
      rmSync(clientFile(paths, id), { force: true });
      observed.delete(id);
      mcp.forgetClient(id);
    };
    const retireConfirmedManaged = (grant: ServiceClientGrant) => {
      const proof = grant.lifetime;
      if (proof.kind !== 'managed' || grant.runtime !== runtime || !expectedHarness.homes.codex) return false;
      const nativeEnv = { ...env, PROMPTOBUS_CODEX_HOME: expectedHarness.homes.codex };
      try {
        return withVerifiedManagedNativeStop(paths.home, proof, nativeEnv, participant => {
          if (grant.nativeBinding && (grant.nativeBinding.kind !== 'codex'
            || (grant.nativeBinding.state === 'bound' && grant.nativeBinding.threadId !== participant.metadata.sessionId))) return false;
          const current = readPrivate(clientFile(paths, grant.id));
          if (!current || !isDeepStrictEqual(grantOf(current), grant)) return false;
          removeClient(grant.id);
          return true;
        });
      } catch { return false; }
    };
    const state = () => {
      let clients = 0, reservations = 0, unknownClients = 0, unknownManaged = 0;
      const values = grants();
      for (const grant of values) if (grant.runtime !== runtime) {
        if (lifetimeState(grant, paths.home, unavailableObservations) === 'dead') removeClient(grant.id);
        else throw new Error('Live clients belong to another shared service runtime; close and reconnect them before upgrade');
      }
      for (const grant of values) {
        if (grant.runtime !== runtime) continue;
        let expired = false, unknownRoot = false;
        try { expired = standaloneExpired(grant, paths); } catch { unknownRoot = true; }
        const life = unknownRoot ? 'unknown' : expired ? 'dead' : lifetimeState(grant, paths.home, managedState);
        if (life === 'dead') { removeClient(grant.id); continue; }
        if (!unknownRoot && life === 'unknown' && retireConfirmedManaged(grant)) continue;
        clients += 1;
        if (grant.lifetime.kind === 'reservation') reservations += 1;
        if (life === 'unknown') {
          unknownClients += 1;
          if (grant.lifetime.kind === 'managed') unknownManaged += 1;
        }
      }
      return { clients, reservations, unknownClients, unknownManaged, sessions: readdirSync(paths.sessions).filter(name => name.endsWith('.json')).length,
        warden: warden.diagnostics() };
    };
    state();
    await warden.recover();

    const realizeClient = async (grant: ServiceClientGrant, nativeId: unknown) => {
      const id = grant.id;
      if (!nativeThreadId(nativeId)) throw new HttpFailure(400, 'Invalid native thread id');
      if (!grant.nativeBinding) throw new HttpFailure(409, 'This client has no native binding');
      await requireProcessLifetime(grant, 401);
      const latestValue = readPrivate(clientFile(paths, id)), latest = latestValue === null ? null : grantOf(latestValue);
      let binding = latest?.nativeBinding;
      let current = currentGrant(grant.nativeBinding.state === 'pending' && binding?.state === 'bound'
        ? { ...grant, nativeBinding: binding } : grant);
      requireLifetime(current, paths.home, managedState, 401);
      requireManagedNativeIdentity(current, nativeId, 409);
      const boundId = binding?.state === 'bound' ? binding.kind === 'codex' ? binding.threadId : binding.sessionId : null;
      if (boundId && boundId !== nativeId) throw new HttpFailure(409, 'Client is already bound to another native thread id');
      if (current.lifetime.kind === 'managed') await reserveManagedNativeIdentity(paths, current, nativeId, { host, env: current.pollEnv });
      if (current.rootLaunch) {
        const launch = readStandaloneLaunch(paths, current.runtime, current.rootLaunch);
        const nativeStore = readStandaloneProfile(paths, current.runtime, launch.profile).nativeStore;
        if (grants().some(other => {
          const otherBinding = other.nativeBinding;
          return other.id !== current.id && otherBinding?.state === 'bound' && otherBinding.kind === binding?.kind
            && (otherBinding.kind === 'codex' ? otherBinding.threadId : otherBinding.sessionId) === nativeId
            && (nativeStoreForServiceClient(paths, other, nativeId) ?? nativeStore) === nativeStore;
        })) {
          throw new HttpFailure(409, 'Available native client already binds this actual identity');
        }
        await claimStandaloneIdentity(current, paths, nativeId, { host, env: current.pollEnv });
      }
      if (current.rootLaunch || current.lifetime.kind === 'managed') {
        const finalValue = readPrivate(clientFile(paths, id)), finalGrant = finalValue === null ? null : grantOf(finalValue);
        const finalBinding = finalGrant?.nativeBinding;
        const finalId = finalBinding?.state === 'bound' ? finalBinding.kind === 'codex' ? finalBinding.threadId : finalBinding.sessionId : null;
        current = currentGrant(binding?.state === 'pending' && finalId === nativeId ? { ...current, nativeBinding: finalBinding } : current);
        binding = current.nativeBinding;
      }
      if (binding?.state === 'pending') writePrivate(clientFile(paths, id), { ...current, nativeBinding: binding.kind === 'codex'
        ? { kind: 'codex', state: 'bound', threadId: nativeId }
        : { kind: binding.kind, state: 'bound', sessionId: nativeId } });
    };
    const finalizeStandaloneStartup = async (grant: ServiceClientGrant) => {
      const reference = grant.rootLaunch;
      if (!reference || grant.nativeBinding?.state !== 'pending') return;
      const lock = `${reference.file}.lock`, deadline = Date.now() + 5000;
      let release = await acquireServiceLock(lock);
      while (!release) {
        if (Date.now() >= deadline) throw new HttpFailure(503, 'Standalone native generation is already being realized; retry the tool call');
        await new Promise(resolve => setTimeout(resolve, 20));
        release = await acquireServiceLock(lock);
      }
      try {
        const current = currentGrant(grant), launch = readStandaloneLaunch(paths, current.runtime, reference), candidate = launch.startupCandidate;
        if (!candidate || launch.phase !== 'pending' || launch.nativeId !== null) return;
        await requireProcessLifetime(current, 401);
        const profile = readStandaloneProfile(paths, current.runtime, launch.profile);
        try { requireStartupCandidateFence(paths, launch, profile); }
        catch (error) { throw new HttpFailure(409, error instanceof Error ? error.message : 'Standalone startup fence changed'); }
        currentGrant(current);
        if (!isDeepStrictEqual(readStandaloneLaunch(paths, current.runtime, reference), launch)) throw new HttpFailure(409, 'Standalone launch changed during native observation');
        try {
          const transcript = claudeStartupTranscript(profile.nativeStore, candidate.sessionId, candidate.transcript, true);
          if (!transcript) return;
          writePrivate(reference.file, { ...launch, nativeId: candidate.sessionId, nativeStart: { source: 'startup', transcript } });
          await realizeClient(current, candidate.sessionId);
        } catch (error) {
          removeClient(current.id);
          throw error instanceof HttpFailure ? error : new HttpFailure(403, error instanceof Error ? error.message : 'Standalone startup realization failed');
        }
      } finally { release(); }
    };
    const control = async (input: unknown) => {
      if (closing) throw new HttpFailure(503, 'Shared service is stopping');
      if (!recordOf(input) || typeof input.operation !== 'string') throw new HttpFailure(400, 'Invalid service control operation');
      if (input.operation === 'status') return { ...discovery, ...state() };
      if (input.runtime !== runtime) throw new HttpFailure(409, 'Owner request belongs to a different shared service runtime');
      if (input.operation === 'close-task') {
        if (typeof input.task !== 'string') throw new HttpFailure(400, 'Task closure requires a task');
        const callerEnv = environmentOf(input.env);
        requireServiceHarnessContext(expectedHarness, host, callerEnv, REGISTRY, environmentOf(input.pollEnv ?? callerEnv));
        if (requests > 1) throw new HttpFailure(409, 'Task closure requires settled service requests');
        const task = input.task;
        const parent = readTask(paths.home, task).parent;
        const close = () => withTaskLock(paths.home, task, () => {
          const meta = readTask(paths.home, task), root = participantOf(meta, ORCHESTRATOR);
          if (meta.parent !== parent) throw new HttpFailure(409, 'Task parent changed before closure');
          if (meta.adapter?.bb || root?.harness !== 'codex' || !root.metadata.nativeStop
            || root.metadata.nativeUnlaunched === root.metadata.nativeLaunchId) {
            throw new HttpFailure(409, 'Service owner closure requires a confirmed native Codex root Stop; BB lifecycle is separate');
          }
          requireNoLiveReservations(host, paths.home, task);
          requireNativeIdle(paths.home, meta, null, { taskLocked: true });
          if (parent !== undefined) {
            const route = meta.participants.find(participant => participant.role === 'root');
            if (!route) throw new HttpFailure(409, 'Child task closure requires its canonical native root route');
            requireNoLiveReservations(host, paths.home, parent);
            requireNativeRootRoute(paths.home, meta, route, env);
          }
          for (const participant of meta.participants) {
            if (participant.harness !== 'codex') {
              if (participant.role === 'root' && parent !== undefined) continue;
              if (participant.role !== 'user' || participant.sessionRef || sessionIdOf(participant) || participant.mode === 'managed') {
                throw new HttpFailure(409, 'Service owner closure supports only confirmed native Codex participants');
              }
              continue;
            }
            requireNativeTerminal(paths.home, meta, participant, env, { taskLocked: true });
          }
          closeTask(paths.home, task);
        });
        if (parent === undefined) close();
        else withTaskLock(paths.home, parent, close);
        await warden.abort(task);
        return { task, closed: true };
      }
      if (input.operation === 'warden-ensure' || input.operation === 'warden-abort') {
        if (typeof input.task !== 'string') throw new HttpFailure(400, 'Task warden requires a task');
        requireServiceHarnessContext(expectedHarness, host, env, REGISTRY, environmentOf(input.pollEnv ?? env));
        return input.operation === 'warden-ensure' ? warden.ensure(input.task) : await warden.abort(input.task);
      }
      if (input.operation === 'stop') {
        const current = state(), work = current.clients ? null : activeWork();
        if (current.clients || work || requests > 1) throw new HttpFailure(409,
          `Shared service still has live clients or active work [clients: ${current.clients}, activeWork: ${work ?? 'notObserved'}, pendingObservations: ${pendingObservations.size}, requests: ${requests}]`);
        lifecycle.stop?.();
        return { stopped: true };
      }
      if (input.operation === 'standalone-preflight') {
        if (typeof input.profile !== 'string' || !nativeThreadId(input.nativeId)) throw new HttpFailure(400, 'Standalone recovery requires a profile and explicit native id');
        const lock = path.join(paths.directory, 'root-admission.lock'), deadline = Date.now() + 5000;
        let unlock = await acquireServiceLock(lock);
        while (!unlock) {
          if (Date.now() >= deadline) throw new HttpFailure(409, 'Standalone owner preflight is already in progress');
          await new Promise(resolve => setTimeout(resolve, 20));
          unlock = await acquireServiceLock(lock);
        }
        let reserved: ServiceClientGrant | null = null;
        let recoveryFile: string | null = null;
        try {
          const binding = standaloneBindingForRecovery(paths, runtime, input.profile, input.nativeId);
          const reference = { file: path.join(paths.directory, `standalone-launch-${binding.nonce}.json`), nonce: binding.nonce };
          const launch = readStandaloneLaunch(paths, runtime, reference), profile = readStandaloneProfile(paths, runtime, input.profile);
          if (launch.identityInvalid || launch.phase !== 'bound' || launch.nativeId !== input.nativeId
            || launch.profile !== profile.id || profile.harness !== binding.harness || profile.nativeStore !== binding.nativeStore
            || binding.ownerKey !== launch.nonce || !isDeepStrictEqual(launch.process, binding.process) || !launch.clientId) {
            throw new HttpFailure(409, 'Standalone recovery cannot change the immutable native generation');
          }
          const hookFile = path.join(paths.directory, `standalone-hook-${launch.nonce}.json`), hookVersion = recordVersion(hookFile), hook = readPrivate(hookFile);
          if (!recordOf(hook) || hook.schemaVersion !== 1 || hook.root !== paths.root || hook.home !== paths.home
            || !isDeepStrictEqual(hook.binding, binding)) throw new HttpFailure(409, 'Standalone recovery requires a trusted durable owner hook receipt');
          const template = grantOf(hook.client);
          if (!isDeepStrictEqual(template.rootLaunch, reference) || template.runtime !== runtime || template.cwd !== launch.cwd
            || template.lifetime.kind !== 'process' || !isDeepStrictEqual(template.lifetime.process, launch.process)
            || template.nativeBinding?.kind !== profile.harness) throw new HttpFailure(409, 'Owner hook receipt belongs to another native process');
          const knownOutcomes = () => {
            if (mcp.mutationPending(launch.nonce)) throw new HttpFailure(409, 'Standalone mutation is still in flight; wait for its original outcome');
            requireKnownRootOutcomes(paths, launch.nonce);
          };
          recoveryFile = path.join(paths.directory, `standalone-recovery-${launch.nonce}.json`);
          const previous = readPrivate(recoveryFile);
          if (previous === null) {
            try { lstatSync(recoveryFile); throw new HttpFailure(409, 'Existing standalone recovery state is corrupt, not absent'); }
            catch (error) { if (!recordOf(error) || error.code !== 'ENOENT') throw error; }
          }
          let pending: ServiceClientGrant | null = null;
          if (previous !== null) {
            if (!recordOf(previous) || previous.root !== paths.root || previous.home !== paths.home || previous.runtime !== runtime
              || previous.nonce !== launch.nonce || typeof previous.phase !== 'string' || !['pending', 'completed'].includes(previous.phase)
              || typeof previous.previousClientId !== 'string' || !CLIENT_ID.test(previous.previousClientId)) {
              throw new HttpFailure(409, 'Standalone recovery state is corrupt; preserve it for owner inspection');
            }
            const candidate = grantOf(previous.client);
            if (!isDeepStrictEqual(candidate.rootLaunch, reference) || candidate.runtime !== runtime || candidate.cwd !== launch.cwd
              || candidate.lifetime.kind !== 'process' || !isDeepStrictEqual(candidate.lifetime.process, launch.process)
              || candidate.nativeBinding?.kind !== profile.harness) throw new HttpFailure(409, 'Standalone recovery state changed its immutable binding');
            if (previous.phase === 'pending' && !standaloneClientRevoked(paths, candidate.id)
              && (launch.clientId === candidate.id || launch.clientId === previous.previousClientId)) pending = candidate;
          }
          const currentValue = readPrivate(clientFile(paths, launch.clientId));
          const current = currentValue === null ? null : grantOf(currentValue);
          if (current && (!isDeepStrictEqual(current.rootLaunch, reference) || current.runtime !== runtime || current.cwd !== launch.cwd
            || current.lifetime.kind !== 'process' || !isDeepStrictEqual(current.lifetime.process, launch.process))) {
            throw new HttpFailure(409, 'Current standalone capability belongs to another native binding');
          }
          if ((!pending || pending.id === current?.id) && current?.nativeBinding?.state === 'bound'
            && !launch.revoked && !standaloneClientRevoked(paths, current.id)) {
            await requireProcessLifetime(current, 409);
            currentGrant(current);
            knownOutcomes();
            if (!sameRecordVersion(hookVersion)) throw new HttpFailure(409, 'Owner hook receipt changed during recovery');
            if (pending && recordOf(previous)) writePrivate(recoveryFile, { ...previous, phase: 'completed',
              reason: 'Existing same-process capability completed before owner restart', client: current });
            return { profile: input.profile, nativeId: input.nativeId, recovered: false };
          }
          // No await from the in-flight check through the durable old-token fence and new pending reservation.
          knownOutcomes();
          reserved = pending ?? { ...template, id: randomUUID(), token: randomBytes(32).toString('hex'),
            nativeBinding: { kind: profile.harness, state: 'pending' } };
          const previousClientId = pending && recordOf(previous) ? String(previous.previousClientId) : launch.clientId;
          writePrivate(recoveryFile, { root: paths.root, home: paths.home, runtime, nonce: launch.nonce,
            previousClientId, phase: 'pending', reason: 'Owner native proof pending', client: reserved });
          if (launch.clientId !== reserved.id) {
            revokeStandaloneRoot({ ...template, id: launch.clientId }, paths);
            removeClient(launch.clientId);
          }
          writePrivate(reference.file, { ...launch, clientId: reserved.id, revoked: false });
          if (standaloneClientRevoked(paths, reserved.id)) throw new HttpFailure(409, 'Reserved standalone capability was already revoked');
          const saved = readPrivate(clientFile(paths, reserved.id));
          if (saved !== null && !isDeepStrictEqual(grantOf(saved), reserved)) throw new HttpFailure(409, 'Reserved standalone capability changed');
          writePrivate(clientFile(paths, reserved.id), reserved);
          await requireProcessLifetime(reserved, 409);
          currentGrant(reserved);
          standaloneBindingForRecovery(paths, runtime, input.profile, input.nativeId);
          if (!sameRecordVersion(hookVersion)) throw new HttpFailure(409, 'Owner hook receipt changed during recovery');
          knownOutcomes();
          if (closing) throw new HttpFailure(503, 'Shared service is stopping');
          const bound: ServiceClientGrant = { ...reserved, nativeBinding: profile.harness === 'codex'
            ? { kind: 'codex', state: 'bound', threadId: input.nativeId }
            : { kind: profile.harness, state: 'bound', sessionId: input.nativeId } };
          writePrivate(clientFile(paths, bound.id), bound);
          writePrivate(recoveryFile, { root: paths.root, home: paths.home, runtime, nonce: launch.nonce,
            previousClientId, phase: 'completed', reason: 'Same native binding proved by owner', client: bound });
          return { profile: input.profile, nativeId: input.nativeId, recovered: true };
        } catch (error) {
          if (recoveryFile && reserved) {
            const saved = readPrivate(recoveryFile);
            if (recordOf(saved) && recordOf(saved.client) && saved.client.id === reserved.id && saved.phase === 'pending') {
              writePrivate(recoveryFile, { ...saved, reason: error instanceof Error ? error.message : 'Owner proof unavailable; repeat explicit preflight' });
            }
          }
          throw error;
        } finally { unlock(); }
      }
      if (input.operation === 'register') {
        if (!recordOf(input.client) || typeof input.client.cwd !== 'string' || !path.isAbsolute(input.client.cwd)) throw new HttpFailure(400, 'Client cwd must be absolute');
        const requestedEnv = environmentOf(input.client.env);
        const pollEnv = environmentOf(input.client.pollEnv ?? input.client.env);
        if (requestedEnv.PROMPTOBUS_HOME && canonicalPath(requestedEnv.PROMPTOBUS_HOME) !== paths.home) throw new HttpFailure(400, 'Client store does not match the shared service');
        requestedEnv.PROMPTOBUS_HOME = paths.home;
        requestedEnv.PROMPTOBUS_ROLE ||= 'orchestrator';
        const lifetime = input.client.lifetime === undefined ? { kind: 'reservation' as const, expiresAt: Date.now() + reservationMs } : lifetimeOf(input.client.lifetime);
        if (!lifetime) throw new HttpFailure(400, 'Invalid client lifetime');
        const files = filesOf(input.client.files);
        const nativeBinding = nativeBindingOf(input.client.nativeBinding);
        if (files) {
          reviewerFiles(files.roots, files.canonicalFiles);
          files.roots = files.roots.map(root => realpathSync(root));
        }
        const grant: ServiceClientGrant = { schemaVersion: 1, id: randomUUID(), token: randomBytes(32).toString('hex'), runtime,
          cwd: canonicalPath(input.client.cwd), env: requestedEnv, pollEnv, lifetime, files, ...(nativeBinding ? { nativeBinding } : {}),
          ...(input.client.rootLaunch === undefined ? {} : { rootLaunch: standaloneReference(input.client.rootLaunch) }) };
        if (input.client.bbRootNonce !== undefined) {
          if (typeof input.client.bbRootNonce !== 'string' || !CLIENT_ID.test(input.client.bbRootNonce)
            || lifetime.kind !== 'process' || nativeBinding?.kind !== 'codex' || grant.rootLaunch) throw new HttpFailure(400, 'BB root receipt generation requires its own Codex process client');
          grant.bbRootNonce = input.client.bbRootNonce;
        }
        if (lifetime.kind === 'managed' && (requestedEnv.PROMPTOBUS_TASK !== lifetime.task || requestedEnv.PROMPTOBUS_ROLE !== lifetime.address)) throw new HttpFailure(400, 'Managed lifetime does not match the client task/address');
        const validateRegistration = async () => {
          await requireProcessLifetime(grant, 409, true);
          requireLifetime(grant, paths.home, managedState);
        };
        await validateRegistration();
        if (nativeBinding && !grant.rootLaunch && !grant.bbRootNonce) {
          requireServiceHarnessContext(expectedHarness, host, requestedEnv, REGISTRY, pollEnv);
          if (!isDeepStrictEqual(input.launcherHarness, expectedLauncher)) throw new HttpFailure(409,
            'Native launcher has different harness state homes, binaries or common poll environment; reconnect through the same workspace runtime');
        }
        if (files) privateReadGrants(paths, files);
        const context = nativeBinding ? null : await contextFor(grant, validateRegistration);
        await validateRegistration();
        if (closing) throw new HttpFailure(503, 'Shared service is stopping');
        requireLifetime(grant, paths.home, managedState);
        publishStandaloneClient(grant, paths);
        if (grant.rootLaunch) {
          const previousRootClient = await prepareStandaloneResume(grant, paths, { host, env: pollEnv });
          if (previousRootClient) removeClient(previousRootClient);
          await validateRegistration();
          if (closing) throw new HttpFailure(503, 'Shared service is stopping');
        }
        writePrivate(clientFile(paths, grant.id), grant);
        if (context) mcp.rememberContext(context);
        return { clientId: grant.id, token: grant.token, credentialFile: clientFile(paths, grant.id),
          busUrl: `${discovery.url}mcp/bus`, filesUrl: grant.files ? `${discovery.url}mcp/reviewer_files` : null } satisfies ServiceClientCredential;
      }
      if (input.operation === 'revoke' || input.operation === 'bind' || input.operation === 'realize') {
        const id = typeof input.clientId === 'string' ? input.clientId : '';
        if (!CLIENT_ID.test(id)) throw new HttpFailure(400, 'Invalid client id');
        const value = readPrivate(clientFile(paths, id));
        if (value === null && input.operation === 'revoke') {
          try { lstatSync(clientFile(paths, id)); }
          catch (error) {
            if (recordOf(error) && error.code === 'ENOENT') return { clientId: id, operation: input.operation };
            throw error;
          }
        }
        if (value === null) throw new HttpFailure(404, 'Client binding not found');
        const grant = grantOf(value);
        if (input.operation === 'realize') {
          await realizeClient(grant, input.threadId);
          return { clientId: id, operation: input.operation };
        }
        if (input.operation === 'bind') {
          const lifetime = lifetimeOf(input.lifetime);
          if (!lifetime || lifetime.kind === 'reservation') throw new HttpFailure(400, 'Binding requires native lifetime proof');
          if (lifetime.kind === 'managed' && (grant.env.PROMPTOBUS_TASK !== lifetime.task || grant.env.PROMPTOBUS_ROLE !== lifetime.address)) throw new HttpFailure(400, 'Managed lifetime does not match the client task/address');
          const updated = { ...grant, lifetime };
          await requireProcessLifetime(updated);
          currentGrant(grant);
          requireLifetime(updated, paths.home, managedState);
          writePrivate(clientFile(paths, id), updated);
        } else {
          removeClient(id);
        }
        return { clientId: id, operation: input.operation };
      }
      throw new HttpFailure(400, 'Unknown service control operation');
    };

    const server = http = createServer(async (request, response) => {
      requests += 1;
      idleSince = Date.now();
      try {
        if (closing) throw new HttpFailure(503, 'Shared service is stopping');
        const expected = new URL(discovery.url);
        if (request.headers.host !== expected.host || (request.headers.origin !== undefined && request.headers.origin !== expected.origin)) throw new HttpFailure(403, 'Foreign HTTP authority or Origin');
        const url = new URL(request.url ?? '/', discovery.url);
        if (url.origin !== expected.origin) throw new HttpFailure(403, 'Foreign HTTP request target');
        const endpoint = url.pathname === '/mcp/bus' ? 'bus' : url.pathname === '/mcp/reviewer_files' ? 'reviewer_files' : null;
        if (!endpoint) throw new HttpFailure(404, 'Endpoint not found');
        const result = await mcp.handle({ endpoint, method: request.method, headers: request.headers, readBody: () => bodyOf(request) });
        reply(response, result.status, result.body, result.headers);
      } catch (error) {
        const status = error instanceof HttpFailure ? error.status : 500;
        reply(response, status, { error: error instanceof Error ? error.message : 'Shared service request failed' });
      } finally {
        requests -= 1;
      }
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    const port = prior ? Number(new URL(prior.url).port) : 0;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Shared service has no loopback port');
    discovery = { schemaVersion: 1, root: paths.root, home: paths.home, runtime, version: host.version,
      url: `http://127.0.0.1:${address.port}/`, process: requireProcess() };
    const controlServer = ipc = createServer(async (request, response) => {
      requests += 1;
      idleSince = Date.now();
      try {
        if (closing) throw new HttpFailure(503, 'Shared service is stopping');
        if (request.headers.host !== 'promptobus.local' || request.headers.origin !== undefined
          || !request.headers.authorization?.startsWith('Bearer ')
          || !tokenEquals(ownerToken, request.headers.authorization.slice(7))) throw new HttpFailure(401, 'Owner authentication required');
        if (request.method !== 'POST' || request.url !== '/control') throw new HttpFailure(405, 'Control requires POST /control');
        reply(response, 200, await control(await bodyOf(request)));
      } catch (error) {
        reply(response, error instanceof HttpFailure ? error.status : 500, { error: error instanceof Error ? error.message : 'Shared service control failed' });
      } finally { requests -= 1; }
    });
    controlServer.headersTimeout = 10_000;
    controlServer.requestTimeout = 30_000;
    await prepareControlSocket(paths);
    await new Promise<void>((resolve, reject) => {
      controlServer.once('error', reject);
      controlServer.listen(paths.controlSocket, () => { controlServer.off('error', reject); resolve(); });
    });
    chmodSync(paths.controlSocket, 0o600);
    writePrivate(paths.discovery, discovery);
    await new Promise<void>((resolve, reject) => {
      lifecycle.fail = reject;
      lifecycle.stop = () => {
        if (closing) return;
        closing = true;
        let remaining = 2;
        const done = (error?: Error) => { if (error) reject(error); remaining -= 1; if (!remaining) resolve(); };
        server.close(done); controlServer.close(done);
        server.closeIdleConnections(); controlServer.closeIdleConnections();
      };
      if (wardenFailure) { reject(wardenFailure); lifecycle.stop(); return; }
      const onSignal = () => lifecycle.stop?.();
      process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
      server.once('close', () => { process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); });
      timer = setInterval(() => {
        try {
          if (state().clients || activeWork() || requests) idleSince = Date.now();
          else if (Date.now() - idleSince >= idleMs) lifecycle.stop?.();
        } catch (error) { server.closeAllConnections(); controlServer.closeAllConnections(); lifecycle.stop?.(); reject(error); }
      }, Math.min(1000, idleMs));
    });
  } catch (error) {
    serviceFailed = true; serviceFailure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try { if (timer) clearInterval(timer); } catch (error) { cleanupErrors.push(error); }
    try { lifecycle.stop?.(); } catch (error) { cleanupErrors.push(error); }
    try { releaseWardenBinding?.(); } catch (error) { cleanupErrors.push(error); }
    try { await sharedWarden?.close(); } catch (error) { if (!serviceFailed || error !== serviceFailure) cleanupErrors.push(error); }
    await Promise.allSettled(pendingObservations);
    for (const server of [http, ipc]) if (server) {
      try {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } catch (error) { cleanupErrors.push(error); }
    }
    if (!sharedWarden || sharedWarden.hasExited()) {
      try { release(); } catch (error) { cleanupErrors.push(error); }
    } else cleanupErrors.push(new Error('Shared task Worker exit unconfirmed; owner lock retained'));
    if (cleanupErrors.length) {
      const errors = [...(serviceFailed ? [serviceFailure] : []), ...cleanupErrors];
      throw new AggregateError(errors, `Shared service cleanup failed: ${errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')}`);
    }
  }
}

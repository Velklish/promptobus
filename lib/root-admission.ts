import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PromptobusHost } from '../dist/index.js';
import {
  acquireServiceLock, privateDirectory, processRecord, processState, readPrivate, recordOf, runtimeIdentity, servicePaths, writePrivate,
} from './service-state.js';
import type { ProcessIdentity, ServicePaths } from './service-state.js';
import { initializeNativeAdmissionState, requireNativeAdmissionState, reserveBbNativeSuccessor } from './native-admission.js';

export interface RootGeneration { nativeThreadId: string; appServer: ProcessIdentity; nonce: string }
interface RootCreation {
  revision: string; state: 'pending' | 'uncertain' | 'bound'; bbThreadId: string | null;
  nativeThreadId: string | null; pending: { file: string; generation: RootGeneration } | null;
  executionScope?: Readonly<{ project: string; environment: string }>;
}
export interface ApprovedRootProfile { id: string; runtime: string; nativeStore: string; creation?: RootCreation }
export interface RootLookupScope {
  root: string; home: string; profile: Readonly<ApprovedRootProfile>; generation: Readonly<RootGeneration>;
}
export interface RootRealization extends RootLookupScope { bbThreadId: string }
export interface RootRequest { profileId: string; nativeStore: string; generation: RootGeneration }
interface ManagedLaunch { id: string; bbThreadId: string | null }
interface RootRecord { profileId: string; bbThreadId: string; generation: RootGeneration }
interface AdmissionState {
  schemaVersion: 2; root: string; home: string; profiles: ApprovedRootProfile[]; managed: ManagedLaunch[]; roots: RootRecord[];
}

const scopedId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const threadId = (value: unknown): value is string => scopedId(value) && value.startsWith('thr_') && value.length > 4;
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value);
const runtimeId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function generationOf(value: unknown): RootGeneration | null {
  if (!recordOf(value) || !nativeId(value.nativeThreadId) || !scopedId(value.nonce)) return null;
  const appServer = processRecord(value.appServer);
  return appServer ? { nativeThreadId: value.nativeThreadId, appServer, nonce: value.nonce } : null;
}

const generationKey = (value: RootGeneration) => JSON.stringify([value.nativeThreadId, value.appServer.pid, value.appServer.birth, value.nonce]);
const executionScopeOf = (value: unknown): value is Readonly<{ project: string; environment: string }> => recordOf(value)
  && [value.project, value.environment].every(item => typeof item === 'string' && item.length > 0 && item.trim() === item && !item.includes('\0'));
function requireExecutionScope(creation: RootCreation, expected: RootCreation['executionScope']) {
  if (creation.executionScope?.project !== expected?.project || creation.executionScope?.environment !== expected?.environment) {
    throw new Error('Root creation execution scope changed; use its original project and environment');
  }
}
function creationOf(value: unknown): value is RootCreation {
  if (!recordOf(value) || !scopedId(value.revision) || (typeof value.state !== 'string' || !['pending', 'uncertain', 'bound'].includes(value.state))
    || (value.bbThreadId !== null && !threadId(value.bbThreadId))
    || (value.nativeThreadId !== null && !nativeId(value.nativeThreadId))
    || (value.state === 'bound') !== (value.bbThreadId !== null)
    || (value.executionScope !== undefined && !executionScopeOf(value.executionScope))) return false;
  if (value.pending === null) return true;
  if (!recordOf(value.pending) || typeof value.pending.file !== 'string' || !path.isAbsolute(value.pending.file)) return false;
  const generation = generationOf(value.pending.generation);
  return generation !== null && generation.nativeThreadId === value.nativeThreadId;
}
const profileRecord = (value: unknown): value is ApprovedRootProfile => recordOf(value) && scopedId(value.id)
  && runtimeId(value.runtime) && typeof value.nativeStore === 'string' && path.isAbsolute(value.nativeStore)
  && path.resolve(value.nativeStore) === value.nativeStore && (value.creation === undefined || creationOf(value.creation));
const managedRecord = (value: unknown): value is ManagedLaunch => recordOf(value) && scopedId(value.id)
  && (value.bbThreadId === null || threadId(value.bbThreadId));
const rootRecord = (value: unknown): value is RootRecord => recordOf(value) && scopedId(value.profileId)
  && threadId(value.bbThreadId) && generationOf(value.generation) !== null;
const unique = (values: string[]) => new Set(values).size === values.length;
export function readRootAdmissionState(paths: ServicePaths): AdmissionState | null {
  const directory = path.join(paths.directory, 'root-admission');
  let missing = false;
  try {
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory
      || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o077) !== 0) throw new Error('Root admission directory is not owned private state');
  } catch (error) { if (recordOf(error) && error.code === 'ENOENT') missing = true; else throw error; }
  const value = readPrivate(path.join(directory, 'state.json'));
  if (missing && value === null) {
    try { lstatSync(directory); }
    catch (error) { if (recordOf(error) && error.code === 'ENOENT') return null; throw error; }
  }
  return stateOf(value, paths.root, paths.home);
}

function stateOf(value: unknown, root: string, home: string): AdmissionState {
  if (!recordOf(value) || value.schemaVersion !== 2 || value.root !== root || value.home !== home
    || !Array.isArray(value.profiles) || !value.profiles.every(profileRecord)
    || !Array.isArray(value.managed) || !value.managed.every(managedRecord)
    || !Array.isArray(value.roots) || !value.roots.every(rootRecord)) {
    throw new Error('Root admission state is missing, corrupt or belongs to another scope');
  }
  const { profiles, managed, roots } = value;
  if (!unique(profiles.map(profile => profile.id))
    || !unique(profiles.flatMap(profile => profile.creation?.bbThreadId ? [profile.creation.bbThreadId] : []))
    || !unique(managed.map(launch => launch.id))
    || !unique(managed.flatMap(launch => launch.bbThreadId === null ? [] : [launch.bbThreadId]))
    || !unique(roots.map(record => generationKey(record.generation)))
    || roots.some(record => !profiles.some(profile => profile.id === record.profileId)
      || managed.some(launch => launch.bbThreadId === record.bbThreadId))) throw new Error('Root admission state has conflicting classifications');
  return { schemaVersion: 2, root, home, profiles, managed, roots };
}

function canonicalNativeStore(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Root profile requires an absolute native account store');
  const canonical = realpathSync(value);
  if (!statSync(canonical).isDirectory()) throw new Error('Root profile native account store must be an existing directory');
  return canonical;
}

// Private owner operations only; the later native guard supplies transcript and app-server proof.
export function createRootAdmission(host: PromptobusHost, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  const paths = servicePaths(host, env), runtime = runtimeIdentity(host);
  const directory = path.join(paths.directory, 'root-admission');
  const stateFile = path.join(directory, 'state.json'), lock = path.join(paths.directory, 'root-admission.lock');

  async function transaction<T>(run: (state: AdmissionState) => Promise<T>, validateOwner?: () => void | Promise<void>): Promise<T> {
    privateDirectory(paths.base); privateDirectory(paths.directory);
    const deadline = Date.now() + 5000;
    let release = await acquireServiceLock(lock);
    while (!release) {
      if (Date.now() >= deadline) throw new Error('Root admission is busy; retry after its owner finishes');
      await new Promise(resolve => setTimeout(resolve, 20));
      release = await acquireServiceLock(lock);
    }
    try {
      await validateOwner?.();
      privateDirectory(paths.directory);
      let state = readRootAdmissionState(paths);
      if (state === null) {
        privateDirectory(directory);
        writePrivate(stateFile, { schemaVersion: 2, root: paths.root, home: paths.home, profiles: [], managed: [], roots: [] });
        state = stateOf(readPrivate(stateFile), paths.root, paths.home);
      }
      privateDirectory(directory);
      return await run(state);
    } finally { release(); }
  }

  return {
    async approveProfile(input: { id: string; nativeStore: string; executionScope?: RootCreation['executionScope'] }, verifyOwner?: () => void, publishProfile?: () => void): Promise<void> {
      if (!recordOf(input) || !scopedId(input.id)) throw new Error('Root profile requires a scoped ID');
      if (input.executionScope !== undefined && !executionScopeOf(input.executionScope)) throw new Error('Root creation requires its exact project and environment');
      const profile = { id: input.id, runtime, nativeStore: canonicalNativeStore(input.nativeStore) };
      await transaction(async state => {
        const manifestFile = path.join(paths.directory, `root-profile-${profile.id}.json`), manifest = readPrivate(manifestFile);
        if (manifest === null) {
          try { lstatSync(manifestFile); throw new Error('Existing root profile manifest is corrupt, not absent'); }
          catch (error) { if (!recordOf(error) || error.code !== 'ENOENT') throw error; }
        }
        if (manifest !== null && (!recordOf(manifest) || manifest.schemaVersion !== 1 || manifest.mode === 'standalone'
          || manifest.root !== paths.root || manifest.home !== paths.home || manifest.runtime !== runtime
          || manifest.id !== profile.id || manifest.nativeStore !== profile.nativeStore)) {
          throw new Error('Root profile ID is reserved for another admission mode or scope');
        }
        const previous = state.profiles.find(value => value.id === profile.id);
        if (previous) {
          if (previous.runtime !== runtime || previous.nativeStore !== profile.nativeStore) throw new Error('Approved root profile ID belongs to another runtime or account store');
          if (previous.creation) requireExecutionScope(previous.creation, input.executionScope);
          initializeNativeAdmissionState(paths);
          publishProfile?.();
          return;
        }
        initializeNativeAdmissionState(paths);
        publishProfile?.();
        state.profiles.push(profile);
        writePrivate(stateFile, state);
      }, () => { verifyOwner?.(); requireNativeAdmissionState(paths); });
    },

    async reserveRootCreation(id: string, revision: string, verifyOwner: () => void, executionScope?: RootCreation['executionScope']) {
      if (!scopedId(id) || !scopedId(revision)) throw new Error('Root creation requires its exact approved profile and operation');
      if (executionScope !== undefined && !executionScopeOf(executionScope)) throw new Error('Root creation requires its exact project and environment');
      return transaction(async state => {
        const profile = state.profiles.find(value => value.id === id && value.runtime === runtime);
        if (!profile) throw new Error('Root creation profile is not approved');
        if (profile.creation) {
          requireExecutionScope(profile.creation, executionScope);
          return { invoke: false, creation: structuredClone(profile.creation) };
        }
        profile.creation = { revision, state: 'pending', bbThreadId: null, nativeThreadId: null, pending: null,
          ...(executionScope ? { executionScope: { ...executionScope } } : {}) };
        writePrivate(stateFile, state);
        return { invoke: true, creation: structuredClone(profile.creation) };
      }, verifyOwner);
    },

    async finishRootCreation(id: string, revision: string, bbThreadId: string | null, verifyOwner: () => void, executionScope?: RootCreation['executionScope']) {
      if (bbThreadId !== null && !threadId(bbThreadId)) throw new Error('Root creation requires its returned canonical BB thread ID');
      return transaction(async state => {
        const profile = state.profiles.find(value => value.id === id && value.runtime === runtime), creation = profile?.creation;
        if (!creation || creation.revision !== revision || creation.state !== 'pending') throw new Error('Root creation operation changed; the late result cannot be adopted');
        requireExecutionScope(creation, executionScope);
        if (bbThreadId !== null && (state.managed.some(value => value.bbThreadId === bbThreadId)
          || state.profiles.some(value => value.id !== id && value.creation?.bbThreadId === bbThreadId))) {
          throw new Error('Returned BB thread already belongs to another creation or managed launch');
        }
        creation.bbThreadId = bbThreadId;
        creation.state = bbThreadId === null ? 'uncertain' : 'bound';
        writePrivate(stateFile, state);
        return structuredClone(creation);
      }, verifyOwner);
    },

    async deferRootCreation(id: string, file: string, generation: RootGeneration, verifyOwner?: () => void) {
      return transaction(async state => {
        const profile = state.profiles.find(value => value.id === id && value.runtime === runtime), creation = profile?.creation;
        if (!creation || (creation.state === 'bound' && creation.pending !== null)) return false;
        const expected = path.join(paths.directory, `root-client-${createHash('sha256').update(JSON.stringify([id, generation.appServer])).digest('hex')}.json`);
        if (!generationOf(generation) || file !== expected || processState(generation.appServer) !== 'alive') {
          throw new Error('Pending root proof does not name its exact current native launch');
        }
        if ((creation.nativeThreadId !== null && creation.nativeThreadId !== generation.nativeThreadId)
          || (creation.pending !== null && (creation.pending.file !== file
            || generationKey(creation.pending.generation) !== generationKey(generation)))) throw new Error('Root creation cannot substitute its pending native generation');
        creation.nativeThreadId = generation.nativeThreadId;
        creation.pending = { file, generation: structuredClone(generation) };
        writePrivate(stateFile, state);
        return creation.state !== 'bound';
      }, verifyOwner);
    },

    async realizeRoot<T>(input: RootRequest, lookup: (scope: RootLookupScope) => Promise<unknown>,
      realize: (proof: RootRealization) => Promise<T>, verifyOwner?: () => void): Promise<T> {
      if (!recordOf(input) || !scopedId(input.profileId)) throw new Error('Root admission requires an approved profile ID');
      const profileId = input.profileId, nativeStore = canonicalNativeStore(input.nativeStore), generation = generationOf(input.generation);
      if (!generation) throw new Error('Root admission requires one exact native generation');
      return transaction(async state => {
        const profile = state.profiles.find(value => value.id === profileId);
        if (!profile || profile.runtime !== runtime || profile.nativeStore !== nativeStore) throw new Error('Root profile is not approved for this runtime and native account store');
        if (state.managed.some(launch => launch.bbThreadId === null)) throw new Error('Unresolved managed launch intent blocks root admission; owned recovery is required');
        if (processState(generation.appServer) !== 'alive') throw new Error('Root app-server process identity is unavailable or no longer current');
        const scope: RootLookupScope = Object.freeze({ root: paths.root, home: paths.home, profile: Object.freeze({ id: profile.id, runtime: profile.runtime, nativeStore: profile.nativeStore }),
          generation: Object.freeze({ ...generation, appServer: Object.freeze({ ...generation.appServer }) }) });
        const correspondence = await lookup(scope);
        verifyOwner?.();
        if (!recordOf(correspondence) || correspondence.complete !== true || correspondence.eligibility !== 'eligible'
          || !threadId(correspondence.bbThreadId)) throw new Error('Root requires a complete eligible unique canonical BB correspondence');
        const bbThreadId = correspondence.bbThreadId;
        if (profile.creation) {
          const creation = profile.creation;
          if (creation.state !== 'bound' || creation.bbThreadId !== bbThreadId
            || (creation.nativeThreadId !== null && creation.nativeThreadId !== generation.nativeThreadId)) {
            throw new Error('Native root is not the exact thread returned by its approved ordinary creation');
          }
          if (creation.nativeThreadId === null) {
            creation.nativeThreadId = generation.nativeThreadId;
            writePrivate(stateFile, state);
          }
        }
        if (state.managed.some(launch => launch.bbThreadId === bbThreadId)) throw new Error('Managed BB thread is permanently excluded from root admission');
        const previous = state.roots.find(record => generationKey(record.generation) === generationKey(generation));
        if (previous && (previous.profileId !== profile.id || previous.bbThreadId !== bbThreadId)) throw new Error('Native root generation classification is immutable');
        if (processState(generation.appServer) !== 'alive') throw new Error('Root app-server process changed during authoritative lookup');
        await reserveBbNativeSuccessor(paths, { harness: 'codex', nativeStore, nativeId: generation.nativeThreadId, source: 'bb', runtime,
          ownerKey: bbThreadId, process: generation.appServer, nonce: generation.nonce, profile: profile.id }, { host, env });
        verifyOwner?.();
        if (!previous) {
          state.roots.push({ profileId: profile.id, bbThreadId, generation });
          writePrivate(stateFile, state);
        }
        return realize({ ...scope, bbThreadId });
      }, verifyOwner);
    },

    async beginManagedLaunch(id: string): Promise<void> {
      if (!scopedId(id)) throw new Error('Managed launch intent requires a scoped ID');
      await transaction(async state => {
        if (state.managed.some(launch => launch.id === id)) throw new Error('Managed launch intent already exists; do not repeat provider spawn');
        state.managed.push({ id, bbThreadId: null });
        writePrivate(stateFile, state);
      });
    },

    async completeManagedLaunch(id: string, bbThreadId: string): Promise<void> {
      if (!scopedId(id) || !threadId(bbThreadId)) throw new Error('Managed completion requires an exact intent and canonical BB thread ID');
      await transaction(async state => {
        const launch = state.managed.find(value => value.id === id);
        if (!launch) throw new Error('Managed launch intent is missing');
        if (launch.bbThreadId === bbThreadId) return;
        if (launch.bbThreadId !== null) throw new Error('Managed launch intent is already bound to another BB thread');
        if (state.roots.some(record => record.bbThreadId === bbThreadId)) throw new Error('Adopting an admitted root requires prior capability revocation; adoption is unsupported');
        if (state.managed.some(value => value.bbThreadId === bbThreadId)) throw new Error('Existing managed thread adoption is unsupported');
        launch.bbThreadId = bbThreadId;
        writePrivate(stateFile, state);
      });
    },
  };
}

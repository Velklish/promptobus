import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PromptobusHost } from '../dist/index.js';
import {
  acquireServiceLock, privateDirectory, processRecord, processState, readPrivate, recordOf, runtimeIdentity, servicePaths, writePrivate,
} from './service-state.js';
import type { ProcessIdentity } from './service-state.js';

export interface RootGeneration { nativeThreadId: string; appServer: ProcessIdentity; nonce: string }
export interface ApprovedRootProfile { id: string; runtime: string; nativeStore: string }
export interface RootLookupScope {
  root: string; home: string; profile: Readonly<ApprovedRootProfile>; generation: Readonly<RootGeneration>;
}
export interface RootRealization extends RootLookupScope { bbThreadId: string }
export interface RootRequest { profileId: string; nativeStore: string; generation: RootGeneration }
interface ManagedLaunch { id: string; bbThreadId: string | null }
interface RootRecord { profileId: string; bbThreadId: string; generation: RootGeneration }
interface AdmissionState {
  schemaVersion: 1; root: string; home: string; profiles: ApprovedRootProfile[]; managed: ManagedLaunch[]; roots: RootRecord[];
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
const profileRecord = (value: unknown): value is ApprovedRootProfile => recordOf(value) && scopedId(value.id)
  && runtimeId(value.runtime) && typeof value.nativeStore === 'string' && path.isAbsolute(value.nativeStore)
  && path.resolve(value.nativeStore) === value.nativeStore;
const managedRecord = (value: unknown): value is ManagedLaunch => recordOf(value) && scopedId(value.id)
  && (value.bbThreadId === null || threadId(value.bbThreadId));
const rootRecord = (value: unknown): value is RootRecord => recordOf(value) && scopedId(value.profileId)
  && threadId(value.bbThreadId) && generationOf(value.generation) !== null;
const unique = (values: string[]) => new Set(values).size === values.length;

function stateOf(value: unknown, root: string, home: string): AdmissionState {
  if (!recordOf(value) || value.schemaVersion !== 1 || value.root !== root || value.home !== home
    || !Array.isArray(value.profiles) || !value.profiles.every(profileRecord)
    || !Array.isArray(value.managed) || !value.managed.every(managedRecord)
    || !Array.isArray(value.roots) || !value.roots.every(rootRecord)) throw new Error('Root admission state is missing, corrupt or belongs to another scope');
  const { profiles, managed, roots } = value;
  if (!unique(profiles.map(profile => profile.id)) || !unique(managed.map(launch => launch.id))
    || !unique(managed.flatMap(launch => launch.bbThreadId === null ? [] : [launch.bbThreadId]))
    || !unique(roots.map(record => generationKey(record.generation)))
    || roots.some(record => !profiles.some(profile => profile.id === record.profileId)
      || managed.some(launch => launch.bbThreadId === record.bbThreadId))) throw new Error('Root admission state has conflicting classifications');
  return { schemaVersion: 1, root, home, profiles, managed, roots };
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

  async function transaction<T>(run: (state: AdmissionState) => Promise<T>): Promise<T> {
    privateDirectory(paths.base); privateDirectory(paths.directory);
    const deadline = Date.now() + 5000;
    let release = await acquireServiceLock(lock);
    while (!release) {
      if (Date.now() >= deadline) throw new Error('Root admission is busy; retry after its owner finishes');
      await new Promise(resolve => setTimeout(resolve, 20));
      release = await acquireServiceLock(lock);
    }
    try {
      privateDirectory(paths.directory);
      if (!existsSync(directory)) {
        privateDirectory(directory);
        writePrivate(stateFile, { schemaVersion: 1, root: paths.root, home: paths.home, profiles: [], managed: [], roots: [] });
      }
      privateDirectory(directory);
      return await run(stateOf(readPrivate(stateFile), paths.root, paths.home));
    } finally { release(); }
  }

  return {
    async approveProfile(input: { id: string; nativeStore: string }): Promise<void> {
      if (!recordOf(input) || !scopedId(input.id)) throw new Error('Root profile requires a scoped ID');
      const profile = { id: input.id, runtime, nativeStore: canonicalNativeStore(input.nativeStore) };
      await transaction(async state => {
        const previous = state.profiles.find(value => value.id === profile.id);
        if (previous) {
          if (previous.runtime !== runtime || previous.nativeStore !== profile.nativeStore) throw new Error('Approved root profile ID belongs to another runtime or account store');
          return;
        }
        state.profiles.push(profile);
        writePrivate(stateFile, state);
      });
    },

    async realizeRoot<T>(input: RootRequest, lookup: (scope: RootLookupScope) => Promise<unknown>,
      realize: (proof: RootRealization) => Promise<T>): Promise<T> {
      if (!recordOf(input) || !scopedId(input.profileId)) throw new Error('Root admission requires an approved profile ID');
      const profileId = input.profileId, nativeStore = canonicalNativeStore(input.nativeStore), generation = generationOf(input.generation);
      if (!generation) throw new Error('Root admission requires one exact native generation');
      return transaction(async state => {
        const profile = state.profiles.find(value => value.id === profileId);
        if (!profile || profile.runtime !== runtime || profile.nativeStore !== nativeStore) throw new Error('Root profile is not approved for this runtime and native account store');
        if (state.managed.some(launch => launch.bbThreadId === null)) throw new Error('Unresolved managed launch intent blocks root admission; owned recovery is required');
        if (processState(generation.appServer) !== 'alive') throw new Error('Root app-server process identity is unavailable or no longer current');
        const scope: RootLookupScope = Object.freeze({ root: paths.root, home: paths.home, profile: Object.freeze({ ...profile }),
          generation: Object.freeze({ ...generation, appServer: Object.freeze({ ...generation.appServer }) }) });
        const correspondence = await lookup(scope);
        if (!recordOf(correspondence) || correspondence.complete !== true || correspondence.eligibility !== 'eligible'
          || !threadId(correspondence.bbThreadId)) throw new Error('Root requires a complete eligible unique canonical BB correspondence');
        const bbThreadId = correspondence.bbThreadId;
        if (state.managed.some(launch => launch.bbThreadId === bbThreadId)) throw new Error('Managed BB thread is permanently excluded from root admission');
        const previous = state.roots.find(record => generationKey(record.generation) === generationKey(generation));
        if (previous && (previous.profileId !== profile.id || previous.bbThreadId !== bbThreadId)) throw new Error('Native root generation classification is immutable');
        if (processState(generation.appServer) !== 'alive') throw new Error('Root app-server process changed during authoritative lookup');
        if (!previous) {
          state.roots.push({ profileId: profile.id, bbThreadId, generation });
          writePrivate(stateFile, state);
        }
        return realize({ ...scope, bbThreadId });
      });
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

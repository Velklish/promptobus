import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { PromptobusHost } from '../dist/index.js';
import { shellQuote } from '../dist/fs/shell.js';
import { runAsync } from './exec.js';
import { createRootAdmission, readRootAdmissionState } from './root-admission.js';
import { actorIdentityVariables } from './drivers.js';
import { observeCodexAppServer, readCodexRootTranscript } from './root-native.js';
import { createOwnerEnvironment, readOwnerEnvironment } from './service-launch.js';
import { writeRootExecPlan } from './launch-exec.js';
import type { RootExecCommand } from './launch-exec.js';
import { ensureWorkspaceService, realizeServiceClient, registerServiceClient } from './service-client.js';
import { acquireServiceLock, prepareServicePaths, processRecord, processState, readPrivate, recordOf, recordVersion, sameRecordVersion,
  runtimeIdentity, servicePaths, writePrivate } from './service-state.js';
import type { ProcessIdentity, RecordVersion, ServicePaths } from './service-state.js';

interface RootProfile {
  schemaVersion: 1; root: string; home: string; runtime: string; id: string; nativeStore: string; ownerEnvironment: string; bb: string;
}
interface RootLaunch {
  schemaVersion: 1; profile: string; runtime: string; appServer: ProcessIdentity; nonce: string; clientId: string; credentialFile: string;
  nativeStart?: { nativeThreadId: string; transcript: string };
}
export interface CodexRootProfileDescriptor {
  profile: string; busUrl: string; root: string; home: string;
  server: { url: string; http_headers_helper: string; required: true };
  startHook: { type: 'command'; command: string };
  execPlanCommand: string;
  creation?: { state: 'pending' | 'uncertain' | 'bound'; bbThreadId: string | null };
}
const profileId = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const profileFile = (paths: ServicePaths, id: string) => path.join(paths.directory, `root-profile-${id}.json`);
const creationKey = (creation: { revision: string; executionScope?: Readonly<{ project: string; environment: string }> } | undefined) =>
  creation ? JSON.stringify([creation.revision, creation.executionScope?.project, creation.executionScope?.environment]) : null;
const readCreationKey = (paths: ServicePaths, id: string, runtime: string) => creationKey(readRootAdmissionState(paths)?.profiles
  .find(profile => profile.id === id && profile.runtime === runtime)?.creation);

function readProfile(host: PromptobusHost, id: string, env: NodeJS.ProcessEnv): RootProfile {
  if (!profileId(id)) throw new Error('Root profile requires a scoped ID');
  const paths = servicePaths(host, env), value = readPrivate(profileFile(paths, id));
  if (!recordOf(value) || value.schemaVersion !== 1 || value.root !== paths.root || value.home !== paths.home
    || value.runtime !== runtimeIdentity(host) || value.id !== id || typeof value.nativeStore !== 'string'
    || typeof value.ownerEnvironment !== 'string' || typeof value.bb !== 'string' || !path.isAbsolute(value.bb)) {
    throw new Error('Root profile is not approved for this canonical workspace, store and runtime');
  }
  return value as unknown as RootProfile;
}

export async function approveCodexRootProfile(host: PromptobusHost, input: { id: string; nativeStore: string;
  executionScope?: Readonly<{ project: string; environment: string }>;
  createRoot?: (profile: CodexRootProfileDescriptor) => Promise<{ id: string }> }, env = process.env): Promise<CodexRootProfileDescriptor> {
  const givenScope = input.executionScope;
  if (givenScope !== undefined && !recordOf(givenScope)) throw new Error('Root creation requires its exact project and environment');
  const executionScope = givenScope === undefined ? undefined : Object.freeze({ project: givenScope.project, environment: givenScope.environment });
  if (executionScope && [executionScope.project, executionScope.environment]
    .some(value => typeof value !== 'string' || !value.length || value.trim() !== value || value.includes('\0'))) {
    throw new Error('Root creation requires its exact project and environment');
  }
  input = { id: input.id, nativeStore: input.nativeStore, createRoot: input.createRoot, executionScope };
  env = { ...env };
  if (!profileId(input.id)) throw new Error('Root profile requires a scoped ID');
  if (input.createRoot !== undefined && typeof input.createRoot !== 'function') throw new Error('Root creation requires its trusted owner callback');
  if (!path.isAbsolute(input.nativeStore)) throw new Error('Root profile requires an absolute native account store');
  if ((env.PROMPTOBUS_ROLE && env.PROMPTOBUS_ROLE !== 'orchestrator')
    || ['PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_OPENCODE_SESSION',
      'PROMPTOBUS_CLIENT_FILE'].some(name => env[name])) throw new Error('A managed participant cannot approve a root profile');
  const candidates = [env.BB_CLI, ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, 'bb'))];
  const executable = candidates.find(file => {
    if (!file || !path.isAbsolute(file)) return false;
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
  });
  if (!executable) throw new Error('The BB root profile requires its public bb CLI');
  const bb = realpathSync(executable);
  const paths = servicePaths(host, env), runtime = runtimeIdentity(host), nativeStore = realpathSync(input.nativeStore);
  prepareServicePaths(paths);
  const file = profileFile(paths, input.id);
  const requireAbsent = () => {
    try { lstatSync(file); }
    catch (error) { if (recordOf(error) && error.code === 'ENOENT') return; throw error; }
    throw new Error('Root creation owner or approved profile changed');
  };
  let version: RecordVersion | null;
  try { version = recordVersion(file); }
  catch (error) { if (recordOf(error) && error.code === 'ENOENT') version = null; else throw error; }
  let owner = version ? readProfile(host, input.id, env) : null;
  if (owner && (owner.nativeStore !== nativeStore || owner.bb !== bb)) throw new Error('Root profile ID already describes a different native account or BB launcher');
  let snapshotVersion = owner ? recordVersion(owner.ownerEnvironment) : null;
  let snapshot = owner ? readOwnerEnvironment(host, owner.ownerEnvironment, { env }) : null;
  let operation = readCreationKey(paths, input.id, runtime);
  const verifyOwner = () => {
    const current = servicePaths(host, env);
    if (current.root !== paths.root || current.home !== paths.home || current.base !== paths.base
      || runtimeIdentity(host) !== runtime || (version !== null && !sameRecordVersion(version))
      || (snapshotVersion !== null && !sameRecordVersion(snapshotVersion))) throw new Error('Root creation owner or approved profile changed');
    if (version === null) requireAbsent();
    if (readCreationKey(paths, input.id, runtime) !== operation) throw new Error('Root creation operation or execution scope changed');
  };
  verifyOwner();
  await createRootAdmission(host, { env }).approveProfile({ id: input.id, nativeStore, executionScope }, verifyOwner, () => {
    if (owner) return;
    // Publish only from the original absent manifest while holding the admission lock.
    owner = { schemaVersion: 1, root: paths.root, home: paths.home, runtime, id: input.id,
      nativeStore, ownerEnvironment: createOwnerEnvironment(host, env), bb };
    snapshot = readOwnerEnvironment(host, owner.ownerEnvironment, { env });
    snapshotVersion = recordVersion(owner.ownerEnvironment);
    writePrivate(file, owner);
    version = recordVersion(file);
  });
  verifyOwner();
  if (!owner || !snapshot || !version) throw new Error('Root profile approval did not publish its owned snapshot');
  const discovery = await ensureWorkspaceService(host, { env: { ...snapshot, PROMPTOBUS_SERVICE_HOME: paths.base }, pollEnv: snapshot });
  verifyOwner();
  const command = (args: string[]) => [host.nodePath(), ...args].map(shellQuote).join(' ');
  const scope = ['--service-home', paths.base];
  const descriptor: CodexRootProfileDescriptor = { profile: input.id, busUrl: `${discovery.url}mcp/bus`, root: paths.root, home: paths.home,
    server: { url: `${discovery.url}mcp/bus`, http_headers_helper: command(host.busArgv(['service', 'headers', '--profile', input.id, ...scope])), required: true },
    startHook: { type: 'command' as const, command: command(host.guardArgv(['guard', '--root-profile', input.id, ...scope])) },
    execPlanCommand: command(host.busArgv(['service', 'exec-plan', '--profile', input.id, ...scope])) };
  if (!input.createRoot) return descriptor;
  const admission = createRootAdmission(host, { env }), revision = randomUUID();
  const reserved = await admission.reserveRootCreation(input.id, revision, verifyOwner, executionScope);
  let creation = reserved.creation;
  operation = creationKey(creation);
  verifyOwner();
  if (reserved.invoke) {
    verifyOwner();
    let created: { id: string };
    try {
      created = await input.createRoot(descriptor);
      if (!recordOf(created) || typeof created.id !== 'string' || !/^thr_[a-zA-Z0-9_-]{1,124}$/.test(created.id)) {
        throw new Error('Root creation did not return its actual canonical BB thread');
      }
    } catch (error) {
      try { await admission.finishRootCreation(input.id, revision, null, verifyOwner, executionScope); }
      catch (retain) { throw new AggregateError([error, retain], 'Root creation failed; its uncertain operation remains reserved'); }
      throw error;
    }
    creation = await admission.finishRootCreation(input.id, revision, created.id, verifyOwner, executionScope);
  }
  verifyOwner();
  if (creation.state === 'bound' && creation.pending && processState(creation.pending.generation.appServer) === 'alive') {
    if (creation.pending.file !== launchFile(paths, input.id, creation.pending.generation.appServer)) throw new Error('Pending root proof escaped its approved launch');
    const launch = readLaunch(creation.pending.file, owner, creation.pending.generation.appServer);
    if (!launch || launch.nonce !== creation.pending.generation.nonce
      || launch.nativeStart?.nativeThreadId !== creation.pending.generation.nativeThreadId) throw new Error('Pending native root proof changed before owner preflight');
    await realizeCapturedRoot(host, owner, launch, env, version, operation);
  }
  return { ...descriptor, creation: { state: creation.state, bbThreadId: creation.bbThreadId } };
}

export async function codexRootExecPlan(host: PromptobusHost, id: string, command: Pick<RootExecCommand, 'file' | 'args'>,
  { env = process.env, dryRun = false }: { env?: NodeJS.ProcessEnv; dryRun?: boolean } = {}) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('The root exec launcher requires a supported POSIX process observer');
  if (!command.file || [command.file, ...command.args].some(value => typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('Root exec requires a native command and arguments without NUL bytes');
  }
  if ((env.PROMPTOBUS_ROLE && env.PROMPTOBUS_ROLE !== 'orchestrator')
    || ['PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_OPENCODE_SESSION',
      'PROMPTOBUS_CLIENT_FILE'].some(name => env[name])) throw new Error('A managed participant cannot run an ordinary root preflight');
  const profile = readProfile(host, id, env), paths = servicePaths(host, env);
  const snapshot = readOwnerEnvironment(host, profile.ownerEnvironment, { env });
  if (dryRun) return { profile: id, root: paths.root, home: paths.home, command,
    preflight: 'notRun' as const, nativeAuthorization: 'notRun' as const };
  await ensureWorkspaceService(host, { env: { ...snapshot, PROMPTOBUS_SERVICE_HOME: paths.base }, pollEnv: snapshot });
  const delta: RootExecCommand['env'] = Object.fromEntries([
    ...actorIdentityVariables(), 'OPENCODE_SESSION_ID', 'PROMPTOBUS_TASK', 'PROMPTOBUS_ROLE', 'PROMPTOBUS_ROOT_TASK',
    'BB_THREAD_ID', 'BB_ENVIRONMENT_ID', 'BB_PROJECT_ID', 'BB_THREAD_STORAGE',
    ...Object.keys(env).filter(name => name.startsWith('PROMPTOBUS_CLIENT_')),
  ].map(name => [name, null]));
  return writeRootExecPlan(paths.directory, { ...command, env: { ...delta, PROMPTOBUS_HOME: paths.home,
    PROMPTOBUS_SERVICE_HOME: paths.base, PROMPTOBUS_OWNER_ENV_FILE: profile.ownerEnvironment } });
}

const launchFile = (paths: ServicePaths, profile: string, appServer: ProcessIdentity) => path.join(paths.directory,
  `root-client-${createHash('sha256').update(JSON.stringify([profile, appServer])).digest('hex')}.json`);

function readLaunch(file: string, profile: RootProfile, appServer: ProcessIdentity): RootLaunch | null {
  const value = readPrivate(file);
  if (value === null) return null;
  const identity = recordOf(value) ? processRecord(value.appServer) : null;
  if (!recordOf(value) || value.schemaVersion !== 1 || value.profile !== profile.id || value.runtime !== profile.runtime
    || !identity || identity.pid !== appServer.pid || identity.birth !== appServer.birth
    || typeof value.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(value.nonce) || typeof value.clientId !== 'string'
    || typeof value.credentialFile !== 'string') throw new Error('Root client generation changed; run owner preflight before reconnecting');
  if (value.nativeStart !== undefined && (!recordOf(value.nativeStart) || typeof value.nativeStart.nativeThreadId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value.nativeStart.nativeThreadId)
    || typeof value.nativeStart.transcript !== 'string' || !path.isAbsolute(value.nativeStart.transcript))) {
    throw new Error('Root native start proof changed');
  }
  return value as unknown as RootLaunch;
}

function credentialOf(paths: ServicePaths, launch: RootLaunch) {
  if (!/^[a-f0-9-]{36}$/.test(launch.clientId) || launch.credentialFile !== path.join(paths.clients, `${launch.clientId}.json`)) {
    throw new Error('Root client credential escaped its service scope');
  }
  const grant = readPrivate(launch.credentialFile);
  if (!recordOf(grant) || grant.id !== launch.clientId || grant.runtime !== launch.runtime || typeof grant.token !== 'string'
    || grant.bbRootNonce !== launch.nonce
    || !recordOf(grant.lifetime) || grant.lifetime.kind !== 'process' || !recordOf(grant.lifetime.process)
    || grant.lifetime.process.pid !== launch.appServer.pid || grant.lifetime.process.birth !== launch.appServer.birth
    || !recordOf(grant.nativeBinding) || grant.nativeBinding.kind !== 'codex') throw new Error('Root credential has no matching native process lifetime');
  return grant;
}

export async function codexRootHeaders(host: PromptobusHost, id: string, env = process.env) {
  const profile = readProfile(host, id, env), appServer = observeCodexAppServer(), paths = servicePaths(host, env);
  const snapshot = readOwnerEnvironment(host, profile.ownerEnvironment, { env });
  const options = { env: { ...snapshot, PROMPTOBUS_SERVICE_HOME: paths.base }, pollEnv: snapshot, cwd: paths.root };
  await ensureWorkspaceService(host, options);
  const file = launchFile(paths, id, appServer), lock = `${file}.lock`, deadline = Date.now() + 5000;
  let release = await acquireServiceLock(lock);
  while (!release) {
    if (Date.now() >= deadline) throw new Error('Root native generation is being prepared; retry the native connection');
    await new Promise(resolve => setTimeout(resolve, 20));
    release = await acquireServiceLock(lock);
  }
  try {
    let launch = readLaunch(file, profile, appServer);
    if (!launch) {
      const actorEnv: NodeJS.ProcessEnv = { ...snapshot, PROMPTOBUS_OWNER_ENV_FILE: profile.ownerEnvironment };
      for (const name of [...actorIdentityVariables(), 'OPENCODE_SESSION_ID', 'PROMPTOBUS_TASK', 'PROMPTOBUS_ROLE',
        'PROMPTOBUS_ROOT_TASK', 'BB_THREAD_ID', 'BB_ENVIRONMENT_ID', 'BB_PROJECT_ID', 'BB_THREAD_STORAGE']) delete actorEnv[name];
      for (const name of Object.keys(actorEnv)) if (name.startsWith('PROMPTOBUS_CLIENT_')) delete actorEnv[name];
      const nonce = randomUUID();
      const credential = await registerServiceClient(host, { cwd: paths.root, env: actorEnv, pollEnv: snapshot,
        lifetime: { kind: 'process', process: appServer }, nativeBinding: { kind: 'codex', state: 'pending' }, bbRootNonce: nonce }, options);
      launch = { schemaVersion: 1, profile: id, runtime: profile.runtime, appServer, nonce,
        clientId: credential.clientId, credentialFile: credential.credentialFile };
      writePrivate(file, launch);
    }
    if (processState(appServer) !== 'alive') throw new Error('Native Codex app-server generation is no longer current');
    return { Authorization: `Bearer ${credentialOf(paths, launch).token as string}` };
  } finally { release(); }
}

async function realizeCapturedRoot(host: PromptobusHost, profile: RootProfile, launch: RootLaunch, env: NodeJS.ProcessEnv,
  profileVersion: RecordVersion, operation: string | null) {
  const paths = servicePaths(host, env), start = launch.nativeStart;
  if (!start || processState(launch.appServer) !== 'alive') throw new Error('Root requires its retained actual native start and current process');
  const file = launchFile(paths, profile.id, launch.appServer), current = readLaunch(file, profile, launch.appServer);
  if (!current || current.nonce !== launch.nonce || !current.nativeStart || current.nativeStart.nativeThreadId !== start.nativeThreadId
    || current.nativeStart.transcript !== start.transcript) throw new Error('Root start proof changed before owner realization');
  const proofVersion = recordVersion(file);
  const validateOwner = () => {
    const currentPaths = servicePaths(host, env);
    if (!sameRecordVersion(proofVersion) || !sameRecordVersion(profileVersion)
      || currentPaths.root !== paths.root || currentPaths.home !== paths.home || currentPaths.base !== paths.base
      || runtimeIdentity(host) !== profile.runtime) throw new Error('Root proof, approved profile or owner changed during realization');
    if (readCreationKey(paths, profile.id, profile.runtime) !== operation) throw new Error('Root creation operation or execution scope changed before native realization');
  };
  validateOwner();
  credentialOf(paths, launch);
  const transcript = readCodexRootTranscript({ nativeStore: profile.nativeStore, transcript: start.transcript, nativeThreadId: start.nativeThreadId });
  if (transcript.source !== 'cli' && transcript.source !== 'vscode') throw new Error('BB root requires a cli or vscode native SessionMeta source');
  const snapshot = readOwnerEnvironment(host, profile.ownerEnvironment, { env });
  const options = { env: { ...snapshot, PROMPTOBUS_SERVICE_HOME: paths.base }, pollEnv: snapshot, cwd: paths.root };
  return createRootAdmission(host, options).realizeRoot({ profileId: profile.id, nativeStore: transcript.nativeStore,
    generation: { nativeThreadId: transcript.nativeThreadId, appServer: launch.appServer, nonce: launch.nonce } }, async () => {
    const result = await runAsync(profile.bb, ['promptobus', 'root', 'lookup', '--root', paths.root, '--native-thread', transcript.nativeThreadId],
      { env: snapshot, cwd: paths.root, encoding: 'utf8', timeoutMs: 5000 });
    validateOwner();
    if (result.status !== 0) throw new Error('BB root lookup did not establish authoritative native correspondence');
    const value: unknown = JSON.parse(result.stdout);
    if (!recordOf(value) || value.root !== paths.root || value.home !== paths.home) throw new Error('BB root lookup returned a different canonical workspace or store');
    return value;
  }, async () => {
    if (!existsSync(launch.credentialFile)) throw new Error('Root client was revoked before native realization');
    validateOwner();
    await realizeServiceClient(host, launch.clientId, transcript.nativeThreadId, options);
  }, validateOwner);
}

export async function authorizeCodexRootStart(host: PromptobusHost, id: string, event: Readonly<Record<string, unknown>>, env = process.env) {
  if (event.hook_event_name !== 'SessionStart') return;
  if (typeof event.session_id !== 'string' || typeof event.transcript_path !== 'string') throw new Error('Root start requires the actual native session and transcript');
  const paths = servicePaths(host, env), profileVersion = recordVersion(profileFile(paths, id));
  const profile = readProfile(host, id, env);
  const operation = readCreationKey(paths, id, profile.runtime);
  const appServer = observeCodexAppServer();
  const file = launchFile(paths, id, appServer), launch = readLaunch(file, profile, appServer);
  const validateProfile = () => {
    const current = servicePaths(host, env);
    if (!sameRecordVersion(profileVersion) || current.root !== paths.root || current.home !== paths.home
      || current.base !== paths.base || runtimeIdentity(host) !== profile.runtime) throw new Error('Root hook approved profile or owner changed');
    if (readCreationKey(paths, id, profile.runtime) !== operation) throw new Error('Root hook creation operation or execution scope changed');
  };
  validateProfile();
  if (!launch) throw new Error('Root start has no pending native headers-helper generation');
  credentialOf(paths, launch);
  const transcript = readCodexRootTranscript({ nativeStore: profile.nativeStore, transcript: event.transcript_path, nativeThreadId: event.session_id });
  if (transcript.source !== 'cli' && transcript.source !== 'vscode') throw new Error('BB root requires a cli or vscode native SessionMeta source');
  const start = { nativeThreadId: transcript.nativeThreadId, transcript: transcript.transcript };
  const lock = `${file}.lock`, deadline = Date.now() + 5000;
  let release = await acquireServiceLock(lock);
  while (!release) {
    if (Date.now() >= deadline) throw new Error('Root native start proof is being published');
    await new Promise(resolve => setTimeout(resolve, 20));
    release = await acquireServiceLock(lock);
  }
  try {
    validateProfile();
    const current = readLaunch(file, profile, appServer);
    if (!current || current.nonce !== launch.nonce || (current.nativeStart
      && (current.nativeStart.nativeThreadId !== start.nativeThreadId || current.nativeStart.transcript !== start.transcript))) {
      throw new Error('Root native start cannot substitute its immutable generation');
    }
    if (!current.nativeStart) writePrivate(file, { ...current, nativeStart: start });
  } finally { release(); }
  const pending = await createRootAdmission(host, { env }).deferRootCreation(id, file,
    { nativeThreadId: transcript.nativeThreadId, appServer, nonce: launch.nonce }, validateProfile);
  if (pending) return;
  await realizeCapturedRoot(host, profile, { ...launch, nativeStart: start }, env, profileVersion, operation);
}

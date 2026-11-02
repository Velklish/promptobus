import { shellQuote } from '../dist/fs/shell.js';
import { randomUUID } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { PromptobusHost } from '../dist/index.js';
import type { LibDriver, LibLaunchPlan, LibMcpServer } from './driver-runtime.js';
import { actorIdentityVariables, replaceManagedMcpServers } from './drivers.js';
import { PROMPTOBUS_SERVER } from './contract.js';
import { canonicalPath, taskExists, withTaskLock, writeJsonAtomic } from './store.js';
import { revokeFailedManagedLaunch } from './driver-common.js';
import { bindServiceClient, realizeServiceClient, registerServiceClient, revokeServiceClient } from './service-client.js';
import type { ServiceCallOptions } from './service-client.js';
import type { ServiceClientInput, ServiceNativeHarness } from './service.js';
import { prepareServicePaths, readPrivate, recordOf, recordVersion, runtimeIdentity, sameRecordVersion, servicePaths, writePrivate } from './service-state.js';

export const OWNER_ENV_FILE = 'PROMPTOBUS_OWNER_ENV_FILE';
export const CLIENT_TOKEN = 'PROMPTOBUS_CLIENT_TOKEN';
export const CLIENT_FILE = 'PROMPTOBUS_CLIENT_FILE';
const RECORD_VARS = ['PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CURSOR_SESSION', 'PROMPTOBUS_CODEX_SESSION', 'PROMPTOBUS_OPENCODE_SESSION'];
const CLIENT_ID = /^[a-f0-9-]{36}$/;
const nativeHarness = (value: unknown): value is ServiceNativeHarness => value === 'claude' || value === 'cursor' || value === 'codex' || value === 'opencode';

export interface ManagedServiceLaunch {
  launchId: string; clientId: string; credentialFile: string;
  beforeStart(record: string): Promise<void>;
  realize(nativeId: string): Promise<void>;
  revoke(): Promise<void>;
}
interface ServiceLaunchPlan extends LibLaunchPlan {
  service?: ManagedServiceLaunch; env?: NodeJS.ProcessEnv;
  serviceScopes?: { server: string; task: string; address: string; record: string }[];
  serviceFiles?: NonNullable<ServiceClientInput['files']>;
}
export interface ManagedServiceLaunchInput {
  launch: ServiceLaunchPlan; driver: LibDriver; home: string; task: string; address: string; ref: string;
  cwd: string; env: NodeJS.ProcessEnv; commonEnv: NodeJS.ProcessEnv;
  files?: NonNullable<ServiceClientInput['files']>;
  deferTaskBinding?: boolean;
}

function stringEnvironment(value: unknown): NodeJS.ProcessEnv {
  if (!recordOf(value) || Object.values(value).some(item => item !== undefined && typeof item !== 'string')) {
    throw new Error('Owner environment snapshot must contain string values');
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string') env[key] = item;
  return env;
}

export function createOwnerEnvironment(host: PromptobusHost, env: NodeJS.ProcessEnv) {
  const paths = servicePaths(host, env);
  prepareServicePaths(paths);
  const file = path.join(paths.directory, `owner-environment-${randomUUID()}.json`);
  const snapshot = { ...env };
  delete snapshot[OWNER_ENV_FILE];
  for (const name of Object.keys(snapshot)) if (name.startsWith('PROMPTOBUS_CLIENT_') || name.startsWith('PROMPTOBUS_ROOT_')) delete snapshot[name];
  writePrivate(file, { schemaVersion: 1, root: paths.root, home: paths.home, runtime: runtimeIdentity(host), env: snapshot });
  return file;
}

export function readOwnerEnvironment(host: PromptobusHost, file: string, { env = process.env }: ServiceCallOptions = {}) {
  const paths = servicePaths(host, env);
  if (!path.isAbsolute(file) || path.dirname(file) !== paths.directory || !/^owner-environment-[a-f0-9-]{36}\.json$/.test(path.basename(file))) {
    throw new Error('Owner environment snapshot belongs to a different shared service');
  }
  const value = readPrivate(file);
  if (!recordOf(value) || value.schemaVersion !== 1 || value.root !== paths.root || value.home !== paths.home || value.runtime !== runtimeIdentity(host)) {
    throw new Error('Owner environment snapshot identity does not match this workspace and runtime');
  }
  return Object.freeze(stringEnvironment(value.env));
}

function ownerEnvironment(host: PromptobusHost, env: NodeJS.ProcessEnv, commonEnv: NodeJS.ProcessEnv) {
  const file = env[OWNER_ENV_FILE] || commonEnv[OWNER_ENV_FILE];
  if (file) return { file, env: readOwnerEnvironment(host, file, { env: { ...commonEnv, ...env } }) };
  const managed = (source: NodeJS.ProcessEnv) => {
    const role = source.PROMPTOBUS_ROLE?.trim();
    return (role && role !== 'orchestrator') || RECORD_VARS.some(name => source[name]?.trim());
  };
  if (managed(env) || managed(commonEnv)) {
    throw new Error('Managed launch requires the private root owner environment reference; reconnect through the root launcher');
  }
  const created = createOwnerEnvironment(host, commonEnv);
  return { file: created, env: readOwnerEnvironment(host, created, { env: commonEnv }) };
}

export function managedServiceServers(harness: ServiceNativeHarness, credential: { busUrl: string; filesUrl: string | null }, tokenVariable = CLIENT_TOKEN) {
  const server = (url: string): LibMcpServer => harness === 'codex'
    ? { type: 'http', url, bearer_token_env_var: tokenVariable }
    : { type: 'http', url, ...(harness === 'opencode' ? { oauth: false as const } : {}), headers: {
      Authorization: `Bearer ${harness === 'claude' ? '${' + tokenVariable + '}'
        : harness === 'cursor' ? '${env:' + tokenVariable + '}' : '{env:' + tokenVariable + '}'}`,
    } };
  return { [PROMPTOBUS_SERVER]: server(credential.busUrl),
    ...(credential.filesUrl ? { reviewer_files: server(credential.filesUrl) } : {}) };
}

function clientEnvironment(env: NodeJS.ProcessEnv) {
  const own = { ...env };
  for (const name of [...actorIdentityVariables(), 'OPENCODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']) delete own[name];
  for (const name of Object.keys(own)) if (name.startsWith('PROMPTOBUS_CLIENT_') || name.startsWith('PROMPTOBUS_ROOT_')) delete own[name];
  return own;
}

interface ManagedHookContext {
  harness: ServiceNativeHarness; home: string; task: string; address: string; ref: string; record: string; launchId: string;
  deferTaskBinding: boolean;
}
const stagedLaunchFile = (directory: string, id: string) => path.join(directory, `launch-${id}.json`);

function managedCredential(host: PromptobusHost, file: string, options: ServiceCallOptions) {
  const paths = servicePaths(host, options.env), id = path.basename(file, '.json');
  if (!CLIENT_ID.test(id) || file !== path.join(paths.clients, `${id}.json`)) throw new Error('Managed client credential belongs to another service');
  const value = readPrivate(file);
  if (!recordOf(value) || value.id !== id || value.runtime !== runtimeIdentity(host) || !recordOf(value.lifetime)
    || !recordOf(value.nativeBinding)) throw new Error('Managed client has no native launch binding');
  return { id, paths, value };
}

export function readManagedServiceHookContext(host: PromptobusHost, file: string, options: ServiceCallOptions = {}): ManagedHookContext {
  const { id, paths, value: grant } = managedCredential(host, file, options);
  const value = readPrivate(stagedLaunchFile(paths.directory, id));
  if (!recordOf(value) || value.runtime !== runtimeIdentity(host) || value.home !== paths.home || !recordOf(grant.nativeBinding)
    || !nativeHarness(value.harness) || value.harness !== grant.nativeBinding.kind || typeof value.task !== 'string' || typeof value.address !== 'string'
    || typeof value.ref !== 'string' || typeof value.launchId !== 'string' || typeof value.record !== 'string'
    || !path.isAbsolute(value.record) || typeof value.deferTaskBinding !== 'boolean') throw new Error('Managed launch has no matching staged record');
  if (!recordOf(grant.env) || grant.env.PROMPTOBUS_TASK !== value.task || grant.env.PROMPTOBUS_ROLE !== value.address) {
    throw new Error('Managed launch task and address do not match the client');
  }
  if (!recordOf(grant.lifetime) || (grant.lifetime.kind !== 'managed' && (grant.lifetime.kind !== 'reservation' || !value.deferTaskBinding))
    || (grant.lifetime.kind === 'managed' && (grant.lifetime.task !== value.task || grant.lifetime.address !== value.address
      || grant.lifetime.ref !== value.ref || grant.lifetime.launchId !== value.launchId || grant.lifetime.record !== value.record))) {
    throw new Error('Managed launch lifetime does not match the staged record');
  }
  const record = readPrivate(value.record);
  if (!recordOf(record) || typeof record.home !== 'string' || canonicalPath(record.home) !== paths.home || record.task !== value.task
    || record.address !== value.address || record.ref !== value.ref || record.launchId !== value.launchId) throw new Error('Managed launch record identity changed');
  return { harness: value.harness, home: paths.home, task: value.task, address: value.address,
    ref: value.ref, record: value.record, launchId: value.launchId, deferTaskBinding: value.deferTaskBinding };
}

/** Read only the exact staged launch capability; this helper never starts the service. */
export function managedServiceHeaders(host: PromptobusHost, file: string, options: ServiceCallOptions = {}) {
  const { value } = managedCredential(host, file, options);
  const context = readManagedServiceHookContext(host, file, options);
  if (context.harness !== 'claude' || typeof value.token !== 'string' || !value.token) {
    throw new Error('Managed headers require a staged Claude client');
  }
  return { Authorization: `Bearer ${value.token}` };
}

export async function realizeManagedServiceClient(host: PromptobusHost, file: string, nativeId: string, options: ServiceCallOptions = {}) {
  const { id, value } = managedCredential(host, file, options);
  const context = readManagedServiceHookContext(host, file, options);
  if (recordOf(value.lifetime) && value.lifetime.kind === 'reservation') {
    if (!context.deferTaskBinding) throw new Error('Managed lifetime has not been published');
    await bindServiceClient(host, id, { kind: 'managed', task: context.task, address: context.address, ref: context.ref,
      launchId: context.launchId, record: context.record }, options);
  }
  await realizeServiceClient(host, id, nativeId, options);
}

export async function finalizeManagedServiceLaunch(host: PromptobusHost, input: ManagedServiceLaunchInput) {
  const { launch, driver, home, task, address, ref, cwd, env, commonEnv, files, deferTaskBinding = false } = input;
  if (launch.service) throw new Error('Managed HTTP launch was already finalized');
  if (!nativeHarness(driver.id)) throw new Error('Unsupported managed HTTP harness');
  if (canonicalPath(home) !== canonicalPath(host.promptobusHome())) throw new Error('Managed HTTP launch belongs to another store');
  const owner = ownerEnvironment(host, env, commonEnv), actorEnv = clientEnvironment({ ...env, ...launch.env });
  actorEnv.PROMPTOBUS_HOME = canonicalPath(home);
  actorEnv.PROMPTOBUS_TASK = task;
  actorEnv.PROMPTOBUS_ROLE = address;
  const options: ServiceCallOptions = { cwd, env: { ...owner.env, PROMPTOBUS_SERVICE_HOME: servicePaths(host, env).base }, pollEnv: owner.env };
  const paths = servicePaths(host, options.env);
  const launchId = launch.launchId ?? randomUUID();
  const scopes: { server: string; task: string; address: string; record: string | null; files?: ManagedServiceLaunchInput['files']; deferTaskBinding: boolean }[] = [
    { server: PROMPTOBUS_SERVER, task, address, record: null, files: files ?? launch.serviceFiles, deferTaskBinding },
    ...(launch.serviceScopes ?? []).map(scope => ({ ...scope, files: undefined, deferTaskBinding: true }))];
  if (new Set(scopes.map(scope => scope.server)).size !== scopes.length) throw new Error('Managed launch server scopes overlap');
  const registrations: { scope: typeof scopes[number]; credential: Awaited<ReturnType<typeof registerServiceClient>>; tokenVariable: string }[] = [];
  let revocation: Promise<void> | null = null;
  const revoke = () => revocation ??= (async () => {
    const failures: { clientId: string; credentialFile: string; error: unknown }[] = [];
    for (const { credential } of registrations) {
      try {
        await revokeServiceClient(host, credential.clientId, options);
        rmSync(stagedLaunchFile(paths.directory, credential.clientId), { force: true });
      } catch (error) { failures.push({ clientId: credential.clientId, credentialFile: credential.credentialFile, error }); }
    }
    if (failures.length) {
      const details = failures.map(failure => `${failure.clientId} (${failure.credentialFile}): `
        + `${failure.error instanceof Error ? failure.error.message : String(failure.error)}`).join('; ');
      throw new AggregateError(failures.map(failure => failure.error), `Managed grant cleanup failed: ${details}. `
        + 'Failed owned grant references remain unresolved; inspect them before retrying');
    }
  })();
  try {
    for (const scope of scopes) {
      const credential = await registerServiceClient(host, { cwd, env: { ...actorEnv, PROMPTOBUS_TASK: scope.task, PROMPTOBUS_ROLE: scope.address },
        pollEnv: owner.env, nativeBinding: { kind: driver.id, state: 'pending' }, ...(scope.files ? { files: scope.files } : {}) }, options);
      registrations.push({ scope, credential, tokenVariable: registrations.length === 0 ? CLIENT_TOKEN
        : `${CLIENT_TOKEN}_${credential.clientId.replaceAll('-', '').toUpperCase()}` });
    }
    const first = registrations[0]!;
    let stagedRecord: string | null = null;
    const service: ManagedServiceLaunch = { launchId, clientId: first.credential.clientId, credentialFile: first.credential.credentialFile,
      async beforeStart(record) {
        if (stagedRecord && stagedRecord !== record) throw new Error('Managed launch already owns another record');
        for (const { scope, credential } of registrations) {
          const ownedFile = scope.record ?? record;
          const stage = () => {
            const version = recordVersion(ownedFile), owned = readPrivate(ownedFile);
            if (!recordOf(owned) || typeof owned.home !== 'string' || canonicalPath(owned.home) !== paths.home || owned.task !== scope.task
              || owned.address !== scope.address || owned.ref !== ref || owned.launchId !== launchId) throw new Error('Managed launch record identity changed');
            let nativeStore: string | null = null;
            if (driver.id === 'claude') {
              const store = (source: NodeJS.ProcessEnv) => source.CLAUDE_CONFIG_DIR
                || ((process.platform === 'win32' ? source.USERPROFILE : source.HOME) ? path.join((process.platform === 'win32' ? source.USERPROFILE : source.HOME)!, '.claude') : null);
              const trustedStore = store(owner.env), actualStore = store(actorEnv);
              if (trustedStore && actualStore && path.isAbsolute(trustedStore) && path.isAbsolute(actualStore)) {
                try {
                  const trusted = realpathSync(trustedStore);
                  if (trusted === realpathSync(actualStore)) nativeStore = trusted;
                } catch { /* Missing native state is not established by an environment default. */ }
              }
            }
            if (!sameRecordVersion(version)) throw new Error('Managed launch record changed before provenance staging');
            writeJsonAtomic(ownedFile, { ...owned, nativeLaunchProvenance: { harness: driver.id, ownerEnvironment: owner.file,
              state: nativeStore ? 'candidate' : 'unknown', nativeStore, source: nativeStore ? (owner.env.CLAUDE_CONFIG_DIR ? 'owner-environment/CLAUDE_CONFIG_DIR' : 'owner-environment/native-default') : 'unknown',
              ...(nativeStore ? {} : { reason: 'actual native identity store is not established by the trusted launch snapshot' }) } }, { mode: 0o600 });
          };
          if (taskExists(home, scope.task)) withTaskLock(home, scope.task, stage); else stage();
          writePrivate(stagedLaunchFile(paths.directory, credential.clientId), { runtime: runtimeIdentity(host), harness: driver.id,
            home: paths.home, task: scope.task, address: scope.address, ref, launchId, record: ownedFile, deferTaskBinding: scope.deferTaskBinding });
          if (!scope.deferTaskBinding) await bindServiceClient(host, credential.clientId,
            { kind: 'managed', task: scope.task, address: scope.address, ref, launchId, record: ownedFile }, options);
          readManagedServiceHookContext(host, credential.credentialFile, options);
        }
        stagedRecord = record;
      },
      async realize(nativeId) {
        for (const { credential } of registrations) await realizeManagedServiceClient(host, credential.credentialFile, nativeId, options);
      },
      revoke,
    };
    const servers: Record<string, LibMcpServer> = {};
    const ownEnv: NodeJS.ProcessEnv = { ...actorEnv, [OWNER_ENV_FILE]: owner.file,
      PROMPTOBUS_SERVICE_HOME: paths.base, [CLIENT_FILE]: first.credential.credentialFile };
    for (const { scope, credential, tokenVariable } of registrations) {
      const prepared = managedServiceServers(driver.id, credential, tokenVariable);
      if (driver.id === 'claude') {
        const headersHelper = [host.nodePath(), ...host.busArgv(['service', 'headers', '--client-file', credential.credentialFile,
          '--service-home', paths.base])].map(shellQuote).join(' ');
        for (const descriptor of Object.values(prepared)) {
          delete descriptor.headers;
          descriptor.headersHelper = headersHelper;
        }
      }
      servers[scope.server] = prepared[PROMPTOBUS_SERVER]!;
      if (prepared.reviewer_files) servers.reviewer_files = prepared.reviewer_files;
      ownEnv[tokenVariable] = credential.token;
    }
    launch.service = service;
    launch.env = ownEnv;
    replaceManagedMcpServers(driver, launch, servers);
    return { service, env: ownEnv };
  } catch (error) {
    return revokeFailedManagedLaunch(launch, error, undefined, revoke);
  }
}

export { revokeFailedManagedLaunch };

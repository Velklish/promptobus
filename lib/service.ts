import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmodSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { PromptobusHost } from '../dist/index.js';
import { admitsAddress, registryOf, sessionRefOf } from '../dist/index.js';
import type { JsonRpcMessage } from '../dist/mcp/server.js';
import { mcpTools } from '../dist/mcp/tools.js';
import { busConnection } from './server.js';
import { canonicalPath, participantOf, readTask } from './store.js';
import { participantSession } from './status.js';
import { actorIdentityVariables, REGISTRY } from './drivers.js';
import { bindServiceHarnessContext, requireServiceHarnessContext } from './harness-home.js';
import { REVIEW_FILE_TOOLS, reviewerFiles } from './reviewer-files.js';
import { PROMPTOBUS_SERVER, PROTOCOL_VERSIONS } from './contract.js';
import {
  acquireServiceLock, contained, prepareControlSocket, prepareServicePaths, privateDirectory, processRecord, readDiscovery, readPrivate,
  recordOf, requireProcess, runtimeIdentity, processState, servicePaths, writePrivate,
} from './service-state.js';
import type { ProcessIdentity, ServiceDiscovery, ServicePaths } from './service-state.js';

export type ServiceHostFactory = (context: { cwd: string; env: Readonly<NodeJS.ProcessEnv> }) => PromptobusHost | Promise<PromptobusHost>;
export type ServiceClientLifetime =
  | { kind: 'reservation'; expiresAt: number }
  | { kind: 'process'; process: ProcessIdentity }
  | { kind: 'managed'; task: string; address: string; ref: string; launchId: string; record: string };
export type ServiceNativeBinding =
  | { kind: 'codex'; state: 'pending' }
  | { kind: 'codex'; state: 'bound'; threadId: string };
export interface ServiceClientInput {
  cwd: string; env: NodeJS.ProcessEnv; lifetime?: ServiceClientLifetime;
  files?: { roots: string[]; canonicalFiles?: string[] };
  nativeBinding?: ServiceNativeBinding;
}
export interface ServiceClientGrant {
  schemaVersion: 1; id: string; token: string; runtime: string; cwd: string; env: NodeJS.ProcessEnv;
  lifetime: ServiceClientLifetime; files: { roots: string[]; canonicalFiles: string[] } | null;
  nativeBinding?: ServiceNativeBinding;
}
export interface ServiceClientCredential { clientId: string; token: string; credentialFile: string; busUrl: string; filesUrl: string | null }
export interface ServiceStatus extends ServiceDiscovery { clients: number; reservations: number; unknownClients: number; unknownManaged: number; sessions: number }
export interface RunServiceOptions {
  host: PromptobusHost; createHost: ServiceHostFactory; env?: NodeJS.ProcessEnv;
  activeWork?: () => boolean;
}
interface ConnectionRecord { id: string; client: string; endpoint: Endpoint; protocol: string; initialized: boolean }
type Endpoint = 'bus' | 'reviewer_files';
interface Connection { handle: (message: JsonRpcMessage) => object | null }
interface ClientContext { grant: ServiceClientGrant; host: PromptobusHost; env: Readonly<NodeJS.ProcessEnv> }
interface RequestReceipt { digest: string; state: 'started' | 'completed'; readOnly: boolean; response?: object | null }
class HttpFailure extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const HTTP_PROTOCOLS = PROTOCOL_VERSIONS.filter(version => version !== '2024-11-05');
const CLIENT_ID = /^[a-f0-9-]{36}$/;
const MAX_BODY = 16 * 1024 * 1024;
const REPLAYABLE_READS = new Set(['read_file', 'read_files', 'list_files', 'search_text']);
const field = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : null;
const tokenEquals = (a: string, b: string) => {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};
const clientFile = (paths: ServicePaths, id: string) => path.join(paths.clients, `${id}.json`);
const sessionFile = (paths: ServicePaths, id: string) => path.join(paths.sessions, `${id}.json`);

function lifetimeOf(value: unknown): ServiceClientLifetime | null {
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

function environmentOf(value: unknown): NodeJS.ProcessEnv {
  if (!recordOf(value) || Object.values(value).some(item => item !== undefined && typeof item !== 'string')) throw new Error('Client env must contain string values');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('PROMPTOBUS_SERVICE_') || key.startsWith('PROMPTOBUS_CLIENT_')) continue;
    if (typeof item === 'string') env[key] = item;
  }
  return env;
}

const nativeThreadId = (value: unknown): value is string => typeof value === 'string' && /^\S+$/u.test(value);

function nativeBindingOf(value: unknown): ServiceNativeBinding | undefined {
  if (value === undefined) return undefined;
  if (recordOf(value) && value.kind === 'codex') {
    if (value.state === 'pending' && value.threadId === undefined) return { kind: 'codex', state: 'pending' };
    if (value.state === 'bound' && nativeThreadId(value.threadId)) return { kind: 'codex', state: 'bound', threadId: value.threadId };
  }
  throw new HttpFailure(400, 'Invalid Codex native binding');
}

function clientEnvironment(grant: ServiceClientGrant): Readonly<NodeJS.ProcessEnv> {
  const env = { ...grant.env };
  if (grant.nativeBinding) {
    if (grant.nativeBinding.state !== 'bound') throw new HttpFailure(403, 'Codex native binding is pending owner realization');
    for (const name of actorIdentityVariables()) delete env[name];
    if (grant.lifetime.kind === 'managed') env[REGISTRY.drivers.codex.options.mcpIdentity!.recordVar] = grant.lifetime.record;
    env.CODEX_THREAD_ID = grant.nativeBinding.threadId;
  }
  return Object.freeze(env);
}

function requireNativeCall(grant: ServiceClientGrant, message: JsonRpcMessage) {
  if (!grant.nativeBinding || message.method !== 'tools/call') return;
  if (grant.nativeBinding.state !== 'bound') throw new HttpFailure(403, 'Codex native binding is pending owner realization');
  const meta = message.params?._meta;
  if (!recordOf(meta) || !nativeThreadId(meta.threadId) || meta.threadId !== grant.nativeBinding.threadId) {
    throw new HttpFailure(403, 'Codex tool call requires the bound native thread id in params._meta.threadId');
  }
}

function filesOf(value: unknown): ServiceClientGrant['files'] {
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

function grantOf(value: unknown): ServiceClientGrant {
  if (!recordOf(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !CLIENT_ID.test(value.id)
    || !field(value.token) || !field(value.runtime) || !field(value.cwd)) throw new Error('Invalid shared service client grant');
  const lifetime = lifetimeOf(value.lifetime);
  if (!lifetime) throw new Error('Invalid shared service client lifetime');
  return { schemaVersion: 1, id: value.id, token: String(value.token), runtime: String(value.runtime), cwd: String(value.cwd),
    env: environmentOf(value.env), lifetime, files: filesOf(value.files),
    ...(value.nativeBinding === undefined ? {} : { nativeBinding: nativeBindingOf(value.nativeBinding) }) };
}

function connectionOf(value: unknown): ConnectionRecord | null {
  if (!recordOf(value) || typeof value.id !== 'string' || !CLIENT_ID.test(value.id) || typeof value.client !== 'string'
    || !CLIENT_ID.test(value.client) || (value.endpoint !== 'bus' && value.endpoint !== 'reviewer_files')
    || typeof value.protocol !== 'string' || !HTTP_PROTOCOLS.includes(value.protocol) || typeof value.initialized !== 'boolean') return null;
  return { id: value.id, client: value.client, endpoint: value.endpoint, protocol: value.protocol, initialized: value.initialized };
}

function jsonRpc(value: unknown): JsonRpcMessage & { jsonrpc: '2.0' } {
  if (!recordOf(value) || value.jsonrpc !== '2.0' || (value.id !== undefined && typeof value.id !== 'string' && typeof value.id !== 'number')
    || (typeof value.id === 'number' && !Number.isFinite(value.id)) || (value.method !== undefined && typeof value.method !== 'string')
    || (value.params !== undefined && !recordOf(value.params))
    || (value.method === undefined && !Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error'))) throw new HttpFailure(400, 'Expected one JSON-RPC message');
  return { jsonrpc: '2.0', ...(value.id === undefined ? {} : { id: value.id }),
    ...(typeof value.method === 'string' ? { method: value.method } : {}), ...(recordOf(value.params) ? { params: value.params } : {}) };
}

function managedParticipant(proof: Extract<ServiceClientLifetime, { kind: 'managed' }>, home: string) {
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

function lifetimeState(grant: ServiceClientGrant, home: string): 'alive' | 'dead' | 'unknown' {
  const proof = grant.lifetime;
  if (proof.kind === 'reservation') return Date.now() < proof.expiresAt ? 'alive' : 'dead';
  if (proof.kind === 'process') return processState(proof.process);
  try {
    const participant = managedParticipant(proof, home);
    return participant ? participantSession(participant) : 'dead';
  } catch { return 'unknown'; }
}

function requireLifetime(grant: ServiceClientGrant, home: string, status = 409) {
  if (grant.lifetime.kind === 'managed') {
    try {
      if (!managedParticipant(grant.lifetime, home)) throw new Error('mismatched participant');
    } catch { throw new HttpFailure(status, 'Managed lifetime has no matching task, participant and launch record'); }
  }
  if (lifetimeState(grant, home) === 'dead') throw new HttpFailure(status, 'Client lifetime is already expired or replaced');
}

function privateReadGrants(paths: ServicePaths, files: NonNullable<ServiceClientGrant['files']>) {
  for (const root of [...files.roots, ...files.canonicalFiles]) {
    const canonical = canonicalPath(root);
    if (contained(canonical, paths.base) || contained(paths.base, canonical)) {
      throw new Error('Reviewer grants overlap private shared-service credentials; narrow the read roots');
    }
    if (realpathSync(root) !== root) throw new Error('Canonical reviewer grant changed; prepare a new client');
  }
  return reviewerFiles(files.roots, files.canonicalFiles);
}

function fileConnection(read: ReturnType<typeof reviewerFiles>, version: string): Connection {
  return { handle(message) {
    if (message.id === undefined || message.id === null) return null;
    const response = { jsonrpc: '2.0', id: message.id };
    if (message.method === 'initialize') return { ...response, result: { protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'promptobus-reviewer-files', version } } };
    if (message.method === 'ping') return { ...response, result: {} };
    if (message.method === 'tools/list') return { ...response, result: { tools: REVIEW_FILE_TOOLS } };
    if (message.method === 'tools/call') {
      try {
        if (typeof message.params?.name !== 'string' || (message.params.arguments !== undefined && !recordOf(message.params.arguments))) throw new Error('Invalid file tool call');
        return { ...response, result: { content: [{ type: 'text', text: JSON.stringify(read(message.params.name, message.params.arguments ?? {})) }] } };
      } catch (error) { return { ...response, result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'File tool failed' }] } }; }
    }
    return { ...response, error: { code: -32601, message: 'Method not found' } };
  } };
}

function nativeDiscovery(host: PromptobusHost, endpoint: Endpoint): Connection {
  return { handle(message) {
    if (message.id === undefined || message.id === null) return null;
    const response = { jsonrpc: '2.0', id: message.id };
    if (message.method === 'initialize') return { ...response, result: { protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: endpoint === 'bus' ? { name: PROMPTOBUS_SERVER, version: host.version }
        : { name: 'promptobus-reviewer-files', version: '1.0.0' } } };
    if (message.method === 'ping') return { ...response, result: {} };
    if (message.method === 'tools/list') return { ...response, result: { tools: endpoint === 'bus' ? mcpTools(registryOf(host)) : REVIEW_FILE_TOOLS } };
    return { ...response, error: { code: -32601, message: 'Method not found' } };
  } };
}

function receiptOf(value: unknown): RequestReceipt | null {
  if (!recordOf(value) || typeof value.digest !== 'string' || (value.state !== 'started' && value.state !== 'completed')
    || typeof value.readOnly !== 'boolean' || (value.response !== undefined && value.response !== null && !recordOf(value.response))) return null;
  return { digest: value.digest, state: value.state, readOnly: value.readOnly, ...(value.response === undefined ? {} : { response: value.response }) };
}

function dispatch(paths: ServicePaths, session: ConnectionRecord, message: JsonRpcMessage, connection: Connection) {
  if (message.method !== 'tools/call' || message.id === undefined || message.id === null) return connection.handle(message);
  const key = createHash('sha256').update(JSON.stringify(message.id)).digest('hex');
  const digest = createHash('sha256').update(JSON.stringify(message)).digest('hex');
  const readOnly = session.endpoint === 'reviewer_files'
    && typeof message.params?.name === 'string' && REPLAYABLE_READS.has(message.params.name)
    && REVIEW_FILE_TOOLS.some(tool => tool.name === message.params?.name && tool.annotations.readOnlyHint === true);
  const directory = path.join(paths.requests, session.id);
  privateDirectory(directory);
  const file = path.join(directory, `${key}.json`), previous = readPrivate(file);
  if (previous !== null) {
    const receipt = receiptOf(previous);
    if (!receipt) throw new HttpFailure(409, 'The saved request receipt is invalid; inspect the journal before retrying');
    if (receipt.digest !== digest) throw new HttpFailure(409, 'This request id was already used for different arguments');
    if (receipt.readOnly && readOnly) return connection.handle(message);
    if (receipt.state === 'started') throw new HttpFailure(409, 'The earlier request outcome is uncertain; inspect the journal instead of repeating it');
    return receipt.response ?? null;
  }
  writePrivate(file, { digest, state: 'started', readOnly });
  const response = connection.handle(message);
  writePrivate(file, { digest, state: 'completed', readOnly, ...(readOnly ? {} : { response }) });
  return response;
}

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

export async function runWorkspaceService({ host, createHost, env = process.env, activeWork = () => false }: RunServiceOptions) {
  const paths = servicePaths(host, env), runtime = runtimeIdentity(host);
  prepareServicePaths(paths);
  const release = await acquireServiceLock(paths.lock);
  if (!release) return;
  const lifecycle: { stop?: () => void } = {};
  let timer: NodeJS.Timeout | null = null;
  let http: ReturnType<typeof createServer> | null = null;
  let ipc: ReturnType<typeof createServer> | null = null;
  try {
    const prior = readDiscovery(paths);
    const ownerValue = readPrivate(paths.owner);
    if (ownerValue !== null && (!recordOf(ownerValue) || typeof ownerValue.token !== 'string' || !/^[a-f0-9]{64}$/.test(ownerValue.token))) throw new Error('Shared service owner credential is invalid');
    const ownerToken = recordOf(ownerValue) && typeof ownerValue.token === 'string' ? ownerValue.token : randomBytes(32).toString('hex');
    writePrivate(paths.owner, { token: ownerToken });
    const expectedHarness = bindServiceHarnessContext(host, env, REGISTRY);
    const contexts = new Map<string, ClientContext>();
    const connections = new Map<string, { context: ClientContext; connection: Connection }>();
    let discovery: ServiceDiscovery;
    let closing = false, requests = 0, idleSince = Date.now();
    const idleMs = Number(env.PROMPTOBUS_SERVICE_IDLE_MS ?? 30_000);
    const reservationMs = Number(env.PROMPTOBUS_SERVICE_RESERVATION_MS ?? 120_000);
    if (!Number.isSafeInteger(idleMs) || idleMs < 1 || !Number.isSafeInteger(reservationMs) || reservationMs < 1) throw new Error('Invalid shared service lifetime duration');

    const grants = () => readdirSync(paths.clients).filter(name => CLIENT_ID.test(name.slice(0, -5)) && name.endsWith('.json'))
      .map(name => {
        const grant = grantOf(readPrivate(path.join(paths.clients, name)));
        if (`${grant.id}.json` !== name) throw new Error('Client grant identity does not match its file');
        return grant;
      });
    const removeSession = (id: string) => {
      rmSync(sessionFile(paths, id), { force: true });
      rmSync(path.join(paths.requests, id), { recursive: true, force: true });
      connections.delete(id);
    };
    const removeClient = (id: string) => {
      rmSync(clientFile(paths, id), { force: true });
      contexts.delete(id);
      for (const file of readdirSync(paths.sessions)) {
        const record = connectionOf(readPrivate(path.join(paths.sessions, file)));
        if (record?.client === id) removeSession(record.id);
      }
    };
    const state = () => {
      let clients = 0, reservations = 0, unknownClients = 0, unknownManaged = 0;
      for (const grant of grants()) {
        const life = lifetimeState(grant, paths.home);
        if (life === 'dead') { removeClient(grant.id); continue; }
        if (grant.runtime !== runtime) throw new Error('Live clients belong to another shared service runtime; close and reconnect them before upgrade');
        clients += 1;
        if (grant.lifetime.kind === 'reservation') reservations += 1;
        if (life === 'unknown') {
          unknownClients += 1;
          if (grant.lifetime.kind === 'managed') unknownManaged += 1;
        }
      }
      return { clients, reservations, unknownClients, unknownManaged, sessions: readdirSync(paths.sessions).filter(name => name.endsWith('.json')).length };
    };
    state();

    const contextFor = async (grant: ServiceClientGrant, revalidate: () => void): Promise<ClientContext> => {
      const cached = contexts.get(grant.id);
      if (cached && isDeepStrictEqual(cached.grant, grant)) return cached;
      const clientEnv = clientEnvironment(grant);
      const clientHost = await createHost({ cwd: grant.cwd, env: clientEnv });
      revalidate();
      const clientPaths = servicePaths(clientHost, env);
      if (clientPaths.root !== paths.root || clientPaths.home !== paths.home) throw new Error('Client Host belongs to a different canonical workspace/store');
      if (runtimeIdentity(clientHost) !== runtime) throw new Error('Client Host belongs to a different shared-service runtime');
      requireServiceHarnessContext(expectedHarness, clientHost, clientEnv, REGISTRY);
      if (!admitsAddress(registryOf(clientHost), clientEnv.PROMPTOBUS_ROLE || 'orchestrator')) throw new Error('Unknown client bus address');
      if (grant.files) privateReadGrants(paths, grant.files);
      const context = { grant, env: clientEnv, host: clientHost };
      return context;
    };
    const authorizeGrant = (grant: ServiceClientGrant) => {
      const value = readPrivate(clientFile(paths, grant.id));
      const current = value === null ? null : grantOf(value);
      if (!current || !tokenEquals(current.token, grant.token) || current.runtime !== runtime || !isDeepStrictEqual(current, grant)) {
        throw new HttpFailure(401, 'Client binding is absent or expired');
      }
      requireLifetime(current, paths.home, 401);
    };
    const authenticateClient = (authorization: string | undefined) => {
      if (!authorization?.startsWith('Bearer ')) throw new HttpFailure(401, 'Client authentication required');
      const bearer = authorization.slice(7);
      const grant = grants().find(candidate => tokenEquals(candidate.token, bearer));
      if (!grant || grant.runtime !== runtime) throw new HttpFailure(401, 'Client binding is absent or expired');
      requireLifetime(grant, paths.home, 401);
      return grant;
    };
    const readConnection = (id: string, grant: ServiceClientGrant, endpoint: Endpoint) => {
      if (!CLIENT_ID.test(id)) throw new HttpFailure(404, 'MCP session not found');
      const record = connectionOf(readPrivate(sessionFile(paths, id)));
      if (!record || record.client !== grant.id || record.endpoint !== endpoint) throw new HttpFailure(404, 'MCP session not found');
      return record;
    };
    const connectionFor = (record: ConnectionRecord, context: ClientContext) => {
      const cached = connections.get(record.id);
      if (cached?.context === context) return cached.connection;
      let connection: Connection;
      if (record.endpoint === 'reviewer_files') {
        if (!context.grant.files) throw new HttpFailure(403, 'This client has no reviewer file grant');
        connection = fileConnection(privateReadGrants(paths, context.grant.files), '1.0.0');
      } else connection = busConnection(context.host, context.env, context.grant.cwd);
      connections.set(record.id, { context, connection });
      return connection;
    };

    const control = async (input: unknown) => {
      if (closing) throw new HttpFailure(503, 'Shared service is stopping');
      if (!recordOf(input) || typeof input.operation !== 'string') throw new HttpFailure(400, 'Invalid service control operation');
      if (input.operation === 'status') return { ...discovery, ...state() };
      if (input.runtime !== runtime) throw new HttpFailure(409, 'Owner request belongs to a different shared service runtime');
      if (input.operation === 'stop') {
        if (state().clients || activeWork() || requests > 1) throw new HttpFailure(409, 'Shared service still has live clients or active work');
        lifecycle.stop?.();
        return { stopped: true };
      }
      if (input.operation === 'register') {
        if (!recordOf(input.client) || typeof input.client.cwd !== 'string' || !path.isAbsolute(input.client.cwd)) throw new HttpFailure(400, 'Client cwd must be absolute');
        const requestedEnv = environmentOf(input.client.env);
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
          cwd: canonicalPath(input.client.cwd), env: requestedEnv, lifetime, files, ...(nativeBinding ? { nativeBinding } : {}) };
        if (lifetime.kind === 'managed' && (requestedEnv.PROMPTOBUS_TASK !== lifetime.task || requestedEnv.PROMPTOBUS_ROLE !== lifetime.address)) throw new HttpFailure(400, 'Managed lifetime does not match the client task/address');
        requireLifetime(grant, paths.home);
        if (files) privateReadGrants(paths, files);
        const context = nativeBinding ? null : await contextFor(grant, () => requireLifetime(grant, paths.home));
        if (closing) throw new HttpFailure(503, 'Shared service is stopping');
        requireLifetime(grant, paths.home);
        writePrivate(clientFile(paths, grant.id), grant);
        if (context) contexts.set(grant.id, context);
        return { clientId: grant.id, token: grant.token, credentialFile: clientFile(paths, grant.id),
          busUrl: `${discovery.url}mcp/bus`, filesUrl: grant.files ? `${discovery.url}mcp/reviewer_files` : null } satisfies ServiceClientCredential;
      }
      if (input.operation === 'revoke' || input.operation === 'bind' || input.operation === 'realize') {
        const id = typeof input.clientId === 'string' ? input.clientId : '';
        if (!CLIENT_ID.test(id)) throw new HttpFailure(400, 'Invalid client id');
        const value = readPrivate(clientFile(paths, id));
        if (value === null) throw new HttpFailure(404, 'Client binding not found');
        const grant = grantOf(value);
        if (input.operation === 'realize') {
          if (!nativeThreadId(input.threadId)) throw new HttpFailure(400, 'Invalid Codex native thread id');
          if (!grant.nativeBinding) throw new HttpFailure(409, 'This client has no Codex native binding');
          requireLifetime(grant, paths.home, 401);
          if (grant.nativeBinding.state === 'bound' && grant.nativeBinding.threadId !== input.threadId) throw new HttpFailure(409, 'Codex client is already bound to another native thread id');
          if (grant.nativeBinding.state === 'pending') writePrivate(clientFile(paths, id), { ...grant,
            nativeBinding: { kind: 'codex', state: 'bound', threadId: input.threadId } });
          return { clientId: id, operation: input.operation };
        }
        if (input.operation === 'bind') {
          const lifetime = lifetimeOf(input.lifetime);
          if (!lifetime || lifetime.kind === 'reservation') throw new HttpFailure(400, 'Binding requires native lifetime proof');
          if (lifetime.kind === 'managed' && (grant.env.PROMPTOBUS_TASK !== lifetime.task || grant.env.PROMPTOBUS_ROLE !== lifetime.address)) throw new HttpFailure(400, 'Managed lifetime does not match the client task/address');
          const updated = { ...grant, lifetime };
          requireLifetime(updated, paths.home);
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
        const endpoint: Endpoint | null = url.pathname === '/mcp/bus' ? 'bus' : url.pathname === '/mcp/reviewer_files' ? 'reviewer_files' : null;
        if (!endpoint) throw new HttpFailure(404, 'Endpoint not found');
        const grant = authenticateClient(request.headers.authorization);
        if (endpoint === 'reviewer_files' && !grant.files) throw new HttpFailure(403, 'This client has no reviewer file grant');
        const header = request.headers['mcp-session-id'];
        if (Array.isArray(header)) throw new HttpFailure(400, 'Invalid MCP session header');
        const protocolHeader = request.headers['mcp-protocol-version'];
        if (protocolHeader !== undefined && (Array.isArray(protocolHeader) || !HTTP_PROTOCOLS.includes(protocolHeader))) throw new HttpFailure(400, 'Unsupported MCP protocol version');
        if (header) {
          const record = readConnection(header, grant, endpoint);
          const asked = request.headers['mcp-protocol-version'];
          if (asked !== undefined && asked !== record.protocol) throw new HttpFailure(400, 'Unsupported or mismatched MCP protocol version');
        }
        if (request.method === 'GET') {
          if (!header) throw new HttpFailure(400, 'MCP session header required');
          reply(response, 405, { error: 'SSE is not offered' }, { allow: 'POST, DELETE' }); return;
        }
        if (request.method === 'DELETE') {
          if (!header) throw new HttpFailure(400, 'MCP session header required');
          const record = readConnection(header, grant, endpoint);
          removeSession(record.id);
          reply(response, 204); return;
        }
        if (request.method !== 'POST') throw new HttpFailure(405, 'MCP requires POST');
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpFailure(415, 'MCP requires application/json');
        const accepts = (request.headers.accept ?? '').split(',').map(type => type.split(';')[0]?.trim().toLowerCase());
        if (!accepts.includes('application/json') || !accepts.includes('text/event-stream')) throw new HttpFailure(406, 'MCP client must accept JSON and event streams');
        const message = jsonRpc(await bodyOf(request));
        authorizeGrant(grant);
        requireNativeCall(grant, message);
        let record: ConnectionRecord;
        if (message.method === 'initialize') {
          if (header || message.id === undefined) throw new HttpFailure(400, 'Initialize requires an id and no session header');
          const protocol = typeof message.params?.protocolVersion === 'string' && HTTP_PROTOCOLS.includes(message.params.protocolVersion)
            ? message.params.protocolVersion : HTTP_PROTOCOLS[0]!;
          record = { id: randomUUID(), client: grant.id, endpoint, protocol, initialized: false };
          writePrivate(sessionFile(paths, record.id), record);
          message.params = { ...message.params, protocolVersion: protocol };
        } else {
          if (!header) throw new HttpFailure(400, 'MCP session header required');
          record = readConnection(header, grant, endpoint);
          const asked = request.headers['mcp-protocol-version'];
          if (asked !== undefined && asked !== record.protocol) throw new HttpFailure(400, 'Unsupported or mismatched MCP protocol version');
        }
        if (message.method === 'notifications/initialized') {
          if (message.id !== undefined) throw new HttpFailure(400, 'Initialized must be a notification');
          writePrivate(sessionFile(paths, record.id), { ...record, initialized: true });
          reply(response, 202); return;
        }
        if (!record.initialized && message.method !== 'initialize' && message.method !== 'ping') throw new HttpFailure(400, 'MCP session has not completed initialization');
        let result: object | null;
        try {
          if (message.method === undefined) result = null;
          else if (grant.nativeBinding && message.method !== 'tools/call') result = nativeDiscovery(host, endpoint).handle(message);
          else {
            const context = await contextFor(grant, () => authorizeGrant(grant));
            authorizeGrant(grant);
            if (closing) throw new HttpFailure(503, 'Shared service is stopping');
            contexts.set(grant.id, context);
            result = dispatch(paths, record, message, connectionFor(record, context));
          }
        }
        catch (error) { if (message.method === 'initialize') removeSession(record.id); throw error; }
        reply(response, result === null ? 202 : 200, result === null ? undefined : result,
          message.method === 'initialize' ? { 'mcp-session-id': record.id } : {});
      } catch (error) {
        const status = error instanceof HttpFailure ? error.status : 500;
        reply(response, status, { error: error instanceof Error ? error.message : 'Shared service request failed' });
      } finally { requests -= 1; }
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
      lifecycle.stop = () => {
        if (closing) return;
        closing = true;
        let remaining = 2;
        const done = (error?: Error) => { if (error) reject(error); remaining -= 1; if (!remaining) resolve(); };
        server.close(done); controlServer.close(done);
        server.closeIdleConnections(); controlServer.closeIdleConnections();
      };
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
  } finally {
    if (timer) clearInterval(timer);
    lifecycle.stop?.();
    for (const server of [http, ipc]) if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    release();
  }
}

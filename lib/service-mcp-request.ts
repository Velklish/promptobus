import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import type { ParticipantV1, PromptobusHost, SessionSnapshot } from '../dist/index.js';
import { admitsAddress, registryOf, sessionIdOf } from '../dist/index.js';
import { withSynchronousAuthority } from '../dist/fs/lock.js';
import type { JsonRpcMessage } from '../dist/mcp/server.js';
import { mcpTools } from '../dist/mcp/tools.js';
import { busConnection } from './server.js';
import { withTaskLock } from './store.js';
import { participantSession } from './status.js';
import { actorIdentityVariables, REGISTRY } from './drivers.js';
import { requireServiceHarnessContext } from './harness-home.js';
import type { ServiceWarden } from './service-warden.js';
import { REVIEW_FILE_TOOLS, reviewerFiles } from './reviewer-files.js';
import { PROMPTOBUS_SERVER, PROTOCOL_VERSIONS } from './contract.js';
import { readPrivate, recordOf, recordVersion, runtimeIdentity, sameRecordVersion, servicePaths, writePrivate } from './service-state.js';
import type { RecordVersion, ServicePaths } from './service-state.js';
import { standaloneClientRevoked, standaloneExpired } from './standalone-root-state.js';
import { ManagedNativeRevisionDrift } from './native-admission.js';
import {
  HttpFailure, CLIENT_ID, tokenEquals, clientFile, nativeThreadId, grantOf, managedParticipant, unavailableObservations,
  requireLifetime, privateReadGrants,
} from './service-grant.js';
import type { ServiceClientGrant, ServiceHostFactory } from './service.js';
import type { HarnessContext } from './harness-home.js';
import { dispatch, requireKnownRootOutcomes } from './service-request-receipts.js';

interface ConnectionRecord { id: string; client: string; endpoint: Endpoint; protocol: string; initialized: boolean }
type Endpoint = 'bus' | 'reviewer_files';
interface Connection { handle: (message: JsonRpcMessage) => object | null }
interface ClientContext { grant: ServiceClientGrant; host: PromptobusHost; env: Readonly<NodeJS.ProcessEnv> }
interface ManagedAuthorization { revision: RecordVersion; participant: ParticipantV1; record: Record<string, unknown> | null }
const HTTP_PROTOCOLS = PROTOCOL_VERSIONS.filter(version => version !== '2024-11-05');
function codexAuthorityRecord(record: Record<string, unknown>) {
  const authority = { ...record };
  delete authority.lastEvent; delete authority.lastEventAt; delete authority.rateLimits;
  return authority;
}
function refreshCodexTelemetry(proof: ManagedAuthorization) {
  if (!proof.record) return false;
  try {
    const revision = recordVersion(proof.revision.file), record = readPrivate(revision.file);
    if (!recordOf(record) || !sameRecordVersion(revision) || isDeepStrictEqual(record, proof.record)
      || !isDeepStrictEqual(codexAuthorityRecord(record), codexAuthorityRecord(proof.record))) return false;
    proof.revision = revision; proof.record = record;
    return true;
  } catch { return false; }
}
const sessionFile = (paths: ServicePaths, id: string) => path.join(paths.sessions, `${id}.json`);

function clientEnvironment(grant: ServiceClientGrant): Readonly<NodeJS.ProcessEnv> {
  const env = { ...grant.env };
  if (grant.nativeBinding) {
    if (grant.nativeBinding.state !== 'bound') throw new HttpFailure(403, 'Native binding is pending owner realization');
    for (const name of [...actorIdentityVariables(), 'OPENCODE_SESSION_ID']) delete env[name];
    const driver = REGISTRY.drivers[grant.nativeBinding.kind]!;
    const recordVar = driver.options.mcpIdentity?.recordVar ?? (driver.id === 'claude' ? 'PROMPTOBUS_CLAUDE_SESSION' : null);
    if (grant.lifetime.kind === 'managed' && recordVar) env[recordVar] = grant.lifetime.record;
    if (driver.options.identityVar) env[driver.options.identityVar] = grant.nativeBinding.kind === 'codex'
      ? grant.nativeBinding.threadId : grant.nativeBinding.sessionId;
  }
  return Object.freeze(env);
}

function requireNativeCall(grant: ServiceClientGrant, message: JsonRpcMessage) {
  if (!grant.nativeBinding || message.method !== 'tools/call') return;
  if (grant.nativeBinding.state !== 'bound') throw new HttpFailure(403, 'Native binding is pending owner realization');
  if (grant.nativeBinding.kind !== 'codex') return;
  const meta = message.params?._meta;
  if (!recordOf(meta) || !nativeThreadId(meta.threadId) || meta.threadId !== grant.nativeBinding.threadId) {
    throw new HttpFailure(403, 'Codex tool call requires the bound native thread id in params._meta.threadId');
  }
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

interface RequestOwner {
  host: PromptobusHost; env: NodeJS.ProcessEnv; paths: ServicePaths; runtime: string;
  createHost: ServiceHostFactory; expectedHarness: HarnessContext; warden: Pick<ServiceWarden, 'observe'>;
  requireProcessLifetime(grant: ServiceClientGrant, status: number): Promise<void>;
  proveNativeBinding(grant: ServiceClientGrant): Promise<void>;
  finalizeStandaloneStartup(grant: ServiceClientGrant): Promise<void>;
  isClosing(): boolean;
}
interface McpRequest { endpoint: Endpoint; method?: string; headers: IncomingHttpHeaders; readBody(): Promise<unknown> }
interface McpReply { status: number; headers?: Record<string, string>; body?: unknown }

export function createMcpRequests({ paths, host, runtime, env, createHost, expectedHarness, warden,
  requireProcessLifetime, proveNativeBinding, finalizeStandaloneStartup, isClosing }: RequestOwner) {
  const contexts = new Map<string, ClientContext>();
  const connections = new Map<string, { context: ClientContext; connection: Connection }>();
  const rootMutations = new Map<string, number>();
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
  const forgetClient = (id: string) => {
    contexts.delete(id);
    for (const file of readdirSync(paths.sessions)) {
      const record = connectionOf(readPrivate(path.join(paths.sessions, file)));
      if (record?.client === id) removeSession(record.id);
    }
  };
  const contextFor = async (grant: ServiceClientGrant, revalidate: () => Promise<unknown>): Promise<ClientContext> => {
    const cached = contexts.get(grant.id);
    if (cached && isDeepStrictEqual(cached.grant, grant)) return cached;
    const clientEnv = clientEnvironment(grant);
    const clientHost = await createHost({ cwd: grant.cwd, env: clientEnv });
    await revalidate();
    const clientPaths = servicePaths(clientHost, env);
    if (clientPaths.root !== paths.root || clientPaths.home !== paths.home) throw new Error('Client Host belongs to a different canonical workspace/store');
    if (runtimeIdentity(clientHost) !== runtime) throw new Error('Client Host belongs to a different shared-service runtime');
    requireServiceHarnessContext(expectedHarness, clientHost, clientEnv, REGISTRY, grant.pollEnv);
    if (!admitsAddress(registryOf(clientHost), clientEnv.PROMPTOBUS_ROLE || 'orchestrator')) throw new Error('Unknown client bus address');
    if (grant.files) privateReadGrants(paths, grant.files);
    const context = { grant, env: clientEnv, host: clientHost };
    return context;
  };
  class ClientBindingChanged extends HttpFailure {
    constructor() { super(401, 'Client binding is absent or expired'); }
  }
  const currentGrant = (grant: ServiceClientGrant) => {
    const value = readPrivate(clientFile(paths, grant.id));
    const current = value === null ? null : grantOf(value);
    if (!current || !tokenEquals(current.token, grant.token) || current.runtime !== runtime || !isDeepStrictEqual(current, grant)
      || (current.rootLaunch && standaloneClientRevoked(paths, current.id))) {
      throw new ClientBindingChanged();
    }
    return current;
  };
  const authorizeCurrent = (grant: ServiceClientGrant, proof: ManagedAuthorization | null = null, returned = false) => {
    const current = currentGrant(grant);
    if (standaloneExpired(current, paths)) throw new HttpFailure(401, 'Standalone root admission expired or was revoked');
    if (current.lifetime.kind !== 'managed') {
      requireLifetime(current, paths.home, unavailableObservations, 401); return;
    }
    const participant = managedParticipant(current.lifetime, paths.home);
    if (!proof || !participant || !isDeepStrictEqual(managedIdentity(participant), managedIdentity(proof.participant))) {
      throw new ManagedIdentityDrift('within-attempt participant identity');
    }
    if (!sameRecordVersion(proof.revision) && !(returned && participant.harness === 'codex'
      && current.nativeBinding?.kind === 'codex' && refreshCodexTelemetry(proof))) throw new ManagedRevisionDrift('within attempt');
  };
  const MANAGED_DRIFT = 'Managed lifetime changed after observation; retry with current owner proof';
  class ManagedRevisionDrift extends HttpFailure {
    constructor(stage: string) { super(409, `${MANAGED_DRIFT} [stage: ${stage}]`); }
  }
  class ManagedIdentityDrift extends HttpFailure {
    constructor(stage: string) { super(409, `${MANAGED_DRIFT} [stage: ${stage}]`); }
  }
  const MANAGED_PROOF_ATTEMPTS = 3;
  const managedIdentity = (participant: ParticipantV1) => [participant.harness, sessionIdOf(participant), participant.metadata?.nativeLaunchId];
  // Only same-identity record drift gets a fresh full proof; any other refusal ends authorization.
  const authorizeGrant = async (grant: ServiceClientGrant, label: string) => {
    const pin: { identity: unknown[] | null } = { identity: null };
    for (let attempt = 1; ; attempt += 1) {
      try { return await authorizeAttempt(grant, pin, label); }
      catch (error) {
        if (!(error instanceof ManagedRevisionDrift)) throw error;
        if (attempt >= MANAGED_PROOF_ATTEMPTS) throw new ManagedRevisionDrift(`exhausted ${MANAGED_PROOF_ATTEMPTS}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  };
  const authorizeAttempt = async (grant: ServiceClientGrant, pin: { identity: unknown[] | null }, label: string) => {
    const current = currentGrant(grant);
    await requireProcessLifetime(current, 401);
    let proof: ManagedAuthorization | null = null;
    if (current.lifetime.kind === 'managed') {
      let revision: RecordVersion, participant: ParticipantV1 | null;
      try {
        revision = recordVersion(current.lifetime.record);
        participant = managedParticipant(current.lifetime, paths.home);
      } catch { throw new HttpFailure(401, 'Managed lifetime has no matching task, participant and launch record'); }
      if (!participant) throw new HttpFailure(401, 'Managed lifetime has no matching task, participant and launch record');
      if (pin.identity && !isDeepStrictEqual(pin.identity, managedIdentity(participant))) {
        throw new HttpFailure(409, 'Managed participant identity changed during authorization');
      }
      pin.identity ??= managedIdentity(participant);
      let record: Record<string, unknown> | null = null;
      if (participant.harness === 'codex' && current.nativeBinding?.kind === 'codex') {
        const value = readPrivate(revision.file);
        if (!recordOf(value)) throw new HttpFailure(401, 'Managed lifetime has no matching task, participant and launch record');
        record = value;
      }
      proof = { revision, participant, record };
    }
    try { await proveNativeBinding(current); }
    catch (error) {
      if (error instanceof ManagedNativeRevisionDrift) throw new ManagedRevisionDrift('native proof');
      throw error;
    }
    authorizeCurrent(grant, proof);
    if (proof) {
      let snapshot: SessionSnapshot = null;
      try { snapshot = await warden.observe([proof.participant], [proof.revision]); } catch { /* no observation is no authority */ }
      authorizeCurrent(grant, proof);
      const state = participantSession(proof.participant, snapshot);
      if (state === 'dead') throw new HttpFailure(401, 'Client lifetime is already expired or replaced');
      if (state !== 'alive') throw new HttpFailure(503, 'Managed lifetime observation is unavailable; retry after owner diagnostics');
    }
    authorizeCurrent(grant, proof);
    return () => {
      try { authorizeCurrent(grant, proof, true); }
      catch (error) {
        if (error instanceof ManagedRevisionDrift) throw new ManagedRevisionDrift(`returned fence: ${label}`);
        if (error instanceof ManagedIdentityDrift) throw new ManagedIdentityDrift(`returned fence: ${label}: participant identity`);
        throw error;
      }
    };
  };
  const clientGrant = (authorization: string | undefined) => {
    if (!authorization?.startsWith('Bearer ')) throw new HttpFailure(401, 'Client authentication required');
    const bearer = authorization.slice(7);
    const grant = grants().find(candidate => tokenEquals(candidate.token, bearer));
    if (!grant || grant.runtime !== runtime) throw new HttpFailure(401, 'Client binding is absent or expired');
    return grant;
  };
  const authorizeCatalog = async (grant: ServiceClientGrant, authorization: string | undefined) => {
    try {
      (await authorizeGrant(grant, 'body'))();
      return grant;
    } catch (error) {
      if (!(error instanceof ClientBindingChanged)) throw error;
      const next = clientGrant(authorization);
      if (next.nativeBinding?.state !== 'bound' || next.nativeBinding.kind !== grant.nativeBinding?.kind
        || !isDeepStrictEqual(next, { ...grant, nativeBinding: next.nativeBinding })) throw error;
      // A realized client has the same static catalog. Recheck its full current lifetime and proof.
      (await authorizeGrant(next, 'catalog realization'))();
      return next;
    }
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

  async function handle(request: McpRequest): Promise<McpReply> {
    const { endpoint } = request;
    let mutationNonce: string | null = null;
    try {
      const authorization = request.headers.authorization;
      let grant = clientGrant(authorization);
      const pendingNativePost = request.method === 'POST' && grant.nativeBinding?.state === 'pending' && !grant.rootLaunch && !grant.bbRootNonce;
      if (!pendingNativePost) (await authorizeGrant(grant, 'authenticate'))();
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
        return { status: 405, body: { error: 'SSE is not offered' }, headers: { allow: 'POST, DELETE' } };
      }
      if (request.method === 'DELETE') {
        if (!header) throw new HttpFailure(400, 'MCP session header required');
        const record = readConnection(header, grant, endpoint);
        removeSession(record.id);
        return { status: 204 };
      }
      if (request.method !== 'POST') throw new HttpFailure(405, 'MCP requires POST');
      if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpFailure(415, 'MCP requires application/json');
      const accepts = (request.headers.accept ?? '').split(',').map(type => type.split(';')[0]?.trim().toLowerCase());
      if (!accepts.includes('application/json') || !accepts.includes('text/event-stream')) throw new HttpFailure(406, 'MCP client must accept JSON and event streams');
      const message = jsonRpc(await request.readBody());
      if (message.method === 'tools/call' && grant.rootLaunch && grant.nativeBinding?.state === 'pending') {
        await finalizeStandaloneStartup(grant);
        grant = clientGrant(authorization);
        (await authorizeGrant(grant, 'finalize'))();
      }
      if ((grant.rootLaunch || grant.bbRootNonce) && message.method === 'tools/call') {
        mutationNonce = grant.rootLaunch?.nonce ?? grant.bbRootNonce!;
        rootMutations.set(mutationNonce, (rootMutations.get(mutationNonce) ?? 0) + 1);
      }
      if (pendingNativePost && message.method === 'tools/list') grant = await authorizeCatalog(grant, authorization);
      else (await authorizeGrant(grant, 'body'))();
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
        return { status: 202 };
      }
      if (!record.initialized && message.method !== 'initialize' && message.method !== 'ping') throw new HttpFailure(400, 'MCP session has not completed initialization');
      let result: object | null;
      try {
        if (message.method === undefined) result = null;
        else if (grant.nativeBinding && message.method !== 'tools/call') result = nativeDiscovery(host, endpoint).handle(message);
        else {
          const context = await contextFor(grant, () => authorizeGrant(grant, 'factory'));
          const authorizeDispatch = await authorizeGrant(grant, 'dispatch');
          authorizeDispatch();
          if (isClosing()) throw new HttpFailure(503, 'Shared service is stopping');
          contexts.set(grant.id, context);
          const receiptNonce = grant.rootLaunch?.nonce ?? grant.bbRootNonce;
          if (receiptNonce) requireKnownRootOutcomes(paths, receiptNonce);
          const invoke = () => dispatch(paths, record, message, connectionFor(record, context), receiptNonce);
          if (grant.lifetime.kind !== 'managed') result = invoke();
          else {
            const task = grant.lifetime.task;
            let entered = false;
            try {
              result = withSynchronousAuthority(authorizeDispatch, () => withTaskLock(paths.home, task, () => {
                entered = true;
                return invoke();
              }, { waitMs: 0 }));
            } catch (error) {
              if (!entered && !(error instanceof HttpFailure)) throw new HttpFailure(503,
                `Managed operation did not enter its journal: ${error instanceof Error ? error.message : String(error)}`);
              throw error;
            }
          }
        }
      }
      catch (error) { if (message.method === 'initialize') removeSession(record.id); throw error; }
      return { status: result === null ? 202 : 200, body: result ?? undefined,
        headers: message.method === 'initialize' ? { 'mcp-session-id': record.id } : {} };
    } catch (error) {
      const status = error instanceof HttpFailure ? error.status : 500;
      return { status, body: { error: error instanceof Error ? error.message : 'Shared service request failed' } };
    } finally {
      if (mutationNonce) {
        const count = (rootMutations.get(mutationNonce) ?? 1) - 1;
        if (count) rootMutations.set(mutationNonce, count); else rootMutations.delete(mutationNonce);
      }
    }
  }
  return { handle, grants, currentGrant, contextFor, forgetClient,
    rememberContext: (context: ClientContext) => contexts.set(context.grant.id, context),
    mutationPending: (nonce: string) => rootMutations.has(nonce) };
}

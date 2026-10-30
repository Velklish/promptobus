import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import type { PromptobusHost } from '../dist/index.js';
import type { ServiceClientCredential, ServiceClientInput, ServiceClientLifetime, ServiceStatus } from './service.js';
import { acquireServiceLock, prepareServicePaths, processRecord, readDiscovery, readPrivate, recordOf, runtimeIdentity, sameProcess, servicePaths } from './service-state.js';
import type { ServiceDiscovery, ServicePaths } from './service-state.js';

export interface ServiceCallOptions { cwd?: string; env?: NodeJS.ProcessEnv }
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function serviceControl(paths: ServicePaths, input: object): Promise<unknown> {
  const owner = readPrivate(paths.owner);
  if (!recordOf(owner) || typeof owner.token !== 'string' || !/^[a-f0-9]{64}$/.test(owner.token)) throw new Error('Shared service owner credential is invalid');
  const body = JSON.stringify(input);
  return new Promise<unknown>((resolve, reject) => {
    const call = request({ socketPath: paths.controlSocket, path: '/control', method: 'POST',
      headers: { host: 'promptobus.local', authorization: `Bearer ${owner.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += String(chunk);
        if (Buffer.byteLength(text) > 1024 * 1024) call.destroy(new Error('Shared service control response exceeds its limit'));
      });
      response.on('error', reject);
      response.on('end', () => {
        let value: unknown;
        try { value = JSON.parse(text) as unknown; } catch { reject(new Error('Shared service returned invalid control JSON')); return; }
        if (response.statusCode !== 200) { reject(new Error(recordOf(value) && typeof value.error === 'string' ? value.error : `Shared service control refused: HTTP ${response.statusCode}`)); return; }
        resolve(value);
      });
    });
    call.setTimeout(5000, () => call.destroy(new Error('Shared service control request timed out')));
    call.on('error', reject);
    call.end(body);
  });
}

function statusOf(value: unknown, expected: ServiceDiscovery): ServiceStatus {
  if (!recordOf(value) || value.runtime !== expected.runtime || value.root !== expected.root || value.home !== expected.home || value.url !== expected.url
    || !recordOf(value.process) || value.process.pid !== expected.process.pid || value.process.birth !== expected.process.birth
    || typeof value.clients !== 'number' || typeof value.reservations !== 'number' || typeof value.unknownClients !== 'number'
    || typeof value.unknownManaged !== 'number' || typeof value.sessions !== 'number') throw new Error('Shared service control identity did not match discovery');
  return { ...expected, clients: value.clients, reservations: value.reservations, unknownClients: value.unknownClients,
    unknownManaged: value.unknownManaged, sessions: value.sessions };
}

function compatible(discovery: ServiceDiscovery, runtime: string) {
  if (discovery.runtime !== runtime) throw new Error('A different shared service runtime owns this workspace; close clients and restart it through the matching launcher');
}

export async function workspaceServiceStatus(host: PromptobusHost, { env = process.env }: ServiceCallOptions = {}) {
  const paths = servicePaths(host, env), discovery = readDiscovery(paths);
  if (!discovery || !sameProcess(discovery.process)) return { running: false as const, discovery };
  compatible(discovery, runtimeIdentity(host));
  return { running: true as const, ...statusOf(await serviceControl(paths, { operation: 'status' }), discovery) };
}

export async function ensureWorkspaceService(host: PromptobusHost, { cwd = host.workspaceRoot(), env = process.env }: ServiceCallOptions = {}): Promise<ServiceDiscovery> {
  const paths = servicePaths(host, env), runtime = runtimeIdentity(host);
  prepareServicePaths(paths);
  const ready = async () => {
    const discovery = readDiscovery(paths);
    if (!discovery || !sameProcess(discovery.process)) return null;
    compatible(discovery, runtime);
    try { statusOf(await serviceControl(paths, { operation: 'status' }), discovery); return discovery; }
    catch (error) {
      if (!sameProcess(discovery.process)) return null;
      throw error;
    }
  };
  const existing = await ready();
  if (existing) return existing;
  const deadline = Date.now() + 20_000;
  for (;;) {
    const release = await acquireServiceLock(paths.startup);
    if (!release) {
      const discovery = await ready();
      if (discovery) return discovery;
      if (Date.now() >= deadline) throw new Error('Shared service startup is still owned by another launcher; inspect service status');
      await wait(50);
      continue;
    }
    try {
      const discovery = await ready();
      if (discovery) return discovery;
      const logFile = path.join(paths.directory, 'startup-error.log');
      const fd = openSync(logFile, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      let error: Error | null = null;
      const child = spawn(host.nodePath(), host.busArgv(['service', 'run']), { cwd, env: { ...env, PROMPTOBUS_HOME: paths.home }, detached: true, stdio: ['ignore', 'ignore', fd] });
      closeSync(fd);
      child.once('error', failure => { error = failure; });
      child.unref();
      for (;;) {
        const current = await ready();
        if (current) return current;
        if (error) throw error;
        if (child.exitCode !== null || child.signalCode !== null) {
          const owner = processRecord(readPrivate(path.join(paths.lock, 'owner.json')));
          if (child.exitCode === 0 && owner && sameProcess(owner) && Date.now() < deadline) { await wait(50); continue; }
          const detail = readFileSync(logFile, 'utf8').slice(-2000).trim();
          throw new Error(`Shared service exited before readiness (${child.exitCode ?? child.signalCode}); the consumer entry must route service run with createHost({cwd, env}): ${detail}`);
        }
        if (Date.now() >= deadline) throw new Error('Shared service did not become ready; inspect its private startup-error.log and retained endpoint');
        await wait(50);
      }
    } finally { release(); }
  }
}

export async function registerServiceClient(host: PromptobusHost, client: ServiceClientInput, options: ServiceCallOptions = {}): Promise<ServiceClientCredential> {
  await ensureWorkspaceService(host, options);
  const value = await serviceControl(servicePaths(host, options.env), { operation: 'register', runtime: runtimeIdentity(host), client });
  if (!recordOf(value) || typeof value.clientId !== 'string' || typeof value.token !== 'string' || typeof value.credentialFile !== 'string'
    || typeof value.busUrl !== 'string' || (value.filesUrl !== null && typeof value.filesUrl !== 'string')) throw new Error('Shared service returned an invalid client credential');
  return { clientId: value.clientId, token: value.token, credentialFile: value.credentialFile, busUrl: value.busUrl, filesUrl: value.filesUrl };
}

export async function bindServiceClient(host: PromptobusHost, clientId: string, lifetime: ServiceClientLifetime, options: ServiceCallOptions = {}) {
  return serviceControl(servicePaths(host, options.env), { operation: 'bind', runtime: runtimeIdentity(host), clientId, lifetime });
}

export async function revokeServiceClient(host: PromptobusHost, clientId: string, options: ServiceCallOptions = {}) {
  return serviceControl(servicePaths(host, options.env), { operation: 'revoke', runtime: runtimeIdentity(host), clientId });
}

export async function stopWorkspaceService(host: PromptobusHost, { env = process.env }: ServiceCallOptions = {}) {
  const status = await workspaceServiceStatus(host, { env });
  if (!status.running) return { stopped: false };
  await serviceControl(servicePaths(host, env), { operation: 'stop', runtime: runtimeIdentity(host) });
  const deadline = Date.now() + 5000;
  while (sameProcess(status.process)) {
    if (Date.now() >= deadline) throw new Error('Shared service shutdown was requested, but physical exit is not confirmed; inspect service status');
    await wait(25);
  }
  return { stopped: true };
}

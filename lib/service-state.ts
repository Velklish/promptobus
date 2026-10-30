import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptobusHost } from '../dist/index.js';
import { withDirLock } from '../dist/fs/lock.js';
import { canonicalPath, writeJsonAtomic } from './store.js';

export interface ProcessIdentity { pid: number; birth: string }
export interface ServicePaths {
  base: string; directory: string; discovery: string; owner: string; lock: string; startup: string;
  clients: string; sessions: string; requests: string; controlSocket: string; root: string; home: string;
}
export interface ServiceDiscovery {
  schemaVersion: 1; root: string; home: string; runtime: string; version: string;
  url: string; process: ProcessIdentity;
}
interface LockOwner extends ProcessIdentity { nonce: string }

export const recordOf = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const contained = (root: string, file: string) => file === root
  || (!path.relative(root, file).startsWith(`..${path.sep}`) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));

export function processIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const source = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = source.slice(source.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || !fields[19]) return null;
      return { pid, birth: `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}` };
    }
    if (process.platform === 'darwin') {
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 });
      const match = result.status === 0 && /^\s*(\S+)\s+(.+?)\s*$/.exec(result.stdout);
      if (!match || match[1]!.startsWith('Z')) return null;
      return { pid, birth: match[2]! };
    }
  } catch { return null; }
  return null;
}

export function sameProcess(identity: ProcessIdentity) {
  return processState(identity) !== 'dead';
}

export function processState(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  const current = processIdentity(identity.pid);
  if (current) return current.birth === identity.birth ? 'alive' : 'dead';
  try { process.kill(identity.pid, 0); } catch (error) {
    if (recordOf(error) && error.code === 'ESRCH') return 'dead';
  }
  return 'unknown';
}

export function requireProcess(pid = process.pid) {
  const identity = processIdentity(pid);
  if (!identity) throw new Error('Shared service requires an observable process birth identity on this platform');
  return identity;
}

export function servicePaths(host: PromptobusHost, env: NodeJS.ProcessEnv = process.env): ServicePaths {
  const root = canonicalPath(host.workspaceRoot()), home = canonicalPath(host.promptobusHome());
  const base = canonicalPath(env.PROMPTOBUS_SERVICE_HOME || path.join(homedir(), '.promptobus', 'services'));
  const key = createHash('sha256').update(JSON.stringify([root, home])).digest('hex');
  const directory = path.join(base, key);
  return { base, directory, root, home, discovery: path.join(directory, 'service.json'), owner: path.join(directory, 'owner.json'),
    lock: path.join(directory, 'owner.lock'), startup: path.join(directory, 'startup.lock'),
    clients: path.join(directory, 'clients'), sessions: path.join(directory, 'sessions'), requests: path.join(directory, 'requests'),
    controlSocket: path.join(base, `${key.slice(0, 24)}.sock`) };
}

export async function prepareControlSocket(paths: ServicePaths) {
  if (Buffer.byteLength(paths.controlSocket) > 100) throw new Error('Shared service private socket path is too long; choose a shorter PROMPTOBUS_SERVICE_HOME');
  if (!existsSync(paths.controlSocket)) return;
  const entry = lstatSync(paths.controlSocket);
  if (!entry.isSocket() || (process.getuid && entry.uid !== process.getuid())) throw new Error('Shared service control socket is unsafe');
  const listening = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(paths.controlSocket);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if ('code' in error && (error.code === 'ECONNREFUSED' || error.code === 'ENOENT')) resolve(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Shared service control socket is occupied or unresponsive')); });
  });
  if (listening) throw new Error('Shared service control socket is occupied by another listener');
  if (!existsSync(paths.controlSocket)) return;
  const latest = lstatSync(paths.controlSocket);
  if (latest.dev !== entry.dev || latest.ino !== entry.ino) throw new Error('Shared service control socket changed during recovery');
  rmSync(paths.controlSocket);
}

export function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entry = lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory
    || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o077) !== 0) {
    throw new Error(`Shared service requires an owned private directory without symbolic links: ${directory}`);
  }
}

export function prepareServicePaths(paths: ServicePaths) {
  for (const directory of [paths.base, paths.directory, paths.clients, paths.sessions, paths.requests]) privateDirectory(directory);
}

export function readPrivate(file: string): unknown {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if (recordOf(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || (entry.mode & 0o077) !== 0 || (process.getuid && entry.uid !== process.getuid())) {
      throw new Error(`Shared service requires an owned private regular file: ${file}`);
    }
    try { return JSON.parse(readFileSync(fd, 'utf8')) as unknown; }
    catch { throw new Error(`Shared service private record is invalid: ${file}`); }
  } finally { closeSync(fd); }
}

export function writePrivate(file: string, value: unknown) {
  const parent = path.dirname(file);
  const entry = lstatSync(parent);
  if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(parent) !== parent || (entry.mode & 0o077) !== 0) {
    throw new Error('Shared service private directory changed');
  }
  writeJsonAtomic(file, value, { mode: 0o600 });
}

export function processRecord(value: unknown): ProcessIdentity | null {
  return recordOf(value) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && typeof value.birth === 'string' && value.birth.length > 0
    ? { pid: Number(value.pid), birth: value.birth } : null;
}

export function discoveryOf(value: unknown): ServiceDiscovery | null {
  if (!recordOf(value) || value.schemaVersion !== 1 || typeof value.root !== 'string' || typeof value.home !== 'string'
    || typeof value.runtime !== 'string' || typeof value.version !== 'string' || typeof value.url !== 'string') return null;
  const own = processRecord(value.process);
  const url = new URL(value.url);
  if (!own || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
    || url.username || url.password || url.search || url.hash) return null;
  return { schemaVersion: 1, root: value.root, home: value.home, runtime: value.runtime, version: value.version, url: value.url, process: own };
}

export function readDiscovery(paths: ServicePaths) {
  const value = readPrivate(paths.discovery);
  if (value === null) return null;
  const discovery = discoveryOf(value);
  if (!discovery || discovery.root !== paths.root || discovery.home !== paths.home) throw new Error('Shared service discovery identity is invalid');
  return discovery;
}

export function runtimeIdentity(host: PromptobusHost) {
  const hash = createHash('sha256');
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const add = (file: string) => { hash.update(file); hash.update(readFileSync(file)); };
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name), entry = lstatSync(file);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.(?:js|json)$/.test(name)) add(file);
    }
  };
  hash.update(JSON.stringify([host.version, process.version, canonicalPath(host.nodePath()), host.busArgv(['service', 'run'])]));
  add(path.join(packageRoot, 'package.json'));
  for (const directory of ['lib', 'dist', 'bin', 'models', 'schemas']) walk(path.join(packageRoot, directory));
  const entry = host.binPath();
  if (existsSync(entry) && statSync(entry).isFile() && !contained(packageRoot, entry)) add(entry);
  return hash.digest('hex');
}

const serviceLockOptions = {
  onMissing: () => new Error('Shared service lock parent vanished'),
  onBusy: () => new Error('Shared service startup is busy; retry after its owner finishes'),
};

export async function acquireServiceLock(directory: string): Promise<(() => void) | null> {
  return withDirLock(`${directory}.gate`, () => acquireOwnedLock(directory), serviceLockOptions);
}

function acquireOwnedLock(directory: string): (() => void) | null {
  const own: LockOwner = { ...requireProcess(), nonce: randomUUID() };
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if (!recordOf(error) || error.code !== 'EEXIST') throw error;
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Shared service lock is unsafe');
    const previous = readPrivate(path.join(directory, 'owner.json'));
    const process = processRecord(previous);
    if (!process) throw new Error('Shared service lock has no valid owner; inspect it before retrying');
    if (sameProcess(process)) return null;
    rmSync(directory, { recursive: true });
    return acquireOwnedLock(directory);
  }
  writePrivate(path.join(directory, 'owner.json'), own);
  return () => withDirLock(`${directory}.gate`, () => {
    const latest = readPrivate(path.join(directory, 'owner.json'));
    if (recordOf(latest) && latest.nonce === own.nonce) rmSync(directory, { recursive: true });
  }, serviceLockOptions);
}

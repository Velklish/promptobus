import { createHash, randomUUID } from 'node:crypto';
import { readFile, readlink } from 'node:fs/promises';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PromptobusHost } from '../dist/index.js';
import { withDirLock } from '../dist/fs/lock.js';
import { canonicalPath, writeJsonAtomic } from './store.js';
import { run, runAsync } from './exec.js';

export interface ProcessIdentity { pid: number; birth: string }
export interface RecordVersion { file: string; version: string }

export function recordVersion(file: string): RecordVersion {
  const value = statSync(file, { bigint: true });
  return { file, version: [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':') };
}

export function sameRecordVersion(expected: RecordVersion) {
  try { return recordVersion(expected.file).version === expected.version; } catch { return false; }
}
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

interface ProcessObservation { scope: string; identity: ProcessIdentity | null; zombie: boolean }
const LINUX_BOOT = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const DARWIN_SCOPE = 'v2:darwin:utc-c';
const darwinObservationEnv = () => ({ ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' });

function darwinStart(source: string): string | null {
  const value = source.trim().replace(/\s+/g, ' ');
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) ([1-9]\d{3})$/.exec(value);
  if (!match) return null;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[2]!);
  const date = new Date(Date.UTC(Number(match[7]), month, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])));
  return date.getUTCMonth() === month && date.getUTCDate() === Number(match[3])
    && ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()] === match[1] ? value : null;
}

function birthScope(birth: string): string | null {
  const linux = new RegExp(`^(v2:linux:${LINUX_BOOT}:[1-9]\\d*):(0|[1-9]\\d*)$`).exec(birth);
  if (linux) return linux[1]!;
  if (birth.startsWith(`${DARWIN_SCOPE}:`) && darwinStart(birth.slice(DARWIN_SCOPE.length + 1)) === birth.slice(DARWIN_SCOPE.length + 1)) return DARWIN_SCOPE;
  return null;
}

function linuxStat(pid: number, source: string) {
  if (!source.startsWith(`${pid} (`) || source.lastIndexOf(')') < source.indexOf('(')) return null;
  const fields = source.slice(source.lastIndexOf(')') + 2).trim().split(/\s+/);
  return /^[RSDZTtWXxKPI]$/.test(fields[0] ?? '') && /^(0|[1-9]\d*)$/.test(fields[19] ?? '')
    ? { state: fields[0]!, ticks: fields[19]! } : null;
}

function linuxView(boot: string, namespace: string, ownStat: string, ownStatus: string) {
  const id = /^pid:\[([1-9]\d*)\]$/.exec(namespace), bootId = boot.trim();
  const statusPid = /^Pid:[ \t]+(\d+)[ \t]*$/m.exec(ownStatus);
  const namespacePids = /^NSpid:[ \t]+(\d+(?:[ \t]+\d+)*)[ \t]*$/m.exec(ownStatus)?.[1]?.trim().split(/[ \t]+/);
  if (!new RegExp(`^${LINUX_BOOT}$`).test(bootId) || !id || !linuxStat(process.pid, ownStat)
    || Number(statusPid?.[1]) !== process.pid || namespacePids?.length !== 1 || Number(namespacePids[0]) !== process.pid) return null;
  return `v2:linux:${bootId}:${id[1]}`;
}

function darwinObservation(pid: number, status: number | null, stdout: string, stderr: string): ProcessObservation {
  const match = status === 0 && !stderr.trim() && /^\s*(\S+)\s+(.+?)\s*$/.exec(stdout);
  const start = match ? darwinStart(match[2]!) : null;
  return { scope: DARWIN_SCOPE, identity: match && /^[DIRSTUXZ][+<>LNlsEJVTWX-]*$/.test(match[1]!) && start
    ? { pid, birth: `${DARWIN_SCOPE}:${start}` } : null, zombie: Boolean(match && start && match[1]!.startsWith('Z')) };
}

function observeProcess(pid: number): ProcessObservation | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const scope = linuxView(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'), readlinkSync('/proc/self/ns/pid'),
        readFileSync('/proc/self/stat', 'utf8'), readFileSync('/proc/self/status', 'utf8'));
      if (!scope) return null;
      let stat: ReturnType<typeof linuxStat> = null;
      try { stat = linuxStat(pid, readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch {}
      return { scope, identity: stat ? { pid, birth: `${scope}:${stat.ticks}` } : null, zombie: stat?.state === 'Z' };
    }
    if (process.platform === 'darwin') {
      const result = run('/bin/ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: darwinObservationEnv() });
      return darwinObservation(pid, result.status, result.stdout ?? '', result.stderr ?? '');
    }
  } catch {}
  return null;
}

async function observeProcessAsync(pid: number): Promise<ProcessObservation | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const [boot, namespace, ownStat, ownStatus] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink('/proc/self/ns/pid'),
        readFile('/proc/self/stat', 'utf8'), readFile('/proc/self/status', 'utf8'),
      ]);
      const scope = linuxView(boot, namespace, ownStat, ownStatus);
      if (!scope) return null;
      let stat: ReturnType<typeof linuxStat> = null;
      try { stat = linuxStat(pid, await readFile(`/proc/${pid}/stat`, 'utf8')); } catch {}
      return { scope, identity: stat ? { pid, birth: `${scope}:${stat.ticks}` } : null, zombie: stat?.state === 'Z' };
    }
    if (process.platform === 'darwin') {
      const result = await runAsync('/bin/ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='],
        { encoding: 'utf8', timeoutMs: 2000, env: darwinObservationEnv() });
      return darwinObservation(pid, result.status, result.stdout, result.stderr);
    }
  } catch {}
  return null;
}

export function processIdentity(pid: number): ProcessIdentity | null {
  const observed = observeProcess(pid);
  return observed && !observed.zombie ? observed.identity : null;
}

export async function processIdentityAsync(pid: number): Promise<ProcessIdentity | null> {
  const observed = await observeProcessAsync(pid);
  return observed && !observed.zombie ? observed.identity : null;
}

export function sameProcess(identity: ProcessIdentity) {
  return processState(identity) !== 'dead';
}

export function processState(identity: ProcessIdentity): 'alive' | 'dead' | 'unknown' {
  return compareProcess(identity, observeProcess(identity.pid));
}

function compareProcess(identity: ProcessIdentity, observed: ProcessObservation | null): 'alive' | 'dead' | 'unknown' {
  const scope = birthScope(identity.birth);
  if (!scope || !observed || observed.scope !== scope || !Number.isSafeInteger(identity.pid) || identity.pid <= 0) return 'unknown';
  if (observed.identity) return observed.zombie || observed.identity.birth !== identity.birth ? 'dead' : 'alive';
  try { process.kill(identity.pid, 0); } catch (error) {
    if (recordOf(error) && error.code === 'ESRCH') return 'dead';
  }
  return 'unknown';
}

const processObservations = new Map<string, Promise<'alive' | 'dead' | 'unknown'>>();
export function processStateAsync(identity: ProcessIdentity): Promise<'alive' | 'dead' | 'unknown'> {
  const key = JSON.stringify(identity), existing = processObservations.get(key);
  if (existing) return existing;
  const pending = observeProcessAsync(identity.pid).then(observed => compareProcess(identity, observed))
    .finally(() => { processObservations.delete(key); });
  processObservations.set(key, pending);
  return pending;
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

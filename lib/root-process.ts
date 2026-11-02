import { lstat, readFile, readlink, readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { runAsync } from './exec.js';
import { processIdentityAsync, processStateAsync } from './service-state.js';
import type { ProcessIdentity } from './service-state.js';

const DARWIN_IMAGE = `ObjC.import('Foundation');
ObjC.bindFunction('dlopen', ['void *', ['char *', 'int']]);
ObjC.bindFunction('malloc', ['void *', ['unsigned long']]);
ObjC.bindFunction('free', ['void', ['void *']]);
function run(args) {
  if (!$.dlopen('/usr/lib/libproc.dylib', 2)) throw new Error('Kernel image observer unavailable');
  ObjC.bindFunction('proc_pidpath', ['int', ['int', 'void *', 'uint32_t']]);
  const bytes = $.malloc(4096);
  if (!bytes) throw new Error('Kernel image observer unavailable');
  try {
    const count = $.proc_pidpath(Number(args[0]), bytes, 4096);
    if (count <= 0) throw new Error('Kernel image observer unavailable');
    return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(
      $.NSData.dataWithBytesLength(bytes, count), $.NSUTF8StringEncoding));
  } finally { $.free(bytes); }
}`;

export async function processExecutable(identity: ProcessIdentity): Promise<string | null> {
  if (await processStateAsync(identity) !== 'alive') return null;
  try {
    let file: string;
    if (process.platform === 'linux') file = await readlink(`/proc/${identity.pid}/exe`);
    else if (process.platform === 'darwin') {
      const result = await runAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DARWIN_IMAGE, String(identity.pid)],
        { encoding: 'utf8', timeoutMs: 2000, env: { PATH: '/usr/bin:/bin' } });
      if (result.error || result.status !== 0 || result.stderr.trim()) return null;
      file = result.stdout.trim();
    } else return null;
    if (!path.isAbsolute(file) || /[\r\n\0]/.test(file) || await processStateAsync(identity) !== 'alive') return null;
    return file;
  } catch { return null; }
}

export async function processParent(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'linux') {
      const source = await readFile(`/proc/${pid}/stat`, 'utf8');
      const fields = source.slice(source.lastIndexOf(')') + 2).split(' ');
      return fields[0] !== 'Z' && /^\d+$/.test(fields[1] ?? '') ? Number(fields[1]) : null;
    }
    if (process.platform === 'darwin') {
      const result = await runAsync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeoutMs: 2000 });
      if (result.status === 0 && /^\s*\d+\s*$/.test(result.stdout)) return Number(result.stdout.trim());
    }
  } catch {}
  return null;
}

export async function observeRootProcess(pid: number): Promise<ProcessIdentity | null> {
  return processIdentityAsync(pid);
}

export async function isSupportedPosixShell(identity: ProcessIdentity): Promise<boolean> {
  const file = await processExecutable(identity);
  if (!file) return false;
  try {
    if (process.platform !== 'darwin') return file === realpathSync('/bin/sh');
    if (!['/bin/sh', '/bin/bash'].includes(file) || realpathSync(file) !== file) return false;
    const image = await lstat(file);
    return image.isFile() && image.uid === 0 && (image.mode & 0o022) === 0
      && await processStateAsync(identity) === 'alive';
  } catch { return false; }
}

export async function requireNativeHookAncestor(native: ProcessIdentity, start = process.ppid) {
  if (start === native.pid && await processStateAsync(native) === 'alive') return;
  const shell = await observeRootProcess(start);
  if (shell && await isSupportedPosixShell(shell)
    && await processParent(start) === native.pid && await processStateAsync(native) === 'alive') {
    return;
  }
  throw new Error('Standalone hook requires the exact native process or its observed /bin/sh command child');
}

export async function processHasOpenFile(identity: ProcessIdentity, file: string): Promise<boolean> {
  if (!path.isAbsolute(file) || await processStateAsync(identity) !== 'alive') return false;
  try {
    const target = await stat(file, { bigint: true });
    let opened = false;
    if (process.platform === 'linux') {
      for (const fd of await readdir(`/proc/${identity.pid}/fd`)) {
        try {
          const actual = await stat(`/proc/${identity.pid}/fd/${fd}`, { bigint: true });
          if (actual.dev === target.dev && actual.ino === target.ino) { opened = true; break; }
        } catch {}
      }
    } else if (process.platform === 'darwin') {
      const result = await runAsync('/usr/sbin/lsof', ['-a', '-p', String(identity.pid), '-Fpn', file],
        { encoding: 'utf8', timeoutMs: 2000, env: { PATH: '/usr/bin:/bin:/usr/sbin' } });
      const fields = result.stdout.split('\n');
      opened = result.status === 0 && !result.error && fields.includes(`p${identity.pid}`) && fields.includes(`n${file}`);
    }
    const current = await stat(file, { bigint: true });
    return opened && current.dev === target.dev && current.ino === target.ino && await processStateAsync(identity) === 'alive';
  } catch { return false; }
}

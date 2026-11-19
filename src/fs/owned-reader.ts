import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 16_384;
const DEFAULT_BYTES = 1024 * 1024;
const READ_BUDGET = 32 * DEFAULT_BYTES;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sameInode = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;

export class OwnedReadChanged extends Error {}

export function ownedReader(configured: string) {
  const uid = process.getuid?.();
  if (uid === undefined || !constants.O_NOFOLLOW) throw new Error('cannot verify store file ownership on this platform');
  const owned = (stat: { uid: number }) => stat.uid === uid;
  const base = lstatSync(configured);
  if (!base.isDirectory() || !owned(base)) throw new Error('store root is not an owned directory');
  const root = realpathSync(configured);
  if (!sameInode(base, lstatSync(root))) throw new Error('store root changed during resolution');
  let bytesLeft = READ_BUDGET;
  const refuse = (file: string): never => { throw new Error(`store entry crosses the owned regular-file boundary: ${path.relative(root, file)}`); };
  const directory = (dir: string): void => {
    const rel = path.relative(root, dir);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`) || path.resolve(dir) !== dir) refuse(dir);
    let current = root;
    if (!sameInode(base, lstatSync(root)) || realpathSync(root) !== root) refuse(root);
    for (const component of rel ? rel.split(path.sep) : []) {
      current = path.join(current, component);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || !owned(stat)) refuse(current);
    }
  };
  const text = (file: string, max = DEFAULT_BYTES): string | null => {
    let fd: number | undefined;
    try {
      if (path.resolve(file) !== file) refuse(file);
      directory(path.dirname(file));
      const before = lstatSync(file);
      if (!before.isFile() || !owned(before) || before.size > max || realpathSync(file) !== file) refuse(file);
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || !owned(stat) || stat.size > max) refuse(file);
      if (!sameInode(before, stat)) throw new OwnedReadChanged(`store record changed during open: ${path.relative(root, file)}`);
      if (stat.size > bytesLeft) throw new Error('store snapshot exceeds the 32 MiB read budget');
      bytesLeft -= stat.size;
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      directory(path.dirname(file));
      if (size !== stat.size || realpathSync(file) !== file) refuse(file);
      return buffer.subarray(0, size).toString('utf8');
    } catch (error) {
      if (fd === undefined && missing(error)) return null;
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  };
  const names = (dir: string): string[] => {
    try { directory(dir); } catch (error) { if (missing(error)) return []; throw error; }
    const handle = opendirSync(dir);
    try {
      const out: string[] = [];
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (out.length >= MAX_ENTRIES) throw new Error(`store directory exceeds ${MAX_ENTRIES} entries: ${path.relative(root, dir)}`);
        out.push(entry.name);
      }
      directory(dir);
      return out.sort();
    } finally { handle.closeSync(); }
  };
  const hasDirectory = (dir: string) => {
    try { directory(dir); return true; } catch (error) { if (missing(error)) return false; throw error; }
  };
  return { root, text, names, hasDirectory, resetBudget() { bytesLeft = READ_BUDGET; } };
}

export type OwnedReader = ReturnType<typeof ownedReader>;

// Atomic file write — a raw primitive shared by the legacy store and protocol v1.
//
// Not exported: a helper exported once becomes a contract, and the point of the
// boundary is that the outside sees protocol, not disk. There is no second copy
// — v1 takes this same module.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

let atomicSeq = 0;

/**
 * Write a file whole: a temporary neighbour in the same directory and `rename` over it.
 *
 * `writeFileSync` truncates the file to zero — a parallel reader finds it empty,
 * and a process that died mid-write leaves a truncated file forever.
 */
export function writeFileAtomic(file: string, content: string, { mode = null }: { mode?: number | null } = {}): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  atomicSeq += 1;
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${atomicSeq}`);
  try {
    writeFileSync(tmp, content, mode === null ? undefined : { mode });
    // `mode` on `writeFileSync` is cut by umask: under a stock 022 a requested 0o660
    // arrives as 0o640. `chmod` after create does not touch umask.
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    // recursive: a directory can sit where tmp should be (an aborted pass, a
    // foreign FS); `force` alone will not lift it, and the next write would
    // hit it forever.
    rmSync(tmp, { force: true, recursive: true });
    throw e;
  }
}

/** The same move — for every overwriteable JSON file on the bus. */
export function writeJsonAtomic<T>(file: string, value: T): T {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

// Atomic writes.
// [reference/01-overview.md#atomic-writes](../../docs/reference/01-overview.md#atomic-writes)
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

let atomicSeq = 0;

/**
 * Write a file whole: a temporary neighbour in the same directory and `rename` over it.
 *
 * `writeFileSync` truncates the file to zero — a parallel reader finds it empty,
 * and a process that died mid-write leaves a truncated file forever.
 */
export function writeFileAtomic(file: string, content: string, { mode = null, preserveMode = false }: { mode?: number | null; preserveMode?: boolean } = {}): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  atomicSeq += 1;
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${atomicSeq}`);
  const kept = preserveMode && existsSync(file) ? (statSync(file).mode & 0o777) : null;
  const m = kept ?? mode;
  try {
    writeFileSync(tmp, content, m === null ? undefined : { mode: m });
    // `mode` on `writeFileSync` is cut by umask: under a stock 022 a requested 0o660
    // arrives as 0o640. `chmod` after create does not touch umask.
    if (m !== null) chmodSync(tmp, m);
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
export function writeJsonAtomic<T>(file: string, value: T, { mode = null }: { mode?: number | null } = {}): T {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  return value;
}

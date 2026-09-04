// Живость процесса и синхронная пауза. Внутренний модуль package: наружу эти примитивы не
// экспортируются — `pidAlive` уходит из `store.ts`, потому что он часть его
// поверхности с прежних времён.
import process from 'node:process';

/**
 * Жив ли процесс. Сигнал 0 ничего не шлёт, а только проверяет доступность цели; `EPERM`
 * означает «процесс есть, но чужой» — тоже жив.
 */
export function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Синхронная пауза: лок берётся из синхронного кода, и уступить ход событий там нечему. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

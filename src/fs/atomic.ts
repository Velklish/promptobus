// Атомарная запись файла — сырой примитив, общий у legacy store и protocol v1.
//
// Наружу не экспортируется (ADR-032, §1): экспортированный однажды хелпер становится
// контрактом, а смысл границы в том, что снаружи виден protocol, а не диск. Копии второй
// не бывает — v1 берёт этот же модуль.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

let atomicSeq = 0;

/**
 * Записать файл целиком: временный сосед в той же директории и `rename` поверх.
 *
 * `writeFileSync` усекает файл до нуля — параллельный читатель застаёт его пустым, а
 * умерший посреди записи процесс оставляет обрезанный файл навсегда.
 */
export function writeFileAtomic(file: string, content: string, { mode = null }: { mode?: number | null } = {}): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  atomicSeq += 1;
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${atomicSeq}`);
  try {
    writeFileSync(tmp, content, mode === null ? undefined : { mode });
    // `mode` у `writeFileSync` режет umask: при штатном 022 просьба 0o660 приезжает 0o640.
    // `chmod` после создания umask не касается.
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    // recursive: на месте tmp бывает каталог (оборванный проход, чужая ФС), одним `force`
    // он не снимается, и следующая запись упиралась бы в него вечно.
    rmSync(tmp, { force: true, recursive: true });
    throw e;
  }
}

/** Тот же приём — всем перезаписываемым JSON-файлам шины. */
export function writeJsonAtomic<T>(file: string, value: T): T {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

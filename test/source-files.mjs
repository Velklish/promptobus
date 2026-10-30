import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function sourceFile(file, exists = existsSync) {
  const typed = file.replace(/\.js$/, '.ts');
  return typed !== file && exists(typed) ? typed : file;
}

export function sourceFilesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(file);
    if (!entry.isFile() || entry.name.endsWith('.d.ts')) return [];
    return entry.name.endsWith('.ts') || (entry.name.endsWith('.js') && sourceFile(file) === file)
      ? [file] : [];
  });
}

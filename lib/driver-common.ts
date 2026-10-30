import { readFileSync } from 'node:fs';
import process from 'node:process';
import { logWarden } from './store.js';

export function parseVersion(value: unknown) {
  const raw = String(value ?? '');
  const match = /(?:^|[^A-Za-z0-9])v?(\d+(?:\.\d+)*)(?![\d.])/.exec(raw);
  return match ? match[1].split('.').map(Number) : null;
}

export function versionLess(a: unknown, b: unknown) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

export function versionParseRefusal(name: string, value: unknown) {
  return `${name} binary version could not be parsed: ${String(value)}`;
}

export function sessionEnv(dropList: readonly string[] | null | undefined, base = process.env, extra: NodeJS.ProcessEnv = {}) {
  const env = { ...base };
  for (const name of dropList ?? []) delete env[name];
  return { ...env, ...extra };
}

export function sessionEnvFor(dropList: readonly string[] | null | undefined) {
  return (base = process.env, extra: NodeJS.ProcessEnv = {}) => sessionEnv(dropList, base, extra);
}

export function readRecordAt<T = Record<string, unknown>>(file: string): T | null {
  try {
    const record: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return record as T;
  } catch {
    return null;
  }
}

const foreignWrites = new Set<string>();

export function sayForeignWrite(home: string, task: string, addr: string, held: string, session: string | null, what: string) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} for address ${addr} is refused: the address is bound to session ${held}, `
    + `and ${session} is writing — the owner's records were left untouched`);
}

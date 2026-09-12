import { readFileSync } from 'node:fs';
import process from 'node:process';
import { logWarden } from './store.js';

export function parseVersion(value) {
  const raw = String(value ?? '');
  const match = /(?:^|[^A-Za-z0-9])v?(\d+(?:\.\d+)*)(?![\d.])/.exec(raw);
  return match ? match[1].split('.').map(Number) : null;
}

export function versionLess(a, b) {
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

export function versionParseRefusal(name, value) {
  return `${name} binary version could not be parsed: ${String(value)}`;
}

export function sessionEnv(dropList, base = process.env, extra = {}) {
  const env = { ...base };
  for (const name of dropList ?? []) delete env[name];
  return { ...env, ...extra };
}

export function sessionEnvFor(dropList) {
  return (base = process.env, extra = {}) => sessionEnv(dropList, base, extra);
}

export function readRecordAt(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const foreignWrites = new Set();

export function sayForeignWrite(home, task, addr, held, session, what) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} for address ${addr} is refused: the address is bound to session ${held}, `
    + `and ${session} is writing — the owner's records were left untouched`);
}

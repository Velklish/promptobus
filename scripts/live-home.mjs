import { readdirSync, readFileSync } from 'node:fs';

export function optionalEntries(dir) {
  try { return readdirSync(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function optionalBytes(file) {
  try { return readFileSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

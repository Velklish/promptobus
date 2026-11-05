// Time ledger of `npm test`: one JSON line per file per run and one per run. Not `*.test.mjs` —
// the runner does not run it. Format and use: contributing.md § Suite isolation.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LEDGER_ENV = 'PROMPTOBUS_TEST_LEDGER';

// A checkout without `node_modules` — a fixture repository planting the runner — keeps no ledger.
export function ledgerPath(root, env = process.env) {
  if (env[LEDGER_ENV]) return path.resolve(env[LEDGER_ENV]);
  const modules = path.join(root, 'node_modules');
  return existsSync(modules) ? path.join(modules, '.cache', 'promptobus-test-ledger.jsonl') : null;
}

export function appendLedger(file, lines) {
  if (!lines.length) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

const isLine = (line) => !!line && typeof line === 'object' && typeof line.run === 'string'
  && (line.kind === 'run' || (line.kind === 'file' && typeof line.file === 'string' && Number.isFinite(line.ms)));

export function readLedger(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { lines: [], broken: 0 };
    throw e;
  }
  const lines = [];
  let broken = 0;
  for (const text of raw.split('\n')) {
    if (!text.trim()) continue;
    try {
      const value = JSON.parse(text);
      if (isLine(value)) lines.push(value);
      else broken += 1;
    } catch {
      broken += 1;
    }
  }
  return { lines, broken };
}

export function fileMedians(lines, { runs = 8 } = {}) {
  const files = lines.filter((line) => line.kind === 'file');
  const kept = new Set([...new Set(files.map((line) => line.run))].slice(-runs));
  const samples = new Map();
  for (const line of files) {
    if (!kept.has(line.run) || line.outcome !== 'pass') continue;
    samples.set(line.file, [...(samples.get(line.file) ?? []), line.ms]);
  }
  return new Map([...samples].map(([file, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return [file, { median: sorted[Math.floor(sorted.length / 2)], samples: sorted.length }];
  }));
}

// A file without history goes first: its duration is unknown, and a late start risks the tail.
export function dispatchOrder(names, medians) {
  return [...names].sort((a, b) => {
    const ma = medians.get(a)?.median;
    const mb = medians.get(b)?.median;
    if (ma === undefined || mb === undefined) {
      return (ma === undefined ? 0 : 1) - (mb === undefined ? 0 : 1) || a.localeCompare(b);
    }
    return mb - ma || a.localeCompare(b);
  });
}

// Slow is twice the median AND `minDeltaMs` more: a ratio alone flags the noise of short files.
export function slowFiles(results, medians, { factor = 2, minDeltaMs = 5000, minSamples = 3 } = {}) {
  return results.flatMap(({ name, ms }) => {
    const known = medians.get(name);
    if (!known || known.samples < minSamples || ms < known.median * factor || ms - known.median < minDeltaMs) return [];
    return [{ name, ms, median: known.median }];
  }).sort((a, b) => (b.ms - b.median) - (a.ms - a.median) || a.name.localeCompare(b.name));
}

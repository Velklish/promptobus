// Gate: an inline comment runs at most two lines (owner's rule of 2026-09-12).
// Why, the sweep order and where displaced facts go: guides/contributing.md.
import './home.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { longRuns } from './comment-scan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 2;
const TREES = ['lib', 'src', 'bin', 'templates'];
const CODE = /\.(js|ts|mjs)$/;

/**
 * Files the sweep has not reached, each with the IDENTITY of every long run it still has.
 *
 * Identities and not a count, because a count let a pending file swap its debt: delete one
 * long block, add another, and `runs.length` was unchanged and the gate silent. A run is
 * identified by the hash of its own text, so the only lawful move is disappearance.
 *
 * No other exception exists. There are no licence headers in these trees and nothing
 * generated is tracked, so an exception would be a hole shaped like the thing the gate
 * looks for.
 */
const PENDING = new Map(Object.entries(JSON.parse(
  readFileSync(path.join(ROOT, 'test', 'fixtures', 'comment-sweep-pending.json'), 'utf8'),
)).map(([file, ids]) => [file, new Set(ids)]));

/** A run's identity: its own prose, so that rewriting it is a change and moving it is not. */
export function runId(run) {
  return createHash('sha256').update(run.lines.map((l) => l.trim()).join('\n')).digest('hex').slice(0, 12);
}

export function runsOf(text) {
  return longRuns(text, LIMIT);
}

const tracked = execFileSync('git', ['ls-files', ...TREES], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && CODE.test(f));

test('an inline comment is at most two lines, outside the files the sweep has not reached', () => {
  assert.ok(tracked.length > 0, 'no files were read — the walk found nothing to judge');
  const offenders = [];
  const appeared = [];
  const swept = [];
  for (const rel of tracked) {
    const runs = runsOf(readFileSync(path.join(ROOT, rel), 'utf8'));
    if (!PENDING.has(rel)) {
      for (const run of runs) offenders.push(`${rel}:${run.line} — ${run.length} lines`);
      continue;
    }
    const owed = PENDING.get(rel);
    for (const run of runs) {
      if (!owed.has(runId(run))) appeared.push(`${rel}:${run.line} — a long run the list does not name`);
    }
    if (!runs.length) swept.push(rel);
  }
  assert.deepEqual(offenders, [], `comment runs longer than ${LIMIT} lines`);
  assert.deepEqual(appeared, [],
    'a pending file carries a long run the list does not name — swapping debt is not sweeping');
  assert.deepEqual(swept, [], 'swept files still listed as pending — take them off the list');
});

test('every pending entry names a tracked file, and every listed run still exists', () => {
  const missingFiles = [...PENDING.keys()].filter((rel) => !tracked.includes(rel));
  assert.deepEqual(missingFiles, [], 'pending list names files the walk does not see');
  // A listed id no run answers is debt already paid: the entry has to go, or the list
  // drifts into an allowlist of names nobody checks.
  const stale = [];
  for (const [rel, owed] of PENDING) {
    if (!tracked.includes(rel)) continue;
    const have = new Set(runsOf(readFileSync(path.join(ROOT, rel), 'utf8')).map(runId));
    for (const id of owed) if (!have.has(id)) stale.push(`${rel}: ${id} is listed and gone — drop it`);
  }
  assert.deepEqual(stale, [], 'pending entries for runs that no longer exist');
});

test('the scanner sees the shapes a per-line regexp could not', () => {
  // Each was a hole the review named, and each is a positive case: without them the gate
  // could stop seeing comments altogether and still pass.
  const one = (src) => runsOf(src).map((r) => [r.line, r.length]);
  assert.deepEqual(one('/*\n a\n b\n */\nconst x = 1;'), [[1, 4]], 'a block with bare continuation lines');
  assert.deepEqual(one('const x = 1; // one\n// two\n// three\n'), [[1, 3]], 'a comment opened after code');
  assert.deepEqual(one('/**\n * a\n * b\n */\nfn();'), [[1, 4]], 'a jsdoc block');
  assert.deepEqual(one('// a\n// b\n// c\nconst x = 1;'), [[1, 3]], 'three line comments');
  assert.deepEqual(one('// a\nconst x = 1;\n// b\n'), [], 'code between them ends the run');
  assert.deepEqual(one("const s = '// not a comment';\nconst u = 'http://x';\n"), [], 'inside a string');
});

test('a run is identified by its text, so replacing one is not paying it', () => {
  const a = runsOf('// one\n// two\n// three\n')[0];
  const b = runsOf('// four\n// five\n// six\n')[0];
  assert.equal(a.length, b.length, 'the fixture holds the COUNT equal — that is the hole being closed');
  assert.notEqual(runId(a), runId(b), 'equal counts must not give equal identities');
  assert.equal(runId(a), runId(runsOf('// one\n// two\n// three\n')[0]), 'the same text gives the same id');
});

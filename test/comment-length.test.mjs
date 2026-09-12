// Gate: an inline comment runs at most two lines (owner's rule of 2026-09-12).
// Why, the sweep order and where displaced facts go: guides/contributing.md.
import './home.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 2;
const TREES = ['lib', 'src', 'bin', 'templates'];
const CODE = /\.(js|ts|mjs)$/;
const COMMENT = /^\s*(\/\/|\*|\/\*)/;

/**
 * Files the sweep has not reached yet, with the run count each still carries.
 *
 * A ratchet, not an exemption list: the gate is red on a long run in any file NOT named
 * here, AND red on a file named here that no longer has one. The second half is what
 * keeps the list shrinking — an entry that stops being true is a failure, so nobody can
 * sweep a file and leave it listed as unswept. The list empties and then goes.
 *
 * No other exception exists. There are no licence headers in these trees and nothing
 * generated is tracked, so an exception would be a hole shaped like the thing the gate
 * looks for.
 */
const PENDING = new Map(Object.entries(JSON.parse(
  readFileSync(path.join(ROOT, 'test', 'fixtures', 'comment-sweep-pending.json'), 'utf8'),
)));

export function runsOf(text) {
  const lines = text.split('\n');
  const runs = [];
  let i = 0;
  while (i < lines.length) {
    if (!COMMENT.test(lines[i])) { i++; continue; }
    let j = i;
    while (j < lines.length && COMMENT.test(lines[j])) j++;
    if (j - i > LIMIT) runs.push({ line: i + 1, length: j - i });
    i = j;
  }
  return runs;
}

const tracked = execFileSync('git', ['ls-files', ...TREES], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && CODE.test(f));

test('an inline comment is at most two lines, outside the files the sweep has not reached', () => {
  assert.ok(tracked.length > 0, 'no files were read — the walk found nothing to judge');
  const offenders = [];
  const stale = [];
  for (const rel of tracked) {
    const runs = runsOf(readFileSync(path.join(ROOT, rel), 'utf8'));
    if (PENDING.has(rel)) {
      if (!runs.length) stale.push(rel);
      continue;
    }
    for (const run of runs) offenders.push(`${rel}:${run.line} — ${run.length} lines`);
  }
  assert.deepEqual(offenders, [], `comment runs longer than ${LIMIT} lines`);
  assert.deepEqual(stale, [], 'swept files still listed as pending — take them off the list');
});

test('every pending entry names a tracked file', () => {
  const missing = [...PENDING.keys()].filter((rel) => !tracked.includes(rel));
  assert.deepEqual(missing, [], 'pending list names files the walk does not see');
});

test('the run finder counts a run, not a comment line', () => {
  // Three consecutive lines are one run of three; the same three split by code are none.
  assert.deepEqual(runsOf('// a\n// b\n// c\n'), [{ line: 1, length: 3 }]);
  assert.deepEqual(runsOf('// a\nconst x = 1;\n// b\nconst y = 2;\n// c\n'), []);
  assert.deepEqual(runsOf('// a\n// b\nconst x = 1;\n'), []);
  // A block comment counts by its lines, wherever it starts.
  assert.deepEqual(runsOf('const x = 1;\n/**\n * a\n * b\n */\n'), [{ line: 2, length: 4 }]);
});

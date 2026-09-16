// Gate: an inline comment runs at most two lines (owner's rule of 2026-09-12).
// What it catches, what it does not, and where displaced facts go: guides/contributing.md § the sweep.
import './home.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { longRuns, maskedLines, trackedCode } from './comment-scan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 2;
const TREES = ['lib', 'src', 'bin'];

// Files the sweep has not reached, each listing the IDENTITY of every long run it still
// has, once per run: a run listed twice is owed twice.
const PENDING = new Map(Object.entries(JSON.parse(
  readFileSync(path.join(ROOT, 'test', 'fixtures', 'comment-sweep-pending.json'), 'utf8'),
)));

/** A run's identity: its own prose, so that rewriting it is a change and moving it is not. */
export function runId(run) {
  return createHash('sha256').update(run.lines.map((l) => l.trim()).join('\n')).digest('hex').slice(0, 12);
}

export function runsOf(text) {
  return longRuns(text, LIMIT);
}

/** How many times each value occurs — the whole difference between a multiset and a `Set`. */
function countOf(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

/** The runs a list does not name, counting copies: listed once and written twice owes one. */
export function unnamedRuns(runs, listed) {
  const owed = countOf(listed);
  const out = [];
  for (const run of runs) {
    const id = runId(run);
    const left = owed.get(id) ?? 0;
    if (left > 0) owed.set(id, left - 1);
    else out.push(run);
  }
  return out;
}

/** The listed ids no run answers any more, counting copies. */
export function staleIds(runs, listed) {
  const have = countOf(runs.map(runId));
  const out = [];
  for (const [id, owed] of countOf(listed)) {
    for (let n = have.get(id) ?? 0; n < owed; n++) out.push(id);
  }
  return out;
}

const { files: tracked, empty: emptyTrees } = trackedCode(ROOT, TREES);

test('every tree the gate names carries code it can judge', () => {
  assert.deepEqual(emptyTrees, [], 'a tree named in TREES holds no tracked code file — drop it or fix the name');
  assert.ok(tracked.length > 0, 'no files were read — the walk found nothing to judge');
});

test('the pending list only ever shrinks', () => {
  // Ceilings as literals, lowered BY HAND as debt is paid: without them a new run plus its id
  // in the fixture passes every other check here, and raising one is an edit review can see.
  assert.ok(PENDING.size <= 10, `the pending list names ${PENDING.size} files, and the ceiling is 10`);
  const ids = [...PENDING.values()].flat().length;
  assert.ok(ids <= 189, `the pending list owes ${ids} runs, and the ceiling is 189`);
});

/** The walk, with a count of what it actually read and judged beside its three verdict lists. */
export function surveyTree(files, listing) {
  const offenders = [];
  const appeared = [];
  const swept = [];
  let judged = 0;
  let seen = 0;
  for (const rel of files) {
    const runs = runsOf(readFileSync(path.join(ROOT, rel), 'utf8'));
    judged++;
    seen += runs.length;
    if (!listing.has(rel)) {
      for (const run of runs) offenders.push(`${rel}:${run.line} — ${run.length} lines`);
      continue;
    }
    // Each run spends one unit of what the list owes; the copy of an allowed block finds none.
    for (const run of unnamedRuns(runs, listing.get(rel))) {
      appeared.push(`${rel}:${run.line} — a long run the list does not name (${run.length} lines)`);
    }
    if (!runs.length) swept.push(rel);
  }
  return { offenders, appeared, swept, judged, seen };
}

const walk = surveyTree(tracked, PENDING);

test('the walk says how much it read, because an empty one gives the same green as a full one', () => {
  // Measured before this floor existed: emptying the walk outright left 11 of 11 verdicts green,
  // since every list it fills is asserted EMPTY and an empty walk fills them all with nothing.
  assert.equal(walk.judged, tracked.length, `the walk judged ${walk.judged} of ${tracked.length} tracked files`);
  assert.equal(walk.seen, 189, `the walk saw ${walk.seen} long runs, and the tree is known to carry 189`);
});

test('the walk refuses each of the four shapes it exists to catch', () => {
  // The floor catches a walk that read NOTHING; it cannot catch one that reads every file and
  // judges none, since `judged` and `seen` fill either way. So the judging branches are driven.
  const debtor = 'lib/spawn.js';
  const carried = runsOf(readFileSync(path.join(ROOT, debtor), 'utf8')).length;
  const bare = surveyTree([debtor], new Map());
  assert.ok(carried > 0, `${debtor} no longer carries debt — point this test at another listed file`);
  assert.equal(bare.offenders.length, carried, 'every long run of a file the list does not name is refused');
  assert.ok(bare.offenders[0].startsWith(`${debtor}:`), 'and the refusal names the file and the line');
  assert.deepEqual(bare.appeared, [], 'a file outside the list cannot also be swapping debt');
  const owesNothing = surveyTree([debtor], new Map([[debtor, []]]));
  assert.deepEqual(owesNothing.offenders, [], 'a listed file is judged against its entries, not refused outright');
  assert.equal(owesNothing.appeared.length, carried, 'and every run beyond them is a run the list does not name');
  const clean = 'lib/cli.js';
  assert.deepEqual(surveyTree([clean], new Map([[clean, []]])).swept, [clean],
    'a listed file with nothing left to sweep has to come off the list');
  assert.deepEqual(unknownFiles([clean], new Map([['lib/gone.js', []]])), ['lib/gone.js'],
    'and a name the list carries that the walk never sees is refused too');
  assert.deepEqual(unknownFiles([clean], new Map([[clean, []]])), [], 'a name the walk does see is not');
});

test('an inline comment is at most two lines, outside the files the sweep has not reached', () => {
  assert.deepEqual(walk.offenders, [], `comment runs longer than ${LIMIT} lines`);
  assert.deepEqual(walk.appeared, [],
    'a pending file carries a long run the list does not name — swapping debt is not sweeping');
  assert.deepEqual(walk.swept, [], 'swept files still listed as pending — take them off the list');
});

/** Files the list names that the walk does not see — the other direction of the same sweep. */
export function unknownFiles(files, listing) {
  return [...listing.keys()].filter((rel) => !files.includes(rel));
}

test('every pending entry names a tracked file, and every listed run still exists, as many times as listed', () => {
  assert.deepEqual(unknownFiles(tracked, PENDING), [], 'pending list names files the walk does not see');
  const stale = [];
  for (const [rel, ids] of PENDING) {
    if (!tracked.includes(rel)) continue;
    // Listed more often than the file carries it is debt already paid: the extra entry goes.
    const runs = runsOf(readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const id of staleIds(runs, ids)) stale.push(`${rel}: ${id} is listed and not answered — drop it`);
  }
  assert.deepEqual(stale, [], 'pending entries for runs that no longer exist');
});

test('the scanner sees the shapes a per-line regexp could not', () => {
  const one = (src) => runsOf(src).map((r) => [r.line, r.length]);
  assert.deepEqual(one('/*\n a\n b\n */\nconst x = 1;'), [[1, 4]], 'a block with bare continuation lines');
  // Boundaries are not enough: the bare lines must be IN the run, or its identity is the
  // identity of a different comment and the ratchet compares the wrong text.
  assert.deepEqual(runsOf('/*\n a\n b\n */\n')[0].lines.map((l) => l.trim()), ['/*', 'a', 'b', '*/']);
  assert.deepEqual(one('/* x */ // one\n// two\n// three\n'), [[1, 3]], 'a run continuing after `*/` on the same line');
  assert.deepEqual(one('/*\n a\n b\n */ work();\n'), [[1, 3]], 'code after `*/` ends the run there');
  assert.deepEqual(one('/**\n * a\n * b\n */\nfn();'), [[1, 4]], 'a jsdoc block');
  assert.deepEqual(one('// a\n// b\n// c\nconst x = 1;'), [[1, 3]], 'three line comments');
  assert.deepEqual(one('/** a */\n// b\n// c\nconst x = 1;'), [[1, 3]], 'two adjacent comments are one run');
  assert.deepEqual(one('// a\nconst x = 1;\n// b\n'), [], 'code between them ends the run');
  assert.deepEqual(one('// a\n\n// b\n// c\n'), [], 'a blank line between them ends the run');
});

test('a trailing comment belongs to its code line: it neither starts nor continues a run', () => {
  const one = (src) => runsOf(src).map((r) => [r.line, r.length]);
  assert.deepEqual(one('const x = 1; // one\n// two\n// three\n'), [],
    'a comment opened after code does not start a run');
  assert.deepEqual(one('// a\n// b\nconst x = 1; // c\n// d\n// e\n'), [],
    'a code line breaks the run whether or not it ends in a comment');
});

test('a comment marker inside a string, a template or a regex is not a comment', () => {
  const one = (src) => runsOf(src).map((r) => [r.line, r.length]);
  assert.deepEqual(one("const s = '// not a comment';\nconst u = 'http://x';\n"), [], 'inside a string');
  assert.deepEqual(one('const s = "/*";\nconst t = "*/";\nconst u = 1;\n'), [], 'a block marker inside a string');
  assert.deepEqual(one('const s = `// not a comment\n// still not`;\nconst y = 1;\n'), [],
    'inside a template literal, which spans lines');
});

test('the lexer keeps its state across lines: a regex and a nested template close where they should', () => {
  const one = (src) => runsOf(src).map((r) => [r.line, r.length]);
  // Measured in the consumer's copy of this gate, 2026-09-16: without regex state the backtick
  // below opened a template that never closed and hid 66 blocks, 413 lines, in 10 files.
  assert.deepEqual(one('const r = /`/g;\n// a\n// b\n// c\n'), [[2, 3]], 'a backtick inside a regex opens nothing');
  assert.deepEqual(one("text.replace(/`/g, '');\n/*\n a\n b\n*/\n"), [[2, 4]], 'and the block after it is still seen');
  // The same measurement: a fix reading only the previous character lost 5 more blocks here,
  // because the inner `` ` `` closes the inner template and the outer `}` the outer `${`.
  assert.deepEqual(one('const s = `a${`b${c}d`}e`;\n// a\n// b\n// c\n'), [[2, 3]], 'templates nested through `${…}`');
  assert.deepEqual(one('const s = `${ {a: 1} }`;\n// a\n// b\n// c\n'), [[2, 3]], 'a brace inside `${…}` is not its end');
  assert.deepEqual(one('const q = (a + b) / 2;\n// a\n// b\n// c\n'), [[2, 3]], 'a division is not a regex');
});

test('what a `/` is decided by the token before it, and the comment beside it is the proof', () => {
  // A misread `/` costs the comment to its RIGHT rather than the parse, so that is the assertion:
  // a regex swallowing `/* note */` and a division leaving it are the two observable outcomes.
  const noteOn = (src) => maskedLines(src)[0].trim();
  assert.equal(noteOn('let i = 0; i++ / 2; /* note */'), '/* note */', '`++` is one token: division follows');
  assert.equal(noteOn('while (i--) { x(); } / 2; /* note */'), '/* note */', 'and so is `--`; a brace ends a value too');
  // `!` stays in the regex class: prefix negation is what the tree writes, `lib/exec.js` among them,
  // while the postfix TypeScript `x!` appears nowhere in it.
  assert.equal(noteOn('const v = !/\\s/.test(x); /* note */'), '/* note */', 'a regex after `!` closes at its own `/`');
  assert.equal(noteOn('#!/usr/bin/env node // note'), '// note', 'a shebang opens nothing that stays open');
});

test('a run is identified by its text, and the list owes it once per copy', () => {
  const a = runsOf('// one\n// two\n// three\n')[0];
  const b = runsOf('// four\n// five\n// six\n')[0];
  assert.equal(a.length, b.length, 'the fixture holds the COUNT equal — that is the hole being closed');
  assert.notEqual(runId(a), runId(b), 'equal counts must not give equal identities');
  assert.equal(runId(a), runId(runsOf('// one\n// two\n// three\n')[0]), 'the same text gives the same id');
  const twice = runsOf('// one\n// two\n// three\nconst x = 1;\n// one\n// two\n// three\n');
  assert.equal(twice.length, 2, 'the same block written twice is two runs');
  assert.equal(runId(twice[0]), runId(twice[1]), 'and they carry one identity, which a Set would collapse');
});

test('the list owes a run once per copy, which is the round-5 bypass closed', () => {
  const twice = runsOf('// one\n// two\n// three\nconst x = 1;\n// one\n// two\n// three\n');
  const id = runId(twice[0]);
  assert.equal(unnamedRuns(twice, [id]).length, 1, 'a list owing it once pays one copy and refuses the other');
  assert.equal(unnamedRuns(twice, [id, id]).length, 0, 'a list owing it twice pays for both');
  assert.equal(unnamedRuns(twice, []).length, 2, 'a list owing nothing refuses both');
  // And the other direction: an entry listed more often than the tree answers it is dead debt.
  assert.deepEqual(staleIds(twice, [id, id, id]), [id], 'listed three times, written twice: one entry is dead');
  assert.deepEqual(staleIds(twice, [id, id]), [], 'listed as often as written: nothing to drop');
  assert.deepEqual(staleIds([], [id]), [id], 'a run that is gone leaves its entry behind');
});

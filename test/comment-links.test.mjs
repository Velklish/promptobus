// Gate: a markdown link inside a CODE comment resolves — file, anchor and subject.
// What it catches and what it does not: guides/contributing.md § the sweep.
import './home.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { codeLines, commentBlocks, maskedLines, trackedCode } from './comment-scan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREES = ['lib', 'src', 'bin'];
const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const SOURCE_TOKEN = /^[\s,.—–-]*(?:in\s+|and\s+)?`([^`]+)`/;
const PATHISH = /\.(js|ts|mjs|json|md)$/;
const DECLARED = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|const|class|type|interface|enum|let|var)\s+([A-Za-z0-9_$]+)/;
const MEMBER = /^\s*(?:(?:public|private|protected|static|readonly|abstract|async|get|set)\s+)*([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*\(/;
const NOT_A_NAME = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'with', 'case',
  'new', 'typeof', 'delete', 'void', 'throw', 'await', 'yield', 'import', 'export', 'super', 'this',
]);

/** The pointers this tree is known to carry, per file and per class, with multiplicity. */
const BASELINE = JSON.parse(
  readFileSync(path.join(ROOT, 'test', 'fixtures', 'comment-links-baseline.json'), 'utf8'),
);

/** GitHub's heading slug: each space becomes a hyphen, runs are not collapsed. */
export function slugOf(heading) {
  return heading.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9 _-]/g, '').trim().replace(/ /g, '-');
}

export function anchorsOf(markdown) {
  return new Set(markdown.split('\n')
    .map((l) => l.match(/^#{1,6}\s+(.*)$/)).filter(Boolean).map((m) => slugOf(m[1])));
}

/** The backticked list at the head of a `Source:` line; prose after it is not part of it. */
export function sourceTokens(line) {
  const out = [];
  let rest = line.replace(/^Source:/, '');
  for (let m = rest.match(SOURCE_TOKEN); m; m = rest.match(SOURCE_TOKEN)) {
    out.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return out;
}

/** Sections by anchor, each carrying the files and symbols its `Source:` line names. */
export function sectionsOf(markdown) {
  const lines = markdown.split('\n');
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{2,3}\s+(.*)$/);
    if (!h) continue;
    const raw = lines[i + 2] ?? '';
    if (!raw.startsWith('Source:')) continue;
    const tokens = sourceTokens(raw);
    // A heading that opens with a backticked name documents THAT symbol; a prose one a topic.
    const lead = h[1].match(/^`([A-Za-z0-9_$]+)`/);
    const symbols = tokens.filter((t) => !PATHISH.test(t));
    out.set(slugOf(h[1]), {
      raw,
      subject: lead ? lead[1] : null,
      files: tokens.filter((t) => PATHISH.test(t)),
      symbols: lead && !symbols.includes(lead[1]) ? [lead[1], ...symbols] : symbols,
    });
  }
  return out;
}

/** The name a line DECLARES, or null: a call, an `if` and a bare property are not declarations. */
export function declaredName(line) {
  const decl = line.match(DECLARED);
  if (decl) return decl[1];
  const member = line.match(MEMBER);
  if (member && !NOT_A_NAME.has(member[1]) && !/[=)]\s*$/.test(line.slice(0, line.indexOf('(')))) {
    // An interface or class member declares its name; `foo(bar);` at the same shape does not.
    if (/[;{]\s*$/.test(line) && !/^\s*[A-Za-z0-9_$]+\s*\([^)]*\)\s*;\s*$/.test(line)) return member[1];
  }
  return null;
}

const indentOf = (line) => line.match(/^\s*/)[0].length;

/** The declaration a comment region stands above, or null when it stands above none. */
export function symbolUnder(code, endLine) {
  let j = endLine;
  while (j < code.length && !code[j].trim()) j++;
  return declaredName(code[j] ?? '');
}

// The declaration a comment stands INSIDE, walking out to column 0. Its own column comes
// from the caller: in `code` a comment-only line is blanked to nothing.
export function enclosingSymbol(code, startLine, col) {
  let want = col;
  for (let j = startLine - 2; j >= 0; j--) {
    const line = code[j];
    if (!line.trim()) continue;
    const ind = indentOf(line);
    if (ind >= want) continue;
    want = ind;
    const name = declaredName(line);
    if (name) return name;
    if (ind === 0) return null;
  }
  return null;
}

/** Links written inside a comment, taken from the comment text and not the whole line. */
export function commentLinks(text) {
  const out = [];
  // Every comment line, not every comment RUN: a pointer trailing code is still a pointer.
  maskedLines(text).forEach((line, i) => {
    for (const m of line.matchAll(LINK)) out.push({ line: i + 1, text: m[1], target: m[2] });
  });
  return out;
}

/** How many times each value occurs — the whole difference between a multiset and a `Set`. */
function countOf(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

/** Targets the baseline names more often than the tree carries them, counting copies. */
export function lostTargets(known, have) {
  const found = countOf(have);
  const out = [];
  for (const [target, owed] of countOf(known)) {
    for (let n = found.get(target) ?? 0; n < owed; n++) out.push(target);
  }
  return out;
}

const { files: tracked, empty: emptyTrees } = trackedCode(ROOT, TREES);

const docCache = new Map();
const docOf = (abs) => {
  if (!docCache.has(abs)) {
    const text = readFileSync(abs, 'utf8');
    docCache.set(abs, { anchors: anchorsOf(text), sections: sectionsOf(text) });
  }
  return docCache.get(abs);
};

/** Every pointer of one file, with the symbol each is bound to. */
export function pointersIn(rel, text) {
  const rows = [];
  const code = codeLines(text);
  const masked = maskedLines(text);
  for (const block of commentBlocks(text)) {
    // `declaredName` reads the CODE half of the half the block adjoins: with the comment
    // left in, a `;` inside it ended a statement; with both halves, `a(); /* … */ b();` declared `a`.
    let under = null;
    if (block.codeBefore) under = declaredName((code[block.start - 1] ?? '').slice(0, block.col));
    else if (block.codeAfter) under = declaredName((code[block.end - 1] ?? '').slice(block.endCol));
    else under = symbolUnder(code, block.end);
    // A trailing comment's column is not its line's indentation: passing it let the walk
    // outward accept siblings, turning an unbound refusal into a bound pass.
    const want = block.codeBefore ? indentOf(code[block.start - 1] ?? '') : block.col;
    const within = enclosingSymbol(code, block.start, want);
    for (let n = block.start; n <= block.end; n++) {
      for (const m of (masked[n - 1] ?? '').matchAll(LINK)) {
        const target = m[2];
        const [file, anchor] = target.split('#');
        const abs = file && !/^(https?:|mailto:)/.test(target)
          ? path.resolve(ROOT, path.dirname(rel), file) : null;
        rows.push({
          rel, line: n, target, text: m[1], file, anchor: anchor ?? null, abs,
          exists: !!abs && existsSync(abs), under, within,
        });
      }
    }
  }
  return rows;
}

/** Every pointer of the tree, classified into exactly one class, so that nothing is skipped. */
export function pointers() {
  return tracked.flatMap((rel) => pointersIn(rel, readFileSync(path.join(ROOT, rel), 'utf8')));
}

const CLASSES = ['external', 'broken', 'fileOnly', 'brokenAnchor', 'citation', 'malformedSource',
  'crossFile', 'sameFileCitation', 'fileLevel', 'bound', 'unbound', 'mismatched'];

/** One class per pointer, and a reason when the class is a refusal. */
export function classify(p, section) {
  if (/^(https?:|mailto:|#)/.test(p.target)) return { cls: 'external' };
  if (!p.file || !p.exists) return { cls: 'broken', why: `${p.rel}:${p.line} -> ${p.target}` };
  if (!p.anchor) return { cls: 'fileOnly' };
  if (section === undefined) return { cls: 'brokenAnchor', why: `${p.rel}:${p.line} -> ${p.target}` };
  if (section === null) return { cls: 'citation' };
  if (!section.files.length) {
    return { cls: 'malformedSource', why: `${p.rel}:${p.line} -> ${p.target}: "${section.raw.trim()}" names no file` };
  }
  const mine = section.files.some((f) => path.normalize(f) === path.normalize(p.rel));
  if (!mine) return { cls: 'crossFile' };
  // `§` in the link text is the tree's citation form: it sends a reader somewhere, it does
  // not claim that the section documents the code below it.
  if (p.text.includes('§')) return { cls: 'sameFileCitation' };
  if (!section.subject) return { cls: 'fileLevel' };
  // Either binding satisfies it: the declaration the comment stands above, or the one it sits in.
  const bindings = [p.under, p.within].filter(Boolean);
  if (!bindings.length) {
    return { cls: 'unbound', why: `${p.rel}:${p.line} names \`${section.subject}\` and stands above no declaration and inside no symbol` };
  }
  if (!bindings.some((b) => section.symbols.includes(b))) {
    return { cls: 'mismatched', why: `${p.rel}:${p.line} points at \`${section.subject}\` but is bound to \`${bindings.join('`, `')}\`` };
  }
  return { cls: 'bound' };
}

const all = pointers();

/** The section a pointer names: `undefined` for no heading, `null` for a heading with no source. */
export function sectionFor(p) {
  if (!p.exists || !p.anchor) return undefined;
  const doc = docOf(p.abs);
  if (!doc.anchors.has(p.anchor)) return undefined;
  return doc.sections.get(p.anchor) ?? null;
}

const verdicts = all.map((p) => ({ p, ...classify(p, sectionFor(p)) }));
const of = (cls) => verdicts.filter((v) => v.cls === cls);

test('every tree the gate names carries code it can judge', () => {
  assert.deepEqual(emptyTrees, [], 'a tree named in TREES holds no tracked code file — drop it or fix the name');
  assert.ok(tracked.length > 0, 'no files were read — the walk found nothing to judge');
});

test('a link written in a code comment resolves to a file that exists', () => {
  assert.deepEqual(of('broken').map((v) => v.why), [], 'links in code comments that resolve to nothing');
});

test('an anchor written in a code comment names a heading that exists', () => {
  assert.deepEqual(of('brokenAnchor').map((v) => v.why), [], 'anchors in code comments that name no heading');
});

test('a bound pointer stands above or inside the symbol its section names', () => {
  assert.deepEqual(of('mismatched').map((v) => v.why), [],
    'pointers whose section names a different symbol than they are bound to');
  assert.deepEqual(of('unbound').map((v) => v.why), [],
    'pointers whose section names a symbol they are bound to nothing by');
});

test('a section the pointer leans on is readable, and every pointer lands in a counted class', () => {
  assert.deepEqual(of('malformedSource').map((v) => v.why), [],
    'a `Source:` line whose file the gate cannot read is not a licence to skip the check');
  const counts = {};
  for (const v of verdicts) counts[v.cls] = (counts[v.cls] ?? 0) + 1;
  assert.deepEqual(Object.keys(counts).filter((c) => !CLASSES.includes(c)), [], 'a pointer took a class no one named');
  // Counted against a walk that does NOT group lines: comparing the enumeration with its own
  // sum was a tautology, and it hid every link the grouping was dropping before this check.
  let links = 0;
  for (const rel of tracked) links += commentLinks(readFileSync(path.join(ROOT, rel), 'utf8')).length;
  assert.equal(all.length, links, 'the classified pointers are fewer than the comments carry — a skip nobody counts');
  assert.deepEqual(counts, BASELINE.classes, 'the split between the pointer classes moved — say so in the baseline');
});

test('no file has lost a pointer it is known to carry, counting copies', () => {
  const lost = [];
  const added = [];
  const now = new Map();
  for (const p of all) {
    if (!now.has(p.rel)) now.set(p.rel, []);
    now.get(p.rel).push(p.target);
  }
  // Two identical targets in one file are two pointers: removing one of them is a loss.
  for (const [rel, targets] of Object.entries(BASELINE.byFile)) {
    for (const target of lostTargets(targets, now.get(rel) ?? [])) lost.push(`${rel} -> ${target}`);
  }
  for (const [rel, targets] of now) {
    const known = countOf(BASELINE.byFile[rel] ?? []);
    for (const [target, n] of countOf(targets)) {
      const owed = known.get(target) ?? 0;
      if (n > owed) added.push(`${rel} -> ${target}`);
    }
  }
  assert.deepEqual(lost, [], 'pointers that were in the baseline and are gone');
  if (added.length) console.log(`  pointers added since the baseline: ${added.length}`);
});

test('the walk reads links from the comment text and not from the line around it', () => {
  const sample = '/**\n * see [a](../docs/x.md#b)\n[c](../docs/y.md#d)\n */\nconst s = "[e](z.md)";\n';
  assert.deepEqual(commentLinks(sample).map((l) => l.target), ['../docs/x.md#b', '../docs/y.md#d']);
  // The round-5 bypass: a link inside a string on a line that also carries a comment.
  assert.deepEqual(commentLinks('const s = "[x](../queue/missing.md)"; // note\n').map((l) => l.target), []);
  assert.deepEqual(commentLinks('// see [x](../queue/one.md) and [y](../queue/two.md)\n').map((l) => l.target),
    ['../queue/one.md', '../queue/two.md']);
  // Each space becomes a hyphen, runs are not collapsed — the em dash leaves two.
  assert.deepEqual([...anchorsOf('# One Two\n## `three` — four\n')], ['one-two', 'three--four']);
});

test('a pointer trailing code is enumerated, and bound by the code on its own line', () => {
  const rows = pointersIn('lib/a.js', 'export function f() { return 1; } // [x](../docs/y.md#z)\n');
  assert.equal(rows.length, 1, 'the walk goes by comment LINES, and a run would have dropped this one');
  assert.equal(rows[0].line, 1);
  assert.equal(rows[0].under, 'f', 'a trailing comment is bound by the declaration it trails');
  assert.deepEqual(pointersIn('lib/a.js', 'const s = "[x](../docs/y.md#z)";\n'), [],
    'and a link inside a string is not a pointer at all');
  const above = pointersIn('lib/a.js', '// [x](../docs/y.md#z)\nexport function g() {}\n');
  assert.equal(above[0].under, 'g', 'a comment standing alone is bound by what follows it');
});

test('a call is not a declaration, and a comment on its line cannot make it one', () => {
  // The round-2 review: `declaredName` was fed the RAW line, so the `;` inside the comment
  // satisfied its end-of-statement guard and the anchored call shape no longer matched.
  const under = (src) => pointersIn('lib/a.js', src)[0]?.under ?? null;
  assert.equal(under('run(job); // [x](../docs/y.md#z);\n'), null, 'a `;` inside the comment is not the statement\'s');
  assert.equal(under('run(job); // [x](../docs/y.md#z) {\n'), null, 'and neither is a `{`');
  assert.equal(under('export function f() { // [x](../docs/y.md#z)\n'), 'f', 'a real declaration still binds');
});

test('code on the block\'s own line binds it, before the comment or after', () => {
  const under = (src) => pointersIn('lib/a.js', src)[0]?.under ?? null;
  assert.equal(under('/* [x](../docs/y.md#z) */ export function f() {}\n'), 'f',
    'a block opening the line is bound by the code after it, not by the next line');
  assert.equal(under('export const A = 1; // [x](../docs/y.md#z)\n'), 'A', 'and by the code before it');
  assert.equal(under('// [x](../docs/y.md#z)\nexport function g() {}\n'), 'g',
    'a block standing alone is still bound by what follows it');
});

test('a pointer trailing code on its line is still a pointer', () => {
  // The round-1 review of PB-188: the walk went by RUNS, and a run drops a line carrying code,
  // so a pointer written after a statement was classified by nothing and counted by nothing.
  assert.deepEqual(commentLinks('foo(); // [x](../docs/y.md#z)\n').map((l) => l.target), ['../docs/y.md#z']);
  assert.deepEqual(commentLinks('foo(); /* [x](../docs/y.md#z) */\n').map((l) => l.target), ['../docs/y.md#z']);
  assert.deepEqual(commentLinks('const s = "[x](../docs/y.md#z)";\n').map((l) => l.target), [],
    'and a link inside a string on such a line is still not one');
  assert.deepEqual(commentLinks('const s = "[a](x.md)"; // [b](y.md)\n').map((l) => l.target), ['y.md'],
    'the comment half of the line is read and the code half is not');
});

test('a `Source:` line is read as a list of files and symbols, and prose after it is not one', () => {
  assert.deepEqual(sourceTokens('Source: `lib/exec.js` — `run`, `planRun`.'), ['lib/exec.js', 'run', 'planRun']);
  assert.deepEqual(sourceTokens('Source: `stallStands` in `src/supervisor.ts`, the `promptobus status` print.'),
    ['stallStands', 'src/supervisor.ts']);
  assert.deepEqual(sourceTokens('Source: `lib/models.js`, the `models` command.'), ['lib/models.js']);
  const doc = '## `fn` — does a thing\n\nSource: `lib/x.js`, `fn`.\n\n## A topic\n\nSource: `lib/y.js`, `helper`.\n';
  const sections = sectionsOf(doc);
  assert.deepEqual(sections.get('fn--does-a-thing').files, ['lib/x.js']);
  assert.equal(sections.get('fn--does-a-thing').subject, 'fn', 'a heading opening with a name documents that symbol');
  assert.equal(sections.get('a-topic').subject, null, 'a prose heading documents a topic, and only its file is checked');
  assert.deepEqual(sections.get('a-topic').symbols, ['helper'], 'its `Source:` symbols are still read');
});

test('a declaration is a declaration: a call, an `if` and a bare property are not', () => {
  assert.equal(declaredName('export function wakeTakenBy(home: string): string | null {'), 'wakeTakenBy');
  assert.equal(declaredName('  harnessStateHome(harness: string): string | null;'), 'harnessStateHome');
  assert.equal(declaredName('export const ROLES = ROUTED_ROLES;'), 'ROLES');
  assert.equal(declaredName('  if (sent === null) return !justSpawned(participant);'), null,
    'the round-5 bypass: `if (…)` was read as a declaration named `if`');
  assert.equal(declaredName('bindParticipantHomeRemoval(removeParticipantHome);'), null, 'a call declares nothing');
  assert.equal(declaredName('  let sessions;'), 'sessions');
});

test('a file that loses one of two identical targets has lost a pointer', () => {
  // The round-5 bypass: `lib/driver-cursor.js` pointed at `cursor-persist.js` from two lines,
  // and a `Set` of targets could not tell one of them going from neither.
  assert.deepEqual(lostTargets(['a.md#x', 'a.md#x'], ['a.md#x']), ['a.md#x']);
  assert.deepEqual(lostTargets(['a.md#x', 'a.md#x'], ['a.md#x', 'a.md#x']), []);
  assert.deepEqual(lostTargets(['a.md#x'], ['a.md#x', 'a.md#x']), [], 'a copy added is not a copy lost');
  assert.deepEqual(lostTargets(['a.md#x'], []), ['a.md#x']);
});

test('the source path is compared, and a bare symbol name is no licence to skip it', () => {
  const at = (over) => ({
    rel: 'lib/a.js', line: 3, target: '../docs/x.md#y', text: 'reference/x.md#y',
    file: '../docs/x.md', anchor: 'y', abs: '/x.md', exists: true, under: 'other', within: null, ...over,
  });
  const section = (over) => ({ raw: 'Source: `lib/a.js`, `fn`.', subject: 'fn', files: ['lib/a.js'], symbols: ['fn'], ...over });
  assert.equal(classify(at(), section({ files: ['lib/b.js'] })).cls, 'crossFile',
    'a section describing another file does not license a symbol comparison here');
  assert.equal(classify(at(), section()).cls, 'mismatched', 'the round-5 bypass: the file was never compared');
  assert.equal(classify(at({ under: 'fn' }), section()).cls, 'bound');
  assert.equal(classify(at({ under: null, within: 'fn' }), section()).cls, 'bound', 'the enclosing symbol binds it too');
  assert.equal(classify(at({ under: null }), section()).cls, 'unbound', 'and standing above nothing is a refusal, not silence');
  assert.equal(classify(at(), section({ subject: null })).cls, 'fileLevel', 'a prose heading binds the file only');
  assert.equal(classify(at(), section({ files: [] })).cls, 'malformedSource', 'a `Source:` naming no file is a refusal');
  assert.equal(classify(at({ text: '05-drivers.md § fn' }), section()).cls, 'sameFileCitation');
  assert.equal(classify(at({ exists: false }), section()).cls, 'broken');
  assert.equal(classify(at({ anchor: null, target: '../docs/x.md' }), undefined).cls, 'fileOnly');
  assert.equal(classify(at(), undefined).cls, 'brokenAnchor');
  assert.equal(classify(at(), null).cls, 'citation');
});

test('a trailing comment is enclosed by its function, not by the statement before it', () => {
  // The round-3 major, and the third of its class: the walk passed `block.col` — the column of
  // the `//`, far right of the indentation — so the walk outward stopped excluding siblings.
  const within = (src) => pointersIn('lib/a.js', src)[0]?.within ?? null;
  assert.equal(within('export function f() {\n  const A = 1;\n  run(job); // [x](../docs/y.md#z)\n}\n'), 'f',
    'the sibling declaration above it is not what encloses it');
  assert.equal(within('export const A = 1;\nrun(job); // [x](../docs/y.md#z)\n'), null,
    'and at column 0 nothing encloses it — this one turned unbound into bound, the green side of the error');
  assert.equal(within('export function f() {\n  // [x](../docs/y.md#z)\n  return 1;\n}\n'), 'f',
    'a comment standing on its own line is still enclosed');
});

test('a binding reads the half of the line its comment adjoins, and no other', () => {
  const under = (src) => pointersIn('lib/a.js', src)[0]?.under ?? null;
  assert.equal(under('a(); /* [x](../docs/y.md#z) */ b();\n'), null,
    'a comment between two statements declares neither: with both halves the anchored guard missed and `a` came back');
  assert.equal(under('/* [x](../docs/y.md#z) */ export function f() {}\n'), 'f', 'the half after it, when that is where the code is');
  assert.equal(under('export const A = 1; // [x](../docs/y.md#z)\n'), 'A', 'and the half before it otherwise');
});

test('classify judges a row the WALK built, not one a fixture assembled', () => {
  // The seam, not the predicate: every other `classify` case hands it a row written by hand,
  // where `text`, `under` and `exists` are whatever the fixture says they are.
  const rel = 'lib/model-routing/catalog.js';
  const anchor = '../../docs/guides/model-routing.md#mergeweights--the-four-merge-rules-and-why-provenance-is-a-list';
  const clsOf = (src) => {
    const rows = pointersIn(rel, src);
    return rows.length ? classify(rows[0], sectionFor(rows[0])).cls : 'no pointer at all';
  };
  assert.equal(clsOf(`// [x](${anchor})\nexport function mergeWeights() {}\n`), 'bound',
    'the walk resolves the file, reads the real section and binds the declaration below');
  assert.equal(clsOf(`// [model-routing.md § mergeWeights](${anchor})\nexport function mergeWeights() {}\n`), 'sameFileCitation',
    'and the `§` form is decided by the link text the walk read, not by one a fixture set');
  assert.equal(clsOf(`// [x](${anchor})\nrun(job);\n`), 'unbound',
    'a call below it binds nothing, and that is a refusal rather than a silent pass');
  assert.equal(clsOf(`const s = "[x](${anchor})";\n`), 'no pointer at all', 'a link in a string never reaches classify');
  // Every REFUSAL through the walk too, which is the half that matters: on the tree all five
  // refusal classes are empty by construction, so nothing there would notice the walk giving up.
  assert.equal(clsOf('// [x](../../docs/guides/no-such-guide.md#anything)\nexport function mergeWeights() {}\n'), 'broken',
    'the walk resolves the path and finds nothing');
  assert.equal(clsOf(`// [x](${anchor.split('#')[0]}#no-heading-of-this-name)\nexport function mergeWeights() {}\n`), 'brokenAnchor',
    'the walk reads the real document and the anchor names no heading in it');
  assert.equal(clsOf(`// [x](${anchor})\nexport function somethingElse() {}\n`), 'mismatched',
    'the walk binds the declaration below, and it is not the one the section names');
  // The one refusal no document here can produce: all 109 `Source:` lines name a file. The ROW
  // is still the walk's; the section is written by hand, and a section comes off disk anyway.
  const row = pointersIn(rel, `// [x](${anchor})\nexport function mergeWeights() {}\n`)[0];
  assert.equal(classify(row, { raw: 'Source: prose with no file.', subject: 'fn', files: [], symbols: ['fn'] }).cls,
    'malformedSource', 'a `Source:` the gate cannot read is a refusal even for a row that resolves');
});

test('symbolUnder is reached through the walk, which decides which line it reads', () => {
  const under = (src) => pointersIn('lib/a.js', src)[0]?.under ?? null;
  assert.equal(under('// [x](../docs/y.md#z)\n// second line of the same comment\nexport function f() {}\n'), 'f',
    'a two-line comment is read from its END');
  assert.equal(under('// [x](../docs/y.md#z)\n\nexport const A = 1;\n'), 'A', 'a blank line between them is skipped');
  // The seam itself: which ARRAY the walk hands it. Given raw lines, the `;` inside the trailing
  // comment ends the statement for the guard and `run(job);` reads as a declaration named `run`.
  assert.equal(under('// [x](../docs/y.md#z)\nrun(job); // not a declaration;\n'), null,
    'the line below is read as CODE, so a `;` written in its comment is not the statement\'s');
});

test('a pointer inside a function is bound by the symbol that encloses it', () => {
  const lines = ['export function wardenRound(a) {', '  const x = 1;', '', '  return x;', '}'];
  assert.equal(enclosingSymbol(lines, 3, 2), 'wardenRound', 'the comment line is blank in `code`, so its column is passed');
  assert.equal(enclosingSymbol(['const x = 1;', ''], 2, 0), null, 'at column 0 nothing encloses it');
});

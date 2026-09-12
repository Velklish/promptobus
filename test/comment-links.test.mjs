// Gate: a markdown link inside a CODE comment resolves — file, anchor and subject.
// Why this is a second gate and not part of the others: guides/contributing.md.
import './home.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commentRegions } from './comment-scan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREES = ['lib', 'src', 'bin', 'templates'];
const CODE = /\.(js|ts|mjs)$/;
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const SYMBOL = /^\s*(?:export\s+)?(?:async\s+)?(?:function|const|class|type|interface|let)\s+([A-Za-z0-9_]+)|^\s*([A-Za-z0-9_]+)\s*[(:]/;

/**
 * The pointers this tree is known to carry, per file, and how many bind a symbol.
 *
 * A baseline and not a floor: a count could be held up by links nobody touched while the
 * pointers under repair quietly vanished. Losing one is a failure; adding one is reported
 * and allowed, since the sweep adds pointers by design.
 */
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

/** Sections by anchor, each carrying the file and symbol its `Source:` line names. */
export function sectionsOf(markdown) {
  const lines = markdown.split('\n');
  const out = new Map();
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{2,3}\s+(.*)$/);
    if (!h) continue;
    const s = (lines[i + 2] ?? '').match(/^Source: `([^`]+)`(?:, `([^`]+)`)?\./);
    if (s) out.set(slugOf(h[1]), { file: s[1], symbol: s[2] ?? null });
  }
  return out;
}

/** Links written inside a comment, found through the scanner rather than per line. */
export function commentLinks(text) {
  const lines = text.split('\n');
  const out = [];
  for (const region of commentRegions(text)) {
    for (let n = region.start; n <= region.end; n++) {
      for (const m of (lines[n - 1] ?? '').matchAll(LINK)) out.push({ line: n, target: m[1] });
    }
  }
  return out;
}

/** The declaration a comment region stands above, or null when it stands above none. */
export function symbolUnder(lines, endLine) {
  let j = endLine;
  while (j < lines.length && !lines[j].trim()) j++;
  const m = (lines[j] ?? '').match(SYMBOL);
  return m ? (m[1] ?? m[2]) : null;
}

const tracked = execFileSync('git', ['ls-files', ...TREES], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && CODE.test(f));

const docCache = new Map();
const docOf = (abs) => {
  if (!docCache.has(abs)) {
    const text = readFileSync(abs, 'utf8');
    docCache.set(abs, { anchors: anchorsOf(text), sections: sectionsOf(text) });
  }
  return docCache.get(abs);
};

/** Every pointer of the tree, classified, so that nothing is skipped in silence. */
function pointers() {
  const rows = [];
  for (const rel of tracked) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = text.split('\n');
    for (const region of commentRegions(text)) {
      for (let n = region.start; n <= region.end; n++) {
        for (const m of (lines[n - 1] ?? '').matchAll(LINK)) {
          const target = m[1];
          if (/^(https?:|mailto:|#)/.test(target)) continue;
          const [file, anchor] = target.split('#');
          const abs = file ? path.resolve(ROOT, path.dirname(rel), file) : null;
          rows.push({
            rel, line: n, target, file, anchor: anchor ?? null, abs,
            exists: !!abs && existsSync(abs), under: symbolUnder(lines, region.end),
          });
        }
      }
    }
  }
  return rows;
}

const all = pointers();

test('a link written in a code comment resolves to a file that exists', () => {
  assert.ok(tracked.length > 0, 'no files were read — the walk found nothing to judge');
  const broken = all.filter((p) => p.file && !p.exists).map((p) => `${p.rel}:${p.line} -> ${p.target}`);
  assert.deepEqual(broken, [], 'links in code comments that resolve to nothing');
});

test('an anchor written in a code comment names a heading that exists', () => {
  const broken = [];
  for (const p of all) {
    if (!p.anchor || !p.exists) continue;
    if (!docOf(p.abs).anchors.has(p.anchor)) broken.push(`${p.rel}:${p.line} -> ${p.target}`);
  }
  assert.deepEqual(broken, [], 'anchors in code comments that name no heading');
});

test('a pointer stands above the symbol its section names, and none is skipped in silence', () => {
  const wrong = [];
  // Three classes, all counted. A pointer is BOUND when its section names a symbol and is
  // then checked against the declaration it stands above; FILE-LEVEL when the section
  // names a file and no symbol; a CITATION when it points at a guide section that
  // describes no source at all. The third is lawful — `src/hooks.ts` cites where the
  // removal is explained — but it must be counted, because a skip nobody counts is how a
  // threshold fills with the unchecked.
  const seen = { bound: 0, fileLevel: 0, citation: 0 };
  for (const p of all) {
    if (!p.anchor || !p.exists) continue;
    const section = docOf(p.abs).sections.get(p.anchor);
    if (!section) { seen.citation++; continue; }
    if (!section.symbol) { seen.fileLevel++; continue; }
    seen.bound++;
    if (p.under && p.under !== section.symbol) {
      wrong.push(`${p.rel}:${p.line} points at \`${section.symbol}\` but stands above \`${p.under}\``);
    }
  }
  assert.deepEqual(wrong, [], 'pointers whose section names a different symbol than they stand above');
  assert.deepEqual(seen, { bound: BASELINE.bound, fileLevel: BASELINE.fileLevel, citation: BASELINE.citation },
    'the split between the three pointer classes moved — say so in the baseline');
});

test('no file has lost a pointer it is known to carry', () => {
  const lost = [];
  const added = [];
  const now = new Map();
  for (const p of all) {
    if (!now.has(p.rel)) now.set(p.rel, new Set());
    now.get(p.rel).add(p.target);
  }
  for (const [rel, targets] of Object.entries(BASELINE.byFile)) {
    const have = now.get(rel) ?? new Set();
    for (const t of targets) if (!have.has(t)) lost.push(`${rel} -> ${t}`);
  }
  for (const [rel, targets] of now) {
    const known = new Set(BASELINE.byFile[rel] ?? []);
    for (const t of targets) if (!known.has(t)) added.push(`${rel} -> ${t}`);
  }
  // Losing one is the failure this replaces the floor with; additions are the sweep's
  // normal output and are reported as a count rather than refused.
  assert.deepEqual(lost, [], 'pointers that were in the baseline and are gone');
  if (added.length) console.log(`  pointers added since the baseline: ${added.length}`);
});

test('the walk sees a link on a continuation line and ignores prose that is not a comment', () => {
  const sample = '/**\n * see [a](../docs/x.md#b)\n[c](../docs/y.md#d)\n */\nconst s = "[e](z.md)";\n';
  assert.deepEqual(commentLinks(sample).map((l) => l.target), ['../docs/x.md#b', '../docs/y.md#d']);
  // Each space becomes a hyphen, runs are not collapsed — the em dash leaves two.
  assert.deepEqual([...anchorsOf('# One Two\n## `three` — four\n')], ['one-two', 'three--four']);
});

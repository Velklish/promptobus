// Where a comment begins and ends, tracked across lines instead of guessed per line.
// Both comment gates read it; why it is stateful: guides/contributing.md.

/**
 * Comment regions of a source file, as `{ start, end, lines }` with 1-based line numbers.
 *
 * A per-line regexp cannot do this and the two gates were wrong in three ways because of
 * it: a `/* … *\/` block whose middle lines carry no `*` looked like several runs or none,
 * a comment opened after code on the same line was invisible, and a `//` run beginning at
 * column 40 was treated as prose. The scanner tracks whether it is inside a block, whether
 * it is inside a string or a template literal, and whether a `//` run is continuing.
 *
 * Strings matter: `const s = '// not a comment';` must not open one, and a URL's `//`
 * inside a string must not either.
 */
export function commentRegions(text) {
  const lines = text.split('\n');
  const regions = [];
  let block = null;
  let run = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (block) {
      block.lines.push(line);
      block.end = i + 1;
      if (line.includes('*/')) { regions.push(block); block = null; }
      continue;
    }
    const found = scanLine(line);
    if (found.opensBlock) {
      if (run) { regions.push(run); run = null; }
      block = { start: i + 1, end: i + 1, lines: [line], kind: 'block' };
      if (found.closesBlock) { regions.push(block); block = null; }
      continue;
    }
    if (found.lineComment) {
      // A `//` run continues only while every line is one; code between ends it.
      if (run && run.end === i) { run.lines.push(line); run.end = i + 1; }
      else { if (run) regions.push(run); run = { start: i + 1, end: i + 1, lines: [line], kind: 'line' }; }
      continue;
    }
    if (run) { regions.push(run); run = null; }
  }
  if (block) regions.push(block);
  if (run) regions.push(run);
  return regions;
}

/** One line: does it open a block, close it, or carry a `//` comment outside a string? */
function scanLine(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && next === '*') {
      return { opensBlock: true, closesBlock: line.indexOf('*/', i + 2) !== -1, lineComment: false };
    }
    if (c === '/' && next === '/') return { opensBlock: false, closesBlock: false, lineComment: true };
  }
  return { opensBlock: false, closesBlock: false, lineComment: false };
}

/** The prose of a region, one entry per line, markers stripped and blanks dropped. */
export function proseOf(region) {
  return region.lines
    .map((l) => l.replace(/^\s*\/\*\*?/, '').replace(/\*\/\s*$/, '')
      .replace(/^\s*\*\s?/, '').replace(/^\s*\/\/ ?/, '').trim())
    .filter(Boolean);
}

/** Regions longer than `limit` lines, which is what both gates judge. */
export function longRuns(text, limit = 2) {
  return commentRegions(text)
    .filter((r) => r.end - r.start + 1 > limit)
    .map((r) => ({ line: r.start, length: r.end - r.start + 1, lines: r.lines }));
}

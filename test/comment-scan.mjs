// Where a comment begins and ends, lexed across lines instead of guessed per line.
// What the two gates over it catch and what they do not: guides/contributing.md § the sweep.
import { execFileSync } from 'node:child_process';

const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

// Tokens after which a `/` is division. `!` is NOT one: `!/\s/.test(v)` is prefix negation
// and the tree writes it; the postfix TypeScript `x!` appears nowhere in it.
const ENDS_A_VALUE = new Set([')', ']', '}', '++', '--']);

/** A `/` opens a regex unless the token before it ended a value. */
function regexAllowed(prev) {
  if (prev === null) return true;
  if (prev === 'value') return false;
  if (prev.startsWith('w:')) return REGEX_KEYWORDS.has(prev.slice(2));
  return !ENDS_A_VALUE.has(prev);
}

/** A quoted string; a newline ends it, so a stray quote cannot swallow the file. */
function skipString(text, i, quote) {
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === quote) return j + 1;
    if (c === '\n') return j;
  }
  return text.length;
}

/** A regex literal with its character classes and flags; a newline ends it. */
function skipRegex(text, i) {
  let klass = false;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '\n') return j;
    if (klass) { if (c === ']') klass = false; continue; }
    if (c === '[') { klass = true; continue; }
    if (c === '/') {
      let k = j + 1;
      while (k < text.length && /[A-Za-z]/.test(text[k])) k++;
      return k;
    }
  }
  return text.length;
}

/** Every comment as `{ from, to, kind }` over character offsets, state carried across lines. */
export function commentSpans(text) {
  const out = [];
  const frames = [{ template: false, depth: 0 }];
  let prev = null;
  let i = 0;
  while (i < text.length) {
    const frame = frames[frames.length - 1];
    const c = text[i];
    if (frame.template) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { frames.pop(); prev = 'value'; i++; continue; }
      // A `${` opens a code frame of its own, so a template inside one nests rather than closes.
      if (c === '$' && text[i + 1] === '{') { frames.push({ template: false, depth: 0 }); prev = null; i += 2; continue; }
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const to = nl === -1 ? text.length : nl;
      out.push({ from: i, to, kind: 'line' });
      i = to;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const to = close === -1 ? text.length : close + 2;
      out.push({ from: i, to, kind: 'block' });
      i = to;
      continue;
    }
    if (c === '"' || c === "'") { i = skipString(text, i, c); prev = 'value'; continue; }
    if (c === '`') { frames.push({ template: true, depth: 0 }); i++; continue; }
    if (c === '/' && regexAllowed(prev)) { i = skipRegex(text, i); prev = 'value'; continue; }
    if (c === '{') { frame.depth++; prev = '{'; i++; continue; }
    if (c === '}') {
      // Depth 0 in a nested frame closes a `${…}`; at the base frame it is just a brace.
      if (frame.depth === 0 && frames.length > 1) { frames.pop(); i++; continue; }
      if (frame.depth > 0) frame.depth--;
      prev = '}';
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let k = i;
      while (k < text.length && /[A-Za-z0-9_$]/.test(text[k])) k++;
      prev = `w:${text.slice(i, k)}`;
      i = k;
      continue;
    }
    // `++` and `--` are one token: after them a `/` is division, after a single `+` it is not.
    if ((c === '+' || c === '-') && text[i + 1] === c) { prev = c + c; i += 2; continue; }
    prev = c;
    i++;
  }
  return out;
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, idx) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Per line: the comment columns on it, and whether code stands before or after them. */
export function lineFacts(text) {
  const lines = text.split('\n');
  const starts = lineStartsOf(text);
  const facts = lines.map((l) => ({ text: l, spans: [], codeBefore: false, codeAfter: false }));
  for (const span of commentSpans(text)) {
    const first = lineOf(starts, span.from);
    const last = lineOf(starts, Math.max(span.from, span.to - 1));
    for (let n = first; n <= last; n++) {
      const from = n === first ? span.from - starts[n] : 0;
      const to = n === last ? span.to - starts[n] : lines[n].length;
      facts[n].spans.push([from, Math.min(to, lines[n].length)]);
    }
  }
  for (const fact of facts) {
    if (!fact.spans.length) { fact.codeBefore = /\S/.test(fact.text); continue; }
    const head = fact.spans[0][0];
    fact.codeBefore = /\S/.test(fact.text.slice(0, head));
    let cursor = head;
    for (const [from, to] of fact.spans) {
      if (/\S/.test(fact.text.slice(cursor, from))) fact.codeAfter = true;
      cursor = Math.max(cursor, to);
    }
    if (/\S/.test(fact.text.slice(cursor))) fact.codeAfter = true;
  }
  return facts;
}

/** Each line with everything outside a comment blanked, columns preserved. */
export function maskedLines(text) {
  return lineFacts(text).map((fact) => {
    if (!fact.spans.length) return '';
    const chars = ' '.repeat(fact.text.length).split('');
    for (const [from, to] of fact.spans) for (let i = from; i < to; i++) chars[i] = fact.text[i];
    return chars.join('').replace(/\s+$/, '');
  });
}

/** The complement: each line with the COMMENT blanked, so a reader of code sees only code. */
export function codeLines(text) {
  return lineFacts(text).map((fact) => {
    if (!fact.spans.length) return fact.text;
    const chars = fact.text.split('');
    for (const [from, to] of fact.spans) for (let i = from; i < to; i++) chars[i] = ' ';
    return chars.join('').replace(/\s+$/, '');
  });
}

/** Comment runs as `{ start, end, lines }`, 1-based and inclusive. */
export function commentRegions(text) {
  const regions = [];
  let current = null;
  const facts = lineFacts(text);
  for (let n = 0; n < facts.length; n++) {
    const fact = facts[n];
    // Code before a comment makes the line a code line; code after one ends the run there.
    if (!fact.spans.length || fact.codeBefore || fact.codeAfter) { current = null; continue; }
    if (current) { current.lines.push(fact.text); current.end = n + 1; continue; }
    current = { start: n + 1, end: n + 1, lines: [fact.text] };
    regions.push(current);
  }
  return regions;
}

/** Comment lines grouped for BINDING: unlike a run, a comment trailing code is a block. */
export function commentBlocks(text) {
  const blocks = [];
  let current = null;
  const facts = lineFacts(text);
  for (let n = 0; n < facts.length; n++) {
    const fact = facts[n];
    if (!fact.spans.length) { current = null; continue; }
    if (current && !fact.codeBefore) { current.end = n + 1; current.endCol = fact.spans.at(-1)[1]; }
    else {
      // `col` and `endCol` bound the comment on its own line: what lies outside them is the
      // code the block adjoins, and a binding may look at that half and at no other.
      blocks.push(current = {
        start: n + 1, end: n + 1, col: fact.spans[0][0], endCol: fact.spans.at(-1)[1],
        codeBefore: fact.codeBefore, codeAfter: false,
      });
    }
    if (fact.codeAfter) { current.codeAfter = true; current = null; }
  }
  return blocks;
}

/** The prose of a region, one entry per line, markers stripped and blanks dropped. */
export function proseOf(region) {
  return region.lines
    .map((l) => l.replace(/^\s*\/\*\*?/, '').replace(/\*\/\s*$/, '')
      .replace(/^\s*\*\s?/, '').replace(/^\s*\/\/ ?/, '').trim())
    .filter(Boolean);
}

/** The tracked code of the named trees, with any tree that holds none named beside it. */
export function trackedCode(root, trees) {
  const files = execFileSync('git', ['ls-files', ...trees], { cwd: root, encoding: 'utf8' })
    .split('\n').filter((f) => f && /\.(js|ts|mjs)$/.test(f));
  // A tree that resolves to nothing is a silent hole: `templates/` sat in both gates for four
  // days after its last file went, and the walk over it read zero files without saying so.
  const empty = trees.filter((t) => !files.some((f) => f === t || f.startsWith(`${t}/`)));
  return { files, empty };
}

/** Regions longer than `limit` lines, which is what both gates judge. */
export function longRuns(text, limit = 2) {
  return commentRegions(text)
    .filter((r) => r.end - r.start + 1 > limit)
    .map((r) => ({ line: r.start, length: r.end - r.start + 1, lines: r.lines }));
}

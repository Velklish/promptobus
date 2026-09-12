// Gate: a markdown link inside a CODE comment resolves — file and anchor both.
// Why this is a second gate and not part of the others: guides/contributing.md.
import './home.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREES = ['lib', 'src', 'bin', 'templates'];
const CODE = /\.(js|ts|mjs)$/;
const COMMENT = /^\s*(\/\/|\*|\/\*)/;
const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

/** GitHub's heading slug, which is what an anchor in these files is written against. */
export function slugOf(heading) {
  return heading.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9 _-]/g, '').trim().replace(/ /g, '-');
}

export function anchorsOf(markdown) {
  return new Set(markdown.split('\n')
    .map((l) => l.match(/^#{1,6}\s+(.*)$/))
    .filter(Boolean)
    .map((m) => slugOf(m[1])));
}

/** Every markdown link that appears inside a comment, with the line it was written on. */
export function commentLinks(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (!COMMENT.test(line)) return;
    for (const m of line.matchAll(LINK)) out.push({ line: i + 1, target: m[1] });
  });
  return out;
}

const tracked = execFileSync('git', ['ls-files', ...TREES], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && CODE.test(f));

test('a link written in a code comment resolves to a file that exists', () => {
  assert.ok(tracked.length > 0, 'no files were read — the walk found nothing to judge');
  const broken = [];
  let seen = 0;
  for (const rel of tracked) {
    for (const { line, target } of commentLinks(readFileSync(path.join(ROOT, rel), 'utf8'))) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      seen++;
      const file = target.split('#')[0];
      if (!file) continue;
      if (!existsSync(path.resolve(ROOT, path.dirname(rel), file))) broken.push(`${rel}:${line} -> ${target}`);
    }
  }
  // A gate that matched nothing would pass in silence; these links are the reason it exists.
  assert.ok(seen > 50, `only ${seen} comment links were found — the walk is not reaching them`);
  assert.deepEqual(broken, [], 'links in code comments that resolve to nothing');
});

test('an anchor written in a code comment names a heading that exists', () => {
  const broken = [];
  const docs = new Map();
  for (const rel of tracked) {
    for (const { line, target } of commentLinks(readFileSync(path.join(ROOT, rel), 'utf8'))) {
      if (/^(https?:|mailto:)/.test(target) || !target.includes('#')) continue;
      const [file, anchor] = target.split('#');
      if (!file || !anchor) continue;
      const abs = path.resolve(ROOT, path.dirname(rel), file);
      if (!existsSync(abs)) continue;
      if (!docs.has(abs)) docs.set(abs, anchorsOf(readFileSync(abs, 'utf8')));
      if (!docs.get(abs).has(anchor)) broken.push(`${rel}:${line} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], 'anchors in code comments that name no heading');
});

test('the walk sees a link and an anchor, and ignores prose that is not a comment', () => {
  // The positive half: without it, a walk that matched nothing would satisfy the checks.
  const sample = '// see [a](../docs/x.md#b)\nconst s = "[c](../docs/y.md#d)";\n/* [e](z.md) */\n';
  assert.deepEqual(commentLinks(sample).map((l) => l.target), ['../docs/x.md#b', 'z.md']);
  // Each space becomes a hyphen, runs are not collapsed — the em dash leaves two.
  assert.deepEqual([...anchorsOf('# One Two\n## `three` — four\n')], ['one-two', 'three--four']);
});

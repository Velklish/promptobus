// Publicity gate. Fails when anything private to the project this package was
// extracted from survives in what we ship.
//
// Two surfaces, and the second is why this script exists at all. Tracked files
// are easy to grep by hand. The npm tarball is not: it carries `dist/`, which is
// built rather than committed, so a leak compiled out of a clean source tree is
// invisible to any check that reads git alone.
//
// The forbidden strings are assembled from fragments on purpose. A gate that
// contained them literally would either flag itself or need an exemption, and an
// exemption is a hole shaped exactly like the thing being looked for.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const say = (s) => process.stdout.write(`${s}\n`);

const FORBIDDEN = [
  ['host of the origin forge', ['gitlab', '.ati', '.st'].join('')],
  ['origin CLI name', ['ati', '-agents'].join('')],
  ['origin package scopes', ['@agent', '-workspace'].join('')],
  ['origin package scopes', ['@ati', '-agents'].join('')],
  ['origin environment prefix', ['ATI', '_'].join('')],
  ['origin memory service', ['context', '-store'].join('')],
  ['origin tracker ids', new RegExp(['BL', '-[0-9]'].join(''))],
];

const TEXT = /\.(m?js|ts|json|md|ya?ml|txt|mjs)$/;
const failures = [];

function scan(label, name, text, needle) {
  const hit = needle instanceof RegExp ? needle.test(text) : text.includes(needle);
  if (hit) failures.push(`${label}: ${name}`);
}

// --- surface 1: what git tracks -------------------------------------------
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);

for (const rel of tracked) {
  if (!TEXT.test(rel)) continue;
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  for (const [label, needle] of FORBIDDEN) scan(label, rel, text, needle);
}

// Links that point outside this repository are the quieter half of the same
// problem: they read as documentation and resolve to nothing.
//
// Only prose is examined. In a markdown file every line is prose; in code only
// comment lines are, because `](` also occurs inside regular expressions and
// string literals, and a gate that reported those would be answered by muting it.
const LINK = /\]\(([^)#\s]+?)\)/g;
// In markdown a fenced block or an inline code span is not prose either: a sentence
// that QUOTES the link pattern would otherwise be read as a link to its example.
const mdProse = (text) => text
  .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
  .replace(/`[^`\n]*`/g, '');
const proseOf = (rel, text) => (rel.endsWith('.md')
  ? mdProse(text)
  : text.split('\n').filter((l) => /^\s*(\/\/|\*)/.test(l)).join('\n'));
for (const rel of tracked) {
  if (!/\.(md|m?js|ts)$/.test(rel)) continue;
  const text = proseOf(rel, readFileSync(path.join(ROOT, rel), 'utf8'));
  for (const m of text.matchAll(LINK)) {
    const target = m[1].trim();
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
    const abs = path.resolve(path.dirname(path.join(ROOT, rel)), target);
    if (!abs.startsWith(ROOT + path.sep)) failures.push(`link leaves the repository: ${rel} → ${target}`);
    else if (!existsSync(abs)) failures.push(`link resolves to nothing: ${rel} → ${target}`);
  }
}

// --- surface 2: what npm would ship ---------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), 'promptobus-audit-'));
try {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
  const packed = execFileSync('npm', ['pack', '--pack-destination', tmp], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop();
  const tarball = path.join(tmp, packed);
  execFileSync('tar', ['-xzf', tarball, '-C', tmp]);
  const listed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean);
  say(`tarball: ${packed} · ${listed.length} entries`);
  for (const entry of listed) {
    if (entry.endsWith('/') || !TEXT.test(entry)) continue;
    const abs = path.join(tmp, entry);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    for (const [label, needle] of FORBIDDEN) scan(label, `tarball:${entry}`, text, needle);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- verdict ---------------------------------------------------------------
if (failures.length) {
  for (const f of [...new Set(failures)].sort()) say(`✖ ${f}`);
  say(`✖ publicity audit: ${new Set(failures).size} finding(s)`);
  process.exit(1);
}
say(`✔ publicity audit: clean · ${tracked.length} tracked files and the packed tarball`);
